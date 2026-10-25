// SPDX-License-Identifier: MPL-2.0

import { createReadStream } from "node:fs";
import type { ReadStream } from "node:fs";
import type { Server, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";

export async function disposeFixtureServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await server[Symbol.asyncDispose]();
}

export async function streamFileResponse(
	response: ServerResponse,
	filePath: string,
): Promise<void> {
	let source: ReadStream | undefined;

	function stopSourceOnResponseClose(): void {
		if (source !== undefined && !source.destroyed) source.destroy();
	}

	response.once("close", stopSourceOnResponseClose);
	try {
		await using stream = createReadStream(filePath);
		source = stream;
		stream.pipe(response);
		await finished(stream, { cleanup: true });
	} catch {
		if (response.destroyed) return;
		if (!response.headersSent) {
			response.statusCode = 404;
			response.end();
			return;
		}
		response.destroy();
	} finally {
		response.off("close", stopSourceOnResponseClose);
	}
}
