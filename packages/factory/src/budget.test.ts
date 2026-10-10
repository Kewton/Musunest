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
