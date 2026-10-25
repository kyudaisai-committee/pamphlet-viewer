// SPDX-License-Identifier: MPL-2.0

export interface PdfiumRenderFlags {
	annotations?: number;
	reverseByteOrder?: number;
}

export function combinePdfiumRenderFlags(flags: PdfiumRenderFlags): number {
	return Object.values(flags).reduce((combined, flag) => combined | (flag ?? 0), 0);
}
