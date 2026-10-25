---
"@kyudaisai/pamphlet-viewer": patch
---

PDFiumの範囲読み込みのコールバックで位置を符号なし値に正規化し、2GiB以降のデータも読み込めるようにします。
