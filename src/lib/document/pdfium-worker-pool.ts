// SPDX-License-Identifier: MIT

import { PdfiumWorkerClient, PdfiumWorkerUnavailableError } from "../pdfium/worker-client";
import type { PageVisual } from "./page-source";

interface PdfiumWorkerSlot {
	client: PdfiumWorkerClient | null;
	opening: Promise<PdfiumWorkerClient> | null;
	activeRenders: number;
}

export class PdfiumWorkerPool {
	#slots: [PdfiumWorkerSlot, PdfiumWorkerSlot];
	#disposed = false;

	constructor(
		private readonly source: string,
		private readonly pageCount: number,
		firstClient: PdfiumWorkerClient | null = null,
	) {
		this.#slots = [
			{
				client: firstClient,
				opening: firstClient === null ? null : Promise.resolve(firstClient),
				activeRenders: 0,
			},
			{ client: null, opening: null, activeRenders: 0 },
		];
	}

	renderPage(pageIndex: number, scale: number): Promise<PageVisual> {
		this.#assertActive();
		const slot =
			this.#slots[0].activeRenders <= this.#slots[1].activeRenders
				? this.#slots[0]
				: this.#slots[1];
		slot.activeRenders += 1;
		return this.#render(slot, pageIndex, scale).finally(() => {
			slot.activeRenders -= 1;
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const slot of this.#slots) slot.client?.terminate();
	}

	async #render(slot: PdfiumWorkerSlot, pageIndex: number, scale: number): Promise<PageVisual> {
		const client = await this.#open(slot);
		this.#assertActive();
		return client.renderPage(pageIndex, scale);
	}

	async #open(slot: PdfiumWorkerSlot): Promise<PdfiumWorkerClient> {
		this.#assertActive();
		if (slot.opening === null) {
			const client = new PdfiumWorkerClient();
			slot.client = client;
			slot.opening = client
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
					slot.opening = null;
					throw error;
				});
		}
		return slot.opening;
	}

	#assertActive(): void {
		if (this.#disposed) {
			throw new DOMException("PDF document is no longer available.", "AbortError");
		}
	}
}
