// T2 試験の仕様（v11a/stages/test-spec.ts）の unit テスト（07-architecture-v1.1a.md §1.1・§1.2・§1.3・§2.3。Issue #508）。
//
// 偽物の LLM（記録した応答）・偽物の判定・固定の時計（共通の口の時計は 0）で閉じる。外部の API は呼ばない。
// 題材は v1.1α の共通の題材（`__tests__/fixtures.ts`。担当者と項目の抽象的な題材）を使う。
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import {
  STRUCTURAL_ASSERTIONS,
  TEST_OPERATIONS,
  TEST_TARGET_KINDS,
  type FixedTest,
  type StructuralAssertionKind,
  type TestSuite,
} from "../../fixed-test.js";
import { createFakeJudge } from "../../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest } from "../../judge.js";
import type { LlmStructuredRequest } from "../../llm.js";
import type { RequirementList } from "../../pipeline.js";
import { ruleDefinitionDefects, ruleTexts, type Problem, type RejectedCandidate } from "../../stages/prompt.js";
import {
  NATURE_JUDGE_THRESHOLD,
  TEST_SUITE_RULE_DEFINITIONS,
  checkSuitePlan,
  reconcileNatures,
  runTestSuite,
  natureQuestionName,
} from "../../stages/test-suite.js";
import { createRecordingClient, expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import {
  createCheckedRecordingClient,
  negative,
  NegativeOutput,
  casesResponseOf,
  withoutIdAndClock,
  recordedStructured,
  EMPTY_AGGREGATE_REQUEST_DIFF,
  ENUM_MEMBERSHIP_REQUEST_DIFF,
  FIXTURE_DOCUMENTS,
  LEDGER_VIEW_2A,
  LEDGER_VIEW_2B,
  LEDGER_VIEW_2C,
  NON_REQUIREMENT_TEXT,
  WHEN_NON_REQUIREMENT_REQUEST_DIFF,
  fixtureNonRequirementList,
  fixtureNonRequirementTable,
  withoutWhenAndNonRequirement,
  withAggregates,
  withoutEmptyAggregate,
  fixtureDefaultValueList,
  fixtureDefaultValueTable,
  fixtureEnumMembershipList,
  fixtureEnumMembershipTable,
  fixtureGeneratedList,
  fixtureGeneratedTable,
  FIXTURE_YAML,
  fixtureList,
  fixtureTable,
  withCheckTargets,
  jsonDiffPaths,
  requestDiffsOf,
  strictDefects as strictDefectsOf,
  withoutEnumMembership,
} from "../__tests__/fixtures.js";
import { deriveCarryOver, pruneForCarryOver, type CarryOver } from "../carry-over.js";
import { coverageUnitsOf } from "../coverage.js";
import { canonicalJson, nameTableSha256, type NameTable } from "../names.js";
import { OWNERSHIP_STRUCTURE_NOT_ALLOWED, PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, type LedgerView } from "../../v12/ledger.js";
import {
  GENERATED_STRUCTURE_STOP_MESSAGES,
  GENERATED_TEST_ID_MESSAGE,
  GENERATED_TEST_ID_PREFIX,
  checkGeneratedOverlap,
  generateTests,
  isGeneratedTestId,
  ledgerTargetsOf,
  type LedgerTarget,
} from "../../v12/generated-tests.js";
import { createV11aEvaluator } from "../evaluate.js";
import { TEST_CASE_BUNDLE_MESSAGES, TEST_CASE_EXPAND_MESSAGES, TEST_CASE_ID_PREFIX, testCasesSchemaOf } from "../../v12/test-cases.js";
import { CallGateway, createCallGate } from "../../call.js";
import { createBudgetedJudge } from "../../judge-budget.js";
import { JobBudget } from "../../budget.js";
import type { LlmClient } from "../../llm.js";
import { RATES, USAGE } from "../../__tests__/run.js";
import { V12_T2_BUNDLE } from "../../v12/limits.js";
import { fromPublicV12Flags, ledgerViewOf, V12_PIPELINE_FLAGS } from "../../v12/ledger.js";
import { buildSized, type SizedMaterials } from "../__tests__/sizes.js";
import { requestListedIds, requestRetainedIds, retainingT2Client } from "../__tests__/fixtures.js";
import { correspondenceFromTable } from "../bind-by-id.js";
import { toV1 } from "../convert.js";
import {
  EVALUABLE_COMBINATIONS,
  STRUCTURE_OBSERVES,
  TEST_OBSERVES,
  TEST_SPEC_DATA_NAMES,
  TEST_SPEC_DECIDED_NATURES_DATA_NAME,
  TEST_SPEC_RETAINED_DATA_NAME,
  TEST_SPEC_RETRY_DATA_NAMES,
  TEST_SPEC_ROUNDS,
  TEST_SPEC_RULES,
  TEST_SPEC_RULE_DEFINITIONS,
  TEST_SPEC_SCHEMA,
  TEST_SPEC_SCHEMA_NAME,
  DEFAULT_VALUE_EXEMPT_MESSAGES,
  DEFAULT_VALUE_TEST_MESSAGES,
  checkClassificationCompleteness,
  checkConditionTests,
  checkEvaluability,
  checkEvaluability as checkEvaluabilityOf,
  checkEvaluabilityByLedger,
  checkTestSpecOutput as checkTestSpecOutputOf,
  defaultValueTargetsOf as defaultValueTargetsOfBase,
  exemptDefaultValueProblems as exemptDefaultValueProblemsBase,
  exemptLedgerProblems,
  testSpecRuleDefinitionsOf,
  testSpecSchemaOf,
  LEDGER_UNREGISTERED_OBSERVES_MESSAGE,
  DEFAULT_VALUE_NOT_ALLOWED_MESSAGE,
  runTestSpec,
  type DefaultValueTarget,
  testSuiteSha256,
  type TestObserves,
  type TestSpecInput,
} from "./test-spec.js";

// ── 題材 ──────────────────────────────────────────────────────────

const structured = recordedStructured;

/** 確定した仕様（題材の要件の一覧と同じ要件。抽象的な文） */
function fixturePlan(list: RequirementList = fixtureList()): ConfirmedPlan {
  return {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-v11a",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: list.requirements.map((requirement) => requirement.text).join("") }],
    requirements: list.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: "constraining" as const,
      origin: { input_id: "in-1", quote: requirement.quote },
      parts: [{ id: `${requirement.id}-p1`, text: requirement.text, disposition: "met" as const }],
    })),
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
  };
}

/** 持ち越し（R5 は表の unresolved。`rejected` の要件は表の意味の点検の拒否として足す） */
async function carryOverFor(table: NameTable, rejected: readonly string[] = []): Promise<CarryOver> {
  const list = fixtureList();
  const tableSha256 = await nameTableSha256(table);
  const targets = table.verification.filter((entry) => entry.kind !== "unresolved").map((entry) => entry.requirementId);
  return deriveCarryOver({
    list,
    table,
    semanticCheck: {
      tableSha256,
      judgments: targets.map((requirementId) =>
        rejected.includes(requirementId)
          ? { requirementId, verdict: "reject" as const, kind: "unneeded-ownership", quote: "締められる" }
          : { requirementId, verdict: "accept" as const },
      ),
    },
  });
}

interface RawTestOptions {
  readonly id: string;
  readonly requirementId: string;
  readonly targetKind: string;
  readonly roleId: string;
  readonly kind?: "normal" | "abnormal" | "boundary";
  readonly operation: string;
  readonly observes: string;
  readonly input?: unknown;
  readonly assertion?: Record<string, unknown> | null;
  /** 期待（strict の schema の形。省けば下の既定。Issue #550） */
  readonly expected?: Record<string, unknown>;
}

/** strict の schema の形の試験 1 件（入力・期待の値は JSON の文字列） */
function rawTest(options: RawTestOptions): Record<string, unknown> {
  const kind = options.kind ?? "normal";
  const structure = options.operation === "structure";
  const errorExpected = kind === "abnormal" && options.operation === "validate";
  return {
    id: options.id,
    target: { requirementId: options.requirementId, kind: options.targetKind, roleId: options.roleId },
    kind,
    operation: options.operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: JSON.stringify(options.input ?? {}),
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: options.expected ?? (structure
      ? { kind: "ok", value: "true", code: null }
      : errorExpected
        ? { kind: "error", value: null, code: "E_INVALID" }
        : { kind: "ok", value: "1", code: null }),
    assertion: options.assertion ?? null,
    observes: options.observes,
  };
}

const KINDS = ["normal", "abnormal", "boundary"] as const;

/** R1：項目（金額）の検査の正常・異常・境界 */
const r1Validate = (prefix = "r1") =>
  KINDS.map((kind) =>
    rawTest({
      id: `${prefix}-${kind}`,
      requirementId: "R1",
      targetKind: "field",
      roleId: "f.item.amount",
      kind,
      operation: "validate",
      observes: "validation",
      input: { "f.item.amount": kind === "abnormal" ? -1 : 5 },
    }),
  );

/** R1：在ることだけ（entity が画面に在る）の正常 1 本 */
const r1Existence = () => [
  rawTest({ id: "r1-exist", requirementId: "R1", targetKind: "entity", roleId: "e.item", operation: "screen", observes: "existence" }),
];

/** R2：構造の検査（担当者の表に担当者の名前が出る） */
const r2Structure = () => [
  rawTest({
    id: "r2-shows",
    requirementId: "R2",
    targetKind: "screen",
    roleId: "s.members",
    operation: "structure",
    observes: "view-structure",
    assertion: { check: "view-shows", expected: null, refEntity: null, role: "f.member.title" },
  }),
];

/** R2：構造で確かめる要件の、構造の検査でない試験（外される） */
const r2Execution = (id = "r2-exec") =>
  rawTest({ id, requirementId: "R2", targetKind: "computation", roleId: "c.itemCount", operation: "compute", observes: "value" });

/**
 * R3 の操作の試験の期待の形（Issue #550）。`number` … 今までの既定（rawTest の既定の期待＝数 1）。`boolean` … 条件の真偽
 * （金額が 0 の異常は false、ほかは true。手 2p の記録の操作の試験と同じ形。旗 on の T2' は期待の型を真偽に限る）
 */
type R3Expectation = "number" | "boolean";

/** R3：操作の条件の正常・異常・境界（`kinds` で欠けを作る。`expectation` で期待の形を選ぶ。既定は今までの数） */
const r3Action = (kinds: readonly ("normal" | "abnormal" | "boundary")[] = KINDS, roleId = "o.closeItem", expectation: R3Expectation = "number") =>
  kinds.map((kind) =>
    rawTest({
      id: `r3-${kind}`,
      requirementId: "R3",
      targetKind: "operation",
      roleId,
      kind,
      operation: "action",
      observes: "when",
      input: { "f.item.amount": kind === "abnormal" ? 0 : 3 },
      ...(expectation === "boolean" ? { expected: { kind: "ok", value: kind === "abnormal" ? "false" : "true", code: null } } : {}),
    }),
  );

/** R3：期待が条件の真偽の操作の試験（旗 on の走りに使う。Issue #550） */
const r3When = (kinds: readonly ("normal" | "abnormal" | "boundary")[] = KINDS, roleId = "o.closeItem") => r3Action(kinds, roleId, "boolean");

/** R4：アプリ全体の計算の正常・異常・境界（`kinds` で数を変える） */
const r4Compute = (kinds: readonly ("normal" | "abnormal" | "boundary")[] = KINDS) =>
  kinds.map((kind) =>
    rawTest({ id: `r4-${kind}`, requirementId: "R4", targetKind: "computation", roleId: "c.rate", kind, operation: "compute", observes: "value" }),
  );

type NatureRow = { readonly requirementId: string; readonly nature: "ruled" | "existence-only" };
const T1_NATURES: readonly NatureRow[] = [
  { requirementId: "R1", nature: "ruled" },
  { requirementId: "R2", nature: "existence-only" },
  { requirementId: "R3", nature: "ruled" },
  { requirementId: "R4", nature: "ruled" },
];

/** 応答（分類と試験） */
const response = (tests: readonly Record<string, unknown>[], classifications: readonly NatureRow[] = T1_NATURES) => ({
  classifications,
  tests,
});

/** 通る応答（R5 だけ持ち越し。`r3` で R3 の試験を選ぶ。既定は今までの数の期待） */
const passing = (r3: readonly Record<string, unknown>[] = r3Action()) => response([...r1Validate(), ...r2Structure(), ...r3, ...r4Compute()]);

/** 判定の口（偽物）の要求を記録する包み */
function recordingJudge(inner: Judge): { readonly judge: Judge; readonly requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    requests,
    judge: {
      ...(inner.source === undefined ? {} : { source: inner.source }),
      async judge(request: JudgeRequest) {
        requests.push(request);
        return inner.judge(request);
      },
    },
  };
}

const choice = (value: string, probability: number): JudgeAnswer => ({
  kind: "choice",
  choice: value,
  probabilities: undefined,
  probability,
  confidence: undefined,
});

/** 段を流す（既定は R5 だけ持ち越し・題材の表） */
/** 旗 off（台帳を渡さない）と旗 on（台帳の導出を渡す）。評価可能性と #533 の試験を両方で同じ結果に照らす（Issue #547） */
const LEDGER_CASES: readonly { readonly name: string; readonly ledger: LedgerView | undefined }[] = [
  { name: "off", ledger: undefined },
  { name: "on", ledger: PROPERTY_LEDGER_VIEW },
];

/** 旗に合わせて、段・評価可能性・形の検査・既定値の要件の引き方・免除を選ぶ（on は台帳から導いた関数） */
function ledgerFunctions(ledger: LedgerView | undefined) {
  const withLedger = ledger === undefined ? {} : { ledger };
  return {
    run: (outputs: readonly unknown[], options: Parameters<typeof run>[1] = {}) => run(outputs, { ...options, ...withLedger }),
    checkEvaluability: (suite: TestSuite, observes: ReadonlyMap<string, TestObserves>, table?: NameTable) =>
      ledger === undefined ? checkEvaluabilityOf(suite, observes, table) : checkEvaluabilityByLedger(suite, observes, table, ledger),
    checkTestSpecOutput: (output: unknown) => checkTestSpecOutputOf(output, ledger),
    defaultValueTargetsOf: (table: NameTable): ReadonlyMap<string, unknown> =>
      ledger === undefined ? defaultValueTargetsOfBase(table) : ledgerTargetsOf(table, ledger),
    exemptDefaultValueProblems: (problems: readonly Problem[], list: RequirementList, targets: ReadonlyMap<string, unknown>) =>
      ledger === undefined
        ? exemptDefaultValueProblemsBase(problems, list, targets as ReadonlyMap<string, DefaultValueTarget>)
        : exemptLedgerProblems(problems, list, targets as ReadonlyMap<string, LedgerTarget>),
    ruleDefinitions: testSpecRuleDefinitionsOf(ledger),
  };
}

async function run(
  outputs: readonly unknown[],
  options: Partial<Omit<TestSpecInput, "gateway">> & { readonly rejected?: readonly string[] } = {},
) {
  const table = options.table ?? fixtureTable();
  const carryOver = options.carryOver ?? (await carryOverFor(table, options.rejected));
  const recording = createCheckedRecordingClient(outputs.map(structured));
  // 旗 `v12.ids` の中身のやり直しは、書き直さない（保持した）要件の分類と場合を台本の応答から除いて返す（Issue #651）
  const gateway = makeGateway(options.ids === true ? retainingT2Client(recording.client) : recording.client, { maxAttempts: 1 });
  const { rejected: _rejected, ...rest } = options;
  const outcome = await runTestSpec({
    plan: fixturePlan(),
    list: fixtureList(),
    documents: FIXTURE_DOCUMENTS,
    ...rest,
    table,
    carryOver,
    gateway,
  });
  return { outcome, recording, gateway };
}

/**
 * 旗 `v12.ids` の走りの応答：v1 の形（分類と試験）で書いた材料を、同じ内容の場合の形に書き換える（#625。場合の形で書いた材料と
 * 負例はそのまま）。手 3c・3d の試験の材料を、変えた契約（応答の形）に合わせる
 */
function asCases(outputs: readonly unknown[]): readonly unknown[] {
  return outputs.map((output) =>
    output instanceof NegativeOutput || typeof output !== "object" || output === null || !("tests" in output)
      ? output
      : casesResponseOf(output as { readonly classifications?: readonly unknown[]; readonly tests: readonly unknown[] }),
  );
}

/**
 * 旗 `v12.ids` の合併の並び（要件の一覧の順に要件ごと、要件の中は応答の順。一覧に無い要件 ID は末尾に応答の順。Issue #651）で、
 * 応答の `index` 番目の試験（v1 の形）か場合（場合の形）が並ぶ添字（場合の形への書き換え〔`asCases`〕は試験の順を変えない）
 */
function mergedIndexAt(output: unknown, order: readonly string[], index: number): number {
  const record = output as { readonly tests?: readonly Record<string, unknown>[]; readonly cases?: readonly Record<string, unknown>[] };
  const items = record.cases ?? record.tests ?? [];
  const rank = (item: Record<string, unknown>): number => {
    const id = item["requirementId"] ?? (item["target"] as { readonly requirementId?: unknown } | undefined)?.requirementId;
    const at = typeof id === "string" ? order.indexOf(id) : -1;
    return at === -1 ? order.length : at;
  };
  const sorted = items.map((item, at) => ({ item, at })).sort((left, right) => rank(left.item) - rank(right.item) || left.at - right.at);
  const found = sorted.findIndex((entry) => entry.at === index);
  if (found === -1) throw new Error("前提が壊れた：応答の添字が無い");
  return found;
}

/** 場合の形の応答を合併の並び（`mergedIndexAt` と同じ規則。分類も同じ規則）に並べ替えたもの */
function mergedOutputOf(output: { readonly classifications: readonly unknown[]; readonly cases: readonly unknown[] }, order: readonly string[]) {
  const rank = (item: unknown): number => {
    const id = (item as { readonly requirementId?: unknown }).requirementId;
    const at = typeof id === "string" ? order.indexOf(id) : -1;
    return at === -1 ? order.length : at;
  };
  const sorted = (items: readonly unknown[]) =>
    items.map((item, at) => ({ item, at })).sort((left, right) => rank(left.item) - rank(right.item) || left.at - right.at).map((entry) => entry.item);
  return { ...output, classifications: sorted(output.classifications), cases: sorted(output.cases) };
}

/** v1 の形で書いた応答の試験 `id` の、合併の並びでの添字（`mergedIndexAt`） */
function mergedCaseIndexOf(output: { readonly tests: readonly Record<string, unknown>[] }, order: readonly string[], id: string): number {
  const index = output.tests.findIndex((test) => test["id"] === id);
  if (index === -1) throw new Error(`前提が壊れた：応答に試験 ${id} が無い`);
  return mergedIndexAt(output, order, index);
}

/** データの塊の名前の並び */
function dataNamesOf(input: string): readonly string[] {
  return [...input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1] ?? "");
}

/** データの塊の中身（JSON）を読む */
function dataBlockOf(input: string, name: string): unknown {
  const match = new RegExp(`<data name="${name}">\\n([\\s\\S]*?)\\n</data>`).exec(input);
  if (match === null) throw new Error(`データの塊が無い: ${name}`);
  return JSON.parse(match[1] ?? "null");
}

/** データの塊の中身（生の文字列）の並び */
function dataTextsOf(input: string): readonly string[] {
  return [...input.matchAll(/<data name="[^"]+">\n([\s\S]*?)\n<\/data>/g)].map((match) => match[1] ?? "");
}

/** 要求の全文（規則・文書・データ・schema） */
const requestText = (request: LlmStructuredRequest): string => JSON.stringify(request);

// ── 規則と schema ─────────────────────────────────────────────────

describe("規則と schema（Issue #508）", () => {
  it("規則の定義に不備が無く、送る文は定義の text から組む。ID は R-tsp-nn", () => {
    expect(ruleDefinitionDefects(TEST_SPEC_RULE_DEFINITIONS)).toEqual([]);
    expect(TEST_SPEC_RULES).toEqual(ruleTexts(TEST_SPEC_RULE_DEFINITIONS));
    for (const definition of TEST_SPEC_RULE_DEFINITIONS) expect(definition.id).toMatch(/^R-tsp-\d{2}$/);
    // v1 の ②' の規則の定義とは別の並び（v1 の ID を使わない）
    const v1Ids = new Set(TEST_SUITE_RULE_DEFINITIONS.map((definition) => definition.id));
    expect(TEST_SPEC_RULE_DEFINITIONS.some((definition) => v1Ids.has(definition.id))).toBe(false);
  });

  it("schema は ②' の schema に試験ごとの observes（7 つの値）を足したもの", () => {
    const items = TEST_SPEC_SCHEMA.properties.tests.items;
    expect(items.required).toContain("observes");
    expect(items.properties.observes.enum).toEqual([...TEST_OBSERVES]);
    expect(TEST_OBSERVES).toEqual([
      "when",
      "value",
      "validation",
      "view-structure",
      "existence",
      "state-after-set",
      "default-value",
    ]);
    expect(TEST_SPEC_SCHEMA.required).toEqual(["classifications", "tests"]);
  });
});

// ── データ ───────────────────────────────────────────────────────

describe("T2 のデータ（名前・T1 の分類・期待・合否・宣言を見せない。§2.3）", () => {
  it("データの名前の並びが決まりどおりで、表の塊に name の鍵が無く role・source がある", async () => {
    const { outcome, recording } = await run([passing()]);
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    if (request === undefined) throw new Error("要求が無い");
    expect(request.schemaName).toBe(TEST_SPEC_SCHEMA_NAME);
    expect(dataNamesOf(request.input)).toEqual([...TEST_SPEC_DATA_NAMES]);
    expect(TEST_SPEC_DATA_NAMES).toEqual(["確定した仕様", "要件の一覧", "対象の表", "要件ごとの確かめ方", "要件ごとの所属"]);
    // 文書はデータではなく文書の欄に渡す
    expect(request.documents).toEqual(FIXTURE_DOCUMENTS.map((document) => `${document.name}\n${document.text}`));
    const rows = dataBlockOf(request.input, "対象の表") as readonly Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(new Set(Object.keys(row))).toEqual(
        new Set(["entity", "groupBy", "id", "kind", "options", "refEntity", "role", "source", "type"]),
      );
      expect("name" in row).toBe(false);
      expect(typeof row["role"]).toBe("string");
      expect(row["source"]).toBeDefined();
    }
    // 宣言の名前（表の name の値）が表の塊に出ない
    const tableText = JSON.stringify(rows);
    expect(tableText).not.toContain('"itemCount"');
    expect(tableText).not.toContain('"closeItem"');
  });

  it("データのどの塊にも要件の種類（nature）が無く、期待・合否・宣言の塊も無い", async () => {
    const { recording } = await run([passing()]);
    const input = recording.structured[0]?.input ?? "";
    for (const text of dataTextsOf(input)) {
      expect(text).not.toContain('"nature"');
      expect(text).not.toContain("existence-only");
    }
    // 塊は決まった 5 つだけ（期待・合否・宣言の塊は無い）
    expect(dataNamesOf(input)).toEqual([...TEST_SPEC_DATA_NAMES]);
    // 宣言（YAML）の断片が無い
    expect(input).not.toContain("entities:");
    expect(input).not.toContain("views:");
  });

  it("確定した仕様の要件ごとの kind（existence／constraining）は、データの全塊・前置きのどこにも無い（2 回目も）", async () => {
    // existence と constraining を混ぜた仕様で、1 回目は落として 2 回目の要求も見る
    const base = fixturePlan();
    const plan: ConfirmedPlan = {
      ...base,
      requirements: base.requirements.map((requirement, index) => ({
        ...requirement,
        kind: index % 2 === 0 ? ("existence" as const) : ("constraining" as const),
      })),
    };
    const round1 = response([...r1Validate(), ...r2Structure(), ...r3Action(["normal", "abnormal"]), ...r4Compute()]);
    const { recording } = await run([round1, passing()], { plan });
    expect(recording.structured.length).toBe(2);
    const planKindPair = /\\?"kind\\?"\s*:\s*\\?"(?:existence|constraining)\\?"/;
    for (const request of recording.structured) {
      const shown = dataBlockOf(request.input, "確定した仕様") as { readonly requirements: readonly Record<string, unknown>[] };
      expect(shown.requirements.length).toBe(plan.requirements.length);
      for (const requirement of shown.requirements) {
        expect("kind" in requirement).toBe(false);
        expect(requirement["text"]).toBeDefined();
      }
      for (const text of dataTextsOf(request.input)) {
        expect(text).not.toMatch(planKindPair);
        expect(text).not.toContain("constraining");
      }
      // 前置き（共通の規則・文書・段の規則・schema）と要求の全文
      for (const text of [request.instructions, ...(request.documents ?? []), ...(request.rules ?? []), JSON.stringify(request.schema), requestText(request)]) {
        expect(text).not.toMatch(planKindPair);
        expect(text).not.toContain("constraining");
      }
    }
  });

  it("持ち越した要件が一覧・所属に無く、その要件だけの行が所属に無い", async () => {
    // R5 は表の unresolved、R3 は表の意味の点検の拒否で持ち越し。o.closeItem は R3 だけの行
    const carryOver = await carryOverFor(fixtureTable(), ["R3"]);
    expect(carryOver.excludedRowIds).toEqual(["o.closeItem"]);
    const tests = [...r1Validate(), ...r2Structure(), ...r4Compute()];
    const { outcome, recording } = await run([response(tests, T1_NATURES.filter((entry) => entry.requirementId !== "R3"))], {
      carryOver,
    });
    expect(outcome.ok).toBe(true);
    const input = recording.structured[0]?.input ?? "";
    const list = dataBlockOf(input, "要件の一覧") as RequirementList;
    expect(list.requirements.map((requirement) => requirement.id)).toEqual(["R1", "R2", "R4"]);
    const ownership = dataBlockOf(input, "要件ごとの所属") as readonly {
      readonly requirementId: string;
      readonly roles: readonly { readonly id: string }[];
    }[];
    expect(ownership.map((entry) => entry.requirementId)).toEqual(["R1", "R2", "R4"]);
    expect(ownership.flatMap((entry) => entry.roles.map((role) => role.id))).not.toContain("o.closeItem");
    const verification = dataBlockOf(input, "要件ごとの確かめ方") as readonly { readonly requirementId: string }[];
    expect(verification.map((entry) => entry.requirementId)).toEqual(["R1", "R2", "R4"]);
    // 共有する行（R1 と R3 が所属させる金額）は残る
    expect(ownership.find((entry) => entry.requirementId === "R1")?.roles.map((role) => role.id)).toContain("f.item.amount");
  });

  it("要求のどこにも受入の題材の言葉が無い", async () => {
    const { recording } = await run([response([...r1Validate(), ...r2Structure(), ...r3Action(["normal"]), ...r4Compute()]), passing()]);
    expect(recording.structured).toHaveLength(2);
    expectNoAcceptanceMaterial(recording.structured.map(requestText));
    expectNoAcceptanceMaterial([...TEST_SPEC_RULES, JSON.stringify(TEST_SPEC_SCHEMA)]);
  });

  it("全件が持ち越しなら LLM を呼ばずに断る（D15）", async () => {
    const recording = createCheckedRecordingClient([]);
    const carryOver: CarryOver = {
      entries: fixtureList().requirements.map((requirement) => ({
        requirementId: requirement.id,
        reasons: [{ origin: "semantic-check", reason: "x" }],
      })),
      excludedRowIds: [],
      remainingRequirementIds: [],
      allCarried: true,
    };
    await expect(
      runTestSpec({
        plan: fixturePlan(),
        list: fixtureList(),
        table: fixtureTable(),
        carryOver,
        documents: FIXTURE_DOCUMENTS,
        gateway: makeGateway(recording.client),
      }),
    ).rejects.toThrow("残る要件が 0");
    expect(recording.structured).toHaveLength(0);
  });
});

// ── 評価可能性 ─────────────────────────────────────────────────────

/** 評価可能性の検査だけに渡す試験（形の検査は通さない。対象・操作・中身だけを持つ） */
function bareTest(id: string, targetKind: string, operation: string, check?: StructuralAssertionKind): FixedTest {
  return {
    id,
    target: { requirementId: "R1", kind: targetKind, roleId: "x" },
    kind: "normal",
    operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: {},
    referenceData: [],
    expected: { kind: "ok", value: true },
    ...(check === undefined ? {} : { assertion: { check } }),
  } as FixedTest;
}

/** 評価可能性の固定文（値を埋めない） */
const FIXED_MESSAGES: readonly string[] = [
  "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態の試験は作らない）",
  "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い",
];

describe.each(LEDGER_CASES)("評価可能性（対象の種類・操作・observes を評価の方法の表に照らす。§2.3 の (i)。旗 $name）", ({ ledger }) => {
  /** 旗 on の走りは期待が真偽の R3 の操作の試験、off は今までの数の期待（Issue #550） */
  const r3For = ledger === undefined ? r3Action : r3When;
  const { run, checkEvaluability } = ledgerFunctions(ledger);
  it("表にある組の全部が通り、表に無い組（未対応の性質を含む）は全部が固定文で落ちる（全組を列挙）", () => {
    const listed = new Set(EVALUABLE_COMBINATIONS.map((entry) => `${entry.targetKind}|${entry.operation}|${entry.observes}`));
    // 8 組に（項目・validate・default-value）を足した 9 組（Issue #533）
    expect(listed.size).toBe(9);
    expect(listed.has("field|validate|default-value")).toBe(true);
    let passed = 0;
    for (const targetKind of TEST_TARGET_KINDS) {
      for (const operation of TEST_OPERATIONS.filter((candidate) => candidate !== "structure")) {
        for (const observes of TEST_OBSERVES) {
          const test = bareTest("t", targetKind, operation);
          const problems = checkEvaluability({ tests: [test] }, new Map([["t", observes]]));
          if (observes === "default-value") {
            // 表（確かめ方）を渡さなければ、既定値の試験はどの組でも固定文で落ちる（Issue #533）
            expect(problems).toEqual([{ field: "tests[0].observes", message: DEFAULT_VALUE_NOT_ALLOWED_MESSAGE }]);
          } else if (listed.has(`${targetKind}|${operation}|${observes}`)) {
            expect(problems).toEqual([]);
            passed += 1;
          } else {
            expect(problems).toHaveLength(1);
            expect(problems[0]?.field).toBe("tests[0].observes");
            // 固定文（対象の種類・操作・性質の値を埋めない）
            expect(FIXED_MESSAGES).toContain(problems[0]?.message);
          }
        }
      }
    }
    // 表を渡さない走査では、既定値の組だけが通らない
    expect(passed).toBe(EVALUABLE_COMBINATIONS.length - 1);
  });

  it("state-after-set はどの組でも未対応の固定文で落ちる。default-value は確かめ方が fixed-test の要件では固定文で落ちる（Issue #533 で読み替え）", () => {
    const problems = checkEvaluability({ tests: [bareTest("t", "operation", "action")] }, new Map([["t", "state-after-set" as const]]));
    expect(problems).toEqual([
      {
        field: "tests[0].observes",
        message: "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態の試験は作らない）",
      },
    ]);
    // 題材の表の R1 は確かめ方が fixed-test。その要件の選択肢の項目に既定値の試験を作っても落ちる
    for (const [targetKind, operation] of [["operation", "action"], ["field", "validate"]] as const) {
      const test = { ...bareTest("t", targetKind, operation), target: { requirementId: "R1", kind: targetKind, roleId: "f.item.kind" } } as FixedTest;
      expect(checkEvaluability({ tests: [test] }, new Map([["t", "default-value" as const]]), fixtureTable())).toEqual([
        { field: "tests[0].observes", message: DEFAULT_VALUE_NOT_ALLOWED_MESSAGE },
      ]);
    }
  });

  it("表に無い組（operation × action × value）は固定文で落ちる", () => {
    const problems = checkEvaluability({ tests: [bareTest("t", "operation", "action")] }, new Map([["t", "value" as const]]));
    expect(problems).toEqual([
      { field: "tests[0].observes", message: "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い" },
    ]);
  });

  it("構造の検査は、検査の中身に合う view-structure／existence だけが通る（全組を列挙）", () => {
    for (const check of STRUCTURAL_ASSERTIONS) {
      for (const observes of TEST_OBSERVES) {
        const problems = checkEvaluability(
          { tests: [bareTest("t", "screen", "structure", check)] },
          new Map<string, TestObserves>([["t", observes]]),
        );
        const expected = check === "view-shows" ? "view-structure" : "existence";
        expect(STRUCTURE_OBSERVES[check]).toBe(expected);
        expect(problems.length === 0).toBe(observes === expected);
      }
    }
  });

  it("観測する性質の引けない試験は落ちる", () => {
    expect(checkEvaluability({ tests: [bareTest("t", "computation", "compute")] }, new Map())).toEqual([
      { field: "tests[0].observes", message: "観測する性質が引けない" },
    ]);
  });

  it("段で state-after-set の試験を作れば、2 回とも落ちて unmet（attempts 2・calls 2）", async () => {
    const bad = response([
      ...r1Validate(),
      ...r2Structure(),
      ...r3For().map((test, index) => (index === 0 ? { ...test, observes: "state-after-set" } : test)),
      ...r4Compute(),
    ]);
    const { outcome, recording, gateway } = await run([bad, bad]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.attempts).toBe(TEST_SPEC_ROUNDS);
    expect(TEST_SPEC_ROUNDS).toBe(2);
    expect(recording.structured).toHaveLength(2);
    expect(gateway.counts.attempts.started).toBe(2);
    expect(outcome.failure.problems).toEqual([
      {
        field: "tests[4].observes",
        message: "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態の試験は作らない）",
      },
    ]);
  });

  it("段で operation × action × value の試験を作れば、評価の方法の表に無い組として落ちる", async () => {
    const bad = response([
      ...r1Validate(),
      ...r2Structure(),
      ...r3For().map((test) => ({ ...test, observes: "value" })),
      ...r4Compute(),
    ]);
    const { outcome } = await run([bad, bad]);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems.map((problem) => problem.message)).toEqual(
      Array(3).fill("（対象の種類・操作・観測する性質）の組が評価の方法の表に無い"),
    );
  });

  it("知らない observes は形の落ち（共通の窓口が 1 回やり直し、2 回で malformed）", async () => {
    const bad = negative(
      response([...r1Validate(), ...r2Structure(), ...r3For(), ...r4Compute()].map((test) => ({ ...test, observes: "other" }))),
      "observes が enum の外の応答。strict の schema では出ないが、形の検査の落ちを観測する負例",
    );
    const { outcome, recording } = await run([bad, bad]);
    if (outcome.ok || outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(recording.structured).toHaveLength(2);
    expect(outcome.failure.problems.every((problem) => problem.field.endsWith(".observes"))).toBe(true);
  });

  it("試験 ID の重なりは形の落ち", async () => {
    const tests = [...r1Validate(), ...r2Structure(), ...r3For(), ...r4Compute()];
    const bad = response([...tests, { ...tests[0] }]);
    const { outcome } = await run([bad, bad]);
    if (outcome.ok || outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(outcome.failure.problems).toEqual([{ field: `tests[${tests.length}].id`, message: "試験の識別子が組の中で重なっている" }]);
  });
});

// ── v1 の検査・持ち越し・やり直し ─────────────────────────────────────

describe("v1 の検査を新契約で呼ぶ・持ち越しの要件の試験は落ちる・やり直し（§1.2・§2.3）", () => {
  it("v1 の検査の負例：対象の id が要件の所属に無い試験は、2 回とも落ちて unmet（attempts 2・calls 2）", async () => {
    // R3 の試験の対象を、R1 だけが所属させる操作（o.addItem）にする
    const bad = response([...r1Validate(), ...r2Structure(), ...r3Action(KINDS, "o.addItem"), ...r4Compute()]);
    const { outcome, recording, gateway } = await run([bad, bad]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.attempts).toBe(2);
    expect(recording.structured).toHaveLength(2);
    expect(gateway.counts.attempts.started).toBe(2);
    expect(outcome.failure.problems).toContainEqual({
      field: "tests[4].target.roleId",
      message: "対象の役割 ID が、その要件の所属に無い",
    });
  });

  it("持ち越しの要件（R5）の試験は、一覧に無い要件 ID として落ちる", async () => {
    const carried = rawTest({ id: "r5", requirementId: "R5", targetKind: "entity", roleId: "e.item", operation: "screen", observes: "existence" });
    const bad = response([...r1Validate(), ...r2Structure(), ...r3Action(), ...r4Compute(), carried]);
    const { outcome } = await run([bad, bad]);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems).toContainEqual({
      field: "tests[10].target.requirementId",
      message: "一覧に無い要件 ID である",
    });
  });

  it("2 回目のデータに前回の試験（外して種類を書き込んだ後の組）と前回の作り直しの指示があり、前置きが 1 回目と等しい", async () => {
    // 1 回目：R2 の実行の試験（外される）を含み、R3 の境界が欠ける。2 回目：通る
    const round1 = response([...r1Validate(), r2Execution(), ...r2Structure(), ...r3Action(["normal", "abnormal"]), ...r4Compute()]);
    const { outcome, recording, gateway } = await run([round1, passing()]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.rounds).toBe(2);
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 1 });
    const [first, second] = recording.structured;
    if (first === undefined || second === undefined) throw new Error("要求が 2 つ無い");
    // 前置き（共通の規則・文書・段の規則・schema）は 1 回目と同じで、データは末尾に足すだけ
    expect(second.instructions).toBe(first.instructions);
    expect(second.documents).toEqual(first.documents);
    expect(second.rules).toEqual(first.rules);
    expect(second.schema).toEqual(first.schema);
    expect(second.input.startsWith(first.input)).toBe(true);
    expect(dataNamesOf(second.input)).toEqual([...TEST_SPEC_DATA_NAMES, ...TEST_SPEC_RETRY_DATA_NAMES]);
    const previousTests = dataBlockOf(second.input, "前回の試験") as readonly { readonly id: string; readonly observes: string }[];
    // 外した後の組（r2-exec を含まない）で、試験ごとに観測する性質を添える
    expect(previousTests.map((test) => test.id)).toEqual([
      "r1-normal",
      "r1-abnormal",
      "r1-boundary",
      "r2-shows",
      "r3-normal",
      "r3-abnormal",
      "r4-normal",
      "r4-abnormal",
      "r4-boundary",
    ]);
    expect(previousTests.map((test) => test.observes)).toEqual([
      "validation",
      "validation",
      "validation",
      "view-structure",
      "when",
      "when",
      "value",
      "value",
      "value",
    ]);
    const previousProblems = dataBlockOf(second.input, "前回の作り直しの指示") as readonly { readonly field: string }[];
    expect(previousProblems).toEqual([{ field: "requirements[2]", message: "boundary の試験が無い" }]);
    // 外した試験は回ごとに数える
    expect(outcome.value.dropped).toEqual([{ round: 1, testId: "r2-exec", requirementId: "R2", operation: "compute" }]);
  });

  it("組の SHA は observes を含む：observes を 1 つ変えると SHA が変わり、同じ組・同じ observes なら 2 回同じ", async () => {
    const { outcome } = await run([passing()]);
    if (!outcome.ok) throw new Error("通らない");
    const { suite, observes, sha256 } = outcome.value;
    expect(await testSuiteSha256(suite, observes)).toBe(sha256);
    expect(await testSuiteSha256(suite, new Map(observes))).toBe(sha256);
    const [firstId, firstObserves] = [...observes][0] ?? [];
    if (firstId === undefined || firstObserves === undefined) throw new Error("observes が無い");
    const changed = new Map(observes);
    changed.set(firstId, firstObserves === "value" ? "validation" : "value");
    const changedSha = await testSuiteSha256(suite, changed);
    expect(changedSha).toMatch(/^[0-9a-f]{64}$/);
    expect(changedSha).not.toBe(sha256);
    // 組だけの SHA とも違う（observes が測られている）
    expect(sha256).not.toBe(await sha256Hex(canonicalJson(suite)));
  });

  it("通った組の網羅の単位は A1 の関数の値と等しく、組の SHA は 2 回同じ。observes は FixedTest に入らない", async () => {
    const first = await run([passing()]);
    const second = await run([passing()]);
    if (!first.outcome.ok || !second.outcome.ok) throw new Error("通らない");
    const value = first.outcome.value;
    expect(value.rounds).toBe(1);
    expect(value.coverage).toEqual(
      coverageUnitsOf({
        suite: value.suite,
        observes: value.observes,
        natures: new Map(T1_NATURES.map((entry) => [entry.requirementId, entry.nature])),
      }),
    );
    expect(value.coverage.length).toBe(10);
    expect(value.sha256).toBe(second.outcome.value.sha256);
    expect(value.sha256).toBe(
      await sha256Hex(canonicalJson({ suite: value.suite, observes: Object.fromEntries(value.observes) })),
    );
    expect(value.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const test of value.suite.tests) expect("observes" in test).toBe(false);
    expect([...value.observes.keys()]).toEqual(value.suite.tests.map((test) => test.id));
    expect(value.discrepancies).toEqual([]);
    expect(value.dropped).toEqual([]);
  });
});

// ── 種類の分類と照合（J2）────────────────────────────────────────────

describe("種類の分類と照合（T1 の分類と T2 の分類の食い違いは J2。§1.1）", () => {
  it("T1 が ruled・T2 が existence-only：J2 を 1 回呼び、judged で採った種類が網羅の検査に効く", async () => {
    const recorded = recordingJudge(createFakeJudge({ [natureQuestionName("R1")]: choice("existence-only", 0.9) }));
    const classifications = T1_NATURES.map((entry) =>
      entry.requirementId === "R1" ? { requirementId: "R1", nature: "existence-only" as const } : entry,
    );
    // R1 は正常 1 本だけ（existence-only なら通り、ruled なら異常・境界が欠ける）
    const output = response([...r1Existence(), ...r2Structure(), ...r3Action(), ...r4Compute()], classifications);
    const { outcome } = await run([output], { judge: recorded.judge });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(recorded.requests).toHaveLength(1);
    // 一致する要件（R2〜R4）は聞かない
    expect(Object.keys(recorded.requests[0]?.questions ?? {})).toEqual([natureQuestionName("R1")]);
    expect(outcome.value.discrepancies).toEqual([
      expect.objectContaining({
        requirementId: "R1",
        design: "ruled",
        classified: "existence-only",
        resolved: "existence-only",
        resolution: "judged",
        probability: 0.9,
      }),
    ]);
    expect(outcome.value.natures.get("R1")).toBe("existence-only");
    expect(outcome.value.suite.classifications?.find((entry) => entry.requirementId === "R1")?.nature).toBe("existence-only");
    // 網羅の単位も採った種類で導く
    expect(outcome.value.coverage).toEqual(
      coverageUnitsOf({ suite: outcome.value.suite, observes: outcome.value.observes, natures: outcome.value.natures }),
    );
  });

  it("確率が閾値未満なら ruled へ倒し（fallback）、同じ組は網羅の検査で落ちる", async () => {
    const recorded = recordingJudge(
      createFakeJudge({ [natureQuestionName("R1")]: choice("existence-only", NATURE_JUDGE_THRESHOLD - 0.01) }),
    );
    const classifications = T1_NATURES.map((entry) =>
      entry.requirementId === "R1" ? { requirementId: "R1", nature: "existence-only" as const } : entry,
    );
    const output = response([...r1Existence(), ...r2Structure(), ...r3Action(), ...r4Compute()], classifications);
    const { outcome } = await run([output, output], { judge: recorded.judge });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems).toContainEqual({ field: "requirements[0]", message: "abnormal の試験が無い" });
    // 2 回目の呼び出しでも聞き直さない（前の判断のまま）
    expect(recorded.requests).toHaveLength(1);
  });

  it("判定が答えを返さない／確率が閾値未満なら ruled・fallback で、結果に出る", async () => {
    const classifications = T1_NATURES.map((entry) =>
      entry.requirementId === "R1" ? { requirementId: "R1", nature: "existence-only" as const } : entry,
    );
    // R1 は ruled の組（倒した ruled で通る）
    const output = response([...r1Validate(), ...r2Structure(), ...r3Action(), ...r4Compute()], classifications);
    const judges: readonly Judge[] = [
      createFakeJudge({}), // 答えを用意しない（判定が失敗する）
      createFakeJudge({ [natureQuestionName("R1")]: choice("existence-only", 0.1) }),
    ];
    for (const judge of judges) {
      const { outcome } = await run([output], { judge });
      if (!outcome.ok) throw new Error("通らない");
      expect(outcome.value.discrepancies).toEqual([
        { requirementId: "R1", design: "ruled", classified: "existence-only", resolved: "ruled", resolution: "fallback" },
      ]);
      expect(outcome.value.natures.get("R1")).toBe("ruled");
    }
  });

  it("T1 が existence-only・T2 が ruled（逆）でも J2 を 1 回呼ぶ", async () => {
    const base = fixtureTable();
    const table: NameTable = {
      ...base,
      classification: base.classification.map((entry) =>
        entry.requirementId === "R4" ? { requirementId: "R4", nature: "existence-only" as const } : entry,
      ),
    };
    const recorded = recordingJudge(createFakeJudge({ [natureQuestionName("R4")]: choice("ruled", 0.8) }));
    const { outcome } = await run([passing()], { table, judge: recorded.judge });
    if (!outcome.ok) throw new Error("通らない");
    expect(recorded.requests).toHaveLength(1);
    expect(Object.keys(recorded.requests[0]?.questions ?? {})).toEqual([natureQuestionName("R4")]);
    expect(outcome.value.discrepancies).toEqual([
      expect.objectContaining({ requirementId: "R4", design: "existence-only", classified: "ruled", resolved: "ruled", resolution: "judged" }),
    ]);
  });

  it("T1 と T2 が一致すれば J2 を呼ばない", async () => {
    const recorded = recordingJudge(createFakeJudge({}));
    const { outcome } = await run([passing()], { judge: recorded.judge });
    expect(outcome.ok).toBe(true);
    expect(recorded.requests).toHaveLength(0);
  });

  it("2 回目の呼び出しで同じ要件を聞き直さず、前の判断（judged）のまま", async () => {
    const recorded = recordingJudge(createFakeJudge({ [natureQuestionName("R1")]: choice("existence-only", 0.9) }));
    const classifications = T1_NATURES.map((entry) =>
      entry.requirementId === "R1" ? { requirementId: "R1", nature: "existence-only" as const } : entry,
    );
    // 1 回目は R3 の境界が欠ける。2 回目は R2 の分類を変えても、R1 は聞き直さない
    const round1 = response([...r1Existence(), ...r2Structure(), ...r3Action(["normal", "abnormal"]), ...r4Compute()], classifications);
    const round2 = response([...r1Existence(), ...r2Structure(), ...r3Action(), ...r4Compute()], classifications);
    const { outcome } = await run([round1, round2], { judge: recorded.judge });
    if (!outcome.ok) throw new Error("通らない");
    expect(outcome.value.rounds).toBe(2);
    expect(recorded.requests).toHaveLength(1);
    expect(outcome.value.discrepancies).toEqual([
      expect.objectContaining({ requirementId: "R1", resolved: "existence-only", resolution: "judged" }),
    ]);
  });
});

// ── 分類の完全性（照合の前。レビュー #521 の指摘 1）────────────────────────────

describe("分類の完全性（残る要件にちょうど 1 件。照合の前に断る。§1.1）", () => {
  const complete = () => [...r1Validate(), ...r2Structure(), ...r3Action(), ...r4Compute()];
  const missingAll = [0, 1, 2, 3].map((index) => ({ field: `requirements[${index}]`, message: "要件の分類が無い" }));

  it("関数：完全なら問題なし。空配列・未定義は残る要件の全部が欠落", async () => {
    const table = fixtureTable();
    const list = pruneForCarryOver(fixtureList(), table, await carryOverFor(table)).list;
    const ids = list.requirements.map((requirement) => requirement.id);
    const full = ids.map((requirementId) => ({ requirementId, nature: "ruled" as const }));
    expect(checkClassificationCompleteness(list, full)).toEqual([]);
    const allMissing = ids.map((_, index) => ({ field: `requirements[${index}]`, message: "要件の分類が無い" }));
    expect(checkClassificationCompleteness(list, [])).toEqual(allMissing);
    expect(checkClassificationCompleteness(list, undefined)).toEqual(allMissing);
  });

  it("classifications が空配列なら、T1 の分類だけで固定せず 2 回とも落ちて unmet（J2 を呼ばない）", async () => {
    const recorded = recordingJudge(createFakeJudge({}));
    const empty = response(complete(), []);
    const { outcome, recording } = await run([empty, empty], { judge: recorded.judge });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.attempts).toBe(TEST_SPEC_ROUNDS);
    expect(recording.structured).toHaveLength(2);
    expect(outcome.failure.problems).toEqual(missingAll);
    expect(recorded.requests).toHaveLength(0);
  });

  it("判定の口が無くても、空配列は 2 回とも落ちて unmet", async () => {
    const empty = response(complete(), []);
    const { outcome } = await run([empty, empty]);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems).toEqual(missingAll);
  });

  it("1 回目が空配列でも、2 回目のデータに前回の作り直しの指示があり、完全な分類なら通る", async () => {
    const { outcome, recording } = await run([response(complete(), []), passing()]);
    if (!outcome.ok) throw new Error("通らない");
    expect(outcome.value.rounds).toBe(2);
    const second = recording.structured[1]?.input ?? "";
    expect(dataBlockOf(second, TEST_SPEC_RETRY_DATA_NAMES[1])).toEqual(missingAll);
  });

  it("1 件欠落（R1 の分類が無い）は落ちる", async () => {
    const missing = response(
      complete(),
      T1_NATURES.filter((entry) => entry.requirementId !== "R1"),
    );
    const { outcome } = await run([missing, missing]);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems).toEqual([{ field: "requirements[0]", message: "要件の分類が無い" }]);
  });

  it("重複（R1 が 2 件。値が違っても同じでも）は落ちる", async () => {
    for (const nature of ["ruled", "existence-only"] as const) {
      const duplicated = response(complete(), [...T1_NATURES, { requirementId: "R1", nature }]);
      const { outcome } = await run([duplicated, duplicated]);
      if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
      expect(outcome.failure.problems).toEqual([
        { field: "classifications[4].requirementId", message: "同じ要件の分類が重なっている" },
      ]);
    }
  });

  it("対象外の要件 ID（持ち越しの R5・一覧に無い ID）は落ちる", async () => {
    for (const requirementId of ["R5", "R9"]) {
      const outside = response(complete(), [...T1_NATURES, { requirementId, nature: "ruled" }]);
      const { outcome } = await run([outside, outside]);
      if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
      expect(outcome.failure.problems).toEqual([
        { field: "classifications[4].requirementId", message: "要件の一覧に無い要件 ID の分類である" },
      ]);
    }
  });
});

// ── 判断の保持（再試行の回で一致しても。レビュー #521 の指摘 2）────────────────────

describe("J2 の判断を再試行の回でも保つ（その回に T1 と T2 が一致しても。§1.1）", () => {
  /** T1 の R1 を existence-only にした表 */
  const tableR1Existence = (): NameTable => {
    const base = fixtureTable();
    return {
      ...base,
      classification: base.classification.map((entry) =>
        entry.requirementId === "R1" ? { requirementId: "R1", nature: "existence-only" as const } : entry,
      ),
    };
  };
  const agreeing = T1_NATURES.map((entry) =>
    entry.requirementId === "R1" ? { requirementId: "R1", nature: "existence-only" as const } : entry,
  );
  // 1 回目：T2 の R1 は ruled（T1 と食い違う）。別の要件（R3）の境界が欠けて作り直しになる
  const round1 = () => response([...r1Validate(), ...r2Structure(), ...r3Action(["normal", "abnormal"]), ...r4Compute()]);

  it("T1=existence-only・1 回目 T2=ruled・J2=ruled → 2 回目 T2=existence-only でも R1 は ruled（正常 1 本は網羅で落ちる）", async () => {
    const recorded = recordingJudge(createFakeJudge({ [natureQuestionName("R1")]: choice("ruled", 0.99) }));
    const round2 = response([...r1Existence(), ...r2Structure(), ...r3Action(), ...r4Compute()], agreeing);
    const { outcome } = await run([round1(), round2], { table: tableR1Existence(), judge: recorded.judge });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems).toContainEqual({ field: "requirements[0]", message: "abnormal の試験が無い" });
    expect(outcome.failure.problems).toContainEqual({ field: "requirements[0]", message: "boundary の試験が無い" });
    expect(recorded.requests).toHaveLength(1);
  });

  it("判定の口が無い fallback（ruled）も、2 回目に一致しても保つ", async () => {
    const round2 = response([...r1Existence(), ...r2Structure(), ...r3Action(), ...r4Compute()], agreeing);
    const { outcome } = await run([round1(), round2], { table: tableR1Existence() });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems).toContainEqual({ field: "requirements[0]", message: "abnormal の試験が無い" });
  });

  it("2 回目に一致して通るときも、採った種類・組の分類・網羅の単位・食い違いの記録が判断どおり", async () => {
    const recorded = recordingJudge(createFakeJudge({ [natureQuestionName("R1")]: choice("ruled", 0.99) }));
    const round2 = response([...r1Validate(), ...r2Structure(), ...r3Action(), ...r4Compute()], agreeing);
    const { outcome } = await run([round1(), round2], { table: tableR1Existence(), judge: recorded.judge });
    if (!outcome.ok) throw new Error("通らない");
    expect(outcome.value.rounds).toBe(2);
    expect(recorded.requests).toHaveLength(1);
    expect(outcome.value.natures.get("R1")).toBe("ruled");
    expect(outcome.value.suite.classifications?.filter((entry) => entry.requirementId === "R1")).toEqual([
      { requirementId: "R1", nature: "ruled" },
    ]);
    expect(outcome.value.discrepancies).toEqual([
      expect.objectContaining({
        requirementId: "R1",
        design: "existence-only",
        classified: "ruled",
        resolved: "ruled",
        resolution: "judged",
        probability: 0.99,
      }),
    ]);
    expect(outcome.value.coverage).toEqual(
      coverageUnitsOf({ suite: outcome.value.suite, observes: outcome.value.observes, natures: outcome.value.natures }),
    );
  });
});

// ── やり直しに採った種類を渡す（方法論 03 §1 の H3。Issue #526）────────────────────

describe("2 回目のデータに、J2 で決めた要件だけの採った種類を渡す（Issue #526）", () => {
  /** R1・R4 を T1 と食い違わせた分類（R1：existence-only、R4：existence-only） */
  const discrepant = T1_NATURES.map((entry) =>
    entry.requirementId === "R1" || entry.requirementId === "R4"
      ? { requirementId: entry.requirementId, nature: "existence-only" as const }
      : entry,
  );
  // 1 回目：R3 の境界が欠けて作り直しになる（R1・R4 は ruled の組）
  const round1 = () => response([...r1Validate(), ...r2Structure(), ...r3Action(["normal", "abnormal"]), ...r4Compute()], discrepant);
  const round2 = () => response([...r1Validate(), ...r2Structure(), ...r3Action(), ...r4Compute()], discrepant);

  it("judged の要件だけが塊にあり、1 回目には無く、前置き・規則・schema が 1 回目と等しい", async () => {
    // R1 は judged（ruled）、R4 は確率不足で fallback
    const recorded = recordingJudge(
      createFakeJudge({
        [natureQuestionName("R1")]: choice("ruled", 0.95),
        [natureQuestionName("R4")]: choice("ruled", NATURE_JUDGE_THRESHOLD - 0.01),
      }),
    );
    const { outcome, recording } = await run([round1(), round2()], { judge: recorded.judge });
    if (!outcome.ok) throw new Error("通らない");
    expect(outcome.value.rounds).toBe(2);
    expect(recorded.requests).toHaveLength(1);
    const [first, second] = recording.structured;
    if (first === undefined || second === undefined) throw new Error("要求が 2 つ無い");
    expect(dataNamesOf(first.input)).toEqual([...TEST_SPEC_DATA_NAMES]);
    expect(dataNamesOf(second.input)).toEqual([
      ...TEST_SPEC_DATA_NAMES,
      ...TEST_SPEC_RETRY_DATA_NAMES,
      TEST_SPEC_DECIDED_NATURES_DATA_NAME,
    ]);
    expect(second.instructions).toBe(first.instructions);
    expect(second.documents).toEqual(first.documents);
    expect(second.rules).toEqual(first.rules);
    expect(second.schema).toEqual(first.schema);
    expect(second.input.startsWith(first.input)).toBe(true);
    // J2 を呼ばない要件（R2・R3）も、fallback の要件（R4）も塊に無い
    expect(dataBlockOf(second.input, TEST_SPEC_DECIDED_NATURES_DATA_NAME)).toEqual([{ requirementId: "R1", nature: "ruled" }]);
    // fallback の R4 は、評価では今までどおり ruled として扱う
    expect(outcome.value.natures.get("R4")).toBe("ruled");
    expect(outcome.value.discrepancies).toContainEqual({
      requirementId: "R4",
      design: "ruled",
      classified: "existence-only",
      resolved: "ruled",
      resolution: "fallback",
    });
    expectNoAcceptanceMaterial(recording.structured.map(requestText));
  });

  it("判定が失敗した要件・確率が足りなかった要件だけなら塊を足さず、どちらも ruled として扱う（負例）", async () => {
    const judges: readonly Judge[] = [
      createFakeJudge({}), // 答えを用意しない（判定が失敗する）
      createFakeJudge({
        [natureQuestionName("R1")]: choice("existence-only", 0.1),
        [natureQuestionName("R4")]: choice("existence-only", NATURE_JUDGE_THRESHOLD - 0.01),
      }),
    ];
    for (const judge of judges) {
      const { outcome, recording } = await run([round1(), round2()], { judge });
      if (!outcome.ok) throw new Error("通らない");
      const second = recording.structured[1]?.input ?? "";
      expect(dataNamesOf(second)).toEqual([...TEST_SPEC_DATA_NAMES, ...TEST_SPEC_RETRY_DATA_NAMES]);
      expect(second).not.toContain(TEST_SPEC_DECIDED_NATURES_DATA_NAME);
      expect(outcome.value.natures.get("R1")).toBe("ruled");
      expect(outcome.value.natures.get("R4")).toBe("ruled");
    }
  });

  it("判定の口が無い（J2 を呼ばない）なら塊を足さない", async () => {
    const { outcome, recording } = await run([round1(), round2()]);
    if (!outcome.ok) throw new Error("通らない");
    const second = recording.structured[1]?.input ?? "";
    expect(second).not.toContain(TEST_SPEC_DECIDED_NATURES_DATA_NAME);
  });
});

// ── 観測用の口（onDropped・onRejected）──────────────────────────────────

/** 通知の種類・回・試行の並び */
const shapeOf = (seen: readonly RejectedCandidate[]) =>
  seen.map((candidate) => ({ kind: candidate.kind, round: candidate.round, attempt: candidate.attempt }));

describe("onDropped・onRejected は v1 の ②' と同じ回数で呼ばれ、口の有無で要求が変わらない", () => {
  const round1 = () =>
    response([...r1Validate(), r2Execution("r2-exec-1"), ...r2Structure(), ...r3Action(["normal", "abnormal"]), ...r4Compute()]);
  const round2 = () => response([...r1Validate(), r2Execution("r2-exec-2"), ...r2Structure(), ...r3Action(), ...r4Compute()]);
  const invalid = negative({ tests: 123 }, "tests が並びでない応答。strict の schema では出ないが、形の検査の落ちの通知を観測する負例");

  it("v1 の ②' に同じ応答を流したときと、通知の回数・種類・回が等しい", async () => {
    const outputs = [invalid, round1(), round2()];
    const v2Dropped: number[] = [];
    const v2Seen: RejectedCandidate[] = [];
    const t2 = await run(outputs, {
      onDropped: (dropped) => v2Dropped.push(dropped.length),
      onRejected: (candidate) => v2Seen.push(candidate),
    });
    expect(t2.outcome.ok).toBe(true);

    // v1 の ②'：持ち越しを除いた一覧と、A1 の写しの設計を渡す（新契約）
    const table = fixtureTable();
    const pruned = pruneForCarryOver(fixtureList(), table, await carryOverFor(table));
    const v1Dropped: number[] = [];
    const v1Seen: RejectedCandidate[] = [];
    // v1 の ②' の schema（test-suite）は observes の欄を持たない。T2' の応答を v1 に流して通知を比べる試験なので、
    // この v1 側だけは照合なしの client を使う（v1 の段・schema は凍結した比較元）
    const recording = createRecordingClient(outputs.map(structured));
    const v1 = await runTestSuite({
      list: pruned.list,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: pruned.conversion.design,
      plan: fixturePlan(),
      onDropped: (dropped) => v1Dropped.push(dropped.length),
      onRejected: (candidate) => v1Seen.push(candidate),
    });
    expect(v1.ok).toBe(true);

    expect(v2Dropped).toEqual(v1Dropped);
    expect(v2Dropped).toEqual([1, 1]);
    expect(shapeOf(v2Seen)).toEqual(shapeOf(v1Seen));
    expect(shapeOf(v2Seen)).toEqual([
      { kind: "shape", round: 1, attempt: 1 },
      { kind: "content", round: 1, attempt: 2 },
    ]);
    // 中身の候補の対象は、外して種類を書き込んだ後の組（前回の試験と同じ並び）
    const notice = v2Seen[1];
    if (notice?.kind !== "content") throw new Error("中身の通知でない");
    const target = notice.target as TestSuite;
    expect(target.tests.map((test) => test.id)).not.toContain("r2-exec-1");
    const previous = dataBlockOf(t2.recording.structured[2]?.input ?? "", "前回の試験") as readonly { readonly id: string }[];
    expect(target.tests.map((test) => test.id)).toEqual(previous.map((test) => test.id));
    expect(notice.inspectionList.requirements.map((requirement) => requirement.id)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(notice.problems.every((problem) => problem.reference === "target")).toBe(true);
  });

  it("口の有無で、偽物が受け取った要求・結果・回数が同じ", async () => {
    const once = async (hooks: boolean) => {
      const { outcome, recording, gateway } = await run(
        [invalid, round1(), round2()],
        hooks ? { onDropped: () => undefined, onRejected: () => undefined } : {},
      );
      return { requests: JSON.stringify(recording.structured), outcome, counts: gateway.counts };
    };
    const without = await once(false);
    const withHooks = await once(true);
    expect(withHooks).toEqual(without);
  });

  it("2 回で落ちれば中身の通知は 2 回（回 1・2）で、最後の通知の問題が失敗の problems と等しい", async () => {
    const seen: RejectedCandidate[] = [];
    const { outcome } = await run([round1(), round1()], { onRejected: (candidate) => seen.push(candidate) });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(seen.map((candidate) => [candidate.kind, candidate.round])).toEqual([
      ["content", 1],
      ["content", 2],
    ]);
    expect(seen.at(-1)?.problems.map(({ reference: _reference, ...problem }) => problem)).toEqual(outcome.failure.problems);
  });
});

// ── 既定値の要件（default-value。Issue #533）─────────────────────────────

describe.each(LEDGER_CASES)("既定値の要件：表の確かめ方が default-value の要件にだけ既定値の試験を許す（Issue #533。旗 $name）", ({ ledger }) => {
  /** 旗 on の走りは期待が真偽の R3 の操作の試験、off は今までの数の期待（Issue #550） */
  const r3For = ledger === undefined ? r3Action : r3When;
  const { run, checkTestSpecOutput, defaultValueTargetsOf, exemptDefaultValueProblems } = ledgerFunctions(ledger);
  const ruleDefinitions = ledgerFunctions(ledger).ruleDefinitions;
  const rules = ruleTexts(ruleDefinitions);
  const DLIST = fixtureDefaultValueList();
  const DPLAN = fixturePlan(DLIST);
  const DTABLE = fixtureDefaultValueTable();
  /** 持ち越しを除いた一覧での R6 の位置（R5 は unresolved で持ち越し） */
  const R6_AT = "requirements[4]";
  /** 組の中の R6 の既定値の試験の位置（R1 3 本・R2 1 本・R3 3 本・R4 3 本のあと） */
  const T_AT = "tests[10]";
  const UNSUPPORTED =
    "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態の試験は作らない）";

  /** 持ち越し（R5 は表の unresolved。`rejected` は表の意味の点検の拒否） */
  async function carryFor(table: NameTable, rejected: readonly string[] = []): Promise<CarryOver> {
    const tableSha256 = await nameTableSha256(table);
    const targets = table.verification.filter((entry) => entry.kind !== "unresolved").map((entry) => entry.requirementId);
    return deriveCarryOver({
      list: DLIST,
      table,
      semanticCheck: {
        tableSha256,
        judgments: targets.map((requirementId) =>
          rejected.includes(requirementId)
            ? { requirementId, verdict: "reject" as const, kind: "weak-verification", quote: "alpha" }
            : { requirementId, verdict: "accept" as const },
        ),
      },
    });
  }

  /** 既定値の試験（正しい形：normal・validate・default-value・期待 ok の JSON の文字列・入力が空・参照データが空） */
  const r6Default = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "r6-default",
    target: { requirementId: "R6", kind: "field", roleId: "f.item.kind" },
    kind: "normal",
    operation: "validate",
    clock: "2026-09-16T12:00:00+09:00",
    input: "{}",
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: JSON.stringify("alpha"), code: null },
    assertion: null,
    observes: "default-value",
    ...patch,
  });
  const D_NATURES: readonly NatureRow[] = [...T1_NATURES, { requirementId: "R6", nature: "ruled" }];
  const others = (r3 = r3For()) => [...r1Validate(), ...r2Structure(), ...r3, ...r4Compute()];
  const dResponse = (r6: readonly Record<string, unknown>[] = [r6Default()], natures: readonly NatureRow[] = D_NATURES, r3 = r3For()) =>
    response([...others(r3), ...r6], natures);

  async function runD(outputs: readonly unknown[], options: { table?: NameTable; judge?: Judge; rejected?: readonly string[] } = {}) {
    const table = options.table ?? DTABLE;
    return run(outputs, {
      plan: DPLAN,
      list: DLIST,
      table,
      carryOver: await carryFor(table, options.rejected),
      ...(options.judge === undefined ? {} : { judge: options.judge }),
    });
  }

  /** 2 回とも落として、最後の問題を返す */
  async function problemsOf(bad: unknown, table?: NameTable) {
    const { outcome } = await runD([bad, bad], table === undefined ? {} : { table });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.attempts).toBe(TEST_SPEC_ROUNDS);
    return outcome.failure.problems;
  }

  const fixedTestTable = (): NameTable => ({
    ...DTABLE,
    verification: DTABLE.verification.map((entry) => (entry.requirementId === "R6" ? { requirementId: "R6", kind: "fixed-test" as const } : entry)),
  });

  it("(1) 二点測定の正の側：既定値の試験を 1 本だけ書いた応答が 1 回で通り、網羅の単位にその試験の単位がある", async () => {
    const { outcome, recording } = await runD([dResponse()]);
    if (!outcome.ok) throw new Error(`通るはず: ${JSON.stringify(outcome.failure)}`);
    expect(recording.structured).toHaveLength(1);
    expect(outcome.value.observes.get("r6-default")).toBe("default-value");
    expect(outcome.value.natures.get("R6")).toBe("ruled");
    const key = canonicalJson({
      basis: "value",
      requirementId: "R6",
      targetId: "f.item.kind",
      kind: "normal",
      operation: "validate",
      observes: "default-value",
    });
    expect(outcome.value.coverage).toContainEqual({ requirementId: "R6", targetId: "f.item.kind", key });
    // 既定値の要件の単位はこの 1 つだけ（異常・境界の単位は無い）
    expect(outcome.value.coverage.filter((unit) => unit.requirementId === "R6")).toHaveLength(1);
    expect(outcome.value.coverage).toEqual(
      coverageUnitsOf({ suite: outcome.value.suite, observes: outcome.value.observes, natures: outcome.value.natures }),
    );
  });

  it("(2) 負例：確かめ方が fixed-test の要件に既定値の試験を作ると固定文で落ち、異常・境界の不足も免除されない", async () => {
    const problems = await problemsOf(dResponse(), fixedTestTable());
    expect(problems).toContainEqual({ field: `${T_AT}.observes`, message: DEFAULT_VALUE_NOT_ALLOWED_MESSAGE });
    expect(problems).toContainEqual({ field: R6_AT, message: "abnormal の試験が無い" });
    expect(problems).toContainEqual({ field: R6_AT, message: "boundary の試験が無い" });
  });

  it("(2) 負例：既定値の要件の試験を省くと「要件の試験が無い」で落ちる（免除は試験の有無で決めない）", async () => {
    const problems = await problemsOf(dResponse([]));
    expect(problems).toEqual([{ field: R6_AT, message: "要件の試験が無い" }]);
  });

  it("(2) 負例：観測が validation の normal だけは固定文で落ちる", async () => {
    expect(await problemsOf(dResponse([r6Default({ observes: "validation" })]))).toEqual([
      { field: `${T_AT}.observes`, message: DEFAULT_VALUE_TEST_MESSAGES.observes },
    ]);
  });

  it("(2) 負例：abnormal の試験は固定文で落ちる", async () => {
    const problems = await problemsOf(
      dResponse([r6Default(), r6Default({ id: "r6-abnormal", kind: "abnormal", expected: { kind: "error", value: null, code: "E_INVALID" } })]),
    );
    expect(problems).toContainEqual({ field: "tests[11].kind", message: DEFAULT_VALUE_TEST_MESSAGES.kind });
    expect(problems).toContainEqual({ field: "tests[11].expected", message: DEFAULT_VALUE_TEST_MESSAGES.expected });
  });

  it("(2) 負例：期待が value と違う・文字列でない（引用符の無い値・数）・kind が error は固定文で落ちる", async () => {
    for (const expected of [
      { kind: "ok", value: JSON.stringify("beta"), code: null },
      { kind: "ok", value: "alpha", code: null },
      { kind: "ok", value: "1", code: null },
      { kind: "ok", value: "null", code: null },
      { kind: "error", value: null, code: "E_INVALID" },
    ]) {
      expect(await problemsOf(dResponse([r6Default({ expected })])), JSON.stringify(expected)).toEqual([
        { field: `${T_AT}.expected`, message: DEFAULT_VALUE_TEST_MESSAGES.expected },
      ]);
    }
  });

  it("(2) 負例：入力が空でないと固定文で落ちる", async () => {
    expect(await problemsOf(dResponse([r6Default({ input: JSON.stringify({ "f.item.kind": "beta" }) })]))).toEqual([
      { field: `${T_AT}.input`, message: DEFAULT_VALUE_TEST_MESSAGES.input },
    ]);
  });

  it("(2) 負例：ほかの条件を満たし参照データだけが 1 行ある試験は、参照データの固定文だけで落ちる", async () => {
    const referenceData = [{ target: { requirementId: "R6", kind: "entity", roleId: "e.item" }, rowId: "item-1", values: "{}" }];
    expect(await problemsOf(dResponse([r6Default({ referenceData })]))).toEqual([
      { field: `${T_AT}.referenceData`, message: DEFAULT_VALUE_TEST_MESSAGES.referenceData },
    ]);
  });

  it("(2) 負例：state-after-set は今までどおり未対応の固定文で落ちる", async () => {
    const problems = await problemsOf(dResponse([r6Default({ observes: "state-after-set" })]));
    expect(problems).toContainEqual({ field: `${T_AT}.observes`, message: UNSUPPORTED });
    expect(problems).toContainEqual({ field: `${T_AT}.observes`, message: DEFAULT_VALUE_TEST_MESSAGES.observes });
  });

  it("(2) 負例：ほかの ruled の要件の異常・境界の不足は免除が漏れずに落ちる", async () => {
    expect(await problemsOf(dResponse([r6Default()], D_NATURES, r3For(["normal"])))).toEqual([
      { field: "requirements[2]", message: "abnormal の試験が無い" },
      { field: "requirements[2]", message: "boundary の試験が無い" },
    ]);
  });

  it("(2) 負例：既定値の試験を別の項目（validate の正しい組）に向けても落ちる", async () => {
    const problems = await problemsOf(dResponse([r6Default({ target: { requirementId: "R6", kind: "field", roleId: "f.item.amount" } })]));
    expect(problems).toContainEqual({ field: `${T_AT}.observes`, message: DEFAULT_VALUE_NOT_ALLOWED_MESSAGE });
    expect(problems).toContainEqual({ field: `${T_AT}.target`, message: DEFAULT_VALUE_TEST_MESSAGES.target });
  });

  // ── (3) 除外の範囲 ─────────────────────────────────────────────

  async function planned(table: NameTable = DTABLE, rejected: readonly string[] = []) {
    const pruned = pruneForCarryOver(DLIST, table, await carryFor(table, rejected));
    return { pruned, design: pruned.conversion.design, defaults: defaultValueTargetsOf(pruned.table) };
  }
  const suiteOf = (output: unknown): TestSuite => {
    const checked = checkTestSpecOutput(output);
    if (!checked.ok) throw new Error("形が通るはず");
    return checked.value.suite;
  };
  const key = (problem: Problem) => `${problem.field}\u0000${problem.message}`;
  const minus = (a: readonly Problem[], b: readonly Problem[]) => {
    const kept = new Set(b.map(key));
    return a.filter((problem) => !kept.has(key(problem)));
  };

  it("(3) v1 の checkSuitePlan の出力と除外後の出力の差は、既定値の要件の位置の abnormal・boundary の不足の 2 件だけ", async () => {
    const { pruned, design, defaults } = await planned();
    const suite = suiteOf(dResponse());
    const raw = checkSuitePlan(pruned.list, suite, design, reconcileNatures(design, suite.classifications).natures);
    const exempted = exemptDefaultValueProblems(raw, pruned.list, defaults);
    expect(minus(raw, exempted)).toEqual([
      { field: R6_AT, message: "abnormal の試験が無い" },
      { field: R6_AT, message: "boundary の試験が無い" },
    ]);
    expect(exempted).toEqual([]);
    expect(DEFAULT_VALUE_EXEMPT_MESSAGES).toEqual(["abnormal の試験が無い", "boundary の試験が無い"]);
  });

  it("(3) 部分一致の文・別の位置・別の文・持ち越しで除かれた要件の位置の問題は外れない", async () => {
    const { pruned, defaults } = await planned();
    const kept: readonly Problem[] = [
      { field: R6_AT, message: "abnormal の試験が無い（追記）" },
      { field: R6_AT, message: " boundary の試験が無い" },
      { field: R6_AT, message: "normal の試験が無い" },
      { field: R6_AT, message: "要件の試験が無い" },
      { field: "requirements[3]", message: "abnormal の試験が無い" },
      { field: `${R6_AT}.kind`, message: "boundary の試験が無い" },
      { field: T_AT, message: "abnormal の試験が無い" },
    ];
    expect(exemptDefaultValueProblems(kept, pruned.list, defaults)).toEqual(kept);
    // R6 が持ち越し（表の意味の点検の拒否）なら、除いた表に既定値の要件は無く、何も外れない
    const carried = await planned(DTABLE, ["R6"]);
    expect(carried.defaults.size).toBe(0);
    const atCarried: readonly Problem[] = [
      { field: "requirements[5]", message: "abnormal の試験が無い" },
      { field: R6_AT, message: "boundary の試験が無い" },
    ];
    expect(exemptDefaultValueProblems(atCarried, DLIST, carried.defaults)).toEqual(atCarried);
    expect(exemptDefaultValueProblems(atCarried, carried.pruned.list, carried.defaults)).toEqual(atCarried);
  });

  it("(3) selector の食い違い・上限・空の組の問題は除外のあとも今までどおり出る", async () => {
    const { pruned, design, defaults } = await planned();
    const natures = new Map(pruned.list.requirements.map((requirement) => [requirement.id, "ruled" as const] as const));
    const check = (output: unknown) =>
      exemptDefaultValueProblems(checkSuitePlan(pruned.list, suiteOf(output), design, natures), pruned.list, defaults);
    // 空の組
    const empty = check(response([], D_NATURES));
    expect(empty).toContainEqual({ field: "tests", message: "試験の集合が空である" });
    expect(empty).toContainEqual({ field: R6_AT, message: "要件の試験が無い" });
    // 上限（要件ごとの試験の数）
    const many = Array.from({ length: 17 }, (_, index) => r6Default({ id: `r6-${index}` }));
    expect(check(dResponse(many))).toContainEqual({ field: R6_AT, message: "要件の試験が上限 16 を超えている（17）" });
    // selector の食い違い（同じ要件と役割 ID で対象の種類が違う）
    const conflict = check(dResponse([r6Default(), r6Default({ id: "r6-other", target: { requirementId: "R6", kind: "entity", roleId: "f.item.kind" } })]));
    expect(conflict).toContainEqual({
      field: "tests[11].target",
      message: "selector（要件 ID と役割 ID）が一意に決まらない（対象の種類が食い違う）",
    });
  });

  // ── (4) 分類 ───────────────────────────────────────────────────

  it("(4) default-value の要件の分類が食い違っても判定を呼ばず（要求 0）ruled で採り、記録は fallback", async () => {
    const recorded = recordingJudge(createFakeJudge({}));
    const natures = D_NATURES.map((entry) => (entry.requirementId === "R6" ? { requirementId: "R6", nature: "existence-only" as const } : entry));
    const { outcome } = await runD([dResponse([r6Default()], natures)], { judge: recorded.judge });
    if (!outcome.ok) throw new Error(`通るはず: ${JSON.stringify(outcome.failure)}`);
    expect(recorded.requests).toHaveLength(0);
    expect(outcome.value.natures.get("R6")).toBe("ruled");
    expect(outcome.value.discrepancies).toEqual([
      { requirementId: "R6", design: "ruled", classified: "existence-only", resolved: "ruled", resolution: "fallback" },
    ]);
  });

  it("(4) ほかの要件の食い違いは今までどおり判定に聞き、既定値の要件は問いに入らない", async () => {
    const recorded = recordingJudge(createFakeJudge({ [natureQuestionName("R4")]: choice("ruled", 0.9) }));
    const natures = D_NATURES.map((entry) =>
      entry.requirementId === "R6" || entry.requirementId === "R4" ? { ...entry, nature: "existence-only" as const } : entry,
    );
    const { outcome } = await runD([dResponse([r6Default()], natures)], { judge: recorded.judge });
    if (!outcome.ok) throw new Error(`通るはず: ${JSON.stringify(outcome.failure)}`);
    expect(recorded.requests).toHaveLength(1);
    expect(Object.keys(recorded.requests[0]?.questions ?? {})).toEqual([natureQuestionName("R4")]);
    expect(outcome.value.discrepancies.find((entry) => entry.requirementId === "R6")?.resolution).toBe("fallback");
    expect(outcome.value.discrepancies.find((entry) => entry.requirementId === "R4")?.resolution).toBe("judged");
  });

  // ── (5) データ ─────────────────────────────────────────────────

  it("(5) 「要件ごとの確かめ方」に default-value の要件だけ value があり、ほかの項目・前置き・規則の並びが今までと同じ", async () => {
    const { recording } = await runD([dResponse()]);
    const base = await run([passing(r3For())]);
    const request = recording.structured[0]!;
    const baseRequest = base.recording.structured[0]!;
    expect(dataNamesOf(request.input)).toEqual([...TEST_SPEC_DATA_NAMES]);
    const verification = dataBlockOf(request.input, "要件ごとの確かめ方") as readonly Record<string, unknown>[];
    expect(verification.find((entry) => entry["requirementId"] === "R6")).toEqual({
      requirementId: "R6",
      verificationKind: "default-value",
      checks: [],
      value: "alpha",
    });
    expect(verification.filter((entry) => "value" in entry).map((entry) => entry["requirementId"])).toEqual(["R6"]);
    // ほかの要件の項目は、既定値の要件の無い走りの塊と同じ
    expect(verification.filter((entry) => entry["requirementId"] !== "R6")).toEqual(dataBlockOf(baseRequest.input, "要件ごとの確かめ方"));
    for (const field of ["instructions", "rules", "documents", "schemaName", "schema", "maxOutputTokens"] as const) {
      expect(request[field]).toEqual(baseRequest[field]);
    }
    expect(request.rules).toEqual(rules);
    expectNoAcceptanceMaterial([requestText(request)]);
  });

  it("旗 on（手 2a の台帳）と off で、同じ応答の要求（前置き・規則・データ・schema）と結果が深く等しい。#548 の台帳の on は要求の差が enum-membership の行の分だけ、今の台帳はさらに empty-aggregate の行の分だけ（1 回で通る・作り直す・判定に聞く）", async () => {
    const recorded = () => recordingJudge(createFakeJudge({ [natureQuestionName("R4")]: choice("ruled", 0.9) }));
    const natures = D_NATURES.map((entry) => (entry.requirementId === "R4" ? { ...entry, nature: "existence-only" as const } : entry));
    // 今の台帳の on とも同じ応答で比べるので、R3 は期待が真偽の操作の試験（off の結果も同じ。Issue #550）
    const dWhen = (r6: readonly Record<string, unknown>[] = [r6Default()], dNatures: readonly NatureRow[] = D_NATURES) => dResponse(r6, dNatures, r3When());
    const scenarios: readonly (readonly unknown[])[] = [
      [dWhen()],
      [dWhen([r6Default({ observes: "validation" })]), dWhen()],
      [dWhen([r6Default()], natures)],
      [dWhen([r6Default({ kind: "abnormal" })]), dWhen([r6Default({ kind: "abnormal" })])],
    ];
    for (const outputs of scenarios) {
      const runFor = async (view: LedgerView | undefined) => {
        const judge = recorded();
        const table = DTABLE;
        const result = await ledgerFunctions(view).run(outputs, {
          plan: DPLAN,
          list: DLIST,
          table,
          carryOver: await carryFor(table),
          judge: judge.judge,
        });
        return { ...result, judgeRequests: judge.requests };
      };
      const off = await runFor(undefined);
      const on = await runFor(LEDGER_VIEW_2A);
      expect(JSON.stringify(on.recording.structured)).toBe(JSON.stringify(off.recording.structured));
      expect(on.outcome).toEqual(off.outcome);
      expect(on.judgeRequests).toEqual(off.judgeRequests);
      expect(on.gateway.counts).toEqual(off.gateway.counts);
      // #548 の台帳（Issue #548）：要求の差は名指しの場所だけで、その分を除けばバイト列で同じ。結果・判定・呼び出し数は同じ
      const twoB = await runFor(LEDGER_VIEW_2B);
      const twoBRequests = JSON.parse(JSON.stringify(twoB.recording.structured)) as unknown[];
      const offRequests = JSON.parse(JSON.stringify(off.recording.structured)) as unknown[];
      for (const diff of requestDiffsOf(twoBRequests, offRequests)) expect(diff.paths).toEqual(ENUM_MEMBERSHIP_REQUEST_DIFF[TEST_SPEC_SCHEMA_NAME]);
      expect(JSON.stringify(withoutEnumMembership(twoBRequests))).toBe(JSON.stringify(offRequests));
      expect(twoB.outcome).toEqual(off.outcome);
      expect(twoB.judgeRequests).toEqual(off.judgeRequests);
      expect(twoB.gateway.counts).toEqual(off.gateway.counts);
      // #549 の台帳（Issue #549）：#548 の台帳との差は empty-aggregate の行の分（R-tsp-16 の文・observes の enum）だけ。
      // 表の計算の行は集計の種類と集計元を持たない（型付きの表）ので、データは同じ。結果・判定・呼び出し数は同じ
      const full = await runFor(LEDGER_VIEW_2C);
      const fullRequests = JSON.parse(JSON.stringify(full.recording.structured)) as unknown[];
      for (const diff of requestDiffsOf(fullRequests, twoBRequests)) expect(diff.paths).toEqual(EMPTY_AGGREGATE_REQUEST_DIFF[TEST_SPEC_SCHEMA_NAME]);
      expect(JSON.stringify(withoutEmptyAggregate(fullRequests))).toBe(JSON.stringify(twoBRequests));
      expect(full.outcome).toEqual(off.outcome);
      expect(full.judgeRequests).toEqual(off.judgeRequests);
      expect(full.gateway.counts).toEqual(off.gateway.counts);
      // 今の台帳（Issue #550）：#549 の台帳との差は when の行の分（R-tsp-16 の文）だけ。non-requirement は T2 の要求に出ない。
      // 結果・判定・呼び出し数は同じ
      const now = await runFor(PROPERTY_LEDGER_VIEW);
      const nowRequests = JSON.parse(JSON.stringify(now.recording.structured)) as unknown[];
      for (const diff of requestDiffsOf(nowRequests, fullRequests)) expect(diff.paths).toEqual(WHEN_NON_REQUIREMENT_REQUEST_DIFF[TEST_SPEC_SCHEMA_NAME]);
      expect(JSON.stringify(withoutWhenAndNonRequirement(nowRequests))).toBe(JSON.stringify(fullRequests));
      expect(now.outcome).toEqual(off.outcome);
      expect(now.judgeRequests).toEqual(off.judgeRequests);
      expect(now.gateway.counts).toEqual(off.gateway.counts);
    }
  });

  it("規則：R-tsp-02 は default-value の要件を除き、R-tsp-16 は default-value の要件にだけ既定値の試験の形を許す", () => {
    const text = (id: string) => ruleDefinitions.find((definition) => definition.id === id)?.text ?? "";
    // 旗 on は台帳の enum-membership（Issue #548）も除く
    expect(text("R-tsp-02")).toContain(`確かめ方が structural・default-value${ledger === undefined ? "" : "・enum-membership"} の要件を除いて`);
    const r16 = text("R-tsp-16");
    expect(r16).toContain("確かめ方が default-value の要件にだけ");
    expect(r16).toContain("その要件には異常・境界の試験を作らない");
    expect(r16).toContain("ほかの要件に default-value を書かない");
    expect(r16).toContain("state-after-set）は評価できないので、その試験は作らない");
    expect(ruleDefinitionDefects(ruleDefinitions)).toEqual([]);
    expectNoAcceptanceMaterial(rules);
  });
});

// ── 旗 on（性質の台帳から導く。Issue #547）──────────────────────────────

describe("旗 on：手 2a の台帳（enum-membership の行を除いた導出）なら T2 の規則の文・schema が off とバイト列で同じ（載せ替えだけ。Issue #547・#548）", () => {
  it("規則の定義は off の定数と深く等しく、送る文の並び・schema の JSON がバイト列で同じ。規則の不備は on・off とも 0", () => {
    const definitions = testSpecRuleDefinitionsOf(LEDGER_VIEW_2A);
    expect(definitions).toEqual(TEST_SPEC_RULE_DEFINITIONS);
    expect(JSON.stringify(ruleTexts(definitions))).toBe(JSON.stringify(TEST_SPEC_RULES));
    expect(JSON.stringify(testSpecSchemaOf(LEDGER_VIEW_2A))).toBe(JSON.stringify(TEST_SPEC_SCHEMA));
    expect(ruleDefinitionDefects(definitions)).toEqual([]);
    expect(ruleDefinitionDefects(TEST_SPEC_RULE_DEFINITIONS)).toEqual([]);
    expect(testSpecRuleDefinitionsOf()).toBe(TEST_SPEC_RULE_DEFINITIONS);
    expect(testSpecSchemaOf()).toBe(TEST_SPEC_SCHEMA);
  });

  it("二点測定：台帳の形の文・除外の種類・observes の並びを変えると、組んだ規則と schema が off と食い違う", () => {
    const text = (view: LedgerView, id: string) => testSpecRuleDefinitionsOf(view).find((definition) => definition.id === id)?.text;
    const offText = (id: string) => TEST_SPEC_RULE_DEFINITIONS.find((definition) => definition.id === id)?.text;
    expect(text(LEDGER_VIEW_2A, "R-tsp-02")).toBe(offText("R-tsp-02"));
    expect(text(LEDGER_VIEW_2A, "R-tsp-16")).toBe(offText("R-tsp-16"));
    expect(text({ ...LEDGER_VIEW_2A, t2ExemptKinds: [] }, "R-tsp-02")).not.toBe(offText("R-tsp-02"));
    expect(text({ ...LEDGER_VIEW_2A, t2FormTexts: [] }, "R-tsp-16")).not.toBe(offText("R-tsp-16"));
    expect(text({ ...LEDGER_VIEW_2A, t2UnsupportedTexts: [] }, "R-tsp-16")).not.toBe(offText("R-tsp-16"));
    const [first = "", second = "", ...rest] = LEDGER_VIEW_2A.observes;
    const reversed = { ...LEDGER_VIEW_2A, observes: [second, first, ...rest] };
    expect(JSON.stringify(testSpecSchemaOf(reversed))).not.toBe(JSON.stringify(TEST_SPEC_SCHEMA));
  });
});

describe("旗 on：#548 の台帳（empty-aggregate の行を除いた導出）の T2 の規則・schema と off の差は enum-membership の行の分（R-tsp-02 の除外・R-tsp-16 の形の 1 文・observes の enum）だけ（Issue #548・#549）", () => {
  it("R-tsp-02 の除外に enum-membership が入り、R-tsp-16 に形の 1 文が default-value の文の次に入る。ほかの定義・schema の位置は off と同じで、規則の不備は 0", () => {
    const row = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership");
    const anchor = PROPERTY_LEDGER.find((entry) => entry.id === "default-value")?.rules.t2;
    if (row?.rules.t2 == null || anchor == null) throw new Error("前提が壊れた");
    const definitions = testSpecRuleDefinitionsOf(LEDGER_VIEW_2B);
    const text = (id: string) => definitions.find((definition) => definition.id === id)?.text ?? "";
    const offText = (id: string) => TEST_SPEC_RULE_DEFINITIONS.find((definition) => definition.id === id)?.text ?? "";
    expect(text("R-tsp-02")).toBe(offText("R-tsp-02").replace("structural・default-value の要件", "structural・default-value・enum-membership の要件"));
    expect(text("R-tsp-16")).toBe(offText("R-tsp-16").replace(anchor, `${anchor}${row.rules.t2}`));
    expect(text("R-tsp-16")).toContain("k1・k2");
    expect(definitions.filter((definition) => !["R-tsp-02", "R-tsp-16"].includes(definition.id))).toEqual(
      TEST_SPEC_RULE_DEFINITIONS.filter((definition) => !["R-tsp-02", "R-tsp-16"].includes(definition.id)),
    );
    expect(ruleDefinitionDefects(definitions)).toEqual([]);
    expect(jsonDiffPaths(testSpecSchemaOf(LEDGER_VIEW_2B), TEST_SPEC_SCHEMA)).toEqual(["$.properties.tests.items.properties.observes.enum"]);
    expect(testSpecSchemaOf(LEDGER_VIEW_2B).properties.tests.items.properties.observes.enum).toEqual([...TEST_OBSERVES, "enum-membership"]);
    expectNoAcceptanceMaterial(ruleTexts(definitions));
  });
});

describe("旗 on：#549 の台帳の T2 の規則・schema と #548 の台帳の差は empty-aggregate の行の分（R-tsp-16 の形の 1 文・observes の enum）だけ（Issue #549）", () => {
  it("R-tsp-16 に形の 1 文が enum-membership の文の次に入り、observes の enum の末尾に empty-aggregate が入る。R-tsp-02 の除外は変わらない（免除は無い）。規則の不備は 0", () => {
    const row = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate");
    const anchor = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership")?.rules.t2;
    if (row?.rules.t2 == null || anchor == null) throw new Error("前提が壊れた");
    const definitions = testSpecRuleDefinitionsOf(LEDGER_VIEW_2C);
    const before = testSpecRuleDefinitionsOf(LEDGER_VIEW_2B);
    expect(definitions).toEqual(
      before.map((definition) =>
        definition.id === "R-tsp-16" ? { ...definition, text: definition.text.replace(anchor, `${anchor}${row.rules.t2 ?? ""}`) } : definition,
      ),
    );
    expect(ruleDefinitionDefects(definitions)).toEqual([]);
    expect(jsonDiffPaths(testSpecSchemaOf(LEDGER_VIEW_2C), testSpecSchemaOf(LEDGER_VIEW_2B))).toEqual(["$.properties.tests.items.properties.observes.enum"]);
    expect(testSpecSchemaOf(LEDGER_VIEW_2C).properties.tests.items.properties.observes.enum).toEqual([...TEST_OBSERVES, "enum-membership", "empty-aggregate"]);
    expect(withoutEmptyAggregate(testSpecSchemaOf(LEDGER_VIEW_2C))).toEqual(testSpecSchemaOf(LEDGER_VIEW_2B));
    expectNoAcceptanceMaterial(ruleTexts(definitions));
  });
});

describe("旗 on：今の台帳の T2 の規則・schema と #549 の台帳の差は when の行の分（R-tsp-16 の 1 文）だけ（Issue #550）", () => {
  it("R-tsp-16 の台帳の文の頭に when の 1 文が入り、observes の enum は変わらない（non-requirement は試験を作らない）。R-tsp-02 の除外は変わらない。規則の不備は 0", () => {
    const whenText = PROPERTY_LEDGER.find((entry) => entry.id === "when")?.rules.t2;
    const anchor = PROPERTY_LEDGER.find((entry) => entry.id === "default-value")?.rules.t2;
    if (whenText == null || anchor == null) throw new Error("前提が壊れた");
    const definitions = testSpecRuleDefinitionsOf(PROPERTY_LEDGER_VIEW);
    const before = testSpecRuleDefinitionsOf(LEDGER_VIEW_2C);
    expect(definitions).toEqual(
      before.map((definition) =>
        definition.id === "R-tsp-16" ? { ...definition, text: definition.text.replace(anchor, `${whenText}${anchor}`) } : definition,
      ),
    );
    expect(ruleDefinitionDefects(definitions)).toEqual([]);
    expect(JSON.stringify(testSpecSchemaOf(PROPERTY_LEDGER_VIEW))).toBe(JSON.stringify(testSpecSchemaOf(LEDGER_VIEW_2C)));
    expect(testSpecSchemaOf(PROPERTY_LEDGER_VIEW).properties.tests.items.properties.observes.enum).not.toContain("non-requirement");
    const r16 = definitions.find((definition) => definition.id === "R-tsp-16")?.text ?? "";
    expect(r16).toContain("value を true");
    expect(r16).toContain("操作後の状態（写像・文字列・数）を期待に書かない");
    expect(r16).toContain("action の試験を作らない");
    expectNoAcceptanceMaterial(ruleTexts(definitions));
  });
});

describe("旗 on：T2' に台帳に無い観測する性質を直接渡すと固定文で落ちる（未登録の性質の拒否）", () => {
  // empty-aggregate は手 2c（Issue #549）で登録した。#548 の台帳では台帳に無い性質として落ちる（下の二点測定）
  const unregistered = ["no-such-property", "other"] as const;

  it("評価可能性：台帳に無い性質は、どの組でも台帳の固定文で落ちる（値を埋めない）。台帳にある性質は off と同じ結果", () => {
    for (const targetKind of TEST_TARGET_KINDS) {
      for (const operation of TEST_OPERATIONS) {
        const test = bareTest("t", targetKind, operation, operation === "structure" ? "view-shows" : undefined);
        for (const observed of unregistered) {
          const problems = checkEvaluabilityByLedger({ tests: [test] }, new Map([["t", observed as TestObserves]]), fixtureTable(), PROPERTY_LEDGER_VIEW);
          expect(problems).toEqual([{ field: "tests[0].observes", message: LEDGER_UNREGISTERED_OBSERVES_MESSAGE }]);
          expect(LEDGER_UNREGISTERED_OBSERVES_MESSAGE).not.toContain(observed);
          // off でも落ちる（別の固定文）。on は台帳に無いことを名指しする
          expect(checkEvaluability({ tests: [test] }, new Map([["t", observed as TestObserves]]), fixtureTable())).toHaveLength(1);
        }
        for (const observed of TEST_OBSERVES) {
          const observes = new Map([["t", observed]]);
          expect(checkEvaluabilityByLedger({ tests: [test] }, observes, fixtureTable(), PROPERTY_LEDGER_VIEW)).toEqual(
            checkEvaluability({ tests: [test] }, observes, fixtureTable()),
          );
        }
        // 二点測定（Issue #549）：empty-aggregate は #548 の台帳では台帳に無い性質で落ち、今の台帳では組が合えば台帳の組に照らす
        const emptyAggregate = new Map([["t", "empty-aggregate" as TestObserves]]);
        expect(checkEvaluabilityByLedger({ tests: [test] }, emptyAggregate, fixtureTable(), LEDGER_VIEW_2B)).toEqual([
          { field: "tests[0].observes", message: LEDGER_UNREGISTERED_OBSERVES_MESSAGE },
        ]);
        const listed = targetKind === "computation" && operation === "aggregate";
        expect(checkEvaluabilityByLedger({ tests: [test] }, emptyAggregate, fixtureTable(), PROPERTY_LEDGER_VIEW).length, `${targetKind} ${operation}`).toBe(
          listed ? 0 : 1,
        );
      }
    }
  });

  it("形の検査：schema の enum を迂回した応答の台帳に無い性質は、on でも固定文で落ちる（知っている値は台帳の順。手 2a の台帳なら off と同じ）", () => {
    for (const observed of ["enum-membership", "no-such-property"]) {
      const output = response([...r1Validate(), ...r2Structure(), ...r3When(), ...r4Compute()].map((test, index) => (index === 0 ? { ...test, observes: observed } : test)));
      const checked = checkTestSpecOutputOf(output, LEDGER_VIEW_2A);
      expect(checked).toEqual(checkTestSpecOutputOf(output));
      expect(checked.ok).toBe(false);
      if (checked.ok) return;
      expect(checked.problems).toEqual([
        { field: "tests[0].observes", message: `観測する性質は ${LEDGER_VIEW_2A.observes.join("・")} のいずれかであること` },
      ]);
    }
    // 今の台帳：enum-membership は登録済みで形を通り、台帳に無い性質は今の台帳の並びの固定文で落ちる
    const output = response([...r1Validate(), ...r2Structure(), ...r3When(), ...r4Compute()].map((test, index) => (index === 0 ? { ...test, observes: "no-such-property" } : test)));
    const checked = checkTestSpecOutputOf(output, PROPERTY_LEDGER_VIEW);
    expect(checked).toEqual({
      ok: false,
      problems: [{ field: "tests[0].observes", message: `観測する性質は ${PROPERTY_LEDGER_VIEW.observes.join("・")} のいずれかであること` }],
    });
    expect(withoutEnumMembership(withoutEmptyAggregate(checked))).toEqual(checkTestSpecOutputOf(output));
  });

  it("段：台帳に無い性質を書いた応答は on でも 2 回とも形で落ち、malformed（やり直しの回数は今と同じ）", async () => {
    for (const [view, observed] of [
      [LEDGER_VIEW_2A, "enum-membership"],
      [PROPERTY_LEDGER_VIEW, "no-such-property"],
    ] as const) {
      const bad = negative(
        response([...r1Validate(), ...r2Structure(), ...r3When(), ...r4Compute()].map((test) => ({ ...test, observes: observed }))),
        "台帳に無い性質を書いた応答。その台帳から導いた schema の observes の enum に無いので strict では出ないが、段の未登録の拒否を観測する負例",
      );
      const { outcome, recording } = await ledgerFunctions(view).run([bad, bad]);
      if (outcome.ok || outcome.failure.kind !== "malformed") throw new Error("malformed でない");
      expect(recording.structured).toHaveLength(2);
    }
  });
});

// ── 選択肢の集合 enum-membership（旗 on。Issue #548）──────────────────────────────

describe("旗 on：選択肢の集合の要件は、表の確かめ方が enum-membership の要件にだけ選択肢の集合の試験を許す（Issue #548）", () => {
  const ROW = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership");
  if (ROW?.t2 == null) throw new Error("前提が壊れた：台帳に enum-membership の試験の型が無い");
  const MESSAGES = ROW.t2.messages;
  const { run: runOn, checkTestSpecOutput, defaultValueTargetsOf: ledgerTargets, exemptDefaultValueProblems: exempt } =
    ledgerFunctions(PROPERTY_LEDGER_VIEW);
  const ELIST = fixtureEnumMembershipList();
  const EPLAN = fixturePlan(ELIST);
  const ETABLE = fixtureEnumMembershipTable();
  const R6_AT = "requirements[4]";
  const T_AT = "tests[10]";

  async function carryFor(table: NameTable, rejected: readonly string[] = []): Promise<CarryOver> {
    const tableSha256 = await nameTableSha256(table);
    const targets = table.verification.filter((entry) => entry.kind !== "unresolved").map((entry) => entry.requirementId);
    return deriveCarryOver({
      list: ELIST,
      table,
      semanticCheck: {
        tableSha256,
        judgments: targets.map((requirementId) =>
          rejected.includes(requirementId)
            ? { requirementId, verdict: "reject" as const, kind: "weak-verification", quote: "alpha" }
            : { requirementId, verdict: "accept" as const },
        ),
      },
    });
  }

  /** 選択肢の集合の試験（正しい形：normal・validate・enum-membership・期待 ok の options の並びの JSON・入力が空・参照データが空） */
  const r6Enum = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "r6-enum",
    target: { requirementId: "R6", kind: "field", roleId: "f.item.kind" },
    kind: "normal",
    operation: "validate",
    clock: "2026-09-16T12:00:00+09:00",
    input: "{}",
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: JSON.stringify(["alpha", "beta"]), code: null },
    assertion: null,
    observes: "enum-membership",
    ...patch,
  });
  const E_NATURES: readonly NatureRow[] = [...T1_NATURES, { requirementId: "R6", nature: "ruled" }];
  const others = (r3 = r3When()) => [...r1Validate(), ...r2Structure(), ...r3, ...r4Compute()];
  const eResponse = (r6: readonly Record<string, unknown>[] = [r6Enum()], natures: readonly NatureRow[] = E_NATURES, r3 = r3When()) =>
    response([...others(r3), ...r6], natures);

  async function runE(
    outputs: readonly unknown[],
    options: { table?: NameTable; judge?: Judge; rejected?: readonly string[]; ledger?: LedgerView } = {},
  ) {
    const table = options.table ?? ETABLE;
    const runner = options.ledger === undefined ? runOn : ledgerFunctions(options.ledger).run;
    return runner(outputs, {
      plan: EPLAN,
      list: ELIST,
      table,
      carryOver: await carryFor(table, options.rejected),
      ...(options.judge === undefined ? {} : { judge: options.judge }),
    });
  }

  async function problemsOf(bad: unknown, table?: NameTable) {
    const { outcome } = await runE([bad, bad], table === undefined ? {} : { table });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error(`unmet でない: ${JSON.stringify(outcome)}`);
    expect(outcome.failure.attempts).toBe(TEST_SPEC_ROUNDS);
    return outcome.failure.problems;
  }

  const fixedTestTable = (): NameTable => ({
    ...ETABLE,
    verification: ETABLE.verification.map((entry) => (entry.requirementId === "R6" ? { requirementId: "R6", kind: "fixed-test" as const } : entry)),
  });

  it("(1) 二点測定：形どおりの試験 1 本を書いた応答が今の台帳で 1 回で通り網羅の単位にその単位があり、手 2a の台帳（性質が未登録）では固定文で落ちる", async () => {
    const { outcome, recording } = await runE([eResponse()]);
    if (!outcome.ok) throw new Error(`通るはず: ${JSON.stringify(outcome.failure)}`);
    expect(recording.structured).toHaveLength(1);
    expect(outcome.value.observes.get("r6-enum")).toBe("enum-membership");
    expect(outcome.value.natures.get("R6")).toBe("ruled");
    const key = canonicalJson({
      basis: "value",
      requirementId: "R6",
      targetId: "f.item.kind",
      kind: "normal",
      operation: "validate",
      observes: "enum-membership",
    });
    expect(outcome.value.coverage).toContainEqual({ requirementId: "R6", targetId: "f.item.kind", key });
    expect(outcome.value.coverage.filter((unit) => unit.requirementId === "R6")).toHaveLength(1);
    expect(outcome.value.coverage).toEqual(
      coverageUnitsOf({ suite: outcome.value.suite, observes: outcome.value.observes, natures: outcome.value.natures }),
    );
    // 直す前（手 2a の台帳）：観測する性質が未登録で、形の固定文で落ちる（2 回で malformed）
    const unregisteredE = negative(eResponse(), "手 2a の台帳の schema の observes の enum に enum-membership が無い。段の未登録の拒否を観測する負例");
    const before = await runE([unregisteredE, unregisteredE], { ledger: LEDGER_VIEW_2A });
    if (before.outcome.ok || before.outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(before.outcome.failure.problems).toContainEqual({
      field: `${T_AT}.observes`,
      message: `観測する性質は ${LEDGER_VIEW_2A.observes.join("・")} のいずれかであること`,
    });
  });

  it("(2) 負例：確かめ方が fixed-test の要件に選択肢の集合の試験を作ると固定文で落ち、異常・境界の不足も免除されない", async () => {
    const problems = await problemsOf(eResponse(), fixedTestTable());
    expect(problems).toContainEqual({ field: `${T_AT}.observes`, message: MESSAGES.notAllowed });
    expect(problems).toContainEqual({ field: R6_AT, message: "abnormal の試験が無い" });
    expect(problems).toContainEqual({ field: R6_AT, message: "boundary の試験が無い" });
  });

  it("(2) 負例：期待が options と順が違う・長さが違う・文字列の並びでない・kind が error は固定文で落ちる（値を埋めない）", async () => {
    for (const expected of [
      { kind: "ok", value: JSON.stringify(["beta", "alpha"]), code: null },
      { kind: "ok", value: JSON.stringify(["alpha"]), code: null },
      { kind: "ok", value: JSON.stringify(["alpha", "beta", "gamma"]), code: null },
      { kind: "ok", value: JSON.stringify(["alpha", "alpha"]), code: null },
      { kind: "ok", value: JSON.stringify("alpha"), code: null },
      { kind: "ok", value: JSON.stringify([1, 2]), code: null },
      { kind: "ok", value: JSON.stringify({ alpha: true, beta: true }), code: null },
      { kind: "ok", value: "null", code: null },
      { kind: "error", value: null, code: "E_INVALID" },
    ]) {
      const problems = await problemsOf(eResponse([r6Enum({ expected })]));
      expect(problems, JSON.stringify(expected)).toEqual([{ field: `${T_AT}.expected`, message: MESSAGES.expected }]);
      for (const word of ["alpha", "beta", "gamma"]) expect(MESSAGES.expected).not.toContain(word);
    }
  });

  it("(2) 負例：abnormal の試験は固定文で落ちる", async () => {
    const problems = await problemsOf(
      eResponse([r6Enum(), r6Enum({ id: "r6-abnormal", kind: "abnormal", expected: { kind: "error", value: null, code: "E_INVALID" } })]),
    );
    expect(problems).toContainEqual({ field: "tests[11].kind", message: MESSAGES.kind });
    expect(problems).toContainEqual({ field: "tests[11].expected", message: MESSAGES.expected });
  });

  it("(2) 負例：入力が空でないと固定文で落ちる", async () => {
    expect(await problemsOf(eResponse([r6Enum({ input: JSON.stringify({ "f.item.kind": "beta" }) })]))).toEqual([
      { field: `${T_AT}.input`, message: MESSAGES.input },
    ]);
  });

  it("(2) 負例：ほかの条件を満たし参照データだけが 1 行ある試験は、参照データの固定文だけで落ちる", async () => {
    const referenceData = [{ target: { requirementId: "R6", kind: "entity", roleId: "e.item" }, rowId: "item-1", values: "{}" }];
    expect(await problemsOf(eResponse([r6Enum({ referenceData })]))).toEqual([{ field: `${T_AT}.referenceData`, message: MESSAGES.referenceData }]);
  });

  it("(2) 負例：対象が別の項目（validate の正しい組）だと落ちる", async () => {
    const problems = await problemsOf(eResponse([r6Enum({ target: { requirementId: "R6", kind: "field", roleId: "f.item.amount" } })]));
    expect(problems).toContainEqual({ field: `${T_AT}.observes`, message: MESSAGES.notAllowed });
    expect(problems).toContainEqual({ field: `${T_AT}.target`, message: MESSAGES.target });
  });

  it("(2) 負例：その要件の試験を省くと「要件の試験が無い」で落ちる（免除は試験の有無で決めない）", async () => {
    expect(await problemsOf(eResponse([]))).toEqual([{ field: R6_AT, message: "要件の試験が無い" }]);
  });

  it("(2) 負例：観測が validation の normal だけは固定文で落ちる", async () => {
    expect(await problemsOf(eResponse([r6Enum({ observes: "validation" })]))).toEqual([
      { field: `${T_AT}.observes`, message: MESSAGES.observes },
    ]);
  });

  it("(2) 負例：ほかの ruled の要件の異常・境界の不足は免除が漏れずに落ちる", async () => {
    expect(await problemsOf(eResponse([r6Enum()], E_NATURES, r3When(["normal"])))).toEqual([
      { field: "requirements[2]", message: "abnormal の試験が無い" },
      { field: "requirements[2]", message: "boundary の試験が無い" },
    ]);
  });

  // ── (3) 除外の範囲 ─────────────────────────────────────────────

  async function planned(table: NameTable = ETABLE, rejected: readonly string[] = []) {
    const pruned = pruneForCarryOver(ELIST, table, await carryFor(table, rejected));
    return { pruned, design: pruned.conversion.design, targets: ledgerTargets(pruned.table) };
  }
  const suiteOf = (output: unknown): TestSuite => {
    const checked = checkTestSpecOutput(output);
    if (!checked.ok) throw new Error("形が通るはず");
    return checked.value.suite;
  };
  const key = (problem: Problem) => `${problem.field}\u0000${problem.message}`;
  const minus = (a: readonly Problem[], b: readonly Problem[]) => {
    const kept = new Set(b.map(key));
    return a.filter((problem) => !kept.has(key(problem)));
  };

  it("(3) v1 の checkSuitePlan の出力と除外後の出力の差は、対象の要件の位置の abnormal・boundary の不足の 2 件だけ", async () => {
    const { pruned, design, targets } = await planned();
    const suite = suiteOf(eResponse());
    const raw = checkSuitePlan(pruned.list, suite, design, reconcileNatures(design, suite.classifications).natures);
    const exempted = exempt(raw, pruned.list, targets);
    expect(minus(raw, exempted)).toEqual([
      { field: R6_AT, message: "abnormal の試験が無い" },
      { field: R6_AT, message: "boundary の試験が無い" },
    ]);
    expect(exempted).toEqual([]);
  });

  it("(3) 除外は default-value と同じ 3 条件（位置・文の完全一致・持ち越しで除かれていない）：部分一致の文・別の位置・別の文・持ち越しの要件の位置は外れない", async () => {
    const { pruned, targets } = await planned();
    const kept: readonly Problem[] = [
      { field: R6_AT, message: "abnormal の試験が無い（追記）" },
      { field: R6_AT, message: " boundary の試験が無い" },
      { field: R6_AT, message: "normal の試験が無い" },
      { field: R6_AT, message: "要件の試験が無い" },
      { field: "requirements[3]", message: "abnormal の試験が無い" },
      { field: `${R6_AT}.kind`, message: "boundary の試験が無い" },
      { field: T_AT, message: "abnormal の試験が無い" },
    ];
    expect(exempt(kept, pruned.list, targets)).toEqual(kept);
    const carried = await planned(ETABLE, ["R6"]);
    expect(carried.targets.size).toBe(0);
    const atCarried: readonly Problem[] = [
      { field: "requirements[5]", message: "abnormal の試験が無い" },
      { field: R6_AT, message: "boundary の試験が無い" },
    ];
    expect(exempt(atCarried, ELIST, carried.targets)).toEqual(atCarried);
    expect(exempt(atCarried, carried.pruned.list, carried.targets)).toEqual(atCarried);
  });

  // ── (4) 分類 ───────────────────────────────────────────────────

  it("(4) 分類が食い違っても判定を呼ばず（要求 0）ruled で採り、記録は fallback", async () => {
    const recorded = recordingJudge(createFakeJudge({}));
    const natures = E_NATURES.map((entry) => (entry.requirementId === "R6" ? { requirementId: "R6", nature: "existence-only" as const } : entry));
    const { outcome } = await runE([eResponse([r6Enum()], natures)], { judge: recorded.judge });
    if (!outcome.ok) throw new Error(`通るはず: ${JSON.stringify(outcome.failure)}`);
    expect(recorded.requests).toHaveLength(0);
    expect(outcome.value.natures.get("R6")).toBe("ruled");
    expect(outcome.value.discrepancies).toEqual([
      { requirementId: "R6", design: "ruled", classified: "existence-only", resolved: "ruled", resolution: "fallback" },
    ]);
  });

  // ── (5) データと題材の言葉 ──────────────────────────────────────

  it("(5) 「要件ごとの確かめ方」に kind が載り（value は無い）、規則に形の 1 文があり、要求のどこにも題材の言葉が無い", async () => {
    const { recording } = await runE([eResponse()]);
    const request = recording.structured[0]!;
    expect(dataNamesOf(request.input)).toEqual([...TEST_SPEC_DATA_NAMES]);
    const verification = dataBlockOf(request.input, "要件ごとの確かめ方") as readonly Record<string, unknown>[];
    expect(verification.find((entry) => entry["requirementId"] === "R6")).toEqual({
      requirementId: "R6",
      verificationKind: "enum-membership",
      checks: [],
    });
    expect(verification.some((entry) => "value" in entry)).toBe(false);
    expect(request.rules).toEqual(ruleTexts(testSpecRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)));
    expect(request.rules?.some((text) => text.includes(ROW.rules.t2 ?? "（無い）"))).toBe(true);
    expectNoAcceptanceMaterial([requestText(request)]);
  });
});

// ── 空の集計 empty-aggregate（集計の種類 × データ状態の期待の形の門。旗 on。Issue #549）──────────────────

describe("旗 on：空の集計の要件の試験は、集計の種類 × データ状態の台帳の表で期待を確かめる（(a)① の型。Issue #549）", () => {
  const ROW = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate");
  if (ROW?.t2Aggregate == null) throw new Error("前提が壊れた：台帳に empty-aggregate の集計の試験の型が無い");
  const MESSAGES = ROW.t2Aggregate.messages;
  /** アプリ全体の集計の行（金額の合計・件数・平均。どれも集計元は項目の entity。R4 が所属させる） */
  const appRow = (id: string, name: string, quote: string) => ({
    id,
    kind: "computation" as const,
    entity: null,
    name,
    role: "要件 R4 が使う対象",
    source: { requirementId: "R4", quote },
    type: { valueType: "number" as const, scope: "app" as const, form: "aggregate" as const },
    options: null,
    groupBy: null,
    refEntity: null,
  });
  /** 題材の表（計算の行に集計の種類と集計元を持つ）に、アプリ全体の集計の 3 行を足した表。`extra` で集計を差し替える */
  const aggTable = (extra: Parameters<typeof withAggregates>[1] = {}): NameTable => {
    const base = fixtureTable();
    const rows = [...base.rows, appRow("c.sumAll", "sumAll", "金額の合計"), appRow("c.countAll", "countAll", "区分ごとの件数"), appRow("c.avgAll", "avgAll", "全体の率")];
    return withAggregates(
      {
        ...base,
        rows,
        ownership: base.ownership.map((entry) =>
          entry.requirementId === "R4"
            ? { ...entry, roles: [...entry.roles, ...["c.sumAll", "c.countAll", "c.avgAll"].map((id) => ({ id, basis: "stated" as const, reason: null }))] }
            : entry,
        ),
      },
      { "c.sumAll": { kind: "sum", entity: "e.item" }, "c.countAll": { kind: "count", entity: "e.item" }, "c.avgAll": { kind: "avg", entity: "e.item" }, ...extra },
    );
  };
  /** 項目の行（集計元の行）3 つ */
  const ITEM_ROWS = [1, 2, 3].map((index) => ({
    target: { requirementId: "R4", kind: "entity", roleId: "e.item" },
    rowId: `item-${String(index)}`,
    values: JSON.stringify({ "f.item.amount": 1 }),
  }));
  interface AggOptions {
    readonly id?: string;
    readonly roleId?: string;
    readonly kind?: "normal" | "abnormal" | "boundary";
    readonly operation?: string;
    readonly observes?: string;
    readonly empty?: readonly string[];
    readonly value: unknown;
    readonly referenceData?: readonly Record<string, unknown>[];
  }
  /** 集計の試験 1 件（既定は空の集計・アプリ全体の合計・集計元を空と明示した境界） */
  const aggTest = (options: AggOptions): Record<string, unknown> => ({
    id: options.id ?? "r4-empty",
    target: { requirementId: "R4", kind: "computation", roleId: options.roleId ?? "c.sumAll" },
    kind: options.kind ?? "boundary",
    operation: options.operation ?? "aggregate",
    clock: "2026-09-16T12:00:00+09:00",
    input: "{}",
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: options.empty ?? ["e.item"] },
    referenceData: options.referenceData ?? [],
    expected: { kind: "ok", value: JSON.stringify(options.value), code: null },
    assertion: null,
    observes: options.observes ?? "empty-aggregate",
  });
  /** 空の境界（集計元を空と明示）と未読の異常（集計元に触れない）の 2 本 */
  const pair = (roleId: string, empty: unknown, unread: unknown = null, prefix = roleId) => [
    aggTest({ id: `${prefix}-empty`, roleId, kind: "boundary", empty: ["e.item"], value: empty }),
    aggTest({ id: `${prefix}-unread`, roleId, kind: "abnormal", empty: [], value: unread }),
  ];
  const aResponse = (extra: readonly Record<string, unknown>[]) => response([...r1Validate(), ...r2Structure(), ...r3When(), ...r4Compute(), ...extra]);
  const runA = (outputs: readonly unknown[], options: { table?: NameTable; ledger?: LedgerView } = {}) =>
    run(outputs, { table: options.table ?? aggTable(), ledger: options.ledger ?? PROPERTY_LEDGER_VIEW });
  /** 1 回目の応答で落ちた問題（作り直しの指示。2 回目は同じ応答） */
  async function problemsOf(extra: readonly Record<string, unknown>[], table?: NameTable): Promise<readonly Problem[]> {
    const bad = aResponse(extra);
    const { outcome } = await runA([bad, bad], table === undefined ? {} : { table });
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    return outcome.failure.problems;
  }
  /** 追加の試験の位置（r1・r2・r3・r4 の 10 本のあと） */
  const AT = (offset = 0) => `tests[${String(10 + offset)}]`;
  const ENUM_ZEROS = [
    { heading: "alpha", value: 0 },
    { heading: "beta", value: 0 },
  ];

  it("(1) 二点測定：sum のアプリ全体の集計に、空を明示して 0 の boundary と、触れずに null の abnormal（どちらも empty-aggregate）を書いた応答は通り、網羅の単位にある。#548 の台帳では観測する性質が未登録で落ちる", async () => {
    const good = aResponse(pair("c.sumAll", 0));
    const { outcome, recording } = await runA([good]);
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(recording.structured).toHaveLength(1);
    expect(outcome.value.observes.get("c.sumAll-empty")).toBe("empty-aggregate");
    const units = outcome.value.coverage.filter((unit) => unit.targetId === "c.sumAll").map((unit) => JSON.parse(unit.key) as Record<string, unknown>);
    expect(units.map((unit) => [unit["kind"], unit["operation"], unit["observes"]])).toEqual([
      ["boundary", "aggregate", "empty-aggregate"],
      ["abnormal", "aggregate", "empty-aggregate"],
    ]);
    // 直す前（#548 の台帳）：観測する性質が台帳に無く、形で 2 回落ちる
    const unregisteredA = negative(good, "#548 の台帳の schema の observes の enum に empty-aggregate が無い。段の未登録の拒否を観測する負例");
    const before = await runA([unregisteredA, unregisteredA], { ledger: LEDGER_VIEW_2B });
    if (before.outcome.ok || before.outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(before.outcome.failure.problems).toContainEqual({
      field: `${AT()}.observes`,
      message: `観測する性質は ${LEDGER_VIEW_2B.observes.join("・")} のいずれかであること`,
    });
  });

  it("(1) 正例：avg × 空は null、count × 空は 0、見出しごと × enum × 空は options の順の 0 の並び、見出しごと × avg × 空は null の並び、月 × 空は各 value が 0 の並び、見出しごとの未読は null", async () => {
    const cases: readonly { readonly name: string; readonly tests: readonly Record<string, unknown>[]; readonly table?: NameTable }[] = [
      { name: "avg", tests: pair("c.avgAll", null) },
      { name: "count", tests: pair("c.countAll", 0) },
      { name: "groups enum count", tests: pair("c.byKind", ENUM_ZEROS) },
      {
        name: "groups enum avg",
        tests: pair("c.byKind", [
          { heading: "alpha", value: null },
          { heading: "beta", value: null },
        ]),
        table: aggTable({ "c.byKind": { kind: "avg", entity: "e.item" } }),
      },
      {
        name: "groups month sum",
        tests: pair("c.byMonth", [
          { heading: "2026-08", value: 0 },
          { heading: "2026-09", value: 0 },
        ]),
      },
    ];
    for (const entry of cases) {
      const { outcome } = await runA([aResponse(entry.tests)], entry.table === undefined ? {} : { table: entry.table });
      expect(outcome.ok, `${entry.name}：${outcome.ok ? "" : JSON.stringify(outcome.failure)}`).toBe(true);
    }
  });

  it("(2) 負例：空を明示して null を期待（sum・count）は固定文で落ちる", async () => {
    for (const roleId of ["c.sumAll", "c.countAll"]) {
      expect(await problemsOf([aggTest({ roleId, value: null })]), roleId).toEqual([{ field: `${AT()}.expected`, message: MESSAGES.expected }]);
    }
  });

  it("(2) 負例：空と明示せず 0 の並びを期待（見出しごとの未読）・0 を期待（未読）は固定文で落ちる", async () => {
    expect(await problemsOf([aggTest({ roleId: "c.byKind", kind: "abnormal", empty: [], value: ENUM_ZEROS })])).toEqual([
      { field: `${AT()}.expected`, message: MESSAGES.expected },
    ]);
    expect(await problemsOf([aggTest({ kind: "abnormal", empty: [], value: 0 })])).toEqual([{ field: `${AT()}.expected`, message: MESSAGES.expected }]);
  });

  it("(2) 負例：avg × 空に 0、見出しの順が options と違う・見出しが足りない・余計な欄がある並びは固定文で落ちる", async () => {
    expect(await problemsOf([aggTest({ roleId: "c.avgAll", value: 0 })])).toEqual([{ field: `${AT()}.expected`, message: MESSAGES.expected }]);
    for (const value of [
      [...ENUM_ZEROS].reverse(),
      ENUM_ZEROS.slice(0, 1),
      ENUM_ZEROS.map((item) => ({ ...item, label: "x" })),
      ENUM_ZEROS.map((item) => item.value),
      { alpha: 0, beta: 0 },
    ]) {
      // 順の違いは v1 の見出しの順の検査も挙げる（その分は今までどおり）
      expect(await problemsOf([aggTest({ roleId: "c.byKind", value })]), JSON.stringify(value)).toContainEqual({ field: `${AT()}.expected`, message: MESSAGES.expected });
    }
    // 月の見出しの並びの value が 0 でない・空の並び
    for (const value of [[{ heading: "2026-09", value: null }], []]) {
      expect(await problemsOf([aggTest({ roleId: "c.byMonth", value })]), JSON.stringify(value)).toEqual([{ field: `${AT()}.expected`, message: MESSAGES.expected }]);
    }
  });

  it("(2) 負例：集計元でない entity だけを空と明示して 0（未読なので null が要る）は固定文で落ちる", async () => {
    const problems = await problemsOf([aggTest({ kind: "abnormal", empty: ["e.member"], value: 0 })]);
    expect(problems).toEqual([{ field: `${AT()}.expected`, message: MESSAGES.expected }]);
  });

  it("(2) 負例：参照データに集計元の行があるのに empty-aggregate、kind が状態に合わない（空に abnormal・未読に boundary）は固定文で落ちる", async () => {
    expect(await problemsOf([aggTest({ value: 0, referenceData: ITEM_ROWS })])).toEqual([{ field: `${AT()}.referenceData`, message: MESSAGES.referenceData }]);
    expect(await problemsOf([aggTest({ kind: "abnormal", value: 0 })])).toEqual([{ field: `${AT()}.kind`, message: MESSAGES.kind }]);
    expect(await problemsOf([aggTest({ kind: "boundary", empty: [], value: null })])).toEqual([{ field: `${AT()}.kind`, message: MESSAGES.kind }]);
  });

  it("(2) 負例：対象が集計の行でない（式の計算・集計元の無い表）empty-aggregate は固定文で落ちる", async () => {
    expect(await problemsOf([aggTest({ roleId: "c.rate", value: 0 })])).toEqual([{ field: `${AT()}.target`, message: MESSAGES.target }]);
    // 計算の行に集計の種類と集計元が無い表（型付きの表）では、集計の行も対象にならない（fail-closed）
    expect(await problemsOf([aggTest({ roleId: "c.byKind", value: ENUM_ZEROS })], fixtureTable())).toEqual([
      { field: `${AT()}.target`, message: MESSAGES.target },
    ]);
  });

  it("(2) 負例：observes が value で集計元の行が無い集計の試験は、空と明示すれば種類の値、しなければ null でなければ固定文で落ちる", async () => {
    expect(await problemsOf([aggTest({ kind: "normal", observes: "value", value: 5 })])).toEqual([{ field: `${AT()}.expected`, message: MESSAGES.alsoExpected }]);
    expect(await problemsOf([aggTest({ kind: "normal", observes: "value", empty: [], value: 0 })])).toEqual([
      { field: `${AT()}.expected`, message: MESSAGES.alsoExpected },
    ]);
    // 合えば通る（kind は見ない）
    for (const test of [aggTest({ kind: "normal", observes: "value", value: 0 }), aggTest({ kind: "normal", observes: "value", empty: [], value: null })]) {
      const { outcome } = await runA([aResponse([test])]);
      expect(outcome.ok).toBe(true);
    }
  });

  it("(3) 既存の value の正常の試験（集計元の行あり）は今までどおり通り、門に掛からない", async () => {
    const normal = aggTest({ kind: "normal", observes: "value", empty: [], value: 3, referenceData: ITEM_ROWS });
    const { outcome } = await runA([aResponse([normal])]);
    expect(outcome.ok, outcome.ok ? "" : JSON.stringify(outcome.failure)).toBe(true);
    // 旗 off（集計の種類と集計元の無い表）では同じ試験の形でも門は無い
    const off = await run([aResponse([aggTest({ kind: "normal", observes: "value", roleId: "c.byKind", value: [{ heading: "alpha", value: 5 }, { heading: "beta", value: 5 }] })])], { table: fixtureTable() });
    expect(off.outcome.ok, off.outcome.ok ? "" : JSON.stringify(off.outcome.failure)).toBe(true);
  });

  it("(4) 要求に題材の言葉が無く、R-tsp-16 に台帳の文があり、データの対象の表の計算の行に aggregate が載る", async () => {
    const { recording } = await runA([aResponse(pair("c.sumAll", 0))]);
    const request = recording.structured[0]!;
    expectNoAcceptanceMaterial([requestText(request)]);
    expect(request.rules?.some((text) => text.includes(ROW.rules.t2 ?? "（無い）"))).toBe(true);
    const rows = dataBlockOf(request.input, TEST_SPEC_DATA_NAMES[2]) as { id: string; type: Record<string, unknown> | null }[];
    expect(rows.find((row) => row.id === "c.sumAll")?.type).toEqual({ valueType: "number", scope: "app", form: "aggregate", aggregate: { kind: "sum", entity: "e.item" } });
    expect(rows.find((row) => row.id === "c.rate")?.type).toEqual({ valueType: "number", scope: "app", form: "expression", aggregate: null });
    // 名前は見せない（今までどおり）
    expect(rows.every((row) => !("name" in row))).toBe(true);
  });
});

// ── 旗 on：操作の条件（when）の試験の期待の型の門（Issue #550）──────────────────────────────

describe("旗 on：操作の条件（when）の試験は、期待が ok なら真偽、対象は条件を持つ操作の行（(a)③・(c)② の型。Issue #550）", () => {
  const ledger = PROPERTY_LEDGER_VIEW;
  const WHEN_T2 = PROPERTY_LEDGER.find((entry) => entry.id === "when")?.t2Condition;
  if (WHEN_T2 == null) throw new Error("前提が壊れた：台帳の when に条件の試験の型が無い");
  const messages = WHEN_T2.messages;
  /** R3 の試験を差し替えた応答（ほかの要件は通る応答のまま） */
  const withR3 = (r3: readonly Record<string, unknown>[], extra: readonly Record<string, unknown>[] = []) =>
    response([...r1Validate(), ...extra, ...r2Structure(), ...r3, ...r4Compute()]);
  /** R3 の正常の試験の期待だけを替えた応答 */
  const normalExpecting = (expected: Record<string, unknown>) =>
    withR3(r3When().map((test) => (test["id"] === "r3-normal" ? { ...test, expected } : test)));
  const indexOf = (output: { readonly tests: readonly Record<string, unknown>[] }, id: string) =>
    output.tests.findIndex((test) => test["id"] === id);

  it("(1) 正例：条件を持つ操作に期待 true の正常・期待 false の異常（か error）・true の境界を書いた応答は旗 on で 1 回で通る", async () => {
    const errorAbnormal = r3When().map((test) =>
      test["id"] === "r3-abnormal" ? { ...test, expected: { kind: "error", value: null, code: "E_CONDITION" } } : test,
    );
    for (const [r3, values] of [
      [r3When(), [true, false, true]],
      [errorAbnormal, [true, "error", true]],
    ] as const) {
      const { outcome, recording } = await run([withR3(r3)], { ledger });
      if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
      expect(recording.structured).toHaveLength(1);
      const tests = outcome.value.suite.tests.filter((test) => outcome.value.observes.get(test.id) === "when");
      expect(tests.map((test) => (test.expected.kind === "ok" ? test.expected.value : test.expected.kind))).toEqual(values);
    }
    // 門の関数は通る応答に問題を出さない
    const { outcome } = await run([withR3(r3When())], { ledger });
    if (!outcome.ok) throw new Error("通るはず");
    expect(checkConditionTests(outcome.value.suite, outcome.value.observes, fixtureTable(), ledger)).toEqual([]);
  });

  const negatives = [
    { name: "期待に操作後の状態（写像）", expected: { kind: "ok", value: JSON.stringify({ "f.item.kind": "beta" }), code: null } },
    { name: "期待が文字列", expected: { kind: "ok", value: JSON.stringify("closed"), code: null } },
    { name: "期待が数", expected: { kind: "ok", value: "1", code: null } },
    { name: "期待が null", expected: { kind: "ok", value: "null", code: null } },
  ] as const;
  for (const entry of negatives) {
    it(`(2) 負例：${entry.name}は旗 on の T2' で固定文で落ち（2 回で unmet）、旗 off は今までどおり T2 を通る`, async () => {
      const output = normalExpecting(entry.expected);
      const on = await run([output, output], { ledger });
      if (on.outcome.ok || on.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
      expect(on.outcome.failure.attempts).toBe(TEST_SPEC_ROUNDS);
      expect(on.outcome.failure.problems).toEqual([{ field: `tests[${String(indexOf(output, "r3-normal"))}].expected`, message: messages.expected }]);
      const off = await run([output]);
      expect(off.outcome.ok).toBe(true);
    });
  }

  it("(2) 負例：今までの既定の R3（r3Action。期待は数 1）の応答は、旗 on では T2' で 3 本とも固定文で落ち（2 回で unmet）、旗 off は今までどおり 1 回で通る", async () => {
    const output = passing(r3Action());
    const on = await run([output, output], { ledger });
    if (on.outcome.ok || on.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(on.outcome.failure.problems).toEqual(
      ["r3-normal", "r3-abnormal", "r3-boundary"].map((id) => ({ field: `tests[${String(indexOf(output, id))}].expected`, message: messages.expected })),
    );
    const off = await run([output]);
    if (!off.outcome.ok) throw new Error("off は通るはず");
    expect(off.recording.structured).toHaveLength(1);
    // 期待が真偽の R3（r3When）にすれば旗 on でも通る
    expect((await run([passing(r3When())], { ledger })).outcome.ok).toBe(true);
  });

  it("(2) 負例：条件の無い操作（hasWhen 偽）に when の試験を作ると旗 on の T2' で固定文で落ち、旗 off は今までどおり T2 を通る", async () => {
    // R1 が所属させる o.addItem は条件（when）を持たない
    const noWhen = rawTest({
      id: "r1-no-when",
      requirementId: "R1",
      targetKind: "operation",
      roleId: "o.addItem",
      operation: "action",
      observes: "when",
      expected: { kind: "ok", value: "true", code: null },
    });
    const output = withR3(r3When(), [noWhen]);
    const on = await run([output, output], { ledger });
    if (on.outcome.ok || on.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(on.outcome.failure.problems).toEqual([{ field: `tests[${String(indexOf(output, "r1-no-when"))}].target`, message: messages.target }]);
    const off = await run([output]);
    expect(off.outcome.ok).toBe(true);
  });

  it("(2) 負例：操作に validate を当てた when の試験は今までどおり組が表に無い（旗 on・off とも。条件の門の文は出ない）", async () => {
    const validate = rawTest({ id: "r3-validate", requirementId: "R3", targetKind: "operation", roleId: "o.closeItem", operation: "validate", observes: "when" });
    const output = withR3([...r3When(), validate]);
    for (const withLedger of [{ ledger }, {}]) {
      const { outcome } = await run([output, output], withLedger);
      if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
      expect(outcome.failure.problems).toEqual([
        { field: `tests[${String(indexOf(output, "r3-validate"))}].observes`, message: "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い" },
      ]);
    }
  });

  it("二点測定：#549 の台帳（条件の試験の型が無い）の on では、写像の期待も条件の無い操作も T2' を通る（門は台帳の行から掛けている）", async () => {
    const output = normalExpecting(negatives[0].expected);
    const before = await run([output], { ledger: LEDGER_VIEW_2C });
    expect(before.outcome.ok).toBe(true);
    if (!before.outcome.ok) return;
    expect(checkConditionTests(before.outcome.value.suite, before.outcome.value.observes, fixtureTable(), LEDGER_VIEW_2C)).toEqual([]);
    expect(checkConditionTests(before.outcome.value.suite, before.outcome.value.observes, fixtureTable(), ledger)).toEqual([
      { field: `tests[${String(indexOf(output, "r3-normal"))}].expected`, message: messages.expected },
    ]);
  });
});

// ── 旗 on：T1'' が受理した要件でない文は T2 の一覧・確かめ方・分類の完全性の外（Issue #550）──────────────────

describe("旗 on：T1'' が受理した non-requirement の要件は、T2 の要求の一覧・確かめ方に無く、分類の完全性の対象外で、試験を書けば一覧に無い要件 ID で落ちる（Issue #550）", () => {
  const ledger = PROPERTY_LEDGER_VIEW;
  const nlist = fixtureNonRequirementList();
  const ntable = withAggregates(fixtureNonRequirementTable());
  const nonCarry = async () =>
    deriveCarryOver({
      list: nlist,
      table: ntable,
      semanticCheck: {
        tableSha256: await nameTableSha256(ntable),
        judgments: ["R1", "R2", "R3", "R4", "R6"].map((requirementId) => ({ requirementId, verdict: "accept" as const })),
      },
      ledger,
    });
  const runNon = async (outputs: readonly unknown[]) => {
    const recording = createCheckedRecordingClient(outputs.map(structured));
    const outcome = await runTestSpec({
      plan: fixturePlan(nlist),
      list: nlist,
      table: ntable,
      carryOver: await nonCarry(),
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      ledger,
    });
    return { outcome, recording };
  };

  it("持ち越しの導出：受理された R6 は要件でない文で、持ち越し（R5 だけ）にも残る一覧にも無く、除く行は増えない", async () => {
    const carry = await nonCarry();
    expect(carry.entries.map((entry) => entry.requirementId)).toEqual(["R5"]);
    expect(carry.nonRequirements).toEqual(["R6"]);
    expect(carry.remainingRequirementIds).toEqual(["R1", "R2", "R3", "R4"]);
    expect(carry.excludedRowIds).toEqual((await carryOverFor(withAggregates(fixtureTable()))).excludedRowIds);
  });

  it("通る応答（R6 の試験も分類も無い）は 1 回で通り、要求の一覧・確かめ方・所属に R6 が無い", async () => {
    const { outcome, recording } = await runNon([passing(r3When())]);
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    const input = recording.structured[0]?.input ?? "";
    const [, listName, , verificationName, ownershipName] = TEST_SPEC_DATA_NAMES;
    const listed = dataBlockOf(input, listName) as { requirements: { id: string }[] };
    expect(listed.requirements.map((requirement) => requirement.id)).toEqual(["R1", "R2", "R3", "R4"]);
    expect((dataBlockOf(input, verificationName) as { requirementId: string }[]).map((entry) => entry.requirementId)).toEqual(["R1", "R2", "R3", "R4"]);
    expect((dataBlockOf(input, ownershipName) as { requirementId: string }[]).map((entry) => entry.requirementId)).toEqual(["R1", "R2", "R3", "R4"]);
    // 確かめ方の種類 non-requirement は T2 に見せない（確定した仕様には文が残る＝持ち越しの要件と同じ扱い）
    expect(input).not.toContain("non-requirement");
    expect(JSON.stringify(dataBlockOf(input, TEST_SPEC_DATA_NAMES[0]))).toContain(NON_REQUIREMENT_TEXT);
  });

  it("(5) R6 の試験を書けば「一覧に無い要件 ID」で落ち、R6 の分類を書いても分類の完全性で落ちる（既存の検査）", async () => {
    const withTest = response([
      ...passing(r3When()).tests,
      rawTest({ id: "r6-x", requirementId: "R6", targetKind: "entity", roleId: "e.item", operation: "screen", observes: "existence" }),
    ]);
    const tested = await runNon([withTest, withTest]);
    if (tested.outcome.ok || tested.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(tested.outcome.failure.problems.map((problem) => problem.message)).toContain("一覧に無い要件 ID である");
    const classified = response(passing(r3When()).tests, [...T1_NATURES, { requirementId: "R6", nature: "existence-only" }]);
    const extra = await runNon([classified, classified]);
    if (extra.outcome.ok || extra.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(extra.outcome.failure.problems.map((problem) => problem.message)).toEqual(["要件の一覧に無い要件 ID の分類である"]);
  });
});

// ── 旗 v12.ids の構造の検査の対象（Issue #594）──────────────────────────────────

describe("T2 の「要件ごとの確かめ方」に構造の検査の対象の ID（旗 v12.ids の表だけ）", () => {
  it("C2 が検査の対象を書いた表なら構造で確かめる要件に checkTargets が載り、ほかの欄・ほかの要件・前置き・規則は対象の無い表と同じ。T2' の構造の検査はそのまま通る", async () => {
    const withTargets = withCheckTargets(fixtureTable());
    const on = await run([passing()], { table: withTargets });
    const off = await run([passing()]);
    expect(on.outcome.ok).toBe(true);
    const onRequest = on.recording.structured[0]!;
    const offRequest = off.recording.structured[0]!;
    const onData = dataBlockOf(onRequest.input, "要件ごとの確かめ方") as readonly Record<string, unknown>[];
    const offData = dataBlockOf(offRequest.input, "要件ごとの確かめ方") as readonly Record<string, unknown>[];
    expect(onData.find((entry) => entry["requirementId"] === "R2")).toEqual({
      requirementId: "R2",
      verificationKind: "structural",
      checks: ["view-shows"],
      checkTargets: [{ check: "view-shows", targetId: "s.members", sourceId: "f.member.title" }],
    });
    expect(onData.map(({ checkTargets: _targets, ...rest }) => rest)).toEqual(offData);
    // 対象の無い表（旗 off・ids off の表）のデータに checkTargets の欄は無い（今と同じ）
    expect(offData.some((entry) => "checkTargets" in entry)).toBe(false);
    for (const field of ["instructions", "rules", "documents", "schemaName", "schema", "maxOutputTokens"] as const) {
      expect(onRequest[field]).toEqual(offRequest[field]);
    }
  });
});

// ── 旗 v12.ids：台帳の型だけで値が決まる試験はコードが作る（手 3c。Issue #595）──────────────────────

describe("旗 v12.ids：既定値・選択肢の集合・アプリ全体と見出しごと × 選択肢の空の集計はコードが作り、T2 には値の要る試験だけを書かせる（Issue #595）", () => {
  const ledger = PROPERTY_LEDGER_VIEW;
  const AGG = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate")?.t2Aggregate;
  const DEFAULT_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "default-value");
  if (AGG == null || DEFAULT_ROW?.t2 == null) throw new Error("前提が壊れた：台帳の行が無い");
  /** 行ごと（c.itemCount）と見出しごと × 月（c.byMonth）の集計だけを所属させる要件 R8（コードが空の試験を作らない範囲） */
  const R8_TEXT = "担当者ごとの項目の数と、月ごとの金額の合計を見られる。";
  const base = fixtureGeneratedList();
  const GLIST: RequirementList = {
    ...base,
    requirements: [...base.requirements, { id: "R8", text: R8_TEXT, quote: R8_TEXT, position: { start: 0, end: R8_TEXT.length } }],
  };
  // 旗 ids の表は C2 が構造の検査の対象を書く（手 3b）。構造の検査はコードが作るので、検査ごとの対象を添えた表で回す（#624）
  const baseTable = withCheckTargets(fixtureGeneratedTable());
  const GTABLE: NameTable = {
    ...baseTable,
    ownership: [...baseTable.ownership, { requirementId: "R8", roles: ["c.itemCount", "c.byMonth"].map((id) => ({ id, basis: "stated" as const, reason: null })) }],
    verification: [...baseTable.verification, { requirementId: "R8", kind: "fixed-test" }],
    classification: [...baseTable.classification, { requirementId: "R8", nature: "ruled" }],
  };
  const GPLAN = fixturePlan(GLIST);
  const NATURES: readonly NatureRow[] = [...T1_NATURES, { requirementId: "R8", nature: "ruled" }];

  async function carryFor(table: NameTable = GTABLE): Promise<CarryOver> {
    const tableSha256 = await nameTableSha256(table);
    const targets = table.verification.filter((entry) => entry.kind !== "unresolved").map((entry) => entry.requirementId);
    return deriveCarryOver({
      list: GLIST,
      table,
      semanticCheck: { tableSha256, judgments: targets.map((requirementId) => ({ requirementId, verdict: "accept" as const })) },
    });
  }
  const runG = async (outputs: readonly unknown[], ids = true, table: NameTable = GTABLE) =>
    run(ids ? asCases(outputs) : outputs, { plan: GPLAN, list: GLIST, table, carryOver: await carryFor(table), ledger, ...(ids ? { ids: true } : {}) });

  const ITEM_ROWS = [1, 2, 3].map((index) => ({
    target: { requirementId: "R8", kind: "entity", roleId: "e.item" },
    rowId: `item-${String(index)}`,
    values: JSON.stringify({ "f.item.amount": 1 }),
  }));
  /** 集計の試験 1 件（strict の形） */
  const aggTest = (options: {
    readonly id: string;
    readonly requirementId?: string;
    readonly roleId: string;
    readonly kind: "normal" | "abnormal" | "boundary";
    readonly observes: string;
    readonly empty?: readonly string[];
    readonly value: unknown;
    readonly referenceData?: readonly Record<string, unknown>[];
  }): Record<string, unknown> => ({
    id: options.id,
    target: { requirementId: options.requirementId ?? "R8", kind: "computation", roleId: options.roleId },
    kind: options.kind,
    operation: "aggregate",
    clock: "2026-09-16T12:00:00+09:00",
    input: "{}",
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: options.empty ?? [] },
    referenceData: options.referenceData ?? [],
    expected: { kind: "ok", value: JSON.stringify(options.value), code: null },
    assertion: null,
    observes: options.observes,
  });
  const MONTHS_3 = ["2026-07", "2026-08", "2026-09"].map((heading) => ({ heading, value: 0 }));
  const MONTHS_6 = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((heading) => ({ heading, value: 0 }));
  /** R8 の試験：行ごとの集計の正常・境界（空）・異常（未読）と、月の見出しごとの境界（`months` の並び） */
  const r8Tests = (options: { readonly omit?: "boundary" | "abnormal"; readonly months?: readonly unknown[] } = {}) =>
    [
      aggTest({ id: "r8-count-normal", roleId: "c.itemCount", kind: "normal", observes: "value", value: 3, referenceData: ITEM_ROWS }),
      aggTest({ id: "r8-count-empty", roleId: "c.itemCount", kind: "boundary", observes: "empty-aggregate", empty: ["e.item"], value: 0 }),
      aggTest({ id: "r8-count-unread", roleId: "c.itemCount", kind: "abnormal", observes: "empty-aggregate", value: null }),
      aggTest({ id: "r8-month-empty", roleId: "c.byMonth", kind: "boundary", observes: "empty-aggregate", empty: ["e.item"], value: options.months ?? MONTHS_3 }),
    ].filter((test) => test["kind"] !== options.omit);
  /**
   * ids on の通る応答（R6・R7 の試験も、R4 のアプリ全体・見出しごと × 選択肢の空の試験も書かない。手 3d（#624）で、構造の要件 R2 は
   * 要求の一覧に無く、構造の検査と画面の試験はコードが作るので書かない）
   */
  const idsResponse = (extra: readonly Record<string, unknown>[] = [], r8: readonly Record<string, unknown>[] = r8Tests()) =>
    response([...r1Validate(), ...r3When(), ...r4Compute(), ...r8, ...extra], NATURES.filter((entry) => entry.requirementId !== "R2"));
  /** ids off の同じ応答（構造の要件 R2 の構造の検査と分類を LLM が書く） */
  const offResponse = (extra: readonly Record<string, unknown>[] = [], r8: readonly Record<string, unknown>[] = r8Tests()) =>
    response([...r1Validate(), ...r2Structure(), ...r3When(), ...r4Compute(), ...r8, ...extra], NATURES);
  /** 応答の試験の数（R1 3・R3 3・R4 3・R8 4。手 3d（#624）で R2 の構造の検査 1 本をコードが作るようになった） */
  const LLM_TESTS = 13;
  const generated = async () => {
    const carry = await carryFor();
    const pruned = pruneForCarryOver(GLIST, GTABLE, carry);
    return generateTests({ table: pruned.table, ledger, list: pruned.list });
  };

  it("規則：旗 ids の R-tsp-16 は台帳の旗 ids の文（既定値・選択肢の集合は作らない文、空の集計はコードが作る範囲を作らない文の後ろに今の文）。ほかの定義は ids off と同じ。規則の不備は on・off とも 0", () => {
    const on = testSpecRuleDefinitionsOf(ledger, true);
    const off = testSpecRuleDefinitionsOf(ledger);
    expect(ruleDefinitionDefects(on)).toEqual([]);
    expect(ruleDefinitionDefects(off)).toEqual([]);
    // 手 3e（#625）：欄の名前を指す文（R-tsp-07・09・11・12・13・14）と R-tsp-16 が場合の形。ID・why は同じで、ほかの定義は ids off と同じ
    const CASE_FORM_IDS = ["R-tsp-07", "R-tsp-09", "R-tsp-11", "R-tsp-12", "R-tsp-13", "R-tsp-14", "R-tsp-16"];
    expect(on.map((definition) => definition.id)).toEqual(off.map((definition) => definition.id));
    expect(on.map((definition) => definition.why)).toEqual(off.map((definition) => definition.why));
    expect(on.filter((definition) => !CASE_FORM_IDS.includes(definition.id))).toEqual(off.filter((definition) => !CASE_FORM_IDS.includes(definition.id)));
    for (const id of CASE_FORM_IDS) {
      expect(on.find((definition) => definition.id === id)?.text, id).not.toBe(off.find((definition) => definition.id === id)?.text);
    }
    const text = on.find((definition) => definition.id === "R-tsp-16")?.text ?? "";
    for (const row of PROPERTY_LEDGER) {
      if (row.rules.t2Ids !== null) expect(text, row.id).toContain(row.rules.t2Ids);
    }
    // 既定値・選択肢の集合の「作る」文は無く、空の集計の今の文（行ごと・月の見出しごとに使う）は残る。when の文は今のまま
    expect(text).not.toContain(DEFAULT_ROW.rules.t2 ?? "（無い）");
    expect(text).not.toContain(PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership")?.rules.t2 ?? "（無い）");
    // 空の集計の行ごと・月の見出しごとの文は場合の形（欄の名前が rows・targetId。#625）。when の文は今のまま
    expect(text).not.toContain(PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate")?.rules.t2 ?? "（無い）");
    expect(text).toContain("参照の行（rows）にその entity の行を置かない");
    expect(text).toContain(PROPERTY_LEDGER.find((entry) => entry.id === "when")?.rules.t2 ?? "（無い）");
    // 台帳の順：形の位置の文は t2IdsFormTexts の順に並ぶ
    let at = 0;
    for (const form of ledger.t2IdsFormTexts) {
      const found = text.indexOf(form, at);
      expect(found, form.slice(0, 20)).toBeGreaterThanOrEqual(at);
      at = found + form.length;
    }
    // 台帳を渡さなければ ids は効かない（今の定数）
    expect(testSpecRuleDefinitionsOf(undefined, true)).toBe(TEST_SPEC_RULE_DEFINITIONS);
  });

  it("(1) 要求：要件の一覧・確かめ方・所属に既定値と選択肢の集合の要件（R6・R7）が無く、集計の要件（R4・R8）はある。表の行は除かない。ids off との差は R-tsp-16 の文とこの 3 つの塊だけ。題材の言葉は無い", async () => {
    const on = await runG([idsResponse()]);
    const off = await runG([offResponse()], false);
    const onRequest = on.recording.structured[0]!;
    const offRequest = off.recording.structured[0]!;
    const [, listName, tableName, verificationName, ownershipName] = TEST_SPEC_DATA_NAMES;
    const idsOf = (input: string, name: string) =>
      (name === listName
        ? (dataBlockOf(input, name) as { requirements: { id: string }[] }).requirements
        : (dataBlockOf(input, name) as { requirementId: string }[]).map((entry) => ({ id: entry.requirementId }))
      ).map((entry) => entry.id);
    for (const name of [listName, verificationName, ownershipName]) {
      // 手 3d（#624）：構造の要件 R2 も要求に無い
      expect(idsOf(onRequest.input, name), name).toEqual(["R1", "R3", "R4", "R8"]);
      expect(idsOf(offRequest.input, name), name).toEqual(["R1", "R2", "R3", "R4", "R6", "R7", "R8"]);
    }
    expect(dataBlockOf(onRequest.input, tableName)).toEqual(dataBlockOf(offRequest.input, tableName));
    expect(dataNamesOf(onRequest.input)).toEqual(dataNamesOf(offRequest.input));
    for (const field of ["instructions", "documents", "schemaName", "maxOutputTokens"] as const) {
      expect(onRequest[field]).toEqual(offRequest[field]);
    }
    // schema は場合の形（手 3e・#625）。ids off は今の形
    expect(onRequest.schema).toEqual(testCasesSchemaOf(ledger));
    expect(offRequest.schema).toEqual(testSpecSchemaOf(ledger));
    // 規則の差は欄の名前を指す文（R-tsp-07・09・11・12・13・14）と R-tsp-16 だけ（#625）
    const ruleDiff = (onRequest.rules ?? []).map((text, index) => (text === offRequest.rules?.[index] ? null : index)).filter((index) => index !== null);
    const indexOf = (id: string) => TEST_SPEC_RULE_DEFINITIONS.findIndex((definition) => definition.id === id);
    const common = (onRequest.rules ?? []).length - TEST_SPEC_RULE_DEFINITIONS.length;
    expect(ruleDiff).toEqual(["R-tsp-07", "R-tsp-09", "R-tsp-11", "R-tsp-12", "R-tsp-13", "R-tsp-14", "R-tsp-16"].map((id) => common + indexOf(id)));
    expectNoAcceptanceMaterial([requestText(onRequest)]);
  });

  it("(1) 正例：行ごとと見出しごと × 月の集計の要件（R8）に LLM が正常・境界・異常を書いた応答が 1 回で通り、組は LLM の試験のあとにコードの試験が並び、網羅の単位に R8 の単位とコードの試験の単位がある", async () => {
    const { outcome, recording } = await runG([idsResponse()]);
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(recording.structured).toHaveLength(1);
    const made = await generated();
    const ids = outcome.value.suite.tests.map((test) => test.id);
    expect(ids.slice(LLM_TESTS)).toEqual(made.tests.map((test) => test.id));
    expect(ids.slice(0, LLM_TESTS).some(isGeneratedTestId)).toBe(false);
    expect(outcome.value.suite.tests.slice(LLM_TESTS)).toEqual(made.tests);
    const units = outcome.value.coverage.map((unit) => JSON.parse(unit.key) as Record<string, unknown>);
    const has = (requirementId: string, targetId: string, kind: string, observes: string) =>
      units.some((unit) => unit["requirementId"] === requirementId && unit["targetId"] === targetId && unit["kind"] === kind && unit["observes"] === observes);
    expect(has("R8", "c.itemCount", "boundary", "empty-aggregate")).toBe(true);
    expect(has("R8", "c.itemCount", "abnormal", "empty-aggregate")).toBe(true);
    expect(has("R8", "c.byMonth", "boundary", "empty-aggregate")).toBe(true);
    expect(has("R4", "c.base", "boundary", "empty-aggregate")).toBe(true);
    expect(has("R4", "c.byKind", "abnormal", "empty-aggregate")).toBe(true);
    expect(has("R6", "f.item.kind", "normal", "default-value")).toBe(true);
    expect(has("R7", "f.item.kind", "normal", "enum-membership")).toBe(true);
    // 既定値・選択肢の集合の要件の異常・境界の不足は今までどおり外れ（通った）、分類は T1 の分類（ruled）
    expect(outcome.value.natures.get("R6")).toBe("ruled");
    expect(outcome.value.natures.get("R7")).toBe("ruled");
  });

  it("(1) 負例：行ごとの集計の境界か異常を省いた応答は「boundary の試験が無い」「abnormal の試験が無い」で落ちる（コードが作る範囲でないので免除されない。位置は要求の一覧の R8）", async () => {
    for (const omit of ["boundary", "abnormal"] as const) {
      // 月の見出しの境界も省く（R8 の境界はこれと行ごとの 2 本）
      const r8 = r8Tests({ omit }).filter((test) => omit !== "boundary" || test["id"] !== "r8-month-empty");
      const bad = idsResponse([], r8);
      const { outcome } = await runG([bad, bad]);
      if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
      // 位置は要求の一覧の R8（手 3d（#624）で R2 が要求に無いので 3）
      expect(outcome.failure.problems, omit).toEqual([{ field: "requirements[3]", message: `${omit} の試験が無い` }]);
    }
  });

  it("(2) 応答にコードが作る試験と同じ組の試験（既定値・選択肢の集合・アプリ全体の空・見出しごと × 選択肢の未読）があれば固定文で落ち、予約の接頭辞の ID も落ちる", async () => {
    const field = (requirementId: string, observes: string, id: string) => ({
      ...rawTest({ id, requirementId, targetKind: "field", roleId: "f.item.kind", operation: "validate", observes, input: {} }),
      expected: { kind: "ok", value: observes === "default-value" ? JSON.stringify("alpha") : JSON.stringify(["alpha", "beta"]), code: null },
    });
    const extra = [
      field("R6", "default-value", "r6-default"),
      field("R7", "enum-membership", "r7-enum"),
      aggTest({ id: "r4-base-empty", requirementId: "R4", roleId: "c.base", kind: "boundary", observes: "empty-aggregate", empty: ["e.item"], value: 0 }),
      aggTest({ id: "r4-kind-unread", requirementId: "R4", roleId: "c.byKind", kind: "abnormal", observes: "empty-aggregate", value: null }),
    ];
    const bad = idsResponse(extra);
    const { outcome, recording } = await runG([bad, bad]);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    // 位置は場合の添字（#625）。合併の並びは要件の一覧の順に要件ごと（一覧に無い R6・R7 は末尾。Issue #651）
    const order = requestListedIds(recording.structured[0]!);
    const at = (offset: number) => `cases[${String(mergedCaseIndexOf(bad, order, ["r6-default", "r7-enum", "r4-base-empty", "r4-kind-unread"][offset] ?? ""))}]`;
    expect(outcome.failure.problems).toContainEqual({ field: `${at(0)}.observes`, message: DEFAULT_ROW.t2?.messages.notAllowed });
    expect(outcome.failure.problems).toContainEqual({
      field: `${at(1)}.observes`,
      message: PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership")?.t2?.messages.notAllowed,
    });
    expect(outcome.failure.problems).toContainEqual({ field: `${at(2)}.observes`, message: AGG.messages.notAllowed });
    expect(outcome.failure.problems).toContainEqual({ field: `${at(3)}.observes`, message: AGG.messages.notAllowed });
    // 予約の接頭辞の ID は場合の形では書けない（試験 ID はコードが case: と連番で振る。#625）。v1 の形の組の口は今までどおり落とす
    expect(outcome.failure.problems.some((problem) => problem.message === GENERATED_TEST_ID_MESSAGE)).toBe(false);
    const mine: FixedTest = {
      id: `${GENERATED_TEST_ID_PREFIX}mine`,
      target: { requirementId: "R1", kind: "field", roleId: "f.item.amount" },
      kind: "normal",
      operation: "validate",
      clock: "2026-09-16T12:00:00+09:00",
      input: {},
      referenceData: [],
      expected: { kind: "ok", value: true },
    };
    const llmSuite = { tests: [mine] };
    expect(checkGeneratedOverlap(llmSuite, new Map(), await generated(), GTABLE, ledger)).toEqual([{ field: "tests[0].id", message: GENERATED_TEST_ID_MESSAGE }]);
    // 同じ応答から重なりの試験を除けば 1 回で通る（重なりのほかに落ちる理由は無い）
    const { outcome: clean } = await runG([idsResponse()]);
    expect(clean.ok).toBe(true);
  });

  it("(3) 二点測定：手 2c の負例（空を明示して null を期待・空と明示せず 0 の並びを期待）は ids off（前の手の旗だけ on）で T2' に落ちるが、ids on では LLM がその試験を書かず、コードの試験が組にあって 1 回で通る", async () => {
    const r6r7 = [
      { ...rawTest({ id: "r6-default", requirementId: "R6", targetKind: "field", roleId: "f.item.kind", operation: "validate", observes: "default-value", input: {} }), expected: { kind: "ok", value: JSON.stringify("alpha"), code: null } },
      { ...rawTest({ id: "r7-enum", requirementId: "R7", targetKind: "field", roleId: "f.item.kind", operation: "validate", observes: "enum-membership", input: {} }), expected: { kind: "ok", value: JSON.stringify(["alpha", "beta"]), code: null } },
    ];
    const wrong = [
      aggTest({ id: "r4-base-empty", requirementId: "R4", roleId: "c.base", kind: "boundary", observes: "empty-aggregate", empty: ["e.item"], value: null }),
      aggTest({ id: "r4-kind-unread", requirementId: "R4", roleId: "c.byKind", kind: "abnormal", observes: "empty-aggregate", value: [{ heading: "alpha", value: 0 }, { heading: "beta", value: 0 }] }),
    ];
    // ids off は R6・R7 も要求の一覧にあるので、分類と試験を LLM が書く
    const offBad = response([...offResponse([...r6r7, ...wrong]).tests], [...NATURES, { requirementId: "R6", nature: "ruled" }, { requirementId: "R7", nature: "ruled" }]);
    const before = await runG([offBad, offBad], false);
    if (before.outcome.ok || before.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    // ids off の応答は R2 の構造の検査 1 本を含む（位置は LLM_TESTS + 1 から）
    expect(before.outcome.failure.problems).toEqual([
      { field: `tests[${String(LLM_TESTS + 1 + 2)}].expected`, message: AGG.messages.expected },
      { field: `tests[${String(LLM_TESTS + 1 + 3)}].expected`, message: AGG.messages.expected },
    ]);
    // ids on：同じ要件の空の試験を LLM は書かない。コードの試験（空を明示した 0・触れない null）が組にある
    const after = await runG([idsResponse()]);
    if (!after.outcome.ok) throw new Error(`通るはず：${JSON.stringify(after.outcome.failure)}`);
    expect(after.recording.structured).toHaveLength(1);
    const byRole = (roleId: string) =>
      after.outcome.ok ? after.outcome.value.suite.tests.filter((test) => isGeneratedTestId(test.id) && test.target.roleId === roleId) : [];
    expect(byRole("c.base").map((test) => [test.kind, test.inputContract?.emptyEntities, test.expected])).toEqual([
      ["boundary", ["e.item"], { kind: "ok", value: 0 }],
      ["abnormal", [], { kind: "ok", value: null }],
    ]);
    expect(byRole("c.byKind").map((test) => test.expected)).toEqual([
      { kind: "ok", value: [{ heading: "alpha", value: 0 }, { heading: "beta", value: 0 }] },
      { kind: "ok", value: null },
    ]);
  });

  it("(4) 組の SHA・網羅の単位・観測する性質の写像はコードの試験を含む組で測る（SHA は 2 回同じ・コードの試験を除くと変わる）。免除の 2 文は今までどおり外れる", async () => {
    const { outcome } = await runG([idsResponse()]);
    if (!outcome.ok) throw new Error("通るはず");
    const { suite, observes } = outcome.value;
    expect(outcome.value.sha256).toBe(await testSuiteSha256(suite, observes));
    expect(outcome.value.coverage).toEqual(coverageUnitsOf({ suite, observes, natures: outcome.value.natures }));
    const made = await generated();
    for (const [id, observed] of made.observes) expect(observes.get(id)).toBe(observed);
    const llmOnly = { ...suite, tests: suite.tests.filter((test) => !isGeneratedTestId(test.id)) };
    expect(await testSuiteSha256(llmOnly, observes)).not.toBe(outcome.value.sha256);
    // 免除：全部の一覧の v1 の検査で R6・R7 の abnormal・boundary の不足だけが出て、外したあとは 0
    const carry = await carryFor();
    const pruned = pruneForCarryOver(GLIST, GTABLE, carry);
    const raw = checkSuitePlan(pruned.list, suite, pruned.conversion.design, outcome.value.natures);
    expect(raw).toEqual([
      { field: "requirements[4]", message: "abnormal の試験が無い" },
      { field: "requirements[4]", message: "boundary の試験が無い" },
      { field: "requirements[5]", message: "abnormal の試験が無い" },
      { field: "requirements[5]", message: "boundary の試験が無い" },
    ]);
    expect(exemptLedgerProblems(raw, pruned.list, ledgerTargetsOf(pruned.table, ledger))).toEqual([]);
  });

  it("(5) 月の見出しの照合は今のまま：LLM が書いた月の見出しごとの空の試験は、T2' が各値だけを照らして 3 か月でも 6 か月でも通る（コードが見出しの数を決めない）", async () => {
    for (const months of [MONTHS_3, MONTHS_6]) {
      const { outcome } = await runG([idsResponse([], r8Tests({ months }))]);
      expect(outcome.ok, JSON.stringify(months)).toBe(true);
    }
  });

  it("(5) B4 は月の見出しの期待の全体（見出しと長さ）を宣言の last で照らす：3 か月と last 3・6 か月と last 6 は不一致 0、3 か月の期待に last 6 は不一致（通す側に変えない）", async () => {
    const monthTest = (months: readonly unknown[]): FixedTest => ({
      id: "m-empty",
      target: { requirementId: "R8", kind: "computation", roleId: "c.byMonth" },
      kind: "boundary",
      operation: "aggregate",
      clock: "2026-09-16T12:00:00+09:00",
      input: {},
      inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: ["e.item"] },
      referenceData: [],
      expected: { kind: "ok", value: months },
    });
    const observes = new Map<string, TestObserves>([["m-empty", "empty-aggregate" as TestObserves]]);
    const evaluator = createV11aEvaluator({ table: GTABLE, observes, ledger });
    const list: RequirementList = { ...GLIST, requirements: GLIST.requirements.filter((requirement) => requirement.id === "R8") };
    const table: NameTable = { ...GTABLE, ownership: GTABLE.ownership.filter((entry) => entry.requirementId === "R8") };
    const mismatchesOf = async (months: readonly unknown[], last: number) => {
      const source = FIXTURE_YAML.replace("      last: 6\n", `      last: ${String(last)}\n`);
      const suite: TestSuite = { classifications: [{ requirementId: "R8", nature: "ruled" }], tests: [monthTest(months)] };
      const report = await evaluator.report(
        { source },
        { list, suite, correspondences: correspondenceFromTable(table), ownership: toV1(table).ownership },
      );
      if (report.testRun === null) throw new Error("評価に届かない");
      expect(report.testRun.unresolved, JSON.stringify(report.testRun.unresolved)).toEqual([]);
      return report.testRun.mismatches.length;
    };
    expect(await mismatchesOf(MONTHS_3, 3)).toBe(0);
    expect(await mismatchesOf(MONTHS_6, 6)).toBe(0);
    expect(await mismatchesOf(MONTHS_3, 6)).toBe(1);
  });

  it("(fail-closed) 除いた要件ごとにコードの試験が 1 本以上ある。コードの試験を作れない要件（選択肢の項目を引けない R7）は除かず、T2 の一覧に残って試験が無ければ「要件の試験が無い」で落ちる（免除しない）", async () => {
    const made = await generated();
    for (const id of made.excludedRequirementIds) expect(made.tests.filter((test) => test.target.requirementId === id).length, id).toBeGreaterThanOrEqual(1);
    const { outcome } = await runG([idsResponse()]);
    if (!outcome.ok) throw new Error("通るはず");
    for (const id of made.excludedRequirementIds) {
      expect(outcome.value.suite.tests.filter((test) => test.target.requirementId === id && isGeneratedTestId(test.id)).length, id).toBeGreaterThanOrEqual(1);
    }
    // R7 が選択肢の項目を所属させない表（確かめ方の対象が引けない）
    const unresolvable: NameTable = { ...GTABLE, ownership: GTABLE.ownership.map((entry) => (entry.requirementId === "R7" ? { ...entry, roles: [] } : entry)) };
    const bad = response(idsResponse().tests, [...NATURES.filter((entry) => entry.requirementId !== "R2"), { requirementId: "R7", nature: "ruled" }]);
    const { outcome: failed, recording } = await runG([bad, bad], true, unresolvable);
    const listed = dataBlockOf(recording.structured[0]!.input, TEST_SPEC_DATA_NAMES[1]) as { requirements: { id: string }[] };
    expect(listed.requirements.map((requirement) => requirement.id)).toEqual(["R1", "R3", "R4", "R7", "R8"]);
    if (failed.ok || failed.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(failed.failure.problems).toEqual([{ field: "requirements[3]", message: "要件の試験が無い" }]);
  });

  it("(6) コードが作らない空の集計の要件：J2 が existence-only と決めた R4 にはコードの試験を足さず、R4 は T2 の一覧に残り、LLM の試験は今までどおり照らす（境界を書けば v1 の検査で落ちる）", async () => {
    const judge = createFakeJudge({ [natureQuestionName("R4")]: choice("existence-only", 0.9) });
    const natures = NATURES.map((entry) => (entry.requirementId === "R4" ? { ...entry, nature: "existence-only" as const } : entry));
    const r4Normal = rawTest({ id: "r4-normal", requirementId: "R4", targetKind: "computation", roleId: "c.rate", operation: "compute", observes: "value" });
    const base = [...r1Validate(), ...r3When(), r4Normal, ...r8Tests()];
    const runJ = async (outputs: readonly unknown[]) =>
      run(asCases(outputs), { plan: GPLAN, list: GLIST, table: GTABLE, carryOver: await carryFor(), ledger, ids: true, judge });
    const withoutR2 = natures.filter((entry) => entry.requirementId !== "R2");
    const { outcome, recording } = await runJ([response(base, withoutR2)]);
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(outcome.value.natures.get("R4")).toBe("existence-only");
    const aggregateOfR4 = (tests: readonly FixedTest[]) =>
      tests.some((test) => isGeneratedTestId(test.id) && test.target.requirementId === "R4" && test.operation === "aggregate");
    expect(aggregateOfR4(outcome.value.suite.tests)).toBe(false);
    // R6・R7 のコードの試験はある（手 3d（#624）で R2 の構造の検査と R4 の画面の構造の確認もコードが作る。画面は種類に依らない）
    expect(outcome.value.suite.tests.filter((test) => isGeneratedTestId(test.id)).map((test) => [test.target.requirementId, test.operation])).toEqual([
      ["R2", "structure"],
      ["R4", "screen"],
      ["R6", "validate"],
      ["R7", "validate"],
    ]);
    const listed = dataBlockOf(recording.structured[0]!.input, TEST_SPEC_DATA_NAMES[1]) as { requirements: { id: string }[] };
    expect(listed.requirements.map((requirement) => requirement.id)).toContain("R4");
    // LLM が R4 の空の境界を書けば、在ることだけの要件として v1 の検査で落ちる（免除されない）
    const boundary = aggTest({ id: "r4-base-empty", requirementId: "R4", roleId: "c.base", kind: "boundary", observes: "empty-aggregate", empty: ["e.item"], value: 0 });
    const bad = response([...base, boundary], withoutR2);
    const { outcome: failed } = await runJ([bad, bad]);
    if (failed.ok || failed.failure.kind !== "unmet") throw new Error("unmet でない");
    // 位置は合併の並び（要件の一覧の順に要件ごと。Issue #651）での R4 の境界の場合の添字
    const order = requestListedIds(recording.structured[0]!);
    expect(failed.failure.problems).toContainEqual({ field: `cases[${String(mergedCaseIndexOf(bad, order, "r4-base-empty"))}]`, message: "在ることだけの要件なので、boundary の試験を作らない" });
  });

  it("(手 3g・#651 (3)) 反する再分類：初回に J2 が existence-only と決めた R4 は、同じ束の R8 の問題で 2 回目を呼んでも保持され再回答されない（一覧に無い・R4 の J2 は 0）。R8 が 2 回目で T1 と食い違えば合併後に J2 を 1 回だけ聞き、決めた種類で検査し、R4 に空の集計の異常・境界を足さない", async () => {
    const recorded = recordingJudge(
      createFakeJudge({ [natureQuestionName("R4")]: choice("existence-only", 0.9), [natureQuestionName("R8")]: choice("ruled", 0.9) }),
    );
    const natures = NATURES.filter((entry) => entry.requirementId !== "R2").map((entry) => (entry.requirementId === "R4" ? { ...entry, nature: "existence-only" as const } : entry));
    const r4Normal = rawTest({ id: "r4-normal", requirementId: "R4", targetKind: "computation", roleId: "c.rate", operation: "compute", observes: "value" });
    const first = response([...r1Validate(), ...r3When(), r4Normal, ...r8Tests({ omit: "abnormal" })], natures);
    // 2 回目の台本は全要件を書くが、偽物の口は書き直さない要件（R1・R3・R4）の分類と場合を除いて返す。R8 は existence-only と再分類する
    const second = response(
      [...r1Validate(), ...r3When(), r4Normal, ...r8Tests()],
      natures.map((entry) => (entry.requirementId === "R8" ? { ...entry, nature: "existence-only" as const } : entry)),
    );
    const { outcome, recording } = await run(asCases([first, second]), { plan: GPLAN, list: GLIST, table: GTABLE, carryOver: await carryFor(), ledger, ids: true, judge: recorded.judge });
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(outcome.value.rounds).toBe(2);
    expect(requestListedIds(recording.structured[1]!)).toEqual(["R8"]);
    expect(requestRetainedIds(recording.structured[1]!)).toEqual(["R1", "R3", "R4"]);
    // J2 は初回に R4、2 回目の合併後に R8 を 1 回ずつ（R4 は再回答が無いので聞かない）
    expect(recorded.requests.map((request) => Object.keys(request.questions))).toEqual([[natureQuestionName("R4")], [natureQuestionName("R8")]]);
    expect(outcome.value.natures.get("R4")).toBe("existence-only");
    expect(outcome.value.natures.get("R8")).toBe("ruled");
    // J2 が existence-only を採用した R4 には、2 回目でも空の集計の異常・境界（コードの試験）を足さない
    expect(outcome.value.suite.tests.some((test) => isGeneratedTestId(test.id) && test.target.requirementId === "R4" && test.operation === "aggregate")).toBe(false);
    // R4 の場合は初回のまま組にある
    expect(outcome.value.suite.tests.filter((test) => test.target.requirementId === "R4" && !isGeneratedTestId(test.id)).map((test) => test.target.roleId)).toEqual(["c.rate"]);
  });

  it("(6) コードが作らない空の集計の要件：T1 の分類が existence-only の R4（T2 は ruled・判定なしで ruled に倒す）にはコードの試験を作らず、LLM が書いた空の試験を台帳の表で照らす（違えば落ち、合えば通る）", async () => {
    const table: NameTable = { ...GTABLE, classification: GTABLE.classification.map((entry) => (entry.requirementId === "R4" ? { ...entry, nature: "existence-only" as const } : entry)) };
    const empty = (value: unknown) => aggTest({ id: "r4-base-empty", requirementId: "R4", roleId: "c.base", kind: "boundary", observes: "empty-aggregate", empty: ["e.item"], value });
    const wrong = idsResponse([empty(null)]);
    const { outcome: failed, recording } = await runG([wrong, wrong], true, table);
    if (failed.ok || failed.failure.kind !== "unmet") throw new Error("unmet でない");
    // 位置は合併の並び（要件の一覧の順に要件ごと。Issue #651）での R4 の空の場合の添字
    const order = requestListedIds(recording.structured[0]!);
    const at = mergedCaseIndexOf(wrong, order, "r4-base-empty");
    expect(failed.failure.problems).toEqual([{ field: `cases[${String(at)}].expected`, message: AGG.messages.expected }]);
    const { outcome } = await runG([idsResponse([empty(0)])], true, table);
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(outcome.value.natures.get("R4")).toBe("ruled");
    expect(outcome.value.suite.tests.some((test) => isGeneratedTestId(test.id) && test.target.requirementId === "R4" && test.operation === "aggregate")).toBe(false);
    // LLM が書いた空の試験は展開した試験として組にある（試験 ID はコードが振る。#625）
    expect(outcome.value.suite.tests.some((test) => test.id === `${TEST_CASE_ID_PREFIX}${String(at + 1)}` && test.target.roleId === "c.base" && test.kind === "boundary")).toBe(true);
  });

  it("旗 ids でも台帳を渡さない走りは今のまま（コードの試験を作らない）", async () => {
    const plain = await run([passing()], { ids: true });
    const off = await run([passing()]);
    expect(plain.outcome).toEqual(off.outcome);
    expect(JSON.stringify(plain.recording.structured)).toBe(JSON.stringify(off.recording.structured));
  });
});

// ── 旗 v12.ids：構造の検査と画面・在ることの構造の確認はコードが作る（手 3d。Issue #624）──────────────────────

describe("旗 v12.ids：構造の検査と画面・在ることの構造の確認はコードが作り、T2 には値の要る試験だけを書かせる（Issue #624）", () => {
  const ledger = PROPERTY_LEDGER_VIEW;
  const VIEW_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "view-structure");
  const EXISTENCE_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "existence");
  if (VIEW_ROW?.rules.t2Ids == null || EXISTENCE_ROW?.rules.t2Ids == null) throw new Error("前提が壊れた：台帳の旗 ids の文が無い");
  const requirementOf = (id: string, text: string) => ({ id, text, quote: text, position: { start: 0, end: text.length } });
  const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });
  /** R6：画面だけを所属させる決まりの要件（fixed-test・ruled）。R7：画面と項目を所属させる決まりの要件 */
  const DLIST: RequirementList = {
    ...fixtureList(),
    requirements: [
      ...fixtureList().requirements,
      requirementOf("R6", "担当者の一覧と項目の一覧の画面は、決まった並びで出す。"),
      requirementOf("R7", "項目の一覧で題名を見られ、題名は空にできない。"),
    ],
  };
  const baseTable = withCheckTargets(fixtureTable());
  const DTABLE: NameTable = {
    ...baseTable,
    ownership: [...baseTable.ownership, { requirementId: "R6", roles: ["s.members", "s.items"].map(stated) }, { requirementId: "R7", roles: ["s.items", "f.item.title"].map(stated) }],
    verification: [...baseTable.verification, { requirementId: "R6", kind: "fixed-test" }, { requirementId: "R7", kind: "fixed-test" }],
    classification: [...baseTable.classification, { requirementId: "R6", nature: "ruled" }, { requirementId: "R7", nature: "ruled" }],
  };
  const DPLAN = fixturePlan(DLIST);
  async function carryD(table: NameTable = DTABLE): Promise<CarryOver> {
    const tableSha256 = await nameTableSha256(table);
    const targets = table.verification.filter((entry) => entry.kind !== "unresolved").map((entry) => entry.requirementId);
    return deriveCarryOver({ list: DLIST, table, semanticCheck: { tableSha256, judgments: targets.map((requirementId) => ({ requirementId, verdict: "accept" as const })) } });
  }
  const runD = async (outputs: readonly unknown[], ids = true, table: NameTable = DTABLE) =>
    run(ids ? asCases(outputs) : outputs, { plan: DPLAN, list: DLIST, table, carryOver: await carryD(table), ledger, ...(ids ? { ids: true } : {}) });
  const NATURES_D: readonly NatureRow[] = [
    { requirementId: "R1", nature: "ruled" },
    { requirementId: "R3", nature: "ruled" },
    { requirementId: "R4", nature: "ruled" },
    { requirementId: "R6", nature: "ruled" },
    { requirementId: "R7", nature: "ruled" },
  ];
  /** R7 の項目（題名）の検査の正常・異常・境界（`omit` で欠けを作る） */
  const r7Validate = (omit?: "abnormal") =>
    KINDS.filter((kind) => kind !== omit).map((kind) =>
      rawTest({ id: `r7-${kind}`, requirementId: "R7", targetKind: "field", roleId: "f.item.title", kind, operation: "validate", observes: "validation" }),
    );
  /** ids on の通る応答（R2 は要求に無い。R6 は画面だけなので LLM は書かない。R7 は項目の 3 種類だけ） */
  const idsTests = () => [...r1Validate(), ...r3When(), ...r4Compute(), ...r7Validate()];
  const idsOk = (extra: readonly Record<string, unknown>[] = [], natures: readonly NatureRow[] = NATURES_D) => response([...idsTests(), ...extra], natures);
  const LLM_COUNT = 12;

  it("(1) 要求：要件の一覧・確かめ方・所属に構造の要件 R2 が無く、画面の要件 R6・R7 はある。規則の文の「作らない」は構造の検査と screen 操作だけ。schema の operation の enum に structure が無く assertion は null だけ。題材の言葉は無い", async () => {
    const { outcome, recording } = await runD([idsOk()]);
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0]!;
    const [, listName, , verificationName, ownershipName] = TEST_SPEC_DATA_NAMES;
    expect((dataBlockOf(request.input, listName) as { requirements: { id: string }[] }).requirements.map((entry) => entry.id)).toEqual(["R1", "R3", "R4", "R6", "R7"]);
    for (const name of [verificationName, ownershipName]) {
      expect((dataBlockOf(request.input, name) as { requirementId: string }[]).map((entry) => entry.requirementId), name).toEqual(["R1", "R3", "R4", "R6", "R7"]);
    }
    const r16 = (request.rules ?? []).find((text) => text.includes("観測する性質（observes）を 1 つ書く")) ?? "";
    expect(r16).toContain(VIEW_ROW.rules.t2Ids ?? "");
    expect(r16).toContain(EXISTENCE_ROW.rules.t2Ids ?? "");
    // 新しい文の「作らない」の対象は、構造の検査と画面の試験・entity が在ることの試験だけ（欄の名前は場合の形。#625）
    expect(VIEW_ROW.rules.t2Ids).toMatch(/^構造の検査と画面の試験（画面・項目 × screen の view-structure）は作らない/);
    expect(EXISTENCE_ROW.rules.t2Ids).toMatch(/^entity が在ることの試験（observes は existence）は作らない/);
    // schema は場合の形（操作も assertion も無い。#625）
    expect(request.schema).toEqual(testCasesSchemaOf(ledger));
    expect(strictDefectsOf(request.schema)).toEqual([]);
    // ids off（前の手の旗だけ on）の schema は今のまま（structure があり assertion は写像か null）
    expect(testSpecSchemaOf(ledger)).toEqual(testSpecSchemaOf(ledger, false));
    expect(testSpecSchemaOf(ledger).properties.tests.items.properties.operation.enum).toEqual([...TEST_OPERATIONS]);
    expect(testSpecSchemaOf(undefined, true)).toBe(TEST_SPEC_SCHEMA);
    expectNoAcceptanceMaterial([requestText(request)]);
  });

  it("(1) 正例：1 回で通り、組は LLM の試験のあとに構造の検査（R2）・画面の構造の確認（R4 の s.overview・R6 の 2 画面・R7 の s.items）が並ぶ。R6 の abnormal・boundary の不足は台帳の型と所属で免除される", async () => {
    const { outcome, recording } = await runD([idsOk()]);
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(recording.structured).toHaveLength(1);
    const generatedOnes = outcome.value.suite.tests.slice(LLM_COUNT);
    expect(generatedOnes.every((test) => isGeneratedTestId(test.id))).toBe(true);
    expect(generatedOnes.map((test) => [test.target.requirementId, test.target.roleId, test.operation, outcome.value.observes.get(test.id)])).toEqual([
      ["R2", "s.members", "structure", "view-structure"],
      ["R4", "s.overview", "screen", "view-structure"],
      ["R6", "s.members", "screen", "view-structure"],
      ["R6", "s.items", "screen", "view-structure"],
      ["R7", "s.items", "screen", "view-structure"],
    ]);
    // (5) 組の SHA・網羅の単位・観測する性質の写像はコードの試験を含む
    const { suite, observes } = outcome.value;
    expect(outcome.value.sha256).toBe(await testSuiteSha256(suite, observes));
    expect(outcome.value.coverage).toEqual(coverageUnitsOf({ suite, observes, natures: outcome.value.natures }));
    const keys = outcome.value.coverage.map((unit) => JSON.parse(unit.key) as Record<string, unknown>);
    expect(keys.some((unit) => unit["requirementId"] === "R2" && unit["targetId"] === "s.members")).toBe(true);
    expect(keys.some((unit) => unit["requirementId"] === "R6" && unit["targetId"] === "s.items" && unit["observes"] === "view-structure")).toBe(true);
    for (const test of generatedOnes) expect(observes.has(test.id)).toBe(true);
  });

  it("(2) LLM の場合が画面の行を対象にすれば（操作は screen に展開される）固定文で落ちる。項目の画面の構造は評価の方法の表で落ちる。構造の検査は場合の schema で書けない（同じ応答から除けば通る）", async () => {
    const screen = rawTest({ id: "r7-screen", requirementId: "R7", targetKind: "screen", roleId: "s.items", operation: "screen", observes: "view-structure" });
    const entityScreen = rawTest({ id: "r1-exist", requirementId: "R4", targetKind: "screen", roleId: "s.overview", operation: "screen", observes: "view-structure" });
    for (const extra of [screen, entityScreen]) {
      const bad = idsOk([extra]);
      const { outcome, recording } = await runD([bad, bad]);
      if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error(`unmet でない：${String(extra["id"])} ${JSON.stringify(outcome)}`);
      // 操作はコードが対象の行から導くので、位置は場合の対象（#625）。添字は合併の並び（要件の一覧の順に要件ごと。Issue #651）
      const at = mergedIndexAt(bad, requestListedIds(recording.structured[0]!), LLM_COUNT);
      expect(outcome.failure.problems, String(extra["id"])).toContainEqual({ field: `cases[${String(at)}].targetId`, message: OWNERSHIP_STRUCTURE_NOT_ALLOWED });
    }
    // 項目を対象に view-structure を書いた場合は validate に展開され、評価の方法の表に無い組で落ちる（項目 × screen は書けない）
    const fieldScreen = idsOk([rawTest({ id: "r7-field-screen", requirementId: "R7", targetKind: "field", roleId: "f.item.title", operation: "screen", observes: "view-structure" })]);
    const failed = await runD([fieldScreen, fieldScreen]);
    if (failed.outcome.ok || failed.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    const fieldAt = mergedIndexAt(fieldScreen, requestListedIds(failed.recording.structured[0]!), LLM_COUNT);
    expect(failed.outcome.failure.problems).toContainEqual({ field: `cases[${String(fieldAt)}].observes`, message: "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い" });
    // #624 (2) の structure の負例の置き換え（手 3e・#625）：場合の形で構造の検査を書こうとした場合も、LLM の structure・screen の試験として
    // 落ちる。view-shows の検査の代わりに画面の行を対象にした場合 → #624 の固定文、field-type の検査の代わりに項目に existence を
    // 書いた場合（validate × existence）→ 評価の方法の表の固定文
    const showsLike = idsOk([rawTest({ id: "r7-shows-like", requirementId: "R7", targetKind: "screen", roleId: "s.items", operation: "screen", observes: "view-structure", expected: { kind: "ok", value: "true", code: null } })]);
    const showsFailed = await runD([showsLike, showsLike]);
    if (showsFailed.outcome.ok || showsFailed.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(showsFailed.outcome.failure.problems).toContainEqual({ field: `cases[${String(LLM_COUNT)}].targetId`, message: OWNERSHIP_STRUCTURE_NOT_ALLOWED });
    const typeLike = idsOk([rawTest({ id: "r7-type-like", requirementId: "R7", targetKind: "field", roleId: "f.item.title", operation: "validate", observes: "existence", expected: { kind: "ok", value: "true", code: null } })]);
    const typeFailed = await runD([typeLike, typeLike]);
    if (typeFailed.outcome.ok || typeFailed.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(typeFailed.outcome.failure.problems).toContainEqual({ field: `cases[${String(LLM_COUNT)}].observes`, message: "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い" });
    // 場合の schema には操作も assertion も無い（構造の検査を構文で書けない）
    const items = (testCasesSchemaOf(ledger).properties.cases.items.properties) as Record<string, unknown>;
    expect(Object.keys(items)).not.toContain("operation");
    expect(Object.keys(items)).not.toContain("assertion");
    const { outcome } = await runD([idsOk()]);
    expect(outcome.ok).toBe(true);
  });

  it("(3) 二点測定：「structure に assertion 無し」の応答は ids off（前の手の旗だけ on）で形で落ちるが、ids on では schema で書けず（応答に構造の検査が無い）、コードの試験が組にあって 1 回で通る", async () => {
    const noAssertion = { ...rawTest({ id: "r2-shows", requirementId: "R2", targetKind: "screen", roleId: "s.members", operation: "structure", observes: "view-structure" }), assertion: null };
    const offBad = response([...r1Validate(), noAssertion, ...r3When(), ...r4Compute(), ...r7Validate(), rawTest({ id: "r6-a", requirementId: "R6", targetKind: "screen", roleId: "s.items", operation: "screen", observes: "view-structure" }), rawTest({ id: "r6-b", requirementId: "R6", targetKind: "screen", roleId: "s.items", kind: "abnormal", operation: "screen", observes: "view-structure" }), rawTest({ id: "r6-c", requirementId: "R6", targetKind: "screen", roleId: "s.items", kind: "boundary", operation: "screen", observes: "view-structure" })], [...NATURES_D, { requirementId: "R2", nature: "existence-only" }]);
    const before = await runD([offBad, offBad], false);
    if (before.outcome.ok) throw new Error("落ちるはず");
    expect(before.outcome.failure.kind).toBe("malformed");
    if (before.outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(before.outcome.failure.problems).toContainEqual({ field: "tests[3].assertion", message: "操作が structure なら、構造の検査の中身（assertion）が要る" });
    const after = await runD([idsOk()]);
    if (!after.outcome.ok) throw new Error(`通るはず：${JSON.stringify(after.outcome.failure)}`);
    expect(after.recording.structured).toHaveLength(1);
    expect(after.outcome.value.suite.tests.filter((test) => test.target.requirementId === "R2").map((test) => [test.operation, test.assertion])).toEqual([
      ["structure", { check: "view-shows", role: "f.member.title" }],
    ]);
  });

  it("(3) 二点測定：画面だけの決まりの要件に normal 1 本だけの応答は ids off で「abnormal・boundary の試験が無い」で落ちるが、ids on ではコードが画面の試験を作り、免除が台帳の型と所属で効いて 1 回で通る", async () => {
    const r6Normal = rawTest({ id: "r6-normal", requirementId: "R6", targetKind: "screen", roleId: "s.items", operation: "screen", observes: "view-structure" });
    const offOnlyNormal = response([...r1Validate(), ...r2Structure(), ...r3When(), ...r4Compute(), ...r7Validate(), r6Normal], [...NATURES_D, { requirementId: "R2", nature: "existence-only" }]);
    const before = await runD([offOnlyNormal, offOnlyNormal], false);
    if (before.outcome.ok || before.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    // 位置は持ち越し（R5）を除いた一覧の R6
    const r6Index = DLIST.requirements.filter((requirement) => requirement.id !== "R5").findIndex((requirement) => requirement.id === "R6");
    expect(before.outcome.failure.problems).toEqual([
      { field: `requirements[${String(r6Index)}]`, message: "abnormal の試験が無い" },
      { field: `requirements[${String(r6Index)}]`, message: "boundary の試験が無い" },
    ]);
    const after = await runD([idsOk()]);
    expect(after.outcome.ok).toBe(true);
    expect(after.recording.structured).toHaveLength(1);
  });

  it("(4) 負例（免除が広がらない）：画面と項目を所属に持つ決まりの要件 R7 で項目の abnormal を省いた応答は今までどおり「abnormal の試験が無い」で落ちる（位置は要求の一覧の R7）", async () => {
    const bad = response([...r1Validate(), ...r3When(), ...r4Compute(), ...r7Validate("abnormal")], NATURES_D);
    const { outcome } = await runD([bad, bad]);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems).toEqual([{ field: "requirements[4]", message: "abnormal の試験が無い" }]);
  });

  it("(4) 負例：在ることだけの要件に validate・所属に無い対象・評価の方法の表に無い組・16 本超は、コードの試験を足した組でも今までどおり固定文で落ちる", async () => {
    const existenceOnly = NATURES_D.map((entry) => (entry.requirementId === "R7" ? { ...entry, nature: "existence-only" as const } : entry));
    const table = { ...DTABLE, classification: DTABLE.classification.map((entry) => (entry.requirementId === "R7" ? { ...entry, nature: "existence-only" as const } : entry)) };
    const validateOnExistence = response([...r1Validate(), ...r3When(), ...r4Compute(), r7Validate()[0]!], existenceOnly);
    const failed1 = await runD([validateOnExistence, validateOnExistence], true, table);
    if (failed1.outcome.ok || failed1.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    // 位置は場合の添字（展開の対応表で写す。#625）。添字は合併の並び（要件の一覧の順に要件ごと。Issue #651）
    const orderOf = (recording: { readonly structured: readonly LlmStructuredRequest[] }) => requestListedIds(recording.structured[0]!);
    expect(failed1.outcome.failure.problems).toContainEqual({ field: `cases[${String(mergedIndexAt(validateOnExistence, orderOf(failed1.recording), 9))}]`, message: "在ることだけの要件なので、検査（validate）の試験を作らない" });

    const notOwned = idsOk([rawTest({ id: "r1-other", requirementId: "R1", targetKind: "field", roleId: "f.member.title", operation: "validate", observes: "validation" })]);
    const failed2 = await runD([notOwned, notOwned]);
    if (failed2.outcome.ok || failed2.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(failed2.outcome.failure.problems).toContainEqual({ field: `cases[${String(mergedIndexAt(notOwned, orderOf(failed2.recording), LLM_COUNT))}].targetId`, message: "対象の役割 ID が、その要件の所属に無い" });

    const unlisted = idsOk([rawTest({ id: "r3-value", requirementId: "R3", targetKind: "operation", roleId: "o.closeItem", operation: "action", observes: "value" })]);
    const failed3 = await runD([unlisted, unlisted]);
    if (failed3.outcome.ok || failed3.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(failed3.outcome.failure.problems).toContainEqual({ field: `cases[${String(mergedIndexAt(unlisted, orderOf(failed3.recording), LLM_COUNT))}].observes`, message: "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い" });

    // R4 はコードが画面の試験を 1 本作るので、LLM の 16 本で組は 17 本になり上限で落ちる（コードの試験も数える）
    const many = Array.from({ length: 16 }, (_, index) =>
      rawTest({ id: `r4-many-${String(index)}`, requirementId: "R4", targetKind: "computation", roleId: "c.rate", kind: KINDS[index % 3]!, operation: "compute", observes: "value" }),
    );
    const over = response([...r1Validate(), ...r3When(), ...many, ...r7Validate()], NATURES_D);
    const failed4 = await runD([over, over]);
    if (failed4.outcome.ok || failed4.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(failed4.outcome.failure.problems.some((problem) => problem.field === "requirements[2]" && problem.message.startsWith("要件の試験が上限 16 を超えている"))).toBe(true);
  });

  it("fail-closed：構造の検査の対象の行が表に無い表は、LLM を呼ばずに固定文で止まる（近い行に結ばない。attempts 0）", async () => {
    const broken: NameTable = {
      ...DTABLE,
      verification: DTABLE.verification.map((entry) =>
        entry.kind === "structural" ? { ...entry, targets: [{ check: "view-shows" as const, targetId: "s.membersx", sourceId: "f.member.title" }] } : entry,
      ),
    };
    const { outcome, recording } = await runD([idsOk()], true, broken);
    expect(recording.structured).toHaveLength(0);
    expect(outcome).toEqual({ ok: false, failure: { kind: "unmet", attempts: 0, problems: [{ field: "requirements[1]", message: GENERATED_STRUCTURE_STOP_MESSAGES.unknownRow }] } });
  });

  // ── 手 3e（Issue #625）：T2 は場合の形で書かせ、コードが骨組みを組んで展開し、展開後の組に今の検査を全部掛ける ──────────
  describe("手 3e：場合の形の T2（Issue #625）", () => {
    /** 同じ内容の場合の形の応答（v1 の形の材料を書き換えたもの。骨組みを書かない） */
    const casesOk = (extra: readonly Record<string, unknown>[] = []) => casesResponseOf(idsOk(extra));
    /** 場合の形の応答をそのまま渡す（`runD` の書き換えを通らない形） */
    const runCases = (outputs: readonly unknown[]) => runD(outputs);
    const CASE_FORM_IDS = ["R-tsp-07", "R-tsp-09", "R-tsp-11", "R-tsp-12", "R-tsp-13", "R-tsp-14"];

    it("(1) 要求の schema は場合の形で、欄の名前を指す文が場合の形・R-tsp-16 の形の位置は台帳の順。名前を推測しない・独立に分類する・異常の期待の型の文は変えない。題材の言葉は無い", async () => {
      const { outcome, recording } = await runCases([casesOk()]);
      expect(outcome.ok).toBe(true);
      const request = recording.structured[0]!;
      expect(request.schema).toEqual(testCasesSchemaOf(ledger));
      const on = testSpecRuleDefinitionsOf(ledger, true);
      const off = testSpecRuleDefinitionsOf(ledger);
      const rules = request.rules ?? [];
      expect(rules.slice(rules.length - on.length)).toEqual(ruleTexts(on));
      for (const id of ["R-tsp-01", "R-tsp-08", "R-tsp-10"]) {
        expect(on.find((definition) => definition.id === id), id).toEqual(off.find((definition) => definition.id === id));
      }
      for (const id of CASE_FORM_IDS) {
        const text = on.find((definition) => definition.id === id)?.text ?? "";
        // 場合の形の文は、場合に無い欄（target・inputContract・referenceData）を書かせない
        for (const field of ["inputContract", "referenceData", "roleId"]) expect(text, `${id} ${field}`).not.toContain(field);
      }
      const r16 = on.find((definition) => definition.id === "R-tsp-16")?.text ?? "";
      expect(r16.startsWith("場合ごとに、観測する性質（observes）を 1 つ書く。")).toBe(true);
      expect(r16).toBe(`${r16.slice(0, r16.indexOf(ledger.t2IdsFormTexts[0] ?? ""))}${ledger.t2IdsFormTexts.join("")}${ledger.t2UnsupportedTexts.join("")}`);
      expect(ruleDefinitionDefects(on)).toEqual([]);
      expectNoAcceptanceMaterial([requestText(request)]);
    });

    it("(2) 二点測定：手 3d の正例（v1 の形の応答で 1 回で通る走り）と同じ内容を場合の形で書いた応答が、展開後に同じ組（id と時計を除いて深く等しい。observes・網羅の単位・組の SHA の計算の対象が同じ）になって 1 回で通る", async () => {
      const v1 = checkTestSpecOutputOf(idsOk(), ledger);
      if (!v1.ok) throw new Error("前提が壊れた：手 3d の応答が形に落ちる");
      const { outcome, recording } = await runCases([casesOk()]);
      if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
      expect(recording.structured).toHaveLength(1);
      expect(outcome.value.rounds).toBe(1);
      const llm = outcome.value.suite.tests.slice(0, LLM_COUNT);
      expect(llm.map(withoutIdAndClock)).toEqual(v1.value.suite.tests.map(withoutIdAndClock));
      expect(llm.map((test) => outcome.value.observes.get(test.id))).toEqual(v1.value.suite.tests.map((test) => v1.value.observes.get(test.id)));
      // 同じ組を v1 の形の試験から組み直す（試験 ID と時計だけを展開の値に替え、コードの試験を足す）と、網羅の単位と SHA が同じ
      const generatedTail = outcome.value.suite.tests.slice(LLM_COUNT);
      const rebuiltTests = [
        ...v1.value.suite.tests.map((test, index) => ({ ...test, id: `${TEST_CASE_ID_PREFIX}${String(index + 1)}`, clock: llm[index]?.clock ?? "" })),
        ...generatedTail,
      ];
      const rebuiltObserves = new Map<string, TestObserves>([
        ...v1.value.suite.tests.map((test, index) => [`${TEST_CASE_ID_PREFIX}${String(index + 1)}`, v1.value.observes.get(test.id) as TestObserves] as const),
        ...generatedTail.map((test) => [test.id, outcome.value.observes.get(test.id) as TestObserves] as const),
      ]);
      const rebuilt = { ...outcome.value.suite, tests: rebuiltTests };
      expect(rebuilt.tests).toEqual(outcome.value.suite.tests);
      expect(await testSuiteSha256(rebuilt, rebuiltObserves)).toBe(outcome.value.sha256);
      expect(coverageUnitsOf({ suite: rebuilt, observes: rebuiltObserves, natures: outcome.value.natures })).toEqual(outcome.value.coverage);
    });

    it("(3) 門（展開が通しても検査が落とす）：参照行の上限超・既定値の要件に別の形・when の期待が真偽でない・所属に無い対象・評価の方法の表に無い組・在ることだけの要件に validate は、今までどおりの固定文で落ちる", async () => {
      const DEFAULT_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "default-value");
      const WHEN_ROW = PROPERTY_LEDGER.find((entry) => entry.id === "when");
      if (DEFAULT_ROW?.t2 == null || WHEN_ROW?.t2Condition == null) throw new Error("前提が壊れた：台帳の行が無い");
      // 添字は合併の並び（要件の一覧の順に要件ごと。Issue #651）。`cases[]` は走りのあとに、応答の末尾（添字 LLM_COUNT）に足した
      // 場合の合併の位置へ置き換える
      const at = "cases[]";
      const manyRows = Array.from({ length: 65 }, (_, index) => ({ rowId: `x-${String(index)}`, target: { requirementId: "R1", kind: "entity", roleId: "e.item" }, values: "{}" }));
      const gates: readonly (readonly [string, Record<string, unknown>, { readonly field: string; readonly message: string }])[] = [
        [
          "参照行の上限超",
          { ...rawTest({ id: "r1-many", requirementId: "R1", targetKind: "field", roleId: "f.item.amount", operation: "validate", observes: "validation" }), referenceData: manyRows },
          { field: `${at}.rows`, message: "参照データの行が上限 64 を超えている（65）" },
        ],
        [
          "既定値の要件でない要件に default-value",
          { ...rawTest({ id: "r1-default", requirementId: "R1", targetKind: "field", roleId: "f.item.kind", operation: "validate", observes: "default-value" }), expected: { kind: "ok", value: JSON.stringify("alpha"), code: null } },
          { field: `${at}.observes`, message: DEFAULT_ROW.t2.messages.notAllowed },
        ],
        [
          "when の期待が真偽でない",
          rawTest({ id: "r3-state", requirementId: "R3", targetKind: "operation", roleId: "o.closeItem", operation: "action", observes: "when", expected: { kind: "ok", value: JSON.stringify({ "f.item.kind": "beta" }), code: null } }),
          { field: `${at}.expected`, message: WHEN_ROW.t2Condition.messages.expected },
        ],
        [
          "所属に無い対象",
          rawTest({ id: "r1-other", requirementId: "R1", targetKind: "field", roleId: "f.member.title", operation: "validate", observes: "validation" }),
          { field: `${at}.targetId`, message: "対象の役割 ID が、その要件の所属に無い" },
        ],
        [
          "評価の方法の表に無い組",
          rawTest({ id: "r3-value", requirementId: "R3", targetKind: "operation", roleId: "o.closeItem", operation: "action", observes: "value" }),
          { field: `${at}.observes`, message: "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い" },
        ],
      ];
      for (const [name, extra, problem] of gates) {
        const bad = casesOk([extra]);
        const { outcome, recording } = await runCases([bad, bad]);
        if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error(`unmet でない：${name}`);
        const placed = `cases[${String(mergedIndexAt(bad, requestListedIds(recording.structured[0]!), LLM_COUNT))}]`;
        expect(outcome.failure.problems, name).toContainEqual({ ...problem, field: problem.field.replace(/^cases\[\]/, placed) });
      }
      // 在ることだけの要件に validate（R7 を existence-only にした表）
      const existenceOnly = NATURES_D.map((entry) => (entry.requirementId === "R7" ? { ...entry, nature: "existence-only" as const } : entry));
      const table = { ...DTABLE, classification: DTABLE.classification.map((entry) => (entry.requirementId === "R7" ? { ...entry, nature: "existence-only" as const } : entry)) };
      const validateOnExistence = casesResponseOf(response([...r1Validate(), ...r3When(), ...r4Compute(), r7Validate()[0]!], existenceOnly));
      const failed = await runD([validateOnExistence, validateOnExistence], true, table);
      if (failed.outcome.ok || failed.outcome.failure.kind !== "unmet") throw new Error("unmet でない");
      const placed = mergedIndexAt(validateOnExistence, requestListedIds(failed.recording.structured[0]!), 9);
      expect(failed.outcome.failure.problems).toContainEqual({ field: `cases[${String(placed)}]`, message: "在ることだけの要件なので、検査（validate）の試験を作らない" });
    });

    it("(4) 1 回目の中身の落ちの 2 回目の要求に、前回の場合（展開前の形）と場合の添字の問題が載る。展開に落ちた回も同じ（作り直しの回数は今のまま）", async () => {
      const notOwned = casesOk([rawTest({ id: "r1-other", requirementId: "R1", targetKind: "field", roleId: "f.member.title", operation: "validate", observes: "validation" })]);
      const { outcome, recording, gateway } = await runCases([notOwned, casesOk()]);
      expect(outcome.ok).toBe(true);
      expect(recording.structured).toHaveLength(2);
      const [testsName, problemsName] = TEST_SPEC_RETRY_DATA_NAMES;
      const second = recording.structured[1]!.input;
      // 2 回目は問題の帰属した R1 だけを書き直させる：前回の場合は R1 の場合だけ（合併の順）、位置はその並びの添字（Issue #651）
      const order = requestListedIds(recording.structured[0]!);
      const r1Cases = (output: { readonly cases: readonly Record<string, unknown>[] }) => output.cases.filter((entry) => entry["requirementId"] === "R1");
      expect(requestListedIds(recording.structured[1]!)).toEqual(["R1"]);
      expect(requestRetainedIds(recording.structured[1]!)).toEqual(order.filter((id) => id !== "R1"));
      expect(dataBlockOf(second, testsName)).toEqual(r1Cases(notOwned));
      expect(dataBlockOf(second, problemsName)).toContainEqual({ field: `cases[${String(r1Cases(notOwned).length - 1)}].targetId`, message: "対象の役割 ID が、その要件の所属に無い" });
      expect(gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 1 });
      // 展開に落ちた回（表に無い行）：組を作らず、前回の場合と場合の添字の固定文で作り直させる
      const unknownRow = { ...casesOk(), cases: [...casesOk().cases, { ...casesOk().cases[0]!, targetId: "f.item.nothing" }] };
      expect(unknownRow.cases[LLM_COUNT]?.["requirementId"]).toBe("R1");
      const again = await runCases([unknownRow, casesOk()]);
      expect(again.outcome.ok).toBe(true);
      const retried = again.recording.structured[1]!.input;
      expect(dataBlockOf(retried, testsName)).toEqual(r1Cases(unknownRow));
      expect(dataBlockOf(retried, problemsName)).toEqual([{ field: `cases[${String(r1Cases(unknownRow).length - 1)}].targetId`, message: TEST_CASE_EXPAND_MESSAGES.target }]);
      // 2 回とも落ちれば unmet（展開の固定文のまま。補わない。位置は合併の並びの添字）
      const failed = await runCases([unknownRow, unknownRow]);
      const placed = mergedIndexAt(unknownRow, order, LLM_COUNT);
      expect(failed.outcome).toEqual({ ok: false, failure: { kind: "unmet", attempts: TEST_SPEC_ROUNDS, problems: [{ field: `cases[${String(placed)}].targetId`, message: TEST_CASE_EXPAND_MESSAGES.target }] } });
    });

    it("(5) 結果の組の形は手 3d と同じ（欄を変えない）で、LLM が書いた場合の数と応答の文字数がある。断った候補の診断は場合の形の応答と展開後の対象を載せる", async () => {
      const v1 = checkTestSpecOutputOf(idsOk(), ledger);
      if (!v1.ok) throw new Error("前提が壊れた");
      const ok = casesOk();
      const { outcome } = await runCases([ok]);
      if (!outcome.ok) throw new Error("通るはず");
      expect(outcome.value.suite.tests.slice(0, LLM_COUNT).map((test) => Object.keys(test))).toEqual(v1.value.suite.tests.map((test) => Object.keys(test)));
      expect(outcome.value.cases).toEqual({ count: LLM_COUNT, responseChars: JSON.stringify(ok).length });
      // 断った候補（中身）：応答は場合の形、対象は展開後の組（試験の位置の問題は対象の添字のまま）
      const rejected: RejectedCandidate[] = [];
      const bad = casesOk([rawTest({ id: "r1-other", requirementId: "R1", targetKind: "field", roleId: "f.member.title", operation: "validate", observes: "validation" })]);
      const plainRun = await run([bad, ok], { plan: DPLAN, list: DLIST, table: DTABLE, carryOver: await carryD(), ledger, ids: true, onRejected: (candidate) => rejected.push(candidate) });
      expect(plainRun.outcome.ok).toBe(true);
      const [first] = rejected;
      if (first?.kind !== "content") throw new Error("中身の候補でない");
      // 応答は合併した場合の形（要件の一覧の順に要件ごと。Issue #651）。足した場合はその合併の位置に展開される
      const order = requestListedIds(plainRun.recording.structured[0]!);
      const placed = mergedIndexAt(bad, order, LLM_COUNT);
      expect(first.response).toEqual(mergedOutputOf(bad, order));
      expect((first.target as TestSuite).tests[placed]?.id).toBe(`${TEST_CASE_ID_PREFIX}${String(placed + 1)}`);
      expect((first.target as TestSuite).tests[placed]?.target.roleId).toBe("f.member.title");
      expect(first.problems).toContainEqual({ field: `tests[${String(placed)}].target.roleId`, message: "対象の役割 ID が、その要件の所属に無い", reference: "target" });
      // ids off（前の手の旗だけ on）の結果には欄が無い
      const off = await runD([response([...r1Validate(), ...r2Structure(), ...r3When(), ...r4Compute(), ...r7Validate(), ...KINDS.map((kind) => rawTest({ id: `r6-${kind}`, requirementId: "R6", targetKind: "screen", roleId: "s.items", kind, operation: "screen", observes: "view-structure" }))], [...NATURES_D, { requirementId: "R2", nature: "existence-only" }])], false);
      if (!off.outcome.ok) throw new Error("通るはず");
      expect(off.outcome.value).not.toHaveProperty("cases");
    });

    it("(fail-closed) 展開は補わない：expected の kind と欄が合わない場合・entity でない参照元は、作り直しでも直らなければ固定文のまま unmet", async () => {
      const okCases = casesOk().cases;
      const wrongExpected = { classifications: casesOk().classifications, cases: [...okCases.slice(0, -1), { ...okCases[okCases.length - 1]!, expected: { kind: "ok", code: "E_X" } }] };
      const failed = await runCases([negative(wrongExpected, "anyOf の ok の枝に code は strict では出ないが、展開の固定文の負例として要る"), negative(wrongExpected, "同上")]);
      expect(failed.outcome).toEqual({ ok: false, failure: { kind: "unmet", attempts: TEST_SPEC_ROUNDS, problems: [{ field: `cases[${String(okCases.length - 1)}].expected`, message: TEST_CASE_EXPAND_MESSAGES.expected }] } });
    });
  });

  it("ids off（前の手の旗だけ on）の要求・schema・結果は今のまま（構造の要件は一覧にあり、画面の試験は作らない）", async () => {
    const offOk = response([...r1Validate(), ...r2Structure(), ...r3When(), ...r4Compute(), ...r7Validate(), ...KINDS.map((kind) => rawTest({ id: `r6-${kind}`, requirementId: "R6", targetKind: "screen", roleId: "s.items", kind, operation: "screen", observes: "view-structure" }))], [...NATURES_D, { requirementId: "R2", nature: "existence-only" }]);
    const off = await runD([offOk], false);
    if (!off.outcome.ok) throw new Error(`通るはず：${JSON.stringify(off.outcome.failure)}`);
    expect(off.outcome.value.suite.tests.some((test) => isGeneratedTestId(test.id))).toBe(false);
    expect(off.recording.structured[0]?.schema).toEqual(testSpecSchemaOf(ledger));
    expect((dataBlockOf(off.recording.structured[0]!.input, TEST_SPEC_DATA_NAMES[1]) as { requirements: { id: string }[] }).requirements.map((entry) => entry.id)).toEqual(["R1", "R2", "R3", "R4", "R6", "R7"]);
  });
});

// ── 旗 v12.ids の T2 の束（手 3f・Issue #626）───────────────────────────────
//
// 束に渡す規則の区別（教訓 (1)・(2)。束の中で閉じる条件だけを束で見て、合併した組の条件は合併後に 1 回だけ掛ける）：
//
// | 規則 | 束の中で閉じる | 合併後に 1 回 |
// |---|---|---|
// | 分類が束の要件にちょうど 1 件（欠落・重複・別の束・一覧に無い） | ○ | |
// | 場合の要件 ID が別の束・一覧に無い要件でない | ○ | |
// | 場合の形（schema の型。`checkTestCasesOutput`） | ○ | |
// | 展開（骨組み・行 ID） | | ○ |
// | 分類の完全性（要求の一覧の全部）・分類の照合（T1 との食い違い）・J2 | | ○ |
// | 網羅（正常・異常・境界）・要件ごとの総数（16）・所属・評価可能性・台帳の検査・集計・条件・コードの試験との重なり | | ○ |

describe("旗 v12.ids の T2 の束（手 3f・Issue #626）", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  const LEDGER: LedgerView = (() => {
    const view = ledgerViewOf(ALL_ON);
    if (view === undefined) throw new Error("前提が壊れた：台帳が無い");
    return view;
  })();
  type Output = { readonly classifications: readonly { readonly requirementId: string; readonly nature: string }[]; readonly cases: readonly Record<string, unknown>[] };
  /** 構造の要件・コードの試験の無い台本（試験 3N。全要件が T2 の要求に残る） */
  const sized = (requirements: number, options: { readonly codeWritten?: boolean } = {}): SizedMaterials =>
    buildSized(requirements, 3 * requirements, ALL_ON, options);
  const fullOf = (materials: SizedMaterials, omitAbnormalOf?: string): Output =>
    materials.t2Response(omitAbnormalOf === undefined ? {} : { omitAbnormalOf }) as unknown as Output;
  /** 全要件の応答を、束の要件の分類と場合に絞る */
  const sliceOf = (output: Output, ids: readonly string[]): Output => ({
    classifications: output.classifications.filter((entry) => ids.includes(entry.requirementId)),
    cases: output.cases.filter((entry) => ids.includes(entry["requirementId"] as string)),
  });
  const carryOf = async (materials: SizedMaterials): Promise<CarryOver> =>
    deriveCarryOver({
      list: materials.list,
      table: materials.table,
      semanticCheck: {
        tableSha256: await nameTableSha256(materials.table),
        judgments: materials.table.verification
          .filter((entry) => entry.kind !== "unresolved")
          .map((entry) => ({ requirementId: entry.requirementId, verdict: "accept" as const })),
      },
    });

  /**
   * 束ごとの台本で答える偽物の口（束は初回の「要件の一覧」の先頭の要件 ID で見分ける。中身のやり直しの一覧は束の書き直す要件だけ
   * なので、要件 ID の組が交わる前の要求と同じ束に数える〔Issue #651〕。束ごとの呼び出しの回を数える）。台本には要求の一覧の
   * 要件 ID・束の回・束の先頭の要件 ID を渡す。開始と終了の順を記録し、偽物の時計で 1 回の応答に `stepMs` 掛ける（始まった時刻から
   * 数える。同時に始まった束は同じ時刻に終わる）
   */
  function scripted(
    script: (ids: readonly string[], call: number, head: string) => unknown,
    stepMs = 0,
    fail?: (ids: readonly string[], call: number, head: string) => boolean,
  ) {
    let clock = 0;
    const events: string[] = [];
    const requests: { readonly ids: readonly string[]; readonly input: string }[] = [];
    const calls = new Map<string, number>();
    const seen: { readonly head: string; readonly ids: Set<string> }[] = [];
    const client: LlmClient = {
      async callStructured<T>(request: LlmStructuredRequest) {
        const ids = requestListedIds(request);
        const found = seen.find((entry) => ids.some((id) => entry.ids.has(id)));
        const known = found ?? { head: ids[0] ?? "", ids: new Set<string>() };
        if (found === undefined) seen.push(known);
        for (const id of ids) known.ids.add(id);
        const key = known.head;
        const call = (calls.get(key) ?? 0) + 1;
        calls.set(key, call);
        requests.push({ ids, input: request.input });
        events.push(`start:${key}`);
        const startedAt = clock;
        await new Promise((resolve) => setTimeout(resolve, 0));
        clock = Math.max(clock, startedAt + stepMs);
        events.push(`end:${key}`);
        if (fail?.(ids, call, key) === true) throw Object.assign(new Error("fetch が失敗しました"), { kind: "network" });
        return { output: script(ids, call, key) as T, usage: USAGE };
      },
      async callWithTools() {
        throw new Error("前提が壊れた：T2 は道具を呼ばない");
      },
    };
    return { client, events, requests, calls, now: () => clock };
  }

  async function runBundled(
    materials: SizedMaterials,
    script: (ids: readonly string[], call: number, head: string) => unknown,
    options: { readonly judge?: Judge; readonly concurrency?: number; readonly stepMs?: number } = {},
  ) {
    const fake = scripted(script, options.stepMs);
    const gateway = new CallGateway({ client: fake.client, budget: new JobBudget(10), rates: RATES, now: fake.now, deadline: 86_400_000 });
    const rejected: { readonly candidate: RejectedCandidate; readonly bundle: unknown }[] = [];
    const startedAt = fake.now();
    const outcome = await runTestSpec({
      plan: materials.plan,
      list: materials.list,
      table: materials.table,
      carryOver: await carryOf(materials),
      documents: FIXTURE_DOCUMENTS,
      gateway,
      ledger: LEDGER,
      ids: true,
      onRejected: (candidate, bundle) => rejected.push({ candidate, bundle }),
      ...(options.judge === undefined ? {} : { judge: options.judge }),
      ...(options.concurrency === undefined ? {} : { bundleConcurrency: options.concurrency }),
    });
    return { outcome, ...fake, gateway, rejected, wallMs: fake.now() - startedAt };
  }
  /** 束ごとの呼び出しの回数（束の先頭の要件 ID → 回数） */
  const callsOf = (run: { readonly calls: ReadonlyMap<string, number> }) => Object.fromEntries(run.calls);
  const requirementsOf = (input: string) =>
    (dataBlockOf(input, TEST_SPEC_DATA_NAMES[1]) as { readonly requirements: readonly { readonly id: string }[] }).requirements.map((entry) => entry.id);

  it("(1) 要件 15 で要求 3 本（各 5 件）、7 で 2 本（5＋2）、25 で 5 本。各要求の一覧・確かめ方・所属はその束の要件だけで、表は全行", async () => {
    for (const [count, sizes] of [
      [15, [5, 5, 5]],
      [7, [5, 2]],
      [25, [5, 5, 5, 5, 5]],
    ] as const) {
      const materials = sized(count);
      const full = fullOf(materials);
      const run = await runBundled(materials, (ids) => sliceOf(full, ids));
      expect(run.outcome.ok, String(count)).toBe(true);
      expect(run.requests.map((request) => request.ids.length)).toEqual([...sizes]);
      expect(run.requests.flatMap((request) => request.ids)).toEqual(materials.list.requirements.map((requirement) => requirement.id));
      for (const request of run.requests) {
        expect(requirementsOf(request.input)).toEqual(request.ids);
        expect((dataBlockOf(request.input, TEST_SPEC_DATA_NAMES[2]) as readonly unknown[]).length).toBe(materials.table.rows.length);
        const verification = dataBlockOf(request.input, TEST_SPEC_DATA_NAMES[3]) as readonly { readonly requirementId: string }[];
        expect(verification.map((entry) => entry.requirementId)).toEqual(request.ids);
        const ownership = dataBlockOf(request.input, TEST_SPEC_DATA_NAMES[4]) as readonly { readonly requirementId: string }[];
        expect(ownership.every((entry) => request.ids.includes(entry.requirementId))).toBe(true);
      }
      expectNoAcceptanceMaterial(run.requests.map((request) => request.input));
    }
  });

  it("(教訓 3) 束の数が 1・2・3 と増えても、1 要件あたりの試験の数は増えない（runTestSpec を通した組で、同じ要件の組の試験の数が等しい）", async () => {
    const perRequirement = async (count: number) => {
      const materials = sized(count);
      const full = fullOf(materials);
      const run = await runBundled(materials, (ids) => sliceOf(full, ids));
      if (!run.outcome.ok) throw new Error("通らない");
      const counts: Record<string, number> = {};
      for (const test of run.outcome.value.suite.tests) counts[test.target.requirementId] = (counts[test.target.requirementId] ?? 0) + 1;
      // 組は応答の場合をちょうど 1 回ずつ展開したもの（束が重ねも落としもしない）
      expect(run.outcome.value.suite.tests).toHaveLength(full.cases.length);
      return { bundles: run.requests.length, counts };
    };
    const one = await perRequirement(5);
    const two = await perRequirement(10);
    const three = await perRequirement(15);
    expect([one.bundles, two.bundles, three.bundles]).toEqual([1, 2, 3]);
    const firstFive = (counts: Readonly<Record<string, number>>) => ["R1", "R2", "R3", "R4", "R5"].map((id) => counts[id]);
    expect(firstFive(two.counts)).toEqual(firstFive(one.counts));
    expect(firstFive(three.counts)).toEqual(firstFive(one.counts));
    expect(Math.max(...Object.values(three.counts))).toBe(Math.max(...Object.values(one.counts)));
  });

  describe("(2) 束 2 の応答の欠落・重複・別の束の要件 ID・一覧に無い要件 ID は、それぞれ固定文で落ちて束 2 だけがやり直され、束 1・3 の要求は増えない", () => {
    const materials = sized(15);
    const full = fullOf(materials);
    const bundle2 = ["R6", "R7", "R8", "R9", "R10"];
    const good = sliceOf(full, bundle2);
    const defects: readonly (readonly [string, Output, string])[] = [
      ["欠落", { ...good, classifications: good.classifications.filter((entry) => entry.requirementId !== "R7") }, TEST_CASE_BUNDLE_MESSAGES.missing],
      ["重複", { ...good, classifications: [...good.classifications, { requirementId: "R7", nature: "ruled" }] }, TEST_CASE_BUNDLE_MESSAGES.duplicate],
      ["別の束の要件 ID", { ...good, classifications: [...good.classifications, { requirementId: "R1", nature: "ruled" }] }, TEST_CASE_BUNDLE_MESSAGES.outside],
      ["一覧に無い要件 ID", { ...good, classifications: [...good.classifications, { requirementId: "R99", nature: "ruled" }] }, TEST_CASE_BUNDLE_MESSAGES.unknown],
      ["場合の別の束の要件 ID", { ...good, cases: [...good.cases, { ...full.cases[0] }] }, TEST_CASE_BUNDLE_MESSAGES.caseOutside],
      ["場合の一覧に無い要件 ID", { ...good, cases: [...good.cases, { ...full.cases[0], requirementId: "R99" }] }, TEST_CASE_BUNDLE_MESSAGES.caseUnknown],
    ];
    it.each(defects)("%s", async (_name, defect, message) => {
      const run = await runBundled(materials, (ids, call) => (ids[0] === "R6" && call === 1 ? defect : sliceOf(full, ids)));
      expect(run.outcome.ok).toBe(true);
      expect(callsOf(run)).toEqual({ R1: 1, R6: 2, R11: 1 });
      const [shape] = run.rejected;
      expect(run.rejected).toHaveLength(1);
      expect(shape?.candidate.kind).toBe("shape");
      expect(shape?.bundle).toEqual({ index: 1, requirements: 5, rewritten: 5, retained: 0 });
      expect(shape?.candidate.problems.map((problem) => problem.message)).toContain(message);
      expect(run.gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 0 });
    });
  });

  describe("(3)〜(5) 中身のやり直しは帰属する束だけ。形は束の全 round で通算 1・束の呼び出しは 3 以下", () => {
    const materials = sized(15);
    const full = fullOf(materials);
    const omitted = fullOf(materials, "R12");
    // R12 の分類を T1（ruled）と食い違わせ、判定（J2）で ruled に決める
    const discrepant = (output: Output): Output => ({
      ...output,
      classifications: output.classifications.map((entry) => (entry.requirementId === "R12" ? { ...entry, nature: "existence-only" } : entry)),
    });

    it("(3) 束 3 の要件の異常の欠けで束 3 だけが 2 回目に呼ばれ（書き直す R12 だけの一覧・前回の R12 の場合・その問題・判定で決めた種類・保持した要件の ID）、J2 は合併後 1 回、2 回目が通れば問題 0", async () => {
      const recorded = recordingJudge(createFakeJudge({ [natureQuestionName("R12")]: choice("ruled", 0.95) }));
      const run = await runBundled(
        materials,
        (ids, call, head) => (head === "R11" ? discrepant(sliceOf(call === 1 ? omitted : full, ids)) : sliceOf(full, ids)),
        { judge: recorded.judge },
      );
      if (!run.outcome.ok) throw new Error(JSON.stringify(run.outcome.failure));
      expect(run.outcome.value.rounds).toBe(2);
      expect(callsOf(run)).toEqual({ R1: 1, R6: 1, R11: 2 });
      expect(recorded.requests).toHaveLength(1);
      const second = run.requests.at(-1);
      if (second === undefined) throw new Error("要求が無い");
      // 2 回目の要求は書き直す要件（問題の帰属した R12）だけ。位置は書き直す要件の並びへ写す（Issue #651）
      expect(second.ids).toEqual(["R12"]);
      expect(dataNamesOf(second.input)).toEqual([
        ...TEST_SPEC_DATA_NAMES,
        ...TEST_SPEC_RETRY_DATA_NAMES,
        TEST_SPEC_DECIDED_NATURES_DATA_NAME,
        TEST_SPEC_RETAINED_DATA_NAME,
      ]);
      expect(dataBlockOf(second.input, TEST_SPEC_RETRY_DATA_NAMES[0])).toEqual(discrepant(sliceOf(omitted, second.ids)).cases);
      expect(dataBlockOf(second.input, TEST_SPEC_RETRY_DATA_NAMES[1])).toEqual([{ field: "requirements[0]", message: "abnormal の試験が無い" }]);
      expect(dataBlockOf(second.input, TEST_SPEC_DECIDED_NATURES_DATA_NAME)).toEqual([{ requirementId: "R12", nature: "ruled" }]);
      expect(dataBlockOf(second.input, TEST_SPEC_RETAINED_DATA_NAME)).toEqual(["R11", "R13", "R14", "R15"]);
      expect(run.gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 1 });
    });

    it("(3) 2 回目も欠ければ unmet（束 3 の呼び出し 2・ほかの束は 1）", async () => {
      const run = await runBundled(materials, (ids, _call, head) => sliceOf(head === "R11" ? omitted : full, ids));
      expect(run.outcome.ok).toBe(false);
      if (run.outcome.ok) return;
      expect(run.outcome.failure).toMatchObject({ kind: "unmet", attempts: TEST_SPEC_ROUNDS });
      expect(callsOf(run)).toEqual({ R1: 1, R6: 1, R11: 2 });
    });

    it("(4) 帰属できない問題（組全体の位置）は束を推測せず固定文で unmet、追加の要求は無い", async () => {
      const run = await runBundled(materials, (ids) => ({ ...sliceOf(full, ids), cases: [] }));
      expect(run.outcome.ok).toBe(false);
      if (run.outcome.ok) return;
      expect(run.outcome.failure.kind).toBe("unmet");
      if (run.outcome.failure.kind !== "unmet") return;
      expect(run.outcome.failure.problems[0]).toEqual({ field: "", message: TEST_CASE_BUNDLE_MESSAGES.unattributed });
      expect(run.outcome.failure.problems).toContainEqual({ field: "tests", message: "試験の集合が空である" });
      expect(callsOf(run)).toEqual({ R1: 1, R6: 1, R11: 1 });
      expect(run.gateway.retryCounts.content).toBe(0);
    });

    const shapeBad = negative({ classifications: "x", cases: "x" }, "classifications・cases が並びでない応答。束の形の落ちを観測する負例");
    it("(5) 束 2 が初回で形に落ち → 形のやり直しで通り → 中身で落ち → 中身のやり直しの応答が形で落ちると、追加の要求は無く unmet（束 2 の呼び出し 3）", async () => {
      const bundle2 = ["R6", "R7", "R8", "R9", "R10"];
      const script = [shapeBad, sliceOf(fullOf(materials, "R7"), bundle2), shapeBad, sliceOf(full, ["R7"])];
      const run = await runBundled(materials, (ids, call, head) => (head === "R6" ? script[call - 1] : sliceOf(full, ids)));
      expect(run.outcome.ok).toBe(false);
      if (run.outcome.ok) return;
      expect(run.outcome.failure.kind).toBe("unmet");
      expect(callsOf(run)).toEqual({ R1: 1, R6: 3, R11: 1 });
      expect(run.gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 1 });
    });

    it("(5) 初回で形を使わなかった束は、中身のやり直しの応答が形で落ちても 1 回やり直せる（呼び出し 3）", async () => {
      const bundle2 = ["R6", "R7", "R8", "R9", "R10"];
      const script = [sliceOf(fullOf(materials, "R7"), bundle2), shapeBad, sliceOf(full, ["R7"])];
      const run = await runBundled(materials, (ids, call, head) => (head === "R6" ? script[call - 1] : sliceOf(full, ids)));
      if (!run.outcome.ok) throw new Error(JSON.stringify(run.outcome.failure));
      expect(callsOf(run)).toEqual({ R1: 1, R6: 3, R11: 1 });
      expect(run.gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 1 });
    });
  });

  describe("門の式：T2 区間の共有の門の増分 ＝ Σ束（開始＋予算での未着手＋timeout を伸ばせない未着手）＋判定の枝の増分（R5）", () => {
    /** 走らせる部分と同じ配線：束ごとに口を作り、門（と既定で予算）を共有する。判定は同じ門と枝を通す */
    async function runGated(
      materials: SizedMaterials,
      script: (ids: readonly string[], call: number, head: string) => unknown,
      options: {
        readonly budgetUsd?: number;
        readonly fail?: (ids: readonly string[], call: number, head: string) => boolean;
        readonly perBundle?: (bundle: number) => { readonly callTimeoutMs?: number; readonly budget?: JobBudget };
        readonly judge?: Judge;
      } = {},
    ) {
      const fake = scripted(script, 0, options.fail);
      const deadline = 60_000;
      const gate = createCallGate({ now: fake.now, deadline, limit: 144 });
      const budget = new JobBudget(options.budgetUsd ?? 10);
      const judge =
        options.judge === undefined ? undefined : createBudgetedJudge({ judge: options.judge, budget, rates: RATES, gate, judgeLimit: 80 });
      const bundles: CallGateway[] = [];
      const make = (bundle: number, extra: { readonly callTimeoutMs?: number; readonly budget?: JobBudget } = {}) =>
        new CallGateway({
          client: fake.client,
          budget: extra.budget ?? budget,
          rates: RATES,
          now: fake.now,
          deadline,
          gate,
          callTimeoutMs: extra.callTimeoutMs ?? 1_000,
        });
      const gateBefore = gate.attempts();
      const outcome = await runTestSpec({
        plan: materials.plan,
        list: materials.list,
        table: materials.table,
        carryOver: await carryOf(materials),
        documents: FIXTURE_DOCUMENTS,
        gateway: make(-1),
        ledger: LEDGER,
        ids: true,
        bundleGateway: (bundle) => {
          const made = make(bundle, options.perBundle?.(bundle));
          bundles[bundle] = made;
          return made;
        },
        ...(judge === undefined ? {} : { judge }),
      });
      const counts = bundles.map((entry) => entry.counts);
      const formula = counts.reduce((sum, item) => sum + item.attempts.started + item.attempts.not_started.budget + item.attempts.not_started.timeout, 0);
      return { outcome, fake, counts, gateDelta: gate.attempts() - gateBefore, formula, branch: judge?.branch?.used ?? 0 };
    }

    it("(a) 予算 0 で 2 束を同時に呼ぶと両束が budget で止まり、共有の門 +2・束の開始 0・予算での未着手 2・口の呼び出し 0", async () => {
      const materials = sized(7);
      const full = fullOf(materials);
      const run = await runGated(materials, (ids) => sliceOf(full, ids), { budgetUsd: 0 });
      expect(run.outcome.ok).toBe(false);
      if (run.outcome.ok) return;
      expect(run.outcome.failure.kind).toBe("budget");
      expect(run.counts.map((item) => [item.attempts.started, item.attempts.not_started.budget])).toEqual([
        [0, 1],
        [0, 1],
      ]);
      expect(run.fake.requests).toHaveLength(0);
      expect(run.gateDelta).toBe(2);
      expect(run.gateDelta).toBe(run.formula + run.branch);
    });

    it("(b) 2 束が通り、合併後に J2 を 1 回呼ぶ台本で、共有の門 +3・束の開始 2・判定の枝 +1。束の計に J2 は載らない", async () => {
      const materials = sized(7);
      const full = fullOf(materials);
      const discrepant = (output: Output): Output => ({
        ...output,
        classifications: output.classifications.map((entry) => (entry.requirementId === "R6" ? { ...entry, nature: "existence-only" } : entry)),
      });
      const run = await runGated(materials, (ids) => discrepant(sliceOf(full, ids)), {
        judge: createFakeJudge({ [natureQuestionName("R6")]: choice("ruled", 0.95) }),
      });
      if (!run.outcome.ok) throw new Error(JSON.stringify(run.outcome.failure));
      expect(run.counts.map((item) => item.attempts.started)).toEqual([1, 1]);
      expect(run.branch).toBe(1);
      expect(run.gateDelta).toBe(3);
      expect(run.gateDelta).toBe(run.formula + run.branch);
    });

    it("(c) 通信の再送 1・timeout を伸ばせない未着手 1・予算での未着手 1 が別の束で交錯しても、各項目はその束の計にだけ出て、式が成り立つ", async () => {
      const materials = sized(15);
      const full = fullOf(materials);
      const run = await runGated(materials, (ids) => sliceOf(full, ids), {
        // 束 1・2 は 1 回目の試行が通信の誤り。束 1 は timeout を伸ばせる、束 2 は締切の残りと同じ timeout で伸ばせない。束 3 は予算 0
        fail: (ids, call) => (ids[0] === "R1" || ids[0] === "R6") && call === 1,
        perBundle: (bundle) => (bundle === 1 ? { callTimeoutMs: 60_000 } : bundle === 2 ? { budget: new JobBudget(0) } : {}),
      });
      expect(run.outcome.ok).toBe(false);
      const shape = run.counts.map((item) => ({
        started: item.attempts.started,
        communication: item.retries.communication,
        timeout: item.attempts.not_started.timeout,
        budget: item.attempts.not_started.budget,
      }));
      expect(shape).toEqual([
        { started: 2, communication: 1, timeout: 0, budget: 0 },
        { started: 1, communication: 0, timeout: 1, budget: 0 },
        { started: 0, communication: 0, timeout: 0, budget: 1 },
      ]);
      expect(run.gateDelta).toBe(5);
      expect(run.gateDelta).toBe(run.formula + run.branch);
    });
  });

  it("(6) 束は同時に始まる：束 3 の開始がどの応答よりも前", async () => {
    const materials = sized(15);
    const full = fullOf(materials);
    const run = await runBundled(materials, (ids) => sliceOf(full, ids));
    const firstEnd = run.events.findIndex((event) => event.startsWith("end:"));
    expect(run.events.indexOf("start:R11")).toBeGreaterThanOrEqual(0);
    expect(run.events.indexOf("start:R11")).toBeLessThan(firstEnd);
    expect(run.events.slice(0, 3)).toEqual(["start:R1", "start:R6", "start:R11"]);
  });

  it("(7) 各束の応答に 10 秒掛かるとき、T2 の壁の時間は 1 束分（10 秒）で束の数に比例しない。同時数 1 なら束の数 × 10 秒", async () => {
    for (const count of [15, 25]) {
      const materials = sized(count);
      const full = fullOf(materials);
      const concurrent = await runBundled(materials, (ids) => sliceOf(full, ids), { stepMs: 10_000 });
      const serial = await runBundled(materials, (ids) => sliceOf(full, ids), { stepMs: 10_000, concurrency: 1 });
      expect(concurrent.outcome.ok && serial.outcome.ok).toBe(true);
      expect(concurrent.wallMs).toBe(10_000);
      expect(serial.wallMs).toBe(10_000 * Math.ceil(count / V12_T2_BUNDLE.size));
    }
  });

  it("(8) 同じ台本で同時数 1 の走りと同時の走りの展開後の組・組の SHA・成果物が深く等しい（順序に依らない）", async () => {
    const materials = sized(15);
    const full = fullOf(materials);
    const script = (ids: readonly string[], call: number) => sliceOf(ids[0] === "R11" && call === 1 ? fullOf(materials, "R12") : full, ids);
    const concurrent = await runBundled(materials, script);
    const serial = await runBundled(materials, script, { concurrency: 1 });
    if (!concurrent.outcome.ok || !serial.outcome.ok) throw new Error("通らない");
    expect(serial.outcome.value).toEqual(concurrent.outcome.value);
    expect(serial.outcome.value.sha256).toBe(concurrent.outcome.value.sha256);
    expect(callsOf(serial)).toEqual(callsOf(concurrent));
  });

  describe("(10) 門：合併後の組の誤りは今までどおりの固定文で落ち、その要件を含む束だけがやり直される", () => {
    const materials = sized(15);
    const full = fullOf(materials);
    const bundle3 = ["R11", "R12", "R13", "R14", "R15"];
    const r12 = (patch: Readonly<Record<string, unknown>>) => {
      const good = sliceOf(full, bundle3);
      return { ...good, cases: good.cases.map((entry) => (entry["requirementId"] === "R12" && entry["kind"] === "normal" ? { ...entry, ...patch } : entry)) };
    };
    const cases: readonly (readonly [string, () => Output, string])[] = [
      ["所属に無い対象", () => r12({ targetId: "E1.F1" }), "対象の役割 ID が、その要件の所属に無い"],
      ["評価の方法の表に無い組", () => r12({ observes: "empty-aggregate" }), "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い"],
      [
        "16 本超",
        () => {
          const good = sliceOf(full, bundle3);
          const normal = good.cases.find((entry) => entry["requirementId"] === "R12");
          return { ...good, cases: [...good.cases, ...Array.from({ length: 16 }, () => ({ ...normal }))] };
        },
        "要件の試験が上限 16 を超えている（19）",
      ],
    ];
    it.each(cases)("%s", async (_name, bad, fragment) => {
      const run = await runBundled(materials, (ids, call, head) => (head === "R11" && call === 1 ? bad() : sliceOf(full, ids)));
      if (!run.outcome.ok) throw new Error(JSON.stringify(run.outcome.failure));
      expect(callsOf(run)).toEqual({ R1: 1, R6: 1, R11: 2 });
      const content = run.rejected.find((entry) => entry.candidate.kind === "content");
      expect(content?.candidate.problems.length).toBeGreaterThan(0);
      expect(content?.candidate.problems.map((problem) => problem.message)).toContain(fragment);
    });

    it("在ることだけの要件（判定で existence-only）に validate の試験があれば、その束だけがやり直され、再び落ちれば unmet", async () => {
      const recorded = recordingJudge(createFakeJudge({ [natureQuestionName("R12")]: choice("existence-only", 0.95) }));
      const run = await runBundled(
        materials,
        (ids, _call, head) => {
          const slice = sliceOf(full, ids);
          return head === "R11"
            ? { ...slice, classifications: slice.classifications.map((entry) => (entry.requirementId === "R12" ? { ...entry, nature: "existence-only" } : entry)) }
            : slice;
        },
        { judge: recorded.judge },
      );
      expect(run.outcome.ok).toBe(false);
      if (run.outcome.ok) return;
      expect(run.outcome.failure.kind).toBe("unmet");
      expect(callsOf(run)).toEqual({ R1: 1, R6: 1, R11: 2 });
      expect(recorded.requests).toHaveLength(1);
    });

    it("集計の空の期待（コードが作る範囲）を束 1 が書けば、今までどおりの固定文で落ち、束 1 だけがやり直される", async () => {
      const written = sized(15, { codeWritten: true });
      const writtenFull = fullOf(written);
      const aggregate = writtenFull.cases.find((entry) => entry["requirementId"] === "R3" && entry["targetId"] === "C1");
      if (aggregate === undefined) throw new Error("前提が壊れた：集計の場合が無い");
      const wrong = { ...aggregate, kind: "boundary", observes: "empty-aggregate", rows: [], emptyEntities: ["E1"], expected: { kind: "ok", value: "5" } };
      const run = await runBundled(written, (ids, call) => {
        const slice = sliceOf(writtenFull, ids);
        return ids.includes("R3") && call === 1 ? { ...slice, cases: [...slice.cases, wrong] } : slice;
      });
      if (!run.outcome.ok) throw new Error(JSON.stringify(run.outcome.failure));
      expect(callsOf(run)).toEqual({ R3: 2, R8: 1, R13: 1 });
      const content = run.rejected.find((entry) => entry.candidate.kind === "content");
      const notAllowed = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate")?.t2Aggregate?.messages.notAllowed;
      expect(notAllowed).toBeDefined();
      expect(content?.candidate.problems.map((problem) => problem.message)).toContain(notAllowed);
    });

    it("コードの試験（手 3c・3d）は合併後の組にあり、コードが作る範囲の試験を束が書けばその束だけがやり直される", async () => {
      const written = sized(15, { codeWritten: true });
      const writtenFull = fullOf(written);
      const run = await runBundled(written, (ids) => sliceOf(writtenFull, ids));
      if (!run.outcome.ok) throw new Error(JSON.stringify(run.outcome.failure));
      expect(run.outcome.value.suite.tests.filter((test) => isGeneratedTestId(test.id)).length).toBe(written.generatedTestCount);
      // コードの試験だけで確かめる要件（R1・R2）は束に入らない
      expect(run.requests.flatMap((request) => request.ids)).not.toContain("R1");
      expect(run.requests.map((request) => request.ids.length)).toEqual([5, 5, 3]);
    });
  });

  describe("手 3g（Issue #651）：中身のやり直しは問題の帰属した要件だけを書き直させ、同じ束の問題の無い要件の分類と場合を保持する", () => {
    const materials = sized(15);
    const full = fullOf(materials);
    const omitted = fullOf(materials, "R7");
    const bundle2 = ["R6", "R7", "R8", "R9", "R10"];
    /** 束 2 の R7 の異常を初回に欠く台本（ほかの束とやり直しは `later` が答える） */
    const r7Missing = (later: (ids: readonly string[], call: number) => unknown) => (ids: readonly string[], call: number, head: string) =>
      head === "R6" ? (call === 1 ? sliceOf(omitted, ids) : later(ids, call)) : sliceOf(full, ids);
    /** 保持した要件 Z（R8）の場合（validate）を混ぜた R7 の応答 */
    const withZ = (ids: readonly string[]): Output => ({ ...sliceOf(full, ids), cases: [...sliceOf(full, ids).cases, ...sliceOf(full, ["R8"]).cases.slice(0, 1)] });

    it("(1) 消える試験：2 回目の要求の一覧は R7 だけ（前回の R7 の場合・R7 の問題・保持した要件の ID）、応答が R7 の三種だけでも、ほかの 4 件の分類と場合は初回のまま（値・observes・参照の行・順）で、合併後の検査で問題 0 で通る。束 1・3 の要求は増えない", async () => {
      const clean = await runBundled(materials, (ids) => sliceOf(full, ids));
      const run = await runBundled(materials, r7Missing((ids) => sliceOf(full, ids)));
      if (!run.outcome.ok || !clean.outcome.ok) throw new Error(JSON.stringify(run.outcome));
      expect(run.outcome.value.rounds).toBe(2);
      expect(callsOf(run)).toEqual({ R1: 1, R6: 2, R11: 1 });
      const second = run.requests.at(-1);
      if (second === undefined) throw new Error("要求が無い");
      expect(second.ids).toEqual(["R7"]);
      expect(dataNamesOf(second.input)).toEqual([...TEST_SPEC_DATA_NAMES, ...TEST_SPEC_RETRY_DATA_NAMES, TEST_SPEC_RETAINED_DATA_NAME]);
      expect(dataBlockOf(second.input, TEST_SPEC_RETRY_DATA_NAMES[0])).toEqual(sliceOf(omitted, ["R7"]).cases);
      expect(dataBlockOf(second.input, TEST_SPEC_RETRY_DATA_NAMES[1])).toEqual([{ field: "requirements[0]", message: "abnormal の試験が無い" }]);
      expect(dataBlockOf(second.input, TEST_SPEC_RETAINED_DATA_NAME)).toEqual(["R6", "R8", "R9", "R10"]);
      // 確かめ方・所属は書き直す要件だけ、表は全行
      expect((dataBlockOf(second.input, TEST_SPEC_DATA_NAMES[3]) as readonly { readonly requirementId: string }[]).map((entry) => entry.requirementId)).toEqual(["R7"]);
      expect((dataBlockOf(second.input, TEST_SPEC_DATA_NAMES[4]) as readonly { readonly requirementId: string }[]).every((entry) => entry.requirementId === "R7")).toBe(true);
      expect((dataBlockOf(second.input, TEST_SPEC_DATA_NAMES[2]) as readonly unknown[]).length).toBe(materials.table.rows.length);
      // 保持した要件の分類と場合は初回のまま：組（試験 ID・値・observes・参照の行・順）・組の SHA・網羅の単位が、初回で通る走りと同じ
      expect(run.outcome.value.suite).toEqual(clean.outcome.value.suite);
      expect(run.outcome.value.sha256).toBe(clean.outcome.value.sha256);
      expect(run.outcome.value.coverage).toEqual(clean.outcome.value.coverage);
      expect([...run.outcome.value.observes]).toEqual([...clean.outcome.value.observes]);
      expectNoAcceptanceMaterial(run.requests.map((request) => request.input));
    });

    it("(1) 二点測定：束全体を書き直させる前の契約の応答（2 回目の応答が R7 の三種だけ）を束の全要件の要求として受けると「要件の試験が無い」で unmet になる（保持が無ければほかの要件の試験が消える）", async () => {
      const run = await runBundled(materials, r7Missing((ids) => sliceOf(full, ids)));
      expect(run.outcome.ok).toBe(true);
      // 同じ 2 回目の応答（R7 の三種）を、保持なしで束 2 の出力として合併した組の検査は、ほかの要件の試験が無いので落ちる
      const lost = { classifications: sliceOf(full, bundle2).classifications, cases: sliceOf(full, ["R7"]).cases };
      const withoutRetention = await runBundled(materials, (ids, call, head) => (head === "R6" ? (call === 1 ? lost : sliceOf(full, ids)) : sliceOf(full, ids)));
      expect(withoutRetention.outcome.ok).toBe(true);
      const content = withoutRetention.rejected.find((entry) => entry.candidate.kind === "content");
      expect(content?.candidate.problems.map((problem) => problem.message)).toContain("要件の試験が無い");
    });

    it("(2) 増える validate：2 回目の応答に保持した要件 Z（R8）の場合があれば保持した要件の固定文で落ち、束 2 の形のやり直しを使う。やり直しで通れば Z の初回の場合は採用済みのまま", async () => {
      const clean = await runBundled(materials, (ids) => sliceOf(full, ids));
      const run = await runBundled(materials, r7Missing((ids, call) => (call === 2 ? withZ(ids) : sliceOf(full, ids))));
      if (!run.outcome.ok || !clean.outcome.ok) throw new Error(JSON.stringify(run.outcome));
      expect(callsOf(run)).toEqual({ R1: 1, R6: 3, R11: 1 });
      expect(run.gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 1 });
      const shape = run.rejected.find((entry) => entry.candidate.kind === "shape");
      expect(shape?.bundle).toEqual({ index: 1, requirements: 5, rewritten: 1, retained: 4 });
      expect(shape?.candidate.problems.map((problem) => problem.message)).toEqual([TEST_CASE_BUNDLE_MESSAGES.caseRetained]);
      expect(run.outcome.value.suite).toEqual(clean.outcome.value.suite);
      // 保持した要件の分類も同じ固定文の対（分類の文）で落ちる
      const classified = await runBundled(
        materials,
        r7Missing((ids, call) => (call === 2 ? { ...sliceOf(full, ids), classifications: [...sliceOf(full, ids).classifications, { requirementId: "R9", nature: "ruled" }] } : sliceOf(full, ids))),
      );
      expect(classified.outcome.ok).toBe(true);
      expect(classified.rejected.find((entry) => entry.candidate.kind === "shape")?.candidate.problems.map((problem) => problem.message)).toEqual([TEST_CASE_BUNDLE_MESSAGES.retained]);
    });

    it("(2) 形のやり直しを使い切っていれば、保持した要件の場合を含む 2 回目の応答で追加の要求なく unmet（束 2 の呼び出し 3）", async () => {
      const shapeBad = negative({ classifications: "x", cases: "x" }, "classifications・cases が並びでない応答。束の形のやり直しを使い切る負例");
      const script = [shapeBad, sliceOf(omitted, bundle2), withZ(["R7"]), sliceOf(full, ["R7"])];
      const run = await runBundled(materials, (ids, call, head) => (head === "R6" ? script[call - 1] : sliceOf(full, ids)));
      expect(run.outcome.ok).toBe(false);
      if (run.outcome.ok) return;
      expect(run.outcome.failure.kind).toBe("unmet");
      if (run.outcome.failure.kind !== "unmet") return;
      expect(run.outcome.failure.problems.map((problem) => problem.message)).toEqual([TEST_CASE_BUNDLE_MESSAGES.caseRetained]);
      expect(callsOf(run)).toEqual({ R1: 1, R6: 3, R11: 1 });
    });

    it("(R7 a) 2 回目の合併後の検査の入力（展開後の組）に保持した要件の場合が含まれ、全部の検査が掛かる（2 回目も落ちる台本で、2 回目の中身の候補の組に全部の要件の試験があり、問題は初回と同じ）", async () => {
      const run = await runBundled(materials, (ids, _call, head) => sliceOf(head === "R6" ? omitted : full, ids));
      expect(run.outcome.ok).toBe(false);
      const contents = run.rejected.filter((entry) => entry.candidate.kind === "content");
      expect(contents).toHaveLength(2);
      const [first, second] = contents.map((entry) => entry.candidate);
      const suiteOf = (candidate: RejectedCandidate | undefined) => (candidate?.kind === "content" ? (candidate.target as TestSuite).tests : []);
      // 2 回目の組は初回の組と同じ（保持した R6・R8〜R10 と束 1・3 の場合を省かず、同じ試験 ID で同じ検査に掛かる）
      expect(suiteOf(second)).toEqual(suiteOf(first));
      expect(new Set(suiteOf(second).map((test) => test.target.requirementId))).toEqual(new Set(materials.list.requirements.map((requirement) => requirement.id)));
      expect(second?.problems).toEqual(first?.problems);
      expect(second?.problems.map((problem) => problem.message)).toEqual(["abnormal の試験が無い"]);
    });

    it("(R7 c) 同じ入力で T2 を 2 回呼ぶと、2 回目も初回（束の全要件の要求）から始まり、保持の状態を共有しない", async () => {
      const once = await runBundled(materials, r7Missing((ids) => sliceOf(full, ids)));
      const twice = await runBundled(materials, r7Missing((ids) => sliceOf(full, ids)));
      expect(twice.requests.map((request) => request.ids.length)).toEqual([5, 5, 5, 1]);
      expect(twice.requests.map((request) => request.ids)).toEqual(once.requests.map((request) => request.ids));
      expect(twice.outcome).toEqual(once.outcome);
    });

    it("帰属した要件が 2 つの束にまたがれば両方の束を呼び（それぞれ書き直す要件だけ）、ほかの束は呼ばない", async () => {
      const both = fullOf(materials, "R2");
      const r12 = fullOf(materials, "R12");
      const run = await runBundled(materials, (ids, call, head) =>
        call === 1 && head === "R1" ? sliceOf(both, ids) : call === 1 && head === "R11" ? sliceOf(r12, ids) : sliceOf(full, ids),
      );
      if (!run.outcome.ok) throw new Error(JSON.stringify(run.outcome.failure));
      expect(callsOf(run)).toEqual({ R1: 2, R6: 1, R11: 2 });
      expect(run.requests.slice(3).map((request) => request.ids)).toEqual([["R2"], ["R12"]]);
    });
  });
});
