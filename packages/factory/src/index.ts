// @musunest/factory —— プロダクト内の工場（宣言だけを作る LLM エージェント）の骨格（Issue #278）。
//
// 設計の正本は workspace/mvp/m1/agent/02-architecture.md。外側（段の順番・記録・打ち切り・合否）は
// コードが決め、内側の「書く・直す」段だけを LLM に任せる。**LLM はまだ呼ばない**（OpenAI の
// adapter とプロンプトは次の Issue）。
//
// 依存の向き：`factory → appspec-schema, spec-engine` だけ（control-plane には依存しない。
// 納品物の型は appspec-schema から取る。§3.1）。infra/scripts/dep-graph.mjs が正本である。

export const PACKAGE_NAME = "@musunest/factory" as const;

export * from "./budget.js";
export * from "./llm.js";
export * from "./llm-fake.js";
export * from "./outcome.js";
export * from "./pipeline.js";
