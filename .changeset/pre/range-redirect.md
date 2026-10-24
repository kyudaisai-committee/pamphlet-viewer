---
"@kyudaisai/pamphlet-viewer": patch
---

初回Range要求がリダイレクトされた場合、検証済みの応答URLを後続要求に再利用します。
ページ寸法の取得で本文を解析せず、サイズ照会時の不要なRange取得と重複解析を省きます。
