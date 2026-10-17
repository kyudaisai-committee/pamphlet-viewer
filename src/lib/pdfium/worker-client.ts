import type { PageSize, PageVisual } from "../document/page-source";

export interface PdfiumDocumentInfo {
	pageCount: number;
	fileLength: number;
}

interface OpenRequest {
	type: "open";
	url: string;
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
}

type WorkerResponse = OpenedResponse | PageSizeResponse | RenderedResponse | ErrorResponse;
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
	#nextId = 0;
	#pending = new Map<number, PendingRequest>();
	#terminated = false;

	constructor() {
		this.#worker = new Worker(new URL("./pdfium.worker.ts", import.meta.url), {
			type: "module",
		});
		this.#worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
			this.#onMessage(event.data);
		});
		this.#worker.addEventListener("error", (event: ErrorEvent) => {
			this.#rejectPending(new Error(event.message || "The PDF worker failed."));
		});
		this.#worker.addEventListener("messageerror", () => {
			this.#rejectPending(new Error("The PDF worker returned an unreadable response."));
		});
	}

	async open(url: string): Promise<PdfiumDocumentInfo> {
		const response = await this.#request<OpenRequest>({ type: "open", url });
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
		const pending = this.#pending.get(response.id);
		if (pending === undefined) return;
		this.#pending.delete(response.id);
		pending.resolve(response);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}
