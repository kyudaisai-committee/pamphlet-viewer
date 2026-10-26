import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { PdfiumBackend } from "../document/pdfium-backend";
import { calculateFitScale } from "../domain/layout";
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

test("reopens an updated PDF after a fatal range request and renders its new document", async () => {
	const dprDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
	Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
	vi.stubGlobal("Worker", ControlledWorker);
	try {
		await import("../entry");
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
		const failedWorker = getControlledWorker(0);
		const firstOpen = await waitForWorkerRequest(failedWorker, "open");
		failedWorker.reply({ id: firstOpen.id, type: "opened", pageCount: 4, fileLength: 8192 });
		const failedRender = await answerPageSizeRequestsUntilRender(failedWorker);
		failedWorker.reply({
			id: failedRender.id,
			type: "error",
			message: "The PDF representation changed.",
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
		await userEvent.click(retryButton);
		await expect.poll(() => ControlledWorker.instances.length).toBeGreaterThan(1);
		const recoveredWorker = ControlledWorker.instances.at(-1);
		if (recoveredWorker === undefined)
			throw new Error("The recovered page worker was not created.");
		const recoveredOpen = await waitForWorkerRequest(recoveredWorker, "open");
		expect(recoveredOpen.url).toBe(firstOpen.url);
		recoveredWorker.reply({
			id: recoveredOpen.id,
			type: "opened",
			pageCount: 5,
			fileLength: 10240,
		});
		const recoveredRender = await answerPageSizeRequestsUntilRender(recoveredWorker);
		expect(
			recoveredWorker.requests.filter((request) => request.type === "page-size").at(-1)?.pageIndex,
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
		expect(recoveredRender.pageIndex).toBe(1);
		expect(recoveredRender.scale).toBeCloseTo(expectedRasterScale, 4);
		recoveredWorker.reply({
			id: recoveredRender.id,
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
		expect(failedWorker.terminateCalls).toBe(1);
		expect(recoveredWorker.terminateCalls).toBe(0);
	} finally {
		if (dprDescriptor === undefined) Reflect.deleteProperty(window, "devicePixelRatio");
		else Object.defineProperty(window, "devicePixelRatio", dprDescriptor);
	}
});
