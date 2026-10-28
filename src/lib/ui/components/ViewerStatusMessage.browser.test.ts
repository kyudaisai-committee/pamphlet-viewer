import { tick } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";
import type { PamphletViewerElement } from "@/lib/public-api";

const RENDERING_STATUS_MESSAGE = "ページを描画しています。";

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
});

test("delays the rendering status by 200 ms when no page is visible", async () => {
	await import("@/lib/entry");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const render = createDeferred<PageVisual>();
	const renderStarted = createDeferred<void>();
	const element = createViewer({
		async renderPage(): Promise<PageVisual> {
			renderStarted.resolve();
			return render.promise;
		},
	});
	const firstPage = waitForPageChange(element, 1);
	document.body.append(element);
	await renderStarted.promise;

	await tick();
	await vi.advanceTimersByTimeAsync(199);
	expect(element.shadowRoot?.querySelector(".status")?.textContent).not.toContain(
		RENDERING_STATUS_MESSAGE,
	);
	await vi.advanceTimersByTimeAsync(1);
	await tick();
	expect(element.shadowRoot?.querySelector(".status")?.textContent).toContain(
		RENDERING_STATUS_MESSAGE,
	);

	render.resolve(createVisual(220, 40, 40));
	await firstPage;
	await tick();
	expect(element.shadowRoot?.querySelector(".status")).toBeNull();
});

function createViewer(renderer: { renderPage(): Promise<PageVisual> }): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "840px";
	element.style.height = "620px";
	element.layout = "single";
	element.backend = createBackend(renderer);
	element.src = "./reader-rendering-status.pdf";
	return element;
}

function createBackend(renderer: { renderPage(): Promise<PageVisual> }): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount: 1,
				async getPageSize() {
					return { width: 300, height: 400 };
				},
				renderPage() {
					return renderer.renderPage();
				},
				async renderPrefetchedPage() {
					return createVisual(220, 40, 40);
				},
				dispose() {},
			};
		},
	};
}

function createVisual(red: number, green: number, blue: number): PageVisual {
	return {
		type: "pixels",
		width: 1,
		height: 1,
		pixels: new Uint8Array([red, green, blue, 255]).buffer,
	};
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
