// SPDX-License-Identifier: MIT

const FIXTURE_PATH = "/__pdfium-range-fixture.pdf";

export function createLibraryTestHtml(requestUrl = "/"): string {
	if (new URL(requestUrl, "http://localhost").searchParams.get("mode") === "public-error") {
		return createPublicErrorContractHtml();
	}
	return `<!doctype html>
<html lang="ja">
	<head>
		<meta charset="utf-8">
		<title>Custom Element distribution test</title>
	</head>
	<body>
		<pamphlet-viewer id="viewer" src="${FIXTURE_PATH}" layout="single" style="display:block;width:840px;height:560px"></pamphlet-viewer>
		<script>
			document.addEventListener("pagechange", (event) => {
				parent.postMessage({ type: "pagechange", detail: event.detail }, location.origin);
			});
			document.addEventListener("error", (event) => {
				parent.postMessage({ type: "error", detail: event.detail }, location.origin);
			});
		</script>
		<script type="module" src="/dist/library/pamphlet-viewer.js?load=first"></script>
		<script type="module">
			import { registerPamphletViewer } from "/dist/library/pamphlet-viewer.js?load=duplicate";
			registerPamphletViewer();
			parent.postMessage(
				{ type: "registration", registered: typeof registerPamphletViewer === "function" },
				location.origin,
			);
		</script>
	</body>
</html>`;
}

function createPublicErrorContractHtml(): string {
	return `<!doctype html>
<html lang="ja">
	<head><meta charset="utf-8"><title>Public error contract</title></head>
	<body>
		<pamphlet-viewer id="viewer" layout="single" style="display:block;width:390px;height:620px"></pamphlet-viewer>
		<script type="module">
			try {
				const api = await import("/dist/library/pamphlet-viewer.js?public-error-contract");
				api.registerPamphletViewer();
				const viewer = document.getElementById("viewer");
				let openCount = 0;
				let renderCount = 0;
				let successfulRenderCount = 0;
				viewer.addEventListener("pagechange", () => {
					parent.postMessage({ type: "pagechange" }, location.origin);
				});
				viewer.addEventListener("error", (event) => {
					parent.postMessage({
						type: "error",
						code: event.detail.code,
						retryable: event.detail.retryable,
					}, location.origin);
				});
				viewer.backend = {
					async open() {
						openCount += 1;
						viewer.dataset.openCount = String(openCount);
						const sourceNumber = openCount;
						return {
							pageCount: 2,
							async getPageSize() { return { width: 300, height: 400 }; },
							async renderPage(_pageIndex, scale) {
								renderCount += 1;
								viewer.dataset.renderCount = String(renderCount);
								viewer.dataset.lastRenderScale = String(scale);
								if (
									sourceNumber === 1 &&
									viewer.dataset.failThumbnailNextRender === "true" &&
									scale < 0.7
								) {
									delete viewer.dataset.failThumbnailNextRender;
									throw new api.PageSourceUnavailableError("The thumbnail worker stopped.");
								}
								successfulRenderCount += 1;
								viewer.dataset.successfulRenderCount = String(successfulRenderCount);
								return {
									type: "pixels",
									width: 2,
									height: 2,
									pixels: new Uint8Array([40, 90, 130, 255, 40, 90, 130, 255, 40, 90, 130, 255, 40, 90, 130, 255]).buffer,
								};
							},
							dispose() {},
						};
					},
				};
				viewer.src = "/__public-error-contract.pdf";
				parent.postMessage({
					type: "setup",
					exported: typeof api.PageSourceUnavailableError === "function",
				}, location.origin);
			} catch (error) {
				parent.postMessage({ type: "setup", exported: false, error: String(error) }, location.origin);
			}
		</script>
	</body>
</html>`;
}

export function createRemoteLibraryTestHtml(entryUrl: string, pdfUrl: string): string {
	return `<!doctype html>
<html lang="ja">
	<head><meta charset="utf-8"><title>Remote library test</title></head>
	<body>
		<pamphlet-viewer id="viewer" style="display:block;width:840px;height:560px"></pamphlet-viewer>
		<script>
			document.addEventListener("pagechange", (event) => {
				parent.postMessage({ type: "pagechange", detail: event.detail }, location.origin);
			});
			document.addEventListener("error", (event) => {
				parent.postMessage({ type: "error", detail: event.detail }, location.origin);
			});
		</script>
		<script type="module">
			try {
				const module = await import(${JSON.stringify(entryUrl)});
				module.registerPamphletViewer();
				document.getElementById("viewer").src = ${JSON.stringify(pdfUrl)};
			} catch (error) {
				parent.postMessage({ type: "error", detail: String(error) }, location.origin);
			}
		</script>
	</body>
</html>`;
}
