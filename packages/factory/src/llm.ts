// @musunest/factory —— LlmClient の型（02-architecture.md §2・§2.1・§2.2）。
//
// LLM の呼び出しは adapter 層に閉じ込める（CLAUDE.md の不変条件）。この file は**型だけ**を置く。
// OpenAI 用の実装（`fetch` だけを使う）は次の Issue。**API キーを扱うのは、その実装だけ**である（§2.1）。
//
// 呼び出しは 2 つ：①'・②'・⑤a・⑥' の**構造化出力**（JSON Schema）と、⑥ の**道具付き**（§2）。
// どちらも **usage を返す**。usage が返らないことがあるので、返り値は `LlmUsage | undefined` である。
// 費用は「呼ぶ前に最大費用を予約する」ので、呼ぶ側（budget.ts と call.ts）が usage を受けて精算する（§1.5）。
//
// **道具の往復**（R-2）：道具付きの呼び出しは、道具の呼び出し（識別子つき）→ 結果の返信 →
// 次のターン → 宣言の確定（終わりの合図）、という往復になる。`LlmToolResponse` は「続く（道具の
// 呼び出し）」か「終わる（宣言の確定）」のどちらかである。**会話の状態はこちらで組み立てて毎回送る**
// （`store: false`。§2 の「会話の状態」）。だから要求は `turns`（これまでの往復）を持つ。

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

/** 道具の呼び出し。**識別子で結果の返信と突き合わせる**（R-2） */
export interface LlmToolCall {
  /** 呼び出しの識別子。結果の返信（`LlmToolResult.toolCallId`）はこれで突き合わせる */
  readonly id: string;
  readonly name: string;
  /** 引数。コードが形と値を確かめる（§2.2） */
  readonly arguments: unknown;
}

/** 道具の呼び出しへの返信（次のターンへ渡す） */
export interface LlmToolResult {
  /** 返信先の呼び出しの識別子 */
  readonly toolCallId: string;
  /** 呼び出した道具の名前（突き合わせの補助） */
  readonly name: string;
  /** 道具が返した値（検査の結果・評価器の値など） */
  readonly output: unknown;
}

/**
 * 会話の 1 項目。**こちらで組み立てて毎回送る**（`store: false`。§2）。最初の入力は要求の `input` に
 * 置くので、ここには**最初の入力の後の往復**だけを置く。助手の呼び出しの次に、道具の結果が来る。
 */
export type LlmTurn =
  | { readonly role: "assistant"; readonly toolCalls: readonly LlmToolCall[] }
  | { readonly role: "tool"; readonly results: readonly LlmToolResult[] };

/** 構造化出力の要求（①'・②'・⑤a・⑥'） */
export interface LlmStructuredRequest {
  /** 信頼する規則（毎回送る。§2） */
  readonly instructions: string;
  /** 信頼する文書（契約・語彙の意味・語彙の台帳。入力の先頭に固定する。§2） */
  readonly documents: readonly string[];
  /** 依頼文・要件の一覧・宣言。**データとして囲んだ入力**（規則ではない。§2.2） */
  readonly input: string;
  /** JSON Schema の名前 */
  readonly schemaName: string;
  /** JSON Schema（構造化出力） */
  readonly schema: unknown;
  /** 出力トークンの上限。推論のトークンも含めて上限に入れる（§1.5） */
  readonly maxOutputTokens: number;
  /** 締切までの残り時間で実呼び出しを打ち切るための合図（共通の口が付ける。§1.5） */
  readonly signal?: AbortSignal;
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

/** 道具付きの要求（⑥ 直す） */
export interface LlmToolRequest {
  /** 信頼する規則（毎回送る。§2） */
  readonly instructions: string;
  /** 信頼する文書（契約・語彙の意味・語彙の台帳。§2） */
  readonly documents: readonly string[];
  /** 最初の入力（直す対象の宣言と、④⑤ の結果）。**データとして囲んだ入力**（§2.2） */
  readonly input: string;
  /** 使える道具（静的チェック・試験の実行・対応表の確認。§1） */
  readonly tools: readonly LlmToolDefinition[];
  /** これまでの往復。こちらで組み立てて毎回送る（§2） */
  readonly turns: readonly LlmTurn[];
  /** 出力トークンの上限。推論のトークンも含めて上限に入れる（§1.5） */
  readonly maxOutputTokens: number;
  /** 締切までの残り時間で実呼び出しを打ち切るための合図（共通の口が付ける。§1.5） */
  readonly signal?: AbortSignal;
}

/**
 * 道具付きの応答。**道具の呼び出し（続く）**か、**宣言の確定（終わりの合図）**のどちらかである（R-2）。
 * `kind` で判別できるので、呼ぶ側は「次は結果を返す」「これで終わり」を型で分けられる。
 */
export type LlmToolResponse =
  | {
      readonly kind: "toolCalls";
      readonly toolCalls: readonly LlmToolCall[];
      readonly usage: LlmUsage | undefined;
    }
  | {
      readonly kind: "done";
      /** 確定した宣言（⑥ の出力） */
      readonly declaration: unknown;
      readonly usage: LlmUsage | undefined;
    };

/**
 * LLM の呼び出しの型（§2.1）。構造化出力・道具付き・usage・予約を中身の側に置く。
 * **予約と締切は、共通の口（call.ts）が引き受ける**——ここは adapter の素の呼び出しである（§1.5）。
 */
export interface LlmClient {
  /** 構造化出力（JSON Schema）で 1 つ呼ぶ */
  callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>>;
  /** 道具付きで 1 つ呼ぶ。往復は `turns` で送り、応答は `kind` で判別する（R-2） */
  callWithTools(request: LlmToolRequest): Promise<LlmToolResponse>;
}
