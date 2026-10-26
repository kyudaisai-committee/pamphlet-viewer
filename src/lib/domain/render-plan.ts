// SPDX-License-Identifier: MIT

import { MAX_PAGE_RENDER_PIXELS } from "../document/page-source";
import type { PageSize } from "../document/page-source";

export { MAX_PAGE_RENDER_PIXELS } from "../document/page-source";

export interface PageRenderPlan {
	displayScale: number;
	rasterScale: number;
	displayWidth: number;
	displayHeight: number;
	rasterWidth: number;
	rasterHeight: number;
}

export function createPageRenderPlan(
	pageSize: PageSize,
	displayScale: number,
	maxPixels = MAX_PAGE_RENDER_PIXELS,
	devicePixelRatio = 1,
): PageRenderPlan {
	if (
		!Number.isFinite(pageSize.width) ||
		!Number.isFinite(pageSize.height) ||
		pageSize.width <= 0 ||
		pageSize.height <= 0
	) {
		throw new RangeError("Page dimensions must be finite numbers greater than 0.");
	}
	if (!Number.isFinite(displayScale) || displayScale <= 0) {
		throw new RangeError("Display scale must be a finite number greater than 0.");
	}
	if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) {
		throw new RangeError("The page render pixel budget must be a positive safe integer.");
	}
	if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
		throw new RangeError("The device pixel ratio must be a finite number greater than 0.");
	}

	const displayWidth = pageSize.width * displayScale;
	const displayHeight = pageSize.height * displayScale;
	if (!Number.isFinite(displayWidth) || !Number.isFinite(displayHeight)) {
		throw new RangeError("The requested display dimensions are too large.");
	}

	let rasterScale = Math.min(
		displayScale * devicePixelRatio,
		Math.sqrt(maxPixels / (pageSize.width * pageSize.height)),
	);
	let rasterWidth = Math.max(1, Math.ceil(pageSize.width * rasterScale));
	let rasterHeight = Math.max(1, Math.ceil(pageSize.height * rasterScale));
	while (rasterWidth * rasterHeight > maxPixels) {
		rasterScale *= Math.sqrt(maxPixels / (rasterWidth * rasterHeight)) * 0.999999;
		rasterWidth = Math.max(1, Math.ceil(pageSize.width * rasterScale));
		rasterHeight = Math.max(1, Math.ceil(pageSize.height * rasterScale));
	}

	return {
		displayScale,
		rasterScale,
		displayWidth,
		displayHeight,
		rasterWidth,
		rasterHeight,
	};
}
