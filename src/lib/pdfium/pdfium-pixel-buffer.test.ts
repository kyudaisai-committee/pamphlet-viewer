import { describe, expect, it } from "vitest";

import { copyPdfiumThumbnailPixels, copyRgbaBitmapPixels } from "./pdfium-pixel-buffer";

describe("PDFium RGBA bitmap copying", () => {
	it("packs rows without padding into an independent pixel buffer", () => {
		const heap = new Uint8Array([
			0, 0, 0, 0, 11, 12, 13, 14, 21, 22, 23, 24, 90, 90, 90, 90, 31, 32, 33, 34, 41, 42, 43, 44,
		]);
		const output = copyRgbaBitmapPixels(heap, 4, 2, 2, 12);

		expect(Array.from(new Uint8Array(output))).toEqual([
			11, 12, 13, 14, 21, 22, 23, 24, 31, 32, 33, 34, 41, 42, 43, 44,
		]);
		heap.fill(0);
		expect(new Uint8Array(output)[0]).toBe(11);
	});

	it.each([
		{ sourcePointer: 0, width: 2, height: 2, stride: 7 },
		{ sourcePointer: 25, width: 2, height: 2, stride: 12 },
	])("rejects invalid stride or heap bounds: $sourcePointer, $stride", (input) => {
		expect(() =>
			copyRgbaBitmapPixels(
				new Uint8Array(32),
				input.sourcePointer,
				input.width,
				input.height,
				input.stride,
			),
		).toThrow("invalid bitmap buffer");
	});
});

describe("PDFium thumbnail bitmap conversion", () => {
	it.each([
		{ format: 1, bytes: [83], expected: [83, 83, 83, 255] },
		{ format: 2, bytes: [30, 20, 10], expected: [10, 20, 30, 255] },
		{ format: 3, bytes: [30, 20, 10, 0], expected: [10, 20, 30, 255] },
		{ format: 4, bytes: [30, 20, 10, 40], expected: [10, 20, 30, 40] },
		{ format: 5, bytes: [32, 64, 96, 128], expected: [191, 128, 64, 128] },
	])("converts PDFium bitmap format $format to RGBA", ({ format, bytes, expected }) => {
		const pixels = copyPdfiumThumbnailPixels(new Uint8Array(bytes), 0, 1, 1, bytes.length, format);

		expect(Array.from(new Uint8Array(pixels))).toEqual(expected);
	});

	it("honors row stride and preserves fully transparent pixels as transparent black", () => {
		const heap = new Uint8Array([5, 6, 7, 0, 90, 8, 9, 10, 255]);

		const pixels = copyPdfiumThumbnailPixels(heap, 0, 1, 2, 5, 4);

		expect(Array.from(new Uint8Array(pixels))).toEqual([0, 0, 0, 0, 10, 9, 8, 255]);
	});

	it("rejects unsupported formats, invalid strides, and excessive dimensions", () => {
		const heap = new Uint8Array(32);

		expect(() => copyPdfiumThumbnailPixels(heap, 0, 1, 1, 4, 0)).toThrow("unsupported");
		expect(() => copyPdfiumThumbnailPixels(heap, 0, 2, 1, 5, 4)).toThrow("invalid thumbnail");
		expect(() => copyPdfiumThumbnailPixels(heap, 0, 401, 400, 1604, 4)).toThrow(
			"invalid thumbnail",
		);
	});
});
