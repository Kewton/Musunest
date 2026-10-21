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
| `agent-accept/run-agent.mjs` | 計測。評価セットの定義ファイル（既定は `sets/dev-p1-p10.json`。`--set <パス>` で差し替える）の本 × 回数を工場の入口（`packages/factory/dist/cli.js`）で流す（API を呼ぶ。窓口の手元だけ）。出力先に `conditions.json`（計測の条件）・本ごとのディレクトリ・`run-<時刻>.json`（1 回の起動の記録）を残す。`--pipeline`・`--make-pairs`・`--compare`（v1 と v1.1α を対にして交互に流す Build 比較）は §5.8（#513） |
| `agent-accept/score-agent.mjs` | 採点。条件のファイルに記録された定義ファイル（無ければ既定の `sets/dev-p1-p10.json`。`--set <パス>` で差し替える）を読んで、出力先の本を採点表 v5 で採点し、`score[-label].json` を書く。`--anonymous` なら `score[-label].anonymous.json` だけを書く。Plan を通した本は、原文系と了承後系を別に数え、台本を事後に当てる（§5.5・§5.6）。`--compare` は対にした交互の計測の出力先を採点して `score-compare[-label].json` を書く（§5.8） |
| `agent-accept/freeze-plan-set.mjs` | (b) の凍結（#497。§5.7）。Plan 評価（`run-agent.mjs --plan-only`）の出力先から、P ごとに規則で 1 本の確定した仕様を選び、組のディレクトリ（リポジトリの外）に凍結した組と包みの写しを置く（API を呼ばない） |
| `agent-accept/run-agent.test.mjs`・`agent-accept/score-agent.test.mjs`・`agent-accept/freeze-plan-set.test.mjs` | `node --test "workspace/mvp/m1/agent/eval/agent-accept/*.test.mjs"`（API・ネットワーク無し。計測の試験は偽物の工場で、採点の試験は `cases/` の固定の宣言と凍結したエンジンで閉じる。先に `pnpm build`） |
| `sets/<組の id>.json`・`sets/scripts/<題材>.json` | 評価セットの定義ファイルと、題材ごとの台本（§5.6）。`dev-p1-p10.json` は今の P1〜P10 を同じ形で書き直したもの（依頼文の指紋が `stage1-patterns.md` の表と一致することを試験で確かめる） |

方法論 `methodology/01-eval-sets.md` §2〜§4 の前提のうち、**分母の補正・本数の照合・比較の条件の指紋・匿名の集計**をここで満たす（#425）。**原文と了承後の二系統の採点**は §5.5（#426）。**評価セットの定義ファイルと台本**は §5.6（#427）。**#427 の完了の範囲は「定義ファイルの入口」と「台本の事後の照合（診断）」まで**で、実行中に事項で答える口（工場の変更）は別の Issue（§5.6.3）。

### 5.1 計測の条件（`conditions.json`。schema `musunest-factory/agent-accept-conditions/v5`。v4 は #497、v3 は #427、v2 は #425、v1 は #401）

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
| `params.pipeline`・`params.stage_output_limits_v11a`・`comparison` | **v5（#513。§5.8）**：工場の経路（`v1`／`v1.1a`。`--pipeline` を省けば `v1`）、v1.1α の 4 段の出力の上限（dist に無ければ `null`）、比較の群の印（`--compare` のときだけ。対のファイルの SHA・群・役割・`profile`。それ以外は `null`）。どれも署名に入る。`params.stage_output_limits` には **v1 の出力の 10 段だけ**を表の並びのまま写す（v1.1α の段を足した dist でも、v1 の欄の値は変わらない） |
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
| `completion` | 本数の照合。予定した本（`conditions.json` の `child_args`）・実行した本（要約のある本）・**採点した本（`scored`。行に入れた本の数）**・未実行（ディレクトリが無い）・途中（要約が無い）・予定外（予定に無いディレクトリ）・**採点できない本（`unscored`。採点する組に無い ID の本。行に入れない）**と、いちばん新しい起動の記録の止まった理由（文と `stop_code`）・残りの本・有効だった `budget_usd`。1 本でも残れば `status: "incomplete"`・`label: "未完了"`（**正式な比較基準にしない**、の機械の目印）。**照合の前に条件のファイルを検証する**：既知の schema（v1〜v5）・`child_args` が配列・各 ID が `P<n>-r<n>` の文字列・ID の一意性・`params.patterns` × `params.runs` と予定の一覧の一致・予定が 1 本以上。1 つでも落ちれば `unverified`・「未照合」と理由（入力の値は書かない）で、「完了」に丸めない。条件のファイルが無い出力先（#401 より前）・読めない条件も「未照合」。**予定の本が採点する組に無ければ採点せずに断る**（exit 3。§5.6.4。一部の本だけを含む組で採点して、予定した本を分母から黙って除かないため） |
| `fingerprints` | 採点に使った定義とエンジン（`<repo>` から実際に読み込んだもの）と、組が実際に参照する採点の定義の実体（`definition:<題材>`。§5.1 の `scoring`）と、集計のコード（**実行中の `score-agent.mjs`**。`scoring.aggregator` にパスと SHA-256）の指紋（`scoring`）と spec-engine の `dist` の指紋、条件のファイルに記録された値、その一致（`scoring_matches_conditions`・`spec_engine_matches_conditions`。条件に無ければ `null`）。別の checkout を `<repo>` に渡して採点しても、`<repo>` の旧い採点器の指紋を「一致」と出さない |

v5 の条件（#513）では `evaluation.pipeline`（既知の値か `unknown`）を足す。v1〜v4 の条件の出力の `evaluation` は今までの形のまま（`pipeline` の欄を出さない）。照合の 3 段（未照合・未完了・完了）の読み方は、比較の採点（§5.8.5）も同じ言葉を使う。

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

- 問数と往復の平均の分母は、往復の記録の `rounds` が配列の本。自由入力は `rounds[].answers[].free_text` が文字列の答えの数（`null` は数えない）。`rounds` か各往復の `answers` が配列でない記録と、JSON として読めない記録は `unreadable` に数え、読めて 0 件の本（`answers` に 0 を足すだけ）と区別する
- **今まで採点が止まっていた入力の扱い**（分類の無害化の例外とは別。欠けた・読めない入力を、既存の「記録なし」の計算へ渡すだけ）：往復の記録は採点を止めずに読む。JSON として読めない記録は、既存の行・表では記録なし（`null`）として扱う。既存の行の問数・往復は今までの式のまま数え、**今まで値が出ていた入力（形が違っても）は今までの値を変えない**（例：往復の `questions` が文字列なら、その長さ）。今までの式が例外で止まった形（`rounds` が写像・文字列、往復が `null` など）だけを 0 に写して続ける。採点の式・予定の分母・PASS の判定は変えない
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

### 5.8 v1 と v1.1α の Build 比較（#513。設計書 `../07-architecture-v1.1a.md` §4・D7・D17・追加判断 B）

v1（比較元の checkout。main `2cd1586f856fb1cdecf75ef035826cbffe539e69`）と v1.1α（候補の checkout）を、同じ凍結した組から**同じ時間帯に交互に**流し、原文系 PASS の**対の差**で読む。本物の計測は窓口が手元で流す（API を呼ぶ）。試験は偽物の工場の入口と固定の記録で閉じる。

#### 5.8.1 口（`run-agent.mjs`）

| 口 | 中身 |
|---|---|
| `--pipeline v1\|v1.1a` | 既定 `v1`。`v1.1a` は `--build-from` と一緒にだけ受け、子の引数の**末尾**に `--pipeline v1.1a` を足す。`v1` と省略は子に何も足さない（今までと同じ引数・同じ署名）。知らない値・値の無い指定・組めない組は `flags:conflict` |
| `--make-pairs <出力> --build-from <組> [--runs 3]` | 対のファイルを書く（子を起こさない）。採用した P（組の順）× 1〜`runs` を並べ、先行の群を `v1` から交互にする。同じ入力からは同じバイト列。出力が既にあれば `compare:pairs-exists` で上書きしない |
| `--compare --baseline <比較元の checkout> --pairs <対のファイル> --build-from <組> --budget-usd <上限> [--concurrency 3] [--effort・--deadline-min・--factory-budget-usd・--model]` | 対にした交互の計測。群 `v1` ＝ 比較元の checkout の入口と cwd（`--pipeline` 無し）、群 `v1.1a` ＝ `<repo>` の入口（`--pipeline v1.1a`）。ほかの引数と写し（依頼文・包み）は両群で同じ。`--only`・`--runs`・`--resume`・`--plan`・`--plan-only`・`--script`・`--pipeline`・`--make-pairs` とは組めない（`flags:conflict`）。`--budget-usd` は必須（`compare:budget-required`）。比較は再開しない（前の結果のある出力先は `compare:prior-output`） |

#### 5.8.2 ファイル

| ファイル | 中身 |
|---|---|
| 対のファイル（`--pairs`） | schema `musunest-eval/compare-pairs/v1`：`frozen_sha256`（凍結した組のファイル全体の SHA-256）・`groups`（`["v1","v1.1a"]`）・`runs`・`pairs[]`（`pid`・`r`・`first`）。対の順と先行順は起動の前に固定する |
| `<out>/pairs.json` | 対のファイルのバイト列の写し（採点がこの SHA を照らす。記録には SHA だけを書く） |
| `<out>/v1/`・`<out>/v1.1a/` | 群ごとの計測。今までと同じ形の `conditions.json`（v5。`comparison`＝対の SHA・群・役割（`baseline`／`candidate`）・`profile`）・本のディレクトリ・`run-<時刻>.json`。群ごとに `score-agent.mjs` でそのまま採点できる。条件の `child_args` は checkout と群のディレクトリからの相対のパスで書く（比較元のパスを記録に写さない。実際に渡す引数は絶対パス） |
| `<out>/comparison.json`（`COMPARISON_FILE`） | 比較の記録（schema `musunest-eval/compare-record/v1`）：対の SHA・数・回数、群ごとの指紋（工場の dist・`source`・spec-engine・生成に渡す文書・2 つの上限の欄・工場の既定・条件の署名）、共有の指紋（組・採点・台本・判定の口の構成・凍結した組・依頼文の出どころ・effort・model・1 本の予算と締切）、`profile` と違った項目、並列・上限・1 本の予約・採点の費用 0・`signature`。**鍵の値・パス・子の出力は書かない** |
| `<out>/compare-run-<時刻>.json`（`COMPARE_RUN_PREFIX`） | 比較の起動の記録：対ごとの状態（`both`＝両方／`first-only`＝先行だけ／`unstarted`＝未起動）・起こさなかった本の一覧・起こした本の数・止まった理由と符号（`budget` か `null`）・済みの額・止めたときに走っていた本の数・群ごとの済みの額と終了の分類 |

#### 5.8.3 起動の前の照合と正式な比較の条件

- **意図した差**は工場の dist・commit・dirty・経路・v1.1α の上限の欄だけ。採点・組・台本・判定の構成・凍結した組は `<repo>` の道具の側から取り、両群で共有する（採点は生成のあとに全本へ同じ版を当てるため）。spec-engine の dist・生成に渡す文書・effort・model・予算・締切・**v1 の 10 段の上限**が両群で違えば `compare:fingerprint-differs`（違った欄の名前だけを出す）。工場の既定（effort・1 本の予算・締切・model・推論の既定・語彙の版・鍵の環境変数の名前）が違えば `compare:defaults-differ`
- 候補の **v1.1α の 4 段**が A1 の承認値（`name-table`・`test-spec` 32,768、`semantic-check`・`decl-check` 16,384）と違えば（無いときも）`compare:limits-unapproved`。包みの検査は両群の dist の関数をそれぞれ当てる（符号は `--build-from` と同じ）
- 対のファイルの検査：版と群（`compare:pairs-schema`）・凍結した組の SHA（`pairs-frozen`）・`runs` が正の整数（`pairs-runs`）・0 対（`pairs-empty`）・各対の形（`pairs-shape`）・重複（`pairs-duplicate`）・採用 P × 1〜`runs` の欠落（`pairs-missing`）と余り（`pairs-extra`）・ファイルの順に交互（`pairs-alternation`）・読めない（`pairs-unreadable`）。読めない比較元は `compare:baseline-unreadable`。**どの断りでも子を起こさず、exit 3・固定の符号の 1 行で、何も書かない**
- **正式な比較の条件**（定数 `OFFICIAL_COMPARE`）：比較元の commit が `2cd1586…` で dirty でない・凍結した組 v1 のファイル全体の SHA-256 が `1bed5c0e8cadbc504f3378337b3ea7b8335229ebb135cc7f7760e80ddcd0c9d9`（`id` `dev-p1-p10-b-408b202`・版 1・採用 10 P。同じ id・版で中身が違えば満たさない）・反復 3・effort high・締切 20 分・1 本 0.30 USD・合計の並列 3・全体の上限 5 USD・採点 v5。全部満たせば `profile` は `official`、違えば `diagnostic`（**断らない**。違った項目の名前だけを残す）

#### 5.8.4 起動の順・並列・全体の予算の打ち切り（D17）

- 対の順 × 先行順を 1 本の待ち行列にし、`--concurrency`（既定 3。**両群の合計**）の枠が空くたびに先頭を起こす
- 起こす直前に「**済みの額＋走行中の本の予約＋新しく起こす 1 本の予約 ≤ 上限**」のときだけ起こす（等しければ起こす。1 本の予約＝`--factory-budget-usd`。100 万分の 1 USD の整数で比べる）。超えればそれ以降を起こさず、走行中の本は終わるまで待つ。済みの額は終わった本の要約の費用（生成と判定を含む今までの欄）。**採点は API を呼ばないので費用 0 と記録する**（採点のコードに通信の import が無いことを試験で確かめる）
- 各本の締切・予算の停止は終端の結果（延長も流し直しもしない）。比較でない計測の止め方（済みの額だけを見る）は変えない

#### 5.8.5 採点（`score-agent.mjs <repo> <out> --compare [--label x] [--anonymous]`）と読み方

- 両群を今の関数（§5.2 の採点）で採点してから対を組む。**断る（`compare:scoring-mismatch`。exit 3）**：対のファイルの写しの SHA が比較の記録と両群の条件で一致しない・群の `params` が `pipeline` と v1.1α の上限の欄以外で違う・どちらかの群に予定外の本。比較の記録か群のディレクトリが無ければ `compare:record-missing`。**予定の内側の不足**（予算・締切で止めた正常な計測の未実行・途中）は断らない
- **差の向き**：対ごとに原文系 PASS を 0／1 にして **差＝候補（v1.1a）− 比較元（v1）**。両方が終わった対の数 n、＋1／0／−1 の件数、平均と区間（平均 ± 1.96 × 標本標準偏差 ÷ √n。n < 2 は `null`）。片側だけの対は差 `null` で n に入れない。締切・予算で止まった本は PASS 0 で分母に残る。**区間は参考**で、成績の確定ではない（追加判断 B）
- **P 別と反復**：`pairs.by_pattern` に P ごとの差の並び（反復は同じ P の下）と平均。各群の率と Wilson の区間（`pass_executed`・`pass_planned`）は実行のばらつきの参考で、**対の差の区間の代わりにならない**。了承後系は群ごとに UNEVALUATED・FAIL の数と、落ちた判定の鍵（匿名の口では出さない）
- **停止段**（群ごと）：`failure` があれば `段:種類`、無ければ `stop_reason`。`limit` は A5 の `verification-v11a.json` の `decl_check.exhausted` が 1 以上なら `decl-check:limit`。A5 の停止の名前 5 つ（`name-table:unmet`・`semantic-check:malformed`・`test-spec:unmet`・`decl-check:malformed`・`carry-over:unmet`）と `decl-check:limit` は 0 件も並べる。知らない値は `unknown`。**`carry-over:unmet` は全件持ち越しだけでなく、除いた行を参照する行が残ったときにも出る**（工場の判定 none。PR #519 の既知の制限）
- **到達数**（群ごと）：段ごとに、段の記録に現れた本の数と予定数。**0 件は「今回未観測（0/予定）」**と分母を併記する（観測が無いことと 0 件であることを分ける）
- **持ち越し**（群ごと。v1 は `null`）：`carry-over.json` の `entries[].reasons[].origin` から出どころ 4 つ（`name-table`・`semantic-check`・`decl-check`・`coverage`）の件数（要件ごとに出どころを 1 回）と、持ち越しのある本の数。記録の無い本・読めない本は欠測に数える
- **照合**：(i) どちらかの群の照合が「未照合」か、採点のときの指紋の照合（`scoring`・`spec_engine`・`set`・`scripts`・`frozen` の `*_matches_conditions`）に false か null があれば `unverified`・「**未照合**」（どれが false か null かを `completion.unverified` に出す）。(ii) そうでなく、全対が両方終わり・両群の照合が完了・予算の停止の記録が無く・`profile` が `official` のときだけ `complete`・「完了」。(iii) それ以外は `incomplete`・「**未完了**」（`diagnostic` は「未完了・診断」）。**未照合は「比べてよいかが確かめられない」、未完了は「確かめられたが正式な比較の条件を満たさない」。** `complete` 以外は `reference_only` 真（参考値で、正式な比較基準にしない）
- 出力は `score-compare[-label].json`（`SCORE_COMPARE_FILE`）と標準出力（対ごとの 1 行・P ごとの 1 行・比較の 1 行）。`--anonymous` なら `score-compare[-label].anonymous.json` だけで、件数・率・区間・既知の値だけを出す（本の ID・P の ID・パス・落ちた判定の鍵・知らない値は出さない）

#### 5.8.6 規則と停止の台帳

- v1.1α の規則（`R-nt`・`R-sc`・`R-tsp`・`R-dc`・`R-w11`）は `../methodology/ledger/rules.md` §5 に 1 要素 1 行で写した。行の数と ID の集合は `score-agent.test.mjs` が工場の dist の配列と照らす
- v1.1α の新しい危険 N1〜N8 は `../methodology/ledger/failure-modes.md` の別の節（計測前。観測は「今回未観測」）

#### 5.8.7 限界（#513 で直していないこと）

- `--pipeline v1.1a` を受ける工場の入口は #511。入る前の工場では候補の群の子が `--pipeline` を受けられないので、本物の比較は #511 が入ってから流す。子の引数は #511 のあとに窓口が実物で確かめる
- 比較は再開しない。途中で止めた比較は、別の出力先で対のファイルからやり直す（事前に固定した対の順とばらつきの読みを崩さないため、止まった本の流し直しはしない）

### 5.9 漏斗・pass^k・工場の判定の 4 値（#538。設計書 `../08-architecture-v1.2.md` §7・§8.1・§8.4。v1.2 の手 0a）

既存の記録（`summary.line.json` の要約・`bundle/artifacts/verification.json`・`verification-v11a.json`）から、どの段で失うか・同じ P で k 回とも通るか・工場が「確かめられなかった」を出した本の数を集計する。**足しただけ**：既存の欄の名前・意味・並び・値と、採点の規則（判定・PASS・分母・集計の版・了承後系・区間の算出）、指紋の算出と照合の方法は変えない。新しい欄は出力のいちばん後ろ（行では既存の鍵のあと）に足す。費用は 0（集計のコードだけ。API を呼ばない）。段単位の実行口（§8.3）と、対の差を段ごとに取る比較は別の Issue。

#### 5.9.1 漏斗（`funnel`）

- 段は `BUILD_STAGE_IDS` の順（v1 の 12 段と v1.1α の 7 段）。**v1 と v1.1α の記録の形に同じ規則を当てる**（段の名前が違うだけ）。段ごとに 4 つを数える：
  - **到達**（`reached`）：その段の記録が要約の `stages` に 1 つ以上ある本
  - **1 回目で通過**（`first_pass`）：その段の**最初の記録**が `status` ok・`calls` 1・`retries.shape` 0・`retries.content` 0（`retries` が無い記録は ok と `calls` 1 だけで決める。通信の再送 `retries.communication` は数えない）
  - **通過**（`passed`）：その段のどれかの記録が ok
  - **停止**（`stopped`）：要約の `failure.stage` がその段
- **適用外**：到達した本の記録が全部 `calls` 0 の段（コードの段。静的の検査・試験の実行・判定など）は「1 回目で通過」を `null` にする（件数も率も `null`。`code_stage` 真）。**未到達の 0 とは別**で、到達 0 の段の 1 回目は 0 と「今回未観測」になる
- **v1.2 手 3 の新しい 2 段**（`vocabulary`＝C1・`mapping`＝C2。`BUILD_STAGE_IDS` の末尾）：束ごとに 1 記録になるので、**1 回目で通過は全記録を集約**する（全記録が §上の条件を満たすとき 1。既存の段は今までどおり最初の記録だけ）。**2 段の行は、採点する本のどれかの記録に新しい段があるときだけ**漏斗・停止の 0 件の行（`vocabulary:unmet`・`mapping:unmet`）・到達・匿名の既知の段に足す。無い入力の出力は今までとバイト列で同じ
- **分母は 2 つ並べる**：件数は**予定本数**（条件の `child_args`。未実行・途中の本は到達 0 で分母に残る。`planned`・`reached_label` ＝ 到達／予定）、条件付き率は**到達本数**（`rates`。数と Wilson の区間。到達 0 なら「今回未観測（0/予定）」）。予定を検証できない条件では採点した本を分母にする（§5.2 の `metrics_plan` と同じ）
- **完走の内訳**（`completed`）：要約の `stop_class` が completed の本（失敗の無い本。stagnation・limit で止まった本を含む）を、`verification.json` の `test_mismatches` と `test_unresolved` がともに 0 の本（`no_mismatch`）とそれ以外（`with_mismatch`）に分ける。記録が無い・欄が整数でない本は欠測（`missing`）に数え、0 と推測しない
- **停止段の内訳**（`stops`）：§5.8.5 の停止段の値（`段:種類`・`stop_reason`・`decl-check:limit`・知らない値は `unknown`）ごとの本数。比較の群の `stops.values` と同じ値になる

#### 5.9.2 pass^k（`pass_k`）

- P ごとに、その P の全反復（k は条件の `params.runs`。P の一覧は `params.patterns`）が原文系 PASS なら 1。P の数を分母に件数と率（Wilson）。**未実行・途中・締切で止まった本は PASS 0**（途中の本は宣言があっても 0）
- `by_pattern` に P ごとの 0／1 の並び（反復の順）。標準出力は 1 行（例：`pass^3: 1/10（…）（P1 1,0,0・…）`）

#### 5.9.3 工場の判定の 4 値（`rows[].factory_verdict4`・`rows[].unverified_details`）

- **正本は D1 の明示的な欄**：要約の `verdict` が partial で、要約の `assurance` が `unverified` のときだけ `unverified`。それ以外は `verdict` と同じ（`full`／`partial`／`none`。知らない値は `unknown`、要約か `verdict` が無ければ `absent`）
- **検証の記録の `unverified` の内訳（件数）から本の判定を復元しない。** 「不一致 1・未検証 2」の本は partial であり、内訳があることは本が unverified である証拠ではない（設計書 §7 は partial の理由が優先）。内訳は `unverified_details` に件数だけを数える（`verification.json` の `unverified` が配列なら要素の数、0 以上の整数ならその値。記録か欄が無ければ `null`。欠測を 0 と推測しない）。集計は `unverified_details`（実行した本・読めた本・欠測・件数の合計・1 件以上の本の数）
- **既存の `factory_verdict`・`metrics.factory_verdicts`・`tables` の工場の verdict は変えない**（unverified の本も partial のまま）。4 値は別の欄に足す
- **欄が無ければ従来どおり**：今の工場は `assurance` に `unverified` を載せないので、今の記録（v1・v1.1α）では `unverified` は 0 件で、判定・件数・区間は変わらない

#### 5.9.4 判定の 3 系統（`verdicts`）

- 原文系（PASS／FAIL／STATIC_NG／GEN_FAIL）・了承後系（PASS／FAIL／UNEVALUATED／STATIC_NG／`not_applicable` ＝ 了承後の判定が無い本）・工場の 4 値（と `unknown`・`absent`）を**別に**数え、混ぜない。値は既知の列挙に写し、知らない値は `unknown`
- 件数（`counts`）の分母は予定本数（原文系・了承後系の未実行・途中の本は `not_run`、工場の 4 値では `absent`）。別に条件付き率を、実行した本の中（`executed`）と納品のある本（宣言がある本）の中（`delivered`）で出す

#### 5.9.5 比較・匿名の口・標準出力

- `--compare` は群ごとに `funnel`・`pass_k`・`verdicts`（各群の採点の出力の欄そのまま）を足す。既存の比較の欄（対の差・停止段・到達数・持ち越し・照合）は変えない。段ごとの対の差は手 0b
- `--anonymous` には `funnel`・`pass_k`・`verdicts`・`unverified_details` の件数と率だけを足す（段の ID は既知の一覧、停止段は既知の値か `unknown`。`pass_k.by_pattern`・P の ID・本の ID・鍵の値は出さない）。`--compare --anonymous` も群ごとに同じ
- 標準出力は、既存の行のあとに漏斗の 1 行（到達した段だけ。`段 到達／1 回目／通過／停止`、適用外は「—」、完走の内訳）と pass^k の 1 行を足す（`--compare` は群ごとに 2 行）。既存の行は変えない

#### 5.9.6 採点のコード自身の指紋が変わること

- 採点の指紋（§5.1・§5.2）は集計のコード（このファイル）の SHA-256 を含む。#538 でこのファイルを直したので、**集計のコードの SHA と、それを含む採点の総合の指紋が変わる**。直す前に記録した条件を採点し直すと `scoring_matches_conditions` が偽（「採点の指紋が条件と不一致」）になり、比較の照合はそれで「未照合」になる（`completion.unverified` に `scoring_matches_conditions` が出る）。**旧いハッシュを固定して一致に見せない**（証跡を偽らない）。値が変わってよいのはこの指紋と、そこから導かれる照合の結果だけで、ほかの既存の欄の値は直す前と同じ

### 5.10 内外の表・不一致と未解決の試験の分類・段の役割ごとの対の差・P のまとまり（#539。設計書 `../08-architecture-v1.2.md` §8.2・§8.7。v1.2 の手 0b）

工場が partial にした本が外の採点では PASS だったとき、その食い違いの切り分け（§8.2）を毎回の計測で機械で出し、比較を §8.7（D6）の読み方に合わせる。**足しただけ**：既存の欄と §5.9 の欄の名前・意味・並び・値と、採点の規則（判定・PASS・分母・集計の版・了承後系・区間の算出）、指紋の算出と照合の方法は変えない。新しい欄は出力のいちばん後ろに足す（`agreement`・`test_findings`。比較は群ごとに同じ 2 つと、出力の後ろに `stage_pairs`・`pattern_clusters`）。費用は 0（集計のコードだけ。API を呼ばない）。値が変わってよいのは §5.9.6 と同じ例外（採点のコード自身の指紋と、それに由来する照合）だけ。

#### 5.10.1 内外の表（`agreement`）

- 実行した本ごとに（工場の 4 値 × 原文系の判定 PASS／FAIL／STATIC_NG／GEN_FAIL）の組を取り、組ごとの件数の表（`source.table`。行は工場の 4 値と `unknown`・`absent`、列は原文系の値と `unknown`）を出す。0 でない組だけを `source.cells`（鍵は `工場×外`。例：`partial×PASS`）にも並べる
- 了承後系の判定も同じ形で別の表に出す（`accepted`。列は §5.9.4 の了承後系の値）。2 つの系は混ぜない
- **分母は予定本数**（`planned`）。未実行・途中の本は表に入れず、別の行（`not_run`）に数える。値の写し方は §5.9.4 の `verdicts` と同じ
- 比較では群ごとに同じ欄を足す

#### 5.10.2 不一致・未解決の試験の分類（`test_findings`）

- **読取元**：正本は試験の結果の記録（`bundle/artifacts/tests.json` の `mismatches` と `unresolved`。鍵は `testId`）。検証の記録（`verification.json` の `partial_reasons.unresolved_tests`。鍵は `test_id`）は**同じ最終結果の写し**として扱う
- **重複の排除**：鍵の名前を正規化して、**試験 ID だけを鍵に**突き合わせる（不一致と未解決の種類をまたぐ）。**同じ本・同じ試験・同じ理由は 1 件**（`source` が `both`）。片側だけにある試験はその側で補う（`tests`／`verification`）。**同じ試験 ID で理由の文が違えば 1 件として数え（種類と文は正本のもの）、その試験 ID を `inconsistent` に 1 つ数える**（黙って別件にしない）。正本 `tests` の不一致（`mismatches`）にある試験 ID が検証の記録の `unresolved_tests` にもあれば、不一致の 1 件とし（`source` が `both`）、検証の記録は補完と食い違いの確認にだけ使う。正本の中で不一致と未解決に同じ試験 ID があるときも、先に読む不一致の 1 件とする。要素の形が違う（試験 ID か `detail` が文字列でない）ものは `malformed` に数え、分類しない
- **欠測**：2 つの記録がどちらも読めない（無い・JSON でない・欄が配列でない）本は欠測（`missing`）。片方だけ読めればその側で数える（`sources` に本の数）。対象は実行した本。v1 と v1.1α で読む欄は同じ
- **分類**：`detail`（評価器の固定文）を定数の表 `FINDING_PATTERNS`（正規表現の並び）に**上から順に当て、最初に当たったもの**。表の文は評価器の全文を写す（`…` は名前や数が入る位置）。工場のコードと dist は import しない

| 分類 | 固定文の形 |
|---|---|
| `binding-defect` | 「表の ID が指す場所が宣言に無い」「試験の対象の ID が名前の表に無い」「selector（…）の対応（…）に当たる … の場所が対応表の外にある」「selector（…）に対応表の項目が無い」「selector（…）に提出された対応が無い（1 つに決まらない）」「selector（…）に当たる … の場所が無い」「… 個あり、1 つに決まらない」「参照データの対象（…）が実在の entity に結び付かない」「試験 … が結び付けの表に無い（1 つに決まらない）」「… に提出された対応が無い」 |
| `evaluator-coverage` | 「評価の方法の表で未対応である（…）」「操作 … に条件（when）が無く、実行は評価器で確かめられない」「操作の実行（set を当てたあとの状態）は評価器で確かめられない」 |
| `test-defect` | 「… の期待は真偽（true / false）であること」「入力が写像（object）でない」「構造の検査の中身（assertion）が無い」「view-shows の表示を期待する役割 ID（role）が無い」 |
| `needs-human`（値の不一致と宣言側の不足。人が見る） | 「… が期待と違う（期待 …、実際 …）」「… が成り立った（期待は成り立たないこと）」「… が値を返した（期待は求められないこと）」「検査 … が落ちた（…）」「検査 … が落ちなかった（…）」「宣言に … が無い」「entity … に項目 … が無い」「項目 … の種類が …（期待 …）」「項目 … の参照先が …（期待 …）」「一覧 … は … を表示しない」「項目 … は画面から辿れない（entity … の一覧か表に出ていない）」「… に create の操作も、一覧か表の表示も無い」 |
| `unknown` | どれにも当たらない（件数を出す。工場が固定文を変えたら `unknown` が増えて気づける）。**断らない。既存の判定・PASS に使わない** |

- 表のどの文も 2 つの形に当たらない（試験で全組み合わせを確かめる）。「宣言に … が無い」は評価器の書き方（「宣言に操作 … が無い」のように「に」の直後に空白が無い形と、「宣言に entity … が無い」の形）の両方に当たる
- **出し方**：本ごとに分類ごとの件数（`by_run`。試験 ID と `detail` の原文と `source` はここにだけ残す）、群と全体の合計（`classes`・`findings`・`mismatches`・`unresolved`・`inconsistent`・`malformed`）。**分類は記録の読み方であり、採点の判定・PASS・分母には触れない**

#### 5.10.3 比較：段の役割ごとの対の差（`stage_pairs`）

- **段の役割の対応表**（定数 `STAGE_ROLES`）：設計＝`design`／`name-table`、試験＝`test-suite`／`test-spec`、書く＝`write`、点検＝`correspondence`／`decl-check`、実行＝`run-tests`、判定＝`judge`（比較元 v1／候補 v1.1α）
- **設計の役割の新しい読み方**（v1.1α の段の名前で引く群＝v1.1a・v1.2）：本の要約の段の記録に `name-table` が無く `vocabulary` が 1 つ以上あれば、**到達＝`vocabulary` の記録が 1 つ以上／通過＝`semantic-check` の記録がある（C1・C2 の全束を通って C3 に渡った印。`mapping` のどれかが ok でも C3 に届かなければ通過でない）／1 回目で通過＝通過かつ `vocabulary`・`mapping` の全記録が 1 回目で通過**。`name-table` だけの本・両方ある本・どちらも無い本は今までの規則
- 対ごとに §5.9.1 の「到達」「1 回目で通過」「通過」をそれぞれ 0／1 にし、**差＝候補 − 比較元**を取る。件数（＋1／0／−1）・n・平均・区間は既存の対の差と同じ関数（`pairStats`。区間は参考）で出す
- **有効な対を指標ごとに定める**：両側で指標が定義されている対だけを n に入れる。次の対は差 `null` で n から除き、理由ごとの数を `excluded` に出す
  - `not_applicable`（**適用外**）：片側でもその群の漏斗で 1 回目で通過が `null`（コードの段。§5.9.1）。実行（v1 はコードの段、v1.1α は未到達）と判定（両群ともコードの段）の 1 回目で通過は、今の記録では n＝0 で、平均・区間・P の集計も `null`
  - `missing`（**欠測**）：片側でも要約が読めないか、段の記録（`stages`）が配列でない
  - `one_side`：片側だけ実行された対（未実行・途中を含む）
- **未到達の 0 と適用外の `null` を区別する**：段に届かなかった本は 0 の測定値として n に入る（両側とも届かない対は差 0）。適用外は測定値ではない
- `rows` に対ごとの差と理由を残す（行つきの出力だけ）

#### 5.10.4 比較：P をまとまりにした符号反転と bootstrap（`pattern_clusters`・各指標の `clusters`）

- 原文系 PASS の対の差（既存）と段の役割ごとの差を、**P ごとに平均**する（m 個。m は有効な対のある P の数。丸めずに計算する）。設計書 §8.7 のとおり **P を単位にした区間と検定を主にする**：
  - **(i) 符号反転の両側 p**（`sign_flip.p`）：P 平均の符号を 2^m 通り全部入れ替え、平均の絶対値が観測以上になる割合。m が 12（`SIGN_FLIP_MAX_CLUSTERS`）を超えれば `null` と理由
  - **(ii) P を単位にした bootstrap の区間**（`bootstrap.interval`）：P 平均を復元抽出した平均の 2.5・97.5 百分位（線形補間）。回数と乱数の種は定数（`BOOTSTRAP`：10000 回・種 539）で、同じ入力で同じ値
  - **参考の t 区間**（`t_reference`）：P 平均の平均 ± t(0.975, m−1) × 標本標準偏差 ÷ √m。前提は P 間の独立と P 平均の正規近似で、まとまりが少ないと近似が粗い。**主の読み方には使わない**
  - m＜2 なら区間と p は `null`（理由つき）
- **読み方と限界**：P は題材 5 × 書き方 2 で、P 間の独立は仮定である。符号反転は帰無仮説の下で P 平均の符号が交換可能であることを前提にする。まとまりは 10 個しかなく、検出できる差は大きい（同じ「改善 8・回帰 1」でも改善が 3 P に集中すれば P 単位の両側 p は 0.25。独立な対の正確検定なら 0.039）。**非有意は「差が無い」ではなく「検出されず」**
- 既存の対の差（`pairs` の件数・平均・区間）は**独立な対の参考**としてそのまま並べ、P 単位の結果と区別する（`independent_reference`）。不一致の対の件数（`discordant`：＋1 と −1 の数）も並べるが、**「8 対 1 以上」を確定の信号にする旗は置かない**（記述的な警報）。非有意を同等の証明にしない

#### 5.10.5 匿名の口・標準出力

- `--anonymous` には `agreement` の件数（既知の値の表）と `test_findings` の件数（分類ごと・読みの状態ごと・`inconsistent`・`malformed`・欠測）を足す。`--compare --anonymous` は群ごとに同じ 2 つと、段の役割ごとの差の件数・n・平均・区間・除いた数・P の集計（m・平均・p・区間）を足す。**本の ID・P の ID・P ごとの平均・試験 ID・`detail`・鍵の値は出さない**
- 標準出力：通常の採点は内外の表と分類の 1 行（`内外の表（予定 … 本・実行 … 本・未実行と途中 … 本。工場×外）: 原文系 …／了承後系 …・試験の分類（…）: …`）を、指紋・漏斗・pass^k の行の前に足す。`--compare` は群ごとの内外の表の 1 行と、P のまとまりの 1 行（PASS の差と、段の役割ごとの通過の差の P 平均の平均・p・bootstrap の区間・参考の t 区間・不一致の対の件数）を最後に足す。既存の行は変えない（`--compare` の JSON の行には #539 の欄を入れない）

### 5.11 段単位の走り（凍結した上流からの N 本・段の通過率・段だけの対の比較。#545。設計書 `../08-architecture-v1.2.md` §8.3・§8.6。v1.2 の手 0d）

門を変えないバグの直しは、独立レビューと**変えた段だけの計測**で merge する（2026-10-17 所有者の決定 C）。工場の段単位の実行口（手 0c。工場の README §2.1）を計測の道具から本ごとに当てて N 本流し、採点で段の通過率を出し、凍結した前の候補と今の候補を同じ上流の入力で対にして比べる。**新しい旗を省けば、計測の子の引数・条件のファイル・採点の JSON・匿名の口・標準出力は今と同じ**（値が変わってよいのは §5.9.6 と同じ例外：採点のコード自身の指紋と、それに由来する照合だけ）。採点の費用は 0。計測の費用の見込みは設計書 §8.3・§8.6（変えた段の前後 各 30 本で 0.4〜2.3 USD × 2）。

#### 5.11.1 旗（`run-agent.mjs`）

- `--stage-start <段>`・`--stage-end <段>`・`--stage-from <凍結した上流の計測の出力先>`。**`--pipeline v1.1a` と `--build-from <組>` と組んでだけ受ける**（それ以外は `flags:conflict`）。段の名前・範囲の決め方・境界は工場の dist（`packages/factory/dist/v11a/bundle-v11a.js`）が公開する定数と関数を読む（道具の中に段の表を持たない）。片方だけ付ければ他方は経路の端（工場と同じ）
- 開始が T1（`name-table`）なら `--stage-from` を付けられない。T2（`test-spec`）・B1（`write`）なら必須。表に無い段・開始が終了より後も `flags:conflict`
- 区間 0（開始 T1・終了 T1''）の段の表に `vocabulary`・`mapping` を足した（`name-table`・`semantic-check`・`carry-over` はそのまま）。区間 1 以降の記録に出れば「段の履歴が範囲と合わない」。工場の dist との照合の試験は、採点の段の表と dist の段の表が深く等しいことを見る（採点が先に足した段を許す定数は手 3a で外した）
- 対象の本は `--build-from` と同じ（採用した P × 回数。`--only` は採用した P の部分集合）
- 子の引数の末尾に `--stage-start <開始> --stage-end <終了>` と、開始の段の直前の境界があれば `--stage-input <本のディレクトリ>/stage-input/stage-checkpoint-<境界>.json` を足す。上流の checkpoint と段の走りの記録は、照合を通ったバイト列のまま本のディレクトリの `stage-input/` に写す（工場は checkpoint の隣の記録を読む）
- **予算と締切の単位は段の走り 1 本**：`--factory-budget-usd`・`--deadline-min` は今までどおり子ごとに `--budget`・`--deadline` で渡し、工場がその走りの始まりから当てる（前の走りの額と時間を引かない）。計測全体の目安の額（`--budget-usd`）の扱いは今と同じで、済みの額は段の走りの記録の `provider_cost_usd` から足す

#### 5.11.2 上流の照合と符号（子を起こす前。exit 4）

- 上流の計測の条件（`<上流>/conditions.json`）：版 v6・`params.mode` が `stage-run`・署名が中身と合う・定義ファイルと凍結した組の SHA が今と同じ・範囲が開始の段の直前の境界を通る。合わなければ `stage-from:conditions-missing`・`stage-from:conditions-unreadable`・`stage-from:conditions-invalid`・`stage-from:conditions-frozen`・`stage-from:range`
- 本ごと：上流の段の走りの記録（`<上流>/<本>/bundle/stage-run.json`）が読める（`stage-from:stage-input:unreadable`）・形の版（`stage-from:stage-input:version`）・範囲が上流の条件と同じ（`stage-from:record-range`）・確定した仕様と依頼文の SHA が凍結した組の値と同じ（`stage-from:stage-input:plan-sha256`・`stage-from:stage-input:source-sha256`）
- 境界の checkpoint を宣言した本には、**工場の dist の照合の関数（`verifyStageInput`）**を checkpoint と記録に当てる（出力ダイジェスト・表・点検・持ち越しの導き直し・試験の組を含む。記録に残した照合の結果は信頼しない）。比較では両群の checkout の関数を同じ写しに当てる。断れば `stage-from:<工場の符号>`（例：`stage-from:stage-input:table-sha256`。工場の符号の一覧に無い値は `stage-from:stage-input:unknown`）
- どの断りも **exit 4**、標準エラーに `断りました: [<符号>] ids=<本の ID> count=<件数>` の 1 行（値・パスは出さない）で、**子を 1 本も起こさず、出力先に何も書かない**。exit 3（使い方・再開の断り）と取り違えない

#### 5.11.3 入力なしの本（`stage_input_absent`）

- **入力なしにするのは、照合を通った上流の段の走りの記録が、境界の checkpoint を宣言せず、範囲の中で境界へ未到達と確認できる本だけ**：停止（`stopped`）が写像で、段は境界より前の段（上流の範囲の開始の区間から境界の直前の区間までの開始・終了の段と、区間 0 の持ち越しの導出 `carry-over`）・種類は既知の値、`stage_pass` が偽・`exit_code` が 1、段の履歴（`stages`）が全部境界より前の段で、到達した段（`reached_stage`）が履歴の最後と停止の段に一致し、宣言した境界は全部それより前。どれかが合わない宣言なしの記録（境界より後の段まで到達・停止した記録、不正な形の停止など）は壊れた記録として `stage-from:record-inconsistent`（exit 4・子 0 本・何も書かない）で断る。その本は起こさず、条件のファイルの `stage_input_absent`（`count` と `ids`）に残す。子の引数（`child_args[].argv`）は `null` で、予定の一覧には残す（予定は 採用した P × 回数 のまま）
- 境界に届いて checkpoint を宣言したのに材料が無い・壊れている本、上流の段の走りの記録が読めない・壊れている本、早期停止を示さずに宣言の無い本は**入力なしにしない**（上の符号で断る）
- 採点は入力なしの本を**黙って分母から除かない**：照合（`completion`）では未実行に数えず `stage_input_absent` に件数を出し、段の通過率では別の行（`input_absent`）に出す

#### 5.11.4 条件のファイル（v6。段単位の走りのときだけ）

- 版は `musunest-factory/agent-accept-conditions/v6`。`params.mode` が `stage-run`、`params` に `stage_start`・`stage_end`・`budget_scope`（`stage-run`。工場の dist の値）・`stage_from`（上流の条件のファイルの SHA-256・署名・範囲。開始 T1 は `null`）・`stage_inputs`（本ごとの上流の checkpoint と記録の SHA-256。入力なしの本は記録の SHA と `absent: true`）を足し、直下に `stage_input_absent` を足す。どれも署名に入る
- `--resume` は署名の一致でだけ許す（**範囲・上流・本ごとの入力を変えた再開は `resume:signature` で断る**）。入力なしの本は再開でも起こさない
- 起動の記録（`summary.line.json`）には `stage_run`（`stage_pass`・`reached_stage`・`stopped` の段と種類・`provider_cost_usd`・`exit_code`。既知の値と数だけ）を足す。要約の行が無いので `summary` は `null`。標準出力の 1 本の行は `verdict=` の代わりに `stage=<開始>..<終了> … stage_pass=<真偽>` を出す。段単位の走りは publish しない（工場が納品物を書かない）

#### 5.11.5 採点：段の通過率（`stage_pass_rate`）と納品の成功の違い

- **段の通過は納品の成功ではない**。工場の段の走りの記録の `stage_pass`（範囲の中に早期停止が無く、終了の段の最後の記録が ok）を本ごとに読み、`stage_pass_rate` に出す。PASS・納品の成功・`verdict` の名前で出さない。終了が ⑦ なら ⑦ の判定（`stage_judge_verdict`）の件数を別に出す（`stage_judge_verdicts`）。停止は 段:種類 の件数（`stops`）
- 件数は別々に出す：**対象予定**（`planned`。採用した P × 回数。子を起こす前に条件のファイルへ固定）・**入力なし**（`input_absent`）・**起動**（`launched`）・**観測**（`observed`。起動して段の走りの記録が読めた）・**欠測**（`missing` ＝ 予定 − 入力なし − 観測。内訳 `missing_breakdown`：未起動 `unlaunched`・記録なし `unreadable`・条件と食い違う `mismatched`。D17 の予算の停止で起こさなかった本は未起動のまま数え、`budget_pending` に件数を出す）・**通過**（`passed`）
- 記録は条件に結べたときだけ観測に数える：範囲（`range`）が条件の `stage_start`・`stage_end` と同じ、確定した仕様と依頼文の SHA が凍結した組のその P の値と同じ、入力の対応（開始 T1 は記録の `input` が `null` で本ごとの入力の欄が無い。それ以外は記録の `input` が指す本のディレクトリの `stage-input/` の写しの SHA-256 が `stage_inputs` の値と同じで、checkpoint の境界が記録の入力の境界と同じで、記録の入力の出力ダイジェスト `input.output_digest` が、写した上流の記録のその checkpoint の宣言の値と同じ）・段の履歴と範囲の整合（段の履歴・到達の段・停止の段が範囲の区間の段だけで、到達の段が履歴の最後、段の通過が「停止なし・終了の段の最後の記録が ok」と一致。区間の表 `STAGE_SEGMENTS` は工場の dist が区間の端の段しか公開しないので手で写して持ち、B 区間（write..judge）には B3'・B6 で全件持ち越しになったときの `carry-over`（停止 `carry-over`・`unmet`。正当な不通過）を含む。試験で、dist の `STAGE_STARTS`・`STAGE_ENDS` の段と `STAGE_BOUNDARIES` の境界の両側の段が手の表にあること、手の表の段が dist の `STAGE_IDS` の段であること、工場の dist で B6 が全試験を棄却した記録が観測・不通過・照合 complete に数えられ漏斗に `carry-over` が出ることを確かめる）。食い違う記録は通過に数えず欠測の `mismatched` に数え、行の `mismatches`（`range`・`plan-source`・`input`・`stages`）に理由を残し、照合は**未照合**（理由つき）。漏斗も結べた記録だけから作る
- **率の分母は 予定 − 入力なし**（`denominator`。起動の前に決まる。未起動の本を分母から消さない）。率（`rate`）と Wilson の 95% 区間（`interval`）は同じ分母で、分母が 0 なら `null`
- 段単位の計測では、原文系・了承後系の PASS と納品の欄（`metrics`・`metrics_accepted`・`fulfillment`・`verdicts`・`pass_k`・`agreement` など）を**計算しない**：`null` にして `not_computed`（理由 `stage-run` と欄の一覧）を添える。`evaluation.build_applicable` は偽
- 漏斗（§5.9.1）は範囲の中の段（段の走りの記録に現れた段）だけに当て、分母は 予定 − 入力なし
- **段単位でない条件の採点には新しい欄を置かない**（`stage_pass_rate`・`not_computed`・`stage_run`・照合の `stage_input_absent` が無い）

#### 5.11.6 段だけの対の比較（`--compare` と段の旗）と読み方

- 対のファイル：`run-agent.mjs <repo> <out> --make-pairs <対> --build-from <組> --pipeline v1.1a --stage-start <段> [--stage-end <段>] [--stage-from <上流>] [--runs 3]`。上流の照合（§5.11.2）のあと、**上流の入力のある本だけ**（採用した P の順 × 回数）で対を書く（版 `musunest-eval/stage-compare-pairs/v1`。範囲と上流の条件の SHA を結ぶ）。交互の順は今の比較と同じ関数
- 計測：`--compare --baseline <凍結した前の候補の checkout> --pairs <対> --build-from <組> --pipeline v1.1a --stage-start … --stage-from … --budget-usd <上限>`。群は **`before`**（`--baseline` の checkout。役割 baseline）と **`after`**（`<repo>`。役割 candidate）で、v1／v1.1α の比較の群とは別の定数。**両群とも v1.1α の経路で、同じ本に同じ上流の入力のバイト列を渡す**。対のファイルが上流の入力のある本・範囲・上流と合わなければ `compare:pairs-missing`・`compare:pairs-extra`・`compare:pairs-stage` で断る。起こす直前の額の確かめ（D17）は今の比較と同じ関数。v1.1α の 4 段の上限は両群で A1 の承認値を確かめる。正式な比較の条件（§5.8.3 の profile）は当てない
- 採点：`score-agent.mjs <repo> <out> --compare` が比較の記録の版（`musunest-eval/stage-compare-record/v1`）で段だけの対の比較と見分け、`score-compare[-label].json`（版 `musunest-eval/score-stage-compare/v1`）に書く。両群を段単位の採点で採点し、対ごとに段の通過の差（**after − before**）を取る。件数（＋1／0／−1）・n・平均・区間は今の対の差と同じ関数（§5.8.5）、P のまとまりの符号反転の p と bootstrap の区間は手 0b の関数（§5.10.4。t 区間は参考）。片側が未起動・欠測の対は差 `null` で n に入れず、理由ごとの件数（`excluded`）を出す。入力なしの本は対に入らず、件数（`input_absent`）を別に出す
- **読み方**：段の評価の利点は**上流を固定して効果を局所化すること**であり、「不一致の対が増えて見やすい」ことではない（設計書 §8.3・§8.7）。主は変えた段の通過率の対の差で、全体の PASS の対の差は数 wave ごとにまとめる 30 対の比較で読む。**非有意は「差が無い」ではなく「検出されず」**

#### 5.11.7 匿名の口・標準出力

- `--anonymous`（段単位の採点）は、照合と指紋（今と同じ形。条件の版に v6 を足す）・評価の種類・範囲・`not_computed`・段の通過率の件数・率・区間・停止と ⑦ の判定の件数・範囲の中の漏斗だけ。`--compare --anonymous` は対の差の件数・n・平均・区間・除いた数・P の集計（m・平均・p・区間）と、群ごとの照合・指紋・段の通過率。**本の ID・P の ID・上流の SHA は出さない**
- 標準出力：段単位の採点は、要約の JSON・本ごとの行・照合の行・段の通過の 1 行（`段の通過（範囲 <開始>..<終了>。納品の成功ではない）: 通過 …／予定 …・入力なし …・起動 …・観測 …・欠測 …（…）・率 …`）・漏斗の行・指紋の行を出す（計算しない欄の行は出さない）。段だけの対の比較は、要約の JSON・対ごとの行・群ごとの段の通過の行と、比較の 1 行を出す。段単位でない採点の行は変えない

### 5.12 試験の点検（変異）（#554。設計書 `../08-architecture-v1.2.md` §9 の手 5 の後半。v1.2 の手 5b）

手 5a（`mutation/mutate.mjs`・`mutation/classify.mjs`）が凍結した宣言から作って分類した変異に、凍結した候補の**固定した試験**を、工場の B3（名前の照合）・B4（試験の評価）と同じ評価口と、工場が使ったのと同じ有効な評価の文脈で掛け、「試験が変異を落とせるか」を数える（`mutation/score-mutants.mjs`）。**計測の道具であって、工場の門ではない**：工場の合否・門・検証の定義に入らず、工場の段からこの道具を呼ばず、工場の側のどのファイルもこの道具を参照しない。**費用 0**（API・LLM・判定を呼ばない。B3'・判定は呼ばない。時計を使わない）。

#### 5.12.1 演算子と分類の優先順・結果の定義

- 演算子は手 5a のもの（変えない）：`remove-field`（項目を消す）・`flip-comparison`（比較を反転）・`remove-when`（when を消す）・`reorder-options`（選択肢の順を替える）・`change-default`（既定値を替える）・`remove-validation`（検査を消す）・`swap-aggregate`（集計の種類を替える）
- 変異は、**優先順のある排他的な分類**で 1 つにだけ入る。上から：原本不適（手 5a）→ **試験と原本が合わない**（原本に B3 の落ち・B4 の不一致・未解決がある候補。変異は全部ここ）→ 静的に落ちる → 食い違い → 構文の同値 → 同値（人の印）→ 判定不能 → 適格な変異（非同値（確定））の 4 つの結果
- 適格な変異の結果は **1 つにだけ**入る：**試験で落ちる**（B4 の不一致が 1 件以上）／**結び付けで落ちる**（B3 の落ちがあり、B4 の不一致は 0）／**未解決だけ**（B3 の落ち・B4 の不一致が 0 で、未解決が 1 件以上）／**生き残る**（どれも 0）
- 試験ごとに、落とした変異（その試験が B4 で不一致になった変異）の数を数える。対象の要件の適格な変異（変えた場所が、**その試験の対象の行**（`target.roleId`）に当たる。同じ要件に所属する別の行に当たるだけの変異は当たらない。検査は表の行が無いので当たらない）が 1 つ以上あるのに 1 つも落とさない試験を**落とせない試験**に数える

#### 5.12.2 検出率・分母・条件付きであること・選別の偏り

- **適格な変異**＝原本が使え（手 5a）・試験と原本が合い・静的チェックを通り・非同値（確定）の変異。**主の検出率**＝試験で落ちる ÷ 適格な変異。**副の検出率**＝（試験で落ちる＋結び付けで落ちる）÷ 同じ分母。**落とせない試験の率**＝落とせない試験 ÷ 適格な変異を対象に持つ試験。**この 3 つの分母に判定不能・同値・食い違いを入れない**
- 検出率は適格な変異に限る**条件付きの率**である。判定不能を除く**選別**のため、外の採点で差の出やすい変異に偏る。変異の全体の検出率ではなく、読むときは「適格な変異のうち」と添える
- **分類の割合の分母**（別の欄）＝原本が使え、試験と原本が合う候補の、静的チェックを通った変異の全部（構文の同値・食い違い・判定不能を含む）。例：非同値 4・判定不能 2・同値 1 なら同値の率は 1 ÷ 7、食い違いが 1 あれば 1 ÷ 8。同値の率は構文の同値と同値（人の印）の和で、内訳も別に出す
- **分母 0 は 0% にしない**：率と区間を `null` にし、理由の固定の符号（`no-eligible-mutants`・`no-classified-mutants`・`no-tests-with-eligible-mutants`）を付ける
- 別に数える：同値（構文・人の印）・食い違い・判定不能・静的に落ちる・作れなかった（手 5a の `not_built`）・原本不適・試験と原本が合わない・未解決だけ。演算子ごと・P ごと・候補ごとの内訳も出す

#### 5.12.3 区間・まとまりが少ないこと

- 変異は同じ原本・同じ試験で相関するので、Wilson の 95% 区間は **「参考（独立を仮定）」**（`wilson95_reference`）の名で出す。**一般化の区間は出さない**。候補ごと・P ごとの率と**まとまりの数**（候補の数・P の数・適格な変異のある P の数。`clusters`）を並べる。**まとまりが少ない**ので、率はこの**凍結した集合の記述**に限り、別の題材・別の候補への一般化の根拠にしない

#### 5.12.4 入力（目録と有効な評価の文脈の凍結）と照合

- 入力は**目録**（schema `musunest-eval/mutation-score-inventory/v1`）だけ。候補ごとに、P の番号・反復の番号・題材の定義・原本の宣言・手 5a の出力（`classify.mjs` の出力のファイル。埋め込まれた変異の原文だけを評価する）・印のファイル（任意）・**有効な評価の文脈**を、場所と SHA-256 で持つ。版は、工場の dist と spec-engine の dist の入口と**ファイルごとの SHA-256 の一覧**・ほかの依存のファイル（`dependency_files`。例：appspec-schema の dist・各パッケージの `package.json`）の SHA-256 の一覧・工場の commit・採点のエンジンの SHA-256
- **有効な評価の文脈**（schema `musunest-eval/mutation-score-context/v1`）は、工場が使ったものを**直接凍結したファイル**：名前の表（`table`。行・所属）・要件の一覧（`list`。持ち越しと要件でない文を除いた有効な一覧）・有効な試験の組（`suite`。棄却で外した後）・所属（`ownership`）・除く行の ID（`excluded_row_ids`）・観測する性質の写像（`observes`）・持ち越しの entries（`carry_over`）・棄却した試験の ID（`rejected_test_ids`）・要件でない文の ID（`non_requirements`。無い版は空の配列と明記）・台帳の旗（`ledger.on`）。有効な組に棄却した試験が残る・一覧に持ち越しの要件か要件でない文が残る、は食い違いとして断る
- **読む前に SHA-256 を全部照らす**：目録のファイル（版・候補）を読んで照らし、さらに手 5a の出力に書かれた原本・題材の定義・印の指紋と照らす。変異ごとに、埋め込まれた原文から計算した SHA-256 が出力の値と一致することを、評価の前に確かめる。**1 つでも合わなければ何も数えずに断る**（**終了コード 3**・固定の符号。fail-closed）。断りの符号：`hash_mismatch`・`origin_sha_mismatch`・`subject_sha_mismatch`・`marks_mismatch`・`mutant_sha_mismatch`・`context_inconsistent`・`invalid_context`・`invalid_inventory`・`dependency_unlisted`・`dependency_unresolved` ほか。標準エラーは「符号 固定文」の 1 行で、入力の値は写さない
- **依存の照合（実際の読み込みで止める）**：正は Node の読み込みそのものである。dist を import する前に `node:module` の `register` で resolve・load の hook（道具の中の data: の URL）を入れ、評価が終わるまでの見張りの窓の間、`file:` のファイルは**目録に載ったもの**（load では Node が読んだ原文の SHA-256 が目録と合うもの）か**道具のコード**（`score-mutants.mjs`・`classify.mjs`・`mutate.mjs`）だけを通し、`node:` の組み込みは通し、それ以外（目録に無いファイル・data: など）は断る。目録に無ければ `dependency_unlisted`、SHA-256 が合わなければ `hash_mismatch` で、exit 3・固定文・出力なし。ESM はグラフの全部を読み終えてから評価するので、静的な import の断りはどのモジュールの評価よりも前に起きる（注釈を挟む `import /* … */ "./x.mjs"` のような書き方でも同じ）。評価の途中の `import()`（実行時に指定子を組むものを含む）も同じ hook を通る
- **前段の早い断り（静的な閉包）**：hook を入れる前に、2 つの入口から import の閉包（静的な import・`export … from`・副作用の import・文字列の `import()`。bare の指定子は `node_modules` の `package.json` の `exports` で解き、各 `.js` の形を決める最寄りの `package.json` も含める）を、目録に載ったファイルだけを読んで求め、目録に無い・解けない（`dependency_unresolved`）ものを先に断る。正規表現で指定子を拾うので取りこぼし得る（その分は上の hook が止める）。`package.json` は Node が resolve のときに内部で読み hook を通らないので、この閉包と目録の SHA-256 で結ぶ
- **目録のコードの走査と保証の前提**：hook は import の読み込みしか見ないので、hook を通らずにコードを読み込み・実行する口（同期の `require`・`createRequire`・`node:module`・`node:vm`・`eval`・`Function` のコンストラクタ）が、目録に載ったコード（`.js`・`.mjs`・`.cjs`）の中身に 1 つでもあれば、評価の前に `forbidden_api` で断る（exit 3・固定文・出力なし）。保証の前提は「dist は tsc の出力で、これらの口を持たない。持つ dist は断る」である。**今の dist は入力のファイルを fs で読むので fs は見ない。fs で読んだ中身をコードとして実行する口は eval・Function・vm の走査で断る**。見ている範囲は、Node の import の読み込み（hook）と目録のコードの文字列としての走査（指定子の閉包・上の 6 つの口）までで、それ以外（fs で読む中身そのもの・子プロセス・難読化した書き方で口を組み立てるコードなど）は見ていない。**この道具は sandbox ではない**：悪意のあるコードを閉じ込めるためではなく、「凍結した版の dist で測った」ことを確かめるためのものである
- **走査の字句の分けと限界**：6 つの口は原文への正規表現ではなく、依存を足さない小さな字句の分けを通してから照合する（行コメント・ブロックコメントを外し、文字列（`'`・`"`）とテンプレート（`` ` ``）の中身はコードとして見ない。`Function /* … */ (…)` のように注釈を挟む呼び出しも口に数え、注釈・文字列の中の語は数えない。`node:module`・`node:vm` は指定子の位置（`from`・`import`・`import(`・`require(` の直後）の文字列の値で照合する）。限界：正規表現リテラルは直前の字句から推測して読み飛ばすので、推測を誤ると後ろの字句がずれ得る。テンプレートの中の式（`${…}`）はコードとして読むが、式を持つテンプレートの値は指定子の照合に使わない。sandbox ではない・名前を組み立てる難読化は見ない、の前提は上のとおり
- hook はプロセスに残るが、呼び出しごとの見張りの窓（共有の旗）が開いている間だけ働く。すでに読み込まれたモジュールは読み直されないので、凍結の保証は**新しいプロセス**（入口の `node score-mutants.mjs`）で得る。試験は別プロセスで入口を起こし、注釈を挟む import で目録に無いファイルを読む入口が断られること（対照：目録に足すと通る）、読み込みの時点で内容が入れ替わったファイルが `hash_mismatch` で断られること、Node の読み込みが目録と道具のコードの内側に収まることを確かめる
- **道具は目録に載ったファイルだけを読む**（自分のコードを除く）。評価の規則は写して持たず、工場の dist（`createV11aEvaluator`）を目録の場所から動的に読み、凍結した文脈で作って呼ぶ。工場の package を静的に import しない

#### 5.12.5 出力・匿名の口・使い方

- `node workspace/mvp/m1/agent/eval/mutation/score-mutants.mjs <目録の JSON> --out <出力の JSON> [--anonymous]`（先に `pnpm build`）。出力は JSON（schema `musunest-eval/mutation-test-score/v1`。定義の欄・指紋・まとまりの数・全体・演算子ごと・P ごと・候補ごとの変異の結果と試験ごとの数）と、標準出力の要約。指紋は道具のコードの SHA-256・工場の commit・両 dist の一覧の SHA-256・採点のエンジンの SHA-256・目録の SHA-256。同じ入力からは同じ出力になる
- **`--anonymous`** は件数と率と演算子の ID だけ。P の番号・候補の ID・宣言の名前・パス・SHA-256（指紋を含む）を出さない。候補ごと・P ごとの率は名前を付けずに並べる
- この道具の結果は工場の**門ではない**。合否・`verdict`・`stop_reason`・終了コード・やり直しの回数・締切・予算・呼び出しの上限・v1 の振る舞いを変えない

### 5.13 経路 v1.2 と比較の群の組（Build 比較の続き。#557。設計書 `../08-architecture-v1.2.md` §8.6・§8.7・§9 の手 2・手 4）

§5.8 の Build 比較に、工場の経路 v1.2（#547。merge 済みの v1.2 の旗を全部 on・prompt_version `v1.2`）と、比較の群の組の選択を足す。**新しい旗（`--pipeline v1.2`・`--compare-pipelines`）を省けば、子の引数・条件・対のファイル・比較の記録・起動の記録・採点の JSON・標準出力・匿名の口は今と同じ**（値が変わってよいのは道具と採点のコード自身の指紋と、それに由来する照合だけ）。試験は偽物の工場の入口と固定の記録で閉じる。

#### 5.13.1 口（`run-agent.mjs`）

| 口 | 中身 |
|---|---|
| `--pipeline v1.2` | `v1.1a` と同じく `--build-from` と一緒にだけ受け、子の引数の**末尾**に `--pipeline v1.2` を足す。値の無い指定・知らない値・組めない組（`--plan`・`--plan-only`・`--script`・段単位の走りの旗）は `flags:conflict`。段単位の走りと v1.2 の組み合わせは、工場の段の口が v1.2 を受けることを確かめてから別の Issue で足す。標準出力の本ごとの行には v1.2 のときだけ ` pipeline=v1.2` が付く |
| `--compare-pipelines <比較元>,<候補>` | 受ける組は `v1,v1.1a`（省略と同じ）・`v1.1a,v1.2`・`v1,v1.2` だけ（同じ値・知らない値・ほかの組・3 つ以上は `flags:conflict`）。`--compare` か `--make-pairs` と一緒にだけ受ける。**段だけの対の比較（§5.11.6）の旗とは、どの組でも一緒に受けない**（`flags:conflict`・子 0）。群の名前は群の経路の名前（`<out>/<経路>`）、役割は比較元 `baseline`・候補 `candidate`。比較元の群は `--baseline` の checkout、候補の群は `<repo>` で流す（**`--baseline` に `<repo>` と同じ checkout を渡してよい**） |

- `--make-pairs` は選んだ群を対のファイルの `groups` に書き、先行の群を比較元から交互にする。`--compare` は対のファイルの `groups` が選んだ群と同じでなければ `compare:pairs-schema` で断る
- 経路の一覧（`PIPELINES`）と群の組（`COMPARE_PIPELINE_PAIRS`）は `score-agent.mjs` の定数で、計測と採点が共有する（別に手書きしない）

#### 5.13.2 旗の組の読み方（工場の公開の値・報告との照合・未照合）

- **正本は工場の公開の値**：子を起こす前に、工場の dist の package の入口（`packages/factory/dist/index.js`）の `V12_PIPELINE_FLAGS`（旗の名前 → 真偽）を読み、条件の `params.v12_flags` に写す。**計測の側で旗の名前を手書きしない**（後の手の旗は工場が同じ正本に足すので、道具を直さずに条件と記録に載る）。export が無い、または旗の名前 → 真偽の写像でない（値が真偽でない・空・配列など）なら **exit 3・`pipeline:v1.2-unavailable`** で子を 1 本も起こさない。旗の組は条件の署名に入るので、組が変わった `--resume` は `resume:signature` で断る（v1.2 の再開は、保存した条件を v7 として検証し署名を中身から計算し直して照らす。知らない版・書き換えた条件も同じ符号で断る）
- **報告との照合**：子が終わったら、その本の要約（標準出力の headless-summary の `v12_flags`）と条件の記録（`bundle/build-record.json` の `conditions.v12_flags`）を読み（推定しない）、条件の組と**名前 → 真偽の集合として**照らす（キーの順だけの違いは一致）。本ごとの記録（`summary.line.json` の `v12_flags`）に、2 つの報告（`present`／`absent`／`malformed` と組）と結果を残す。結果は強い順に `malformed`（不正形）＞ `missing`（欠測）＞ `inconsistent`（要約と条件の記録の食い違い）＞ `mismatch`（条件と不一致）＞ `match`（一致）。起動の記録（`run-<時刻>.json`）には、出力先の**全部の本の記録**（`--resume` で飛ばした前回の完了本を含む）から照らし直した件数と一致しない本を残す
- **未照合**：採点は本ごとの記録の報告を条件の組と照らし直す（記録に残した結果は信頼しない）。**起動した本**のうち 1 本でも一致しなければ照合を `unverified`・「**未照合**」にし、`completion.unverified` に `v12-flags` を出す（`complete` に丸めない）。未起動の本（予算で止めた本など）は今の未実行・途中のまま（未照合に数えない）。未照合は計測の照合の状態で、**工場の verdict と PASS の判定は変えない**
- 採点の出力：`evaluation.pipeline` に `v1.2`、v1.2 の条件のときだけ `evaluation.v12_flags`（条件の組・`verified`／`unverified`・起動した本の数・結果ごとの本の数・一致しない本）と標準出力の `旗の組（v1.2）: …` の 1 行。漏斗・到達・停止・持ち越し・段の役割ごとの対の差は v1.1α の段の名前と同じ表で数える
- 匿名の口：経路と、照合を通った旗の名前と真偽（通らなければ `null`）と件数だけ（本の ID・P の ID は出さない）

#### 5.13.3 schema の版の照合

- 条件の schema は **v1.2 のときだけ `musunest-factory/agent-accept-conditions/v7`**（v5 に `params.v12_flags` を足した。v6 は段単位の走り #545 の版）。`v1`・`v1.1a`・省略の条件は今の v5 のまま
- 群の照合（計測の起動の前と比較の採点）は、v1.2 を含む組では各群の条件を既知の版として個別に検証してから（`v1`・`v1.1a` は v5、`v1.2` は v7 と旗の組の形）、両方から共通の比較の形（経路・v1.1α の上限の欄・旗の組・版を除く）を組んで照らす。保存する条件と署名は元のまま。**知らない版・群と合わない版は `compare:conditions-version`、段単位の走りの条件（v6）との混在は `compare:conditions-stage`** で断る。`v1,v1.1a` の組の扱い（知らない版は照合で未照合）は今のまま
- 起動の前の照合の**意図した差**に、`v12_flags` と schema の版の差を足す（経路と v1.1α の上限の欄と同じ扱い）。各群の署名と工場の報告の照合からは除かない。両群の条件の署名が同じなら今と同じく断る

#### 5.13.4 3 つの組の正式な条件の扱い

- **v1.1α の 4 段の上限の承認値の検査**は、経路が `v1.1a` か `v1.2` の群すべてに当てる（違えば `compare:limits-unapproved`）
- **正式な比較の条件（`OFFICIAL_COMPARE`）は変えない。** 比較元が `v1` の組（`v1,v1.1a`・`v1,v1.2`）は今の定数で `official`／`diagnostic` を判定する。`v1.1a,v1.2` の組は `diagnostic`（違った項目に `pipelines`）にして断らない。採点と匿名の口は理由 `pipelines` を残す
- 比較の記録（`comparison.json`）の群ごとの欄と群の条件に、群の経路と（v1.2 の群は）`v12_flags` を残す。比較の採点は比較の記録の `pairs.groups` から群の組を読み、差の向きの文を「**候補（<候補>）− 比較元（<比較元>）**」に組み立てる（`v1,v1.1a` では今の文と同じ文字列）。段の役割の対応表（§5.10.3）は v1.2 の群を v1.1α の段の名前で引く。群の入れ替え・複製は今と同じく `compare:scoring-mismatch`
- 段だけの対の比較（§5.11.6。群 `before`・`after`）は今のまま（新しい旗を省いた対・条件・採点は変えない）

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

## 7. 表の採点（正解の表との照合）（#606。v1.2 表の採点 1。道具 `table/score-table.mjs`）

手 3（T1 を C1・C2 に分ける）の前後で、工場の ②部品の一覧・③要件と部品の結び付けを、段の通過や外の採点の PASS ではなく**正解の表と直接比べて**測る。要件ごとに 3 問——(i) 必要な部品が全部在る（**欠け**）、(ii) 許す集合の外の所属が無い（**過剰**）、(iii) **確かめ方**が許す集合に入る——を 0／1 で出す。**計測の道具であって工場の門ではない**（工場の合否・門・検証の定義に入らない。工場の package を import せず、工場の側もこの道具を参照しない）。**費用 0**（LLM・判定・API・通信・時計を使わない。Jev も入れない）。

> 節の番号：§5 の末尾（§5.13 の次）に置くと、既存の試験が固定している見出しの並び（§5.11〜§5.13 の次が §6）が変わるので、§7 として末尾に足した。§5 以前・§6 の文は変えていない。

### 7.1 使い方と入力

```bash
node table/score-table.mjs <正解のディレクトリ> <計測の出力先> <出力先> [--compare] [--anonymous]
```

- **正解は非公開**で git の外に置く（採点担当が作る。所有者の決定 2026-10-18）。道具は場所を引数で受け取るだけで、**正解の場所に既定値を持たない**。正解の文（引用・意味・質問・理由・除外の文）は出力に写さない
- 正解のディレクトリ：`*.json` だけを名前の順に読み（同じ場所の `schema.md`・`README.md` などは読まない）、1 ファイル＝1 P。形（版 `table-gold-v1`。欄の名前と型は現物に合わせた。#606 の窓口の確認）：
  - 必須：`version`・`pattern`（`P<n>`）・`plan_set`（`id`・`version`・`manifest_sha256`）・`plan_sha256`・`counts`（件数。値は整数）・`components`（**配列。`symbol` で索引**。`kind`・`type`）・`requirements`（**配列。`requirement_id` で索引**。P をまたいで同じ ID が出るので P の中で一意として扱う。`variants`＝案の並び。案は `id`・`required`・`allowed`・`context`・`verification`＝**長さ 1 の配列**）・`needs_human`（保留の一覧。`requirement_id`・`reason_kind`・`candidates`）
  - 部品の任意の欄：親 entity `entity`・参照先 `refEntity`・`groupBy`（`kind`・`field`＝記号）・`options`（配列。**数は配列の長さ**）・`semantics`（あれば意味の未照合の印）・`design_family`
  - **任意の欄**（無ければ null と同じで、**無いだけで断らない**）：判定の状態 `adjudication_status`・`unexpressible`（`scope` は `"<設計族>-family-only"` の形だけ）・`verification_limit`・`scope`（除外の部分。読まない）・`related_requirement_ids`（保留の一覧にある。要件の側も読む）。案の任意の欄：設計族 `design_family`・禁止の部品 `forbidden_components`・方針 `entity_field_policy`・案の `unexpressible`
  - 確かめ方（配列の 1 要素）：`kind` と、structural は `checks`・`assertions`（`check`・`target`＝記号・`expected`・`refEntity`）、fixed-test は `observations`（`target`＝記号・`target_kind`・`operation`）、unresolved は `reason_kind`
  - 文の欄（`meaning_quote`・`rationale`・`review_evidence`・`question`・`text` など）と `provenance` などは読まない
  - 必須の欄が欠ける・型が違う・確かめ方の配列の長さが 1 以外・`unexpressible.scope` の形が違う（`table-score:gold-shape`）・版が違う（`table-score:gold-version`）・読めない（`table-score:gold-unreadable`）・同じ P が 2 つ（`table-score:gold-duplicate`）正解は**何も数えず断る**
- 計測の出力先：条件のファイル（`conditions.json`。予定 `child_args` と凍結した組 `frozen`＝`id`・`version`・`adopted[]` の `pattern`・`plan_sha256`）と本ごとのディレクトリ
- **表の読取元**（**観測の単位は本。1 本に表 1 つ**）：(a) **受理済みの表**（納品物の成果物の名前の表 `bundle/artifacts/name-table.json`）、(b) 段の走りの **checkpoint** の `name_table`（境界 t1-t2。`bundle/stage-checkpoint-t1-t2.json`。形は (a) と同じ）。1 本に両方あれば (a) を採り (b) は件数（`checkpoint_also`）だけ。どちらも無い本は「表なし」（表なしの本の中に、T1 を通ったが納品物の無い本＝修復の上限や後の段で止まり受理済みの表がどこにも残らない本がある。直すのは工場の側）。`source` が null の表（旗 ids on の受理済みの表。手 3a の後も同じ形）も読む

### 7.2 SHA の照合（fail-closed）

- 正解の P ごとの `plan_sha256` と組の ID・版を、条件のファイルの凍結した組の値と、本ごとの記録（納品物の build の記録 `bundle/build-record.json`、または checkpoint）の `plan_sha256` と照らす。表のある本に `plan_sha256` の記録が無いときも合わないと数える
- **1 つでも合わなければ何も数えず終了コード 3** と固定の符号（`table-score:frozen-set`・`table-score:plan-sha256-conditions`・`table-score:plan-sha256-run`）の 1 行で断り、**出力を書かない**。ほかの断り：`table-score:args`・`table-score:conditions`・`table-score:gold-missing`（予定の P の正解が無い）・`table-score:table-unreadable`・`table-score:compare-record`。断る文に値・パス・ID を入れない

### 7.3 正規化と共有の採点の関数

- 読取元は**正規化**してから共有の採点の関数（`scoreStructure`。export する）に渡す。渡すものは 2 つ：
  - **採点の構造**（`normalizeTable`）：行＝種類・型の構造（field は型、computation は valueType・scope・form・aggregate の種類、operation は action と hasWhen、screen は view、entity は null）・options の数・groupBy の種類と、**親 entity・refEntity・groupBy の元・集計元を正規化後の行の添字へ結び直した参照**（無いなら null、指す行が無ければ**参照切れ** `broken`。区別する）。所属＝要件 ID → 行の添字の集合。確かめ方＝要件 ID → 種類・checks・value
  - **読取元のメタデータ**：表の SHA（無ければ null）
- id は結び直しのあと落とす（name・role・source も）。だから id・名前を全部置き換えた表、source が全部 null の表も同じ結果になる
- 戻り＝要件 ID ごとの 5 値・3 問（0／1／null）・採った案・印、割り当て、割り当てられない行

### 7.4 割り当て（表の行 → 正解の部品）

- 鍵は凍結した要件 ID。行は **（種類・型の構造・groupBy の種類）＋所属の足跡**（その行を所属させる要件 ID の集合）で部品の記号の候補を持つ。足跡は、型の構造が合う記号のうち、足跡の要件の記号の全体（全案の required・allowed・context と、その親 entity・参照先の閉包）に入る要件の数が最も多いものに絞る（足跡で候補を 0 にしない。許す集合の外の所属を過剰として数えるため）
- 親 entity・参照先・集計元・groupBy の元は、**正規化した参照をたどって割り当てどうしで整合**させる（**参照切れの行は割り当て不能**）。P 全体（本の表 1 つ）で一貫した割り当てを決定的に探す：単射で参照の整合する割り当てのうち、割り当てた行の数が最も多い解を全部集め、全ての解で同じ記号になる行だけを割り当てる。**探索の上限は定数**（節 `SEARCH_LIMIT`・最良の解 `SOLUTION_LIMIT`）で、超えた表は全要件を保留（`search-limit`）
- **1 部品に 1 行**。2 行が同じ部品にしか当たらないときはどちらも割り当てず「**割り当てられない行**」に数える（別名の合併をしない）。どの部品にも当たらない行も同じ欄に数える。保留の一覧の candidates は案として使わない
- 表に無い式・名前から意味を補わない。選択肢は数の一致だけ。選択肢の意味・既定値の選択肢・式の義務は照合できないので「**意味の未照合**」の印（`semantics-unverified`）と件数にし、0／1 は構造の 3 問で決める

### 7.5 3 問（同じ 1 案の中で。別案どうしを合併しない）

- (i) **欠け**：required は当該要件の所属で見る（親 entity は閉包）。行は在るが当該要件に所属していない required は欠け。required の選択肢の数が正解の数と違えば欠け。context と、required の部品と表に実在する allowed の部品の参照先・集計元・groupBy の元は、表全体に在ればよく所属は要らない。allowed は上限で、使っていない任意の部品とその参照先の実在は求めない
- (ii) **過剰**：当該要件の所属の行が、同じ案の allowed（と required）の親 entity の閉包の内。所属の行の親として導かれる entity の所属は過剰にしない。参照先 entity と集計元は allowed に在るときだけ許す
- (iii) **確かめ方**：種類が同じ案の verification と一致。structural は checks を順と重複を除いて完全一致し、assertions の束縛も照らす（target の行が当該要件の所属に在り、expected が行の型と、ref_entity が行の参照先の割り当てと合う。assertions の無い check は種類だけ）。fixed-test は observations を照らす——target の行が表に在り種類が target_kind と一致し、操作（試験の操作。記号ではない）が行の型に適合する（定数の表 `OBSERVATION_FIT`：validate は項目か entity、action は hasWhen が真の操作、screen は画面、aggregate は種別 aggregate の計算、compute は種別 expression の計算）。default-value・enum-membership・non-requirement は種類の一致。**未照合は表に無い意味だけ**
- 3 問とも 1 の案が 1 つでもあれば「正答」。無ければ 1 の数が最も多い案（同数なら先頭＝基準）の 3 問を内訳に数える

### 7.6 5 値・了承除外と unexpressible・保留

- 要件の結果は **5 値**のどれか 1 つ：**正答**（`correct`）・**誤り**（`wrong`）・**正直な持ち越し**（`carry-over`）・**了承除外**（`accepted-removal`）・**保留**（`held`）。**二値（正答・誤り）の要件だけ**を率と差に使う。案の間の優先は 正答 → 了承除外 → 持ち越し → 誤り
- 表の unresolved：同じ案の verification が unresolved なら reason_kind で分ける——`accepted-removal` は**了承除外**（持ち越しでも達成でもない）、`unsupported-observation`・`deployment-scope` は**正直な持ち越し**。案に無くても要件に `verification_limit` があれば持ち越し。どれでもなければ (iii) 0。要件 ID の形（alt）で免除しない
- `unexpressible`：要件直下で scope が無ければ全案に、scope（設計族）があればその設計族の案にだけ、案の中に書かれていればその案にだけ効く。効く範囲で表が unresolved なら正直な持ち越し、それ以外を主張すれば**過大な主張**（誤りの内訳。印 `overclaim`）。効かない範囲は通常の 3 問
- 保留：**ID で重複排除した集合**＝判定の状態が needs_human の要件 ∪ 保留の一覧の requirement_id（**静的な保留** `needs-human`。正解だけで決まる）。`related_requirement_ids` に載る要件は保留にせず「関連あり」の印（`related`）と件数。加えて**候補依存**の保留：割り当て不能の行を所属に持つ要件（`unassignable-row`）、全案が禁止の部品（案ごと）に割り当てた行を所属に持つ要件（禁止に当たる案は選ばない）と、3 問とも 1 の案が無く最良の案が同数で、その案どうしの設計族が違うか方針（`entity_field_policy`）のある案を含んで案が選べない要件（`alternative-unselectable`）、探索の上限（`search-limit`）

### 7.7 集計・分母と静的な保留・P の区間

- 主＝要件単位の正答率。内訳＝欠けの率・過剰の率・確かめ方の正答率（二値の要件の中で）。**読取元ごとに出し、混ぜない**（`by_source.accepted`・`by_source.checkpoint`。その読取元を採らなかった本は未観測に数える）
- **分母を 2 つ並べる**：**分母 (a)**＝表のある本の二値の要件数。**分母 (b)**＝予定の本 ×（その P の要件数 − **静的な保留**の数）。(b) は観測に依らず、未観測（表なしの本）と候補依存の非二値は分母に残し分子に入れない（正答の下限）。要件数は要件の並びと保留の一覧の ID の和集合で数える
- 未観測・候補依存の非二値・関連あり・意味の未照合・過大な主張・割り当てられない行は件数で別に出す（`counts`）。分母 0 は 0 と出し、率と区間は null に理由の符号 `denominator-zero`
- 区間：**P を単位にする**。P ごとに二値の要件の 0／1 を平均し、既存の P のまとまりの関数（`score-agent.mjs` の `clusterStats`。import して使う）で **bootstrap** の区間と参考の t 区間を出す（m＝二値の要件のある P の数。2 未満なら null と理由）。**単独群では符号反転の p を出さない**。Wilson の 95% は「**参考（独立を仮定）**」で、P の区間の代用にしない

### 7.8 比較（`--compare`）

- 計測の出力先に比較の記録の出力先を渡す。`comparison.json` の `pairs.groups` の 0 番目を比較元（baseline）、1 番目を候補（candidate）とし、群のディレクトリをそれぞれ §7.2 と同じく照合して採点する
- 同じ P・同じ回の本を対にして、要件ごとの差＝**after − before**（候補 − 比較元。−1・0・＋1）を**両側とも二値の要件だけ**で取り、本ごとに平均し P ごとに平均する。件数・n・平均・区間は既存の `pairStats`、P のまとまりの符号反転の p・bootstrap の区間は既存の `clusterStats` を import して使う（写さない）
- 片側に表の無い対（`table-absent`）・片側でも非二値の要件（`non-binary`）は差 null で n から除き、理由ごとの件数に出す。読取元ごとに対を組む

### 7.9 出力・匿名・指紋

- 出力は JSON（schema `musunest-eval/table-score/v1`。比較は `musunest-eval/table-score-compare/v1`）の `table-score.json`（比較は `table-score-compare.json`）と、標準出力の要約（読取元ごとに正答率・内訳・分母・5 値・割り当てられない行・表なし・P の区間。比較は差の 1 行）。要件 ID と記号は行ごとの出力（`scoring.rows`）にだけ載せる。同じ入力からは同じ出力
- `--anonymous` は `*.anonymous.json`（schema `musunest-eval/table-score-anonymous/v1`）だけを書き、件数・率・区間・m だけを出す（P の番号・本の ID・要件 ID・記号・パス・SHA を出さない）
- **指紋**（道具のファイルの SHA-256。`fingerprint.tool_sha256`）は通常の出力にだけ、採点の欄（`scoring`）と別の欄で載せる

### 7.10 範囲の外・限界

- 正解の作成・版上げ・置き場（所有者）。Jev の較正。工場の表の形・段の変更。候補の凍結と計測（窓口）
- 正解の欄の名前と型は、窓口が現物から欄の名前と型だけを抜いた一覧に合わせた（この道具の作り手は現物を読んでいない）。現物の形が変われば `table-score:gold-shape` で断る（数えない）。そのときは欄の名前を合わせる Issue を立てる
- unresolved の reason_kind のうち `table-vocabulary-gap`・`empty-reference-list` は本文の規則に無いので、持ち越しにも了承除外にも数えない（`verification_limit` が無ければ (iii) 0）

### 7.11 断った候補の下書きの採点（読取元 (c)。#607）

T1' が断った候補の下書き（表になる前の応答）を、受理済みの表と同じ 3 問で採点する。断られた表がどれだけ正しかったかを見る。**計測の道具であって工場の門ではない**（費用 0）。

- 読む場所：本ごとの診断の記録 `bundle/diagnostics/rejected-name-table.json` の `candidates[]`。候補ごとの応答 `response`（下書き。`rows` と、要件ごとの `roles`・`verification`・`nature` を一覧の順で持つ）と、候補に添えた点検の一覧 `inspection_list`
- 下書きの行の type は欄を**平ら**に持つ写像（`fieldType`・`valueType`・`scope`・`form`・`aggregate`・`action`・`hasWhen`・`view`）なので、行の種類に合う欄だけを 1 本目の表の型に写してから、1 本目と同じ正規化（`normalizeTable`。親 entity・refEntity・groupBy の元・集計元の ID を行の**添字**へ結び直す。指す行が無ければ**参照切れ**で null と区別）と共有の採点の関数（`scoreStructure`）に渡す。関数を共有し、写さない
- 要件 ID は**点検の一覧の順**で付ける。応答の要件の写し・行の**出典の写し**と引用は読まない（全部置き換えても同じ結果）。読取元のメタデータの**表の SHA は null**（C3 を結ばない）
- **観測の単位は本。本ごとに最後の候補**（round・attempt・call が最大。記録の並びではなくこの順で決める。同じなら記録の後のもの）**1 つだけ**を採点する。**候補の数**は本ごとの件数（`draft_rows[].candidate_count`）と合計で出す。別の候補の行・所属を**合併しない**（先の候補にだけ在る部品は、後の採点では欠け）
- **読めない候補**（`unreadable`）：一覧の無い候補（`no-list`）・応答が表の形でない候補＝**形の失敗**（`shape`。形の検査で断られた候補を含む）・一覧と要件の**数が合わない**候補（`count-mismatch`）・記録のファイルが読めないか形が違う本（`file`）。最後の候補が読めなければ採点せず、**古い候補に黙って戻らない**
- **下書きだけの本**（断った候補の記録があり表の無い本）も、build の記録 `bundle/build-record.json` の `plan_sha256` を 1 本目と同じく照らす。記録が無い・合わなければ 1 本目と同じ符号 `table-score:plan-sha256-run` で**何も数えず終了コード 3** で断り、出力を書かない（fail-closed）
- 分母は (c) 専用で、1 本目の (a)・(b) と混ぜない：**分母 (a')**＝下書きを採点した本の二値の要件数、**分母 (b')**＝予定の本 ×（その P の要件数 − **静的な保留**の数）。5 値・保留の集合・了承除外・unexpressible・意味の未照合・**P を単位**にした区間・分母 0 の契約（分母 0・率 null・理由の符号）は 1 本目の集計の関数をそのまま使う
- 出力：`scoring.draft`（集計。`draft` の欄に候補の件数・採点した本・読めない候補の理由ごとの件数）と `scoring.draft_rows`（本ごと）。標準出力に `[draft]` の行
- `--compare` の対に (c) は入れない（群ごとの集計だけ。`scoring.draft.baseline`・`scoring.draft.candidate`）。受理済みの表と下書きの両方がある本は、それぞれの読取元に **1 回ずつ**数える（混ざらない）
- 範囲の外：v1.2 の旗 ids on の断った候補（語彙・写像の診断。形が違う）。読めば形の失敗に数える

### 7.12 C3 の正誤表（見逃し・誤拒否。#607）

C3（T1''）の判定を同じ正解と照らし、誤りの要件の受理（**見逃し**）と正しい要件の拒否（**誤拒否**）を数える。検査をすり抜けた誤りの直接の計測で、工場の門ではない。

- 本ごとに、採点した表（1 本目の読取元 (a)・(b)）と**表の SHA** が一致する点検の記録の回を結ぶ：受理済みの表は成果物の `bundle/artifacts/semantic-check.json`（semantic-check の記録。回の並び `rounds[]`。合う回が 2 つ以上なら最後の回）、checkpoint は同じファイルの `semantic_check`。記録の無い本（`absent`）・読めないか形が違う本（`unreadable`）・SHA の合う回の無い本（`no-matching-round`）は「**点検の記録なし**」に数え、正誤表に入れない。**断った候補**は点検の前に落ちているので対象にしない
- **二値（正答・誤り）の要件だけ**で、正解の判定（正答／誤り）× C3 の判定（accept／reject）の 2×2（`cells`）を数える。持ち越し・了承除外・保留は正誤表に入れず件数（`non_binary`）だけ。点検の対象（`targets`）に無い要件・判定の無い要件（同じ ID の判定が 2 つ以上ある要件を含む）は「**点検の対象外**」（`out_of_target`）
- **見逃しの率**＝誤りの要件のうち受理された数 ÷ 誤りの要件（点検あり）。**誤拒否の率**＝正しい要件のうち拒否された数 ÷ 正しい要件（点検あり）。分母 0 は率 null と符号 `denominator-zero`。Wilson は「**参考（独立を仮定）**」。**P ごと**の 2×2（`by_pattern`）と P の数（`patterns`）を並べる
- 読取元の種類ごとに出す（`scoring.c3.accepted`・`scoring.c3.checkpoint`。本ごとは `scoring.c3_rows`）。`--compare` では群ごとに同じ欄（`baseline`・`candidate`。対の差は取らない）。標準出力に `[c3:<読取元>]` の行
- 点検の記録の**引用**（`quote`）と**拒否の理由**の文は読まず、出力に写さない。**拒否の種類**（`kind`）は既知の値（`unnecessary-ownership`・`missing-target`・`weak-verification`）の件数だけで、ほかの値は `unknown` に数える（値を写さない）
- `--anonymous` に足す欄（`draft`・`c3`）も件数・率・P の数だけ（本の ID・要件 ID・P の番号を出さない。既存の匿名の欄は変えない）。1 本目の採点の欄の名前・意味・値は変えず、**指紋**（道具のファイルの SHA-256）だけがコードの変更で変わる

### 7.13 段の走りと段の比較の読み方（読取元 checkpoint・入力なし・表なし。#639）

条件の版 v6・v8（`params.mode` が `stage-run`）の計測と、段だけの対の比較の記録（版 `musunest-eval/stage-compare-record/v1`。`pairs.groups` が before・after）を、同じ道具で読む。段単位でない計測の出力は変えない（下の欄は段単位のときだけ足す）。

- **段の走り**の本は Build の記録（`bundle/build-record.json`）を持たないことがあり、表は読取元 checkpoint（境界 t1-t2）から読む。本の `plan_sha256` は checkpoint の値で凍結した組と照らす（記録と checkpoint の両方があれば両方照らす）。U1 の主指標（要件単位の正答率）はこの道具の checkpoint の値で、C3 の正誤表は checkpoint の `semantic_check` を表の SHA の一致で結ぶ（§7.12）。**段の通過は納品の成功ではない**：ここで出すのは表の正答率だけで、PASS・納品の欄ではない
- **入力なし**：条件の `stage_input_absent` の本（上流が境界に届かず起こしていない本）は本のディレクトリを読まず、`runs.input_absent`（本ごとは `input_absent`）に数える。**表なし**（`runs.no_table`）は起こしたのに読める表が無い本（段の途中で止まった本など）で、入力なしとは分けて数える。どちらも**分母 (b)** には残し、分子と分母 (a) に入れない（正答の下限）。条件の入力なしの一覧が予定の部分集合でない・経路（v6 は v1.1a、v8 は v1.2）が版と合わない条件は断る（`table-score:conditions`）
- **読取元の本の数**：段単位のときだけ `scoring.run_sources`（`accepted_only`・`checkpoint_only`・`both`・`no_table`・`input_absent`。互いに重ならない）を出し、標準出力に `[本の読取元]` の行を足す。`--compare` では群ごと
- **段の比較**（`--compare`）：記録の `pairs.groups` の 0 番目を比較元・1 番目を候補とし、同じ P・同じ回の本を対にする。両群で表の無い対は `table-absent` で除く。**入力なしの本は対に入らず**、`excluded.input-absent` に件数を出す。P のまとまりの区間は §7.8 と同じ
- **出どころの契約**：通常の出力の `fingerprint` に、採点した計測の条件のファイルの SHA-256（`conditions_sha256`）と計測の ID（`measurement_id`。条件に無ければ null）を足す（`--compare` では群ごと）。本ごとの行（`scoring.rows`）の `source`（受理済み・checkpoint）と `table_sha256` は従来どおり。`--anonymous` には指紋・SHA を出さず、`run_sources` の件数だけを足す

## 8. 比較の雑音の分解と検出できる差の目安（#631。v1.2 評価 a。道具 `agent-accept/score-agent.mjs --compare`）

30 対（10 P × 3 回）の前後比較で差が「検出されず」になったとき、本数（P）を増やすか反復（K）を増やすかは、どちらの雑音が勝つかで決まる。`--compare` の出力の末尾に欄 `noise` を足し、既存の対の差の P ごとの並びから**費用 0**（集計のコードだけ。API を呼ばない）で雑音の内訳を出す。**判定・門・merge の可否には使わない**（数を出すだけ。K を上げる判断と確認の計測は人。方法論 `01` §4・§5）。既存の欄の名前・意味・並び・値と、採点の規則（判定・PASS・分母・区間の算出）は変えない。値が変わってよいのは §5.9.6 と同じ例外（採点のコード自身の指紋と、それに由来する照合）だけ。

### 8.1 欄（`noise`）

- `noise.pass`：原文系 PASS の対の差（`pairs.by_pattern` の `diffs`。差 −1／0／＋1。null の対は除く）
- `noise.stage_pairs.roles.<役割>.passed`：段の役割ごとの「通過」の対の差（§5.10.3 の `stage_pairs` と同じ並び）に同じ関数を当てたもの
- `noise.runs`：いまの K（比較元の群の条件の `runs`）。`noise.note`：読み方の文
- 1 つの集計の欄：`m`・`excluded_patterns`（有効な対の無い P の数）・`mean`（d̄）・`within`（`variance` ＝ σ̂²_w、`patterns` ＝ 使った P の数）・`between.variance`（s²_b）・`prediction`（v̂_pred）・`data`（`raw` ＝ 生の値、`variance` ＝ ω̂²、`clipped` ＝ 0 に切った印）・`winner`・`reason`・`detectable`（`z`・`by_k` の 1〜10・`infinity`・`current`（いまの K とその δ）・`reason`）・`by_pattern`（P ごとの K_p・平均・分散。行つきの出力だけ）。値は丸めずに計算し、出すときに 6 桁に丸める

### 8.2 式

記号：P ごとの有効な対（差が null でない）の数 K_p、K_p ≥ 1 の P の数 m（K_p＝0 の P は除き、その数を `excluded_patterns` に出す）、差 d_{p,k}、P 平均 d̄_p ＝ Σ_k d_{p,k} ÷ K_p、全体の平均 d̄ ＝ Σ_p d̄_p ÷ m（有効な P 平均の単純平均。全対の平均ではない。§5.10.4 の `clusters.mean` と同じ）。

- **P 内の分散**（反復のぶれ）：s²_p ＝ Σ_k (d_{p,k} − d̄_p)² ÷ (K_p − 1)。K_p ≥ 2 の P だけで取り、その平均を σ̂²_w とする（使った P の数を `within.patterns` に出す）
- **P 平均の分散**：s²_b ＝ Σ_p (d̄_p − d̄)² ÷ (m − 1)
- **予測の雑音**（K 反復の平均に残る分）：v̂_pred ＝ mean_p(σ̂²_w ÷ K_p)
- **データの雑音**（P の違い）：ω̂² ＝ max(0, s²_b − v̂_pred)。生の値（負になりうる）も出し、0 に切ったら `clipped` を真にする（「データの雑音は検出されず」）
- **勝つ側**（`winner`）：v̂_pred ＞ ω̂² なら `prediction`、v̂_pred ＜ ω̂² なら `data`、等しければ `tie`（全差 0 を含む。差 1e−12 以内を等しいとみなす）。m ＜ 3 なら `undetermined`（`reason` ＝ `few-patterns`）、σ̂²_w を出せる P（K_p ≥ 2）が 2 未満なら `undetermined`（`few-within-patterns`）
- **検出できる差の目安**：反復 K′ のときの全体の平均の標準誤差 SE(K′) ＝ √((ω̂² ＋ σ̂²_w ÷ K′) ÷ m)。両側 5%・検出力 80% の正規近似で δ(K′) ＝ (z₀.₉₇₅ ＋ z₀.₈₀) × SE(K′) ＝ 2.8016 × SE(K′)。K′ ＝ 1〜10 の表（`by_k`）と、K′ → ∞ の下限 δ_∞ ＝ 2.8016 × √(ω̂² ÷ m)（`infinity`）、いまの K の値（`current`）を出す。σ̂²_w（K_p ≥ 2 の P が無い）か s²_b（m ＜ 2）を推定できなければ δ は null と `reason` ＝ `variance-unestimable`。全差 0 なら分散は全部 0 で δ は 0（null ではない）。m ＜ 3 で勝つ側を決めないときも、推定できれば δ は出す

### 8.3 出典

- Miller 2024「Adding Error Bars to Evals」arXiv 2411.00640：§3.1（K 回の反復で平均の分散は (Var(x̄) ＋ E[σ²] ÷ K) ÷ n）・§5（検出力の式）
- Wang 2025「Measuring all the noises of LLM Evals」arXiv 2512.21326：予測の雑音とデータの雑音の分解、対の差の雑音
- 窓口の調査（2026-10-18）§3 の 2・4

### 8.4 読み方と限界

- δ(K′) は P 平均の正規近似による**目安**で、m＝10 では粗い。**主の読み方は P 単位の符号反転と bootstrap のまま**（§5.10.4）。非有意は「差が無い」ではなく「検出されず」
- 0／1 の差で K_p＝3 の P 内分散は粗く、3 回とも同じ値の P は 0 になる（σ̂²_w を小さく見せうる）
- 対は同じ P・同じ回の番号で組んだだけで、呼び出しは独立である。だから対の差の P 内分散は**両群の反復のぶれの和**に相当する（対にしても予測の雑音は減らない。減るのは P の違いの分）
- 勝つ側と δ は K を上げるかどうかを人が考える材料で、門・判定・merge の可否には使わない

### 8.5 匿名の口・標準出力

- `--compare --anonymous` には、`noise.pass` と段の役割ごとの `passed` について m・使った P の数・分散（σ̂²_w・s²_b・v̂_pred・ω̂² の生の値と切った値と印）・勝つ側と理由・δ の表（1〜10・下限・いまの K）だけを出す。**P の ID・本の ID・P ごとの値・平均は出さない**
- 標準出力：`--compare` の既存の行の後ろ（P のまとまりの 1 行のあと）に 1 行（`雑音の分解（判定には使わない目安）: 予測 …・データ …（勝つ側）・検出できる差 K=3 …・K=6 …・下限 …（m …・P 内の分散を出せた P …）`）を足す。`--compare` の JSON の行には `noise` を入れない

## 9. PASS あたりの費用・段ごとの時間と usage・PASS 対 費用（#632。v1.2 評価 b。道具 `agent-accept/score-agent.mjs`）

正答率は再試行で上がりうるので、同じ正答率でも費用は大きく違いうる。手 4（探索型の直し）・手 7（本数・モデル）は「費用あたりの PASS」で読む（設計書 `../08-architecture-v1.2.md` §9）。既存の記録（起動の記録の費用と要約の段の記録）から**費用 0**（集計のコードだけ。API を呼ばない）で、通常の採点の出力の末尾に `cost_per_pass`・`stage_usage`、`--compare` の群ごとに同じ欄と、出力の末尾（`noise` のあと）に `pass_vs_cost` を足す。**判定・門・merge の可否には使わない**（数を出すだけ。費用の線＝いくらまでは置かない）。既存の欄の名前・意味・並び・値（本ごとの `cost_usd`・`seconds`、`metrics_build` の既存の欄、§8 の `noise` を含む）と採点の規則は変えない。値が変わってよいのは §5.9.6 と同じ例外（採点のコード自身の指紋と、それに由来する照合）だけ。段単位の走り（§5.11）の採点には足さない。

### 9.1 PASS あたりの費用（`cost_per_pass`。群ごと）

- **定義**：予定した全部の本の費用の合計 ÷ 原文系 PASS の数。PASS は予定本数の中で数える（`pass_k` と同じ。未実行・途中の本は PASS でない）
- **本 1 本の費用**：要約のある本だけ、起動の記録の `plan_cost.total_usd`（無ければ要約の `provider_cost_usd`）。有限で 0 以上でなければ**読めない**。未実行・途中・要約が無い・費用の欄が無い本は **0 と推測せず欠測**に数える（`cost.observed`・`cost.missing`。`cost.total` は読めた本の合計）。既存の行の `cost_usd`（読めなければ 0）は変えない
- **分母**：`planned`（予定本数）。記録の無い本の数を `unavailable` に内訳（`unexecuted` ＝ 未実行・`incomplete` ＝ 途中・`no_summary` ＝ 実行したが要約が無い本。要約を書く前に止まった本を含む）で出し、黙って分母から落とさない（`unavailable.no_summary` は既存の `stops.no_summary` と同じ数え方で、未実行・途中を含まない）。標準出力では値の横に「読めた本／予定」を出す
- **欠測の扱い**：値（`value`）と区間（`interval`）は**欠測 0 のときだけ**出す。欠測が 1 本でもあれば値と区間は null・理由 `reason` ＝ `cost-missing` とし、代わりに**観測した費用だけの下限** `lower_bound`（読めた本の費用の合計 ÷ PASS。費用は 0 以上なので真の値はこれ以上）を出す。読めた本が 0 なら下限も null と `all-missing`。PASS が 0 なら値・区間・下限は null と `no-pass`（理由の優先は `no-pass` ＞ `all-missing` ＞ `cost-missing`）
- **区間**：**P を単位**にした bootstrap。P を復元抽出し、抽出した P の費用の合計 ÷ PASS の合計の 2.5・97.5 百分位（回数と種は §5.10.4 と同じ定数 `BOOTSTRAP`）。PASS の合計が 0 の抽出は除いてその数を `bootstrap.excluded` に出す。P が 2 未満なら区間は null（`bootstrap.reason` ＝ `few-patterns`）
- `by_pattern`：P ごとの本数・PASS の数・欠測の数・読めた費用の合計（行つきの出力だけ）

### 9.2 段ごとの時間と usage（`stage_usage`。群ごと）

- 本ごとの要約の段の記録（`stages[]`）から、段の ID ごとに、記録の出た本の数（`runs`）・呼び出し数（`calls`）・時間（`duration_ms`）・トークン（`input_tokens`・`cached_input_tokens`・`cache_write_tokens`・`output_tokens`・`reasoning_tokens`）・再試行（`retries` の `communication`・`shape`・`content`）・usage の無い呼び出し（`missing_usage_calls`）を出す。呼び出し・トークン・再試行は全部の本の同じ段の記録の合計
- **時間**は Build だけの集計（§5.3）の `by_stage` と**同じ関数**：本ごとに同じ段の記録を足し、本をまたいで読めた本の数・欠測・合計・中央値。段の記録を読めた本で出てこない段は実測の 0、要約の無い本と段の時間が読めない本は欠測
- 段は記録に現れたものだけを、既存の段の順（Plan の段 → Build の段 → v1.1α の段 → v1.2 の `vocabulary`・`mapping`）で並べる。知らない段は `unknown` で末尾。`planned`・`unavailable`（§9.1 と同じ内訳）を添える
- **段ごとの USD は出さない**。記録に段ごとの費用が無く、単価を道具に書かない（費用の代理は呼び出し数とトークン）

### 9.3 PASS 対 費用（`pass_vs_cost`。`--compare`）

- 群ごとに PASS の数／予定・費用の合計（読めた本／予定・記録の無い本の内訳）・PASS あたりの費用（区間。欠測なら下限と欠測の本数）を並べ、続けて候補 − 比較元の PASS の差（`pass_diff`）を**いつも**出す
- 費用の差（`cost_diff`。費用の合計の差）と向き（`direction`）は**両群とも費用の欠測が 0 のときだけ**出す。どちらかに欠測があれば費用の差は null・向きは `undetermined`・理由 `cost-missing`（部分の合計の差で向きを決めない）
- 向きは**記述**で線は置かない：`frontier`（PASS が増え費用が減る＝**前線**に乗る）・`buy-pass`（費用を払って PASS を買う）・`save-cost`（PASS を減らして費用を減らす）・`worse`（どちらも悪い）・`same`（PASS の差も費用の差も 0）。片方の差だけが 0 のときは、悪くならない側を良い向きに数える（PASS 差 0 で費用が減れば `frontier`、PASS 差 0 で費用が増えれば `worse`）

### 9.4 読み方

- PASS あたりの費用は、1 つの PASS を得るまでの**期待費用の推定**である（Cost-of-Pass。arXiv 2504.13359）。正答率と費用を 1 つの数にまとめるので、手 4・手 7 の比較は正答率だけでなくこの数と向きで読む
- 再試行で正答率を買うときの最適な回数は、**検証器の誤受理率**に依る（Stroebl ほか arXiv 2411.17501。不完全な検証器の下では再試行を増やしても正答率に上限があり、誤受理が増える）。だから `buy-pass` は「得」とは限らない
- 出典の整理は窓口の調査（2026-10-18）§3 の 7・8

### 9.5 限界

- 費用は起動の記録と要約の値をそのまま使い、単価から計算し直さない。段ごとの内訳は呼び出しとトークンだけ
- 区間は P を単位にした bootstrap で、P が 10 個では粗い。PASS の少ない抽出では比が大きく振れる（PASS 0 の抽出は除いてその数を出す）
- 下限は欠測の本の費用を 0 とみなした値で、真の値はこれ以上。欠測が多いほど下限は緩い
- 向きは記述で、差の雑音（§8）を考えない。PASS の差が雑音の範囲かどうかは §5.10.4・§8 で読む

### 9.6 匿名の口・標準出力

- `--anonymous` と `--compare --anonymous` には、件数・合計・中央値・値・区間・下限・既知の理由・向きだけを出す（`by_pattern` を出さない。段は既知の段の ID だけ）。**本の ID・P の ID・P ごとの値は出さない**
- 標準出力：`--compare` の末尾（§8 の雑音の分解の 1 行のあと）に 1 行（`PASS 対 費用（判定には使わない記述）: <群> PASS k/n・費用 合計 …（読めた …/…・未実行 …・途中 …・要約なし …）・PASS あたり …（区間 …）／…／差（…）PASS …・費用 …・向き …・段の時間 上位 3: …`）。段ごとの時間は上位 3 段だけを 1 行に、全部は JSON（`stage_usage`）に。`--compare` の JSON の行と通常の採点の標準出力には足さない

## 10. 最後に通った段 → 止まった値の遷移表と、本ごとの最初の上流の落ち（#633。v1.2 評価 c。道具 `agent-accept/score-agent.mjs`）

段に分けた生成では、下流の落ちが上流の落ちに連鎖する。注釈は「最初の上流の落ち」だけに付け、遷移（最後に成功した状態 × 最初に落ちた所）の表で読むのが実務の作法である（窓口の調査 2026-10-18 §3 (4)）。§5.9.1 の停止段の内訳（`stops`）と到達数は、どの段を通ったあとどこで止まったかの組と、最初にやり直しが出た段を出さない。台帳の「観測した段」は症状が出た段で、最初に崩れた段ではない。既存の記録から**費用 0**（集計のコードだけ。API を呼ばない）で出す。**判定・門・merge の可否には使わない**。台帳の主因の確定（コード・再現・反例の証拠が要る）の代わりにもならない。既存の欄の名前・意味・並び・値と採点の規則は変えない（新しい欄は末尾。値が変わってよいのは §5.9.6 と同じ例外だけ）。

### 10.1 本ごとの 2 つの値（`rows[].last_passed_stage`・`rows[].first_upstream_failure`）

- **最後に通った段**（`last_passed_stage`）：要約の段の記録（`stages[]`。実行の順）で、`status` が ok の記録を持つ最後の段。ok の記録が無ければ null
- **最初の上流の落ち**（`first_upstream_failure`）：記録の順で、最初に「1 回目で通過」でなかった段（§5.9.1 と同じ定義。段の最初の記録が ok でない・`calls` が 2 以上・`retries` の `shape` か `content` が 1 以上。`calls` 0 のコードの段は ok でない記録のときだけ。`vocabulary`・`mapping` は束ごとの記録なので全記録）。全段が 1 回目で通れば null（「なし」）
- **欠測**：要約が無い本、要約の段の記録が配列でない本は、どちらの値も文字列 `missing`（null と区別する。0 や「なし」と推測しない）。段の ID が文字列でない記録は `unknown`

### 10.2 遷移表（`transitions`。群ごと。通常の採点の出力と `--compare` の群の末尾）

- **行**＝最後に通った段（既存の段の順＋`none`＝どの段も通っていない本＋`unreadable`＋`unknown`）、**列**＝止まった値（`stopValueOf` が返す値そのまま。§5.8.5 の停止段の値。止まらず完走した本も、この関数が返す値〈`completed` など〉の列に入る）、**値**＝本の数。`matrix` に行 × 列を、0 でない組だけを `cells`（`last_passed`・`stop`・`runs`）に並べる
- `unreadable` ＝ 要約は読めるが段の記録が配列でない本の行。列の合計を `stops.values` に合わせるために置く（`missing` には数えない）。`unknown` ＝ 知らない段（`BUILD_STAGE_IDS` に無い）
- **分母は予定本数**（`planned`）。未実行・途中の本は `not_run`、実行したが要約の読めない本は `missing` に数える
- **既存の `stops` との照合は項目別**：停止の値ごとの列の合計 ＝ `stops.values` の同じ鍵の値、`not_run` ＝ `stops.unexecuted` ＋ `stops.incomplete`、`missing` ＝ `stops.no_summary`、全セルの和（`not_run`・`missing` を含む）＝ `planned`。既存の `stops`（読めた要約だけを `values` に数える）は変えない

### 10.3 最初の上流の落ちの内訳（`first_upstream_failures`。群ごと）

- 段ごとの本の数（`stages`。既存の段の順＋`unknown`）と、`none`（全段が 1 回目で通った本）・`missing`（要約か段の記録が読めない本）・`not_run`（未実行・途中）。全部の和 ＝ `planned`

### 10.4 読み方

- **最初の上流の落ちと止まった段が違う本は連鎖の候補**である。直すのは上流から。診断した段（止まった段）に直接当てる修正が、下流を壊す例が報告されている。止まった段の列だけでなく、その本の最初の上流の落ちの段を台帳の「最初の上流の落ち」の列（方法論 `02` §1）に書く
- 遷移表は「最後に通った段」と「止まった値」の組で、どこまで進んでどこで止まったかを 1 枚で読む。`none` の行の本は最初の段で止まっている。`completed` の列の本は完走で、行は完走した本が最後に通った段になる
- 実際に数を変えるのは手 3 以降の直しである。この節の数は直しの優先度の材料で、頻度と重大さの判断（方法論 `02` §2）に代わらない

### 10.5 限界

- 段の記録を持たない v1 のコードの段（`calls` 0）は「1 回目で通過」を判定できない。ok の記録があれば通過とみなし、ok でない記録のときだけ落ちとする（コードの段の再実行の有無は見えない）
- 「最初の上流の落ち」は記録の順の最初であり、因果の証明ではない。上流の落ちが下流の落ちの原因かどうかは、台帳の主因の確定（コード・再現・反例の証拠）で決める
- 段単位の走り（§5.11）の採点には足さない。要約が無い・段の記録が読めない本は欠測で、分母に残す

### 10.6 匿名の口・標準出力

- `--anonymous` と `--compare --anonymous` には、既知の段の ID（`BUILD_STAGE_IDS`）・`none`・`unreadable`・既知の停止の値の件数だけを出す。知らない段・知らない停止の値は `unknown`。**本の ID・P の ID・段の自由な文字列は出さない**
- 標準出力：`--compare` の末尾（§9 の PASS 対 費用の 1 行のあと）に 1 行（`<群> 遷移表（最後に通った段→止まった値。判定には使わない記述）: <行>→<列> <本の数>・…（未実行・途中 …・要約なし …・予定 …）` を群の数だけ `／` でつなぐ）。0 でない組だけ。JSON の行と通常の採点の標準出力には足さない

### 10.7 再開（`--resume`）の照合に v1.2 の呼び出しの上限を入れる（#618。道具 `agent-accept/run-agent.mjs`）

- 経路 v1.2 の単独の計測（`--pipeline v1.2`）は、条件のファイルの `params.v12_call_limits`（`logical_calls`・`real_attempts`・`judge_branch`）に、工場の dist の `V12_CALL_LIMITS` の値を書く（道具に値を写さない）。署名に入る。v1・v1.1a だけの計測と、dist が上限を出さないときは欄を足さず、条件のファイルと署名は変わらない。比較の群（`--compare-pipelines`）の条件には足さない（採点側の群の params の照合が欄の差を見るため。足すときは採点側と一緒に直す）
- `--resume` は記録の上限と今の dist の上限が違えば、今の条件の不一致と同じ `[resume:signature]` で断る。`v12_call_limits` の欄の無い前の版の条件のファイルは、その欄を除いた署名で今までどおり照らして再開できる（上限が記録されていないので、混ざったかどうかはこの照合では分からない）
- 旗 `ids` が on の dist が `V12_CALL_LIMITS` を出さない・3 つが有限の数でないときは、**exit 3・`pipeline:v1.2-limits-unavailable`** で子を 1 本も起こさない（黙って欄を省かない）。`ids` が off か、旗に `ids` の無い dist（手 3p より前）だけ欄を足さずに通す

### 10.8 v1.2 の段の走りの計測と採点（条件 v8・旗の照合・1 段先の副指標。#638。道具 `agent-accept/run-agent.mjs`・`agent-accept/score-agent.mjs`）

工程ごとの評価の単位 U1（C1 語彙 → C2 写像 → C3 意味の点検）を、段の旗（§5.11）で v1.2 の経路のまま流して採点する。工場の段の走りの口（`--pipeline v1.2 --plan-file` と段の旗）に合わせて計測・採点を接続したもので、費用は 0（API を呼ぶのは計測のときだけ）。

- **計測**：段の旗（`--stage-start`・`--stage-end`・`--stage-from`）は `--pipeline v1.2 --build-from` とも組める。子の引数の末尾は `--pipeline v1.2` のあとに段の旗。条件の版は **v8**（v6 の段の欄に、v7 の `params.pipeline`（`v1.2`）・`params.v12_flags`（工場の dist の `V12_PIPELINE_FLAGS` の写し）と §10.7 の `params.v12_call_limits` を足した形。署名に入る）。v1.1α の段単位の走りは v6 のままで、条件・子の引数・出力は変わらない
- **開始の別名**：`--stage-start` の別名（C1 語彙の名前）は、工場の dist（`v11a/bundle-v11a.js`）が公開する別名の表で区間の正本の名前（`name-table`）に正規化してから範囲を決める。道具に別名を書かない。v1.1α の経路は別名を受けない（`flags:conflict`）
- **上流の照合（`--stage-from`）**：上流の条件は v6 か v8 で、経路が今の経路と同じこと（違えば **exit 4・`stage-from:conditions-pipeline`**。版と経路の合わない条件は `stage-from:conditions-invalid`）。v1.2 の照合では、工場の dist の照合の関数に、dist の package の入口が公開する旗の組と台帳の指紋（`propertyLedgerSha256`）を渡す。旗の組か台帳の指紋が上流の checkpoint の版と違えば工場の符号 `stage-input:version` で断る（`stage-from:stage-input:version`）
- **段だけの対の比較（`--make-pairs`・`--compare`）**：群は before・after で、両群とも v1.2。対のファイルは範囲と上流の条件の SHA を結ぶ今の形。両群の dist の旗の組が名前 → 真偽の集合として同じでなければ **exit 3・`compare:flags-mismatch`** で子を 1 本も起こさない。比較の群の条件には §10.7 と同じく上限の欄を足さない
- **採点の照合**：段単位の条件として v8 も読む（段の履歴の照合は今の区間の表のまま。区間 0 に `vocabulary`・`mapping`）。本ごとの段の走りの記録（`bundle/stage-run.json`）の `conditions.v12_flags` を条件の `params.v12_flags` と照らし（`evaluation.v12_flags`。結果の名前は §5.13 と同じ）、起こした本の 1 本でも一致しない・欄が無い・記録が読めなければ照合は未照合（`completion.unverified` に `v12-flags`）。段の通過率と下の副指標の数は変えない
- **1 段先の副指標（`next_stage`。v8 のときだけ。群ごと）**：U1 の同じ出力を T2 まで流した走り（範囲 `vocabulary`..`test-spec`）の記録から出す。終了した単位自身の集計（持ち越しの数・試験の数）で代用しない
  - **T2' の通過**（`t2_pass`）＝ `test-spec` の最後の記録が ok の本の数 ÷ 予定本数。Wilson の区間は参考。T2 に届かず止まった本（入力なしの本を含む）は 0 に数えて `not_reached` に、記録の読めない本・条件と食い違う本・起こさなかった本は `missing` に件数を出し、どちらも分母から消さない。T2 で止まった本は `failed`
  - **T2 が落とした試験の数**（`dropped_tests`）＝ 記録の `test_spec.dropped_tests`。T2 に届いた本だけで合計と中央値を出し、届かない本・値の無い本は null で、`observed`・`missing` と T2 に届いた本の数 `reached` を出す
  - 範囲が `test-spec` を含まない走りでは、両方を null にし理由 `range-excludes-test-spec` を添える。U2 の 1 段先（U3 の停滞率・C7 の不一致）は宣言の保存の Issue の後
- **読み方**：単位の評価の主指標（U1 の表の正誤）は表の採点の道具（§7）が出す。ここの段の通過と 1 段先の副指標は、その単位の出力が次の段で使えるかの副指標であり、**段の通過は納品の成功ではない**。判定・門・merge の可否に使わない
- **匿名の口**：`--anonymous` には経路・旗の照合の状態（照合を通った旗の名前と真偽・件数）・1 段先の副指標の件数と率と区間だけを足す（本の ID・P の ID・上流と確定した仕様の SHA・一致しない本の一覧は出さない）。標準出力は段単位の採点の既存の行の後ろに、旗の組の 1 行と `1 段先（T2' の通過・T2 が落とした試験。納品の成功ではない）: …` の 1 行（`--compare` は群ごと）

#### 10.8.1 凍結した上流の組（版 1）と、`--stage-from` に組のディレクトリを渡す口（#640。道具 `agent-accept/freeze-stage-input.mjs`・`agent-accept/run-agent.mjs`・`agent-accept/score-agent.mjs`）

工程ごとの評価（U2 試験・U3 宣言）の入力を、P ごとに 1 本の境界の checkpoint と前の走りの記録で固定する。**版 1** は参照の計測（経路 v1.2 で境界の checkpoint を書いた計測。一気通貫 v7 か段の走り v8）から**規則**で選ぶ。API を呼ばない（費用 0）。門・判定・merge の可否に使わない。

> 節の番号：既存の試験が §10 と §10.8 を末尾として照らすので、§10.8 の下の小節として末尾に足した。§10.8 までの文は変えていない。

- **凍結**：`node freeze-stage-input.mjs <repo> <参照の計測の出力先> <表の採点の出力（table-score.json）> <組のディレクトリ> --id <組の ID> --version <整数> --boundary <境界>`。境界の名前は工場の dist の表（`STAGE_BOUNDARIES`）にある値だけ受ける
- **規則（`best-scored-complete` v1）**：P ごとに、参照の計測の本のうち (i) 境界の checkpoint を宣言し（Build だけの記録か段の走りの記録の `checkpoints`。工場が前の走りの記録として読む順と同じ）、(ii) 工場の dist の照合の関数（`verifyStageInput`。旗の組と台帳の指紋も渡す）が通り、(iii) 表の採点の出力にその本の行があり二値（正答・誤り）の要件が 1 件以上ある本を**有効な候補**とし、正答率（正答 ÷（正答＋誤り））が最も高い本を採る。同点は起動の記録の `started_at` が早い本、同じなら回の番号の小さい本（入力の順は使わない）。**分母 0**（二値の要件が 0）・未採点の本は候補から外す（0 点に読み替えない）。本を選ばせる引数は無い
- 有効な候補の無い P は組から外し、`missing` に理由の符号を残す：`no-checkpoint`（宣言した本が無い）・`verify-failed`（照合を通った本が無い）・`no-scored-candidate`（二値の要件のある採点の行が無い）
- **出どころの照合**（合わなければ何も書かず exit 3）：参照の計測の条件が v7 か v8 で署名が中身と合う（`freeze:conditions-invalid`）・経路が v1.2（`freeze:conditions-pipeline`）・旗の組が今の dist の組と同じ（`freeze:conditions-flags`）・凍結した組 (b) のファイルの SHA が条件の値と同じ（`freeze:conditions-frozen`。読めなければ `freeze:plan-set-unreadable`）・定義ファイルの SHA（`freeze:set-sha256`）。表の採点の出力は表の採点の版で（`freeze:score-unreadable`）、`fingerprint.conditions_sha256` が参照の計測の条件のファイルの SHA-256 と同じで行の本が計測の予定の中にあり、採る本の表の SHA が採点の行の `table_sha256` と checkpoint の `name_table.table_sha256` の両方と同じ（`freeze:score-mismatch`）。ほか `freeze:args`・`freeze:boundary`・`freeze:out-not-empty`・`freeze:dist-unreadable`・`freeze:record-unreadable`・`freeze:started-at`・`freeze:none-adopted`。断りの行は符号と本の ID・件数だけ
- **組の形**（`frozen-stage-input-set.json`。schema `musunest-eval/frozen-stage-input-set/v1`）：`id`・`version`・`boundary`・`rule`（名前と版）・`plan_set`（(b) の id・版・SHA）・`source`（参照の計測の条件の SHA・計測の ID・経路・旗の組・採点の出力の SHA）・`adopted[]`（P・本の ID・`started_at`・checkpoint の写しの場所と SHA と出力ダイジェスト・記録の写しの場所と SHA・表の SHA・選んだときの正答率の分子と分母 `score`）・`missing[]`（P と理由の符号）・`signature`（`signature` を除いた組の JSON の SHA-256）。checkpoint と記録はバイト列のまま `inputs/<本>/` に写す（記録は工場が読む名前のまま）。組に正解の表の中身・要件の文は写さない
- **組の置き場所はリポジトリの外**（checkpoint に題材の名前が入る）。道具は場所を引数で受けるだけ
- **人の採否**：`node freeze-stage-input.mjs <組のディレクトリ> --adopt <採否のファイル>`。採否のファイル（schema `musunest-eval/frozen-stage-input-review/v1`）は `set`（組の id と版）・`author`（`owner`／`scorer`）・`date`（`YYYY-MM-DD`）・`decisions[]`（P ごとの `adopt`／`exclude` と理由の符号 `reason`。除外は必須）を 1 ファイルで持つ。道具は除外の P を `adopted` から `missing`（理由 `human-excluded:<符号>`）へ移し、`review`（採否のファイルの SHA-256・担当・日付）を足して組のファイルを署名し直し、採用後の組の SHA を標準出力に出す。checkpoint と記録の写し（原本）はバイト列のまま変えず、版も変えない。採否のファイルに無い P（`adopt:missing-p`）・組の採用に無い P（`adopt:unknown-p`）・同じ P を 2 回指す（`adopt:duplicate-p`）・組と違う id／版（`adopt:set-mismatch`）・反映済みの組（`adopt:already-reviewed`）は何も書かず断る。人が本を選び直す口は無い（除外だけ）
- **計測**（`run-agent.mjs --stage-from <組のディレクトリ>`）：組のファイルのあるディレクトリを受ける（上流の計測の出力先を渡す今の形はそのまま）。組の形・署名（`stage-from:set-invalid`・`stage-from:set-unreadable`・`stage-from:set-signature`）・写しの SHA（`stage-from:set-sha256`）・境界が開始の段の直前の境界と同じ（`stage-from:set-boundary`）・`plan_set` が `--build-from` の組と同じ（`stage-from:set-plan-set`）・経路と旗の組が今の計測と同じ（`stage-from:set-pipeline`）・`review` がある（**人の採否が未反映の組は使わない**。`stage-from:set-review`）・対象の P が組の `adopted` か `missing` にある（`stage-from:set-pattern`）・記録の宣言の出力ダイジェストが組の値と同じ（`stage-from:set-digest`）を確かめ、写しに工場の dist の照合の関数を当て直す（`stage-from:<工場の符号>`）。どれも exit 4・子 0 本・何も書かない
- **P ごとの 1 本を、その P の全反復に同じバイト列で渡す**。`missing` の P（人が除外した P を含む）は入力なし（`stage_input_absent` と同じ扱い。件数を出す）。条件の `params.stage_from` は組の種類（`frozen-stage-input-set`）・id・版・組のファイルの SHA、`params.stage_inputs` の本ごとの欄に組の出力ダイジェストと記録の写しの名前を足す。段だけの対の比較では両群に同じ組を渡し、対のファイルの `stage_from_sha256` は組のファイルの SHA
- **採点**：条件の `stage_from` が組のとき、本ごとの入力の照合は組の宣言（`stage_inputs` の出力ダイジェスト・写しの SHA）と照らす（記録の写しは組に写した名前で読む）。採点の出力の `stage_run.stage_from` に組の種類・id・版・SHA を足す。`--anonymous` には組の id・版・入力なしの件数だけ（本の ID・P の ID・SHA は出さない）
- **更新の決まり**：版を上げるのは**節目**だけ（一気通貫の節目で参照の計測を取り直したとき）。**版をまたいで比較しない**（比較では両群に同じ組）。**版 2** は正解の表から組む別の道具（この道具は版 1 の規則だけ）。組の採用（10 P × 1 を人が正解と照らし、採否のファイルで反映する）は人の作業

#### 10.8.2 U2 試験の指標（変異の検出率と落とせない試験の率）と、手 5b の評価口に台帳を渡す直し（#686。道具 `mutation/score-stage-tests.mjs`・`mutation/score-mutants.mjs`）

工程ごとの評価の単位 **U2**（C4 試験）の主指標を出す。入口は凍結した上流の組（境界 t1-t2。§10.8.1）、出口は境界 t2-b1 の checkpoint。T2 だけを流した段の走り（条件 v8・`params.mode` が stage-run・範囲 `test-spec`..`test-spec`・`stage_from` が凍結した上流の組）の記録と checkpoint を**参照の宣言**（P ごとに 1 本）に当て、手 5（手 5a の分類 → 手 5b の評価。§5.12）の変異の検出率と落とせない試験の率を本・P・群ごとに出す。計測の道具であって門ではない。工場の package を import せず、dist の公開の値と関数を計測の checkout の場所から読む。API・LLM・判定を呼ばない（費用 0）。

> 節の番号：既存の試験が §10.8 の下の末尾を照らすので、§10.8.1 の後ろに足した。§10.8.1 までの文は変えていない。凍結の道具の試験の末尾の条件は「§10.8.1 の後ろは `####` の小節だけ（`##`・`###` は無い）」に改めた。

- **使い方**：`node score-stage-tests.mjs <repo> <U2 の計測の出力先> <参照の宣言の組のディレクトリ> <出力先> [--compare] [--anonymous]`（先に `pnpm build`）。出力先は空か無いこと（`stage-tests:out-not-empty`）。出力は `stage-tests-score.json`（`--compare` は `stage-tests-compare.json`）・`--anonymous` のときは同じ名前の `.anonymous.json`・本ごとの文脈（`contexts/<本>.json`）・手 5a の出力（`mutants/<P>.json`）・手 5b の目録（`inventory.json`）で、文脈・目録・手 5a の出力の SHA を出力に残す。**置き場所はリポジトリの外**（参照の宣言の組・文脈・目録に題材の名前が入る）
- **参照の宣言の組**（`reference-declaration-set.json`。schema `musunest-eval/reference-declaration-set/v1`）：`id`・`version`・`rule`・`frozen_set`（上流の組の id・版・組のファイルの SHA）・`source`（参照の計測の条件のファイルの SHA・計測の ID）・`declarations[]`（P・出どころ `origin`（本の ID、または `human`）・宣言の写しの場所と SHA-256（`declarations/<P>/app.spec.yaml`）・`table_sha256`（その宣言が組まれた表の SHA）・印のファイル `marks`（任意。手 5a の印））・`missing[]`（P と理由の符号）・`signature`（`signature` を除いた組の JSON の SHA-256）
- **作り方（版 1 の規則 `adopted-run-declaration`）**：`node score-stage-tests.mjs --make-reference <参照の計測の出力先> <上流の組のディレクトリ> <参照の宣言の組のディレクトリ> --id <組の ID> --version <整数>`。**出どころを固定する**：上流の組の署名と写しの SHA が中身と合い `review` がある（人の採否が未反映の組は断る。`make-reference:set-review`・`make-reference:set-<状態>`）・参照の計測の条件のファイルの SHA-256 が上流の組の `source.conditions_sha256` と同じ（同じ本 ID・同じ表 SHA を持つ別の計測から写さない。`make-reference:source-mismatch`）。合わなければ何も書かず exit 3。通れば、組が採用した本と**同じ本**の受理済みの宣言（納品物の `bundle/artifacts/app.spec.yaml`）を写し、その本の受理済みの表（`bundle/artifacts/name-table.json`）の `table_sha256` が組の checkpoint の表の SHA と同じことを確かめる。違えば `missing`・`table-mismatch`、納品物の宣言の無い本の P は `no-declaration`、組が外した P（人が除外した P を含む）は `upstream-missing`。本を選ばせる引数は無い。人が正しい宣言を置く**版 2** は同じ形で、この道具では作らない
- **照合（fail-closed。口ごとに扱いが違う）**：
  - (a) **計測全体**：参照の宣言の組の形・署名・写しの SHA（`stage-tests:reference-<状態>`）、条件の版が v8 で署名が中身と合う（`stage-tests:conditions-version`）、mode・経路・範囲（`stage-tests:range`）、`stage_from` の組（種類・id・版・SHA）が参照の宣言の組の `frozen_set` と同じ（`stage-tests:frozen-set`）、条件の工場と spec-engine の dist の指紋が今の checkout の dist と同じ（`stage-tests:dist`）、定義ファイルの SHA（`stage-tests:set`）。合わなければ**何も書かず exit 3**・固定の符号の 1 行（値・パスを出さない）
  - (b) **本ごと**：段の走りの記録の範囲（`range`）、記録の `input` の出力ダイジェストが条件の `stage_inputs` と同じ（`input`）、本の確定した仕様の写し（`plan-file.json`）が凍結した組 (b) の SHA と工場の包みの検査を通り、その `plan_sha256` が記録と checkpoint の値と同じ（`plan`）、t2-b1 の checkpoint が宣言どおりにある（`checkpoint`）、記録の `checkpoints` の t2-b1 の出力ダイジェストが中身から計算し直した値と同じ（`digest`）、checkpoint の表の SHA が参照の宣言の `table_sha256` と同じ（`table`）、文脈が組める（`context`）。合わない本は **`mismatch`**（理由の符号）に数えて評価せず、**予定の分母に残す**（黙って落とさない）
  - (c) 参照の作成のときの表の不一致は、上の `missing`（`table-mismatch`）
- **文脈を組む**（本ごと。§5.12.4 の有効な評価の文脈の形）：表（checkpoint の `name_table` の行・所属・確かめ方・分類）・要件の一覧（確定した仕様の要件から、持ち越しと要件でない文を除いた有効な一覧）・試験の組（checkpoint の `test_spec` から持ち越しの要件の試験を除いたもの）と観測する性質・所属・除く行・持ち越し・棄却した試験の ID（T2 だけの走りでは空）・要件でない文・台帳の旗（checkpoint の版の旗 `ledger`）。一覧・組・所属は工場の dist の関数（`requirementsFromPlan`・`pruneForCarryOver`）で、工場の回す部分が B の評価口に渡す文脈と同じ導き方で作る（道具に写さない）。手 5a の分類（原本 → 変異）は P ごとに 1 回（原本は参照の宣言、印は参照の宣言の組の印）。目録（工場・spec-engine・appspec-schema の dist のファイルの一覧と SHA・採点のエンジン）を組んで手 5b の関数を呼ぶ。手 5b の断りは `stage-tests:mutation:<手 5b の符号>` で、書いたファイルを消して exit 3
- **手 5b の直し（評価口に台帳を渡す）**：文脈の `ledger.on` が真なら、目録の工場の dist が公開する台帳の正本から導いた見方（`ledgerViewOf`）を、工場の回す部分と同じ渡し方で評価口を作る引数に渡す（道具に台帳を写さない）。dist が公開しなければ `ledger_unavailable` で断る（黙って off にしない）。**off は今のまま**：指標・件数・分類・匿名の口・断りの符号は変わらず、変わるのは道具自身の指紋 `fingerprints.tool` とそれに由来する照合だけ。出力の `context.ledger_on` も今のまま。§5.12 の fail-closed（目録に無いファイルを読まない・SHA を全部照らす）は変えない
- **指標**：
  - **本ごと**：状態（上から最初に当てはまる 1 つ：入力なし `input-absent` → 欠測 `missing`（起こしたが記録が読めない）→ `mismatch` → 段を通らない `stage-failed` → 参照の宣言なし `no-reference` → 評価した `evaluated`）・段の通過・T2' の組の試験の数・外した試験の数・網羅の単位の数（記録の `test_spec`）・手 5b の候補の状態（`aligned`／`test-origin-mismatch`（試験と原本が合わない）／`origin-unusable`（原本不適））・主と副の検出率・落とせない試験の率（分子・分母）・分類の件数
  - **P ごと**：K 本の合算（その P の評価した本の分子の和 ÷ 分母の和）と本ごとの値
  - **群**：件数の**分母は予定**（条件の `child_args` の全部）。入力なし・欠測・`mismatch`（理由ごと）・段を通らない・参照の宣言なし・原本不適・試験と原本が合わない・適格な変異 0・評価した、を別に数え、その和が予定に等しい（観測・段の通過も数える）。率は P を単位にした平均と bootstrap の区間（表の採点の `patternInterval` を import。写さない）。全部を合わせた率の Wilson は**参考**（独立を仮定）。演算子ごとの件数と率も出す。**分母 0 は null と理由の符号**
- **`--compare`**：段だけの対の比較の記録（§5.11.6。群 before／after）の出力先を渡す。両群の条件に (a) を当て（dist の指紋は今の checkout ＝ after の群の条件と照らす。両群とも今の checkout の評価口で評価する）、同じ P・同じ回の本を対にして、主の検出率と落とせない試験の率の差（after − before）・P のまとまり（符号反転の p と bootstrap の区間。`clusterStats`）を出す。片側が欠測・`mismatch`・参照なし・段を通らない・試験と原本が合わない・適格な変異 0 の対は除き、理由ごとの件数を出す
- **`--anonymous`**：件数・率・区間・演算子の ID だけ（P の番号・本の ID・宣言の名前・組の ID・パス・SHA を出さない）。標準出力の要約も P の番号・本の ID を含まない
- **読み方**：検出率は適格な変異に限る**条件付き**の率（§5.12.2）。**版 1** の参照の宣言は参照の計測の受理済みの宣言で、正しい宣言ではない。**版をまたいで比較しない**。段の通過は**納品の成功ではない**。判定・門・merge の可否に使わない
- 範囲の外：参照の宣言の版 2（人の正しい宣言）、U2 の 1 段先（U3 の停滞率・C7 の不一致）、正解の試験との一致、工場の変更
