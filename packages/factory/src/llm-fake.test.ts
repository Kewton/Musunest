// 偽物の LlmClient（02 §2.1）の unit テスト。Issue #282 の受入条件のうち、偽物に閉じる分。
//
// ここで固定したいのは 4 つ。
//   1. 道具の呼び出し → 結果の返信 → 次のターン → 宣言の確定、の往復を**再生**できる（R-2）
//   2. 記録と違う順の要求（履歴の長さ・返信先の識別子）は誤りにする
//   3. 記録した応答と usage を順に返し、尽きたら誤りになる（実 API を呼ばない）
//   4. 記録の行数は上限（`recordRows`）を超えられない（§1.5）
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "./limits.js";
import type { LlmStructuredRequest, LlmToolRequest, LlmTurn, LlmUsage } from "./llm.js";
import {
  FakeLlmExhaustedError,
  FakeLlmOrderError,
  createFakeLlmClient,
  type RecordedCall,
} from "./llm-fake.js";

const STRUCTURED_REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  input: "依頼文",
  schemaName: "requirement-list",
  schema: { type: "object" },
  maxOutputTokens: 100,
};

const TOOL_REQUEST: LlmToolRequest = {
  instructions: "規則",
  documents: ["文書"],
  input: "宣言",
  tools: [{ name: "staticCheck", description: "静的チェックを流す", parameters: { type: "object" } }],
  turns: [],
  maxOutputTokens: 100,
};

const USAGE_A: LlmUsage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 1 };
const USAGE_B: LlmUsage = { inputTokens: 3, cachedInputTokens: 1, outputTokens: 4, reasoningTokens: 0 };

/** 助手の呼び出しと、その結果の返信（こちらで組み立てて毎回送る履歴。§2） */
const replyTurns = (toolCalls: readonly { id: string; name: string }[]): readonly LlmTurn[] => [
  { role: "assistant", toolCalls: toolCalls.map((call) => ({ ...call, arguments: {} })) },
  {
    role: "tool",
    results: toolCalls.map((call) => ({ toolCallId: call.id, name: call.name, output: { ok: true } })),
  },
];

describe("偽物の LlmClient（02 §2.1・R-2）", () => {
  it("道具の呼び出し → 結果の返信 → 次のターン → 宣言の確定、の往復を再生する", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: {
          kind: "toolCalls",
          toolCalls: [{ id: "call-1", name: "staticCheck", arguments: {} }],
          usage: USAGE_A,
        },
      },
      { kind: "tools", response: { kind: "done", declaration: { entity: "item" }, usage: USAGE_B } },
    ]);

    const first = await client.callWithTools(TOOL_REQUEST);
    expect(first.kind).toBe("toolCalls");
    if (first.kind !== "toolCalls") return;
    expect(first.toolCalls).toEqual([{ id: "call-1", name: "staticCheck", arguments: {} }]);
    expect(first.usage).toBe(USAGE_A);

    const second = await client.callWithTools({
      ...TOOL_REQUEST,
      turns: replyTurns([{ id: "call-1", name: "staticCheck" }]),
    });
    expect(second.kind).toBe("done");
    if (second.kind !== "done") return;
    expect(second.declaration).toEqual({ entity: "item" });
    expect(second.usage).toBe(USAGE_B);
  });

  it("結果を返さずに次のターンを送ると、順が違うので誤りにする", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: { kind: "toolCalls", toolCalls: [{ id: "call-1", name: "t", arguments: {} }], usage: undefined },
      },
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await client.callWithTools(TOOL_REQUEST);
    // 履歴は 2 項目のはずが、記録のままの 0 項目で来た
    await expect(client.callWithTools(TOOL_REQUEST)).rejects.toBeInstanceOf(FakeLlmOrderError);
  });

  it("助手の呼び出しと道具の結果の順を入れ替えると誤りにする", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: { kind: "toolCalls", toolCalls: [{ id: "call-1", name: "t", arguments: {} }], usage: undefined },
      },
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await client.callWithTools(TOOL_REQUEST);
    const [assistant, tool] = replyTurns([{ id: "call-1", name: "t" }]);
    if (assistant === undefined || tool === undefined) throw new Error("前提が壊れた");
    await expect(
      client.callWithTools({ ...TOOL_REQUEST, turns: [tool, assistant] }),
    ).rejects.toBeInstanceOf(FakeLlmOrderError);
  });

  it("直近の呼び出しと違う識別子で結果を返すと誤りにする", async () => {
    const client = createFakeLlmClient([
      {
        kind: "tools",
        response: { kind: "toolCalls", toolCalls: [{ id: "call-1", name: "t", arguments: {} }], usage: undefined },
      },
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await client.callWithTools(TOOL_REQUEST);
    await expect(
      client.callWithTools({ ...TOOL_REQUEST, turns: replyTurns([{ id: "call-9", name: "t" }]) }),
    ).rejects.toBeInstanceOf(FakeLlmOrderError);
  });

  it("記録した構造化出力と usage を順に返す", async () => {
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
    const client = createFakeLlmClient([
      { kind: "tools", response: { kind: "done", declaration: {}, usage: undefined } },
    ]);
    await expect(client.callStructured(STRUCTURED_REQUEST)).rejects.toBeInstanceOf(FakeLlmOrderError);
  });

  it("記録の行数が上限を超えたら断る", () => {
    const tooMany: RecordedCall[] = Array.from({ length: AGENT_LIMITS.recordRows + 1 }, () => ({
      kind: "structured" as const,
      output: null,
      usage: undefined,
    }));
    expect(() => createFakeLlmClient(tooMany)).toThrow(RangeError);
  });
});
