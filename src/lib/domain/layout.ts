// SPDX-License-Identifier: MIT

import type { PageSize } from "../document/page-source";

export const AUTO_SPREAD_MIN_WIDTH = 760;
export const SPREAD_GAP = 4;

export type LayoutMode = "single" | "spread" | "auto";
export type ResolvedLayout = Exclude<LayoutMode, "auto">;
export type FitMode = "page" | "width";

export interface ViewportSize {
	width: number;
	height: number;
}

export function resolveLayout(
	mode: LayoutMode,
	viewportWidth: number,
	spreadMinWidth = AUTO_SPREAD_MIN_WIDTH,
): ResolvedLayout {
	if (mode === "spread") return "spread";
	if (mode === "single") return "single";
	return viewportWidth >= spreadMinWidth ? "spread" : "single";
}

export function visiblePageIndexes(
	pageCount: number,
	pageNumber: number,
	layout: ResolvedLayout,
): number[] {
	if (pageCount < 1) return [];

	const currentPageIndex = Math.max(0, Math.min(pageCount - 1, Math.trunc(pageNumber) - 1));
	if (layout === "single" || currentPageIndex === 0) return [currentPageIndex];

	const firstPageIndex = 1 + Math.floor((currentPageIndex - 1) / 2) * 2;
	const secondPageIndex = firstPageIndex + 1;
	return secondPageIndex < pageCount ? [firstPageIndex, secondPageIndex] : [firstPageIndex];
}

export function parsePageNumber(value: string, pageCount: number): number | null {
	if (!/^\d+$/.test(value)) return null;
	const pageNumber = Number(value);
	if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) return null;
	return pageNumber;
}

export function calculateFitScale(
	pageSizes: PageSize[],
	viewport: ViewportSize,
	fit: FitMode,
	zoom: number,
): number {
	if (
		pageSizes.length === 0 ||
		viewport.width <= 0 ||
		viewport.height <= 0 ||
		pageSizes.some((size) => size.width <= 0 || size.height <= 0)
	) {
		return 1;
	}

	const pageWidth = pageSizes.reduce((width, size) => width + size.width, 0);
	const gapWidth = SPREAD_GAP * Math.max(0, pageSizes.length - 1);
	const maxHeight = Math.max(...pageSizes.map((size) => size.height));
	const widthScale = Math.max(0, viewport.width - gapWidth) / pageWidth;
	const baseScale =
		fit === "width" ? widthScale : Math.min(widthScale, viewport.height / maxHeight);
	return baseScale * Math.max(0.1, Math.min(zoom, 8));
}
