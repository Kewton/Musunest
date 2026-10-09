// 費用の予約（02-architecture.md §1.5）。
//
// 呼ぶ前に、その呼び出しの最大費用（入力の長さ × 単価 ＋ `max_output_tokens` × 単価）を予約し、
// ジョブの残高を超えるなら**呼ばない**。usage が返ったら実際の費用で精算する。usage が返らなければ
// **予約を残したまま**にする（呼んだ分を使ったか分からないので、残高を戻さない）。
//
// 単価は引数で受け取る（コードに埋め込まない。Issue #278）。
import type { LlmUsage } from "./llm.js";

/** トークンの単価（USD / 1 トークン）。入力・キャッシュに当たった入力・出力の 3 つ */
export interface TokenRates {
  readonly inputPerToken: number;
  readonly cachedInputPerToken: number;
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
 * 引数のトークン数と出力の上限から、その呼び出しの最大費用を求める（§1.5）。
 * 入力は**キャッシュが当たらない前提**で見積もる（予約は安全側に倒す）。
 */
export function estimateMaxCostUsd(request: {
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  readonly rates: TokenRates;
}): number {
  return (
    request.inputTokens * request.rates.inputPerToken +
    request.maxOutputTokens * request.rates.outputPerToken
  );
}

/**
 * usage から実際の費用を求める（§1.5）。入力のトークンにはキャッシュに当たった分が含まれるので、
 * その分を安い単価で数える。`reasoningTokens` は `outputTokens` の内訳なので、足さない。
 */
export function costOfUsageUsd(usage: LlmUsage, rates: TokenRates): number {
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    uncachedInputTokens * rates.inputPerToken +
    usage.cachedInputTokens * rates.cachedInputPerToken +
    usage.outputTokens * rates.outputPerToken
  );
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
}
