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
		gap: 18px;
		width: max-content;
		min-width: max-content;
		min-height: 52px;
		padding: 6px 12px;
		border-bottom: 1px solid var(--pamphlet-viewer-border, #3b4148);
		background: var(--pamphlet-viewer-toolbar, #24282e);

		@container reader-toolbar (max-width: 700px) {
			width: 100%;
			min-width: 0;
			min-height: 56px;
			flex-wrap: wrap;
			justify-content: space-between;
			gap: 8px;
			padding: 6px;
		}

		@container reader-toolbar (max-width: 340px) {
			row-gap: 4px;
		}
	}
</style>
