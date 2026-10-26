// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { parseFit, parseLayout, resolveDocumentSource } from "./viewer-options";

describe("resolveDocumentSource", () => {
	it("resolves relative URLs against the supplied base", () => {
		expect(
			resolveDocumentSource("../brochure.pdf", "https://example.test/catalog/index.html"),
		).toBe("https://example.test/brochure.pdf");
	});

	it("rejects values that cannot be resolved", () => {
		expect(resolveDocumentSource("brochure.pdf", "not a URL")).toBeNull();
	});
});

describe("viewer option parsers", () => {
	it("accept only supported layout and fit values", () => {
		expect(parseLayout("spread")).toBe("spread");
		expect(parseLayout("poster")).toBeNull();
		expect(parseFit("width")).toBe("width");
		expect(parseFit("height")).toBeNull();
	});
});
