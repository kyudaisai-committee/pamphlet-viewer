import { describe, expect, it, vi } from "vitest";

import {
	PageSourceUnavailableError,
	type DocumentBackend,
	type PageSource,
	type PageVisual,
} from "../document/page-source";
import { ViewerController } from "./viewer-controller.svelte";

describe("ViewerController page-data prefetch", () => {
	it("starts after visible pages commit and ignores ordinary prefetch failures", async () => {
		const visibleRender = createDeferred<PageVisual>();
		const renderPage = vi.fn(() => visibleRender.promise);
		const prefetchIndexes: number[] = [];
		const prefetchStarted = createDeferred<void>();
		const source = createPageSource(5, renderPage, (pageIndex) => {
			prefetchIndexes.push(pageIndex);
			if (prefetchIndexes.length === 2) prefetchStarted.resolve(undefined);
			return Promise.reject(new Error("Temporary speculative range failure."));
		});
		const events: string[] = [];
		const controller = new ViewerController((event) => events.push(event.type));
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(renderPage).toHaveBeenCalledOnce());

		expect(prefetchIndexes).toEqual([]);
		expect(controller.renderRevision).toBe(0);
		visibleRender.resolve(pixelVisual());
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		await prefetchStarted.promise;
		await flushMicrotasks();

		expect(prefetchIndexes).toEqual([1, 2]);
		expect(controller.phase).toBe("ready");
		expect(controller.failure).toBeNull();
		expect(events).not.toContain("error");
		controller.dispose();
	});

	it("cancels obsolete page-data requests when navigation changes", async () => {
		const activePrefetch = createDeferred<void>();
		const prefetchIndexes: number[] = [];
		let activePrefetchStarted = false;
		const cancelPrefetch = vi.fn(() => {
			if (activePrefetchStarted) {
				activePrefetch.reject(new DOMException("cancelled", "AbortError"));
			}
		});
		const source = createPageSource(
			8,
			async () => pixelVisual(),
			(pageIndex) => {
				prefetchIndexes.push(pageIndex);
				if (pageIndex === 1) {
					activePrefetchStarted = true;
					return activePrefetch.promise;
				}
				return Promise.resolve();
			},
		);
		source.cancelPrefetchPageRequests = cancelPrefetch;
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(prefetchIndexes).toEqual([1, 2]));
		cancelPrefetch.mockClear();

		controller.requestRender(renderInput(2));
		expect(cancelPrefetch).toHaveBeenCalledOnce();
		activePrefetch.resolve(undefined);
		await vi.waitFor(() => expect(controller.renderRevision).toBe(2));
		await vi.waitFor(() => expect(prefetchIndexes).toEqual([1, 2, 0, 2, 3]));

		controller.dispose();
	});

	it("cancels active page-data work when render requests are invalidated", async () => {
		const activePrefetch = createDeferred<void>();
		const prefetchIndexes: number[] = [];
		let activePrefetchStarted = false;
		const cancelPrefetch = vi.fn(() => {
			if (activePrefetchStarted) {
				activePrefetch.reject(new DOMException("cancelled", "AbortError"));
			}
		});
		const source = createPageSource(
			5,
			async () => pixelVisual(),
			(pageIndex) => {
				prefetchIndexes.push(pageIndex);
				if (pageIndex === 1) {
					activePrefetchStarted = true;
					return activePrefetch.promise;
				}
				return Promise.resolve();
			},
		);
		source.cancelPrefetchPageRequests = cancelPrefetch;
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(prefetchIndexes).toEqual([1, 2]));
		cancelPrefetch.mockClear();

		controller.failInvalidOption();
		activePrefetch.resolve(undefined);
		await flushMicrotasks();

		expect(prefetchIndexes).toEqual([1, 2]);
		expect(cancelPrefetch).toHaveBeenCalledOnce();
		expect(controller.failure?.code).toBe("invalid-option");
		controller.dispose();
	});

	it("drops queued prefetch work when the document is replaced", async () => {
		const activePrefetch = createDeferred<void>();
		const oldPrefetchIndexes: number[] = [];
		const oldSource = createPageSource(
			5,
			async () => pixelVisual(),
			(pageIndex) => {
				oldPrefetchIndexes.push(pageIndex);
				return pageIndex === 1 ? activePrefetch.promise : Promise.resolve();
			},
		);
		const controller = new ViewerController(() => undefined);
		await controller.load("old.pdf", createBackend(oldSource));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(oldPrefetchIndexes).toEqual([1, 2]));

		await controller.load(
			"new.pdf",
			createBackend(createPageSource(1, async () => pixelVisual())),
		);
		activePrefetch.resolve(undefined);
		await flushMicrotasks();

		expect(oldPrefetchIndexes).toEqual([1, 2]);
		expect(controller.phase).toBe("ready");
		controller.dispose();
	});

	it("drops queued prefetch work when the controller is disposed", async () => {
		const activePrefetch = createDeferred<void>();
		const prefetchIndexes: number[] = [];
		const source = createPageSource(
			5,
			async () => pixelVisual(),
			(pageIndex) => {
				prefetchIndexes.push(pageIndex);
				return pageIndex === 1 ? activePrefetch.promise : Promise.resolve();
			},
		);
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(prefetchIndexes).toEqual([1, 2]));

		controller.dispose();
		activePrefetch.resolve(undefined);
		await flushMicrotasks();

		expect(prefetchIndexes).toEqual([1, 2]);
		expect(controller.phase).toBe("empty");
	});

	it("reopens the document when a prefetched page makes its source unavailable", async () => {
		const unavailablePrefetch = createDeferred<void>();
		const firstPrefetchIndexes: number[] = [];
		const firstSource = createPageSource(
			5,
			async () => pixelVisual(),
			(pageIndex) => {
				firstPrefetchIndexes.push(pageIndex);
				return pageIndex === 1 ? unavailablePrefetch.promise : Promise.resolve();
			},
		);
		const recoveredSource = createPageSource(5, async () => pixelVisual());
		let openCount = 0;
		const backend: DocumentBackend = {
			async open() {
				openCount += 1;
				return openCount === 1 ? firstSource : recoveredSource;
			},
		};
		const controller = new ViewerController(() => undefined);
		const input = renderInput(1);
		await controller.load("brochure.pdf", backend);
		controller.requestRender(input);
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		await vi.waitFor(() => expect(firstPrefetchIndexes).toEqual([1, 2]));

		unavailablePrefetch.reject(
			new PageSourceUnavailableError("The PDF source can no longer be read."),
		);
		await vi.waitFor(() => expect(controller.sourceUnavailable).toBe(true));
		expect(controller.failure?.retryable).toBe(true);
		controller.retryRender(input);
		await vi.waitFor(() => expect(controller.renderRevision).toBe(2));

		expect(openCount).toBe(2);
		expect(controller.phase).toBe("ready");
		expect(controller.sourceUnavailable).toBe(false);
		controller.dispose();
	});
});

function createBackend(pageSource: PageSource): DocumentBackend {
	return {
		async open() {
			return pageSource;
		},
	};
}

function createPageSource(
	pageCount: number,
	renderPage: (pageIndex: number, scale: number) => Promise<PageVisual>,
	prefetchPage: (pageIndex: number) => Promise<void> = async () => undefined,
): PageSource {
	return {
		pageCount,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		renderPage,
		async renderPrefetchedPage() {
			return pixelVisual();
		},
		prefetchPage,
		dispose() {},
	};
}

function renderInput(page: number) {
	return {
		page,
		layout: "single" as const,
		fit: "page" as const,
		zoom: 1,
		viewport: { width: 600, height: 800 },
	};
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
} {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
