<script lang="ts">
	import { Maximize2Icon, Minimize2Icon } from "@lucide/svelte";

	import type { FitMode, LayoutMode } from "../domain/layout";

	interface ViewOption {
		value: string;
		fit: FitMode;
		layout: LayoutMode;
		label: string;
	}

	const VIEW_OPTIONS: readonly ViewOption[] = [
		{ value: "auto-page", layout: "auto", fit: "page", label: "自動・ページ全体" },
		{ value: "auto-width", layout: "auto", fit: "width", label: "自動・幅に合わせる" },
		{ value: "single-page", layout: "single", fit: "page", label: "単ページ・ページ全体" },
		{ value: "single-width", layout: "single", fit: "width", label: "単ページ・幅に合わせる" },
		{ value: "spread-page", layout: "spread", fit: "page", label: "見開き・ページ全体" },
		{ value: "spread-width", layout: "spread", fit: "width", label: "見開き・幅に合わせる" },
	];

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

	let selectedView = $derived(
		VIEW_OPTIONS.find((option) => option.fit === fit && option.layout === layout)?.value ??
			VIEW_OPTIONS[0].value,
	);

	function onViewChange(value: string): void {
		const option = VIEW_OPTIONS.find((viewOption) => viewOption.value === value);
		if (option === undefined) return;
		onLayoutChange(option.layout);
		onFitChange(option.fit);
	}
</script>

<div class="view-controls" role="group" aria-label="表示設定">
	<label class="view-mode-control">
		<span class="visually-hidden">表示方法</span>
		<select
			aria-label="表示方法"
			value={selectedView}
			disabled={!enabled}
			onchange={(event) => onViewChange(event.currentTarget.value)}
		>
			{#each VIEW_OPTIONS as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
	</label>
	<button
		class="icon-button fullscreen-toggle"
		type="button"
		data-control="fullscreen"
		aria-label={fullscreen ? "埋め込み表示に戻す" : "全画面表示"}
		aria-pressed={fullscreen}
		title={fullscreen ? "埋め込み表示に戻す" : "全画面表示"}
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
		gap: 6px;

		button {
			box-sizing: border-box;
			min-height: 32px;
			padding: 5px 7px;
			border: 1px solid transparent;
			border-radius: 4px;
			background: transparent;
			color: inherit;
			font: inherit;
			cursor: pointer;

			&:hover:not(:disabled) {
				background: #343a41;
			}

			&:focus-visible {
				outline: 2px solid var(--pamphlet-viewer-accent, #a8c5bc);
				outline-offset: 1px;
			}

			&:disabled {
				color: #727981;
				cursor: not-allowed;
			}
		}

		.icon-button {
			display: inline-grid;
			place-items: center;
			width: 34px;
			padding: 5px;
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
				min-height: 32px;
				max-width: min(250px, 45cqi);
				padding: 4px 7px;
				border: 1px solid var(--pamphlet-viewer-border, #454b52);
				border-radius: 3px;
				background: #191c20;
				color: inherit;
				font: inherit;
			}
		}

	}
	@container reader-toolbar (max-width: 700px) {
		.view-controls {
			gap: 4px;

			button {
				min-height: 44px;
			}

			.view-mode-control select {
				width: min(240px, calc(100cqi - 70px));
				min-height: 44px;
			}

			.icon-button {
				width: 44px;
			}
		}
	}

	@container reader-toolbar (max-width: 340px) {
		.view-controls {
			margin-inline-start: auto;
		}
	}
</style>
