import { expect, test } from "vitest";

import { getReaderRegionOrder, READER_TOOLBAR_LAYOUT } from "./reader-toolbar-layout";

test("defines left and right toolbar regions independently from their placement order", () => {
	expect(READER_TOOLBAR_LAYOUT.left).toEqual({ region: "navigation", side: "left" });
	expect(READER_TOOLBAR_LAYOUT.right).toEqual({ region: "settings", side: "right" });
	expect(getReaderRegionOrder(1120)).toEqual(["navigation", "settings", "body", "status"]);
	expect(getReaderRegionOrder(390)).toEqual(["settings", "body", "status", "navigation"]);
});

test.each([320, 700])("moves the left toolbar below the content at %i pixels", (width) => {
	expect(getReaderRegionOrder(width)).toEqual(["settings", "body", "status", "navigation"]);
});

test.each([701, 837, 840])(
	"keeps the right toolbar after the left toolbar at %i pixels",
	(width) => {
		expect(getReaderRegionOrder(width)).toEqual(["navigation", "settings", "body", "status"]);
	},
);
