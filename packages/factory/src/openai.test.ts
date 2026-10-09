// OpenAI の Responses API の adapter（Issue #284）の unit テスト。
//
// 実 API は呼ばない。**差し込んだ `fetch` が受け取った要求**と、**手で書いた応答**だけで閉じる。
// ここで固定したいのは 7 つ。
//   1. 要求に `store: false`・`max_output_tokens`・`instructions`・JSON Schema／tools が入る（§2）
//   2. 規則は毎回送り、`previous_response_id` は送らない（会話はこちらで組み立てる。§2）
//   3. 往復（助手の呼び出し・道具の結果）を入力の項目に直して送る（R-2）
//   4. usage を、あり／なし／壊れている、で分類する（§1.5）
//   5. 誤りを型付きで分類する（HTTP・timeout・拒否・未完了・形が合わない・道具の引数）（§2.2）
//   6. 未完了の応答は、出力が JSON として読めても成功にしない（§2.2）
//   7. adapter のソースが環境変数を読まない（§2.1・R-15）
import { describe, expect, it } from "vitest";
import type {
  LlmStructuredRequest,
  LlmToolRequest,
  LlmTurn,
  LlmUsage,
} from "./llm.js";
import {
  OpenAiAdapterError,
  createOpenAiLlmClient,
  type FetchLike,
  type OpenAiErrorKind,
} from "./openai.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

// ── 差し込む fetch と、手で書いた応答 ────────────────────────────────────

interface Captured {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** 差し込んだ fetch が受け取った要求を記録し、用意した応答を返す */
function recordingFetch(
  reply: (call: number) => Response | Promise<Response>,
): { readonly fetch: FetchLike; readonly captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    captured.push({ url, body });
    return reply(captured.length);
  };
  return { fetch: fetchImpl, captured };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(captured: readonly Captured[], index = 0): Record<string, unknown> {
  const call = captured[index];
  if (call === undefined) throw new Error(`要求が記録されていません（index=${index}）`);
  return call.body;
}

/** 完了した応答を手で書く */
function completed(output: readonly unknown[], usage?: unknown): Record<string, unknown> {
  const response: Record<string, unknown> = { id: "resp_1", status: "completed", output };
  if (usage !== undefined) response.usage = usage;
  return response;
}

/** 出力のテキスト（助手のメッセージ）を手で書く */
function outputText(text: string): readonly unknown[] {
  return [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }];
}

/** 型付きの誤りを取り出す（誤りが投げられなければ試験を落とす） */
async function captureError(run: () => Promise<unknown>): Promise<OpenAiAdapterError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OpenAiAdapterError) return error;
    throw new Error(`型付きの誤りではありません: ${String(error)}`, { cause: error });
  }
  throw new Error("誤りが投げられませんでした");
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: { type: "number" } } },
} as const;

const STRUCTURED_REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  input: "依頼文",
  schemaName: "out",
  schema: SCHEMA,
  maxOutputTokens: 128,
};

const TOOL_REQUEST: LlmToolRequest = {
  instructions: "規則",
  documents: ["文書"],
  input: "宣言",
  tools: [{ name: "staticCheck", description: "静的チェックを流す", parameters: { type: "object" } }],
  turns: [],
  maxOutputTokens: 128,
};

const USAGE_WIRE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 120,
};
const USAGE: LlmUsage = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5 };

const clientWith = (fetch: FetchLike, timeoutMs?: number) =>
  createOpenAiLlmClient(timeoutMs === undefined ? { apiKey: "test-key", fetch } : { apiKey: "test-key", fetch, timeoutMs });

/** 応答を返さない fetch（timeout の試験用）。打ち切りの合図で拒否する */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

// ── 1・2・3. 要求の組み立て ────────────────────────────────────────────

describe("要求の組み立て（02 §2・§2.2）", () => {
  it("構造化出力の要求に、store: false・max_output_tokens・instructions・JSON Schema が入る", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [1, 2] })), USAGE_WIRE)),
    );
    const client = clientWith(fetch);

    const response = await client.callStructured<{ items: number[] }>(STRUCTURED_REQUEST);
    expect(response.output).toEqual({ items: [1, 2] });

    const body = bodyOf(captured);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(128);
    expect(body.instructions).toBe("規則");
    expect(body.previous_response_id).toBeUndefined();
    const format = (body.text as { format: { type: string; name: string; schema: unknown } }).format;
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("out");
    expect(format.schema).toEqual(SCHEMA);
  });

  it("モデルの既定は gpt-6-luna で、effort を渡すと reasoning に入る", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    const client = createOpenAiLlmClient({ apiKey: "test-key", effort: "high", fetch });

    await client.callStructured(STRUCTURED_REQUEST);
    const body = bodyOf(captured);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("道具付きの要求に、store: false・max_output_tokens・instructions・tools が入る", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })), USAGE_WIRE)),
    );
    const client = clientWith(fetch);

    const response = await client.callWithTools(TOOL_REQUEST);
    expect(response.kind).toBe("done");

    const body = bodyOf(captured);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(128);
    expect(body.instructions).toBe("規則");
    expect(body.previous_response_id).toBeUndefined();
    const tools = body.tools as readonly unknown[];
    expect(tools[0]).toMatchObject({ type: "function", name: "staticCheck" });
    expect(body.text).toBeUndefined();
  });

  it("往復（助手の呼び出し・道具の結果）を入力の項目に直して送る（R-2）", async () => {
    const turns: readonly LlmTurn[] = [
      { role: "assistant", toolCalls: [{ id: "call-1", name: "staticCheck", arguments: { where: "a" } }] },
      { role: "tool", results: [{ toolCallId: "call-1", name: "staticCheck", output: { ok: true } }] },
    ];
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })), USAGE_WIRE)),
    );
    const client = clientWith(fetch);

    await client.callWithTools({ ...TOOL_REQUEST, turns });
    const input = bodyOf(captured).input as readonly unknown[];
    expect(input).toContainEqual({
      type: "function_call",
      call_id: "call-1",
      name: "staticCheck",
      arguments: JSON.stringify({ where: "a" }),
    });
    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ ok: true }),
    });
  });

  it("2 回続けて呼ぶと、2 回とも instructions を送り、previous_response_id を送らない", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    const client = clientWith(fetch);

    await client.callStructured(STRUCTURED_REQUEST);
    await client.callStructured(STRUCTURED_REQUEST);

    expect(captured).toHaveLength(2);
    for (const call of captured) {
      expect(call.body.instructions).toBe("規則");
      expect(call.body.previous_response_id).toBeUndefined();
    }
  });
});

// ── 4. usage の分類（02 §1.5）──────────────────────────────────────────

describe("usage の分類（02 §1.5・R-6）", () => {
  it("usage があれば、共通の契約の形に直して返す", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [1] })), USAGE_WIRE)),
    );
    const response = await clientWith(fetch).callStructured(STRUCTURED_REQUEST);
    expect(response.usage).toEqual(USAGE);
  });

  it("usage が無ければ「usage なし」にする", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [1] })))));
    const response = await clientWith(fetch).callStructured(STRUCTURED_REQUEST);
    expect(response.output).toEqual({ items: [1] });
    expect(response.usage).toBeUndefined();
  });

  it("壊れた usage（数でない・負・内訳が合計を超える）は「usage なし」にする", async () => {
    const broken: readonly unknown[] = [
      { input_tokens: "100", output_tokens: 20 },
      { input_tokens: -1, output_tokens: 20 },
      { input_tokens: 10.5, output_tokens: 20 },
      { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 200 } },
      { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 200 } },
      { input_tokens: 100, output_tokens: 20, input_tokens_details: "壊れた" },
    ];
    for (const usage of broken) {
      const { fetch } = recordingFetch(() =>
        jsonResponse(completed(outputText(JSON.stringify({ items: [1] })), usage)),
      );
      const response = await clientWith(fetch).callStructured(STRUCTURED_REQUEST);
      expect(response.output).toEqual({ items: [1] });
      expect(response.usage).toBeUndefined();
    }
  });
});

// ── 5・6. 誤りの分類（02 §2.2）────────────────────────────────────────

describe("誤りの分類（02 §2.2）", () => {
  async function errorKindOf(reply: () => Response | Promise<Response>): Promise<OpenAiAdapterError> {
    const { fetch } = recordingFetch(reply);
    return captureError(() => clientWith(fetch).callStructured(STRUCTURED_REQUEST));
  }

  it("HTTP 429 は、状態コード付きの HTTP の誤りにする", async () => {
    const error = await errorKindOf(() =>
      jsonResponse({ error: { message: "rate limit", type: "rate_limit_error" } }, 429),
    );
    expect(error.kind).toBe("http");
    expect(error.status).toBe(429);
  });

  it("残高切れ（insufficient_quota）は、HTTP と分けて分類する", async () => {
    const error = await errorKindOf(() =>
      jsonResponse({ error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" } }, 429),
    );
    expect(error.kind).toBe("balance");
    expect(error.status).toBe(429);
  });

  it("拒否（refusal）を分類する", async () => {
    const error = await errorKindOf(() =>
      jsonResponse(completed([{ type: "message", content: [{ type: "refusal", refusal: "できません" }] }])),
    );
    expect(error.kind).toBe("refusal");
  });

  it("未完了の応答を分類する", async () => {
    const error = await errorKindOf(() =>
      jsonResponse({
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: outputText(JSON.stringify({ items: [1, 2] })),
      }),
    );
    expect(error.kind).toBe("incomplete");
  });

  it("未完了の応答は、出力が JSON として読めても成功にしない", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: outputText(JSON.stringify({ items: [1, 2] })),
      }),
    );
    const error = await captureError(() => clientWith(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("incomplete");
  });

  it("schema に合わない応答を分類する", async () => {
    const error = await errorKindOf(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: ["文字列"] })), USAGE_WIRE)),
    );
    expect(error.kind).toBe("malformed");
  });

  it("本文が JSON として読めない応答を分類する", async () => {
    const error = await errorKindOf(() => new Response("これは JSON ではない", { status: 200 }));
    expect(error.kind).toBe("malformed");
  });

  it("出力の本文が JSON として読めない応答を分類する", async () => {
    const error = await errorKindOf(() => jsonResponse(completed(outputText("これは JSON ではない"))));
    expect(error.kind).toBe("malformed");
  });

  it("道具の引数が JSON として読めない応答を分類する", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed([
          { type: "function_call", call_id: "call-1", name: "staticCheck", arguments: "これは JSON ではない" },
        ]),
      ),
    );
    const error = await captureError(() => clientWith(fetch).callWithTools(TOOL_REQUEST));
    expect(error.kind).toBe("toolArguments");
  });

  it("timeout を分類する", async () => {
    const error = await captureError(() => clientWith(hangingFetch, 5).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("timeout");
  });

  it("道具の呼び出しを返す応答は toolCalls にする", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed([
          {
            type: "function_call",
            call_id: "call-9",
            name: "runTests",
            arguments: JSON.stringify({ suite: "a" }),
            status: "completed",
          },
        ]),
      ),
    );
    const response = await clientWith(fetch).callWithTools(TOOL_REQUEST);
    expect(response.kind).toBe("toolCalls");
    if (response.kind !== "toolCalls") return;
    expect(response.toolCalls).toEqual([{ id: "call-9", name: "runTests", arguments: { suite: "a" } }]);
  });

  it("分類は互いに区別できる（kind の取り違えが無い）", async () => {
    const kinds: Readonly<Record<string, OpenAiErrorKind>> = {
      http: (await errorKindOf(() => jsonResponse({ error: {} }, 429))).kind,
      malformed: (await errorKindOf(() => jsonResponse(completed(outputText("{}"))))).kind,
      refusal: (await errorKindOf(() =>
        jsonResponse(completed([{ type: "message", content: [{ type: "refusal", refusal: "no" }] }])),
      )).kind,
    };
    expect(kinds.http).toBe("http");
    expect(kinds.malformed).toBe("malformed");
    expect(kinds.refusal).toBe("refusal");
  });
});

// ── 7. 環境変数を読まない（02 §2.1・R-15）────────────────────────────

describe("adapter は環境変数を読まない（02 §2.1・R-15）", () => {
  it("openai.ts に環境変数の入口が無い", () => {
    const source = fs.readFileSync(new URL("./openai.ts", import.meta.url), "utf8");
    const forbidden = ["process.env", "process[", "import.meta.env", "Deno.env", "globalThis.process", "OPENAI_API_KEY"];
    for (const token of forbidden) {
      expect(source.includes(token), `openai.ts に ${token} がある`).toBe(false);
    }
  });
});
