import { expect, test } from "vitest";

import { findCurrentChapter, resolveChapters } from "./viewer-config";

test("resolves ordered chapters and finds the chapter for a page", () => {
	const chapters = resolveChapters(
		{
			chapters: [
				{ title: "後半", page: 8 },
				{ title: " 前半 ", page: 2 },
			],
		},
		10,
	);

	expect(chapters).toEqual([
		{ title: "前半", page: 2 },
		{ title: "後半", page: 8 },
	]);
	expect(findCurrentChapter(chapters, 1)).toBeUndefined();
	expect(findCurrentChapter(chapters, 7)).toEqual({ title: "前半", page: 2 });
	expect(findCurrentChapter(chapters, 8)).toEqual({ title: "後半", page: 8 });
});

test("ignores malformed, duplicate, and out-of-range chapter entries", () => {
	expect(
		resolveChapters(
			{
				chapters: [
					{ title: "有効", page: 1 },
					{ title: "重複", page: 1 },
					{ title: "範囲外", page: 4 },
					{ title: "不正", page: 2.5 },
					{ title: "   ", page: 2 },
					null,
				],
			},
			3,
		),
	).toEqual([{ title: "有効", page: 1 }]);
	expect(resolveChapters({ chapters: "invalid" }, 3)).toEqual([]);
	expect(resolveChapters(null, 3)).toEqual([]);
});
