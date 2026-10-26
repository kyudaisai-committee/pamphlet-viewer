import { afterEach, expect, test, vi } from "vitest";

import type { PageSource } from "@/lib/document/page-source";
import { PdfiumBackend } from "@/lib/document/pdfium-backend";
import type { PamphletViewerElement } from "@/lib/public-api";

import {
	answerPageSizeRequestsUntilRender,
	ControlledWorker,
	getControlledWorker,
	resetControlledWorkers,
	waitForViewerReady,
	waitForWorkerRequestAcrossInstances,
	waitForWorkerRequest,
	waitForWorkerRequestAfterOpening,
} from "./reader-fake-worker";

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	resetControlledWorkers();
});

test("recovers from a thumbnail worker failure in the narrow reader", async () => {
	vi.stubGlobal("Worker", ControlledWorker);
	await import("../entry");
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "390px";
	element.style.height = "620px";
	element.layout = "single";
	element.backend = new PdfiumBackend();
	const ready = waitForViewerReady(element);
	document.body.append(element);
	await ready;
	element.src = "./thumbnail-worker-failure.pdf";

	await expect.poll(() => ControlledWorker.instances.length).toBe(1);
	const documentWorker = getControlledWorker(0);
	const firstOpen = await waitForWorkerRequest(documentWorker, "open");
	documentWorker.reply({
		id: firstOpen.id,
		type: "opened",
		pageCount: 4,
		fileLength: 8192,
	});
	const mainRender = await answerPageSizeRequestsUntilRender(documentWorker);
	mainRender.worker.reply({
		id: mainRender.request.id,
		type: "rendered",
		visual: {
			type: "pixels",
			width: 1,
			height: 1,
			pixels: new Uint8Array([1, 2, 3, 255]).buffer,
		},
	});

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The viewer did not attach its shadow root.");
	await expect.poll(() => shadowRoot.querySelector(".page-frame")).not.toBeNull();
	shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).not.toBeNull();
	const unavailableThumbnailRequest = await waitForWorkerRequestAfterOpening("thumbnail");
	const failedThumbnailWorker = unavailableThumbnailRequest.worker;
	const unavailableThumbnail = unavailableThumbnailRequest.request;
	failedThumbnailWorker.reply({
		id: unavailableThumbnail.id,
		type: "error",
		message: "The thumbnail worker trapped.",
		fatal: true,
	});
	const retriedThumbnailRequest = await waitForWorkerRequestAfterOpening(
		"thumbnail",
		0,
		(request) => request.pageIndex === unavailableThumbnail.pageIndex,
	);
	expect(retriedThumbnailRequest.worker).not.toBe(failedThumbnailWorker);
	retriedThumbnailRequest.worker.reply({
		id: retriedThumbnailRequest.request.id,
		type: "error",
		message: "The recovered thumbnail worker trapped.",
		fatal: true,
	});

	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).toBeNull();
	await expect.poll(() => shadowRoot.querySelector('[role="alert"] button')).not.toBeNull();
	const retryButtonBounds = shadowRoot
		.querySelector<HTMLButtonElement>('[role="alert"] button')
		?.getBoundingClientRect();
	expect(retryButtonBounds?.width).toBeGreaterThan(0);
	expect(retryButtonBounds?.height).toBeGreaterThan(0);
	const failedRequestCount = failedThumbnailWorker.requests.length;
	await Promise.resolve();
	expect(failedThumbnailWorker.requests).toHaveLength(failedRequestCount);
	const retryButton = shadowRoot.querySelector<HTMLButtonElement>('[role="alert"] button');
	const recoveredWorkerStart = ControlledWorker.instances.length;
	retryButton?.click();
	await expect
		.poll(() => ControlledWorker.instances.length)
		.toBeGreaterThan(recoveredWorkerStart);
	const recoveredOpenResponse = await waitForWorkerRequestAcrossInstances(
		"open",
		recoveredWorkerStart,
	);
	const recoveredDocumentWorker = recoveredOpenResponse.worker;
	const recoveredOpen = recoveredOpenResponse.request;
	expect(recoveredOpen.url).toBe(firstOpen.url);
	recoveredDocumentWorker.reply({
		id: recoveredOpen.id,
		type: "opened",
		pageCount: 4,
		fileLength: 8192,
	});
	const recoveredMainRender = await answerPageSizeRequestsUntilRender(recoveredDocumentWorker);
	recoveredMainRender.worker.reply({
		id: recoveredMainRender.request.id,
		type: "rendered",
		visual: {
			type: "pixels",
			width: 1,
			height: 1,
			pixels: new Uint8Array([4, 5, 6, 255]).buffer,
		},
	});
	await expect.poll(() => shadowRoot.querySelector(".page-frame")).not.toBeNull();
	await expect.poll(() => shadowRoot.querySelector('[role="alert"]')).toBeNull();

	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).toBeNull();
	await expect.poll(() => shadowRoot.querySelector('[role="alert"]')).toBeNull();
	expect(failedThumbnailWorker.terminateCalls).toBe(1);
	expect(recoveredMainRender.worker.terminateCalls).toBe(0);
});

test("uses the document worker for embedded thumbnail prefetch", async () => {
	vi.stubGlobal("Worker", ControlledWorker);
	const abortController = new AbortController();
	let source: PageSource | null = null;
	try {
		const opening = new PdfiumBackend().open(
			new URL("./thumbnail-open-retry.pdf", window.location.href).href,
			abortController.signal,
		);
		const documentWorker = getControlledWorker(0);
		const documentOpen = await waitForWorkerRequest(documentWorker, "open");
		documentWorker.reply({
			id: documentOpen.id,
			type: "opened",
			pageCount: 1,
			fileLength: 4096,
		});
		source = await opening;
		if (source.prefetchThumbnail === undefined) {
			throw new Error("The PDF source does not support embedded thumbnail prefetch.");
		}

		await expect(source.prefetchThumbnail(0)).resolves.toBeNull();
		expect(
			documentWorker.requests.some((request) => request.type === "thumbnail-prefetch"),
		).toBe(true);
		expect(ControlledWorker.instances).toHaveLength(1);
	} finally {
		source?.dispose();
		abortController.abort();
	}
});
