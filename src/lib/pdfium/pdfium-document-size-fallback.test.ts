import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { afterEach, expect, it, vi } from "vitest";

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

it("rechecks page availability after a fallback read miss rebuilds native state without eviction", async () => {
	const { PdfiumDocumentSession } = await import("./pdfium-document");
	let nextPointer = 100;
	let firstPageLoad = true;
	const heap = new Uint8Array(256);
	const loadPage = vi.fn(() => {
		if (firstPageLoad) {
			firstPageLoad = false;
			rangeLoaderMocks.hasMissingChunks = true;
		}
		return 3;
	});
	const isPageAvailable = vi.fn(() => 1);
	const fetchMissingChunks = rangeLoaderMocks.fetchMissingChunks.mockImplementation(async () => {
		rangeLoaderMocks.hasMissingChunks = false;
		return 1;
	});
	const createBitmap = vi.fn(() => 4);
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
		FPDF_GetPageSizeByIndexF() {
			return false;
		},
		FPDF_GetPageWidthF() {
			return 1;
		},
		FPDF_GetPageHeightF() {
			return 1;
		},
		FPDFBitmap_Create: createBitmap,
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
			HEAPU8: heap,
		},
	} as unknown as WrappedPdfiumModule;

	pdfiumMocks.init.mockResolvedValue(pdfium);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new ArrayBuffer(0), { status: 200 })),
	);

	const session = await PdfiumDocumentSession.open(
		"https://example.test/linearized.pdf",
		"https://example.test/pdfium.wasm",
		new AbortController().signal,
	);
	try {
		expect(await session.getPageSize(0)).toEqual({ width: 1, height: 1 });
		expect(rangeLoaderMocks.cacheEpoch).toBe(0);
		expect(fetchMissingChunks).toHaveBeenCalledOnce();
		expect(fetchMissingChunks).toHaveBeenCalledWith(false);
		expect(isPageAvailable).toHaveBeenCalledTimes(2);
		expect(loadPage).toHaveBeenCalledTimes(2);
		expect(createBitmap).not.toHaveBeenCalled();
	} finally {
		session.dispose();
	}
});
