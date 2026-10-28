import { afterEach, expect, test } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";
import type { PamphletViewerElement } from "@/lib/public-api";

const RENDERING_STATUS_MESSAGE = "ページを描画しています。";

afterEach(() => {
	document.body.replaceChildren();
});

test("does not show the rendering status after a quick page change", async () => {
	await import("@/lib/entry");
	const render = createDeferred<PageVisual>();
	const renderStarted = createDeferred<void>();
	const element = createViewer({
		async renderPage(pageIndex: number): Promise<PageVisual> {
			if (pageIndex === 1) {
				renderStarted.resolve();
				return render.promise;
			}
			return createVisual();
		},
	});
	const firstPage = waitForPageChange(element, 1);
	document.body.append(element);
	await firstPage;

	const secondPage = waitForPageChange(element, 2);
	element.page = 2;
	await renderStarted.promise;
	await delay(100);
	expect(element.shadowRoot?.querySelector(".status")?.textContent).not.toContain(
		RENDERING_STATUS_MESSAGE,
	);

	render.resolve(createVisual());
	await secondPage;
	await delay(450);
	expect(element.shadowRoot?.querySelector(".status")).toBeNull();
	expect(element.shadowRoot?.textContent).not.toContain(RENDERING_STATUS_MESSAGE);
});

test("shows the rendering status after it stays pending for 400 ms", async () => {
	await import("@/lib/entry");
	const render = createDeferred<PageVisual>();
	const renderStarted = createDeferred<void>();
	const element = createViewer({
		async renderPage(pageIndex: number): Promise<PageVisual> {
			if (pageIndex === 1) {
				renderStarted.resolve();
				return render.promise;
			}
			return createVisual();
		},
	});
	const firstPage = waitForPageChange(element, 1);
	document.body.append(element);
	await firstPage;

	const secondPage = waitForPageChange(element, 2);
	element.page = 2;
	await renderStarted.promise;
	await expect
		.poll(() => element.shadowRoot?.querySelector(".status")?.textContent)
		.toContain(RENDERING_STATUS_MESSAGE);

	render.resolve(createVisual());
	await secondPage;
	await expect.poll(() => element.shadowRoot?.querySelector(".status")).toBeNull();
});

function createViewer(renderer: {
	renderPage(pageIndex: number): Promise<PageVisual>;
}): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "840px";
	element.style.height = "620px";
	element.layout = "single";
	element.backend = createBackend(renderer);
	element.src = "./reader-rendering-status.pdf";
	return element;
}

function createBackend(renderer: {
	renderPage(pageIndex: number): Promise<PageVisual>;
}): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount: 2,
				async getPageSize() {
					return { width: 300, height: 400 };
				},
				async getPrefetchedPageSize() {
					throw new DOMException("Skip prerendering in this test.", "AbortError");
				},
				renderPage(pageIndex: number) {
					return renderer.renderPage(pageIndex);
				},
				async renderPrefetchedPage() {
					return createVisual();
				},
				dispose() {},
			};
		},
	};
}

function createVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]).buffer };
}

function waitForPageChange(element: PamphletViewerElement, page: number): Promise<void> {
	return new Promise((resolve) => {
		element.addEventListener(
			"pagechange",
			(event) => {
				if (event.detail.page === page) resolve();
			},
			{ once: true },
		);
	});
}

function createDeferred<Value>(): {
	promise: Promise<Value>;
	resolve(value: Value): void;
} {
	let resolve: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
