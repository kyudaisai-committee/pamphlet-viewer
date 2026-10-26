<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import type { PageVisual } from "@/lib/document/page-source";

	interface Props {
		visual: PageVisual;
		label: string;
		decorative?: boolean;
	}

	let { visual, label, decorative = false }: Props = $props();
	let canvasElement = $state<HTMLCanvasElement>();

	$effect(() => {
		const currentVisual = visual;
		const canvas = canvasElement;
		const context = canvas?.getContext("2d", { alpha: false });
		if (canvas === undefined || context === null || context === undefined) return;

		canvas.width = currentVisual.width;
		canvas.height = currentVisual.height;
		if (currentVisual.type === "pixels") {
			const imageData = new ImageData(
				new Uint8ClampedArray(currentVisual.pixels),
				currentVisual.width,
				currentVisual.height,
			);
			context.putImageData(imageData, 0, 0);
			return;
		}

		context.drawImage(currentVisual.bitmap, 0, 0);
	});
</script>

<div
	class="page-visual"
	role={decorative ? undefined : "img"}
	aria-label={decorative ? undefined : label}
	aria-hidden={decorative ? "true" : undefined}
>
	<canvas class="page-canvas" aria-hidden="true" bind:this={canvasElement}></canvas>
</div>

<style>
	.page-visual {
		display: block;
		width: 100%;
		height: 100%;
		background: #fff;
		line-height: 0;

		canvas {
			display: block;
			width: 100%;
			height: 100%;
			background: #fff;
			object-fit: contain;
		}
	}
</style>
