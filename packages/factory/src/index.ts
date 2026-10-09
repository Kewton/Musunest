// @musunest/factory —— プロダクト内の工場（宣言だけを作る LLM エージェント）（Issue #278 の骨格に、段・
// 回す部分・adapter・納品物を足したもの）。
//
// 設計の正本は workspace/mvp/m1/agent/02-architecture.md。外側（段の順番・記録・打ち切り・合否）は
// コードが決め、内側の「書く・直す」段だけを LLM に任せる。**ここ（公開する面）から、段・回す部分
// （run.ts）・adapter（openai.ts）・納品物（bundle.ts）・手元の入口（cli.ts）が読める。**
//
// 依存の向き：`factory → appspec-schema, spec-engine` だけ（control-plane には依存しない。
// 納品物の型は appspec-schema から取る。§3.1）。infra/scripts/dep-graph.mjs が正本である。

export const PACKAGE_NAME = "@musunest/factory" as const;

// ── 骨格（Issue #278）─────────────────────────────────────────────
export * from "./budget.js";
export * from "./llm.js";
export * from "./llm-fake.js";
export * from "./outcome.js";
export * from "./pipeline.js";

// ── 共通の口・上限（Issue #282）───────────────────────────────────
export * from "./call.js";
export * from "./limits.js";

// ── adapter（Issue #284。`fetch` だけを使う。`openai.ts` は外部の入口を持つ唯一の library の file）──
export * from "./openai.js";

// ── 段（stages/。Issue #285・#287・#292・#293・#294）──────────────
export * from "./stages/arbitrate.js";
export * from "./stages/bind.js";
export * from "./stages/correspondence.js";
export * from "./stages/design.js";
export * from "./stages/prompt.js";
export * from "./stages/repair.js";
export * from "./stages/requirements.js";
export * from "./stages/reverse-check.js";
export * from "./stages/run-tests.js";
export * from "./stages/static-check.js";
export * from "./stages/test-suite.js";
export * from "./stages/tools.js";
export * from "./stages/write.js";

// ── 記録・納品物・回す部分・手元の入口（Issue #288）───────────────
export * from "./record.js";
export * from "./bundle.js";
export * from "./run.js";
export * from "./cli.js";
