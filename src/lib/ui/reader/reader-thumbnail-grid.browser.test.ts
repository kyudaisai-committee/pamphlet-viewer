import { afterEach, expect, test } from "vitest";
import { page as browserPage } from "vitest/browser";

import type { PamphletViewerElement } from "@/lib/public-api";

const PDF_FIXTURES = [
	{
		name: "portrait pages",
		path: "/__thumbnail-portrait-range-fixture.pdf",
		ratio: 0.75,
	},
	{
		name: "landscape pages",
		path: "/__thumbnail-landscape-range-fixture.pdf",
		ratio: 4 / 3,
	},
	{
		name: "mixed page sizes",
		path: "/__thumbnail-mixed-range-fixture.pdf",
		ratio: 0.75,
		secondRatio: 4 / 3,
	},
] as const;

afterEach(async () => {
	document.body.replaceChildren();
	await browserPage.viewport(1280, 900);
});

test.each(PDF_FIXTURES)("uses PDF page ratios in the $name thumbnail grid", async (fixture) => {
	await import("@/lib/entry");
	const element = createViewer(840, fixture.path);
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const firstStageCanvas = shadowRoot.querySelector<HTMLCanvasElement>(".page-frame canvas");
	if (firstStageCanvas === null) throw new Error("The first PDF page was not rendered.");
	expect(firstStageCanvas.width / firstStageCanvas.height).toBeCloseTo(fixture.ratio, 2);

	const thumbnailToggle = shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle");
	if (thumbnailToggle === null) throw new Error("The thumbnail toggle was not rendered.");
	thumbnailToggle.click();
	await expect
		.poll(() =>
			shadowRoot.querySelector<HTMLCanvasElement>(
				'.thumbnail-entry[data-page-index="0"] canvas',
			),
		)
		.not.toBeNull();

	const thumbnailRow = shadowRoot.querySelector<HTMLElement>(".thumbnail-row");
	const firstThumbnailCanvas = shadowRoot.querySelector<HTMLCanvasElement>(
		'.thumbnail-entry[data-page-index="0"] canvas',
	);
	const thumbnailPreview = shadowRoot.querySelector<HTMLElement>(".thumbnail-preview");
	if (thumbnailRow === null || firstThumbnailCanvas === null || thumbnailPreview === null) {
		throw new Error("The first thumbnail row did not render.");
	}
	const columns = getComputedStyle(thumbnailRow).gridTemplateColumns.split(" ").length;
	expect(columns).toBeGreaterThan(1);
	await expect.poll(() => firstThumbnailCanvas.width).toBeGreaterThan(0);
	expect(firstThumbnailCanvas.width / firstThumbnailCanvas.height).toBeCloseTo(fixture.ratio, 2);
	expect(getComputedStyle(thumbnailPreview).backgroundColor).toBe("rgb(23, 26, 30)");
	expect(getComputedStyle(firstThumbnailCanvas).backgroundColor).toBe("rgba(0, 0, 0, 0)");
	expect(getComputedStyle(firstThumbnailCanvas.parentElement!).backgroundColor).toBe(
		"rgba(0, 0, 0, 0)",
	);

	if ("secondRatio" in fixture) {
		const secondThumbnailCanvas = shadowRoot.querySelector<HTMLCanvasElement>(
			'.thumbnail-entry[data-page-index="1"] canvas',
		);
		if (secondThumbnailCanvas === null)
			throw new Error("The second mixed-size thumbnail is missing.");
		await expect.poll(() => secondThumbnailCanvas.width).toBeGreaterThan(0);
		expect(secondThumbnailCanvas.width / secondThumbnailCanvas.height).toBeCloseTo(
			fixture.secondRatio,
			2,
		);
	}
});

test("recalculates grid columns and virtual scroll rows after resizing", async () => {
	await import("@/lib/entry");
	const element = createViewer(840, "/__thumbnail-mixed-range-fixture.pdf");
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-row")).not.toBeNull();
	const scrollContainer = shadowRoot.querySelector<HTMLElement>(".thumbnail-scroll");
	if (scrollContainer === null) throw new Error("The thumbnail list did not render.");

	const initialRow = shadowRoot.querySelector<HTMLElement>(".thumbnail-row");
	if (initialRow === null) throw new Error("The desktop thumbnail grid row is missing.");
	const desktopColumnCount = getColumnCount(initialRow);
	expect(desktopColumnCount).toBeGreaterThan(1);

	element.style.width = "390px";
	await expect
		.poll(() => {
			const resizedRow = shadowRoot.querySelector<HTMLElement>(".thumbnail-row");
			return resizedRow === null ? 0 : getColumnCount(resizedRow);
		})
		.toBeGreaterThan(desktopColumnCount);

	const resizedRow = shadowRoot.querySelector<HTMLElement>(".thumbnail-row");
	if (resizedRow === null) throw new Error("The mobile thumbnail grid row is missing.");
	const mobileColumnCount = getColumnCount(resizedRow);
	const targetPageIndex = 20;
	scrollContainer.scrollTop = Math.floor(targetPageIndex / mobileColumnCount) * 160;
	scrollContainer.dispatchEvent(new Event("scroll"));
	await expect
		.poll(() =>
			shadowRoot.querySelector(`[data-page-index="${targetPageIndex}"] .thumbnail-entry`),
		)
		.not.toBeNull();
	const visibleEntries = shadowRoot.querySelectorAll(".thumbnail-entry").length;
	expect(visibleEntries).toBeLessThan(24);

	element.page = targetPageIndex + 1;
	await expect.poll(() => element.page).toBe(targetPageIndex + 1);
	await expect
		.poll(() =>
			shadowRoot.querySelector(
				`.thumbnail-entry[data-page-index="${targetPageIndex}"][aria-current="page"]`,
			),
		)
		.not.toBeNull();
});

function createViewer(width: number, pdfPath: string): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = `${width}px`;
	element.style.height = "620px";
	element.layout = "single";
	element.src = new URL(pdfPath, window.location.href).href;
	return element;
}

function getColumnCount(row: HTMLElement): number {
	return getComputedStyle(row).gridTemplateColumns.split(" ").length;
}

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}
