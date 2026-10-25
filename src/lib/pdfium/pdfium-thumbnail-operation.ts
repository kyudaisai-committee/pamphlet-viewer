// SPDX-License-Identifier: MPL-2.0

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
			const { width, height, stride, sourcePointer, format } = availability.runNative(() => ({
				width: pdfium.FPDFBitmap_GetWidth(bitmap),
				height: pdfium.FPDFBitmap_GetHeight(bitmap),
				stride: pdfium.FPDFBitmap_GetStride(bitmap),
				sourcePointer: pdfium.FPDFBitmap_GetBuffer(bitmap),
				format: pdfium.FPDFBitmap_GetFormat(bitmap),
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
