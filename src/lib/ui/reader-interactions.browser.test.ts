import { afterEach, beforeEach, expect, test } from "vitest";
import { page as browserPage } from "vitest/browser";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";
import { ReaderFullscreenController } from "./reader-fullscreen.svelte";

const BOOKMARKS_STORAGE_KEY = "pamphlet-viewer.bookmarks.v1";

afterEach(async () => {
	document.body.replaceChildren();
	localStorage.removeItem(BOOKMARKS_STORAGE_KEY);
	await browserPage.viewport(1280, 900);
});

beforeEach(async () => {
	await browserPage.viewport(1280, 900);
});

test("keeps the thumbnail list virtual and selects a distant page", async () => {
	await import("../entry");
	const renderedPages: number[] = [];
	const element = createViewer({ width: 1120, height: 680 }, createBackend(120, renderedPages));
	element.layout = "single";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
	await expect
		.poll(() => shadowRoot.querySelectorAll(".thumbnail-entry").length)
		.toBeGreaterThan(0);
	await expect.poll(() => renderedPages.length).toBeGreaterThan(1);
	expect(shadowRoot.querySelectorAll(".thumbnail-entry").length).toBeLessThan(10);
	expect(renderedPages.length).toBeLessThan(12);

	const scrollContainer = shadowRoot.querySelector<HTMLElement>(".thumbnail-scroll");
	if (scrollContainer === null) throw new Error("The thumbnail list did not render.");
	scrollContainer.scrollTop = 40 * 160;
	scrollContainer.dispatchEvent(new Event("scroll"));
	await expect
		.poll(() => shadowRoot.querySelector('[data-page-index="40"] .thumbnail-entry'))
		.not.toBeNull();
	shadowRoot.querySelector<HTMLButtonElement>('[data-page-index="40"] .thumbnail-entry')?.click();
	await expect.poll(() => element.page).toBe(41);
	await expect
		.poll(() => shadowRoot.querySelector('.page-frame[data-page-index="40"]'))
		.not.toBeNull();
});

test("navigates to validated configured chapters", async () => {
	await import("../entry");
	const element = createViewer({ width: 840, height: 620 }, createBackend(12));
	element.config = {
		chapters: [
			{ title: "後半", page: 7 },
			{ title: "前半", page: 2 },
			{ title: "無効", page: 20 },
		],
	};
	element.layout = "single";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const chapterSelect = shadowRoot.querySelector<HTMLSelectElement>(
		'.toolbar > .chapter-control select[aria-label="章へ移動"]',
	);
	if (chapterSelect === null) {
		throw new Error("The configured chapter list was not rendered.");
	}
	const visibleChapterSelect = browserPage.elementLocator(chapterSelect);
	await expect.element(visibleChapterSelect).toBeVisible();
	expect(Array.from(chapterSelect.options, (option) => option.textContent)).toEqual([
		"章を選択",
		"前半",
		"後半",
	]);

	await visibleChapterSelect.selectOptions("7");
	await expect.poll(() => element.page).toBe(7);
	await expect.poll(() => chapterSelect.value).toBe("7");
	element.page = 9;
	await expect.poll(() => chapterSelect.value).toBe("7");
});

test("persists bookmarks per document and restores the saved page list", async () => {
	localStorage.removeItem(BOOKMARKS_STORAGE_KEY);
	await import("../entry");
	const element = createViewer({ width: 840, height: 620 }, createBackend(5));
	element.layout = "single";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const bookmarkButton = shadowRoot.querySelector<HTMLButtonElement>(
		".page-controls > .bookmark-toggle",
	);
	if (bookmarkButton === null) {
		throw new Error("The bookmark controls were not rendered.");
	}
	expect(bookmarkButton.disabled).toBe(false);
	await expect.element(browserPage.elementLocator(bookmarkButton)).toBeVisible();
	await browserPage.elementLocator(bookmarkButton).click();
	await expect.poll(() => bookmarkButton.getAttribute("aria-pressed")).toBe("true");
	expect(
		shadowRoot.querySelector<HTMLSelectElement>(
			'.toolbar > .bookmark-list-control select[aria-label="ブックマーク一覧"]',
		)?.options[1]?.value,
	).toBe("1");

	element.page = 3;
	await expect.poll(() => element.page).toBe(3);
	await browserPage.elementLocator(bookmarkButton).click();
	await expect.poll(() => bookmarkButton.getAttribute("aria-pressed")).toBe("true");

	const bookmarkSelect = shadowRoot.querySelector<HTMLSelectElement>(
		'.toolbar > .bookmark-list-control select[aria-label="ブックマーク一覧"]',
	);
	if (bookmarkSelect === null) throw new Error("The saved page list was not rendered.");
	const desktopBookmarkSelect = browserPage.elementLocator(bookmarkSelect);
	await expect.element(desktopBookmarkSelect).toBeVisible();
	await desktopBookmarkSelect.selectOptions("1");
	await expect.poll(() => element.page).toBe(1);

	const secondDocumentPage = waitForPageChange(element);
	element.src = "./different-reader.pdf";
	await secondDocumentPage;
	expect(
		shadowRoot.querySelector(
			'.toolbar > .bookmark-list-control select[aria-label="ブックマーク一覧"]',
		),
	).toBeNull();

	const restoredPage = waitForPageChange(element);
	element.src = "./reader-test.pdf";
	await restoredPage;
	const restoredOptions = shadowRoot.querySelector<HTMLSelectElement>(
		'.toolbar > .bookmark-list-control select[aria-label="ブックマーク一覧"]',
	)?.options;
	expect(Array.from(restoredOptions ?? [], (option) => option.value)).toEqual(["", "1", "3"]);

	element.page = 3;
	await expect.poll(() => bookmarkButton.getAttribute("aria-pressed")).toBe("true");
	await browserPage.elementLocator(bookmarkButton).click();
	await expect.poll(() => bookmarkButton.getAttribute("aria-pressed")).toBe("false");
	expect(
		Array.from(
			shadowRoot.querySelector<HTMLSelectElement>(
				'.toolbar > .bookmark-list-control select[aria-label="ブックマーク一覧"]',
			)?.options ?? [],
			(option) => option.value,
		),
	).toEqual(["", "1"]);
});

test("synchronizes bookmarks between viewer instances and storage events", async () => {
	localStorage.removeItem(BOOKMARKS_STORAGE_KEY);
	await import("../entry");
	const backend = createBackend(5);
	const first = createViewer({ width: 840, height: 620 }, backend);
	const second = createViewer({ width: 840, height: 620 }, backend);
	first.layout = "single";
	second.layout = "single";
	const firstPage = waitForPageChange(first);
	const secondPage = waitForPageChange(second);
	document.body.append(first, second);
	await Promise.all([firstPage, secondPage]);

	const firstButtonElement = first.shadowRoot?.querySelector<HTMLButtonElement>(
		".page-controls > .bookmark-toggle",
	);
	const secondButtonElement = second.shadowRoot?.querySelector<HTMLButtonElement>(
		".page-controls > .bookmark-toggle",
	);
	if (
		firstButtonElement === null ||
		firstButtonElement === undefined ||
		secondButtonElement === null ||
		secondButtonElement === undefined
	) {
		throw new Error("The bookmark controls were not rendered for both viewers.");
	}
	const firstButton = browserPage.elementLocator(firstButtonElement);
	const secondButton = browserPage.elementLocator(secondButtonElement);
	await expect.element(firstButton).toBeVisible();
	await expect.element(secondButton).toBeVisible();
	await firstButton.click();
	await expect.poll(() => secondButtonElement.getAttribute("aria-pressed")).toBe("true");

	const documentKey = new URL("./reader-test.pdf", document.baseURI).href;
	const newValue = JSON.stringify({ [documentKey]: [2, 4] });
	localStorage.setItem(BOOKMARKS_STORAGE_KEY, newValue);
	window.dispatchEvent(new StorageEvent("storage", { key: BOOKMARKS_STORAGE_KEY, newValue }));
	await expect
		.poll(() =>
			Array.from(
				second.shadowRoot?.querySelector<HTMLSelectElement>(
					'.toolbar > .bookmark-list-control select[aria-label="ブックマーク一覧"]',
				)?.options ?? [],
				(option) => option.value,
			),
		)
		.toEqual(["", "2", "4"]);
});

test.each([320, 390])(
	"keeps chapter and saved-page navigation usable at %i pixels",
	async (width) => {
		const documentKey = new URL("./reader-test.pdf", document.baseURI).href;
		localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify({ [documentKey]: [3, 8] }));
		await import("../entry");
		const element = createViewer({ width, height: 620 }, createBackend(12));
		element.layout = "auto";
		element.config = {
			chapters: [
				{ title: "前半", page: 1 },
				{ title: "後半", page: 7 },
			],
		};
		const firstPage = waitForPageChange(element);
		document.body.append(element);
		await firstPage;

		const shadowRoot = element.shadowRoot;
		const toolbar = shadowRoot?.querySelector<HTMLElement>(".toolbar");
		const settingsToolbar = shadowRoot?.querySelector<HTMLElement>(".settings-toolbar");
		const shell = shadowRoot?.querySelector<HTMLElement>(".viewer-shell");
		const readerBody = shadowRoot?.querySelector<HTMLElement>(".reader-body");
		const statusBar = shadowRoot?.querySelector<HTMLElement>(".status-bar");
		const pageControls = shadowRoot?.querySelector<HTMLElement>(".page-controls");
		const zoomControls = shadowRoot?.querySelector<HTMLElement>(".zoom-controls");
		const viewControls = shadowRoot?.querySelector<HTMLElement>(".view-controls");
		const zoomSlider = shadowRoot?.querySelector<HTMLInputElement>(".zoom-slider");
		const zoomIn = shadowRoot?.querySelector<HTMLButtonElement>(
			'.zoom-controls button[aria-label="拡大"]',
		);
		const settingsSummary = shadowRoot?.querySelector<HTMLElement>(".compact-settings > summary");
		const settingsPanel = shadowRoot?.querySelector<HTMLElement>(".compact-settings-panel");
		const compactNavigation = shadowRoot?.querySelector<HTMLDetailsElement>(".compact-navigation");
		const summary = compactNavigation?.querySelector<HTMLElement>("summary");
		if (
			toolbar === null ||
			toolbar === undefined ||
			settingsToolbar === null ||
			settingsToolbar === undefined ||
			shell === null ||
			shell === undefined ||
			readerBody === null ||
			readerBody === undefined ||
			statusBar === null ||
			statusBar === undefined ||
			pageControls === null ||
			pageControls === undefined ||
			zoomControls === null ||
			zoomControls === undefined ||
			viewControls === null ||
			viewControls === undefined ||
			zoomSlider === null ||
			zoomSlider === undefined ||
			zoomIn === null ||
			zoomIn === undefined ||
			settingsSummary === null ||
			settingsSummary === undefined ||
			settingsPanel === null ||
			settingsPanel === undefined ||
			compactNavigation === null ||
			compactNavigation === undefined ||
			summary === null ||
			summary === undefined
		) {
			throw new Error("The narrow reader navigation controls were not rendered.");
		}
		expect(element.getBoundingClientRect().width).toBe(width);
		const shellRect = shell.getBoundingClientRect();
		const toolbarRect = toolbar.getBoundingClientRect();
		const settingsToolbarRect = settingsToolbar.getBoundingClientRect();
		const bodyRect = readerBody.getBoundingClientRect();
		const statusRect = statusBar.getBoundingClientRect();
		const pageControlsRect = pageControls.getBoundingClientRect();
		const zoomControlsRect = zoomControls.getBoundingClientRect();
		const viewControlsRect = viewControls.getBoundingClientRect();
		expect(settingsToolbarRect.left).toBeGreaterThanOrEqual(shellRect.left);
		expect(settingsToolbarRect.right).toBeLessThanOrEqual(shellRect.right);
		expect(toolbarRect.left).toBeGreaterThanOrEqual(shellRect.left);
		expect(toolbarRect.right).toBeLessThanOrEqual(shellRect.right);
		expect(settingsToolbarRect.top).toBeGreaterThanOrEqual(shellRect.top);
		expect(settingsToolbarRect.bottom).toBeLessThanOrEqual(bodyRect.top);
		expect(bodyRect.bottom).toBeLessThanOrEqual(statusRect.top);
		expect(statusRect.bottom).toBeLessThanOrEqual(toolbarRect.top);
		expect(toolbarRect.bottom).toBeLessThanOrEqual(shellRect.bottom);
		expect(pageControlsRect.top).toBeGreaterThanOrEqual(toolbarRect.top);
		expect(pageControlsRect.bottom).toBeLessThanOrEqual(toolbarRect.bottom);
		expect(zoomControlsRect.top).toBeGreaterThanOrEqual(settingsToolbarRect.top);
		expect(zoomControlsRect.bottom).toBeLessThanOrEqual(settingsToolbarRect.bottom);
		expect(viewControlsRect.top).toBeGreaterThanOrEqual(settingsToolbarRect.top);
		expect(viewControlsRect.bottom).toBeLessThanOrEqual(settingsToolbarRect.bottom);
		const zoomAndViewDoNotOverlap =
			zoomControlsRect.right <= viewControlsRect.left ||
			viewControlsRect.right <= zoomControlsRect.left ||
			zoomControlsRect.bottom <= viewControlsRect.top ||
			viewControlsRect.bottom <= zoomControlsRect.top;
		expect(zoomAndViewDoNotOverlap).toBe(true);
		const summaryLocator = browserPage.elementLocator(summary);
		await expect.element(summaryLocator).toBeVisible();
		await summaryLocator.click();
		await expect.poll(() => compactNavigation.open).toBe(true);
		const panel = compactNavigation.querySelector<HTMLElement>(".compact-navigation-panel");
		const chapterSelect = compactNavigation.querySelector<HTMLSelectElement>(
			'select[aria-label="章へ移動"]',
		);
		const bookmarkSelect = compactNavigation.querySelector<HTMLSelectElement>(
			'select[aria-label="ブックマーク一覧"]',
		);
		if (panel === null || chapterSelect === null || bookmarkSelect === null) {
			throw new Error("The compact chapter and bookmark lists were not rendered.");
		}
		const panelLocator = browserPage.elementLocator(panel);
		const chapterLocator = browserPage.elementLocator(chapterSelect);
		const bookmarkLocator = browserPage.elementLocator(bookmarkSelect);
		await expect.element(panelLocator).toBeVisible();
		await expect.element(chapterLocator).toBeVisible();
		await expect.element(bookmarkLocator).toBeVisible();
		const panelRect = panel.getBoundingClientRect();
		expect(panelRect.width).toBeLessThanOrEqual(280);
		expect(panelRect.left).toBeGreaterThanOrEqual(toolbarRect.left);
		expect(panelRect.right).toBeLessThanOrEqual(toolbarRect.right);
		expect(panelRect.left).toBeGreaterThanOrEqual(shellRect.left);
		expect(panelRect.right).toBeLessThanOrEqual(shellRect.right);
		expect(panelRect.bottom).toBeLessThanOrEqual(toolbarRect.top);
		for (const select of [chapterSelect, bookmarkSelect]) {
			const selectRect = select.getBoundingClientRect();
			expect(selectRect.left).toBeGreaterThanOrEqual(panelRect.left);
			expect(selectRect.right).toBeLessThanOrEqual(panelRect.right);
			expect(selectRect.left).toBeGreaterThanOrEqual(toolbarRect.left);
			expect(selectRect.right).toBeLessThanOrEqual(toolbarRect.right);
			expect(selectRect.left).toBeGreaterThanOrEqual(shellRect.left);
			expect(selectRect.right).toBeLessThanOrEqual(shellRect.right);
		}
		await chapterLocator.selectOptions("7");
		await expect.poll(() => element.page).toBe(7);
		expect(compactNavigation.open).toBe(false);

		await summaryLocator.click();
		const bookmarkToggle = compactNavigation.querySelector<HTMLButtonElement>(".bookmark-toggle");
		if (bookmarkToggle === null) throw new Error("The compact bookmark toggle was not rendered.");
		await browserPage.elementLocator(bookmarkToggle).click();
		await expect.poll(() => bookmarkToggle.getAttribute("aria-pressed")).toBe("true");
		expect(JSON.parse(localStorage.getItem(BOOKMARKS_STORAGE_KEY) ?? "null")).toEqual({
			[documentKey]: [3, 7, 8],
		});

		await summaryLocator.click();
		await bookmarkLocator.selectOptions("8");
		await expect.poll(() => element.page).toBe(8);
		expect(compactNavigation.open).toBe(false);
		await summaryLocator.click();
		await browserPage.elementLocator(bookmarkToggle).click();
		await expect.poll(() => bookmarkToggle.getAttribute("aria-pressed")).toBe("false");
		expect(JSON.parse(localStorage.getItem(BOOKMARKS_STORAGE_KEY) ?? "null")).toEqual({
			[documentKey]: [3, 7],
		});

		await browserPage.elementLocator(zoomIn).click();
		await expect.poll(() => Number(zoomSlider.value)).toBeGreaterThan(1);
		const settingsSummaryLocator = browserPage.elementLocator(settingsSummary);
		await settingsSummaryLocator.click();
		await expect.element(browserPage.elementLocator(settingsPanel)).toBeVisible();
		const settingsPanelRect = settingsPanel.getBoundingClientRect();
		expect(settingsPanelRect.top).toBeGreaterThanOrEqual(
			settingsSummary.getBoundingClientRect().bottom,
		);
		expect(settingsPanelRect.left).toBeGreaterThanOrEqual(shellRect.left);
		expect(settingsPanelRect.right).toBeLessThanOrEqual(shellRect.right);
		const layoutSelect = settingsPanel.querySelector<HTMLSelectElement>(
			'select[aria-label="ページ配置"]',
		);
		if (layoutSelect === null)
			throw new Error("The compact page layout selector was not rendered.");
		await browserPage.elementLocator(layoutSelect).selectOptions("single");
		await expect.poll(() => element.layout).toBe("single");
	},
);

test("uses the host width for mobile thumbnail mode and closes after selection", async () => {
	await import("../entry");
	const element = createViewer({ width: 390, height: 620 }, createBackend(24));
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	expect(window.innerWidth).toBeGreaterThan(620);
	expect(shadowRoot.querySelectorAll(".page-frame")).toHaveLength(1);

	shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
	const stageSlot = shadowRoot.querySelector<HTMLElement>(".stage-slot");
	const readerBody = shadowRoot.querySelector<HTMLElement>(".reader-body");
	const toolbar = shadowRoot.querySelector<HTMLElement>(".toolbar");
	const compactSettings = shadowRoot.querySelector<HTMLElement>(".compact-settings");
	if (stageSlot === null || readerBody === null || toolbar === null || compactSettings === null) {
		throw new Error("The mobile reader controls are missing.");
	}
	await expect.poll(() => getComputedStyle(stageSlot).display).toBe("none");
	expect(getComputedStyle(readerBody).gridTemplateColumns.trim().split(" ")).toHaveLength(1);
	expect(getComputedStyle(compactSettings).display).toBe("block");
	expect(toolbar.getBoundingClientRect().height).toBeLessThanOrEqual(120);
	shadowRoot.querySelector<HTMLButtonElement>('[data-page-index="2"] .thumbnail-entry')?.click();
	await expect.poll(() => element.page).toBe(3);
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).toBeNull();
});

test("falls back to a top-layer fullscreen reader and restores the embed size on Escape", async () => {
	await import("../entry");
	const element = createViewer({ width: 390, height: 600 }, createBackend(2));
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
	const fullscreenButton = shadowRoot.querySelector<HTMLButtonElement>(".fullscreen-toggle");
	if (shell === null || fullscreenButton === null)
		throw new Error("Fullscreen controls are missing.");
	fullscreenButton.click();
	await expect.poll(() => shell.matches(":popover-open")).toBe(true);
	expect(shell.getBoundingClientRect().width).toBeGreaterThan(620);
	expect(element.hasAttribute("data-fullscreen-fallback")).toBe(true);

	const escapeEvent = new KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	document.dispatchEvent(escapeEvent);
	expect(escapeEvent.defaultPrevented).toBe(true);
	await expect.poll(() => shell.matches(":popover-open")).toBe(false);
	await expect.poll(() => element.hasAttribute("data-fullscreen-fallback")).toBe(false);
	await expect.poll(() => fullscreenButton.getAttribute("aria-pressed")).toBe("false");
});

test("does not apply an old fullscreen request to a reattached reader", async () => {
	const fullscreenElementDescriptor = Object.getOwnPropertyDescriptor(
		document,
		"fullscreenElement",
	);
	const exitFullscreenDescriptor = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
	const requestState: { resolve: (() => void) | null } = { resolve: null };
	let exitCount = 0;
	const oldHost = document.createElement("div");
	const oldShell = document.createElement("div");
	const oldButton = document.createElement("button");
	const newHost = document.createElement("div");
	const newShell = document.createElement("div");
	const newButton = document.createElement("button");
	const fullscreenController = new ReaderFullscreenController();
	let detachController: (() => void) | null = null;
	Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
	Object.defineProperty(document, "exitFullscreen", {
		configurable: true,
		value: async function exitMockFullscreen(): Promise<void> {
			exitCount += 1;
			Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
		},
	});
	Object.defineProperty(oldHost, "requestFullscreen", {
		configurable: true,
		value: function requestPendingFullscreen(): Promise<void> {
			return new Promise((resolve) => {
				requestState.resolve = resolve;
			});
		},
	});
	oldHost.append(oldShell);
	oldShell.append(oldButton);
	newHost.append(newShell);
	newShell.append(newButton);
	document.body.append(oldHost, newHost);

	try {
		detachController = fullscreenController.attach(oldHost, oldShell, oldButton);
		const pendingToggle = fullscreenController.toggle();
		await expect.poll(() => requestState.resolve).not.toBeNull();
		detachController();
		detachController = fullscreenController.attach(newHost, newShell, newButton);
		Object.defineProperty(document, "fullscreenElement", {
			configurable: true,
			value: oldHost,
		});
		const completeRequest = requestState.resolve;
		if (completeRequest === null) throw new Error("The pending fullscreen request did not start.");
		completeRequest();
		await pendingToggle;

		expect(exitCount).toBe(1);
		expect(fullscreenController.active).toBe(false);
		expect(newHost.hasAttribute("data-fullscreen-fallback")).toBe(false);
		expect(newShell.matches(":popover-open")).toBe(false);
	} finally {
		detachController?.();
		restoreProperty(document, "fullscreenElement", fullscreenElementDescriptor);
		restoreProperty(document, "exitFullscreen", exitFullscreenDescriptor);
	}
});

test("supports high zoom and pans the page without a pixel-limit error", async () => {
	await import("../entry");
	const element = createViewer({ width: 520, height: 520 }, createBackend(1));
	element.layout = "single";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const pageArea = shadowRoot.querySelector<HTMLElement>(".page-area");
	const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
	if (pageArea === null || zoomSlider === null) throw new Error("The page controls are missing.");
	const errorEvents: string[] = [];
	element.addEventListener("error", (event) => errorEvents.push(event.detail.code));
	zoomSlider.value = "8";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await expect.poll(() => zoomSlider.value).toBe("8");
	await expect.poll(() => pageArea.scrollWidth).toBeGreaterThan(pageArea.clientWidth);
	expect(errorEvents).toEqual([]);

	const startScroll = pageArea.scrollLeft;
	pageArea.dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			pointerId: 7,
			pointerType: "mouse",
			button: 0,
			clientX: 180,
			clientY: 180,
		}),
	);
	pageArea.dispatchEvent(
		new PointerEvent("pointermove", {
			bubbles: true,
			pointerId: 7,
			pointerType: "mouse",
			button: 0,
			clientX: 140,
			clientY: 150,
		}),
	);
	pageArea.dispatchEvent(
		new PointerEvent("pointerup", { bubbles: true, pointerId: 7, pointerType: "mouse" }),
	);
	expect(pageArea.scrollLeft).toBeGreaterThan(startScroll);
});

function createViewer(
	size: { width: number; height: number },
	backend: DocumentBackend,
): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = `${size.width}px`;
	element.style.height = `${size.height}px`;
	element.backend = backend;
	element.src = "./reader-test.pdf";
	return element;
}

function createBackend(pageCount: number, renderedPages: number[] = []): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount,
				async getPageSize(): Promise<{ width: number; height: number }> {
					return { width: 300, height: 400 };
				},
				async renderPage(pageIndex: number): Promise<PageVisual> {
					renderedPages.push(pageIndex);
					return {
						type: "pixels",
						width: 300,
						height: 400,
						pixels: createPixels(),
					};
				},
				dispose(): void {},
			};
		},
	};
}

function createPixels(): ArrayBuffer {
	const bytes = new Uint8ClampedArray(300 * 400 * 4);
	for (let offset = 0; offset < bytes.length; offset += 4) {
		bytes[offset] = 66;
		bytes[offset + 1] = 102;
		bytes[offset + 2] = 93;
		bytes[offset + 3] = 255;
	}
	return bytes.buffer;
}

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}

function restoreProperty(
	target: object,
	name: string,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor === undefined) {
		Reflect.deleteProperty(target, name);
		return;
	}
	Object.defineProperty(target, name, descriptor);
}
