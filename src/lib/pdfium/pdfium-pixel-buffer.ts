// SPDX-License-Identifier: MPL-2.0

const PIXEL_BYTES = 4;
const MAX_THUMBNAIL_PIXELS = 160_000;

const PDFIUM_BITMAP_GRAY = 1;
const PDFIUM_BITMAP_BGR = 2;
const PDFIUM_BITMAP_BGRX = 3;
const PDFIUM_BITMAP_BGRA = 4;
const PDFIUM_BITMAP_BGRA_PREMUL = 5;

export function copyRgbaBitmapPixels(
	heap: Uint8Array,
	sourcePointer: number,
	width: number,
	height: number,
	stride: number,
): ArrayBuffer {
	const rowBytes = width * PIXEL_BYTES;
	const pixelBytes = rowBytes * height;
	if (
		!Number.isSafeInteger(sourcePointer) ||
		sourcePointer < 0 ||
		!Number.isSafeInteger(width) ||
		width < 1 ||
		!Number.isSafeInteger(height) ||
		height < 1 ||
		!Number.isSafeInteger(rowBytes) ||
		rowBytes < 1 ||
		!Number.isSafeInteger(pixelBytes) ||
		pixelBytes < 1 ||
		!Number.isSafeInteger(stride) ||
		stride < rowBytes
	) {
		throw new Error("PDFium returned an invalid bitmap buffer.");
	}

	const lastRowStart = sourcePointer + (height - 1) * stride;
	const sourceEnd = lastRowStart + rowBytes;
	if (
		!Number.isSafeInteger(lastRowStart) ||
		!Number.isSafeInteger(sourceEnd) ||
		sourceEnd > heap.byteLength
	) {
		throw new Error("PDFium returned an invalid bitmap buffer.");
	}

	const pixels = new Uint8Array(pixelBytes);
	for (let row = 0; row < height; row += 1) {
		const sourceStart = sourcePointer + row * stride;
		pixels.set(heap.subarray(sourceStart, sourceStart + rowBytes), row * rowBytes);
	}
	return pixels.buffer;
}

export function copyPdfiumThumbnailPixels(
	heap: Uint8Array,
	sourcePointer: number,
	width: number,
	height: number,
	stride: number,
	format: number,
): ArrayBuffer {
	const bytesPerPixel = getPdfiumBitmapBytesPerPixel(format);
	const rowBytes = width * bytesPerPixel;
	const pixelCount = width * height;
	if (
		!Number.isSafeInteger(sourcePointer) ||
		sourcePointer < 0 ||
		!Number.isSafeInteger(width) ||
		width < 1 ||
		!Number.isSafeInteger(height) ||
		height < 1 ||
		!Number.isSafeInteger(rowBytes) ||
		!Number.isSafeInteger(pixelCount) ||
		pixelCount > MAX_THUMBNAIL_PIXELS ||
		!Number.isSafeInteger(stride) ||
		stride < rowBytes
	) {
		throw new Error("PDFium returned an invalid thumbnail bitmap.");
	}

	const sourceEnd = sourcePointer + (height - 1) * stride + rowBytes;
	if (!Number.isSafeInteger(sourceEnd) || sourceEnd > heap.byteLength) {
		throw new Error("PDFium returned an invalid thumbnail bitmap.");
	}

	const pixels = new Uint8Array(pixelCount * PIXEL_BYTES);
	for (let row = 0; row < height; row += 1) {
		for (let column = 0; column < width; column += 1) {
			const sourceOffset = sourcePointer + row * stride + column * bytesPerPixel;
			const targetOffset = (row * width + column) * PIXEL_BYTES;
			writeRgbaPixel(pixels, targetOffset, heap, sourceOffset, format);
		}
	}
	return pixels.buffer;
}

function getPdfiumBitmapBytesPerPixel(format: number): number {
	switch (format) {
		case PDFIUM_BITMAP_GRAY:
			return 1;
		case PDFIUM_BITMAP_BGR:
			return 3;
		case PDFIUM_BITMAP_BGRX:
		case PDFIUM_BITMAP_BGRA:
		case PDFIUM_BITMAP_BGRA_PREMUL:
			return 4;
		default:
			throw new Error("PDFium returned an unsupported thumbnail bitmap format.");
	}
}

function writeRgbaPixel(
	pixels: Uint8Array,
	targetOffset: number,
	heap: Uint8Array,
	sourceOffset: number,
	format: number,
): void {
	if (format === PDFIUM_BITMAP_GRAY) {
		const gray = heap[sourceOffset] ?? 0;
		pixels[targetOffset] = gray;
		pixels[targetOffset + 1] = gray;
		pixels[targetOffset + 2] = gray;
		pixels[targetOffset + 3] = 255;
		return;
	}

	const blue = heap[sourceOffset] ?? 0;
	const green = heap[sourceOffset + 1] ?? 0;
	const red = heap[sourceOffset + 2] ?? 0;
	const alpha =
		format === PDFIUM_BITMAP_BGRA || format === PDFIUM_BITMAP_BGRA_PREMUL
			? (heap[sourceOffset + 3] ?? 0)
			: 255;
	if (format === PDFIUM_BITMAP_BGRA_PREMUL && alpha > 0) {
		pixels[targetOffset] = unpremultiply(red, alpha);
		pixels[targetOffset + 1] = unpremultiply(green, alpha);
		pixels[targetOffset + 2] = unpremultiply(blue, alpha);
	} else {
		pixels[targetOffset] = alpha === 0 ? 0 : red;
		pixels[targetOffset + 1] = alpha === 0 ? 0 : green;
		pixels[targetOffset + 2] = alpha === 0 ? 0 : blue;
	}
	pixels[targetOffset + 3] = alpha;
}

function unpremultiply(channel: number, alpha: number): number {
	return Math.min(255, Math.round((channel * 255) / alpha));
}
