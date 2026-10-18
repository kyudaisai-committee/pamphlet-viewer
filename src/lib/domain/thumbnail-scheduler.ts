import type { PageSource, PageVisual } from "../document/page-source";

export const MAX_THUMBNAIL_ENTRIES = 24;
export const MAX_THUMBNAIL_PIXEL_BYTES = 32 * 1024 * 1024;
const THUMBNAIL_MAX_WIDTH = 144;
const THUMBNAIL_MAX_PIXELS = 160_000;

export interface ThumbnailEntry {
	pageIndex: number;
	visual: PageVisual;
	pixelBytes: number;
}

interface ThumbnailTask {
	pageIndex: number;
	sourceGeneration: number;
	demandGeneration: number;
}

export type ThumbnailRenderer = (pageIndex: number, scale: number) => Promise<PageVisual>;
export type ThumbnailChangeListener = (entries: readonly ThumbnailEntry[]) => void;
export type ThumbnailDemandListener = () => void;

export class ThumbnailScheduler {
	#source: PageSource | null = null;
	#sourceGeneration = 0;
	#demandGeneration = 0;
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
	) {}

	get entries(): readonly ThumbnailEntry[] {
		return Array.from(this.#cache.values());
	}

	setSource(source: PageSource | null): void {
		if (source === this.#source) return;
		this.#sourceGeneration += 1;
		this.#demandGeneration += 1;
		this.#source = source;
		this.#desired.clear();
		this.#queue = [];
		this.#runningPagesBySource.set(this.#sourceGeneration, new Set());
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
				if (Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex < source.pageCount) {
					nextDesired.add(pageIndex);
				}
			}
		}
		this.#desired = nextDesired;
		this.onDemandChange();
		this.#queue = this.#queue
			.filter((task) => nextDesired.has(task.pageIndex))
			.map((task) => ({ ...task, demandGeneration: this.#demandGeneration }));
		this.#enqueueDesiredPages();
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
		const runningPages = this.#runningPagesBySource.get(this.#sourceGeneration);
		for (const pageIndex of this.#desired) {
			if (
				this.#cache.has(pageIndex) ||
				runningPages?.has(pageIndex) === true ||
				this.#queue.some((task) => task.pageIndex === pageIndex)
			) {
				this.get(pageIndex);
				continue;
			}
			this.#queue.push({
				pageIndex,
				sourceGeneration: this.#sourceGeneration,
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
				this.#queue.length > 0
			) {
				const task = this.#queue.shift();
				if (
					task === undefined ||
					task.sourceGeneration !== sourceGeneration ||
					task.demandGeneration !== this.#demandGeneration ||
					!this.#desired.has(task.pageIndex)
				) {
					continue;
				}

				runningPages.add(task.pageIndex);
				try {
					const pageSize = await source.getPageSize(task.pageIndex);
					if (!this.#isCurrent(task, source)) continue;
					const scale = calculateThumbnailScale(pageSize.width, pageSize.height);
					const visual = await this.render(task.pageIndex, scale);
					if (!this.#isCurrent(task, source)) {
						releaseVisual(visual);
						continue;
					}
					this.#store({
						pageIndex: task.pageIndex,
						visual,
						pixelBytes: visual.width * visual.height * 4,
					});
				} catch {
					// A missing thumbnail is retried only when it becomes visible again.
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

	#isCurrent(task: ThumbnailTask, source: PageSource): boolean {
		return (
			task.sourceGeneration === this.#sourceGeneration &&
			task.demandGeneration === this.#demandGeneration &&
			source === this.#source &&
			this.#desired.has(task.pageIndex)
		);
	}

	#enqueueAfterInvalidation(task: ThumbnailTask, source: PageSource): void {
		if (
			task.demandGeneration === this.#demandGeneration ||
			task.sourceGeneration !== this.#sourceGeneration ||
			source !== this.#source ||
			!this.#desired.has(task.pageIndex) ||
			this.#cache.has(task.pageIndex) ||
			this.#queue.some((queuedTask) => queuedTask.pageIndex === task.pageIndex)
		) {
			return;
		}
		this.#queue.push({
			pageIndex: task.pageIndex,
			sourceGeneration: this.#sourceGeneration,
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
			const oldest = this.#cache.entries().next().value as [number, ThumbnailEntry] | undefined;
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

export function calculateThumbnailScale(width: number, height: number): number {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
	return Math.min(
		1,
		THUMBNAIL_MAX_WIDTH / width,
		Math.sqrt(THUMBNAIL_MAX_PIXELS / (width * height)),
	);
}

function releaseVisual(visual: PageVisual): void {
	if (visual.type === "bitmap") visual.bitmap.close();
}
