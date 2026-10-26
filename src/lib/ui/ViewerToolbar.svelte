<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { PamphletChapter } from "@/lib/public-api";
	import ViewerNavigationControls from "./ViewerNavigationControls.svelte";

	interface Props {
		page: number;
		pageCount: number;
		chapters: readonly PamphletChapter[];
		currentChapterPage?: number;
		bookmarkPages: readonly number[];
		bookmarked: boolean;
		bookmarkEnabled: boolean;
		enabled: boolean;
		canPrevious: boolean;
		canNext: boolean;
		thumbnailsOpen: boolean;
		onPageChange(value: string): void;
		onChapterChange(value: string): void;
		onToggleBookmark(): void;
		onSelectBookmark(value: string): void;
		onPrevious(): void;
		onNext(): void;
		onToggleThumbnails(): void;
	}

	let {
		page,
		pageCount,
		chapters,
		currentChapterPage,
		bookmarkPages,
		bookmarked,
		bookmarkEnabled,
		enabled,
		canPrevious,
		canNext,
		thumbnailsOpen,
		onPageChange,
		onChapterChange,
		onToggleBookmark,
		onSelectBookmark,
		onPrevious,
		onNext,
		onToggleThumbnails,
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
</div>

<style>
	.toolbar-container {
		box-sizing: border-box;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0;
		width: 100%;
		min-width: 0;
		min-height: var(--pamphlet-viewer-toolbar-height);
		padding: var(--pamphlet-viewer-toolbar-padding-block)
			var(--pamphlet-viewer-toolbar-padding-inline);
		border-bottom: var(--pamphlet-viewer-border-width) solid
			var(--pamphlet-viewer-border, #3b4148);
		background: var(--pamphlet-viewer-toolbar, #24282e);

		.toolbar {
			display: flex;
			align-items: center;
			min-width: max-content;
		}
	}

	@container reader-toolbar (max-width: 700px) {
		.toolbar-container {
			min-height: 0;
			padding: 0;
			border: 0;
			background: transparent;

			.toolbar {
				box-sizing: border-box;
				display: flex;
				align-items: center;
				position: relative;
				width: 100%;
				min-height: var(--pamphlet-viewer-compact-toolbar-height);
				min-width: 0;
				padding: var(--pamphlet-viewer-compact-toolbar-padding);
				border-top: var(--pamphlet-viewer-border-width) solid
					var(--pamphlet-viewer-border, #3b4148);
				background: var(--pamphlet-viewer-toolbar, #24282e);
			}
		}
	}
</style>
