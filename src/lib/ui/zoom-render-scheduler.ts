export const ZOOM_RENDER_DELAY_MS = 130;

export class ZoomRenderScheduler {
	#timeoutId: ReturnType<typeof setTimeout> | null = null;

	schedule(render: () => void): void {
		this.cancel();
		this.#timeoutId = setTimeout(() => {
			this.#timeoutId = null;
			render();
		}, ZOOM_RENDER_DELAY_MS);
	}

	cancel(): void {
		if (this.#timeoutId !== null) clearTimeout(this.#timeoutId);
		this.#timeoutId = null;
	}
}
