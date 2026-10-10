// P6 照合と確定（04-plan-agent.md §3 P6・§4）。
//
// **会話の全体（原文・質問・答え）と要件の一覧を、双方向に照らす**：会話のどの部分も要件か決めたことに
// 対応するか／どの要件も出どころ（原文か答え）を持つか。そのうえで §4 の形（`ConfirmedPlan`）にし、
// **未解決の事項がすべて「解決の根拠つき」で閉じている**ことをコードが確かめる（#331 の `checkPlan`）。
//
// コードが決めること：
//   1. **答えから増えた要件の出どころを、答えの ID にする**（`added` の要件の origin を答えへ寄せる）
//   2. **覆われていない原文の文があれば確定しない**（原文を文に切り、各文が要件の出どころで覆われているか）
//   3. どの答えも、要件の出どころか変更の答えとして使われているか（使われていなければ確定しない）
//
// 判定の口（Noul）は、原文・答えの各部分が要件に覆われるかを**助言**として聞く（引用の実在はコードのまま。
// 05 §3・E5）。**判定で確定を開けない**——合否はコードが決める（05 §4）。
import type {
  ConfirmedPlan,
  PlanAcceptedUnwritable,
  PlanChange,
  PlanDecision,
  PlanInput,
  PlanOpenIssue,
  PlanProblem,
  PlanRequirement,
  PlanSourceInput,
} from "@musunest/appspec-schema";
import { PLAN_SPEC_SCHEMA_VERSION, checkPlan, planDigest } from "@musunest/appspec-schema";
import type { Judge, JudgeQuestion } from "../judge.js";
import { splitSourceSentences } from "../stages/reverse-check.js";

/** P6 の照合の誤りの種類 */
export const CONFIRM_PROBLEM_CODES = [
  /** 覆われていない原文の文がある */
  "uncovered-source",
  /** どの要件にも出どころとして使われていない答えがある */
  "uncovered-answer",
  /** 答えから増えた要件の出どころが、その答えになっていない */
  "origin-not-answer",
] as const;
export type ConfirmProblemCode = (typeof CONFIRM_PROBLEM_CODES)[number];

/** P6 の照合の誤り 1 つ */
export interface ConfirmProblem {
  readonly code: ConfirmProblemCode;
  readonly path: string;
  readonly message: string;
}

/** 判定 1 件の記録（問いの ID・確率・閾値を満たしたか・モデルの版） */
export interface ConfirmJudgment {
  readonly questionId: string;
  readonly value: number;
  /** 「覆われている」の確率が閾値以上か（助言。合否はコードが決める。05 §4） */
  readonly meetsThreshold: boolean;
  readonly model: string;
  readonly answeredBy: string;
}

/** P6 が受け取るもの */
export interface ConfirmInput {
  readonly planId: string;
  /** 確定しようとしている仕様の版（答えを反映するたびに上がる） */
  readonly revision: number;
  /** P3 が照らした文書（語彙）の版 */
  readonly vocabularyVersion: string;
  /** 依頼文（原文） */
  readonly source: string;
  readonly inputs: readonly PlanInput[];
  readonly requirements: readonly PlanRequirement[];
  readonly openIssues: readonly PlanOpenIssue[];
  readonly decisions: readonly PlanDecision[];
  readonly acceptedUnwritable: readonly PlanAcceptedUnwritable[];
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  /** 判定の口（覆いの助言。実 API は呼ばない） */
  readonly judge: Judge;
  /** 覆いの助言を見る閾値 */
  readonly threshold: number;
}

/** P6 の結果 */
export interface ConfirmResult {
  /** §4 の形（確認の SHA-256 つき） */
  readonly plan: ConfirmedPlan;
  /** コードが見つけた照合の誤り（空なら覆いは取れている） */
  readonly problems: readonly ConfirmProblem[];
  /** #331 の `checkPlan` が見つけた誤り（未解決の事項・実在しない ID など） */
  readonly planProblems: readonly PlanProblem[];
  /** 判定の記録 */
  readonly judgments: readonly ConfirmJudgment[];
  /** 確定できるか（`problems` と `planProblems` が空のときだけ真） */
  readonly confirmed: boolean;
}

/**
 * 答えから増えた要件（`change.kind === "added"` で `answer_id` を持つもの）の出どころを、その答えの ID に
 * 寄せる（04 §3 P6・§4）。要件の文を、その答えからの引用にする。それ以外の要件はそのまま。
 */
export function normalizeOrigins(
  requirements: readonly PlanRequirement[],
  inputs: readonly PlanInput[],
): readonly PlanRequirement[] {
  const answerIds = new Set(inputs.filter((input) => input.kind === "answer").map((input) => input.id));
  return requirements.map((requirement) => {
    const answerId = requirement.change?.answer_id;
    if (requirement.change?.kind === "added" && answerId !== undefined && answerIds.has(answerId)) {
      return { ...requirement, origin: { input_id: answerId, quote: requirement.text } };
    }
    return requirement;
  });
}

/** 原文の文の範囲（`text`）と、その文を覆う要件の出どころの ID（`inputId`）の組 */
interface SentenceCoverage {
  readonly text: string;
  readonly covered: boolean;
}

/**
 * 原文を文に切り、各文が**要件の出どころ**（`inputs` の `source`）で覆われているかを求める（04 §3 P6）。
 * 文に対応する `source` の入力が無い、またはその入力がどの要件の出どころにもなっていなければ、覆われて
 * いない。
 */
export function checkSourceCoverage(
  source: string,
  inputs: readonly PlanInput[],
  requirements: readonly PlanRequirement[],
): readonly SentenceCoverage[] {
  const coveredInputIds = new Set(requirements.map((requirement) => requirement.origin.input_id));
  const sourceInputs = inputs.filter((input): input is PlanSourceInput => input.kind === "source");
  const result: SentenceCoverage[] = [];
  for (const range of splitSourceSentences(source)) {
    const text = source.slice(range.start, range.end);
    const trimmed = text.trim();
    const match = sourceInputs.find((input) => input.text.trim() === trimmed);
    result.push({ text: trimmed, covered: match !== undefined && coveredInputIds.has(match.id) });
  }
  return result;
}

/** どの要件の出どころ／変更の答えにも使われていない答えの ID を求める（04 §3 P6） */
export function uncoveredAnswerIds(
  inputs: readonly PlanInput[],
  requirements: readonly PlanRequirement[],
): readonly string[] {
  const used = new Set<string>();
  for (const requirement of requirements) {
    used.add(requirement.origin.input_id);
    const answerId = requirement.change?.answer_id;
    if (answerId !== undefined) used.add(answerId);
  }
  return inputs.filter((input) => input.kind === "answer" && !used.has(input.id)).map((input) => input.id);
}

/** 依頼文・答えの各部分を覆う問いの名前の頭（問いの名前は `cover:<入力 ID>`） */
export const CONFIRM_QUESTION_PREFIX = "cover";

/** 覆いの助言の問いの名前 */
export function confirmQuestionName(inputId: string): string {
  return `${CONFIRM_QUESTION_PREFIX}:${inputId}`;
}

/**
 * P6 を 1 回回す。出どころを正規化し、覆いをコードで確かめ、判定の口の Noul で助言を取り、§4 の形にして
 * #331 の `checkPlan` を掛ける。`confirmed` は**コードの誤りと `checkPlan` の誤りがどちらも空**のときだけ真。
 */
export async function runConfirm(input: ConfirmInput): Promise<ConfirmResult> {
  const requirements = normalizeOrigins(input.requirements, input.inputs);
  const problems: ConfirmProblem[] = [];

  // 1. 答えから増えた要件の出どころが、その答えになっているか（正規化後は必ず満たすが、明示に確かめる）
  const answerIds = new Set(input.inputs.filter((entry) => entry.kind === "answer").map((entry) => entry.id));
  requirements.forEach((requirement, index) => {
    const change: PlanChange | undefined = requirement.change;
    if (change?.kind === "added" && change.answer_id !== undefined && answerIds.has(change.answer_id)) {
      if (requirement.origin.input_id !== change.answer_id) {
        problems.push({
          code: "origin-not-answer",
          path: `requirements[${index}].origin.input_id`,
          message: `${requirement.id}: 答え ${change.answer_id} から増えた要件の出どころが、その答えになっていない`,
        });
      }
    }
  });

  // 2. 覆われていない原文の文があれば確定しない
  checkSourceCoverage(input.source, input.inputs, requirements).forEach((sentence, index) => {
    if (!sentence.covered) {
      problems.push({
        code: "uncovered-source",
        path: `source[${index}]`,
        message: `原文の「${sentence.text}」がどの要件にも覆われていない`,
      });
    }
  });

  // 3. どの要件にも使われていない答えがあれば確定しない
  for (const answerId of uncoveredAnswerIds(input.inputs, requirements)) {
    problems.push({
      code: "uncovered-answer",
      path: `inputs.${answerId}`,
      message: `答え ${answerId} がどの要件にも対応していない`,
    });
  }

  // 4. 判定の口（Noul）に、各部分が覆われるかを助言として聞く（確定はできない）
  const judgments: ConfirmJudgment[] = [];
  const coverTargets = [
    ...input.inputs.filter((entry) => entry.kind === "source"),
    ...input.inputs.filter((entry) => entry.kind === "answer"),
  ];
  if (coverTargets.length > 0) {
    const questions: Record<string, JudgeQuestion> = {};
    for (const target of coverTargets) {
      questions[confirmQuestionName(target.id)] = {
        kind: "noul",
        instructions: "次の依頼文または答えの部分が、いずれかの要件に覆われているかを yes／no で答える。",
        criteria: { yes: "覆われている", no: "覆われていない" },
      };
    }
    const state = {
      requirements: requirements.map((requirement) => ({
        id: requirement.id,
        text: requirement.text,
        origin: requirement.origin,
      })),
      parts: coverTargets.map((target) => ({ id: target.id, kind: target.kind })),
    };
    const response = await input.judge.judge({ state, questions });
    for (const target of coverTargets) {
      const name = confirmQuestionName(target.id);
      const answer = response.answers[name];
      const value = answer !== undefined && answer.kind === "noul" ? answer.noul : 0;
      judgments.push({
        questionId: name,
        value,
        meetsThreshold: value >= input.threshold,
        model: response.model,
        answeredBy: response.answeredBy,
      });
    }
  }

  // 5. §4 の形にして、確認の SHA-256 を計算する（`confirmation` は自分自身の SHA なので混ぜない）
  const base = {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: input.planId,
    revision: input.revision,
    vocabulary_version: input.vocabularyVersion,
    inputs: input.inputs,
    requirements,
    open_issues: input.openIssues,
    decisions: input.decisions,
    accepted_unwritable: input.acceptedUnwritable,
  };
  const sha256 = await planDigest(base);
  const plan: ConfirmedPlan = {
    ...base,
    confirmation: { sha256, confirmed_at: input.confirmedAt, confirmed_by: input.confirmedBy },
  };

  // 6. #331 の検査（未解決の事項・実在しない ID・了承の範囲）
  const planProblems = checkPlan(plan);

  return {
    plan,
    problems,
    planProblems,
    judgments,
    confirmed: problems.length === 0 && planProblems.length === 0,
  };
}
