// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "vitest";

import {
	clampReaderZoom,
	detectPageSwipeDirection,
	ReaderGestureController,
} from "./reader-gesture";

describe("detectPageSwipeDirection", () => {
	it("maps quick horizontal swipes to page direction after distance and axis checks", () => {
		expect(detectPageSwipeDirection({ x: 180, y: 100 }, { x: 120, y: 105 }, 200)).toBe("next");
		expect(detectPageSwipeDirection({ x: 120, y: 100 }, { x: 180, y: 105 }, 200)).toBe("previous");
		expect(detectPageSwipeDirection({ x: 180, y: 100 }, { x: 133, y: 100 }, 200)).toBeNull();
		expect(detectPageSwipeDirection({ x: 180, y: 100 }, { x: 100, y: 160 }, 200)).toBeNull();
		expect(detectPageSwipeDirection({ x: 180, y: 100 }, { x: 120, y: 100 }, 701)).toBeNull();
		expect(detectPageSwipeDirection({ x: 180, y: 100 }, { x: 230, y: 100 }, 500)).toBeNull();
	});
});

describe("ReaderGestureController", () => {
	it("converts a single pointer drag into scrolling deltas", () => {
		const gestures = new ReaderGestureController();
		expect(gestures.pointerDown(1, { x: 100, y: 90 }, 2)).toBe(true);
		expect(gestures.pointerMove(1, { x: 72, y: 64 })).toEqual({
			type: "pan",
			deltaX: 28,
			deltaY: 26,
		});
		gestures.pointerEnd(1);
		expect(gestures.pointerMove(1, { x: 50, y: 50 })).toBeNull();
	});

	it("anchors pinch zoom at its center and clamps the reader range", () => {
		const gestures = new ReaderGestureController();
		gestures.pointerDown(1, { x: 100, y: 100 }, 1);
		gestures.pointerDown(2, { x: 200, y: 100 }, 1);
		expect(gestures.pointerMove(2, { x: 300, y: 100 })).toEqual({
			type: "zoom",
			zoom: 2,
			center: { x: 200, y: 100 },
		});
		expect(gestures.pointerMove(2, { x: 1200, y: 100 })).toMatchObject({
			type: "zoom",
			zoom: 8,
		});
		expect(clampReaderZoom(Number.POSITIVE_INFINITY)).toBe(1);
		expect(clampReaderZoom(0)).toBe(0.1);
	});

	it("releases pinch state on pointer cancellation", () => {
		const gestures = new ReaderGestureController();
		gestures.pointerDown(1, { x: 100, y: 100 }, 1);
		gestures.pointerDown(2, { x: 200, y: 100 }, 1);
		gestures.pointerEnd(2);
		expect(gestures.pointerMove(1, { x: 90, y: 90 })).toEqual({
			type: "pan",
			deltaX: 10,
			deltaY: 10,
		});
		gestures.clear();
		expect(gestures.pointerMove(1, { x: 80, y: 80 })).toBeNull();
	});
});
