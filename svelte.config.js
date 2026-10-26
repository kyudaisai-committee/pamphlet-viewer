// SPDX-License-Identifier: MIT

/** @param {{ filename: string }} options */
function isPamphletViewer({ filename }) {
	return filename.split(/[\\/]/).at(-1) === "PamphletViewer.svelte";
}

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
const svelteConfig = {
	compilerOptions: {
		customElement: isPamphletViewer,
		css: "injected",
	},
};

export default svelteConfig;
