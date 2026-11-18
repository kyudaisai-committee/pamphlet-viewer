// SPDX-License-Identifier: MIT

import type { PdfRangeResponse } from "./range-request";
import type { PdfRangeTransport, RangeTransportRequest } from "./range-transport";

const MAX_FILE_LENGTH = 0xffff_ffff;

export class FullResponseBroker implements PdfRangeTransport {
	#controller = new AbortController();
	#response: PdfRangeResponse | null = null;
	#loading: Promise<PdfRangeResponse> | null = null;
	#disposed = false;

	constructor(private readonly source: string) {}

	async request(request: RangeTransportRequest, signal: AbortSignal): Promise<PdfRangeResponse> {
		this.#assertActive();
		if (signal.aborted) throw createAbortError();
		if (!this.#isSourceUrl(request.url)) {
			throw new Error("A PDF worker requested ranges for a different document.");
		}
		const response = await this.#waitForResponse(signal);
		const end = Math.min(request.requestedEnd, response.totalLength - 1);
		if (request.start > end) throw new Error("The requested PDF range starts beyond EOF.");
		return {
			...response,
			bytes: response.bytes.slice(request.start, end + 1),
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#controller.abort();
		this.#response = null;
		this.#loading = null;
	}

	async #waitForResponse(signal: AbortSignal): Promise<PdfRangeResponse> {
		const response = this.#response;
		if (response !== null) return response;

		let loading = this.#loading;
		if (loading === null) {
			loading = this.#load();
			this.#loading = loading;
			void loading.catch(() => {
				if (this.#loading === loading) this.#loading = null;
			});
		}
		return waitForAbortable(loading, signal);
	}

	async #load(): Promise<PdfRangeResponse> {
		const response = await fetch(this.source, { signal: this.#controller.signal });
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => {});
			throw new Error(`The server returned HTTP ${response.status} to a full PDF request.`);
		}
		const contentLength = response.headers.get("Content-Length");
		if (contentLength !== null) {
			const declaredLength = Number(contentLength);
			if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
				void response.body?.cancel().catch(() => {});
				throw new Error("The server returned an invalid PDF Content-Length header.");
			}
			if (declaredLength > MAX_FILE_LENGTH) {
				void response.body?.cancel().catch(() => {});
				throw new Error("PDF files must be smaller than 4 GiB.");
			}
		}

		const bytes = await readResponseBody(response, MAX_FILE_LENGTH);
		if (this.#controller.signal.aborted) throw createAbortError();
		const result: PdfRangeResponse = {
			bytes,
			totalLength: bytes.byteLength,
			etag: response.headers.get("ETag"),
			lastModified: response.headers.get("Last-Modified"),
			responseUrl: response.url,
		};
		this.#response = result;
		return result;
	}

	#isSourceUrl(url: string): boolean {
		return url === this.source || url === this.#response?.responseUrl;
	}

	#assertActive(): void {
		if (this.#disposed) throw createAbortError();
	}
}

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(createAbortError());
	return new Promise<T>((resolve, reject) => {
		const abort = function abortWait(): void {
			cleanup();
			reject(createAbortError());
		};
		const cleanup = function removeAbortListener(): void {
			signal.removeEventListener("abort", abort);
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			if (result.value.byteLength > maximumBytes - byteLength) {
				void reader.cancel().catch(() => {});
				throw new Error("PDF files must be smaller than 4 GiB.");
			}
			chunks.push(result.value);
			byteLength += result.value.byteLength;
		}
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function createAbortError(): DOMException {
	return new DOMException("PDF loading was cancelled.", "AbortError");
}
