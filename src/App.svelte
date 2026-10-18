<script lang="ts">
	import "@/lib/entry";

	function readSourceFromQuery(): string {
		return new URLSearchParams(window.location.search).get("src") ?? "";
	}

	let source = $state(readSourceFromQuery());
	let input = $state(readSourceFromQuery());

	function loadSource(event: SubmitEvent): void {
		event.preventDefault();
		source = input.trim();
	}
</script>

<svelte:head>
	<title>Pamphlet Viewer</title>
	<meta
		name="description"
		content="HTTP Range対応のPDFを読み込むWeb Component形式のパンフレットビューアー"
	/>
</svelte:head>

<main>
	<header class="page-header">
		<div>
			<p class="eyebrow">WEB COMPONENT DEMO</p>
			<h1>Pamphlet Viewer</h1>
			<p class="intro">PDFのURLを入力して、ページ表示を確認できます。</p>
		</div>
		<a href="https://github.com/embedpdf/embed-pdf-viewer" target="_blank" rel="noreferrer">
			EmbedPDF
		</a>
	</header>

	<form class="source-form" onsubmit={loadSource}>
		<label for="pdf-url">PDF URL</label>
		<div class="source-input-row">
			<input
				id="pdf-url"
				bind:value={input}
				placeholder="https://example.com/brochure.pdf"
				inputmode="url"
				autocomplete="url"
			/>
			<button type="submit">表示</button>
		</div>
		<p>Range requests に対応した PDF の URL を指定してください。</p>
	</form>

	<pamphlet-viewer
		src={source}
		page={1}
		layout="auto"
		fit="page"
		class="viewer"
	></pamphlet-viewer>

	<footer>
		<span>Web Component の動作確認用デモ</span>
		<code>&lt;pamphlet-viewer src="…"&gt;</code>
	</footer>
</main>

<style>
	:global(*) {
		box-sizing: border-box;
	}

	:global(body) {
		margin: 0;
		background: #f4f6fa;
		color: #172033;
		font: 15px/1.5 system-ui, sans-serif;
	}

	main {
		width: min(1120px, 100% - 32px);
		margin: 0 auto;
		padding: 36px 0 24px;

		.page-header {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 24px;
			margin-bottom: 26px;

			div {
				.eyebrow {
					margin: 0 0 7px;
					color: #53688e;
					font-size: 11px;
					font-weight: 700;
					letter-spacing: 0.12em;
				}

				h1 {
					margin: 0;
					font-size: clamp(26px, 4vw, 36px);
					letter-spacing: -0.04em;
				}

				.intro {
					margin: 8px 0 0;
					color: #647087;
				}
			}

			a {
				margin-top: 8px;
				color: #3157a4;
				font-weight: 600;
				text-decoration: none;

				&:hover {
					text-decoration: underline;
				}
			}
		}

		.source-form {
			margin-bottom: 14px;
			padding: 16px;
			border: 1px solid #dce1ea;
			border-radius: 12px;
			background: #fff;

			label {
				display: block;
				margin-bottom: 7px;
				font-size: 13px;
				font-weight: 650;
			}

			.source-input-row {
				display: flex;
				gap: 8px;

				input {
					flex: 1 1 auto;
					min-width: 0;
					min-height: 42px;
					padding: 9px 11px;
					border: 1px solid #cbd3e0;
					border-radius: 8px;
					background: #fff;
					color: inherit;
					font: inherit;
				}

				button {
					min-width: 72px;
					min-height: 42px;
					padding: 8px 16px;
					border: 0;
					border-radius: 8px;
					background: #3157a4;
					color: #fff;
					font: inherit;
					font-weight: 650;
					cursor: pointer;

					&:hover {
						background: #244889;
					}
				}
			}

			p {
				margin: 8px 0 0;
				color: #68758b;
				font-size: 12px;
			}
		}

		.viewer {
			height: min(70vh, 760px);
			min-height: 380px;
		}

		footer {
			display: flex;
			justify-content: space-between;
			gap: 12px;
			padding: 12px 2px;
			color: #68758b;
			font-size: 12px;

			code {
				color: #3d4e6a;
			}
		}

		@media (max-width: 600px) {
			width: min(100% - 20px, 1120px);
			padding-top: 20px;

			.page-header {
				margin-bottom: 18px;
			}

			.viewer {
				height: 68vh;
				min-height: 360px;
			}

			footer {
				flex-direction: column;
			}
		}
	}
</style>
