# @kyudaisai/pamphlet-viewer

## 0.1.0-alpha.2

### Patch Changes

- bc09028: PDFの連続した必要範囲を最大1MiBのRange要求にまとめ、読み込み時のHTTP要求数を削減しました。
  初回PDF取得とPDFiumのWASM初期化を並行して開始し、並列応答と読み込み中止時の状態管理も改善しました。

## 0.1.0-alpha.1

### Patch Changes

- 21e32a9: 型付きの設定オブジェクトで章のタイトルと開始ページを指定し、章一覧から移動できるようにしました。
  文書URLごとにブックマークをlocalStorageへ保存・復元し、ページの追加・解除と保存ページへの移動に対応しました。

## 0.1.0-alpha.0

### Minor Changes

- c2e1f2b: ライブラリの初回リリースを準備します。
