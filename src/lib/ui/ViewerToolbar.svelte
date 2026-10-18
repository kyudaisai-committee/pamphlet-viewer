<script lang="ts">
	import { ChevronLeftIcon, ChevronRightIcon, PanelLeftIcon } from "@lucide/svelte";

	import type { GesturePoint } from "../domain/reader-gesture";
	import type { FitMode, LayoutMode } from "../domain/layout";
	import ViewerViewControls from "./ViewerViewControls.svelte";
	import ZoomControls from "./ZoomControls.svelte";

	interface Props {
		page: number;
		pageCount: number;
		layout: LayoutMode;
		fit: FitMode;
		zoom: number;
		enabled: boolean;
		canPrevious: boolean;
		canNext: boolean;
		thumbnailsOpen: boolean;
		fullscreen: boolean;
		onPageChange(value: string): void;
		onLayoutChange(value: string): void;
		onFitChange(value: FitMode): void;
		onPrevious(): void;
		onNext(): void;
		onZoomChange(value: number, anchor: GesturePoint): void;
		onResetZoom(anchor: GesturePoint): void;
		onToggleThumbnails(): void;
		onToggleFullscreen(): void;
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
		thumbnailsOpen,
		fullscreen,
		onPageChange,
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
		<div class="control-group page-controls" role="group" aria-label="ページ移動">
			<button
				class="icon-button thumbnail-toggle"
				type="button"
				aria-label={thumbnailsOpen ? "ページ一覧を閉じる" : "ページ一覧を開く"}
				aria-expanded={thumbnailsOpen}
				title={thumbnailsOpen ? "ページ一覧を閉じる" : "ページ一覧を開く"}
				onclick={onToggleThumbnails}
			>
				<PanelLeftIcon size={18} aria-hidden="true" />
			</button>
			<button
				class="icon-button"
				type="button"
				aria-label="前のページ"
				title="前のページ"
				aria-keyshortcuts="ArrowLeft PageUp"
				disabled={!enabled || !canPrevious}
				onclick={onPrevious}
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
			>
				<ChevronRightIcon size={18} aria-hidden="true" />
			</button>
		</div>

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
		container-name: reader-toolbar;
		container-type: inline-size;

		.toolbar {
			box-sizing: border-box;
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: space-between;
			gap: 8px 18px;
			min-height: 52px;
			padding: 6px 12px;
			border-bottom: 1px solid var(--pamphlet-viewer-border, #3b4148);
			background: var(--pamphlet-viewer-toolbar, #24282e);

			.control-group {
				display: flex;
				align-items: center;
				gap: 6px;
			}

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

			.page-number {
				display: inline-flex;
				align-items: center;
				gap: 5px;
				white-space: nowrap;

				input {
					box-sizing: border-box;
					width: 46px;
					min-height: 32px;
					padding: 4px;
					border: 1px solid var(--pamphlet-viewer-border, #454b52);
					border-radius: 3px;
					background: #191c20;
					color: inherit;
					font: inherit;
					text-align: center;
				}
			}
		}
	}

	@container reader-toolbar (max-width: 700px) {
		.toolbar-container {
			.toolbar {
				display: grid;
				grid-template-columns: minmax(0, 1fr) auto;
				gap: 6px 8px;
				padding: 6px;

				.page-controls {
					grid-column: 1;
					gap: 4px;

					button {
						min-height: 44px;
					}

					.icon-button {
						width: 44px;
					}

					.page-number {
						input {
							width: 38px;
							min-height: 44px;
						}
					}
				}
			}
		}
	}
</style>
