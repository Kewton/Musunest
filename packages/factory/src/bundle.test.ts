// 納品物（bundle.ts）の unit テスト（02 §1・§4・F-10・R-3）。
//
// ここで固定したいのは 6 つ。
//   1. manifest の `files` の SHA-256 と大きさが、実際のファイル（UTF-8 のバイト列）と一致すること
//   2. **検証の結果に書いた SHA-256 が、最後の宣言のバイト列の SHA-256 と一致**すること（R-3）
//   3. 要約が appspec-schema の wire の型に合うこと
//   4. manifest 自身（`bundle-manifest.json`）は `files` に数えないこと（control-plane の照合と同じ約束）
//   5. 実行しなかった検査（⑤a・⑤b）を `unexecuted_inspections` に挙げること
//   6. 書けなかった要件の一覧（要件 ID・要件の文・引用・書けない部分）と、部分案になった理由を出すこと
//      （合格のときは空。Issue #326）
import { BUNDLE_MANIFEST_SCHEMA_VERSION, acceptsHeadlessSummaryWire } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST_FILE,
  UNWRITABLE_FILE,
  VERIFICATION_FILE,
  assembleBundle,
  bundleFiles,
  type BundleInput,
  type BundlePartialReasons,
  type BundleUnwritable,
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
  unwritable: [],
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

// ── 書けなかった要件の一覧と、部分案になった理由（02 §1.4・§4・Issue #326）──

/** 書けなかった要件（R-1 と R-4 の 2 件。要件の文と引用つき） */
const UNWRITABLE = [
  { requirementId: "R-1", text: "記録できる", quote: "タスクを記録する", unwritable: ["記録の並べ替えは書けない"] },
  { requirementId: "R-4", text: "印を出せる", quote: "印を出す", unwritable: ["印の色分けは書けない"] },
];

describe("書けなかった要件の一覧と、部分案になった理由（02 §1.4・§4・Issue #326）", () => {
  it("書けなかった要件を出し、manifest に載せ、宣言の SHA-256 に結び付ける", async () => {
    const declared = await sha256Hex(declaration.source);
    const bundle = await assembleBundle(
      input({
        unwritable: UNWRITABLE,
        outcome: { result: "partial", verdict: "partial" },
        declarationSha256: declared,
      }),
    );

    // 一覧のファイルに出る（要件 ID・要件の文・引用・書けない部分）
    const text = findText(bundle.artifacts, UNWRITABLE_FILE);
    const list = JSON.parse(text) as BundleUnwritable;
    expect(list.declaration_sha256).toBe(declared);
    expect(list.unwritable).toEqual(UNWRITABLE);

    // manifest に載る（SHA-256 と大きさが、そのファイルのバイト列と一致する）
    const entry = bundle.manifest.files.find((file) => file.path === UNWRITABLE_FILE);
    expect(entry?.sha256).toBe(await sha256Hex(text));
    expect(entry?.size_bytes).toBe(byteLength(text));

    // 検証の結果にも、書けない要件の数と ID が出る
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.partial_reasons.unwritable_requirements).toEqual({
      count: 2,
      requirement_ids: ["R-1", "R-4"],
    });
  });

  it("部分案の理由（書けない要件・未解決・曖昧さ・未解決の試験・対応表の落ち）を出す", async () => {
    const bundle = await assembleBundle(
      input({
        unwritable: UNWRITABLE,
        outcome: { result: "partial", verdict: "partial" },
        requirements: { ...REQUIREMENTS, unresolved: ["決めずに残した重大な曖昧さ"] },
        correspondence: {
          entries: CORRESPONDENCE.entries,
          misses: [{ requirementId: "R-2", detail: "計算 total は画面から辿れない" }],
        },
        testRun: { mismatches: [], unresolved: [{ testId: "t9", detail: "入力の型は確かめられない" }] },
        arbitration: { upheld: [], overturned: [], unresolved: ["t8"] },
      }),
    );
    const reasons: BundlePartialReasons = (
      JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification
    ).partial_reasons;
    expect(reasons.unwritable_requirements).toEqual({ count: 2, requirement_ids: ["R-1", "R-4"] });
    expect(reasons.unresolved).toEqual({ count: 2, ids: ["t8", "t9"] });
    expect(reasons.ambiguities).toEqual(["決めずに残した重大な曖昧さ"]);
    expect(reasons.unresolved_tests).toEqual([{ test_id: "t9", detail: "入力の型は確かめられない" }]);
    expect(reasons.correspondence_misses).toEqual([
      { requirement_id: "R-2", detail: "計算 total は画面から辿れない" },
    ]);
  });

  it("合格のときは、部分案の理由を空で出す（欄は常にある）", async () => {
    const bundle = await assembleBundle(input());
    const reasons: BundlePartialReasons = (
      JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification
    ).partial_reasons;
    expect(reasons).toEqual({
      unwritable_requirements: { count: 0, requirement_ids: [] },
      unresolved: { count: 0, ids: [] },
      ambiguities: [],
      unresolved_tests: [],
      correspondence_misses: [],
    });
  });

  it("申告の仕分け・裏付けの判定の記録、印つきの要件、落とした申告を出す（Issue #332）", async () => {
    const bundle = await assembleBundle(
      input({
        unwritable: UNWRITABLE,
        outcome: { result: "partial", verdict: "partial" },
        triage: [
          {
            question_id: "triage:R-1:0",
            answer: "vocabulary-hole",
            confidence: 0.9,
            model: "gpt-test",
            answered_by: "llm",
          },
          { question_id: "support:R-1:0", answer: "not-stated", confidence: null, model: "gpt-test", answered_by: "llm" },
        ],
        markedRequirements: ["R-1"],
        dropped: [{ requirement_id: "R-2", part: "曖昧さのメモ", label: "ambiguity", reason: "理由" }],
      }),
    );
    const list = JSON.parse(findText(bundle.artifacts, UNWRITABLE_FILE)) as BundleUnwritable;
    expect(list.triage).toEqual([
      { question_id: "triage:R-1:0", answer: "vocabulary-hole", confidence: 0.9, model: "gpt-test", answered_by: "llm" },
      { question_id: "support:R-1:0", answer: "not-stated", confidence: null, model: "gpt-test", answered_by: "llm" },
    ]);
    expect(list.marked_requirements).toEqual(["R-1"]);
    expect(list.dropped).toEqual([{ requirement_id: "R-2", part: "曖昧さのメモ", label: "ambiguity", reason: "理由" }]);
  });

  it("仕分けを回さないときは、判定の記録も落とした申告も空で出す（欄は常にある）", async () => {
    const bundle = await assembleBundle(input());
    const list = JSON.parse(findText(bundle.artifacts, UNWRITABLE_FILE)) as BundleUnwritable;
    expect(list.triage).toEqual([]);
    expect(list.marked_requirements).toEqual([]);
    expect(list.dropped).toEqual([]);
  });
});
