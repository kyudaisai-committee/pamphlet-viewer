import { afterEach, expect, test } from "vitest";
import { page as browserPage } from "vitest/browser";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";
import type { PamphletViewerElement } from "@/lib/public-api";

afterEach(async () => {
	document.body.replaceChildren();
	await browserPage.viewport(1280, 900);
});

test.each([390, 840])(
	"restores the selected panel through the generic sidebar toggle at %ipx",
	async (width) => {
		const element = await createLoadedViewer(width);
		const shadowRoot = getShadowRoot(element);
		const sidebarToggle = getRequiredButton(shadowRoot, ".thumbnail-toggle");
		const chapterToggle = getRequiredButton(shadowRoot, '[data-panel-toggle="chapters"]');
		const bookmarkToggle = getRequiredButton(shadowRoot, '[data-panel-toggle="bookmarks"]');

		expect(sidebarToggle.getAttribute("aria-expanded")).toBe("false");
		expect(sidebarToggle.getAttribute("aria-label")).toBe("サイドバーを開く");
		sidebarToggle.click();
		await expect.poll(() => getPanelHeading(shadowRoot)).toBe("ページ一覧");
		expect(sidebarToggle.getAttribute("aria-expanded")).toBe("true");
		expect(sidebarToggle.getAttribute("aria-label")).toBe("サイドバーを閉じる");
		sidebarToggle.click();
		await expect.poll(() => shadowRoot.querySelector(".reader-panel")).toBeNull();

		chapterToggle.click();
		await expect.poll(() => getPanelHeading(shadowRoot)).toBe("目次");
		sidebarToggle.click();
		await expect.poll(() => shadowRoot.querySelector(".reader-panel")).toBeNull();
		expect(sidebarToggle.getAttribute("aria-expanded")).toBe("false");
		sidebarToggle.click();
		await expect.poll(() => getPanelHeading(shadowRoot)).toBe("目次");

		bookmarkToggle.click();
		await expect.poll(() => getPanelHeading(shadowRoot)).toBe("ブックマーク一覧");
		expect(chapterToggle.getAttribute("aria-expanded")).toBe("false");
		expect(bookmarkToggle.getAttribute("aria-expanded")).toBe("true");
		chapterToggle.click();
		await expect.poll(() => getPanelHeading(shadowRoot)).toBe("目次");

		const closeButton = getRequiredButton(shadowRoot, ".reader-panel .panel-close");
		closeButton.click();
		await expect.poll(() => shadowRoot.querySelector(".reader-panel")).toBeNull();
		await expect.poll(() => shadowRoot.activeElement).toBe(sidebarToggle);
		sidebarToggle.click();
		await expect.poll(() => getPanelHeading(shadowRoot)).toBe("目次");
	},
);

test("keeps the last panel selected when a mobile chapter choice closes the sidebar", async () => {
	const element = await createLoadedViewer(390);
	const shadowRoot = getShadowRoot(element);
	const sidebarToggle = getRequiredButton(shadowRoot, ".thumbnail-toggle");
	const chapterToggle = getRequiredButton(shadowRoot, '[data-panel-toggle="chapters"]');

	chapterToggle.click();
	await expect.poll(() => getPanelHeading(shadowRoot)).toBe("目次");
	const chapterEntry = getRequiredButton(shadowRoot, '[data-chapter-page="3"]');
	chapterEntry.click();
	await expect.poll(() => element.page).toBe(3);
	await expect.poll(() => shadowRoot.querySelector(".reader-panel")).toBeNull();

	sidebarToggle.click();
	await expect.poll(() => getPanelHeading(shadowRoot)).toBe("目次");
});

test("falls back to the page list when the selected chapter tab is removed", async () => {
	const element = await createLoadedViewer(840);
	const shadowRoot = getShadowRoot(element);
	const sidebarToggle = getRequiredButton(shadowRoot, ".thumbnail-toggle");
	const chapterToggle = getRequiredButton(shadowRoot, '[data-panel-toggle="chapters"]');

	chapterToggle.click();
	await expect.poll(() => getPanelHeading(shadowRoot)).toBe("目次");
	sidebarToggle.click();
	await expect.poll(() => shadowRoot.querySelector(".reader-panel")).toBeNull();
	element.setConfig({ chapters: [] });
	await expect.poll(() => shadowRoot.querySelector('[data-panel-toggle="chapters"]')).toBeNull();

	sidebarToggle.click();
	await expect.poll(() => getPanelHeading(shadowRoot)).toBe("ページ一覧");
});

test("hides the bookmark tab while bookmarks are unavailable", async () => {
	await import("@/lib/entry");
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "840px";
	element.style.height = "620px";
	element.src = "";
	const ready = new Promise<void>((resolve) =>
		element.addEventListener("ready", () => resolve(), { once: true }),
	);
	document.body.append(element);
	await ready;
	const shadowRoot = getShadowRoot(element);
	getRequiredButton(shadowRoot, ".thumbnail-toggle").click();
	await expect.poll(() => shadowRoot.querySelector(".reader-panel")).not.toBeNull();
	expect(shadowRoot.querySelector('.reader-panel [aria-label="ブックマーク一覧"]')).toBeNull();
});

async function createLoadedViewer(width: number): Promise<PamphletViewerElement> {
	await import("@/lib/entry");
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = `${width}px`;
	element.style.height = "620px";
	element.layout = "single";
	element.backend = createBackend();
	element.src = "./reader-panel-state-test.pdf";
	element.setConfig({
		chapters: [
			{ title: "前半", page: 1 },
			{ title: "後半", page: 3 },
		],
	});
	const loaded = new Promise<void>((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
	document.body.append(element);
	await loaded;
	return element;
}

function createBackend(): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount: 4,
				async getPageSize(): Promise<{ width: number; height: number }> {
					return { width: 300, height: 400 };
				},
				async renderPage(): Promise<PageVisual> {
					return createVisual();
				},
				async renderPrefetchedPage(): Promise<PageVisual> {
					return createVisual();
				},
				dispose(): void {},
			};
		},
	};
}

function createVisual(): PageVisual {
	return {
		type: "pixels",
		width: 1,
		height: 1,
		pixels: new Uint8Array([66, 102, 93, 255]).buffer,
	};
}

function getShadowRoot(element: PamphletViewerElement): ShadowRoot {
	if (element.shadowRoot === null) throw new Error("The reader shadow root is missing.");
	return element.shadowRoot;
}

function getRequiredButton(shadowRoot: ShadowRoot, selector: string): HTMLButtonElement {
	const button = shadowRoot.querySelector<HTMLButtonElement>(selector);
	if (button === null) throw new Error(`The button for ${selector} is missing.`);
	return button;
}

function getPanelHeading(shadowRoot: ShadowRoot): string | null {
	return shadowRoot.querySelector(".reader-panel h2")?.textContent ?? null;
}
