import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { afterEach, describe, expect, it, vi } from "vitest";

const pdfiumMocks = vi.hoisted(() => ({
	init: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
const rangeLoaderMocks = vi.hoisted(() => ({
	cacheEpoch: 0,
	hasMissingChunks: false,
	fetchMissingChunks: vi.fn<(includeHints?: boolean) => Promise<number>>().mockResolvedValue(0),
}));

vi.mock("@embedpdf/pdfium", () => ({ init: pdfiumMocks.init }));

vi.mock("./range-loader", () => ({
	RANGE_CACHE_LIMIT: 64 * 1024 * 1024,
	PdfRangeLoader: class {
		totalLength: number | null = null;

		get cacheEpoch(): number {
			return rangeLoaderMocks.cacheEpoch;
		}

		get hasMissingChunks(): boolean {
			return rangeLoaderMocks.hasMissingChunks;
		}

		async initialize(): Promise<number> {
			this.totalLength = 256;
			return 256;
		}

		clearRangeHints(): void {}

		async fetchMissingChunks(includeHints?: boolean): Promise<number> {
			return rangeLoaderMocks.fetchMissingChunks(includeHints);
		}

		dispose(): void {}
	},
}));

afterEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	rangeLoaderMocks.cacheEpoch = 0;
	rangeLoaderMocks.hasMissingChunks = false;
	rangeLoaderMocks.fetchMissingChunks.mockReset().mockResolvedValue(0);
});

describe("PdfiumDocumentSession", () => {
	it("retains a cleanup trap after disposal and stays healthy after normal cleanup", async () => {
		const { PdfiumDocumentSession } = await import("./pdfium-document");
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
			FPDFAvail_IsLinearized() {
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

	it("retries page operations after a temporary range failure while reopening", async () => {
		const { PdfiumDocumentSession } = await import("./pdfium-document");
		let nextPointer = 100;
		const heap = new Uint8Array(256);
		const malloc = vi.fn((size: number) => {
			const pointer = nextPointer;
			nextPointer += Math.max(size, 16);
			return pointer;
		});
		const free = vi.fn();
		const loadPage = vi.fn(() => 3);
		const isPageAvailable = vi.fn(() => 1);
		let missFirstSizeRead = true;
		let missFirstThumbnailRead = false;
		const getThumbnail = vi.fn(() => {
			if (missFirstThumbnailRead) {
				missFirstThumbnailRead = false;
				rangeLoaderMocks.hasMissingChunks = true;
				return 0;
			}
			return 5;
		});
		const renderPageBitmap = vi.fn();
		const destroyBitmap = vi.fn();
		const getPageSizeByIndex = vi.fn((_document: number, _pageIndex: number, pointer: number) => {
			if (missFirstSizeRead) {
				missFirstSizeRead = false;
				rangeLoaderMocks.hasMissingChunks = true;
				return false;
			}
			const view = new DataView(heap.buffer);
			view.setFloat32(pointer, 1, true);
			view.setFloat32(pointer + Float32Array.BYTES_PER_ELEMENT, 1, true);
			return true;
		});
		rangeLoaderMocks.fetchMissingChunks.mockImplementationOnce(async () => {
			rangeLoaderMocks.hasMissingChunks = false;
			rangeLoaderMocks.cacheEpoch += 1;
			return 1;
		});
		const pdfium = {
			PDFiumExt_Init() {},
			FPDFAvail_Create() {
				return 1;
			},
			FPDFAvail_Destroy() {},
			FPDFAvail_IsDocAvail() {
				return 1;
			},
			FPDFAvail_IsLinearized() {
				return 1;
			},
			FPDFAvail_GetDocument() {
				return 2;
			},
			FPDFAvail_IsPageAvail: isPageAvailable,
			FPDF_CloseDocument() {},
			FPDF_ClosePage() {},
			FPDF_GetLastError() {
				return 0;
			},
			FPDF_GetPageCount() {
				return 1;
			},
			FPDF_LoadPage: loadPage,
			FPDF_GetPageSizeByIndexF: getPageSizeByIndex,
			FPDF_GetPageWidthF() {
				return 1;
			},
			FPDF_GetPageHeightF() {
				return 1;
			},
			FPDFBitmap_Create() {
				return 4;
			},
			FPDFPage_GetThumbnailAsBitmap: getThumbnail,
			FPDFBitmap_GetWidth() {
				return 1;
			},
			FPDFBitmap_GetHeight() {
				return 1;
			},
			FPDFBitmap_GetFormat() {
				return 4;
			},
			FPDFBitmap_FillRect() {},
			FPDF_RenderPageBitmap: renderPageBitmap,
			FPDFBitmap_GetStride() {
				return 4;
			},
			FPDFBitmap_GetBuffer() {
				return 0;
			},
			FPDFBitmap_Destroy: destroyBitmap,
			pdfium: {
				wasmExports: { malloc, free },
				addFunction() {
					const pointer = nextPointer;
					nextPointer += 1;
					return pointer;
				},
				removeFunction() {},
				setValue() {},
				HEAPU8: heap,
			},
		} as unknown as WrappedPdfiumModule;

		pdfiumMocks.init.mockResolvedValue(pdfium);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new ArrayBuffer(0), { status: 200 })),
		);

		const session = await PdfiumDocumentSession.open(
			"https://example.test/cache-rebuild.pdf",
			"https://example.test/pdfium.wasm",
			new AbortController().signal,
		);
		expect(session.info).toEqual({ pageCount: 1, fileLength: 256 });
		expect(await session.getPageSize(0)).toEqual({ width: 1, height: 1 });
		expect(loadPage).not.toHaveBeenCalled();
		expect(isPageAvailable).not.toHaveBeenCalled();
		expect(getPageSizeByIndex).toHaveBeenCalledTimes(2);
		expect(free).toHaveBeenCalledWith(getPageSizeByIndex.mock.calls[0]?.[2]);
		expect(rangeLoaderMocks.fetchMissingChunks).toHaveBeenCalledOnce();

		rangeLoaderMocks.cacheEpoch = 1;
		rangeLoaderMocks.hasMissingChunks = true;
		rangeLoaderMocks.fetchMissingChunks.mockRejectedValueOnce(
			new Error("PDF range request failed (HTTP 503)."),
		);
		await expect(session.getPageSize(0)).rejects.toThrow("HTTP 503");
		expect(session.info).toEqual({ pageCount: 1, fileLength: 256 });
		expect(rangeLoaderMocks.fetchMissingChunks).toHaveBeenCalledWith(false);

		rangeLoaderMocks.hasMissingChunks = false;
		expect(await session.getPageSize(0)).toEqual({ width: 1, height: 1 });
		expect(loadPage).not.toHaveBeenCalled();
		expect(await session.renderPage(0, 1)).toMatchObject({
			type: "pixels",
			width: 1,
			height: 1,
		});
		rangeLoaderMocks.fetchMissingChunks.mockImplementationOnce(async () => {
			rangeLoaderMocks.hasMissingChunks = false;
			rangeLoaderMocks.cacheEpoch += 1;
			return 1;
		});
		const renderCallsBeforeThumbnail = renderPageBitmap.mock.calls.length;
		const pageAvailabilityCallsBeforeThumbnail = isPageAvailable.mock.calls.length;
		missFirstThumbnailRead = true;
		expect(await session.renderThumbnail(0)).toMatchObject({
			type: "pixels",
			width: 1,
			height: 1,
		});
		expect(getThumbnail).toHaveBeenCalledTimes(2);
		expect(destroyBitmap).toHaveBeenCalledWith(5);
		expect(renderPageBitmap).toHaveBeenCalledTimes(renderCallsBeforeThumbnail);
		expect(isPageAvailable).toHaveBeenCalledTimes(pageAvailabilityCallsBeforeThumbnail + 2);
		expect(session.info).toEqual({ pageCount: 1, fileLength: 256 });
		session.dispose();
	});
});
