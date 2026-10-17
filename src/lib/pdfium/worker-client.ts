export interface RenderedPdfPage {
	pageCount: number;
	pageIndex: number;
	width: number;
	height: number;
	pixels: ArrayBuffer;
	fileLength: number;
}

interface RenderRequest {
	id: number;
	type: "render";
	url: string;
	pageIndex: number;
}

interface RenderResponse {
	id: number;
	type: "rendered";
	page: RenderedPdfPage;
}

interface ErrorResponse {
	id: number;
	type: "error";
	message: string;
}

type WorkerResponse = RenderResponse | ErrorResponse;

interface PendingRequest {
	resolve(page: RenderedPdfPage): void;
	reject(error: Error): void;
}

export class PdfiumWorkerClient {
	#worker: Worker;
	#nextId = 0;
	#pending = new Map<number, PendingRequest>();

	constructor() {
		this.#worker = new Worker(new URL("./pdfium.worker.ts", import.meta.url), {
			type: "module",
		});
		this.#worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
			this.#onMessage(event.data);
		});
		this.#worker.addEventListener("error", (event: ErrorEvent) => {
			this.#rejectPending(new Error(event.message));
		});
	}

	renderPage(url: string, pageIndex: number): Promise<RenderedPdfPage> {
		const id = this.#nextId;
		this.#nextId += 1;

		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			const request: RenderRequest = { id, type: "render", url, pageIndex };
			this.#worker.postMessage(request);
		});
	}

	terminate(): void {
		this.#worker.terminate();
		this.#rejectPending(new DOMException("PDF worker was terminated.", "AbortError"));
	}

	#onMessage(response: WorkerResponse): void {
		const pending = this.#pending.get(response.id);
		if (pending === undefined) return;
		this.#pending.delete(response.id);

		if (response.type === "error") {
			pending.reject(new Error(response.message));
			return;
		}
		pending.resolve(response.page);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}
