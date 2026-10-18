import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [svelte()],
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
