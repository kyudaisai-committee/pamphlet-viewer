// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";

import type { PageVisual } from "../document/page-source";
import { PdfiumBackend } from "../document/pdfium-backend";
import { PageRenderQueue } from "../domain/page-render-queue";

test("uses a PDF's embedded thumbnail through PDFium without a page-size render", async () => {
	const { queue, dispose } = await openQueue("/__embedded-thumbnail-range-fixture.pdf");
	try {
		const visual = await queue.render(0, 0.3, "thumbnail");

		expect(visual.type).toBe("pixels");
		if (visual.type !== "pixels") throw new Error("PDFium should return thumbnail pixels.");
		expect(visual.width).toBe(3);
		expect(visual.height).toBe(4);
		expect(getPixel(visual, 1, 2)).toEqual([0, 255, 0, 255]);
	} finally {
		dispose();
	}
}, 120_000);

test("renders a reduced page when the PDF has no embedded thumbnail", async () => {
	const { queue, dispose } = await openQueue("/__pdfium-range-fixture.pdf");
	try {
		const visual = await queue.render(0, 0.3, "thumbnail");

		expect(visual.type).toBe("pixels");
		if (visual.type !== "pixels") throw new Error("PDFium should return fallback pixels.");
		expect(visual.width / visual.height).toBeCloseTo(0.75);
		const [red, green, blue] = getPixel(
			visual,
			Math.floor(visual.width / 2),
			Math.floor(visual.height / 2),
		);
		expect(red).toBeLessThan(50);
		expect(green).toBeGreaterThan(50);
		expect(blue).toBeGreaterThan(150);
	} finally {
		dispose();
	}
}, 120_000);

async function openQueue(urlPath: string): Promise<{
	queue: PageRenderQueue;
	dispose(): void;
}> {
	const abortController = new AbortController();
	const source = await new PdfiumBackend().open(
		new URL(urlPath, window.location.href).href,
		abortController.signal,
	);
	const queue = new PageRenderQueue(source);
	return {
		queue,
		dispose() {
			queue.dispose();
			source.dispose();
			abortController.abort();
		},
	};
}

function getPixel(visual: Extract<PageVisual, { type: "pixels" }>, x: number, y: number): number[] {
	const offset = (y * visual.width + x) * 4;
	return Array.from(new Uint8Array(visual.pixels, offset, 4));
}
