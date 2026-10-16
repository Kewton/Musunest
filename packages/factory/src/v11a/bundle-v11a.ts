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
import { ARTIFACTS_DIR, type BundleArtifact } from "../bundle.js";
import type { TestSuite } from "../fixed-test.js";
import type { DeclarationElement, DeclarationMark } from "./bind-by-id.js";
import type { CarryOverEntry, DeclJudgment, SemanticJudgment } from "./carry-over.js";
import type { CoverageLoss, CoverageUnit } from "./coverage.js";
import type { NameTable } from "./names.js";
import type { JudgeAdviceMarkEntry, JudgeAdviceRecord } from "./stages/judge-advice.js";

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
