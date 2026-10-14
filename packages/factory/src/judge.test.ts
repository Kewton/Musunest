// 落とす組み合わせ（Issue #330）の unit テスト。
//
// **実 API は呼ばない。** Jev は偽物の `fetch`、LLM は偽物の `LlmClient` で閉じる。固定したいのは 4 つ。
//   1. Jev の adapter が失敗したら、LLM の adapter で答え直す（§4）
//   2. どちらが答えたかを、結果（`answeredBy`）に残す（§4）
//   3. 合成した口（Jev → Luna）は、落とし先（Luna）の口を `fallback` に載せる（Issue #432）
//   4. 合成の口は要求の門を変えずに渡し、門の拒否では落とし先へ切り替えない（Issue #469）
import { describe, expect, it } from "vitest";
import { createCallGate, type CallGate } from "./call.js";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "./llm.js";
import { createFallbackJudge, type Judge, type JudgeRequest } from "./judge.js";
import { JevAdapterError, createJevJudge, type JevFetch } from "./judge-jev.js";
import { createLlmJudge } from "./judge-llm.js";

const REQUEST: JudgeRequest = {
  state: { note: "決まっていないことを挙げている" },
  questions: {
    kind: { kind: "choice", instructions: "What kind of note is it?", criteria: { a: "one", b: "another" } },
    open: { kind: "noul", instructions: "Does it name an undecided choice?" },
  },
};

const LLM_OUTPUT = { answers: { kind: { choice: "a" }, open: { noul: 0.8 } } };

/** 常に同じ応答を返す fetch（Jev を失敗させる用） */
function fetchReturning(status: number, payload: unknown = { error: "x" }): JevFetch {
  return async () =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 決めた応答を返す偽物の LlmClient */
function fixedLlmClient(output: unknown): LlmClient {
  return {
    async callStructured<T>(_request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
      return { output: output as T, usage: undefined };
    },
    async callWithTools(): Promise<LlmToolResponse> {
      throw new Error("道具付きの呼び出しは使わない");
    },
  };
}

/** 常に失敗する偽物の LlmClient */
function failingLlmClient(): LlmClient {
  return {
    async callStructured<T>(): Promise<LlmStructuredResponse<T>> {
      throw new Error("LLM も失敗した");
    },
    async callWithTools(): Promise<LlmToolResponse> {
      throw new Error("道具付きの呼び出しは使わない");
    },
  };
}

/** Jev を失敗させる（再試行しない種類。待たない） */
const failingJev = (status: number) =>
  createJevJudge({ apiKey: "k", fetch: fetchReturning(status), maxAttempts: 1, sleep: async () => {} });

const llmJudge = (client: LlmClient) => createLlmJudge({ client, model: "gpt-test" });

describe("落とす組み合わせ（05 §4）", () => {
  it("Jev が 429 で失敗したら、LLM の adapter で答え、どちらが答えたかが残る", async () => {
    const judge = createFallbackJudge({ primary: failingJev(429), fallback: llmJudge(fixedLlmClient(LLM_OUTPUT)) });

    const result = await judge.judge(REQUEST);

    expect(result.answeredBy).toBe("llm");
    expect(result.model).toBe("gpt-test");
    expect(result.answers.kind).toEqual({
      kind: "choice",
      choice: "a",
      probabilities: undefined,
      probability: undefined,
      confidence: undefined,
    });
    expect(result.answers.open).toEqual({ kind: "noul", noul: 0.8 });
  });

  it("Jev が 401 で失敗したときも、LLM の adapter で答え直す", async () => {
    const judge = createFallbackJudge({ primary: failingJev(401), fallback: llmJudge(fixedLlmClient(LLM_OUTPUT)) });
    const result = await judge.judge(REQUEST);
    expect(result.answeredBy).toBe("llm");
  });

  it("Jev が答えられたら、そちらの答えを使い、どちらが答えたかが残る", async () => {
    const jev = createJevJudge({
      apiKey: "k",
      fetch: fetchReturning(200, {
        model: "jev-1.13.0",
        usage: { input_tokens: 10 },
        answers: { kind: { choice: "b", confidence: 0.9 }, open: { noul: 0.1 } },
      }),
    });
    const judge = createFallbackJudge({ primary: jev, fallback: llmJudge(failingLlmClient()) });

    const result = await judge.judge(REQUEST);

    expect(result.answeredBy).toBe("jev");
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.kind).toEqual({
      kind: "choice",
      choice: "b",
      probabilities: undefined,
      probability: undefined,
      confidence: 0.9,
    });
  });

  it("両方失敗したら、あとの誤りを投げる", async () => {
    const judge = createFallbackJudge({ primary: failingJev(429), fallback: llmJudge(failingLlmClient()) });
    await expect(judge.judge(REQUEST)).rejects.toThrow("LLM も失敗した");
  });
});

describe("落とし先（Luna）の口を載せる（Issue #432）", () => {
  it("合成した口は、落とし先を fallback に載せる（再点検を Luna の別の会話で行えるように）", () => {
    const fallback = llmJudge(fixedLlmClient(LLM_OUTPUT));
    const judge = createFallbackJudge({ primary: failingJev(429), fallback });
    // 同じ口をもう一度呼ぶと主（Jev）が答え直すだけなので、落とし先を明示的に選べるようにしてある
    expect(judge.fallback).toBe(fallback);
    // 主も載せる——包みは主と落とし先を別々に包み直し、切り替えの 2 回を実試行として数える（Issue #432）
    expect(judge.primary).toBeDefined();
  });

  it("LLM だけの口には、落とし先が無い（その口自身が Luna）", () => {
    expect(llmJudge(fixedLlmClient(LLM_OUTPUT)).fallback).toBeUndefined();
  });
});

// ── 合成の口は、要求の門を変えずに渡し、門の拒否では切り替えない（Issue #469）──────────

describe("合成の口と共有の門（05 §4・Issue #469）", () => {
  const gate = createCallGate({ now: () => 0, deadline: 1_000, limit: 10 });

  it("主と落とし先が、要求の門をそのまま（同じ参照で）受け取る", async () => {
    const seen: (CallGate | undefined)[] = [];
    const primary: Judge = {
      async judge(request): Promise<never> {
        seen.push(request.gate);
        throw new Error("Jev が止まった");
      },
    };
    const fallback: Judge = {
      async judge(request) {
        seen.push(request.gate);
        return { answers: {}, inputTokens: 0, model: "gpt-test", answeredBy: "llm" };
      },
    };
    const judge = createFallbackJudge({ primary, fallback });

    const result = await judge.judge({ ...REQUEST, gate });

    expect(result.answeredBy).toBe("llm");
    expect(seen).toEqual([gate, gate]);
    expect(seen[0]).toBe(gate);
    expect(seen[1]).toBe(gate);
  });

  it("主が門の拒否を投げたら、落とし先へ切り替えず、そのまま投げる", async () => {
    let fallbackCalls = 0;
    const primary: Judge = {
      async judge(): Promise<never> {
        throw new JevAdapterError("gateLimit", "要求の門の上限に達したので再送しません", 429);
      },
    };
    const fallback: Judge = {
      async judge() {
        fallbackCalls += 1;
        return { answers: {}, inputTokens: 0, model: "gpt-test", answeredBy: "llm" };
      },
    };
    const judge = createFallbackJudge({ primary, fallback });

    await expect(judge.judge({ ...REQUEST, gate })).rejects.toMatchObject({ kind: "gateLimit" });
    expect(fallbackCalls).toBe(0);
  });

  it("門の拒否でなければ、今までどおり落とし先で答え直す", async () => {
    let fallbackCalls = 0;
    const primary: Judge = {
      async judge(): Promise<never> {
        throw new JevAdapterError("unavailable", "Jev が混み合っています", 429);
      },
    };
    const fallback: Judge = {
      async judge() {
        fallbackCalls += 1;
        return { answers: {}, inputTokens: 0, model: "gpt-test", answeredBy: "llm" };
      },
    };
    const judge = createFallbackJudge({ primary, fallback });

    const result = await judge.judge({ ...REQUEST, gate });

    expect(result.answeredBy).toBe("llm");
    expect(fallbackCalls).toBe(1);
  });
});
