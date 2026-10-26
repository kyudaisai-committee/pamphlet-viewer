import { expect, test } from "vitest";

import type { PageVisual } from "../document/page-source";
import { PdfiumBackend } from "../document/pdfium-backend";
import { PageRenderQueue } from "../domain/page-render-queue";

test("uses a PDFium-rendered color thumbnail without rendering the full page", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);
	const metricsBeforeOpen = await getThumbnailFixtureMetrics();
	const { queue, dispose } = await openQueue("/__embedded-thumbnail-range-fixture.pdf");
	try {
		const metricsAfterOpen = await getThumbnailFixtureMetrics();
		const visual = await queue.render(0, 0.3, "thumbnail");
		const metricsAfter = await getThumbnailFixtureMetrics();

		expect(visual.type).toBe("pixels");
		if (visual.type !== "pixels") throw new Error("PDFium should return thumbnail pixels.");
		expect(visual.width).toBe(3);
		expect(visual.height).toBe(4);
		expect(getPixel(visual, 0, 0)).toEqual([255, 0, 0, 255]);
		expect(getPixel(visual, 1, 0)).toEqual([0, 0, 255, 255]);
		expect(metricsAfter.fullRequests).toBe(0);
		expect(metricsAfterOpen.requestedBytes - metricsBeforeOpen.requestedBytes).toBeGreaterThan(
			0,
		);
		expect(metricsAfterOpen.requestedBytes - metricsBeforeOpen.requestedBytes).toBeLessThan(
			metricsAfterOpen.fileLength,
		);
		expect(metricsAfter.requestedBytes).toBe(metricsAfterOpen.requestedBytes);
	} finally {
		dispose();
	}
}, 120_000);

test("prefetches embedded thumbnails across the document with partial range requests", async () => {
	const abortController = new AbortController();
	const source = await new PdfiumBackend().open(
		new URL("/__embedded-thumbnail-batch-range-fixture.pdf", window.location.href).href,
		abortController.signal,
	);
	try {
		if (source.prefetchThumbnail === undefined) {
			throw new Error("The PDF source does not support embedded thumbnail prefetch.");
		}
		const metricsBefore = await getEmbeddedThumbnailBatchMetrics();
		const visuals = await Promise.all(
			Array.from(
				{ length: 24 },
				(_, pageIndex) => source.prefetchThumbnail?.(pageIndex) ?? Promise.resolve(null),
			),
		);
		const metricsAfter = await getEmbeddedThumbnailBatchMetrics();
		const requestedBytes = metricsAfter.requestedBytes - metricsBefore.requestedBytes;

		expect(visuals).toHaveLength(24);
		expect(visuals.every((visual) => visual !== null)).toBe(true);
		expect(metricsAfter.fullRequests - metricsBefore.fullRequests).toBe(0);
		expect(requestedBytes).toBeGreaterThan(0);
		expect(requestedBytes).toBeGreaterThan(256 * 256 * 3);
		expect(requestedBytes).toBeLessThan(1024 * 1024);
		expect(requestedBytes).toBeLessThan(metricsAfter.fileLength);
	} finally {
		source.dispose();
		abortController.abort();
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

async function getThumbnailFixtureMetrics(): Promise<{
	requestedBytes: number;
	fullRequests: number;
	ranges: Array<{ start: number; end: number }>;
	fileLength: number;
}> {
	const response = await fetch("/__embedded-thumbnail-range-metrics");
	if (!response.ok) throw new Error("The embedded thumbnail fixture metrics are unavailable.");
	return response.json();
}

async function getEmbeddedThumbnailBatchMetrics(): Promise<{
	requestedBytes: number;
	fullRequests: number;
	ranges: Array<{ start: number; end: number }>;
	fileLength: number;
}> {
	const response = await fetch("/__embedded-thumbnail-batch-range-metrics");
	if (!response.ok) {
		throw new Error("The embedded thumbnail batch fixture metrics are unavailable.");
	}
	return response.json();
}

function getPixel(visual: Extract<PageVisual, { type: "pixels" }>, x: number, y: number): number[] {
	const offset = (y * visual.width + x) * 4;
	return Array.from(new Uint8Array(visual.pixels, offset, 4));
}
