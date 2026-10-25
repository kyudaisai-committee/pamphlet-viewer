import { mkdir, mkdtempDisposable, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import * as ts from "typescript";
import { expect, test } from "vitest";

const LIBRARY_DIRECTORY = resolve(process.cwd(), "dist/library");

interface PackageManifest {
	private: boolean;
	exports: {
		".": {
			types: string;
			import: string;
		};
	};
}

test("emits a self-hosted worker, external WASM asset, and public declarations", async () => {
	const files = await listFiles(LIBRARY_DIRECTORY);
	const entryPath = resolve(LIBRARY_DIRECTORY, "pamphlet-viewer.js");
	const entry = await readFile(entryPath, "utf8");
	const packageManifest = JSON.parse(
		await readFile(resolve(process.cwd(), "package.json"), "utf8"),
	) as PackageManifest;
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
	expect(entry).not.toContain("@/lib/");
	expect(entry).not.toContain("data:application/wasm");
	expect(entry).not.toContain("https://cdn.jsdelivr.net");
	expect(entry).not.toContain("https://unpkg.com");
	expect(files.map((file) => relative(LIBRARY_DIRECTORY, file))).toContain("pamphlet-viewer.d.ts");
	expect(files.some((file) => file.includes("pdfium.worker-") && file.endsWith(".ts"))).toBe(false);
	expect(packageManifest.private).toBe(true);
	expect(packageManifest.exports["."]).toEqual({
		types: "./dist/library/pamphlet-viewer.d.ts",
		import: "./dist/library/pamphlet-viewer.js",
	});

	const worker = await readFile(workerPath, "utf8");
	expect(worker).toContain(wasmFileName);
	for (const javascriptFile of files.filter((file) => file.endsWith(".js"))) {
		expect(await readFile(javascriptFile, "utf8")).not.toContain("@/lib/");
	}
	for (const declarationFile of files.filter((file) => file.endsWith(".d.ts"))) {
		expect(await readFile(declarationFile, "utf8")).not.toContain("@/lib/");
	}
});

test("public declarations resolve for a consumer without the source alias", async () => {
	await using fixture = await mkdtempDisposable(join(tmpdir(), "pamphlet-viewer-types-"));
	const packagePath = resolve(process.cwd());
	const nodeModulesPath = join(fixture.path, "node_modules");
	await mkdir(nodeModulesPath, { recursive: true });
	await symlink(packagePath, join(nodeModulesPath, "pamphlet-viewer"), "dir");
	const consumerPath = join(fixture.path, "consumer.mts");
	await writeFile(
		consumerPath,
		[
			'import { PageSourceUnavailableError } from "pamphlet-viewer";',
			'import type { PamphletViewerElement } from "pamphlet-viewer";',
			'const unavailable = new PageSourceUnavailableError("The source is unavailable.");',
			"const error: Error = unavailable;",
			'if (error.name !== "PageSourceUnavailableError") throw error;',
			"declare const viewer: PamphletViewerElement;",
			"viewer.page = 2;",
			'viewer.setConfig({ chapters: [{ title: "Introduction", page: 1 }] });',
			'viewer.addEventListener("pagechange", (event) => event.detail.visiblePages);',
		].join("\n"),
	);
	const program = ts.createProgram([consumerPath], {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ES2023,
		strict: true,
		skipLibCheck: false,
		noEmit: true,
		types: [],
	});

	expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
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
