// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "vitest";

import type { PdfiumRenderFlags } from "./pdfium-render-flags";
import { combinePdfiumRenderFlags } from "./pdfium-render-flags";

describe("PDFium render flags", () => {
	it.each([
		{ flags: {}, expected: 0 },
		{ flags: { annotations: 0x01 }, expected: 0x01 },
		{ flags: { reverseByteOrder: 0x10 }, expected: 0x10 },
		{ flags: { annotations: 0x01, reverseByteOrder: 0x10 }, expected: 0x11 },
	] satisfies Array<{ flags: PdfiumRenderFlags; expected: number }>)(
		"combines $flags into $expected",
		({ flags, expected }) => {
			expect(combinePdfiumRenderFlags(flags)).toBe(expected);
		},
	);
});
