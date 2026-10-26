// SPDX-License-Identifier: MIT

import { afterEach, expect, test, vi } from "vitest";

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
		visual: { type: "pixels", width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]).buffer },
	});

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The viewer did not attach its shadow root.");
	await expect.poll(() => shadowRoot.querySelector(".page-frame")).not.toBeNull();
	const thumbnailRequestStart = failedWorker.requests.length;
	shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).not.toBeNull();
	const pageSize = await waitForWorkerRequest(failedWorker, "page-size", thumbnailRequestStart);
	failedWorker.reply({
		id: pageSize.id,
		type: "page-size",
		pageSize: { width: 300, height: 400 },
	});
	const thumbnailRender = await waitForWorkerRequest(failedWorker, "render", thumbnailRequestStart);
	failedWorker.reply({
		id: thumbnailRender.id,
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
	const failedRequestCount = failedWorker.requests.length;
	await Promise.resolve();
	expect(failedWorker.requests).toHaveLength(failedRequestCount);
	const retryButton = shadowRoot.querySelector<HTMLButtonElement>('[role="alert"] button');
	retryButton?.click();
	await expect.poll(() => ControlledWorker.instances.length).toBe(2);
	const recoveredWorker = getControlledWorker(1);
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
		visual: { type: "pixels", width: 1, height: 1, pixels: new Uint8Array([4, 5, 6, 255]).buffer },
	});
	await expect.poll(() => shadowRoot.querySelector(".page-frame")).not.toBeNull();
	await expect.poll(() => shadowRoot.querySelector('[role="alert"]')).toBeNull();

	const recoveredThumbnailRequestStart = recoveredWorker.requests.length;
	shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).not.toBeNull();
	const recoveredPageSize = await waitForWorkerRequest(
		recoveredWorker,
		"page-size",
		recoveredThumbnailRequestStart,
	);
	recoveredWorker.reply({
		id: recoveredPageSize.id,
		type: "page-size",
		pageSize: { width: 300, height: 400 },
	});
	const recoveredThumbnailRender = await waitForWorkerRequest(
		recoveredWorker,
		"render",
		recoveredThumbnailRequestStart,
	);
	recoveredWorker.reply({
		id: recoveredThumbnailRender.id,
		type: "rendered",
		visual: { type: "pixels", width: 1, height: 1, pixels: new Uint8Array([7, 8, 9, 255]).buffer },
	});
	await expect
		.poll(() => shadowRoot.querySelector('.thumbnail-entry[data-page-index="0"] canvas'))
		.not.toBeNull();
	expect(failedWorker.terminateCalls).toBe(1);
	expect(recoveredWorker.terminateCalls).toBe(0);
});
