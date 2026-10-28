import { expect, test } from "vitest";

import type { PamphletViewerElement } from "@/lib/public-api";

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

		const viewer = element as PamphletViewerElement;
		viewer.setConfig({ chapters: [{ title: "配布版の章", page: 1 }] });
		await expect
			.poll(() => viewer.shadowRoot?.querySelector('[data-panel-toggle="chapters"]'))
			.not.toBeNull();
		const tableOfContentsToggle = viewer.shadowRoot?.querySelector<HTMLButtonElement>(
			'[data-panel-toggle="chapters"]',
		);
		if (tableOfContentsToggle === null || tableOfContentsToggle === undefined) {
			throw new Error("The built custom element did not render the configured chapters.");
		}
		tableOfContentsToggle.click();
		await expect
			.poll(() => viewer.shadowRoot?.querySelector(".chapter-title")?.textContent)
			.toBe("配布版の章");

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
			resourceUrls.some((url) =>
				url.pathname.startsWith("/dist/library/assets/pdfium.worker-"),
			),
		).toBe(true);
		expect(resourceUrls.every((url) => url.origin === window.location.origin)).toBe(true);
		expect(frameWindow.customElements.get("pamphlet-viewer")).toBeDefined();
	} finally {
		frame.remove();
	}
});

test("loads the built custom element and worker from a separate asset origin", async () => {
	const resetResponse = await fetch("/__pdfium-range-reset");
	if (!resetResponse.ok) throw new Error("The PDF Range metrics endpoint did not reset.");
	const originResponse = await fetch("/__pdfium-cors-origin");
	if (!originResponse.ok) throw new Error("The external asset server did not start.");
	const { port } = (await originResponse.json()) as { port: number };
	const remoteEntry = new URL("/pamphlet-viewer.js", window.location.href);
	remoteEntry.hostname = "127.0.0.1";
	remoteEntry.port = String(port);
	const pdfUrl = new URL("/__pdfium-range-fixture.pdf", window.location.href).href;

	const frame = document.createElement("iframe");
	frame.src = `/__built-library-remote-test.html?entry=${encodeURIComponent(remoteEntry.href)}&pdf=${encodeURIComponent(pdfUrl)}`;
	const result = waitForRemoteLibraryResult(frame);
	document.body.append(frame);
	try {
		const outcome = await result;
		const frameWindow = frame.contentWindow;
		const remoteResources =
			frameWindow?.performance
				.getEntriesByType("resource")
				.map((entry) => new URL(entry.name).href) ?? [];
		if (outcome.type === "error") {
			const metrics = await fetch("/__pdfium-range-metrics");
			const rangeMetrics = metrics.ok ? await metrics.json() : "unavailable";
			const assetMetrics = await fetch(`/__pdfium-cors-asset-metrics?port=${port}`);
			const assetRequests = assetMetrics.ok ? await assetMetrics.json() : "unavailable";
			throw new Error(
				`The remote library failed: ${JSON.stringify(outcome.detail)}; resources: ${JSON.stringify(remoteResources)}; assets: ${JSON.stringify(assetRequests)}; ranges: ${JSON.stringify(rangeMetrics)}`,
			);
		}

		const frameDocument = frame.contentDocument;
		if (frameDocument === null || frameWindow === null) {
			throw new Error("Could not access the external-asset test frame.");
		}
		const element = frameDocument.getElementById("viewer");
		const canvas = element?.shadowRoot?.querySelector<HTMLCanvasElement>(".page-canvas");
		await expect.poll(() => canvas?.width ?? 0).toBeGreaterThan(0);
		if (canvas === null || canvas === undefined) {
			throw new Error("The remote worker did not render a page canvas.");
		}
		const context = canvas.getContext("2d");
		if (context === null) throw new Error("The remote page canvas has no 2D context.");
		const pixel = context.getImageData(
			Math.floor(canvas.width / 2),
			Math.floor(canvas.height / 2),
			1,
			1,
		).data;
		expect(pixel[2]).toBeGreaterThan(100);

		expect(remoteResources).toContain(remoteEntry.href);
		const assetMetrics = await fetch(`/__pdfium-cors-asset-metrics?port=${port}`);
		if (!assetMetrics.ok) throw new Error("The remote asset metrics endpoint did not respond.");
		const assetRequests = (await assetMetrics.json()) as { requests: string[] };
		expect(assetRequests.requests.some((path) => path.includes("pdfium.worker-"))).toBe(true);
		expect(assetRequests.requests.some((path) => path.endsWith(".wasm"))).toBe(true);

		const metrics = await fetch("/__pdfium-range-metrics");
		if (!metrics.ok) throw new Error("The PDF Range metrics endpoint did not respond.");
		const rangeMetrics = (await metrics.json()) as {
			requestedBytes: number;
			fullRequests: number;
			fileLength: number;
		};
		expect(rangeMetrics.fullRequests).toBe(0);
		expect(rangeMetrics.requestedBytes).toBeLessThan(rangeMetrics.fileLength);
	} finally {
		frame.remove();
		await fetch(`/__pdfium-cors-close?port=${port}`);
	}
}, 45_000);

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

interface RemoteLibraryResult {
	type: "pagechange" | "error";
	detail?: unknown;
}

function waitForRemoteLibraryResult(frame: HTMLIFrameElement): Promise<RemoteLibraryResult> {
	return new Promise((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			window.removeEventListener("message", receiveMessage);
			reject(new Error("The remote library did not render or report an error."));
		}, 15_000);
		window.addEventListener("message", receiveMessage);

		function receiveMessage(event: MessageEvent<unknown>): void {
			if (event.source !== frame.contentWindow || !isRemoteLibraryResult(event.data)) return;
			window.clearTimeout(timeoutId);
			window.removeEventListener("message", receiveMessage);
			resolve(event.data);
		}
	});
}

function isRemoteLibraryResult(value: unknown): value is RemoteLibraryResult {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	return value.type === "pagechange" || (value.type === "error" && "detail" in value);
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
