# 性質の台帳（写し）

> 状態：**手 2b**（2026-10-18・Issue #548。手 2a は 2026-10-17・Issue #547）。**正本はコード**（`packages/factory/src/v12/ledger.ts` の `PROPERTY_LEDGER`）で、この表は人が読む写しである。列の意味は `../../08-architecture-v1.2.md` §5。

## 1. 照らし方

- この表は**コードの台帳と 1 要素 1 行**で照らされる（`v12/ledger.test.ts`。D2）。行の欠け・余り・欄の食い違い（状態を含む）で試験が落ちる。**行を直すときはコードを直し、この表を写し直す**（表だけを直さない）
- 欄の中身はコードの `propertyCopyCells` が 1 行から組む文字列と同じ。並びは台帳の順（＝T2 の observes の enum の順）
- 旗 `v12.ledger`（既定 off）が on の走りだけ、T1・T1'・T1''・T2・T2'・B1・評価口（B4・B5 の道具・版の再検査）が台帳から導く。手 2a は**載せ替えだけ**で、on で組んだ規則の文・schema・データの並びは off とバイト列で同じだった
- 手 2b で `enum-membership`（選択肢の集合）の行を足し、T1''（R-sc-02 の末尾の受理条件）・B1（R-w11 の末尾）へも台帳の文を差し込む。on の要求と off の差はこの行の分（R-nt-08・R-sc-02・R-tsp-02・R-tsp-16 の文、R-w11-11、schema の enum）だけで、この行を除いた台帳の導出は off とバイト列で同じ。off は今の v1.1α とバイト列で同じ

## 2. 期待の値の書き手（§5 との段階の差）

- `llm-written-code-checked` … 手 2 の段階。T2 の LLM が期待の値を書き、コードが台帳の行から導いた値と T2' で厳密に照らす（違えば拒否）
- `code` … §5 の「値はコードだけで埋まる」。手 3（導ける欄のコード化）で入れる

## 3. 表（1 行 1 性質）

| id | 状態 | since | T1 の kind | T2 の形 | 期待の値の書き手 | B4 | 外の対応 | why |
|---|---|---|---|---|---|---|---|---|
| when | 有効（v1.1α から引き継ぎ・列の一部は未定義） | Issue #508（台帳への集約は #547） | — | 未定義（組：operation × action） | — | v1-run-tests | 未定義 | 操作の条件（when）を、操作 × action の試験の真偽で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3） |
| value | 有効（v1.1α から引き継ぎ・列の一部は未定義） | Issue #508（台帳への集約は #547） | — | 未定義（組：computation × compute・computation × aggregate） | — | v1-run-tests | 未定義 | 計算と集計の値を、計算 × compute・aggregate の試験で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3） |
| validation | 有効（v1.1α から引き継ぎ・列の一部は未定義） | Issue #508（台帳への集約は #547） | — | 未定義（組：field × validate・entity × validate） | — | v1-run-tests | 未定義 | 項目と entity の検査を、validate の試験で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3） |
| view-structure | 有効（v1.1α から引き継ぎ・列の一部は未定義） | Issue #508（台帳への集約は #547） | — | 未定義（組：screen × screen・field × screen） | — | v1-run-tests | 未定義 | 画面の構造を、画面・項目 × screen の試験で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3） |
| existence | 有効（v1.1α から引き継ぎ・列の一部は未定義） | Issue #508（台帳への集約は #547） | — | 未定義（組：entity × screen） | — | v1-run-tests | 未定義 | entity が在ることを、entity × screen の試験で確かめる（v1.1α の評価の方法の表。02 §1.3・07 §2.3） |
| state-after-set | 登録済み・未対応（v1.1α から引き継ぎ・列の一部は未定義） | Issue #508（台帳への集約は #547） | — | — | — | — | 未定義 | 操作に set を当てたあとの状態は評価の方法が無い（v1 は作ってから ⑤b で未解決にしていた。07 §2.3）。作れば T2' で落とす |
| default-value | 有効 | Issue #533（台帳への集約は #547） | default-value | field × validate・normal・期待 ok の json-string・入力 empty-record・参照データ 空・1 本以上 | llm-written-code-checked | default-value | enumDefault | 選択肢の項目の既定値だけを決める要件を、評価できる試験の形を試験より前に表で確定して確かめる（方法論 03 §1 の H2・H1。台帳 F5） |
| enum-membership | 有効 | Issue #548 | enum-membership | field × validate・normal・期待 ok の json-string-array・入力 empty-record・参照データ 空・1 本以上 | llm-written-code-checked | enum-membership | 外は見ない | 選択肢の項目の値が挙げた選択肢のどれかであることだけを決める要件を、表で確定した選択肢の集合と宣言の options の照合で確かめる（名前の一致に頼らない。08 §8.2 の (c)①・M-03） |

- 「有効（v1.1α から引き継ぎ・列の一部は未定義）」の行は、v1.1α の評価の方法の表の組を登録したもの。試験の型・網羅の鍵・外の対応は未定義で、今の検査のまま
- 「外の対応」の「未定義」は、対応をまだ決めていない欄（「外は見ない」とは別）
- `enum-membership` の期待の型は「options の並び」：T2 の LLM が対象の項目の表の options のキーを表の順に並べた並びを JSON で書き、T2' が長さ・順まで照らす。B4 は宣言の options のキーの集合と長さで照らす（順の違いは B3 の options の照合が落とす）。外の採点の labels は表示名の別の観測で同値ではないので「外は見ない」
