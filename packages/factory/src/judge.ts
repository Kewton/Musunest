// 判定の口（05-judge-model.md §1・§4）。「1 つの state と、名前を付けた問いの map を渡し、問いごとの
// 答えを返す」型を 1 つに決め、Jev（TypeSafe の System One）・LLM の構造化出力・試験用の偽物を、同じ口の
// adapter として実装する。**LLM と Jev の呼び出しは adapter 層に閉じ込める**（CLAUDE.md の不変条件）。
//
// 問いは 3 つ（§1）：choice（選択肢から 1 つ）・score（順序のある段階で点を付ける）・noul（はい／いいえ）。
// 答えは問いごとに返す。noul は 0〜1 の値を持つ。choice は選んだ名前と、選択肢ごとの確率を持つ。score は
// 段階の番号を確率で重み付けした数と、段階の文の一覧・段階ごとの確率を持つ（#349）。使ったトークン数
// （Jev の出力は無料。§5）と、答えたモデルの版の ID を結果に残す（§1・§8 U-J3）。
//
// **落とす組み合わせ**（§4）：Jev が失敗したら LLM の adapter で答え直し、どちらが答えたかを結果
// （`answeredBy`）に残す。Jev が止まっても工場は止まらない（§6）。
//
// 判定は助言であって門ではない（§4）。答えで合否を開けない。
import type { LlmUsage } from "./llm.js";

/** 問いの種類（§1） */
export type JudgeQuestionKind = "choice" | "score" | "noul";

/**
 * 問いの `instructions`（§1・#349）。文字列のほか、問いの文と、それが参照するデータを分けて書ける object も
 * 受け取る（Jev の wire はどちらも許す）。
 */
export type JudgeInstructions = string | Readonly<Record<string, unknown>>;

/** 選択肢から 1 つ選ぶ問い（§1）。`criteria` は選択肢の名前 → 意味 */
export interface JudgeChoiceQuestion {
  readonly kind: "choice";
  readonly instructions: JudgeInstructions;
  readonly criteria: Readonly<Record<string, string>>;
}

/**
 * 順序のある段階で点を付ける問い（§1・#349）。`criteria` は**順序のある段階の文の配列**（Jev の wire は
 * 2〜10 個）。番号は配列の位置（0 始まり）で、答えの `legend`・`probabilities` と同じ順。
 */
export interface JudgeScoreQuestion {
  readonly kind: "score";
  readonly instructions: JudgeInstructions;
  readonly criteria: readonly string[];
}

/** はい／いいえの問い（§1）。答えは 0〜1 の値 */
export interface JudgeNoulQuestion {
  readonly kind: "noul";
  readonly instructions: JudgeInstructions;
  /** はい／いいえの意味（任意） */
  readonly criteria?: Readonly<Record<string, string>>;
}

/** 判定の口が受け取る問い（§1） */
export type JudgeQuestion = JudgeChoiceQuestion | JudgeScoreQuestion | JudgeNoulQuestion;

/**
 * choice の答え（§1・#349）。`choice` は選んだ選択肢の名前。`probabilities` は**選択肢ごとの確率**
 * （選択肢の名前 → 0〜1）。`probability` は**選んだ選択肢の確率**（`probabilities` から出す）。`confidence`
 * は確信度。**返せない adapter（LLM の構造化出力）では `probabilities`・`probability`・`confidence` を
 * `undefined`**（「不明」）にする。
 */
export interface JudgeChoiceAnswer {
  readonly kind: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>> | undefined;
  readonly probability: number | undefined;
  readonly confidence: number | undefined;
}

/**
 * score の答え（§1・#349）。`score` は**段階の番号を確率で重み付けした数**（段階のあいだに落ちうる）。
 * `legend` は段階の文の一覧（番号の順）、`probabilities` は**段階ごとの確率**（番号の順）。`confidence` は
 * 確信度。**確率を返せない adapter では `probabilities`・`confidence` を `undefined`**（「不明」）にする。
 */
export interface JudgeScoreAnswer {
  readonly kind: "score";
  readonly score: number;
  readonly legend: readonly string[];
  readonly probabilities: readonly number[] | undefined;
  readonly confidence: number | undefined;
}

/** noul の答え（§1）。`noul` は「はい」の 0〜1 の値 */
export interface JudgeNoulAnswer {
  readonly kind: "noul";
  readonly noul: number;
}

/** 判定の口が返す答え（§1） */
export type JudgeAnswer = JudgeChoiceAnswer | JudgeScoreAnswer | JudgeNoulAnswer;

/** 答えた adapter（§4「どちらで答えたかを結果に残す」） */
export type JudgeSource = "jev" | "llm" | "fake";

/** 1 回の判定の要求（§1）。1 つの state と、名前を付けた問いの map を渡す */
export interface JudgeRequest {
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: Readonly<Record<string, JudgeQuestion>>;
}

/** 1 回の判定の答え（§1）。問いごとの答え・使ったトークン数・答えたモデルの版の ID */
export interface JudgeResponse {
  readonly answers: Readonly<Record<string, JudgeAnswer>>;
  /** 使った入力のトークン数（Jev の出力は無料。§5） */
  readonly inputTokens: number;
  /**
   * LLM が答えたときの使用量（入力・キャッシュ・出力のトークン。Issue #359・§1.5）。**入力の
   * トークンだけ**しか返さない adapter（Jev。出力は無料。§5）は省く——呼ぶ側は `inputTokens` で数える。
   */
  readonly usage?: LlmUsage;
  /** 答えたモデルの版の ID（§1・§8 U-J3） */
  readonly model: string;
  /** 答えた adapter（§4） */
  readonly answeredBy: JudgeSource;
}

/** 判定の口（port。§4）。Jev・LLM・偽物がこの型を実装する */
export interface Judge {
  /** 1 つの state と問いの map を渡し、問いごとの答えを返す（§1） */
  judge(request: JudgeRequest): Promise<JudgeResponse>;
}

/** 落とす組み合わせの設定（§4「Jev が失敗したら LLM の adapter で答え直す」） */
export interface FallbackJudgeOptions {
  /** 先に試す判定（Jev） */
  readonly primary: Judge;
  /** 先が失敗したときに使う判定（LLM） */
  readonly fallback: Judge;
}

/**
 * 第 1 の判定を試し、**失敗したら**第 2 の判定で答え直す（§4）。**どちらが答えたかは、返ってきた
 * 結果の `answeredBy` に残る**。第 1 が失敗する理由は問わない（429・529・障害。§6「Jev が止まっても
 * 工場は止まらない」）。第 2 も失敗すれば、その誤りをそのまま投げる。
 */
export function createFallbackJudge(options: FallbackJudgeOptions): Judge {
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      try {
        return await options.primary.judge(request);
      } catch {
        return await options.fallback.judge(request);
      }
    },
  };
}
