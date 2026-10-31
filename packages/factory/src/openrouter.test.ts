// OpenRouter（Responses API 互換・提供元を固定）の adapter（Issue #788・#790）の unit テスト。
//
// 実 API は呼ばない。**差し込んだ `fetch` が受け取った要求**と、**手で書いた応答**だけで閉じる。
// ここで固定したいのは 10 ある。
//   1. 宛先は `https://openrouter.ai/api/v1/responses`、`Authorization` は渡した鍵、既定のモデルは
//      `z-ai/glm-5.3-flash`（`model` で上書きできる）
//   2. body は OpenAI と同じで、**最後に `provider` が 1 つ増えるだけ**（構造化・schema 付きの道具・
//      `finalAnswerOnly`・schema の無い道具だけ）。schema の塊は足さない（OpenAI と同じ）
//   2'. 共有の body は比較元の固定値とバイト列で同じ（`provider` を除いて。封筒の段の `text.format.schema` だけは 7 の形）
//   3. 応答の解釈は OpenAI と同じ（封筒の `result` の取り出し、形の誤り）。**囲みは読まない**（今のとおり malformed）
//   4. usage は OpenAI と同じ読み方で、OpenRouter 独自の欄（`cost`・`is_byok`・`cost_details`）は読まずに捨てる
//   5. 誤りの分類（404・429・残高切れ・5xx・timeout・未完了）は OpenAI と同じ
//   6. adapter の source が環境変数を読まない（鍵は入口から渡す）
//   7. 封筒の段の構造化出力は、`text.format.schema` が**その段の枝 1 つだけ**の封筒（`anyOf` が無い）。OpenAI・Ollama は
//      同じ要求でも全段の `anyOf` のまま（Issue #790）
//   8. 封筒の無い段・道具付きの要求・判定の口の要求は、`stageOnlyEnvelope` の有無で body が同じ（Issue #790）
//   9. 応答：その段の枝の正しい応答は取り出せ、別の段の `stage` は `wrong-stage`、枝に合わない応答は `schema` の malformed（#783 の印も同じ）
//   10. 提供元の指定は `morph/fp8` で body の末尾にあり、単価は fp8 の値である（Issue #790）
import { describe, expect, it } from "vitest";
import type { LlmClient, LlmStructuredRequest, LlmToolRequest } from "./llm.js";
import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_PROVIDER_ROUTING,
  OPENROUTER_RESPONSES_URL,
  createOpenRouterLlmClient,
  type OpenRouterAdapterOptions,
} from "./openrouter.js";
import {
  OpenAiAdapterError,
  OpenAiIncompleteError,
  createOpenAiLlmClient,
  createResponsesLlmClient,
  type FetchLike,
} from "./openai.js";
import { createOllamaLlmClient } from "./ollama.js";
import { REVERSE_CHECK_SCHEMA, REVERSE_CHECK_SCHEMA_NAME } from "./stages/reverse-check.js";
import { SURFACE_DIFF_SCHEMA_NAME } from "./plan/surface.js";
import { SEMANTIC_CHECK_SCHEMA, SEMANTIC_CHECK_SCHEMA_NAME } from "./v11a/stages/semantic-check.js";
import { VOCABULARY_SCHEMA_NAMES, vocabularySchemaOf } from "./v12/stages/vocabulary.js";
import {
  ENVELOPE_SCHEMA,
  ENVELOPE_SCHEMA_NAME,
  ENVELOPE_SCHEMA_NAME_V11A,
  ENVELOPE_SCHEMA_NAME_V12,
  ENVELOPE_SCHEMA_V11A,
  type EnvelopeId,
} from "./schema-envelope.js";
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

  it("提供元を固定する指定は morph/fp8 だけを許し、落とし先を許さない（Issue #788・#790）", () => {
    expect(OPENROUTER_PROVIDER_ROUTING).toEqual({ only: ["morph/fp8"], require_parameters: true, allow_fallbacks: false });
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
  // 固定の値（提供元を fp8 の morph/fp8 に限り、落とし先を許さない。Issue #790）
  expect(body["provider"]).toEqual({ only: ["morph/fp8"], require_parameters: true, allow_fallbacks: false });
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

  it("封筒の段の構造化出力でも、provider を末尾に 1 つ持ち、`text.format.schema` を除けば OpenAI と同じ（#790 で schema だけその段の枝に変わる）", async () => {
    const request: LlmStructuredRequest = {
      ...STRUCTURED_REQUEST,
      schemaName: REVERSE_CHECK_SCHEMA_NAME,
      schema: REVERSE_CHECK_SCHEMA,
    };
    const { openrouter, openai } = await bodiesOf((client) => client.callStructured(request));
    expectProviderRoutingAtEnd(openrouter);
    // `text.format.schema` だけは #790 でその段の枝 1 つに変わる（ほかの欄・ほかの `text.format` の欄は変わらない）
    expect(withoutFormatSchema(withoutProvider(openrouter))).toEqual(withoutFormatSchema(openai));
    expect(formatOf(openai).schema).toEqual(ENVELOPE_SCHEMA);
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

  it("schema に合わない応答は malformed（strict の schema が縛ることを理由に検査を緩めない。#783 の印は schema）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: REVERSE_CHECK_SCHEMA_NAME, uncovered: [{ start: 1 }] } })))),
    );
    const error = await captureError(() => openrouterClient(fetch).callStructured(envelopeRequest));
    expect(error.kind).toBe("malformed");
    expect(error.malformedKind).toBe("schema");
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

// ── 7. 封筒の段は「その段の枝 1 つだけの封筒」を送る（Issue #790）─────────────

/** body の `text.format` を読む */
function formatOf(body: Record<string, unknown>): {
  readonly name: unknown;
  readonly schema: unknown;
  readonly strict: unknown;
} {
  return (body["text"] as { readonly format: { readonly name: unknown; readonly schema: unknown; readonly strict: unknown } }).format;
}

/** body の `text.format.schema.properties.result` を読む */
function resultBranchOf(body: Record<string, unknown>): Record<string, unknown> {
  const schema = formatOf(body).schema as { readonly properties: { readonly result: Record<string, unknown> } };
  return schema.properties.result;
}

/** `text.format.schema` を目印に置き換えた写しを返す（その欄だけを比べない。Issue #790） */
function withoutFormatSchema(body: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const text = copy["text"] as { format: Record<string, unknown> };
  text.format["schema"] = "<schema>";
  return copy;
}

/** 1 つの要求の body を捕まえる（応答の解釈は見ない。誤りは捨てる） */
async function captureBody(
  makeClient: (fetch: FetchLike) => LlmClient,
  run: (client: LlmClient) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ result: {} })))));
  await run(makeClient(fetch)).catch(() => {});
  return captured[0]!.body;
}

/** 期待の枝：`reverse-check`（v1 の封筒。試験の側で独立に書いた固定値） */
const REVERSE_CHECK_BRANCH = {
  type: "object",
  additionalProperties: false,
  required: ["stage", "uncovered"],
  properties: {
    stage: { type: "string", enum: ["reverse-check"], description: "この枝の段（reverse-check）" },
    uncovered: {
      type: "array",
      description: "どの要件にも対応しない原文の部分（文字の範囲）",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end"],
        properties: { start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 } },
      },
    },
  },
};

/** 期待の枝：`semantic-check`（v1.1a・v1.2 の封筒。試験の側で独立に書いた固定値） */
const SEMANTIC_CHECK_BRANCH = {
  type: "object",
  additionalProperties: false,
  required: ["stage", "judgments"],
  properties: {
    stage: { type: "string", enum: ["semantic-check"], description: "この枝の段（semantic-check）" },
    judgments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "verdict", "kind", "quote"],
        properties: {
          requirementId: { type: "string" },
          verdict: { type: "string", enum: ["accept", "reject"] },
          kind: {
            type: ["string", "null"],
            enum: ["unnecessary-ownership", "missing-target", "weak-verification", null],
            description: "拒否の種類（受理は null）",
          },
          quote: { type: ["string", "null"], description: "拒否の根拠の引用（受理は null）" },
        },
      },
    },
  },
};

/** 期待の枝：`vocabulary-entities`（v1.2-ids の封筒。試験の側で独立に書いた固定値） */
const VOCABULARY_ENTITIES_BRANCH = {
  type: "object",
  additionalProperties: false,
  required: ["stage", "entities"],
  properties: {
    stage: { type: "string", enum: ["vocabulary-entities"], description: "この枝の段（vocabulary-entities）" },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role"],
        properties: {
          name: { type: "string", description: "宣言で使う名前" },
          role: { type: "string", description: "役割の説明（1 文）" },
        },
      },
    },
  },
};

describe("封筒の段の構造化出力は、その段の枝 1 つだけの封筒を送る（anyOf を使わない。Issue #790）", () => {
  const cases: readonly {
    readonly label: string;
    readonly envelope: EnvelopeId;
    readonly schemaName: string;
    readonly schema: unknown;
    readonly name: string;
    readonly branch: unknown;
  }[] = [
    { label: "v1", envelope: "v1", schemaName: REVERSE_CHECK_SCHEMA_NAME, schema: REVERSE_CHECK_SCHEMA, name: ENVELOPE_SCHEMA_NAME, branch: REVERSE_CHECK_BRANCH },
    { label: "v1.1a", envelope: "v1.1a", schemaName: SEMANTIC_CHECK_SCHEMA_NAME, schema: SEMANTIC_CHECK_SCHEMA, name: ENVELOPE_SCHEMA_NAME_V11A, branch: SEMANTIC_CHECK_BRANCH },
    { label: "v1.2", envelope: "v1.2", schemaName: SEMANTIC_CHECK_SCHEMA_NAME, schema: SEMANTIC_CHECK_SCHEMA, name: ENVELOPE_SCHEMA_NAME_V12, branch: SEMANTIC_CHECK_BRANCH },
    { label: "v1.2-ids", envelope: "v1.2-ids", schemaName: VOCABULARY_SCHEMA_NAMES.entities, schema: vocabularySchemaOf("entities"), name: ENVELOPE_SCHEMA_NAME_V12, branch: VOCABULARY_ENTITIES_BRANCH },
  ];

  for (const c of cases) {
    it(`識別子 ${c.label}：result がその段の枝 1 つだけで anyOf を持たず、name は今の封筒の名前（試験の側の固定値と一致）`, async () => {
      const request: LlmStructuredRequest = { ...STRUCTURED_REQUEST, schemaName: c.schemaName, schema: c.schema };
      const body = await captureBody(
        (fetch) => openrouterClient(fetch, { envelope: c.envelope }),
        (client) => client.callStructured(request),
      );
      const format = formatOf(body);
      expect(format.name).toBe(c.name);
      expect(format.strict).toBe(true);
      const result = resultBranchOf(body);
      expect(result, "anyOf を持っている").not.toHaveProperty("anyOf");
      expect(JSON.stringify(result)).toBe(JSON.stringify(c.branch));
      expect(result).toEqual(c.branch);
    });
  }

  it("要求ごとに schema を差し替える段（同じ段名で schema が違う）は、解決した枝 1 つだけを送る（起動時の定数の枝ではない）", async () => {
    const swapped = {
      type: "object",
      additionalProperties: false,
      required: ["note"],
      properties: { note: { type: "string" } },
    };
    const request: LlmStructuredRequest = { ...STRUCTURED_REQUEST, schemaName: SEMANTIC_CHECK_SCHEMA_NAME, schema: swapped };
    const body = await captureBody((fetch) => openrouterClient(fetch, { envelope: "v1.2" }), (client) => client.callStructured(request));
    expect(formatOf(body).name).toBe(ENVELOPE_SCHEMA_NAME_V12);
    const result = resultBranchOf(body);
    expect(result).not.toHaveProperty("anyOf");
    expect(result).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["stage", "note"],
      properties: {
        stage: { type: "string", enum: [SEMANTIC_CHECK_SCHEMA_NAME], description: "この枝の段（semantic-check）" },
        note: { type: "string" },
      },
    });
  });

  it("OpenAI・Ollama の同じ要求は、全段の anyOf のまま（#790 は OpenRouter だけ）", async () => {
    const request: LlmStructuredRequest = { ...STRUCTURED_REQUEST, schemaName: SEMANTIC_CHECK_SCHEMA_NAME, schema: SEMANTIC_CHECK_SCHEMA };
    const reply = (): Response =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: SEMANTIC_CHECK_SCHEMA_NAME, judgments: [] } }))));
    const openai = recordingFetch(reply);
    await createOpenAiLlmClient({ apiKey: "sk-FAKE", fetch: openai.fetch, envelope: "v1.1a" }).callStructured(request).catch(() => {});
    expect(formatOf(openai.captured[0]!.body).schema).toEqual(ENVELOPE_SCHEMA_V11A);
    expect(Array.isArray(resultBranchOf(openai.captured[0]!.body)["anyOf"])).toBe(true);
    const ollama = recordingFetch(reply);
    await createOllamaLlmClient({ apiKey: "ollama-FAKE", fetch: ollama.fetch, envelope: "v1.1a" }).callStructured(request).catch(() => {});
    expect(formatOf(ollama.captured[0]!.body).schema).toEqual(ENVELOPE_SCHEMA_V11A);
    expect(Array.isArray(resultBranchOf(ollama.captured[0]!.body)["anyOf"])).toBe(true);
  });
});

// ── 8. stageOnlyEnvelope は封筒の段だけを変える（Issue #790）────────────────

describe("stageOnlyEnvelope は封筒の段の text.format.schema だけを変える（Issue #790）", () => {
  const withFlag = (flag: boolean, run: (client: LlmClient) => Promise<unknown>): Promise<Record<string, unknown>> =>
    captureBody(
      (fetch) =>
        createResponsesLlmClient({
          apiKey: "or-FAKE",
          model: "same-model",
          url: OPENROUTER_RESPONSES_URL,
          extraBody: { provider: OPENROUTER_PROVIDER_ROUTING },
          stageOnlyEnvelope: flag,
          fetch,
        }),
      run,
    );
  const same = async (run: (client: LlmClient) => Promise<unknown>): Promise<void> => {
    expect(JSON.stringify(await withFlag(true, run))).toBe(JSON.stringify(await withFlag(false, run)));
  };

  it("封筒の無い段（差分専用の schema）の構造化出力は、有無で body が同じ", async () => {
    const request: LlmStructuredRequest = { ...STRUCTURED_REQUEST, schemaName: SURFACE_DIFF_SCHEMA_NAME, schema: SCHEMA };
    await same((client) => client.callStructured(request));
  });

  it("判定の口の要求は、有無で body が同じ", async () => {
    const request: LlmStructuredRequest = { ...STRUCTURED_REQUEST, schemaName: "judge-questions", schema: SCHEMA };
    await same((client) => client.callStructured(request));
  });

  it("道具付きの要求（通常の往復）は、有無で body が同じ", async () => {
    const request: LlmToolRequest = { ...TOOL_REQUEST, schemaName: "answer", schema: SCHEMA };
    await same((client) => client.callWithTools(request));
  });

  it("道具付きの要求（finalAnswerOnly）は、有無で body が同じ", async () => {
    const request: LlmToolRequest = { ...TOOL_REQUEST, schemaName: "answer", schema: SCHEMA, finalAnswerOnly: true };
    await same((client) => client.callWithTools(request));
  });

  it("封筒の段は、有無で text.format.schema だけが変わる（そのほかは同じ）", async () => {
    const request: LlmStructuredRequest = { ...STRUCTURED_REQUEST, schemaName: REVERSE_CHECK_SCHEMA_NAME, schema: REVERSE_CHECK_SCHEMA };
    const on = await withFlag(true, (client) => client.callStructured(request));
    const off = await withFlag(false, (client) => client.callStructured(request));
    expect(JSON.stringify(on)).not.toBe(JSON.stringify(off));
    expect(JSON.stringify(withoutFormatSchema(on))).toBe(JSON.stringify(withoutFormatSchema(off)));
  });
});

// ── 9. 封筒の段の応答の扱いは今のまま（Issue #790）─────────────────────────

describe("封筒の段の応答の扱いは今のまま（wrong-stage と schema の印も。Issue #790）", () => {
  const semanticRequest: LlmStructuredRequest = {
    ...STRUCTURED_REQUEST,
    schemaName: SEMANTIC_CHECK_SCHEMA_NAME,
    schema: SEMANTIC_CHECK_SCHEMA,
  };

  it("その段の枝の正しい応答は取り出せる（stage を落として段へ渡す）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: SEMANTIC_CHECK_SCHEMA_NAME, judgments: [] } })))),
    );
    const response = await openrouterClient(fetch, { envelope: "v1.2" }).callStructured<{ judgments: readonly unknown[] }>(semanticRequest);
    expect(response.output).toEqual({ judgments: [] });
  });

  it("別の段の stage の応答は wrong-stage（#783 の印も今のまま）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: REVERSE_CHECK_SCHEMA_NAME, judgments: [] } })))),
    );
    const error = await captureError(() => openrouterClient(fetch, { envelope: "v1.2" }).callStructured(semanticRequest));
    expect(error.kind).toBe("malformed");
    expect(error.malformedKind).toBe("wrong-stage");
  });

  it("段の枝に合わない応答は schema の malformed（#783 の印も今のまま）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: SEMANTIC_CHECK_SCHEMA_NAME, judgments: "文字列" } })))),
    );
    const error = await captureError(() => openrouterClient(fetch, { envelope: "v1.2" }).callStructured(semanticRequest));
    expect(error.kind).toBe("malformed");
    expect(error.malformedKind).toBe("schema");
  });
});
