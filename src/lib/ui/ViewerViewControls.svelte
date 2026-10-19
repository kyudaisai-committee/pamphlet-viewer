<script lang="ts">
	import { Maximize2Icon, Minimize2Icon } from "@lucide/svelte";

	import type { FitMode, LayoutMode } from "../domain/layout";

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
</script>

<div class="view-controls" role="group" aria-label="表示設定">
	<div class="fit-controls" role="group" aria-label="ページの合わせ方">
		<button type="button" aria-pressed={fit === "page"} disabled={!enabled} onclick={() => onFitChange("page")}>
			ページ
		</button>
		<button type="button" aria-pressed={fit === "width"} disabled={!enabled} onclick={() => onFitChange("width")}>
			幅
		</button>
	</div>
	<label class="layout-control">
		<span class="visually-hidden">ページ配置</span>
		<select
			aria-label="ページ配置"
			value={layout}
			disabled={!enabled}
			onchange={(event) => onLayoutChange(event.currentTarget.value)}
		>
			<option value="auto">自動</option>
			<option value="single">単ページ</option>
			<option value="spread">見開き</option>
		</select>
	</label>
	<details class="compact-settings">
		<summary>表示設定</summary>
		<div class="compact-settings-panel">
			<div class="fit-controls" role="group" aria-label="ページの合わせ方">
				<button type="button" aria-pressed={fit === "page"} disabled={!enabled} onclick={() => onFitChange("page")}>
					ページ
				</button>
				<button type="button" aria-pressed={fit === "width"} disabled={!enabled} onclick={() => onFitChange("width")}>
					幅
				</button>
			</div>
			<label class="layout-control">
				<span class="visually-hidden">ページ配置</span>
				<select
					aria-label="ページ配置"
					value={layout}
					disabled={!enabled}
					onchange={(event) => onLayoutChange(event.currentTarget.value)}
				>
					<option value="auto">自動</option>
					<option value="single">単ページ</option>
					<option value="spread">見開き</option>
				</select>
			</label>
		</div>
	</details>
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

		.fit-controls {
			display: flex;
			gap: 2px;
			padding: 2px;
			border: 1px solid var(--pamphlet-viewer-border, #454b52);
			border-radius: 4px;

			button {
				min-width: 38px;
				min-height: 28px;
				padding: 3px 6px;
				font-size: 12px;

				&[aria-pressed="true"] {
					background: #3a4245;
					color: #edf2ef;
				}
			}
		}

		.layout-control {
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
				min-height: 32px;
				padding: 4px 7px;
				border: 1px solid var(--pamphlet-viewer-border, #454b52);
				border-radius: 3px;
				background: #191c20;
				color: inherit;
				font: inherit;
			}
		}

		.compact-settings {
			display: none;

			summary {
				box-sizing: border-box;
				display: flex;
				align-items: center;
				min-height: 44px;
				padding: 4px 8px;
				border: 1px solid var(--pamphlet-viewer-border, #454b52);
				border-radius: 3px;
				cursor: pointer;

				&:focus-visible {
					outline: 2px solid var(--pamphlet-viewer-accent, #a8c5bc);
					outline-offset: 1px;
				}
			}

			&[open] .compact-settings-panel {
				display: grid;
			}

			.compact-settings-panel {
				position: absolute;
				z-index: 1;
				inset-block-start: calc(100% + 6px);
				inset-inline-end: 0;
				grid-template-columns: auto auto;
				gap: 8px;
				width: max-content;
				padding: 8px;
				border: 1px solid var(--pamphlet-viewer-border, #454b52);
				border-radius: 4px;
				background: var(--pamphlet-viewer-panel, #24282e);

				.fit-controls {
					display: flex;
				}

				.layout-control {
					display: block;
				}
			}
		}
	}

	@container reader-toolbar (max-width: 700px) {
		.view-controls {
			gap: 4px;

			button {
				min-height: 44px;
			}

			.icon-button {
				width: 44px;
			}

			> .fit-controls,
			> .layout-control {
				display: none;
			}

			.compact-settings {
				position: relative;
				display: block;
			}
		}
	}

	@container reader-toolbar (max-width: 340px) {
		.view-controls {
			margin-inline-start: auto;
		}
	}
</style>
