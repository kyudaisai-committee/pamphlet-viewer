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
	static lastOpenedDocumentInfo: {
		pageCount: number;
		fileLength: number;
	} | null = null;
	readonly requests: ReaderWorkerRequest[] = [];
	readonly repliedRequestIds = new Set<number>();
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
				this.reply({
					id: message.id,
					type: "thumbnail-prefetch",
					visual: null,
				}),
			);
		}
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	reply(message: unknown): void {
		if (isReaderWorkerRequest(message)) {
			this.repliedRequestIds.add(message.id);
			if (
				message.type === "opened" &&
				"pageCount" in message &&
				typeof message.pageCount === "number" &&
				"fileLength" in message &&
				typeof message.fileLength === "number"
			) {
				ControlledWorker.lastOpenedDocumentInfo = {
					pageCount: message.pageCount,
					fileLength: message.fileLength,
				};
			}
		}
		this.dispatchEvent(new MessageEvent("message", { data: message }));
	}
}

export function resetControlledWorkers(): void {
	ControlledWorker.instances = [];
	ControlledWorker.lastOpenedDocumentInfo = null;
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
				request = worker.requests
					.slice(startIndex)
					.find((candidate) => candidate.type === type);
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
): Promise<{ worker: ControlledWorker; request: ReaderWorkerRequest }> {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		for (const candidate of ControlledWorker.instances) {
			if (candidate.terminateCalls > 0) continue;
			const requests =
				candidate === worker ? candidate.requests.slice(startIndex) : candidate.requests;
			const nextOpen = requests.find(
				(request) =>
					request.type === "open" && !candidate.repliedRequestIds.has(request.id),
			);
			if (nextOpen !== undefined && ControlledWorker.lastOpenedDocumentInfo !== null) {
				candidate.reply({
					id: nextOpen.id,
					type: "opened",
					...ControlledWorker.lastOpenedDocumentInfo,
				});
				continue;
			}
			const nextPageSize = requests.find(
				(request) =>
					request.type === "page-size" && !candidate.repliedRequestIds.has(request.id),
			);
			if (nextPageSize !== undefined) {
				candidate.reply({
					id: nextPageSize.id,
					type: "page-size",
					pageSize: { width: 300, height: 400 },
				});
				continue;
			}
			const render = requests.find(
				(request) =>
					request.type === "render" && !candidate.repliedRequestIds.has(request.id),
			);
			if (render !== undefined) return { worker: candidate, request: render };
		}
		await expect
			.poll(() =>
				ControlledWorker.instances.some(
					(candidate) =>
						candidate.terminateCalls === 0 &&
						candidate.requests.some(
							(request) =>
								!candidate.repliedRequestIds.has(request.id) &&
								(request.type === "open" ||
									request.type === "page-size" ||
									request.type === "render"),
						),
				),
			)
			.toBe(true);
	}
	throw new Error("Render did not start after page-size responses.");
}

export async function answerOpenRequests(startIndex: number): Promise<void> {
	await expect
		.poll(() => {
			const pendingWorkers = ControlledWorker.instances.slice(startIndex);
			if (pendingWorkers.length === 0 || ControlledWorker.lastOpenedDocumentInfo === null) {
				return false;
			}
			for (const worker of pendingWorkers) {
				const open = worker.requests.find(
					(request) =>
						request.type === "open" && !worker.repliedRequestIds.has(request.id),
				);
				if (open === undefined) continue;
				worker.reply({
					id: open.id,
					type: "opened",
					...ControlledWorker.lastOpenedDocumentInfo,
				});
			}
			return pendingWorkers.some((worker) =>
				worker.requests.some((request) => request.type === "open"),
			);
		})
		.toBe(true);
}

export async function waitForWorkerRequestAcrossInstances(
	type: string,
	startIndex = 0,
): Promise<{ worker: ControlledWorker; request: ReaderWorkerRequest }> {
	let found: { worker: ControlledWorker; request: ReaderWorkerRequest } | undefined;
	await expect
		.poll(() => {
			found = undefined;
			for (const worker of ControlledWorker.instances.slice(startIndex)) {
				const request = worker.requests.find(
					(candidate) =>
						candidate.type === type && !worker.repliedRequestIds.has(candidate.id),
				);
				if (request !== undefined) {
					found = { worker, request };
					return true;
				}
			}
			return false;
		})
		.toBe(true);
	if (found === undefined) throw new Error(`The ${type} request was not sent.`);
	return found;
}

export async function waitForWorkerRequestAfterOpening(
	type: string,
	startIndex = 0,
	matches: (request: ReaderWorkerRequest) => boolean = () => true,
): Promise<{ worker: ControlledWorker; request: ReaderWorkerRequest }> {
	let found: { worker: ControlledWorker; request: ReaderWorkerRequest } | undefined;
	await expect
		.poll(() => {
			found = undefined;
			for (const worker of ControlledWorker.instances.slice(startIndex)) {
				for (const request of worker.requests) {
					if (worker.repliedRequestIds.has(request.id)) continue;
					if (request.type === type && matches(request)) {
						found = { worker, request };
						return true;
					}
					if (
						request.type === "open" &&
						ControlledWorker.lastOpenedDocumentInfo !== null
					) {
						worker.reply({
							id: request.id,
							type: "opened",
							...ControlledWorker.lastOpenedDocumentInfo,
						});
						continue;
					}
					if (request.type === "page-size") {
						worker.reply({
							id: request.id,
							type: "page-size",
							pageSize: { width: 300, height: 400 },
						});
					}
				}
			}
			return false;
		})
		.toBe(true);
	if (found === undefined) throw new Error(`The ${type} request was not sent.`);
	return found;
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
