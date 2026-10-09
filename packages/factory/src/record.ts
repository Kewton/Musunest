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
import { isIncompleteResponseError } from "./call.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmUsage,
} from "./llm.js";

/** 段の識別子（02 §1 の段。①〜⑧） */
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
] as const;
export type StageId = (typeof STAGE_IDS)[number];

/** 段の結果 */
export const STAGE_STATUSES = ["ok", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** 失敗の分類（どの種類の失敗か。02 §1.5・§2.2・S-7） */
export const FAILURE_KINDS = [
  "limit", // 入力の上限（依頼文の長さなど）
  "deadline", // 締切切れ
  "budget", // 予約の残高切れ
  "call-limit", // 呼び出しの数の超過
  "malformed", // 形が合わない応答が続いた
  "refused", // 拒否が続いた
  "invalid-request", // 要求そのものが不正（HTTP 400 など。やり直しても通らない）
  "unmet", // コードの検査に合わなかった（未達）
  "incomplete", // 静的チェックを通った版が無いまま終わった
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** 失敗の帰属（どの段の・どの種類の失敗か。S-7） */
export interface FailureAttribution {
  readonly stage: StageId;
  readonly kind: FailureKind;
  /**
   * 要求そのものが不正なときの、API の誤りの種類（例: `invalid_json_schema`。§2.2・S-8）。
   * それ以外の失敗では持たない。**誤りの本文の全文は持たない**（種類だけを残す）。
   */
  readonly code?: string;
}

/** 使用トークンの計（呼び出しの数と、usage が欠けた呼び出しの数を含む。§1.5） */
export interface UsageSnapshot {
  readonly calls: number;
  readonly missing_usage_calls: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
}

/** 段ごとの記録の欄（この欄だけを持つ） */
export const STAGE_RECORD_KEYS = [
  "stage",
  "status",
  "duration_ms",
  "calls",
  "missing_usage_calls",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "failure_kind",
] as const;
export type StageRecordKey = (typeof STAGE_RECORD_KEYS)[number];

/** 段ごとの記録（列挙した欄だけ） */
export interface StageRecord {
  readonly stage: StageId;
  readonly status: StageStatus;
  readonly duration_ms: number;
  readonly calls: number;
  readonly missing_usage_calls: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly failure_kind: FailureKind | null;
}

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
  readonly exit_code: number;
}

/**
 * 段ごとの記録を組み立てる。**列挙した欄だけ**を名指しで写す（余分な欄は写さない）。
 * 渡した `usage` の差は、その段が使ったトークンである。
 */
export function makeStageRecord(
  stage: StageId,
  status: StageStatus,
  durationMs: number,
  usage: UsageSnapshot,
  failureKind: FailureKind | null,
): StageRecord {
  return {
    stage,
    status,
    duration_ms: durationMs,
    calls: usage.calls,
    missing_usage_calls: usage.missing_usage_calls,
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_tokens,
    failure_kind: failureKind,
  };
}

/** 2 つの時点の差（段ごとのトークン数） */
export function usageDelta(before: UsageSnapshot, after: UsageSnapshot): UsageSnapshot {
  return {
    calls: after.calls - before.calls,
    missing_usage_calls: after.missing_usage_calls - before.missing_usage_calls,
    input_tokens: after.input_tokens - before.input_tokens,
    cached_input_tokens: after.cached_input_tokens - before.cached_input_tokens,
    output_tokens: after.output_tokens - before.output_tokens,
    reasoning_tokens: after.reasoning_tokens - before.reasoning_tokens,
  };
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
  #outputTokens = 0;
  #reasoningTokens = 0;

  /** いまの計（段の前後で取って差を出す） */
  get snapshot(): UsageSnapshot {
    return {
      calls: this.#calls,
      missing_usage_calls: this.#missing,
      input_tokens: this.#inputTokens,
      cached_input_tokens: this.#cachedInputTokens,
      output_tokens: this.#outputTokens,
      reasoning_tokens: this.#reasoningTokens,
    };
  }

  /** 1 回の呼び出しを数える。usage があれば足す */
  note(usage: LlmUsage | undefined): void {
    this.#calls += 1;
    if (usage === undefined) {
      this.#missing += 1;
      return;
    }
    this.#inputTokens += usage.inputTokens;
    this.#cachedInputTokens += usage.cachedInputTokens;
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
      makeStageRecord(stage.stage, stage.status, stage.duration_ms, stage, stage.failure_kind),
    ),
    arbitration: {
      upheld: input.arbitration.upheld,
      overturned: input.arbitration.overturned,
      undecidable: input.arbitration.undecidable,
    },
    budget_remaining_usd: input.budget_remaining_usd,
    missing_usage_calls: input.missing_usage_calls,
    failure:
      failure === null
        ? null
        : failure.code === undefined
          ? { stage: failure.stage, kind: failure.kind }
          : { stage: failure.stage, kind: failure.kind, code: failure.code },
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
    stop_reason: null,
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
    missing_usage_calls: picked.missing_usage_calls,
    failure: picked.failure,
  };
}
