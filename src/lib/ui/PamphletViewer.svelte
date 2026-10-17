<svelte:options
	customElement={{
		props: {
			src: { type: "String" },
			page: { type: "Number", reflect: true },
			layout: { type: "String", reflect: true },
			fit: { type: "String", reflect: true },
			backend: { attribute: "data-backend", type: "Object" },
		},
		extend: extendViewerElement,
	}}
/>

<script module lang="ts">
	import { extendViewerElement } from "./pamphlet-viewer-element";
</script>

<script lang="ts">
	import { onMount, untrack } from "svelte";

	import type { DocumentBackend, PageVisual } from "../document/page-source";
	import { PdfiumBackend } from "../document/pdfium-backend";
	import { resolveLayout, visiblePageIndexes } from "../domain/layout";
	import type { FitMode, LayoutMode } from "../domain/layout";
	import { ViewerController } from "../domain/viewer-controller.svelte";
	import type { ViewerEvent } from "../domain/viewer-controller.svelte";
	import { parseFit, parseLayout, resolveDocumentSource } from "../domain/viewer-options";
	import PageCanvas from "./PageCanvas.svelte";
	import ViewerToolbar from "./ViewerToolbar.svelte";
	import ViewerStatusBar from "./ViewerStatusBar.svelte";
	import ViewerStatusMessage from "./ViewerStatusMessage.svelte";

	interface Props {
		src?: string;
		page?: number;
		layout?: LayoutMode;
		fit?: FitMode;
		backend?: DocumentBackend;
	}

	type DisplayedPage = { pageIndex: number; visual: PageVisual };

	let {
		src = $bindable(""),
		page = $bindable(1),
		layout = $bindable<LayoutMode>("auto"),
		fit = $bindable<FitMode>("page"),
		backend,
	}: Props = $props();

	const defaultBackend = new PdfiumBackend();
	const controller = new ViewerController(dispatchControllerEvent);
	let pageArea = $state<HTMLElement>();
	let viewport = $state({ width: 0, height: 0 });
	let zoom = $state(1);
	let previousSource = "";
	let resolvedLayout = $derived(resolveLayout(layout, viewport.width));
	let displayedPages = $derived.by((): DisplayedPage[] => {
		const pageIndexes = visiblePageIndexes(controller.pageCount, page, resolvedLayout);
		return pageIndexes.flatMap((pageIndex) => {
			const visual = controller.pageVisuals[pageIndex];
			return visual === undefined ? [] : [{ pageIndex, visual }];
		});
	});

	$effect(() => {
		const source = src;
		const activeBackend = backend ?? defaultBackend;
		if (source !== previousSource) {
			if (previousSource.length > 0) page = 1;
			previousSource = source;
		}
		if (source.trim().length === 0) {
			untrack(() => void controller.load("", activeBackend));
			return;
		}

		const resolvedSource = resolveDocumentSource(
			source,
			pageArea?.ownerDocument.baseURI ?? document.baseURI,
		);
		if (resolvedSource === null) {
			untrack(() => controller.failInvalidSource());
			return;
		}
		untrack(() => void controller.load(resolvedSource, activeBackend));
	});

	$effect(() => {
		const pageSource = controller.pageSource;
		const pageCount = controller.pageCount;
		const pageNumber = page;
		const currentLayout = parseLayout(layout);
		const currentFit = parseFit(fit);
		const currentViewport = viewport;
		const currentZoom = zoom;
		if (pageSource === null || pageCount < 1) return;
		if (currentLayout === null || currentFit === null) {
			untrack(() =>
				controller.failInvalidOption("ページ配置またはフィット方法の値が正しくありません。"),
			);
			return;
		}
		untrack(() =>
			controller.requestRender({
				page: pageNumber,
				layout: currentLayout,
				fit: currentFit,
				zoom: currentZoom,
				viewport: currentViewport,
			}),
		);
	});

	onMount(() => {
		if (pageArea === undefined) return;
		const resizeObserver = new ResizeObserver(updateViewport);
		resizeObserver.observe(pageArea);
		updateViewport();
		getViewerHost()?.dispatchEvent(
			new CustomEvent("ready", { detail: undefined, bubbles: true, composed: true }),
		);
		return () => {
			resizeObserver.disconnect();
			controller.dispose();
		};
	});

	function dispatchControllerEvent(event: ViewerEvent): void {
		getViewerHost()?.dispatchEvent(
			new CustomEvent(event.type, {
				detail: { ...event.detail },
				bubbles: true,
				composed: true,
			}),
		);
		if (event.type === "pagechange") page = event.detail.page;
	}

	function updateViewport(): void {
		if (pageArea === undefined) return;
		const bounds = pageArea.getBoundingClientRect();
		viewport = { width: Math.max(0, bounds.width - 48), height: Math.max(0, bounds.height - 48) };
	}

	function getViewerHost(): HTMLElement | null {
		if (pageArea === undefined) return null;
		const root = pageArea.getRootNode();
		return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
	}

	function onPageChange(value: string): void {
		page = Number(value);
	}

	function onLayoutChange(value: string): void {
		const parsedLayout = parseLayout(value);
		if (parsedLayout !== null) layout = parsedLayout;
	}

	function onFitChange(value: FitMode): void {
		fit = value;
	}

	function previousPage(): void {
		if (resolvedLayout === "single") {
			page = Math.max(1, page - 1);
			return;
		}
		const visible = visiblePageIndexes(controller.pageCount, page, resolvedLayout);
		page = Math.max(1, (visible[0] ?? 0) - 1);
	}

	function nextPage(): void {
		if (resolvedLayout === "single") {
			page = Math.min(controller.pageCount, page + 1);
			return;
		}
		const visible = visiblePageIndexes(controller.pageCount, page, resolvedLayout);
		page = Math.min(controller.pageCount, (visible.at(-1) ?? 0) + 2);
	}

	function retry(): void {
		if (controller.failure?.code === "load-failed") {
			const resolvedSource = resolveDocumentSource(
				src,
				pageArea?.ownerDocument.baseURI ?? document.baseURI,
			);
			if (resolvedSource !== null) void controller.load(resolvedSource, backend ?? defaultBackend);
			return;
		}
		const currentLayout = parseLayout(layout);
		const currentFit = parseFit(fit);
		if (currentLayout === null || currentFit === null) return;
		controller.retryRender({ page, layout: currentLayout, fit: currentFit, zoom, viewport });
	}

</script>

<div class="viewer-shell">
	<ViewerToolbar
		page={page}
		pageCount={controller.pageCount}
		layout={parseLayout(layout) ?? "auto"}
		fit={parseFit(fit) ?? "page"}
		zoom={zoom}
		enabled={controller.pageCount > 0}
		canPrevious={page > 1}
		canNext={page < controller.pageCount}
		onPageChange={onPageChange}
		onLayoutChange={onLayoutChange}
		onFitChange={onFitChange}
		onPrevious={previousPage}
		onNext={nextPage}
		onZoomChange={(value) => (zoom = value)}
	/>
	<section
		class="page-area"
		aria-label="パンフレット表示領域"
		bind:this={pageArea}
	>
		{#if displayedPages.length > 0 && controller.phase !== "error"}
			<div class="viewer-pages" class:spread={displayedPages.length === 2}>
				{#each displayedPages as displayedPage (displayedPage.pageIndex)}
					<div class="page-frame">
						<PageCanvas
							visual={displayedPage.visual}
							label={`${displayedPage.pageIndex + 1}ページ`}
						/>
					</div>
				{/each}
			</div>
		{:else}
			<ViewerStatusMessage
				phase={controller.phase}
				failure={controller.failure}
				onRetry={retry}
			/>
		{/if}
	</section>
	<ViewerStatusBar phase={controller.phase} pageCount={controller.pageCount} />
</div>

<style>
	:host {
		display: block;
		min-height: 22rem;
		color: var(--pamphlet-viewer-text, #202532);
		font: 14px/1.5 system-ui, sans-serif;
		color-scheme: light;
	}

	.viewer-shell {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: inherit;
		overflow: hidden;
		border: 1px solid var(--pamphlet-viewer-border, #d8dce5);
		border-radius: 12px;
		background: var(--pamphlet-viewer-surface, #fff);

		.page-area {
			flex: 1 1 auto;
			min-height: 0;
			overflow: auto;
			background: var(--pamphlet-viewer-canvas, #e9ecf2);

			&:focus-visible {
				outline: 2px solid var(--pamphlet-viewer-accent, #3157a4);
				outline-offset: -3px;
			}

			.viewer-pages {
				box-sizing: border-box;
				display: flex;
				align-items: center;
				justify-content: center;
				gap: 16px;
				width: max-content;
				min-width: 100%;
				min-height: 100%;
				margin-inline: auto;
				padding: 24px;

				.page-frame {
					flex: 0 0 auto;
					border: 1px solid var(--pamphlet-viewer-border, #d8dce5);
				}
			}
		}

	}
</style>
