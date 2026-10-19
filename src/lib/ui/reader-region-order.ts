type ReaderRegion = "settings" | "body" | "status" | "navigation";

const MOBILE_READER_REGION_ORDER = ["settings", "body", "status", "navigation"] as const;
const DESKTOP_READER_REGION_ORDER = ["navigation", "settings", "body", "status"] as const;

export function observeResponsiveReaderOrder(shell: HTMLElement): () => void {
	let compact: boolean | null = null;

	function updateOrder(): void {
		const nextCompact = shell.clientWidth <= 700;
		if (compact === nextCompact) return;
		const order = nextCompact ? MOBILE_READER_REGION_ORDER : DESKTOP_READER_REGION_ORDER;
		const regions: Record<ReaderRegion, HTMLElement | undefined> = {
			settings: undefined,
			body: undefined,
			status: undefined,
			navigation: undefined,
		};
		for (const child of shell.children) {
			if (!(child instanceof HTMLElement)) continue;
			const region = child.dataset.readerRegion;
			if (
				region === "settings" ||
				region === "body" ||
				region === "status" ||
				region === "navigation"
			) {
				regions[region] = child;
			}
		}
		if (Object.values(regions).some((region) => region === undefined)) return;

		const root = shell.getRootNode();
		const focused =
			root instanceof ShadowRoot ? root.activeElement : shell.ownerDocument.activeElement;
		const restoreFocus = focused instanceof HTMLElement && shell.contains(focused);
		for (const [index, regionName] of order.entries()) {
			const region = regions[regionName];
			const reference = shell.children[index] ?? null;
			if (region === undefined || region === reference) continue;
			moveReaderRegionBefore(shell, region, reference);
		}
		compact = nextCompact;
		const activeAfterMove =
			root instanceof ShadowRoot ? root.activeElement : shell.ownerDocument.activeElement;
		if (restoreFocus && activeAfterMove !== focused) {
			focused.focus({ preventScroll: true });
		}
	}

	const resizeObserver = new ResizeObserver(updateOrder);
	resizeObserver.observe(shell);
	updateOrder();
	return () => resizeObserver.disconnect();
}

function moveReaderRegionBefore(
	shell: HTMLElement,
	region: HTMLElement,
	reference: Element | null,
): void {
	if (typeof shell.moveBefore === "function") {
		try {
			shell.moveBefore(region, reference);
			return;
		} catch {
			// Browsers without same-parent moveBefore support use the focus-restoring fallback.
		}
	}
	shell.insertBefore(region, reference);
}
