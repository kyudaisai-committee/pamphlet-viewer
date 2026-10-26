// SPDX-License-Identifier: MIT

export interface PageSize {
	width: number;
	height: number;
}

export const MAX_PAGE_RENDER_PIXELS = 8 * 1024 * 1024;

export type PageVisual =
	| { type: "pixels"; width: number; height: number; pixels: ArrayBuffer }
	| { type: "bitmap"; width: number; height: number; bitmap: ImageBitmap };

export interface PageSource {
	readonly pageCount: number;
	readonly propagateThumbnailErrors?: boolean;
	getPageSize(pageIndex: number): Promise<PageSize>;
	getPrefetchedPageSize?(pageIndex: number): Promise<PageSize>;
	getThumbnailPageSize?(pageIndex: number): Promise<PageSize>;
	cancelForegroundRequests?(): void;
	prefetchPage?(pageIndex: number): Promise<void>;
	cancelPrefetchPageRequests?(): void;
	renderThumbnail?(pageIndex: number): Promise<PageVisual | null>;
	prefetchThumbnail?(pageIndex: number): Promise<PageVisual | null>;
	renderPrefetchedPage(pageIndex: number, scale: number): Promise<PageVisual>;
	renderPage(pageIndex: number, scale: number): Promise<PageVisual>;
	dispose(): void | Promise<void>;
}

export interface DocumentBackend {
	open(source: string, signal: AbortSignal): Promise<PageSource>;
}

export class PageSourceUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PageSourceUnavailableError";
	}
}
