import { describe, expect, test } from "vitest";

import {
	calculateThumbnailColumnCount,
	calculateThumbnailRowCount,
	calculateVisibleThumbnailRows,
	getThumbnailPageIndexesForRow,
} from "./thumbnail-grid";

describe("thumbnail grid layout", () => {
	test("chooses a responsive number of columns from the available width", () => {
		expect(calculateThumbnailColumnCount(200)).toBe(1);
		expect(calculateThumbnailColumnCount(216)).toBe(2);
		expect(calculateThumbnailColumnCount(328)).toBe(3);
	});

	test("calculates row counts and page indexes without dropping a partial last row", () => {
		expect(calculateThumbnailRowCount(5, 2)).toBe(3);
		expect(getThumbnailPageIndexesForRow(0, 5, 2)).toEqual([0, 1]);
		expect(getThumbnailPageIndexesForRow(2, 5, 2)).toEqual([4]);
	});

	test("renders nearby rows with one row of overscan and clamps to the list", () => {
		expect(calculateVisibleThumbnailRows(20, 2, 320, 160)).toEqual({
			startRow: 1,
			endRow: 4,
			totalRows: 10,
		});
		expect(calculateVisibleThumbnailRows(20, 2, 5000, 160)).toEqual({
			startRow: 9,
			endRow: 10,
			totalRows: 10,
		});
	});
});
