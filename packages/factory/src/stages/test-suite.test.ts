// ②' 試験を作って固定する（stages/test-suite.ts）の unit テスト（02 §1・§1.3・F-9）。
//
// ここで固定したいのは 4 つ。
//   1. 一覧に無い要件 ID・必要な正常／異常／境界の欠落・空の試験集合・一意に決まらない selector を、
//      それぞれ固定する前に断ること
//   2. 要求の本文に宣言が含まれないこと（②' の会話に宣言を見せない。§1.3）
//   3. 満たさなければ 1 回だけ作り直し、それでも欠ける要件は未達として持つこと
//   4. ①' と同じく、送った要求を観測できること（規則とデータが別・JSON Schema が付く）
import { describe, expect, it } from "vitest";
import { checkTestSuite, type RequirementNature, type TestSuite } from "../fixed-test.js";
import type { DesignResult } from "../pipeline.js";
import {
  TEST_SUITE_SCHEMA_NAME,
  checkSuiteAgainstRequirements,
  checkSuitePlan,
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
      { requirementId: "R-1", design: "existence-only", classified: "ruled", resolved: "ruled" },
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
      { requirementId: "R-1", design: "existence-only", classified: "ruled", resolved: "ruled" },
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
