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
	import { onMount, tick, untrack } from "svelte";

	import type { DocumentBackend, PageVisual } from "../document/page-source";
	import { PdfiumBackend } from "../document/pdfium-backend";
	import { resolveLayout, visiblePageIndexes } from "../domain/layout";
	import type { FitMode, LayoutMode, ViewportSize } from "../domain/layout";
import type { GesturePoint, ZoomAnchor } from "../domain/reader-gesture";
	import { ViewerController } from "../domain/viewer-controller.svelte";
	import type { ViewerEvent } from "../domain/viewer-controller.svelte";
	import { parseFit, parseLayout, resolveDocumentSource } from "../domain/viewer-options";
import type { PageRenderPlan } from "../domain/render-plan";
	import ThumbnailPanel from "./ThumbnailPanel.svelte";
	import ViewerStage from "./ViewerStage.svelte";
	import ViewerStatusBar from "./ViewerStatusBar.svelte";
	import ViewerToolbar from "./ViewerToolbar.svelte";
	import { ReaderFullscreenController } from "./reader-fullscreen.svelte";
	import { captureZoomAnchor, restoreZoomAnchor } from "./reader-zoom-anchor";

	interface Props {
		src?: string;
		page?: number;
		layout?: LayoutMode;
		fit?: FitMode;
		backend?: DocumentBackend;
	}

	type DisplayedPage = { pageIndex: number; visual: PageVisual; plan: PageRenderPlan };

	let {
		src = $bindable(""),
		page = $bindable(1),
		layout = $bindable<LayoutMode>("auto"),
		fit = $bindable<FitMode>("page"),
		backend,
	}: Props = $props();

	const defaultBackend = new PdfiumBackend();
	const controller = new ViewerController(dispatchControllerEvent);
	const fullscreenController = new ReaderFullscreenController();
	let shellElement = $state<HTMLElement>();
	let pageArea = $state<HTMLElement>();
	let viewport = $state<ViewportSize>({ width: 0, height: 0 });
	let zoom = $state(1);
	let thumbnailsOpen = $state(false);
	let thumbnailPageIndexes = $state<readonly number[]>([]);
	let previousSource = "";
	let pendingZoomAnchor: ZoomAnchor | null = null;
	let zoomAnchorVersion = 0;
	let resolvedLayout = $derived(resolveLayout(layout, viewport.width));
	let currentPages = $derived(visiblePageIndexes(controller.pageCount, page, resolvedLayout));
	let displayedPages = $derived.by((): DisplayedPage[] =>
		currentPages.flatMap((pageIndex) => {
			const visual = controller.pageVisuals[pageIndex];
			const plan = controller.pageRenderPlans[pageIndex];
			return visual === undefined || plan === undefined ? [] : [{ pageIndex, visual, plan }];
		}),
	);

	$effect(() => {
		const source = src;
		const activeBackend = backend ?? defaultBackend;
		if (source !== previousSource) {
			const hadPreviousSource = previousSource.length > 0;
			previousSource = source;
			untrack(() => {
				if (hadPreviousSource) page = 1;
				zoom = 1;
				pendingZoomAnchor = null;
				zoomAnchorVersion += 1;
				thumbnailsOpen = false;
				thumbnailPageIndexes = [];
				controller.closeThumbnails();
			});
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
		const devicePixelRatio = pageArea?.ownerDocument.defaultView?.devicePixelRatio ?? 1;
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
				devicePixelRatio,
			}),
		);
	});

	$effect(() => {
		const isOpen = thumbnailsOpen;
		const pageIndexes = thumbnailPageIndexes;
		if (isOpen) untrack(() => controller.setThumbnailPages(pageIndexes));
		else untrack(() => controller.closeThumbnails());
	});

	onMount(() => {
		if (pageArea === undefined || shellElement === undefined) return;
		const host = getViewerHost();
		const fullscreenButton = shellElement.querySelector<HTMLElement>("[data-control='fullscreen']");
		const detachFullscreen =
			host !== null && fullscreenButton !== null
				? fullscreenController.attach(host, shellElement, fullscreenButton)
				: () => undefined;
		host?.dispatchEvent(new CustomEvent("ready", { detail: undefined, bubbles: true, composed: true }));
		return () => {
			detachFullscreen();
			controller.dispose();
		};
	});

	function dispatchControllerEvent(event: ViewerEvent): void {
		const host = getViewerHost();
		host?.dispatchEvent(
			new CustomEvent(event.type, {
				detail: { ...event.detail },
				bubbles: true,
				composed: true,
			}),
		);
		if (event.type !== "pagechange") return;
		page = event.detail.page;
		const anchor = pendingZoomAnchor;
		if (anchor === null) return;
		if (!event.detail.visiblePages.includes(anchor.pageIndex + 1)) {
			pendingZoomAnchor = null;
			return;
		}
		pendingZoomAnchor = null;
		const anchorVersion = zoomAnchorVersion;
		void tick().then(() => {
			requestAnimationFrame(() => {
				const area = pageArea;
				if (anchorVersion === zoomAnchorVersion && area?.isConnected === true) {
					restoreZoomAnchor(area, anchor);
				}
			});
		});
	}

	function getViewerHost(): HTMLElement | null {
		if (pageArea === undefined) return null;
		const root = pageArea.getRootNode();
		return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
	}

	function onPageChange(value: string): void {
		clearZoomAnchor();
		page = Number(value);
	}

	function onLayoutChange(value: string): void {
		const parsedLayout = parseLayout(value);
		if (parsedLayout !== null) {
			clearZoomAnchor();
			layout = parsedLayout;
		}
	}

	function onFitChange(value: FitMode): void {
		fit = value;
	}

	function previousPage(): void {
		clearZoomAnchor();
		if (resolvedLayout === "single") {
			page = Math.max(1, page - 1);
			return;
		}
		const visible = visiblePageIndexes(controller.pageCount, page, resolvedLayout);
		page = Math.max(1, (visible[0] ?? 0) - 1);
	}

	function nextPage(): void {
		clearZoomAnchor();
		if (resolvedLayout === "single") {
			page = Math.min(controller.pageCount, page + 1);
			return;
		}
		const visible = visiblePageIndexes(controller.pageCount, page, resolvedLayout);
		page = Math.min(controller.pageCount, (visible.at(-1) ?? 0) + 2);
	}

	function onZoomChange(value: number, point: GesturePoint): void {
		setZoomAt(value, point);
	}

	function onResetZoom(point: GesturePoint): void {
		setZoomAt(1, point);
	}

	function setZoomAt(value: number, point: GesturePoint): void {
		if (pageArea !== undefined) pendingZoomAnchor = captureZoomAnchor(pageArea, point);
		zoomAnchorVersion += 1;
		zoom = Math.max(0.1, Math.min(8, value));
	}

	function clearZoomAnchor(): void {
		pendingZoomAnchor = null;
		zoomAnchorVersion += 1;
	}

	function updateThumbnailPages(pageIndexes: readonly number[]): void {
		thumbnailPageIndexes = pageIndexes;
	}

	function selectThumbnail(selectedPage: number): void {
		clearZoomAnchor();
		page = selectedPage;
		if ((getViewerHost()?.getBoundingClientRect().width ?? 0) <= 620) thumbnailsOpen = false;
	}

	function onViewportChange(nextViewport: ViewportSize): void {
		viewport = nextViewport;
	}

	function onZoomGesture(value: number, center: GesturePoint): void {
		setZoomAt(value, center);
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

<div class="viewer-shell" bind:this={shellElement}>
	<ViewerToolbar
		page={page}
		pageCount={controller.pageCount}
		layout={parseLayout(layout) ?? "auto"}
		fit={parseFit(fit) ?? "page"}
		zoom={zoom}
		enabled={controller.pageCount > 0}
		canPrevious={page > 1}
		canNext={page < controller.pageCount}
		thumbnailsOpen={thumbnailsOpen}
		fullscreen={fullscreenController.active}
		onPageChange={onPageChange}
		onLayoutChange={onLayoutChange}
		onFitChange={onFitChange}
		onPrevious={previousPage}
		onNext={nextPage}
		onZoomChange={onZoomChange}
		onResetZoom={onResetZoom}
		onToggleThumbnails={() => (thumbnailsOpen = !thumbnailsOpen)}
		onToggleFullscreen={() => void fullscreenController.toggle()}
	/>
	<div class="reader-body" class:thumbnails-open={thumbnailsOpen}>
		{#if thumbnailsOpen}
			<div class="thumbnail-slot">
				<ThumbnailPanel
					pageCount={controller.pageCount}
					currentPages={currentPages}
					visuals={controller.thumbnailVisuals}
					onVisiblePagesChange={updateThumbnailPages}
					onSelectPage={selectThumbnail}
					onClose={() => (thumbnailsOpen = false)}
				/>
			</div>
		{/if}
		<div class="stage-slot">
			<ViewerStage
				pages={displayedPages}
				phase={controller.phase}
				failure={controller.failure}
				{zoom}
				bind:pageArea
				onViewportChange={onViewportChange}
				onZoomGesture={onZoomGesture}
				onPrevious={previousPage}
				onNext={nextPage}
				onRetry={retry}
			/>
		</div>
	</div>
	<ViewerStatusBar phase={controller.phase} pageCount={controller.pageCount} />
</div>

<style>
	:host {
		display: block;
		width: 100%;
		min-width: 0;
		min-height: 22rem;
		color: #e4e7e9;
		font: 14px/1.5 system-ui, sans-serif;
		color-scheme: dark;
		--pamphlet-viewer-text: #e4e7e9;
		--pamphlet-viewer-border: #3b4148;
		--pamphlet-viewer-stage: #191c20;
		--pamphlet-viewer-panel: #24282e;
		--pamphlet-viewer-toolbar: #24282e;
		--pamphlet-viewer-accent: #a8c5bc;

		&:fullscreen {
			width: 100vw !important;
			height: 100dvh !important;
			min-height: 0 !important;
			background: #191c20;
		}
	}

	:host([data-fullscreen-fallback]) {
		position: fixed;
		z-index: 2147483000;
		inset: 0;
		width: 100vw !important;
		height: 100dvh !important;
		min-height: 0 !important;
		background: #191c20;
	}

	.viewer-shell {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: inherit;
		container-name: pamphlet-reader;
		container-type: inline-size;
		overflow: hidden;
		border: 1px solid var(--pamphlet-viewer-border);
		background: #191c20;

		&:popover-open {
			position: fixed;
			inset: 0;
			width: 100vw;
			height: 100dvh;
			max-width: none;
			max-height: none;
			margin: 0;
			border: 0;
			background: #191c20;
		}

		.reader-body {
			box-sizing: border-box;
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			flex: 1 1 auto;
			min-width: 0;
			min-height: 0;

			&.thumbnails-open {
				grid-template-columns: 208px minmax(0, 1fr);
			}

			.thumbnail-slot {
				display: flex;
				flex-direction: column;
				min-width: 0;
				min-height: 0;
			}

			.stage-slot {
				display: flex;
				flex-direction: column;
				min-width: 0;
				min-height: 0;
			}
		}
	}

	@container pamphlet-reader (max-width: 620px) {
		.viewer-shell {
			.reader-body.thumbnails-open {
				grid-template-columns: minmax(0, 1fr);

				.stage-slot {
					display: none;
				}
			}
		}
	}
</style>
