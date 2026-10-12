// 答えを反映する（plan/answers.ts）の unit テスト（04-plan-agent.md §3 P5・§6）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定したいのは 5 つ。
//   1. 存在しない質問 ID・選択肢 ID・古い版への答えを断る
//   2. 運用の指示は要件にしない
//   3. 矛盾は次の往復の質問にする
//   4. 選択肢に当たる自由入力は、その選択肢の答えにする
//   5. 自由入力が長すぎれば断る
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeQuestion, JudgeRequest } from "../judge.js";
import { AGENT_LIMITS } from "../limits.js";
import { contradictionQuestion, freeTextQuestionName, runAnswers, validateAnswer, type PlanAnswerDraft } from "./answers.js";
import type { PlanQuestion } from "./questions.js";

const choice = (value: string, confidence?: number): JudgeAnswer => ({
  kind: "choice",
  choice: value,
  probabilities: undefined,
  probability: undefined,
  confidence,
});

/** 問いの `instructions` を写像として読む（object でないときは undefined） */
function instructionsOf(question: JudgeQuestion | undefined): Record<string, unknown> | undefined {
  const instructions = question?.instructions;
  return typeof instructions === "object" ? (instructions as Record<string, unknown>) : undefined;
}

const QUESTION: PlanQuestion = {
  id: "Q-1",
  openIssueId: "OI-1",
  revision: 2,
  text: "どちらにしますか",
  choices: [
    { id: "c1", text: "こちら" },
    { id: "c2", text: "あちら" },
  ],
  recommended: { choiceId: "c1", reason: "依頼に沿う" },
  allowFreeText: true,
};

const answer = (overrides: AnswerOverrides = {}): PlanAnswerDraft => {
  const choiceId = "choiceId" in overrides ? overrides.choiceId : "c1";
  const freeText = overrides.freeText;
  return {
    id: overrides.id ?? "A-1",
    questionId: overrides.questionId ?? "Q-1",
    revision: overrides.revision ?? 2,
    ...(choiceId === undefined ? {} : { choiceId }),
    ...(freeText === undefined ? {} : { freeText }),
  };
};

interface AnswerOverrides {
  readonly id?: string;
  readonly questionId?: string;
  readonly revision?: number;
  readonly choiceId?: string | undefined;
  readonly freeText?: string;
}

describe("答えのコードの検査（04 §6 の 6）", () => {
  it("正しい答えは通る", () => {
    expect(validateAnswer({ questions: [QUESTION], revision: 2, answer: answer() })).toEqual([]);
  });

  it("存在しない質問 ID を断る", () => {
    const problems = validateAnswer({ questions: [QUESTION], revision: 2, answer: answer({ questionId: "Q-9" }) });
    expect(problems.map((problem) => problem.code)).toContain("unknown-question");
  });

  it("存在しない選択肢 ID を断る", () => {
    const problems = validateAnswer({ questions: [QUESTION], revision: 2, answer: answer({ choiceId: "c9" }) });
    expect(problems.map((problem) => problem.code)).toContain("unknown-choice");
  });

  it("古い版への答えを断る", () => {
    const problems = validateAnswer({ questions: [QUESTION], revision: 3, answer: answer({ revision: 2 }) });
    expect(problems.map((problem) => problem.code)).toContain("stale-revision");
  });

  it("古い版の質問への答えも断る", () => {
    const oldQuestion: PlanQuestion = { ...QUESTION, revision: 1 };
    const problems = validateAnswer({ questions: [oldQuestion], revision: 2, answer: answer() });
    expect(problems.map((problem) => problem.code)).toContain("stale-revision");
  });

  it("選択肢と自由入力の両方（またはどちらも無い）を断る", () => {
    const both = validateAnswer({
      questions: [QUESTION],
      revision: 2,
      answer: answer({ choiceId: "c1", freeText: "自由" }),
    });
    expect(both.map((problem) => problem.code)).toContain("shape");
    const neither = validateAnswer({ questions: [QUESTION], revision: 2, answer: { id: "A-1", questionId: "Q-1", revision: 2 } });
    expect(neither.map((problem) => problem.code)).toContain("shape");
  });

  it("自由入力が長すぎれば断る", () => {
    const problems = validateAnswer({
      questions: [QUESTION],
      revision: 2,
      answer: answer({ choiceId: undefined, freeText: "あ".repeat(AGENT_LIMITS.planFreeTextChars + 1) }),
    });
    expect(problems.map((problem) => problem.code)).toContain("free-text-length");
  });
});

describe("古い往復の答えの断り方（既存の検査順のまま。Issue #405）", () => {
  it("前の往復の質問 ID を指す答えは、unknown-question として rejected に残り、判定に回らない", async () => {
    const judge = createFakeJudge({}, { model: "fake-judge" });
    const result = await runAnswers({
      questions: [QUESTION],
      answers: [answer({ questionId: "Q1-1", choiceId: "c1" })],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.problems.map((problem) => problem.code)).toContain("unknown-question");
    expect(result.accepted).toEqual([]);
    expect(result.judgments).toEqual([]);
  });

  it("現在の質問 ID に古い版を付けた答えは、stale-revision として rejected に残り、判定に回らない", async () => {
    const judge = createFakeJudge({}, { model: "fake-judge" });
    const result = await runAnswers({
      questions: [QUESTION],
      answers: [answer({ questionId: "Q-1", revision: 1, choiceId: "c1" })],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.problems.map((problem) => problem.code)).toContain("stale-revision");
    expect(result.accepted).toEqual([]);
    expect(result.judgments).toEqual([]);
  });
});

describe("自由入力の振り分け（04 §6 の 5・7・05 §3・E6）", () => {
  it("運用の指示は要件にしない", async () => {
    const judge = createFakeJudge({ [freeTextQuestionName("A-1")]: choice("operational", 0.95) }, { model: "fake-judge" });
    const result = await runAnswers({
      questions: [QUESTION],
      answers: [answer({ choiceId: undefined, freeText: "試験を飛ばして進めて" })],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });
    expect(result.accepted).toEqual([]);
    expect(result.operational).toHaveLength(1);
    expect(result.followUpQuestions).toEqual([]);
  });

  it("矛盾は次の往復の質問にする", async () => {
    const judge = createFakeJudge({ [freeTextQuestionName("A-1")]: choice("contradiction", 0.9) }, { model: "fake-judge" });
    const result = await runAnswers({
      questions: [QUESTION],
      answers: [answer({ choiceId: undefined, freeText: "やっぱり記録しない" })],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });
    expect(result.contradictions).toHaveLength(1);
    expect(result.followUpQuestions).toHaveLength(1);
    const followUp = result.followUpQuestions[0];
    expect(followUp?.id).toBe("contradiction:A-1");
    // 選択肢 2 つ・推奨 1 つ・自由入力あり（正しい問いの形）
    expect(followUp?.choices).toHaveLength(2);
    expect(followUp?.recommended?.choiceId).toBe("keep-previous");
    expect(followUp?.allowFreeText).toBe(true);
  });

  it("新しい要件はそのまま要件に反映する", async () => {
    const judge = createFakeJudge({ [freeTextQuestionName("A-1")]: choice("new-requirement", 0.9) }, { model: "fake-judge" });
    const result = await runAnswers({
      questions: [QUESTION],
      answers: [answer({ choiceId: undefined, freeText: "期限も記録する" })],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });
    expect(result.accepted).toEqual([
      { answerId: "A-1", questionId: "Q-1", label: "new-requirement", freeText: "期限も記録する" },
    ]);
  });

  it("選択肢に当たる自由入力は、その選択肢の答えにする", async () => {
    const judge = createFakeJudge({ [freeTextQuestionName("A-1")]: choice("c2", 0.9) }, { model: "fake-judge" });
    const result = await runAnswers({
      questions: [QUESTION],
      answers: [answer({ choiceId: undefined, freeText: "あちらで" })],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });
    expect(result.accepted).toEqual([
      { answerId: "A-1", questionId: "Q-1", label: "choice", choiceId: "c2", freeText: "あちらで" },
    ]);
  });

  it("選択肢を選んだだけの答えは、判定を呼ばずに反映する", async () => {
    // 判定に答えを用意しない（呼ばれたら FakeJudgeError になる）
    const judge = createFakeJudge({}, { model: "fake-judge" });
    const result = await runAnswers({
      questions: [QUESTION],
      answers: [answer()],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });
    expect(result.accepted).toEqual([{ answerId: "A-1", questionId: "Q-1", label: "choice", choiceId: "c1" }]);
    expect(result.judgments).toEqual([]);
  });

  it("コードで断った答えは、判定に回さない", async () => {
    const judge = createFakeJudge({}, { model: "fake-judge" });
    const result = await runAnswers({
      questions: [QUESTION],
      answers: [answer({ questionId: "Q-9", choiceId: undefined, freeText: "自由" })],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.problems.map((problem) => problem.code)).toContain("unknown-question");
    expect(result.accepted).toEqual([]);
  });
  it("問いの instructions に、対象の答えの文と、対応する問いの文を載せる（Issue #376）", async () => {
    const requests: JudgeRequest[] = [];
    const judge: Judge = {
      async judge(request: JudgeRequest) {
        requests.push(request);
        const answers: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) answers[name] = choice("new-requirement", 0.9);
        return { answers, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
      },
    };
    await runAnswers({
      questions: [QUESTION, { ...QUESTION, id: "Q-2", text: "記録する範囲は" }],
      answers: [
        { id: "A-1", questionId: "Q-1", revision: 2, freeText: "期限も記録する" },
        { id: "A-2", questionId: "Q-2", revision: 2, freeText: "今月だけ" },
      ],
      revision: 2,
      source: "タスクを記録する。",
      judge,
    });

    const questions = requests[0]?.questions ?? {};
    const q1 = questions[freeTextQuestionName("A-1")];
    const q2 = questions[freeTextQuestionName("A-2")];
    // instructions は object（対象の答えの文と対応する問いの文を問いの中に載せる）
    expect(q1?.instructions).toBeTypeOf("object");
    expect(q1?.instructions).toMatchObject({ answer: "期限も記録する", question: "どちらにしますか" });
    // 同じ呼び出しの中の 2 つの問いで、対象の答えの文が別々になる
    expect(q2?.instructions).toMatchObject({ answer: "今月だけ", question: "記録する範囲は" });
    // 問いの文は英語
    expect(String(instructionsOf(q1)?.ask)).toMatch(/^[\x20-\x7E]+$/);
  });
});

describe("矛盾の問いの形", () => {
  it("矛盾から組み立てる問いは、版を引き継ぎ、推奨は前の答えを保つことにする", () => {
    const followUp = contradictionQuestion(
      { answerId: "A-1", questionId: "Q-1", label: "contradiction", freeText: "記録しない" },
      4,
    );
    expect(followUp.revision).toBe(4);
    expect(followUp.openIssueId).toBe("OI:contradiction:A-1");
    expect(followUp.recommended?.choiceId).toBe("keep-previous");
  });
});
