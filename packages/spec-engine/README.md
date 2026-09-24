# @musunest/spec-engine

アプリの宣言（`app.spec.yaml`）の**静的チェック**と、その入口である（Issue #97）。検査を通った宣言を
**正規化した JSON** にし（#98。Q12）、**同じ entity の中の計算と検査**を評価する（#98）。
宣言の形・語彙・見本・負例・意味の文書は [`@musunest/appspec-schema`](../appspec-schema)（契約の正本）にあり、
このパッケージはそれを**読んで検査し、評価する**。層と検査項目の考え方は
[`workspace/mvp/m1/03-spec-layers-and-checker.md`](../../workspace/mvp/m1/03-spec-layers-and-checker.md) §5 にある。

## 1. 何をするか

- 宣言を**実行せずに**検査する（形・データ層・ロジック層・UI・権限）。式は AST に解析して**型だけ**を見る
  （`eval` / `Function` を使わない。03 §5.3・CLAUDE.md の不変条件）
- 誤りは **3 つ組**で返す：機械向けの誤りコード・日本語の説明・原文の位置（1 始まりの行と列。03 §5.3）
- 式には上限を付ける（文字数 200・深さ 8・ノード 64。§8）
- **検査を通った宣言だけ**を、正規化した JSON（`NormalizedAppSpec`）にする（§5。Q12）
- 検査済みの宣言と 1 件のレコードから、**computed の値と、通らなかった validation の名前**を求める（§6）
- **ストレージ（D1・R2・DO）に触れない。** 原本を読むのは入口（CLI）だけである
- **評価の時計は引数で受け取る**（§6。Q17）。日付の関数は M1.1 には無い

検査と評価は、**同じ AST・演算子・関数定義・上限定数**を使う（`src/expression.ts`・`src/limits.ts`）。
判定が 2 か所に分かれると、検査は通るのに店頭で動かない（03 §5.3）。

`checkSpec` は**例外を外へ出さない**。読めない入力も「読めなかった」という診断にして返す
（呼ぶ側がプロセスを落とすかどうかを決められるようにする）。

## 2. 入口（CLI）

リポジトリの直下から、次のように呼ぶ。

```bash
pnpm --filter @musunest/spec-engine spec:check -- packages/appspec-schema/samples/expense-log/app.spec.yaml
```

- 出す形：`<原本>:<行>:<列>: <誤りコード>: <説明>`（1 診断 1 行。エディタと grep でたどれる）
- **診断が無ければ何も出さない**（Unix の作法。CI では終了コードだけを見る）
- 相対パスは、**走っているディレクトリ**（`pnpm` は script を `packages/spec-engine` で走らせる）、
  次に**リポジトリの直下**（`pnpm-workspace.yaml` のあるディレクトリ）の順に探す。絶対パスはそのまま使う

| 終了コード | 意味 |
|---|---|
| `0` | 診断なし（宣言は検査を通った） |
| `1` | 診断あり（宣言が誤っている） |
| `2` | 使い方の誤り（原本のパスが無い・2 つ以上） |
| `3` | 原本を読めない（パスが無い・ディレクトリ・権限が無い） |

`--help`（`-h`）は使い方を出して `0` で終わる。`--` は `pnpm` がそのまま引数として渡すので、先頭の 1 つを読み飛ばす
（2026-09-16 実測・pnpm 10.13.1）。

**CLI は publish も評価もしない。** 中身は `checkSpec` で、入口は薄い（原本の読み取りだけで、書き込みも式の実行もしない）。
検査と入口で判定が食い違うと、CI と publish の判定がずれる。publish と評価の入口は**ライブラリ**である
（`normalizeSpec`・`evaluateRecord`。§5・§6）。

## 3. 使い方（ライブラリ）

```ts
import { checkSpec, evaluateRecord, fixedClock, normalizeSpec } from "@musunest/spec-engine";

const checked = checkSpec(yamlText);
if (checked.ok) {
  checked.spec; // 型検査済みの AppSpec（appspec-schema の型）
} else {
  checked.diagnostics; // Diagnostic[]（code・message・line・column）
}

// publish の時点（Q12）。検査に通らなければ、成果物を返さない
const normalized = await normalizeSpec(yamlText);
if (normalized.ok) {
  normalized.app;  // NormalizedAppSpec（schemaVersion・sourceSha256・spec）
  normalized.json; // 正規化した JSON の本文（そのまま R2 に置く）
}

// リクエストの時点。評価が受け取るのは**正規化した成果物だけ**である（未検査の YAML は渡せない）
const evaluation = evaluateRecord({
  app: normalized.app,
  entity: "expense",
  record: { description: "夕食", amount: 6600, discount: 600, payer: "A", participants: ["A", "B", "C"] },
  clock: fixedClock("2026-09-16T12:00:00+09:00"),
});
evaluation.computed;    // { paidAmount: 6000, headcount: 3, shareAmount: 2000 }（宣言の順）
evaluation.validations; // 通らなかった検査の名前（宣言の順）。空なら保存してよい
```

| 公開しているもの | 中身 |
|---|---|
| `checkSpec(source)` | YAML の原文 → `AppSpec` または診断の配列 |
| `normalizeSpec(source)` | YAML の原文 → `NormalizedAppSpec` と JSON（検査に通らなければ診断だけ。§5） |
| `serializeNormalizedAppSpec(app)` | 正規化した成果物 → JSON の本文（出力の規約は 1 か所。§5） |
| `sha256Hex(text)` | 文字列の UTF-8 バイト列の SHA-256（小文字 16 進 64 桁） |
| `evaluateRecord(request)` | 検査済みの宣言・レコード・時計 → computed の値と失敗した検査の名前（§6） |
| `fixedClock(instant)`・`systemClock()`・`Clock`・`isClockInstant` | 差し込む時計（§6。Q17） |
| `Diagnostic`・`DIAGNOSTIC_CODES`・`compareDiagnostics`・`formatDiagnostic` | 診断の型・一覧・並べ方・人向けの 1 行 |
| `parseExpression`・`readExpression`・`analyzeExpression`・`countNodes`・`depthOf`・`positionAt` | 式の解析（AST）と型の検査。評価はここから AST を受け取る |
| `EXPRESSION_LIMITS`・`EXPRESSION_LIMIT_CODES`・`EXPRESSION_LIMIT_NAMES` | 式の上限（チェックと評価で同じ値を使う） |
| `ARITHMETIC_OPERATORS`・`COMPARISON_OPERATORS`・`BUILTIN_FUNCTIONS`（appspec-schema から再輸出） | 演算子と店頭が用意する関数の定義（正本は appspec-schema） |
| `CheckResult`・`NormalizeResult`・`Evaluation`・`EvaluationRequest`・`ComputedValue`・`AstNode`・`SpecType`・`ExpressionScope` | 呼ぶ側が使う型 |

依存の向きは `spec-engine → appspec-schema` だけである（`infra/scripts/dep-graph.mjs`）。

## 4. 診断の一覧（誤りコード）

コードの形式は `<種類>_<対象>_<問題>`（`ERROR_CODE_PATTERN`）。正本は
[`src/diagnostics.ts`](./src/diagnostics.ts) の `DIAGNOSTIC_CODES` で、unit テストが
「一覧にあること」と「形に合っていること」を確かめる。**既に台帳・負例にあるコードの別名は作らない。**
**新しい診断は、実装側（`check.ts`）に定義せず、この一覧に足す。**

| コード | いつ出るか |
|---|---|
| `SHAPE_YAML_INVALID` | YAML として読めない（この検査が読める形の範囲外も含む。§7） |
| `SHAPE_KEY_MISSING` | 必須の欄・キーが無い（7 欄すべてを書く。中身が無ければ `[]`） |
| `SHAPE_KEY_UNKNOWN` | その版の語彙に無い欄・キー（`label`・`required` など、まだ入っていない語彙。一覧の `type` の値と操作の `kind` の値もここではなく下表で断る） |
| `SHAPE_KEY_DUPLICATE` | 同じ欄を 2 回書いている |
| `SHAPE_NAME_INVALID` | 名前が英字で始まる英数字ではない |
| `SHAPE_VALUE_INVALID` | 値の形が違う（欄が並びでない、`name` が空、写像でない、など） |
| `SHAPE_VALIDATION_MESSAGE_INVALID` | 検査の文言（`message`）が、空でない文字列になっていない（M1.2） |
| `SHAPE_CHECK_FAILED` | 検査の途中で予期しない例外が出た（外へ投げずにこれを返す） |
| `DATA_ENTITY_DUPLICATE_NAME` | entity の名前が重なっている |
| `DATA_FIELD_DUPLICATE_NAME` | 同じ entity の中で項目の名前が重なっている |
| `DATA_FIELD_NAME_RESERVED` | `id`・`createdAt`・`updatedAt` を項目名に使っている |
| `DATA_FIELD_TYPE_UNKNOWN` | M1.1 の型（`string`・`number`・`list`）に無い型 |
| `DATA_REF_TARGET_NOT_FOUND` | 参照（`ref`・参照 list）の参照先の entity が宣言に無い（M1.2） |
| `LOGIC_ENTITY_NOT_FOUND` | action・validation・computed の `entity` が宣言に無い |
| `LOGIC_REFERENCE_NOT_FOUND` | 式が参照する名前が、同じ entity の項目にも計算にも無い |
| `LOGIC_REFERENCE_OUT_OF_ENTITY` | 別の（または同じ）entity の名前を `.` で参照している（M1.1 は書けない） |
| `LOGIC_COMPUTED_CYCLE` | 計算どうしの参照が循環している（自分自身を含む。集計をまたぐ循環も同じ） |
| `LOGIC_COMPUTED_NAME_CONFLICT` | 計算の名前が、同じ entity の項目の名前と重なっている |
| `LOGIC_COMPUTED_NAME_RESERVED` | 計算の名前に `id`・`createdAt`・`updatedAt` を使っている |
| `LOGIC_COMPUTED_DUPLICATE_NAME` | 計算の名前が重なっている（entity に 2 つ目の精算を書いたときも同じ） |
| `LOGIC_COMPUTED_TYPE_MISMATCH` | 計算の式の型が `type` と食い違う |
| `LOGIC_COMPUTED_TYPE_UNKNOWN` | 計算の `type` が M1.1 の型（`number`）に無い |
| `LOGIC_AGGREGATE_FORM_INVALID` | 集計の形が不正（`sum` と `count` の同時指定、どちらも無い、対象の書き方。M1.2） |
| `LOGIC_AGGREGATE_TARGET_NOT_FOUND` | 集計の対象（entity・項目・計算）が宣言に無い（M1.2） |
| `LOGIC_AGGREGATE_TARGET_NOT_NUMBER` | 集計の対象（`sum`）が数ではない（M1.2） |
| `LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH` | 集計の `where` が、集計元の項目と `this` の参照型に合わない（M1.2） |
| `LOGIC_SETTLE_AMOUNT_NOT_NUMBER` | 精算（`settle`）の額の項目が、支出の entity の数の項目でない（M1.2） |
| `LOGIC_SETTLE_REFERENCE_TYPE_MISMATCH` | 精算の払った人・割る人が、精算する entity を指す参照でない（M1.2） |
| `LOGIC_VALIDATION_NOT_BOOLEAN` | 検査の式が真偽にならない |
| `LOGIC_VALIDATION_DUPLICATE_NAME` | 検査の名前が重なっている |
| `LOGIC_ACTION_DUPLICATE_NAME` | 操作の名前が重なっている |
| `LOGIC_ACTION_KIND_NOT_ALLOWED` | 操作の `kind`（種類）が M1.2 の語彙（`create`・`update`・`delete`）に無い（M1.2） |
| `LOGIC_FUNCTION_NOT_ALLOWED` | 店頭が用意していない関数を使っている（M1.1 は `min`・`max`・`len`） |
| `LOGIC_FUNCTION_ARITY_MISMATCH` | 関数に渡す引数の数が合わない |
| `LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH` | 関数に渡す引数の型が合わない |
| `LOGIC_OPERAND_TYPE_MISMATCH` | 演算子の左右の型が合わない（数どうしの計算・比較に数でないものを書いている） |
| `LOGIC_EXPRESSION_INVALID` | 式を解析できない（書けない文字・括弧の閉じ忘れ・比較の連鎖） |
| `LOGIC_EXPRESSION_TOO_LONG` | 式の文字数が上限（200）を超えている |
| `LOGIC_EXPRESSION_DEPTH_EXCEEDED` | 式の深さが上限（8）を超えている |
| `LOGIC_EXPRESSION_NODES_EXCEEDED` | 式のノード数が上限（64）を超えている |
| `UI_ENTITY_NOT_FOUND` | 一覧の `entity` が宣言に無い |
| `UI_VIEW_DUPLICATE_NAME` | 一覧の名前が重なっている |
| `UI_FIELD_NOT_FOUND` | 表（`type: table`）の `show` に書いた名前が、項目にも計算にも無い（M1.2） |
| `PERMISSION_NAME_NOT_ALLOWED` | 権限の名前が M1.1（`read`・`write`）に無い |
| `PERMISSION_SUBJECT_NOT_ALLOWED` | `subject` が M1.1（`minIdentity`）に無い |
| `PERMISSION_IDENTITY_MODE_NOT_ALLOWED` | `minIdentity.mode` が M1（`anonymous`）に無い |
| `PERMISSION_DUPLICATE_NAME` | 権限の名前が重なっている |

- 台帳（`vocabulary.yaml` の `check_rules`）と負例（`samples/negatives/index.json` の `codes`）に書いたコードは、
   **この検査が実装する期待値**である。負例 81 件については、返るコードの集合が一覧と**ちょうど一致**することを
  unit テストで固定している
- 誤りの内側の型は決められないものとして扱う（`unknown`）。だから 1 つの誤りが 2 つ以上のコードに化けない
  （例：`max(participants, 1)` は `LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH` だけを返し、計算の `type` の
  不一致には化けない）
- 位置は、名前・キー・式の**始まるところ**を指す。式の中の誤りは、その式の中の位置を指す
  （引用符つきの値では、引用符の分だけ後ろへずれる）

## 5. 正規化した JSON（publish が作る形）

publish の時点で、**検査を通った宣言だけ**を正規化した JSON（`NormalizedAppSpec`）にして R2 に置く
（`00-open-questions.md` Q12・`04-spec-evolution.md` §3）。data-api と画面はこの JSON だけを読み、
**実行のたびに YAML の解析と静的チェックを繰り返さない**（CPU 10 ms のため）。

```json
{ "schemaVersion": "community.app-spec/v0.2", "sourceSha256": "<64 桁>", "spec": { ... } }
```

| 決めごと | 中身 |
|---|---|
| 検査との関係 | **検査に 1 つでも通らなければ、成果物を返さない**（診断だけを返す）。判定は `checkSpec` の 1 か所だけに置く |
| 原本の識別 | `sourceSha256` は、**原本そのもの**（改行とコメントを含む UTF-8 のバイト列）の SHA-256。小文字の 16 進 64 桁。コメントを 1 行足すだけで変わる |
| 決定的であること | 同じ原本からは**同じバイト列**。現在時刻・乱数・環境の情報を混ぜない |
| 宣言の順 | **並べ替えない。** entity の項目順と、view・computed・validation・action の宣言順は意味を持つ（一覧の列の順・検査を返す順。`docs/semantics.md`）。無条件のキー並べ替えをしない |
| 出力の規約 | UTF-8・改行は LF・字下げは 2 文字（`NORMALIZED_JSON_INDENT`）・**末尾に改行 1 つ**・キーの並びは `schemaVersion` → `sourceSha256` → `spec` |
| バージョン | `APPSPEC_SCHEMA_VERSION`（M1.1〜M1.4 は `community.app-spec/v0.2`。appspec-schema が正本） |

- 正規化は `crypto.subtle` を使うので、Node でも Workers でも動く（依存を足さない）
- 失敗のときは `app`・`json` の欄そのものが無い（受け取った側が中身を読めない）

## 6. 評価（同じ entity の中の計算と検査）

data-api が、**検査済みの宣言**と 1 件のレコードと**差し込んだ時計**を受け取り、computed の値と、
通らなかった validation の名前を求める（`docs/semantics.md`「computed」「validation」）。
**入力の型検査と保存は data-api の担当である**——ここは型検査を通ったレコードだけを受け取る。

| 決めごと | 中身 |
|---|---|
| 入口 | `evaluateRecord({ app, entity, record, clock })`。`app` は**正規化した成果物だけ**（未検査の YAML を渡す口は無い） |
| 依存の順 | computed を参照する computed を、**宣言の並びによらず依存の順**に評価する。循環は `null`（検査が `LOGIC_COMPUTED_CYCLE` で断るが、渡されても止まらない） |
| 返す並び | `computed` のキーは**宣言の順**。`validations` は通らなかった検査の名前を**宣言の順**に並べる |
| すべて評価する | validation は途中で打ち切らない。真にならなかったものを**すべて**返す（`amount=0, discount=-100` は `positiveAmount, nonNegativeDiscount` の順） |
| 非有限の値 | 計算の途中で有限の数でなくなったら（0 で割る・桁あふれ）、computed は `null`、その検査は不合格。**0 に読み替えない**（`ratio == 0` のような検査が、誤って通らないようにする） |
| 真になったときだけ通る | 検査の式が `true` を返したときだけ「通った」とする。`null`（求められない）や真偽でない値は通らない |
| 上限 | 静的チェックと**同じ** `EXPRESSION_LIMITS`（文字数 200・深さ 8・ノード 64）を評価でも見る。超えた式は解析も評価もせず、computed は `null`・検査は不合格（成果物が手で作られていても成功値にしない） |
| レコード | **書き換えない。** 計算値は戻り値にだけ入れる |
| 時計 | **引数で受け取る**（`Clock`）。評価の中で `Date.now()` を読まない。M1.1 に日付の関数は無いので値は時計に依らないが、M1.3 の「今日」「今月」はここへ差し込む（Q17） |
| 式の実行 | `eval` / `Function` を使わない。AST を歩いて値を求める（AST は上限の内側でしか作らないので、歩く深さも有界） |

- 時計は `fixedClock("2026-09-16T12:00:00+09:00")`（採点のシナリオ）と `systemClock()`（リクエストの経路）。
  **オフセットの無い時刻は読まない**——実行する環境の時間帯で意味が変わるためである
- **API に時計を書き換える入口は作らない**（Q17）。staging の e2e は、時計に依存しない値と SHA の照合だけを見る

## 7. 読み取れる YAML の書き方

**読み取れる形を絞り、外れた入力は黙って無視せずに断る**（読めない行を捨てると、書いた宣言の一部が
「無かったこと」になり、検査が空振りする）。

| 読める | 読めない（`SHAPE_YAML_INVALID`） |
|---|---|
| `欄: 値` の写像（字下げで入れ子にする） | 1 行に書く写像（`{ mode: anonymous }`） |
| `- ` で始まる並び（要素は写像かスカラ） | ブロックの値（`\|` と `>`）・アンカーと別名（`&`・`*`）・タグ（`!`） |
| 空白の直後の `#` から行末までのコメント | インデントのタブ |
| 1 行の並び（`[]`・`[a, b]`） | 複数の宣言（`---` は先頭の 1 つだけ） |
| 引用符つきのスカラ（`"…"` は `\n \t \r \" \\`、`'…'` は `''`） | 予約された記号から始まる値（`@`・`` ` ``・`%`） |
| 先頭の `---` 1 つ | 値の中の `: `（入れ子を 1 行に重ねる書き方） |

- **値はすべて文字列として読む。** YAML がほかの型に読む値（`true`・数・日付）を宣言に書くと、
  名前や型の検査で落ちる（黙って解釈しない）
- YAML のライブラリを足さない理由：ワークスペースのパッケージは依存を持たない方針で、
  appspec-schema の台帳の読み取り（`src/ledger-yaml.ts`）も同じ理由で自前の読み取りを持っている。
  また `data-api` は `spec-engine` に依存するので、**リクエスト経路の Worker に YAML パーサを持ち込まない**
  意味もある（宣言の解析は publish の時点で済ませる。Q12）
- 読める形を広げるときは、`README`・`src/check.ts` の冒頭・この表を同じ PR で直す

## 8. 式の上限

| 上限 | 値 | 1 超過の診断 |
|---|---|---|
| 文字数 | 200 | `LOGIC_EXPRESSION_TOO_LONG` |
| 深さ（葉を 1 と数える） | 8 | `LOGIC_EXPRESSION_DEPTH_EXCEEDED` |
| AST のノード数 | 64 | `LOGIC_EXPRESSION_NODES_EXCEEDED` |

- **ちょうどは通り、1 超過で診断になる**（unit テストで両側を実測する）
- 上限を超えた式は**解析もしない**（長さで先に打ち切る）。評価（§6）も同じ入口を通す
- 値と意味は `src/limits.ts` の `EXPRESSION_LIMITS` が正本で、評価（#98）もこれを読む
- 2026-09-16 に窓口が決定（見本の式は深さ 3 程度）。#111 の実測を見て M1.5 で見直す。
  CPU の実測から決めるアプリ全体の規模の目安とは別物である

## 9. テスト（受入条件との対応）

```bash
pnpm --filter @musunest/spec-engine test    # unit（このパッケージ）
pnpm test                                   # リポジトリ全体（turbo + infra/scripts）
pnpm check                                  # verify-parity → lint → typecheck → test → tf-fmt → tf-validate
```

| 受入条件（Issue #97） | 担保するテスト |
|---|---|
| 見本 `expense-log` の診断が空で、7 欄を持つ AppSpec を返す | `src/check.test.ts`「見本 expense-log」 |
| チェック中に式の実行やストレージ操作を行わない | `src/check.test.ts`「検査は式を実行しない・ストレージに触れない」（`eval`・`Function`・`fetch` を禁じた状態で検査し、ライブラリのソースも走査する） |
| 負例 81 件の誤りコードの集合が一覧の `codes` と一致する | `src/check.test.ts`「負例」の `it.each`（`it.each` は負例の一覧から作る） |
| 診断の説明が空でなく、位置が該当する YAML の行・列を指す | 同上（全件）＋「位置は、該当する式の始まるところを指す」 |
| 不正 YAML・未知キー・未知参照・自己循環・複数要素の循環を拒否する | 「不正な YAML は断る」「形の検査」「計算の循環」 |
| 深さ 8・ノード 64・200 文字ちょうどは通り、1 超過は上限の診断になる | `src/expression.test.ts`「式の上限」と `src/check.test.ts`「式の上限」（両側を実測） |
| 正例の CLI 終了コードは 0、負例は非 0。ライブラリの結果と一致する | `src/cli.test.ts`（子プロセスで終了コードを実測し、出力の誤りコードを `checkSpec` と突き合わせる） |
| 不正入力でも未捕捉例外や無限ループにならない | `src/cli.test.ts`（`error` と `signal` を見る。timeout つきの `spawnSync`） |
| 入口は薄い CLI で、同パッケージに `spec:check` がある | `src/cli.test.ts`「リポジトリの直下からの呼び出し」（`pnpm --filter … spec:check -- <原本>` を実際に走らせる） |

| 受入条件（Issue #98） | 担保するテスト |
|---|---|
| 同じ原本を時刻・実行回数を変えて正規化しても JSON バイト列が一致する | `src/normalize.test.ts`「同じ原本からは同じバイト列になる」（`Date.now` と `Math.random` を差し替えて実測） |
| `sourceSha256` が原本の独立した SHA-256 と一致し、コメントを足すと変わる | 同「見本 expense-log の正規化」（`node:crypto` で計算し、バイト列そのものと突き合わせる） |
| 項目・検査の宣言順が維持される | 同「宣言の順を並べ替えない」（逆向きの宣言でもその順のまま） |
| `expense-log` の時計 `2026-09-16T12:00:00+09:00` で 4 件の計算値が期待どおり | `src/evaluate.test.ts`「見本 expense-log の計算」（採点のシナリオの期待値と突き合わせる） |
| computed を参照する computed が宣言の並びによらず依存順に評価される | 同「computed を参照する computed の依存の順」（`shareAmount` を先に宣言した宣言で実測） |
| `amount=0, discount=-100` は `positiveAmount, nonNegativeDiscount` の順で返す | 同「型が正しい amount=0, discount=-100 …」（`amount=0` は両方の検査に落ちる） |
| `1/0` とオーバーフローの computed は `null`、それを使う検査は不合格 | 同「有限の数でなくなった計算」＋「不正な計算値を 0 に読み替えない」 |
| `max(1, headcount)` の正例は数値を返す | 同「max(1, headcount) は数値を返す（0 で割らないための守り）」 |
| 元の入力オブジェクトに計算値が書き込まれない | 同「計算値は戻り値にだけ入る」（入れ子まで凍らせたレコードを渡す） |
| #97 の負例は正規化されない | `src/normalize.test.ts`「検査に通らない原本は正規化しない」（負例 81 件を `it.each` で回す） |
| 評価側も同じ上限の直前・ちょうど・1 超過を検証し、超過を成功値にしない | `src/evaluate.test.ts`「式の上限」（文字数・深さ・ノードを 1 つずつ両側で実測。成果物を手で作った場合も測る） |
| 差し込む時計を変えても M1.1 の計算値は変わらない | 同「差し込む時計を変えても、M1.1 の計算値は変わらない」（4 つの時計で実測） |
| 時計は引数で受け取り、オフセットの無い時刻を読まない | `src/clock.test.ts` |
| 入口が根から読め、未検査の YAML を評価へ渡す口が無い | `src/index.test.ts`「公開する面」（宣言 → 正規化 → 評価の通し） |

| 受入条件（Issue #109。操作の種類） | 担保するテスト |
|---|---|
| 操作の `kind` に `create`・`update`・`delete` を書ける（語彙は閉じている） | `src/check.test.ts`「操作の種類（kind。M1.2）」（3 つを `it.each` で実測） |
| `kind` の省略は `create` として読み、宣言に欄を足さない（M1.1 の意味を変えない） | 同「kind を省略すると、欄そのものが無い」 |
| 未知の `kind` は `LOGIC_ACTION_KIND_NOT_ALLOWED` で落ち、位置は書いた語を指す | 同「未知の kind は …」／負例 `action-unknown-kind` |
| 導入で正例になった `action-with-kind`（`kind: create`）が通り、負例の一覧から外れている | 同「kind: create を書ける（負例 action-with-kind の正例）」 |
| 新しい見本（warikan の edit/delete）が静的チェックに通る | 「見本（appspec-schema の samples/）」の `it.each`（`warikan` を含む） |
| 台帳の `check_rules` と負例・意味の節が同期する | `@musunest/appspec-schema` の `src/index.test.ts`「語彙の台帳」 |

- 実測した終了コードと実行コマンドは、PR の証跡に転記する（この README はコマンドと対応表までを持つ）
- **実環境での確認は、ユニットテストとは別に証跡を残す**（staging の e2e は時計に依存しない値と SHA の照合だけ。Q16・Q17）

## 10. 作りについて

- `src/check.ts` … YAML の読み取り（位置つき）と、欄ごとの検査、公開の入口 `checkSpec`
- `src/normalize.ts` … 検査を通った宣言を正規化した JSON にする（Q12）
- `src/evaluate.ts` … 同じ entity の中の computed と validation の評価
- `src/clock.ts` … 評価に差し込む時計（Q17）
- `src/expression.ts` … 式の字句・解析（AST）・型の検査・位置の写し
- `src/diagnostics.ts` … 診断の型と誤りコードの一覧（正本。**新しいコードはここに足す**。§4）
- `src/limits.ts` … 式の上限定数（検査と評価で共有）
- `src/cli.ts` … 入口。原本を読み、`checkSpec` の結果を終了コードにする
- `src/index.ts` … 公開する面（依存の向きは appspec-schema だけ）
- `tsconfig.json` の `types` に `"node"` を足しているのは、**このパッケージだけ**が Node で走る入口
  （CLI）を持つためである。ライブラリの中身（`check.ts`・`normalize.ts`・`evaluate.ts`・`clock.ts`）は
  Node の API を使わず、unit テストがソースを走査して確かめる
  （`src/index.test.ts`「ライブラリのソースは、式の実行とストレージの入口を持たない」）
