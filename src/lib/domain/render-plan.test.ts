import { describe, expect, it } from "vitest";

import { createPageRenderPlan, MAX_PAGE_RENDER_PIXELS } from "./render-plan";

describe("createPageRenderPlan", () => {
	it("preserves the requested logical size while limiting the raster to the pixel budget", () => {
		const plan = createPageRenderPlan({ width: 1200, height: 1800 }, 8);

		expect(plan.displayScale).toBe(8);
		expect(plan.displayWidth).toBe(9600);
		expect(plan.displayHeight).toBe(14400);
		expect(plan.rasterWidth * plan.rasterHeight).toBeLessThanOrEqual(MAX_PAGE_RENDER_PIXELS);
		expect(plan.rasterScale).toBeLessThan(plan.displayScale);
	});

	it("keeps the raster at the logical scale when it fits the budget", () => {
		const plan = createPageRenderPlan({ width: 400, height: 600 }, 2);

		expect(plan.rasterScale).toBe(2);
		expect(plan.rasterWidth).toBe(800);
		expect(plan.rasterHeight).toBe(1200);
	});

	it("uses device pixel ratio for raster quality without changing logical dimensions", () => {
		const plan = createPageRenderPlan({ width: 300, height: 400 }, 1.5, undefined, 2);

		expect(plan.displayWidth).toBe(450);
		expect(plan.displayHeight).toBe(600);
		expect(plan.rasterScale).toBe(3);
		expect(plan.rasterWidth).toBe(900);
		expect(plan.rasterHeight).toBe(1200);
	});

	it("rejects invalid dimensions, scales, and budgets", () => {
		expect(() => createPageRenderPlan({ width: 0, height: 600 }, 1)).toThrow(RangeError);
		expect(() =>
			createPageRenderPlan({ width: 400, height: 600 }, Number.POSITIVE_INFINITY),
		).toThrow(RangeError);
		expect(() => createPageRenderPlan({ width: 400, height: 600 }, 1, 0)).toThrow(RangeError);
		expect(() => createPageRenderPlan({ width: 400, height: 600 }, 1, undefined, 0)).toThrow(
			RangeError,
		);
	});
});
