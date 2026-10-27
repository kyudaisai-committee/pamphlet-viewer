// SPDX-License-Identifier: MIT

import { bookmarkStore } from "./bookmark-store";

export class ViewerBookmarks {
	pages = $state<number[]>([]);

	connect(documentKey: string | null, pageCount: number, enabled: boolean): () => void {
		if (documentKey === null || !enabled) {
			this.pages = [];
			return () => undefined;
		}

		this.pages = bookmarkStore.getBookmarks(documentKey, pageCount);
		return bookmarkStore.subscribe(documentKey, () => {
			this.pages = bookmarkStore.getBookmarks(documentKey, pageCount);
		});
	}

	toggleCurrentPage(
		documentKey: string | null,
		page: number,
		pageCount: number,
		enabled: boolean,
	): void {
		if (documentKey === null || !enabled) return;
		this.pages = bookmarkStore.togglePage(documentKey, page, pageCount);
	}

	findPage(value: string, enabled: boolean): number | undefined {
		if (!enabled) return undefined;
		return this.pages.find((page) => String(page) === value);
	}
}
