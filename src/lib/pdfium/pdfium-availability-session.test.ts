import { describe, expect, it, vi } from "vitest";

import {
	PdfiumAvailabilitySession,
	type PdfiumAvailabilityApi,
} from "./pdfium-availability-session";
import { type PdfiumRuntimeApi } from "./pdfium-file-access";
import type { PdfRangeLoader } from "./range-loader";

interface FakeLoaderOptions {
	getMissing?: () => boolean;
	getCacheEpoch?: () => number;
	clearMissingChunks?: () => void;
	fetchMissingChunks?: () => Promise<number>;
}

interface FakePdfium {
	api: PdfiumAvailabilityApi;
	events: string[];
	getDocumentCount(): number;
	getAvailabilityCount(): number;
	setPageAvailability(status: number): void;
	setLinearizationStatus(status: number): void;
}

function createFakeLoader(options: FakeLoaderOptions = {}): PdfRangeLoader {
	const loader = {
		get totalLength() {
			return 16;
		},
		get cacheEpoch() {
			return options.getCacheEpoch?.() ?? 0;
		},
		get hasMissingChunks() {
			return options.getMissing?.() ?? false;
		},
		readInto: vi.fn(() => true),
		isRangeAvailable: vi.fn(() => true),
		hintRange: vi.fn(),
		clearRangeHints: vi.fn(),
		clearMissingChunks: options.clearMissingChunks ?? vi.fn(),
		fetchMissingChunks: options.fetchMissingChunks ?? vi.fn(async () => 1),
		dispose: vi.fn(),
	};
	return loader as unknown as PdfRangeLoader;
}

function createFakePdfium(): FakePdfium {
	const events: string[] = [];
	let nextPointer = 100;
	let documentCount = 0;
	let availabilityCount = 0;
	let pageAvailability = 1;
	let linearizationStatus = 1;
	const runtime: PdfiumRuntimeApi = {
		malloc(size) {
			events.push(`malloc:${size}`);
			const pointer = nextPointer;
			nextPointer += 16;
			return pointer;
		},
		free(pointer) {
			events.push(`free:${pointer}`);
		},
		addFunction(_callback, signature) {
			events.push(`add:${signature}`);
			const pointer = nextPointer;
			nextPointer += 1;
			return pointer;
		},
		removeFunction(pointer) {
			events.push(`remove:${pointer}`);
		},
		setValue() {},
		getHeap() {
			return new Uint8Array(16);
		},
	};
	const api: PdfiumAvailabilityApi = {
		FPDFAvail_Create() {
			availabilityCount += 1;
			events.push("availability-create");
			return availabilityCount + 10;
		},
		FPDFAvail_Destroy() {
			events.push("availability-destroy");
		},
		FPDFAvail_GetDocument() {
			documentCount += 1;
			events.push("document-open");
			return 50;
		},
		FPDFAvail_IsDocAvail() {
			return 1;
		},
		FPDFAvail_IsLinearized() {
			return linearizationStatus;
		},
		FPDFAvail_IsPageAvail() {
			return pageAvailability;
		},
		FPDF_CloseDocument() {
			events.push("document-close");
		},
		FPDF_GetLastError() {
			return 0;
		},
		FPDF_GetPageCount() {
			return 24;
		},
		runtime,
	};
	return {
		api,
		events,
		getDocumentCount() {
			return documentCount;
		},
		getAvailabilityCount() {
			return availabilityCount;
		},
		setPageAvailability(status) {
			pageAvailability = status;
		},
		setLinearizationStatus(status) {
			linearizationStatus = status;
		},
	};
}

describe("PdfiumAvailabilitySession", () => {
	it("allows the page-load size fallback only after linearized page ranges are available", async () => {
		let missing = false;
		const fetchMissingChunks = vi.fn(async () => {
			missing = false;
			return 1;
		});
		const loader = createFakeLoader({
			getMissing: () => missing,
			clearMissingChunks: () => {
				missing = false;
			},
			fetchMissingChunks,
		});
		const pdfium = createFakePdfium();
		const session = await PdfiumAvailabilitySession.open(
			pdfium.api,
			loader,
			new AbortController().signal,
		);
		try {
			expect(await session.preparePageSizeFallback(12)).toBe(true);
			pdfium.setPageAvailability(1);
			missing = true;
			expect(await session.preparePageSizeFallback(12)).toBe(false);
			expect(fetchMissingChunks).toHaveBeenCalledOnce();
			expect(pdfium.getAvailabilityCount()).toBe(2);
			expect(pdfium.getDocumentCount()).toBe(2);
			expect(await session.preparePageSizeFallback(12)).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("keeps one document across page operations and survives more than 128 cache epochs", async () => {
		let cacheEpoch = 0;
		const loader = createFakeLoader({ getCacheEpoch: () => cacheEpoch });
		const pdfium = createFakePdfium();
		const session = await PdfiumAvailabilitySession.open(
			pdfium.api,
			loader,
			new AbortController().signal,
		);
		try {
			for (let operation = 0; operation < 3; operation += 1) {
				session.beginPageOperation();
				await session.ensurePageAvailable(0);
				session.completePageOperation();
			}
			expect(pdfium.getDocumentCount()).toBe(1);

			for (let epoch = 1; epoch <= 130; epoch += 1) {
				cacheEpoch = epoch;
				session.beginPageOperation();
				await session.ensurePageAvailable(epoch % 24);
				session.completePageOperation();
			}
			expect(pdfium.getDocumentCount()).toBe(131);
			expect(pdfium.getAvailabilityCount()).toBe(131);
		} finally {
			session.dispose();
		}

		const documentClose = pdfium.events.indexOf("document-close");
		const availabilityDestroy = pdfium.events.indexOf("availability-destroy", documentClose);
		const firstCallbackRemoval = pdfium.events.findIndex((event) =>
			event.startsWith("remove:"),
		);
		const firstMemoryFree = pdfium.events.findIndex((event) => event.startsWith("free:"));
		expect(documentClose).toBeGreaterThanOrEqual(0);
		expect(availabilityDestroy).toBeGreaterThan(documentClose);
		expect(firstCallbackRemoval).toBeGreaterThan(availabilityDestroy);
		expect(firstMemoryFree).toBeGreaterThan(firstCallbackRemoval);
	});

	it("does not recreate native state when disposed during a missing-range fetch", async () => {
		let missing = false;
		let resolveFetch: (count: number) => void = () => {};
		const fetchMissingChunks = vi.fn(
			() =>
				new Promise<number>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const loader = createFakeLoader({
			getMissing: () => missing,
			fetchMissingChunks,
		});
		const pdfium = createFakePdfium();
		const session = await PdfiumAvailabilitySession.open(
			pdfium.api,
			loader,
			new AbortController().signal,
		);
		pdfium.setPageAvailability(0);
		session.beginPageOperation();
		missing = true;
		const pending = session.ensurePageAvailable(0);
		await vi.waitFor(() => expect(fetchMissingChunks).toHaveBeenCalledOnce());
		const availabilityCount = pdfium.getAvailabilityCount();
		session.dispose();
		missing = false;
		resolveFetch(1);

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(pdfium.getAvailabilityCount()).toBe(availabilityCount);
		expect(pdfium.getDocumentCount()).toBe(1);
	});

	it("shares one range-fetch limit across retry phases and resets it after success", async () => {
		let missing = false;
		let fetchCount = 0;
		let pdfium: FakePdfium | null = null;
		const loader = createFakeLoader({
			getMissing: () => missing,
			clearMissingChunks: () => {
				missing = false;
			},
			fetchMissingChunks: async () => {
				fetchCount += 1;
				if (fetchCount === 100) missing = false;
				if (fetchCount === 129) {
					missing = false;
					pdfium?.setPageAvailability(1);
				}
				return 1;
			},
		});
		pdfium = createFakePdfium();
		const session = await PdfiumAvailabilitySession.open(
			pdfium.api,
			loader,
			new AbortController().signal,
		);
		try {
			session.beginPageOperation();
			missing = true;
			await session.recoverAfterReadMiss();

			pdfium.setPageAvailability(0);
			missing = true;
			await expect(session.ensurePageAvailable(0)).rejects.toThrow("128 range-fetch batches");
			expect(fetchCount).toBe(128);

			session.beginPageOperation();
			await session.ensurePageAvailable(0);
			session.completePageOperation();
			expect(fetchCount).toBe(129);
		} finally {
			session.dispose();
		}
	});

	it("does not run native cleanup after a WebAssembly trap", async () => {
		const pdfium = createFakePdfium();
		pdfium.api.FPDFAvail_IsPageAvail = () => {
			throw new WebAssembly.RuntimeError("simulated PDFium trap");
		};
		const session = await PdfiumAvailabilitySession.open(
			pdfium.api,
			createFakeLoader(),
			new AbortController().signal,
		);
		session.beginPageOperation();
		await expect(session.ensurePageAvailable(0)).rejects.toBeInstanceOf(
			WebAssembly.RuntimeError,
		);
		expect(session.isPoisoned).toBe(true);

		const eventCount = pdfium.events.length;
		session.dispose();
		expect(pdfium.events.slice(eventCount)).toEqual([]);
	});

	it.each([0, -1])(
		"skips whole-file page availability for linearization status %i",
		async (status) => {
			let cacheEpoch = 0;
			const pdfium = createFakePdfium();
			pdfium.setLinearizationStatus(status);
			const isLinearized = vi.spyOn(pdfium.api, "FPDFAvail_IsLinearized");
			const isPageAvailable = vi.spyOn(pdfium.api, "FPDFAvail_IsPageAvail");
			const session = await PdfiumAvailabilitySession.open(
				pdfium.api,
				createFakeLoader({ getCacheEpoch: () => cacheEpoch }),
				new AbortController().signal,
			);
			try {
				session.beginPageOperation();
				await session.ensurePageAvailable(0);
				cacheEpoch += 1;
				session.beginPageOperation();
				await session.ensurePageAvailable(1);
				expect(isPageAvailable).not.toHaveBeenCalled();
				expect(isLinearized).toHaveBeenCalledTimes(2);
			} finally {
				session.dispose();
			}
		},
	);
});
