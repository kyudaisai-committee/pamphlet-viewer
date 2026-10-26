// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";

import { PdfRangeLoader, RANGE_CHUNK_SIZE } from "./range-loader";

interface RedirectFixtureMetrics {
	ranges: Array<{ start: number; end: number }>;
	redirects: number;
}

test("reuses an HTTP redirect target for later byte ranges", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);

	const url = new URL("/__pdfium-redirect-range-fixture.pdf", window.location.href).href;
	const loader = new PdfRangeLoader(url, new AbortController().signal);
	try {
		expect(await loader.initialize()).toBe(RANGE_CHUNK_SIZE * 2);
		expect(loader.readInto(RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1)).toBe(false);
		expect(await loader.fetchMissingChunks()).toBe(1);

		const metricsResponse = await fetch("/__pdfium-redirect-range-metrics");
		expect(metricsResponse.ok).toBe(true);
		const metrics = (await metricsResponse.json()) as RedirectFixtureMetrics;
		expect(metrics.redirects).toBe(1);
		expect(metrics.ranges).toEqual([
			{ start: 0, end: RANGE_CHUNK_SIZE - 1 },
			{ start: RANGE_CHUNK_SIZE, end: RANGE_CHUNK_SIZE * 2 - 1 },
		]);
	} finally {
		loader.dispose();
	}
}, 30_000);
