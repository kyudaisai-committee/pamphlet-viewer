// SPDX-License-Identifier: MPL-2.0

import type { PageSource, PageVisual } from "../document/page-source";
import { PageSourceUnavailableError } from "../document/page-source";

export type PageRenderPriority = "visible" | "thumbnail";

interface RenderTask {
	sequence: number;
	pageIndex: number;
	scale: number;
	priority: PageRenderPriority;
	resolve(visual: PageVisual): void;
	reject(error: unknown): void;
}

export class PageRenderQueue {
	#tasks: RenderTask[] = [];
	#running = false;
	#disposed = false;
	#sequence = 0;

	constructor(private readonly source: PageSource) {}

	render(pageIndex: number, scale: number, priority: PageRenderPriority): Promise<PageVisual> {
		if (this.#disposed) return Promise.reject(createAbortError());
		const sequence = this.#sequence + 1;
		this.#sequence = sequence;
		return new Promise((resolve, reject) => {
			this.#tasks.push({ sequence, pageIndex, scale, priority, resolve, reject });
			this.#tasks.sort((left, right) => {
				const priorityDifference = getPriorityRank(left.priority) - getPriorityRank(right.priority);
				return priorityDifference || left.sequence - right.sequence;
			});
			void this.#drain();
		});
	}

	cancelQueued(priority?: PageRenderPriority): void {
		const retained: RenderTask[] = [];
		for (const task of this.#tasks) {
			if (priority === undefined || task.priority === priority) task.reject(createAbortError());
			else retained.push(task);
		}
		this.#tasks = retained;
	}

	dispose(): void {
		this.#disposed = true;
		this.cancelQueued();
	}

	async #drain(): Promise<void> {
		if (this.#running || this.#disposed) return;
		this.#running = true;
		try {
			while (!this.#disposed && this.#tasks.length > 0) {
				const task = this.#tasks.shift();
				if (task === undefined) continue;
				try {
					if (task.priority === "thumbnail" && this.source.renderThumbnail !== undefined) {
						try {
							const thumbnail = await this.source.renderThumbnail(task.pageIndex);
							if (thumbnail !== null) {
								task.resolve(thumbnail);
								continue;
							}
						} catch (error) {
							if (isUnrecoverableThumbnailError(error)) throw error;
						}
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
	return priority === "visible" ? 0 : 1;
}

function createAbortError(): DOMException {
	return new DOMException("The page render was cancelled.", "AbortError");
}
