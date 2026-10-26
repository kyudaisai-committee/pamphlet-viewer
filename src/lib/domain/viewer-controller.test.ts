import { describe, expect, it, vi } from "vitest";

import {
	PageSourceUnavailableError,
	type DocumentBackend,
	type PageSource,
	type PageVisual,
} from "../document/page-source";
import { ViewerController } from "./viewer-controller.svelte";

describe("ViewerController", () => {
	it("emits one error for repeated requests with the same invalid page", async () => {
		const events: string[] = [];
		const controller = new ViewerController((event) => events.push(event.type));
		await controller.load(
			"brochure.pdf",
			createBackend(createPageSource(2, () => pixelVisual())),
		);

		const input = {
			page: 3,
			layout: "single" as const,
			fit: "page" as const,
			zoom: 1,
			viewport: { width: 600, height: 800 },
		};
		controller.requestRender(input);
		controller.requestRender(input);

		expect(events.filter((event) => event === "error")).toHaveLength(1);
		expect(controller.failure?.code).toBe("invalid-page");
		controller.dispose();
	});

	it("releases previous bitmap visuals when pages change and on disposal", async () => {
		const closeCalls: ReturnType<typeof vi.fn>[] = [];
		const controller = new ViewerController(() => undefined);
		const source = createPageSource(2, () => {
			const close = vi.fn();
			closeCalls.push(close);
			return bitmapVisual(close);
		});
		await controller.load("brochure.pdf", createBackend(source));

		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(Object.keys(controller.pageVisuals)).toHaveLength(1));

		controller.requestRender(renderInput(2));
		await vi.waitFor(() => expect(closeCalls[0]?.mock.calls).toHaveLength(1));
		await vi.waitFor(() => expect(controller.pageVisuals[1]).toBeDefined());

		controller.dispose();
		expect(closeCalls[1]?.mock.calls).toHaveLength(1);
	});

	it("starts the newest render while an earlier page-size request is pending", async () => {
		const stalePageSize = createDeferred<{ width: number; height: number }>();
		const getPageSize = vi.fn((pageIndex: number) =>
			pageIndex === 0 ? stalePageSize.promise : Promise.resolve({ width: 300, height: 400 }),
		);
		const latestVisual = pixelVisual();
		const renderPage = vi.fn(async (pageIndex: number) => {
			if (pageIndex !== 1) throw new Error("The stale page must not be rendered.");
			return latestVisual;
		});
		const source: PageSource = {
			...createPageSource(2, pixelVisual),
			getPageSize,
			renderPage,
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		const input = { ...renderInput(1), viewport: { width: 300, height: 400 } };
		controller.requestRender(input);
		await vi.waitFor(() => expect(getPageSize).toHaveBeenCalledWith(0));

		controller.requestRender({ ...input, page: 2 });
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		expect(renderPage).toHaveBeenCalledWith(1, 1);
		expect(controller.pageVisuals[1]).toBe(latestVisual);

		stalePageSize.resolve({ width: 300, height: 400 });
		await flushTasks();
		expect(controller.renderRevision).toBe(1);
		expect(renderPage).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("keeps logical zoom size while rendering within the page pixel budget", async () => {
		let renderedScale = 0;
		const source: PageSource = {
			pageCount: 1,
			async getPageSize() {
				return { width: 1200, height: 1800 };
			},
			async renderPage(_pageIndex, scale) {
				renderedScale = scale;
				return pixelVisual();
			},
			async renderPrefetchedPage() {
				return pixelVisual();
			},
			dispose() {},
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender({
			page: 1,
			layout: "single",
			fit: "page",
			zoom: 8,
			viewport: { width: 1200, height: 1800 },
		});
		await vi.waitFor(() => expect(controller.pageRenderPlans[0]).toBeDefined());

		const plan = controller.pageRenderPlans[0];
		if (plan === undefined) throw new Error("The page render plan was not stored.");
		expect(plan.displayScale).toBe(8);
		expect(plan.displayWidth).toBe(9600);
		expect(plan.rasterScale).toBe(renderedScale);
		expect(plan.rasterWidth * plan.rasterHeight).toBeLessThanOrEqual(8 * 1024 * 1024);
		controller.dispose();
	});

	it("renders at the device pixel ratio while preserving the CSS page size", async () => {
		let renderedScale = 0;
		const source: PageSource = {
			pageCount: 1,
			async getPageSize() {
				return { width: 300, height: 400 };
			},
			async renderPage(_pageIndex, scale) {
				renderedScale = scale;
				return pixelVisual();
			},
			async renderPrefetchedPage() {
				return pixelVisual();
			},
			dispose() {},
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender({
			...renderInput(1),
			devicePixelRatio: 2,
			viewport: { width: 300, height: 400 },
		});
		await vi.waitFor(() => expect(controller.pageRenderPlans[0]?.rasterScale).toBe(2));

		const plan = controller.pageRenderPlans[0];
		if (plan === undefined) throw new Error("The page render plan was not stored.");
		expect(plan.displayWidth).toBe(300);
		expect(plan.displayHeight).toBe(400);
		expect(renderedScale).toBe(2);
		controller.dispose();
	});

	it("reuses an adjacent prerendered page when the target scale matches", async () => {
		const prefetchedVisual = pixelVisual();
		const renderPage = vi.fn(async () => pixelVisual());
		const renderPrefetchedPage = vi.fn(async () => prefetchedVisual);
		const source: PageSource = {
			...createPageSource(3, pixelVisual),
			renderPage,
			renderPrefetchedPage,
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		const input = { ...renderInput(1), viewport: { width: 300, height: 400 } };
		controller.requestRender(input);
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		await vi.waitFor(() =>
			expect(renderPrefetchedPage).toHaveBeenCalledWith(1, 1, expect.any(AbortSignal)),
		);
		await flushTasks();

		controller.requestRender({ ...input, page: 2 });
		await vi.waitFor(() => expect(controller.renderRevision).toBe(2));
		expect(controller.pageVisuals[1]).toBe(prefetchedVisual);
		expect(renderPage).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it("renders again and releases an adjacent image when the scale changes", async () => {
		const closePrefetched = vi.fn();
		const prefetchedVisual = bitmapVisual(closePrefetched);
		const renderedScales: number[] = [];
		const renderPage = vi.fn(async (_pageIndex: number, scale: number) => {
			renderedScales.push(scale);
			return pixelVisual();
		});
		const renderPrefetchedPage = vi.fn(async () => prefetchedVisual);
		const source: PageSource = {
			...createPageSource(3, pixelVisual),
			renderPage,
			renderPrefetchedPage,
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		const input = { ...renderInput(1), viewport: { width: 300, height: 400 } };
		controller.requestRender(input);
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		await vi.waitFor(() => expect(renderPrefetchedPage).toHaveBeenCalledOnce());
		await flushTasks();

		controller.requestRender({ ...input, page: 2, zoom: 2 });
		await vi.waitFor(() => expect(controller.renderRevision).toBe(2));
		expect(controller.pageVisuals[1]).not.toBe(prefetchedVisual);
		expect(renderedScales).toContain(2);
		await vi.waitFor(() => expect(closePrefetched).toHaveBeenCalledOnce());
		controller.dispose();
	});

	it("renders a visible page without waiting for an in-flight adjacent prerender", async () => {
		const unrelatedRender = createDeferred<PageVisual>();
		const unrelatedStarted = createDeferred<void>();
		const visibleRender = createDeferred<PageVisual>();
		const visibleStarted = createDeferred<void>();
		const closeUnrelated = vi.fn();
		const renderPage = vi.fn(async () => pixelVisual());
		const renderPrefetchedPage = vi.fn((pageIndex: number) => {
			if (pageIndex === 0) {
				unrelatedStarted.resolve();
				return unrelatedRender.promise;
			}
			visibleStarted.resolve();
			return visibleRender.promise;
		});
		const source: PageSource = {
			...createPageSource(4, pixelVisual),
			renderPage,
			renderPrefetchedPage,
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender(renderInput(2));
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		await Promise.all([unrelatedStarted.promise, visibleStarted.promise]);

		controller.requestRender(renderInput(3));
		await vi.waitFor(() => expect(controller.renderRevision).toBe(2));
		expect(renderPage).toHaveBeenCalledTimes(2);
		expect(controller.pageVisuals[2]).toBeDefined();

		visibleRender.resolve(pixelVisual());
		await vi.waitFor(() => expect(renderPrefetchedPage.mock.calls).toHaveLength(4));
		expect(renderPrefetchedPage.mock.calls.map(([pageIndex]) => pageIndex)).toEqual([
			0, 2, 1, 3,
		]);

		controller.dispose();
		unrelatedRender.resolve(bitmapVisual(closeUnrelated));
		await vi.waitFor(() => expect(closeUnrelated).toHaveBeenCalledOnce());
	});

	it("retains a prerender that finishes while navigation is still measuring the target page", async () => {
		const navigationPageSize = createDeferred<{ width: number; height: number }>();
		const backgroundRender = createDeferred<PageVisual>();
		const backgroundStarted = createDeferred<void>();
		let backgroundHasStarted = false;
		const getPageSize = vi.fn((pageIndex: number) => {
			if (pageIndex === 1 && backgroundHasStarted) return navigationPageSize.promise;
			return Promise.resolve({ width: 300, height: 400 });
		});
		const prefetchedVisual = pixelVisual();
		const renderPage = vi.fn(async () => pixelVisual());
		const renderPrefetchedPage = vi.fn((pageIndex: number) => {
			if (pageIndex !== 1) return Promise.resolve(pixelVisual());
			backgroundHasStarted = true;
			backgroundStarted.resolve();
			return backgroundRender.promise;
		});
		const source: PageSource = {
			...createPageSource(2, pixelVisual),
			getPageSize,
			renderPage,
			renderPrefetchedPage,
		};
		const controller = new ViewerController(() => undefined);
		const input = { ...renderInput(1), viewport: { width: 300, height: 400 } };
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender(input);
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		await backgroundStarted.promise;

		controller.requestRender({ ...input, page: 2 });
		await vi.waitFor(() =>
			expect(getPageSize.mock.calls.filter(([pageIndex]) => pageIndex === 1)).toHaveLength(2),
		);
		backgroundRender.resolve(prefetchedVisual);
		await flushTasks();
		expect(controller.renderRevision).toBe(1);

		navigationPageSize.resolve({ width: 300, height: 400 });
		await vi.waitFor(() => expect(controller.renderRevision).toBe(2));
		expect(controller.pageVisuals[1]).toBe(prefetchedVisual);
		expect(renderPage).toHaveBeenCalledOnce();
		expect(renderPrefetchedPage.mock.calls.map(([pageIndex]) => pageIndex)).toEqual([1, 0]);
		controller.dispose();
	});

	it("retries a claimed background failure with the foreground renderer", async () => {
		const failedPrerender = createDeferred<PageVisual>();
		const started = createDeferred<void>();
		const fallbackVisual = pixelVisual();
		const renderPage = vi.fn(async () => fallbackVisual);
		const renderPrefetchedPage = vi.fn(() => {
			started.resolve();
			return failedPrerender.promise;
		});
		const source: PageSource = {
			...createPageSource(2, pixelVisual),
			renderPage,
			renderPrefetchedPage,
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		const input = { ...renderInput(1), viewport: { width: 300, height: 400 } };
		controller.requestRender(input);
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		await started.promise;
		controller.requestRender({ ...input, page: 2 });
		failedPrerender.reject(new Error("The prerender worker failed."));
		await vi.waitFor(() => expect(controller.renderRevision).toBe(2));

		expect(renderPage).toHaveBeenCalledTimes(2);
		expect(controller.pageVisuals[1]).toBe(fallbackVisual);
		expect(controller.phase).toBe("ready");
		controller.dispose();
	});

	it("renders a replacement document while the previous page-size request is pending", async () => {
		const oldPageSize = createDeferred<{ width: number; height: number }>();
		const oldGetPageSize = vi.fn(() => oldPageSize.promise);
		const oldSource: PageSource = {
			pageCount: 1,
			getPageSize: oldGetPageSize,
			async renderPage() {
				throw new Error("The stale page-size request must prevent this render.");
			},
			async renderPrefetchedPage() {
				return pixelVisual();
			},
			dispose() {},
		};
		const newVisual = pixelVisual();
		const newRenderPage = vi.fn(async () => newVisual);
		const newSource: PageSource = {
			pageCount: 1,
			async getPageSize() {
				return { width: 300, height: 400 };
			},
			renderPage: newRenderPage,
			async renderPrefetchedPage() {
				return pixelVisual();
			},
			dispose() {},
		};
		const events: string[] = [];
		const controller = new ViewerController((event) => events.push(event.type));
		await controller.load("old.pdf", createBackend(oldSource));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(oldGetPageSize).toHaveBeenCalledOnce());

		await controller.load("new.pdf", createBackend(newSource));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(newRenderPage).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(controller.pageVisuals[0]).toBe(newVisual));

		oldPageSize.resolve({ width: 300, height: 400 });
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		expect(controller.pageVisuals[0]).toBe(newVisual);
		expect(events.filter((event) => event === "pagechange")).toHaveLength(1);
		controller.dispose();
	});

	it("releases a late bitmap from a stale render without replacing the new document", async () => {
		const oldRender = createDeferred<PageVisual>();
		const oldRenderPage = vi.fn(() => oldRender.promise);
		const oldSource: PageSource = {
			pageCount: 1,
			async getPageSize() {
				return { width: 300, height: 400 };
			},
			renderPage: oldRenderPage,
			async renderPrefetchedPage() {
				return pixelVisual();
			},
			dispose() {},
		};
		const closeStaleBitmap = vi.fn();
		const staleVisual = bitmapVisual(closeStaleBitmap);
		const newVisual = pixelVisual();
		const newSource: PageSource = {
			pageCount: 1,
			async getPageSize() {
				return { width: 300, height: 400 };
			},
			async renderPage() {
				return newVisual;
			},
			async renderPrefetchedPage() {
				return pixelVisual();
			},
			dispose() {},
		};
		const events: string[] = [];
		const controller = new ViewerController((event) => events.push(event.type));
		await controller.load("old.pdf", createBackend(oldSource));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(oldRenderPage).toHaveBeenCalledOnce());

		await controller.load("new.pdf", createBackend(newSource));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(controller.pageVisuals[0]).toBe(newVisual));
		oldRender.resolve(staleVisual);
		await vi.waitFor(() => expect(closeStaleBitmap).toHaveBeenCalledOnce());

		expect(controller.pageVisuals[0]).toBe(newVisual);
		expect(events.filter((event) => event === "pagechange")).toHaveLength(1);
		controller.dispose();
	});

	it("reports asynchronous disposal failures without failing the replacement document", async () => {
		const cleanupError = new Error("document cleanup failed");
		const cleanupErrors: unknown[] = [];
		const events: string[] = [];
		const controller = new ViewerController(
			(event) => events.push(event.type),
			(error) => cleanupErrors.push(error),
		);
		const oldSource = createPageSource(1, pixelVisual);
		oldSource.dispose = () => Promise.reject(cleanupError);
		await controller.load("old.pdf", createBackend(oldSource));
		await controller.load("new.pdf", createBackend(createPageSource(1, pixelVisual)));
		await vi.waitFor(() => expect(cleanupErrors).toEqual([cleanupError]));

		expect(controller.phase).toBe("ready");
		expect(events.filter((event) => event === "error")).toHaveLength(0);
		controller.dispose();
	});

	it("reports disposal failure from a stale backend open result", async () => {
		const cleanupError = new Error("stale source cleanup failed");
		const cleanupErrors: unknown[] = [];
		const controller = new ViewerController(
			() => undefined,
			(error) => cleanupErrors.push(error),
		);
		const staleOpen = createDeferred<PageSource>();
		const firstLoad = controller.load("stale.pdf", {
			async open() {
				return staleOpen.promise;
			},
		});
		await controller.load("current.pdf", createBackend(createPageSource(1, pixelVisual)));
		const staleSource = createPageSource(1, pixelVisual);
		staleSource.dispose = () => Promise.reject(cleanupError);
		staleOpen.resolve(staleSource);
		await firstLoad;
		await vi.waitFor(() => expect(cleanupErrors).toEqual([cleanupError]));
		expect(controller.phase).toBe("ready");
		controller.dispose();
	});

	it("advances an internal render revision without changing pagechange semantics", async () => {
		const pageChanges: number[] = [];
		const controller = new ViewerController((event) => {
			if (event.type === "pagechange") pageChanges.push(event.detail.page);
		});
		await controller.load("brochure.pdf", createBackend(createPageSource(1, pixelVisual)));
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
		controller.requestRender({ ...renderInput(1), zoom: 1.5 });
		await vi.waitFor(() => expect(controller.renderRevision).toBe(2));
		expect(pageChanges).toEqual([1]);
		controller.dispose();
	});

	it("reopens an unavailable source and preserves the render input on retry", async () => {
		const disposeUnavailableSource = vi.fn();
		const unavailableRender = vi.fn(() => {
			throw new PageSourceUnavailableError("The PDF worker cannot be reused.");
		});
		const unavailableSource = createPageSource(2, unavailableRender);
		unavailableSource.dispose = disposeUnavailableSource;
		const recoveredRender = vi.fn(async () => pixelVisual());
		const recoveredSource: PageSource = {
			pageCount: 2,
			async getPageSize() {
				return { width: 300, height: 400 };
			},
			renderPage: recoveredRender,
			async renderPrefetchedPage() {
				return pixelVisual();
			},
			dispose() {},
		};
		let openCount = 0;
		const backend: DocumentBackend = {
			async open() {
				openCount += 1;
				return openCount === 1 ? unavailableSource : recoveredSource;
			},
		};
		const controller = new ViewerController(() => undefined);
		const input = {
			page: 2,
			layout: "single" as const,
			fit: "page" as const,
			zoom: 1.5,
			viewport: { width: 600, height: 800 },
			devicePixelRatio: 2,
		};

		await controller.load("brochure.pdf", backend);
		controller.requestRender(input);
		await vi.waitFor(() => expect(controller.failure?.code).toBe("render-failed"));
		controller.requestRender({ ...input, zoom: 2 });
		expect(controller.phase).toBe("error");
		expect(controller.sourceUnavailable).toBe(true);
		expect(unavailableRender).toHaveBeenCalledOnce();
		controller.retryRender(input);
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));

		expect(openCount).toBe(2);
		expect(disposeUnavailableSource).toHaveBeenCalledOnce();
		expect(recoveredRender).toHaveBeenCalledOnce();
		expect(recoveredRender).toHaveBeenCalledWith(1, 6);
		expect(controller.pageRenderPlans[1]?.displayScale).toBe(3);
		controller.dispose();
	});

	it("reuses the current source when retrying a transient render failure", async () => {
		let renderCount = 0;
		let openCount = 0;
		const source: PageSource = {
			pageCount: 1,
			async getPageSize() {
				return { width: 300, height: 400 };
			},
			async renderPage() {
				renderCount += 1;
				if (renderCount === 1) throw new Error("Temporary render failure.");
				return pixelVisual();
			},
			async renderPrefetchedPage() {
				return pixelVisual();
			},
			dispose() {},
		};
		const backend: DocumentBackend = {
			async open() {
				openCount += 1;
				return source;
			},
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", backend);
		controller.requestRender(renderInput(1));
		await vi.waitFor(() => expect(controller.failure?.code).toBe("render-failed"));
		controller.retryRender(renderInput(1));
		await vi.waitFor(() => expect(controller.renderRevision).toBe(1));

		expect(openCount).toBe(1);
		expect(renderCount).toBe(2);
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

function createPageSource(pageCount: number, renderVisual: () => PageVisual): PageSource {
	return {
		pageCount,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		async renderPage() {
			return renderVisual();
		},
		async renderPrefetchedPage() {
			return renderVisual();
		},
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

function bitmapVisual(close: () => void): PageVisual {
	const bitmap = { close } as unknown as ImageBitmap;
	return { type: "bitmap", width: 1, height: 1, bitmap };
}

async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
