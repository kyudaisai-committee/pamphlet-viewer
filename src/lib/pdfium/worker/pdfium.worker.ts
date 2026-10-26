// SPDX-License-Identifier: MIT

import type { PageSize, PageVisual } from "@/lib/document/page-source";
import type { PageTaskPriority } from "@/lib/domain/scheduling/page-task-scheduler";
import { PdfiumDocumentSession, PdfiumFatalError } from "@/lib/pdfium/document/pdfium-document";
import { PdfRepresentationChangedError } from "@/lib/pdfium/range/range-request";
import type { PdfRangeResponse } from "@/lib/pdfium/range/range-request";
import { requestPdfRange } from "@/lib/pdfium/range/range-request";
import type {
	RangeTransportRequest,
	RangeWorkerCancelRequest,
	RangeWorkerRequest,
	RangeWorkerResponse,
} from "@/lib/pdfium/range/range-transport";

interface OpenRequest {
	id: number;
	type: "open";
	url: string;
	wasmUrl: string;
	useRangeBroker: boolean;
}

interface PageSizeRequest {
	id: number;
	type: "page-size";
	pageIndex: number;
	priority: PageTaskPriority;
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
	priority: PageTaskPriority;
}

interface ThumbnailRequest {
	id: number;
	type: "thumbnail";
	pageIndex: number;
}

interface ThumbnailPrefetchRequest {
	id: number;
	type: "thumbnail-prefetch";
	pageIndex: number;
}

interface CancelRequest {
	type: "cancel";
	id: number;
}

type WorkerRequest =
	| OpenRequest
	| PageSizeRequest
	| PagePrefetchRequest
	| RenderRequest
	| ThumbnailRequest
	| ThumbnailPrefetchRequest;

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

interface ThumbnailPrefetchResponse {
	id: number;
	type: "thumbnail-prefetch";
	visual: PageVisual | null;
}

interface ErrorResponse {
	id: number;
	type: "error";
	message: string;
	errorName?: string;
	fatal?: boolean;
}

type WorkerResponse =
	| OpenedResponse
	| PageSizeResponse
	| PagePrefetchResponse
	| RenderedResponse
	| ThumbnailResponse
	| ThumbnailPrefetchResponse
	| ErrorResponse;

interface WorkerScope {
	addEventListener(
		type: "message",
		listener: (
			event: MessageEvent<WorkerRequest | CancelRequest | RangeWorkerResponse>,
		) => void,
	): void;
	postMessage(
		message: WorkerResponse | RangeWorkerRequest | RangeWorkerCancelRequest,
		transfer?: Transferable[],
	): void;
	close(): void;
}

const workerScope = self as unknown as WorkerScope;
let documentSession: PdfiumDocumentSession | null = null;
let requestQueue = Promise.resolve();
let useRangeBroker = false;
let nextRangeRequestId = 0;
let lastProcessedRequestId = -1;
const operationControllers = new Map<number, AbortController>();
const cancelledRequestIds = new Set<number>();
const pendingRangeRequests = new Map<
	number,
	{
		resolve(response: PdfRangeResponse): void;
		reject(error: unknown): void;
		signal: AbortSignal;
		abort(): void;
	}
>();

workerScope.addEventListener("message", function queueRequest(event) {
	if (event.data.type === "range-response") {
		resolveRangeRequest(event.data);
		return;
	}
	if (event.data.type === "cancel") {
		cancelRequest(event.data.id);
		return;
	}
	const request = event.data;
	requestQueue = requestQueue.then(
		() => processRequest(request),
		() => processRequest(request),
	);
});

async function processRequest(request: WorkerRequest): Promise<void> {
	if (cancelledRequestIds.delete(request.id)) {
		lastProcessedRequestId = Math.max(lastProcessedRequestId, request.id);
		workerScope.postMessage({
			id: request.id,
			type: "error",
			message: "PDF page operation was cancelled.",
			errorName: "AbortError",
		});
		return;
	}
	const controller = new AbortController();
	operationControllers.set(request.id, controller);
	try {
		if (request.type === "open") {
			useRangeBroker = request.useRangeBroker;
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
				controller.signal,
				undefined,
				request.useRangeBroker ? requestPdfRangeFromHost : undefined,
			);
			useRangeBroker = request.useRangeBroker;
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
			const pageSize = await session.getPageSize(
				request.pageIndex,
				request.priority,
				controller.signal,
			);
			const response: PageSizeResponse = { id: request.id, type: "page-size", pageSize };
			workerScope.postMessage(response);
			return;
		}
		if (request.type === "page-prefetch") {
			await session.prefetchPage(request.pageIndex, controller.signal);
			const response: PagePrefetchResponse = { id: request.id, type: "page-prefetch" };
			workerScope.postMessage(response);
			return;
		}
		if (request.type === "thumbnail") {
			const visual = await session.renderThumbnail(request.pageIndex, controller.signal);
			const response: ThumbnailResponse = { id: request.id, type: "thumbnail", visual };
			const transfer = visual?.type === "pixels" ? [visual.pixels] : [];
			workerScope.postMessage(response, transfer);
			return;
		}
		if (request.type === "thumbnail-prefetch") {
			const visual = await session.prefetchThumbnail(request.pageIndex, controller.signal);
			const response: ThumbnailPrefetchResponse = {
				id: request.id,
				type: "thumbnail-prefetch",
				visual,
			};
			const transfer = visual?.type === "pixels" ? [visual.pixels] : [];
			workerScope.postMessage(response, transfer);
			return;
		}

		const visual = await session.renderPage(
			request.pageIndex,
			request.scale,
			request.priority,
			controller.signal,
		);
		const response: RenderedResponse = { id: request.id, type: "rendered", visual };
		const transfer = visual.type === "pixels" ? [visual.pixels] : [];
		workerScope.postMessage(response, transfer);
	} catch (error) {
		const fatal =
			error instanceof PdfiumFatalError ||
			error instanceof PdfRepresentationChangedError ||
			documentSession?.isPoisoned === true;
		if (fatal) {
			documentSession?.dispose();
			documentSession = null;
		}
		const response: ErrorResponse = {
			id: request.id,
			type: "error",
			message: error instanceof Error ? error.message : "PDF processing failed.",
			errorName: error instanceof Error ? error.name : undefined,
			fatal,
		};
		workerScope.postMessage(response);
		if (fatal) workerScope.close();
	} finally {
		operationControllers.delete(request.id);
		cancelledRequestIds.delete(request.id);
		lastProcessedRequestId = Math.max(lastProcessedRequestId, request.id);
	}
}

function cancelRequest(id: number): void {
	if (id <= lastProcessedRequestId) return;
	const controller = operationControllers.get(id);
	if (controller !== undefined) {
		controller.abort();
		return;
	}
	cancelledRequestIds.add(id);
}

function requestPdfRangeFromHost(
	request: RangeTransportRequest,
	signal: AbortSignal,
): Promise<PdfRangeResponse> {
	if (!useRangeBroker) return requestPdfRange({ ...request, signal });
	const id = nextRangeRequestId;
	nextRangeRequestId += 1;
	return new Promise((resolve, reject) => {
		const abort = function cancelHostRangeRequest(): void {
			pendingRangeRequests.delete(id);
			workerScope.postMessage({ type: "range-cancel", id });
			reject(new DOMException("The PDF range request was cancelled.", "AbortError"));
		};
		pendingRangeRequests.set(id, { resolve, reject, signal, abort });
		signal.addEventListener("abort", abort, { once: true });
		workerScope.postMessage({ type: "range-request", id, request });
	});
}

function resolveRangeRequest(response: RangeWorkerResponse): void {
	const pending = pendingRangeRequests.get(response.id);
	if (pending === undefined) return;
	pendingRangeRequests.delete(response.id);
	pending.signal.removeEventListener("abort", pending.abort);
	if (response.response === undefined) {
		pending.reject(
			response.fatal === true
				? new PdfRepresentationChangedError(
						response.error ?? "The PDF representation changed.",
					)
				: new Error(response.error ?? "The PDF range request failed."),
		);
		return;
	}
	pending.resolve({
		bytes: new Uint8Array(response.response.bytes),
		totalLength: response.response.totalLength,
		etag: response.response.etag,
		lastModified: response.response.lastModified,
		responseUrl: response.response.responseUrl,
	});
}
