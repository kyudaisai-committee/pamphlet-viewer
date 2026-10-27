import { expect, test } from "vitest";

import { RANGE_CHUNK_SIZE } from "@/lib/pdfium/range/range-loader";
import { PdfiumWorkerClient } from "@/lib/pdfium/worker/worker-client";

interface FixtureMetrics {
	requestedBytes: number;
	fullRequests: number;
	fileLength: number;
}

test("gets a distant linearized page size without fetching the full PDF", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);

	const worker = new PdfiumWorkerClient();
	const url = new URL("/__linearized-range-fixture.pdf", window.location.href).href;
	try {
		const info = await worker.open(url);
		expect(info.pageCount).toBe(24);
		const pageSize = await worker.getPageSize(12);
		expect(pageSize).toEqual({ width: 300, height: 400 });

		const response = await fetch("/__linearized-range-metrics");
		expect(response.ok).toBe(true);
		const metrics = (await response.json()) as FixtureMetrics;
		expect(metrics.fullRequests).toBe(0);
		expect(metrics.requestedBytes).toBeLessThan(metrics.fileLength);
		expect(metrics.requestedBytes).toBeLessThan(RANGE_CHUNK_SIZE * 4);
	} finally {
		worker.terminate();
	}
}, 120_000);
