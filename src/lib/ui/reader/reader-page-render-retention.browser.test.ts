import { afterEach, expect, test } from "vitest";

import {
	COLORS,
	createBackend,
	createDeferred,
	createPageSource,
	createVisual,
	createViewer,
	expectRenderedPages,
	observePageFrames,
	readRenderedPages,
	visualFor,
	waitForAnimationFrames,
	waitForRenderingFeedback,
	waitForPageChange,
} from "./reader-page-render-fixtures";

afterEach(() => {
	document.body.replaceChildren();
});

test("keeps the current canvas until the new page is ready", async () => {
	await import("@/lib/entry");
	const color: [number, number, number] = [18, 20, 22];
	const pageTwoStarted = createDeferred<void>();
	const pageTwoRender = createDeferred<ReturnType<typeof visualFor>>();
	const viewer = createViewer(
		createBackend(4, (pageIndex) => {
			if (pageIndex === 1) {
				pageTwoStarted.resolve();
				return pageTwoRender.promise;
			}
			if (pageIndex === 0) return Promise.resolve(createVisual(color));
			return Promise.resolve(visualFor(pageIndex));
		}),
	);
	viewer.fit = "width";
	const firstPage = waitForPageChange(viewer, 1);
	document.body.append(viewer);
	await firstPage;
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: color }]);

	const secondPage = waitForPageChange(viewer, 2);
	viewer.page = 2;
	await pageTwoStarted.promise;
	const feedback = await waitForRenderingFeedback(viewer);
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: color }]);
	expect(feedback.getAttribute("role")).toBe("status");
	expect(feedback.textContent).toContain("ページを描画しています。");

	pageTwoRender.resolve(visualFor(1));
	await secondPage;
	await expectRenderedPages(viewer, [{ pageIndex: 1, pixel: COLORS[1] ?? null }]);
	await expect.poll(() => viewer.shadowRoot?.querySelector(".rendering-feedback")).toBeNull();
});

test("keeps a nonempty canvas across a normal quick page transition", async () => {
	await import("@/lib/entry");
	const viewer = createViewer(createBackend(4, async (pageIndex) => visualFor(pageIndex)));
	const firstPage = waitForPageChange(viewer, 1);
	document.body.append(viewer);
	await firstPage;
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: COLORS[0] ?? null }]);

	const pageFrames = observePageFrames(viewer);
	const secondPage = waitForPageChange(viewer, 2);
	viewer.page = 2;
	expect(readRenderedPages(viewer)).toEqual([{ pageIndex: 0, pixel: COLORS[0] ?? null }]);
	await secondPage;
	await expectRenderedPages(viewer, [{ pageIndex: 1, pixel: COLORS[1] ?? null }]);
	await pageFrames.sampleTwoFrames();
	pageFrames.stop();
	expect(pageFrames.counts.every((count) => count > 0)).toBe(true);
});

test("keeps a canvas present when an adjacent prerender is already cached", async () => {
	await import("@/lib/entry");
	const prerenderStarted = createDeferred<void>();
	const prerenderFinished = createDeferred<void>();
	const renderCalls: number[] = [];
	const prerenderCalls: number[] = [];
	const source = createPageSource(
		4,
		async (pageIndex) => {
			renderCalls.push(pageIndex);
			return visualFor(pageIndex);
		},
		{
			async getPrefetchedPageSize() {
				return { width: 300, height: 400 };
			},
			async renderPrefetchedPage(pageIndex) {
				prerenderCalls.push(pageIndex);
				prerenderStarted.resolve();
				return Promise.resolve(visualFor(pageIndex)).then((visual) => {
					prerenderFinished.resolve();
					return visual;
				});
			},
		},
	);
	const viewer = createViewer({
		async open() {
			return source;
		},
	});
	const firstPage = waitForPageChange(viewer, 1);
	document.body.append(viewer);
	await firstPage;
	await prerenderStarted.promise;
	await prerenderFinished.promise;
	await waitForAnimationFrames(2);
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: COLORS[0] ?? null }]);
	expect(prerenderCalls).toContain(1);
	expect(renderCalls).not.toContain(1);

	const pageFrames = observePageFrames(viewer);
	const secondPage = waitForPageChange(viewer, 2);
	viewer.page = 2;
	expect(readRenderedPages(viewer)).toEqual([{ pageIndex: 0, pixel: COLORS[0] ?? null }]);
	await secondPage;
	await expectRenderedPages(viewer, [{ pageIndex: 1, pixel: COLORS[1] ?? null }]);
	await pageFrames.sampleTwoFrames();
	pageFrames.stop();

	expect(renderCalls).not.toContain(1);
	expect(pageFrames.counts.length).toBeGreaterThan(0);
	expect(pageFrames.counts.every((count) => count > 0)).toBe(true);
});

test("keeps both old spread pages until both new pages finish rendering", async () => {
	await import("@/lib/entry");
	const pageFourStarted = createDeferred<void>();
	const pageFiveStarted = createDeferred<void>();
	const pageFourRender = createDeferred<ReturnType<typeof visualFor>>();
	const pageFiveRender = createDeferred<ReturnType<typeof visualFor>>();
	const viewer = createViewer(
		createBackend(6, (pageIndex) => {
			if (pageIndex === 3) {
				pageFourStarted.resolve();
				return pageFourRender.promise;
			}
			if (pageIndex === 4) {
				pageFiveStarted.resolve();
				return pageFiveRender.promise;
			}
			return Promise.resolve(visualFor(pageIndex));
		}),
		{ page: 2, layout: "spread" },
	);
	const currentSpread = waitForPageChange(viewer, 2);
	document.body.append(viewer);
	await currentSpread;
	await expectRenderedPages(viewer, [
		{ pageIndex: 1, pixel: COLORS[1] ?? null },
		{ pageIndex: 2, pixel: COLORS[2] ?? null },
	]);

	const nextSpread = waitForPageChange(viewer, 4);
	viewer.page = 4;
	await Promise.all([pageFourStarted.promise, pageFiveStarted.promise]);
	pageFiveRender.resolve(visualFor(4));
	await waitForRenderingFeedback(viewer);
	await expectRenderedPages(viewer, [
		{ pageIndex: 1, pixel: COLORS[1] ?? null },
		{ pageIndex: 2, pixel: COLORS[2] ?? null },
	]);
	expect(viewer.shadowRoot?.querySelector(".rendering-feedback")).not.toBeNull();

	pageFourRender.resolve(visualFor(3));
	await nextSpread;
	await expectRenderedPages(viewer, [
		{ pageIndex: 3, pixel: COLORS[3] ?? null },
		{ pageIndex: 4, pixel: COLORS[4] ?? null },
	]);
	await expect.poll(() => viewer.shadowRoot?.querySelector(".rendering-feedback")).toBeNull();
});
