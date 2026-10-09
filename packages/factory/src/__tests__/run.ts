// 回す部分（run.ts）・納品物（bundle.ts）・記録（record.ts）・手元の入口（cli.ts）の試験で使う、
// **手で書いた**題材と記録（02 §1・§1.3）。**実 API は呼ばない**——記録した応答を返す偽物（llm-fake.ts）で
// 閉じる。題材は抽象的なものだけを使い、受入の題材の言葉（持ち寄り・当番表…）は使わない。
import type { LlmUsage } from "../llm.js";
import type { RecordedCall } from "../llm-fake.js";
import type { GenerationInput } from "../run.js";
import type { PromptDocument } from "../stages/prompt.js";
import { SAMPLE_DOCUMENTS, SOURCE_TEXT } from "../stages/__tests__/prompt.js";

export { SAMPLE_DOCUMENTS, SOURCE_TEXT };

/** 記録に付ける使用トークン（`usage` が欠けた呼び出しの試験は、これを省いて作る） */
export const USAGE: LlmUsage = {
  inputTokens: 100,
  cachedInputTokens: 0,
  outputTokens: 50,
  reasoningTokens: 0,
};

/** 単価（試験は小さく取る） */
export const RATES = {
  inputPerToken: 0.000001,
  cachedInputPerToken: 0.0000005,
  outputPerToken: 0.000002,
};

/**
 * 抽象的な宣言（7 欄）。要件 R-1 は `total`（`amount * 2`）、R-2 は `extra`（`amount + 1`）の計算で満たし、
 * 一覧が `total` と `extra` を出すので、どちらも画面から辿れる（⑤a の確認を通る）。
 */
export const DECLARATION_SOURCE = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      amount: number",
  "views:",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [total, extra]",
  "actions: []",
  "validations: []",
  "computed:",
  "  - name: total",
  "    entity: record",
  "    expression: amount * 2",
  "    type: number",
  "  - name: extra",
  "    entity: record",
  "    expression: amount + 1",
  "    type: number",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** 静的チェックに通らない宣言（1 か所だけ型を間違える） */
export const INVALID_DECLARATION_SOURCE = DECLARATION_SOURCE.replace("amount: number", "amount: nosuchtype");

/** ① の答え（抽象的な題材。受入の題材の言葉は使わない） */
export const REQUIREMENT_LIST_OUTPUT = {
  requirements: [
    { id: "R-1", text: "記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
    { id: "R-2", text: "合計できる", quote: "件数を合計する", position: { start: 9, end: 16 } },
  ],
  decisions: [],
  unresolved: [],
};

/** ①' の答え（コードの検査を通る。覆われていない部分は無い） */
export const REVERSE_CHECK_OUTPUT = { uncovered: [] };

/** ② の答え（書けない要件は無い） */
export const DESIGN_OUTPUT = {
  designs: [
    { requirementId: "R-1", vocabulary: ["計算"], placement: ["computed"], unwritable: [] },
    { requirementId: "R-2", vocabulary: ["計算"], placement: ["computed"], unwritable: [] },
  ],
};

/** ② の答え（R-2 を書けないと申告する。部分案の道） */
export const DESIGN_OUTPUT_PARTIAL = {
  designs: [
    { requirementId: "R-1", vocabulary: ["計算"], placement: ["computed"], unwritable: [] },
    { requirementId: "R-2", vocabulary: [], placement: [], unwritable: ["補助の値の並べ替えは書けない"] },
  ],
};

/** ②' で固定する試験 1 件（R-1 は `total`、R-2 は `extra` の計算を対象にする） */
function suiteTest(id: string, requirementId: string, kind: "normal" | "abnormal" | "boundary"): unknown {
  const r1 = requirementId === "R-1";
  return {
    id,
    target: { requirementId, kind: "computation", role: r1 ? "合計を出す計算" : "補助の値の計算" },
    kind,
    operation: "compute",
    clock: "2026-09-16T12:00:00+09:00",
    input: { amount: 21 },
    referenceData: [],
    expected: { kind: "ok", value: r1 ? 42 : 22 },
  };
}

/** ②' の答え（R-1・R-2 それぞれに正常・異常・境界がそろう） */
export const TEST_SUITE_OUTPUT = {
  tests: [
    suiteTest("t1", "R-1", "normal"),
    suiteTest("t2", "R-1", "abnormal"),
    suiteTest("t3", "R-1", "boundary"),
    suiteTest("t4", "R-2", "normal"),
    suiteTest("t5", "R-2", "abnormal"),
    suiteTest("t6", "R-2", "boundary"),
  ],
};

/** ⑤a の答え（実在して画面から辿れる場所だけを挙げる） */
export const CORRESPONDENCE_OUTPUT = {
  entries: [
    { requirementId: "R-1", locations: [{ kind: "computation", entity: "record", name: "total" }] },
    { requirementId: "R-2", locations: [{ kind: "computation", entity: "record", name: "extra" }] },
  ],
};

/** 記録した構造化出力の 1 回 */
export function structured(output: unknown, usage: LlmUsage | undefined = USAGE): RecordedCall {
  return { kind: "structured", output, usage };
}

/** 完走する道の記録（①→①'→②→②'→③→⑤a の順。⑥ は要らない） */
export function recordedRun(options: { readonly write?: string; readonly design?: unknown } = {}): readonly RecordedCall[] {
  return [
    structured(REQUIREMENT_LIST_OUTPUT),
    structured(REVERSE_CHECK_OUTPUT),
    structured(options.design ?? DESIGN_OUTPUT),
    structured(TEST_SUITE_OUTPUT),
    structured({ declaration: options.write ?? DECLARATION_SOURCE }),
    structured(CORRESPONDENCE_OUTPUT),
  ];
}

/** 回す部分の入力（試験は時計を 0 に固定し、予算は十分に取る） */
export function makeRunInput(
  client: GenerationInput["client"],
  overrides: Partial<GenerationInput> = {},
): GenerationInput {
  return {
    source: SOURCE_TEXT,
    documents: SAMPLE_DOCUMENTS,
    client,
    budgetUsd: 10,
    rates: RATES,
    now: () => 0,
    deadline: 60_000,
    runId: "run-test",
    storageUnit: "test-unit",
    builder: "musunest-factory",
    model: "gpt-test",
    effort: "high",
    promptVersion: "v1",
    contractVersion: "v0.2",
    specEngineVersion: "0.0.0",
    factoryVersion: "0.0.0",
    ...overrides,
  };
}

/** 文書の例（呼ぶ側から渡す。このパッケージはファイルを読まない） */
export const DOCUMENTS: readonly PromptDocument[] = SAMPLE_DOCUMENTS;
