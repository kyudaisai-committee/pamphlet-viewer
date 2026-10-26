// SPDX-License-Identifier: MIT

import {
	PageTaskScheduler,
	type PageTaskPriority,
} from "@/lib/domain/scheduling/page-task-scheduler";

import { RangeChunkCache } from "./range-chunk-cache";
import {
	RANGE_CHUNK_SIZE,
	RANGE_FETCH_CONCURRENCY,
	RANGE_REQUEST_MAX_CHUNKS,
} from "./range-loader";
import {
	PdfRepresentationChangedError,
	requestPdfRange,
	type PdfRangeResponse,
} from "./range-request";
import type { RangeTransportRequest } from "./range-transport";

export const RANGE_BROKER_CACHE_LIMIT = 128 * 1024 * 1024;

interface CachedChunk {
	bytes: Uint8Array;
	response: Omit<PdfRangeResponse, "bytes">;
}

interface PendingChunk {
	promise: Promise<CachedChunk>;
	resolve(chunk: CachedChunk): void;
	reject(error: unknown): void;
	waiters: number;
	batchKey: string | null;
	priority: PageTaskPriority;
}

interface FetchBatch {
	key: string;
	indexes: number[];
	pendingChunks: Map<number, PendingChunk>;
	priority: PageTaskPriority;
	state: "queued" | "running";
	controller: AbortController;
	scheduled: Promise<void> | null;
}

export class PdfRangeBroker {
	#cache: RangeChunkCache;
	#pending = new Map<number, PendingChunk>();
	#queue = new Set<number>();
	#batches = new Map<string, FetchBatch>();
	#scheduler = new PageTaskScheduler({
		maximumConcurrent: RANGE_FETCH_CONCURRENCY,
		reservedVisible: Math.floor(RANGE_FETCH_CONCURRENCY / 2),
	});
	#controller = new AbortController();
	#requestUrl: string;
	#totalLength: number | null = null;
	#etag: string | null = null;
	#lastModified: string | null = null;
	#terminalError: PdfRepresentationChangedError | null = null;
	#disposed = false;
	#queuedDrain = false;
	#batchSequence = 0;

	constructor(
		private readonly source: string,
		cacheLimitBytes = RANGE_BROKER_CACHE_LIMIT,
	) {
		if (!Number.isSafeInteger(cacheLimitBytes) || cacheLimitBytes < RANGE_CHUNK_SIZE) {
			throw new RangeError(
				`PDF range broker cache must be at least ${RANGE_CHUNK_SIZE} bytes.`,
			);
		}
		this.#requestUrl = source;
		this.#cache = new RangeChunkCache(
			cacheLimitBytes,
			Math.max(RANGE_CHUNK_SIZE, Math.floor(cacheLimitBytes / 2)),
		);
	}

	get cachedByteLength(): number {
		return this.#cache.byteLength;
	}

	get pendingChunkCount(): number {
		return this.#pending.size;
	}

	async request(request: RangeTransportRequest, signal: AbortSignal): Promise<PdfRangeResponse> {
		this.#assertActive();
		if (signal.aborted) throw createAbortError();
		if (!this.#isSourceUrl(request.url)) {
			throw new Error("A PDF worker requested ranges for a different document.");
		}
		this.#assertMetadata(request);

		const firstIndex = Math.floor(request.start / RANGE_CHUNK_SIZE);
		const effectiveEnd =
			this.#totalLength === null
				? request.requestedEnd
				: Math.min(request.requestedEnd, this.#totalLength - 1);
		if (request.start > effectiveEnd)
			throw new Error("The requested PDF range starts beyond EOF.");
		const lastIndex = Math.floor(effectiveEnd / RANGE_CHUNK_SIZE);
		const chunks = await Promise.all(
			Array.from({ length: lastIndex - firstIndex + 1 }, (_value, offset) =>
				this.#getChunk(firstIndex + offset, request.priority, signal),
			),
		);
		this.#throwIfAborted(signal);

		const totalLength = chunks[0]?.response.totalLength ?? this.#totalLength;
		if (totalLength === null)
			throw new Error("The PDF byte-range response omitted its file length.");
		const end = Math.min(request.requestedEnd, totalLength - 1);
		const bytes = new Uint8Array(end - request.start + 1);
		for (let index = 0; index < chunks.length; index += 1) {
			const chunk = chunks[index];
			if (chunk === undefined) continue;
			const startOffset = Math.max(request.start, (firstIndex + index) * RANGE_CHUNK_SIZE);
			const endOffset = Math.min(end + 1, (firstIndex + index + 1) * RANGE_CHUNK_SIZE);
			bytes.set(
				chunk.bytes.subarray(
					startOffset - (firstIndex + index) * RANGE_CHUNK_SIZE,
					endOffset - (firstIndex + index) * RANGE_CHUNK_SIZE,
				),
				startOffset - request.start,
			);
		}
		const responseMetadata = chunks[0]?.response;
		if (responseMetadata === undefined) throw new Error("The requested PDF range was empty.");
		return { bytes, ...responseMetadata };
	}

	dispose(): void {
		this.#invalidate(createAbortError());
	}

	#invalidate(error: Error): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (error instanceof PdfRepresentationChangedError) this.#terminalError = error;
		this.#controller.abort();
		this.#scheduler.dispose();
		this.#cache.clear();
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#queue.clear();
		this.#batches.clear();
		this.#totalLength = null;
		this.#etag = null;
		this.#lastModified = null;
	}

	#getChunk(
		index: number,
		priority: PageTaskPriority,
		signal: AbortSignal,
	): Promise<CachedChunk> {
		const cached = this.#cache.get(index);
		if (cached !== undefined) {
			const metadata = this.#getMetadata();
			return Promise.resolve({ bytes: cached, response: metadata });
		}

		let pending = this.#pending.get(index);
		if (
			pending !== undefined &&
			pending.waiters === 0 &&
			pending.batchKey !== null &&
			this.#batches.get(pending.batchKey)?.controller.signal.aborted === true
		) {
			if (this.#pending.get(index) === pending) this.#pending.delete(index);
			pending = undefined;
		}
		if (pending === undefined) {
			pending = createPendingChunk(priority);
			this.#pending.set(index, pending);
			this.#queue.add(index);
		} else if (getPriorityRank(priority) < getPriorityRank(pending.priority)) {
			pending.priority = priority;
		}
		pending.waiters += 1;
		const batch = pending.batchKey === null ? undefined : this.#batches.get(pending.batchKey);
		if (batch !== undefined && getPriorityRank(priority) < getPriorityRank(batch.priority)) {
			batch.priority = priority;
			if (batch.state === "queued") this.#promoteBatch(batch);
		}
		this.#scheduleDrain();
		return waitWithSignal(pending.promise, signal).finally(() => {
			pending.waiters -= 1;
			if (pending.waiters === 0 && pending.batchKey === null) {
				this.#queue.delete(index);
				if (this.#pending.get(index) === pending) this.#pending.delete(index);
			}
			const currentBatch =
				pending.batchKey === null ? undefined : this.#batches.get(pending.batchKey);
			if (
				currentBatch?.state === "running" &&
				currentBatch.indexes.every(
					(chunkIndex) => this.#pending.get(chunkIndex)?.waiters === 0,
				)
			) {
				currentBatch.controller.abort();
			}
		});
	}

	#scheduleDrain(): void {
		if (this.#queuedDrain || this.#disposed) return;
		this.#queuedDrain = true;
		queueMicrotask(() => {
			this.#queuedDrain = false;
			this.#drainQueue();
		});
	}

	#drainQueue(): void {
		while (this.#queue.size > 0) {
			const first = Math.min(...this.#queue);
			const indexes = [first];
			while (
				indexes.length < RANGE_REQUEST_MAX_CHUNKS &&
				this.#queue.has(first + indexes.length)
			) {
				indexes.push(first + indexes.length);
			}
			for (const index of indexes) this.#queue.delete(index);
			const priority = indexes.reduce<PageTaskPriority>((best, index) => {
				const candidate = this.#pending.get(index);
				return candidate !== undefined &&
					getPriorityRank(best) > getPriorityRank(candidate.priority)
					? candidate.priority
					: best;
			}, "thumbnail");
			const batch: FetchBatch = {
				key: `range:${indexes[0]}-${indexes.at(-1)}:${this.#batchSequence}`,
				indexes,
				pendingChunks: new Map(
					indexes.flatMap((index) => {
						const pending = this.#pending.get(index);
						return pending === undefined ? [] : [[index, pending] as const];
					}),
				),
				priority,
				state: "queued",
				controller: new AbortController(),
				scheduled: null,
			};
			this.#batchSequence += 1;
			for (const index of indexes) {
				const pending = this.#pending.get(index);
				if (pending !== undefined) pending.batchKey = batch.key;
			}
			this.#batches.set(batch.key, batch);
			this.#scheduleBatch(batch);
		}
	}

	#scheduleBatch(batch: FetchBatch): void {
		if (batch.scheduled !== null) return;
		batch.scheduled = this.#submitBatch(batch);
	}

	#promoteBatch(batch: FetchBatch): void {
		void this.#submitBatch(batch).catch((error: unknown) => this.#failBatch(batch, error));
	}

	#submitBatch(batch: FetchBatch): Promise<void> {
		const task = {
			key: batch.key,
			priority: batch.priority,
			execute: (signal: AbortSignal) => this.#fetchBatch(batch, signal),
		};
		return this.#scheduler
			.schedule(task, this.#controller.signal)
			.then((lease) => {
				lease.release();
			})
			.catch((error: unknown) => {
				this.#failBatch(batch, error);
				this.#dropBatch(batch);
			});
	}

	async #fetchBatch(batch: FetchBatch, schedulerSignal: AbortSignal): Promise<void> {
		if (batch.indexes.every((index) => this.#pending.get(index)?.waiters === 0)) {
			this.#dropBatch(batch);
			return;
		}
		batch.state = "running";
		const controller = new AbortController();
		const abort = function abortIfUnscheduled(): void {
			controller.abort();
		};
		schedulerSignal.addEventListener("abort", abort, { once: true });
		batch.controller = controller;
		try {
			const start = (batch.indexes[0] ?? 0) * RANGE_CHUNK_SIZE;
			const requestedEnd = start + batch.indexes.length * RANGE_CHUNK_SIZE - 1;
			let response: PdfRangeResponse;
			try {
				response = await requestPdfRange({
					url: this.#requestUrl,
					signal: controller.signal,
					start,
					requestedEnd,
					totalLength: this.#totalLength,
					etag: this.#etag,
					lastModified: this.#lastModified,
				});
			} catch (error) {
				if (error instanceof PdfRepresentationChangedError) this.#invalidate(error);
				throw error;
			}
			this.#throwIfAborted(controller.signal);
			this.#acceptResponse(response);
			for (const index of batch.indexes) {
				const offset = (index - (batch.indexes[0] ?? index)) * RANGE_CHUNK_SIZE;
				const end = Math.min(offset + RANGE_CHUNK_SIZE, response.bytes.byteLength);
				const chunk: CachedChunk = {
					bytes:
						offset < response.bytes.byteLength
							? response.bytes.slice(offset, end)
							: new Uint8Array(),
					response: omitBytes(response),
				};
				const pending = batch.pendingChunks.get(index);
				if (
					pending === undefined ||
					this.#pending.get(index) !== pending ||
					pending.waiters === 0
				) {
					continue;
				}
				if (chunk.bytes.byteLength > 0) this.#cache.set(index, chunk.bytes);
				pending.resolve(chunk);
			}
		} catch (error) {
			this.#failBatch(batch, error);
		} finally {
			schedulerSignal.removeEventListener("abort", abort);
			this.#dropBatch(batch);
		}
	}

	#acceptResponse(response: PdfRangeResponse): void {
		if (
			(this.#totalLength !== null && this.#totalLength !== response.totalLength) ||
			(this.#etag !== null && this.#etag !== response.etag) ||
			(this.#lastModified !== null && this.#lastModified !== response.lastModified)
		) {
			const error = new PdfRepresentationChangedError(
				"The PDF representation changed while it was being loaded.",
			);
			this.#invalidate(error);
			throw error;
		}
		if (this.#totalLength === null && response.responseUrl !== "") {
			this.#requestUrl = response.responseUrl;
		}
		this.#totalLength ??= response.totalLength;
		this.#etag ??= response.etag;
		this.#lastModified ??= response.lastModified;
	}

	#assertMetadata(request: RangeTransportRequest): void {
		if (
			(request.totalLength !== null && request.totalLength !== this.#totalLength) ||
			(request.etag !== null && request.etag !== this.#etag) ||
			(request.lastModified !== null && request.lastModified !== this.#lastModified)
		) {
			const error = new PdfRepresentationChangedError(
				"The PDF representation changed while it was being loaded.",
			);
			this.#invalidate(error);
			throw error;
		}
	}

	#getMetadata(): Omit<PdfRangeResponse, "bytes"> {
		if (this.#totalLength === null)
			throw new Error("The PDF range response metadata is unavailable.");
		return {
			totalLength: this.#totalLength,
			etag: this.#etag,
			lastModified: this.#lastModified,
			responseUrl: this.#requestUrl,
		};
	}

	#isSourceUrl(url: string): boolean {
		return url === this.source || url === this.#requestUrl;
	}

	#failBatch(batch: FetchBatch, error: unknown): void {
		for (const index of batch.indexes) {
			const pending = batch.pendingChunks.get(index);
			if (pending === undefined || this.#pending.get(index) !== pending) continue;
			pending.reject(error);
			this.#pending.delete(index);
		}
	}

	#dropBatch(batch: FetchBatch): void {
		if (this.#batches.get(batch.key) === batch) this.#batches.delete(batch.key);
		for (const index of batch.indexes) {
			const pending = batch.pendingChunks.get(index);
			if (pending?.batchKey !== batch.key) continue;
			pending.batchKey = null;
			if (pending.waiters === 0 && this.#pending.get(index) === pending) {
				this.#pending.delete(index);
			}
		}
		this.#scheduleDrain();
	}

	#assertActive(): void {
		if (this.#disposed) throw this.#terminalError ?? createAbortError();
	}

	#throwIfAborted(signal: AbortSignal): void {
		this.#assertActive();
		if (signal.aborted) throw createAbortError();
	}
}

function createPendingChunk(priority: PageTaskPriority): PendingChunk {
	let resolve: (chunk: CachedChunk) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<CachedChunk>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject, waiters: 0, batchKey: null, priority };
}

function getPriorityRank(priority: PageTaskPriority): number {
	if (priority === "visible") return 0;
	if (priority === "data") return 1;
	if (priority === "prerender") return 2;
	return 3;
}

function waitWithSignal<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) return Promise.reject(createAbortError());
	return new Promise((resolve, reject) => {
		const abort = function rejectAbortedWait(): void {
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function omitBytes(response: PdfRangeResponse): Omit<PdfRangeResponse, "bytes"> {
	return {
		totalLength: response.totalLength,
		etag: response.etag,
		lastModified: response.lastModified,
		responseUrl: response.responseUrl,
	};
}

function createAbortError(): DOMException {
	return new DOMException("PDF range request was cancelled.", "AbortError");
}
