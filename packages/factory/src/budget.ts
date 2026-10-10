// 費用の予約（02-architecture.md §1.5）。
//
// 呼ぶ前に、その呼び出しの最大費用（入力の長さ × 単価 ＋ `max_output_tokens` × 単価）を予約し、
// ジョブの残高を超えるなら**呼ばない**。usage が返ったら実際の費用で精算する。usage が返らなければ
// **予約を残したまま**にする（呼んだ分を使ったか分からないので、残高を戻さない）。
//
// 単価は引数で受け取る（コードに埋め込まない。Issue #278）。
import type { LlmUsage } from "./llm.js";

/**
 * トークンの単価（USD / 1 トークン）。入力・キャッシュに当たった入力（読み取り）・キャッシュへ書き込む
 * 入力（書き込み）・出力の 4 つ。書き込みは入力の 1.25 倍である（§1.2・#342）。欄を省いた単価
 * （古い呼び方）では、書き込みを入力と同じ単価として扱う。
 */
export interface TokenRates {
  readonly inputPerToken: number;
  readonly cachedInputPerToken: number;
  /** キャッシュへ書き込む入力の単価（USD / 1 トークン。入力の 1.25 倍。§1.2）。省くと入力の単価を使う */
  readonly cacheWritePerToken?: number;
  readonly outputPerToken: number;
}

/** 予約した 1 回の呼び出しの最大費用 */
export interface Reservation {
  /** 予約した最大費用（USD） */
  readonly maxCostUsd: number;
  /** 予約の識別子（精算の突き合わせ用） */
  readonly id: number;
}

/** 予約の結果。残高を超えるなら `reserved: false`（呼ばない） */
export type ReserveResult =
  | { readonly reserved: true; readonly reservation: Reservation }
  | { readonly reserved: false; readonly maxCostUsd: number; readonly remainingUsd: number };

/**
 * 引数のトークン数と出力の上限から、その呼び出しの最大費用を求める（§1.5・#342）。
 * 入力は**キャッシュへ書き込む前提**で見積もる——キャッシュの書き込みは入力より高い（1.25 倍）ので、
 * 全部を書き込みとして数えておけば予約が実際の費用を下回らない（安全側に倒す）。
 */
export function estimateMaxCostUsd(request: {
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  readonly rates: TokenRates;
}): number {
  const inputPerToken = request.rates.cacheWritePerToken ?? request.rates.inputPerToken;
  return request.inputTokens * inputPerToken + request.maxOutputTokens * request.rates.outputPerToken;
}

/**
 * usage から実際の費用を求める（§1.5・#342）。入力は 3 つに分けて数える——キャッシュに当たった分
 * （読み取り。安い単価）・キャッシュへ書き込んだ分（書き込み。入力の 1.25 倍）・そのどちらでもない分
 * （入力の単価）。`reasoningTokens` は `outputTokens` の内訳なので、足さない。
 */
export function costOfUsageUsd(usage: LlmUsage, rates: TokenRates): number {
  const cacheReadTokens = usage.cachedInputTokens;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cacheReadTokens - cacheWriteTokens);
  const cacheWritePerToken = rates.cacheWritePerToken ?? rates.inputPerToken;
  return (
    uncachedInputTokens * rates.inputPerToken +
    cacheWriteTokens * cacheWritePerToken +
    cacheReadTokens * rates.cachedInputPerToken +
    usage.outputTokens * rates.outputPerToken
  );
}

// ── Jev（TypeSafe の System One）の費用（05-judge-model.md §1・§5）─────────────

/**
 * Jev の入力の単価（USD / 100 万トークン。05 §1「入力 100 万トークンあたり 0.042 USD・出力は無料」）。
 * 単価はベンダーが決める固定値なので、ここに置く（OpenAI の単価のように呼ぶ側からは渡さない）。
 */
export const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;

/**
 * Jev の費用を、**今の予約と同じ仕組み**（`estimateMaxCostUsd`・`costOfUsageUsd`・`JobBudget`）で
 * 数えるための単価（05 §5）。キャッシュの区別は無く（入力・読み取り・書き込みはすべて同じ単価）、
 * 出力は無料である（#342 で足した書き込みの欄も同じ単価にする）。
 */
export const JEV_RATES: TokenRates = {
  inputPerToken: JEV_USD_PER_MILLION_INPUT_TOKENS / 1_000_000,
  cachedInputPerToken: JEV_USD_PER_MILLION_INPUT_TOKENS / 1_000_000,
  cacheWritePerToken: JEV_USD_PER_MILLION_INPUT_TOKENS / 1_000_000,
  outputPerToken: 0,
};

/** Jev の費用（USD）を入力のトークン数から数える（出力は無料。05 §5） */
export function jevCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * JEV_USD_PER_MILLION_INPUT_TOKENS;
}

/** ジョブ全体の費用の予算。呼ぶ前に予約し、usage が返ったら精算する（§1.5） */
export class JobBudget {
  readonly #limitUsd: number;
  #reservedUsd = 0;
  #spentUsd = 0;
  #nextId = 1;

  constructor(limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd < 0) {
      throw new RangeError("予算の上限は 0 以上の有限の数であること");
    }
    this.#limitUsd = limitUsd;
  }

  /** ジョブ全体の上限（USD） */
  get limitUsd(): number {
    return this.#limitUsd;
  }

  /** 予約と精算を引いた残高（USD） */
  get remainingUsd(): number {
    return this.#limitUsd - this.#reservedUsd - this.#spentUsd;
  }

  /** いま予約されている額（USD）。usage が返らなかった呼び出しの分が残る */
  get reservedUsd(): number {
    return this.#reservedUsd;
  }

  /** 精算済みの額（USD） */
  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** 呼ぶ前に最大費用を予約する。残高を超えるなら予約しない（呼ばない） */
  reserve(maxCostUsd: number): ReserveResult {
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
      throw new RangeError("予約する最大費用は 0 以上の有限の数であること");
    }
    if (maxCostUsd > this.remainingUsd) {
      return { reserved: false, maxCostUsd, remainingUsd: this.remainingUsd };
    }
    const reservation: Reservation = { maxCostUsd, id: this.#nextId };
    this.#nextId += 1;
    this.#reservedUsd += maxCostUsd;
    return { reserved: true, reservation };
  }

  /**
   * usage が返ったときだけ呼ぶ。予約を実際の費用で置き換える（差額は残高へ戻る）。
   * usage が返らなかった呼び出しでは呼ばないので、予約は残ったままになる。
   */
  settle(reservation: Reservation, usage: LlmUsage, rates: TokenRates): number {
    const actualUsd = costOfUsageUsd(usage, rates);
    this.#reservedUsd -= reservation.maxCostUsd;
    this.#spentUsd += actualUsd;
    return actualUsd;
  }

  /**
   * 予約を、費用を掛けずに解く（呼び出しが**失敗した**とき。Issue #359）。usage が分からない
   * 失敗では、予約をそのまま残すと残高が戻らない——**助言**である判定の呼び出しでは、失敗しても
   * 予約を精算して残高へ戻す（段の失敗の扱いとは別。`settle` は成功した呼び出しにだけ使う）。
   */
  release(reservation: Reservation): void {
    this.#reservedUsd -= reservation.maxCostUsd;
  }
}
