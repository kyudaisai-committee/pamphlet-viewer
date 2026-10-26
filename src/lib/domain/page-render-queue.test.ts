import { describe, expect, it, vi } from "vitest";

import {
	PageSourceUnavailableError,
	type PageSource,
	type PageVisual,
} from "@/lib/document/page-source";
import { calculateThumbnailScale } from "@/lib/document/thumbnail-scale";

import { PageRenderQueue } from "./page-render-queue";

describe("PageRenderQueue", () => {
	it("renders visible spread pages concurrently", async () => {
		const requests: number[] = [];
		const pending: Array<(visual: PageVisual) => void> = [];
		const source = createPageSource((pageIndex) => {
			requests.push(pageIndex);
			return new Promise((resolve) => pending.push(resolve));
		});
		const queue = new PageRenderQueue(source);
		const first = queue.render(1, 1, "visible");
		const second = queue.render(2, 1, "visible");

		await vi.waitFor(() => expect(requests).toEqual([1, 2]));
		pending[1]?.(pixelVisual());
		await second;
		pending[0]?.(pixelVisual());
		await first;
		queue.dispose();
	});

	it("keeps visible renders independent from a running data prefetch", async () => {
		let finishPrefetch: () => void = () => undefined;
		const renderCalls: number[] = [];
		const pendingRenders: Array<(visual: PageVisual) => void> = [];
		const source = createPageSource((pageIndex) => {
			renderCalls.push(pageIndex);
			return new Promise((resolve) => pendingRenders.push(resolve));
		});
		source.prefetchPage = () =>
			new Promise<void>((resolve) => {
				finishPrefetch = resolve;
			});
		const queue = new PageRenderQueue(source);
		const prefetch = queue.prefetchPage(5);
		await vi.waitFor(() => expect(finishPrefetch).toBeTypeOf("function"));

		const first = queue.render(6, 1, "visible");
		const second = queue.render(7, 1, "visible");
		await vi.waitFor(() => expect(renderCalls).toEqual([6, 7]));
		pendingRenders[0]?.(pixelVisual());
		pendingRenders[1]?.(pixelVisual());
		await Promise.all([first, second]);
		expect(finishPrefetch).toBeTypeOf("function");
		finishPrefetch();
		await prefetch;
		queue.dispose();
	});

	it("dispatches queued data prefetches so the source scheduler can order them", async () => {
		const prefetchRequests: number[] = [];
		const finishPrefetch: Array<() => void> = [];
		const source = createPageSource(async () => pixelVisual());
		source.prefetchPage = vi.fn((pageIndex) => {
			prefetchRequests.push(pageIndex);
			return new Promise<void>((resolve) => finishPrefetch.push(resolve));
		});
		const queue = new PageRenderQueue(source);

		const first = queue.prefetchPage(5);
		const second = queue.prefetchPage(6);
		await vi.waitFor(() => expect(prefetchRequests).toEqual([5, 6]));

		for (const finish of finishPrefetch) finish();
		await Promise.all([first, second]);
		queue.dispose();
	});

	it("dispatches data work while prioritizing visible pages over queued thumbnails", async () => {
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

		const firstThumbnail = queue.render(1, 0.3, "thumbnail");
		const secondThumbnail = queue.render(4, 0.3, "thumbnail");
		await vi.waitFor(() => expect(requests).toEqual(["render-1", "render-4"]));
		const queuedPrefetch = queue.prefetchPage(3);
		const queuedThumbnail = queue.render(2, 0.3, "thumbnail");
		const visiblePage = queue.render(7, 1, "visible");
		expect(requests).toEqual(["render-1", "render-4", "prefetch-3"]);
		pending[0]?.(pixelVisual());
		await firstThumbnail;
		await vi.waitFor(() => expect(requests).toContain("render-7"));
		expect(requests).toEqual(["render-1", "render-4", "prefetch-3", "render-7"]);
		pending[2]?.(pixelVisual());
		await visiblePage;
		pending[1]?.(pixelVisual());
		await secondThumbnail;
		await vi.waitFor(() => expect(requests).toContain("render-2"));
		pending[3]?.(pixelVisual());
		await queuedThumbnail;
		await vi.waitFor(() =>
			expect(requests).toEqual([
				"render-1",
				"render-4",
				"prefetch-3",
				"render-7",
				"render-2",
			]),
		);
		finishPrefetch();
		await queuedPrefetch;
		queue.dispose();
	});

	it("cancels a running prefetch request when navigation changes", async () => {
		const requests: number[] = [];
		const pending: Array<(visual: PageVisual) => void> = [];
		let rejectPrefetch: (error: Error) => void = () => undefined;
		const source = createPageSource((pageIndex) => {
			requests.push(pageIndex);
			return new Promise((resolve) => pending.push(resolve));
		});
		const prefetchPage = vi.fn(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectPrefetch = reject;
				}),
		);
		source.prefetchPage = prefetchPage;
		source.cancelPrefetchPageRequests = vi.fn(() =>
			rejectPrefetch(new DOMException("cancelled", "AbortError")),
		);
		const queue = new PageRenderQueue(source);
		const active = queue.render(1, 1, "visible");
		await vi.waitFor(() => expect(requests).toEqual([1]));
		const queued = queue.prefetchPage(2);
		queue.cancelQueued("prefetch");
		await expect(queued).rejects.toMatchObject({ name: "AbortError" });
		pending[0]?.(pixelVisual());
		await active;
		expect(prefetchPage).toHaveBeenCalledOnce();
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
		const firstActive = queue.render(1, 0.3, "thumbnail");
		const secondActive = queue.render(4, 0.3, "thumbnail");
		await vi.waitFor(() => expect(requests).toEqual([1, 4]));
		const cancelled = queue.render(2, 0.3, "thumbnail");
		const visible = queue.render(3, 1, "visible");
		queue.cancelQueued("thumbnail");
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		pending[0]?.(pixelVisual());
		await firstActive;
		await vi.waitFor(() => expect(requests).toContain(3));
		pending[2]?.(pixelVisual());
		await visible;
		pending[1]?.(pixelVisual());
		await secondActive;
		expect(requests).toEqual([1, 4, 3]);
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
			expect(renderPage).toHaveBeenCalledWith(4, calculateThumbnailScale(300, 400));
			queue.dispose();
		},
	);

	it("propagates source-owned thumbnail errors without falling back to body rendering", async () => {
		const failure = new Error("The thumbnail worker could not decode this page.");
		const getPageSize = vi.fn(async () => ({ width: 300, height: 400 }));
		const renderPage = vi.fn(async () => pixelVisual());
		const renderThumbnail = vi.fn(async () => {
			throw failure;
		});
		const source: PageSource = {
			...createPageSource(renderPage),
			getPageSize,
			renderThumbnail,
			propagateThumbnailErrors: true,
		};
		const queue = new PageRenderQueue(source);

		await expect(queue.render(4, 0.3, "thumbnail")).rejects.toBe(failure);

		expect(renderThumbnail).toHaveBeenCalledWith(4);
		expect(getPageSize).not.toHaveBeenCalled();
		expect(renderPage).not.toHaveBeenCalled();
		queue.dispose();
	});

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
		async renderPrefetchedPage() {
			return pixelVisual();
		},
		renderPage,
		dispose() {},
	};
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}
