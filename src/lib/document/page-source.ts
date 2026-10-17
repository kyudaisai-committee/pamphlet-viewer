export interface PageSize {
	width: number;
	height: number;
}

export type PageVisual =
	| { type: "pixels"; width: number; height: number; pixels: ArrayBuffer }
	| { type: "bitmap"; width: number; height: number; bitmap: ImageBitmap };

export interface PageSource {
	readonly pageCount: number;
	getPageSize(pageIndex: number): Promise<PageSize>;
	renderPage(pageIndex: number, scale: number): Promise<PageVisual>;
	dispose(): void | Promise<void>;
}

export interface DocumentBackend {
	open(source: string, signal: AbortSignal): Promise<PageSource>;
}
