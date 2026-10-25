// SPDX-License-Identifier: MPL-2.0

import { expect, it } from "vitest";

import type { PamphletViewerConfig } from "@/lib/public-api";

import { setViewerElementConfig, subscribeViewerElementConfig } from "./viewer-element-config";

it("stores replacement config per host and stops notifying after unsubscribe", () => {
	const firstHost = {};
	const secondHost = {};
	const firstUpdates: PamphletViewerConfig[] = [];
	const secondUpdates: PamphletViewerConfig[] = [];
	const unsubscribe = subscribeViewerElementConfig(firstHost, (config) => {
		firstUpdates.push(config);
	});
	subscribeViewerElementConfig(secondHost, (config) => {
		secondUpdates.push(config);
	});

	expect(firstUpdates).toEqual([{}]);
	expect(secondUpdates).toEqual([{}]);

	const firstConfig = { chapters: [{ title: "前半", page: 1 }] };
	setViewerElementConfig(firstHost, firstConfig);
	expect(firstUpdates).toEqual([{}, firstConfig]);
	expect(secondUpdates).toEqual([{}]);

	const replacement = { chapters: [{ title: "後半", page: 4 }] };
	setViewerElementConfig(firstHost, replacement);
	expect(firstUpdates).toEqual([{}, firstConfig, replacement]);

	unsubscribe();
	setViewerElementConfig(firstHost, {});
	expect(firstUpdates).toEqual([{}, firstConfig, replacement]);
});
