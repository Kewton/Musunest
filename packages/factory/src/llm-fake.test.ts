// 偽物の LlmClient（02 §2.1）の unit テスト。Issue #278 の受入条件のうち、偽物に閉じる分。
//
// ここで固定したいのは 2 つ。
//   1. 記録した応答と usage を**順に**返す
//   2. 記録が尽きたら誤りになる（実 API を呼ばないので、尽きたことを明示的に観測できる）
import { describe, expect, it } from "vitest";
import type { LlmStructuredRequest, LlmToolRequest, LlmUsage } from "./llm.js";
import { FakeLlmExhaustedError, createFakeLlmClient, type RecordedCall } from "./llm-fake.js";

const STRUCTURED_REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  input: "依頼文",
  schemaName: "requirement-list",
  schema: { type: "object" },
  maxOutputTokens: 100,
};

const TOOL_REQUEST: LlmToolRequest = {
  instructions: "規則",
  input: "宣言",
  tools: [{ name: "staticCheck", description: "静的チェックを流す", parameters: { type: "object" } }],
  maxOutputTokens: 100,
};

const USAGE_A: LlmUsage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 1 };
const USAGE_B: LlmUsage = { inputTokens: 3, cachedInputTokens: 1, outputTokens: 4, reasoningTokens: 0 };

describe("偽物の LlmClient（02 §2.1）", () => {
  it("記録した応答と usage を順に返す", async () => {
    const recorded: readonly RecordedCall[] = [
      { kind: "structured", output: { id: "first" }, usage: USAGE_A },
      { kind: "structured", output: { id: "second" }, usage: USAGE_B },
    ];
    const client = createFakeLlmClient(recorded);

    const first = await client.callStructured<{ id: string }>(STRUCTURED_REQUEST);
    expect(first.output).toEqual({ id: "first" });
    expect(first.usage).toBe(USAGE_A);

    const second = await client.callStructured<{ id: string }>(STRUCTURED_REQUEST);
    expect(second.output).toEqual({ id: "second" });
    expect(second.usage).toBe(USAGE_B);
  });

  it("道具付きの応答も順に返す", async () => {
    const client = createFakeLlmClient([
      { kind: "tools", toolCalls: [{ name: "staticCheck", arguments: { path: "app.spec.yaml" } }], usage: USAGE_A },
    ]);
    const response = await client.callWithTools(TOOL_REQUEST);
    expect(response.toolCalls).toEqual([{ name: "staticCheck", arguments: { path: "app.spec.yaml" } }]);
    expect(response.usage).toBe(USAGE_A);
  });

  it("usage が無い記録は、usage を undefined にする", async () => {
    const client = createFakeLlmClient([{ kind: "structured", output: { ok: true }, usage: undefined }]);
    const response = await client.callStructured<{ ok: boolean }>(STRUCTURED_REQUEST);
    expect(response.output).toEqual({ ok: true });
    expect(response.usage).toBeUndefined();
  });

  it("記録が尽きたら誤りになる", async () => {
    const client = createFakeLlmClient([{ kind: "structured", output: { id: "only" }, usage: USAGE_A }]);
    await client.callStructured(STRUCTURED_REQUEST);
    await expect(client.callStructured(STRUCTURED_REQUEST)).rejects.toBeInstanceOf(FakeLlmExhaustedError);
  });

  it("記録の種別が食い違えば誤りになる", async () => {
    const client = createFakeLlmClient([{ kind: "tools", toolCalls: [], usage: undefined }]);
    await expect(client.callStructured(STRUCTURED_REQUEST)).rejects.toBeInstanceOf(FakeLlmExhaustedError);
  });
});
