<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import { BookmarkIcon, PanelLeftIcon, TableOfContentsIcon, XIcon } from "@lucide/svelte";
	import type { Snippet } from "svelte";

	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";
	import type { ReaderPanelTab } from "./reader-panel-state";

	interface Props {
		panel: ReaderPanelTab;
		hasChapters: boolean;
		hasBookmarks: boolean;
		pages: Snippet;
		chapters: Snippet;
		bookmarks: Snippet;
		onPanelChange(panel: ReaderPanelTab): void;
		onClose(): void;
	}

	let {
		panel,
		hasChapters,
		hasBookmarks,
		pages,
		chapters,
		bookmarks,
		onPanelChange,
		onClose,
	}: Props = $props();
	const messages = useViewerMessages();

	function getPanelLabel(panel: ReaderPanelTab): string {
		switch (panel) {
			case "pages":
				return messages.pageList;
			case "chapters":
				return messages.tableOfContents;
			case "bookmarks":
				return messages.bookmarkList;
		}
	}
</script>

<aside class="reader-panel" aria-labelledby="reader-panel-heading">
	<header
		class="panel-heading"
		class:few-panels={!hasChapters || !hasBookmarks}
		class:single-panel={!hasChapters && !hasBookmarks}
	>
		<h2 id="reader-panel-heading">{getPanelLabel(panel)}</h2>
		<button class="panel-close" type="button" aria-label={messages.closePanel} onclick={onClose}>
			<XIcon size={18} aria-hidden="true" />
		</button>
		<div class="panel-tabs" role="group" aria-label={messages.readerPanel}>
			<button
				class:active={panel === "pages"}
				type="button"
				aria-label={messages.pageList}
				aria-pressed={panel === "pages"}
				title={messages.pageList}
				onclick={() => onPanelChange("pages")}
			>
				<PanelLeftIcon size={18} aria-hidden="true" />
			</button>
			{#if hasChapters}
				<button
					class:active={panel === "chapters"}
					type="button"
					aria-label={messages.tableOfContents}
					aria-pressed={panel === "chapters"}
					title={messages.tableOfContents}
					onclick={() => onPanelChange("chapters")}
				>
					<TableOfContentsIcon size={18} aria-hidden="true" />
				</button>
			{/if}
			{#if hasBookmarks}
				<button
					class:active={panel === "bookmarks"}
					type="button"
					aria-label={messages.bookmarkList}
					aria-pressed={panel === "bookmarks"}
					title={messages.bookmarkList}
					onclick={() => onPanelChange("bookmarks")}
				>
					<BookmarkIcon size={18} aria-hidden="true" />
				</button>
			{/if}
		</div>
	</header>
	<div class="panel-content" aria-labelledby="reader-panel-heading">
		{#if panel === "pages"}
			{@render pages()}
		{:else if panel === "chapters"}
			{@render chapters()}
		{:else}
			{@render bookmarks()}
		{/if}
	</div>
</aside>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
		.reader-panel {
			box-sizing: border-box;
			display: grid;
			grid-template-rows: auto minmax(0, 1fr);
			width: 100%;
			height: 100%;
			min-width: 0;
			min-height: 0;
			border-inline-end: var(--pamphlet-viewer-border-width) solid
				var(--pamphlet-viewer-border, #3b4148);

			.panel-heading {
				box-sizing: border-box;
				display: grid;
				grid-template-columns: minmax(0, 1fr) auto;
				grid-template-rows: auto auto;
				align-items: center;
				gap: 4px 8px;
				padding: 6px 10px 8px 14px;
				border-bottom: var(--pamphlet-viewer-border-width) solid
					var(--pamphlet-viewer-border, #3b4148);

				h2 {
					grid-column: 1;
					grid-row: 1;
					min-width: 0;
					margin: 0;
					font-size: 13px;
					font-weight: 600;
				}

				.panel-close {
					grid-column: 2;
					grid-row: 1;
				}

				.panel-tabs {
					grid-column: 1 / -1;
					grid-row: 2;
					display: grid;
					grid-template-columns: repeat(3, minmax(0, 1fr));
					gap: 4px;
				}

				&.few-panels .panel-tabs {
					grid-template-columns: repeat(2, minmax(0, 1fr));
				}

				&.single-panel .panel-tabs {
					grid-template-columns: minmax(0, 1fr);
				}
			}

			.panel-close,
			.panel-tabs button {
				box-sizing: border-box;
				display: grid;
				place-items: center;
				width: var(--pamphlet-viewer-touch-target-size);
				min-height: var(--pamphlet-viewer-touch-target-size);
				padding: 4px;
				border: var(--pamphlet-viewer-border-width) solid transparent;
				border-radius: var(--pamphlet-viewer-control-radius);
				background: transparent;
				color: inherit;
				font: inherit;
				cursor: pointer;

				@media (hover: hover) {
					&:hover {
						background: var(--pamphlet-viewer-control-hover);
					}
				}

				&:focus-visible {
					outline: var(--pamphlet-viewer-focus-ring);
					outline-offset: var(--pamphlet-viewer-focus-ring-offset);
				}
			}

			.panel-tabs button {
				width: 100%;

				&.active {
					border-color: var(--pamphlet-viewer-accent, #a8c5bc);
					background: var(--pamphlet-viewer-thumbnail-current);
				}
			}

			.panel-content {
				min-width: 0;
				min-height: 0;
				overflow: hidden;
			}
		}
	}
</style>
