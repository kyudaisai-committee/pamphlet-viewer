import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

import { MAX_PAGE_RENDER_PIXELS } from "../document/page-source";
import type { PageSize, PageVisual } from "../document/page-source";
import type { PdfiumAvailabilitySession } from "./pdfium-availability-session";
import { copyRgbaBitmapPixels } from "./pdfium-pixel-buffer";
import { combinePdfiumRenderFlags } from "./pdfium-render-flags";
import type { PdfiumRenderFlags } from "./pdfium-render-flags";
import type { PdfRangeLoader } from "./range-loader";

const PAGE_SIZE_BUFFER_SIZE = 8;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
export const PAGE_RENDER_FLAGS: PdfiumRenderFlags = { reverseByteOrder: FPDF_REVERSE_BYTE_ORDER };

export function getPageSizeByIndex(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
): PageSize | null {
	let sizePointer = 0;
	let result: PageSize | null = null;
	let operationError: unknown;
	let hasOperationError = false;
	try {
		sizePointer = availability.runNative(
			() => pdfium.pdfium.wasmExports.malloc(PAGE_SIZE_BUFFER_SIZE),
			(pointer) => {
				sizePointer = pointer;
			},
		);
		if (sizePointer === 0) throw new Error("PDFium could not allocate page-size output memory.");

		const gotSize = availability.runNative(() =>
			pdfium.FPDF_GetPageSizeByIndexF(availability.documentHandle, pageIndex, sizePointer),
		);
		if (!loader.hasMissingChunks) {
			if (!gotSize) throw new Error(`PDFium could not get the size for page ${pageIndex}.`);
			const heap = getPdfiumHeap(pdfium);
			if (sizePointer > heap.byteLength - PAGE_SIZE_BUFFER_SIZE) {
				throw new Error("PDFium returned an invalid page-size output buffer.");
			}
			const view = new DataView(heap.buffer, heap.byteOffset + sizePointer, PAGE_SIZE_BUFFER_SIZE);
			const size = {
				width: view.getFloat32(0, true),
				height: view.getFloat32(Float32Array.BYTES_PER_ELEMENT, true),
			};
			if (
				!Number.isFinite(size.width) ||
				!Number.isFinite(size.height) ||
				size.width <= 0 ||
				size.height <= 0
			) {
				throw new Error("PDFium returned invalid page dimensions.");
			}
			result = size;
		}
	} catch (error) {
		operationError = error;
		hasOperationError = true;
		availability.markNativeFailure(error);
	}

	if (sizePointer !== 0 && !availability.isPoisoned) {
		try {
			availability.runNative(() => pdfium.pdfium.wasmExports.free(sizePointer));
		} catch (cleanupError) {
			availability.markNativeFailure(cleanupError);
			if (!hasOperationError) {
				operationError = cleanupError;
				hasOperationError = true;
			}
		}
	}

	if (hasOperationError) throw operationError;
	return result;
}

export function renderPdfiumPage(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
	scale: number,
): PageVisual | null {
	return runPageOperation(pdfium, availability, loader, pageIndex, (page) =>
		renderLoadedPage(pdfium, availability, page, scale),
	);
}

export function getPdfiumHeap(pdfium: WrappedPdfiumModule): Uint8Array {
	const runtime = pdfium.pdfium as WrappedPdfiumModule["pdfium"] & { HEAPU8: Uint8Array };
	return runtime.HEAPU8;
}

function runPageOperation<T>(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
	operation: (page: number) => T,
): T | null {
	let page = 0;
	let result: T | null = null;
	let operationError: unknown;
	let hasOperationError = false;
	try {
		page = availability.runNative(
			() => pdfium.FPDF_LoadPage(availability.documentHandle, pageIndex),
			(loadedPage) => {
				page = loadedPage;
			},
		);
		if (page === 0) {
			if (!loader.hasMissingChunks) {
				const errorCode = availability.runNative(() => pdfium.FPDF_GetLastError());
				throw new Error(`PDFium could not load page ${pageIndex} (error ${errorCode}).`);
			}
		} else {
			const value = operation(page);
			if (!loader.hasMissingChunks) result = value;
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
	if (result === null && !loader.hasMissingChunks) {
		throw new Error("PDFium did not complete the page render.");
	}
	return result;
}

function renderLoadedPage(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	page: number,
	scale: number,
): PageVisual {
	const pageSize = availability.runNative(() => ({
		width: pdfium.FPDF_GetPageWidthF(page),
		height: pdfium.FPDF_GetPageHeightF(page),
	}));
	if (
		!Number.isFinite(pageSize.width) ||
		!Number.isFinite(pageSize.height) ||
		pageSize.width <= 0 ||
		pageSize.height <= 0
	) {
		throw new Error("PDFium returned invalid page dimensions.");
	}
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
			(pointer) => {
				bitmap = pointer;
			},
		);
		if (bitmap === 0) throw new Error("PDFium could not allocate the page bitmap.");
		availability.runNative(() =>
			pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff),
		);
		availability.runNative(() =>
			pdfium.FPDF_RenderPageBitmap(
				bitmap,
				page,
				0,
				0,
				width,
				height,
				0,
				combinePdfiumRenderFlags(PAGE_RENDER_FLAGS),
			),
		);

		const { stride, sourcePointer } = availability.runNative(() => ({
			stride: pdfium.FPDFBitmap_GetStride(bitmap),
			sourcePointer: pdfium.FPDFBitmap_GetBuffer(bitmap),
		}));
		const pixels = copyRgbaBitmapPixels(
			getPdfiumHeap(pdfium),
			sourcePointer,
			width,
			height,
			stride,
		);
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
