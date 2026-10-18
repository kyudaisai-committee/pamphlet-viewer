import { afterEach, expect, test, vi } from "vitest";

import { PdfiumBackend } from "../document/pdfium-backend";
import { calculateFitScale } from "../domain/layout";
import type { PamphletViewerElement } from "../public-api";

interface WorkerRequest {
	id: number;
	type: string;
	url?: string;
	pageIndex?: number;
	scale?: number;
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
		if (!isWorkerRequest(message)) throw new Error("The viewer sent an invalid worker request.");
		this.requests.push(message);
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	reply(message: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: message }));
	}
}

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	ControlledWorker.instances = [];
});

test("retries a fatal PDF worker through the viewer and restores page, zoom, and DPR", async () => {
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
		const ready = waitForReady(element);
		document.body.append(element);
		await ready;
		element.src = "./fatal-worker-retry.pdf";

		await expect.poll(() => ControlledWorker.instances.length).toBe(1);
		const failedWorker = getWorker(0);
		const firstOpen = await waitForRequest(failedWorker, "open");
		failedWorker.reply({ id: firstOpen.id, type: "opened", pageCount: 4, fileLength: 8192 });
		const failedRender = await answerPageSizeRequestsUntilRender(failedWorker);
		failedWorker.reply({
			id: failedRender.id,
			type: "error",
			message: "The PDF worker trapped.",
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

		shadowRoot.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
		await expect.poll(() => ControlledWorker.instances.length).toBe(2);
		const recoveredWorker = getWorker(1);
		const recoveredOpen = await waitForRequest(recoveredWorker, "open");
		expect(recoveredOpen.url).toBe(firstOpen.url);
		recoveredWorker.reply({
			id: recoveredOpen.id,
			type: "opened",
			pageCount: 4,
			fileLength: 8192,
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
				pixels: new Uint8Array([38, 42, 45, 255]).buffer,
			},
		});
		await expect
			.poll(() => shadowRoot.querySelector('.page-frame[data-page-index="1"]'))
			.not.toBeNull();
		expect(failedWorker.terminateCalls).toBe(1);
		expect(recoveredWorker.terminateCalls).toBe(0);
	} finally {
		if (dprDescriptor === undefined) Reflect.deleteProperty(window, "devicePixelRatio");
		else Object.defineProperty(window, "devicePixelRatio", dprDescriptor);
	}
});

async function waitForRequest(worker: ControlledWorker, type: string): Promise<WorkerRequest> {
	let request: WorkerRequest | undefined;
	try {
		await expect
			.poll(() => {
				request = worker.requests.find((candidate) => candidate.type === type);
				return request !== undefined;
			})
			.toBe(true);
	} catch (error) {
		throw new Error(
			`The ${type} request was not sent; received ${JSON.stringify(worker.requests)}.`,
			{ cause: error },
		);
	}
	if (request === undefined) throw new Error(`The ${type} request was not sent.`);
	return request;
}

async function answerPageSizeRequestsUntilRender(worker: ControlledWorker): Promise<WorkerRequest> {
	const handledRequestIds = new Set<number>();
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const nextPageSize = worker.requests.find(
			(request) => request.type === "page-size" && !handledRequestIds.has(request.id),
		);
		if (nextPageSize !== undefined) {
			handledRequestIds.add(nextPageSize.id);
			worker.reply({
				id: nextPageSize.id,
				type: "page-size",
				pageSize: { width: 300, height: 400 },
			});
			continue;
		}
		const render = worker.requests.find((request) => request.type === "render");
		if (render !== undefined) return render;
		await expect
			.poll(() =>
				worker.requests.some(
					(request) =>
						request.type === "render" ||
						(request.type === "page-size" && !handledRequestIds.has(request.id)),
				),
			)
			.toBe(true);
	}
	throw new Error(
		`Render did not start after page-size responses: ${JSON.stringify(worker.requests)}.`,
	);
}

function waitForReady(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("ready", () => resolve(), { once: true }),
	);
}

function getWorker(index: number): ControlledWorker {
	const worker = ControlledWorker.instances[index];
	if (worker === undefined) throw new Error(`Worker ${index} was not created.`);
	return worker;
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "number" &&
		"type" in value &&
		typeof value.type === "string" &&
		(!("url" in value) || typeof value.url === "string") &&
		(!("pageIndex" in value) || typeof value.pageIndex === "number") &&
		(!("scale" in value) || typeof value.scale === "number")
	);
}
