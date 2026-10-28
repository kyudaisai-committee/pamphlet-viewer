// SPDX-License-Identifier: MIT

export const READER_TOOLBAR_LAYOUT = {
	left: { region: "navigation", side: "left" },
	right: { region: "settings", side: "right" },
} as const;

export type ReaderRegion = "settings" | "body" | "status" | "navigation";
export type ReaderToolbarLayout = typeof READER_TOOLBAR_LAYOUT;

export function getReaderRegionOrder(width: number): readonly ReaderRegion[] {
	if (width <= 700) {
		return [
			READER_TOOLBAR_LAYOUT.right.region,
			"body",
			"status",
			READER_TOOLBAR_LAYOUT.left.region,
		];
	}
	return [
		READER_TOOLBAR_LAYOUT.left.region,
		READER_TOOLBAR_LAYOUT.right.region,
		"body",
		"status",
	];
}
