// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LICENSE_FILES = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"];

export async function createReleaseArchive(
	archivePath: string,
	libraryPath = resolve("dist/library"),
	projectRoot = process.cwd(),
): Promise<void> {
	const absoluteArchivePath = resolve(archivePath);
	const absoluteLibraryPath = resolve(libraryPath);
	const absoluteProjectRoot = resolve(projectRoot);

	await mkdir(dirname(absoluteArchivePath), { recursive: true });

	await using staging = await mkdtempDisposable(join(tmpdir(), "pamphlet-viewer-release-"));
	await cp(absoluteLibraryPath, staging.path, { recursive: true });

	for (const licenseFile of LICENSE_FILES) {
		await cp(join(absoluteProjectRoot, licenseFile), join(staging.path, licenseFile));
	}
	await cp(join(absoluteProjectRoot, "licenses"), join(staging.path, "licenses"), {
		recursive: true,
	});

	await execFileAsync("tar", ["-czf", absoluteArchivePath, "-C", staging.path, "."]);
}

const invokedScriptPath = process.argv[1];
if (
	invokedScriptPath !== undefined &&
	resolve(invokedScriptPath) === fileURLToPath(import.meta.url)
) {
	const archivePath = process.argv[2];
	if (archivePath === undefined) {
		throw new Error("Usage: node scripts/create-release-archive.ts <archive-path>");
	}
	await createReleaseArchive(archivePath);
}
