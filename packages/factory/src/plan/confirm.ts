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
  PlanQuestionInput,
  PlanRequirement,
  PlanSourceInput,
} from "@musunest/appspec-schema";
import { PLAN_SPEC_SCHEMA_VERSION, checkPlan, planDigest } from "@musunest/appspec-schema";
import type { Judge, JudgeQuestion } from "../judge.js";
import type { SourceRange } from "../pipeline.js";
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
  /**
   * P1 が受け取った依頼の枠の文の範囲（Issue #372）。**枠の範囲も覆われていると数える**——枠の文は
   * 要件にしないので、要件の出どころでは覆われないためである。無いときは空の配列として扱う。
   */
  readonly framing?: readonly SourceRange[];
  /**
   * 要件 ID → その要件の引用と**重なる原文の文の入力 ID の並び**の対応（Issue #487）。P2 を終えた一覧から
   * 1 回だけ組んだものを渡す。渡されたときだけ、対応の並びにある文を「覆われている」と数える——引用が
   * 2 文以上にまたがるとき、P6 が出どころ 1 つ（多対 1）でしか数えないために後ろの文が未使用になるのを
   * 防ぐ（P2 は範囲の重なりで多対多に数えている）。**確定した仕様の形（§4）・SHA には混ぜず、判定の
   * 材料にも足さない。** 渡さないときは今までどおりに振る舞う。
   */
  readonly sourceCorrespondence?: ReadonlyMap<string, readonly string[]>;
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
 * いない。ただし**枠の範囲**（`framing`）に重なる文は、覆われていると数える（Issue #372）。
 *
 * さらに、**対応**（`correspondence`）が渡されたときだけ、その要件の対応の並びにある文の入力も
 * 覆われていると数える（Issue #487）。数えてよいのは、**渡した要件の一覧にあり**、出どころの正規化
 * （`normalizeOrigins`）のあとも出どころが**原文の入力のまま**の要件だけである。対応の要件 ID が一覧に
 * 無いとき・原文の入力でない ID・実在しない ID は、どの文の入力とも一致しないので数えられない
 * （黙って捨て、覆いの根拠にしない）。
 */
export function checkSourceCoverage(
  source: string,
  inputs: readonly PlanInput[],
  requirements: readonly PlanRequirement[],
  framing: readonly SourceRange[] = [],
  correspondence?: ReadonlyMap<string, readonly string[]>,
): readonly SentenceCoverage[] {
  const coveredInputIds = new Set(requirements.map((requirement) => requirement.origin.input_id));
  const sourceInputs = inputs.filter((input): input is PlanSourceInput => input.kind === "source");
  const sourceInputIds = new Set(sourceInputs.map((input) => input.id));
  // 対応から、覆いの根拠にしてよい文の入力 ID を集める（Issue #487）。一覧にある要件だけを見て、
  // 出どころが原文の入力のままの要件に限る（答えへ正規化された要件の対応は数えない）。
  const coveredByCorrespondence = new Set<string>();
  if (correspondence !== undefined) {
    for (const requirement of requirements) {
      if (!sourceInputIds.has(requirement.origin.input_id)) continue;
      for (const inputId of correspondence.get(requirement.id) ?? []) {
        if (sourceInputIds.has(inputId)) coveredByCorrespondence.add(inputId);
      }
    }
  }
  const result: SentenceCoverage[] = [];
  for (const range of splitSourceSentences(source)) {
    const text = source.slice(range.start, range.end);
    const trimmed = text.trim();
    const match = sourceInputs.find((input) => input.text.trim() === trimmed);
    const byFraming = framing.some((frame) => frame.start < range.end && range.start < frame.end);
    result.push({
      text: trimmed,
      covered:
        byFraming ||
        (match !== undefined && (coveredInputIds.has(match.id) || coveredByCorrespondence.has(match.id))),
    });
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
 * 覆いの問いの `instructions` に載せる、対象の部分の文（Issue #376）。**問いの名前だけで対象を区別しても、
 * Jev は名前を読まない**ので、部分の文そのものを問いに載せる。部分は 3 種類ある：
 *   - 原文の文 … その文をそのまま載せる
 *   - 自由入力の答え … その文と、元の問いの文を載せる
 *   - 選択式の答え … 質問 ID と選択肢 ID から**選択肢の文を引き**、元の問いの文も添える
 * 問いの文そのもの（`ask`）は英語にする。
 */
function coverInstructions(
  target: PlanInput,
  questionsById: ReadonlyMap<string, PlanQuestionInput>,
): Readonly<Record<string, unknown>> {
  if (target.kind === "source") {
    return {
      part: target.text,
      ask: "Is this part of the request covered by one of the requirements? Answer yes or no.",
    };
  }
  if (target.kind === "answer") {
    const question = questionsById.get(target.question_id);
    const originalQuestion = question?.text ?? "";
    if (target.choice_id !== undefined) {
      const choice = question?.choices.find((candidate) => candidate.id === target.choice_id);
      return {
        part: choice?.text ?? target.choice_id,
        choice_id: target.choice_id,
        question: originalQuestion,
        ask: "Is the chosen option covered by one of the requirements? Answer yes or no.",
      };
    }
    return {
      part: target.free_text ?? "",
      question: originalQuestion,
      ask: "Is this answer covered by one of the requirements? Answer yes or no.",
    };
  }
  // 覆いの対象は原文と答えだけである（質問は出どころの引用としてだけ数える）
  return {
    part: target.text,
    ask: "Is this part of the request covered by one of the requirements? Answer yes or no.",
  };
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
          message: "答えから増えた要件の出どころが、その答えになっていない",
        });
      }
    }
  });

  // 2. 覆われていない原文の文があれば確定しない（枠の範囲も覆われていると数える。Issue #372。
  //    対応が渡されたときは、対応の並びにある文も覆われていると数える。Issue #487）
  checkSourceCoverage(
    input.source,
    input.inputs,
    requirements,
    input.framing ?? [],
    input.sourceCorrespondence,
  ).forEach((sentence, index) => {
    if (!sentence.covered) {
      problems.push({
        code: "uncovered-source",
        path: `source[${index}]`,
        message: "原文の文がどの要件にも覆われていない",
      });
    }
  });

  // 3. どの要件にも使われていない答えがあれば確定しない
  for (const answerId of uncoveredAnswerIds(input.inputs, requirements)) {
    problems.push({
      code: "uncovered-answer",
      path: `inputs.${answerId}`,
      message: "答えがどの要件にも対応していない",
    });
  }

  // 4. 判定の口（Noul）に、各部分が覆われるかを助言として聞く（確定はできない）
  const judgments: ConfirmJudgment[] = [];
  const coverTargets = [
    ...input.inputs.filter((entry) => entry.kind === "source"),
    ...input.inputs.filter((entry) => entry.kind === "answer"),
  ];
  if (coverTargets.length > 0) {
    const questionsById = new Map<string, PlanQuestionInput>();
    for (const entry of input.inputs) {
      if (entry.kind === "question") questionsById.set(entry.id, entry);
    }
    const questions: Record<string, JudgeQuestion> = {};
    for (const target of coverTargets) {
      // 対象の部分の文そのものを問いの `instructions` に載せる（問いの名前だけでは Jev が読めない。
      // 選択式の答えは、選択肢の文を引き、元の問いの文も添える。Issue #376）。
      questions[confirmQuestionName(target.id)] = {
        kind: "noul",
        instructions: coverInstructions(target, questionsById),
        criteria: { yes: "覆われている", no: "覆われていない" },
      };
    }
    // state には、問いをまたいで共通に要る要件の一覧だけを残す（部分の文は問いの欄へ移した。Issue #376）
    const state = {
      requirements: requirements.map((requirement) => ({
        id: requirement.id,
        text: requirement.text,
        origin: requirement.origin,
      })),
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
