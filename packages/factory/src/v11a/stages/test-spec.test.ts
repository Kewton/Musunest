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
import { ruleDefinitionDefects, ruleTexts, type RejectedCandidate } from "../../stages/prompt.js";
import {
  NATURE_JUDGE_THRESHOLD,
  TEST_SUITE_RULE_DEFINITIONS,
  runTestSuite,
  natureQuestionName,
} from "../../stages/test-suite.js";
import { createRecordingClient, expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import { FIXTURE_DOCUMENTS, fixtureList, fixtureTable } from "../__tests__/fixtures.js";
import { deriveCarryOver, pruneForCarryOver, type CarryOver } from "../carry-over.js";
import { coverageUnitsOf } from "../coverage.js";
import { canonicalJson, nameTableSha256, type NameTable } from "../names.js";
import {
  EVALUABLE_COMBINATIONS,
  STRUCTURE_OBSERVES,
  TEST_OBSERVES,
  TEST_SPEC_DATA_NAMES,
  TEST_SPEC_RETRY_DATA_NAMES,
  TEST_SPEC_ROUNDS,
  TEST_SPEC_RULES,
  TEST_SPEC_RULE_DEFINITIONS,
  TEST_SPEC_SCHEMA,
  TEST_SPEC_SCHEMA_NAME,
  checkEvaluability,
  runTestSpec,
  type TestObserves,
  type TestSpecInput,
} from "./test-spec.js";

// ── 題材 ──────────────────────────────────────────────────────────

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

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
    expected: structure
      ? { kind: "ok", value: "true", code: null }
      : errorExpected
        ? { kind: "error", value: null, code: "E_INVALID" }
        : { kind: "ok", value: "1", code: null },
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

/** R3：操作の条件の正常・異常・境界（`kinds` で欠けを作る） */
const r3Action = (kinds: readonly ("normal" | "abnormal" | "boundary")[] = KINDS, roleId = "o.closeItem") =>
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
    }),
  );

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

/** 通る応答（R5 だけ持ち越し） */
const passing = () => response([...r1Validate(), ...r2Structure(), ...r3Action(), ...r4Compute()]);

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
async function run(
  outputs: readonly unknown[],
  options: Partial<Omit<TestSpecInput, "gateway">> & { readonly rejected?: readonly string[] } = {},
) {
  const table = options.table ?? fixtureTable();
  const carryOver = options.carryOver ?? (await carryOverFor(table, options.rejected));
  const recording = createRecordingClient(outputs.map(structured));
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
    const recording = createRecordingClient([]);
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
  "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態・項目の既定値の試験は作らない）",
  "（対象の種類・操作・観測する性質）の組が評価の方法の表に無い",
];

describe("評価可能性（対象の種類・操作・observes を評価の方法の表に照らす。§2.3 の (i)）", () => {
  it("表にある組の全部が通り、表に無い組（未対応の性質を含む）は全部が固定文で落ちる（全組を列挙）", () => {
    const listed = new Set(EVALUABLE_COMBINATIONS.map((entry) => `${entry.targetKind}|${entry.operation}|${entry.observes}`));
    expect(listed.size).toBe(8);
    let passed = 0;
    for (const targetKind of TEST_TARGET_KINDS) {
      for (const operation of TEST_OPERATIONS.filter((candidate) => candidate !== "structure")) {
        for (const observes of TEST_OBSERVES) {
          const test = bareTest("t", targetKind, operation);
          const problems = checkEvaluability({ tests: [test] }, new Map([["t", observes]]));
          if (listed.has(`${targetKind}|${operation}|${observes}`)) {
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
    expect(passed).toBe(EVALUABLE_COMBINATIONS.length);
  });

  it("state-after-set・default-value は、どの組でも未対応の固定文で落ちる", () => {
    for (const observes of ["state-after-set", "default-value"] as const) {
      const problems = checkEvaluability({ tests: [bareTest("t", "operation", "action")] }, new Map([["t", observes]]));
      expect(problems).toEqual([
        {
          field: "tests[0].observes",
          message: "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態・項目の既定値の試験は作らない）",
        },
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
      ...r3Action().map((test, index) => (index === 0 ? { ...test, observes: "state-after-set" } : test)),
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
        message: "観測する性質が評価の方法の表で未対応である（操作に set を当てたあとの状態・項目の既定値の試験は作らない）",
      },
    ]);
  });

  it("段で operation × action × value の試験を作れば、評価の方法の表に無い組として落ちる", async () => {
    const bad = response([
      ...r1Validate(),
      ...r2Structure(),
      ...r3Action().map((test) => ({ ...test, observes: "value" })),
      ...r4Compute(),
    ]);
    const { outcome } = await run([bad, bad]);
    if (outcome.ok || outcome.failure.kind !== "unmet") throw new Error("unmet でない");
    expect(outcome.failure.problems.map((problem) => problem.message)).toEqual(
      Array(3).fill("（対象の種類・操作・観測する性質）の組が評価の方法の表に無い"),
    );
  });

  it("知らない observes は形の落ち（共通の窓口が 1 回やり直し、2 回で malformed）", async () => {
    const bad = response([...r1Validate(), ...r2Structure(), ...r3Action(), ...r4Compute()].map((test) => ({ ...test, observes: "other" })));
    const { outcome, recording } = await run([bad, bad]);
    if (outcome.ok || outcome.failure.kind !== "malformed") throw new Error("malformed でない");
    expect(recording.structured).toHaveLength(2);
    expect(outcome.failure.problems.every((problem) => problem.field.endsWith(".observes"))).toBe(true);
  });

  it("試験 ID の重なりは形の落ち", async () => {
    const tests = [...r1Validate(), ...r2Structure(), ...r3Action(), ...r4Compute()];
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
    expect(value.sha256).toBe(await sha256Hex(canonicalJson(value.suite)));
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

// ── 観測用の口（onDropped・onRejected）──────────────────────────────────

/** 通知の種類・回・試行の並び */
const shapeOf = (seen: readonly RejectedCandidate[]) =>
  seen.map((candidate) => ({ kind: candidate.kind, round: candidate.round, attempt: candidate.attempt }));

describe("onDropped・onRejected は v1 の ②' と同じ回数で呼ばれ、口の有無で要求が変わらない", () => {
  const round1 = () =>
    response([...r1Validate(), r2Execution("r2-exec-1"), ...r2Structure(), ...r3Action(["normal", "abnormal"]), ...r4Compute()]);
  const round2 = () => response([...r1Validate(), r2Execution("r2-exec-2"), ...r2Structure(), ...r3Action(), ...r4Compute()]);
  const invalid = { tests: 123 };

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
