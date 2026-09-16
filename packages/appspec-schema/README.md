# @musunest/appspec-schema

アプリの宣言（`app.spec.yaml`）の**契約の正本**である（企画書 13 章）。M1.1〜M1.4 は v0.2 の草案を置き、M1.5 で固めて工場（CommandAgent）へ渡す。
進め方は [`workspace/mvp/m1/04-spec-evolution.md`](../../workspace/mvp/m1/04-spec-evolution.md)、層は [`03-spec-layers-and-checker.md`](../../workspace/mvp/m1/03-spec-layers-and-checker.md) にある。

## 1. 置いてあるもの

| 場所 | 中身 | 誰が読むか |
|---|---|---|
| `src/spec.ts` | 宣言の型、語彙の定数（項目の型・関数・演算子・権限）、欄と層の対応、正規化した JSON の型 | すべて（`@musunest/appspec-schema`） |
| `src/vocabulary.ts` | 語彙の台帳の行の検査 `checkVocabularyLedger` | unit テスト、spec-engine |
| `src/samples.ts` | 採点のシナリオと負例の一覧の形と読み取り | spec-engine・data-api のテスト |
| `src/files.ts` | 下のファイルの場所（Node 側だけ） | `@musunest/appspec-schema/files` |
| `vocabulary.yaml` | 語彙の台帳（`04` §6.2） | unit テスト、工場 |
| `docs/semantics.md` | M1.1 での意味（`04` §1.1） | 実装する人 |
| `samples/<name>/app.spec.yaml` | 見本 | 静的チェック・publish・採点 |
| `samples/<name>/scenario.json` | 採点のシナリオ（入力と期待値） | 計算・data-api のテスト |
| `samples/negatives/<name>.app.spec.yaml` | 負例（1 か所だけわざと間違えた宣言） | 静的チェックのテスト |
| `samples/negatives/index.json` | 負例ごとの、期待する誤りコード | 静的チェックのテスト |

- 見本は今「支出の記録」（`expense-log`）だけである。M1.2 以降、見本が必要とする語彙と一緒に足す
- 次の Issue からは、ファイルを場所の関数で読む（パッケージの中の並びを知らなくてよい）

```ts
import { readFileSync } from "node:fs";
import { negativeIndexFile, sampleScenarioFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import { readNegativeIndex, readScoringScenario } from "@musunest/appspec-schema";

const yamlText = readFileSync(sampleSpecFile("expense-log"), "utf8");
const scenario = readScoringScenario(JSON.parse(readFileSync(sampleScenarioFile("expense-log"), "utf8")));
const negatives = readNegativeIndex(JSON.parse(readFileSync(negativeIndexFile(), "utf8")));
```

## 2. 版の表記（決定。2026-09-16・#96）

- `APPSPEC_SCHEMA_VERSION` は **`community.app-spec/v0.2-draft`** にする（前は M0 の仮置きの `0.0.0-m0`）
- **M1.5 で `community.app-spec/v0.2` に固め、同じコミットで `pins/commandagent.json` の `appspec_schema` を差し替える**（`00-open-questions.md` Q9、`04` §4）。この Issue ではピンを差し替えない

理由

1. 版の名前は、工場側の版の並び（`community.app-spec/v0.1`）に揃える（Q9）。`0.0.0-m0` はピンの表記と比べられなかった
2. 草案は M1.1〜M1.4 のあいだ自由に変える（`04` §4）。`v0.2` とだけ書くと、固める前の形が v0.2 として扱われうる。`-draft` を付けて、固めた版と取り違えないようにする
3. **ピンには固めた版だけを書く。** unit テストが「ピンの版に `-draft` が無いこと」と「固めたあとはピンとこのパッケージの版が一致すること」を確かめる
4. 台帳の `since` も同じ表記にする（`v0.2-draft（M1.1）`。`04` §6.2 の案のとおり）。草案のあいだは、台帳の `factory` をすべて「未対応」にする（工場にはまだ渡さない）

## 3. 層の形（仮決め。2026-09-16・#96。M1.5 で確定する）

**横並びのままにする。** 欄は v0.1 と同じ 7 つで、どの欄がどの層かは `SECTION_LAYER`（`src/spec.ts`）で決める。

| 欄 | 層 |
|---|---|
| `entities` | データ |
| `validations`・`computed`・`actions` | ロジック |
| `views` | UI |
| `permissions`・`minIdentity` | 権限（全層に効く） |

理由

1. **M1.1 の語彙は v0.1 と同じ**で、工場は今 v0.1 の 7 欄しか受け付けない（`02-l2-spec-examples.md` §8）。横並びなら、v0.1 の宣言との差が「欄の中身」だけになり、M1.6 の工場側の差し替えが小さく済む
2. 静的チェックは、欄と層の対応表があれば層ごとに書ける（`03` §4）。入れ子にしても、チェックが得る情報は増えない
3. data-api と画面は正規化した JSON だけを読む（`04` §3）。あとで入れ子に変えても、直すのは静的チェックと変換だけで済む
4. 入れ子の利点（層の境目を形で見せる）が効くのは、1 つの欄に 2 つの層の書き方が混ざるとき（操作の条件 `when`・一覧の絞り込み）である。それが入るのは M1.3 なので、そこで書きにくければ変換だけを直して形を変える（`04` §3.1）

- データ連携層（`integrations`）の欄は M1 では置かない。`LAYERS` に `integration` の席だけを残す（`03` §2.5）

## 4. 語彙の台帳と、語彙の足し方

- 台帳の欄は `04` §6.2 の案のとおり（`name`・`layer`・`since`・`samples`・`negatives`・`check_rules`・`semantics`・`runtime`・`factory`）。**欄が 1 つでも欠けた行があれば unit テストで落ちる**
- unit テストは、台帳とほかのファイルも突き合わせる
  - `name` と `layer` が `VOCABULARY`（`src/spec.ts`）と 1 対 1 に一致する。項目の型・関数・本人確認の種類は、すべて台帳にある
  - `samples` の見本、`negatives` の負例、`semantics` の節、`runtime` のパッケージが実在する
  - `check_rules` が、その行の負例が出す誤りコードの集まりとちょうど一致する
  - 見本と負例に、台帳から参照されないものが無い
- 台帳は 1 行 1 語彙の狭い書き方に限る（`src/ledger-yaml.ts`）。このパッケージは依存を持たないので、YAML のライブラリを使わずに読むためである。その書き方の範囲では、一般の YAML の読み取りと同じ結果になる
- 語彙を 1 つ足すときは、`04` §2 の一周に沿って、見本・採点のシナリオ・`src/spec.ts`（`VOCABULARY` を含む）・台帳・負例・`docs/semantics.md` を**同じ PR で**直す

## 5. 誤りコード（草案）

- 形は `<種類>_<対象>_<問題>`（例 `LOGIC_COMPUTED_CYCLE`）。種類は `03` §5.1 の「確かめること」で、`SHAPE`（形）と層の名前（`DATA`・`LOGIC`・`PERMISSION`・`UI`・`UX`・`INTEGRATION`）を使う（`ERROR_CODE_PATTERN`）
- 台帳の `check_rules` と `samples/negatives/index.json` に書いたコードは、**静的チェック（spec-engine。#97）が実装する期待値**である。体系は #97 で確定する。コードの名前を変えるときは、このパッケージの台帳と負例の一覧も同じ PR で直す

## 6. 正規化した JSON

- publish の時点で、静的チェックを通った宣言を正規化した JSON にして R2 に置く（Q12）。形は `NormalizedAppSpec`（`schemaVersion`・原本の SHA-256・`spec`）
- 型をここに置くのは、画面（host）が `sdk` 経由でしか型を受け取れず、`sdk` は `appspec-schema` にしか依存できないからである（`infra/scripts/dep-graph.mjs`）。M1.1 の草案では、`spec` は宣言そのものである
