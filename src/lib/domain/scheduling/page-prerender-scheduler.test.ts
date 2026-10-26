import { describe, expect, it, vi } from "vitest";

import type { PageSource, PageVisual } from "@/lib/document/page-source";

import { MAX_PRERENDER_ENTRIES, PagePrerenderScheduler } from "./page-prerender-scheduler";

describe("PagePrerenderScheduler", () => {
	it("renders requests independently and limits in-flight background work", async () => {
		const calls: number[] = [];
		const first = deferred<PageVisual>();
		const second = deferred<PageVisual>();
		const third = deferred<PageVisual>();
		const waiters = [first, second, third];
		const source = createSource((pageIndex) => {
			calls.push(pageIndex);
			const waiter = waiters[pageIndex];
			if (waiter === undefined) throw new Error("Unexpected page request.");
			return waiter.promise;
		});
		const scheduler = new PagePrerenderScheduler();
		scheduler.setSource(source);
		scheduler.setRequests([
			{ pageIndex: 0, scale: 1 },
			{ pageIndex: 1, scale: 1 },
			{ pageIndex: 2, scale: 1 },
		]);

		await vi.waitFor(() => expect(calls).toEqual([0, 1]));
		second.resolve(pixelVisual());
		await vi.waitFor(() => expect(calls).toEqual([0, 1, 2]));
		third.resolve(pixelVisual());
		first.resolve(pixelVisual());
		await vi.waitFor(() => expect(scheduler.take(0, 1)).toBeDefined());
		expect(scheduler.take(1, 1)).toBeDefined();
		expect(scheduler.take(2, 1)).toBeDefined();
		scheduler.setSource(null);
	});

	it("reuses only an exact scale match", async () => {
		const render = vi.fn(async () => pixelVisual());
		const scheduler = new PagePrerenderScheduler();
		scheduler.setSource(createSource(render));
		scheduler.setRequests([{ pageIndex: 2, scale: 1.5 }]);
		await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(scheduler.take(2, 1.25)).toBeUndefined());
		expect(scheduler.take(2, 1.5)).toBeDefined();
		scheduler.setSource(null);
	});

	it("hands the same in-flight page render to a newly visible request", async () => {
		const render = deferred<PageVisual>();
		const started = deferred<void>();
		const source = createSource(() => {
			started.resolve();
			return render.promise;
		});
		const scheduler = new PagePrerenderScheduler();
		scheduler.setSource(source);
		scheduler.setRequests([{ pageIndex: 2, scale: 1.5 }]);
		await started.promise;
		scheduler.setRequests([], true);

		const claimed = scheduler.claim(2, 1.5);
		expect(claimed).toBeDefined();
		expect(scheduler.claim(2, 1.5)).toBeUndefined();
		expect(scheduler.claim(2, 2)).toBeUndefined();
		const visual = pixelVisual();
		render.resolve(visual);
		expect(await claimed).toBe(visual);
		expect(scheduler.take(2, 1.5)).toBeUndefined();
		scheduler.setSource(null);
	});

	it("aborts an in-flight render after its request leaves the target set", async () => {
		const started = deferred<AbortSignal>();
		const result = deferred<PageVisual>();
		const scheduler = new PagePrerenderScheduler();
		scheduler.setSource(
			createSource((_pageIndex, _scale, signal) => {
				if (signal === undefined)
					throw new Error("The prerender signal was not forwarded.");
				started.resolve(signal);
				return result.promise;
			}),
		);
		scheduler.setRequests([{ pageIndex: 1, scale: 1 }]);
		const signal = await started.promise;

		scheduler.setRequests([]);

		expect(signal.aborted).toBe(true);
		result.resolve(pixelVisual());
		await flushTasks();
		scheduler.setSource(null);
	});

	it("transfers cached bitmap ownership without closing the returned visual", async () => {
		const close = vi.fn();
		const visual = bitmapVisual(close);
		if (visual.type !== "bitmap") throw new Error("Expected a bitmap visual.");
		const render = vi.fn(async () => visual);
		const scheduler = new PagePrerenderScheduler();
		scheduler.setSource(createSource(render));
		scheduler.setRequests([{ pageIndex: 3, scale: 1 }]);
		await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
		await flushTasks();
		expect(scheduler.take(3, 1)).toBe(visual);

		expect(close).not.toHaveBeenCalled();
		visual.bitmap.close();
		expect(close).toHaveBeenCalledOnce();
		scheduler.setSource(null);
	});

	it("closes late bitmap results after the target set changes", async () => {
		const result = deferred<PageVisual>();
		const close = vi.fn();
		const requested = deferred<void>();
		const scheduler = new PagePrerenderScheduler();
		scheduler.setSource(
			createSource(() => {
				requested.resolve();
				return result.promise;
			}),
		);
		scheduler.setRequests([{ pageIndex: 1, scale: 1 }]);
		await requested.promise;

		scheduler.setRequests([{ pageIndex: 2, scale: 1 }]);
		result.resolve(bitmapVisual(close));
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		expect(scheduler.take(1, 1)).toBeUndefined();
		scheduler.setSource(null);
	});

	it("keeps cache size within the entry budget and closes evicted visuals", async () => {
		const closes = Array.from({ length: MAX_PRERENDER_ENTRIES + 1 }, () => vi.fn());
		const renders: number[] = [];
		const scheduler = new PagePrerenderScheduler();
		const source = createSource(async (pageIndex) => {
			renders.push(pageIndex);
			const close = closes[pageIndex];
			if (close === undefined) throw new Error("Unexpected page request.");
			return bitmapVisual(close, 2048, 2048);
		});
		scheduler.setSource(source);
		scheduler.setRequests(closes.map((_, pageIndex) => ({ pageIndex, scale: 1 })));
		await vi.waitFor(() => expect(renders).toHaveLength(closes.length));

		expect(scheduler.take(0, 1)).toBeUndefined();
		expect(closes[0]?.mock.calls).toHaveLength(1);
		for (let pageIndex = 1; pageIndex < closes.length; pageIndex += 1) {
			expect(scheduler.take(pageIndex, 1)).toBeDefined();
		}
		scheduler.setSource(null);
	});

	it.each([
		{ budgetMiB: 64, retainedPages: [2, 3], evictedPages: [0, 1] },
		{ budgetMiB: 128, retainedPages: [0, 1, 2, 3], evictedPages: [] },
	])(
		"retains full-size images under a $budgetMiB MiB cache budget",
		async ({ budgetMiB, retainedPages, evictedPages }) => {
			const closes = Array.from({ length: 4 }, () => vi.fn());
			const visualBytes = 4096 * 2048 * 4;
			const scheduler = new PagePrerenderScheduler(4, budgetMiB * 1024 * 1024);
			scheduler.setSource(
				createSource(async (pageIndex) => {
					const close = closes[pageIndex];
					if (close === undefined) throw new Error("Unexpected page request.");
					return bitmapVisual(close, 4096, 2048);
				}),
			);
			scheduler.setRequests(
				Array.from({ length: 4 }, (_value, pageIndex) => ({ pageIndex, scale: 1 })),
			);

			await vi.waitFor(() =>
				expect(scheduler.cachedPixelBytes).toBe(retainedPages.length * visualBytes),
			);
			for (const pageIndex of retainedPages) {
				expect(scheduler.take(pageIndex, 1)).toBeDefined();
			}
			expect(scheduler.cachedPixelBytes).toBe(0);
			for (const pageIndex of evictedPages) {
				const close = closes[pageIndex];
				if (close === undefined) throw new Error("The evicted image is missing.");
				expect(close).toHaveBeenCalledOnce();
			}
			scheduler.setSource(null);
		},
	);

	it("silently drops ordinary render failures", async () => {
		const render = vi.fn(async () => {
			throw new Error("Temporary background failure.");
		});
		const scheduler = new PagePrerenderScheduler();
		scheduler.setSource(createSource(render));
		scheduler.setRequests([{ pageIndex: 1, scale: 1 }]);
		await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
		expect(scheduler.take(1, 1)).toBeUndefined();
		scheduler.setSource(null);
	});
});

function createSource(
	renderPrefetchedPage: (
		pageIndex: number,
		scale: number,
		signal?: AbortSignal,
	) => Promise<PageVisual>,
): PageSource {
	return {
		pageCount: 10,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		renderPage: async () => pixelVisual(),
		renderPrefetchedPage,
		dispose() {},
	};
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}

function bitmapVisual(close: () => void, width = 1, height = 1): PageVisual {
	const bitmap = { close } as unknown as ImageBitmap;
	return { type: "bitmap", width, height, bitmap };
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
