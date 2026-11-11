// 画面の答えを待つ答え役（studio-s1.md §4.1・Issue #867 の目的・1）。
//
// 工場の Plan の口（`PlanResponder`）の実装。質問・確認を親（画面）へ送り、親から答えが届くまで解決しない
// Promise を返す。Plan は往復ごとに await するので、これで画面と同期できる。
// 締切は絶対時刻で、確認の答えが締切を過ぎてから届いたら「やめる」を返し、`timedOut` を立てる。
import type {
  PlanAnswerDraft,
  PlanAnswerOutcome,
  PlanAnswerRequest,
  PlanConfirmationView,
  PlanConfirmOutcome,
  PlanResponder,
} from "@musunest/factory";
import { toRunnerConfirmation } from "./confirm-view.js";
import type {
  ConfirmOutcome,
  RunnerAnswers,
  RunnerConfirmation,
  RunnerQuestion,
  RunnerQuestionBundle,
  SubmittedAnswer,
} from "./runner.js";

/** 画面（親）とのやり取りの口 */
export interface PlanResponderChannel {
  /** 質問の束を画面へ送り、答えが届くまで待つ */
  readonly ask: (bundle: RunnerQuestionBundle) => Promise<RunnerAnswers>;
  /** 確認を画面へ送り、答えが届くまで待つ */
  readonly confirm: (confirmation: RunnerConfirmation) => Promise<ConfirmOutcome>;
}

export interface PlanResponderOptions {
  readonly channel: PlanResponderChannel;
  /** いまの時刻（試験は固定する） */
  readonly now?: () => number;
  /** Plan の締切（絶対時刻。ミリ秒） */
  readonly deadline?: number;
}

/** 答える役。`timedOut` は締切を過ぎて確認の答えを受けたか */
export interface WaitingPlanResponder extends PlanResponder {
  readonly timedOut: boolean;
}

/** 工場の質問 1 つを、画面の型へ写す */
function toRunnerQuestion(question: PlanAnswerRequest["questions"][number]): RunnerQuestion {
  const recommended = question.recommended;
  const firstChoice = question.choices[0];
  return {
    id: question.id,
    text: question.text,
    choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })),
    recommended:
      recommended === undefined
        ? { choiceId: firstChoice?.id ?? "", reason: "" }
        : { choiceId: recommended.choiceId, reason: recommended.reason },
    allowFreeText: question.allowFreeText ?? false,
  };
}

/** 質問の束を、画面の型へ写す（版・残りの問数と往復） */
export function toQuestionBundle(request: PlanAnswerRequest): RunnerQuestionBundle {
  return {
    revision: request.revision,
    questions: request.questions.map(toRunnerQuestion),
    remaining: { questions: request.remaining.questions, roundTrips: request.remaining.roundTrips },
  };
}

/** 画面の答え 1 つを、工場の答えの下書きへ写す（選択肢か自由入力のちょうど一方） */
function toAnswerDraft(answer: SubmittedAnswer, revision: number): PlanAnswerDraft | undefined {
  const base = { id: `A:${answer.questionId}`, questionId: answer.questionId, revision };
  if (answer.choiceId !== undefined) {
    return { ...base, choiceId: answer.choiceId };
  }
  if (answer.freeText !== undefined) {
    return { ...base, freeText: answer.freeText };
  }
  return undefined;
}

/**
 * 画面の答えを待つ答え役を作る。`answer` は質問を送って答えを待ち、`confirm` は確認を送って答えを待つ。
 * 確認の答えが締切を過ぎてから届いたら、画面の答えによらず「やめる」を返す（Build を起こさない）。
 */
export function createPlanResponder(options: PlanResponderOptions): WaitingPlanResponder {
  const now = options.now ?? ((): number => Date.now());
  let timedOut = false;

  return {
    get timedOut(): boolean {
      return timedOut;
    },

    async answer(request: PlanAnswerRequest): Promise<PlanAnswerOutcome> {
      const response = await options.channel.ask(toQuestionBundle(request));
      if (response.kind === "all-recommended") {
        return { kind: "all-recommended" };
      }
      const answers: PlanAnswerDraft[] = [];
      for (const answer of response.answers) {
        const draft = toAnswerDraft(answer, request.revision);
        if (draft !== undefined) answers.push(draft);
      }
      return { kind: "answers", answers };
    },

    async confirm(view: PlanConfirmationView): Promise<PlanConfirmOutcome> {
      const outcome = await options.channel.confirm(toRunnerConfirmation(view));
      if (options.deadline !== undefined && now() >= options.deadline) {
        timedOut = true;
        return "stop";
      }
      return outcome === "build" ? "build" : "stop";
    },
  };
}
