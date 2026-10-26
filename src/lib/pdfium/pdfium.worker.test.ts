import { afterEach, describe, expect, it, vi } from "vitest";

interface OpenRequest {
	id: number;
	type: "open";
	url: string;
	wasmUrl: string;
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

type WorkerRequest = OpenRequest | PagePrefetchRequest;
type WorkerMessage = WorkerRequest | CancelRequest;

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
}

describe("PDF worker document lifecycle", () => {
	afterEach(() => {
		vi.doUnmock("./pdfium-document");
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
		vi.doMock("./pdfium-document", () => ({
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
		vi.doMock("./pdfium-document", () => ({
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
		const { PdfRepresentationChangedError } = await import("./range-request");
		const session: DocumentSessionStub = {
			info: { pageCount: 4, fileLength: 1024 },
			isPoisoned: false,
			dispose: vi.fn(),
			async prefetchPage() {
				throw new PdfRepresentationChangedError("The PDF representation changed.");
			},
		};
		vi.doMock("./pdfium-document", () => ({
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
		vi.doMock("./pdfium-document", () => ({
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
		vi.doMock("./pdfium-document", () => ({
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
});

function createDeferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
	let resolve: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
