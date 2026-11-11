// 段の進み（studio-s1.md §4.4・Issue #867 の目的・5）。
//
// 工場は全部のファイルを最後に書くので、進みは LLM の adapter を包んで出す。要求の `schemaName` から
// 段の表示名を引き（知らない名前は「作業中」）、応答の tokens × 単価で概算の額を数えて、呼び出しごとに
// 親へ通知する。単価は要求の `model` があればその単価、無ければ既定の単価である。
import {
  DECL_CHECK_SCHEMA_NAME,
  FIELD_REPAIR_SCHEMA_NAME,
  MAPPING_SCHEMA_NAME,
  NAME_TABLE_SCHEMA_NAME,
  SEMANTIC_CHECK_SCHEMA_NAME,
  TEST_SPEC_SCHEMA_NAME,
  VOCABULARY_SCHEMA_NAMES,
  WRITE_V11A_SCHEMA_NAME,
  costOfUsageUsd,
  modelRatesOf,
  type LlmClient,
  type LlmStructuredRequest,
  type LlmStructuredResponse,
  type LlmToolRequest,
  type LlmToolResponse,
  type LlmUsage,
  type TokenRates,
} from "@musunest/factory";
import type { RunnerProgress } from "./runner.js";

/** 知らない段の表示名 */
export const UNKNOWN_STAGE_LABEL = "作業中" as const;

/**
 * schemaName → 段の表示名。工場の公開の定数から引く（写しのずれを作らない）。
 * 表示名は利用者の言葉で、宣言の用語を使わない。
 */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  [NAME_TABLE_SCHEMA_NAME]: "名前の表",
  [VOCABULARY_SCHEMA_NAMES.entities]: "名前の表",
  [VOCABULARY_SCHEMA_NAMES.fields]: "名前の表",
  [VOCABULARY_SCHEMA_NAMES.behaviors]: "名前の表",
  [MAPPING_SCHEMA_NAME]: "名前の表",
  [TEST_SPEC_SCHEMA_NAME]: "試験",
  [WRITE_V11A_SCHEMA_NAME]: "書く",
  [SEMANTIC_CHECK_SCHEMA_NAME]: "点検",
  [DECL_CHECK_SCHEMA_NAME]: "点検",
  [FIELD_REPAIR_SCHEMA_NAME]: "直す",
};

/** schemaName から段の表示名を引く（知らない名前・名前の無い要求は「作業中」） */
export function stageLabelOf(schemaName: string | undefined): string {
  if (schemaName === undefined) return UNKNOWN_STAGE_LABEL;
  return STAGE_LABELS[schemaName] ?? UNKNOWN_STAGE_LABEL;
}

export interface ProgressTrackerOptions {
  /** 進みの通知（親へ送る） */
  readonly notify: (progress: RunnerProgress) => void;
  /** 要求のモデルから単価を引く（既定は工場の単価の表） */
  readonly ratesFor?: (model: string | undefined) => TokenRates;
}

/** LLM の adapter を包み、段の表示名と概算の額を数える包み */
export interface ProgressTracker {
  /** いまの概算の額（USD） */
  readonly estimatedUsd: number;
  /** いまの段の表示名 */
  readonly stage: string;
  wrap(client: LlmClient): LlmClient;
}

/** 進みを数える包みを作る */
export function createProgressTracker(options: ProgressTrackerOptions): ProgressTracker {
  const ratesFor = options.ratesFor ?? ((model: string | undefined): TokenRates => modelRatesOf(model ?? ""));
  let estimatedUsd = 0;
  let stage: string = UNKNOWN_STAGE_LABEL;

  const report = (): void => {
    options.notify({ stage, estimatedUsd });
  };

  const addUsage = (usage: LlmUsage | undefined, model: string | undefined): void => {
    if (usage === undefined) return;
    estimatedUsd += costOfUsageUsd(usage, ratesFor(model));
  };

  return {
    get estimatedUsd(): number {
      return estimatedUsd;
    },
    get stage(): string {
      return stage;
    },
    wrap(client: LlmClient): LlmClient {
      return {
        async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
          stage = stageLabelOf(request.schemaName);
          report();
          const response = await client.callStructured<T>(request);
          addUsage(response.usage, request.model);
          report();
          return response;
        },
        async callWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
          stage = stageLabelOf(request.schemaName);
          report();
          const response = await client.callWithTools(request);
          addUsage(response.usage, request.model);
          report();
          return response;
        },
      };
    },
  };
}
