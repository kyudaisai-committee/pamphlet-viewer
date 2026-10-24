import {
	PageSourceUnavailableError,
	type DocumentBackend,
	type PageSource,
	type PageVisual,
} from "../document/page-source";
import { calculateFitScale, resolveLayout, visiblePageIndexes } from "./layout";
import type { FitMode, LayoutMode, ViewportSize } from "./layout";
import { PageRenderQueue } from "./page-render-queue";
import { createPageRenderPlan } from "./render-plan";
import type { PageRenderPlan } from "./render-plan";
import {
	MAX_THUMBNAIL_ENTRIES,
	MAX_THUMBNAIL_PIXEL_BYTES,
	ThumbnailScheduler,
} from "./thumbnail-scheduler";
import type { ThumbnailEntry } from "./thumbnail-scheduler";

export type ViewerPhase = "empty" | "loading" | "ready" | "error";

export interface ViewerFailure {
	code: "invalid-source" | "invalid-option" | "load-failed" | "invalid-page" | "render-failed";
	message: string;
	retryable: boolean;
}

export type ViewerEvent =
	| { type: "documentload"; detail: { pageCount: number } }
	| { type: "pagechange"; detail: { page: number; visiblePages: number[] } }
	| { type: "error"; detail: ViewerFailure };

export interface RenderInput {
	page: number;
	layout: LayoutMode;
	fit: FitMode;
	zoom: number;
	viewport: ViewportSize;
	devicePixelRatio?: number;
}

interface ScheduledRender extends RenderInput {
	id: number;
	generation: number;
}

export class ViewerController {
	phase = $state<ViewerPhase>("empty");
	pageCount = $state(0);
	renderRevision = $state(0);
	renderedRequestId = $state<number | null>(null);
	renderedZoom = $state<number | null>(null);
	pageSource = $state<PageSource | null>(null);
	pageVisuals = $state<Record<number, PageVisual>>({});
	pageRenderPlans = $state<Record<number, PageRenderPlan>>({});
	thumbnailVisuals = $state<Record<number, PageVisual>>({});
	failure = $state<ViewerFailure | null>(null);

	#abortController: AbortController | null = null;
	#loadId = 0;
	#renderId = 0;
	#pendingRender: ScheduledRender | null = null;
	#renderingGeneration: number | null = null;
	#lastRenderKey = "";
	#lastPageChangeKey = "";
	#failedRenderKey = "";
	#sourceUrl: string | null = null;
	#backend: DocumentBackend | null = null;
	#sourceUnavailable = false;
	#renderQueue: PageRenderQueue | null = null;
	#thumbnailScheduler: ThumbnailScheduler;
	#reportCleanupError: (error: unknown) => void;

	constructor(
		private readonly dispatch: (event: ViewerEvent) => void,
		reportCleanupError: (error: unknown) => void = reportSourceDisposalFailure,
	) {
		this.#reportCleanupError = reportCleanupError;
		this.#thumbnailScheduler = new ThumbnailScheduler(
			(pageIndex, scale) => {
				const queue = this.#renderQueue;
				return queue === null
					? Promise.reject(new DOMException("The document is not open.", "AbortError"))
					: queue.render(pageIndex, scale, "thumbnail");
			},
			(entries) => this.#updateThumbnailVisuals(entries),
			() => this.#renderQueue?.cancelQueued("thumbnail"),
			MAX_THUMBNAIL_ENTRIES,
			MAX_THUMBNAIL_PIXEL_BYTES,
			() => this.#handleSourceUnavailable(),
		);
	}

	get sourceUnavailable(): boolean {
		return this.#sourceUnavailable;
	}

	async load(url: string, backend: DocumentBackend): Promise<void> {
		await this.#loadDocument(url, backend, null, false);
	}

	async #loadDocument(
		url: string,
		backend: DocumentBackend,
		renderAfterLoad: RenderInput | null,
		preservePageChangeKey: boolean,
	): Promise<void> {
		this.#cancelDocument(preservePageChangeKey);
		this.#sourceUrl = url.length === 0 ? null : url;
		this.#backend = url.length === 0 ? null : backend;
		this.#sourceUnavailable = false;
		const loadId = this.#loadId + 1;
		this.#loadId = loadId;
		this.failure = null;
		this.pageCount = 0;
		this.pageVisuals = {};
		this.#lastRenderKey = "";
		if (url.length === 0) {
			this.phase = "empty";
			return;
		}

		const abortController = new AbortController();
		this.#abortController = abortController;
		this.phase = "loading";
		try {
			const pageSource = await backend.open(url, abortController.signal);
			if (abortController.signal.aborted || loadId !== this.#loadId) {
				disposePageSource(pageSource, this.#reportCleanupError);
				return;
			}
			this.pageSource = pageSource;
			this.#renderQueue = new PageRenderQueue(pageSource);
			this.#thumbnailScheduler.setSource(pageSource);
			this.pageCount = pageSource.pageCount;
			this.phase = "ready";
			this.dispatch({ type: "documentload", detail: { pageCount: pageSource.pageCount } });
			if (renderAfterLoad !== null) this.requestRender(renderAfterLoad);
		} catch {
			if (abortController.signal.aborted || loadId !== this.#loadId) return;
			this.#setFailure({
				code: "load-failed",
				message: "PDFを読み込めませんでした。URLとサーバーのRange対応を確認してください。",
				retryable: true,
			});
		}
	}

	failInvalidSource(): void {
		this.#cancelDocument();
		this.pageCount = 0;
		this.pageVisuals = {};
		this.#setFailure({
			code: "invalid-source",
			message: "PDFのURLを解決できませんでした。",
			retryable: false,
		});
	}

	failInvalidOption(message: string): void {
		this.#invalidateRenderRequests();
		this.#setFailure({ code: "invalid-option", message, retryable: false });
	}

	requestRender(input: RenderInput): number | null {
		if (this.pageSource === null || this.#sourceUnavailable) return null;
		if (this.pageCount < 1 || input.viewport.width <= 0 || input.viewport.height <= 0) return null;
		if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > this.pageCount) {
			this.#invalidateRenderRequests();
			this.#setFailure({
				code: "invalid-page",
				message: `ページ番号は1から${this.pageCount}の範囲で指定してください。`,
				retryable: false,
			});
			return null;
		}

		const key = [
			input.page,
			input.layout,
			input.fit,
			input.zoom,
			input.viewport.width,
			input.viewport.height,
			input.devicePixelRatio ?? 1,
		].join(":");
		if (this.phase === "error") {
			if (this.failure?.code === "load-failed" || key === this.#failedRenderKey) return null;
			this.phase = "ready";
			this.failure = null;
		}
		if (this.phase !== "ready") return null;
		if (key === this.#lastRenderKey) return this.#renderId;
		this.#lastRenderKey = key;
		this.#renderQueue?.cancelQueued("visible");
		const id = this.#renderId + 1;
		this.#renderId = id;
		const generation = this.#loadId;
		this.#pendingRender = { ...input, id, generation };
		if (this.#renderingGeneration !== generation) void this.#drainRenderQueue(generation);
		return id;
	}

	retryRender(input: RenderInput): void {
		if (this.#sourceUnavailable) {
			const url = this.#sourceUrl;
			const backend = this.#backend;
			if (url !== null && backend !== null) {
				void this.#loadDocument(url, backend, input, true);
			}
			return;
		}
		this.#failedRenderKey = "";
		this.#lastRenderKey = "";
		this.failure = null;
		this.phase = "ready";
		this.requestRender(input);
	}

	setThumbnailPages(pageIndexes: readonly number[], prefetchIndexes: readonly number[] = []): void {
		this.#thumbnailScheduler.setVisiblePages(pageIndexes, prefetchIndexes);
	}

	closeThumbnails(): void {
		this.#thumbnailScheduler.close();
	}

	dispose(): void {
		this.#cancelDocument();
		this.#sourceUrl = null;
		this.#backend = null;
		this.#sourceUnavailable = false;
		this.pageVisuals = {};
		this.pageCount = 0;
		this.phase = "empty";
	}

	async #drainRenderQueue(generation: number): Promise<void> {
		if (this.#renderingGeneration === generation) return;
		this.#renderingGeneration = generation;
		try {
			while (
				generation === this.#loadId &&
				this.#pendingRender !== null &&
				this.#pendingRender.generation === generation
			) {
				const request = this.#pendingRender;
				this.#pendingRender = null;
				await this.#render(request);
			}
		} finally {
			if (this.#renderingGeneration === generation) this.#renderingGeneration = null;
			const pendingGeneration = this.#pendingRender?.generation;
			if (pendingGeneration !== undefined && pendingGeneration === this.#loadId) {
				void this.#drainRenderQueue(pendingGeneration);
			}
		}
	}

	async #render(request: ScheduledRender): Promise<void> {
		const source = this.pageSource;
		const renderQueue = this.#renderQueue;
		if (source === null || renderQueue === null) return;
		const layout = resolveLayout(request.layout, request.viewport.width);
		const pageIndexes = visiblePageIndexes(this.pageCount, request.page, layout);
		try {
			const pageSizes = await Promise.all(pageIndexes.map((index) => source.getPageSize(index)));
			if (!this.#isCurrent(request, source)) return;
			const displayScale = calculateFitScale(
				pageSizes,
				request.viewport,
				request.fit,
				request.zoom,
			);
			const plans = pageSizes.map((pageSize) =>
				createPageRenderPlan(pageSize, displayScale, undefined, request.devicePixelRatio ?? 1),
			);
			const visualResults = await Promise.allSettled(
				pageIndexes.map(async (pageIndex, localIndex) => {
					const plan = plans[localIndex];
					if (plan === undefined) throw new Error("The page render plan is missing.");
					const visual = await renderQueue.render(pageIndex, plan.rasterScale, "visible");
					return { visual, plan };
				}),
			);
			const completedRenders = visualResults.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			);
			const renderFailure = visualResults.find((result) => result.status === "rejected");
			if (renderFailure?.status === "rejected") {
				releaseVisuals(completedRenders.map((result) => result.visual));
				throw renderFailure.reason;
			}
			if (!this.#isCurrent(request, source)) {
				releaseVisuals(completedRenders.map((result) => result.visual));
				return;
			}
			const nextPages: Record<number, PageVisual> = {};
			const nextPlans: Record<number, PageRenderPlan> = {};
			for (const [visualIndex, rendered] of completedRenders.entries()) {
				const pageIndex = pageIndexes[visualIndex];
				if (pageIndex === undefined) continue;
				nextPages[pageIndex] = rendered.visual;
				nextPlans[pageIndex] = rendered.plan;
			}
			this.#releaseCurrentVisuals();
			this.pageVisuals = nextPages;
			this.pageRenderPlans = nextPlans;
			this.renderedRequestId = request.id;
			this.renderedZoom = request.zoom;
			this.renderRevision += 1;
			const visiblePages = pageIndexes.map((index) => index + 1);
			const pageChangeKey = `${request.page}:${visiblePages.join(",")}`;
			if (pageChangeKey !== this.#lastPageChangeKey) {
				this.#lastPageChangeKey = pageChangeKey;
				this.dispatch({
					type: "pagechange",
					detail: { page: request.page, visiblePages },
				});
			}
		} catch (error) {
			if (!this.#isCurrent(request, source)) return;
			if (error instanceof PageSourceUnavailableError) {
				this.#handleSourceUnavailable();
			} else {
				this.#sourceUnavailable = false;
				this.#lastRenderKey = "";
				this.#failedRenderKey = [
					request.page,
					request.layout,
					request.fit,
					request.zoom,
					request.viewport.width,
					request.viewport.height,
					request.devicePixelRatio ?? 1,
				].join(":");
				this.#setFailure({
					code: "render-failed",
					message: "ページを表示できませんでした。もう一度お試しください。",
					retryable: true,
				});
			}
		}
	}

	#isCurrent(request: ScheduledRender, source: PageSource): boolean {
		return (
			request.id === this.#renderId &&
			request.generation === this.#loadId &&
			source === this.pageSource
		);
	}

	#cancelDocument(preservePageChangeKey = false): void {
		this.#loadId += 1;
		this.#renderId += 1;
		this.#pendingRender = null;
		this.#lastRenderKey = "";
		this.renderedRequestId = null;
		this.renderedZoom = null;
		if (!preservePageChangeKey) this.#lastPageChangeKey = "";
		this.#failedRenderKey = "";
		this.#renderQueue?.dispose();
		this.#renderQueue = null;
		this.#thumbnailScheduler.setSource(null);
		this.#abortController?.abort();
		this.#abortController = null;
		const source = this.pageSource;
		this.pageSource = null;
		if (source !== null) disposePageSource(source, this.#reportCleanupError);
		this.#releaseCurrentVisuals();
		this.pageVisuals = {};
		this.pageRenderPlans = {};
	}

	#releaseCurrentVisuals(): void {
		for (const visual of Object.values(this.pageVisuals)) {
			if (visual.type === "bitmap") visual.bitmap.close();
		}
	}

	#updateThumbnailVisuals(entries: readonly ThumbnailEntry[]): void {
		const nextVisuals: Record<number, PageVisual> = {};
		for (const entry of entries) nextVisuals[entry.pageIndex] = entry.visual;
		this.thumbnailVisuals = nextVisuals;
	}

	#handleSourceUnavailable(): void {
		this.#sourceUnavailable = true;
		this.#invalidateRenderRequests();
		this.#setFailure({
			code: "render-failed",
			message: "ページを表示できませんでした。もう一度お試しください。",
			retryable: true,
		});
	}

	#invalidateRenderRequests(): void {
		this.#renderId += 1;
		this.#pendingRender = null;
		this.#lastRenderKey = "";
		this.#failedRenderKey = "";
		this.#renderQueue?.cancelQueued("visible");
	}

	#setFailure(failure: ViewerFailure): void {
		if (
			this.phase === "error" &&
			this.failure?.code === failure.code &&
			this.failure.message === failure.message &&
			this.failure.retryable === failure.retryable
		) {
			return;
		}
		this.failure = failure;
		this.phase = "error";
		this.dispatch({ type: "error", detail: failure });
	}
}

function releaseVisuals(visuals: PageVisual[]): void {
	for (const visual of visuals) {
		if (visual.type === "bitmap") visual.bitmap.close();
	}
}

function disposePageSource(source: PageSource, reportCleanupError: (error: unknown) => void): void {
	try {
		const disposal = source.dispose();
		if (disposal !== undefined) void disposal.catch(reportCleanupError);
	} catch (error) {
		reportCleanupError(error);
	}
}

function reportSourceDisposalFailure(error: unknown): void {
	console.error("The pamphlet viewer could not dispose a document source.", error);
}
