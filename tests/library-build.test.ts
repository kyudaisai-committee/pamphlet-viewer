import { mkdir, mkdtempDisposable, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as ts from "typescript";
import { expect, test } from "vitest";

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
