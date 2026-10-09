// 全呼び出しを通す共通の口（02 §1.5・§2.2）の unit テスト。Issue #282 の受入条件のうち、口に閉じる分。
//
// ここで固定したいのは 6 つ。
//   1. 規則・文書・schema・道具・履歴を含む**入力の上界**で予約する
//   2. 残高を超える呼び出しはしない（予約できなければ呼ばない）
//   3. usage が返らないときは予約を残す（返れば精算する）
//   4. 例外と再試行も、回数と予約に計上する
//   5. 締切までの残り時間が尽きたら、実呼び出しを中断して締切切れを返す
//   6. 呼び出しの回数の上限と、道具の呼び出しの回数を数える
import { describe, expect, it, vi } from "vitest";
import { JobBudget, costOfUsageUsd, estimateMaxCostUsd, type TokenRates } from "./budget.js";
import {
  CallGateway,
  estimateInputUpperBoundTokens,
  structuredInputParts,
  toolInputParts,
  type LlmInputParts,
} from "./call.js";
import { AGENT_LIMITS } from "./limits.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmUsage,
} from "./llm.js";
import { createFakeLlmClient } from "./llm-fake.js";

const RATES: TokenRates = { inputPerToken: 1, cachedInputPerToken: 0.5, outputPerToken: 2 };

const STRUCTURED_REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  input: "依頼文",
  schemaName: "out",
  schema: { type: "object" },
  maxOutputTokens: 10,
};

const TOOL_REQUEST: LlmToolRequest = {
  instructions: "規則",
  documents: ["文書"],
  input: "宣言",
  tools: [{ name: "staticCheck", description: "静的チェックを流す", parameters: { type: "object" } }],
  turns: [],
  maxOutputTokens: 10,
};

const USAGE: LlmUsage = { inputTokens: 5, cachedInputTokens: 1, outputTokens: 4, reasoningTokens: 0 };

const maxCostOf = (parts: LlmInputParts, maxOutputTokens: number): number =>
  estimateMaxCostUsd({ inputTokens: estimateInputUpperBoundTokens(parts), maxOutputTokens, rates: RATES });

/** 呼ばれたかを観測するための、決まった応答を返す偽物（実 API を呼ばない） */
function spyClient(onCall: () => void): LlmClient {
  return {
    callStructured<T>(): Promise<LlmStructuredResponse<T>> {
      onCall();
      return Promise.resolve({ output: {} as T, usage: undefined });
    },
    callWithTools(): Promise<LlmToolResponse> {
      onCall();
      return Promise.resolve({ kind: "done", declaration: {}, usage: undefined });
    },
  };
}

const EMPTY: LlmInputParts = {
  instructions: "",
  documents: [],
  schema: undefined,
  tools: [],
  turns: [],
  data: "",
};

describe("入力の上界（02 §1.5・§2.2）", () => {
  it("規則・文書・schema・道具・履歴・データの全部から数える", () => {
    expect(estimateInputUpperBoundTokens(EMPTY)).toBe(0);
    expect(estimateInputUpperBoundTokens({ ...EMPTY, instructions: "a" })).toBeGreaterThan(0);
    expect(estimateInputUpperBoundTokens({ ...EMPTY, documents: ["a"] })).toBeGreaterThan(0);
    expect(estimateInputUpperBoundTokens({ ...EMPTY, schema: { x: 1 } })).toBeGreaterThan(0);
    expect(
      estimateInputUpperBoundTokens({
        ...EMPTY,
        tools: [{ name: "t", description: "d", parameters: {} }],
      }),
    ).toBeGreaterThan(0);
    expect(
      estimateInputUpperBoundTokens({ ...EMPTY, turns: [{ role: "assistant", toolCalls: [] }] }),
    ).toBeGreaterThan(0);
    expect(estimateInputUpperBoundTokens({ ...EMPTY, data: "a" })).toBeGreaterThan(0);
  });
});

describe("共通の口（02 §1.5・§2.2）", () => {
  it("入力の上界で予約する（規則・文書・schema・道具・履歴を含む）", async () => {
    const budget = new JobBudget(1_000);
    const client = createFakeLlmClient([{ kind: "structured", output: { ok: true }, usage: undefined }]);
    const gateway = new CallGateway({ client, budget, rates: RATES, now: () => 0, deadline: 1_000 });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("ok");
    // usage が返らないので予約は残る。その額は、上界から出した最大費用と一致する
    expect(budget.reservedUsd).toBe(
      maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens),
    );
  });

  it("残高を超える呼び出しはしない", async () => {
    const maxCostUsd = maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens);
    const budget = new JobBudget(maxCostUsd - 1);
    let called = 0;
    const gateway = new CallGateway({
      client: spyClient(() => {
        called += 1;
      }),
      budget,
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result).toEqual({ kind: "budgetExceeded", maxCostUsd, remainingUsd: maxCostUsd - 1 });
    expect(called).toBe(0);
    expect(gateway.calls).toBe(0);
  });

  it("usage が返れば精算し、返らなければ予約を残す", async () => {
    const withUsage = createFakeLlmClient([{ kind: "structured", output: { ok: true }, usage: USAGE }]);
    const budgetA = new JobBudget(1_000);
    const gatewayA = new CallGateway({ client: withUsage, budget: budgetA, rates: RATES, now: () => 0, deadline: 1_000 });
    await gatewayA.callStructured(STRUCTURED_REQUEST);
    expect(budgetA.spentUsd).toBe(costOfUsageUsd(USAGE, RATES));
    expect(budgetA.reservedUsd).toBe(0);

    const withoutUsage = createFakeLlmClient([{ kind: "structured", output: { ok: true }, usage: undefined }]);
    const budgetB = new JobBudget(1_000);
    const gatewayB = new CallGateway({
      client: withoutUsage,
      budget: budgetB,
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });
    await gatewayB.callStructured(STRUCTURED_REQUEST);
    expect(budgetB.spentUsd).toBe(0);
    expect(budgetB.reservedUsd).toBe(
      maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens),
    );
  });

  it("例外と再試行も、回数と予約に計上する（1 回目は失敗、2 回目は成功）", async () => {
    let attempts = 0;
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("一時的な誤り"));
        return Promise.resolve({ output: { ok: true } as T, usage: USAGE });
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({ client, budget, rates: RATES, now: () => 0, deadline: 1_000 });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("ok");
    expect(attempts).toBe(2);
    expect(gateway.calls).toBe(2);
    expect(gateway.retries).toBe(1);
    // 失敗した 1 回目の予約は残る（usage が分からないため）。2 回目は usage で精算される
    expect(budget.reservedUsd).toBe(
      maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens),
    );
    expect(budget.spentUsd).toBe(costOfUsageUsd(USAGE, RATES));
  });

  it("再試行を使い切っても成功しなければ失敗にし、試行ごとの予約が残る", async () => {
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        return Promise.reject(new Error("毎回失敗する"));
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({ client, budget, rates: RATES, now: () => 0, deadline: 1_000, maxAttempts: 3 });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result).toEqual({ kind: "failed", attempts: 3, error: expect.any(Error) });
    expect(gateway.calls).toBe(3);
    expect(gateway.retries).toBe(2);
    const maxCostUsd = maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens);
    expect(budget.reservedUsd).toBe(maxCostUsd * 3);
  });

  it("締切の残り時間が尽きていれば、実呼び出しをせずに締切切れを返す", async () => {
    let called = 0;
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({
      client: spyClient(() => {
        called += 1;
      }),
      budget,
      rates: RATES,
      now: () => 5_000,
      deadline: 5_000,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("deadlineExceeded");
    expect(called).toBe(0);
    expect(budget.reservedUsd).toBe(0);
  });

  it("呼んでいる途中で残り時間が尽きたら、実呼び出しを中断して締切切れを返す", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const client: LlmClient = {
        callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
          return new Promise<never>(() => {
            request.signal?.addEventListener("abort", () => {
              aborted = true;
            });
          });
        },
        callWithTools(): Promise<LlmToolResponse> {
          return Promise.reject(new Error("使わない"));
        },
      };
      const budget = new JobBudget(1_000);
      const gateway = new CallGateway({ client, budget, rates: RATES, now: () => 0, deadline: 1_000 });

      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.kind).toBe("deadlineExceeded");
      expect(aborted).toBe(true);
      expect(gateway.calls).toBe(1);
      // 呼んだ分の予約は残る（usage が分からないため）
      expect(budget.reservedUsd).toBe(
        maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("呼び出しの回数の上限に触れたら、呼ばずに知らせる", async () => {
    let called = 0;
    const budget = new JobBudget(1_000_000);
    const gateway = new CallGateway({
      client: spyClient(() => {
        called += 1;
      }),
      budget,
      rates: RATES,
      now: () => 0,
      deadline: 1_000_000,
      limits: { ...AGENT_LIMITS, callCount: 2 },
    });

    await gateway.callStructured(STRUCTURED_REQUEST);
    await gateway.callStructured(STRUCTURED_REQUEST);
    const result = await gateway.callStructured(STRUCTURED_REQUEST);

    expect(result).toEqual({ kind: "limitExceeded", limit: "callCount", max: 2, actual: 2 });
    expect(called).toBe(2);
  });

  it("道具付きの呼び出しは、道具の呼び出しの回数を数える", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: {
          kind: "toolCalls",
          toolCalls: [
            { id: "call-1", name: "staticCheck", arguments: {} },
            { id: "call-2", name: "runTests", arguments: {} },
          ],
          usage: undefined,
        },
      },
    ]);
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({ client, budget, rates: RATES, now: () => 0, deadline: 1_000 });

    const result = await gateway.callWithTools(TOOL_REQUEST);
    expect(result.kind).toBe("ok");
    expect(gateway.toolCalls).toBe(2);
    expect(budget.reservedUsd).toBe(
      maxCostOf(toolInputParts(TOOL_REQUEST), TOOL_REQUEST.maxOutputTokens),
    );
  });

  it("試行の回数が 1 未満なら断る", () => {
    expect(
      () =>
        new CallGateway({
          client: spyClient(() => {}),
          budget: new JobBudget(1_000),
          rates: RATES,
          now: () => 0,
          deadline: 1_000,
          maxAttempts: 0,
        }),
    ).toThrow(RangeError);
  });
});
