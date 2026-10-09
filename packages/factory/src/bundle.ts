// ⑧ 納品物にする（02-architecture.md §1・§3.2・§4・F-10）。
//
// CommandAgent と同じ形の bundle を組み立てる（§4・F-10）。形の正本は appspec-schema の納品物の入口
// （`@musunest/appspec-schema` の delivery.ts）。
//
//   - 納品物の直下の JSON（`bundle-manifest.json`）… `files` の SHA-256 と大きさ・`instrument`・
//     `expected_verdict` など
//   - `artifacts/` の下のファイル … 宣言（`app.spec.yaml`）・要約・要件の一覧・対応表・試験の結果・
//     申告・裁定の記録・検証の結果
//   - 検証の結果（`artifacts/verification.json`）に、**最後の宣言のバイト列の SHA-256** を書く（§4・R-3）
//
// ファイルはすべて UTF-8 の文字列として持つ（UTF-8 にすればこの文字列のバイト列になる）。SHA-256 は
// spec-engine の `sha256Hex` を使う（Worker でも Node でも動く）。**この file はファイルも環境変数も扱わない**
// ——書くのは手元の入口（cli.ts）だけである。
import {
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  type BundleManifest,
  type BundleManifestFile,
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

/** 納品物の 1 つのファイル（UTF-8 の文字列）。`path` は納品物の直下からの相対パス（`/` 区切り） */
export interface BundleArtifact {
  readonly path: string;
  readonly text: string;
}

/** 検証の結果（`artifacts/verification.json`）。**最後の宣言のバイト列の SHA-256** を中に書く（§4・R-3） */
export interface BundleVerification {
  /** 完成した宣言（原文）の UTF-8 バイト列の SHA-256 */
  readonly declaration_sha256: string;
  /** ⑦ の合否 */
  readonly outcome: Outcome;
  readonly correspondence_misses: number;
  readonly test_mismatches: number;
  readonly test_unresolved: number;
  /** 実行しなかった検査（`correspondence`・`run-tests`）。**空でなければ合格にしない**（§1.4） */
  readonly unexecuted_inspections: readonly string[];
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

  const verification: BundleVerification = {
    declaration_sha256: input.declarationSha256,
    outcome: input.outcome,
    correspondence_misses: input.correspondence?.misses.length ?? 0,
    test_mismatches: input.testRun?.mismatches.length ?? 0,
    test_unresolved: input.testRun?.unresolved.length ?? 0,
    unexecuted_inspections: unexecuted,
  };

  const artifacts: readonly BundleArtifact[] = [
    { path: DECLARATION_FILE, text: input.declaration.source },
    { path: SUMMARY_FILE, text: toJson(input.summary) },
    { path: REQUIREMENTS_FILE, text: toJson(input.requirements) },
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

  const manifest: BundleManifest = {
    schema_version: BUNDLE_MANIFEST_SCHEMA_VERSION,
    storage_unit: input.storageUnit,
    source_run: input.runId,
    artifact_level: input.artifactLevel,
    expected_verdict: input.outcome.verdict,
    instrument: {
      binary_sha256: await sha256Hex(
        `${input.builder}\n${input.factoryVersion}\n${input.specEngineVersion}`,
      ),
      verification_profile: input.verificationProfile,
    },
    files,
  };

  return {
    artifacts,
    manifest,
    manifestText: toJson(manifest),
    summary: input.summary,
    declarationSha256: input.declarationSha256,
  };
}

/** 納品物のすべてのファイル（`artifacts/` の各ファイルと、`bundle-manifest.json`）。書く順もこの順 */
export function bundleFiles(bundle: AssembledBundle): readonly BundleArtifact[] {
  return [...bundle.artifacts, { path: BUNDLE_MANIFEST_FILE, text: bundle.manifestText }];
}
