import { afterEach, expect, test } from "vitest";
import { page as browserPage } from "vitest/browser";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";
import type { PamphletViewerElement } from "@/lib/public-api";

afterEach(async () => {
	document.body.replaceChildren();
	await browserPage.viewport(1280, 900);
});

test.each([390, 660, 700, 701, 702, 703, 840])(
	"matches thumbnail selection behavior to stage visibility at host width %ipx",
	async (width) => {
		await import("@/lib/entry");
		const element = createViewer(width);
		const firstPage = waitForPageChange(element);
		document.body.append(element);
		await firstPage;

		const shadowRoot = element.shadowRoot;
		if (shadowRoot === null)
			throw new Error("The pamphlet viewer did not attach its shadow root.");
		const shell = shadowRoot.querySelector<HTMLElement>(".viewer-shell");
		const stageSlot = shadowRoot.querySelector<HTMLElement>(".stage-slot");
		if (shell === null || stageSlot === null) throw new Error("The reader stage is missing.");
		expect(getComputedStyle(shell).borderLeftWidth).toBe("1px");

		const thumbnailToggle = shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle");
		if (thumbnailToggle === null) throw new Error("The thumbnail toggle is missing.");
		thumbnailToggle.click();
		await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).not.toBeNull();
		const stageIsHidden = width <= 702;
		expect(getComputedStyle(stageSlot).display === "none").toBe(stageIsHidden);

		const pageEntry = shadowRoot.querySelector<HTMLButtonElement>(
			'[data-page-index="2"] .thumbnail-entry',
		);
		if (pageEntry === null) throw new Error("The third page thumbnail is missing.");
		pageEntry.click();
		await expect.poll(() => element.page).toBe(3);
		await waitForDisplayedPageFrame(shadowRoot, 2);
		if (stageIsHidden) {
			await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).toBeNull();
		} else {
			expect(shadowRoot.querySelector(".thumbnail-panel")).not.toBeNull();
		}
	},
);

test("uses the resized stage visibility when selecting a thumbnail", async () => {
	await import("@/lib/entry");
	const element = createViewer(660);
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const stageSlot = shadowRoot.querySelector<HTMLElement>(".stage-slot");
	const thumbnailToggle = shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle");
	if (stageSlot === null || thumbnailToggle === null) {
		throw new Error("The thumbnail reader controls are missing.");
	}
	thumbnailToggle.click();
	await expect.poll(() => getComputedStyle(stageSlot).display).toBe("none");

	element.style.width = "840px";
	await expect.poll(() => getComputedStyle(stageSlot).display).toBe("flex");
	const thirdPage = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-page-index="2"] .thumbnail-entry',
	);
	if (thirdPage === null) throw new Error("The third page thumbnail is missing.");
	thirdPage.click();
	await expect.poll(() => element.page).toBe(3);
	await waitForDisplayedPageFrame(shadowRoot, 2);
	expect(shadowRoot.querySelector(".thumbnail-panel")).not.toBeNull();

	element.style.width = "660px";
	await expect.poll(() => getComputedStyle(stageSlot).display).toBe("none");
	const fourthPage = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-page-index="3"] .thumbnail-entry',
	);
	if (fourthPage === null) throw new Error("The fourth page thumbnail is missing.");
	fourthPage.click();
	await expect.poll(() => element.page).toBe(4);
	await waitForDisplayedPageFrame(shadowRoot, 3);
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).toBeNull();
});

test("keeps thumbnails open when fullscreen makes the stage visible", async () => {
	await import("@/lib/entry");
	const element = createViewer(660);
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	Object.defineProperty(element, "requestFullscreen", {
		configurable: true,
		value: async function rejectFullscreenRequest(): Promise<void> {
			throw new DOMException("Fullscreen is unavailable.", "NotAllowedError");
		},
	});

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const shell = shadowRoot.querySelector<HTMLElement>(".viewer-shell");
	const stageSlot = shadowRoot.querySelector<HTMLElement>(".stage-slot");
	const thumbnailToggle = shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle");
	const fullscreenToggle = shadowRoot.querySelector<HTMLButtonElement>(".fullscreen-toggle");
	if (
		shell === null ||
		stageSlot === null ||
		thumbnailToggle === null ||
		fullscreenToggle === null
	) {
		throw new Error("The reader controls are missing.");
	}
	thumbnailToggle.click();
	await expect.poll(() => getComputedStyle(stageSlot).display).toBe("none");
	fullscreenToggle.click();
	await expect.poll(() => shell.matches(":popover-open")).toBe(true);
	await expect.poll(() => getComputedStyle(stageSlot).display).toBe("flex");

	const thirdPage = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-page-index="2"] .thumbnail-entry',
	);
	if (thirdPage === null) throw new Error("The third page thumbnail is missing.");
	thirdPage.click();
	await expect.poll(() => element.page).toBe(3);
	await waitForDisplayedPageFrame(shadowRoot, 2);
	expect(shadowRoot.querySelector(".thumbnail-panel")).not.toBeNull();
});

async function waitForDisplayedPageFrame(shadowRoot: ShadowRoot, pageIndex: number): Promise<void> {
	await expect
		.poll(() => {
			const stageSlot = shadowRoot.querySelector<HTMLElement>(".stage-slot");
			const pageFrame = shadowRoot.querySelector<HTMLElement>(
				`.page-frame[data-page-index="${pageIndex}"]`,
			);
			if (stageSlot === null || pageFrame === null) return false;
			const bounds = pageFrame.getBoundingClientRect();
			return (
				getComputedStyle(stageSlot).display === "flex" &&
				bounds.width > 0 &&
				bounds.height > 0
			);
		})
		.toBe(true);
}

function createViewer(width: number): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = `${width}px`;
	element.style.height = "620px";
	element.backend = createBackend(4);
	element.src = "./responsive-thumbnail-test.pdf";
	return element;
}

function createBackend(pageCount: number): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount,
				async getPageSize(): Promise<{ width: number; height: number }> {
					return { width: 300, height: 400 };
				},
				async renderPage(): Promise<PageVisual> {
					return {
						type: "pixels",
						width: 1,
						height: 1,
						pixels: new Uint8Array([66, 102, 93, 255]).buffer,
					};
				},
				async renderPrefetchedPage(): Promise<PageVisual> {
					return {
						type: "pixels",
						width: 1,
						height: 1,
						pixels: new Uint8Array([66, 102, 93, 255]).buffer,
					};
				},
				dispose(): void {},
			};
		},
	};
}

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}
