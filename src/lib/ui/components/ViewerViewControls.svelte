<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import { Maximize2Icon, Minimize2Icon } from "@lucide/svelte";

	import type { FitMode, LayoutMode } from "@/lib/domain/navigation/layout";
	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";

	interface ViewOption {
		value: string;
		fit: FitMode;
		layout: LayoutMode;
		label: string;
	}

	interface Props {
		fit: FitMode;
		layout: LayoutMode;
		enabled: boolean;
		fullscreen: boolean;
		onFitChange(value: FitMode): void;
		onLayoutChange(value: string): void;
		onToggleFullscreen(): void;
	}

	let {
		fit,
		layout,
		enabled,
		fullscreen,
		onFitChange,
		onLayoutChange,
		onToggleFullscreen,
	}: Props = $props();
	const messages = useViewerMessages();
	const viewOptions: readonly ViewOption[] = $derived.by(() => [
		{ value: "auto-page", layout: "auto", fit: "page", label: messages.viewAutoPage },
		{ value: "auto-width", layout: "auto", fit: "width", label: messages.viewAutoWidth },
		{ value: "single-page", layout: "single", fit: "page", label: messages.viewSinglePage },
		{ value: "single-width", layout: "single", fit: "width", label: messages.viewSingleWidth },
		{ value: "spread-page", layout: "spread", fit: "page", label: messages.viewSpreadPage },
		{ value: "spread-width", layout: "spread", fit: "width", label: messages.viewSpreadWidth },
	]);

	let selectedView = $derived(
		viewOptions.find((option) => option.fit === fit && option.layout === layout)?.value ??
			viewOptions[0].value,
	);

	function onViewChange(value: string): void {
		const option = viewOptions.find((viewOption) => viewOption.value === value);
		if (option === undefined) return;
		onLayoutChange(option.layout);
		onFitChange(option.fit);
	}
</script>

<div class="view-controls" role="group" aria-label={messages.viewSettingsLabel}>
	<label class="view-mode-control">
		<span class="visually-hidden">{messages.viewMode}</span>
		<select
			aria-label={messages.viewMode}
			value={selectedView}
			disabled={!enabled}
			onchange={(event) => onViewChange(event.currentTarget.value)}
		>
			{#each viewOptions as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
	</label>
	<button
		class="icon-button fullscreen-toggle"
		type="button"
		data-control="fullscreen"
		aria-label={fullscreen ? messages.exitFullscreen : messages.fullscreen}
		aria-pressed={fullscreen}
		title={fullscreen ? messages.exitFullscreen : messages.fullscreen}
		onclick={onToggleFullscreen}
	>
		{#if fullscreen}
			<Minimize2Icon size={18} aria-hidden="true" />
		{:else}
			<Maximize2Icon size={18} aria-hidden="true" />
		{/if}
	</button>
</div>

<style>
	.view-controls {
		display: flex;
		align-items: center;
		gap: var(--pamphlet-viewer-control-gap);

		button {
			box-sizing: border-box;
			min-height: var(--pamphlet-viewer-control-height);
			padding: var(--pamphlet-viewer-control-padding-block)
				var(--pamphlet-viewer-control-padding-inline);
			border: var(--pamphlet-viewer-border-width) solid transparent;
			border-radius: var(--pamphlet-viewer-control-radius);
			background: transparent;
			color: inherit;
			font: inherit;
			cursor: pointer;

			&:hover:not(:disabled) {
				background: var(--pamphlet-viewer-control-hover);
			}

			&:focus-visible {
				outline: var(--pamphlet-viewer-focus-ring);
				outline-offset: var(--pamphlet-viewer-focus-ring-offset);
			}

			&:disabled {
				color: var(--pamphlet-viewer-disabled-text);
				cursor: not-allowed;
			}
		}

		.icon-button {
			display: inline-grid;
			place-items: center;
			width: var(--pamphlet-viewer-icon-button-width);
			padding: var(--pamphlet-viewer-control-padding-block);
		}

		.view-mode-control {
			min-width: 0;

			.visually-hidden {
				position: absolute;
				width: 1px;
				height: 1px;
				padding: 0;
				margin: -1px;
				overflow: hidden;
				clip: rect(0, 0, 0, 0);
				white-space: nowrap;
				border: 0;
			}

			select {
				box-sizing: border-box;
				min-height: var(--pamphlet-viewer-control-height);
				max-width: min(250px, 45cqi);
				padding: 4px 7px;
				border: var(--pamphlet-viewer-border-width) solid
					var(--pamphlet-viewer-control-border);
				border-radius: var(--pamphlet-viewer-field-radius);
				background: var(--pamphlet-viewer-control-background);
				color: inherit;
				font: inherit;
			}
		}

	}
	@container reader-toolbar (max-width: 700px) {
		.view-controls {
			gap: var(--pamphlet-viewer-compact-control-gap);

			button {
				min-height: var(--pamphlet-viewer-touch-target-size);
			}

			.view-mode-control select {
				width: min(240px, calc(100cqi - 70px));
				min-height: var(--pamphlet-viewer-touch-target-size);
			}

			.icon-button {
				width: var(--pamphlet-viewer-touch-target-size);
			}
		}
	}

	@container reader-toolbar (max-width: 340px) {
		.view-controls {
			margin-inline-start: auto;
		}
	}
</style>
