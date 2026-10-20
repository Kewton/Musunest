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
  type AttemptCounts,
  type CallCounts,
  type RetryCounts,
} from "./call.js";
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

/** トークン数の項目ごとの合計（束ごとの計量を段全体へ足す。旗 `v12.ids` の C3 の束。Issue #662） */
export function usageSum(snapshots: readonly UsageSnapshot[]): UsageSnapshot {
  return snapshots.reduce<UsageSnapshot>(
    (sum, item) => ({
      calls: sum.calls + item.calls,
      missing_usage_calls: sum.missing_usage_calls + item.missing_usage_calls,
      input_tokens: sum.input_tokens + item.input_tokens,
      cached_input_tokens: sum.cached_input_tokens + item.cached_input_tokens,
      cache_write_tokens: sum.cache_write_tokens + item.cache_write_tokens,
      output_tokens: sum.output_tokens + item.output_tokens,
      reasoning_tokens: sum.reasoning_tokens + item.reasoning_tokens,
    }),
    { calls: 0, missing_usage_calls: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
  );
}

/** 呼び出しの計の項目ごとの合計（束ごとの口の計を段全体へ足す。旗 `v12.ids` の C3 の束。Issue #662） */
export function callCountsSum(counts: readonly CallCounts[]): CallCounts {
  const zero: CallCounts = {
    attempts: {
      started: 0,
      responded: 0,
      errors: 0,
      cancelled_deadline: 0,
      cancelled_timeout: 0,
      not_started: { deadline: 0, budget: 0, limit: 0, timeout: 0 },
    },
    retries: { communication: 0, shape: 0, content: 0 },
  };
  return counts.reduce<CallCounts>(
    (sum, item) => ({
      attempts: {
        started: sum.attempts.started + item.attempts.started,
        responded: sum.attempts.responded + item.attempts.responded,
        errors: sum.attempts.errors + item.attempts.errors,
        cancelled_deadline: sum.attempts.cancelled_deadline + item.attempts.cancelled_deadline,
        cancelled_timeout: sum.attempts.cancelled_timeout + item.attempts.cancelled_timeout,
        not_started: {
          deadline: sum.attempts.not_started.deadline + item.attempts.not_started.deadline,
          budget: sum.attempts.not_started.budget + item.attempts.not_started.budget,
          limit: sum.attempts.not_started.limit + item.attempts.not_started.limit,
          timeout: sum.attempts.not_started.timeout + item.attempts.not_started.timeout,
        },
      },
      retries: {
        communication: sum.retries.communication + item.retries.communication,
        shape: sum.retries.shape + item.retries.shape,
        content: sum.retries.content + item.retries.content,
      },
    }),
    zero,
  );
}

/**
 * すべての LLM 呼び出しを通して、呼び出しの数と使用トークンを数える（§1.5）。
 * usage が返らない呼び出しも数える（「usage が欠けた呼び出しの数」）。
 */
export class UsageMeter {
  #calls = 0;
  #missing = 0;
  #inputTokens = 0;
  #cachedInputTokens = 0;
  #cacheWriteTokens = 0;
  #outputTokens = 0;
  #reasoningTokens = 0;

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
          return response;
        } catch (error) {
          // 未完了の応答は例外として現れるが、usage は付くことがある（§1.5）。呼び出しの数と
          // トークンを数えてから投げ直す——usage が無ければ「usage が欠けた呼び出し」として数える。
          if (isIncompleteResponseError(error)) this.note(error.usage);
          throw error;
        }
      },
      callWithTools: async (request: LlmToolRequest): Promise<LlmToolResponse> => {
        try {
          const response = await client.callWithTools(request);
          this.note(response.usage);
          return response;
        } catch (error) {
          if (isIncompleteResponseError(error)) this.note(error.usage);
          throw error;
        }
      },
    };
  }
}

/**
 * 失敗の帰属を、列挙した欄に写す（S-7・S-8・#304）。`code` と `problems` は**あるときだけ**写し、
 * 欄の名前と問題の種類だけを残す（値の中身は残さない）。
 */
function pickFailure(failure: FailureAttribution): FailureAttribution {
  const picked: FailureAttribution =
    failure.code === undefined
      ? { stage: failure.stage, kind: failure.kind }
      : { stage: failure.stage, kind: failure.kind, code: failure.code };
  if (failure.problems === undefined || failure.problems.length === 0) return picked;
  return {
    ...picked,
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
