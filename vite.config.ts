import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	plugins: [svelte()],
	build: {
		outDir: "dist/demo",
		emptyOutDir: true,
	},
	optimizeDeps: {
		include: ["@embedpdf/pdfium", "@lucide/svelte"],
	},
});
