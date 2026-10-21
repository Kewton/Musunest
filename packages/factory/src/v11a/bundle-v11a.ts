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
// 旗 `v12.search-repair` が on の走りだけ、8 つ目に探索の記録 `search-repair.json`（版ごとの宣言の SHA-256・違反の数の
// 内訳・採否・捨てた候補の状態の要約・一番良い版の SHA-256・作り直しの有無）を末尾に足す（`V12_SEARCH_REPAIR_ARTIFACT_NAME`。
// Issue #551）。旗 off の走りは渡さないので、7 つの記録とバイト列で同じである。
//
// **純粋な関数**で、同じ入力からは同じバイト列になる（決まった字下げの JSON。末尾に改行 1 つ）。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import {
  ARTIFACTS_DIR,
  DIAGNOSTICS_TABLE_ROUNDS_FILE,
  type BundleArtifact,
  type BundleRejectedCandidate,
} from "../bundle.js";
import { BUILD_CLI_RECORD_SCHEMA } from "../cli-plan.js";
import type { RequirementNature, TestSuite } from "../fixed-test.js";
import type { Verdict } from "../outcome.js";
import { requirementsFromPlan } from "../pipeline.js";
import type { FailureAttribution, StageId, StageRecord, StopReason } from "../record.js";
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
import { UPSTREAM_LEDGER_BOUNDARY, type V12PublicFlags } from "../v12/ledger.js";
import type { SearchRepairRecord, VersionViolations } from "../v12/search-repair.js";

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

/** 探索の記録の置き場所（旗 `v12.search-repair` が on の走りだけ。v1.1α の 7 つの記録と重ならない。Issue #551） */
export const V12_SEARCH_REPAIR_ARTIFACT_NAME = `${ARTIFACTS_DIR}/search-repair.json` as const;

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
    /** 旗 `v12.ids` の走りだけ：コードが作った試験 ID の並び（組の順。off の走りは渡さない＝欄が無い。Issue #595） */
    readonly generatedTestIds?: readonly string[];
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
    /** T1'' が受理した要件でない文の要件 ID（1 件も無ければ省く＝欄を書かない。Issue #550） */
    readonly nonRequirements?: readonly string[];
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
  /** 探索の記録（旗 `v12.search-repair` が on の走りだけが渡す。省けば記録を足さない。Issue #551） */
  readonly searchRepair?: SearchRepairRecord;
}

/** 決まった字下げで JSON にする（同じ入力からは同じバイト列。末尾に改行 1 つ。v1 の成果物と同じ） */
function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 違反の数を記録の JSON の形にする（欄の名前は snake_case） */
function violationsJson(violations: VersionViolations): unknown {
  if (violations.kind === "static-check-failed") {
    return { kind: violations.kind, declaration_sha256: violations.declarationSha256 };
  }
  return {
    kind: violations.kind,
    declaration_sha256: violations.declarationSha256,
    breakdown: violations.breakdown,
    known_total: violations.knownTotal,
    unknown:
      violations.unknown === null
        ? null
        : { reason: violations.unknown.reason, declaration_sha256: violations.unknown.declarationSha256 },
  };
}

/** 探索の記録（`search-repair.json`）を組む（純粋。Issue #551） */
export function buildSearchRepairArtifact(record: SearchRepairRecord): BundleArtifact {
  return {
    path: V12_SEARCH_REPAIR_ARTIFACT_NAME,
    text: toJson({
      versions: record.versions.map((version) => ({
        origin: version.origin,
        declaration_sha256: version.declarationSha256,
        violations: violationsJson(version.violations),
        adopted: version.adopted,
        discarded: version.discarded,
      })),
      recounts: record.recounts.map((recount) => ({
        cause: recount.cause,
        declaration_sha256: recount.declarationSha256,
        violations: violationsJson(recount.violations),
      })),
      best_declaration_sha256: record.bestDeclarationSha256,
      rewritten: record.rewritten,
    }),
  };
}

/** v1.1α の 7 つの記録を組む（純粋。並びは `V11A_ARTIFACT_NAMES` の順。探索の記録を渡せば末尾に足す） */
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
        ...(testSpec.generatedTestIds === undefined ? {} : { generated_test_ids: testSpec.generatedTestIds }),
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
        ...(carryOver.nonRequirements === undefined ? {} : { non_requirements: carryOver.nonRequirements }),
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
    ...(input.searchRepair === undefined ? [] : [buildSearchRepairArtifact(input.searchRepair)]),
  ];
}

// ── 回ごとの行（旗 `v12.ids` の C2・C3。Issue #699）────────────────────────────────
//
// 旗 `v12.ids` の走りは C2（要件の写像）と C3（表の意味の点検）を最大 2 回回すが、段の走りの記録・checkpoint・
// 納品物は採用した回の表と判定しか残さない。初回の誤った受理が書き直しの対象から外れる（原因 3）かを記録から
// 照らすため、C2 の 1 回ごとの表・C3 の判定・書き直した要件の ID・採用した回を、**診断にだけ** 1 本のファイル
// （`diagnostics/table-rounds.json`）に残す。段の判定・持ち越し・採用した回の選び方には使わない。
//
// 表の欄は checkpoint の `name_table`、C3 の欄は一気通貫の C3 の記録の `rounds` と**同じ形**である（二重に
// 定義しない）。行が 1 つも無ければファイルを作らない（v1.1a・ids off の v1.2 は行を持たない）。

/** 回ごとの行の、C2 が組んだ表（checkpoint の `name_table` と同じ形） */
export interface TableRoundTable {
  readonly table_sha256: string;
  readonly rows: NameTable["rows"];
  readonly ownership: NameTable["ownership"];
  readonly verification: NameTable["verification"];
  readonly classification: NameTable["classification"];
}

/** 回ごとの行の、C2 が書き直した要件（2 回目だけ。初回は null） */
export interface TableRoundRewrite {
  /** 書き直した要件 ID の並び（一覧の順） */
  readonly requirement_ids: readonly string[];
  readonly rewritten: number;
  readonly kept: number;
}

/** 回ごとの行の、C3 の判定（一気通貫の C3 の記録の `rounds` と同じ形） */
export interface TableRoundSemanticCheck {
  readonly table_sha256: string;
  readonly targets: readonly string[];
  readonly judgments: readonly SemanticJudgment[];
  readonly advice: readonly JudgeAdviceMarkEntry[];
}

/** C2 の 1 回（1 行）。C3 が形で止まった回・C2 が落ちた回は欄を持たない（null） */
export interface TableRoundRecord {
  /** C2 の回（1 から） */
  readonly round: number;
  /** C2 の成否（`ok`・`unmet`・`failed`。2 回目が C2' に落ちた回は表を持たない） */
  readonly ok: "ok" | "unmet" | "failed";
  readonly table: TableRoundTable | null;
  readonly rewrite: TableRoundRewrite | null;
  readonly semantic_check: TableRoundSemanticCheck | null;
  /** その回の表を採用したか（止まった走りは全部 false） */
  readonly adopted: boolean;
}

/** 回ごとの行を 1 本の診断のファイルに組む（純粋。行が無ければファイルを作らない。Issue #699） */
export function buildTableRoundsFile(rounds: readonly TableRoundRecord[]): readonly BundleArtifact[] {
  return rounds.length === 0 ? [] : [{ path: DIAGNOSTICS_TABLE_ROUNDS_FILE, text: toJson({ rounds }) }];
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

/** 区間の表の 1 行（開始・終了・直前の境界・区間の中で段の記録に出てよい段の並び） */
export interface StageSegment {
  readonly start: StageStart;
  readonly end: StageEnd;
  readonly boundary: StageBoundary | null;
  readonly stages: readonly StageId[];
}

/**
 * 段単位の走りの区間の表（段の名前の正本）。i 番目の行が `STAGE_STARTS[i]`・`STAGE_ENDS[i]` の区間で、`boundary` は
 * その開始の直前の境界（`boundaryBefore`）。`stages` は区間の中で段の走りの記録に出てよい段（`持ち越しの停止`
 * `carry-over` は区間 0 と 2 に出る）。採点の道具は工場を import せず手で写して持ち、試験で照らす。
 * v1.2 の段を足す手は、この表に行を足す。
 */
export const STAGE_SEGMENTS: readonly StageSegment[] = [
  // 旗 `v12.ids` の走りは T1 の代わりに C1（vocabulary）・C2（mapping）が区間 0 に出る（末尾に足す。採点の写しと同じ順。Issue #593）
  { start: "name-table", end: "semantic-check", boundary: null, stages: ["name-table", "semantic-check", "carry-over", "vocabulary", "mapping"] },
  { start: "test-spec", end: "test-spec", boundary: "t1-t2", stages: ["test-spec"] },
  {
    start: "write",
    end: "judge",
    boundary: "t2-b1",
    stages: ["write", "static-check", "name-check", "decl-check", "run-tests", "repair", "arbitration", "coverage", "carry-over", "judge"],
  },
];

/** 範囲（開始 i・終了 k）の記録に出てよい段の並び（区間 i〜k をつなぐ。開始が終了より後・表に無い名前は空） */
export function stagesInRange(start: string, end: string): readonly StageId[] {
  const i = STAGE_SEGMENTS.findIndex((segment) => segment.start === start);
  const k = STAGE_SEGMENTS.findIndex((segment) => segment.end === end);
  return i < 0 || k < i ? [] : STAGE_SEGMENTS.slice(i, k + 1).flatMap((segment) => segment.stages);
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

/**
 * 開始の段の別名（`--pipeline v1.2` の段の走りだけが受ける。区間 0 の C1 語彙を区間の正本の名前に正規化する。段の表は変えない。
 * Issue #637）
 */
export const STAGE_START_ALIASES_V12: Readonly<Record<string, StageStart>> = { vocabulary: "name-table" };

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
/**
 * 再開の入力の照合が「前の走りの記録」として受ける形の版：段の走りの記録と、Build だけの記録（`--pipeline v1.2` の走りが
 * `checkpoints` を同じ形で宣言する。Issue #636）
 */
export const STAGE_PREVIOUS_RECORD_SCHEMAS: readonly string[] = [STAGE_RUN_RECORD_SCHEMA, BUILD_CLI_RECORD_SCHEMA];
/** 段の走りの記録の置き場所（`--out` の直下） */
export const STAGE_RUN_RECORD_FILE = "stage-run.json" as const;
/** 予算と締切の適用の単位（段の走り 1 本） */
export const STAGE_BUDGET_SCOPE = "stage-run" as const;
/**
 * `--pipeline v1.2` の段の走りが ⑦ まで流したとき、判定した宣言（最終版の原文）を書く置き場所（`--out` の直下）。
 * 計測の記録であって成果物ではない（納品物の `artifacts/` の名前と重ねない。manifest・門・publish に入れない。Issue #687）
 */
export const STAGE_DECLARATION_FILE = "stage-declaration.yaml" as const;

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

/** 呼び出しの上限の組（checkpoint の版の欄 `call_limits`・条件の記録の `v12_call_limits` の形。Issue #637） */
export interface StageCallLimits {
  readonly logical_calls: number;
  readonly real_attempts: number;
  readonly judge_branch: number;
}

/**
 * checkpoint に残す版（語彙・契約は照合し、prompt・工場は記録だけ）。`--pipeline v1.2` の走り（段の走り・一気通貫の走り）だけ、
 * 性質の台帳の指紋 `ledger`・実効の旗の組の公開の形 `flags`（v1.2 の照合で今の走りと同じことを求める）と、呼び出しの上限
 * `call_limits`（旗 ids が off なら null。記録だけ）を足す。v1.1α の checkpoint は 4 欄のまま（Issue #637）。
 * v1.2 は境界ごとの上流の台帳の部分の指紋 `ledger_upstream` も足す（境界 t1-t2 は部分の指紋、t2-b1 は null。`stageVersionsAt`。
 * 全体の指紋 `ledger` は今のまま記録する。Issue #713）
 */
export interface StageVersions {
  readonly vocabulary: string;
  readonly contract: string;
  readonly prompt: string;
  readonly factory: string;
  readonly ledger?: string;
  readonly ledger_upstream?: string | null;
  readonly flags?: V12PublicFlags;
  readonly call_limits?: StageCallLimits | null;
}

/**
 * v1.2 の段の入力の照合が今の走りと同じことを求める版（台帳の指紋と実効の旗の組。Issue #637）。`ledgerUpstream` は今の工場の
 * 上流の台帳の部分の指紋で、入力の境界が t1-t2 の照合だけが読む（無ければ断る。t2-b1 は読まない。Issue #713）
 */
export interface StageV12Versions {
  readonly ledger: string;
  readonly ledgerUpstream?: string;
  readonly flags: V12PublicFlags;
}

/**
 * v1.2 の checkpoint の版を境界ごとに組む（一気通貫と段の走りの書き手が共有する）。`ledger_upstream` を `ledger` の直後に置き、
 * 境界 t1-t2 には上流の台帳の部分の指紋、t2-b1 には null を書く（全境界に同じ版を使い回さない。Issue #713）
 */
export function stageVersionsAt(versions: StageVersions, boundary: StageBoundary, ledgerUpstream: string): StageVersions {
  const { vocabulary, contract, prompt, factory, ledger, flags, call_limits } = versions;
  return {
    vocabulary,
    contract,
    prompt,
    factory,
    ...(ledger === undefined ? {} : { ledger }),
    ledger_upstream: boundary === UPSTREAM_LEDGER_BOUNDARY ? ledgerUpstream : null,
    ...(flags === undefined ? {} : { flags }),
    ...(call_limits === undefined ? {} : { call_limits }),
  };
}

/** SHA-256 の 16 進の 64 桁の文字列か（部分の指紋の形の検査。Issue #713） */
const isSha256Hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

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
    /** T1'' が受理した要件でない文（1 件も無ければ欄を持たない。Issue #550） */
    readonly non_requirements?: readonly string[];
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
      ...(materials.carryOver.nonRequirements === undefined ? {} : { non_requirements: materials.carryOver.nonRequirements }),
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
  /** `--pipeline v1.2` の段の走りだけ：経路・実効の旗の組・呼び出しの上限（旗 ids が on のときだけ。Issue #637） */
  readonly pipeline?: "v1.2";
  readonly v12_flags?: V12PublicFlags;
  readonly v12_call_limits?: StageCallLimits;
}

/** T2' を通った組の数（`test_spec`。Issue #637） */
export interface StageTestSpecCounts {
  /** T2' を通った組の試験の数 */
  readonly tests: number;
  /** T2' の検査で組から外した試験の数（回す部分が `onDropped` で受けた件数） */
  readonly dropped_tests: number;
  /** 網羅の単位の数 */
  readonly coverage_units: number;
}

/** ⑦ まで流した段の走りの判定した宣言（最終版の原文・SHA-256・静的チェックの合否。Issue #687） */
export interface StageJudgedDeclaration {
  readonly source: string;
  readonly sha256: string;
  readonly staticCheckPassed: boolean;
}

/** 最終版を静的チェックに落として B3・C7 を流していない理由（実施して 0 件とは別。Issue #687） */
export const STAGE_VERIFICATION_NOT_RUN_STATIC_CHECK = "not-run:static-check" as const;

/**
 * ⑦ まで流した段の走りの検証の数（段の走りの記録の `verification`。Issue #687）。表・組・宣言・静的チェックに掛けた版の SHA は
 * 一気通貫の検証の記録（verification-v11a）と同じ値。B3・C7・未解決は最終版の実測で、最終版が静的チェックに落ちて流していなければ
 * null と理由（⑦ の判定に使う代替の 1 を写さない）
 */
export interface StageVerificationCounts {
  readonly table_sha256: string;
  readonly test_suite_sha256: string;
  readonly declaration_sha256: string;
  readonly checked_declaration_sha256s: readonly string[];
  /** B3' の件数（枯渇・形・拒否。一気通貫の verification-v11a の `decl_check` と同じ数え方） */
  readonly decl_check: { readonly exhausted: number; readonly malformed: number; readonly rejected: number };
  /** 最終版の B3 の落ちの数 */
  readonly b3_misses: number | null;
  /** 最終版の C7 の不一致の数 */
  readonly c7_mismatches: number | null;
  /** 未解決の数（裁定の未解決と最終版の未解決。停滞で足した分を含む） */
  readonly unresolved: number | null;
  /** 上の 3 つが null の理由（流したなら null） */
  readonly not_run: typeof STAGE_VERIFICATION_NOT_RUN_STATIC_CHECK | null;
  /** 止まり方（completed・stagnation・limit・unresolved） */
  readonly stop_reason: StopReason;
  /** 往復（B5）の数 */
  readonly round_trips: number;
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
  /** 旗 `v12.ids` の走りの門と枝の上限と使った数（要約の `v12_calls` と同じ形。旗 off は欄を持たない。Issue #637） */
  readonly v12Calls?: unknown;
  /** この走りで T2 を回し T2' を通ったときだけ、その組の数（再開の材料から入った走り・T2 に届かない走りは持たない。Issue #637） */
  readonly testSpec?: StageTestSpecCounts;
  /**
   * T1・T2（旗 `v12.ids` の走りは C1・C2）が断った候補（一気通貫の診断と同じ形・同じ順。候補が無ければ欄を持たない。
   * 段の判定・持ち越し・回数には使わない。Issue #683）
   */
  readonly rejected?: readonly BundleRejectedCandidate[];
  /**
   * 旗 `v12.ids` の C2 の回ごとの行（C2 の表・C3 の判定・書き直した要件・採用した回。行が無ければ欄を持たない。
   * 段の判定・持ち越し・採用した回の選び方には使わない。Issue #699）
   */
  readonly tableRounds?: readonly TableRoundRecord[];
  /**
   * ⑦ まで流したときだけ、判定した宣言と検証の数（範囲の中の ⑦ より前の早期停止は持たない。差し戻しの走りも ⑦ を流したので持つ。
   * 境界の材料には入れない。記録・ファイルに書くかは呼ぶ側が決める。Issue #687）
   */
  readonly declaration?: StageJudgedDeclaration;
  readonly verification?: StageVerificationCounts;
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
  /**
   * `--pipeline v1.2` の段の走りだけ：`v12_calls`（旗 ids の走りの使った数）と、範囲が `test-spec` を含むときの `test_spec`
   * （T2 に届かなければ null）を末尾に足す（v1.1α の記録は欄を持たない。Issue #637）
   */
  readonly v12?: { readonly testSpecInRange: boolean };
}): Record<string, unknown> {
  // `--pipeline v1.2` の段の走りで ⑦ を流したときだけ、判定した宣言のファイル（名前・SHA-256・静的チェックの合否）と検証の数を
  // 末尾に足す（v1.1α の記録は欄を持たない。Issue #687）
  const { outcome } = input;
  const v12 = input.v12;
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
    ...(v12 === undefined || outcome.v12Calls === undefined ? {} : { v12_calls: outcome.v12Calls }),
    ...(v12 === undefined || !v12.testSpecInRange ? {} : { test_spec: outcome.testSpec ?? null }),
    ...(v12 === undefined || outcome.declaration === undefined
      ? {}
      : {
          declaration: {
            file: STAGE_DECLARATION_FILE,
            sha256: outcome.declaration.sha256,
            static_check_passed: outcome.declaration.staticCheckPassed,
          },
        }),
    ...(v12 === undefined || outcome.verification === undefined ? {} : { verification: outcome.verification }),
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
 * 前の走りの記録（段の走りの記録か、`--pipeline v1.2` の Build だけの記録。Issue #636）だけ。**呼ぶ側はクライアントを作る前に呼ぶ**（断ったら API を呼ばない・何も書かない）。
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
  /** 前の走りの記録（段の走りの記録か Build だけの記録）の中身（読めなければ null） */
  readonly recordText: string | null;
  readonly plan: ConfirmedPlan;
  readonly planSha256: string;
  readonly sourceSha256: string;
  readonly vocabularyVersion: string;
  readonly contractVersion: string;
  /**
   * `--pipeline v1.2` の段の走りだけ：checkpoint の版の `ledger`・`flags` がこの値と同じことを求める（欄が無ければ断る）。省けば
   * 見ない（v1.1α の照合は今までどおり。Issue #637）。入力の境界が t1-t2 なら `ledger` の代わりに上流の台帳の部分の指紋
   * `ledger_upstream` を `ledgerUpstream` と照らす（両方が 64 桁の 16 進で同じことを求める。Issue #713）
   */
  readonly v12?: StageV12Versions;
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

  // 版：checkpoint と記録の形の版・語彙の版・契約の版（prompt と工場の版は記録するが断らない）。記録は段の走りの記録か
  // Build だけの記録（Issue #636）
  const versions = checkpoint["versions"];
  if (
    checkpoint["schema_version"] !== STAGE_CHECKPOINT_SCHEMA ||
    typeof record["schema_version"] !== "string" ||
    !STAGE_PREVIOUS_RECORD_SCHEMAS.includes(record["schema_version"]) ||
    !isObject(versions) ||
    versions["vocabulary"] !== input.vocabularyVersion ||
    versions["contract"] !== input.contractVersion
  ) {
    return fail("stage-input:version");
  }
  // v1.2 の段の走り：台帳の指紋と実効の旗の組が今の走りと同じ（欄の無い checkpoint・旗の違う上流を混ぜない。上限は照合しない。
  // Issue #637）。境界 t1-t2 は上流の段が読む台帳の部分の指紋で照らし（欠け・形の違い・不一致は断る。両方の欠けを一致とみなさない・
  // 全体の指紋に代えない）、t2-b1 は今のまま全体の指紋で照らす（`ledger_upstream` の有無・値を受理の判断に使わない。Issue #713）
  if (input.v12 !== undefined) {
    const ledgerMatches =
      needed === UPSTREAM_LEDGER_BOUNDARY
        ? isSha256Hex(versions["ledger_upstream"]) &&
          isSha256Hex(input.v12.ledgerUpstream) &&
          versions["ledger_upstream"] === input.v12.ledgerUpstream
        : versions["ledger"] === input.v12.ledger;
    if (!ledgerMatches || !isObject(versions["flags"]) || !sameJson(versions["flags"], input.v12.flags)) {
      return fail("stage-input:version");
    }
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
      ...(carryOver.nonRequirements === undefined ? {} : { non_requirements: carryOver.nonRequirements }),
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
