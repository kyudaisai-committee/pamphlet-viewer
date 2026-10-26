// SPDX-License-Identifier: MIT

import { PdfiumFileAccess, type PdfiumRuntimeApi } from "./pdfium-file-access";
import type { PdfRangeLoader } from "./range-loader";

const MAX_AVAILABILITY_ATTEMPTS = 128;
const MAX_CACHE_REBUILDS = 128;
const MAX_RANGE_FETCH_BATCHES_PER_OPERATION = 128;

export class PdfiumAvailabilityFatalError extends Error {
	constructor(cause: unknown) {
		const message = cause instanceof Error ? cause.message : "PDFium entered an unusable state.";
		super(message, { cause });
		this.name = "PdfiumAvailabilityFatalError";
	}
}

export interface PdfiumAvailabilityApi {
	FPDFAvail_Create(fileAvail: number, fileAccess: number): number;
	FPDFAvail_Destroy(availability: number): void;
	FPDFAvail_GetDocument(availability: number, password: string): number;
	FPDFAvail_IsDocAvail(availability: number, hints: number): number;
	FPDFAvail_IsLinearized(availability: number): number;
	FPDFAvail_IsPageAvail(availability: number, pageIndex: number, hints: number): number;
	FPDF_CloseDocument(document: number): void;
	FPDF_GetLastError(): number;
	FPDF_GetPageCount(document: number): number;
	runtime: PdfiumRuntimeApi;
}

export class PdfiumAvailabilitySession {
	#fileAccess: PdfiumFileAccess | null = null;
	#availability = 0;
	#document = 0;
	#pageCount: number | null = null;
	#isLinearized: boolean | null = null;
	#nativeCacheEpoch: number;
	#callbackError: Error | null = null;
	#rebuildCount = 0;
	#rangeFetchBatchCount = 0;
	#poisoned = false;
	#disposed = false;

	private constructor(
		private readonly pdfium: PdfiumAvailabilityApi,
		private readonly loader: PdfRangeLoader,
		private readonly signal: AbortSignal,
	) {
		this.#nativeCacheEpoch = loader.cacheEpoch;
	}

	static async open(
		pdfium: PdfiumAvailabilityApi,
		loader: PdfRangeLoader,
		signal: AbortSignal,
	): Promise<PdfiumAvailabilitySession> {
		const session = new PdfiumAvailabilitySession(pdfium, loader, signal);
		try {
			session.#createFileAccess();
			await session.#openDocument();
			return session;
		} catch (error) {
			session.#markPoisoned(error);
			session.dispose();
			if (session.isPoisoned) throw new PdfiumAvailabilityFatalError(error);
			throw error;
		}
	}

	get documentHandle(): number {
		if (this.#document === 0) throw new Error("The PDF document is not open.");
		return this.#document;
	}

	get pageCount(): number {
		if (this.#pageCount === null) throw new Error("The PDF document is not open.");
		return this.#pageCount;
	}

	get isPoisoned(): boolean {
		return this.#poisoned;
	}

	beginPageOperation(): void {
		this.#rebuildCount = 0;
		this.#rangeFetchBatchCount = 0;
	}

	completePageOperation(): void {
		this.#rebuildCount = 0;
		this.#rangeFetchBatchCount = 0;
	}

	runNative<T>(operation: () => T, captureResult?: (result: T) => void): T {
		if (this.#disposed) throw new Error("The PDFium availability session is disposed.");
		if (this.#poisoned)
			throw new Error("The PDFium availability session cannot be reused after a native failure.");
		this.#callbackError = null;

		let result: T;
		try {
			result = operation();
		} catch (error) {
			this.#markPoisoned(error);
			throw error;
		}

		captureResult?.(result);
		if (this.#callbackError !== null) {
			this.#markPoisoned(this.#callbackError);
			throw this.#callbackError;
		}
		return result;
	}

	markNativeFailure(error: unknown): void {
		this.#markPoisoned(error);
	}

	async ensureDocumentAvailable(): Promise<void> {
		this.#throwIfAborted();
		await this.#synchronizeCacheEpoch();
		this.#throwIfAborted();
		await this.#openDocument();
		this.#throwIfAborted();
	}

	async preparePageSizeFallback(pageIndex: number): Promise<boolean> {
		this.#throwIfAborted();
		await this.ensureDocumentAvailable();
		if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
			throw new RangeError(`Page index must be between 0 and ${this.pageCount - 1}.`);
		}
		if (this.#isLinearized !== true) {
			throw new Error("PDFium could not resolve the requested page size from the open document.");
		}

		const status = this.runNative(() =>
			this.pdfium.FPDFAvail_IsPageAvail(
				this.#availability,
				pageIndex,
				this.#requireFileAccess().downloadHints,
			),
		);
		if (status < 0) this.#throwPdfiumError("PDFium could not inspect the requested page");
		if (status === 1 && !this.loader.hasMissingChunks) {
			this.loader.clearRangeHints();
			return true;
		}

		const fetched = await this.#fetchMissingChunks(true);
		if (fetched === 0) {
			throw new Error("PDFium could not make progress loading the requested page metadata ranges.");
		}
		if (status === 1) {
			await this.#rebuildNativeState();
			this.#throwIfAborted();
			await this.#openDocument();
		}
		this.#throwIfAborted();
		return false;
	}

	async ensurePageAvailable(pageIndex: number): Promise<void> {
		this.#throwIfAborted();
		await this.ensureDocumentAvailable();
		this.#throwIfAborted();
		if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
			throw new RangeError(`Page index must be between 0 and ${this.pageCount - 1}.`);
		}

		for (let attempt = 0; attempt < MAX_AVAILABILITY_ATTEMPTS; attempt += 1) {
			this.#throwIfAborted();
			await this.ensureDocumentAvailable();
			if (this.#isLinearized !== true) return;
			const status = this.runNative(() =>
				this.pdfium.FPDFAvail_IsPageAvail(
					this.#availability,
					pageIndex,
					this.#requireFileAccess().downloadHints,
				),
			);
			if (status < 0) this.#throwPdfiumError("PDFium could not inspect the requested page");

			if (status === 1 && !this.loader.hasMissingChunks) {
				this.loader.clearRangeHints();
				return;
			}

			const fetched = await this.#fetchMissingChunks(true);
			if (fetched === 0) {
				throw new Error("PDFium could not make progress loading the requested page ranges.");
			}
			if (status === 1) {
				await this.#rebuildNativeState();
				this.#throwIfAborted();
				await this.#openDocument();
			}
		}

		throw new Error("PDFium could not prepare the requested page within 128 range attempts.");
	}

	async recoverAfterReadMiss(): Promise<void> {
		if (!this.loader.hasMissingChunks) return;
		for (let attempt = 0; attempt < MAX_AVAILABILITY_ATTEMPTS; attempt += 1) {
			this.#throwIfAborted();
			const fetched = await this.#fetchMissingChunks();
			if (fetched === 0) {
				throw new Error("PDFium could not make progress loading the requested page ranges.");
			}
			if (!this.loader.hasMissingChunks) break;
		}
		if (this.loader.hasMissingChunks) {
			throw new Error(
				"The requested PDF page needs more data than the 64 MiB range cache can retain.",
			);
		}

		this.#throwIfAborted();
		this.loader.clearRangeHints();
		await this.#rebuildNativeState();
		this.#throwIfAborted();
		await this.#openDocument();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#poisoned) return;

		if (this.#document !== 0) {
			const document = this.#document;
			this.#document = 0;
			if (!this.#tryCleanup(() => this.pdfium.FPDF_CloseDocument(document))) return;
		}
		if (this.#availability !== 0) {
			const availability = this.#availability;
			this.#availability = 0;
			if (!this.#tryCleanup(() => this.pdfium.FPDFAvail_Destroy(availability))) return;
		}
		this.#isLinearized = null;

		this.#fileAccess?.dispose();
		this.#fileAccess = null;
	}

	#createFileAccess(): void {
		const fileLength = this.loader.totalLength;
		if (fileLength === null) throw new Error("PDF range loader is not initialized.");
		this.#fileAccess = new PdfiumFileAccess(
			this.pdfium.runtime,
			fileLength,
			this.loader,
			(error) => this.#recordCallbackError(error),
			() => this.#poison(),
		);
		this.#fileAccess.initialize();
		this.#createAvailability();
	}

	async #openDocument(): Promise<void> {
		if (this.#document !== 0) return;
		for (let attempt = 0; attempt < MAX_AVAILABILITY_ATTEMPTS; attempt += 1) {
			this.#throwIfAborted();
			await this.#synchronizeCacheEpoch();
			this.#throwIfAborted();
			if (this.#availability === 0) this.#createAvailability();

			const status = this.runNative(() =>
				this.pdfium.FPDFAvail_IsDocAvail(
					this.#availability,
					this.#requireFileAccess().downloadHints,
				),
			);
			if (status < 0) this.#throwPdfiumError("PDFium could not inspect the document");
			let rebuildAfterFetch = status === 1 && this.loader.hasMissingChunks;
			if (status === 1 && !this.loader.hasMissingChunks) {
				this.loader.clearRangeHints();
				this.runNative(
					() => this.pdfium.FPDFAvail_GetDocument(this.#availability, ""),
					(document) => {
						this.#document = document;
					},
				);
				if (this.#document !== 0) {
					if (this.loader.hasMissingChunks) {
						rebuildAfterFetch = true;
					} else {
						const pageCount = this.runNative(() => this.pdfium.FPDF_GetPageCount(this.#document));
						if (this.loader.hasMissingChunks) {
							rebuildAfterFetch = true;
						} else if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
							this.#throwPdfiumError("PDFium returned an invalid page count");
						} else {
							this.#pageCount = pageCount;
							const linearized = this.runNative(() =>
								this.pdfium.FPDFAvail_IsLinearized(this.#availability),
							);
							if (this.loader.hasMissingChunks) {
								rebuildAfterFetch = true;
							} else {
								this.#isLinearized = linearized === 1 ? true : linearized === 0 ? false : null;
								return;
							}
						}
					}
				}
				if (this.#document === 0 && !this.loader.hasMissingChunks) {
					this.#throwPdfiumError("PDFium could not open the document");
				}
			}

			const fetched = await this.#fetchMissingChunks(true);
			if (fetched === 0) {
				throw new Error("PDFium could not make progress loading document ranges.");
			}
			if (
				rebuildAfterFetch ||
				this.#document !== 0 ||
				this.loader.cacheEpoch !== this.#nativeCacheEpoch
			) {
				await this.#rebuildNativeState();
			}
		}

		throw new Error("PDFium could not prepare the document within 128 range attempts.");
	}

	async #synchronizeCacheEpoch(): Promise<void> {
		if (this.#availability === 0 || this.#nativeCacheEpoch === this.loader.cacheEpoch) return;
		await this.#rebuildNativeState();
	}

	async #fetchMissingChunks(includeHints = false): Promise<number> {
		this.#throwIfAborted();
		if (this.#rangeFetchBatchCount >= MAX_RANGE_FETCH_BATCHES_PER_OPERATION) {
			throw new Error(
				"PDFium could not prepare the requested page within 128 range-fetch batches.",
			);
		}
		this.#rangeFetchBatchCount += 1;
		const fetched = await this.loader.fetchMissingChunks(includeHints);
		this.#throwIfAborted();
		return fetched;
	}

	async #rebuildNativeState(): Promise<void> {
		this.#rebuildCount += 1;
		if (this.#rebuildCount > MAX_CACHE_REBUILDS) {
			throw new Error("PDFium could not keep the required ranges within the 64 MiB working cache.");
		}
		this.#releaseDocumentAndAvailability();
		this.#nativeCacheEpoch = this.loader.cacheEpoch;
		this.#createAvailability();
	}

	#releaseDocumentAndAvailability(): void {
		if (this.#document !== 0) {
			const document = this.#document;
			this.#document = 0;
			this.runNative(() => this.pdfium.FPDF_CloseDocument(document));
		}
		this.#pageCount = null;
		if (this.#availability !== 0) {
			const availability = this.#availability;
			this.#availability = 0;
			this.runNative(() => this.pdfium.FPDFAvail_Destroy(availability));
		}
	}

	#createAvailability(): void {
		if (this.#availability !== 0) return;
		this.#isLinearized = null;
		const fileAccess = this.#requireFileAccess();
		this.runNative(
			() => this.pdfium.FPDFAvail_Create(fileAccess.fileAvail, fileAccess.fileAccess),
			(availability) => {
				this.#availability = availability;
			},
		);
		if (this.#availability === 0) {
			this.#throwPdfiumError("PDFium could not create range availability state");
		}
		this.#nativeCacheEpoch = this.loader.cacheEpoch;
	}

	#tryCleanup(cleanup: () => void): boolean {
		try {
			cleanup();
			return true;
		} catch {
			this.#poison();
			return false;
		}
	}

	#throwPdfiumError(message: string): never {
		const errorCode = this.runNative(() => this.pdfium.FPDF_GetLastError());
		throw new Error(`${message} (error ${errorCode}).`);
	}

	#throwIfAborted(): void {
		if (this.signal.aborted || this.#disposed) {
			throw new DOMException("PDF loading was cancelled.", "AbortError");
		}
	}

	#recordCallbackError(error: unknown): void {
		if (this.#callbackError !== null) return;
		this.#callbackError =
			error instanceof Error ? error : new Error("PDFium requested an invalid range.");
	}

	#markPoisoned(error: unknown): void {
		if (error instanceof WebAssembly.RuntimeError) this.#poisoned = true;
	}

	#poison(): void {
		this.#poisoned = true;
	}

	#requireFileAccess(): PdfiumFileAccess {
		if (this.#fileAccess === null) throw new Error("PDFium file access is not initialized.");
		return this.#fileAccess;
	}
}
