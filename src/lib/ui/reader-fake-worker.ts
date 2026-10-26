import { expect } from "vitest";

export interface ReaderWorkerRequest {
	id: number;
	type: string;
	url?: string;
	pageIndex?: number;
	scale?: number;
}

export class ControlledWorker extends EventTarget {
	static instances: ControlledWorker[] = [];
	readonly requests: ReaderWorkerRequest[] = [];
	terminateCalls = 0;

	constructor() {
		super();
		ControlledWorker.instances.push(this);
	}

	postMessage(message: unknown): void {
		if (!isReaderWorkerRequest(message))
			throw new Error("The viewer sent an invalid worker request.");
		this.requests.push(message);
		if (message.type === "page-prefetch") {
			queueMicrotask(() => this.reply({ id: message.id, type: "page-prefetch" }));
		}
		if (message.type === "thumbnail-prefetch") {
			queueMicrotask(() =>
				this.reply({ id: message.id, type: "thumbnail-prefetch", visual: null }),
			);
		}
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	reply(message: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: message }));
	}
}

export function resetControlledWorkers(): void {
	ControlledWorker.instances = [];
}

export async function waitForWorkerRequest(
	worker: ControlledWorker,
	type: string,
	startIndex = 0,
): Promise<ReaderWorkerRequest> {
	let request: ReaderWorkerRequest | undefined;
	try {
		await expect
			.poll(() => {
				request = worker.requests.slice(startIndex).find((candidate) => candidate.type === type);
				return request !== undefined;
			})
			.toBe(true);
	} catch (error) {
		throw new Error(
			`The ${type} request was not sent; received ${JSON.stringify(worker.requests)}.`,
			{ cause: error },
		);
	}
	if (request === undefined) throw new Error(`The ${type} request was not sent.`);
	return request;
}

export async function answerPageSizeRequestsUntilRender(
	worker: ControlledWorker,
	startIndex = 0,
): Promise<ReaderWorkerRequest> {
	const requests = worker.requests.slice(startIndex);
	const handledRequestIds = new Set<number>();
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const pendingRequests = worker.requests.slice(startIndex);
		const nextPageSize = pendingRequests.find(
			(request) => request.type === "page-size" && !handledRequestIds.has(request.id),
		);
		if (nextPageSize !== undefined) {
			handledRequestIds.add(nextPageSize.id);
			worker.reply({
				id: nextPageSize.id,
				type: "page-size",
				pageSize: { width: 300, height: 400 },
			});
			continue;
		}
		const render = pendingRequests.find((request) => request.type === "render");
		if (render !== undefined) return render;
		await expect
			.poll(() =>
				worker.requests
					.slice(startIndex)
					.some(
						(request) =>
							request.type === "render" ||
							(request.type === "page-size" && !handledRequestIds.has(request.id)),
					),
			)
			.toBe(true);
	}
	throw new Error(`Render did not start after page-size responses: ${JSON.stringify(requests)}.`);
}

export function waitForViewerReady(element: HTMLElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("ready", () => resolve(), { once: true }),
	);
}

export function getControlledWorker(index: number): ControlledWorker {
	const worker = ControlledWorker.instances[index];
	if (worker === undefined) throw new Error(`Worker ${index} was not created.`);
	return worker;
}

function isReaderWorkerRequest(value: unknown): value is ReaderWorkerRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "number" &&
		"type" in value &&
		typeof value.type === "string" &&
		(!("url" in value) || typeof value.url === "string") &&
		(!("pageIndex" in value) || typeof value.pageIndex === "number") &&
		(!("scale" in value) || typeof value.scale === "number")
	);
}
