// SPDX-License-Identifier: MPL-2.0

export interface ContentRange {
	start: number;
	end: number;
	total: number;
}

export function parseContentRange(value: string | null): ContentRange | null {
	if (value === null) return null;

	const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
	if (match === null) return null;

	const start = Number(match[1]);
	const end = Number(match[2]);
	const total = Number(match[3]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
		return null;
	}
	if (start < 0 || end < start || total <= end) return null;

	return { start, end, total };
}

export function cancelResponseBody(response: Response): void {
	if (response.body === null) return;
	void response.body.cancel().catch(() => {});
}

export async function readBoundedResponseBody(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const declaredLength = response.headers.get("Content-Length");
	if (declaredLength !== null && Number(declaredLength) > maxBytes) {
		cancelResponseBody(response);
		throw new Error("The server sent more bytes than requested for a PDF byte range.");
	}

	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			if (result.value.byteLength > maxBytes - byteLength) {
				void reader.cancel().catch(() => {});
				throw new Error("The server sent more bytes than requested for a PDF byte range.");
			}
			chunks.push(result.value);
			byteLength += result.value.byteLength;
		}
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
