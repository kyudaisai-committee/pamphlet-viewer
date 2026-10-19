# Pamphlet Viewer

`@embedpdf/pdfium`（EmbedPDF）を使ってPDFを表示する、Svelte 5製のWeb Componentです。ES moduleとして配布し、Svelte以外のHTMLページにも埋め込めます。PDFはHTTP Rangeで必要な範囲を取得します。

## 開発とビルド

```sh
pnpm dev
pnpm build:library
pnpm verify
```

`pnpm build:library`は`dist/library/`に配布用ES module、型定義、PDFium WorkerとWASMを出力します。WorkerとWASMは別ファイルなので、`dist/library/`の構成を保って同じ配信先へ配置してください。ビルド時に外部CDNからWorkerやWASMを取得しません。`pnpm build`はデモとライブラリの両方をビルドします。

package exportsは`dist/library/pamphlet-viewer.js`と`dist/library/pamphlet-viewer.d.ts`を指します。リポジトリのpackageはprivateのままで、npm公開は行いません。

## GitHub Releases

リリース対象の変更を含むPull Requestでは、`pnpm changeset`を実行して変更内容と`patch`・`minor`・`major`のいずれかを選び、生成された`.changeset/`のファイルをコミットしてください。`main`へのマージ後にGitHub Actionsがバージョン更新Pull Requestを作成します。そのPull Requestをマージすると、既存CIを再利用して検査とビルドを行い、ビルド済みのライブラリからGitHub Releaseを作成します。タグは`v<version>`、リリースノートはGitHubが生成します。

初回のminor変更はalphaとして出し、バージョンを`0.1.0-alpha.0`にします。`0.0.0`の間はReleaseを作成しません。alpha版を継続する間はChangesetsのpre modeを維持し、安定版へ移行するときは`pnpm exec changeset pre exit`で終了してから、生成されたバージョン更新Pull Requestをマージしてください。

バージョン更新Pull Requestの作成には、リポジトリ設定の **Settings → Actions → General → Workflow permissions** で **Allow GitHub Actions to create and approve pull requests** を有効にしてください。

GitHub Releaseの`pamphlet-viewer-<version>.tgz`をダウンロードして展開すると、`dist/library/`の中身がアーカイブのルートにあります。JavaScript、型定義、Worker、WASM、chunks、assetsを相対構造のまま同じ配信先へ配置してください。パッケージはprivateのままなので、npmからはインストールできません。

## HTMLへの埋め込み

```html
<script type="module">
    import { registerPamphletViewer } from "/assets/pamphlet-viewer.js";

    registerPamphletViewer();
</script>

<pamphlet-viewer
    src="./documents/catalog.pdf"
    page="1"
    layout="auto"
    fit="page"
    style="display: block; width: 100%; height: 70vh; min-height: 22rem"
></pamphlet-viewer>
```

`registerPamphletViewer()`は登録済みの要素を再登録しません。ブラウザーでentryを読み込むと自動登録も行われます。ホスト要素に表示領域の高さを指定してください。

## 属性とプロパティ

| 名前     | 初期値 | 説明                                                   |
| -------- | ------ | ------------------------------------------------------ |
| `src`    | 空     | PDFのURL。空でない値を指定すると読み込みます。         |
| `page`   | `1`    | 現在ページ。UIとプロパティは1始まりです。              |
| `layout` | `auto` | `single`、`spread`、`auto`のいずれかです。             |
| `fit`    | `page` | `page`または`width`で表示サイズを合わせます。          |
| `config` | なし   | 章一覧などの設定オブジェクト。プロパティで指定します。 |

`src`の相対URLは、要素の`ownerDocument.baseURI`（`<base>`を含む）を基準に解決します。`getAttribute("src")`は指定された文字列を返し、`element.src`は絶対URLを返します。`element.src = "./catalog.pdf"`と`setAttribute("src", "./catalog.pdf")`は、どちらも読み込む文書を切り替えます。`src`を省略した場合、空属性は自動で追加されません。

`layout="auto"`は、サムネイル一覧の幅を除いた紙面表示領域の有効幅が約760px以上なら見開き、それより狭ければ単ページにします。判定はブラウザーウィンドウではなく、ホスト内の紙面表示領域の幅を使います。見開きの先頭ページは表紙として単独で表示し、2ページ目以降を左右に並べます。これはページめくりアニメーションではありません。

ページ一覧ボタンでサムネイルを開き、ページを選んで移動できます。サムネイルは一覧全体を一度に描画せず、表示範囲のページを必要に応じて作成します。狭いホストでは一覧が表示領域を使い、選択後に本文表示へ戻ります。ズームは10%から800%まで変更でき、拡大中はドラッグで紙面を移動できます。タッチ画面では2本指で拡大縮小できます。CtrlまたはMetaキーを押しながらホイールを操作しても拡大縮小します。通常のホイール操作は紙面をスクロールします。

## 章とブックマーク

`config`プロパティへ型付き設定オブジェクトを渡すと、章の一覧を表示して開始ページへ移動できます。`chapters`のページ番号は1始まりです。章の設定順にかかわらずページ順に並び、文書のページ数を外れる項目や不正な項目は表示しません。

```ts
import type { PamphletViewerConfig, PamphletViewerElement } from "/assets/pamphlet-viewer.js";

const viewer = document.querySelector("pamphlet-viewer") as PamphletViewerElement | null;
const config: PamphletViewerConfig = {
    chapters: [
        { title: "ご利用案内", page: 1 },
        { title: "商品一覧", page: 8 },
    ],
};

if (viewer) viewer.config = config;
```

ブックマークボタンで現在のページを追加・解除でき、保存済みページの一覧から移動できます。ブックマークは文書の解決済みURLごとに`localStorage`へ保存され、同じブラウザーで再度開いたときにも復元します。保存領域を利用できない場合は、その閲覧中はメモリ上で操作できます。

全画面ボタンはブラウザーのFullscreen APIを使います。利用できない場合はPopover APIによる画面拡大表示へ切り替え、Popoverに対応しない環境では固定表示を使います。Escapeキーで元の埋め込みサイズへ戻れます。埋め込み時と全画面時でホスト幅に合わせてページ配置を切り替えます。左右矢印またはPageUp/PageDownは、前後移動ボタンにフォーカスがあるときに使えます。

## イベント

イベントは`bubbles: true`、`composed: true`で発火します。

| イベント       | `detail`                                   | 発火時点                                                                                                                  |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `ready`        | `undefined`                                | UIの接続が完了したとき。                                                                                                  |
| `documentload` | `{ pageCount: number }`                    | 文書のページ数が分かり、表示準備ができたとき。PDF全体の受信完了を意味しません。                                           |
| `pagechange`   | `{ page: number; visiblePages: number[] }` | 表示ページが変わり、その描画が完了したとき。同じページのズームやリサイズによる再描画では発火しません。番号は1始まりです。 |
| `error`        | `{ code; message; retryable }`             | URL、Range応答、PDF処理、ページ指定などで失敗したとき。                                                                   |

`error`の`code`は`invalid-source`、`invalid-option`、`load-failed`、`invalid-page`、`render-failed`のいずれかです。`retryable`は再試行操作が利用できるかを示します。

```js
const viewer = document.querySelector("pamphlet-viewer");

viewer?.addEventListener("documentload", (event) => {
    console.log(`${event.detail.pageCount} pages`);
});

viewer?.addEventListener("pagechange", (event) => {
    console.log(event.detail.visiblePages);
});
```

## ページ入力方式の拡張

`backend`はHTML属性ではなく要素のプロパティです。`DocumentBackend`は`open(source, signal)`から`PageSource`を返し、`PageSource`は`pageCount`、`getPageSize(pageIndex)`、`renderPage(pageIndex, scale)`、`dispose()`を提供します。`PageVisual`はRGBA pixel bufferまたは`ImageBitmap`です。表示状態とレイアウトはこの契約に依存し、PDFium固有の処理はPDF backendに閉じています。

`PamphletViewerElement.backend`へ独自backendを設定し、そのbackendが解釈する値を`src`へ指定できます。現在用意しているbackendはPDFiumのみです。画像URLやページ画像一覧を読むbackendは、同じ契約を使って後から追加できます。

`DocumentBackend.open()`へ渡す`source`は、ホスト文書の`baseURI`で解決済みの絶対URLです。ページ内容はCanvasで表示し、PDFテキストの選択・検索・文書構造に基づく読み上げには対応していません。ツールバーのARIAラベルやキーボード操作は、PDF本文のアクセシビリティを提供するものではありません。

## PDFとアセットの配信条件

PDFサーバーはRange要求に対して正しい`Content-Range`を伴う`206 Partial Content`を返してください。`Accept-Ranges: bytes`だけでは不十分です。Rangeを無視した`200 OK`、`416 Range Not Satisfiable`、不正な`Content-Range`、通信timeoutはエラーになり、PDF全体を取得するfallbackは行いません。Rangeを理解し、PDFのbyte位置とvalidatorを一貫させるようCDNや圧縮設定を確認してください。

別originのPDFを使う場合は、CORSで`Range`と`If-Range`要求ヘッダーを許可し、`Content-Range`、`ETag`、`Last-Modified`応答ヘッダーを公開してください。`ETag`または`Last-Modified`を使うと、範囲の要求に`If-Range`を付けて同一PDF表現か確認します。

HTMLページ、ES module、Worker、WASMを別originから配信する場合、モジュールとWorker/WASMの応答に正しいMIME typeとCORSヘッダーを設定してください。異なるoriginのWorkerはBlob bootstrapからWorker moduleを読み込みます。その構成ではCSPの`worker-src`に`blob:`を許可してください。同一originのWorkerではBlob bootstrapを使いません。

## 現在の上限

- PDFのbyte位置は32-bitのため、ファイルサイズは4GiB未満です。
- Rangeは256KiB単位で取得し、同時要求は最大4件、読み込みcacheは最大64MiBです。各要求は30秒でtimeoutします。
- 1ページの描画出力は最大8,388,608 pixel（約32MiB）です。ズーム倍率は最大800%です。

これらの制限を超える文書はエラーになることがあります。大きなPDFへの対応は無制限ではなく、代表的な文書と配信環境でページ数、メモリ、初回表示時間を測定して判断してください。
