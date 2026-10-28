// SPDX-License-Identifier: MIT

export type ReaderPanelTab = "pages" | "chapters" | "bookmarks";

export interface ReaderPanelAvailability {
	chapters: boolean;
	bookmarks: boolean;
}

export interface ReaderPanelState {
	open: boolean;
	selectedTab: ReaderPanelTab;
}

export function createReaderPanelState(): ReaderPanelState {
	return { open: false, selectedTab: "pages" };
}

export function getActiveReaderPanel(
	state: ReaderPanelState,
	availability: ReaderPanelAvailability,
): ReaderPanelTab | null {
	if (!state.open) return null;
	return getAvailableReaderPanelTab(state.selectedTab, availability);
}

export function normalizeReaderPanelState(
	state: ReaderPanelState,
	availability: ReaderPanelAvailability,
): ReaderPanelState {
	const selectedTab = getAvailableReaderPanelTab(state.selectedTab, availability);
	return selectedTab === state.selectedTab ? state : { ...state, selectedTab };
}

export function toggleReaderPanel(
	state: ReaderPanelState,
	requestedTab: ReaderPanelTab,
	availability: ReaderPanelAvailability,
): ReaderPanelState {
	const normalizedState = normalizeReaderPanelState(state, availability);
	if (requestedTab === "pages") {
		return { ...normalizedState, open: !normalizedState.open };
	}
	if (!isReaderPanelTabAvailable(requestedTab, availability)) return normalizedState;
	if (normalizedState.open && normalizedState.selectedTab === requestedTab) {
		return { ...normalizedState, open: false };
	}
	return { open: true, selectedTab: requestedTab };
}

export function selectReaderPanel(
	state: ReaderPanelState,
	requestedTab: ReaderPanelTab,
	availability: ReaderPanelAvailability,
): ReaderPanelState {
	const normalizedState = normalizeReaderPanelState(state, availability);
	if (!isReaderPanelTabAvailable(requestedTab, availability)) return normalizedState;
	return { open: true, selectedTab: requestedTab };
}

export function closeReaderPanel(state: ReaderPanelState): ReaderPanelState {
	return state.open ? { ...state, open: false } : state;
}

function getAvailableReaderPanelTab(
	tab: ReaderPanelTab,
	availability: ReaderPanelAvailability,
): ReaderPanelTab {
	return isReaderPanelTabAvailable(tab, availability) ? tab : "pages";
}

function isReaderPanelTabAvailable(
	tab: ReaderPanelTab,
	availability: ReaderPanelAvailability,
): boolean {
	if (tab === "chapters") return availability.chapters;
	if (tab === "bookmarks") return availability.bookmarks;
	return true;
}
