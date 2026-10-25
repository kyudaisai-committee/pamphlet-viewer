// SPDX-License-Identifier: MPL-2.0

interface BookmarkStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const STORAGE_KEY = "pamphlet-viewer.bookmarks.v1";

export class BookmarkStore {
	#fallback = new Map<string, number[] | null>();
	#subscribers = new Map<string, Set<() => void>>();
	#listening = false;
	#storage: BookmarkStorage | null;
	#onStorage = (event: StorageEvent): void => {
		if (event.key !== null && event.key !== STORAGE_KEY) return;
		for (const listeners of this.#subscribers.values()) {
			for (const listener of listeners) listener();
		}
	};

	constructor(storage: BookmarkStorage | null = getLocalStorage()) {
		this.#storage = storage;
	}

	getBookmarks(documentKey: string, pageCount: number): number[] {
		if (!isValidDocumentKey(documentKey) || !isValidPageCount(pageCount)) return [];
		const pages = this.#readRecords().get(documentKey) ?? [];
		return normalizePages(pages, pageCount);
	}

	togglePage(documentKey: string, page: number, pageCount: number): number[] {
		if (
			!isValidDocumentKey(documentKey) ||
			!isValidPageCount(pageCount) ||
			!isValidPage(page, pageCount)
		) {
			return this.getBookmarks(documentKey, pageCount);
		}

		const pages = this.getBookmarks(documentKey, pageCount);
		const existingIndex = pages.indexOf(page);
		if (existingIndex === -1) pages.push(page);
		else pages.splice(existingIndex, 1);
		pages.sort((left, right) => left - right);

		const records = this.#readRecords();
		records.set(documentKey, pages);
		this.#saveRecords(records, documentKey);
		this.#notify(documentKey);
		return pages;
	}

	subscribe(documentKey: string, listener: () => void): () => void {
		if (!isValidDocumentKey(documentKey)) return () => undefined;
		const listeners = this.#subscribers.get(documentKey) ?? new Set<() => void>();
		listeners.add(listener);
		this.#subscribers.set(documentKey, listeners);
		if (!this.#listening && typeof window !== "undefined") {
			window.addEventListener("storage", this.#onStorage);
			this.#listening = true;
		}

		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.#subscribers.delete(documentKey);
			if (this.#subscribers.size === 0 && this.#listening && typeof window !== "undefined") {
				window.removeEventListener("storage", this.#onStorage);
				this.#listening = false;
			}
		};
	}

	#readRecords(): Map<string, number[]> {
		let records = new Map<string, number[]>();
		if (this.#storage !== null) {
			try {
				const serialized = this.#storage.getItem(STORAGE_KEY);
				if (serialized !== null) records = parseRecords(serialized) ?? records;
			} catch {
				// Retain pending in-memory changes when storage cannot be read.
			}
		}

		for (const [key, pages] of this.#fallback) {
			if (pages === null) records.delete(key);
			else records.set(key, pages.slice());
		}
		return records;
	}

	#saveRecords(records: Map<string, number[]>, documentKey: string): void {
		const mergedRecords = this.#readRecords();
		const pages = records.get(documentKey);
		if (pages === undefined) mergedRecords.delete(documentKey);
		else mergedRecords.set(documentKey, pages);
		const serialized = JSON.stringify(Object.fromEntries(mergedRecords));
		try {
			if (this.#storage === null) throw new Error("Local storage is unavailable.");
			this.#storage.setItem(STORAGE_KEY, serialized);
			this.#fallback.clear();
		} catch {
			this.#fallback.set(documentKey, pages?.slice() ?? null);
		}
	}

	#notify(documentKey: string): void {
		for (const listener of this.#subscribers.get(documentKey) ?? []) listener();
	}
}

export const bookmarkStore = new BookmarkStore();

function getLocalStorage(): BookmarkStorage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function parseRecords(serialized: string): Map<string, number[]> | null {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	const records = new Map<string, number[]>();
	for (const [documentKey, pages] of Object.entries(value)) {
		if (Array.isArray(pages)) records.set(documentKey, normalizeStoredPages(pages));
	}
	return records;
}

function normalizeStoredPages(pages: readonly unknown[]): number[] {
	return [...new Set(pages.filter(isPositivePage))].sort((left, right) => left - right);
}

function normalizePages(pages: readonly number[], pageCount: number): number[] {
	return pages.filter((page) => isValidPage(page, pageCount));
}

function isPositivePage(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidPage(value: number, pageCount: number): boolean {
	return isPositivePage(value) && value <= pageCount;
}

function isValidPageCount(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function isValidDocumentKey(value: string): boolean {
	return value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
