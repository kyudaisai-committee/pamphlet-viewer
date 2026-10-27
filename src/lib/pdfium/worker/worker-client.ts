// SPDX-License-Identifier: MIT

import pdfiumWasmAssetUrl from "@embedpdf/pdfium/pdfium.wasm?url";

import type { PageSize, PageVisual } from "@/lib/document/page-source";
import type { PageTaskPriority } from "@/lib/domain/scheduling/page-task-scheduler";
import { PdfRangeBroker } from "@/lib/pdfium/range/pdf-range-broker";
import { PdfRepresentationChangedError } from "@/lib/pdfium/range/range-request";
import type {
	RangeWorkerCancelRequest,
	RangeWorkerPromoteRequest,
	RangeWorkerRequest,
	RangeWorkerResponse,
} from "@/lib/pdfium/range/range-transport";

import pdfiumWorkerAssetUrl from "./pdfium.worker.ts?worker&url";

export interface PdfiumDocumentInfo {
	pageCount: number;
	fileLength: number;
}

export class PdfiumWorkerUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PdfiumWorkerUnavailableError";
	}
}

interface OpenRequest {
	type: "open";
	url: string;
	wasmUrl: string;
	useRangeBroker: boolean;
}

interface PageSizeRequest {
	type: "page-size";
	pageIndex: number;
	priority: PageTaskPriority;
}

interface PagePrefetchRequest {
	type: "page-prefetch";
	pageIndex: number;
}

interface RenderRequest {
	type: "render";
	pageIndex: number;
	scale: number;
	priority: PageTaskPriority;
}

interface ThumbnailRequest {
	type: "thumbnail";
	pageIndex: number;
}

interface ThumbnailPrefetchRequest {
	type: "thumbnail-prefetch";
	pageIndex: number;
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
type WorkerMessage =
	| WorkerResponse
	| RangeWorkerRequest
	| RangeWorkerCancelRequest
	| RangeWorkerPromoteRequest
	| { type: "bootstrap-ready" };
type ResponseFor<Request extends WorkerRequest> = Request extends OpenRequest
	? OpenedResponse
	: Request extends PageSizeRequest
		? PageSizeResponse
		: Request extends PagePrefetchRequest
			? PagePrefetchResponse
			: Request extends ThumbnailRequest
				? ThumbnailResponse
				: Request extends ThumbnailPrefetchRequest
					? ThumbnailPrefetchResponse
					: RenderedResponse;

interface PendingRequest {
	request: WorkerRequest;
	resolve(response: WorkerResponse): void;
	reject(error: Error): void;
	priority: PageTaskPriority | null;
	signal: AbortSignal | undefined;
	abortListener: (() => void) | null;
	cancellationRequested: boolean;
}

interface PendingRangeRequest {
	controller: AbortController;
	request: RangeWorkerRequest["request"];
}

export class PdfiumWorkerClient {
	#worker: Worker;
	#releaseBootstrapUrl: (() => void) | null;
	#nextId = 0;
	#pending = new Map<number, PendingRequest>();
	#state: "active" | "terminated" | "unavailable" = "active";
	#terminalError: Error | null = null;
	#pendingRanges = new Map<number, PendingRangeRequest>();
	#opened = false;

	constructor(private readonly rangeBroker?: PdfRangeBroker) {
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
			this.#markUnavailable(
				new PdfiumWorkerUnavailableError(event.message || "The PDF worker failed."),
			);
		});
		this.#worker.addEventListener("messageerror", () => {
			this.#markUnavailable(
				new PdfiumWorkerUnavailableError("The PDF worker returned an unreadable response."),
			);
		});
	}

	get isOpen(): boolean {
		return this.#state === "active" && this.#opened;
	}

	get pendingRangeRequestCount(): number {
		return this.#pendingRanges.size;
	}

	async open(
		url: string,
		useRangeBroker = this.rangeBroker !== undefined,
		signal?: AbortSignal,
	): Promise<PdfiumDocumentInfo> {
		const wasmUrl = new URL(pdfiumWasmAssetUrl, import.meta.url).href;
		const response = await this.#request<OpenRequest>(
			{
				type: "open",
				url,
				wasmUrl,
				useRangeBroker,
			},
			signal,
		);
		this.#opened = true;
		return { pageCount: response.pageCount, fileLength: response.fileLength };
	}

	async getPageSize(
		pageIndex: number,
		priority: PageTaskPriority = "visible",
		signal?: AbortSignal,
	): Promise<PageSize> {
		const response = await this.#request<PageSizeRequest>(
			{
				type: "page-size",
				pageIndex,
				priority,
			},
			signal,
		);
		return response.pageSize;
	}

	promotePageSize(pageIndex: number, priority: PageTaskPriority): boolean {
		return this.#promotePageRequests(
			(pageRequest) =>
				pageRequest.type === "page-size" && pageRequest.pageIndex === pageIndex,
			priority,
		);
	}

	async prefetchPage(pageIndex: number, signal?: AbortSignal): Promise<void> {
		await this.#request<PagePrefetchRequest>({ type: "page-prefetch", pageIndex }, signal);
	}

	async renderPage(
		pageIndex: number,
		scale: number,
		priority: PageTaskPriority = "visible",
		signal?: AbortSignal,
	): Promise<PageVisual> {
		const response = await this.#request<RenderRequest>(
			{
				type: "render",
				pageIndex,
				scale,
				priority,
			},
			signal,
		);
		return response.visual;
	}

	async renderThumbnail(pageIndex: number, signal?: AbortSignal): Promise<PageVisual | null> {
		const response = await this.#request<ThumbnailRequest>(
			{ type: "thumbnail", pageIndex },
			signal,
		);
		return response.visual;
	}

	async prefetchThumbnail(pageIndex: number, signal?: AbortSignal): Promise<PageVisual | null> {
		const response = await this.#request<ThumbnailPrefetchRequest>(
			{
				type: "thumbnail-prefetch",
				pageIndex,
			},
			signal,
		);
		return response.visual;
	}

	cancelRequests(priority: PageTaskPriority): void {
		for (const [id, pending] of this.#pending) {
			if (pending.priority === priority) this.#requestCancellation(id, pending);
		}
	}

	promoteRender(pageIndex: number, scale: number, priority: PageTaskPriority): boolean {
		return this.#promotePageRequests(
			(pageRequest) =>
				pageRequest.type === "render" &&
				pageRequest.pageIndex === pageIndex &&
				pageRequest.scale === scale,
			priority,
		);
	}

	#promotePageRequests(
		matches: (request: WorkerRequest) => boolean,
		priority: PageTaskPriority,
	): boolean {
		let promoted = false;
		for (const [id, pending] of this.#pending) {
			if (
				!matches(pending.request) ||
				pending.cancellationRequested ||
				pending.signal?.aborted === true ||
				pending.priority === null ||
				getPriorityRank(priority) >= getPriorityRank(pending.priority)
			) {
				continue;
			}
			pending.priority = priority;
			promoted = true;
			try {
				this.#worker.postMessage({ type: "promote", id, priority });
			} catch (error) {
				this.#markUnavailable(
					new PdfiumWorkerUnavailableError(
						"The PDF worker stopped while promoting a page operation.",
						{ cause: error },
					),
				);
				return promoted;
			}
		}
		return promoted;
	}

	terminate(): void {
		if (this.#state !== "active") return;
		this.#state = "terminated";
		this.#opened = false;
		this.#stopWorker();
		for (const pending of this.#pendingRanges.values()) pending.controller.abort();
		this.#pendingRanges.clear();
		this.#rejectPending(new DOMException("PDF worker was terminated.", "AbortError"));
	}

	#request<Request extends WorkerRequest>(
		request: Request,
		signal?: AbortSignal,
	): Promise<ResponseFor<Request>> {
		if (this.#state === "unavailable") return Promise.reject(this.#terminalError);
		if (this.#state === "terminated")
			return Promise.reject(new DOMException("PDF worker was terminated.", "AbortError"));
		if (signal?.aborted) return Promise.reject(createAbortError());
		const id = this.#nextId;
		this.#nextId += 1;
		return new Promise<ResponseFor<Request>>((resolve, reject) => {
			const pending: PendingRequest = {
				request,
				resolve: (response) => {
					if (response.type === "error") {
						reject(createWorkerError(response));
						return;
					}
					resolve(response as ResponseFor<Request>);
				},
				reject,
				priority: getRequestPriority(request),
				signal,
				abortListener: null,
				cancellationRequested: false,
			};
			this.#pending.set(id, pending);
			if (signal !== undefined) {
				pending.abortListener = () => this.#requestCancellation(id, pending);
				signal.addEventListener("abort", pending.abortListener, { once: true });
			}
			try {
				this.#worker.postMessage({ id, ...request });
			} catch (error) {
				this.#pending.delete(id);
				this.#removeAbortListener(pending);
				reject(error);
				return;
			}
			if (signal?.aborted) this.#requestCancellation(id, pending);
		});
	}

	#onMessage(response: WorkerMessage): void {
		if (response.type === "bootstrap-ready") return;
		if (this.#state !== "active") {
			if (
				response.type === "rendered" ||
				response.type === "thumbnail" ||
				response.type === "thumbnail-prefetch"
			) {
				releaseWorkerResponse(response);
			}
			return;
		}
		if (response.type === "range-cancel") {
			this.#pendingRanges.get(response.id)?.controller.abort();
			return;
		}
		if (response.type === "range-request") {
			void this.#handleRangeRequest(response);
			return;
		}
		if (response.type === "range-promote") {
			const pending = this.#pendingRanges.get(response.id);
			if (pending !== undefined) {
				try {
					this.rangeBroker?.promoteRequest(pending.request, response.priority);
				} catch (error) {
					this.#markUnavailable(
						new PdfiumWorkerUnavailableError(
							"The document range broker stopped while promoting a request.",
							{ cause: error },
						),
					);
				}
			}
			return;
		}
		if (response.type === "error" && response.fatal === true) {
			this.#markUnavailable(new PdfiumWorkerUnavailableError(response.message));
			return;
		}

		const pending = this.#pending.get(response.id);
		if (pending === undefined) {
			releaseWorkerResponse(response);
			return;
		}
		this.#pending.delete(response.id);
		this.#removeAbortListener(pending);
		if (pending.signal?.aborted) {
			releaseWorkerResponse(response);
			pending.reject(createAbortError());
			return;
		}
		pending.resolve(response);
	}

	async #handleRangeRequest(message: RangeWorkerRequest): Promise<void> {
		const broker = this.rangeBroker;
		if (broker === undefined) {
			this.#replyToRangeRequest(message.id, null, "The PDF range broker is unavailable.");
			return;
		}
		const controller = new AbortController();
		this.#pendingRanges.set(message.id, { controller, request: message.request });
		try {
			const response = await broker.request(message.request, controller.signal);
			if (controller.signal.aborted || this.#state !== "active") return;
			const bytes = new Uint8Array(response.bytes.byteLength);
			bytes.set(response.bytes);
			this.#replyToRangeRequest(message.id, {
				bytes: bytes.buffer,
				totalLength: response.totalLength,
				etag: response.etag,
				lastModified: response.lastModified,
				responseUrl: response.responseUrl,
			});
		} catch (error) {
			if (!controller.signal.aborted && this.#state === "active") {
				this.#replyToRangeRequest(
					message.id,
					null,
					error instanceof Error ? error.message : "The PDF range request failed.",
					error instanceof PdfRepresentationChangedError,
				);
			}
		} finally {
			this.#pendingRanges.delete(message.id);
		}
	}

	#replyToRangeRequest(
		id: number,
		response: NonNullable<RangeWorkerResponse["response"]> | null,
		error?: string,
		fatal = false,
	): void {
		const message: RangeWorkerResponse =
			response === null
				? {
						type: "range-response",
						id,
						error: error ?? "The PDF range request failed.",
						fatal,
					}
				: { type: "range-response", id, response };
		const transfer: Transferable[] = response === null ? [] : [response.bytes];
		this.#worker.postMessage(message, transfer);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			this.#removeAbortListener(pending);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#requestCancellation(id: number, pending: PendingRequest): void {
		if (pending.cancellationRequested || this.#pending.get(id) !== pending) return;
		pending.cancellationRequested = true;
		try {
			this.#worker.postMessage({ type: "cancel", id });
		} catch (error) {
			this.#markUnavailable(
				new PdfiumWorkerUnavailableError(
					"The PDF worker stopped while cancelling a page operation.",
					{ cause: error },
				),
			);
		}
	}

	#removeAbortListener(pending: PendingRequest): void {
		if (pending.abortListener === null) return;
		pending.signal?.removeEventListener("abort", pending.abortListener);
		pending.abortListener = null;
	}

	#markUnavailable(error: PdfiumWorkerUnavailableError): void {
		if (this.#state !== "active") return;
		this.#state = "unavailable";
		this.#opened = false;
		this.#terminalError = error;
		this.#stopWorker();
		for (const pending of this.#pendingRanges.values()) pending.controller.abort();
		this.#pendingRanges.clear();
		this.#rejectPending(error);
	}

	#stopWorker(): void {
		this.#worker.terminate();
		this.#releaseWorkerBootstrap();
	}

	#releaseWorkerBootstrap(): void {
		this.#releaseBootstrapUrl?.();
		this.#releaseBootstrapUrl = null;
	}
}

function getRequestPriority(request: WorkerRequest): PageTaskPriority | null {
	if (request.type === "page-size" || request.type === "render") return request.priority;
	if (request.type === "page-prefetch") return "data";
	if (request.type === "thumbnail" || request.type === "thumbnail-prefetch") return "thumbnail";
	return null;
}

function getPriorityRank(priority: PageTaskPriority): number {
	if (priority === "visible") return 0;
	if (priority === "data") return 1;
	if (priority === "prerender") return 2;
	return 3;
}

function createWorkerError(response: ErrorResponse): Error {
	const error = new Error(response.message);
	if (response.errorName !== undefined) error.name = response.errorName;
	return error;
}

function releaseWorkerResponse(response: WorkerResponse): void {
	if (
		(response.type === "rendered" ||
			response.type === "thumbnail" ||
			response.type === "thumbnail-prefetch") &&
		response.visual?.type === "bitmap"
	) {
		response.visual.bitmap.close();
	}
}

function createAbortError(): DOMException {
	return new DOMException("PDF page operation was cancelled.", "AbortError");
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
