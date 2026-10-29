import { afterEach, expect, test } from "vitest";

import type { DocumentBackend, PageSource } from "@/lib/document/page-source";

import {
	COLORS,
	createBackend,
	createDeferred,
	createPageSource,
	createViewer,
	expectRenderedPages,
	readRenderedPages,
	visualFor,
	waitForAnimationFrames,
	waitForPageChange,
	waitForRenderingFeedback,
} from "./reader-page-render-fixtures";

afterEach(() => {
	document.body.replaceChildren();
});

test("does not restore an outdated page after a newer page finishes", async () => {
	const pageTwoStarted = createDeferred<void>();
	const pageTwoRender = createDeferred<ReturnType<typeof visualFor>>();
	const viewer = createViewer(
		createBackend(4, (pageIndex) => {
			if (pageIndex === 1) {
				pageTwoStarted.resolve();
				return pageTwoRender.promise;
			}
			return Promise.resolve(visualFor(pageIndex));
		}),
	);
	const pageChanges: number[] = [];
	viewer.addEventListener("pagechange", (event) => pageChanges.push(event.detail.page));
	const firstPage = waitForPageChange(viewer, 1);
	document.body.append(viewer);
	await firstPage;

	viewer.page = 2;
	await pageTwoStarted.promise;
	const thirdPage = waitForPageChange(viewer, 3);
	viewer.page = 3;
	await thirdPage;
	await waitForAnimationFrames(2);
	await expectRenderedPages(viewer, [{ pageIndex: 2, pixel: COLORS[2] ?? null }]);

	pageTwoRender.resolve(visualFor(1));
	await waitForAnimationFrames(2);
	await expectRenderedPages(viewer, [{ pageIndex: 2, pixel: COLORS[2] ?? null }]);
	expect(pageChanges).toEqual([1, 3]);
});

test("clears navigation feedback when returning to the still-visible page", async () => {
	const pageTwoStarted = createDeferred<void>();
	const pageTwoRender = createDeferred<ReturnType<typeof visualFor>>();
	const viewer = createViewer(
		createBackend(3, (pageIndex) => {
			if (pageIndex === 1) {
				pageTwoStarted.resolve();
				return pageTwoRender.promise;
			}
			return Promise.resolve(visualFor(pageIndex));
		}),
	);
	const firstPage = waitForPageChange(viewer, 1);
	document.body.append(viewer);
	await firstPage;
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: COLORS[0] ?? null }]);

	viewer.page = 2;
	await pageTwoStarted.promise;
	await waitForRenderingFeedback(viewer);

	viewer.page = 1;
	await expect.poll(() => viewer.shadowRoot?.querySelector(".rendering-feedback")).toBeNull();
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: COLORS[0] ?? null }]);
	pageTwoRender.resolve(visualFor(1));
	await waitForAnimationFrames(2);
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: COLORS[0] ?? null }]);
});

test("clears old pages on source change and ignores a late render from the old source", async () => {
	const oldPageTwoStarted = createDeferred<void>();
	const oldPageTwoRender = createDeferred<ReturnType<typeof visualFor>>();
	const newSource = createDeferred<PageSource>();
	const oldSource = createPageSource(3, async (pageIndex) => {
		if (pageIndex === 1) {
			oldPageTwoStarted.resolve();
			return oldPageTwoRender.promise;
		}
		return visualFor(pageIndex);
	});
	const backend: DocumentBackend = {
		async open(source) {
			return source.endsWith("second.pdf") ? newSource.promise : oldSource;
		},
	};
	const viewer = createViewer(backend);
	const pageChanges: number[] = [];
	viewer.addEventListener("pagechange", (event) => pageChanges.push(event.detail.page));
	const firstPage = waitForPageChange(viewer, 1);
	document.body.append(viewer);
	await firstPage;
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: COLORS[0] ?? null }]);

	viewer.page = 2;
	await oldPageTwoStarted.promise;
	const feedback = await waitForRenderingFeedback(viewer);
	expect(feedback.textContent).toContain("ページを描画しています。");
	viewer.src = "./reader-page-render-second.pdf";
	await expect
		.poll(() => viewer.shadowRoot?.querySelector(".status")?.textContent)
		.toContain("PDFの情報を読み込んでいます。");
	expect(readRenderedPages(viewer)).toEqual([]);
	await expect.poll(() => viewer.shadowRoot?.querySelector(".rendering-feedback")).toBeNull();

	const replacementPage = waitForPageChange(viewer, 1);
	newSource.resolve(
		createPageSource(1, async () => ({
			type: "pixels",
			width: 1,
			height: 1,
			pixels: new Uint8Array([140, 40, 180, 255]).buffer,
		})),
	);
	await replacementPage;
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: [140, 40, 180] }]);

	oldPageTwoRender.resolve(visualFor(1));
	await waitForAnimationFrames(2);
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: [140, 40, 180] }]);
	expect(pageChanges).toEqual([1, 1]);
});

test("hides the previous page when a replacement render fails", async () => {
	const pageTwoStarted = createDeferred<void>();
	const pageTwoRender = createDeferred<ReturnType<typeof visualFor>>();
	const viewer = createViewer(
		createBackend(3, (pageIndex) => {
			if (pageIndex === 1) {
				pageTwoStarted.resolve();
				return pageTwoRender.promise;
			}
			return Promise.resolve(visualFor(pageIndex));
		}),
	);
	const firstPage = waitForPageChange(viewer, 1);
	document.body.append(viewer);
	await firstPage;
	await expectRenderedPages(viewer, [{ pageIndex: 0, pixel: COLORS[0] ?? null }]);

	viewer.page = 2;
	await pageTwoStarted.promise;
	await waitForRenderingFeedback(viewer);
	pageTwoRender.reject(new Error("The page could not be rendered."));
	await expect.poll(() => viewer.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull();
	expect(readRenderedPages(viewer)).toEqual([]);
	await expect.poll(() => viewer.shadowRoot?.querySelector(".rendering-feedback")).toBeNull();
});
