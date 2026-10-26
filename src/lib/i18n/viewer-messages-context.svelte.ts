// SPDX-License-Identifier: MIT
import { getContext, setContext } from "svelte";

import type { ViewerMessages } from "./viewer-messages";

const VIEWER_MESSAGES_CONTEXT = Symbol("viewer messages");

export function provideViewerMessages(messages: ViewerMessages): void {
	setContext(VIEWER_MESSAGES_CONTEXT, messages);
}

export function useViewerMessages(): ViewerMessages {
	const messages = getContext<ViewerMessages>(VIEWER_MESSAGES_CONTEXT);
	if (messages === undefined) throw new Error("Viewer messages context is unavailable.");
	return messages;
}
