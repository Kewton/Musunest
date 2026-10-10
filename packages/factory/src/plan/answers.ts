// P5 答えを反映する（04-plan-agent.md §3 P5・§6）。
//
// **コードが答えを確かめる**：質問 ID・選択肢 ID・対象の版（古い質問への答えは断る）・自由入力の長さ
// （§6 の 6）。そのうえで、**自由入力**を判定の口の **Choice** で「選択肢に当たる／新しい要件／矛盾／
// 運用の指示」に分ける（§6 の 5・05 §3・E6）。**運用の指示は要件にしない**。**矛盾は次の往復で確かめる**
// （そのための問いを組み立てる。§6 の 7）。
//
// **実 API は呼ばない。** 判定は差し込まれた `Judge`（試験は偽物）だけを使う。
import type { Judge, JudgeAnswer, JudgeQuestion } from "../judge.js";
import { AGENT_LIMITS } from "../limits.js";
import type { PlanQuestion } from "./questions.js";

/** 自由入力の振り分けのラベル（04 §6 の 5・05 §3） */
export const ANSWER_LABELS = ["choice", "new-requirement", "contradiction", "operational"] as const;
export type AnswerLabel = (typeof ANSWER_LABELS)[number];

/** 答えの下書き（04 §4 `inputs` の `answer` に対応する）。選択肢か自由入力の**ちょうど一方**を持つ */
export interface PlanAnswerDraft {
  readonly id: string;
  readonly questionId: string;
  /** 答えたときの仕様の版（古い版への答えを断る根拠。§6 の 6） */
  readonly revision: number;
  readonly choiceId?: string;
  readonly freeText?: string;
}

/** 答えの検査の誤りの種類 */
export const ANSWER_PROBLEM_CODES = [
  /** 形（欄の欠け・選択肢と自由入力の両方／どちらも無い） */
  "shape",
  /** 存在しない質問 ID */
  "unknown-question",
  /** その質問の選択肢に無い選択肢 ID */
  "unknown-choice",
  /** 古い版への答え */
  "stale-revision",
  /** 自由入力が長すぎる */
  "free-text-length",
] as const;
export type AnswerProblemCode = (typeof ANSWER_PROBLEM_CODES)[number];

/** 答えの検査の誤り 1 つ */
export interface AnswerProblem {
  readonly code: AnswerProblemCode;
  readonly path: string;
  readonly message: string;
}

/** `validateAnswer` の引数 */
export interface ValidateAnswerInput {
  /** いま有効な質問の束 */
  readonly questions: readonly PlanQuestion[];
  /** いまの仕様の版 */
  readonly revision: number;
  readonly answer: PlanAnswerDraft;
  /** 自由入力の長さの上限（既定は `AGENT_LIMITS.planFreeTextChars`） */
  readonly freeTextMax?: number;
}

/**
 * 答え 1 つをコードで確かめる（04 §6 の 6）。質問 ID・選択肢 ID・対象の版・自由入力の長さを見る。
 * 合わない箇所を**すべて**挙げて返す。空なら通る。
 */
export function validateAnswer(input: ValidateAnswerInput): readonly AnswerProblem[] {
  const problems: AnswerProblem[] = [];
  const { answer } = input;
  const report = (code: AnswerProblemCode, path: string, message: string): void => {
    problems.push({ code, path, message });
  };

  const hasChoice = answer.choiceId !== undefined;
  const hasFreeText = answer.freeText !== undefined;
  if (hasChoice === hasFreeText) {
    report("shape", "answer", "選択肢 ID か自由入力のちょうど一方を書く");
  }
  if (answer.id === "") report("shape", "answer.id", "答えの ID が空である");
  if (answer.questionId === "") {
    report("shape", "answer.questionId", "質問 ID が空である");
    return problems;
  }

  const question = input.questions.find((candidate) => candidate.id === answer.questionId);
  if (question === undefined) {
    report("unknown-question", "answer.questionId", `${answer.questionId}: 質問に無い`);
    return problems;
  }
  if (answer.revision !== input.revision || question.revision !== input.revision) {
    report(
      "stale-revision",
      "answer.revision",
      `古い版への答えである（いまの版 ${input.revision}、答えの版 ${answer.revision}、質問の版 ${question.revision}）`,
    );
  }
  if (hasChoice) {
    const choiceId = answer.choiceId ?? "";
    if (!question.choices.some((choice) => choice.id === choiceId)) {
      report("unknown-choice", "answer.choiceId", `${choiceId}: その質問の選択肢に無い`);
    }
  }
  if (hasFreeText) {
    const max = input.freeTextMax ?? AGENT_LIMITS.planFreeTextChars;
    const actual = (answer.freeText ?? "").length;
    if (actual > max) {
      report("free-text-length", "answer.freeText", `自由入力が長すぎる（上限 ${max}、実際 ${actual}）`);
    }
  }
  return problems;
}

/** 自由入力の振り分けの問いの名前の頭（問いの名前は `answer-free:<答え ID>`） */
export const FREE_TEXT_QUESTION_PREFIX = "answer-free";

/** 自由入力の振り分けの問いの名前 */
export function freeTextQuestionName(answerId: string): string {
  return `${FREE_TEXT_QUESTION_PREFIX}:${answerId}`;
}

/** 振り分けの結果（答え 1 つ） */
export interface ClassifiedAnswer {
  readonly answerId: string;
  readonly questionId: string;
  readonly label: AnswerLabel;
  /** 「選択肢に当たる」ときの選択肢 ID */
  readonly choiceId?: string;
  readonly freeText?: string;
}

/** 判定 1 件の記録 */
export interface AnswerJudgment {
  readonly questionId: string;
  readonly answer: string;
  readonly confidence: number | undefined;
  readonly model: string;
  readonly answeredBy: string;
}

/** 断った答え 1 つと、その理由 */
export interface RejectedAnswer {
  readonly answerId: string;
  readonly problems: readonly AnswerProblem[];
}

/** P5 の結果 */
export interface AnswerResult {
  /** 要件に反映する答え（選択肢・新しい要件） */
  readonly accepted: readonly ClassifiedAnswer[];
  /** 運用の指示（**要件にしない**。§6 の 5） */
  readonly operational: readonly ClassifiedAnswer[];
  /** 矛盾（次の往復で確かめる。§6 の 7） */
  readonly contradictions: readonly ClassifiedAnswer[];
  /** 矛盾から組み立てた、次の往復の質問 */
  readonly followUpQuestions: readonly PlanQuestion[];
  /** コードで断った答え */
  readonly rejected: readonly RejectedAnswer[];
  readonly judgments: readonly AnswerJudgment[];
}

/** P5 が受け取るもの */
export interface AnswersInput {
  /** いま有効な質問の束 */
  readonly questions: readonly PlanQuestion[];
  readonly answers: readonly PlanAnswerDraft[];
  /** いまの仕様の版 */
  readonly revision: number;
  /** 依頼文（原文。矛盾の判定に使う） */
  readonly source: string;
  /** これまでの答え（矛盾の判定に使う） */
  readonly priorAnswers?: readonly ClassifiedAnswer[];
  /** 判定の口（Jev・LLM・偽物。試験は偽物を差し込む） */
  readonly judge: Judge;
  /** 自由入力の長さの上限（既定は `AGENT_LIMITS.planFreeTextChars`） */
  readonly freeTextMax?: number;
}

/**
 * 矛盾から組み立てる、次の往復の質問（04 §6 の 7）。前の答え・原文と食い違う自由入力を、次の往復で
 * 確かめる。選択肢は「前の答えを保つ」「新しい答えを使う」の 2 つで、推奨は前の答えである。
 */
export function contradictionQuestion(
  answer: ClassifiedAnswer,
  revision: number,
): PlanQuestion {
  const id = `contradiction:${answer.answerId}`;
  return {
    id,
    openIssueId: `OI:${id}`,
    revision,
    text: `「${answer.freeText ?? ""}」は、前の答えや依頼と食い違っています。どちらにしますか。`,
    choices: [
      { id: "keep-previous", text: "前の答えを保つ" },
      { id: "use-new", text: "新しい答えを使う" },
    ],
    recommended: { choiceId: "keep-previous", reason: "前の答えのほうが依頼に沿うと考えられる" },
    allowFreeText: true,
  };
}

function choiceOf(answer: JudgeAnswer | undefined): {
  readonly choice: string | undefined;
  readonly confidence: number | undefined;
} {
  if (answer === undefined || answer.kind !== "choice") return { choice: undefined, confidence: undefined };
  return { choice: answer.choice, confidence: answer.confidence };
}

/**
 * P5 を 1 回回す。コードで答えを確かめ、自由入力を判定の口の Choice で振り分ける。
 * **運用の指示は要件にしない**。**矛盾は次の往復の質問にする**。
 */
export async function runAnswers(input: AnswersInput): Promise<AnswerResult> {
  const accepted: ClassifiedAnswer[] = [];
  const operational: ClassifiedAnswer[] = [];
  const contradictions: ClassifiedAnswer[] = [];
  const followUpQuestions: PlanQuestion[] = [];
  const rejected: RejectedAnswer[] = [];
  const judgments: AnswerJudgment[] = [];

  const byId = new Map(input.questions.map((question) => [question.id, question]));
  const freeTextTargets: { readonly answer: PlanAnswerDraft; readonly question: PlanQuestion }[] = [];

  for (const answer of input.answers) {
    const problems = validateAnswer({
      questions: input.questions,
      revision: input.revision,
      answer,
      ...(input.freeTextMax === undefined ? {} : { freeTextMax: input.freeTextMax }),
    });
    if (problems.length > 0) {
      rejected.push({ answerId: answer.id, problems });
      continue;
    }
    const question = byId.get(answer.questionId);
    if (question === undefined) continue;
    if (answer.choiceId !== undefined) {
      // 選択肢を選んだだけの答えは、そのまま要件に反映する
      accepted.push({
        answerId: answer.id,
        questionId: answer.questionId,
        label: "choice",
        choiceId: answer.choiceId,
      });
      continue;
    }
    freeTextTargets.push({ answer, question });
  }

  if (freeTextTargets.length > 0) {
    const questions: Record<string, JudgeQuestion> = {};
    for (const target of freeTextTargets) {
      const criteria: Record<string, string> = {};
      for (const choice of target.question.choices) criteria[choice.id] = choice.text;
      criteria["new-requirement"] = "選択肢に当たらない、新しい要件";
      criteria["contradiction"] = "前の答えや依頼と食い違う";
      criteria["operational"] = "運用についての指示（試験を飛ばして・前の答えを無視してなど。要件にしない）";
      questions[freeTextQuestionName(target.answer.id)] = {
        kind: "choice",
        instructions:
          "自由入力が、この質問のどの選択肢に当たるか、または新しい要件・矛盾・運用の指示のどれかを選ぶ。選択肢に当たるなら、その選択肢の ID を選ぶ。",
        criteria,
      };
    }
    const state = {
      source: input.source,
      priorAnswers: input.priorAnswers ?? [],
      answers: freeTextTargets.map((target) => ({
        answerId: target.answer.id,
        questionId: target.answer.questionId,
        question: target.question.text,
        freeText: target.answer.freeText ?? "",
        choices: target.question.choices,
      })),
    };
    const response = await input.judge.judge({ state, questions });

    for (const target of freeTextTargets) {
      const name = freeTextQuestionName(target.answer.id);
      const { choice, confidence } = choiceOf(response.answers[name]);
      judgments.push({
        questionId: name,
        answer: choice ?? "unknown",
        confidence,
        model: response.model,
        answeredBy: response.answeredBy,
      });
      const choiceIds = new Set(target.question.choices.map((one) => one.id));
      const classified: ClassifiedAnswer = {
        answerId: target.answer.id,
        questionId: target.answer.questionId,
        label: "new-requirement",
        freeText: target.answer.freeText ?? "",
      };
      if (choice !== undefined && choiceIds.has(choice)) {
        accepted.push({ ...classified, label: "choice", choiceId: choice });
        continue;
      }
      if (choice === "operational") {
        operational.push({ ...classified, label: "operational" });
        continue;
      }
      if (choice === "contradiction") {
        const contradiction: ClassifiedAnswer = { ...classified, label: "contradiction" };
        contradictions.push(contradiction);
        followUpQuestions.push(contradictionQuestion(contradiction, input.revision));
        continue;
      }
      if (choice === "new-requirement") {
        accepted.push({ ...classified, label: "new-requirement" });
        continue;
      }
      // 分類できない答えは断る（要件にしない。fail-closed）
      rejected.push({
        answerId: target.answer.id,
        problems: [{ code: "shape", path: `${name}`, message: `分類できない答え: ${String(choice)}` }],
      });
    }
  }

  return { accepted, operational, contradictions, followUpQuestions, rejected, judgments };
}
