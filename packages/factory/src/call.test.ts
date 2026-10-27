// 全呼び出しを通す共通の口（02 §1.5・§2.2）の unit テスト。Issue #282 の受入条件のうち、口に閉じる分。
//
// ここで固定したいのは 6 つ。
//   1. 規則・文書・schema・道具・履歴を含む**入力の上界**で予約する
//   2. 残高を超える呼び出しはしない（予約できなければ呼ばない）
//   3. usage が返らないときは予約を残す（返れば精算する）
//   4. 例外と再試行も、回数と予約に計上する
//   5. 締切までの残り時間が尽きたら、実呼び出しを中断して締切切れを返す
//   6. 呼び出しの回数の上限と、道具の呼び出しの回数を数える
//   7. 呼び出しごとの timeout を effort と締切から決め、締切の残りを超えず、やり直しでは長くする（#302）
//   8. adapter の誤りの種類をそのまま分類する（timeout を拒否にしない。分類できない例外は unknown。#302）
//   9. やり直してよい誤り（timeout・network・HTTP の 5xx）だけをやり直す（#302）
import { describe, expect, it, vi } from "vitest";
import { JobBudget, costOfUsageUsd, estimateMaxCostUsd, type TokenRates } from "./budget.js";
import {
  CallGateway,
  callCountsDelta,
  categorizeCallError,
  createCallGate,
  estimateInputUpperBoundTokens,
  inputUpperBoundChars,
  isIncompleteResponseError,
  isInvalidRequestError,
  isRetryableCallError,
  structuredInputParts,
  toolInputParts,
  type CallErrorKind,
  type CallAttemptEnd,
  type CallAttemptObservation,
  type CallAttemptObserver,
  type CallResult,
  type LlmInputParts,
} from "./call.js";
import {
  AGENT_LIMITS,
  CALL_TIMEOUT_BY_EFFORT,
  OUTPUT_STAGES,
  STAGE_EFFORT_STAGES,
  STAGE_MAX_OUTPUT_TOKENS,
  callTimeoutMsForEffort,
  maxOutputTokensForEffort,
} from "./limits.js";
import { OpenAiIncompleteError } from "./openai.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmUsage,
} from "./llm.js";
import { createFakeLlmClient } from "./llm-fake.js";
import { CallRequestLog, UsageMeter } from "./record.js";

const RATES: TokenRates = { inputPerToken: 1, cachedInputPerToken: 0.5, outputPerToken: 2 };

const STRUCTURED_REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  rules: ["段の規則"],
  input: "依頼文",
  schemaName: "out",
  schema: { type: "object" },
  maxOutputTokens: 10,
};

const TOOL_REQUEST: LlmToolRequest = {
  instructions: "規則",
  documents: ["文書"],
  rules: ["段の規則"],
  input: "宣言",
  tools: [{ name: "staticCheck", description: "静的チェックを流す", parameters: { type: "object" } }],
  turns: [],
  maxOutputTokens: 10,
};

/** 道具付きの要求に載る、最後の答えの schema（構造化出力。#304） */
const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["declaration"],
  properties: { declaration: { type: "string" } },
} as const;

const USAGE: LlmUsage = { inputTokens: 5, cachedInputTokens: 1, outputTokens: 4, reasoningTokens: 0 };

/** 再試行してよい誤り（network）を表す（adapter が投げる形をまねる。#302） */
const networkError = (): Error => Object.assign(new Error("fetch が失敗しました"), { kind: "network" });

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
  rules: [],
  schema: undefined,
  tools: [],
  turns: [],
  data: "",
};

describe("入力の上界（02 §1.5・§2.2）", () => {
  it("規則・文書・段の規則・schema・道具・履歴・データの全部から数える", () => {
    expect(estimateInputUpperBoundTokens(EMPTY)).toBe(0);
    expect(estimateInputUpperBoundTokens({ ...EMPTY, instructions: "a" })).toBeGreaterThan(0);
    expect(estimateInputUpperBoundTokens({ ...EMPTY, documents: ["a"] })).toBeGreaterThan(0);
    expect(estimateInputUpperBoundTokens({ ...EMPTY, rules: ["a"] })).toBeGreaterThan(0);
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

  it("道具付きでも、最後の答えの schema（構造化出力）の分を入力の上界に数える（#304）", () => {
    const withSchema: LlmToolRequest = { ...TOOL_REQUEST, schemaName: "repair-answer", schema: ANSWER_SCHEMA };

    // 要求が持つ schema を、名前と対で材料へ写す
    const parts = toolInputParts(withSchema);
    expect(parts.schema).toEqual({ name: "repair-answer", schema: ANSWER_SCHEMA });

    // 上界は、schema（名前と schema）を直列化した分だけ増える
    const base = inputUpperBoundChars(toolInputParts(TOOL_REQUEST));
    const added = JSON.stringify({ name: "repair-answer", schema: ANSWER_SCHEMA }).length;
    expect(added).toBeGreaterThan(0);
    expect(inputUpperBoundChars(parts)).toBe(base + added);
    expect(estimateInputUpperBoundTokens(parts)).toBeGreaterThan(
      estimateInputUpperBoundTokens(toolInputParts(TOOL_REQUEST)),
    );
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
        if (attempts === 1) return Promise.reject(networkError());
        return Promise.resolve({ output: { ok: true } as T, usage: USAGE });
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const budget = new JobBudget(1_000);
    // timeout の基準を小さく取り、締切の残りに余裕を持たせる（やり直しで長くできる。#302）
    const gateway = new CallGateway({
      client,
      budget,
      rates: RATES,
      now: () => 0,
      deadline: 10_000,
      callTimeoutMs: 100,
    });

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
        return Promise.reject(networkError());
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({
      client,
      budget,
      rates: RATES,
      now: () => 0,
      deadline: 100_000,
      maxAttempts: 3,
      callTimeoutMs: 100,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result).toEqual({ kind: "failed", errorKind: "network", attempts: 3 });
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

// ── 道具の累計の数え方（02 §1.5・Issue #429）────────────────────────
//
// ⑥ の実行の門（累計で断る）が読むのは、この public getter（`toolCalls`）である。**新しい interface や
// getter は作らない**——数え方をここで固定する：道具の束を返す応答でその数だけ増え、`done` の応答・
// 通信のやり直し・例外では増えない。

describe("共通の口の道具の累計（02 §1.5・Issue #429）", () => {
  it("道具の束を返す応答で、その数だけ増える", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: {
          kind: "toolCalls",
          toolCalls: [
            { id: "call-1", name: "staticCheck", arguments: {} },
            { id: "call-2", name: "runTests", arguments: {} },
            { id: "call-3", name: "checkCorrespondence", arguments: {} },
          ],
          usage: undefined,
        },
      },
    ]);
    const gateway = new CallGateway({ client, budget: new JobBudget(1_000), rates: RATES, now: () => 0, deadline: 1_000 });

    const result = await gateway.callWithTools(TOOL_REQUEST);
    expect(result.kind).toBe("ok");
    expect(gateway.toolCalls).toBe(3);
  });

  it("最後の答え（done）の応答では、増えない", async () => {
    const client = createFakeLlmClient([
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    const gateway = new CallGateway({ client, budget: new JobBudget(1_000), rates: RATES, now: () => 0, deadline: 1_000 });

    const result = await gateway.callWithTools(TOOL_REQUEST);
    expect(result.kind).toBe("ok");
    expect(gateway.toolCalls).toBe(0);
  });

  it("通信のやり直しでは、成功した応答の束の数だけ増える", async () => {
    let attempts = 0;
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        return Promise.reject(new Error("使わない"));
      },
      callWithTools(): Promise<LlmToolResponse> {
        attempts += 1;
        if (attempts === 1) return Promise.reject(networkError());
        return Promise.resolve({
          kind: "toolCalls",
          toolCalls: [
            { id: "call-1", name: "staticCheck", arguments: {} },
            { id: "call-2", name: "runTests", arguments: {} },
          ],
          usage: undefined,
        });
      },
    };
    const gateway = new CallGateway({
      client,
      budget: new JobBudget(1_000),
      rates: RATES,
      now: () => 0,
      deadline: 100_000,
      callTimeoutMs: 100,
    });

    const result = await gateway.callWithTools(TOOL_REQUEST);
    expect(result.kind).toBe("ok");
    expect(attempts).toBe(2);
    expect(gateway.calls).toBe(2);
    expect(gateway.retries).toBe(1);
    expect(gateway.toolCalls).toBe(2);
  });

  it("例外（やり直さない誤り）では、増えない", async () => {
    const gateway = new CallGateway({
      client: throwingClient(errorWithKind("refusal")),
      budget: new JobBudget(1_000),
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });

    const result = await gateway.callWithTools(TOOL_REQUEST);
    expect(result.kind).toBe("failed");
    expect(gateway.toolCalls).toBe(0);
  });
});

// ── 生成と判定で共有する実試行の門（Issue #432）────────────────────

describe("生成と判定で共有する実試行の門（Issue #432）", () => {
  it("門があれば、生成の実試行（再試行も）を 1 つの数で数え、合算の上限に掛ける", async () => {
    let attempts = 0;
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        attempts += 1;
        // 1 回目はやり直してよい誤り（network）で失敗させる
        if (attempts === 1) return Promise.reject(networkError());
        return Promise.resolve({ output: { ok: true } as T, usage: USAGE });
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    // すでに判定が 1 試行を使ったところから始める（合算の上限 2）
    const gate = createCallGate({ now: () => 0, deadline: 100_000, limit: 2 });
    gate.begin();
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({
      client,
      budget,
      rates: RATES,
      now: () => 0,
      deadline: 100_000,
      callTimeoutMs: 100,
      gate,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);

    // 1 回目の生成は通る（合計 2）が、**再試行は合算の上限に掛かって開始できない**
    expect(result).toEqual({ kind: "limitExceeded", limit: "callCount", max: 2, actual: 2 });
    expect(attempts).toBe(1);
    expect(gate.attempts()).toBe(2);
  });

  it("門の締切を過ぎていれば、生成の実呼び出しをせずに締切切れを返す", async () => {
    let called = 0;
    const gate = createCallGate({ now: () => 5_000, deadline: 5_000, limit: 10 });
    const gateway = new CallGateway({
      client: spyClient(() => {
        called += 1;
      }),
      budget: new JobBudget(1_000),
      rates: RATES,
      now: () => 5_000,
      deadline: 5_000,
      gate,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("deadlineExceeded");
    expect(called).toBe(0);
    expect(gate.attempts()).toBe(0);
  });

  it("門は上限ちょうどまで通し、その次の試行は拒否する（開始の可否）", () => {
    const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 2 });
    // 上限の 2 回までは始められる
    expect(gate.begin()).toBe("ok");
    expect(gate.begin()).toBe("ok");
    // 3 回目は上限に達しているので始められない（試行は数えない）
    expect(gate.begin()).toBe("limit");
    expect(gate.attempts()).toBe(2);
  });
});

// ── 上限を上げた呼び出しの予約の境界（02 §1.5・Issue #399）──────────────

describe("上限を上げた呼び出しの予約は、入力込みで見積もり、残高の境界で分ける（02 §1.5・Issue #399）", () => {
  /** 設計の段の上限まで上げた要求（入力は今までどおり） */
  const raised: LlmStructuredRequest = {
    ...STRUCTURED_REQUEST,
    maxOutputTokens: maxOutputTokensForEffort("high", "design"),
  };

  it("残高がちょうど足りれば呼び、1 足りなければ呼ばない", async () => {
    const maxCostUsd = maxCostOf(structuredInputParts(raised), raised.maxOutputTokens);
    // 予約は入力込み——出力の上限だけの費用より、入力の分だけ大きい
    expect(maxCostUsd).toBeGreaterThan(raised.maxOutputTokens * RATES.outputPerToken);

    // ちょうど足りる：呼び、usage が返らないので入力込みの予約が残る（扱いは変わらない）
    const exact = new JobBudget(maxCostUsd);
    const exactGateway = new CallGateway({
      client: createFakeLlmClient([{ kind: "structured", output: { ok: true }, usage: undefined }]),
      budget: exact,
      rates: RATES,
      now: () => 0,
      deadline: 1_000_000,
    });
    expect((await exactGateway.callStructured(raised)).kind).toBe("ok");
    expect(exact.reservedUsd).toBe(maxCostUsd);

    // 1 足りない：呼ばずに知らせる
    const short = new JobBudget(maxCostUsd - 1);
    let called = 0;
    const shortGateway = new CallGateway({
      client: spyClient(() => {
        called += 1;
      }),
      budget: short,
      rates: RATES,
      now: () => 0,
      deadline: 1_000_000,
    });
    expect(await shortGateway.callStructured(raised)).toEqual({
      kind: "budgetExceeded",
      maxCostUsd,
      remainingUsd: maxCostUsd - 1,
    });
    expect(called).toBe(0);
    expect(short.reservedUsd).toBe(0);
  });
});

// ── 未完了の応答（02 §2.2・§1.5）────────────────────────────────

const incompleteError = (usage: LlmUsage | undefined): OpenAiIncompleteError =>
  new OpenAiIncompleteError("max_output_tokens", usage, "応答が完了していません（reason=max_output_tokens）");

/** いつも同じ誤りを返す偽物（実 API を呼ばない） */
function throwingClient(error: unknown): LlmClient {
  return {
    callStructured<T>(): Promise<LlmStructuredResponse<T>> {
      return Promise.reject(error);
    },
    callWithTools(): Promise<LlmToolResponse> {
      return Promise.reject(error);
    },
  };
}

describe("未完了の応答（02 §2.2・§1.5）", () => {
  it("未完了の応答は、同じ要求のままやり直さず、拒否と分ける", async () => {
    let attempts = 0;
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        attempts += 1;
        return Promise.reject(incompleteError(USAGE));
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({ client, budget, rates: RATES, now: () => 0, deadline: 1_000 });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result).toEqual({ kind: "incomplete", reason: "max_output_tokens", usage: USAGE });
    expect(attempts).toBe(1);
    expect(gateway.calls).toBe(1);
    expect(gateway.retries).toBe(0);
  });

  it("usage 付きの未完了の応答は、実際の費用で精算する", async () => {
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({
      client: throwingClient(incompleteError(USAGE)),
      budget,
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });

    await gateway.callStructured(STRUCTURED_REQUEST);
    expect(budget.spentUsd).toBe(costOfUsageUsd(USAGE, RATES));
    expect(budget.reservedUsd).toBe(0);
  });

  it("usage の無い未完了の応答では、予約が残る", async () => {
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({
      client: throwingClient(incompleteError(undefined)),
      budget,
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result).toEqual({ kind: "incomplete", reason: "max_output_tokens", usage: undefined });
    expect(budget.spentUsd).toBe(0);
    expect(budget.reservedUsd).toBe(
      maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens),
    );
  });

  it("未完了の応答を表す誤りを、構造で見分ける（口は adapter に依存しない）", () => {
    expect(isIncompleteResponseError(incompleteError(USAGE))).toBe(true);
    expect(
      isIncompleteResponseError(Object.assign(new Error("x"), { kind: "incomplete", reason: "max_output_tokens" })),
    ).toBe(true);
    expect(isIncompleteResponseError(new Error("拒否"))).toBe(false);
    expect(isIncompleteResponseError({ kind: "incomplete", reason: "max_output_tokens" })).toBe(false);
  });
});

// ── 要求そのものが不正な誤り（02 §2.2）────────────────────────────

/** 要求の誤りを表す誤り（HTTP 400 など。adapter が投げる形をまねる） */
const invalidRequestError = (code: string): Error =>
  Object.assign(new Error(`要求が不正です（${code}）`), { kind: "invalidRequest", code });

describe("要求そのものが不正な誤り（02 §2.2）", () => {
  it("拒否と分け、同じ要求のままやり直さない（試行は 1 回で止める）", async () => {
    let attempts = 0;
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        attempts += 1;
        return Promise.reject(invalidRequestError("invalid_json_schema"));
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const budget = new JobBudget(1_000);
    const gateway = new CallGateway({ client, budget, rates: RATES, now: () => 0, deadline: 1_000 });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result).toEqual({ kind: "invalidRequest", code: "invalid_json_schema" });
    expect(attempts).toBe(1);
    expect(gateway.calls).toBe(1);
    expect(gateway.retries).toBe(0);
  });

  it("要求の誤りを表す誤りを、構造で見分ける（口は adapter に依存しない）", () => {
    expect(isInvalidRequestError(invalidRequestError("invalid_json_schema"))).toBe(true);
    expect(
      isInvalidRequestError(Object.assign(new Error("x"), { kind: "invalidRequest", code: "invalid_json_schema" })),
    ).toBe(true);
    expect(isInvalidRequestError(new Error("拒否"))).toBe(false);
    // code が無いものは、要求の誤りとして見分けない
    expect(isInvalidRequestError(Object.assign(new Error("x"), { kind: "invalidRequest" }))).toBe(false);
    expect(isInvalidRequestError({ kind: "invalidRequest", code: "invalid_json_schema" })).toBe(false);
  });
});

// ── 誤りの種類をそのまま分類し、やり直してよい誤りだけをやり直す（02 §2.2・#302）──

/** 分類する誤りを作る（adapter が投げる形をまねる） */
function errorWithKind(kind: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`誤り（${kind}）`), { kind }, extra);
}

/** 1 回の構造化出力を、決まった誤りで失敗させる（試行の回数と口を返す） */
async function classifyOne(
  error: unknown,
  options: { readonly callTimeoutMs?: number; readonly deadline?: number; readonly maxAttempts?: number } = {},
): Promise<{
  readonly result: CallResult<LlmStructuredResponse<unknown>>;
  readonly attempts: number;
  readonly gateway: CallGateway;
}> {
  let attempts = 0;
  const client: LlmClient = {
    callStructured<T>(): Promise<LlmStructuredResponse<T>> {
      attempts += 1;
      return Promise.reject(error);
    },
    callWithTools(): Promise<LlmToolResponse> {
      return Promise.reject(new Error("使わない"));
    },
  };
  const gateway = new CallGateway({
    client,
    budget: new JobBudget(1_000_000),
    rates: RATES,
    now: () => 0,
    deadline: options.deadline ?? 100_000,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
  });
  const result = await gateway.callStructured(STRUCTURED_REQUEST);
  return { result, attempts, gateway };
}

describe("誤りの種類をそのまま分類する（02 §2.2・#302）", () => {
  it("adapter の種類をそのまま写す（timeout を拒否にしない）", () => {
    expect(categorizeCallError(errorWithKind("timeout")).kind).toBe("timeout");
    expect(categorizeCallError(errorWithKind("network")).kind).toBe("network");
    expect(categorizeCallError(errorWithKind("balance")).kind).toBe("balance");
    expect(categorizeCallError(errorWithKind("refusal")).kind).toBe("refusal");
    expect(categorizeCallError(errorWithKind("malformed")).kind).toBe("malformed");
    expect(categorizeCallError(errorWithKind("toolArguments")).kind).toBe("toolArguments");
    expect(categorizeCallError(errorWithKind("http", { status: 503 }))).toEqual({ kind: "http", status: 503 });
    // 分類できない例外は unknown（拒否にしない）
    expect(categorizeCallError(new Error("分類できない")).kind).toBe("unknown");
    expect(categorizeCallError("文字列").kind).toBe("unknown");
  });

  it("やり直してよいのは timeout・network・HTTP の 5xx だけ", () => {
    expect(isRetryableCallError({ kind: "timeout" })).toBe(true);
    expect(isRetryableCallError({ kind: "network" })).toBe(true);
    expect(isRetryableCallError({ kind: "http", status: 500 })).toBe(true);
    expect(isRetryableCallError({ kind: "http", status: 503 })).toBe(true);
    expect(isRetryableCallError({ kind: "http", status: 429 })).toBe(false);
    expect(isRetryableCallError({ kind: "http" })).toBe(false);
    expect(isRetryableCallError({ kind: "balance" })).toBe(false);
    expect(isRetryableCallError({ kind: "refusal" })).toBe(false);
    expect(isRetryableCallError({ kind: "malformed" })).toBe(false);
    expect(isRetryableCallError({ kind: "toolArguments" })).toBe(false);
    expect(isRetryableCallError({ kind: "unknown" })).toBe(false);
  });
});

describe("誤りの種類が別々に失敗として出る（02 §2.2・#302）", () => {
  const notRetryable: readonly { readonly error: Error; readonly kind: CallErrorKind }[] = [
    { error: errorWithKind("refusal"), kind: "refusal" },
    { error: errorWithKind("balance"), kind: "balance" },
    { error: errorWithKind("http", { status: 400 }), kind: "http" },
    { error: errorWithKind("malformed"), kind: "malformed" },
    { error: errorWithKind("toolArguments"), kind: "toolArguments" },
    { error: new Error("分類できない"), kind: "unknown" },
  ];

  it("やり直さない誤りは、その種類のまま 1 回で失敗にする（拒否に混ぜない）", async () => {
    for (const one of notRetryable) {
      const { result, attempts, gateway } = await classifyOne(one.error, { callTimeoutMs: 100, deadline: 100_000 });
      expect(result.kind, one.kind).toBe("failed");
      if (result.kind !== "failed") continue;
      expect(result.errorKind, one.kind).toBe(one.kind);
      expect(attempts, one.kind).toBe(1);
      expect(gateway.retries, one.kind).toBe(0);
    }
  });

  it("やり直してよい誤り（network・HTTP の 5xx）は、長くした timeout でやり直す", async () => {
    for (const error of [networkError(), errorWithKind("http", { status: 503 })]) {
      const { result, attempts, gateway } = await classifyOne(error, { callTimeoutMs: 100, deadline: 100_000 });
      expect(result.kind).toBe("failed");
      expect(attempts).toBe(2);
      expect(gateway.retries).toBe(1);
    }
  });
});

describe("呼び出しごとの timeout（02 §1.5・#302）", () => {
  it("締切に触れずに打ち切られたら、締切ではなく timeout として記録する", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let nowMs = 0;
      const client: LlmClient = {
        callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
          attempts += 1;
          return new Promise<never>(() => {
            request.signal?.addEventListener("abort", () => {});
          });
        },
        callWithTools(): Promise<LlmToolResponse> {
          return Promise.reject(new Error("使わない"));
        },
      };
      const gateway = new CallGateway({
        client,
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => nowMs,
        deadline: 1_001,
        maxAttempts: 2,
        callTimeoutMs: 1_000,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      nowMs = 1_000; // 1 回目の試行で時間を使い切る
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.errorKind).toBe("timeout");
      // 同じ timeout ではやり直さない（残り時間の中で長くできないので、試行は 1 回で止まる）
      expect(result.attempts).toBe(1);
      expect(attempts).toBe(1);
      expect(gateway.retries).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("締切の残りに余裕があれば、timeout を長くしてやり直す", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let nowMs = 0;
      const client: LlmClient = {
        callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
          attempts += 1;
          if (attempts === 1) {
            return new Promise<never>(() => {
              request.signal?.addEventListener("abort", () => {});
            });
          }
          return Promise.resolve({ output: { ok: true } as T, usage: USAGE });
        },
        callWithTools(): Promise<LlmToolResponse> {
          return Promise.reject(new Error("使わない"));
        },
      };
      const gateway = new CallGateway({
        client,
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => nowMs,
        deadline: 100_000,
        maxAttempts: 2,
        callTimeoutMs: 1_000,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      nowMs = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.kind).toBe("ok");
      expect(attempts).toBe(2);
      expect(gateway.retries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── effort から出した timeout と、締切の残り（Issue #399）──────────────────

describe("effort low の timeout は 60 秒で、やり直しで伸び、締切の残りを超えない（Issue #399）", () => {
  /** いつまでも返らない偽物（打ち切りの合図で、打ち切られたことだけ数える） */
  const hangingClient = (onAbort: () => void): LlmClient => ({
    callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
      return new Promise<never>(() => {
        request.signal?.addEventListener("abort", () => {
          onAbort();
        });
      });
    },
    callWithTools(): Promise<LlmToolResponse> {
      return Promise.reject(new Error("使わない"));
    },
  });

  it("最初の試行は 60 秒（low の基準）で、やり直しは 120 秒へ伸びる", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let aborts = 0;
      const gateway = new CallGateway({
        client: hangingClient(() => {
          aborts += 1;
        }),
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => Date.now(),
        deadline: 600_000,
        effort: "low",
        maxAttempts: 3,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      // 1 回目は 60 秒まで打ち切らない
      await vi.advanceTimersByTimeAsync(59_999);
      expect(aborts).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborts).toBe(1);
      // やり直しは 120 秒——60 秒を過ぎても打ち切られない
      await vi.advanceTimersByTimeAsync(60_000);
      expect(aborts).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(aborts).toBe(2);
      // 3 回目（240 秒）まで進めて、試行を使い切る
      await vi.advanceTimersByTimeAsync(240_000);
      const result = await pending;
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.errorKind).toBe("timeout");
      expect(result.attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("やり直しの timeout が残り時間で伸ばせなければ、試行を重ねずに timeout で止まる", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let aborts = 0;
      const gateway = new CallGateway({
        client: hangingClient(() => {
          aborts += 1;
        }),
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => Date.now(),
        deadline: 90_000,
        effort: "low",
        maxAttempts: 3,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      await vi.advanceTimersByTimeAsync(60_000);
      // 1 回目は 60 秒で打ち切った（まだ締切ではない）
      expect(aborts).toBe(1);
      const result = await pending;
      // 2 回目の 120 秒は残り 30 秒に切り詰められる（60 秒より短い）——同じ・短い timeout ではやり直さない
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.errorKind).toBe("timeout");
      expect(result.attempts).toBe(1);
      expect(aborts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 試行の終端と再試行の数（Issue #446）──────────────────────────────
//
// 共通の口が、試行の終端を**理由別**に 1 つの開始につき 1 度だけ数える。不変の式：
// 開始 ＝ 応答 ＋ 誤り ＋ 締切の打ち切り ＋ timeout の打ち切り。未着手は開始に数えない。
// 競合に敗れた側（打ち切ったあとに遅れて来た値・例外）は、新しい終端の数を変えない。

/** 不変の式を確かめる（すべての例で成り立つ。Issue #446） */
function expectAttemptInvariant(gateway: CallGateway): void {
  const attempts = gateway.attempts;
  expect(attempts.started, "開始 ＝ 応答＋誤り＋締切の打ち切り＋timeout の打ち切り").toBe(
    attempts.responded + attempts.errors + attempts.cancelled_deadline + attempts.cancelled_timeout,
  );
}

/** いつまでも返らない偽物（打ち切りの合図で、打ち切られたことだけ数える） */
const hangingStructured = (onAbort: () => void): LlmClient => ({
  callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
    return new Promise<never>(() => {
      request.signal?.addEventListener("abort", () => {
        onAbort();
      });
    });
  },
  callWithTools(): Promise<LlmToolResponse> {
    return Promise.reject(new Error("使わない"));
  },
});

/** 打ち切りの合図を無視して、遅れて決まる偽物（負例。Issue #446） */
const lateStructured = (settle: "resolve" | "reject", delayMs: number): LlmClient => ({
  callStructured<T>(): Promise<LlmStructuredResponse<T>> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (settle === "resolve") resolve({ output: { ok: true } as T, usage: USAGE });
        else reject(networkError());
      }, delayMs);
    });
  },
  callWithTools(): Promise<LlmToolResponse> {
    return Promise.reject(new Error("使わない"));
  },
});

describe("試行の終端と再試行の数を、理由別に分けて数える（Issue #446）", () => {
  it("1 回目で応答 → 開始 1・応答 1・再試行 0", async () => {
    const gateway = new CallGateway({
      client: createFakeLlmClient([{ kind: "structured", output: { ok: true }, usage: USAGE }]),
      budget: new JobBudget(1_000),
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("ok");
    expect(gateway.attempts).toMatchObject({ started: 1, responded: 1, errors: 0 });
    expect(gateway.attempts.not_started).toEqual({ deadline: 0, budget: 0, limit: 0, timeout: 0 });
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 0 });
    expectAttemptInvariant(gateway);
  });

  it("timeout のあと応答 → 開始 2・timeout の打ち切り 1・応答 1・通信 1", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let nowMs = 0;
      const client: LlmClient = {
        callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
          attempts += 1;
          if (attempts === 1) {
            return new Promise<never>(() => {
              request.signal?.addEventListener("abort", () => {});
            });
          }
          return Promise.resolve({ output: { ok: true } as T, usage: USAGE });
        },
        callWithTools(): Promise<LlmToolResponse> {
          return Promise.reject(new Error("使わない"));
        },
      };
      const gateway = new CallGateway({
        client,
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => nowMs,
        deadline: 100_000,
        maxAttempts: 2,
        callTimeoutMs: 1_000,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      nowMs = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.kind).toBe("ok");
      expect(gateway.attempts).toMatchObject({ started: 2, responded: 1, errors: 0, cancelled_timeout: 1 });
      expect(gateway.retryCounts.communication).toBe(1);
      expectAttemptInvariant(gateway);
    } finally {
      vi.useRealTimers();
    }
  });

  it("5xx のあと応答 → 開始 2・誤り 1・応答 1・通信 1", async () => {
    let attempts = 0;
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        attempts += 1;
        if (attempts === 1) return Promise.reject(errorWithKind("http", { status: 503 }));
        return Promise.resolve({ output: { ok: true } as T, usage: USAGE });
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const gateway = new CallGateway({
      client,
      budget: new JobBudget(1_000_000),
      rates: RATES,
      now: () => 0,
      deadline: 100_000,
      maxAttempts: 2,
      callTimeoutMs: 100,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("ok");
    expect(gateway.attempts).toMatchObject({ started: 2, responded: 1, errors: 1 });
    expect(gateway.retryCounts.communication).toBe(1);
    expectAttemptInvariant(gateway);
  });

  it("未完了（usage 有り／無し）→ どちらも応答 1・誤り 0", async () => {
    for (const usage of [USAGE, undefined]) {
      const gateway = new CallGateway({
        client: throwingClient(incompleteError(usage)),
        budget: new JobBudget(1_000),
        rates: RATES,
        now: () => 0,
        deadline: 1_000,
      });
      await gateway.callStructured(STRUCTURED_REQUEST);
      expect(gateway.attempts).toMatchObject({ started: 1, responded: 1, errors: 0 });
      expectAttemptInvariant(gateway);
    }
  });

  it("拒否・形の誤り・不正な要求 → 開始 1・誤り 1・やり直さない", async () => {
    const cases: readonly unknown[] = [
      errorWithKind("refusal"),
      errorWithKind("malformed"),
      invalidRequestError("invalid_json_schema"),
    ];
    for (const error of cases) {
      const gateway = new CallGateway({
        client: throwingClient(error),
        budget: new JobBudget(1_000),
        rates: RATES,
        now: () => 0,
        deadline: 1_000_000,
      });
      const result = await gateway.callStructured(STRUCTURED_REQUEST);
      expect(result.kind === "failed" || result.kind === "invalidRequest").toBe(true);
      expect(gateway.calls).toBe(1);
      expect(gateway.attempts).toMatchObject({ started: 1, responded: 0, errors: 1 });
      expect(gateway.retryCounts.communication).toBe(0);
      expectAttemptInvariant(gateway);
    }
  });

  it("通信のやり直しは実開始で数える：1 回目が再試行してよい誤りで、2 回目が締切で始まらないと、通信 0・未着手（締切）1（Issue #478）", async () => {
    let clock = 0;
    let calls = 0;
    const client: LlmClient = {
      callStructured<T>(): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        // 1 回目の応答（誤り）のあと、締切を越える——2 回目の開始は門（締切）で断られる
        clock = 10_000;
        return Promise.reject(networkError());
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    const gateway = new CallGateway({
      client,
      budget: new JobBudget(1_000_000),
      rates: RATES,
      now: () => clock,
      deadline: 1_000,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    // 2 回目の実呼び出しは始まっていないので、通信のやり直しは数えない（実開始で数える）
    expect(result.kind).toBe("deadlineExceeded");
    expect(calls).toBe(1);
    expect(gateway.retryCounts.communication).toBe(0);
    expect(gateway.attempts).toMatchObject({ started: 1, responded: 0, errors: 1 });
    expect(gateway.attempts.not_started.deadline).toBe(1);
    expectAttemptInvariant(gateway);
  });

  it("残りが 0 以下 → 未着手（締切）1・開始 0・deadlineExceeded", async () => {
    let called = 0;
    const gateway = new CallGateway({
      client: spyClient(() => {
        called += 1;
      }),
      budget: new JobBudget(1_000),
      rates: RATES,
      now: () => 5_000,
      deadline: 5_000,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("deadlineExceeded");
    expect(called).toBe(0);
    expect(gateway.attempts.started).toBe(0);
    expect(gateway.attempts.not_started.deadline).toBe(1);
    expectAttemptInvariant(gateway);
  });

  it("呼んでいる途中で締切 → 開始 1・応答 0・締切の打ち切り 1", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const gateway = new CallGateway({
        client: hangingStructured(() => {
          aborted = true;
        }),
        budget: new JobBudget(1_000),
        rates: RATES,
        now: () => 0,
        deadline: 1_000,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.kind).toBe("deadlineExceeded");
      expect(aborted).toBe(true);
      expect(gateway.attempts).toMatchObject({ started: 1, responded: 0, cancelled_deadline: 1 });
      expectAttemptInvariant(gateway);
    } finally {
      vi.useRealTimers();
    }
  });

  it("予約できない → 未着手（予算）1", async () => {
    const maxCostUsd = maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens);
    let called = 0;
    const gateway = new CallGateway({
      client: spyClient(() => {
        called += 1;
      }),
      budget: new JobBudget(maxCostUsd - 1),
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });

    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("budgetExceeded");
    expect(called).toBe(0);
    expect(gateway.attempts.started).toBe(0);
    expect(gateway.attempts.not_started.budget).toBe(1);
    expectAttemptInvariant(gateway);
  });

  it("呼び出しの数の上限 → 未着手（上限）1", async () => {
    const gateway = new CallGateway({
      client: spyClient(() => {}),
      budget: new JobBudget(1_000_000),
      rates: RATES,
      now: () => 0,
      deadline: 1_000_000,
      limits: { ...AGENT_LIMITS, callCount: 1 },
    });

    await gateway.callStructured(STRUCTURED_REQUEST);
    const result = await gateway.callStructured(STRUCTURED_REQUEST);
    expect(result.kind).toBe("limitExceeded");
    expect(gateway.attempts.started).toBe(1);
    expect(gateway.attempts.not_started.limit).toBe(1);
    expectAttemptInvariant(gateway);
  });

  it("timeout を伸ばせない → 未着手（timeout）1", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let aborts = 0;
      const gateway = new CallGateway({
        client: hangingStructured(() => {
          aborts += 1;
        }),
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => Date.now(),
        deadline: 90_000,
        effort: "low",
        maxAttempts: 3,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(result.kind).toBe("failed");
      expect(aborts).toBe(1);
      expect(gateway.attempts).toMatchObject({ started: 1, cancelled_timeout: 1 });
      expect(gateway.attempts.not_started.timeout).toBe(1);
      expectAttemptInvariant(gateway);
    } finally {
      vi.useRealTimers();
    }
  });

  it("負例：打ち切ったあとに遅れて成功が来ても、応答は増えない（打ち切り 1 のまま）", async () => {
    vi.useFakeTimers();
    try {
      const budget = new JobBudget(1_000_000);
      const gateway = new CallGateway({
        client: lateStructured("resolve", 5_000),
        budget,
        rates: RATES,
        now: () => 0,
        deadline: 1_000,
        callTimeoutMs: 1_000,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.kind).toBe("deadlineExceeded");

      const before = gateway.counts;
      expect(before.attempts).toMatchObject({ started: 1, responded: 0, errors: 0, cancelled_deadline: 1 });
      // 打ち切ったあとに、遅れて成功が来る
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gateway.counts).toEqual(before);
      expectAttemptInvariant(gateway);
      // 打ち切った呼び出しの予約は残る（減らない）
      expect(budget.reservedUsd).toBe(
        maxCostOf(structuredInputParts(STRUCTURED_REQUEST), STRUCTURED_REQUEST.maxOutputTokens),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("負例：打ち切ったあとに遅れて例外が来ても、誤りは増えない（打ち切り 1 のまま）", async () => {
    vi.useFakeTimers();
    try {
      const budget = new JobBudget(1_000_000);
      const gateway = new CallGateway({
        client: lateStructured("reject", 5_000),
        budget,
        rates: RATES,
        now: () => 0,
        deadline: 1_000,
        callTimeoutMs: 1_000,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.kind).toBe("deadlineExceeded");

      const before = gateway.counts;
      expect(before.attempts).toMatchObject({ started: 1, responded: 0, errors: 0, cancelled_deadline: 1 });
      // 打ち切ったあとに、遅れて例外が来る
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gateway.counts).toEqual(before);
      expectAttemptInvariant(gateway);
    } finally {
      vi.useRealTimers();
    }
  });

  it("告げる口で、形・中身の再試行を 1 つずつ数える（通信は口が自分で数える）", () => {
    const gateway = new CallGateway({
      client: spyClient(() => {}),
      budget: new JobBudget(1_000),
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });
    gateway.noteRetry("shape");
    gateway.noteRetry("content");
    gateway.noteRetry("shape");
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 2, content: 1 });
  });

  it("2 時点の差が取れる（計の差を段の記録に写せる）", async () => {
    const gateway = new CallGateway({
      client: createFakeLlmClient([
        { kind: "structured", output: { ok: true }, usage: USAGE },
        { kind: "structured", output: { ok: true }, usage: USAGE },
      ]),
      budget: new JobBudget(1_000),
      rates: RATES,
      now: () => 0,
      deadline: 1_000,
    });
    const before = gateway.counts;
    await gateway.callStructured(STRUCTURED_REQUEST);
    const mid = gateway.counts;
    await gateway.callStructured(STRUCTURED_REQUEST);
    const after = gateway.counts;

    const first = callCountsDelta(before, mid);
    const second = callCountsDelta(mid, after);
    expect(first).toEqual(second);
    expect(first).toEqual({
      attempts: {
        started: 1,
        responded: 1,
        errors: 0,
        cancelled_deadline: 0,
        cancelled_timeout: 0,
        not_started: { deadline: 0, budget: 0, limit: 0, timeout: 0 },
      },
      retries: { communication: 0, shape: 0, content: 0 },
    });
    expect(callCountsDelta(before, after).attempts.started).toBe(2);
  });
});

// ── 段の名前で引いた口（段ごとの effort。Issue #664）──────────────────────────
//
// 段ごとの effort を受けた口は、`forStage(段)` でその段の effort を持つ薄い見方を返す。出力の上限・呼び出しごとの timeout の
// 基準・要求の effort の 3 つが、**同じ段の同じ effort**から出ることを 1 つの試験で照らす。指定の無い段は元の口そのもの。

/** 要求から打ち切りの合図を除く（Issue #664） */
const withoutSignal = ({ signal: _signal, ...rest }: LlmStructuredRequest): Omit<LlmStructuredRequest, "signal"> => rest;

describe("段の名前で引いた口（段ごとの effort。Issue #664）", () => {
  /** 受けた要求を記録し、打ち切りの合図で打ち切られたことを数える偽物（`hang` の要求だけ返らない） */
  const recordingHanging = (hang: (request: LlmStructuredRequest) => boolean) => {
    const requests: LlmStructuredRequest[] = [];
    const aborted: LlmStructuredRequest[] = [];
    const client: LlmClient = {
      callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        requests.push(request);
        if (!hang(request)) return Promise.resolve({ output: {} as T, usage: USAGE });
        return new Promise<never>(() => {
          request.signal?.addEventListener("abort", () => {
            aborted.push(request);
          });
        });
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("使わない"));
      },
    };
    return { client, requests, aborted };
  };

  it("(3) C3 に low を指定した口：C3 の要求の max_output_tokens・effort・呼び出しごとの timeout の基準が low の値で、ほかの段は high のまま。計は元の口と共有する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const recording = recordingHanging((request) => request.schemaName === "hang");
      const gateway = new CallGateway({
        client: recording.client,
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => Date.now(),
        deadline: 600_000,
        effort: "high",
        maxAttempts: 1,
        stageEfforts: { "semantic-check": "low" },
      });
      const c3 = gateway.forStage("semantic-check");
      const others = STAGE_EFFORT_STAGES.filter((stage) => stage !== "semantic-check").map((stage) => gateway.forStage(stage));
      // 上限と timeout の基準：C3 は low の値、ほかは元の口（high）のまま
      expect(c3).not.toBe(gateway);
      expect(c3.effort).toBe("low");
      expect(c3.maxOutputTokens("semantic-check")).toBe(STAGE_MAX_OUTPUT_TOKENS.low["semantic-check"]);
      expect(c3.callTimeoutMs).toBe(CALL_TIMEOUT_BY_EFFORT.low);
      for (const other of others) {
        expect(other).toBe(gateway);
        expect(other.effort).toBe("high");
        expect(other.callTimeoutMs).toBe(CALL_TIMEOUT_BY_EFFORT.high);
      }
      // 要求：C3 の要求にだけ effort low が載り、上限は段の口が引いた値。ほかの段の要求は今の要求のまま（effort の欄が無い）
      await c3.callStructured({ ...STRUCTURED_REQUEST, maxOutputTokens: c3.maxOutputTokens("semantic-check") });
      await gateway.forStage("write").callStructured({ ...STRUCTURED_REQUEST, maxOutputTokens: gateway.maxOutputTokens("write") });
      expect(recording.requests[0]?.effort).toBe("low");
      expect(recording.requests[0]?.maxOutputTokens).toBe(STAGE_MAX_OUTPUT_TOKENS.low["semantic-check"]);
      expect("effort" in (recording.requests[1] ?? {})).toBe(false);
      expect(withoutSignal(recording.requests[1] as LlmStructuredRequest)).toEqual({ ...STRUCTURED_REQUEST, maxOutputTokens: STAGE_MAX_OUTPUT_TOKENS.high.write });
      // 実際の打ち切り：C3 の口は low の 60 秒で、元の口は high の 300 秒で打ち切る（同じ時計）
      const c3Pending = c3.callStructured({ ...STRUCTURED_REQUEST, schemaName: "hang" });
      const basePending = gateway.callStructured({ ...STRUCTURED_REQUEST, schemaName: "hang" });
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_BY_EFFORT.low - 1);
      expect(recording.aborted).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(recording.aborted.map((request) => request.effort)).toEqual(["low"]);
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_BY_EFFORT.high - CALL_TIMEOUT_BY_EFFORT.low - 1);
      expect(recording.aborted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(recording.aborted).toHaveLength(2);
      expect((await c3Pending).kind).toBe("failed");
      expect((await basePending).kind).toBe("failed");
      // 計は共有：どちらの口から見ても 4 回の開始・2 回の timeout の打ち切り
      expect(gateway.calls).toBe(4);
      expect(c3.calls).toBe(4);
      expect(c3.counts).toEqual(gateway.counts);
      expect(gateway.attempts.cancelled_timeout).toBe(2);
      // 段の口から段の口を引いても、元の口の組から引く
      expect(c3.forStage("write")).toBe(gateway);
      expect(c3.forStage("semantic-check").effort).toBe("low");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(4) 指定の無い段の口（組を渡さない口・組に無い段）は元の口そのもので、上限・timeout・effort・要求が今の口と同じ", async () => {
    const recording = recordingHanging(() => false);
    const plain = new CallGateway({ client: recording.client, budget: new JobBudget(1_000_000), rates: RATES, now: () => 0, deadline: 600_000, effort: "medium" });
    const partial = new CallGateway({
      client: recording.client,
      budget: new JobBudget(1_000_000),
      rates: RATES,
      now: () => 0,
      deadline: 600_000,
      effort: "medium",
      stageEfforts: { "decl-check": "low" },
    });
    for (const stage of STAGE_EFFORT_STAGES) {
      const view = plain.forStage(stage);
      expect(view).toBe(plain);
      expect(view.effort).toBe("medium");
      expect(view.callTimeoutMs).toBe(callTimeoutMsForEffort("medium"));
      for (const output of OUTPUT_STAGES) expect(view.maxOutputTokens(output)).toBe(maxOutputTokensForEffort("medium", output));
      if (stage !== "decl-check") expect(partial.forStage(stage)).toBe(partial);
    }
    await plain.forStage("semantic-check").callStructured(STRUCTURED_REQUEST);
    await partial.forStage("semantic-check").callStructured(STRUCTURED_REQUEST);
    for (const request of recording.requests) {
      expect(withoutSignal(request)).toEqual(STRUCTURED_REQUEST);
      expect(Object.keys(request)).toEqual([...Object.keys(STRUCTURED_REQUEST), "signal"]);
    }
  });

  it("呼ぶ側が timeout の基準を指定した口では、段の口もその指定を引き継ぐ（上限と要求の effort は段の値）", () => {
    const gateway = new CallGateway({
      client: spyClient(() => {}),
      budget: new JobBudget(1),
      rates: RATES,
      now: () => 0,
      deadline: 600_000,
      effort: "high",
      callTimeoutMs: 90_000,
      stageEfforts: { mapping: "low" },
    });
    const view = gateway.forStage("mapping");
    expect(view.callTimeoutMs).toBe(90_000);
    expect(view.effort).toBe("low");
    expect(view.maxOutputTokens("name-table")).toBe(STAGE_MAX_OUTPUT_TOKENS.low["name-table"]);
  });
});

// ── 実試行の観測の口（Issue #748）──────────────────────────────────────
//
// 口が確定した分類だけを観測の口へ渡す。開始しなかった試行は行を作らず、打ち切りのあとの完了は
// 終わり方を変えずに遅着として渡る。
describe("実試行の観測の口（Issue #748）：口が確定した分類・打ち切りの時点の確定・遅着", () => {
  interface RecordedObservation {
    started: number;
    end: CallAttemptEnd | undefined;
    late: (LlmUsage | undefined)[];
  }
  function recordingObserver(): { readonly rows: RecordedObservation[]; readonly observer: CallAttemptObserver } {
    const rows: RecordedObservation[] = [];
    return {
      rows,
      observer: {
        beginAttempt(): CallAttemptObservation {
          const row: RecordedObservation = { started: rows.length, end: undefined, late: [] };
          rows.push(row);
          return {
            settle: (end) => {
              if (row.end !== undefined) return;
              row.end = end;
            },
            late: (usage) => row.late.push(usage),
          };
        },
      },
    };
  }

  const usage = (input: number): LlmUsage => ({
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  });
  const structuredResponse = (value: unknown, use?: LlmUsage): LlmStructuredResponse<unknown> =>
    ({ output: value, usage: use }) as LlmStructuredResponse<unknown>;

  it("応答（usage あり・なし）・未完了（usage あり・なし）・要求の不正・通信の誤りからの再送を、口の分類のとおりに 1 試行 1 行で告げる", async () => {
    let index = 0;
    const script: (() => Promise<LlmStructuredResponse<unknown>>)[] = [
      async () => structuredResponse({ ok: 1 }, usage(1)),
      async () => structuredResponse({ ok: 2 }, undefined),
      async () => {
        throw new OpenAiIncompleteError("max_output_tokens", usage(2), "未完了");
      },
      async () => {
        throw new OpenAiIncompleteError("max_output_tokens", undefined, "未完了");
      },
      async () => {
        throw Object.assign(new Error("要求が不正"), { kind: "invalidRequest", code: "invalid_json_schema" });
      },
      async () => {
        throw Object.assign(new Error("通信の誤り"), { kind: "network" });
      },
      async () => structuredResponse({ ok: 3 }, usage(3)),
    ];
    const client: LlmClient = {
      callStructured: <T>() => script[index++]!() as Promise<LlmStructuredResponse<T>>,
      callWithTools: () => {
        throw new Error("呼ばない");
      },
    };
    const recording = recordingObserver();
    const gateway = new CallGateway({
      client,
      budget: new JobBudget(1_000_000),
      rates: RATES,
      now: () => 0,
      deadline: 600_000,
      observer: recording.observer,
    });
    for (let call = 0; call < 6; call += 1) await gateway.callStructured(STRUCTURED_REQUEST);

    expect(recording.rows.map((row) => row.end)).toEqual([
      { kind: "response", usage: usage(1) },
      { kind: "response", usage: undefined },
      { kind: "incomplete", usage: usage(2) },
      { kind: "incomplete", usage: undefined },
      { kind: "error", errorKind: "invalid-request" },
      { kind: "error", errorKind: "network" },
      { kind: "response", usage: usage(3) },
    ]);
    // 行の数は口の実開始の数と一致し、終わり方は attempts の数と一致する
    expect(recording.rows).toHaveLength(gateway.attempts.started);
    expect(gateway.attempts.started).toBe(7);
    expect(gateway.attempts.responded).toBe(5);
    expect(gateway.attempts.errors).toBe(2);
  });

  it("E1：再試行の応答の数 microtask 後に最初の試行が遅着しても、計量の加算の時点で印を採り、実際に差に含んだ段の行へ帰属する", async () => {
    vi.useFakeTimers();
    try {
      const clock = { now: 1_000 };
      const log = new CallRequestLog(1_000, () => clock.now);
      const meter = new UsageMeter();
      let resolveFirst: ((response: LlmStructuredResponse<unknown>) => void) | undefined;
      let calls = 0;
      const client: LlmClient = {
        callStructured: <T>() => {
          calls += 1;
          if (calls === 1) {
            return new Promise<LlmStructuredResponse<T>>((resolve) => {
              resolveFirst = (response) => resolve(response as LlmStructuredResponse<T>);
            });
          }
          return Promise.resolve(structuredResponse({ ok: true }, usage(1)) as LlmStructuredResponse<T>);
        },
        callWithTools: () => {
          throw new Error("呼ばない");
        },
      };
      const gateway = new CallGateway({
        client: meter.wrap(client),
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => clock.now,
        deadline: 600_000,
        callTimeoutMs: 1_000,
        maxAttempts: 2,
        observer: log.observer(),
      });
      const unit = log.beginUnit();
      const before = meter.snapshot;
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      // 1 回目を timeout で打ち切り、2 回目を usage 1 で返す
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.kind).toBe("ok");
      // 打ち切った同じ試行が、再試行の応答の数 microtask 後に usage 11 で遅着する
      resolveFirst?.(structuredResponse({ ok: false }, usage(11)));
      // 計量の加算（印を採る時点）まで進め、そのあとで段の行を積んで単位を閉じる
      for (let turn = 0; turn < 10 && meter.snapshot.input_tokens < 12; turn += 1) await Promise.resolve();
      clock.now += 5;
      const after = meter.snapshot;
      log.finishUnit(unit, 0);
      // 観測の callback が動くまで進める
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      // 加算は段の行の差に入っている（1 + 11）ので、遅着は段の行 0 に帰属する
      expect(after.input_tokens - before.input_tokens).toBe(12);
      expect(log.requests()[0]).toMatchObject({
        stage_index: 0,
        end: "timeout",
        late: { usage: { input_tokens: 11 }, metered_stage_index: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  for (const [label, lateUsage] of [
    ["usage", usage(11)],
    ["missing", undefined],
  ] as const) {
    it(`E1（T2 の二重の計量・${label}）：束の確定のあと B1 が待つ間に同じ試行が遅着しても、束と全体の印を分けて採り、どの段の行にも入らなければ null`, async () => {
      vi.useFakeTimers();
      try {
        const log = new CallRequestLog(0, () => 0);
        const global = new UsageMeter();
        const bundle = new UsageMeter(true);
        let resolveFirst: ((response: LlmStructuredResponse<unknown>) => void) | undefined;
        let calls = 0;
        const client: LlmClient = {
          callStructured: <T>() => {
            calls += 1;
            if (calls === 1) {
              return new Promise<LlmStructuredResponse<T>>((resolve) => {
                resolveFirst = (response) => resolve(response as LlmStructuredResponse<T>);
              });
            }
            return Promise.resolve(structuredResponse({ ok: true }, usage(1)) as LlmStructuredResponse<T>);
          },
          callWithTools: () => {
            throw new Error("呼ばない");
          },
        };
        const bundleUnit = log.beginBoundUnit();
        // 全体の計量と束の計量の**間**に置く門。遅着では全体の加算のあとで止め、B1 を始めてから開ける
        const globalClient = global.wrap(client);
        let invoked = 0;
        let openGate!: () => void;
        const gateOpen = new Promise<void>((resolve) => {
          openGate = resolve;
        });
        const gate: LlmClient = {
          callStructured: async <T>(request: LlmStructuredRequest) => {
            const which = invoked + 1;
            invoked = which;
            const response = await globalClient.callStructured<T>(request);
            if (which === 1) await gateOpen;
            return response;
          },
          callWithTools: (request) => globalClient.callWithTools(request),
        };
        const gateway = new CallGateway({
          client: bundle.wrap(gate),
          budget: new JobBudget(1_000_000),
          rates: RATES,
          now: () => 0,
          deadline: 600_000,
          callTimeoutMs: 1_000,
          maxAttempts: 2,
          observer: log.observer(bundleUnit),
        });
        const pending = gateway.callStructured(STRUCTURED_REQUEST);
        // 最初の試行を timeout で打ち切り、再試行を usage 1 で返す
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await pending).kind).toBe("ok");
        // 束の行と T2 の全体の計量を確定する
        log.finishUnit(bundleUnit, 0);
        // 打ち切った同じ試行が遅着する。全体の計量の加算は束の確定の後・B1 の前（どの行にも入らない）
        resolveFirst?.(structuredResponse({ ok: false }, lateUsage));
        const waitFor = async (predicate: () => boolean): Promise<void> => {
          for (let turn = 0; turn < 1_000 && !predicate(); turn += 1) await Promise.resolve();
          if (!predicate()) throw new Error("前提が壊れた：待っていた加算が起きない");
        };
        await waitFor(() => global.snapshot.calls === 2);
        // B1 の段を始める（全体の計量の前後スナップショットを取る）
        const writeUnit = log.beginUnit();
        const writeBefore = global.snapshot;
        // 外側の束の計量の加算は B1 の開始後（旧の実装はここで印を上書きして B1 に誤帰属した）
        openGate();
        await waitFor(() => bundle.snapshot.calls === 2);
        // 遅着の観測の callback まで microtask を進める
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
        const writeAfter = global.snapshot;
        log.finishUnit(writeUnit, 1);
        // 遅着の usage は、束の行にも B1 の行にも入っていない
        const request = log.requests()[0]!;
        expect(request).toMatchObject({ end: "timeout", stage_index: 0, late: { metered_stage_index: null } });
        expect(writeAfter.input_tokens - writeBefore.input_tokens).toBe(0);
        expect(writeAfter.missing_usage_calls - writeBefore.missing_usage_calls).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("timeout の打ち切りは打ち切りの時点で確定し、あとから来た応答は遅着として渡り、行を変えない", async () => {
    vi.useFakeTimers();
    try {
      let finish: ((response: LlmStructuredResponse<unknown>) => void) | undefined;
      const client: LlmClient = {
        callStructured: <T>() =>
          new Promise<LlmStructuredResponse<T>>((resolve) => {
            finish = (response) => resolve(response as LlmStructuredResponse<T>);
          }),
        callWithTools: () => {
          throw new Error("呼ばない");
        },
      };
      const recording = recordingObserver();
      const gateway = new CallGateway({
        client,
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => 0,
        deadline: 600_000,
        callTimeoutMs: 1_000,
        maxAttempts: 1,
        observer: recording.observer,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({ kind: "failed", errorKind: "timeout", attempts: 1 });
      expect(recording.rows.map((row) => row.end)).toEqual([{ kind: "timeout" }]);
      // 打ち切ったあとに client が応答を返す（遅着）
      finish!(structuredResponse({ late: true }, usage(9)));
      await Promise.resolve();
      await Promise.resolve();
      expect(recording.rows[0]?.end).toEqual({ kind: "timeout" });
      expect(recording.rows[0]?.late).toEqual([usage(9)]);
      expect(gateway.attempts.cancelled_timeout).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("締切の打ち切りは deadline として確定し、締切で未着手の試行は行を作らない", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const client: LlmClient = {
        callStructured: <T>() => new Promise<LlmStructuredResponse<T>>(() => {}),
        callWithTools: () => {
          throw new Error("呼ばない");
        },
      };
      const recording = recordingObserver();
      const gateway = new CallGateway({
        client,
        budget: new JobBudget(1_000_000),
        rates: RATES,
        now: () => now,
        deadline: 1_000,
        callTimeoutMs: 5_000,
        maxAttempts: 1,
        observer: recording.observer,
      });
      const pending = gateway.callStructured(STRUCTURED_REQUEST);
      now = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({ kind: "deadlineExceeded" });
      expect(recording.rows.map((row) => row.end)).toEqual([{ kind: "deadline" }]);
      expect(gateway.attempts.cancelled_deadline).toBe(1);

      // 締切を過ぎてから呼ぶ＝未着手。行は作らない
      expect(await gateway.callStructured(STRUCTURED_REQUEST)).toEqual({ kind: "deadlineExceeded" });
      expect(recording.rows).toHaveLength(1);
      expect(gateway.attempts.not_started.deadline).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
