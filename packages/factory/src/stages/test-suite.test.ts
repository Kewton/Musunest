// ②' 試験を作って固定する（stages/test-suite.ts）の unit テスト（02 §1・§1.3・F-9）。
//
// ここで固定したいのは 4 つ。
//   1. 一覧に無い要件 ID・必要な正常／異常／境界の欠落・空の試験集合・一意に決まらない selector を、
//      それぞれ固定する前に断ること
//   2. 要求の本文に宣言が含まれないこと（②' の会話に宣言を見せない。§1.3）
//   3. 満たさなければ 1 回だけ作り直し、それでも欠ける要件は未達として持つこと
//   4. ①' と同じく、送った要求を観測できること（規則とデータが別・JSON Schema が付く）
import { describe, expect, it } from "vitest";
import { checkTestSuite, type TestSuite } from "../fixed-test.js";
import { TEST_SUITE_SCHEMA_NAME, checkSuiteAgainstRequirements, runTestSuite, type TestSuiteInput } from "./test-suite.js";
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
