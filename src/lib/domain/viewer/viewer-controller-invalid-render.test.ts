import { describe, expect, test, vi } from "vitest";

import type { PageSource, PageVisual } from "@/lib/document/page-source";

import { ViewerController } from "./viewer-controller.svelte";

const invalidRenderScenarios: Array<{
	invalidState: "invalid-page" | "invalid-option";
	lateResult: "success" | "failure";
}> = [
	{ invalidState: "invalid-page", lateResult: "success" },
	{ invalidState: "invalid-page", lateResult: "failure" },
	{ invalidState: "invalid-option", lateResult: "success" },
	{ invalidState: "invalid-option", lateResult: "failure" },
];

describe("ViewerController invalid render requests", () => {
	test.each(invalidRenderScenarios)(
		"keeps $invalidState after a late $lateResult and renders the corrected input",
		async ({ invalidState, lateResult }) => {
			const staleRender = createDeferred<PageVisual>();
			const closeStaleBitmap = vi.fn();
			const staleVisual = bitmapVisual(closeStaleBitmap);
			const renderPage = vi
				.fn<(...args: Parameters<PageSource["renderPage"]>) => Promise<PageVisual>>()
				.mockImplementationOnce(() => staleRender.promise)
				.mockImplementationOnce(async () => pixelVisual());
			const pageChanges: number[] = [];
			const controller = new ViewerController((event) => {
				if (event.type === "pagechange") pageChanges.push(event.detail.page);
			});
			await controller.load("brochure.pdf", createBackend(createPageSource(renderPage)));

			const input = renderInput(1);
			controller.requestRender(input);
			await vi.waitFor(() => expect(renderPage).toHaveBeenCalledOnce());
			invalidateRender(controller, invalidState);
			expect(controller.failure?.code).toBe(invalidState);

			if (lateResult === "success") staleRender.resolve(staleVisual);
			else staleRender.reject(new Error("The stale render failed."));
			await flushPendingWork();

			expect(controller.phase).toBe("error");
			expect(controller.failure?.code).toBe(invalidState);
			expect(controller.renderRevision).toBe(0);
			expect(pageChanges).toEqual([]);
			if (lateResult === "success") expect(closeStaleBitmap).toHaveBeenCalledOnce();
			else expect(closeStaleBitmap).not.toHaveBeenCalled();

			controller.requestRender(input);
			await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
			expect(renderPage).toHaveBeenCalledTimes(2);
			expect(controller.failure).toBeNull();
			expect(pageChanges).toEqual([1]);
			controller.dispose();
			if (lateResult === "success") expect(closeStaleBitmap).toHaveBeenCalledOnce();
		},
	);

	test.each(["invalid-page", "invalid-option"] as const)(
		"ignores page-size results after %s and lets the input be retried",
		async (invalidState) => {
			const firstPageSize = createDeferred<{
				width: number;
				height: number;
			}>();
			let pageSizeCalls = 0;
			const getPageSize = vi.fn(() => {
				pageSizeCalls += 1;
				return pageSizeCalls === 1
					? firstPageSize.promise
					: Promise.resolve({ width: 300, height: 400 });
			});
			const renderPage = vi.fn(async () => pixelVisual());
			const controller = new ViewerController(() => undefined);
			await controller.load(
				"brochure.pdf",
				createBackend({
					pageCount: 1,
					getPageSize,
					renderPage,
					async renderPrefetchedPage() {
						return pixelVisual();
					},
					dispose() {},
				}),
			);

			controller.requestRender(renderInput(1));
			await vi.waitFor(() => expect(getPageSize).toHaveBeenCalledOnce());
			const waitingInput = { ...renderInput(1), zoom: 1.5 };
			expect(controller.requestRender(waitingInput)).not.toBeNull();
			invalidateRender(controller, invalidState);
			expect(controller.failure?.code).toBe(invalidState);

			firstPageSize.resolve({ width: 300, height: 400 });
			await flushPendingWork();
			expect(getPageSize).toHaveBeenCalledTimes(2);
			expect(renderPage).not.toHaveBeenCalled();

			controller.requestRender(waitingInput);
			await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
			expect(getPageSize).toHaveBeenCalledTimes(3);
			expect(renderPage).toHaveBeenCalledOnce();
			expect(controller.failure).toBeNull();
			controller.dispose();
		},
	);
});

function invalidateRender(
	controller: ViewerController,
	invalidState: "invalid-page" | "invalid-option",
): void {
	if (invalidState === "invalid-page") {
		controller.requestRender({ ...renderInput(1), page: 3 });
		return;
	}
	controller.failInvalidOption();
}

function createBackend(pageSource: PageSource) {
	return {
		async open() {
			return pageSource;
		},
	};
}

function createPageSource(
	renderPage: (pageIndex: number, scale: number, signal?: AbortSignal) => Promise<PageVisual>,
): PageSource {
	return {
		pageCount: 2,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		renderPage,
		async renderPrefetchedPage() {
			return pixelVisual();
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

function bitmapVisual(close: () => void): PageVisual {
	return {
		type: "bitmap",
		width: 1,
		height: 1,
		bitmap: { width: 1, height: 1, close } as unknown as ImageBitmap,
	};
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
} {
	let resolve: (value: T) => void = () => undefined;
	let reject: (reason: unknown) => void = () => undefined;
	const promise = new Promise<T>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function flushPendingWork(): Promise<void> {
	await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}
