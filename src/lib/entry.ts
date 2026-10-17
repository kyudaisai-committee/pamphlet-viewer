import PamphletViewer from "./ui/PamphletViewer.svelte";

export * from "./public-api";

export function registerPamphletViewer(registry: CustomElementRegistry = customElements): void {
	if (registry.get("pamphlet-viewer") !== undefined) return;
	const elementConstructor = PamphletViewer.element;
	if (elementConstructor === undefined) {
		throw new Error("PamphletViewer was not compiled as a custom element.");
	}
	registry.define("pamphlet-viewer", elementConstructor);
}

if (typeof customElements !== "undefined") registerPamphletViewer();
