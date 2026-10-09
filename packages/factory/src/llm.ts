// @musunest/factory —— LlmClient の型（02-architecture.md §2・§2.1）。
//
// LLM の呼び出しは adapter 層に閉じ込める（CLAUDE.md の不変条件）。この file は**型だけ**を置く。
// OpenAI 用の実装（`fetch` だけを使う）は次の Issue。**API キーを扱うのは、その実装だけ**である（§2.1）。
//
// 呼び出しは 2 つ：①'・②'・⑤a・⑥' の**構造化出力**（JSON Schema）と、⑥ の**道具付き**（§2）。
// どちらも **usage を返す**。usage が返らないことがあるので、返り値は `LlmUsage | undefined` である。
// 費用は「呼ぶ前に最大費用を予約する」ので、呼ぶ側（budget.ts）が usage を受けて精算する（§1.5）。

/**
 * LLM が返すトークンの数（§1.5）。入力・キャッシュに当たった入力・出力・推論の 4 つを持つ。
 * 推論（`reasoningTokens`）は出力（`outputTokens`）の**内訳**である（二重に数えない）。
 */
export interface LlmUsage {
  /** 入力のトークン（キャッシュに当たった分も含む） */
  readonly inputTokens: number;
  /** 入力のうち、キャッシュに当たったトークン */
  readonly cachedInputTokens: number;
  /** 出力のトークン（推論のトークンを含む） */
  readonly outputTokens: number;
  /** 出力のうち、推論に使ったトークン（`outputTokens` の内訳） */
  readonly reasoningTokens: number;
}

/** 構造化出力の要求（①'・②'・⑤a・⑥'）。規則は `instructions`、依頼文は `input` に分ける（§2.2） */
export interface LlmStructuredRequest {
  /** 信頼する規則（毎回送る。§2） */
  readonly instructions: string;
  /** 依頼文・要件の一覧・宣言。**データとして囲んだ入力**（規則ではない。§2.2） */
  readonly input: string;
  /** JSON Schema の名前 */
  readonly schemaName: string;
  /** JSON Schema（構造化出力） */
  readonly schema: unknown;
  /** 出力トークンの上限。推論のトークンも含めて上限に入れる（§1.5） */
  readonly maxOutputTokens: number;
}

/** 構造化出力の応答。`output` は schema に適合した値である */
export interface LlmStructuredResponse<T> {
  readonly output: T;
  readonly usage: LlmUsage | undefined;
}

/** 道具（function calling）。引数はコードが形と値を確かめる（§2.2） */
export interface LlmToolDefinition {
  readonly name: string;
  readonly description: string;
  /** 引数の JSON Schema */
  readonly parameters: unknown;
}

/** 返ってきた道具の呼び出し */
export interface LlmToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

/** 道具付きの要求（⑥ 直す） */
export interface LlmToolRequest {
  readonly instructions: string;
  readonly input: string;
  readonly tools: readonly LlmToolDefinition[];
  readonly maxOutputTokens: number;
}

/** 道具付きの応答 */
export interface LlmToolResponse {
  readonly toolCalls: readonly LlmToolCall[];
  readonly usage: LlmUsage | undefined;
}

/**
 * LLM の呼び出しの型（§2.1）。構造化出力・道具付き・usage・予約を中身の側に置く。
 * 予約は、呼ぶ前に最大費用を確保してから呼ぶこと（budget.ts。§1.5）。
 */
export interface LlmClient {
  /** 構造化出力（JSON Schema）で 1 つ呼ぶ */
  callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>>;
  /** 道具付きで 1 つ呼ぶ */
  callWithTools(request: LlmToolRequest): Promise<LlmToolResponse>;
}
