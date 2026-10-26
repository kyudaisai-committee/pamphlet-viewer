import { describe, expect, it } from "vitest";

import {
	calculateFitScale,
	getAdjacentPageGroups,
	getPrefetchPageIndexes,
	parsePageNumber,
	resolveLayout,
	visiblePageIndexes,
} from "./layout";

describe("resolveLayout", () => {
	it("switches to a spread at the configured container width", () => {
		expect(resolveLayout("auto", 759)).toBe("single");
		expect(resolveLayout("auto", 760)).toBe("spread");
		expect(resolveLayout("single", 1200)).toBe("single");
	});
});

describe("visiblePageIndexes", () => {
	it("keeps the cover alone and groups following pages in pairs", () => {
		expect(visiblePageIndexes(6, 1, "spread")).toEqual([0]);
		expect(visiblePageIndexes(6, 2, "spread")).toEqual([1, 2]);
		expect(visiblePageIndexes(6, 3, "spread")).toEqual([1, 2]);
		expect(visiblePageIndexes(6, 6, "spread")).toEqual([5]);
	});

	it("keeps a single page when requested or when the document is empty", () => {
		expect(visiblePageIndexes(4, 3, "single")).toEqual([2]);
		expect(visiblePageIndexes(0, 1, "spread")).toEqual([]);
	});
});

describe("getPrefetchPageIndexes", () => {
	it("selects up to two pages in both directions for a single-page layout", () => {
		expect(getPrefetchPageIndexes(10, [5], "single")).toEqual([3, 4, 6, 7]);
		expect(getPrefetchPageIndexes(3, [0], "single")).toEqual([1, 2]);
		expect(getPrefetchPageIndexes(3, [2], "single")).toEqual([0, 1]);
	});

	it("selects two surrounding spreads while keeping the cover as a single page", () => {
		expect(getPrefetchPageIndexes(10, [0], "spread")).toEqual([1, 2, 3, 4]);
		expect(getPrefetchPageIndexes(10, [1, 2], "spread")).toEqual([0, 3, 4, 5, 6]);
		expect(getPrefetchPageIndexes(10, [5, 6], "spread")).toEqual([1, 2, 3, 4, 7, 8, 9]);
		expect(getPrefetchPageIndexes(5, [3, 4], "spread")).toEqual([0, 1, 2]);
	});
});

describe("getAdjacentPageGroups", () => {
	it("selects one neighboring page on each side in single-page layout", () => {
		expect(getAdjacentPageGroups(10, 5, "single")).toEqual([[3], [5]]);
		expect(getAdjacentPageGroups(4, 1, "single")).toEqual([[1]]);
		expect(getAdjacentPageGroups(4, 4, "single")).toEqual([[2]]);
	});

	it("selects neighboring spreads while preserving the single-page cover and last page", () => {
		expect(getAdjacentPageGroups(10, 1, "spread")).toEqual([[1, 2]]);
		expect(getAdjacentPageGroups(10, 2, "spread")).toEqual([[0], [3, 4]]);
		expect(getAdjacentPageGroups(5, 4, "spread")).toEqual([[1, 2]]);
		expect(getAdjacentPageGroups(0, 1, "spread")).toEqual([]);
	});

	it("uses the resolved layout for automatic mode", () => {
		const layout = resolveLayout("auto", 760);
		expect(getAdjacentPageGroups(10, 2, layout)).toEqual([[0], [3, 4]]);
	});
});

describe("parsePageNumber", () => {
	it("accepts only a 1-based page inside the document", () => {
		expect(parsePageNumber("1", 10)).toBe(1);
		expect(parsePageNumber("010", 10)).toBe(10);
		expect(parsePageNumber("0", 10)).toBeNull();
		expect(parsePageNumber("11", 10)).toBeNull();
		expect(parsePageNumber("2.5", 10)).toBeNull();
	});
});

describe("calculateFitScale", () => {
	it("fits a spread within the available width and height", () => {
		const pageSizes = [
			{ width: 300, height: 400 },
			{ width: 300, height: 400 },
		];
		expect(calculateFitScale(pageSizes, { width: 1232, height: 800 }, "page", 1)).toBe(2);
		expect(calculateFitScale(pageSizes, { width: 616, height: 800 }, "width", 1.5)).toBeCloseTo(
			1.53,
		);
	});

	it("subtracts the fixed spread gap before scaling pages to a narrow width", () => {
		const pageSizes = [
			{ width: 300, height: 400 },
			{ width: 300, height: 400 },
		];
		const scale = calculateFitScale(pageSizes, { width: 500, height: 800 }, "width", 1);

		expect(600 * scale + 4).toBeCloseTo(500, 10);
	});
});
