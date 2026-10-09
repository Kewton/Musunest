// @musunest/factory —— OpenAI の Responses API の adapter（02-architecture.md §2・§2.1・§2.2）。
//
// 共通の契約の `LlmClient`（llm.ts）を、**`fetch` だけ**で実装する。手元でも Worker でも同じものが
// 動くように、Cloudflare 固有の API も Node 固有の API も使わない。**API キーを扱うのはここだけ**で、
// **環境変数は読まない**（読むのは手元の入口。別の Issue。§2.1・R-15）。
//
// 決めごと（§2・§2.2）：
//   * 構造化出力は Responses API の JSON Schema の出力（`text.format`）、道具付きは function calling。
//   * どちらも `store: false` と `max_output_tokens` を必ず送る。
//   * 規則（`instructions`）は**毎回**送る。会話はこちらで組み立てて `input` に並べる
//     （`previous_response_id` は送らない。§2 の「会話の状態」）。
//   * 依頼文などのデータは、規則とは別の入力として `<data>` で囲んで送る（§2.2「規則とデータを分ける」）。
//   * usage を共通の契約の形に直す。無い・壊れている（数でない・負・内訳が合計を超える）ときは
//     「usage なし」として返し、共通の口に予約を残させる（§1.5・R-6）。
//   * 誤りは型付きで分類する（`OpenAiAdapterError` の `kind`）。
//     HTTP の誤り（状態コード付き）・timeout・拒否・**未完了の応答**・形が合わない応答・
//     道具の引数が JSON として読めない・残高切れ。**JSON として読めても未完了の応答は成功にしない。**
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolRequest,
  LlmToolResponse,
  LlmTurn,
  LlmUsage,
} from "./llm.js";

/** Responses API の既定のモデル（§2 の表「モデル」） */
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

/** 呼び出しごとの timeout の既定（ミリ秒。§1.5「呼び出しごとに timeout」） */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Responses API の入口（1 か所に固定する。環境変数からは読まない） */
const RESPONSES_URL = "https://api.openai.com/v1/responses";

/** fetch の差し替え口。Workers・ブラウザ・Node のどれでも同じ形で呼べる範囲だけを要求する（§2.1） */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * adapter の誤りの種類（§2.2「拒否・不完全な応答」・§1.5・R-15）。呼ぶ側（共通の口・段）が
 * 「やり直すか・失敗にするか」を種類で分けられるようにする。
 */
export type OpenAiErrorKind =
  /** fetch 自体が失敗した（応答が返らなかった） */
  | "network"
  /** 呼び出しごとの timeout で打ち切った */
  | "timeout"
  /** HTTP の誤り（状態コード付き） */
  | "http"
  /** 残高切れ（`insufficient_quota`） */
  | "balance"
  /** モデルが拒否した */
  | "refusal"
  /** 未完了の応答（`status` が完了でない・出力の上限で切れた） */
  | "incomplete"
  /** 形が合わない応答（JSON でない・schema に合わない・必須の欄が無い） */
  | "malformed"
  /** 道具の引数が JSON として読めない */
  | "toolArguments";

/** adapter が投げる型付きの誤り（§2.2）。`kind` で分類し、HTTP の誤りは `status` を持つ */
export class OpenAiAdapterError extends Error {
  readonly kind: OpenAiErrorKind;
  /** HTTP の誤りの状態コード（それ以外は `undefined`） */
  readonly status: number | undefined;

  constructor(kind: OpenAiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "OpenAiAdapterError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * 未完了の応答（`status` が完了でない・出力の上限で切れた。§2.2・§1.5）。
 *
 * 未完了でも **usage は付くことがある**——共通の口（call.ts）が、成功と同じように実際の費用で
 * 予約を精算できるように、理由と usage を持たせる。**出力の上限で切れた応答は、同じ要求で
 * やり直しても同じところで切れる**ので、共通の口は同じ要求のままやり直さない。
 */
export class OpenAiIncompleteError extends OpenAiAdapterError {
  /** 未完了の理由（`incomplete_details.reason`。例: `max_output_tokens`）。無ければ空文字 */
  readonly reason: string;
  /** 未完了でも付く usage。無ければ `undefined`（共通の口が予約を残す） */
  readonly usage: LlmUsage | undefined;

  constructor(reason: string, usage: LlmUsage | undefined, message: string) {
    super("incomplete", message);
    this.name = "OpenAiIncompleteError";
    this.reason = reason;
    this.usage = usage;
  }
}

/** adapter を作る関数の引数（Issue #284「やること」1） */
export interface OpenAiAdapterOptions {
  /** API キー。**環境変数からは読まない**。呼ぶ側（手元の入口）が渡す */
  readonly apiKey: string;
  /** モデル（既定 `gpt-6-luna`。§2） */
  readonly model?: string;
  /** 推論の effort（§2「品質優先で high から始める」）。渡さなければ送らない */
  readonly effort?: string;
  /** 差し込む `fetch`（既定 `globalThis.fetch`。§2.1） */
  readonly fetch?: FetchLike;
  /** 呼び出しごとの timeout（ミリ秒。既定 `DEFAULT_TIMEOUT_MS`） */
  readonly timeoutMs?: number;
}

interface WireConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly effort: string | undefined;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
}

/**
 * OpenAI の Responses API に対する `LlmClient` を作る（§2.1）。
 * `fetch` を差し込めるので、試験は実 API を呼ばずに要求の中身を観測できる。
 */
export function createOpenAiLlmClient(options: OpenAiAdapterOptions): LlmClient {
  const request = options.fetch ?? globalThis.fetch;
  if (request === undefined) {
    throw new Error("fetch がありません。options.fetch で渡してください");
  }
  const config: WireConfig = {
    apiKey: options.apiKey,
    model: options.model ?? DEFAULT_OPENAI_MODEL,
    effort: options.effort,
    fetch: request,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  return {
    callStructured: <T>(structuredRequest: LlmStructuredRequest) =>
      callStructuredWire<T>(config, structuredRequest),
    callWithTools: (toolRequest: LlmToolRequest) => callToolsWire(config, toolRequest),
  };
}

// ── 呼び出し（fetch と timeout。§1.5・§2.1）────────────────────────────────

/** 1 回の実呼び出し。timeout と、共通の口からの合図（`signal`）の両方で打ち切る */
async function send(config: WireConfig, body: unknown, signal: AbortSignal | undefined): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    return await config.fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut || signal?.aborted === true) {
      throw new OpenAiAdapterError("timeout", "呼び出しごとの timeout で打ち切りました");
    }
    throw new OpenAiAdapterError("network", `fetch が失敗しました: ${messageOf(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** 実呼び出しをして、応答を object として返す。HTTP の誤りと、JSON でない本文をここで分類する */
async function requestWire(
  config: WireConfig,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const response = await send(config, body, signal);
  const text = await readText(response);
  if (!response.ok) throw httpError(response.status, text);
  const parsed = tryParseJson(text);
  if (!parsed.ok) {
    throw new OpenAiAdapterError("malformed", "応答が JSON として読めません");
  }
  if (!isRecord(parsed.value)) {
    throw new OpenAiAdapterError("malformed", "応答が object ではありません");
  }
  return parsed.value;
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new OpenAiAdapterError("network", `応答の本文を読めませんでした: ${messageOf(error)}`);
  }
}

/** HTTP の誤りを分類する。`insufficient_quota` は残高切れとして分ける（§2.2・R-15） */
function httpError(status: number, text: string): OpenAiAdapterError {
  const parsed = tryParseJson(text);
  const code = parsed.ok ? errorCodeOf(parsed.value) : undefined;
  if (code === "insufficient_quota") {
    return new OpenAiAdapterError("balance", `残高が足りません（HTTP ${status}）`, status);
  }
  return new OpenAiAdapterError("http", `HTTP の誤り（HTTP ${status}）`, status);
}

function errorCodeOf(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const { error } = value;
  if (typeof error.code === "string") return error.code;
  if (typeof error.type === "string") return error.type;
  return undefined;
}

// ── 要求の組み立て（§2・§2.2）─────────────────────────────────────────────

/** 共通の要求を Responses API の body にする（`store: false`・`max_output_tokens`・`instructions`） */
function baseBody(
  config: WireConfig,
  instructions: string,
  input: readonly unknown[],
  maxOutputTokens: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    store: false,
    max_output_tokens: maxOutputTokens,
    instructions,
    input,
  };
  if (config.effort !== undefined) body.reasoning = { effort: config.effort };
  return body;
}

/** 構造化出力の body（`text.format` に JSON Schema を置く。§2） */
function buildStructuredBody(config: WireConfig, request: LlmStructuredRequest): Record<string, unknown> {
  const body = baseBody(
    config,
    request.instructions,
    buildInput(request.documents, request.input),
    request.maxOutputTokens,
  );
  body.text = {
    format: {
      type: "json_schema",
      name: request.schemaName,
      schema: request.schema,
      strict: true,
    },
  };
  return body;
}

/** 道具付きの body（`tools` に function calling を置き、往復を `input` に並べる。§2・R-2） */
function buildToolBody(config: WireConfig, request: LlmToolRequest): Record<string, unknown> {
  const input = [...buildInput(request.documents, request.input), ...turnsToInput(request.turns)];
  const body = baseBody(config, request.instructions, input, request.maxOutputTokens);
  body.tools = request.tools.map(toFunctionTool);
  return body;
}

/** 規則とは別の入力。文書を先頭に固定し（キャッシュの効く前置き）、データは `<data>` で囲む（§2.2） */
function buildInput(documents: readonly string[], data: string): unknown[] {
  const items: unknown[] = [];
  for (const document of documents) items.push(userText(document));
  items.push(userText(`<data>\n${data}\n</data>`));
  return items;
}

function userText(text: string): Record<string, unknown> {
  return { role: "user", content: [{ type: "input_text", text }] };
}

/** これまでの往復を Responses API の入力の項目に直す（こちらで組み立てて毎回送る。§2） */
function turnsToInput(turns: readonly LlmTurn[]): unknown[] {
  const items: unknown[] = [];
  for (const turn of turns) {
    if (turn.role === "assistant") {
      for (const call of turn.toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? null),
        });
      }
    } else {
      for (const result of turn.results) {
        items.push({
          type: "function_call_output",
          call_id: result.toolCallId,
          output: JSON.stringify(result.output ?? null),
        });
      }
    }
  }
  return items;
}

function toFunctionTool(tool: LlmToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  };
}

// ── 応答の解釈（§2.2）───────────────────────────────────────────────────

async function callStructuredWire<T>(
  config: WireConfig,
  request: LlmStructuredRequest,
): Promise<LlmStructuredResponse<T>> {
  const wire = await requestWire(config, buildStructuredBody(config, request), request.signal);
  const usage = parseUsage(wire.usage);
  requireCompleted(wire, usage);
  requireNoRefusal(wire);
  const text = extractOutputText(wire);
  if (text === undefined) throw new OpenAiAdapterError("malformed", "構造化出力の本文がありません");
  const parsed = tryParseJson(text);
  if (!parsed.ok) throw new OpenAiAdapterError("malformed", "構造化出力が JSON として読めません");
  const schemaError = validateSchema(request.schema, parsed.value);
  if (schemaError !== undefined) {
    throw new OpenAiAdapterError("malformed", `schema に合いません: ${schemaError}`);
  }
  return { output: parsed.value as T, usage };
}

async function callToolsWire(config: WireConfig, request: LlmToolRequest): Promise<LlmToolResponse> {
  const wire = await requestWire(config, buildToolBody(config, request), request.signal);
  const usage = parseUsage(wire.usage);
  requireCompleted(wire, usage);
  requireNoRefusal(wire);
  const toolCalls = extractFunctionCalls(wire);
  if (toolCalls.length > 0) return { kind: "toolCalls", toolCalls, usage };
  const text = extractOutputText(wire);
  if (text === undefined) throw new OpenAiAdapterError("malformed", "宣言の本文がありません");
  const parsed = tryParseJson(text);
  if (!parsed.ok) throw new OpenAiAdapterError("malformed", "宣言が JSON として読めません");
  return { kind: "done", declaration: parsed.value, usage };
}

/**
 * 応答が完了していることを確かめる（§2.2・§1.5）。`status` が `completed` でなければ未完了として
 * 分類する。**出力が JSON として読めても、未完了なら成功にしない**（`status` を先に見る）。
 * 未完了には、理由と（分かっていれば）usage を添える——共通の口が予約を精算できるようにする。
 */
function requireCompleted(wire: Record<string, unknown>, usage: LlmUsage | undefined): void {
  const status = wire.status;
  if (typeof status !== "string") {
    throw new OpenAiAdapterError("malformed", "応答に status がありません");
  }
  if (status !== "completed") {
    const reason = incompleteReasonValue(wire);
    throw new OpenAiIncompleteError(
      reason,
      usage,
      `応答が完了していません（status=${status}${reason === "" ? "" : `, reason=${reason}`}）`,
    );
  }
}

/** `incomplete_details.reason` を読む（無ければ空文字） */
function incompleteReasonValue(wire: Record<string, unknown>): string {
  const details = wire.incomplete_details;
  if (isRecord(details) && typeof details.reason === "string") return details.reason;
  return "";
}

/** 出力に拒否（`refusal`）があれば分類する（§2.2「拒否・不完全な応答」） */
function requireNoRefusal(wire: Record<string, unknown>): void {
  for (const item of outputItems(wire)) {
    if (!isRecord(item)) continue;
    for (const part of asArray(item.content) ?? []) {
      if (isRecord(part) && part.type === "refusal") {
        const text = typeof part.refusal === "string" ? part.refusal : "";
        throw new OpenAiAdapterError("refusal", `モデルが拒否しました${text === "" ? "" : `: ${text}`}`);
      }
    }
  }
}

function outputItems(wire: Record<string, unknown>): readonly unknown[] {
  return asArray(wire.output) ?? [];
}

/** 出力のテキストをまとめる（`output_text` の content を連結する） */
function extractOutputText(wire: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const item of outputItems(wire)) {
    if (!isRecord(item) || item.type !== "message") continue;
    for (const part of asArray(item.content) ?? []) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join("");
}

/** 道具の呼び出しを取り出す。引数が JSON として読めなければ `toolArguments` にする（§2.2） */
function extractFunctionCalls(wire: Record<string, unknown>): LlmToolCall[] {
  const calls: LlmToolCall[] = [];
  for (const item of outputItems(wire)) {
    if (!isRecord(item) || item.type !== "function_call") continue;
    const id = item.call_id;
    const name = item.name;
    if (typeof id !== "string" || typeof name !== "string") {
      throw new OpenAiAdapterError("malformed", "道具の呼び出しの形が違います");
    }
    calls.push({ id, name, arguments: parseToolArguments(item.arguments) });
  }
  return calls;
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") {
    throw new OpenAiAdapterError("toolArguments", "道具の引数が文字列ではありません");
  }
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  const parsed = tryParseJson(trimmed);
  if (!parsed.ok) {
    throw new OpenAiAdapterError("toolArguments", "道具の引数が JSON として読めません");
  }
  return parsed.value;
}

// ── usage（§1.5・R-6）───────────────────────────────────────────────────

/**
 * usage を共通の契約の形に直す。**無い・壊れているときは `undefined`**（「usage なし」）を返し、
 * 共通の口に予約を残させる。壊れている＝数でない・負・整数でない・内訳が合計を超える。
 */
function parseUsage(value: unknown): LlmUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonNegativeInteger(value.input_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = detailCount(value.input_tokens_details, "cached_tokens");
  const reasoningTokens = detailCount(value.output_tokens_details, "reasoning_tokens");
  if (cachedInputTokens === undefined || reasoningTokens === undefined) return undefined;
  if (cachedInputTokens > inputTokens) return undefined;
  if (reasoningTokens > outputTokens) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 内訳（`input_tokens_details` など）の 1 つの数。無ければ 0、壊れていれば `undefined` */
function detailCount(details: unknown, key: string): number | undefined {
  if (details === undefined) return 0;
  if (!isRecord(details)) return undefined;
  const raw = details[key];
  if (raw === undefined) return 0;
  return nonNegativeInteger(raw);
}

// ── JSON Schema の最小の検査（§2.2「合否・持ち物はコードが決める」）────────────

/**
 * JSON Schema の**最小の**検査。構造化出力の `strict: true` が本来の保証だが、adapter は
 * 「形が合わない応答」を成功にしない（§2.2）。よく使う語だけを見る（型・必須・properties・
 * items・enum・const・結合・additionalProperties・数の上下限・文字列の長さ）。
 */
function validateSchema(schema: unknown, value: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  const type = schema.type;
  if (typeof type === "string" && !matchesType(type, value)) return `型が違います（${type}）`;
  const types = asArray(type);
  if (types !== undefined && !types.some((one) => typeof one === "string" && matchesType(one, value))) {
    return "型がどれにも合いません";
  }
  const enumValues = asArray(schema.enum);
  if (enumValues !== undefined && !enumValues.some((candidate) => deepEqual(candidate, value))) {
    return "enum のどれでもありません";
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) return "const と違います";
  const anyOf = asArray(schema.anyOf);
  if (anyOf !== undefined && !anyOf.some((one) => validateSchema(one, value) === undefined)) {
    return "anyOf のどれにも合いません";
  }
  const oneOf = asArray(schema.oneOf);
  if (oneOf !== undefined) {
    const matched = oneOf.filter((one) => validateSchema(one, value) === undefined).length;
    if (matched !== 1) return "oneOf は 1 つだけ合う必要があります";
  }
  const allOf = asArray(schema.allOf);
  if (allOf !== undefined && allOf.some((one) => validateSchema(one, value) !== undefined)) {
    return "allOf のどれかに合いません";
  }
  if (isRecord(value)) {
    const error = validateObject(schema, value);
    if (error !== undefined) return error;
  }
  if (Array.isArray(value)) {
    const error = validateArray(schema, value);
    if (error !== undefined) return error;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return "minimum 未満です";
    if (typeof schema.maximum === "number" && value > schema.maximum) return "maximum 超えです";
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return "minLength 未満です";
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return "maxLength 超えです";
  }
  return undefined;
}

function validateObject(schema: Record<string, unknown>, value: Record<string, unknown>): string | undefined {
  const required = asArray(schema.required);
  if (required !== undefined) {
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) return `必須の欄がありません（${key}）`;
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (properties !== undefined) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const error = validateSchema(propertySchema, value[key]);
      if (error !== undefined) return `${key}: ${error}`;
    }
  }
  if (schema.additionalProperties === false && properties !== undefined) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) return `余分な欄があります（${key}）`;
    }
  }
  return undefined;
}

function validateArray(schema: Record<string, unknown>, value: readonly unknown[]): string | undefined {
  const items = schema.items;
  if (isRecord(items)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateSchema(items, value[index]);
      if (error !== undefined) return `[${index}]: ${error}`;
    }
  } else {
    const tuple = asArray(items);
    if (tuple !== undefined) {
      for (let index = 0; index < value.length && index < tuple.length; index += 1) {
        const error = validateSchema(tuple[index], value[index]);
        if (error !== undefined) return `[${index}]: ${error}`;
      }
    }
  }
  return undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

// ── 小さな道具立て ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

type JsonResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function tryParseJson(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
