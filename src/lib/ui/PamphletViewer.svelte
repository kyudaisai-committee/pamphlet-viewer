<!-- SPDX-License-Identifier: MIT -->

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

	import type { DocumentBackend, PageVisual } from "@/lib/document/page-source";
	import { PdfiumBackend } from "@/lib/document/pdfium-backend";
	import { resolveLayout, visiblePageIndexes } from "@/lib/domain/navigation/layout";
	import type { FitMode, LayoutMode, ViewportSize } from "@/lib/domain/navigation/layout";
	import type { GesturePoint, ZoomAnchor } from "@/lib/domain/navigation/reader-gesture";
	import { ViewerController } from "@/lib/domain/viewer/viewer-controller.svelte";
	import type { RenderInput, ViewerEvent } from "@/lib/domain/viewer/viewer-controller.svelte";
import { ViewerBookmarks } from "@/lib/domain/bookmarks/viewer-bookmarks.svelte";
import { findCurrentChapter, resolveChapters } from "@/lib/domain/configuration/viewer-config";
	import { parseFit, parseLayout, resolveDocumentSource } from "@/lib/domain/configuration/viewer-options";
	import type { PageRenderPlan } from "@/lib/domain/rendering/render-plan";
	import type { PamphletViewerConfig } from "@/lib/public-api";
	import { resolveViewerLocale } from "../i18n/locale";
	import type { ViewerLocale } from "../i18n/locale";
	import { createViewerMessages } from "@/lib/i18n/viewer-messages";
	import { provideViewerMessages } from "../i18n/viewer-messages-context.svelte";
	import { subscribeViewerElementConfig } from "./viewer-element-config";
	import ThumbnailPanel from "./ThumbnailPanel.svelte";
	import ViewerStage from "./ViewerStage.svelte";
	import ViewerSettingsToolbar from "./ViewerSettingsToolbar.svelte";
	import ViewerStatusBar from "./ViewerStatusBar.svelte";
	import ViewerToolbar from "./ViewerToolbar.svelte";
	import { ReaderFullscreenController } from "./reader-fullscreen.svelte";
	import { observeResponsiveReaderOrder } from "./reader-region-order";
	import { captureZoomAnchor, restoreZoomAnchor } from "./reader-zoom-anchor";
	import { ZoomRenderScheduler } from "./zoom-render-scheduler";

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

	const messages = $state(createViewerMessages("ja"));
	let locale = $state<ViewerLocale>("ja");
	provideViewerMessages(messages);
	const defaultBackend = new PdfiumBackend();
	const controller = new ViewerController(dispatchControllerEvent, undefined, messages);
	const fullscreenController = new ReaderFullscreenController();
	const zoomRenderScheduler = new ZoomRenderScheduler();
	let config = $state<PamphletViewerConfig>({});
	let shellElement = $state<HTMLElement>();
	let pageArea = $state<HTMLElement>();
	let localeInitialized = $state(false);
	let viewport = $state<ViewportSize>({ width: 0, height: 0 });
	let zoom = $state(1);
	let thumbnailsOpen = $state(false);
	let thumbnailPageIndexes = $state<readonly number[]>([]);
	const bookmarkController = new ViewerBookmarks();
	let previousSource = "";
	let lastObservedPage = page;
	let pendingZoomAnchor: ZoomAnchor | null = null;
	let pendingZoomAnchorRequestId: number | null = null;
	let zoomAnchorVersion = 0;
	let lastRenderInput: RenderInput | null = null;
	let resolvedLayout = $derived(resolveLayout(layout, viewport.width));
	let currentPages = $derived(visiblePageIndexes(controller.pageCount, page, resolvedLayout));
	let canMoveNext = $derived.by(() => {
		const visible = visiblePageIndexes(controller.pageCount, page, resolvedLayout);
		const lastVisiblePage = visible.at(-1);
		return lastVisiblePage !== undefined && lastVisiblePage < controller.pageCount - 1;
	});
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
			if (visual === undefined || plan === undefined) return [];
			const renderedZoom = controller.renderedZoom;
			const zoomRatio = renderedZoom === null ? 1 : zoom / renderedZoom;
			return [
				{
					pageIndex,
					visual,
					plan: {
						...plan,
						displayScale: plan.displayScale * zoomRatio,
						displayWidth: plan.displayWidth * zoomRatio,
						displayHeight: plan.displayHeight * zoomRatio,
					},
				},
			];
		}),
	);

	$effect(() => {
		if (!localeInitialized) return;
		const source = src;
		const activeBackend = backend ?? defaultBackend;
		if (source !== previousSource) {
			const hadPreviousSource = previousSource.length > 0;
			previousSource = source;
			untrack(() => {
				if (hadPreviousSource) page = 1;
				zoom = 1;
				zoomRenderScheduler.cancel();
				lastRenderInput = null;
				clearZoomAnchor();
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
		const currentPage = page;
		if (currentPage === lastObservedPage) return;
		lastObservedPage = currentPage;
		untrack(() => {
			zoom = 1;
			zoomRenderScheduler.cancel();
			clearZoomAnchor();
		});
		void tick().then(() => {
			if (page !== currentPage) return;
			if (pageArea === undefined) return;
			pageArea.scrollTop = 0;
			pageArea.scrollLeft = 0;
		});
	});

	$effect(() => {
		const pageSource = controller.pageSource;
		const pageCount = controller.pageCount;
		const phase = controller.phase;
		if (pageSource === null || pageCount < 1) {
			untrack(() => {
				zoomRenderScheduler.cancel();
				lastRenderInput = null;
			});
			return;
		}
		const input = createRenderInput();
		if (input === null) {
			untrack(() => {
				zoomRenderScheduler.cancel();
				lastRenderInput = null;
				controller.failInvalidOption();
			});
			return;
		}
		if (phase === "error") {
			untrack(() => {
				zoomRenderScheduler.cancel();
				lastRenderInput = null;
				clearZoomAnchor();
				controller.requestRender(input);
			});
			return;
		}
		const previousInput = lastRenderInput;
		lastRenderInput = input;
		if (previousInput !== null && isZoomOnlyRenderChange(previousInput, input)) {
			untrack(() => {
				zoomRenderScheduler.schedule(() => {
					const currentInput = createRenderInput();
					if (
						controller.phase !== "ready" ||
						!sameRenderInput(input, currentInput)
					) {
						return;
					}
					const requestId = controller.requestRender(input);
					if (requestId === null) {
						clearZoomAnchor();
						return;
					}
					if (pendingZoomAnchor !== null) pendingZoomAnchorRequestId = requestId;
				});
			});
			return;
		}
		untrack(() => {
			zoomRenderScheduler.cancel();
			if (previousInput !== null && !sameRenderContext(previousInput, input)) {
				clearZoomAnchor();
			}
			controller.requestRender(input);
		});
	});

	$effect(() => {
		const phase = controller.phase;
		const renderRevision = controller.renderRevision;
		const renderedRequestId = controller.renderedRequestId;
		const anchor = pendingZoomAnchor;
		const expectedRequestId = pendingZoomAnchorRequestId;
		if (anchor === null) return;
		if (phase === "error" || !currentPages.includes(anchor.pageIndex)) {
			untrack(clearZoomAnchor);
			return;
		}
		if (
			renderRevision === 0 ||
			renderedRequestId === null ||
			(expectedRequestId !== null && renderedRequestId !== expectedRequestId)
		) {
			return;
		}
		scheduleZoomAnchorRestore(
			anchor,
			zoomAnchorVersion,
			expectedRequestId,
			expectedRequestId !== null,
		);
	});

	$effect(() => {
		const isOpen = thumbnailsOpen;
		const pageIndexes = thumbnailPageIndexes;
		if (isOpen) untrack(() => controller.setThumbnailPages(pageIndexes));
		else untrack(() => controller.closeThumbnails());
	});

	onMount(() => {
		const host = getViewerHost();
		if (host !== null) {
			locale = resolveViewerLocale(
				host.getAttribute("lang"),
				host.ownerDocument.documentElement.getAttribute("lang"),
			);
			Object.assign(
				messages,
				createViewerMessages(locale),
			);
		}
		localeInitialized = true;
		if (pageArea === undefined || shellElement === undefined) return;
		const detachResponsiveOrder = observeResponsiveReaderOrder(shellElement);
		const detachConfig =
			host === null
				? () => undefined
				: subscribeViewerElementConfig(host, (nextConfig) => {
						config = nextConfig;
					});
		const fullscreenButton = shellElement.querySelector<HTMLElement>("[data-control='fullscreen']");
		const detachFullscreen =
			host !== null && fullscreenButton !== null
				? fullscreenController.attach(host, shellElement, fullscreenButton)
				: () => undefined;
		host?.dispatchEvent(new CustomEvent("ready", { detail: undefined, bubbles: true, composed: true }));
		return () => {
			detachConfig();
			detachResponsiveOrder();
			detachFullscreen();
			zoomRenderScheduler.cancel();
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
		if (event.type === "pagechange") page = event.detail.page;
		const host = getViewerHost();
		host?.dispatchEvent(
			new CustomEvent(event.type, {
				detail: { ...event.detail },
				bubbles: true,
				composed: true,
			}),
		);
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
		clearZoomAnchor();
		fit = value;
	}

	function previousPage(): void {
		if (!canNavigatePages()) return;
		clearZoomAnchor();
		if (resolvedLayout === "single") {
			page = Math.max(1, page - 1);
			return;
		}
		const visible = visiblePageIndexes(controller.pageCount, page, resolvedLayout);
		page = Math.max(1, (visible[0] ?? 0) - 1);
	}

	function nextPage(): void {
		if (!canNavigatePages() || !canMoveNext) return;
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

	function canNavigatePages(): boolean {
		return controller.pageSource !== null && controller.pageCount > 0;
	}

	function onResetZoom(): void {
		setZoomAt(1, getPageAreaCenter());
	}

	function setZoomAt(value: number, point: GesturePoint): void {
		const nextZoom = Math.max(0.1, Math.min(8, value));
		if (nextZoom === zoom) return;
		const anchor = pageArea === undefined ? null : captureZoomAnchor(pageArea, point);
		pendingZoomAnchor = anchor;
		pendingZoomAnchorRequestId = null;
		zoomAnchorVersion += 1;
		const anchorVersion = zoomAnchorVersion;
		zoom = nextZoom;
		if (anchor !== null) scheduleZoomAnchorRestore(anchor, anchorVersion, null, false);
	}

	function clearZoomAnchor(): void {
		pendingZoomAnchor = null;
		pendingZoomAnchorRequestId = null;
		zoomAnchorVersion += 1;
	}

	function scheduleZoomAnchorRestore(
		anchor: ZoomAnchor,
		anchorVersion: number,
		expectedRequestId: number | null,
		clearWhenRestored: boolean,
	): void {
		void tick().then(() => {
			const area = pageArea;
			if (
				anchorVersion !== zoomAnchorVersion ||
				pendingZoomAnchor !== anchor ||
				!currentPages.includes(anchor.pageIndex) ||
				controller.phase === "error" ||
				area?.isConnected !== true ||
				(expectedRequestId !== null && controller.renderedRequestId !== expectedRequestId)
			) {
				return;
			}
			if (restoreZoomAnchor(area, anchor) && clearWhenRestored) clearZoomAnchor();
		});
	}

	function isZoomOnlyRenderChange(previous: RenderInput, next: RenderInput): boolean {
		return sameRenderContext(previous, next) && previous.zoom !== next.zoom;
	}

	function sameRenderInput(first: RenderInput, second: RenderInput | null): boolean {
		return second !== null && sameRenderContext(first, second) && first.zoom === second.zoom;
	}

	function sameRenderContext(first: RenderInput, second: RenderInput): boolean {
		return (
			first.page === second.page &&
			first.layout === second.layout &&
			first.fit === second.fit &&
			first.viewport.width === second.viewport.width &&
			first.viewport.height === second.viewport.height &&
			(first.devicePixelRatio ?? 1) === (second.devicePixelRatio ?? 1)
		);
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
		const stageSlot = shellElement?.querySelector<HTMLElement>(".stage-slot");
		if (
			stageSlot !== null &&
			stageSlot !== undefined &&
			getComputedStyle(stageSlot).display === "none"
		) {
			thumbnailsOpen = false;
		}
	}

	function onViewportChange(nextViewport: ViewportSize): void {
		viewport = nextViewport;
	}

	function onZoomGesture(value: number, center: GesturePoint): void {
		setZoomAt(value, center);
	}

	function onUserScroll(): void {
		clearZoomAnchor();
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

<div class="viewer-shell" lang={locale} bind:this={shellElement}>
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
					onUserScroll={onUserScroll}
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
			canNext={canMoveNext}
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
		color: var(--pamphlet-viewer-text);
		font: 14px/1.5 system-ui, sans-serif;
		color-scheme: dark;
		--pamphlet-viewer-text: #e4e7e9;
		--pamphlet-viewer-border: #3b4148;
		--pamphlet-viewer-stage: #191c20;
		--pamphlet-viewer-panel: #24282e;
		--pamphlet-viewer-toolbar: #24282e;
		--pamphlet-viewer-accent: #a8c5bc;
		--pamphlet-viewer-border-width: 1px;
		--pamphlet-viewer-control-height: 32px;
		--pamphlet-viewer-touch-target-size: 44px;
		--pamphlet-viewer-icon-button-width: 34px;
		--pamphlet-viewer-status-action-height: 34px;
		--pamphlet-viewer-control-radius: 4px;
		--pamphlet-viewer-field-radius: 3px;
		--pamphlet-viewer-panel-radius: 4px;
		--pamphlet-viewer-control-padding-block: 5px;
		--pamphlet-viewer-control-padding-inline: 7px;
		--pamphlet-viewer-control-gap: 6px;
		--pamphlet-viewer-compact-control-gap: 4px;
		--pamphlet-viewer-compact-toolbar-gap: 8px;
		--pamphlet-viewer-compact-menu-gap: 8px;
		--pamphlet-viewer-popup-offset: 6px;
		--pamphlet-viewer-toolbar-height: 52px;
		--pamphlet-viewer-toolbar-gap: 18px;
		--pamphlet-viewer-toolbar-padding-block: 6px;
		--pamphlet-viewer-toolbar-padding-inline: 12px;
		--pamphlet-viewer-compact-toolbar-height: 56px;
		--pamphlet-viewer-compact-toolbar-padding: 6px;
		--pamphlet-viewer-control-background: #191c20;
		--pamphlet-viewer-control-border: var(--pamphlet-viewer-border, #454b52);
		--pamphlet-viewer-control-hover: #343a41;
		--pamphlet-viewer-disabled-text: #727981;
		--pamphlet-viewer-thumbnail-current: #30373b;
		--pamphlet-viewer-thumbnail-hover: #2c3137;
		--pamphlet-viewer-focus-ring: 2px solid var(--pamphlet-viewer-accent);
		--pamphlet-viewer-focus-ring-offset: 1px;

		&:fullscreen {
			width: 100vw !important;
			height: 100dvh !important;
			min-height: 0 !important;
			background: var(--pamphlet-viewer-stage);
		}
	}

	:host([data-fullscreen-fallback]) {
		position: fixed;
		z-index: 2147483000;
		inset: 0;
		width: 100vw !important;
		height: 100dvh !important;
		min-height: 0 !important;
		background: var(--pamphlet-viewer-stage);
	}

	.viewer-shell {
		box-sizing: border-box;
		display: grid;
		-webkit-user-select: none;
		user-select: none;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto auto minmax(0, 1fr) auto auto;
		width: 100%;
		height: 100%;
		min-height: inherit;
		container-name: pamphlet-reader reader-toolbar;
		container-type: inline-size;
		overflow: hidden;
		border: var(--pamphlet-viewer-border-width) solid var(--pamphlet-viewer-border);
		background: var(--pamphlet-viewer-stage);

		:global(:is(input, textarea, select, [contenteditable]:not([contenteditable="false"]))) {
			-webkit-user-select: text;
			user-select: text;
		}

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
			background: var(--pamphlet-viewer-stage);
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
