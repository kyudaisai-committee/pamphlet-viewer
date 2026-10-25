// SPDX-License-Identifier: MPL-2.0

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { rangeFixturePlugin } from "./tests/range-fixture-plugin.js";
import { sourceAlias } from "./vite.source-alias.js";

export default defineConfig({
	plugins: [svelte(), rangeFixturePlugin()],
	resolve: { alias: sourceAlias },
	optimizeDeps: {
		include: ["@embedpdf/pdfium", "@lucide/svelte"],
	},
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
					exclude: ["src/**/*.browser.test.ts"],
					environment: "node",
				},
			},
			{
				test: {
					name: "browser",
					include: ["src/**/*.browser.test.ts"],
					fileParallelism: false,
					browser: {
						enabled: true,
						headless: true,
						provider: playwright({ launchOptions: { channel: "chrome" } }),
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
});
