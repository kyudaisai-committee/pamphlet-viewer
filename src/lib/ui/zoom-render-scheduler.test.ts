// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZOOM_RENDER_DELAY_MS, ZoomRenderScheduler } from "./zoom-render-scheduler";

afterEach(() => {
	vi.useRealTimers();
});

describe("ZoomRenderScheduler", () => {
	it("runs only the latest scheduled render after the zoom settles", async () => {
		vi.useFakeTimers();
		const scheduler = new ZoomRenderScheduler();
		const renders: number[] = [];

		scheduler.schedule(() => renders.push(1));
		scheduler.schedule(() => renders.push(2));

		await vi.advanceTimersByTimeAsync(ZOOM_RENDER_DELAY_MS - 1);
		expect(renders).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(renders).toEqual([2]);
	});

	it("cancels a pending render when the viewer no longer needs it", async () => {
		vi.useFakeTimers();
		const scheduler = new ZoomRenderScheduler();
		const render = vi.fn();

		scheduler.schedule(render);
		scheduler.cancel();
		await vi.advanceTimersByTimeAsync(ZOOM_RENDER_DELAY_MS);

		expect(render).not.toHaveBeenCalled();
	});
});
