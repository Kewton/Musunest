// 落とす組み合わせ（Issue #330）の unit テスト。
//
// **実 API は呼ばない。** Jev は偽物の `fetch`、LLM は偽物の `LlmClient` で閉じる。固定したいのは 2 つ。
//   1. Jev の adapter が失敗したら、LLM の adapter で答え直す（§4）
//   2. どちらが答えたかを、結果（`answeredBy`）に残す（§4）
import { describe, expect, it } from "vitest";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "./llm.js";
import { createFallbackJudge, type JudgeRequest } from "./judge.js";
import { createJevJudge, type JevFetch } from "./judge-jev.js";
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
    expect(result.answers.kind).toEqual({ kind: "choice", choice: "a", probability: undefined, confidence: undefined });
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
    expect(result.answers.kind).toEqual({ kind: "choice", choice: "b", probability: undefined, confidence: 0.9 });
  });

  it("両方失敗したら、あとの誤りを投げる", async () => {
    const judge = createFallbackJudge({ primary: failingJev(429), fallback: llmJudge(failingLlmClient()) });
    await expect(judge.judge(REQUEST)).rejects.toThrow("LLM も失敗した");
  });
});
