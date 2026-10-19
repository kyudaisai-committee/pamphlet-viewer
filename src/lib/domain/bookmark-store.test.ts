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
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
} {
	const values = new Map<string, string>();
	return {
		values,
		getItem(key) {
			return values.get(key) ?? null;
		},
		setItem(key, value) {
			values.set(key, value);
		},
	};
}
