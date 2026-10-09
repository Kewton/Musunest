// 全 LLM 呼び出しを通す共通の口（02-architecture.md §1.5・§2.2）。
//
// **すべての LLM 呼び出しはこの口を通す**（段も adapter も、直接 `LlmClient` を呼ばない）。
// ここが引き受けるのは 4 つ。
//
//   1. **呼ぶ前に最大費用を予約する**（§1.5）。入力の上界は、規則・文書・JSON Schema・道具の定義・
//      履歴・データの**全部**から数える（`LlmInputParts`）。出力の上限（`max_output_tokens`）と
//      合わせて、単価（引数）で最大費用を出す。**残高を超えるなら呼ばない。**
//   2. **usage が返れば精算し、返らなければ予約を残す**（§1.5）。例外のときも usage は分からないので
//      予約を残す。
//   3. **例外と再試行も、回数と予約に計上する**（§1.5・§2.2「1 回だけやり直す」）。試行ごとに
//      呼び出しの回数を 1 つ数え、予約を 1 つ取る。道具の呼び出しの回数も数える。
//   4. **締切までの残り時間で実呼び出しを中断する**（§1.5「呼び出しごとに timeout」）。残り時間が
//      尽きていれば呼ばず、呼んでいる途中で尽きたら打ち切って、締切切れとして返す。
//
// 費用の予約そのものは budget.ts（`JobBudget`）が持つ。ここは「呼ぶ前に予約し、呼んだ後で精算する」
// 順番と、回数の集計と、締切を引き受ける。単価はコードに埋め込まない（引数で受け取る）。
import { estimateMaxCostUsd, type JobBudget, type TokenRates } from "./budget.js";
import {
  AGENT_LIMITS,
  maxOutputTokensForEffort,
  type AgentLimits,
  type LimitName,
  type OutputStage,
} from "./limits.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolDefinition,
  LlmToolRequest,
  LlmToolResponse,
  LlmTurn,
  LlmUsage,
} from "./llm.js";

/**
 * 入力の上界を出すための、1 文字あたりのトークン数の上限（案）。
 *
 * 正しいトークン数は tokenizer を呼ばないと分からない。予約は**安全側に倒す**（§1.5）ので、
 * 1 文字 = 1 トークンとして数える（少なく見積もって予約が足りなくなる方を避ける）。
 * この値を変えても契約は変わらない——上界の取り方だけの話である。
 */
export const MAX_TOKENS_PER_CHAR = 1;

/** 入力の上界を数える材料（規則・文書・schema・道具・履歴・データ。§1.5・§2.2） */
export interface LlmInputParts {
  /** 共通の規則（`instructions`） */
  readonly instructions: string;
  /** 文書（契約・語彙の意味・語彙の台帳） */
  readonly documents: readonly string[];
  /** 段ごとの規則（文書の後ろ・データの前に置く） */
  readonly rules: readonly string[];
  /** JSON Schema（構造化出力のとき） */
  readonly schema: unknown;
  /** 道具の定義（道具付きのとき） */
  readonly tools: readonly LlmToolDefinition[];
  /** これまでの往復（履歴） */
  readonly turns: readonly LlmTurn[];
  /** 依頼文・宣言などのデータ（`input`） */
  readonly data: string;
}

/** 構造化出力の要求から、入力の上界の材料を取り出す */
export function structuredInputParts(request: LlmStructuredRequest): LlmInputParts {
  return {
    instructions: request.instructions,
    documents: request.documents,
    rules: request.rules ?? [],
    schema: { name: request.schemaName, schema: request.schema },
    tools: [],
    turns: [],
    data: request.input,
  };
}

/** 道具付きの要求から、入力の上界の材料を取り出す */
export function toolInputParts(request: LlmToolRequest): LlmInputParts {
  return {
    instructions: request.instructions,
    documents: request.documents,
    rules: request.rules ?? [],
    schema: undefined,
    tools: request.tools,
    turns: request.turns,
    data: request.input,
  };
}

function jsonChars(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value) && value.length === 0) return 0;
  const text = JSON.stringify(value);
  return text === undefined ? 0 : text.length;
}

/** 入力の上界（文字数）。規則・文書・段の規則・schema・道具・履歴・データの全部から数える */
export function inputUpperBoundChars(parts: LlmInputParts): number {
  let chars = parts.instructions.length + parts.data.length;
  for (const document of parts.documents) chars += document.length;
  for (const rule of parts.rules) chars += rule.length;
  chars += jsonChars(parts.schema);
  chars += jsonChars(parts.tools);
  chars += jsonChars(parts.turns);
  return chars;
}

/** 入力の上界（トークン数）。1 文字 = 1 トークンとして、安全側に倒す（§1.5） */
export function estimateInputUpperBoundTokens(parts: LlmInputParts): number {
  return Math.ceil(inputUpperBoundChars(parts) * MAX_TOKENS_PER_CHAR);
}

/**
 * 未完了の応答を表す誤りの形（§2.2・§1.5）。adapter（openai.ts）が投げ、ここ（共通の口）が
 * **構造で**見分ける——口は adapter に依存しないので、型ではなく `kind` と `reason` の形で判定する。
 * 未完了の応答は拒否（refusal）と分け、**同じ要求のままやり直さない**（同じ上限ではまた切れる）。
 */
export interface IncompleteResponseError extends Error {
  /** 未完了であることを示す印 */
  readonly kind: "incomplete";
  /** 未完了の理由（`max_output_tokens` など） */
  readonly reason: string;
  /** 未完了でも usage は付くことがある。無ければ `undefined`（予約を残す） */
  readonly usage: LlmUsage | undefined;
}

/** 未完了の応答を表す誤りか（口がやり直さず、usage があれば精算するための判定。§2.2・§1.5） */
export function isIncompleteResponseError(error: unknown): error is IncompleteResponseError {
  if (!(error instanceof Error)) return false;
  const candidate = error as { kind?: unknown; reason?: unknown };
  return candidate.kind === "incomplete" && typeof candidate.reason === "string";
}

/**
 * 要求そのものが不正な誤りを表す形（§2.2）。adapter（openai.ts）が投げ、ここ（共通の口）が
 * **構造で**見分ける——口は adapter に依存しないので、型ではなく `kind` と `code` の形で判定する。
 * HTTP 400（`invalid_json_schema` など）は、同じ要求ではやり直しても通らないので**やり直さない**。
 * 本文の全文は持たず、誤りの種類（`code`）だけを持つ。
 */
export interface InvalidRequestError extends Error {
  /** 要求の誤りであることを示す印 */
  readonly kind: "invalidRequest";
  /** API の誤りの種類（例: `invalid_json_schema`） */
  readonly code: string;
}

/** 要求そのものが不正な誤りか（口がやり直さないための判定。§2.2） */
export function isInvalidRequestError(error: unknown): error is InvalidRequestError {
  if (!(error instanceof Error)) return false;
  const candidate = error as { kind?: unknown; code?: unknown };
  return candidate.kind === "invalidRequest" && typeof candidate.code === "string";
}

/** 共通の口の結果 */
export type CallResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  /** 残り時間が尽きた（実呼び出しをしていない、または途中で打ち切った） */
  | { readonly kind: "deadlineExceeded" }
  /** 予約が残高を超えるので呼ばなかった */
  | { readonly kind: "budgetExceeded"; readonly maxCostUsd: number; readonly remainingUsd: number }
  /** 呼び出しの回数の上限に触れた */
  | { readonly kind: "limitExceeded"; readonly limit: LimitName; readonly max: number; readonly actual: number }
  /** 応答が未完了だった（理由付き）。**同じ要求ではやり直さない**（§2.2・§1.5） */
  | { readonly kind: "incomplete"; readonly reason: string; readonly usage: LlmUsage | undefined }
  /** 要求そのものが不正だった（種類付き）。**同じ要求ではやり直さない**（§2.2） */
  | { readonly kind: "invalidRequest"; readonly code: string }
  /** 再試行を使い切っても成功しなかった */
  | { readonly kind: "failed"; readonly attempts: number; readonly error: unknown };

/** 共通の口の設定 */
export interface CallGatewayOptions {
  /** 素の呼び出し（adapter） */
  readonly client: LlmClient;
  /** ジョブの予算（予約と精算） */
  readonly budget: JobBudget;
  /** トークンの単価（コードに埋め込まない） */
  readonly rates: TokenRates;
  /** いまの時刻（ミリ秒）。時計は差し込む（試験は固定する） */
  readonly now: () => number;
  /** 締切（ミリ秒。この時刻で打ち切る） */
  readonly deadline: number;
  /** 上限（既定は `AGENT_LIMITS`） */
  readonly limits?: AgentLimits;
  /** 1 回の論理的な呼び出しで許す試行の回数（既定 2 = 1 回だけやり直す。§2.2） */
  readonly maxAttempts?: number;
  /** 推論の effort（段の出力の上限を決める。既定 `high`。§2） */
  readonly effort?: string;
}

const DEFAULT_MAX_ATTEMPTS = 2;

interface Attempted<T> {
  readonly value: T;
  readonly usage: LlmUsage | undefined;
}

type AttemptOutcome<T> = { readonly kind: "ok"; readonly result: Attempted<T> } | { readonly kind: "deadline" };

/**
 * すべての LLM 呼び出しを通す口。
 *
 * 呼ぶ前に最大費用を予約し、usage が返れば精算する（返らなければ予約を残す）。例外と再試行も
 * 回数と予約に計上する。締切までの残り時間で実呼び出しを打ち切る。**合否はここでは決めない**
 * （終わりの判定は code = outcome.ts が行う。§1.4）。
 */
export class CallGateway {
  readonly #client: LlmClient;
  readonly #budget: JobBudget;
  readonly #rates: TokenRates;
  readonly #now: () => number;
  readonly #deadline: number;
  readonly #limits: AgentLimits;
  readonly #maxAttempts: number;
  readonly #effort: string;
  #calls = 0;
  #toolCalls = 0;
  #retries = 0;

  constructor(options: CallGatewayOptions) {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("試行の回数は 1 以上の整数であること");
    }
    this.#client = options.client;
    this.#budget = options.budget;
    this.#rates = options.rates;
    this.#now = options.now;
    this.#deadline = options.deadline;
    this.#limits = options.limits ?? AGENT_LIMITS;
    this.#maxAttempts = maxAttempts;
    this.#effort = options.effort ?? "high";
  }

  /** 推論の effort（段の出力の上限の出所。§2） */
  get effort(): string {
    return this.#effort;
  }

  /**
   * 段の出力の上限（`max_output_tokens`）を、effort と段から引く（§1.5・§2）。
   * **値は共通の上限の置き場所（limits.ts）にだけ置く**——段の側で値を書かない。
   */
  maxOutputTokens(stage: OutputStage): number {
    return maxOutputTokensForEffort(this.#effort, stage);
  }

  /** LLM 呼び出しの回数（再試行と例外も数える。§1.5） */
  get calls(): number {
    return this.#calls;
  }

  /** 道具の呼び出しの回数（§1.5「⑥ の中の道具の呼び出しも数える」） */
  get toolCalls(): number {
    return this.#toolCalls;
  }

  /** 再試行の回数（§2.2） */
  get retries(): number {
    return this.#retries;
  }

  /** 構造化出力（①'・②'・⑤a・⑥'）を共通の口を通して呼ぶ */
  async callStructured<T>(request: LlmStructuredRequest): Promise<CallResult<LlmStructuredResponse<T>>> {
    return this.#run(structuredInputParts(request), request.maxOutputTokens, async (signal) => {
      const response = await this.#client.callStructured<T>({ ...request, signal });
      return { value: response, usage: response.usage };
    });
  }

  /** 道具付き（⑥ 直す）を共通の口を通して呼ぶ。道具の呼び出しの回数も数える */
  async callWithTools(request: LlmToolRequest): Promise<CallResult<LlmToolResponse>> {
    return this.#run(toolInputParts(request), request.maxOutputTokens, async (signal) => {
      const response = await this.#client.callWithTools({ ...request, signal });
      if (response.kind === "toolCalls") this.#toolCalls += response.toolCalls.length;
      return { value: response, usage: response.usage };
    });
  }

  async #run<T>(
    parts: LlmInputParts,
    maxOutputTokens: number,
    invoke: (signal: AbortSignal) => Promise<Attempted<T>>,
  ): Promise<CallResult<T>> {
    const inputTokens = estimateInputUpperBoundTokens(parts);
    const maxCostUsd = estimateMaxCostUsd({ inputTokens, maxOutputTokens, rates: this.#rates });
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (this.#deadline - this.#now() <= 0) return { kind: "deadlineExceeded" };
      if (this.#calls >= this.#limits.callCount) {
        return { kind: "limitExceeded", limit: "callCount", max: this.#limits.callCount, actual: this.#calls };
      }
      const reserved = this.#budget.reserve(maxCostUsd);
      if (!reserved.reserved) {
        return { kind: "budgetExceeded", maxCostUsd, remainingUsd: reserved.remainingUsd };
      }
      this.#calls += 1;
      if (attempt > 1) this.#retries += 1;
      try {
        const outcome = await this.#attempt(invoke);
        if (outcome.kind === "deadline") return { kind: "deadlineExceeded" };
        if (outcome.result.usage !== undefined) {
          this.#budget.settle(reserved.reservation, outcome.result.usage, this.#rates);
        }
        return { kind: "ok", value: outcome.result.value };
      } catch (error) {
        // 未完了の応答は拒否と分け、**同じ要求のままやり直さない**（同じ上限ではまた切れる。§2.2）。
        // usage が分かる未完了は、成功と同じく実際の費用で精算する（§1.5）。分からなければ予約を残す。
        if (isIncompleteResponseError(error)) {
          if (error.usage !== undefined) {
            this.#budget.settle(reserved.reservation, error.usage, this.#rates);
          }
          return { kind: "incomplete", reason: error.reason, usage: error.usage };
        }
        // 要求そのものが不正な誤り（HTTP 400 など）は、拒否と分け、**同じ要求のままやり直さない**
        // ——やり直しても通らない（§2.2）。誤りの種類（code）だけを返し、本文の全文は残さない。
        if (isInvalidRequestError(error)) {
          return { kind: "invalidRequest", code: error.code };
        }
        // 例外のときは usage が分からないので、予約は残したまま次を試す（§1.5）
        lastError = error;
      }
    }
    return { kind: "failed", attempts: this.#maxAttempts, error: lastError };
  }

  async #attempt<T>(invoke: (signal: AbortSignal) => Promise<Attempted<T>>): Promise<AttemptOutcome<T>> {
    const remaining = this.#deadline - this.#now();
    if (remaining <= 0) return { kind: "deadline" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("deadline");
      }, remaining);
    });
    try {
      const raced = await Promise.race([invoke(controller.signal), deadline]);
      if (raced === "deadline") return { kind: "deadline" };
      return { kind: "ok", result: raced };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
