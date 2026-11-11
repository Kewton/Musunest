// Build の入力の包み（`plan-result.json` の形。studio-s1.md §4.2・Issue #867 の目的・3）。
//
// 工場の `--plan-file` が読む包みを組む helper は公開されていない（`cli-plan.ts` は index に無い）ので、
// 工房が同じ形を組む。欄は工場の `PlanOnlyResult` と同じで、版・結果・仕様・仕様の SHA-256・依頼文の
// SHA-256・実行条件・止まり方である。仕様の SHA-256 は appspec-schema の `planDigest` を正本にする。
import { createHash } from "node:crypto";
import { planDigest, type ConfirmedPlan } from "@musunest/appspec-schema";
import {
  CONTRACT_VERSION,
  FACTORY_VERSION,
  PROMPT_VERSION_V12,
  SPEC_ENGINE_VERSION,
  VOCABULARY_VERSION,
  type PlanResult,
} from "@musunest/factory";

/** 包みの版（工場の `PLAN_ONLY_RESULT_SCHEMA` と同じ値。Issue #495） */
export const PLAN_RESULT_SCHEMA = "musunest-factory/plan-only-result/v1" as const;

/** 包みの実行条件（工場の `PlanCliConditions` と同じ欄。人が作る包みでも値を持つ） */
export interface PlanEnvelopeConditions {
  readonly model: string;
  readonly effort: string;
  readonly budget_usd: number;
  readonly deadline_ms: number;
  readonly timeout_ms: number | null;
  readonly vocabulary_version: string;
  readonly prompt_version: string;
  readonly contract_version: string;
  readonly factory_version: string;
  readonly spec_engine_version: string;
}

/** 包み（`plan-result.json` の形） */
export interface PlanEnvelope {
  readonly schema_version: typeof PLAN_RESULT_SCHEMA;
  readonly outcome: "confirmed";
  readonly plan: ConfirmedPlan;
  readonly plan_sha256: string;
  readonly source_sha256: string;
  readonly conditions: PlanEnvelopeConditions;
  readonly stop: null;
}

/** 文字列（UTF-8）の SHA-256 を、小文字の 16 進 64 桁で返す */
export async function sha256Hex(text: string): Promise<string> {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 標準の実行条件を組む（Plan の組み立てと同じ値） */
export function defaultPlanEnvelopeConditions(input: {
  readonly model: string;
  readonly effort: string;
  readonly budgetUsd: number;
  readonly deadlineMs: number;
}): PlanEnvelopeConditions {
  return {
    model: input.model,
    effort: input.effort,
    budget_usd: input.budgetUsd,
    deadline_ms: input.deadlineMs,
    timeout_ms: null,
    vocabulary_version: VOCABULARY_VERSION,
    prompt_version: PROMPT_VERSION_V12,
    contract_version: CONTRACT_VERSION,
    factory_version: FACTORY_VERSION,
    spec_engine_version: SPEC_ENGINE_VERSION,
  };
}

export interface BuildPlanEnvelopeInput {
  /** Plan の結果（確定したものだけを包める） */
  readonly result: PlanResult;
  /** 依頼文の原文（SHA-256 を求める。包みには入れない） */
  readonly source: string;
  readonly conditions: PlanEnvelopeConditions;
}

/**
 * 確定した仕様から包みを組む。確定していない結果は包めない（黙って空の包みを作らない）。
 * 仕様の SHA-256 は `planDigest`、依頼文の SHA-256 は `sha256Hex` で求める——工場の検査と同じ値になる。
 */
export async function buildPlanEnvelope(input: BuildPlanEnvelopeInput): Promise<PlanEnvelope> {
  if (input.result.kind !== "confirmed") {
    throw new Error("確定した仕様が無いため、Build の包みを組めません");
  }
  const plan = input.result.plan;
  return {
    schema_version: PLAN_RESULT_SCHEMA,
    outcome: "confirmed",
    plan,
    plan_sha256: await planDigest(plan),
    source_sha256: await sha256Hex(input.source),
    conditions: input.conditions,
    stop: null,
  };
}
