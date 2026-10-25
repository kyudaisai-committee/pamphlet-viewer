// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "vitest";

type PublicApiMessage =
	| { type: "setup"; exported: boolean }
	| { type: "pagechange" }
	| { type: "error"; code: string; retryable: boolean };

test("the built public error value drives thumbnail recovery through the custom element", async () => {
	const frame = document.createElement("iframe");
	const messages: PublicApiMessage[] = [];
	const receiveMessage = (event: MessageEvent<unknown>): void => {
		if (event.source === frame.contentWindow && isPublicApiMessage(event.data)) {
			messages.push(event.data);
		}
	};
	window.addEventListener("message", receiveMessage);
	frame.src = "/__built-library-test.html?mode=public-error";
	document.body.append(frame);

	try {
		await expect
			.poll(() => messages.find((message) => message.type === "setup"))
			.toEqual({
				type: "setup",
				exported: true,
			});
		const frameDocument = frame.contentDocument;
		const viewer = frameDocument?.getElementById("viewer");
		if (viewer === null || viewer === undefined) {
			throw new Error("The public error test frame did not create its viewer.");
		}

		await expect.poll(() => messages.some((message) => message.type === "pagechange")).toBe(true);
		const initialSuccessfulRenderCount = Number(
			viewer.getAttribute("data-successful-render-count"),
		);
		const shadowRoot = viewer.shadowRoot;
		if (shadowRoot === null) throw new Error("The built viewer did not attach its shadow root.");
		viewer.setAttribute("data-fail-thumbnail-next-render", "true");
		shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();

		await expect
			.poll(() => messages.find((message) => message.type === "error"))
			.toEqual({
				type: "error",
				code: "render-failed",
				retryable: true,
			});
		await expect.poll(() => shadowRoot.querySelector(".thumbnail-panel")).toBeNull();
		const retryButton = shadowRoot.querySelector<HTMLButtonElement>('[role="alert"] button');
		expect(retryButton).not.toBeNull();
		retryButton?.click();

		await expect.poll(() => viewer.getAttribute("data-open-count")).toBe("2");
		await expect
			.poll(() => Number(viewer.getAttribute("data-successful-render-count")))
			.toBeGreaterThan(initialSuccessfulRenderCount);
		await expect.poll(() => shadowRoot.querySelector('[role="alert"]')).toBeNull();

		const successfulRenderCount = Number(viewer.getAttribute("data-successful-render-count"));
		shadowRoot.querySelector<HTMLButtonElement>(".thumbnail-toggle")?.click();
		await expect
			.poll(() => Number(viewer.getAttribute("data-successful-render-count")))
			.toBeGreaterThan(successfulRenderCount);
		const thumbnailCanvas = shadowRoot.querySelector<HTMLCanvasElement>(
			'.thumbnail-entry[data-page-index="0"] canvas',
		);
		expect(thumbnailCanvas?.width).toBe(2);
	} finally {
		window.removeEventListener("message", receiveMessage);
		frame.remove();
	}
}, 20_000);

function isPublicApiMessage(value: unknown): value is PublicApiMessage {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	if (value.type === "pagechange") return true;
	if (value.type === "setup") return "exported" in value && typeof value.exported === "boolean";
	return (
		value.type === "error" &&
		"code" in value &&
		typeof value.code === "string" &&
		"retryable" in value &&
		typeof value.retryable === "boolean"
	);
}
