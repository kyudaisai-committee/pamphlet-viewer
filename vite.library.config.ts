import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

import { sourceAlias } from "./vite.source-alias.js";

export default defineConfig({
	base: "./",
	plugins: [svelte()],
	resolve: { alias: sourceAlias },
	build: {
		outDir: "dist/library",
		emptyOutDir: true,
		assetsInlineLimit: 0,
		rolldownOptions: {
			input: "src/lib/entry.ts",
			preserveEntrySignatures: "strict",
			output: {
				format: "es",
				entryFileNames: "pamphlet-viewer.js",
				chunkFileNames: "chunks/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
