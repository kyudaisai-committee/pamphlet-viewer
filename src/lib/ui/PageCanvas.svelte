<script lang="ts">
	import type { PageVisual } from "../document/page-source";

	interface Props {
		visual: PageVisual;
		label: string;
	}

	let { visual, label }: Props = $props();
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

<div class="page-visual" role="img" aria-label={label}>
	<canvas class="page-canvas" aria-hidden="true" bind:this={canvasElement}></canvas>
</div>

<style>
	.page-visual {
		display: block;
		background: #fff;
		line-height: 0;

		canvas {
			display: block;
			background: #fff;
		}
	}
</style>
