import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PdfiumBackend } from "../document/pdfium-backend";
import { PageRenderQueue } from "../domain/page-render-queue";

interface WorkerRequestRecord {
	id: number;
	type: string;
}

class ControlledWorker extends EventTarget {
	static instances: ControlledWorker[] = [];
	readonly requests: WorkerRequestRecord[] = [];

	constructor() {
		super();
		ControlledWorker.instances.push(this);
	}

	postMessage(message: unknown): void {
		if (!isWorkerRequestRecord(message)) throw new Error("Unexpected worker request.");
		this.requests.push(message);
	}

	terminate(): void {}

	reply(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
}

describe("PDFium thumbnail worker", () => {
	beforeEach(() => {
		ControlledWorker.instances = [];
		vi.stubGlobal("Worker", ControlledWorker);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("prefetches an embedded thumbnail through its own worker session", async () => {
		const source = await openSource();
		const prefetch = source.prefetchThumbnail?.(1);
		if (prefetch === undefined) throw new Error("The thumbnail prefetch API was not exposed.");
		const thumbnailWorker = getWorker(1);
		await vi.waitFor(() => expect(thumbnailWorker.requests).toHaveLength(1));
		const open = thumbnailWorker.requests[0];
		if (open === undefined) throw new Error("The thumbnail worker did not open.");
		thumbnailWorker.reply({ id: open.id, type: "opened", pageCount: 2, fileLength: 1024 });
		await vi.waitFor(() => expect(thumbnailWorker.requests).toHaveLength(2));
		const request = thumbnailWorker.requests[1];
		if (request === undefined) throw new Error("The thumbnail prefetch was not posted.");
		expect(request.type).toBe("thumbnail-prefetch");
		thumbnailWorker.reply({ id: request.id, type: "thumbnail-prefetch", visual: null });

		await expect(prefetch).resolves.toBeNull();
		await source.dispose();
	});

	it("lets page rendering finish while thumbnail extraction is pending", async () => {
		const source = await openSource();
		const documentWorker = getWorker(0);
		const render = source.renderPage(0, 1);
		const thumbnail = source.renderThumbnail?.(1);
		if (thumbnail === undefined) throw new Error("The thumbnail API was not exposed.");
		const thumbnailWorker = getWorker(1);
		await vi.waitFor(() => expect(thumbnailWorker.requests).toHaveLength(1));
		const open = thumbnailWorker.requests[0];
		if (open === undefined) throw new Error("The thumbnail worker did not open.");
		thumbnailWorker.reply({ id: open.id, type: "opened", pageCount: 2, fileLength: 1024 });
		await vi.waitFor(() => expect(thumbnailWorker.requests).toHaveLength(2));
		await vi.waitFor(() => expect(documentWorker.requests).toHaveLength(2));
		const renderRequest = documentWorker.requests[1];
		const thumbnailRequest = thumbnailWorker.requests[1];
		if (renderRequest === undefined || thumbnailRequest === undefined) {
			throw new Error("Both independent rendering requests should be outstanding.");
		}
		let thumbnailSettled = false;
		void thumbnail.then(() => {
			thumbnailSettled = true;
		});
		documentWorker.reply({
			id: renderRequest.id,
			type: "rendered",
			visual: { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) },
		});

		await expect(render).resolves.toMatchObject({ type: "pixels", width: 1 });
		expect(thumbnailSettled).toBe(false);
		thumbnailWorker.reply({
			id: thumbnailRequest.id,
			type: "thumbnail",
			visual: { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) },
		});
		await expect(thumbnail).resolves.toMatchObject({ type: "pixels", width: 1 });
		await source.dispose();
	});

	it("does not fall back to the body worker after an ordinary thumbnail error", async () => {
		const source = await openSource();
		const queue = new PageRenderQueue(source);
		const documentWorker = getWorker(0);
		try {
			const rendering = queue.render(1, 0.3, "thumbnail");
			const thumbnailWorker = getWorker(1);
			await vi.waitFor(() => expect(thumbnailWorker.requests).toHaveLength(1));
			const open = thumbnailWorker.requests[0];
			if (open === undefined) throw new Error("The thumbnail worker did not open.");
			thumbnailWorker.reply({ id: open.id, type: "opened", pageCount: 2, fileLength: 1024 });
			await vi.waitFor(() => expect(thumbnailWorker.requests).toHaveLength(2));
			const request = thumbnailWorker.requests[1];
			if (request === undefined) throw new Error("The thumbnail request was not posted.");
			expect(request.type).toBe("thumbnail");
			thumbnailWorker.reply({
				id: request.id,
				type: "error",
				message: "The thumbnail could not be decoded.",
			});

			await expect(rendering).rejects.toThrow("could not be decoded");
			expect(documentWorker.requests).toHaveLength(1);
		} finally {
			queue.dispose();
			await source.dispose();
		}
	});
});

async function openSource(): Promise<Awaited<ReturnType<PdfiumBackend["open"]>>> {
	const opening = new PdfiumBackend().open("brochure.pdf", new AbortController().signal);
	const documentWorker = getWorker(0);
	await vi.waitFor(() => expect(documentWorker.requests).toHaveLength(1));
	const open = documentWorker.requests[0];
	if (open === undefined) throw new Error("The document worker did not open.");
	documentWorker.reply({ id: open.id, type: "opened", pageCount: 2, fileLength: 1024 });
	return opening;
}

function getWorker(index: number): ControlledWorker {
	const worker = ControlledWorker.instances[index];
	if (worker === undefined) throw new Error(`Worker ${index} was not created.`);
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
