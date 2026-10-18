const FIXTURE_PATH = "/__pdfium-range-fixture.pdf";

export function createLibraryTestHtml(): string {
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
