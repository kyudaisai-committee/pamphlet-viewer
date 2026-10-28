<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { PamphletChapter } from "@/lib/public-api";
	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";

	interface Props {
		chapters: readonly PamphletChapter[];
		currentChapterPage?: number;
		onSelectChapter(page: number): void;
	}

	let { chapters, currentChapterPage, onSelectChapter }: Props = $props();
	const messages = useViewerMessages();
</script>

<ul class="chapter-list" aria-label={messages.tableOfContents}>
	{#each chapters as chapter (chapter.page)}
		{@const current = chapter.page === currentChapterPage}
		<li>
			<button
				class="chapter-entry"
				class:current
				data-chapter-page={chapter.page}
				aria-current={current ? "page" : undefined}
				type="button"
				onclick={() => onSelectChapter(chapter.page)}
			>
				<span class="chapter-copy">
					<span class="chapter-title">{chapter.title}</span>
					{#if current}
						<span class="current-label">{messages.currentChapter}</span>
					{/if}
				</span>
				<span class="chapter-page">{messages.pageLabel(chapter.page)}</span>
			</button>
		</li>
	{/each}
</ul>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
		.chapter-list {
			box-sizing: border-box;
			display: flex;
			flex-direction: column;
			gap: 4px;
			width: 100%;
			height: 100%;
			min-width: 0;
			min-height: 0;
			margin: 0;
			padding: 8px;
			list-style: none;
			overflow: auto;
			scrollbar-color: #59616a transparent;

			li {
				min-width: 0;
			}

			.chapter-entry {
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
			}

			.chapter-copy {
				display: grid;
				gap: 1px;
				min-width: 0;
			}

			.chapter-title {
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}

			.current-label {
				color: var(--pamphlet-viewer-accent, #a8c5bc);
				font-size: 11px;
			}

			.chapter-page {
				flex: 0 0 auto;
				color: #aeb4ba;
				font-size: 12px;
				font-variant-numeric: tabular-nums;
			}
		}
	}
</style>
