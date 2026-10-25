// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, vi } from "vitest";

import type { PageSource, PageVisual } from "@/lib/document/page-source";

import { PageRenderQueue } from "./page-render-queue";

describe("PageRenderQueue", () => {
	it("prioritizes a visible page over queued thumbnails", async () => {
		const requests: number[] = [];
		const pending: Array<(visual: PageVisual) => void> = [];
		const queue = new PageRenderQueue(
			createPageSource((pageIndex) => {
				requests.push(pageIndex);
				return new Promise((resolve) => pending.push(resolve));
			}),
		);

		const activeThumbnail = queue.render(1, 0.3, "thumbnail");
		await vi.waitFor(() => expect(requests).toEqual([1]));
		const queuedThumbnail = queue.render(2, 0.3, "thumbnail");
		const visiblePage = queue.render(7, 1, "visible");
		pending[0]?.(pixelVisual());
		await activeThumbnail;
		await vi.waitFor(() => expect(requests).toEqual([1, 7]));
		pending[1]?.(pixelVisual());
		await visiblePage;
		await vi.waitFor(() => expect(requests).toEqual([1, 7, 2]));
		pending[2]?.(pixelVisual());
		await queuedThumbnail;
		queue.dispose();
	});

	it("cancels queued thumbnail work when demand disappears", async () => {
		const requests: number[] = [];
		const pending: Array<(visual: PageVisual) => void> = [];
		const queue = new PageRenderQueue(
			createPageSource((pageIndex) => {
				requests.push(pageIndex);
				return new Promise((resolve) => pending.push(resolve));
			}),
		);
		const active = queue.render(1, 0.3, "thumbnail");
		await vi.waitFor(() => expect(requests).toEqual([1]));
		const cancelled = queue.render(2, 0.3, "thumbnail");
		const visible = queue.render(3, 1, "visible");
		queue.cancelQueued("thumbnail");
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		pending[0]?.(pixelVisual());
		await active;
		await vi.waitFor(() => expect(requests).toEqual([1, 3]));
		pending[1]?.(pixelVisual());
		await visible;
		queue.dispose();
	});
});

function createPageSource(renderPage: (pageIndex: number) => Promise<PageVisual>): PageSource {
	return {
		pageCount: 12,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		renderPage,
		dispose() {},
	};
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}
