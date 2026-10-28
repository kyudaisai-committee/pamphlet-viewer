// SPDX-License-Identifier: MIT

export const THUMBNAIL_ROW_HEIGHT = 160;
export const THUMBNAIL_ROW_OVERSCAN = 1;
export const THUMBNAIL_COLUMN_GAP = 8;

const THUMBNAIL_ROW_INLINE_PADDING = 8;
const MIN_THUMBNAIL_COLUMN_WIDTH = 96;

export interface ThumbnailRowRange {
	startRow: number;
	endRow: number;
	totalRows: number;
}

export function calculateThumbnailColumnCount(containerWidth: number): number {
	const availableWidth = Math.max(0, containerWidth - THUMBNAIL_ROW_INLINE_PADDING * 2);
	return Math.max(
		1,
		Math.floor(
			(availableWidth + THUMBNAIL_COLUMN_GAP) /
				(MIN_THUMBNAIL_COLUMN_WIDTH + THUMBNAIL_COLUMN_GAP),
		),
	);
}

export function calculateThumbnailRowCount(pageCount: number, columnCount: number): number {
	if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return 0;
	return Math.ceil(pageCount / Math.max(1, Math.floor(columnCount)));
}

export function calculateVisibleThumbnailRows(
	pageCount: number,
	columnCount: number,
	scrollTop: number,
	viewportHeight: number,
): ThumbnailRowRange {
	const totalRows = calculateThumbnailRowCount(pageCount, columnCount);
	if (totalRows === 0) return { startRow: 0, endRow: 0, totalRows };

	const safeScrollTop = Math.max(0, scrollTop);
	const firstVisibleRow = Math.min(totalRows, Math.floor(safeScrollTop / THUMBNAIL_ROW_HEIGHT));
	const lastVisibleRow = Math.min(
		totalRows,
		Math.ceil((safeScrollTop + Math.max(0, viewportHeight)) / THUMBNAIL_ROW_HEIGHT),
	);
	const startRow = Math.max(0, firstVisibleRow - THUMBNAIL_ROW_OVERSCAN);
	const endRow = Math.min(totalRows, lastVisibleRow + THUMBNAIL_ROW_OVERSCAN);
	return { startRow, endRow: Math.max(startRow, endRow), totalRows };
}

export function getThumbnailPageIndexesForRow(
	rowIndex: number,
	pageCount: number,
	columnCount: number,
): number[] {
	const firstPageIndex = Math.max(0, Math.floor(rowIndex)) * Math.max(1, Math.floor(columnCount));
	const endPageIndex = Math.min(pageCount, firstPageIndex + Math.max(1, Math.floor(columnCount)));
	return Array.from(
		{ length: Math.max(0, endPageIndex - firstPageIndex) },
		(_, offset) => firstPageIndex + offset,
	);
}
