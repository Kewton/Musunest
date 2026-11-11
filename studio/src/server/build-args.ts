// Build の標準の組（studio-s1.md §4.3・Issue #867 の目的・4）。
//
// 工場の手元の入口（`runCli`）を、CLI と同じ口で呼ぶための引数を組む。標準の組の値は画面から変えられない。
// 予算は 2.00 から Plan の使った額を引いた残りで、セント（整数）で数えて 2.00 を超えない。
import { PER_RUN_LIMIT_USD } from "./runner.js";

/** 標準の組のモデル */
export const STANDARD_BUILD_MODEL = "gpt-6-luna" as const;
/** 標準の組の effort */
export const STANDARD_BUILD_EFFORT = "medium" as const;
/** 標準の組の段ごとの effort */
export const STANDARD_BUILD_STAGE_EFFORT = "test-spec=high" as const;
/** 標準の組の段ごとのモデル */
export const STANDARD_BUILD_STAGE_MODEL = "test-spec=gpt-6.1-terra" as const;

export interface BuildArgsInput {
  /** 依頼文のファイル（工場の入口の最初の引数） */
  readonly requestFile: string;
  /** 納品物の置き場所（`--out`） */
  readonly outDir: string;
  /** 確定した仕様の包み（`--plan-file`） */
  readonly planFile: string;
  /** Plan が使った額（USD） */
  readonly planSpentUsd: number;
  /** 1 回の走りの上限（既定 2.00） */
  readonly perRunLimitUsd?: number;
}

/**
 * Build に残る予算。**セントで引く**——小数の足し引きで 2.00 を超えないためである。
 * 残りが負なら 0 にする（Build は起こさない）。
 */
export function remainingBuildBudgetUsd(planSpentUsd: number, perRunLimitUsd: number = PER_RUN_LIMIT_USD): number {
  const limitCents = Math.round(perRunLimitUsd * 100);
  const spentCents = Math.round(planSpentUsd * 100);
  return Math.max(0, limitCents - spentCents) / 100;
}

/**
 * Build の引数を組む。標準の組の 7 つの旗（`--pipeline`・`--plan-file`・`--model`・`--effort`・
 * `--stage-effort`・`--stage-model`・`--budget`）と、依頼文のファイル・`--out` を並べる。
 * 予算は小数 2 桁の文字列にして、工場の引数の読み取り（`Number`）に渡す。
 */
export function buildFactoryBuildArgs(input: BuildArgsInput): readonly string[] {
  const budgetUsd = remainingBuildBudgetUsd(input.planSpentUsd, input.perRunLimitUsd ?? PER_RUN_LIMIT_USD);
  return [
    input.requestFile,
    "--out",
    input.outDir,
    "--pipeline",
    "v1.2",
    "--plan-file",
    input.planFile,
    "--model",
    STANDARD_BUILD_MODEL,
    "--effort",
    STANDARD_BUILD_EFFORT,
    "--stage-effort",
    STANDARD_BUILD_STAGE_EFFORT,
    "--stage-model",
    STANDARD_BUILD_STAGE_MODEL,
    "--budget",
    budgetUsd.toFixed(2),
  ];
}
