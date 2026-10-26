import { expect, it, vi } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";

import { ViewerController } from "./viewer-controller.svelte";

it("starts both adjacent spreads before waiting for either first page", async () => {
	const previousFirstPage = deferred<PageVisual>();
	const nextFirstPage = deferred<PageVisual>();
	const startedPageIndexes: number[] = [];
	const source: PageSource = {
		pageCount: 10,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		async renderPage() {
			return pixelVisual();
		},
		renderPrefetchedPage(pageIndex) {
			startedPageIndexes.push(pageIndex);
			if (pageIndex === 1) return previousFirstPage.promise;
			if (pageIndex === 5) return nextFirstPage.promise;
			return Promise.resolve(pixelVisual());
		},
		dispose() {},
	};
	const backend: DocumentBackend = {
		async open() {
			return source;
		},
	};
	const controller = new ViewerController(() => undefined);
	await controller.load("brochure.pdf", backend);
	controller.requestRender({
		page: 4,
		layout: "spread",
		fit: "page",
		zoom: 1,
		viewport: { width: 1000, height: 800 },
	});
	await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
	await vi.waitFor(() => expect(startedPageIndexes).toEqual([1, 5]));

	nextFirstPage.resolve(pixelVisual());
	await vi.waitFor(() => expect(startedPageIndexes).toEqual([1, 5, 2, 6]));
	previousFirstPage.resolve(pixelVisual());
	controller.dispose();
});

it("shares an in-flight prerender with the visible request for that page", async () => {
	const visibleVisual = pixelVisual();
	const backgroundVisual = pixelVisual();
	const backgroundRender = deferred<PageVisual>();
	const backgroundStarted = deferred<void>();
	const renderPage = vi.fn(async () => visibleVisual);
	const renderPrefetchedPage = vi.fn((pageIndex: number) => {
		if (pageIndex !== 1) return Promise.resolve(pixelVisual());
		backgroundStarted.resolve();
		return backgroundRender.promise;
	});
	const promotePageRender = vi.fn(() => true);
	const source: PageSource = {
		pageCount: 3,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		renderPage,
		renderPrefetchedPage,
		promotePageRender,
		dispose() {},
	};
	const backend: DocumentBackend = {
		async open() {
			return source;
		},
	};
	const controller = new ViewerController(() => undefined);
	const input = {
		page: 1,
		layout: "single" as const,
		fit: "page" as const,
		zoom: 1,
		viewport: { width: 300, height: 400 },
	};
	await controller.load("brochure.pdf", backend);
	controller.requestRender(input);
	await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
	await backgroundStarted.promise;

	controller.requestRender({ ...input, page: 2 });
	await vi.waitFor(() => expect(promotePageRender).toHaveBeenCalledOnce());
	expect(renderPage).toHaveBeenCalledOnce();
	expect(controller.renderRevision).toBe(1);

	backgroundRender.resolve(backgroundVisual);
	await vi.waitFor(() => expect(controller.renderRevision).toBe(2));
	expect(controller.pageVisuals[1]).toBe(backgroundVisual);
	expect(renderPrefetchedPage.mock.calls.filter(([pageIndex]) => pageIndex === 1)).toHaveLength(
		1,
	);
	expect(renderPage).toHaveBeenCalledOnce();
	controller.dispose();
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}
