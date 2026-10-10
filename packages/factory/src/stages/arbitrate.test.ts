// ⑥' 期待の裁定（stages/arbitrate.ts）の unit テスト（02 §1.3・R-2）。
//
// ここで固定したいのは 4 つ。
//   1. 3 つの分岐（維持・棄却・裁定不能）それぞれで、維持の一覧・棄却の記録（理由と引用）・未解決が
//      正しく返ること
//   2. 引用の無い棄却・原文に実在しない引用の棄却を、認めないこと（未解決へ落とす）
//   3. 主張に無い試験 ID を裁定させないこと（試験を書き換えさせない）
//   4. 送った要求を観測する：原文・要件の一覧・試験・宣言・主張だけをデータに置き、JSON Schema を付け、
//      規則とデータを分け、受入の題材の言葉を使わないこと
import { describe, expect, it } from "vitest";
import { checkTestSuite, type TestSuite } from "../fixed-test.js";
import type { Declaration, Dispute } from "../pipeline.js";
import { CONFIRMED_PLAN } from "../__tests__/run.js";
import {
  ARBITRATION_SCHEMA_NAME,
  checkArbitrationOutput,
  runArbitration,
  type ArbitrationInput,
} from "./arbitrate.js";
import {
  INJECTED_INSTRUCTION,
  REQUIREMENT_LIST,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  fixedTest,
  makeGateway,
} from "./__tests__/prompt.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

const suiteOf = (tests: readonly unknown[]): TestSuite => {
  const checked = checkTestSuite(tests);
  if (!checked.ok) throw new Error(`前提が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  return checked.suite;
};

const SUITE = suiteOf([
  fixedTest("t1", "R-1", "entity", "記録する行", "normal", "action"),
  fixedTest("t2", "R-2", "computation", "合計を出す計算", "normal", "compute"),
  fixedTest("t3", "R-2", "computation", "合計を出す計算", "boundary", "compute"),
]);

const DECLARATION: Declaration = { source: "entities: []\n" };

const disputes = (...ids: readonly string[]): readonly Dispute[] =>
  ids.map((testId) => ({ testId, quote: "件数を合計する" }));

const baseInput = (disputed: readonly Dispute[]): ArbitrationInput => ({
  source: SOURCE_TEXT,
  list: REQUIREMENT_LIST,
  suite: SUITE,
  declaration: DECLARATION,
  disputes: disputed,
  documents: SAMPLE_DOCUMENTS,
  gateway: makeGateway(createRecordingClient([]).client),
});

describe("3 つの分岐（02 §1.3）", () => {
  it("維持は upheld へ、棄却は理由と引用つきで overturned へ、裁定不能は unresolved へ", async () => {
    const recording = createRecordingClient([
      structured({
        decisions: [
          { testId: "t1", verdict: "uphold", reason: "期待は原文のとおり", quote: "" },
          { testId: "t2", verdict: "overturn", reason: "原文の数え方が違う", quote: "件数を合計する" },
          { testId: "t3", verdict: "undecidable", reason: "原文からは決められない", quote: "" },
        ],
      }),
    ]);
    const outcome = await runArbitration({
      ...baseInput(disputes("t1", "t2", "t3")),
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.upheld).toEqual(["t1"]);
    expect(outcome.value.overturned).toEqual([
      { testId: "t2", reason: "原文の数え方が違う", quote: "件数を合計する" },
    ]);
    expect(outcome.value.unresolved).toEqual(["t3"]);
  });

  it("判断の無い主張は、未解決として残す（黙って合格にしない）", () => {
    const checked = checkArbitrationOutput({ decisions: [] }, disputes("t1"), SOURCE_TEXT);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.unresolved).toEqual(["t1"]);
  });

  it("引用の無い棄却を認めない（未解決へ落とす）", () => {
    const checked = checkArbitrationOutput(
      { decisions: [{ testId: "t1", verdict: "overturn", reason: "誤りのはず", quote: "" }] },
      disputes("t1"),
      SOURCE_TEXT,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.overturned).toEqual([]);
    expect(checked.value.unresolved).toEqual(["t1"]);
  });

  it("原文に実在しない引用の棄却を認めない（捏造を弾く）", () => {
    const checked = checkArbitrationOutput(
      { decisions: [{ testId: "t1", verdict: "overturn", reason: "誤り", quote: "原文に無い文" }] },
      disputes("t1"),
      SOURCE_TEXT,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.unresolved).toEqual(["t1"]);
  });
});

describe("試験を書き換えさせない（02 §1.3）", () => {
  it("主張に無い試験 ID を裁定させない（断る）", () => {
    const checked = checkArbitrationOutput(
      { decisions: [{ testId: "t9", verdict: "uphold", reason: "x", quote: "" }] },
      disputes("t1"),
      SOURCE_TEXT,
    );
    expect(checked.ok).toBe(false);
  });

  it("同じ試験の判断が重なれば断る", () => {
    const checked = checkArbitrationOutput(
      {
        decisions: [
          { testId: "t1", verdict: "uphold", reason: "x", quote: "" },
          { testId: "t1", verdict: "undecidable", reason: "y", quote: "" },
        ],
      },
      disputes("t1"),
      SOURCE_TEXT,
    );
    expect(checked.ok).toBe(false);
  });
});

describe("⑥' が送る要求を観測する（02 §2.2）", () => {
  const answer = { decisions: [{ testId: "t1", verdict: "uphold", reason: "期待は正しい", quote: "" }] };

  it("原文・要件の一覧・試験・宣言・主張だけをデータに置き、JSON Schema を付ける", async () => {
    const recording = createRecordingClient([structured(answer)]);
    const outcome = await runArbitration({
      ...baseInput(disputes("t1")),
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input.match(/<data name=/g)).toHaveLength(5);
    expect(request.input).toContain("原文");
    expect(request.input).toContain("要件の一覧");
    expect(request.input).toContain("固定した試験");
    expect(request.input).toContain("宣言");
    expect(request.input).toContain("直す役の主張");
    expect(request.instructions).not.toContain(DECLARATION.source);
    expect(request.schemaName).toBe(ARBITRATION_SCHEMA_NAME);
    expect(request.schema).toBeTypeOf("object");
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("データに仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const recording = createRecordingClient([structured(answer)]);
    await runArbitration({
      ...baseInput(disputes("t1")),
      source: `${SOURCE_TEXT}${INJECTED_INSTRUCTION}`,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.structured[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });

  it("渡すと決めていない文脈（余分な欄）は、データにも規則にも入らない", async () => {
    const recording = createRecordingClient([structured(answer)]);
    const withExtra = {
      ...baseInput(disputes("t1")),
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      staticCheckSentinel: "STATIC_SENTINEL",
    } as unknown as ArbitrationInput;
    await runArbitration(withExtra);
    const request = recording.structured[0];
    expect(request?.input).not.toContain("STATIC_SENTINEL");
    expect(request?.instructions).not.toContain("STATIC_SENTINEL");
  });
});

// ── 確定した仕様と食い違う主張は「Plan に戻す」（§5・Issue #334）──────────────

describe("確定した仕様と食い違う主張は「Plan に戻す」（§5・Issue #334）", () => {
  it("return-to-plan の判断は returnToPlan に入り、維持も棄却もしない", async () => {
    const recording = createRecordingClient([
      structured({
        decisions: [{ testId: "t1", verdict: "return-to-plan", reason: "確定した仕様と食い違う", quote: "" }],
      }),
    ]);
    const outcome = await runArbitration({
      ...baseInput(disputes("t1")),
      plan: CONFIRMED_PLAN,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.returnToPlan).toEqual(["t1"]);
    expect(outcome.value.upheld).toEqual([]);
    expect(outcome.value.overturned).toEqual([]);
    expect(outcome.value.unresolved).toEqual([]);
  });

  it("確定した仕様が無ければ、戻す先が無いので未解決へ落とす", () => {
    const checked = checkArbitrationOutput(
      { decisions: [{ testId: "t1", verdict: "return-to-plan", reason: "戻す先が無い", quote: "" }] },
      disputes("t1"),
      SOURCE_TEXT,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.returnToPlan).toEqual([]);
    expect(checked.value.unresolved).toEqual(["t1"]);
  });

  it("確定した仕様があるときは、データに確定した仕様を入れる", async () => {
    const recording = createRecordingClient([
      structured({ decisions: [{ testId: "t1", verdict: "uphold", reason: "期待は正しい", quote: "" }] }),
    ]);
    await runArbitration({
      ...baseInput(disputes("t1")),
      plan: CONFIRMED_PLAN,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(recording.structured[0]?.input).toContain("確定した仕様");
  });
});
