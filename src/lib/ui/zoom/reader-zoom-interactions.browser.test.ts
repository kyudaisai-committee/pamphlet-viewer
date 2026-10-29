import { afterEach, beforeEach, expect, test } from "vitest";
import { page as browserPage } from "vitest/browser";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";
import type { PamphletViewerElement } from "@/lib/public-api";

import { ZOOM_RENDER_DELAY_MS } from "./zoom-render-scheduler";

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
	completedRenders: number;
	renderScales: number[];
	renderPages: number[];
	holdRenders: boolean;
	pending: Deferred<PageVisual>[];
}

beforeEach(async () => {
	await browserPage.viewport(1280, 900);
});

afterEach(async () => {
	document.body.replaceChildren();
	await browserPage.viewport(1280, 900);
});

test("toolbar zoom, slider, and reset keep the page-area center in place", async () => {
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

test("keeps a page assigned synchronously by a pagechange listener", async () => {
	const element = createViewer(createBackend(undefined, 3));
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const pageChanges: number[] = [];
	element.addEventListener("pagechange", (event) => {
		pageChanges.push(event.detail.page);
		if (event.detail.page === 2) element.page = 3;
	});

	const shadowRoot = getShadowRoot(element);
	const nextButton = shadowRoot.querySelector<HTMLButtonElement>(
		'button[aria-label="次のページ"]',
	);
	if (nextButton === null) throw new Error("The next-page button was not rendered.");
	nextButton.click();

	await expect.poll(() => pageChanges).toEqual([2, 3]);
	await expect.poll(() => element.page).toBe(3);
	await expect.poll(() => element.getAttribute("page")).toBe("3");
	await expect.poll(() => getFrame(getPageArea(shadowRoot)).dataset.pageIndex).toBe("2");
});

test.each([390, 520, 700])(
	"Ctrl-wheel and pinch zoom preserve the pointer or gesture center in a %i pixel host",
	async (width) => {
		const element = createViewer(createBackend(), width);
		const firstPage = waitForPageChange(element);
		document.body.append(element);
		await firstPage;

		const shadowRoot = getShadowRoot(element);
		const pageArea = getPageArea(shadowRoot);
		const point = getAreaPoint(pageArea, 0.63, 0.55);
		const initialRatio = measurePageRatio(pageArea, point);
		const initialWidth = getFrame(pageArea).getBoundingClientRect().width;
		const ordinaryWheel = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: 100,
			clientX: point.x,
			clientY: point.y,
		});
		pageArea.dispatchEvent(ordinaryWheel);
		expect(ordinaryWheel.defaultPrevented).toBe(false);
		expect(readZoom(shadowRoot)).toBe("100%");

		const pinchWheel = createWheel(point, 1, 1.8);
		pageArea.dispatchEvent(pinchWheel);
		expect(pinchWheel.defaultPrevented).toBe(true);
		await expect.poll(() => readZoom(shadowRoot)).toBe("180%");
		await expect
			.poll(() => getFrame(pageArea).getBoundingClientRect().width)
			.toBeGreaterThan(initialWidth);
		await expect
			.poll(() => pagePointError(pageArea, point, initialRatio))
			.toBeLessThanOrEqual(2);

		const pinchStartRatio = measurePageRatio(pageArea, point);
		const widthBeforePinch = getFrame(pageArea).getBoundingClientRect().width;
		pageArea.dispatchEvent(
			createPointerEvent("pointerdown", 1, point.x - 30, point.y, "touch"),
		);
		pageArea.dispatchEvent(
			createPointerEvent("pointerdown", 2, point.x + 30, point.y, "touch"),
		);
		pageArea.dispatchEvent(
			createPointerEvent("pointermove", 1, point.x - 45, point.y, "touch"),
		);
		pageArea.dispatchEvent(
			createPointerEvent("pointermove", 2, point.x + 45, point.y, "touch"),
		);
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

test("zoom previews immediately and coalesces deferred raster work at the latest zoom", async () => {
	const tracker: RenderTracker = {
		renderCalls: 0,
		completedRenders: 0,
		renderScales: [],
		renderPages: [],
		holdRenders: false,
		pending: [],
	};
	const element = createViewer(createBackend(tracker));
	element.style.height = "1000px";
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
	const initialRenderScale = tracker.renderScales[0];
	if (initialRenderScale === undefined)
		throw new Error("The initial page render was not recorded.");
	tracker.holdRenders = true;

	const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
	if (zoomSlider === null) throw new Error("The zoom slider was not rendered.");
	const sliderAnchor = getAreaPoint(pageArea, 0.5, 0.5);
	const initialRatio = measurePageRatio(pageArea, sliderAnchor);
	for (const value of ["2", "2.8", "3.2", "4"]) {
		zoomSlider.value = value;
		zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	}
	await flushUi();
	expect(readZoom(shadowRoot)).toBe("400%");
	expect(getFrame(pageArea).getBoundingClientRect().width).toBeGreaterThan(
		widthAtOneHundredPercent * 3.5,
	);
	expect(pagePointError(pageArea, sliderAnchor, initialRatio)).toBeLessThanOrEqual(2);
	expect(tracker.renderCalls).toBe(1);

	await expect.poll(() => tracker.renderCalls).toBe(2);
	expect(tracker.pending).toHaveLength(1);
	expect(tracker.renderScales[1]).toBeGreaterThan(initialRenderScale * 3.5);
	expect(tracker.renderPages).toEqual([0, 0]);

	const latestRender = tracker.pending[0];
	if (latestRender === undefined) throw new Error("The latest zoom render was not deferred.");
	latestRender.resolve(pixelVisual());
	await flushUi();
	expect(getFrame(pageArea).getBoundingClientRect().width).toBeGreaterThan(
		widthAtOneHundredPercent * 3.5,
	);
	await expect
		.poll(() => pagePointError(pageArea, sliderAnchor, initialRatio))
		.toBeLessThanOrEqual(2);
	expect(pageChangeEvents).toBe(0);
});

test.each(["drag", "wheel"] as const)(
	"a %s scroll during deferred zoom rendering keeps the user's latest viewport position",
	async (interaction) => {
		const tracker: RenderTracker = {
			renderCalls: 0,
			completedRenders: 0,
			renderScales: [],
			renderPages: [],
			holdRenders: false,
			pending: [],
		};
		const element = createViewer(createBackend(tracker));
		element.style.height = "1000px";
		const firstPage = waitForPageChange(element);
		document.body.append(element);
		await firstPage;
		tracker.holdRenders = true;

		const shadowRoot = getShadowRoot(element);
		const pageArea = getPageArea(shadowRoot);
		const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
		if (zoomSlider === null) throw new Error("The zoom slider was not rendered.");
		zoomSlider.value = "2";
		zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
		await expect.poll(() => tracker.renderCalls).toBe(2);
		const deferredRender = tracker.pending[0];
		if (deferredRender === undefined) throw new Error("The zoom render was not deferred.");

		if (interaction === "drag") {
			const point = getAreaPoint(pageArea, 0.5, 0.5);
			pageArea.dispatchEvent(createPointerEvent("pointerdown", 1, point.x, point.y, "mouse"));
			pageArea.dispatchEvent(
				createPointerEvent("pointermove", 1, point.x, point.y - 160, "mouse"),
			);
			pageArea.dispatchEvent(
				createPointerEvent("pointerup", 1, point.x, point.y - 160, "mouse"),
			);
		} else {
			pageArea.dispatchEvent(
				new WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					deltaY: 120,
				}),
			);
			pageArea.scrollTop = 160;
		}

		const scrollTopAfterUserInput = pageArea.scrollTop;
		expect(scrollTopAfterUserInput).toBeGreaterThan(0);
		deferredRender.resolve(pixelVisual());
		await expect.poll(() => tracker.completedRenders).toBe(2);
		await flushUi();
		expect(pageArea.scrollTop).toBe(scrollTopAfterUserInput);
	},
);

test("page changes cancel a pending zoom render and unmount cancels its timer", async () => {
	const tracker: RenderTracker = {
		renderCalls: 0,
		completedRenders: 0,
		renderScales: [],
		renderPages: [],
		holdRenders: false,
		pending: [],
	};
	const element = createViewer(createBackend(tracker, 2));
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	tracker.holdRenders = true;

	const shadowRoot = getShadowRoot(element);
	const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
	if (zoomSlider === null) throw new Error("The zoom slider was not rendered.");
	zoomSlider.value = "2.5";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await flushUi();
	expect(tracker.renderCalls).toBe(1);

	const secondPage = new Promise<void>((resolve) => {
		element.addEventListener(
			"pagechange",
			(event) => {
				if ((event as CustomEvent<{ page: number }>).detail.page === 2) resolve();
			},
			{ once: true },
		);
	});
	element.page = 2;
	await expect.poll(() => tracker.renderCalls).toBe(2);
	expect(tracker.renderPages).toEqual([0, 1]);
	await expect.poll(() => readZoom(shadowRoot)).toBe("100%");
	const pageRender = tracker.pending[0];
	if (pageRender === undefined) throw new Error("The page transition render was not deferred.");
	pageRender.resolve(pixelVisual());
	await secondPage;
	await waitForTimeout(ZOOM_RENDER_DELAY_MS + 20);
	expect(tracker.renderPages.slice(1).every((pageIndex) => pageIndex === 1)).toBe(true);

	zoomSlider.value = "3";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await flushUi();
	const callsBeforeUnmount = tracker.renderCalls;
	element.remove();
	await waitForTimeout(ZOOM_RENDER_DELAY_MS + 20);
	expect(tracker.renderCalls).toBe(callsBeforeUnmount);
});

test("every navigation path resets zoom, including the page property and attribute", async () => {
	const element = createViewer(createBackend(undefined, 8), 840);
	element.setConfig({
		chapters: [
			{ title: "前半", page: 4 },
			{ title: "後半", page: 8 },
		],
	});
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = getShadowRoot(element);
	const zoomIn = shadowRoot.querySelector<HTMLButtonElement>(
		'.zoom-controls button[aria-label="拡大"]',
	);
	const previous = shadowRoot.querySelector<HTMLButtonElement>('button[aria-label="前のページ"]');
	const next = shadowRoot.querySelector<HTMLButtonElement>('button[aria-label="次のページ"]');
	const pageInput = shadowRoot.querySelector<HTMLInputElement>('[aria-label="ページ番号"]');
	const tableOfContentsToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="chapters"]',
	);
	const bookmarkToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="bookmarks"]',
	);
	if (
		zoomIn === null ||
		previous === null ||
		next === null ||
		pageInput === null ||
		tableOfContentsToggle === null ||
		bookmarkToggle === null
	) {
		throw new Error("The page navigation controls were not rendered.");
	}

	await zoomThenNavigate(zoomIn, () => next.click(), element, 2);
	await zoomThenNavigate(zoomIn, () => previous.click(), element, 1);
	await zoomThenNavigate(
		zoomIn,
		() => {
			pageInput.value = "3";
			pageInput.dispatchEvent(new Event("change", { bubbles: true }));
		},
		element,
		3,
	);
	await zoomThenNavigate(
		zoomIn,
		async () => {
			tableOfContentsToggle.click();
			await expect
				.poll(() => shadowRoot.querySelector<HTMLButtonElement>('[data-chapter-page="4"]'))
				.not.toBeNull();
			shadowRoot.querySelector<HTMLButtonElement>('[data-chapter-page="4"]')?.click();
		},
		element,
		4,
	);

	bookmarkToggle.click();
	await expect.poll(() => shadowRoot.querySelector(".bookmark-current")).not.toBeNull();
	const bookmarkAction = shadowRoot.querySelector<HTMLButtonElement>(".bookmark-current");
	if (bookmarkAction === null) throw new Error("The bookmark panel was not rendered.");
	await browserPage.elementLocator(bookmarkAction).click();
	await expect.poll(() => bookmarkAction.getAttribute("aria-pressed")).toBe("true");
	element.page = 6;
	await expect.poll(() => element.page).toBe(6);
	const savedPageFour = shadowRoot.querySelector<HTMLButtonElement>('[data-bookmark-page="4"]');
	if (savedPageFour === null) throw new Error("The bookmark list was not rendered.");
	await zoomThenNavigate(zoomIn, () => savedPageFour.click(), element, 4);

	await zoomIn.click();
	await expect.poll(() => readZoom(shadowRoot)).toBe("120%");
	const pageListTab = shadowRoot.querySelector<HTMLButtonElement>(
		'.reader-panel [aria-label="ページ一覧"]',
	);
	if (pageListTab === null) throw new Error("The page list tab was not rendered.");
	pageListTab.click();
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-scroll")).not.toBeNull();
	const thumbnailScroll = shadowRoot.querySelector<HTMLElement>(".thumbnail-scroll");
	if (thumbnailScroll === null) throw new Error("The thumbnail list was not rendered.");
	thumbnailScroll.scrollTop = 7 * 160;
	thumbnailScroll.dispatchEvent(new Event("scroll"));
	await expect
		.poll(() => shadowRoot.querySelector('[data-page-index="7"] .thumbnail-entry'))
		.not.toBeNull();
	const thumbnail = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-page-index="7"] .thumbnail-entry',
	);
	if (thumbnail === null) throw new Error("The eighth page thumbnail was not rendered.");
	thumbnail.click();
	await expect.poll(() => element.page).toBe(8);
	await expect.poll(() => readZoom(shadowRoot)).toBe("100%");

	await zoomThenNavigate(zoomIn, () => (element.page = 2), element, 2);
	await zoomIn.click();
	await expect.poll(() => readZoom(shadowRoot)).toBe("120%");
	element.setAttribute("page", "3");
	await expect.poll(() => element.page).toBe(3);
	await expect.poll(() => readZoom(shadowRoot)).toBe("100%");
});

test("a deferred older raster preserves the latest zoom preview and anchor", async () => {
	const tracker: RenderTracker = {
		renderCalls: 0,
		completedRenders: 0,
		renderScales: [],
		renderPages: [],
		holdRenders: false,
		pending: [],
	};
	const element = createViewer(createBackend(tracker));
	element.style.height = "1000px";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	tracker.holdRenders = true;

	const shadowRoot = getShadowRoot(element);
	const pageArea = getPageArea(shadowRoot);
	const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
	if (zoomSlider === null) throw new Error("The zoom slider was not rendered.");
	const anchorPoint = getAreaPoint(pageArea, 0.5, 0.5);
	const initialRatio = measurePageRatio(pageArea, anchorPoint);
	const initialWidth = getFrame(pageArea).getBoundingClientRect().width;

	zoomSlider.value = "1.1";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await flushUi();
	await expect.poll(() => tracker.renderCalls).toBe(2);
	const olderRender = tracker.pending[0];
	if (olderRender === undefined) throw new Error("The first zoom render was not deferred.");

	zoomSlider.value = "1.2";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await flushUi();
	const latestWidth = getFrame(pageArea).getBoundingClientRect().width;
	const latestRatio = measurePageRatio(pageArea, anchorPoint);
	expect(readZoom(shadowRoot)).toBe("120%");
	expect(latestWidth).toBeGreaterThan(initialWidth * 1.15);

	olderRender.resolve(pixelVisual());
	await expect.poll(() => tracker.completedRenders).toBe(2);
	await flushUi();
	expect(getFrame(pageArea).getBoundingClientRect().width).toBe(latestWidth);
	expect(pagePointError(pageArea, anchorPoint, latestRatio)).toBeLessThanOrEqual(2);

	await expect.poll(() => tracker.renderCalls).toBe(3);
	expect(tracker.renderPages).toEqual([0, 0, 0]);
	expect(tracker.renderScales[2]).toBeGreaterThan((tracker.renderScales[0] ?? 0) * 1.15);
	const latestRender = tracker.pending[1];
	if (latestRender === undefined) throw new Error("The latest zoom render was not deferred.");
	latestRender.resolve(pixelVisual());
	await expect.poll(() => tracker.completedRenders).toBe(3);
	await flushUi();
	expect(getFrame(pageArea).getBoundingClientRect().width).toBe(latestWidth);
	expect(pagePointError(pageArea, anchorPoint, initialRatio)).toBeLessThanOrEqual(2);
	element.remove();
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

function createBackend(tracker?: RenderTracker, pageCount = 1): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount,
				async getPageSize() {
					return { width: 300, height: 400 };
				},
				async renderPage(pageIndex, scale) {
					if (tracker === undefined) return pixelVisual();
					tracker.renderCalls += 1;
					tracker.renderScales.push(scale);
					tracker.renderPages.push(pageIndex);
					if (!tracker.holdRenders) {
						tracker.completedRenders += 1;
						return pixelVisual();
					}
					const pending = createDeferred<PageVisual>();
					tracker.pending.push(pending);
					return pending.promise.then((visual) => {
						tracker.completedRenders += 1;
						return visual;
					});
				},
				async renderPrefetchedPage() {
					return pixelVisual();
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
	return {
		type: "pixels",
		width: 1,
		height: 1,
		pixels: new Uint8Array([70, 80, 90, 255]).buffer,
	};
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
		deltaY: -100 * Math.log(nextZoom / currentZoom),
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

async function zoomThenNavigate(
	zoomIn: HTMLButtonElement,
	navigate: () => void,
	element: PamphletViewerElement,
	expectedPage: number,
): Promise<void> {
	zoomIn.click();
	await expect.poll(() => readZoom(getShadowRoot(element))).toBe("120%");
	await navigate();
	await expect.poll(() => element.page).toBe(expectedPage);
	await expect.poll(() => readZoom(getShadowRoot(element))).toBe("100%");
}

function flushUi(): Promise<void> {
	return Promise.resolve().then(() => undefined);
}

function waitForTimeout(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
