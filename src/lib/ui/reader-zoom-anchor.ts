// SPDX-License-Identifier: MIT

import type { GesturePoint, ZoomAnchor } from "../domain/reader-gesture";

export function captureZoomAnchor(pageArea: HTMLElement, point: GesturePoint): ZoomAnchor | null {
	const bounds = pageArea.getBoundingClientRect();
	const clientX = Math.max(bounds.left, Math.min(point.x, bounds.right));
	const clientY = Math.max(bounds.top, Math.min(point.y, bounds.bottom));
	const frame = findPageFrame(pageArea, clientX, clientY);
	if (frame === null) return null;
	const frameBounds = frame.getBoundingClientRect();
	const pageIndex = Number(frame.dataset.pageIndex);
	if (!Number.isSafeInteger(pageIndex) || frameBounds.width <= 0 || frameBounds.height <= 0)
		return null;
	return {
		pageIndex,
		pageRatioX: Math.max(0, Math.min(1, (clientX - frameBounds.left) / frameBounds.width)),
		pageRatioY: Math.max(0, Math.min(1, (clientY - frameBounds.top) / frameBounds.height)),
		clientX,
		clientY,
	};
}

export function restoreZoomAnchor(pageArea: HTMLElement, anchor: ZoomAnchor): boolean {
	const frame = pageArea.querySelector<HTMLElement>(
		`.page-frame[data-page-index="${anchor.pageIndex}"]`,
	);
	if (frame === null) return false;
	const bounds = frame.getBoundingClientRect();
	pageArea.scrollLeft += bounds.left + bounds.width * anchor.pageRatioX - anchor.clientX;
	pageArea.scrollTop += bounds.top + bounds.height * anchor.pageRatioY - anchor.clientY;
	return true;
}

function findPageFrame(
	pageArea: HTMLElement,
	clientX: number,
	clientY: number,
): HTMLElement | null {
	const frames = pageArea.querySelectorAll<HTMLElement>(".page-frame[data-page-index]");
	for (const frame of frames) {
		const bounds = frame.getBoundingClientRect();
		if (
			clientX >= bounds.left &&
			clientX <= bounds.right &&
			clientY >= bounds.top &&
			clientY <= bounds.bottom
		) {
			return frame;
		}
	}
	const firstFrame = frames.item(0);
	if (firstFrame === null) return null;
	const bounds = firstFrame.getBoundingClientRect();
	return bounds.width > 0 && bounds.height > 0 ? firstFrame : null;
}
