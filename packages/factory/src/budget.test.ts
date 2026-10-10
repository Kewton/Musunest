// 費用の予約（02 §1.5）の unit テスト。Issue #278 の受入条件のうち、予約に閉じる分。
//
// ここで固定したいのは 3 つ。
//   1. 残高を超える呼び出しは予約できない（呼ばない）
//   2. usage が返れば、実際の費用で精算される（差額は残高へ戻る）
//   3. usage が返らなければ、予約は残ったままになる（残高を戻さない）
//
// 単価は引数で受け取る（コードに埋め込まない）。整数と 0.5 を使い、浮動小数の丸めに依らない値を選ぶ。
import { describe, expect, it } from "vitest";
import {
  JEV_RATES,
  JEV_USD_PER_MILLION_INPUT_TOKENS,
  JobBudget,
  costOfUsageUsd,
  estimateMaxCostUsd,
  jevCostUsd,
  type TokenRates,
} from "./budget.js";
import type { LlmUsage } from "./llm.js";

const RATES: TokenRates = { inputPerToken: 1, cachedInputPerToken: 0.5, outputPerToken: 2 };

describe("最大費用と実際の費用（02 §1.5）", () => {
  it("最大費用は、入力の長さ × 単価 ＋ 出力の上限 × 単価", () => {
    expect(estimateMaxCostUsd({ inputTokens: 10, maxOutputTokens: 5, rates: RATES })).toBe(20);
  });

  it("実際の費用は、キャッシュに当たった入力を安い単価で数える", () => {
    const usage: LlmUsage = {
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 1,
    };
    // (10 - 4) * 1 + 4 * 0.5 + 3 * 2 = 6 + 2 + 6 = 14
    expect(costOfUsageUsd(usage, RATES)).toBe(14);
  });
});

// ── キャッシュの書き込みと読み取りの単価（02 §1.2・#342）──────────────────

describe("キャッシュの書き込みと読み取りを、単価で数える（02 §1.2・#342）", () => {
  // 入力 1・読み取り 0.1（入力の 0.1 倍）・書き込み 1.25（入力の 1.25 倍）・出力 2
  const CACHE_RATES: TokenRates = {
    inputPerToken: 1,
    cachedInputPerToken: 0.1,
    cacheWritePerToken: 1.25,
    outputPerToken: 2,
  };

  it("実際の費用は、書き込みを入力の 1.25 倍・読み取りを 0.1 倍で数える", () => {
    const usage: LlmUsage = {
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteTokens: 20,
      outputTokens: 10,
      reasoningTokens: 0,
    };
    // 書き込みでも読み取りでもない入力: 100 - 40 - 20 = 40
    // 40 * 1 + 20 * 1.25 + 40 * 0.1 + 10 * 2 = 40 + 25 + 4 + 20 = 89
    expect(costOfUsageUsd(usage, CACHE_RATES)).toBe(89);
  });

  it("書き込みの欄が無い usage は、書き込み 0 として数える（古い記録を止めない）", () => {
    const usage: LlmUsage = {
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 1,
    };
    // (10 - 4) * 1 + 4 * 0.1 + 3 * 2 = 6 + 0.4 + 6 = 12.4
    expect(costOfUsageUsd(usage, CACHE_RATES)).toBeCloseTo(12.4, 12);
  });

  it("書き込みの単価を省いたときは、書き込みを入力の単価で数える（古い呼び方）", () => {
    const usage: LlmUsage = {
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 4,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    // (10 - 4) * 1 + 4 * 1 = 10（RATES は書き込みの欄を持たない）
    expect(costOfUsageUsd(usage, RATES)).toBe(10);
  });

  it("予約は、入力の全部を書き込みとして見積もる（上限を超えない）", () => {
    // 100 * 1.25 + 10 * 2 = 125 + 20 = 145（入力の単価で見積もる 120 より大きい）
    const maxCostUsd = estimateMaxCostUsd({ inputTokens: 100, maxOutputTokens: 10, rates: CACHE_RATES });
    expect(maxCostUsd).toBe(145);
    // 入力の単価で見積もった額（120）なら足りる残高でも、書き込みの単価では足りない
    const budget = new JobBudget(120);
    expect(budget.reserve(maxCostUsd).reserved).toBe(false);
  });
});

describe("費用の予約（02 §1.5）", () => {
  it("残高を超える呼び出しは予約できない", () => {
    const budget = new JobBudget(10);
    const maxCostUsd = estimateMaxCostUsd({ inputTokens: 6, maxOutputTokens: 5, rates: RATES }); // 16
    const result = budget.reserve(maxCostUsd);
    expect(result.reserved).toBe(false);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.remainingUsd).toBe(10);
  });

  it("usage が返れば、実際の費用で精算され、差額は残高へ戻る", () => {
    const budget = new JobBudget(100);
    const maxCostUsd = estimateMaxCostUsd({ inputTokens: 10, maxOutputTokens: 5, rates: RATES }); // 20
    const reserved = budget.reserve(maxCostUsd);
    expect(reserved.reserved).toBe(true);
    if (!reserved.reserved) return;
    expect(budget.remainingUsd).toBe(80);

    const usage: LlmUsage = {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 2,
      reasoningTokens: 1,
    };
    const actualUsd = budget.settle(reserved.reservation, usage, RATES); // 10 + 4 = 14
    expect(actualUsd).toBe(14);
    expect(budget.spentUsd).toBe(14);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.remainingUsd).toBe(86);
  });

  it("呼び出しが失敗したときは、予約を解いて残高へ戻す（release。Issue #359）", () => {
    const budget = new JobBudget(100);
    const reserved = budget.reserve(20);
    expect(reserved.reserved).toBe(true);
    if (!reserved.reserved) return;
    expect(budget.remainingUsd).toBe(80);

    budget.release(reserved.reservation);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budget.remainingUsd).toBe(100);
  });

  it("usage が返らなければ、予約は残ったままになる", () => {
    const budget = new JobBudget(100);
    const reserved = budget.reserve(20);
    expect(reserved.reserved).toBe(true);
    // usage が返らないので settle しない。予約は残り、残高は戻らない
    expect(budget.reservedUsd).toBe(20);
    expect(budget.remainingUsd).toBe(80);
    // 予約が残っているので、残りの 80 を超える呼び出しは予約できない（ちょうどの 80 は通る）
    expect(budget.reserve(81).reserved).toBe(false);
    expect(budget.reserve(80).reserved).toBe(true);
  });
});

describe("Jev の費用（05 §1・§5）", () => {
  const usage = (inputTokens: number, outputTokens = 0): LlmUsage => ({
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  });

  it("入力のトークン数から数える（出力は無料）", () => {
    expect(JEV_USD_PER_MILLION_INPUT_TOKENS).toBe(0.042);
    expect(jevCostUsd(1_000_000)).toBe(0.042);
    expect(jevCostUsd(0)).toBe(0);
    expect(jevCostUsd(500_000)).toBeCloseTo(0.021, 12);
  });

  it("usage から数えても、出力とキャッシュの区別に依らない（入力は同じ単価、出力は 0）", () => {
    expect(costOfUsageUsd(usage(1_000_000, 9_999), JEV_RATES)).toBeCloseTo(0.042, 12);
    expect(costOfUsageUsd(usage(0, 9_999), JEV_RATES)).toBe(0);
  });

  it("今の予約と同じ仕組みで、呼ぶ前に最大費用を予約し、精算できる", () => {
    const budget = new JobBudget(1);
    const maxCostUsd = estimateMaxCostUsd({ inputTokens: 2_000_000, maxOutputTokens: 0, rates: JEV_RATES });
    expect(maxCostUsd).toBeCloseTo(0.084, 12);

    const reserved = budget.reserve(maxCostUsd);
    expect(reserved.reserved).toBe(true);
    if (!reserved.reserved) return;
    expect(budget.remainingUsd).toBeCloseTo(1 - 0.084, 12);

    const actualUsd = budget.settle(reserved.reservation, usage(1_000_000), JEV_RATES);
    expect(actualUsd).toBeCloseTo(0.042, 12);
    expect(budget.spentUsd).toBeCloseTo(0.042, 12);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.remainingUsd).toBeCloseTo(0.958, 12);
  });
});
