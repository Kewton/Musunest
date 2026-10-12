// 回す部分（run.ts）・納品物（bundle.ts）・記録（record.ts）・手元の入口（cli.ts）の試験で使う、
// **手で書いた**題材と記録（02 §1・§1.3）。**実 API は呼ばない**——記録した応答を返す偽物（llm-fake.ts）で
// 閉じる。題材は抽象的なものだけを使い、受入の題材の言葉（持ち寄り・当番表…）は使わない。
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
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
  framing: [],
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

/**
 * ②' の答え（R-1 の正常の試験だけ、項目（field）を対象にする）。⑤b でこの試験は**未解決**になる
 * （入力の型は評価器で確かめられない）。ほかは計算の試験で一致するので、不一致は 0 のままである（#306）。
 */
export const TEST_SUITE_OUTPUT_WITH_UNRESOLVED = {
  tests: [
    {
      id: "t1",
      target: { requirementId: "R-1", kind: "field", role: "金額の項目" },
      kind: "normal",
      operation: "compute",
      clock: "2026-09-16T12:00:00+09:00",
      input: {},
      referenceData: [],
      expected: { kind: "ok", value: 1 },
    },
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

/**
 * ⑤a の答え（R-1 に、項目（field）の場所も挙げる）。`TEST_SUITE_OUTPUT_WITH_UNRESOLVED` の項目の試験を
 * 結び付けられるようにする。どの場所も実在し画面から辿れるので、対応表の落ちは 0 である（#306）。
 */
export const CORRESPONDENCE_OUTPUT_WITH_FIELD = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "computation", entity: "record", name: "total" },
        { kind: "field", entity: "record", name: "amount" },
      ],
    },
    { requirementId: "R-2", locations: [{ kind: "computation", entity: "record", name: "extra" }] },
  ],
};

/** 記録した構造化出力の 1 回 */
export function structured(output: unknown, usage: LlmUsage | undefined = USAGE): RecordedCall {
  return { kind: "structured", output, usage };
}

/**
 * 完走する道の記録（①→①'→②→②'→③→⑤a の順。⑥ は要らない）。
 *
 * **既定は新契約の fixture**（役割 ID の表・選択肢・所属を持つ設計。Issue #418）。旧形式の設計を渡す
 * 例は、`makeRunInput` の `designVersion` に `"legacy"` を明示する。`mappings` を省くと、新契約の既定の
 * 対応（`MAPPINGS_PLANNED`）を使う。
 */
export function recordedRun(
  options: {
    readonly write?: string;
    readonly design?: unknown;
    readonly suite?: unknown;
    readonly correspondence?: unknown;
    readonly mappings?: unknown;
  } = {},
): readonly RecordedCall[] {
  return [
    structured(REQUIREMENT_LIST_OUTPUT),
    structured(REVERSE_CHECK_OUTPUT),
    structured(options.design ?? DESIGN_OUTPUT_MAPPED),
    structured(options.suite ?? TEST_SUITE_OUTPUT_MAPPED),
    structured({ declaration: options.write ?? DECLARATION_SOURCE, mappings: options.mappings ?? MAPPINGS_PLANNED }),
    structured(options.correspondence ?? CORRESPONDENCE_OUTPUT_PLANNED),
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

// ── Issue #309：版の整合・停滞・③ のやり直し の試験で使う題材 ─────────────────

/** 宣言（③ が書く）。R-1 は `total`（`amount * 2`）、R-2 は `extra`（`amount + 1`）の計算 */
export const DECLARATION_SOURCE_MISMATCH = DECLARATION_SOURCE.replace("expression: amount * 2", "expression: amount * 3");

/**
 * ② の答え（役割 ID の表・選択肢・所属を持つ新形式。Issue #309・#418）。③ が提出した対応の点検（⑤a）と、
 * 対応の表の不備（③ のやり直し）、②' の対象の所属の点検に使う。
 *
 * `record`（entity）は R-1（`record.total`）と R-2（`record.extra`）の両方が使うので `shared` を真にする。
 * 各計算は entity `record` を参照するので、R-1・R-2 は `record` にも依存として所属する。
 */
export const DESIGN_OUTPUT_MAPPED = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "記録", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "合計", shared: false, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.extra", kind: "computation", entity: "record", name: "補助", shared: false, aliasOf: null, options: null, groupBy: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
        { roleId: "record.extra", basis: "stated", reason: null },
      ],
    },
  ],
};

/**
 * ② の答え（新契約。R-2 を書けないと申告する。部分案の道。Issue #418）。所属と `options` を持ち、
 * 申告は「部分・制約 ID・理由」の組（`SAMPLE_DOCUMENTS` の `### computed` を根拠にする）。
 */
export const DESIGN_OUTPUT_PLANNED_PARTIAL = {
  roles: DESIGN_OUTPUT_MAPPED.roles,
  designs: [
    DESIGN_OUTPUT_MAPPED.designs[0],
    {
      ...DESIGN_OUTPUT_MAPPED.designs[1],
      unwritable: [{ part: "補助の値の並べ替えは書けない", constraintIds: ["computed"], reason: "文書に欄が無い" }],
      notes: [],
    },
  ],
};

/** 役割 ID で対象を指す試験 1 件（新形式。Issue #309） */
function roleSuiteTest(id: string, requirementId: string, roleId: string, kind: "normal" | "abnormal" | "boundary"): unknown {
  const r1 = requirementId === "R-1";
  return {
    id,
    target: { requirementId, kind: "computation", roleId },
    kind,
    operation: "compute",
    clock: "2026-09-16T12:00:00+09:00",
    input: { amount: 21 },
    inputContract: { rowId: `${id}-row`, targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: r1 ? 42 : 22 },
  };
}

/** ②' の答え（役割 ID で指す新形式。R-1・R-2 に正常・異常・境界がそろう） */
export const TEST_SUITE_OUTPUT_MAPPED = {
  tests: [
    roleSuiteTest("t1", "R-1", "record.total", "normal"),
    roleSuiteTest("t2", "R-1", "record.total", "abnormal"),
    roleSuiteTest("t3", "R-1", "record.total", "boundary"),
    roleSuiteTest("t4", "R-2", "record.extra", "normal"),
    roleSuiteTest("t5", "R-2", "record.extra", "abnormal"),
    roleSuiteTest("t6", "R-2", "record.extra", "boundary"),
  ],
};

/** ③ の提出する対応（新契約の既定。役割 ID → 宣言に実在する名前。Issue #418） */
export const MAPPINGS_PLANNED = [
  { roleId: "record", name: "record" },
  { roleId: "record.total", name: "total" },
  { roleId: "record.extra", name: "extra" },
] as const;

/**
 * ⑤a の答え（新契約の既定。entity `record` と、計算 `total`・`extra` の場所を挙げる。Issue #418）。
 * ③ の提出した対応（`MAPPINGS_PLANNED`）の各名前が対応表の内側にあるので、③ のやり直しに入らない。
 */
export const CORRESPONDENCE_OUTPUT_PLANNED = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
    {
      requirementId: "R-2",
      // R-2 は `record`（entity）にも依存として所属するので、要件ごとの点検に合わせて**両方の要件に**
      // 載せる（共有する役割は両方の要件に載せる。Issue #431）
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "extra" },
      ],
    },
  ],
};

/** ③ が提出する対応（`record.total` を、宣言に無い名前 `nonexistent` に結び付ける。対応の表の不備） */
export const BAD_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.total", name: "nonexistent" },
  { roleId: "record.extra", name: "extra" },
] as const;

/** ③ のやり直しの答え（同じ不備を出し直す。上限で止まることを試すのに使う） */
export const MAPPING_REDO_OUTPUT = { mappings: BAD_MAPPINGS };

// ── Issue #326：書けなかった要件の一覧（要件 R-1 と R-4 が書けない設計）────────────

/** 4 つの文の原文（R-1〜R-4 が 1 文ずつ覆う。抽象的な題材） */
export const SOURCE_TEXT_FOUR = "タスクを記録する。件数を合計する。補助を出す。印を出す。";

/** ① の答え（R-1〜R-4。引用と位置は原文に一致する。`framing` は必須の欄なので空の配列を置く。Issue #372） */
export const REQUIREMENT_LIST_OUTPUT_FOUR = {
  requirements: [
    { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する。", position: { start: 0, end: 9 } },
    { id: "R-2", text: "件数を合計できる", quote: "件数を合計する。", position: { start: 9, end: 17 } },
    { id: "R-3", text: "補助を出せる", quote: "補助を出す。", position: { start: 17, end: 23 } },
    { id: "R-4", text: "印を出せる", quote: "印を出す。", position: { start: 23, end: 28 } },
  ],
  framing: [],
  decisions: [],
  unresolved: [],
};

/** ② の答え（R-1 と R-4 を書けないと申告する。部分案の道） */
export const DESIGN_OUTPUT_PARTIAL_FOUR = {
  designs: [
    { requirementId: "R-1", vocabulary: ["計算"], placement: ["computed"], unwritable: ["記録の並べ替えは書けない"] },
    { requirementId: "R-2", vocabulary: ["計算"], placement: ["computed"], unwritable: [] },
    { requirementId: "R-3", vocabulary: ["計算"], placement: ["computed"], unwritable: [] },
    { requirementId: "R-4", vocabulary: ["計算"], placement: ["computed"], unwritable: ["印の色分けは書けない"] },
  ],
};

/** ③ が書く宣言（R-1〜R-4 の計算 4 つを、一覧の `show` で出す） */
export const DECLARATION_SOURCE_FOUR = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      amount: number",
  "views:",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [total, extra, sub, mark]",
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
  "  - name: sub",
  "    entity: record",
  "    expression: amount - 1",
  "    type: number",
  "  - name: mark",
  "    entity: record",
  "    expression: amount * 3",
  "    type: number",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** ②' で固定する試験 1 件（要件ごとの計算 1 つを対象にする） */
function suiteTestFour(
  id: string,
  requirementId: string,
  role: string,
  value: number,
  kind: "normal" | "abnormal" | "boundary",
): unknown {
  return {
    id,
    target: { requirementId, kind: "computation", role },
    kind,
    operation: "compute",
    clock: "2026-09-16T12:00:00+09:00",
    input: { amount: 21 },
    referenceData: [],
    expected: { kind: "ok", value },
  };
}

/** ②' の答え（R-1〜R-4 に正常・異常・境界がそろう） */
export const TEST_SUITE_OUTPUT_FOUR = {
  tests: [
    suiteTestFour("t1", "R-1", "合計を出す計算", 42, "normal"),
    suiteTestFour("t2", "R-1", "合計を出す計算", 42, "abnormal"),
    suiteTestFour("t3", "R-1", "合計を出す計算", 42, "boundary"),
    suiteTestFour("t4", "R-2", "補助の値の計算", 22, "normal"),
    suiteTestFour("t5", "R-2", "補助の値の計算", 22, "abnormal"),
    suiteTestFour("t6", "R-2", "補助の値の計算", 22, "boundary"),
    suiteTestFour("t7", "R-3", "差を出す計算", 20, "normal"),
    suiteTestFour("t8", "R-3", "差を出す計算", 20, "abnormal"),
    suiteTestFour("t9", "R-3", "差を出す計算", 20, "boundary"),
    suiteTestFour("t10", "R-4", "印の計算", 63, "normal"),
    suiteTestFour("t11", "R-4", "印の計算", 63, "abnormal"),
    suiteTestFour("t12", "R-4", "印の計算", 63, "boundary"),
  ],
};

/** ⑤a の答え（R-1〜R-4 の計算の場所。すべて実在し画面から辿れる） */
export const CORRESPONDENCE_OUTPUT_FOUR = {
  entries: [
    { requirementId: "R-1", locations: [{ kind: "computation", entity: "record", name: "total" }] },
    { requirementId: "R-2", locations: [{ kind: "computation", entity: "record", name: "extra" }] },
    { requirementId: "R-3", locations: [{ kind: "computation", entity: "record", name: "sub" }] },
    { requirementId: "R-4", locations: [{ kind: "computation", entity: "record", name: "mark" }] },
  ],
};

/**
 * 書けなかった設計（R-1 と R-4 が `unwritable`）を流す記録（①→①'→②→②'→③→⑤a）。
 * `SOURCE_TEXT_FOUR` を原文にして流す（`makeRunInput` の `source` を差し替える）。
 */
export function recordedRunFour(): readonly RecordedCall[] {
  return [
    structured(REQUIREMENT_LIST_OUTPUT_FOUR),
    structured(REVERSE_CHECK_OUTPUT),
    structured(DESIGN_OUTPUT_PARTIAL_FOUR),
    structured(TEST_SUITE_OUTPUT_FOUR),
    structured({ declaration: DECLARATION_SOURCE_FOUR }),
    structured(CORRESPONDENCE_OUTPUT_FOUR),
  ];
}

// ── 確定した仕様（plan.json。§5・Issue #334）───────────────────────────

/** R-1（記録）・R-2（合計）を持つ、確定した仕様（Plan の契約 `ConfirmedPlan`） */
export const CONFIRMED_PLAN: ConfirmedPlan = {
  schema_version: PLAN_SPEC_SCHEMA_VERSION,
  plan_id: "plan-test",
  revision: 1,
  vocabulary_version: "v1",
  inputs: [{ id: "in-1", kind: "source", text: SOURCE_TEXT }],
  requirements: [
    {
      id: "R-1",
      text: "記録できる",
      kind: "existence",
      origin: { input_id: "in-1", quote: "タスクを記録する" },
      parts: [{ id: "R-1-p1", text: "記録", disposition: "met" }],
    },
    {
      id: "R-2",
      text: "合計できる",
      kind: "constraining",
      origin: { input_id: "in-1", quote: "件数を合計する" },
      parts: [{ id: "R-2-p1", text: "合計", disposition: "met" }],
    },
  ],
  open_issues: [],
  decisions: [],
  accepted_unwritable: [],
  confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
};

/**
 * R-2 の「補助の値の並べ替えは書けない」を**了承して除いた**確定した仕様（`accepted_unwritable`）。
 * `DESIGN_OUTPUT_PARTIAL` の申告（同じ文）と突き合うと、了承済みなので合格（full）になる（§5・Issue #334）。
 */
export const CONFIRMED_PLAN_ACCEPTED: ConfirmedPlan = {
  schema_version: PLAN_SPEC_SCHEMA_VERSION,
  plan_id: "plan-test-accepted",
  revision: 1,
  vocabulary_version: "v1",
  inputs: [{ id: "in-1", kind: "source", text: SOURCE_TEXT }],
  requirements: [
    {
      id: "R-1",
      text: "記録できる",
      kind: "existence",
      origin: { input_id: "in-1", quote: "タスクを記録する" },
      parts: [{ id: "R-1-p1", text: "記録", disposition: "met" }],
    },
    {
      id: "R-2",
      text: "合計できる",
      kind: "constraining",
      origin: { input_id: "in-1", quote: "件数を合計する" },
      parts: [{ id: "R-2-p1", text: "補助の値の並べ替えは書けない", disposition: "accepted_removal" }],
    },
  ],
  open_issues: [],
  decisions: [],
  accepted_unwritable: [
    {
      part_id: "R-2-p1",
      alternative_id: "R-1",
      basis: { doc_version: "v1", location: "contract", constraint_id: "R-1" },
    },
  ],
  confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
};

/**
 * 確定した仕様を渡した道の記録（②→②'→③→⑤a）。**①・①' は無い**（`run.ts` が確定した仕様から
 * 要件の一覧を作るので、①・①' を呼ばない。§5・Issue #334）。
 */
export function recordedRunFromPlan(options: { readonly design?: unknown } = {}): readonly RecordedCall[] {
  return [
    structured(options.design ?? DESIGN_OUTPUT_MAPPED),
    structured(TEST_SUITE_OUTPUT_MAPPED),
    structured({ declaration: DECLARATION_SOURCE, mappings: MAPPINGS_PLANNED }),
    structured(CORRESPONDENCE_OUTPUT_PLANNED),
  ];
}

// ── 答えから増えた要件の文に問いの文脈を添える（§5・Issue #391）────────────────

/** 答えから増えた要件（R-2）の問い（`inputs` の question）の ID と文 */
export const ADDED_QUESTION_ID = "q-added";
export const ADDED_QUESTION_TEXT = "合計をどんなときに出すか";
/** その問いが対応する未解決の事項（`open_issues`）の ID と文 */
export const ADDED_OPEN_ISSUE_ID = "o-added";
export const ADDED_OPEN_ISSUE_TEXT = "合計を出す条件が未決である";
/** その答え（`inputs` の answer）の ID（選択肢で答えたもの） */
export const ADDED_ANSWER_ID = "a-added";

/**
 * R-2 が**答えから増えた**要件（`change.kind` が `added`）である、確定した仕様（§5・Issue #391）。
 * R-1 は原文から来た要件（`change` が無い）で、文脈は添えない。要件の一覧の R-2 の文には、問い
 * （`ADDED_QUESTION_ID`）と未解決の事項（`ADDED_OPEN_ISSUE_ID`）の文が参考として添えられる。
 */
export const CONFIRMED_PLAN_ADDED: ConfirmedPlan = {
  schema_version: PLAN_SPEC_SCHEMA_VERSION,
  plan_id: "plan-test-added",
  revision: 1,
  vocabulary_version: "v1",
  inputs: [
    { id: "in-1", kind: "source", text: SOURCE_TEXT },
    {
      id: ADDED_QUESTION_ID,
      kind: "question",
      open_issue_id: ADDED_OPEN_ISSUE_ID,
      text: ADDED_QUESTION_TEXT,
      choices: [
        { id: "c-added-1", text: "いつでも出す" },
        { id: "c-added-2", text: "締めのときだけ出す" },
      ],
      recommended: { choice_id: "c-added-1", reason: "素直な解釈である" },
    },
    {
      id: ADDED_ANSWER_ID,
      kind: "answer",
      question_id: ADDED_QUESTION_ID,
      choice_id: "c-added-1",
    },
  ],
  requirements: [
    {
      id: "R-1",
      text: "記録できる",
      kind: "existence",
      origin: { input_id: "in-1", quote: "タスクを記録する" },
      parts: [{ id: "R-1-p1", text: "記録", disposition: "met" }],
    },
    {
      id: "R-2",
      text: "合計できる",
      kind: "constraining",
      origin: { input_id: "in-1", quote: "件数を合計する" },
      change: { kind: "added", answer_id: ADDED_ANSWER_ID },
      parts: [{ id: "R-2-p1", text: "合計", disposition: "met" }],
    },
  ],
  open_issues: [
    {
      id: ADDED_OPEN_ISSUE_ID,
      text: ADDED_OPEN_ISSUE_TEXT,
      critical: false,
      status: "resolved",
      resolution: { answer_id: ADDED_ANSWER_ID },
    },
  ],
  decisions: [],
  accepted_unwritable: [],
  confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
};

// ── 見出しごとの集計を持つ新契約の fixture（Issue #433）──────────────────────
//
// 選択肢の項目 `record.status`（enum）と、それを元に分ける見出しごとの集計 `record.byStatus` を持つ。
// ③ の宣言の選択肢のキー列・②' の見出しの期待・⑤a の集計元の組を、1 組で通しで確かめられる。

/** 選択肢の項目と、見出しごとの集計を持つ宣言（`status` は enum、`byStatus` は groups の計算） */
export const GROUPED_DECLARATION_SOURCE = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      amount: number",
  "      status:",
  "        type: enum",
  "        options:",
  "          open: 未了",
  "          closed: 完了",
  "views:",
  "  - name: dashboard",
  "    type: dashboard",
  "    widgets:",
  "      - type: bar",
  "        value: byStatus",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [status, amount, total, extra]",
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
  "  - name: byStatus",
  "    aggregate:",
  "      count: record",
  "      groupBy: record.status",
  "    type: groups",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** 宣言の選択肢のキーの並びを逆にした宣言（③ の宣言が表の順を守らない例。Issue #433） */
export const GROUPED_DECLARATION_REVERSED = GROUPED_DECLARATION_SOURCE.replace(
  "          open: 未了\n          closed: 完了",
  "          closed: 完了\n          open: 未了",
);

/** 見出しごとの集計を持つ新契約の設計（`record.byStatus` の `groupBy` は `record.status`） */
export const GROUPED_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "記録", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.status", kind: "field", entity: "record", name: "状態", shared: false, aliasOf: null, options: ["open", "closed"], groupBy: null },
    { roleId: "record.amount", kind: "field", entity: "record", name: "金額", shared: false, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "合計", shared: false, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.byStatus", kind: "computation", entity: null, name: "状態別", shared: false, aliasOf: null, options: null, groupBy: "record.status" },
    { roleId: "record.extra", kind: "computation", entity: "record", name: "補助", shared: false, aliasOf: null, options: null, groupBy: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
        { roleId: "record.status", basis: "stated", reason: null },
        { roleId: "record.amount", basis: "dependency", reason: "入力の行に保存する項目として参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
        { roleId: "record.byStatus", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
        { roleId: "record.extra", basis: "stated", reason: null },
      ],
    },
  ],
};

/** ③ の提出する対応（見出しごとの集計の fixture） */
export const GROUPED_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.status", name: "status" },
  { roleId: "record.amount", name: "amount" },
  { roleId: "record.total", name: "total" },
  { roleId: "record.byStatus", name: "byStatus" },
  { roleId: "record.extra", name: "extra" },
] as const;

/** 見出しごとの集計の fixture で使う、計算を対象にした試験 1 件 */
function groupedComputeTest(
  id: string,
  requirementId: string,
  roleId: string,
  kind: "normal" | "abnormal" | "boundary",
): Record<string, unknown> {
  return {
    id,
    target: { requirementId, kind: "computation", roleId },
    kind,
    operation: "compute",
    clock: "2026-09-16T12:00:00+09:00",
    input: { "record.amount": 21 },
    inputContract: { rowId: `${id}-row`, targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: requirementId === "R-1" ? 42 : 22 },
  };
}

/** ②' の答え（見出しごとの集計の期待を含む。見出しは options の順） */
export const GROUPED_TEST_SUITE_OUTPUT = {
  tests: [
    groupedComputeTest("t1", "R-1", "record.total", "normal"),
    groupedComputeTest("t2", "R-1", "record.total", "abnormal"),
    groupedComputeTest("t3", "R-1", "record.total", "boundary"),
    {
      id: "t4",
      target: { requirementId: "R-1", kind: "computation", roleId: "record.byStatus" },
      kind: "normal",
      operation: "aggregate",
      clock: "2026-09-16T12:00:00+09:00",
      input: {},
      inputContract: { rowId: "t4-row", targetRowId: null, emptyEntities: [] },
      referenceData: [
        {
          rowId: "row-2",
          target: { requirementId: "R-1", kind: "entity", roleId: "record" },
          values: { "record.status": "open" },
        },
      ],
      expected: { kind: "ok", value: [{ heading: "open", value: 1 }, { heading: "closed", value: 0 }] },
    },
    groupedComputeTest("t5", "R-2", "record.extra", "normal"),
    groupedComputeTest("t6", "R-2", "record.extra", "abnormal"),
    groupedComputeTest("t7", "R-2", "record.extra", "boundary"),
  ],
};

/** ⑤a の答え（見出しごとの集計の fixture。要件ごとの所属の場所をすべて挙げる） */
export const GROUPED_CORRESPONDENCE_OUTPUT = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "field", entity: "record", name: "status" },
        { kind: "field", entity: "record", name: "amount" },
        { kind: "computation", entity: "record", name: "total" },
        { kind: "computation", entity: null, name: "byStatus" },
      ],
    },
    {
      requirementId: "R-2",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "extra" },
      ],
    },
  ],
};

/** 見出しごとの集計の fixture の走り（①→①'→②→②'→③→⑤a） */
export function recordedRunGrouped(options: {
  readonly suite?: unknown;
  readonly declaration?: string;
} = {}): readonly RecordedCall[] {
  return [
    structured(REQUIREMENT_LIST_OUTPUT),
    structured(REVERSE_CHECK_OUTPUT),
    structured(GROUPED_DESIGN),
    structured(options.suite ?? GROUPED_TEST_SUITE_OUTPUT),
    structured({ declaration: options.declaration ?? GROUPED_DECLARATION_SOURCE, mappings: GROUPED_MAPPINGS }),
    structured(GROUPED_CORRESPONDENCE_OUTPUT),
  ];
}

// ── 完了条件の負例：② の設計の意味の誤り 3 種（Issue #433・review 2）───────────────
//
// いずれも、確定した仕様（正本）から**独立に固定した** ②' の試験（見出しの期待）を先に置き、② の設計と
// ③ の宣言が**同じ誤りを共有**して、列の相互照合（⑤a のコード）は一致する形にする。それでも、独立の
// 点検が残した落ちが消えないので full にならない、ということを確かめるための材料である。

/** 選択肢の意味の欠落：`status` の選択肢から `closed` を落とした設計と宣言 */
export const GROUPED_DESIGN_MISSING_OPTION = {
  ...GROUPED_DESIGN,
  roles: GROUPED_DESIGN.roles.map((role) =>
    role.roleId === "record.status" ? { ...role, options: ["open"] } : role,
  ),
};

export const GROUPED_DECLARATION_MISSING_OPTION = GROUPED_DECLARATION_SOURCE.replace(
  "          open: 未了\n          closed: 完了",
  "          open: 未了",
);

/** ラベルとキーの対応の逆転：`status` の選択肢の順とラベルを入れ替えた設計と宣言 */
export const GROUPED_DESIGN_REVERSED_OPTION = {
  ...GROUPED_DESIGN,
  roles: GROUPED_DESIGN.roles.map((role) =>
    role.roleId === "record.status" ? { ...role, options: ["closed", "open"] } : role,
  ),
};

export const GROUPED_DECLARATION_REVERSED_OPTION = GROUPED_DECLARATION_SOURCE.replace(
  "          open: 未了\n          closed: 完了",
  "          closed: 未了\n          open: 完了",
);

/** 集計対象の誤り：`byStatus` が `status` ではなく `kind`（同じ選択肢の項目）で分ける設計と宣言 */
export const GROUPED_DESIGN_WRONG_TARGET = {
  roles: [
    ...GROUPED_DESIGN.roles,
    { roleId: "record.kind", kind: "field", entity: "record", name: "種別", shared: false, aliasOf: null, options: ["open", "closed"], groupBy: null },
  ].map((role) => (role.roleId === "record.byStatus" ? { ...role, groupBy: "record.kind" } : role)),
  designs: GROUPED_DESIGN.designs.map((entry) =>
    entry.requirementId === "R-1"
      ? {
          ...entry,
          ownership: [
            ...entry.ownership,
            { roleId: "record.kind", basis: "dependency", reason: "分ける元の項目として参照するため" },
          ],
        }
      : entry,
  ),
};

export const GROUPED_MAPPINGS_WRONG_TARGET = [
  ...GROUPED_MAPPINGS,
  { roleId: "record.kind", name: "kind" },
] as const;

export const GROUPED_CORRESPONDENCE_OUTPUT_WRONG_TARGET = {
  entries: GROUPED_CORRESPONDENCE_OUTPUT.entries.map((entry) =>
    entry.requirementId === "R-1"
      ? { ...entry, locations: [...entry.locations, { kind: "field", entity: "record", name: "kind" }] }
      : entry,
  ),
};

export const GROUPED_DECLARATION_WRONG_TARGET = GROUPED_DECLARATION_SOURCE.replace(
  "      amount: number\n      status:",
  "      amount: number\n      kind:\n        type: enum\n        options:\n          open: 未了\n          closed: 完了\n      status:",
)
  .replace("    show: [status, amount, total, extra]", "    show: [status, kind, amount, total, extra]")
  .replace("      groupBy: record.status", "      groupBy: record.kind");

/**
 * 確定した仕様（正本）を渡した、見出しごとの集計の fixture の走り（**①・①' は無い**。§5・Issue #334）。
 * ②→②'→③→⑤a の 4 回（②' の作り直しの回だけ `suites` を増やす）。
 */
export function recordedRunGroupedFromPlan(options: {
  readonly design?: unknown;
  readonly suites?: readonly unknown[];
  readonly declaration?: string;
  readonly mappings?: unknown;
  readonly correspondence?: unknown;
} = {}): readonly RecordedCall[] {
  const suites = options.suites ?? [GROUPED_TEST_SUITE_OUTPUT];
  return [
    structured(options.design ?? GROUPED_DESIGN),
    ...suites.map((suite) => structured(suite)),
    structured({
      declaration: options.declaration ?? GROUPED_DECLARATION_SOURCE,
      mappings: options.mappings ?? GROUPED_MAPPINGS,
    }),
    structured(options.correspondence ?? GROUPED_CORRESPONDENCE_OUTPUT),
  ];
}
