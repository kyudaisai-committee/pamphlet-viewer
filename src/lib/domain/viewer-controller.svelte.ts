import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import { calculateFitScale, resolveLayout, visiblePageIndexes } from "./layout";
import type { FitMode, LayoutMode, ViewportSize } from "./layout";

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
}

interface ScheduledRender extends RenderInput {
	id: number;
}

export class ViewerController {
	phase = $state<ViewerPhase>("empty");
	pageCount = $state(0);
	pageSource = $state<PageSource | null>(null);
	pageVisuals = $state<Record<number, PageVisual>>({});
	failure = $state<ViewerFailure | null>(null);

	#abortController: AbortController | null = null;
	#loadId = 0;
	#renderId = 0;
	#pendingRender: ScheduledRender | null = null;
	#rendering = false;
	#lastRenderKey = "";
	#failedRenderKey = "";

	constructor(private readonly dispatch: (event: ViewerEvent) => void) {}

	async load(url: string, backend: DocumentBackend): Promise<void> {
		this.#cancelDocument();
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
				void pageSource.dispose();
				return;
			}
			this.pageSource = pageSource;
			this.pageCount = pageSource.pageCount;
			this.phase = "ready";
			this.dispatch({ type: "documentload", detail: { pageCount: pageSource.pageCount } });
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
		this.#setFailure({ code: "invalid-option", message, retryable: false });
	}

	requestRender(input: RenderInput): void {
		if (this.pageSource === null) return;
		if (this.pageCount < 1 || input.viewport.width <= 0 || input.viewport.height <= 0) return;
		if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > this.pageCount) {
			this.#setFailure({
				code: "invalid-page",
				message: `ページ番号は1から${this.pageCount}の範囲で指定してください。`,
				retryable: false,
			});
			return;
		}

		const key = [
			input.page,
			input.layout,
			input.fit,
			input.zoom,
			input.viewport.width,
			input.viewport.height,
		].join(":");
		if (this.phase === "error") {
			if (this.failure?.code === "load-failed" || key === this.#failedRenderKey) return;
			this.phase = "ready";
			this.failure = null;
		}
		if (this.phase !== "ready") return;
		if (key === this.#lastRenderKey) return;
		this.#lastRenderKey = key;
		const id = this.#renderId + 1;
		this.#renderId = id;
		this.#pendingRender = { ...input, id };
		if (!this.#rendering) void this.#drainRenderQueue();
	}

	retryRender(input: RenderInput): void {
		this.#failedRenderKey = "";
		this.#lastRenderKey = "";
		this.failure = null;
		this.phase = "ready";
		this.requestRender(input);
	}

	dispose(): void {
		this.#cancelDocument();
		this.pageVisuals = {};
		this.pageCount = 0;
		this.phase = "empty";
	}

	async #drainRenderQueue(): Promise<void> {
		if (this.#rendering) return;
		this.#rendering = true;
		try {
			while (this.#pendingRender !== null) {
				const request = this.#pendingRender;
				this.#pendingRender = null;
				await this.#render(request);
			}
		} finally {
			this.#rendering = false;
			if (this.#pendingRender !== null) void this.#drainRenderQueue();
		}
	}

	async #render(request: ScheduledRender): Promise<void> {
		const source = this.pageSource;
		if (source === null) return;
		const layout = resolveLayout(request.layout, request.viewport.width);
		const pageIndexes = visiblePageIndexes(this.pageCount, request.page, layout);
		try {
			const pageSizes = await Promise.all(pageIndexes.map((index) => source.getPageSize(index)));
			if (!this.#isCurrent(request, source)) return;
			const scale = calculateFitScale(pageSizes, request.viewport, request.fit, request.zoom);
			const visualResults = await Promise.allSettled(
				pageIndexes.map((index) => source.renderPage(index, scale)),
			);
			const visuals = visualResults.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			);
			const renderFailure = visualResults.find((result) => result.status === "rejected");
			if (renderFailure?.status === "rejected") {
				releaseVisuals(visuals);
				throw renderFailure.reason;
			}
			if (!this.#isCurrent(request, source)) {
				releaseVisuals(visuals);
				return;
			}
			const nextPages: Record<number, PageVisual> = {};
			for (const [visualIndex, visual] of visuals.entries()) {
				nextPages[pageIndexes[visualIndex]] = visual;
			}
			this.#releaseCurrentVisuals();
			this.pageVisuals = nextPages;
			this.dispatch({
				type: "pagechange",
				detail: { page: request.page, visiblePages: pageIndexes.map((index) => index + 1) },
			});
		} catch {
			if (!this.#isCurrent(request, source)) return;
			this.#lastRenderKey = "";
			this.#failedRenderKey = [
				request.page,
				request.layout,
				request.fit,
				request.zoom,
				request.viewport.width,
				request.viewport.height,
			].join(":");
			this.#setFailure({
				code: "render-failed",
				message: "ページを表示できませんでした。もう一度お試しください。",
				retryable: true,
			});
		}
	}

	#isCurrent(request: ScheduledRender, source: PageSource): boolean {
		return request.id === this.#renderId && source === this.pageSource;
	}

	#cancelDocument(): void {
		this.#loadId += 1;
		this.#renderId += 1;
		this.#pendingRender = null;
		this.#lastRenderKey = "";
		this.#failedRenderKey = "";
		this.#abortController?.abort();
		this.#abortController = null;
		const source = this.pageSource;
		this.pageSource = null;
		if (source !== null) void source.dispose();
		this.#releaseCurrentVisuals();
		this.pageVisuals = {};
	}

	#releaseCurrentVisuals(): void {
		for (const visual of Object.values(this.pageVisuals)) {
			if (visual.type === "bitmap") visual.bitmap.close();
		}
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
