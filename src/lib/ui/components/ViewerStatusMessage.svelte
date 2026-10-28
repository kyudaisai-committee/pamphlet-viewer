<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { ViewerFailure, ViewerPhase } from "@/lib/domain/viewer/viewer-controller.svelte";
	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";

	interface Props {
		phase: ViewerPhase;
		failure: ViewerFailure | null;
		onRetry(): void;
	}

	let { phase, failure, onRetry }: Props = $props();
	const messages = useViewerMessages();
	const RENDERING_STATUS_DELAY_MS = 100;
	let renderingStatusVisible = $state(false);

	$effect(() => {
		if (phase !== "ready") {
			renderingStatusVisible = false;
			return;
		}

		const timeout = window.setTimeout(() => {
			renderingStatusVisible = true;
		}, RENDERING_STATUS_DELAY_MS);
		return () => window.clearTimeout(timeout);
	});
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
		{#if renderingStatusVisible}
			<span>{messages.renderingPage}</span>
		{/if}
	{:else}
		<span>{messages.emptyViewer}</span>
	{/if}
</div>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
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
	}
</style>
