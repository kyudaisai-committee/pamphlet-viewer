// SPDX-License-Identifier: MIT

import { PdfiumWorkerClient, PdfiumWorkerUnavailableError } from "../pdfium/worker-client";
import type { PageSize, PageVisual } from "./page-source";

interface PdfiumWorkerSlot {
	client: PdfiumWorkerClient | null;
	opening: Promise<PdfiumWorkerClient> | null;
	activeRequests: number;
}

export class PdfiumWorkerPool {
	#slots: PdfiumWorkerSlot[];
	#disposed = false;

	constructor(
		private readonly source: string,
		private readonly pageCount: number,
		firstClient: PdfiumWorkerClient | null = null,
		slotCount = 2,
	) {
		this.#slots = Array.from({ length: slotCount }, (_, index) => ({
			client: index === 0 ? firstClient : null,
			opening: index === 0 && firstClient !== null ? Promise.resolve(firstClient) : null,
			activeRequests: 0,
		}));
	}

	getPageSize(pageIndex: number): Promise<PageSize> {
		return this.#run((client) => client.getPageSize(pageIndex));
	}

	prefetchPage(pageIndex: number): Promise<void> {
		return this.#run((client) => client.prefetchPage(pageIndex));
	}

	renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		return this.#run((client) => client.renderPage(pageIndex, scale));
	}

	interrupt(): void {
		if (this.#disposed) return;
		for (const slot of this.#slots) {
			if (slot.activeRequests > 0) this.#resetSlot(slot);
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#resetSlots();
	}

	#run<Result>(operation: (client: PdfiumWorkerClient) => Promise<Result>): Promise<Result> {
		this.#assertActive();
		const slot = this.#getLeastBusySlot();
		slot.activeRequests += 1;
		return this.#runOnSlot(slot, operation).finally(() => {
			slot.activeRequests -= 1;
		});
	}

	async #runOnSlot<Result>(
		slot: PdfiumWorkerSlot,
		operation: (client: PdfiumWorkerClient) => Promise<Result>,
	): Promise<Result> {
		const client = await this.#open(slot);
		this.#assertActive();
		return operation(client);
	}

	async #open(slot: PdfiumWorkerSlot): Promise<PdfiumWorkerClient> {
		this.#assertActive();
		if (slot.opening === null) {
			const client = new PdfiumWorkerClient();
			slot.client = client;
			const opening = client
				.open(this.source)
				.then((info) => {
					if (info.pageCount !== this.pageCount) {
						throw new PdfiumWorkerUnavailableError(
							"The PDF source changed while its pages were rendering.",
						);
					}
					return client;
				})
				.catch((error: unknown) => {
					client.terminate();
					if (slot.client === client) slot.client = null;
					if (slot.opening === opening) slot.opening = null;
					throw error;
				});
			slot.opening = opening;
		}
		return slot.opening;
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
		slot.client?.terminate();
		slot.client = null;
		slot.opening = null;
	}

	#assertActive(): void {
		if (this.#disposed) {
			throw new DOMException("PDF document is no longer available.", "AbortError");
		}
	}
}
