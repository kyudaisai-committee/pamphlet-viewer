import { afterEach, beforeEach, expect, test } from "vitest";
import { page as browserPage, userEvent } from "vitest/browser";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";
import type { PamphletViewerElement } from "@/lib/public-api";

import { ReaderFullscreenController } from "./reader-fullscreen.svelte";

const BOOKMARKS_STORAGE_KEY = "pamphlet-viewer.bookmarks.v1";

test("prevents selecting UI labels while preserving editable controls", async () => {
	await import("@/lib/entry");
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
	await import("@/lib/entry");
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

test("navigates to validated configured chapters from the shared panel", async () => {
	await import("@/lib/entry");
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
	element.page = 3;
	await expect.poll(() => element.page).toBe(3);
	const tableOfContentsToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="chapters"]',
	);
	if (tableOfContentsToggle === null) {
		throw new Error("The table of contents toolbar control was not rendered.");
	}
	await browserPage.elementLocator(tableOfContentsToggle).click();
	const panel = shadowRoot.querySelector<HTMLElement>(".reader-panel");
	if (panel === null) throw new Error("The shared reader panel was not rendered.");
	await expect.element(browserPage.elementLocator(panel)).toBeVisible();
	expect(panel.querySelector("h2")?.textContent).toBe("目次");
	expect(
		Array.from(panel.querySelectorAll(".chapter-title"), (title) => title.textContent),
	).toEqual(["前半", "後半"]);
	expect(panel.querySelector("[aria-current='page'] .chapter-title")?.textContent).toBe("前半");
	expect(panel.querySelector("[aria-current='page'] .current-label")?.textContent).toBe(
		"現在の章",
	);
	expect(panel.querySelector('[data-chapter-page="2"] .chapter-page')?.textContent).toBe(
		"2ページ",
	);

	panel.querySelector<HTMLButtonElement>('[data-chapter-page="7"]')?.click();
	await expect.poll(() => element.page).toBe(7);
	await expect
		.poll(() => shadowRoot.querySelector("[data-chapter-page='7'][aria-current='page']"))
		.not.toBeNull();
	element.page = 9;
	await expect
		.poll(() => shadowRoot.querySelector("[data-chapter-page='7'][aria-current='page']"))
		.not.toBeNull();
});

test("selects fit and page layout together on desktop", async () => {
	await import("@/lib/entry");
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
	await import("@/lib/entry");
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
	const tableOfContentsToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="chapters"]',
	);
	const bookmarkPanelToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="bookmarks"]',
	);
	const viewSelect = shadowRoot.querySelector<HTMLSelectElement>('[aria-label="表示方法"]');
	const previousButton = shadowRoot.querySelector<HTMLButtonElement>(
		'button[aria-label="前のページ"]',
	);
	const thumbnailToggle = shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle");
	const navigationToolbar = shadowRoot.querySelector<HTMLElement>(".navigation-region .toolbar");
	const pageControls = shadowRoot.querySelector<HTMLElement>(".page-controls");
	const panelControls = shadowRoot.querySelector<HTMLElement>(".panel-controls");
	const viewControls = shadowRoot.querySelector<HTMLElement>(".view-controls");
	const settingsToolbar = shadowRoot.querySelector<HTMLElement>(".settings-toolbar");
	if (
		zoomButton === null ||
		pageInput === null ||
		tableOfContentsToggle === null ||
		bookmarkPanelToggle === null ||
		viewSelect === null ||
		previousButton === null ||
		thumbnailToggle === null ||
		navigationToolbar === null ||
		pageControls === null ||
		panelControls === null ||
		viewControls === null ||
		settingsToolbar === null
	) {
		throw new Error("The desktop controls for design token verification are missing.");
	}
	await expect.element(browserPage.elementLocator(tableOfContentsToggle)).toBeVisible();
	await expect.element(browserPage.elementLocator(bookmarkPanelToggle)).toBeVisible();

	for (const [name, control] of [
		["zoom", zoomButton],
		["page number", pageInput],
		["table of contents", tableOfContentsToggle],
		["bookmarks", bookmarkPanelToggle],
		["view mode", viewSelect],
	] as const) {
		expect(getComputedStyle(control).minHeight, name).toBe("38px");
		expect(getComputedStyle(control).borderWidth).toBe("3px");
	}
	expect(getComputedStyle(zoomButton).borderRadius).toBe("9px");
	expect(getComputedStyle(pageInput).borderRadius).toBe("8px");
	expect(getComputedStyle(tableOfContentsToggle).borderRadius).toBe("9px");
	expect(getComputedStyle(viewSelect).borderColor).toBe("rgb(18, 52, 86)");
	expect(getComputedStyle(previousButton).color).toBe("rgb(1, 2, 3)");
	expect(getComputedStyle(pageControls).gap).toBe("10px");
	expect(getComputedStyle(panelControls).gap).toBe("10px");
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
	await import("@/lib/entry");
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
	const pagePanelToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="pages"]',
	);
	const tableOfContentsToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="chapters"]',
	);
	const bookmarkPanelToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="bookmarks"]',
	);
	const settingsToolbar = shadowRoot.querySelector<HTMLElement>(".settings-toolbar");
	const navigationToolbar = shadowRoot.querySelector<HTMLElement>(".navigation-region .toolbar");
	if (
		zoomButton === null ||
		pagePanelToggle === null ||
		tableOfContentsToggle === null ||
		bookmarkPanelToggle === null ||
		settingsToolbar === null ||
		navigationToolbar === null
	) {
		throw new Error("The mobile controls for design token verification are missing.");
	}

	for (const control of [
		zoomButton,
		pagePanelToggle,
		tableOfContentsToggle,
		bookmarkPanelToggle,
	]) {
		expect(getComputedStyle(control).minHeight).toBe("48px");
	}
	expect(getComputedStyle(pagePanelToggle).width).toBe("48px");
	expect(getComputedStyle(tableOfContentsToggle).width).toBe("48px");
	expect(getComputedStyle(bookmarkPanelToggle).width).toBe("48px");
	for (const toolbar of [settingsToolbar, navigationToolbar]) {
		expect(getComputedStyle(toolbar).minHeight).toBe("60px");
		expect(getComputedStyle(toolbar).paddingTop).toBe("8px");
		expect(getComputedStyle(toolbar).paddingLeft).toBe("8px");
		expect(getComputedStyle(toolbar).justifyContent).toBe("space-between");
	}
	const navigationSpacer = shadowRoot.querySelector<HTMLElement>(
		".navigation-region .menu-bar-spacer",
	);
	const settingsSpacer = shadowRoot.querySelector<HTMLElement>(
		".settings-toolbar .menu-bar-spacer",
	);
	if (navigationSpacer === null || settingsSpacer === null) {
		throw new Error("The toolbar spacers are missing.");
	}
	expect(getComputedStyle(navigationSpacer).display).toBe("none");
	expect(getComputedStyle(settingsSpacer).display).toBe("none");
	const navigationRect = navigationToolbar.getBoundingClientRect();
	expect(
		shadowRoot.querySelector(".page-controls")?.getBoundingClientRect().left,
	).toBeGreaterThanOrEqual(navigationRect.left + 8);
	expect(
		shadowRoot.querySelector(".panel-controls")?.getBoundingClientRect().right,
	).toBeLessThanOrEqual(navigationRect.right - 8);

	await browserPage.elementLocator(tableOfContentsToggle).click();
	const panel = shadowRoot.querySelector<HTMLElement>(".reader-panel");
	if (panel === null) throw new Error("The shared reader panel did not open.");
	await expect.element(browserPage.elementLocator(panel)).toBeVisible();
	await browserPage.elementLocator(bookmarkPanelToggle).click();
	await expect.poll(() => panel.querySelector("h2")?.textContent).toBe("ブックマーク一覧");
	expect(shadowRoot.querySelector('[aria-label="章へ移動"]')).toBeNull();
});

test("persists bookmarks per document and restores the saved page list", async () => {
	localStorage.removeItem(BOOKMARKS_STORAGE_KEY);
	await import("@/lib/entry");
	const element = createViewer({ width: 840, height: 620 }, createBackend(5));
	element.layout = "single";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const bookmarkPanelToggle = shadowRoot.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="bookmarks"]',
	);
	if (bookmarkPanelToggle === null) {
		throw new Error("The bookmark panel toggle was not rendered.");
	}
	expect(bookmarkPanelToggle.disabled).toBe(false);
	await expect.element(browserPage.elementLocator(bookmarkPanelToggle)).toBeVisible();
	await browserPage.elementLocator(bookmarkPanelToggle).click();
	await expect.poll(() => bookmarkPanelToggle.getAttribute("aria-expanded")).toBe("true");
	const bookmarkAction = shadowRoot.querySelector<HTMLButtonElement>(".bookmark-current");
	if (bookmarkAction === null) throw new Error("The current-page bookmark action is missing.");
	await browserPage.elementLocator(bookmarkAction).click();
	await expect.poll(() => bookmarkAction.getAttribute("aria-pressed")).toBe("true");
	expect(shadowRoot.querySelector('[data-bookmark-page="1"]')?.textContent).toContain("1ページ");

	element.page = 3;
	await expect.poll(() => element.page).toBe(3);
	bookmarkAction.click();
	await expect.poll(() => bookmarkAction.getAttribute("aria-pressed")).toBe("true");
	const savedPageOne = shadowRoot.querySelector<HTMLButtonElement>('[data-bookmark-page="1"]');
	if (savedPageOne === null) throw new Error("The saved-page list was not rendered.");
	await browserPage.elementLocator(savedPageOne).click();
	await expect.poll(() => element.page).toBe(1);

	const secondDocumentPage = waitForPageChange(element);
	element.src = "./different-reader.pdf";
	await secondDocumentPage;
	expect(shadowRoot.querySelector(".reader-panel")).toBeNull();

	const restoredPage = waitForPageChange(element);
	element.src = "./reader-test.pdf";
	await restoredPage;
	bookmarkPanelToggle.click();
	await expect.poll(() => shadowRoot.querySelectorAll(".bookmark-entry").length).toBe(2);
	expect(
		Array.from(
			shadowRoot.querySelectorAll<HTMLElement>("[data-bookmark-page]"),
			(entry) => entry.dataset.bookmarkPage,
		),
	).toEqual(["1", "3"]);

	element.page = 3;
	const restoredBookmarkAction = shadowRoot.querySelector<HTMLButtonElement>(".bookmark-current");
	if (restoredBookmarkAction === null)
		throw new Error("The restored bookmark panel was not rendered.");
	await expect.poll(() => restoredBookmarkAction.getAttribute("aria-pressed")).toBe("true");
	await browserPage.elementLocator(restoredBookmarkAction).click();
	await expect.poll(() => restoredBookmarkAction.getAttribute("aria-pressed")).toBe("false");
	expect(
		Array.from(
			shadowRoot.querySelectorAll<HTMLElement>("[data-bookmark-page]"),
			(entry) => entry.dataset.bookmarkPage,
		),
	).toEqual(["1"]);
});

test("synchronizes bookmarks between viewer instances and storage events", async () => {
	localStorage.removeItem(BOOKMARKS_STORAGE_KEY);
	await import("@/lib/entry");
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
		'[data-panel-toggle="bookmarks"]',
	);
	const secondButtonElement = second.shadowRoot?.querySelector<HTMLButtonElement>(
		'[data-panel-toggle="bookmarks"]',
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
	secondButtonElement.click();
	await expect.poll(() => second.shadowRoot?.querySelector(".bookmark-current")).not.toBeNull();
	const firstBookmarkAction =
		first.shadowRoot?.querySelector<HTMLButtonElement>(".bookmark-current");
	const secondBookmarkAction =
		second.shadowRoot?.querySelector<HTMLButtonElement>(".bookmark-current");
	if (
		firstBookmarkAction === null ||
		firstBookmarkAction === undefined ||
		secondBookmarkAction === null ||
		secondBookmarkAction === undefined
	) {
		throw new Error("The bookmark panels did not open for both viewers.");
	}
	await browserPage.elementLocator(firstBookmarkAction).click();
	await expect.poll(() => second.shadowRoot?.querySelectorAll(".bookmark-entry").length).toBe(1);

	const documentKey = new URL("./reader-test.pdf", document.baseURI).href;
	const newValue = JSON.stringify({ [documentKey]: [2, 4] });
	localStorage.setItem(BOOKMARKS_STORAGE_KEY, newValue);
	window.dispatchEvent(new StorageEvent("storage", { key: BOOKMARKS_STORAGE_KEY, newValue }));
	await expect
		.poll(() =>
			Array.from(
				second.shadowRoot?.querySelectorAll<HTMLElement>("[data-bookmark-page]") ?? [],
				(entry) => entry.dataset.bookmarkPage,
			),
		)
		.toEqual(["2", "4"]);
});

test.each([320, 390])(
	"uses the shared panels for chapter and bookmark navigation at %i pixels",
	async (width) => {
		const documentKey = new URL("./reader-test.pdf", document.baseURI).href;
		localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify({ [documentKey]: [3, 8] }));
		await import("@/lib/entry");
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
		if (shadowRoot === null) throw new Error("The reader shadow root was not rendered.");
		const tableOfContentsToggle = shadowRoot.querySelector<HTMLButtonElement>(
			'[data-panel-toggle="chapters"]',
		);
		const bookmarkPanelToggle = shadowRoot.querySelector<HTMLButtonElement>(
			'[data-panel-toggle="bookmarks"]',
		);
		const stageSlot = shadowRoot.querySelector<HTMLElement>(".stage-slot");
		const readerBody = shadowRoot.querySelector<HTMLElement>(".reader-body");
		const pageArea = shadowRoot.querySelector<HTMLElement>(".page-area");
		if (
			tableOfContentsToggle === null ||
			bookmarkPanelToggle === null ||
			stageSlot === null ||
			readerBody === null ||
			pageArea === null
		) {
			throw new Error("The mobile reader panel controls were not rendered.");
		}
		expect(element.getBoundingClientRect().width).toBe(width);
		expect(shadowRoot.querySelector(".compact-navigation")).toBeNull();

		await browserPage.elementLocator(tableOfContentsToggle).click();
		await expect.poll(() => shadowRoot.querySelector(".reader-panel")).not.toBeNull();
		await expect.poll(() => getComputedStyle(stageSlot).display).toBe("none");
		expect(getComputedStyle(readerBody).gridTemplateColumns.trim().split(" ")).toHaveLength(1);
		const chapterEntry = shadowRoot.querySelector<HTMLButtonElement>('[data-chapter-page="7"]');
		if (chapterEntry === null) throw new Error("The selected chapter was not rendered.");
		await browserPage.elementLocator(chapterEntry).click();
		await expect.poll(() => element.page).toBe(7);
		await expect.poll(() => shadowRoot.querySelector(".reader-panel")).toBeNull();
		await expect.poll(() => shadowRoot.activeElement).toBe(pageArea);

		await browserPage.elementLocator(bookmarkPanelToggle).click();
		await expect.poll(() => shadowRoot.querySelectorAll(".bookmark-entry").length).toBe(2);
		const savedBookmark = shadowRoot.querySelector<HTMLButtonElement>(
			'[data-bookmark-page="8"]',
		);
		if (savedBookmark === null) throw new Error("The saved page was not rendered.");
		await browserPage.elementLocator(savedBookmark).click();
		await expect.poll(() => element.page).toBe(8);
		await expect.poll(() => shadowRoot.querySelector(".reader-panel")).toBeNull();
		await expect.poll(() => shadowRoot.activeElement).toBe(pageArea);

		const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
		const viewModeSelect = shadowRoot.querySelector<HTMLSelectElement>(
			'.view-mode-control select[aria-label="表示方法"]',
		);
		if (zoomSlider === null || viewModeSelect === null) {
			throw new Error("The mobile display controls were not rendered.");
		}
		await browserPage.elementLocator(viewModeSelect).selectOptions("single-width");
		await expect.poll(() => element.layout).toBe("single");
		await expect.poll(() => element.fit).toBe("width");
		await expect.poll(() => Number(zoomSlider.value)).toBe(1);
	},
);
test("uses the host width for mobile thumbnail mode and closes after selection", async () => {
	await import("@/lib/entry");
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

test.each([700, 701, 702, 703, 800, 837, 839, 840, 873, 1120])(
	"keeps toolbar controls inside a %i pixel host",
	async (width) => {
		const documentKey = new URL("./reader-test.pdf", document.baseURI).href;
		localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify({ [documentKey]: [3] }));
		await import("@/lib/entry");
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
		const compact = shell.clientWidth <= 700;
		const selectors = [
			".page-controls",
			'[data-panel-toggle="chapters"]',
			'[data-panel-toggle="bookmarks"]',
			".zoom-controls",
			'.view-mode-control select[aria-label="表示方法"]',
			'.fullscreen-toggle[aria-label="全画面表示"]',
		];
		const controls = selectors.map((selector) => {
			const control = shadowRoot.querySelector<HTMLElement>(selector);
			if (control === null)
				throw new Error(`The desktop control ${selector} was not rendered.`);
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
			const readerBody = shadowRoot.querySelector<HTMLElement>(".reader-body");
			const tableOfContentsToggle = shadowRoot.querySelector<HTMLButtonElement>(
				'[data-panel-toggle="chapters"]',
			);
			if (readerBody === null || tableOfContentsToggle === null) {
				throw new Error("The compact navigation controls were not rendered.");
			}
			expect(settingsRect.bottom).toBeLessThanOrEqual(readerBody.getBoundingClientRect().top);
			expect(readerBody.getBoundingClientRect().bottom).toBeLessThanOrEqual(toolbarRect.top);
			await browserPage.elementLocator(tableOfContentsToggle).click();
			const panel = shadowRoot.querySelector<HTMLElement>(".reader-panel");
			if (panel === null || panel === undefined)
				throw new Error("The shared reader panel is missing.");
			await expect.element(browserPage.elementLocator(panel)).toBeVisible();
			const panelRect = panel.getBoundingClientRect();
			const bodyRect = readerBody.getBoundingClientRect();
			expect(panelRect.left).toBeGreaterThanOrEqual(bodyRect.left);
			expect(panelRect.right).toBeLessThanOrEqual(bodyRect.right);
		} else {
			const navigationRect = navigationRegion.getBoundingClientRect();
			const settingsRegionRect = settingsRegion.getBoundingClientRect();
			if (shell.clientWidth <= 837) {
				const shellBorderWidth = Number.parseFloat(getComputedStyle(shell).borderLeftWidth);
				expect(settingsRegionRect.left).toBeCloseTo(shellRect.left + shellBorderWidth, 0);
				expect(settingsRegionRect.right).toBeCloseTo(shellRect.right - shellBorderWidth, 0);
				expect(getComputedStyle(settingsToolbar).backgroundColor).toBe("rgb(36, 40, 46)");
				expect(settingsRect.width).toBeCloseTo(settingsRegionRect.width, 0);
			}
			const toolbarRegionsDoNotOverlap =
				navigationRect.right <= settingsRegionRect.left ||
				settingsRegionRect.right <= navigationRect.left ||
				navigationRect.bottom <= settingsRegionRect.top ||
				settingsRegionRect.bottom <= navigationRect.top;
			expect(toolbarRegionsDoNotOverlap).toBe(true);
		}
	},
);

test("falls back to a top-layer fullscreen reader and restores the embed size on Escape", async () => {
	await import("@/lib/entry");
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
	await import("@/lib/entry");
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
