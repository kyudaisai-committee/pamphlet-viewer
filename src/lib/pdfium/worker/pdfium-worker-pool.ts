// SPDX-License-Identifier: MIT

import type { PageSize, PageVisual } from "@/lib/document/page-source";
import {
	PageTaskScheduler,
	type PageTaskLease,
	type PageTaskPriority,
} from "@/lib/domain/scheduling/page-task-scheduler";
import { PdfRangeBroker } from "@/lib/pdfium/range/pdf-range-broker";

import { PdfiumWorkerClient, PdfiumWorkerUnavailableError } from "./worker-client";

export const PDFIUM_WORKER_LIMIT = 4;
export const PDFIUM_VISIBLE_CONCURRENCY = 2;
const WORKER_TERMINATION_GRACE_MS = 100;

interface PdfiumWorkerSlot {
	client: PdfiumWorkerClient | null;
	opening: Promise<PdfiumWorkerClient> | null;
	openingController: AbortController | null;
	openingConsumers: number;
	activeRequests: number;
	activeSignals: Set<AbortSignal>;
	activeOperationCount: number;
}

type WorkerOperation<Result> = (
	client: PdfiumWorkerClient,
	priority: PageTaskPriority,
	signal: AbortSignal,
) => Promise<Result>;

export class PdfiumWorkerPool {
	#slots: PdfiumWorkerSlot[];
	#scheduler: PageTaskScheduler;
	#consumerControllers = new Map<PageTaskPriority, Set<AbortController>>();
	#blockedVisibleTimer: ReturnType<typeof setTimeout> | null = null;
	#disposed = false;

	constructor(
		private readonly source: string,
		private readonly pageCount: number,
		private readonly rangeBroker: PdfRangeBroker,
		firstClient: PdfiumWorkerClient | null = null,
		slotCount = PDFIUM_WORKER_LIMIT,
	) {
		if (!Number.isSafeInteger(slotCount) || slotCount < 1 || slotCount > PDFIUM_WORKER_LIMIT) {
			throw new RangeError(
				`The PDF worker pool supports between 1 and ${PDFIUM_WORKER_LIMIT} workers.`,
			);
		}
		this.#slots = Array.from({ length: slotCount }, (_, index) => ({
			client: index === 0 ? firstClient : null,
			opening: index === 0 && firstClient !== null ? Promise.resolve(firstClient) : null,
			openingController: null,
			openingConsumers: 0,
			activeRequests: 0,
			activeSignals: new Set(),
			activeOperationCount: 0,
		}));
		this.#scheduler = new PageTaskScheduler({
			maximumConcurrent: slotCount,
			reservedVisible: Math.min(PDFIUM_VISIBLE_CONCURRENCY, slotCount - 1),
			onVisibleBlocked: () => this.#scheduleVisibleRecovery(),
		});
	}

	getPageSize(
		pageIndex: number,
		priority: PageTaskPriority = "visible",
		signal?: AbortSignal,
	): Promise<PageSize> {
		return this.#scheduleTask(
			`size:${pageIndex}`,
			priority,
			(client, taskPriority, signal) => client.getPageSize(pageIndex, taskPriority, signal),
			signal,
		);
	}

	prefetchPage(pageIndex: number): Promise<void> {
		return this.#scheduleTask(`data:${pageIndex}`, "data", (client, _priority, signal) =>
			client.prefetchPage(pageIndex, signal),
		);
	}

	renderPage(
		pageIndex: number,
		scale: number,
		priority: PageTaskPriority = "visible",
		signal?: AbortSignal,
	): Promise<PageVisual> {
		return this.#scheduleVisualTask(
			`render:${pageIndex}:${scale}`,
			priority,
			(client, taskPriority, signal) =>
				client.renderPage(pageIndex, scale, taskPriority, signal),
			signal,
		).then((visual) => {
			if (visual === null) throw new Error("PDF worker did not return a page image.");
			return visual;
		});
	}

	renderThumbnail(pageIndex: number): Promise<PageVisual | null> {
		return this.#scheduleVisualTask(
			`thumbnail:${pageIndex}`,
			"thumbnail",
			(client, _priority, signal) => client.renderThumbnail(pageIndex, signal),
		);
	}

	promoteRender(pageIndex: number, scale: number): boolean {
		return this.#scheduler.promote(`render:${pageIndex}:${scale}`, "visible");
	}

	prefetchThumbnail(pageIndex: number): Promise<PageVisual | null> {
		return this.#scheduleVisualTask(
			`thumbnail:${pageIndex}`,
			"thumbnail",
			(client, _priority, signal) => client.prefetchThumbnail(pageIndex, signal),
		);
	}

	interrupt(): void {
		this.cancelRequests("visible");
	}

	interruptPrefetch(): void {
		this.cancelRequests("data");
	}

	cancelRequests(priority: PageTaskPriority): void {
		for (const controller of this.#consumerControllers.get(priority) ?? []) controller.abort();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const controllers of this.#consumerControllers.values()) {
			for (const controller of controllers) controller.abort();
		}
		this.#consumerControllers.clear();
		if (this.#blockedVisibleTimer !== null) clearTimeout(this.#blockedVisibleTimer);
		this.#blockedVisibleTimer = null;
		this.#scheduler.dispose();
		this.#resetSlots();
	}

	#scheduleTask<Result>(
		key: string,
		priority: PageTaskPriority,
		operation: WorkerOperation<Result>,
		signal?: AbortSignal,
		releaseResult?: (result: Result) => void,
	): Promise<Result> {
		return this.#scheduleLeaseTask(key, priority, operation, releaseResult, signal).then(
			(lease) => {
				const result = lease.value;
				lease.release();
				return result;
			},
		);
	}

	#scheduleLeaseTask<Result>(
		key: string,
		priority: PageTaskPriority,
		operation: WorkerOperation<Result>,
		releaseResult?: (result: Result) => void,
		signal?: AbortSignal,
	): Promise<PageTaskLease<Result>> {
		this.#assertActive();
		const controller = new AbortController();
		const abortFromSignal = (): void => controller.abort();
		if (signal?.aborted) controller.abort();
		else signal?.addEventListener("abort", abortFromSignal, { once: true });
		const controllers = this.#consumerControllers.get(priority) ?? new Set<AbortController>();
		controllers.add(controller);
		this.#consumerControllers.set(priority, controllers);
		return this.#scheduler
			.schedule(
				{
					key,
					priority,
					execute: (signal, taskPriority) =>
						this.#executeWithRecovery(operation, taskPriority, signal),
					releaseResult,
				},
				controller.signal,
			)
			.finally(() => {
				signal?.removeEventListener("abort", abortFromSignal);
				controllers.delete(controller);
				if (controllers.size === 0) this.#consumerControllers.delete(priority);
			});
	}

	async #scheduleVisualTask(
		key: string,
		priority: PageTaskPriority,
		operation: WorkerOperation<PageVisual | null>,
		signal?: AbortSignal,
	): Promise<PageVisual | null> {
		const lease = await this.#scheduleLeaseTask(
			key,
			priority,
			operation,
			releaseVisualResult,
			signal,
		);
		try {
			if (lease.value === null) return null;
			return await clonePageVisual(lease.value);
		} finally {
			lease.release();
		}
	}

	async #executeWithRecovery<Result>(
		operation: WorkerOperation<Result>,
		priority: PageTaskPriority,
		signal: AbortSignal,
	): Promise<Result> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				return await this.#runOnSlot(operation, priority, signal);
			} catch (error) {
				if (
					!(error instanceof PdfiumWorkerUnavailableError) ||
					attempt === 1 ||
					signal.aborted
				) {
					throw error;
				}
			}
		}
		throw new PdfiumWorkerUnavailableError("The PDF worker could not process the request.");
	}

	async #runOnSlot<Result>(
		operation: WorkerOperation<Result>,
		priority: PageTaskPriority,
		signal: AbortSignal,
	): Promise<Result> {
		this.#assertActive();
		if (signal.aborted) throw createAbortError();
		const slot = this.#getLeastBusySlot();
		slot.activeRequests += 1;
		slot.activeSignals.add(signal);
		let operationStarted = false;
		try {
			const client = await this.#open(slot, signal);
			this.#assertActive();
			if (signal.aborted) throw createAbortError();
			slot.activeOperationCount += 1;
			operationStarted = true;
			return await operation(client, priority, signal);
		} catch (error) {
			if (error instanceof PdfiumWorkerUnavailableError) this.#resetSlot(slot);
			throw error;
		} finally {
			slot.activeRequests -= 1;
			slot.activeSignals.delete(signal);
			if (operationStarted) slot.activeOperationCount -= 1;
			this.#scheduleVisibleRecovery();
		}
	}

	#scheduleVisibleRecovery(): void {
		if (this.#disposed || this.#blockedVisibleTimer !== null) return;
		this.#blockedVisibleTimer = setTimeout(() => {
			this.#blockedVisibleTimer = null;
			if (this.#disposed || !this.#scheduler.isVisibleBlocked) return;
			const stalledSlot = this.#slots.find(
				(slot) =>
					(slot.openingController?.signal.aborted === true &&
						slot.openingConsumers === 0 &&
						slot.client?.isOpen !== true) ||
					(slot.activeOperationCount > 0 &&
						slot.activeRequests > 0 &&
						slot.activeSignals.size > 0 &&
						[...slot.activeSignals].every((signal) => signal.aborted) &&
						slot.client?.isOpen === true &&
						slot.client.pendingRangeRequestCount === 0),
			);
			if (stalledSlot !== undefined) this.#resetSlot(stalledSlot);
		}, WORKER_TERMINATION_GRACE_MS);
	}

	async #open(slot: PdfiumWorkerSlot, signal: AbortSignal): Promise<PdfiumWorkerClient> {
		this.#assertActive();
		if (signal.aborted) throw createAbortError();
		if (slot.openingController?.signal.aborted === true && slot.client?.isOpen !== true) {
			this.#resetSlot(slot);
		}
		if (slot.opening === null) {
			const client = new PdfiumWorkerClient(this.rangeBroker);
			const controller = new AbortController();
			slot.client = client;
			slot.openingController = controller;
			const opening = client
				.open(this.source, true, controller.signal)
				.then((info) => {
					if (info.pageCount !== this.pageCount) {
						throw new PdfiumWorkerUnavailableError(
							"The PDF source changed while its pages were rendering.",
						);
					}
					if (slot.opening === opening) slot.openingController = null;
					this.#scheduleVisibleRecovery();
					return client;
				})
				.catch((error: unknown) => {
					client.terminate();
					if (slot.client === client) slot.client = null;
					if (slot.opening === opening) {
						slot.opening = null;
						slot.openingController = null;
						slot.openingConsumers = 0;
					}
					this.#scheduleVisibleRecovery();
					throw error;
				});
			slot.opening = opening;
		}
		const opening = slot.opening;
		if (opening === null) throw new Error("The PDF worker failed to start opening.");
		slot.openingConsumers += 1;
		try {
			return await waitForSignal(opening, signal);
		} finally {
			if (slot.opening === opening) {
				slot.openingConsumers -= 1;
				if (slot.openingConsumers === 0 && slot.openingController !== null) {
					slot.openingController.abort();
					this.#scheduleVisibleRecovery();
				}
			}
		}
	}

	#getLeastBusySlot(): PdfiumWorkerSlot {
		const firstSlot = this.#slots[0];
		if (firstSlot === undefined) {
			throw new Error("The PDF worker pool has no available slots.");
		}
		let leastBusySlot = firstSlot;
		for (const slot of this.#slots.slice(1)) {
			if (slot.activeRequests < leastBusySlot.activeRequests) leastBusySlot = slot;
		}
		return leastBusySlot;
	}

	#resetSlots(): void {
		for (const slot of this.#slots) this.#resetSlot(slot);
	}

	#resetSlot(slot: PdfiumWorkerSlot): void {
		slot.openingController?.abort();
		slot.client?.terminate();
		slot.client = null;
		slot.opening = null;
		slot.openingController = null;
		slot.openingConsumers = 0;
	}

	#assertActive(): void {
		if (this.#disposed) {
			throw new DOMException("PDF document is no longer available.", "AbortError");
		}
	}
}

async function clonePageVisual(visual: PageVisual): Promise<PageVisual> {
	if (visual.type === "pixels") {
		return {
			type: "pixels",
			width: visual.width,
			height: visual.height,
			pixels: visual.pixels.slice(0),
		};
	}
	return {
		type: "bitmap",
		width: visual.width,
		height: visual.height,
		bitmap: await createImageBitmap(visual.bitmap),
	};
}

function releaseVisualResult(visual: PageVisual | null): void {
	if (visual?.type === "bitmap") visual.bitmap.close();
}

function createAbortError(): DOMException {
	return new DOMException("PDF page task was cancelled.", "AbortError");
}

function waitForSignal<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) return Promise.reject(createAbortError());
	return new Promise((resolve, reject) => {
		const abort = function rejectWhenSignalAborts(): void {
			signal.removeEventListener("abort", abort);
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}
