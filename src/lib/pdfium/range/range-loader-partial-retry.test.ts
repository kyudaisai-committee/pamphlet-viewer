import { afterEach, describe, expect, it, vi } from "vitest";

import { PdfRangeLoader, RANGE_CHUNK_SIZE } from "./range-loader";

const ETAG = '"partial-retry-document"';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PdfRangeLoader partial retries", () => {
	it("retries only failed chunks after a parallel response fails", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 6;
		const ranges = stubRetryableRangeFetch(fileLength, [RANGE_CHUNK_SIZE * 4]);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			loader.isRangeAvailable(RANGE_CHUNK_SIZE, 1);
			loader.isRangeAvailable(4 * RANGE_CHUNK_SIZE, 1);

			await expect(loader.fetchMissingChunks()).rejects.toThrow("HTTP 503");
			expect(ranges).toEqual([
				`bytes=0-${RANGE_CHUNK_SIZE - 1}`,
				`bytes=${RANGE_CHUNK_SIZE}-${2 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${4 * RANGE_CHUNK_SIZE}-${5 * RANGE_CHUNK_SIZE - 1}`,
			]);
			expect(loader.cacheEpoch).toBe(0);
			expect(loader.hasMissingChunks).toBe(true);
			expect(loader.readInto(RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1)).toBe(true);

			expect(await loader.fetchMissingChunks()).toBe(1);
			expect(ranges).toEqual([
				`bytes=0-${RANGE_CHUNK_SIZE - 1}`,
				`bytes=${RANGE_CHUNK_SIZE}-${2 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${4 * RANGE_CHUNK_SIZE}-${5 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${4 * RANGE_CHUNK_SIZE}-${5 * RANGE_CHUNK_SIZE - 1}`,
			]);
			expect(loader.hasMissingChunks).toBe(false);
			expect(loader.cacheEpoch).toBe(0);
		} finally {
			loader.dispose();
		}
	});

	it("keeps evicted chunks missing when a later parallel range fails", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 8;
		const ranges = stubRetryableRangeFetch(fileLength, [RANGE_CHUNK_SIZE * 6]);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
			RANGE_CHUNK_SIZE * 4,
		);
		try {
			await loader.initialize();
			for (const chunkIndex of [1, 2, 3]) {
				loader.isRangeAvailable(chunkIndex * RANGE_CHUNK_SIZE, 1);
			}
			expect(await loader.fetchMissingChunks()).toBe(3);

			loader.isRangeAvailable(4 * RANGE_CHUNK_SIZE, 1);
			loader.isRangeAvailable(6 * RANGE_CHUNK_SIZE, 1);
			await expect(loader.fetchMissingChunks()).rejects.toThrow("HTTP 503");
			expect(loader.cacheEpoch).toBe(1);
			expect(loader.readInto(4 * RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1)).toBe(true);

			expect(await loader.fetchMissingChunks()).toBe(1);
			expect(ranges).toEqual([
				`bytes=0-${RANGE_CHUNK_SIZE - 1}`,
				`bytes=${RANGE_CHUNK_SIZE}-${4 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${4 * RANGE_CHUNK_SIZE}-${5 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${6 * RANGE_CHUNK_SIZE}-${7 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${6 * RANGE_CHUNK_SIZE}-${7 * RANGE_CHUNK_SIZE - 1}`,
			]);
			expect(loader.cacheEpoch).toBe(1);
			expect(loader.isRangeAvailable(0, 1)).toBe(false);
			expect(loader.isRangeAvailable(RANGE_CHUNK_SIZE, 1)).toBe(false);
		} finally {
			loader.dispose();
		}
	});
});

function stubRetryableRangeFetch(fileLength: number, failedStarts: number[]): string[] {
	const ranges: string[] = [];
	const failuresRemaining = new Set(failedStarts);
	vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
		const rangeHeader = new Headers(init?.headers).get("Range");
		const match = rangeHeader === null ? null : /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
		if (rangeHeader === null || match === null)
			throw new Error("A byte range was not requested.");
		const start = Number(match[1]);
		const requestedEnd = Number(match[2]);
		ranges.push(rangeHeader);
		if (failuresRemaining.delete(start)) return new Response(null, { status: 503 });

		const end = Math.min(requestedEnd, fileLength - 1);
		const bytes = new Uint8Array(end - start + 1);
		bytes.fill(Math.floor(start / RANGE_CHUNK_SIZE) % 251);
		return new Response(bytes, {
			status: 206,
			headers: {
				"Content-Range": `bytes ${start}-${end}/${fileLength}`,
				ETag: ETAG,
			},
		});
	});
	return ranges;
}
