import { execFile } from "node:child_process";
import { mkdtempDisposable, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { createReleaseArchive } from "../scripts/create-release-archive.ts";

const execFileAsync = promisify(execFile);

test("release archive preserves built library paths and includes every license notice and text", async () => {
	await using fixture = await mkdtempDisposable(join(tmpdir(), "pamphlet-viewer-release-test-"));
	const archivePath = join(fixture.path, "pamphlet-viewer.tgz");
	const libraryPath = resolve("dist/library");
	const libraryFiles = await listFiles(libraryPath);
	expect(libraryFiles).toContain("pamphlet-viewer.js");
	expect(
		libraryFiles.some(
			(filePath) => filePath.startsWith("assets/pdfium.worker-") && filePath.endsWith(".js"),
		),
	).toBe(true);
	expect(
		libraryFiles.some(
			(filePath) => filePath.startsWith("assets/pdfium-") && filePath.endsWith(".wasm"),
		),
	).toBe(true);

	await createReleaseArchive(archivePath);

	const { stdout: listing } = await execFileAsync("tar", ["-tzf", archivePath]);
	for (const filePath of libraryFiles) {
		expect(listing).toContain(`./${filePath}`);
	}

	const root = resolve();
	for (const licenseFile of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]) {
		expect(listing).toContain(`./${licenseFile}`);
		const { stdout: archivedContents } = await execFileAsync("tar", [
			"-xOzf",
			archivePath,
			`./${licenseFile}`,
		]);
		expect(archivedContents).toBe(await readFile(join(root, licenseFile), "utf8"));
	}

	const licenseNames = await readdir(join(root, "licenses"));
	for (const licenseName of licenseNames) {
		expect(listing).toContain(`./licenses/${licenseName}`);
		const { stdout: archivedContents } = await execFileAsync("tar", [
			"-xOzf",
			archivePath,
			`./licenses/${licenseName}`,
		]);
		expect(archivedContents).toBe(await readFile(join(root, "licenses", licenseName), "utf8"));
	}
});

async function listFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(path)));
		} else if (entry.isFile()) {
			files.push(relative(resolve("dist/library"), path));
		}
	}
	return files;
}
