<script lang="ts">
	import { RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from "@lucide/svelte";

	interface Props {
		zoom: number;
		enabled: boolean;
		onZoomChange(value: number): void;
		onResetZoom(): void;
	}

	let { zoom, enabled, onZoomChange, onResetZoom }: Props = $props();

	function setZoomFromInput(event: Event): void {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		onZoomChange(Number(input.value));
	}
</script>

<div class="zoom-controls" role="group" aria-label="拡大縮小">
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
	<input
		class="zoom-slider"
		type="range"
		min="0.1"
		max="8"
		step="0.1"
		value={zoom}
		aria-label="拡大率"
		disabled={!enabled}
		oninput={setZoomFromInput}
	/>
	<output class="zoom-level" aria-live="polite">{Math.round(zoom * 100)}%</output>
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
	<button
		class="text-button reset-zoom"
		type="button"
		aria-label="拡大率をリセット"
		title="拡大率をリセット"
		disabled={!enabled || zoom === 1}
		onclick={onResetZoom}
	>
		<RotateCcwIcon size={15} aria-hidden="true" />
		<span class="reset-label">合わせる</span>
	</button>
</div>

<style>
	.zoom-controls {
		display: flex;
		align-items: center;
		gap: 5px;

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

		.zoom-slider {
			width: clamp(72px, 9cqi, 142px);
			accent-color: var(--pamphlet-viewer-accent, #a8c5bc);
		}

		.zoom-level {
			min-width: 42px;
			font-size: 12px;
			font-variant-numeric: tabular-nums;
			text-align: center;
		}

		.reset-zoom {
			padding-inline: 8px;
			font-size: 12px;
		}

		.reset-label {
			display: inline;
		}
	}

	@container reader-toolbar (max-width: 700px) {
		.zoom-controls {
			grid-column: 1 / -1;
			justify-content: space-between;
			gap: 3px;

			.zoom-slider {
				flex: 1 1 56px;
				width: auto;
				min-width: 48px;
				max-width: 180px;
			}

			.reset-zoom {
				width: 44px;
				padding: 5px;
			}

			.reset-label {
				display: none;
			}

			button {
				min-height: 44px;
			}
		}
	}
</style>
