// SPDX-License-Identifier: MIT

import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

import { MAX_PAGE_RENDER_PIXELS } from "@/lib/document/page-source";
import type { PageSize, PageVisual } from "@/lib/document/page-source";

import type { PdfiumAvailabilitySession } from "./pdfium-availability-session";
import { runPdfiumPageOperation } from "./pdfium-page-lifecycle";
import { copyRgbaBitmapPixels } from "./pdfium-pixel-buffer";
import { combinePdfiumRenderFlags } from "./pdfium-render-flags";
import type { PdfiumRenderFlags } from "./pdfium-render-flags";
import type { PdfRangeLoader } from "./range-loader";

const PAGE_SIZE_BUFFER_SIZE = 8;
const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
export const PAGE_RENDER_FLAGS: PdfiumRenderFlags = {
	annotations: FPDF_ANNOT,
	reverseByteOrder: FPDF_REVERSE_BYTE_ORDER,
};

export function getPageSizeByIndex(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
	allowPageLoadFallback = false,
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
		if (sizePointer === 0)
			throw new Error("PDFium could not allocate page-size output memory.");

		const gotSize = availability.runNative(() =>
			pdfium.FPDF_GetPageSizeByIndexF(availability.documentHandle, pageIndex, sizePointer),
		);
		if (gotSize && !loader.hasMissingChunks) {
			result = readPageSizeBuffer(pdfium, sizePointer);
		} else if (!loader.hasMissingChunks && allowPageLoadFallback) {
			result = runPdfiumPageOperation(pdfium, availability, loader, pageIndex, (page) =>
				getLoadedPageSize(pdfium, availability, page),
			);
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

function readPageSizeBuffer(pdfium: WrappedPdfiumModule, pointer: number): PageSize {
	const heap = getPdfiumHeap(pdfium);
	if (pointer > heap.byteLength - PAGE_SIZE_BUFFER_SIZE) {
		throw new Error("PDFium returned an invalid page-size output buffer.");
	}
	const view = new DataView(heap.buffer, heap.byteOffset + pointer, PAGE_SIZE_BUFFER_SIZE);
	return validatePageSize({
		width: view.getFloat32(0, true),
		height: view.getFloat32(Float32Array.BYTES_PER_ELEMENT, true),
	});
}

function getLoadedPageSize(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	page: number,
): PageSize {
	const size = availability.runNative(() => ({
		width: pdfium.FPDF_GetPageWidthF(page),
		height: pdfium.FPDF_GetPageHeightF(page),
	}));
	return validatePageSize(size);
}

function validatePageSize(size: PageSize): PageSize {
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

export function renderPdfiumPage(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
	scale: number,
): PageVisual | null {
	return runPdfiumPageOperation(pdfium, availability, loader, pageIndex, (page) =>
		renderLoadedPage(pdfium, availability, loader, page, scale),
	);
}

export function prefetchPdfiumPage(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
): boolean | null {
	return runPdfiumPageOperation(pdfium, availability, loader, pageIndex, () => true);
}

export function getPdfiumHeap(pdfium: WrappedPdfiumModule): Uint8Array {
	const runtime = pdfium.pdfium as WrappedPdfiumModule["pdfium"] & { HEAPU8: Uint8Array };
	return runtime.HEAPU8;
}

function renderLoadedPage(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	page: number,
	scale: number,
): PageVisual | null {
	const pageSize = availability.runNative(() => ({
		width: pdfium.FPDF_GetPageWidthF(page),
		height: pdfium.FPDF_GetPageHeightF(page),
	}));
	if (loader.hasMissingChunks) return null;
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
		if (!loader.hasMissingChunks) {
			availability.runNative(() =>
				pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff),
			);
		}
		if (!loader.hasMissingChunks) {
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
		}
		if (!loader.hasMissingChunks) {
			const { stride, sourcePointer } = availability.runNative(() => ({
				stride: pdfium.FPDFBitmap_GetStride(bitmap),
				sourcePointer: pdfium.FPDFBitmap_GetBuffer(bitmap),
			}));
			if (!loader.hasMissingChunks) {
				const pixels = copyRgbaBitmapPixels(
					getPdfiumHeap(pdfium),
					sourcePointer,
					width,
					height,
					stride,
				);
				result = { type: "pixels", width, height, pixels };
			}
		}
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
	if (result === null && !loader.hasMissingChunks) {
		throw new Error("PDFium did not complete the page render.");
	}
	return result;
}
