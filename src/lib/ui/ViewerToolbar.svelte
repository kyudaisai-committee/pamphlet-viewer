<script lang="ts">
	import type { FitMode, LayoutMode } from "../domain/layout";
	import type { PamphletChapter } from "@/lib/public-api";
	import ViewerNavigationControls from "./ViewerNavigationControls.svelte";
	import ViewerViewControls from "./ViewerViewControls.svelte";
	import ZoomControls from "./ZoomControls.svelte";

	interface Props {
		page: number;
		pageCount: number;
		chapters: readonly PamphletChapter[];
		currentChapterPage?: number;
		bookmarkPages: readonly number[];
		bookmarked: boolean;
		bookmarkEnabled: boolean;
		layout: LayoutMode;
		fit: FitMode;
		zoom: number;
		enabled: boolean;
		canPrevious: boolean;
		canNext: boolean;
		thumbnailsOpen: boolean;
		fullscreen: boolean;
		onPageChange(value: string): void;
		onChapterChange(value: string): void;
		onToggleBookmark(): void;
		onSelectBookmark(value: string): void;
		onLayoutChange(value: string): void;
		onFitChange(value: FitMode): void;
		onPrevious(): void;
		onNext(): void;
		onZoomChange(value: number): void;
		onResetZoom(): void;
		onToggleThumbnails(): void;
		onToggleFullscreen(): void;
	}

	let {
		page,
		pageCount,
		chapters,
		currentChapterPage,
		bookmarkPages,
		bookmarked,
		bookmarkEnabled,
		layout,
		fit,
		zoom,
		enabled,
		canPrevious,
		canNext,
		thumbnailsOpen,
		fullscreen,
		onPageChange,
		onChapterChange,
		onToggleBookmark,
		onSelectBookmark,
		onLayoutChange,
		onFitChange,
		onPrevious,
		onNext,
		onZoomChange,
		onResetZoom,
		onToggleThumbnails,
		onToggleFullscreen,
	}: Props = $props();

	function onToolbarKeydown(event: KeyboardEvent): void {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
		if (event.key === "ArrowLeft" || event.key === "PageUp") {
			event.preventDefault();
			onPrevious();
		} else if (event.key === "ArrowRight" || event.key === "PageDown") {
			event.preventDefault();
			onNext();
		}
	}
</script>

<div class="toolbar-container">
	<div
		class="toolbar"
		role="toolbar"
		aria-label="パンフレット操作"
		tabindex="0"
		onkeydown={onToolbarKeydown}
	>
		<ViewerNavigationControls
			{page}
			{pageCount}
			{chapters}
			{currentChapterPage}
			{bookmarkPages}
			{bookmarked}
			{bookmarkEnabled}
			{enabled}
			{canPrevious}
			{canNext}
			{thumbnailsOpen}
			{onPageChange}
			{onChapterChange}
			{onToggleBookmark}
			{onSelectBookmark}
			{onPrevious}
			{onNext}
			{onToggleThumbnails}
		/>
	</div>
	<div class="settings-toolbar" role="group" aria-label="ズームと表示設定">
		<ZoomControls {zoom} {enabled} {onZoomChange} {onResetZoom} />
		<ViewerViewControls
			{fit}
			{layout}
			{enabled}
			{fullscreen}
			{onFitChange}
			{onLayoutChange}
			{onToggleFullscreen}
		/>
	</div>
</div>

<style>
	.toolbar-container {
		box-sizing: border-box;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		width: 100%;
		min-width: 0;
		min-height: 52px;
		padding: 6px 12px;
		border-bottom: 1px solid var(--pamphlet-viewer-border, #3b4148);
		background: var(--pamphlet-viewer-toolbar, #24282e);

		.toolbar {
			display: flex;
			align-items: center;
			min-width: max-content;
		}

		.settings-toolbar {
			display: flex;
			align-items: center;
			justify-content: flex-end;
			gap: 18px;
			min-width: max-content;
		}
	}

	@container reader-toolbar (max-width: 700px) {
		.toolbar-container {
			display: contents;

			.toolbar {
				box-sizing: border-box;
				position: relative;
				display: flex;
				align-items: center;
				width: 100%;
				min-height: 56px;
				min-width: 0;
				padding: 6px;
				border-top: 1px solid var(--pamphlet-viewer-border, #3b4148);
				background: var(--pamphlet-viewer-toolbar, #24282e);
			}

			.settings-toolbar {
				box-sizing: border-box;
				display: flex;
				flex-wrap: wrap;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				width: 100%;
				min-height: 56px;
				min-width: 0;
				padding: 6px;
				border-bottom: 1px solid var(--pamphlet-viewer-border, #3b4148);
				background: var(--pamphlet-viewer-toolbar, #24282e);
			}
		}
	}

	@container reader-toolbar (max-width: 340px) {
		.toolbar-container {
			.settings-toolbar {
				row-gap: 4px;
			}
		}
	}
</style>
