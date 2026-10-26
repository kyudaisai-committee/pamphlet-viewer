// SPDX-License-Identifier: MIT

import { createRangeBatchPlan, type RangeBatch } from "./range-batch";
import { RangeChunkCache } from "./range-chunk-cache";
import { requestPdfRange } from "./range-request";

export const RANGE_CHUNK_SIZE = 256 * 1024;
export const RANGE_CACHE_LIMIT = 64 * 1024 * 1024;
export const RANGE_FETCH_CONCURRENCY = 4;
export const RANGE_REQUEST_MAX_CHUNKS = 4;

export { parseContentRange } from "./range-response";
export { RANGE_REQUEST_TIMEOUT_MS } from "./range-request";

export class PdfRangeLoader {
	#cache: RangeChunkCache;
	#cacheLimitBytes: number;
	#cacheLowWatermarkBytes: number;
	#missingChunks = new Set<number>();
	#hintedChunks = new Set<number>();
	#cacheEpoch = 0;
	#totalLength: number | null = null;
	#etag: string | null = null;
	#lastModified: string | null = null;
	#requestUrl: string;
	#disposed = false;

	constructor(
		url: string,
		private readonly signal: AbortSignal,
		cacheLimitBytes = RANGE_CACHE_LIMIT,
	) {
		this.#requestUrl = url;
		if (!Number.isSafeInteger(cacheLimitBytes) || cacheLimitBytes < RANGE_CHUNK_SIZE) {
			throw new RangeError(`PDF range cache must be at least ${RANGE_CHUNK_SIZE} bytes.`);
		}
		this.#cacheLimitBytes = cacheLimitBytes;
		this.#cacheLowWatermarkBytes = Math.max(RANGE_CHUNK_SIZE, Math.floor(cacheLimitBytes / 2));
		this.#cache = new RangeChunkCache(cacheLimitBytes, this.#cacheLowWatermarkBytes);
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
		this.#disposed = true;
		this.#cache.clear();
		this.#missingChunks.clear();
		this.#hintedChunks.clear();
		this.#totalLength = null;
		this.#etag = null;
		this.#lastModified = null;
	}

	async initialize(): Promise<number> {
		this.#throwIfDisposed();
		if (this.#totalLength !== null) return this.#totalLength;
		if (await this.#fetchBatch({ startIndex: 0, chunkIndexes: [0], hasRequiredChunk: true })) {
			this.#cacheEpoch += 1;
		}
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

	clearMissingChunks(): void {
		this.#missingChunks.clear();
	}

	async fetchMissingChunks(includeHints = false): Promise<number> {
		this.#throwIfDisposed();
		const cacheCapacityChunks = Math.floor(this.#cacheLimitBytes / RANGE_CHUNK_SIZE);
		const freeChunkCapacity = Math.floor(
			(this.#cacheLimitBytes - this.#cache.byteLength) / RANGE_CHUNK_SIZE,
		);
		const evictionChunkCapacity = Math.floor(
			(this.#cacheLimitBytes - this.#cacheLowWatermarkBytes) / RANGE_CHUNK_SIZE,
		);
		const batches = createRangeBatchPlan(this.#missingChunks, this.#hintedChunks, {
			includeHints,
			maxChunkCount: Math.min(
				cacheCapacityChunks,
				Math.max(1, freeChunkCapacity, evictionChunkCapacity),
			),
			maxChunksPerRequest: RANGE_REQUEST_MAX_CHUNKS,
		});
		let cacheEvicted = false;
		for (let offset = 0; offset < batches.length; offset += RANGE_FETCH_CONCURRENCY) {
			const wave = batches.slice(offset, offset + RANGE_FETCH_CONCURRENCY);
			const results = await Promise.allSettled(wave.map((batch) => this.#fetchBatch(batch)));
			this.#throwIfDisposed();
			cacheEvicted ||= results.some((result) => result.status === "fulfilled" && result.value);
			const rejection = results.find(
				(result): result is PromiseRejectedResult => result.status === "rejected",
			);
			if (rejection !== undefined) {
				if (cacheEvicted) this.#cacheEpoch += 1;
				this.#forgetRetainedChunks(batches.slice(0, offset + wave.length));
				throw rejection.reason;
			}
		}
		if (cacheEvicted) this.#cacheEpoch += 1;

		const retainedCount = this.#forgetRetainedChunks(batches);
		if (retainedCount !== batches.reduce((count, batch) => count + batch.chunkIndexes.length, 0)) {
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

	#forgetRetainedChunks(batches: readonly RangeBatch[]): number {
		let retainedCount = 0;
		for (const batch of batches) {
			for (const index of batch.chunkIndexes) {
				if (this.#cache.get(index) === undefined) continue;
				this.#missingChunks.delete(index);
				this.#hintedChunks.delete(index);
				retainedCount += 1;
			}
		}
		return retainedCount;
	}

	async #fetchBatch(batch: RangeBatch): Promise<boolean> {
		this.#throwIfDisposed();
		const start = batch.startIndex * RANGE_CHUNK_SIZE;
		const requestedEnd = start + batch.chunkIndexes.length * RANGE_CHUNK_SIZE - 1;
		const response = await requestPdfRange({
			url: this.#requestUrl,
			signal: this.signal,
			start,
			requestedEnd,
			totalLength: this.#totalLength,
			etag: this.#etag,
			lastModified: this.#lastModified,
		});
		this.#throwIfDisposed();
		if (
			(this.#totalLength !== null && this.#totalLength !== response.totalLength) ||
			(this.#etag !== null && this.#etag !== response.etag) ||
			(this.#lastModified !== null && this.#lastModified !== response.lastModified)
		) {
			throw new Error("The PDF representation changed while it was being loaded.");
		}
		if (this.#totalLength === null && response.responseUrl !== "") {
			this.#requestUrl = response.responseUrl;
		}
		this.#totalLength ??= response.totalLength;
		this.#etag ??= response.etag;
		this.#lastModified ??= response.lastModified;

		let cacheEvicted = false;
		for (const index of batch.chunkIndexes) {
			const chunkOffset = (index - batch.startIndex) * RANGE_CHUNK_SIZE;
			const chunkEnd = Math.min(chunkOffset + RANGE_CHUNK_SIZE, response.bytes.byteLength);
			const chunk = response.bytes.slice(chunkOffset, chunkEnd);
			cacheEvicted = this.#cache.set(index, chunk) || cacheEvicted;
		}
		return cacheEvicted;
	}

	#throwIfDisposed(): void {
		if (this.#disposed) throw new DOMException("PDF loading was cancelled.", "AbortError");
	}
}
