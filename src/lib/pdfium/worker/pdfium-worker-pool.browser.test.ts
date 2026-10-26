import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PdfiumBackend } from "@/lib/document/pdfium-backend";
import { PagePrerenderScheduler } from "@/lib/domain/scheduling/page-prerender-scheduler";
import { PdfRangeBroker } from "@/lib/pdfium/range/pdf-range-broker";
import { RANGE_CHUNK_SIZE } from "@/lib/pdfium/range/range-loader";
import type { RangeTransportRequest } from "@/lib/pdfium/range/range-transport";

import { PdfiumWorkerPool } from "./pdfium-worker-pool";
interface WorkerRequest {
	id: number;
	type: string;
}

class ControlledWorker extends EventTarget {
	static instances: ControlledWorker[] = [];
	readonly requests: WorkerRequest[] = [];
	terminateCalls = 0;
	opened = false;

	constructor() {
		super();
		ControlledWorker.instances.push(this);
	}

	postMessage(message: unknown): void {
		if (!isWorkerRequest(message)) throw new Error("The PDF worker request is invalid.");
		this.requests.push(message);
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	reply(data: unknown): void {
		if (isObjectWithType(data) && data.type === "opened") this.opened = true;
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
}

beforeEach(() => {
	ControlledWorker.instances = [];
	vi.stubGlobal("Worker", ControlledWorker);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

test("cancels and retries a prerender through the real PDF backend worker pool", async () => {
	const backend = new PdfiumBackend();
	const openController = new AbortController();
	const opening = backend.open("https://example.test/catalog.pdf", openController.signal);
	const worker = getWorker(0);
	const openRequest = await waitForRequest(worker, "open");
	worker.reply({ id: openRequest.id, type: "opened", pageCount: 3, fileLength: 1024 });
	const source = await opening;
	const scheduler = new PagePrerenderScheduler();
	try {
		scheduler.setSource(source);
		scheduler.setRequests([{ pageIndex: 1, scale: 1 }]);
		const firstRender = await waitForRequest(worker, "render");

		scheduler.setRequests([]);
		const cancelRequest = await waitForRequest(worker, "cancel");
		expect(cancelRequest.id).toBe(firstRender.id);
		worker.reply({
			id: firstRender.id,
			type: "error",
			message: "The prerender was cancelled.",
			errorName: "AbortError",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		scheduler.setRequests([{ pageIndex: 1, scale: 1 }]);
		const retry = await waitForRequest(worker, "render", 3);
		expect(retry.id).not.toBe(firstRender.id);
		worker.reply({
			id: retry.id,
			type: "rendered",
			visual: {
				type: "pixels",
				width: 1,
				height: 1,
				pixels: new ArrayBuffer(4),
			},
		});
		await vi.waitFor(() => expect(scheduler.cachedPixelBytes).toBe(4));
		expect(scheduler.take(1, 1)).toBeDefined();
	} finally {
		scheduler.setSource(null);
		source.dispose();
	}
});

test("replaces an abandoned opening worker before the old open response arrives", async () => {
	const broker = new PdfRangeBroker("https://example.test/catalog.pdf");
	const pool = new PdfiumWorkerPool("https://example.test/catalog.pdf", 10, broker, null, 4);
	const controllers = Array.from({ length: 4 }, () => new AbortController());
	try {
		const obsoleteRequests = controllers.map((controller, pageIndex) =>
			pool.getPageSize(pageIndex, "visible", controller.signal),
		);
		await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(4));
		const oldWorkers = [...ControlledWorker.instances];
		const oldOpenRequests = oldWorkers.map((worker) => worker.requests[0]);
		for (const request of oldOpenRequests) {
			if (request === undefined) throw new Error("An obsolete worker did not start opening.");
			expect(request.type).toBe("open");
		}

		for (const controller of controllers) controller.abort();
		await Promise.allSettled(obsoleteRequests);
		for (const [index, worker] of oldWorkers.entries()) {
			const request = oldOpenRequests[index];
			if (request === undefined) throw new Error("An open request is missing.");
			expect(worker.requests).toContainEqual({ type: "cancel", id: request.id });
		}

		const latestPageSize = pool.getPageSize(8, "visible");
		await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(5));
		const replacement = getWorker(4);
		const replacementOpen = await waitForRequest(replacement, "open");
		expect(oldWorkers.some((worker) => worker.terminateCalls > 0)).toBe(true);
		replacement.reply({
			id: replacementOpen.id,
			type: "opened",
			pageCount: 10,
			fileLength: 1024,
		});
		const pageSizeRequest = await waitForRequest(replacement, "page-size");
		replacement.reply({
			id: pageSizeRequest.id,
			type: "page-size",
			pageSize: { width: 300, height: 400 },
		});
		await expect(latestPageSize).resolves.toEqual({ width: 300, height: 400 });
	} finally {
		pool.dispose();
		broker.dispose();
	}
});

test("promotes an in-flight prerender through the real backend and range broker", async () => {
	const sourceUrl = "https://example.test/catalog.pdf";
	const pdf = Uint8Array.from({ length: RANGE_CHUNK_SIZE * 12 }, (_value, index) => index % 251);
	const fetches: Array<{
		range: string;
		signal: AbortSignal;
		resolve(response: Response): void;
	}> = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const signal = init.signal;
		const range = new Headers(init.headers).get("Range");
		if (!(signal instanceof AbortSignal) || range === null) {
			throw new Error("The PDF range broker omitted an abortable request.");
		}
		return new Promise<Response>((resolve, reject) => {
			fetches.push({ range, signal, resolve });
			signal.addEventListener(
				"abort",
				() => reject(new DOMException("The range fetch was cancelled.", "AbortError")),
				{ once: true },
			);
		});
	});
	const backend = new PdfiumBackend();
	const opening = backend.open(sourceUrl, new AbortController().signal);
	const worker = getWorker(0);
	const openRequest = await waitForRequest(worker, "open");
	worker.reply({ id: openRequest.id, type: "opened", pageCount: 3, fileLength: pdf.byteLength });
	const source = await opening;
	const controller = new AbortController();
	try {
		worker.reply({
			type: "range-request",
			id: 100,
			request: createRangeRequest(sourceUrl, 0, "thumbnail"),
		});
		worker.reply({
			type: "range-request",
			id: 101,
			request: createRangeRequest(sourceUrl, 4 * RANGE_CHUNK_SIZE, "thumbnail"),
		});
		await vi.waitFor(() => expect(fetches).toHaveLength(2));
		const prerender = source.renderPrefetchedPage(1, 1, controller.signal);
		const renderRequest = await waitForRequest(worker, "render");
		worker.reply({
			type: "range-request",
			id: 102,
			request: createRangeRequest(sourceUrl, 8 * RANGE_CHUNK_SIZE, "prerender"),
		});
		await vi.waitFor(() => expect(fetches).toHaveLength(2));

		expect(source.promotePageRender?.(1, 1)).toBe(true);
		const promote = worker.requests.find((request) => request.type === "promote");
		expect(promote).toMatchObject({ id: renderRequest.id, priority: "visible" });
		worker.reply({ type: "range-promote", id: 102, priority: "visible" });
		await vi.waitFor(() => expect(fetches).toHaveLength(3));
		expect(fetches.slice(0, 2).every((fetch) => !fetch.signal.aborted)).toBe(true);
		const promotedFetch = fetches[2];
		if (promotedFetch === undefined) throw new Error("The promoted range fetch did not start.");
		promotedFetch.resolve(createRangeResponse(pdf, promotedFetch.range));
		await vi.waitFor(() =>
			expect(worker.requests).toContainEqual(
				expect.objectContaining({ type: "range-response", id: 102 }),
			),
		);
		worker.reply({
			id: renderRequest.id,
			type: "rendered",
			visual: {
				type: "pixels",
				width: 1,
				height: 1,
				pixels: new ArrayBuffer(4),
			},
		});
		await expect(prerender).resolves.toMatchObject({ type: "pixels", width: 1, height: 1 });
	} finally {
		controller.abort();
		source.dispose();
		vi.unstubAllGlobals();
	}
});

test("prefers an idle prepared worker and avoids a busy prepared worker", async () => {
	const url = "https://example.test/catalog.pdf";
	const broker = new PdfRangeBroker(url);
	const pool = new PdfiumWorkerPool(url, 10, broker, null, 2);
	try {
		const page0 = pool.getPageSize(0);
		const worker0 = getWorker(0);
		await openWorker(worker0);
		const page0Request = await waitForRequest(worker0, "page-size");

		const warmPage7 = pool.getPageSize(7);
		const worker1 = getWorker(1);
		await openWorker(worker1);
		const warmPage7Request = await waitForRequest(worker1, "page-size");
		worker1.reply({
			id: warmPage7Request.id,
			type: "page-size",
			pageSize: { width: 200, height: 300 },
		});
		await warmPage7;
		worker0.reply({
			id: page0Request.id,
			type: "page-size",
			pageSize: { width: 200, height: 300 },
		});
		await page0;

		const busyPage9Start = worker0.requests.length;
		const busyPage9 = pool.getPageSize(9);
		const busyPage9Request = await waitForRequest(worker0, "page-size", busyPage9Start);
		const busyPage8Start = worker1.requests.length;
		const busyPage8 = pool.getPageSize(8);
		const busyPage8Request = await waitForRequest(worker1, "page-size", busyPage8Start);
		worker0.reply({
			id: busyPage9Request.id,
			type: "page-size",
			pageSize: { width: 200, height: 300 },
		});
		await busyPage9;

		const idleColdStart = worker0.requests.length;
		const page7OnIdleColdSlot = pool.getPageSize(7);
		const page7Request = await waitForRequest(worker0, "page-size", idleColdStart);
		worker0.reply({
			id: page7Request.id,
			type: "page-size",
			pageSize: { width: 200, height: 300 },
		});
		await page7OnIdleColdSlot;
		worker1.reply({
			id: busyPage8Request.id,
			type: "page-size",
			pageSize: { width: 200, height: 300 },
		});
		await busyPage8;
	} finally {
		pool.dispose();
		broker.dispose();
	}
});

test("clears worker page affinity after an unavailable worker is reset", async () => {
	const url = "https://example.test/catalog.pdf";
	const broker = new PdfRangeBroker(url);
	const pool = new PdfiumWorkerPool(url, 10, broker, null, 2);
	try {
		const page0 = pool.getPageSize(0);
		const worker0 = getWorker(0);
		await openWorker(worker0);
		const page0Request = await waitForRequest(worker0, "page-size");

		const warmPage8 = pool.getPageSize(8);
		const worker1 = getWorker(1);
		await openWorker(worker1);
		const warmPage8Request = await waitForRequest(worker1, "page-size");
		worker1.reply({
			id: warmPage8Request.id,
			type: "page-size",
			pageSize: { width: 200, height: 300 },
		});
		await warmPage8;
		worker0.reply({
			id: page0Request.id,
			type: "page-size",
			pageSize: { width: 200, height: 300 },
		});
		await page0;

		const failedController = new AbortController();
		const failedWarmPage = pool.getPageSize(8, "visible", failedController.signal);
		const failedRequest = await waitForRequest(worker1, "page-size", worker1.requests.length);
		worker1.reply({
			id: failedRequest.id,
			type: "error",
			message: "The worker failed before returning the page size.",
			fatal: true,
		});
		failedController.abort();
		await expect(failedWarmPage).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(worker1.terminateCalls).toBeGreaterThan(0));

		const retryStart = worker0.requests.length;
		const retry = pool.getPageSize(8);
		const retryRequest = await waitForRequest(worker0, "page-size", retryStart);
		expect(ControlledWorker.instances).toHaveLength(2);
		worker0.reply({
			id: retryRequest.id,
			type: "page-size",
			pageSize: { width: 200, height: 300 },
		});
		await expect(retry).resolves.toEqual({ width: 200, height: 300 });
	} finally {
		pool.dispose();
		broker.dispose();
	}
});

function getWorker(index: number): ControlledWorker {
	const worker = ControlledWorker.instances[index];
	if (worker === undefined) throw new Error(`The PDF worker ${index} was not created.`);
	return worker;
}

async function waitForRequest(
	worker: ControlledWorker,
	type: string,
	startIndex = 0,
): Promise<WorkerRequest> {
	let found: WorkerRequest | undefined;
	await expect
		.poll(() => {
			found = worker.requests.slice(startIndex).find((request) => request.type === type);
			return found !== undefined;
		})
		.toBe(true);
	if (found === undefined) throw new Error(`The PDF worker did not send ${type}.`);
	return found;
}

async function openWorker(worker: ControlledWorker): Promise<void> {
	if (worker.opened) return;
	const openRequest = await waitForRequest(worker, "open");
	worker.reply({ id: openRequest.id, type: "opened", pageCount: 10, fileLength: 1024 });
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "number" &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function isObjectWithType(value: unknown): value is { type: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

function createRangeRequest(
	url: string,
	start: number,
	priority: RangeTransportRequest["priority"],
): RangeTransportRequest {
	return {
		url,
		start,
		requestedEnd: start + RANGE_CHUNK_SIZE - 1,
		totalLength: null,
		etag: null,
		lastModified: null,
		priority,
	};
}

function createRangeResponse(pdf: Uint8Array, rangeHeader: string): Response {
	const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
	if (match === null) throw new Error("The PDF range header is invalid.");
	const start = Number(match[1]);
	const end = Math.min(Number(match[2]), pdf.byteLength - 1);
	return new Response(pdf.slice(start, end + 1), {
		status: 206,
		headers: {
			"Content-Range": `bytes ${start}-${end}/${pdf.byteLength}`,
			"Content-Length": String(end - start + 1),
			ETag: '"catalog-v1"',
			"Cache-Control": "no-store",
		},
	});
}
