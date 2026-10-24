import { afterEach, describe, expect, it, vi } from "vitest";

import { PdfRangeLoader, RANGE_CHUNK_SIZE } from "./range-loader";

const SOURCE_URL = "https://example.test/short-lived-document.pdf";
const FINAL_URL = "https://cdn.example.test/document.pdf?signature=stable";
const ETAG = '"test-document"';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PdfRangeLoader redirect handling", () => {
	it("reuses the final URL from its first validated range response", async () => {
		const requestUrls: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			requestUrls.push(String(input));
			return createRangeResponse(getRangeStart(init), { responseUrl: FINAL_URL });
		});
		vi.stubGlobal("fetch", fetchMock);

		const loader = createLoader();
		try {
			await loader.initialize();
			expect(loader.readInto(RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1)).toBe(false);
			await loader.fetchMissingChunks();

			expect(requestUrls).toEqual([SOURCE_URL, FINAL_URL]);
		} finally {
			loader.dispose();
		}
	});

	it("keeps the validator on requests sent to the final URL", async () => {
		const requests: Array<{ url: string; ifRange: string | null }> = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				ifRange: new Headers(init?.headers).get("If-Range"),
			});
			return createRangeResponse(getRangeStart(init), { etag: ETAG, responseUrl: FINAL_URL });
		});
		vi.stubGlobal("fetch", fetchMock);

		const loader = createLoader();
		try {
			await loader.initialize();
			expect(loader.readInto(RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1)).toBe(false);
			await loader.fetchMissingChunks();

			expect(requests).toEqual([
				{ url: SOURCE_URL, ifRange: null },
				{ url: FINAL_URL, ifRange: ETAG },
			]);
		} finally {
			loader.dispose();
		}
	});

	it("keeps the original URL when the validated response has an empty URL", async () => {
		const requestUrls: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			requestUrls.push(String(input));
			return createRangeResponse(getRangeStart(init), {
				responseUrl: requestUrls.length === 1 ? "" : FINAL_URL,
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const loader = createLoader();
		try {
			await loader.initialize();
			expect(loader.readInto(RANGE_CHUNK_SIZE, new Uint8Array(1), 0, 1)).toBe(false);
			await loader.fetchMissingChunks();

			expect(requestUrls).toEqual([SOURCE_URL, SOURCE_URL]);
		} finally {
			loader.dispose();
		}
	});

	it("does not adopt a URL from a rejected response", async () => {
		const requestUrls: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			requestUrls.push(String(input));
			if (requestUrls.length === 1) {
				return createRangeResponse(getRangeStart(init), {
					contentRange: `bytes 1-${RANGE_CHUNK_SIZE}/${RANGE_CHUNK_SIZE * 2}`,
					responseUrl: FINAL_URL,
				});
			}
			return createRangeResponse(getRangeStart(init));
		});
		vi.stubGlobal("fetch", fetchMock);

		const loader = createLoader();
		try {
			await expect(loader.initialize()).rejects.toThrow("invalid Content-Range");
			expect(await loader.initialize()).toBe(RANGE_CHUNK_SIZE * 2);
			expect(requestUrls).toEqual([SOURCE_URL, SOURCE_URL]);
		} finally {
			loader.dispose();
		}
	});
});

function createLoader(): PdfRangeLoader {
	return new PdfRangeLoader(SOURCE_URL, new AbortController().signal);
}

function createRangeResponse(
	start: number = 0,
	options: { contentRange?: string; etag?: string; responseUrl?: string } = {},
): Response {
	const totalLength = RANGE_CHUNK_SIZE * 2;
	const end = Math.min(start + RANGE_CHUNK_SIZE - 1, totalLength - 1);
	const headers = new Headers({
		"Content-Range": options.contentRange ?? `bytes ${start}-${end}/${totalLength}`,
	});
	if (options.etag !== undefined) headers.set("ETag", options.etag);
	const response = new Response(new Uint8Array(end - start + 1), { status: 206, headers });
	if (options.responseUrl !== undefined) {
		Object.defineProperty(response, "url", { value: options.responseUrl });
	}
	return response;
}

function getRangeStart(init?: RequestInit): number {
	const range = new Headers(init?.headers).get("Range");
	const match = range === null ? null : /^bytes=(\d+)-\d+$/.exec(range);
	if (match === null) throw new Error("A byte range was not requested.");
	return Number(match[1]);
}
