// SPDX-License-Identifier: MIT

import type { PamphletChapter } from "@/lib/public-api";

export function resolveChapters(config: unknown, pageCount: number): PamphletChapter[] {
	if (!isRecord(config) || !Array.isArray(config.chapters) || !Number.isSafeInteger(pageCount)) {
		return [];
	}

	const chapters: PamphletChapter[] = [];
	const usedPages = new Set<number>();
	for (const candidate of config.chapters) {
		if (!isRecord(candidate)) continue;
		const title = candidate.title;
		const page = candidate.page;
		if (
			typeof title !== "string" ||
			title.trim().length === 0 ||
			typeof page !== "number" ||
			!Number.isSafeInteger(page) ||
			page < 1 ||
			page > pageCount ||
			usedPages.has(page)
		) {
			continue;
		}
		usedPages.add(page);
		chapters.push({ title: title.trim(), page });
	}

	return chapters.sort((left, right) => left.page - right.page);
}

export function findCurrentChapter(
	chapters: readonly PamphletChapter[],
	page: number,
): PamphletChapter | undefined {
	return chapters.findLast((chapter) => chapter.page <= page);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
