import { afterEach, expect, test } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";
import type { PamphletViewerElement } from "@/lib/public-api";

afterEach(() => {
	document.body.replaceChildren();
});

test("does not navigate past the last visible page in spread layout", async () => {
	await import("@/lib/entry");
	const cases = [
		{ pageCount: 3, page: 2 },
		{ pageCount: 3, page: 3 },
		{ pageCount: 4, page: 4 },
		{ pageCount: 5, page: 4 },
	];

	for (const scenario of cases) {
		const renderedPages: number[] = [];
		const pageChanges: number[] = [];
		const element = createViewer(scenario.pageCount, "spread", renderedPages);
		element.page = scenario.page;
		element.addEventListener("pagechange", (event) => pageChanges.push(event.detail.page));
		const opened = waitForPageChange(element);
		document.body.append(element);
		await opened;
		await expect
			.poll(() => getVisiblePageIndexes(element))
			.toEqual(getExpectedVisibleIndexes(scenario.pageCount, scenario.page));

		const shadowRoot = element.shadowRoot;
		if (shadowRoot === null)
			throw new Error("The pamphlet viewer did not attach its shadow root.");
		const nextButton = shadowRoot.querySelector<HTMLButtonElement>(
			'button[aria-label="次のページ"]',
		);
		const pageArea = shadowRoot.querySelector<HTMLElement>(".page-area");
		if (nextButton === null || pageArea === null) {
			throw new Error("The page navigation controls were not rendered.");
		}

		expect(nextButton.disabled).toBe(true);
		await waitForAnimationFrames();
		const initialPageChanges = [...pageChanges];
		const initialRenderedPages = [...renderedPages];
		nextButton.click();
		pageArea.focus();
		pageArea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
		dispatchSwipe(pageArea);
		await waitForAnimationFrames();

		expect(element.page).toBe(scenario.page);
		expect(pageChanges).toEqual(initialPageChanges);
		expect(renderedPages).toEqual(initialRenderedPages);
		document.body.replaceChildren();
	}
});

test("allows advancing from the cover and from a spread before the final page", async () => {
	await import("@/lib/entry");
	const cases = [
		{ pageCount: 3, page: 1, expectedPage: 2, expectedIndexes: [1, 2] },
		{ pageCount: 4, page: 2, expectedPage: 4, expectedIndexes: [3] },
	];

	for (const scenario of cases) {
		const element = createViewer(scenario.pageCount, "spread");
		element.page = scenario.page;
		const opened = waitForPageChange(element);
		document.body.append(element);
		await opened;

		const shadowRoot = element.shadowRoot;
		if (shadowRoot === null)
			throw new Error("The pamphlet viewer did not attach its shadow root.");
		const nextButton = shadowRoot.querySelector<HTMLButtonElement>(
			'button[aria-label="次のページ"]',
		);
		if (nextButton === null) throw new Error("The next-page button was not rendered.");
		expect(nextButton.disabled).toBe(false);
		nextButton.click();
		await expect.poll(() => element.page).toBe(scenario.expectedPage);
		await expect.poll(() => getVisiblePageIndexes(element)).toEqual(scenario.expectedIndexes);
		expect(nextButton.disabled).toBe(true);
		document.body.replaceChildren();
	}
});

test("keeps single-page navigation available until the last page", async () => {
	await import("@/lib/entry");
	const element = createViewer(3, "single");
	element.page = 2;
	const opened = waitForPageChange(element);
	document.body.append(element);
	await opened;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const nextButton = shadowRoot.querySelector<HTMLButtonElement>(
		'button[aria-label="次のページ"]',
	);
	if (nextButton === null) throw new Error("The next-page button was not rendered.");
	expect(nextButton.disabled).toBe(false);
	nextButton.click();
	await expect.poll(() => element.page).toBe(3);
	expect(nextButton.disabled).toBe(true);
});

function createViewer(
	pageCount: number,
	layout: "single" | "spread",
	renderedPages: number[] = [],
): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "900px";
	element.style.height = "560px";
	element.layout = layout;
	element.backend = createBackend(pageCount, renderedPages);
	element.src = "./spread-end-test.pdf";
	return element;
}

function createBackend(pageCount: number, renderedPages: number[]): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount,
				async getPageSize() {
					return { width: 300, height: 400 };
				},
				async renderPage(pageIndex): Promise<PageVisual> {
					renderedPages.push(pageIndex);
					return {
						type: "pixels",
						width: 1,
						height: 1,
						pixels: new Uint8Array([70, 80, 90, 255]).buffer,
					};
				},
				async renderPrefetchedPage(): Promise<PageVisual> {
					return {
						type: "pixels",
						width: 1,
						height: 1,
						pixels: new Uint8Array([70, 80, 90, 255]).buffer,
					};
				},
				dispose() {},
			};
		},
	};
}

function getVisiblePageIndexes(element: PamphletViewerElement): number[] {
	return Array.from(
		element.shadowRoot?.querySelectorAll<HTMLElement>(".page-frame[data-page-index]") ?? [],
		(frame) => Number(frame.dataset.pageIndex),
	);
}

function getExpectedVisibleIndexes(pageCount: number, page: number): number[] {
	if (page === 1) return [0];
	const firstPageIndex = 1 + Math.floor((Math.min(pageCount, page) - 2) / 2) * 2;
	const secondPageIndex = firstPageIndex + 1;
	return secondPageIndex < pageCount ? [firstPageIndex, secondPageIndex] : [firstPageIndex];
}

function dispatchSwipe(target: HTMLElement): void {
	target.dispatchEvent(createPointerEvent("pointerdown", 31, 260, 180));
	target.dispatchEvent(createPointerEvent("pointermove", 31, 180, 190));
	target.dispatchEvent(createPointerEvent("pointerup", 31, 180, 190));
}

function createPointerEvent(
	type: string,
	pointerId: number,
	clientX: number,
	clientY: number,
): PointerEvent {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId,
		pointerType: "touch",
		clientX,
		clientY,
	});
}

function waitForAnimationFrames(): Promise<void> {
	return new Promise((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);
}

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}
