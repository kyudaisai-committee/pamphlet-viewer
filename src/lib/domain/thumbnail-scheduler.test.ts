import { describe, expect, it, vi } from "vitest";

import type { PageSource, PageVisual } from "@/lib/document/page-source";

import { ThumbnailScheduler } from "./thumbnail-scheduler";

describe("ThumbnailScheduler", () => {
	it("renders only visible pages and the requested prefetch with one job at a time", async () => {
		const calls: number[] = [];
		let active = 0;
		let maximumActive = 0;
		const source = createPageSource(20);
		const scheduler = new ThumbnailScheduler(
			async (pageIndex) => {
				calls.push(pageIndex);
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await Promise.resolve();
				active -= 1;
				return pixelVisual();
			},
			() => undefined,
		);
		scheduler.setSource(source);
		scheduler.setVisiblePages([8], [7, 9]);

		await vi.waitFor(() => expect(scheduler.entries).toHaveLength(3));
		expect(calls).toEqual([8, 7, 9]);
		expect(maximumActive).toBe(1);
		scheduler.setSource(null);
	});

	it("drops and closes a stale render when the visible range changes", async () => {
		const pending: Array<(visual: PageVisual) => void> = [];
		const staleClose = vi.fn();
		const calls: number[] = [];
		const scheduler = new ThumbnailScheduler(
			(pageIndex) => {
				calls.push(pageIndex);
				return new Promise((resolve) => pending.push(resolve));
			},
			() => undefined,
		);
		scheduler.setSource(createPageSource(4));
		scheduler.setVisiblePages([0]);
		await vi.waitFor(() => expect(calls).toEqual([0]));

		scheduler.setVisiblePages([2]);
		pending[0]?.(bitmapVisual(staleClose));
		await vi.waitFor(() => expect(calls).toEqual([0, 2]));
		expect(staleClose).toHaveBeenCalledOnce();
		pending[1]?.(pixelVisual());
		await vi.waitFor(() => expect(scheduler.entries.map((entry) => entry.pageIndex)).toEqual([2]));
		scheduler.setSource(null);
	});

	it("renders the new source after replacing one with an active thumbnail", async () => {
		let releaseOldRender: ((visual: PageVisual) => void) | undefined;
		let renderCalls = 0;
		const staleClose = vi.fn();
		const scheduler = new ThumbnailScheduler(
			() => {
				renderCalls += 1;
				if (renderCalls === 1) {
					return new Promise((resolve) => {
						releaseOldRender = resolve;
					});
				}
				return Promise.resolve(pixelVisual());
			},
			() => undefined,
		);
		scheduler.setSource(createPageSource(2));
		scheduler.setVisiblePages([0]);
		await vi.waitFor(() => expect(releaseOldRender).toBeTypeOf("function"));

		scheduler.setSource(createPageSource(2));
		scheduler.setVisiblePages([0]);
		releaseOldRender?.(bitmapVisual(staleClose));

		await vi.waitFor(() => expect(renderCalls).toBe(2));
		await vi.waitFor(() => expect(scheduler.entries.map((entry) => entry.pageIndex)).toEqual([0]));
		expect(staleClose).toHaveBeenCalledOnce();
		scheduler.setSource(null);
	});

	it("does not spin when a thumbnail render fails", async () => {
		const render = vi.fn(async () => {
			throw new Error("thumbnail unavailable");
		});
		const scheduler = new ThumbnailScheduler(render, () => undefined);
		scheduler.setSource(createPageSource(1));
		scheduler.setVisiblePages([0]);
		await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
		await Promise.resolve();
		expect(render).toHaveBeenCalledOnce();
		expect(scheduler.entries).toHaveLength(0);
		scheduler.setSource(null);
	});

	it("evicts least recently used visuals by entry count and pixel-byte budget", async () => {
		const closeCalls: Array<ReturnType<typeof vi.fn>> = [];
		const scheduler = new ThumbnailScheduler(
			async () => {
				const close = vi.fn();
				closeCalls.push(close);
				return bitmapVisual(close);
			},
			() => undefined,
			() => undefined,
			2,
			8,
		);
		scheduler.setSource(createPageSource(3));
		scheduler.setVisiblePages([0, 1, 2]);
		await vi.waitFor(() =>
			expect(scheduler.entries.map((entry) => entry.pageIndex)).toEqual([1, 2]),
		);
		expect(closeCalls[0]?.mock.calls).toHaveLength(1);
		scheduler.get(1);
		scheduler.setVisiblePages([0]);
		await vi.waitFor(() => expect(closeCalls[2]?.mock.calls).toHaveLength(1));
		await vi.waitFor(() =>
			expect(scheduler.entries.map((entry) => entry.pageIndex)).toEqual([1, 0]),
		);
		scheduler.setSource(null);
	});
});

function createPageSource(pageCount: number): PageSource {
	return {
		pageCount,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		async renderPage() {
			return pixelVisual();
		},
		dispose() {},
	};
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}

function bitmapVisual(close: () => void): PageVisual {
	return { type: "bitmap", width: 1, height: 1, bitmap: { close } as unknown as ImageBitmap };
}
