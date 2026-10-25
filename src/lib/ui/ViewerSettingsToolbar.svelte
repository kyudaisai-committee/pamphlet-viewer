<!-- SPDX-License-Identifier: MPL-2.0 -->

<script lang="ts">
	import type { FitMode, LayoutMode } from "../domain/layout";
	import ViewerViewControls from "./ViewerViewControls.svelte";
	import ZoomControls from "./ZoomControls.svelte";

	interface Props {
		layout: LayoutMode;
		fit: FitMode;
		zoom: number;
		enabled: boolean;
		fullscreen: boolean;
		onLayoutChange(value: string): void;
		onFitChange(value: FitMode): void;
		onZoomChange(value: number): void;
		onResetZoom(): void;
		onToggleFullscreen(): void;
	}

	let {
		layout,
		fit,
		zoom,
		enabled,
		fullscreen,
		onLayoutChange,
		onFitChange,
		onZoomChange,
		onResetZoom,
		onToggleFullscreen,
	}: Props = $props();
</script>

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

<style>
	.settings-toolbar {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--pamphlet-viewer-toolbar-gap);
		width: max-content;
		min-width: max-content;
		min-height: var(--pamphlet-viewer-toolbar-height);
		padding: var(--pamphlet-viewer-toolbar-padding-block)
			var(--pamphlet-viewer-toolbar-padding-inline);
		border-bottom: var(--pamphlet-viewer-border-width) solid
			var(--pamphlet-viewer-border, #3b4148);
		background: var(--pamphlet-viewer-toolbar, #24282e);

		@container reader-toolbar (max-width: 700px) {
			width: 100%;
			min-width: 0;
			min-height: var(--pamphlet-viewer-compact-toolbar-height);
			flex-wrap: wrap;
			justify-content: space-between;
			gap: var(--pamphlet-viewer-compact-toolbar-gap);
			padding: var(--pamphlet-viewer-compact-toolbar-padding);
		}

		@container reader-toolbar (max-width: 340px) {
			row-gap: var(--pamphlet-viewer-compact-control-gap);
		}
	}
</style>
