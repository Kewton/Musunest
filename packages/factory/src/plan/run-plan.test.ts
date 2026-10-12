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
import { checkConfirmedPlan, isConfirmationValid, planDigest, type ConfirmedPlan, type PlanOpenIssue } from "@musunest/appspec-schema";
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
  type PlanResult,
  type PlanRunInput,
} from "./run-plan.js";
import type { PlanQuestion } from "./questions.js";
import type { PlanAnswerDraft } from "./answers.js";
import type { PlanConfirmationView, PlanTurn } from "./session.js";
import {
  CATALOG_FACETS,
  catalogAppliesQuestionName,
  catalogGateQuestionName,
  catalogQuestionName,
} from "./catalog.js";
import { confirmQuestionName } from "./confirm.js";
import { freeTextQuestionName } from "./answers.js";
import { surfaceSupportQuestionName, surfaceTriageQuestionName } from "./surface-check.js";
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

/** choice の答えを作る（確信度は任意） */
function choice(value: string, confidence?: number): JudgeAnswer {
  return { kind: "choice", choice: value, probabilities: undefined, probability: undefined, confidence };
}

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

/**
 * 目録の答え（Issue #408）。指定した要件の、指定した観点だけを「決まっていない」にし、ほかは
 * 「決まっている」にする。門は既定で「集計を含む」（1）。
 */
function catalogUnspecifiedFor(
  unspecified: Readonly<Record<string, readonly string[]>>,
  requirementIds: readonly string[] = ["R-1", "R-2"],
): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {};
  for (const requirementId of requirementIds) {
    answers[catalogGateQuestionName(requirementId)] = noul(1);
    const open = new Set(unspecified[requirementId] ?? []);
    for (const facet of CATALOG_FACETS) {
      answers[catalogAppliesQuestionName(requirementId, facet.id)] = noul(1);
      answers[catalogQuestionName(requirementId, facet.id)] = noul(open.has(facet.id) ? 0 : 1);
    }
  }
  return answers;
}

/** 未解決の事項 1 つへの正しい P4 の答え（選択肢 2 つ・推奨・自由入力） */
function questionsFor(issueId: string, id = "Q-1"): { readonly questions: readonly unknown[] } {
  return {
    questions: [
      {
        id,
        openIssueId: issueId,
        text: "どうしますか",
        choices: [
          { id: "c1", text: "こちら" },
          { id: "c2", text: "あちら" },
        ],
        recommended: { choiceId: "c1", reason: "依頼に沿う" },
        allowFreeText: true,
      },
    ],
  };
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
      openIssueId: "OI:contradiction:A:Q1-1",
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

/**
 * 問い 1 つに答える下書きを組む（答えの ID は**コードが組み直す**前提で、受け取った問いから組む。
 * Issue #405）。`id` は固定値にして、組み直しが効いていることを観測できるようにする。
 */
function answerTo(question: PlanQuestion | undefined, choiceId = "c1"): PlanAnswerDraft {
  return { id: "A-1", questionId: question?.id ?? "", revision: question?.revision ?? 1, choiceId };
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
      async answer(request) {
        // 質問 ID はコードが `Q<版>-<n>` に組み直す。答えの ID もコードが組み直す（Issue #405）
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q1-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 確定した仕様は `checkConfirmedPlan` を通り、確認の SHA-256 が仕様と一致する（§4）
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    expect(await isConfirmationValid(result.plan)).toBe(true);
    expect(result.plan.confirmation.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 答えから増えた要件が、組み直した答えの ID を出どころにしている
    const added = result.plan.requirements.find((requirement) => requirement.id === "R:A:Q1-1");
    expect(added?.origin.input_id).toBe("A:Q1-1");
    // 段ごとの記録が結果に入る（生成の段の記録と同じ形）。**目録の段が洗い出しより前**（Issue #419）。
    // **申告 0 件でも surface-check の段は `surface` の次に `ok` で残る**（Issue #432）
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "requirements",
      "catalog",
      "surface",
      "surface-check",
      "questions",
      "answers",
      "confirm",
    ]);
    // 申告 0 件なので、判定は呼ばれず、surface-check の段も `ok` である
    expect(result.stages.find((stage) => stage.stage === "surface-check")?.status).toBe("ok");
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
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q1-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 未解決の事項は、推奨で閉じている
    const resolved = result.plan.open_issues.find((issue) => issue.id === "OI-extra");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolution?.answer_id).toBe("A:Q1-1");
    // 推奨の選択肢（c1）を選んだ答えが、入力に残る
    const answer = result.plan.inputs.find((input) => input.kind === "answer" && input.id === "A:Q1-1");
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
      ...coverAnswersFor(Array.from({ length: 10 }, (_value, index) => `A:Q1-${index + 1}`)),
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
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q1-1") });

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
      async answer(request) {
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q1-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    const issues = result.plan.open_issues.filter((issue) => issue.id === "OI-a" || issue.id === "OI-b");
    expect(issues).toHaveLength(2);
    // 2 件とも、同じ（組み直した）答えの ID で閉じている
    expect(issues.map((issue) => issue.resolution?.answer_id)).toEqual(["A:Q1-1", "A:Q1-1"]);
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
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q1-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    const issues = result.plan.open_issues.filter((issue) => issue.id === "OI-a" || issue.id === "OI-b");
    expect(issues.map((issue) => issue.resolution?.answer_id)).toEqual(["A:Q1-1", "A:Q1-1"]);
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
      async answer(request) {
        round += 1;
        if (round === 1) {
          const question = request.questions[0];
          return {
            kind: "answers",
            answers: [
              {
                id: "A-1",
                questionId: question?.id ?? "",
                revision: question?.revision ?? 1,
                freeText: "全員で数える",
              },
            ],
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
      [freeTextQuestionName("A:Q1-1")]: {
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
    // 矛盾の再質問のような重大な事項は既定では閉じず、理由も今までの上限の分類を保つ（Issue #408）
    expect(result.closedByDefault).toEqual([]);
    expect(result.reasons).toEqual([{ source: "session", code: "round-trip-limit", path: "open_issues" }]);
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

  it("残りの問数に収まる重大でない事項を聞かない応答は、覆いの検査でやり直し、2 回続けば段の失敗になる（Issue #419）", async () => {
    const surface = {
      ambiguities: [
        { id: "OI-a", requirementId: "R-1", text: "問い a", critical: true },
        { id: "OI-b", requirementId: "R-1", text: "問い b", critical: false },
      ],
      unwritable: [],
    };
    // 重大な OI-a は聞くが、残り 10 問に収まる重大でない OI-b を聞かない応答
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
      // やり直しも同じ応答 → 2 回続くので段の失敗
      structured(questions),
    ]);

    const result = await runPlan(
      makePlanInput(recording.client, createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q1-1") }), ALL_RECOMMENDED),
    );

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("questions");
    expect(result.failure?.kind).toBe("malformed");
    expect(result.failure?.problems).toEqual([{ field: "questions", code: "question-coverage" }]);
  });

  it("残りの問数に全事項が収まらない設定で、重大でない事項だけが残れば cannot-confirm（noncritical-without-default）になり、P6 を呼ばない（Issue #408・#419）", async () => {
    // 開いている事項 11 件（すべて重大でない）が、残りの問数 10 に収まらない
    const surface = {
      ambiguities: Array.from({ length: 11 }, (_value, index) => ({
        id: `OI-${index + 1}`,
        requirementId: "R-1",
        text: `問い ${index + 1}`,
        critical: false,
      })),
      unwritable: [],
    };
    // P4 は残りの問数の範囲で 10 件を聞く（覆いは収まらないので重大だけでよい）
    const questions = {
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
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(questions),
    ]);

    const result = await runPlan(
      makePlanInput(recording.client, createFakeJudge({ ...catalogAnswers(), ...coverAnswersFor([]) }), ANSWER_NONE),
    );

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 重大でない事項だけが既定の無いまま残った
    expect(result.reasons).toEqual([{ source: "session", code: "noncritical-without-default", path: "open_issues" }]);
    // P6（confirm の段）を呼ばない
    expect(result.stages.some((stage) => stage.stage === "confirm")).toBe(false);
  });

  it("重大な事項が残れば、既存の上限の分類を保つ（noncritical-without-default に置き換えない）", async () => {
    const surface = {
      ambiguities: [
        { id: "OI-a", requirementId: "R-1", text: "問い a", critical: true },
        { id: "OI-b", requirementId: "R-1", text: "問い b", critical: false },
      ],
      unwritable: [],
    };
    // 重大な OI-a と重大でない OI-b の両方を聞く（残り 10 問に収まるので全部を覆う。Issue #419）。
    // 答える役は答えないので、どちらも閉じずに上限まで往復して残る
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
        {
          id: "Q-b",
          openIssueId: "OI-b",
          text: "問い b",
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
      structured(questions),
      structured(questions),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge(catalogAnswers()), ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 重大な事項が残っているので、理由の分類は今までの上限の分類（往復の上限）のまま
    expect(result.reasons).toEqual([{ source: "session", code: "round-trip-limit", path: "open_issues" }]);
    expect(result.openIssues.map((issue) => issue.id)).toContain("OI-a");
    // P6（confirm の段）を呼ばない
    expect(result.stages.some((stage) => stage.stage === "confirm")).toBe(false);
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

  it("往復の制御の理由は、質問数の上限・往復数の上限・重大な事項があるのに問いが無い・重大でない事項だけ、で区別できる", () => {
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
    const critical: PlanOpenIssue = { id: "OI", text: "重大な事項", critical: true, status: "open" };
    const noncritical: PlanOpenIssue = { id: "OI", text: "重大でない事項", critical: false, status: "open" };
    expect(sessionCannotConfirmReason([turnWith(AGENT_LIMITS.planQuestions)], [critical]).code).toBe(
      "question-limit",
    );
    expect(
      sessionCannotConfirmReason([turnWith(1), turnWith(1), turnWith(1)], [critical]).code,
    ).toBe("round-trip-limit");
    expect(sessionCannotConfirmReason([turnWith(1)], [critical]).code).toBe("critical-no-question");
    expect(sessionCannotConfirmReason([turnWith(1)], [critical]).source).toBe("session");
    // 残った事項が重大でないものだけなら `noncritical-without-default`（Issue #408）
    expect(sessionCannotConfirmReason([turnWith(1)], [noncritical]).code).toBe("noncritical-without-default");
    // 重大な事項が 1 つでも混ざれば、今までの分類を保つ
    expect(sessionCannotConfirmReason([turnWith(1)], [critical, noncritical]).code).toBe("critical-no-question");
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

// ── 制約 ID の正規化（確認の前・SHA を計算する前。Issue #398）──────────────────

/** P3 の申告（書けない）に、記号つきの見出しを制約 ID として使う */
const SURFACE_UNWRITABLE_SYMBOL = {
  ambiguities: [],
  unwritable: [
    {
      id: "U-1",
      requirementId: "R-2",
      part: "補助の値の並べ替え",
      constraintIds: ["### computed"],
      reason: "宣言に欄が無い",
      alternative: "題名を画面の見出しとして置く",
    },
  ],
};

/** 確定した Plan の根拠の ID だけを差し替え、SHA を計算し直す（保存されていた Plan を模す） */
async function withConstraintId(plan: ConfirmedPlan, id: string): Promise<ConfirmedPlan> {
  const accepted_unwritable = plan.accepted_unwritable.map((entry) => ({
    ...entry,
    basis: { ...entry.basis, constraint_id: id },
  }));
  const sha256 = await planDigest({ ...plan, accepted_unwritable });
  return { ...plan, accepted_unwritable, confirmation: { ...plan.confirmation, sha256 } };
}

/** 記号つきの見出しを根拠にした Plan を、確認まで進めて返す */
async function planWithSymbolConstraint(): Promise<{
  readonly result: PlanResult;
  readonly views: readonly PlanConfirmationView[];
}> {
  const recording = createRecordingClient([
    structured(REQUIREMENT_LIST_OUTPUT),
    structured(REVERSE_CHECK_OUTPUT),
    structured(SURFACE_UNWRITABLE_SYMBOL),
  ]);
  const views: PlanConfirmationView[] = [];
  const responder: PlanResponder = {
    async answer() {
      return { kind: "answers", answers: [] };
    },
    async confirm(view) {
      views.push(view);
      return "build";
    },
  };
  const judge = createFakeJudge({
    ...catalogAnswers(),
    ...coverAnswersFor([]),
    // 申告 1 件を、語彙の穴で裏付けありと点検する（Issue #432。点検の答えを足すだけで緑）
    [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
    [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
  });
  const result = await runPlan(makePlanInput(recording.client, judge, responder));
  return { result, views };
}

describe("制約 ID の正規化（確認の前・SHA を計算する前。Issue #398）", () => {
  it("P3 の申告の根拠と、確認の役が受け取る根拠が、正規化後の ID になる", async () => {
    const { result, views } = await planWithSymbolConstraint();
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 確定した Plan の根拠は正規化後（### computed → computed）
    expect(result.plan.accepted_unwritable[0]?.basis.constraint_id).toBe("computed");
    // 確認の役が受け取る根拠も正規化後
    expect(views[0]?.unwritable[0]?.basis.constraint_id).toBe("computed");
    // 確定した同じ Plan が、確定した仕様の検査を通り、内容と SHA が一致する（Build へ渡るもの）
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    expect(await isConfirmationValid(result.plan)).toBe(true);
    expect(result.plan.confirmation.sha256).toBe(await planDigest(result.plan));
  });

  it("確定済みの記号つきの ID を持つ Plan を読み込んでも、元の内容と保存した内容を書き換えない", async () => {
    const { result } = await planWithSymbolConstraint();
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 「保存されていた」Plan（記号つきの ID と、それに合う SHA）を作る
    const saved = await withConstraintId(result.plan, "### computed");
    const before = JSON.stringify(saved);
    expect(await checkConfirmedPlan(saved)).toEqual([]);
    expect(await isConfirmationValid(saved)).toBe(true);
    // 読み込んでも書き換えない（元の内容も、保存した内容も）
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("確認のあとに ID を変えた Plan は、確認が失効する", async () => {
    const { result } = await planWithSymbolConstraint();
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    const saved = await withConstraintId(result.plan, "### computed");
    // 確認のあとに ID だけを変える（SHA は計算し直さない）
    const changed: ConfirmedPlan = {
      ...saved,
      accepted_unwritable: saved.accepted_unwritable.map((entry) => ({
        ...entry,
        basis: { ...entry.basis, constraint_id: "computed" },
      })),
    };
    expect(await isConfirmationValid(saved)).toBe(true);
    expect(await isConfirmationValid(changed)).toBe(false);
    expect(await checkConfirmedPlan(changed)).toEqual([
      {
        code: "confirmation_expired",
        path: "confirmation.sha256",
        message: "仕様の SHA-256 と一致しない（確認が失効している）",
      },
    ]);
  });
});

// ── Issue #405：質問 ID と答えの ID を往復をまたいで一意にする ──────────────────

/** 重大 1 件・重大でない 1 件を返す P3 の答え（2 往復させる） */
const SURFACE_MIX = {
  ambiguities: [
    { id: "OI-1", requirementId: "R-1", text: "誰の分を数えるか", critical: true },
    { id: "OI-2", requirementId: "R-1", text: "いつの分を数えるか", critical: false },
  ],
  unwritable: [],
};

/** 未解決の事項 1 つへの P4 の答え（2 往復とも LLM が同じ `id` を返す） */
const questionFor = (openIssueId: string) => ({
  id: "Q-1",
  openIssueId,
  text: "どうしますか",
  choices: [
    { id: "c1", text: "こちら" },
    { id: "c2", text: "あちら" },
  ],
  recommended: { choiceId: "c1", reason: "依頼に沿う" },
  allowFreeText: true,
});

/**
 * 1 往復目の P4 の答え。**残り 10 問に収まるので、重大な OI-1 と重大でない OI-2 の両方を聞く**
 * （Issue #419 の覆いの検査）。ID は LLM が別々の `Q-1`・`Q-2` を返し、コードが `Q<版>-<n>` に組み直す。
 */
const ROUND_1_QUESTION = {
  questions: [
    { ...questionFor("OI-1"), id: "Q-1" },
    { ...questionFor("OI-2"), id: "Q-2" },
  ],
};
const ROUND_2_QUESTION = { questions: [questionFor("OI-2")] };

describe("質問 ID と答えの ID を往復をまたいで一意にする（Issue #405）", () => {
  it("答えの ID が空なら、質問 ID と版と選択肢が正しくても採られない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        round += 1;
        if (round === 1) {
          const question = request.questions[0];
          // 質問 ID・版・選択肢は正しいが、答えの ID が空 ——採られない（質問 ID と版と選択肢が正しくても）
          return {
            kind: "answers",
            answers: [{ id: "", questionId: question?.id ?? "", revision: question?.revision ?? 1, choiceId: "c1" }],
          };
        }
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q2-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(round).toBe(2);
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    const answerIds = result.plan.inputs.filter((input) => input.kind === "answer").map((input) => input.id);
    // 空の ID の答えは、入力・要件・事項の解決に入らない。次の往復の推奨の答えだけが残る
    expect(answerIds).toEqual(["A:Q2-1"]);
    expect(result.plan.requirements.map((requirement) => requirement.id)).not.toContain("R:A:Q1-1");
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-extra")?.resolution?.answer_id).toBe("A:Q2-1");
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
  });

  it("2 往復とも同じ質問 ID と答えの ID でも、ID が重ならず、組み直した ID で確定する", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_MIX),
      structured(ROUND_1_QUESTION),
      structured(ROUND_2_QUESTION),
    ]);
    const asked: PlanAnswerRequest[] = [];
    const responder: PlanResponder = {
      async answer(request) {
        asked.push(request);
        // 2 往復とも、答える役は同じ答えの ID（A-1）を返す。コードが組み直す（Issue #405）
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]) });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    // 質問 ID が `Q<版>-<n>`（1 往復目は `Q1-1`・`Q1-2`、2 往復目は `Q2-1`）。往復をまたいで重ならない
    expect(asked.map((request) => request.questions.map((question) => question.id))).toEqual([
      ["Q1-1", "Q1-2"],
      ["Q2-1"],
    ]);
    const questionIds = result.plan.inputs.filter((input) => input.kind === "question").map((input) => input.id);
    const answerIds = result.plan.inputs.filter((input) => input.kind === "answer").map((input) => input.id);
    expect(questionIds).toEqual(["Q1-1", "Q1-2", "Q2-1"]);
    expect(answerIds).toEqual(["A:Q1-1", "A:Q2-1"]);
    // 答えの ID・解決の根拠・`R:A:…` の要件が、同じ組み直した ID を指す
    const requirementIds = result.plan.requirements.map((requirement) => requirement.id);
    expect(requirementIds).toContain("R:A:Q1-1");
    expect(requirementIds).toContain("R:A:Q2-1");
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-1")?.resolution?.answer_id).toBe("A:Q1-1");
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-2")?.resolution?.answer_id).toBe("A:Q2-1");
    // 答える役に渡った問いの数と、確定した仕様の問いの数が一致する（黙って捨てる分岐が無い）
    const askedTotal = asked.reduce((total, request) => total + request.questions.length, 0);
    expect(questionIds).toHaveLength(askedTotal);
  });

  it("2 往復目に、古い質問 ID と古い版の答えを返しても、どちらも要件にならない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_MIX),
      structured(ROUND_1_QUESTION),
      structured(ROUND_2_QUESTION),
      structured(ROUND_2_QUESTION),
    ]);
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        round += 1;
        const question = request.questions[0];
        if (round === 1) {
          return { kind: "answers", answers: [answerTo(question)] };
        }
        if (round === 2) {
          return {
            kind: "answers",
            answers: [
              // 1 往復目の質問 ID を指す答え
              { id: "A-1", questionId: "Q1-1", revision: 2, choiceId: "c1" },
              // 現在の質問 ID に古い版を付けた答え
              { id: "A-2", questionId: question?.id ?? "", revision: 1, choiceId: "c1" },
            ],
          };
        }
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswersFor(["A:Q1-1", "A:Q3-1"]) });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    // 古い質問 ID・古い版の答えは、どちらも入力・要件・解決の根拠にならない
    const answerIds = result.plan.inputs.filter((input) => input.kind === "answer").map((input) => input.id);
    expect(answerIds).toEqual(["A:Q1-1", "A:Q3-1"]);
    expect(result.plan.requirements.map((requirement) => requirement.id)).not.toContain("R:A:Q2-1");
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-2")?.resolution?.answer_id).toBe("A:Q3-1");
  });

  it("同じ質問に 2 つの答えを返すと、どちらも採られず、事項が開いたまま残る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        round += 1;
        const question = request.questions[0];
        if (round === 1) {
          return {
            kind: "answers",
            answers: [
              { id: "A-1", questionId: question?.id ?? "", revision: question?.revision ?? 1, choiceId: "c1" },
              { id: "A-2", questionId: question?.id ?? "", revision: question?.revision ?? 1, choiceId: "c2" },
            ],
          };
        }
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q2-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    const answerIds = result.plan.inputs.filter((input) => input.kind === "answer").map((input) => input.id);
    // 同じ質問への 2 つの答えは、どちらも採られない。次の往復の推奨の答えだけが残る
    expect(answerIds).toEqual(["A:Q2-1"]);
    expect(result.plan.requirements.map((requirement) => requirement.id)).not.toContain("R:A:Q1-1");
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-extra")?.resolution?.answer_id).toBe("A:Q2-1");
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
  });

  it("同じ応答の中で質問 ID が重なると、1 回やり直し、2 回続くと malformed で止まり、ID の値が残らない", async () => {
    const mark = "MARK_DUP_QQQ";
    const questionOf = (text: string) => ({
      id: `Q-${mark}`,
      openIssueId: "OI-extra",
      text,
      choices: [
        { id: "c1", text: "こちら" },
        { id: "c2", text: "あちら" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    });
    const duplicated = { questions: [questionOf("問い a"), questionOf("問い b")] };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(duplicated),
      structured(duplicated),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge(catalogAnswers()), ANSWER_NONE));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure).toEqual({
      stage: "questions",
      kind: "malformed",
      problems: [{ field: "questions[1].id", code: "duplicate-question-id" }],
    });
    // 目印を含む重複 ID の文字列が、失敗の記録と停止の行のどこにも無い
    expect(JSON.stringify(result)).not.toContain(mark);
    expect(planStopReasonLine(result)).not.toContain(mark);
    expect(planStopReasonLine(result)).toContain("duplicate-question-id");
  });
});

// ── Issue #408：許可の表の既定で、未指定の事項を最初の往復から閉じる ──────────────

describe("許可の表の既定で、未指定の事項を最初の往復から閉じる（04 §3・Issue #408）", () => {
  it("表の観点がすべて適用条件に合うと、P4 も答える役も 0 回で既定で閉じ、確認の役の下書きと確定した仕様が一致する", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    let answerCalls = 0;
    const views: PlanConfirmationView[] = [];
    const responder: PlanResponder = {
      async answer() {
        answerCalls += 1;
        return { kind: "answers", answers: [] };
      },
      async confirm(view) {
        views.push(view);
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period", "current-period", "include-zero"] }),
      ...coverAnswersFor([]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // P4 も答える役も 0 回（`questions` の段の記録が無い）
    expect(answerCalls).toBe(0);
    expect(result.stages.some((stage) => stage.stage === "questions")).toBe(false);
    // decisions に `D:default:` の決定が並ぶ
    const defaults = result.plan.decisions.filter((decision) => decision.id.startsWith("D:default:"));
    expect(defaults.map((decision) => decision.id)).toEqual([
      "D:default:OI:catalog:R-1:period",
      "D:default:OI:catalog:R-1:current-period",
      "D:default:OI:catalog:R-1:include-zero",
    ]);
    // 事項が `resolution.decision_id` で解決する
    for (const decision of defaults) {
      const issueId = decision.id.slice("D:default:".length);
      const issue = result.plan.open_issues.find((candidate) => candidate.id === issueId);
      expect(issue?.status).toBe("resolved");
      expect(issue?.resolution?.decision_id).toBe(decision.id);
    }
    // 確定した仕様の検査の誤りが 0
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    expect(await isConfirmationValid(result.plan)).toBe(true);
    // 確認の役が受け取った下書きの decisions・open_issues と、確定した仕様のそれが一致する
    expect(views[0]?.plan.decisions).toEqual(result.plan.decisions);
    expect(views[0]?.plan.open_issues).toEqual(result.plan.open_issues);
    expect(views[0]?.closedByDefault.map((decision) => decision.id)).toEqual(defaults.map((one) => one.id));
    // 既定で閉じた事項の記録（事項 ID・観点 ID・値）
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R-1:period", facetId: "period", value: "期間の条件を足さない" },
      { issueId: "OI:catalog:R-1:current-period", facetId: "current-period", value: "今の期間を含む" },
      { issueId: "OI:catalog:R-1:include-zero", facetId: "include-zero", value: "0 件の見出しも出す" },
    ]);
    // 既定を当てた仕様が Build に渡る（決定の文が、確定した仕様の decisions に入る）
    expect(result.plan.decisions.map((decision) => decision.subject)).toContain(defaults[0]?.subject);
    // 確認のあとに決定の値を変えた仕様は確認が失効する
    const changed: ConfirmedPlan = {
      ...result.plan,
      decisions: result.plan.decisions.map((decision) =>
        decision.id === "D:default:OI:catalog:R-1:period" ? { ...decision, value: "変えた値" } : decision,
      ),
    };
    expect(await isConfirmationValid(changed)).toBe(false);
    expect(await checkConfirmedPlan(changed)).toEqual([
      {
        code: "confirmation_expired",
        path: "confirmation.sha256",
        message: "仕様の SHA-256 と一致しない（確認が失効している）",
      },
    ]);
  });

  it("重大な事項と表の事項が混ざると、表の事項だけが既定で閉じ、P4 の入力に重大な事項だけが渡る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(questionsFor("OI:catalog:R-1:aggregation")),
    ]);
    const asked: PlanAnswerRequest[] = [];
    const responder: PlanResponder = {
      async answer(request) {
        asked.push(request);
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["aggregation", "period"] }),
      ...coverAnswersFor(["A:Q1-1"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // P4 に渡った事項は、重大な aggregation だけ（表の period は既定で閉じている）
    expect(asked[0]?.questions.map((question) => question.openIssueId)).toEqual(["OI:catalog:R-1:aggregation"]);
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R-1:period", facetId: "period", value: "期間の条件を足さない" },
    ]);
    // 既定で閉じた分は問数・往復を消費しない（出した問いは重大な 1 問だけ）
    expect(result.plan.inputs.filter((input) => input.kind === "question")).toHaveLength(1);
    const usedQuestions = asked.reduce((total, request) => total + request.questions.length, 0);
    expect(usedQuestions).toBe(1);
  });

  it("表の外の事項（権限・P3 の自由文・P1 の未解決）は既定では閉じず、問数が残れば P4 を呼ぶ", async () => {
    const listWithUnresolved = { ...REQUIREMENT_LIST_OUTPUT, unresolved: ["P1 の未解決"] };
    const surface = {
      ambiguities: [{ id: "OI-p3", requirementId: "R-1", text: "自由文の事項", critical: false }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(listWithUnresolved),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured({
        questions: [
          ...(questionsFor("OI:catalog:R-1:editable-by", "Q-1").questions as readonly object[]),
          ...(questionsFor("OI:unresolved:1", "Q-2").questions as readonly object[]),
          ...(questionsFor("OI-p3", "Q-3").questions as readonly object[]),
        ],
      }),
    ]);
    const asked: PlanAnswerRequest[] = [];
    const responder: PlanResponder = {
      async answer(request) {
        asked.push(request);
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["editable-by"] }),
      ...coverAnswersFor(["A:Q1-1", "A:Q1-2", "A:Q1-3"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    // 表の外の事項は既定では閉じない
    expect(result.closedByDefault).toEqual([]);
    // 問数が残っているので P4 を呼ぶ
    expect(asked.length).toBeGreaterThan(0);
  });

  it("上限で残る事項が重大でないものだけなら cannot-confirm（source: session・noncritical-without-default）で、P6 を呼ばない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(questionsFor("OI:catalog:R-1:editable-by")),
      structured(questionsFor("OI:catalog:R-1:editable-by")),
      structured(questionsFor("OI:catalog:R-1:editable-by")),
    ]);
    const responder: PlanResponder = ANSWER_NONE;
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["editable-by"] }),
      ...coverAnswersFor([]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([{ source: "session", code: "noncritical-without-default", path: "open_issues" }]);
    expect(result.closedByDefault).toEqual([]);
    expect(result.stages.some((stage) => stage.stage === "confirm")).toBe(false);
  });

  it("モデルが同じ形（OI:catalog:）の ID を作った事項は、既定の対象にならない", async () => {
    const surface = {
      ambiguities: [{ id: "OI:catalog:R-1:period", requirementId: "R-1", text: "モデルが作った事項", critical: false }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(questionsFor("OI:catalog:R-1:period")),
      structured(questionsFor("OI:catalog:R-1:period")),
      structured(questionsFor("OI:catalog:R-1:period")),
    ]);
    // 目録の答えはすべて「決まっている」（コードが作った事項は無い）
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswersFor([]) });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.closedByDefault).toEqual([]);
    // 事項は開いたままである
    expect(result.openIssues.map((issue) => issue.id)).toContain("OI:catalog:R-1:period");
  });

  it("重複した ID の事項は、既定の対象にならない", async () => {
    const surface = {
      ambiguities: [{ id: "OI:catalog:R-1:period", requirementId: "R-1", text: "重複した事項", critical: false }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(questionsFor("OI:catalog:R-1:period")),
      structured(questionsFor("OI:catalog:R-1:period")),
      structured(questionsFor("OI:catalog:R-1:period")),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...coverAnswersFor([]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // コードが作った事項とモデルが作った事項で ID が重なっているので、既定で閉じない
    expect(result.closedByDefault).toEqual([]);
  });

  it("「全部推奨」でも、残りの問数に収まる重大でない事項を聞かない応答は、覆いの検査でやり直し、2 回続けば段の失敗になる（Issue #419）", async () => {
    const surface = {
      ambiguities: [
        { id: "OI-c", requirementId: "R-1", text: "重大な事項", critical: true },
        { id: "OI-n", requirementId: "R-1", text: "重大でない事項", critical: false },
      ],
      unwritable: [],
    };
    // P4 は重大な OI-c だけを聞き、残り 10 問に収まる重大でない OI-n を聞かない（やり直しも同じ）
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(questionsFor("OI-c")),
      structured(questionsFor("OI-c")),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...coverAnswersFor(["A:Q1-1"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("questions");
    expect(result.failure?.kind).toBe("malformed");
    expect(result.failure?.problems).toEqual([{ field: "questions", code: "question-coverage" }]);
  });

  it("残りの問数に全事項が収まらない設定では、「全部推奨」でも未質問の表の外の事項を閉じない（Issue #408・#419）", async () => {
    // 重大 10 件 + 表の外の重大でない 1 件 = 11 件。残り 10 問に収まらないので、重大だけを求めればよい
    const surface = {
      ambiguities: [
        ...Array.from({ length: 10 }, (_value, index) => ({
          id: `OI-${index + 1}`,
          requirementId: "R-1",
          text: `重大 ${index + 1}`,
          critical: true,
        })),
        { id: "OI-n", requirementId: "R-1", text: "表の外の重大でない事項", critical: false },
      ],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(TEN_QUESTIONS),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...coverAnswersFor(Array.from({ length: 10 }, (_value, index) => `A:Q1-${index + 1}`)),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 推奨で答えた重大 10 件だけが閉じ、未質問の表の外の事項（OI-n）は閉じない
    expect(result.openIssues.map((issue) => issue.id)).toEqual(["OI-n"]);
    // 表の事項（period）は既定で閉じている
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R-1:period", facetId: "period", value: "期間の条件を足さない" },
    ]);
    // 表の外の事項が残るので確定しない
    expect(result.reasons).toEqual([{ source: "session", code: "noncritical-without-default", path: "open_issues" }]);
  });

  it("問数 10・往復 3 の境界で、既定の閉じ方が上限を消費しない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(TEN_ISSUES_SURFACE),
      structured(TEN_QUESTIONS),
    ]);
    const responder: PlanResponder = ALL_RECOMMENDED;
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...coverAnswersFor(Array.from({ length: 10 }, (_value, index) => `A:Q1-${index + 1}`)),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 既定で閉じた分（period）は問数を消費しない
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R-1:period", facetId: "period", value: "期間の条件を足さない" },
    ]);
    // 重大な 10 件はそのまま 10 問で聞く（既定の分を足した 11 問にはしない）
    expect(result.plan.inputs.filter((input) => input.kind === "question")).toHaveLength(AGENT_LIMITS.planQuestions);
    expect(result.plan.open_issues.every((issue) => issue.status === "resolved")).toBe(true);
  });
});

// ── Issue #419：目録の点検を P3 の前に回し、点検の結果を P3 に渡す ─────────────

describe("目録の点検を P3 の前に回し、点検の結果を P3 に渡す（04 §3 P3・Issue #419）", () => {
  /** `<data name="…">…</data>` の中身を取り出す（データの欄ごとに確かめる） */
  const dataBlockOf = (input: string, name: string): string =>
    input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "";

  it("P3 の要求のデータに、目録が点検した対象・開いている事項・仮に適用した既定が入り、値・理由はコードの定数で、依頼文の目印が入らない", async () => {
    const mark = "MARK_SOURCE_P3";
    const source = `${mark}する。件数を合計する。`;
    const pos = (quote: string): { readonly start: number; readonly end: number } => {
      const start = source.indexOf(quote);
      return { start, end: start + quote.length };
    };
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: `${mark}する`, position: pos(`${mark}する`) },
        { id: "R-2", text: "件数を合計できる", quote: "件数を合計する", position: pos("件数を合計する") },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    // period を未指定にする → 既定が当たる（仮適用。まだ閉じない）
    const judge = createFakeJudge({ ...catalogUnspecifiedFor({ "R-1": ["period"] }), ...coverAnswersFor([]) });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE, { source }));

    expect(result.kind).toBe("confirmed");
    // 目録の段が P3 の段より前（段の記録）
    expect(result.stages.map((stage) => stage.stage).slice(0, 3)).toEqual(["requirements", "catalog", "surface"]);
    const request = recording.structured[2];
    expect(request).toBeDefined();
    if (request === undefined) return;
    const input = request.input;
    // 3 つの欄が別々の `<data name=` で入る
    expect(input).toContain('<data name="目録が点検した対象">');
    expect(input).toContain('<data name="開いている事項">');
    expect(input).toContain('<data name="仮に適用した既定">');
    // 開いている事項（コードが目録から作った事項）
    expect(dataBlockOf(input, "開いている事項")).toContain("OI:catalog:R-1:period");
    // 仮に適用した既定（値・理由はコードの定数）
    const defaults = dataBlockOf(input, "仮に適用した既定");
    expect(defaults).toContain("期間の条件を足さない");
    expect(defaults).toContain("語彙の意味");
    expect(defaults).toContain("OI:catalog:R-1:period");
    // 3 つの新しい欄に、依頼文の目印が入らない（依頼文・答えの本文を渡さない）
    for (const name of ["目録が点検した対象", "開いている事項", "仮に適用した既定"]) {
      expect(dataBlockOf(input, name)).not.toContain(mark);
    }
  });

  it("偽物の P3 が、仮に適用した既定と同じ決めどころの自由文の事項を返しても、閉じず・落とさず、開いた事項として P4 に渡る", async () => {
    // 目録は period を未指定にする（既定は仮適用）。P3 は同じ決めどころ（期間）を自由文で挙げる
    const surface = {
      ambiguities: [{ id: "OI-free", requirementId: "R-1", text: "期間のことを決めたい", critical: false }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(questionsFor("OI-free")),
      structured(questionsFor("OI-free")),
      structured(questionsFor("OI-free")),
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
    const judge = createFakeJudge({ ...catalogUnspecifiedFor({ "R-1": ["period"] }), ...coverAnswersFor([]) });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 自由文の事項（OI-free）は、既定と決めどころが同じでも、コードが閉じない・落とさない
    expect(result.openIssues.map((issue) => issue.id)).toContain("OI-free");
    // 開いた事項として P4 に渡る（自動で閉じない）
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]?.questions.map((question) => question.openIssueId)).toContain("OI-free");
    // 目録が作った period の事項だけが、既定で確定して閉じている
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R-1:period", facetId: "period", value: "期間の条件を足さない" },
    ]);
  });

  it("目録の門が判定不明の要件と、当てはまらないと判定した要件で、P3 の重大な事項が開いたまま残れば確定しない", async () => {
    // R-1: 門の答えが範囲の外（不明）→ 集計の観点は判定不明。R-2: 当てはまりを閾値未満（当てはまらない）
    const answers: Record<string, JudgeAnswer> = {
      [catalogGateQuestionName("R-1")]: noul(1.5),
      [catalogGateQuestionName("R-2")]: noul(1),
    };
    for (const facet of CATALOG_FACETS) {
      answers[catalogAppliesQuestionName("R-1", facet.id)] = noul(1);
      answers[catalogQuestionName("R-1", facet.id)] = noul(1);
      answers[catalogAppliesQuestionName("R-2", facet.id)] = noul(0.1);
      answers[catalogQuestionName("R-2", facet.id)] = noul(0);
    }
    const surface = {
      ambiguities: [{ id: "OI-crit", requirementId: "R-1", text: "重大な曖昧さ", critical: true }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      structured(questionsFor("OI-crit")),
      structured(questionsFor("OI-crit")),
      structured(questionsFor("OI-crit")),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge(answers), ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 重大な事項 OI-crit が開いたまま残る（目録の一覧は抑制の根拠にしない）
    expect(result.openIssues.map((issue) => issue.id)).toContain("OI-crit");
    // 一覧では、R-1 の集計の観点が「判定不明」、R-2 の観点が「当てはまらない」
    const request = recording.structured[2];
    const targets = dataBlockOf(request?.input ?? "", "目録が点検した対象");
    expect(targets).toContain("判定不明");
    expect(targets).toContain("当てはまらない");
  });
});

// ── Issue #430：P1/P2 の往復ごとの落ちの内訳を結果に残す ─────────────────

/** 落ち 0 件の内訳（Issue #430） */
const ZERO_MISS_COUNTS = { quoteNotFound: 0, positionMismatch: 0, uncoveredSource: { code: 0, conversation: 0 } };

describe("P1/P2 の往復ごとの落ちの内訳を結果に残す（Issue #430）", () => {
  it("確定した結果にも内訳があり、落ちが無ければ往復 1 つで全部 0 になる", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);
    const responder: PlanResponder = {
      async answer(request) {
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q1-1") });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    // 落ちが無いので、往復は 1 つだけ、種類ごと・出どころごとに全部 0（Issue #430）
    expect(result.requirementsDiagnosis).toEqual({
      rounds: [{ misses: ZERO_MISS_COUNTS, droppedBlankMisses: 0 }],
      redone: false,
      unmet: ZERO_MISS_COUNTS,
    });
  });

  it("確定できない結果（逆照合の落ち）でも、往復ごとの内訳と unmet の内訳が残る", async () => {
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
    // 往復 2（初回 + やり直し）。やり直し後の往復 2 の内訳と unmet の内訳が一致する
    expect(result.requirementsDiagnosis.redone).toBe(true);
    expect(result.requirementsDiagnosis.rounds).toHaveLength(2);
    expect(result.requirementsDiagnosis.rounds[1]?.misses).toEqual(result.requirementsDiagnosis.unmet);
    expect(result.requirementsDiagnosis.unmet).toEqual({
      quoteNotFound: 1,
      positionMismatch: 0,
      uncoveredSource: { code: 0, conversation: 0 },
    });
  });

  it("確定できない結果（P6 の落ち）でも、往復ごとの内訳が残る", async () => {
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
    // 覆われていない原文の文（コードが見つけた分）が、やり直し後も残っている
    expect(result.requirementsDiagnosis.unmet).toEqual({
      quoteNotFound: 0,
      positionMismatch: 0,
      uncoveredSource: { code: 1, conversation: 0 },
    });
  });

  it("止まった結果では、止まるまでに終えた往復の分だけの内訳がある", async () => {
    // ① で止まる → 往復は 0
    const atRequirements = await runPlan(
      makePlanInput(clientThrowingAt([], 1, () => invalidRequestError("invalid_json_schema")), createFakeJudge({}), ANSWER_NONE),
    );
    expect(atRequirements.kind).toBe("stopped");
    expect(atRequirements.requirementsDiagnosis.rounds).toEqual([]);

    // ①' で止まる → 往復は 0（初回の逆照合が終わっていない）
    const atReverseCheck = await runPlan(
      makePlanInput(
        clientThrowingAt([structured(REQUIREMENT_LIST_OUTPUT)], 2, () => invalidRequestError("invalid_json_schema")),
        createFakeJudge({}),
        ANSWER_NONE,
      ),
    );
    expect(atReverseCheck.kind).toBe("stopped");
    expect(atReverseCheck.requirementsDiagnosis.rounds).toEqual([]);

    // ① のやり直しで止まる → 往復 1（初回の逆照合まで終えた）
    const atRedo = await runPlan(
      makePlanInput(
        clientThrowingAt([structured(THREE_REQUIREMENTS), structured(REVERSE_CHECK_OUTPUT)], 3, () =>
          invalidRequestError("invalid_json_schema"),
        ),
        createFakeJudge({}),
        ANSWER_NONE,
        { source: THREE_SOURCE },
      ),
    );
    expect(atRedo.kind).toBe("stopped");
    expect(atRedo.requirementsDiagnosis.rounds).toHaveLength(1);
    // ① のやり直し**自体**が失敗したので、やり直しは終えていない（Issue #430 の直し）
    expect(atRedo.requirementsDiagnosis.redone).toBe(false);

    // ①' のやり直しで止まる → 往復 1。① のやり直しは成功しているので、やり直しは終えている
    const atRedoReverse = await runPlan(
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
    expect(atRedoReverse.kind).toBe("stopped");
    expect(atRedoReverse.requirementsDiagnosis.rounds).toHaveLength(1);
    expect(atRedoReverse.requirementsDiagnosis.redone).toBe(true);
    expect(atRedoReverse.requirementsDiagnosis.unmet).toEqual(ZERO_MISS_COUNTS);
  });
});

// ── Issue #432：P3 の「書けない」の申告を、確認の前に判定の口で独立に点検する ─────────

/** 語彙の穴で裏付けあり・問題ではない・曖昧さ、の 3 件の申告（制約 ID は文書に実在する） */
const SURFACE_THREE_CLAIMS = {
  ambiguities: [],
  unwritable: [
    { id: "U-0", requirementId: "R-1", part: "部分 0", constraintIds: ["アプリの名前・説明"], reason: "理由 0", alternative: "代案 0" },
    { id: "U-1", requirementId: "R-2", part: "部分 1", constraintIds: ["記録"], reason: "理由 1", alternative: "代案 1" },
    { id: "U-2", requirementId: "R-1", part: "部分 2", constraintIds: ["合計"], reason: "理由 2", alternative: "代案 2" },
  ],
};

describe("P3 の「書けない」の申告を判定の口で点検する（04 §3 P3・Issue #432）", () => {
  it("受理した申告だけが了承除外と代わりの案になり、落とした要件はそのまま残り、曖昧さは重大な事項として P4 に渡る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE_CLAIMS),
      structured(questionsFor("OI:surface-check:2")),
    ]);
    const asked: PlanAnswerRequest[] = [];
    const responder: PlanResponder = {
      async answer(request) {
        asked.push(request);
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswersFor(["A:Q1-1"]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
      [surfaceTriageQuestionName(1)]: choice("not-a-problem", 0.8),
      [surfaceTriageQuestionName(2)]: choice("ambiguity", 0.9),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 受理した申告（U-0）だけが了承除外と代わりの案になる
    expect(result.plan.accepted_unwritable).toHaveLength(1);
    expect(result.plan.accepted_unwritable[0]?.part_id).toBe("P:U-0");
    expect(result.plan.accepted_unwritable[0]?.alternative_id).toBe("R:alt:U-0");
    expect(result.plan.requirements.map((requirement) => requirement.id)).toContain("R:alt:U-0");
    // 落とした申告（U-1）の要件（R-2）はそのまま残る（部分が付かない）
    expect(result.plan.requirements.find((requirement) => requirement.id === "R-2")?.parts).toEqual([]);
    // 曖昧さと判定した申告（U-2）が、重大な開いている事項として P4 に渡って閉じる
    expect(asked[0]?.questions.map((question) => question.openIssueId)).toEqual(["OI:surface-check:2"]);
    expect(result.plan.open_issues.find((issue) => issue.id === "OI:surface-check:2")?.status).toBe("resolved");
    // 確定した仕様の検査の誤りが 0
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    // 件数の記録（受理 1・落とした 1・曖昧さへ 1・未点検 0）
    expect(result.surfaceCheck.accepted).toBe(1);
    expect(result.surfaceCheck.dropped).toBe(1);
    expect(result.surfaceCheck.ambiguity).toBe(1);
    expect(result.surfaceCheck.unchecked).toBe(0);
  });

  it("未点検が残れば、P4 も答える役も呼ばれず、理由に値（部分の文・制約 ID）を含めずに確定できない", async () => {
    const mark = "MARK_SURFACE_CLAIM";
    const surface = {
      ambiguities: [],
      unwritable: [
        {
          id: "U-1",
          requirementId: "R-1",
          part: `${mark}の部分`,
          constraintIds: ["記録"],
          reason: `${mark}の理由`,
          alternative: `${mark}の代案`,
        },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
    ]);
    let answerCalls = 0;
    let confirmCalls = 0;
    const responder: PlanResponder = {
      async answer() {
        answerCalls += 1;
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        confirmCalls += 1;
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("not-stated", 0.9),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 理由は有限の分類と、添字つきの欄の名前だけ（値の中身を含まない。Issue #432）
    expect(result.reasons).toEqual([{ source: "surface-check", code: "not-stated", path: "unwritable[0]" }]);
    // 部分の文・理由・制約 ID の文字列が、理由にも停止の行にも出ない
    expect(JSON.stringify(result.reasons)).not.toContain(mark);
    expect(planStopReasonLine(result)).not.toContain(mark);
    expect(planStopReasonLine(result)).toContain("not-stated");
    // P4 も答える役も呼ばれない
    expect(answerCalls).toBe(0);
    expect(confirmCalls).toBe(0);
    // surface-check の段は走った（`ok`）が、questions・confirm の段は無い
    expect(result.stages.some((stage) => stage.stage === "surface-check")).toBe(true);
    expect(result.stages.some((stage) => stage.stage === "questions")).toBe(false);
    expect(result.stages.some((stage) => stage.stage === "confirm")).toBe(false);
    // 件数の記録（未点検 1）
    expect(result.surfaceCheck.unchecked).toBe(1);
    expect(result.surfaceCheck.accepted).toBe(0);
  });

  it("判定の予算が尽きると、段 surface-check が failed（budget）で止まり、申告が通らない", async () => {
    // surface の段の応答に、予算を使い切る巨大な usage を付ける（判定の予約は呼ぶ前に見るので、
    // 目録の判定を通したあと、surface-check の判定の予約が残高を超えて止まる）
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const surface = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface, hugeUsage),
    ]);
    const judge = createFakeJudge(catalogAnswers());

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE, { budgetUsd: 1 }));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("budget");
    expect(result.failure?.stage).toBe("surface-check");
    expect(result.failure?.kind).toBe("budget");
    // 段 surface-check が failed（budget）で記録される
    expect(result.stages.find((stage) => stage.stage === "surface-check")?.status).toBe("failed");
    expect(result.stages.find((stage) => stage.stage === "surface-check")?.failure_kind).toBe("budget");
    // 申告が通らない（受理 0）
    expect(result.surfaceCheck.accepted).toBe(0);
  });
});
