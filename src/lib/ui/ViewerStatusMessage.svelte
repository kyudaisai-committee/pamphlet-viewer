<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { ViewerFailure, ViewerPhase } from "@/lib/domain/viewer/viewer-controller.svelte";
	import { useViewerMessages } from "../i18n/viewer-messages-context.svelte";

	interface Props {
		phase: ViewerPhase;
		failure: ViewerFailure | null;
		onRetry(): void;
	}

	let { phase, failure, onRetry }: Props = $props();
	const messages = useViewerMessages();
</script>

<div class="status" role={phase === "error" ? "alert" : "status"}>
	{#if phase === "loading"}
		<span>{messages.loadingDocument}</span>
	{:else if phase === "error"}
		<p>{failure?.message ?? messages.displayError}</p>
		{#if failure?.retryable}
			<button type="button" onclick={onRetry}>{messages.retry}</button>
		{/if}
	{:else if phase === "ready"}
		<span>{messages.renderingPage}</span>
	{:else}
		<span>{messages.emptyViewer}</span>
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
			min-height: var(--pamphlet-viewer-status-action-height);
			padding: 6px 10px;
			border: var(--pamphlet-viewer-border-width) solid currentColor;
			background: transparent;
			color: inherit;
			font: inherit;
			cursor: pointer;

			&:focus-visible {
				outline: var(--pamphlet-viewer-focus-ring);
				outline-offset: 2px;
			}
		}
	}
</style>
