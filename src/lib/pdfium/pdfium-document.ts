import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";

import type { PageSize, PageVisual } from "../document/page-source";
import { PdfRangeLoader } from "./range-loader";

const FILE_ACCESS_SIZE = 12;
const MAX_RENDER_PIXELS = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 128;

export interface PdfiumDocumentInfo {
	pageCount: number;
	fileLength: number;
}

export class PdfiumDocumentSession {
	#pdfium: WrappedPdfiumModule | null = null;
	#fileLength: number | null = null;
	#pageCount: number | null = null;

	private constructor(
		private readonly loader: PdfRangeLoader,
		private readonly signal: AbortSignal,
	) {}

	static async open(url: string, signal: AbortSignal): Promise<PdfiumDocumentSession> {
		const loader = new PdfRangeLoader(url, signal);
		const session = new PdfiumDocumentSession(loader, signal);
		try {
			await session.#initialize();
			return session;
		} catch (error) {
			loader.dispose();
			throw error;
		}
	}

	get info(): PdfiumDocumentInfo {
		if (this.#fileLength === null || this.#pageCount === null) {
			throw new Error("The PDF document is not open.");
		}
		return { pageCount: this.#pageCount, fileLength: this.#fileLength };
	}

	async getPageSize(pageIndex: number): Promise<PageSize> {
		this.#assertPageIndex(pageIndex);
		return this.#runWithDocument((pdfium, document) => {
			const page = pdfium.FPDF_LoadPage(document, pageIndex);
			if (page === 0) return missingOrThrow(this.loader, pdfium);
			try {
				const size = getPageSize(pdfium, page);
				return this.loader.hasMissingChunks ? missingAttempt() : successAttempt(size);
			} finally {
				pdfium.FPDF_ClosePage(page);
			}
		});
	}

	async renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertPageIndex(pageIndex);
		if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
			throw new RangeError("PDF page scale must be greater than 0 and no greater than 8.");
		}

		return this.#runWithDocument((pdfium, document) => {
			const page = pdfium.FPDF_LoadPage(document, pageIndex);
			if (page === 0) return missingOrThrow(this.loader, pdfium);
			try {
				const pageSize = getPageSize(pdfium, page);
				const width = Math.ceil(pageSize.width * scale);
				const height = Math.ceil(pageSize.height * scale);
				if (
					!Number.isSafeInteger(width) ||
					!Number.isSafeInteger(height) ||
					width < 1 ||
					height < 1
				) {
					throw new Error("PDFium returned invalid scaled page dimensions.");
				}
				if (width * height > MAX_RENDER_PIXELS) {
					throw new Error("The requested PDF page exceeds the 32 MiB pixel output limit.");
				}

				const bitmap = pdfium.FPDFBitmap_Create(width, height, 1);
				if (bitmap === 0) throw new Error("PDFium could not allocate the page bitmap.");
				try {
					pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
					pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0);
					if (this.loader.hasMissingChunks) return missingAttempt();

					const stride = pdfium.FPDFBitmap_GetStride(bitmap);
					const sourcePointer = pdfium.FPDFBitmap_GetBuffer(bitmap);
					const pixels = convertBgraToRgba(
						getPdfiumHeap(pdfium),
						sourcePointer,
						width,
						height,
						stride,
					);
					return this.loader.hasMissingChunks
						? missingAttempt()
						: successAttempt({ type: "pixels", width, height, pixels });
				} finally {
					pdfium.FPDFBitmap_Destroy(bitmap);
				}
			} finally {
				pdfium.FPDF_ClosePage(page);
			}
		});
	}

	dispose(): void {
		this.loader.dispose();
		this.#fileLength = null;
		this.#pageCount = null;
	}

	async #initialize(): Promise<void> {
		this.#fileLength = await this.loader.initialize();
		this.#pdfium = await getPdfium();
		this.#pageCount = await this.#runWithDocument((pdfium, document) => {
			const pageCount = pdfium.FPDF_GetPageCount(document);
			if (this.loader.hasMissingChunks) return missingAttempt();
			if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
				throw new Error("PDFium returned an invalid page count.");
			}
			return successAttempt(pageCount);
		});
	}

	async #runWithDocument<T>(
		operation: (pdfium: WrappedPdfiumModule, document: number) => PdfiumAttempt<T>,
	): Promise<T> {
		const pdfium = this.#pdfium ?? (await getPdfium());
		this.#pdfium = pdfium;
		for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
			if (this.signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");
			const attempt = runDocumentAttempt(pdfium, this.loader, this.#fileLength, operation);
			if (attempt.type === "success") return attempt.value;
			await this.loader.fetchMissingChunks();
		}
		throw new Error(
			"This PDF page needs more range data than the 64 MiB working cache can retain.",
		);
	}

	#assertPageIndex(pageIndex: number): void {
		const pageCount = this.#pageCount;
		if (pageCount === null) throw new Error("The PDF document is not open.");
		if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
			throw new RangeError(`Page index must be between 0 and ${pageCount - 1}.`);
		}
	}
}

type PdfiumAttempt<T> = { type: "success"; value: T } | { type: "missing" };
type FileReadCallback = (
	parameter: number,
	position: number,
	buffer: number,
	size: number,
) => number;

function runDocumentAttempt<T>(
	pdfium: WrappedPdfiumModule,
	loader: PdfRangeLoader,
	fileLength: number | null,
	operation: (pdfium: WrappedPdfiumModule, document: number) => PdfiumAttempt<T>,
): PdfiumAttempt<T> {
	if (fileLength === null) throw new Error("The PDF document has no file length.");
	const fileAccess = pdfium.pdfium.wasmExports.malloc(FILE_ACCESS_SIZE);
	if (fileAccess === 0) throw new Error("Could not allocate PDFium file access data.");
	let callbackPointer: number | null = null;
	let document: number | null = null;
	let callbackError: Error | null = null;
	const readBlock: FileReadCallback = function readBlockCallback(
		_parameter,
		position,
		buffer,
		size,
	): number {
		try {
			return loader.readInto(position, getPdfiumHeap(pdfium), buffer, size) ? 1 : 0;
		} catch (error) {
			callbackError =
				error instanceof Error ? error : new Error("PDFium requested an invalid range.");
			return 0;
		}
	};

	try {
		callbackPointer = pdfium.pdfium.addFunction(readBlock, "iiiii");
		pdfium.pdfium.setValue(fileAccess, fileLength, "i32");
		pdfium.pdfium.setValue(fileAccess + 4, callbackPointer, "i32");
		pdfium.pdfium.setValue(fileAccess + 8, 0, "i32");
		document = pdfium.FPDF_LoadCustomDocument(fileAccess, "");
		if (callbackError !== null) throw callbackError;
		if (document === 0) return missingOrThrow(loader, pdfium);

		const result = operation(pdfium, document);
		if (callbackError !== null) throw callbackError;
		if (result.type === "success" && loader.hasMissingChunks) return missingAttempt();
		return result;
	} finally {
		if (document !== null) pdfium.FPDF_CloseDocument(document);
		if (callbackPointer !== null) pdfium.pdfium.removeFunction(callbackPointer);
		pdfium.pdfium.wasmExports.free(fileAccess);
	}
}

function missingOrThrow<T>(loader: PdfRangeLoader, pdfium: WrappedPdfiumModule): PdfiumAttempt<T> {
	if (loader.hasMissingChunks) return missingAttempt();
	throw new Error(`PDFium could not open the document (error ${pdfium.FPDF_GetLastError()}).`);
}

function missingAttempt<T>(): PdfiumAttempt<T> {
	return { type: "missing" };
}

function successAttempt<T>(value: T): PdfiumAttempt<T> {
	return { type: "success", value };
}

function getPageSize(pdfium: WrappedPdfiumModule, page: number): PageSize {
	const width = pdfium.FPDF_GetPageWidthF(page);
	const height = pdfium.FPDF_GetPageHeightF(page);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error("PDFium returned invalid page dimensions.");
	}
	return { width, height };
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

function getPdfium(): Promise<WrappedPdfiumModule> {
	if (pdfiumPromise === null) pdfiumPromise = loadPdfium();
	return pdfiumPromise;
}

async function loadPdfium(): Promise<WrappedPdfiumModule> {
	const response = await fetch(wasmUrl);
	if (!response.ok) throw new Error(`Could not load PDFium WebAssembly (HTTP ${response.status}).`);
	const wasmBinary = await response.arrayBuffer();
	const pdfium = await init({ wasmBinary });
	pdfium.PDFiumExt_Init();
	return pdfium;
}
