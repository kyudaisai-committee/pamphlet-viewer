// SPDX-License-Identifier: MIT

import { calculateThumbnailScale } from "@/lib/document/thumbnail-scale";

import type { PageSource, PageVisual } from "../document/page-source";
import { PageSourceUnavailableError } from "../document/page-source";

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
	#running = false;
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

	async #drain(): Promise<void> {
		if (this.#running || this.#disposed) return;
		this.#running = true;
		try {
			while (!this.#disposed && this.#tasks.length > 0) {
				const task = this.#tasks.shift();
				if (task === undefined) continue;
				try {
					if (task.type === "prefetch") {
						await this.source.prefetchPage?.(task.pageIndex);
						task.resolve();
						continue;
					}
					if (task.priority === "thumbnail") {
						if (this.source.renderThumbnail !== undefined) {
							try {
								const thumbnail = await this.source.renderThumbnail(task.pageIndex);
								if (thumbnail !== null) {
									task.resolve(thumbnail);
									continue;
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
						const pageSize = await this.source.getPageSize(task.pageIndex);
						task.resolve(
							await this.source.renderPage(
								task.pageIndex,
								calculateThumbnailScale(pageSize.width, pageSize.height),
							),
						);
						continue;
					}
					task.resolve(await this.source.renderPage(task.pageIndex, task.scale));
				} catch (error) {
					task.reject(error);
				}
			}
		} finally {
			this.#running = false;
			if (!this.#disposed && this.#tasks.length > 0) void this.#drain();
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
