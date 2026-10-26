// SPDX-License-Identifier: MIT

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

	it("rejects conflicting validators from concurrent ranges", async () => {
		const fileLength = RANGE_CHUNK_SIZE * 4;
		const pendingResponses = new Map<number, (response: Response) => void>();
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const range = new Headers(init?.headers).get("Range");
			const match = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
			if (range === null || match === null) throw new Error("A byte range was not requested.");
			const start = Number(match[1]);
			const end = Number(match[2]);
			if (start === 0) return createRangeResponse(start, end, fileLength);
			return new Promise<Response>((resolve) => pendingResponses.set(start, resolve));
		});
		vi.stubGlobal("fetch", fetchMock);

		const loader = createLoader();
		try {
			await loader.initialize();
			loader.readInto(RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1);
			loader.readInto(3 * RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1);
			const pendingFetch = loader.fetchMissingChunks();
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

			const resolveFirst = pendingResponses.get(RANGE_CHUNK_SIZE);
			if (resolveFirst === undefined) throw new Error("The first range request did not start.");
			resolveFirst(
				createRangeResponse(RANGE_CHUNK_SIZE, 2 * RANGE_CHUNK_SIZE - 1, fileLength, ETAG),
			);
			await vi.waitFor(() => expect(loader.cachedByteLength).toBe(2 * RANGE_CHUNK_SIZE));

			const resolveSecond = pendingResponses.get(3 * RANGE_CHUNK_SIZE);
			if (resolveSecond === undefined) throw new Error("The second range request did not start.");
			resolveSecond(
				createRangeResponse(
					3 * RANGE_CHUNK_SIZE,
					4 * RANGE_CHUNK_SIZE - 1,
					fileLength,
					'"different-document"',
				),
			);
			await expect(pendingFetch).rejects.toThrow("representation changed");
			expect(loader.cachedByteLength).toBe(2 * RANGE_CHUNK_SIZE);
		} finally {
			loader.dispose();
		}
	});

	it("does not restore cache state when disposed during a range request", async () => {
		const responseResolver: { current: ((response: Response) => void) | null } = { current: null };
		vi.stubGlobal(
			"fetch",
			() =>
				new Promise<Response>((resolve) => {
					responseResolver.current = resolve;
				}),
		);
		const loader = createLoader();
		const pendingInitialization = loader.initialize();
		loader.dispose();
		const resolveResponse = responseResolver.current;
		if (resolveResponse === null) throw new Error("The initial range request did not start.");
		resolveResponse(createRangeResponse(0, RANGE_CHUNK_SIZE - 1, RANGE_CHUNK_SIZE));

		await expect(pendingInitialization).rejects.toMatchObject({ name: "AbortError" });
		expect(loader.totalLength).toBeNull();
		expect(loader.cachedByteLength).toBe(0);
	});
});

function createLoader(signal = new AbortController().signal): PdfRangeLoader {
	return new PdfRangeLoader("https://example.test/document.pdf", signal);
}

function createRangeResponse(
	start: number,
	end: number,
	totalLength: number,
	etag: string | null = null,
): Response {
	const headers = new Headers({ "Content-Range": `bytes ${start}-${end}/${totalLength}` });
	if (etag !== null) headers.set("ETag", etag);
	return new Response(new Uint8Array(end - start + 1), { status: 206, headers });
}
