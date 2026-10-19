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
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBudget } from "../budget.js";
import { CallGateway, type CallGatewayOptions } from "../call.js";
import { checkTestSuite, type TestSuite } from "../fixed-test.js";
import { AGENT_LIMITS } from "../limits.js";
import type { RecordedCall } from "../llm-fake.js";
import type { LlmClient, LlmStructuredResponse, LlmToolRequest, LlmToolResponse } from "../llm.js";
import {
  LEGACY_DESIGN_CONTRACT,
  type CorrespondenceEntry,
  type RequirementList,
  type RoleEntry,
  type RoleNameMapping,
  type VersionChecks,
} from "../pipeline.js";
import type { RequirementRoleOwnership } from "./correspondence.js";
import {
  INJECTED_INSTRUCTION,
  SAMPLE_DOCUMENTS,
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
} from "./__tests__/prompt.js";
import * as bindModule from "./bind.js";
import * as correspondenceModule from "./correspondence.js";
import type { TestRunReport } from "./run-tests.js";
import type { DeclarationEvaluator, EvaluationContext } from "./tools.js";
import {
  DECLARATION_REJECTIONS_DATA_NAME,
  REPAIR_STEP_LIMITS_DATA_NAME,
  checkDeclarationVersion,
  checkRepairAnswer,
  failureSignature,
  isStagnant,
  REPAIR_ANSWER_SCHEMA,
  REPAIR_ANSWER_SCHEMA_NAME,
  runRepairLoop,
  runRepairStep,
  type RepairStepCounts,
  type RepairStepInput,
  type VersionReport,
} from "./repair.js";
import * as repairTools from "./tools.js";

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

/** 最後の答えの形が合わない done（宣言が文字列でない。02 §2.2・#304） */
const doneMalformed = {
  kind: "tools" as const,
  response: { kind: "done" as const, declaration: { declaration: 123 }, usage: undefined },
};

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
    if (outcome.failure.kind !== "malformed") return;
    // 1 回だけ直させる（問題を返して再試行し、2 回続けて合わなければ失敗）
    expect(outcome.failure.attempts).toBe(2);
    expect(outcome.failure.problems.map((problem) => problem.field)).toContain("tests");
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
    expect((request.rules ?? []).join("\n")).toContain("変えられない");
    expect(request.instructions).not.toContain(V1);
    expect(request.tools).toHaveLength(3);
    for (const tool of request.tools) expect(tool.parameters).toBeTypeOf("object");
    expectNoAcceptanceMaterial([
      request.instructions,
      ...(request.rules ?? []),
      request.input,
      ...request.documents,
    ]);
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
    const recording = createRecordingClient([done(huge), done(huge)]);
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

// ── 最後の答えの形を決め、合わなければ 1 回だけ直させる（02 §2.2・#304）──

describe("最後の答えの形を決め、合わなければ 1 回だけ直させる（02 §2.2・#304）", () => {
  const stepWith = (recorded: Parameters<typeof createRecordingClient>[0]) => {
    const recording = createRecordingClient(recorded);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });
    return {
      recording,
      gateway,
      run: version(V1).then((current) =>
        runRepairStep({
          source: SOURCE,
          list: LIST,
          suite: SUITE,
          current,
          correspondences: CORRESPONDENCES,
          documents: SAMPLE_DOCUMENTS,
          gateway,
        }),
      ),
    };
  };

  it("⑥ の要求に、最後の答えの形を決める strict の schema（構造化出力）を付ける", async () => {
    const { recording, run } = stepWith([done(V2)]);
    const outcome = await run;
    expect(outcome.ok).toBe(true);

    const request = recording.tools[0];
    expect(request?.schemaName).toBe(REPAIR_ANSWER_SCHEMA_NAME);
    expect(request?.schema).toEqual(REPAIR_ANSWER_SCHEMA);
  });

  it("形が合わなければ、問題を返して 1 回だけ直させ、合えば通る", async () => {
    const { recording, gateway, run } = stepWith([doneMalformed, done(V2)]);
    const outcome = await run;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.declaration.source).toBe(V2);

    // 2 回呼び、2 回目の要求に、問題（欄の名前と種類）がデータとして足されている
    expect(recording.tools).toHaveLength(2);
    expect(recording.tools[0]?.input).not.toContain("最後の答えの形の誤り");
    const second = recording.tools[1]?.input ?? "";
    expect(second).toContain("最後の答えの形の誤り");
    expect(second).toContain("declaration");
    expect(second).toContain("空でない文字列");
    // 最後の答えの形の誤りで 1 回直させた＝形の再試行 1（Issue #446）
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 0 });
  });

  it("道具の往復だけで通る例では、形の再試行は 0（Issue #446）", async () => {
    const { gateway, run } = stepWith([
      toolCalls([{ id: "c1", name: "static-check", arguments: { declaration: V1 } }]),
      done(V2),
    ]);
    const outcome = await run;
    expect(outcome.ok).toBe(true);
    // 道具の往復は再試行ではない（Issue #446）
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 0 });
  });

  it("2 回続けて合わなければ、段の失敗になり、問題に欄の名前と種類が入る", async () => {
    const { recording, gateway, run } = stepWith([doneMalformed, doneMalformed]);
    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    if (outcome.failure.kind !== "malformed") return;
    expect(outcome.failure.attempts).toBe(2);
    expect(outcome.failure.problems.map((problem) => problem.field)).toContain("declaration");
    expect(recording.tools).toHaveLength(2);
    // やり直しは 1 回だけ（Issue #446）
    expect(gateway.retryCounts.shape).toBe(1);
  });
});

// ── 停滞の検知の署名（02 §1.3.1・R2-10・Issue #309）──────────────────────

/** 署名を測るための、最小の版の結果 */
function report(over: Partial<VersionReport> = {}): VersionReport {
  return {
    declaration: { source: "entities: []\n" },
    declarationSha256: "sha",
    staticCheck: { passed: true, diagnostics: [], app: null },
    correspondence: { entries: [], misses: [] },
    testRun: { mismatches: [], unresolved: [] },
    routes: [],
    defectMisses: [],
    redoMisses: [],
    ...over,
  };
}

// ── 流し直しも、要件ごとの所属を点検する（Issue #431）──────────────────────

describe("流し直しも、要件ごとの所属を点検する（Issue #431）", () => {
  /** 一覧が `title` を出す宣言（entity record は一覧で辿れる） */
  const PERM_DECLARATION = [
    "entities:",
    "  - name: record",
    "    fields:",
    "      title: string",
    "views:",
    "  - name: records",
    "    type: list",
    "    entity: record",
    "    show: [title]",
    "actions: []",
    "validations: []",
    "computed: []",
    "permissions: []",
    "minIdentity:",
    "  mode: anonymous",
    "",
  ].join("\n");
  const roles: readonly RoleEntry[] = [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null },
    { roleId: "record.title", kind: "field", entity: "record", name: "title", shared: false, aliasOf: null },
  ];
  const mappings: readonly RoleNameMapping[] = [
    { roleId: "record", name: "record" },
    { roleId: "record.title", name: "title" },
  ];
  const ownership: readonly RequirementRoleOwnership[] = [
    {
      requirementId: "R-1",
      ownership: [
        { roleId: "record", basis: "dependency", reason: "行の所属として参照するため" },
        { roleId: "record.title", basis: "dependency", reason: "一覧に出す項目として参照するため" },
      ],
    },
  ];
  // R-1 の対応表は entity record だけを挙げ、項目 title を挙げていない
  const correspondences: readonly CorrespondenceEntry[] = [
    { requirementId: "R-1", locations: [{ kind: "entity", entity: null, name: "record" }] },
  ];

  it("所属を渡すと、要件ごとの点検の落ち（要件 ID つき）を redoMisses に返す", async () => {
    const report = await checkDeclarationVersion(
      { source: PERM_DECLARATION },
      { list: LIST, suite: SUITE, correspondences, roles, mappings, ownership },
    );
    expect(report.redoMisses.map((miss) => miss.requirementId)).toContain("R-1");
    expect(report.correspondence?.misses.some((miss) => miss.requirementId === "R-1")).toBe(true);
  });

  it("新契約で所属を渡さなければ、入力の不備として断り、照合なしの成功にしない", async () => {
    const report = await checkDeclarationVersion(
      { source: PERM_DECLARATION },
      { list: LIST, suite: SUITE, correspondences, roles, mappings },
    );
    expect(report.correspondence?.misses.some((miss) => miss.detail.includes("入力の不備"))).toBe(true);
    // 要件ごとの照合は走らず、⑤a のやり直しの落ちも足さない
    expect(report.redoMisses).toEqual([]);
  });

  it("新契約で所属が空でも、入力の不備として断る", async () => {
    const report = await checkDeclarationVersion(
      { source: PERM_DECLARATION },
      { list: LIST, suite: SUITE, correspondences, roles, mappings, ownership: [] },
    );
    expect(report.correspondence?.misses.some((miss) => miss.detail.includes("入力の不備"))).toBe(true);
    expect(report.redoMisses).toEqual([]);
  });

  it("legacy を明示したときは、従来どおり表全体の外の落ちにする（要件 ID は足さない）", async () => {
    const report = await checkDeclarationVersion(
      { source: PERM_DECLARATION },
      { list: LIST, suite: SUITE, correspondences, roles, mappings, version: LEGACY_DESIGN_CONTRACT },
    );
    // record.title は宣言に実在するが、表全体（R-1 は entity record だけ）の挙げていない場所なので落ちになる
    expect(report.correspondence?.misses.some((miss) => miss.detail.includes("対応表の外"))).toBe(true);
    expect(report.redoMisses).toEqual([]);
  });

  it("所属が一部だけ欠ける入力は、入力の不備として断る（表の役割の全部に所属を要る）", async () => {
    // 表の役割 record.title の所属を省く（全体の集合は空ではないので、以前の門を通ってしまっていた）
    const partialOwnership: readonly RequirementRoleOwnership[] = [
      {
        requirementId: "R-1",
        ownership: [{ roleId: "record", basis: "dependency", reason: "行の所属として参照するため" }],
      },
    ];
    const report = await checkDeclarationVersion(
      { source: PERM_DECLARATION },
      { list: LIST, suite: SUITE, correspondences, roles, mappings, ownership: partialOwnership },
    );
    expect(report.correspondence?.misses.some((miss) => miss.detail.includes("入力の不備"))).toBe(true);
    expect(report.redoMisses).toEqual([]);
  });
});

describe("停滞の署名は、名前ではなく分類で決まる（02 §1.3.1・Issue #309）", () => {
  it("名前だけを付け替えた次の版でも、同じ不一致は同じ署名になる（member → memberRegistration）", () => {
    const before = report({
      routes: [{ testId: "t1", route: "missing-element", detail: "宣言に計算 member が無い" }],
    });
    const after = report({
      routes: [{ testId: "t1", route: "missing-element", detail: "宣言に計算 memberRegistration が無い" }],
    });
    expect(failureSignature(before)).toBe(failureSignature(after));
  });

  it("試験 ID か誤りの分類が変われば、署名も変わる", () => {
    const base = report({ routes: [{ testId: "t1", route: "missing-element", detail: "x" }] });
    expect(failureSignature(base)).not.toBe(
      failureSignature(report({ routes: [{ testId: "t2", route: "missing-element", detail: "x" }] })),
    );
    expect(failureSignature(base)).not.toBe(
      failureSignature(report({ routes: [{ testId: "t1", route: "correspondence-defect", detail: "x" }] })),
    );
  });

  it("同じ署名が上限の回数だけ続いたら停滞と見なし、変われば見なさない", () => {
    expect(isStagnant(["a", "a"], 2)).toBe(true);
    expect(isStagnant(["a", "b"], 2)).toBe(false);
    expect(isStagnant(["a"], 2)).toBe(false);
    expect(isStagnant(["a", "a", "a"], 3)).toBe(true);
    // 2 未満の指定では止めない（停滞の検知を切る）
    expect(isStagnant(["a", "a"], 1)).toBe(false);
  });
});

// ── ⑥ の道具の累計・1 回の段の応答の往復の上限（02 §1.5・Issue #429）──────────────
//
// ⑥ の道具の実行は、**ジョブ全体の累計**（共通の口の `toolCalls` の getter）を実行の前に照らして断る。
// 1 回の直す段の中で受け取ってよい応答の数にも上限（`repairStepTurns`）を置く。**実 API は呼ばない。**

afterEach(() => {
  vi.restoreAllMocks();
});

/** ⑥ の道具の呼び出し 1 つ（静的チェック。宣言は妥当なものを使う） */
const staticCheckCall = (id: string, source: string) => ({
  id,
  name: "static-check",
  arguments: { declaration: source },
});

/** 1 応答に載せる道具の束（`count` 件） */
const toolBundle = (count: number, source: string, offset = 0) =>
  Array.from({ length: count }, (_, i) => staticCheckCall(`c${offset + i}`, source));

/**
 * 記録した応答を順に返す偽物。**直す段（`runRepairStep`）ごとに会話が切れる**ことを許す——記録した
 * 応答の順だけを見て、往復の順（`turns`）は確かめない。2 つの段にまたがる累計を試すのに使う。
 */
function flatClient(recorded: readonly RecordedCall[]): LlmClient {
  let index = 0;
  const next = (): RecordedCall => {
    const call = recorded[index];
    index += 1;
    if (call === undefined) throw new Error("記録した応答が尽きました");
    return call;
  };
  return {
    async callStructured<T>() {
      const call = next();
      if (call.kind !== "structured") throw new Error("記録と種別が違います（構造化出力）");
      return { output: call.output as T, usage: call.usage };
    },
    async callWithTools() {
      const call = next();
      if (call.kind !== "tools") throw new Error("記録と種別が違います（道具付き）");
      return call.response;
    },
  };
}

/**
 * 道具の累計を**事前に `preloaded` から始める**共通の口。`toolCalls` の getter を上書きして、ジョブの
 * これまでの累計（例：23）を模す——本物の `CallGateway` は累計を外から与えられないため。
 */
class PreloadedGateway extends CallGateway {
  readonly #preloaded: number;
  constructor(options: CallGatewayOptions, preloaded: number) {
    super(options);
    this.#preloaded = preloaded;
  }
  override get toolCalls(): number {
    return this.#preloaded + super.toolCalls;
  }
}

/** 累計を事前に持つ共通の口を作る（予算は十分・時計は 0 に固定し、締切は絶対時刻） */
function preloadedGateway(
  client: LlmClient,
  preloaded: number,
  options: { readonly maxAttempts?: number; readonly callTimeoutMs?: number } = {},
): PreloadedGateway {
  return new PreloadedGateway(
    {
      client,
      budget: new JobBudget(10),
      rates: { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 },
      now: () => 0,
      deadline: 60_000,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    },
    preloaded,
  );
}

/**
 * timeout で打ち切った 1 回目の応答が**遅れて返り**、再試行が成功する偽物（打ち切り時の累計の門の
 * 回帰。Issue #429）。1 回目は `lateMs` 後に道具の束 1 件を（打ち切り後でも）返し、2 回目は `retryMs`
 * 後に道具の束 2 件を返す。**実 API は呼ばない**（偽物の時計で順序を作る）。
 */
function lateResponseClient(options: { readonly lateMs: number; readonly retryMs: number }): LlmClient {
  let attempt = 0;
  return {
    callStructured<T>(): Promise<LlmStructuredResponse<T>> {
      return Promise.reject(new Error("使わない"));
    },
    callWithTools(): Promise<LlmToolResponse> {
      attempt += 1;
      const first = attempt === 1;
      const delayMs = first ? options.lateMs : options.retryMs;
      const calls = first ? toolBundle(1, V1) : toolBundle(2, V1, 1);
      return new Promise((resolve) => {
        setTimeout(() => resolve({ kind: "toolCalls", toolCalls: calls, usage: undefined }), delayMs);
      });
    },
  };
}

describe("⑥ の道具の累計と 1 回の段の応答の往復の上限（02 §1.5・Issue #429）", () => {
  /** 最初の版（V1）を渡して、⑥ を 1 回回す */
  const runStep = async (gateway: CallGateway): Promise<Awaited<ReturnType<typeof runRepairStep>>> => {
    const initial = await version(V1);
    return runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway,
    });
  };

  it("累計が応答前 23 に、1 つの束（累計 24）は実行し、段は続く", async () => {
    const spy = vi.spyOn(repairTools, "executeRepairTool");
    const recording = createRecordingClient([toolCalls([staticCheckCall("c1", V1)]), done(V2)]);
    const gateway = preloadedGateway(recording.client, AGENT_LIMITS.toolCalls - 1, { maxAttempts: 1 });

    const outcome = await runStep(gateway);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.declaration.source).toBe(V2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(gateway.toolCalls).toBe(AGENT_LIMITS.toolCalls);
  });

  it("累計が応答前 23 に、2 つの束（累計 25）は 1 つも実行せず、累計の上限で段が終わる", async () => {
    const spy = vi.spyOn(repairTools, "executeRepairTool");
    const recording = createRecordingClient([
      toolCalls([staticCheckCall("c1", V1), staticCheckCall("c2", V1)]),
    ]);
    const gateway = preloadedGateway(recording.client, AGENT_LIMITS.toolCalls - 1, { maxAttempts: 1 });

    const outcome = await runStep(gateway);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({
      kind: "callLimit",
      limit: "toolCalls",
      max: AGENT_LIMITS.toolCalls,
      actual: AGENT_LIMITS.toolCalls + 1,
    });
    expect(spy).toHaveBeenCalledTimes(0);
    // 拒否した束も、共通の口の累計には数えられる（getter が 25 を示すこと自体は不具合ではない）
    expect(gateway.toolCalls).toBe(AGENT_LIMITS.toolCalls + 1);
  });

  it("成功して受け取った応答が上限ちょうどまでは続き、8 回目が形の合う done なら受け付ける", async () => {
    const recording = createRecordingClient([
      ...Array.from({ length: AGENT_LIMITS.repairStepTurns - 1 }, (_, i) =>
        toolCalls([staticCheckCall(`c${i}`, V1)]),
      ),
      done(V2),
    ]);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });

    const outcome = await runStep(gateway);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.declaration.source).toBe(V2);
    expect(recording.tools).toHaveLength(AGENT_LIMITS.repairStepTurns);
  });

  it("応答が上限（8）に達したら次の応答は求めず、往復の上限で段が終わる", async () => {
    const recording = createRecordingClient(
      Array.from({ length: AGENT_LIMITS.repairStepTurns }, (_, i) => toolCalls([staticCheckCall(`c${i}`, V1)])),
    );
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });

    const outcome = await runStep(gateway);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("callLimit");
    if (outcome.failure.kind !== "callLimit") return;
    expect(outcome.failure.limit).toBe("repairStepTurns");
    expect(outcome.failure.max).toBe(AGENT_LIMITS.repairStepTurns);
    // 9 回目は求めない（求めれば記録が尽きて、別の失敗になる）
    expect(recording.tools).toHaveLength(AGENT_LIMITS.repairStepTurns);
  });

  it("最後の答えの形の直しの応答も往復に数える（8 回目が形の合わない done なら、直しを求めずに上限で終わる）", async () => {
    const recording = createRecordingClient([
      ...Array.from({ length: AGENT_LIMITS.repairStepTurns - 1 }, (_, i) =>
        toolCalls([staticCheckCall(`c${i}`, V1)]),
      ),
      doneMalformed,
    ]);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });

    const outcome = await runStep(gateway);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("callLimit");
    if (outcome.failure.kind !== "callLimit") return;
    expect(outcome.failure.limit).toBe("repairStepTurns");
    expect(recording.tools).toHaveLength(AGENT_LIMITS.repairStepTurns);
    // 形の合わない done でやり直しを告げたが、往復の上限（repairStepTurns）が次の呼び出しを共通の口より
    // 前で断るので、追加の実開始は無い。段の上限は口の門ではないので未着手は増えず、やり直しの数だけが 1（Issue #478）。
    expect(gateway.retryCounts.shape).toBe(1);
    expect(gateway.attempts.started).toBe(AGENT_LIMITS.repairStepTurns);
    expect(gateway.attempts.not_started).toEqual({ deadline: 0, budget: 0, limit: 0, timeout: 0 });
  });

  it("形の直しの往復も数え、8 回目が形の合う done なら受け付ける（STEP_ATTEMPTS は 1 回のまま）", async () => {
    const recording = createRecordingClient([
      ...Array.from({ length: AGENT_LIMITS.repairStepTurns - 2 }, (_, i) =>
        toolCalls([staticCheckCall(`c${i}`, V1)]),
      ),
      doneMalformed,
      done(V2),
    ]);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });

    const outcome = await runStep(gateway);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.declaration.source).toBe(V2);
    expect(recording.tools).toHaveLength(AGENT_LIMITS.repairStepTurns);
  });

  it("段の開始で累計が戻らない（2 つの段を続けて回すと、2 つ目の段が累計の続きから照らす）", async () => {
    const client = flatClient([toolCalls(toolBundle(20, V1)), done(V2), toolCalls(toolBundle(5, V1, 20))]);
    const gateway = makeGateway(client, { maxAttempts: 1 });

    const first = await runStep(gateway);
    expect(first.ok).toBe(true);
    expect(gateway.toolCalls).toBe(20);

    const second = await runStep(gateway);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure).toEqual({
      kind: "callLimit",
      limit: "toolCalls",
      max: AGENT_LIMITS.toolCalls,
      actual: AGENT_LIMITS.toolCalls + 1,
    });
  });

  it("打ち切り後に遅れて返った束を取りこぼさない（応答の後に読んだ累計そのもので断る）", async () => {
    const spy = vi.spyOn(repairTools, "executeRepairTool");
    // 版は、偽物の時計を使う前に作る（順序を単純にする）
    const initial = await version(V1);
    // 応答前 22。1 回目の応答（束 1）は timeout で打ち切られた**あと**に遅れて返り（累計 23）、
    // 再試行（束 2）が成功する（累計 25）。**呼び出しの前に読んだ累計へ束を足すと 22＋2＝24 で通って
    // しまい**、2 件を実行する——応答の後に読んだ累計そのものを照らすことで断る。
    const client = lateResponseClient({ lateMs: 150, retryMs: 180 });
    const gateway = preloadedGateway(client, AGENT_LIMITS.toolCalls - 2, { maxAttempts: 2, callTimeoutMs: 100 });

    vi.useFakeTimers();
    try {
      const pending = runRepairStep({
        source: SOURCE,
        list: LIST,
        suite: SUITE,
        current: initial,
        correspondences: CORRESPONDENCES,
        documents: SAMPLE_DOCUMENTS,
        gateway,
      });
      // 打ち切り（100ms）→ 遅れて返る束（150ms）→ 再試行の成功（180ms）まで進める
      await vi.advanceTimersByTimeAsync(400);
      const outcome = await pending;

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure).toEqual({
        kind: "callLimit",
        limit: "toolCalls",
        max: AGENT_LIMITS.toolCalls,
        actual: AGENT_LIMITS.toolCalls + 1,
      });
      expect(spy).toHaveBeenCalledTimes(0);
      // 打ち切り後に遅れて数えられた束（1）と、再試行の束（2）を含む累計は 25
      expect(gateway.toolCalls).toBe(AGENT_LIMITS.toolCalls + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 評価口と宣言の意味の点検の拒否（v1.1α A6'。07 §3・D11・Issue #506）──────────────

const V3 = declaration("amount * 2", "amount + 3");

/** 3 件の試験の組（t3 は R-2 の 2 件目）。並びを変えた組も作れるようにする */
const SUITE3 = suiteOf([
  ...SUITE.tests,
  {
    id: "t3",
    target: { requirementId: "R-2", kind: "computation", role: "補助の値の計算" },
    kind: "boundary",
    operation: "compute",
    clock: "2026-09-16T12:00:00+09:00",
    input: { amount: 0 },
    referenceData: [],
    expected: { kind: "ok", value: 1 },
  },
]);

const OWNERSHIP: readonly RequirementRoleOwnership[] = [
  { requirementId: "R-1", ownership: [{ roleId: "record.total", basis: "stated", reason: null }] },
  { requirementId: "R-2", ownership: [{ roleId: "record.extra", basis: "stated", reason: null }] },
];

/** 宣言ごとに落ちる試験 ID（偽物の評価口の決まり。版 V1 は t1・t2、V2 は t2、V3 は無し） */
const FAILING_BY_SOURCE = new Map<string, readonly string[]>([
  [V1, ["t1", "t2"]],
  [V2, ["t2"]],
  [V3, []],
]);

interface EvaluatorCall {
  readonly source: string;
  readonly context: EvaluationContext;
  readonly failing: readonly string[];
}

/**
 * 偽物の評価口：文脈の組の**試験 ID** で落ちを決め、不一致と行き先を返す（並びに依らない）。
 * 受けた宣言と文脈を残す。
 */
function fakeEvaluator(): { readonly evaluate: DeclarationEvaluator; readonly calls: EvaluatorCall[] } {
  const calls: EvaluatorCall[] = [];
  const evaluate: DeclarationEvaluator = (_app, declaration, context) => {
    const failingIds = FAILING_BY_SOURCE.get(declaration.source) ?? [];
    const failing = context.suite.tests.map((test) => test.id).filter((id) => failingIds.includes(id));
    calls.push({ source: declaration.source, context, failing });
    const testRun: TestRunReport = {
      mismatches: failing.map((testId) => ({ testId, detail: "偽物の不一致" })),
      unresolved: [],
      routes: failing.map((testId) => ({ testId, route: "missing-element" as const, detail: "偽物の不一致" })),
      structural: [],
    };
    return { correspondence: { entries: context.correspondences, misses: [] }, testRun };
  };
  return { evaluate, calls };
}

/** 要求から締切の合図を外して JSON にする（バイト列で比べる） */
const bytesOf = (request: LlmToolRequest | undefined): string => {
  if (request === undefined) throw new Error("要求が無い");
  const { signal: _signal, ...rest } = request;
  return JSON.stringify(rest);
};

describe("宣言の意味の点検の拒否をデータとして足す（v1.1α・Issue #506）", () => {
  const stepRequest = async (extra: Partial<RepairStepInput>): Promise<LlmToolRequest | undefined> => {
    const initial = await version(V1);
    const recording = createRecordingClient([done(V2)]);
    const outcome = await runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      ...extra,
    });
    expect(outcome.ok).toBe(true);
    return recording.tools[0];
  };
  const rejections = [{ requirementId: "R-1", kind: "expression", quote: "件数を合計する" }];

  it("拒否を省いた要求と空の並びを渡した要求は、既存の要求とバイト列で同じ", async () => {
    const plain = bytesOf(await stepRequest({}));
    expect(bytesOf(await stepRequest({ declRejections: [] }))).toBe(plain);
    // 対照：評価口だけを渡しても要求は変わらない（道具の文脈にだけ効く）
    expect(bytesOf(await stepRequest({ evaluate: fakeEvaluator().evaluate }))).toBe(plain);
  });

  it("渡すと入力の末尾に塊が 1 つだけ増え、前置き・規則・文書・道具・schema は同じ", async () => {
    const plain = await stepRequest({});
    const withRejections = await stepRequest({ declRejections: rejections });
    if (plain === undefined || withRejections === undefined) throw new Error("要求が無い");
    const block = `<data name="${DECLARATION_REJECTIONS_DATA_NAME}">\n${JSON.stringify(rejections, null, 2)}\n</data>`;
    expect(withRejections.input).toBe(`${plain.input}\n${block}`);
    expect(withRejections.input.match(/<data name=/g)).toHaveLength((plain.input.match(/<data name=/g) ?? []).length + 1);
    expect(withRejections.instructions).toBe(plain.instructions);
    expect(withRejections.rules).toEqual(plain.rules);
    expect(withRejections.documents).toEqual(plain.documents);
    expect(withRejections.tools).toEqual(plain.tools);
    expect(withRejections.schemaName).toBe(plain.schemaName);
    expect(withRejections.schema).toEqual(plain.schema);
    expect(withRejections.maxOutputTokens).toBe(plain.maxOutputTokens);
    expect(withRejections.instructions).not.toContain("件数を合計する");
    expectNoAcceptanceMaterial([withRejections.input]);
  });
});

describe("版の再検査に評価口を渡す（v1.1α・Issue #506）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("版ごとに 1 回、その版の app・宣言・文脈で呼ばれ、routes が評価口の結果と一致し、③・⑤a のやり直しの落ちは空", async () => {
    const bindSpy = vi.spyOn(bindModule, "bindTests");
    const roleSpy = vi.spyOn(correspondenceModule, "checkRoleMappings");
    const correspondenceSpy = vi.spyOn(correspondenceModule, "checkCorrespondence");
    const { evaluate, calls } = fakeEvaluator();
    const context = {
      list: LIST,
      suite: SUITE3,
      correspondences: CORRESPONDENCES,
      ownership: OWNERSHIP,
      version: LEGACY_DESIGN_CONTRACT,
      roles: [] as readonly RoleEntry[],
      mappings: [] as readonly RoleNameMapping[],
      evaluate,
    };
    const first = await checkDeclarationVersion({ source: V1 }, context);
    const second = await checkDeclarationVersion({ source: V2 }, context);
    expect(calls.map((call) => call.source)).toEqual([V1, V2]);
    for (const call of calls) {
      expect(call.context).toEqual({
        list: LIST,
        suite: SUITE3,
        correspondences: CORRESPONDENCES,
        ownership: OWNERSHIP,
        version: LEGACY_DESIGN_CONTRACT,
      });
    }
    expect(first.routes.map((route) => route.testId)).toEqual(["t1", "t2"]);
    expect(first.routes).toEqual((first.testRun as TestRunReport | null)?.routes);
    expect(second.routes.map((route) => route.testId)).toEqual(["t2"]);
    for (const report of [first, second]) {
      expect(report.defectMisses).toEqual([]);
      expect(report.redoMisses).toEqual([]);
      expect(report.correspondence).toEqual({ entries: CORRESPONDENCES, misses: [] });
    }
    expect(first.declarationSha256).toBe(await sha256Hex(V1));
    expect(bindSpy).not.toHaveBeenCalled();
    expect(roleSpy).not.toHaveBeenCalled();
    expect(correspondenceSpy).not.toHaveBeenCalled();

    // 静的チェックを通らない版では評価口を呼ばない（流さない）
    const invalid = await checkDeclarationVersion({ source: V1.replace("amount: number", "amount: nosuchtype") }, context);
    expect(invalid.staticCheck.passed).toBe(false);
    expect(invalid.testRun).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("省けば今までどおり v1 の部品（bindTests・checkCorrespondence）で流す", async () => {
    const bindSpy = vi.spyOn(bindModule, "bindTests");
    const correspondenceSpy = vi.spyOn(correspondenceModule, "checkCorrespondence");
    const report = await version(V1);
    expect(bindSpy).toHaveBeenCalledTimes(1);
    expect(correspondenceSpy).toHaveBeenCalledTimes(1);
    expect(report.testRun?.mismatches.map((mismatch) => mismatch.testId)).toEqual(["t1"]);
  });
});

describe("修復の輪に評価口を渡す（v1.1α・Issue #506）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 棄却 1 件を挟む 2 往復の輪を、組 `suite` で流す（偽物の LLM・偽物の評価口） */
  const loopWith = async (suite: TestSuite) => {
    const { evaluate, calls } = fakeEvaluator();
    const context = { list: LIST, suite, correspondences: CORRESPONDENCES, ownership: OWNERSHIP, evaluate };
    const initial = await checkDeclarationVersion({ source: V1 }, context);
    const recording = createRecordingClient([
      // 1 往復目：V2 を返し、t1 の期待に異議を出す → ⑥' が棄却する
      done(V2, [{ testId: "t1", quote: "件数を合計する" }]),
      structured({
        decisions: [{ testId: "t1", verdict: "overturn", reason: "原文の数え方が違う", quote: "件数を合計する" }],
      }),
      // 2 往復目：棄却のあとの組で、道具で V3 を試してから V3 を返す
      toolCalls([{ id: "c2", name: "run-tests", arguments: { declaration: V3 } }]),
      done(V3),
    ]);
    const outcome = await runRepairLoop({
      source: SOURCE,
      ...context,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      initial,
      limits: limits(6),
    });
    return { outcome, calls, recording };
  };

  it("棄却のあとの版の再検査と次の修復の道具では、評価口の文脈の組に棄却した試験が無く、list・ownership はそのまま届く", async () => {
    const bindSpy = vi.spyOn(bindModule, "bindTests");
    const { outcome, calls, recording } = await loopWith(SUITE3);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.overturned.map((entry) => entry.testId)).toEqual(["t1"]);
    expect(outcome.value.rounds).toBe(2);
    expect(outcome.value.final.declaration.source).toBe(V3);
    expect(outcome.value.final.testRun?.mismatches).toEqual([]);

    // 呼ばれた順：初期の版・再検査（V2。棄却のあと）・道具（V3）・再検査（V3）
    expect(calls.map((call) => call.source)).toEqual([V1, V2, V3, V3]);
    const ids = (call: EvaluatorCall) => call.context.suite.tests.map((test) => test.id);
    expect(ids(calls[0] as EvaluatorCall)).toEqual(["t1", "t2", "t3"]);
    for (const call of calls.slice(1)) {
      expect(ids(call)).not.toContain("t1");
      expect(ids(call)).toEqual(["t2", "t3"]);
    }
    for (const call of calls) {
      expect(call.context.list).toBe(LIST);
      expect(call.context.ownership).toBe(OWNERSHIP);
      expect(call.context.correspondences).toBe(CORRESPONDENCES);
    }
    // 版の数だけ再検査で呼ばれ（初期の版を除く）、道具の呼び出しの分を足した数になる
    const toolCallCount = recording.tools.filter((request) => request.turns.length > 0).length;
    expect(calls.length - 1).toBe(outcome.value.versions.length - 1 + toolCallCount);
    // 道具の結果は評価口の結果（2 往復目の道具は棄却のあとの組で t2 だけが落ちない V3）
    const toolTurn = recording.tools[recording.tools.length - 1]?.turns.at(-1);
    expect(toolTurn?.role === "tool" ? toolTurn.results[0]?.output : undefined).toEqual({
      passed: true,
      detail: "",
      mismatches: [],
      unresolved: [],
      misses: [],
    });
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it("残りの試験の並びを変えても、評価口の結果と輪の結果は試験 ID で同じ", async () => {
    const reordered: TestSuite = { tests: [...SUITE3.tests].reverse() };
    const a = await loopWith(SUITE3);
    const b = await loopWith(reordered);
    expect(a.outcome.ok && b.outcome.ok).toBe(true);
    if (!a.outcome.ok || !b.outcome.ok) return;
    const byId = (calls: readonly EvaluatorCall[]) =>
      calls.map((call) => ({ source: call.source, failing: [...call.failing].sort(), suite: call.context.suite.tests.map((test) => test.id).sort() }));
    expect(byId(b.calls)).toEqual(byId(a.calls));
    const sortedIds = (entries: readonly { readonly testId: string }[] | undefined) =>
      (entries ?? []).map((entry) => entry.testId).sort();
    expect(sortedIds(b.outcome.value.final.testRun?.mismatches)).toEqual(sortedIds(a.outcome.value.final.testRun?.mismatches));
    expect(b.outcome.value.overturned).toEqual(a.outcome.value.overturned);
    expect(sortedIds(b.outcome.value.regressions)).toEqual(sortedIds(a.outcome.value.regressions));
    expect(b.outcome.value.versions.map((entry) => entry.declarationSha256)).toEqual(
      a.outcome.value.versions.map((entry) => entry.declarationSha256),
    );
    expect(b.outcome.value.suite.tests.map((test) => test.id).sort()).toEqual(["t2", "t3"]);
  });

  it("評価口を渡しても、道具の引数の検査は省かない（形の合わない引数は呼ばずに断り、評価口も呼ばない）", async () => {
    const { evaluate, calls } = fakeEvaluator();
    const initial = await version(V1);
    const recording = createRecordingClient([
      toolCalls([{ id: "c1", name: "run-tests", arguments: { declaration: "" } }]),
    ]);
    const outcome = await runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      evaluate,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
    expect(calls).toHaveLength(0);
  });
});

// ── 直す段の数の口と上限の塊（旗 `v12.ids`。手 4c・Issue #665）──────────────────────────
//
// 直す段は段の終わりに段内の数を任意の口で返し（渡さなければ要求・回数・結果に効かない）、`stepLimitsData` を渡せば
// 入力の末尾にデータの塊「直す段の上限」を足す（値は段の始めに 1 回決める）。上限の値と照らし方は変えない。**実 API は呼ばない。**

/** データの塊の中身（JSON）と、入力の中の位置 */
const blockOf = (input: string): { readonly value: unknown; readonly at: number } => {
  const match = new RegExp(`<data name="${REPAIR_STEP_LIMITS_DATA_NAME}">\\n([\\s\\S]*?)\\n</data>`).exec(input);
  if (match === null) throw new Error("上限の塊が無い");
  return { value: JSON.parse(match[1] ?? "null"), at: match.index };
};
const limitsBlock = (usedAtStart: number) => ({
  repairStepTurns: { max: AGENT_LIMITS.repairStepTurns, received: 0 },
  toolCalls: { max: AGENT_LIMITS.toolCalls, usedAtStart },
});
/** 停止の外形（応答の数と終わり方だけ） */
const outwardShape = (counts: readonly RepairStepCounts[]) => counts.map((entry) => ({ responses: entry.responses, end: entry.end }));

describe("直す段の数の口と上限の塊（旗 v12.ids・Issue #665）", () => {
  /** 要求を残しつつ、記録した応答を順に返す偽物（段をまたいで会話が切れてよい） */
  const recordingFlat = (recorded: readonly RecordedCall[]): { readonly client: LlmClient; readonly tools: LlmToolRequest[] } => {
    const inner = flatClient(recorded);
    const tools: LlmToolRequest[] = [];
    return {
      client: {
        callStructured: (request) => inner.callStructured(request),
        callWithTools: (request) => {
          tools.push(request);
          return inner.callWithTools(request);
        },
      },
      tools,
    };
  };
  /** 版 V1 を渡して ⑥ を 1 回回し、口の値を集める */
  const runCounted = async (
    gateway: CallGateway,
    extra: Partial<RepairStepInput> = {},
  ): Promise<{ readonly outcome: Awaited<ReturnType<typeof runRepairStep>>; readonly counts: RepairStepCounts[] }> => {
    const initial = await version(V1);
    const counts: RepairStepCounts[] = [];
    const outcome = await runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway,
      stepLimitsData: true,
      onCounts: (value) => counts.push(value),
      ...extra,
    });
    return { outcome, counts };
  };
  it("上限の表の値は直す前と同じ（段内の応答 8・道具の累計 24・往復 6・停滞 2・点検 6・testsPerRequirement 16・referenceRowsPerTest 64）", () => {
    expect(AGENT_LIMITS.repairStepTurns).toBe(8);
    expect(AGENT_LIMITS.toolCalls).toBe(24);
    expect(AGENT_LIMITS.repairRoundTrips).toBe(6);
    expect(AGENT_LIMITS.stagnationRepeats).toBe(2);
    expect(AGENT_LIMITS.declChecks).toBe(6);
    expect(AGENT_LIMITS.testsPerRequirement).toBe(16);
    expect(AGENT_LIMITS.referenceRowsPerTest).toBe(64);
  });

  it("(1) 8 応答が全て道具の束（各 1 個）→ 9 番目を求める前に段内の上限。口は repairStepTurns・max 8・actual 9・応答 8・道具 8", async () => {
    const spy = vi.spyOn(repairTools, "executeRepairTool");
    const recording = createRecordingClient(
      Array.from({ length: AGENT_LIMITS.repairStepTurns }, (_, i) => toolCalls([staticCheckCall(`c${i}`, V1)])),
    );
    const { outcome, counts } = await runCounted(makeGateway(recording.client, { maxAttempts: 1 }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ kind: "callLimit", limit: "repairStepTurns", max: 8, actual: 9 });
    expect(recording.tools).toHaveLength(8);
    expect(spy).toHaveBeenCalledTimes(8);
    expect(counts).toEqual([
      {
        responses: 8,
        toolBundles: 8,
        toolsExecuted: 8,
        toolCallsAtStart: 0,
        toolCallsAtEnd: 8,
        shapeRetries: 0,
        limit: { name: "repairStepTurns", max: 8, actual: 9 },
        end: "callLimit",
      },
    ]);
    // 上限の塊は全往復で同じ値・同じ位置（基底の入力は変わらず、会話〔turns〕だけが増える）
    const first = recording.tools[0];
    if (first === undefined) throw new Error("要求が無い");
    expect(blockOf(first.input).value).toEqual(limitsBlock(0));
    for (const [index, request] of recording.tools.entries()) {
      expect(request.input).toBe(first.input);
      expect(request.turns).toHaveLength(index * 2);
    }
  });

  it("(2) 7 応答で累計 17、8 番目の束が 8 個 → 実行する前に toolCalls・max 24・actual 25。道具は 1 つも実行されず（17 のまま）・応答 8", async () => {
    const spy = vi.spyOn(repairTools, "executeRepairTool");
    // 7 束で 17 個（3 個 × 3 ＋ 2 個 × 4）
    const sizes = [3, 3, 3, 2, 2, 2, 2];
    let offset = 0;
    const bundles = sizes.map((size) => {
      const bundle = toolCalls(toolBundle(size, V1, offset));
      offset += size;
      return bundle;
    });
    const recording = createRecordingClient([...bundles, toolCalls(toolBundle(8, V1, offset))]);
    const { outcome, counts } = await runCounted(makeGateway(recording.client, { maxAttempts: 1 }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toEqual({ kind: "callLimit", limit: "toolCalls", max: 24, actual: 25 });
    expect(spy).toHaveBeenCalledTimes(17);
    expect(counts).toEqual([
      {
        responses: 8,
        toolBundles: 8,
        toolsExecuted: 17,
        toolCallsAtStart: 0,
        toolCallsAtEnd: 25,
        shapeRetries: 0,
        limit: { name: "toolCalls", max: 24, actual: 25 },
        end: "callLimit",
      },
    ]);
  });

  it("(1) と (2) は同じ外形（応答 8・種類 callLimit）で、上限の名前だけが違う（二点測定）", async () => {
    const turns = createRecordingClient(
      Array.from({ length: AGENT_LIMITS.repairStepTurns }, (_, i) => toolCalls([staticCheckCall(`c${i}`, V1)])),
    );
    const sizes = [3, 3, 3, 2, 2, 2, 2, 8];
    let offset = 0;
    const cumulative = createRecordingClient(
      sizes.map((size) => {
        const bundle = toolCalls(toolBundle(size, V1, offset));
        offset += size;
        return bundle;
      }),
    );
    const a = await runCounted(makeGateway(turns.client, { maxAttempts: 1 }));
    const b = await runCounted(makeGateway(cumulative.client, { maxAttempts: 1 }));
    expect(outwardShape(a.counts)).toEqual(outwardShape(b.counts));
    expect(a.counts[0]?.limit?.name).toBe("repairStepTurns");
    expect(b.counts[0]?.limit?.name).toBe("toolCalls");
  });

  it("(3) 通信の再送：1 回目 timeout・2 回目成功 → 応答 1（共通の口の試行の started 2・responded 1 とは別に数える）", async () => {
    const initial = await version(V1);
    let attempt = 0;
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        return Promise.reject(new Error("使わない"));
      },
      callWithTools(): Promise<LlmToolResponse> {
        attempt += 1;
        // 1 回目は打ち切り（100ms）より後に返り、2 回目は打ち切りより前に done を返す
        const delayMs = attempt === 1 ? 500 : 10;
        return new Promise((resolve) => {
          setTimeout(
            () => resolve({ kind: "done", declaration: { declaration: V2, disputes: [] }, usage: undefined }),
            delayMs,
          );
        });
      },
    };
    const gateway = preloadedGateway(client, 0, { maxAttempts: 2, callTimeoutMs: 100 });
    const counts: RepairStepCounts[] = [];
    vi.useFakeTimers();
    try {
      const pending = runRepairStep({
        source: SOURCE,
        list: LIST,
        suite: SUITE,
        current: initial,
        correspondences: CORRESPONDENCES,
        documents: SAMPLE_DOCUMENTS,
        gateway,
        stepLimitsData: true,
        onCounts: (value) => counts.push(value),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const outcome = await pending;
      expect(outcome.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(gateway.attempts.started).toBe(2);
    expect(gateway.attempts.responded).toBe(1);
    expect(gateway.retryCounts.communication).toBe(1);
    expect(counts).toEqual([
      {
        responses: 1,
        toolBundles: 0,
        toolsExecuted: 0,
        toolCallsAtStart: 0,
        toolCallsAtEnd: 0,
        shapeRetries: 0,
        limit: null,
        end: "done",
      },
    ]);
  });

  it("(4) 形のやり直し：done が形に落ちて 1 回直す → 応答 2・形のやり直し 1・終わり done。2 回目の入力は基底の入力＋問題のデータで、上限の塊の値と位置は 1 回目と同じ", async () => {
    const recording = createRecordingClient([doneMalformed, done(V2)]);
    const { outcome, counts } = await runCounted(makeGateway(recording.client, { maxAttempts: 1 }));

    expect(outcome.ok).toBe(true);
    expect(counts).toEqual([
      {
        responses: 2,
        toolBundles: 0,
        toolsExecuted: 0,
        toolCallsAtStart: 0,
        toolCallsAtEnd: 0,
        shapeRetries: 1,
        limit: null,
        end: "done",
      },
    ]);
    const [first, second] = recording.tools;
    if (first === undefined || second === undefined) throw new Error("要求が無い");
    // 基底の入力（上限の塊を含む）＋問題のデータ（今までどおり追記される）
    expect(second.input.startsWith(`${first.input}\n<data name="最後の答えの形の誤り">`)).toBe(true);
    expect(first.input.endsWith("</data>")).toBe(true);
    expect(blockOf(second.input)).toEqual(blockOf(first.input));
    expect(blockOf(first.input).value).toEqual(limitsBlock(0));
    // 上限の塊は基底の入力の末尾（問題のデータより前）
    expect(first.input.endsWith(`<data name="${REPAIR_STEP_LIMITS_DATA_NAME}">\n${JSON.stringify(limitsBlock(0), null, 2)}\n</data>`)).toBe(true);
  });

  it("2 回続けて形に落ちれば、終わり malformed・形のやり直し 1・応答 2", async () => {
    const recording = createRecordingClient([doneMalformed, doneMalformed]);
    const { outcome, counts } = await runCounted(makeGateway(recording.client, { maxAttempts: 1 }));
    expect(outcome.ok).toBe(false);
    expect(counts.map((entry) => ({ responses: entry.responses, shapeRetries: entry.shapeRetries, limit: entry.limit, end: entry.end }))).toEqual([
      { responses: 2, shapeRetries: 1, limit: null, end: "malformed" },
    ]);
  });

  it("(5) 2 つの段で累計を引き継ぐ：1 段目で道具 10 → 2 段目の始めの累計 10 が塊と口に出て、累計 25 になる束の実行前に toolCalls", async () => {
    const spy = vi.spyOn(repairTools, "executeRepairTool");
    const recording = recordingFlat([toolCalls(toolBundle(10, V1)), done(V2), toolCalls(toolBundle(15, V1, 10))]);
    const gateway = makeGateway(recording.client, { maxAttempts: 1 });

    const first = await runCounted(gateway);
    expect(first.outcome.ok).toBe(true);
    const second = await runCounted(gateway);
    expect(second.outcome.ok).toBe(false);
    if (second.outcome.ok) return;
    expect(second.outcome.failure).toEqual({ kind: "callLimit", limit: "toolCalls", max: 24, actual: 25 });
    expect(spy).toHaveBeenCalledTimes(10);
    expect(first.counts).toEqual([
      {
        responses: 2,
        toolBundles: 1,
        toolsExecuted: 10,
        toolCallsAtStart: 0,
        toolCallsAtEnd: 10,
        shapeRetries: 0,
        limit: null,
        end: "done",
      },
    ]);
    expect(second.counts).toEqual([
      {
        responses: 1,
        toolBundles: 1,
        toolsExecuted: 0,
        toolCallsAtStart: 10,
        toolCallsAtEnd: 25,
        shapeRetries: 0,
        limit: { name: "toolCalls", max: 24, actual: 25 },
        end: "callLimit",
      },
    ]);
    const [step1First, step1Second, step2] = recording.tools;
    if (step1First === undefined || step1Second === undefined || step2 === undefined) throw new Error("要求が無い");
    expect(blockOf(step1First.input).value).toEqual(limitsBlock(0));
    // 1 段目の途中で累計が 10 になっても、1 段目の塊は更新しない
    expect(blockOf(step1Second.input).value).toEqual(limitsBlock(0));
    expect(blockOf(step2.input).value).toEqual(limitsBlock(10));
  });

  it("省けば（off）要求はバイト列で同じ。口だけを渡しても要求・結果は同じ。塊を渡すと入力の末尾に 1 つだけ増え、規則・道具・schema は同じ", async () => {
    const stepRequests = async (extra: Partial<RepairStepInput>) => {
      const initial = await version(V1);
      const recording = createRecordingClient([toolCalls([staticCheckCall("c1", V1)]), done(V2)]);
      const outcome = await runRepairStep({
        source: SOURCE,
        list: LIST,
        suite: SUITE,
        current: initial,
        correspondences: CORRESPONDENCES,
        documents: SAMPLE_DOCUMENTS,
        gateway: makeGateway(recording.client, { maxAttempts: 1 }),
        ...extra,
      });
      return { outcome, requests: recording.tools };
    };
    const plain = await stepRequests({});
    const portOnly = await stepRequests({ onCounts: () => undefined });
    const falsy = await stepRequests({ stepLimitsData: false });
    expect(portOnly.requests.map(bytesOf)).toEqual(plain.requests.map(bytesOf));
    expect(falsy.requests.map(bytesOf)).toEqual(plain.requests.map(bytesOf));
    expect(portOnly.outcome).toEqual(plain.outcome);
    for (const request of plain.requests) expect(request.input).not.toContain(REPAIR_STEP_LIMITS_DATA_NAME);

    const withBlock = await stepRequests({ stepLimitsData: true });
    expect(withBlock.outcome).toEqual(plain.outcome);
    for (const [index, request] of withBlock.requests.entries()) {
      const base = plain.requests[index];
      if (base === undefined) throw new Error("要求が無い");
      const block = `<data name="${REPAIR_STEP_LIMITS_DATA_NAME}">\n${JSON.stringify(limitsBlock(0), null, 2)}\n</data>`;
      expect(request.input).toBe(`${base.input}\n${block}`);
      expect(request.instructions).toBe(base.instructions);
      expect(request.rules).toEqual(base.rules);
      expect(request.documents).toEqual(base.documents);
      expect(request.tools).toEqual(base.tools);
      expect(request.schemaName).toBe(base.schemaName);
      expect(request.schema).toEqual(base.schema);
      expect(request.turns).toEqual(base.turns);
      expectNoAcceptanceMaterial([request.input]);
    }
  });

  it("拒否の塊と併せたときは、上限の塊が末尾（拒否の塊のあと）に来る", async () => {
    const initial = await version(V1);
    const recording = createRecordingClient([done(V2)]);
    await runRepairStep({
      source: SOURCE,
      list: LIST,
      suite: SUITE,
      current: initial,
      correspondences: CORRESPONDENCES,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      declRejections: [{ requirementId: "R-1", kind: "expression", quote: "件数を合計する" }],
      stepLimitsData: true,
    });
    const input = recording.tools[0]?.input ?? "";
    expect(input.indexOf(DECLARATION_REJECTIONS_DATA_NAME)).toBeGreaterThan(0);
    expect(input.indexOf(REPAIR_STEP_LIMITS_DATA_NAME)).toBeGreaterThan(input.indexOf(DECLARATION_REJECTIONS_DATA_NAME));
    expect(input.endsWith("</data>")).toBe(true);
  });

  it("口の値に会話・引数・本文が無い（数と上限の名前だけ）", async () => {
    const recording = createRecordingClient(
      Array.from({ length: AGENT_LIMITS.repairStepTurns }, (_, i) => toolCalls([staticCheckCall(`c${i}`, V1)])),
    );
    const { counts } = await runCounted(makeGateway(recording.client, { maxAttempts: 1 }));
    const text = JSON.stringify(counts);
    expect(text).not.toContain("entities");
    expect(text).not.toContain(SOURCE);
    expect(text).not.toContain("static-check");
    expect(text).not.toContain("c0");
  });

  it("この手で直したファイル（段・記録・走らせる部分と、その試験）に受入の題材の言葉が無い（走査）", async () => {
    const fs = (await import(/* @vite-ignore */ "node:fs")) as { readFileSync(path: URL, encoding: "utf8"): string };
    const files = ["./repair.ts", "./repair.test.ts", "../record.ts", "../record.test.ts", "../v11a/run.ts", "../v11a/run.test.ts"];
    expectNoAcceptanceMaterial(files.map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});
