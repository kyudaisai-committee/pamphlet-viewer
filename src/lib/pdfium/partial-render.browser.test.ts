import { expect, test } from "vitest";

import { PdfiumWorkerClient } from "./worker-client";

interface FixtureMetrics {
	requestedBytes: number;
	fullRequests: number;
	ranges: Array<{ start: number; end: number }>;
	fileLength: number;
}

test("renders first and distant pages before downloading the full PDF", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);

	const worker = new PdfiumWorkerClient();
	const url = new URL("/__pdfium-range-fixture.pdf", window.location.href).href;
	try {
		const firstPage = await worker.renderPage(url, 0);
		expect(firstPage.pageCount).toBe(24);
		expect(firstPage.width).toBe(300);
		expect(firstPage.height).toBe(400);
		expect(centerPixel(firstPage.pixels).r).toBeLessThan(80);
		expect(centerPixel(firstPage.pixels).g).toBeGreaterThan(50);
		expect(centerPixel(firstPage.pixels).b).toBeGreaterThan(150);

		const firstMetrics = await readMetrics();
		expect(firstMetrics.fullRequests).toBe(0);
		expect(firstMetrics.requestedBytes).toBeLessThan(firstMetrics.fileLength);

		const finalPage = await worker.renderPage(url, firstPage.pageCount - 1);
		expect(finalPage.pageIndex).toBe(firstPage.pageCount - 1);
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

async function readMetrics(): Promise<FixtureMetrics> {
	const response = await fetch("/__pdfium-range-metrics");
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
