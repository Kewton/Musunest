// 納品物（bundle.ts）の unit テスト（02 §1・§4・F-10・R-3）。
//
// ここで固定したいのは 5 つ。
//   1. manifest の `files` の SHA-256 と大きさが、実際のファイル（UTF-8 のバイト列）と一致すること
//   2. **検証の結果に書いた SHA-256 が、最後の宣言のバイト列の SHA-256 と一致**すること（R-3）
//   3. 要約が appspec-schema の wire の型に合うこと
//   4. manifest 自身（`bundle-manifest.json`）は `files` に数えないこと（control-plane の照合と同じ約束）
//   5. 実行しなかった検査（⑤a・⑤b）を `unexecuted_inspections` に挙げること
import { BUNDLE_MANIFEST_SCHEMA_VERSION, acceptsHeadlessSummaryWire } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST_FILE,
  VERIFICATION_FILE,
  assembleBundle,
  bundleFiles,
  type BundleInput,
  type BundleVerification,
} from "./bundle.js";
import type { CorrespondenceResult, Declaration, RequirementList } from "./pipeline.js";
import { buildSummary, type RunRecord } from "./record.js";
import { DECLARATION_SOURCE } from "./__tests__/run.js";

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

const REQUIREMENTS: RequirementList = {
  requirements: [{ id: "R-1", text: "記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } }],
  decisions: [],
  unresolved: [],
};

const CORRESPONDENCE: CorrespondenceResult = {
  entries: [{ requirementId: "R-1", locations: [{ kind: "computation", entity: "record", name: "total" }] }],
  misses: [],
};

const SUMMARY = buildSummary(
  {
    builder: "musunest-factory",
    model: "gpt-test",
    effort: "high",
    prompt_version: "v1",
    contract_version: "v0.2",
    spec_engine_version: "0.0.0",
    factory_version: "0.0.0",
    stages: [],
    arbitration: { upheld: 0, overturned: 0, undecidable: 0 },
    budget_remaining_usd: 0.1,
    missing_usage_calls: 0,
    failure: null,
  } satisfies RunRecord,
  {
    run_id: "run-1",
    verdict: "full",
    assurance: "full",
    duration_secs: 0,
    provider_cost_usd: 0,
    stop_class: "completed",
    exit_code: 0,
  },
);

const declaration: Declaration = { source: DECLARATION_SOURCE };

const input = (overrides: Partial<BundleInput> = {}): BundleInput => ({
  runId: "run-1",
  storageUnit: "test-unit",
  artifactLevel: "L2",
  declaration,
  declarationSha256: "declared-sha",
  outcome: { result: "pass", verdict: "full" },
  summary: SUMMARY,
  requirements: REQUIREMENTS,
  correspondence: CORRESPONDENCE,
  testRun: { mismatches: [], unresolved: [] },
  disputes: [{ testId: "t1", quote: "タスクを記録する" }],
  rejected: [],
  arbitration: { upheld: ["t1"], overturned: [], unresolved: [] },
  builder: "musunest-factory",
  verificationProfile: "musunest-factory/l2",
  specEngineVersion: "0.0.0",
  factoryVersion: "0.0.0",
  ...overrides,
});

const findText = (artifacts: readonly { path: string; text: string }[], path: string): string => {
  const found = artifacts.find((artifact) => artifact.path === path);
  if (found === undefined) throw new Error(`無い: ${path}`);
  return found.text;
};

describe("⑧ 納品物（02 §4・F-10）", () => {
  it("manifest の版・検証の結果の verdict", async () => {
    const bundle = await assembleBundle(input());
    expect(bundle.manifest.schema_version).toBe(BUNDLE_MANIFEST_SCHEMA_VERSION);
    expect(bundle.manifest.expected_verdict).toBe("full");
    expect(bundle.manifest.artifact_level).toBe("L2");
    expect(bundle.manifest.source_run).toBe("run-1");
    expect(bundle.manifest.instrument.verification_profile).toBe("musunest-factory/l2");
  });

  it("manifest の SHA-256 と大きさが、ファイルと一致する", async () => {
    const bundle = await assembleBundle(input());
    expect(bundle.manifest.files.length).toBe(bundle.artifacts.length);
    for (const entry of bundle.manifest.files) {
      const text = findText(bundle.artifacts, entry.path);
      expect(entry.sha256).toBe(await sha256Hex(text));
      expect(entry.size_bytes).toBe(byteLength(text));
    }
  });

  it("検証の結果の SHA-256 が、最後の宣言のバイト列の SHA-256 と一致する", async () => {
    const expected = await sha256Hex(declaration.source);
    const bundle = await assembleBundle(input({ declarationSha256: expected }));
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.declaration_sha256).toBe(expected);
    expect(bundle.declarationSha256).toBe(expected);
    // 宣言のファイルのバイト列の SHA-256 も、同じ値になる
    expect(await sha256Hex(findText(bundle.artifacts, "artifacts/app.spec.yaml"))).toBe(expected);
  });

  it("要約が appspec-schema の wire の型に合う", async () => {
    const bundle = await assembleBundle(input());
    expect(acceptsHeadlessSummaryWire(bundle.summary)).toBe(true);
    expect(acceptsHeadlessSummaryWire(JSON.parse(findText(bundle.artifacts, "artifacts/summary.json")))).toBe(true);
  });

  it("manifest 自身は `files` に数えず、書くときは bundleFiles が含める", async () => {
    const bundle = await assembleBundle(input());
    expect(bundle.manifest.files.map((entry) => entry.path)).not.toContain(BUNDLE_MANIFEST_FILE);
    const written = bundleFiles(bundle);
    expect(written.map((file) => file.path)).toContain(BUNDLE_MANIFEST_FILE);
    expect(written).toHaveLength(bundle.artifacts.length + 1);
  });

  it("実行しなかった検査を、検証の結果に挙げる（§1.4）", async () => {
    const bundle = await assembleBundle(input({ correspondence: null, testRun: null }));
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.unexecuted_inspections).toEqual(["correspondence", "run-tests"]);
  });
});
