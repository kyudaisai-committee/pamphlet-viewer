import type { FitMode, LayoutMode } from "./layout";

export function resolveDocumentSource(value: string, baseUri: string): string | null {
	try {
		return new URL(value, baseUri).href;
	} catch {
		return null;
	}
}

export function parseLayout(value: string): LayoutMode | null {
	if (value === "single" || value === "spread" || value === "auto") return value;
	return null;
}

export function parseFit(value: string): FitMode | null {
	if (value === "page" || value === "width") return value;
	return null;
}
