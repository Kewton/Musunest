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
import type { Outcome } from "./outcome.js";
import type {
  ArbitrationResult,
  CorrespondenceResult,
  Declaration,
  RejectedDispute,
  RequirementList,
  TestRunResult,
} from "./pipeline.js";
import type { Summary } from "./record.js";
import { utf8ByteLength } from "./stages/write.js";

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
  /** 部分案になった理由（Issue #326）。合格のときは空で出る */
  readonly partial_reasons: BundlePartialReasons;
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
  readonly summary: Summary;
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
}

/** 組み立てた納品物（`bundle-manifest.json` を含む。書くのは呼ぶ側） */
export interface AssembledBundle {
  /** `artifacts/` の下のファイルと、その他のファイル（`bundle-manifest.json` を除く） */
  readonly artifacts: readonly BundleArtifact[];
  /** 読んだ／書いた manifest */
  readonly manifest: BundleManifest;
  /** manifest（`bundle-manifest.json`）の本文 */
  readonly manifestText: string;
  /** 要約（appspec-schema の wire） */
  readonly summary: Summary;
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

  const verification: BundleVerification = {
    declaration_sha256: input.declarationSha256,
    ...(planSha256 === null ? {} : { plan_sha256: planSha256 }),
    outcome: input.outcome,
    correspondence_misses: correspondenceMisses.length,
    test_mismatches: input.testRun?.mismatches.length ?? 0,
    test_unresolved: unresolvedTests.length,
    unexecuted_inspections: unexecuted,
    partial_reasons: partialReasons,
  };

  const unwritable: BundleUnwritable = {
    declaration_sha256: input.declarationSha256,
    unwritable: input.unwritable,
    triage: input.triage ?? [],
    marked_requirements: input.markedRequirements ?? [],
    dropped: input.dropped ?? [],
  };

  const artifacts: readonly BundleArtifact[] = [
    { path: DECLARATION_FILE, text: input.declaration.source },
    ...(input.plan === undefined ? [] : [{ path: PLAN_FILE, text: toJson(input.plan) }]),
    { path: SUMMARY_FILE, text: toJson(input.summary) },
    { path: REQUIREMENTS_FILE, text: toJson(input.requirements) },
    { path: UNWRITABLE_FILE, text: toJson(unwritable) },
    { path: CORRESPONDENCE_FILE, text: toJson(input.correspondence) },
    { path: TESTS_FILE, text: toJson(input.testRun) },
    { path: DISPUTES_FILE, text: toJson({ disputes: input.disputes, rejected: input.rejected }) },
    { path: ARBITRATION_FILE, text: toJson(input.arbitration) },
    { path: VERIFICATION_FILE, text: toJson(verification) },
  ];

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
