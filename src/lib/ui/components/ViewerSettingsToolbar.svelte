<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { FitMode, LayoutMode } from "@/lib/domain/navigation/layout";
	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";
	import MenuBar from "./MenuBar.svelte";
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
	const messages = useViewerMessages();
</script>

{#snippet zoomControls()}
	<ZoomControls {zoom} {enabled} {onZoomChange} {onResetZoom} />
{/snippet}

{#snippet viewControls()}
	<ViewerViewControls
		{fit}
		{layout}
		{enabled}
		{fullscreen}
		{onFitChange}
		{onLayoutChange}
		{onToggleFullscreen}
	/>
{/snippet}

<div class="settings-toolbar" role="group" aria-label={messages.settingsLabel}>
	<MenuBar
		items={[
			{ kind: "snippet", id: "zoom-controls", content: zoomControls },
			{ kind: "spacer", id: "settings-spacer" },
			{ kind: "snippet", id: "view-controls", content: viewControls },
		]}
	/>
</div>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
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
	}

	@layer pamphlet-viewer.layout {
		.settings-toolbar {
			@container pamphlet-reader (min-width: 701px) and (max-width: 837px) {
				box-sizing: border-box;
				flex: 1 1 100%;
				width: 100%;
				min-width: 0;
			}
		}
	}
</style>
