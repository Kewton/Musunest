// Plan の探針（Issue #956）の試験。
//
// **実 API は呼ばない。** 記録した応答を返す偽物の LLM で閉じ、Plan の経路と同じ要求・同じ選択で流れる
// ことを、要求のバイト列で確かめる。採点（保持率・検出率）は持たない。
import { describe, expect, it, vi } from "vitest";
import { AGENT_LIMITS, type AgentLimits } from "../limits.js";
import { createFakeJudge } from "../judge-fake.js";
import { createRecordingClient, REQUIREMENT_LIST_OUTPUT, SAMPLE_DOCUMENTS, SOURCE_TEXT } from "../stages/__tests__/prompt.js";
import { REVERSE_CHECK_SCHEMA_NAME } from "../stages/reverse-check.js";
import { FINDING_CHECK_SCHEMA_NAME } from "../stages/finding-check.js";
import { REQUIREMENTS_SCHEMA_NAME } from "../stages/requirements.js";
import { structured } from "../__tests__/run.js";
import { runPlan, type PlanResponder } from "./run-plan.js";
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

/** 枠の文を持つ P1 の応答（P2 の一覧に `framing` が載る） */
const FRAMED_LIST_OUTPUT = {
  ...PLAN_LIST_OUTPUT,
  framing: [{ quote: "タスク", position: { start: 0, end: 3 } }],
};

/** 引用が原文に無い要件を 1 つ持つ P1 の応答（引用の修復の経路に入る） */
const BAD_QUOTE_LIST_OUTPUT = {
  ...PLAN_LIST_OUTPUT,
  requirements: REQUIREMENT_LIST_OUTPUT.requirements.map((requirement, index) =>
    index === 0 ? { ...requirement, quote: "タスクを登録する" } : requirement,
  ),
};

/** 修復しても引用が原文に無いままの応答（Plan は requirements の段で確定を止める） */
const BAD_QUOTE_REPAIR_OUTPUT = {
  repairs: [{ index: 0, quote: "原文に無い引用", position: { start: 0, end: 8 } }],
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
function planScript(first: unknown = PLAN_LIST_OUTPUT) {
  return [structured(first), structured({ uncovered: [] }), structured(PLAN_LIST_OUTPUT), structured({ uncovered: [] })];
}

/** 引用の修復を通る台本（修復しても引用が無いので、Plan は requirements の段で止まる） */
function quoteRepairScript() {
  return [
    structured(BAD_QUOTE_LIST_OUTPUT),
    structured({ uncovered: [] }),
    structured(BAD_QUOTE_REPAIR_OUTPUT),
    structured({ uncovered: [] }),
  ];
}

/** 3 文すべてを覆う一覧（Issue #967 の確かめの台本で使う） */
const FULL_LIST_OUTPUT = {
  ...PLAN_LIST_OUTPUT,
  requirements: [
    ...REQUIREMENTS,
    {
      id: "R-3",
      text: "色を選べる",
      quote: "色を選ぶ。",
      position: { start: PROBE_SOURCE.indexOf("色を選ぶ。"), end: PROBE_SOURCE.indexOf("色を選ぶ。") + "色を選ぶ。".length },
    },
  ],
};

/** 確かめ役の「missing」の答え（Issue #967） */
const FINDING_MISSING = { verdict: "missing", requirement_ids: [], reason: "条件の欠落として保つ" };

/** 会話の指摘と、確かめ役の要求を含む台本（Plan も探針も requirements の段で止まる） */
function findingScript() {
  return [
    structured(PLAN_LIST_OUTPUT),
    structured({ uncovered: [{ start: 0, end: 3 }] }),
    structured(FINDING_MISSING),
    structured(FULL_LIST_OUTPUT),
    structured({ uncovered: [{ start: 0, end: 3 }] }),
  ];
}

const responder: PlanResponder = {
  async answer() {
    return { kind: "answers", answers: [] };
  },
  async confirm() {
    return "build";
  },
};

async function runPlanRequirements(source: string, calls: ReturnType<typeof planScript> = planScript()) {
  const recording = createRecordingClient(calls);
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

  it("p2 の枠の文も、Plan の初回の P2 と同じに渡す", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE, planScript(FRAMED_LIST_OUTPUT));
    const probe = await runProbe("p2", PROBE_SOURCE, { extras: { framing: ["タスク"] } });
    expect(JSON.stringify(probe.requests)).toBe(JSON.stringify([plan.requests[1]]));
  });

  it("loop の呼び出し列と各要求が、Plan の requirements の段と直列化して byte で同じ", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE);
    const probe = await runProbe("loop", PROBE_SOURCE);
    expect(plan.result.kind).toBe("cannot-confirm");
    expect(JSON.stringify(probe.requests)).toBe(JSON.stringify(plan.requests));
  });

  it("loop の引用の修復の要求も、本物の Plan の requirements の段と直列化して byte で同じ", async () => {
    const plan = await runPlanRequirements(SOURCE_TEXT, quoteRepairScript());
    const probe = await runProbe("loop", SOURCE_TEXT, { calls: quoteRepairScript() });
    expect(plan.result).toMatchObject({ kind: "cannot-confirm" });
    expect(JSON.stringify(probe.requests)).toBe(JSON.stringify(plan.requests));
    expect(probe.requests.some((request) => request.schemaName === "requirement-quote-repair")).toBe(true);
  });

  it("loop の確かめ役の要求も、本物の Plan の requirements の段と直列化して byte で同じ（Issue #967）", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE, findingScript());
    const probe = await runProbe("loop", PROBE_SOURCE, { calls: findingScript() });
    expect(plan.result).toMatchObject({ kind: "cannot-confirm" });
    expect(JSON.stringify(probe.requests)).toBe(JSON.stringify(plan.requests));
    expect(probe.requests.filter((request) => request.schemaName === FINDING_CHECK_SCHEMA_NAME)).toHaveLength(1);
  });

  it("探針の側だけが選択を 1 つ欠いた写しを渡す変異で、p2 と loop の byte 比較が赤になる", async () => {
    const plan = await runPlanRequirements(PROBE_SOURCE);
    vi.resetModules();
    vi.doMock("./run-plan.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./run-plan.js")>();
      return {
        ...actual,
        // 探針の側だけが欠いた写しを使う変異（Plan の経路は本物の定数のまま）
        PLAN_REVERSE_CHECK_SELECTIONS: { ...actual.PLAN_REVERSE_CHECK_SELECTIONS, observeConditionFindings: false },
      };
    });
    try {
      const mutated = await import("./probe.js");
      const p2Calls = createRecordingClient([structured({ uncovered: [] })]);
      const p2 = await mutated.runPlanProbe({
        stage: "p2",
        cases: caseSet(PROBE_SOURCE, "p2"),
        documents: SAMPLE_DOCUMENTS,
        client: p2Calls.client,
        budgetUsd: 10,
        deadline: 60_000,
        now: () => 0,
        rates: RATES,
        effort: "low",
        repeat: 1,
      });
      expect(p2.runs[0]?.state).toBe("ok");
      expect(JSON.stringify(p2Calls.structured)).not.toBe(JSON.stringify([plan.requests[1]]));

      const loopCalls = createRecordingClient(planScript());
      const loop = await mutated.runPlanProbe({
        stage: "loop",
        cases: caseSet(PROBE_SOURCE, "loop"),
        documents: SAMPLE_DOCUMENTS,
        client: loopCalls.client,
        budgetUsd: 10,
        deadline: 60_000,
        now: () => 0,
        rates: RATES,
        effort: "low",
        repeat: 1,
      });
      expect(loop.runs[0]?.state).toBe("ok");
      expect(JSON.stringify(loopCalls.structured)).not.toBe(JSON.stringify(plan.requests));
    } finally {
      vi.doUnmock("./run-plan.js");
      vi.resetModules();
    }
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

  // ── 門は回ごと（Plan の 1 回の走りに当たる）────────────────────────

  it("門と口を回ごとに作り直すので、loop を 7 回流しても呼び出しの上限で止まらない", async () => {
    const probe = await runProbe("loop", PROBE_SOURCE, {
      calls: Array.from({ length: 7 }, () => planScript()).flat(),
      repeat: 7,
    });
    expect(probe.result.runs.map((run) => run.state)).toEqual(Array.from({ length: 7 }, () => "ok"));
    expect(probe.result.summary).toMatchObject({ planned: 7, completed: 7, failed: 0, not_run: 0 });
    expect(probe.result.runs.every((run) => run.calls === 4 && run.stage_calls === 4)).toBe(true);
  });

  it("呼び出しの上限は回ごとに 0 から数え、1 回で超えた回だけ failed / call-limit にする", async () => {
    const probe = await runProbe("loop", PROBE_SOURCE, {
      calls: [...planScript(), ...planScript()],
      repeat: 2,
      limits: { ...AGENT_LIMITS, callCount: 3 },
    });
    expect(probe.result.runs.map((run) => [run.state, run.stop_reason, run.calls])).toEqual([
      ["failed", "call-limit", 3],
      ["failed", "call-limit", 3],
    ]);
    expect(probe.result.summary).toMatchObject({ completed: 0, failed: 2, not_run: 0 });
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
    expect(observePlanProbeOverlaps(undefined, null, null, "ok")).toBeNull();
  });

  it("一覧が無い回の重なりは null、状態が ok でない回の断片は null（0 件と混ぜない）", async () => {
    const failedP2 = await runProbe("p2", PROBE_SOURCE, {
      calls: [structured({}), structured({})],
      extras: { ranges: [{ id: "r-1", start: 0, end: 8 }] },
    });
    expect(failedP2.result.runs[0]?.state).toBe("failed");
    expect(failedP2.result.runs[0]?.overlaps).toEqual([
      { range_id: "r-1", requirement_ids: ["R-1"], remaining_fragments: null },
    ]);

    const failedLoop = await runProbe("loop", PROBE_SOURCE, {
      calls: [structured({}), structured({})],
      extras: { ranges: [{ id: "r-1", start: 0, end: 8 }] },
    });
    expect(failedLoop.result.runs[0]?.state).toBe("failed");
    expect(failedLoop.result.runs[0]?.list).toBeNull();
    expect(failedLoop.result.runs[0]?.overlaps).toBeNull();

    const notRun = await runProbe("p1", PROBE_SOURCE, {
      calls: [],
      budgetUsd: 0.0000001,
      extras: { ranges: [{ id: "r-1", start: 0, end: 8 }] },
    });
    expect(notRun.result.runs[0]?.state).toBe("not-run");
    expect(notRun.result.runs[0]?.overlaps).toBeNull();
  });

  // ── 未実行と失敗を 0 にしない ────────────────────────────────────────

  it("予算切れ・締切・呼び出しの上限・形の失敗で、状態と停止の理由が分かれ、後続が not-run になる", async () => {
    const budget = await runProbe("p1", SOURCE_TEXT, { calls: [], budgetUsd: 0.0000001, repeat: 2 });
    // 1 回も呼ばずに予算で断った回は `not-run`（呼んでから止まった回は `failed`）
    expect(budget.result.runs.map((run) => [run.state, run.stop_reason, run.calls])).toEqual([
      ["not-run", "budget", 0],
      ["not-run", "budget", 0],
    ]);
    expect(budget.result.summary).toMatchObject({ completed: 0, failed: 0, not_run: 2 });

    const deadline = await runProbe("p1", SOURCE_TEXT, { calls: [], deadline: 0, repeat: 2 });
    expect(deadline.result.runs.map((run) => [run.state, run.stop_reason])).toEqual([
      ["not-run", "deadline"],
      ["not-run", "deadline"],
    ]);

    const limit = await runProbe("p1", SOURCE_TEXT, {
      calls: [],
      repeat: 2,
      limits: { ...AGENT_LIMITS, callCount: 0 },
    });
    expect(limit.result.runs.map((run) => [run.state, run.stop_reason, run.calls])).toEqual([
      ["not-run", "call-limit", 0],
      ["not-run", "call-limit", 0],
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
      caseFileSha256: "case-file-sha",
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
    expect(conditions.case_file_sha256).toBe("case-file-sha");
    expect(conditions.documents.map((document) => document.name)).toEqual(SAMPLE_DOCUMENTS.map((document) => document.name));
    expect(conditions.documents.every((document) => document.bytes > 0 && document.sha256 !== "")).toBe(true);
    expect(JSON.stringify(conditions)).not.toContain(SAMPLE_DOCUMENTS[0]?.text ?? "");
    expect(conditions.selections).toEqual({
      quoteRepair: true,
      meaningRule: true,
      keepValidProvenance: true,
      observeConditionFindings: true,
      conditionRule: true,
      findingCheck: true,
    });
  });
});
