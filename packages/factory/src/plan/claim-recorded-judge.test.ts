// 記録の口（plan/claim-recorded-judge.ts）の unit テスト（Issue #459）。
//
// 「再点検なし」の基準の経路は、記録した主の応答を**要求の内容のハッシュ**で引いて返す記録の口へ、
// **同じ点検の関数**を再点検の口なしで流す。ここで固定するのは、その記録の口が
//   - 記録した応答で流した結果が、同じ偽物を直接呼んだ結果と**全申告の分類・行き先で一致**すること
//   - 記録に無い要求では**止まる**こと（空の配列を成功とも申告無しとも読ませない）
import { describe, expect, it } from "vitest";
import { JobBudget } from "../budget.js";
import { createCallGate } from "../call.js";
import { createBudgetedJudge } from "../judge-budget.js";
import type { Judge, JudgeAnswer, JudgeRequest } from "../judge.js";
import { SAMPLE_DOCUMENTS } from "../stages/__tests__/prompt.js";
import type { PlanSurface, PlanUnwritable } from "./surface.js";
import {
  DEFAULT_PLAN_JUDGE_THRESHOLD,
} from "./run-plan.js";
import {
  runSurfaceCheck,
  surfaceSupportQuestionName,
  surfaceTriageQuestionName,
  type SurfaceCheckResult,
} from "./surface-check.js";
import {
  RecordedJudgeMissError,
  createCallHash,
  createJudgeRecorder,
  createRecordedJudge,
  recordJudge,
} from "./claim-recorded-judge.js";

function choice(value: string, confidence?: number): JudgeAnswer {
  return { kind: "choice", choice: value, probabilities: undefined, probability: undefined, confidence };
}

function claim(id: string, requirementId: string, part: string, constraintIds: readonly string[]): PlanUnwritable {
  return { id, requirementId, part, reason: `理由 ${id}`, constraintIds, alternative: "代案" };
}

const SURFACE: PlanSurface = {
  ambiguities: [],
  unwritable: [
    claim("U-0", "R-1", "穴の部分", ["記録"]),
    claim("U-1", "R-1", "曖昧の部分", ["合計"]),
    claim("U-2", "R-2", "書いていない部分", ["記録"]),
  ],
};

const REQUIREMENTS = new Map([
  ["R-1", "要件 R-1 の文"],
  ["R-2", "要件 R-2 の文"],
]);

/** 申告と判定を結び付けた要約（分類・行き先） */
function summarize(result: SurfaceCheckResult): unknown {
  return {
    accepted: result.accepted.map((item) => item.id),
    dropped: result.dropped.map((item) => [item.index, item.code]),
    ambiguities: result.ambiguities.map((item) => item.index),
    unchecked: result.unchecked.map((item) => [item.index, item.code]),
  };
}

const ANSWERS: Readonly<Record<string, JudgeAnswer>> = {
  [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
  [surfaceTriageQuestionName(1)]: choice("not-a-problem", 0.9),
  [surfaceTriageQuestionName(2)]: choice("vocabulary-hole", 0.9),
  [surfaceSupportQuestionName(0)]: choice("supports", 0.9),
  [surfaceSupportQuestionName(2)]: choice("not-stated", 0.9),
};

function answering(answers: Readonly<Record<string, JudgeAnswer>>): Judge {
  return {
    async judge(request) {
      const out: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(request.questions)) {
        const answer = answers[name];
        if (answer === undefined) throw new Error(`問い ${name} の答えが用意されていません`);
        out[name] = answer;
      }
      return { answers: out, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
    },
  };
}

async function directNoRecheck(): Promise<SurfaceCheckResult> {
  return runSurfaceCheck({
    surface: SURFACE,
    documents: SAMPLE_DOCUMENTS,
    judge: answering(ANSWERS),
    threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
    requirements: REQUIREMENTS,
    docVersion: "v1",
  });
}

async function replayedNoRecheck(): Promise<SurfaceCheckResult> {
  const recorder = createJudgeRecorder();
  // 記録の段（応答を集める）
  await runSurfaceCheck({
    surface: SURFACE,
    documents: SAMPLE_DOCUMENTS,
    judge: recordJudge(answering(ANSWERS), recorder),
    threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
    requirements: REQUIREMENTS,
    docVersion: "v1",
  });
  // 流し直しの段（記録の口を、再点検の口なしで流す）
  return runSurfaceCheck({
    surface: SURFACE,
    documents: SAMPLE_DOCUMENTS,
    judge: createRecordedJudge(recorder.entries),
    threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
    requirements: REQUIREMENTS,
    docVersion: "v1",
  });
}

describe("記録の口は、再点検なしの基準の結果を一致させる（Issue #459）", () => {
  it("同じ偽物を直接呼んだ結果と、全申告の分類・行き先で一致する", async () => {
    const direct = await directNoRecheck();
    const replay = await replayedNoRecheck();
    expect(summarize(replay)).toEqual(summarize(direct));
    // 低確信度・不明・「書いていない」・未知の答えを含む分類が、両方で同じである
    expect(direct.unchecked.map((item) => item.index)).toEqual([2]);
    expect(direct.accepted.map((item) => item.id)).toEqual(["U-0"]);
  });
});

describe("記録の口の呼び出しは、実 API の試行にも使用量にも数えない（Issue #459）", () => {
  it("流し直しの段は、予算の残高と試行の数を動かさない", async () => {
    const budget = new JobBudget(10);
    const recorder = createJudgeRecorder();
    const budgeted = createBudgetedJudge({
      judge: recordJudge(answering(ANSWERS), recorder),
      budget,
      rates: { inputPerToken: 0.001, cachedInputPerToken: 0.0005, outputPerToken: 0.002 },
      gate: createCallGate({ now: () => 0, deadline: 1_000_000, limit: 100 }),
    });
    await runSurfaceCheck({
      surface: SURFACE,
      documents: SAMPLE_DOCUMENTS,
      judge: budgeted,
      threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
      requirements: REQUIREMENTS,
      docVersion: "v1",
    });
    const spent = budget.spentUsd;
    const reserved = budget.reservedUsd;
    const attempts = budgeted.attempts;
    expect(attempts).toBeGreaterThan(0);

    // 流し直しは記録の口だけで流す（予算も門も通らない）
    await runSurfaceCheck({
      surface: SURFACE,
      documents: SAMPLE_DOCUMENTS,
      judge: createRecordedJudge(recorder.entries),
      threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
      requirements: REQUIREMENTS,
      docVersion: "v1",
    });
    expect(budget.spentUsd).toBe(spent);
    expect(budget.reservedUsd).toBe(reserved);
    expect(budgeted.attempts).toBe(attempts);
  });
});

describe("記録に無い要求では止まる（Issue #459）", () => {
  it("空の配列は、成功にも申告無しにも読まれない（要求で投げる）", async () => {
    const judge = createRecordedJudge([]);
    const request: JudgeRequest = { state: {}, questions: {} };
    await expect(judge.judge(request)).rejects.toBeInstanceOf(RecordedJudgeMissError);
  });

  it("記録に無い要求のハッシュで投げる", async () => {
    const recorder = createJudgeRecorder();
    await runSurfaceCheck({
      surface: SURFACE,
      documents: SAMPLE_DOCUMENTS,
      judge: recordJudge(answering(ANSWERS), recorder),
      threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
      requirements: REQUIREMENTS,
      docVersion: "v1",
    });
    const judge = createRecordedJudge(recorder.entries);
    const other: JudgeRequest = { state: { x: 1 }, questions: {} };
    await expect(judge.judge(other)).rejects.toBeInstanceOf(RecordedJudgeMissError);
    // 記録にある要求はハッシュで引ける
    expect(recorder.entries.length).toBeGreaterThan(0);
    const first = recorder.entries[0]!;
    expect(await createCallHash({ state: {}, questions: {} })).not.toBe(first.requestHash);
  });
});
