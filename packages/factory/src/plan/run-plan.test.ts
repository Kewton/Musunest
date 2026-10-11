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
import { planStopReasonLine } from "../cli-plan.js";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest, JudgeResponse } from "../judge.js";
import { AGENT_LIMITS } from "../limits.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmUsage,
} from "../llm.js";
import type { RecordedCall } from "../llm-fake.js";
import {
  planDiagnosisCode,
  planDiagnosisField,
  runPlan,
  sessionCannotConfirmReason,
  type PlanAnswerRequest,
  type PlanResponder,
  type PlanRunInput,
} from "./run-plan.js";
import type { PlanTurn } from "./session.js";
import {
  CATALOG_FACETS,
  catalogAppliesQuestionName,
  catalogGateQuestionName,
  catalogQuestionName,
} from "./catalog.js";
import { confirmQuestionName } from "./confirm.js";
import { freeTextQuestionName } from "./answers.js";
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

/**
 * 目録の問い（要件ごとの門 + 要件 × 観点 × 2 問）すべてに「当てはまる・決まっている」を返す答え
 * （未指定の観点を作らない）。門にも答える（Issue #384）。
 */
function catalogAnswers(): Record<string, JudgeAnswer> {
  return catalogAnswersFor(["R-1", "R-2"]);
}

/** 指定した要件の目録の問い（門 + 要件 × 観点 × 2 問）すべてに「当てはまる・決まっている」を返す */
function catalogAnswersFor(requirementIds: readonly string[]): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {};
  for (const requirementId of requirementIds) {
    answers[catalogGateQuestionName(requirementId)] = noul(1);
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

/** 複数の答えの覆いの問いに「覆われている」を返す答え */
function coverAnswersFor(answerIds: readonly string[]): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {
    [confirmQuestionName("S-1")]: noul(0.95),
    [confirmQuestionName("S-2")]: noul(0.95),
  };
  for (const answerId of answerIds) answers[confirmQuestionName(answerId)] = noul(0.9);
  return answers;
}

/** 目録に無い曖昧さ 10 件（すべて重大）を返す P3 の答え（上限のちょうど内側） */
const TEN_ISSUES_SURFACE = {
  ambiguities: Array.from({ length: 10 }, (_value, index) => ({
    id: `OI-${index + 1}`,
    requirementId: "R-1",
    text: `曖昧 ${index + 1}`,
    critical: true,
  })),
  unwritable: [],
};

/** 10 件の重大な事項に 1 問ずつ（選択肢 2 つ・推奨・自由入力）を返す P4 の答え */
const TEN_QUESTIONS = {
  questions: Array.from({ length: 10 }, (_value, index) => ({
    id: `Q-${index + 1}`,
    openIssueId: `OI-${index + 1}`,
    text: `問い ${index + 1}`,
    choices: [
      { id: "c1", text: "こちら" },
      { id: "c2", text: "あちら" },
    ],
    recommended: { choiceId: "c1", reason: "依頼に沿う" },
    allowFreeText: true,
  })),
};

/** 開いている事項があるのに 0 問を返す P4 の答え（やり直しの対象） */
const ZERO_QUESTIONS = { questions: [] };

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

/** 同じことを聞く重大な事項 2 件を返す P3 の答え（Issue #370） */
const SAME_ISSUES_SURFACE = {
  ambiguities: [
    { id: "OI-a", requirementId: "R-1", text: "誰の分を数えるか", critical: true },
    { id: "OI-b", requirementId: "R-1", text: "誰の分を数えるか（同じ問い）", critical: true },
  ],
  unwritable: [],
};

/** 2 件の事項を 1 問で閉じる P4 の答え（主の OI-a と、一緒に閉じる OI-b。Issue #370） */
const GROUPED_QUESTIONS = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI-a",
      alsoCloses: ["OI-b"],
      text: "誰の分を数えますか",
      choices: [
        { id: "c1", text: "全員" },
        { id: "c2", text: "自分のみ" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
  ],
};

/** 矛盾のあとの往復で使う P4 の答え（OI-a・OI-b と、矛盾から生まれた事項の 2 問） */
const GROUPED_QUESTIONS_AFTER_CONTRADICTION = {
  questions: [
    ...GROUPED_QUESTIONS.questions,
    {
      id: "Q-2",
      openIssueId: "OI:contradiction:A-1",
      alsoCloses: [],
      text: "前の答えを保ちますか",
      choices: [
        { id: "keep", text: "保つ" },
        { id: "use-new", text: "新しい答えを使う" },
      ],
      recommended: { choiceId: "keep", reason: "前の答えを保つ" },
      allowFreeText: true,
    },
  ],
};

/** 依頼文で決まっている事項 1 件を返す P3 の答え（Issue #370） */
const SOURCE_CLOSURE_SURFACE = {
  ambiguities: [{ id: "OI-c", requirementId: "R-1", text: "誰の分を数えるか", critical: true }],
  unwritable: [],
};

/** 依頼文の引用で、唯一の事項を聞かずに閉じる P4 の答え（Issue #370） */
const SOURCE_CLOSURE_QUESTIONS = {
  questions: [],
  closedBySource: [{ issueId: "OI-c", quote: "タスクを記録する", value: "記録する内容を 1 行にする" }],
};

/** 依頼の枠の文を 1 文持つ原文（枠の文は要件にしない。Issue #372） */
const FRAMING_SOURCE = "アプリを作ってください。タスクを記録する。件数を合計する。";

/** 原文から引用の位置を求める（枠の文の試験のため） */
function spanOf(source: string, quote: string): { readonly start: number; readonly end: number } {
  const start = source.indexOf(quote);
  return { start, end: start + quote.length };
}

/** 枠の文を持つ ① の答え（枠の文は framing に入れ、要件にはしない。Issue #372） */
const FRAMING_REQUIREMENT_LIST_OUTPUT = {
  requirements: [
    {
      id: "R-1",
      text: "タスクを記録できる",
      quote: "タスクを記録する",
      position: spanOf(FRAMING_SOURCE, "タスクを記録する"),
    },
    {
      id: "R-2",
      text: "件数を合計できる",
      quote: "件数を合計する",
      position: spanOf(FRAMING_SOURCE, "件数を合計する"),
    },
  ],
  framing: [{ quote: "アプリを作ってください", position: spanOf(FRAMING_SOURCE, "アプリを作ってください") }],
  decisions: ["記録の形は 1 行とした"],
  unresolved: [],
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

  it("重大な事項が 10 件以下なら、偽物の答える役が推奨で答えて確定まで進む", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(TEN_ISSUES_SURFACE),
      structured(TEN_QUESTIONS),
    ]);
    const responder: PlanResponder = {
      async answer() {
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswersFor(Array.from({ length: 10 }, (_value, index) => `A:Q-${index + 1}`)),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 10 件の重大な事項が、すべて推奨で閉じている（1 問も取りこぼさない）
    expect(result.plan.open_issues.every((issue) => issue.status === "resolved")).toBe(true);
    // 10 問ぶんの答えが入力に残る（残りの問数 10 の内側で、重大なものをすべて聞く）
    expect(result.plan.inputs.filter((input) => input.kind === "answer")).toHaveLength(10);
  });

  it("開いている事項があるのに P4 が 0 問を返したとき、やり直しになり、黙って「確定できない」にならない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(ZERO_QUESTIONS),
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

    // 0 問の応答で「確定できない」にせず、やり直して問いを出し、確定まで進む
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-extra")?.status).toBe("resolved");
  });

  // ── 同じことを聞く事項を 1 問でまとめて閉じる（Issue #370）──────────────

  it("同じことを聞く重大な事項 2 件が 1 問で閉じ、通常の答えの道で 2 件が同じ答えを指して確定まで進む", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SAME_ISSUES_SURFACE),
      structured(GROUPED_QUESTIONS),
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
    const issues = result.plan.open_issues.filter((issue) => issue.id === "OI-a" || issue.id === "OI-b");
    expect(issues).toHaveLength(2);
    // 2 件とも、同じ答えの ID で閉じている
    expect(issues.map((issue) => issue.resolution?.answer_id)).toEqual(["A-1", "A-1"]);
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
  });

  it("同じことを聞く重大な事項 2 件が 1 問で閉じ、「全部推奨で進める」の道でも 2 件が同じ答えを指して確定まで進む", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SAME_ISSUES_SURFACE),
      structured(GROUPED_QUESTIONS),
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
    const issues = result.plan.open_issues.filter((issue) => issue.id === "OI-a" || issue.id === "OI-b");
    expect(issues.map((issue) => issue.resolution?.answer_id)).toEqual(["A:Q-1", "A:Q-1"]);
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
  });

  it("答えが矛盾して問いが閉じないとき、一緒に閉じる一覧の事項も開いたまま", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SAME_ISSUES_SURFACE),
      structured(GROUPED_QUESTIONS),
      structured(GROUPED_QUESTIONS_AFTER_CONTRADICTION),
      structured(GROUPED_QUESTIONS_AFTER_CONTRADICTION),
    ]);
    let round = 0;
    const responder: PlanResponder = {
      async answer() {
        round += 1;
        if (round === 1) {
          return {
            kind: "answers",
            answers: [{ id: "A-1", questionId: "Q-1", revision: 1, freeText: "全員で数える" }],
          };
        }
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      [freeTextQuestionName("A-1")]: {
        kind: "choice",
        choice: "contradiction",
        probabilities: undefined,
        probability: undefined,
        confidence: 0.9,
      },
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    const openIds = result.openIssues.map((issue) => issue.id);
    // 矛盾で閉じなかったので、主の OI-a も一緒に閉じる OI-b も開いたまま
    expect(openIds).toContain("OI-a");
    expect(openIds).toContain("OI-b");
  });

  // ── 依頼文で決まっている事項を、聞かずに閉じる（Issue #370）──────────────

  /** 依頼文で唯一の事項を閉じる流れを 1 回まわす（答える役が呼ばれた回数も返す） */
  async function runSourceClosure(): Promise<{ result: Awaited<ReturnType<typeof runPlan>>; answerCalls: number }> {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SOURCE_CLOSURE_SURFACE),
      structured(SOURCE_CLOSURE_QUESTIONS),
    ]);
    let answerCalls = 0;
    const responder: PlanResponder = {
      async answer() {
        answerCalls += 1;
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswersFor([]) });
    const result = await runPlan(makePlanInput(recording.client, judge, responder));
    return { result, answerCalls };
  }

  it("依頼文で閉じた事項が decisions に入り、事項の解決の根拠がその ID を指し、checkConfirmedPlan の誤りが 0", async () => {
    const { result } = await runSourceClosure();

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    const issue = result.plan.open_issues.find((one) => one.id === "OI-c");
    expect(issue?.status).toBe("resolved");
    const decisionId = issue?.resolution?.decision_id;
    expect(decisionId).toBeDefined();
    const decision = result.plan.decisions.find((one) => one.id === decisionId);
    expect(decision?.value).toBe("記録する内容を 1 行にする");
    expect(decision?.reason).toBe("タスクを記録する");
    expect(result.closedBySource).toEqual([
      { issueId: "OI-c", quote: "タスクを記録する", value: "記録する内容を 1 行にする" },
    ]);
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
  });

  it("開いている事項がすべて依頼文で閉じたとき、答える役が呼ばれず、問数と往復が 0 のまま確認に進む", async () => {
    const { result, answerCalls } = await runSourceClosure();

    expect(result.kind).toBe("confirmed");
    // 答える役は 1 度も呼ばれない（問いを 0 問で確認に進む）
    expect(answerCalls).toBe(0);
    // 答えの段は 1 度も走らない（問数を消費しない）
    expect(result.stages.filter((stage) => stage.stage === "answers")).toHaveLength(0);
    if (result.kind !== "confirmed") return;
    expect(result.plan.open_issues.every((issue) => issue.status === "resolved")).toBe(true);
  });

  it("runPlan に渡した原文が、目録の点検の「決まっているか」の state に届く（Issue #376）", async () => {
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
        return "build";
      },
    };
    const inner = createFakeJudge({
      ...catalogAnswers(),
      [confirmQuestionName("S-1")]: noul(0.95),
      [confirmQuestionName("S-2")]: noul(0.95),
    });
    const requests: JudgeRequest[] = [];
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        requests.push(request);
        return inner.judge(request);
      },
    };

    await runPlan(makePlanInput(recording.client, judge, responder));

    const catalogRequest = requests.find((request) =>
      Object.keys(request.questions).includes(catalogQuestionName("R-1", "aggregation")),
    );
    // 原文が、目録の点検の state に届く
    expect(catalogRequest?.state).toMatchObject({ source: SOURCE_TEXT });
    // 対象の要件の文が、問いの欄に入る
    const specified = catalogRequest?.questions[catalogQuestionName("R-1", "aggregation")];
    expect(specified?.instructions).toMatchObject({ requirement: "タスクを記録できる" });
  });

  // ── 依頼の枠の文を要件にしない（Issue #372）───────────────────────────

  it("枠の文を持つ依頼文で、枠の文を要件にしないまま P6 の照合を通って確定し、確定した仕様に framing も枠の要件も入らない", async () => {
    const recording = createRecordingClient([
      structured(FRAMING_REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const responder: PlanResponder = {
      async answer() {
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      [confirmQuestionName("S-1")]: noul(0.9),
      [confirmQuestionName("S-2")]: noul(0.95),
      [confirmQuestionName("S-3")]: noul(0.95),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder, { source: FRAMING_SOURCE }));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 枠の文は要件にしないので、要件は R-1・R-2 のまま（枠の要件が増えない）
    expect(result.plan.requirements.map((requirement) => requirement.id)).toEqual(["R-1", "R-2"]);
    // 確定した仕様に framing は入らない（`@musunest/appspec-schema` の型を変えない）
    expect(Object.keys(result.plan)).not.toContain("framing");
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
  });

  // ── 要件の位置をコードが引用から求める（Issue #382）────────────────────

  it("位置がずれた（引用は正しい）要件の偽物の応答で、Plan が確定し、確定した仕様の要件の出どころが正しい位置を指す", async () => {
    const shifted = {
      ...REQUIREMENT_LIST_OUTPUT,
      requirements: REQUIREMENT_LIST_OUTPUT.requirements.map((requirement) => ({
        ...requirement,
        position: { start: requirement.position.start + 1, end: requirement.position.end + 1 },
      })),
    };
    const recording = createRecordingClient([
      structured(shifted),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const responder: PlanResponder = {
      async answer() {
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      [confirmQuestionName("S-1")]: noul(0.95),
      [confirmQuestionName("S-2")]: noul(0.95),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 出どころが、直した位置の指す原文の文（S-1・S-2）を指す
    expect(result.plan.requirements.find((requirement) => requirement.id === "R-1")?.origin.input_id).toBe("S-1");
    expect(result.plan.requirements.find((requirement) => requirement.id === "R-2")?.origin.input_id).toBe("S-2");
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
  });

  it("原文に無い引用（言い換え）の要件が残ると、Plan が確定しない", async () => {
    const paraphrase = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "タスクを登録する", position: { start: 0, end: 8 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する", position: { start: 9, end: 16 } },
      ],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(paraphrase),
      structured(REVERSE_CHECK_OUTPUT),
      structured(paraphrase),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const responder: PlanResponder = {
      async answer() {
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge(catalogAnswers());

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    // 引用の落ちが残ったまま確定しない
    expect(result.kind).not.toBe("confirmed");
    if (result.kind !== "cannot-confirm") return;
    expect(result.openIssues.some((issue) => issue.text.includes("原文に見つからない"))).toBe(true);
  });
});

// ── Issue #397：Plan が止まった理由を、値を含めずに記録と入口の出力に残す ──────────

const ANSWER_NONE: PlanResponder = {
  async answer() {
    return { kind: "answers", answers: [] };
  },
  async confirm() {
    return "build";
  },
};

const ALL_RECOMMENDED: PlanResponder = {
  async answer() {
    return { kind: "all-recommended" };
  },
  async confirm() {
    return "build";
  },
};

/** api の誤りを模す（種類だけを持つ。本文は残さない） */
function invalidRequestError(code: string, message = "要求が不正です"): Error {
  return Object.assign(new Error(message), { kind: "invalidRequest", code });
}

/** 未完了の応答を模す（理由だけを持つ） */
function incompleteError(reason: string): Error {
  return Object.assign(new Error("応答が完了していません"), { kind: "incomplete", reason, usage: undefined });
}

/** `failAt` 回目の構造化出力の呼び出しでだけ誤りを投げる偽物の呼び出し */
function clientThrowingAt(
  recorded: readonly RecordedCall[],
  failAt: number,
  makeError: () => Error,
): LlmClient {
  const inner = createRecordingClient(recorded);
  let calls = 0;
  return {
    async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
      calls += 1;
      if (calls === failAt) throw makeError();
      return inner.client.callStructured<T>(request);
    },
    async callWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
      return inner.client.callWithTools(request);
    },
  };
}

/** 3 文の原文（R-1・R-2 が最初の 2 文だけを覆う） */
const THREE_SOURCE = "タスクを記録する。件数を合計する。印を出す。";
const THREE_REQUIREMENTS = {
  requirements: [
    { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する。", position: { start: 0, end: 9 } },
    { id: "R-2", text: "件数を合計できる", quote: "件数を合計する。", position: { start: 9, end: 17 } },
  ],
  framing: [],
  decisions: [],
  unresolved: [],
};
const THREE_COVER: Record<string, JudgeAnswer> = {
  [confirmQuestionName("S-1")]: noul(0.95),
  [confirmQuestionName("S-2")]: noul(0.95),
  [confirmQuestionName("S-3")]: noul(0.95),
};

describe("Plan が止まった理由を、値を含めずに残す（Issue #397）", () => {
  it("P3 で文書に無い制約 ID・空の制約 ID で止まると、failure.problems に添字つきの欄と分類が残る", async () => {
    const badSurface = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: ["文書に無い ID"], reason: "理由", alternative: "代案" },
        { id: "U-2", requirementId: "R-2", part: "部分", constraintIds: [], reason: "理由", alternative: "代案" },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(badSurface),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge(catalogAnswers()), ANSWER_NONE));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface");
    expect(result.failure?.kind).toBe("unmet");
    expect(result.failure?.problems).toEqual([
      { field: "unwritable[0].constraintIds", code: "constraint-id-unknown" },
      { field: "unwritable[1].constraintIds", code: "constraint-id-missing" },
    ]);
  });

  it("P4 の形の誤りで止まると、分類が残る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured({ questions: "並びでない" }),
      structured({ questions: "並びでない" }),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge(catalogAnswers()), ANSWER_NONE));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("questions");
    expect(result.failure?.kind).toBe("malformed");
    expect(result.failure?.problems).toEqual([{ field: "questions", code: "shape" }]);
  });

  it("P6 で覆われていない原文があると、cannot-confirm の理由に source: confirm で残る", async () => {
    const recording = createRecordingClient([
      structured(THREE_REQUIREMENTS),
      structured(REVERSE_CHECK_OUTPUT),
      structured(THREE_REQUIREMENTS),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);

    const result = await runPlan(
      makePlanInput(recording.client, createFakeJudge({ ...catalogAnswers(), ...THREE_COVER }), ANSWER_NONE, {
        source: THREE_SOURCE,
      }),
    );

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([{ source: "confirm", code: "uncovered-source", path: "source[2]" }]);
  });

  it("確定した仕様の形の誤りは、cannot-confirm の理由に source: plan-check で残る", async () => {
    const surface = {
      ambiguities: [
        { id: "OI-a", requirementId: "R-1", text: "問い a", critical: true },
        { id: "OI-b", requirementId: "R-1", text: "問い b", critical: false },
      ],
      unwritable: [],
    };
    const questions = {
      questions: [
        {
          id: "Q-a",
          openIssueId: "OI-a",
          text: "問い a",
          choices: [
            { id: "c1", text: "こちら" },
            { id: "c2", text: "あちら" },
          ],
          recommended: { choiceId: "c1", reason: "依頼に沿う" },
          allowFreeText: true,
        },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(questions),
    ]);

    const result = await runPlan(
      makePlanInput(recording.client, createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q-a") }), ALL_RECOMMENDED),
    );

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 重大でない事項 OI-b が開いたまま（open_issue）。P6 の中の検査と外側の検査の重なりは 1 件にまとまる
    expect(result.reasons).toEqual([{ source: "plan-check", code: "open_issue", path: "open_issues[1].status" }]);
  });

  it("path が違う同じ code は別件として残る（重なりは 1 件にまとめる）", async () => {
    const surface = {
      ambiguities: [
        { id: "OI-a", requirementId: "R-1", text: "問い a", critical: false },
        { id: "OI-b", requirementId: "R-1", text: "問い b", critical: false },
        { id: "OI-c", requirementId: "R-2", text: "問い c", critical: true },
      ],
      unwritable: [],
    };
    const questions = {
      questions: [
        {
          id: "Q-c",
          openIssueId: "OI-c",
          text: "問い c",
          choices: [
            { id: "c1", text: "こちら" },
            { id: "c2", text: "あちら" },
          ],
          recommended: { choiceId: "c1", reason: "依頼に沿う" },
          allowFreeText: true,
        },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(questions),
    ]);

    const result = await runPlan(
      makePlanInput(recording.client, createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q-c") }), ALL_RECOMMENDED),
    );

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    const planCheck = result.reasons.filter((reason) => reason.source === "plan-check");
    expect(planCheck).toHaveLength(2);
    expect(planCheck.map((reason) => reason.code)).toEqual(["open_issue", "open_issue"]);
    expect(planCheck.map((reason) => reason.path)).toEqual([
      "open_issues[0].status",
      "open_issues[1].status",
    ]);
  });

  it("逆照合の落ちは source: reverse-check として残る", async () => {
    const paraphrase = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "タスクを登録する", position: { start: 0, end: 8 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する", position: { start: 9, end: 16 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(paraphrase),
      structured(REVERSE_CHECK_OUTPUT),
      structured(paraphrase),
      structured(REVERSE_CHECK_OUTPUT),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge({}), ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([
      { source: "reverse-check", code: "quote-not-found", path: "requirements[*].quote" },
    ]);
  });

  it("往復の制御の落ちは source: session として、reverse-check と区別できる", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge(catalogAnswers()), ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([{ source: "session", code: "round-trip-limit", path: "open_issues" }]);
  });

  it("往復の制御の理由は、質問数の上限・往復数の上限・重大な事項があるのに問いが無い、で区別できる", () => {
    const question = (id: string) => ({
      id,
      openIssueId: "OI",
      revision: 1,
      text: "問い",
      choices: [
        { id: "c1", text: "こちら" },
        { id: "c2", text: "あちら" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    });
    const turnWith = (count: number): PlanTurn => ({
      questions: Array.from({ length: count }, (_value, index) => question(`Q-${index}`)),
      answers: [],
    });
    expect(sessionCannotConfirmReason([turnWith(AGENT_LIMITS.planQuestions)]).code).toBe("question-limit");
    expect(
      sessionCannotConfirmReason([
        turnWith(1),
        turnWith(1),
        turnWith(1),
      ]).code,
    ).toBe("round-trip-limit");
    expect(sessionCannotConfirmReason([turnWith(1)]).code).toBe("critical-no-question");
    expect(sessionCannotConfirmReason([turnWith(1)]).source).toBe("session");
  });

  it("P1/P2 の各呼び出しで止まると、operation と有限の分類が残る", async () => {
    // 要件にする（依頼文が長すぎる＝打ち切り）
    const long = "あ".repeat(AGENT_LIMITS.requestTextChars + 1);
    const limitRun = await runPlan(
      makePlanInput(createRecordingClient([]).client, createFakeJudge({}), ANSWER_NONE, { source: long }),
    );
    expect(limitRun.kind).toBe("stopped");
    if (limitRun.kind === "stopped") {
      expect(limitRun.failure).toEqual({
        stage: "requirements",
        kind: "limit",
        problems: [{ field: "limit", code: "limit-request-text" }],
        operation: "requirements",
      });
    }

    // 逆照合（① は通り、①' で要求の誤り）
    const reverseCheck = await runPlan(
      makePlanInput(
        clientThrowingAt([structured(REQUIREMENT_LIST_OUTPUT)], 2, () => invalidRequestError("invalid_json_schema")),
        createFakeJudge({}),
        ANSWER_NONE,
      ),
    );
    expect(reverseCheck.kind).toBe("stopped");
    if (reverseCheck.kind === "stopped") {
      expect(reverseCheck.failure?.operation).toBe("reverse-check");
      expect(reverseCheck.failure?.problems).toEqual([
        { field: "invalidRequest.code", code: "invalid_json_schema" },
      ]);
    }

    // 要件にするのやり直し（①' で落ちが出て、① の 2 回目で要求の誤り）
    const redo = await runPlan(
      makePlanInput(
        clientThrowingAt([structured(THREE_REQUIREMENTS), structured(REVERSE_CHECK_OUTPUT)], 3, () =>
          invalidRequestError("invalid_json_schema"),
        ),
        createFakeJudge({}),
        ANSWER_NONE,
        { source: THREE_SOURCE },
      ),
    );
    expect(redo.kind).toBe("stopped");
    if (redo.kind === "stopped") expect(redo.failure?.operation).toBe("requirements-redo");

    // 逆照合のやり直し（①' の 2 回目で要求の誤り）
    const redoReverse = await runPlan(
      makePlanInput(
        clientThrowingAt(
          [structured(THREE_REQUIREMENTS), structured(REVERSE_CHECK_OUTPUT), structured(THREE_REQUIREMENTS)],
          4,
          () => invalidRequestError("invalid_json_schema"),
        ),
        createFakeJudge({}),
        ANSWER_NONE,
        { source: THREE_SOURCE },
      ),
    );
    expect(redoReverse.kind).toBe("stopped");
    if (redoReverse.kind === "stopped") expect(redoReverse.failure?.operation).toBe("reverse-check-redo");
  });

  it("一覧に無い分類・API の誤りの種類・打ち切りの理由は other になる", async () => {
    expect(planDiagnosisCode("知らない分類")).toBe("other");
    expect(planDiagnosisCode("shape")).toBe("shape");
    expect(planDiagnosisCode(undefined)).toBe("other");

    const unknownApi = await runPlan(
      makePlanInput(
        clientThrowingAt([], 1, () => invalidRequestError("知らない_api_code")),
        createFakeJudge({}),
        ANSWER_NONE,
      ),
    );
    expect(unknownApi.kind).toBe("stopped");
    if (unknownApi.kind === "stopped") {
      expect(unknownApi.failure?.problems).toEqual([{ field: "invalidRequest.code", code: "other" }]);
    }

    const unknownReason = await runPlan(
      makePlanInput(
        clientThrowingAt([], 1, () => incompleteError("知らない_reason")),
        createFakeJudge({}),
        ANSWER_NONE,
      ),
    );
    expect(unknownReason.kind).toBe("stopped");
    if (unknownReason.kind === "stopped") {
      expect(unknownReason.failure).toEqual({
        stage: "requirements",
        kind: "incomplete",
        problems: [{ field: "incomplete.reason", code: "other" }],
        operation: "requirements",
      });
    }
  });

  it("値が漏れない：API の誤りの種類と生の文は、診断と止まった理由の行に出ない", async () => {
    const apiMark = "MARK_API_CODE_QQQ";
    const messageMark = "MARK_MESSAGE_WWW";
    const result = await runPlan(
      makePlanInput(
        clientThrowingAt([], 1, () => invalidRequestError(apiMark, messageMark)),
        createFakeJudge({}),
        ANSWER_NONE,
      ),
    );

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(JSON.stringify(result.failure)).not.toContain(apiMark);
    expect(JSON.stringify(result.failure)).not.toContain(messageMark);
    expect(planStopReasonLine(result)).not.toContain(apiMark);
    expect(planStopReasonLine(result)).toContain("other");
  });

  it("値が漏れない：モデルの出力の ID は理由に出ないが、既存の欄（未解決の事項）は値を残す", async () => {
    const quoteMark = "MARK_QUOTE_ZZZ";
    const paraphrase = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: `${quoteMark}する`, position: { start: 0, end: quoteMark.length + 2 } },
        { id: "R-2", text: "合計できる", quote: "件数を合計する", position: { start: 9, end: 16 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(paraphrase),
      structured(REVERSE_CHECK_OUTPUT),
      structured(paraphrase),
      structured(REVERSE_CHECK_OUTPUT),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge({}), ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(JSON.stringify(result.reasons)).not.toContain(quoteMark);
    expect(planStopReasonLine(result)).not.toContain(quoteMark);
    // 既存の欄（未解決の事項の文）は、今までどおり値を残す
    expect(JSON.stringify(result.openIssues)).toContain(quoteMark);
  });

  it("値が漏れない：生の path は既知の欄と配列の位置から組み直される", () => {
    const pathMark = "MARK_PATH_EEE";
    expect(planDiagnosisField(`inputs.${pathMark}`)).not.toContain(pathMark);
    expect(planDiagnosisField(`inputs.${pathMark}`)).toBe("inputs.*");
    expect(planDiagnosisField("unwritable[0].constraintIds")).toBe("unwritable[0].constraintIds");
    expect(planDiagnosisField("open_issues[2].status")).toBe("open_issues[2].status");
  });

  it("値が漏れない：確定した仕様には、原文の目印が今までどおり残る", async () => {
    const sourceMark = "MARK_SOURCE_XYZ";
    const leakSource = `タスクを記録する。件数を合計する。${sourceMark}を出す。`;
    const s1 = "タスクを記録する。";
    const s2 = "件数を合計する。";
    const s3 = `${sourceMark}を出す。`;
    const pos = (quote: string) => {
      const start = leakSource.indexOf(quote);
      return { start, end: start + quote.length };
    };
    const leakList = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: s1, position: pos(s1) },
        { id: "R-2", text: "合計できる", quote: s2, position: pos(s2) },
        { id: "R-3", text: "印を出せる", quote: s3, position: pos(s3) },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(leakList),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswersFor(["R-1", "R-2", "R-3"]),
      [confirmQuestionName("S-1")]: noul(0.95),
      [confirmQuestionName("S-2")]: noul(0.95),
      [confirmQuestionName("S-3")]: noul(0.95),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE, { source: leakSource }));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 確定した仕様（既存の保存が認められた欄）には、原文の目印が残る
    expect(JSON.stringify(result.plan)).toContain(sourceMark);
    expect(planStopReasonLine(result)).toBe("");
  });
});
