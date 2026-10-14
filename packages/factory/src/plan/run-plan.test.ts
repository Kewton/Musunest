// Plan を 1 回流す口（plan/run-plan.ts）の unit テスト（04-plan-agent.md §2・§3・§6・§8・Issue #363）。
//
// **偽物の LLM・偽物の判定・偽物の答える役で回す。実 API は呼ばない。** ここで固定したいのは 7 つ。
//   1. 答える役が答えて、確定した仕様（`checkConfirmedPlan` が誤り 0・確認の SHA-256 が仕様と一致）まで進む
//   2. 「全部推奨で進める」で、推奨で閉じて確認に進む
//   3. 質問は往復をまたいで 10 問・3 往復を超えない。上限のあとも重大な未解決の事項が残れば「確定できない」
//   4. 確認で「やめる」なら「止まった」になり、確定した仕様を返さない
//   5. 予算が尽きると「止まった」になる。使った額に LLM と判定の費用が入る
//   6. 段ごとの記録が結果に入る
//   7. 判定の包みが、共有の門を Jev の内部の再送へ届ける（Issue #469）
import { describe, expect, it } from "vitest";
import { checkConfirmedPlan, isConfirmationValid, planDigest, type ConfirmedPlan, type PlanAcceptedUnwritable, type PlanOpenIssue, type PlanPart, type PlanRequirement } from "@musunest/appspec-schema";
import { planStopReasonLine } from "../cli-plan.js";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest, JudgeResponse } from "../judge.js";
import { createJevJudge, type JevFetch } from "../judge-jev.js";
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
  diffChangeKey,
  isAcceptedUnwritableDuplicate,
  planDiagnosisCode,
  planDiagnosisField,
  runPlan,
  selectDiffRequirements,
  sessionCannotConfirmReason,
  type AcceptedClaimSnapshot,
  type PlanAnswerRequest,
  type PlanResponder,
  type PlanResult,
  type PlanRunInput,
} from "./run-plan.js";
import { QUESTIONS_SCHEMA_NAME, type PlanQuestion } from "./questions.js";
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
import { SURFACE_DIFF_SCHEMA_NAME, SURFACE_SCHEMA, SURFACE_SCHEMA_NAME } from "./surface.js";
import {
  createScriptPlanResponder,
  parsePlanScript,
  PLAN_SCRIPT_SCHEMA,
  type PlanScript,
  type PlanScriptMatch,
} from "./script-responder.js";
import {
  SURFACE_RECHECK_NO_EVIDENCE,
  surfaceRecheckEvidenceQuestionName,
  surfaceRecheckKindQuestionName,
  surfaceSupportQuestionName,
  surfaceTriageQuestionName,
} from "./surface-check.js";
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

/** 対象外の参照が無いときの、差分点検の記録の `outOfScope`（Issue #434） */
const NO_OUT_OF_SCOPE = {
  scanned: true,
  claims: 0,
  ambiguities: 0,
  deduped: 0,
  rejectedClaims: 0,
  rejectedAmbiguities: 0,
  kinds: [
    { kind: "source", claims: 0, ambiguities: 0 },
    { kind: "previous-answer", claims: 0, ambiguities: 0 },
    { kind: "alternative", claims: 0, ambiguities: 0 },
    { kind: "unknown", claims: 0, ambiguities: 0 },
    { kind: "unclassified", claims: 0, ambiguities: 0 },
  ],
  dedupedIndexes: [],
};

/** 差分点検の記録の `outOfScope` を、指定した件数だけ変えて作る（Issue #434） */
function diffOutOfScope(
  overrides: {
    scanned?: boolean;
    claims?: number;
    ambiguities?: number;
    deduped?: number;
    rejectedClaims?: number;
    rejectedAmbiguities?: number;
    kinds?: Partial<Record<string, { claims?: number; ambiguities?: number }>>;
    dedupedIndexes?: readonly number[];
  } = {},
) {
  return {
    scanned: overrides.scanned ?? true,
    claims: overrides.claims ?? 0,
    ambiguities: overrides.ambiguities ?? 0,
    deduped: overrides.deduped ?? 0,
    rejectedClaims: overrides.rejectedClaims ?? 0,
    rejectedAmbiguities: overrides.rejectedAmbiguities ?? 0,
    kinds: NO_OUT_OF_SCOPE.kinds.map((entry) => {
      const extra = overrides.kinds?.[entry.kind];
      return extra === undefined ? entry : { ...entry, ...extra };
    }),
    dedupedIndexes: overrides.dedupedIndexes ?? [],
  };
}

/** 差分点検の記録の `inherit`（引き継ぎの件数。Issue #461）を、指定した件数で作る */
function inheritRecord(
  overrides: {
    facets?: readonly { readonly kind: string; readonly facetId: string; readonly count: number }[];
    noParent?: number;
    multipleParents?: number;
    unresolved?: Partial<Record<"missing" | "multiple" | "mismatch", number>>;
    openBySource?: Partial<Record<"catalog" | "surface" | "surface-check", number>>;
  } = {},
) {
  return {
    facets: overrides.facets ?? [],
    noParent: overrides.noParent ?? 0,
    multipleParents: overrides.multipleParents ?? 0,
    unresolved: (["missing", "multiple", "mismatch"] as const).map((kind) => ({
      kind,
      count: overrides.unresolved?.[kind] ?? 0,
    })),
    openBySource: (["catalog", "surface", "surface-check"] as const).map((source) => ({
      source,
      count: overrides.openBySource?.[source] ?? 0,
    })),
  };
}

/** 使い回しで断った件の「提示元ごとの数」（Issue #464。既定はすべて 0） */
function idReuseBySource(
  overrides: Partial<Record<"catalog" | "defaults" | "inherited" | "decisions", number>> = {},
) {
  return (["catalog", "defaults", "inherited", "decisions"] as const).map((source) => ({
    source,
    count: overrides[source] ?? 0,
  }));
}

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
      // 差分点検（その往復で増えた要件だけ）の P3 の応答（Issue #434）
      structured(SURFACE_OUTPUT_CLEAR),
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
    const judge = createFakeJudge({
      ...catalogAnswers(),
      // 差分点検の目録の答え（増えた要件 R:A:Q1-1。Issue #434）
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

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
    // **申告 0 件でも surface-check の段は `surface` の次に `ok` で残る**（Issue #432）。
    // **往復のあとに、差分点検の catalog・surface・surface-check が並ぶ**（Issue #434）
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "requirements",
      "catalog",
      "surface",
      "surface-check",
      "questions",
      "answers",
      "catalog",
      "surface",
      "surface-check",
      "confirm",
    ]);
    // 差分点検の記録（往復 1・増えた要件 1 件。Issue #434）
    expect(result.diffReviews).toEqual([{ round: 1, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) }]);
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
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

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
      ...catalogAnswersFor(Array.from({ length: 10 }, (_value, index) => `R:A:Q1-${index + 1}`)),
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
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

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
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const responder: PlanResponder = {
      async answer(request) {
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

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
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

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

  it("P2 のやり直し後に覆われていない原文が残ると、目録・P3・P4 を呼ばずに cannot-confirm になる（Issue #440）", async () => {
    // 3 文の原文のうち、要件が前の 2 文だけを覆う（最後の 1 文がコードの落ちとして残る）
    const recording = createRecordingClient([
      structured(THREE_REQUIREMENTS),
      structured(REVERSE_CHECK_OUTPUT),
      structured(THREE_REQUIREMENTS),
      structured(REVERSE_CHECK_OUTPUT),
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

    const result = await runPlan(
      makePlanInput(recording.client, createFakeJudge(catalogAnswers()), responder, { source: THREE_SOURCE }),
    );

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 理由は引用の落ちと同じ写し方で、覆われていない原文の落ちとして残る
    expect(result.reasons).toEqual([{ source: "reverse-check", code: "uncovered-source", path: "source[*]" }]);
    expect(result.openIssues).toEqual([]);
    // 目録・P3・P4 は呼ばれない（段の記録に無い）
    const stageIds = result.stages.map((stage) => stage.stage);
    expect(stageIds).not.toContain("catalog");
    expect(stageIds).not.toContain("surface");
    expect(stageIds).not.toContain("questions");
    // 答える役も確認の役も呼ばれない
    expect(answerCalls).toBe(0);
    expect(confirmCalls).toBe(0);
    // 往復の記録の内訳（G1a）に、覆われていない原文の件数（コードが見つけた分）が残る
    expect(result.requirementsDiagnosis.rounds).toHaveLength(2);
    expect(result.requirementsDiagnosis.unmet).toEqual({
      quoteNotFound: 0,
      positionMismatch: 0,
      uncoveredSource: { code: 1, conversation: 0 },
    });
  });

  it("会話が挙げた覆われていない原文だけがやり直し後も残っても、cannot-confirm になる（Issue #440）", async () => {
    // 要件が原文の 2 文を位置で覆うので、コードの落ちは無い
    const coveredList = {
      requirements: [
        { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
        { id: "R-2", text: "件数を合計できる", quote: "件数を合計する", position: { start: 9, end: 16 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    // 会話が挙げた、覆われていない部分（コードの落ちとは重ならない）
    const conversation = { uncovered: [{ start: 0, end: 8 }] };
    const recording = createRecordingClient([
      structured(coveredList),
      structured(conversation),
      structured(coveredList),
      structured(conversation),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge({}), ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([{ source: "reverse-check", code: "uncovered-source", path: "source[*]" }]);
    expect(result.openIssues).toEqual([]);
    expect(result.stages.map((stage) => stage.stage)).not.toContain("catalog");
    // コードの分は 0、会話が挙げた分だけが残る（案 A）
    expect(result.requirementsDiagnosis.unmet).toEqual({
      quoteNotFound: 0,
      positionMismatch: 0,
      uncoveredSource: { code: 0, conversation: 1 },
    });
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
      structured(SURFACE_OUTPUT_CLEAR),
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
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q2-1"]),
      ...coverAnswers("A:Q2-1"),
    });

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
      structured(SURFACE_OUTPUT_CLEAR),
      structured(ROUND_2_QUESTION),
      structured(SURFACE_OUTPUT_CLEAR),
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
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });

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
      structured(SURFACE_OUTPUT_CLEAR),
      structured(ROUND_2_QUESTION),
      structured(ROUND_2_QUESTION),
      structured(SURFACE_OUTPUT_CLEAR),
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
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q3-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q3-1"]),
    });

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
      structured(SURFACE_OUTPUT_CLEAR),
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
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q2-1"]),
      ...coverAnswers("A:Q2-1"),
    });

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
      structured(SURFACE_OUTPUT_CLEAR),
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
      ...catalogAnswersFor(["R:A:Q1-1"]),
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
      structured(SURFACE_OUTPUT_CLEAR),
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
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q1-2", "R:A:Q1-3"]),
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

  it("コードが作った事項と同じ ID を使い回した応答は、行を足す前に C1 で断られ、2 回続けば malformed で止まる（Issue #464）", async () => {
    const surface = {
      ambiguities: [{ id: "OI:catalog:R-1:period", requirementId: "R-1", text: "重複した事項", critical: false }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      // やり直しの 2 回目も同じ応答（使い回しのまま）→ malformed
      structured(surface),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...coverAnswersFor([]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    // 段の失敗は malformed で、分類は issue-id-reused
    expect(result.failure?.kind).toBe("malformed");
    expect(result.failure?.problems?.some((problem) => problem.code === "issue-id-reused")).toBe(true);
    // 断った件の記録（版 1・試行 1 と 2）。同じ ID が目録と仮の既定の両方に当たる
    expect(result.surfaceIdReuse).toEqual([
      { check: 1, attempt: 1, responses: 1, distinctIds: 1, bySource: idReuseBySource({ catalog: 1, defaults: 1 }) },
      { check: 1, attempt: 2, responses: 1, distinctIds: 1, bySource: idReuseBySource({ catalog: 1, defaults: 1 }) },
    ]);
    // 行を足す前に断るので、P4 は呼ばない（衝突の停止にも至らない）
    expect(result.stages.some((stage) => stage.stage === "questions")).toBe(false);
    expect(result.openIssueConflicts.ids).toBe(0);
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
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...catalogAnswersFor(Array.from({ length: 10 }, (_value, index) => `R:A:Q1-${index + 1}`)),
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
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const responder: PlanResponder = ALL_RECOMMENDED;
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...catalogAnswersFor(Array.from({ length: 10 }, (_value, index) => `R:A:Q1-${index + 1}`)),
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

// ── Issue #447：P4 の形のやり直しに、前回の問題をデータで渡す ─────────────────

describe("P4 の形のやり直しに、前回の問題をデータで渡す（Issue #447）", () => {
  /** `<data name="…">…</data>` の中身を取り出す（データの欄ごとに確かめる） */
  const dataBlockOf = (input: string, name: string): string =>
    input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "";

  it("P4 が覆いの検査に 1 回落ちて 2 回目で通る走りでは、2 つ目の P4 の要求だけが塊を持ち、分類が question-coverage である", async () => {
    const surface = {
      ambiguities: [
        { id: "OI-a", requirementId: "R-1", text: "問い a", critical: true },
        { id: "OI-b", requirementId: "R-1", text: "問い b", critical: false },
      ],
      unwritable: [],
    };
    // 2 回目の応答は、重大な OI-a と、残り 10 問に収まる重大でない OI-b の両方を覆う
    const both = {
      questions: [
        ...(questionsFor("OI-a", "Q-1").questions as readonly object[]),
        ...(questionsFor("OI-b", "Q-2").questions as readonly object[]),
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
      // P4 の 1 回目は重大な OI-a だけを聞き、収まるのに覆わない OI-b が残る（覆いの検査に落ちる）
      structured(questionsFor("OI-a", "Q-1")),
      structured(both),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q1-2"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q1-2"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED));

    // 2 回目の応答が覆いの検査を通り、走りは確定まで進む（P4 の 2 回落ちの停止にはならない）
    expect(result.kind).toBe("confirmed");
    const p4 = recording.structured.filter((request) => request.schemaName === QUESTIONS_SCHEMA_NAME);
    expect(p4).toHaveLength(2);
    expect(p4[0]?.input).not.toContain("前回の形の問題");
    expect(p4[1]?.input).toContain("前回の形の問題");
    // 塊には、前回の問題の分類（question-coverage）が入る
    const problems = JSON.parse(dataBlockOf(p4[1]?.input ?? "", "前回の形の問題")) as readonly {
      readonly field: string;
      readonly code?: string;
    }[];
    expect(problems.some((problem) => problem.field === "questions" && problem.code === "question-coverage")).toBe(true);
    // 塊を持つ要求は、走り全体で 2 つ目の P4 の要求だけである
    expect(recording.structured.filter((request) => request.input.includes("前回の形の問題"))).toHaveLength(1);
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
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const responder: PlanResponder = {
      async answer(request) {
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

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

  it("確定できない結果（P2 の覆いの落ち）でも、往復ごとの内訳が残る", async () => {
    const recording = createRecordingClient([
      structured(THREE_REQUIREMENTS),
      structured(REVERSE_CHECK_OUTPUT),
      structured(THREE_REQUIREMENTS),
      structured(REVERSE_CHECK_OUTPUT),
    ]);

    const result = await runPlan(
      makePlanInput(recording.client, createFakeJudge({}), ANSWER_NONE, { source: THREE_SOURCE }),
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
      structured(questionsFor("OI:surface-check:1:2")),
      structured(SURFACE_OUTPUT_CLEAR),
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
      ...catalogAnswersFor(["R:A:Q1-1"]),
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
    expect(asked[0]?.questions.map((question) => question.openIssueId)).toEqual(["OI:surface-check:1:2"]);
    expect(result.plan.open_issues.find((issue) => issue.id === "OI:surface-check:1:2")?.status).toBe("resolved");
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
    // 「書いていない」を再点検（Luna）に回すが、根拠が取れない → 未点検（根拠不足）のまま
    const recheckJudge = createFakeJudge({
      [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceRecheckEvidenceQuestionName(0)]: choice(SURFACE_RECHECK_NO_EVIDENCE, 0.9),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder, { recheckJudge }));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 理由は有限の分類と、添字つきの欄の名前と点検の番号だけ（値の中身を含まない。Issue #432・#434）
    expect(result.reasons).toEqual([
      { source: "surface-check", code: "not-stated", path: "unwritable[0]", check: 1 },
    ]);
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
    // 最初の判定の予約が失敗しても、全申告が未実行の印で診断に残る（Issue #432。申告 0 件と区別できる）
    expect(result.surfaceCheckDiagnostics).toEqual([
      expect.objectContaining({
        index: 0,
        requirementId: "R-1",
        stage: "unexecuted",
        classification: "unexecuted",
        docVersion: "v1",
      }),
    ]);
  });

  it("仕分けの確信度が閾値未満なら、落とさず（not-a-problem でも）未点検にして確定させない", async () => {
    const surface = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-1", part: "部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
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
    const judge = createFakeJudge({
      ...catalogAnswers(),
      // not-a-problem でも、仕分けの確信度が閾値未満 → 落とさず再点検へ回す
      [surfaceTriageQuestionName(0)]: choice("not-a-problem", 0.1),
    });
    // 再点検も判定不能 → 未点検（確定させない）
    const recheckJudge = createFakeJudge({
      [surfaceRecheckKindQuestionName(0)]: choice("undecidable", 0.9),
      [surfaceRecheckEvidenceQuestionName(0)]: choice(SURFACE_RECHECK_NO_EVIDENCE, 0.9),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder, { recheckJudge }));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([{ source: "surface-check", code: "unknown", path: "unwritable[0]", check: 1 }]);
    // P4 も答える役も呼ばれない
    expect(answerCalls).toBe(0);
    expect(result.stages.some((stage) => stage.stage === "questions")).toBe(false);
    expect(result.surfaceCheck.dropped).toBe(0);
    expect(result.surfaceCheck.unchecked).toBe(1);
  });

  it("仕分けのあと裏付けの予算が尽きても、仕分けまでに得た分類と判定が結果に残る（completed は false）", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    // 申告 2 件：1 件目は「問題ではない」で落ち、2 件目は語彙の穴で裏付けへ進む（そこで予算が尽きる）
    const surface = {
      ambiguities: [],
      unwritable: [
        { id: "U-0", requirementId: "R-1", part: "部分 0", constraintIds: ["記録"], reason: "理由 0", alternative: "代案 0" },
        { id: "U-1", requirementId: "R-2", part: "部分 1", constraintIds: ["合計"], reason: "理由 1", alternative: "代案 1" },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
    ]);
    // 仕分けの判定は答えつつ、巨大な usage（LLM の adapter）で予算を使い切る → 裏付けの予約が失敗する
    const triageAnswers: Record<string, JudgeAnswer> = {
      [surfaceTriageQuestionName(0)]: choice("not-a-problem", 0.9),
      [surfaceTriageQuestionName(1)]: choice("vocabulary-hole", 0.9),
    };
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        const answers: Record<string, JudgeAnswer> = {};
        let triage = false;
        for (const name of Object.keys(request.questions)) {
          if (name.startsWith("plan-triage:")) triage = true;
          answers[name] = triageAnswers[name] ?? choice("supports", 0.9);
        }
        // 仕分けの呼び出しだけ巨大な usage（LLM の adapter）で予算を使い切る → 裏付けの予約が失敗する
        return triage
          ? { answers, inputTokens: 0, usage: hugeUsage, model: "judge", answeredBy: "llm" }
          : { answers, inputTokens: 0, model: "judge", answeredBy: "fake" };
      },
    };

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE, { budgetUsd: 1 }));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("budget");
    expect(result.failure?.stage).toBe("surface-check");
    expect(result.failure?.kind).toBe("budget");
    // 途中までの記録が結果に残る（全件 0 と区別できる）
    expect(result.surfaceCheck.completed).toBe(false);
    expect(result.surfaceCheck.dropped).toBe(1);
    expect(result.surfaceCheck.judgments).toHaveLength(2);
    expect(result.surfaceCheck.judgments.map((judgment) => judgment.answer)).toEqual([
      "not-a-problem",
      "vocabulary-hole",
    ]);
    // 受理はまだ 0（裏付けに届いていない）
    expect(result.surfaceCheck.accepted).toBe(0);
  });
});

// ── 判定も、生成と共有する締切・総呼び出し数の門を通る（Issue #432）─────────────

describe("判定も、生成と共有する締切・総呼び出し数の門を通る（Issue #432）", () => {
  /** 仕分けが確信度不明（閾値未満）で、再点検へ回る 1 件の申告を持つ P3 の出力 */
  const SURFACE_RECHECK_ONE = {
    ambiguities: [],
    unwritable: [
      { id: "U-0", requirementId: "R-1", part: "部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
    ],
  };

  it("再点検の間に締切を越えたら、確認へ進まず deadline で止まる", async () => {
    let clock = 0;
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_RECHECK_ONE),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      // 仕分けは確信度不明 → 再点検へ
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole"),
    });
    // 再点検の間に時計が進み、締切を越える
    const recheckJudge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        clock = 2_000;
        return createFakeJudge({
          [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
          [surfaceRecheckEvidenceQuestionName(0)]: choice("記録", 0.9),
        }).judge(request);
      },
    };

    const result = await runPlan(
      makePlanInput(recording.client, judge, ANSWER_NONE, { deadline: 1_000, now: () => clock, recheckJudge }),
    );

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("deadline");
    expect(result.failure?.stage).toBe("surface-check");
    expect(result.failure?.kind).toBe("deadline");
  });

  it("生成で呼び出し上限に達したら、再点検を開始せず call-limit で止まる", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_RECHECK_ONE),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole"),
    });
    // 再点検の口を渡す（合算の上限が「実際に再点検できる口」に掛かることを確かめる）
    let recheckCalls = 0;
    const recheckJudge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        recheckCalls += 1;
        return createFakeJudge({
          [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
          [surfaceRecheckEvidenceQuestionName(0)]: choice("記録", 0.9),
        }).judge(request);
      },
    };

    const result = await runPlan(
      makePlanInput(recording.client, judge, ANSWER_NONE, {
        limits: { ...AGENT_LIMITS, callCount: 5 },
        recheckJudge,
      }),
    );

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("call-limit");
    expect(result.failure?.stage).toBe("surface-check");
    expect(result.failure?.kind).toBe("call-limit");
    // 仕分けは終わっている（その判定の記録が残る）が、再点検は開始していない
    expect(result.surfaceCheck.judgments.map((judgment) => judgment.questionId)).toEqual(["plan-triage:0"]);
    expect(recheckCalls).toBe(0);
    expect(result.surfaceCheck.accepted).toBe(0);
  });

  it("生成の再試行も、判定と合算した上限に掛かる", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);
    const base = recording.client;
    // 生成側の実呼び出しの 4 回目（P4 の最初の問いの呼び出し）で、やり直してよい誤りを返す
    let calls = 0;
    const client: LlmClient = {
      callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        if (calls === 4) return Promise.reject(Object.assign(new Error("通信の誤り"), { kind: "network" }));
        return base.callStructured<T>(request);
      },
      callWithTools: (request: LlmToolRequest): Promise<LlmToolResponse> => base.callWithTools(request),
    };
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers("A:Q1-1") });
    const responder: PlanResponder = {
      async answer() {
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(
      makePlanInput(client, judge, responder, { limits: { ...AGENT_LIMITS, callCount: 5 } }),
    );

    // 合算の上限（5）に達しているので、生成の再試行は開始できない → 段 questions が call-limit で止まる
    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("call-limit");
    expect(result.failure?.stage).toBe("questions");
    expect(result.failure?.kind).toBe("call-limit");
    // 実際に試した生成の呼び出しは 4 回（再試行は開始していない）
    expect(calls).toBe(4);
  });

  it("P6 の判定が締切を越えて返ったら、confirmed を返さず deadline で止まる", async () => {
    let clock = 0;
    const deadline = 1_000;
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const base = createFakeJudge({
      ...catalogAnswers(),
      [confirmQuestionName("S-1")]: noul(0.95),
      [confirmQuestionName("S-2")]: noul(0.95),
    });
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        // P6 の覆いの判定で、**締切を越えて**返る（遅い応答）
        if (Object.keys(request.questions).some((name) => name.startsWith("cover:"))) clock = deadline + 1;
        return base.judge(request);
      },
    };
    const responder: PlanResponder = {
      async answer() {
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(
      makePlanInput(recording.client, judge, responder, { now: () => clock, deadline }),
    );

    // 遅い応答を成功にしない——締切後に confirmed を返さない
    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("deadline");
    expect(result.failure?.stage).toBe("confirm");
    expect(result.failure?.kind).toBe("deadline");
  });

  it("総呼び出し数の上限ちょうどで正常に終わったら、上限の停止にせず確定を返す", async () => {
    // 生成 3 回（要件・逆照合・P3）＋目録判定 1 回＋P6 判定 1 回 = 合計 5。上限も 5（ちょうど）
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      [confirmQuestionName("S-1")]: noul(0.95),
      [confirmQuestionName("S-2")]: noul(0.95),
    });

    const result = await runPlan(
      makePlanInput(recording.client, judge, ANSWER_NONE, { limits: { ...AGENT_LIMITS, callCount: 5 } }),
    );

    // 上限ちょうどで終わった Plan を、上限の停止と誤って報告しない（締切も過ぎていない）
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
  });

  it("落とし先（Luna）の口が無い入力では、主（Jev）を再点検に使わず、低確信を受理しない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_RECHECK_ONE),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      // 仕分けは低確信（語彙の穴）→ 再点検へ回したい
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.1),
      // 主が万一再点検に使われたら受理してしまう答えを持たせておく（使われないことを確かめる）
      [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceRecheckEvidenceQuestionName(0)]: choice("記録", 0.9),
    });

    // recheckJudge を渡さない（落とし先が無い）
    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.surfaceCheck.accepted).toBe(0);
    expect(result.reasons).toEqual([{ source: "surface-check", code: "unknown", path: "unwritable[0]", check: 1 }]);
  });
});

// ── 要件にする段のやり直しが、次の呼び出しの前に始まらないときの記録（Issue #478）──────
//
// P1（要件にする）の 1 回目の応答が形に落ちると、段はやり直しを決めて告げる（`noteRetry("shape")`）。
// そのあと 2 回目の呼び出しの前に締切が尽きると、やり直しの数だけが 1 になり、実開始は初回の 1 のまま
// 止まる。段の記録（`requirements`）で、その未着手のやり直しを固定する。

describe("要件にする段のやり直しが、次の呼び出しの前に始まらないときの記録（Issue #478）", () => {
  it("1 回目の応答が形に落ち、2 回目の前に締切が尽きると、stopped（deadline）で、段の記録が形 1・開始 1・未着手（締切）1 になる", async () => {
    let clock = 0;
    const recording = createRecordingClient([structured({ requirements: "だめ" })]);
    const base = recording.client;
    let calls = 0;
    const client: LlmClient = {
      callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        const pending = base.callStructured<T>(request);
        // 1 回目の応答のあと、締切を越える——2 回目の開始は門（締切）で断られる
        if (calls === 1) clock = 1_001;
        return pending;
      },
      callWithTools: (request: LlmToolRequest): Promise<LlmToolResponse> => base.callWithTools(request),
    };

    const result = await runPlan(
      makePlanInput(client, createFakeJudge({}), ANSWER_NONE, { now: () => clock, deadline: 1_000 }),
    );

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("deadline");
    const requirements = result.stages.find((stage) => stage.stage === "requirements");
    expect(requirements?.status).toBe("failed");
    expect(requirements?.failure_kind).toBe("deadline");
    // 初回は始まって応答があり、形に落ちてやり直しを決めたが、2 回目は締切で始まらない
    expect(requirements?.attempts).toEqual({
      started: 1,
      responded: 1,
      errors: 0,
      cancelled_deadline: 0,
      cancelled_timeout: 0,
      not_started: { deadline: 1, budget: 0, limit: 0, timeout: 0 },
    });
    expect(requirements?.retries).toEqual({ communication: 0, shape: 1, content: 0 });
  });
});

// ── 判定の包みが、共有の門を Jev の内部の再送へ届ける（04 §2・Issue #469）────────────
//
// 実経路では、Jev の adapter は**作るときに門を渡さず**、門は `runPlan` の中で作られる。包み
// （`createBudgetedJudge`）が門を**要求**に載せるので、Jev が 429・529 のあと内部で再送する各回も、
// 生成と共有する門の回数に入る。生成 2（P1・P2）のあとに目録の判定（P3）で Jev を呼ぶ経路で、
// (a) 上限に達したら fetch が上限を越えないこと、(b) 余裕があれば再送が 1 回だけ通ることを固定する。

/** 差し込む `fetch` が状態コードの列を返す、Jev の adapter（門は作るときに渡さない。実経路と同じ） */
function jevFetch(statuses: readonly number[]): { readonly fetch: JevFetch; readonly calls: () => number } {
  let calls = 0;
  const fetchImpl: JevFetch = async (_url, init) => {
    calls += 1;
    const status = statuses[calls - 1] ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "busy" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    // 目録の問いはすべて Noul なので、「はい」を返せば未指定の観点を作らない
    const body = JSON.parse(String(init.body)) as { questions: Record<string, { type: string }> };
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions)) {
      answers[name] = question.type === "noul" ? { noul: 1 } : { choice: "a", probabilities: { a: 1 } };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 10 }, answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls: () => calls };
}

describe("判定の包みが、共有の門を Jev の内部の再送へ届ける（04 §2・Issue #469）", () => {
  it("(a) 生成 2＋Jev の初回 1 のあと 429 なら、門が上限に達して fetch 1・再送 0・後段 0 で call-limit に止まる", async () => {
    const recording = createRecordingClient([structured(REQUIREMENT_LIST_OUTPUT), structured(REVERSE_CHECK_OUTPUT)]);
    const jev = jevFetch([429, 429, 429, 429]);
    const judge = createJevJudge({ apiKey: "k", fetch: jev.fetch, maxAttempts: 4, sleep: async () => {} });

    const result = await runPlan(
      makePlanInput(recording.client, judge, ANSWER_NONE, { limits: { ...AGENT_LIMITS, callCount: 3 } }),
    );

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("call-limit");
    // 生成 2（P1・P2）＋ Jev の初回 1 で上限（3）に達し、再送は門が断る → Jev の実呼び出しは 1 回だけ
    expect(jev.calls()).toBe(1);
    expect(recording.structured).toHaveLength(2);
    // 後段の段は走らない
    expect(result.stages.map((stage) => stage.stage)).not.toContain("surface");
  });

  it("(b) 429 のあと 200 の組で上限 4 なら、生成 2＋初回 1＋再送 1＝4 で、次の実試行が 0", async () => {
    const recording = createRecordingClient([structured(REQUIREMENT_LIST_OUTPUT), structured(REVERSE_CHECK_OUTPUT)]);
    const jev = jevFetch([429, 200]);
    const judge = createJevJudge({ apiKey: "k", fetch: jev.fetch, maxAttempts: 4, sleep: async () => {} });

    const result = await runPlan(
      makePlanInput(recording.client, judge, ANSWER_NONE, { limits: { ...AGENT_LIMITS, callCount: 4 } }),
    );

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("call-limit");
    // Jev の初回（429）＋合法な再送 1（200）＝ fetch 2。門に余裕があるので再送は通る
    expect(jev.calls()).toBe(2);
    // 生成は P1・P2 の 2 回だけ。上限（4）に達したので、次の実試行（洗い出し）は 0
    expect(recording.structured).toHaveLength(2);
  });
});

// ── Issue #434：P5 で増えた要件を、確認の前に差分点検に掛ける ──────────────────

/** `<data name="…">…</data>` の中身を取り出す（データの欄ごとに確かめる） */
const dataBlockOf = (input: string, name: string): string =>
  input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "";

/** 差分点検の洗い出しが返す、重大な事項 1 件（差分の要件に由来する） */
const DIFF_CRITICAL = {
  ambiguities: [{ id: "OI-diff", requirementId: "R:A:Q1-1", text: "差分で開いた重大な事項", critical: true }],
  unwritable: [],
};

/** 差分点検の申告の点検へ回す、書けない申告 1 件（差分の要件に由来する。制約 ID は文書に実在する） */
const DIFF_UNWRITABLE = {
  ambiguities: [],
  unwritable: [
    { id: "U-0", requirementId: "R:A:Q1-1", part: "差分の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
  ],
};

describe("差分点検：その往復で増えた要件だけを点検し、文脈は参照用に渡す（04 §3 P3・Issue #434）", () => {
  it("答えで増えた要件だけが目録・洗い出しの対象になり、別の問いに由来する既存要件と決定は文脈に見え、段の記録に 2 回目の 3 段が並ぶ", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_MIX),
      structured(ROUND_1_QUESTION),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(ROUND_2_QUESTION),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const requests: JudgeRequest[] = [];
    const inner = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        requests.push(request);
        return inner.judge(request);
      },
    };
    const responder: PlanResponder = {
      async answer(request) {
        // 各往復とも、提示された最初の問いだけに答える（1 往復目は OI-1、2 往復目は OI-2）
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;

    // 1 往復目の差分点検の目録は、増えた要件 R:A:Q1-1 だけを問いの名前にする（既存の R-1 は対象にしない）
    const first = requests.find((request) => Object.keys(request.questions).includes(catalogGateQuestionName("R:A:Q1-1")));
    expect(first).toBeDefined();
    expect(Object.keys(first?.questions ?? {})).toContain(catalogGateQuestionName("R:A:Q1-1"));
    expect(Object.keys(first?.questions ?? {})).not.toContain(catalogGateQuestionName("R-1"));

    // 2 往復目の差分点検の目録は R:A:Q2-1 だけ（前の往復で増えた R:A:Q1-1 を点検し直さない）
    const second = requests
      .filter((request) => Object.keys(request.questions).includes(catalogGateQuestionName("R:A:Q2-1")))
      .at(-1);
    expect(second).toBeDefined();
    expect(Object.keys(second?.questions ?? {})).not.toContain(catalogGateQuestionName("R:A:Q1-1"));

    // 洗い出しは初回 + 差分 2 回。2 回目の差分の要求では、対象（要件の一覧）は R:A:Q2-1 だけである。
    // 拾う条件は「初回の名前か差分専用の名前」に広げる（差分区間は差分専用の名前を使う。Issue #483）。
    const surfaceRequests = recording.structured.filter(
      (request) => request.schemaName === SURFACE_SCHEMA_NAME || request.schemaName === SURFACE_DIFF_SCHEMA_NAME,
    );
    expect(surfaceRequests).toHaveLength(3);
    const secondDiff = surfaceRequests[2];
    const target = dataBlockOf(secondDiff?.input ?? "", "要件の一覧");
    expect(target).toContain("R:A:Q2-1");
    expect(target).not.toContain("R:A:Q1-1");
    // 参照用の文脈には、別の問いに由来する既存要件（R:A:Q1-1）と、既存の決定（D-1）が見える
    const contextAll = dataBlockOf(secondDiff?.input ?? "", "点検時点の全要件");
    expect(contextAll).toContain("R:A:Q1-1");
    expect(contextAll).toContain("R-1");
    const contextDecisions = dataBlockOf(secondDiff?.input ?? "", "既存の決定");
    expect(contextDecisions).toContain("D-1");
    // 関係する問いと答えのデータがある
    expect(dataBlockOf(secondDiff?.input ?? "", "関係する問いと答え")).toContain("A:Q2-1");
    // 了承除外はまだ無い
    expect(dataBlockOf(secondDiff?.input ?? "", "了承除外").trim()).toBe("[]");

    // 段の記録に、2 回目の catalog・surface・surface-check が往復のあとに並ぶ
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "requirements",
      "catalog",
      "surface",
      "surface-check",
      "questions",
      "answers",
      "catalog",
      "surface",
      "surface-check",
      "questions",
      "answers",
      "catalog",
      "surface",
      "surface-check",
      "confirm",
    ]);
    // 差分点検の記録（往復ごとに 1 件。値ではなく件数）
    expect(result.diffReviews).toEqual([
      { round: 1, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) },
      { round: 2, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) },
    ]);
  });

  it("増えた要件が 0 件の往復では、差分点検の段を呼ばない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        round += 1;
        if (round === 1) {
          // 答えの ID が空 → 採られず、要件が増えない
          return {
            kind: "answers",
            answers: [
              { id: "", questionId: request.questions[0]?.id ?? "", revision: request.questions[0]?.revision ?? 1, choiceId: "c1" },
            ],
          };
        }
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q2-1"]),
      ...coverAnswers("A:Q2-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    // 差分点検は 2 往復目でだけ走る（1 往復目は増えた要件が 0 件）
    expect(result.diffReviews).toEqual([{ round: 2, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) }]);
    // 目録の段は初回と 2 往復目でだけ（1 往復目の分は無い）
    expect(result.stages.filter((stage) => stage.stage === "catalog")).toHaveLength(2);
  });
});

// ── Issue #483：差分の洗い出しの enum を、その往復の差分から組む ──────────────────

describe("差分点検：差分の洗い出しの enum は、その往復の差分の要件 ID だけである（04 §3 P3・Issue #483）", () => {
  /** 要求の schema の、要件 ID の欄の `enum` を読む（差分専用の schema だけが持つ） */
  function enumOf(request: LlmStructuredRequest | undefined): readonly string[] | undefined {
    const schema = request?.schema as
      | { properties?: { ambiguities?: { items?: { properties?: { requirementId?: { enum?: readonly string[] } } } } } }
      | undefined;
    return schema?.properties?.ambiguities?.items?.properties?.requirementId?.enum;
  }

  it("初回は SURFACE_SCHEMA のまま、差分の各往復は、その往復の差分の要件 ID だけを enum に持つ", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_MIX),
      structured(ROUND_1_QUESTION),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(ROUND_2_QUESTION),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });
    const responder: PlanResponder = {
      async answer(request) {
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(makePlanInput(recording.client, judge, responder));
    expect(result.kind).toBe("confirmed");

    const surfaceRequests = recording.structured.filter(
      (request) => request.schemaName === SURFACE_SCHEMA_NAME || request.schemaName === SURFACE_DIFF_SCHEMA_NAME,
    );
    expect(surfaceRequests).toHaveLength(3);
    // 初回の洗い出しは、SURFACE_SCHEMA_NAME と SURFACE_SCHEMA のままで、enum を持たない
    expect(surfaceRequests[0]?.schemaName).toBe(SURFACE_SCHEMA_NAME);
    expect(surfaceRequests[0]?.schema).toBe(SURFACE_SCHEMA);
    expect(enumOf(surfaceRequests[0])).toBeUndefined();
    // 1 往復目の差分は、差分専用の名前で、その往復の差分（R:A:Q1-1）だけを enum に持つ
    expect(surfaceRequests[1]?.schemaName).toBe(SURFACE_DIFF_SCHEMA_NAME);
    expect(enumOf(surfaceRequests[1])).toEqual(["R:A:Q1-1"]);
    // 2 往復目は、その往復の差分（R:A:Q2-1）だけで、1 往復目の差分の ID を含まない
    expect(surfaceRequests[2]?.schemaName).toBe(SURFACE_DIFF_SCHEMA_NAME);
    expect(enumOf(surfaceRequests[2])).toEqual(["R:A:Q2-1"]);
  });
});

describe("差分点検：新しく開いた重大な事項を、同じ上限の中で扱う（04 §3 P3・Issue #434）", () => {
  it("差分の洗い出しが返した重大な事項は、残りの問数に収まれば次の往復で聞かれて確定する", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(DIFF_CRITICAL),
      structured(questionsFor("OI-diff")),
      structured(SURFACE_OUTPUT_CLEAR),
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
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 2 往復目に、差分で開いた重大な事項が聞かれる
    expect(asked).toHaveLength(2);
    expect(asked[1]?.questions.map((question) => question.openIssueId)).toEqual(["OI-diff"]);
    // 差分点検の記録（1 往復目で事項 1 件を開き、2 往復目の答えでも 1 件増えた）
    expect(result.diffReviews).toEqual([
      { round: 1, added: 1, openIssues: 1, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1, openBySource: { surface: 1 } }) },
      { round: 2, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) },
    ]);
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-diff")?.status).toBe("resolved");
  });

  it("差分の洗い出しが返した重大な事項が残りの問数に収まらなければ、確定できない（session）", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(TEN_ISSUES_SURFACE),
      structured(TEN_QUESTIONS),
      structured(DIFF_CRITICAL),
    ]);
    const responder: PlanResponder = ALL_RECOMMENDED;
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(Array.from({ length: 10 }, (_value, index) => `R:A:Q1-${index + 1}`)),
      ...coverAnswersFor(Array.from({ length: 10 }, (_value, index) => `A:Q1-${index + 1}`)),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 問数の上限に触れたので、残った重大な事項を聞けない
    expect(result.reasons).toEqual([{ source: "session", code: "question-limit", path: "open_issues" }]);
    expect(result.openIssues.map((issue) => issue.id)).toContain("OI-diff");
    // P6 を呼ばない
    expect(result.stages.some((stage) => stage.stage === "confirm")).toBe(false);
  });

  it("別の問いから増えた要件どうしの矛盾が重大な事項として返れば、未解決のまま確定しない", async () => {
    const contradiction = {
      ambiguities: [{ id: "OI-contra", requirementId: "R:A:Q2-1", text: "差分の要件どうしの矛盾", critical: true }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_MIX),
      structured(ROUND_1_QUESTION),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(ROUND_2_QUESTION),
      structured(contradiction),
      structured(questionsFor("OI-contra")),
    ]);
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        round += 1;
        if (round === 3) {
          // 3 往復目は答えない → 矛盾の事項が未解決のまま残る
          return { kind: "answers", answers: [] };
        }
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 矛盾の事項が開いたまま残る（聞いても答えが無いので未解決）
    expect(result.openIssues.map((issue) => issue.id)).toContain("OI-contra");
    expect(result.reasons).toEqual([{ source: "session", code: "round-trip-limit", path: "open_issues" }]);
  });
});

describe("差分点検：目録の未指定の観点が、既定の適用と上限に載る（04 §3・Issue #434）", () => {
  it("差分の目録が返した重大でない観点は、適用条件に合えば次の既定の適用で閉じ、問数を消費しない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const responder: PlanResponder = ALL_RECOMMENDED;
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogUnspecifiedFor({ "R:A:Q1-1": ["period"] }, ["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 差分の目録が開いた period は、非重大で適用条件に合うので既定で閉じる（問数を消費しない）
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R:A:Q1-1:period", facetId: "period", value: "期間の条件を足さない" },
    ]);
    expect(result.diffReviews).toEqual([{ round: 1, added: 1, openIssues: 1, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1, openBySource: { catalog: 1 } }) }]);
    // 2 往復目は無い（既定で閉じたので問いを出さない）
    expect(result.stages.filter((stage) => stage.stage === "questions")).toHaveLength(1);
  });

  it("差分の目録が返した重大な観点は、既定では閉じず、次の往復で聞いて確定する", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(questionsFor("OI:catalog:R:A:Q1-1:aggregation")),
      structured(SURFACE_OUTPUT_CLEAR),
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
      ...catalogUnspecifiedFor({ "R:A:Q1-1": ["aggregation"] }, ["R:A:Q1-1"]),
      ...catalogAnswersFor(["R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 重大な観点は、2 往復目に聞かれる
    expect(asked[1]?.questions.map((question) => question.openIssueId)).toEqual([
      "OI:catalog:R:A:Q1-1:aggregation",
    ]);
    expect(result.closedByDefault).toEqual([]);
  });
});

describe("差分点検：書けない申告を、確認の前に点検する（04 §3 P3・Issue #434）", () => {
  it("点検で受理された申告だけが了承除外と代わりの案になり、確認の SHA がその仕様から計算される", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(DIFF_UNWRITABLE),
    ]);
    const responder: PlanResponder = ALL_RECOMMENDED;
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 受理した申告が、了承除外と代わりの案になる
    expect(result.plan.accepted_unwritable).toHaveLength(1);
    expect(result.plan.accepted_unwritable[0]?.part_id).toBe("P:U-0");
    expect(result.plan.accepted_unwritable[0]?.alternative_id).toBe("R:alt:U-0");
    expect(result.plan.requirements.map((requirement) => requirement.id)).toContain("R:alt:U-0");
    // 確認の SHA が、点検後の仕様から計算される
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    expect(await isConfirmationValid(result.plan)).toBe(true);
    expect(result.plan.confirmation.sha256).toBe(await planDigest(result.plan));
    // 差分点検の記録に、了承除外に加えた件数が残る
    expect(result.diffReviews).toEqual([{ round: 1, added: 1, openIssues: 0, acceptedUnwritable: 1, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) }]);
    // 差分の点検の受理が、結果の要約にも積まれる（初回は申告 0 件なので、合計 1 件。Issue #434）
    expect(result.surfaceCheck.accepted).toBe(1);
    expect(result.surfaceCheck.completed).toBe(true);
    expect(result.surfaceCheck.judgments.map((judgment) => judgment.questionId)).toEqual([
      "plan-triage:0",
      "plan-support:0",
    ]);
  });

  it("差分の申告の点検が未点検なら、確認も呼ばずに確定できない（surface-check）", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(DIFF_UNWRITABLE),
    ]);
    let confirmCalls = 0;
    const responder: PlanResponder = {
      async answer() {
        return { kind: "all-recommended" };
      },
      async confirm() {
        confirmCalls += 1;
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      // 裏付けが「書いていない」→ 落とし先（Luna）が無いので未点検
      [surfaceSupportQuestionName(0)]: choice("not-stated", 0.9),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 差分点検は 2 回目の点検（初回は申告 0 件）なので、点検の番号は 2
    expect(result.reasons).toEqual([{ source: "surface-check", code: "unknown", path: "unwritable[0]", check: 2 }]);
    // 未点検が、結果の要約にも積まれる（0 件に見せない。Issue #434）
    expect(result.surfaceCheck.unchecked).toBe(1);
    expect(result.surfaceCheck.accepted).toBe(0);
    expect(result.surfaceCheck.completed).toBe(true);
    // 確認も P6 も呼ばない
    expect(confirmCalls).toBe(0);
    expect(result.stages.some((stage) => stage.stage === "confirm")).toBe(false);
  });
});

describe("差分点検：「全部推奨」の後の新しい束と、上限（04 §3・Issue #434）", () => {
  it("全部推奨の後に差分点検で重大な事項が増えると、残枠があれば 2 往復目に質問し、それまでの答えと消費した問数が保たれる", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(DIFF_CRITICAL),
      structured(questionsFor("OI-diff")),
      structured(SURFACE_OUTPUT_CLEAR),
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
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(asked).toHaveLength(2);
    // 2 往復目に、差分で開いた事項が聞かれる
    expect(asked[1]?.questions.map((question) => question.openIssueId)).toEqual(["OI-diff"]);
    // 消費した問数が保たれ、残りが減っている（1 問答えた後の 2 往復目）
    expect(asked[1]?.remaining.questions).toBeLessThan(asked[0]?.remaining.questions ?? Infinity);
    // それまでの答えは保たれる
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-extra")?.resolution?.answer_id).toBe("A:Q1-1");
  });

  it("全部推奨の後に差分点検で重大な事項が増え、残枠が無ければ、確認も Build も呼ばない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(TEN_ISSUES_SURFACE),
      structured(TEN_QUESTIONS),
      structured(DIFF_CRITICAL),
    ]);
    let confirmCalls = 0;
    const responder: PlanResponder = {
      async answer() {
        return { kind: "all-recommended" };
      },
      async confirm() {
        confirmCalls += 1;
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(Array.from({ length: 10 }, (_value, index) => `R:A:Q1-${index + 1}`)),
      ...coverAnswersFor(Array.from({ length: 10 }, (_value, index) => `A:Q1-${index + 1}`)),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    expect(confirmCalls).toBe(0);
    expect(result.stages.some((stage) => stage.stage === "confirm")).toBe(false);
  });
});

// ── Issue #434：応答が指す要件 ID を、この往復の差分の集合へ照合する ─────────────

describe("差分点検：応答が指す要件 ID を、この往復の差分の集合へ照合する（04 §3 P3・Issue #434）", () => {
  it("参照用に渡しただけの既存の要件を指す申告は、受理せず確定させない", async () => {
    const badDiff = {
      ambiguities: [{ id: "OI-bad", requirementId: "R-1", text: "既存の要件を指す", critical: true }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      // 1 試行目が対象の照合で落ち、2 試行目（やり直し）も同じ誤りを返す（Issue #484）
      structured(badDiff),
      structured(badDiff),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface");
    expect(result.failure?.kind).toBe("unmet");
    expect(result.failure?.problems).toEqual([
      { field: "ambiguities[0].requirementId", code: "requirement-id-unknown" },
    ]);
    // 誤りの文に要件 ID の値を入れない
    expect(JSON.stringify(result.failure)).not.toContain("R-1");
  });

  it("前の往復の要件を指す申告は、受理せず確定させない（停止した往復も記録に数える）", async () => {
    const badDiff = {
      ambiguities: [{ id: "OI-bad", requirementId: "R:A:Q1-1", text: "前の往復の要件を指す", critical: true }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_MIX),
      structured(ROUND_1_QUESTION),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(ROUND_2_QUESTION),
      // 2 往復目の差分の洗い出し：1 試行目と 2 試行目（やり直し）の両方が対象外を指す（Issue #484）
      structured(badDiff),
      structured(badDiff),
    ]);
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        round += 1;
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface");
    expect(result.failure?.kind).toBe("unmet");
    expect(result.failure?.problems).toEqual([
      { field: "ambiguities[0].requirementId", code: "requirement-id-unknown" },
    ]);
    expect(JSON.stringify(result.failure)).not.toContain("R:A:Q1-1");
    // 停止した往復（2 往復目）も、差分点検の記録に数えられる（Issue #434）
    // 2 往復目の対象外の参照（前の往復の要件 R:A:Q1-1 を指す未解決の事項）が、分類つきで残る
    expect(result.diffReviews).toEqual([
      { round: 1, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) },
      {
        round: 2,
        added: 1,
        openIssues: 0,
        acceptedUnwritable: 0,
        outOfScope: diffOutOfScope({
          ambiguities: 1,
          rejectedAmbiguities: 1,
          kinds: { "previous-answer": { ambiguities: 1 } },
        }),
        inherit: inheritRecord({ noParent: 1 }),
      },
    ]);
    expect(round).toBe(2);
  });
});

// ── Issue #483：enum を掛けても、制約 ID の裏付けと申告の意味の点検を省かない ────────

describe("差分点検：enum のあとも、制約 ID の裏付けと申告の点検を掛ける（04 §3 P3・Issue #483）", () => {
  it("対象内の要件 ID を指しても、文書に無い制約 ID を根拠にした申告は constraint-id-unknown で止まる", async () => {
    const unknownConstraint = {
      ambiguities: [],
      unwritable: [
        {
          id: "U-0",
          requirementId: "R:A:Q1-1",
          part: "差分の部分",
          constraintIds: ["文書に無い ID"],
          reason: "理由",
          alternative: "代案",
        },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(unknownConstraint),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface");
    expect(result.failure?.kind).toBe("unmet");
    expect(result.failure?.problems).toEqual([
      { field: "unwritable[0].constraintIds", code: "constraint-id-unknown" },
    ]);
  });

  it("対象内の要件 ID を指す申告でも、偽物の判定が裏付けを認めなければ、了承除外に入れない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(DIFF_UNWRITABLE),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      // 抜粋が主張に反する → 落とす（了承除外にしない。意味の独立の点検が働く）
      [surfaceSupportQuestionName(0)]: choice("contradicts", 0.95),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.plan.accepted_unwritable).toEqual([]);
    expect(result.plan.requirements.map((requirement) => requirement.id)).not.toContain("R:alt:U-0");
    expect(result.surfaceCheck.dropped).toBe(1);
    expect(result.surfaceCheck.accepted).toBe(0);
  });
});

// ── Issue #434：差分点検でも、途中停止の進捗を残す ───────────────────────────

/** 差分の洗い出しが返す、書けない申告 2 件（差分の要件に由来する。制約 ID は文書に実在する） */
const DIFF_TWO_CLAIMS = {
  ambiguities: [],
  unwritable: [
    { id: "U-0", requirementId: "R:A:Q1-1", part: "部分 0", constraintIds: ["記録"], reason: "理由 0", alternative: "代案 0" },
    { id: "U-1", requirementId: "R:A:Q1-1", part: "部分 1", constraintIds: ["合計"], reason: "理由 1", alternative: "代案 1" },
  ],
};

describe("差分点検：途中停止でも進捗を残す（04 §3 P3・Issue #432・#434）", () => {
  it("差分の点検の最初の予約が失敗しても、件数と未実行の診断が残る（completed は false）", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      // 差分の洗い出しの応答で予算を使い切る → 差分の申告の点検の最初の予約が失敗する
      structured(DIFF_UNWRITABLE, hugeUsage),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED, { budgetUsd: 1 }));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("budget");
    expect(result.failure?.stage).toBe("surface-check");
    expect(result.failure?.kind).toBe("budget");
    // 差分の点検の記録（開始時に積む）と、未実行の診断が残る
    expect(result.surfaceCheck.completed).toBe(false);
    expect(result.surfaceCheck.accepted).toBe(0);
    expect(result.surfaceCheckDiagnostics).toEqual([
      expect.objectContaining({ index: 0, requirementId: "R:A:Q1-1", stage: "unexecuted", classification: "unexecuted" }),
    ]);
    expect(result.diffReviews).toEqual([{ round: 1, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) }]);
  });

  it("差分の点検の裏付けが途中で止まっても、仕分けまでの分類と判定が残る（completed は false）", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(DIFF_TWO_CLAIMS),
    ]);
    const inner = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });
    const triageAnswers: Record<string, JudgeAnswer> = {
      [surfaceTriageQuestionName(0)]: choice("not-a-problem", 0.9),
      [surfaceTriageQuestionName(1)]: choice("vocabulary-hole", 0.9),
    };
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        const hasTriage = Object.keys(request.questions).some((name) => name.startsWith("plan-triage:"));
        if (!hasTriage) return inner.judge(request);
        const answers: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) answers[name] = triageAnswers[name] ?? choice("supports", 0.9);
        // 仕分けの呼び出しだけ巨大な usage で予算を使い切る → 裏付けの予約が失敗する
        return { answers, inputTokens: 0, usage: hugeUsage, model: "judge", answeredBy: "llm" };
      },
    };

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED, { budgetUsd: 1 }));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("budget");
    expect(result.failure?.stage).toBe("surface-check");
    // 仕分けまでに得た分類と判定が残る（全件 0 と区別できる）
    expect(result.surfaceCheck.completed).toBe(false);
    expect(result.surfaceCheck.dropped).toBe(1);
    expect(result.surfaceCheck.accepted).toBe(0);
    expect(result.surfaceCheck.judgments).toHaveLength(2);
    expect(result.surfaceCheckDiagnostics.map((claim) => claim.classification)).toEqual([
      "not-a-problem",
      "vocabulary-hole",
    ]);
    expect(result.diffReviews).toEqual([{ round: 1, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) }]);
  });
});

// ── Issue #434：差分の対象の選択（変更・削除の参照の解決）────────────────────

describe("差分の対象の選択：変更・削除は元の要件を引く（Issue #434）", () => {
  /** 要件 1 つを手で作る（`change` は任意） */
  function requirement(id: string, change?: PlanRequirement["change"]): PlanRequirement {
    return {
      id,
      text: id,
      kind: "constraining",
      origin: { input_id: "A:1", quote: id },
      ...(change === undefined ? {} : { change }),
      parts: [],
    };
  }

  it("added は対象、changed・removed は元の要件を引ければ対象、引けなければ unresolved", () => {
    const original = requirement("R-1");
    const added = requirement("R:A:Q1-1", { kind: "added", answer_id: "A:Q1-1" });
    // 同じ要件の変更（元は R-1）と、削除（元は R-1）
    const changed = requirement("R:A:Q1-2", { kind: "changed", from_requirement_id: "R-1", answer_id: "A:Q1-2" });
    const removed = requirement("R:A:Q1-3", { kind: "removed", from_requirement_id: "R-1", answer_id: "A:Q1-3" });
    // 分割の、増えた分（added）と、元の要件の変更（changed）
    const splitAdded = requirement("R:A:Q1-4", { kind: "added", answer_id: "A:Q1-4" });

    const all = [original, added, changed, removed, splitAdded];
    const selection = selectDiffRequirements(all, new Set());
    expect(selection.kind).toBe("targets");
    if (selection.kind !== "targets") return;
    // 変更を持たない要件は対象にしない。増えた・変わった・消えた分が対象になる
    expect(selection.targets.map((r) => r.id)).toEqual(["R:A:Q1-1", "R:A:Q1-2", "R:A:Q1-3", "R:A:Q1-4"]);

    // 既に点検した要件は、change を持っていても対象にしない（点検済みは ID ではなく変更の鍵で数える）
    const reviewedKeys = new Set([diffChangeKey(added) ?? ""]);
    const reviewed = selectDiffRequirements(all, reviewedKeys);
    if (reviewed.kind === "targets") {
      expect(reviewed.targets.map((r) => r.id)).toEqual(["R:A:Q1-2", "R:A:Q1-3", "R:A:Q1-4"]);
    }

    // 元の要件を解決できない changed・removed は、確定させない側に倒す
    const unknownFrom = requirement("R:A:Q1-5", { kind: "changed", from_requirement_id: "R-999", answer_id: "A:Q1-5" });
    expect(selectDiffRequirements([original, unknownFrom], new Set()).kind).toBe("unresolved");
    const noFrom = requirement("R:A:Q1-6", { kind: "removed", answer_id: "A:Q1-6" });
    expect(selectDiffRequirements([original, noFrom], new Set()).kind).toBe("unresolved");

    // 変更が無ければ、対象は空である
    expect(selectDiffRequirements([original], new Set())).toEqual({ kind: "targets", targets: [] });
  });

  it("同じ ID の要件でも、後の答えによる変更・削除は対象にする（ID だけで除外しない）", () => {
    const original = requirement("R-1");
    const added = requirement("R:A:Q1-1", { kind: "added", answer_id: "A:Q1-1" });
    // 先に added を点検済みにする
    const reviewedKeys = new Set([diffChangeKey(added) ?? ""]);

    // 同じ ID の、後の答えによる変更——鍵が変わるので対象になる
    const laterChanged = requirement("R:A:Q1-1", { kind: "changed", from_requirement_id: "R-1", answer_id: "A:Q1-2" });
    const selChanged = selectDiffRequirements([original, added, laterChanged], reviewedKeys);
    if (selChanged.kind === "targets") expect(selChanged.targets.map((r) => r.id)).toEqual(["R:A:Q1-1"]);

    // 同じ ID の、後の答えによる削除
    const laterRemoved = requirement("R:A:Q1-1", { kind: "removed", from_requirement_id: "R-1", answer_id: "A:Q1-3" });
    const selRemoved = selectDiffRequirements([original, added, laterRemoved], reviewedKeys);
    if (selRemoved.kind === "targets") expect(selRemoved.targets.map((r) => r.id)).toEqual(["R:A:Q1-1"]);

    // 同じ ID・同じ変更・同じ答えは、点検済みとして除外する（同じ変更を繰り返さない）
    const same = requirement("R:A:Q1-1", { kind: "added", answer_id: "A:Q1-1" });
    const selSame = selectDiffRequirements([original, same], reviewedKeys);
    if (selSame.kind === "targets") expect(selSame.targets).toEqual([]);

    // 同じ ID の後の変更でも、元の参照が解決できなければ確定させない
    const laterUnknown = requirement("R:A:Q1-1", { kind: "changed", from_requirement_id: "R-999", answer_id: "A:Q1-9" });
    expect(selectDiffRequirements([original, added, laterUnknown], reviewedKeys).kind).toBe("unresolved");
  });
});

// ── Issue #434：点検の番号で、判定・診断・停止理由を一意に引く ─────────────────

describe("差分点検：点検の番号で、判定・診断・停止理由を一意に引く（Issue #434）", () => {
  /** 問い 1 つを手で作る（ID は LLM 由来で、コードが `Q<版>-<n>` に組み直す） */
  function questionOf(openIssueId: string, id: string) {
    return {
      id,
      openIssueId,
      text: "どうしますか",
      choices: [
        { id: "c1", text: "こちら" },
        { id: "c2", text: "あちら" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    };
  }
  /** 初回の洗い出し：曖昧さ 3 件（3 往復に分ける）と、書けない申告 1 件（添字 0） */
  const ISSUES = {
    ambiguities: [
      { id: "OI-1", requirementId: "R-1", text: "曖昧 1", critical: true },
      { id: "OI-2", requirementId: "R-1", text: "曖昧 2", critical: true },
      { id: "OI-3", requirementId: "R-1", text: "曖昧 3", critical: true },
    ],
    unwritable: [
      { id: "U-0", requirementId: "R-1", part: "初回の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
    ],
  };
  /** 差分の洗い出し：書けない申告 1 件（添字 0） */
  const diffClaim = (requirementId: string, id: string) => ({
    ambiguities: [],
    unwritable: [{ id, requirementId, part: "差分の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" }],
  });

  it("初回と複数の差分が同じ添字 0 を使っても、点検の番号で一意に引ける（申告 0 件の点検と途中停止を挟む）", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      // 初回の洗い出し（点検 1 の申告。添字 0）
      structured(ISSUES),
      structured({ questions: [questionOf("OI-1", "Q-1"), questionOf("OI-2", "Q-2"), questionOf("OI-3", "Q-3")] }),
      // 1 往復目の差分（点検 2。申告 0 件）
      structured(SURFACE_OUTPUT_CLEAR),
      structured({ questions: [questionOf("OI-2", "Q-1"), questionOf("OI-3", "Q-2")] }),
      // 2 往復目の差分（点検 3。添字 0 の申告）
      structured(diffClaim("R:A:Q2-1", "U-1")),
      structured({ questions: [questionOf("OI-3", "Q-1")] }),
      // 3 往復目の差分（点検 4。予算を使い切って、最初の予約が失敗して止まる）
      structured(diffClaim("R:A:Q3-1", "U-2"), hugeUsage),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1", "R:A:Q3-1"]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    const responder: PlanResponder = {
      async answer(request) {
        // 各往復、提示された最初の問いだけに答える（1 往復に 1 要件ずつ増やす）
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(makePlanInput(recording.client, judge, responder, { budgetUsd: 1 }));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface-check");
    expect(result.failure?.kind).toBe("budget");
    // 判定は、点検の番号（1=初回、3=2 往復目の差分）つき。同じ問いの名前（添字 0）が点検で区別できる
    expect(result.surfaceCheck.judgments.map((judgment) => [judgment.check, judgment.questionId])).toEqual([
      [1, "plan-triage:0"],
      [1, "plan-support:0"],
      [3, "plan-triage:0"],
      [3, "plan-support:0"],
    ]);
    // 診断も点検の番号つき。申告 0 件の点検（2）は空、途中停止の点検（4）は未実行
    expect(result.surfaceCheckDiagnostics.map((claim) => [claim.check, claim.index, claim.classification])).toEqual([
      [1, 0, "supports"],
      [3, 0, "supports"],
      [4, 0, "unexecuted"],
    ]);
    expect(result.surfaceCheck.judgments.some((judgment) => judgment.check === 2)).toBe(false);
    expect(result.surfaceCheck.completed).toBe(false);
    // 差分点検の記録は往復ごとに 3 件（停止した往復も数える）
    expect(result.diffReviews).toEqual([
      { round: 1, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) },
      { round: 2, added: 1, openIssues: 0, acceptedUnwritable: 1, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) },
      { round: 3, added: 1, openIssues: 0, acceptedUnwritable: 0, outOfScope: NO_OUT_OF_SCOPE, inherit: inheritRecord({ noParent: 1 }) },
    ]);
  });
});

// ── Issue #434・§3：受理済み申告の再申告だけを重複として除く（A）と、その記録（B）────────

/** 初回に受理される「書けない」の申告（R-1 の部分。制約 ID は 2 つとも文書に実在する） */
const ACCEPTED_CLAIM = {
  id: "U-0",
  requirementId: "R-1",
  part: "初回の部分",
  constraintIds: ["記録", "合計"] as readonly string[],
  reason: "理由",
  alternative: "代案",
};

/** 初回の洗い出し：曖昧さ 1 件（往復を作る）と、受理される「書けない」の申告 1 件 */
const BASE_SURFACE = {
  ambiguities: [{ id: "OI-1", requirementId: "R-1", text: "曖昧", critical: true }],
  unwritable: [ACCEPTED_CLAIM],
};

/** 受理済みの申告の再申告（申告 ID はモデル作なので変えてある——正本にしないことの確認） */
function duplicateClaim(overrides: Partial<typeof ACCEPTED_CLAIM> = {}): typeof ACCEPTED_CLAIM {
  return { ...ACCEPTED_CLAIM, id: "U-dup", ...overrides };
}

describe("差分点検・§3：受理済み申告の正確な再申告だけを重複として除く（Issue #434）", () => {
  /**
   * 初回で U-0 を受理させ、1 往復目で R:A:Q1-1 を増やしたあとの差分点検に、与えた応答を返す。
   *
   * **差分の応答の台本は既定で 1 本だけ**である（Issue #484 の「やること 7」）。対象の照合だけで落ちる
   * 負例（やり直しの 2 試行目が起きる組）だけが、呼ぶ側で `retry: true` を立てて同じ応答をもう 1 本足す。
   * 受理される応答、制約の誤りで止まる組（D1）は 2 試行目を始めないので、台本を増やさない——増やすと、
   * 制約の誤りを誤ってやり直す実装でも期待が通ってしまう。
   */
  async function runSingleDiff(
    diffOutput: unknown,
    extraJudge: Record<string, JudgeAnswer> = {},
    options: { readonly retry?: boolean } = {},
  ): Promise<PlanResult> {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(BASE_SURFACE),
      structured(questionsFor("OI-1")),
      structured(diffOutput),
      ...(options.retry === true ? [structured(diffOutput)] : []),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
      ...extraJudge,
    });
    return runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED));
  }

  it("正確な再申告だけを除く（了承除外・代案・要件は増減しない）", async () => {
    const result = await runSingleDiff({ ambiguities: [], unwritable: [duplicateClaim()] });

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 重複を除いたので、了承除外・代わりの案は初回のぶんだけ（増減しない）
    expect(result.plan.accepted_unwritable.map((entry) => entry.part_id)).toEqual(["P:U-0"]);
    const ids = result.plan.requirements.map((requirement) => requirement.id);
    expect(ids).toContain("R:alt:U-0");
    expect(ids).not.toContain("R:alt:U-dup");
    // 記録：原応答で対象外 1 件（申告）、コードで除いた 1 件、分類は原文（source）
    expect(result.diffReviews).toEqual([
      {
        round: 1,
        added: 1,
        openIssues: 0,
        acceptedUnwritable: 0,
        outOfScope: diffOutOfScope({
          claims: 1,
          deduped: 1,
          kinds: { source: { claims: 1 } },
          dedupedIndexes: [0],
        }),
        inherit: inheritRecord({ noParent: 1 }),
      },
    ]);
  });

  it("正確な再申告と、対象内の申告・重大な事項が混在しても、再申告だけを除き、対象内は F1、重大事項は次の質問へ進む", async () => {
    const inScope = { id: "U-9", requirementId: "R:A:Q1-1", part: "差分の部分", constraintIds: ["記録"], reason: "差分の理由", alternative: "差分の代案" };
    const mixed = {
      ambiguities: [{ id: "OI-new", requirementId: "R:A:Q1-1", text: "新しい曖昧", critical: true }],
      unwritable: [duplicateClaim(), inScope],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(BASE_SURFACE),
      structured(questionsFor("OI-1")),
      structured(mixed),
      structured(questionsFor("OI-new")),
      structured(SURFACE_OUTPUT_CLEAR),
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
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 再申告だけを除き、対象内の申告は F1 に掛かって受理される（了承除外は初回＋対象内の 2 件）
    expect(result.plan.accepted_unwritable.map((entry) => entry.part_id)).toEqual(["P:U-0", "P:U-9"]);
    expect(result.plan.requirements.map((requirement) => requirement.id)).not.toContain("R:alt:U-dup");
    // 重大な事項は、次の往復で聞かれて閉じる
    expect(asked[1]?.questions.map((question) => question.openIssueId)).toEqual(["OI-new"]);
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-new")?.status).toBe("resolved");
    // 記録：1 往復目は対象外 1 件（申告）を除き、重大事項 1 件を開いた
    expect(result.diffReviews[0]).toEqual({
      round: 1,
      added: 1,
      openIssues: 1,
      acceptedUnwritable: 1,
      outOfScope: diffOutOfScope({ claims: 1, deduped: 1, kinds: { source: { claims: 1 } }, dedupedIndexes: [0] }),
      inherit: inheritRecord({ noParent: 1, openBySource: { surface: 1 } }),
    });
  });

  it("部分文・要件・理由・代案が違えば、重複と認めず止める（完全一致を広げない）", async () => {
    const cases: { readonly name: string; readonly claim: typeof ACCEPTED_CLAIM }[] = [
      { name: "部分文が別", claim: duplicateClaim({ part: "別の部分" }) },
      { name: "部分文の拡張", claim: duplicateClaim({ part: "初回の部分です" }) },
      { name: "要件が別", claim: duplicateClaim({ requirementId: "R-2" }) },
      { name: "理由が違う", claim: duplicateClaim({ reason: "別の理由" }) },
      { name: "代案が違う", claim: duplicateClaim({ alternative: "別の代案" }) },
    ];
    for (const { name, claim } of cases) {
      // 対象の照合だけで落ちる負例。やり直し（2 試行目）にも同じ応答を返す（Issue #484）
      const result = await runSingleDiff({ ambiguities: [], unwritable: [claim] }, {}, { retry: true });
      expect(result.kind, name).toBe("stopped");
      if (result.kind !== "stopped") continue;
      expect(result.failure?.stage, name).toBe("surface");
      expect(result.failure?.kind, name).toBe("unmet");
      // 重複と認めず、対象外 1 件を断った（除いていない）
      const out = result.diffReviews[0]?.outOfScope;
      expect(out?.deduped, name).toBe(0);
      expect(out?.rejectedClaims, name).toBe(1);
    }
  });

  it("制約集合は、並び替えだけの同じ全集合を除ける（追加・欠落・空・未知は断る）", async () => {
    // 正例：並び替えだけ
    const reordered = await runSingleDiff({ ambiguities: [], unwritable: [duplicateClaim({ constraintIds: ["合計", "記録"] })] });
    expect(reordered.kind).toBe("confirmed");
    expect(reordered.diffReviews[0]?.outOfScope.deduped).toBe(1);

    // 負例（対象の照合だけで断る）：追加・欠落。制約の裏付けは通るが、受理済みの再申告とは認めない集合なので
    // 対象外として断り、やり直し（2 試行目）へ回る。台本は呼ぶ側で 2 本目を明示して足す（Issue #484）
    const targetNegatives: { readonly name: string; readonly constraintIds: readonly string[] }[] = [
      { name: "追加", constraintIds: ["記録", "合計", "アプリの名前・説明"] },
      { name: "欠落", constraintIds: ["記録"] },
    ];
    for (const { name, constraintIds } of targetNegatives) {
      const result = await runSingleDiff(
        { ambiguities: [], unwritable: [duplicateClaim({ constraintIds })] },
        {},
        { retry: true },
      );
      expect(result.kind, name).toBe("stopped");
      if (result.kind !== "stopped") continue;
      expect(result.failure?.kind, name).toBe("unmet");
      expect(result.diffReviews[0]?.outOfScope.deduped, name).toBe(0);
      // 対象の照合で落ちた試行が 2 行（やり直しへ回った）
      expect(result.surfaceTargetAttempts.map((attempt) => attempt.result), name).toEqual(["target", "target"]);
    }

    // 負例（制約の裏付けで断る）：空・未知。対象の照合へ回さず、1 試行目で制約の誤りとして止まる
    // ——やり直しの台本は**足さない**（足すと、誤ってやり直す実装でも期待が通ってしまう。Issue #484）
    const constraintNegatives: { readonly name: string; readonly constraintIds: readonly string[] }[] = [
      { name: "空", constraintIds: [] },
      { name: "未知", constraintIds: ["文書に無い ID"] },
    ];
    for (const { name, constraintIds } of constraintNegatives) {
      const result = await runSingleDiff({ ambiguities: [], unwritable: [duplicateClaim({ constraintIds })] });
      expect(result.kind, name).toBe("stopped");
      if (result.kind !== "stopped") continue;
      expect(result.failure?.kind, name).toBe("unmet");
      expect(result.surfaceTargetAttempts.map((attempt) => attempt.result), name).toEqual(["accepted"]);
      expect(result.diffReviews[0]?.outOfScope.deduped, name).toBe(0);
    }
  });

  it("曖昧さは重複と認めない（要件・文・critical が違っても、同じ ID でも止める）", async () => {
    const ambiguities = [
      { id: "OI-1", requirementId: "R-2", text: "曖昧", critical: true },
      { id: "OI-1", requirementId: "R-1", text: "別の文", critical: true },
      { id: "OI-1", requirementId: "R-1", text: "曖昧", critical: false },
      { id: "OI-2", requirementId: "R-1", text: "新しい要件と矛盾する", critical: true },
    ];
    for (const ambiguity of ambiguities) {
      // 対象の照合だけで断る負例。やり直し（2 試行目）にも同じ応答を返す（Issue #484）
      const result = await runSingleDiff({ ambiguities: [ambiguity], unwritable: [] }, {}, { retry: true });
      expect(result.kind, `${ambiguity.requirementId}/${ambiguity.critical}`).toBe("stopped");
      if (result.kind !== "stopped") continue;
      expect(result.failure?.stage).toBe("surface");
      expect(result.failure?.kind).toBe("unmet");
      // 除かず、断った（分類は内部の対応で決まる。R-1 は原文、R-2 も原文）
      expect(result.diffReviews[0]?.outOfScope.deduped).toBe(0);
      expect(result.diffReviews[0]?.outOfScope.rejectedAmbiguities).toBe(1);
      expect(result.diffReviews[0]?.outOfScope.kinds.some((entry) => entry.ambiguities > 0)).toBe(true);
    }
  });

  it("正確な重複と、対象外の未知が同時にあるときは、後者で段ごと止め、識別した重複件数も残す", async () => {
    const unknown = { id: "U-x", requirementId: "R:unknown", part: "部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" };
    // 対象外の未知で断る負例。やり直し（2 試行目）にも同じ応答を返す（Issue #484）
    const result = await runSingleDiff({ ambiguities: [], unwritable: [duplicateClaim(), unknown] }, {}, { retry: true });

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface");
    expect(result.failure?.kind).toBe("unmet");
    // 原応答で対象外 2 件（申告）・除いた 1 件・断った 1 件。分類は原文 1・未知 1
    expect(result.diffReviews[0]?.outOfScope).toEqual(
      diffOutOfScope({
        claims: 2,
        deduped: 1,
        rejectedClaims: 1,
        kinds: { source: { claims: 1 }, unknown: { claims: 1 } },
        dedupedIndexes: [0],
      }),
    );
    // 誤りの文に、要件 ID の値を入れない
    expect(JSON.stringify(result.failure)).not.toContain("R:unknown");
  });

  it("対象内の申告は、受理済みの形に似ていても差分の点検を飛ばさない（F1 に掛ける）", async () => {
    // 対象内（R:A:Q1-1）の申告は、対象外の照合をせず、従来どおり F1 に掛ける
    const inScope = { id: "U-dup", requirementId: "R:A:Q1-1", part: "初回の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" };
    const result = await runSingleDiff({ ambiguities: [], unwritable: [inScope] });

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 従来の F1（仕分け・裏付け）に掛かり、受理されて了承除外が増える
    expect(result.plan.accepted_unwritable.map((entry) => entry.part_id)).toEqual(["P:U-0", "P:U-dup"]);
    expect(result.diffReviews[0]?.outOfScope).toEqual(NO_OUT_OF_SCOPE);
  });

  it("制約検査で止まっても、対象外の集合・分類と、識別済みの重複件数を保存する（D1）", async () => {
    // 空の制約を持つ申告（存在しない要件を指す）と、対象外の曖昧さを、正確な再申告に混ぜる
    const empty = { id: "U-empty", requirementId: "R:unknown", part: "部分", constraintIds: [], reason: "理由", alternative: "代案" };
    const outAmbiguity = { id: "OI-old", requirementId: "R-1", text: "古い曖昧", critical: true };
    const result = await runSingleDiff({ ambiguities: [outAmbiguity], unwritable: [duplicateClaim(), empty] });

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface");
    expect(result.failure?.kind).toBe("unmet");
    // 空の制約は、形と現文書の検査で断る（除外で隠さない）
    expect(result.failure?.problems).toEqual([{ field: "unwritable[1].constraintIds", code: "constraint-id-missing" }]);
    // 止まっても、対象外の集合・分類と、識別済みの重複件数（原添字つき）は残る
    expect(result.diffReviews[0]?.outOfScope).toEqual(
      diffOutOfScope({
        scanned: true,
        claims: 2,
        ambiguities: 1,
        deduped: 1,
        rejectedClaims: 1,
        rejectedAmbiguities: 1,
        kinds: { source: { claims: 1, ambiguities: 1 }, unknown: { claims: 1 } },
        dedupedIndexes: [0],
      }),
    );
    // 制約の誤りで止まる組は参照のやり直しへ回さない——差分の surface 段の実開始は 1・形のやり直し 0・
    // 照合の通知 1 行だけ（台本も増やさない）。誤ってやり直す実装なら、台本が尽きて種別が変わり落ちる
    const lastSurface = [...result.stages].reverse().find((stage) => stage.stage === "surface");
    expect(lastSurface?.attempts.started).toBe(1);
    expect(lastSurface?.retries.shape).toBe(0);
    expect(result.surfaceTargetAttempts.map((attempt) => [attempt.attempt, attempt.result])).toEqual([[1, "accepted"]]);
  });

  it("正規化しても接頭辞が残る既知 ID の再申告は、別の集合なので重複と認めず止める（D2）", async () => {
    const documents = [{ name: "語彙の意味", text: "### action\n説明。\n### ### ### action\n説明。" }];
    const accepted = { id: "U-0", requirementId: "R-1", part: "初回の部分", constraintIds: ["action"], reason: "理由", alternative: "代案" };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured({ ambiguities: [{ id: "OI-1", requirementId: "R-1", text: "曖昧", critical: true }], unwritable: [accepted] }),
      structured(questionsFor("OI-1")),
      // 1 回の正規化で `### action` になる（元の集合 `action` とは別の、実在する集合）
      // 1 試行目が対象の照合で落ち、2 試行目（やり直し）にも同じ応答を返す（Issue #484）
      structured({ ambiguities: [], unwritable: [{ ...accepted, id: "U-dup", constraintIds: ["### ### action"] }] }),
      structured({ ambiguities: [], unwritable: [{ ...accepted, id: "U-dup", constraintIds: ["### ### action"] }] }),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED, { documents }));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface");
    // 2 試行目まで参照のやり直しへ回り、対象外の停止（unmet・requirement-id-unknown）で止まる（Issue #484）
    expect(result.failure?.kind).toBe("unmet");
    expect(result.failure?.problems?.some((problem) => problem.code === "requirement-id-unknown")).toBe(true);
    // 二重に正規化しないので、`### action` と `action` を同一視せず、重複ではなく却下になる
    expect(result.diffReviews[0]?.outOfScope.deduped).toBe(0);
    expect(result.diffReviews[0]?.outOfScope.rejectedClaims).toBe(1);
  });
});

describe("差分点検・§3：重複と認めない構造の条件（Issue #434）", () => {
  /** 要件 1 つを手で作る */
  function requirement(id: string, parts: readonly PlanPart[] = []): PlanRequirement {
    return { id, text: id, kind: "constraining", origin: { input_id: "S-1", quote: id }, parts };
  }
  const acceptedPart: PlanPart = { id: "P:U-0", text: "初回の部分", disposition: "accepted_removal" };
  const entry: PlanAcceptedUnwritable = {
    part_id: "P:U-0",
    alternative_id: "R:alt:U-0",
    basis: { doc_version: "v1", location: "初回の部分", constraint_id: "記録" },
  };
  const snapshot: AcceptedClaimSnapshot = {
    requirementId: "R-1",
    partId: "P:U-0",
    part: "初回の部分",
    reason: "理由",
    alternative: "代案",
    alternativeId: "R:alt:U-0",
    constraintIds: ["記録"],
    requirementText: "R-1",
    changeKey: undefined,
    docVersion: "v1",
  };
  const claim = { id: "U-dup", requirementId: "R-1", part: "初回の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" };
  const base = {
    claim,
    requirements: [requirement("R-1", [acceptedPart]), requirement("R:alt:U-0")],
    acceptedUnwritable: [entry],
    snapshots: [snapshot],
    docVersion: "v1",
  };

  it("すべて揃えば、重複と認める", () => {
    expect(isAcceptedUnwritableDuplicate(base)).toBe(true);
  });

  it("parts だけ accepted_removal（了承除外の対応が無い）は重複と認めない", () => {
    expect(isAcceptedUnwritableDuplicate({ ...base, acceptedUnwritable: [] })).toBe(false);
  });

  it("受理した元申告の控えが無ければ重複と認めない", () => {
    expect(isAcceptedUnwritableDuplicate({ ...base, snapshots: [] })).toBe(false);
  });

  it("part_id に了承除外が複数対応すれば重複と認めない", () => {
    expect(isAcceptedUnwritableDuplicate({ ...base, acceptedUnwritable: [entry, entry] })).toBe(false);
  });

  it("対応する代案が存在しなければ重複と認めない", () => {
    expect(isAcceptedUnwritableDuplicate({ ...base, requirements: [requirement("R-1", [acceptedPart])] })).toBe(false);
  });

  it("要件の文が受理時から変わっていれば重複と認めない", () => {
    const changed: PlanRequirement = { ...requirement("R-1", [acceptedPart]), text: "変わった文" };
    expect(isAcceptedUnwritableDuplicate({ ...base, requirements: [changed, requirement("R:alt:U-0")] })).toBe(false);
  });

  it("別の要件が同じ part_id を持てば、重複と認めない（D3）", () => {
    const other = requirement("R-other", [{ id: "P:U-0", text: "別の文", disposition: "accepted_removal" }]);
    expect(isAcceptedUnwritableDuplicate({ ...base, requirements: [...base.requirements, other] })).toBe(false);
  });

  it("同じ要件の中に同じ part_id・別の文があれば、重複と認めない（D3）", () => {
    const r1 = requirement("R-1", [acceptedPart, { id: "P:U-0", text: "別の文", disposition: "accepted_removal" }]);
    expect(isAcceptedUnwritableDuplicate({ ...base, requirements: [r1, requirement("R:alt:U-0")] })).toBe(false);
  });

  it("受理した控えの対応（part_id・代わりの案の ID）が入れ替わっていれば、重複と認めない（D3）", () => {
    expect(isAcceptedUnwritableDuplicate({ ...base, snapshots: [{ ...snapshot, partId: "P:other" }] })).toBe(false);
    expect(isAcceptedUnwritableDuplicate({ ...base, snapshots: [{ ...snapshot, alternativeId: "R:alt:other" }] })).toBe(false);
  });

  it("制約集合は、1 回だけ正規化した値をそのまま比べる（接頭辞が残る別集合は同一視しない。D2）", () => {
    // 別の集合（`action` と `### action`）→ 重複と認めない
    expect(
      isAcceptedUnwritableDuplicate({
        ...base,
        snapshots: [{ ...snapshot, constraintIds: ["action"] }],
        claim: { ...claim, constraintIds: ["### action"] },
      }),
    ).toBe(false);
    // どちらも `### action`（正規化後に接頭辞が残る既知 ID）→ 同じ集合なので重複と認める
    expect(
      isAcceptedUnwritableDuplicate({
        ...base,
        snapshots: [{ ...snapshot, constraintIds: ["### action"] }],
        claim: { ...claim, constraintIds: ["### action"] },
      }),
    ).toBe(true);
    // どちらも `action` → 重複と認める
    expect(
      isAcceptedUnwritableDuplicate({
        ...base,
        snapshots: [{ ...snapshot, constraintIds: ["action"] }],
        claim: { ...claim, constraintIds: ["action"] },
      }),
    ).toBe(true);
  });
});

// ── Issue #460：同じ ID の開いている事項の行を畳まず、衝突は問いの前に有限の理由で止める ──────────

describe("同じ ID の開いている事項の行を畳まず、衝突は問いの前に有限の理由で止める（Issue #460）", () => {
  it("新しい分類 duplicate-open-issue は、有限の一覧にあり other に消えない", () => {
    expect(planDiagnosisCode("duplicate-open-issue")).toBe("duplicate-open-issue");
    expect(planDiagnosisCode("知らない分類")).toBe("other");
  });

  /** 同じことを聞く 2 件（OI-a・OI-b）と、別の 1 件（OI-x）を返す P3 の答え */
  const GROUPED_SURFACE_THREE = {
    ambiguities: [
      { id: "OI-a", requirementId: "R-1", text: "同じ問い 1", critical: true },
      { id: "OI-b", requirementId: "R-1", text: "同じ問い 2", critical: true },
      { id: "OI-x", requirementId: "R-2", text: "別の問い", critical: true },
    ],
    unwritable: [],
  };
  /** OI-a と OI-b を 1 問で閉じ、OI-x を別の 1 問で聞く P4 の答え */
  const GROUPED_QUESTIONS_TWO = {
    questions: [
      {
        id: "Q-1",
        openIssueId: "OI-a",
        alsoCloses: ["OI-b"],
        text: "まとめて聞く",
        choices: [
          { id: "c1", text: "こちら" },
          { id: "c2", text: "あちら" },
        ],
        recommended: { choiceId: "c1", reason: "依頼に沿う" },
        allowFreeText: true,
      },
      {
        id: "Q-2",
        openIssueId: "OI-x",
        text: "別に聞く",
        choices: [
          { id: "c1", text: "こちら" },
          { id: "c2", text: "あちら" },
        ],
        recommended: { choiceId: "c1", reason: "依頼に沿う" },
        allowFreeText: true,
      },
    ],
  };

  async function runGroupedTwo(responder: PlanResponder): Promise<PlanResult> {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(GROUPED_SURFACE_THREE),
      structured(GROUPED_QUESTIONS_TWO),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q1-2"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q1-2"]),
    });
    return runPlan(makePlanInput(recording.client, judge, responder));
  }

  it("主の事項と alsoCloses が同じ答えの ID で閉じ、他の行には触れない（通常の答えと全部推奨の両方）", async () => {
    const normal: PlanResponder = {
      async answer(request) {
        return { kind: "answers", answers: request.questions.map((question) => answerTo(question)) };
      },
      async confirm() {
        return "build";
      },
    };
    for (const responder of [normal, ALL_RECOMMENDED]) {
      const result = await runGroupedTwo(responder);
      expect(result.kind).toBe("confirmed");
      if (result.kind !== "confirmed") continue;
      // 主の OI-a と一緒に閉じる OI-b が、同じ（組み直した）答えの ID で閉じる
      expect(result.plan.open_issues.find((issue) => issue.id === "OI-a")?.resolution?.answer_id).toBe("A:Q1-1");
      expect(result.plan.open_issues.find((issue) => issue.id === "OI-b")?.resolution?.answer_id).toBe("A:Q1-1");
      // 別の行（OI-x）は、別の問いの答えで閉じる（一緒に閉じる一覧に触れられない）
      expect(result.plan.open_issues.find((issue) => issue.id === "OI-x")?.resolution?.answer_id).toBe("A:Q1-2");
      // 同じ ID の行を増やしていない
      expect(result.plan.open_issues.filter((issue) => issue.id === "OI-a")).toHaveLength(1);
      expect(result.openIssueConflicts).toEqual({ ids: 0, rows: [], attribution: [], emptyTargets: 0, round: null });
      expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    }
  });

  /** 4 件の重大な曖昧さ（OI-1〜OI-4）を返す P3 の答え */
  const SURFACE_FOUR = {
    ambiguities: Array.from({ length: 4 }, (_value, index) => ({
      id: `OI-${index + 1}`,
      requirementId: "R-1",
      text: `曖昧 ${index + 1}`,
      critical: true,
    })),
    unwritable: [],
  };
  /** 4 件の事項に 1 問ずつ（LLM の id はコードが組み直す） */
  const QUESTIONS_FOUR = {
    questions: Array.from({ length: 4 }, (_value, index) => ({
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

  it("不受理の答え（質問に無い・選択肢に無い・古い版・長すぎる自由入力）は何も解決せず、事項は開いたまま次の往復に回る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_FOUR),
      // 1 往復目：4 件に問いを出す。答えはどれも不受理（下の responder）
      structured(QUESTIONS_FOUR),
      // 2 往復目：まだ開いている 4 件に、もう一度問いを出す
      structured(QUESTIONS_FOUR),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q2-1", "R:A:Q2-2", "R:A:Q2-3", "R:A:Q2-4"]),
      ...coverAnswersFor(["A:Q2-1", "A:Q2-2", "A:Q2-3", "A:Q2-4"]),
    });
    const asked: PlanAnswerRequest[] = [];
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        asked.push(request);
        round += 1;
        if (round === 1) {
          // 質問に無い・選択肢に無い・古い版・長すぎる自由入力（どれも要件にならない）
          return {
            kind: "answers",
            answers: [
              { id: "A-1", questionId: "Q1-1", revision: 1, choiceId: "cX" },
              { id: "A-2", questionId: "Q1-2", revision: 0, choiceId: "c1" },
              { id: "A-3", questionId: "Q99-9", revision: 1, choiceId: "c1" },
              { id: "A-4", questionId: "Q1-4", revision: 1, freeText: "長すぎる自由入力" },
            ],
          };
        }
        return { kind: "all-recommended" };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(makePlanInput(recording.client, judge, responder, { freeTextMax: 4 }));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 1 往復目で何も解決せず、同じ 4 件が 2 往復目にも聞かれる（開いたまま次の往復に回る）
    expect(asked).toHaveLength(2);
    expect(asked[0]?.questions.map((question) => question.openIssueId)).toEqual(["OI-1", "OI-2", "OI-3", "OI-4"]);
    expect(asked[1]?.questions.map((question) => question.openIssueId)).toEqual(["OI-1", "OI-2", "OI-3", "OI-4"]);
    // 入力・要件・resolution のどれも、不受理の答えからは増えていない
    expect(result.plan.inputs.filter((input) => input.kind === "answer").map((input) => input.id)).toEqual([
      "A:Q2-1",
      "A:Q2-2",
      "A:Q2-3",
      "A:Q2-4",
    ]);
    expect(result.plan.requirements.map((requirement) => requirement.id)).toEqual([
      "R-1",
      "R-2",
      "R:A:Q2-1",
      "R:A:Q2-2",
      "R:A:Q2-3",
      "R:A:Q2-4",
    ]);
    const recordText = JSON.stringify(result.plan);
    expect(recordText).not.toContain("A-1");
    expect(recordText).not.toContain("Q99-9");
    // 解決の根拠は、2 往復目の受理された答えだけを指す
    for (const [index, id] of ["OI-1", "OI-2", "OI-3", "OI-4"].entries()) {
      expect(result.plan.open_issues.find((issue) => issue.id === id)?.resolution?.answer_id).toBe(`A:Q2-${index + 1}`);
    }
  });

  /** 与えた P3 の応答で 1 回流す（P4 に進んだかを見る） */
  async function runSurface(surface: unknown): Promise<PlanResult> {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
    ]);
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswersFor([]) });
    return runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));
  }

  it("同一応答内の同じ ID の 2 件は、畳まずに 2 行のまま、P4 を呼ばずに duplicate-open-issue で止まる", async () => {
    const sameContent = {
      ambiguities: [
        { id: "OI-dup", requirementId: "R-1", text: "同じ文", critical: true },
        { id: "OI-dup", requirementId: "R-1", text: "同じ文", critical: true },
      ],
      unwritable: [],
    };
    const differentRequirement = {
      ambiguities: [
        { id: "OI-dup", requirementId: "R-1", text: "同じ文", critical: true },
        { id: "OI-dup", requirementId: "R-2", text: "同じ文", critical: true },
      ],
      unwritable: [],
    };
    for (const surface of [sameContent, differentRequirement]) {
      const result = await runSurface(surface);
      expect(result.kind).toBe("cannot-confirm");
      if (result.kind !== "cannot-confirm") continue;
      expect(result.reasons).toEqual([{ source: "session", code: "duplicate-open-issue", path: "open_issues" }]);
      // 2 行のまま畳まれない（同じ出どころの組として記録する）
      expect(result.openIssues.filter((issue) => issue.id === "OI-dup")).toHaveLength(2);
      expect(result.openIssueConflicts.ids).toBe(1);
      expect(result.openIssueConflicts.rows).toEqual([{ existing: "surface", added: "surface", count: 1 }]);
      expect(result.closedByDefault).toEqual([]);
      expect(result.stages.some((stage) => stage.stage === "questions")).toBe(false);
    }
  });

  it("入力の要件の ID が重複して目録が同じ ID の行を 2 行作ると、既定の決定が 0 件のまま duplicate-open-issue で止まる", async () => {
    const duplicateRequirementList = {
      requirements: [
        { id: "R-1", text: "タスクを記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
        { id: "R-1", text: "件数を合計できる", quote: "件数を合計する", position: { start: 9, end: 16 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(duplicateRequirementList),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }, ["R-1"]),
      ...coverAnswersFor([]),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 既定の決定は 0 件のまま（目録の行が 2 つあるので既定の対象にしない）
    expect(result.closedByDefault).toEqual([]);
    expect(result.reasons).toEqual([{ source: "session", code: "duplicate-open-issue", path: "open_issues" }]);
    expect(result.openIssueConflicts.ids).toBe(1);
    expect(result.openIssueConflicts.rows).toEqual([{ existing: "catalog", added: "catalog", count: 1 }]);
    expect(result.stages.some((stage) => stage.stage === "questions")).toBe(false);
  });

  it("差分の点検が往復ごとに作る申告点検の曖昧さの ID は衝突せず、既定で閉じる事項も変わらない", async () => {
    const initialSurface = {
      ambiguities: [],
      unwritable: [
        { id: "U-0", requirementId: "R-1", part: "初回の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
      ],
    };
    const diffSurface = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R:A:Q1-1", part: "差分の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(initialSurface),
      // 1 往復目：点検 1 の曖昧さ（添字 0）への問い
      structured(questionsFor("OI:surface-check:1:0")),
      // 1 往復目の差分点検：点検 2 の曖昧さ（同じ添字 0）
      structured(diffSurface),
      // 2 往復目：点検 2 の曖昧さへの問い
      structured(questionsFor("OI:surface-check:2:0")),
      // 2 往復目の差分点検：もう開かない
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...catalogAnswersFor(["R:A:Q1-1", "R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
      [surfaceTriageQuestionName(0)]: choice("ambiguity", 0.9),
    });
    const responder: PlanResponder = {
      async answer(request) {
        return { kind: "answers", answers: request.questions.map((question) => answerTo(question)) };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 初回（点検 1）と差分（点検 2）が同じ添字 0 を使っても、ID が衝突しない
    expect(
      result.plan.open_issues.map((issue) => issue.id).filter((id) => id.startsWith("OI:surface-check:")),
    ).toEqual(["OI:surface-check:1:0", "OI:surface-check:2:0"]);
    for (const id of ["OI:surface-check:1:0", "OI:surface-check:2:0"]) {
      expect(result.plan.open_issues.find((issue) => issue.id === id)?.status).toBe("resolved");
    }
    // 既定で閉じた事項は、目録の既定のまま（ID の形を変えても変わらない）
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R-1:period", facetId: "period", value: "期間の条件を足さない" },
    ]);
    expect(result.openIssueConflicts).toEqual({ ids: 0, rows: [], attribution: [], emptyTargets: 0, round: null });
  });
});

// ── Issue #461：答えから生まれた要件が、答えが解いた観点と親で決まった観点を引き継ぐ ──────

/** 親の目録の重大な観点 OI:catalog:R-1:aggregation に答える P4（選択肢の文が要件の値になる） */
const INHERIT_QUESTIONS = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI:catalog:R-1:aggregation",
      text: "どう数えますか",
      choices: [
        { id: "c1", text: "全員を数える" },
        { id: "c2", text: "自分のみ数える" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
  ],
};

/** 主がモデル作・`alsoCloses` にコード作の目録の事項がある P4（選択肢の文が要件の値になる） */
const INHERIT_GROUPED_QUESTIONS = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI-extra",
      alsoCloses: ["OI:catalog:R-1:aggregation"],
      text: "どう数えますか",
      choices: [
        { id: "c1", text: "全員を数える" },
        { id: "c2", text: "自分のみ数える" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
  ],
};

/** 親の目録の観点 2 つ（aggregation・counted-state）に 1 問ずつ答える P4 */
const INHERIT_QUESTIONS_TWO = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI:catalog:R-1:aggregation",
      text: "どう数えますか",
      choices: [
        { id: "c1", text: "全員を数える" },
        { id: "c2", text: "自分のみ数える" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
    {
      id: "Q-2",
      openIssueId: "OI:catalog:R-1:counted-state",
      text: "どの状態を数えますか",
      choices: [
        { id: "c1", text: "実施した会議だけ数える" },
        { id: "c2", text: "予定も数える" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
  ],
};

/** 別々の要件のコード作の事項（R-1 と R-2）を 1 問で閉じる P4 */
const INHERIT_TWO_REQUIREMENT_QUESTIONS = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI:catalog:R-1:aggregation",
      alsoCloses: ["OI:catalog:R-2:aggregation"],
      text: "どう数えますか",
      choices: [
        { id: "c1", text: "全員を数える" },
        { id: "c2", text: "自分のみ数える" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
  ],
};

/** 提示された問いに、すべて最初の選択肢で答える答える役 */
const ANSWER_FIRST: PlanResponder = {
  async answer(request) {
    return { kind: "answers", answers: request.questions.map((question) => answerTo(question, "c1")) };
  },
  async confirm() {
    return "build";
  },
};

describe("差分点検：答えから生まれた要件が、答えの解いた観点を引き継ぐ（04 §3 P4・§6 の 1・Issue #461）", () => {
  /** 親の目録の観点に答え、差分の目録が同じ観点を未指定と返す 1 往復の流れを組む */
  async function runInherit(judgeAnswers: Record<string, JudgeAnswer>, responder: PlanResponder = ANSWER_FIRST) {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(INHERIT_QUESTIONS),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({ ...catalogUnspecifiedFor({ "R-1": ["aggregation"] }), ...judgeAnswers });
    return runPlan(makePlanInput(recording.client, judge, responder));
  }

  it("親の目録の重大な観点に答えると、差分の目録が同じ観点を未指定と返しても開かず、questions の段が 1 回のまま確定する（通常の答えと全部推奨の両方）", async () => {
    for (const responder of [ANSWER_FIRST, ALL_RECOMMENDED]) {
      const result = await runInherit(
        {
          ...catalogUnspecifiedFor({ "R:A:Q1-1": ["aggregation"] }, ["R:A:Q1-1"]),
          ...coverAnswers("A:Q1-1"),
        },
        responder,
      );
      expect(result.kind).toBe("confirmed");
      if (result.kind !== "confirmed") continue;
      // questions の段は 1 回だけ（差分の観点を開き直して聞かない）
      expect(result.stages.filter((stage) => stage.stage === "questions")).toHaveLength(1);
      // 確定した仕様に、引き継いだ観点が resolved で載り、根拠が D:inherit: の決定である
      const inherited = result.plan.open_issues.find((issue) => issue.id === "OI:catalog:R:A:Q1-1:aggregation");
      expect(inherited?.status).toBe("resolved");
      const decisionId = inherited?.resolution?.decision_id ?? "";
      expect(decisionId).toBe("D:inherit:OI:catalog:R:A:Q1-1:aggregation");
      expect(result.plan.decisions.find((decision) => decision.id === decisionId)?.value).toBe("全員を数える");
      // 根拠の決定の理由に、親の事項の ID が入る
      expect(result.plan.decisions.find((decision) => decision.id === decisionId)?.reason).toContain(
        "OI:catalog:R-1:aggregation",
      );
      // 既定では閉じていない
      expect(result.closedByDefault).toEqual([]);
      // 確定した仕様の検査を通る
      expect(await checkConfirmedPlan(result.plan)).toEqual([]);
      // 引き継ぎの記録（種類 a・観点 aggregation・親なしは 0）
      expect(result.diffReviews[0]?.inherit).toMatchObject({
        facets: [{ kind: "a", facetId: "aggregation", count: 1 }],
        noParent: 0,
        multipleParents: 0,
        openBySource: [
          { source: "catalog", count: 0 },
          { source: "surface", count: 0 },
          { source: "surface-check", count: 0 },
        ],
      });
    }
  });

  it("主がモデル作の事項で、alsoCloses にコード作の目録の事項がある問いに答えても、同じく引き継ぐ", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(INHERIT_GROUPED_QUESTIONS),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["aggregation"] }),
      ...catalogUnspecifiedFor({ "R:A:Q1-1": ["aggregation"] }, ["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });
    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST));
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.stages.filter((stage) => stage.stage === "questions")).toHaveLength(1);
    expect(result.plan.open_issues.find((issue) => issue.id === "OI:catalog:R:A:Q1-1:aggregation")?.status).toBe(
      "resolved",
    );
    expect(result.diffReviews[0]?.inherit).toMatchObject({
      facets: [{ kind: "a", facetId: "aggregation", count: 1 }],
      noParent: 0,
    });
  });

  it("親で別の観点が答え・既定で解決済みなら、その観点も開かず、値がそれぞれ元の値と一致する", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(INHERIT_QUESTIONS_TWO),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["aggregation", "counted-state", "period"] }),
      ...catalogUnspecifiedFor(
        {
          "R:A:Q1-1": ["aggregation", "counted-state", "period"],
          "R:A:Q1-2": ["aggregation", "counted-state", "period"],
        },
        ["R:A:Q1-1", "R:A:Q1-2"],
      ),
      ...coverAnswersFor(["A:Q1-1", "A:Q1-2"]),
    });
    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST));
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.stages.filter((stage) => stage.stage === "questions")).toHaveLength(1);
    const valueOf = (id: string): string | undefined =>
      result.plan.decisions.find((decision) => decision.id === id)?.value;
    // (a) 答えが解いた観点
    expect(valueOf("D:inherit:OI:catalog:R:A:Q1-1:aggregation")).toBe("全員を数える");
    expect(valueOf("D:inherit:OI:catalog:R:A:Q1-2:counted-state")).toBe("実施した会議だけ数える");
    // (b) 別の答えで解けた観点（値が入れ替わらない）
    expect(valueOf("D:inherit:OI:catalog:R:A:Q1-1:counted-state")).toBe("実施した会議だけ数える");
    expect(valueOf("D:inherit:OI:catalog:R:A:Q1-2:aggregation")).toBe("全員を数える");
    // (c) 既定で解けた観点
    expect(valueOf("D:inherit:OI:catalog:R:A:Q1-1:period")).toBe("期間の条件を足さない");
    expect(valueOf("D:inherit:OI:catalog:R:A:Q1-2:period")).toBe("期間の条件を足さない");
    // 既定で閉じた事項は、初回の 1 件のままで増えない
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R-1:period", facetId: "period", value: "期間の条件を足さない" },
    ]);
  });

  it("親の目録が開かなかった観点は開いて次の往復で聞き、親が答え由来なら親の引き継ぎ（d）も引き継ぐ", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(INHERIT_QUESTIONS),
      structured(SURFACE_OUTPUT_CLEAR),
      // 2 往復目：差分的に開いた counted-state に問いを出す
      structured(questionsFor("OI:catalog:R:A:Q1-1:counted-state")),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["aggregation"] }),
      ...catalogUnspecifiedFor({ "R:A:Q1-1": ["aggregation", "counted-state"] }, ["R:A:Q1-1"]),
      ...catalogUnspecifiedFor({ "R:A:Q2-1": ["aggregation", "counted-state"] }, ["R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });
    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST));
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 1 往復目で counted-state を開いて、2 往復目に聞く
    expect(result.stages.filter((stage) => stage.stage === "questions")).toHaveLength(2);
    // 1 往復目：aggregation は引き継ぎ、counted-state は開く
    expect(result.diffReviews[0]?.inherit).toEqual(
      inheritRecord({ facets: [{ kind: "a", facetId: "aggregation", count: 1 }], openBySource: { catalog: 1 } }),
    );
    // 2 往復目：counted-state は (a)、親が引き継いだ aggregation は (d) として引き継ぐ
    expect(result.diffReviews[1]?.inherit.facets).toEqual([
      { kind: "a", facetId: "counted-state", count: 1 },
      { kind: "d", facetId: "aggregation", count: 1 },
    ]);
    const valueOf = (id: string): string | undefined =>
      result.plan.decisions.find((decision) => decision.id === id)?.value;
    expect(valueOf("D:inherit:OI:catalog:R:A:Q1-1:aggregation")).toBe("全員を数える");
    expect(valueOf("D:inherit:OI:catalog:R:A:Q2-1:aggregation")).toBe("全員を数える");
    expect(valueOf("D:inherit:OI:catalog:R:A:Q2-1:counted-state")).toBe("こちら");
  });

  it("集合にコード作の事項が無い問い（モデル作の曖昧さだけ）に答えても、引き継がず従来どおり開く", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(questionsFor("OI:catalog:R:A:Q1-1:aggregation")),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const asked: PlanAnswerRequest[] = [];
    const responder: PlanResponder = {
      async answer(request) {
        asked.push(request);
        return { kind: "answers", answers: request.questions.map((question) => answerTo(question, "c1")) };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({}, ["R-1", "R-2"]),
      ...catalogUnspecifiedFor({ "R:A:Q1-1": ["aggregation"] }, ["R:A:Q1-1"]),
      ...catalogUnspecifiedFor({}, ["R:A:Q2-1"]),
      ...coverAnswersFor(["A:Q1-1", "A:Q2-1"]),
    });
    const result = await runPlan(makePlanInput(recording.client, judge, responder));
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 親なしなので、差分の目録が返した重大な観点は開かれ、次の往復で聞かれる
    expect(asked[1]?.questions.map((question) => question.openIssueId)).toEqual(["OI:catalog:R:A:Q1-1:aggregation"]);
    expect(result.diffReviews[0]?.inherit).toMatchObject({ noParent: 1, facets: [] });
  });

  it("alsoCloses が 2 要件のコード作の事項を含むなら、(a) だけを引き継ぎ、親が複数として報告する", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(INHERIT_TWO_REQUIREMENT_QUESTIONS),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["aggregation"], "R-2": ["aggregation"] }),
      ...catalogUnspecifiedFor({ "R:A:Q1-1": ["aggregation"] }, ["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });
    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST));
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.diffReviews[0]?.inherit).toMatchObject({
      facets: [{ kind: "a", facetId: "aggregation", count: 1 }],
      multipleParents: 1,
      noParent: 0,
    });
  });

  it("受理されなかった答えでは何も引き継がず、入力・要件・決定のどれも増えない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(INHERIT_QUESTIONS),
      // 1 往復目は受け付けられない → 新しい要件が増えないので差分点検を呼ばない
      structured(INHERIT_QUESTIONS),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        round += 1;
        const question = request.questions[0];
        if (round === 1) {
          // 選択肢に無い答え → 受理されない
          return { kind: "answers", answers: [{ id: "A-1", questionId: question?.id ?? "", revision: question?.revision ?? 1, choiceId: "cX" }] };
        }
        return { kind: "answers", answers: request.questions.map((one) => answerTo(one, "c1")) };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["aggregation"] }),
      ...catalogUnspecifiedFor({ "R:A:Q2-1": ["aggregation"] }, ["R:A:Q2-1"]),
      ...coverAnswers("A:Q2-1"),
    });
    const result = await runPlan(makePlanInput(recording.client, judge, responder));
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 受理されなかった 1 往復目は、差分点検の記録を積まない（増えた要件が無い）
    expect(result.diffReviews.map((review) => review.round)).toEqual([2]);
    // 入力・要件は、受理された 2 往復目の分だけ
    expect(result.plan.inputs.filter((input) => input.kind === "answer").map((input) => input.id)).toEqual(["A:Q2-1"]);
    expect(result.plan.requirements.map((requirement) => requirement.id)).toEqual(["R-1", "R-2", "R:A:Q2-1"]);
    // 受理されなかった答えの ID は、どこにも残らない
    expect(JSON.stringify(result.plan)).not.toContain("A-1");
  });

  it("P3 が引き継いだ事項と同じ ID を行として返す応答は、C1（issue-id-reused）で断られ、2 回続けば malformed で止まる", async () => {
    const sameIdAmbiguity = {
      ambiguities: [
        { id: "OI:catalog:R:A:Q1-1:aggregation", requirementId: "R:A:Q1-1", text: "同じ ID の曖昧さ", critical: true },
      ],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(INHERIT_QUESTIONS),
      // 差分の洗い出し：引き継いだ事項と同じ ID を返す（1 回目・やり直しの 2 回目とも）
      structured(sameIdAmbiguity),
      structured(sameIdAmbiguity),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["aggregation"] }),
      ...catalogUnspecifiedFor({ "R:A:Q1-1": ["aggregation"] }, ["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });
    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST));
    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.kind).toBe("malformed");
    expect(result.failure?.problems?.some((problem) => problem.code === "issue-id-reused")).toBe(true);
    // 断った件の記録が新しい欄に残る（版 2・試行 1 と 2）。提示元は「今回の引き継ぎ」
    expect(result.surfaceIdReuse).toEqual([
      { check: 2, attempt: 1, responses: 1, distinctIds: 1, bySource: idReuseBySource({ inherited: 1 }) },
      { check: 2, attempt: 2, responses: 1, distinctIds: 1, bySource: idReuseBySource({ inherited: 1 }) },
    ]);
    // 断った応答からは、行が足されない（引き継いだ行も足されない）
    expect(result.openIssueConflicts.ids).toBe(0);
  });

  it("見せていない既存の行（前の往復の P3 の行）との衝突は、今までどおり #460 の停止になる", async () => {
    // 初回の P3 が OI-extra を開き、答えで閉じる。差分の P3 が、見せていない OI-extra を再び返す
    const sameId = {
      ambiguities: [{ id: "OI-extra", requirementId: "R:A:Q1-1", text: "同じ ID", critical: true }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(questionsFor("OI-extra")),
      structured(sameId),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });
    const responder: PlanResponder = {
      async answer(request) {
        return { kind: "answers", answers: request.questions.map((question) => answerTo(question)) };
      },
      async confirm() {
        return "build";
      },
    };
    const result = await runPlan(makePlanInput(recording.client, judge, responder));
    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([{ source: "session", code: "duplicate-open-issue", path: "open_issues" }]);
    expect(result.openIssueConflicts.ids).toBe(1);
    expect(result.openIssueConflicts.rows).toEqual([{ existing: "surface", added: "surface", count: 1 }]);
    // 帰属の組は、前の往復の P3 の行（resolved）と、今回足した P3 の行（open）
    expect(result.openIssueConflicts.attribution).toEqual([
      {
        first: { origin: "surface", status: "open", current: true },
        second: { origin: "surface", status: "resolved", current: false },
        count: 1,
      },
    ]);
    // 使い回しとしては断っていない（見せていない ID）
    expect(result.surfaceIdReuse).toEqual([]);
  });

  it("引き継ぎの前後で、判定の問いの数と目録の呼び出しの回数が変わらない", async () => {
    const run = async (diffUnspecifiedForChild: Record<string, readonly string[]>): Promise<{
      readonly judgeCalls: number;
      readonly catalogCalls: number;
      readonly questions: number;
    }> => {
      const recording = createRecordingClient([
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(SURFACE_OUTPUT_CLEAR),
        structured(INHERIT_QUESTIONS),
        structured(SURFACE_OUTPUT_CLEAR),
      ]);
      const requests: JudgeRequest[] = [];
      const inner = createFakeJudge({
        ...catalogUnspecifiedFor({ "R-1": ["aggregation"] }),
        ...catalogUnspecifiedFor(diffUnspecifiedForChild, ["R:A:Q1-1"]),
        ...coverAnswers("A:Q1-1"),
      });
      const judge: Judge = {
        async judge(request: JudgeRequest): Promise<JudgeResponse> {
          requests.push(request);
          return inner.judge(request);
        },
      };
      const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST));
      expect(result.kind).toBe("confirmed");
      return {
        judgeCalls: requests.length,
        catalogCalls: result.stages.filter((stage) => stage.stage === "catalog").length,
        questions: result.stages.filter((stage) => stage.stage === "questions").length,
      };
    };
    // 引き継ぐ場合と、差分の目録が同じ観点を未指定と返さない場合で、呼び出しの数は変わらない
    const inherited = await run({ "R:A:Q1-1": ["aggregation"] });
    const notObserved = await run({ "R:A:Q1-1": [] });
    expect(inherited).toEqual(notObserved);
  });

  it("今回引き継ぐ決定が、当該差分の P3 の参照用文脈（既存の決定）にも入る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
      structured(INHERIT_QUESTIONS),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["aggregation"] }),
      ...catalogUnspecifiedFor({ "R:A:Q1-1": ["aggregation"] }, ["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });
    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST));
    expect(result.kind).toBe("confirmed");
    // 差分の P3（2 回目の洗い出し）の要求を取る。拾う条件は「初回の名前か差分専用の名前」に広げる（Issue #483）
    const surfaceRequests = recording.structured.filter(
      (request) => request.schemaName === SURFACE_SCHEMA_NAME || request.schemaName === SURFACE_DIFF_SCHEMA_NAME,
    );
    expect(surfaceRequests).toHaveLength(2);
    const diffRequest = surfaceRequests[1];
    // 子の決定（D:inherit:）と、元の解決の値が、参照用文脈に入る
    const decisionsBlock = dataBlockOf(diffRequest?.input ?? "", "既存の決定");
    expect(decisionsBlock).toContain("D:inherit:OI:catalog:R:A:Q1-1:aggregation");
    expect(decisionsBlock).toContain("全員を数える");
    // 点検の対象・実際に開く事項・仮の既定の構成は Issue 指定のまま（引き継ぐ観点は開く事項に入らない）
    expect(dataBlockOf(diffRequest?.input ?? "", "要件の一覧")).toContain("R:A:Q1-1");
    expect(dataBlockOf(diffRequest?.input ?? "", "開いている事項").trim()).toBe("[]");
    expect(dataBlockOf(diffRequest?.input ?? "", "仮に適用した既定").trim()).toBe("[]");
  });
});

// ── Issue #464：データで見せた事項 ID を使い回した応答を、行を足す前に断る ──────────────

describe("データで見せた事項 ID を使い回した応答を、行を足す前に断り、断った件を記録に残す（04 §3 P3・Issue #464）", () => {
  /** 問いに最初の選択肢で答える答える役（答えの ID はコードが組み直す） */
  const ANSWER_FIRST_INLINE: PlanResponder = {
    async answer(request) {
      return { kind: "answers", answers: request.questions.map((question) => answerTo(question)) };
    },
    async confirm() {
      return "build";
    },
  };

  it("初回：使い回しの応答を 1 回断り、受理した 2 回目で進む。断った応答から行は足されず、既存の行は変わらない", async () => {
    const reuse = {
      ambiguities: [{ id: "OI:catalog:R-1:period", requirementId: "R-1", text: "使い回し", critical: false }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(reuse),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({ ...catalogUnspecifiedFor({ "R-1": ["period"] }), ...coverAnswersFor([]) });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 断った応答の事項（「使い回し」）は、行として足されない
    expect(result.plan.open_issues.some((issue) => issue.text === "使い回し")).toBe(false);
    // 既存の行（目録の period）は変わらない（既定で閉じる）
    expect(result.closedByDefault).toEqual([
      { issueId: "OI:catalog:R-1:period", facetId: "period", value: "期間の条件を足さない" },
    ]);
    // 断った件の記録（版 1・試行 1）。同じ ID が目録と仮の既定の両方に当たるので、両方に数える
    expect(result.surfaceIdReuse).toEqual([
      { check: 1, attempt: 1, responses: 1, distinctIds: 1, bySource: idReuseBySource({ catalog: 1, defaults: 1 }) },
    ]);
    // 2 回目の応答は受理され、洗い出しの段は成功する
    expect(result.stages.find((stage) => stage.stage === "surface")?.status).toBe("ok");
  });

  it("差分：使い回しの応答を 1 回断り、受理した 2 回目で進む。断った応答から行は足されない", async () => {
    const diffReuse = {
      ambiguities: [
        { id: "OI:catalog:R-1:period", requirementId: "R:A:Q1-1", text: "使い回し", critical: true },
      ],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(questionsFor("OI-extra")),
      structured(diffReuse),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST_INLINE));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 断った応答の事項は、行として足されない
    expect(result.plan.open_issues.some((issue) => issue.text === "使い回し")).toBe(false);
    // 断った件の記録（版 2・試行 1）。提示元は「決定に結ばれた既存の事項」（既定で閉じた行）
    expect(result.surfaceIdReuse).toEqual([
      { check: 2, attempt: 1, responses: 1, distinctIds: 1, bySource: idReuseBySource({ decisions: 1 }) },
    ]);
  });

  it("差分：断ったあとに受理した応答にも、点検の対象の検査が掛かる（対象外なら unmet で止まる）", async () => {
    const diffReuse = {
      ambiguities: [
        { id: "OI:catalog:R-1:period", requirementId: "R:A:Q1-1", text: "使い回し", critical: true },
      ],
      unwritable: [],
    };
    const outOfScope = {
      ambiguities: [{ id: "OI:new:x", requirementId: "R-9", text: "対象外", critical: true }],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(questionsFor("OI-extra")),
      structured(diffReuse),
      structured(outOfScope),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_FIRST_INLINE));

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    // 最終の失敗は unmet（点検の対象の検査）。使い回しに置き換えない
    expect(result.failure?.kind).toBe("unmet");
    expect(result.failure?.problems?.some((problem) => problem.code === "requirement-id-unknown")).toBe(true);
    // 断った履歴は、最終の失敗の欄とは別の欄に残る
    expect(result.surfaceIdReuse).toEqual([
      { check: 2, attempt: 1, responses: 1, distinctIds: 1, bySource: idReuseBySource({ decisions: 1 }) },
    ]);
  });
});

// ── Plan の段の記録に、試行の終端と再試行の数が入る（Issue #446）──────────────

describe("Plan の段の記録に、試行の終端と再試行の数が入る（Issue #446）", () => {
  it("P4 の形の再試行は、questions 段の retries.shape に 1 と数える", async () => {
    const questionOf = (text: string) => ({
      id: "Q-dup",
      openIssueId: "OI-extra",
      text,
      choices: [
        { id: "c1", text: "こちら" },
        { id: "c2", text: "あちら" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    });
    const duplicated = { questions: [questionOf("a"), questionOf("b")] };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(duplicated), // 1 回目の形の誤り（質問 ID の重複）
      structured(QUESTIONS_OUTPUT), // 2 回目で通る
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const responder: PlanResponder = {
      async answer(request) {
        return { kind: "answers", answers: [answerTo(request.questions[0])] };
      },
      async confirm() {
        return "build";
      },
    };
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    const questions = result.stages.find((stage) => stage.stage === "questions");
    expect(questions).toMatchObject({
      status: "ok",
      calls: 2,
      retries: { communication: 0, shape: 1, content: 0 },
    });
  });

  it("Plan の段が呼んでいる途中で締切に触れると、開始 1・応答 0・締切の打ち切り 1", async () => {
    const hanging: LlmClient = {
      async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        return new Promise<never>(() => {
          request.signal?.addEventListener("abort", () => {});
        });
      },
      async callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const responder: PlanResponder = {
      async answer() {
        return { kind: "answers", answers: [] };
      },
      async confirm() {
        return "build";
      },
    };

    const result = await runPlan(
      makePlanInput(hanging, createFakeJudge({}), responder, { now: () => 60_000 - 1, deadline: 60_000 }),
    );

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.reason).toBe("deadline");
    const requirements = result.stages.find((stage) => stage.stage === "requirements");
    expect(requirements).toMatchObject({
      status: "failed",
      calls: 0,
      failure_kind: "deadline",
      attempts: { started: 1, responded: 0, errors: 0, cancelled_deadline: 1, cancelled_timeout: 0 },
    });
  });
});

// ── 台本の答える役（04 §9・Issue #444）────────────────────────────
//
// 台本（`musunest-eval/plan-script/v1`）の答える役で、推奨と違う答えが確定した仕様に入ること、束の一部に
// だけ答えた往復で答えた事項だけ閉じて残りが次の往復で聞き直され、上限で確定できないこと、照合の文脈に
// 目録以外の事項と再質問に観点が欠けた値・要件の参照が渡ることを固定する。**実 API は呼ばない。**

/** 項目に `basis` が無ければ補う（当て方の試験の関心ではない。形の検査は `script-responder.test.ts` が試す） */
function withScriptBasis(entry: unknown): unknown {
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    if (record["basis"] === undefined) return { ...record, basis: "basis" };
  }
  return entry;
}

/** v1 の台本を、項目から組み立てる（形の検査を通す） */
function scriptOf(entries: readonly unknown[]): PlanScript {
  const parsed = parsePlanScript(
    JSON.stringify({ schema: PLAN_SCRIPT_SCHEMA, subject: "X", version: 1, entries: entries.map(withScriptBasis) }),
  );
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

/** 別々の事項 2 件（重大。目録以外。Issue #444） */
const SPLIT_SURFACE = {
  ambiguities: [
    { id: "OI-a", requirementId: "R-1", text: "数え方", critical: true },
    { id: "OI-b", requirementId: "R-2", text: "丸め方", critical: true },
  ],
  unwritable: [],
};

/** 事項 2 件に 1 問ずつ（別々の問い）を返す P4 の答え（Issue #444） */
const SPLIT_QUESTIONS = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI-a",
      text: "どう数えますか",
      choices: [
        { id: "c1", text: "件数" },
        { id: "c2", text: "合計" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
    {
      id: "Q-2",
      openIssueId: "OI-b",
      text: "どう丸めますか",
      choices: [
        { id: "c1", text: "切り捨て" },
        { id: "c2", text: "四捨五入" },
      ],
      recommended: { choiceId: "c1", reason: "素直" },
      allowFreeText: true,
    },
  ],
};

/** 残った事項 OI-b にだけ問いを返す P4 の答え（Issue #444） */
const SPLIT_QUESTION_B = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI-b",
      text: "どう丸めますか",
      choices: [
        { id: "c1", text: "切り捨て" },
        { id: "c2", text: "四捨五入" },
      ],
      recommended: { choiceId: "c1", reason: "素直" },
      allowFreeText: true,
    },
  ],
};

describe("台本の答える役（04 §9・Issue #444）", () => {
  it("推奨と違う答えが、確定した仕様に入る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      // 答えから増えた要件の差分点検（Issue #434）
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    // 台本に無い（SURFACE_OUTPUT の事項の文に当たる）項目を 1 件だけ置く。推奨（c1）と違う c2 を選ぶ
    const script = scriptOf([{ id: "E1", facet: null, keys: ["誰の分"], answer: { choose: ["自分のみ"] } }]);
    const matches: PlanScriptMatch[] = [];
    const responder = createScriptPlanResponder(script, {
      match: (match) => matches.push(match),
      confirmation: () => {},
    });
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 推奨（c1）と違う c2 が、そのまま確定した仕様に入る
    const answer = result.plan.inputs.find((input) => input.kind === "answer" && input.id === "A:Q1-1");
    expect(answer?.kind === "answer" ? answer.choice_id : undefined).toBe("c2");
    expect(result.plan.requirements.find((requirement) => requirement.id === "R:A:Q1-1")?.text).toBe("自分のみ");
    // 事項は、その答えで閉じる
    expect(result.plan.open_issues.find((issue) => issue.id === "OI-extra")?.resolution?.answer_id).toBe("A:Q1-1");
    // 照合の記録は answered（コードが振った質問 ID・往復の版・状態・項目の添字）
    expect(matches).toEqual([{ questionId: "Q1-1", revision: 1, state: "answered", entryIndex: 0 }]);
  });

  it("照合の文脈に、目録以外の事項と再質問に観点が欠けた値・要件の参照が渡る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SAME_ISSUES_SURFACE),
      structured(GROUPED_QUESTIONS),
      structured(GROUPED_QUESTIONS_AFTER_CONTRADICTION),
      structured(GROUPED_QUESTIONS_AFTER_CONTRADICTION),
    ]);
    const asked: PlanAnswerRequest[] = [];
    let round = 0;
    const responder: PlanResponder = {
      async answer(request) {
        asked.push(request);
        round += 1;
        if (round === 1) {
          const question = request.questions[0];
          return {
            kind: "answers",
            answers: [
              { id: "A-1", questionId: question?.id ?? "", revision: question?.revision ?? 1, freeText: "全員で数える" },
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

    await runPlan(makePlanInput(recording.client, judge, responder));

    // 1 往復目：主の事項は P3 の洗い出し（目録以外）——観点は欠けた値、参照先の要件は R-1
    expect(asked[0]?.revision).toBe(1);
    expect(asked[0]?.issues[0]?.question.id).toBe("Q1-1");
    expect(asked[0]?.issues[0]?.main).toEqual({
      id: "OI-a",
      text: "誰の分を数えるか",
      facetId: null,
      requirement: { id: "R-1", text: "タスクを記録できる" },
    });

    // 2 往復目：矛盾から組み立てた再質問——観点も参照先の要件も欠けた値
    const context = asked[1]?.issues.find((entry) => entry.question.openIssueId === "OI:contradiction:A:Q1-1");
    expect(context).toBeDefined();
    expect(context?.main).toEqual({
      id: "OI:contradiction:A:Q1-1",
      text: expect.any(String),
      facetId: null,
      requirement: null,
    });
  });

  it("束の一部にだけ答えた往復で、答えた事項だけ閉じ、残りが次の往復で聞き直され、上限で確定できない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SPLIT_SURFACE),
      structured(SPLIT_QUESTIONS),
      // 答えから増えた要件の差分点検（P4 は毎回妥当な問いを返す固定入力）
      structured(SURFACE_OUTPUT_CLEAR),
      structured(SPLIT_QUESTION_B),
      structured(SPLIT_QUESTION_B),
    ]);
    // OI-a の事項（「数え方」）にだけ当たる項目。OI-b（「丸め方」）には当たらない
    const script = scriptOf([{ id: "E1", facet: null, keys: ["数え"], answer: { choose: ["件数"] } }]);
    const matches: PlanScriptMatch[] = [];
    const responder = createScriptPlanResponder(script, {
      match: (match) => matches.push(match),
      confirmation: () => {},
    });
    const judge = createFakeJudge({ ...catalogAnswers(), ...catalogAnswersFor(["R:A:Q1-1"]) });

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    // 答えた OI-a だけが閉じ、OI-b は開いたまま次々と聞き直され、往復の上限で確定できない
    expect(result.openIssues.map((issue) => issue.id)).toEqual(["OI-b"]);
    expect(result.reasons).toEqual([{ source: "session", code: "round-trip-limit", path: "open_issues" }]);
    // 1 往復目の OI-a の問いは答え、OI-b と、その後の聞き直しは答えない（all-recommended は返さない）
    expect(matches.map((match) => match.state)).toEqual(["answered", "unknown", "unknown", "unknown"]);
  });

  it("台本に無い問いは開いたまま残り、上限で確定できない（all-recommended を返さない）", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      structured(QUESTIONS_OUTPUT),
    ]);
    const script = scriptOf([{ id: "E1", facet: null, keys: ["該当しない語"], answer: { choose: ["全員"] } }]);
    const responder = createScriptPlanResponder(script);
    const judge = createFakeJudge(catalogAnswers());

    const result = await runPlan(makePlanInput(recording.client, judge, responder));

    // 推奨で埋めていれば OI-extra が閉じて確定するはずである。確定しないことが all-recommended を返さない証拠
    expect(result.kind).toBe("cannot-confirm");
  });
});

// ── Issue #484：差分の洗い出しの対象外の参照を、形のやり直し（最大 2 試行）へ返す ──────────

describe("差分点検：対象外の参照を形のやり直しへ返し、試行ごとの結果を残す（04 §3 P3・Issue #484）", () => {
  /** 分類別の件数の並び（断った参照だけ。既定はすべて 0） */
  const KIND_ORDER = ["source", "previous-answer", "alternative", "unknown", "unclassified"] as const;
  function targetKinds(
    overrides: Partial<Record<(typeof KIND_ORDER)[number], { claims?: number; ambiguities?: number }>> = {},
  ) {
    return KIND_ORDER.map((kind) => ({
      kind,
      claims: overrides[kind]?.claims ?? 0,
      ambiguities: overrides[kind]?.ambiguities ?? 0,
    }));
  }
  /** 原文の要件を指す未解決の事項 1 件（対象外） */
  const badDiff = {
    ambiguities: [{ id: "OI-bad", requirementId: "R-1", text: "原文を指す", critical: true }],
    unwritable: [],
  };
  /** 点検の対象の内側だけで作った応答（対象の照合を通る） */
  const goodDiff = { ambiguities: [], unwritable: [] };
  /** 形で落ちる応答（代わりの案が無い） */
  const badShape = {
    ambiguities: [],
    unwritable: [{ id: "U-1", requirementId: "R:A:Q1-1", part: "部分", constraintIds: ["記録"], reason: "理由" }],
  };

  /** 初回に OI-extra を開き、全部推奨で R:A:Q1-1 を増やしたあとの差分の洗い出しに、与えた応答を返す */
  async function runDiffScenario(
    diffOutputs: readonly unknown[],
    overrides: Partial<PlanRunInput> = {},
  ): Promise<PlanResult> {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT),
      structured(QUESTIONS_OUTPUT),
      ...diffOutputs.map((output) => structured(output)),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogAnswersFor(["R:A:Q1-1"]),
      ...coverAnswers("A:Q1-1"),
    });
    return runPlan(makePlanInput(recording.client, judge, ALL_RECOMMENDED, overrides));
  }

  it("(h) 1 試行目が原文の要件を指し、2 試行目が対象内なら、止まらずに進み、記録は 2 試行目だけで数える", async () => {
    const result = await runDiffScenario([badDiff, goodDiff]);

    expect(result.kind).toBe("confirmed");
    // 差分点検の記録の outOfScope は、2 試行目の照合だけで数える（断った数 0）
    expect(result.diffReviews[0]?.outOfScope).toEqual(NO_OUT_OF_SCOPE);
    // 新しい欄：試行 1（対象の照合で不成立・分類 source の件数 1）と試行 2（受理）
    expect(result.surfaceTargetAttempts).toEqual([
      {
        check: 2,
        attempt: 1,
        result: "target",
        rejectedClaims: 0,
        rejectedAmbiguities: 1,
        kinds: targetKinds({ source: { ambiguities: 1 } }),
      },
      { check: 2, attempt: 2, result: "accepted", rejectedClaims: 0, rejectedAmbiguities: 0, kinds: targetKinds() },
    ]);
    // 行に値（要件 ID・事項 ID・文）が出ない
    const text = JSON.stringify(result.surfaceTargetAttempts);
    expect(text).not.toContain("R-1");
    expect(text).not.toContain("OI-");
    expect(text).not.toContain("原文を指す");
  });

  it("(i) 2 試行とも対象外を指すと、今の負例と同じ止まり方で、新しい欄に 2 行が分かれて残る", async () => {
    const result = await runDiffScenario([badDiff, badDiff]);

    expect(result.kind).toBe("stopped");
    if (result.kind !== "stopped") return;
    expect(result.failure?.stage).toBe("surface");
    expect(result.failure?.kind).toBe("unmet");
    expect(result.failure?.problems).toEqual([
      { field: "ambiguities[0].requirementId", code: "requirement-id-unknown" },
    ]);
    // 差分点検の記録も、2 試行目の照合だけで数える（原文の曖昧さ 1）
    expect(result.diffReviews[0]?.outOfScope).toEqual(
      diffOutOfScope({ ambiguities: 1, rejectedAmbiguities: 1, kinds: { source: { ambiguities: 1 } } }),
    );
    expect(result.surfaceTargetAttempts).toEqual([
      {
        check: 2,
        attempt: 1,
        result: "target",
        rejectedClaims: 0,
        rejectedAmbiguities: 1,
        kinds: targetKinds({ source: { ambiguities: 1 } }),
      },
      {
        check: 2,
        attempt: 2,
        result: "target",
        rejectedClaims: 0,
        rejectedAmbiguities: 1,
        kinds: targetKinds({ source: { ambiguities: 1 } }),
      },
    ]);
  });

  it("(j) 呼び出しの上限が 1 試行目までで尽きると、2 試行目を始めず、上限の種類で止まる。新しい欄は 1 行だけ", async () => {
    // 対照：上限を十分に取って最後まで回し、実際の呼び出しの総数を測る。最後の呼び出しが 2 試行目である
    // ——共通の門は、生成の呼び出しと判定の呼び出しを**同じ 1 つの数**で数える（Issue #432）
    const control = await runDiffScenario([badDiff, badDiff]);
    const judgeCalls = Object.values(control.judge.calls_by_adapter).reduce((sum, calls) => sum + calls, 0);
    const total = control.stages.reduce((sum, stage) => sum + stage.calls, 0) + judgeCalls;
    expect(total).toBeGreaterThan(1);

    // 拒否→成功：新しい欄は [対象で不成立, 受理]
    const ok = await runDiffScenario([badDiff, goodDiff]);
    expect(ok.kind).toBe("confirmed");
    expect(ok.surfaceTargetAttempts.map((attempt) => attempt.result)).toEqual(["target", "accepted"]);

    // 拒否→形で不成立：新しい欄は [対象で不成立, 形で不成立]、段の失敗は malformed
    const shaped = await runDiffScenario([badDiff, badShape]);
    expect(shaped.kind).toBe("stopped");
    if (shaped.kind === "stopped") expect(shaped.failure?.kind).toBe("malformed");
    expect(shaped.surfaceTargetAttempts.map((attempt) => attempt.result)).toEqual(["target", "shape"]);

    // 拒否→未着手：上限を 1 試行目までで尽きるようにして、2 試行目を始めない
    const limited = await runDiffScenario([badDiff, badDiff], {
      limits: { ...AGENT_LIMITS, callCount: total - 1 },
    });
    expect(limited.kind).toBe("stopped");
    if (limited.kind !== "stopped") return;
    expect(limited.failure?.stage).toBe("surface");
    expect(limited.failure?.kind).toBe("call-limit");
    // 新しい欄は試行 1 の 1 行だけ（拒否→未着手）
    expect(limited.surfaceTargetAttempts.map((attempt) => attempt.attempt)).toEqual([1]);
    expect(limited.surfaceTargetAttempts[0]?.result).toBe("target");
    // 2 試行目は始めていない（追加の開始 0）
    const lastSurface = [...limited.stages].reverse().find((stage) => stage.stage === "surface");
    expect(lastSurface?.attempts.started).toBe(1);
    expect(lastSurface?.attempts.not_started.limit).toBe(1);
  });
});

// ── 複数の文にまたがる引用の、原文の文との対応を P2 から P6 まで保つ（Issue #487）──

describe("複数の文にまたがる引用の対応を、P2 から P6 まで保つ（Issue #487）", () => {
  /** 理由に原文の文・要件 ID が混ざらないことを見るための印 */
  const MARK = "MARK487";
  /** P1 が 2 文にまたがる引用の要件 1 つを返す一覧（原文は既定の `SOURCE_TEXT`） */
  const SPANNING_LIST = {
    requirements: [
      {
        id: "R-1",
        text: "記録して合計できる",
        quote: "タスクを記録する。件数を合計する。",
        position: { start: 0, end: 17 },
      },
    ],
    framing: [],
    decisions: [],
    unresolved: [],
  };

  it("(h) P1 が 2 文にまたがる引用の要件を返し、P2 の落ちが 0 の組で、Plan は確定し、要件の数と出どころは P1 のまま", async () => {
    const recording = createRecordingClient([
      structured(SPANNING_LIST),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({ ...catalogAnswersFor(["R-1"]), ...coverAnswersFor([]) });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 要件の数は P1 の一覧と同じ（水増ししない）
    expect(result.plan.requirements.map((requirement) => requirement.id)).toEqual(["R-1"]);
    // 出どころは最初の文の入力である
    expect(result.plan.requirements[0]?.origin.input_id).toBe("S-1");
  });

  /** 枠でも要件でもない 3 文目の文が残る、印つきの 3 文の原文 */
  const RC_SOURCE = `${MARK}Aを記録する。${MARK}Bを合計する。${MARK}Cを出す。`;
  /** 前の 2 文だけを覆う一覧（3 文目がコードの落ちとして残る） */
  const RC_PARTIAL = {
    requirements: [
      { id: `R-${MARK}`, text: "記録できる", quote: `${MARK}Aを記録する。`, position: spanOf(RC_SOURCE, `${MARK}Aを記録する。`) },
      { id: "R-2", text: "合計できる", quote: `${MARK}Bを合計する。`, position: spanOf(RC_SOURCE, `${MARK}Bを合計する。`) },
    ],
    framing: [],
    decisions: [],
    unresolved: [],
  };

  it("(i) どの引用とも重ならず枠でもない文が P2 のやり直し後にも 1 文残る組は、cannot-confirm になり、理由に値が出ない", async () => {
    const recording = createRecordingClient([
      structured(RC_PARTIAL),
      structured(REVERSE_CHECK_OUTPUT),
      structured(RC_PARTIAL),
      structured(REVERSE_CHECK_OUTPUT),
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

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge({}), responder, { source: RC_SOURCE }));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([{ source: "reverse-check", code: "uncovered-source", path: "source[*]" }]);
    // 目録・P3 以降は実行されない
    const stageIds = result.stages.map((stage) => stage.stage);
    expect(stageIds).not.toContain("catalog");
    expect(stageIds).not.toContain("surface");
    expect(stageIds).not.toContain("questions");
    expect(answerCalls).toBe(0);
    expect(confirmCalls).toBe(0);
    // 理由に、原文の文・要件 ID が出ない（Issue #445）
    const text = JSON.stringify(result.reasons);
    expect(text).not.toContain(MARK);
    expect(text).not.toContain("R-2");
  });

  /** 全ての文に引用が重なる、印つきの 2 文の原文 */
  const RC2_SOURCE = `${MARK}Dを記録する。${MARK}Eを合計する。`;
  /** 両方の文を覆う一覧（コードの落ちは 0） */
  const RC_ALL_COVERED = {
    requirements: [
      { id: "R-1", text: "記録できる", quote: `${MARK}Dを記録する。`, position: spanOf(RC2_SOURCE, `${MARK}Dを記録する。`) },
      { id: "R-2", text: "合計できる", quote: `${MARK}Eを合計する。`, position: spanOf(RC2_SOURCE, `${MARK}Eを合計する。`) },
    ],
    framing: [],
    decisions: [],
    unresolved: [],
  };
  /** 会話が挙げる、覆われていない部分（コードの落ちとは重ならない） */
  const RC_CONVERSATION = { uncovered: [{ start: 0, end: `${MARK}Dを記録する。`.length }] };

  it("(i2) 全ての文に引用が重なる組でも、P2 の会話の申告がやり直し後に残れば、今のとおり P2 で確定を拒否する", async () => {
    const recording = createRecordingClient([
      structured(RC_ALL_COVERED),
      structured(RC_CONVERSATION),
      structured(RC_ALL_COVERED),
      structured(RC_CONVERSATION),
    ]);

    const result = await runPlan(makePlanInput(recording.client, createFakeJudge({}), ANSWER_NONE, { source: RC2_SOURCE }));

    expect(result.kind).toBe("cannot-confirm");
    if (result.kind !== "cannot-confirm") return;
    expect(result.reasons).toEqual([{ source: "reverse-check", code: "uncovered-source", path: "source[*]" }]);
    expect(result.stages.map((stage) => stage.stage)).not.toContain("catalog");
  });

  /** 3 文の原文（初回は第 3 文が未対応になる） */
  const REDO_SOURCE = "タスクを記録する。件数を合計する。印を出す。";
  /** 初回の一覧（第 3 文がどの引用とも重ならない） */
  const REDO_INITIAL = {
    requirements: [
      { id: "R-1", text: "記録できる", quote: "タスクを記録する。", position: spanOf(REDO_SOURCE, "タスクを記録する。") },
      { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: spanOf(REDO_SOURCE, "件数を合計する。") },
    ],
    framing: [],
    decisions: [],
    unresolved: [],
  };
  /** やり直し後の一覧（要件 2 が第 2・第 3 文を引用する） */
  const REDO_FINAL = {
    requirements: [
      { id: "R-1", text: "記録できる", quote: "タスクを記録する。", position: spanOf(REDO_SOURCE, "タスクを記録する。") },
      {
        id: "R-2",
        text: "合計して印を出せる",
        quote: "件数を合計する。印を出す。",
        position: spanOf(REDO_SOURCE, "件数を合計する。印を出す。"),
      },
    ],
    framing: [],
    decisions: [],
    unresolved: [],
  };

  it("(j) 初回は第 3 文が未対応でやり直しとなり、やり直し後の一覧で確定し、最終一覧の対応が運ばれる", async () => {
    const recording = createRecordingClient([
      structured(REDO_INITIAL),
      structured(REVERSE_CHECK_OUTPUT),
      structured(REDO_FINAL),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswersFor(["R-1", "R-2"]),
      [confirmQuestionName("S-1")]: noul(0.95),
      [confirmQuestionName("S-2")]: noul(0.95),
      [confirmQuestionName("S-3")]: noul(0.95),
    });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE, { source: REDO_SOURCE }));

    // 初回の対応（要件 2 → S-2 だけ）を使うと第 3 文の覆いが取れない。最終一覧の対応が運ばれるので確定する
    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    expect(result.plan.requirements.map((requirement) => requirement.id)).toEqual(["R-1", "R-2"]);
    expect(result.plan.requirements[0]?.origin.input_id).toBe("S-1");
    expect(result.plan.requirements[1]?.origin.input_id).toBe("S-2");
  });

  it("(k) 既存の確定する組の plan と SHA-256 は、この Issue の前後で等しい（対応は仕様に混ざらない）", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_OUTPUT_CLEAR),
    ]);
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswersFor([]) });

    const result = await runPlan(makePlanInput(recording.client, judge, ANSWER_NONE));

    expect(result.kind).toBe("confirmed");
    if (result.kind !== "confirmed") return;
    // 仕様は §4 の欄だけからなる。対応（内部の写像）は混ざらない——だから SHA-256 も変わらない
    expect(Object.keys(result.plan).sort()).toEqual([
      "accepted_unwritable",
      "confirmation",
      "decisions",
      "inputs",
      "open_issues",
      "plan_id",
      "requirements",
      "revision",
      "schema_version",
      "vocabulary_version",
    ]);
    expect(JSON.stringify(result.plan)).not.toContain("sourceCorrespondence");
    expect(await checkConfirmedPlan(result.plan)).toEqual([]);
    expect(await isConfirmationValid(result.plan)).toBe(true);
    expect(result.plan.confirmation.sha256).toBe(await planDigest(result.plan));
    // 要件の数・ID・出どころは P1 の一覧のまま
    expect(result.plan.requirements.map((requirement) => requirement.id)).toEqual(["R-1", "R-2"]);
    expect(result.plan.requirements.map((requirement) => requirement.origin.input_id)).toEqual(["S-1", "S-2"]);
  });
});

