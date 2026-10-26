// SPDX-License-Identifier: MIT

import { afterEach, expect, test } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";

afterEach(() => {
	document.body.replaceChildren();
});

test("exposes setConfig on the registered prototype and applies it before connection", async () => {
	const constructor = await registerViewer();
	const viewer = createViewer();
	const prototype = constructor.prototype;

	expect(Object.hasOwn(prototype, "setConfig")).toBe(true);
	expect(Object.getOwnPropertyDescriptor(prototype, "config")).toBeUndefined();
	expect(Reflect.get(viewer, "config")).toBeUndefined();
	expect(getObservedAttributes(constructor)).not.toContain("config");

	viewer.setConfig({ chapters: [{ title: "初期章", page: 1 }] });
	const pageChanged = waitForPageChange(viewer);
	document.body.append(viewer);
	await pageChanged;

	await expect.poll(() => getChapterTitles(viewer)).toEqual(["章を選択", "初期章"]);
});

test("replaces connected settings, clears chapters, and keeps instances independent", async () => {
	await registerViewer();
	const firstViewer = createViewer();
	const secondViewer = createViewer();
	firstViewer.setConfig({ chapters: [{ title: "一つ目", page: 1 }] });
	secondViewer.setConfig({ chapters: [{ title: "二つ目", page: 2 }] });
	const firstPageChanged = waitForPageChange(firstViewer);
	const secondPageChanged = waitForPageChange(secondViewer);
	document.body.append(firstViewer, secondViewer);
	await Promise.all([firstPageChanged, secondPageChanged]);

	await expect.poll(() => getChapterTitles(firstViewer)).toEqual(["章を選択", "一つ目"]);
	await expect.poll(() => getChapterTitles(secondViewer)).toEqual(["章を選択", "二つ目"]);

	firstViewer.setConfig({ chapters: [{ title: "置換後", page: 3 }] });
	await expect.poll(() => getChapterTitles(firstViewer)).toEqual(["章を選択", "置換後"]);
	await expect.poll(() => getChapterTitles(secondViewer)).toEqual(["章を選択", "二つ目"]);

	firstViewer.setConfig({});
	await expect.poll(() => getChapterTitles(firstViewer)).toEqual([]);
});

test("ignores the removed config property and attribute", async () => {
	const constructor = await registerViewer();
	const viewer = createViewer();
	const oldConfig = { chapters: [{ title: "旧設定", page: 1 }] };
	Reflect.set(viewer, "config", oldConfig);
	viewer.setAttribute("config", JSON.stringify(oldConfig));
	const pageChanged = waitForPageChange(viewer);
	document.body.append(viewer);
	await pageChanged;

	await expect.poll(() => getChapterTitles(viewer)).toEqual([]);
	expect(Object.getOwnPropertyDescriptor(constructor.prototype, "config")).toBeUndefined();
});

test("retains settings across disconnection and reattachment", async () => {
	await registerViewer();
	const viewer = createViewer();
	viewer.setConfig({ chapters: [{ title: "接続前", page: 1 }] });
	const firstPageChanged = waitForPageChange(viewer);
	document.body.append(viewer);
	await firstPageChanged;
	await expect.poll(() => getChapterTitles(viewer)).toEqual(["章を選択", "接続前"]);

	viewer.remove();
	await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
	viewer.setConfig({ chapters: [{ title: "再接続後", page: 2 }] });
	const secondPageChanged = waitForPageChange(viewer);
	document.body.append(viewer);
	await secondPageChanged;
	await expect.poll(() => getChapterTitles(viewer)).toEqual(["章を選択", "再接続後"]);

	viewer.setConfig({ chapters: [{ title: "再接続後の更新", page: 3 }] });
	await expect.poll(() => getChapterTitles(viewer)).toEqual(["章を選択", "再接続後の更新"]);
});

async function registerViewer(): Promise<CustomElementConstructor> {
	await import("../entry");
	const constructor = customElements.get("pamphlet-viewer");
	if (constructor === undefined) throw new Error("The pamphlet viewer was not registered.");
	return constructor;
}

function createViewer(): PamphletViewerElement {
	const viewer = document.createElement("pamphlet-viewer");
	viewer.style.width = "840px";
	viewer.style.height = "560px";
	viewer.layout = "single";
	viewer.backend = createBackend();
	viewer.src = "./set-config.pdf";
	return viewer;
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

function getChapterTitles(viewer: PamphletViewerElement): Array<string | null> {
	const chapterSelect = viewer.shadowRoot?.querySelector<HTMLSelectElement>(
		'select[aria-label="章へ移動"]',
	);
	return chapterSelect === undefined || chapterSelect === null
		? []
		: Array.from(chapterSelect.options, (option) => option.textContent);
}

function getObservedAttributes(constructor: CustomElementConstructor): string[] {
	const value: unknown = Reflect.get(constructor, "observedAttributes");
	if (
		!Array.isArray(value) ||
		!value.every((attribute: unknown) => typeof attribute === "string")
	) {
		throw new Error("The viewer did not expose its observed attributes.");
	}
	return value;
}

function waitForPageChange(viewer: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) => {
		viewer.addEventListener("pagechange", () => resolve(), { once: true });
	});
}
