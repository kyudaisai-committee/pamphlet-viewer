import { cancelResponseBody, parseContentRange, readBoundedResponseBody } from "./range-response";

export const RANGE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_FILE_LENGTH = 0xffff_ffff;

export interface PdfRangeRequestParameters {
	url: string;
	signal: AbortSignal;
	start: number;
	requestedEnd: number;
	totalLength: number | null;
	etag: string | null;
	lastModified: string | null;
}

export interface PdfRangeResponse {
	bytes: Uint8Array;
	totalLength: number;
	etag: string | null;
	lastModified: string | null;
}

export async function requestPdfRange(
	parameters: PdfRangeRequestParameters,
): Promise<PdfRangeResponse> {
	const { url, signal, start, requestedEnd, totalLength, etag, lastModified } = parameters;
	if (signal.aborted) throw new DOMException("PDF loading was cancelled.", "AbortError");

	const requestController = new AbortController();
	let timedOut = false;
	const abortRequest = function abortForParentSignal(): void {
		requestController.abort();
	};
	signal.addEventListener("abort", abortRequest, { once: true });
	const timeoutId = setTimeout(function abortTimedOutRequest(): void {
		timedOut = true;
		requestController.abort();
	}, RANGE_REQUEST_TIMEOUT_MS);

	const headers = new Headers({ Range: `bytes=${start}-${requestedEnd}` });
	const ifRange = etag && !etag.startsWith("W/") ? etag : lastModified;
	if (ifRange !== null) headers.set("If-Range", ifRange);

	try {
		const response = await fetch(url, { headers, signal: requestController.signal });
		if (response.status !== 206) {
			cancelResponseBody(response);
			throw new Error(`The server returned HTTP ${response.status} to a byte-range request.`);
		}

		const range = parseContentRange(response.headers.get("Content-Range"));
		if (range === null || range.start !== start) {
			cancelResponseBody(response);
			throw new Error("The server returned an invalid Content-Range header.");
		}
		if (range.total > MAX_FILE_LENGTH) {
			cancelResponseBody(response);
			throw new Error("PDF files must be smaller than 4 GiB.");
		}
		const expectedEnd = Math.min(requestedEnd, range.total - 1);
		if (range.end !== expectedEnd) {
			cancelResponseBody(response);
			throw new Error("The server returned an incomplete byte range.");
		}
		if (totalLength !== null && range.total !== totalLength) {
			cancelResponseBody(response);
			throw new Error("The PDF length changed while it was being loaded.");
		}
		if (
			(etag !== null && response.headers.get("ETag") !== etag) ||
			(lastModified !== null && response.headers.get("Last-Modified") !== lastModified)
		) {
			cancelResponseBody(response);
			throw new Error("The PDF representation changed while it was being loaded.");
		}

		const expectedLength = range.end - range.start + 1;
		const bytes = await readBoundedResponseBody(response, expectedLength);
		if (bytes.byteLength !== expectedLength) {
			throw new Error("The server returned a byte range with an unexpected length.");
		}

		return {
			bytes,
			totalLength: range.total,
			etag: response.headers.get("ETag"),
			lastModified: response.headers.get("Last-Modified"),
		};
	} catch (error) {
		if (signal.aborted) {
			throw new DOMException("PDF loading was cancelled.", "AbortError");
		}
		if (timedOut) {
			throw new Error("The PDF byte-range request timed out.", { cause: error });
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
		signal.removeEventListener("abort", abortRequest);
	}
}
