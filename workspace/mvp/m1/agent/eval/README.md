# 採点表 v5（#277）

> 状態：**凍結**（2026-10-09・窓口）。エージェントの結果を見る前に作り、凍結した。凍結の宣言は `03-evaluation.md` に書く。
> 設計の正本は `workspace/mvp/m1/agent/03-evaluation.md` §2・§4（PR #276）。

## 1. 形：汎用の採点エンジン ＋ 題材ごとの定義（データ）

| ファイル | 中身 |
|---|---|
| `engine.mjs` | エンジン。定義の役割を宣言に当てはめ（バックトラック）、判定の種類を引数で実行する。名前は見ない。振る舞いは spec-engine の評価器で確かめる |
| `subjects/<id>.json` | 題材の定義（データ）。**新しい題材は、このファイルを書くだけで採点できる** |
| `rubric-v5.mjs` | 入口。`node rubric-v5.mjs <spec-engine の dist/index.js> <id か定義のパス> <yaml>... [--json]` |
| `score-claims.mjs` | 申告の採点。**当てはまった構造ごと**に書けない要件の正解を読む。`finalVerdict` で宣言と合わせた最終の判定を出す |
| `cases/` | 決定①〜③の正例と負例（12 本）と期待（`cases.json`）。`node run-cases.mjs <dist>` |
| `regress.mjs` | v4 との回帰（79 本）。`node regress.mjs <dist>` |
| `rescore-baseline.mjs` | 基準線（第 5 段の 50 本）の採点し直し。`node rescore-baseline.mjs <dist> <stage5 の runs>` → `baseline-v5.json`・`baseline-v5.md` |

判定：`PASS`／`PASS_NEEDS_CLAIM`（別の構造。申告で決まる）／`FAIL`／`STATIC_NG`。最終の判定は `finalVerdict`（別の構造は、挙げ漏れが 0 のときだけ `PASS`）。

### 1.1 決定の入れ方

| 決定 | どこで |
|---|---|
| ①`show` の省略 | `engine.mjs` の `shownForEntity`：`type` の無い一覧、`show` の無い `table`・`list` は全部を並べる。ダッシュボードの順位の部品（`by`・`show`）も「見られる」 |
| ②別の構造 | 定義の `structures` の 2 つ目以降。主の構造（0 番目）を優先し、別の構造は `PASS_NEEDS_CLAIM`。**enum の代わりの entity は構造として定義しない**（役割が見つからず不合格） |
| ③最初に開く画面 | 判定の種類を持たない（採点しない） |
| 第 4 段：少ない順 | `rankingOrder`：順位の部品の `by` が、少ない側で大きいか（負の数・`1 / (n + 1)` などの書き方を問わない） |
| `03` §4 の充足率 | 結果の `fulfilled`／`writable_total`（当てはまった構造の判定の数） |

## 2. 定義の書き方

```json
{
  "id": "A", "title": "持ち寄りの持ち物分担", "clock": "2026-10-08T12:00:00+09:00", "today": "2026-10-08",
  "structures": [{
    "id": "main",
    "roles": {
      "main":   { "entity": {} },
      "member": { "entity": { "hasFieldTypes": ["string"] } },
      "who":    { "field": { "of": "main", "type": "ref", "to": "member" } },
      "status": { "field": { "of": "main", "type": "enum", "labels": ["まだ", "用意できた"] } },
      "qty":    { "field": { "of": "main", "type": "number" } }
    },
    "checks": [
      { "req": "登録したときの状態", "kind": "enumDefault", "field": "status", "label": "まだ" },
      { "req": "数は 1 以上", "kind": "validation", "entity": "main",
        "cases": [{ "set": { "qty": 0 }, "valid": false }, { "set": { "qty": 1 }, "valid": true }] },
      { "req": "人ごとの数が見られる", "kind": "computedVisible", "entity": "member", "aggregateOnly": true,
        "sources": { "main": [{ "set": { "who": "m1" } }, { "set": { "who": "m1" } }, { "set": { "who": "m2" } }] },
        "probes": [{ "recordId": "m1", "expect": 2 }, { "recordId": "m2", "expect": 1 }] }
    ],
    "unwritable": []
  }]
}
```

- **役割**：`entity`（`hasFieldTypes` で持つべき型）か `field`（`of` の entity の項目。`type`・`labels`＝選択肢の表示名の集合・`to`＝参照先の役割）。entity の役割は互いに別の entity に当てはまる。当てはめ方が複数あれば、満たした要件の多いものを採る
- **値**：`set` のキーは役割の名前。参照は `"m1"` のような ID、参照の並びは `["m1"]`
- **判定の種類**（12）：`creatable`・`actionExists`（`kinds`）・`enumDefault`・`advanceAction`（`from`→`to` の `set` と `when`）・`boardColumns`・`listFilters`・`validation`（`cases`）・`computedVisible`（`probes`・`sources`・`aggregateOnly`）・`scopeOnDashboard`・`groupChart`（`groupBy`・`month`・`last`・`aggKind`・`value`・`widgets`）・`highlight`（`trueOn`・`falseOn`）・`rankingOrder`（`fewer`・`more`・`writes`）
- **書けない要件**：構造ごとの `unwritable`（`id`・`keys`＝申告の文を見つける正規表現・`optionalIfWritten`＝書けたら数えない）

## 3. 凍結の対象（SHA-256）

```
25ea44ec218f9b0a99db0d06c171274946ca622090a67bc98cc24fcf55bf99ce  engine.mjs
a4afde2e0dfe020f21dab98b8353e11b5d69d16d481b6959053dc3e507ee81db  rubric-v5.mjs
1c62512931b63465429e0c1ba01abfe93b3b0bb4602e223b37da78b82b392a30  score-claims.mjs
bc6b8b5a1625a5e1bc8a86e109f0774bfce94869df117a5ae622882fb516b1ec  subjects/A.json
17fd97ab0fa5818a9067ca2a9d6bac0bf8468c79cbf39185ca454571ecebcb24  subjects/B.json
a10d827eff477dda51394bff96faa0f9c42631cb818a1653098446bc979bfe70  subjects/C.json
6f996f4837681bba92516c6a1e12ae9044b63bcb28d14d28bdc8d00aa1702bfe  subjects/D.json
904e07be4d6d50fb05519ed56d86dc641199a038fc0a62b41b1a2f8409bbf3dc  subjects/E.json
5bd250662068a663b54bb1e2b60a460e64158605e4b1223d5d6b8f6870c3d267  cases/cases.json
```

まとめた SHA-256（上の行を改行で連結し、最後に改行を 1 つ付けたものの SHA-256）：`68fa0f64186fd731c5a248ad3c2e53190dc54a89a81a9c8ad1efc0ba333a6fde`

凍結の前に決めたこと（2026-10-09）：許される申告（`score-claims.mjs` の `DEFAULT_ALLOWED`）と、`advanceAction`・`rankingOrder` の直し（`baseline-v5.md` §4.1）。

## 4. 確かめたこと（spec-engine は main `bf7a8e2` の `dist/`）

- `run-cases.mjs`：12 本すべて期待どおり（決定①の正例 3・負例 2、②の正例 1・負例 4、③の正例 2）
- `regress.mjs`：79 本（第 1 段 5・第 2 段 13・負例 7・第 4 段 4・第 5 段 50）のうち、v4 と判定が違うのは 7 本だけで、**すべて決定①②による**（P7-r3・P9-r1 が①で合格、D の別の構造 5 本が②で `PASS_NEEDS_CLAIM`）

## 5. 受入の計測と採点の道具（`agent-accept/`。#378・#400・#425）

| ファイル | 中身 |
|---|---|
| `agent-accept/run-agent.mjs` | 計測。P1〜P10 × 回数を工場の入口（`packages/factory/dist/cli.js`）で流す（API を呼ぶ。窓口の手元だけ）。出力先に `conditions.json`（計測の条件）・本ごとのディレクトリ・`run-<時刻>.json`（1 回の起動の記録）を残す |
| `agent-accept/score-agent.mjs` | 採点。出力先の本を採点表 v5 で採点し、`score[-label].json` を書く。`--anonymous` なら `score[-label].anonymous.json` だけを書く。Plan を通した本は、原文系と了承後系を別に数える（§5.5） |
| `agent-accept/run-agent.test.mjs`・`agent-accept/score-agent.test.mjs` | `node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"`（API・ネットワーク無し。計測の試験は偽物の工場で、採点の試験は `cases/` の固定の宣言と凍結したエンジンで閉じる。先に `pnpm build`） |

方法論 `methodology/01-eval-sets.md` §2〜§4 の前提のうち、**分母の補正・本数の照合・比較の条件の指紋・匿名の集計**をここで満たす（#425）。**原文と了承後の二系統の採点**は §5.5（#426）。評価セットの入口と台本は別の Issue（#427）。

### 5.1 計測の条件（`conditions.json`。schema `musunest-factory/agent-accept-conditions/v2`）

| 欄 | 中身 |
|---|---|
| `source` | コミットと未コミットの変更の有無 |
| `factory` | 工場の `dist` の指紋と、`src` より新しいか（作り直した根拠） |
| `spec_engine` | spec-engine の `dist` の指紋（工場の生成と採点の両方が読む） |
| `document` | 依頼文の表（`stage1-patterns.md`）の SHA-256 |
| `prompt_documents` | 生成に渡す文書。工場の入口が読むものと同じ場所を appspec-schema の `files` から引く：契約（ディレクトリの指紋）・語彙の意味・語彙の台帳（各 SHA-256） |
| `judge` | 判定の口の構成。`jev-primary-llm-fallback`（Jev の鍵の環境変数が空でない）か `llm-only`。**鍵の値は書かない**（環境変数の名前だけ） |
| `params`・`child_args` | モデル・effort・Plan の有無・題材と回数・同時数・全体の目安額・工場 1 本の予算と締切・段ごとの出力の上限と、子プロセスへ渡す引数 |
| `scoring` | 採点の定義と集計のコードの指紋（`engine.mjs`・`score-claims.mjs`・`rubric-v5.mjs`・`agent-accept/score-agent.mjs`・`subjects/*.json`。`<repo>` の採点器のもの） |
| `signature` | `--resume` の一致の判定に使う SHA-256。**`started_at`・`scoring`・`params.budget_usd` を除いた全部** |

- **署名が保証するのは生成の条件の一致であって、管理の条件（計測全体の停止の目安 `params.budget_usd`）まで含めた一致ではない。** 再開で変えた目安の額は条件のファイルには書かず（初回の値のまま上書きしない）、起動の記録（下の `run-<時刻>.json`）から読む
- `scoring` を署名から外すのは、採点は生成のあとに全本へ同じ版を当てるもので、一致は採点の出力（§5.2 の `fingerprints`）で照合するから。**ただし「採点だけ直したあとは再開できる」とは限らない**：`source.commit`・`source.dirty` は署名に残るので、clean な checkout を編集したり、採点だけの commit を積んだりすれば再開は断られる。外す効果があるのは `source` が変わらない場合（すでに未コミットの変更がある作業ツリーで採点の定義だけを直したとき）に限る。挙動は変えない
- `params.budget_usd`（計測全体の停止の目安）を外すのは、予算で止まった計測を `--budget-usd` を上げて `--resume` で流し切れるようにするため（方法論 `01` §5「予定本数まで流し切る」）。工場 1 本の予算 `factory_budget_usd` は生成の条件なので残す
- `run-<時刻>.json`：1 回の起動ごとに `mode`（`fresh`／`resume`）・流した本・残りの本・止まった理由（`stop` の文と `stop_code`。`budget` か `null`）・**その起動で有効だった `budget_usd`**・初回の条件の `initial_budget_usd`・変えたかどうか（`budget_changed`）・済みの額（`spent_usd`）を残す。完走した再開でも残すので、同じ署名の計測でも管理の条件の変更履歴を読める。再開のときは従来の `resume-<時刻>.json` も残す（`budget_usd` つき）

### 5.2 採点の出力（`score[-label].json`）

`metrics`・`bySubject`・`rows` の既存の欄は、名前も意味も変えていない（**集計の版 v1**）。#425 で足した欄：

| 欄 | 中身 |
|---|---|
| `aggregation_versions` | v1・v2 の数え方の説明 |
| `fulfillment.v1` / `fulfillment.v2` | 充足率を版ごとに並べる。`partial`（一部書けない題材 B・D）・`writable`（書ける題材 A・C・E）・`all`。**v1** ＝ 補正前（分母は当てはまった構造の判定の数。生成失敗・静的 NG の本は分母に入らない。`v1.partial` は `metrics.fulfillment_partial` と同じ値）。**v2** ＝ 補正後（分母は題材の採点定義の判定の数。当てはまった構造、無ければ主の構造。生成失敗・静的 NG・役割が見つからない本は充足 0 で分母に残す）。2 つの版は混ぜない。前後の比較は同じ版で読む |
| `rows[].fulfillment_v2` | 本ごとの v2 の分子・分母と、分母の出どころ（`structure:<id>`／`definition:<主の構造の id>`） |
| `completion` | 本数の照合。予定した本（`conditions.json` の `child_args`）・実行した本（要約のある本）・未実行（ディレクトリが無い）・途中（要約が無い）・予定外（予定に無いディレクトリ）と、いちばん新しい起動の記録の止まった理由（文と `stop_code`）・残りの本・有効だった `budget_usd`。1 本でも残れば `status: "incomplete"`・`label: "未完了"`（**正式な比較基準にしない**、の機械の目印）。**照合の前に条件のファイルを検証する**：既知の schema（v1・v2）・`child_args` が配列・各 ID が `P<n>-r<n>` の文字列・ID の一意性・`params.patterns` × `params.runs` と予定の一覧の一致・予定が 1 本以上。1 つでも落ちれば `unverified`・「未照合」と理由（入力の値は書かない）で、「完了」に丸めない。条件のファイルが無い出力先（#401 より前）・読めない条件も「未照合」 |
| `fingerprints` | 採点に使った定義とエンジン（`<repo>` から実際に読み込んだもの）と集計のコード（**実行中の `score-agent.mjs`**。`scoring.aggregator` にパスと SHA-256）の指紋（`scoring`）と spec-engine の `dist` の指紋、条件のファイルに記録された値、その一致（`scoring_matches_conditions`・`spec_engine_matches_conditions`。条件に無ければ `null`）。別の checkout を `<repo>` に渡して採点しても、`<repo>` の旧い採点器の指紋を「一致」と出さない |

標準出力には従来の指標と行に加えて、`fulfillment`・`completion` と、照合（`照合: 完了／未完了`）・指紋の一致の 1 行ずつを出す。

### 5.3 匿名の集計（`--anonymous`）

回帰用・保留用の組は落ちの中身を調べない（方法論 `01` §1）。`--anonymous` は `score[-label].anonymous.json` **だけ**を書き、標準出力にも同じものだけを出す。中身は指標の数と区間（`metrics`・`fulfillment`）・本数（`runs`・`completion` の数）・指紋（ハッシュだけ。ファイルの一覧は出さない）。`rows`・`bySubject`・本の ID・失敗した判定の名前・要件の文・申告の文は出さない。既定（`--anonymous` 無し）の出し方は今のまま。

匿名の出力は**許可した欄だけを組み立てる**（入力の文字列をそのまま通さない）：`metrics` は数と区間の 9 つの指標と、工場の判定の値を既知の列挙（`full`・`partial`・`none`）か `unknown` にまとめた `factory_verdicts`。`completion` は `status`・`label`（既知の値）・数と、止まった理由のコード `stop_code`（`budget`・`other`・`null`。文は出さない）。`fingerprints` は 64 桁の 16 進だけを通し（形が違えば `null`）、条件の `schema` と判定の口の構成は既知の値か `unknown`。測定 ID は出さない。

### 5.4 限界（#425 で直していないこと）

- **判定の口の構成を選ぶ条件（Jev の鍵の環境変数が空でなければ Jev を主・LLM を落とし先、無ければ LLM だけ）は、工場の入口（`packages/factory` の `assembleJudge`）と `run-agent.mjs` の 2 か所に写している。** 工場の側が変わっても、道具の側は気づかない（dist の指紋が変わることは分かるが、記録した構成が実際の構成と一致することは保証しない）。共通の選択関数や、本物の入口に偽物の依存を渡す契約試験は `packages/factory` を触るので #425 には入れていない。**ずれに気づく手段は今は無い**
- 署名は生成の条件の一致を保証するもので、管理の条件（計測全体の目安の額）や採点の版の一致は保証しない（§5.1）。採点の版は採点の出力の `fingerprints` で、目安の額は起動の記録で読む
- 契約の指紋はディレクトリの指紋（工場が読まない隠しファイルなども含む）なので、変更の見落としより余分な不一致を起こす側に倒してある
- 本物の工場で `run-agent.mjs` を流す試験は無い（API を呼ばない）。再開の試験の偽物のリポジトリは git の外なので、`source` の変化で断られる経路は試験していない

### 5.5 了承後の採点（#426）

Plan を通した本は、依頼文の要件の一部が、利用者が了承した既定や除外で形が変わる。原文だけで数えると正しい了承を落ちと数え、了承後だけで数えると誤った了承や除外を見逃す（方法論 `01` §3・所有者の決定⑥）。だから**原文系**（凍結した v5 の判定のまま。集計の版 v1・v2）と**了承後系**を別に数え、並べて読む。了承後系は原文系の欄を変えない（足すだけ）。定義は**候補の計測の結果を見る前に**書いた（読んだ出力は形だけ。`workspace/mem/requests/impl-426.result.md`）。

#### 5.5.1 何を読むか

| 読むもの | 使い方 |
|---|---|
| `bundle/artifacts/plan.json`（確定した仕様。契約 `musunest.plan-spec/v1`。`04-plan-agent.md` §4） | **了承の記録の正本**。要件（`requirements[]`）の部分の処分（`parts[].disposition`：`met`／`accepted_removal`／`alternative`）と変更の関係（`change.kind`：`added`／`changed`／`removed`）、了承して除いた部分（`accepted_unwritable[]`。根拠つき）、既定で決めたこと（`decisions[]`）を読む。門（bundle の manifest と検証の結果の SHA）を通ったものを読む |
| `bundle/plan-record.json`（往復の記録。納品物の外） | 補助。Plan の結果（`outcome`）だけを読み、`plan.json` の無い本の「未確定」の区別に使う（質問の数・費用は従来どおり `rows[].plan`） |
| 確認の画面の出力（標準出力の文） | **読まない**。`plan.json` の差分・`accepted_unwritable`・`decisions` を人向けに写したもので、契約ではない |
| 条件のファイルの `params.plan` | 計測が Plan を通したか。記録の無い本を「対象外」にするか「記録なし」にするかを決める（5.5.4） |

#### 5.5.2 了承後の要件と、原文の要件との対応

- **了承後の要件** ＝ 確定した仕様の要件の**有効な部分**（`disposition: "met"` の部分。部分の無い要件は全体）。Build が満たすべきもの（`04` §5）と同じ読み
- **形が変わったもの**（了承の対象）を 2 つに分ける。**除外** ＝ `accepted_removal` の部分と、`removed` の要件（作らない、と了承した）。**変更** ＝ `alternative` の部分と、`changed` の要件（別の形で作る、と了承した）。`added`（答えから増えた要件）は**数えるだけ**（原文の要件の形を変えたのではなく、足したもの。v5 で判定できる形ではない）
- **原文の要件との対応は、採点定義の `keys`（正規表現）で取る**。申告の採点（`score-claims.mjs`）と同じ照合（要件の文と部分の文を連結し、`keys` のどれかに当たるか）。当たる先は、順に：当てはまった構造（無ければ主の構造）の**書けない要件**（`unwritable[].keys`）→ **許される申告**（`DEFAULT_ALLOWED`＋定義の `allowedClaims`）→ **書ける要件**（`checks[].keys`。**v5 の定義には無い**ので今は当たらない。評価セットの定義が `checks[].keys` を持てば、コードを変えずに書ける要件まで照合が伸びる）→ **他の構造の書けない要件**（`unwritable[].keys`。当てはまった構造では書けるのに除いた、の目印）
- どれにも当たらない除外は**誤った除外**に数える。v5 の申告の採点が、期待にも許される申告にも当たらない申告を誤った申告に数えるのと同じ読み（分からないものを通さない）。どれにも当たらない**変更**は `unmatched` として数えるだけ（何かを落としたのではなく、v5 の外の要件を別の形で作ると了承したもの。誤りの証拠が無い）

#### 5.5.3 数え方

| 数えるもの | 定義 |
|---|---|
| **正しい了承**（`accepted_unwritable_ids`） | 除外・変更のうち、当てはまった構造の書けない要件に当たるもの。了承後系では、その要件は**申告が無くても挙げ漏れに数えない**（`claims_accepted.accepted`。Plan で了承を取ったから）。原文系では従来どおり申告が要る |
| **誤った除外**（`wrong_exclusions`） | 除外のうち、書けない要件にも許される申告にも当たらないもの。内訳は `matched`：書ける要件（`check`）／他の構造の書けない要件（`other_unwritable`）／何にも当たらない（`null`）。**了承後系の分母から外さない**（外すと書ける残りの落ちを隠す。`04` §5）。`accepted_unwritable[]` に部分の無い記録も誤った除外に数える |
| **誤った了承**（`wrong_acceptances`） | 変更のうち、**書ける要件に当たる**もの（原文が固定していた要件を、了承で別の形に変えた。`matched` は `check`、または他の構造の書けない要件 `other_unwritable`＝当てはまった構造では書ける）。`check` に当たった判定は了承後系の**分母（と、満たしていれば分子）から外し、`changed_checks` に数える**（v5 はその形を判定できない。原文系は従来どおり判定する）。v5 の定義では `checks[].keys` が無いので、`check` に当たる変更は今は 0 件で、変更の数（`changes`）だけが並ぶ |
| 許される了承（`allowed`） | 許される申告に当たるもの。数えない |
| 変更の数（`changes`）・決めたこと（`decisions`） | `added`／`changed`／`removed` の要件の数と、既定で決めたことの数。照合しない（既定で決めたことは、原文が固定しない事項の既定で、要件の文を変えない。変えたなら `change` に現れる） |

#### 5.5.4 記録の無い本と分母

| 本 | `acceptance.status` | 了承後系 |
|---|---|---|
| `plan.json` を読めた | `confirmed` | 了承の記録で読み替える |
| `plan.json` があるが、読めない・版が違う・形が違う | `invalid`（`reasons` に理由。値は書かない） | 充足 0・分母は題材の定義の判定の数 |
| `plan.json` が無く、`plan-record.json` がある（Plan が確定しなかった）か、計測が Plan を通した（`params.plan`） | `absent`（`plan_outcome` に Plan の結果） | 充足 0・分母は題材の定義の判定の数 |
| どちらも無く、計測も Plan を通していない | `none` | **対象外**（`fulfillment_accepted`・`claims_accepted`・`verdict_accepted` は `null`。了承後系の分母に入れない） |

- 生成失敗・静的 NG・役割が見つからない本は、原文系の v2 と同じく**充足 0 で分母に残す**（#425 の決まりをそのまま当てる）。`plan.json` があれば了承の記録（除外・変更の照合）は出す
- 了承後系の分母 ＝ v2 の分母 − `changed_checks`。分子 ＝ 残った判定のうち満たしたもの。了承後の最終の判定は `finalVerdict` を了承後の申告（`claims_accepted`）で取る

#### 5.5.5 出力の欄（足しただけ。既存の欄の名前と意味は変えない）

| 欄 | 中身 |
|---|---|
| `scoring_systems` | 原文系・了承後系の説明 |
| `rows[].acceptance` | 了承の記録の読み：`status`・`reasons`・`plan_outcome`、確定した本はさらに `plan_id`・`revision`・`structure`（照合に使った構造）・`changes`・`decisions`・`exclusions[]`・`changed[]`（それぞれ ID・種類・当たった先 `matched`・判定 `judged`）・`accepted_unwritable_ids`・`changed_checks`・`wrong_exclusions`・`wrong_acceptances`・`allowed` |
| `rows[].claims_accepted` | 了承後の申告の採点：`structure`・`expected`・`correct`・`accepted`（了承済みで申告の無いもの）・`optional`・`missed`・`verdict`。誤った申告は原文系の `claims.false_claims` と同じ |
| `rows[].fulfillment_accepted` | 了承後の充足：`fulfilled`・`total`・`total_from`・`excluded_changed` |
| `rows[].verdict_accepted` | 了承後の最終の判定（確定した本だけ。ほかは `null`） |
| `fulfillment.accepted` | 了承後系の充足率（`partial`・`writable`・`all`。対象の本だけ） |
| `metrics_accepted` | 了承後系の指標：対象の本数（`runs`・`confirmed`・`absent`・`invalid`）・`spec_pass_writable`・`missed_partial`・`spec_pass_partial`・`wrong_exclusion_runs`・`wrong_acceptance_runs`（分母は確定した本）・`wrong_exclusions`・`wrong_acceptances`・`changed_checks`・`changes`・`decisions` |
| `bySubject[].pass_accepted` | 題材ごとの了承後の合格 |

匿名の集計には `fulfillment.accepted` と `metrics_accepted`（数と区間だけ）を足す。標準出力には行ごとの了承後の判定の列と、了承後の 1 行を足す。

#### 5.5.6 採らなかった案

| 案 | 採らなかった理由 |
|---|---|
| 確認の画面の出力（標準出力）を読む | `plan.json` の写しで契約ではない。納品物の外にあり、形が変われば読めなくなる |
| 書ける要件の照合の鍵（`checks` ごとの正規表現）をコードに置く | 題材の言葉をコードに写す（守ることに反する）。凍結した定義の外に判定の材料を足すことになる。鍵は定義（データ）が持つのが v5 の形 |
| Build の対応表（`correspondence.json`）で要件と宣言の場所を結ぶ | Build 自身の申告で独立でない。宣言の場所から v5 の判定へ戻す対応が無い |
| LLM に対応を取らせる | API を呼ぶ・再現しない。採点は凍結したコードで行う（`03` §4） |
| 誤った除外を了承後系の分母から外す | 書ける残りの落ちを隠す（`04` §5）。原文系と並べる意味が無くなる |
| 何にも当たらない除外を「採点表の外」として数えない | 了承後だけで数えると除外を見逃す、の再現。v5 の申告の採点の前例（当たらない申告は誤り）に合わせた |
| 既定で決めたこと（`decisions`）を要件に照合する | 要件の文を変えない（変えたなら `change` に現れる）。照合すると、原文と同じ既定を決めた本まで誤った了承に数える |
| `plan.json` の無い本を了承後系の対象外にする | Plan を通した計測で Plan が確定しなかった本は失敗であり、分母から落とすと率が上がる（#425 の分母の決まりに反する） |

#### 5.5.7 限界（#426 で直していないこと）

- v5 の定義には `checks[].keys` が無いので、**書ける要件の変更は照合できず、変更の数だけが並ぶ**。誤った了承は今は 0 件にしかならない（照合できない、であって無い、ではない）
- 工場の今の Plan は `accepted_removal` の部分と `added` の要件しか作らない（`changed`・`removed`・`alternative` は契約にあるが未使用）。コードは契約の全部を読む
- `plan.json` の検査（ID の参照・確認の SHA の一致）はしない（門が通したものを読む）。形（版・配列・要件の ID と文）だけを見る
- 他の構造の書けない要件に当たった除外の `matched` は、その要件の ID を目印に出すだけで、除いた部分がその要件そのものである保証はない（鍵の部分一致）
