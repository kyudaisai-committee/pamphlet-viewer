// SPDX-License-Identifier: MIT

import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { describe, expect, it, vi } from "vitest";

import type { PdfiumAvailabilitySession } from "./pdfium-availability-session";
import { renderPdfiumPage } from "./pdfium-page-operation";
import type { PdfRangeLoader } from "./range-loader";

type ReadMissPhase = "load" | "size" | "render";

interface FixtureOptions {
	readMissPhase?: ReadMissPhase;
	renderTrap?: boolean;
}

describe("PDFium page rendering", () => {
	it.each([
		["page load", "load"],
		["page dimensions", "size"],
		["page render", "render"],
	] as const)("skips the remaining raster work after a read miss during %s", (_label, phase) => {
		const fixture = createFixture({ readMissPhase: phase });

		expect(renderPdfiumPage(fixture.pdfium, fixture.availability, fixture.loader, 0, 1)).toBeNull();
		expect(fixture.closePage).toHaveBeenCalledWith(2);
		expect(fixture.isPoisoned()).toBe(false);
		if (phase === "load" || phase === "size") {
			expect(fixture.createBitmap).not.toHaveBeenCalled();
		}
		if (phase === "load") {
			expect(fixture.getPageWidth).not.toHaveBeenCalled();
			expect(fixture.renderPageBitmap).not.toHaveBeenCalled();
		}
		if (phase === "size") {
			expect(fixture.getPageWidth).toHaveBeenCalledOnce();
			expect(fixture.renderPageBitmap).not.toHaveBeenCalled();
		}
		if (phase === "render") {
			expect(fixture.renderPageBitmap).toHaveBeenCalledOnce();
			expect(fixture.getStride).not.toHaveBeenCalled();
			expect(fixture.getBuffer).not.toHaveBeenCalled();
			expect(fixture.destroyBitmap).toHaveBeenCalledWith(3);
		}
	});

	it("preserves native-trap cleanup behavior", () => {
		const fixture = createFixture({ renderTrap: true });

		expect(() =>
			renderPdfiumPage(fixture.pdfium, fixture.availability, fixture.loader, 0, 1),
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
	closePage: ReturnType<typeof vi.fn>;
	getPageWidth: ReturnType<typeof vi.fn>;
	createBitmap: ReturnType<typeof vi.fn>;
	renderPageBitmap: ReturnType<typeof vi.fn>;
	getStride: ReturnType<typeof vi.fn>;
	getBuffer: ReturnType<typeof vi.fn>;
	destroyBitmap: ReturnType<typeof vi.fn>;
	isPoisoned: () => boolean;
} {
	let missing = false;
	let poisoned = false;
	const closePage = vi.fn();
	const getPageWidth = vi.fn(() => {
		if (options.readMissPhase === "size") missing = true;
		return 300;
	});
	const createBitmap = vi.fn(() => 3);
	const renderPageBitmap = vi.fn(() => {
		if (options.renderTrap === true) throw new WebAssembly.RuntimeError("render trap");
		if (options.readMissPhase === "render") missing = true;
	});
	const getStride = vi.fn(() => 4);
	const getBuffer = vi.fn(() => 0);
	const destroyBitmap = vi.fn();
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
	const loader = {
		get hasMissingChunks() {
			return missing;
		},
	} as unknown as PdfRangeLoader;
	const pdfium = {
		FPDF_LoadPage: vi.fn(() => {
			if (options.readMissPhase === "load") missing = true;
			return 2;
		}),
		FPDF_GetLastError: vi.fn(() => 0),
		FPDF_ClosePage: closePage,
		FPDF_GetPageWidthF: getPageWidth,
		FPDF_GetPageHeightF: vi.fn(() => 200),
		FPDFBitmap_Create: createBitmap,
		FPDFBitmap_FillRect: vi.fn(),
		FPDF_RenderPageBitmap: renderPageBitmap,
		FPDFBitmap_GetStride: getStride,
		FPDFBitmap_GetBuffer: getBuffer,
		FPDFBitmap_Destroy: destroyBitmap,
		pdfium: { HEAPU8: new Uint8Array(16) },
	} as unknown as WrappedPdfiumModule;

	return {
		pdfium,
		availability,
		loader,
		closePage,
		getPageWidth,
		createBitmap,
		renderPageBitmap,
		getStride,
		getBuffer,
		destroyBitmap,
		isPoisoned: () => poisoned,
	};
}
