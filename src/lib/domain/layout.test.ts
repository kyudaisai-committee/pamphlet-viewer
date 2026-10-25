// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "vitest";

import { calculateFitScale, parsePageNumber, resolveLayout, visiblePageIndexes } from "./layout";

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
