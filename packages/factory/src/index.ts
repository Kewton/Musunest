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
// Ollama Cloud の Responses API（OpenAI 互換）の adapter（Issue #771。共有の実装の薄い包み）
export * from "./ollama.js";
// OpenRouter（Responses API 互換・提供元を固定）の adapter（Issue #788。共有の実装の薄い包み）
export * from "./openrouter.js";
export * from "./schema-check.js";

// ── 判定の口（Issue #330。Jev の adapter・LLM の adapter・偽物。`judge-jev.ts` が Jev の入口を持つ）──
export * from "./judge.js";
export * from "./judge-jev.js";
export * from "./judge-llm.js";
export * from "./judge-fake.js";

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

// ── Plan の段（plan/。Issue #333。P1〜P6：要件を固める役）─────────────
export * from "./plan/catalog.js";
export * from "./plan/surface.js";
export * from "./plan/questions.js";
export * from "./plan/answers.js";
export * from "./plan/confirm.js";
export * from "./plan/session.js";
// Plan を 1 回流す口（Issue #363。答える役の口を差し込み、確定した仕様まで進める）
export * from "./plan/run-plan.js";

// ── 記録・納品物・回す部分・手元の入口（Issue #288）───────────────
export * from "./record.js";
export * from "./bundle.js";
export * from "./run.js";
export * from "./cli.js";

// ── v1.1α（v11a/。`07-architecture-v1.1a.md`・Issue #505〜#511）─────────────
// 契約（名前の表・v1 の型への写し・id の結び付け・持ち越し・網羅の単位）
export * from "./v11a/names.js";
export * from "./v11a/convert.js";
export * from "./v11a/bind-by-id.js";
export * from "./v11a/carry-over.js";
export * from "./v11a/coverage.js";
// 段（T1・T1''・J4・T2・B1・B3'）
export * from "./v11a/stages/name-table.js";
export * from "./v11a/stages/semantic-check.js";
export * from "./v11a/stages/judge-advice.js";
export * from "./v11a/stages/test-spec.js";
export * from "./v11a/stages/write.js";
export * from "./v11a/stages/decl-check.js";
// 走らせる部分・名前の照合（B3）・評価口・記録
export * from "./v11a/name-check.js";
export * from "./v11a/evaluate.js";
export * from "./v11a/run.js";
export * from "./v11a/bundle-v11a.js";

// ── v1.2（v12/。`08-architecture-v1.2.md`・Issue #547〜）──────────────────
// 性質の台帳と v1.2 の旗の正本（`V12_PIPELINE_FLAGS`。計測の道具が読む契約）
export * from "./v12/ledger.js";
// 探索型の直しの部品（旗 `v12.search-repair`。手 4a・Issue #551）
export * from "./v12/search-repair.js";
// 失敗の場所と欄だけの直し（旗 `v12.search-repair` の直す手。手 4b・Issue #553）
export * from "./v12/locate.js";
export * from "./v12/stages/field-repair.js";
// v1.2 の呼び出しの上限の表（段ごとの論理の枠・実試行の門・判定の枝。旗 `v12.ids`。手 3p・Issue #592）
export * from "./v12/limits.js";
// ID はコードが振る（C1 語彙の 3 束・C2 要件の写像。旗 `v12.ids`。手 3a・Issue #593）
export * from "./v12/ids.js";
export * from "./v12/stages/vocabulary.js";
export * from "./v12/stages/mapping.js";
// コードが作る試験（台帳の型だけで値が決まる試験。旗 `v12.ids`。手 3c・Issue #595）
export * from "./v12/generated-tests.js";
// T2 の場合の形と展開（値の要る試験の場合だけを LLM が書き、骨組みはコードが組む。旗 `v12.ids`。手 3e・Issue #625）
export * from "./v12/test-cases.js";
