// Plan の探針（Issue #956）の試験。
//
// **実 API は呼ばない。** 記録した応答を返す偽物の LLM で閉じ、Plan の経路と同じ要求・同じ選択で流れる
// ことを、要求のバイト列で確かめる。採点（保持率・検出率）は持たない。
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS, type AgentLimits } from "../limits.js";
import { createFakeJudge } from "../judge-fake.js";
import { makeGateway, createRecordingClient, REQUIREMENT_LIST_OUTPUT, SAMPLE_DOCUMENTS, SOURCE_TEXT } from "../stages/__tests__/prompt.js";
import { runReverseCheckLoopWithOperation, REVERSE_CHECK_SCHEMA_NAME } from "../stages/reverse-check.js";
import { REQUIREMENTS_SCHEMA_NAME } from "../stages/requirements.js";
import { structured } from "../__tests__/run.js";
import { PLAN_REVERSE_CHECK_SELECTIONS, runPlan, type PlanResponder } from "./run-plan.js";
import {
  PLAN_PROBE_CASES_SCHEMA,
  buildPlanProbeConditions,
  observePlanProbeOverlaps,
  parsePlanProbeCases,
  planProbeStopReasonOf,
  runPlanProbe,
  validatePlanProbeCaseSet,
  type PlanProbeCaseSet,
  type PlanProbeStage,
} from "./probe.js";

const RATES = { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 };

/** 末尾に、どの要件にも覆われない文を 1 つ足した原文（P2 の落ちを残す） */
const PROBE_SOURCE = `${SOURCE_TEXT}色を選ぶ。`;

const REQUIREMENTS = REQUIREMENT_LIST_OUTPUT.requirements;
/** Plan の P1 の応答（決定は空。探針へ渡す一覧と同じにする） */
const PLAN_LIST_OUTPUT = { ...REQUIREMENT_LIST_OUTPUT, decisions: [] };

/** 引用が原文に無い要件を 1 つ持つ P1 の応答（引用の修復の経路に入る） */
const BAD_QUOTE_LIST_OUTPUT = {
  ...PLAN_LIST_OUTPUT,
  requirements: REQUIREMENT_LIST_OUTPUT.requirements.map((requirement, index) =>
    index === 0 ? { ...requirement, quote: "タスクを登録する" } : requirement,
  ),
};

/** 引用の修復の応答 */
const QUOTE_REPAIR_OUTPUT = {
  repairs: [{ index: 0, quote: "タスクを記録する", position: { start: 0, end: 8 } }],
};

function caseSet(source: string, stage: PlanProbeStage, extras: Partial<PlanProbeCaseSet["cases"][number]> = {}): PlanProbeCaseSet {
  return {
    schema_version: PLAN_PROBE_CASES_SCHEMA,
    cases_version: "cases-v1",
    cases: [
      {
        id: "case-1",
        source,
        ...(stage === "p2" ? { requirements: REQUIREMENTS } : {}),
        ...extras,
      },
    ],
  };
}

/** Plan の requirements の段が送る 4 つの要求（P1 → P2 → 作り直しの P1 → P2）の台本 */
function planScript() {
  return [structured(PLAN_LIST_OUTPUT), structured({ uncovered: [] }), structured(PLAN_LIST_OUTPUT), structured({ uncovered: [] })];
}

const responder: PlanResponder = {
  async answer() {
    return { kind: "answers", answers: [] };
  },
  async confirm() {
    return "build";
  },
};

async function runPlanRequirements(source: string) {
  const recording = createRecordingClient(planScript());
  const result = await runPlan({
    source,
    documents: SAMPLE_DOCUMENTS,
    client: recording.client,
    judge: createFakeJudge({}),
    responder,
    budgetUsd: 10,
    rates: RATES,
    now: () => 0,
    deadline: 60_000,
    effort: "low",
    planId: "plan-1",
    vocabularyVersion: "v1",
    confirmedBy: "tester",
  });
  return { result, requests: recording.structured };
}

async function runProbe(
  stage: PlanProbeStage,
  source: string,
  options: {
    readonly calls?: ReturnType<typeof planScript>;
    readonly repeat?: number;
    readonly budgetUsd?: number;
    readonly deadline?: number;
    readonly limits?: AgentLimits;
    readonly extras?: Partial<PlanProbeCaseSet["cases"][number]>;
  } = {},
) {
  const defaultCalls =
    stage === "p1"
      ? [structured(PLAN_LIST_OUTPUT)]
      : stage === "p2"
        ? [structured({ uncovered: [] })]
        : planScript();
  const recording = createRecordingClient(options.calls ?? defaultCalls);
  const result = await runPlanProbe({
    stage,
    cases: caseSet(source, stage, options.extras ?? {}),
    documents: SAMPLE_DOCUMENTS,
    client: recording.client,
    budgetUsd: options.budgetUsd ?? 10,
    deadline: options.deadline ?? 60_000,
    now: () => 0,
    rates: RATES,
    effort: "low",
    repeat: options.repeat ?? 1,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return { result, requests: recording.structured };
}

describe("Plan の探針", () => {
  // ── 要求は Plan と同じ（byte で比べる）──────────────────────────────

  it("p1 の要求が、Plan の初回の P1 と直列化して byte で同じ", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE);
    const probe = await runProbe("p1", PROBE_SOURCE);
    expect(JSON.stringify(probe.requests)).toBe(JSON.stringify([plan.requests[0]]));
  });

  it("p2 の要求が、Plan の初回の P2（同じ一覧）と直列化して byte で同じ", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE);
    const probe = await runProbe("p2", PROBE_SOURCE);
    expect(JSON.stringify(probe.requests)).toBe(JSON.stringify([plan.requests[1]]));
  });

  it("loop の呼び出し列と各要求が、Plan の requirements の段と直列化して byte で同じ", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE);
    const probe = await runProbe("loop", PROBE_SOURCE);
    expect(plan.result.kind).toBe("cannot-confirm");
    expect(JSON.stringify(probe.requests)).toBe(JSON.stringify(plan.requests));
  });

  it("loop の引用の修復の要求も、Plan と同じ選択の往復と直列化して byte で同じ", async () => {
    const script = () => [
      structured(BAD_QUOTE_LIST_OUTPUT),
      structured({ uncovered: [] }),
      structured(QUOTE_REPAIR_OUTPUT),
      structured({ uncovered: [] }),
    ];
    const planSide = createRecordingClient(script());
    const outcome = await runReverseCheckLoopWithOperation({
      source: SOURCE_TEXT,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(planSide.client, { effort: "low" }),
      ...PLAN_REVERSE_CHECK_SELECTIONS,
    });
    expect(outcome.ok).toBe(true);
    const probe = await runProbe("loop", SOURCE_TEXT, { calls: script() });
    expect(JSON.stringify(probe.requests)).toBe(JSON.stringify(planSide.structured));
    expect(probe.requests.some((request) => request.schemaName === "requirement-quote-repair")).toBe(true);
  });

  it("探針の側だけが選択を 1 つ欠いた写しを渡す変異で、要求の比較が赤になる", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE);
    // 探針の代わりの変異（observeConditionFindings を欠いた写し）。P2 の要求が Plan と別物になる
    const recording = createRecordingClient(planScript());
    await runReverseCheckLoopWithOperation({
      source: PROBE_SOURCE,
      documents: SAMPLE_DOCUMENTS,
      gateway: makeGateway(recording.client, { effort: "low" }),
      quoteRepair: true,
      meaningRule: true,
      keepValidProvenance: true,
    });
    expect(JSON.stringify(recording.structured[1])).not.toBe(JSON.stringify(plan.requests[1]));
  });

  // ── 段の外を呼ばない ────────────────────────────────────────────────

  it("p1 は段の呼び出しが 1 回で終わり、要件の口だけを呼ぶ", async () => {
    const probe = await runProbe("p1", PROBE_SOURCE, { calls: [structured(REQUIREMENT_LIST_OUTPUT)] });
    const run = probe.result.runs[0];
    expect(run?.state).toBe("ok");
    expect(run?.stage_calls).toBe(1);
    expect(run?.shape_retries).toBe(0);
    expect(run?.calls).toBe(1);
    expect(probe.requests.map((request) => request.schemaName)).toEqual([REQUIREMENTS_SCHEMA_NAME]);
  });

  it("p2 は段の呼び出しが 1 回で終わり、逆照合の口だけを呼ぶ", async () => {
    const probe = await runProbe("p2", PROBE_SOURCE, { calls: [structured({ uncovered: [] })] });
    const run = probe.result.runs[0];
    expect(run?.state).toBe("ok");
    expect(run?.stage_calls).toBe(1);
    expect(run?.calls).toBe(1);
    expect(probe.requests.map((request) => request.schemaName)).toEqual([REVERSE_CHECK_SCHEMA_NAME]);
  });

  it("loop は同じ応答の列を与えた Plan の requirements の段と同じ回数で終わり、P3 以降を呼ばない", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE);
    const probe = await runProbe("loop", PROBE_SOURCE);
    const run = probe.result.runs[0];
    expect(run?.stage_calls).toBe(plan.requests.length);
    const names = probe.requests.map((request) => request.schemaName);
    expect(names.every((name) => name === REQUIREMENTS_SCHEMA_NAME || name === REVERSE_CHECK_SCHEMA_NAME)).toBe(true);
    expect(names).toContain(REQUIREMENTS_SCHEMA_NAME);
    expect(names).toContain(REVERSE_CHECK_SCHEMA_NAME);
  });

  // ── 組の検査（呼び出し 0 回）────────────────────────────────────────

  it("形の誤り・ID の重複・原文の外の範囲・p2 の一覧の欠けを断る", () => {
    expect(parsePlanProbeCases("{")).toMatchObject({ code: "probe-cases:json" });
    expect(
      parsePlanProbeCases(
        JSON.stringify({
          schema_version: PLAN_PROBE_CASES_SCHEMA,
          cases_version: "v1",
          cases: [
            { id: "same", source: "a" },
            { id: "same", source: "b" },
          ],
        }),
      ),
    ).toMatchObject({ code: "probe-cases:duplicate-case" });
    expect(
      parsePlanProbeCases(
        JSON.stringify({
          schema_version: PLAN_PROBE_CASES_SCHEMA,
          cases_version: "v1",
          cases: [
            {
              id: "one",
              source: "abcdef",
              requirements: [
                { id: "R-1", text: "a", quote: "a", position: { start: 0, end: 1 } },
                { id: "R-1", text: "b", quote: "b", position: { start: 1, end: 2 } },
              ],
            },
          ],
        }),
      ),
    ).toMatchObject({ code: "probe-cases:duplicate-requirement" });
    const outOfRange = parsePlanProbeCases(
      JSON.stringify({
        schema_version: PLAN_PROBE_CASES_SCHEMA,
        cases_version: "v1",
        cases: [{ id: "one", source: "abc", ranges: [{ id: "r", start: 1, end: 9 }] }],
      }),
    );
    expect(outOfRange).toMatchObject({ code: "probe-cases:range" });
    const parsed = parsePlanProbeCases(
      JSON.stringify({
        schema_version: PLAN_PROBE_CASES_SCHEMA,
        cases_version: "v1",
        cases: [{ id: "one", source: "abc" }],
      }),
    );
    if ("code" in parsed) throw new Error(parsed.code);
    expect(validatePlanProbeCaseSet(parsed.cases, "p2")).toMatchObject({ code: "probe-cases:missing-requirements" });
  });

  it("p2 の一覧が引用の実在の検査に落ちる件と、位置を決め直す件を、別の符号で断る", () => {
    const missingQuote = parsePlanProbeCases(
      JSON.stringify({
        schema_version: PLAN_PROBE_CASES_SCHEMA,
        cases_version: "v1",
        cases: [
          {
            id: "one",
            source: "abcdef",
            requirements: [{ id: "R-1", text: "x", quote: "zzz", position: { start: 0, end: 3 } }],
          },
        ],
      }),
    );
    if ("code" in missingQuote) throw new Error(missingQuote.code);
    expect(validatePlanProbeCaseSet(missingQuote.cases, "p2")).toMatchObject({ code: "probe-cases:coverage" });

    const shifted = parsePlanProbeCases(
      JSON.stringify({
        schema_version: PLAN_PROBE_CASES_SCHEMA,
        cases_version: "v1",
        cases: [
          {
            id: "one",
            source: "abcdef",
            requirements: [{ id: "R-1", text: "ab", quote: "ab", position: { start: 1, end: 3 } }],
          },
        ],
      }),
    );
    if ("code" in shifted) throw new Error(shifted.code);
    expect(validatePlanProbeCaseSet(shifted.cases, "p2")).toMatchObject({ code: "probe-cases:reposition" });
  });

  it("組の検査に落ちると、LLM を 1 回も呼ばない", async () => {
    const recording = createRecordingClient([]);
    const parsed = parsePlanProbeCases(
      JSON.stringify({
        schema_version: PLAN_PROBE_CASES_SCHEMA,
        cases_version: "v1",
        cases: [{ id: "one", source: "abc" }],
      }),
    );
    if ("code" in parsed) throw new Error(parsed.code);
    const invalid = validatePlanProbeCaseSet(parsed.cases, "p2");
    expect(invalid).not.toBeNull();
    expect(recording.structured).toEqual([]);
  });

  // ── 重なりは観測 ────────────────────────────────────────────────────

  it("範囲に重なる要件の ID と残った断片を出し、重なりの有無で状態・集計を変えない", async () => {
    const withRanges = await runProbe("p2", PROBE_SOURCE, {
      calls: [structured({ uncovered: [{ start: 17, end: 20 }] })],
      extras: {
        ranges: [
          { id: "r-1", start: 0, end: 8 },
          { id: "r-2", start: 16, end: 22 },
        ],
      },
    });
    const withoutRanges = await runProbe("p2", PROBE_SOURCE, {
      calls: [structured({ uncovered: [{ start: 17, end: 20 }] })],
    });
    const overlaps = withRanges.result.runs[0]?.overlaps ?? [];
    expect(overlaps).toEqual([
      { range_id: "r-1", requirement_ids: ["R-1"], remaining_fragments: [] },
      { range_id: "r-2", requirement_ids: [], remaining_fragments: [{ start: 17, end: 20 }] },
    ]);
    expect(withRanges.result.runs[0]?.state).toBe(withoutRanges.result.runs[0]?.state);
    expect(withRanges.result.summary).toEqual(withoutRanges.result.summary);
    expect(observePlanProbeOverlaps(undefined, null, null)).toEqual([]);
  });

  // ── 未実行と失敗を 0 にしない ────────────────────────────────────────

  it("予算切れ・締切・呼び出しの上限・形の失敗で、状態と停止の理由が分かれ、後続が not-run になる", async () => {
    const budget = await runProbe("p1", SOURCE_TEXT, { calls: [], budgetUsd: 0.0000001, repeat: 2 });
    expect(budget.result.runs.map((run) => [run.state, run.stop_reason])).toEqual([
      ["failed", "budget"],
      ["not-run", "budget"],
    ]);
    expect(budget.result.summary).toMatchObject({ completed: 0, failed: 1, not_run: 1 });

    const deadline = await runProbe("p1", SOURCE_TEXT, { calls: [], deadline: 0, repeat: 2 });
    expect(deadline.result.runs.map((run) => [run.state, run.stop_reason])).toEqual([
      ["failed", "deadline"],
      ["not-run", "deadline"],
    ]);

    const limit = await runProbe("p1", SOURCE_TEXT, {
      calls: [],
      repeat: 2,
      limits: { ...AGENT_LIMITS, callCount: 0 },
    });
    expect(limit.result.runs.map((run) => [run.state, run.stop_reason])).toEqual([
      ["failed", "call-limit"],
      ["not-run", "call-limit"],
    ]);

    const malformed = await runProbe("p1", SOURCE_TEXT, {
      calls: [structured({}), structured({})],
      repeat: 2,
    });
    expect(malformed.result.runs.map((run) => [run.state, run.stop_reason])).toEqual([
      ["failed", "malformed"],
      ["not-run", "malformed"],
    ]);
    expect(malformed.result.runs[0]?.shape_retries).toBe(1);
    expect(malformed.result.runs[0]?.stage_calls).toBe(1);
  });

  it("usage が不明な回は予約を戻さず、後続を not-run にする", async () => {
    const probe = await runProbe("p1", SOURCE_TEXT, {
      calls: [{ kind: "structured", output: REQUIREMENT_LIST_OUTPUT, usage: undefined }],
      repeat: 2,
    });
    expect(probe.result.runs[0]?.state).toBe("ok");
    expect(probe.result.runs[0]?.usage_unknown).toBe(true);
    expect(probe.result.runs[0]?.stop_reason).toBe("usage-unknown");
    expect(probe.result.runs[1]?.state).toBe("not-run");
    expect(probe.result.summary).toMatchObject({ completed: 1, failed: 0, not_run: 1 });
    expect(probe.result.summary.cost.usage_unknown_runs).toBe(1);
  });

  it("停止の理由と失敗の分類を、値を持たない固定の符号で残す", () => {
    expect(planProbeStopReasonOf({ kind: "budget", maxCostUsd: 1, remainingUsd: 0 })).toBe("budget");
    expect(planProbeStopReasonOf({ kind: "callLimit", limit: "callCount", max: 0, actual: 0 })).toBe("call-limit");
    expect(planProbeStopReasonOf({ kind: "malformed", attempts: 2, problems: [] })).toBe("malformed");
    expect(planProbeStopReasonOf({ kind: "incomplete", reason: "max_output_tokens" })).toBe("incomplete");
  });

  // ── 条件の記録 ──────────────────────────────────────────────────────

  it("条件に、組の SHA・文書のバイト数と SHA・選択の値を残し、文書の本文を写さない", async () => {
    const cases = caseSet(SOURCE_TEXT, "loop");
    const conditions = await buildPlanProbeConditions({
      stage: "loop",
      cases,
      caseSetSha256: "case-set-sha",
      documents: SAMPLE_DOCUMENTS,
      sourceSha256: { "case-1": "source-sha" },
      provider: "openai",
      model: "model-x",
      effort: "low",
      repeat: 1,
      budgetUsd: 1,
      deadlineMs: 60_000,
      limits: AGENT_LIMITS,
      rates: RATES,
    });
    expect(conditions.case_set_sha256).toBe("case-set-sha");
    expect(conditions.documents.map((document) => document.name)).toEqual(SAMPLE_DOCUMENTS.map((document) => document.name));
    expect(conditions.documents.every((document) => document.bytes > 0 && document.sha256 !== "")).toBe(true);
    expect(JSON.stringify(conditions)).not.toContain(SAMPLE_DOCUMENTS[0]?.text ?? "");
    expect(conditions.selections).toEqual({
      quoteRepair: true,
      meaningRule: true,
      keepValidProvenance: true,
      observeConditionFindings: true,
    });
  });
});
