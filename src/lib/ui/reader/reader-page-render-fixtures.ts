import { expect } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "@/lib/document/page-source";
import type { PamphletViewerElement } from "@/lib/public-api";

export interface RenderedPage {
	pageIndex: number;
	pixel: number[] | null;
}

export type PageColor = [number, number, number];
export type PageRenderer = (pageIndex: number) => Promise<PageVisual>;

export const COLORS: Record<number, PageColor> = {
	0: [220, 30, 30],
	1: [30, 80, 220],
	2: [30, 190, 70],
	3: [230, 170, 20],
	4: [180, 40, 190],
};

export function createViewer(
	backend: DocumentBackend,
	options: { page?: number; layout?: "single" | "spread"; width?: number } = {},
): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = `${options.width ?? 840}px`;
	element.style.height = "620px";
	element.page = options.page ?? 1;
	element.layout = options.layout ?? "single";
	element.backend = backend;
	element.src = "./reader-page-render-fixture.pdf";
	return element;
}

export function createBackend(pageCount: number, renderPage: PageRenderer): DocumentBackend {
	return createBackendFromSource(createPageSource(pageCount, renderPage));
}

export function createBackendFromSource(source: PageSource): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return source;
		},
	};
}

export function createPageSource(
	pageCount: number,
	renderPage: PageRenderer,
	options: {
		getPrefetchedPageSize?(): Promise<{ width: number; height: number }>;
		renderPrefetchedPage?(pageIndex: number): Promise<PageVisual>;
	} = {},
): PageSource {
	return {
		pageCount,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		async getPrefetchedPageSize() {
			if (options.getPrefetchedPageSize === undefined) {
				throw new DOMException("Prefetch is disabled for this test.", "AbortError");
			}
			return options.getPrefetchedPageSize();
		},
		renderPage,
		renderPrefetchedPage(pageIndex) {
			return (
				options.renderPrefetchedPage?.(pageIndex) ?? Promise.resolve(visualFor(pageIndex))
			);
		},
		dispose() {},
	};
}

export function visualFor(pageIndex: number): PageVisual {
	return createVisual(COLORS[pageIndex] ?? [100, 100, 100]);
}

export function createVisual([red, green, blue]: PageColor): PageVisual {
	return {
		type: "pixels",
		width: 1,
		height: 1,
		pixels: new Uint8Array([red, green, blue, 255]).buffer,
	};
}

export function waitForPageChange(element: PamphletViewerElement, page: number): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener(
			"pagechange",
			(event) => {
				if (event.detail.page === page) resolve();
			},
			{ once: true },
		),
	);
}

export function readRenderedPages(element: PamphletViewerElement): RenderedPage[] {
	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) return [];
	return Array.from(shadowRoot.querySelectorAll<HTMLElement>(".page-frame"), (frame) => {
		const imageData = frame
			.querySelector<HTMLCanvasElement>("canvas")
			?.getContext("2d")
			?.getImageData(0, 0, 1, 1).data;
		return {
			pageIndex: Number(frame.dataset.pageIndex),
			pixel: imageData === undefined ? null : [imageData[0], imageData[1], imageData[2]],
		};
	});
}

export async function expectRenderedPages(
	element: PamphletViewerElement,
	expected: readonly RenderedPage[],
): Promise<void> {
	await expect.poll(() => readRenderedPages(element)).toEqual(expected);
}

export function observePageFrames(element: PamphletViewerElement): {
	counts: number[];
	sampleTwoFrames(): Promise<void>;
	stop(): void;
} {
	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The viewer did not attach its shadow root.");
	const counts = [readRenderedPages(element).length];
	const observer = new MutationObserver(() => counts.push(readRenderedPages(element).length));
	observer.observe(shadowRoot, { childList: true, subtree: true });
	return {
		counts,
		sampleTwoFrames() {
			return new Promise((resolve) => {
				requestAnimationFrame(() => {
					counts.push(readRenderedPages(element).length);
					requestAnimationFrame(() => {
						counts.push(readRenderedPages(element).length);
						resolve();
					});
				});
			});
		},
		stop() {
			observer.disconnect();
		},
	};
}

export function createDeferred<Value>(): {
	promise: Promise<Value>;
	resolve(value: Value): void;
	reject(reason?: unknown): void;
} {
	let resolve: (value: Value) => void = () => undefined;
	let reject: (reason?: unknown) => void = () => undefined;
	const promise = new Promise<Value>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
