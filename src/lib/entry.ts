// SPDX-License-Identifier: MIT

import PamphletViewer from "@/lib/ui/reader/PamphletViewer.svelte";

export * from "./public-api";

export function registerPamphletViewer(registry: CustomElementRegistry = customElements): void {
	if (registry.get("pamphlet-viewer") !== undefined) return;
	const component = PamphletViewer as typeof PamphletViewer & {
		element?: CustomElementConstructor;
	};
	const elementConstructor = component.element;
	if (elementConstructor === undefined) {
		throw new Error("PamphletViewer was not compiled as a custom element.");
	}
	registry.define("pamphlet-viewer", elementConstructor);
}
