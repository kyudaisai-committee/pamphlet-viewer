// SPDX-License-Identifier: MIT

import { PdfiumWorkerClient, PdfiumWorkerUnavailableError } from "../pdfium/worker-client";
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
		const client = new PdfiumWorkerClient();
		let thumbnailClient: PdfiumWorkerClient | null = null;
		let pageSource: PdfiumPageSource | null = null;
		const abort = function terminateWorker(): void {
			pageSource?.dispose();
			client.terminate();
			thumbnailClient?.terminate();
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
	readonly supportsConcurrentPageRenders = true;
	#foregroundClients: [PdfiumWorkerClient | null, PdfiumWorkerClient | null];
	#foregroundOpen: [Promise<PdfiumWorkerClient> | null, Promise<PdfiumWorkerClient> | null];
	#foregroundLoads: [number, number] = [0, 0];
	#prefetchClients: [PdfiumWorkerClient | null, PdfiumWorkerClient | null] = [null, null];
	#prefetchOpen: [Promise<PdfiumWorkerClient> | null, Promise<PdfiumWorkerClient> | null] = [
		null,
		null,
	];
	#prefetchLoads: [number, number] = [0, 0];
	readonly propagateThumbnailErrors = true;

	constructor(
		readonly pageCount: number,
		private readonly client: PdfiumWorkerClient,
		private readonly source: string,
		private readonly signal: AbortSignal,
		private readonly abortListener: () => void,
		private readonly getThumbnailClient: () => PdfiumWorkerClient,
		private readonly terminateThumbnailClient: () => void,
	) {
		this.#foregroundClients = [client, null];
		this.#foregroundOpen = [Promise.resolve(client), null];
	}

	getPageSize(pageIndex: number): Promise<PageSize> {
		this.#assertActive();
		return this.client.getPageSize(pageIndex).catch(mapSourceFailure);
	}

	prefetchPage(pageIndex: number): Promise<void> {
		this.#assertActive();
		return this.client.prefetchPage(pageIndex).catch(mapSourceFailure);
	}

	renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertActive();
		return this.#renderFromPool(
			this.#foregroundClients,
			this.#foregroundOpen,
			this.#foregroundLoads,
			pageIndex,
			scale,
		).catch(mapSourceFailure);
	}

	renderPrefetchedPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertActive();
		return this.#renderFromPool(
			this.#prefetchClients,
			this.#prefetchOpen,
			this.#prefetchLoads,
			pageIndex,
			scale,
		).catch(mapSourceFailure);
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
		this.client.terminate();
		this.#terminatePool(this.#foregroundClients);
		this.#terminatePool(this.#prefetchClients);
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

	async #renderFromPool(
		clients: [PdfiumWorkerClient | null, PdfiumWorkerClient | null],
		openings: [Promise<PdfiumWorkerClient> | null, Promise<PdfiumWorkerClient> | null],
		loads: [number, number],
		pageIndex: number,
		scale: number,
	): Promise<PageVisual> {
		const slot = loads[0] <= loads[1] ? 0 : 1;
		loads[slot] += 1;
		try {
			const client = await this.#openPoolClient(clients, openings, slot);
			return await client.renderPage(pageIndex, scale);
		} finally {
			loads[slot] -= 1;
		}
	}

	async #openPoolClient(
		clients: [PdfiumWorkerClient | null, PdfiumWorkerClient | null],
		openings: [Promise<PdfiumWorkerClient> | null, Promise<PdfiumWorkerClient> | null],
		slot: 0 | 1,
	): Promise<PdfiumWorkerClient> {
		if (openings[slot] === null) {
			const client = new PdfiumWorkerClient();
			clients[slot] = client;
			const opening = client.open(this.source).then((info) => {
				if (info.pageCount !== this.pageCount) {
					throw new PdfiumWorkerUnavailableError(
						"The PDF source changed while its pages were rendering.",
					);
				}
				return client;
			});
			openings[slot] = opening.catch((error: unknown) => {
				client.terminate();
				if (clients[slot] === client) clients[slot] = null;
				openings[slot] = null;
				throw error;
			});
		}
		return openings[slot] as Promise<PdfiumWorkerClient>;
	}

	#terminatePool(clients: [PdfiumWorkerClient | null, PdfiumWorkerClient | null]): void {
		for (const client of clients) client?.terminate();
	}
}

function mapSourceFailure(error: unknown): never {
	if (error instanceof PdfiumWorkerUnavailableError) {
		throw new PageSourceUnavailableError(error.message, { cause: error });
	}
	throw error;
}
