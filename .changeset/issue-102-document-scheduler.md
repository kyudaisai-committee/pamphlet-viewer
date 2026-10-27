---
"@kyudaisai/pamphlet-viewer": patch
---

PDFiumのページ処理に優先順位付きschedulerを追加し、文書セッション内でRange取得をWorker間共有します。表示への切替時に先読み結果を引き継ぎ、先読み画像cacheを128 MiBに拡張します。
