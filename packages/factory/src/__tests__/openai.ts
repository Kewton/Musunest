// adapter の 3 つ（OpenAI・Ollama・OpenRouter）が**同じ共有の body** を組むことを、固定の期待で照らす材料（Issue #788）。
//
// 期待は**比較元（main の凍結した checkout）の body をそのまま固定した値**である（欄の並びまで含む JSON の文字列）。
// 共有の実装（`../openai.ts` の `createResponsesLlmClient`）は、`extraBody` を渡さなければ比較元とバイト列で同じ body を
// 送る——この事実は既存の比較元の記録（`__fixtures__/baseline-2cd1586/cli.json`。cli.test.ts の「--pipeline を
// 省いた入口は、凍結した比較元の記録と同じ」）が照らしている。下の固定値は、同じ道具で今の木から採った body を
// そのまま置いたものである（比較元と body が同じであることは、その記録の試験が担保する）。
//
// ここに固定値を置くのは、**共有の body の欄（並び・`text`・`tools`）を壊す変異で、3 つの adapter の試験がそろって
// 赤になる**ようにするためである。3 つとも、この同じ固定値と（Ollama は schema の塊を、OpenRouter は `provider` を
// 除いて）照らす。
import type { LlmStructuredRequest, LlmToolRequest } from "../llm.js";

/** 固定の期待を取るモデル（3 つの adapter に同じ値を渡す） */
export const SHARED_BODY_MODEL = "shared-model";

/** 固定の期待を取る構造化出力の要求（`text.format` を踏む） */
export const SHARED_STRUCTURED_REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  rules: [],
  input: "依頼文",
  schemaName: "shared-out",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { type: "number" } } },
  },
  maxOutputTokens: 128,
};

/** 固定の期待を取る道具付きの要求（`tools` を踏む。schema は無し） */
export const SHARED_TOOL_REQUEST: LlmToolRequest = {
  instructions: "規則",
  documents: ["文書"],
  rules: [],
  input: "宣言",
  tools: [{ name: "staticCheck", description: "静的チェックを流す", parameters: { type: "object" } }],
  turns: [],
  maxOutputTokens: 128,
};

/** 比較元の構造化出力の body（欄の並びまで含む。`text.format` を持つ） */
export const SHARED_STRUCTURED_BODY_JSON =
  '{"model":"shared-model","store":false,"max_output_tokens":128,"instructions":"規則","prompt_cache_key":"musunest-factory","prompt_cache_options":{"mode":"explicit"},"input":[{"role":"user","content":[{"type":"input_text","text":"文書","prompt_cache_breakpoint":{"mode":"explicit"}}]},{"role":"user","content":[{"type":"input_text","text":"<data>\\n依頼文\\n</data>"}]}],"text":{"format":{"type":"json_schema","name":"shared-out","schema":{"type":"object","additionalProperties":false,"required":["items"],"properties":{"items":{"type":"array","items":{"type":"number"}}}},"strict":true}}}';

/** 比較元の道具付きの body（欄の並びまで含む。`tools` を持つ） */
export const SHARED_TOOL_BODY_JSON =
  '{"model":"shared-model","store":false,"max_output_tokens":128,"instructions":"規則","prompt_cache_key":"musunest-factory","prompt_cache_options":{"mode":"explicit"},"input":[{"role":"user","content":[{"type":"input_text","text":"文書","prompt_cache_breakpoint":{"mode":"explicit"}}]},{"role":"user","content":[{"type":"input_text","text":"<data>\\n宣言\\n</data>"}]}],"tools":[{"type":"function","name":"staticCheck","description":"静的チェックを流す","parameters":{"type":"object"},"strict":true}]}';

/** schema の塊の頭の文（Ollama の body から塊を見つけるのに使う。openai.ts と同じ値） */
export const SHARED_SCHEMA_INSTRUCTION_PREFIX = "次の JSON Schema に合う JSON だけを返す。";

/** 入力の項目の形（role と content。除く処理のためだけに見る） */
type InputItem = { readonly role?: string; content?: { readonly type: string; readonly text?: string }[] };

/**
 * Ollama の body から schema の塊（`developer` の内容の塊のうち、頭の文で始まるもの）をすべて除いた写しを返す。
 * 塊だけになって空になった `developer` の項目は、項目ごと除く。ほかの欄・項目には触れない（Ollama は 1 つの
 * 構造化出力の要求に塊を 1 つだけ足す）。
 */
export function withoutSchemaBlock(body: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const input = copy["input"] as InputItem[];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (item.role !== "developer" || item.content === undefined) continue;
    item.content = item.content.filter(
      (block) => !(typeof block.text === "string" && block.text.startsWith(SHARED_SCHEMA_INSTRUCTION_PREFIX)),
    );
    if (item.content.length === 0) input.splice(index, 1);
  }
  return copy;
}

/** OpenRouter の body から `provider`（末尾に足した 1 欄）を除いた写しを返す（ほかの欄・並びは今のまま） */
export function withoutProvider(body: Record<string, unknown>): Record<string, unknown> {
  const { provider: _provider, ...rest } = body;
  return rest;
}
