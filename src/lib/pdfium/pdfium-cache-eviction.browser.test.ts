import pdfiumWasmAssetUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { expect, test } from "vitest";

import type { PageVisual } from "@/lib/document/page-source";

import { PdfiumDocumentSession } from "./pdfium-document";
import { RANGE_CHUNK_SIZE } from "./range-loader";

interface FixtureMetrics {
	requestedBytes: number;
	fullRequests: number;
	ranges: Array<{ start: number; end: number }>;
	fileLength: number;
}

test("rebuilds PDFium state after bounded cache eviction and re-renders an evicted page", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);

	const url = new URL("/__pdfium-eviction-fixture.pdf", window.location.href).href;
	const wasmUrl = new URL(pdfiumWasmAssetUrl, import.meta.url).href;
	const session = await PdfiumDocumentSession.open(
		url,
		wasmUrl,
		new AbortController().signal,
		RANGE_CHUNK_SIZE * 4,
	);
	try {
		const firstPageSize = await session.getPageSize(0);
		expect(firstPageSize).toEqual({ width: 300, height: 400 });
		const metricsAfterSize = await readMetrics();
		const firstContentChunk = RANGE_CHUNK_SIZE;
		expect(countChunkRequests(metricsAfterSize, firstContentChunk)).toBe(0);

		const firstPage = await session.renderPage(0, 1);
		expectCenterColor(firstPage, "blue");
		const firstMetrics = await readMetrics();
		expect(countChunkRequests(firstMetrics, firstContentChunk)).toBe(1);

		for (const pageIndex of [6, 12, 18]) {
			expectCenterColor(await session.renderPage(pageIndex, 1), "blue");
		}
		expectCenterColor(await session.renderPage(23, 1), "red");
		const metricsAfterEviction = await readMetrics();
		expect(countChunkRequests(metricsAfterEviction, firstContentChunk)).toBe(1);
		expect(metricsAfterEviction.fullRequests).toBe(0);

		expectCenterColor(await session.renderPage(0, 1), "blue");
		const finalMetrics = await readMetrics();
		expect(countChunkRequests(finalMetrics, firstContentChunk)).toBeGreaterThan(1);
		expect(finalMetrics.fullRequests).toBe(0);
		expect(finalMetrics.requestedBytes).toBeLessThan(finalMetrics.fileLength);
	} finally {
		session.dispose();
	}
}, 120_000);

async function readMetrics(): Promise<FixtureMetrics> {
	const response = await fetch("/__pdfium-eviction-metrics");
	if (!response.ok)
		throw new Error(`Could not read eviction fixture metrics (HTTP ${response.status}).`);
	return (await response.json()) as FixtureMetrics;
}

function countChunkRequests(metrics: FixtureMetrics, start: number): number {
	return metrics.ranges.filter((range) => range.start === start).length;
}

function expectCenterColor(visual: PageVisual, color: "blue" | "red"): void {
	if (visual.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
	const pixels = new Uint8ClampedArray(visual.pixels);
	const index = (Math.floor(visual.height / 2) * visual.width + Math.floor(visual.width / 2)) * 4;
	if (color === "blue") {
		expect(pixels[index]).toBeLessThan(80);
		expect(pixels[index + 1]).toBeGreaterThan(50);
		expect(pixels[index + 2]).toBeGreaterThan(150);
		return;
	}
	expect(pixels[index]).toBeGreaterThan(200);
	expect(pixels[index + 1]).toBeLessThan(60);
	expect(pixels[index + 2]).toBeLessThan(80);
}
