// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	parseContentRange,
	PdfRangeLoader,
	RANGE_CHUNK_SIZE,
	RANGE_REQUEST_MAX_CHUNKS,
} from "./range-loader";

const ETAG = '"test-document"';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("parseContentRange", () => {
	it("accepts a complete byte range with a known total", () => {
		expect(parseContentRange("bytes 256-511/1024")).toEqual({
			start: 256,
			end: 511,
			total: 1024,
		});
	});

	it.each([null, "bytes */1024", "bytes 0-1024/1024", "bytes nope"])(
		"rejects invalid Content-Range values: %s",
		(value) => {
			expect(parseContentRange(value)).toBeNull();
		},
	);
});

describe("PdfRangeLoader", () => {
	it("copies cached bytes into PDFium's requested buffer", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(Uint8Array.from([1, 2, 3, 4]), {
					status: 206,
					headers: { "Content-Range": "bytes 0-3/4", ETag: ETAG },
				}),
		);

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			expect(await loader.initialize()).toBe(4);
			const target = new Uint8Array(6);
			expect(loader.readInto(1, target, 2, 2)).toBe(true);
			expect(target).toEqual(new Uint8Array([0, 0, 2, 3, 0, 0]));
			expect(loader.cachedByteLength).toBe(4);
		} finally {
			loader.dispose();
		}
	});

	it("rejects negative offsets and sizes at the reader boundary", async () => {
		stubRangeFetch(4);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			expect(() => loader.readInto(-1, new Uint8Array(1), 0, 1)).toThrow(RangeError);
			expect(() => loader.isRangeAvailable(-1, 1)).toThrow(RangeError);
			expect(() => loader.hintRange(0, -1)).toThrow(RangeError);
		} finally {
			loader.dispose();
		}
	});

	it("allows a cached read while another range is pending", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 2;
		stubRangeFetch(fileLength);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			expect(loader.isRangeAvailable(RANGE_CHUNK_SIZE, 1)).toBe(false);
			expect(loader.hasMissingChunks).toBe(true);
			expect(loader.readInto(0, new Uint8Array(1), 0, 1)).toBe(true);
		} finally {
			loader.dispose();
		}
	});

	it("combines consecutive missing chunks into ranges of at most 1 MiB", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 12;
		const fetchMetrics = stubRangeFetch(fileLength);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			for (let index = 1; index <= 8; index += 1) {
				loader.isRangeAvailable(index * RANGE_CHUNK_SIZE, 1);
			}

			expect(await loader.fetchMissingChunks()).toBe(8);
			expect(fetchMetrics.ranges).toEqual([
				`bytes=0-${RANGE_CHUNK_SIZE - 1}`,
				`bytes=${RANGE_CHUNK_SIZE}-${5 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${5 * RANGE_CHUNK_SIZE}-${9 * RANGE_CHUNK_SIZE - 1}`,
			]);
			expect(RANGE_REQUEST_MAX_CHUNKS * RANGE_CHUNK_SIZE).toBe(1024 * 1024);

			const data = new Uint8Array(8 * RANGE_CHUNK_SIZE);
			expect(loader.readInto(RANGE_CHUNK_SIZE, data, 0, data.byteLength)).toBe(true);
			expect(Array.from({ length: 8 }, (_value, index) => data[index * RANGE_CHUNK_SIZE])).toEqual([
				1, 2, 3, 4, 5, 6, 7, 8,
			]);
			expect(loader.cachedByteLength).toBe(9 * RANGE_CHUNK_SIZE);
		} finally {
			loader.dispose();
		}
	});

	it("does not fetch gaps or cached chunks between missing ranges", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 6;
		const fetchMetrics = stubRangeFetch(fileLength);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			loader.isRangeAvailable(2 * RANGE_CHUNK_SIZE, 1);
			await loader.fetchMissingChunks();
			loader.isRangeAvailable(RANGE_CHUNK_SIZE, 1);
			loader.isRangeAvailable(3 * RANGE_CHUNK_SIZE, 1);

			expect(await loader.fetchMissingChunks()).toBe(2);
			expect(fetchMetrics.ranges).toEqual([
				`bytes=0-${RANGE_CHUNK_SIZE - 1}`,
				`bytes=${2 * RANGE_CHUNK_SIZE}-${3 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${RANGE_CHUNK_SIZE}-${2 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${3 * RANGE_CHUNK_SIZE}-${4 * RANGE_CHUNK_SIZE - 1}`,
			]);
		} finally {
			loader.dispose();
		}
	});

	it("prioritizes required missing ranges over hints", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 24;
		const fetchMetrics = stubRangeFetch(fileLength);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			loader.isRangeAvailable(20 * RANGE_CHUNK_SIZE, 1);
			loader.hintRange(2 * RANGE_CHUNK_SIZE, 1);
			loader.hintRange(10 * RANGE_CHUNK_SIZE, 1);

			expect(await loader.fetchMissingChunks(true)).toBe(3);
			expect(fetchMetrics.ranges.slice(1)).toEqual([
				`bytes=${20 * RANGE_CHUNK_SIZE}-${21 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${2 * RANGE_CHUNK_SIZE}-${3 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${10 * RANGE_CHUNK_SIZE}-${11 * RANGE_CHUNK_SIZE - 1}`,
			]);
		} finally {
			loader.dispose();
		}
	});

	it("keeps no more than four range requests in flight", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 36;
		const fetchMetrics = stubRangeFetch(fileLength, true);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			for (let index = 2; index <= 32; index += 2) {
				loader.isRangeAvailable(index * RANGE_CHUNK_SIZE, 1);
			}

			expect(await loader.fetchMissingChunks()).toBe(16);
			expect(fetchMetrics.maxActiveRequests).toBe(4);
			expect(fetchMetrics.ranges).toHaveLength(17);
		} finally {
			loader.dispose();
		}
	});

	it("splits a partial final response into its own cache chunk", async () => {
		const fileLength = 2 * RANGE_CHUNK_SIZE + 17;
		const fetchMetrics = stubRangeFetch(fileLength);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			loader.isRangeAvailable(2 * RANGE_CHUNK_SIZE, 17);
			expect(await loader.fetchMissingChunks()).toBe(1);
			expect(fetchMetrics.ranges).toEqual([
				`bytes=0-${RANGE_CHUNK_SIZE - 1}`,
				`bytes=${2 * RANGE_CHUNK_SIZE}-${3 * RANGE_CHUNK_SIZE - 1}`,
			]);
			expect(loader.cachedByteLength).toBe(RANGE_CHUNK_SIZE + 17);
			const tail = new Uint8Array(17);
			expect(loader.readInto(2 * RANGE_CHUNK_SIZE, tail, 0, tail.byteLength)).toBe(true);
			expect(tail[0]).toBe(2);
		} finally {
			loader.dispose();
		}
	});

	it("reclaims cache space in one batch and can re-fetch an evicted range", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 8;
		const fetchMetrics = stubRangeFetch(fileLength);
		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
			RANGE_CHUNK_SIZE * 4,
		);
		try {
			await loader.initialize();
			for (let index = 1; index < 4; index += 1) {
				loader.isRangeAvailable(index * RANGE_CHUNK_SIZE, 1);
			}

			expect(await loader.fetchMissingChunks()).toBe(3);
			loader.isRangeAvailable(4 * RANGE_CHUNK_SIZE, 1);
			await loader.fetchMissingChunks();

			expect(loader.cacheEpoch).toBe(1);
			expect(loader.cachedByteLength).toBe(RANGE_CHUNK_SIZE * 3);
			expect(fetchMetrics.ranges).toEqual([
				`bytes=0-${RANGE_CHUNK_SIZE - 1}`,
				`bytes=${RANGE_CHUNK_SIZE}-${4 * RANGE_CHUNK_SIZE - 1}`,
				`bytes=${4 * RANGE_CHUNK_SIZE}-${5 * RANGE_CHUNK_SIZE - 1}`,
			]);
			expect(loader.hasMissingChunks).toBe(false);
			expect(() => loader.isRangeAvailable(0, RANGE_CHUNK_SIZE * 5)).toThrow(
				"exceeds the 64 MiB working cache",
			);

			expect(loader.isRangeAvailable(0, 1)).toBe(false);
			await loader.fetchMissingChunks();
			expect(fetchMetrics.ranges).toHaveLength(4);
			expect(loader.hasMissingChunks).toBe(false);
			expect(loader.cacheEpoch).toBe(1);
		} finally {
			loader.dispose();
		}
	});
});

interface RangeFetchMetrics {
	ranges: string[];
	maxActiveRequests: number;
}

function stubRangeFetch(fileLength: number, delayResponses = false): RangeFetchMetrics {
	const metrics: RangeFetchMetrics = { ranges: [], maxActiveRequests: 0 };
	let activeRequests = 0;
	vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
		const rangeHeader = new Headers(init?.headers).get("Range");
		const match = rangeHeader === null ? null : /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
		if (match === null || rangeHeader === null) throw new Error("A byte range was not requested.");
		const start = Number(match[1]);
		const requestedEnd = Number(match[2]);
		metrics.ranges.push(rangeHeader);
		activeRequests += 1;
		metrics.maxActiveRequests = Math.max(metrics.maxActiveRequests, activeRequests);
		if (delayResponses) await new Promise<void>((resolve) => setTimeout(resolve, 0));
		activeRequests -= 1;

		const end = Math.min(requestedEnd, fileLength - 1);
		const bytes = new Uint8Array(end - start + 1);
		for (let offset = 0; offset < bytes.byteLength; offset += RANGE_CHUNK_SIZE) {
			bytes.fill(
				Math.floor((start + offset) / RANGE_CHUNK_SIZE) % 251,
				offset,
				Math.min(offset + RANGE_CHUNK_SIZE, bytes.byteLength),
			);
		}
		return new Response(bytes, {
			status: 206,
			headers: {
				"Content-Range": `bytes ${start}-${end}/${fileLength}`,
				ETag: ETAG,
			},
		});
	});
	return metrics;
}
