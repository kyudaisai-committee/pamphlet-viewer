import type { DocumentBackend, PageSource, PageVisual } from "./document/page-source";
import type { FitMode, LayoutMode } from "./domain/layout";
import type { ViewerFailure } from "./domain/viewer-controller.svelte";

export type { FitMode, LayoutMode, ViewerFailure, DocumentBackend, PageSource, PageVisual };

export interface PamphletViewerEventMap {
	ready: CustomEvent<undefined>;
	documentload: CustomEvent<{ pageCount: number }>;
	pagechange: CustomEvent<{ page: number; visiblePages: number[] }>;
	error: CustomEvent<ViewerFailure>;
}

export interface PamphletViewerElement extends HTMLElement {
	src: string;
	page: number;
	layout: LayoutMode;
	fit: FitMode;
	backend?: DocumentBackend;
	addEventListener<K extends keyof PamphletViewerEventMap>(
		type: K,
		listener: (this: PamphletViewerElement, event: PamphletViewerEventMap[K]) => void,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	removeEventListener<K extends keyof PamphletViewerEventMap>(
		type: K,
		listener: (this: PamphletViewerElement, event: PamphletViewerEventMap[K]) => void,
		options?: boolean | EventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void;
}

declare global {
	interface HTMLElementEventMap {
		ready: PamphletViewerEventMap["ready"];
		documentload: PamphletViewerEventMap["documentload"];
		pagechange: PamphletViewerEventMap["pagechange"];
	}

	interface HTMLElementTagNameMap {
		"pamphlet-viewer": PamphletViewerElement;
	}
}
