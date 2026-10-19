import { afterEach, expect, test } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";

interface Point {
	x: number;
	y: number;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

interface RenderTracker {
	renderCalls: number;
	renderScales: number[];
	renderPages: number[];
	holdRenders: boolean;
	pending: Deferred<PageVisual>[];
}

afterEach(() => {
	document.body.replaceChildren();
});

test("toolbar zoom, slider, and reset keep the page-area center in place", async () => {
	await import("../entry");
	const element = createViewer(createBackend());
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = getShadowRoot(element);
	const pageArea = getPageArea(shadowRoot);
	const center = getAreaPoint(pageArea, 0.5, 0.5);
	const initialRatio = measurePageRatio(pageArea, center);
	const initialWidth = getFrame(pageArea).getBoundingClientRect().width;
	shadowRoot.querySelector<HTMLButtonElement>('button[aria-label="拡大"]')?.click();
	await expect.poll(() => readZoom(shadowRoot)).toBe("120%");
	await expect
		.poll(() => getFrame(pageArea).getBoundingClientRect().width)
		.toBeGreaterThan(initialWidth);
	await expect.poll(() => pagePointError(pageArea, center, initialRatio)).toBeLessThanOrEqual(2);

	const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
	if (zoomSlider === null) throw new Error("The zoom slider was not rendered.");
	const widthAtOneHundredTwentyPercent = getFrame(pageArea).getBoundingClientRect().width;
	zoomSlider.value = "2.4";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await expect.poll(() => readZoom(shadowRoot)).toBe("240%");
	await expect
		.poll(() => getFrame(pageArea).getBoundingClientRect().width)
		.toBeGreaterThan(widthAtOneHundredTwentyPercent);
	await expect.poll(() => pagePointError(pageArea, center, initialRatio)).toBeLessThanOrEqual(2);

	const widthAtTwoHundredFortyPercent = getFrame(pageArea).getBoundingClientRect().width;
	shadowRoot.querySelector<HTMLButtonElement>(".reset-zoom")?.click();
	await expect.poll(() => readZoom(shadowRoot)).toBe("100%");
	await expect
		.poll(() => getFrame(pageArea).getBoundingClientRect().width)
		.toBeLessThan(widthAtTwoHundredFortyPercent);
	await expect.poll(() => pagePointError(pageArea, center, initialRatio)).toBeLessThanOrEqual(2);
});

test.each([390, 520, 700])(
	"Ctrl-wheel and pinch zoom preserve the pointer or gesture center in a %i pixel host",
	async (width) => {
		await import("../entry");
		const element = createViewer(createBackend(), width);
		const firstPage = waitForPageChange(element);
		document.body.append(element);
		await firstPage;

		const shadowRoot = getShadowRoot(element);
		const pageArea = getPageArea(shadowRoot);
		const point = getAreaPoint(pageArea, 0.63, 0.55);
		const initialRatio = measurePageRatio(pageArea, point);
		const initialWidth = getFrame(pageArea).getBoundingClientRect().width;
		pageArea.dispatchEvent(createWheel(point, 1, 1.8));
		await expect.poll(() => readZoom(shadowRoot)).toBe("180%");
		await expect
			.poll(() => getFrame(pageArea).getBoundingClientRect().width)
			.toBeGreaterThan(initialWidth);
		await expect.poll(() => pagePointError(pageArea, point, initialRatio)).toBeLessThanOrEqual(2);

		const pinchStartRatio = measurePageRatio(pageArea, point);
		const widthBeforePinch = getFrame(pageArea).getBoundingClientRect().width;
		pageArea.dispatchEvent(createPointerEvent("pointerdown", 1, point.x - 30, point.y, "touch"));
		pageArea.dispatchEvent(createPointerEvent("pointerdown", 2, point.x + 30, point.y, "touch"));
		pageArea.dispatchEvent(createPointerEvent("pointermove", 1, point.x - 45, point.y, "touch"));
		pageArea.dispatchEvent(createPointerEvent("pointermove", 2, point.x + 45, point.y, "touch"));
		pageArea.dispatchEvent(createPointerEvent("pointerup", 1, point.x - 45, point.y, "touch"));
		pageArea.dispatchEvent(createPointerEvent("pointerup", 2, point.x + 45, point.y, "touch"));
		await expect.poll(() => readZoom(shadowRoot)).toBe("270%");
		await expect
			.poll(() => getFrame(pageArea).getBoundingClientRect().width)
			.toBeGreaterThan(widthBeforePinch);
		await expect
			.poll(() => pagePointError(pageArea, point, pinchStartRatio))
			.toBeLessThanOrEqual(2);
	},
);

test("a stale zoom render cannot consume the latest zoom anchor", async () => {
	await import("../entry");
	const tracker: RenderTracker = {
		renderCalls: 0,
		renderScales: [],
		renderPages: [],
		holdRenders: false,
		pending: [],
	};
	const element = createViewer(createBackend(tracker));
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	let pageChangeEvents = 0;
	element.addEventListener("pagechange", () => {
		pageChangeEvents += 1;
	});

	const shadowRoot = getShadowRoot(element);
	const pageArea = getPageArea(shadowRoot);
	const widthAtOneHundredPercent = getFrame(pageArea).getBoundingClientRect().width;
	const center = getAreaPoint(pageArea, 0.5, 0.5);
	const ratioAtOneHundredPercent = measurePageRatio(pageArea, center);
	const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
	if (zoomSlider === null) throw new Error("The zoom slider was not rendered.");
	zoomSlider.value = "2";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await expect.poll(() => readZoom(shadowRoot)).toBe("200%");
	await expect.poll(() => tracker.renderCalls).toBe(2);
	await expect
		.poll(() => getFrame(pageArea).getBoundingClientRect().width)
		.toBeGreaterThan(widthAtOneHundredPercent);
	await expect
		.poll(() => pagePointError(pageArea, center, ratioAtOneHundredPercent))
		.toBeLessThanOrEqual(2);
	tracker.holdRenders = true;

	const firstPointer = getAreaPoint(pageArea, 0.35, 0.4);
	pageArea.dispatchEvent(createWheel(firstPointer, 2, 3));
	await expect.poll(() => readZoom(shadowRoot)).toBe("300%");
	await expect.poll(() => tracker.renderCalls).toBeGreaterThanOrEqual(3);
	const latestPointer = getAreaPoint(pageArea, 0.65, 0.62);
	const expectedLatestRatio = measurePageRatio(pageArea, latestPointer);
	pageArea.dispatchEvent(createWheel(latestPointer, 3, 4));
	await expect.poll(() => readZoom(shadowRoot)).toBe("400%");
	const scrollBeforeStaleCompletion = { left: pageArea.scrollLeft, top: pageArea.scrollTop };
	const widthBeforeStaleCompletion = getFrame(pageArea).getBoundingClientRect().width;

	const staleRender = tracker.pending[0];
	if (staleRender === undefined) throw new Error("The stale zoom render was not deferred.");
	const callsBeforeStaleResolution = tracker.renderCalls;
	staleRender.resolve(pixelVisual());
	await expect.poll(() => tracker.renderCalls).toBeGreaterThan(callsBeforeStaleResolution);
	expect(pageArea.scrollLeft).toBe(scrollBeforeStaleCompletion.left);
	expect(pageArea.scrollTop).toBe(scrollBeforeStaleCompletion.top);
	expect(getFrame(pageArea).getBoundingClientRect().width).toBe(widthBeforeStaleCompletion);

	let resolvedRenderIndex = 1;
	const fourHundredPercentWidth = widthAtOneHundredPercent * 3.5;
	while (getFrame(pageArea).getBoundingClientRect().width <= fourHundredPercentWidth) {
		const latestRender = tracker.pending[resolvedRenderIndex];
		if (latestRender === undefined) throw new Error("The latest zoom render was not deferred.");
		const callsBeforeResolution = tracker.renderCalls;
		latestRender.resolve(pixelVisual());
		resolvedRenderIndex += 1;
		await expect
			.poll(
				() =>
					getFrame(pageArea).getBoundingClientRect().width > fourHundredPercentWidth ||
					tracker.renderCalls > callsBeforeResolution,
			)
			.toBe(true);
	}
	expect(getFrame(pageArea).getBoundingClientRect().width).toBeGreaterThan(fourHundredPercentWidth);
	expect(tracker.renderScales.at(-1)).toBeGreaterThan((tracker.renderScales[1] ?? 0) * 1.75);
	expect(tracker.renderPages.every((renderedPage) => renderedPage === 0)).toBe(true);
	await expect
		.poll(() => pagePointError(pageArea, latestPointer, expectedLatestRatio))
		.toBeLessThanOrEqual(2);
	expect(pageChangeEvents).toBe(0);
});

function createViewer(backend: DocumentBackend, width = 520): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = `${width}px`;
	element.style.height = "620px";
	element.layout = "single";
	element.backend = backend;
	element.src = "./zoom-test.pdf";
	return element;
}

function createBackend(tracker?: RenderTracker): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount: 1,
				async getPageSize() {
					return { width: 300, height: 400 };
				},
				async renderPage(pageIndex, scale) {
					if (tracker === undefined) return pixelVisual();
					tracker.renderCalls += 1;
					tracker.renderScales.push(scale);
					tracker.renderPages.push(pageIndex);
					if (!tracker.holdRenders) return pixelVisual();
					const pending = createDeferred<PageVisual>();
					tracker.pending.push(pending);
					return pending.promise;
				},
				dispose() {},
			};
		},
	};
}

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new Uint8Array([70, 80, 90, 255]).buffer };
}

function getShadowRoot(element: PamphletViewerElement): ShadowRoot {
	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The viewer did not attach its shadow root.");
	return shadowRoot;
}

function getPageArea(shadowRoot: ShadowRoot): HTMLElement {
	const pageArea = shadowRoot.querySelector<HTMLElement>(".page-area");
	if (pageArea === null) throw new Error("The page area was not rendered.");
	return pageArea;
}

function getFrame(pageArea: HTMLElement): HTMLElement {
	const frame = pageArea.querySelector<HTMLElement>(".page-frame");
	if (frame === null) throw new Error("The page frame was not rendered.");
	return frame;
}

function getAreaPoint(pageArea: HTMLElement, xRatio: number, yRatio: number): Point {
	const bounds = pageArea.getBoundingClientRect();
	return { x: bounds.left + bounds.width * xRatio, y: bounds.top + bounds.height * yRatio };
}

function measurePageRatio(pageArea: HTMLElement, point: Point): Point {
	const bounds = getFrame(pageArea).getBoundingClientRect();
	return { x: (point.x - bounds.left) / bounds.width, y: (point.y - bounds.top) / bounds.height };
}

function pagePointError(pageArea: HTMLElement, point: Point, expectedRatio: Point): number {
	const frame = getFrame(pageArea).getBoundingClientRect();
	const actualRatio = measurePageRatio(pageArea, point);
	return Math.max(
		Math.abs(actualRatio.x - expectedRatio.x) * frame.width,
		Math.abs(actualRatio.y - expectedRatio.y) * frame.height,
	);
}

function createWheel(point: Point, currentZoom: number, nextZoom: number): WheelEvent {
	return new WheelEvent("wheel", {
		bubbles: true,
		cancelable: true,
		ctrlKey: true,
		deltaY: -Math.log(nextZoom / currentZoom) / 0.002,
		clientX: point.x,
		clientY: point.y,
	});
}

function createPointerEvent(
	type: string,
	pointerId: number,
	clientX: number,
	clientY: number,
	pointerType: string,
): PointerEvent {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId,
		pointerType,
		clientX,
		clientY,
	});
}

function readZoom(shadowRoot: ShadowRoot): string | null {
	return shadowRoot.querySelector(".zoom-level")?.textContent ?? null;
}

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}
