<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { Snippet } from "svelte";

	import type { ReaderToolbarLayout } from "./reader-toolbar-layout";

	interface Props {
		layout: ReaderToolbarLayout;
		left: Snippet;
		right: Snippet;
	}

	let { layout, left, right }: Props = $props();
</script>

<div
	class="navigation-region"
	data-reader-region={layout.left.region}
	data-toolbar-side={layout.left.side}
>
	{@render left()}
</div>
<div class="settings-region" data-reader-region={layout.right.region} data-toolbar-side={layout.right.side}>
	{@render right()}
</div>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.layout {
	.navigation-region,
	.settings-region {
		min-width: 0;
	}

	[data-toolbar-side="left"] {
		grid-column: 1;
		grid-row: 1;
	}

	[data-toolbar-side="right"] {
		grid-column: 2;
		grid-row: 1;
	}

	@container pamphlet-reader (min-width: 701px) and (max-width: 837px) {
		.settings-region {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}

	@container pamphlet-reader (max-width: 700px) {
		[data-toolbar-side="right"] {
			grid-column: 1 / -1;
			grid-row: 1;
		}

		[data-toolbar-side="left"] {
			grid-column: 1 / -1;
			grid-row: 5;
		}
	}
	}
</style>
