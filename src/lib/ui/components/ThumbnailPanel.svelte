<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import { onMount, untrack } from "svelte";

	import type { PageVisual } from "@/lib/document/page-source";
	import { useViewerMessages } from "@/lib/i18n/viewer-messages-context.svelte";
	import PageCanvas from "./PageCanvas.svelte";
	import {
		calculateThumbnailColumnCount,
		calculateThumbnailRowCount,
		calculateVisibleThumbnailRows,
		getThumbnailPageIndexesForRow,
		THUMBNAIL_ROW_HEIGHT,
	} from "./thumbnail-grid";

	interface Props {
		pageCount: number;
		currentPages: readonly number[];
		visuals: Readonly<Record<number, PageVisual>>;
		onVisiblePagesChange(pageIndexes: readonly number[]): void;
		onSelectPage(page: number): void;
	}

	let {
		pageCount,
		currentPages,
		visuals,
		onVisiblePagesChange,
		onSelectPage,
	}: Props = $props();
	const messages = useViewerMessages();
	let scrollContainer = $state<HTMLElement>();
	let columnCount = $state(1);
	let visibleStartRow = $state(0);
	let visibleEndRow = $state(0);
	let totalRows = $derived(calculateThumbnailRowCount(pageCount, columnCount));
	let renderedRows = $derived(
		Array.from({ length: visibleEndRow - visibleStartRow }, (_, offset) => {
			const rowIndex = visibleStartRow + offset;
			return {
				rowIndex,
				pageIndexes: getThumbnailPageIndexesForRow(rowIndex, pageCount, columnCount),
			};
		}),
	);

	$effect(() => {
		const count = pageCount;
		const activePage = currentPages[0] ?? 0;
		const columns = columnCount;
		untrack(() => {
			if (count === 0) {
				updateVisiblePages();
				return;
			}
			if (scrollContainer !== undefined) {
				const activeRow = Math.floor(Math.min(activePage, count - 1) / columns);
				const activeTop = activeRow * THUMBNAIL_ROW_HEIGHT;
				const activeBottom = activeTop + THUMBNAIL_ROW_HEIGHT;
				const visibleBottom = scrollContainer.scrollTop + scrollContainer.clientHeight;
				if (activeTop < scrollContainer.scrollTop || activeBottom > visibleBottom) {
					scrollContainer.scrollTop = activeTop;
				}
			}
			updateVisiblePages();
		});
	});

	onMount(() => {
		if (scrollContainer === undefined) return;
		const resizeObserver = new ResizeObserver(updateVisiblePages);
		resizeObserver.observe(scrollContainer);
		updateVisiblePages();
		return () => resizeObserver.disconnect();
	});

	function updateVisiblePages(): void {
		const container = scrollContainer;
		if (container === undefined || pageCount === 0) {
			visibleStartRow = 0;
			visibleEndRow = 0;
			onVisiblePagesChange([]);
			return;
		}

		const nextColumnCount = calculateThumbnailColumnCount(container.clientWidth);
		if (columnCount !== nextColumnCount) columnCount = nextColumnCount;
		const range = calculateVisibleThumbnailRows(
			pageCount,
			nextColumnCount,
			container.scrollTop,
			container.clientHeight,
		);
		visibleStartRow = range.startRow;
		visibleEndRow = range.endRow;
		const visiblePageIndexes = Array.from(
			{ length: range.endRow - range.startRow },
			(_, offset) => getThumbnailPageIndexesForRow(range.startRow + offset, pageCount, nextColumnCount),
		).flat();
		onVisiblePagesChange(visiblePageIndexes);
	}
</script>

<div class="thumbnail-panel">
	<div
		class="thumbnail-scroll"
		role="list"
		aria-label={messages.pageThumbnails}
		bind:this={scrollContainer}
		onscroll={updateVisiblePages}
	>
		<div class="thumbnail-list" style:--thumbnail-column-count={columnCount}>
			<div class="virtual-spacer" aria-hidden="true" style:height={`${visibleStartRow * THUMBNAIL_ROW_HEIGHT}px`}></div>
			{#each renderedRows as row (row.rowIndex)}
				<div class="thumbnail-row">
					{#each row.pageIndexes as pageIndex (pageIndex)}
						{@const visual = visuals[pageIndex]}
						<div class="thumbnail-entry-wrapper" role="listitem" data-page-index={pageIndex}>
							<button
								class="thumbnail-entry"
								class:current={currentPages.includes(pageIndex)}
								class:current-cover={pageIndex === 0 && currentPages.includes(pageIndex)}
								data-page-index={pageIndex}
								aria-current={currentPages.includes(pageIndex) ? "page" : undefined}
								aria-label={messages.showThumbnailPage(pageIndex + 1)}
								type="button"
								onclick={() => onSelectPage(pageIndex + 1)}
							>
								<span class="thumbnail-preview" aria-hidden="true">
									{#if visual !== undefined}
										<PageCanvas visual={visual} label={messages.pageLabel(pageIndex + 1)} decorative />
									{:else}
										<span class="thumbnail-placeholder"></span>
									{/if}
								</span>
								<span class="thumbnail-label">{pageIndex + 1}</span>
							</button>
						</div>
					{/each}
				</div>
			{/each}
			<div
				class="virtual-spacer"
				aria-hidden="true"
				style:height={`${Math.max(0, totalRows - visibleEndRow) * THUMBNAIL_ROW_HEIGHT}px`}
			></div>
		</div>
	</div>
</div>

<style>
	@layer pamphlet-viewer.base, pamphlet-viewer.components, pamphlet-viewer.layout;

	@layer pamphlet-viewer.components {
	.thumbnail-panel {
		box-sizing: border-box;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;

		.thumbnail-scroll {
			min-height: 0;
			overflow: auto;
			overscroll-behavior: contain;
			scrollbar-color: #59616a transparent;

			.thumbnail-list {
				display: flex;
				flex-direction: column;
				min-height: 100%;

				.thumbnail-row {
					box-sizing: border-box;
					display: grid;
					grid-template-columns: repeat(var(--thumbnail-column-count), minmax(0, 1fr));
					gap: 8px;
					flex: 0 0 160px;
					height: 160px;
					padding-inline: 8px;
				}

				.thumbnail-entry-wrapper {
					box-sizing: border-box;
					display: grid;
					place-items: center;
					min-width: 0;
					min-height: 0;

					.thumbnail-entry {
						box-sizing: border-box;
						display: grid;
						grid-template-rows: minmax(0, 1fr) auto;
						gap: 5px;
						width: 100%;
						height: 152px;
						min-height: 0;
						margin: 0;
						padding: 7px;
						border: var(--pamphlet-viewer-border-width) solid transparent;
						border-radius: var(--pamphlet-viewer-panel-radius);
						background: transparent;
						color: #c6cbd1;
						font: inherit;
						cursor: pointer;
						overflow: hidden;

						&.current {
							border-color: var(--pamphlet-viewer-accent, #a8c5bc);
							background: var(--pamphlet-viewer-thumbnail-current);
							color: #f3f5f4;
						}

						&.current-cover {
							border-inline-start-width: 3px;
						}

						@media (hover: hover) {
							&:hover:not(.current) {
								background: var(--pamphlet-viewer-thumbnail-hover);
							}
						}

						&:focus-visible {
							outline: var(--pamphlet-viewer-focus-ring);
							outline-offset: var(--pamphlet-viewer-focus-ring-offset);
						}

						.thumbnail-preview {
							box-sizing: border-box;
							display: grid;
							grid-template-columns: minmax(0, 1fr);
							grid-template-rows: minmax(0, 1fr);
							place-items: center;
							width: 100%;
							height: 100%;
							min-width: 0;
							min-height: 0;
							overflow: hidden;
							border: var(--pamphlet-viewer-border-width) solid #454b52;
							background: #171a1e;

							:global(.page-visual),
							:global(.page-canvas) {
								background: transparent;
							}

							.thumbnail-placeholder {
								width: 42%;
								height: 88%;
								background: #30353a;
							}
						}

						.thumbnail-label {
							font-size: 11px;
							font-variant-numeric: tabular-nums;
							text-align: center;
						}
			}
		}
	}
	}
	}
	}
</style>
