import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageSourceUnavailableError } from "@/lib/document/page-source";
import { PdfiumBackend } from "@/lib/document/pdfium-backend";
import { PdfRangeBroker } from "@/lib/pdfium/range/pdf-range-broker";

import { PdfiumWorkerClient, PdfiumWorkerUnavailableError } from "./worker-client";

interface WorkerRequestRecord {
	id: number;
	type: string;
	pageIndex?: number;
}

class ControlledWorker extends EventTarget {
	static instances: ControlledWorker[] = [];
	readonly requests: WorkerRequestRecord[] = [];
	terminateCalls = 0;
	postMessageError: Error | null = null;
	postMessageErrorForType: string | null = null;

	constructor() {
		super();
		ControlledWorker.instances.push(this);
	}

	postMessage(message: unknown): void {
		if (this.postMessageError !== null) throw this.postMessageError;
		if (!isWorkerRequestRecord(message)) throw new Error("Unexpected worker request.");
		if (this.postMessageErrorForType === message.type) {
			throw new Error(`The worker could not receive ${message.type}.`);
		}
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

	it("cancels an operation without terminating the worker and releases a late bitmap", async () => {
		const client = new PdfiumWorkerClient();
		const worker = getWorker();
		const controller = new AbortController();
		const render = client.renderPage(3, 1, "visible", controller.signal);
		const request = worker.requests[0];
		if (request === undefined) throw new Error("The render request was not posted.");

		controller.abort();
		expect(worker.requests[1]).toMatchObject({ type: "cancel", id: request.id });
		const close = vi.fn();
		worker.reply({
			id: request.id,
			type: "rendered",
			visual: {
				type: "bitmap",
				width: 10,
				height: 10,
				bitmap: { close } as unknown as ImageBitmap,
			},
		});

		await expect(render).rejects.toMatchObject({ name: "AbortError" });
		expect(close).toHaveBeenCalledOnce();
		expect(worker.terminateCalls).toBe(0);
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
		await vi.waitFor(() => expect(worker.requests).toHaveLength(2));
		const sizeRequest = worker.requests[1];
		if (sizeRequest === undefined) throw new Error("The page-size request was not posted.");
		worker.reply({ id: sizeRequest.id, type: "error", message: "Worker trap.", fatal: true });
		await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(2));
		const retryWorker = ControlledWorker.instances[1];
		if (retryWorker === undefined) throw new Error("The replacement worker was not created.");
		const retryOpen = retryWorker.requests[0];
		if (retryOpen === undefined) throw new Error("The replacement worker was not opened.");
		retryWorker.reply({ id: retryOpen.id, type: "opened", pageCount: 2, fileLength: 1024 });
		await vi.waitFor(() => expect(retryWorker.requests).toHaveLength(2));
		const retrySize = retryWorker.requests[1];
		if (retrySize === undefined)
			throw new Error("The replacement page-size request was not posted.");
		retryWorker.reply({
			id: retrySize.id,
			type: "error",
			message: "The replacement worker failed.",
			fatal: true,
		});

		await expect(pageSize).rejects.toBeInstanceOf(PageSourceUnavailableError);
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
		if (prefetch === undefined) throw new Error("The page prefetch API was not exposed.");
		await vi.waitFor(() => expect(worker.requests).toHaveLength(2));
		const prefetchRequest = worker.requests[1];
		if (prefetchRequest === undefined) throw new Error("The page prefetch was not queued.");
		expect(prefetchRequest.type).toBe("page-prefetch");
		expect(prefetchRequest.pageIndex).toBe(6);
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

	it.each(["terminate", "error"] as const)(
		"ignores late range work and releases late visuals after %s",
		async (terminalAction) => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			const broker = new PdfRangeBroker("https://example.test/catalog.pdf");
			const client = new PdfiumWorkerClient(broker);
			const worker = getWorker();
			if (terminalAction === "terminate") client.terminate();
			else worker.dispatchEvent(new ErrorEvent("error", { message: "The worker crashed." }));

			worker.reply({
				type: "range-request",
				id: 40,
				request: {
					url: "https://example.test/catalog.pdf",
					start: 0,
					requestedEnd: 255,
					totalLength: null,
					etag: null,
					lastModified: null,
					priority: "visible",
				},
			});
			const close = vi.fn();
			worker.reply({
				id: 41,
				type: "rendered",
				visual: {
					type: "bitmap",
					width: 10,
					height: 10,
					bitmap: { close } as unknown as ImageBitmap,
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(fetch).not.toHaveBeenCalled();
			expect(close).toHaveBeenCalledOnce();
			broker.dispose();
		},
	);

	it("cleans up the pending request and abort listener after postMessage throws", async () => {
		const client = new PdfiumWorkerClient();
		const worker = getWorker();
		const controller = new AbortController();
		const postError = new Error("The worker could not receive a message.");
		worker.postMessageError = postError;
		const firstOpen = client.open("catalog.pdf", true, controller.signal);
		await expect(firstOpen).rejects.toBe(postError);

		worker.postMessageError = null;
		controller.abort();
		const secondOpen = client.open("catalog.pdf");
		const request = worker.requests[0];
		if (request === undefined) throw new Error("The retry open request was not posted.");
		expect(worker.requests).toHaveLength(1);
		worker.reply({ id: request.id, type: "opened", pageCount: 1, fileLength: 256 });
		await expect(secondOpen).resolves.toMatchObject({ pageCount: 1 });
		client.terminate();
	});

	it("retires a worker when promotion cannot be posted and releases a late render", async () => {
		const client = new PdfiumWorkerClient();
		const worker = getWorker();
		const opening = client.open("catalog.pdf");
		const openRequest = worker.requests[0];
		if (openRequest === undefined) throw new Error("The open request was not posted.");
		worker.reply({ id: openRequest.id, type: "opened", pageCount: 2, fileLength: 1024 });
		await opening;

		const render = client.renderPage(1, 1, "prerender");
		const renderRequest = worker.requests[1];
		if (renderRequest === undefined) throw new Error("The render request was not posted.");
		worker.postMessageErrorForType = "promote";
		expect(client.promoteRender(1, 1, "visible")).toBe(true);
		await expect(render).rejects.toBeInstanceOf(PdfiumWorkerUnavailableError);
		expect(worker.terminateCalls).toBe(1);

		const close = vi.fn();
		worker.reply({
			id: renderRequest.id,
			type: "rendered",
			visual: {
				type: "bitmap",
				width: 1,
				height: 1,
				bitmap: { close } as unknown as ImageBitmap,
			},
		});
		expect(close).toHaveBeenCalledOnce();
	});

	it("handles a range promotion after its broker is disposed", async () => {
		const broker = new PdfRangeBroker("https://example.test/catalog.pdf");
		const client = new PdfiumWorkerClient(broker);
		expect(client.isOpen).toBe(false);
		const worker = getWorker();
		worker.reply({
			type: "range-request",
			id: 12,
			request: {
				url: "https://example.test/catalog.pdf",
				start: 0,
				requestedEnd: 255,
				totalLength: null,
				etag: null,
				lastModified: null,
				priority: "prerender",
			},
		});
		broker.dispose();
		expect(() =>
			worker.reply({ type: "range-promote", id: 12, priority: "visible" }),
		).not.toThrow();
		await vi.waitFor(() => expect(worker.terminateCalls).toBe(1));
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
