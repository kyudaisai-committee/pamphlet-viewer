// SPDX-License-Identifier: MIT

import type { PageSize, PageVisual } from "../document/page-source";
import { PdfiumDocumentSession, PdfiumFatalError } from "./pdfium-document";

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

interface PagePrefetchRequest {
	id: number;
	type: "page-prefetch";
	pageIndex: number;
}

interface RenderRequest {
	id: number;
	type: "render";
	pageIndex: number;
	scale: number;
}

interface ThumbnailRequest {
	id: number;
	type: "thumbnail";
	pageIndex: number;
}

type WorkerRequest =
	| OpenRequest
	| PageSizeRequest
	| PagePrefetchRequest
	| RenderRequest
	| ThumbnailRequest;

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

interface PagePrefetchResponse {
	id: number;
	type: "page-prefetch";
}

interface RenderedResponse {
	id: number;
	type: "rendered";
	visual: PageVisual;
}

interface ThumbnailResponse {
	id: number;
	type: "thumbnail";
	visual: PageVisual | null;
}

interface ErrorResponse {
	id: number;
	type: "error";
	message: string;
	fatal?: boolean;
}

type WorkerResponse =
	| OpenedResponse
	| PageSizeResponse
	| PagePrefetchResponse
	| RenderedResponse
	| ThumbnailResponse
	| ErrorResponse;

interface WorkerScope {
	addEventListener(type: "message", listener: (event: MessageEvent<WorkerRequest>) => void): void;
	postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
	close(): void;
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
			const previousSession = documentSession;
			previousSession?.dispose();
			documentSession = null;
			if (previousSession?.isPoisoned) {
				throw new PdfiumFatalError(
					new Error("The previous PDFium document could not be released."),
				);
			}
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
		if (request.type === "page-prefetch") {
			await session.prefetchPage(request.pageIndex);
			const response: PagePrefetchResponse = { id: request.id, type: "page-prefetch" };
			workerScope.postMessage(response);
			return;
		}
		if (request.type === "thumbnail") {
			const visual = await session.renderThumbnail(request.pageIndex);
			const response: ThumbnailResponse = { id: request.id, type: "thumbnail", visual };
			const transfer = visual?.type === "pixels" ? [visual.pixels] : [];
			workerScope.postMessage(response, transfer);
			return;
		}

		const visual = await session.renderPage(request.pageIndex, request.scale);
		const response: RenderedResponse = { id: request.id, type: "rendered", visual };
		const transfer = visual.type === "pixels" ? [visual.pixels] : [];
		workerScope.postMessage(response, transfer);
	} catch (error) {
		const fatal = error instanceof PdfiumFatalError || documentSession?.isPoisoned === true;
		if (fatal) {
			documentSession?.dispose();
			documentSession = null;
		}
		const response: ErrorResponse = {
			id: request.id,
			type: "error",
			message: error instanceof Error ? error.message : "PDF processing failed.",
			fatal,
		};
		workerScope.postMessage(response);
		if (fatal) workerScope.close();
	}
}
