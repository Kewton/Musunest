// Ollama Cloud の Responses API（OpenAI 互換）の adapter（Issue #771）の unit テスト。
//
// 実 API は呼ばない。**差し込んだ `fetch` が受け取った要求**と、**手で書いた応答**だけで閉じる。
// ここで固定したいのは 6 つ。
//   1. 宛先は `https://ollama.com/v1/responses`、`Authorization` は渡した鍵、既定のモデルは
//      `deepseek-v4.1-flash:cloud`（`model` で上書きできる）
//   2. body は OpenAI と同じで、段の指示の最後に schema の塊が 1 つ増えるだけ（構造化・schema 付きの道具・
//      `finalAnswerOnly`）。schema の無い道具だけの要求は OpenAI と同じ。封筒の段では「その段だけの封筒全体」
//   3. 応答の解釈は OpenAI と同じ（封筒の `result` の取り出し、形の誤り）
//   4. usage は、キャッシュの書き込みの欄が無ければ 0、`reasoning_tokens` 0 をそのまま 0 として読む
//   5. 誤りの分類（429・残高切れ・5xx・timeout・未完了）は OpenAI と同じ
//   6. adapter の source が環境変数を読まない（鍵は入口から渡す）
import { describe, expect, it } from "vitest";
import type { LlmStructuredRequest, LlmToolRequest } from "./llm.js";
import {
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_RESPONSES_URL,
  createOllamaLlmClient,
  type OllamaAdapterOptions,
} from "./ollama.js";
import {
  OpenAiAdapterError,
  OpenAiIncompleteError,
  createOpenAiLlmClient,
  type FetchLike,
} from "./openai.js";
import { REVERSE_CHECK_SCHEMA, REVERSE_CHECK_SCHEMA_NAME } from "./stages/reverse-check.js";
import { buildStageBranch, envelopeStageFor } from "./schema-envelope.js";

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
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
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

const ollamaClient = (fetch: FetchLike, extra: Partial<OllamaAdapterOptions> = {}) =>
  createOllamaLlmClient({ apiKey: "ollama-FAKE", fetch, ...extra });

type ContentBlock = { readonly type: string; readonly text: string };

/** 入力の developer のメッセージの内容の塊（無ければ空） */
function developerBlocks(body: Record<string, unknown>): ContentBlock[] {
  const input = body["input"] as readonly { readonly role?: string; readonly content?: readonly ContentBlock[] }[];
  return input.flatMap((item) => (item.role === "developer" ? (item.content ?? []) : []));
}

const SCHEMA_INSTRUCTION_PREFIX = "次の JSON Schema に合う JSON だけを返す。";

/** 1 つの要求について、Ollama と OpenAI の body を作る（同じモデル・同じ封筒で比べる） */
async function bodiesOf(
  run: (client: ReturnType<typeof createOllamaLlmClient> | ReturnType<typeof createOpenAiLlmClient>) => Promise<unknown>,
  extra: Partial<OllamaAdapterOptions> = {},
): Promise<{ readonly ollama: Record<string, unknown>; readonly openai: Record<string, unknown> }> {
  const reply = () => jsonResponse(completed(outputText(JSON.stringify({ items: [] }))));
  const o = recordingFetch(reply);
  const p = recordingFetch(reply);
  await run(createOllamaLlmClient({ apiKey: "ollama-FAKE", model: "same-model", fetch: o.fetch, ...extra })).catch(() => {});
  await run(createOpenAiLlmClient({ apiKey: "sk-FAKE", model: "same-model", fetch: p.fetch, ...extra })).catch(() => {});
  return { ollama: o.captured[0]!.body, openai: p.captured[0]!.body };
}

// ── 1. 宛先・鍵・モデル ──────────────────────────────────────────────

describe("宛先・鍵・既定のモデル（Issue #771）", () => {
  it("宛先は https://ollama.com/v1/responses、Authorization は渡した鍵、既定のモデルは deepseek-v4.1-flash:cloud", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [1] })))),
    );
    const client = ollamaClient(fetch);
    const response = await client.callStructured<{ items: number[] }>(STRUCTURED_REQUEST);
    expect(response.output).toEqual({ items: [1] });

    const call = captured[0]!;
    expect(call.url).toBe("https://ollama.com/v1/responses");
    expect(call.url).toBe(OLLAMA_RESPONSES_URL);
    expect(call.headers["authorization"]).toBe("Bearer ollama-FAKE");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body["model"]).toBe("deepseek-v4.1-flash:cloud");
    expect(call.body["model"]).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it("model・effort を渡すと、その値で送る", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })))),
    );
    const client = ollamaClient(fetch, { model: "deepseek-v4.1-flash", effort: "low" });
    await client.callStructured(STRUCTURED_REQUEST);
    expect(captured[0]!.body["model"]).toBe("deepseek-v4.1-flash");
    expect(captured[0]!.body["reasoning"]).toEqual({ effort: "low" });
  });
});

// ── 2. body は OpenAI と同じで、schema の塊が 1 つ増えるだけ ──────────

describe("body は OpenAI と同じで、段の指示の最後に schema の塊が 1 つ増えるだけ（Issue #771）", () => {
  it("構造化出力：input のほかは OpenAI と同じで、developer の最後の塊が schema の文", async () => {
    const { ollama, openai } = await bodiesOf((client) => client.callStructured(STRUCTURED_REQUEST));
    const { input: ollamaInput, ...ollamaRest } = ollama;
    const { input: openaiInput, ...openaiRest } = openai;
    expect(ollamaRest).toEqual(openaiRest);
    // OpenAI は文書・データの 2 項目。Ollama はその間に schema の developer が 1 つ増える
    expect((openaiInput as readonly unknown[]).length).toBe(2);
    expect((ollamaInput as readonly unknown[]).length).toBe(3);
    const blocks = developerBlocks(ollama);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text.startsWith(SCHEMA_INSTRUCTION_PREFIX)).toBe(true);
    expect(blocks[0]!.text).toContain(JSON.stringify(SCHEMA));
  });

  it("段の規則と封筒の指示があっても、schema の塊は最後の内容の塊（規則・封筒の指示は今のまま）", async () => {
    const request: LlmStructuredRequest = {
      ...STRUCTURED_REQUEST,
      rules: ["段の規則"],
      schemaName: REVERSE_CHECK_SCHEMA_NAME,
      schema: REVERSE_CHECK_SCHEMA,
    };
    const { ollama, openai } = await bodiesOf((client) => client.callStructured(request));
    const ollamaBlocks = developerBlocks(ollama);
    const openaiBlocks = developerBlocks(openai);
    expect(ollamaBlocks.length).toBe(openaiBlocks.length + 1);
    expect(ollamaBlocks.slice(0, -1)).toEqual(openaiBlocks);
    expect(ollamaBlocks.at(-1)!.text.startsWith(SCHEMA_INSTRUCTION_PREFIX)).toBe(true);
    // 封筒の段：載せる schema は「result の下にその段の枝を置いた、その段だけの封筒全体」
    const entry = envelopeStageFor(REVERSE_CHECK_SCHEMA_NAME);
    expect(entry).toBeDefined();
    expect(ollamaBlocks.at(-1)!.text).toContain(
      JSON.stringify({
        type: "object",
        additionalProperties: false,
        required: ["result"],
        properties: { result: buildStageBranch(entry!) },
      }),
    );
  });

  it("schema 付きの道具（finalAnswerOnly も）は schema の塊を足し、道具の定義・履歴・tool_choice は OpenAI と同じ", async () => {
    const request: LlmToolRequest = {
      ...TOOL_REQUEST,
      schemaName: "answer",
      schema: SCHEMA,
      finalAnswerOnly: true,
    };
    const { ollama, openai } = await bodiesOf((client) => client.callWithTools(request));
    const { input: ollamaInput, ...ollamaRest } = ollama;
    const { input: openaiInput, ...openaiRest } = openai;
    expect(ollamaRest).toEqual(openaiRest);
    expect(ollamaRest["tool_choice"]).toBe("none");
    expect((ollamaInput as readonly unknown[]).length).toBe((openaiInput as readonly unknown[]).length + 1);
    const blocks = developerBlocks(ollama);
    expect(blocks.at(-1)!.text.startsWith(SCHEMA_INSTRUCTION_PREFIX)).toBe(true);
    expect(blocks.at(-1)!.text).toContain(JSON.stringify(SCHEMA));
  });

  it("schema の無い道具だけの要求は、OpenAI と同じ body（schema の塊を足さない）", async () => {
    const { ollama, openai } = await bodiesOf((client) => client.callWithTools(TOOL_REQUEST));
    expect(ollama).toEqual(openai);
    expect(developerBlocks(ollama)).toHaveLength(0);
  });

  it("規則も封筒の指示も無い要求（判定の口など）でも、schema の塊だけの developer を置く", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ ok: true })))),
    );
    const client = ollamaClient(fetch);
    await client.callStructured({
      ...STRUCTURED_REQUEST,
      schemaName: "judge-question",
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    });
    const blocks = developerBlocks(captured[0]!.body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text.startsWith(SCHEMA_INSTRUCTION_PREFIX)).toBe(true);
  });

  it("OpenAI の adapter は schema の塊を足さない（今までと同じ body）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })))),
    );
    const client = createOpenAiLlmClient({ apiKey: "sk-FAKE", fetch });
    await client.callStructured(STRUCTURED_REQUEST);
    expect(developerBlocks(captured[0]!.body)).toHaveLength(0);
  });
});

// ── 3. 応答の解釈（OpenAI と同じ） ──────────────────────────────────

describe("応答の解釈は OpenAI と同じ（Issue #771）", () => {
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
    const response = await ollamaClient(fetch).callStructured(envelopeRequest);
    expect(response.output).toEqual({ uncovered: [] });
  });

  it("result の無い応答は malformed", async () => {
    const { fetch } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ uncovered: [] })))));
    const error = await captureError(() => ollamaClient(fetch).callStructured(envelopeRequest));
    expect(error.kind).toBe("malformed");
  });

  it("別の段の枝の応答は malformed", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: "design", uncovered: [] } })))),
    );
    const error = await captureError(() => ollamaClient(fetch).callStructured(envelopeRequest));
    expect(error.kind).toBe("malformed");
  });

  it("schema に合わない応答は malformed（縛られないことを理由に検査を緩めない）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: REVERSE_CHECK_SCHEMA_NAME, uncovered: [{ start: 1 }] } })))),
    );
    const error = await captureError(() => ollamaClient(fetch).callStructured(envelopeRequest));
    expect(error.kind).toBe("malformed");
  });
});

// ── 4. usage ────────────────────────────────────────────────────────

describe("usage の読み取り（Issue #771）", () => {
  const envelopeRequest: LlmStructuredRequest = {
    instructions: "規則",
    documents: ["文書"],
    rules: [],
    input: "依頼文",
    schemaName: REVERSE_CHECK_SCHEMA_NAME,
    schema: REVERSE_CHECK_SCHEMA,
    maxOutputTokens: 128,
  };

  it("キャッシュの書き込みの欄が無い・reasoning_tokens 0 の応答を、書き込み 0・推論 0 として読む", async () => {
    const usage = {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 },
    };
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: REVERSE_CHECK_SCHEMA_NAME, uncovered: [] } })), usage)),
    );
    const response = await ollamaClient(fetch).callStructured(envelopeRequest);
    expect(response.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
    });
  });

  it("usage が無ければ「usage なし」にする", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ result: { stage: REVERSE_CHECK_SCHEMA_NAME, uncovered: [] } })))),
    );
    const response = await ollamaClient(fetch).callStructured(envelopeRequest);
    expect(response.usage).toBeUndefined();
  });
});

// ── 5. 誤りの分類（OpenAI と同じ） ──────────────────────────────────

describe("誤りの分類は OpenAI と同じ（Issue #771）", () => {
  it("HTTP 429 は、状態コード付きの HTTP の誤り", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ error: { code: "rate_limit" } }, 429));
    const error = await captureError(() => ollamaClient(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(429);
  });

  it("HTTP 429 の insufficient_quota は残高切れ", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ error: { code: "insufficient_quota" } }, 429));
    const error = await captureError(() => ollamaClient(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("balance");
    expect(error.status).toBe(429);
  });

  it("HTTP 5xx は HTTP の誤り", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ error: { code: "server_error" } }, 503));
    const error = await captureError(() => ollamaClient(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(503);
  });

  it("未完了の応答は incomplete（出力が JSON として読めても成功にしない）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: outputText(JSON.stringify({ items: [] })) }),
    );
    const error = await captureError(() => ollamaClient(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error).toBeInstanceOf(OpenAiIncompleteError);
    expect(error.kind).toBe("incomplete");
    expect((error as OpenAiIncompleteError).reason).toBe("max_output_tokens");
  });

  it("timeout を分類する（自分の時計で打ち切る）", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = ollamaClient(hanging, { timeoutMs: 5 });
    const error = await captureError(() => client.callStructured(STRUCTURED_REQUEST));
    expect(error.kind).toBe("timeout");
  });
});

// ── 6. adapter は環境変数を読まない ─────────────────────────────────

describe("adapter は環境変数を読まない（Issue #771）", () => {
  it("ollama.ts に環境変数の入口と宛先の環境変数が無い", async () => {
    const files = (await import(/* @vite-ignore */ "node:fs")) as {
      readFileSync(path: URL, encoding: "utf8"): string;
    };
    const source = files.readFileSync(new URL("./ollama.ts", import.meta.url), "utf8");
    for (const token of ["process.env", "OLLAMA_API_KEY", "cloudflare:workers", "node:fs"]) {
      expect(source.includes(token), token).toBe(false);
    }
    // 宛先は固定（環境変数から読まない）
    expect(source).toContain("https://ollama.com/v1/responses");
  });
});
