<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";

	interface Props {
		requestId: number | null;
	}

	let { requestId }: Props = $props();
	const messages = useViewerMessages();
	const RENDERING_FEEDBACK_DELAY_MS = 100;
	let visible = $state(false);

	$effect(() => {
		if (requestId === null) {
			visible = false;
			return;
		}

		visible = false;
		const timeout = window.setTimeout(() => {
			visible = true;
		}, RENDERING_FEEDBACK_DELAY_MS);
		return () => window.clearTimeout(timeout);
	});
</script>

{#if visible}
	<div class="rendering-feedback" role="status">{messages.renderingPage}</div>
{/if}

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
		.rendering-feedback {
			position: absolute;
			inset-inline: 16px;
			inset-block-end: 16px;
			z-index: 1;
			box-sizing: border-box;
			width: fit-content;
			max-width: calc(100% - 32px);
			margin-inline: auto;
			padding: 8px 12px;
			border: var(--pamphlet-viewer-border-width) solid #aeb4ba;
			border-radius: var(--pamphlet-viewer-control-radius, 4px);
			background: #111416;
			color: #fff;
			box-shadow: 0 2px 12px rgb(0 0 0 / 55%);
			font-size: 14px;
			font-weight: 500;
			text-align: center;
			pointer-events: none;
		}
	}
</style>
