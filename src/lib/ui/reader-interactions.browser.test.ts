import { afterEach, beforeEach, expect, test } from "vitest";
import { page as browserPage, userEvent } from "vitest/browser";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";
import { ReaderFullscreenController } from "./reader-fullscreen.svelte";

const BOOKMARKS_STORAGE_KEY = "pamphlet-viewer.bookmarks.v1";

test("prevents selecting UI labels while preserving editable controls", async () => {
	await import("../entry");
	const element = createViewer({ width: 840, height: 620 }, createBackend(5));
	element.layout = "single";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const label = shadowRoot.querySelector<HTMLElement>(".reset-label");
	const pageInput = shadowRoot.querySelector<HTMLInputElement>('[aria-label="ページ番号"]');
	if (label === null || pageInput === null) {
		throw new Error("The viewer label or page input is missing.");
	}

	expect(getComputedStyle(label).userSelect).toBe("none");
	expect(getComputedStyle(pageInput).userSelect).toBe("text");
	pageInput.value = "2";
	pageInput.dispatchEvent(new Event("change", { bubbles: true }));
	await expect.poll(() => element.page).toBe(2);
});

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
	element.setConfig({
		chapters: [
			{ title: "後半", page: 7 },
			{ title: "前半", page: 2 },
			{ title: "無効", page: 20 },
		],
	});
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

test("selects fit and page layout together on desktop", async () => {
	await import("../entry");
	const element = createViewer({ width: 840, height: 620 }, createBackend(5));
	element.layout = "auto";
	element.fit = "page";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const select = element.shadowRoot?.querySelector<HTMLSelectElement>(
		'.view-mode-control select[aria-label="表示方法"]',
	);
	if (select === null || select === undefined) {
		throw new Error("The combined view mode selector was not rendered.");
	}
	const viewModeSelect = browserPage.elementLocator(select);
	await expect.element(viewModeSelect).toBeVisible();
	expect(Array.from(select.options, (option) => option.textContent)).toEqual([
		"自動・ページ全体",
		"自動・幅に合わせる",
		"単ページ・ページ全体",
		"単ページ・幅に合わせる",
		"見開き・ページ全体",
		"見開き・幅に合わせる",
	]);
	await viewModeSelect.selectOptions("spread-width");
	await expect.poll(() => element.layout).toBe("spread");
	await expect.poll(() => element.fit).toBe("width");
	await viewModeSelect.selectOptions("single-page");
	await expect.poll(() => element.layout).toBe("single");
	await expect.poll(() => element.fit).toBe("page");
});

test("applies shared design tokens to desktop controls", async () => {
	await import("../entry");
	const element = createViewer({ width: 840, height: 620 }, createBackend(5));
	element.layout = "single";
	element.setConfig({ chapters: [{ title: "前半", page: 1 }] });
	element.style.setProperty("--pamphlet-viewer-border-width", "3px");
	element.style.setProperty("--pamphlet-viewer-control-height", "38px");
	element.style.setProperty("--pamphlet-viewer-control-radius", "9px");
	element.style.setProperty("--pamphlet-viewer-field-radius", "8px");
	element.style.setProperty("--pamphlet-viewer-control-background", "rgb(17, 24, 39)");
	element.style.setProperty("--pamphlet-viewer-control-border", "rgb(18, 52, 86)");
	element.style.setProperty("--pamphlet-viewer-control-hover", "rgb(86, 120, 144)");
	element.style.setProperty("--pamphlet-viewer-disabled-text", "rgb(1, 2, 3)");
	element.style.setProperty("--pamphlet-viewer-focus-ring", "3px solid rgb(200, 20, 20)");
	element.style.setProperty("--pamphlet-viewer-control-gap", "10px");
	element.style.setProperty("--pamphlet-viewer-toolbar-gap", "23px");
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const zoomButton = shadowRoot.querySelector<HTMLButtonElement>(
		'.zoom-controls button[aria-label="拡大"]',
	);
	const pageInput = shadowRoot.querySelector<HTMLInputElement>('[aria-label="ページ番号"]');
	const chapterSelect = shadowRoot.querySelector<HTMLSelectElement>(
		'.toolbar > .chapter-control select[aria-label="章へ移動"]',
	);
	const viewSelect = shadowRoot.querySelector<HTMLSelectElement>('[aria-label="表示方法"]');
	const previousButton = shadowRoot.querySelector<HTMLButtonElement>(
		'button[aria-label="前のページ"]',
	);
	const thumbnailToggle = shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle");
	const navigationToolbar = shadowRoot.querySelector<HTMLElement>(".navigation-region .toolbar");
	const pageControls = shadowRoot.querySelector<HTMLElement>(".page-controls");
	const viewControls = shadowRoot.querySelector<HTMLElement>(".view-controls");
	const settingsToolbar = shadowRoot.querySelector<HTMLElement>(".settings-toolbar");
	if (
		zoomButton === null ||
		pageInput === null ||
		chapterSelect === null ||
		viewSelect === null ||
		previousButton === null ||
		thumbnailToggle === null ||
		navigationToolbar === null ||
		pageControls === null ||
		viewControls === null ||
		settingsToolbar === null
	) {
		throw new Error("The desktop controls for design token verification are missing.");
	}
	await expect.element(browserPage.elementLocator(chapterSelect)).toBeVisible();

	for (const [name, control] of [
		["zoom", zoomButton],
		["page number", pageInput],
		["chapter", chapterSelect],
		["view mode", viewSelect],
	] as const) {
		expect(getComputedStyle(control).minHeight, name).toBe("38px");
		expect(getComputedStyle(control).borderWidth).toBe("3px");
	}
	expect(getComputedStyle(zoomButton).borderRadius).toBe("9px");
	expect(getComputedStyle(pageInput).borderRadius).toBe("8px");
	expect(getComputedStyle(chapterSelect).backgroundColor).toBe("rgb(17, 24, 39)");
	expect(getComputedStyle(viewSelect).borderColor).toBe("rgb(18, 52, 86)");
	expect(getComputedStyle(previousButton).color).toBe("rgb(1, 2, 3)");
	expect(getComputedStyle(pageControls).gap).toBe("10px");
	expect(getComputedStyle(viewControls).gap).toBe("10px");
	expect(getComputedStyle(settingsToolbar).gap).toBe("23px");

	await userEvent.tab();
	expect(shadowRoot.activeElement).toBe(navigationToolbar);
	await userEvent.tab();
	expect(shadowRoot.activeElement).toBe(thumbnailToggle);
	expect(getComputedStyle(thumbnailToggle).outlineWidth).toBe("3px");
	expect(getComputedStyle(thumbnailToggle).outlineColor).toBe("rgb(200, 20, 20)");
	await browserPage.elementLocator(thumbnailToggle).hover();
	expect(getComputedStyle(thumbnailToggle).backgroundColor).toBe("rgb(86, 120, 144)");
});

test("shares touch target and compact toolbar tokens across mobile bars", async () => {
	await import("../entry");
	const element = createViewer({ width: 390, height: 620 }, createBackend(5));
	element.layout = "single";
	element.setConfig({ chapters: [{ title: "前半", page: 1 }] });
	element.style.setProperty("--pamphlet-viewer-touch-target-size", "48px");
	element.style.setProperty("--pamphlet-viewer-compact-toolbar-height", "60px");
	element.style.setProperty("--pamphlet-viewer-compact-toolbar-padding", "8px");
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const zoomButton = shadowRoot.querySelector<HTMLButtonElement>(
		'.zoom-controls button[aria-label="拡大"]',
	);
	const summary = shadowRoot.querySelector<HTMLElement>(".compact-navigation > summary");
	const chapterSelect = shadowRoot.querySelector<HTMLSelectElement>(
		'.compact-navigation-panel select[aria-label="章へ移動"]',
	);
	const bookmarkToggle = shadowRoot.querySelector<HTMLButtonElement>(
		".compact-navigation-panel .bookmark-toggle",
	);
	const settingsToolbar = shadowRoot.querySelector<HTMLElement>(".settings-toolbar");
	const navigationToolbar = shadowRoot.querySelector<HTMLElement>(".navigation-region .toolbar");
	if (
		zoomButton === null ||
		summary === null ||
		chapterSelect === null ||
		bookmarkToggle === null ||
		settingsToolbar === null ||
		navigationToolbar === null
	) {
		throw new Error("The mobile controls for design token verification are missing.");
	}

	for (const control of [zoomButton, chapterSelect, bookmarkToggle]) {
		expect(getComputedStyle(control).minHeight).toBe("48px");
	}
	expect(getComputedStyle(summary).width).toBe("48px");
	expect(getComputedStyle(summary).height).toBe("48px");
	for (const toolbar of [settingsToolbar, navigationToolbar]) {
		expect(getComputedStyle(toolbar).minHeight).toBe("60px");
		expect(getComputedStyle(toolbar).paddingTop).toBe("8px");
		expect(getComputedStyle(toolbar).paddingLeft).toBe("8px");
	}

	await browserPage.elementLocator(summary).click();
	await expect.element(browserPage.elementLocator(chapterSelect)).toBeVisible();
	await expect.element(browserPage.elementLocator(bookmarkToggle)).toBeVisible();
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
		element.setConfig({
			chapters: [
				{ title: "前半", page: 1 },
				{ title: "後半", page: 7 },
			],
		});
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
		const viewModeSelect = shadowRoot?.querySelector<HTMLSelectElement>(
			'.view-mode-control select[aria-label="表示方法"]',
		);
		const compactNavigation =
			shadowRoot?.querySelector<HTMLDetailsElement>(".compact-navigation");
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
			viewModeSelect === null ||
			viewModeSelect === undefined ||
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
		const viewModeRect = viewModeSelect.getBoundingClientRect();
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
		expect(viewControlsRect.left).toBeGreaterThanOrEqual(settingsToolbarRect.left);
		expect(viewControlsRect.right).toBeLessThanOrEqual(settingsToolbarRect.right);
		expect(viewModeRect.top).toBeGreaterThanOrEqual(settingsToolbarRect.top);
		expect(viewModeRect.bottom).toBeLessThanOrEqual(settingsToolbarRect.bottom);
		expect(viewModeRect.left).toBeGreaterThanOrEqual(settingsToolbarRect.left);
		expect(viewModeRect.right).toBeLessThanOrEqual(settingsToolbarRect.right);
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
		const bookmarkToggle =
			compactNavigation.querySelector<HTMLButtonElement>(".bookmark-toggle");
		if (bookmarkToggle === null)
			throw new Error("The compact bookmark toggle was not rendered.");
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
		const viewModeLocator = browserPage.elementLocator(viewModeSelect);
		await expect.element(viewModeLocator).toBeVisible();
		await viewModeLocator.selectOptions("single-width");
		await expect.poll(() => element.layout).toBe("single");
		await expect.poll(() => element.fit).toBe("width");
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
	const viewModeSelect = shadowRoot.querySelector<HTMLSelectElement>(
		'.view-mode-control select[aria-label="表示方法"]',
	);
	if (stageSlot === null || readerBody === null || toolbar === null || viewModeSelect === null) {
		throw new Error("The mobile reader controls are missing.");
	}
	await expect.poll(() => getComputedStyle(stageSlot).display).toBe("none");
	expect(getComputedStyle(readerBody).gridTemplateColumns.trim().split(" ")).toHaveLength(1);
	await expect.element(browserPage.elementLocator(viewModeSelect)).toBeVisible();
	expect(toolbar.getBoundingClientRect().height).toBeLessThanOrEqual(120);
	shadowRoot.querySelector<HTMLButtonElement>('[data-page-index="2"] .thumbnail-entry')?.click();
	await expect.poll(() => element.page).toBe(3);
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).toBeNull();
});

test.each([701, 840])("keeps toolbar controls inside a %i pixel host", async (width) => {
	const documentKey = new URL("./reader-test.pdf", document.baseURI).href;
	localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify({ [documentKey]: [3] }));
	await import("../entry");
	const element = createViewer({ width, height: 620 }, createBackend(12));
	element.setConfig({
		chapters: [
			{ title: "前半", page: 1 },
			{ title: "長い章タイトル", page: 7 },
		],
	});
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The reader shadow root was not rendered.");
	const shell = shadowRoot.querySelector<HTMLElement>(".viewer-shell");
	const navigationRegion = shadowRoot.querySelector<HTMLElement>(".navigation-region");
	const settingsRegion = shadowRoot.querySelector<HTMLElement>(".settings-region");
	const toolbar = shadowRoot.querySelector<HTMLElement>(".toolbar");
	const settingsToolbar = shadowRoot.querySelector<HTMLElement>(".settings-toolbar");
	if (
		shell === null ||
		navigationRegion === null ||
		settingsRegion === null ||
		toolbar === null ||
		settingsToolbar === null
	) {
		throw new Error("The desktop reader toolbars were not rendered.");
	}
	const shellRect = shell.getBoundingClientRect();
	const toolbarRect = toolbar.getBoundingClientRect();
	const settingsRect = settingsToolbar.getBoundingClientRect();
	const compact = width <= 701;
	const selectors = compact
		? [
				".page-controls",
				".zoom-controls",
				'.view-mode-control select[aria-label="表示方法"]',
				'.fullscreen-toggle[aria-label="全画面表示"]',
			]
		: [
				".page-controls",
				'.toolbar > .chapter-control select[aria-label="章へ移動"]',
				'.toolbar > .bookmark-list-control select[aria-label="ブックマーク一覧"]',
				".zoom-controls",
				'.view-mode-control select[aria-label="表示方法"]',
				'.fullscreen-toggle[aria-label="全画面表示"]',
			];
	const controls = selectors.map((selector) => {
		const control = shadowRoot.querySelector<HTMLElement>(selector);
		if (control === null) throw new Error(`The desktop control ${selector} was not rendered.`);
		return { selector, rect: control.getBoundingClientRect().toJSON() };
	});
	for (const { selector } of controls) {
		const control = shadowRoot.querySelector<HTMLElement>(selector);
		if (control === null) throw new Error(`The desktop control ${selector} disappeared.`);
		await expect.element(browserPage.elementLocator(control)).toBeVisible();
	}
	for (const { selector } of controls) {
		const control = shadowRoot.querySelector<HTMLElement>(selector);
		if (control === null) throw new Error(`The desktop control ${selector} disappeared.`);
		const rect = control.getBoundingClientRect();
		const parentRect =
			selector === ".zoom-controls" ||
			selector.includes("view-") ||
			selector.includes("fullscreen")
				? settingsRect
				: toolbarRect;
		expect(rect.left, `${selector} left edge`).toBeGreaterThanOrEqual(parentRect.left);
		expect(rect.right, `${selector} right edge`).toBeLessThanOrEqual(parentRect.right);
		expect(rect.left, `${selector} host left edge`).toBeGreaterThanOrEqual(shellRect.left);
		expect(rect.right, `${selector} host right edge`).toBeLessThanOrEqual(shellRect.right);
	}
	if (compact) {
		const readerBody = shadowRoot?.querySelector<HTMLElement>(".reader-body");
		const summary = shadowRoot?.querySelector<HTMLElement>(".compact-navigation summary");
		if (
			readerBody === null ||
			readerBody === undefined ||
			summary === null ||
			summary === undefined
		) {
			throw new Error("The compact navigation controls were not rendered.");
		}
		expect(settingsRect.bottom).toBeLessThanOrEqual(readerBody.getBoundingClientRect().top);
		expect(readerBody.getBoundingClientRect().bottom).toBeLessThanOrEqual(toolbarRect.top);
		await browserPage.elementLocator(summary).click();
		const panel = shadowRoot?.querySelector<HTMLElement>(".compact-navigation-panel");
		if (panel === null || panel === undefined)
			throw new Error("The compact navigation panel is missing.");
		await expect.element(browserPage.elementLocator(panel)).toBeVisible();
		const panelRect = panel.getBoundingClientRect();
		expect(panelRect.left).toBeGreaterThanOrEqual(toolbarRect.left);
		expect(panelRect.right).toBeLessThanOrEqual(toolbarRect.right);
	} else {
		for (const selector of [
			'.toolbar > .chapter-control select[aria-label="章へ移動"]',
			'.toolbar > .bookmark-list-control select[aria-label="ブックマーク一覧"]',
		]) {
			const control = shadowRoot?.querySelector<HTMLElement>(selector);
			if (control === null || control === undefined) {
				throw new Error(`The desktop control ${selector} was not rendered.`);
			}
			await expect.element(browserPage.elementLocator(control)).toBeVisible();
			const rect = control.getBoundingClientRect();
			expect(rect.left).toBeGreaterThanOrEqual(toolbarRect.left);
			expect(rect.right).toBeLessThanOrEqual(toolbarRect.right);
		}
		const navigationRect = navigationRegion.getBoundingClientRect();
		const settingsRegionRect = settingsRegion.getBoundingClientRect();
		const toolbarRegionsDoNotOverlap =
			navigationRect.right <= settingsRegionRect.left ||
			settingsRegionRect.right <= navigationRect.left ||
			navigationRect.bottom <= settingsRegionRect.top ||
			settingsRegionRect.bottom <= navigationRect.top;
		expect(toolbarRegionsDoNotOverlap).toBe(true);
	}
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
			Object.defineProperty(document, "fullscreenElement", {
				configurable: true,
				value: null,
			});
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
		if (completeRequest === null)
			throw new Error("The pending fullscreen request did not start.");
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
				async renderPrefetchedPage(): Promise<PageVisual> {
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
