// SPDX-License-Identifier: MIT

import type { PageSource, PageVisual } from "@/lib/document/page-source";
import { PageSourceUnavailableError } from "@/lib/document/page-source";
import { calculateThumbnailScale } from "@/lib/document/thumbnail-scale";

const MAX_CONCURRENT_RENDERS = 2;

export type PageRenderPriority = "visible" | "thumbnail" | "prefetch";

interface TaskBase {
	sequence: number;
	pageIndex: number;
	priority: PageRenderPriority;
	reject(error: unknown): void;
}

interface RenderTask extends TaskBase {
	type: "render";
	scale: number;
	resolve(visual: PageVisual): void;
}

interface PrefetchTask extends TaskBase {
	type: "prefetch";
	resolve(): void;
}

type PageTask = RenderTask | PrefetchTask;

export class PageRenderQueue {
	#tasks: PageTask[] = [];
	#active = 0;
	#disposed = false;
	#sequence = 0;

	constructor(private readonly source: PageSource) {}

	render(
		pageIndex: number,
		scale: number,
		priority: "visible" | "thumbnail",
	): Promise<PageVisual> {
		if (this.#disposed) return Promise.reject(createAbortError());
		const sequence = this.#sequence + 1;
		this.#sequence = sequence;
		return new Promise((resolve, reject) => {
			this.#enqueue({
				type: "render",
				sequence,
				pageIndex,
				scale,
				priority,
				resolve,
				reject,
			});
		});
	}

	prefetchPage(pageIndex: number): Promise<void> {
		if (this.source.prefetchPage === undefined) return Promise.resolve();
		if (this.#disposed) return Promise.reject(createAbortError());
		const sequence = this.#sequence + 1;
		this.#sequence = sequence;
		return new Promise((resolve, reject) => {
			this.#enqueue({
				type: "prefetch",
				sequence,
				pageIndex,
				priority: "prefetch",
				resolve,
				reject,
			});
		});
	}

	cancelQueued(priority?: PageRenderPriority): void {
		if (priority === undefined || priority === "prefetch") {
			this.source.cancelPrefetchPageRequests?.();
		}
		const retained: PageTask[] = [];
		for (const task of this.#tasks) {
			if (priority === undefined || task.priority === priority)
				task.reject(createAbortError());
			else retained.push(task);
		}
		this.#tasks = retained;
	}

	dispose(): void {
		this.#disposed = true;
		this.cancelQueued();
	}

	#enqueue(task: PageTask): void {
		this.#tasks.push(task);
		this.#tasks.sort((left, right) => {
			const priorityDifference =
				getPriorityRank(left.priority) - getPriorityRank(right.priority);
			return priorityDifference || left.sequence - right.sequence;
		});
		void this.#drain();
	}

	#drain(): void {
		if (this.#disposed) return;
		while (!this.#disposed && this.#active < MAX_CONCURRENT_RENDERS && this.#tasks.length > 0) {
			const renderIndex = this.#tasks.findIndex((task) => task.type === "render");
			if (renderIndex === -1) break;
			const task = this.#tasks.splice(renderIndex, 1)[0];
			if (task === undefined) continue;
			this.#active += 1;
			void this.#run(task);
		}
		while (!this.#disposed) {
			const prefetchIndex = this.#tasks.findIndex((task) => task.type === "prefetch");
			if (prefetchIndex === -1) return;
			const task = this.#tasks.splice(prefetchIndex, 1)[0];
			if (task !== undefined) void this.#run(task);
		}
	}

	async #run(task: PageTask): Promise<void> {
		try {
			if (task.type === "prefetch") {
				await this.source.prefetchPage?.(task.pageIndex);
				task.resolve();
				return;
			}
			if (task.priority === "thumbnail") {
				if (this.source.renderThumbnail !== undefined) {
					try {
						const thumbnail = await this.source.renderThumbnail(task.pageIndex);
						if (thumbnail !== null) {
							task.resolve(thumbnail);
							return;
						}
					} catch (error) {
						if (
							this.source.propagateThumbnailErrors === true ||
							isUnrecoverableThumbnailError(error)
						) {
							throw error;
						}
					}
				}
				const pageSize =
					this.source.getThumbnailPageSize === undefined
						? await this.source.getPageSize(task.pageIndex)
						: await this.source.getThumbnailPageSize(task.pageIndex);
				task.resolve(
					await this.source.renderPage(
						task.pageIndex,
						calculateThumbnailScale(pageSize.width, pageSize.height),
					),
				);
				return;
			}
			task.resolve(await this.source.renderPage(task.pageIndex, task.scale));
		} catch (error) {
			task.reject(error);
		} finally {
			if (task.type === "render") {
				this.#active -= 1;
				this.#drain();
			}
		}
	}
}

function isUnrecoverableThumbnailError(error: unknown): boolean {
	return (
		error instanceof PageSourceUnavailableError ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function getPriorityRank(priority: PageRenderPriority): number {
	if (priority === "visible") return 0;
	if (priority === "thumbnail") return 1;
	return 2;
}

function createAbortError(): DOMException {
	return new DOMException("The page render was cancelled.", "AbortError");
}
