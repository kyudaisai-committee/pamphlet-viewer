import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { afterEach, describe, expect, it, vi } from "vitest";

const startupMocks = vi.hoisted(() => ({
	init: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	rangeInitialize: vi.fn<() => Promise<number>>(),
	rangeDispose: vi.fn(),
}));

vi.mock("@embedpdf/pdfium", () => ({ init: startupMocks.init }));

vi.mock("@/lib/pdfium/range/range-loader", () => ({
	RANGE_CACHE_LIMIT: 64 * 1024 * 1024,
	PdfRangeLoader: class {
		cacheEpoch = 0;
		totalLength: number | null = null;
		hasMissingChunks = false;

		async initialize(): Promise<number> {
			this.totalLength = await startupMocks.rangeInitialize();
			return this.totalLength;
		}

		clearRangeHints(): void {}

		async fetchMissingChunks(): Promise<number> {
			return 0;
		}

		dispose(): void {
			startupMocks.rangeDispose();
		}
	},
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("PdfiumDocumentSession startup", () => {
	it("starts the first byte range and WebAssembly load concurrently", async () => {
		vi.resetModules();
		startupMocks.init.mockReset();
		startupMocks.rangeInitialize.mockReset();
		startupMocks.rangeDispose.mockReset();

		const range = createDeferred<number>();
		const pdfiumInitialization = createDeferred<unknown>();
		startupMocks.rangeInitialize.mockReturnValue(range.promise);
		startupMocks.init.mockReturnValue(pdfiumInitialization.promise);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([0]), { status: 200 })),
		);

		const { PdfiumDocumentSession } = await import("./pdfium-document");
		const { pdfium, createAvailability } = createPdfiumMock();
		const opening = PdfiumDocumentSession.open(
			"https://example.test/document.pdf",
			"https://example.test/pdfium.wasm",
			new AbortController().signal,
		);
		await vi.waitFor(() => {
			expect(startupMocks.rangeInitialize).toHaveBeenCalledOnce();
			expect(startupMocks.init).toHaveBeenCalledOnce();
		});

		pdfiumInitialization.resolve(pdfium);
		await vi.waitFor(() => expect(pdfium.PDFiumExt_Init).toHaveBeenCalledOnce());
		expect(createAvailability).not.toHaveBeenCalled();

		range.resolve(256);
		const session = await opening;
		expect(session.info).toEqual({ pageCount: 1, fileLength: 256 });
		expect(createAvailability).toHaveBeenCalledOnce();
		session.dispose();
	});

	it("does not start range or WebAssembly loads when already cancelled", async () => {
		vi.resetModules();
		startupMocks.init.mockReset();
		startupMocks.rangeInitialize.mockReset();
		startupMocks.rangeDispose.mockReset();

		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { PdfiumDocumentSession } = await import("./pdfium-document");
		const controller = new AbortController();
		controller.abort();

		await expect(
			PdfiumDocumentSession.open(
				"https://example.test/document.pdf",
				"https://example.test/pdfium.wasm",
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(startupMocks.rangeInitialize).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("handles a late range rejection after WebAssembly startup fails", async () => {
		vi.resetModules();
		startupMocks.init.mockReset();
		startupMocks.rangeInitialize.mockReset();
		startupMocks.rangeDispose.mockReset();

		const range = createDeferred<number>();
		startupMocks.rangeInitialize.mockReturnValue(range.promise);
		startupMocks.init.mockRejectedValue(new Error("WASM initialization failed."));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([0]), { status: 200 })),
		);

		const { PdfiumDocumentSession } = await import("./pdfium-document");
		const opening = PdfiumDocumentSession.open(
			"https://example.test/document.pdf",
			"https://example.test/pdfium.wasm",
			new AbortController().signal,
		);
		await expect(opening).rejects.toThrow("WASM initialization failed");
		expect(startupMocks.rangeDispose).toHaveBeenCalledOnce();
		range.reject(new Error("Late range failure."));
		await Promise.resolve();
		await Promise.resolve();
	});
});

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
} {
	let resolve: (value: T) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createPdfiumMock(): {
	pdfium: WrappedPdfiumModule;
	createAvailability: ReturnType<typeof vi.fn>;
} {
	let nextPointer = 100;
	const createAvailability = vi.fn(() => 1);
	const pdfium = {
		PDFiumExt_Init: vi.fn(),
		FPDFAvail_Create: createAvailability,
		FPDFAvail_Destroy: vi.fn(),
		FPDFAvail_IsDocAvail: vi.fn(() => 1),
		FPDFAvail_IsLinearized: vi.fn(() => 1),
		FPDFAvail_GetDocument: vi.fn(() => 2),
		FPDFAvail_IsPageAvail: vi.fn(() => 1),
		FPDF_CloseDocument: vi.fn(),
		FPDF_GetLastError: vi.fn(() => 0),
		FPDF_GetPageCount: vi.fn(() => 1),
		pdfium: {
			wasmExports: {
				malloc() {
					const pointer = nextPointer;
					nextPointer += 16;
					return pointer;
				},
				free: vi.fn(),
			},
			addFunction() {
				const pointer = nextPointer;
				nextPointer += 1;
				return pointer;
			},
			removeFunction: vi.fn(),
			setValue: vi.fn(),
			HEAPU8: new Uint8Array(256),
		},
	} as unknown as WrappedPdfiumModule;
	return { pdfium, createAvailability };
}
