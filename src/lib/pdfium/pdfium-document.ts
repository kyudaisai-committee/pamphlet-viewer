import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";

import { MAX_PAGE_RENDER_PIXELS } from "../document/page-source";
import type { PageSize, PageVisual } from "../document/page-source";
import {
	PdfiumAvailabilitySession,
	PdfiumAvailabilityFatalError,
	type PdfiumAvailabilityApi,
} from "./pdfium-availability-session";
import { PdfRangeLoader, RANGE_CACHE_LIMIT } from "./range-loader";

const MAX_OPERATION_ATTEMPTS = 128;

export interface PdfiumDocumentInfo {
	pageCount: number;
	fileLength: number;
}

export class PdfiumFatalError extends Error {
	constructor(cause: unknown) {
		const message = cause instanceof Error ? cause.message : "PDFium entered an unusable state.";
		super(message, { cause });
		this.name = "PdfiumFatalError";
	}
}

export class PdfiumDocumentSession {
	#pdfium: WrappedPdfiumModule | null = null;
	#availability: PdfiumAvailabilitySession | null = null;
	#fileLength: number | null = null;
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
	): Promise<PdfiumDocumentSession> {
		const loader = new PdfRangeLoader(url, signal, cacheLimitBytes);
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
		if (this.#fileLength === null || availability === null) {
			throw new Error("The PDF document is not open.");
		}
		return { pageCount: availability.pageCount, fileLength: this.#fileLength };
	}

	get isPoisoned(): boolean {
		return this.#poisoned || this.#availability?.isPoisoned === true;
	}

	async getPageSize(pageIndex: number): Promise<PageSize> {
		this.#assertPageIndex(pageIndex);
		return this.#runPageOperation(pageIndex, (pdfium, availability, page) =>
			getPageSize(pdfium, availability, page),
		);
	}

	async renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertPageIndex(pageIndex);
		if (!Number.isFinite(scale) || scale <= 0) {
			throw new RangeError("PDF page scale must be a finite number greater than 0.");
		}

		return this.#runPageOperation(pageIndex, (pdfium, availability, page) =>
			renderPage(pdfium, availability, page, scale),
		);
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
	}

	async #runPageOperation<T>(
		pageIndex: number,
		operation: (
			pdfium: WrappedPdfiumModule,
			availability: PdfiumAvailabilitySession,
			page: number,
		) => T,
	): Promise<T> {
		const pdfium = this.#pdfium;
		const availability = this.#availability;
		if (pdfium === null || availability === null || this.#disposed) {
			throw new Error("The PDF document is not open.");
		}

		availability.beginPageOperation();
		for (let attempt = 0; attempt < MAX_OPERATION_ATTEMPTS; attempt += 1) {
			if (this.signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
			await availability.ensurePageAvailable(pageIndex);
			if (this.#disposed) {
				throw new DOMException("PDF loading was cancelled.", "AbortError");
			}
			const result = runPageOperation(pdfium, availability, this.loader, pageIndex, operation);
			if (result.type === "success") {
				availability.completePageOperation();
				return result.value;
			}
			await availability.recoverAfterReadMiss();
		}

		throw new Error("PDFium could not render the requested page within 128 range attempts.");
	}

	#assertPageIndex(pageIndex: number): void {
		const availability = this.#availability;
		if (availability === null) throw new Error("The PDF document is not open.");
		if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= availability.pageCount) {
			throw new RangeError(`Page index must be between 0 and ${availability.pageCount - 1}.`);
		}
	}
}

type PageOperation<T> = { type: "success"; value: T } | { type: "missing" };

function runPageOperation<T>(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
	operation: (
		pdfium: WrappedPdfiumModule,
		availability: PdfiumAvailabilitySession,
		page: number,
	) => T,
): PageOperation<T> {
	let page = 0;
	let result: PageOperation<T> | null = null;
	let operationError: unknown;
	let hasOperationError = false;
	try {
		page = availability.runNative(
			() => pdfium.FPDF_LoadPage(availability.documentHandle, pageIndex),
			(result) => {
				page = result;
			},
		);
		if (page === 0) {
			if (loader.hasMissingChunks) result = { type: "missing" };
			else {
				const errorCode = availability.runNative(() => pdfium.FPDF_GetLastError());
				throw new Error(`PDFium could not load page ${pageIndex} (error ${errorCode}).`);
			}
		} else {
			const value = operation(pdfium, availability, page);
			result = loader.hasMissingChunks ? { type: "missing" } : { type: "success", value };
		}
	} catch (error) {
		operationError = error;
		hasOperationError = true;
		availability.markNativeFailure(error);
	}

	if (page !== 0 && !availability.isPoisoned) {
		try {
			availability.runNative(() => pdfium.FPDF_ClosePage(page));
		} catch (cleanupError) {
			availability.markNativeFailure(cleanupError);
			if (!hasOperationError) {
				operationError = cleanupError;
				hasOperationError = true;
			}
		}
	}

	if (hasOperationError) throw operationError;
	if (result === null) throw new Error("PDFium did not complete the page operation.");
	return result;
}

function getPageSize(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	page: number,
): PageSize {
	const size = availability.runNative(() => ({
		width: pdfium.FPDF_GetPageWidthF(page),
		height: pdfium.FPDF_GetPageHeightF(page),
	}));
	if (
		!Number.isFinite(size.width) ||
		!Number.isFinite(size.height) ||
		size.width <= 0 ||
		size.height <= 0
	) {
		throw new Error("PDFium returned invalid page dimensions.");
	}
	return size;
}

function renderPage(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	page: number,
	scale: number,
): PageVisual {
	const pageSize = getPageSize(pdfium, availability, page);
	const width = Math.ceil(pageSize.width * scale);
	const height = Math.ceil(pageSize.height * scale);
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
		throw new Error("PDFium returned invalid scaled page dimensions.");
	}
	if (width * height > MAX_PAGE_RENDER_PIXELS) {
		throw new Error("The requested PDF page exceeds the 32 MiB pixel output limit.");
	}

	let bitmap = 0;
	let result: PageVisual | null = null;
	let renderError: unknown;
	let hasRenderError = false;
	try {
		bitmap = availability.runNative(
			() => pdfium.FPDFBitmap_Create(width, height, 1),
			(result) => {
				bitmap = result;
			},
		);
		if (bitmap === 0) throw new Error("PDFium could not allocate the page bitmap.");
		availability.runNative(() =>
			pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff),
		);
		availability.runNative(() =>
			pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0),
		);

		const { stride, sourcePointer } = availability.runNative(() => ({
			stride: pdfium.FPDFBitmap_GetStride(bitmap),
			sourcePointer: pdfium.FPDFBitmap_GetBuffer(bitmap),
		}));
		const pixels = convertBgraToRgba(getPdfiumHeap(pdfium), sourcePointer, width, height, stride);
		result = { type: "pixels", width, height, pixels };
	} catch (error) {
		renderError = error;
		hasRenderError = true;
		availability.markNativeFailure(error);
	}

	if (bitmap !== 0 && !availability.isPoisoned) {
		try {
			availability.runNative(() => pdfium.FPDFBitmap_Destroy(bitmap));
		} catch (cleanupError) {
			availability.markNativeFailure(cleanupError);
			if (!hasRenderError) {
				renderError = cleanupError;
				hasRenderError = true;
			}
		}
	}

	if (hasRenderError) throw renderError;
	if (result === null) throw new Error("PDFium did not complete the page render.");
	return result;
}

function createAvailabilityApi(pdfium: WrappedPdfiumModule): PdfiumAvailabilityApi {
	return {
		FPDFAvail_Create: (fileAvail, fileAccess) => pdfium.FPDFAvail_Create(fileAvail, fileAccess),
		FPDFAvail_Destroy: (availability) => pdfium.FPDFAvail_Destroy(availability),
		FPDFAvail_GetDocument: (availability, password) =>
			pdfium.FPDFAvail_GetDocument(availability, password),
		FPDFAvail_IsDocAvail: (availability, hints) => pdfium.FPDFAvail_IsDocAvail(availability, hints),
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

function convertBgraToRgba(
	heap: Uint8Array,
	sourcePointer: number,
	width: number,
	height: number,
	stride: number,
): ArrayBuffer {
	const pixels = new Uint8Array(width * height * 4);
	for (let row = 0; row < height; row += 1) {
		for (let column = 0; column < width; column += 1) {
			const sourceOffset = sourcePointer + row * stride + column * 4;
			const targetOffset = (row * width + column) * 4;
			pixels[targetOffset] = heap[sourceOffset + 2];
			pixels[targetOffset + 1] = heap[sourceOffset + 1];
			pixels[targetOffset + 2] = heap[sourceOffset];
			pixels[targetOffset + 3] = heap[sourceOffset + 3];
		}
	}
	return pixels.buffer;
}

function getPdfiumHeap(pdfium: WrappedPdfiumModule): Uint8Array {
	const runtime = pdfium.pdfium as WrappedPdfiumModule["pdfium"] & { HEAPU8: Uint8Array };
	return runtime.HEAPU8;
}

let pdfiumPromise: Promise<WrappedPdfiumModule> | null = null;

function getPdfium(wasmUrl: string): Promise<WrappedPdfiumModule> {
	if (pdfiumPromise === null) pdfiumPromise = loadPdfium(wasmUrl);
	return pdfiumPromise;
}

async function loadPdfium(wasmUrl: string): Promise<WrappedPdfiumModule> {
	const response = await fetch(wasmUrl);
	if (!response.ok) throw new Error(`Could not load PDFium WebAssembly (HTTP ${response.status}).`);
	const wasmBinary = await response.arrayBuffer();
	const pdfium = await init({ wasmBinary, locateFile: () => wasmUrl });
	pdfium.PDFiumExt_Init();
	return pdfium;
}
