import { describe, expect, it, vi } from "vitest";

import { PdfiumFileAccess, type PdfiumRuntimeApi } from "./pdfium-file-access";

type BlockCallback = (parameter: number, position: number, buffer: number, size: number) => number;
type AvailabilityCallback = (fileAvail: number, offset: number, size: number) => number;
type DownloadHintCallback = (hints: number, offset: number, size: number) => void;

describe("PDFium file-access callbacks", () => {
	it.each([0x7fffffff, 0x80000000, 0xffffffff, 0x12345678])(
		"normalizes signed i32 callback values before calling the range reader (%i)",
		(unsignedValue) => {
			const fixture = createFixture();
			fixture.fileAccess.initialize();
			try {
				const { block, isAvailable, addHint } = fixture.callbacks;
				if (block === null || isAvailable === null || addHint === null) {
					throw new Error("PDFium callbacks were not registered.");
				}
				const signedValue = toWasmI32(unsignedValue);

				expect(block(0, signedValue, signedValue, signedValue)).toBe(1);
				expect(fixture.reader.readInto).toHaveBeenCalledWith(
					unsignedValue,
					fixture.heap,
					unsignedValue,
					unsignedValue,
				);
				expect(isAvailable(1, signedValue, signedValue)).toBe(1);
				expect(fixture.reader.isRangeAvailable).toHaveBeenCalledWith(unsignedValue, unsignedValue);
				addHint(1, signedValue, signedValue);
				expect(fixture.reader.hintRange).toHaveBeenCalledWith(unsignedValue, unsignedValue);
				expect(fixture.callbackError).not.toHaveBeenCalled();
			} finally {
				fixture.fileAccess.dispose();
			}
		},
	);
});

function createFixture(): {
	fileAccess: PdfiumFileAccess;
	heap: Uint8Array;
	callbacks: {
		block: BlockCallback | null;
		isAvailable: AvailabilityCallback | null;
		addHint: DownloadHintCallback | null;
	};
	reader: {
		readInto: ReturnType<typeof vi.fn>;
		isRangeAvailable: ReturnType<typeof vi.fn>;
		hintRange: ReturnType<typeof vi.fn>;
	};
	callbackError: ReturnType<typeof vi.fn>;
} {
	const heap = new Uint8Array(16);
	const callbacks = {
		block: null as BlockCallback | null,
		isAvailable: null as AvailabilityCallback | null,
		addHint: null as DownloadHintCallback | null,
	};
	const reader = {
		readInto: vi.fn(() => true),
		isRangeAvailable: vi.fn(() => true),
		hintRange: vi.fn(),
	};
	const callbackError = vi.fn();
	let nextPointer = 100;
	const runtime: PdfiumRuntimeApi = {
		malloc(size) {
			const pointer = nextPointer;
			nextPointer += size;
			return pointer;
		},
		free: vi.fn(),
		addFunction(callback, signature) {
			if (signature === "iiiii") callbacks.block = callback as BlockCallback;
			else if (signature === "iiii") callbacks.isAvailable = callback as AvailabilityCallback;
			else if (signature === "viii") callbacks.addHint = callback as DownloadHintCallback;
			const pointer = nextPointer;
			nextPointer += 1;
			return pointer;
		},
		removeFunction: vi.fn(),
		setValue: vi.fn(),
		getHeap() {
			return heap;
		},
	};
	const fileAccess = new PdfiumFileAccess(runtime, 0xffffffff, reader, callbackError, vi.fn());
	return { fileAccess, heap, callbacks, reader, callbackError };
}

function toWasmI32(value: number): number {
	return Number(new WebAssembly.Global({ value: "i32" }, value).value);
}
