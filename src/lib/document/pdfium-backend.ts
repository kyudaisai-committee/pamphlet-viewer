// SPDX-License-Identifier: MIT

import { PdfRangeBroker } from "@/lib/pdfium/range/pdf-range-broker";
import { PdfiumWorkerPool } from "@/lib/pdfium/worker/pdfium-worker-pool";
import {
	PdfiumWorkerClient,
	PdfiumWorkerUnavailableError,
} from "@/lib/pdfium/worker/worker-client";

import {
	PageSourceUnavailableError,
	type DocumentBackend,
	type PageSize,
	type PageSource,
	type PageVisual,
} from "./page-source";

export class PdfiumBackend implements DocumentBackend {
	async open(source: string, signal: AbortSignal): Promise<PageSource> {
		if (signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
		const rangeBroker = new PdfRangeBroker(source);
		const client = new PdfiumWorkerClient(rangeBroker);
		let pageSource: PdfiumPageSource | null = null;
		const abort = function abortDocumentOpen(): void {
			if (pageSource === null) {
				client.terminate();
				rangeBroker.dispose();
			} else pageSource.dispose();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			const info = await client.open(source);
			if (signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
			pageSource = new PdfiumPageSource(
				info.pageCount,
				source,
				client,
				rangeBroker,
				signal,
				abort,
			);
			return pageSource;
		} catch (error) {
			signal.removeEventListener("abort", abort);
			client.terminate();
			rangeBroker.dispose();
			throw error;
		}
	}
}

class PdfiumPageSource implements PageSource {
	#disposed = false;
	#workerPool: PdfiumWorkerPool;
	readonly propagateThumbnailErrors = true;

	constructor(
		readonly pageCount: number,
		source: string,
		client: PdfiumWorkerClient,
		private readonly rangeBroker: PdfRangeBroker,
		private readonly signal: AbortSignal,
		private readonly abortListener: () => void,
	) {
		this.#workerPool = new PdfiumWorkerPool(source, pageCount, rangeBroker, client);
	}

	getPageSize(pageIndex: number, signal?: AbortSignal): Promise<PageSize> {
		this.#assertActive();
		return this.#workerPool.getPageSize(pageIndex, "visible", signal).catch(mapSourceFailure);
	}

	getPrefetchedPageSize(pageIndex: number, signal?: AbortSignal): Promise<PageSize> {
		this.#assertActive();
		return this.#workerPool.getPageSize(pageIndex, "prerender", signal).catch(mapSourceFailure);
	}

	getThumbnailPageSize(pageIndex: number): Promise<PageSize> {
		this.#assertActive();
		return this.#workerPool.getPageSize(pageIndex, "thumbnail").catch(mapSourceFailure);
	}

	cancelForegroundRequests(): void {
		this.#workerPool.cancelRequests("visible");
	}

	promotePageRender(pageIndex: number, scale: number): boolean {
		return this.#workerPool.promoteRender(pageIndex, scale);
	}

	prefetchPage(pageIndex: number): Promise<void> {
		this.#assertActive();
		return this.#workerPool.prefetchPage(pageIndex).catch(mapSourceFailure);
	}

	cancelPrefetchPageRequests(): void {
		this.#workerPool.cancelRequests("data");
	}

	renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertActive();
		return this.#workerPool.renderPage(pageIndex, scale).catch(mapSourceFailure);
	}

	renderPrefetchedPage(
		pageIndex: number,
		scale: number,
		signal?: AbortSignal,
	): Promise<PageVisual> {
		this.#assertActive();
		return this.#workerPool
			.renderPage(pageIndex, scale, "prerender", signal)
			.catch(mapSourceFailure);
	}

	renderThumbnail(pageIndex: number): Promise<PageVisual | null> {
		this.#assertActive();
		return this.#workerPool.renderThumbnail(pageIndex).catch(mapSourceFailure);
	}

	prefetchThumbnail(pageIndex: number): Promise<PageVisual | null> {
		this.#assertActive();
		return this.#workerPool.prefetchThumbnail(pageIndex).catch(mapSourceFailure);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.signal.removeEventListener("abort", this.abortListener);
		this.#workerPool.dispose();
		this.rangeBroker.dispose();
	}

	#assertActive(): void {
		if (this.#disposed || this.signal.aborted) {
			throw new DOMException("PDF document is no longer available.", "AbortError");
		}
	}
}

function mapSourceFailure(error: unknown): never {
	if (error instanceof PageSourceUnavailableError) throw error;
	if (error instanceof PdfiumWorkerUnavailableError) {
		throw new PageSourceUnavailableError(error.message, { cause: error });
	}
	throw error;
}
