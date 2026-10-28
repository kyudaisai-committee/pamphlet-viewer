import { afterEach, expect, test } from "vitest";

import {
	COLORS,
	createBackend,
	createDeferred,
	createPageSource,
	createVisual,
	createViewer,
	delay,
	expectRenderedPages,
	observePageFrames,
	readRenderedPages,
	visualFor,
	waitForPageChange,
} from "./reader-page-render-fixtures";

afterEach(() => {
	document.body.replaceChildren();
});

test.each([
	{ background: "dark page", color: [18, 20, 22] as [number, number, number] },
	{ background: "light page", color: [245, 245, 245] as [number, number, number] },
])("keeps the current canvas and readable feedback over a $background", async ({ color }) => {
	await import("@/lib/entry");
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
	await delay(150);
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: color }]);
	const feedback = viewer.shadowRoot?.querySelector<HTMLElement>(".rendering-feedback");
	const pageArea = viewer.shadowRoot?.querySelector<HTMLElement>(".page-area");
	if (
		feedback === null ||
		feedback === undefined ||
		pageArea === null ||
		pageArea === undefined
	) {
		throw new Error("The pending render feedback or page area is missing.");
	}
	expect(feedback.textContent).toContain("ページを描画しています。");
	expect(getComputedStyle(feedback).backgroundColor).toBe("rgb(17, 20, 22)");
	expect(getComputedStyle(feedback).color).toBe("rgb(255, 255, 255)");
	expect(getComputedStyle(feedback).fontSize).toBe("14px");
	const pageAreaBounds = pageArea.getBoundingClientRect();
	let feedbackBounds = feedback.getBoundingClientRect();
	expect(feedbackBounds.top).toBeGreaterThanOrEqual(pageAreaBounds.top);
	expect(feedbackBounds.bottom).toBeLessThanOrEqual(pageAreaBounds.bottom);
	const scrollHeight = pageArea.scrollHeight;
	pageArea.scrollTop = 180;
	pageArea.dispatchEvent(new Event("scroll"));
	feedbackBounds = feedback.getBoundingClientRect();
	expect(feedbackBounds.top).toBeGreaterThanOrEqual(pageAreaBounds.top);
	expect(feedbackBounds.bottom).toBeLessThanOrEqual(pageAreaBounds.bottom);
	expect(pageArea.scrollHeight).toBe(scrollHeight);

	pageTwoRender.resolve(visualFor(1));
	await secondPage;
	await expectRenderedPages(viewer, [{ pageIndex: 1, pixel: COLORS[1] ?? null }]);
});

test.each([
	{ viewport: "desktop", width: 840 },
	{ viewport: "mobile", width: 390 },
])(
	"keeps delayed-render feedback visible at maximum zoom scroll on $viewport",
	async ({ width }) => {
		await import("@/lib/entry");
		const zoomRenderStarted = createDeferred<void>();
		const zoomRender = createDeferred<ReturnType<typeof visualFor>>();
		let deferRendering = false;
		const viewer = createViewer(
			createBackend(1, (pageIndex) => {
				if (deferRendering) {
					zoomRenderStarted.resolve();
					return zoomRender.promise;
				}
				return Promise.resolve(visualFor(pageIndex));
			}),
			{ width },
		);
		viewer.fit = "width";
		const firstPage = waitForPageChange(viewer, 1);
		document.body.append(viewer);
		await firstPage;
		await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: COLORS[0] ?? null }]);

		const shadowRoot = viewer.shadowRoot;
		if (shadowRoot === null) throw new Error("The viewer did not attach its shadow root.");
		const pageArea = shadowRoot.querySelector<HTMLElement>(".page-area");
		const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
		const stageViewport = shadowRoot.querySelector<HTMLElement>(".stage-viewport");
		if (
			pageArea === null ||
			pageArea === undefined ||
			zoomSlider === null ||
			zoomSlider === undefined ||
			stageViewport === null ||
			stageViewport === undefined
		) {
			throw new Error("The page area, zoom control, or stage viewport is missing.");
		}
		deferRendering = true;
		zoomSlider.value = "4";
		zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
		await zoomRenderStarted.promise;
		await delay(150);

		const feedback = shadowRoot?.querySelector<HTMLElement>(".rendering-feedback");
		if (feedback === null || feedback === undefined) {
			throw new Error("The delayed-render feedback is missing.");
		}
		expect(Number(zoomSlider.value)).toBe(4);
		expect(pageArea.scrollHeight).toBeGreaterThan(pageArea.clientHeight * 2);
		expect(pageArea.scrollWidth).toBeGreaterThan(pageArea.clientWidth);
		const scrollDimensions = {
			height: pageArea.scrollHeight,
			width: pageArea.scrollWidth,
			clientHeight: pageArea.clientHeight,
			clientWidth: pageArea.clientWidth,
		};
		pageArea.scrollTop = pageArea.scrollHeight - pageArea.clientHeight;
		pageArea.scrollLeft = pageArea.scrollWidth - pageArea.clientWidth;
		pageArea.dispatchEvent(new Event("scroll"));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		expect(pageArea.scrollTop).toBeGreaterThanOrEqual(
			pageArea.scrollHeight - pageArea.clientHeight - 1,
		);
		expect(pageArea.scrollLeft).toBeGreaterThanOrEqual(
			pageArea.scrollWidth - pageArea.clientWidth - 1,
		);
		expect({
			height: pageArea.scrollHeight,
			width: pageArea.scrollWidth,
			clientHeight: pageArea.clientHeight,
			clientWidth: pageArea.clientWidth,
		}).toEqual(scrollDimensions);

		const stageBounds = stageViewport.getBoundingClientRect();
		const pageAreaBounds = pageArea.getBoundingClientRect();
		const feedbackBounds = feedback.getBoundingClientRect();
		expect(feedbackBounds.top).toBeGreaterThanOrEqual(stageBounds.top);
		expect(feedbackBounds.bottom).toBeLessThanOrEqual(stageBounds.bottom);
		expect(feedbackBounds.left).toBeGreaterThanOrEqual(pageAreaBounds.left);
		expect(feedbackBounds.right).toBeLessThanOrEqual(pageAreaBounds.right);

		zoomRender.resolve(visualFor(0));
		await expect.poll(() => shadowRoot.querySelector(".rendering-feedback")).toBeNull();
	},
);

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
	await delay(100);
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
	await delay(150);
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
	expect(viewer.shadowRoot?.querySelector(".rendering-feedback")).toBeNull();
});
