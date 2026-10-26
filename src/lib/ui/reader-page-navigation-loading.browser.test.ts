import { afterEach, expect, test } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";

afterEach(() => {
	document.body.replaceChildren();
});

test("ignores page navigation while loading and allows it after the document opens", async () => {
	await import("../entry");
	const opening = createDeferred<PageSource>();
	const element = createViewer(createBackend(opening.promise));
	const documentLoaded = new Promise<void>((resolve) => {
		element.addEventListener("documentload", () => resolve(), { once: true });
	});
	document.body.append(element);

	await expect
		.poll(() => element.shadowRoot?.querySelector(".status")?.getAttribute("role"))
		.toBe("status");
	const pageArea = getPageArea(element);
	pressNext(pageArea);
	expect(element.page).toBe(1);

	opening.resolve(createPageSource());
	await documentLoaded;
	const secondPage = new Promise<void>((resolve) => {
		element.addEventListener("pagechange", (event) => {
			if (event.detail.page === 2) resolve();
		});
	});
	pressNext(pageArea);
	await secondPage;
	expect(element.page).toBe(2);
});

test("ignores page navigation when no document is open", async () => {
	await import("../entry");
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "900px";
	element.style.height = "620px";
	document.body.append(element);

	await expect
		.poll(() => element.shadowRoot?.querySelector(".status")?.getAttribute("role"))
		.toBe("status");
	const pageArea = getPageArea(element);
	pressNext(pageArea);
	pressNext(pageArea, "PageDown");
	expect(element.page).toBe(1);
});

function createViewer(backend: DocumentBackend): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "900px";
	element.style.height = "620px";
	element.backend = backend;
	element.src = "./reader-navigation-loading.pdf";
	return element;
}

function createBackend(source: Promise<PageSource>): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return source;
		},
	};
}

function createPageSource(): PageSource {
	return {
		pageCount: 2,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		async renderPage(): Promise<PageVisual> {
			return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
		},
		dispose() {},
	};
}

function getPageArea(element: PamphletViewerElement): HTMLElement {
	const pageArea = element.shadowRoot?.querySelector<HTMLElement>(".page-area");
	if (pageArea === null || pageArea === undefined) throw new Error("The page area is missing.");
	return pageArea;
}

function pressNext(pageArea: HTMLElement, key = "ArrowRight"): void {
	pageArea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
