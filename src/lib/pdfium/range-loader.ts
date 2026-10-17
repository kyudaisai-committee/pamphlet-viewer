export const RANGE_CHUNK_SIZE = 256 * 1024;
export const RANGE_CACHE_LIMIT = 64 * 1024 * 1024;
export const RANGE_FETCH_CONCURRENCY = 4;
const MAX_FILE_LENGTH = 0xffff_ffff;

export interface ContentRange {
	start: number;
	end: number;
	total: number;
}

export function parseContentRange(value: string | null): ContentRange | null {
	if (value === null) return null;

	const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
	if (match === null) return null;

	const start = Number(match[1]);
	const end = Number(match[2]);
	const total = Number(match[3]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
		return null;
	}
	if (start < 0 || end < start || total <= end) return null;

	return { start, end, total };
}

class ChunkCache {
	#chunks = new Map<number, Uint8Array>();
	#byteLength = 0;

	constructor(private readonly maxBytes: number) {}

	get byteLength(): number {
		return this.#byteLength;
	}

	get(index: number): Uint8Array | undefined {
		const chunk = this.#chunks.get(index);
		if (chunk === undefined) return undefined;

		this.#chunks.delete(index);
		this.#chunks.set(index, chunk);
		return chunk;
	}

	clear(): void {
		this.#chunks.clear();
		this.#byteLength = 0;
	}

	set(index: number, chunk: Uint8Array): void {
		const existing = this.#chunks.get(index);
		if (existing !== undefined) {
			this.#byteLength -= existing.byteLength;
			this.#chunks.delete(index);
		}
		if (chunk.byteLength > this.maxBytes) return;

		while (this.#byteLength + chunk.byteLength > this.maxBytes) {
			const oldest = this.#chunks.entries().next().value as [number, Uint8Array] | undefined;
			if (oldest === undefined) break;
			this.#chunks.delete(oldest[0]);
			this.#byteLength -= oldest[1].byteLength;
		}

		this.#chunks.set(index, chunk);
		this.#byteLength += chunk.byteLength;
	}
}

export class PdfRangeLoader {
	#cache = new ChunkCache(RANGE_CACHE_LIMIT);
	#missingChunks = new Set<number>();
	#totalLength: number | null = null;
	#etag: string | null = null;
	#lastModified: string | null = null;

	constructor(
		private readonly url: string,
		private readonly signal: AbortSignal,
	) {}

	get totalLength(): number | null {
		return this.#totalLength;
	}

	get cachedByteLength(): number {
		return this.#cache.byteLength;
	}

	get hasMissingChunks(): boolean {
		return this.#missingChunks.size > 0;
	}

	dispose(): void {
		this.#cache.clear();
		this.#missingChunks.clear();
		this.#totalLength = null;
		this.#etag = null;
		this.#lastModified = null;
	}

	async initialize(): Promise<number> {
		if (this.#totalLength !== null) return this.#totalLength;
		await this.#fetchChunk(0);
		if (this.#totalLength === null) {
			throw new Error("The server did not provide a valid Content-Range header.");
		}
		return this.#totalLength;
	}

	readInto(position: number, target: Uint8Array, targetOffset: number, length: number): boolean {
		const totalLength = this.#totalLength;
		if (totalLength === null) throw new Error("Range loader is not initialized.");
		if (
			!Number.isSafeInteger(position) ||
			!Number.isSafeInteger(targetOffset) ||
			!Number.isSafeInteger(length) ||
			position < 0 ||
			targetOffset < 0 ||
			length < 0 ||
			position + length > totalLength ||
			targetOffset + length > target.byteLength
		) {
			throw new RangeError("PDFium requested bytes outside the PDF document.");
		}
		if (length === 0) return true;

		const firstIndex = Math.floor(position / RANGE_CHUNK_SIZE);
		const lastIndex = Math.floor((position + length - 1) / RANGE_CHUNK_SIZE);
		const chunks = new Map<number, Uint8Array>();
		for (let index = firstIndex; index <= lastIndex; index += 1) {
			const chunk = this.#cache.get(index);
			if (chunk === undefined) this.#missingChunks.add(index);
			else chunks.set(index, chunk);
		}
		if (this.#missingChunks.size > 0) return false;

		for (const [index, chunk] of chunks) {
			const chunkStart = index * RANGE_CHUNK_SIZE;
			const copyStart = Math.max(position, chunkStart);
			const copyEnd = Math.min(position + length, chunkStart + chunk.byteLength);
			const sourceStart = copyStart - chunkStart;
			const destinationStart = targetOffset + copyStart - position;
			target.set(chunk.subarray(sourceStart, sourceStart + copyEnd - copyStart), destinationStart);
		}

		return true;
	}

	async fetchMissingChunks(): Promise<void> {
		const indices = [...this.#missingChunks].slice(0, RANGE_FETCH_CONCURRENCY);
		await Promise.all(indices.map((index) => this.#fetchChunk(index)));
		for (const index of indices) this.#missingChunks.delete(index);
	}

	async #fetchChunk(index: number): Promise<void> {
		if (this.signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");

		const start = index * RANGE_CHUNK_SIZE;
		const requestEnd = start + RANGE_CHUNK_SIZE - 1;
		const headers = new Headers({ Range: `bytes=${start}-${requestEnd}` });
		const ifRange = this.#etag && !this.#etag.startsWith("W/") ? this.#etag : this.#lastModified;
		if (ifRange !== null) headers.set("If-Range", ifRange);

		const response = await fetch(this.url, { headers, signal: this.signal });
		if (response.status !== 206) {
			await cancelResponseBody(response);
			throw new Error(`The server returned HTTP ${response.status} to a byte-range request.`);
		}

		const range = parseContentRange(response.headers.get("Content-Range"));
		if (range === null || range.start !== start) {
			await cancelResponseBody(response);
			throw new Error("The server returned an invalid Content-Range header.");
		}
		if (range.total > MAX_FILE_LENGTH) {
			await cancelResponseBody(response);
			throw new Error("PDF files must be smaller than 4 GiB.");
		}
		const expectedEnd = Math.min(requestEnd, range.total - 1);
		if (range.end !== expectedEnd) {
			await cancelResponseBody(response);
			throw new Error("The server returned an incomplete byte range.");
		}
		if (this.#totalLength !== null && range.total !== this.#totalLength) {
			await cancelResponseBody(response);
			throw new Error("The PDF length changed while it was being loaded.");
		}
		if (!this.#matchesValidator(response)) {
			await cancelResponseBody(response);
			throw new Error("The PDF representation changed while it was being loaded.");
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength !== range.end - range.start + 1) {
			throw new Error("The server returned a byte range with an unexpected length.");
		}

		this.#totalLength = range.total;
		this.#rememberValidators(response);
		this.#cache.set(index, bytes);
	}

	#matchesValidator(response: Response): boolean {
		const etag = response.headers.get("ETag");
		const lastModified = response.headers.get("Last-Modified");
		if (this.#etag !== null && etag !== this.#etag) return false;
		if (this.#lastModified !== null && lastModified !== this.#lastModified) return false;
		return true;
	}

	#rememberValidators(response: Response): void {
		this.#etag ??= response.headers.get("ETag");
		this.#lastModified ??= response.headers.get("Last-Modified");
	}
}

async function cancelResponseBody(response: Response): Promise<void> {
	if (response.body === null) return;
	try {
		await response.body.cancel();
	} catch {
		return;
	}
}
