import { afterEach, expect, test, vi } from "vitest";

import type { PageSource } from "../document/page-source";
import { PdfiumBackend } from "../document/pdfium-backend";
import type { PamphletViewerElement } from "../public-api";
import {
	answerPageSizeRequestsUntilRender,
	ControlledWorker,
	getControlledWorker,
	resetControlledWorkers,
	waitForViewerReady,
	waitForWorkerRequest,
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
	const failedWorker = getControlledWorker(0);
	const firstOpen = await waitForWorkerRequest(failedWorker, "open");
	failedWorker.reply({ id: firstOpen.id, type: "opened", pageCount: 4, fileLength: 8192 });
	const mainRender = await answerPageSizeRequestsUntilRender(failedWorker);
	failedWorker.reply({
		id: mainRender.id,
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
	await expect.poll(() => ControlledWorker.instances.length).toBe(2);
	const failedThumbnailWorker = getControlledWorker(1);
	const failedThumbnailOpen = await waitForWorkerRequest(failedThumbnailWorker, "open");
	failedThumbnailWorker.reply({
		id: failedThumbnailOpen.id,
		type: "opened",
		pageCount: 4,
		fileLength: 8192,
	});
	const unavailableThumbnail = await waitForWorkerRequest(failedThumbnailWorker, "thumbnail");
	failedThumbnailWorker.reply({
		id: unavailableThumbnail.id,
		type: "error",
		message: "The thumbnail worker trapped.",
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
	retryButton?.click();
	await expect.poll(() => ControlledWorker.instances.length).toBe(3);
	const recoveredWorker = getControlledWorker(2);
	const recoveredOpen = await waitForWorkerRequest(recoveredWorker, "open");
	expect(recoveredOpen.url).toBe(firstOpen.url);
	recoveredWorker.reply({
		id: recoveredOpen.id,
		type: "opened",
		pageCount: 4,
		fileLength: 8192,
	});
	const recoveredMainRender = await answerPageSizeRequestsUntilRender(recoveredWorker);
	recoveredWorker.reply({
		id: recoveredMainRender.id,
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
	expect(recoveredWorker.terminateCalls).toBe(0);
});

test("recreates the thumbnail worker after a transient open failure", async () => {
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

		const failedPrefetch = source.prefetchThumbnail(0);
		const failedThumbnailWorker = getControlledWorker(1);
		const failedOpen = await waitForWorkerRequest(failedThumbnailWorker, "open");
		failedThumbnailWorker.reply({
			id: failedOpen.id,
			type: "error",
			message: "The thumbnail source is temporarily unavailable.",
		});
		await expect(failedPrefetch).rejects.toThrow("temporarily unavailable");

		const retriedPrefetch = source.prefetchThumbnail(0);
		const recoveredThumbnailWorker = getControlledWorker(2);
		const recoveredOpen = await waitForWorkerRequest(recoveredThumbnailWorker, "open");
		recoveredThumbnailWorker.reply({
			id: recoveredOpen.id,
			type: "opened",
			pageCount: 1,
			fileLength: 4096,
		});
		const prefetch = await waitForWorkerRequest(recoveredThumbnailWorker, "thumbnail-prefetch");
		recoveredThumbnailWorker.reply({
			id: prefetch.id,
			type: "thumbnail-prefetch",
			visual: null,
		});
		await expect(retriedPrefetch).resolves.toBeNull();
		expect(failedThumbnailWorker.terminateCalls).toBe(1);
		expect(recoveredThumbnailWorker.terminateCalls).toBe(0);
	} finally {
		source?.dispose();
		abortController.abort();
	}
});
