import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { afterEach, describe, expect, it, vi } from "vitest";

const pdfiumMocks = vi.hoisted(() => ({
	init: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("@embedpdf/pdfium", () => ({ init: pdfiumMocks.init }));

vi.mock("./range-loader", () => ({
	PdfRangeLoader: class {
		cacheEpoch = 0;
		totalLength: number | null = null;
		hasMissingChunks = false;

		async initialize(): Promise<number> {
			this.totalLength = 256;
			return 256;
		}

		clearRangeHints(): void {}

		async fetchMissingChunks(): Promise<number> {
			return 0;
		}

		dispose(): void {}
	},
}));

import { PdfiumDocumentSession } from "./pdfium-document";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("PdfiumDocumentSession", () => {
	it("retains a cleanup trap after disposal and stays healthy after normal cleanup", async () => {
		let trapOnClose = false;
		let nextPointer = 100;
		const pdfium = {
			PDFiumExt_Init() {},
			FPDFAvail_Create() {
				return 1;
			},
			FPDFAvail_Destroy() {},
			FPDFAvail_IsDocAvail() {
				return 1;
			},
			FPDFAvail_GetDocument() {
				return 2;
			},
			FPDF_CloseDocument() {
				if (trapOnClose) throw new WebAssembly.RuntimeError("cleanup trap");
			},
			FPDF_GetLastError() {
				return 0;
			},
			FPDF_GetPageCount() {
				return 1;
			},
			pdfium: {
				wasmExports: {
					malloc() {
						const pointer = nextPointer;
						nextPointer += 16;
						return pointer;
					},
					free() {},
				},
				addFunction() {
					const pointer = nextPointer;
					nextPointer += 1;
					return pointer;
				},
				removeFunction() {},
				setValue() {},
				HEAPU8: new Uint8Array(256),
			},
		} as unknown as WrappedPdfiumModule;

		pdfiumMocks.init.mockResolvedValue(pdfium);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new ArrayBuffer(0), { status: 200 })),
		);

		const normalSession = await PdfiumDocumentSession.open(
			"https://example.test/normal.pdf",
			"https://example.test/pdfium.wasm",
			new AbortController().signal,
		);
		expect(normalSession.isPoisoned).toBe(false);
		normalSession.dispose();
		expect(normalSession.isPoisoned).toBe(false);

		trapOnClose = true;
		const trappedSession = await PdfiumDocumentSession.open(
			"https://example.test/trapped.pdf",
			"https://example.test/pdfium.wasm",
			new AbortController().signal,
		);
		expect(trappedSession.isPoisoned).toBe(false);
		trappedSession.dispose();
		expect(trappedSession.isPoisoned).toBe(true);
		trappedSession.dispose();
		expect(trappedSession.isPoisoned).toBe(true);
	});
});
