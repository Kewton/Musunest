# 記録の手直し（Issue #332）

`responses.json` は、2026-10-10 の疎通で本物の OpenAI が返した応答の記録である（第 0 段の「読書会」の題材）。
**設計の段（② `requirement-design`）の応答だけ**を、Issue #332 の新しい形に手で直した。ほかの段
（`requirement-list`・`reverse-check`・`test-suite`・`declaration`・`requirement-correspondence`・
`role-name-mappings`）の応答は**1 バイトも変えていない**。

## 直した箇所

設計の段の `designs` の各要件に、新しい欄 `notes`（空の並び）を足した。加えて、要件 R-1 の `unwritable`
を、文字列から「書けない部分（part）・制約 ID（constraintIds）・理由（reason）」の組に直した。

- 直す前：`"unwritable": ["アプリ自体の名前・説明"]`
- 直した後：
  ```json
  "unwritable": [
    {
      "part": "アプリ自体の名前・説明",
      "constraintIds": ["アプリの名前・説明"],
      "reason": "宣言には、アプリ自体の名前や説明を置く欄が無い。"
    }
  ]
  ```

## 直した理由

Issue #332 で、② の `unwritable` の要素を「書けない部分・**制約 ID**・理由」の組に変え、曖昧さ・決めた
こと・不確かさは `notes` に分けた。制約 ID は、段に渡した文書の本文から取った集合（契約の規則の `R-…` と、
語彙の意味の `### ` 見出し）に入っていなければ、`checkDesignConstraints` が断る。

この記録の再生（`run-replay.test.ts`）では、文書として試験の `SAMPLE_DOCUMENTS` を渡す。そのため、R-1 の
申告の根拠には、その文書にある語彙の意味の見出し「アプリの名前・説明」を使った（`SAMPLE_DOCUMENTS` の
「語彙の意味」に `### アプリの名前・説明` を置いてある）。R-1 の申告の中身（書けない部分）と、要件 R-1 の
文・引用は変えていない。

## 変えていないこと

- 設計の段の `roles`・要件ごとの `nature`・`verification`・`vocabulary`・`placement` は変えていない。
- ほかの段の応答は変えていない（`run-replay.test.ts` の SHA-256 の試験は、この手直しの後の**ファイル全体**の
  バイト列を固定する）。
