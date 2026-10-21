---
"@kyudaisai/pamphlet-viewer": patch
---

PDFの連続した必要範囲を最大1MiBのRange要求にまとめ、読み込み時のHTTP要求数を削減しました。
初回PDF取得とPDFiumのWASM初期化を並行して開始し、並列応答と読み込み中止時の状態管理も改善しました。
