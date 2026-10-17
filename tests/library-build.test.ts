import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { expect, test } from "vitest";

const LIBRARY_DIRECTORY = resolve(process.cwd(), "dist/library");

test("emits a self-hosted worker, external WASM asset, and public declarations", async () => {
	const files = await listFiles(LIBRARY_DIRECTORY);
	const entryPath = resolve(LIBRARY_DIRECTORY, "pamphlet-viewer.js");
	const entry = await readFile(entryPath, "utf8");
	const workerPath = files.find((file) => file.includes("pdfium.worker-") && file.endsWith(".js"));
	const wasmPath = files.find((file) => file.endsWith(".wasm"));

	if (workerPath === undefined || wasmPath === undefined) {
		throw new Error("The PDFium worker or WASM asset was not emitted as a file.");
	}
	const workerReference = relative(LIBRARY_DIRECTORY, workerPath).split("\\").join("/");
	const wasmFileName = wasmPath.split("/").at(-1);
	if (wasmFileName === undefined) throw new Error("The WASM asset has no file name.");

	expect(entry).toContain(workerReference);
	expect(entry).toContain(wasmFileName);
	expect(entry).not.toContain("pdfium.worker.ts");
	expect(entry).not.toContain("data:application/wasm");
	expect(entry).not.toContain("https://cdn.jsdelivr.net");
	expect(entry).not.toContain("https://unpkg.com");
	expect(files.map((file) => relative(LIBRARY_DIRECTORY, file))).toContain("types/entry.d.ts");
	expect(files.map((file) => relative(LIBRARY_DIRECTORY, file))).toContain("types/public-api.d.ts");
	expect(files.some((file) => file.includes("pdfium.worker-") && file.endsWith(".ts"))).toBe(false);

	const worker = await readFile(workerPath, "utf8");
	expect(worker).toContain(wasmFileName);
});

async function listFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const children = await Promise.all(
		entries.map(async (entry) => {
			const path = resolve(directory, entry.name);
			return entry.isDirectory() ? listFiles(path) : [path];
		}),
	);
	return children.flat();
}
