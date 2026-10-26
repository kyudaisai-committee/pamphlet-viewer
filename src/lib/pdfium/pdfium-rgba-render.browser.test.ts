import { expect, test, vi } from "vitest";

import type { PageVisual } from "../document/page-source";
import { PdfiumBackend } from "../document/pdfium-backend";
import { PdfiumWorkerClient } from "./worker-client";

test("renders RGBA channels, alpha, white background, and an independent pixel buffer", async () => {
	const worker = new PdfiumWorkerClient();
	try {
		const url = new URL("/__pdfium-range-fixture.pdf", window.location.href).href;
		const info = await worker.open(url);
		const firstPage = await worker.renderPage(0, 1);
		if (firstPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");

		expect(info.pageCount).toBe(24);
		expect(firstPage.width).toBe(300);
		expect(firstPage.height).toBe(400);
		expectPixelColor(firstPage, 150, 200, "blue");
		expectPixelAlpha(firstPage, 150, 200);
		expectPixelColor(firstPage, 0, 0, "white");
		expectPixelAlpha(firstPage, 0, 0);
		const firstPageBytes = Array.from(new Uint8Array(firstPage.pixels));

		const laterPage = await worker.renderPage(info.pageCount - 1, 1);
		if (laterPage.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
		expectPixelColor(laterPage, 150, 200, "red");
		expect(Array.from(new Uint8Array(firstPage.pixels))).toEqual(firstPageBytes);
	} finally {
		worker.terminate();
	}
}, 120_000);

test("keeps RGBA channels and alpha on rotated CropBox pages", async () => {
	const worker = new PdfiumWorkerClient();
	try {
		const url = new URL("/__rotated-crop-range-fixture.pdf", window.location.href).href;
		const info = await worker.open(url);
		const pageSize = await worker.getPageSize(0);
		const visual = await worker.renderPage(0, 1);
		if (visual.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");

		expect(info.pageCount).toBe(24);
		expect(pageSize).toEqual({ width: 300, height: 200 });
		expect(visual.width).toBe(pageSize.width);
		expect(visual.height).toBe(pageSize.height);
		expectPixelColor(visual, 150, 100, "blue");
		expectPixelAlpha(visual, 150, 100);
	} finally {
		worker.terminate();
	}
}, 120_000);

test("renders visible spread pages and adjacent pages in independent PDFium workers", async () => {
	const url = new URL("/__pdfium-range-fixture.pdf", window.location.href).href;
	const source = await new PdfiumBackend().open(url, new AbortController().signal);
	try {
		const [left, right, adjacent] = await Promise.all([
			source.renderPage(0, 1),
			source.renderPage(1, 1),
			source.renderPrefetchedPage(23, 1),
		]);
		expectPixelColor(left, 150, 200, "blue");
		expectPixelColor(right, 150, 200, "blue");
		expectPixelColor(adjacent, 150, 200, "red");
	} finally {
		await source.dispose();
	}
}, 120_000);

test("finishes visible renders while an unrelated adjacent PDFium worker remains pending", async () => {
	RenderWorker.instances = [];
	vi.stubGlobal("Worker", RenderWorker);
	let source: Awaited<ReturnType<PdfiumBackend["open"]>> | null = null;
	try {
		source = await new PdfiumBackend().open(
			"https://example.test/brochure.pdf",
			new AbortController().signal,
		);
		let backgroundCompleted = false;
		const backgroundRender = source.renderPrefetchedPage(23, 1).then(() => {
			backgroundCompleted = true;
		});
		await vi.waitFor(() =>
			expect(getRenderRequest(RenderWorker.instances[1], 23)).toBeDefined(),
		);

		const firstVisibleRender = source.renderPage(0, 1);
		const secondVisibleRender = source.renderPage(1, 1);
		await vi.waitFor(() =>
			expect(getRenderRequest(RenderWorker.instances[0], 0)).toBeDefined(),
		);
		await vi.waitFor(() =>
			expect(getRenderRequest(RenderWorker.instances[2], 1)).toBeDefined(),
		);
		replyToRender(RenderWorker.instances[0], 0);
		replyToRender(RenderWorker.instances[2], 1);
		await Promise.all([firstVisibleRender, secondVisibleRender]);
		expect(backgroundCompleted).toBe(false);

		replyToRender(RenderWorker.instances[1], 23);
		await backgroundRender;
	} finally {
		await source?.dispose();
		vi.unstubAllGlobals();
	}
});

interface RenderWorkerRequest {
	id: number;
	type: string;
	pageIndex?: number;
}

class RenderWorker extends EventTarget {
	static instances: RenderWorker[] = [];
	readonly requests: RenderWorkerRequest[] = [];

	constructor() {
		super();
		RenderWorker.instances.push(this);
	}

	postMessage(message: unknown): void {
		if (!isRenderWorkerRequest(message)) throw new Error("Unexpected PDFium worker request.");
		if (message.type === "open") {
			this.reply({
				id: message.id,
				type: "opened",
				pageCount: 24,
				fileLength: 1024,
			});
			return;
		}
		this.requests.push(message);
	}

	terminate(): void {}

	reply(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
}

function isRenderWorkerRequest(value: unknown): value is RenderWorkerRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as { id?: unknown; type?: unknown; pageIndex?: unknown };
	return (
		typeof request.id === "number" &&
		typeof request.type === "string" &&
		(request.pageIndex === undefined || typeof request.pageIndex === "number")
	);
}

function getRenderRequest(
	worker: RenderWorker | undefined,
	pageIndex: number,
): RenderWorkerRequest | undefined {
	return worker?.requests.find(
		(request) => request.type === "render" && request.pageIndex === pageIndex,
	);
}

function replyToRender(worker: RenderWorker | undefined, pageIndex: number): void {
	const request = getRenderRequest(worker, pageIndex);
	if (worker === undefined || request === undefined) {
		throw new Error(`No PDFium render request was found for page ${pageIndex}.`);
	}
	worker.reply({ id: request.id, type: "rendered", visual: pixelVisual() });
}

function expectPixelAlpha(visual: PageVisual, x: number, y: number): void {
	if (visual.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
	expect(pixelAt(visual, x, y)[3]).toBe(255);
}

function expectPixelColor(
	visual: PageVisual,
	x: number,
	y: number,
	color: "blue" | "red" | "white",
): void {
	if (visual.type !== "pixels") throw new Error("PDFium should render a pixel buffer.");
	const [red, green, blue] = pixelAt(visual, x, y);
	if (color === "blue") {
		expect(red).toBeLessThan(80);
		expect(green).toBeGreaterThan(50);
		expect(blue).toBeGreaterThan(150);
	} else if (color === "red") {
		expect(red).toBeGreaterThan(200);
		expect(green).toBeLessThan(60);
		expect(blue).toBeLessThan(80);
	} else {
		expect(red).toBeGreaterThan(240);
		expect(green).toBeGreaterThan(240);
		expect(blue).toBeGreaterThan(240);
	}
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}

function pixelAt(visual: Extract<PageVisual, { type: "pixels" }>, x: number, y: number): number[] {
	const offset = (y * visual.width + x) * 4;
	return Array.from(new Uint8Array(visual.pixels, offset, 4));
}
