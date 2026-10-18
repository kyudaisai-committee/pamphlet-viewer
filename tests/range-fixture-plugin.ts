import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

import type { Plugin } from "vite";

import { disposeFixtureServer, streamFileResponse } from "./http-resource-lifecycle.js";
import { createLibraryTestHtml, createRemoteLibraryTestHtml } from "./library-fixture-pages.js";
import { createPdfFixture } from "./pdf-fixture.js";

const FIXTURE_PATH = "/__pdfium-range-fixture.pdf";
const METRICS_PATH = "/__pdfium-range-metrics";
const RESET_PATH = "/__pdfium-range-reset";
const LINEARIZED_FIXTURE_PATH = "/__linearized-range-fixture.pdf";
const LINEARIZED_METRICS_PATH = "/__linearized-range-metrics";
const TINY_PAGE_FIXTURE_PATH = "/__tiny-page-range-fixture.pdf";
const TINY_PAGE_METRICS_PATH = "/__tiny-page-range-metrics";
const EVICTION_FIXTURE_PATH = "/__pdfium-eviction-fixture.pdf";
const EVICTION_METRICS_PATH = "/__pdfium-eviction-metrics";
const CORS_ORIGIN_PATH = "/__pdfium-cors-origin";
const CORS_CLOSE_PATH = "/__pdfium-cors-close";
const CORS_ASSET_METRICS_PATH = "/__pdfium-cors-asset-metrics";
const LIBRARY_DIRECTORY = resolve(process.cwd(), "dist/library");
const LIBRARY_HTML_PATH = "/__built-library-test.html";
const REMOTE_LIBRARY_HTML_PATH = "/__built-library-remote-test.html";

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
	const regularFixture = createFixtureRecord(createPdfFixture(), METRICS_PATH);
	const linearizedFixture = createFixtureRecord(
		Buffer.from(readFileSync(new URL("./fixtures/pamphlet-linearized.pdf", import.meta.url))),
		LINEARIZED_METRICS_PATH,
	);
	const tinyPageFixture = createFixtureRecord(
		createPdfFixture({ tinyPageNumbers: [16, 17] }),
		TINY_PAGE_METRICS_PATH,
	);
	const evictionFixture = createFixtureRecord(
		createPdfFixture({ contentGapBytes: 256 * 1024, midDocumentFillerBytes: 0 }),
		EVICTION_METRICS_PATH,
	);
	const fixtures = new Map<string, FixtureRecord>([
		[FIXTURE_PATH, regularFixture],
		[LINEARIZED_FIXTURE_PATH, linearizedFixture],
		[TINY_PAGE_FIXTURE_PATH, tinyPageFixture],
		[EVICTION_FIXTURE_PATH, evictionFixture],
	]);
	const corsServers = new Map<number, ReturnType<typeof createServer>>();
	const corsAssetRequests = new Map<number, string[]>();

	return {
		name: "range-pdf-fixture",
		configureServer(server) {
			server.httpServer?.once("close", function closeCorsServer(): void {
				closeCorsFixtureServers(corsServers);
			});

			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
				if (pathname === LIBRARY_HTML_PATH) {
					response.setHeader("Content-Type", "text/html; charset=utf-8");
					response.end(createLibraryTestHtml());
					return;
				}
				if (pathname === REMOTE_LIBRARY_HTML_PATH) {
					const searchParams = new URL(request.url ?? "/", "http://localhost").searchParams;
					const entryUrl = searchParams.get("entry");
					const pdfUrl = searchParams.get("pdf");
					if (entryUrl === null || pdfUrl === null) {
						response.statusCode = 400;
						response.end();
						return;
					}
					response.setHeader("Content-Type", "text/html; charset=utf-8");
					response.end(createRemoteLibraryTestHtml(entryUrl, pdfUrl));
					return;
				}
				if (pathname === RESET_PATH) {
					for (const fixture of fixtures.values()) resetMetrics(fixture.metrics);
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ reset: true }));
					return;
				}
				if (pathname === CORS_ORIGIN_PATH) {
					const assetRequests: string[] = [];
					const corsServer = createCorsFixtureServer(regularFixture, assetRequests);
					corsServer.listen(0, "127.0.0.1", function sendCorsServerPort(): void {
						const address = corsServer.address();
						if (address === null || address === undefined || typeof address === "string") {
							response.statusCode = 503;
							response.end();
							void disposeFixtureServer(corsServer).catch(reportFixtureDisposalError);
							return;
						}
						corsServers.set(address.port, corsServer);
						corsAssetRequests.set(address.port, assetRequests);
						response.setHeader("Content-Type", "application/json");
						response.end(JSON.stringify({ port: address.port }));
					});
					return;
				}
				if (pathname === CORS_CLOSE_PATH) {
					const port = Number(
						new URL(request.url ?? "/", "http://localhost").searchParams.get("port"),
					);
					const activeServer = corsServers.get(port);
					corsServers.delete(port);
					corsAssetRequests.delete(port);
					if (activeServer === undefined) {
						response.end();
						return;
					}
					void disposeFixtureServer(activeServer).then(
						function finishCorsServerClose(): void {
							response.end();
						},
						function failCorsServerClose(error: unknown): void {
							reportFixtureDisposalError(error);
							response.statusCode = 500;
							response.end();
						},
					);
					return;
				}
				if (pathname === CORS_ASSET_METRICS_PATH) {
					const port = Number(
						new URL(request.url ?? "/", "http://localhost").searchParams.get("port"),
					);
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ requests: corsAssetRequests.get(port) ?? [] }));
					return;
				}
				const metricsFixture = [...fixtures.values()].find(
					(fixture) => fixture.metricsPath === pathname,
				);
				if (metricsFixture !== undefined) {
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify(metricsFixture.metrics));
					return;
				}
				const fixture = fixtures.get(pathname);
				if (fixture === undefined) {
					next();
					return;
				}
				sendFixtureResponse(request, response, fixture);
			});
		},
	};
}

interface FixtureRecord {
	pdf: Buffer;
	metricsPath: string;
	metrics: FixtureMetrics;
}

function createFixtureRecord(pdf: Buffer, metricsPath: string): FixtureRecord {
	return {
		pdf,
		metricsPath,
		metrics: { requestedBytes: 0, fullRequests: 0, ranges: [], fileLength: pdf.byteLength },
	};
}

function resetMetrics(metrics: FixtureMetrics): void {
	metrics.requestedBytes = 0;
	metrics.fullRequests = 0;
	metrics.ranges = [];
}

function setCorsHeaders(response: ServerResponse, origin: string): void {
	response.setHeader("Access-Control-Allow-Origin", origin);
	response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
	response.setHeader("Access-Control-Allow-Headers", "Range, If-Range");
	response.setHeader(
		"Access-Control-Expose-Headers",
		"Accept-Ranges, Content-Range, ETag, Last-Modified",
	);
	response.setHeader("Vary", "Origin");
}

function sendFixtureResponse(
	request: IncomingMessage,
	response: ServerResponse,
	fixture: FixtureRecord,
): void {
	const origin = request.headers.origin;
	if (origin !== undefined) setCorsHeaders(response, origin);
	if (request.method === "OPTIONS") {
		response.statusCode = 204;
		response.end();
		return;
	}

	const { pdf, metrics } = fixture;
	response.setHeader("Content-Type", "application/pdf");
	response.setHeader("Accept-Ranges", "bytes");
	response.setHeader("ETag", '"range-fixture-v1"');
	response.setHeader("Cache-Control", "no-store");
	if (request.headers.range === undefined) {
		metrics.fullRequests += 1;
		response.statusCode = 200;
		response.setHeader("Content-Length", pdf.byteLength);
		response.end(pdf);
		return;
	}

	const range = parseByteRange(request.headers.range, pdf.byteLength);
	if (range === null) {
		response.statusCode = 416;
		response.setHeader("Content-Range", `bytes */${pdf.byteLength}`);
		response.end();
		return;
	}

	const body = pdf.subarray(range.start, range.end + 1);
	metrics.ranges.push(range);
	metrics.requestedBytes += body.byteLength;
	response.statusCode = 206;
	response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${pdf.byteLength}`);
	response.setHeader("Content-Length", body.byteLength);
	response.end(body);
}

function createCorsFixtureServer(
	fixture: FixtureRecord,
	assetRequests: string[],
): ReturnType<typeof createServer> {
	return createServer(function serveCorsFixture(request, response): void {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname === FIXTURE_PATH) {
			sendFixtureResponse(request, response, fixture);
			return;
		}
		assetRequests.push(pathname);
		void serveLibraryAsset(response, pathname);
	});
}

function closeCorsFixtureServers(servers: Map<number, ReturnType<typeof createServer>>): void {
	const pendingDisposals = Array.from(servers.values(), function disposeServer(server) {
		return disposeFixtureServer(server);
	});
	servers.clear();
	void Promise.all(pendingDisposals).catch(reportFixtureDisposalError);
}

function reportFixtureDisposalError(error: unknown): void {
	process.emitWarning(
		error instanceof Error
			? error
			: new Error("Unable to dispose a fixture HTTP server", { cause: error }),
	);
}

async function serveLibraryAsset(response: ServerResponse, pathname: string): Promise<void> {
	const filePath = resolve(LIBRARY_DIRECTORY, `.${pathname}`);
	if (!filePath.startsWith(`${LIBRARY_DIRECTORY}${sep}`)) {
		response.statusCode = 404;
		response.end();
		return;
	}

	response.setHeader("Access-Control-Allow-Origin", "*");
	response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
	response.setHeader("Content-Type", getLibraryAssetContentType(extname(filePath)));
	await streamFileResponse(response, filePath);
}

function getLibraryAssetContentType(extension: string): string {
	if (extension === ".js") return "text/javascript; charset=utf-8";
	if (extension === ".wasm") return "application/wasm";
	return "application/octet-stream";
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
