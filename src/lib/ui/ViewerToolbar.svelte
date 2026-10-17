<script lang="ts">
	import {
		ChevronLeftIcon,
		ChevronRightIcon,
		ZoomInIcon,
		ZoomOutIcon,
	} from "@lucide/svelte";

	import type { FitMode, LayoutMode } from "../domain/layout";

	interface Props {
		page: number;
		pageCount: number;
		layout: LayoutMode;
		fit: FitMode;
		zoom: number;
		enabled: boolean;
		canPrevious: boolean;
		canNext: boolean;
		onPageChange(value: string): void;
		onLayoutChange(value: string): void;
		onFitChange(value: FitMode): void;
		onPrevious(): void;
		onNext(): void;
		onZoomChange(value: number): void;
	}

	let {
		page,
		pageCount,
		layout,
		fit,
		zoom,
		enabled,
		canPrevious,
		canNext,
		onPageChange,
		onLayoutChange,
		onFitChange,
		onPrevious,
		onNext,
		onZoomChange,
	}: Props = $props();

	function onNavigationKeydown(event: KeyboardEvent, direction: "previous" | "next"): void {
		const previousKeys = ["ArrowLeft", "PageUp"];
		const nextKeys = ["ArrowRight", "PageDown"];
		if (direction === "previous" && previousKeys.includes(event.key)) {
			event.preventDefault();
			onPrevious();
		}
		if (direction === "next" && nextKeys.includes(event.key)) {
			event.preventDefault();
			onNext();
		}
	}
</script>

	<div class="toolbar" role="toolbar" aria-label="パンフレット操作">
	<div class="page-navigation" aria-label="ページ移動">
		<button
			class="icon-button"
			type="button"
			aria-label="前のページ"
			title="前のページ"
			aria-keyshortcuts="ArrowLeft PageUp"
			disabled={!enabled || !canPrevious}
			onclick={onPrevious}
			onkeydown={(event) => onNavigationKeydown(event, "previous")}
		>
			<ChevronLeftIcon size={18} aria-hidden="true" />
		</button>
		<label class="page-number">
			<input
				type="number"
				min="1"
				max={pageCount}
				value={page}
				aria-label="ページ番号"
				disabled={!enabled}
				onchange={(event) => onPageChange(event.currentTarget.value)}
			/>
			<span aria-hidden="true">/ {pageCount || "—"}</span>
		</label>
		<button
			class="icon-button"
			type="button"
			aria-label="次のページ"
			title="次のページ"
			aria-keyshortcuts="ArrowRight PageDown"
			disabled={!enabled || !canNext}
			onclick={onNext}
			onkeydown={(event) => onNavigationKeydown(event, "next")}
		>
			<ChevronRightIcon size={18} aria-hidden="true" />
		</button>
	</div>

	<div class="toolbar-divider" aria-hidden="true"></div>

	<div class="zoom-controls" aria-label="拡大縮小">
		<button
			class="icon-button"
			type="button"
			aria-label="縮小"
			title="縮小"
			disabled={!enabled || zoom <= 0.1}
			onclick={() => onZoomChange(Math.max(0.1, zoom / 1.2))}
		>
			<ZoomOutIcon size={18} aria-hidden="true" />
		</button>
		<span class="zoom-level" aria-live="polite">{Math.round(zoom * 100)}%</span>
		<button
			class="icon-button"
			type="button"
			aria-label="拡大"
			title="拡大"
			disabled={!enabled || zoom >= 8}
			onclick={() => onZoomChange(Math.min(8, zoom * 1.2))}
		>
			<ZoomInIcon size={18} aria-hidden="true" />
		</button>
	</div>

	<div class="toolbar-divider" aria-hidden="true"></div>

	<label class="layout-control">
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

		<div class="fit-controls" role="group" aria-label="ページの合わせ方">
		<button type="button" aria-pressed={fit === "page"} disabled={!enabled} onclick={() => onFitChange("page")}>
			ページ
		</button>
		<button type="button" aria-pressed={fit === "width"} disabled={!enabled} onclick={() => onFitChange("width")}>
			幅
		</button>
	</div>
</div>

<style>
	.toolbar {
		box-sizing: border-box;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 56px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--pamphlet-viewer-border, #d8dce5);
		background: var(--pamphlet-viewer-toolbar, #fbfcfe);

		.page-navigation,
		.zoom-controls,
		.fit-controls {
			display: inline-flex;
			align-items: center;
			gap: 6px;
		}

		button {
			box-sizing: border-box;
			min-width: 34px;
			min-height: 34px;
			padding: 6px;
			border: 1px solid var(--pamphlet-viewer-border, #d8dce5);
			border-radius: 4px;
			background: transparent;
			color: inherit;
			font: inherit;
			cursor: pointer;

			&:focus-visible {
				outline: 2px solid var(--pamphlet-viewer-accent, #3157a4);
				outline-offset: 2px;
			}

			&:disabled {
				color: #9299a7;
				cursor: not-allowed;
			}
		}

		.icon-button {
			display: inline-grid;
			place-items: center;
		}

		.page-navigation {
			.page-number {
				display: inline-flex;
				align-items: center;
				gap: 5px;
				white-space: nowrap;

				input {
					box-sizing: border-box;
					width: 52px;
					min-height: 34px;
					padding: 5px 6px;
					border: 1px solid var(--pamphlet-viewer-border, #d8dce5);
					border-radius: 4px;
					background: #fff;
					color: inherit;
					font: inherit;
					text-align: center;
				}
			}
		}

		.zoom-controls {
			.zoom-level {
				min-width: 44px;
				font-variant-numeric: tabular-nums;
				text-align: center;
			}
		}

		.toolbar-divider {
			width: 1px;
			height: 24px;
			background: var(--pamphlet-viewer-border, #d8dce5);
		}

		.layout-control {
			select {
				min-height: 34px;
				padding: 5px 8px;
				border: 1px solid var(--pamphlet-viewer-border, #d8dce5);
				border-radius: 4px;
				background: #fff;
				color: inherit;
				font: inherit;
			}
		}

		.fit-controls {
			gap: 2px;

			button {
				min-width: 42px;
				padding: 3px 8px;

				&[aria-pressed="true"] {
					background: #e9ecf2;
				}
			}
		}
	}

	@media (max-width: 620px) {
		.toolbar {
			gap: 6px;
			padding: 7px;

			.toolbar-divider {
				display: none;
			}
		}
	}
</style>
