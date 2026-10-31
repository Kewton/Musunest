// @musunest/factory —— OpenRouter（Responses API 互換・提供元を固定）の adapter（Issue #788）。
//
// OpenRouter は OpenAI の Responses API と互換の入口を持ち、今の body の欄をそのまま受ける。そこで、要求の
// 組み立て・応答の解釈・中断・usage・誤りの分類は `openai.ts` の共有の実装（`createResponsesLlmClient`）を
// そのまま使い、**宛先と、body の末尾に足す提供元の指定（`provider`）だけ**を変える（設計の候補 ①）。
//
// 決めごと（Issue #788・#790）：
//   * 宛先は `https://openrouter.ai/api/v1/responses` に固定（**環境変数からは読まない**。鍵は入口が渡す）。
//   * body の末尾に提供元の指定 `provider`（`OPENROUTER_PROVIDER_ROUTING`）を 1 つ足す——`extraBody` の口で渡す。
//     ほかの欄の並びと値は OpenAI と同じ（schema の塊は足さない。`text.format` の strict な JSON Schema が応答を縛る）。
//   * `stageOnlyEnvelope: true` を渡す（Issue #790）——封筒の段の構造化出力だけ、`text.format.schema` をその段の枝
//     1 つだけの封筒にする。提供元が strict の schema を強く効かせると、全段の枝の `anyOf` では形の似た別の段の枝が
//     選ばれ、`wrong-stage` で止まった（#788 の観測）。OpenAI・Ollama はこの設定を渡さないので body は今のまま。
//   * 構造化出力・道具付きの往復・usage・未完了・拒否・HTTP の分類は OpenAI と同じ。OpenRouter 独自の usage の欄
//     （`cost`・`is_byok`・`cost_details`）は読まずに捨てる。schema の検査は手元の `validateSchema` のまま。
//   * `fetch` だけを使う。環境変数を読まない。
import type { LlmClient } from "./llm.js";
import { createResponsesLlmClient, type FetchLike } from "./openai.js";
import type { EnvelopeId } from "./schema-envelope.js";

/** OpenRouter の Responses API の宛先（1 か所に固定する。環境変数からは読まない） */
export const OPENROUTER_RESPONSES_URL = "https://openrouter.ai/api/v1/responses";

/** OpenRouter の既定のモデル（Issue #788。fp8 の提供元 `morph/fp8` で走らせる） */
export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash";

/**
 * 提供元を固定する指定（Issue #788・#790）。`morph/fp8` だけを許し、要求の欄を提供元が受けることを求め
 * （`require_parameters`）、落とし先（fallback）を許さない（`allow_fallbacks: false`）。
 * 所有者が 2026-10-31 に決めた（段だけの封筒にしても量子化 fp4 の OpenInference は C1 の内容を誤ったため、
 * fp8 の `morph/fp8` に替えた）。`openai.ts` の `extraBody` の口で body の末尾に足す。
 */
export const OPENROUTER_PROVIDER_ROUTING: Readonly<Record<string, unknown>> = {
  only: ["morph/fp8"],
  require_parameters: true,
  allow_fallbacks: false,
};

/** OpenRouter の adapter を作る関数の引数（`openai.ts` の `OpenAiAdapterOptions` と同じ形） */
export interface OpenRouterAdapterOptions {
  /** API キー。**環境変数からは読まない**。呼ぶ側（手元の入口）が渡す */
  readonly apiKey: string;
  /** モデル（既定 `z-ai/glm-5.3-flash`） */
  readonly model?: string;
  /** 推論の effort。渡さなければ送らない */
  readonly effort?: string;
  /** 差し込む `fetch`（既定 `globalThis.fetch`） */
  readonly fetch?: FetchLike;
  /** 呼び出しごとの timeout（ミリ秒）。指定しなければ effort から出す */
  readonly timeoutMs?: number;
  /** 構造化出力で送る封筒（`schema-envelope.ts`。既定 v1） */
  readonly envelope?: EnvelopeId;
}

/**
 * OpenRouter（Responses API 互換）に対する `LlmClient` を作る（Issue #788）。
 * 宛先を OpenRouter に固定し、提供元の指定を body の末尾に足す。ほかは OpenAI の Responses API と同じ実装である。
 */
export function createOpenRouterLlmClient(options: OpenRouterAdapterOptions): LlmClient {
  return createResponsesLlmClient({
    ...options,
    model: options.model ?? DEFAULT_OPENROUTER_MODEL,
    url: OPENROUTER_RESPONSES_URL,
    // 封筒の段の構造化出力だけ、その段の枝 1 つだけの封筒を送る（Issue #790。提供元が strict の schema を
    // 強く効かせても、形の似た別の段の枝が選ばれないようにする）
    stageOnlyEnvelope: true,
    // 提供元を固定する（body の末尾に 1 つ足す。ほかの欄は OpenAI と同じ）
    extraBody: { provider: OPENROUTER_PROVIDER_ROUTING },
  });
}
