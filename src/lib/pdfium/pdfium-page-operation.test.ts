import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { describe, expect, it, vi } from "vitest";

import type { PdfiumAvailabilitySession } from "./pdfium-availability-session";
import { getPageSizeByIndex } from "./pdfium-page-operation";
import type { PdfRangeLoader } from "./range-loader";

interface FixtureOptions {
	width?: number;
	height?: number;
	getSizeResult?: boolean;
	missingRange?: boolean;
	trap?: boolean;
	allocation?: number;
}

describe("PDFium page-size lookup", () => {
	it("reads indexed dimensions without loading the page and frees its output buffer", () => {
		const fixture = createFixture();

		expect(getPageSizeByIndex(fixture.pdfium, fixture.availability, fixture.loader, 7)).toEqual({
			width: 300,
			height: 400,
		});
		expect(fixture.pdfium.FPDF_LoadPage).not.toHaveBeenCalled();
		expect(fixture.getPageSize).toHaveBeenCalledWith(1, 7, 16);
		expect(fixture.malloc).toHaveBeenCalledWith(8);
		expect(fixture.free).toHaveBeenCalledWith(16);
	});

	it.each([
		[0, 400],
		[Number.NaN, 400],
		[300, 0],
	])("rejects invalid page dimensions %s × %s and releases the buffer", (width, height) => {
		const fixture = createFixture({ width, height });

		expect(() =>
			getPageSizeByIndex(fixture.pdfium, fixture.availability, fixture.loader, 0),
		).toThrow("invalid page dimensions");
		expect(fixture.free).toHaveBeenCalledWith(16);
	});

	it("rejects an unsuccessful size response when no range is missing", () => {
		const fixture = createFixture({ getSizeResult: false });

		expect(() =>
			getPageSizeByIndex(fixture.pdfium, fixture.availability, fixture.loader, 0),
		).toThrow("could not get the size");
		expect(fixture.free).toHaveBeenCalledWith(16);
	});

	it("discards an unsuccessful size response while a range is missing", () => {
		const fixture = createFixture({ getSizeResult: false, missingRange: true });

		expect(getPageSizeByIndex(fixture.pdfium, fixture.availability, fixture.loader, 0)).toBeNull();
		expect(fixture.free).toHaveBeenCalledWith(16);
	});

	it("does not free PDFium memory after a fatal native trap", () => {
		const fixture = createFixture({ trap: true });

		expect(() =>
			getPageSizeByIndex(fixture.pdfium, fixture.availability, fixture.loader, 0),
		).toThrow(WebAssembly.RuntimeError);
		expect(fixture.isPoisoned()).toBe(true);
		expect(fixture.free).not.toHaveBeenCalled();
	});

	it("rejects a failed output allocation without calling PDFium", () => {
		const fixture = createFixture({ allocation: 0 });

		expect(() =>
			getPageSizeByIndex(fixture.pdfium, fixture.availability, fixture.loader, 0),
		).toThrow("could not allocate page-size output memory");
		expect(fixture.getPageSize).not.toHaveBeenCalled();
		expect(fixture.free).not.toHaveBeenCalled();
	});
});

function createFixture(options: FixtureOptions = {}): {
	pdfium: WrappedPdfiumModule;
	availability: PdfiumAvailabilitySession;
	loader: PdfRangeLoader;
	getPageSize: ReturnType<typeof vi.fn>;
	malloc: ReturnType<typeof vi.fn>;
	free: ReturnType<typeof vi.fn>;
	isPoisoned: () => boolean;
} {
	const heap = new Uint8Array(128);
	let poisoned = false;
	let missing = options.missingRange ?? false;
	const malloc = vi.fn(() => options.allocation ?? 16);
	const free = vi.fn();
	const getPageSize = vi.fn((_document: number, _pageIndex: number, pointer: number) => {
		if (options.trap === true) throw new WebAssembly.RuntimeError("page-size trap");
		if (options.missingRange === true) missing = true;
		new DataView(heap.buffer).setFloat32(pointer, options.width ?? 300, true);
		new DataView(heap.buffer).setFloat32(
			pointer + Float32Array.BYTES_PER_ELEMENT,
			options.height ?? 400,
			true,
		);
		return options.getSizeResult ?? true;
	});
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
		FPDF_LoadPage: vi.fn(() => 2),
		FPDF_GetPageSizeByIndexF: getPageSize,
		pdfium: { wasmExports: { malloc, free }, HEAPU8: heap },
	} as unknown as WrappedPdfiumModule;

	return { pdfium, availability, loader, getPageSize, malloc, free, isPoisoned: () => poisoned };
}
