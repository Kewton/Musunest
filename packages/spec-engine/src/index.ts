// @musunest/spec-engine —— アプリの宣言（app.spec.yaml）の**静的チェック**と、その入口である。
//
// このパッケージは M1.1 では次を持つ（workspace/mvp/m1/03-spec-layers-and-checker.md §5・
// workspace/mvp/m1/README.md §10.2 の順 2）。
//   1. 宣言を実行せずに検査する（形・データ層・ロジック層・UI・権限。src/check.ts）
//   2. 誤りを 3 つ組で返す（誤りコード・日本語の説明・原文の位置。src/diagnostics.ts）
//   3. 式を AST に解析して、上限つきで型を見る（src/expression.ts・src/limits.ts）
//   4. 手元と CI から呼ぶ薄い入口（src/cli.ts・`spec:check`）
//   5. 検査を通った宣言を、正規化した JSON にする（src/normalize.ts。Q12）
//   6. 同じ entity の中の計算と検査を、差し込んだ時計の上で評価する（src/evaluate.ts・src/clock.ts）
//
// **検査（1〜3）は式を実行しない。** 評価（5・6）は、検査が使ったのと同じ AST・演算子・関数定義・
// 上限定数を読む（判定が 2 か所に分かれると、検査は通るのに店頭で動かない。03 §5.3）。
// 評価の入口は**検査済みの宣言（正規化した JSON）だけ**を受け取り、未検査の YAML は渡せない。
//
// 依存の向き：`spec-engine → appspec-schema` だけ（infra/scripts/dep-graph.mjs）。

export const PACKAGE_NAME = "@musunest/spec-engine" as const;

export * from "./check.js";
export * from "./clock.js";
export * from "./diagnostics.js";
export * from "./evaluate.js";
export * from "./expression.js";
export * from "./limits.js";
export * from "./normalize.js";

// 式の検査と評価が同じ定義を使えるように、宣言の語彙（演算子・関数・欄）も、ここから読める形にする
export {
  APPSPEC_SCHEMA_VERSION,
  ARITHMETIC_OPERATORS,
  BUILTIN_FUNCTIONS,
  COMPARISON_OPERATORS,
  FIELD_TYPES,
  NAME_PATTERN,
  SECTION_LAYER,
} from "@musunest/appspec-schema";
export type {
  AppSpec,
  BuiltinFunctionName,
  Entity,
  ExpressionType,
  FieldType,
  NormalizedAppSpec,
} from "@musunest/appspec-schema";
