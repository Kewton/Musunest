// ⑥ 直す（stages/repair.ts）の unit テスト（02 §1・§1.3・§1.5・§2.2・§4）。
//
// ここで固定したいのは 6 つ。
//   1. 直す役が試験と要件の一覧を書き換えられないこと（書き換える欄を返せば断る。結果の一覧は不変）
//   2. 原文の引用が無い主張・原文に実在しない引用の主張を受け付けないこと（捏造を弾く）
//   3. 直した後、静的チェック・対応表・固定した試験が**最後の版**で流し直され、直しによる回帰が
//      不一致として数えられること
//   4. 結果の宣言の SHA-256 が、流し直した版のバイト列のものと一致し、古い版の結果に新しい版の
//      SHA-256 が付かないこと
//   5. 主張は ⑥' の裁定へ渡り、棄却された試験が外れること
//   6. 送った要求を観測する：規則とデータを分け、その段に渡すと決めた文脈だけを置き、道具（JSON Schema）
//      を付け、受入の題材の言葉を使わないこと
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { checkTestSuite, type TestSuite } from "../fixed-test.js";
import { AGENT_LIMITS } from "../limits.js";
import type { LlmToolRequest } from "../llm.js";
import type { CorrespondenceEntry, RequirementList, VersionChecks } from "../pipeline.js";
import {
  INJECTED_INSTRUCTION,
  SAMPLE_DOCUMENTS,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";
import {
  checkDeclarationVersion,
  checkRepairAnswer,
  runRepairLoop,
  runRepairStep,
  type RepairStepInput,
} from "./repair.js";

const done = (declaration: string, disputes: readonly { testId: string; quote: string }[] = []) => ({
  kind: "tools" as const,
  response: {
    kind: "done" as const,
    declaration: { declaration, disputes },
    usage: undefined,
  },
});

const toolCalls = (calls: readonly { id: string; name: string; arguments: unknown }[]) => ({
  kind: "tools" as const,
  response: { kind: "toolCalls" as const, toolCalls: calls, usage: undefined },
});

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

/** 抽象的な題材の宣言（`total` と `extra` の式だけを差し替える。受入の題材の言葉は使わない） */
const declaration = (totalExpr: string, extraExpr: string): string =>
  [
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
    "    expression: " + totalExpr,
    "    type: number",
    "  - name: extra",
    "    entity: record",
    "    expression: " + extraExpr,
    "    type: number",
    "permissions: []",
    "minIdentity:",
    "  mode: anonymous",
    "",
  ].join("\n");

const V1 = declaration("amount * 3", "amount + 1");
const V2 = declaration("amount * 2", "amount + 1");
const V2_REGRESS = declaration("amount * 2", "amount + 2");

const SOURCE = "件数を合計する。補助の値を出す。";

const LIST: RequirementList = {
  requirements: [
    { id: "R-1", text: "件数を合計できる", quote: "件数を合計する", position: { start: 0, end: 8 } },
    { id: "R-2", text: "補助の値を出せる", quote: "補助の値を出す", position: { start: 9, end: 16 } },
  ],
  decisions: [],
  unresolved: [],
};

const suiteOf = (tests: readonly unknown[]): TestSuite => {
  const checked = checkTestSuite(tests);
  if (!checked.ok) throw new Error(`前提が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  return checked.suite;
};

const SUITE = suiteOf([
  {
    id: "t1",
    target: { requirementId: "R-1", kind: "computation", role: "合計を出す計算" },
    kind: "normal",
    operation: "compute",
    clock: "2026-09-16T12:00:00+09:00",
    input: { amount: 21 },
    referenceData: [],
    expected: { kind: "ok", value: 42 },
  },
  {
    id: "t2",
    target: { requirementId: "R-2", kind: "computation", role: "補助の値の計算" },
    kind: "normal",
    operation: "compute",
    clock: "2026-09-16T12:00:00+09:00",
    input: { amount: 21 },
    referenceData: [],
    expected: { kind: "ok", value: 22 },
  },
]);

const CORRESPONDENCES: readonly CorrespondenceEntry[] = [
  { requirementId: "R-1", locations: [{ kind: "computation", entity: "record", name: "total" }] },
  { requirementId: "R-2", locations: [{ kind: "computation", entity: "record", name: "extra" }] },
];

/** 固定した試験の fixture が、意図どおり動くことの前提（t1 は V1 で落ち、V2 で通る） */
const version = (source: string): Promise<VersionChecks> =>
  checkDeclarationVersion({ source }, { list: LIST, suite: SUITE, correspondences: CORRESPONDENCES });

const limits = (repairRoundTrips: number) => ({ ...AGENT_LIMITS, repairRoundTrips });

// ── 1・2. 直す役の主張と、試験・要件の一覧の不可変 ──────────────────────

describe("直す役は試験と要件の一覧を書き換えられない（02 §1.3）", () => {
  const testIds = new Set(SUITE.tests.map((test) => test.id));

  it("試験を書き換える欄を返せば断る", () => {
    const checked = checkRepairAnswer(
      { declaration: V2, tests: [{ id: "t1", expected: { kind: "ok", value: 999 } }] },
      SOURCE,
      testIds,
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.problems.map((problem) => problem.field)).toContain("tests");
  });

  it("要件の一覧を書き換える欄も断る", () => {
    const checked = checkRepairAnswer({ declaration: V2, requirements: [] }, SOURCE, testIds);
    expect(checked.ok).toBe(false);
  });

  it("一覧に無い試験 ID の主張は、受け付けずに理由つきで残す", () => {
    const checked = checkRepairAnswer(
      { declaration: V2, disputes: [{ testId: "t9", quote: "件数を合計する" }] },
      SOURCE,
      testIds,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.disputes).toEqual([]);
    expect(checked.value.rejected[0]?.reason).toContain("一覧に無い");
  });

  it("試験を書き換える応答は、段の失敗として断る", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([
      {
        kind: "tools",
        response: {
          kind: "done",
          declaration: { declaration: V2, tests: [{ id: "t1", expected: { kind: "ok", value: 0 } }] },
          usage: undefined,
        },
      },
    ]);
    const outcome = await runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
  });
});

describe("原文の引用を根拠にした主張だけを受け付ける（02 §1.3・R-2）", () => {
  const testIds = new Set(SUITE.tests.map((test) => test.id));

  it("引用が無い主張は受け付けない", () => {
    const checked = checkRepairAnswer({ declaration: V2, disputes: [{ testId: "t1" }] }, SOURCE, testIds);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.disputes).toEqual([]);
    expect(checked.value.rejected[0]?.reason).toContain("引用が無い");
  });

  it("原文に実在しない引用（捏造）の主張は受け付けない", () => {
    const checked = checkRepairAnswer(
      { declaration: V2, disputes: [{ testId: "t1", quote: "原文に存在しない文" }] },
      SOURCE,
      testIds,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.disputes).toEqual([]);
    expect(checked.value.rejected[0]?.reason).toContain("実在しない");
  });

  it("原文に実在する引用を添えた主張は受け付ける", () => {
    const checked = checkRepairAnswer(
      { declaration: V2, disputes: [{ testId: "t1", quote: "件数を合計する" }] },
      SOURCE,
      testIds,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.disputes).toEqual([{ testId: "t1", quote: "件数を合計する" }]);
    expect(checked.value.rejected).toEqual([]);
  });
});

// ── 3・4. 流し直しと SHA-256 ────────────────────────────────────────

describe("直した後は最後の版で流し直す（02 §1）", () => {
  it("直しで前に通っていたものが落ちたら、回帰として不一致に数える", async () => {
    const initial = await version(V1);
    expect(initial.testRun?.mismatches.map((entry) => entry.testId)).toEqual(["t1"]);

    const recording = createRecordingClient([done(V2_REGRESS)]);
    const outcome = await runRepairLoop({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      initial,
      limits: limits(1),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.rounds).toBe(1);
    expect(outcome.value.limitReached).toBe(true);
    expect(outcome.value.regressions.map((entry) => entry.testId)).toEqual(["t2"]);
    // 回帰は、最後の版の不一致に**含まれる**（⑦ で不一致として数えられる）
    expect(outcome.value.final.testRun?.mismatches.map((entry) => entry.testId)).toEqual(["t2"]);
    expect(outcome.value.final.declaration.source).toBe(V2_REGRESS);
  });

  it("全部満たせば、1 往復で止まる（回帰なし）", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([done(V2)]);
    const outcome = await runRepairLoop({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      initial,
      limits: limits(6),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.rounds).toBe(1);
    expect(outcome.value.limitReached).toBe(false);
    expect(outcome.value.regressions).toEqual([]);
    expect(outcome.value.final.testRun?.mismatches).toEqual([]);
    // 直す役は、要件の一覧も固定した試験も書き換えられない
    expect(outcome.value.list).toEqual(LIST);
    expect(outcome.value.suite.tests.map((test) => test.id)).toEqual(["t1", "t2"]);
  });
});

describe("結果の SHA-256 は、流し直した版のものだけにする（02 §4）", () => {
  it("古い版の結果に、新しい版の SHA-256 を付けない", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([done(V2)]);
    const outcome = await runRepairLoop({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      initial,
      limits: limits(6),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.versions).toHaveLength(2);
    const [first, second] = outcome.value.versions;
    expect(first?.declarationSha256).toBe(await sha256Hex(V1));
    expect(second?.declarationSha256).toBe(await sha256Hex(V2));
    expect(outcome.value.final.declarationSha256).toBe(await sha256Hex(V2));
    expect(first?.declarationSha256).not.toBe(outcome.value.final.declarationSha256);
  });
});

// ── 5. ⑥' の裁定との連携 ───────────────────────────────────────────

describe("主張は ⑥' の裁定へ渡る（02 §1.3）", () => {
  it("棄却された試験は外れ、残りが満たせば止まる", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([
      done(V2, [{ testId: "t1", quote: "件数を合計する" }]),
      structured({
        decisions: [{ testId: "t1", verdict: "overturn", reason: "原文の数え方が違う", quote: "件数を合計する" }],
      }),
    ]);
    const outcome = await runRepairLoop({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      initial,
      limits: limits(6),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.overturned).toEqual([
      { testId: "t1", reason: "原文の数え方が違う", quote: "件数を合計する" },
    ]);
    expect(outcome.value.suite.tests.map((test) => test.id)).toEqual(["t2"]);
    expect(outcome.value.unresolved).toEqual([]);
  });

  it("維持された期待は、直した宣言で満たして止まる", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([
      done(V2, [{ testId: "t1", quote: "件数を合計する" }]),
      structured({
        decisions: [{ testId: "t1", verdict: "uphold", reason: "期待は原文のとおり", quote: "" }],
      }),
    ]);
    const outcome = await runRepairLoop({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      initial,
      limits: limits(6),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.upheld).toEqual(["t1"]);
    expect(outcome.value.overturned).toEqual([]);
    // 維持された期待は外さず、直した宣言（最後の版）で満たしている
    expect(outcome.value.final.declaration.source).toBe(V2);
    expect(outcome.value.final.testRun?.mismatches).toEqual([]);
    expect(outcome.value.rounds).toBe(1);
  });
});

// ── 6. 送った要求を観測する ────────────────────────────────────────

describe("⑥ が送る要求を観測する（02 §2.2）", () => {
  it("決めた文脈だけをデータに置き、道具を付け、規則とデータを分ける", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([
      toolCalls([{ id: "c1", name: "static-check", arguments: { declaration: V1 } }]),
      done(V2),
    ]);
    const outcome = await runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(true);

    const request: LlmToolRequest | undefined = recording.tools[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.input.match(/<data name=/g)).toHaveLength(7);
    expect(request.input).toContain("原文");
    expect(request.input).toContain("要件の一覧");
    expect(request.input).toContain("固定した試験");
    expect(request.input).toContain("宣言");
    expect(request.input).toContain("静的チェックの結果");
    expect(request.input).toContain("対応表の落ち");
    expect(request.input).toContain("試験の結果");
    expect(request.instructions).toContain("変えられない");
    expect(request.instructions).not.toContain(V1);
    expect(request.tools).toHaveLength(3);
    for (const tool of request.tools) expect(tool.parameters).toBeTypeOf("object");
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
  });

  it("データに仕込んだ「規則を無視せよ」は、規則の側へ入らない", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([done(V2)]);
    await runRepairStep({
      source: `${SOURCE}${INJECTED_INSTRUCTION}`,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    const request = recording.tools[0];
    expect(request?.input).toContain(INJECTED_INSTRUCTION);
    expect(request?.instructions).not.toContain(INJECTED_INSTRUCTION);
  });

  it("渡すと決めていない文脈（余分な欄）は、データにも規則にも入らない", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([done(V2)]);
    const withExtra = {
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      correspondenceSentinel: "CORRESPONDENCE_SENTINEL",
    } as unknown as RepairStepInput;
    await runRepairStep(withExtra);
    const request = recording.tools[0];
    expect(request?.input).not.toContain("CORRESPONDENCE_SENTINEL");
    expect(request?.instructions).not.toContain("CORRESPONDENCE_SENTINEL");
  });
});

// ── 道具の引数・上限を、コードが断る ──────────────────────────────

describe("道具の引数と上限を、コードが断る（02 §2.2・§1.5）", () => {
  it("形の合わない道具の引数は、呼ばずに断る", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([
      toolCalls([{ id: "c1", name: "static-check", arguments: { declaration: "" } }]),
    ]);
    const outcome = await runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
  });

  it("上限を超える宣言を返せば、形の誤りとして断る", async () => {
    const initial = await version(V1);
    const huge = "x".repeat(AGENT_LIMITS.declarationBytes + 1);
    const recording = createRecordingClient([done(huge)]);
    const outcome = await runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
  });
});
