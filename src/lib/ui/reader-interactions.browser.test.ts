import { afterEach, beforeEach, expect, test } from "vitest";
import { page as browserPage } from "vitest/browser";

import type { DocumentBackend, PageSource, PageVisual } from "../document/page-source";
import type { PamphletViewerElement } from "../public-api";
import { ReaderFullscreenController } from "./reader-fullscreen.svelte";

afterEach(async () => {
	document.body.replaceChildren();
	await browserPage.viewport(1280, 900);
});

beforeEach(async () => {
	await browserPage.viewport(1280, 900);
});

test("keeps the thumbnail list virtual and selects a distant page", async () => {
	await import("../entry");
	const renderedPages: number[] = [];
	const element = createViewer({ width: 1120, height: 680 }, createBackend(120, renderedPages));
	element.layout = "single";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
	await expect
		.poll(() => shadowRoot.querySelectorAll(".thumbnail-entry").length)
		.toBeGreaterThan(0);
	await expect.poll(() => renderedPages.length).toBeGreaterThan(1);
	expect(shadowRoot.querySelectorAll(".thumbnail-entry").length).toBeLessThan(10);
	expect(renderedPages.length).toBeLessThan(12);

	const scrollContainer = shadowRoot.querySelector<HTMLElement>(".thumbnail-scroll");
	if (scrollContainer === null) throw new Error("The thumbnail list did not render.");
	scrollContainer.scrollTop = 40 * 160;
	scrollContainer.dispatchEvent(new Event("scroll"));
	await expect
		.poll(() => shadowRoot.querySelector('[data-page-index="40"] .thumbnail-entry'))
		.not.toBeNull();
	shadowRoot.querySelector<HTMLButtonElement>('[data-page-index="40"] .thumbnail-entry')?.click();
	await expect.poll(() => element.page).toBe(41);
	await expect
		.poll(() => shadowRoot.querySelector('.page-frame[data-page-index="40"]'))
		.not.toBeNull();
});

test("uses the host width for mobile thumbnail mode and closes after selection", async () => {
	await import("../entry");
	const element = createViewer({ width: 390, height: 620 }, createBackend(24));
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	expect(window.innerWidth).toBeGreaterThan(620);
	expect(shadowRoot.querySelectorAll(".page-frame")).toHaveLength(1);

	shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
	const stageSlot = shadowRoot.querySelector<HTMLElement>(".stage-slot");
	const readerBody = shadowRoot.querySelector<HTMLElement>(".reader-body");
	const toolbar = shadowRoot.querySelector<HTMLElement>(".toolbar");
	const compactSettings = shadowRoot.querySelector<HTMLElement>(".compact-settings");
	if (stageSlot === null || readerBody === null || toolbar === null || compactSettings === null) {
		throw new Error("The mobile reader controls are missing.");
	}
	await expect.poll(() => getComputedStyle(stageSlot).display).toBe("none");
	expect(getComputedStyle(readerBody).gridTemplateColumns.trim().split(" ")).toHaveLength(1);
	expect(getComputedStyle(compactSettings).display).toBe("block");
	expect(toolbar.getBoundingClientRect().height).toBeLessThanOrEqual(120);
	shadowRoot.querySelector<HTMLButtonElement>('[data-page-index="2"] .thumbnail-entry')?.click();
	await expect.poll(() => element.page).toBe(3);
	await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).toBeNull();
});

test("falls back to a top-layer fullscreen reader and restores the embed size on Escape", async () => {
	await import("../entry");
	const element = createViewer({ width: 390, height: 600 }, createBackend(2));
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	Object.defineProperty(element, "requestFullscreen", {
		configurable: true,
		value: async function rejectFullscreenRequest(): Promise<void> {
			throw new DOMException("Fullscreen is unavailable.", "NotAllowedError");
		},
	});

	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const shell = shadowRoot.querySelector<HTMLElement>(".viewer-shell");
	const fullscreenButton = shadowRoot.querySelector<HTMLButtonElement>(".fullscreen-toggle");
	if (shell === null || fullscreenButton === null)
		throw new Error("Fullscreen controls are missing.");
	fullscreenButton.click();
	await expect.poll(() => shell.matches(":popover-open")).toBe(true);
	expect(shell.getBoundingClientRect().width).toBeGreaterThan(620);
	expect(element.hasAttribute("data-fullscreen-fallback")).toBe(true);

	const escapeEvent = new KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	document.dispatchEvent(escapeEvent);
	expect(escapeEvent.defaultPrevented).toBe(true);
	await expect.poll(() => shell.matches(":popover-open")).toBe(false);
	await expect.poll(() => element.hasAttribute("data-fullscreen-fallback")).toBe(false);
	await expect.poll(() => fullscreenButton.getAttribute("aria-pressed")).toBe("false");
});

test("does not apply an old fullscreen request to a reattached reader", async () => {
	const fullscreenElementDescriptor = Object.getOwnPropertyDescriptor(
		document,
		"fullscreenElement",
	);
	const exitFullscreenDescriptor = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
	const requestState: { resolve: (() => void) | null } = { resolve: null };
	let exitCount = 0;
	const oldHost = document.createElement("div");
	const oldShell = document.createElement("div");
	const oldButton = document.createElement("button");
	const newHost = document.createElement("div");
	const newShell = document.createElement("div");
	const newButton = document.createElement("button");
	const fullscreenController = new ReaderFullscreenController();
	let detachController: (() => void) | null = null;
	Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
	Object.defineProperty(document, "exitFullscreen", {
		configurable: true,
		value: async function exitMockFullscreen(): Promise<void> {
			exitCount += 1;
			Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
		},
	});
	Object.defineProperty(oldHost, "requestFullscreen", {
		configurable: true,
		value: function requestPendingFullscreen(): Promise<void> {
			return new Promise((resolve) => {
				requestState.resolve = resolve;
			});
		},
	});
	oldHost.append(oldShell);
	oldShell.append(oldButton);
	newHost.append(newShell);
	newShell.append(newButton);
	document.body.append(oldHost, newHost);

	try {
		detachController = fullscreenController.attach(oldHost, oldShell, oldButton);
		const pendingToggle = fullscreenController.toggle();
		await expect.poll(() => requestState.resolve).not.toBeNull();
		detachController();
		detachController = fullscreenController.attach(newHost, newShell, newButton);
		Object.defineProperty(document, "fullscreenElement", {
			configurable: true,
			value: oldHost,
		});
		const completeRequest = requestState.resolve;
		if (completeRequest === null) throw new Error("The pending fullscreen request did not start.");
		completeRequest();
		await pendingToggle;

		expect(exitCount).toBe(1);
		expect(fullscreenController.active).toBe(false);
		expect(newHost.hasAttribute("data-fullscreen-fallback")).toBe(false);
		expect(newShell.matches(":popover-open")).toBe(false);
	} finally {
		detachController?.();
		restoreProperty(document, "fullscreenElement", fullscreenElementDescriptor);
		restoreProperty(document, "exitFullscreen", exitFullscreenDescriptor);
	}
});

test("supports high zoom and pans the page without a pixel-limit error", async () => {
	await import("../entry");
	const element = createViewer({ width: 520, height: 520 }, createBackend(1));
	element.layout = "single";
	const firstPage = waitForPageChange(element);
	document.body.append(element);
	await firstPage;
	const shadowRoot = element.shadowRoot;
	if (shadowRoot === null) throw new Error("The pamphlet viewer did not attach its shadow root.");
	const pageArea = shadowRoot.querySelector<HTMLElement>(".page-area");
	const zoomSlider = shadowRoot.querySelector<HTMLInputElement>(".zoom-slider");
	if (pageArea === null || zoomSlider === null) throw new Error("The page controls are missing.");
	const errorEvents: string[] = [];
	element.addEventListener("error", (event) => errorEvents.push(event.detail.code));
	zoomSlider.value = "8";
	zoomSlider.dispatchEvent(new Event("input", { bubbles: true }));
	await expect.poll(() => zoomSlider.value).toBe("8");
	await expect.poll(() => pageArea.scrollWidth).toBeGreaterThan(pageArea.clientWidth);
	expect(errorEvents).toEqual([]);

	const startScroll = pageArea.scrollLeft;
	pageArea.dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			pointerId: 7,
			pointerType: "mouse",
			button: 0,
			clientX: 180,
			clientY: 180,
		}),
	);
	pageArea.dispatchEvent(
		new PointerEvent("pointermove", {
			bubbles: true,
			pointerId: 7,
			pointerType: "mouse",
			button: 0,
			clientX: 140,
			clientY: 150,
		}),
	);
	pageArea.dispatchEvent(
		new PointerEvent("pointerup", { bubbles: true, pointerId: 7, pointerType: "mouse" }),
	);
	expect(pageArea.scrollLeft).toBeGreaterThan(startScroll);
});

function createViewer(
	size: { width: number; height: number },
	backend: DocumentBackend,
): PamphletViewerElement {
	const element = document.createElement("pamphlet-viewer") as PamphletViewerElement;
	element.style.width = `${size.width}px`;
	element.style.height = `${size.height}px`;
	element.backend = backend;
	element.src = "./reader-test.pdf";
	return element;
}

function createBackend(pageCount: number, renderedPages: number[] = []): DocumentBackend {
	return {
		async open(): Promise<PageSource> {
			return {
				pageCount,
				async getPageSize(): Promise<{ width: number; height: number }> {
					return { width: 300, height: 400 };
				},
				async renderPage(pageIndex: number): Promise<PageVisual> {
					renderedPages.push(pageIndex);
					return {
						type: "pixels",
						width: 300,
						height: 400,
						pixels: createPixels(),
					};
				},
				dispose(): void {},
			};
		},
	};
}

function createPixels(): ArrayBuffer {
	const bytes = new Uint8ClampedArray(300 * 400 * 4);
	for (let offset = 0; offset < bytes.length; offset += 4) {
		bytes[offset] = 66;
		bytes[offset + 1] = 102;
		bytes[offset + 2] = 93;
		bytes[offset + 3] = 255;
	}
	return bytes.buffer;
}

function waitForPageChange(element: PamphletViewerElement): Promise<void> {
	return new Promise((resolve) =>
		element.addEventListener("pagechange", () => resolve(), { once: true }),
	);
}

function restoreProperty(
	target: object,
	name: string,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor === undefined) {
		Reflect.deleteProperty(target, name);
		return;
	}
	Object.defineProperty(target, name, descriptor);
}
