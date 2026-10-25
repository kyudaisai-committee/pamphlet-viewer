// SPDX-License-Identifier: MPL-2.0

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

import { sourceAlias } from "./vite.source-alias.js";

// https://vite.dev/config/
export default defineConfig({
	plugins: [svelte()],
	resolve: { alias: sourceAlias },
	build: {
		outDir: "dist/demo",
		emptyOutDir: true,
	},
	optimizeDeps: {
		include: ["@embedpdf/pdfium", "@lucide/svelte"],
	},
});
