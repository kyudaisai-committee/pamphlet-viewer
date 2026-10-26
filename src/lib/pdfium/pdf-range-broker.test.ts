import { expect, test, vi } from "vitest";

import { PdfRangeBroker } from "./pdf-range-broker";
import { RANGE_CHUNK_SIZE } from "./range-loader";
import { PdfRepresentationChangedError } from "./range-request";

const URL = "https://example.test/catalog.pdf";
const ETAG = '"catalog-v1"';

test("deduplicates overlapping in-flight chunks and reuses cached chunks", async () => {
	const pdf = createPdf(RANGE_CHUNK_SIZE * 6);
	const ranges: string[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const range = new Headers(init.headers).get("Range");
		if (range === null) throw new Error("The broker omitted the Range header.");
		ranges.push(range);
		return createResponse(pdf, range);
	});
	const broker = new PdfRangeBroker(URL);
	const controller = new AbortController();
	try {
		const [first, overlapping] = await Promise.all([
			broker.request(
				createRequest(0, 3 * RANGE_CHUNK_SIZE - 1, "visible"),
				controller.signal,
			),
			broker.request(
				createRequest(2 * RANGE_CHUNK_SIZE, 5 * RANGE_CHUNK_SIZE - 1, "prerender"),
				controller.signal,
			),
		]);
		expect([...first.bytes]).toEqual([...pdf.subarray(0, 3 * RANGE_CHUNK_SIZE)]);
		expect([...overlapping.bytes]).toEqual([
			...pdf.subarray(2 * RANGE_CHUNK_SIZE, 5 * RANGE_CHUNK_SIZE),
		]);
		expect(ranges).toEqual([
			`bytes=0-${4 * RANGE_CHUNK_SIZE - 1}`,
			`bytes=${4 * RANGE_CHUNK_SIZE}-${5 * RANGE_CHUNK_SIZE - 1}`,
		]);
		expect(broker.cachedByteLength).toBe(5 * RANGE_CHUNK_SIZE);

		await broker.request(
			createRequest(RANGE_CHUNK_SIZE, 2 * RANGE_CHUNK_SIZE - 1, "visible"),
			controller.signal,
		);
		expect(ranges).toHaveLength(2);
	} finally {
		broker.dispose();
		vi.unstubAllGlobals();
	}
});

test("cancelling one worker request does not cancel a shared fetch", async () => {
	const pdf = createPdf(RANGE_CHUNK_SIZE * 3);
	const response = createDeferred<Response>();
	const fetchSignals: AbortSignal[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		if (init.signal instanceof AbortSignal) fetchSignals.push(init.signal);
		return response.promise;
	});
	const broker = new PdfRangeBroker(URL);
	const firstController = new AbortController();
	const secondController = new AbortController();
	try {
		const first = broker.request(
			createRequest(0, RANGE_CHUNK_SIZE - 1, "prerender"),
			firstController.signal,
		);
		const second = broker.request(
			createRequest(0, RANGE_CHUNK_SIZE - 1, "visible"),
			secondController.signal,
		);
		await vi.waitFor(() => expect(fetchSignals).toHaveLength(1));
		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchSignals[0]?.aborted).toBe(false);

		response.resolve(createResponse(pdf, `bytes=0-${RANGE_CHUNK_SIZE - 1}`));
		const result = await second;
		expect([...result.bytes]).toEqual([...pdf.subarray(0, RANGE_CHUNK_SIZE)]);
		expect(fetchSignals[0]?.aborted).toBe(false);
	} finally {
		broker.dispose();
		vi.unstubAllGlobals();
	}
});

test("restarts a chunk request after its last cancelled fetch is already aborting", async () => {
	const pdf = createPdf(RANGE_CHUNK_SIZE * 2);
	const fetches: Array<{
		range: string;
		signal: AbortSignal;
		resolve(response: Response): void;
	}> = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const signal = init.signal;
		const range = new Headers(init.headers).get("Range");
		if (!(signal instanceof AbortSignal) || range === null) {
			throw new Error("The broker omitted an abortable range request.");
		}
		return new Promise<Response>((resolve, reject) => {
			fetches.push({ range, signal, resolve });
			signal.addEventListener(
				"abort",
				() => reject(new DOMException("The fetch was cancelled.", "AbortError")),
				{ once: true },
			);
			if (signal.aborted) reject(new DOMException("The fetch was cancelled.", "AbortError"));
		});
	});
	const broker = new PdfRangeBroker(URL);
	const firstController = new AbortController();
	try {
		const first = broker.request(
			createRequest(0, RANGE_CHUNK_SIZE - 1, "prerender"),
			firstController.signal,
		);
		await vi.waitFor(() => expect(fetches).toHaveLength(1));
		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });

		const retry = broker.request(
			createRequest(0, RANGE_CHUNK_SIZE - 1, "visible"),
			new AbortController().signal,
		);
		await vi.waitFor(() => expect(fetches).toHaveLength(2));
		const retryFetch = fetches[1];
		if (retryFetch === undefined) throw new Error("The retry fetch was not started.");
		retryFetch.resolve(createResponse(pdf, retryFetch.range));
		const response = await retry;
		expect([...response.bytes]).toEqual([...pdf.subarray(0, RANGE_CHUNK_SIZE)]);
		expect(fetches[0]?.signal.aborted).toBe(true);
		expect(broker.cachedByteLength).toBe(RANGE_CHUNK_SIZE);
	} finally {
		broker.dispose();
		vi.unstubAllGlobals();
	}
});

test("invalidates the document session when the server changes its representation", async () => {
	const pdf = createPdf(RANGE_CHUNK_SIZE * 2);
	let fetchCount = 0;
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const range = new Headers(init.headers).get("Range");
		if (range === null) throw new Error("The broker omitted the Range header.");
		fetchCount += 1;
		return fetchCount === 1
			? createResponse(pdf, range)
			: createResponse(pdf, range, '"catalog-v2"');
	});
	const broker = new PdfRangeBroker(URL);
	const signal = new AbortController().signal;
	try {
		await broker.request(createRequest(0, RANGE_CHUNK_SIZE - 1, "visible"), signal);
		await expect(
			broker.request(
				createRequest(RANGE_CHUNK_SIZE, 2 * RANGE_CHUNK_SIZE - 1, "visible"),
				signal,
			),
		).rejects.toBeInstanceOf(PdfRepresentationChangedError);
		await expect(
			broker.request(createRequest(0, RANGE_CHUNK_SIZE - 1, "visible"), signal),
		).rejects.toBeInstanceOf(PdfRepresentationChangedError);
		expect(fetchCount).toBe(2);
	} finally {
		broker.dispose();
		vi.unstubAllGlobals();
	}
});

test("allows a retry after a temporary HTTP range failure", async () => {
	const pdf = createPdf(RANGE_CHUNK_SIZE);
	let fetchCount = 0;
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		fetchCount += 1;
		if (fetchCount === 1) return new Response(null, { status: 503 });
		const range = new Headers(init.headers).get("Range");
		if (range === null) throw new Error("The broker omitted the Range header.");
		return createResponse(pdf, range);
	});
	const broker = new PdfRangeBroker(URL);
	const signal = new AbortController().signal;
	try {
		const request = createRequest(0, RANGE_CHUNK_SIZE - 1, "visible");
		await expect(broker.request(request, signal)).rejects.toThrow("HTTP 503");
		const response = await broker.request(request, signal);
		expect([...response.bytes]).toEqual([...pdf]);
		expect(fetchCount).toBe(2);
	} finally {
		broker.dispose();
		vi.unstubAllGlobals();
	}
});

function createRequest(
	start: number,
	requestedEnd: number,
	priority: "visible" | "data" | "prerender" | "thumbnail",
) {
	return {
		url: URL,
		start,
		requestedEnd,
		totalLength: null,
		etag: null,
		lastModified: null,
		priority,
	};
}

function createPdf(length: number): Uint8Array {
	return Uint8Array.from({ length }, (_value, index) => index % 251);
}

function createResponse(pdf: Uint8Array, rangeHeader: string, etag = ETAG): Response {
	const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
	if (match === null) throw new Error(`Invalid range: ${rangeHeader}`);
	const start = Number(match[1]);
	const end = Math.min(Number(match[2]), pdf.byteLength - 1);
	return new Response(pdf.slice(start, end + 1), {
		status: 206,
		headers: {
			"Content-Range": `bytes ${start}-${end}/${pdf.byteLength}`,
			"Content-Length": String(end - start + 1),
			ETag: etag,
			"Cache-Control": "no-store",
		},
	});
}

function createDeferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
	let resolve: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
