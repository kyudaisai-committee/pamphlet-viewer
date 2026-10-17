import { afterAll, expect, test } from "vitest";

import { PdfiumWorkerClient } from "./worker-client";

interface FixtureMetrics {
	requestedBytes: number;
	fullRequests: number;
	ranges: Array<{ start: number; end: number }>;
	fileLength: number;
}

afterAll(async () => {
	await fetch("/__pdfium-cors-close");
});

test("renders first and distant pages before downloading the full PDF", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);

	const worker = new PdfiumWorkerClient();
	const url = new URL("/__pdfium-range-fixture.pdf", window.location.href).href;
	try {
		const info = await worker.open(url);
		expect(info.pageCount).toBe(24);
		const firstPageSize = await worker.getPageSize(0);
		expect(firstPageSize).toEqual({ width: 300, height: 400 });
		const firstPage = await worker.renderPage(0, 1);
		expect(firstPage.type).toBe("pixels");
		if (firstPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
		expect(firstPage.width).toBe(300);
		expect(firstPage.height).toBe(400);
		expect(centerPixel(firstPage.pixels).r).toBeLessThan(80);
		expect(centerPixel(firstPage.pixels).g).toBeGreaterThan(50);
		expect(centerPixel(firstPage.pixels).b).toBeGreaterThan(150);

		const firstMetrics = await readMetrics();
		expect(firstMetrics.fullRequests).toBe(0);
		expect(firstMetrics.requestedBytes).toBeLessThan(firstMetrics.fileLength);

		const finalPage = await worker.renderPage(info.pageCount - 1, 1);
		expect(finalPage.type).toBe("pixels");
		if (finalPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
		expect(finalPage.width).toBe(300);
		expect(finalPage.height).toBe(400);
		expect(centerPixel(finalPage.pixels).r).toBeGreaterThan(200);
		expect(centerPixel(finalPage.pixels).g).toBeLessThan(60);
		expect(centerPixel(finalPage.pixels).b).toBeLessThan(80);

		const finalMetrics = await readMetrics();
		const firstRanges = new Set(firstMetrics.ranges.map(rangeKey));
		const additionalRanges = finalMetrics.ranges.filter(
			(range) => !firstRanges.has(rangeKey(range)),
		);
		expect(additionalRanges.some((range) => range.start > 8 * 1024 * 1024)).toBe(true);
		expect(finalMetrics.fullRequests).toBe(0);
		expect(finalMetrics.requestedBytes).toBeLessThan(finalMetrics.fileLength);
	} finally {
		worker.terminate();
	}
}, 120_000);

test("renders pages from a linearized PDF using additional byte ranges", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);

	const worker = new PdfiumWorkerClient();
	const url = new URL("/__linearized-range-fixture.pdf", window.location.href).href;
	try {
		const info = await worker.open(url);
		expect(info.pageCount).toBe(24);
		const firstPage = await worker.renderPage(0, 1);
		if (firstPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
		expect(centerPixel(firstPage.pixels).b).toBeGreaterThan(150);

		const firstMetrics = await readMetrics("/__linearized-range-metrics");
		expect(firstMetrics.fullRequests).toBe(0);
		expect(firstMetrics.requestedBytes).toBeLessThan(firstMetrics.fileLength);

		const distantPageIndex = 12;
		const distantPage = await worker.renderPage(distantPageIndex, 1);
		if (distantPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
		const distantPixel = centerPixel(distantPage.pixels);
		expect(distantPixel.r).toBeGreaterThan(200);
		expect(distantPixel.g).toBeLessThan(60);
		expect(distantPixel.b).toBeLessThan(80);

		const finalMetrics = await readMetrics("/__linearized-range-metrics");
		const firstRanges = new Set(firstMetrics.ranges.map(rangeKey));
		expect(finalMetrics.ranges.some((range) => !firstRanges.has(rangeKey(range)))).toBe(true);
		expect(finalMetrics.fullRequests).toBe(0);
		expect(finalMetrics.requestedBytes).toBeLessThan(finalMetrics.fileLength);
	} finally {
		worker.terminate();
	}
}, 120_000);

test("loads a PDF from a different origin with exposed Range response headers", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);

	const originResponse = await fetch("/__pdfium-cors-origin");
	expect(originResponse.ok).toBe(true);
	const { port } = (await originResponse.json()) as { port: number };
	const url = new URL("/__pdfium-range-fixture.pdf", window.location.href);
	url.hostname = "127.0.0.1";
	url.port = String(port);
	const worker = new PdfiumWorkerClient();
	try {
		const info = await worker.open(url.href);
		expect(info.pageCount).toBe(24);
		const firstPage = await worker.renderPage(0, 1);
		if (firstPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
		expect(centerPixel(firstPage.pixels).b).toBeGreaterThan(150);

		const metrics = await readMetrics();
		expect(metrics.ranges.length).toBeGreaterThan(0);
		expect(metrics.fullRequests).toBe(0);
		expect(metrics.requestedBytes).toBeLessThan(metrics.fileLength);
	} finally {
		worker.terminate();
	}
}, 120_000);

async function readMetrics(path = "/__pdfium-range-metrics"): Promise<FixtureMetrics> {
	const response = await fetch(path);
	if (!response.ok)
		throw new Error(`Could not read range fixture metrics (HTTP ${response.status}).`);
	return (await response.json()) as FixtureMetrics;
}

function centerPixel(buffer: ArrayBuffer): { r: number; g: number; b: number } {
	const pixels = new Uint8ClampedArray(buffer);
	const index = (200 * 300 + 150) * 4;
	return { r: pixels[index], g: pixels[index + 1], b: pixels[index + 2] };
}

function rangeKey(range: { start: number; end: number }): string {
	return `${range.start}-${range.end}`;
}
