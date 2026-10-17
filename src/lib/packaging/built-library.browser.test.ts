import { expect, test } from "vitest";

interface LibraryTestMessage {
	type: "pagechange" | "error";
	detail?: unknown;
}

interface RegistrationMessage {
	type: "registration";
	registered: boolean;
}

test("loads the ESM custom element from plain HTML with its sibling PDF assets", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	if (!resetResponse.ok) throw new Error("The PDF Range metrics endpoint did not reset.");

	const frame = document.createElement("iframe");
	frame.src = "/__built-library-test.html";
	const message = waitForLibraryMessage(frame);
	const registration = waitForRegistration(frame);
	document.body.append(frame);

	try {
		const [outcome, hasRegistrationExport] = await Promise.all([message, registration]);
		if (outcome.type === "error") {
			throw new Error(`The built viewer failed: ${JSON.stringify(outcome.detail)}`);
		}
		expect(hasRegistrationExport).toBe(true);

		const frameDocument = frame.contentDocument;
		const frameWindow = frame.contentWindow;
		if (frameDocument === null || frameWindow === null) {
			throw new Error("Could not access the plain HTML test frame.");
		}

		const element = frameDocument.getElementById("viewer");
		if (element === null) {
			throw new Error("The plain HTML did not contain the upgraded custom element.");
		}
		const canvas = element.shadowRoot?.querySelector<HTMLCanvasElement>(".page-canvas");
		await expect.poll(() => canvas?.width ?? 0).toBeGreaterThan(0);
		if (canvas === null || canvas === undefined) {
			throw new Error("The built custom element did not render a page canvas.");
		}
		const context = canvas.getContext("2d");
		if (context === null) throw new Error("The built page canvas has no 2D context.");
		const pixel = context.getImageData(
			Math.floor(canvas.width / 2),
			Math.floor(canvas.height / 2),
			1,
			1,
		).data;
		expect(pixel[2]).toBeGreaterThan(100);

		const response = await fetch("/__pdfium-range-metrics");
		if (!response.ok) throw new Error("The PDF Range metrics endpoint did not respond.");
		const metrics = (await response.json()) as {
			requestedBytes: number;
			fullRequests: number;
			fileLength: number;
		};
		expect(metrics.fullRequests).toBe(0);
		expect(metrics.requestedBytes).toBeLessThan(metrics.fileLength);

		const resourceUrls = frameWindow.performance
			.getEntriesByType("resource")
			.map((entry) => new URL(entry.name));
		expect(
			resourceUrls.some((url) => url.pathname.startsWith("/dist/library/assets/pdfium.worker-")),
		).toBe(true);
		expect(resourceUrls.every((url) => url.origin === window.location.origin)).toBe(true);
		expect(frameWindow.customElements.get("pamphlet-viewer")).toBeDefined();
	} finally {
		frame.remove();
	}
});

function waitForLibraryMessage(frame: HTMLIFrameElement): Promise<LibraryTestMessage> {
	return new Promise((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			window.removeEventListener("message", receiveMessage);
			reject(new Error("The plain HTML custom element did not report a result."));
		}, 10_000);
		window.addEventListener("message", receiveMessage);

		function receiveMessage(event: MessageEvent<unknown>): void {
			if (event.source !== frame.contentWindow || !isLibraryTestMessage(event.data)) return;
			window.clearTimeout(timeoutId);
			window.removeEventListener("message", receiveMessage);
			resolve(event.data);
		}
	});
}

function waitForRegistration(frame: HTMLIFrameElement): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			window.removeEventListener("message", receiveMessage);
			reject(new Error("The built module did not export registerPamphletViewer."));
		}, 10_000);
		window.addEventListener("message", receiveMessage);

		function receiveMessage(event: MessageEvent<unknown>): void {
			if (event.source !== frame.contentWindow || !isRegistrationMessage(event.data)) return;
			window.clearTimeout(timeoutId);
			window.removeEventListener("message", receiveMessage);
			resolve(event.data.registered);
		}
	});
}

function isLibraryTestMessage(value: unknown): value is LibraryTestMessage {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	return value.type === "pagechange" || (value.type === "error" && "detail" in value);
}

function isRegistrationMessage(value: unknown): value is RegistrationMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "registration" &&
		"registered" in value &&
		typeof value.registered === "boolean"
	);
}
