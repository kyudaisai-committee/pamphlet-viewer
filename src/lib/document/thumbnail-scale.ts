// SPDX-License-Identifier: MIT

const THUMBNAIL_MAX_WIDTH = 144;
const THUMBNAIL_MAX_PIXELS = 160_000;

export function calculateThumbnailScale(width: number, height: number): number {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
	return Math.min(
		1,
		THUMBNAIL_MAX_WIDTH / width,
		Math.sqrt(THUMBNAIL_MAX_PIXELS / (width * height)),
	);
}
