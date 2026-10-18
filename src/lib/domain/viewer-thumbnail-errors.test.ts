import { expect, test, vi } from "vitest";

import {
	PageSourceUnavailableError,
	type DocumentBackend,
	type PageSource,
	type PageVisual,
} from "../document/page-source";
import { ViewerController } from "./viewer-controller.svelte";

test("keeps the document ready after an ordinary thumbnail failure", async () => {
	const events: string[] = [];
	const renderPage = vi.fn(async () => {
		throw new Error("The thumbnail could not be rendered.");
	});
	const controller = new ViewerController((event) => events.push(event.type));
	await controller.load("brochure.pdf", createBackend(createPageSource(renderPage)));

	controller.setThumbnailPages([0]);
	await vi.waitFor(() => expect(renderPage).toHaveBeenCalledOnce());
	expect(controller.phase).toBe("ready");
	expect(controller.sourceUnavailable).toBe(false);
	expect(events).not.toContain("error");

	controller.setThumbnailPages([0]);
	await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
	expect(controller.phase).toBe("ready");
	controller.dispose();
});

test("reopens a source after a fatal thumbnail failure and resumes its demand", async () => {
	const unavailableRender = vi.fn(async () => {
		throw new PageSourceUnavailableError("The thumbnail source is unavailable.");
	});
	const recoveredRender = vi.fn(async () => pageVisual());
	const unavailableSource = createPageSource(unavailableRender);
	const recoveredSource = createPageSource(recoveredRender);
	let openCount = 0;
	const backend: DocumentBackend = {
		async open() {
			openCount += 1;
			return openCount === 1 ? unavailableSource : recoveredSource;
		},
	};
	const controller = new ViewerController(() => undefined);
	await controller.load("brochure.pdf", backend);
	controller.setThumbnailPages([0]);
	await vi.waitFor(() => expect(controller.failure?.code).toBe("render-failed"));
	expect(controller.sourceUnavailable).toBe(true);
	controller.requestRender({
		page: 1,
		layout: "single",
		fit: "page",
		zoom: 1,
		viewport: { width: 600, height: 800 },
	});
	expect(controller.phase).toBe("error");
	expect(unavailableRender).toHaveBeenCalledOnce();

	controller.retryRender({
		page: 1,
		layout: "single",
		fit: "page",
		zoom: 1,
		viewport: { width: 600, height: 800 },
	});
	await vi.waitFor(() => expect(controller.renderRevision).toBe(1));
	controller.setThumbnailPages([0]);
	await vi.waitFor(() => expect(controller.thumbnailVisuals[0]).toBeDefined());

	expect(openCount).toBe(2);
	expect(controller.phase).toBe("ready");
	expect(controller.pageVisuals[0]).toBeDefined();
	expect(recoveredRender).toHaveBeenCalledTimes(2);
	controller.dispose();
});

test.each(["resolve", "reject"] as const)(
	"keeps a fatal thumbnail failure after a pending body page-size request %s",
	async (settlement) => {
		const pendingPageSize = createDeferred<{ width: number; height: number }>();
		let pageSizeCalls = 0;
		const source: PageSource = {
			pageCount: 1,
			getPageSize() {
				pageSizeCalls += 1;
				return pageSizeCalls === 1
					? pendingPageSize.promise
					: Promise.resolve({ width: 300, height: 400 });
			},
			async renderPage() {
				throw new PageSourceUnavailableError("The thumbnail source is unavailable.");
			},
			dispose() {},
		};
		const controller = new ViewerController(() => undefined);
		await controller.load("brochure.pdf", createBackend(source));
		controller.requestRender({
			page: 1,
			layout: "single",
			fit: "page",
			zoom: 1,
			viewport: { width: 600, height: 800 },
		});
		await vi.waitFor(() => expect(pageSizeCalls).toBe(1));

		controller.setThumbnailPages([0]);
		await vi.waitFor(() => expect(controller.sourceUnavailable).toBe(true));
		if (settlement === "resolve") {
			pendingPageSize.resolve({ width: 300, height: 400 });
		} else {
			pendingPageSize.reject(new Error("The stale body size request failed."));
		}
		await Promise.resolve();

		expect(controller.phase).toBe("error");
		expect(controller.failure?.code).toBe("render-failed");
		expect(controller.sourceUnavailable).toBe(true);
		controller.dispose();
	},
);

function createBackend(pageSource: PageSource): DocumentBackend {
	return {
		async open() {
			return pageSource;
		},
	};
}

function createPageSource(renderPage: PageSource["renderPage"]): PageSource {
	return {
		pageCount: 1,
		async getPageSize() {
			return { width: 300, height: 400 };
		},
		renderPage,
		dispose() {},
	};
}

function pageVisual(): PageVisual {
	return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
} {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}
