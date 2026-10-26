import { describe, expect, it } from "vitest";

import { resolveViewerLocale } from "./locale";

describe("resolveViewerLocale", () => {
	it.each([
		{ elementLanguage: "en", documentLanguage: "ja", expected: "en" },
		{ elementLanguage: "EN-us", documentLanguage: "ja", expected: "en" },
		{ elementLanguage: "ja-JP", documentLanguage: "en", expected: "ja" },
		{ elementLanguage: "", documentLanguage: "en-US", expected: "en" },
		{ elementLanguage: "  ", documentLanguage: "ja-JP", expected: "ja" },
		{ elementLanguage: null, documentLanguage: "en-GB", expected: "en" },
		{ elementLanguage: "fr-FR", documentLanguage: "en", expected: "ja" },
		{ elementLanguage: null, documentLanguage: null, expected: "ja" },
	])(
		"resolves $elementLanguage against $documentLanguage",
		({ elementLanguage, documentLanguage, expected }) => {
			expect(resolveViewerLocale(elementLanguage, documentLanguage)).toBe(expected);
		},
	);
});
