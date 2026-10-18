import { afterEach, describe, expect, it, vi } from "vitest";

interface OpenRequest {
	id: number;
	type: "open";
	url: string;
	wasmUrl: string;
}

interface WorkerResponse {
	id: number;
	type: string;
	fatal?: boolean;
}

interface DocumentSessionStub {
	readonly info: { pageCount: number; fileLength: number };
	readonly isPoisoned: boolean;
	dispose(): void;
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
		let dispatch: ((request: OpenRequest) => void) | null = null;
		const workerScope = {
			addEventListener(_type: "message", listener: (event: MessageEvent<OpenRequest>) => void) {
				dispatch = (request) => listener({ data: request } as MessageEvent<OpenRequest>);
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
});
