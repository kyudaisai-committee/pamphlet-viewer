<svelte:options
	customElement={{
		props: {
			src: { type: "String" },
			page: { type: "Number", reflect: true },
			layout: { type: "String", reflect: true },
			fit: { type: "String", reflect: true },
			backend: { attribute: "data-backend", type: "Object" },
			config: { type: "Object" },
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
	import type { RenderInput, ViewerEvent } from "../domain/viewer-controller.svelte";
import { ViewerBookmarks } from "../domain/viewer-bookmarks.svelte";
import { findCurrentChapter, resolveChapters } from "../domain/viewer-config";
	import { parseFit, parseLayout, resolveDocumentSource } from "../domain/viewer-options";
	import type { PageRenderPlan } from "../domain/render-plan";
import type { PamphletViewerConfig } from "@/lib/public-api";
	import ThumbnailPanel from "./ThumbnailPanel.svelte";
	import ViewerStage from "./ViewerStage.svelte";
	import ViewerSettingsToolbar from "./ViewerSettingsToolbar.svelte";
	import ViewerStatusBar from "./ViewerStatusBar.svelte";
	import ViewerToolbar from "./ViewerToolbar.svelte";
	import { ReaderFullscreenController } from "./reader-fullscreen.svelte";
	import { observeResponsiveReaderOrder } from "./reader-region-order";
	import { captureZoomAnchor, restoreZoomAnchor } from "./reader-zoom-anchor";

	interface Props {
		src?: string;
		page?: number;
		layout?: LayoutMode;
		fit?: FitMode;
		backend?: DocumentBackend;
		config?: PamphletViewerConfig;
	}

	type DisplayedPage = { pageIndex: number; visual: PageVisual; plan: PageRenderPlan };

	let {
		src = $bindable(""),
		page = $bindable(1),
		layout = $bindable<LayoutMode>("auto"),
		fit = $bindable<FitMode>("page"),
		backend,
		config,
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
	const bookmarkController = new ViewerBookmarks();
	let previousSource = "";
	let pendingZoomAnchor: ZoomAnchor | null = null;
	let pendingZoomAnchorRequestId: number | null = null;
	let zoomAnchorVersion = 0;
	let resolvedLayout = $derived(resolveLayout(layout, viewport.width));
	let currentPages = $derived(visiblePageIndexes(controller.pageCount, page, resolvedLayout));
	let chapters = $derived(resolveChapters(config, controller.pageCount));
	let currentChapter = $derived(findCurrentChapter(chapters, page));
	let resolvedSource = $derived(
		src.trim().length === 0
			? null
			: resolveDocumentSource(src, pageArea?.ownerDocument.baseURI ?? document.baseURI),
	);
	let bookmarksEnabled = $derived(
		controller.phase === "ready" && controller.pageCount > 0 && resolvedSource !== null,
	);
	let currentPageBookmarked = $derived(bookmarkController.pages.includes(page));
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
				pendingZoomAnchorRequestId = null;
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
		const documentKey = resolvedSource;
		const pageCount = controller.pageCount;
		const enabled = bookmarksEnabled;
		return bookmarkController.connect(documentKey, pageCount, enabled);
	});

	$effect(() => {
		const pageSource = controller.pageSource;
		const pageCount = controller.pageCount;
		if (pageSource === null || pageCount < 1) return;
		const anchor = pendingZoomAnchor;
		if (anchor !== null && !currentPages.includes(anchor.pageIndex)) {
			untrack(clearZoomAnchor);
		}
		const input = createRenderInput();
		if (input === null) {
			untrack(() =>
				controller.failInvalidOption("ページ配置またはフィット方法の値が正しくありません。"),
			);
			return;
		}
		const requestId = untrack(() => controller.requestRender(input));
		if (pendingZoomAnchor !== null) pendingZoomAnchorRequestId = requestId;
	});

	$effect(() => {
		const renderRevision = controller.renderRevision;
		const renderedRequestId = controller.renderedRequestId;
		const phase = controller.phase;
		const anchor = pendingZoomAnchor;
		const expectedRequestId = pendingZoomAnchorRequestId;
		if (anchor === null) return;
		if (phase === "error") {
			clearZoomAnchor();
			return;
		}
		if (
			renderRevision === 0 ||
			expectedRequestId === null ||
			renderedRequestId !== expectedRequestId
		) {
			return;
		}
		const anchorVersion = zoomAnchorVersion;
		void tick().then(() => {
			const area = pageArea;
			if (
				anchorVersion !== zoomAnchorVersion ||
				pendingZoomAnchorRequestId !== expectedRequestId ||
				area?.isConnected !== true ||
				controller.renderedRequestId !== expectedRequestId
			) {
				return;
			}
			if (restoreZoomAnchor(area, anchor)) {
				pendingZoomAnchor = null;
				pendingZoomAnchorRequestId = null;
			}
		});
	});

	$effect(() => {
		const isOpen = thumbnailsOpen;
		const pageIndexes = thumbnailPageIndexes;
		if (isOpen) untrack(() => controller.setThumbnailPages(pageIndexes));
		else untrack(() => controller.closeThumbnails());
	});

	onMount(() => {
		if (pageArea === undefined || shellElement === undefined) return;
		const detachResponsiveOrder = observeResponsiveReaderOrder(shellElement);
		const host = getViewerHost();
		const fullscreenButton = shellElement.querySelector<HTMLElement>("[data-control='fullscreen']");
		const detachFullscreen =
			host !== null && fullscreenButton !== null
				? fullscreenController.attach(host, shellElement, fullscreenButton)
				: () => undefined;
		host?.dispatchEvent(new CustomEvent("ready", { detail: undefined, bubbles: true, composed: true }));
		return () => {
			detachResponsiveOrder();
			detachFullscreen();
			clearZoomAnchor();
			controller.dispose();
		};
	});

	function dispatchControllerEvent(event: ViewerEvent): void {
		if (event.type === "error" && controller.sourceUnavailable) {
			thumbnailsOpen = false;
			thumbnailPageIndexes = [];
			controller.closeThumbnails();
		}
		const host = getViewerHost();
		host?.dispatchEvent(
			new CustomEvent(event.type, {
				detail: { ...event.detail },
				bubbles: true,
				composed: true,
			}),
		);
		if (event.type === "pagechange") page = event.detail.page;
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

	function onChapterChange(value: string): void {
		const chapterPage = chapters.find((chapter) => String(chapter.page) === value)?.page;
		if (chapterPage === undefined) return;
		clearZoomAnchor();
		page = chapterPage;
	}

	function toggleCurrentBookmark(): void {
		bookmarkController.toggleCurrentPage(
			resolvedSource,
			page,
			controller.pageCount,
			bookmarksEnabled,
		);
	}

	function selectBookmark(value: string): void {
		const bookmarkedPage = bookmarkController.findPage(value, bookmarksEnabled);
		if (bookmarkedPage === undefined) return;
		clearZoomAnchor();
		page = bookmarkedPage;
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

	function onZoomChange(value: number): void {
		setZoomAt(value, getPageAreaCenter());
	}

	function onResetZoom(): void {
		setZoomAt(1, getPageAreaCenter());
	}

	function setZoomAt(value: number, point: GesturePoint): void {
		const nextZoom = Math.max(0.1, Math.min(8, value));
		if (nextZoom === zoom) return;
		pendingZoomAnchor = pageArea === undefined ? null : captureZoomAnchor(pageArea, point);
		pendingZoomAnchorRequestId = null;
		zoomAnchorVersion += 1;
		zoom = nextZoom;
	}

	function clearZoomAnchor(): void {
		pendingZoomAnchor = null;
		pendingZoomAnchorRequestId = null;
		zoomAnchorVersion += 1;
	}

	function createRenderInput(): RenderInput | null {
		const currentLayout = parseLayout(layout);
		const currentFit = parseFit(fit);
		if (currentLayout === null || currentFit === null) return null;
		return {
			page,
			layout: currentLayout,
			fit: currentFit,
			zoom,
			viewport,
			devicePixelRatio: pageArea?.ownerDocument.defaultView?.devicePixelRatio ?? 1,
		};
	}

	function getPageAreaCenter(): GesturePoint {
		const bounds = pageArea?.getBoundingClientRect();
		if (bounds === undefined) return { x: 0, y: 0 };
		return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
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
		const input = createRenderInput();
		if (input !== null) controller.retryRender(input);
	}
</script>

<div class="viewer-shell" bind:this={shellElement}>
	<div class="settings-region" data-reader-region="settings">
		<ViewerSettingsToolbar
		layout={parseLayout(layout) ?? "auto"}
		fit={parseFit(fit) ?? "page"}
		zoom={zoom}
		enabled={controller.pageCount > 0}
		fullscreen={fullscreenController.active}
		onLayoutChange={onLayoutChange}
		onFitChange={onFitChange}
		onZoomChange={onZoomChange}
		onResetZoom={onResetZoom}
		onToggleFullscreen={() => void fullscreenController.toggle()}
	/>
	</div>
	<div class="content-region" data-reader-region="body">
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
	</div>
	<div class="status-region" data-reader-region="status">
		<ViewerStatusBar phase={controller.phase} pageCount={controller.pageCount} />
	</div>
	<div class="navigation-region" data-reader-region="navigation">
		<ViewerToolbar
			page={page}
			pageCount={controller.pageCount}
			{chapters}
			currentChapterPage={currentChapter?.page}
			bookmarkPages={bookmarkController.pages}
			bookmarked={currentPageBookmarked}
			bookmarkEnabled={bookmarksEnabled}
			enabled={controller.pageCount > 0}
			canPrevious={page > 1}
			canNext={page < controller.pageCount}
			thumbnailsOpen={thumbnailsOpen}
			onPageChange={onPageChange}
			onChapterChange={onChapterChange}
			onToggleBookmark={toggleCurrentBookmark}
			onSelectBookmark={selectBookmark}
			onPrevious={previousPage}
			onNext={nextPage}
			onToggleThumbnails={() => (thumbnailsOpen = !thumbnailsOpen)}
		/>
	</div>
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
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto auto minmax(0, 1fr) auto auto;
		width: 100%;
		height: 100%;
		min-height: inherit;
		container-name: pamphlet-reader reader-toolbar;
		container-type: inline-size;
		overflow: hidden;
		border: 1px solid var(--pamphlet-viewer-border);
		background: #191c20;

		.settings-region,
		.navigation-region {
			min-width: 0;
		}

		.navigation-region {
			grid-column: 1;
			grid-row: 1;
		}

		.settings-region {
			grid-column: 2;
			grid-row: 1;
		}

		.content-region {
			grid-column: 1 / -1;
			grid-row: 3;
			display: flex;
			min-width: 0;
			min-height: 0;
		}

		.status-region {
			grid-column: 1 / -1;
			grid-row: 4;
		}

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

	@container pamphlet-reader (min-width: 701px) and (max-width: 837px) {
		.viewer-shell .settings-region {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}

	@container pamphlet-reader (max-width: 700px) {
		.viewer-shell .settings-region {
			grid-column: 1 / -1;
			grid-row: 1;
		}

		.viewer-shell .content-region {
			grid-row: 3;
		}

		.viewer-shell .status-region {
			grid-row: 4;
		}

		.viewer-shell .navigation-region {
			grid-column: 1 / -1;
			grid-row: 5;
		}

		.viewer-shell .reader-body {
			flex: 1 1 0;
		}

		.viewer-shell .reader-body.thumbnails-open {
			grid-template-columns: minmax(0, 1fr);

			.stage-slot {
				display: none;
			}
	}
	}
</style>
