import { describe, expect, it, vi } from "vitest";

import { PageSourceUnavailableError } from "@/lib/document/page-source";
import type { PageSource, PageVisual } from "@/lib/document/page-source";

import { ThumbnailScheduler, type ThumbnailEntry } from "./thumbnail-scheduler";

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

	it("prefetches and keeps every embedded thumbnail within the pixel budget", async () => {
		const prefetchCalls: number[] = [];
		const render = vi.fn(async () => pixelVisual());
		const source = createPageSource(30, {
			prefetchThumbnail: async (pageIndex) => {
				prefetchCalls.push(pageIndex);
				return pixelVisual();
			},
		});
		const scheduler = new ThumbnailScheduler(render, () => undefined);
		scheduler.setSource(source);
		scheduler.setVisiblePages([29]);

		await vi.waitFor(() => expect(scheduler.entries).toHaveLength(30));
		expect(prefetchCalls).toHaveLength(29);
		expect(render).toHaveBeenCalledOnce();
		expect(scheduler.get(0)?.pageIndex).toBe(0);
		scheduler.close();
		expect(scheduler.entries).toHaveLength(30);
		scheduler.setSource(null);
		expect(scheduler.entries).toHaveLength(0);
	});

	it("prioritizes visible fallback when an in-flight embedded thumbnail is absent", async () => {
		const firstPrefetch = deferred<PageVisual | null>();
		const events: string[] = [];
		const source = createPageSource(8, {
			prefetchThumbnail: async (pageIndex) => {
				events.push(`embedded:${pageIndex}`);
				return pageIndex === 0 ? firstPrefetch.promise : null;
			},
		});
		const scheduler = new ThumbnailScheduler(
			async (pageIndex) => {
				events.push(`visible:${pageIndex}`);
				return pixelVisual();
			},
			() => undefined,
		);
		scheduler.setSource(source);
		scheduler.setVisiblePages([]);
		await vi.waitFor(() => expect(events).toEqual(["embedded:0"]));
		scheduler.setVisiblePages([0]);
		firstPrefetch.resolve(null);

		await vi.waitFor(() => expect(events).toContain("visible:0"));
		expect(events.slice(0, 2)).toEqual(["embedded:0", "visible:0"]);
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

	it("starts the current source while an old embedded lookup is pending", async () => {
		const oldThumbnail = deferred<PageVisual | null>();
		const oldThumbnailRequested = deferred<void>();
		const oldSource = createPageSource(1, {
			prefetchThumbnail: () => {
				oldThumbnailRequested.resolve();
				return oldThumbnail.promise;
			},
		});
		const render = vi.fn(async () => pixelVisual());
		const staleClose = vi.fn();
		const changes: ThumbnailEntry[][] = [];
		const scheduler = new ThumbnailScheduler(render, (entries) => changes.push([...entries]));
		scheduler.setSource(oldSource);
		scheduler.setVisiblePages([]);
		await oldThumbnailRequested.promise;

		scheduler.setSource(createPageSource(1));
		scheduler.setVisiblePages([0]);
		await vi.waitFor(() => expect(scheduler.entries).toHaveLength(1));
		const currentEntry = scheduler.entries[0];
		const currentChangeCount = changes.length;
		oldThumbnail.resolve(bitmapVisual(staleClose));
		await vi.waitFor(() => expect(staleClose).toHaveBeenCalledOnce());

		expect(render).toHaveBeenCalledOnce();
		expect(scheduler.entries[0]).toBe(currentEntry);
		expect(changes).toHaveLength(currentChangeCount);
		scheduler.setSource(null);
	});

	it("starts and keeps the current source while an old render is pending", async () => {
		const oldVisual = deferred<PageVisual>();
		const oldRenderStarted = deferred<void>();
		const staleClose = vi.fn();
		const render = vi
			.fn<(_pageIndex: number, _scale: number) => Promise<PageVisual>>()
			.mockImplementationOnce(() => {
				oldRenderStarted.resolve();
				return oldVisual.promise;
			})
			.mockResolvedValue(pixelVisual());
		const changes: ThumbnailEntry[][] = [];
		const scheduler = new ThumbnailScheduler(render, (entries) => changes.push([...entries]));
		scheduler.setSource(createPageSource(1));
		scheduler.setVisiblePages([0]);
		await oldRenderStarted.promise;

		scheduler.setSource(createPageSource(1));
		scheduler.setVisiblePages([0]);
		await vi.waitFor(() => expect(scheduler.entries).toHaveLength(1));
		const currentEntry = scheduler.entries[0];
		const currentChangeCount = changes.length;
		oldVisual.resolve(bitmapVisual(staleClose));
		await vi.waitFor(() => expect(staleClose).toHaveBeenCalledOnce());
		await Promise.resolve();

		expect(render).toHaveBeenCalledTimes(2);
		expect(scheduler.entries[0]).toBe(currentEntry);
		expect(changes).toHaveLength(currentChangeCount);
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

	it("reports a fatal error from the current source after its demand changes", async () => {
		const pendingRender = deferred<PageVisual>();
		const renderStarted = deferred<void>();
		const render = vi.fn(() => {
			renderStarted.resolve();
			return pendingRender.promise;
		});
		const sourceUnavailable = vi.fn();
		const scheduler = new ThumbnailScheduler(
			render,
			() => undefined,
			undefined,
			undefined,
			undefined,
			sourceUnavailable,
		);
		scheduler.setSource(createPageSource(2));
		scheduler.setVisiblePages([0], [1]);
		await renderStarted.promise;
		scheduler.setVisiblePages([1]);
		pendingRender.reject(new PageSourceUnavailableError("The source can no longer render."));
		await vi.waitFor(() => expect(sourceUnavailable).toHaveBeenCalledOnce());

		scheduler.setVisiblePages([1]);
		await Promise.resolve();
		expect(render).toHaveBeenCalledOnce();
		expect(scheduler.entries).toHaveLength(0);
		scheduler.setSource(null);
	});

	it("ignores a fatal error from a replaced source and keeps the new cache", async () => {
		const oldRender = deferred<PageVisual>();
		const oldRenderStarted = deferred<void>();
		const sourceUnavailable = vi.fn();
		const render = vi
			.fn<(_pageIndex: number, _scale: number) => Promise<PageVisual>>()
			.mockImplementationOnce(() => {
				oldRenderStarted.resolve();
				return oldRender.promise;
			})
			.mockResolvedValue(pixelVisual());
		const scheduler = new ThumbnailScheduler(
			render,
			() => undefined,
			undefined,
			undefined,
			undefined,
			sourceUnavailable,
		);
		scheduler.setSource(createPageSource(1));
		scheduler.setVisiblePages([0]);
		await oldRenderStarted.promise;

		scheduler.setSource(createPageSource(1));
		scheduler.setVisiblePages([0]);
		await vi.waitFor(() => expect(scheduler.entries).toHaveLength(1));
		const currentEntry = scheduler.entries[0];
		oldRender.reject(new PageSourceUnavailableError("The replaced source cannot render."));
		await Promise.resolve();
		await Promise.resolve();

		expect(sourceUnavailable).not.toHaveBeenCalled();
		expect(scheduler.entries[0]).toBe(currentEntry);
		expect(render).toHaveBeenCalledTimes(2);
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

function createPageSource(
	pageCount: number,
	options: {
		getPageSize?: PageSource["getPageSize"];
		prefetchThumbnail?: NonNullable<PageSource["prefetchThumbnail"]>;
	} = {},
): PageSource {
	return {
		pageCount,
		getPageSize: options.getPageSize ?? (async () => ({ width: 300, height: 400 })),
		...(options.prefetchThumbnail === undefined
			? {}
			: { prefetchThumbnail: options.prefetchThumbnail }),
		async renderPage() {
			return pixelVisual();
		},
		dispose() {},
	};
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
} {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function pixelVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}

function bitmapVisual(close: () => void): PageVisual {
	return { type: "bitmap", width: 1, height: 1, bitmap: { close } as unknown as ImageBitmap };
}
