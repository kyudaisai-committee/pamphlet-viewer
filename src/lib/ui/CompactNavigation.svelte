<script lang="ts">
	import { BookmarkCheckIcon, BookmarkIcon } from "@lucide/svelte";

	import type { PamphletChapter } from "@/lib/public-api";

	interface Props {
		chapters: readonly PamphletChapter[];
		currentChapterPage?: number;
		bookmarkPages: readonly number[];
		bookmarked: boolean;
		bookmarkEnabled: boolean;
		enabled: boolean;
		onChapterChange(value: string): void;
		onToggleBookmark(): void;
		onSelectBookmark(value: string): void;
	}

	let {
		chapters,
		currentChapterPage,
		bookmarkPages,
		bookmarked,
		bookmarkEnabled,
		enabled,
		onChapterChange,
		onToggleBookmark,
		onSelectBookmark,
	}: Props = $props();
</script>

<details class="compact-navigation">
	<summary aria-label="章とブックマークを開く" title="章とブックマーク">
		<BookmarkIcon size={18} aria-hidden="true" />
	</summary>
	<div class="compact-navigation-panel">
		{#if chapters.length > 0}
			<label class="chapter-control">
				<span>章</span>
				<select
					aria-label="章へ移動"
					value={currentChapterPage ?? ""}
					disabled={!enabled}
					onchange={(event) => {
						onChapterChange(event.currentTarget.value);
						event.currentTarget.closest("details")?.removeAttribute("open");
					}}
				>
					<option value="">章を選択</option>
					{#each chapters as chapter (chapter.page)}
						<option value={chapter.page}>{chapter.title}</option>
					{/each}
				</select>
			</label>
		{/if}
		<button
			class="bookmark-toggle"
			type="button"
			aria-label={bookmarked ? "このページのブックマークを解除" : "このページをブックマーク"}
			aria-pressed={bookmarked}
			disabled={!bookmarkEnabled}
			onclick={(event) => {
				onToggleBookmark();
				event.currentTarget.closest("details")?.removeAttribute("open");
			}}
		>
			{#if bookmarked}
				<BookmarkCheckIcon size={18} aria-hidden="true" />
				ブックマークを解除
			{:else}
				<BookmarkIcon size={18} aria-hidden="true" />
				このページをブックマーク
			{/if}
		</button>
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
						event.currentTarget.closest("details")?.removeAttribute("open");
					}}
				>
					<option value="">移動</option>
					{#each bookmarkPages as savedPage (savedPage)}
						<option value={savedPage}>{savedPage}ページ</option>
					{/each}
				</select>
			</label>
		{/if}
	</div>
</details>

<style>
	.compact-navigation {
		display: none;

		> summary {
			box-sizing: border-box;
			display: grid;
			place-items: center;
			width: 44px;
			height: 44px;
			border: 1px solid transparent;
			border-radius: 4px;
			cursor: pointer;
			list-style: none;

			&::-webkit-details-marker {
				display: none;
			}

			&:focus-visible {
				outline: 2px solid var(--pamphlet-viewer-accent, #a8c5bc);
				outline-offset: 1px;
			}
		}
	}

	.compact-navigation-panel {
		position: absolute;
		z-index: 5;
		inset-block-start: calc(100% + 6px);
		inset-inline-end: 0;
		display: grid;
		gap: 8px;
		box-sizing: border-box;
		width: min(280px, calc(100cqi - 12px));
		padding: 10px;
		border: 1px solid var(--pamphlet-viewer-border, #3b4148);
		border-radius: 4px;
		background: var(--pamphlet-viewer-panel, #24282e);
		box-shadow: 0 6px 18px #0008;

		.chapter-control,
		.bookmark-list-control {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			max-width: none;

			select {
				flex: 1 1 auto;
				width: 1px;
				max-width: none;
				min-height: 44px;
			}
		}

		.bookmark-toggle {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 8px;
			width: 100%;
			min-height: 44px;
			border: 1px solid var(--pamphlet-viewer-border, #454b52);
			border-radius: 4px;
			background: transparent;
			color: inherit;
			font: inherit;
			cursor: pointer;

			&:disabled {
				color: #727981;
				cursor: not-allowed;
			}
		}
	}

	@container reader-toolbar (max-width: 700px) {
		.compact-navigation {
			position: static;
			display: block;

			.compact-navigation-panel {
				inset-block-start: auto;
				inset-block-end: calc(100% + 6px);
			}
		}
	}
</style>
