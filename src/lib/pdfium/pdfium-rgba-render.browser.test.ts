// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "vitest";

import type { PageVisual } from "../document/page-source";
import { PdfiumWorkerClient } from "./worker-client";

test("renders RGBA channels, alpha, white background, and an independent pixel buffer", async () => {
	const worker = new PdfiumWorkerClient();
	try {
		const url = new URL("/__pdfium-range-fixture.pdf", window.location.href).href;
		const info = await worker.open(url);
		const firstPage = await worker.renderPage(0, 1);
		if (firstPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");

		expect(info.pageCount).toBe(24);
		expect(firstPage.width).toBe(300);
		expect(firstPage.height).toBe(400);
		expectPixelColor(firstPage, 150, 200, "blue");
		expectPixelAlpha(firstPage, 150, 200);
		expectPixelColor(firstPage, 0, 0, "white");
		expectPixelAlpha(firstPage, 0, 0);
		const firstPageBytes = Array.from(new Uint8Array(firstPage.pixels));

		const laterPage = await worker.renderPage(info.pageCount - 1, 1);
		if (laterPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
		expectPixelColor(laterPage, 150, 200, "red");
		expect(Array.from(new Uint8Array(firstPage.pixels))).toEqual(firstPageBytes);
	} finally {
		worker.terminate();
	}
}, 120_000);

test("keeps RGBA channels and alpha on rotated CropBox pages", async () => {
	const worker = new PdfiumWorkerClient();
	try {
		const url = new URL("/__rotated-crop-range-fixture.pdf", window.location.href).href;
		const info = await worker.open(url);
		const pageSize = await worker.getPageSize(0);
		const visual = await worker.renderPage(0, 1);
		if (visual.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");

		expect(info.pageCount).toBe(24);
		expect(pageSize).toEqual({ width: 300, height: 200 });
		expect(visual.width).toBe(pageSize.width);
		expect(visual.height).toBe(pageSize.height);
		expectPixelColor(visual, 150, 100, "blue");
		expectPixelAlpha(visual, 150, 100);
	} finally {
		worker.terminate();
	}
}, 120_000);

function expectPixelAlpha(visual: PageVisual, x: number, y: number): void {
	if (visual.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
	expect(pixelAt(visual, x, y)[3]).toBe(255);
}

function expectPixelColor(
	visual: PageVisual,
	x: number,
	y: number,
	color: "blue" | "red" | "white",
): void {
	if (visual.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
	const [red, green, blue] = pixelAt(visual, x, y);
	if (color === "blue") {
		expect(red).toBeLessThan(80);
		expect(green).toBeGreaterThan(50);
		expect(blue).toBeGreaterThan(150);
	} else if (color === "red") {
		expect(red).toBeGreaterThan(200);
		expect(green).toBeLessThan(60);
		expect(blue).toBeLessThan(80);
	} else {
		expect(red).toBeGreaterThan(240);
		expect(green).toBeGreaterThan(240);
		expect(blue).toBeGreaterThan(240);
	}
}

function pixelAt(visual: Extract<PageVisual, { type: "pixels" }>, x: number, y: number): number[] {
	const offset = (y * visual.width + x) * 4;
	return Array.from(new Uint8Array(visual.pixels, offset, 4));
}
