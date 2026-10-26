<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import { XIcon } from "@lucide/svelte";
	import { onMount, untrack } from "svelte";

	import type { PageVisual } from "@/lib/document/page-source";
	import { useViewerMessages } from "../i18n/viewer-messages-context.svelte";
	import PageCanvas from "./PageCanvas.svelte";

	const THUMBNAIL_ROW_HEIGHT = 160;
	const VIRTUAL_OVERSCAN = 1;

	interface Props {
		pageCount: number;
		currentPages: readonly number[];
		visuals: Readonly<Record<number, PageVisual>>;
		onVisiblePagesChange(pageIndexes: readonly number[]): void;
		onSelectPage(page: number): void;
		onClose(): void;
	}

	let {
		pageCount,
		currentPages,
		visuals,
		onVisiblePagesChange,
		onSelectPage,
		onClose,
	}: Props = $props();
	const messages = useViewerMessages();
	let scrollContainer = $state<HTMLElement>();
	let visibleStart = $state(0);
	let visibleEnd = $state(0);
	let renderedPageIndexes = $derived(
		Array.from({ length: visibleEnd - visibleStart }, (_, offset) => visibleStart + offset),
	);

	$effect(() => {
		const count = pageCount;
		const activePage = currentPages[0] ?? 0;
		if (count === 0) return;
		untrack(() => {
			if (scrollContainer !== undefined) {
				const activeTop = activePage * THUMBNAIL_ROW_HEIGHT;
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
			visibleStart = 0;
			visibleEnd = 0;
			onVisiblePagesChange([]);
			return;
		}

		const firstVisible = Math.floor(container.scrollTop / THUMBNAIL_ROW_HEIGHT);
		const lastVisible = Math.ceil(
			(container.scrollTop + container.clientHeight) / THUMBNAIL_ROW_HEIGHT,
		);
		const nextStart = Math.max(0, firstVisible - VIRTUAL_OVERSCAN);
		const nextEnd = Math.min(pageCount, lastVisible + VIRTUAL_OVERSCAN);
		visibleStart = nextStart;
		visibleEnd = Math.max(nextStart, nextEnd);
		onVisiblePagesChange(
			Array.from({ length: visibleEnd - visibleStart }, (_, offset) => visibleStart + offset),
		);
	}
</script>

<aside class="thumbnail-panel" aria-label={messages.pageList}>
	<header class="panel-heading">
		<h2>{messages.pageList}</h2>
		<button type="button" aria-label={messages.hidePages} onclick={onClose}>
			<XIcon size={18} aria-hidden="true" />
		</button>
	</header>
	<div
		class="thumbnail-scroll"
		role="list"
		aria-label={messages.pageThumbnails}
		bind:this={scrollContainer}
		onscroll={updateVisiblePages}
	>
		<div class="thumbnail-list">
			<div class="virtual-spacer" aria-hidden="true" style:height={`${visibleStart * THUMBNAIL_ROW_HEIGHT}px`}></div>
			{#each renderedPageIndexes as pageIndex (pageIndex)}
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
			<div
				class="virtual-spacer"
				aria-hidden="true"
				style:height={`${Math.max(0, pageCount - visibleEnd) * THUMBNAIL_ROW_HEIGHT}px`}
			></div>
		</div>
	</div>
</aside>

<style>
	.thumbnail-panel {
		box-sizing: border-box;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		border-inline-end: var(--pamphlet-viewer-border-width) solid
			var(--pamphlet-viewer-border, #3b4148);
		background: var(--pamphlet-viewer-panel, #24282e);

		.panel-heading {
			box-sizing: border-box;
			display: flex;
			align-items: center;
			justify-content: space-between;
			min-height: var(--pamphlet-viewer-touch-target-size);
			padding: 4px 10px 4px 14px;
			border-bottom: var(--pamphlet-viewer-border-width) solid
				var(--pamphlet-viewer-border, #3b4148);

			h2 {
				margin: 0;
				font-size: 13px;
				font-weight: 600;
			}

			button {
				display: grid;
				place-items: center;
				width: var(--pamphlet-viewer-control-height);
				height: var(--pamphlet-viewer-control-height);
				border: var(--pamphlet-viewer-border-width) solid transparent;
				border-radius: var(--pamphlet-viewer-control-radius);
				background: transparent;
				color: inherit;
				cursor: pointer;

				&:hover {
					background: var(--pamphlet-viewer-control-hover);
				}

				&:focus-visible {
					outline: var(--pamphlet-viewer-focus-ring);
					outline-offset: var(--pamphlet-viewer-focus-ring-offset);
				}
			}
		}

		.thumbnail-scroll {
			min-height: 0;
			overflow: auto;
			overscroll-behavior: contain;
			scrollbar-color: #59616a transparent;

			.thumbnail-list {
				display: flex;
				flex-direction: column;
				min-height: 100%;

				.thumbnail-entry-wrapper {
					box-sizing: border-box;
					display: grid;
					place-items: center;
					flex: 0 0 160px;
					height: 160px;
					min-height: 0;
					padding-inline: 8px;

					.thumbnail-entry {
						box-sizing: border-box;
						display: grid;
						grid-template-rows: minmax(0, 1fr) auto;
						gap: 5px;
						width: 100%;
						height: 152px;
						min-height: 0;
						flex: 0 0 152px;
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

						&:hover:not(.current) {
							background: var(--pamphlet-viewer-thumbnail-hover);
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
</style>
