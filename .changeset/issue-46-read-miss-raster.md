---
"@kyudaisai/pamphlet-viewer": patch
---

PDFページの読み込み中にRange不足が分かった場合、不要なbitmap確保・描画・画素転送をスキップします。
