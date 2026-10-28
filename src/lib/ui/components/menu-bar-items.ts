// SPDX-License-Identifier: MIT

import type { Snippet } from "svelte";

export type MenuBarItem =
	| { readonly id: string; readonly kind: "snippet"; readonly content: Snippet }
	| { readonly id: string; readonly kind: "spacer" };
