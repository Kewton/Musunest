// ⑧ 納品物にする（02-architecture.md §1・§3.2・§4・F-10）。
//
// CommandAgent と同じ形の bundle を組み立てる（§4・F-10）。形の正本は appspec-schema の納品物の入口
// （`@musunest/appspec-schema` の delivery.ts）。
//
//   - 納品物の直下の JSON（`bundle-manifest.json`）… `files` の SHA-256 と大きさ・`instrument`・
//     `expected_verdict` など
//   - `artifacts/` の下のファイル … 宣言（`app.spec.yaml`）・要約・要件の一覧・書けなかった要件の
//     一覧（`unwritable.json`）・対応表・試験の結果・申告・裁定の記録・検証の結果
//   - 検証の結果（`artifacts/verification.json`）に、**最後の宣言のバイト列の SHA-256** を書く（§4・R-3）。
//     あわせて、**部分案になった理由**（書けない要件・未解決・曖昧さ・未解決の試験・対応表の落ち）を出す
//     （Issue #326。合格のときは空で出る）
//
// ファイルはすべて UTF-8 の文字列として持つ（UTF-8 にすればこの文字列のバイト列になる）。SHA-256 は
// spec-engine の `sha256Hex` を使う（Worker でも Node でも動く）。**この file はファイルも環境変数も扱わない**
// ——書くのは手元の入口（cli.ts）だけである。
import {
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  planDigest,
  type BundleManifest,
  type BundleManifestFile,
  type ConfirmedPlan,
} from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import type { JudgeSource } from "./judge.js";
import type { Outcome } from "./outcome.js";
import type {
  ArbitrationResult,
  CorrespondenceResult,
  Declaration,
  DesignResult,
  NatureDiscrepancy,
  RejectedDispute,
  RequirementList,
  RequirementNature,
  RoleNameMapping,
  StructuralAssertionKind,
  StructuralCheckResult,
  TestRunResult,
  TestSuite,
} from "./pipeline.js";
import type { StageId, StageOperation, StageRecord, Summary } from "./record.js";
import { utf8ByteLength } from "./stages/write.js";
import type { DroppedNonstructuralTest } from "./stages/test-suite.js";

/**
 * 判定の呼び出しの数と費用（Issue #359）。**答えた adapter（jev・llm・fake）ごと**に呼び出しの数を
 * 数え、判定の費用（USD）を残す。費用は**段の費用（`provider_cost_usd`）とは別の欄**に置く——
 * 判定は助言であり、段の呼び出しと同じ予算で数えるが、費用の内訳は分けて読めるようにする（05 §5）。
 */
export interface BundleJudgeUsage {
  /** 答えた adapter（jev・llm・fake）ごとの、判定の呼び出しの数 */
  readonly calls_by_adapter: Readonly<Record<JudgeSource, number>>;
  /** 判定の費用（USD）。段の費用（`provider_cost_usd`）とは別の欄 */
  readonly cost_usd: number;
}

/**
 * ②' で種類が食い違った要件の記録（Issue #373）。**決め方**（決まりで倒した `fallback`／判定で選んだ
 * `judged`）を残し、判定で選んだときは確率・判定のモデル・閾値の版を残す（依頼文の全文は残さない）。
 */
export interface BundleNatureDiscrepancy {
  readonly requirement_id: string;
  /** ② の設計が決めた種類 */
  readonly design: RequirementNature;
  /** ②' が独立に分類した種類 */
  readonly classified: RequirementNature;
  /** 実際に採った種類 */
  readonly resolved: RequirementNature;
  /** どう決めたか（決まりで倒した／判定で選んだ） */
  readonly resolution: "fallback" | "judged";
  /** 判定で選んだときの、選んだ選択肢の確率（閾値以上） */
  readonly probability?: number;
  /** 判定で答えたモデルの版の ID */
  readonly model?: string;
  /** 判定の閾値の版の ID */
  readonly threshold_version?: string;
}

/**
 * 固定の前に外した、**構造で確かめる要件の構造の検査でない試験**の数（Issue #392）。形の検査を通した
 * **生成の回ごと**に外した件数を合計し、**操作ごと**の内訳も持つ。**0 件のときは欄を省く**（要約の任意の欄）。
 */
export interface BundleDroppedNonstructuralTests {
  /** 外した件数の合計（回ごとに数えたものの合計） */
  readonly count: number;
  /** 外した試験の操作ごとの件数 */
  readonly by_operation: Readonly<Record<string, number>>;
}

/**
 * 納品物の要約（appspec-schema の wire に、記録の欄と**判定の呼び出しの数・費用**、②' の種類の食い違いの
 * 記録、固定の前に外した試験の数を足したもの。Issue #359・#373・#392）。wire は知らない欄を足しても
 * 受け付ける（`acceptsHeadlessSummaryWire`）ので、どれも additive に足す。
 */
export interface BundleSummary extends Summary {
  readonly judge: BundleJudgeUsage;
  /** ②' で種類が食い違った要件の記録（食い違いが無ければ空の並び。Issue #373） */
  readonly nature_discrepancies: readonly BundleNatureDiscrepancy[];
  /**
   * 固定の前に外した、構造で確かめる要件の構造の検査でない試験の数（**0 件のときは省く**。Issue #392）。
   * **②' が最後に失敗しても・後の段で早く止まっても**残る（成功の戻り値だけに頼らない）。
   */
  readonly dropped_nonstructural_tests?: BundleDroppedNonstructuralTests;
}

/**
 * 外した試験の記録（回・試験 ID・要件 ID・操作。Issue #392）から、要約の欄（数と操作ごとの内訳）を組む。
 * **0 件なら `undefined`** を返し、要約の欄を省く。
 */
export function toDroppedNonstructuralTests(
  entries: readonly DroppedNonstructuralTest[],
): BundleDroppedNonstructuralTests | undefined {
  if (entries.length === 0) return undefined;
  const byOperation: Record<string, number> = {};
  for (const entry of entries) {
    byOperation[entry.operation] = (byOperation[entry.operation] ?? 0) + 1;
  }
  return { count: entries.length, by_operation: byOperation };
}

/** ②' の食い違いの記録を、要約に載せる形（snake_case）に写す（Issue #373） */
export function toBundleNatureDiscrepancies(
  entries: readonly NatureDiscrepancy[],
): readonly BundleNatureDiscrepancy[] {
  return entries.map((entry) => ({
    requirement_id: entry.requirementId,
    design: entry.design,
    classified: entry.classified,
    resolved: entry.resolved,
    resolution: entry.resolution,
    ...(entry.probability === undefined ? {} : { probability: entry.probability }),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.thresholdVersion === undefined ? {} : { threshold_version: entry.thresholdVersion }),
  }));
}

/** manifest のファイル名。**納品物の直下**に置く（control-plane の照合と同じ名前） */
export const BUNDLE_MANIFEST_FILE = "bundle-manifest.json" as const;

/** 納品物の下の、検証の結果などを置くディレクトリ */
export const ARTIFACTS_DIR = "artifacts" as const;

/** 宣言（app.spec.yaml）の置き場所（CommandAgent と同じ） */
export const DECLARATION_FILE = `${ARTIFACTS_DIR}/app.spec.yaml` as const;
/** 要約（appspec-schema の wire）の置き場所 */
export const SUMMARY_FILE = `${ARTIFACTS_DIR}/summary.json` as const;
/** 要件の一覧（①）の置き場所 */
export const REQUIREMENTS_FILE = `${ARTIFACTS_DIR}/requirements.json` as const;
/** 対応表（⑤a）の置き場所 */
export const CORRESPONDENCE_FILE = `${ARTIFACTS_DIR}/correspondence.json` as const;
/** 試験の結果（⑤b）の置き場所 */
export const TESTS_FILE = `${ARTIFACTS_DIR}/tests.json` as const;
/** 申告（⑥ の主張と、受け付けなかった主張）の置き場所 */
export const DISPUTES_FILE = `${ARTIFACTS_DIR}/disputes.json` as const;
/** 裁定の記録（⑥'）の置き場所 */
export const ARBITRATION_FILE = `${ARTIFACTS_DIR}/arbitration.json` as const;
/** 検証の結果（宣言のバイト列の SHA-256 を結び付ける。§4・R-3）の置き場所 */
export const VERIFICATION_FILE = `${ARTIFACTS_DIR}/verification.json` as const;
/**
 * 書けなかった要件の一覧（② の `unwritable` に、要件の文と引用を添えたもの。Issue #326）の置き場所。
 * 検証の結果と同じく、**最後の宣言のバイト列の SHA-256** を中に書く（§4・R-3）。
 */
export const UNWRITABLE_FILE = `${ARTIFACTS_DIR}/unwritable.json` as const;
/**
 * 確定した仕様（`plan.json`）の置き場所（§4・Issue #334）。**無くてよい**（今の納品物と互換）。あるときは、
 * manifest の最上位の `plan_sha256` と、検証の結果の `plan_sha256` に、**同じ仕様の SHA-256** を載せる
 * （門（#335）が、この 2 つと `plan.json` から計算した値を照合する）。
 */
export const PLAN_FILE = `${ARTIFACTS_DIR}/plan.json` as const;
/** manifest と検証の結果が、確定した仕様の SHA-256 を載せる欄の名前（門（#335）と同じ名前にする） */
export const PLAN_SHA256_FIELD = "plan_sha256" as const;

// ── 受理した材料（設計・固定した試験・提出された対応）と、早期停止の診断（Issue #417）──────
//
// 早期停止でも、段が**受理した時点で積んだ材料**だけを診断の成果物として残す。完走では、同じ材料を
// 納品物の成果物に足す。**合否・verdict・停止理由・終了コードの決め方は変えない**——診断の有無は門の
// 条件にしない。材料の状態は 4 値：受理済み（段が ok で採った）・候補（段が返したが最終の判定の前）・
// 未受理（段を実行したが材料を採れなかった）・未実行（段に届かなかった）。

/** 納品物の成果物に足す、受理した設計（②）の置き場所（Issue #417） */
export const DESIGN_FILE = `${ARTIFACTS_DIR}/design.json` as const;
/** 納品物の成果物に足す、固定した試験の組（②'）の置き場所（Issue #417） */
export const TEST_SUITE_FILE = `${ARTIFACTS_DIR}/test-suite.json` as const;
/** 納品物の成果物に足す、提出された対応（③）の置き場所（Issue #417） */
export const MAPPINGS_FILE = `${ARTIFACTS_DIR}/mappings.json` as const;

/**
 * 診断の成果物の置き場所（早期停止のときだけ）。**納品物の置き場所（`ARTIFACTS_DIR`）とは別**にする
 * ——早期停止を納品物にしないためである（Issue #417）。
 */
export const DIAGNOSTICS_DIR = "diagnostics" as const;
/** 診断の一覧（材料ごとの状態・止めた段と分類・版ごとの評価の行・回数）の置き場所 */
export const DIAGNOSTICS_LISTING_FILE = `${DIAGNOSTICS_DIR}/materials.json` as const;
/** 診断に出す、受理した設計の置き場所 */
export const DIAGNOSTICS_DESIGN_FILE = `${DIAGNOSTICS_DIR}/design.json` as const;
/** 診断に出す、固定した試験の組の置き場所 */
export const DIAGNOSTICS_TEST_SUITE_FILE = `${DIAGNOSTICS_DIR}/test-suite.json` as const;
/** 診断に出す、提出された対応の置き場所 */
export const DIAGNOSTICS_MAPPINGS_FILE = `${DIAGNOSTICS_DIR}/mappings.json` as const;
/** 診断に出す、候補の宣言（③ か ⑥ が返した原文。版ごと）の置き場所 */
export const DIAGNOSTICS_DECLARATION_FILE = `${DIAGNOSTICS_DIR}/declaration.json` as const;
/** 診断に出す、静的チェックの診断（版ごと）の置き場所 */
export const DIAGNOSTICS_STATIC_CHECK_FILE = `${DIAGNOSTICS_DIR}/static-check.json` as const;

/** 診断に出す、② が断った設計の候補（形と中身。値つき。Issue #501）の置き場所 */
export const DIAGNOSTICS_REJECTED_DESIGN_FILE = `${DIAGNOSTICS_DIR}/rejected-design.json` as const;
/** 診断に出す、②' が断った試験の組の候補（形と中身。値つき。Issue #501）の置き場所 */
export const DIAGNOSTICS_REJECTED_TEST_SUITE_FILE = `${DIAGNOSTICS_DIR}/rejected-test-suite.json` as const;
/** 診断に出す、v1.1α の名前の表（T1）が断った候補の置き場所（`07-architecture-v1.1a.md` §1） */
export const DIAGNOSTICS_REJECTED_NAME_TABLE_FILE = `${DIAGNOSTICS_DIR}/rejected-name-table.json` as const;
/** 診断に出す、v1.1α の試験の仕様（T2）が断った候補の置き場所（`07-architecture-v1.1a.md` §1） */
export const DIAGNOSTICS_REJECTED_TEST_SPEC_FILE = `${DIAGNOSTICS_DIR}/rejected-test-spec.json` as const;

/** 断った候補を出す段（Issue #501。`name-table`・`test-spec` は v1.1α の段） */
export type RejectedCandidateStage = "design" | "test-suite" | "name-table" | "test-spec";

/** 断った候補の段ごとのファイル（並びは書く順。v1 の 2 段が先） */
const REJECTED_CANDIDATE_FILES: readonly { readonly stage: RejectedCandidateStage; readonly path: string }[] = [
  { stage: "design", path: DIAGNOSTICS_REJECTED_DESIGN_FILE },
  { stage: "test-suite", path: DIAGNOSTICS_REJECTED_TEST_SUITE_FILE },
  { stage: "name-table", path: DIAGNOSTICS_REJECTED_NAME_TABLE_FILE },
  { stage: "test-spec", path: DIAGNOSTICS_REJECTED_TEST_SPEC_FILE },
];

/** 断った候補の問題 1 つ（参照元と、その参照元の JSON の SHA-256 を結ぶ。Issue #501） */
export interface BundleRejectedProblem {
  readonly field: string;
  readonly message: string;
  readonly code?: string;
  /** 参照元（`target` ＝中身の検査に掛けた候補の全体、`response` ＝ raw の応答） */
  readonly reference: "target" | "response";
  /** 参照元の JSON の SHA-256 */
  readonly reference_sha256: string;
}

/**
 * 断った候補 1 つ（値つき。診断の候補のファイルにだけ置く。Issue #501）。段・`operation`・段の呼び出しの
 * 通し番号（`call`）・回（中身の round）・試行（形の attempt）で、段の記録の呼び出しへ結び付く。SHA-256 は
 * `JSON.stringify` した値の SHA-256（材料の版と同じ計算）である。形の候補は対象と一覧を持たない。
 */
export interface BundleRejectedCandidate {
  readonly stage: RejectedCandidateStage;
  readonly operation: StageOperation | null;
  readonly call: number;
  readonly round: number;
  readonly attempt: number;
  readonly kind: "shape" | "content";
  readonly target?: unknown;
  readonly target_sha256?: string;
  readonly response: unknown;
  readonly response_sha256: string;
  readonly inspection_list?: unknown;
  readonly inspection_list_sha256?: string;
  readonly problems: readonly BundleRejectedProblem[];
}

/** 固定文（と分類）ごとの件数（値を持たない。Issue #501） */
export interface BundleRejectedMessageCount {
  readonly message: string;
  readonly code?: string;
  readonly count: number;
}

/** 一覧に置く、断った候補の要約（値なし。Issue #501） */
export interface BundleRejectedSummary {
  readonly stage: RejectedCandidateStage;
  readonly operation: StageOperation | null;
  readonly call: number;
  readonly round: number;
  readonly attempt: number;
  readonly kind: "shape" | "content";
  readonly problem_count: number;
  readonly messages: readonly BundleRejectedMessageCount[];
}

/** 断った候補を、値の無い要約にする（分類の鍵は固定文と `code`。現れた順。Issue #501） */
export function summarizeRejectedCandidates(
  candidates: readonly BundleRejectedCandidate[],
): readonly BundleRejectedSummary[] {
  return candidates.map((candidate) => {
    const counts: { message: string; code?: string; count: number }[] = [];
    for (const problem of candidate.problems) {
      const found = counts.find((entry) => entry.message === problem.message && entry.code === problem.code);
      if (found === undefined) {
        counts.push({ message: problem.message, ...(problem.code === undefined ? {} : { code: problem.code }), count: 1 });
      } else {
        found.count += 1;
      }
    }
    return {
      stage: candidate.stage,
      operation: candidate.operation,
      call: candidate.call,
      round: candidate.round,
      attempt: candidate.attempt,
      kind: candidate.kind,
      problem_count: candidate.problems.length,
      messages: counts,
    };
  });
}

/**
 * 断った候補のファイルを組む（Issue #501）。**段ごとに別のファイル**にし（設計・試験の組、v1.1α の
 * 名前の表・試験の仕様）、候補が無い段のファイルは作らない。名前はコードの定数である。**manifest は組まない。**
 */
export function buildRejectedCandidateFiles(candidates: readonly BundleRejectedCandidate[]): readonly BundleArtifact[] {
  const artifacts: BundleArtifact[] = [];
  for (const { stage, path } of REJECTED_CANDIDATE_FILES) {
    const ofStage = candidates.filter((candidate) => candidate.stage === stage);
    if (ofStage.length > 0) artifacts.push({ path, text: toJson({ candidates: ofStage }) });
  }
  return artifacts;
}

/** 材料・検査の種類（一覧の 1 行ごと。コードの定数） */
export const MATERIAL_KINDS = [
  "design", // ② の設計（役割 ID の表と要件ごとの設計）
  "test_suite", // ②' の固定した試験の組（分類込み。棄却で外す前）
  "mappings", // ③ の提出した対応（役割 ID → 宣言の名前）
  "declaration", // ③ か ⑥ が返した宣言（候補）
  "correspondence", // ⑤a の対応表
  "test_run", // ⑤b の試験の結果
  "evaluation", // ④⑤ の評価（版ごとの行）
] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/** 材料の状態の 4 値（§Issue #417） */
export const MATERIAL_STATES = ["accepted", "candidate", "unaccepted", "unexecuted"] as const;
export type MaterialState = (typeof MATERIAL_STATES)[number];

/**
 * 材料の版。設計・試験・対応は**受理した段の記録の添字**（`stages` の何件目か）と、**材料の JSON の
 * SHA-256**。宣言は**宣言（原文）のバイト列の SHA-256** だけ（どちらも `sha256` に入れる）。
 */
export interface BundleMaterialVersion {
  readonly sha256: string;
  /** 受理した段の記録の添字（設計・試験・対応。宣言では省く） */
  readonly stage_index?: number;
}

/** 一覧の 1 行（材料ごとの状態。Issue #417） */
export interface BundleMaterialEntry {
  readonly material: MaterialKind;
  readonly state: MaterialState;
  readonly version?: BundleMaterialVersion;
  /** 宣言が候補のとき、その版が静的チェックを通ったか（宣言の行だけ） */
  readonly static_check_passed?: boolean;
}

/** 実行していない検査の落ちの件数（0 と区別する。Issue #417） */
export const UNEXECUTED = "unexecuted" as const;
export type InspectionCount = number | typeof UNEXECUTED;

/**
 * 版ごとの評価の行（§Issue #417）。④ の結果を受け取った時点で積み、⑤a・⑤b の完了時に同じ宣言の
 * SHA-256 の行へ追記する。**試験 ID と文言は持たない**——件数と、失敗の行き先ごとの件数だけを持つ。
 * 実行していない検査の落ちの件数は 0 とせず `"unexecuted"` と記す。
 */
export interface BundleEvaluationRow {
  readonly declaration_sha256: string;
  readonly static_check_passed: boolean;
  readonly static_check_diagnostics: number;
  readonly correspondence_misses: InspectionCount;
  readonly test_mismatches: InspectionCount;
  readonly test_unresolved: InspectionCount;
  /** 失敗の行き先（`correspondence-redo` など）ごとの件数 */
  readonly routes: Readonly<Record<string, number>>;
}

/**
 * 回数（段の記録から数える。§Issue #417）。評価の回数・③ の初回・③ の対応の出し直し・⑤a の生成・
 * ⑥ の段の実行数を**別々に**数え、LLM の試行の数や道具の内部の検査の数と同一視しない。
 */
export interface BundleMaterialCounts {
  readonly evaluations: number;
  readonly write_initial: number;
  readonly write_redos: number;
  readonly correspondence_generations: number;
  readonly repair_executions: number;
}

/**
 * 段の記録から回数を数える（§Issue #417）。評価は ④（`static-check`）の記録の数、③ の初回は
 * `write` の記録の有無、③ の出し直しは `write` の記録から初回を除いた数、⑤a の生成は
 * `correspondence`、⑥ の実行は `repair` の記録の数である。**段の記録と必ず一致する**——
 * 数え方を 2 つ持たない。
 */
export function materialCounts(stages: readonly StageRecord[]): BundleMaterialCounts {
  const countOf = (stage: StageId): number => stages.filter((record) => record.stage === stage).length;
  const writes = countOf("write");
  return {
    evaluations: countOf("static-check"),
    write_initial: writes > 0 ? 1 : 0,
    write_redos: Math.max(0, writes - 1),
    correspondence_generations: countOf("correspondence"),
    repair_executions: countOf("repair"),
  };
}

/**
 * 早期停止の診断の組み立ての入力（§Issue #417）。**積んだ材料だけ**を渡す——無い材料は省き、一覧には
 * 状態（未受理・未実行）として出る。空の宣言も manifest も組まない。
 */
export interface DiagnosticsInput {
  /** 止めた段と分類（早期停止。無ければ null） */
  readonly stopped: { readonly stage: string; readonly kind: string } | null;
  readonly materials: readonly BundleMaterialEntry[];
  readonly evaluations: readonly BundleEvaluationRow[];
  readonly counts: BundleMaterialCounts;
  /** 受理した設計（在るときだけ） */
  readonly design?: DesignResult;
  /** 受理した固定した試験の組（在るときだけ） */
  readonly testSuite?: TestSuite;
  /** 受理した提出された対応（在るときだけ） */
  readonly mappings?: readonly RoleNameMapping[];
  /** 候補の宣言（版ごと。在るときだけ） */
  readonly declarations?: readonly { readonly sha256: string; readonly declaration: string }[];
  /** 静的チェックの診断（版ごと。実行したときだけ） */
  readonly staticChecks?: readonly {
    readonly declaration_sha256: string;
    readonly passed: boolean;
    readonly diagnostics: readonly unknown[];
  }[];
  /** ②・②' が断った候補（値つき。在るときだけ。Issue #501） */
  readonly rejected?: readonly BundleRejectedCandidate[];
}

/**
 * 早期停止の診断の成果物を組む（§1.4・§4・Issue #417）。**積んだ材料だけ**から組み、無い材料の
 * ファイルは作らない。一覧（材料ごとの状態・止めた段と分類・版ごとの評価の行・回数）は常に出す。
 * **manifest は組まない**（早期停止を納品物にしない）。ファイルの名前はコードの定数である。
 */
export function buildDiagnostics(input: DiagnosticsInput): readonly BundleArtifact[] {
  const artifacts: BundleArtifact[] = [
    {
      path: DIAGNOSTICS_LISTING_FILE,
      text: toJson({
        stopped: input.stopped,
        materials: input.materials,
        evaluations: input.evaluations,
        counts: input.counts,
        // 断った候補の要約（値なし。Issue #501）。候補の中身は下の候補のファイルにだけ置く
        rejected: summarizeRejectedCandidates(input.rejected ?? []),
      }),
    },
  ];
  if (input.design !== undefined) {
    artifacts.push({ path: DIAGNOSTICS_DESIGN_FILE, text: toJson({ design: input.design }) });
  }
  if (input.testSuite !== undefined) {
    artifacts.push({ path: DIAGNOSTICS_TEST_SUITE_FILE, text: toJson({ suite: input.testSuite }) });
  }
  if (input.mappings !== undefined) {
    artifacts.push({ path: DIAGNOSTICS_MAPPINGS_FILE, text: toJson({ mappings: input.mappings }) });
  }
  if (input.declarations !== undefined && input.declarations.length > 0) {
    artifacts.push({ path: DIAGNOSTICS_DECLARATION_FILE, text: toJson({ declarations: input.declarations }) });
  }
  if (input.staticChecks !== undefined && input.staticChecks.length > 0) {
    artifacts.push({ path: DIAGNOSTICS_STATIC_CHECK_FILE, text: toJson({ checks: input.staticChecks }) });
  }
  artifacts.push(...buildRejectedCandidateFiles(input.rejected ?? []));
  return artifacts;
}

/** 納品物の 1 つのファイル（UTF-8 の文字列）。`path` は納品物の直下からの相対パス（`/` 区切り） */
export interface BundleArtifact {
  readonly path: string;
  readonly text: string;
}

/** 書けなかった要件の 1 件（Issue #326）。② の設計が出した `unwritable` を、要件の文と引用で包む。
 * **要件 ID・要件の文・原文の引用・書けない部分**（F-2）。
 */
export interface UnwritableRequirement {
  /** 要件 ID（① の一覧のもの） */
  readonly requirementId: string;
  /** 要件の文（① の一覧のもの） */
  readonly text: string;
  /** 原文の引用（① の一覧のもの） */
  readonly quote: string;
  /** 書けない部分（② の `unwritable` の各行） */
  readonly unwritable: readonly string[];
}

/** 申告の仕分け・裏付けの判定 1 件の記録（Issue #332。依頼文の全文は残さない。S-8） */
export interface BundleTriageJudgment {
  /** 問いの ID */
  readonly question_id: string;
  /** 答え（仕分けのラベル、または裏付けの判定） */
  readonly answer: string;
  /** 確信度（返せない adapter では null＝不明） */
  readonly confidence: number | null;
  /** 答えたモデルの版の ID */
  readonly model: string;
  /** 答えた adapter（jev・llm・fake） */
  readonly answered_by: string;
}

/** 落とした申告 1 件（曖昧さ・問題ではない。Issue #332） */
export interface BundleDroppedClaim {
  readonly requirement_id: string;
  readonly part: string;
  readonly label: string;
  readonly reason: string;
}

/** 書けなかった要件の一覧（`artifacts/unwritable.json`）。宣言の版に結び付ける（§4・Issue #326・#332） */
export interface BundleUnwritable {
  /** 設計の対象にした宣言（原文）の UTF-8 バイト列の SHA-256 */
  readonly declaration_sha256: string;
  readonly unwritable: readonly UnwritableRequirement[];
  /** 申告の仕分けと裏付けの判定の記録（問いの ID・答え・確信度・答えたモデルの版。Issue #332） */
  readonly triage: readonly BundleTriageJudgment[];
  /** 印つきで残した要件 ID（裏付けが「書いていない」・確信度が閾値未満。Issue #332） */
  readonly marked_requirements: readonly string[];
  /** 問題ではない・曖昧さとして落とした申告（記録。Issue #332） */
  readonly dropped: readonly BundleDroppedClaim[];
}

/**
 * 部分案になった理由（`artifacts/verification.json` の中。§1.4・Issue #326）。
 *
 * **合格のときは、どれも空で出る**（同じ欄を、合否にかかわらず常に出す——読む側が欄の有無で分岐しない）。
 * 数を数える欄は、**数と ID** を分けて持つ（どの要件・どの試験が理由かを追える）。
 */
export interface BundlePartialReasons {
  /** 書けない要件（② の `unwritable`）。数と要件 ID */
  readonly unwritable_requirements: {
    readonly count: number;
    readonly requirement_ids: readonly string[];
  };
  /** 未解決（⑦ に渡した数。期待の裁定の未解決と、最終版の試験の未解決の和。同じ試験 ID は 1 つ） */
  readonly unresolved: {
    readonly count: number;
    readonly ids: readonly string[];
  };
  /** 決めずに残した重大な曖昧さ（① の `unresolved`） */
  readonly ambiguities: readonly string[];
  /** 未解決の試験（⑤b）。試験 ID と、未解決の理由 */
  readonly unresolved_tests: readonly {
    readonly test_id: string;
    readonly detail: string;
  }[];
  /** 対応表の落ち（⑤a）。要件 ID と、落ちの理由 */
  readonly correspondence_misses: readonly {
    readonly requirement_id: string;
    readonly detail: string;
  }[];
}

/**
 * 構造の検査 1 件の記録（`artifacts/verification.json` の中。§1.3・Issue #387）。**試験 ID・要件 ID・
 * 検査の中身・結果**を持ち、**合格（`pass`）・不一致（`mismatch`）・未解決（`unresolved`）を区別する**。
 */
export interface BundleStructuralCheck {
  readonly test_id: string;
  readonly requirement_id: string;
  /** 検査の中身（`field-type`・`action-kind`・`action-unconditioned`・`view-shows`・`aggregate-no-period`） */
  readonly check: StructuralAssertionKind;
  readonly result: StructuralCheckResult;
  /** 結果の理由（人向けの短い説明） */
  readonly detail: string;
}

/** 検証の結果（`artifacts/verification.json`）。**最後の宣言のバイト列の SHA-256** を中に書く（§4・R-3） */
export interface BundleVerification {
  /** 完成した宣言（原文）の UTF-8 バイト列の SHA-256 */
  readonly declaration_sha256: string;
  /**
   * 確定した仕様（`plan.json`）の SHA-256（正規化して計算したもの。§4・Issue #334）。**確定した仕様が
   * あるときだけ**入る。manifest の同じ名前の欄と**同じ値**で、門（#335）が `plan.json` と照合する。
   */
  readonly plan_sha256?: string;
  /** ⑦ の合否 */
  readonly outcome: Outcome;
  readonly correspondence_misses: number;
  readonly test_mismatches: number;
  readonly test_unresolved: number;
  /** 実行しなかった検査（`correspondence`・`run-tests`）。**空でなければ合格にしない**（§1.4） */
  readonly unexecuted_inspections: readonly string[];
  /** 構造の検査の 1 件ごとの記録（合格・不一致・未解決。§1.3・Issue #387）。検査が無ければ空で出る */
  readonly structural_checks: readonly BundleStructuralCheck[];
  /** 部分案になった理由（Issue #326）。合格のときは空で出る */
  readonly partial_reasons: BundlePartialReasons;
  /**
   * 材料の状態の一覧（設計・固定した試験・提出された対応・候補の宣言・⑤a・⑤b・評価。Issue #417）。
   * **試験 ID・文言・署名の文字列は入れない**——状態と版だけを持つ。
   */
  readonly materials: readonly BundleMaterialEntry[];
  /** 版ごとの評価の行（Issue #417）。**試験 ID・文言は入れない**——件数だけを持つ */
  readonly evaluations: readonly BundleEvaluationRow[];
  /** 回数（評価・③ の初回・③ の出し直し・⑤a の生成・⑥ の実行。Issue #417） */
  readonly counts: BundleMaterialCounts;
}

/** ⑧ が受け取るもの（⑦ までの結果と、宣言・要約・記録） */
export interface BundleInput {
  readonly runId: string;
  readonly storageUnit: string;
  readonly artifactLevel: string;
  readonly declaration: Declaration;
  /** 宣言（原文）の UTF-8 バイト列の SHA-256（流し直した最後の版のもの。§4） */
  readonly declarationSha256: string;
  readonly outcome: Outcome;
  /** 要約（記録の欄と、判定の呼び出しの数・費用を持つ。Issue #359） */
  readonly summary: BundleSummary;
  readonly requirements: RequirementList;
  /** 書けなかった要件の一覧（② の `unwritable` に、要件の文と引用を添えたもの。Issue #326） */
  readonly unwritable: readonly UnwritableRequirement[];
  /** 申告の仕分けと裏付けの判定の記録（Issue #332。無ければ空で出る） */
  readonly triage?: readonly BundleTriageJudgment[];
  /** 印つきで残した要件 ID（Issue #332） */
  readonly markedRequirements?: readonly string[];
  /** 落とした申告（Issue #332） */
  readonly dropped?: readonly BundleDroppedClaim[];
  readonly correspondence: CorrespondenceResult | null;
  readonly testRun: TestRunResult | null;
  readonly disputes: readonly { readonly testId: string; readonly quote: string }[];
  readonly rejected: readonly RejectedDispute[];
  readonly arbitration: ArbitrationResult;
  /** 検証の道具の識別（§4。プロダクト内の工場では spec-engine と factory の版を入れる。U-B） */
  readonly builder: string;
  readonly verificationProfile: string;
  readonly specEngineVersion: string;
  readonly factoryVersion: string;
  /**
   * 確定した仕様（`plan.json`。§4・Issue #334）。**無くてよい**（今の納品物と互換）。あるときは、
   * `artifacts/plan.json` として納品物に入れ、manifest と検証の結果に同じ仕様の SHA-256 を記録する。
   */
  readonly plan?: ConfirmedPlan;
  /** 受理した設計（② の役割 ID の表と要件ごとの設計）。納品物の設計のファイルに入れる（Issue #417） */
  readonly design: DesignResult;
  /** 受理した固定した試験の組（②' の分類込み。棄却で外す前）。納品物の試験のファイルに入れる（Issue #417） */
  readonly testSuite: TestSuite;
  /** 最終版の提出された対応（③）。納品物の対応のファイルに入れる（Issue #417） */
  readonly mappings: readonly RoleNameMapping[];
  /** 材料の状態の一覧（検証の結果に入れる。Issue #417） */
  readonly materials: readonly BundleMaterialEntry[];
  /** 版ごとの評価の行（検証の結果に入れる。Issue #417） */
  readonly evaluations: readonly BundleEvaluationRow[];
  /**
   * 追加の成果物（v1.1α の `name-table.json` など。`07-architecture-v1.1a.md` §1.4）。**成果物の置き場所
   * （`artifacts/`）の下**に置き、v1 の成果物の**後ろ**に並べて manifest の `files` に載せる。v1 の成果物と
   * 同じ path・置き場所の外の path・重複した path は例外で断る（黙って上書きしない）。省くか空なら v1 のまま。
   */
  readonly extraArtifacts?: readonly BundleArtifact[];
}

/**
 * 追加の成果物の path を確かめる（v1.1α。§1.4）。成果物の置き場所の下にあり、v1 の成果物とも、ほかの
 * 追加の成果物とも重ならないこと。合わなければ例外で断る（黙って上書きしない）。
 */
function checkExtraArtifacts(base: readonly BundleArtifact[], extras: readonly BundleArtifact[]): void {
  const taken = new Set(base.map((artifact) => artifact.path));
  for (const extra of extras) {
    if (!extra.path.startsWith(`${ARTIFACTS_DIR}/`) || extra.path.length === ARTIFACTS_DIR.length + 1) {
      throw new Error(`追加の成果物 ${extra.path} は成果物の置き場所（${ARTIFACTS_DIR}/）の下にない`);
    }
    if (taken.has(extra.path)) {
      throw new Error(`追加の成果物 ${extra.path} は、既にある成果物と同じ path である（上書きしない）`);
    }
    taken.add(extra.path);
  }
}

/** 組み立てた納品物（`bundle-manifest.json` を含む。書くのは呼ぶ側） */
export interface AssembledBundle {
  /** `artifacts/` の下のファイルと、その他のファイル（`bundle-manifest.json` を除く） */
  readonly artifacts: readonly BundleArtifact[];
  /** 読んだ／書いた manifest */
  readonly manifest: BundleManifest;
  /** manifest（`bundle-manifest.json`）の本文 */
  readonly manifestText: string;
  /** 要約（appspec-schema の wire に、判定の呼び出しの数・費用を足したもの） */
  readonly summary: BundleSummary;
  readonly declarationSha256: string;
  /**
   * 確定した仕様（`plan.json`）の SHA-256（正規化して計算したもの）。**確定した仕様が無ければ `null`**。
   * manifest と検証の結果に載せた値と同じである（§4・Issue #334）。
   */
  readonly planSha256: string | null;
}

/** 決まった字下げで JSON にする（同じ入力からは同じバイト列。末尾に改行 1 つ） */
function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 納品物を組み立てる（§4）。
 *
 * `files` は `artifacts/` の各ファイルの SHA-256 と大きさである（manifest 自身は含めない——
 * control-plane の照合と同じ約束）。`instrument.binary_sha256` は、使った spec-engine と factory の版を
 * 結び付けた値である（欄の名前と意味の改名は U-B）。
 */
export async function assembleBundle(input: BundleInput): Promise<AssembledBundle> {
  const unexecuted: string[] = [];
  if (input.correspondence === null) unexecuted.push("correspondence");
  if (input.testRun === null) unexecuted.push("run-tests");

  // 確定した仕様（`plan.json`）の SHA-256。**無い納品物は null**（今の納品物と互換。§4・Issue #334）
  const planSha256 = input.plan === undefined ? null : await planDigest(input.plan);

  // 未解決の ID は、⑦ に渡した数え方と同じにする（期待の裁定の未解決と、最終版の試験の未解決の和。重複は 1 つ）
  const unresolvedTests = input.testRun?.unresolved ?? [];
  const unresolvedIds = [
    ...new Set([...input.arbitration.unresolved, ...unresolvedTests.map((entry) => entry.testId)]),
  ];
  const unwritableIds = input.unwritable.map((entry) => entry.requirementId);
  const correspondenceMisses = input.correspondence?.misses ?? [];
  const partialReasons: BundlePartialReasons = {
    unwritable_requirements: { count: unwritableIds.length, requirement_ids: unwritableIds },
    unresolved: { count: unresolvedIds.length, ids: unresolvedIds },
    ambiguities: input.requirements.unresolved,
    unresolved_tests: unresolvedTests.map((entry) => ({ test_id: entry.testId, detail: entry.detail })),
    correspondence_misses: correspondenceMisses.map((entry) => ({
      requirement_id: entry.requirementId,
      detail: entry.detail,
    })),
  };

  // 構造の検査の 1 件ごとの記録（試験 ID・要件 ID・検査の中身・結果）。§1.3・Issue #387
  const structuralChecks: readonly BundleStructuralCheck[] = (input.testRun?.structural ?? []).map(
    (entry) => ({
      test_id: entry.testId,
      requirement_id: entry.requirementId,
      check: entry.check,
      result: entry.result,
      detail: entry.detail,
    }),
  );

  const verification: BundleVerification = {
    declaration_sha256: input.declarationSha256,
    ...(planSha256 === null ? {} : { plan_sha256: planSha256 }),
    outcome: input.outcome,
    correspondence_misses: correspondenceMisses.length,
    test_mismatches: input.testRun?.mismatches.length ?? 0,
    test_unresolved: unresolvedTests.length,
    unexecuted_inspections: unexecuted,
    structural_checks: structuralChecks,
    partial_reasons: partialReasons,
    materials: input.materials,
    evaluations: input.evaluations,
    counts: materialCounts(input.summary.stages),
  };

  const unwritable: BundleUnwritable = {
    declaration_sha256: input.declarationSha256,
    unwritable: input.unwritable,
    triage: input.triage ?? [],
    marked_requirements: input.markedRequirements ?? [],
    dropped: input.dropped ?? [],
  };

  // 受理した材料（設計・固定した試験・提出された対応）のファイル（§4・Issue #417）。**各ファイルの中に
  // 最終の宣言のバイト列の SHA-256 を書く**（R-3）。固定した試験のファイルには、**棄却で外した試験の ID**
  // も載せる（試験の組は棄却で外す前のものをそのまま残す——材料を後から作り直さない）。
  const designMaterial = { declaration_sha256: input.declarationSha256, design: input.design };
  const testSuiteMaterial = {
    declaration_sha256: input.declarationSha256,
    suite: input.testSuite,
    overturned_test_ids: input.arbitration.overturned.map((entry) => entry.testId),
  };
  const mappingsMaterial = { declaration_sha256: input.declarationSha256, mappings: input.mappings };

  const v1Artifacts: readonly BundleArtifact[] = [
    { path: DECLARATION_FILE, text: input.declaration.source },
    ...(input.plan === undefined ? [] : [{ path: PLAN_FILE, text: toJson(input.plan) }]),
    { path: SUMMARY_FILE, text: toJson(input.summary) },
    { path: REQUIREMENTS_FILE, text: toJson(input.requirements) },
    { path: UNWRITABLE_FILE, text: toJson(unwritable) },
    { path: CORRESPONDENCE_FILE, text: toJson(input.correspondence) },
    { path: TESTS_FILE, text: toJson(input.testRun) },
    { path: DESIGN_FILE, text: toJson(designMaterial) },
    { path: TEST_SUITE_FILE, text: toJson(testSuiteMaterial) },
    { path: MAPPINGS_FILE, text: toJson(mappingsMaterial) },
    { path: DISPUTES_FILE, text: toJson({ disputes: input.disputes, rejected: input.rejected }) },
    { path: ARBITRATION_FILE, text: toJson(input.arbitration) },
    { path: VERIFICATION_FILE, text: toJson(verification) },
  ];
  // 追加の成果物は v1 の成果物の後ろに並べる（v1.1α。§1.4）。省くか空なら v1 の並びのまま
  const extraArtifacts = input.extraArtifacts ?? [];
  checkExtraArtifacts(v1Artifacts, extraArtifacts);
  const artifacts: readonly BundleArtifact[] =
    extraArtifacts.length === 0
      ? v1Artifacts
      : [...v1Artifacts, ...extraArtifacts.map((artifact) => ({ path: artifact.path, text: artifact.text }))];

  const files: BundleManifestFile[] = [];
  for (const artifact of artifacts) {
    files.push({
      path: artifact.path,
      sha256: await sha256Hex(artifact.text),
      size_bytes: utf8ByteLength(artifact.text),
    });
  }

  // 確定した仕様があるときだけ、manifest の最上位に `plan_sha256` を載せる（門（#335）が照合する）。
  // `BundleManifest` の型（appspec-schema）には欄が無い（納品物の版の型はそのまま）ので、載せるときだけ足す
  const manifest = {
    schema_version: BUNDLE_MANIFEST_SCHEMA_VERSION,
    storage_unit: input.storageUnit,
    source_run: input.runId,
    artifact_level: input.artifactLevel,
    expected_verdict: input.outcome.verdict,
    ...(planSha256 === null ? {} : { [PLAN_SHA256_FIELD]: planSha256 }),
    instrument: {
      binary_sha256: await sha256Hex(
        `${input.builder}\n${input.factoryVersion}\n${input.specEngineVersion}`,
      ),
      verification_profile: input.verificationProfile,
    },
    files,
  } as BundleManifest;

  return {
    artifacts,
    manifest,
    manifestText: toJson(manifest),
    summary: input.summary,
    declarationSha256: input.declarationSha256,
    planSha256,
  };
}

/** 納品物のすべてのファイル（`artifacts/` の各ファイルと、`bundle-manifest.json`）。書く順もこの順 */
export function bundleFiles(bundle: AssembledBundle): readonly BundleArtifact[] {
  return [...bundle.artifacts, { path: BUNDLE_MANIFEST_FILE, text: bundle.manifestText }];
}
