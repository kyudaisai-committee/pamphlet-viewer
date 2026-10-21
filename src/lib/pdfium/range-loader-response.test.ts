import { afterEach, describe, expect, it, vi } from "vitest";

import { PdfRangeLoader, RANGE_CHUNK_SIZE, RANGE_REQUEST_TIMEOUT_MS } from "./range-loader";

const ETAG = '"test-document"';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("PdfRangeLoader response validation", () => {
	it("rejects full responses instead of downloading the complete PDF", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));

		const loader = createLoader();
		await expect(loader.initialize()).rejects.toThrow("HTTP 200");
		expect(cancel).toHaveBeenCalledOnce();
		loader.dispose();
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

		const loader = createLoader();
		await expect(loader.initialize()).rejects.toThrow("more bytes than requested");
		expect(cancel).toHaveBeenCalledOnce();
		expect(loader.cachedByteLength).toBe(0);
		loader.dispose();
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

		const loader = createLoader();
		await expect(loader.initialize()).rejects.toThrow("HTTP 416");
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledOnce();
		loader.dispose();
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

		const loader = createLoader();
		await expect(loader.initialize()).rejects.toThrow("invalid Content-Range");
		expect(cancel).toHaveBeenCalledOnce();
		loader.dispose();
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

		const loader = createLoader();
		await expect(loader.initialize()).rejects.toThrow("incomplete byte range");
		expect(cancel).toHaveBeenCalledOnce();
		expect(loader.cachedByteLength).toBe(0);
		loader.dispose();
	});

	it("aborts a request when its document signal is cancelled", async () => {
		const controller = new AbortController();
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

		const loader = new PdfRangeLoader("https://example.test/document.pdf", controller.signal);
		const pendingRequest = loader.initialize();
		controller.abort();
		await expect(pendingRequest).rejects.toMatchObject({ name: "AbortError" });
		loader.dispose();
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

		const loader = createLoader();
		const pendingRequest = loader.initialize();
		const rejection = expect(pendingRequest).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(RANGE_REQUEST_TIMEOUT_MS);
		await rejection;
		loader.dispose();
	});

	it("cancels a response when its document validator changes between chunks", async () => {
		const cancel = vi.fn();
		const requests: Array<{ range: string | null; ifRange: string | null }> = [];
		vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const range = headers.get("Range");
			requests.push({ range, ifRange: headers.get("If-Range") });
			const start = requests.length === 1 ? 0 : RANGE_CHUNK_SIZE;
			const end = start + RANGE_CHUNK_SIZE - 1;
			return new Response(
				requests.length === 1 ? new Uint8Array(RANGE_CHUNK_SIZE) : new ReadableStream({ cancel }),
				{
					status: 206,
					headers: {
						"Content-Range": `bytes ${start}-${end}/524288`,
						ETag: requests.length === 1 ? ETAG : '"changed-document"',
					},
				},
			);
		});

		const loader = createLoader();
		try {
			await loader.initialize();
			expect(loader.readInto(RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1)).toBe(false);
			await expect(loader.fetchMissingChunks()).rejects.toThrow("representation changed");
			expect(cancel).toHaveBeenCalledOnce();
			expect(requests).toEqual([
				{ range: `bytes=0-${RANGE_CHUNK_SIZE - 1}`, ifRange: null },
				{
					range: `bytes=${RANGE_CHUNK_SIZE}-${2 * RANGE_CHUNK_SIZE - 1}`,
					ifRange: ETAG,
				},
			]);
		} finally {
			loader.dispose();
		}
	});
});

function createLoader(signal = new AbortController().signal): PdfRangeLoader {
	return new PdfRangeLoader("https://example.test/document.pdf", signal);
}
