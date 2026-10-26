// SPDX-License-Identifier: MIT
export type ViewerLocale = "en" | "ja";

export function resolveViewerLocale(
	elementLanguage: string | null,
	documentLanguage: string | null,
): ViewerLocale {
	const explicitLanguage = elementLanguage?.trim();
	if (explicitLanguage) return normalizeViewerLocale(explicitLanguage) ?? "ja";
	return normalizeViewerLocale(documentLanguage?.trim() ?? "") ?? "ja";
}

function normalizeViewerLocale(language: string): ViewerLocale | null {
	const primaryLanguage = language.split(/[-_]/u, 1)[0]?.toLowerCase();
	if (primaryLanguage === "en" || primaryLanguage === "ja") return primaryLanguage;
	return null;
}
