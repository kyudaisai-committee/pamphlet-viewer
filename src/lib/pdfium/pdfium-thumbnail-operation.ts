// SPDX-License-Identifier: MIT

import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

import type { PageVisual } from "../document/page-source";
import type { PdfiumAvailabilitySession } from "./pdfium-availability-session";
import { runPdfiumPageOperation } from "./pdfium-page-lifecycle";
import { getPdfiumHeap } from "./pdfium-page-operation";
import { copyPdfiumThumbnailPixels } from "./pdfium-pixel-buffer";
import type { PdfRangeLoader } from "./range-loader";

export type PdfiumThumbnailResult = { type: "none" } | { type: "visual"; visual: PageVisual };

export function getPdfiumThumbnailByIndex(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
): PdfiumThumbnailResult | null {
	return runPdfiumPageOperation(pdfium, availability, loader, pageIndex, (page) =>
		getLoadedPdfiumThumbnail(pdfium, availability, loader, page),
	);
}

function getLoadedPdfiumThumbnail(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	page: number,
): PdfiumThumbnailResult | null {
	const getThumbnail = pdfium.FPDFPage_GetThumbnailAsBitmap;
	if (typeof getThumbnail !== "function") return { type: "none" };

	let bitmap = 0;
	let colorConvertedBitmap = 0;
	let result: PdfiumThumbnailResult | null = { type: "none" };
	let operationError: unknown;
	let hasOperationError = false;
	try {
		bitmap = availability.runNative(
			() => getThumbnail(page),
			(createdBitmap) => {
				bitmap = createdBitmap;
			},
		);
		if (bitmap !== 0 && !loader.hasMissingChunks) {
			const { sourceFormat, sourceWidth, sourceHeight } = availability.runNative(() => ({
				sourceFormat: pdfium.FPDFBitmap_GetFormat(bitmap),
				sourceWidth: pdfium.FPDFBitmap_GetWidth(bitmap),
				sourceHeight: pdfium.FPDFBitmap_GetHeight(bitmap),
			}));
			if (sourceFormat === 1) {
				colorConvertedBitmap = tryConvertThumbnailBitmapToColor(
					pdfium,
					availability,
					bitmap,
					sourceWidth,
					sourceHeight,
				);
			}
			const outputBitmap = colorConvertedBitmap || bitmap;
			const { width, height, stride, sourcePointer, format } = availability.runNative(() => ({
				width: pdfium.FPDFBitmap_GetWidth(outputBitmap),
				height: pdfium.FPDFBitmap_GetHeight(outputBitmap),
				stride: pdfium.FPDFBitmap_GetStride(outputBitmap),
				sourcePointer: pdfium.FPDFBitmap_GetBuffer(outputBitmap),
				format: pdfium.FPDFBitmap_GetFormat(outputBitmap),
			}));
			if (!loader.hasMissingChunks) {
				const pixels = copyPdfiumThumbnailPixels(
					getPdfiumHeap(pdfium),
					sourcePointer,
					width,
					height,
					stride,
					format,
				);
				result = {
					type: "visual",
					visual: { type: "pixels", width, height, pixels },
				};
			}
		}
	} catch (error) {
		operationError = error;
		hasOperationError = true;
		availability.markNativeFailure(error);
	}

	if (colorConvertedBitmap !== 0 && !availability.isPoisoned) {
		try {
			availability.runNative(() => pdfium.FPDFBitmap_Destroy(colorConvertedBitmap));
		} catch (cleanupError) {
			availability.markNativeFailure(cleanupError);
			if (!hasOperationError) {
				operationError = cleanupError;
				hasOperationError = true;
			}
		}
	}

	if (bitmap !== 0 && !availability.isPoisoned) {
		try {
			availability.runNative(() => pdfium.FPDFBitmap_Destroy(bitmap));
		} catch (cleanupError) {
			availability.markNativeFailure(cleanupError);
			if (!hasOperationError) {
				operationError = cleanupError;
				hasOperationError = true;
			}
		}
	}

	if (hasOperationError) throw operationError;
	if (loader.hasMissingChunks) return null;
	return result;
}

function tryConvertThumbnailBitmapToColor(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	bitmap: number,
	width: number,
	height: number,
): number {
	let document = 0;
	let imageObject = 0;
	let renderedBitmap = 0;
	let operationError: unknown;
	let hasOperationError = false;
	try {
		document = availability.runNative(
			() => pdfium.FPDF_CreateNewDocument(),
			(handle) => {
				document = handle;
			},
		);
		if (document !== 0) {
			imageObject = availability.runNative(
				() => pdfium.FPDFPageObj_NewImageObj(document),
				(handle) => {
					imageObject = handle;
				},
			);
			if (imageObject !== 0) {
				const bitmapSet = availability.runNative(() =>
					pdfium.FPDFImageObj_SetBitmap(0, 0, imageObject, bitmap),
				);
				const matrixSet = bitmapSet
					? availability.runNative(() =>
							pdfium.FPDFImageObj_SetMatrix(imageObject, width, 0, 0, height, 0, 0),
						)
					: false;
				if (matrixSet) {
					renderedBitmap = availability.runNative(
						() => pdfium.FPDFImageObj_GetRenderedBitmap(document, 0, imageObject),
						(handle) => {
							renderedBitmap = handle;
						},
					);
				}
			}
		}
	} catch (error) {
		operationError = error;
		hasOperationError = true;
		availability.markNativeFailure(error);
	}

	if (imageObject !== 0 && !availability.isPoisoned) {
		try {
			availability.runNative(() => pdfium.FPDFPageObj_Destroy(imageObject));
		} catch (cleanupError) {
			availability.markNativeFailure(cleanupError);
			if (!hasOperationError) {
				operationError = cleanupError;
				hasOperationError = true;
			}
		}
	}
	if (document !== 0 && !availability.isPoisoned) {
		try {
			availability.runNative(() => pdfium.FPDF_CloseDocument(document));
		} catch (cleanupError) {
			availability.markNativeFailure(cleanupError);
			if (!hasOperationError) {
				operationError = cleanupError;
				hasOperationError = true;
			}
		}
	}

	if (hasOperationError) throw operationError;
	return renderedBitmap;
}
