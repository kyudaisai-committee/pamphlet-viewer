---
"@kyudaisai/pamphlet-viewer": patch
---

初回Range要求がリダイレクトされた場合、検証済みの応答URLを後続要求に再利用します。
ページ寸法の取得ではPDFiumにページ本文を解析させず、描画時に必要なRange取得を減らします。
