// SPDX-License-Identifier: MIT

import type { PageSource, PageVisual } from "../document/page-source";

export const MAX_PRERENDER_ENTRIES = 4;
export const MAX_PRERENDER_PIXEL_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_PRERENDERS = 2;

export interface PagePrerenderRequest {
	pageIndex: number;
	scale: number;
}

interface PagePrerenderEntry extends PagePrerenderRequest {
	visual: PageVisual;
	pixelBytes: number;
}

interface PagePrerenderTask extends PagePrerenderRequest {
	key: string;
	source: PageSource;
	state: "queued" | "running";
	claimed: boolean;
	desired: boolean;
	preserveResult: boolean;
	result: Promise<PageVisual> | null;
}

export class PagePrerenderScheduler {
	#source: PageSource | null = null;
	#active = 0;
	#queue: PagePrerenderTask[] = [];
	#tasksByKey = new Map<string, PagePrerenderTask>();
	#cache = new Map<string, PagePrerenderEntry>();
	#cacheBytes = 0;

	setSource(source: PageSource | null): void {
		if (source === this.#source) return;
		this.#source = source;
		this.#queue = [];
		this.#tasksByKey.clear();
		this.#clearCache();
	}

	setRequests(requests: readonly PagePrerenderRequest[], preserveCache = false): void {
		const uniqueRequests = new Map<string, PagePrerenderRequest>();
		if (this.#source !== null) {
			for (const request of requests) {
				if (
					!Number.isSafeInteger(request.pageIndex) ||
					request.pageIndex < 0 ||
					request.pageIndex >= this.#source.pageCount ||
					!Number.isFinite(request.scale) ||
					request.scale <= 0
				) {
					continue;
				}
				uniqueRequests.set(createKey(request.pageIndex, request.scale), request);
			}
		}

		for (const [key, task] of this.#tasksByKey) {
			task.desired = uniqueRequests.has(key);
			task.preserveResult = preserveCache;
			if (task.state === "queued" && !task.desired && !task.claimed) {
				this.#tasksByKey.delete(key);
			}
		}
		this.#queue = this.#queue.filter((task) => this.#tasksByKey.get(task.key) === task);
		if (!preserveCache) {
			const wantedKeys = new Set(uniqueRequests.keys());
			for (const [key, entry] of this.#cache) {
				if (!wantedKeys.has(key)) this.#deleteEntry(key, entry);
			}
		}
		for (const [key, request] of uniqueRequests) {
			this.#touch(key);
			if (this.#cache.has(key) || this.#tasksByKey.has(key)) continue;
			const source = this.#source;
			if (source === null) continue;
			const task: PagePrerenderTask = {
				...request,
				key,
				source,
				state: "queued",
				claimed: false,
				desired: true,
				preserveResult: false,
				result: null,
			};
			this.#tasksByKey.set(key, task);
			this.#queue.push(task);
		}
		this.#drain();
	}

	take(pageIndex: number, scale: number): PageVisual | undefined {
		const key = createKey(pageIndex, scale);
		const entry = this.#cache.get(key);
		if (entry === undefined) return undefined;
		this.#removeEntry(key, entry, false);
		return entry.visual;
	}

	claim(pageIndex: number, scale: number): Promise<PageVisual> | undefined {
		const cached = this.take(pageIndex, scale);
		if (cached !== undefined) return Promise.resolve(cached);
		const task = this.#tasksByKey.get(createKey(pageIndex, scale));
		if (task?.state !== "running" || task.result === null || task.source !== this.#source) {
			return undefined;
		}
		task.claimed = true;
		task.desired = true;
		return task.result;
	}

	clear(): void {
		this.#queue = [];
		this.#tasksByKey.clear();
		this.#clearCache();
	}

	#drain(): void {
		while (this.#active < MAX_CONCURRENT_PRERENDERS && this.#queue.length > 0) {
			const request = this.#queue.shift();
			if (request === undefined || request.source !== this.#source) continue;
			this.#active += 1;
			request.state = "running";
			request.result = Promise.resolve().then(() =>
				request.source.renderPrefetchedPage(request.pageIndex, request.scale),
			);
			void this.#finish(request);
		}
	}

	async #finish(task: PagePrerenderTask): Promise<void> {
		try {
			if (task.result === null) return;
			const visual = await task.result;
			if (task.claimed) {
				// The foreground caller owns the result returned by claim().
			} else if (task.source !== this.#source || this.#tasksByKey.get(task.key) !== task) {
				releaseVisual(visual);
			} else if (task.desired || task.preserveResult) {
				this.#store({
					pageIndex: task.pageIndex,
					scale: task.scale,
					visual,
					pixelBytes: visual.width * visual.height * 4,
				});
			} else {
				releaseVisual(visual);
			}
		} catch {
			// Speculative renders are retried when the page becomes visible.
		} finally {
			if (this.#tasksByKey.get(task.key) === task) this.#tasksByKey.delete(task.key);
			this.#active -= 1;
			this.#drain();
		}
	}

	#store(entry: PagePrerenderEntry): void {
		const key = createKey(entry.pageIndex, entry.scale);
		if (
			!Number.isSafeInteger(entry.pixelBytes) ||
			entry.pixelBytes <= 0 ||
			entry.pixelBytes > MAX_PRERENDER_PIXEL_BYTES
		) {
			releaseVisual(entry.visual);
			return;
		}
		const previous = this.#cache.get(key);
		if (previous !== undefined) this.#deleteEntry(key, previous);
		this.#cache.set(key, entry);
		this.#cacheBytes += entry.pixelBytes;
		while (
			this.#cache.size > MAX_PRERENDER_ENTRIES ||
			this.#cacheBytes > MAX_PRERENDER_PIXEL_BYTES
		) {
			const oldest = this.#cache.entries().next().value as
				| [string, PagePrerenderEntry]
				| undefined;
			if (oldest === undefined) return;
			this.#deleteEntry(oldest[0], oldest[1]);
		}
	}

	#touch(key: string): void {
		const entry = this.#cache.get(key);
		if (entry === undefined) return;
		this.#cache.delete(key);
		this.#cache.set(key, entry);
	}

	#deleteEntry(key: string, entry: PagePrerenderEntry): void {
		this.#removeEntry(key, entry, true);
	}

	#removeEntry(key: string, entry: PagePrerenderEntry, release: boolean): void {
		this.#cache.delete(key);
		this.#cacheBytes -= entry.pixelBytes;
		if (release) releaseVisual(entry.visual);
	}

	#clearCache(): void {
		for (const [key, entry] of this.#cache) this.#deleteEntry(key, entry);
	}
}

function createKey(pageIndex: number, scale: number): string {
	return `${pageIndex}:${scale}`;
}

function releaseVisual(visual: PageVisual): void {
	if (visual.type === "bitmap") visual.bitmap.close();
}
