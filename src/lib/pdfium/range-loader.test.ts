import { afterEach, describe, expect, it, vi } from "vitest";

import {
	parseContentRange,
	PdfRangeLoader,
	RANGE_CHUNK_SIZE,
	RANGE_REQUEST_TIMEOUT_MS,
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
		const body = Uint8Array.from([1, 2, 3, 4]);
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(body, {
					status: 206,
					headers: {
						"Content-Range": "bytes 0-3/4",
						ETag: ETAG,
					},
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

	it("allows a cached read while another range is pending", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 2;
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(new Uint8Array(RANGE_CHUNK_SIZE), {
					status: 206,
					headers: { "Content-Range": `bytes 0-${RANGE_CHUNK_SIZE - 1}/${fileLength}` },
				}),
		);

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

	it("reclaims cache space in one batch and can re-fetch an evicted range", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 8;
		const requestedStarts: number[] = [];
		vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
			const rangeHeader = new Headers(init?.headers).get("Range");
			if (rangeHeader === null) throw new Error("A byte range was not requested.");
			const start = Number(/^bytes=(\d+)-/.exec(rangeHeader)?.[1]);
			requestedStarts.push(start);
			const end = Math.min(start + RANGE_CHUNK_SIZE - 1, fileLength - 1);
			return new Response(new Uint8Array(end - start + 1), {
				status: 206,
				headers: {
					"Content-Range": `bytes ${start}-${end}/${fileLength}`,
					ETag: ETAG,
				},
			});
		});

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

			await loader.fetchMissingChunks();
			loader.isRangeAvailable(4 * RANGE_CHUNK_SIZE, 1);
			await loader.fetchMissingChunks();

			expect(loader.cacheEpoch).toBe(1);
			expect(loader.cachedByteLength).toBeLessThanOrEqual(RANGE_CHUNK_SIZE * 4);
			expect(loader.cachedByteLength).toBe(RANGE_CHUNK_SIZE * 3);
			expect(requestedStarts).toHaveLength(5);
			expect(loader.hasMissingChunks).toBe(false);
			expect(() => loader.isRangeAvailable(0, RANGE_CHUNK_SIZE * 5)).toThrow(
				"exceeds the 64 MiB working cache",
			);

			expect(loader.isRangeAvailable(0, 1)).toBe(false);
			await loader.fetchMissingChunks();
			expect(requestedStarts).toHaveLength(6);
			expect(loader.hasMissingChunks).toBe(false);
			expect(loader.cacheEpoch).toBe(1);
		} finally {
			loader.dispose();
		}
	});

	it("rejects full responses instead of downloading the complete PDF", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		await expect(loader.initialize()).rejects.toThrow("HTTP 200");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("rejects a range response body larger than the requested chunk and cancels it", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(RANGE_CHUNK_SIZE + 1));
			},
			cancel,
		});
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(body, {
					status: 206,
					headers: { "Content-Range": `bytes 0-${RANGE_CHUNK_SIZE - 1}/524288` },
				}),
		);

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		await expect(loader.initialize()).rejects.toThrow("more bytes than requested");
		expect(cancel).toHaveBeenCalledOnce();
		expect(loader.cachedByteLength).toBe(0);
	});

	it("cancels a rejected 416 response without retrying the request", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const fetchMock = vi.fn(
			async () =>
				new Response(body, {
					status: 416,
					headers: { "Content-Range": "bytes */524288" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		await expect(loader.initialize()).rejects.toThrow("HTTP 416");
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("cancels a 206 response with an invalid Content-Range header", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(body, {
					status: 206,
					headers: { "Content-Range": "bytes */524288" },
				}),
		);

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		await expect(loader.initialize()).rejects.toThrow("invalid Content-Range");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("cancels a short Content-Range before reading its oversized body", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(body, {
					status: 206,
					headers: { "Content-Range": "bytes 0-3/524288" },
				}),
		);

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		await expect(loader.initialize()).rejects.toThrow("incomplete byte range");
		expect(cancel).toHaveBeenCalledOnce();
		expect(loader.cachedByteLength).toBe(0);
	});

	it("aborts a range request when it exceeds its deadline", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal === null || signal === undefined) {
						reject(new Error("The byte-range request had no AbortSignal."));
						return;
					}
					signal.addEventListener(
						"abort",
						() => reject(new DOMException("Request aborted.", "AbortError")),
						{ once: true },
					);
				}),
		);

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		const pendingRequest = loader.initialize();
		const rejection = expect(pendingRequest).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(RANGE_REQUEST_TIMEOUT_MS);
		await rejection;
		loader.dispose();
	});

	it("cancels a response when its document validator changes between chunks", async () => {
		const cancel = vi.fn();
		let requestCount = 0;
		vi.stubGlobal("fetch", async () => {
			requestCount += 1;
			const start = requestCount === 1 ? 0 : RANGE_CHUNK_SIZE;
			const end = start + RANGE_CHUNK_SIZE - 1;
			return new Response(
				requestCount === 1 ? new Uint8Array(RANGE_CHUNK_SIZE) : new ReadableStream({ cancel }),
				{
					status: 206,
					headers: {
						"Content-Range": `bytes ${start}-${end}/524288`,
						ETag: requestCount === 1 ? ETAG : '"changed-document"',
					},
				},
			);
		});

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			await loader.initialize();
			expect(loader.readInto(RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1)).toBe(false);
			await expect(loader.fetchMissingChunks()).rejects.toThrow("representation changed");
			expect(cancel).toHaveBeenCalledOnce();
			expect(requestCount).toBe(2);
		} finally {
			loader.dispose();
		}
	});
});
