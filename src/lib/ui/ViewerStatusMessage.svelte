<script lang="ts">
	import type { ViewerFailure, ViewerPhase } from "../domain/viewer-controller.svelte";

	interface Props {
		phase: ViewerPhase;
		failure: ViewerFailure | null;
		onRetry(): void;
	}

	let { phase, failure, onRetry }: Props = $props();
</script>

<div class="status" role={phase === "error" ? "alert" : "status"}>
	{#if phase === "loading"}
		<span>PDFの情報を読み込んでいます。</span>
	{:else if phase === "error"}
		<p>{failure?.message ?? "PDFを表示できませんでした。"}</p>
		{#if failure?.retryable}
			<button type="button" onclick={onRetry}>再試行</button>
		{/if}
	{:else if phase === "ready"}
		<span>ページを描画しています。</span>
	{:else}
		<span>PDFのURLを設定すると、ここにパンフレットが表示されます。</span>
	{/if}
</div>

<style>
	.status {
		box-sizing: border-box;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 12px;
		min-height: 100%;
		padding: 24px;
		color: #c1c6cb;
		text-align: center;

		&[role="alert"] {
			color: #f3a6a6;
		}

		button {
			min-height: 34px;
			padding: 6px 10px;
			border: 1px solid currentColor;
			background: transparent;
			color: inherit;
			font: inherit;
			cursor: pointer;

			&:focus-visible {
				outline: 2px solid var(--pamphlet-viewer-accent, #3157a4);
				outline-offset: 2px;
			}
		}
	}
</style>
