<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { MenuBarItem } from "./menu-bar-items";

	interface Props {
		items: readonly MenuBarItem[];
	}

	let { items }: Props = $props();
</script>

<div class="menu-bar-items">
	{#each items as item (item.id)}
		{#if item.kind === "spacer"}
			<span class="menu-bar-spacer" aria-hidden="true"></span>
		{:else}
			{@render item.content()}
		{/if}
	{/each}
</div>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
	.menu-bar-items {
		display: contents;
	}

	.menu-bar-spacer {
		flex: 1 1 auto;
		min-width: 0;
	}

	@container reader-toolbar (max-width: 700px) {
		.menu-bar-spacer {
			display: none;
		}
	}
	}
</style>
