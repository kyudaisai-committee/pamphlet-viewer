import { describe, expect, it, vi } from "vitest";

import {
	PageSourceUnavailableError,
	type PageSource,
	type PageVisual,
} from "@/lib/document/page-source";

import { PageRenderQueue } from "./page-render-queue";

describe("PageRenderQueue", () => {
	it("prioritizes a visible page over queued thumbnails", async () => {
		const requests: string[] = [];
		const pending: Array<(visual: PageVisual) => void> = [];
		let finishPrefetch: () => void = () => undefined;
		const source = createPageSource((pageIndex) => {
			requests.push(`render-${pageIndex}`);
			return new Promise((resolve) => pending.push(resolve));
		});
		source.prefetchPage = vi.fn((pageIndex) => {
			requests.push(`prefetch-${pageIndex}`);
			return new Promise<void>((resolve) => {
				finishPrefetch = () => resolve();
			});
		});
		const queue = new PageRenderQueue(source);

		const activeThumbnail = queue.render(1, 0.3, "thumbnail");
		await vi.waitFor(() => expect(requests).toEqual(["render-1"]));
		const queuedPrefetch = queue.prefetchPage(3);
		const queuedThumbnail = queue.render(2, 0.3, "thumbnail");
		const visiblePage = queue.render(7, 1, "visible");
		pending[0]?.(pixelVisual());
		await activeThumbnail;
		await vi.waitFor(() => expect(requests).toEqual(["render-1", "render-7"]));
		pending[1]?.(pixelVisual());
		await visiblePage;
		await vi.waitFor(() => expect(requests).toEqual(["render-1", "render-7", "render-2"]));
		pending[2]?.(pixelVisual());
		await queuedThumbnail;
		await vi.waitFor(() =>
			expect(requests).toEqual(["render-1", "render-7", "render-2", "prefetch-3"]),
		);
		finishPrefetch();
		await queuedPrefetch;
		queue.dispose();
	});

	it("cancels queued prefetch work when navigation changes", async () => {
		const requests: number[] = [];
		const pending: Array<(visual: PageVisual) => void> = [];
		const source = createPageSource((pageIndex) => {
			requests.push(pageIndex);
			return new Promise((resolve) => pending.push(resolve));
		});
		const prefetchPage = vi.fn(async () => undefined);
		source.prefetchPage = prefetchPage;
		const queue = new PageRenderQueue(source);
		const active = queue.render(1, 1, "visible");
		await vi.waitFor(() => expect(requests).toEqual([1]));
		const queued = queue.prefetchPage(2);
		queue.cancelQueued("prefetch");
		await expect(queued).rejects.toMatchObject({ name: "AbortError" });
		pending[0]?.(pixelVisual());
		await active;
		expect(prefetchPage).not.toHaveBeenCalled();
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

	it("uses embedded thumbnails without rendering the whole page", async () => {
		const renderPage = vi.fn(async () => pixelVisual());
		const renderThumbnail = vi.fn(async () => pixelVisual());
		const source = createPageSource(renderPage);
		source.renderThumbnail = renderThumbnail;
		const queue = new PageRenderQueue(source);

		await queue.render(2, 0.3, "thumbnail");

		expect(renderThumbnail).toHaveBeenCalledWith(2);
		expect(renderPage).not.toHaveBeenCalled();
		queue.dispose();
	});

	it.each(["missing", "invalid"] as const)(
		"falls back to a reduced page render when the embedded thumbnail is %s",
		async (thumbnailResult) => {
			const renderPage = vi.fn(async () => pixelVisual());
			const renderThumbnail =
				thumbnailResult === "missing"
					? vi.fn(async () => null)
					: vi.fn(async () => {
							throw new Error("The embedded image could not be decoded.");
						});
			const source = createPageSource(renderPage);
			source.renderThumbnail = renderThumbnail;
			const queue = new PageRenderQueue(source);

			await queue.render(4, 0.3, "thumbnail");

			expect(renderThumbnail).toHaveBeenCalledWith(4);
			expect(renderPage).toHaveBeenCalledWith(4, 0.3);
			queue.dispose();
		},
	);

	it.each([
		new DOMException("cancelled", "AbortError"),
		new PageSourceUnavailableError("The PDF worker stopped."),
	])("does not hide abort or fatal thumbnail errors", async (error) => {
		const source = createPageSource(vi.fn(async () => pixelVisual()));
		source.renderThumbnail = vi.fn(async () => {
			throw error;
		});
		const queue = new PageRenderQueue(source);

		await expect(queue.render(4, 0.3, "thumbnail")).rejects.toBe(error);
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
