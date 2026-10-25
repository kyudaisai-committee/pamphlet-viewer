// SPDX-License-Identifier: MPL-2.0
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { dts } from "rolldown-plugin-dts";
import { defineConfig } from "vite";

import { sourceAlias } from "./vite.source-alias.js";

export default defineConfig({
	base: "./",
	plugins: [
		paraglideVitePlugin({ project: "./project.inlang", outdir: "./src/paraglide" }),
		svelte(),
		...dts({ generator: "tsc", tsconfig: "./tsconfig.library.json" }),
	],
	resolve: { alias: sourceAlias },
	oxc: { exclude: [/\.js$/, /\.d\.[cm]?ts$/] },
	build: {
		outDir: "dist/library",
		emptyOutDir: true,
		assetsInlineLimit: 0,
		rolldownOptions: {
			input: { "pamphlet-viewer": "src/lib/entry.ts" },
			preserveEntrySignatures: "strict",
			output: {
				format: "es",
				entryFileNames: "[name].js",
				chunkFileNames: "chunks/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
