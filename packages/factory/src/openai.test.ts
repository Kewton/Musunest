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
import { describe, expect, it, vi } from "vitest";
import type {
  LlmStructuredRequest,
  LlmToolRequest,
  LlmTurn,
} from "./llm.js";
import { OUTPUT_STAGES, maxOutputTokensForEffort } from "./limits.js";
import {
  OPENAI_PROMPT_CACHE_KEY,
  RESPONSES_BODY_RESERVED_KEYS,
  OpenAiAdapterError,
  OpenAiIncompleteError,
  createOpenAiLlmClient,
  createResponsesLlmClient,
  type FetchLike,
  type OpenAiErrorKind,
  type OpenAiUsage,
} from "./openai.js";
import {
  SHARED_BODY_MODEL,
  SHARED_STRUCTURED_BODY_JSON,
  SHARED_STRUCTURED_REQUEST,
  SHARED_TOOL_BODY_JSON,
  SHARED_TOOL_REQUEST,
} from "./__tests__/openai.js";
import {
  ENVELOPE_SCHEMA,
  ENVELOPE_SCHEMA_NAME,
  ENVELOPE_SCHEMA_NAME_V11A,
  ENVELOPE_SCHEMA_NAME_V12,
  ENVELOPE_SCHEMA_V11A,
  ENVELOPE_SCHEMA_V12,
  ENVELOPE_SCHEMA_V12_IDS,
  ENVELOPE_SCHEMA_V12_LEDGER,
  buildEnvelopeSchema,
  buildStageBranch,
  envelopeStageFor,
  STAGE_ENVELOPE_ENTRIES_V11A,
} from "./schema-envelope.js";
import { DESIGN_SCHEMA, DESIGN_SCHEMA_NAME } from "./stages/design.js";
import { NAME_TABLE_SCHEMA, NAME_TABLE_SCHEMA_NAME, nameTableSchemaOf } from "./v11a/stages/name-table.js";
import { TEST_SPEC_SCHEMA_NAME, testSpecSchemaOf } from "./v11a/stages/test-spec.js";
import { PROPERTY_LEDGER_VIEW } from "./v12/ledger.js";
import { VOCABULARY_BUNDLES } from "./v12/ids.js";
import { MAPPING_SCHEMA_NAME, mappingSchemaOf } from "./v12/stages/mapping.js";
import { VOCABULARY_SCHEMA_NAMES, vocabularySchemaOf } from "./v12/stages/vocabulary.js";
import { SURFACE_DIFF_SCHEMA_NAME, SURFACE_SCHEMA, SURFACE_SCHEMA_NAME, buildSurfaceDiffSchema } from "./plan/surface.js";
import { REQUIREMENT_LIST_SCHEMA, REQUIREMENTS_SCHEMA_NAME } from "./stages/requirements.js";
import { REVERSE_CHECK_SCHEMA, REVERSE_CHECK_SCHEMA_NAME } from "./stages/reverse-check.js";
import { TEST_SUITE_SCHEMA, TEST_SUITE_SCHEMA_NAME } from "./stages/test-suite.js";

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

const USAGE_WIRE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 120,
};
const USAGE: OpenAiUsage = {
  inputTokens: 100,
  cachedInputTokens: 40,
  cacheWriteTokens: 10,
  outputTokens: 20,
  reasoningTokens: 5,
};

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

  it("段ごとの effort（Issue #664・#751）：構造化と道具付きのどちらの要求も、effort があれば reasoning はその値、無ければ設定の値。要求に無ければ body はバイト列で今と同じ", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    const client = createOpenAiLlmClient({ apiKey: "test-key", effort: "high", fetch });

    await client.callStructured(STRUCTURED_REQUEST);
    await client.callStructured({ ...STRUCTURED_REQUEST, effort: "low" });
    await client.callStructured(STRUCTURED_REQUEST);
    expect(bodyOf(captured, 0).reasoning).toEqual({ effort: "high" });
    expect(bodyOf(captured, 1).reasoning).toEqual({ effort: "low" });
    // 要求の effort は reasoning にだけ現れ、ほかの欄・並びは同じ（effort の欄を body に写さない）
    const { reasoning: _low, ...withLow } = bodyOf(captured, 1);
    const { reasoning: _high, ...withHigh } = bodyOf(captured, 0);
    expect(JSON.stringify(withLow)).toBe(JSON.stringify(withHigh));
    expect(JSON.stringify(bodyOf(captured, 2))).toBe(JSON.stringify(bodyOf(captured, 0)));
    expect(Object.keys(bodyOf(captured, 1))).toEqual(Object.keys(bodyOf(captured, 0)));

    // adapter に effort の設定が無くても、要求の effort は送る
    const bare = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)));
    const bareClient = createOpenAiLlmClient({ apiKey: "test-key", fetch: bare.fetch });
    await bareClient.callStructured(STRUCTURED_REQUEST);
    await bareClient.callStructured({ ...STRUCTURED_REQUEST, effort: "medium" });
    expect(bodyOf(bare.captured, 0).reasoning).toBeUndefined();
    expect(bodyOf(bare.captured, 1).reasoning).toEqual({ effort: "medium" });

    // 道具付きの要求も構造化と同じ規則：要求の effort があればそれを、無ければ設定の値を送る（Issue #751）
    const tools = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })), USAGE_WIRE)));
    const toolClient = createOpenAiLlmClient({ apiKey: "test-key", effort: "high", fetch: tools.fetch });
    await toolClient.callWithTools(TOOL_REQUEST);
    await toolClient.callWithTools({ ...TOOL_REQUEST, effort: "medium" });
    await toolClient.callWithTools(TOOL_REQUEST);
    expect(bodyOf(tools.captured, 0).reasoning).toEqual({ effort: "high" });
    expect(bodyOf(tools.captured, 1).reasoning).toEqual({ effort: "medium" });
    expect(JSON.stringify(bodyOf(tools.captured, 2))).toBe(JSON.stringify(bodyOf(tools.captured, 0)));
    expect(Object.keys(bodyOf(tools.captured, 1))).toEqual(Object.keys(bodyOf(tools.captured, 0)));
    // 要求の effort は reasoning にだけ現れ、ほかの欄（tools・input・max_output_tokens）は同じ
    const { reasoning: _toolMedium, ...toolWithMedium } = bodyOf(tools.captured, 1);
    const { reasoning: _toolHigh, ...toolWithHigh } = bodyOf(tools.captured, 0);
    expect(JSON.stringify(toolWithMedium)).toBe(JSON.stringify(toolWithHigh));
    // adapter の設定に effort が無ければ、要求の effort だけを送る
    const bareTools = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })), USAGE_WIRE)));
    const bareToolClient = createOpenAiLlmClient({ apiKey: "test-key", fetch: bareTools.fetch });
    await bareToolClient.callWithTools(TOOL_REQUEST);
    await bareToolClient.callWithTools({ ...TOOL_REQUEST, effort: "medium" });
    expect(bodyOf(bareTools.captured, 0).reasoning).toBeUndefined();
    expect(bodyOf(bareTools.captured, 1).reasoning).toEqual({ effort: "medium" });
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

  it("最後の答えの schema を持つ道具付きの要求は、tools と一緒に strict の構造化出力も送る（#304）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })), USAGE_WIRE)),
    );
    const client = clientWith(fetch);

    await client.callWithTools({ ...TOOL_REQUEST, schemaName: "repair-answer", schema: SCHEMA });

    const body = bodyOf(captured);
    const tools = body.tools as readonly unknown[];
    expect(tools[0]).toMatchObject({ type: "function", name: "staticCheck", strict: true });
    const format = (body.text as { format: { type: string; name: string; schema: unknown; strict: boolean } }).format;
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("repair-answer");
    expect(format.schema).toEqual(SCHEMA);
    expect(format.strict).toBe(true);
  });

  it("最後の答えだけを求める印があるときだけ道具を選ばせない指定を足し、履歴・schema・effort・道具の定義は印の無い body と同じ（Issue #768）", async () => {
    const turns: readonly LlmTurn[] = [
      { role: "assistant", toolCalls: [{ id: "call-1", name: "staticCheck", arguments: { where: "a" } }] },
      { role: "tool", results: [{ toolCallId: "call-1", name: "staticCheck", output: { ok: true } }] },
    ];
    const request: LlmToolRequest = { ...TOOL_REQUEST, schemaName: "repair-answer", schema: SCHEMA, turns, effort: "medium" };
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })), USAGE_WIRE)),
    );
    const client = createOpenAiLlmClient({ apiKey: "test-key", effort: "high", fetch });

    await client.callWithTools(request);
    await client.callWithTools({ ...request, finalAnswerOnly: true });
    await client.callWithTools(request);

    const plain = bodyOf(captured, 0);
    const marked = bodyOf(captured, 1);
    expect(plain).not.toHaveProperty("tool_choice");
    expect(marked.tool_choice).toBe("none");
    // 印は道具を選ばせない指定だけを足す（道具の定義は残る。履歴・schema・effort・入力も同じ）
    expect((marked.tools as readonly unknown[])[0]).toMatchObject({ type: "function", name: "staticCheck" });
    const { tool_choice: _choice, ...rest } = marked;
    expect(rest).toEqual(plain);
    // 印が無ければ今の body とバイト列で同じ
    expect(JSON.stringify(bodyOf(captured, 2))).toBe(JSON.stringify(plain));
  });

  it("囲みの付いた本文は今のとおり malformed（OpenAI は囲みを読まない。Issue #777）", async () => {
    const fenced = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
    const structured = recordingFetch(() => jsonResponse(completed(outputText(fenced({ items: [] })), USAGE_WIRE)));
    const structuredError = await captureError(() => clientWith(structured.fetch).callStructured(STRUCTURED_REQUEST));
    expect(structuredError.kind).toBe("malformed");
    const tools = recordingFetch(() => jsonResponse(completed(outputText(fenced({ entity: "item" })), USAGE_WIRE)));
    const toolsError = await captureError(() => clientWith(tools.fetch).callWithTools(TOOL_REQUEST));
    expect(toolsError.kind).toBe("malformed");
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

  it("文書は入力の先頭に同じ並びで置かれ、依頼文はその後ろに置かれる（§2・§2.2）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured({
      ...STRUCTURED_REQUEST,
      documents: ["契約の文書", "語彙の意味", "語彙の台帳"],
      input: "依頼文",
    });
    const input = bodyOf(captured).input as readonly { content: readonly { text: string }[] }[];
    expect(input.map((item) => item.content[0]?.text)).toEqual([
      "契約の文書",
      "語彙の意味",
      "語彙の台帳",
      "<data>\n依頼文\n</data>",
    ]);
  });

  it("道具付きでも、文書は入力の先頭で、依頼文はその後ろに置かれる（§2・§2.2）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })), USAGE_WIRE)),
    );
    await clientWith(fetch).callWithTools({
      ...TOOL_REQUEST,
      documents: ["契約の文書", "語彙の意味"],
      input: "宣言",
    });
    const input = bodyOf(captured).input as readonly { content: readonly { text: string }[] }[];
    expect(input.map((item) => item.content[0]?.text)).toEqual([
      "契約の文書",
      "語彙の意味",
      "<data>\n宣言\n</data>",
    ]);
  });

  it("段ごとの規則は、文書の後ろ・依頼文の前に置かれる（02 §2）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured({
      ...STRUCTURED_REQUEST,
      documents: ["契約の文書"],
      rules: ["段の規則", "もう 1 つの段の規則"],
      input: "依頼文",
    });
    const input = bodyOf(captured).input as readonly { content: readonly { text: string }[] }[];
    expect(input.map((item) => item.content[0]?.text)).toEqual([
      "契約の文書",
      "<rules>\n段の規則\nもう 1 つの段の規則\n</rules>",
      "<data>\n依頼文\n</data>",
    ]);
  });

  it("規則が空なら、規則の項目を送らない（文書の後ろが依頼文になる）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured({ ...STRUCTURED_REQUEST, documents: ["契約の文書"], rules: [] });
    const input = bodyOf(captured).input as readonly { content: readonly { text: string }[] }[];
    expect(input.map((item) => item.content[0]?.text)).toEqual(["契約の文書", "<data>\n依頼文\n</data>"]);
  });

  it("prompt_cache_key を、構造化出力でも道具付きでも同じ値で送る（02 §2）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    const client = clientWith(fetch);
    await client.callStructured(STRUCTURED_REQUEST);
    await client.callWithTools(TOOL_REQUEST);
    expect(captured).toHaveLength(2);
    for (const call of captured) {
      expect(call.body.prompt_cache_key).toBe(OPENAI_PROMPT_CACHE_KEY);
    }
  });
});

// ── 3.3. 囲みの開始行の余分なバッククォート（Issue #777 レビュー R1）──────────────
//
// OpenAI の client は囲みを読まない（`readFencedJson` は off）ので、開始行がどうであれ本文は今のとおり
// malformed になる。この 3 反例は Ollama の client（設定 on）で始まりの検査が効く（`ollama.test.ts`）。

/** 囲みの開始行が不正な 3 反例（Issue #777 レビュー R1。閉じは 3 個） */
const R1_BAD_STARTS: readonly { readonly name: string; readonly start: string }[] = [
  { name: "開始行がバッククォート 4 個だけ", start: "````" },
  { name: "開始行がバッククォート 6 個だけ", start: "``````" },
  { name: "言語の印の末尾にバッククォート 3 個（```json```）", start: "```json```" },
];

describe("囲みの開始行の余分なバッククォートは今のとおり malformed（Issue #777 レビュー R1。OpenAI は囲みを読まない）", () => {
  const fenced = (start: string, payload: unknown): string => `${start}\n${JSON.stringify(payload)}\n\`\`\``;

  it.each(R1_BAD_STARTS)("$name：構造化出力も最後の答えも malformed", async ({ start }) => {
    const structured = recordingFetch(() => jsonResponse(completed(outputText(fenced(start, { items: [] })), USAGE_WIRE)));
    const structuredError = await captureError(() => clientWith(structured.fetch).callStructured(STRUCTURED_REQUEST));
    expect(structuredError.kind).toBe("malformed");
    const tools = recordingFetch(() => jsonResponse(completed(outputText(fenced(start, { entity: "item" })), USAGE_WIRE)));
    const toolsError = await captureError(() => clientWith(tools.fetch).callWithTools(TOOL_REQUEST));
    expect(toolsError.kind).toBe("malformed");
  });
});

// ── 3.4. 送る max_output_tokens は段と effort の値（02 §1.5・Issue #399）──────────

describe("送る max_output_tokens は、段と effort の値になる（02 §1.5・Issue #399）", () => {
  it("段と effort の値（STAGE_MAX_OUTPUT_TOKENS）をそのまま送る", async () => {
    for (const effort of ["low", "medium", "high"] as const) {
      for (const stage of OUTPUT_STAGES) {
        const expected = maxOutputTokensForEffort(effort, stage);
        const { fetch, captured } = recordingFetch(() =>
          jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
        );
        const client = createOpenAiLlmClient({ apiKey: "test-key", effort, fetch });
        await client.callStructured({ ...STRUCTURED_REQUEST, maxOutputTokens: expected });
        expect(bodyOf(captured).max_output_tokens, `${effort}/${stage}`).toBe(expected);
      }
    }
  });

  it("代表の値を名指しでも確かめる（設計・洗い出しは 32,768、逆照合は 8,192）", async () => {
    const design = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    await createOpenAiLlmClient({ apiKey: "test-key", effort: "low", fetch: design.fetch }).callStructured({
      ...STRUCTURED_REQUEST,
      maxOutputTokens: maxOutputTokensForEffort("low", "design"),
    });
    expect(bodyOf(design.captured).max_output_tokens).toBe(32_768);
    expect(maxOutputTokensForEffort("low", "surface")).toBe(32_768);
    expect(maxOutputTokensForEffort("high", "reverse-check")).toBe(8_192);
  });
});

// ── 3.5. プロンプトのキャッシュ（02 §2・§1.2・#342）──────────────────────

/** 入力の項目（role と content をそのまま見る） */
type InputItem = { readonly role: string; readonly content: readonly Record<string, unknown>[] };

function inputOf(captured: readonly Captured[], index = 0): readonly InputItem[] {
  return bodyOf(captured, index).input as readonly InputItem[];
}

describe("プロンプトのキャッシュを、明示の breakpoint で文書の直後に当てる（02 §2・#342）", () => {
  it("送る本文に prompt_cache_options.mode = explicit がある", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured(STRUCTURED_REQUEST);
    expect(bodyOf(captured).prompt_cache_options).toEqual({ mode: "explicit" });
  });

  it("文書の最後のブロックだけに breakpoint が付き、ほかのブロックには付かない", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured({
      ...STRUCTURED_REQUEST,
      documents: ["契約の文書", "語彙の意味", "語彙の台帳"],
      rules: ["段の規則"],
      input: "依頼文",
    });
    // 文書 3・段の規則 1・データ 1 の 5 項目。breakpoint は 3 つ目の文書だけ
    expect(inputOf(captured).map((item) => item.content[0]?.prompt_cache_breakpoint)).toEqual([
      undefined,
      undefined,
      { mode: "explicit" },
      undefined,
      undefined,
    ]);
  });

  it("段ごとの指示は、文書より後ろの developer のメッセージにある", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured({
      ...STRUCTURED_REQUEST,
      documents: ["契約の文書"],
      rules: ["段の規則", "もう 1 つの段の規則"],
      input: "依頼文",
    });
    const input = inputOf(captured);
    // 文書（user）→ 段の規則（developer）→ データ（user）の順
    expect(input.map((item) => item.role)).toEqual(["user", "developer", "user"]);
    expect(input[1]?.content[0]).toEqual({
      type: "input_text",
      text: "<rules>\n段の規則\nもう 1 つの段の規則\n</rules>",
    });
  });

  it("上の instructions は段によらず同じで、段ごとの指示は developer のメッセージに分かれる", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    const client = clientWith(fetch);
    await client.callStructured({ ...STRUCTURED_REQUEST, documents: ["文書"], rules: ["段 A の規則"] });
    await client.callStructured({ ...STRUCTURED_REQUEST, documents: ["文書"], rules: ["段 B の規則"] });

    expect(captured).toHaveLength(2);
    // 上の instructions は、段によらず同じ値
    expect(bodyOf(captured, 0).instructions).toBe("規則");
    expect(bodyOf(captured, 1).instructions).toBe("規則");
    // 段ごとの指示は、上の instructions ではなく developer のメッセージにある
    expect(inputOf(captured, 0)[1]).toMatchObject({ role: "developer" });
    expect(inputOf(captured, 0)[1]?.content[0]?.text).toContain("段 A の規則");
    expect(inputOf(captured, 1)[1]?.content[0]?.text).toContain("段 B の規則");
  });

  it("道具付きの要求でも、prompt_cache_options を送り、最後の文書にだけ breakpoint を付ける", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })), USAGE_WIRE)),
    );
    await clientWith(fetch).callWithTools({
      ...TOOL_REQUEST,
      documents: ["契約の文書", "語彙の意味"],
      rules: ["段の規則"],
      input: "宣言",
    });
    const body = bodyOf(captured);
    expect(body.prompt_cache_options).toEqual({ mode: "explicit" });
    // 文書 2・段の規則 1・データ 1 の 4 項目。breakpoint は 2 つ目の文書だけ
    expect(inputOf(captured).map((item) => item.content[0]?.prompt_cache_breakpoint)).toEqual([
      undefined,
      { mode: "explicit" },
      undefined,
      undefined,
    ]);
  });
});

// ── 3.7. 全段で同じ封筒の schema（02 §2・#353）────────────────────────────

/** 封筒の応答（`result` で包み、`stage` を判別子にする） */
const enveloped = (stage: string, output: Record<string, unknown>): Record<string, unknown> => ({
  result: { stage, ...output },
});

/** ① の答え（`REQUIREMENT_LIST_SCHEMA` に合う最小の形。`framing` は必須の欄なので空の配列を置く。Issue #372） */
const REQUIREMENT_OUTPUT = {
  requirements: [{ id: "R-1", text: "要件", quote: "引用", position: { start: 0, end: 1 } }],
  framing: [],
  decisions: [],
  unresolved: [],
};

/** ①' の答え */
const REVERSE_OUTPUT = { uncovered: [] };

/** 封筒の `text.format` を読む */
function formatOf(body: Record<string, unknown>): {
  readonly name: string;
  readonly schema: unknown;
  readonly strict: boolean;
} {
  return (body.text as { format: { name: string; schema: unknown; strict: boolean } }).format;
}

const stageRequest = (schemaName: string, schema: unknown): LlmStructuredRequest => ({
  ...STRUCTURED_REQUEST,
  schemaName,
  schema,
});

describe("構造化出力は、全段で同じ封筒の schema を送る（02 §2・#353）", () => {
  it("構造化出力のどの段の要求でも、text.format の名前と schema が同じ", async () => {
    const reply = (call: number): Record<string, unknown> =>
      call === 1
        ? enveloped(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_OUTPUT)
        : enveloped(REVERSE_CHECK_SCHEMA_NAME, REVERSE_OUTPUT);
    const { fetch, captured } = recordingFetch((call) =>
      jsonResponse(completed(outputText(JSON.stringify(reply(call))), USAGE_WIRE)),
    );
    const client = clientWith(fetch);

    await client.callStructured(stageRequest(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_SCHEMA));
    await client.callStructured(stageRequest(REVERSE_CHECK_SCHEMA_NAME, REVERSE_CHECK_SCHEMA));

    expect(captured).toHaveLength(2);
    for (const call of captured) {
      const format = formatOf(call.body);
      expect(format.name).toBe(ENVELOPE_SCHEMA_NAME);
      expect(format.schema).toEqual(ENVELOPE_SCHEMA);
      expect(format.strict).toBe(true);
    }
  });

  it("封筒に載っていない schema は、今までどおりその要求の schema を送る（判定の口など）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured(stageRequest("judge-answers", SCHEMA));

    const format = formatOf(bodyOf(captured));
    expect(format.name).toBe("judge-answers");
    expect(format.schema).toEqual(SCHEMA);
  });

  it("答えの result を取り出し、判別子の stage を落として段に渡す", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed(outputText(JSON.stringify(enveloped(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_OUTPUT))), USAGE_WIRE),
      ),
    );
    const response = await clientWith(fetch).callStructured<Record<string, unknown>>(
      stageRequest(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_SCHEMA),
    );
    expect(response.output).toEqual(REQUIREMENT_OUTPUT);
    expect(response.output).not.toHaveProperty("stage");
  });

  it("答えの stage がその段でなければ、形の誤り（malformed）になる", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed(outputText(JSON.stringify(enveloped(REVERSE_CHECK_SCHEMA_NAME, REVERSE_OUTPUT))), USAGE_WIRE),
      ),
    );
    const error = await captureError(() =>
      clientWith(fetch).callStructured(stageRequest(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_SCHEMA)),
    );
    expect(error.kind).toBe("malformed");
  });

  it("result が無い応答は、形の誤り（malformed）になる", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify(REQUIREMENT_OUTPUT)), USAGE_WIRE)),
    );
    const error = await captureError(() =>
      clientWith(fetch).callStructured(stageRequest(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_SCHEMA)),
    );
    expect(error.kind).toBe("malformed");
  });

  it("段ごとの指示に、その段の stage が入る（文書より後ろ・データより前）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(
        completed(outputText(JSON.stringify(enveloped(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_OUTPUT))), USAGE_WIRE),
      ),
    );
    await clientWith(fetch).callStructured({
      ...stageRequest(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_SCHEMA),
      rules: ["段の規則"],
    });
    const input = inputOf(captured);
    // 文書（user）→ 段の規則（developer）→ データ（user）
    expect(input.map((item) => item.role)).toEqual(["user", "developer", "user"]);
    expect(input[1]?.content[0]).toEqual({ type: "input_text", text: "<rules>\n段の規則\n</rules>" });
    // 段の規則の本文は変えず、別の内容の塊として stage の指示を足す
    expect(input[1]?.content[1]?.["text"]).toContain(REQUIREMENTS_SCHEMA_NAME);
  });
});

// ── v1.1α の封筒（07-architecture-v1.1a.md §3・D12・Issue #511）─────────────────

describe("封筒は options の envelope で選ぶ（既定 v1。v1.1α は stage-envelope-v11a。Issue #511）", () => {
  it("envelope を省いた client と \"v1\" を渡した client は、同じ v1 の段の要求に同じ body を送る", async () => {
    const reply = () =>
      jsonResponse(completed(outputText(JSON.stringify(enveloped(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_OUTPUT))), USAGE_WIRE));
    const omitted = recordingFetch(reply);
    const v1 = recordingFetch(reply);
    const request = stageRequest(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_SCHEMA);
    await createOpenAiLlmClient({ apiKey: "test-key", fetch: omitted.fetch }).callStructured(request);
    await createOpenAiLlmClient({ apiKey: "test-key", fetch: v1.fetch, envelope: "v1" }).callStructured(request);

    expect(JSON.stringify(bodyOf(v1.captured))).toBe(JSON.stringify(bodyOf(omitted.captured)));
    expect(formatOf(bodyOf(omitted.captured)).name).toBe(ENVELOPE_SCHEMA_NAME);
    expect(formatOf(bodyOf(omitted.captured)).schema).toEqual(ENVELOPE_SCHEMA);
  });

  it("\"v1.1a\" では name-table の要求に v1.1α の封筒を送り、result を取り出して stage を落とす", async () => {
    const output = { rows: [], requirements: [] };
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify(enveloped(NAME_TABLE_SCHEMA_NAME, output))), USAGE_WIRE)),
    );
    const response = await createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" }).callStructured<
      Record<string, unknown>
    >(stageRequest(NAME_TABLE_SCHEMA_NAME, NAME_TABLE_SCHEMA));

    const format = formatOf(bodyOf(captured));
    expect(format.name).toBe(ENVELOPE_SCHEMA_NAME_V11A);
    expect(format.schema).toEqual(ENVELOPE_SCHEMA_V11A);
    expect(format.strict).toBe(true);
    expect(response.output).toEqual(output);
    expect(response.output).not.toHaveProperty("stage");
    // 段の指示に、その段の stage が入る
    expect(inputOf(captured)[1]?.content.at(-1)?.["text"]).toContain(NAME_TABLE_SCHEMA_NAME);
  });

  it("\"v1.1a\" の client で stage が違う答えは、形の誤り（malformed）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify(enveloped("test-spec", { rows: [], requirements: [] }))), USAGE_WIRE)),
    );
    const error = await captureError(() =>
      createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" }).callStructured(
        stageRequest(NAME_TABLE_SCHEMA_NAME, NAME_TABLE_SCHEMA),
      ),
    );
    expect(error.kind).toBe("malformed");
  });

  it("\"v1.1a\" の client に v1 だけの段（requirement-design）を要求すると、その schema をそのまま送る", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ roles: [], designs: [] })), USAGE_WIRE)),
    );
    await createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" }).callStructured(
      stageRequest(DESIGN_SCHEMA_NAME, DESIGN_SCHEMA),
    );
    const format = formatOf(bodyOf(captured));
    expect(format.name).toBe(DESIGN_SCHEMA_NAME);
    expect(format.schema).toEqual(DESIGN_SCHEMA);
  });

  it("判定の口の schema は、どちらの封筒の client でもそのまま送る", async () => {
    for (const envelope of ["v1", "v1.1a"] as const) {
      const { fetch, captured } = recordingFetch(() =>
        jsonResponse(completed(outputText(JSON.stringify({ items: [] })), USAGE_WIRE)),
      );
      await createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope }).callStructured(
        stageRequest("judge-answers", SCHEMA),
      );
      const format = formatOf(bodyOf(captured));
      expect(format.name, envelope).toBe("judge-answers");
      expect(format.schema, envelope).toEqual(SCHEMA);
    }
  });

  it("v1 の client は、v1.1α の段の名前の要求に封筒を送らない（v1.1α の封筒は v1 の要求に混ざらない）", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ rows: [], requirements: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured(stageRequest(NAME_TABLE_SCHEMA_NAME, NAME_TABLE_SCHEMA));
    const format = formatOf(bodyOf(captured));
    expect(format.name).toBe(NAME_TABLE_SCHEMA_NAME);
    expect(envelopeStageFor(NAME_TABLE_SCHEMA_NAME)).toBeUndefined();
  });
});

describe("封筒の段の枝は、段が渡した schema で組む（旗 on の台帳の schema がモデルに届く。Issue #549 の直し）", () => {
  const onTable = nameTableSchemaOf(PROPERTY_LEDGER_VIEW);
  // 計算の行 1 つの T1 の応答（行の型に集計の種類と集計元を持つ。旗 on の strict の schema で必須の欄）
  const onDraft = {
    rows: [
      {
        id: "c.total",
        kind: "computation",
        entity: null,
        name: "total",
        role: "件数を合計する",
        source: { copy: "件数を合計する", quote: "件数を合計する" },
        type: {
          fieldType: null,
          valueType: "number",
          scope: "app",
          form: "aggregate",
          action: null,
          hasWhen: null,
          view: null,
          aggregate: { kind: "sum", entity: "e.item" },
        },
        options: null,
        groupBy: null,
        refEntity: null,
      },
    ],
    requirements: [],
  };
  const replyWith = (stage: string, output: unknown) => () =>
    jsonResponse(completed(outputText(JSON.stringify(enveloped(stage, output as Record<string, unknown>))), USAGE_WIRE));

  it("旗 on の T1（台帳の schema）は旗 on の封筒を送り、行の型の aggregate がモデルに届く。T2 も同じ封筒（T1 と T2 で同じバイト列）", async () => {
    const t1 = recordingFetch(replyWith(NAME_TABLE_SCHEMA_NAME, onDraft));
    await createOpenAiLlmClient({ apiKey: "test-key", fetch: t1.fetch, envelope: "v1.1a" }).callStructured(
      stageRequest(NAME_TABLE_SCHEMA_NAME, onTable),
    );
    const t2 = recordingFetch(replyWith(TEST_SPEC_SCHEMA_NAME, { classifications: [], tests: [] }));
    await createOpenAiLlmClient({ apiKey: "test-key", fetch: t2.fetch, envelope: "v1.1a" })
      .callStructured(stageRequest(TEST_SPEC_SCHEMA_NAME, testSpecSchemaOf(PROPERTY_LEDGER_VIEW)))
      .catch(() => undefined);

    const format = formatOf(bodyOf(t1.captured));
    expect(format.name).toBe(ENVELOPE_SCHEMA_NAME_V11A);
    expect(format.schema).toEqual(ENVELOPE_SCHEMA_V12_LEDGER);
    expect(format.schema).not.toEqual(ENVELOPE_SCHEMA_V11A);
    expect(JSON.stringify(formatOf(bodyOf(t2.captured)).schema)).toBe(JSON.stringify(format.schema));
    const branches = (((format.schema as Record<string, unknown>)["properties"] as Record<string, unknown>)["result"] as { readonly anyOf: readonly unknown[] }).anyOf;
    expect(branches).toContainEqual(buildStageBranch({ stage: NAME_TABLE_SCHEMA_NAME, schema: onTable }));
    expect(JSON.stringify(branches)).toContain('"aggregate"');
  });

  it("応答の取り出しも同じ枝で行う：aggregate を持つ T1 の応答は、旗 on の schema では受け、旗 off の schema では形の誤り", async () => {
    const on = recordingFetch(replyWith(NAME_TABLE_SCHEMA_NAME, onDraft));
    const response = await createOpenAiLlmClient({ apiKey: "test-key", fetch: on.fetch, envelope: "v1.1a" }).callStructured<
      Record<string, unknown>
    >(stageRequest(NAME_TABLE_SCHEMA_NAME, onTable));
    expect(response.output).toEqual(onDraft);

    const off = recordingFetch(replyWith(NAME_TABLE_SCHEMA_NAME, onDraft));
    const error = await captureError(() =>
      createOpenAiLlmClient({ apiKey: "test-key", fetch: off.fetch, envelope: "v1.1a" }).callStructured(
        stageRequest(NAME_TABLE_SCHEMA_NAME, NAME_TABLE_SCHEMA),
      ),
    );
    expect(error.kind).toBe("malformed");
    expect(formatOf(bodyOf(off.captured)).schema).toEqual(ENVELOPE_SCHEMA_V11A);
  });

  it("どの封筒の枝とも違う段の schema は、その段の枝だけを差し替えた封筒で送る（ほかの枝は選んだ封筒のまま）", async () => {
    const custom = { ...NAME_TABLE_SCHEMA, description: "差し替えた schema" };
    const { fetch, captured } = recordingFetch(replyWith(NAME_TABLE_SCHEMA_NAME, { rows: [], requirements: [] }));
    await createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" })
      .callStructured(stageRequest(NAME_TABLE_SCHEMA_NAME, custom))
      .catch(() => undefined);
    expect(formatOf(bodyOf(captured)).schema).toEqual(
      buildEnvelopeSchema(
        STAGE_ENVELOPE_ENTRIES_V11A.map((entry) =>
          entry.stage === NAME_TABLE_SCHEMA_NAME ? { stage: entry.stage, schema: custom } : entry,
        ),
      ),
    );
  });
});

// ── Issue #588：経路 v1.2 の封筒は 1 つ（識別子 v1.2 で全段が同じ実体を送る）──────────

describe("識別子 v1.2 の client は、封筒に載る全段に同じ v1.2 の封筒を送る（Issue #588）", () => {
  /** 送るだけ見る（応答は捨てる。形の誤りでも送った body は残る） */
  async function sentFormat(envelope: "v1.1a" | "v1.2", schemaName: string, schema: unknown) {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify(enveloped(schemaName, {}))), USAGE_WIRE)),
    );
    await createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope })
      .callStructured(stageRequest(schemaName, schema))
      .catch(() => undefined);
    return formatOf(bodyOf(captured));
  }

  /** 旗 on の T1・T2（台帳の schema）と、台帳の導出を持たない T1''・B1・B3'・B5' の要求の schema */
  const v12Requests = (ids = false): readonly { readonly stage: string; readonly schema: unknown }[] => [
    { stage: NAME_TABLE_SCHEMA_NAME, schema: nameTableSchemaOf(PROPERTY_LEDGER_VIEW) },
    { stage: TEST_SPEC_SCHEMA_NAME, schema: testSpecSchemaOf(PROPERTY_LEDGER_VIEW, ids) },
    ...STAGE_ENVELOPE_ENTRIES_V11A.filter(
      (entry) => entry.stage !== NAME_TABLE_SCHEMA_NAME && entry.stage !== TEST_SPEC_SCHEMA_NAME,
    ),
  ];

  it("旗 on の T1・T2 と T1''・B1・B3'・B5' の 6 段が、名前 stage-envelope-v12 の同じバイト列の封筒を送る", async () => {
    // 識別子 v1.2 は ids off の v1.2 の走りの封筒（T2 は ids off の schema。ids on の場合の schema は識別子 v1.2-ids で送る。#624・#682）
    const requests = v12Requests();
    expect(requests).toHaveLength(6);
    const sent = new Set<string>();
    for (const request of requests) {
      const format = await sentFormat("v1.2", request.stage, JSON.parse(JSON.stringify(request.schema)));
      expect(format.name, request.stage).toBe(ENVELOPE_SCHEMA_NAME_V12);
      expect(format.schema, request.stage).toEqual(ENVELOPE_SCHEMA_V12);
      expect(format.strict, request.stage).toBe(true);
      const branches = (((format.schema as Record<string, unknown>)["properties"] as Record<string, unknown>)["result"] as {
        readonly anyOf: readonly unknown[];
      }).anyOf;
      expect(branches, request.stage).toContainEqual(buildStageBranch({ stage: request.stage, schema: request.schema }));
      sent.add(JSON.stringify(format));
    }
    expect(sent.size).toBe(1);
  });

  it("同じ要求を識別子 v1.1a で送ると、今のまま 2 種類の封筒（旗 on の T1・T2 とほかの段で前置きが違う）", async () => {
    const sent = new Set<string>();
    for (const request of v12Requests()) {
      const format = await sentFormat("v1.1a", request.stage, request.schema);
      expect(format.name, request.stage).toBe(ENVELOPE_SCHEMA_NAME_V11A);
      sent.add(JSON.stringify(format.schema));
    }
    expect(sent).toEqual(new Set([JSON.stringify(ENVELOPE_SCHEMA_V12_LEDGER), JSON.stringify(ENVELOPE_SCHEMA_V11A)]));
  });

  it("v1.2 の一覧に無い名前（判定の口・差分の洗い出し・v1 だけの段）は、その schema をそのまま送る", async () => {
    for (const [name, schema] of [
      ["judge-answers", SCHEMA],
      [SURFACE_DIFF_SCHEMA_NAME, DIFF_SCHEMA],
      [DESIGN_SCHEMA_NAME, DESIGN_SCHEMA],
    ] as const) {
      const format = await sentFormat("v1.2", name, schema);
      expect(format.name, name).toBe(name);
      expect(format.schema, name).toEqual(schema);
    }
  });

  it("識別子 v1.2 の client も、応答の stage が違えば形の誤り（取り出しは緩めない）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify(enveloped(TEST_SPEC_SCHEMA_NAME, { rows: [], requirements: [] }))), USAGE_WIRE)),
    );
    const error = await captureError(() =>
      createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.2" }).callStructured(
        stageRequest(NAME_TABLE_SCHEMA_NAME, nameTableSchemaOf(PROPERTY_LEDGER_VIEW)),
      ),
    );
    expect(error.kind).toBe("malformed");
  });
});

// ── Issue #682：旗 ids on の v1.2 は識別子 v1.2-ids の封筒（C2 の枝が検査の種類ごとの欄）を全段で送る ──────────

describe("識別子 v1.2-ids の client は、C1・C2 と T1''〜B5' の全段に同じ封筒を送り、C2 の応答は欄の写像の形で照らす（Issue #682）", () => {
  async function sentFormat(envelope: "v1.2" | "v1.2-ids", schemaName: string, schema: unknown) {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify(enveloped(schemaName, {}))), USAGE_WIRE)),
    );
    await createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope })
      .callStructured(stageRequest(schemaName, schema))
      .catch(() => undefined);
    return formatOf(bodyOf(captured));
  }

  /**
   * ids on の v1.2 の走りの全段の要求の schema（T1 は呼ばないが、封筒の枝としては載る）。T2 は旗 ids の場合の schema（#624・#625）。
   * `ids` を偽にすると T2 だけ ids off の schema（識別子 v1.2 の走りが渡すもの）
   */
  const idsRequests = (ids = true): readonly { readonly stage: string; readonly schema: unknown }[] => [
    { stage: TEST_SPEC_SCHEMA_NAME, schema: testSpecSchemaOf(PROPERTY_LEDGER_VIEW, ids) },
    ...STAGE_ENVELOPE_ENTRIES_V11A.filter((entry) => entry.stage !== NAME_TABLE_SCHEMA_NAME && entry.stage !== TEST_SPEC_SCHEMA_NAME),
    ...VOCABULARY_BUNDLES.map((bundle) => ({ stage: VOCABULARY_SCHEMA_NAMES[bundle], schema: vocabularySchemaOf(bundle, PROPERTY_LEDGER_VIEW) })),
    { stage: MAPPING_SCHEMA_NAME, schema: mappingSchemaOf(PROPERTY_LEDGER_VIEW) },
  ];

  it("C1・C2 と T1''・T2・B1・B3'・B5' の 9 段が、名前 stage-envelope-v12 の 1 種類のバイト列（識別子 v1.2-ids の封筒）を送る", async () => {
    const requests = idsRequests();
    expect(requests).toHaveLength(9);
    const sent = new Set<string>();
    for (const request of requests) {
      const format = await sentFormat("v1.2-ids", request.stage, JSON.parse(JSON.stringify(request.schema)));
      expect(format.name, request.stage).toBe(ENVELOPE_SCHEMA_NAME_V12);
      expect(format.schema, request.stage).toEqual(ENVELOPE_SCHEMA_V12_IDS);
      expect(format.strict, request.stage).toBe(true);
      sent.add(JSON.stringify(format));
    }
    expect(sent.size).toBe(1);
  });

  it("識別子 v1.2（ids off）の C2 以外の段は、今までどおり識別子 v1.2 の封筒を送る（ids on の封筒と別のバイト列）", async () => {
    for (const request of idsRequests(false).filter((entry) => entry.stage !== MAPPING_SCHEMA_NAME)) {
      const format = await sentFormat("v1.2", request.stage, request.schema);
      expect(format.name, request.stage).toBe(ENVELOPE_SCHEMA_NAME_V12);
      expect(format.schema, request.stage).toEqual(ENVELOPE_SCHEMA_V12);
      expect(format.schema, request.stage).not.toEqual(ENVELOPE_SCHEMA_V12_IDS);
    }
  });

  /** C2 の応答（要件 1 件。checks だけを差し替える） */
  const mappingOutput = (checks: unknown) => ({
    requirements: [
      {
        requirementId: "R1",
        roles: [{ id: "V1", basis: "stated", reason: null }],
        verification: { kind: "structural", value: null, reason: "画面に出ることだけ", checks, constraintIds: [] },
        nature: "existence-only",
      },
    ],
  });
  const fields = (set: Record<string, unknown>) =>
    Object.fromEntries(
      ["field-type", "action-kind", "action-unconditioned", "view-shows", "aggregate-no-period", "write-anonymous"].map((check) => [check, set[check] ?? null]),
    );
  const callMapping = (output: unknown) => {
    const { fetch } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify(enveloped(MAPPING_SCHEMA_NAME, output as Record<string, unknown>))), USAGE_WIRE)));
    return createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.2-ids" }).callStructured<Record<string, unknown>>(
      stageRequest(MAPPING_SCHEMA_NAME, mappingSchemaOf(PROPERTY_LEDGER_VIEW)),
    );
  };

  it("欄の写像の C2 の応答（各欄は null か対象の並び。view-shows の要素だけ sourceId・ほかの欄は null）は受け、そのまま段へ渡す（Issue #724：同じ種類の対象を 2 つ以上並べてよい）", async () => {
    for (const checks of [
      fields({ "view-shows": [{ targetId: "V1", sourceId: "E1.F1" }] }),
      fields({ "view-shows": [{ targetId: "V1", sourceId: "E1.F1" }, { targetId: "V1", sourceId: "E1.F2" }] }),
      fields({ "action-kind": [{ targetId: "OP1" }, { targetId: "OP2" }], "field-type": [{ targetId: "E1.F1" }] }),
    ]) {
      const output = mappingOutput(checks);
      expect((await callMapping(output)).output, JSON.stringify(checks)).toEqual(output);
    }
    expect((await callMapping(mappingOutput(null))).output).toEqual(mappingOutput(null));
  });

  it("負例 (6)：view-shows でない欄の要素に sourceId を持つ応答・配列の形の checks・欄の欠けた checks・並びでない欄（直す前の写像の欄）は、adapter の schema の検査で形の誤り", async () => {
    for (const checks of [
      fields({ "field-type": [{ targetId: "E1.F1", sourceId: "E1.F1" }] }),
      [{ check: "view-shows", targetId: "V1", sourceId: "E1.F1" }],
      { "view-shows": [{ targetId: "V1", sourceId: "E1.F1" }] },
      fields({ "view-shows": [{ targetId: "V1", sourceId: null }] }),
      fields({ "view-shows": { targetId: "V1", sourceId: "E1.F1" } }),
    ]) {
      const error = await captureError(() => callMapping(mappingOutput(checks)));
      expect(error.kind, JSON.stringify(checks)).toBe("malformed");
    }
  });
});

// ── Issue #483：差分専用の schema は封筒の外で送り、enum の外は形の誤りにする ──────────

/** 差分の洗い出しの要求の schema（封筒に載せない。`enum` つき） */
const DIFF_SCHEMA = buildSurfaceDiffSchema(["R:A:Q1-1", "R:A:Q1-2"]);

describe("差分の洗い出しの schema（enum）を、封筒の外で送る（02 §2・Issue #483）", () => {
  it("封筒に載っていない差分専用の schema は、名前も schema（enum つき）もそのまま送る", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(completed(outputText(JSON.stringify({ ambiguities: [], unwritable: [] })), USAGE_WIRE)),
    );
    await clientWith(fetch).callStructured(stageRequest(SURFACE_DIFF_SCHEMA_NAME, DIFF_SCHEMA));

    const format = formatOf(bodyOf(captured));
    expect(format.name).toBe(SURFACE_DIFF_SCHEMA_NAME);
    expect(format.schema).toEqual(DIFF_SCHEMA);
    // enum は schema の中に残っている
    expect(JSON.stringify(format.schema)).toContain('"R:A:Q1-1"');
    expect(format.strict).toBe(true);
  });

  it("封筒に載っている段の要求は、今のまま封筒の schema を送る", async () => {
    const { fetch, captured } = recordingFetch(() =>
      jsonResponse(
        completed(
          outputText(JSON.stringify(enveloped(SURFACE_SCHEMA_NAME, { ambiguities: [], unwritable: [] }))),
          USAGE_WIRE,
        ),
      ),
    );
    await clientWith(fetch).callStructured(stageRequest(SURFACE_SCHEMA_NAME, SURFACE_SCHEMA));

    const format = formatOf(bodyOf(captured));
    expect(format.name).toBe(ENVELOPE_SCHEMA_NAME);
    expect(format.schema).toEqual(ENVELOPE_SCHEMA);
    expect(format.strict).toBe(true);
  });

  it("差分専用の schema の enum に無い要件 ID を含む応答は、形の誤り（malformed）になる", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed(
          outputText(
            JSON.stringify({
              ambiguities: [{ id: "OI-1", requirementId: "R-9", text: "対象外", critical: true }],
              unwritable: [],
            }),
          ),
          USAGE_WIRE,
        ),
      ),
    );
    const error = await captureError(() =>
      clientWith(fetch).callStructured(stageRequest(SURFACE_DIFF_SCHEMA_NAME, DIFF_SCHEMA)),
    );
    expect(error.kind).toBe("malformed");
  });

  it("差分専用の名前は封筒から引けない（adapter はそのまま送る）", () => {
    expect(envelopeStageFor(SURFACE_DIFF_SCHEMA_NAME)).toBeUndefined();
  });
});

// ── 3.8. 構造の検査を持つ試験の段の応答（#386）────────────────────────────

/**
 * 試験の段の応答（**構造の検査** 1 本。strict の schema に合わせ、`assertion` の欄をすべて埋める。
 * Issue #386）。`expected.value` と `input` は JSON の**文字列**である。
 */
const STRUCTURAL_TEST_SUITE_OUTPUT = {
  classifications: [{ requirementId: "R-1", nature: "ruled" }],
  tests: [
    {
      id: "t1",
      target: { requirementId: "R-1", kind: "operation", roleId: "record.add" },
      kind: "normal",
      operation: "structure",
      clock: "2026-09-16T12:00:00+09:00",
      input: "{}",
      inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: "true", code: null },
      assertion: { check: "action-kind", expected: "create", refEntity: null, role: null },
    },
  ],
};

describe("構造の検査を持つ試験の段の応答が、封筒を通る（02 §2・Issue #386）", () => {
  it("構造の検査を持つ応答は、封筒を通り、assertion を保つ", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed(
          outputText(JSON.stringify(enveloped(TEST_SUITE_SCHEMA_NAME, STRUCTURAL_TEST_SUITE_OUTPUT))),
          USAGE_WIRE,
        ),
      ),
    );
    const response = await clientWith(fetch).callStructured<Record<string, unknown>>(
      stageRequest(TEST_SUITE_SCHEMA_NAME, TEST_SUITE_SCHEMA),
    );
    const tests = response.output["tests"] as readonly Record<string, unknown>[];
    expect(tests).toHaveLength(1);
    expect(tests[0]?.["assertion"]).toEqual({ check: "action-kind", expected: "create", refEntity: null, role: null });
    expect(response.output).not.toHaveProperty("stage");
  });

  it("assertion の欄が欠けた応答は、形の誤り（malformed）になる", async () => {
    const withoutAssertion = {
      classifications: [{ requirementId: "R-1", nature: "ruled" }],
      tests: [
        {
          id: "t1",
          target: { requirementId: "R-1", kind: "operation", roleId: "record.add" },
          kind: "normal",
          operation: "structure",
          clock: "2026-09-16T12:00:00+09:00",
          input: "{}",
          inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
          referenceData: [],
          expected: { kind: "ok", value: "true", code: null },
        },
      ],
    };
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed(outputText(JSON.stringify(enveloped(TEST_SUITE_SCHEMA_NAME, withoutAssertion))), USAGE_WIRE),
      ),
    );
    const error = await captureError(() =>
      clientWith(fetch).callStructured(stageRequest(TEST_SUITE_SCHEMA_NAME, TEST_SUITE_SCHEMA)),
    );
    expect(error.kind).toBe("malformed");
  });

  it("assertion の形が違う応答は、形の誤り（malformed）になる", async () => {
    const wrongShape = {
      ...STRUCTURAL_TEST_SUITE_OUTPUT,
      tests: [
        {
          ...STRUCTURAL_TEST_SUITE_OUTPUT.tests[0],
          assertion: { check: "nope", expected: null, refEntity: null, role: null },
        },
      ],
    };
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed(outputText(JSON.stringify(enveloped(TEST_SUITE_SCHEMA_NAME, wrongShape))), USAGE_WIRE),
      ),
    );
    const error = await captureError(() =>
      clientWith(fetch).callStructured(stageRequest(TEST_SUITE_SCHEMA_NAME, TEST_SUITE_SCHEMA)),
    );
    expect(error.kind).toBe("malformed");
  });

  it("write-anonymous を持つ応答も、封筒を通る（Issue #393）", async () => {
    const writeAnonymousSuite = {
      ...STRUCTURAL_TEST_SUITE_OUTPUT,
      tests: [
        {
          ...STRUCTURAL_TEST_SUITE_OUTPUT.tests[0],
          assertion: { check: "write-anonymous", expected: null, refEntity: null, role: null },
        },
      ],
    };
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed(outputText(JSON.stringify(enveloped(TEST_SUITE_SCHEMA_NAME, writeAnonymousSuite))), USAGE_WIRE),
      ),
    );
    const response = await clientWith(fetch).callStructured<Record<string, unknown>>(
      stageRequest(TEST_SUITE_SCHEMA_NAME, TEST_SUITE_SCHEMA),
    );
    const tests = response.output["tests"] as readonly Record<string, unknown>[];
    expect(tests).toHaveLength(1);
    expect(tests[0]?.["assertion"]).toEqual({
      check: "write-anonymous",
      expected: null,
      refEntity: null,
      role: null,
    });
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

  it("キャッシュの書き込みの欄が無ければ 0 にして、読み取りと分けて持つ（#302）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(
        completed(outputText(JSON.stringify({ items: [1] })), {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
        }),
      ),
    );
    const response = await clientWith(fetch).callStructured(STRUCTURED_REQUEST);
    expect(response.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 5,
    });
  });

  it("壊れた usage（数でない・負・内訳が合計を超える）は「usage なし」にする", async () => {
    const broken: readonly unknown[] = [
      { input_tokens: "100", output_tokens: 20 },
      { input_tokens: -1, output_tokens: 20 },
      { input_tokens: 10.5, output_tokens: 20 },
      { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 200 } },
      { input_tokens: 100, output_tokens: 20, input_tokens_details: { cache_write_tokens: 200 } },
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

  it("HTTP 400（invalid_json_schema）は、要求の誤りとして分類し、種類だけを持つ（本文は残さない）", async () => {
    const error = await errorKindOf(() =>
      jsonResponse(
        {
          error: {
            message: "BODY_SENTINEL: schema must have a 'type' key",
            type: "invalid_request_error",
            code: "invalid_json_schema",
          },
        },
        400,
      ),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_json_schema");
    // 本文の全文は、誤りにも残さない（種類だけ）
    expect(error.message).not.toContain("BODY_SENTINEL");
  });

  it("HTTP 400 で code が無くても、要求の誤りとして分類する", async () => {
    const error = await errorKindOf(() => jsonResponse({ error: { message: "bad" } }, 400));
    expect(error.kind).toBe("invalidRequest");
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request_error");
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

  it("未完了の応答の誤りは、理由と usage を持つ（§1.5・§2.2）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: outputText(JSON.stringify({ items: [1, 2] })),
        usage: USAGE_WIRE,
      }),
    );
    const error = await captureError(() => clientWith(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error).toBeInstanceOf(OpenAiIncompleteError);
    if (!(error instanceof OpenAiIncompleteError)) return;
    expect(error.kind).toBe("incomplete");
    expect(error.reason).toBe("max_output_tokens");
    expect(error.usage).toEqual(USAGE);
  });

  it("usage が無い未完了の応答は、理由だけを持つ（予約は残る側）", async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output: outputText(JSON.stringify({ items: [] })),
      }),
    );
    const error = await captureError(() => clientWith(fetch).callStructured(STRUCTURED_REQUEST));
    expect(error).toBeInstanceOf(OpenAiIncompleteError);
    if (!(error instanceof OpenAiIncompleteError)) return;
    expect(error.reason).toBe("content_filter");
    expect(error.usage).toBeUndefined();
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

  it("合図（signal）が渡されたら自分の時計を持たず、合図の中断で timeout にする（#302）", async () => {
    const client = clientWith(hangingFetch, 5);
    const controller = new AbortController();
    const pending = client.callStructured({ ...STRUCTURED_REQUEST, signal: controller.signal });
    // adapter の時計（5ms）では打ち切られない（呼ぶ側が timeout を持つ）
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    const error = await captureError(() => pending);
    expect(error.kind).toBe("timeout");
  });

  it("ヘッダーの後に本文が止まっても、中断の合図で待機が終わる（Issue #455）", async () => {
    // 応答のヘッダーは返すが、本文は止まったままになる fetch（合図の中断で本文を誤らせる）
    let headersReturned: () => void = () => {};
    const returned = new Promise<void>((resolve) => {
      headersReturned = resolve;
    });
    const stallingBodyFetch: FetchLike = (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      headersReturned();
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
      );
    };
    const client = clientWith(stallingBodyFetch, 5);
    const controller = new AbortController();

    const pending = client.callStructured({ ...STRUCTURED_REQUEST, signal: controller.signal });
    // ヘッダーが返ってから合図を出す——ここで合図を外していると、本文の待機が終わらない
    await returned;
    controller.abort();

    const error = await captureError(() => pending);
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

// ── 3.8. 構造化出力の形の誤りの種類の印（Issue #783）────────────────────────
//
// adapter は、構造化出力の本文を形の誤りとしたとき、**今の検査の順のまま**投げる所に印（`malformedKind`）を付ける。
// 印は 5 つ：`no-body`・`not-json`・`envelope`・`wrong-stage`・`schema`。付かない malformed（道具付きの宣言の
// 本文・wire の JSON・status の欠落）は `undefined`（共通の口が `other` として数える）。
describe("構造化出力の形の誤りに、種類の印を付ける（Issue #783）", () => {
  /** 封筒ありの段（要求の schema は封筒の枝と等しい）で印を取る */
  async function envelopeMarkOf(reply: () => Response | Promise<Response>): Promise<string | undefined> {
    const { fetch } = recordingFetch(reply);
    const error = await captureError(() =>
      clientWith(fetch).callStructured(stageRequest(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_SCHEMA)),
    );
    expect(error.kind).toBe("malformed");
    return error.malformedKind;
  }

  it("本文が無い：no-body", async () => {
    expect(await envelopeMarkOf(() => jsonResponse(completed([], USAGE_WIRE)))).toBe("no-body");
  });

  it("本文が JSON として読めない：not-json", async () => {
    expect(await envelopeMarkOf(() => jsonResponse(completed(outputText("これは JSON ではない"))))).toBe("not-json");
  });

  it("封筒の外側が object でない：envelope", async () => {
    expect(await envelopeMarkOf(() => jsonResponse(completed(outputText(JSON.stringify(["配列"])))))).toBe("envelope");
  });

  it("result が object でない：envelope", async () => {
    expect(await envelopeMarkOf(() => jsonResponse(completed(outputText(JSON.stringify({ result: "文字列" })))))).toBe("envelope");
  });

  it("封筒の stage がその段でない：wrong-stage", async () => {
    const wrong = JSON.stringify(enveloped(REVERSE_CHECK_SCHEMA_NAME, REVERSE_OUTPUT));
    expect(await envelopeMarkOf(() => jsonResponse(completed(outputText(wrong))))).toBe("wrong-stage");
  });

  it("封筒の段の枝の schema に合わない：schema", async () => {
    const bad = JSON.stringify(enveloped(REQUIREMENTS_SCHEMA_NAME, { requirements: "文字列" }));
    expect(await envelopeMarkOf(() => jsonResponse(completed(outputText(bad))))).toBe("schema");
  });

  it.each([
    { name: "本文が無い", mark: "no-body", reply: () => jsonResponse(completed([], USAGE_WIRE)) },
    { name: "JSON として読めない", mark: "not-json", reply: () => jsonResponse(completed(outputText("これは JSON ではない"))) },
    { name: "要求の schema に合わない", mark: "schema", reply: () => jsonResponse(completed(outputText(JSON.stringify({ items: ["文字列"] })))) },
  ])("封筒の外の段（判定の口の schema）：$name に印 $mark を付ける", async ({ mark, reply }) => {
    const { fetch } = recordingFetch(reply);
    const error = await captureError(() =>
      clientWith(fetch).callStructured(stageRequest("judge-answers", SCHEMA)),
    );
    expect(error.kind).toBe("malformed");
    expect(error.malformedKind).toBe(mark);
  });

  it("印を付けない malformed：道具付きの宣言の本文・wire の JSON・status の欠落", async () => {
    const toolsNoBody = await captureError(() =>
      clientWith(recordingFetch(() => jsonResponse(completed([], USAGE_WIRE))).fetch).callWithTools(TOOL_REQUEST),
    );
    expect(toolsNoBody.kind).toBe("malformed");
    expect(toolsNoBody.malformedKind).toBeUndefined();

    const wireNotJson = await captureError(() =>
      clientWith(recordingFetch(() => new Response("これは JSON ではない", { status: 200 })).fetch).callStructured(
        STRUCTURED_REQUEST,
      ),
    );
    expect(wireNotJson.kind).toBe("malformed");
    expect(wireNotJson.malformedKind).toBeUndefined();

    const noStatus = await captureError(() =>
      clientWith(
        recordingFetch(() =>
          jsonResponse({ output: outputText(JSON.stringify(enveloped(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_OUTPUT))) }),
        ).fetch,
      ).callStructured(stageRequest(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_SCHEMA)),
    );
    expect(noStatus.kind).toBe("malformed");
    expect(noStatus.malformedKind).toBeUndefined();
  });

  it("道具の引数の誤り（toolArguments）は malformed ではなく、印も持たない", async () => {
    const error = await captureError(() =>
      clientWith(
        recordingFetch(() =>
          jsonResponse(
            completed([{ type: "function_call", call_id: "call-1", name: "staticCheck", arguments: "これは JSON ではない" }]),
          ),
        ).fetch,
      ).callWithTools(TOOL_REQUEST),
    );
    expect(error.kind).toBe("toolArguments");
    expect(error.malformedKind).toBeUndefined();
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

// ── 3.9. 共有の body の末尾に足す固定の欄（`extraBody`。Issue #788）────────────────────

/** `extraBody` を渡せる client（宛先は固定の偽の値。偽物の fetch で body を観測する） */
const responsesClient = (fetch: FetchLike, extraBody?: Readonly<Record<string, unknown>>) =>
  createResponsesLlmClient({
    apiKey: "test-key",
    model: SHARED_BODY_MODEL,
    url: "https://example.test/v1/responses",
    fetch,
    ...(extraBody === undefined ? {} : { extraBody }),
  });

/**
 * 予約名の**試験側の独立した固定の一覧**（Issue #788 の 11 名。要求で省かれる欄の名前を含む全部）。
 * 実装の `RESPONSES_BODY_RESERVED_KEYS` を列挙しない——実装から名前が抜けると試験対象も抜けるため（レビュー R4）。
 */
const RESERVED_BODY_NAMES_FIXED = [
  "model",
  "store",
  "max_output_tokens",
  "instructions",
  "prompt_cache_key",
  "prompt_cache_options",
  "input",
  "reasoning",
  "text",
  "tools",
  "tool_choice",
] as const;

describe("extraBody：body を組み終えた最後に固定の欄を足す（Issue #788）", () => {
  it("渡さなければ body は今とバイト列で同じ（比較元の固定値と一致する）", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [] })))));
    const client = responsesClient(fetch);
    await client.callStructured(SHARED_STRUCTURED_REQUEST);
    expect(JSON.stringify(captured[0]!.body)).toBe(SHARED_STRUCTURED_BODY_JSON);
    await client.callWithTools(SHARED_TOOL_REQUEST);
    expect(JSON.stringify(captured[1]!.body)).toBe(SHARED_TOOL_BODY_JSON);
  });

  it("構造化出力の body の**最後**に 1 欄を足す（ほかの欄の並びと値は同じ）", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [] })))));
    const provider = { only: ["x"], require_parameters: true, allow_fallbacks: false };
    await responsesClient(fetch, { provider }).callStructured(SHARED_STRUCTURED_REQUEST);
    const body = captured[0]!.body;
    expect(Object.keys(body).at(-1)).toBe("provider");
    const { provider: _provider, ...rest } = body;
    expect(JSON.stringify(rest)).toBe(SHARED_STRUCTURED_BODY_JSON);
  });

  it("道具付きの body（通常・finalAnswerOnly）のどちらの最後にも足す", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ entity: "item" })))));
    const client = responsesClient(fetch, { provider: "fixed" });
    await client.callWithTools(SHARED_TOOL_REQUEST);
    await client.callWithTools({ ...TOOL_REQUEST, schemaName: "answer", schema: SCHEMA, finalAnswerOnly: true });
    for (const index of [0, 1]) {
      expect(Object.keys(captured[index]!.body).at(-1), String(index)).toBe("provider");
      expect(captured[index]!.body["provider"], String(index)).toBe("fixed");
      const { provider: _provider, ...rest } = captured[index]!.body;
      expect(rest["tools"], String(index)).toBeDefined();
    }
  });

  it("予約名の集合が、試験側の独立した固定の 11 名と一致する（Issue #788 レビュー R4。実装から名前が抜けたら赤）", () => {
    // 実装の定数を列挙しない（実装から名前が抜けると試験対象も抜けるため）。Issue の 11 名を固定で持つ
    expect([...RESPONSES_BODY_RESERVED_KEYS].sort()).toEqual([...RESERVED_BODY_NAMES_FIXED].sort());
    expect(RESERVED_BODY_NAMES_FIXED).toHaveLength(11);
  });

  it("予約名（独立の固定の 11 名。要求で省かれる欄の名前を含む全部）は受けず、作るときに投げる（fetch 0 回）", () => {
    for (const key of RESERVED_BODY_NAMES_FIXED) {
      const recording = recordingFetch(() => jsonResponse(completed(outputText("{}"))));
      const fetch = vi.fn(recording.fetch);
      expect(() => responsesClient(fetch, { [key]: 1 }), key).toThrow();
      expect(fetch, key).not.toHaveBeenCalled();
    }
  });

  it("整数の形の名前は受けず、作るときに投げる（fetch 0 回）", () => {
    for (const key of ["0", "1", "42"]) {
      const recording = recordingFetch(() => jsonResponse(completed(outputText("{}"))));
      const fetch = vi.fn(recording.fetch);
      expect(() => responsesClient(fetch, { [key]: 1 }), key).toThrow();
      expect(fetch, key).not.toHaveBeenCalled();
    }
  });

  it("JSON の値でないもの（関数・undefined・NaN・Infinity・toJSON を持つ値）は受けず、作るときに投げる（fetch 0 回。Issue #788 レビュー R1）", () => {
    const cases: readonly { readonly name: string; readonly value: Readonly<Record<string, unknown>> }[] = [
      { name: "トップレベルの関数", value: { custom: () => 1 } },
      { name: "トップレベルの undefined", value: { custom: undefined } },
      { name: "NaN", value: { custom: Number.NaN } },
      { name: "Infinity", value: { custom: Number.POSITIVE_INFINITY } },
      { name: "入れ子の関数", value: { custom: { deep: () => 1 } } },
      { name: "入れ子の undefined", value: { custom: [1, undefined] } },
      { name: "bigint", value: { custom: 1n } },
      // JSON.stringify が toJSON を呼び、鍵をすり替えて model を上書きし整数キーを先頭へ出せる（レビュー R1 の再現）
      { name: "トップレベルの toJSON（鍵のすり替え）", value: { toJSON: () => ({ model: "overwritten", "0": "first" }) } },
      { name: "入れ子の toJSON", value: { custom: { toJSON: () => ({ model: "overwritten" }) } } },
    ];
    for (const c of cases) {
      const recording = recordingFetch(() => jsonResponse(completed(outputText("{}"))));
      const fetch = vi.fn(recording.fetch);
      expect(() => responsesClient(fetch, c.value), c.name).toThrow();
      expect(fetch, c.name).not.toHaveBeenCalled();
    }
  });

  it("JSON の値は再帰的にそのまま複製され、NaN を null に変えない（Issue #788 レビュー R1）", async () => {
    const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [] })))));
    await responsesClient(fetch, { provider: { keep: [1, 2.5, true, null, "x"], nested: { deep: [3] } } }).callStructured(
      SHARED_STRUCTURED_REQUEST,
    );
    expect(captured[0]!.body["provider"]).toEqual({ keep: [1, 2.5, true, null, "x"], nested: { deep: [3] } });
  });

  it("`__proto__` という正当な JSON の名前も、値と末尾の位置を保って足す（Issue #788 レビュー R2）", async () => {
    // オブジェクトのリテラルの `__proto__` は prototype の指定になるので、必ず JSON.parse で作る
    const extraBody = JSON.parse('{"custom":{"marker":1},"__proto__":{"marker":1}}') as Record<string, unknown>;
    let sent = "";
    const rawFetch: FetchLike = async (_url, init) => {
      sent = String(init.body);
      return jsonResponse(completed(outputText(JSON.stringify({ items: [] }))));
    };
    await responsesClient(rawFetch, extraBody).callStructured(SHARED_STRUCTURED_REQUEST);
    // 送る本文の末尾に、`custom` の次（末尾）に `__proto__` の欄が現れる
    expect(sent.endsWith('"custom":{"marker":1},"__proto__":{"marker":1}}')).toBe(true);
    const body = JSON.parse(sent) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(body, "__proto__")?.value).toEqual({ marker: 1 });
    // body の prototype は変えていない（欄が消えて prototype が変わる、が再現しない）
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(body, "__proto__")?.enumerable).toBe(true);
  });

  it("値は作るときに複製して固定する（あとで元を書き換えても送る body は変わらない）", async () => {
    const value = { only: ["x"], nested: [1, 2] };
    const { fetch, captured } = recordingFetch(() => jsonResponse(completed(outputText(JSON.stringify({ items: [] })))));
    const client = responsesClient(fetch, { provider: value });
    value.only.push("y");
    value.nested.push(3);
    await client.callStructured(SHARED_STRUCTURED_REQUEST);
    expect(captured[0]!.body["provider"]).toEqual({ only: ["x"], nested: [1, 2] });
  });
});
