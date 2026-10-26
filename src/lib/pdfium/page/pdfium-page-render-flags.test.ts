import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { expect, it, vi } from "vitest";

import type { PdfiumAvailabilitySession } from "@/lib/pdfium/document/pdfium-availability-session";
import type { PdfRangeLoader } from "@/lib/pdfium/range/range-loader";

import { PAGE_RENDER_FLAGS, renderPdfiumPage } from "./pdfium-page-operation";
import { combinePdfiumRenderFlags } from "./pdfium-render-flags";

it("passes the composed named flags to the PDFium render call", () => {
	const renderPageBitmap = vi.fn();
	const pdfium = {
		FPDF_LoadPage: vi.fn(() => 2),
		FPDF_ClosePage: vi.fn(),
		FPDF_GetPageWidthF: vi.fn(() => 1),
		FPDF_GetPageHeightF: vi.fn(() => 1),
		FPDFBitmap_Create: vi.fn(() => 3),
		FPDFBitmap_FillRect: vi.fn(),
		FPDF_RenderPageBitmap: renderPageBitmap,
		FPDFBitmap_GetStride: vi.fn(() => 4),
		FPDFBitmap_GetBuffer: vi.fn(() => 1),
		FPDFBitmap_Destroy: vi.fn(),
		pdfium: { HEAPU8: new Uint8Array(8) },
	} as unknown as WrappedPdfiumModule;
	const availability = {
		documentHandle: 1,
		isPoisoned: false,
		runNative<T>(operation: () => T, captureResult?: (result: T) => void): T {
			const result = operation();
			captureResult?.(result);
			return result;
		},
		markNativeFailure() {},
	} as unknown as PdfiumAvailabilitySession;
	const loader = { hasMissingChunks: false } as unknown as PdfRangeLoader;

	renderPdfiumPage(pdfium, availability, loader, 0, 1);

	expect(renderPageBitmap).toHaveBeenCalledWith(
		3,
		2,
		0,
		0,
		1,
		1,
		0,
		combinePdfiumRenderFlags(PAGE_RENDER_FLAGS),
	);
});
