// SPDX-License-Identifier: MPL-2.0

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
	getPageSize(pageIndex: number): Promise<PageSize>;
	renderThumbnail?(pageIndex: number): Promise<PageVisual | null>;
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
