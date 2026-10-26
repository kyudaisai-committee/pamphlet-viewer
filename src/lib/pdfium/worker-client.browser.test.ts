import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageSourceUnavailableError } from "../document/page-source";
import { PdfiumBackend } from "../document/pdfium-backend";
import { PdfiumWorkerClient, PdfiumWorkerUnavailableError } from "./worker-client";

interface WorkerRequestRecord {
	id: number;
	type: string;
}

class ControlledWorker extends EventTarget {
	static instances: ControlledWorker[] = [];
	readonly requests: WorkerRequestRecord[] = [];
	terminateCalls = 0;

	constructor() {
		super();
		ControlledWorker.instances.push(this);
	}

	postMessage(message: unknown): void {
		if (!isWorkerRequestRecord(message)) throw new Error("Unexpected worker request.");
		this.requests.push(message);
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	reply(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
}

describe("PdfiumWorkerClient terminal state", () => {
	beforeEach(() => {
		ControlledWorker.instances = [];
		vi.stubGlobal("Worker", ControlledWorker);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("rejects every pending and future request after a fatal response", async () => {
		const client = new PdfiumWorkerClient();
		const worker = getWorker();
		const open = client.open("brochure.pdf");
		const pageSize = client.getPageSize(0);
		const request = worker.requests[0];
		if (request === undefined) throw new Error("The open request was not posted.");

		worker.reply({
			id: request.id,
			type: "error",
			message: "The document worker is no longer usable.",
			fatal: true,
		});

		await expect(open).rejects.toBeInstanceOf(PdfiumWorkerUnavailableError);
		await expect(pageSize).rejects.toBeInstanceOf(PdfiumWorkerUnavailableError);
		await expect(client.renderPage(0, 1)).rejects.toBeInstanceOf(PdfiumWorkerUnavailableError);
		expect(worker.terminateCalls).toBe(1);
	});

	it.each(["error", "messageerror"] as const)(
		"rejects pending and future requests after a worker %s event",
		async (eventType) => {
			const client = new PdfiumWorkerClient();
			const worker = getWorker();
			const open = client.open("brochure.pdf");

			if (eventType === "error") {
				worker.dispatchEvent(new ErrorEvent("error", { message: "The worker crashed." }));
			} else {
				worker.dispatchEvent(new Event("messageerror"));
			}

			await expect(open).rejects.toBeInstanceOf(PdfiumWorkerUnavailableError);
			await expect(client.open("brochure.pdf")).rejects.toBeInstanceOf(
				PdfiumWorkerUnavailableError,
			);
			expect(worker.terminateCalls).toBe(1);
		},
	);

	it("keeps nonfatal document errors retryable on the same worker", async () => {
		const client = new PdfiumWorkerClient();
		const worker = getWorker();
		const open = client.open("brochure.pdf");
		const openRequest = worker.requests[0];
		if (openRequest === undefined) throw new Error("The open request was not posted.");
		worker.reply({ id: openRequest.id, type: "error", message: "Temporary range failure." });
		await expect(open).rejects.toThrow("Temporary range failure.");

		const pageSize = client.getPageSize(0);
		const sizeRequest = worker.requests[1];
		if (sizeRequest === undefined) throw new Error("The page-size request was not posted.");
		worker.reply({
			id: sizeRequest.id,
			type: "page-size",
			pageSize: { width: 300, height: 400 },
		});

		await expect(pageSize).resolves.toEqual({ width: 300, height: 400 });
		expect(worker.terminateCalls).toBe(0);
		client.terminate();
	});

	it("returns an optional embedded thumbnail through the worker protocol", async () => {
		const client = new PdfiumWorkerClient();
		const worker = getWorker();
		const thumbnail = client.renderThumbnail(4);
		const request = worker.requests[0];
		if (request === undefined) throw new Error("The thumbnail request was not posted.");
		expect(request.type).toBe("thumbnail");

		worker.reply({ id: request.id, type: "thumbnail", visual: null });

		await expect(thumbnail).resolves.toBeNull();
		client.terminate();
	});

	it("prefetches page data through the worker without returning a visual", async () => {
		const client = new PdfiumWorkerClient();
		const worker = getWorker();
		const prefetch = client.prefetchPage(7);
		const request = worker.requests[0];
		if (request === undefined) throw new Error("The page prefetch request was not posted.");
		expect(request.type).toBe("page-prefetch");
		expect(request.pageIndex).toBe(7);

		worker.reply({ id: request.id, type: "page-prefetch" });

		await expect(prefetch).resolves.toBeUndefined();
		client.terminate();
	});

	it("maps a dead PDFium worker to the document-level unavailable contract", async () => {
		const backend = new PdfiumBackend();
		const openPromise = backend.open("brochure.pdf", new AbortController().signal);
		const worker = getWorker();
		const openRequest = worker.requests[0];
		if (openRequest === undefined) throw new Error("The open request was not posted.");
		worker.reply({ id: openRequest.id, type: "opened", pageCount: 2, fileLength: 1024 });
		const source = await openPromise;
		const pageSize = source.getPageSize(0);
		const sizeRequest = worker.requests[1];
		if (sizeRequest === undefined) throw new Error("The page-size request was not posted.");
		worker.reply({ id: sizeRequest.id, type: "error", message: "Worker trap.", fatal: true });

		await expect(pageSize).rejects.toBeInstanceOf(PageSourceUnavailableError);
		await source.dispose();
	});

	it("exposes an embedded thumbnail on the PDF page source", async () => {
		const backend = new PdfiumBackend();
		const openPromise = backend.open("brochure.pdf", new AbortController().signal);
		const worker = getWorker();
		const openRequest = worker.requests[0];
		if (openRequest === undefined) throw new Error("The open request was not posted.");
		worker.reply({ id: openRequest.id, type: "opened", pageCount: 2, fileLength: 1024 });
		const source = await openPromise;
		if (source.renderThumbnail === undefined) throw new Error("The thumbnail API was not exposed.");
		const thumbnail = source.renderThumbnail(0);
		const thumbnailRequest = worker.requests[1];
		if (thumbnailRequest === undefined) throw new Error("The thumbnail request was not posted.");
		worker.reply({ id: thumbnailRequest.id, type: "thumbnail", visual: null });

		await expect(thumbnail).resolves.toBeNull();
		await source.dispose();
	});

	it("exposes range-only page prefetch on the PDF page source", async () => {
		const backend = new PdfiumBackend();
		const openPromise = backend.open("brochure.pdf", new AbortController().signal);
		const worker = getWorker();
		const openRequest = worker.requests[0];
		if (openRequest === undefined) throw new Error("The open request was not posted.");
		worker.reply({ id: openRequest.id, type: "opened", pageCount: 8, fileLength: 1024 });
		const source = await openPromise;
		const prefetch = source.prefetchPage?.(6);
		const prefetchRequest = worker.requests[1];
		if (prefetch === undefined || prefetchRequest === undefined) {
			throw new Error("The page prefetch API was not exposed.");
		}
		expect(prefetchRequest.type).toBe("page-prefetch");
		worker.reply({ id: prefetchRequest.id, type: "page-prefetch" });

		await expect(prefetch).resolves.toBeUndefined();
		await source.dispose();
	});

	it("keeps explicit termination distinct from worker failure", async () => {
		const client = new PdfiumWorkerClient();
		const worker = getWorker();
		const open = client.open("brochure.pdf");
		client.terminate();

		await expect(open).rejects.toMatchObject({ name: "AbortError" });
		await expect(client.open("brochure.pdf")).rejects.toMatchObject({ name: "AbortError" });
		expect(worker.terminateCalls).toBe(1);
	});
});

function getWorker(): ControlledWorker {
	const worker = ControlledWorker.instances[0];
	if (worker === undefined) throw new Error("The worker client did not create a worker.");
	return worker;
}

function isWorkerRequestRecord(value: unknown): value is WorkerRequestRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "number" &&
		"type" in value &&
		typeof value.type === "string"
	);
}
