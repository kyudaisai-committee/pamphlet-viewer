// SPDX-License-Identifier: MIT

import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";

import type { PageSize, PageVisual } from "@/lib/document/page-source";
import { calculateThumbnailScale } from "@/lib/document/thumbnail-scale";
import type { PageTaskPriority } from "@/lib/domain/scheduling/page-task-scheduler";

import {
	PdfiumAvailabilitySession,
	PdfiumAvailabilityFatalError,
	type PdfiumAvailabilityApi,
} from "./pdfium-availability-session";
import {
	getPageSizeByIndex,
	getPdfiumHeap,
	prefetchPdfiumPage,
	renderPdfiumPage,
} from "./pdfium-page-operation";
import { getPdfiumThumbnailByIndex } from "./pdfium-thumbnail-operation";
import { PdfRangeLoader, RANGE_CACHE_LIMIT } from "./range-loader";
import type { RangeWorkerRequester } from "./range-transport";

const MAX_OPERATION_ATTEMPTS = 128;

export interface PdfiumDocumentInfo {
	pageCount: number;
	fileLength: number;
}

export class PdfiumFatalError extends Error {
	constructor(cause: unknown) {
		const message =
			cause instanceof Error ? cause.message : "PDFium entered an unusable state.";
		super(message, { cause });
		this.name = "PdfiumFatalError";
	}
}

export class PdfiumDocumentSession {
	#pdfium: WrappedPdfiumModule | null = null;
	#availability: PdfiumAvailabilitySession | null = null;
	#fileLength: number | null = null;
	#pageCount: number | null = null;
	#disposed = false;
	#poisoned = false;

	private constructor(
		private readonly loader: PdfRangeLoader,
		private readonly wasmUrl: string,
		private readonly signal: AbortSignal,
	) {}

	static async open(
		url: string,
		wasmUrl: string,
		signal: AbortSignal,
		cacheLimitBytes = RANGE_CACHE_LIMIT,
		rangeRequester?: RangeWorkerRequester,
	): Promise<PdfiumDocumentSession> {
		const loader = new PdfRangeLoader(url, signal, cacheLimitBytes, rangeRequester);
		const session = new PdfiumDocumentSession(loader, wasmUrl, signal);
		try {
			await session.#initialize();
			return session;
		} catch (error) {
			session.dispose();
			const fatal =
				session.isPoisoned ||
				error instanceof PdfiumAvailabilityFatalError ||
				error instanceof WebAssembly.RuntimeError;
			if (fatal) throw new PdfiumFatalError(error);
			throw error;
		}
	}

	get info(): PdfiumDocumentInfo {
		const availability = this.#availability;
		if (this.#fileLength === null || this.#pageCount === null || availability === null) {
			throw new Error("The PDF document is not open.");
		}
		return { pageCount: this.#pageCount, fileLength: this.#fileLength };
	}

	get isPoisoned(): boolean {
		return this.#poisoned || this.#availability?.isPoisoned === true;
	}

	async getPageSize(
		pageIndex: number,
		priority: PageTaskPriority = "visible",
		operationSignal?: AbortSignal,
	): Promise<PageSize> {
		this.#assertPageIndex(pageIndex);
		this.loader.setPriority(priority);
		return this.#runDocumentOperation(
			pageIndex,
			(pdfium, availability, allowPageLoadFallback) =>
				getPageSizeByIndex(
					pdfium,
					availability,
					this.loader,
					pageIndex,
					allowPageLoadFallback,
				),
			"document",
			operationSignal,
		);
	}

	async renderPage(
		pageIndex: number,
		scale: number,
		priority: PageTaskPriority = "visible",
		operationSignal?: AbortSignal,
	): Promise<PageVisual> {
		this.#assertPageIndex(pageIndex);
		if (!Number.isFinite(scale) || scale <= 0) {
			throw new RangeError("PDF page scale must be a finite number greater than 0.");
		}

		this.loader.setPriority(priority);
		return this.#runDocumentOperation(
			pageIndex,
			(pdfium, availability) =>
				renderPdfiumPage(pdfium, availability, this.loader, pageIndex, scale),
			"page",
			operationSignal,
		);
	}

	async prefetchPage(pageIndex: number, operationSignal?: AbortSignal): Promise<void> {
		this.#assertPageIndex(pageIndex);
		this.loader.setPriority("data");
		await this.#runDocumentOperation(
			pageIndex,
			(pdfium, availability) =>
				prefetchPdfiumPage(pdfium, availability, this.loader, pageIndex),
			"page",
			operationSignal,
		);
	}

	async renderThumbnail(pageIndex: number, operationSignal?: AbortSignal): Promise<PageVisual> {
		this.loader.setPriority("thumbnail");
		const thumbnail = await this.prefetchThumbnail(pageIndex, operationSignal);
		if (thumbnail !== null) return thumbnail;
		const pageSize = await this.getPageSize(pageIndex, "thumbnail", operationSignal);
		return this.renderPage(
			pageIndex,
			calculateThumbnailScale(pageSize.width, pageSize.height),
			"thumbnail",
			operationSignal,
		);
	}

	async prefetchThumbnail(
		pageIndex: number,
		operationSignal?: AbortSignal,
	): Promise<PageVisual | null> {
		this.#assertPageIndex(pageIndex);
		this.loader.setPriority("thumbnail");
		const result = await this.#runDocumentOperation(
			pageIndex,
			(pdfium, availability) => {
				const thumbnail = getPdfiumThumbnailByIndex(
					pdfium,
					availability,
					this.loader,
					pageIndex,
				);
				return thumbnail === null ? null : { thumbnail };
			},
			"page",
			operationSignal,
		);
		return result.thumbnail.type === "visual" ? result.thumbnail.visual : null;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const availability = this.#availability;
		this.#poisoned = this.#poisoned || availability?.isPoisoned === true;
		availability?.dispose();
		this.#poisoned = this.#poisoned || availability?.isPoisoned === true;
		this.#availability = null;
		this.loader.dispose();
		this.#fileLength = null;
		this.#pageCount = null;
	}

	async #initialize(): Promise<void> {
		if (this.signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
		const [fileLength, pdfium] = await Promise.all([
			this.loader.initialize(),
			getPdfium(this.wasmUrl),
		]);
		this.#fileLength = fileLength;
		this.#pdfium = pdfium;
		this.#availability = await PdfiumAvailabilitySession.open(
			createAvailabilityApi(this.#pdfium),
			this.loader,
			this.signal,
		);
		this.#pageCount = this.#availability.pageCount;
	}

	async #runDocumentOperation<T>(
		pageIndex: number,
		operation: (
			pdfium: WrappedPdfiumModule,
			availability: PdfiumAvailabilitySession,
			allowPageLoadFallback: boolean,
		) => T | null,
		availabilityRequirement: "document" | "page",
		operationSignal?: AbortSignal,
	): Promise<T> {
		const pdfium = this.#pdfium;
		const availability = this.#availability;
		if (pdfium === null || availability === null || this.#disposed) {
			throw new Error("The PDF document is not open.");
		}

		if (operationSignal?.aborted) throw createOperationAbortError();
		this.loader.setOperationSignal(operationSignal ?? null);
		let pageAvailabilityCacheEpoch: number | null = null;
		try {
			availability.beginPageOperation();
			for (let attempt = 0; attempt < MAX_OPERATION_ATTEMPTS; attempt += 1) {
				if (operationSignal?.aborted) throw createOperationAbortError();
				if (this.signal.aborted)
					throw new DOMException("PDF loading was cancelled.", "AbortError");
				if (availabilityRequirement === "page")
					await availability.ensurePageAvailable(pageIndex);
				else await availability.ensureDocumentAvailable();
				if (operationSignal?.aborted) throw createOperationAbortError();
				if (this.#disposed) {
					throw new DOMException("PDF loading was cancelled.", "AbortError");
				}
				if (pageAvailabilityCacheEpoch !== this.loader.cacheEpoch) {
					pageAvailabilityCacheEpoch = null;
				}
				let value: T | null;
				try {
					value = operation(
						pdfium,
						availability,
						pageAvailabilityCacheEpoch === this.loader.cacheEpoch,
					);
				} catch (error) {
					availability.markNativeFailure(error);
					throw error;
				}
				if (value === null && !this.loader.hasMissingChunks) {
					if (availabilityRequirement === "document") {
						const pageAvailable = await availability.preparePageSizeFallback(pageIndex);
						pageAvailabilityCacheEpoch = pageAvailable ? this.loader.cacheEpoch : null;
						continue;
					}
					throw new Error("PDFium did not complete the document operation.");
				}
				if (!this.loader.hasMissingChunks && value !== null) {
					availability.completePageOperation();
					return value;
				}
				pageAvailabilityCacheEpoch = null;
				await availability.recoverAfterReadMiss();
			}

			throw new Error(
				"PDFium could not complete the requested page operation within 128 range attempts.",
			);
		} finally {
			this.loader.setOperationSignal(null);
		}
	}

	#assertPageIndex(pageIndex: number): void {
		const availability = this.#availability;
		const pageCount = this.#pageCount;
		if (availability === null || pageCount === null) {
			throw new Error("The PDF document is not open.");
		}
		if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
			throw new RangeError(`Page index must be between 0 and ${pageCount - 1}.`);
		}
	}
}

function createOperationAbortError(): DOMException {
	return new DOMException("PDF page operation was cancelled.", "AbortError");
}

function createAvailabilityApi(pdfium: WrappedPdfiumModule): PdfiumAvailabilityApi {
	return {
		FPDFAvail_Create: (fileAvail, fileAccess) => pdfium.FPDFAvail_Create(fileAvail, fileAccess),
		FPDFAvail_Destroy: (availability) => pdfium.FPDFAvail_Destroy(availability),
		FPDFAvail_GetDocument: (availability, password) =>
			pdfium.FPDFAvail_GetDocument(availability, password),
		FPDFAvail_IsDocAvail: (availability, hints) =>
			pdfium.FPDFAvail_IsDocAvail(availability, hints),
		FPDFAvail_IsLinearized: (availability) => pdfium.FPDFAvail_IsLinearized(availability),
		FPDFAvail_IsPageAvail: (availability, pageIndex, hints) =>
			pdfium.FPDFAvail_IsPageAvail(availability, pageIndex, hints),
		FPDF_CloseDocument: (document) => pdfium.FPDF_CloseDocument(document),
		FPDF_GetLastError: () => pdfium.FPDF_GetLastError(),
		FPDF_GetPageCount: (document) => pdfium.FPDF_GetPageCount(document),
		runtime: {
			malloc: (size) => pdfium.pdfium.wasmExports.malloc(size),
			free: (pointer) => pdfium.pdfium.wasmExports.free(pointer),
			addFunction: (callback, signature) => pdfium.pdfium.addFunction(callback, signature),
			removeFunction: (pointer) => pdfium.pdfium.removeFunction(pointer),
			setValue: (pointer, value, type) => pdfium.pdfium.setValue(pointer, value, type),
			getHeap: () => getPdfiumHeap(pdfium),
		},
	};
}

let pdfiumPromise: Promise<WrappedPdfiumModule> | null = null;

function getPdfium(wasmUrl: string): Promise<WrappedPdfiumModule> {
	if (pdfiumPromise === null) pdfiumPromise = loadPdfium(wasmUrl);
	return pdfiumPromise;
}

async function loadPdfium(wasmUrl: string): Promise<WrappedPdfiumModule> {
	const response = await fetch(wasmUrl);
	if (!response.ok)
		throw new Error(`Could not load PDFium WebAssembly (HTTP ${response.status}).`);
	const wasmBinary = await response.arrayBuffer();
	const pdfium = await init({ wasmBinary, locateFile: () => wasmUrl });
	pdfium.PDFiumExt_Init();
	return pdfium;
}
