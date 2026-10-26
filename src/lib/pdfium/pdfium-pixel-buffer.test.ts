// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { copyRgbaBitmapPixels } from "./pdfium-pixel-buffer";

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
