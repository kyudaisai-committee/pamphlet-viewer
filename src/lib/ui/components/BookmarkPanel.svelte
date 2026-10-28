<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import { BookmarkCheckIcon, BookmarkIcon } from "@lucide/svelte";

	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";

	interface Props {
		page: number;
		bookmarkPages: readonly number[];
		bookmarked: boolean;
		bookmarkEnabled: boolean;
		onToggleBookmark(): void;
		onSelectBookmark(page: number): void;
	}

	let {
		page,
		bookmarkPages,
		bookmarked,
		bookmarkEnabled,
		onToggleBookmark,
		onSelectBookmark,
	}: Props = $props();
	const messages = useViewerMessages();
</script>

<div class="bookmark-panel">
	<button
		class="bookmark-current"
		type="button"
		aria-label={bookmarked ? messages.removeBookmark : messages.bookmarkPage}
		aria-pressed={bookmarked}
		disabled={!bookmarkEnabled}
		onclick={onToggleBookmark}
	>
		{#if bookmarked}
			<BookmarkCheckIcon size={18} aria-hidden="true" />
			<span>{messages.bookmarkRemoved}</span>
		{:else}
			<BookmarkIcon size={18} aria-hidden="true" />
			<span>{messages.bookmarkAdded}</span>
		{/if}
	</button>
	{#if bookmarkPages.length > 0}
		<ul class="bookmark-list" aria-label={messages.bookmarkList}>
			{#each bookmarkPages as savedPage (savedPage)}
				<li>
					<button
						class="bookmark-entry"
						class:current={savedPage === page}
						data-bookmark-page={savedPage}
						aria-current={savedPage === page ? "page" : undefined}
						type="button"
						disabled={!bookmarkEnabled}
						onclick={() => onSelectBookmark(savedPage)}
					>
						<span>{messages.savedPage(savedPage)}</span>
						{#if savedPage === page}
							<span class="current-label">{messages.currentPage}</span>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="empty-bookmarks">{messages.noBookmarks}</p>
	{/if}
</div>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
		.bookmark-panel {
			box-sizing: border-box;
			display: grid;
			grid-template-rows: auto minmax(0, 1fr);
			align-content: start;
			gap: 8px;
			width: 100%;
			height: 100%;
			min-width: 0;
			min-height: 0;
			padding: 8px;

			.bookmark-current {
				box-sizing: border-box;
				display: flex;
				align-items: center;
				justify-content: center;
				gap: 8px;
				width: 100%;
				min-height: var(--pamphlet-viewer-touch-target-size);
				padding: 6px 10px;
				border: var(--pamphlet-viewer-border-width) solid
					var(--pamphlet-viewer-control-border);
				border-radius: var(--pamphlet-viewer-control-radius);
				background: var(--pamphlet-viewer-control-background);
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

			.bookmark-list {
				box-sizing: border-box;
				display: flex;
				flex-direction: column;
				gap: 4px;
				min-width: 0;
				min-height: 0;
				margin: 0;
				padding: 0;
				list-style: none;
				overflow: auto;
				scrollbar-color: #59616a transparent;

				li {
					min-width: 0;
				}
			}

			.bookmark-entry {
				box-sizing: border-box;
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				width: 100%;
				min-height: var(--pamphlet-viewer-touch-target-size);
				padding: 6px 8px;
				border: var(--pamphlet-viewer-border-width) solid transparent;
				border-radius: var(--pamphlet-viewer-panel-radius);
				background: transparent;
				color: #c6cbd1;
				font: inherit;
				text-align: start;
				cursor: pointer;

				&.current {
					border-color: var(--pamphlet-viewer-accent, #a8c5bc);
					background: var(--pamphlet-viewer-thumbnail-current);
					color: #f3f5f4;
				}

				&:hover:not(.current) {
					background: var(--pamphlet-viewer-thumbnail-hover);
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

			.current-label {
				color: var(--pamphlet-viewer-accent, #a8c5bc);
				font-size: 11px;
			}

			.empty-bookmarks {
				align-self: start;
				margin: 4px;
				color: #aeb4ba;
				font-size: 13px;
			}
		}
	}
</style>
