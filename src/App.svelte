<!-- SPDX-License-Identifier: MIT -->

<script lang="ts">
	import "./lib/entry";

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
		content="HTTP Range対応のPDFを読むWeb Component形式のパンフレットビューアー"
	/>
</svelte:head>

<main>
	<header class="demo-header">
		<h1>Pamphlet Viewer</h1>
		<form class="source-form" onsubmit={loadSource}>
			<label class="visually-hidden" for="pdf-url">PDF URL</label>
			<div class="source-input-row">
				<input
					id="pdf-url"
					bind:value={input}
					placeholder="https://example.com/brochure.pdf"
					inputmode="url"
					autocomplete="url"
					aria-describedby="source-hint"
				/>
				<button type="submit">表示</button>
			</div>
			<span id="source-hint">Range対応PDF</span>
		</form>
	</header>

	<pamphlet-viewer
		src={source}
		page={1}
		layout="auto"
		fit="page"
		class="viewer"
	></pamphlet-viewer>
</main>

<style>
	:global(*) {
		box-sizing: border-box;
	}

	:global(body) {
		min-width: 320px;
		min-height: 100vh;
		margin: 0;
		background: #111416;
		color: #e4e7e9;
		font: 14px/1.5 system-ui, sans-serif;
	}

	main {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: min(1440px, 100%);
		min-height: 100dvh;
		margin-inline: auto;
		padding: 8px;
		container-name: demo-page;
		container-type: inline-size;

		.demo-header {
			display: grid;
			grid-template-columns: auto minmax(240px, 560px);
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			min-height: 44px;

			h1 {
				margin: 0;
				font-size: 16px;
				font-weight: 600;
			}

			.source-form {
				display: grid;
				grid-template-columns: minmax(0, 1fr);
				gap: 3px;
				min-width: 0;

				.visually-hidden {
					position: absolute;
					width: 1px;
					height: 1px;
					padding: 0;
					margin: -1px;
					overflow: hidden;
					clip: rect(0, 0, 0, 0);
					white-space: nowrap;
					border: 0;
				}

				.source-input-row {
					display: flex;
					gap: 6px;

					input {
						box-sizing: border-box;
						flex: 1 1 auto;
						min-width: 0;
						min-height: 38px;
						padding: 7px 10px;
						border: 1px solid #3b4148;
						border-radius: 4px;
						background: #191c20;
						color: inherit;
						font: inherit;

						&:focus-visible {
							outline: 2px solid #a8c5bc;
							outline-offset: 1px;
						}
					}

					button {
						min-width: 60px;
						min-height: 38px;
						padding: 6px 12px;
						border: 1px solid #454b52;
						border-radius: 4px;
						background: #30363c;
						color: inherit;
						font: inherit;
						cursor: pointer;

						@media (hover: hover) {
							&:hover {
								background: #3a4245;
							}
						}

						&:focus-visible {
							outline: 2px solid #a8c5bc;
							outline-offset: 1px;
						}
					}
				}

				#source-hint {
					color: #9ba2aa;
					font-size: 11px;
				}
			}
		}

		.viewer {
			flex: 1 1 auto;
			height: calc(100dvh - 84px);
			min-height: 22rem;
		}

		@container demo-page (max-width: 680px) {
			.demo-header {
				grid-template-columns: minmax(0, 1fr);
				gap: 6px;
				padding-block: 2px;
			}

			.viewer {
				height: 68dvh;
				min-height: 22rem;
			}
		}
	}
</style>
