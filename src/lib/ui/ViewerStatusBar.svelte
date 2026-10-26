<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { ViewerPhase } from "@/lib/domain/viewer/viewer-controller.svelte";
	import { useViewerMessages } from "../i18n/viewer-messages-context.svelte";

	interface Props {
		phase: ViewerPhase;
		pageCount: number;
	}

	let { phase, pageCount }: Props = $props();
	const messages = useViewerMessages();
</script>

<div class="status-bar" aria-live="polite">
	{#if phase === "ready"}
		<span>{messages.pageCount(pageCount)}</span>
	{:else if phase === "loading"}
		<span>{messages.statusLoading}</span>
	{:else if phase === "error"}
		<span>{messages.statusError}</span>
	{:else}
		<span>{messages.statusEmpty}</span>
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
		border-top: var(--pamphlet-viewer-border-width) solid
			var(--pamphlet-viewer-border, #d8dce5);
		background: var(--pamphlet-viewer-toolbar, #fbfcfe);
		color: #aeb4ba;
		font-size: 12px;
	}
</style>
