// SPDX-License-Identifier: MIT

import type { PageTaskPriority } from "@/lib/domain/scheduling/page-task-scheduler";

import type { PdfRangeResponse } from "./range-request";

export interface RangeTransportRequest {
	readonly url: string;
	readonly start: number;
	readonly requestedEnd: number;
	readonly totalLength: number | null;
	readonly etag: string | null;
	readonly lastModified: string | null;
	readonly priority: PageTaskPriority;
}

export interface RangeTransportResponse extends Omit<PdfRangeResponse, "bytes"> {
	readonly bytes: ArrayBuffer;
}

export interface RangeWorkerRequest {
	readonly type: "range-request";
	readonly id: number;
	readonly request: RangeTransportRequest;
}

export interface RangeWorkerCancelRequest {
	readonly type: "range-cancel";
	readonly id: number;
}

export interface RangeWorkerResponse {
	readonly type: "range-response";
	readonly id: number;
	readonly response?: RangeTransportResponse;
	readonly error?: string;
	readonly fatal?: boolean;
}

export interface RangeWorkerRequester {
	(request: RangeTransportRequest, signal: AbortSignal): Promise<PdfRangeResponse>;
}
