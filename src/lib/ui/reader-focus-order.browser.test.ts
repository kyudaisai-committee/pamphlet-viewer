// SPDX-License-Identifier: MPL-2.0

import { afterEach, expect, test } from "vitest";
import { page as browserPage, userEvent } from "vitest/browser";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";

const BOOKMARKS_STORAGE_KEY = "pamphlet-viewer.bookmarks.v1";

afterEach(async () => {
	document.body.replaceChildren();
	localStorage.removeItem(BOOKMARKS_STORAGE_KEY);
	await browserPage.viewport(1280, 900);
});

test.each([
	{ width: 320, firstRegion: "settings", nextRegion: "navigation" },
	{ width: 390, firstRegion: "settings", nextRegion: "navigation" },
	{ width: 840, firstRegion: "navigation", nextRegion: "settings" },
	{ width: 1120, firstRegion: "navigation", nextRegion: "settings" },
])(
	"uses visible control order for Tab and Shift+Tab at $width pixels",
	async ({ width, firstRegion, nextRegion }) => {
		const element = await createLoadedViewer(width);
		const shadowRoot = getShadowRoot(element);
		const shell = shadowRoot.querySelector<HTMLElement>(".viewer-shell");
		if (shell === null) throw new Error("The reader shell is missing.");
		await expect
			.poll(() => getReaderRegions(shell))
			.toEqual(
				width <= 700
					? ["settings", "body", "status", "navigation"]
					: ["navigation", "settings", "body", "status"],
			);

		const firstControl = getFirstTabStop(shadowRoot, firstRegion);
		firstControl.focus();
		expect(shadowRoot.activeElement).toBe(firstControl);

		const forwardPath = [firstControl];
		let nextRegionFirst: HTMLElement | null = null;
		for (let step = 0; step < 30; step += 1) {
			await userEvent.tab();
			const active = getActiveElement(shadowRoot);
			const region = getReaderRegion(active);
			if (region === firstRegion) {
				forwardPath.push(active);
				continue;
			}
			if (region !== nextRegion) {
				throw new Error(`Tab moved from ${firstRegion} to ${region ?? "outside the viewer"}.`);
			}
			nextRegionFirst = active;
			break;
		}
		if (nextRegionFirst === null) throw new Error("Tab did not reach the next toolbar region.");

		await userEvent.tab({ shift: true });
		expect(shadowRoot.activeElement).toBe(forwardPath.at(-1));
		const reversePath = [getActiveElement(shadowRoot)];
		while (reversePath.length < forwardPath.length) {
			await userEvent.tab({ shift: true });
			reversePath.push(getActiveElement(shadowRoot));
		}
		expect(reversePath).toEqual([...forwardPath].reverse());
	},
);

test("places body controls between mobile settings and navigation in keyboard order", async () => {
	const element = await createLoadedViewer(390);
	const shadowRoot = getShadowRoot(element);
	const thumbnailToggle = shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle");
	if (thumbnailToggle === null) throw new Error("The thumbnail toggle is missing.");
	thumbnailToggle.click();
	await expect
		.poll(() =>
			shadowRoot.querySelector('.thumbnail-panel button[aria-label="ページ一覧を閉じる"]'),
		)
		.not.toBeNull();
	const closeThumbnails = shadowRoot.querySelector<HTMLButtonElement>(
		'.thumbnail-panel button[aria-label="ページ一覧を閉じる"]',
	);
	if (closeThumbnails === null) throw new Error("The body controls did not open.");

	const zoomOut = shadowRoot.querySelector<HTMLButtonElement>(
		'.zoom-controls button[aria-label="縮小"]',
	);
	if (zoomOut === null) throw new Error("The settings controls are missing.");
	zoomOut.focus();
	for (let step = 0; step < 5; step += 1) await userEvent.tab();
	expect(shadowRoot.activeElement).toBe(closeThumbnails);
	expect(getReaderRegion(closeThumbnails)).toBe("body");
	await userEvent.tab();
	expect(getReaderRegion(getActiveElement(shadowRoot))).toBe("body");
});

test("keeps chapter and bookmark menu keyboard order within mobile navigation", async () => {
	localStorage.setItem(
		BOOKMARKS_STORAGE_KEY,
		JSON.stringify({ [new URL("./reader-test.pdf", document.baseURI).href]: [2] }),
	);
	const element = await createLoadedViewer(390);
	const shadowRoot = getShadowRoot(element);
	const menu = shadowRoot.querySelector<HTMLDetailsElement>(".compact-navigation");
	const summary = menu?.querySelector<HTMLElement>("summary");
	const chapterSelect = menu?.querySelector<HTMLSelectElement>('[aria-label="章へ移動"]');
	const bookmarkToggle = menu?.querySelector<HTMLButtonElement>(".bookmark-toggle");
	const bookmarkSelect = menu?.querySelector<HTMLSelectElement>('[aria-label="ブックマーク一覧"]');
	if (
		menu === null ||
		menu === undefined ||
		summary === null ||
		summary === undefined ||
		chapterSelect === null ||
		chapterSelect === undefined ||
		bookmarkToggle === null ||
		bookmarkToggle === undefined ||
		bookmarkSelect === null ||
		bookmarkSelect === undefined
	) {
		throw new Error("The mobile chapter and bookmark menu is missing.");
	}

	summary.focus();
	await userEvent.keyboard("{Space}");
	expect(menu.open).toBe(true);
	await userEvent.tab();
	expect(getActiveElement(shadowRoot)).toBe(chapterSelect);
	await userEvent.tab();
	expect(getActiveElement(shadowRoot)).toBe(bookmarkToggle);
	await userEvent.tab();
	expect(getActiveElement(shadowRoot)).toBe(bookmarkSelect);
	await userEvent.tab({ shift: true });
	expect(getActiveElement(shadowRoot)).toBe(bookmarkToggle);
	await userEvent.tab({ shift: true });
	expect(getActiveElement(shadowRoot)).toBe(chapterSelect);
	await userEvent.tab({ shift: true });
	expect(getActiveElement(shadowRoot)).toBe(summary);
});

test("preserves focus and fullscreen button identity when resizing across the breakpoint", async () => {
	const element = await createLoadedViewer(840);
	Object.defineProperty(element, "requestFullscreen", {
		configurable: true,
		value: async function rejectFullscreenRequest(): Promise<void> {
			throw new DOMException("Fullscreen is unavailable.", "NotAllowedError");
		},
	});
	const shadowRoot = getShadowRoot(element);
	const shell = shadowRoot.querySelector<HTMLElement>(".viewer-shell");
	const fullscreenButton = shadowRoot.querySelector<HTMLButtonElement>(".fullscreen-toggle");
	const navigationToolbar = shadowRoot.querySelector<HTMLElement>(".navigation-region .toolbar");
	if (shell === null || fullscreenButton === null || navigationToolbar === null) {
		throw new Error("The reader resize controls are missing.");
	}
	fullscreenButton.focus();
	expect(shadowRoot.activeElement).toBe(fullscreenButton);

	element.style.width = "390px";
	await expect.poll(() => shell.clientWidth).toBe(388);
	await expect
		.poll(() => getReaderRegions(shell))
		.toEqual(["settings", "body", "status", "navigation"]);
	expect(shadowRoot.activeElement).toBe(fullscreenButton);
	expect(shadowRoot.querySelector(".fullscreen-toggle")).toBe(fullscreenButton);
	await userEvent.tab();
	expect(getReaderRegion(getActiveElement(shadowRoot))).toBe("navigation");

	element.style.width = "1120px";
	await expect.poll(() => shell.clientWidth).toBe(1118);
	await expect
		.poll(() => getReaderRegions(shell))
		.toEqual(["navigation", "settings", "body", "status"]);
	expect(shadowRoot.querySelector(".fullscreen-toggle")).toBe(fullscreenButton);
	expect(fullscreenButton.isConnected).toBe(true);
	expect(shadowRoot.activeElement).toBe(navigationToolbar);
	fullscreenButton.focus();
	await userEvent.keyboard("{Space}");
	await expect.poll(() => shell.matches(":popover-open")).toBe(true);
	await userEvent.keyboard("{Escape}");
	await expect.poll(() => shell.matches(":popover-open")).toBe(false);
	await expect.poll(() => shadowRoot.activeElement).toBe(fullscreenButton);
});

test("keeps keyboard focus on the same fullscreen control after closing fallback fullscreen", async () => {
	const element = await createLoadedViewer(390);
	Object.defineProperty(element, "requestFullscreen", {
		configurable: true,
		value: async function rejectFullscreenRequest(): Promise<void> {
			throw new DOMException("Fullscreen is unavailable.", "NotAllowedError");
		},
	});
	const shadowRoot = getShadowRoot(element);
	const shell = shadowRoot.querySelector<HTMLElement>(".viewer-shell");
	const fullscreenButton = shadowRoot.querySelector<HTMLButtonElement>(".fullscreen-toggle");
	if (shell === null || fullscreenButton === null) {
		throw new Error("The fullscreen controls are missing.");
	}
	fullscreenButton.focus();
	await userEvent.keyboard("{Space}");
	await expect.poll(() => shell.matches(":popover-open")).toBe(true);
	await userEvent.keyboard("{Escape}");
	await expect.poll(() => shell.matches(":popover-open")).toBe(false);
	await expect.poll(() => shadowRoot.activeElement).toBe(fullscreenButton);
	expect(shadowRoot.querySelector(".fullscreen-toggle")).toBe(fullscreenButton);
});

async function createLoadedViewer(width: number): Promise<PamphletViewerElement> {
	await import("../entry");
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = `${width}px`;
	element.style.height = "620px";
	element.backend = createBackend();
	element.src = "./reader-test.pdf";
	element.layout = "single";
	element.setConfig({
		chapters: [
			{ title: "前半", page: 1 },
			{ title: "後半", page: 2 },
		],
	});
	const ready = new Promise<void>((resolve) => {
		element.addEventListener("pagechange", () => resolve(), { once: true });
	});
	document.body.append(element);
	await ready;
	return element;
}

function createBackend(): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount: 3,
				async getPageSize(): Promise<{ width: number; height: number }> {
					return { width: 300, height: 400 };
				},
				async renderPage(): Promise<PageVisual> {
					return {
						type: "pixels",
						width: 300,
						height: 400,
						pixels: new Uint8ClampedArray(300 * 400 * 4).buffer,
					};
				},
				dispose(): void {},
			};
		},
	};
}

function getShadowRoot(element: PamphletViewerElement): ShadowRoot {
	if (element.shadowRoot === null) throw new Error("The reader shadow root is missing.");
	return element.shadowRoot;
}

function getReaderRegions(shell: HTMLElement): string[] {
	return Array.from(shell.children, (child) =>
		child instanceof HTMLElement ? (child.dataset.readerRegion ?? "") : "",
	);
}

function getFirstTabStop(shadowRoot: ShadowRoot, region: string): HTMLElement {
	const selectors =
		region === "settings"
			? '.settings-region button[aria-label="縮小"]'
			: ".navigation-region .toolbar";
	const element = shadowRoot.querySelector<HTMLElement>(selectors);
	if (element === null) throw new Error(`The first tab stop in ${region} is missing.`);
	return element;
}

function getActiveElement(shadowRoot: ShadowRoot): HTMLElement {
	const active = shadowRoot.activeElement;
	if (!(active instanceof HTMLElement))
		throw new Error("Keyboard focus left the reader shadow root.");
	return active;
}

function getReaderRegion(element: HTMLElement): string | null {
	return element.closest<HTMLElement>("[data-reader-region]")?.dataset.readerRegion ?? null;
}
