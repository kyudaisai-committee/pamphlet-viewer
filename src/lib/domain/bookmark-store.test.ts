// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "vitest";

import { BookmarkStore } from "./bookmark-store";

const STORAGE_KEY = "pamphlet-viewer.bookmarks.v1";

test("stores sorted bookmarks per resolved document URL and filters invalid pages", () => {
	const storage = createStorage();
	storage.values.set(
		STORAGE_KEY,
		JSON.stringify({
			"https://example.test/first.pdf": [4, 2, 0, 9, 2, "3"],
			"https://example.test/second.pdf": [3],
		}),
	);
	const store = new BookmarkStore(storage);

	expect(store.getBookmarks("https://example.test/first.pdf", 5)).toEqual([2, 4]);
	expect(store.togglePage("https://example.test/first.pdf", 4, 5)).toEqual([2]);
	expect(store.togglePage("https://example.test/first.pdf", 3, 5)).toEqual([2, 3]);
	expect(store.getBookmarks("https://example.test/second.pdf", 5)).toEqual([3]);
});

test("continues in memory when localStorage throws and ignores invalid bookmark pages", () => {
	const storage = {
		getItem(): string {
			throw new Error("Storage access denied.");
		},
		setItem(): void {
			throw new Error("Storage access denied.");
		},
	};
	const store = new BookmarkStore(storage);

	expect(store.togglePage("https://example.test/reader.pdf", 2, 4)).toEqual([2]);
	expect(store.togglePage("https://example.test/reader.pdf", 7, 4)).toEqual([2]);
	expect(store.getBookmarks("https://example.test/reader.pdf", 1)).toEqual([]);
	expect(store.getBookmarks("https://example.test/reader.pdf", 4)).toEqual([2]);
});

test("prefers failed writes for an existing document, including after a storage clear", () => {
	const storage = createStorage();
	const documentKey = "https://example.test/first.pdf";
	storage.values.set(
		STORAGE_KEY,
		JSON.stringify({ [documentKey]: [1, 3], "https://example.test/second.pdf": [2] }),
	);
	const store = new BookmarkStore(storage);
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const eventTarget = new EventTarget();
	let pagesAfterStorageClear: number[] = [];

	Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
	try {
		const unsubscribe = store.subscribe(documentKey, () => {
			pagesAfterStorageClear = store.getBookmarks(documentKey, 5);
		});
		storage.setWriteFailure(true);

		expect(store.togglePage(documentKey, 3, 5)).toEqual([1]);
		expect(store.getBookmarks(documentKey, 5)).toEqual([1]);
		expect(store.togglePage(documentKey, 2, 5)).toEqual([1, 2]);
		expect(store.getBookmarks(documentKey, 5)).toEqual([1, 2]);

		storage.values.delete(STORAGE_KEY);
		const clearEvent = new Event("storage") as StorageEvent;
		Object.defineProperty(clearEvent, "key", { value: null });
		eventTarget.dispatchEvent(clearEvent);
		expect(pagesAfterStorageClear).toEqual([1, 2]);
		expect(store.getBookmarks(documentKey, 5)).toEqual([1, 2]);
		unsubscribe();
	} finally {
		if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
		else Object.defineProperty(globalThis, "window", previousWindow);
	}
});

test("merges the latest other-document bookmarks when a failed write recovers", () => {
	const storage = createStorage();
	const firstDocument = "https://example.test/first.pdf";
	const secondDocument = "https://example.test/second.pdf";
	storage.values.set(
		STORAGE_KEY,
		JSON.stringify({ [firstDocument]: [1, 3], [secondDocument]: [2] }),
	);
	const store = new BookmarkStore(storage);
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const eventTarget = new EventTarget();
	let firstPagesAfterStorageChange: number[] = [];
	let secondPagesAfterStorageChange: number[] = [];

	Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
	try {
		const unsubscribeFirst = store.subscribe(firstDocument, () => {
			firstPagesAfterStorageChange = store.getBookmarks(firstDocument, 5);
		});
		const unsubscribeSecond = store.subscribe(secondDocument, () => {
			secondPagesAfterStorageChange = store.getBookmarks(secondDocument, 5);
		});
		storage.setWriteFailure(true);

		expect(store.togglePage(firstDocument, 3, 5)).toEqual([1]);
		storage.values.set(
			STORAGE_KEY,
			JSON.stringify({ [firstDocument]: [1, 3], [secondDocument]: [2, 4] }),
		);
		const updateEvent = new Event("storage") as StorageEvent;
		Object.defineProperty(updateEvent, "key", { value: STORAGE_KEY });
		eventTarget.dispatchEvent(updateEvent);
		expect(firstPagesAfterStorageChange).toEqual([1]);
		expect(secondPagesAfterStorageChange).toEqual([2, 4]);

		storage.setWriteFailure(false);
		expect(store.togglePage(firstDocument, 2, 5)).toEqual([1, 2]);
		expect(JSON.parse(storage.values.get(STORAGE_KEY) ?? "null")).toEqual({
			[firstDocument]: [1, 2],
			[secondDocument]: [2, 4],
		});
		unsubscribeFirst();
		unsubscribeSecond();
	} finally {
		if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
		else Object.defineProperty(globalThis, "window", previousWindow);
	}
});

test("does not restore another document after its external deletion or storage clear", () => {
	const storage = createStorage();
	const firstDocument = "https://example.test/first.pdf";
	const secondDocument = "https://example.test/second.pdf";
	storage.values.set(
		STORAGE_KEY,
		JSON.stringify({ [firstDocument]: [1, 3], [secondDocument]: [2] }),
	);
	const store = new BookmarkStore(storage);
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const eventTarget = new EventTarget();

	Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
	try {
		const unsubscribeFirst = store.subscribe(firstDocument, () => undefined);
		const unsubscribeSecond = store.subscribe(secondDocument, () => undefined);
		storage.setWriteFailure(true);
		expect(store.togglePage(firstDocument, 3, 5)).toEqual([1]);

		storage.values.set(STORAGE_KEY, JSON.stringify({ [firstDocument]: [1, 3] }));
		const deleteEvent = new Event("storage") as StorageEvent;
		Object.defineProperty(deleteEvent, "key", { value: STORAGE_KEY });
		eventTarget.dispatchEvent(deleteEvent);
		expect(store.getBookmarks(firstDocument, 5)).toEqual([1]);
		expect(store.getBookmarks(secondDocument, 5)).toEqual([]);

		storage.values.delete(STORAGE_KEY);
		const clearEvent = new Event("storage") as StorageEvent;
		Object.defineProperty(clearEvent, "key", { value: null });
		eventTarget.dispatchEvent(clearEvent);
		expect(store.getBookmarks(firstDocument, 5)).toEqual([1]);
		expect(store.getBookmarks(secondDocument, 5)).toEqual([]);
		unsubscribeFirst();
		unsubscribeSecond();
	} finally {
		if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
		else Object.defineProperty(globalThis, "window", previousWindow);
	}
});

test("recovers from malformed stored data and notifies same-page subscribers", () => {
	const storage = createStorage();
	storage.values.set(STORAGE_KEY, "not valid JSON");
	const store = new BookmarkStore(storage);
	let notifications = 0;
	const unsubscribe = store.subscribe("https://example.test/reader.pdf", () => notifications++);

	expect(store.getBookmarks("https://example.test/reader.pdf", 3)).toEqual([]);
	expect(store.togglePage("https://example.test/reader.pdf", 1, 3)).toEqual([1]);
	expect(notifications).toBe(1);
	expect(JSON.parse(storage.values.get(STORAGE_KEY) ?? "null")).toEqual({
		"https://example.test/reader.pdf": [1],
	});
	unsubscribe();
});

function createStorage(): {
	values: Map<string, string>;
	setWriteFailure(value: boolean): void;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
} {
	const values = new Map<string, string>();
	let failWrites = false;
	return {
		values,
		setWriteFailure(value) {
			failWrites = value;
		},
		getItem(key) {
			return values.get(key) ?? null;
		},
		setItem(key, value) {
			if (failWrites) throw new Error("Storage quota exceeded.");
			values.set(key, value);
		},
	};
}
