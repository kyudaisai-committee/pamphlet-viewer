import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { PdfiumBackend } from "@/lib/document/pdfium-backend";
import { calculateFitScale } from "@/lib/domain/navigation/layout";
import type { PamphletViewerElement } from "@/lib/public-api";

import {
	answerPageSizeRequestsUntilRender,
	ControlledWorker,
	getControlledWorker,
	resetControlledWorkers,
	waitForViewerReady,
	waitForWorkerRequest,
	waitForWorkerRequestAcrossInstances,
	waitForWorkerRequestAfterOpening,
} from "./reader-fake-worker";

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	resetControlledWorkers();
});

test("reopens an updated PDF after a fatal range request and renders its new document", async () => {
	const dprDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
	Object.defineProperty(window, "devicePixelRatio", {
		configurable: true,
		value: 2,
	});
	vi.stubGlobal("Worker", ControlledWorker);
	try {
		await import("@/lib/entry");
		const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
		element.style.width = "520px";
		element.style.height = "620px";
		element.layout = "single";
		element.backend = new PdfiumBackend();
		const loadedPageCounts: number[] = [];
		element.addEventListener("documentload", (event) =>
			loadedPageCounts.push(event.detail.pageCount),
		);
		const ready = waitForViewerReady(element);
		document.body.append(element);
		await ready;
		element.src = "./fatal-worker-retry.pdf";

		await expect.poll(() => ControlledWorker.instances.length).toBe(1);
		const documentWorker = getControlledWorker(0);
		const firstOpen = await waitForWorkerRequest(documentWorker, "open");
		documentWorker.reply({
			id: firstOpen.id,
			type: "opened",
			pageCount: 4,
			fileLength: 8192,
		});
		const failedRender = await answerPageSizeRequestsUntilRender(documentWorker);
		failedRender.worker.reply({
			id: failedRender.request.id,
			type: "error",
			message: "The PDF representation changed.",
			fatal: true,
		});
		const retriedRender = await waitForWorkerRequestAfterOpening(
			"render",
			0,
			(request) => request.pageIndex === failedRender.request.pageIndex,
		);
		expect(retriedRender.worker).not.toBe(failedRender.worker);
		retriedRender.worker.reply({
			id: retriedRender.request.id,
			type: "error",
			message: "The PDF representation changed again.",
			fatal: true,
		});

		const shadowRoot = element.shadowRoot;
		if (shadowRoot === null) throw new Error("The viewer did not attach its shadow root.");
		await expect.poll(() => shadowRoot.querySelector('[role="alert"] button')).not.toBeNull();
		element.page = 2;
		const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
		if (zoomSlider === null) throw new Error("The zoom slider was not rendered.");
		zoomSlider.value = "2";
		zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
		await expect.poll(() => zoomSlider.value).toBe("2");
		await expect.poll(() => shadowRoot.querySelector('[role="alert"] button')).not.toBeNull();

		const retryButton = shadowRoot.querySelector<HTMLButtonElement>('[role="alert"] button');
		if (retryButton === null) throw new Error("The retry button was not rendered.");
		const recoveredWorkerStart = ControlledWorker.instances.length;
		await userEvent.click(retryButton);
		await expect
			.poll(() => ControlledWorker.instances.length)
			.toBeGreaterThan(recoveredWorkerStart);
		const recoveredOpenResponse = await waitForWorkerRequestAcrossInstances(
			"open",
			recoveredWorkerStart,
		);
		const recoveredOpenWorker = recoveredOpenResponse.worker;
		const recoveredOpen = recoveredOpenResponse.request;
		expect(recoveredOpen.url).toBe(firstOpen.url);
		recoveredOpenWorker.reply({
			id: recoveredOpen.id,
			type: "opened",
			pageCount: 5,
			fileLength: 10240,
		});
		const recoveredRender = await answerPageSizeRequestsUntilRender(recoveredOpenWorker);
		expect(
			recoveredRender.worker.requests.filter((request) => request.type === "page-size").at(-1)
				?.pageIndex,
		).toBe(1);
		const pageArea = shadowRoot.querySelector<HTMLElement>(".page-area");
		if (pageArea === null) throw new Error("The page area was not rendered.");
		const bounds = pageArea.getBoundingClientRect();
		const expectedRasterScale =
			calculateFitScale(
				[{ width: 300, height: 400 }],
				{ width: bounds.width - 48, height: bounds.height - 48 },
				"page",
				2,
			) * 2;
		expect(recoveredRender.request.pageIndex).toBe(1);
		expect(recoveredRender.request.scale).toBeCloseTo(expectedRasterScale, 4);
		recoveredRender.worker.reply({
			id: recoveredRender.request.id,
			type: "rendered",
			visual: {
				type: "pixels",
				width: 1,
				height: 1,
				pixels: new Uint8Array([38, 42, 105, 255]).buffer,
			},
		});
		await expect
			.poll(() => shadowRoot.querySelector('.page-frame[data-page-index="1"]'))
			.not.toBeNull();
		await expect.poll(() => loadedPageCounts).toEqual([4, 5]);
		const canvas = shadowRoot.querySelector<HTMLCanvasElement>(
			'.page-frame[data-page-index="1"] canvas.page-canvas',
		);
		if (canvas === null) throw new Error("The updated PDF page was not rendered.");
		const renderedPixel = canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data;
		expect(renderedPixel?.[2]).toBe(105);
		expect(failedRender.worker.terminateCalls).toBe(1);
		expect(recoveredRender.worker.terminateCalls).toBe(0);
	} finally {
		if (dprDescriptor === undefined) Reflect.deleteProperty(window, "devicePixelRatio");
		else Object.defineProperty(window, "devicePixelRatio", dprDescriptor);
	}
});
