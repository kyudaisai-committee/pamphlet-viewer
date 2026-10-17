import { afterEach, describe, expect, it, vi } from "vitest";

import { parseContentRange, PdfRangeLoader } from "./range-loader";

const ETAG = '"test-document"';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("parseContentRange", () => {
	it("accepts a complete byte range with a known total", () => {
		expect(parseContentRange("bytes 256-511/1024")).toEqual({
			start: 256,
			end: 511,
			total: 1024,
		});
	});

	it.each([null, "bytes */1024", "bytes 0-1024/1024", "bytes nope"])(
		"rejects invalid Content-Range values: %s",
		(value) => {
			expect(parseContentRange(value)).toBeNull();
		},
	);
});

describe("PdfRangeLoader", () => {
	it("copies cached bytes into PDFium's requested buffer", async () => {
		const body = Uint8Array.from([1, 2, 3, 4]);
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(body, {
					status: 206,
					headers: {
						"Content-Range": "bytes 0-3/4",
						ETag: ETAG,
					},
				}),
		);

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		try {
			expect(await loader.initialize()).toBe(4);
			const target = new Uint8Array(6);
			expect(loader.readInto(1, target, 2, 2)).toBe(true);
			expect(target).toEqual(new Uint8Array([0, 0, 2, 3, 0, 0]));
			expect(loader.cachedByteLength).toBe(4);
		} finally {
			loader.dispose();
		}
	});

	it("rejects full responses instead of downloading the complete PDF", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));

		const loader = new PdfRangeLoader(
			"https://example.test/document.pdf",
			new AbortController().signal,
		);
		await expect(loader.initialize()).rejects.toThrow("HTTP 200");
		expect(cancel).toHaveBeenCalledOnce();
	});
});
