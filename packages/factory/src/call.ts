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
//   4. **呼び出しごとの timeout を、effort と締切から決めて実呼び出しを中断する**（§1.5「呼び出し
//      ごとに timeout」・#302）。timeout は effort ごとの基準（`callTimeoutMsForEffort`）から出し、
//      **ジョブの締切の残りを超えない**。残り時間が尽きていれば呼ばず、呼んでいる途中で尽きたら
//      打ち切る。**やり直しでは timeout を長くする**（同じ timeout ではやり直さない。§2.2・#302）。
//   5. **adapter の誤りの種類を、そのまま分類する**（§2.2・#302）。`timeout`・`network`・HTTP の 5xx
//      だけをやり直し、4xx・残高切れ・拒否・未完了・形の誤り・分類できない例外はやり直さない。
//      **「拒否」はモデルが拒否したとき（`refusal`）だけ**にする（timeout を拒否にしない）。
//
// 段ごとの effort（`stageEfforts`。Issue #664）を受けた口は、`forStage(段)` で**その段の effort を持つ薄い見方**を返す。
// 出力の上限・呼び出しごとの timeout の基準・要求の effort の 3 つを**同じ段の同じ effort**から引く（3 か所を別々に引くと、
// 「検査は通るのに店頭で切れる」ずれになる）。要求の effort は構造化と道具付きの両方に載せる（Issue #751）。
// 指定の無い段は元の口そのもので、要求のバイト列は今と同じ。
//
// 費用の予約そのものは budget.ts（`JobBudget`）が持つ。ここは「呼ぶ前に予約し、呼んだ後で精算する」
// 順番と、回数の集計と、締切と timeout を引き受ける。単価はコードに埋め込まない（引数で受け取る）。
import { estimateMaxCostUsd, type JobBudget, type TokenRates } from "./budget.js";
import {
  AGENT_LIMITS,
  callTimeoutMsForEffort,
  maxOutputTokensForEffort,
  type AgentLimits,
  type LimitName,
  type OutputStage,
  type ReasoningEffort,
  type StageEfforts,
  type StageEffortStage,
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
  MalformedKind,
  MalformedKindCounts,
  MalformedKindKey,
} from "./llm.js";
import { isMalformedKind, MALFORMED_KIND_KEYS } from "./llm.js";

/**
 * 段の出力の上限（`max_output_tokens`）の上書きの表（段 → 値。Issue #776）。
 *
 * **共通の口の任意の引数**として届く——段のコードに provider の分岐を足さず、provider ごとに違う
 * 推論の量へ上限を合わせる口である（`CallGatewayOptions.stageOutputLimits`）。表に無い段は
 * `STAGE_MAX_OUTPUT_TOKENS` の値のまま。effort に依らない（段 → 値）。
 */
export type StageOutputLimits = Readonly<Partial<Record<OutputStage, number>>>;

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

/** 道具付きの要求から、入力の上界の材料を取り出す（最後の答えの schema も含める。#304・§1.5） */
export function toolInputParts(request: LlmToolRequest): LlmInputParts {
  return {
    instructions: request.instructions,
    documents: request.documents,
    rules: request.rules ?? [],
    schema: request.schema === undefined ? undefined : { name: request.schemaName, schema: request.schema },
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

/**
 * 共通の口が分類する誤りの種類（§2.2「誤りの種類をそのまま写す」・#302）。adapter の `kind` を
 * **そのまま**写す。未完了（`incomplete`）と要求の不正（`invalidRequest`）は、上の結果の種類に
 * 分けて持つので、ここには入れない。
 */
export const CALL_ERROR_KINDS = [
  "timeout", // 呼び出しごとの timeout で打ち切った
  "network", // fetch 自体が失敗した
  "http", // HTTP の誤り（5xx はやり直してよい。4xx はやり直さない）
  "balance", // 残高切れ（`insufficient_quota`）
  "refusal", // モデルが拒否した
  "malformed", // 形が合わない応答（JSON でない・schema に合わない）
  "toolArguments", // 道具の引数が JSON として読めない
  "unknown", // 上のどれにも分類できない例外
] as const;
export type CallErrorKind = (typeof CALL_ERROR_KINDS)[number];

/** 誤り 1 つを分類した結果。やり直すかの判定にも使う */
export interface CategorizedCallError {
  readonly kind: CallErrorKind;
  /** HTTP の誤りの状態コード（`http` のときだけ持つ） */
  readonly status?: number;
}

/**
 * 実試行 1 回の終わりの、**口が確定した分類**（Issue #748）。観測の口へは、例外の文・要求や応答の本文・
 * ID の値を渡さない——分類と usage だけを渡す。未完了は応答の一種として分け、要求の不正は誤りの
 * `invalid-request` として分ける（`CALL_ERROR_KINDS` は未完了・要求の不正を含まないため）。
 */
export type CallAttemptEnd =
  | { readonly kind: "response"; readonly usage: LlmUsage | undefined }
  | { readonly kind: "incomplete"; readonly usage: LlmUsage | undefined }
  | {
      readonly kind: "error";
      readonly errorKind: CallErrorKind | "invalid-request";
      /**
       * 形の誤り（`malformed`）の種類の印（表の値のときだけ。Issue #783）。口の設定が on で、例外が印を持つときだけ載る。
       * #748 の行は、`error_kind` が malformed のときだけこの印を `malformed_kind` として写す。
       */
      readonly malformedKind?: MalformedKind;
    }
  /** 呼び出しごとの timeout で打ち切った */
  | { readonly kind: "timeout" }
  /** ジョブの締切で打ち切った */
  | { readonly kind: "deadline" };

/**
 * 実試行 1 回の観測（Issue #748）。口は**始めなかった試行**（締切・上限・予算で未着手）では作らない。
 * `settle` は**1 つの開始につき 1 度だけ**呼ばれる——打ち切りのあとに client が遅れて返ったときは
 * `late` を呼び、行の終わり方は変えない。
 */
export interface CallAttemptObservation {
  /** 終わりを確定する（2 度目以降の呼び出しは無視される） */
  settle(end: CallAttemptEnd): void;
  /** 打ち切りのあとに client が遅れて応答・未完了を返した（usage が無ければ `undefined`） */
  late(usage: LlmUsage | undefined): void;
  /**
   * 計量（`UsageMeter.note`）がこの試行の usage を加算した**その時点**に呼ばれる（Issue #748 のレビュー R1）。
   * 遅着の帰属は、観測の callback が動いた時点ではなく、この印の時点の単位から解く。
   * `bound` は束の計量か（T2 は束と全体の 2 つが同じ応答を数える。レビュー R1）。
   */
  note?(bound: boolean): void;
}

/** 試行ごとの計量の印（実呼び出しの合図で引く。Issue #748 のレビュー R1） */
const noteHooks = new WeakMap<object, (bound: boolean) => void>();

/** 計量の加算の時点で呼ぶ印を、その実呼び出しの合図に結び付ける */
export function registerNoteHook(key: object, hook: (bound: boolean) => void): void {
  noteHooks.set(key, hook);
}

/** 計量の加算の時点で、その実呼び出しの印を呼ぶ（印が無ければ何もしない） */
export function runNoteHook(key: object | undefined, bound: boolean): void {
  if (key === undefined) return;
  noteHooks.get(key)?.(bound);
}

/**
 * 実試行の観測器（Issue #748）。親の口と T2 の束ごとの口が**同じ 1 つ**を共有する。
 * `beginAttempt` は実呼び出しを始める直前に呼ばれ、始めなかった試行では呼ばれない。
 */
export interface CallAttemptObserver {
  beginAttempt(): CallAttemptObservation;
}

/**
 * 例外を、共通の口の種類に写す（§2.2・#302）。**口は adapter に依存しない**ので、型ではなく
 * `kind` の形で見分ける。分類できない例外は `unknown` として別に出す（拒否に混ぜない）。
 */
export function categorizeCallError(error: unknown): CategorizedCallError {
  if (!(error instanceof Error)) return { kind: "unknown" };
  const kind = (error as { kind?: unknown }).kind;
  const status = (error as { status?: unknown }).status;
  if (kind === "timeout") return { kind: "timeout" };
  if (kind === "network") return { kind: "network" };
  if (kind === "balance") return { kind: "balance" };
  if (kind === "refusal") return { kind: "refusal" };
  if (kind === "malformed") return { kind: "malformed" };
  if (kind === "toolArguments") return { kind: "toolArguments" };
  if (kind === "http") return typeof status === "number" ? { kind: "http", status } : { kind: "http" };
  return { kind: "unknown" };
}

/**
 * やり直してよい誤りか（§2.2・#302）。`timeout`・`network`・HTTP の 5xx **だけ**をやり直す。
 * 4xx（要求の不正・残高切れなど）・拒否・未完了・形の誤り・分類できない例外はやり直さない。
 */
export function isRetryableCallError(error: CategorizedCallError): boolean {
  if (error.kind === "timeout" || error.kind === "network") return true;
  if (error.kind === "http") return error.status !== undefined && error.status >= 500;
  return false;
}

/**
 * 試行が例外で終わったときの、観測の口へ渡す分類（Issue #748）。未完了・要求の不正を分け、
 * 残りは adapter の種類をそのまま写す。**例外の文は写さない**。
 *
 * Issue #783：口の設定（`recordMalformedKinds`）が on で、分類が `malformed` のときは、例外の
 * `malformedKind`（表の値）を印として載せる——#748 の行に `malformed_kind` を残せるようにする。
 */
function attemptEndOfError(error: unknown, recordMalformedKinds: boolean): CallAttemptEnd {
  if (isIncompleteResponseError(error)) return { kind: "incomplete", usage: error.usage };
  if (isInvalidRequestError(error)) return { kind: "error", errorKind: "invalid-request" };
  const errorKind = categorizeCallError(error).kind;
  if (!recordMalformedKinds || errorKind !== "malformed") return { kind: "error", errorKind };
  const malformedKind = malformedKindOfError(error);
  return malformedKind === undefined ? { kind: "error", errorKind } : { kind: "error", errorKind, malformedKind };
}

/**
 * usage のキャッシュの**書き込み**のトークン（#302・#342・§2.2）。共通の usage（`LlmUsage`）が
 * 持つ欄を読む（読み取りの `cachedInputTokens` と分けて見る）。無い・壊れているときは 0 にする
 * （記録を止めない）。
 */
export function cacheWriteTokensOf(usage: LlmUsage | undefined): number {
  if (usage === undefined) return 0;
  const raw = usage.cacheWriteTokens;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/** 共通の口の結果 */
export type CallResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  /** 締切の残り時間が尽きた（実呼び出しをしていない、または途中で打ち切った） */
  | { readonly kind: "deadlineExceeded" }
  /** 予約が残高を超えるので呼ばなかった */
  | { readonly kind: "budgetExceeded"; readonly maxCostUsd: number; readonly remainingUsd: number }
  /** 呼び出しの回数の上限に触れた */
  | { readonly kind: "limitExceeded"; readonly limit: LimitName; readonly max: number; readonly actual: number }
  /** 応答が未完了だった（理由付き）。**同じ要求ではやり直さない**（§2.2・§1.5） */
  | { readonly kind: "incomplete"; readonly reason: string; readonly usage: LlmUsage | undefined }
  /** 要求そのものが不正だった（種類付き）。**同じ要求ではやり直さない**（§2.2） */
  | { readonly kind: "invalidRequest"; readonly code: string }
  /**
   * 分類した誤りで失敗した（種類付き）。**やり直してよい誤りだけを、長くした timeout でやり直す**
   * （同じ timeout ではやり直さない。§2.2・#302）。未完了と要求の不正は上の種類に分けるので来ない。
   */
  | {
      readonly kind: "failed";
      readonly errorKind: CallErrorKind;
      readonly attempts: number;
      /** HTTP の誤りの状態コード（それ以外は持たない） */
      readonly status?: number;
      /**
       * その試行の形の誤り（`malformed`）の印（種類。Issue #783）。**口の設定（`recordMalformedKinds`）が on で、
       * 印が表の値のときだけ**持つ——`other`（印の無い・表に無い印の malformed）と off の走りは持たない。
       * 段はこの欄を失敗の帰属へ写す（stages/prompt.ts）。
       */
      readonly malformedKind?: MalformedKind;
    };

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
  /** 推論の effort（段の出力の上限と、呼び出しごとの timeout の基準を決める。既定 `high`。§2） */
  readonly effort?: string;
  /**
   * 呼び出し 1 回ごとの timeout の基準（ミリ秒）。既定は effort から出す（`callTimeoutMsForEffort`）。
   * 実際に使う値は**締切の残りを超えず**、やり直しでは長くする（#302）。
   */
  readonly callTimeoutMs?: number;
  /**
   * 生成と判定で共有する実試行の門（Issue #432）。渡すと、総呼び出し数の門は**この門の数**（生成の
   * 呼び出し・その再試行・判定の呼び出し・切り替え・再点検の合計）に掛かる。渡さなければ、この口の
   * `#calls` だけを上限に照らす（従来どおり）。
   */
  readonly gate?: CallGate;
  /**
   * 段ごとの effort の組（Issue #664）。`forStage` で段の名前で引いた口が、その段の effort で出力の上限と timeout の基準を
   * 引き、構造化の要求に effort を載せる。省けば、どの段の口も今の口と同じ。
   */
  readonly stageEfforts?: StageEfforts;
  /**
   * 段の出力の上限（`max_output_tokens`）の上書きの表（段 → 値。Issue #776）。渡した口では
   * `maxOutputTokens(段)` が表の値を返し、要求の `max_output_tokens` と予算の予約（`estimateMaxCostUsd`）が
   * その値で揃う。表に無い段は `STAGE_MAX_OUTPUT_TOKENS` の値のまま。**provider ごとに違う推論の量へ
   * 上限を合わせる口**で、段のコードに provider の分岐を足さない。省けば今の口と同じ。
   */
  readonly stageOutputLimits?: StageOutputLimits;
  /**
   * 実試行の観測器（Issue #748）。渡した口だけが、**実呼び出しを始めた試行**の始まりと終わりを告げる。
   * 省けば何も告げない（今の振る舞いと同じ）。要求の wire・中断の合図・計量・予約・再送は変えない。
   */
  readonly observer?: CallAttemptObserver;
  /**
   * 形の誤り（adapter の構造化出力の本文）の種類を数えるか（Issue #783）。既定は偽（今の振る舞いと同じ）。
   * 真の口だけが、実試行の終端の誤りが `malformed` のとき、例外の `malformedKind`（表の値）を印、
   * そうでなければ `other` として `AttemptCounts.malformed` に足し、失敗の結果と観測の行に印を載せる。
   * **分類・再送の規則・試行の数え方は変えない。** 段の名前で引いた口（`forStage`）へ引き継ぐ。
   */
  readonly recordMalformedKinds?: boolean;
}

/** 口の計（試行・再試行・道具の数。段の名前で引いた口と共有する。Issue #446・#664） */
interface GatewayCounters {
  calls: number;
  toolCalls: number;
  retries: number;
  // 試行の終端の計（Issue #446）。**1 つの開始につき 1 度だけ**数える。
  attemptsStarted: number;
  attemptsResponded: number;
  attemptsErrors: number;
  attemptsCancelledDeadline: number;
  attemptsCancelledTimeout: number;
  notStartedDeadline: number;
  notStartedBudget: number;
  notStartedLimit: number;
  notStartedTimeout: number;
  // 形・中身の再試行（段が告げる。Issue #446）
  retriesShape: number;
  retriesContent: number;
  // 形の誤りの種類ごとの数（口の設定が on のときだけ足す。Issue #783）
  malformedKinds: Record<MalformedKindKey, number>;
}

function newGatewayCounters(): GatewayCounters {
  return {
    calls: 0,
    toolCalls: 0,
    retries: 0,
    attemptsStarted: 0,
    attemptsResponded: 0,
    attemptsErrors: 0,
    attemptsCancelledDeadline: 0,
    attemptsCancelledTimeout: 0,
    notStartedDeadline: 0,
    notStartedBudget: 0,
    notStartedLimit: 0,
    notStartedTimeout: 0,
    retriesShape: 0,
    retriesContent: 0,
    malformedKinds: Object.fromEntries(MALFORMED_KIND_KEYS.map((key) => [key, 0])) as Record<MalformedKindKey, number>,
  };
}

/** 形の誤りの種類ごとの数を、集計の鍵 6 つを名指しで写す（余分な鍵は写さない。Issue #783） */
function pickMalformedCounts(counts: Record<MalformedKindKey, number>): MalformedKindCounts {
  return Object.fromEntries(MALFORMED_KIND_KEYS.map((key) => [key, counts[key]])) as MalformedKindCounts;
}

/**
 * 例外から、構造化出力の本文の形の誤りの印（種類）を読む（Issue #783）。口は adapter の型に依存しないので、
 * `malformedKind` の**形で**見分け、**共有の表（`MALFORMED_KINDS`）で検証する**——表に無い値は `undefined`
 * （呼ぶ側が `other` として数える）。
 */
function malformedKindOfError(error: unknown): MalformedKind | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = (error as { malformedKind?: unknown }).malformedKind;
  return isMalformedKind(value) ? value : undefined;
}

/**
 * 生成と判定で共有する、**実試行の門**（Issue #432）。時計・締切・総呼び出し数を 1 つに持つ——生成の
 * `CallGateway` も判定の包みも、これを通して実試行を数え、締切と上限に照らす。これにより、生成の
 * 呼び出し・その再試行・判定の呼び出し・Jev→Luna の切り替え・独立した再点検が、**同じ 1 つの数**で
 * 掛かる。判定は生成の `CallGateway` を通らないので、門を共有しないと合算できない。
 */
export interface CallGate {
  /** いまの時刻（ミリ秒） */
  readonly now: () => number;
  /** 締切（ミリ秒） */
  readonly deadline: number;
  /** 総呼び出しの上限 */
  readonly limit: number;
  /** これまでに数えた実試行の数 */
  attempts(): number;
  /** 締切までの残り（ミリ秒。負にならない） */
  remainingMs(): number;
  /**
   * 実試行の**直前**の検査。締切を過ぎていれば `"deadline"`、上限に達していれば `"limit"` を返し、
   * **試行を数えない**。`"ok"` のときだけ試行を 1 つ数える（失敗した試行も数える）。
   */
  begin(): "ok" | "deadline" | "limit";
}

/** 共有の門を作る（Issue #432）。時計・締切・上限は生成と判定で同じ値を渡す */
export function createCallGate(options: {
  readonly now: () => number;
  readonly deadline: number;
  readonly limit: number;
}): CallGate {
  let attempts = 0;
  return {
    now: options.now,
    deadline: options.deadline,
    limit: options.limit,
    attempts: () => attempts,
    remainingMs: () => Math.max(0, options.deadline - options.now()),
    begin: () => {
      if (options.now() >= options.deadline) return "deadline";
      if (attempts >= options.limit) return "limit";
      attempts += 1;
      return "ok";
    },
  };
}

/**
 * 未着手の理由別の数（Issue #446）。**実呼び出しを始めなかった**ことを示す——開始の数は増やさない。
 * 締切の残りが無い・予約が残高を超える・呼び出しの数の上限・timeout を伸ばせない、の 4 種である。
 */
export interface NotStartedCounts {
  /** 締切の残りが無い */
  readonly deadline: number;
  /** 予約が残高を超える（残高切れ） */
  readonly budget: number;
  /** 呼び出しの数の上限に触れた */
  readonly limit: number;
  /** timeout を伸ばせない（同じ・短い timeout ではやり直さない） */
  readonly timeout: number;
}

/**
 * 呼び出しの**試行の終端**の計（Issue #446）。**1 つの開始につき 1 度だけ**数える——競合（応答と打ち切り）に
 * 勝った結果で終端を決める。**不変の式**：開始 ＝ 応答 ＋ 誤り ＋ 締切の打ち切り ＋ timeout の打ち切り。
 * 未着手は開始に数えない。`UsageMeter.snapshot` と同じく、**2 つの時点の差**を取れる。
 */
export interface AttemptCounts {
  /** 開始（予約を取って実呼び出しを始めた数。内部の呼び出しの数と同じ時点） */
  readonly started: number;
  /** 応答（値が返った数と、未完了の例外で終わった数。未完了は usage の有無によらず応答 1・誤り 0） */
  readonly responded: number;
  /** 誤り（未完了以外の例外。通信・HTTP・拒否・形・不正な要求・分類できない例外） */
  readonly errors: number;
  /** 締切の打ち切り（呼んでいる途中でジョブの締切に触れて打ち切った） */
  readonly cancelled_deadline: number;
  /** timeout の打ち切り（呼び出しごとの timeout で打ち切った） */
  readonly cancelled_timeout: number;
  /** 未着手（実呼び出しを始めなかった。理由別） */
  readonly not_started: NotStartedCounts;
  /**
   * 形の誤り（adapter の構造化出力の本文）の**種類ごとの数**（集計の鍵は印 5 つ＋ `other`。Issue #783）。
   * 口の設定（`recordMalformedKinds`）が on で、**実試行の終端の誤りが `malformed`** のときだけ、その印
   * （表の値なら印、そうでなければ `other`）を 1 つ足す。打ち切りのあとに遅れて返った応答（`late`）では足さない。
   * **0 でない鍵が無いときは欄を持たない**（今の記録と同じ形。差分の判定は `attemptsDelta` と
   * 段の記録の写し（record.ts）が行う）。
   */
  readonly malformed?: MalformedKindCounts;
}

/**
 * 再試行の数（種類別。Issue #446・#478）。**欄ごとに数え始める時点が違う**——同じ「再試行」の名前でも、
 * 口が数えるもの（実開始）と段が告げるもの（やり直しを決めた数）の 2 つの出所がある。
 *
 *   - **通信**（`communication`）… 共通の口（`CallGateway`）が締切・共有の門・timeout を伸ばせるか・
 *     予算の予約をすべて通し、**実呼び出しを始めた時点**で数える（2 回目以降の開始。全実開始数
 *     `attempts.started` が増えるのと同じ時点）。**実際に始めた再送の数**である
 *   - **形**（`shape`）… 形の検査に落ちて、段が**やり直しを決めた時点**で告げる口
 *     （`CallGateway.noteRetry`）が数える（`callStructuredChecked` と直す段（⑥）の答えの検査。どれも
 *     **次の呼び出しの門より前**）
 *   - **中身**（`content`）… 中身の検査に落ちて、段が**やり直しを決めた時点**で告げる（設計（②）と
 *     試験集合（②'）の作り直しの輪。どれも**次の呼び出しの門より前**）
 *
 * **読み方の境界**：
 *
 *   - `attempts.started` は初回・道具付きの通常の往復・再送をすべて含む**全実開始数**であり、
 *     **再試行の実開始数ではない**
 *   - 通信の再送の実開始数は `communication` で読む
 *   - 形・中身のやり直しの**実開始数**は、段全体の記録の欄だけからは復元できない——やり直しを決めた
 *     あと、次の呼び出しが門（締切・共有の上限・予算）で始まらず、やり直しの数だけが増えることがある。
 *     1 つの最初の要求とそのやり直しだけを切り出した区間で、初回が始まった場合に限り、開始の差分から
 *     1 を引いたものが追加の開始数になる
 */
export interface RetryCounts {
  /** 通信（共通の口が実際に始めた再送の数。2 回目以降の実開始） */
  readonly communication: number;
  /** 形（形の検査に落ちてやり直しを決めた数。次の呼び出しが門で始まらなくても数える） */
  readonly shape: number;
  /** 中身（中身の検査に落ちてやり直しを決めた数。次の呼び出しが門で始まらなくても数える） */
  readonly content: number;
}

/** 共通の口の計（試行の終端と再試行。Issue #446）。`UsageMeter.snapshot` と同じく 2 時点の差を取れる */
export interface CallCounts {
  readonly attempts: AttemptCounts;
  readonly retries: RetryCounts;
}

/** 段が口へ告げる再試行の種類（Issue #446）。通信は口が数えるので、ここには無い */
export type RetryKind = "shape" | "content";

/** 2 つの時点の差（試行の終端。段の前後で取って差を出す。Issue #446） */
export function attemptsDelta(before: AttemptCounts, after: AttemptCounts): AttemptCounts {
  const malformed = malformedCountsDelta(before.malformed, after.malformed);
  return {
    started: after.started - before.started,
    responded: after.responded - before.responded,
    errors: after.errors - before.errors,
    cancelled_deadline: after.cancelled_deadline - before.cancelled_deadline,
    cancelled_timeout: after.cancelled_timeout - before.cancelled_timeout,
    not_started: {
      deadline: after.not_started.deadline - before.not_started.deadline,
      budget: after.not_started.budget - before.not_started.budget,
      limit: after.not_started.limit - before.not_started.limit,
      timeout: after.not_started.timeout - before.not_started.timeout,
    },
    ...(malformed === undefined ? {} : { malformed }),
  };
}

/**
 * 形の誤りの種類ごとの数の差（Issue #783）。**0 でない鍵が無ければ欄を持たない**——累計が 0 でない口でも、
 * その区間の差分が 0 なら欄を出さない（前の区間の数を引き継がない）。`after` に欄が無ければ差も無い。
 */
function malformedCountsDelta(
  before: MalformedKindCounts | undefined,
  after: MalformedKindCounts | undefined,
): MalformedKindCounts | undefined {
  if (after === undefined) return undefined;
  const counts = {} as Record<MalformedKindKey, number>;
  let any = false;
  for (const key of MALFORMED_KIND_KEYS) {
    const delta = after[key] - (before?.[key] ?? 0);
    counts[key] = delta;
    if (delta !== 0) any = true;
  }
  return any ? (counts as MalformedKindCounts) : undefined;
}

/** 2 つの時点の差（再試行の数。段の前後で取って差を出す。Issue #446） */
export function retryCountsDelta(before: RetryCounts, after: RetryCounts): RetryCounts {
  return {
    communication: after.communication - before.communication,
    shape: after.shape - before.shape,
    content: after.content - before.content,
  };
}

/** 2 つの時点の差（共通の口の計。段の前後で取って差を出す。Issue #446） */
export function callCountsDelta(before: CallCounts, after: CallCounts): CallCounts {
  return {
    attempts: attemptsDelta(before.attempts, after.attempts),
    retries: retryCountsDelta(before.retries, after.retries),
  };
}

const DEFAULT_MAX_ATTEMPTS = 2;

interface Attempted<T> {
  readonly value: T;
  readonly usage: LlmUsage | undefined;
}

type AttemptOutcome<T> =
  | { readonly kind: "ok"; readonly result: Attempted<T> }
  /** ジョブの締切に触れて打ち切った */
  | { readonly kind: "deadline" }
  /** 呼び出しごとの timeout で打ち切った（締切の残りとは別。§1.5・#302） */
  | { readonly kind: "timeout" };

/**
 * すべての LLM 呼び出しを通す口。
 *
 * 呼ぶ前に最大費用を予約し、usage が返れば精算する（返らなければ予約を残す）。例外と再試行も
 * 回数と予約に計上する。呼び出しごとの timeout を effort と締切から決め、実呼び出しを打ち切る。
 * **合否はここでは決めない**（終わりの判定は code = outcome.ts が行う。§1.4）。
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
  /** 呼び出し 1 回ごとの timeout の基準（ミリ秒。§1.5・#302） */
  readonly #callTimeoutMs: number;
  /** 生成と判定で共有する実試行の門（無ければ、この口の `#calls` だけを上限に照らす。Issue #432） */
  readonly #gate: CallGate | undefined;
  /** 呼ぶ側が指定した timeout の基準（指定が無ければ undefined。段の名前で引いた口へ引き継ぐ。Issue #664） */
  readonly #explicitCallTimeoutMs: number | undefined;
  /** 段ごとの effort の組（段の名前で引いた口の出所。Issue #664） */
  readonly #stageEfforts: StageEfforts;
  /** 段の出力の上限の上書きの表（渡した口だけ。段の名前で引いた口へ引き継ぐ。Issue #776） */
  readonly #stageOutputLimits: StageOutputLimits;
  /** 実試行の観測器（省けば観測しない。Issue #748） */
  readonly #observer: CallAttemptObserver | undefined;
  /** 形の誤りの種類を数えるか（既定は偽。Issue #783） */
  readonly #recordMalformedKinds: boolean;
  /** 段の名前で引いた口の元の口（元の口では自分自身。Issue #664） */
  #root: CallGateway = this;
  /** 要求に載せる effort（段の名前で引いた口だけが持つ。無ければ載せない＝今の要求。構造化と道具付きの両方。Issue #664・#751） */
  #requestEffort: ReasoningEffort | undefined;
  /** 口の計（段の名前で引いた口は、元の口と同じ計を共有する。Issue #664） */
  #counts: GatewayCounters = newGatewayCounters();

  constructor(options: CallGatewayOptions) {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("試行の回数は 1 以上の整数であること");
    }
    this.#effort = options.effort ?? "high";
    const callTimeoutMs = options.callTimeoutMs ?? callTimeoutMsForEffort(this.#effort);
    if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
      throw new RangeError("呼び出しごとの timeout は 0 より大きい有限の数であること");
    }
    this.#client = options.client;
    this.#budget = options.budget;
    this.#rates = options.rates;
    this.#now = options.now;
    this.#deadline = options.deadline;
    this.#limits = options.limits ?? AGENT_LIMITS;
    this.#maxAttempts = maxAttempts;
    this.#callTimeoutMs = callTimeoutMs;
    this.#gate = options.gate;
    this.#explicitCallTimeoutMs = options.callTimeoutMs;
    this.#stageEfforts = options.stageEfforts ?? {};
    this.#stageOutputLimits = options.stageOutputLimits ?? {};
    this.#observer = options.observer;
    this.#recordMalformedKinds = options.recordMalformedKinds === true;
  }

  /** 推論の effort（段の出力の上限の出所。§2） */
  get effort(): string {
    return this.#effort;
  }

  /** 呼び出し 1 回ごとの timeout の基準（ミリ秒。やり直しで伸ばす前の値。§1.5・#302・Issue #664） */
  get callTimeoutMs(): number {
    return this.#callTimeoutMs;
  }

  /**
   * 段の名前で引いた口（Issue #664）。その段に effort の指定があれば、**その段の effort を持つ薄い見方**を返す——
   * 出力の上限（`maxOutputTokens`）と呼び出しごとの timeout の基準をその effort から引き、構造化と道具付きの
   * 両方の要求に effort を載せる（Issue #751）。
   * 予算・門・締切・時計・単価・上限・試行の回数と**口の計は元の口と共有する**（段の前後の差の取り方は変わらない）。
   * 呼ぶ側が timeout の基準を指定した口では、その指定を引き継ぐ（呼ぶ側の指定が effort の基準に勝つのは今と同じ）。
   * 段の出力の上限の上書き（`stageOutputLimits`。Issue #776）も引き継ぐ——effort の指定の有無によらず、
   * 段の名前で引いた口の `maxOutputTokens` が上書きの値を返す。
   * 指定の無い段は**元の口そのもの**を返す（上限・timeout・要求は今と同じ）。
   */
  forStage(stage: StageEffortStage): CallGateway {
    const root = this.#root;
    const effort = root.#stageEfforts[stage];
    if (effort === undefined) return root;
    const view = new CallGateway({
      client: root.#client,
      budget: root.#budget,
      rates: root.#rates,
      now: root.#now,
      deadline: root.#deadline,
      limits: root.#limits,
      maxAttempts: root.#maxAttempts,
      effort,
      ...(root.#explicitCallTimeoutMs === undefined ? {} : { callTimeoutMs: root.#explicitCallTimeoutMs }),
      ...(root.#gate === undefined ? {} : { gate: root.#gate }),
      ...(root.#observer === undefined ? {} : { observer: root.#observer }),
      ...(root.#recordMalformedKinds ? { recordMalformedKinds: true } : {}),
      stageOutputLimits: root.#stageOutputLimits,
    });
    view.#root = root;
    view.#requestEffort = effort;
    view.#counts = root.#counts;
    return view;
  }

  /**
   * 段の出力の上限（`max_output_tokens`）を、effort と段から引く（§1.5・§2）。
   * **値は共通の上限の置き場所（limits.ts）にだけ置く**——段の側で値を書かない。
   * 上書きの表（`stageOutputLimits`。Issue #776）に段があればその値を返し、無ければ今の値のまま。
   */
  maxOutputTokens(stage: OutputStage): number {
    return this.#stageOutputLimits[stage] ?? maxOutputTokensForEffort(this.#effort, stage);
  }

  /** LLM 呼び出しの回数（再試行と例外も数える。§1.5） */
  get calls(): number {
    return this.#counts.calls;
  }

  /** 道具の呼び出しの回数（§1.5「⑥ の中の道具の呼び出しも数える」） */
  get toolCalls(): number {
    return this.#counts.toolCalls;
  }

  /** 再試行の回数（§2.2。**通信**の再試行＝口が自分で行う 2 回目以降） */
  get retries(): number {
    return this.#counts.retries;
  }

  /** 試行の終端の計（いまの計。段の前後で差を取る。Issue #446） */
  get attempts(): AttemptCounts {
    const counts: AttemptCounts = {
      started: this.#counts.attemptsStarted,
      responded: this.#counts.attemptsResponded,
      errors: this.#counts.attemptsErrors,
      cancelled_deadline: this.#counts.attemptsCancelledDeadline,
      cancelled_timeout: this.#counts.attemptsCancelledTimeout,
      not_started: {
        deadline: this.#counts.notStartedDeadline,
        budget: this.#counts.notStartedBudget,
        limit: this.#counts.notStartedLimit,
        timeout: this.#counts.notStartedTimeout,
      },
    };
    // 形の誤りの種類ごとの数は、口の設定が on のときだけ持つ（off の走りは今の形のまま。Issue #783）
    return this.#recordMalformedKinds ? { ...counts, malformed: pickMalformedCounts(this.#counts.malformedKinds) } : counts;
  }

  /** 再試行の数の計（種類別。いまの計。段の前後で差を取る。Issue #446） */
  get retryCounts(): RetryCounts {
    return { communication: this.#counts.retries, shape: this.#counts.retriesShape, content: this.#counts.retriesContent };
  }

  /** 共通の口の計（試行の終端と再試行。`UsageMeter.snapshot` と同じく 2 時点の差を取れる。Issue #446） */
  get counts(): CallCounts {
    return { attempts: this.attempts, retries: this.retryCounts };
  }

  /**
   * 形・中身の再試行を、段が口へ**告げる口**（Issue #446・#478）。**通信**の再試行は口が自分で数えるので、
   * ここへは来ない。形・中身は口が知らない（形の検査・中身の検査は段にある）ので、段の輪が呼ぶ。
   *
   * **告げる時点は、次の呼び出しの門（締切・共有の上限・予算・timeout を伸ばせるか）より前**である
   * ——段が検査に落ちてやり直しを**決めた**時点で告げるので、告げたやり直しが**未着手で終わる**ことが
   * ある（次の呼び出しが門で始まらない。たとえば形に落ちた直後に締切が尽きる・共有の上限に達する・
   * 予算の予約が拒否される・直す段（⑥）の往復の上限が共通の口より前で断る）。このときもやり直しの数は
   * 1 増える（実開始数は増えない）。
   */
  noteRetry(kind: RetryKind): void {
    if (kind === "shape") this.#counts.retriesShape += 1;
    else this.#counts.retriesContent += 1;
  }

  /** 構造化出力（①'・②'・⑤a・⑥'）を共通の口を通して呼ぶ */
  async callStructured<T>(request: LlmStructuredRequest): Promise<CallResult<LlmStructuredResponse<T>>> {
    // 段の名前で引いた口だけ、要求に段の effort を載せる（指定の無い口の要求は今と同じ。Issue #664）
    const sent: LlmStructuredRequest = this.#requestEffort === undefined ? request : { ...request, effort: this.#requestEffort };
    return this.#run(structuredInputParts(sent), sent.maxOutputTokens, async (signal) => {
      const response = await this.#client.callStructured<T>({ ...sent, signal });
      return { value: response, usage: response.usage };
    });
  }

  /** 道具付き（⑥ 直す）を共通の口を通して呼ぶ。道具の呼び出しの回数も数える */
  async callWithTools(request: LlmToolRequest): Promise<CallResult<LlmToolResponse>> {
    // 段の名前で引いた口だけ、要求に段の effort を載せる（指定の無い口の要求は今と同じ。Issue #664・#751）
    const sent: LlmToolRequest = this.#requestEffort === undefined ? request : { ...request, effort: this.#requestEffort };
    return this.#run(toolInputParts(sent), sent.maxOutputTokens, async (signal) => {
      const response = await this.#client.callWithTools({ ...sent, signal });
      if (response.kind === "toolCalls") this.#counts.toolCalls += response.toolCalls.length;
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
    let attempts = 0;
    let lastKind: CallErrorKind = "unknown";
    let lastStatus: number | undefined;
    let previousTimeoutMs: number | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const remaining = this.#deadline - this.#now();
      if (remaining <= 0) {
        this.#counts.notStartedDeadline += 1;
        return { kind: "deadlineExceeded" };
      }
      // 総呼び出し数の門。**共有の門があれば、生成の呼び出し・その再試行・判定の呼び出し・切り替え・
      // 再点検の合計**で照らし、この試行を数える（Issue #432）。無ければ、この口の `#calls` だけを見る。
      if (this.#gate !== undefined) {
        const begun = this.#gate.begin();
        if (begun === "deadline") {
          this.#counts.notStartedDeadline += 1;
          return { kind: "deadlineExceeded" };
        }
        if (begun === "limit") {
          this.#counts.notStartedLimit += 1;
          return { kind: "limitExceeded", limit: "callCount", max: this.#gate.limit, actual: this.#gate.attempts() };
        }
      } else if (this.#counts.calls >= this.#limits.callCount) {
        this.#counts.notStartedLimit += 1;
        return { kind: "limitExceeded", limit: "callCount", max: this.#limits.callCount, actual: this.#counts.calls };
      }
      // 呼び出しごとの timeout は、effort の基準をやり直しごとに倍へ伸ばし、締切の残りで頭を打つ
      // （#302）。**同じ timeout ではやり直さない**——伸ばせないなら、次の試行はせずに止める。
      const timeoutMs = Math.min(this.#callTimeoutMs * 2 ** (attempt - 1), remaining);
      if (attempt > 1 && previousTimeoutMs !== undefined && timeoutMs <= previousTimeoutMs) {
        this.#counts.notStartedTimeout += 1;
        break;
      }
      const reserved = this.#budget.reserve(maxCostUsd);
      if (!reserved.reserved) {
        this.#counts.notStartedBudget += 1;
        return { kind: "budgetExceeded", maxCostUsd, remainingUsd: reserved.remainingUsd };
      }
      this.#counts.calls += 1;
      this.#counts.attemptsStarted += 1;
      if (attempt > 1) this.#counts.retries += 1;
      attempts = attempt;
      // 実試行の観測（Issue #748）。**始めた試行**だけ行を作る（未着手では呼ばない）。
      const observation = this.#observer?.beginAttempt();
      try {
        const outcome = await this.#attempt(invoke, timeoutMs, remaining, observation);
        if (outcome.kind === "deadline") {
          this.#counts.attemptsCancelledDeadline += 1;
          return { kind: "deadlineExceeded" };
        }
        if (outcome.kind === "timeout") {
          // 呼び出しごとの timeout。usage は分からないので予約は残し、**拒否ではなく** `timeout` として
          // 扱い、やり直してよい誤りに入れる（伸ばせなければ、次の周で止まる。§2.2・#302）。
          this.#counts.attemptsCancelledTimeout += 1;
          lastKind = "timeout";
          lastStatus = undefined;
          previousTimeoutMs = timeoutMs;
          continue;
        }
        if (outcome.result.usage !== undefined) {
          this.#budget.settle(reserved.reservation, outcome.result.usage, this.#rates);
        }
        this.#counts.attemptsResponded += 1;
        return { kind: "ok", value: outcome.result.value };
      } catch (error) {
        // 未完了の応答は拒否と分け、**同じ要求のままやり直さない**（同じ上限ではまた切れる。§2.2）。
        // usage が分かる未完了は、成功と同じく実際の費用で精算する（§1.5）。分からなければ予約を残す。
        if (isIncompleteResponseError(error)) {
          if (error.usage !== undefined) {
            this.#budget.settle(reserved.reservation, error.usage, this.#rates);
          }
          // 未完了は usage の有無によらず**応答**として数える（誤りではない。Issue #446）
          this.#counts.attemptsResponded += 1;
          return { kind: "incomplete", reason: error.reason, usage: error.usage };
        }
        // 要求そのものが不正な誤り（HTTP 400 など）は、拒否と分け、**同じ要求のままやり直さない**
        // ——やり直しても通らない（§2.2）。誤りの種類（code）だけを返し、本文の全文は残さない。
        if (isInvalidRequestError(error)) {
          this.#counts.attemptsErrors += 1;
          return { kind: "invalidRequest", code: error.code };
        }
        // adapter の誤りを種類ごとに分類する（#302）。**「拒否」は拒否のときだけ**にする。
        // やり直してよい種類（timeout・network・5xx）だけを、長くした timeout でやり直す。
        const classified = categorizeCallError(error);
        lastKind = classified.kind;
        lastStatus = classified.status;
        // この試行の終端は**誤り**である——やり直してよい誤りでも、この試行は誤りで終わっている
        // （Issue #446）。やり直すのは次の試行からで、そちらも別に数える。
        this.#counts.attemptsErrors += 1;
        // 形の誤りの種類を数える（口の設定が on のときだけ。Issue #783）。印が表の値ならその印、そうでなければ
        // `other`。**誤りの文・値・本文は数にも観測の口にも渡さない**——数えるのは固定の鍵だけである。
        const malformedKind =
          this.#recordMalformedKinds && classified.kind === "malformed" ? malformedKindOfError(error) : undefined;
        if (this.#recordMalformedKinds && classified.kind === "malformed") {
          this.#counts.malformedKinds[malformedKind ?? "other"] += 1;
        }
        if (!isRetryableCallError(classified)) {
          return {
            kind: "failed",
            errorKind: classified.kind,
            attempts,
            ...(classified.status === undefined ? {} : { status: classified.status }),
            ...(malformedKind === undefined ? {} : { malformedKind }),
          };
        }
        // 例外のときは usage が分からないので、予約は残したまま次を試す（§1.5）
        previousTimeoutMs = timeoutMs;
      }
    }
    // 使い切った・伸ばせないで止めた。**新しい終端の数は増やさない**——各試行の終端はもう数えてある。
    return {
      kind: "failed",
      errorKind: lastKind,
      attempts,
      ...(lastStatus === undefined ? {} : { status: lastStatus }),
    };
  }

  /**
   * 1 回の実呼び出しを、呼び出しごとの timeout（`timeoutMs`）で打ち切る（§1.5・#302）。
   * `timeoutMs` が締切の残りに達していれば、それはジョブの締切として返す（`deadline`）。
   * 途中で打ち切るときは合図（`signal`）を中断する——adapter は中断を timeout として返す。
   *
   * 観測の口（Issue #748）へは、**打ち切りの時点で**終わりを確定して渡す（戻った時点で行が未確定・
   * 遅い完了で二重確定にならない）。打ち切りのあとに client が返したら `late` として渡し、行は変えない。
   */
  async #attempt<T>(
    invoke: (signal: AbortSignal) => Promise<Attempted<T>>,
    timeoutMs: number,
    remaining: number,
    observation: CallAttemptObservation | undefined,
  ): Promise<AttemptOutcome<T>> {
    const atDeadline = timeoutMs >= remaining;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 打ち切りの分類。abort の同期の拒否が `settle` より先に来ても、遅着として扱えるように先に置く */
    let cancelled: "deadline" | "timeout" | undefined;
    const aborted = new Promise<"deadline" | "timeout">((resolve) => {
      timer = setTimeout(() => {
        cancelled = atDeadline ? "deadline" : "timeout";
        observation?.settle({ kind: cancelled });
        controller.abort();
        resolve(cancelled);
      }, timeoutMs);
    });
    try {
      // 計量の加算の時点の印（遅着の帰属を、観測の callback の時点でなく加算の時点から解く。Issue #748 のレビュー R1）
      registerNoteHook(controller.signal, (bound) => observation?.note?.(bound));
      const call = invoke(controller.signal);
      if (observation === undefined) {
        // 打ち切ったあとに来る拒否を握る（待っていない側の拒否を、未処理のまま残さない）
        void call.catch(() => {});
      } else {
        void call
          .then(
            (result) => {
              if (cancelled === undefined) observation.settle({ kind: "response", usage: result.usage });
              else observation.late(result.usage);
            },
            (error) => {
              const end = attemptEndOfError(error, this.#recordMalformedKinds);
              if (cancelled === undefined) observation.settle(end);
              else if (end.kind === "incomplete") observation.late(end.usage);
            },
          )
          // 観測の口が投げても、待っていない側の拒否を未処理のまま残さない
          .catch(() => {});
      }
      const raced = await Promise.race([call, aborted]);
      if (raced === "deadline" || raced === "timeout") return { kind: raced };
      return { kind: "ok", result: raced };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
