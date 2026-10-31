// OpenRouter（Responses API 互換・提供元を固定）の adapter（Issue #788）の unit テスト。
//
// 実 API は呼ばない。**差し込んだ `fetch` が受け取った要求**と、**手で書いた応答**だけで閉じる。
// ここで固定したいのは 7 つ。
//   1. 宛先は `https://openrouter.ai/api/v1/responses`、`Authorization` は渡した鍵、既定のモデルは
//      `z-ai/glm-5.3-flash`（`model` で上書きできる）
//   2. body は OpenAI と同じで、**最後に `provider` が 1 つ増えるだけ**（構造化・schema 付きの道具・
//      `finalAnswerOnly`・schema の無い道具だけ）。schema の塊は足さない（OpenAI と同じ）
//   2'. 共有の body は比較元の固定値とバイト列で同じ（`provider` を除いて）
//   3. 応答の解釈は OpenAI と同じ（封筒の `result` の取り出し、形の誤り）。**囲みは読まない**（今のとおり malformed）
//   4. usage は OpenAI と同じ読み方で、OpenRouter 独自の欄（`cost`・`is_byok`・`cost_details`）は読まずに捨てる
//   5. 誤りの分類（404・429・残高切れ・5xx・timeout・未完了）は OpenAI と同じ
//   6. adapter の source が環境変数を読まない（鍵は入口から渡す）
import { describe, expect, it } from "vitest";
import type { LlmStructuredRequest, LlmToolRequest } from "./llm.js";
import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_PROVIDER_ROUTING,
  OPENROUTER_RESPONSES_URL,
  createOpenRouterLlmClient,
  type OpenRouterAdapterOptions,
} from "./openrouter.js";
import { OpenAiAdapterError, OpenAiIncompleteError, createOpenAiLlmClient, type FetchLike } from "./openai.js";
import { REVERSE_CHECK_SCHEMA, REVERSE_CHECK_SCHEMA_NAME } from "./stages/reverse-check.js";
import {
  SHARED_BODY_MODEL,
  SHARED_STRUCTURED_BODY_JSON,
  SHARED_STRUCTURED_REQUEST,
  SHARED_TOOL_BODY_JSON,
  SHARED_TOOL_REQUEST,
  withoutProvider,
} from "./__tests__/openai.js";

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** 差し込んだ fetch が受け取った要求を記録し、用意した応答を返す */
function recordingFetch(
  reply: (call: number) => Response | Promise<Response>,
): { readonly fetch: FetchLike; readonly captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    captured.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return reply(captured.length);
  };
  return { fetch: fetchImpl, captured };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function completed(output: readonly unknown[], usage?: unknown): Record<string, unknown> {
  const response: Record<string, unknown> = { id: "resp_1", status: "completed", output };
  if (usage !== undefined) response.usage = usage;
  return response;
}

function outputText(text: string): readonly unknown[] {
  return [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }];
}

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
  rules: [],
  input: "依頼文",
  schemaName: "out",
  schema: SCHEMA,
  maxOutputTokens: 128,
};

const TOOL_REQUEST: LlmToolRequest = {
  instructions: "規則",
  documents: ["文書"],
  rules: [],
  input: "宣言",
  tools: [{ name: "staticCheck", description: "静的チェックを流す", parameters: { type: "object" } }],
  turns: [],
  maxOutputTokens: 128,
};

const openrouterClient = (fetch: FetchLike, extra: Partial<OpenRouterAdapterOptions> = {}) =>
  createOpenRouterLlmClient({ apiKey: "or-FAKE", fetch, ...extra });

/** 1 つの要求について、OpenRouter と OpenAI の body を作る（同じモデルで比べる） */
async function bodiesOf(
  run: (client: ReturnType<typeof createOpenRouterLlmClient> | ReturnType<typeof createOpenAiLlmClient>) => Promise<unknown>,
  extra: Partial<OpenRouterAdapterOptions> = {},
): Promise<{ readonly openrouter: Record<string, unknown>; readonly openai: Record<string, unknown> }> {
  const reply = () => jsonResponse(completed(outputText(JSON.stringify({ items: [] }))));
  const o = recordingFetch(reply);
  const p = recordingFetch(reply);
  await run(createOpenRouterLlmClient({ apiKey: "or-FAKE", model: "same-model", fetch: o.fetch, ...extra })).catch(() => {});
  await run(createOpenAiLlmClient({ apiKey: "sk-FAKE", model: "same-model", fetch: p.fetch, ...extra })).catch(() => {});
  return { openrouter: o.captured[0]!.body, openai: p.captured[0]!.body };
}

// ── 1. 宛先・鍵・モデル ──────────────────────────────────────────────

describe("宛先・鍵・既定のモデル（Issue #788）", () => {
  it("宛先は https://openrouter.ai/api/v1/responses、Authorization は渡した鍵、既定のモデルは z-ai/glm-5.3-flash", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [1] })))));
    const response = await openrouterClient(fetch).callStructured<{ items: number[] }>(STRUCTURED_REQUEST);
    expect(response.output).toEqual({ items: [1] });

    const call = captured[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/responses");
    expect(call.url).toBe(OPENROUTER_RESPONSES_URL);
    expect(call.headers["authorization"]).toBe("Bearer or-FAKE");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body["model"]).toBe("z-ai/glm-5.3-flash");
    expect(call.body["model"]).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("model・effort を渡すと、その値で送る", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [] })))));
    await openrouterClient(fetch, { model: "z-ai/glm-5.3-flash:free", effort: "low" }).callStructured(STRUCTURED_REQUEST);
    expect(captured[0]!.body["model"]).toBe("z-ai/glm-5.3-flash:free");
    expect(captured[0]!.body["reasoning"]).toEqual({ effort: "low" });
  });

  it("提供元を固定する指定は open-inference だけを許し、落とし先を許さない（Issue #788）", () => {
    expect(OPENROUTER_PROVIDER_ROUTING).toEqual({ only: ["open-inference"], require_parameters: true, allow_fallbacks: false });
  });
});

// ── 2. body は OpenAI と同じで、最後に provider が 1 つ増えるだけ ──────

/**
 * OpenRouter の生の送信 body（偽物の fetch が受けた body）が、提供元の固定値 `provider` を**末尾に 1 つだけ**
 * 持つことを確かめる（Issue #788 レビュー R3）。`withoutProvider()` した body だけを比べると、道具付きの要求で
 * 追加欄が消えても気づけないため、全要求形態で存在・内容・末尾の位置を直接見る。
 */
function expectProviderRoutingAtEnd(body: Record<string, unknown>): void {
  expect(Object.keys(body).filter((key) => key === "provider"), "provider がちょうど 1 つではない").toHaveLength(1);
  expect(Object.keys(body).at(-1), "provider が末尾ではない").toBe("provider");
  expect(body["provider"]).toEqual(OPENROUTER_PROVIDER_ROUTING);
  // 固定の値（提供元を open-inference に限り、落とし先を許さない）
  expect(body["provider"]).toEqual({ only: ["open-inference"], require_parameters: true, allow_fallbacks: false });
}

describe("body は OpenAI と同じで、最後に provider が 1 つ増えるだけ（Issue #788）", () => {
  it("構造化出力：provider を末尾に 1 つ持ち、input ほかは OpenAI と同じ（schema の塊を足さない）", async () => {
    const { openrouter, openai } = await bodiesOf((client) => client.callStructured(STRUCTURED_REQUEST));
    expectProviderRoutingAtEnd(openrouter);
    expect(withoutProvider(openrouter)).toEqual(openai);
    // schema の塊は足さない（OpenAI と同じ）
    expect(JSON.stringify(openrouter["input"])).not.toContain("次の JSON Schema に合う JSON だけを返す。");
  });

  it("schema 付きの道具（通常の往復）：provider を末尾に 1 つ持ち、除けば OpenAI と同じ（tool_choice を送らない）", async () => {
    const request: LlmToolRequest = { ...TOOL_REQUEST, schemaName: "answer", schema: SCHEMA };
    const { openrouter, openai } = await bodiesOf((client) => client.callWithTools(request));
    expectProviderRoutingAtEnd(openrouter);
    expect(openrouter["tool_choice"]).toBeUndefined();
    expect(withoutProvider(openrouter)).toEqual(openai);
  });

  it("schema 付きの道具（finalAnswerOnly）：provider を末尾に 1 つ持ち、除けば OpenAI と同じ（道具の定義と tool_choice: none を送る）", async () => {
    const request: LlmToolRequest = { ...TOOL_REQUEST, schemaName: "answer", schema: SCHEMA, finalAnswerOnly: true };
    const { openrouter, openai } = await bodiesOf((client) => client.callWithTools(request));
    expectProviderRoutingAtEnd(openrouter);
    expect(openrouter["tool_choice"]).toBe("none");
    expect(openrouter["tools"] as readonly unknown[]).toHaveLength(1);
    expect(withoutProvider(openrouter)).toEqual(openai);
  });

  it("schema の無い道具だけの要求：provider を末尾に 1 つ持ち、除けば OpenAI と同じ", async () => {
    const { openrouter, openai } = await bodiesOf((client) => client.callWithTools(TOOL_REQUEST));
    expectProviderRoutingAtEnd(openrouter);
    expect(openrouter["text"]).toBeUndefined();
    expect(withoutProvider(openrouter)).toEqual(openai);
  });

  it("封筒の段の構造化出力でも、provider を末尾に 1 つ持ち、除けば OpenAI と同じ", async () => {
    const request: LlmStructuredRequest = {
      ...STRUCTURED_REQUEST,
      schemaName: REVERSE_CHECK_SCHEMA_NAME,
      schema: REVERSE_CHECK_SCHEMA,
    };
    const { openrouter, openai } = await bodiesOf((client) => client.callStructured(request));
    expectProviderRoutingAtEnd(openrouter);
    expect(withoutProvider(openrouter)).toEqual(openai);
  });
});

// ── 2'. 共有の body は比較元の固定値とバイト列で同じ ────────────────

describe("共有の body は比較元の固定値とバイト列で同じ（provider を除いて。Issue #788）", () => {
  it("構造化出力と道具付きの body が、比較元の固定値と一致する（provider は末尾に 1 つ。欄の並び・text・tools まで）", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [] })))));
    const client = openrouterClient(fetch, { model: SHARED_BODY_MODEL });
    await client.callStructured(SHARED_STRUCTURED_REQUEST);
    expectProviderRoutingAtEnd(captured[0]!.body);
    expect(JSON.stringify(withoutProvider(captured[0]!.body))).toBe(SHARED_STRUCTURED_BODY_JSON);
    await client.callWithTools(SHARED_TOOL_REQUEST);
    expectProviderRoutingAtEnd(captured[1]!.body);
    expect(JSON.stringify(withoutProvider(captured[1]!.body))).toBe(SHARED_TOOL_BODY_JSON);
  });
});

// ── 3. 応答の解釈（OpenAI と同じ） ──────────────────────────────────

describe("応答の解釈は OpenAI と同じ（Issue #788）", () => {
  const envelopeRequest: LlmStructuredRequest = {
    instructions: "規則",
    documents: ["文書"],
    rules: [],
    input: "依頼文",
    schemaName: REVERSE_CHECK_SCHEMA_NAME,
    schema: REVERSE_CHECK_SCHEMA,
    maxOutputTokens: 128,
  };

  it("封筒の段で result 付きの正しい応答は取り出せる（stage を落として段へ渡す）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: REVERSE_CHECK_SCHEMA_NAME, uncovered: [] } })))),
    );
    const response = await openrouterClient(fetch).callStructured(envelopeRequest);
    expect(response.output).toEqual({ uncovered: [] });
  });

  it("schema に合わない応答は malformed（strict の schema が縛ることを理由に検査を緩めない）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: REVERSE_CHECK_SCHEMA_NAME, uncovered: [{ start: 1 }] } })))),
    );
    const error = await captureError(() => openrouterClient(fetch).callStructured(envelopeRequest));
    expect(error.kind).toBe("malformed");
  });

  it("囲みで包んだ本文は今のとおり malformed（OpenRouter は囲みを読まない）", async () => {
    const fenced = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
    const structured = recordingFetch(() => jsonResponse(completed(outputText(fenced({ items: [] })))));
    const structuredError = await captureError(() => openrouterClient(structured.fetch).callStructured(STRUCTURED_REQUEST));
    expect(structuredError.kind).toBe("malformed");
    const tools = recordingFetch(() => jsonResponse(completed(outputText(fenced({ entity: "item" })))));
    const toolsError = await captureError(() => openrouterClient(tools.fetch).callWithTools(TOOL_REQUEST));
    expect(toolsError.kind).toBe("malformed");
  });
});

// ── 4. usage ────────────────────────────────────────────────────────

describe("usage の読み取り（OpenRouter 独自の欄は読まずに捨てる。Issue #788）", () => {
  it("cost・is_byok・cost_details が付いていても、今と同じ usage として読む", async () => {
    const usage = {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
      cost: 0.0123,
      is_byok: false,
      cost_details: { upstream_inference_cost: 0.01 },
    };
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [1] })), usage)),
    );
    const response = await openrouterClient(fetch).callStructured(STRUCTURED_REQUEST);
    expect(response.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 5,
    });
  });

  it("usage が無ければ「usage なし」にする", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [1] })))));
    const response = await openrouterClient(fetch).callStructured(STRUCTURED_REQUEST);
    expect(response.usage).toBeUndefined();
  });
});

// ── 5. 誤りの分類（OpenAI と同じ） ──────────────────────────────────

describe("誤りの分類は OpenAI と同じ（Issue #788）", () => {
  it("HTTP 404（提供元が見つからない）は、状態コード付きの HTTP の誤り", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ error: { code: "not_found" } }, 404));
    const error = await captureError(() => openrouterClient(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(404);
  });

  it("HTTP 429 は、状態コード付きの HTTP の誤り", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ error: { code: "rate_limit" } }, 429));
    const error = await captureError(() => openrouterClient(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(429);
  });

  it("HTTP 5xx は HTTP の誤り", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ error: { code: "server_error" } }, 503));
    const error = await captureError(() => openrouterClient(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(503);
  });

  it("未完了の応答は incomplete（出力が JSON として読めても成功にしない）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: outputText(JSON.stringify({ items: [] })),
      }),
    );
    const error = await captureError(() => openrouterClient(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error).toBeInstanceOf(OpenAiIncompleteError);
    expect(error.kind).toBe("incomplete");
    expect((error as OpenAiIncompleteError).reason).toBe("max_output_tokens");
  });

  it("timeout を分類する（自分の時計で打ち切る）", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const error = await captureError(() => openrouterClient(hanging, { timeoutMs: 5 }).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("timeout");
  });
});

// ── 6. adapter は環境変数を読まない ─────────────────────────────────

describe("adapter は環境変数を読まない（Issue #788）", () => {
  it("openrouter.ts に環境変数の入口と宛先の環境変数が無い", async () => {
    const files = (await import(/* @vite-ignore */ "node:fs")) as {
      readFileSync(path: URL, encoding: "utf8"): string;
    };
    const source = files.readFileSync(new URL("./openrouter.ts", import.meta.url), "utf8");
    for (const token of ["process.env", "OPENROUTER_API_KEY", "cloudflare:workers", "node:fs"]) {
      expect(source.includes(token), token).toBe(false);
    }
    // 宛先は固定（環境変数から読まない）
    expect(source).toContain("https://openrouter.ai/api/v1/responses");
  });
});
