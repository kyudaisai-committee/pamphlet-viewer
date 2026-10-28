<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import {
		BookmarkIcon,
		ChevronLeftIcon,
		ChevronRightIcon,
		PanelLeftIcon,
		TableOfContentsIcon,
	} from "@lucide/svelte";

	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";
	import type { ReaderPanelTab } from "./ReaderPanel.svelte";
	import MenuBar from "./MenuBar.svelte";

	interface Props {
		page: number;
		pageCount: number;
		chapterCount: number;
		panel: ReaderPanelTab | null;
		bookmarkEnabled: boolean;
		enabled: boolean;
		canPrevious: boolean;
		canNext: boolean;
		onPageChange(value: string): void;
		onTogglePanel(panel: ReaderPanelTab): void;
		onPrevious(): void;
		onNext(): void;
	}

	let {
		page,
		pageCount,
		chapterCount,
		panel,
		bookmarkEnabled,
		enabled,
		canPrevious,
		canNext,
		onPageChange,
		onTogglePanel,
		onPrevious,
		onNext,
	}: Props = $props();
	const messages = useViewerMessages();
</script>

{#snippet pageNavigation()}
	<div class="page-controls" role="group" aria-label={messages.pageNavigationLabel}>
		<button
			class="icon-button thumbnail-toggle"
			data-panel-toggle="pages"
			type="button"
			aria-label={panel === "pages" ? messages.hidePages : messages.showPages}
			aria-expanded={panel === "pages"}
			title={panel === "pages" ? messages.hidePages : messages.showPages}
			onclick={() => onTogglePanel("pages")}
		>
			<PanelLeftIcon size={18} aria-hidden="true" />
		</button>
		<button
			class="icon-button"
			type="button"
			aria-label={messages.previousPage}
			title={messages.previousPage}
			aria-keyshortcuts="ArrowLeft PageUp"
			disabled={!enabled || !canPrevious}
			onclick={onPrevious}
		>
			<ChevronLeftIcon size={18} aria-hidden="true" />
		</button>
		<label class="page-number">
			<input
				type="number"
				min="1"
				max={pageCount}
				value={page}
				aria-label={messages.pageNumber}
				disabled={!enabled}
				onchange={(event) => onPageChange(event.currentTarget.value)}
			/>
			<span aria-hidden="true">/ {pageCount || "—"}</span>
		</label>
		<button
			class="icon-button"
			type="button"
			aria-label={messages.nextPage}
			title={messages.nextPage}
			aria-keyshortcuts="ArrowRight PageDown"
			disabled={!enabled || !canNext}
			onclick={onNext}
		>
			<ChevronRightIcon size={18} aria-hidden="true" />
		</button>
	</div>
{/snippet}

{#snippet panelNavigation()}
	<div class="panel-controls" role="group" aria-label={messages.readerPanel}>
		{#if chapterCount > 0}
			<button
				class="icon-button panel-toggle"
				data-panel-toggle="chapters"
				type="button"
				aria-label={panel === "chapters" ? messages.closePanel : messages.openTableOfContents}
				aria-expanded={panel === "chapters"}
				title={panel === "chapters" ? messages.closePanel : messages.openTableOfContents}
				onclick={() => onTogglePanel("chapters")}
			>
				<TableOfContentsIcon size={18} aria-hidden="true" />
			</button>
		{/if}
		<button
			class="icon-button bookmark-toggle"
			data-panel-toggle="bookmarks"
			type="button"
			aria-label={panel === "bookmarks" ? messages.closePanel : messages.openBookmarks}
			aria-expanded={panel === "bookmarks"}
			title={panel === "bookmarks" ? messages.closePanel : messages.openBookmarks}
			disabled={!bookmarkEnabled}
			onclick={() => onTogglePanel("bookmarks")}
		>
			<BookmarkIcon size={18} aria-hidden="true" />
		</button>
	</div>
{/snippet}

<MenuBar
	items={[
		{ kind: "snippet", id: "page-navigation", content: pageNavigation },
		{ kind: "snippet", id: "panel-navigation", content: panelNavigation },
		{ kind: "spacer", id: "navigation-spacer" },
	]}
/>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
		.page-controls,
		.panel-controls {
			display: flex;
			align-items: center;
			gap: var(--pamphlet-viewer-control-gap);

			button {
				box-sizing: border-box;
				min-height: var(--pamphlet-viewer-control-height);
				padding: var(--pamphlet-viewer-control-padding-block)
					var(--pamphlet-viewer-control-padding-inline);
				border: var(--pamphlet-viewer-border-width) solid transparent;
				border-radius: var(--pamphlet-viewer-control-radius);
				background: transparent;
				color: inherit;
				font: inherit;
				cursor: pointer;

				&:hover:not(:disabled) {
					background: var(--pamphlet-viewer-control-hover);
				}

				&:focus-visible {
					outline: var(--pamphlet-viewer-focus-ring);
					outline-offset: var(--pamphlet-viewer-focus-ring-offset);
				}

				&:disabled {
					color: var(--pamphlet-viewer-disabled-text);
					cursor: not-allowed;
				}
			}

			.icon-button {
				display: inline-grid;
				place-items: center;
				width: var(--pamphlet-viewer-icon-button-width);
				padding: var(--pamphlet-viewer-control-padding-block);
			}
		}

		.page-number {
			display: inline-flex;
			align-items: center;
			gap: 5px;
			white-space: nowrap;

			input {
				box-sizing: border-box;
				width: 46px;
				min-height: var(--pamphlet-viewer-control-height);
				padding: 4px;
				border: var(--pamphlet-viewer-border-width) solid
					var(--pamphlet-viewer-control-border);
				border-radius: var(--pamphlet-viewer-field-radius);
				background: var(--pamphlet-viewer-control-background);
				color: inherit;
				font: inherit;
				text-align: center;
			}
		}

		@container reader-toolbar (max-width: 700px) {
			.page-controls,
			.panel-controls {
				gap: var(--pamphlet-viewer-compact-control-gap);

				button,
				.icon-button {
					min-height: var(--pamphlet-viewer-touch-target-size);
				}

				.icon-button {
					width: var(--pamphlet-viewer-touch-target-size);
				}
			}

			.page-number input {
				width: 38px;
				min-height: var(--pamphlet-viewer-touch-target-size);
			}
		}
	}
</style>
