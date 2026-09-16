# @musunest/spec-engine

アプリの宣言（`app.spec.yaml`）の**静的チェック**と、手元・CI から呼ぶ入口である（Issue #97）。
宣言の形・語彙・見本・負例・意味の文書は [`@musunest/appspec-schema`](../appspec-schema)（契約の正本）にあり、
このパッケージはそれを**読んで検査する**。層と検査項目の考え方は
[`workspace/mvp/m1/03-spec-layers-and-checker.md`](../../workspace/mvp/m1/03-spec-layers-and-checker.md) §5 にある。

## 1. 何をするか

- 宣言を**実行せずに**検査する（形・データ層・ロジック層・UI・権限）。式は AST に解析して**型だけ**を見る
  （`eval` / `Function` を使わない。03 §5.3・CLAUDE.md の不変条件）
- 誤りは **3 つ組**で返す：機械向けの誤りコード・日本語の説明・原文の位置（1 始まりの行と列。03 §5.3）
- 式には上限を付ける（文字数 200・深さ 8・ノード 64。§6）
- **ストレージ（D1・R2・DO）に触れない。** 原本を読むのは入口（CLI）だけである
- 値の計算（評価）は #98 が受け持つ。**ここが公開する AST・演算子・関数定義・上限定数を評価も使う**
  （判定が 2 か所に分かれると、検査は通るのに店頭で動かない）

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
検査と入口で判定が食い違うと、CI と publish の判定がずれる。

## 3. 使い方（ライブラリ）

```ts
import { checkSpec } from "@musunest/spec-engine";

const result = checkSpec(yamlText);
if (result.ok) {
  result.spec; // 型検査済みの AppSpec（appspec-schema の型）
} else {
  result.diagnostics; // Diagnostic[]（code・message・line・column）
}
```

| 公開しているもの | 中身 |
|---|---|
| `checkSpec(source)` | YAML の原文 → `AppSpec` または診断の配列 |
| `Diagnostic`・`DIAGNOSTIC_CODES`・`compareDiagnostics`・`formatDiagnostic` | 診断の型・一覧・並べ方・人向けの 1 行 |
| `parseExpression`・`readExpression`・`analyzeExpression`・`countNodes`・`depthOf`・`positionAt` | 式の解析（AST）と型の検査。#98 の評価はここから AST を受け取る |
| `EXPRESSION_LIMITS`・`EXPRESSION_LIMIT_CODES`・`EXPRESSION_LIMIT_NAMES` | 式の上限（チェックと評価で同じ値を使う） |
| `ARITHMETIC_OPERATORS`・`COMPARISON_OPERATORS`・`BUILTIN_FUNCTIONS`（appspec-schema から再輸出） | 演算子と店頭が用意する関数の定義（正本は appspec-schema） |
| `CheckResult`・`AstNode`・`SpecType`・`ExpressionScope` | 呼ぶ側が使う型 |

依存の向きは `spec-engine → appspec-schema` だけである（`infra/scripts/dep-graph.mjs`）。

## 4. 診断の一覧（誤りコード）

コードの形式は `<種類>_<対象>_<問題>`（`ERROR_CODE_PATTERN`）。正本は
[`src/diagnostics.ts`](./src/diagnostics.ts) の `DIAGNOSTIC_CODES` で、unit テストが
「一覧にあること」と「形に合っていること」を確かめる。**既に台帳・負例にあるコードの別名は作らない。**

| コード | いつ出るか |
|---|---|
| `SHAPE_YAML_INVALID` | YAML として読めない（この検査が読める形の範囲外も含む。§5） |
| `SHAPE_KEY_MISSING` | 必須の欄・キーが無い（7 欄すべてを書く。中身が無ければ `[]`） |
| `SHAPE_KEY_UNKNOWN` | その版の語彙に無い欄・キー（`label`・`kind`・`type` など、まだ入っていない語彙） |
| `SHAPE_KEY_DUPLICATE` | 同じ欄を 2 回書いている |
| `SHAPE_NAME_INVALID` | 名前が英字で始まる英数字ではない |
| `SHAPE_VALUE_INVALID` | 値の形が違う（欄が並びでない、`name` が空、写像でない、など） |
| `SHAPE_CHECK_FAILED` | 検査の途中で予期しない例外が出た（外へ投げずにこれを返す） |
| `DATA_ENTITY_DUPLICATE_NAME` | entity の名前が重なっている |
| `DATA_FIELD_DUPLICATE_NAME` | 同じ entity の中で項目の名前が重なっている |
| `DATA_FIELD_NAME_RESERVED` | `id`・`createdAt`・`updatedAt` を項目名に使っている |
| `DATA_FIELD_TYPE_UNKNOWN` | M1.1 の型（`string`・`number`・`list`）に無い型 |
| `LOGIC_ENTITY_NOT_FOUND` | action・validation・computed の `entity` が宣言に無い |
| `LOGIC_REFERENCE_NOT_FOUND` | 式が参照する名前が、同じ entity の項目にも計算にも無い |
| `LOGIC_REFERENCE_OUT_OF_ENTITY` | 別の（または同じ）entity の名前を `.` で参照している（M1.1 は書けない） |
| `LOGIC_COMPUTED_CYCLE` | 計算どうしの参照が循環している（自分自身を含む） |
| `LOGIC_COMPUTED_NAME_CONFLICT` | 計算の名前が、同じ entity の項目の名前と重なっている |
| `LOGIC_COMPUTED_NAME_RESERVED` | 計算の名前に `id`・`createdAt`・`updatedAt` を使っている |
| `LOGIC_COMPUTED_DUPLICATE_NAME` | 計算の名前が重なっている |
| `LOGIC_COMPUTED_TYPE_MISMATCH` | 計算の式の型が `type` と食い違う |
| `LOGIC_COMPUTED_TYPE_UNKNOWN` | 計算の `type` が M1.1 の型（`number`）に無い |
| `LOGIC_VALIDATION_NOT_BOOLEAN` | 検査の式が真偽にならない |
| `LOGIC_VALIDATION_DUPLICATE_NAME` | 検査の名前が重なっている |
| `LOGIC_ACTION_DUPLICATE_NAME` | 操作の名前が重なっている |
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
| `PERMISSION_NAME_NOT_ALLOWED` | 権限の名前が M1.1（`read`・`write`）に無い |
| `PERMISSION_SUBJECT_NOT_ALLOWED` | `subject` が M1.1（`minIdentity`）に無い |
| `PERMISSION_IDENTITY_MODE_NOT_ALLOWED` | `minIdentity.mode` が M1（`anonymous`）に無い |
| `PERMISSION_DUPLICATE_NAME` | 権限の名前が重なっている |

- 台帳（`vocabulary.yaml` の `check_rules`）と負例（`samples/negatives/index.json` の `codes`）に書いたコードは、
  **この検査が実装する期待値**である。負例 24 件については、返るコードの集合が一覧と**ちょうど一致**することを
  unit テストで固定している
- 誤りの内側の型は決められないものとして扱う（`unknown`）。だから 1 つの誤りが 2 つ以上のコードに化けない
  （例：`max(participants, 1)` は `LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH` だけを返し、計算の `type` の
  不一致には化けない）
- 位置は、名前・キー・式の**始まるところ**を指す。式の中の誤りは、その式の中の位置を指す
  （引用符つきの値では、引用符の分だけ後ろへずれる）

## 5. 読み取れる YAML の書き方

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

## 6. 式の上限

| 上限 | 値 | 1 超過の診断 |
|---|---|---|
| 文字数 | 200 | `LOGIC_EXPRESSION_TOO_LONG` |
| 深さ（葉を 1 と数える） | 8 | `LOGIC_EXPRESSION_DEPTH_EXCEEDED` |
| AST のノード数 | 64 | `LOGIC_EXPRESSION_NODES_EXCEEDED` |

- **ちょうどは通り、1 超過で診断になる**（unit テストで両側を実測する）
- 上限を超えた式は**解析もしない**（長さで先に打ち切る）。評価（#98）も同じ入口を通す
- 値と意味は `src/limits.ts` の `EXPRESSION_LIMITS` が正本で、#98 はこれを読む
- 2026-09-16 に窓口が決定（見本の式は深さ 3 程度）。#111 の実測を見て M1.5 で見直す。
  CPU の実測から決めるアプリ全体の規模の目安とは別物である

## 7. テスト（受入条件との対応）

```bash
pnpm --filter @musunest/spec-engine test    # unit（このパッケージ）
pnpm test                                   # リポジトリ全体（turbo + infra/scripts）
pnpm check                                  # verify-parity → lint → typecheck → test → tf-fmt → tf-validate
```

| 受入条件（Issue #97） | 担保するテスト |
|---|---|
| 見本 `expense-log` の診断が空で、7 欄を持つ AppSpec を返す | `src/check.test.ts`「見本 expense-log」 |
| チェック中に式の実行やストレージ操作を行わない | `src/check.test.ts`「検査は式を実行しない・ストレージに触れない」（`eval`・`Function`・`fetch` を禁じた状態で検査し、ライブラリのソースも走査する） |
| 負例 24 件の誤りコードの集合が一覧の `codes` と一致する | `src/check.test.ts`「負例」の `it.each`（`it.each` は負例の一覧から作る） |
| 診断の説明が空でなく、位置が該当する YAML の行・列を指す | 同上（全件）＋「位置は、該当する式の始まるところを指す」 |
| 不正 YAML・未知キー・未知参照・自己循環・複数要素の循環を拒否する | 「不正な YAML は断る」「形の検査」「計算の循環」 |
| 深さ 8・ノード 64・200 文字ちょうどは通り、1 超過は上限の診断になる | `src/expression.test.ts`「式の上限」と `src/check.test.ts`「式の上限」（両側を実測） |
| 正例の CLI 終了コードは 0、負例は非 0。ライブラリの結果と一致する | `src/cli.test.ts`（子プロセスで終了コードを実測し、出力の誤りコードを `checkSpec` と突き合わせる） |
| 不正入力でも未捕捉例外や無限ループにならない | `src/cli.test.ts`（`error` と `signal` を見る。timeout つきの `spawnSync`） |
| 入口は薄い CLI で、同パッケージに `spec:check` がある | `src/cli.test.ts`「リポジトリの直下からの呼び出し」（`pnpm --filter … spec:check -- <原本>` を実際に走らせる） |

- 実測した終了コードと実行コマンドは、PR の証跡に転記する（この README はコマンドと対応表までを持つ）

## 8. 作りについて

- `src/check.ts` … YAML の読み取り（位置つき）と、欄ごとの検査、公開の入口 `checkSpec`
- `src/expression.ts` … 式の字句・解析（AST）・型の検査・位置の写し
- `src/diagnostics.ts` … 診断の型と誤りコードの一覧（正本）
- `src/limits.ts` … 式の上限定数（評価と共有）
- `src/cli.ts` … 入口。原本を読み、`checkSpec` の結果を終了コードにする
- `src/index.ts` … 公開する面（依存の向きは appspec-schema だけ）
- `tsconfig.json` の `types` に `"node"` を足しているのは、**このパッケージだけ**が Node で走る入口
  （CLI）を持つためである。ライブラリの中身（`check.ts` など）は Node の API を使わず、
  unit テストがソースを走査して確かめる
