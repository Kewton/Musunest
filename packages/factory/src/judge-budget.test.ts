// 判定を予算に結び付ける包み（Issue #359）の unit テスト。
//
// **実 API は呼ばない。** 差し込んだ偽物の判定（`Judge`）が返す答えと usage、それを受け取る `JobBudget`
// だけで閉じる。固定したいのは 4 つ。
//   1. **Jev の答えは Jev の単価で精算される**（入力だけ。出力は無料。§5）
//   2. **LLM の答えは LLM の単価で精算される**（入力・キャッシュ・出力。§5）
//   3. **予約できないときは判定を呼ばず、誤り（`JudgeBudgetExceededError`）として返す**
//   4. **呼び出しが失敗しても、予約は精算される**（残高へ戻る。Issue #359）
import { describe, expect, it } from "vitest";
import { JEV_RATES, JobBudget, costOfUsageUsd, type TokenRates } from "./budget.js";
import { JudgeBudgetExceededError, createBudgetedJudge } from "./judge-budget.js";
import type { Judge, JudgeRequest, JudgeResponse } from "./judge.js";
import type { LlmUsage } from "./llm.js";

/** LLM（判定の落とし先）の単価（試験は小さく取る） */
const RATES: TokenRates = { inputPerToken: 0.000001, cachedInputPerToken: 0.0000005, outputPerToken: 0.000002 };

/** 1 問だけの小さな要求 */
const REQUEST: JudgeRequest = {
  state: { note: "x" },
  questions: { q: { kind: "noul", instructions: "yes?" } },
};

/** 決めた答えを返し、呼ばれた回数を数える偽物の判定 */
function fixedJudge(response: JudgeResponse): { readonly judge: Judge; readonly calls: () => number } {
  let calls = 0;
  return {
    judge: {
      async judge(): Promise<JudgeResponse> {
        calls += 1;
        return response;
      },
    },
    calls: () => calls,
  };
}

/** 常に失敗する偽物の判定 */
function failingJudge(error: Error): { readonly judge: Judge; readonly calls: () => number } {
  let calls = 0;
  return {
    judge: {
      async judge(): Promise<JudgeResponse> {
        calls += 1;
        throw error;
      },
    },
    calls: () => calls,
  };
}

describe("判定の費用を、答えた adapter の単価で精算する（05 §5・Issue #359）", () => {
  it("Jev の答えは、Jev の単価で精算する（入力だけ。出力は無料）", async () => {
    const { judge, calls } = fixedJudge({
      answers: {},
      inputTokens: 1_000_000,
      model: "jev-1.13.0",
      answeredBy: "jev",
    });
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    const response = await budgeted.judge(REQUEST);

    expect(response.answeredBy).toBe("jev");
    // Jev: 入力 1,000,000 × 0.042/100 万 = 0.042 USD（出力は無料）
    expect(budgeted.spentUsd).toBeCloseTo(0.042, 12);
    expect(budget.spentUsd).toBeCloseTo(0.042, 12);
    expect(budget.reservedUsd).toBe(0);
    expect(budgeted.callsByAdapter).toEqual({ jev: 1, llm: 0, fake: 0 });
    expect(calls()).toBe(1);
  });

  it("LLM の答えは、LLM の単価で精算する（入力・キャッシュ・出力を含む）", async () => {
    const usage: LlmUsage = { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 0 };
    const { judge } = fixedJudge({ answers: {}, inputTokens: usage.inputTokens, usage, model: "gpt-judge", answeredBy: "llm" });
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    await budgeted.judge(REQUEST);

    expect(budgeted.spentUsd).toBeCloseTo(costOfUsageUsd(usage, RATES), 12);
    // 出力（200）も費用に入る（Jev の単価なら 0 になる額ではない）
    expect(budgeted.spentUsd).toBeGreaterThan(200 * RATES.outputPerToken);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 1, fake: 0 });
  });

  it("偽物の答えは、費用を掛けない（予約を解くだけ）", async () => {
    const { judge } = fixedJudge({ answers: {}, inputTokens: 123, model: "fake-judge", answeredBy: "fake" });
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    await budgeted.judge(REQUEST);

    expect(budgeted.spentUsd).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budget.reservedUsd).toBe(0);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 0, fake: 1 });
  });
});

describe("予約できないときは判定を呼ばない（Issue #359）", () => {
  it("残高を超える予約は取れず、判定を呼ばずに誤りを返す", async () => {
    const { judge, calls } = fixedJudge({ answers: {}, inputTokens: 0, model: "gpt-judge", answeredBy: "llm" });
    const budget = new JobBudget(0.0001);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    await expect(budgeted.judge(REQUEST)).rejects.toBeInstanceOf(JudgeBudgetExceededError);
    // 予約できなかったので、判定は呼ばない（誤りをそのまま返す）
    expect(calls()).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budget.reservedUsd).toBe(0);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0 });
  });
});

describe("呼び出しが失敗しても、予約は精算される（Issue #359）", () => {
  it("判定が失敗したら、誤りを投げ直し、予約を解いて残高へ戻す", async () => {
    const { judge, calls } = failingJudge(new Error("判定が失敗した"));
    const budget = new JobBudget(10);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });

    await expect(budgeted.judge(REQUEST)).rejects.toThrow("判定が失敗した");
    expect(calls()).toBe(1);
    // 予約は精算され（解かれ）、残高は上限のまま戻る
    expect(budget.reservedUsd).toBe(0);
    expect(budget.spentUsd).toBe(0);
    expect(budget.remainingUsd).toBe(10);
    expect(budgeted.callsByAdapter).toEqual({ jev: 0, llm: 0, fake: 0 });
  });
});

describe("単価の既定（Issue #359）", () => {
  it("Jev の単価を渡さなければ、JEV_RATES を使う（入力は同じ単価・出力は無料）", async () => {
    expect(JEV_RATES.outputPerToken).toBe(0);
    const { judge } = fixedJudge({ answers: {}, inputTokens: 500_000, model: "jev", answeredBy: "jev" });
    const budget = new JobBudget(1);
    const budgeted = createBudgetedJudge({ judge, budget, rates: RATES });
    await budgeted.judge(REQUEST);
    expect(budgeted.spentUsd).toBeCloseTo(0.021, 12);
  });
});
