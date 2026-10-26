import { describe, expect, it } from "vitest";

import { calculateWheelZoom } from "./reader-wheel-zoom";

describe("calculateWheelZoom", () => {
	it("matches the Chromium pinch scale for pixel deltas", () => {
		const deltaY = -100 * Math.log(1.2);

		expect(calculateWheelZoom(1, deltaY, 0, 800)).toBeCloseTo(1.2);
		expect(calculateWheelZoom(1.2, -100 * Math.log(1 / 1.2), 0, 800)).toBeCloseTo(1);
	});

	it("normalizes line and page delta modes to pixels", () => {
		expect(calculateWheelZoom(1, -1, 1, 800)).toBeCloseTo(Math.exp(16 / 100));
		expect(calculateWheelZoom(1, -1, 2, 50)).toBeCloseTo(Math.exp(50 / 100));
	});

	it("clamps zoom and ignores invalid wheel deltas or modes", () => {
		expect(calculateWheelZoom(7.9, -100, 0, 800)).toBe(8);
		expect(calculateWheelZoom(0.11, 100, 0, 800)).toBe(0.1);
		expect(calculateWheelZoom(2, Number.NaN, 0, 800)).toBe(2);
		expect(calculateWheelZoom(2, 100, 99, 800)).toBe(2);
		expect(calculateWheelZoom(2, 100, 2, 0)).toBe(2);
	});
});
