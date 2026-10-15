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
| `agent-accept/run-agent.mjs` | 計測。評価セットの定義ファイル（既定は `sets/dev-p1-p10.json`。`--set <パス>` で差し替える）の本 × 回数を工場の入口（`packages/factory/dist/cli.js`）で流す（API を呼ぶ。窓口の手元だけ）。出力先に `conditions.json`（計測の条件）・本ごとのディレクトリ・`run-<時刻>.json`（1 回の起動の記録）を残す |
| `agent-accept/score-agent.mjs` | 採点。条件のファイルに記録された定義ファイル（無ければ既定の `sets/dev-p1-p10.json`。`--set <パス>` で差し替える）を読んで、出力先の本を採点表 v5 で採点し、`score[-label].json` を書く。`--anonymous` なら `score[-label].anonymous.json` だけを書く。Plan を通した本は、原文系と了承後系を別に数え、台本を事後に当てる（§5.5・§5.6） |
| `agent-accept/freeze-plan-set.mjs` | (b) の凍結（#497。§5.7）。Plan 評価（`run-agent.mjs --plan-only`）の出力先から、P ごとに規則で 1 本の確定した仕様を選び、組のディレクトリ（リポジトリの外）に凍結した組と包みの写しを置く（API を呼ばない） |
| `agent-accept/run-agent.test.mjs`・`agent-accept/score-agent.test.mjs`・`agent-accept/freeze-plan-set.test.mjs` | `node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"`（API・ネットワーク無し。計測の試験は偽物の工場で、採点の試験は `cases/` の固定の宣言と凍結したエンジンで閉じる。先に `pnpm build`） |
| `sets/<組の id>.json`・`sets/scripts/<題材>.json` | 評価セットの定義ファイルと、題材ごとの台本（§5.6）。`dev-p1-p10.json` は今の P1〜P10 を同じ形で書き直したもの（依頼文の指紋が `stage1-patterns.md` の表と一致することを試験で確かめる） |

方法論 `methodology/01-eval-sets.md` §2〜§4 の前提のうち、**分母の補正・本数の照合・比較の条件の指紋・匿名の集計**をここで満たす（#425）。**原文と了承後の二系統の採点**は §5.5（#426）。**評価セットの定義ファイルと台本**は §5.6（#427）。**#427 の完了の範囲は「定義ファイルの入口」と「台本の事後の照合（診断）」まで**で、実行中に事項で答える口（工場の変更）は別の Issue（§5.6.3）。

### 5.1 計測の条件（`conditions.json`。schema `musunest-factory/agent-accept-conditions/v4`。v3 は #427、v2 は #425、v1 は #401）

| 欄 | 中身 |
|---|---|
| `source` | コミットと未コミットの変更の有無 |
| `factory` | 工場の `dist` の指紋と、`src` より新しいか（作り直した根拠） |
| `spec_engine` | spec-engine の `dist` の指紋（工場の生成と採点の両方が読む） |
| `set` | **読んだ定義ファイル**（§5.6。v3）：パス・SHA-256・`id`・`version`・`role`・本の一覧（`items[]`：ID・題材・書き方・書ける範囲）。署名に入る（依頼文はここから組む） |
| `document` | 依頼文の出どころの文書（定義ファイルの `source.document`。`dev-p1-p10.json` なら `stage1-patterns.md`）のパスと SHA-256（文書が無ければ `null`）。v2 までは「依頼文の表の SHA-256」で、値は同じ。計測はこの文書を読まない（定義ファイルが写し） |
| `scripts` | 台本（§5.6。v3）：`mode`・題材ごとの台本のパスと SHA-256・まとめた指紋。`mode` は `post-hoc`（採点で事後に当てる。`--script` なし）か `live`（`--script` で実行中に当てる。v4）。**`post-hoc` のときは署名から外す**（`scoring` と同じ理由：台本は生成に関わらず、採点の出力が条件と照合する）。**`live` のときは生成の条件なので署名に入れる** |
| `frozen` | 凍結した組（v4。`--build-from` のときだけ。それ以外は `null`）：組のファイルのパスと SHA-256・ID・版・出どころ（`frozen-plan`／`human`）・作った人の印（`human` のときだけ）、採用した P ごとの `plan_sha256`・`source_sha256`・包みの SHA-256、外した P（`missing`）。署名に入る。仕様の本体は写さない（§5.7） |
| `prompt_documents` | 生成に渡す文書。工場の入口が読むものと同じ場所を appspec-schema の `files` から引く：契約（ディレクトリの指紋）・語彙の意味・語彙の台帳（各 SHA-256） |
| `judge` | 判定の口の構成。`jev-primary-llm-fallback`（Jev の鍵の環境変数が空でない）か `llm-only`。**鍵の値は書かない**（環境変数の名前だけ） |
| `params`・`child_args` | モデル・effort・Plan の有無・題材と回数・同時数・全体の目安額・工場 1 本の予算と締切・段ごとの出力の上限と、子プロセスへ渡す引数。v4 で `params.mode`（`build`＝指定なし／`e2e`＝`--plan`／`plan-only`／`build-from`）を足し、`params.answers_mode` に `script`（`--script`）を足した。`params.plan` の値の決め方は変えない（子の引数に `--plan` があるか） |
| `scoring` | 採点の定義と集計のコードの指紋（`engine.mjs`・`score-claims.mjs`・`rubric-v5.mjs`・`agent-accept/score-agent.mjs`・`subjects/*.json`。`<repo>` の採点器のもの）に、**組が実際に参照する採点の定義の実体**（`files[]` の `definition:<題材>`。`source` は `eval/` からの相対パス、`sha256` は中身）を足したもの。`subjects/` の外に置いた定義も数えるので、組を変えずに参照先の中身だけを変えても、採点の出力の `scoring_matches_conditions` が不一致になる（独立レビューの指摘 2） |
| `signature` | `--resume` の一致の判定に使う SHA-256。**`started_at`・`scoring`・`post-hoc` の `scripts`・`params.budget_usd` を除いた全部**（`schema`・`params.mode`・`frozen`・`live` の `scripts` は入る） |

- **署名が保証するのは生成の条件の一致であって、管理の条件（計測全体の停止の目安 `params.budget_usd`）まで含めた一致ではない。** 再開で変えた目安の額は条件のファイルには書かず（初回の値のまま上書きしない）、起動の記録（下の `run-<時刻>.json`）から読む
- `scoring` を署名から外すのは、採点は生成のあとに全本へ同じ版を当てるもので、一致は採点の出力（§5.2 の `fingerprints`）で照合するから。**ただし「採点だけ直したあとは再開できる」とは限らない**：`source.commit`・`source.dirty` は署名に残るので、clean な checkout を編集したり、採点だけの commit を積んだりすれば再開は断られる。外す効果があるのは `source` が変わらない場合（すでに未コミットの変更がある作業ツリーで採点の定義だけを直したとき）に限る。挙動は変えない
- `params.budget_usd`（計測全体の停止の目安）を外すのは、予算で止まった計測を `--budget-usd` を上げて `--resume` で流し切れるようにするため（方法論 `01` §5「予定本数まで流し切る」）。工場 1 本の予算 `factory_budget_usd` は生成の条件なので残す
- `run-<時刻>.json`：1 回の起動ごとに `mode`（`fresh`／`resume`）・流した本・残りの本・止まった理由（`stop` の文と `stop_code`。`budget` か `null`）・**その起動で有効だった `budget_usd`**・初回の条件の `initial_budget_usd`・変えたかどうか（`budget_changed`）・済みの額（`spent_usd`）を残す。完走した再開でも残すので、同じ署名の計測でも管理の条件の変更履歴を読める。再開のときは従来の `resume-<時刻>.json` も残す（`budget_usd` つき）。v4 で、その起動で流した本の終了の分類ごとの件数（`exit_classes`。§5.7.5）を足した
- **v3 以前（#497 より前）の条件のファイルの計測も、この道具で再開できない**（`schema` が署名に入り、v4 は `params.mode`・`frozen` を持つ。`[resume:signature]` で断る）。下の v2 と同じ安全側の拒否で、救済のために `schema` を署名から外さない。指定なしと `--plan` の道では、子へ渡す引数・答えのファイル・既存の欄の値・署名から外す欄・再開の振る舞いは変えていない（変わるのは `schema` の文字列、新しい欄 `params.mode`・`frozen: null`、本と起動の記録の欄だけ）
- **v2 以前（#427 より前）の条件のファイルの計測は、この道具で再開できない。** `schema` と `set` が署名に入るので、保存した署名と一致せず「保存した条件と今の条件が一致しません」で断る（v1 と同じ扱い。試験 `run-agent.test.mjs` の v2 の例）。混在した計測を止める安全側の拒否なので、**救済のために `schema` や `set` を署名から外さない**。続けるなら、旧い署名が一致する旧版の環境で流すか、別の出力先で新しく計測する。採点の道具は v2 以前の結果をそのまま採点・照合できる（§5.6.4）

### 5.2 採点の出力（`score[-label].json`）

`metrics`・`bySubject`・`rows` の既存の欄は、名前も意味も変えていない（**集計の版 v1**）。#425 で足した欄：

| 欄 | 中身 |
|---|---|
| `aggregation_versions` | v1・v2 の数え方の説明 |
| `fulfillment.v1` / `fulfillment.v2` | 充足率を版ごとに並べる。`partial`（一部書けない題材 B・D）・`writable`（書ける題材 A・C・E）・`all`。**v1** ＝ 補正前（分母は当てはまった構造の判定の数。生成失敗・静的 NG の本は分母に入らない。`v1.partial` は `metrics.fulfillment_partial` と同じ値）。**v2** ＝ 補正後（分母は題材の採点定義の判定の数。当てはまった構造、無ければ主の構造。生成失敗・静的 NG・役割が見つからない本は充足 0 で分母に残す）。2 つの版は混ぜない。前後の比較は同じ版で読む |
| `rows[].fulfillment_v2` | 本ごとの v2 の分子・分母と、分母の出どころ（`structure:<id>`／`definition:<主の構造の id>`） |
| `completion` | 本数の照合。予定した本（`conditions.json` の `child_args`）・実行した本（要約のある本）・**採点した本（`scored`。行に入れた本の数）**・未実行（ディレクトリが無い）・途中（要約が無い）・予定外（予定に無いディレクトリ）・**採点できない本（`unscored`。採点する組に無い ID の本。行に入れない）**と、いちばん新しい起動の記録の止まった理由（文と `stop_code`）・残りの本・有効だった `budget_usd`。1 本でも残れば `status: "incomplete"`・`label: "未完了"`（**正式な比較基準にしない**、の機械の目印）。**照合の前に条件のファイルを検証する**：既知の schema（v1〜v3）・`child_args` が配列・各 ID が `P<n>-r<n>` の文字列・ID の一意性・`params.patterns` × `params.runs` と予定の一覧の一致・予定が 1 本以上。1 つでも落ちれば `unverified`・「未照合」と理由（入力の値は書かない）で、「完了」に丸めない。条件のファイルが無い出力先（#401 より前）・読めない条件も「未照合」。**予定の本が採点する組に無ければ採点せずに断る**（exit 3。§5.6.4。一部の本だけを含む組で採点して、予定した本を分母から黙って除かないため） |
| `fingerprints` | 採点に使った定義とエンジン（`<repo>` から実際に読み込んだもの）と、組が実際に参照する採点の定義の実体（`definition:<題材>`。§5.1 の `scoring`）と、集計のコード（**実行中の `score-agent.mjs`**。`scoring.aggregator` にパスと SHA-256）の指紋（`scoring`）と spec-engine の `dist` の指紋、条件のファイルに記録された値、その一致（`scoring_matches_conditions`・`spec_engine_matches_conditions`。条件に無ければ `null`）。別の checkout を `<repo>` に渡して採点しても、`<repo>` の旧い採点器の指紋を「一致」と出さない |

標準出力には従来の指標と行に加えて、`fulfillment`・`completion` と、照合（`照合: 完了／未完了（予定・実行・採点・未実行・途中・採点できない）`）・指紋の一致の 1 行ずつを出す。

#### 5.2.1 評価の種類・Plan の集計・Build だけの集計（#498。足しただけ）

2026-10-15 の所有者の決定（#491。評価を Plan 評価・Build 評価・通し評価に分ける）に合わせて、評価の種類を見分け、Plan の集計と Build だけの集計を**新しい欄**として足した。既存の欄（`metrics`・`metrics_accepted`・`metrics_script`・`fulfillment`・`completion`・`bySubject`・`rows`・`tables` の既存の形）と、採点の定義・分母・PASS の判定は変えていない（`metrics` の鍵の並びも同じ）。

| 欄 | 中身 |
|---|---|
| `evaluation` | `mode`：v4 の条件なら `params.mode`（`build`・`e2e`・`plan-only`・`build-from`。それ以外は `unknown`）、v1〜v3 なら `params.plan` が真で `e2e`・偽で `build`、条件が無ければ `null`。`build_applicable`：`plan-only` のときだけ偽 |
| `metrics_plan` | Plan の集計（`e2e`・`plan-only` のときだけ。それ以外は `null`）。結果の内訳（`outcomes`：`confirmed`・`cannot-confirm`・`stopped`・`unknown`・`absent`）と確定の率（`confirmed`。数と区間）、止まり方の分類ごとの本数（`stop_classes`。既知の分類だけ。ほかは `unknown`）、問数と往復（`questions`・`rounds`：合計・本ごとの平均・平均の分母）、自由入力（`free_text`：`answers`・`runs`・`unreadable`）、時間（`duration_ms`。本ごとの `stages[].duration_ms` の合計）と費用（`usd`。起動の記録の Plan の額、無ければ往復の記録の使った額）、実行中の台本（`script`。`scripts.mode` が `live` のときだけ）、包みの検査（`envelope`。`plan-only` のときだけ） |
| `metrics_build` | Build だけの集計（`build-from` のときだけ。それ以外は `null`）。終了の内訳（`exit_classes`：起動の記録の `exit_class` ごと。`ok`・`failed`・`return-to-plan`・`envelope-unreadable`・`envelope-rejected`・`usage-other`・`other`、それ以外は `unknown`）・exit 2 の生の数（`exit_2`）・包みの拒否（`envelope_refusals`）・差し戻し（`return_to_plan`：`count`・`rate`・`inconsistent`・`unrecorded`）・組との照合（`frozen_match`：`checked`・`mismatched`）・工場の verdict（`factory_verdicts`。既知の値・`unknown`・`absent`）・既存の PASS の率（`pass`。既存の行の判定をそのまま読む）・時間（`duration_ms` と段ごとの `by_stage`）と Build の費用（`usd`）・本ごとの行（`rows`） |
| `fingerprints.frozen`・`fingerprints.frozen_matches_conditions` | 凍結した組のファイル（条件の `frozen.path`）の SHA-256 と、条件の `frozen.sha256` との一致（条件に無ければ `null`。読めなければ指紋は `null` で不一致）。入れ子の `fingerprints.conditions.frozen` は **v4 の条件のときだけ**足し、v1〜v3 では鍵ごと省く（旧版の形のまま）。条件の `frozen.sha256` が 64 桁の 16 進の文字列でなければ、どの mode でも `null`（一致は偽）にし、入力の文字列を写さない |

**数え方の共通の決まり**（新しい欄のすべて）：

- **分母は予定した本**（条件の `child_args`。`--only` で一部の P だけを流した計測なら、その P × 回数）の全部。条件の予定を検証できなければ、採点した本。未実行（ディレクトリが無い）・途中（要約が無い）・記録の欠けた本も分母に残し、成功にも除外にも数えない（`unexecuted`・`incomplete`・`unrecorded` の数として出す）。Plan の集計の `outcomes.absent` は、往復の記録を読めない本（未実行・途中・記録なし）の合計。記録なしのうち、往復の記録はあるが JSON として読めない本は `record_unreadable` に別に数える
- **時間と費用は `{ observed, missing, total, median }`**。`observed` は値を読めた本の数、`missing` は読めなかった本の数（`observed + missing` ＝ 分母）。実測の 0（空の段の記録・0 の額）は `observed` に入れ、欠測と区別する。中央値は本ごとの値から取り、本の数が偶数なら真ん中 2 つの平均。`observed` が 0 なら `total`・`median` は `null`。単位はミリ秒と USD（小数 6 桁に丸める）。段の記録は、配列でないか有限で 0 以上でない値が 1 つでもあれば、その本は欠測
- **分類は既知の列挙に写し、知らない値は `unknown`**。一覧は採点の道具に固定して持つ（工場の Plan の段 `PLAN_STAGE_IDS`・生成の段・失敗の種類 `FAILURE_KINDS`・確定できない理由の出どころ `CANNOT_CONFIRM_SOURCES` と符号 `PLAN_DIAGNOSIS_CODES`・verdict・台本の照合の状態・終了の分類）。入力の文字列（符号に見える文字列・契約の検査の message）は通さない
- **既存の振る舞いを変えない、の例外（無害化）**：これまで英小文字とハイフンの形をした未知の分類がそのまま出ていた、診断の表の止まり方の分類（`tables` の `stop.classes`・`stop_classes` と、その標準出力の行）と段の ID（`stages.by_stage` の鍵）・Build の表の工場の verdict、行の工場の verdict の標準出力（と標準出力の `metrics.factory_verdicts` の鍵）も、上の既知の一覧に写す。既存の試験が使う符号はすべて一覧にあるので、既存の期待は変わらない。`score.json` の `metrics`・`rows` の値と、読む元の記録（生のログ・往復の記録）は書き換えない

**Plan の集計の細目**：

- 問数と往復の平均の分母は、往復の記録の `rounds` が配列の本。自由入力は `rounds[].answers[].free_text` が文字列の答えの数（`null` は数えない）。`rounds` か各往復の `answers` が配列でない記録と、JSON として読めない記録は `unreadable` に数え、読めて 0 件の本（`answers` に 0 を足すだけ）と区別する。往復の記録は採点を止めずに読み、JSON として読めない記録は既存の行・表では記録なし（`null`）、`rounds` が配列でない記録は既存の行の問数・往復を 0 に写す（今までは例外で止まっていた）
- 実行中の台本（`script`）：往復の記録の `script.matches[].state` の件数を、`answered`・`unknown`・`duplicate`・`no-choice`・`stale-revision`、それ以外は `unknown-state` に数える。率（`all_answered`）は「問いが 1 つ以上あり、全部が `answered` の本」÷ 往復の記録のある本。照合の記録は問い（質問 ID と版）と 1 対 1 に対応させ、全部の問いにちょうど 1 つずつの記録があり、余りも重なりも無い本だけを分子の候補にする。0 問の本（`no_questions`）と、照合の記録が無い・足りない・空・重なる・余る・問いの ID と版を読めない本（`unrecorded`）は別に数え、分子に入れない（状態ごとの件数には、ある記録をそのまま数える）
- 包みの検査（`envelope`。Plan だけの計測）：本ごとに `bundle/plan-result.json` を読み、版（`envelope-version`）・結果の食い違い（往復の記録の `outcome` と違うか、確定なのに仕様が無い・確定でないのに仕様がある。`outcome-mismatch`）・仕様の SHA（実際の `planDigest` と違うか、確定でないのに値がある。`plan-sha256`）・依頼文の SHA（`source-sha256`）・契約の検査（`checkConfirmedPlan` に問題がある。`contract`）を当てる。結果は既知の 3 値（`confirmed`・`cannot-confirm`・`stopped`）だけを認め、それ以外（往復の記録と同じ値でも）・型違いは `outcome-mismatch`。確定なら仕様は写像、確定でなければ仕様も `plan_sha256` も厳密に `null`（欄の欠落は `null` とみなさない）。通った本と通らない本の数、理由ごとの数、包みの無い本（`absent`）と JSON でない・写像でない本（`unreadable`）の数を出す
- **Plan だけの計測の採点**：台本の事後の照合は、確定した仕様を包みから読む（納品物の `plan.json` が無いので）。既存の行・`metrics` は今の定義のまま計算する（宣言が無いので生成失敗に見える）。Build の表は 0 本で、分母の文で Plan 評価と示す。通常の標準出力に「Build の指標は対象外」の 1 行を足す（匿名の標準出力は JSON 1 個のまま）

**Build だけの集計の細目**：

- 分母は予定した本（組の採用した P の全体ではない）。組が外した P の数（条件の `frozen.missing`）を分母の文に添える（`frozen_missing`）。Build の表も予定した本の全部（未実行の本を含む）で、Plan の記録が無いことを理由に外さず、分母の文は「凍結した組の本」
- 包みの拒否は、exit 2 で起動の記録の分類が `envelope-unreadable`・`envelope-rejected` で、しかも本の `stdout.log` にその構造化された行（工場の読み取りの失敗の行、または既知の検査名を持つ拒否の行）がある本だけを数える
- 差し戻しの率：分子は、終了コードが 3 で、かつ Build だけの記録（`bundle/build-record.json`）の `return_to_plan` が真の本だけ。分母は予定した本。終了コード 3 で記録が偽の本と、終了コード 0 で記録が真の本は `inconsistent`、終了コード 3 で記録が無いか読めない本は `unrecorded` に数え、どちらも分子に入れない
- 組との照合：Build だけの記録の `plan_sha256`・`source_sha256` が、条件の `frozen` の採用した P の値と違う本の数（`mismatched`。照合した本の数 `checked`）
- **断る**（exit 3。採点の出力を書かない）：`build-from` の計測で、条件の `frozen` が無い（`[score:frozen-missing]`）・形が違う（`[score:frozen-invalid]`。パスが空でない文字列・SHA-256 が 64 桁の 16 進の文字列・採用した P が一意で 2 つの SHA が同じ形の文字列・外した P が一意で採用した P と重ならない）。断りの 1 行は固定の文と符号だけで、匿名でも同じ（本の ID・パス・値を出さない）

**限界**（#498 で直していないこと）：

- **正解のデータとの照合は無い。** 取りこぼし・水増し・不要な質問は、人の正解ができてから別に扱う。この段の確定率・包みの検査・台本の照合の率で、仕様の品質を判定できるとは言えない
- 自由入力は答えの数だけを数え、文は読まない。記録の形を読めない本は `unreadable` に数えるだけで、その本に自由入力があったかどうかは分からない（0 件とはみなさない）
- 採点を止める記録（本の `summary.line.json`・申告の `unwritable.json`・1 回の起動の記録 `run-<時刻>.json`）が JSON として読めないときは、通常・匿名のどちらでも exit 1 で `失敗しました: 記録を読めなかった [score:record-unreadable:<summary｜unwritable｜run-record>]` の 1 行だけを出し、採点の出力を書かない（例外の文は記録の断片を含みうるので出さない）。それ以外の予期しない誤り（依存が無いなど）の扱いは今までどおり
- **生の記録から写す既存の欄は無害化の保証の外**：`rows` の `failure`・`stop`・`factory_verdict`・`plan.outcome`・`acceptance.plan_outcome` などは、今までどおり記録の値をそのまま写す（score.json の既存の値を変えない、を優先した）。値を読ませたくない組では `--anonymous` を使う
- 分類の一覧は工場の値を写したもの。工場が値を足せば、ここに足すまで `unknown` に写る（値は漏れない側に倒れる）
- 包みの拒否と終了の分類は、起動の記録の `exit_class` と本の `stdout.log` を読む。計測の道具（`run-agent.mjs`）が分類を書いた規則と別に、終了コードから分類を作り直してはいない

### 5.3 匿名の集計（`--anonymous`）

回帰用・保留用の組は落ちの中身を調べない（方法論 `01` §1）。`--anonymous` は `score[-label].anonymous.json` **だけ**を書き、標準出力にも同じものだけを出す。中身は指標の数と区間（`metrics`・`fulfillment`）・本数（`runs`・`completion` の数）・指紋（ハッシュだけ。ファイルの一覧は出さない）。`rows`・`bySubject`・本の ID・失敗した判定の名前・要件の文・申告の文は出さない。既定（`--anonymous` 無し）の出し方は今のまま。

匿名の出力は**許可した欄だけを組み立てる**（入力の文字列をそのまま通さない）：`metrics` は数と区間の 9 つの指標と、工場の判定の値を既知の列挙（`full`・`partial`・`none`）か `unknown` にまとめた `factory_verdicts`。`completion` は `status`・`label`（既知の値）・数（採点した本数・採点できない本数を含む）と、止まった理由のコード `stop_code`（`budget`・`other`・`null`。文は出さない）。`fingerprints` は 64 桁の 16 進だけを通し（形が違えば `null`）、条件の `schema` と判定の口の構成は既知の値か `unknown`。測定 ID は出さない。

#498 で足した匿名の欄：`evaluation`（`mode` は既知の値か `unknown`、`build_applicable`）。`metrics_plan` は、本数（予定・未実行・途中・記録なし・JSON として読めない記録）・結果の内訳・確定の率・問数と往復（合計・平均・分母）・自由入力の数と `unreadable`・実行中の台本の照合の状態ごとの件数と率（`0 問`・照合の記録なし）・包みの検査の数（通った・通らない・無い・読めない）、時間と費用の `observed`・`missing`・`total`・`median`。`metrics_build` は、本数・外した P の数・終了の内訳・exit 2 の生の数・包みの拒否の数・差し戻しの数と率と `inconsistent`・`unrecorded`・組との照合の数・PASS の率・既知の verdict の内訳、時間と費用の同じ 4 つ。`fingerprints.frozen` はハッシュだけ（と一致の真偽）。入れ子の `fingerprints.conditions.frozen` は v4 の条件のときだけ。既知の値の一覧には、条件の版 v4 と台本の当て方 `live` を足した。**止まり方の分類の符号・包みの理由の符号・段の ID・本ごとの値・本の ID は出さない。** 率は数と区間の形の文字列だけを通す。

**`--anonymous` は読み込みと診断の前に伝わり、標準エラーも件数と既知の理由だけにする**（独立レビューの指摘 4）：組に無い ID の本を飛ばしたときは `飛ばしました: 組に無い ID の本 n 本`、断るときは `断りました: 予定の本が採点する組に無い（n 本）`・`断りました: 定義ファイルを読めません: <既知の理由>`（パス・本の ID・組の ID を出さない）。予期しない誤り（例：採点器の依存が無い）でも詳細（パスを含みうる）は出さず `失敗しました: 採点できなかった（…）` で exit 1。匿名でない実行では同じ経路で本の ID・組の ID・パス・誤りの詳細を出す（調べられる）。

### 5.4 限界（#425 で直していないこと）

- **判定の口の構成を選ぶ条件（Jev の鍵の環境変数が空でなければ Jev を主・LLM を落とし先、無ければ LLM だけ）は、工場の入口（`packages/factory` の `assembleJudge`）と `run-agent.mjs` の 2 か所に写している。** 工場の側が変わっても、道具の側は気づかない（dist の指紋が変わることは分かるが、記録した構成が実際の構成と一致することは保証しない）。共通の選択関数や、本物の入口に偽物の依存を渡す契約試験は `packages/factory` を触るので #425 には入れていない。**ずれに気づく手段は今は無い**
- 署名は生成の条件の一致を保証するもので、管理の条件（計測全体の目安の額）や採点の版の一致は保証しない（§5.1）。採点の版は採点の出力の `fingerprints` で、目安の額は起動の記録で読む
- 契約の指紋はディレクトリの指紋（工場が読まない隠しファイルなども含む）なので、変更の見落としより余分な不一致を起こす側に倒してある
- 本物の工場で `run-agent.mjs` を流す試験は無い（API を呼ばない）。再開の試験の偽物のリポジトリは git の外なので、`source` の変化で断られる経路は試験していない

### 5.5 了承後の採点（#426）

Plan を通した本は、依頼文の要件の一部が、利用者が了承した既定や除外で形が変わる。原文だけで数えると正しい了承を落ちと数え、了承後だけで数えると誤った了承や除外を見逃す（方法論 `01` §3・所有者の決定⑥）。だから**原文系**（凍結した v5 の判定のまま。集計の版 v1・v2）と**了承後系**を別に数え、並べて読む。了承後系は原文系の欄を変えない（足すだけ）。定義は**候補の計測の結果を見る前に**書いた（読んだ出力は形だけ。`workspace/mem/requests/impl-426.result.md`）。独立レビュー（`review-impl-426.result.md`）の指摘 1〜5 を `fix-426.result.md` で反映した：**判定の手段が無いものは「判定不能」「未評価」と正直に出し、誤り 0 件や充足に丸めない**。再レビュー（`review-impl-426b.result.md`）で残った 1 件を `fix-426b.result.md` で反映した：**処分の照合ができたこと（`expected`・`allowed`）と、了承後の有効な要件（代替先・変更後・追加）を満たしたことを分けて持ち、後者を判定する手段が無い本は PASS にしない**。変更後・代替・追加の要件を判定する対応データは別の Issue で決める（ここには入れない）。

#### 5.5.1 何を読むか

| 読むもの | 使い方 |
|---|---|
| `bundle/artifacts/plan.json`（確定した仕様。契約 `musunest.plan-spec/v1`。`04-plan-agent.md` §4） | **了承の記録の正本**。要件（`requirements[]`）の部分の処分（`parts[].disposition`：`met`／`accepted_removal`／`alternative`）と変更の関係（`change.kind`：`added`／`changed`／`removed`）、了承して除いた部分（`accepted_unwritable[]`。根拠つき）、既定で決めたこと（`decisions[]`）を読む。**採点の入口で契約の検査を通す**：`packages/appspec-schema` の dist の `checkConfirmedPlan`（工場が Plan を確定するときに呼ぶものと同じ。工場の公開の面はこれを再公開していないので、契約の持ち主の dist から読む）。形・参照の不整合・了承の範囲の外・未解決の事項・確認の失効のどれかに落ちれば `invalid`（理由は検査のコードと欄の場所。値は書かない）。納品物の manifest・検証の結果との SHA の結び付きは見ない（5.5.7） |
| `bundle/plan-record.json`（往復の記録。納品物の外） | 補助。Plan の結果（`outcome`）だけを読み、`plan.json` の無い本の理由の内訳に使う（5.5.4）。質問の数・費用は従来どおり `rows[].plan` |
| 確認の画面の出力（標準出力の文） | **読まない**。`plan.json` の差分・`accepted_unwritable`・`decisions` を人向けに写したもので、契約ではない |
| 条件のファイルの `params.plan` | 計測が Plan を通したか。記録の無い本を「対象外」にするか「記録なし」にするかを決める（5.5.4） |

#### 5.5.2 了承後の要件と、原文の要件との対応

- **了承後の要件** ＝ 確定した仕様の要件の**有効な部分**（`disposition: "met"` の部分。部分の無い要件は全体）。Build が満たすべきもの（`04` §5）と同じ読み
- **形が変わったもの**（了承の対象）を 2 つに分ける。**除外** ＝ `accepted_removal` の部分と、`removed` の要件（作らない、と了承した）。**変更** ＝ `alternative` の部分と、`changed` の要件（別の形で作る、と了承した）。`added`（答えから増えた要件）は**照合しない**（原文の要件の形を変えたのではなく、足したもの。v5 で判定できる形ではない）が、下の「未検証の有効な要件」には数える
- **処分の照合と、了承後の有効な要件の評価は別のもの**。照合が `expected` なのは「処分の対象が書けない要件に当たった」という判断で、除外の `expected` と申告の挙げ漏れの免除（5.5.3）はそれで決まる。一方、了承して除いた部分の**代替先**（`accepted_unwritable[].alternative_id`・`parts[].alternative_id` が指す要件）、`changed` の**変更後**の要件、`added` の**追加**の要件は、了承後の有効な要件として Build が満たすべきもの（`04` §5：有効な部分を**すべて**満たしたときだけ合格）だが、v5 には判定する手段が無い。これらを**未検証の有効な要件**として別に数え（`acceptance.effective`）、1 つでもあれば照合が `expected`・`allowed` でも、その本の了承後の判定は `UNEVALUATED`（5.5.4）
- **原文の要件との対応は、採点定義の `keys`（正規表現）で取る**（申告の採点 `score-claims.mjs` と同じ照合）。**照合する文**：部分の処分なら**その部分の文だけ**（親の要件の全文・変更後の文・代わりの案の文は使わない。親の別の部分の語で当てたり、代替先の語で免除したりしない）。要件全体の `changed`・`removed` なら**元の要件（`from_requirement_id`）の文**（変更後の文は使わない。`changed` の元が自分自身なら元の文が無いので照合できない）
- **当たる先**は 4 種で、**当たったものを全部**挙げる（先頭の 1 件で決めない）：当てはまった構造（無ければ主の構造）の**書けない要件**（`unwritable[].keys`）／**許される申告**（`DEFAULT_ALLOWED`＋定義の `allowedClaims`）／**書ける要件**（`checks[].keys`。**v5 の定義には無い**ので今は当たらない）／**他の構造の書けない要件**（`unwritable[].keys`。当てはまった構造では書けるのに処分した、の目印）
- **処分 1 つの判定**（`judged`）：

| 当たり方 | 除外 | 変更 |
|---|---|---|
| 何にも当たらない | `unmatched`（**判定不能**） | `unmatched`（**判定不能**） |
| 部分の文が 2 つ以上の対象に当たる | `ambiguous`（**判定不能**） | `ambiguous`（**判定不能**） |
| 当てはまった構造の書けない要件 | `expected`（正しい了承） | `expected`（正しい了承） |
| 許される申告 | `allowed` | `allowed` |
| 書ける要件（`checks[].keys`） | `wrong`（誤った除外） | `unevaluated`（**未評価**。変更後を判定する手段が無い） |
| 他の構造の書けない要件 | `wrong`（誤った除外） | `wrong`（誤った了承） |

- 要件全体（`removed`・`changed`）は**含まれる対象をすべて点検する**：1 つでも書ける要件・他の構造の書けない要件に当たれば上の表の `wrong`／`unevaluated`、書けない要件だけなら `expected`（当たった書けない要件を全部、正しい了承に数える）、許される申告だけなら `allowed`。部分は 1 つの対象のはずなので、2 つ以上に当たれば `ambiguous`
- **判定不能**（`unmatched`・`ambiguous`）は、**挙げ漏れの免除の根拠にせず、誤りにも数えない**。件数と状態で出す（5.5.3）。v5 の定義には書ける要件の鍵が無いので、書ける要件の除外・変更は今は `unmatched` に入る（誤りと言える証拠が無い、であって無い、ではない）

#### 5.5.3 数え方

| 数えるもの | 定義 |
|---|---|
| **正しい了承**（`accepted_unwritable_ids`） | `expected` の処分が当てた書けない要件。了承後系では、その要件は**申告が無くても挙げ漏れに数えない**（`claims_accepted.accepted`。Plan で了承を取ったから）。原文系では従来どおり申告が要る |
| **誤った除外**（`counts.exclusions.wrong`） | `wrong` の除外。**了承後系の分母から外さない**（外すと書ける残りの落ちを隠す。`04` §5）。`accepted_unwritable[]` に部分の無い記録は契約の検査が `invalid` にするので確定した本には現れない（`readAcceptance` 単体では `wrong` に数える） |
| **判定不能の除外**（`counts.exclusions.unmatched`・`ambiguous`） | 誤りにも正しい了承にも数えない。書ける残りの落ちは、分母に残る判定が拾う |
| **誤った了承**（`metrics_accepted.wrong_acceptances`） | **未評価**。変更後の要件を判定する対応データ（別の Issue）が無い間は `status: "unevaluated"` で、**証拠**（`evidence`：他の構造の書けない要件に当たった変更 ＝ `counts.changes.wrong`）と**判定不能・未評価**（`unmatched`・`ambiguous`・`unevaluated`）の件数を添える。**0 件に丸めない**（JSON・匿名の集計・標準出力のどれでも） |
| **未評価の判定**（`unevaluated_checks`・`fulfillment_accepted.unevaluated`） | 変更が当てた書ける要件の判定。**分母からも分子からも外さない**（原文の判定のまま数える。落ちた判定を変更扱いにしても率は上がらない）。その本の了承後の判定は `UNEVALUATED` |
| **未検証の有効な要件**（`acceptance.effective`・`metrics_accepted.unverified_requirements`） | 判定の手段が無い了承後の有効な要件。出どころは 4 つ：`accepted_unwritable` ＝ 了承して除いた記録の代替先（`accepted_unwritable[].alternative_id` が指す要件）／`part` ＝ 部分の代替先（`met` でない部分の `alternative_id` が指す要件）／`changed` ＝ 変更後の要件（その要件自身）／`added` ＝ 追加の要件（その要件自身）。**要件 ID で 1 件**に数え（同じ要件を 2 つの出どころが指せば出どころを両方残す）、指す先が `requirements` に無くても数える（契約の検査が落とすので確定した本には現れない）。`effective.status` は未検証が 0 なら `evaluated`、1 つでもあれば `unevaluated`。**分母・分子は引かない**（v2 と同じまま）。その本の了承後の判定は `UNEVALUATED`（照合が `expected`・`allowed` でも）。件数は行（`effective.unverified[]`・`effective.counts`）・集計（`unverified_requirements`・`unverified_sources`・`unverified_runs`）・匿名（数だけ）・標準出力に出す。**除外だけ**（代替先も追加も無い）の本は、照合が `expected`・`allowed` なら今までどおり PASS になりうる |
| 許される了承（`allowed`） | 許される申告に当たるもの。数えない |
| 変更の数（`changes`）・決めたこと（`decisions`） | `added`／`changed`／`removed` の要件の数と、既定で決めたことの数。照合しない（既定で決めたことは、原文が固定しない事項の既定で、要件の文を変えない。変えたなら `change` に現れる） |

#### 5.5.4 記録の無い本と分母

| 本 | `acceptance.status` | 了承後系 |
|---|---|---|
| `plan.json` を読め、契約の検査を通った | `confirmed` | 了承の記録で読み替える |
| `plan.json` があるが、読めない・版が違う・形が違う・契約の検査に落ちる（参照の不整合・了承の範囲の外・未解決・確認の失効） | `invalid`（`reasons` に理由。値は書かない） | 充足 0・分母は題材の定義の判定の数 |
| `plan.json` が無く、`plan-record.json` があるか、計測が Plan を通した（`params.plan`） | `absent`（`plan_outcome` に Plan の結果、`absent_reason` に理由：`plan_not_confirmed` ＝ Plan が確定しなかった（`stopped`・`cannot-confirm`）／`confirmed_without_plan` ＝ Plan は確定したが納品物に仕様が無い（確定後に Build を始めない経路もあるので、Build の段階は断定しない）／`unknown` ＝ 往復の記録が無いか結果が読めない） | 充足 0・分母は題材の定義の判定の数 |
| どちらも無く、計測も Plan を通していない | `none` | **対象外**（`fulfillment_accepted`・`claims_accepted`・`verdict_accepted` は `null`。了承後系の分母に入れない） |

- **了承後系の分母 ＝ v2 の分母**（当てはまった構造の判定の数。生成失敗・静的 NG・役割が見つからない・記録の無い・読めない本は充足 0 で、主の構造の判定の数。#425 の決まりをそのまま当てる）。**了承で変わった判定も、誤った除外も、分母から外さない**。分子 ＝ 原文の判定で満たした数（失敗の本は 0）。だから充足率の数は v2 と同じで、了承後系が足すのは未評価の印（`fulfillment.accepted.unevaluated`：判定の数と本の数）と、申告（`claims_accepted`）・判定（`verdict_accepted`）の読み替えである。`plan.json` があれば、失敗の本でも了承の記録（除外・変更の照合）は出す
- **了承後の最終の判定**（`verdict_accepted`）：静的 NG は `STATIC_NG`。変更のうち `expected`・`allowed` でないものがあるか、**未検証の有効な要件が 1 つでもあれば**原則 `UNEVALUATED`（PASS にしない。照合が `expected`・`allowed` でも同じ）。ただし変更が当てた判定が分かっていて（`wrong`・判定不能の変更が無い）、未評価の判定の外に落ちがあるか挙げ漏れがあれば `FAIL`（落ちは隠さない。未検証の代替先があっても同じ）。残りは `finalVerdict` を了承後の申告（`claims_accepted`）で取る

#### 5.5.5 出力の欄（足しただけ。既存の欄の名前と意味は変えない）

| 欄 | 中身 |
|---|---|
| `scoring_systems` | 原文系・了承後系の説明 |
| `rows[].acceptance` | 了承の記録の読み：`status`・`reasons`・`plan_outcome`、記録の無い本は `absent_reason`、確定した本はさらに `plan_id`・`revision`・`structure`（照合に使った構造）・`changes`・`decisions`・`exclusions[]`・`changed[]`（ID・種類・照合の範囲 `scope`・当たった先 `matched[]`・判定 `judged`）・`counts`（除外・変更ごとの判定の件数）・`accepted_unwritable_ids`・`unevaluated_checks`・`allowed`・`effective`（有効な要件の評価の状態：`status`・`unverified[]`（要件 ID と出どころ `via[]`）・`counts`（`total` と出どころごと）） |
| `rows[].claims_accepted` | 了承後の申告の採点：`structure`・`expected`・`correct`・`accepted`（了承済みで申告の無いもの）・`optional`・`missed`・`verdict`。誤った申告は原文系の `claims.false_claims` と同じ |
| `rows[].fulfillment_accepted` | 了承後の充足：`fulfilled`・`total`・`total_from`（v2 と同じ数）・`unevaluated`（変更が当てた判定の名前） |
| `rows[].verdict_accepted` | 了承後の最終の判定（確定した本だけ。`PASS`／`FAIL`／`STATIC_NG`／`UNEVALUATED`。ほかは `null`） |
| `fulfillment.accepted` | 了承後系の充足率（`partial`・`writable`・`all`。対象の本だけ）と `unevaluated`（`checks`・`runs`） |
| `metrics_accepted` | 了承後系の指標：対象の本数（`runs`・`confirmed`・`absent`・`absent_reasons`・`invalid`）・`spec_pass_writable`・`missed_partial`・`spec_pass_partial`・`unevaluated_runs`・`unevaluated_checks`・`unverified_requirements`（未検証の有効な要件の数）・`unverified_sources`（出どころごと）・`unverified_runs`（それを持つ本。分母は確定した本）・`wrong_exclusion_runs`・`undecided_exclusion_runs`（分母は確定した本）・`wrong_exclusions`・`undecided_exclusions`・`wrong_acceptances`（**未評価**の状態と内訳）・`wrong_acceptance_runs`（同）・`changes`・`decisions` |
| `bySubject[].pass_accepted` | 題材ごとの了承後の合格（`UNEVALUATED` は合格に数えない） |
| `fingerprints.appspec_schema` | 契約の検査に使った `packages/appspec-schema/dist` の指紋（条件のファイルには無いので照合しない） |

匿名の集計には `fulfillment.accepted` と `metrics_accepted`（数・区間・既知の状態だけ。未検証の有効な要件は数と出どころごとの数だけで、要件の ID は出さない）を足す。標準出力には行ごとの了承後の判定の列と、了承後の 1 行（本数の内訳・未評価の本・未検証の有効な要件の件数と内訳（代替先・変更後・追加）・誤った除外と判定不能・誤った了承は「未評価」と内訳・充足と未評価の判定）を足す。

#### 5.5.6 採らなかった案

| 案 | 採らなかった理由 |
|---|---|
| 確認の画面の出力（標準出力）を読む | `plan.json` の写しで契約ではない。納品物の外にあり、形が変われば読めなくなる |
| 書ける要件の照合の鍵（`checks` ごとの正規表現）をコードに置く | 題材の言葉をコードに写す（守ることに反する）。凍結した定義の外に判定の材料を足すことになる。鍵は定義（データ）が持つのが v5 の形 |
| Build の対応表（`correspondence.json`）で要件と宣言の場所を結ぶ | Build 自身の申告で独立でない。宣言の場所から v5 の判定へ戻す対応が無い |
| LLM に対応を取らせる | API を呼ぶ・再現しない。採点は凍結したコードで行う（`03` §4） |
| 誤った除外を了承後系の分母から外す | 書ける残りの落ちを隠す（`04` §5）。原文系と並べる意味が無くなる |
| 了承で変わった判定を分母から外す（最初の実装） | 落ちた判定を変更扱いにすると率が上がる（レビューの指摘 2）。変更後を判定する手段が無いなら、外さず未評価の印を付ける |
| 何にも当たらない除外を誤った除外に数える（最初の実装） | 書ける要件の鍵が無い v5 では、判定できないものを誤りに丸めることになる（指摘 1・3）。判定不能として件数で出し、免除にも誤りにも使わない |
| 親の要件の全文を部分の照合に使う（最初の実装） | 親の別の部分の語で当たり、書ける部分だけの除外が正しい了承になる（指摘 3） |
| 照合が `expected`・`allowed` なら代替先・追加の要件も満たしたとみなす（1 回目の直し） | 照合は処分の対象が書けない要件に当たったという判断で、代替先・変更後・追加の要件の充足の判定ではない。今の工場は `accepted_removal` のたびに代替先の要件を足して `alternative_id` で指すので、代替先を検証していない本が PASS と合格率に入る（再レビューの指摘 2）。照合の結果と有効な要件の評価の状態を別に持ち、未検証が 1 つでもあれば `UNEVALUATED` にする |
| 未検証の有効な要件のある本を `FAIL` にする | 満たしていない証拠が無い。判定の手段が無いことと落ちは別（判定不能・未評価の扱いと同じ）。対応データが入ったら判定できる |
| 既定で決めたこと（`decisions`）を要件に照合する | 要件の文を変えない（変えたなら `change` に現れる）。照合すると、原文と同じ既定を決めた本まで誤った了承に数える |
| `plan.json` の無い本を了承後系の対象外にする | Plan を通した計測で Plan が確定しなかった本は失敗であり、分母から落とすと率が上がる（#425 の分母の決まりに反する） |
| 契約の検査を工場の dist から読む | 工場の公開の面（`@musunest/factory` の dist）は契約の検査を再公開していない。`packages/` を変えずに、契約の持ち主の `appspec-schema` の dist から同じ関数を読む |

#### 5.5.7 限界（#426 で直していないこと）

- v5 の定義には `checks[].keys` が無いので、**書ける要件の除外・変更は照合できず、判定不能（`unmatched`）に入る**。誤った了承の指標は、対応データ（変更後・代替・追加の要件の判定。別の Issue）が入るまで**未評価**のまま。今の工場の Plan は `accepted_removal` の部分（**そのたびに代替先の要件を足し、`accepted_unwritable[].alternative_id` で指す**。`packages/factory` の `run-plan.ts`）と `added` の要件を作る（`changed`・`removed`・`alternative` は契約にあるが未使用）。**だから今の工場の出力でも、書けない要件を 1 つでも了承して除いた本・答えから要件が増えた本は、未検証の有効な要件を持ち、了承後の判定は `UNEVALUATED` になる**（過去の計測では確定した 3 本がすべて該当した。`fix-426b.result.md`）。PASS になりうるのは、了承の記録に代替先も追加も無い本だけ
- **未検証の有効な要件は「満たしたか分からない」であって「満たしていない」ではない**。対応データが入るまで、了承後の合格率（`spec_pass_*`・`pass_accepted`）はこれらの本を合格に数えず、分母には残す。合格率を読むときは `unverified_runs`・`unevaluated_runs` と並べて読む
- **許される申告の事項**（`DEFAULT_ALLOWED`：ボタンの表示名・最初に開く画面）**を、無条件に要件の除外・変更でも許している**（`allowed`）。申告で許されることと、要件として除くことを同じに扱ってよいかは点検していない（レビュー §3）
- 契約の検査は読んだ `plan.json` 単体に当てる。納品物の manifest・検証の結果との SHA の結び付き、工場の入口（`run-agent.mjs` が起動する CLI）が門を通したことは確かめない
- 正しい了承（`expected`）の代替先（`alternative_id` が指す要件・`alternative` の部分）が実装されたこと、`changed` の変更後・`added` の要件が満たされたことは確かめない（だから未検証として数え、本を PASS にしない。判定の手段は対応データの Issue で決める）
- 他の構造の書けない要件に当たった処分の `matched` は、その要件の ID を目印に出すだけで、処分した部分がその要件そのものである保証はない（鍵の部分一致）
- Plan が確定して納品物に `plan.json` が無い本（`confirmed_without_plan`）は、Build のどこまで進んだかを記録から読めない（往復の記録は Build の前に書かれる）

### 5.6 評価セットの定義ファイルと台本（#427）

方法論 `01-eval-sets.md` §2 の「評価セットの入口」と「台本」。今まで計測の道具は依頼文を固定の文書（`stage1-patterns.md`）から読み、採点の道具は P 番号 → 題材・書き方・書ける範囲の対応を道具の中に固定していた。これを **1 つの定義ファイル**に移し、道具はそれを読んで流す・採点する。P 番号と題材の対応は道具の中に持たない。**今の P1〜P10 の依頼文と採点の対応は変えない**（形を移すだけ。定義ファイルから組み立てた依頼文の指紋が今の表と一致することを試験で確かめる）。形は**実装の前に**ここに書いた。

**#427 の完了の範囲**：(1) 評価セットの定義ファイルの入口（計測と採点が読む）、(2) 台本の形と、**台本の事後の照合（診断）**。実行中に台本で答える口は工場（`packages/factory`）の変更なので #427 には入れず、**別の Issue**にする（§5.6.3）。**その Issue が終わるまで、方法論 `01` §2 の作業 1 の必須分のうち「台本」は未完了**である（事後の照合は、不明な問いで推奨が採られたことを数えるだけで、台本で答えた成績を測らない）。独立レビュー（`workspace/mem/requests/review-impl-427.result.md`）の指摘 2〜4 は `fix-427.result.md` で反映した：**採点の定義の実体の指紋・予定と採点の本数の照合・匿名の標準エラー**（§5.6.4）。

#### 5.6.1 定義ファイル（`sets/<組の id>.json`。schema `musunest-eval/eval-set/v1`）

| 欄 | 中身 |
|---|---|
| `schema`・`id`・`version` | 契約の版・組の ID・組の版（題材を入れ替えたら上げる。方法論 `01` §1「組の版を上げて基準を測り直す」） |
| `role` | 組の役割：`development`（開発用）／`regression`（回帰用）／`holdout`（保留用）。方法論 `01` §1 |
| `title` | 人が読む名前 |
| `source` | 出どころ（任意）：`document`（依頼文を写した文書のパス。リポジトリの根からの相対）・`section` |
| `styles` | 書き方の ID → 説明（例 `S1`＝丁寧な箇条書き、`S2`＝会話体）。本の `style` はここにあること |
| `items[]` | 本 1 つ。**`id`**（`P<n>` の形。出力先の本の名前 `<id>-r<回>` と条件の `params.patterns` に使う。照合の道具がこの形を前提にする）・**`subject`**（題材 ID。採点の定義の `id` と一致）・**`style`**・**`writable`**（対象範囲：`true`＝全部書ける、`false`＝一部書けない。集計の `partial`／`writable` の分け方になる）・**`scoring`**（採点の定義のパス）・**`script`**（台本のパス。無ければ `null`）・**`request`**（依頼文。行の配列。改行でつないだものが依頼文で、計測はその末尾に改行を 1 つ足して `request.md` に書く） |

- パスは**定義ファイルの場所からの相対**（`../subjects/A.json`・`scripts/A.json`）。絶対パスも通す（試験用）
- **欠けた欄・形の違う欄は断る**（理由の一覧。入力の値は書かない）：未知の `schema`・`id`／`version`／`role`／`styles`／`items` の形・本の ID の形と一意性・`styles` に無い書き方・`writable` が真偽値でない・採点の定義が無い／`id` が `subject` と違う・台本が無い／読めない／形が違う・`request` が文字列の配列でないか 0 行・同じ題材の本で `writable` が食い違う。計測の道具は 1 本も起こさずに非 0 で終え、採点の道具は採点しない
- 同じ題材の本は同じ採点の定義と台本を指す（P1 と P2 は `A`）。**採点の定義そのものは凍結した `subjects/` のまま**（定義ファイルは指すだけ）
- **匿名の集計には、組の ID・題材 ID・本の ID を出さない**（§5.3 のまま）

#### 5.6.2 台本（`sets/scripts/<題材>.json`。schema `musunest-eval/plan-script/v1`）

Plan の質問に、**質問 ID ではなく点検済みの事項（どの要件のどの決めどころか）で答える**。質問 ID（`Q<版>-<n>`）・選択肢 ID・要件 ID（`R-<n>`）は実行のたびに工場が付け直すので、台本はそれらを持たず、**文**（要件の文・問いの文・選択肢の文）と**目録の観点 ID**で指す。

| 欄 | 中身 |
|---|---|
| `schema`・`subject`・`version` | 契約の版・題材 ID（定義ファイルの `subject` と一致）・台本の版 |
| `entries[]` | 点検済みの事項 1 つ。**`id`**（台本の中で一意）・**`facet`**（工場の目録の観点 ID：`aggregation`／`period`／`current-period`／`counted-state`／`include-zero`／`editable-by`。目録に無い決めどころなら `null`）・**`keys`**（正規表現の配列。**全部**が当たること。要件と決めどころの両方を指す語を書く）・**`answer`**（`{ "choose": [正規表現…] }`＝選択肢の文で指す。全部が当たる選択肢が**ちょうど 1 つ**のときだけ決まる／`{ "recommended": true }`＝点検の結果「推奨でよい」と決めた事項。**台本に無いのとは区別する**）・**`basis`**（根拠：依頼文の引用と、採点の定義のどの判定が決めているか） |

**当て方**（1 問ごと）：

1. 問いの**事項の文**を集める：問いの文・選択肢の文・問いが閉じる事項（`open_issue_id`・`also_closes`）の文と、目録の事項（`OI:catalog:<要件 ID>:<観点 ID>`）が指す**要件の文**。事項と要件の文は確定した仕様（`bundle/artifacts/plan.json`）から引く（無い本は問いと選択肢の文だけ）
2. 問いが持つ**観点**を、目録の事項の ID から読む（`OI:catalog:…:<観点 ID>`。`also_closes` も見る）。工場の目録の事項の ID の形に依存する（変われば観点は読めなくなるが、文の照合は残る）
3. `keys` が全部当たり、かつ観点が食い違わない（台本の `facet` が `null`、問いに観点が無い、または問いの観点に含まれる）台本の件を集める。**0 件なら「不明」（`unknown`）**。2 件以上なら「決められない」（`unresolved`・`entries`）
4. 1 件なら答えを決める：`choose` が全部当たる選択肢がちょうど 1 つならその選択肢、0 か 2 つ以上なら「決められない」（`unresolved`・`no-choice`／`many-choices`）。`recommended: true` なら推奨の選択肢
5. 決まった答えを、**工場が実際に採った答え**（往復の記録 `plan-record.json` の `answers`。全部推奨で閉じた往復は推奨）と比べる：同じなら `agreed`、違えば `disagreed`

- **台本の答えの出どころは依頼文と採点の定義（凍結した v5）だけ。候補の計測の結果（工場の推奨の中身）を見て台本を選ばない。** 採点の定義が区別しない事項（例：内訳を件数で出すか金額で出すか）と依頼文が決めていない事項は台本に入れない（不明のまま数える）。最初の台本は、今の組（A〜E）で**依頼文か採点の定義が決めている事項**の分だけ（目録の観点 × 集計の要件と、依頼文が明示する目録外の決めどころ）。曖昧な依頼の組（`04-plan-agent.md` §9）の台本は別の Issue
- 自由入力の答えは今は扱わない（選択式だけ）

#### 5.6.3 「不明」の扱いと、工場を変えずにできないこと

**工場の答えの口は質問 ID で、Plan を始める前に 1 度だけ読む**（`packages/factory/src/cli-plan.ts` の `parsePlanAnswers`・`createAnswersFilePlanResponder`。質問 ID → 選択肢 ID か自由入力。無い質問は推奨で埋める）。質問は Plan の途中で工場が作るので、**事項で書いた台本を実行中に当てる口が工場に無い**。「不明」を表す値も無い（空の答えは推奨になる）。だから今は：

| | 今 |
|---|---|
| 計測（`run-agent.mjs`） | 答えのファイルは今までどおり **`{}`（すべて推奨。`params.answers_mode: "recommended"`）**。台本は実行中に当てない。条件のファイルに台本の指紋と `scripts.mode: "post-hoc"` を残す |
| 採点（`score-agent.mjs`） | 往復の記録の**全部の問いに台本を事後に当て**、本ごとに `scripted`（台本で答えられた。`agreed`／`disagreed`）・`unknown`（台本に無い）・`unresolved`（決められない）を数える。**台本に無い問いに工場が推奨で進んだことを、黙って採らずに結果で知らせる**：行の `script.status`（`ok`／`disagreed`／`unanswered`／`no-questions`／`none`）・集計 `metrics_script`・匿名の集計（数だけ）・標準出力の 1 行 |

- **どこで止まるか**：**実行中は止まらない**（工場が推奨で進み、Build まで流れる）。止まるのは採点で、`unanswered`・`disagreed` の本は「台本が保証しない答えの上で測った本」として印が付く。了承後系の判定（`verdict_accepted`）や合格率は**変えない**（足すだけ）。読むときは `spec_pass_*` を `metrics_script.runs_unanswered`・`runs_disagreed` と並べて読む
- 工場に事項で答える口が付いたら（別の Issue。`packages/factory` を触る）、**同じ台本をそのまま渡す**。そのとき変わるのは `run-agent.mjs` の答えの書き方と `scripts.mode` だけで、台本と採点の当て方は変えない。「不明」のときに Plan を止めるか推奨で進むかも、その口の仕様で決める
- **別の Issue（工場の「事項で答える口」）で扱う要点**（独立レビュー `review-impl-427.result.md` §3）：各往復で質問・選択肢・事項の観点と、その時点の要件／事項の文と版を利用者役へ渡すこと（今の `PlanAnswerRequest` は質問と残りの上限だけ）／台本が一意に当たるときだけ答え、`unknown`・`unresolved` を明示的な結果として返し、推奨への自動変換と Build の自動開始を防ぐこと（不明時の停止・再質問と本数の数え方を仕様にする）／事項・選択・答えの版、台本の件、照合の状態を記録し、**実行中に使う台本は生成条件なので署名に含める**こと／API 不要の試験（推奨と違う答えの反映・未登録の問い・複数一致・古い版・不明後に Build が始まらないこと）。ここ（#427）では扱わない
- 事後に当てるので、台本の照合が示すのは「工場の推奨が点検済みの答えと同じだったか」であって「台本で答えたらどうなったか」ではない。`disagreed` の本の Build の結果は、台本の答えで作ったものではない。**台本で答えた場合の仕様・Build の成績、不明に対する Plan の停止や再質問、意図の解決率は測れない**。`runs_ok` は問いの無い本も含み、Plan の確定や成功の指標ではない。本の状態は `disagreed` を優先するので、不一致と不明が同居する本の不明は `runs_unanswered` に入らず、問いの `unknown`／`unresolved` と `details` に残る

#### 5.6.4 条件と出力の欄（足しただけ。既存の欄の名前と意味は変えない）

| どこ | 欄 | 中身 |
|---|---|---|
| `conditions.json`（v3） | `set`・`document`・`scripts` | §5.1 の表 |
| `score[-label].json` | `set` | 採点に使った組：`id`・`version`・`role`・`path`・`sha256`。条件のファイルの値との一致は `fingerprints.set_matches_conditions`（条件に無ければ `null`。v2 以前の計測は既定の組で採点する） |
| | `rows[].writable` | 本の対象範囲（定義ファイルの `writable`） |
| | `rows[].script` | 台本の照合：`file`（台本のパス。無ければ `null`）・`status`・`questions`（問いの数）・`scripted`・`agreed`・`disagreed`・`unknown`・`unresolved`・`details[]`（問いごと：`question_id`・`open_issue_id`・`facets`・`status`・`reason`・`entry_id`・`choice_id`（台本の答え）・`actual_choice_id`（工場の答え）・`agrees`）。往復の記録の無い本は `status: "none"` |
| | `metrics_script` | `mode`・`label`・`runs`（往復の記録のある本）・`questions`・`scripted`・`agreed`・`disagreed`・`unknown`・`unresolved`・`runs_ok`・`runs_disagreed`・`runs_unanswered`（数と区間。分母は往復の記録のある本） |
| | `fingerprints.set`・`fingerprints.scripts` | 読んだ定義ファイルの SHA-256 と、台本のまとめた指紋（ファイルの一覧つき）。条件のファイルの値との一致（`set_matches_conditions`・`scripts_matches_conditions`） |
| | `fingerprints.scoring.files[]` の `definition:<題材>` | 組が実際に参照する採点の定義の実体（`source`・`sha256`）。§5.1 の `scoring` と同じ計算で、`scoring_matches_conditions` に効く。`subjects/` の中の定義は `subjects/<題材>.json` と `definition:<題材>` の両方で数える |
| | `completion.scored`・`completion.unscored` | 採点した本の数と、採点できない本（組に無い ID）の一覧。採点できない本が 1 本でもあれば理由 `採点できない n 本（組に無い ID）` が付き「完了」にならない（§5.2） |
| | `bySubject` | 鍵は定義ファイルの題材の順（今の組では `A`〜`E` のまま） |
| 匿名の集計 | `metrics_script`・`set`・`fingerprints.set`・`fingerprints.scripts` | 数と区間・既知の値（`mode`・`role`）・版・ハッシュだけ。問いの文・事項の ID・台本の件の ID・組の ID・題名は出さない |

標準出力には `台本: 対象 n 本・問い q（台本で答えられた k［推奨と同じ a・違う d］・不明 u・決められない v）・本の内訳（一致 x・不一致 y・不明あり z）` の 1 行を足す。

- 採点の道具が読む組は、`--set <パス>` ＞ 条件のファイルの `set.path`（リポジトリの根からの相対。絶対パスも通す）＞ 既定の `sets/dev-p1-p10.json` の順
- **予定の本（条件のファイルの `child_args`。検証できるとき）が採点する組に無ければ、採点せずに断る**（`断りました: 予定の本が採点する組（<組>）に無い（n 本: <ID>）`。exit 3。`score[-label].json` を書かない）。v2 以前の結果に一部の本だけを含む組を `--set` で渡したときも同じ。予定した本を飛ばして成功率の分母から黙って除かないための拒否で、「未照合」にして数を出すことはしない（独立レビューの指摘 3）
- 出力先に**組に無い ID の本**（予定外）があれば採点せず行に入れないが、照合 `completion` に `unscored` として残し（予定外かつ採点できない本の 2 つの理由）、標準エラーに `飛ばしました: <ID>（組 <組> に無い ID の本）` と出す（匿名なら件数だけ。§5.3）。条件のファイルを検証できない（未照合）出力先でも同じ
- 定義ファイルは署名に入る（依頼文の出どころ）。**変えると再開は断られる**。台本は署名の外（`scoring` と同じ扱い）で、採点の出力が条件の指紋と照合する。**組が参照する採点の定義の実体も `scoring` の指紋に入る**（§5.1。署名の外）：組を変えずに参照先の中身だけを変えても `scoring_matches_conditions` が不一致になる（組の指紋 `set_matches_conditions` は一致のまま。試験で分母が動くことと合わせて確かめる）
- v2 以前の条件のファイルの計測は採点・照合でき（組・台本の一致は `null`）、再開はできない（§5.1）

#### 5.6.5 採らなかった案

| 案 | 採らなかった理由 |
|---|---|
| 台本を質問 ID → 選択肢 ID で書く（今の答えのファイルの形） | ID は実行のたびに変わる。前の計測の ID で次の計測に答えられない。方法論 `01` §2「質問 ID ではなく点検済みの事項で答える」に反する |
| 工場の対話の口（端末）を計測の道具が擬似端末で駆動し、実行中に台本で答える | 問いの文を標準出力から読み戻す形になり、事項の ID（観点）が端末に出ないので観点で当てられない。答えのファイルの口と違う経路になり、`answers_mode` の意味が変わる。依頼は答えのファイルの口に合わせること |
| 自由入力で「不明」と答える | 工場は自由入力を判定の口（API）で分類し、分類できなければ断って次の往復で聞き直す。費用と往復を増やすうえ、質問 ID が要るので事前に書けない |
| 不明な問いのある本を了承後系の分母から外す・判定を変える | 既存の欄の意味を変える。台本の照合は別の欄で出し、並べて読む |
| 定義ファイルに採点の定義の中身を写す | 凍結した `subjects/` が正本。写すと二重になり、指紋が二つになる |
| 台本の `keys` を要件 ID（`R-<n>`）で書く | 要件 ID は P1 で LLM が付け、実行ごとに変わる |
| 台本の答えを候補の計測の推奨から写す | 台本がその計測に適応する（方法論 `01` §0）。出どころは依頼文と採点の定義だけにする |

#### 5.6.6 限界（#427 で直していないこと）

- 台本は実行中に当たらない（§5.6.3）。不明な問いで Plan は止まらず、推奨で進む。**実行中に事項で答える口は工場の別の Issue**で、それまで作業 1 の必須分のうち台本は未完了（§5.6 の範囲）
- 採点の定義の実体の指紋は、組が指す定義の**中身**で数える（パスに依らない）。`subjects/` の外に置いた定義の変更は不一致として出るが、どの判定が変わったかまでは示さない（`files[]` の `sha256` を見比べる）
- 文の照合（正規表現）は、工場が利用者の言葉で書く問いと選択肢の言い回しに依存する。当たらない・複数に当たるときは「不明」「決められない」に倒し、推奨に丸めない。台本の精度（問いの文に当たる率）は本物の計測で確かめていない
- 問いの観点は目録の事項の ID の形（`OI:catalog:<要件 ID>:<観点 ID>`）から読む。工場が形を変えれば観点は読めなくなる（文の照合だけになる）
- 本の ID は `P<n>` の形に固定している（照合の道具 `validatePlanned`・`reconcile` が前提にする）。新しい組も `P<n>` で番号を振る
- `regress.mjs`・`rescore-baseline.mjs`（v5 の回帰と基準線の採点し直し）は P 番号 → 題材の対応を自分で持ったまま（凍結した採点表の道具。触らない）
- 定義ファイルの `request` は依頼文の写しで、`source.document` との一致は試験（`run-agent.test.mjs`）が確かめるだけ。計測の道具は文書を読まない

### 5.7 Plan 評価・Build 評価・通し評価の口と、(b) の凍結（#497）

2026-10-15 の所有者の決定（#491。評価を Plan 評価・Build 評価・通し評価に分ける。D4 は (b) の凍結の規則）のうち、計測の道具から工場の 3 つの口（#495）を流す配線と、(b) を規則で凍結する道具。API は使わない（凍結の道具も試験も）。計測の道具と工場の既定の値は変えていない。

#### 5.7.1 3 つの口（`run-agent.mjs`）

| 指定 | `params.mode` | 子へ渡すもの |
|---|---|---|
| なし | `build` | 今までどおり |
| `--plan` | `e2e` | 今までどおり（`--plan --answers <空の答え>`）。`--script` と組めば `--plan --script <写し>` |
| `--plan-only` | `plan-only` | `--plan-only --answers <空の答え>`。`--script` と組めば `--plan-only --script <写し>`。工場は Plan だけの結果を `bundle/plan-result.json` に書き、Build を流さない |
| `--build-from <組のファイル>` | `build-from` | `--plan-file <写し>`（組の包みを本のディレクトリの `plan-file.json` に写したもの）。Build だけを流す |

- `--script`：本ごとに定義ファイルの台本を本のディレクトリの `script.json` に写し、子に渡す（`--answers` は渡さない。`params.answers_mode` は `script`、`scripts.mode` は `live` で、台本が署名に入る）。台本の無い本が 1 本でもあれば断る
- 組めない組は断る：`--plan` と `--plan-only`、`--build-from` と `--plan`・`--plan-only`・`--script`、Plan を流さない `--script`

#### 5.7.2 `--build-from` の対象の本

- 既定は、組が採用した P × `--runs`。`--only` は採用した P の部分集合だけを許す
- 組が外した P（`missing`）は `build-from:excluded-p`、組にも定義ファイルにも無い P は `build-from:unknown-p`、定義ファイルにはあるが組に無い P は `build-from:not-adopted` で断る
- 条件の `params.patterns`・`child_args` と採点の照合（`validatePlanned`・`reconcile`）は、この対象 × 回数にそろう

#### 5.7.3 `--build-from` の事前の検査（子を起こす前。出どころが `frozen-plan` でも `human` でも同じ）

1. 組のファイルを読む（無い・JSON でない・形が違う → `build-from:frozen-missing`／`build-from:frozen-invalid`）。組に書いた定義ファイルの SHA-256 と今の定義ファイル（`build-from:set-sha256`）
2. 対象の P ごとに、写しのバイト列の SHA-256 と組の値（`build-from:envelope-sha256`）
3. 工場の dist の包みの読み取りと検査の関数（`parsePlanFile`・`validatePlanFile`。純粋な関数）を、写しと今の依頼文と工場の語彙の版（`VOCABULARY_VERSION`）に当てる。工場が `--plan-file` で行う検査（必須欄・入れ子の型・結果の種類・`checkConfirmedPlan`・実際の `planDigest`・包み自身の `source_sha256`・語彙の版）と同じものになる。読み取りの失敗は `build-from:envelope-unreadable:<工場の符号>`、検査の拒否は `build-from:envelope-rejected:<検査名>`。人の包みの `conditions` が `null` なのは許す
4. 組の `plan_sha256`・`source_sha256` と包みの値（`build-from:plan-sha256`／`build-from:source-sha256`）

組に保存した検査の結果は信頼せず、`--resume` でも毎回この検査を行う。

#### 5.7.4 拒否の符号

計測の道具と凍結の道具の断りは exit 3。標準エラーの 1 行に、固定の拒否の符号（`[...]`）と本の ID・件数だけを出す（`<工場の符号>`・`<検査名>` は既知の列挙に写し、それ以外は `unknown`）。どの断りでも子を 1 本も起こさない。新しい計測の起動前の断りでは `conditions.json`・本のディレクトリ・起動の記録を作らない。再開の断りでは既存のファイルをバイト列まで変えず、新しいファイルを作らない。

| 符号 | 断る場合 |
|---|---|
| `flags:conflict` | 組めない指定の組（§5.7.1） |
| `script:missing`・`script:changed`・`script:read` | 台本の無い本がある／読み込んだあとに台本が変わった／台本を読めない |
| `build-from:*` | §5.7.2・§5.7.3 |
| `resume:prior-output`・`resume:no-conditions`・`resume:unreadable`・`resume:signature`・`resume:partial`・`resume:no-logs` | 既存の再開の断り（#400）。今までの文のあとに符号を添える |
| `set:invalid`・`only:unknown` | 既存の定義ファイルと `--only` の断り（#427）。今までの文のあとに符号を添える |
| `freeze:*` | 凍結の道具の断り（§5.7.6） |

#### 5.7.5 本と起動の記録（v4 で足した欄）と無害化

- 本の起動の記録（`summary.line.json`）に、子を起こす直前の `started_at`（ISO、ミリ秒まで）と、終了の分類 `exit_class` を足した。`exit_class` は 0 ＝ `ok`、1 ＝ `failed`、3 ＝ `return-to-plan`。2 は、標準出力に工場の包みの読み取りの失敗の行（既知の版）があれば `envelope-unreadable`、検査で断った行（既知の版と既知の検査名）があれば `envelope-rejected`、どちらも無ければ `usage-other`。それ以外は `other`。exit 2 が出ても計測は止めない。1 回の起動の記録（`run-<時刻>.json`）に分類ごとの件数（`exit_classes`）を足した
- **無害化**：本のディレクトリの生のログ（`stdout.log`・`stderr.log`・`request.md`・写し）はそのまま残す。記録（`summary.line.json`・起動の記録・条件・組のファイル）と計測の道具の標準出力には値を入れない。`summary.line.json` の `stdout_tail`・`stderr_tail` は子の出力の写しから `{ bytes, known_lines }`（バイト数と既知の版の行の数）に置き換えた。要約（`summary`）と費用の行（`plan_cost`）は、**列挙した欄と型だけ**を写す：`verdict`（`full`・`partial`・`none` か `unknown`）・`stop_class`・`stop_reason`（工場の止めた理由と失敗の分類の列挙か `unknown`）・有限の数の欄（費用・時間・終了コード・残高など）・`stages[]`（段の ID・`operation`・`status`・`failure_kind` は列挙か `unknown`、数の欄、試行と再試行の数）・`arbitration` の数（数の写像はどの階層も工場の `record.ts` の既知の鍵だけを名指しで写す）・`failure`（段と種類は列挙、`code` は有無だけ `present`、`problems` は件数）。費用の行は `plan_usd`・`build_usd`・`total_usd` だけ。それ以外の欄（`run_id`・`next_action`・問題の `message`・追加の欄）は写さない。標準出力の 1 行の `verdict=` も既知の値か `unknown`。生の中身を読むときは生のログを開く
- 断りの文は 1 行で、入力から来る部分を通さない。既存の断りの文は保つが、定義ファイルのパスは出さず、`--only` の ID は `P<n>` の形のものだけ（それ以外は「形の違う ID n 件」）、組の ID は既知の組（`sets/` の `dev-p1-p10`・`regression-r1`）と一致するときだけ出す（それ以外は「既知でない組」）。在るが読めない包み・台本（ディレクトリなど）は `build-from:envelope-read`・`script:read`・`freeze:envelope-read` で断る

#### 5.7.6 (b) の凍結の道具（`freeze-plan-set.mjs`）

```bash
node freeze-plan-set.mjs <repo> <Plan 評価の出力先> <組のディレクトリ> --id <組の ID> --version <整数>
```

- 入力は比較元の版の Plan 評価（`--plan-only`）の出力先。出力は組のディレクトリで、組のファイル（`frozen-plan-set.json`。`musunest-eval/frozen-plan-set/v1`）と採用した本の包みの写し（`envelopes/<本>.plan-result.json`）を置く。置き場所は計測の出力先と同じくリポジトリの外で、道具は場所を引数で受け取るだけ
- **規則（`earliest-confirmed` v1）**：P ごとに、包みの結果が確定した本のうち `started_at` が最も早い本を採る。同じ時刻なら回の番号の小さい本。Build の記録（要約の verdict・納品物・Build だけの記録）は読まない。本を選ばせる引数は無い
- 採る前に、包みに §5.7.3 の 3. と同じ工場の検査関数を当てる。包みの条件（モデル・effort）が計測の条件と一致することも確かめる
- 確定した本が無い P は断らずに組から外し、`missing` に残す（P の ID と、その P の本数）。全部の P に確定が無いときだけ断る
- 断る（exit 3。組を書かない）：引数が足りない（`freeze:args`）・出力先が空でない（`freeze:out-not-empty`）・条件のファイルが無い・読めない（`freeze:conditions-missing`／`-unreadable`）・v4 でない（`freeze:conditions-schema`）・`params.mode` が `plan-only` でない（`freeze:mode`）・予定の検証が通らない（`freeze:planned`）・`source.dirty` が偽でない（`freeze:dirty`）・commit が無い（`freeze:commit`）・定義ファイルを読めないか SHA-256 が条件と違う（`freeze:set-unreadable`／`freeze:set-sha256`）・照合が完了でない（`freeze:incomplete`）・確定した本の包みが検査を通らない（`freeze:envelope-unreadable[:<符号>]`／`freeze:envelope-rejected:<検査名>`）・在るが読めない（`freeze:envelope-read`）・包みの条件が違う（`freeze:envelope-conditions`）・`started_at` が無い（`freeze:started-at`）・確定が 1 本も無い（`freeze:none-confirmed`）
- 組のファイルの欄：`schema`・組の `id`・組の `version`（整数。引数で渡す）・`origin`（`frozen-plan`）・`rule`（規則の名前と版）・`set`（定義ファイルのパス・SHA-256・ID・版）・`source_measurement`（測定 ID・条件の署名・条件のファイルの SHA-256・Plan の commit・工場の dist の指紋・モデル・effort・予算・締切・答え方・台本の当て方と指紋）・`adopted[]`（P・本・`started_at`・包みの相対パスと SHA-256・`plan_sha256`・`source_sha256`）・`missing[]`。時刻・出力先のパスは書かない（同じ入力からはバイト列まで同じ組になる）
- 人が作る (a) は同じ組の形で、`origin` を `human`、作った人の印を `author`（`owner`／`scorer`）にする（`rule`・`source_measurement` は `null` でよい）。(a) を作る道具はこの Issue に入れていない

#### 5.7.7 基準として流す条件（計測の道具と工場の既定は変えない）

- **正式な基準と比較では、全段 `--effort high`・`--deadline-min 20`・`--factory-budget-usd 0.30` を明示して渡す。** 工場の既定の締切は 10 分なので、指定しないと基準にならない
- 比較元と候補は、同じ入力・同じ答え方・同じ並列の数で、同じ時間帯に交互に流し、P ごとの対で読む
- Build 評価は凍結した組の版をまたいで比べない。Plan を変えた wave の後は組の版を上げて測り直す
- 並列 10 は、429・529・締切による停止の件数を記録から観測できて、しかも 0 だったときだけ採る。観測できないことを 0 件とみなさない。観測の手段はまだ無いので、並列は 3 のままにする
- 外した P がある組の成績は、採用した P の数と外した数を添えて読み、全 P の組の成績と同じに扱わない

#### 5.7.8 限界（#497 で直していないこと）

- 台本の写しは、定義ファイルの読み込みで取った指紋と同じ中身のときだけ写す（読み込みのあとに変われば `script:changed` で断る）。工場が台本の形を受け付けるかは工場の検査に任せる
- 要約の列挙（段の ID・失敗の分類・止めた理由）は工場の `record.ts` の値を写したもの。工場が値を足せば、足すまで `unknown` に写る（値は漏れない側に倒れる）
- `params.plan` は `--plan` の有無のまま（`plan-only`・`build-from` は `false`）。採点の道具の了承後系の対象は、今までどおり本ごとの Plan の記録の有無でも決まる
- 比較の道具は作っていない。並列の上限を上げる条件（429・529・締切の停止の観測）は別の Issue

## 6. 回帰用の組 `regression-r1`（#450）

方法論 `01-eval-sets.md` §1 の**回帰用の組の初期の予備セット**。直しの前後で同じ組を数え、壊していないかを見る組で、**落ちの中身は調べない**。開発用（§5.6 の `dev-p1-p10`）と同じ入口の形（`sets/regression-r1.json`。`role: regression`）で、新しい題材 5 つ（`subjects/R1〜R5.json`）を開発用の題材と**同じ判定の組**で持つ。

> 状態：**案**（2026-10-13・窓口）。**Codex の独立のレビュー（2026-10-13。指摘 5・直さないと誤る 3）は反映済み**（`fix-450`。§6.2 の「開発用との差」・§6.5・§6.6）。再確認で残った 1 件（R2 の集計の対象状態）は凍結した v5 では直せないので、**直さず限界として §6.5・§6.6 に明記**した（`fix-450b`・`fix-450c`。窓口の判断）。使うのは**所有者の確認（保留用の題材との重なりが無いこと）を経てから**。作る側は保留用の題材を見ていない。題材と採点は、**候補の計測の結果を見ずに**（過去の計測の記録を読まずに）、開発用の対応表（§6.2）だけから選んだ。凍結した v5（`engine.mjs`・`score-claims.mjs`・`rubric-v5.mjs`）と開発用の定義（`subjects/A〜E.json`・`sets/dev-p1-p10.json`・`sets/scripts/`）は変えていない。

### 6.1 役割と読み方（方法論 `01` §1）

- **落ちの中身（記録・納品物）を調べない。** 読むのは匿名の集計（`score-agent.mjs --anonymous`。§5.3）の数と区間だけ。前後で同じ組（同じ `id`・`version`・同じ採点の定義の実体）を数える
- **調べた題材は開発用へ移し、組の版を上げて基準を測り直す。** 落ちを調べた時点でその題材は回帰用ではなくなる（見た題材で選んだ直しは、その組に適応するから）。移すときは `version` を上げ、§6.2 の対応（機能・書き方・書けない範囲）を保つように題材を補充し、題材と採点のレビュー（Codex・所有者）を経てから基準を測り直す
- **移動で比較から消えた落ちを改善に数えない。** 旧版で確認した劣化は台帳（方法論 `04`）に残し、解消か受け入れの判断まで追う。旧版と新版の成績を、組の変更をまたぐ改善として比較しない
- 最初の変更の前に、この組で**基準を測る**（方法論 `06` §1 の作業 3）。計測の単位は構造の変更 1 wave に **30 本**（§6.4）。予定の本数まで流し切る（止まったら「未完了」。§5.2）

### 6.2 対応表（開発用 P1〜P10 と回帰用 P1〜P10）

回帰用の題材は、開発用の題材と**1 対 1 に対応**する（`MIRROR`：A→R1・B→R2・C→R3・D→R4・E→R5）。対応する題材どうしは、採点の定義の**構造の数・判定の種類と並び・集計の限定・部品の種類・書けない要件の数と申告の鍵**が同じ。試験 `score-agent.test.mjs`（「回帰用の題材の採点の定義は、対応する開発用の題材と…同じ」）がこの対応を機械で固定する。違うのは役割の名前・選択肢の表示名・依頼文の題材と、次の**開発用との差**（Codex のレビューの指摘 1〜3 で足した。開発用の定義は凍結のままなので同じ弱点を持つ。直すなら別の Issue で版を上げる）：

- **境界（指摘 1）**：「1 以上」の検査（R1 の数・R3 の個数・R4 の定員。R4 は両方の構造）に、0 と 1 の間の値（0.5）を拒否する行を足した。`> 0` で書いた宣言は落ちる（語彙は `number` を整数に限定しない）。試験「回帰用の「1 以上」の検査…」が固定する
- **件数と合計（指摘 3）**：人ごとの件数の判定の sources に、件数と数の項目の合計が一致しない数を入れた（R1 の数 2・5・3 → 件数 2・1 ≠ 合計 7・3。R4 の主の構造の定員 4・6・5）。件数を合計に取り違えた宣言は落ちる。依頼文も集計の単位と対象を一意に読める文にした（R1：荷物の件数で「数」の合計ではない。R2：未実施を含む担当の件数。R3 の S2：個数は 1 個以上）。試験「回帰用の人ごとの集計…の sources は、件数と数の項目の合計が一致しない」が固定する
- **主役の名前（指摘 2）**：R1 の主役（荷物）に名前用の `string` の項目を求める役割 `name` を足した。名前の項目を省いた宣言は役割が見つからず落ちる（判定の数は 7 のまま。役割の結び付けで実現し、エンジンは変えていない）

**機能（語彙の構成要素）**：

| # | 覆う範囲（判定の種類） | 開発用 | 回帰用 |
|---|---|---|---|
| 1 | 登録（`creatable`）：entity 2 つ（主役と人）。E・R5 は 3 つ | A・B・C・D・E | R1・R2・R3・R4・R5 |
| 2 | 参照（`ref`）：主役 → 人。E・R5 は 2 本（人と物） | A・B・C・E | R1・R2・R3・R5 |
| 3 | 参照の並び（`list of`）と `len`。主の構造 | D | R4 |
| 4 | 選択肢（`enum`）3 つの「種類」と、一覧の絞り込み（`listFilters`：enum＋ref） | A・B・C | R1・R2・R3 |
| 5 | 状態の選択肢 2 つ：既定値（`enumDefault`）・進めるボタン（`advanceAction`：`set`＋`when`）・ボード（`boardColumns`） | A・B・E | R1・R2・R5 |
| 6 | 数の検査（`validation`：1 以上） | A・C・D | R1・R3・R4 |
| 7 | 並びの長さの検査（`len(list) <= n`） | D | R4 |
| 8 | 直せて消せる（`actionExists`：update・delete） | C | R3 |
| 9 | 人ごとの件数（`computedVisible`：`count`＋`where: this`。`aggregateOnly`） | A・B・D・E | R1・R2・R4・R5 |
| 10 | 人ごとの合計（`sum`＋`where: this`） | C | R3 |
| 11 | 行の式の計算（`len`・引き算）が画面に見える | D | R4 |
| 12 | 日付（`date`）と今日（`today()`）の印（`highlight`）：当日／過ぎた | B（当日）・E（過ぎた） | R2（当日）・R5（過ぎた） |
| 13 | アプリ全体の集計（`scope: app`＋`within: this_month`）の数値の部品（`scopeOnDashboard`：`number`） | C | R3 |
| 14 | 月ごとの集計（`groupBy` の月＋`last: 6`＋`sum`）の棒（`groupChart`：`bar`） | C | R3 |
| 15 | 選択肢ごとの内訳（`groupBy` の enum）の円か棒（`groupChart`：`pie`／`bar`） | C | R3 |
| 16 | 順位の部品（`ranking`）の向き（`rankingOrder`。負の数で書けば「少ない順」として合格・申告は要らない） | B | R2 |
| 17 | 別の構造（決定②：申告が正しければ合格。`PASS_NEEDS_CLAIM`） | D（参加の entity） | R4（参加の entity） |

判定の数（主の構造）：A 7・B 8・C 9・D 6（別の構造 6）・E 7 ＝ R1 7・R2 8・R3 9・R4 6（別の構造 6）・R5 7。

**書き方**：開発用と同じ 2 つ（`S1` 丁寧な箇条書き・`S2` 会話体）。題材ごとに S1 と S2 を 1 本ずつ、**要件の中身は同じで言葉づかいと並べ方だけが違う**（`stage1-patterns.md` §1 の作り方）。識別子を指定しない。曖昧な要件を入れない。**開発用の依頼文に残っている `**` の強調**（文書から写したもの。書けない要件と印の要件に付いている）**は、回帰用には入れていない**（利用者の依頼に近い形にする。差として記録）。

**書けない範囲**：

| 書けない要件（理由） | 開発用 | 回帰用 | 申告の鍵（`unwritable[].keys`） |
|---|---|---|---|
| 回数の**少ない順**に並べる（一覧の `sort` が無い。`ranking` は降順だけ。負の数で書けば書けたことにして申告を数えない） | B | R2 | 少ない・昇順・並べ（`optionalIfWritten`） |
| 参照の並びを**空で登録**できる（`list of` は空を受け取らない。任意の項目が無い）。主の構造 | D | R4 | 0 人・ゼロ・誰も・いなくても・空・あとから・任意・必須 |
| 別の構造での**定員の超過**（検査の式から別の entity の数を見られない） | D（別の構造） | R4（別の構造） | 定員・超 |
| 許される申告（`DEFAULT_ALLOWED`：ボタンの表示名・最初に開く画面） | 全題材 | 全題材 | — |

書ける題材 3（A・C・E ↔ R1・R3・R5。`writable: true`）、一部書けない題材 2（B・D ↔ R2・R4。`writable: false`）。本の ID と書き方と対象範囲の並びも開発用と同じ位置関係（P1・P2 → 1 つ目の題材、…。`writable` は `true, true, false, false, true, true, false, false, true, true`）。

### 6.3 題材（所有者が保留用の題材との重なりを確かめる一覧）

| 題材 | 題名 | 主役 / 人 / その他の entity | 選択肢（表示名） | 対応する開発用 |
|---|---|---|---|---|
| R1 | 引っ越しの荷造り | 荷物 / 家族（メンバー） | 種類：割れ物・本・衣類／状態：未梱包・梱包済み | A |
| R2 | マンションの共用部の点検 | 点検 / 住民 | 種類：消火器・照明・非常口／状態：未実施・実施済み | B |
| R3 | 家庭菜園の収穫 | 収穫 / メンバー | 作物：トマト・きゅうり・なす | C |
| R4 | ボードゲーム会の参加者 | ゲーム会 / メンバー（別の構造：参加） | — | D |
| R5 | 機器の修理の受付 | 修理 / 担当者・機器 | 状態：作業中・完了 | E |

- 選び方：開発用と同じ判定の組を持てる、**よく知られた一般的な業務・趣味の題材**。開発用の 5 題材と別のもの。保留用の題材は見ていない（重なりは所有者が確かめる）
- **開発用の題材の言葉を使わない。** 試験が開発用の定義の題名の語（`subjects/A〜E.json` の `title` を「の」「と」「・」で区切った語）を、回帰用の定義・依頼文・正例負例に当てて確かめる（言葉そのものは試験に書かない）
- 依頼文の正本は定義ファイル（写しの文書は無い。`source` は書かない。条件の `document` は `null`）

### 6.4 本数の組み方（30 本）

**題材 5 × 書き方 2 × 反復 3 ＝ 30 本。** 定義ファイルの本は 10（P1〜P10）で、反復は計測の引数 `--runs 3` で与える（本の名前は `P<n>-r<1..3>`）。

```bash
node workspace/mvp/m1/agent/eval/agent-accept/run-agent.mjs <repo> <out> --effort <effort> --plan --runs 3 \
  --set workspace/mvp/m1/agent/eval/sets/regression-r1.json
node workspace/mvp/m1/agent/eval/agent-accept/score-agent.mjs <repo> <out> --anonymous
```

- 題材を増やさず反復を 3 にした理由：回帰用は**同じ組を数える**組なので、題材の広さより実行のばらつき（方法論 `01` §4「10 パターン × 3 回の前後」）を見る形にそろえる。題材の広さ（未知の題材への一般化）は保留用が担う
- 分母（1 計測）：書ける題材 18 本（R1・R3・R5 × 2 × 3）、一部書けない題材 12 本（R2・R4 × 2 × 3）。要件の分母は主の構造の判定の数から：書ける題材 (7＋9＋7) × 6 ＝ 138、一部書けない題材 (8＋6) × 6 ＝ 84（生成失敗・静的 NG は充足 0 でこの分母に残る。§5.2 の v2）
- 本の ID は組の中で P1〜P10（§5.6.6。照合の道具が `P<n>` を前提にする）。開発用と同じ番号だが、組の ID（`regression-r1`）と出力先で区別する。**同じ出力先に両方の組を流さない**（予定の本の照合が組ごとだから）
- 費用の見込み：1 本 0.032〜0.058 USD（方法論 `01` §5 の参考値）× 30 ＝ 約 1.0〜1.7 USD（完走する本が増えると増える）
- 台本は無い（`script: null`）。Plan の問いは工場の推奨で進み、採点では問いが全部「不明」（`unknown`）として数えられる（問いのある本は `runs_unanswered`。§5.6.3）。回帰用は落ちの中身を調べないので、台本を書く根拠（依頼文と採点の定義だけから決められる事項）を集める作業は別に行う

### 6.5 正例と負例（`cases/regression/`）

**形**：1 本 1 つの JSON。`spec`（宣言 `app.spec.yaml` の**行の配列**。採点では改行でつないで一時ファイルに書く）と、任意の `log`（申告。`cases/*.log.json` と同じ `{ attempts: [{ unwritable: [{ requirement, reason }] }] }`）。索引は `cases.json`（`file`・`subject`・`structure`（当てはまる構造の id。役割が見つからない／静的 NG は `null`）・`expect`（`PASS`／`FAIL`／`STATIC_NG`）・`failed`（落ちる判定の名前の並び。正例は `[]`。役割が見つからないときは `役割が見つかる`）・`codes`（静的 NG の診断コード）・`written`（任意。`rankingOrder` の `written` の期待）・`claims`（任意。申告の判定の期待 `OK`／`NG`）・`missed`（任意。申告の挙げ漏れの数の期待）・`why`）。試験は最終の判定だけでなく、構造・落ちる判定の**集合**・診断コード・`written`・申告の判定と挙げ漏れの数まで索引と照合する（指摘 5。狙いと違う判定で落ちた負例を通さない）。依頼文（§5.6.1）と同じ「行の配列」の形で JSON に収めた（Issue の対象ファイルが `cases/regression/*.json`）。

**確かめ方**：`node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"`（「回帰用の題材の正例・負例…」）。`engine.mjs` の `score` と `score-claims.mjs` の `scoreClaims`・`finalVerdict` で採点し、期待と比べる。API は呼ばない。手で 1 本流すなら、行をつないで `.app.spec.yaml` に書き、`node rubric-v5.mjs <spec-engine の dist> subjects/R1.json <yaml>`。

| ファイル | 題材 | 構造 | 期待 | 落ちる判定（`failed`）／申告 | 何を確かめるか |
|---|---|---|---|---|---|
| `r1-pos-full` | R1 | main | PASS | — | 主の構造で全部満たす（`show` の無い表＝決定①） |
| `r1-neg-filter-without-who` | R1 | main | FAIL | 種類と人で絞り込み | 絞り込みが種類だけ |
| `r1-neg-default-packed` | R1 | main | FAIL | 登録したときの状態 | 登録したときの状態が進んだ側 |
| `r1-neg-no-title` | R1 | — | FAIL | 役割が見つかる | 荷物の名前の項目が無い（指摘 2） |
| `r1-neg-quantity-gt-zero` | R1 | main | FAIL | 数は 1 以上 | 下限を `> 0` で書いた（0.5 を通す。指摘 1） |
| `r1-neg-sum-instead-of-count` | R1 | main | FAIL | 人ごとの件数が見られる | 件数を「数」の合計にした（件数 2 の人が 7。指摘 3） |
| `r2-pos-table-claimed` | R2 | main | PASS | 申告 OK（`written` 偽） | 回数の列を出す表まで。少ない順を書けないと申告 |
| `r2-pos-ranked-fewer-first` | R2 | main | PASS | 申告 OK（`written` 真） | 少ない順を負の数の計算の順位の部品で書いた（申告なしで OK） |
| `r2-neg-ranking-descending` | R2 | main | FAIL | 少ない順を逆向きで書いていない／申告 OK | 少ない順を書けないと申告したうえで、順位の部品を降順のまま置いた（申告 OK のまま順位だけ落ちる。指摘 5） |
| `r2-neg-highlight-before-today` | R2 | main | FAIL | 今日の点検に印／申告 OK | 今日の印の式が「今日より前」 |
| `r2-neg-invented-sort` | R2 | — | STATIC_NG | `SHAPE_KEY_UNKNOWN` | 語彙に無い `sort` を発明した |
| `r3-pos-dashboard` | R3 | main | PASS | — | 数値 2・棒・円の部品、直せて消せる、人ごとの合計 |
| `r3-neg-no-delete` | R3 | main | FAIL | 収穫を直せて消せる | 消す操作が無い |
| `r3-neg-chart-last-12` | R3 | main | FAIL | 月ごとの個数のグラフ（直近 6 か月） | 月ごとのグラフが直近 12 か月 |
| `r3-neg-quantity-gt-zero` | R3 | main | FAIL | 個数は 1 以上 | 下限を `> 0` で書いた（指摘 1） |
| `r4-pos-list-claimed` | R4 | list | PASS | 申告 OK | 主の構造（参照の並び）。0 人で登録できないと申告 |
| `r4-neg-list-without-capacity-check` | R4 | list | FAIL | 定員を超えたら登録できない／申告 OK | 主の構造で定員の超過の検査が無い |
| `r4-neg-list-capacity-gt-zero` | R4 | list | FAIL | 定員は 1 人以上／申告 OK | 主の構造で下限を `> 0` で書いた（指摘 1） |
| `r4-pos-attendance-claimed` | R4 | attendance | PASS | 申告 OK | 別の構造（参加の entity）。定員の超過を書けないと申告 → `PASS_NEEDS_CLAIM` → PASS。下限は `>= 1`（指摘 1） |
| `r4-neg-attendance-not-claimed` | R4 | attendance | FAIL | —／申告 NG（挙げ漏れ 1） | 別の構造で宣言は全部満たす（`PASS_NEEDS_CLAIM`）が申告が無い |
| `r4-neg-attendance-capacity-gt-zero` | R4 | attendance | FAIL | 定員は 1 人以上／申告 OK | 別の構造で下限を `> 0` で書いた（指摘 1） |
| `r5-pos-full` | R5 | main | PASS | — | 3 つの entity と 2 本の参照、納期超過の印、2 つの回数 |
| `r5-neg-highlight-includes-today` | R5 | main | FAIL | 納期を過ぎたものに印 | 印の式が納期当日も含む |
| `r5-neg-device-count-hidden` | R5 | main | FAIL | 機器ごとの回数が見られる | 機器ごとの回数を画面に出していない |

24 本（正例 7・負例 17。別の構造の正例 1・負例 2、申告 NG の負例 1、静的 NG 1、境界 `> 0` の負例 4、件数の取り違えの負例 1、名前の省略の負例 1）。負例は正例の宣言から 1 か所だけ変えて作る（落ちる判定が狙いの 1 つに限られることを索引で固定する）。

**R2 の件数と順位の判定の限界（Codex の再確認の残件。`fix-450b`。窓口が「測れないものとして残す」を採用）**：R2 の「人ごとの件数が見られる」と「少ない順を逆向きで書いていない」の sources は `who` だけを指定し、状態は既定値（未実施）で埋まる。保証するのは**全状態を数える宣言が通る**ことまでで、**状態で数を変える宣言**（主役に数の項目を足して `sum` で集計し、進める操作の `set` でその数を 0 にする形。凍結した採点で再現済み）は 8 判定と申告をすべて通って PASS になり、**落とせない**。凍結した v5 では直せない：役割になるのは entity と項目だけで選択肢の鍵は役割にならず、`setFor` は値をそのまま渡す（鍵の直書きは生成側が別の鍵を選ぶと対応が保てず、しかもこの形は状態で絞らないので落ちない）。集計の `where` は `this` との一致・含む・期間だけで状態では絞れず、状態から旗を作る式も語彙に無い。**開発用の B も既定の状態だけで同じ弱点を持つ**（開発用と回帰用で扱いをそろえた）。直す案は採点の版の変更（§6.6 の次の版）。

### 6.6 足りない範囲・偏り（開発用と回帰用に共通）

- **両方の組に無い語彙**：平均（`avg`）・精算（`settle`・`settlement`）・見出しごとの集計の `where`／`within`・`delete` の `when`・順位の部品を要件として求める「多い順」（`rankingOrder` の `required`）・表示名（`label`）の有無・式に `and` が無いことの申告（「条件を 2 つ重ねる」。`03-evaluation.md` §3 の「語彙の穴」の組）・文字列の比較の検査。これらは回帰用でも測れない（対応を保つことを優先し、範囲を広げていない）
- **書けない要件の種類は 2 つ**（少ない順・空の並び）のまま。語彙の穴の組（`03` §3）が別に要る
- **書き方は 2 つ**（丁寧・会話体）のまま。保留用にある「短いメモ」の書き方は無い
- **偏り**：5 題材のうち 4 つが「主役 → 人」の参照 1 本の構造。一部書けない題材 2 つは、どちらも「人ごとの件数」を含む。回帰用は開発用の構造を写したので、開発用の偏りをそのまま持つ
- **測れるもの・測れないもの（レビューの指摘 4）**：この組で測れるのは、**固定した同型の 5 題材での劣化の信号**だけである。構造・判定の並び・申告の鍵・入力の値まで開発用を写しているので、**開発用の形に合わせた直し（構造への適応）は回帰用でも成功し**、別の参照の構成・機能の組み合わせ・境界・未収録の語彙での劣化は未観測のまま残る（指摘 1・3 は、写しが採点の弱点まで共有した例）。独立性や劣化の不存在の保証には使わない（方法論 `06-transition.md` §1）。**R2 の人ごとの件数と少ない順は、状態で数を変える宣言を落とせない**（§6.5 の限界。開発用の B も同じ）ので、「件数が全状態を数える」ことの劣化はこの組では測れない。匿名の集計では、ある本の改善と別の本の劣化が**相殺**されて合格の数が同じに見えることがある（本ごとの充足の数の分布まで見る。§5.3）。**30 本は 5 題材の反復**であり、30 の独立した題材ではない。未知の題材への一般化は保留用の役割
- **次の版（r2）の方針**（レビュー §3。今回は作らない。版を上げるときは §6.1 のとおり基準を測り直し、旧版と新版の数を改善として直接比較しない）：
  - 候補の成績を見る前に、機能・書き方・書けない範囲の対応表を固定したうえで、**同じ機能を異なる組み合わせや役割の配置で覆う題材を混ぜる**（「主役 → 人」の参照 1 本に偏らせない）
  - 判定の種類と並びの完全一致を固定する試験は、**機能の対応を確かめる試験**に改める
  - 正しい実装と誤った実装の結果が分かれる probes を選ぶ：数量と件数が違う入力・複数の値での計算・対象が 0 件の場合・状態の混在・日付と数の境界（状態の混在は、定義の `set` が選択肢の鍵を宣言に依らず書けないので、エンジンの版を上げるときに。案：sources の行に「進める操作のあとの行」の印を足し、エンジンが `advanceAction` と同じ見つけ方で update の `set` を行にまるごと当てる。鍵は宣言から `keyByLabel` で引くので生成側の鍵に依らない。手元の確認では、この行を 1 つ混ぜると正例の件数は保たれ、§6.5 の「状態で数を変える宣言」は件数と順位で落ちる。窓口が別の Issue の案にする）
  - 採点のエンジンと開発用の定義の凍結は維持し、新しい定義と正例・負例は独立にレビューする（Codex・所有者）
- **採点の指紋**：`subjects/` に R1〜R5 を足したので、`scoringFingerprint` の `subjects/*.json` の並びが変わり、**この変更より前の計測**の条件のファイルとは `scoring_matches_conditions` が不一致になる（A〜E の定義と集計のコードは 1 文字も変えていない。`fingerprints.scoring.files[]` の個々の `sha256` で確かめられる）。この変更のあとに測る前後比較には影響しない

### 6.7 確かめていないこと

- **本物の計測は流していない**（基準は方法論 `06` §1 の作業 3）。依頼文を工場に渡したときの Plan の問い・Build の結果は未観測
- 保留用の題材との重なり（所有者が確かめる）。レビューの指摘を反映した版の再確認は済み（残件 1 件は §6.5 の限界として明記。直していない）
- 正例の宣言が画面（host）で動くこと（静的チェックと spec-engine の評価だけで確かめた。開発用の `stage1-specs/` と同じ範囲）
