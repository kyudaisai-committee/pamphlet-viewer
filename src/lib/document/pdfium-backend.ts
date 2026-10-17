import { PdfiumWorkerClient } from "../pdfium/worker-client";
import type { DocumentBackend, PageSize, PageSource, PageVisual } from "./page-source";

export class PdfiumBackend implements DocumentBackend {
	async open(source: string, signal: AbortSignal): Promise<PageSource> {
		if (signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
		const client = new PdfiumWorkerClient();
		const abort = function terminateWorker(): void {
			client.terminate();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			const info = await client.open(source);
			if (signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
			return new PdfiumPageSource(info.pageCount, client, signal, abort);
		} catch (error) {
			signal.removeEventListener("abort", abort);
			client.terminate();
			throw error;
		}
	}
}

class PdfiumPageSource implements PageSource {
	#disposed = false;

	constructor(
		readonly pageCount: number,
		private readonly client: PdfiumWorkerClient,
		private readonly signal: AbortSignal,
		private readonly abortListener: () => void,
	) {}

	getPageSize(pageIndex: number): Promise<PageSize> {
		this.#assertActive();
		return this.client.getPageSize(pageIndex);
	}

	renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertActive();
		return this.client.renderPage(pageIndex, scale);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.signal.removeEventListener("abort", this.abortListener);
		this.client.terminate();
	}

	#assertActive(): void {
		if (this.#disposed || this.signal.aborted) {
			throw new DOMException("PDF document is no longer available.", "AbortError");
		}
	}
}
