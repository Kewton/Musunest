// 納品物に足す v1.1α の記録（07-architecture-v1.1a.md §1.4。Issue #510）。
//
// v1 の `assembleBundle` の成果物（`design.json` ほか）はそのまま出し、`extraArtifacts` に次の 7 つを足す。
// 名前（置き場所）は**この 1 か所の定数**（`V11A_ARTIFACT_NAMES`）で決める：
//
//   - `name-table.json` … 表・所属・確かめ方・分類・表の SHA-256
//   - `test-spec.json` … 試験の組・組の SHA-256・`observes`・網羅の単位・棄却した試験 ID・B6 の結果
//   - `semantic-check.json` … T1'' の回ごとの表の SHA-256・対象の要件・判定・引用・渡した J4 の印
//   - `decl-check.json` … B3' の宣言の SHA-256 ごとの判定・引用・該当箇所の印・追加の要素の一覧・残りの点検の回数
//   - `carry-over.json` … 持ち越しの要件・理由・出どころ・除いた行
//   - `judge-advice.json` … J4 の回ごとの問いの ID・値・adapter・版（model）・閾値
//   - `verification-v11a.json` … 実際に検査した表・試験の組・宣言の SHA-256 と、B3' の枯渇・形の失敗・意味の拒否の件数
//
// **読み分け**：v1 の `verification.json` の `partial_reasons` は変えない（v1 の欄だけを数える）。持ち越し
// （4 つの出どころ）は ⑦ で未解決に数えるが、その理由と出どころは `carry-over.json` にだけ置く——部分案の
// 理由を読むときは、`partial_reasons` と `carry-over.json` の両方を読む。
//
// **純粋な関数**で、同じ入力からは同じバイト列になる（決まった字下げの JSON。末尾に改行 1 つ）。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { ARTIFACTS_DIR, type BundleArtifact } from "../bundle.js";
import type { RequirementNature, TestSuite } from "../fixed-test.js";
import type { Verdict } from "../outcome.js";
import { requirementsFromPlan } from "../pipeline.js";
import type { FailureAttribution, StageRecord } from "../record.js";
import type { DeclarationElement, DeclarationMark } from "./bind-by-id.js";
import {
  deriveCarryOver,
  type CarryOver,
  type CarryOverEntry,
  type DeclJudgment,
  type SemanticJudgment,
} from "./carry-over.js";
import { coverageUnitsOf, type CoverageLoss, type CoverageUnit } from "./coverage.js";
import { canonicalJson, nameTableSha256, type NameTable } from "./names.js";
import type { JudgeAdviceMarkEntry, JudgeAdviceRecord } from "./stages/judge-advice.js";
import { semanticCheckTargets } from "./stages/semantic-check.js";
import { testSuiteSha256, type TestObserves } from "./stages/test-spec.js";

/** v1.1α の記録の置き場所（成果物の置き場所の下。v1 の成果物と重ならない） */
export const V11A_ARTIFACT_NAMES = {
  nameTable: `${ARTIFACTS_DIR}/name-table.json`,
  testSpec: `${ARTIFACTS_DIR}/test-spec.json`,
  semanticCheck: `${ARTIFACTS_DIR}/semantic-check.json`,
  declCheck: `${ARTIFACTS_DIR}/decl-check.json`,
  carryOver: `${ARTIFACTS_DIR}/carry-over.json`,
  judgeAdvice: `${ARTIFACTS_DIR}/judge-advice.json`,
  verification: `${ARTIFACTS_DIR}/verification-v11a.json`,
} as const;

/** T1'' の 1 回の記録 */
export interface SemanticCheckRound {
  /** T1 の回（1 から） */
  readonly round: number;
  readonly tableSha256: string;
  readonly targets: readonly string[];
  readonly judgments: readonly SemanticJudgment[];
  /** T1'' に渡した J4 の印 */
  readonly advice: readonly JudgeAdviceMarkEntry[];
}

/** J4 の 1 回の記録（T1' を通った表ごと） */
export interface JudgeAdviceRound {
  readonly round: number;
  readonly tableSha256: string;
  readonly record: JudgeAdviceRecord;
}

/** B6 の 1 回の記録（棄却のたび） */
export interface CoverageCheckRecord {
  /** その時点までに棄却した試験 ID（棄却の順） */
  readonly overturnedTestIds: readonly string[];
  /** 単位を失った要件と失った単位 */
  readonly losses: readonly CoverageLoss[];
}

/** B3' の 1 版の記録 */
export interface DeclCheckVersionRecord {
  readonly declarationSha256: string;
  /** LLM に点検させた要件 ID */
  readonly targets: readonly string[];
  /** 判定（文脈なし＝`unmarked` を含む） */
  readonly judgments: readonly DeclJudgment[];
  /** 該当箇所の印（表の `id` ごと） */
  readonly marks: readonly DeclarationMark[];
  /** 表に無い追加の要素の一覧（A1 の `extraElementsOf`。B3' の入力と同じ値） */
  readonly extraElements: readonly DeclarationElement[];
  /** この版の点検のあとに残った点検の回数 */
  readonly remainingChecks: number;
}

/** B3' の件数（枯渇・形の失敗・意味の拒否を別の欄に数える。D16） */
export interface DeclCheckCounts {
  /** 点検が尽きて止めた回数（次の版を作らずに止めた・点検できない版が残った） */
  readonly exhausted: number;
  /** 形の失敗（形・完全性・引用の落ちでやり直した回数と、形の落ちで止めた回数） */
  readonly malformed: number;
  /** 意味の拒否（全版の拒否の判定の数） */
  readonly rejected: number;
}

/** 7 つの記録を組む入力 */
export interface V11aRecordsInput {
  readonly nameTable: { readonly table: NameTable; readonly sha256: string };
  readonly semanticCheck: readonly SemanticCheckRound[];
  readonly judgeAdvice: readonly JudgeAdviceRound[];
  readonly testSpec: {
    readonly suite: TestSuite;
    readonly sha256: string;
    readonly observes: ReadonlyMap<string, string>;
    readonly coverage: readonly CoverageUnit[];
    readonly overturnedTestIds: readonly string[];
    readonly coverageChecks: readonly CoverageCheckRecord[];
  };
  readonly declCheck: {
    /** 点検の上限（`declChecks`） */
    readonly limit: number;
    readonly versions: readonly DeclCheckVersionRecord[];
  };
  readonly carryOver: {
    readonly entries: readonly CarryOverEntry[];
    readonly excludedRowIds: readonly string[];
    readonly remainingRequirementIds: readonly string[];
  };
  readonly verification: {
    readonly tableSha256: string;
    readonly testSuiteSha256: string;
    /** 納品物の宣言（最終版）の SHA-256 */
    readonly declarationSha256: string;
    /** 静的チェックに掛けた宣言の版の SHA-256（版の順） */
    readonly checkedDeclarationSha256s: readonly string[];
    readonly declCheck: DeclCheckCounts;
  };
}

/** 決まった字下げで JSON にする（同じ入力からは同じバイト列。末尾に改行 1 つ。v1 の成果物と同じ） */
function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** v1.1α の 7 つの記録を組む（純粋。並びは `V11A_ARTIFACT_NAMES` の順） */
export function buildV11aArtifacts(input: V11aRecordsInput): readonly BundleArtifact[] {
  const { nameTable, testSpec, declCheck, carryOver, verification } = input;
  return [
    {
      path: V11A_ARTIFACT_NAMES.nameTable,
      text: toJson({
        table_sha256: nameTable.sha256,
        rows: nameTable.table.rows,
        ownership: nameTable.table.ownership,
        verification: nameTable.table.verification,
        classification: nameTable.table.classification,
      }),
    },
    {
      path: V11A_ARTIFACT_NAMES.testSpec,
      text: toJson({
        suite_sha256: testSpec.sha256,
        suite: testSpec.suite,
        observes: Object.fromEntries(testSpec.observes),
        coverage_units: testSpec.coverage,
        overturned_test_ids: testSpec.overturnedTestIds,
        coverage_checks: testSpec.coverageChecks.map((check) => ({
          overturned_test_ids: check.overturnedTestIds,
          losses: check.losses,
        })),
      }),
    },
    {
      path: V11A_ARTIFACT_NAMES.semanticCheck,
      text: toJson({
        rounds: input.semanticCheck.map((round) => ({
          round: round.round,
          table_sha256: round.tableSha256,
          targets: round.targets,
          judgments: round.judgments,
          advice: round.advice,
        })),
      }),
    },
    {
      path: V11A_ARTIFACT_NAMES.declCheck,
      text: toJson({
        limit: declCheck.limit,
        versions: declCheck.versions.map((version) => ({
          declaration_sha256: version.declarationSha256,
          targets: version.targets,
          judgments: version.judgments,
          marks: version.marks,
          extra_elements: version.extraElements,
          remaining_checks: version.remainingChecks,
        })),
      }),
    },
    {
      path: V11A_ARTIFACT_NAMES.carryOver,
      text: toJson({
        entries: carryOver.entries,
        excluded_row_ids: carryOver.excludedRowIds,
        remaining_requirement_ids: carryOver.remainingRequirementIds,
      }),
    },
    {
      path: V11A_ARTIFACT_NAMES.judgeAdvice,
      text: toJson({
        rounds: input.judgeAdvice.map((round) => ({
          round: round.round,
          table_sha256: round.tableSha256,
          thresholds: round.record.thresholds,
          requests: round.record.requests,
        })),
      }),
    },
    {
      path: V11A_ARTIFACT_NAMES.verification,
      text: toJson({
        table_sha256: verification.tableSha256,
        test_suite_sha256: verification.testSuiteSha256,
        declaration_sha256: verification.declarationSha256,
        checked_declaration_sha256s: verification.checkedDeclarationSha256s,
        decl_check: verification.declCheck,
      }),
    },
  ];
}

// ── 段単位の実行口の記録（08-architecture-v1.2.md §8.3。Issue #544）────────────────────────
//
// v1.1α の経路を、**開始の段と終了の段**で切って流すときの記録と照合をここに置く：
//
//   - 段の表（定数で閉じる）。開始は `name-table`（T1）・`test-spec`（T2）・`write`（B1）、終了は
//     `semantic-check`（T1'' まで）・`test-spec`（T2' まで）・`judge`（⑦ まで）。v1.2 の段は後の手で足す
//   - 再開の境界は 2 つ：`t1-t2`（持ち越しを導き、T2 を呼ぶ直前）と `t2-b1`（T2' を終え、B1 を始める直前）
//   - 境界の checkpoint（**再開の正本**）と、その**出力ダイジェスト**（checkpoint の中身全部を正規の形で並べた
//     SHA-256）。B3'・B6 で足した持ち越し・棄却・網羅の損失は checkpoint に入れない（B の結果を上流へ戻さない）
//   - 再開の入力の照合（1 つでも合わなければ固定の符号で断る。**クライアントを作る前**に呼ぶ）
//   - 段の走りの記録（`stage_pass`・`budget_scope`。納品の成功・`verdict`・`pass` の名前を使わない）
//
// 納品物の記録と同じく純粋で、ファイルも環境変数も触らない（読み書きは手元の入口 `cli.ts` が行う）。

// ── 段の表 ─────────────────────────────────────────────────────────

/** 開始の段（T1・T2・B1） */
export const STAGE_STARTS = ["name-table", "test-spec", "write"] as const;
export type StageStart = (typeof STAGE_STARTS)[number];
/** 終了の段（T1''・T2'・⑦） */
export const STAGE_ENDS = ["semantic-check", "test-spec", "judge"] as const;
export type StageEnd = (typeof STAGE_ENDS)[number];

/** 経路の上の位置（開始が終了より後かを決める） */
const STAGE_POSITION: Readonly<Record<StageStart | StageEnd, number>> = {
  "name-table": 0,
  "semantic-check": 1,
  "test-spec": 2,
  write: 3,
  judge: 4,
};

/** 再開の境界（`t1-t2`：T1''／T2 の間、`t2-b1`：T2／B1 の間） */
export const STAGE_BOUNDARIES = ["t1-t2", "t2-b1"] as const;
export type StageBoundary = (typeof STAGE_BOUNDARIES)[number];

/** 開始の段の直前の境界（開始 T1 は入力が要らない） */
export function boundaryBefore(start: StageStart): StageBoundary | null {
  if (start === "test-spec") return "t1-t2";
  if (start === "write") return "t2-b1";
  return null;
}

/** 段の範囲 */
export interface StageRange {
  readonly start: StageStart;
  readonly end: StageEnd;
}

/** 使い方の誤りの固定の符号（終了コード 2） */
export const STAGE_RANGE_USAGE_CODES = [
  "stage-range:pipeline",
  "stage-range:order",
  "stage-range:unknown",
  "stage-input:not-needed",
  "stage-input:missing",
] as const;
export type StageRangeUsageCode = (typeof STAGE_RANGE_USAGE_CODES)[number];

/** 段の入力の照合の失敗の固定の符号（終了コード 4） */
export const STAGE_INPUT_CODES = [
  "stage-input:unreadable",
  "stage-input:boundary",
  "stage-input:version",
  "stage-input:digest",
  "stage-input:plan-sha256",
  "stage-input:source-sha256",
  "stage-input:table-sha256",
  "stage-input:semantic-sha256",
  "stage-input:targets",
  "stage-input:carry-over",
  "stage-input:suite-sha256",
] as const;
export type StageInputCode = (typeof STAGE_INPUT_CODES)[number];

const isStart = (value: string): value is StageStart => (STAGE_STARTS as readonly string[]).includes(value);
const isEnd = (value: string): value is StageEnd => (STAGE_ENDS as readonly string[]).includes(value);

/**
 * 旗の値から段の範囲を決める（片方だけなら他方は経路の端）。表に無い名前は `stage-range:unknown`、開始が終了
 * より後は `stage-range:order`、入力の有無が開始の段と合わなければ `stage-input:not-needed`・`stage-input:missing`。
 */
export function resolveStageRange(input: {
  readonly start?: string;
  readonly end?: string;
  readonly hasInput: boolean;
}): StageRange | { readonly code: StageRangeUsageCode } {
  const start = input.start ?? "name-table";
  const end = input.end ?? "judge";
  if (!isStart(start) || !isEnd(end)) return { code: "stage-range:unknown" };
  if (STAGE_POSITION[start] > STAGE_POSITION[end]) return { code: "stage-range:order" };
  const needed = boundaryBefore(start);
  if (needed === null && input.hasInput) return { code: "stage-input:not-needed" };
  if (needed !== null && !input.hasInput) return { code: "stage-input:missing" };
  return { start, end };
}

// ── checkpoint ──────────────────────────────────────────────────────

/** checkpoint の形の版 */
export const STAGE_CHECKPOINT_SCHEMA = "musunest.factory.v11a-stage-checkpoint/v1" as const;
/** 段の走りの記録の形の版 */
export const STAGE_RUN_RECORD_SCHEMA = "musunest.factory.v11a-stage-run/v1" as const;
/** 段の走りの記録の置き場所（`--out` の直下） */
export const STAGE_RUN_RECORD_FILE = "stage-run.json" as const;
/** 予算と締切の適用の単位（段の走り 1 本） */
export const STAGE_BUDGET_SCOPE = "stage-run" as const;

/** 境界の checkpoint の置き場所（`--out` の直下。段の走りの記録と同じディレクトリ） */
export function stageCheckpointFile(boundary: StageBoundary): string {
  return `stage-checkpoint-${boundary}.json`;
}

/** 凍結した試験の組（T2 の出力のうち、B が使うもの） */
export interface FrozenTestSpec {
  readonly suite: TestSuite;
  readonly sha256: string;
  readonly observes: ReadonlyMap<string, TestObserves>;
  readonly coverage: readonly CoverageUnit[];
  readonly natures: ReadonlyMap<string, RequirementNature>;
}

/** 境界の材料（回す部分が境界で渡す。B の結果は入らない） */
export interface BoundaryMaterials {
  readonly boundary: StageBoundary;
  readonly table: NameTable;
  readonly tableSha256: string;
  /** 採用した T1'' の点検結果（表の SHA に結ぶ） */
  readonly semanticCheck: {
    readonly tableSha256: string;
    readonly targets: readonly string[];
    readonly judgments: readonly SemanticJudgment[];
  };
  /** 採用した表の J4 の助言 */
  readonly judgeAdvice: JudgeAdviceRecord;
  /** その時点の持ち越し（T1 の unresolved と T1'' の拒否から導いたもの） */
  readonly carryOver: CarryOver;
  /** `t2-b1` だけ：試験の組 */
  readonly testSpec?: FrozenTestSpec;
}

/** 再開の材料（照合を通った checkpoint から読む。開始の段の前の境界のもの） */
export type ResumeMaterials = Omit<BoundaryMaterials, "boundary">;

/** checkpoint に残す版（語彙・契約は照合し、prompt・工場は記録だけ） */
export interface StageVersions {
  readonly vocabulary: string;
  readonly contract: string;
  readonly prompt: string;
  readonly factory: string;
}

/** checkpoint（JSON の値） */
export interface StageCheckpoint {
  readonly schema_version: typeof STAGE_CHECKPOINT_SCHEMA;
  readonly boundary: StageBoundary;
  readonly versions: StageVersions;
  readonly plan_sha256: string;
  readonly source_sha256: string;
  readonly name_table: {
    readonly table_sha256: string;
    readonly rows: NameTable["rows"];
    readonly ownership: NameTable["ownership"];
    readonly verification: NameTable["verification"];
    readonly classification: NameTable["classification"];
  };
  readonly semantic_check: {
    readonly table_sha256: string;
    readonly targets: readonly string[];
    readonly judgments: readonly SemanticJudgment[];
  };
  readonly judge_advice: JudgeAdviceRecord;
  readonly carry_over: {
    readonly entries: readonly CarryOverEntry[];
    readonly excluded_row_ids: readonly string[];
    readonly remaining_requirement_ids: readonly string[];
  };
  readonly test_spec?: {
    readonly suite_sha256: string;
    readonly suite: TestSuite;
    /** 試験 ID → 観測する性質（組の順を保つため並びで持つ） */
    readonly observes: readonly { readonly testId: string; readonly observes: TestObserves }[];
    readonly coverage_units: readonly CoverageUnit[];
    /** 要件 ID → 採った種類（並びで持つ） */
    readonly natures: readonly { readonly requirementId: string; readonly nature: RequirementNature }[];
  };
}

/** JSON の値にそろえる（`undefined` の欄を落とす。書いた checkpoint と読み直した checkpoint を同じ値にする） */
function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 決まった字下げで JSON にする（末尾に改行 1 つ。納品物の成果物と同じ） */
export function stageJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 境界の材料から checkpoint を組む（純粋） */
export function buildStageCheckpoint(input: {
  readonly materials: BoundaryMaterials;
  readonly versions: StageVersions;
  readonly planSha256: string;
  readonly sourceSha256: string;
}): StageCheckpoint {
  const { materials } = input;
  const spec = materials.testSpec;
  return toJsonValue({
    schema_version: STAGE_CHECKPOINT_SCHEMA,
    boundary: materials.boundary,
    versions: input.versions,
    plan_sha256: input.planSha256,
    source_sha256: input.sourceSha256,
    name_table: {
      table_sha256: materials.tableSha256,
      rows: materials.table.rows,
      ownership: materials.table.ownership,
      verification: materials.table.verification,
      classification: materials.table.classification,
    },
    semantic_check: {
      table_sha256: materials.semanticCheck.tableSha256,
      targets: materials.semanticCheck.targets,
      judgments: materials.semanticCheck.judgments,
    },
    judge_advice: materials.judgeAdvice,
    carry_over: {
      entries: materials.carryOver.entries,
      excluded_row_ids: materials.carryOver.excludedRowIds,
      remaining_requirement_ids: materials.carryOver.remainingRequirementIds,
    },
    ...(spec === undefined
      ? {}
      : {
          test_spec: {
            suite_sha256: spec.sha256,
            suite: spec.suite,
            observes: [...spec.observes].map(([testId, observes]) => ({ testId, observes })),
            coverage_units: spec.coverage,
            natures: [...spec.natures].map(([requirementId, nature]) => ({ requirementId, nature })),
          },
        }),
  });
}

/** 出力ダイジェスト（checkpoint の中身全部を正規の形で並べた SHA-256） */
export function stageOutputDigest(checkpoint: unknown): Promise<string> {
  return sha256Hex(canonicalJson(checkpoint));
}

// ── 段の走りの記録 ───────────────────────────────────────────────────

/** 判定の口の構成（鍵は書かない） */
export interface StageJudgeConfiguration {
  readonly primary: "jev" | "llm";
  readonly fallback: "llm" | null;
}

/** 段の走りの条件 */
export interface StageRunConditions {
  readonly model: string;
  readonly effort: string;
  /** 文書の指紋（名前ごとの SHA-256） */
  readonly documents: readonly { readonly name: string; readonly sha256: string }[];
  readonly judge: StageJudgeConfiguration;
  readonly prompt_version: string;
  readonly vocabulary_version: string;
  readonly contract_version: string;
  readonly factory_version: string;
  readonly spec_engine_version: string;
  /** 1 本の予算（USD）と締切（ミリ秒）。段の走り 1 本に当てる */
  readonly budget_usd: number;
  readonly deadline_ms: number;
  readonly timeout_ms: number | null;
}

/** 回す部分が返す、段の走りの結果 */
export interface StageRunOutcome {
  readonly stages: readonly StageRecord[];
  /** 範囲の中の早期停止（無ければ null） */
  readonly stopped: FailureAttribution | null;
  /** 通った境界の材料（通った順） */
  readonly boundaries: readonly BoundaryMaterials[];
  /** ⑦ まで流したときの ⑦ の判定（それ以外は null） */
  readonly judgeVerdict: Verdict | null;
  /** ⑦ まで流したときの最終の持ち越し（記録だけ。再開の入力にしない） */
  readonly finalCarryOver: readonly CarryOverEntry[] | null;
  readonly returnToPlan: boolean;
  readonly costUsd: number;
  readonly durationSecs: number;
}

/** 段の通過：範囲の中に早期停止が無く、終了の段の最後の記録が ok */
export function stagePassOf(outcome: Pick<StageRunOutcome, "stages" | "stopped">, end: StageEnd): boolean {
  if (outcome.stopped !== null) return false;
  const last = outcome.stages.filter((record) => record.stage === end).at(-1);
  return last !== undefined && last.status === "ok";
}

/** 段の走りの記録（JSON の値）を組む。`verdict`・`pass` の名前の欄を置かない */
export function buildStageRunRecord(input: {
  readonly range: StageRange;
  readonly input: { readonly checkpoint: string; readonly boundary: StageBoundary; readonly output_digest: string } | null;
  readonly planSha256: string;
  readonly sourceSha256: string;
  readonly checkpoints: readonly { readonly boundary: StageBoundary; readonly path: string; readonly output_digest: string }[];
  readonly conditions: StageRunConditions;
  readonly outcome: StageRunOutcome;
  readonly exitCode: number;
}): Record<string, unknown> {
  const { outcome } = input;
  return toJsonValue({
    schema_version: STAGE_RUN_RECORD_SCHEMA,
    range: { start: input.range.start, end: input.range.end },
    input: input.input,
    plan_sha256: input.planSha256,
    source_sha256: input.sourceSha256,
    checkpoints: input.checkpoints,
    reached_stage: outcome.stages.at(-1)?.stage ?? null,
    conditions: input.conditions,
    budget_scope: STAGE_BUDGET_SCOPE,
    provider_cost_usd: outcome.costUsd,
    duration_secs: outcome.durationSecs,
    stages: outcome.stages,
    stopped: outcome.stopped,
    stage_pass: stagePassOf(outcome, input.range.end),
    ...(outcome.judgeVerdict === null ? {} : { stage_judge_verdict: outcome.judgeVerdict }),
    ...(outcome.finalCarryOver === null ? {} : { final_carry_over: outcome.finalCarryOver }),
    return_to_plan: outcome.returnToPlan,
    exit_code: input.exitCode,
  });
}

// ── 再開の入力の照合 ─────────────────────────────────────────────────

/** 照合の結果 */
export type StageInputVerification =
  | {
      readonly ok: true;
      readonly resume: ResumeMaterials;
      readonly input: { readonly checkpoint: string; readonly boundary: StageBoundary; readonly output_digest: string };
    }
  | { readonly ok: false; readonly code: StageInputCode };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const sameJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const fail = (code: StageInputCode): StageInputVerification => ({ ok: false, code });

/**
 * 再開の入力を照合する（1 つでも合わなければ固定の符号で断る）。読むのは開始の段の直前の境界の checkpoint と、
 * 前の段の走りの記録だけ。**呼ぶ側はクライアントを作る前に呼ぶ**（断ったら API を呼ばない・何も書かない）。
 *
 * 照合の順：読める → 境界 → 版 → 出力ダイジェスト → 確定した仕様・依頼文の SHA → 表の SHA → 点検結果の表の SHA →
 * 点検の対象 → 持ち越し →（開始 B1）試験の組。
 */
export async function verifyStageInput(input: {
  readonly start: StageStart;
  /** checkpoint のファイルの中身（読めなければ null） */
  readonly checkpointText: string | null;
  /** checkpoint のファイルの名前（記録が宣言する `path` と照らす） */
  readonly checkpointFile: string;
  /** 前の段の走りの記録の中身（読めなければ null） */
  readonly recordText: string | null;
  readonly plan: ConfirmedPlan;
  readonly planSha256: string;
  readonly sourceSha256: string;
  readonly vocabularyVersion: string;
  readonly contractVersion: string;
}): Promise<StageInputVerification> {
  const needed = boundaryBefore(input.start);
  if (needed === null) return fail("stage-input:boundary");

  const checkpoint = parseObject(input.checkpointText);
  const record = parseObject(input.recordText);
  if (checkpoint === null || record === null) return fail("stage-input:unreadable");

  // 境界：checkpoint が開始の段の直前の境界のもので、前の段の走りの記録がそれを宣言している
  if (checkpoint["boundary"] !== needed) return fail("stage-input:boundary");
  const declared = Array.isArray(record["checkpoints"])
    ? (record["checkpoints"] as readonly unknown[]).find(
        (entry) => isObject(entry) && entry["boundary"] === needed && entry["path"] === input.checkpointFile,
      )
    : undefined;
  if (!isObject(declared) || typeof declared["output_digest"] !== "string") return fail("stage-input:boundary");

  // 版：checkpoint と記録の形の版・語彙の版・契約の版（prompt と工場の版は記録するが断らない）
  const versions = checkpoint["versions"];
  if (
    checkpoint["schema_version"] !== STAGE_CHECKPOINT_SCHEMA ||
    record["schema_version"] !== STAGE_RUN_RECORD_SCHEMA ||
    !isObject(versions) ||
    versions["vocabulary"] !== input.vocabularyVersion ||
    versions["contract"] !== input.contractVersion
  ) {
    return fail("stage-input:version");
  }

  // 出力ダイジェスト：中身から計算し直して記録の値と一致
  if ((await stageOutputDigest(checkpoint)) !== declared["output_digest"]) return fail("stage-input:digest");

  // 確定した仕様・依頼文の SHA が、今の確定した仕様の検査の結果と一致
  if (checkpoint["plan_sha256"] !== input.planSha256) return fail("stage-input:plan-sha256");
  if (checkpoint["source_sha256"] !== input.sourceSha256) return fail("stage-input:source-sha256");

  const typed = checkpoint as unknown as StageCheckpoint;
  const list = requirementsFromPlan(input.plan);

  // 表の SHA を中身から計算し直して一致
  const nameTable = typed.name_table;
  if (!isObject(nameTable)) return fail("stage-input:table-sha256");
  const table: NameTable = {
    rows: nameTable.rows,
    ownership: nameTable.ownership,
    verification: nameTable.verification,
    classification: nameTable.classification,
  };
  let tableSha256: string;
  try {
    tableSha256 = await nameTableSha256(table);
  } catch {
    return fail("stage-input:table-sha256");
  }
  if (tableSha256 !== nameTable.table_sha256) return fail("stage-input:table-sha256");

  // 点検結果の表の SHA が採用した表と一致
  const semantic = typed.semantic_check;
  if (!isObject(semantic) || semantic.table_sha256 !== tableSha256) return fail("stage-input:semantic-sha256");

  // 点検の対象：今の T1'' と同じ関数で導いた対象と過不足なくそろい、各 ID に判定が 1 つ
  let targets: readonly string[];
  try {
    targets = semanticCheckTargets(list, table);
  } catch {
    return fail("stage-input:targets");
  }
  const judgments = Array.isArray(semantic.judgments) ? semantic.judgments : null;
  const judged = judgments?.map((judgment) => (isObject(judgment) ? judgment["requirementId"] : undefined)) ?? [];
  if (
    judgments === null ||
    !Array.isArray(semantic.targets) ||
    !sameJson(semantic.targets, targets) ||
    judged.length !== targets.length ||
    new Set(judged).size !== judged.length ||
    !judged.every((id) => typeof id === "string" && targets.includes(id)) ||
    !judgments.every((judgment) => judgment.verdict === "accept" || judgment.verdict === "reject")
  ) {
    return fail("stage-input:targets");
  }

  // 持ち越し：一覧・表・採用した点検結果から既存の関数で導き直したものと同じ
  let carryOver: CarryOver;
  try {
    carryOver = await deriveCarryOver({ list, table, semanticCheck: { tableSha256, judgments } });
  } catch {
    return fail("stage-input:carry-over");
  }
  if (
    carryOver.allCarried ||
    !sameJson(typed.carry_over, {
      entries: carryOver.entries,
      excluded_row_ids: carryOver.excludedRowIds,
      remaining_requirement_ids: carryOver.remainingRequirementIds,
    })
  ) {
    return fail("stage-input:carry-over");
  }

  const base: ResumeMaterials = {
    table,
    tableSha256,
    semanticCheck: { tableSha256, targets, judgments },
    judgeAdvice: typed.judge_advice,
    carryOver,
  };
  const inputRecord = { checkpoint: input.checkpointFile, boundary: needed, output_digest: declared["output_digest"] };
  if (input.start !== "write") return { ok: true, resume: base, input: inputRecord };

  // 開始 B1：試験の組の SHA を中身から計算し直して一致し、observes と網羅の単位がそろう
  const spec = typed.test_spec;
  if (!isObject(spec) || !isObject(spec.suite) || !Array.isArray(spec.suite.tests)) return fail("stage-input:suite-sha256");
  try {
    const observes = new Map(spec.observes.map((entry) => [entry.testId, entry.observes] as const));
    const natures = new Map(spec.natures.map((entry) => [entry.requirementId, entry.nature] as const));
    const testIds = spec.suite.tests.map((test) => test.id);
    if (
      observes.size !== spec.observes.length ||
      natures.size !== spec.natures.length ||
      new Set(testIds).size !== observes.size ||
      !testIds.every((id) => observes.has(id)) ||
      (await testSuiteSha256(spec.suite, observes)) !== spec.suite_sha256 ||
      !sameJson(coverageUnitsOf({ suite: spec.suite, observes, natures }), spec.coverage_units)
    ) {
      return fail("stage-input:suite-sha256");
    }
    return {
      ok: true,
      resume: {
        ...base,
        testSpec: { suite: spec.suite, sha256: spec.suite_sha256, observes, coverage: spec.coverage_units, natures },
      },
      input: inputRecord,
    };
  } catch {
    return fail("stage-input:suite-sha256");
  }
}
