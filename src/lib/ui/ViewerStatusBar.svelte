<script lang="ts">
	import type { ViewerPhase } from "../domain/viewer-controller.svelte";

	interface Props {
		phase: ViewerPhase;
		pageCount: number;
	}

	let { phase, pageCount }: Props = $props();
</script>

<div class="status-bar" aria-live="polite">
	{#if phase === "ready"}
		<span>{pageCount}ページ</span>
	{:else if phase === "loading"}
		<span>準備中</span>
	{:else if phase === "error"}
		<span>読み込みエラー</span>
	{:else}
		<span>PDF未選択</span>
	{/if}
</div>

<style>
	.status-bar {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		min-height: 30px;
		padding: 4px 12px;
		border-top: 1px solid var(--pamphlet-viewer-border, #d8dce5);
		background: var(--pamphlet-viewer-toolbar, #fbfcfe);
		color: #697284;
		font-size: 12px;
	}
</style>
