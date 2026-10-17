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
	const canvas = shadowRoot?.querySelector<HTMLCanvasElement>(".page-canvas");
	expect(toolbar).not.toBeNull();
	expect(canvas).not.toBeNull();
	expect(getComputedStyle(toolbar as HTMLElement).display).toBe("flex");
	expect(getComputedStyle(canvas as HTMLCanvasElement).display).toBe("block");
	expect(openCalls).toHaveLength(1);

	const errors: string[] = [];
	element.addEventListener("error", (event) => errors.push(event.detail.code));
	element.page = 9;
	await expect.poll(() => errors).toEqual(["invalid-page"]);
	shadowRoot?.querySelector<HTMLButtonElement>('.zoom-controls button[aria-label="拡大"]')?.click();
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

function createPageSource(): PageSource {
	return {
		pageCount: 1,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		async renderPage(): Promise<PageVisual> {
			return {
				type: "pixels",
				width: 300,
				height: 400,
				pixels: pagePixels(),
			};
		},
		dispose() {},
	};
}

function pagePixels(): ArrayBuffer {
	const pixels = new Uint8ClampedArray(300 * 400 * 4);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		pixels[offset] = 38;
		pixels[offset + 1] = 82;
		pixels[offset + 2] = 148;
		pixels[offset + 3] = 255;
	}
	return pixels.buffer;
}
