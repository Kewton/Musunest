// ②' 試験を作って固定する（stages/test-suite.ts）の unit テスト（02 §1・§1.3・F-9）。
//
// ここで固定したいのは 4 つ。
//   1. 一覧に無い要件 ID・必要な正常／異常／境界の欠落・空の試験集合・一意に決まらない selector を、
//      それぞれ固定する前に断ること
//   2. 要求の本文に宣言が含まれないこと（②' の会話に宣言を見せない。§1.3）
//   3. 満たさなければ 1 回だけ作り直し、それでも欠ける要件は未達として持つこと
//   4. ①' と同じく、送った要求を観測できること（規則とデータが別・JSON Schema が付く）
import { describe, expect, it } from "vitest";
import { checkTestSuite, STRUCTURAL_ASSERTIONS, type RequirementNature, type StructuralAssertionKind, type TestSuite } from "../fixed-test.js";
import type { DesignResult, RoleEntry } from "../pipeline.js";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeQuestion, JudgeRequest, JudgeResponse } from "../judge.js";
import {
  NATURE_JUDGE_THRESHOLD,
  NATURE_JUDGE_THRESHOLD_VERSION,
  TEST_SUITE_RULES,
  TEST_SUITE_SCHEMA_NAME,
  checkSuiteAgainstRequirements,
  checkSuitePlan,
  dropNonstructuralTests,
  natureQuestionName,
  reconcileNatures,
  runTestSuite,
  type TestSuiteInput,
} from "./test-suite.js";
import {
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  TEST_SUITE_OUTPUT,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  fixedTest,
  makeGateway,
} from "./__tests__/prompt.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

/** 問いの `instructions` を写像として読む（object でないときは undefined） */
function instructionsOf(question: JudgeQuestion | undefined): Record<string, unknown> | undefined {
  const instructions = question?.instructions;
  return typeof instructions === "object" ? (instructions as Record<string, unknown>) : undefined;
}

/** 手で書いた試験の並びを、型の付いた組にする（形は fixed-test.ts の正本を通す） */
function suiteOf(tests: readonly unknown[]): TestSuite {
  const checked = checkTestSuite(tests);
  if (!checked.ok) throw new Error(`前提が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  return checked.suite;
}

const R1_TRIPLE = [
  fixedTest("t1", "R-1", "entity", "記録する行", "normal", "action"),
  fixedTest("t2", "R-1", "entity", "記録する行", "abnormal", "action"),
  fixedTest("t3", "R-1", "entity", "記録する行", "boundary", "action"),
];
const R2_TRIPLE = [
  fixedTest("t4", "R-2", "computation", "合計を出す計算", "normal", "compute"),
  fixedTest("t5", "R-2", "computation", "合計を出す計算", "abnormal", "compute"),
  fixedTest("t6", "R-2", "computation", "合計を出す計算", "boundary", "compute"),
];

/** R-2 の境界が欠けた組（作り直しの 1 回目に使う） */
const MISSING_BOUNDARY_OUTPUT = {
  tests: [
    ...R1_TRIPLE,
    fixedTest("t4", "R-2", "computation", "合計を出す計算", "normal", "compute"),
    fixedTest("t5", "R-2", "computation", "合計を出す計算", "abnormal", "compute"),
  ],
};

describe("固定する前にコードが断る（02 §1・§1.3）", () => {
  it("正しい組は断らない", () => {
    expect(checkSuiteAgainstRequirements(REQUIREMENT_LIST, suiteOf(TEST_SUITE_OUTPUT.tests))).toEqual([]);
  });

  it("空の試験集合を断る", () => {
    const problems = checkSuiteAgainstRequirements(REQUIREMENT_LIST, suiteOf([]));
    expect(problems.some((problem) => problem.message.includes("空"))).toBe(true);
  });

  it("一覧に無い要件 ID を断る", () => {
    const tests = [...R1_TRIPLE, fixedTest("t9", "R-9", "entity", "知らない行", "normal", "action")];
    const problems = checkSuiteAgainstRequirements(REQUIREMENT_LIST, suiteOf(tests));
    expect(problems.some((problem) => problem.field.includes("requirementId"))).toBe(true);
  });

  it("必要な正常／異常／境界の欠落を断る", () => {
    const problems = checkSuiteAgainstRequirements(REQUIREMENT_LIST, suiteOf(MISSING_BOUNDARY_OUTPUT.tests));
    expect(problems.some((problem) => problem.message.includes("R-2") && problem.message.includes("boundary"))).toBe(true);
  });

  it("どの要件にも試験が無ければ断る", () => {
    const problems = checkSuiteAgainstRequirements(REQUIREMENT_LIST, suiteOf(R1_TRIPLE));
    expect(problems.some((problem) => problem.message.includes("R-2") && problem.message.includes("試験が無い"))).toBe(true);
  });

  it("一意に決まらない selector を断る", () => {
    const conflicting = fixedTest("t7", "R-1", "field", "記録する行", "normal", "action");
    const problems = checkSuiteAgainstRequirements(REQUIREMENT_LIST, suiteOf([...R1_TRIPLE, ...R2_TRIPLE, conflicting]));
    expect(problems.some((problem) => problem.message.includes("一意に決まらない"))).toBe(true);
  });
});

describe("②' は 1 回だけ作り直す（02 §1）", () => {
  it("1 回目の欠けを直せば固定できる", async () => {
    const recording = createRecordingClient([
      structured(MISSING_BOUNDARY_OUTPUT),
      structured(TEST_SUITE_OUTPUT),
    ]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.rounds).toBe(2);
    expect(recording.structured).toHaveLength(2);
  });

  it("作り直しても欠ける要件は未達として返す", async () => {
    const recording = createRecordingClient([
      structured(MISSING_BOUNDARY_OUTPUT),
      structured(MISSING_BOUNDARY_OUTPUT),
    ]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
    if (outcome.failure.kind !== "unmet") return;
    expect(outcome.failure.problems.some((problem) => problem.message.includes("boundary"))).toBe(true);
  });
});

describe("②' が送る要求を観測する（02 §2.2・§1.3）", () => {
  it("要件の一覧だけをデータに置き、宣言は見せず、JSON Schema を付ける", async () => {
    const recording = createRecordingClient([structured(TEST_SUITE_OUTPUT)]);
    const withDeclaration = {
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      declaration: "DECLARATION_SENTINEL",
    } as unknown as TestSuiteInput;
    const outcome = await runTestSuite(withDeclaration);
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input.match(/<data name=/g)).toHaveLength(1);
    expect(request.input).toContain("要件の一覧");
    expect(request.input).not.toContain("DECLARATION_SENTINEL");
    expect(request.instructions).not.toContain("DECLARATION_SENTINEL");
    expect(request.schemaName).toBe(TEST_SUITE_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("要件の文に仕込んだ「規則を無視せよ」も、規則の側へ入らない", async () => {
    const recording = createRecordingClient([structured(TEST_SUITE_OUTPUT)]);
    const list = {
      requirements: [
        {
          id: "R-1",
          text: `タスクを記録できる。${INJECTED_INSTRUCTION}`,
          quote: "タスクを記録する",
          position: { start: 0, end: 8 },
        },
      ],
      decisions: [],
      unresolved: [],
    };
    await runTestSuite({
      list,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });
});

describe("②' の不正な応答（02 §2.2）", () => {
  it("形が合わない応答は 1 回だけやり直し、2 回続くと失敗になる", async () => {
    const bad = createRecordingClient([structured({ tests: "nope" }), structured({ tests: "nope" })]);
    const failed = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: [],
      gateway: makeGateway(bad.client),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.failure.kind).toBe("malformed");
  });
});

// ── 役割 ID・入力の契約・種類（Issue #307）──────────────────────

const CLOCK = "2026-09-16T12:00:00+09:00";

/** 抽象的な役割 ID の表（entity の文脈を含む ID） */
const PLANNED_ROLES = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
  { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: false, aliasOf: null },
] as const;

/** ② の設計（役割 ID の表と、要件ごとの種類・確かめ方） */
const PLANNED_DESIGN: DesignResult = {
  roles: PLANNED_ROLES,
  designs: [
    { requirementId: "R-1", nature: "ruled", verification: { kind: "fixed-test" }, vocabulary: [], placement: [], unwritable: [] },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "在ることだけなので構造で確かめる" },
      vocabulary: [],
      placement: [],
      unwritable: [],
    },
  ],
};

const naturesOf = (entries: readonly (readonly [string, RequirementNature])[]): ReadonlyMap<string, RequirementNature> =>
  new Map(entries);

const RULED_NATURES = naturesOf([
  ["R-1", "ruled"],
  ["R-2", "existence-only"],
]);

/** 役割 ID と入力の契約を備えた試験 1 件（本番の応答の形） */
function plannedTest(options: {
  readonly id: string;
  readonly requirementId: string;
  readonly roleId?: string;
  readonly role?: string;
  readonly targetKind?: "entity" | "field" | "computation" | "operation" | "screen";
  readonly kind?: "normal" | "abnormal" | "boundary";
  readonly operation?: "compute" | "validate" | "action" | "aggregate" | "screen";
  readonly expected?: unknown;
  readonly referenceData?: readonly unknown[];
}): Record<string, unknown> {
  return {
    id: options.id,
    target: {
      requirementId: options.requirementId,
      kind: options.targetKind ?? "computation",
      ...(options.roleId === undefined ? {} : { roleId: options.roleId }),
      ...(options.role === undefined ? {} : { role: options.role }),
    },
    kind: options.kind ?? "normal",
    operation: options.operation ?? "compute",
    clock: CLOCK,
    input: { amount: 21 },
    inputContract: { rowId: "row-1", targetRowId: "row-1", emptyEntities: [] },
    referenceData: options.referenceData ?? [],
    expected: options.expected ?? { kind: "ok", value: 42 },
  };
}

/** R-1（決まりを含む）の正常・異常・境界と、R-2（在ることだけ）の正常 1 本 */
const R1_RULED = [
  plannedTest({ id: "t1", requirementId: "R-1", roleId: "record.total", kind: "normal", operation: "compute" }),
  plannedTest({
    id: "t2",
    requirementId: "R-1",
    roleId: "record.total",
    kind: "abnormal",
    operation: "compute",
    expected: { kind: "ok", value: 0 },
  }),
  plannedTest({
    id: "t3",
    requirementId: "R-1",
    roleId: "record.total",
    kind: "boundary",
    operation: "compute",
    expected: { kind: "ok", value: 0 },
  }),
];
const R2_EXISTENCE = [
  plannedTest({
    id: "t4",
    requirementId: "R-2",
    roleId: "record",
    targetKind: "entity",
    kind: "normal",
    operation: "action",
    expected: { kind: "ok", value: 1 },
  }),
];

describe("役割 ID の表と、要件ごとの種類に照らす（Issue #307）", () => {
  it("役割 ID と入力の契約を備えた正しい組は断らない", () => {
    const suite = suiteOf([...R1_RULED, ...R2_EXISTENCE]);
    expect(checkSuitePlan(REQUIREMENT_LIST, suite, PLANNED_DESIGN, RULED_NATURES)).toEqual([]);
  });

  it("在ることだけの要件に、異常の試験を作ったら断る（疎通の確認で起きた形）", () => {
    const abnormal = plannedTest({
      id: "x1",
      requirementId: "R-2",
      roleId: "record",
      targetKind: "entity",
      kind: "abnormal",
      operation: "action",
      expected: { kind: "ok", value: 1 },
    });
    const problems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([...R1_RULED, ...R2_EXISTENCE, abnormal]), PLANNED_DESIGN, RULED_NATURES);
    expect(problems.some((problem) => problem.message.includes("R-2") && problem.message.includes("在ることだけ") && problem.message.includes("abnormal"))).toBe(true);
  });

  it("在ることだけの要件に、境界の試験を作ったら断る", () => {
    const boundary = plannedTest({
      id: "x2",
      requirementId: "R-2",
      roleId: "record",
      targetKind: "entity",
      kind: "boundary",
      operation: "action",
      expected: { kind: "ok", value: 1 },
    });
    const problems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([...R1_RULED, ...R2_EXISTENCE, boundary]), PLANNED_DESIGN, RULED_NATURES);
    expect(problems.some((problem) => problem.message.includes("R-2") && problem.message.includes("boundary"))).toBe(true);
  });

  it("在ることだけの要件に、検査（validate）の試験を作ったら断る", () => {
    const validation = plannedTest({
      id: "x3",
      requirementId: "R-2",
      roleId: "record",
      targetKind: "entity",
      kind: "normal",
      operation: "validate",
      expected: { kind: "error", code: "E_X" },
    });
    const suite = suiteOf([...R1_RULED, validation]);
    const problems = checkSuitePlan(REQUIREMENT_LIST, suite, PLANNED_DESIGN, RULED_NATURES);
    expect(problems.some((problem) => problem.message.includes("R-2") && problem.message.includes("validate"))).toBe(true);
  });

  it("自由な文の役割だけで指した試験を断る（対象も参照の行も役割 ID で指す）", () => {
    const onlyRole = plannedTest({ id: "x4", requirementId: "R-1", role: "合計を出す計算", kind: "normal", operation: "compute" });
    const problems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([...R1_RULED, ...R2_EXISTENCE, onlyRole]), PLANNED_DESIGN, RULED_NATURES);
    expect(problems.some((problem) => problem.message.includes("自由な文の役割だけ"))).toBe(true);
  });

  it("参照の行の対象も、役割 ID でなければ断る", () => {
    const withRow = plannedTest({
      id: "t2",
      requirementId: "R-1",
      roleId: "record.total",
      kind: "abnormal",
      operation: "compute",
      expected: { kind: "ok", value: 0 },
      referenceData: [{ rowId: "row-2", target: { requirementId: "R-1", kind: "computation", role: "自由な文" }, values: { amount: 1 } }],
    });
    const problems = checkSuitePlan(
      REQUIREMENT_LIST,
      suiteOf([R1_RULED[0]!, withRow, R1_RULED[2]!, ...R2_EXISTENCE]),
      PLANNED_DESIGN,
      RULED_NATURES,
    );
    expect(problems.some((problem) => problem.field.includes("referenceData[0].target.roleId"))).toBe(true);
  });

  it("入力の契約に、固定の行 ID・評価の対象の行 ID・空の集合を表せる", () => {
    const withRows = plannedTest({
      id: "c1",
      requirementId: "R-1",
      roleId: "record.total",
      kind: "normal",
      operation: "compute",
      referenceData: [{ rowId: "row-2", target: { requirementId: "R-1", kind: "computation", roleId: "record.total" }, values: { amount: 1 } }],
    });
    const checked = checkTestSuite([
      { ...withRows, inputContract: { rowId: "row-1", targetRowId: "row-2", emptyEntities: ["record"] } },
    ]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const test = checked.suite.tests[0];
    expect(test?.inputContract).toEqual({ rowId: "row-1", targetRowId: "row-2", emptyEntities: ["record"] });
    expect(test?.referenceData[0]?.rowId).toBe("row-2");
  });

  it("検査（validate）の異常の期待は、誤りコードでなければ断る", () => {
    const valueExpected = plannedTest({
      id: "x5",
      requirementId: "R-1",
      roleId: "record.amount",
      targetKind: "field",
      kind: "abnormal",
      operation: "validate",
      expected: { kind: "ok", value: false },
    });
    const problems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([...R1_RULED, ...R2_EXISTENCE, valueExpected]), PLANNED_DESIGN, RULED_NATURES);
    expect(problems.some((problem) => problem.message.includes("検査（validate）の異常"))).toBe(true);
  });

  it("計算・集計の異常の期待は、値でもよい（誤りコードを要求しない）", () => {
    // R1_RULED の abnormal は、計算（compute）の期待が値（0）。断られない
    expect(checkSuitePlan(REQUIREMENT_LIST, suiteOf([...R1_RULED, ...R2_EXISTENCE]), PLANNED_DESIGN, RULED_NATURES)).toEqual([]);
  });

  it("種類が設計と食い違うとき、決まりを含むほうへ倒し、食い違いを結果に残す", () => {
    const design: DesignResult = {
      roles: [],
      designs: [
        { requirementId: "R-1", nature: "existence-only", verification: { kind: "fixed-test" }, vocabulary: [], placement: [], unwritable: [] },
      ],
    };
    const reconciled = reconcileNatures(design, [{ requirementId: "R-1", nature: "ruled" }]);
    expect(reconciled.natures.get("R-1")).toBe("ruled");
    expect(reconciled.discrepancies).toEqual([
      { requirementId: "R-1", design: "existence-only", classified: "ruled", resolved: "ruled", resolution: "fallback" },
    ]);
  });

  it("設計と分類が一致すれば、食い違いは残さない", () => {
    const reconciled = reconcileNatures(PLANNED_DESIGN, [
      { requirementId: "R-1", nature: "ruled" },
      { requirementId: "R-2", nature: "existence-only" },
    ]);
    expect(reconciled.discrepancies).toEqual([]);
    expect(reconciled.natures.get("R-2")).toBe("existence-only");
  });

  it("②' の分類が設計と食い違うと、倒した種類で検査し、食い違いを結果に残す", async () => {
    // 設計は R-1 を「在ることだけ」とするが、②' は「決まりを含む」と分類した
    const design: DesignResult = {
      ...PLANNED_DESIGN,
      designs: [
        { ...PLANNED_DESIGN.designs[0]!, nature: "existence-only" },
        PLANNED_DESIGN.designs[1]!,
      ],
    };
    const output = {
      classifications: [
        { requirementId: "R-1", nature: "ruled" },
        { requirementId: "R-2", nature: "existence-only" },
      ],
      tests: [...R1_RULED, ...R2_EXISTENCE],
    };
    const recording = createRecordingClient([structured(output)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies).toEqual([
      { requirementId: "R-1", design: "existence-only", classified: "ruled", resolved: "ruled", resolution: "fallback" },
    ]);
  });

  it("設計を渡さなければ、旧来の検査だけを行う（後方互換）", async () => {
    const recording = createRecordingClient([structured(TEST_SUITE_OUTPUT)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies).toEqual([]);
  });
});

// ── ②' に設計を渡す（Issue #316）────────────────────────────────

describe("②' に設計を渡す（Issue #316）", () => {
  /** 設計と ②' がどちらも在ることだけと分類した組（R-2 は正常 1 本だけ。疎通の確認で落ちた形） */
  const BOTH_EXISTENCE_ONLY = {
    classifications: [
      { requirementId: "R-1", nature: "ruled" },
      { requirementId: "R-2", nature: "existence-only" },
    ],
    tests: [...R1_RULED, ...R2_EXISTENCE],
  };

  it("設計と ②' がどちらも在ることだけと分類した要件は、正常の試験だけで固定できる", async () => {
    const recording = createRecordingClient([structured(BOTH_EXISTENCE_ONLY)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: PLANNED_DESIGN,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 食い違いは無く、1 回で固定する（在ることだけの R-2 に異常・境界を求めない）
    expect(outcome.value.discrepancies).toEqual([]);
    expect(outcome.value.rounds).toBe(1);
    expect(recording.structured).toHaveLength(1);
  });

  it("設計を渡すと、プロンプトのデータに役割 ID の表と要件ごとの種類が入る", async () => {
    const recording = createRecordingClient([structured(BOTH_EXISTENCE_ONLY)]);
    await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: PLANNED_DESIGN,
    });
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    // 試験の対象を指せるように、設計の役割 ID の表を渡す
    expect(request.input).toContain("役割 ID の表");
    expect(request.input).toContain("record.total");
    // 要件ごとの種類（在ることだけ）も渡す
    expect(request.input).toContain("要件ごとの種類");
    expect(request.input).toContain("existence-only");
    // 宣言は見せない（②' の会話に宣言を入れない。§1.3）
    expect(request.input).not.toContain("DECLARATION_SENTINEL");
    expect(request.instructions).not.toContain("DECLARATION_SENTINEL");
  });

  it("設計を渡さなければ、役割 ID の表と要件ごとの種類はデータに入らない（旧形式）", async () => {
    const recording = createRecordingClient([structured(TEST_SUITE_OUTPUT)]);
    await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input).not.toContain("役割 ID の表");
    expect(request.input).not.toContain("要件ごとの種類");
  });
});

// ── 種類の食い違いを判定の口に選ばせる（§1・②'・Issue #373）──────────────

/** 設計が R-1 を「在ることだけ」、R-2 を「在ることだけ」とする設計（R-1 の向きを逆にする） */
const DESIGN_R1_EXISTENCE: DesignResult = {
  roles: PLANNED_ROLES,
  designs: [
    { requirementId: "R-1", nature: "existence-only", verification: { kind: "structural", reason: "在ることだけ" }, vocabulary: [], placement: [], unwritable: [] },
    { requirementId: "R-2", nature: "existence-only", verification: { kind: "structural", reason: "在ることだけ" }, vocabulary: [], placement: [], unwritable: [] },
  ],
};

/** 在ることだけの R-1 の正常 1 本（entity の create を構造で確かめる形） */
const R1_EXISTENCE = [
  plannedTest({
    id: "e1",
    requirementId: "R-1",
    roleId: "record",
    targetKind: "entity",
    kind: "normal",
    operation: "action",
    expected: { kind: "ok", value: 1 },
  }),
];

/** 種類の判定の答え（choice。確率つき） */
const natureAnswer = (nature: string, probability?: number): JudgeAnswer => ({
  kind: "choice",
  choice: nature,
  probabilities: undefined,
  probability,
  confidence: 0.9,
});

/** 食い違いを含む ②' の答え（R-1 だけ食い違う） */
const discrepantOutput = (tests: readonly unknown[]) => ({
  classifications: [
    { requirementId: "R-1", nature: "existence-only" },
    { requirementId: "R-2", nature: "existence-only" },
  ],
  tests,
});

describe("種類の食い違いを判定の口に選ばせる（§1・②'・Issue #373）", () => {
  it("判定が閾値以上の確率で existence-only を選ぶと、その要件にふつうの試験だけで合格する", async () => {
    // 設計は R-1 を ruled とするが、②' は existence-only と分類した（食い違い）
    const recording = createRecordingClient([structured(discrepantOutput([...R1_EXISTENCE, ...R2_EXISTENCE]))]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: PLANNED_DESIGN,
      judge: createFakeJudge({ [natureQuestionName("R-1")]: natureAnswer("existence-only", 0.8) }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies).toEqual([
      {
        requirementId: "R-1",
        design: "ruled",
        classified: "existence-only",
        resolved: "existence-only",
        resolution: "judged",
        probability: 0.8,
        model: "fake-judge",
        thresholdVersion: NATURE_JUDGE_THRESHOLD_VERSION,
      },
    ]);
    // 採った種類が、返す試験集合の分類に書き込まれている（後の段が同じ種類で評価する）
    expect(outcome.value.suite.classifications).toEqual([
      { requirementId: "R-1", nature: "existence-only" },
      { requirementId: "R-2", nature: "existence-only" },
    ]);
  });

  it("設計が existence-only・試験の段が ruled の向きの食い違いでも、判定の答えで決まる", async () => {
    const recording = createRecordingClient([
      structured({
        classifications: [
          { requirementId: "R-1", nature: "ruled" },
          { requirementId: "R-2", nature: "existence-only" },
        ],
        tests: [...R1_EXISTENCE, ...R2_EXISTENCE],
      }),
    ]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: DESIGN_R1_EXISTENCE,
      judge: createFakeJudge({ [natureQuestionName("R-1")]: natureAnswer("existence-only", 0.8) }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies).toEqual([
      {
        requirementId: "R-1",
        design: "existence-only",
        classified: "ruled",
        resolved: "existence-only",
        resolution: "judged",
        probability: 0.8,
        model: "fake-judge",
        thresholdVersion: NATURE_JUDGE_THRESHOLD_VERSION,
      },
    ]);
  });

  it("確率がちょうど閾値なら採る", async () => {
    // 設計は R-1 を ruled、②' は existence-only と分類した（食い違い）
    const recording = createRecordingClient([structured(discrepantOutput([...R1_EXISTENCE, ...R2_EXISTENCE]))]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: PLANNED_DESIGN,
      judge: createFakeJudge({
        [natureQuestionName("R-1")]: natureAnswer("existence-only", NATURE_JUDGE_THRESHOLD),
      }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies[0]).toMatchObject({
      resolution: "judged",
      resolved: "existence-only",
      probability: NATURE_JUDGE_THRESHOLD,
    });
  });

  /** 設計 existence-only・②' ruled の食い違いで、R-1 に正常・異常・境界を作った組（判定で ruled に倒れると通る） */
  const RULED_SUITE_OUTPUT = {
    classifications: [
      { requirementId: "R-1", nature: "ruled" },
      { requirementId: "R-2", nature: "existence-only" },
    ],
    tests: [...R1_RULED, ...R2_EXISTENCE],
  };

  it("閾値未満なら ruled に倒れる", async () => {
    const recording = createRecordingClient([structured(RULED_SUITE_OUTPUT)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: DESIGN_R1_EXISTENCE,
      judge: createFakeJudge({ [natureQuestionName("R-1")]: natureAnswer("existence-only", 0.5) }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies).toEqual([
      { requirementId: "R-1", design: "existence-only", classified: "ruled", resolved: "ruled", resolution: "fallback" },
    ]);
  });

  it("確率が無ければ ruled に倒れる", async () => {
    const recording = createRecordingClient([structured(RULED_SUITE_OUTPUT)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: DESIGN_R1_EXISTENCE,
      judge: createFakeJudge({ [natureQuestionName("R-1")]: natureAnswer("existence-only", undefined) }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies[0]).toMatchObject({ resolved: "ruled", resolution: "fallback" });
    expect(outcome.value.discrepancies[0]?.probability).toBeUndefined();
  });

  it("選択肢に無い答えなら ruled に倒れる", async () => {
    const recording = createRecordingClient([structured(RULED_SUITE_OUTPUT)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: DESIGN_R1_EXISTENCE,
      judge: createFakeJudge({ [natureQuestionName("R-1")]: natureAnswer("unknown", 0.9) }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies[0]).toMatchObject({ resolved: "ruled", resolution: "fallback" });
  });

  it("判定の口が無ければ、今までどおり ruled に倒れる", async () => {
    const recording = createRecordingClient([structured(RULED_SUITE_OUTPUT)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: DESIGN_R1_EXISTENCE,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies).toEqual([
      { requirementId: "R-1", design: "existence-only", classified: "ruled", resolved: "ruled", resolution: "fallback" },
    ]);
  });

  it("判定が失敗したら ruled に倒れる", async () => {
    const recording = createRecordingClient([structured(RULED_SUITE_OUTPUT)]);
    const failing: Judge = {
      async judge(): Promise<JudgeResponse> {
        throw new Error("判定が失敗した");
      },
    };
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: DESIGN_R1_EXISTENCE,
      judge: failing,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.discrepancies[0]).toMatchObject({ resolved: "ruled", resolution: "fallback" });
  });

  it("食い違った要件が複数あれば、1 回の呼び出しにまとめて聞く", async () => {
    const bothRuled: DesignResult = {
      roles: PLANNED_ROLES,
      designs: [
        { requirementId: "R-1", nature: "ruled", verification: { kind: "fixed-test" }, vocabulary: [], placement: [], unwritable: [] },
        { requirementId: "R-2", nature: "ruled", verification: { kind: "fixed-test" }, vocabulary: [], placement: [], unwritable: [] },
      ],
    };
    const output = {
      classifications: [
        { requirementId: "R-1", nature: "existence-only" },
        { requirementId: "R-2", nature: "existence-only" },
      ],
      tests: [...R1_EXISTENCE, ...R2_EXISTENCE],
    };
    const recording = createRecordingClient([structured(output)]);
    const questionsSeen: string[][] = [];
    const requests: JudgeRequest[] = [];
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        questionsSeen.push(Object.keys(request.questions));
        requests.push(request);
        const answers: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) answers[name] = natureAnswer("existence-only", 0.8);
        return { answers, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
      },
    };
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: bothRuled,
      judge,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 2 つの食い違いを、1 回の呼び出しの 2 問としてまとめて聞く
    expect(questionsSeen).toEqual([[natureQuestionName("R-1"), natureQuestionName("R-2")]]);
    // それぞれの問いに、対象の要件の文が別々に載る（Issue #376）
    const first = requests[0];
    const q1 = first?.questions[natureQuestionName("R-1")];
    const q2 = first?.questions[natureQuestionName("R-2")];
    expect(q1?.instructions).toMatchObject({ requirement: "タスクを記録できる" });
    expect(q2?.instructions).toMatchObject({ requirement: "件数を合計できる" });
    expect(outcome.value.discrepancies.map((entry) => entry.requirementId)).toEqual(["R-1", "R-2"]);
  });

  it("食い違った要件だけを 1 回にまとめ、やり直しの回でも聞き直さない", async () => {
    // 1 回目は R-2 の試験が無く作り直しになる。2 回目も R-1 は ruled と分類される（食い違いのまま）
    const round1 = {
      classifications: [
        { requirementId: "R-1", nature: "ruled" },
        { requirementId: "R-2", nature: "existence-only" },
      ],
      tests: [...R1_EXISTENCE],
    };
    const round2 = {
      classifications: [
        { requirementId: "R-1", nature: "ruled" },
        { requirementId: "R-2", nature: "existence-only" },
      ],
      tests: [...R1_EXISTENCE, ...R2_EXISTENCE],
    };
    const recording = createRecordingClient([structured(round1), structured(round2)]);
    const questionsSeen: string[][] = [];
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        questionsSeen.push(Object.keys(request.questions));
        const answers: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) answers[name] = natureAnswer("existence-only", 0.8);
        return { answers, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
      },
    };
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: DESIGN_R1_EXISTENCE,
      judge,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.rounds).toBe(2);
    // 1 回だけ、食い違った R-1 の 1 問だけを聞く（2 回目のやり直しでは聞き直さない）
    expect(questionsSeen).toEqual([[natureQuestionName("R-1")]]);
    expect(outcome.value.discrepancies[0]).toMatchObject({ requirementId: "R-1", resolution: "judged" });
  });

  it("判定が失敗した要件も、やり直しの回で聞き直さない", async () => {
    const round1 = {
      classifications: [
        { requirementId: "R-1", nature: "ruled" },
        { requirementId: "R-2", nature: "existence-only" },
      ],
      tests: [...R1_EXISTENCE],
    };
    const round2 = {
      classifications: [
        { requirementId: "R-1", nature: "ruled" },
        { requirementId: "R-2", nature: "existence-only" },
      ],
      tests: [...R1_RULED, ...R2_EXISTENCE],
    };
    const recording = createRecordingClient([structured(round1), structured(round2)]);
    let calls = 0;
    const failing: Judge = {
      async judge(): Promise<JudgeResponse> {
        calls += 1;
        throw new Error("判定が失敗した");
      },
    };
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: DESIGN_R1_EXISTENCE,
      judge: failing,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.rounds).toBe(2);
    expect(calls).toBe(1);
    expect(outcome.value.discrepancies[0]).toMatchObject({ resolved: "ruled", resolution: "fallback" });
  });

  it("判定の問いには、対象の要件の文と原文の引用を載せ、設計の出力・試験は入れない（Issue #376）", async () => {
    const design: DesignResult = {
      roles: PLANNED_ROLES,
      designs: [
        { requirementId: "R-1", nature: "existence-only", verification: { kind: "fixed-test" }, vocabulary: ["DESIGN_SENTINEL"], placement: [], unwritable: [] },
        { requirementId: "R-2", nature: "existence-only", verification: { kind: "structural", reason: "在ることだけ" }, vocabulary: [], placement: [], unwritable: [] },
      ],
    };
    const output = {
      classifications: [
        { requirementId: "R-1", nature: "ruled" },
        { requirementId: "R-2", nature: "existence-only" },
      ],
      tests: [{ ...R1_EXISTENCE[0]!, id: "TEST_SENTINEL" }, ...R2_EXISTENCE],
    };
    const recording = createRecordingClient([structured(output)]);
    let request: JudgeRequest | undefined;
    const judge: Judge = {
      async judge(req: JudgeRequest): Promise<JudgeResponse> {
        request = req;
        const answers: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(req.questions)) answers[name] = natureAnswer("existence-only", 0.8);
        return { answers, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
      },
    };
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design,
      judge,
    });
    expect(outcome.ok).toBe(true);

    const question = request?.questions[natureQuestionName("R-1")];
    // instructions は object（対象の要件の文と原文の引用を問いの中に載せる）
    expect(question?.instructions).toBeTypeOf("object");
    expect(question?.instructions).toMatchObject({ requirement: "タスクを記録できる", quote: "タスクを記録する" });
    // 問いの文は英語
    expect(String(instructionsOf(question)?.ask)).toMatch(/^[\x20-\x7E]+$/);
    // 設計の出力（役割・語彙）も、試験も入らない
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("DESIGN_SENTINEL");
    expect(serialized).not.toContain("TEST_SENTINEL");
    expect(serialized).not.toContain("record.total");
  });
});

// ── 構造の検査（Issue #386）────────────────────────────────────

/** 構造の検査を試すための役割 ID の表（entity・画面・項目・操作・計算） */
const STRUCTURE_ROLES: readonly RoleEntry[] = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
  { roleId: "record.records", kind: "screen", entity: "record", name: "records", shared: false, aliasOf: null },
  { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: false, aliasOf: null },
  { roleId: "record.payer", kind: "field", entity: "record", name: "payer", shared: false, aliasOf: null },
  { roleId: "record.add", kind: "operation", entity: "record", name: "add", shared: false, aliasOf: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
  { roleId: "other", kind: "entity", entity: null, name: "other", shared: false, aliasOf: null },
  { roleId: "other.amount", kind: "field", entity: "other", name: "amount", shared: false, aliasOf: null },
];

/** checks を持つ構造の要件（R-1）と、固定した試験の要件（R-2）の設計（Issue #386） */
function structuralDesign(checks: readonly StructuralAssertionKind[]): DesignResult {
  return {
    roles: STRUCTURE_ROLES,
    designs: [
      {
        requirementId: "R-1",
        nature: "existence-only",
        verification: { kind: "structural", reason: "構造で確かめる" },
        checks: [...checks],
        vocabulary: [],
        placement: [],
        unwritable: [],
      },
      {
        requirementId: "R-2",
        nature: "ruled",
        verification: { kind: "fixed-test" },
        checks: [],
        vocabulary: [],
        placement: [],
        unwritable: [],
      },
    ],
  };
}

const STRUCTURE_NATURES: ReadonlyMap<string, RequirementNature> = new Map([
  ["R-1", "existence-only"],
  ["R-2", "ruled"],
]);

/** 構造の検査 1 件（操作 structure・種類 normal・期待は「成り立つ」） */
function structureTest(
  id: string,
  requirementId: string,
  targetKind: "entity" | "field" | "computation" | "operation" | "screen",
  roleId: string,
  assertion: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    target: { requirementId, kind: targetKind, roleId },
    kind: "normal",
    operation: "structure",
    clock: CLOCK,
    input: {},
    inputContract: { rowId: `${id}-row`, targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: true },
    assertion,
  };
}

/** 5 つの検査の中身と、その対象（役割の種類と役割 ID） */
const CHECK_CASES: Readonly<
  Record<StructuralAssertionKind, { readonly targetKind: "entity" | "field" | "computation" | "operation" | "screen"; readonly roleId: string; readonly assertion: Record<string, unknown> }>
> = {
  "field-type": { targetKind: "field", roleId: "record.payer", assertion: { check: "field-type", expected: "ref", refEntity: "record" } },
  "action-kind": { targetKind: "operation", roleId: "record.add", assertion: { check: "action-kind", expected: "create" } },
  "action-unconditioned": { targetKind: "operation", roleId: "record.add", assertion: { check: "action-unconditioned" } },
  "view-shows": { targetKind: "screen", roleId: "record.records", assertion: { check: "view-shows", role: "record.amount" } },
  "aggregate-no-period": { targetKind: "computation", roleId: "record.total", assertion: { check: "aggregate-no-period" } },
};

/** 検査の中身の並びに対する構造の検査の並び（R-1 を対象にする） */
function structureTestsFor(checks: readonly StructuralAssertionKind[]): readonly Record<string, unknown>[] {
  return checks.map((check, index) => {
    const spec = CHECK_CASES[check];
    return structureTest(`s${index}`, "R-1", spec.targetKind, spec.roleId, spec.assertion);
  });
}

/** R-2（決まりを含む）の正常・異常・境界 */
const R2_TRIPLE_PLANNED = [
  plannedTest({ id: "n2", requirementId: "R-2", roleId: "record.total", kind: "normal", operation: "compute" }),
  plannedTest({ id: "a2", requirementId: "R-2", roleId: "record.total", kind: "abnormal", operation: "compute", expected: { kind: "ok", value: 0 } }),
  plannedTest({ id: "b2", requirementId: "R-2", roleId: "record.total", kind: "boundary", operation: "compute", expected: { kind: "ok", value: 0 } }),
];

describe("構造の検査（Issue #386）", () => {
  it("設計の checks の中身ごとに構造の検査があれば、実行の試験が無くても断らない", () => {
    const checks: readonly StructuralAssertionKind[] = STRUCTURAL_ASSERTIONS;
    const suite = suiteOf([...structureTestsFor(checks), ...R2_TRIPLE_PLANNED]);
    expect(checkSuitePlan(REQUIREMENT_LIST, suite, structuralDesign(checks), STRUCTURE_NATURES)).toEqual([]);
  });

  it("checks の中身の一部だけなら、欠けた検査を挙げる", () => {
    const suite = suiteOf([...structureTestsFor(["action-kind"]), ...R2_TRIPLE_PLANNED]);
    const problems = checkSuitePlan(
      REQUIREMENT_LIST,
      suite,
      structuralDesign(["action-kind", "action-unconditioned"]),
      STRUCTURE_NATURES,
    );
    expect(
      problems.some((problem) => problem.message.includes("action-unconditioned") && problem.message.includes("無い")),
    ).toBe(true);
  });

  it("実行の試験だけで構造の検査が 0 本なら、欠けとして断る", () => {
    const execution = plannedTest({ id: "e1", requirementId: "R-1", roleId: "record.total", kind: "normal", operation: "compute" });
    const suite = suiteOf([execution, ...R2_TRIPLE_PLANNED]);
    const problems = checkSuitePlan(REQUIREMENT_LIST, suite, structuralDesign(["action-kind"]), STRUCTURE_NATURES);
    expect(problems.some((problem) => problem.message.includes("構造の検査 action-kind が無い"))).toBe(true);
  });

  it("構造の検査が、確かめ方が構造でない要件を対象にすると断る", () => {
    const wrong = structureTest("w1", "R-2", "operation", "record.add", { check: "action-kind", expected: "create" });
    const suite = suiteOf([...structureTestsFor(["action-kind"]), wrong, ...R2_TRIPLE_PLANNED]);
    const problems = checkSuitePlan(REQUIREMENT_LIST, suite, structuralDesign(["action-kind"]), STRUCTURE_NATURES);
    expect(problems.some((problem) => problem.message.includes("確かめ方が構造の要件だけを対象にできる"))).toBe(true);
  });

  it("view-shows の参照する役割が表に無い・別の entity・種類違いなら断る", () => {
    const design = structuralDesign(["view-shows"]);
    const notInTable = structureTest("v1", "R-1", "screen", "record.records", { check: "view-shows", role: "record.missing" });
    const otherEntity = structureTest("v2", "R-1", "screen", "record.records", { check: "view-shows", role: "other.amount" });
    const wrongKind = structureTest("v3", "R-1", "screen", "record.records", { check: "view-shows", role: "record" });
    const notInTableProblems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([notInTable, ...R2_TRIPLE_PLANNED]), design, STRUCTURE_NATURES);
    expect(
      notInTableProblems.some((problem) => problem.field.includes("assertion.role") && problem.message.includes("役割 ID の表に無い")),
    ).toBe(true);
    const otherEntityProblems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([otherEntity, ...R2_TRIPLE_PLANNED]), design, STRUCTURE_NATURES);
    expect(otherEntityProblems.some((problem) => problem.message.includes("別の entity"))).toBe(true);
    const wrongKindProblems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([wrongKind, ...R2_TRIPLE_PLANNED]), design, STRUCTURE_NATURES);
    expect(wrongKindProblems.some((problem) => problem.message.includes("項目か計算"))).toBe(true);
  });

  it("field-type の参照先が表に無い・entity でなければ断る", () => {
    const design = structuralDesign(["field-type"]);
    const notEntity = structureTest("f1", "R-1", "field", "record.payer", { check: "field-type", expected: "ref", refEntity: "record.amount" });
    const notInTable = structureTest("f2", "R-1", "field", "record.payer", { check: "field-type", expected: "ref", refEntity: "ghost" });
    const notEntityProblems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([notEntity, ...R2_TRIPLE_PLANNED]), design, STRUCTURE_NATURES);
    expect(notEntityProblems.some((problem) => problem.message.includes("entity の役割でなければならない"))).toBe(true);
    const notInTableProblems = checkSuitePlan(REQUIREMENT_LIST, suiteOf([notInTable, ...R2_TRIPLE_PLANNED]), design, STRUCTURE_NATURES);
    expect(notInTableProblems.some((problem) => problem.message.includes("役割 ID の表に無い"))).toBe(true);
  });

  it("checks の無い設計と assertion の無い組は、今までどおりの検査になる（後方互換）", () => {
    // PLANNED_DESIGN は R-2 が structural だが checks を持たず、R2_EXISTENCE は assertion を持たない
    const suite = suiteOf([...R1_RULED, ...R2_EXISTENCE]);
    expect(checkSuitePlan(REQUIREMENT_LIST, suite, PLANNED_DESIGN, RULED_NATURES)).toEqual([]);
  });

  it("確かめ方は、種類の分類とは別のデータの欄で渡す（Issue #386）", async () => {
    const checks: readonly StructuralAssertionKind[] = ["action-kind"];
    const design = structuralDesign(checks);
    const output = {
      classifications: [
        { requirementId: "R-1", nature: "existence-only" },
        { requirementId: "R-2", nature: "ruled" },
      ],
      tests: [...structureTestsFor(checks), ...R2_TRIPLE_PLANNED],
    };
    const recording = createRecordingClient([structured(output)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design,
    });
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request?.input).toContain("要件ごとの種類");
    expect(request?.input).toContain("要件ごとの確かめ方");
    expect(request?.input).toContain("checks");
    expect((request?.rules ?? []).join("\n")).toContain("確かめ方の欄は使わない");
  });
});

// ── 構造で確かめる要件には、構造の検査だけを固定する（§1・②'・Issue #392）──────────

/** 構造で確かめる要件（R-1）を **ruled** とする設計（種類が ruled でも構造の検査だけを作る） */
function ruledStructuralDesign(checks: readonly StructuralAssertionKind[]): DesignResult {
  const base = structuralDesign(checks);
  return { ...base, designs: [{ ...base.designs[0]!, nature: "ruled" }, base.designs[1]!] };
}

/** R-1（構造で確かめる）に、入力・画面・集計・操作の実行の試験を混ぜた ②' の答え（Issue #392） */
function mixedStructuralSuite(): { readonly tests: readonly Record<string, unknown>[] } {
  return {
    tests: [
      ...structureTestsFor(["action-kind"]),
      plannedTest({ id: "x-compute", requirementId: "R-1", roleId: "record.total", kind: "normal", operation: "compute" }),
      plannedTest({
        id: "x-validate",
        requirementId: "R-1",
        roleId: "record.amount",
        targetKind: "field",
        kind: "abnormal",
        operation: "validate",
        expected: { kind: "error", code: "E_X" },
      }),
      plannedTest({
        id: "x-action",
        requirementId: "R-1",
        roleId: "record.add",
        targetKind: "operation",
        kind: "normal",
        operation: "action",
        expected: { kind: "ok", value: null },
      }),
      plannedTest({ id: "x-aggregate", requirementId: "R-1", roleId: "record.total", kind: "normal", operation: "aggregate" }),
      // 設計の役割 ID の表に無い役割を指す実行の試験（外すので、残った試験の照合には掛からない）
      plannedTest({
        id: "x-screen",
        requirementId: "R-1",
        roleId: "record.missing",
        targetKind: "screen",
        kind: "normal",
        operation: "screen",
        expected: { kind: "ok", value: null },
      }),
      ...R2_TRIPLE_PLANNED,
    ],
  };
}

/** 外す対象の試験 ID（入力・画面・集計・操作の実行。構造の検査 s0 は残る） */
const DROPPED_IDS = ["x-compute", "x-validate", "x-action", "x-aggregate", "x-screen"] as const;

describe("構造で確かめる要件には、構造の検査だけを固定する（§1・②'・Issue #392）", () => {
  it("構造の要件の入力・画面・集計・操作の試験を外し、構造の検査と別の要件の試験は残す", async () => {
    const recording = createRecordingClient([structured(mixedStructuralSuite())]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: ruledStructuralDesign(["action-kind"]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 外した試験が戻り値に出る（回・試験 ID・要件 ID・操作）
    expect(outcome.value.dropped).toEqual(
      DROPPED_IDS.map((testId) => ({ round: 1, testId, requirementId: "R-1", operation: expect.any(String) })),
    );
    expect(outcome.value.dropped.map((entry) => entry.operation)).toEqual([
      "compute",
      "validate",
      "action",
      "aggregate",
      "screen",
    ]);
    // 構造の検査（R-1 の s0）と、fixed-test の要件（R-2）の正常・異常・境界は残る
    expect(outcome.value.suite.tests.map((test) => test.id)).toEqual(["s0", "n2", "a2", "b2"]);
  });

  it("checks の無い設計・fixed-test（checks が空）・unresolved・確かめ方の無い要件では何も外さない", () => {
    const suite = suiteOf(mixedStructuralSuite().tests);
    /** fixed-test の要件（R-2）は checks が空の並びでも外さない（R-1 の構造の検査だけを外す） */
    const fixedTestWithEmptyChecks = { requirementId: "R-2", nature: "ruled" as const, verification: { kind: "fixed-test" as const }, checks: [], vocabulary: [], placement: [], unwritable: [] };
    const designs: readonly DesignResult[] = [
      {
        roles: STRUCTURE_ROLES,
        designs: [
          { requirementId: "R-1", nature: "existence-only", verification: { kind: "structural", reason: "構造で確かめる" }, vocabulary: [], placement: [], unwritable: [] },
          fixedTestWithEmptyChecks,
        ],
      },
      {
        roles: STRUCTURE_ROLES,
        designs: [
          { requirementId: "R-1", nature: "existence-only", verification: { kind: "unresolved", reason: "確かめられない" }, vocabulary: [], placement: [], unwritable: [] },
          fixedTestWithEmptyChecks,
        ],
      },
      {
        roles: STRUCTURE_ROLES,
        designs: [
          { requirementId: "R-1", nature: "existence-only", vocabulary: [], placement: [], unwritable: [] },
          fixedTestWithEmptyChecks,
        ],
      },
    ];
    for (const design of designs) {
      expect(dropNonstructuralTests(design, suite, 1).dropped).toEqual([]);
    }
    // checks を持つ構造の要件（R-1）だけが対象で、fixed-test の R-2 の試験は残る
    expect(dropNonstructuralTests(ruledStructuralDesign(["action-kind"]), suite, 1).dropped.map((entry) => entry.testId)).toEqual([
      ...DROPPED_IDS,
    ]);
  });

  it("外す対象の試験でも、形が不正なら形の誤りとしてやり直しになる", async () => {
    const invalid = {
      tests: [{ ...plannedTest({ id: "bad", requirementId: "R-1", roleId: "record.total" }), operation: "nonsense" }],
    };
    const recording = createRecordingClient([structured(invalid), structured(invalid)]);
    const notifications: number[] = [];
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: ruledStructuralDesign(["action-kind"]),
      onDropped: (dropped) => notifications.push(dropped.length),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    // 形が合わないので、外す（通知する）ところまで届かない
    expect(notifications).toEqual([]);
  });

  it("やり直しの回をまたいでも、外した件数を回ごとに数える", async () => {
    const round1 = {
      tests: [
        ...structureTestsFor(["action-kind"]),
        plannedTest({ id: "r1-exec", requirementId: "R-1", roleId: "record.total", operation: "compute" }),
        R2_TRIPLE_PLANNED[0]!,
      ],
    };
    const round2 = {
      tests: [
        ...structureTestsFor(["action-kind"]),
        plannedTest({ id: "r2-exec", requirementId: "R-1", roleId: "record.total", operation: "compute" }),
        ...R2_TRIPLE_PLANNED,
      ],
    };
    const recording = createRecordingClient([structured(round1), structured(round2)]);
    const rounds: number[][] = [];
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: ruledStructuralDesign(["action-kind"]),
      onDropped: (dropped) => rounds.push(dropped.map((entry) => entry.round)),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.rounds).toBe(2);
    expect(outcome.value.dropped.map((entry) => [entry.round, entry.testId])).toEqual([
      [1, "r1-exec"],
      [2, "r2-exec"],
    ]);
    // 通知の口にも、回ごとに渡る（成功の戻り値だけに頼らない）
    expect(rounds).toEqual([[1], [2]]);
  });

  it("決まりの文に「構造の検査だけを作る」があり、データの欄に確かめ方の種類が入る", async () => {
    const checks: readonly StructuralAssertionKind[] = ["action-kind"];
    const output = { tests: [...structureTestsFor(checks), ...R2_TRIPLE_PLANNED] };
    const recording = createRecordingClient([structured(output)]);
    const outcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      design: ruledStructuralDesign(checks),
    });
    expect(outcome.ok).toBe(true);

    const rules = TEST_SUITE_RULES.join("\n");
    expect(rules).toContain("構造の検査だけを作る");
    // 3 種類を作る文は、確かめ方が structural の要件を除く
    const threeKinds = TEST_SUITE_RULES.find((rule) => rule.includes("3 種類"));
    expect(threeKinds).toContain("structural の要件を除いて");

    // データの例に、ruled かつ structural の要件が入る（種類と、確かめ方の種類）
    const request = recording.structured[0];
    expect(request?.input).toContain('"nature": "ruled"');
    expect(request?.input).toContain('"verificationKind": "structural"');
    expect(request?.input).toContain("要件ごとの確かめ方");
  });

  it("外したあとに構造の検査が欠ける（中身の一部だけ・0 本）なら、今までどおりやり直しになる", async () => {
    // 中身の一部だけ（action-unconditioned の構造の検査が無い）
    const partial = {
      tests: [
        ...structureTestsFor(["action-kind"]),
        plannedTest({ id: "p-exec", requirementId: "R-1", roleId: "record.total", operation: "compute" }),
        ...R2_TRIPLE_PLANNED,
      ],
    };
    const partialRun = createRecordingClient([structured(partial), structured(partial)]);
    const partialOutcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(partialRun.client, { maxAttempts: 1 }),
      design: ruledStructuralDesign(["action-kind", "action-unconditioned"]),
    });
    expect(partialOutcome.ok).toBe(false);
    if (partialOutcome.ok) return;
    expect(partialOutcome.failure.kind).toBe("unmet");
    if (partialOutcome.failure.kind !== "unmet") return;
    expect(
      partialOutcome.failure.problems.some(
        (problem) => problem.message.includes("構造の検査 action-unconditioned が無い"),
      ),
    ).toBe(true);

    // 0 本（実行の試験だけ）
    const zero = {
      tests: [
        plannedTest({ id: "z-exec", requirementId: "R-1", roleId: "record.total", operation: "compute" }),
        ...R2_TRIPLE_PLANNED,
      ],
    };
    const zeroRun = createRecordingClient([structured(zero), structured(zero)]);
    const zeroOutcome = await runTestSuite({
      list: REQUIREMENT_LIST,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(zeroRun.client, { maxAttempts: 1 }),
      design: ruledStructuralDesign(["action-kind"]),
    });
    expect(zeroOutcome.ok).toBe(false);
    if (zeroOutcome.ok) return;
    expect(zeroOutcome.failure.kind).toBe("unmet");
    if (zeroOutcome.failure.kind !== "unmet") return;
    expect(
      zeroOutcome.failure.problems.some(
        (problem) => problem.message.includes("R-1") && problem.message.includes("試験が無い"),
      ),
    ).toBe(true);
  });
});
