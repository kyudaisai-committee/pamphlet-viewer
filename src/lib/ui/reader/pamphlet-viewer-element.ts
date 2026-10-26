// SPDX-License-Identifier: MIT

import type { PamphletViewerConfig } from "@/lib/public-api";

import { setViewerElementConfig } from "./viewer-element-config";

export function extendViewerElement(Base: typeof HTMLElement): typeof HTMLElement {
	return class PamphletViewerHost extends Base {
		constructor() {
			super();
			upgradeProperty(this, "src");
			upgradeProperty(this, "page");
			upgradeProperty(this, "layout");
			upgradeProperty(this, "fit");
			upgradeProperty(this, "backend");
		}

		get src(): string {
			const source = this.getAttribute("src");
			if (source === null) return "";
			try {
				return new URL(source, this.ownerDocument.baseURI).href;
			} catch {
				return source;
			}
		}

		set src(value: string) {
			this.setAttribute("src", value);
		}

		setConfig(config: PamphletViewerConfig): void {
			setViewerElementConfig(this, config);
		}
	};
}

function upgradeProperty(element: HTMLElement, name: string): void {
	if (!Object.hasOwn(element, name)) return;
	const value = Reflect.get(element, name);
	Reflect.deleteProperty(element, name);
	Reflect.set(element, name, value);
}
