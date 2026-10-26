// SPDX-License-Identifier: MIT

import type { FitMode, LayoutMode } from "@/lib/domain/navigation/layout";
import type { ViewerFailure } from "@/lib/domain/viewer/viewer-controller.svelte";

import type { DocumentBackend, PageSource, PageVisual } from "./document/page-source";

export type { FitMode, LayoutMode, ViewerFailure, DocumentBackend, PageSource, PageVisual };
export { PageSourceUnavailableError } from "./document/page-source";

export interface PamphletChapter {
	title: string;
	page: number;
}

export interface PamphletViewerConfig {
	chapters?: readonly PamphletChapter[];
}

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
	setConfig(config: PamphletViewerConfig): void;
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
