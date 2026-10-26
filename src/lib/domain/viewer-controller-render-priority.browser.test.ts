import { expect, test, vi } from "vitest";

import type { PageSource, PageVisual } from "../document/page-source";
import { PdfiumBackend } from "../document/pdfium-backend";
import { ViewerController } from "./viewer-controller.svelte";

const FIXTURE_URL = new URL("/__render-priority-fixture.pdf", window.location.href).href;

interface FixtureMetrics {
	rangeRequests: number;
	delayRangeStarted: boolean;
	delayRangeFinished: boolean;
	delayRangeCancelled: boolean;
}

type SourceOverrides = Partial<
	Pick<
		PageSource,
		| "getPrefetchedPageSize"
		| "prefetchPage"
		| "cancelPrefetchPageRequests"
		| "renderPrefetchedPage"
	>
>;

test("starts the latest visible page while the previous render range is held", async () => {
	await configureDelay(0);
	const source = await openFixture();
	const controller = new ViewerController(() => undefined);
	let controllerOwnsSource = false;
	try {
		await warmSamePageOnBothWorkers(source, 0);
		const adapter = createSourceAdapter(source);
		await controller.load(FIXTURE_URL, createBackend(adapter));
		await configureDelay("hold");

		controller.requestRender(renderInput(24));
		await waitForDelayedRange();
		const latestRequestId = controller.requestRender(renderInput(13));
		if (latestRequestId === null) throw new Error("The latest page request was rejected.");
		controllerOwnsSource = true;

		await waitForRender(controller, 1, 3000);
		expect(controller.renderedRequestId).toBe(latestRequestId);
		expect(controller.pageVisuals[12]).toBeDefined();
		const metrics = await readMetrics();
		expect(metrics.rangeRequests).toBeGreaterThan(1);
		expect(metrics.delayRangeFinished).toBe(false);
	} finally {
		await releaseDelayedRange();
		controller.dispose();
		if (!controllerOwnsSource) await source.dispose();
	}
}, 30_000);

test("starts visible rendering while background page-size acquisition is delayed", async () => {
	await configureDelay(0);
	const source = await openFixture();
	const controller = new ViewerController(() => undefined);
	let controllerOwnsSource = false;
	try {
		await warmAdjacentPages(source);
		const backgroundPageSizeCalls: number[] = [];
		const getPrefetchedPageSize = source.getPrefetchedPageSize;
		if (getPrefetchedPageSize === undefined) {
			throw new Error("The background page-size API is unavailable.");
		}
		const adapter = createSourceAdapter(source, {
			getPrefetchedPageSize(pageIndex) {
				backgroundPageSizeCalls.push(pageIndex);
				return getPrefetchedPageSize.call(source, pageIndex);
			},
			async prefetchPage() {},
			cancelPrefetchPageRequests() {},
		});
		await controller.load(FIXTURE_URL, createBackend(adapter));
		await configureDelay("hold");

		controller.requestRender(renderInput(1));
		await waitForRender(controller, 1, 800);
		await waitForDelayedRange();
		expect(backgroundPageSizeCalls.length).toBeGreaterThan(0);
		const latestRequestId = controller.requestRender(renderInput(2));
		if (latestRequestId === null) throw new Error("The latest page request was rejected.");
		controllerOwnsSource = true;

		await waitForRender(controller, 2, 3000);
		expect(controller.renderedRequestId).toBe(latestRequestId);
		expect(controller.pageVisuals[1]).toBeDefined();
		expect((await readMetrics()).delayRangeFinished).toBe(false);
	} finally {
		await releaseDelayedRange();
		controller.dispose();
		if (!controllerOwnsSource) await source.dispose();
	}
}, 30_000);

test("starts visible rendering while adjacent page-data prefetch is delayed", async () => {
	await configureDelay(0);
	const source = await openFixture();
	const controller = new ViewerController(() => undefined);
	let controllerOwnsSource = false;
	const pendingPrerender = deferred<PageVisual>();
	try {
		await warmAdjacentPages(source, 11, 12);
		const adjacentPrefetchPages: number[] = [];
		const prefetchPage = source.prefetchPage;
		if (prefetchPage === undefined) throw new Error("Page-data prefetch is unavailable.");
		const adapter = createSourceAdapter(source, {
			prefetchPage(pageIndex) {
				adjacentPrefetchPages.push(pageIndex);
				return prefetchPage.call(source, pageIndex);
			},
			async getPrefetchedPageSize() {
				return { width: 300, height: 400 };
			},
			renderPrefetchedPage() {
				return pendingPrerender.promise;
			},
		});
		await controller.load(FIXTURE_URL, createBackend(adapter));
		await configureDelay("hold");

		controller.requestRender(renderInput(12));
		await waitForRender(controller, 1, 800);
		await waitForDelayedRange();
		expect(adjacentPrefetchPages).toContain(12);
		const latestRequestId = controller.requestRender(renderInput(13));
		if (latestRequestId === null) throw new Error("The latest page request was rejected.");
		controllerOwnsSource = true;

		await waitForRender(controller, 2, 3000);
		expect(controller.renderedRequestId).toBe(latestRequestId);
		expect(controller.pageVisuals[12]).toBeDefined();
		expect((await readMetrics()).delayRangeFinished).toBe(false);
	} finally {
		await releaseDelayedRange();
		controller.dispose();
		if (!controllerOwnsSource) await source.dispose();
		pendingPrerender.resolve(pixelVisual());
	}
}, 30_000);

test("reuses completed page-data prefetch through the same PDFium worker", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);
	const url = new URL("/__image-prefetch-range-fixture.pdf", window.location.href).href;
	const source = await new PdfiumBackend().open(url, new AbortController().signal);
	try {
		await source.getPageSize(23);
		const beforePrefetch = await readImagePrefetchMetrics();
		const prefetch = source.prefetchPage?.(23);
		if (prefetch === undefined) throw new Error("Page-data prefetch is unavailable.");
		await prefetch;
		const afterPrefetch = await readImagePrefetchMetrics();
		const visual = await source.renderPage(23, 1);
		const afterRender = await readImagePrefetchMetrics();

		expect(afterPrefetch.requestedBytes).toBeGreaterThan(beforePrefetch.requestedBytes);
		expect(afterRender.requestedBytes).toBe(afterPrefetch.requestedBytes);
		if (visual.type === "bitmap") visual.bitmap.close();
	} finally {
		await source.dispose();
	}
}, 30_000);

async function openFixture(): Promise<PageSource> {
	return new PdfiumBackend().open(FIXTURE_URL, new AbortController().signal);
}

async function warmSamePageOnBothWorkers(source: PageSource, pageIndex: number): Promise<void> {
	await Promise.all([source.getPageSize(pageIndex), source.getPageSize(pageIndex)]);
	const visuals = await Promise.all([
		source.renderPage(pageIndex, 1),
		source.renderPage(pageIndex, 1),
	]);
	for (const visual of visuals) {
		if (visual.type === "bitmap") visual.bitmap.close();
	}
}

async function warmAdjacentPages(
	source: PageSource,
	firstPageIndex = 0,
	secondPageIndex = 1,
): Promise<void> {
	await Promise.all([source.getPageSize(firstPageIndex), source.getPageSize(secondPageIndex)]);
	const visuals = await Promise.all([
		source.renderPage(firstPageIndex, 1),
		source.renderPage(secondPageIndex, 1),
	]);
	for (const visual of visuals) {
		if (visual.type === "bitmap") visual.bitmap.close();
	}
}

function createSourceAdapter(source: PageSource, overrides: SourceOverrides = {}): PageSource {
	const getPrefetchedPageSize = overrides.getPrefetchedPageSize ?? source.getPrefetchedPageSize;
	const prefetchPage = overrides.prefetchPage ?? source.prefetchPage;
	const cancelPrefetchPageRequests =
		overrides.cancelPrefetchPageRequests ?? source.cancelPrefetchPageRequests;
	const renderPrefetchedPage = overrides.renderPrefetchedPage ?? source.renderPrefetchedPage;
	const adapter: PageSource = {
		pageCount: source.pageCount,
		getPageSize(pageIndex) {
			return source.getPageSize(pageIndex);
		},
		cancelForegroundRequests() {
			source.cancelForegroundRequests?.();
		},
		renderPage(pageIndex, scale) {
			return source.renderPage(pageIndex, scale);
		},
		renderPrefetchedPage(pageIndex, scale) {
			return renderPrefetchedPage.call(source, pageIndex, scale);
		},
		dispose() {
			return source.dispose();
		},
	};
	if (getPrefetchedPageSize !== undefined) {
		adapter.getPrefetchedPageSize = (pageIndex) =>
			getPrefetchedPageSize.call(source, pageIndex);
	}
	if (prefetchPage !== undefined) {
		adapter.prefetchPage = (pageIndex) => prefetchPage.call(source, pageIndex);
	}
	if (cancelPrefetchPageRequests !== undefined) {
		adapter.cancelPrefetchPageRequests = () => cancelPrefetchPageRequests.call(source);
	}
	return adapter;
}

function createBackend(source: PageSource) {
	return {
		async open() {
			return source;
		},
	};
}

function renderInput(page: number) {
	return {
		page,
		layout: "single" as const,
		fit: "page" as const,
		zoom: 1,
		viewport: { width: 300, height: 400 },
	};
}

async function configureDelay(delay: number | "hold"): Promise<void> {
	const control = typeof delay === "number" ? `delayNextRangeMs=${delay}` : "holdNextRange=true";
	const response = await fetch(`/__render-priority-control?${control}`);
	expect(response.ok).toBe(true);
}

async function releaseDelayedRange(): Promise<void> {
	const response = await fetch("/__render-priority-control?releaseDelayedRange=true");
	expect(response.ok).toBe(true);
}

async function readMetrics(): Promise<FixtureMetrics> {
	const response = await fetch("/__render-priority-metrics");
	expect(response.ok).toBe(true);
	return (await response.json()) as FixtureMetrics;
}

async function readImagePrefetchMetrics(): Promise<{ requestedBytes: number }> {
	const response = await fetch("/__image-prefetch-range-metrics");
	expect(response.ok).toBe(true);
	return (await response.json()) as { requestedBytes: number };
}

async function waitForDelayedRange(): Promise<void> {
	await vi.waitFor(
		async () => {
			expect((await readMetrics()).delayRangeStarted).toBe(true);
		},
		{ timeout: 10_000, interval: 20 },
	);
}

async function waitForRender(
	controller: ViewerController,
	revision: number,
	timeout: number,
): Promise<void> {
	await vi.waitFor(() => expect(controller.renderRevision).toBe(revision), {
		timeout,
		interval: 20,
	});
}

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
