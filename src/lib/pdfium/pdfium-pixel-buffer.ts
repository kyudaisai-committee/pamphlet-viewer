// SPDX-License-Identifier: MPL-2.0

const PIXEL_BYTES = 4;

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
