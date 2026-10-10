// LLM（構造化出力）の判定の adapter（Issue #330）の unit テスト。
//
// **実 API は呼ばない。** 差し込んだ偽物の `LlmClient` が受け取った要求と、手で書いた応答だけで閉じる。
// ここで固定したいのは 4 つ。
//   1. 問いの map から、答えの JSON Schema を組み立てて送る（§4）
//   2. state と問いを、データとして入力に送る（§2.2）
//   3. 確率は返せないので、choice・score の確率と確信度は「不明」（undefined）にする（§4）
//   4. トークン数とモデルの版の ID を結果に残す（§1）
import { describe, expect, it } from "vitest";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse, LlmUsage } from "./llm.js";
import type { JudgeRequest } from "./judge.js";
import {
  DEFAULT_LLM_JUDGE_INSTRUCTIONS,
  DEFAULT_LLM_JUDGE_MAX_OUTPUT_TOKENS,
  LlmJudgeError,
  createLlmJudge,
} from "./judge-llm.js";

/** 要求を記録し、用意した応答を返す偽物の LlmClient */
function recordingClient(
  output: unknown,
  usage: LlmUsage | undefined,
): { readonly client: LlmClient; readonly captured: LlmStructuredRequest[] } {
  const captured: LlmStructuredRequest[] = [];
  const client: LlmClient = {
    async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
      captured.push(request);
      return { output: output as T, usage };
    },
    async callWithTools(): Promise<LlmToolResponse> {
      throw new Error("道具付きの呼び出しは使わない");
    },
  };
  return { client, captured };
}

const USAGE: LlmUsage = {
  inputTokens: 321,
  cachedInputTokens: 0,
  outputTokens: 20,
  reasoningTokens: 0,
};

const REQUEST: JudgeRequest = {
  state: { note: "決まっていないことを挙げている" },
  questions: {
    kind: { kind: "choice", instructions: "What kind of note is it?", criteria: { a: "one", b: "another" } },
    rank: { kind: "score", instructions: "How strong is it?", criteria: { low: "weak", high: "strong" } },
    open: { kind: "noul", instructions: "Does it name an undecided choice?" },
  },
};

const OUTPUT = {
  answers: {
    kind: { choice: "a" },
    rank: { score: "high" },
    open: { noul: 0.8 },
  },
};

interface AnswersSchema {
  readonly properties: {
    readonly answers: {
      readonly required: readonly string[];
      readonly additionalProperties: boolean;
      readonly properties: Readonly<Record<string, Record<string, unknown>>>;
    };
  };
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
}

describe("要求の組み立て（05 §2.2・§4）", () => {
  it("問いの名前ごとに答えの欄を持つ JSON Schema を、strict の構造化出力で送る", async () => {
    const { client, captured } = recordingClient(OUTPUT, undefined);
    await createLlmJudge({ client, model: "gpt-test" }).judge(REQUEST);

    const request = captured[0];
    expect(request?.schemaName).toBe("judge-answers");
    expect(request?.maxOutputTokens).toBe(DEFAULT_LLM_JUDGE_MAX_OUTPUT_TOKENS);
    expect(request?.instructions).toBe(DEFAULT_LLM_JUDGE_INSTRUCTIONS);
    const schema = request?.schema as AnswersSchema;
    expect(schema.required).toEqual(["answers"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.answers.required).toEqual(["kind", "rank", "open"]);
    expect(schema.properties.answers.additionalProperties).toBe(false);
    expect(schema.properties.answers.properties.kind).toMatchObject({
      type: "object",
      required: ["choice"],
      properties: { choice: { type: "string", enum: ["a", "b"] } },
    });
    expect(schema.properties.answers.properties.rank).toMatchObject({
      properties: { score: { type: "string", enum: ["low", "high"] } },
    });
    expect(schema.properties.answers.properties.open).toMatchObject({
      properties: { noul: { type: "number", minimum: 0, maximum: 1 } },
    });
  });

  it("state と問いを、データとして入力に送る（規則ではない）", async () => {
    const { client, captured } = recordingClient(OUTPUT, undefined);
    await createLlmJudge({ client, model: "gpt-test", documents: ["文書"] }).judge(REQUEST);

    const request = captured[0];
    expect(request?.documents).toEqual(["文書"]);
    expect(JSON.parse(String(request?.input))).toEqual({ state: REQUEST.state, questions: REQUEST.questions });
  });
});

describe("応答の解釈（05 §1・§4）", () => {
  it("確率は返せないので、choice・score の確率と確信度を「不明」にし、noul は 0〜1 の値にする", async () => {
    const { client } = recordingClient(OUTPUT, USAGE);
    const result = await createLlmJudge({ client, model: "gpt-test" }).judge(REQUEST);

    expect(result.answeredBy).toBe("llm");
    expect(result.model).toBe("gpt-test");
    expect(result.inputTokens).toBe(321);
    expect(result.answers.kind).toEqual({ kind: "choice", choice: "a", probability: undefined, confidence: undefined });
    expect(result.answers.rank).toEqual({ kind: "score", score: "high", probability: undefined, confidence: undefined });
    expect(result.answers.open).toEqual({ kind: "noul", noul: 0.8 });
  });

  it("usage が無ければ、トークン数は 0 にする", async () => {
    const { client } = recordingClient(OUTPUT, undefined);
    const result = await createLlmJudge({ client, model: "gpt-test" }).judge(REQUEST);
    expect(result.inputTokens).toBe(0);
  });

  it("答えが欠けた応答は malformed にして、成功にしない", async () => {
    const { client } = recordingClient({ answers: { kind: { choice: "a" } } }, undefined);
    await expect(createLlmJudge({ client, model: "gpt-test" }).judge(REQUEST)).rejects.toBeInstanceOf(LlmJudgeError);
  });

  it("noul が 0〜1 の数でなければ、malformed にして、成功にしない", async () => {
    const { client } = recordingClient({ answers: { ...OUTPUT.answers, open: { noul: 2 } } }, undefined);
    await expect(createLlmJudge({ client, model: "gpt-test" }).judge(REQUEST)).rejects.toBeInstanceOf(LlmJudgeError);
  });
});
