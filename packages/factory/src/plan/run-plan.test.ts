// Plan を 1 回流す口（plan/run-plan.ts）の unit テスト（04-plan-agent.md §2・§3・§6・§8・Issue #363）。
//
// **偽物の LLM・偽物の判定・偽物の答える役で回す。実 API は呼ばない。** ここで固定したいのは 6 つ。
//   1. 答える役が答えて、確定した仕様（`checkConfirmedPlan` が誤り 0・確認の SHA-256 が仕様と一致）まで進む
//   2. 「全部推奨で進める」で、推奨で閉じて確認に進む
//   3. 質問は往復をまたいで 10 問・3 往復を超えない。上限のあとも重大な未解決の事項が残れば「確定できない」
//   4. 確認で「やめる」なら「止まった」になり、確定した仕様を返さない
//   5. 予算が尽きると「止まった」になる。使った額に LLM と判定の費用が入る
//   6. 段ごとの記録が結果に入る
import { describe, expect, it } from "vitest";
import { checkConfirmedPlan, isConfirmationValid } from "@musunest/appspec-schema";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest, JudgeResponse } from "../judge.js";
import { AGENT_LIMITS } from "../limits.js";
import type { LlmClient, LlmUsage } from "../llm.js";
import { runPlan, type PlanAnswerRequest, type PlanResponder, type PlanRunInput } from "./run-plan.js";
import { CATALOG_FACETS, catalogAppliesQuestionName, catalogQuestionName } from "./catalog.js";
import { confirmQuestionName } from "./confirm.js";
import {
  createRecordingClient,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
} from "../stages/__tests__/prompt.js";
import { structured } from "../__tests__/run.js";

const RATES = { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 };

const noul = (value: number): JudgeAnswer => ({ kind: "noul", noul: value });

/** 目録の問い（要件 × 観点 × 2 問）すべてに「当てはまる・決まっている」を返す答え（未指定の観点を作らない） */
function catalogAnswers(): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {};
  for (const requirementId of ["R-1", "R-2"]) {
    for (const facet of CATALOG_FACETS) {
      answers[catalogAppliesQuestionName(requirementId, facet.id)] = noul(1);
      answers[catalogQuestionName(requirementId, facet.id)] = noul(1);
    }
  }
  return answers;
}

/** 覆いの問い（原文の文と、答え）に「覆われている」を返す答え */
function coverAnswers(answerId: string): Record<string, JudgeAnswer> {
  return {
    [confirmQuestionName("S-1")]: noul(0.95),
    [confirmQuestionName("S-2")]: noul(0.95),
    [confirmQuestionName(answerId)]: noul(0.9),
  };
}

/** 目録に無い曖昧さ 1 件（重大）を返す P3 の答え */
const SURFACE_OUTPUT = {
  ambiguities: [{ id: "OI-extra", requirementId: "R-1", text: "誰の分を数えるか", critical: true }],
  unwritable: [],
};

/** 曖昧さ 0 件の P3 の答え */
const SURFACE_OUTPUT_CLEAR = { ambiguities: [], unwritable: [] };

/** P4 の答え（未解決の事項 OI-extra 1 つに、選択肢 2 つ・推奨 1 つ・自由入力） */
const QUESTIONS_OUTPUT = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI-extra",
      text: "誰の分を数えるか",
      choices: [
        { id: "c1", text: "全員" },
        { id: "c2", text: "自分のみ" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
  ],
};

function makePlanInput(
  client: LlmClient,
  judge: Judge,
  responder: PlanResponder,
  overrides: Partial<PlanRunInput> = {},
): PlanRunInput {
  return {
    source: SOURCE_TEXT,
    documents: SAMPLE_DOCUMENTS,
    client,
    judge,
    responder,
    budgetUsd: 10,
    rates: RATES,
    now: () => 0,
    deadline: 60_000,
    effort: "low",
    planId: "plan-1",
    vocabularyVersion: "v1",
    confirmedBy: "tester",
    ...overrides,
  };
}

describe("Plan を 1 回流す（04 §2・§3・§6・§8）", () => {
  it("偽物の答える役が答えて、確定した仕様まで進む", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);
    const responder: PlanResponder = {
      async answer() {
        return { kind: "answers", answers: [{ id: "A-1", questionId: "Q-1", revision: 1, choiceId: "c1" }] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 確定した仕様は `checkConfirmedPlan` を通り、確認の SHA-256 が仕様と一致する（§4）
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    expect(await isConfirmationValid(result.plan)).toBe(true);
    expect(result.plan.confirmation.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 答えから増えた要件が、その答えを出どころにしている
    const added = result.plan.requirements.find((requirement) => requirement.id === "R:A-1");
    expect(added?.origin.input_id).toBe("A-1");
    // 段ごとの記録が結果に入る（生成の段の記録と同じ形）
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "requirements",
      "surface",
      "catalog",
      "questions",
      "answers",
      "confirm",
    ]);
    expect(result.stages.every((stage) => typeof stage.duration_ms === "number")).toBe(true);
    // 使った額に LLM の費用が入る
    expect(result.spentUsd).toBeGreaterThan(0);
    // 答える役が受け取った残りは、上限の内側である
    expect(result.remainingUsd).toBeGreaterThan(0);
  });

  it("「全部推奨で進める」で、推奨で閉じて確認に進む", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);
    const responder: PlanResponder = {
      async answer() {
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 未解決の事項は、推奨で閉じている
    const resolved = result.plan.open_issues.find((issue) => issue.id === "OI-extra");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolution?.answer_id).toBe("A:Q-1");
    // 推奨の選択肢（c1）を選んだ答えが、入力に残る
    const answer = result.plan.inputs.find((input) => input.kind === "answer" && input.id === "A:Q-1");
    expect(answer?.kind === "answer" ? answer.choice_id : undefined).toBe("c1");
  });

  it("質問は往復をまたいで上限を超えず、重大な未解決の事項が残れば「確定できない」になる", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);
    const asked: PlanAnswerRequest[] = [];
    const responder: PlanResponder = {
      async answer(request) {
        asked.push(request);
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge(catalogAnswers());

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 重大な未解決の事項が残っている
    expect(result.openIssues.map((issue) => issue.id)).toEqual(["OI-extra"]);
    // 往復は 3 回まで（4 回目の質問は出さない）
    expect(asked).toHaveLength(AGENT_LIMITS.planRoundTrips);
    expect(result.stages.filter((stage) => stage.stage === "questions")).toHaveLength(AGENT_LIMITS.planRoundTrips);
    // 合わせて 10 問まで（出した問いはその内側）
    const totalAsked = asked.reduce((total, request) => total + request.questions.length, 0);
    expect(totalAsked).toBeLessThanOrEqual(AGENT_LIMITS.planQuestions);
    // 残りは往復ごとに減り、上限の内側である
    expect(asked.map((request) => request.remaining.roundTrips)).toEqual([3, 2, 1]);
    expect(asked.every((request) => request.remaining.questions <= AGENT_LIMITS.planQuestions)).toBe(true);
  });

  it("確認で「やめる」なら「止まった」になり、確定した仕様を返さない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const responder: PlanResponder = {
      async answer() {
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "stop";
      },
    };
    const judge = createFakeJudge(catalogAnswers());

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("declined");
    expect(result.failure).toBeNull();
    // 確定した仕様を返さない（`kind` が `confirmed` ではない）
    expect("plan" in result).toBe(false);
  });

  it("予算が尽きると「止まった」になる。使った額に LLM と判定の費用が入る", async () => {
    // 判定が返す usage を大きくして、目録の点検のあとで予算を使い切る（LLM と判定の両方を使う）
    const hugeUsage: LlmUsage = {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const hugeJudge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        const answers: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) answers[name] = noul(1);
        return { answers, inputTokens: 1_000, usage: hugeUsage, model: "judge", answeredBy: "llm" };
      },
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
    ]);
    const responder: PlanResponder = {
      async answer() {
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(makePlanInput(recording.client, hugeJudge, responder, { budgetUsd: 1 }));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("budget");
    // 判定の費用が入る
    expect(result.judge.cost_usd).toBeGreaterThan(0);
    // 使った額は、判定の費用より大きい（LLM の費用も入っている）
    expect(result.spentUsd).toBeGreaterThan(result.judge.cost_usd);
    // 予算を使い切っている（残りが無い）
    expect(result.remainingUsd).toBeLessThanOrEqual(0);
  });
});
