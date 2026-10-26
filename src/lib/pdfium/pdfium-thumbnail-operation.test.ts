// SPDX-License-Identifier: MIT

import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { describe, expect, it, vi } from "vitest";

import type { PdfiumAvailabilitySession } from "./pdfium-availability-session";
import { getPdfiumThumbnailByIndex } from "./pdfium-thumbnail-operation";
import type { PdfRangeLoader } from "./range-loader";

interface FixtureOptions {
	thumbnailBitmap?: number;
	missDuringThumbnail?: boolean;
	trap?: boolean;
	format?: number;
}

describe("PDFium embedded thumbnail extraction", () => {
	it("returns embedded pixels without rendering the page and releases both native handles", () => {
		const fixture = createFixture();

		expect(
			getPdfiumThumbnailByIndex(fixture.pdfium, fixture.availability, fixture.loader, 0),
		).toEqual({
			type: "visual",
			visual: {
				type: "pixels",
				width: 1,
				height: 1,
				pixels: new Uint8Array([10, 20, 30, 40]).buffer,
			},
		});
		expect(fixture.renderPageBitmap).not.toHaveBeenCalled();
		expect(fixture.destroyBitmap).toHaveBeenCalledWith(3);
		expect(fixture.closePage).toHaveBeenCalledWith(2);
	});

	it("reports no embedded image only after all thumbnail reads are available", () => {
		const absent = createFixture({ thumbnailBitmap: 0 });
		expect(getPdfiumThumbnailByIndex(absent.pdfium, absent.availability, absent.loader, 0)).toEqual(
			{ type: "none" },
		);
		expect(absent.closePage).toHaveBeenCalledWith(2);

		const missing = createFixture({ thumbnailBitmap: 0, missDuringThumbnail: true });
		expect(
			getPdfiumThumbnailByIndex(missing.pdfium, missing.availability, missing.loader, 0),
		).toBeNull();
		expect(missing.closePage).toHaveBeenCalledWith(2);
	});

	it("cleans up an unusable bitmap so the caller can fall back to page rendering", () => {
		const fixture = createFixture({ format: 0 });

		expect(() =>
			getPdfiumThumbnailByIndex(fixture.pdfium, fixture.availability, fixture.loader, 0),
		).toThrow("unsupported thumbnail bitmap format");
		expect(fixture.destroyBitmap).toHaveBeenCalledWith(3);
		expect(fixture.closePage).toHaveBeenCalledWith(2);
	});

	it("preserves fatal native traps and skips unsafe handle cleanup", () => {
		const fixture = createFixture({ trap: true });

		expect(() =>
			getPdfiumThumbnailByIndex(fixture.pdfium, fixture.availability, fixture.loader, 0),
		).toThrow(WebAssembly.RuntimeError);
		expect(fixture.isPoisoned()).toBe(true);
		expect(fixture.destroyBitmap).not.toHaveBeenCalled();
		expect(fixture.closePage).not.toHaveBeenCalled();
	});
});

function createFixture(options: FixtureOptions = {}): {
	pdfium: WrappedPdfiumModule;
	availability: PdfiumAvailabilitySession;
	loader: PdfRangeLoader;
	renderPageBitmap: ReturnType<typeof vi.fn>;
	destroyBitmap: ReturnType<typeof vi.fn>;
	closePage: ReturnType<typeof vi.fn>;
	isPoisoned: () => boolean;
} {
	let poisoned = false;
	const heap = new Uint8Array([30, 20, 10, 40]);
	const renderPageBitmap = vi.fn();
	const destroyBitmap = vi.fn();
	const closePage = vi.fn();
	const availability = {
		documentHandle: 1,
		get isPoisoned() {
			return poisoned;
		},
		runNative<T>(operation: () => T): T {
			try {
				return operation();
			} catch (error) {
				if (error instanceof WebAssembly.RuntimeError) poisoned = true;
				throw error;
			}
		},
		markNativeFailure(error: unknown) {
			if (error instanceof WebAssembly.RuntimeError) poisoned = true;
		},
	} as unknown as PdfiumAvailabilitySession;
	let missing = false;
	const loader = {
		get hasMissingChunks() {
			return missing;
		},
	} as unknown as PdfRangeLoader;
	const pdfium = {
		FPDF_LoadPage: vi.fn(() => 2),
		FPDF_GetLastError: vi.fn(() => 0),
		FPDF_ClosePage: closePage,
		FPDFPage_GetThumbnailAsBitmap: vi.fn(() => {
			if (options.trap === true) throw new WebAssembly.RuntimeError("thumbnail trap");
			if (options.missDuringThumbnail === true) missing = true;
			return options.thumbnailBitmap ?? 3;
		}),
		FPDFBitmap_GetWidth: vi.fn(() => 1),
		FPDFBitmap_GetHeight: vi.fn(() => 1),
		FPDFBitmap_GetStride: vi.fn(() => 4),
		FPDFBitmap_GetBuffer: vi.fn(() => 0),
		FPDFBitmap_GetFormat: vi.fn(() => options.format ?? 4),
		FPDFBitmap_Destroy: destroyBitmap,
		FPDF_RenderPageBitmap: renderPageBitmap,
		pdfium: { HEAPU8: heap },
	} as unknown as WrappedPdfiumModule;

	return {
		pdfium,
		availability,
		loader,
		renderPageBitmap,
		destroyBitmap,
		closePage,
		isPoisoned: () => poisoned,
	};
}
