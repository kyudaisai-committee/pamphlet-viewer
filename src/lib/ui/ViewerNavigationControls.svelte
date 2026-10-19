<script lang="ts">
	import {
		BookmarkCheckIcon,
		BookmarkIcon,
		ChevronLeftIcon,
		ChevronRightIcon,
		PanelLeftIcon,
	} from "@lucide/svelte";

	import type { PamphletChapter } from "@/lib/public-api";
	import CompactNavigation from "./CompactNavigation.svelte";

	interface Props {
		page: number;
		pageCount: number;
		chapters: readonly PamphletChapter[];
		currentChapterPage?: number;
		bookmarkPages: readonly number[];
		bookmarked: boolean;
		bookmarkEnabled: boolean;
		enabled: boolean;
		canPrevious: boolean;
		canNext: boolean;
		thumbnailsOpen: boolean;
		onPageChange(value: string): void;
		onChapterChange(value: string): void;
		onToggleBookmark(): void;
		onSelectBookmark(value: string): void;
		onPrevious(): void;
		onNext(): void;
		onToggleThumbnails(): void;
	}

	let {
		page,
		pageCount,
		chapters,
		currentChapterPage,
		bookmarkPages,
		bookmarked,
		bookmarkEnabled,
		enabled,
		canPrevious,
		canNext,
		thumbnailsOpen,
		onPageChange,
		onChapterChange,
		onToggleBookmark,
		onSelectBookmark,
		onPrevious,
		onNext,
		onToggleThumbnails,
	}: Props = $props();
</script>

<div class="page-controls" role="group" aria-label="ページ移動">
	<button
		class="icon-button thumbnail-toggle"
		type="button"
		aria-label={thumbnailsOpen ? "ページ一覧を閉じる" : "ページ一覧を開く"}
		aria-expanded={thumbnailsOpen}
		title={thumbnailsOpen ? "ページ一覧を閉じる" : "ページ一覧を開く"}
		onclick={onToggleThumbnails}
	>
		<PanelLeftIcon size={18} aria-hidden="true" />
	</button>
	<button
		class="icon-button"
		type="button"
		aria-label="前のページ"
		title="前のページ"
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
			aria-label="ページ番号"
			disabled={!enabled}
			onchange={(event) => onPageChange(event.currentTarget.value)}
		/>
		<span aria-hidden="true">/ {pageCount || "—"}</span>
	</label>
	<button
		class="icon-button"
		type="button"
		aria-label="次のページ"
		title="次のページ"
		aria-keyshortcuts="ArrowRight PageDown"
		disabled={!enabled || !canNext}
		onclick={onNext}
	>
		<ChevronRightIcon size={18} aria-hidden="true" />
	</button>
	<button
		class="icon-button bookmark-toggle"
		type="button"
		aria-label={bookmarked ? "このページのブックマークを解除" : "このページをブックマーク"}
		aria-pressed={bookmarked}
		title={bookmarked ? "このページのブックマークを解除" : "このページをブックマーク"}
		disabled={!bookmarkEnabled}
		onclick={onToggleBookmark}
	>
		{#if bookmarked}
			<BookmarkCheckIcon size={18} aria-hidden="true" />
		{:else}
			<BookmarkIcon size={18} aria-hidden="true" />
		{/if}
	</button>
	<CompactNavigation
		{chapters}
		{currentChapterPage}
		{bookmarkPages}
		{bookmarked}
		{bookmarkEnabled}
		{enabled}
		{onChapterChange}
		{onToggleBookmark}
		{onSelectBookmark}
	/>
</div>

{#if chapters.length > 0}
	<label class="chapter-control">
		<span>章</span>
		<select
			aria-label="章へ移動"
			value={currentChapterPage ?? ""}
			disabled={!enabled}
			onchange={(event) => onChapterChange(event.currentTarget.value)}
		>
			<option value="">章を選択</option>
			{#each chapters as chapter (chapter.page)}
				<option value={chapter.page}>{chapter.title}</option>
			{/each}
		</select>
	</label>
{/if}
{#if bookmarkPages.length > 0}
	<label class="bookmark-list-control">
		<span>保存ページ</span>
		<select
			aria-label="ブックマーク一覧"
			value=""
			disabled={!bookmarkEnabled}
			onchange={(event) => {
				onSelectBookmark(event.currentTarget.value);
				event.currentTarget.value = "";
			}}
		>
			<option value="">移動</option>
			{#each bookmarkPages as savedPage (savedPage)}
				<option value={savedPage}>{savedPage}ページ</option>
			{/each}
		</select>
	</label>
{/if}

<style>
	.page-controls {
		display: flex;
		align-items: center;
		gap: 6px;

		button {
			box-sizing: border-box;
			min-height: 32px;
			padding: 5px 7px;
			border: 1px solid transparent;
			border-radius: 4px;
			background: transparent;
			color: inherit;
			font: inherit;
			cursor: pointer;

			&:hover:not(:disabled) {
				background: #343a41;
			}

			&:focus-visible {
				outline: 2px solid var(--pamphlet-viewer-accent, #a8c5bc);
				outline-offset: 1px;
			}

			&:disabled {
				color: #727981;
				cursor: not-allowed;
			}
		}

		.icon-button {
			display: inline-grid;
			place-items: center;
			width: 34px;
			padding: 5px;
		}

		.page-number {
			display: inline-flex;
			align-items: center;
			gap: 5px;
			white-space: nowrap;

			input {
				box-sizing: border-box;
				width: 46px;
				min-height: 32px;
				padding: 4px;
				border: 1px solid var(--pamphlet-viewer-border, #454b52);
				border-radius: 3px;
				background: #191c20;
				color: inherit;
				font: inherit;
				text-align: center;
			}
		}
	}

	.chapter-control,
	.bookmark-list-control {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		white-space: nowrap;

		select {
			box-sizing: border-box;
			min-height: 32px;
			padding: 4px 24px 4px 8px;
			border: 1px solid var(--pamphlet-viewer-border, #454b52);
			border-radius: 3px;
			background: #191c20;
			color: inherit;
			font: inherit;
		}
	}

	.chapter-control select {
		max-width: min(260px, 30vw);
		text-overflow: ellipsis;
	}

	.bookmark-list-control select {
		max-width: min(160px, 24vw);
	}

	@container reader-toolbar (max-width: 700px) {
		.page-controls {
			gap: 4px;

			button,
			.icon-button {
				min-height: 44px;
			}

			.icon-button {
				width: 44px;
			}

			.page-number input {
				width: 38px;
				min-height: 44px;
			}

			> .bookmark-toggle {
				display: none;
			}
		}

		.chapter-control,
		.bookmark-list-control {
			display: none;
		}
	}
</style>
