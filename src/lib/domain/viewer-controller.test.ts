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
