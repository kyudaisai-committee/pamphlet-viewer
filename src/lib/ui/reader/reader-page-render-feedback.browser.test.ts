import { tick } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

import { ZOOM_RENDER_DELAY_MS } from "@/lib/ui/zoom/zoom-render-scheduler";

import {
	COLORS,
	createBackend,
	createDeferred,
	createVisual,
	createViewer,
	expectRenderedPages,
	visualFor,
	waitForPageChange,
	waitForRenderingFeedback,
	waitForAnimationFrames,
} from "./reader-page-render-fixtures";

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
});

test.each([
	{ viewport: "desktop", width: 840 },
	{ viewport: "mobile", width: 390 },
])("does not show feedback during a delayed zoom redraw on $viewport", async ({ width }) => {
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
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

	const shadowRoot = viewer.shadowRoot;
	if (shadowRoot === null) throw new Error("The viewer did not attach its shadow root.");
	const pageArea = shadowRoot.querySelector<HTMLElement>(".page-area");
	const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
	if (pageArea === null || zoomSlider === null) {
		throw new Error("The page area or zoom control is missing.");
	}
	deferRendering = true;
	zoomSlider.value = "4";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	await vi.advanceTimersByTimeAsync(ZOOM_RENDER_DELAY_MS);
	await zoomRenderStarted.promise;
	await tick();
	await vi.advanceTimersByTimeAsync(200);
	await tick();
	expect(shadowRoot.querySelector(".rendering-feedback")).toBeNull();
	expect(Number(zoomSlider.value)).toBe(4);
	expect(pageArea.scrollHeight).toBeGreaterThan(pageArea.clientHeight * 2);
	expect(pageArea.scrollWidth).toBeGreaterThan(pageArea.clientWidth);

	zoomRender.resolve(visualFor(0));
	await waitForAnimationFrames(2);
});

test.each([
	{ viewport: "desktop", width: 840 },
	{ viewport: "mobile", width: 390 },
])(
	"keeps page-navigation feedback visible at maximum zoom scroll on $viewport",
	async ({ width }) => {
		const pageTwoStarted = createDeferred<void>();
		const pageTwoRender = createDeferred<ReturnType<typeof visualFor>>();
		const zoomPixel: [number, number, number] = [42, 116, 178];
		let initialPageScale = 0;
		let captureInitialScale = true;
		const viewer = createViewer(
			createBackend(3, (pageIndex, scale) => {
				if (pageIndex === 1) {
					pageTwoStarted.resolve();
					return pageTwoRender.promise;
				}
				if (pageIndex === 0 && captureInitialScale) {
					initialPageScale = Math.max(initialPageScale, scale);
				}
				if (pageIndex === 0 && !captureInitialScale && scale > initialPageScale) {
					return Promise.resolve(createVisual(zoomPixel));
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
		if (pageArea === null || zoomSlider === null || stageViewport === null) {
			throw new Error("The page area, zoom control, or stage viewport is missing.");
		}

		captureInitialScale = false;
		zoomSlider.value = "4";
		zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
		await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: zoomPixel }]);

		expect(pageArea.scrollHeight).toBeGreaterThan(pageArea.clientHeight * 2);
		expect(pageArea.scrollWidth).toBeGreaterThan(pageArea.clientWidth);

		const secondPage = waitForPageChange(viewer, 2);
		viewer.page = 2;
		await pageTwoStarted.promise;
		const feedback = await waitForRenderingFeedback(viewer);
		await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: zoomPixel }]);

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

		pageTwoRender.resolve(visualFor(1));
		await secondPage;
		await expectRenderedPages(viewer, [{ pageIndex: 1, pixel: COLORS[1] ?? null }]);
		await expect.poll(() => shadowRoot.querySelector(".rendering-feedback")).toBeNull();
	},
);

test.each(["viewport resize", "same-page layout change"] as const)(
	"does not show feedback during a delayed $change redraw",
	async (change) => {
		const redrawStarted = createDeferred<void>();
		const redraw = createDeferred<ReturnType<typeof visualFor>>();
		let deferredPageIndex: number | null = null;
		const viewer = createViewer(
			createBackend(2, (pageIndex) => {
				if (pageIndex === deferredPageIndex) {
					redrawStarted.resolve();
					return redraw.promise;
				}
				return Promise.resolve(visualFor(pageIndex));
			}),
			{ page: 2, width: 840 },
		);
		viewer.fit = "width";
		viewer.layout = "single";
		const firstPage = waitForPageChange(viewer, 2);
		document.body.append(viewer);
		await firstPage;
		await expectRenderedPages(viewer, [{ pageIndex: 1, pixel: COLORS[1] ?? null }]);
		const shadowRoot = viewer.shadowRoot;
		if (shadowRoot === null) throw new Error("The viewer did not attach its shadow root.");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const redrawPageIndex = 1;
		deferredPageIndex = redrawPageIndex;
		if (change === "viewport resize") viewer.style.width = "960px";
		else viewer.layout = "spread";
		await redrawStarted.promise;
		await tick();
		await vi.advanceTimersByTimeAsync(200);
		await tick();
		expect(shadowRoot.querySelector(".rendering-feedback")).toBeNull();

		redraw.resolve(visualFor(redrawPageIndex));
		await waitForAnimationFrames(2);
		await expectRenderedPages(viewer, [{ pageIndex: 1, pixel: COLORS[1] ?? null }]);
	},
);
