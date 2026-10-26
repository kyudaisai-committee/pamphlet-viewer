import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PdfiumBackend } from "@/lib/document/pdfium-backend";
import { PagePrerenderScheduler } from "@/lib/domain/scheduling/page-prerender-scheduler";
import { PdfRangeBroker } from "@/lib/pdfium/range/pdf-range-broker";

import { PdfiumWorkerPool } from "./pdfium-worker-pool";
interface WorkerRequest {
	id: number;
	type: string;
}

class ControlledWorker extends EventTarget {
	static instances: ControlledWorker[] = [];
	readonly requests: WorkerRequest[] = [];
	terminateCalls = 0;

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
