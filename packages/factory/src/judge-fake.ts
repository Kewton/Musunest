// 偽物の判定（05-judge-model.md §4「試験は偽物の判定で回す」）。
//
// **問いの名前ごとに決めた答えを返す**。試験はこれで閉じ、Jev にも LLM にも触れない（実 API を呼ばない）。
// 用意していない問い・種類の食い違いは誤りにして、試験の題材のずれを黙って通さない。
import type { Judge, JudgeAnswer, JudgeRequest, JudgeResponse } from "./judge.js";

/** 用意していない問い・種類の食い違いのときに投げる誤り */
export class FakeJudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeJudgeError";
  }
}

/** 偽物の判定を作る関数の引数 */
export interface FakeJudgeOptions {
  /** 答えたモデルの版の ID（既定 `fake-judge`。§1） */
  readonly model?: string;
  /** 使ったトークン数（既定 0。§5） */
  readonly inputTokens?: number;
}

/**
 * 問いの名前ごとに決めた答えを返す偽物の判定（§4）。`answersByQuestion` に無い問いが来たら
 * `FakeJudgeError`、問いの種類と答えの種類が食い違うときも `FakeJudgeError` にする。
 */
export function createFakeJudge(
  answersByQuestion: Readonly<Record<string, JudgeAnswer>>,
  options: FakeJudgeOptions = {},
): Judge {
  const model = options.model ?? "fake-judge";
  const inputTokens = options.inputTokens ?? 0;
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      const answers: Record<string, JudgeAnswer> = {};
      for (const [name, question] of Object.entries(request.questions)) {
        const answer = answersByQuestion[name];
        if (answer === undefined) {
          throw new FakeJudgeError(`問い ${name} の答えが用意されていません`);
        }
        if (answer.kind !== question.kind) {
          throw new FakeJudgeError(
            `問い ${name} の種類と答えの種類が違います（問い ${question.kind}、答え ${answer.kind}）`,
          );
        }
        answers[name] = answer;
      }
      return { answers, inputTokens, model, answeredBy: "fake" };
    },
  };
}
