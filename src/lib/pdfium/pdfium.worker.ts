import type { PageSize, PageVisual } from "../document/page-source";
import { PdfiumDocumentSession } from "./pdfium-document";

interface OpenRequest {
	id: number;
	type: "open";
	url: string;
	wasmUrl: string;
}

interface PageSizeRequest {
	id: number;
	type: "page-size";
	pageIndex: number;
}

interface RenderRequest {
	id: number;
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

interface WorkerScope {
	addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
	postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;
let documentSession: PdfiumDocumentSession | null = null;
let requestQueue = Promise.resolve();

workerScope.addEventListener("message", function queueRequest(event) {
	requestQueue = requestQueue.then(
		() => processRequest(event.data),
		() => processRequest(event.data),
	);
});

async function processRequest(request: WorkerRequest): Promise<void> {
	try {
		if (request.type === "open") {
			documentSession?.dispose();
			documentSession = null;
			const session = await PdfiumDocumentSession.open(
				request.url,
				request.wasmUrl,
				new AbortController().signal,
			);
			documentSession = session;
			const info = session.info;
			const response: OpenedResponse = {
				id: request.id,
				type: "opened",
				pageCount: info.pageCount,
				fileLength: info.fileLength,
			};
			workerScope.postMessage(response);
			return;
		}

		const session = documentSession;
		if (session === null) throw new Error("The PDF worker has no open document.");
		if (request.type === "page-size") {
			const pageSize = await session.getPageSize(request.pageIndex);
			const response: PageSizeResponse = { id: request.id, type: "page-size", pageSize };
			workerScope.postMessage(response);
			return;
		}

		const visual = await session.renderPage(request.pageIndex, request.scale);
		const response: RenderedResponse = { id: request.id, type: "rendered", visual };
		const transfer = visual.type === "pixels" ? [visual.pixels] : [];
		workerScope.postMessage(response, transfer);
	} catch (error) {
		const response: ErrorResponse = {
			id: request.id,
			type: "error",
			message: error instanceof Error ? error.message : "PDF processing failed.",
		};
		workerScope.postMessage(response);
	}
}
