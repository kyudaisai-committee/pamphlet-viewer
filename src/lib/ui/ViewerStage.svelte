<script lang="ts">
	import { onMount } from "svelte";

	import type { PageVisual } from "../document/page-source";
	import type { PageRenderPlan } from "../domain/render-plan";
	import type { ViewerFailure, ViewerPhase } from "../domain/viewer-controller.svelte";
	import type { ViewportSize } from "../domain/layout";
	import { ReaderGestureController } from "../domain/reader-gesture";
	import type { GesturePoint } from "../domain/reader-gesture";
	import PageCanvas from "./PageCanvas.svelte";
	import ViewerStatusMessage from "./ViewerStatusMessage.svelte";

	interface DisplayedPage {
		pageIndex: number;
		visual: PageVisual;
		plan: PageRenderPlan;
	}

	interface Props {
		pages: readonly DisplayedPage[];
		phase: ViewerPhase;
		failure: ViewerFailure | null;
		zoom: number;
		pageArea?: HTMLElement;
		onViewportChange(viewport: ViewportSize): void;
		onZoomGesture(zoom: number, center: GesturePoint): void;
		onPrevious(): void;
		onNext(): void;
		onRetry(): void;
	}

	let {
		pages,
		phase,
		failure,
		zoom,
		pageArea = $bindable(),
		onViewportChange,
		onZoomGesture,
		onPrevious,
		onNext,
		onRetry,
	}: Props = $props();
	const gestures = new ReaderGestureController();
	let pointerActive = $state(false);

	onMount(() => {
		if (pageArea === undefined) return;
		const resizeObserver = new ResizeObserver(updateViewport);
		resizeObserver.observe(pageArea);
		pageArea.addEventListener("pointerdown", onPointerDown);
		pageArea.addEventListener("pointermove", onPointerMove);
		pageArea.addEventListener("pointerup", onPointerEnd);
		pageArea.addEventListener("pointercancel", onPointerEnd);
		pageArea.addEventListener("lostpointercapture", onPointerEnd);
		pageArea.addEventListener("wheel", onWheel, { passive: false });
		pageArea.addEventListener("keydown", onKeydown);
		updateViewport();
		return () => {
			resizeObserver.disconnect();
			pageArea?.removeEventListener("pointerdown", onPointerDown);
			pageArea?.removeEventListener("pointermove", onPointerMove);
			pageArea?.removeEventListener("pointerup", onPointerEnd);
			pageArea?.removeEventListener("pointercancel", onPointerEnd);
			pageArea?.removeEventListener("lostpointercapture", onPointerEnd);
			pageArea?.removeEventListener("wheel", onWheel);
			pageArea?.removeEventListener("keydown", onKeydown);
			gestures.clear();
		};
	});

	function updateViewport(): void {
		if (pageArea === undefined) return;
		const bounds = pageArea.getBoundingClientRect();
		onViewportChange({ width: Math.max(0, bounds.width - 48), height: Math.max(0, bounds.height - 48) });
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		const accepted = gestures.pointerDown(
			event.pointerId,
			{ x: event.clientX, y: event.clientY },
			zoom,
		);
		if (!accepted) return;
		pointerActive = gestures.activePointerCount > 0;
		event.preventDefault();
		pageArea?.focus({ preventScroll: true });
		if (event.isTrusted) pageArea?.setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent): void {
		const update = gestures.pointerMove(event.pointerId, { x: event.clientX, y: event.clientY });
		if (update === null) return;
		if (update.type === "zoom") {
			event.preventDefault();
			onZoomGesture(update.zoom, update.center);
			return;
		}
		if (!pointerActive || pageArea === undefined || !hasOverflow(pageArea)) return;
		pageArea.scrollBy(update.deltaX, update.deltaY);
		event.preventDefault();
	}

	function onPointerEnd(event: PointerEvent): void {
		gestures.pointerEnd(event.pointerId);
		pointerActive = gestures.activePointerCount > 0;
		if (event.isTrusted && pageArea?.hasPointerCapture(event.pointerId)) {
			pageArea.releasePointerCapture(event.pointerId);
		}
	}

	function onWheel(event: WheelEvent): void {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		const nextZoom = zoom * Math.exp(-event.deltaY * 0.002);
		onZoomGesture(nextZoom, { x: event.clientX, y: event.clientY });
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.target !== pageArea) return;
		if (event.key === "ArrowLeft" || event.key === "PageUp") {
			event.preventDefault();
			onPrevious();
		} else if (event.key === "ArrowRight" || event.key === "PageDown") {
			event.preventDefault();
			onNext();
		}
	}

	function hasOverflow(element: HTMLElement): boolean {
		return (
			element.scrollWidth > element.clientWidth + 1 ||
			element.scrollHeight > element.clientHeight + 1
		);
	}

	function hasScrollableContent(): boolean {
		return pageArea !== undefined && hasOverflow(pageArea);
	}
</script>

<section
	class="page-area"
	class:zoomed={zoom > 1}
	class:dragging={pointerActive && hasScrollableContent()}
	aria-label="パンフレット表示領域"
	aria-keyshortcuts="ArrowLeft ArrowRight PageUp PageDown"
	tabindex="-1"
	bind:this={pageArea}
>
	{#if pages.length > 0 && phase !== "error"}
		<div class="viewer-pages" class:spread={pages.length === 2}>
			{#each pages as page (page.pageIndex)}
				<div
					class="page-frame"
					data-page-index={page.pageIndex}
					style:width={`${page.plan.displayWidth}px`}
					style:height={`${page.plan.displayHeight}px`}
				>
					<PageCanvas visual={page.visual} label={`${page.pageIndex + 1}ページ`} />
				</div>
			{/each}
		</div>
	{:else}
		<ViewerStatusMessage {phase} {failure} onRetry={onRetry} />
	{/if}
</section>

<style>
	.page-area {
		box-sizing: border-box;
		flex: 1 1 auto;
		position: relative;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		background: var(--pamphlet-viewer-stage, #191c20);
		touch-action: none;
		outline: none;
		cursor: default;

		&:focus-visible {
			outline: var(--pamphlet-viewer-focus-ring);
			outline-offset: -3px;
		}

		&.dragging {
			cursor: grabbing;
		}

		.viewer-pages {
			box-sizing: border-box;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			width: max-content;
			min-width: 100%;
			min-height: 100%;
			margin-inline: auto;
			padding: 24px;

			.page-frame {
				box-sizing: border-box;
				flex: 0 0 auto;
				border: 1px solid #c6c9cb;
				background: #fff;
			}
		}
	}

	@container reader-toolbar (max-width: 700px) {
		.page-area.zoomed .viewer-pages {
			padding-inline: 50cqi;
		}
	}
</style>
