import { Buffer } from "node:buffer";

import type { Plugin } from "vite";

const FIXTURE_PATH = "/__pdfium-range-fixture.pdf";
const METRICS_PATH = "/__pdfium-range-metrics";
const RESET_PATH = "/__pdfium-range-reset";
const LIBRARY_HTML_PATH = "/__built-library-test.html";
const PAGE_COUNT = 24;
const FILLER_BYTES = 32 * 1024 * 1024;
const TRAILING_FILLER_BYTES = 1024 * 1024;
const FAR_PAGE_COLOR = [0.91, 0.08, 0.16] as const;

interface FixtureMetrics {
	requestedBytes: number;
	fullRequests: number;
	ranges: Array<{ start: number; end: number }>;
	fileLength: number;
}

interface ByteRange {
	start: number;
	end: number;
}

export function rangeFixturePlugin(): Plugin {
	const fixture = createPdfFixture();
	const metrics: FixtureMetrics = {
		requestedBytes: 0,
		fullRequests: 0,
		ranges: [],
		fileLength: fixture.byteLength,
	};

	return {
		name: "range-pdf-fixture",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
				if (pathname === LIBRARY_HTML_PATH) {
					response.setHeader("Content-Type", "text/html; charset=utf-8");
					response.end(createLibraryTestHtml());
					return;
				}
				if (pathname === RESET_PATH) {
					metrics.requestedBytes = 0;
					metrics.fullRequests = 0;
					metrics.ranges = [];
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ reset: true }));
					return;
				}
				if (pathname === METRICS_PATH) {
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify(metrics));
					return;
				}
				if (pathname !== FIXTURE_PATH) {
					next();
					return;
				}

				response.setHeader("Content-Type", "application/pdf");
				response.setHeader("Accept-Ranges", "bytes");
				response.setHeader("ETag", '"range-fixture-v1"');
				response.setHeader("Cache-Control", "no-store");
				if (request.headers.range === undefined) {
					metrics.fullRequests += 1;
					response.statusCode = 200;
					response.setHeader("Content-Length", fixture.byteLength);
					response.end(fixture);
					return;
				}

				const range = parseByteRange(request.headers.range, fixture.byteLength);
				if (range === null) {
					response.statusCode = 416;
					response.setHeader("Content-Range", `bytes */${fixture.byteLength}`);
					response.end();
					return;
				}

				const body = fixture.subarray(range.start, range.end + 1);
				metrics.ranges.push(range);
				metrics.requestedBytes += body.byteLength;
				response.statusCode = 206;
				response.setHeader(
					"Content-Range",
					`bytes ${range.start}-${range.end}/${fixture.byteLength}`,
				);
				response.setHeader("Content-Length", body.byteLength);
				response.end(body);
			});
		},
	};
}

function createLibraryTestHtml(): string {
	return `<!doctype html>
<html lang="ja">
	<head>
		<meta charset="utf-8">
		<title>Custom Element distribution test</title>
	</head>
	<body>
		<pamphlet-viewer id="viewer" src="${FIXTURE_PATH}" layout="single" style="display:block;width:840px;height:560px"></pamphlet-viewer>
		<script>
			document.addEventListener("pagechange", (event) => {
				parent.postMessage({ type: "pagechange", detail: event.detail }, location.origin);
			});
			document.addEventListener("error", (event) => {
				parent.postMessage({ type: "error", detail: event.detail }, location.origin);
			});
		</script>
		<script type="module" src="/dist/library/pamphlet-viewer.js?load=first"></script>
		<script type="module">
			import { registerPamphletViewer } from "/dist/library/pamphlet-viewer.js?load=duplicate";
			registerPamphletViewer();
			parent.postMessage(
				{ type: "registration", registered: typeof registerPamphletViewer === "function" },
				location.origin,
			);
		</script>
	</body>
</html>`;
}

function parseByteRange(value: string, fileLength: number): ByteRange | null {
	const match = /^bytes=(\d+)-(\d+)$/.exec(value);
	if (match === null) return null;

	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
	if (start < 0 || end < start || start >= fileLength) return null;

	return { start, end: Math.min(end, fileLength - 1) };
}

function createPdfFixture(): Buffer {
	const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n", "ascii")];
	const offsets: number[] = [0];
	let position = chunks[0].byteLength;

	appendObject(chunks, offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>", position);
	position += chunks.at(-1)?.byteLength ?? 0;

	const pageReferences = Array.from({ length: PAGE_COUNT }, (_, index) => {
		const pageObject = 3 + index;
		return `${pageObject} 0 R`;
	});
	const pagesObject = `<< /Type /Pages /Count ${PAGE_COUNT} /Kids [${pageReferences.join(" ")}] >>`;
	appendObject(chunks, offsets, 2, pagesObject, position);
	position += chunks.at(-1)?.byteLength ?? 0;

	for (let index = 0; index < PAGE_COUNT; index += 1) {
		const pageObject = 3 + index;
		const contentObject = 3 + PAGE_COUNT + index;
		const pageBody = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents ${contentObject} 0 R >>`;
		appendObject(chunks, offsets, pageObject, pageBody, position);
		position += chunks.at(-1)?.byteLength ?? 0;
	}

	for (let index = 0; index < PAGE_COUNT; index += 1) {
		if (index === PAGE_COUNT / 2) {
			appendFiller(chunks, FILLER_BYTES);
			position += FILLER_BYTES;
		}

		const contentObject = 3 + PAGE_COUNT + index;
		const color = getPageColor(index);
		const stream = `q\n${color[0]} ${color[1]} ${color[2]} rg\n30 40 240 320 re\nf\nQ\n`;
		const contentBody = `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`;
		appendObject(chunks, offsets, contentObject, contentBody, position);
		position += chunks.at(-1)?.byteLength ?? 0;
	}
	appendFiller(chunks, TRAILING_FILLER_BYTES);
	position += TRAILING_FILLER_BYTES;

	const objectCount = offsets.length;
	const xrefOffset = position;
	const xrefLines = ["xref", `0 ${objectCount}`, "0000000000 65535 f "];
	for (const offset of offsets.slice(1)) {
		xrefLines.push(`${offset.toString().padStart(10, "0")} 00000 n `);
	}
	const trailer = [
		"trailer",
		`<< /Size ${objectCount} /Root 1 0 R >>`,
		"startxref",
		`${xrefOffset}`,
		"%%EOF",
		"",
	].join("\n");
	chunks.push(Buffer.from(`${xrefLines.join("\n")}\n${trailer}`, "ascii"));

	return Buffer.concat(chunks);
}

function appendFiller(chunks: Buffer[], byteLength: number): void {
	const filler = Buffer.alloc(byteLength, 0x78);
	filler[0] = 0x25;
	filler[filler.byteLength - 1] = 0x0a;
	chunks.push(filler);
}

function getPageColor(index: number): readonly [number, number, number] {
	if (index === PAGE_COUNT - 1) return FAR_PAGE_COLOR;
	return [0.12, 0.34, 0.72];
}

function appendObject(
	chunks: Buffer[],
	offsets: number[],
	objectNumber: number,
	body: string,
	position: number,
): void {
	const chunk = Buffer.from([`${objectNumber} 0 obj`, body, "endobj", ""].join("\n"), "ascii");
	offsets[objectNumber] = position;
	chunks.push(chunk);
}
