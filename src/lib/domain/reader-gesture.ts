// SPDX-License-Identifier: MPL-2.0

export const MIN_READER_ZOOM = 0.1;
export const MAX_READER_ZOOM = 8;

export interface GesturePoint {
	x: number;
	y: number;
}

export type PageSwipeDirection = "previous" | "next";

export interface ZoomAnchor {
	pageIndex: number;
	pageRatioX: number;
	pageRatioY: number;
	clientX: number;
	clientY: number;
}

export type ReaderGestureUpdate =
	| { type: "pan"; deltaX: number; deltaY: number }
	| { type: "zoom"; zoom: number; center: GesturePoint };

interface PinchStart {
	distance: number;
	zoom: number;
}

export class ReaderGestureController {
	#pointers = new Map<number, GesturePoint>();
	#previousPoint: GesturePoint | null = null;
	#pinchStart: PinchStart | null = null;

	get activePointerCount(): number {
		return this.#pointers.size;
	}

	pointerDown(pointerId: number, point: GesturePoint, zoom: number): boolean {
		if (this.#pointers.has(pointerId) || this.#pointers.size >= 2) return false;
		this.#pointers.set(pointerId, point);
		if (this.#pointers.size === 1) {
			this.#previousPoint = point;
			return true;
		}

		const [first, second] = this.#pointers.values();
		if (first === undefined || second === undefined) return true;
		this.#previousPoint = null;
		this.#pinchStart = { distance: distanceBetween(first, second), zoom: clampReaderZoom(zoom) };
		return true;
	}

	pointerMove(pointerId: number, point: GesturePoint): ReaderGestureUpdate | null {
		if (!this.#pointers.has(pointerId)) return null;
		this.#pointers.set(pointerId, point);
		if (this.#pointers.size === 2 && this.#pinchStart !== null) {
			const [first, second] = this.#pointers.values();
			if (first === undefined || second === undefined) return null;
			const center = midpoint(first, second);
			const nextDistance = distanceBetween(first, second);
			const ratio = this.#pinchStart.distance === 0 ? 1 : nextDistance / this.#pinchStart.distance;
			return {
				type: "zoom",
				zoom: clampReaderZoom(this.#pinchStart.zoom * ratio),
				center,
			};
		}

		const previous = this.#previousPoint;
		this.#previousPoint = point;
		if (previous === null) return null;
		return {
			type: "pan",
			deltaX: previous.x - point.x,
			deltaY: previous.y - point.y,
		};
	}

	pointerEnd(pointerId: number): void {
		this.#pointers.delete(pointerId);
		this.#pinchStart = null;
		if (this.#pointers.size === 1) {
			const [remaining] = this.#pointers.values();
			this.#previousPoint = remaining ?? null;
			return;
		}
		this.#previousPoint = null;
	}

	clear(): void {
		this.#pointers.clear();
		this.#previousPoint = null;
		this.#pinchStart = null;
	}
}

export function clampReaderZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return 1;
	return Math.max(MIN_READER_ZOOM, Math.min(MAX_READER_ZOOM, zoom));
}

export function detectPageSwipeDirection(
	start: GesturePoint,
	end: GesturePoint,
	durationMs: number,
): PageSwipeDirection | null {
	const deltaX = end.x - start.x;
	const deltaY = end.y - start.y;
	if (
		!Number.isFinite(durationMs) ||
		durationMs < 0 ||
		durationMs > 700 ||
		Math.abs(deltaX) < 48 ||
		Math.abs(deltaX) < Math.abs(deltaY) * 1.5 ||
		Math.abs(deltaX) / Math.max(durationMs, 1) < 0.2
	) {
		return null;
	}
	return deltaX < 0 ? "next" : "previous";
}

function distanceBetween(first: GesturePoint, second: GesturePoint): number {
	return Math.hypot(second.x - first.x, second.y - first.y);
}

function midpoint(first: GesturePoint, second: GesturePoint): GesturePoint {
	return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}
