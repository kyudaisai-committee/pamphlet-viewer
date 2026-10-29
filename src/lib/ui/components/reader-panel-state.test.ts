import { describe, expect, test } from "vitest";

import {
	closeReaderPanel,
	createReaderPanelState,
	getActiveReaderPanel,
	normalizeReaderPanelState,
	selectReaderPanel,
	toggleReaderPanel,
} from "./reader-panel-state";

const ALL_PANELS_AVAILABLE = { chapters: true, bookmarks: true };

describe("reader panel state", () => {
	test("reopens the last selected tab from the generic sidebar toggle", () => {
		const initialState = createReaderPanelState();
		const openedChapters = toggleReaderPanel(initialState, "chapters", ALL_PANELS_AVAILABLE);
		const closed = toggleReaderPanel(openedChapters, "pages", ALL_PANELS_AVAILABLE);

		expect(closed).toEqual({ open: false, selectedTab: "chapters" });
		expect(toggleReaderPanel(closed, "pages", ALL_PANELS_AVAILABLE)).toEqual({
			open: true,
			selectedTab: "chapters",
		});
	});

	test("dedicated shortcuts select their tab and toggle it closed when already selected", () => {
		const bookmarks = toggleReaderPanel(
			createReaderPanelState(),
			"bookmarks",
			ALL_PANELS_AVAILABLE,
		);
		expect(bookmarks).toEqual({ open: true, selectedTab: "bookmarks" });
		expect(toggleReaderPanel(bookmarks, "chapters", ALL_PANELS_AVAILABLE)).toEqual({
			open: true,
			selectedTab: "chapters",
		});
		expect(toggleReaderPanel(bookmarks, "bookmarks", ALL_PANELS_AVAILABLE)).toEqual({
			open: false,
			selectedTab: "bookmarks",
		});
	});

	test("falls back to pages when the selected chapter or bookmark panel is unavailable", () => {
		const chapters = selectReaderPanel(
			createReaderPanelState(),
			"chapters",
			ALL_PANELS_AVAILABLE,
		);
		const bookmarks = selectReaderPanel(
			createReaderPanelState(),
			"bookmarks",
			ALL_PANELS_AVAILABLE,
		);
		const chaptersUnavailable = normalizeReaderPanelState(chapters, {
			chapters: false,
			bookmarks: true,
		});
		const bookmarksUnavailable = normalizeReaderPanelState(bookmarks, {
			chapters: true,
			bookmarks: false,
		});

		expect(chaptersUnavailable).toEqual({ open: true, selectedTab: "pages" });
		expect(bookmarksUnavailable).toEqual({ open: true, selectedTab: "pages" });
		expect(getActiveReaderPanel(bookmarks, { chapters: true, bookmarks: false })).toBe("pages");
	});

	test("closing preserves the selected tab while reset returns to the initial page tab", () => {
		const bookmarks = selectReaderPanel(
			createReaderPanelState(),
			"bookmarks",
			ALL_PANELS_AVAILABLE,
		);

		expect(closeReaderPanel(bookmarks)).toEqual({ open: false, selectedTab: "bookmarks" });
		expect(createReaderPanelState()).toEqual({ open: false, selectedTab: "pages" });
	});
});
