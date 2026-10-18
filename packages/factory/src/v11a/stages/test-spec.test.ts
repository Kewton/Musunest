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
  fixtureList,
  fixtureTable,
  jsonDiffPaths,
  requestDiffsOf,
  withoutEnumMembership,
} from "../__tests__/fixtures.js";
import { deriveCarryOver, pruneForCarryOver, type CarryOver } from "../carry-over.js";
import { coverageUnitsOf } from "../coverage.js";
import { canonicalJson, nameTableSha256, type NameTable } from "../names.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, type LedgerView } from "../../v12/ledger.js";
import {
  EVALUABLE_COMBINATIONS,
  STRUCTURE_OBSERVES,
  TEST_OBSERVES,
  TEST_SPEC_DATA_NAMES,
  TEST_SPEC_DECIDED_NATURES_DATA_NAME,
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
  ledgerTargetsOf,
  testSpecRuleDefinitionsOf,
  testSpecSchemaOf,
  LEDGER_UNREGISTERED_OBSERVES_MESSAGE,
  DEFAULT_VALUE_NOT_ALLOWED_MESSAGE,
  runTestSpec,
  type DefaultValueTarget,
  type LedgerTarget,
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
  const gateway = makeGateway(recording.client, { maxAttempts: 1 });
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
