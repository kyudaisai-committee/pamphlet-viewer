import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";

import { PdfRangeLoader } from "./range-loader";

const FILE_ACCESS_SIZE = 12;
const MAX_RENDER_PIXELS = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 32;

interface RenderRequest {
	id: number;
	type: "render";
	url: string;
	pageIndex: number;
}

interface RenderedPdfPage {
	pageCount: number;
	pageIndex: number;
	width: number;
	height: number;
	pixels: ArrayBuffer;
	fileLength: number;
}

interface RenderResponse {
	id: number;
	type: "rendered";
	page: RenderedPdfPage;
}

interface ErrorResponse {
	id: number;
	type: "error";
	message: string;
}

type WorkerResponse = RenderResponse | ErrorResponse;
type FileReadCallback = (
	parameter: number,
	position: number,
	buffer: number,
	size: number,
) => number;

interface WorkerScope {
	addEventListener(type: "message", listener: (event: MessageEvent<RenderRequest>) => void): void;
	postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

type RenderAttempt = { type: "success"; page: RenderedPdfPage } | { type: "missing" };

const workerScope = self as unknown as WorkerScope;
let pdfiumPromise: Promise<WrappedPdfiumModule> | null = null;

workerScope.addEventListener("message", function handleMessage(event) {
	void processRequest(event.data);
});

async function processRequest(request: RenderRequest): Promise<void> {
	try {
		const page = await renderPdfPage(request.url, request.pageIndex);
		const response: RenderResponse = { id: request.id, type: "rendered", page };
		workerScope.postMessage(response, [page.pixels]);
	} catch (error) {
		const response: ErrorResponse = {
			id: request.id,
			type: "error",
			message: error instanceof Error ? error.message : "PDF rendering failed.",
		};
		workerScope.postMessage(response);
	}
}

async function renderPdfPage(url: string, pageIndex: number): Promise<RenderedPdfPage> {
	if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
		throw new RangeError("Page index must be a non-negative integer.");
	}

	const controller = new AbortController();
	const loader = new PdfRangeLoader(url, controller.signal);
	const fileLength = await loader.initialize();
	const pdfium = await getPdfium();

	for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
		const attempt = renderPageAttempt(pdfium, loader, fileLength, pageIndex);
		if (attempt.type === "success") return attempt.page;
		await loader.fetchMissingChunks();
	}

	throw new Error("The PDF requires more ranges than the safe retry limit allows.");
}

function renderPageAttempt(
	pdfium: WrappedPdfiumModule,
	loader: PdfRangeLoader,
	fileLength: number,
	pageIndex: number,
): RenderAttempt {
	const fileAccess = pdfium.pdfium.wasmExports.malloc(FILE_ACCESS_SIZE);
	if (fileAccess === 0) throw new Error("Could not allocate PDFium file access data.");

	let callbackPointer: number | null = null;
	let document: number | null = null;
	let page: number | null = null;
	let bitmap: number | null = null;
	let callbackError: Error | null = null;

	const readBlock: FileReadCallback = function readBlockCallback(
		_parameter,
		position,
		buffer,
		size,
	): number {
		try {
			return loader.readInto(position, getPdfiumHeap(pdfium), buffer, size) ? 1 : 0;
		} catch (error) {
			callbackError =
				error instanceof Error ? error : new Error("PDFium requested an invalid range.");
			return 0;
		}
	};

	try {
		callbackPointer = pdfium.pdfium.addFunction(readBlock, "iiiii");
		pdfium.pdfium.setValue(fileAccess, fileLength, "i32");
		pdfium.pdfium.setValue(fileAccess + 4, callbackPointer, "i32");
		pdfium.pdfium.setValue(fileAccess + 8, 0, "i32");

		document = pdfium.FPDF_LoadCustomDocument(fileAccess, "");
		if (document === 0) return missingOrThrow(loader, callbackError, pdfium);
		if (loader.hasMissingChunks) return { type: "missing" };

		const pageCount = pdfium.FPDF_GetPageCount(document);
		if (loader.hasMissingChunks) return { type: "missing" };
		if (pageIndex >= pageCount) {
			throw new RangeError(`Page ${pageIndex + 1} is outside the ${pageCount}-page document.`);
		}

		page = pdfium.FPDF_LoadPage(document, pageIndex);
		if (page === 0) return missingOrThrow(loader, callbackError, pdfium);
		if (loader.hasMissingChunks) return { type: "missing" };

		const width = Math.ceil(pdfium.FPDF_GetPageWidthF(page));
		const height = Math.ceil(pdfium.FPDF_GetPageHeightF(page));
		if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
			throw new Error("PDFium returned invalid page dimensions.");
		}
		if (width * height > MAX_RENDER_PIXELS) {
			throw new Error("The requested PDF page exceeds the rendering memory limit.");
		}

		bitmap = pdfium.FPDFBitmap_Create(width, height, 1);
		if (bitmap === 0) throw new Error("PDFium could not allocate the page bitmap.");
		pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
		pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0);
		if (loader.hasMissingChunks) return { type: "missing" };

		const stride = pdfium.FPDFBitmap_GetStride(bitmap);
		const sourcePointer = pdfium.FPDFBitmap_GetBuffer(bitmap);
		const heap = getPdfiumHeap(pdfium);
		const source = heap.subarray(sourcePointer, sourcePointer + stride * height);
		const pixels = convertBgraToRgba(source, width, height, stride);
		const transferablePixels = new ArrayBuffer(pixels.byteLength);
		new Uint8Array(transferablePixels).set(pixels);
		return {
			type: "success",
			page: { pageCount, pageIndex, width, height, pixels: transferablePixels, fileLength },
		};
	} finally {
		if (bitmap !== null) pdfium.FPDFBitmap_Destroy(bitmap);
		if (page !== null) pdfium.FPDF_ClosePage(page);
		if (document !== null) pdfium.FPDF_CloseDocument(document);
		if (callbackPointer !== null) pdfium.pdfium.removeFunction(callbackPointer);
		pdfium.pdfium.wasmExports.free(fileAccess);
	}
}

function missingOrThrow(
	loader: PdfRangeLoader,
	callbackError: Error | null,
	pdfium: WrappedPdfiumModule,
): RenderAttempt {
	if (callbackError !== null) throw callbackError;
	if (loader.hasMissingChunks) return { type: "missing" };
	throw new Error(`PDFium could not open the document (error ${pdfium.FPDF_GetLastError()}).`);
}

function convertBgraToRgba(
	source: Uint8Array,
	width: number,
	height: number,
	stride: number,
): Uint8ClampedArray {
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let row = 0; row < height; row += 1) {
		for (let column = 0; column < width; column += 1) {
			const sourceOffset = row * stride + column * 4;
			const targetOffset = (row * width + column) * 4;
			pixels[targetOffset] = source[sourceOffset + 2];
			pixels[targetOffset + 1] = source[sourceOffset + 1];
			pixels[targetOffset + 2] = source[sourceOffset];
			pixels[targetOffset + 3] = source[sourceOffset + 3];
		}
	}
	return pixels;
}

function getPdfiumHeap(pdfium: WrappedPdfiumModule): Uint8Array {
	const runtime = pdfium.pdfium as WrappedPdfiumModule["pdfium"] & { HEAPU8: Uint8Array };
	return runtime.HEAPU8;
}

function getPdfium(): Promise<WrappedPdfiumModule> {
	if (pdfiumPromise !== null) return pdfiumPromise;

	pdfiumPromise = loadPdfium();
	return pdfiumPromise;
}

async function loadPdfium(): Promise<WrappedPdfiumModule> {
	const response = await fetch(wasmUrl);
	if (!response.ok) throw new Error(`Could not load PDFium WebAssembly (HTTP ${response.status}).`);
	const wasmBinary = await response.arrayBuffer();
	const pdfium = await init({ wasmBinary });
	pdfium.PDFiumExt_Init();
	return pdfium;
}
