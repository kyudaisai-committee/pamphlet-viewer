import { afterEach, expect, test } from "vitest";

import type { PamphletViewerElement } from "../public-api";

const originalDocumentLanguage = document.documentElement.getAttribute("lang");

afterEach(() => {
	document.body.replaceChildren();
	if (originalDocumentLanguage === null) document.documentElement.removeAttribute("lang");
	else document.documentElement.setAttribute("lang", originalDocumentLanguage);
});

test("keeps explicit English and Japanese locales independent across instances", async () => {
	document.documentElement.lang = "fr";
	await import("../entry");
	const englishViewer = createViewer("en-US");
	const japaneseViewer = createViewer("ja-JP");
	document.body.append(englishViewer, japaneseViewer);

	await expect.poll(() => getToolbarLabel(englishViewer)).toBe("Pamphlet controls");
	await expect.poll(() => getToolbarLabel(japaneseViewer)).toBe("パンフレット操作");
	await expect
		.poll(() => getViewOptions(englishViewer))
		.toEqual([
			"Automatic · fit page",
			"Automatic · fit width",
			"Single page · fit page",
			"Single page · fit width",
			"Spread · fit page",
			"Spread · fit width",
		]);
	expect(getViewerLanguage(englishViewer)).toBe("en");
	expect(getViewerLanguage(japaneseViewer)).toBe("ja");
	await expect.poll(() => getErrorMessage(englishViewer)).toBe("Could not resolve the PDF URL.");
	await expect
		.poll(() => getErrorMessage(japaneseViewer))
		.toBe("PDFのURLを解決できませんでした。");
	expect(document.documentElement.lang).toBe("fr");
});

test("uses document language for missing or blank element lang and Japanese for unsupported values", async () => {
	document.documentElement.lang = "en-GB";
	await import("../entry");
	const missingLanguageViewer = createViewer();
	const blankLanguageViewer = createViewer("");
	const unsupportedLanguageViewer = createViewer("fr-FR");
	document.body.append(missingLanguageViewer, blankLanguageViewer, unsupportedLanguageViewer);

	await expect.poll(() => getToolbarLabel(missingLanguageViewer)).toBe("Pamphlet controls");
	await expect.poll(() => getToolbarLabel(blankLanguageViewer)).toBe("Pamphlet controls");
	await expect.poll(() => getToolbarLabel(unsupportedLanguageViewer)).toBe("パンフレット操作");
	expect(getViewerLanguage(missingLanguageViewer)).toBe("en");
	expect(getViewerLanguage(blankLanguageViewer)).toBe("en");
	expect(getViewerLanguage(unsupportedLanguageViewer)).toBe("ja");
	expect(document.documentElement.lang).toBe("en-GB");
});

function createViewer(language?: string): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	if (language !== undefined) element.setAttribute("lang", language);
	element.src = "http://[";
	return element;
}

function getToolbarLabel(viewer: PamphletViewerElement): string | null | undefined {
	return viewer.shadowRoot?.querySelector<HTMLElement>(".toolbar")?.getAttribute("aria-label");
}

function getErrorMessage(viewer: PamphletViewerElement): string | undefined {
	return viewer.shadowRoot?.querySelector<HTMLElement>("[role='alert'] p")?.textContent?.trim();
}

function getViewOptions(viewer: PamphletViewerElement): string[] | undefined {
	const options = viewer.shadowRoot?.querySelectorAll<HTMLOptionElement>(
		".view-mode-control option",
	);
	return options === undefined
		? undefined
		: Array.from(options, (option) => option.textContent ?? "");
}

function getViewerLanguage(viewer: PamphletViewerElement): string | null | undefined {
	return viewer.shadowRoot?.querySelector<HTMLElement>(".viewer-shell")?.getAttribute("lang");
}
