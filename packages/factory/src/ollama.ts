// @musunest/factory —— Ollama Cloud の Responses API（OpenAI 互換）の adapter（Issue #771）。
//
// Ollama は OpenAI の Responses API と互換の入口を持ち、今の body の欄をそのまま受ける。そこで、要求の
// 組み立て・応答の解釈・中断・usage・誤りの分類は `openai.ts` の共有の実装（`createResponsesLlmClient`）を
// そのまま使い、**宛先・既定のモデル・「schema を文で示すか」だけ**を変える（設計の候補 ①）。
//
// 決めごと（Issue #771）：
//   * 宛先は `https://ollama.com/v1/responses` に固定（**環境変数からは読まない**。鍵は入口が渡す）。
//   * `text.format` の JSON Schema は Ollama では応答を縛らない。だから **schema の提示を有効**にし、
//     構造化出力と最後の答えの schema を持つ道具付きの要求に、段の指示の最後の内容の塊として
//     「次の JSON Schema に合う JSON だけを返す」と schema の本文を 1 つ足す（`text.format` は今のまま送る）。
//     形の検査は手元の `validateSchema` のまま——**縛られないことを理由に検査を緩めない**。
//   * usage・未完了・拒否・HTTP の分類は OpenAI と同じ。キャッシュの書き込みの欄が無ければ 0、
//     `reasoning_tokens` が 0 ならそのまま 0 として読む。
//   * `fetch` だけを使う。環境変数を読まない。
import type { LlmClient } from "./llm.js";
import { createResponsesLlmClient, type FetchLike } from "./openai.js";
import type { EnvelopeId } from "./schema-envelope.js";

/** Ollama Cloud の Responses API の宛先（1 か所に固定する。環境変数からは読まない） */
export const OLLAMA_RESPONSES_URL = "https://ollama.com/v1/responses";

/** Ollama の既定のモデル（Issue #771） */
export const DEFAULT_OLLAMA_MODEL = "deepseek-v4.1-flash:cloud";

/** Ollama の adapter を作る関数の引数（`openai.ts` の `OpenAiAdapterOptions` と同じ形） */
export interface OllamaAdapterOptions {
  /** API キー。**環境変数からは読まない**。呼ぶ側（手元の入口）が渡す */
  readonly apiKey: string;
  /** モデル（既定 `deepseek-v4.1-flash:cloud`） */
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
 * Ollama Cloud の Responses API に対する `LlmClient` を作る（Issue #771）。
 * 宛先は Ollama に固定し、schema の提示を有効にする。ほかは OpenAI の Responses API と同じ実装である。
 */
export function createOllamaLlmClient(options: OllamaAdapterOptions): LlmClient {
  return createResponsesLlmClient({
    ...options,
    model: options.model ?? DEFAULT_OLLAMA_MODEL,
    url: OLLAMA_RESPONSES_URL,
    presentSchema: true,
  });
}
