import { RangeChunkCache } from "./range-chunk-cache";
import { cancelResponseBody, parseContentRange, readBoundedResponseBody } from "./range-response";

export const RANGE_CHUNK_SIZE = 256 * 1024;
export const RANGE_CACHE_LIMIT = 64 * 1024 * 1024;
export const RANGE_FETCH_CONCURRENCY = 4;
export const RANGE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_FILE_LENGTH = 0xffff_ffff;

export { parseContentRange } from "./range-response";

export class PdfRangeLoader {
	#cache: RangeChunkCache;
	#cacheLimitBytes: number;
	#missingChunks = new Set<number>();
	#hintedChunks = new Set<number>();
	#cacheEpoch = 0;
	#totalLength: number | null = null;
	#etag: string | null = null;
	#lastModified: string | null = null;

	constructor(
		private readonly url: string,
		private readonly signal: AbortSignal,
		cacheLimitBytes = RANGE_CACHE_LIMIT,
	) {
		if (!Number.isSafeInteger(cacheLimitBytes) || cacheLimitBytes < RANGE_CHUNK_SIZE) {
			throw new RangeError(`PDF range cache must be at least ${RANGE_CHUNK_SIZE} bytes.`);
		}
		this.#cacheLimitBytes = cacheLimitBytes;
		this.#cache = new RangeChunkCache(
			cacheLimitBytes,
			Math.max(RANGE_CHUNK_SIZE, Math.floor(cacheLimitBytes / 2)),
		);
	}

	get totalLength(): number | null {
		return this.#totalLength;
	}

	get cachedByteLength(): number {
		return this.#cache.byteLength;
	}

	get cacheEpoch(): number {
		return this.#cacheEpoch;
	}

	get hasMissingChunks(): boolean {
		return this.#missingChunks.size > 0;
	}

	get hasHintedChunks(): boolean {
		return this.#hintedChunks.size > 0;
	}

	dispose(): void {
		this.#cache.clear();
		this.#missingChunks.clear();
		this.#hintedChunks.clear();
		this.#totalLength = null;
		this.#etag = null;
		this.#lastModified = null;
	}

	async initialize(): Promise<number> {
		if (this.#totalLength !== null) return this.#totalLength;
		if (await this.#fetchChunk(0)) this.#cacheEpoch += 1;
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
		let rangeAvailable = true;
		for (let index = firstIndex; index <= lastIndex; index += 1) {
			const chunk = this.#cache.get(index);
			if (chunk === undefined) {
				this.#missingChunks.add(index);
				rangeAvailable = false;
			} else chunks.set(index, chunk);
		}
		if (!rangeAvailable) return false;

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

	isRangeAvailable(position: number, length: number): boolean {
		const indexes = this.#getChunkIndexes(position, length);
		let available = true;
		for (const index of indexes) {
			if (this.#cache.get(index) === undefined) {
				this.#missingChunks.add(index);
				available = false;
			}
		}
		return available;
	}

	hintRange(position: number, length: number): void {
		const indexes = this.#getChunkIndexes(position, length);
		for (const index of indexes) {
			if (this.#cache.get(index) === undefined) this.#hintedChunks.add(index);
		}
	}

	clearRangeHints(): void {
		this.#hintedChunks.clear();
	}

	async fetchMissingChunks(includeHints = false): Promise<number> {
		const queuedIndexes = includeHints
			? new Set([...this.#missingChunks, ...this.#hintedChunks])
			: this.#missingChunks;
		const indices = [...queuedIndexes].slice(0, RANGE_FETCH_CONCURRENCY);
		const results = await Promise.allSettled(indices.map((index) => this.#fetchChunk(index)));
		if (results.some((result) => result.status === "fulfilled" && result.value)) {
			this.#cacheEpoch += 1;
		}
		const rejection = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (rejection !== undefined) throw rejection.reason;
		let retainedCount = 0;
		for (const index of indices) {
			if (this.#cache.get(index) !== undefined) {
				this.#missingChunks.delete(index);
				this.#hintedChunks.delete(index);
				retainedCount += 1;
			}
		}
		if (retainedCount !== indices.length) {
			throw new Error("The requested PDF byte ranges exceed the 64 MiB working cache.");
		}
		return retainedCount;
	}

	#getChunkIndexes(position: number, length: number): number[] {
		const totalLength = this.#totalLength;
		if (totalLength === null) throw new Error("Range loader is not initialized.");
		if (
			!Number.isSafeInteger(position) ||
			!Number.isSafeInteger(length) ||
			position < 0 ||
			length < 0 ||
			position + length > totalLength
		) {
			throw new RangeError("PDFium requested bytes outside the PDF document.");
		}
		if (length === 0) return [];
		if (length > this.#cacheLimitBytes) {
			throw new Error("The requested PDF byte range exceeds the 64 MiB working cache.");
		}
		const firstIndex = Math.floor(position / RANGE_CHUNK_SIZE);
		const lastIndex = Math.floor((position + length - 1) / RANGE_CHUNK_SIZE);
		return Array.from(
			{ length: lastIndex - firstIndex + 1 },
			(_value, offset) => firstIndex + offset,
		);
	}

	async #fetchChunk(index: number): Promise<boolean> {
		if (this.signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");

		const requestController = new AbortController();
		let timedOut = false;
		const abortRequest = function abortForParentSignal(): void {
			requestController.abort();
		};
		this.signal.addEventListener("abort", abortRequest, { once: true });
		const timeoutId = setTimeout(function abortTimedOutRequest(): void {
			timedOut = true;
			requestController.abort();
		}, RANGE_REQUEST_TIMEOUT_MS);

		const start = index * RANGE_CHUNK_SIZE;
		const requestEnd = start + RANGE_CHUNK_SIZE - 1;
		const headers = new Headers({ Range: `bytes=${start}-${requestEnd}` });
		const ifRange = this.#etag && !this.#etag.startsWith("W/") ? this.#etag : this.#lastModified;
		if (ifRange !== null) headers.set("If-Range", ifRange);

		try {
			const response = await fetch(this.url, { headers, signal: requestController.signal });
			if (response.status !== 206) {
				cancelResponseBody(response);
				throw new Error(`The server returned HTTP ${response.status} to a byte-range request.`);
			}

			const range = parseContentRange(response.headers.get("Content-Range"));
			if (range === null || range.start !== start) {
				cancelResponseBody(response);
				throw new Error("The server returned an invalid Content-Range header.");
			}
			if (range.total > MAX_FILE_LENGTH) {
				cancelResponseBody(response);
				throw new Error("PDF files must be smaller than 4 GiB.");
			}
			const expectedEnd = Math.min(requestEnd, range.total - 1);
			if (range.end !== expectedEnd) {
				cancelResponseBody(response);
				throw new Error("The server returned an incomplete byte range.");
			}
			if (this.#totalLength !== null && range.total !== this.#totalLength) {
				cancelResponseBody(response);
				throw new Error("The PDF length changed while it was being loaded.");
			}
			if (!this.#matchesValidator(response)) {
				cancelResponseBody(response);
				throw new Error("The PDF representation changed while it was being loaded.");
			}

			const expectedLength = range.end - range.start + 1;
			const bytes = await readBoundedResponseBody(response, expectedLength);
			if (bytes.byteLength !== expectedLength) {
				throw new Error("The server returned a byte range with an unexpected length.");
			}

			this.#totalLength = range.total;
			this.#rememberValidators(response);
			return this.#cache.set(index, bytes);
		} catch (error) {
			if (this.signal.aborted) {
				throw new DOMException("PDF loading was cancelled.", "AbortError");
			}
			if (timedOut) {
				throw new Error("The PDF byte-range request timed out.", { cause: error });
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
			this.signal.removeEventListener("abort", abortRequest);
		}
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
