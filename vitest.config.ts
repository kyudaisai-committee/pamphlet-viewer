import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import { rangeFixturePlugin } from "./tests/range-fixture-plugin.js";

export default defineConfig({
	plugins: [rangeFixturePlugin()],
	optimizeDeps: {
		include: ["@embedpdf/pdfium"],
	},
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts"],
					exclude: ["src/**/*.browser.test.ts"],
					environment: "node",
				},
			},
			{
				test: {
					name: "browser",
					include: ["src/**/*.browser.test.ts"],
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
