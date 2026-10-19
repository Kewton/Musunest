// 手元の入口（02-architecture.md §3.2）。
//
// `factory:run -- <依頼文のファイル> --out <ディレクトリ>` で、手元から 1 回の生成を流す。出力は納品物の
// ディレクトリである。**この入口だけが環境変数とファイルを扱う**——鍵は環境変数 `OPENAI_API_KEY`（LLM）と
// `JEV_API_KEY`（Jev）から読み、文書（契約・語彙の意味・語彙の台帳）はファイルから読む。単価はここで渡す
// （日付付きの既定値）。**判定の口（05 §4）もここで組み立てて生成に渡す**——`JEV_API_KEY` があれば Jev を
// 主・LLM を落とし先にした組み合わせ、無ければ LLM だけを使う（標準エラーに 1 行出す）。
//
// **ライブラリ（run.ts・bundle.ts・record.ts・段）は、環境変数もファイルも Node 固有の API も持たない。**
// ここが外側との境目である。鍵が無ければ、API を呼ばずに使い方の誤りで終わる。
//
// `--pipeline v1.1a`（既定 v1）を付けると、確定した仕様（`--plan-file`）から v1.1α の経路（`v11a/run.ts`）を流す
// （`07-architecture-v1.1a.md` §3・Issue #511）。v1.1α は `--plan-file` と組んでだけ受ける。`--pipeline` を省けば
// v1 の経路で、LLM への要求・納品物・要約・終了コードは今までとバイト列で同じである。
// `--pipeline v1.2` は、v1.1α の経路に merge 済みの手の旗を全部 on（`V12_PIPELINE_FLAGS`。今は性質の台帳と探索型の直し。
// 公開の鍵で書いた組を `fromPublicV12Flags` で実効の旗にして渡す。Issue #551）で流す
// （`08-architecture-v1.2.md` §9・Issue #547）。受け方は `v1.1a` と同じ（`--plan-file` と組んでだけ）で、封筒は v1.2 の封筒
// （`stage-envelope-v12`。旗の組から導き、全段で同じ。Issue #588。旗 ids が on なら識別子 `v1.2-ids`＝名前は同じで C2 の枝が
// 検査の種類ごとの欄の封筒。Issue #682）、
// 要約と条件の記録の `prompt_version` は `v1.2`、条件の記録には `pipeline` と実効の旗の組 `v12_flags` を足し、要約にも
// `v12_flags` を書く。`v1.1a` は旗を全部 off で流し、新しい欄を出さない。
//
// `--stage-start <段>`・`--stage-end <段>`・`--stage-input <checkpoint>` を付けると、v1.1α の経路を段の範囲だけ
// 流す（段単位の実行口。`08-architecture-v1.2.md` §8.3・Issue #544）。`--pipeline v1.1a --plan-file` か
// `--pipeline v1.2 --plan-file` と組んでだけ受ける（v1.2 は Issue #637）。再開の入力は**クライアントを作る前に**照合し、合わなければ API を呼ばず、何も書かずに終了コード 4
// と固定の符号 1 行（標準エラー）で終わる。段の走りは納品物を書かず、境界の checkpoint と段の走りの記録だけを
// 書く。旗を省けば今までの走りとバイト列で同じである（checkpoint も書かない）。
//
// `--pipeline v1.2` の段の走りは、一気通貫と同じ旗の組・封筒・プロンプトの版で流し（旗 ids の走りは呼び出しの上限も置く）、
// `--stage-start vocabulary` を区間 0 の別名として受けて範囲と記録を正本の名前 `name-table` に正規化する。checkpoint の版に
// 台帳の指紋 `ledger`・実効の旗の組 `flags`・呼び出しの上限 `call_limits` を足し（一気通貫の走りの checkpoint も同じ）、段の入力の
// 照合は `flags`・`ledger` が今の走りと同じことを求める。段の走りの記録の条件に `pipeline`・`v12_flags`・`v12_call_limits`、記録に
// `v12_calls` と（範囲が `test-spec` を含むとき）`test_spec` を足す。v1.1a の段の走りは何も変えない（Issue #637）。
//
// `--pipeline v1.2` の一気通貫の走りのうち旗 v12.ids が on の走りは、通った境界（T1''／T2・T2／B1）の checkpoint を段の走りと
// 同じ関数・同じ名前で `--out` の直下に書き（納品物の manifest には載せない）、Build だけの記録に `checkpoints` で宣言する。
// 段の入力の照合は、前の走りの記録として段の走りの記録が無ければ、checkpoint を 1 つ以上宣言した Build だけの記録を読む
// （Issue #636）。`v1`・`v1.1a`・ids off の v1.2 の走りは何も足さない。
//
// `node:fs` は**動的**に読む（Worker が根（index.ts）から import しても、この経路は呼ばれない限り動かない。
// appspec-schema の contract.ts と同じやり方）。
import { planDigest, type ConfirmedPlan } from "@musunest/appspec-schema";
import type { TokenRates } from "./budget.js";
import { bundleFiles } from "./bundle.js";
import {
  buildBuildCliRecord,
  buildPlanCliRecord,
  buildPlanOnlyResult,
  buildSurfaceCheckDiagnostic,
  createAnswersFilePlanResponder,
  createInteractivePlanResponder,
  createPlanTranscript,
  parsePlanAnswers,
  parsePlanFile,
  PLAN_CLI_RECORD_FILE,
  PLAN_ONLY_RESULT_FILE,
  PLAN_SURFACE_CHECK_FILE,
  planBuildCostLine,
  planFileErrorLine,
  planFileRejectLine,
  planStopReasonLine,
  sha256Hex,
  validatePlanFile,
  BUILD_CLI_RECORD_FILE,
  type PlanCliConditions,
  type PlanTranscript,
  type Terminal,
} from "./cli-plan.js";
import { createFallbackJudge, type Judge } from "./judge.js";
import { createJevJudge } from "./judge-jev.js";
import { createLlmJudge } from "./judge-llm.js";
import type { AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import { createOpenAiLlmClient, DEFAULT_OPENAI_MODEL } from "./openai.js";
import type { EnvelopeId } from "./schema-envelope.js";
import { runPlan, type PlanResponder, type PlanResult } from "./plan/run-plan.js";
import {
  createScriptPlanResponder,
  parsePlanScript,
  type PlanScriptRecordSink,
} from "./plan/script-responder.js";
import { runGeneration } from "./run.js";
import {
  boundaryBefore,
  buildStageCheckpoint,
  buildStageRunRecord,
  resolveStageRange,
  stageCheckpointFile,
  stageJsonText,
  stageOutputDigest,
  stagePassOf,
  stagesInRange,
  verifyStageInput,
  STAGE_BUDGET_SCOPE,
  STAGE_RUN_RECORD_FILE,
  STAGE_START_ALIASES_V12,
  type BoundaryMaterials,
  type StageBoundary,
  type StageCallLimits,
  type StageRange,
  type StageRunConditions,
  type StageVersions,
} from "./v11a/bundle-v11a.js";
import { runGenerationV11a, runStageRangeV11a, type GenerationResultV11a } from "./v11a/run.js";
import {
  fromPublicV12Flags,
  propertyLedgerSha256,
  toPublicV12Flags,
  V12_PIPELINE_FLAGS,
  type V12Flags,
  type V12PublicFlags,
} from "./v12/ledger.js";
import { V12_CALL_LIMITS } from "./v12/limits.js";
import type { PromptDocument } from "./stages/prompt.js";

/** 工場の識別（要約の `builder`。S-5） */
export const BUILDER = "musunest-factory" as const;
/** プロンプトの版（§3・S-5） */
export const PROMPT_VERSION = "v1" as const;
/** v1.1α の走りのプロンプトの版（要約と `build-record.json` の `conditions.prompt_version`。Issue #511） */
export const PROMPT_VERSION_V11A = "v1.1a" as const;
/** v1.2 の走りのプロンプトの版（要約と `build-record.json` の `conditions.prompt_version`。Issue #547） */
export const PROMPT_VERSION_V12 = "v1.2" as const;
/** `--pipeline` で選べる経路（既定 v1） */
export const PIPELINES = ["v1", "v1.1a", "v1.2"] as const;
/** 経路の型 */
export type Pipeline = (typeof PIPELINES)[number];
/** 契約の版（`03-evaluation.md` §1 が v0.2 に固定する） */
export const CONTRACT_VERSION = "v0.2" as const;
/** P3 が照らす語彙の版（確定した仕様の `vocabulary_version`。04 §4・Issue #336） */
export const VOCABULARY_VERSION = "v1" as const;
/** spec-engine の版（§4。改名は U-B） */
export const SPEC_ENGINE_VERSION = "0.0.0" as const;
/** factory の版（§4。改名は U-B） */
export const FACTORY_VERSION = "0.0.0" as const;

/** 既定の effort（§2「品質優先で high から始める」） */
export const DEFAULT_EFFORT = "high" as const;
/** 既定の費用の上限（USD。C-1。2026-10-09 所有者の決定で 0.30 に広げた） */
export const DEFAULT_BUDGET_USD = 0.3 as const;
/** 既定の締切（ミリ秒。T-1。2026-10-09 所有者の決定で 10 分に広げた） */
export const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;
/** 鍵を読む環境変数の名前 */
export const API_KEY_ENV = "OPENAI_API_KEY" as const;
/** Jev の鍵を読む環境変数の名前。**鍵を読むのは手元の入口だけ**（adapter は環境変数を読まない。§4） */
export const JEV_API_KEY_ENV = "JEV_API_KEY" as const;

/**
 * 単価（USD / 1 トークン）。2026-10-09 の公開値（入力 $0.10・キャッシュの読み取り $0.01・
 * キャッシュの書き込み $0.125・出力 $0.50／100 万）。書き込みは入力の 1.25 倍である（§1.2・#342）。
 */
export const DEFAULT_RATES: TokenRates = {
  inputPerToken: 0.1 / 1_000_000,
  cachedInputPerToken: 0.01 / 1_000_000,
  cacheWritePerToken: 0.125 / 1_000_000,
  outputPerToken: 0.5 / 1_000_000,
};

/** 終了コード：成功（納品物を書いた） */
export const EXIT_OK = 0;
/** 終了コード：生成が失敗した（早期停止。納品物を書かなかった） */
export const EXIT_RUN_FAILED = 1;
/** 終了コード：使い方の誤り（鍵が無い・引数が足りない） */
export const EXIT_USAGE = 2;
/**
 * 終了コード：`--plan-file` の Build だけの道で、差し戻し（`returnToPlan`）が立った（Issue #495）。
 * **3 は `--plan-file` の差し戻しにだけ使う**——`--plan`（通し）の差し戻しは今までどおり 0 で終わる。
 */
export const EXIT_RETURN_TO_PLAN = 3;
/**
 * 終了コード：段の走りの再開の入力（`--stage-input`）の照合に失敗した（Issue #544）。API を呼ばず、何も書かない。
 * `--plan-file` の差し戻し（3）とは別の値である。
 */
export const EXIT_STAGE_INPUT = 4;

/** 使い方の文（誤りを人に見せる） */
export const USAGE =
  "使い方: factory:run -- <依頼文のファイル> --out <ディレクトリ> [--model <名前>] [--effort <値>] [--budget <USD>] [--deadline <分>] [--timeout <分>] [--plan [--answers <ファイル> | --script <ファイル>] | --plan-only [--answers <ファイル> | --script <ファイル>] | --plan-file <ファイル> [--pipeline v1|v1.1a|v1.2]]";

/** 段単位の実行口の使い方（段の旗の誤りのときだけ、`USAGE` のあとに出す。Issue #544） */
export const STAGE_USAGE =
  "段の走り: factory:run -- <依頼文のファイル> --out <ディレクトリ> --pipeline v1.1a|v1.2 --plan-file <ファイル> [--stage-start name-table|test-spec|write（v1.2 は vocabulary も。name-table の別名）] [--stage-end semantic-check|test-spec|judge] [--stage-input <前の段の走りの checkpoint>]";

/** 手元の入口が受け取る引数 */
export interface CliArguments {
  readonly requestFile: string;
  readonly outDir: string;
  readonly model: string;
  readonly effort: string;
  /** 費用の上限（USD）。指定しなければ既定（`DEFAULT_BUDGET_USD`）を使う */
  readonly budgetUsd?: number;
  /** 締切（ミリ秒）。指定しなければ既定（`DEFAULT_DEADLINE_MS`）を使う */
  readonly deadlineMs?: number;
  /**
   * 呼び出し 1 回ごとの timeout（ミリ秒）。指定しなければ effort から出す（#302）。
   * 実際に使う値は締切の残りを超えない（共通の口が頭を打つ）。
   */
  readonly timeoutMs?: number;
  /** `--plan` を付けると、Plan を回してから Build を流す（04 §7・Issue #336） */
  readonly plan?: boolean;
  /**
   * `--plan-only` を付けると、Plan だけを回し、確定した仕様とその SHA-256・原文の SHA-256・条件を
   * `plan-result.json` に書いて止まる（Build は流さない。Issue #495）。`--plan` とは同時に指定できない。
   */
  readonly planOnly?: boolean;
  /**
   * `--plan-file <ファイル>` を付けると、`plan-result.json` の包みを検査し、確定した仕様を正本にして
   * Build だけを流す（Plan は流さない。Issue #495）。`--plan`・`--plan-only` とは同時に指定できない。
   */
  readonly planFile?: string;
  /** 答えのファイル（`--answers <ファイル>`。付けると対話の代わりにファイルから答える。評価用） */
  readonly answersFile?: string;
  /**
   * 台本のファイル（`--script <ファイル>`。付けると対話や答えのファイルの代わりに、点検済みの事項で
   * 答える台本で答える。評価用。Issue #444）。`--answers` とは同時に指定できない。
   */
  readonly scriptFile?: string;
  /**
   * `--pipeline <v1|v1.1a|v1.2>`（既定 v1。指定したときだけ持つ）。値によらず `--plan`・`--plan-only` とは同時に
   * 指定できない。`v1.1a`・`v1.2` は `--plan-file` と一緒にだけ受ける（Issue #511・#547）。
   */
  readonly pipeline?: Pipeline;
  /**
   * 段の範囲（`--stage-start`・`--stage-end`・`--stage-input` のどれかを付けたときだけ持つ。Issue #544）。
   * `--pipeline v1.1a --plan-file` か `--pipeline v1.2 --plan-file` と組んでだけ受ける（v1.2 は Issue #637）。片方だけなら他方は
   * 経路の端。開始の別名（v1.2 の `vocabulary`）は正本の名前（`name-table`）に正規化して持つ
   */
  readonly stageRange?: StageRange;
  /** 再開の入力（前の段の走りが書いた、開始の段の直前の境界の checkpoint のファイル） */
  readonly stageInput?: string;
}

function isPipeline(value: string): value is Pipeline {
  return (PIPELINES as readonly string[]).includes(value);
}

/** v1.1α の経路で流す経路か（`v1.1a` と `v1.2`。確定した仕様と組んでだけ流れる） */
function isV11aPath(pipeline: Pipeline | undefined): pipeline is "v1.1a" | "v1.2" {
  return pipeline === "v1.1a" || pipeline === "v1.2";
}

/**
 * 経路の封筒の識別子（v1 は欄を置かないので `undefined`。Issue #588）。v1.2 は実効の旗で選ぶ：旗 ids が on なら C2 の枝を検査の
 * 種類ごとの欄にした `v1.2-ids`、off なら今の `v1.2`（Issue #682）
 */
function envelopeIdOf(pipeline: Pipeline | undefined): EnvelopeId | undefined {
  const flags = v12FlagsOf(pipeline);
  if (flags !== undefined) return fromPublicV12Flags(flags).ids ? "v1.2-ids" : "v1.2";
  return pipeline === "v1.1a" ? "v1.1a" : undefined;
}

/** 経路のプロンプトの版 */
function promptVersionOf(pipeline: Pipeline | undefined): string {
  return pipeline === "v1.2" ? PROMPT_VERSION_V12 : pipeline === "v1.1a" ? PROMPT_VERSION_V11A : PROMPT_VERSION;
}

/** 経路の旗の公開の組（`v1.2` だけが持つ。正本 `V12_PIPELINE_FLAGS` をそのまま使う。Issue #547・#551） */
function v12FlagsOf(pipeline: Pipeline | undefined): Readonly<V12PublicFlags> | undefined {
  return pipeline === "v1.2" ? V12_PIPELINE_FLAGS : undefined;
}

/** 呼び出しの上限の組（条件の記録の `v12_call_limits`・checkpoint の版の `call_limits` の形。旗 ids の走りでだけ効く。Issue #616・#637） */
function v12CallLimitsRecord(): StageCallLimits {
  return {
    logical_calls: V12_CALL_LIMITS.logicalCalls,
    real_attempts: V12_CALL_LIMITS.realAttempts,
    judge_branch: V12_CALL_LIMITS.judgeBranch,
  };
}

/** 引数を読む。誤りは `error` に人の読む文を入れて返す（例外にしない） */
export function parseCliArguments(argv: readonly string[]): CliArguments | { readonly error: string } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let requestFile: string | undefined;
  let outDir: string | undefined;
  let model: string = DEFAULT_OPENAI_MODEL;
  let effort: string = DEFAULT_EFFORT;
  let budgetUsd: number | undefined;
  let deadlineMs: number | undefined;
  let timeoutMs: number | undefined;
  let plan = false;
  let planOnly = false;
  let planFile: string | undefined;
  let answersFile: string | undefined;
  let scriptFile: string | undefined;
  let pipeline: Pipeline | undefined;
  let stageStart: string | undefined;
  let stageEnd: string | undefined;
  let stageInput: string | undefined;
  let stageFlag = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--plan") {
      plan = true;
      continue;
    }
    if (arg === "--plan-only") {
      planOnly = true;
      continue;
    }
    if (arg === "--plan-file") {
      const raw = args[index + 1];
      index += 1;
      if (raw === undefined) return { error: "--plan-file には出力ファイルを指定してください" };
      planFile = raw;
      continue;
    }
    if (arg === "--pipeline") {
      const raw = args[index + 1];
      index += 1;
      if (raw === undefined || !isPipeline(raw)) {
        return { error: `--pipeline には ${PIPELINES.join(" か ")} を指定してください` };
      }
      pipeline = raw;
      continue;
    }
    if (arg === "--stage-start" || arg === "--stage-end" || arg === "--stage-input") {
      const raw = args[index + 1];
      index += 1;
      stageFlag = true;
      if (raw === undefined) {
        return { error: arg === "--stage-input" ? "stage-input:missing（--stage-input には checkpoint のファイルを指定してください）" : "stage-range:unknown（段の名前を指定してください）" };
      }
      if (arg === "--stage-start") stageStart = raw;
      else if (arg === "--stage-end") stageEnd = raw;
      else stageInput = raw;
      continue;
    }
    if (arg === "--answers") {
      const raw = args[index + 1];
      index += 1;
      if (raw === undefined) return { error: "--answers には答えのファイルを指定してください" };
      answersFile = raw;
      continue;
    }
    if (arg === "--script") {
      const raw = args[index + 1];
      index += 1;
      if (raw === undefined) return { error: "--script には台本のファイルを指定してください" };
      scriptFile = raw;
      continue;
    }
    if (arg === "--out") {
      outDir = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = args[index + 1] ?? model;
      index += 1;
      continue;
    }
    if (arg === "--effort") {
      effort = args[index + 1] ?? effort;
      index += 1;
      continue;
    }
    if (arg === "--budget") {
      const raw = args[index + 1];
      index += 1;
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        return { error: "--budget には 0 より大きい数（USD）を指定してください" };
      }
      budgetUsd = value;
      continue;
    }
    if (arg === "--deadline") {
      const raw = args[index + 1];
      index += 1;
      const minutes = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { error: "--deadline には 0 より大きい数（分）を指定してください" };
      }
      deadlineMs = minutes * 60_000;
      continue;
    }
    if (arg === "--timeout") {
      const raw = args[index + 1];
      index += 1;
      const minutes = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { error: "--timeout には 0 より大きい数（分）を指定してください" };
      }
      timeoutMs = minutes * 60_000;
      continue;
    }
    if (arg.startsWith("--")) return { error: `知らない選択肢: ${arg}` };
    if (requestFile === undefined) {
      requestFile = arg;
      continue;
    }
    return { error: `余分な引数: ${arg}` };
  }
  if (requestFile === undefined) return { error: "依頼文のファイルを指定してください" };
  if (outDir === undefined) return { error: "--out で出力のディレクトリを指定してください" };
  if (plan && planOnly) {
    return { error: "--plan と --plan-only は同時に指定できません" };
  }
  if (planOnly && planFile !== undefined) {
    return { error: "--plan-only と --plan-file は同時に指定できません" };
  }
  if (plan && planFile !== undefined) {
    return { error: "--plan と --plan-file は同時に指定できません" };
  }
  if (planFile !== undefined && answersFile !== undefined) {
    return { error: "--plan-file と --answers は同時に指定できません" };
  }
  if (planFile !== undefined && scriptFile !== undefined) {
    return { error: "--plan-file と --script は同時に指定できません" };
  }
  if (answersFile !== undefined && !plan && !planOnly) {
    return { error: "--answers は --plan と一緒に指定してください" };
  }
  if (scriptFile !== undefined && !plan && !planOnly) {
    return { error: "--script は --plan と一緒に指定してください" };
  }
  if (scriptFile !== undefined && answersFile !== undefined) {
    return { error: "--script と --answers は同時に指定できません" };
  }
  if (pipeline !== undefined && plan) {
    return { error: "--pipeline と --plan は同時に指定できません" };
  }
  if (pipeline !== undefined && planOnly) {
    return { error: "--pipeline と --plan-only は同時に指定できません" };
  }
  if (pipeline === "v1.1a" && planFile === undefined) {
    return { error: "--pipeline v1.1a は --plan-file と一緒に指定してください" };
  }
  if (pipeline === "v1.2" && planFile === undefined) {
    return { error: "--pipeline v1.2 は --plan-file と一緒に指定してください" };
  }
  let stageRange: StageRange | undefined;
  if (stageFlag) {
    if (!isV11aPath(pipeline) || planFile === undefined) {
      return { error: `stage-range:pipeline（${STAGE_RANGE_USAGE_MESSAGES["stage-range:pipeline"]}）` };
    }
    // v1.2 だけ、開始の別名（区間 0 の `vocabulary`）を区間の正本の名前に正規化する（v1.1a は今までどおり別名を受けない。Issue #637）
    const start = pipeline === "v1.2" && stageStart !== undefined ? (STAGE_START_ALIASES_V12[stageStart] ?? stageStart) : stageStart;
    const resolved = resolveStageRange({
      ...(start === undefined ? {} : { start }),
      ...(stageEnd === undefined ? {} : { end: stageEnd }),
      hasInput: stageInput !== undefined,
    });
    if ("code" in resolved) return { error: `${resolved.code}（${STAGE_RANGE_USAGE_MESSAGES[resolved.code]}）` };
    stageRange = resolved;
  }
  return {
    requestFile,
    outDir,
    model,
    effort,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(plan ? { plan: true } : {}),
    ...(planOnly ? { planOnly: true } : {}),
    ...(planFile === undefined ? {} : { planFile }),
    ...(answersFile === undefined ? {} : { answersFile }),
    ...(scriptFile === undefined ? {} : { scriptFile }),
    ...(pipeline === undefined ? {} : { pipeline }),
    ...(stageRange === undefined ? {} : { stageRange }),
    ...(stageInput === undefined ? {} : { stageInput }),
  };
}

/** 段の旗の使い方の誤りの説明（符号のあとに添える） */
const STAGE_RANGE_USAGE_MESSAGES = {
  "stage-range:pipeline": "段の旗は --pipeline v1.1a か v1.2 と --plan-file と一緒に指定してください",
  "stage-range:order": "開始の段が終了の段より後です",
  "stage-range:unknown":
    "開始は name-table・test-spec・write（v1.2 は name-table の別名 vocabulary も）、終了は semantic-check・test-spec・judge から選んでください",
  "stage-input:not-needed": "開始 name-table には --stage-input を付けられません",
  "stage-input:missing": "開始 test-spec・write には --stage-input（前の段の走りの checkpoint）が要ります",
} as const;

/** 手元の入口の依存（試験は偽物を差し込む） */
export interface CliDeps {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly loadDocuments: () => Promise<readonly PromptDocument[]>;
  /**
   * LLM の adapter を作る。`envelope` は v1.1α の走り（段の走りを含む）で `"v1.1a"`、v1.2 の走りで `"v1.2"` が渡る
   * （Issue #511・#588）——v1 の走りでは欄を置かない（v1 の要求のバイト列を変えない）。
   */
  readonly makeClient: (options: { apiKey: string; model: string; effort: string; envelope?: EnvelopeId }) => LlmClient;
  /**
   * Jev の判定の adapter を作る（05 §4）。**鍵を読むのは手元の入口だけ**——`JEV_API_KEY` を環境変数
   * から読んで渡す（adapter は環境変数を読まない）。試験は偽物を差し込む（実 API を呼ばない）。
   */
  readonly makeJevJudge?: (options: { apiKey: string }) => Judge;
  /** LLM の判定の adapter を作る（05 §4）。試験は偽物を差し込む。既定は本物（`judge-llm.ts`） */
  readonly makeLlmJudge?: (options: { client: LlmClient; model: string }) => Judge;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** 標準エラーに 1 行出す（判定を落としたときの注意。既定は何もしない） */
  readonly logError?: (line: string) => void;
  readonly rates?: TokenRates;
  readonly budgetUsd?: number;
  readonly deadlineMs?: number;
  readonly limits?: AgentLimits;
  /**
   * 対話の端末（`--plan` を `--answers` 無しで使うときに要る。04 §7）。本物は `main` が用意し、
   * 試験は偽物を差し込む（本物の端末を触らない）。
   */
  readonly terminal?: Terminal;
}

/** 出力のパスを組む（納品物の相対パスは `/` 区切り） */
function joinPath(directory: string, path: string): string {
  return directory.endsWith("/") ? `${directory}${path}` : `${directory}/${path}`;
}

/** 相対パスの親ディレクトリ（`artifacts/app.spec.yaml` → `artifacts`。直下なら空文字） */
function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/**
 * 判定の口を組み立てる（05 §4・Issue #355）。`JEV_API_KEY` があれば **Jev を主・LLM を落とし先**にした
 * 組み合わせ、無ければ LLM だけを使う（その旨を標準エラーに 1 行出す）。**鍵を読むのはここだけ**——adapter
 * （Jev・LLM）は環境変数を読まない。Plan にも Build にも**同じ判定の口**を渡す（Issue #336）。
 *
 * 併せて、**再点検専用の Luna の口**（LLM）を返す（Issue #432）——P3 の未確定の申告の再点検を、主（Jev）
 * ではなく Luna の別の会話へ明示的に回すため、呼ぶ側（Plan）へ渡す。Build には使わない。
 */
export interface AssembleJudgeInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly model: string;
  readonly client: LlmClient;
  readonly makeJevJudge?: (options: { apiKey: string }) => Judge;
  readonly makeLlmJudge?: (options: { client: LlmClient; model: string }) => Judge;
  readonly logError: (line: string) => void;
}

export function assembleJudge(
  input: AssembleJudgeInput,
): { readonly judge: Judge; readonly recheckJudge: Judge } {
  const llmJudge = (input.makeLlmJudge ?? createLlmJudge)({ client: input.client, model: input.model });
  const jevApiKey = input.env[JEV_API_KEY_ENV];
  if (jevApiKey !== undefined && jevApiKey !== "") {
    const judge = createFallbackJudge({
      primary: (input.makeJevJudge ?? createJevJudge)({ apiKey: jevApiKey }),
      fallback: llmJudge,
    });
    return { judge, recheckJudge: llmJudge };
  }
  input.logError(`環境変数 ${JEV_API_KEY_ENV} が無いので、判定は LLM（${input.model}）だけを使います`);
  return { judge: llmJudge, recheckJudge: llmJudge };
}

/** 生成の入力のうち、Plan の有無で変わらない部分（`--out` のディレクトリ・締切・上限） */
interface BuildJob {
  readonly source: string;
  readonly documents: readonly PromptDocument[];
  readonly client: LlmClient;
  readonly judge: Judge;
  /** 再点検専用の Luna の口（Plan だけが使う。Issue #432） */
  readonly recheckJudge: Judge;
  readonly outDir: string;
  readonly model: string;
  readonly effort: string;
  readonly budgetUsd: number;
  readonly deadline: number;
  readonly now: () => number;
  readonly timeoutMs?: number;
  /** 経路（省けば v1。v1.1α は確定した仕様と組んでだけ流れる。Issue #511） */
  readonly pipeline?: Pipeline;
}

/**
 * 1 回の生成を流し、納品物をディレクトリに書く（§3.2）。要約は 1 行の JSON で出す。
 * 返すのは、終了コードと**生成が使った額（USD）**（Plan と合わせて最後に 1 行出すため。Issue #336）。
 */
async function runBuild(
  deps: CliDeps,
  job: BuildJob & { readonly plan?: ConfirmedPlan },
  log: (line: string) => void,
): Promise<{
  readonly code: number;
  readonly costUsd: number;
  readonly returnToPlan: boolean;
  /** 通った境界の材料（`--pipeline v1.2` の走りだけ。Issue #636） */
  readonly boundaries?: readonly BoundaryMaterials[];
  /** 境界の材料を集めた走りの実効の旗（checkpoint の版の `flags`・`call_limits`。Issue #637） */
  readonly flags?: V12Flags;
}> {
  // v1.1α は確定した仕様と組んでだけ流れる（引数の読み取りが `--plan-file` を要る。Issue #511）。v1.2 は同じ経路に
  // 旗の組を渡し、要約に旗の組を書かせる（Issue #547）。旗 v12.ids が on の走りだけ、境界の材料も集めさせる（checkpoint を書く
  // ため。ids off の走りは集めず、直す前とバイト列で同じ。Issue #636）
  const v11aPlan = isV11aPath(job.pipeline) ? job.plan : undefined;
  const input = generationInputOf(deps, job, v11aPlan === undefined ? PROMPT_VERSION : promptVersionOf(job.pipeline));
  const publicFlags = v12FlagsOf(job.pipeline);
  const flags = publicFlags === undefined ? undefined : fromPublicV12Flags(publicFlags);
  const run: GenerationResultV11a =
    v11aPlan === undefined
      ? await runGeneration({ ...input, ...(job.plan === undefined ? {} : { plan: job.plan }) })
      : await runGenerationV11a({
          ...input,
          plan: v11aPlan,
          ...(flags === undefined ? {} : { flags, recordV12Flags: true, ...(flags.ids ? { collectBoundaries: true } : {}) }),
        });
  const written = await writeBuildRun(deps, job, run, log);
  return run.boundaries === undefined || flags === undefined ? written : { ...written, boundaries: run.boundaries, flags };
}

/** 生成の入力のうち、経路に依らない部分（v1・v1.1α・段の走りで同じ） */
function generationInputOf(deps: CliDeps, job: BuildJob, promptVersion: string) {
  return {
    source: job.source,
    documents: job.documents,
    client: job.client,
    budgetUsd: job.budgetUsd,
    rates: deps.rates ?? DEFAULT_RATES,
    now: job.now,
    deadline: job.deadline,
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(job.timeoutMs === undefined ? {} : { callTimeoutMs: job.timeoutMs }),
    judge: job.judge,
    runId: `local-${String(job.now())}`,
    storageUnit: job.outDir,
    builder: BUILDER,
    model: job.model,
    effort: job.effort,
    promptVersion,
    contractVersion: CONTRACT_VERSION,
    specEngineVersion: SPEC_ENGINE_VERSION,
    factoryVersion: FACTORY_VERSION,
  };
}

/** 生成の結果（納品物・診断・要約）を書き、終了コードと使った額を返す */
async function writeBuildRun(
  deps: CliDeps,
  job: BuildJob,
  run: Awaited<ReturnType<typeof runGeneration>>,
  log: (line: string) => void,
): Promise<{ readonly code: number; readonly costUsd: number; readonly returnToPlan: boolean }> {
  if (run.bundle !== null) {
    await deps.makeDirectory(job.outDir);
    for (const file of bundleFiles(run.bundle)) {
      const parent = parentOf(file.path);
      if (parent !== "") await deps.makeDirectory(joinPath(job.outDir, parent));
      await deps.writeFile(joinPath(job.outDir, file.path), file.text);
    }
  }
  // 診断が空でなければ、出力のディレクトリの下の**診断の置き場所**に書く（Issue #417）。完走でも、②・②' が
  // 断った候補のファイルだけは書く（Issue #501。完走の診断は候補のファイルだけである）。**診断は納品物の
  // 成果物と manifest に入れない**し、**診断の有無を終了コードの条件に加えない**。
  if (run.diagnostics.length > 0) {
    await deps.makeDirectory(job.outDir);
    for (const file of run.diagnostics) {
      const parent = parentOf(file.path);
      if (parent !== "") await deps.makeDirectory(joinPath(job.outDir, parent));
      await deps.writeFile(joinPath(job.outDir, file.path), file.text);
    }
  }
  log(JSON.stringify(run.summary));
  return {
    code: run.bundle === null ? EXIT_RUN_FAILED : EXIT_OK,
    costUsd: run.summary.provider_cost_usd ?? 0,
    returnToPlan: run.returnToPlan === true,
  };
}

/**
 * `--plan`・`--plan-only` が共有する、答える役の用意（04 §7・Issue #495）。`--script`・`--answers`・端末の
 * どれも同じに選べる。用意に失敗（使い方の誤り）なら `null` を返す（呼ぶ側が 2 で終わる）。
 */
async function createPlanResponder(
  deps: CliDeps,
  parsed: CliArguments,
  transcript: PlanTranscript,
  log: (line: string) => void,
): Promise<{ readonly responder: PlanResponder; readonly scriptSha256?: string } | null> {
  if (parsed.scriptFile !== undefined) {
    const scriptText = await deps.readFile(parsed.scriptFile);
    const script = parsePlanScript(scriptText);
    if ("error" in script) {
      log(`使い方の誤り: ${script.error}`);
      return null;
    }
    const scriptSha256 = await sha256Hex(scriptText);
    // 照合の結果・往復・確認の答えを、往復の記録へ写す口（値ではなく、コードが振った ID・版・状態・
    // 添字と、提示した問い・返した答えだけ）
    const sink: PlanScriptRecordSink = {
      match: (match) => {
        transcript.scriptMatches.push(match);
      },
      round: (round) => {
        transcript.rounds.push(round);
      },
      confirmation: (decision) => {
        transcript.confirmation = decision;
      },
    };
    return { responder: createScriptPlanResponder(script, sink), scriptSha256 };
  }
  if (parsed.answersFile !== undefined) {
    const answersText = await deps.readFile(parsed.answersFile);
    const answers = parsePlanAnswers(answersText);
    if ("error" in answers) {
      log(`使い方の誤り: ${answers.error}`);
      return null;
    }
    return { responder: createAnswersFilePlanResponder(answers, transcript, log) };
  }
  const terminal = deps.terminal;
  if (terminal === undefined) {
    log(
      `使い方の誤り: --plan の対話には端末が要ります（--answers <ファイル> か --script <ファイル> でも渡せます）`,
    );
    return null;
  }
  return { responder: createInteractivePlanResponder(terminal, transcript) };
}

/** Plan の往復の記録と、点検の診断を `--out` に置く（納品物には入れない。§7・Issue #432） */
async function writePlanRecords(
  deps: CliDeps,
  outDir: string,
  input: {
    readonly result: PlanResult;
    readonly transcript: PlanTranscript;
    readonly budgetUsd: number;
    readonly planId: string;
    readonly scriptSha256?: string;
  },
): Promise<void> {
  await deps.makeDirectory(outDir);
  await deps.writeFile(
    joinPath(outDir, PLAN_CLI_RECORD_FILE),
    JSON.stringify(
      buildPlanCliRecord({
        result: input.result,
        transcript: input.transcript,
        budgetUsd: input.budgetUsd,
        planId: input.planId,
        ...(input.scriptSha256 === undefined ? {} : { script: { sha256: input.scriptSha256 } }),
      }),
    ),
  );
  // P3 の申告 1 件ずつの診断を、**別のファイル**に置く（受理・落とした・途中停止のどれも。Issue #432）。
  // `plan-record.json` は今の要約のままにする。
  await deps.writeFile(
    joinPath(outDir, PLAN_SURFACE_CHECK_FILE),
    JSON.stringify(buildSurfaceCheckDiagnostic({ result: input.result, planId: input.planId })),
  );
}

/** Plan を 1 回流し、往復の記録と点検の診断を書く（`--plan`・`--plan-only` が共有する。Issue #495） */
async function runPlanOnce(
  deps: CliDeps,
  parsed: CliArguments,
  job: BuildJob,
  log: (line: string) => void,
): Promise<{ readonly result: PlanResult; readonly planId: string } | null> {
  const transcript = createPlanTranscript();
  const setup = await createPlanResponder(deps, parsed, transcript, log);
  if (setup === null) return null;
  const planId = `local-plan-${String(job.now())}`;
  const result = await runPlan({
    source: job.source,
    documents: job.documents,
    client: job.client,
    judge: job.judge,
    recheckJudge: job.recheckJudge,
    responder: setup.responder,
    budgetUsd: job.budgetUsd,
    rates: deps.rates ?? DEFAULT_RATES,
    now: job.now,
    deadline: job.deadline,
    effort: job.effort,
    planId,
    vocabularyVersion: VOCABULARY_VERSION,
    confirmedBy: "local",
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(job.timeoutMs === undefined ? {} : { callTimeoutMs: job.timeoutMs }),
  });
  await writePlanRecords(deps, job.outDir, {
    result,
    transcript,
    budgetUsd: job.budgetUsd,
    planId,
    ...(setup.scriptSha256 === undefined ? {} : { scriptSha256: setup.scriptSha256 }),
  });
  return { result, planId };
}

/**
 * `--plan` の道（Issue #336）。Plan を 1 回流し、確定した仕様を Build に渡す。**予算は Plan と Build で
 * 1 つ**——Build には、全体の予算から Plan で使った額を引いた残りを渡す（§8）。確定できなければ Build を
 * 流さず、理由を 1 行出して 0 でない終了コードで終わる。往復の記録は `--out` に置く（納品物には入れない）。
 */
async function runPlanThenBuild(
  deps: CliDeps,
  parsed: CliArguments,
  job: BuildJob,
  log: (line: string) => void,
): Promise<number> {
  const planned = await runPlanOnce(deps, parsed, job, log);
  if (planned === null) return EXIT_USAGE;
  const { result } = planned;

  if (result.kind !== "confirmed") {
    log(planStopReasonLine(result));
    log(planBuildCostLine(result.spentUsd, 0));
    return EXIT_RUN_FAILED;
  }
  if (result.remainingUsd <= 0) {
    log("Plan で予算を使い切ったので、Build を流しません");
    log(planBuildCostLine(result.spentUsd, 0));
    return EXIT_RUN_FAILED;
  }

  // 確定した仕様を Build の正本にし、残りの予算を渡す（§5・§8）
  const build = await runBuild(deps, { ...job, budgetUsd: result.remainingUsd, plan: result.plan }, log);
  log(planBuildCostLine(result.spentUsd, build.costUsd));
  return build.code;
}

/**
 * `--plan-only` の道（Issue #495）。Plan を 1 回流し、確定した仕様とその SHA-256・原文の SHA-256・条件を
 * `plan-result.json` に書く。**Build は流さない**（`runGeneration` を呼ばない）。終了コードは、確定したら 0、
 * 確定しなければ 1（`runPlan` が停止を返した本を確定に変えない。Plan で予算を使い切って確定した本も 0）。
 */
async function runPlanOnly(
  deps: CliDeps,
  parsed: CliArguments,
  job: BuildJob,
  conditions: PlanCliConditions,
  log: (line: string) => void,
): Promise<number> {
  const planned = await runPlanOnce(deps, parsed, job, log);
  if (planned === null) return EXIT_USAGE;
  const { result } = planned;

  const plan = result.kind === "confirmed" ? result.plan : null;
  const planSha256 = plan === null ? null : await planDigest(plan);
  const sourceSha256 = await sha256Hex(job.source);
  await deps.makeDirectory(job.outDir);
  await deps.writeFile(
    joinPath(job.outDir, PLAN_ONLY_RESULT_FILE),
    JSON.stringify(buildPlanOnlyResult({ result, planSha256, sourceSha256, conditions })),
  );

  if (result.kind !== "confirmed") {
    log(planStopReasonLine(result));
    log(planBuildCostLine(result.spentUsd, 0));
    return EXIT_RUN_FAILED;
  }
  log(planBuildCostLine(result.spentUsd, 0));
  return EXIT_OK;
}

/**
 * `--plan-file` の道（Issue #495）。包みを検査し（**client を作る前に**）、通ったときだけ、確定した仕様を
 * 正本にして Build だけを流す（`runPlan` は呼ばない）。予算は `--budget` の全額、締切は `--deadline` から
 * 求める（Plan に使った額も時間も引かない）。差し戻しが立ったら、Build だけの記録の欄を真にし、終了コード 3
 * で終わる（生成の要約と納品物は従来どおり書く）。
 */
async function runBuildFromPlanFile(
  deps: CliDeps,
  parsed: CliArguments,
  planFilePath: string,
  ctx: {
    readonly now: () => number;
    readonly budgetUsd: number;
    readonly deadlineMs: number;
    readonly conditions: PlanCliConditions;
  },
  log: (line: string) => void,
  logError: (line: string) => void,
): Promise<number> {
  const source = await deps.readFile(parsed.requestFile);
  let text: string;
  try {
    text = await deps.readFile(planFilePath);
  } catch {
    log(planFileErrorLine("plan-file-read"));
    return EXIT_USAGE;
  }
  const file = parsePlanFile(text);
  if ("code" in file) {
    log(planFileErrorLine(file.code));
    return EXIT_USAGE;
  }
  const validation = await validatePlanFile({
    envelope: file.envelope,
    source,
    vocabularyVersion: VOCABULARY_VERSION,
  });
  if (validation.kind === "rejected") {
    log(planFileRejectLine(validation));
    return EXIT_USAGE;
  }
  if (parsed.stageRange !== undefined) {
    return runStageFromPlanFile(deps, parsed, parsed.stageRange, { ...ctx, source, validation }, log, logError);
  }

  const apiKey = deps.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    log(`使い方の誤り: 環境変数 ${API_KEY_ENV} がありません`);
    log(USAGE);
    return EXIT_USAGE;
  }
  const documents = await deps.loadDocuments();
  // v1.1α の走りは v1.1α の封筒、v1.2 の走りは v1.2 の封筒を選ぶ（v1 の走りでは欄を置かない。Issue #511・#588）
  const envelope = envelopeIdOf(parsed.pipeline);
  const client = deps.makeClient({
    apiKey,
    model: parsed.model,
    effort: parsed.effort,
    ...(envelope === undefined ? {} : { envelope }),
  });
  const { judge, recheckJudge } = assembleJudge({
    env: deps.env,
    model: parsed.model,
    client,
    ...(deps.makeJevJudge === undefined ? {} : { makeJevJudge: deps.makeJevJudge }),
    ...(deps.makeLlmJudge === undefined ? {} : { makeLlmJudge: deps.makeLlmJudge }),
    logError,
  });
  const job: BuildJob = {
    source,
    documents,
    client,
    judge,
    recheckJudge,
    outDir: parsed.outDir,
    model: parsed.model,
    effort: parsed.effort,
    budgetUsd: ctx.budgetUsd,
    deadline: ctx.now() + ctx.deadlineMs,
    now: ctx.now,
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    ...(parsed.pipeline === undefined ? {} : { pipeline: parsed.pipeline }),
  };
  const build = await runBuild(deps, { ...job, plan: validation.plan }, log);
  await deps.makeDirectory(job.outDir);
  // `--pipeline v1.2` の走りだけ、通った境界の checkpoint を段の走りと同じ関数・同じ名前で `--out` の直下に書き、Build だけの
  // 記録に宣言する（納品物の manifest には載せない。ほかの経路は何も足さない。Issue #636）
  const checkpoints =
    build.boundaries === undefined
      ? undefined
      : await writeStageCheckpoints(deps, job.outDir, build.boundaries, {
          versions: await stageVersionsOf(promptVersionOf(job.pipeline), build.flags),
          planSha256: validation.planSha256,
          sourceSha256: validation.sourceSha256,
        });
  await deps.writeFile(
    joinPath(job.outDir, BUILD_CLI_RECORD_FILE),
    JSON.stringify(
      buildBuildCliRecord({
        conditions: ctx.conditions,
        planSha256: validation.planSha256,
        sourceSha256: validation.sourceSha256,
        returnToPlan: build.returnToPlan,
        ...(checkpoints === undefined ? {} : { checkpoints }),
      }),
    ),
  );
  return build.returnToPlan ? EXIT_RETURN_TO_PLAN : build.code;
}

/** パスの親ディレクトリ（`/` の無いパスは `.`） */
function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : index === 0 ? "/" : path.slice(0, index);
}

/** パスの最後の名前 */
function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * checkpoint に残す版（語彙・契約・prompt・工場。段の走りと `--pipeline v1.2` の走りで同じ形。Issue #636）。v1.2 の走り（実効の旗を
 * 渡す）だけ、台帳の指紋・実効の旗の組の公開の形・呼び出しの上限（旗 ids が off なら null）を足す（v1.1a は 4 欄のまま。Issue #637）
 */
async function stageVersionsOf(promptVersion: string, flags?: V12Flags): Promise<StageVersions> {
  const versions = { vocabulary: VOCABULARY_VERSION, contract: CONTRACT_VERSION, prompt: promptVersion, factory: FACTORY_VERSION };
  if (flags === undefined) return versions;
  return {
    ...versions,
    ledger: await propertyLedgerSha256(),
    flags: toPublicV12Flags(flags),
    call_limits: flags.ids ? v12CallLimitsRecord() : null,
  };
}

/**
 * 通った境界の材料から checkpoint を組み、境界ごとの名前で `outDir` の直下に書く（段の走りと `--pipeline v1.2` の走りが
 * 共有する。Issue #636）。返すのは記録の `checkpoints`（境界・ファイル名・出力ダイジェスト。通った順）
 */
async function writeStageCheckpoints(
  deps: CliDeps,
  outDir: string,
  boundaries: readonly BoundaryMaterials[],
  options: { readonly versions: StageVersions; readonly planSha256: string; readonly sourceSha256: string },
): Promise<{ boundary: StageBoundary; path: string; output_digest: string }[]> {
  const checkpoints: { boundary: StageBoundary; path: string; output_digest: string }[] = [];
  for (const materials of boundaries) {
    const checkpoint = buildStageCheckpoint({ materials, ...options });
    const path = stageCheckpointFile(materials.boundary);
    await deps.writeFile(joinPath(outDir, path), stageJsonText(checkpoint));
    checkpoints.push({ boundary: materials.boundary, path, output_digest: await stageOutputDigest(checkpoint) });
  }
  return checkpoints;
}

/**
 * 前の走りの記録を読む（段の走りの記録。無ければ、checkpoint を 1 つ以上宣言した Build だけの記録＝旗 v12.ids の走りが
 * checkpoint を書いた場所。Issue #636）。どちらでもなければ null（v1・v1.1a・ids off の v1.2・境界に届かなかった走りの場所は
 * 直す前と同じに読めない扱い）
 */
async function readPreviousRecord(deps: CliDeps, directory: string): Promise<string | null> {
  const stageRecord = await readOrNull(deps, joinPath(directory, STAGE_RUN_RECORD_FILE));
  if (stageRecord !== null) return stageRecord;
  const buildRecord = await readOrNull(deps, joinPath(directory, BUILD_CLI_RECORD_FILE));
  if (buildRecord === null) return null;
  try {
    const value: unknown = JSON.parse(buildRecord);
    const checkpoints = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["checkpoints"] : undefined;
    return Array.isArray(checkpoints) && checkpoints.length > 0 ? buildRecord : null;
  } catch {
    return null;
  }
}

/** 読めなければ null（段の入力の照合は、読めないことを固定の符号にする） */
async function readOrNull(deps: CliDeps, path: string): Promise<string | null> {
  try {
    return await deps.readFile(path);
  } catch {
    return null;
  }
}

/**
 * 段の走りの道（`--stage-start`・`--stage-end`・`--stage-input`。08 §8.3・Issue #544）。確定した仕様の検査を
 * 通ったあとに呼ぶ。再開の入力を**クライアントを作る前に**照合し、断れば固定の符号 1 行を標準エラーに出して
 * 終了コード 4 で終わる（API を呼ばない・何も書かない）。通れば範囲の段だけを流し、通った境界の checkpoint と
 * 段の走りの記録を `--out` に書く。**納品物は書かない**（⑦ まで流しても publish の口へ何も渡さない）。予算と
 * 締切は `--budget`・`--deadline` をこの走りの始まりから当てる（前の走りの額と時間を引かない）。
 *
 * 終了コード：段の通過 0、範囲の中の早期停止 1、確定した仕様の道の差し戻し 3、段の入力の照合の失敗 4。
 */
async function runStageFromPlanFile(
  deps: CliDeps,
  parsed: CliArguments,
  range: StageRange,
  ctx: {
    readonly now: () => number;
    readonly budgetUsd: number;
    readonly deadlineMs: number;
    readonly source: string;
    readonly validation: { readonly plan: ConfirmedPlan; readonly planSha256: string; readonly sourceSha256: string };
  },
  log: (line: string) => void,
  logError: (line: string) => void,
): Promise<number> {
  const { validation } = ctx;
  // v1.2 の段の走りは一気通貫と同じ旗の組・封筒・プロンプトの版で流す（v1.1a は旗を渡さない＝今のまま。Issue #637）
  const pipeline = parsed.pipeline === "v1.2" ? "v1.2" : "v1.1a";
  const publicFlags = v12FlagsOf(pipeline);
  const flags = publicFlags === undefined ? undefined : fromPublicV12Flags(publicFlags);
  const versions = await stageVersionsOf(promptVersionOf(pipeline), flags);
  let resume: Parameters<typeof runStageRangeV11a>[0]["resume"];
  let inputRecord: { readonly checkpoint: string; readonly boundary: StageBoundary; readonly output_digest: string } | null =
    null;
  if (boundaryBefore(range.start) !== null && parsed.stageInput !== undefined) {
    const checkpointPath = parsed.stageInput;
    const verified = await verifyStageInput({
      start: range.start,
      checkpointText: await readOrNull(deps, checkpointPath),
      checkpointFile: baseNameOf(checkpointPath),
      recordText: await readPreviousRecord(deps, directoryOf(checkpointPath)),
      plan: validation.plan,
      planSha256: validation.planSha256,
      sourceSha256: validation.sourceSha256,
      vocabularyVersion: VOCABULARY_VERSION,
      contractVersion: CONTRACT_VERSION,
      ...(versions.ledger === undefined || versions.flags === undefined
        ? {}
        : { v12: { ledger: versions.ledger, flags: versions.flags } }),
    });
    if (!verified.ok) {
      logError(verified.code);
      return EXIT_STAGE_INPUT;
    }
    resume = verified.resume;
    inputRecord = verified.input;
  }

  const apiKey = deps.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    log(`使い方の誤り: 環境変数 ${API_KEY_ENV} がありません`);
    log(USAGE);
    return EXIT_USAGE;
  }
  const documents = await deps.loadDocuments();
  const client = deps.makeClient({ apiKey, model: parsed.model, effort: parsed.effort, envelope: envelopeIdOf(pipeline) ?? "v1.1a" });
  const { judge, recheckJudge } = assembleJudge({
    env: deps.env,
    model: parsed.model,
    client,
    ...(deps.makeJevJudge === undefined ? {} : { makeJevJudge: deps.makeJevJudge }),
    ...(deps.makeLlmJudge === undefined ? {} : { makeLlmJudge: deps.makeLlmJudge }),
    logError,
  });
  const job: BuildJob = {
    source: ctx.source,
    documents,
    client,
    judge,
    recheckJudge,
    outDir: parsed.outDir,
    model: parsed.model,
    effort: parsed.effort,
    budgetUsd: ctx.budgetUsd,
    deadline: ctx.now() + ctx.deadlineMs,
    now: ctx.now,
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    pipeline,
  };
  const outcome = await runStageRangeV11a({
    ...generationInputOf(deps, job, promptVersionOf(pipeline)),
    plan: validation.plan,
    range,
    ...(resume === undefined ? {} : { resume }),
    ...(flags === undefined ? {} : { flags }),
  });

  await deps.makeDirectory(job.outDir);
  const checkpoints = await writeStageCheckpoints(deps, job.outDir, outcome.boundaries, {
    versions,
    planSha256: validation.planSha256,
    sourceSha256: validation.sourceSha256,
  });
  const code =
    outcome.stopped !== null
      ? EXIT_RUN_FAILED
      : outcome.returnToPlan
        ? EXIT_RETURN_TO_PLAN
        : stagePassOf(outcome, range.end)
          ? EXIT_OK
          : EXIT_RUN_FAILED;
  const jevApiKey = deps.env[JEV_API_KEY_ENV];
  const conditions: StageRunConditions = {
    model: parsed.model,
    effort: parsed.effort,
    documents: await Promise.all(
      documents.map(async (document) => ({ name: document.name, sha256: await sha256Hex(document.text) })),
    ),
    judge:
      jevApiKey !== undefined && jevApiKey !== "" ? { primary: "jev", fallback: "llm" } : { primary: "llm", fallback: null },
    prompt_version: promptVersionOf(pipeline),
    vocabulary_version: VOCABULARY_VERSION,
    contract_version: CONTRACT_VERSION,
    factory_version: FACTORY_VERSION,
    spec_engine_version: SPEC_ENGINE_VERSION,
    budget_usd: ctx.budgetUsd,
    deadline_ms: ctx.deadlineMs,
    timeout_ms: parsed.timeoutMs ?? null,
    // v1.2 の段の走りだけ：経路・実効の旗の組・呼び出しの上限（旗 ids が on のときだけ。Issue #637）
    ...(flags === undefined
      ? {}
      : { pipeline: "v1.2", v12_flags: toPublicV12Flags(flags), ...(flags.ids ? { v12_call_limits: v12CallLimitsRecord() } : {}) }),
  };
  const record = buildStageRunRecord({
    range,
    input: inputRecord,
    planSha256: validation.planSha256,
    sourceSha256: validation.sourceSha256,
    checkpoints,
    conditions,
    outcome,
    exitCode: code,
    // v1.2 の段の走りだけ、`v12_calls` と（範囲が T2 を含むとき）`test_spec` を足す（Issue #637）
    ...(flags === undefined ? {} : { v12: { testSpecInRange: stagesInRange(range.start, range.end).includes("test-spec") } }),
  });
  await deps.writeFile(joinPath(job.outDir, STAGE_RUN_RECORD_FILE), stageJsonText(record));
  log(
    JSON.stringify({
      stage_pass: record["stage_pass"],
      reached_stage: record["reached_stage"],
      budget_scope: STAGE_BUDGET_SCOPE,
      exit_code: code,
    }),
  );
  return code;
}

/**
 * 1 回の生成を流し、納品物をディレクトリに書く（§3.2）。`--plan` があれば Plan を回してから Build を流す
 * （Issue #336）。`--plan-only` は Plan だけを流し、`--plan-file` は確定した仕様から Build だけを流す
 * （Issue #495）。鍵が無ければ **`makeClient` を呼ばずに**使い方の誤りで終わる（API を呼ばない）。
 */
export async function runCli(deps: CliDeps): Promise<number> {
  const log = deps.log ?? ((): void => {});
  const logError = deps.logError ?? ((): void => {});
  const parsed = parseCliArguments(deps.argv);
  if ("error" in parsed) {
    log(`使い方の誤り: ${parsed.error}`);
    log(USAGE);
    if (parsed.error.startsWith("stage-")) log(STAGE_USAGE);
    return EXIT_USAGE;
  }
  const now = deps.now ?? ((): number => Date.now());
  const budgetUsd = parsed.budgetUsd ?? deps.budgetUsd ?? DEFAULT_BUDGET_USD;
  const deadlineMs = parsed.deadlineMs ?? deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const conditions: PlanCliConditions = {
    model: parsed.model,
    effort: parsed.effort,
    budget_usd: budgetUsd,
    deadline_ms: deadlineMs,
    timeout_ms: parsed.timeoutMs ?? null,
    vocabulary_version: VOCABULARY_VERSION,
    prompt_version: promptVersionOf(parsed.pipeline),
    contract_version: CONTRACT_VERSION,
    factory_version: FACTORY_VERSION,
    spec_engine_version: SPEC_ENGINE_VERSION,
  };
  // v1.2 の走りだけ、条件の記録に経路と実効の旗の組を足す（v1・v1.1α の記録には新しい欄を出さない。Issue #547）
  const v12Flags = v12FlagsOf(parsed.pipeline);
  // 呼び出しの上限は旗 `ids` が on の走りでだけ効くので、そのときだけ定数を参照して記録に足す（Issue #616）
  const v12Conditions =
    v12Flags === undefined
      ? undefined
      : {
          pipeline: "v1.2",
          v12_flags: v12Flags,
          ...(v12Flags.ids ? { v12_call_limits: v12CallLimitsRecord() } : {}),
        };
  const recordConditions: PlanCliConditions = v12Conditions === undefined ? conditions : { ...conditions, ...v12Conditions };

  // `--plan-file`：包みを検査してから client を作る（検査で断れば API を呼ばない。Issue #495）
  if (parsed.planFile !== undefined) {
    return runBuildFromPlanFile(
      deps,
      parsed,
      parsed.planFile,
      { now, budgetUsd, deadlineMs, conditions: recordConditions },
      log,
      logError,
    );
  }

  const apiKey = deps.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    log(`使い方の誤り: 環境変数 ${API_KEY_ENV} がありません`);
    log(USAGE);
    return EXIT_USAGE;
  }

  const source = await deps.readFile(parsed.requestFile);
  const documents = await deps.loadDocuments();
  const client = deps.makeClient({ apiKey, model: parsed.model, effort: parsed.effort });
  const { judge, recheckJudge } = assembleJudge({
    env: deps.env,
    model: parsed.model,
    client,
    ...(deps.makeJevJudge === undefined ? {} : { makeJevJudge: deps.makeJevJudge }),
    ...(deps.makeLlmJudge === undefined ? {} : { makeLlmJudge: deps.makeLlmJudge }),
    logError,
  });

  const deadline = now() + deadlineMs;
  const job: BuildJob = {
    source,
    documents,
    client,
    judge,
    recheckJudge,
    outDir: parsed.outDir,
    model: parsed.model,
    effort: parsed.effort,
    budgetUsd,
    deadline,
    now,
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
  };

  if (parsed.planOnly === true) return runPlanOnly(deps, parsed, job, conditions, log);
  if (parsed.plan === true) return runPlanThenBuild(deps, parsed, job, log);
  const build = await runBuild(deps, job, log);
  return build.code;
}

// ── Node 側（ファイルと環境変数を扱う。動的に読む）────────────────────

interface NodeProcess {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  exitCode?: number;
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
  readonly stdin?: unknown;
}

interface NodeFs {
  readFile(path: URL | string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readdir(path: URL | string): Promise<readonly string[]>;
}

interface SchemaFiles {
  readonly CONTRACT_DIR: string;
  vocabularyFile(): URL;
  semanticsFile(): URL;
  packageFile(relativePath: string): URL;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

async function nodeFs(): Promise<NodeFs> {
  return (await importUntyped("node:fs/promises")) as NodeFs;
}

/** 契約・語彙の意味・語彙の台帳を、appspec-schema のファイルから読む（§2） */
export async function loadDocumentsFromFiles(): Promise<readonly PromptDocument[]> {
  const fs = await nodeFs();
  const files = (await importUntyped("@musunest/appspec-schema/files")) as SchemaFiles;
  const contractDirectory = files.packageFile(`${files.CONTRACT_DIR}/`);
  const names = (await fs.readdir(contractDirectory)).filter((name) => !name.startsWith(".")).sort();
  const contractParts: string[] = [];
  for (const name of names) {
    contractParts.push(await fs.readFile(new URL(name, contractDirectory), "utf8"));
  }
  return [
    { name: "契約", text: contractParts.join("\n") },
    { name: "語彙の意味", text: await fs.readFile(files.semanticsFile(), "utf8") },
    { name: "語彙の台帳", text: await fs.readFile(files.vocabularyFile(), "utf8") },
  ];
}

function selfUrl(): string {
  return (import.meta as ImportMeta & { url: string }).url;
}

/** この file が入口として起動されたときだけ動く（import したときは動かさない） */
function isEntryPoint(proc: NodeProcess): boolean {
  const entry = proc.argv[1];
  if (entry === undefined) return false;
  return selfUrl().endsWith(entry);
}

/** 本物の端末（1 行を読み書きする。readline は必要になったときだけ動的に読む。§7） */
function createNodeTerminal(proc: NodeProcess): Terminal {
  let reader: { question(query: string): Promise<string>; close(): void } | undefined;
  return {
    write: (line) => proc.stdout.write(`${line}\n`),
    readLine: async () => {
      if (reader === undefined) {
        const readline = (await importUntyped("node:readline/promises")) as {
          createInterface(options: { input: unknown; output: unknown }): {
            question(query: string): Promise<string>;
            close(): void;
          };
        };
        reader = readline.createInterface({ input: proc.stdin, output: proc.stdout });
      }
      try {
        return await reader.question("");
      } catch {
        return undefined;
      }
    },
  };
}

/** 手元から流す入口（`node dist/cli.js -- <依頼文> --out <ディレクトリ>`） */
export async function main(): Promise<void> {
  const proc = (globalThis as unknown as { process?: NodeProcess }).process;
  if (proc === undefined || !isEntryPoint(proc)) return;
  const fs = await nodeFs();
  const code = await runCli({
    argv: proc.argv.slice(2),
    env: proc.env,
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, text) => fs.writeFile(path, text, "utf8"),
    makeDirectory: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
    loadDocuments: loadDocumentsFromFiles,
    makeClient: ({ apiKey, model, effort, envelope }) =>
      createOpenAiLlmClient({ apiKey, model, effort, ...(envelope === undefined ? {} : { envelope }) }),
    terminal: createNodeTerminal(proc),
    log: (line) => proc.stdout.write(`${line}\n`),
    logError: (line) => proc.stderr.write(`${line}\n`),
  });
  proc.exitCode = code;
}

void main();
