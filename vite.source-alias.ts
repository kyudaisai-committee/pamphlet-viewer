// SPDX-License-Identifier: MPL-2.0

import { fileURLToPath } from "node:url";

export const sourceAlias = {
	"@": fileURLToPath(new URL("./src", import.meta.url)),
};
