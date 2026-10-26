import type { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";

import type { Plugin } from "vite";

import { createPdfFixture } from "./pdf-fixture.js";

const FIXTURE_PATH = "/__render-priority-fixture.pdf";
const CONTROL_PATH = "/__render-priority-control";
const METRICS_PATH = "/__render-priority-metrics";

interface FixtureMetrics {
	rangeRequests: number;
	delayRangeStarted: boolean;
	delayRangeFinished: boolean;
	delayRangeCancelled: boolean;
}

interface ByteRange {
	start: number;
	end: number;
}

interface RangeDelayControl {
	readonly delayMs: number;
	setRelease(release: () => void): void;
	clearRelease(release: () => void): void;
}

export function renderPriorityFixturePlugin(): Plugin {
	const fixtureGapBytes = 512 * 1024;
	const pdf = createPdfFixture({
		contentGapBytes: fixtureGapBytes,
		midDocumentFillerBytes: 0,
		pageObjectGapBytes: fixtureGapBytes,
	});
	const metrics: FixtureMetrics = {
		rangeRequests: 0,
		delayRangeStarted: false,
		delayRangeFinished: false,
		delayRangeCancelled: false,
	};
	let delayNextRangeMs = 0;
	let holdNextRange = false;
	let delayIssued = false;
	let releaseHeldRange: (() => void) | null = null;

	return {
		name: "render-priority-pdf-fixture",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const url = new URL(request.url ?? "/", "http://localhost");
				if (url.pathname === CONTROL_PATH) {
					if (url.searchParams.get("releaseDelayedRange") === "true") {
						const release = releaseHeldRange;
						releaseHeldRange = null;
						release?.();
						response.setHeader("Content-Type", "application/json");
						response.end(JSON.stringify({ released: release !== null }));
						return;
					}
					const delay = Number(url.searchParams.get("delayNextRangeMs") ?? 0);
					if (!Number.isSafeInteger(delay) || delay < 0 || delay > 10_000) {
						response.statusCode = 400;
						response.end();
						return;
					}
					delayNextRangeMs = delay;
					holdNextRange = url.searchParams.get("holdNextRange") === "true";
					delayIssued = false;
					metrics.rangeRequests = 0;
					metrics.delayRangeStarted = false;
					metrics.delayRangeFinished = false;
					metrics.delayRangeCancelled = false;
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ configured: true }));
					return;
				}
				if (url.pathname === METRICS_PATH) {
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify(metrics));
					return;
				}
				if (url.pathname !== FIXTURE_PATH) {
					next();
					return;
				}
				servePdfRange(request.headers.range, request.method, response, pdf, metrics, {
					get delayMs() {
						if (holdNextRange && !delayIssued) {
							delayIssued = true;
							return -1;
						}
						if (delayNextRangeMs === 0 || delayIssued) return 0;
						delayIssued = true;
						return delayNextRangeMs;
					},
					setRelease(release) {
						releaseHeldRange = release;
					},
					clearRelease(release) {
						if (releaseHeldRange === release) releaseHeldRange = null;
					},
				});
			});
		},
	};
}

function servePdfRange(
	rangeHeader: string | undefined,
	method: string | undefined,
	response: ServerResponse,
	pdf: Buffer,
	metrics: FixtureMetrics,
	delay: RangeDelayControl,
): void {
	response.setHeader("Content-Type", "application/pdf");
	response.setHeader("Accept-Ranges", "bytes");
	response.setHeader("ETag", '"render-priority-fixture-v1"');
	response.setHeader("Cache-Control", "no-store");
	if (rangeHeader === undefined) {
		response.statusCode = 200;
		response.setHeader("Content-Length", pdf.byteLength);
		response.end(method === "HEAD" ? undefined : pdf);
		return;
	}

	const range = parseByteRange(rangeHeader, pdf.byteLength);
	if (range === null) {
		response.statusCode = 416;
		response.setHeader("Content-Range", `bytes */${pdf.byteLength}`);
		response.end();
		return;
	}

	metrics.rangeRequests += 1;
	const body = pdf.subarray(range.start, range.end + 1);
	response.statusCode = 206;
	response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${pdf.byteLength}`);
	response.setHeader("Content-Length", body.byteLength);
	const delayMs = delay.delayMs;
	const send = function sendRangeResponse(): void {
		if (response.destroyed) return;
		response.end(body);
		if (delayMs !== 0) metrics.delayRangeFinished = true;
	};
	if (delayMs === 0) {
		send();
		return;
	}

	metrics.delayRangeStarted = true;
	if (delayMs < 0) {
		delay.setRelease(send);
		response.once("close", function cancelClosedHeldRange(): void {
			if (response.writableEnded) return;
			delay.clearRelease(send);
			metrics.delayRangeCancelled = true;
		});
		return;
	}
	const timer = setTimeout(send, delayMs);
	response.once("close", function cancelClosedRangeResponse(): void {
		if (response.writableEnded) return;
		clearTimeout(timer);
		metrics.delayRangeCancelled = true;
	});
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
