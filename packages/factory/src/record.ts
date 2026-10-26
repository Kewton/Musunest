// 記録（要約と、段ごとの記録）の欄と組み立て（02-architecture.md §3.5・§4・S-5・S-7・S-8）。
//
// 記録は**最小にする**（§3.5・S-8）。ここは、要約と記録に入れる欄を**列挙**し、**その欄だけ**を名指しで
// 写して組み立てる。だから、依頼文の全文・LLM の応答の全文・API キー・生の HTTP の誤りの本文は、
// どの欄にも入らない——渡されても、列挙した欄の外なので落ちる。
//
// 出す先は 2 つ：
//   - 段ごとの記録（`RunRecord`）… builder・モデル・effort・版（プロンプト・契約・spec-engine・factory）・
//     段ごとの結果と所要時間とトークン・裁定の数・予約の残り・usage が欠けた呼び出しの数・失敗の帰属
//   - 要約（`Summary`）… 記録の欄に、CommandAgent と同じ要約の欄（`status`・`verdict`・`assurance`…）を
//     足したもの。wire の型は appspec-schema の納品物の入口（`HeadlessSummaryWire`）に合わせる
import {
  HEADLESS_REQUIRED_KEYS,
  HEADLESS_SCHEMA_VERSION,
  type HeadlessSummaryWire,
} from "@musunest/appspec-schema";
import {
  cacheWriteTokensOf,
  isIncompleteResponseError,
  runNoteHook,
  type AttemptCounts,
  type CallAttemptEnd,
  type CallAttemptObservation,
  type CallAttemptObserver,
  type CallCounts,
  type CallErrorKind,
  type RetryCounts,
} from "./call.js";
import type { LimitName } from "./limits.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmUsage,
} from "./llm.js";

/** 段の識別子（02 §1 の段。①〜⑧。v1.1α の段は末尾。07 §3） */
export const STAGE_IDS = [
  "requirements", // ① 要件にする
  "reverse-check", // ①' 逆照合
  "design", // ② 設計する
  "test-suite", // ②' 試験を作って固定する
  "write", // ③ 書く
  "static-check", // ④ 静的チェック
  "correspondence", // ⑤a 対応表
  "run-tests", // ⑤b 試験を流す
  "repair", // ⑥ 直す
  "arbitration", // ⑥' 期待の裁定
  "judge", // ⑦ 終わりの判定
  "bundle", // ⑧ 納品物にする
  // v1.1α の段（07-architecture-v1.1a.md §1・§3。Issue #505）。**末尾に足すだけ**で、上の並びは変えない
  "name-table", // T1 名前の表（T1' の検査を含む）
  "semantic-check", // T1'' 表の意味の点検
  "test-spec", // T2 試験の仕様（T2' の検査を含む）
  "name-check", // B3 名前の照合
  "decl-check", // B3' 宣言の意味の点検
  "coverage", // B6 棄却のあとの網羅
  "carry-over", // 全件持ち越しの停止（D15）
  // v1.2 の段（08-architecture-v1.2.md §4。Issue #593）。**末尾に足すだけ**で、上の並びは変えない。旗 `v12.ids` の走りだけが出す
  "vocabulary", // C1 語彙（束ごとに 1 記録。C1' を含む）
  "mapping", // C2 要件の写像（呼び出しごとに 1 記録。C2' を含む）
] as const;
export type StageId = (typeof STAGE_IDS)[number];

/** 段の結果 */
export const STAGE_STATUSES = ["ok", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * 段の記録の `operation`（段をどんな理由で回したか。Issue #410）。通常の段は `null`、仕分けが呼ぶ
 * 設計のやり直しだけ `"redo-design"` を持つ。**上限のある値の並び**——この外の値は記録に写さない
 * （`null` にする）。
 */
export const STAGE_OPERATIONS = ["redo-design"] as const;
export type StageOperation = (typeof STAGE_OPERATIONS)[number];

/**
 * 失敗の分類（どの種類の失敗か。02 §1.5・§2.2・S-7・#302）。**呼び出しの誤りは、adapter の種類を
 * そのまま写す**——timeout を「拒否」に混ぜない。`refused` は**モデルが拒否したときだけ**にする。
 */
export const FAILURE_KINDS = [
  "limit", // 入力の上限（依頼文の長さなど）
  "deadline", // 締切切れ
  "budget", // 予約の残高切れ
  "call-limit", // 呼び出しの数の超過
  "timeout", // 呼び出しごとの timeout で打ち切られた
  "network", // fetch 自体が失敗した
  "http", // HTTP の誤り（5xx など）
  "balance", // 残高切れ（`insufficient_quota`）
  "malformed", // 形が合わない応答が続いた
  "refused", // モデルが拒否した
  "tool-arguments", // 道具の引数が JSON として読めなかった
  "invalid-request", // 要求そのものが不正（HTTP 400 など。やり直しても通らない）
  "unmet", // コードの検査に合わなかった（未達）
  "incomplete", // 応答が未完了だった（静的チェックを通った版が無いまま終わった場合も含む）
  "unknown", // 上のどれにも分類できない例外
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * 止めた理由（記録と要約の `stop_reason`。§1.5・#309）。
 *
 *   - `completed` … 完走した（直しの上限に触れず、停滞もしなかった）
 *   - `stagnation` … 停滞を検知して止めた（同じ不一致が続いた。未解決のまま部分案）
 *   - `limit` … いずれかの上限に触れて止めた（直しの往復・③ のやり直し・⑤a の作り直し）
 *   - `unresolved` … 曖昧さ・未解決だけが残り、それ以上直さなかった
 *   - `deadline` … 締切で止めた
 *
 * 早期停止（入口・呼び出しの誤り・残高切れ）では、止めた段の失敗の分類（`FailureKind`）を入れる。
 */
export type StopReason = "completed" | "stagnation" | "limit" | "unresolved" | "deadline";

/**
 * 形が合わなかった／未達だった 1 つの欄（欄の名前と、問題の種類。#304）。
 * **値の中身（宣言の原文・依頼文・LLM の応答の全文）は持たない**——問題の文はコードが書いた型の説明と
 * 数だけで、値そのものを含まない（S-8）。
 */
export interface FailureProblem {
  readonly field: string;
  /** どう合わなかったか（コードが書いた、問題の種類の説明） */
  readonly message: string;
}

/** 失敗の帰属（どの段の・どの種類の失敗か。S-7） */
export interface FailureAttribution {
  readonly stage: StageId;
  readonly kind: FailureKind;
  /**
   * 要求そのものが不正なときの、API の誤りの種類（例: `invalid_json_schema`。§2.2・S-8）。
   * それ以外の失敗では持たない。**誤りの本文の全文は持たない**（種類だけを残す）。
   */
  readonly code?: string;
  /**
   * 形が合わなかった欄（欄の名前と、問題の種類。#304）。`malformed`・`unmet` のときだけ持つ。
   * **値の中身は持たない**（宣言の原文・依頼文は記録に残さない。S-8）。
   */
  readonly problems?: readonly FailureProblem[];
  /**
   * 当たった呼び出しの数の上限（上限の名前・上限値・実際の値。Issue #665）。旗 `v12.ids` の走りの `call-limit` のときだけ持つ
   * （ほかの走り・ほかの種類では欄が無い＝形は今のまま）。数と名前だけで、値の中身は持たない（S-8）
   */
  readonly limit?: FailureLimit;
}

/** 失敗の帰属の上限（名前・上限値・実際の値。Issue #665） */
export interface FailureLimit {
  readonly name: LimitName;
  readonly max: number;
  readonly actual: number;
}

/**
 * 使用トークンの計（呼び出しの数と、usage が欠けた呼び出しの数を含む。§1.5）。
 * キャッシュは**書き込み**（`cache_write_tokens`）と**読み取り**（`cached_input_tokens`）を分ける（#302）。
 */
export interface UsageSnapshot {
  readonly calls: number;
  readonly missing_usage_calls: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
}

/**
 * 試行の終端の計に、段の記録として写す下位の欄（この欄だけを写す。Issue #446）。
 * 値は `AttemptCounts` と同じ形を取る（段の記録の `attempts`）。
 */
export const ATTEMPT_KEYS = [
  "started",
  "responded",
  "errors",
  "cancelled_deadline",
  "cancelled_timeout",
  "not_started",
] as const;

/** 未着手の理由別の数に、段の記録として写す下位の欄（この欄だけを写す。Issue #446） */
export const NOT_STARTED_KEYS = ["deadline", "budget", "limit", "timeout"] as const;

/** 再試行の数に、段の記録として写す下位の欄（この欄だけを写す。Issue #446） */
export const RETRY_KEYS = ["communication", "shape", "content"] as const;

/** 段ごとの記録の欄（この欄だけを持つ） */
export const STAGE_RECORD_KEYS = [
  "stage",
  "operation",
  "status",
  "duration_ms",
  "calls",
  "missing_usage_calls",
  "input_tokens",
  "cached_input_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens",
  "attempts",
  "retries",
  "failure_kind",
] as const;
export type StageRecordKey = (typeof STAGE_RECORD_KEYS)[number];

/** 段ごとの記録（列挙した欄だけ） */
export interface StageRecord {
  readonly stage: StageId;
  /** 段を回した理由（通常は `null`、仕分けが呼ぶ設計のやり直しは `"redo-design"`。Issue #410） */
  readonly operation: StageOperation | null;
  readonly status: StageStatus;
  readonly duration_ms: number;
  readonly calls: number;
  readonly missing_usage_calls: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  /** 呼び出しの試行の開始・応答・誤り・打ち切り・未着手の数（Issue #446） */
  readonly attempts: AttemptCounts;
  /**
   * 通信・形・中身の再試行の数（欄ごとの意味は `RetryCounts` の注記に同じ——通信は共通の口が実際に
   * 始めた再送の数、形・中身は検査に落ちてやり直しを決めた数。Issue #446・#478）
   */
  readonly retries: RetryCounts;
  readonly failure_kind: FailureKind | null;
  /**
   * 参照の照合の数（`vocabulary`・`mapping` の記録だけが持つ。固定の鍵 `REFERENCE_COUNT_KEYS`。ID の値は持たない。Issue #593）。
   * ほかの段の記録には欄が無い（記録の形は変えない）
   */
  readonly references?: StageReferenceCounts;
}

/** 参照の照合の数の鍵（照らした参照・知らない ID・重複・別の束の ID。Issue #593） */
export const REFERENCE_COUNT_KEYS = ["checked", "unknown_ids", "duplicates", "cross_bundle_ids"] as const;

/** 参照の照合の数（段の記録の欄） */
export type StageReferenceCounts = { readonly [K in (typeof REFERENCE_COUNT_KEYS)[number]]: number };

/** 参照の照合の数を持てる段（Issue #593） */
export const REFERENCE_COUNT_STAGES: readonly StageId[] = ["vocabulary", "mapping"];

/** 裁定の数（維持・棄却・裁定不能。§1.3） */
export interface ArbitrationCounts {
  readonly upheld: number;
  readonly overturned: number;
  readonly undecidable: number;
}

/** 記録の欄（この欄だけを持つ） */
export const RUN_RECORD_KEYS = [
  "builder",
  "model",
  "effort",
  "prompt_version",
  "contract_version",
  "spec_engine_version",
  "factory_version",
  "stages",
  "arbitration",
  "budget_remaining_usd",
  "budget_reserved_usd",
  "missing_usage_calls",
  "failure",
] as const;
export type RunRecordKey = (typeof RUN_RECORD_KEYS)[number];

/** 1 回の生成の記録（列挙した欄だけ） */
export interface RunRecord {
  readonly builder: string;
  readonly model: string;
  readonly effort: string;
  readonly prompt_version: string;
  readonly contract_version: string;
  readonly spec_engine_version: string;
  readonly factory_version: string;
  readonly stages: readonly StageRecord[];
  readonly arbitration: ArbitrationCounts;
  readonly budget_remaining_usd: number;
  /**
   * 未精算の予約額（USD。打ち切った呼び出しの予約は残す。Issue #446）。組み立てで必ず書く欄なので、
   * 読む側（古い記録や手で書いた仕掛け）は省ける。
   */
  readonly budget_reserved_usd?: number;
  readonly missing_usage_calls: number;
  readonly failure: FailureAttribution | null;
}

/** 要約の欄（列挙した欄だけ。appspec-schema の wire の必須の欄＋記録の欄） */
export const SUMMARY_KEYS = [
  "schema_version",
  ...HEADLESS_REQUIRED_KEYS,
  ...RUN_RECORD_KEYS,
] as const;

/** 要約。wire（`HeadlessSummaryWire`）に、記録の欄を足したもの */
export type Summary = HeadlessSummaryWire & RunRecord;

/** 要約のうち、記録からは決まらない欄（呼ぶ側が渡す） */
export interface SummaryBase {
  readonly run_id: string;
  readonly verdict: string;
  readonly assurance: string;
  readonly duration_secs: number;
  readonly provider_cost_usd: number;
  readonly stop_class: string | null;
  /**
   * 止めた理由（§1.5・#309）。完走なら `"completed"`、早期停止なら止めた失敗の分類。省くと `null`
   * （従来の呼び出しを壊さない）。`StopReason` は完走側の値の一覧である。
   */
  readonly stopReason?: StopReason | FailureKind | null;
  readonly exit_code: number;
}

/**
 * `operation` を、**上限のある値の並び**（`STAGE_OPERATIONS`）にあるときだけ写す（Issue #410）。
 * それ以外（モデルの出力・任意の文字列・`null` など）は `null` にする。
 */
function pickStageOperation(value: unknown): StageOperation | null {
  return (STAGE_OPERATIONS as readonly unknown[]).includes(value) ? (value as StageOperation) : null;
}

/**
 * 試行の終端の計から、**列挙した下位の欄だけ**を写す（余分な欄は写さない。Issue #446）。
 * 渡した `counts` の差は、その段の呼び出しの試行の終端である。
 */
function pickAttempts(counts: AttemptCounts): AttemptCounts {
  return {
    started: counts.started,
    responded: counts.responded,
    errors: counts.errors,
    cancelled_deadline: counts.cancelled_deadline,
    cancelled_timeout: counts.cancelled_timeout,
    not_started: {
      deadline: counts.not_started.deadline,
      budget: counts.not_started.budget,
      limit: counts.not_started.limit,
      timeout: counts.not_started.timeout,
    },
  };
}

/** 再試行の数から、**列挙した下位の欄だけ**を写す（余分な欄は写さない。Issue #446） */
function pickRetries(counts: RetryCounts): RetryCounts {
  return { communication: counts.communication, shape: counts.shape, content: counts.content };
}

/**
 * 段ごとの記録を組み立てる。**列挙した欄だけ**を名指しで写す（余分な欄は写さない）。
 * 渡した `usage` の差は、その段が使ったトークンである。`counts` の差は、その段の呼び出しの試行の終端と
 * 再試行である（Issue #446）。`operation` は省けば `null`（通常の段）。
 */
export function makeStageRecord(
  stage: StageId,
  status: StageStatus,
  durationMs: number,
  usage: UsageSnapshot,
  counts: CallCounts,
  failureKind: FailureKind | null,
  operation: StageOperation | null = null,
  references?: StageReferenceCounts,
): StageRecord {
  const referencesField =
    references === undefined || !REFERENCE_COUNT_STAGES.includes(stage)
      ? {}
      : { references: Object.fromEntries(REFERENCE_COUNT_KEYS.map((key) => [key, references[key]])) as StageReferenceCounts };
  return {
    stage,
    operation: pickStageOperation(operation),
    status,
    duration_ms: durationMs,
    calls: usage.calls,
    missing_usage_calls: usage.missing_usage_calls,
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_tokens,
    attempts: pickAttempts(counts.attempts),
    retries: pickRetries(counts.retries),
    failure_kind: failureKind,
    ...referencesField,
  };
}

/** 2 つの時点の差（段ごとのトークン数） */
export function usageDelta(before: UsageSnapshot, after: UsageSnapshot): UsageSnapshot {
  return {
    calls: after.calls - before.calls,
    missing_usage_calls: after.missing_usage_calls - before.missing_usage_calls,
    input_tokens: after.input_tokens - before.input_tokens,
    cached_input_tokens: after.cached_input_tokens - before.cached_input_tokens,
    cache_write_tokens: after.cache_write_tokens - before.cache_write_tokens,
    output_tokens: after.output_tokens - before.output_tokens,
    reasoning_tokens: after.reasoning_tokens - before.reasoning_tokens,
  };
}

/**
 * すべての LLM 呼び出しを通して、呼び出しの数と使用トークンを数える（§1.5）。
 * usage が返らない呼び出しも数える（「usage が欠けた呼び出しの数」）。
 */
export class UsageMeter {
  readonly #bound: boolean;
  #calls = 0;
  #missing = 0;
  #inputTokens = 0;
  #cachedInputTokens = 0;
  #cacheWriteTokens = 0;
  #outputTokens = 0;
  #reasoningTokens = 0;

  /** `bound` は束の計量（T2 の束ごとの口）か。束と全体の 2 つが加算するので、印を分けて採る（レビュー R1） */
  constructor(bound = false) {
    this.#bound = bound;
  }

  /** いまの計（段の前後で取って差を出す） */
  get snapshot(): UsageSnapshot {
    return {
      calls: this.#calls,
      missing_usage_calls: this.#missing,
      input_tokens: this.#inputTokens,
      cached_input_tokens: this.#cachedInputTokens,
      cache_write_tokens: this.#cacheWriteTokens,
      output_tokens: this.#outputTokens,
      reasoning_tokens: this.#reasoningTokens,
    };
  }

  /** 1 回の呼び出しを数える。usage があれば足す（キャッシュの書き込みも分けて数える。#302） */
  note(usage: LlmUsage | undefined): void {
    this.#calls += 1;
    if (usage === undefined) {
      this.#missing += 1;
      return;
    }
    this.#inputTokens += usage.inputTokens;
    this.#cachedInputTokens += usage.cachedInputTokens;
    this.#cacheWriteTokens += cacheWriteTokensOf(usage);
    this.#outputTokens += usage.outputTokens;
    this.#reasoningTokens += usage.reasoningTokens;
  }

  /** 呼び出しの数を数えるように包む（この包みを通してだけ LLM を呼ぶ） */
  wrap(client: LlmClient): LlmClient {
    return {
      callStructured: async <T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> => {
        try {
          const response = await client.callStructured<T>(request);
          this.note(response.usage);
          runNoteHook(request.signal, this.#bound);
          return response;
        } catch (error) {
          // 未完了の応答は例外として現れるが、usage は付くことがある（§1.5）。呼び出しの数と
          // トークンを数えてから投げ直す——usage が無ければ「usage が欠けた呼び出し」として数える。
          if (isIncompleteResponseError(error)) {
            this.note(error.usage);
            runNoteHook(request.signal, this.#bound);
          }
          throw error;
        }
      },
      callWithTools: async (request: LlmToolRequest): Promise<LlmToolResponse> => {
        try {
          const response = await client.callWithTools(request);
          this.note(response.usage);
          runNoteHook(request.signal, this.#bound);
          return response;
        } catch (error) {
          if (isIncompleteResponseError(error)) {
            this.note(error.usage);
            runNoteHook(request.signal, this.#bound);
          }
          throw error;
        }
      },
    };
  }
}

// ── 実試行の行と段全体の span（旗 `v12.ids` の段の走りだけ。Issue #748）──────────────
//
// 段の行（`StageRecord`）は段ごとの合計だけを持ち、並列の区間では「段の行の時間」「実試行の時間の合計」
// 「段全体の壁時計」が別物になる。ここは**内訳**を残すだけで、合計（段の行）には足さない（二重に数えない）。
// 行は、入口の client を使う全部の経路（親の口と T2 の束ごとの口）が共有する 1 つの観測器が積む。

/** 実試行 1 行の終わりの分類（口が確定した分類。Issue #748） */
export const CALL_REQUEST_END_KINDS = ["response", "incomplete", "error", "timeout", "deadline"] as const;
export type CallRequestEndKind = (typeof CALL_REQUEST_END_KINDS)[number];

/** 誤りで終わった行の分類（要求の不正は口の分類に無いので別に持つ。Issue #748） */
export type CallRequestErrorKind = CallErrorKind | "invalid-request";

/** 行のトークン（usage が無ければ行の `usage` が null） */
export interface CallRequestUsage {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
}

/**
 * 遅着の欄（Issue #748）。打ち切りのあとに client が応答・未完了を返したとき、行の終わり方は変えず、
 * ここに usage（無ければ null）と、**今の計量がその加算を実際に含んだ段の行の位置**を残す。
 * どの行の差にも入らなければ `metered_stage_index` は null。
 */
export interface CallRequestLate {
  readonly usage: CallRequestUsage | null;
  readonly metered_stage_index: number | null;
}

/** 実試行 1 行（`stage_index` は段の行への参照。Issue #748） */
export interface CallRequestRecord {
  readonly stage_index: number | null;
  /** 走りの開始からのミリ秒 */
  readonly start_ms: number;
  /** 走りの開始からのミリ秒 */
  readonly end_ms: number;
  readonly end: CallRequestEndKind;
  readonly error_kind: CallRequestErrorKind | null;
  readonly usage: CallRequestUsage | null;
  readonly late: CallRequestLate;
}

/** 段全体の span を持てる段（束に分けて並列に呼ぶ段。Issue #748） */
export const CALL_SPAN_STAGES = ["mapping", "semantic-check", "test-spec"] as const;
export type CallSpanStage = (typeof CALL_SPAN_STAGES)[number];

/**
 * 束に分けた段の全体の開始と終わり（Issue #748）。段の行は変えず、別の欄に残す。
 * `stage_indices` は対応する段の行の位置（C2・C3 は各回の行 1 つ、T2 は束の各行）。
 * 途中で止まった段は `end_ms` が null、到達しなかった段は span そのものを持たない。
 */
export interface StageSpanRecord {
  readonly stage: CallSpanStage;
  readonly round: number | null;
  readonly start_ms: number;
  readonly end_ms: number | null;
  readonly stage_indices: readonly number[];
}

/** 段の行のもとになる単位（この中の実試行が、あとで決まる段の行の位置を指す。Issue #748） */
export interface CallRequestUnit {
  rowIndex: number | null;
  open: boolean;
}

interface MutableCallRequestRow {
  readonly unit: CallRequestUnit | null;
  readonly startMs: number;
  endMs: number;
  end: CallRequestEndKind | null;
  errorKind: CallRequestErrorKind | null;
  usage: CallRequestUsage | null;
  lateUsage: CallRequestUsage | null;
  /** 遅着の加算を含んだ段の行の単位（まだ行の位置が決まっていなければ null でない単位のまま） */
  lateUnit: CallRequestUnit | null;
  /** 束の計量が加算した時点で開いていた束の単位（確定後は採らない。レビュー R1） */
  boundUnit: CallRequestUnit | null;
  /** 全体の計量が加算した時点で開いていた全体の単位（レビュー R1） */
  globalUnit: CallRequestUnit | null;
  noted: boolean;
}

/** 段全体の span の積み途中の状態（`openSpan` が返す。Issue #748） */
export interface StageSpanState {
  readonly stage: CallSpanStage;
  readonly round: number | null;
  readonly startMs: number;
  endMs: number | null;
  stageIndices: readonly number[];
}

/** usage を、行のトークンの欄に写す（usage が無ければ null。 Issue #748） */
export function callRequestUsageOf(usage: LlmUsage | undefined): CallRequestUsage | null {
  if (usage === undefined) return null;
  return {
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_tokens: cacheWriteTokensOf(usage),
    output_tokens: usage.outputTokens,
    reasoning_tokens: usage.reasoningTokens,
  };
}

/**
 * 実試行の行と段全体の span を積む観測器（Issue #748）。親の口と T2 の束ごとの口が**同じ 1 つ**を共有する。
 *
 * 単位（`beginUnit`）は、段の行を積むもとになる区間である。単位の中で始まった実試行の行は、その単位の
 * 段の行を指す。T2 の束は `beginBoundUnit` で**全体の単位にしない**——同時に走る束が互いの行を指さないため。
 * 遅着の加算の帰属は、`note`（計量の加算の時点）で採った所属——行の単位が開いている間ならその単位、
 * 閉じていれば**その時点で開いている全体の単位**、どちらも無ければ null——から解く（今の計量の前後の
 * スナップショットの差に実際に含まれる行と一致する）。観測の callback が動いた時点では解かない（レビュー R1）。
 */
export class CallRequestLog {
  readonly #startedAt: () => number;
  readonly #now: () => number;
  readonly #rows: MutableCallRequestRow[] = [];
  readonly #spans: StageSpanState[] = [];
  #globalUnit: CallRequestUnit | null = null;

  constructor(startedAt: number | (() => number), now: () => number) {
    this.#startedAt = typeof startedAt === "function" ? startedAt : () => startedAt;
    this.#now = now;
  }

  /** 全体の単位（runStage・runStageOk・C1・C2 の直接の記録）を始める */
  beginUnit(): CallRequestUnit {
    const unit: CallRequestUnit = { rowIndex: null, open: true };
    this.#globalUnit = unit;
    return unit;
  }

  /** T2 の束の単位を始める（全体の単位にはしない） */
  beginBoundUnit(): CallRequestUnit {
    return { rowIndex: null, open: true };
  }

  /** 段の行を積んだあと、その行の位置で単位を閉じる */
  finishUnit(unit: CallRequestUnit | undefined, rowIndex: number): void {
    if (unit === undefined) return;
    unit.rowIndex = rowIndex;
    unit.open = false;
    if (this.#globalUnit === unit) this.#globalUnit = null;
  }

  /** 観測の口を作る（単位を渡せばその単位に、渡さなければ始めた時点の全体の単位に属する） */
  observer(unit?: CallRequestUnit): CallAttemptObserver {
    return { beginAttempt: () => this.#begin(unit ?? this.#globalUnit) };
  }

  /** 束に分けた段の全体の span を開く（`startMs` は走りの開始からのミリ秒） */
  openSpan(stage: CallSpanStage, round: number | null, startMs: number): StageSpanState {
    const span: StageSpanState = { stage, round, startMs, endMs: null, stageIndices: [] };
    this.#spans.push(span);
    return span;
  }

  /** span を閉じる（成功した段だけ。`stageIndices` は対応する段の行の位置） */
  closeSpan(span: StageSpanState | undefined, stageIndices: readonly number[], endMs: number): void {
    if (span === undefined) return;
    span.stageIndices = stageIndices.slice();
    span.endMs = endMs;
  }

  /** 途中で止まった span を閉じる（終わりは null のまま。到達した行だけを持つ） */
  failSpan(span: StageSpanState | undefined, stageIndices: readonly number[]): void {
    if (span === undefined) return;
    span.stageIndices = stageIndices.slice();
  }

  /** 行（開始の順）。遅着の加算を含んだ行の位置は、段の行の位置が決まってから解く */
  requests(): readonly CallRequestRecord[] {
    return this.#rows.map((row) => ({
      stage_index: row.unit?.rowIndex ?? null,
      start_ms: row.startMs,
      end_ms: row.endMs,
      end: row.end ?? "error",
      error_kind: row.errorKind,
      usage: row.usage,
      late: {
        usage: row.lateUsage,
        metered_stage_index: row.lateUnit?.rowIndex ?? null,
      },
    }));
  }

  /** 段全体の span（開始の順。到達しなかった段は無い） */
  stageSpans(): readonly StageSpanRecord[] {
    return this.#spans.map((span) => ({
      stage: span.stage,
      round: span.round,
      start_ms: span.startMs,
      end_ms: span.endMs,
      stage_indices: span.stageIndices.slice(),
    }));
  }

  #begin(unit: CallRequestUnit | null): CallAttemptObservation {
    const startMs = this.#now() - this.#startedAt();
    const row: MutableCallRequestRow = {
      unit,
      startMs,
      endMs: startMs,
      end: null,
      errorKind: null,
      usage: null,
      lateUsage: null,
      lateUnit: null,
      boundUnit: null,
      globalUnit: null,
      noted: false,
    };
    this.#rows.push(row);
    return {
      settle: (end: CallAttemptEnd): void => {
        // 行はちょうど 1 度だけ確定する（2 度目以降は打ち切りのあとの遅着として扱う）
        if (row.end !== null) return;
        row.endMs = this.#now() - this.#startedAt();
        row.end = end.kind;
        if (end.kind === "response" || end.kind === "incomplete") row.usage = callRequestUsageOf(end.usage);
        else if (end.kind === "error") row.errorKind = end.errorKind;
      },
      note: (bound: boolean): void => {
        // 計量がこの試行の加算をした時点の所属を採る（観測の callback の時点ではない。Issue #748 のレビュー R1）。
        // T2 は束と全体の 2 つの計量が同じ応答を数えるので、束は開いている束の単位、全体は全体の単位で**別々に**採る
        row.noted = true;
        if (bound) {
          if (row.unit !== null && row.unit.open) row.boundUnit = row.unit;
        } else {
          row.globalUnit = this.#globalUnit;
        }
      },
      late: (usage: LlmUsage | undefined): void => {
        // 打ち切りのあとに返った応答・未完了だけが遅着。行の終わり方・時刻・所属は変えない
        if (row.end !== "timeout" && row.end !== "deadline") return;
        row.lateUsage = callRequestUsageOf(usage);
        // 計量の加算の時点の印があればそれを使う。無ければ（印を渡さない単体の試験）従来どおりこの時点で解く
        row.lateUnit = row.noted
          ? (row.boundUnit ?? row.globalUnit)
          : row.unit !== null && row.unit.open
            ? row.unit
            : this.#globalUnit;
      },
    };
  }
}

/**
 * 失敗の帰属を、列挙した欄に写す（S-7・S-8・#304）。`code`・`problems`・`limit` は**あるときだけ**写し、
 * 欄の名前と問題の種類・上限の名前と数だけを残す（値の中身は残さない。`limit` は Issue #665）。
 */
function pickFailure(failure: FailureAttribution): FailureAttribution {
  const picked: FailureAttribution =
    failure.code === undefined
      ? { stage: failure.stage, kind: failure.kind }
      : { stage: failure.stage, kind: failure.kind, code: failure.code };
  const limited: FailureAttribution =
    failure.limit === undefined
      ? picked
      : { ...picked, limit: { name: failure.limit.name, max: failure.limit.max, actual: failure.limit.actual } };
  if (failure.problems === undefined || failure.problems.length === 0) return limited;
  return {
    ...limited,
    problems: failure.problems.map((problem) => ({ field: problem.field, message: problem.message })),
  };
}

/** 記録を組み立てる。**列挙した欄だけ**を写す（余分な欄は渡されても落ちる） */
export function buildRunRecord(input: RunRecord): RunRecord {
  const failure = input.failure;
  return {
    builder: input.builder,
    model: input.model,
    effort: input.effort,
    prompt_version: input.prompt_version,
    contract_version: input.contract_version,
    spec_engine_version: input.spec_engine_version,
    factory_version: input.factory_version,
    stages: input.stages.map((stage) =>
      makeStageRecord(
        stage.stage,
        stage.status,
        stage.duration_ms,
        stage,
        { attempts: stage.attempts, retries: stage.retries },
        stage.failure_kind,
        stage.operation,
        stage.references,
      ),
    ),
    arbitration: {
      upheld: input.arbitration.upheld,
      overturned: input.arbitration.overturned,
      undecidable: input.arbitration.undecidable,
    },
    budget_remaining_usd: input.budget_remaining_usd,
    budget_reserved_usd: input.budget_reserved_usd ?? 0,
    missing_usage_calls: input.missing_usage_calls,
    failure: failure === null ? null : pickFailure(failure),
  };
}

/**
 * 要約を組み立てる。**列挙した欄（`SUMMARY_KEYS`）だけ**を名指しで写す。
 * wire の必須の欄は、値が無ければ `null`（並びは空、写像は空）で埋める（CommandAgent と同じ約束）。
 */
export function buildSummary(record: RunRecord, base: SummaryBase): Summary {
  const picked = buildRunRecord(record);
  return {
    schema_version: HEADLESS_SCHEMA_VERSION,
    run_id: base.run_id,
    verdict: base.verdict,
    assurance: base.assurance,
    score: null,
    acceptance_sheet_path: null,
    artifacts_dir: "artifacts",
    events_path: null,
    duration_secs: base.duration_secs,
    provider_cost_usd: base.provider_cost_usd,
    provider_usage_by_role: {},
    stop_class: base.stop_class,
    directive_round: null,
    status: "completed",
    gate: null,
    stop_reason: base.stopReason ?? null,
    next_action: null,
    changed_files: [],
    verify_commands: [],
    exit_code: base.exit_code,
    builder: picked.builder,
    model: picked.model,
    effort: picked.effort,
    prompt_version: picked.prompt_version,
    contract_version: picked.contract_version,
    spec_engine_version: picked.spec_engine_version,
    factory_version: picked.factory_version,
    stages: picked.stages,
    arbitration: picked.arbitration,
    budget_remaining_usd: picked.budget_remaining_usd,
    budget_reserved_usd: picked.budget_reserved_usd ?? 0,
    missing_usage_calls: picked.missing_usage_calls,
    failure: picked.failure,
  };
}
