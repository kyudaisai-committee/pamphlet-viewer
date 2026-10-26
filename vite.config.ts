import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

import { sourceAlias } from "./vite.source-alias.js";

const LICENSE_BANNER = `/*!
 * SPDX-License-Identifier: MIT
 * Source code: https://github.com/kyudaisai-committee/pamphlet-viewer
 */`;

// https://vite.dev/config/
export default defineConfig({
	plugins: [svelte()],
	resolve: { alias: sourceAlias },
	build: {
		outDir: "dist/demo",
		emptyOutDir: true,
		rolldownOptions: { output: { banner: LICENSE_BANNER, comments: { legal: true } } },
	},
	worker: {
		rolldownOptions: { output: { banner: LICENSE_BANNER, comments: { legal: true } } },
	},
	optimizeDeps: {
		include: ["@embedpdf/pdfium", "@lucide/svelte"],
	},
});
