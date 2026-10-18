import pdfiumWasmAssetUrl from "@embedpdf/pdfium/pdfium.wasm?url";

import type { PageSize, PageVisual } from "../document/page-source";
import pdfiumWorkerAssetUrl from "./pdfium.worker.ts?worker&url";

export interface PdfiumDocumentInfo {
	pageCount: number;
	fileLength: number;
}

interface OpenRequest {
	type: "open";
	url: string;
	wasmUrl: string;
}

interface PageSizeRequest {
	type: "page-size";
	pageIndex: number;
}

interface RenderRequest {
	type: "render";
	pageIndex: number;
	scale: number;
}

type WorkerRequest = OpenRequest | PageSizeRequest | RenderRequest;

interface OpenedResponse {
	id: number;
	type: "opened";
	pageCount: number;
	fileLength: number;
}

interface PageSizeResponse {
	id: number;
	type: "page-size";
	pageSize: PageSize;
}

interface RenderedResponse {
	id: number;
	type: "rendered";
	visual: PageVisual;
}

interface ErrorResponse {
	id: number;
	type: "error";
	message: string;
	fatal?: boolean;
}

type WorkerResponse = OpenedResponse | PageSizeResponse | RenderedResponse | ErrorResponse;
type WorkerMessage = WorkerResponse | { type: "bootstrap-ready" };
type ResponseFor<Request extends WorkerRequest> = Request extends OpenRequest
	? OpenedResponse
	: Request extends PageSizeRequest
		? PageSizeResponse
		: RenderedResponse;

interface PendingRequest {
	resolve(response: WorkerResponse): void;
	reject(error: Error): void;
}

export class PdfiumWorkerClient {
	#worker: Worker;
	#releaseBootstrapUrl: (() => void) | null;
	#nextId = 0;
	#pending = new Map<number, PendingRequest>();
	#terminated = false;

	constructor() {
		const workerUrl = new URL(pdfiumWorkerAssetUrl, import.meta.url);
		const workerHandle =
			workerUrl.origin === globalThis.location.origin
				? {
						worker: new Worker(workerUrl, { type: "module" }),
						releaseBootstrapUrl: null,
					}
				: createCrossOriginPdfiumWorker(workerUrl);
		this.#worker = workerHandle.worker;
		this.#releaseBootstrapUrl = workerHandle.releaseBootstrapUrl;
		this.#worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
			if (event.data.type === "bootstrap-ready") {
				this.#releaseWorkerBootstrap();
				return;
			}
			this.#onMessage(event.data);
		});
		this.#worker.addEventListener("error", (event: ErrorEvent) => {
			this.#releaseWorkerBootstrap();
			this.#rejectPending(new Error(event.message || "The PDF worker failed."));
		});
		this.#worker.addEventListener("messageerror", () => {
			this.#releaseWorkerBootstrap();
			this.#rejectPending(new Error("The PDF worker returned an unreadable response."));
		});
	}

	async open(url: string): Promise<PdfiumDocumentInfo> {
		const wasmUrl = new URL(pdfiumWasmAssetUrl, import.meta.url).href;
		const response = await this.#request<OpenRequest>({ type: "open", url, wasmUrl });
		return { pageCount: response.pageCount, fileLength: response.fileLength };
	}

	async getPageSize(pageIndex: number): Promise<PageSize> {
		const response = await this.#request<PageSizeRequest>({ type: "page-size", pageIndex });
		return response.pageSize;
	}

	async renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		const response = await this.#request<RenderRequest>({ type: "render", pageIndex, scale });
		return response.visual;
	}

	terminate(): void {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#worker.terminate();
		this.#releaseWorkerBootstrap();
		this.#rejectPending(new DOMException("PDF worker was terminated.", "AbortError"));
	}

	#request<Request extends WorkerRequest>(request: Request): Promise<ResponseFor<Request>> {
		if (this.#terminated)
			return Promise.reject(new DOMException("PDF worker was terminated.", "AbortError"));
		const id = this.#nextId;
		this.#nextId += 1;
		return new Promise<ResponseFor<Request>>((resolve, reject) => {
			this.#pending.set(id, {
				resolve: (response) => {
					if (response.type === "error") {
						reject(new Error(response.message));
						return;
					}
					resolve(response as ResponseFor<Request>);
				},
				reject,
			});
			this.#worker.postMessage({ id, ...request });
		});
	}

	#onMessage(response: WorkerResponse): void {
		if (response.type === "error" && response.fatal === true) {
			this.#terminated = true;
			this.#worker.terminate();
			this.#releaseWorkerBootstrap();
			this.#rejectPending(new Error(response.message));
			return;
		}

		const pending = this.#pending.get(response.id);
		if (pending === undefined) return;
		this.#pending.delete(response.id);
		pending.resolve(response);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	#releaseWorkerBootstrap(): void {
		this.#releaseBootstrapUrl?.();
		this.#releaseBootstrapUrl = null;
	}
}

interface PdfiumWorkerHandle {
	worker: Worker;
	releaseBootstrapUrl: (() => void) | null;
}

function createCrossOriginPdfiumWorker(workerUrl: URL): PdfiumWorkerHandle {
	const bootstrapSource = [
		`import ${JSON.stringify(workerUrl.href)};`,
		`self.postMessage({ type: "bootstrap-ready" });`,
	].join("\n");
	const bootstrapUrl = URL.createObjectURL(
		new Blob([bootstrapSource], { type: "text/javascript" }),
	);
	try {
		const worker = new Worker(bootstrapUrl, { type: "module" });
		let released = false;
		return {
			worker,
			releaseBootstrapUrl() {
				if (released) return;
				released = true;
				URL.revokeObjectURL(bootstrapUrl);
			},
		};
	} catch (error) {
		URL.revokeObjectURL(bootstrapUrl);
		throw error;
	}
}
