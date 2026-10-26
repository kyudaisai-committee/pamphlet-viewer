import { afterEach, expect, test } from "vitest";

import type { PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";

afterEach(() => {
	document.body.replaceChildren();
});

test("upgrades preconfigured elements once and keeps child styles inside the shadow root", async () => {
	const container = document.createElement("div");
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	container.append(element);
	document.body.append(container);
	element.style.width = "840px";
	element.style.height = "560px";

	const openCalls: string[] = [];
	const openCompletion: { resolve?: (source: PageSource) => void } = {};
	element.backend = {
		open(source) {
			openCalls.push(source);
			return new Promise((resolve) => {
				openCompletion.resolve = resolve;
			});
		},
	};
	element.src = "brochure.pdf";
	element.page = 1;
	element.layout = "single";
	element.fit = "page";

	const pageChanged = new Promise<void>((resolve) => {
		container.addEventListener(
			"pagechange",
			(event) => {
				expect(event.bubbles).toBe(true);
				expect(event.composed).toBe(true);
				expect(event.detail.page).toBe(1);
				resolve();
			},
			{ once: true },
		);
	});

	await import("../entry");
	element.setConfig({ chapters: [{ title: "はじめに", page: 1 }] });
	await expect.poll(() => openCalls.length).toBe(1);
	await new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);
	const resolveOpen = openCompletion.resolve;
	if (resolveOpen === undefined) throw new Error("The fake PDF backend did not start loading.");
	resolveOpen(createPageSource());
	await pageChanged;
	await new Promise((resolve) => setTimeout(resolve, 50));

	expect(openCalls).toEqual([new URL("brochure.pdf", element.ownerDocument.baseURI).href]);
	expect(element.getAttribute("src")).toBe("brochure.pdf");
	expect(element.src).toBe(new URL("brochure.pdf", element.ownerDocument.baseURI).href);

	const shadowRoot = element.shadowRoot;
	expect(shadowRoot).not.toBeNull();
	const toolbar = shadowRoot?.querySelector<HTMLElement>(".toolbar");
	const chapterSelect = shadowRoot?.querySelector<HTMLSelectElement>(
		'select[aria-label="章へ移動"]',
	);
	const canvas = shadowRoot?.querySelector<HTMLCanvasElement>(".page-canvas");
	expect(toolbar).not.toBeNull();
	expect(chapterSelect?.selectedOptions[0]?.textContent).toBe("はじめに");
	expect(canvas).not.toBeNull();
	expect(getComputedStyle(toolbar as HTMLElement).display).toBe("flex");
	expect(getComputedStyle(canvas as HTMLCanvasElement).display).toBe("block");
	expect(openCalls).toHaveLength(1);

	const errors: string[] = [];
	element.addEventListener("error", (event) => errors.push(event.detail.code));
	element.page = 9;
	await expect.poll(() => errors).toEqual(["invalid-page"]);
	shadowRoot
		?.querySelector<HTMLButtonElement>('.zoom-controls button[aria-label="拡大"]')
		?.click();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(errors).toEqual(["invalid-page"]);
});

test("opens and renders a real ranged PDF through the custom element", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	expect(resetResponse.ok).toBe(true);
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "840px";
	element.style.height = "560px";
	element.src = "/__pdfium-range-fixture.pdf";
	element.layout = "single";
	document.body.append(element);

	const pageChanged = new Promise<void>((resolve) => {
		element.addEventListener("pagechange", () => resolve(), { once: true });
	});
	await import("../entry");
	await pageChanged;

	const canvas = element.shadowRoot?.querySelector<HTMLCanvasElement>(".page-canvas");
	await expect.poll(() => canvas?.width ?? 0).toBeGreaterThan(0);
	const context = canvas?.getContext("2d");
	if (canvas === null || canvas === undefined || context === null || context === undefined) {
		throw new Error("The custom element did not render a page canvas.");
	}
	const pixel = context.getImageData(
		Math.floor(canvas.width / 2),
		Math.floor(canvas.height / 2),
		1,
		1,
	).data;
	expect(pixel[2]).toBeGreaterThan(100);

	const metricsResponse = await fetch("/__pdfium-range-metrics");
	expect(metricsResponse.ok).toBe(true);
	const metrics = (await metricsResponse.json()) as {
		requestedBytes: number;
		fullRequests: number;
		fileLength: number;
	};
	expect(metrics.fullRequests).toBe(0);
	expect(metrics.requestedBytes).toBeLessThan(metrics.fileLength);
});

test("keeps an omitted src empty and resolves raw src attributes against the document", async () => {
	const emptyElement = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	const ready = new Promise<void>((resolve) => {
		emptyElement.addEventListener("ready", () => resolve(), { once: true });
	});
	document.body.append(emptyElement);
	await ready;
	expect(emptyElement.getAttribute("src")).toBeNull();
	expect(emptyElement.src).toBe("");

	const attributeElement = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	attributeElement.style.width = "840px";
	attributeElement.style.height = "560px";
	attributeElement.backend = {
		async open(): Promise<PageSource> {
			return createPageSource();
		},
	};
	attributeElement.setAttribute("src", "./attribute-brochure.pdf");
	const pageChanged = new Promise<void>((resolve) => {
		attributeElement.addEventListener("pagechange", () => resolve(), { once: true });
	});
	document.body.append(attributeElement);
	await pageChanged;

	expect(attributeElement.getAttribute("src")).toBe("./attribute-brochure.pdf");
	expect(attributeElement.src).toBe(
		new URL("./attribute-brochure.pdf", attributeElement.ownerDocument.baseURI).href,
	);
});

test("aborts a stale source load and only renders the newest source", async () => {
	await import("../entry");
	const attempts: Array<{
		source: string;
		signal: AbortSignal;
		resolve(source: PageSource): void;
	}> = [];
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "840px";
	element.style.height = "560px";
	element.layout = "single";
	element.backend = {
		open(source, signal) {
			return new Promise<PageSource>((resolve) => attempts.push({ source, signal, resolve }));
		},
	};
	const changes: number[] = [];
	element.addEventListener("pagechange", (event) => changes.push(event.detail.page));
	element.src = "./first.pdf";
	document.body.append(element);
	await expect.poll(() => attempts.length).toBe(1);

	const firstAttempt = attempts[0];
	if (firstAttempt === undefined) throw new Error("The first source did not start loading.");
	element.src = "./second.pdf";
	await expect.poll(() => attempts.length).toBe(2);
	expect(firstAttempt.signal.aborted).toBe(true);

	let staleSourceDisposed = false;
	let staleSourceRenderCount = 0;
	firstAttempt.resolve(
		createPageSource(
			1,
			[255, 0, 0],
			() => (staleSourceDisposed = true),
			() => staleSourceRenderCount++,
		),
	);
	await expect.poll(() => staleSourceDisposed).toBe(true);
	const secondAttempt = attempts[1];
	if (secondAttempt === undefined) throw new Error("The second source did not start loading.");
	let currentSourceRenderCount = 0;
	secondAttempt.resolve(
		createPageSource(
			1,
			[0, 160, 0],
			() => {},
			() => currentSourceRenderCount++,
		),
	);
	await expect.poll(() => changes.length).toBe(1);
	expect(changes).toEqual([1]);
	expect(staleSourceRenderCount).toBe(0);
	expect(currentSourceRenderCount).toBeGreaterThan(0);
	expect(secondAttempt.signal.aborted).toBe(false);
	expect(canvasPixel(element)).toEqual([0, 160, 0, 255]);
});

test("keeps instances independent and reopens after disconnecting and reconnecting", async () => {
	await import("../entry");
	const openCalls: Array<{ source: string; signal: AbortSignal }> = [];
	const disposed = new Map<string, number>();
	const backend = {
		open(source: string, signal: AbortSignal): Promise<PageSource> {
			openCalls.push({ source, signal });
			const isSecond = source.endsWith("second-instance.pdf");
			const color: readonly [number, number, number] = isSecond ? [0, 160, 0] : [0, 0, 220];
			return Promise.resolve(
				createPageSource(isSecond ? 2 : 1, color, () => {
					disposed.set(source, (disposed.get(source) ?? 0) + 1);
				}),
			);
		},
	};
	const first = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	const second = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	for (const element of [first, second]) {
		element.style.width = "840px";
		element.style.height = "560px";
		element.layout = "single";
		element.backend = backend;
	}
	first.src = "./first-instance.pdf";
	second.src = "./second-instance.pdf";
	second.page = 2;
	const firstChanged = waitForPageChange(first);
	const secondChanged = waitForPageChange(second);
	document.body.append(first, second);
	await Promise.all([firstChanged, secondChanged]);
	await expect.poll(() => openCalls.length).toBe(2);
	const firstOpen = openCalls.find((call) => call.source.endsWith("first-instance.pdf"));
	const secondOpen = openCalls.find((call) => call.source.endsWith("second-instance.pdf"));
	if (firstOpen === undefined || secondOpen === undefined) {
		throw new Error("Both viewer instances did not open their own sources.");
	}
	expect(firstOpen.signal.aborted).toBe(false);
	expect(secondOpen.signal.aborted).toBe(false);
	expect(canvasPixel(first)).toEqual([0, 0, 220, 255]);
	expect(canvasPixel(second)).toEqual([0, 160, 0, 255]);

	const firstReconnected = waitForPageChange(first);
	first.remove();
	await expect.poll(() => firstOpen.signal.aborted).toBe(true);
	await expect.poll(() => disposed.get(firstOpen.source)).toBe(1);
	document.body.append(first);
	await firstReconnected;
	await expect
		.poll(() => openCalls.filter((call) => call.source === firstOpen.source))
		.toHaveLength(2);
	expect(secondOpen.signal.aborted).toBe(false);
	expect(disposed.get(secondOpen.source)).toBeUndefined();
	expect(canvasPixel(first)).toEqual([0, 0, 220, 255]);
});

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}

function canvasPixel(element: PamphletViewerElement): number[] {
	const canvas = element.shadowRoot?.querySelector<HTMLCanvasElement>(".page-canvas");
	const context = canvas?.getContext("2d");
	if (canvas === null || canvas === undefined || context === null || context === undefined) {
		throw new Error("The custom element did not render a page canvas.");
	}
	return [
		...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
			.data,
	];
}

function createPageSource(
	pageCount = 1,
	color: readonly [number, number, number] = [38, 82, 148],
	onDispose: () => void = () => {},
	onRender: () => void = () => {},
): PageSource {
	return {
		pageCount,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		async renderPage(): Promise<PageVisual> {
			onRender();
			return {
				type: "pixels",
				width: 300,
				height: 400,
				pixels: pagePixels(color),
			};
		},
		async renderPrefetchedPage(): Promise<PageVisual> {
			return {
				type: "pixels",
				width: 300,
				height: 400,
				pixels: pagePixels(color),
			};
		},
		dispose: onDispose,
	};
}

function pagePixels(color: readonly [number, number, number]): ArrayBuffer {
	const pixels = new Uint8ClampedArray(300 * 400 * 4);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		pixels[offset] = color[0];
		pixels[offset + 1] = color[1];
		pixels[offset + 2] = color[2];
		pixels[offset + 3] = 255;
	}
	return pixels.buffer;
}
