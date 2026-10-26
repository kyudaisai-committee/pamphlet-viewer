// SPDX-License-Identifier: MIT

import { clampReaderZoom } from "./reader-gesture";

const WHEEL_ZOOM_PIXELS_PER_LINE = 16;
const WHEEL_ZOOM_SCALE_PIXELS = 100;
const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export function calculateWheelZoom(
	currentZoom: number,
	deltaY: number,
	deltaMode: number,
	pageHeight: number,
): number {
	const zoom = clampReaderZoom(currentZoom);
	if (!Number.isFinite(deltaY)) return zoom;

	const scale = getDeltaModeScale(deltaMode, pageHeight);
	if (scale === null) return zoom;

	const normalizedDelta = deltaY * scale;
	if (!Number.isFinite(normalizedDelta)) return zoom;

	return clampReaderZoom(zoom * Math.exp(-normalizedDelta / WHEEL_ZOOM_SCALE_PIXELS));
}

function getDeltaModeScale(deltaMode: number, pageHeight: number): number | null {
	if (deltaMode === DOM_DELTA_PIXEL) return 1;
	if (deltaMode === DOM_DELTA_LINE) return WHEEL_ZOOM_PIXELS_PER_LINE;
	if (deltaMode === DOM_DELTA_PAGE && Number.isFinite(pageHeight) && pageHeight > 0) {
		return pageHeight;
	}
	return null;
}
