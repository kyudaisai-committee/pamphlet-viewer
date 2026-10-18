import { describe, expect, it, vi } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
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

function bitmapVisual(close: () => void): PageVisual {
	const bitmap = { close } as unknown as ImageBitmap;
	return { type: "bitmap", width: 1, height: 1, bitmap };
}
