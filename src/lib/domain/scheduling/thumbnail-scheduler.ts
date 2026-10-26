// SPDX-License-Identifier: MIT

import type { PageSource, PageVisual } from "@/lib/document/page-source";
import { PageSourceUnavailableError } from "@/lib/document/page-source";

export const MAX_THUMBNAIL_PIXEL_BYTES = 32 * 1024 * 1024;
export const MAX_THUMBNAIL_ENTRIES = Number.MAX_SAFE_INTEGER;

export interface ThumbnailEntry {
	pageIndex: number;
	visual: PageVisual;
	pixelBytes: number;
}

interface ThumbnailTask {
	pageIndex: number;
	sourceGeneration: number;
	kind: "visible" | "embedded";
	demandGeneration: number | null;
}

export type ThumbnailRenderer = (pageIndex: number, scale: number) => Promise<PageVisual>;
export type ThumbnailChangeListener = (entries: readonly ThumbnailEntry[]) => void;
export type ThumbnailDemandListener = () => void;
export type ThumbnailSourceUnavailableListener = () => void;

export class ThumbnailScheduler {
	#source: PageSource | null = null;
	#sourceGeneration = 0;
	#demandGeneration = 0;
	#unavailableSourceGeneration: number | null = null;
	#embeddedPrefetchIndex = 0;
	#willPrefetchEmbeddedThumbnails = false;
	#desired = new Set<number>();
	#queue: ThumbnailTask[] = [];
	#runningPagesBySource = new Map<number, Set<number>>();
	#drainingSources = new Set<number>();
	#cache = new Map<number, ThumbnailEntry>();
	#cacheBytes = 0;

	constructor(
		private readonly render: ThumbnailRenderer,
		private readonly onChange: ThumbnailChangeListener,
		private readonly onDemandChange: ThumbnailDemandListener = () => undefined,
		private readonly maxEntries = MAX_THUMBNAIL_ENTRIES,
		private readonly maxPixelBytes = MAX_THUMBNAIL_PIXEL_BYTES,
		private readonly onSourceUnavailable: ThumbnailSourceUnavailableListener = () => undefined,
	) {}

	get entries(): readonly ThumbnailEntry[] {
		return Array.from(this.#cache.values());
	}

	setSource(source: PageSource | null): void {
		if (source === this.#source) return;
		if (!this.#drainingSources.has(this.#sourceGeneration)) {
			this.#runningPagesBySource.delete(this.#sourceGeneration);
		}
		this.#sourceGeneration += 1;
		this.#demandGeneration += 1;
		this.#unavailableSourceGeneration = null;
		this.#embeddedPrefetchIndex = 0;
		this.#willPrefetchEmbeddedThumbnails = source?.prefetchThumbnail !== undefined;
		this.#source = source;
		this.#desired.clear();
		this.#queue = [];
		if (source !== null) {
			this.#runningPagesBySource.set(this.#sourceGeneration, new Set());
		}
		this.onDemandChange();
		this.#clearCache();
		this.#notify();
	}

	setVisiblePages(pageIndexes: readonly number[], prefetchIndexes: readonly number[] = []): void {
		this.#demandGeneration += 1;
		const source = this.#source;
		const nextDesired = new Set<number>();
		if (source !== null) {
			for (const pageIndex of [...pageIndexes, ...prefetchIndexes]) {
				if (
					Number.isSafeInteger(pageIndex) &&
					pageIndex >= 0 &&
					pageIndex < source.pageCount
				) {
					nextDesired.add(pageIndex);
				}
			}
		}
		this.#desired = nextDesired;
		this.onDemandChange();
		this.#queue = [];
		this.#enqueueDesiredPages();
		const desiredOrder = new Map(
			Array.from(nextDesired, (pageIndex, index) => [pageIndex, index]),
		);
		this.#queue.sort((left, right) => {
			if (left.kind !== right.kind) return left.kind === "visible" ? -1 : 1;
			if (left.kind === "embedded" || right.kind === "embedded") {
				return left.pageIndex - right.pageIndex;
			}
			return (
				(desiredOrder.get(left.pageIndex) ?? 0) - (desiredOrder.get(right.pageIndex) ?? 0)
			);
		});
		if (source !== null) void this.#drain(this.#sourceGeneration, source);
	}

	close(): void {
		this.setVisiblePages([]);
	}

	get(pageIndex: number): ThumbnailEntry | undefined {
		const entry = this.#cache.get(pageIndex);
		if (entry === undefined) return undefined;
		this.#cache.delete(pageIndex);
		this.#cache.set(pageIndex, entry);
		return entry;
	}

	#enqueueDesiredPages(): void {
		if (this.#unavailableSourceGeneration === this.#sourceGeneration) return;
		const runningPages = this.#runningPagesBySource.get(this.#sourceGeneration);
		for (const pageIndex of this.#desired) {
			if (
				this.#cache.has(pageIndex) ||
				runningPages?.has(pageIndex) === true ||
				this.#queue.some((task) => task.pageIndex === pageIndex && task.kind === "visible")
			) {
				this.get(pageIndex);
				continue;
			}
			this.#queue.push({
				pageIndex,
				sourceGeneration: this.#sourceGeneration,
				kind: "visible",
				demandGeneration: this.#demandGeneration,
			});
		}
	}

	async #drain(sourceGeneration: number, source: PageSource): Promise<void> {
		if (
			sourceGeneration !== this.#sourceGeneration ||
			source !== this.#source ||
			this.#drainingSources.has(sourceGeneration)
		) {
			return;
		}
		const runningPages = this.#runningPagesBySource.get(sourceGeneration);
		if (runningPages === undefined) return;
		this.#drainingSources.add(sourceGeneration);
		try {
			while (
				sourceGeneration === this.#sourceGeneration &&
				source === this.#source &&
				(this.#queue.length > 0 ||
					(this.#willPrefetchEmbeddedThumbnails &&
						this.#embeddedPrefetchIndex < source.pageCount))
			) {
				let task = this.#queue.shift();
				if (task === undefined) {
					const pageIndex = this.#embeddedPrefetchIndex;
					this.#embeddedPrefetchIndex += 1;
					if (this.#cache.has(pageIndex)) continue;
					task = {
						pageIndex,
						sourceGeneration,
						kind: "embedded",
						demandGeneration: null,
					};
				}
				if (
					task.sourceGeneration !== sourceGeneration ||
					(task.kind === "visible" &&
						(task.demandGeneration !== this.#demandGeneration ||
							!this.#desired.has(task.pageIndex)))
				) {
					continue;
				}
				if (task.kind === "embedded" && this.#cache.has(task.pageIndex)) continue;

				runningPages.add(task.pageIndex);
				try {
					const visual =
						task.kind === "embedded"
							? await source.prefetchThumbnail?.(task.pageIndex)
							: await this.render(task.pageIndex, 1);
					if (visual === null || visual === undefined) continue;
					if (
						!this.#isSourceCurrent(task.sourceGeneration, source) ||
						(task.kind === "visible" &&
							(task.demandGeneration !== this.#demandGeneration ||
								!this.#desired.has(task.pageIndex)))
					) {
						releaseVisual(visual);
						continue;
					}
					this.#store({
						pageIndex: task.pageIndex,
						visual,
						pixelBytes: visual.width * visual.height * 4,
					});
				} catch (error) {
					if (
						error instanceof PageSourceUnavailableError &&
						this.#isSourceCurrent(sourceGeneration, source)
					) {
						this.#unavailableSourceGeneration = sourceGeneration;
						this.#willPrefetchEmbeddedThumbnails = false;
						this.#desired.clear();
						this.#queue = [];
						this.onDemandChange();
						this.onSourceUnavailable();
					}
					// Ordinary thumbnail failures are retried only when they become visible again.
				} finally {
					runningPages.delete(task.pageIndex);
					if (sourceGeneration === this.#sourceGeneration && source === this.#source) {
						this.#enqueueAfterInvalidation(task, source);
					}
				}
			}
		} finally {
			this.#drainingSources.delete(sourceGeneration);
			if (
				sourceGeneration !== this.#sourceGeneration &&
				runningPages.size === 0 &&
				this.#runningPagesBySource.get(sourceGeneration) === runningPages
			) {
				this.#runningPagesBySource.delete(sourceGeneration);
			}
			if (
				sourceGeneration === this.#sourceGeneration &&
				source === this.#source &&
				this.#queue.length > 0
			) {
				void this.#drain(sourceGeneration, source);
			}
		}
	}

	#isSourceCurrent(sourceGeneration: number, source: PageSource): boolean {
		return sourceGeneration === this.#sourceGeneration && source === this.#source;
	}

	#enqueueAfterInvalidation(task: ThumbnailTask, source: PageSource): void {
		if (
			!this.#isSourceCurrent(task.sourceGeneration, source) ||
			this.#unavailableSourceGeneration === task.sourceGeneration ||
			(task.kind === "visible" && task.demandGeneration === this.#demandGeneration) ||
			!this.#desired.has(task.pageIndex) ||
			this.#cache.has(task.pageIndex) ||
			this.#queue.some((queuedTask) => queuedTask.pageIndex === task.pageIndex)
		) {
			return;
		}
		this.#queue.unshift({
			pageIndex: task.pageIndex,
			sourceGeneration: this.#sourceGeneration,
			kind: "visible",
			demandGeneration: this.#demandGeneration,
		});
	}

	#store(entry: ThumbnailEntry): void {
		const previous = this.#cache.get(entry.pageIndex);
		if (previous !== undefined) {
			this.#cacheBytes -= previous.pixelBytes;
			releaseVisual(previous.visual);
			this.#cache.delete(entry.pageIndex);
		}
		if (entry.pixelBytes > this.maxPixelBytes) {
			releaseVisual(entry.visual);
			return;
		}
		this.#cache.set(entry.pageIndex, entry);
		this.#cacheBytes += entry.pixelBytes;
		while (this.#cache.size > this.maxEntries || this.#cacheBytes > this.maxPixelBytes) {
			const oldest = this.#cache.entries().next().value as
				| [number, ThumbnailEntry]
				| undefined;
			if (oldest === undefined) break;
			this.#cache.delete(oldest[0]);
			this.#cacheBytes -= oldest[1].pixelBytes;
			releaseVisual(oldest[1].visual);
		}
		this.#notify();
	}

	#clearCache(): void {
		for (const entry of this.#cache.values()) releaseVisual(entry.visual);
		this.#cache.clear();
		this.#cacheBytes = 0;
	}

	#notify(): void {
		this.onChange(this.entries);
	}
}

function releaseVisual(visual: PageVisual): void {
	if (visual.type === "bitmap") visual.bitmap.close();
}
