// SPDX-License-Identifier: MIT
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

import { sourceAlias } from "./vite.source-alias.js";

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		paraglideVitePlugin({
			project: "./project.inlang",
			outdir: "./src/paraglide",
			emitTsDeclarations: true,
		}),
		svelte(),
	],
	resolve: { alias: sourceAlias },
	build: {
		outDir: "dist/demo",
		emptyOutDir: true,
	},
	optimizeDeps: {
		include: ["@embedpdf/pdfium", "@lucide/svelte"],
	},
});
