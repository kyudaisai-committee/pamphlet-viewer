import { afterEach, expect, test } from "vitest";

import type { PamphletViewerElement } from "../public-api";

afterEach(() => {
	document.body.replaceChildren();
});

test("renders Square annotation appearances in page and thumbnail canvases", async () => {
	await import("../entry");
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "900px";
	element.style.height = "620px";
	element.layout = "single";
	element.src = new URL("/__annotated-range-fixture.pdf", window.location.href).href;
	const pageRendered = waitForPageChange(element);
	document.body.append(element);
	await pageRendered;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const pageCanvas = shadowRoot.querySelector<HTMLCanvasElement>(".page-frame canvas");
	if (pageCanvas === null) throw new Error("The PDF page canvas was not rendered.");
	await expectAnnotationPixel(pageCanvas);

	const thumbnailToggle = shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle");
	if (thumbnailToggle === null) throw new Error("The thumbnail toggle was not rendered.");
	thumbnailToggle.click();
	await expect
		.poll(() =>
			shadowRoot.querySelector<HTMLCanvasElement>('.thumbnail-entry[data-page-index="0"] canvas'),
		)
		.not.toBeNull();
	const thumbnailCanvas = shadowRoot.querySelector<HTMLCanvasElement>(
		'.thumbnail-entry[data-page-index="0"] canvas',
	);
	if (thumbnailCanvas === null) throw new Error("The PDF thumbnail canvas was not rendered.");
	await expectAnnotationPixel(thumbnailCanvas);
});

async function expectAnnotationPixel(canvas: HTMLCanvasElement): Promise<void> {
	await expect.poll(() => readCenterPixel(canvas)?.red ?? 0).toBeGreaterThan(200);
	const pixel = readCenterPixel(canvas);
	if (pixel === null) throw new Error("The PDF canvas has no rendered pixels.");
	expect(pixel.green).toBeLessThan(60);
	expect(pixel.blue).toBeLessThan(80);
}

function readCenterPixel(
	canvas: HTMLCanvasElement,
): { red: number; green: number; blue: number } | null {
	if (canvas.width < 1 || canvas.height < 1) return null;
	const context = canvas.getContext("2d");
	if (context === null) return null;
	const pixel = context.getImageData(
		Math.floor(canvas.width / 2),
		Math.floor(canvas.height / 2),
		1,
		1,
	);
	return { red: pixel.data[0] ?? 0, green: pixel.data[1] ?? 0, blue: pixel.data[2] ?? 0 };
}

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}
