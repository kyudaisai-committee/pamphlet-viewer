import { afterEach, describe, expect, it, vi } from "vitest";

import type { RangeTransportRequest } from "@/lib/pdfium/range/range-transport";

interface OpenRequest {
	id: number;
	type: "open";
	url: string;
	wasmUrl: string;
	useRangeBroker?: boolean;
}

interface PagePrefetchRequest {
	id: number;
	type: "page-prefetch";
	pageIndex: number;
}

interface CancelRequest {
	id: number;
	type: "cancel";
}

interface PromoteRequest {
	id: number;
	type: "promote";
	priority: "visible" | "data" | "prerender" | "thumbnail";
}

interface RenderRequest {
	id: number;
	type: "render";
	pageIndex: number;
	scale: number;
	priority: "visible" | "data" | "prerender" | "thumbnail";
}

interface RangeResponseMessage {
	type: "range-response";
	id: number;
	response: {
		bytes: ArrayBuffer;
		totalLength: number;
		etag: string | null;
		lastModified: string | null;
		responseUrl: string;
	};
}

type WorkerRequest = OpenRequest | PagePrefetchRequest | RenderRequest;
type WorkerMessage = WorkerRequest | CancelRequest | PromoteRequest | RangeResponseMessage;

interface WorkerResponse {
	id: number;
	type: string;
	fatal?: boolean;
}

interface DocumentSessionStub {
	readonly info: { pageCount: number; fileLength: number };
	readonly isPoisoned: boolean;
	dispose(): void;
	prefetchPage(pageIndex: number, signal?: AbortSignal): Promise<void>;
	setPriority?(priority: "visible" | "data" | "prerender" | "thumbnail"): void;
	renderPage?(
		pageIndex: number,
		scale: number,
		priority: "visible" | "data" | "prerender" | "thumbnail",
		signal?: AbortSignal,
	): Promise<{ type: "pixels"; width: number; height: number; pixels: ArrayBuffer }>;
}

describe("PDF worker document lifecycle", () => {
	afterEach(() => {
		vi.doUnmock("@/lib/pdfium/document/pdfium-document");
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("stops before opening another document when previous cleanup poisons PDFium", async () => {
		let poisoned = false;
		const session: DocumentSessionStub = {
			info: { pageCount: 1, fileLength: 256 },
			get isPoisoned() {
				return poisoned;
			},
			dispose() {
				poisoned = true;
			},
			async prefetchPage() {},
		};
		const openDocument = vi.fn(async () => session);
		vi.doMock("@/lib/pdfium/document/pdfium-document", () => ({
			PdfiumDocumentSession: class {
				static open(): Promise<DocumentSessionStub> {
					return openDocument();
				}
			},
			PdfiumFatalError: class extends Error {},
		}));

		const responses: WorkerResponse[] = [];
		const closeWorker = vi.fn();
		let dispatch: ((request: WorkerMessage) => void) | null = null;
		const workerScope = {
			addEventListener(
				_type: "message",
				listener: (event: MessageEvent<WorkerMessage>) => void,
			) {
				dispatch = (request) => listener({ data: request } as MessageEvent<WorkerMessage>);
			},
			postMessage(message: WorkerResponse): void {
				responses.push(message);
			},
			close: closeWorker,
		};
		vi.stubGlobal("self", workerScope);
		await import("./pdfium.worker");

		const sendOpen = (id: number): void => {
			if (dispatch === null)
				throw new Error("The PDF worker did not register its message handler.");
			dispatch({
				id,
				type: "open",
				url: `https://example.test/${id}.pdf`,
				wasmUrl: "https://example.test/pdfium.wasm",
			});
		};

		sendOpen(1);
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		expect(responses[0]).toMatchObject({ id: 1, type: "opened" });

		sendOpen(2);
		await vi.waitFor(() => expect(responses).toHaveLength(2));
		expect(responses[1]).toMatchObject({ id: 2, type: "error", fatal: true });
		expect(openDocument).toHaveBeenCalledOnce();
		expect(closeWorker).toHaveBeenCalledOnce();
	});

	it("prefetches a page without rendering it", async () => {
		const prefetchPage = vi.fn(async () => undefined);
		const session: DocumentSessionStub = {
			info: { pageCount: 8, fileLength: 1024 },
			isPoisoned: false,
			dispose() {},
			prefetchPage,
		};
		vi.doMock("@/lib/pdfium/document/pdfium-document", () => ({
			PdfiumDocumentSession: class {
				static open(): Promise<DocumentSessionStub> {
					return Promise.resolve(session);
				}
			},
			PdfiumFatalError: class extends Error {},
		}));

		const responses: WorkerResponse[] = [];
		let dispatch: ((request: WorkerMessage) => void) | null = null;
		const workerScope = {
			addEventListener(
				_type: "message",
				listener: (event: MessageEvent<WorkerMessage>) => void,
			) {
				dispatch = (request) => listener({ data: request } as MessageEvent<WorkerMessage>);
			},
			postMessage(message: WorkerResponse): void {
				responses.push(message);
			},
			close() {},
		};
		vi.stubGlobal("self", workerScope);
		await import("./pdfium.worker");

		const send = (request: WorkerMessage): void => {
			if (dispatch === null)
				throw new Error("The PDF worker did not register its message handler.");
			dispatch(request);
		};
		send({
			id: 1,
			type: "open",
			url: "https://example.test/brochure.pdf",
			wasmUrl: "https://example.test/pdfium.wasm",
		});
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		send({ id: 2, type: "page-prefetch", pageIndex: 6 });
		await vi.waitFor(() => expect(responses).toHaveLength(2));

		expect(prefetchPage).toHaveBeenCalledWith(6, expect.any(AbortSignal));
		expect(responses[1]).toMatchObject({ id: 2, type: "page-prefetch" });
	});

	it("retires the worker when the server changes the PDF representation", async () => {
		const { PdfRepresentationChangedError } = await import("@/lib/pdfium/range/range-request");
		const session: DocumentSessionStub = {
			info: { pageCount: 4, fileLength: 1024 },
			isPoisoned: false,
			dispose: vi.fn(),
			async prefetchPage() {
				throw new PdfRepresentationChangedError("The PDF representation changed.");
			},
		};
		vi.doMock("@/lib/pdfium/document/pdfium-document", () => ({
			PdfiumDocumentSession: class {
				static open(): Promise<DocumentSessionStub> {
					return Promise.resolve(session);
				}
			},
			PdfiumFatalError: class extends Error {},
		}));

		const responses: WorkerResponse[] = [];
		const closeWorker = vi.fn();
		let dispatch: ((request: WorkerMessage) => void) | null = null;
		const workerScope = {
			addEventListener(
				_type: "message",
				listener: (event: MessageEvent<WorkerMessage>) => void,
			) {
				dispatch = (request) => listener({ data: request } as MessageEvent<WorkerMessage>);
			},
			postMessage(message: WorkerResponse): void {
				responses.push(message);
			},
			close: closeWorker,
		};
		vi.stubGlobal("self", workerScope);
		await import("./pdfium.worker");

		const send = (request: WorkerMessage): void => {
			if (dispatch === null)
				throw new Error("The PDF worker did not register its message handler.");
			dispatch(request);
		};
		send({
			id: 1,
			type: "open",
			url: "https://example.test/brochure.pdf",
			wasmUrl: "https://example.test/pdfium.wasm",
		});
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		send({ id: 2, type: "page-prefetch", pageIndex: 2 });
		await vi.waitFor(() => expect(responses).toHaveLength(2));

		expect(responses[1]).toMatchObject({ id: 2, type: "error", fatal: true });
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(closeWorker).toHaveBeenCalledOnce();
	});

	it("skips a queued operation cancelled while another operation is running", async () => {
		const firstOperation = createDeferred<void>();
		const prefetchPage = vi.fn((pageIndex: number) =>
			pageIndex === 1 ? firstOperation.promise : Promise.resolve(),
		);
		const session: DocumentSessionStub = {
			info: { pageCount: 8, fileLength: 1024 },
			isPoisoned: false,
			dispose() {},
			prefetchPage,
		};
		vi.doMock("@/lib/pdfium/document/pdfium-document", () => ({
			PdfiumDocumentSession: class {
				static open(): Promise<DocumentSessionStub> {
					return Promise.resolve(session);
				}
			},
			PdfiumFatalError: class extends Error {},
		}));

		const responses: WorkerResponse[] = [];
		let dispatch: ((request: WorkerMessage) => void) | null = null;
		const workerScope = {
			addEventListener(
				_type: "message",
				listener: (event: MessageEvent<WorkerMessage>) => void,
			) {
				dispatch = (request) => listener({ data: request } as MessageEvent<WorkerMessage>);
			},
			postMessage(message: WorkerResponse): void {
				responses.push(message);
			},
			close() {},
		};
		vi.stubGlobal("self", workerScope);
		await import("./pdfium.worker");

		const send = (request: WorkerMessage): void => {
			if (dispatch === null)
				throw new Error("The PDF worker did not register its message handler.");
			dispatch(request);
		};
		send({
			id: 1,
			type: "open",
			url: "https://example.test/brochure.pdf",
			wasmUrl: "https://example.test/pdfium.wasm",
		});
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		send({ id: 2, type: "page-prefetch", pageIndex: 1 });
		await vi.waitFor(() =>
			expect(prefetchPage).toHaveBeenCalledWith(1, expect.any(AbortSignal)),
		);
		send({ id: 3, type: "page-prefetch", pageIndex: 2 });
		send({ id: 3, type: "cancel" });
		firstOperation.resolve(undefined);
		await vi.waitFor(() => expect(responses).toHaveLength(3));

		expect(prefetchPage).toHaveBeenCalledOnce();
		expect(responses[2]).toMatchObject({ id: 3, type: "error", errorName: "AbortError" });
	});

	it("forwards cancellation to an active asynchronous operation and keeps the worker alive", async () => {
		const prefetchPage = vi.fn((pageIndex: number, signal?: AbortSignal) => {
			if (pageIndex !== 1) return Promise.resolve();
			return new Promise<void>((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("The operation was cancelled.", "AbortError")),
					{ once: true },
				);
			});
		});
		const session: DocumentSessionStub = {
			info: { pageCount: 8, fileLength: 1024 },
			isPoisoned: false,
			dispose() {},
			prefetchPage,
		};
		vi.doMock("@/lib/pdfium/document/pdfium-document", () => ({
			PdfiumDocumentSession: class {
				static open(): Promise<DocumentSessionStub> {
					return Promise.resolve(session);
				}
			},
			PdfiumFatalError: class extends Error {},
		}));

		const responses: WorkerResponse[] = [];
		const closeWorker = vi.fn();
		let dispatch: ((request: WorkerMessage) => void) | null = null;
		const workerScope = {
			addEventListener(
				_type: "message",
				listener: (event: MessageEvent<WorkerMessage>) => void,
			) {
				dispatch = (request) => listener({ data: request } as MessageEvent<WorkerMessage>);
			},
			postMessage(message: WorkerResponse): void {
				responses.push(message);
			},
			close: closeWorker,
		};
		vi.stubGlobal("self", workerScope);
		await import("./pdfium.worker");

		const send = (request: WorkerMessage): void => {
			if (dispatch === null)
				throw new Error("The PDF worker did not register its message handler.");
			dispatch(request);
		};
		send({
			id: 1,
			type: "open",
			url: "https://example.test/brochure.pdf",
			wasmUrl: "https://example.test/pdfium.wasm",
		});
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		send({ id: 2, type: "page-prefetch", pageIndex: 1 });
		await vi.waitFor(() =>
			expect(prefetchPage).toHaveBeenCalledWith(1, expect.any(AbortSignal)),
		);
		send({ id: 2, type: "cancel" });
		await vi.waitFor(() => expect(responses).toHaveLength(2));
		expect(responses[1]).toMatchObject({ id: 2, type: "error", errorName: "AbortError" });

		send({ id: 3, type: "page-prefetch", pageIndex: 2 });
		await vi.waitFor(() => expect(responses).toHaveLength(3));
		expect(prefetchPage).toHaveBeenCalledTimes(2);
		expect(closeWorker).not.toHaveBeenCalled();
	});

	it("promotes an active render and its outstanding range request", async () => {
		let rangeRequester:
			| ((request: RangeTransportRequest, signal: AbortSignal) => Promise<unknown>)
			| undefined;
		const setPriority = vi.fn();
		const session: DocumentSessionStub = {
			info: { pageCount: 8, fileLength: 1024 },
			isPoisoned: false,
			dispose() {},
			async prefetchPage() {},
			setPriority,
			async renderPage(_pageIndex, _scale, priority, signal) {
				if (rangeRequester === undefined || signal === undefined) {
					throw new Error("The PDF range requester was not initialized.");
				}
				await rangeRequester(
					{
						url: "https://example.test/catalog.pdf",
						start: 0,
						requestedEnd: 255,
						totalLength: null,
						etag: null,
						lastModified: null,
						priority,
					},
					signal,
				);
				return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
			},
		};
		vi.doMock("@/lib/pdfium/document/pdfium-document", () => ({
			PdfiumDocumentSession: class {
				static open(
					_url: string,
					_wasmUrl: string,
					_signal: AbortSignal,
					_cacheLimitBytes: number,
					requester?: (
						request: RangeTransportRequest,
						signal: AbortSignal,
					) => Promise<unknown>,
				): Promise<DocumentSessionStub> {
					rangeRequester = requester;
					return Promise.resolve(session);
				}
			},
			PdfiumFatalError: class extends Error {},
		}));

		const messages: unknown[] = [];
		let dispatch: ((request: WorkerMessage) => void) | null = null;
		const workerScope = {
			addEventListener(
				_type: "message",
				listener: (event: MessageEvent<WorkerMessage>) => void,
			) {
				dispatch = (request) => listener({ data: request } as MessageEvent<WorkerMessage>);
			},
			postMessage(message: unknown): void {
				messages.push(message);
			},
			close() {},
		};
		vi.stubGlobal("self", workerScope);
		await import("./pdfium.worker");

		const send = (request: WorkerMessage): void => {
			if (dispatch === null)
				throw new Error("The PDF worker did not register its message handler.");
			dispatch(request);
		};
		send({
			id: 1,
			type: "open",
			url: "https://example.test/catalog.pdf",
			wasmUrl: "https://example.test/pdfium.wasm",
			useRangeBroker: true,
		});
		await vi.waitFor(() =>
			expect(messages).toContainEqual(expect.objectContaining({ type: "opened" })),
		);
		send({ id: 2, type: "render", pageIndex: 1, scale: 1, priority: "prerender" });
		await vi.waitFor(() =>
			expect(messages).toContainEqual(expect.objectContaining({ type: "range-request" })),
		);
		const rangeRequest = messages.find(isRangeRequest);
		if (rangeRequest === undefined)
			throw new Error("The active render did not request a range.");
		send({ id: 2, type: "promote", priority: "visible" });
		expect(setPriority).toHaveBeenCalledWith("visible");
		expect(messages).toContainEqual({
			type: "range-promote",
			id: rangeRequest.id,
			priority: "visible",
		});
		send({
			type: "range-response",
			id: rangeRequest.id,
			response: {
				bytes: new ArrayBuffer(256),
				totalLength: 1024,
				etag: '"catalog-v1"',
				lastModified: null,
				responseUrl: "https://example.test/catalog.pdf",
			},
		});
		await vi.waitFor(() =>
			expect(messages).toContainEqual(expect.objectContaining({ id: 2, type: "rendered" })),
		);
	});

	it("cleans up failed host posts and skips an already-cancelled range request", async () => {
		let dispatch: ((request: WorkerMessage) => void) | null = null;
		let send: ((request: WorkerMessage) => void) | null = null;
		let shouldThrowRangePost = true;
		let cancelBeforeRange = false;
		let activeRenderId = 2;
		let rangeRequester:
			| ((request: RangeTransportRequest, signal: AbortSignal) => Promise<unknown>)
			| undefined;
		const session: DocumentSessionStub = {
			info: { pageCount: 2, fileLength: 1024 },
			isPoisoned: false,
			dispose() {},
			async prefetchPage() {},
			async renderPage(_pageIndex, _scale, priority, signal) {
				if (rangeRequester === undefined || signal === undefined) {
					throw new Error("The PDF range requester was not initialized.");
				}
				if (cancelBeforeRange) send?.({ id: activeRenderId, type: "cancel" });
				await rangeRequester(
					{
						url: "https://example.test/catalog.pdf",
						start: 0,
						requestedEnd: 255,
						totalLength: null,
						etag: null,
						lastModified: null,
						priority,
					},
					signal,
				);
				return { type: "pixels", width: 1, height: 1, pixels: new ArrayBuffer(4) };
			},
		};
		vi.doMock("@/lib/pdfium/document/pdfium-document", () => ({
			PdfiumDocumentSession: class {
				static open(
					_url: string,
					_wasmUrl: string,
					_signal: AbortSignal,
					_cacheLimitBytes: number,
					requester?: (
						request: RangeTransportRequest,
						signal: AbortSignal,
					) => Promise<unknown>,
				): Promise<DocumentSessionStub> {
					rangeRequester = requester;
					return Promise.resolve(session);
				}
			},
			PdfiumFatalError: class extends Error {},
		}));

		const messages: unknown[] = [];
		const workerScope = {
			addEventListener(
				_type: "message",
				listener: (event: MessageEvent<WorkerMessage>) => void,
			) {
				dispatch = (request) => listener({ data: request } as MessageEvent<WorkerMessage>);
			},
			postMessage(message: unknown): void {
				if (isRangeRequest(message) && shouldThrowRangePost) {
					shouldThrowRangePost = false;
					throw new Error("The host could not receive the range request.");
				}
				messages.push(message);
			},
			close() {},
		};
		vi.stubGlobal("self", workerScope);
		await import("./pdfium.worker");

		send = (request) => {
			if (dispatch === null)
				throw new Error("The PDF worker did not register its message handler.");
			dispatch(request);
		};
		send({
			id: 1,
			type: "open",
			url: "https://example.test/catalog.pdf",
			wasmUrl: "https://example.test/pdfium.wasm",
			useRangeBroker: true,
		});
		await vi.waitFor(() =>
			expect(messages).toContainEqual(expect.objectContaining({ type: "opened" })),
		);

		send({ id: 2, type: "render", pageIndex: 0, scale: 1, priority: "visible" });
		await vi.waitFor(() =>
			expect(messages).toContainEqual(expect.objectContaining({ id: 2, type: "error" })),
		);
		expect(messages.filter(isRangeRequest)).toHaveLength(0);

		activeRenderId = 3;
		send({ id: activeRenderId, type: "render", pageIndex: 0, scale: 1, priority: "visible" });
		await vi.waitFor(() => expect(messages.filter(isRangeRequest)).toHaveLength(1));
		const rangeRequest = messages.find(isRangeRequest);
		if (rangeRequest === undefined) throw new Error("The retry did not request a range.");
		send({
			type: "range-response",
			id: rangeRequest.id,
			response: {
				bytes: new ArrayBuffer(256),
				totalLength: 1024,
				etag: '"catalog-v1"',
				lastModified: null,
				responseUrl: "https://example.test/catalog.pdf",
			},
		});
		await vi.waitFor(() =>
			expect(messages).toContainEqual(expect.objectContaining({ id: 3, type: "rendered" })),
		);

		activeRenderId = 4;
		cancelBeforeRange = true;
		send({ id: activeRenderId, type: "render", pageIndex: 1, scale: 1, priority: "visible" });
		await vi.waitFor(() =>
			expect(messages).toContainEqual(expect.objectContaining({ id: 4, type: "error" })),
		);
		expect(messages.filter(isRangeRequest)).toHaveLength(1);
	});
});

function createDeferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
	let resolve: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function isRangeRequest(value: unknown): value is { id: number; type: "range-request" } {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "number" &&
		"type" in value &&
		value.type === "range-request"
	);
}
