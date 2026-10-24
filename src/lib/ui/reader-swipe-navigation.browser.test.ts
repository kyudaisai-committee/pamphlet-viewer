import { afterEach, expect, test } from "vitest";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";

afterEach(() => {
	document.body.replaceChildren();
});

test("touch horizontal swipes turn pages while vertical page scrolling is available", async () => {
	await import("../entry");
	const element = createViewer(3);
	element.fit = "width";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const pageArea = getPageArea(element);
	expect(pageArea.scrollHeight).toBeGreaterThan(pageArea.clientHeight);
	expect(pageArea.scrollWidth).toBeLessThanOrEqual(pageArea.clientWidth + 1);

	dispatchSwipe(pageArea, 1, { x: 260, y: 180 }, { x: 180, y: 190 }, "touch");
	await expect.poll(() => element.page).toBe(2);

	dispatchSwipe(pageArea, 2, { x: 180, y: 190 }, { x: 255, y: 185 }, "touch");
	await expect.poll(() => element.page).toBe(1);
});

test("vertical, short, mouse, pinch, canceled, lost-capture, interactive, and zoomed gestures do not turn pages", async () => {
	await import("../entry");
	const element = createViewer(3);
	element.fit = "width";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const pageArea = getPageArea(element);
	dispatchSwipe(pageArea, 1, { x: 250, y: 160 }, { x: 200, y: 240 }, "touch");
	dispatchSwipe(pageArea, 2, { x: 250, y: 160 }, { x: 225, y: 160 }, "touch");
	dispatchSwipe(pageArea, 3, { x: 250, y: 160 }, { x: 170, y: 160 }, "mouse");

	pageArea.dispatchEvent(createPointerEvent("pointerdown", 4, 250, 160, "touch"));
	pageArea.dispatchEvent(createPointerEvent("pointerdown", 5, 290, 160, "touch"));
	pageArea.dispatchEvent(createPointerEvent("pointerup", 5, 290, 160, "touch"));
	pageArea.dispatchEvent(createPointerEvent("pointermove", 4, 170, 160, "touch"));
	pageArea.dispatchEvent(createPointerEvent("pointerup", 4, 170, 160, "touch"));

	dispatchSwipe(pageArea, 6, { x: 250, y: 160 }, { x: 170, y: 160 }, "touch", "pointercancel");
	dispatchSwipe(pageArea, 7, { x: 250, y: 160 }, { x: 170, y: 160 }, "touch", "lostpointercapture");

	const button = document.createElement("button");
	pageArea.append(button);
	dispatchSwipe(button, 8, { x: 250, y: 160 }, { x: 170, y: 160 }, "touch");
	button.remove();
	await expect.poll(() => element.page).toBe(1);

	const zoomIn = element.shadowRoot?.querySelector<HTMLButtonElement>(
		'.zoom-controls button[aria-label="拡大"]',
	);
	zoomIn?.click();
	await expect.poll(() => readZoom(element)).toBe("120%");
	dispatchSwipe(pageArea, 9, { x: 250, y: 160 }, { x: 170, y: 160 }, "touch");
	await expect.poll(() => element.page).toBe(1);
});

function createViewer(pageCount: number): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = "390px";
	element.style.height = "500px";
	element.layout = "single";
	element.backend = createBackend(pageCount);
	element.src = "./swipe-test.pdf";
	return element;
}

function createBackend(pageCount: number): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount,
				async getPageSize() {
					return { width: 300, height: 800 };
				},
				async renderPage() {
					return {
						type: "pixels",
						width: 1,
						height: 1,
						pixels: new Uint8Array([70, 80, 90, 255]).buffer,
					} satisfies PageVisual;
				},
				dispose() {},
			};
		},
	};
}

function getPageArea(element: PamphletViewerElement): HTMLElement {
	const pageArea = element.shadowRoot?.querySelector<HTMLElement>(".page-area");
	if (pageArea === undefined || pageArea === null)
		throw new Error("The page area was not rendered.");
	return pageArea;
}

function dispatchSwipe(
	target: HTMLElement,
	pointerId: number,
	start: { x: number; y: number },
	end: { x: number; y: number },
	pointerType: string,
	endType = "pointerup",
): void {
	target.dispatchEvent(createPointerEvent("pointerdown", pointerId, start.x, start.y, pointerType));
	target.dispatchEvent(createPointerEvent("pointermove", pointerId, end.x, end.y, pointerType));
	target.dispatchEvent(createPointerEvent(endType, pointerId, end.x, end.y, pointerType));
}

function createPointerEvent(
	type: string,
	pointerId: number,
	clientX: number,
	clientY: number,
	pointerType: string,
): PointerEvent {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId,
		pointerType,
		clientX,
		clientY,
	});
}

function readZoom(element: PamphletViewerElement): string | null {
	return element.shadowRoot?.querySelector(".zoom-level")?.textContent ?? null;
}

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}
