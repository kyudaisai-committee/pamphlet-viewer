// SPDX-License-Identifier: MIT

import { PdfiumWorkerClient, PdfiumWorkerUnavailableError } from "../pdfium/worker-client";
import {
	PageSourceUnavailableError,
	type DocumentBackend,
	type PageSize,
	type PageSource,
	type PageVisual,
} from "./page-source";
import { PdfiumWorkerPool } from "./pdfium-worker-pool";

export class PdfiumBackend implements DocumentBackend {
	async open(source: string, signal: AbortSignal): Promise<PageSource> {
		if (signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
		const client = new PdfiumWorkerClient();
		let thumbnailClient: PdfiumWorkerClient | null = null;
		let pageSource: PdfiumPageSource | null = null;
		const abort = function terminateWorker(): void {
			if (pageSource === null) client.terminate();
			else pageSource.dispose();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			const info = await client.open(source);
			if (signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
			pageSource = new PdfiumPageSource(
				info.pageCount,
				client,
				source,
				signal,
				abort,
				() => {
					thumbnailClient ??= new PdfiumWorkerClient();
					return thumbnailClient;
				},
				() => {
					thumbnailClient?.terminate();
					thumbnailClient = null;
				},
			);
			return pageSource;
		} catch (error) {
			signal.removeEventListener("abort", abort);
			client.terminate();
			throw error;
		}
	}
}

class PdfiumPageSource implements PageSource {
	#disposed = false;
	#foregroundPool: PdfiumWorkerPool;
	#pagePrefetchPool: PdfiumWorkerPool;
	#prerenderPool: PdfiumWorkerPool;
	readonly propagateThumbnailErrors = true;

	constructor(
		readonly pageCount: number,
		client: PdfiumWorkerClient,
		private readonly source: string,
		private readonly signal: AbortSignal,
		private readonly abortListener: () => void,
		private readonly getThumbnailClient: () => PdfiumWorkerClient,
		private readonly terminateThumbnailClient: () => void,
	) {
		this.#foregroundPool = new PdfiumWorkerPool(source, pageCount, client);
		this.#pagePrefetchPool = new PdfiumWorkerPool(source, pageCount, null, 1);
		this.#prerenderPool = new PdfiumWorkerPool(source, pageCount, null, 1);
	}

	getPageSize(pageIndex: number): Promise<PageSize> {
		this.#assertActive();
		return this.#foregroundPool.getPageSize(pageIndex).catch(mapSourceFailure);
	}

	getPrefetchedPageSize(pageIndex: number): Promise<PageSize> {
		this.#assertActive();
		return this.#prerenderPool.getPageSize(pageIndex).catch(mapSourceFailure);
	}

	getThumbnailPageSize(pageIndex: number): Promise<PageSize> {
		this.#assertActive();
		return this.#openThumbnailWorker()
			.then((client) => client.getPageSize(pageIndex))
			.catch(mapSourceFailure);
	}

	cancelForegroundRequests(): void {
		this.#foregroundPool.interrupt();
	}

	prefetchPage(pageIndex: number): Promise<void> {
		this.#assertActive();
		return this.#pagePrefetchPool.prefetchPage(pageIndex).catch(mapSourceFailure);
	}

	cancelPrefetchPageRequests(): void {
		this.#pagePrefetchPool.interrupt();
	}

	renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertActive();
		return this.#foregroundPool.renderPage(pageIndex, scale).catch(mapSourceFailure);
	}

	renderPrefetchedPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertActive();
		return this.#prerenderPool.renderPage(pageIndex, scale).catch(mapSourceFailure);
	}

	renderThumbnail(pageIndex: number): Promise<PageVisual | null> {
		this.#assertActive();
		return this.#renderThumbnail(pageIndex).catch(mapSourceFailure);
	}

	prefetchThumbnail(pageIndex: number): Promise<PageVisual | null> {
		this.#assertActive();
		return this.#prefetchThumbnail(pageIndex).catch(mapSourceFailure);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.signal.removeEventListener("abort", this.abortListener);
		this.#foregroundPool.dispose();
		this.#pagePrefetchPool.dispose();
		this.#prerenderPool.dispose();
		this.terminateThumbnailClient();
	}

	#assertActive(): void {
		if (this.#disposed || this.signal.aborted) {
			throw new DOMException("PDF document is no longer available.", "AbortError");
		}
	}

	async #renderThumbnail(pageIndex: number): Promise<PageVisual> {
		const client = await this.#openThumbnailWorker();
		const visual = await client.renderThumbnail(pageIndex);
		if (visual === null) throw new Error("PDFium could not render the requested thumbnail.");
		return visual;
	}

	async #prefetchThumbnail(pageIndex: number): Promise<PageVisual | null> {
		const client = await this.#openThumbnailWorker();
		return client.prefetchThumbnail(pageIndex);
	}

	#thumbnailOpen: Promise<PdfiumWorkerClient> | null = null;

	async #openThumbnailWorker(): Promise<PdfiumWorkerClient> {
		this.#assertActive();
		if (this.#thumbnailOpen === null) {
			const client = this.getThumbnailClient();
			this.#thumbnailOpen = client
				.open(this.source)
				.then((info) => {
					if (info.pageCount !== this.pageCount) {
						throw new PdfiumWorkerUnavailableError(
							"The PDF source changed while its thumbnails were loading.",
						);
					}
					return client;
				})
				.catch((error: unknown) => {
					this.terminateThumbnailClient();
					this.#thumbnailOpen = null;
					throw error;
				});
		}
		return this.#thumbnailOpen;
	}
}

function mapSourceFailure(error: unknown): never {
	if (error instanceof PdfiumWorkerUnavailableError) {
		throw new PageSourceUnavailableError(error.message, { cause: error });
	}
	throw error;
}
