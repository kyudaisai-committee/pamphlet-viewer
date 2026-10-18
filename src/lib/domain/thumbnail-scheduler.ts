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
	generation: number;
}

export type ThumbnailRenderer = (pageIndex: number, scale: number) => Promise<PageVisual>;
export type ThumbnailChangeListener = (entries: readonly ThumbnailEntry[]) => void;
export type ThumbnailDemandListener = () => void;

export class ThumbnailScheduler {
	#source: PageSource | null = null;
	#generation = 0;
	#desired = new Set<number>();
	#queue: ThumbnailTask[] = [];
	#runningPages = new Set<number>();
	#cache = new Map<number, ThumbnailEntry>();
	#cacheBytes = 0;
	#draining = false;

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
		this.#generation += 1;
		this.#source = source;
		this.#desired.clear();
		this.#queue = [];
		this.#runningPages.clear();
		this.onDemandChange();
		this.#clearCache();
		this.#notify();
	}

	setVisiblePages(pageIndexes: readonly number[], prefetchIndexes: readonly number[] = []): void {
		this.#generation += 1;
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
			.map((task) => ({ ...task, generation: this.#generation }));
		this.#enqueueDesiredPages();
		void this.#drain();
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
		for (const pageIndex of this.#desired) {
			if (
				this.#cache.has(pageIndex) ||
				this.#runningPages.has(pageIndex) ||
				this.#queue.some((task) => task.pageIndex === pageIndex)
			) {
				this.get(pageIndex);
				continue;
			}
			this.#queue.push({ pageIndex, generation: this.#generation });
		}
	}

	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (this.#queue.length > 0) {
				const task = this.#queue.shift();
				const source = this.#source;
				if (
					task === undefined ||
					source === null ||
					task.generation !== this.#generation ||
					!this.#desired.has(task.pageIndex)
				) {
					continue;
				}

				this.#runningPages.add(task.pageIndex);
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
					this.#runningPages.delete(task.pageIndex);
					this.#enqueueAfterInvalidation(task, source);
				}
			}
		} finally {
			this.#draining = false;
			if (this.#queue.length > 0) void this.#drain();
		}
	}

	#isCurrent(task: ThumbnailTask, source: PageSource): boolean {
		return (
			task.generation === this.#generation &&
			source === this.#source &&
			this.#desired.has(task.pageIndex)
		);
	}

	#enqueueAfterInvalidation(task: ThumbnailTask, source: PageSource): void {
		if (
			task.generation === this.#generation ||
			source !== this.#source ||
			!this.#desired.has(task.pageIndex) ||
			this.#cache.has(task.pageIndex) ||
			this.#queue.some((queuedTask) => queuedTask.pageIndex === task.pageIndex)
		) {
			return;
		}
		this.#queue.push({ pageIndex: task.pageIndex, generation: this.#generation });
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
