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
