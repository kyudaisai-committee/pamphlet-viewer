// SPDX-License-Identifier: MIT

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
		await controller.load("brochure.pdf", createBackend(createPageSource(2, () => pixelVisual())));

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

	it("renders a replacement document while the previous page-size request is pending", async () => {
		const oldPageSize = createDeferred<{ width: number; height: number }>();
		const oldGetPageSize = vi.fn(() => oldPageSize.promise);
		const oldSource: PageSource = {
			pageCount: 1,
			getPageSize: oldGetPageSize,
			async renderPage() {
				throw new Error("The stale page-size request must prevent this render.");
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
} {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function bitmapVisual(close: () => void): PageVisual {
	const bitmap = { close } as unknown as ImageBitmap;
	return { type: "bitmap", width: 1, height: 1, bitmap };
}
