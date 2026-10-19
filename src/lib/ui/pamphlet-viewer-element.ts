export function extendViewerElement(Base: typeof HTMLElement): typeof HTMLElement {
	return class PamphletViewerHost extends Base {
		constructor() {
			super();
			upgradeProperty(this, "src");
			upgradeProperty(this, "page");
			upgradeProperty(this, "layout");
			upgradeProperty(this, "fit");
			upgradeProperty(this, "backend");
			upgradeProperty(this, "config");
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
	};
}

function upgradeProperty(element: HTMLElement, name: string): void {
	if (!Object.hasOwn(element, name)) return;
	const value = Reflect.get(element, name);
	Reflect.deleteProperty(element, name);
	Reflect.set(element, name, value);
}
