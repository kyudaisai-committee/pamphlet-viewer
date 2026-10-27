// SPDX-License-Identifier: MIT

import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

import type { PdfiumAvailabilitySession } from "@/lib/pdfium/document/pdfium-availability-session";
import type { PdfRangeLoader } from "@/lib/pdfium/range/range-loader";

export function runPdfiumPageOperation<T>(
	pdfium: WrappedPdfiumModule,
	availability: PdfiumAvailabilitySession,
	loader: PdfRangeLoader,
	pageIndex: number,
	operation: (page: number) => T | null,
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
		} else if (!loader.hasMissingChunks) {
			const value = operation(page);
			if (!loader.hasMissingChunks && value !== null) result = value;
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
		throw new Error("PDFium did not complete the page operation.");
	}
	return result;
}
