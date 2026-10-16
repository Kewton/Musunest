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
import { BUNDLE_MANIFEST_SCHEMA_VERSION, acceptsHeadlessSummaryWire, planDigest } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { captureBaseline, type BaselineCapture, type BaselineScenarios } from "./__tests__/baseline-capture.js";
import * as factoryModule from "./index.js";
import { ACCEPTANCE_MATERIAL_WORDS } from "./stages/__tests__/prompt.js";
import {
  ARTIFACTS_DIR,
  BUNDLE_MANIFEST_FILE,
  DESIGN_FILE,
  DIAGNOSTICS_DECLARATION_FILE,
  DIAGNOSTICS_DESIGN_FILE,
  DIAGNOSTICS_LISTING_FILE,
  DIAGNOSTICS_MAPPINGS_FILE,
  DIAGNOSTICS_REJECTED_DESIGN_FILE,
  DIAGNOSTICS_REJECTED_NAME_TABLE_FILE,
  DIAGNOSTICS_REJECTED_TEST_SPEC_FILE,
  DIAGNOSTICS_REJECTED_TEST_SUITE_FILE,
  DIAGNOSTICS_STATIC_CHECK_FILE,
  DIAGNOSTICS_TEST_SUITE_FILE,
  MAPPINGS_FILE,
  MATERIAL_KINDS,
  PLAN_FILE,
  REQUIREMENTS_FILE,
  TEST_SUITE_FILE,
  UNWRITABLE_FILE,
  VERIFICATION_FILE,
  assembleBundle,
  buildDiagnostics,
  buildRejectedCandidateFiles,
  bundleFiles,
  summarizeRejectedCandidates,
  toBundleNatureDiscrepancies,
  type BundleEvaluationRow,
  type BundleInput,
  type BundleJudgeUsage,
  type BundleMaterialEntry,
  type BundleNatureDiscrepancy,
  type BundlePartialReasons,
  type BundleRejectedCandidate,
  type BundleRejectedSummary,
  type BundleSummary,
  type BundleUnwritable,
  type BundleVerification,
} from "./bundle.js";
import {
  requirementsFromPlan,
  type CorrespondenceResult,
  type Declaration,
  type DesignResult,
  type RequirementList,
  type RoleNameMapping,
  type TestSuite,
} from "./pipeline.js";
import { buildSummary, type RunRecord } from "./record.js";
import {
  ADDED_OPEN_ISSUE_TEXT,
  ADDED_QUESTION_TEXT,
  CONFIRMED_PLAN,
  CONFIRMED_PLAN_ADDED,
  DECLARATION_SOURCE,
} from "./__tests__/run.js";

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

const SUMMARY: BundleSummary = {
  ...buildSummary(
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
  ),
  judge: { calls_by_adapter: { jev: 0, llm: 0, fake: 0 }, cost_usd: 0 },
  nature_discrepancies: [],
};

const declaration: Declaration = { source: DECLARATION_SOURCE };

/** 受理した設計（②。Issue #417）の例 */
const DESIGN: DesignResult = {
  roles: [{ roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null }],
  designs: [{ requirementId: "R-1", nature: "ruled", verification: { kind: "fixed-test" }, vocabulary: ["計算"], placement: ["computed"], unwritable: [] }],
};

/** 受理した固定した試験の組（②'。Issue #417）の例 */
const TEST_SUITE: TestSuite = {
  classifications: [{ requirementId: "R-1", nature: "ruled" }],
  tests: [
    {
      id: "t1",
      target: { requirementId: "R-1", kind: "computation", roleId: "record.total" },
      kind: "normal",
      operation: "compute",
      clock: "2026-09-16T12:00:00+09:00",
      input: { amount: 21 },
      referenceData: [],
      expected: { kind: "ok", value: 42 },
    },
  ],
};

/** 提出された対応（③。Issue #417）の例 */
const MAPPINGS: readonly RoleNameMapping[] = [{ roleId: "record.total", name: "total" }];

/** 完走のときの、材料の状態の一覧（Issue #417）の例 */
const MATERIALS: readonly BundleMaterialEntry[] = [
  { material: "design", state: "accepted", version: { stage_index: 1, sha256: "design-sha" } },
  { material: "test_suite", state: "accepted", version: { stage_index: 2, sha256: "suite-sha" } },
  { material: "mappings", state: "accepted", version: { stage_index: 3, sha256: "mappings-sha" } },
  { material: "declaration", state: "candidate", version: { sha256: "declared-sha" }, static_check_passed: true },
  { material: "correspondence", state: "accepted" },
  { material: "test_run", state: "accepted" },
  { material: "evaluation", state: "accepted" },
];

/** 完走のときの、版ごとの評価の行（Issue #417）の例 */
const EVALUATIONS: readonly BundleEvaluationRow[] = [
  {
    declaration_sha256: "declared-sha",
    static_check_passed: true,
    static_check_diagnostics: 0,
    correspondence_misses: 0,
    test_mismatches: 0,
    test_unresolved: 0,
    routes: {},
  },
];

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
  design: DESIGN,
  testSuite: TEST_SUITE,
  mappings: MAPPINGS,
  materials: MATERIALS,
  evaluations: EVALUATIONS,
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

  it("manifest 自身を除く納品物の全ファイルが、files と過不足なく一致する（追加の 3 ファイルを含む。Issue #417）", async () => {
    const bundle = await assembleBundle(input());
    // 納品物のファイルの集合（manifest 自身は含めない）と、manifest の files が同じ並びである
    expect(bundle.manifest.files.map((entry) => entry.path)).toEqual(
      bundle.artifacts.map((artifact) => artifact.path),
    );
    // 追加の 3 ファイル（設計・固定した試験・提出された対応）が入っている
    const paths = bundle.manifest.files.map((entry) => entry.path);
    expect(paths).toContain(DESIGN_FILE);
    expect(paths).toContain(TEST_SUITE_FILE);
    expect(paths).toContain(MAPPINGS_FILE);
    // 各ファイルの中に、**最後の宣言の SHA-256** が書いてある（02 §4。Issue #417）
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    for (const path of [DESIGN_FILE, TEST_SUITE_FILE, MAPPINGS_FILE]) {
      const material = JSON.parse(findText(bundle.artifacts, path)) as { declaration_sha256: string };
      expect(material.declaration_sha256, path).toBe(verification.declaration_sha256);
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

  it("要約に、判定の呼び出しの数（adapter ごと）と費用を残す（Issue #359）", async () => {
    const judge: BundleJudgeUsage = { calls_by_adapter: { jev: 1, llm: 2, fake: 0 }, cost_usd: 0.0004 };
    const bundle = await assembleBundle(input({ summary: { ...SUMMARY, judge } }));
    const summary = JSON.parse(findText(bundle.artifacts, "artifacts/summary.json")) as BundleSummary;
    expect(summary.judge).toEqual(judge);
    expect(bundle.summary.judge).toEqual(judge);
    // wire は知らない欄を足しても受け付ける（additive。Issue #359）
    expect(acceptsHeadlessSummaryWire(summary)).toBe(true);
  });

  it("要約に、種類の食い違いの記録（決め方・確率・判定のモデル・閾値の版）を残す（Issue #373）", async () => {
    const nature_discrepancies = toBundleNatureDiscrepancies([
      {
        requirementId: "R-1",
        design: "existence-only",
        classified: "ruled",
        resolved: "existence-only",
        resolution: "judged",
        probability: 0.82,
        model: "gpt-judge",
        thresholdVersion: "nature-judge-v1",
      },
      { requirementId: "R-2", design: "ruled", classified: "existence-only", resolved: "ruled", resolution: "fallback" },
    ]);
    const bundle = await assembleBundle(input({ summary: { ...SUMMARY, nature_discrepancies } }));
    const summary = JSON.parse(findText(bundle.artifacts, "artifacts/summary.json")) as BundleSummary;
    const expected: readonly BundleNatureDiscrepancy[] = [
      {
        requirement_id: "R-1",
        design: "existence-only",
        classified: "ruled",
        resolved: "existence-only",
        resolution: "judged",
        probability: 0.82,
        model: "gpt-judge",
        threshold_version: "nature-judge-v1",
      },
      { requirement_id: "R-2", design: "ruled", classified: "existence-only", resolved: "ruled", resolution: "fallback" },
    ];
    expect(summary.nature_discrepancies).toEqual(expected);
    expect(bundle.summary.nature_discrepancies).toEqual(expected);
    // wire は知らない欄を足しても受け付ける（additive。Issue #373）
    expect(acceptsHeadlessSummaryWire(summary)).toBe(true);
  });

  it("要約に、固定の前に外した試験の数（任意の欄）を残す。欄の無い記録も読める（Issue #392）", async () => {
    const dropped = { count: 3, by_operation: { compute: 2, screen: 1 } };
    const withDropped = await assembleBundle(input({ summary: { ...SUMMARY, dropped_nonstructural_tests: dropped } }));
    const summary = JSON.parse(findText(withDropped.artifacts, "artifacts/summary.json")) as BundleSummary;
    expect(summary.dropped_nonstructural_tests).toEqual(dropped);
    expect(withDropped.summary.dropped_nonstructural_tests).toEqual(dropped);
    // wire は知らない欄を足しても受け付ける（additive。Issue #392）
    expect(acceptsHeadlessSummaryWire(summary)).toBe(true);

    // 欄が無い記録も読める（欄は任意。0 件のときは省く）
    const withoutDropped = await assembleBundle(input());
    const plain = JSON.parse(findText(withoutDropped.artifacts, "artifacts/summary.json")) as BundleSummary;
    expect(plain.dropped_nonstructural_tests).toBeUndefined();
    expect(acceptsHeadlessSummaryWire(plain)).toBe(true);
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

// ── 確定した仕様（plan.json）を納品物に入れる（§4・Issue #334）────────────────

describe("確定した仕様（plan.json）を納品物に入れる（§4・Issue #334）", () => {
  it("plan.json を入れ、manifest と検証の結果に同じ仕様の SHA-256 を載せる", async () => {
    const bundle = await assembleBundle(input({ plan: CONFIRMED_PLAN }));
    const digest = await planDigest(CONFIRMED_PLAN);

    // plan.json が納品物に入り、manifest の files にも載る
    expect(bundle.artifacts.map((artifact) => artifact.path)).toContain(PLAN_FILE);
    expect(bundle.manifest.files.map((file) => file.path)).toContain(PLAN_FILE);
    expect(bundle.planSha256).toBe(digest);

    // manifest の最上位と、検証の結果に、**同じ仕様の** SHA-256 が載る（門（#335）が照合する）
    expect((bundle.manifest as unknown as Record<string, unknown>)["plan_sha256"]).toBe(digest);
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.plan_sha256).toBe(digest);
  });

  it("確定した仕様が無ければ、plan.json を入れず plan_sha256 も載せない（今の納品物と互換）", async () => {
    const bundle = await assembleBundle(input());
    expect(bundle.artifacts.map((artifact) => artifact.path)).not.toContain(PLAN_FILE);
    expect(bundle.planSha256).toBeNull();
    expect((bundle.manifest as unknown as Record<string, unknown>)["plan_sha256"]).toBeUndefined();
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.plan_sha256).toBeUndefined();
  });
});

// ── 答えから増えた要件の一覧を添えても、plan の本体と SHA は変わらない（§4・Issue #391）──

describe("答えから増えた要件の一覧を添えても、plan の本体と SHA は変わらない（§4・Issue #391）", () => {
  it("plan.json の本体と plan の SHA は入力のまま、要件の一覧だけが添えた文になる", async () => {
    const requirements = requirementsFromPlan(CONFIRMED_PLAN_ADDED);
    const digest = await planDigest(CONFIRMED_PLAN_ADDED);
    const bundle = await assembleBundle(input({ plan: CONFIRMED_PLAN_ADDED, requirements }));

    // plan の本体は入力の仕様のまま（キー順も含めて同じバイト列）。SHA も変わらない
    expect(findText(bundle.artifacts, PLAN_FILE)).toBe(`${JSON.stringify(CONFIRMED_PLAN_ADDED, null, 2)}\n`);
    expect(bundle.planSha256).toBe(digest);
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.plan_sha256).toBe(digest);

    // 要件の一覧だけが、参考の文脈を添えた文になる（原文から来た要件は元のまま）
    const written = JSON.parse(findText(bundle.artifacts, REQUIREMENTS_FILE)) as RequirementList;
    const added = written.requirements.find((requirement) => requirement.id === "R-2");
    expect(added?.text).toContain(ADDED_QUESTION_TEXT);
    expect(added?.text).toContain(ADDED_OPEN_ISSUE_TEXT);
    expect(written.requirements.find((requirement) => requirement.id === "R-1")?.text).toBe("記録できる");
  });
});

// ── 構造の検査の記録を、照合の記録に入れる（02 §1.3・§4・Issue #387）──────────────

describe("構造の検査の記録を、照合の記録に入れる（02 §1.3・§4・Issue #387）", () => {
  const STRUCTURAL_CHECKS = [
    { testId: "sc-1", requirementId: "R-1", check: "field-type", result: "pass", detail: "成り立った" },
    {
      testId: "sc-2",
      requirementId: "R-1",
      check: "action-kind",
      result: "mismatch",
      detail: "操作 add の種類が create（期待 update）",
    },
    {
      testId: "sc-3",
      requirementId: "R-2",
      check: "view-shows",
      result: "unresolved",
      detail: "表示を期待する役割 ID に提出された対応が無い",
    },
  ] as const;

  it("1 件ごとの記録（試験 ID・要件 ID・検査の中身・結果）を出し、合格・不一致・未解決を区別する", async () => {
    const bundle = await assembleBundle(
      input({
        outcome: { result: "partial", verdict: "partial" },
        testRun: { mismatches: [], unresolved: [], structural: STRUCTURAL_CHECKS },
      }),
    );
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.structural_checks).toEqual([
      { test_id: "sc-1", requirement_id: "R-1", check: "field-type", result: "pass", detail: "成り立った" },
      {
        test_id: "sc-2",
        requirement_id: "R-1",
        check: "action-kind",
        result: "mismatch",
        detail: "操作 add の種類が create（期待 update）",
      },
      {
        test_id: "sc-3",
        requirement_id: "R-2",
        check: "view-shows",
        result: "unresolved",
        detail: "表示を期待する役割 ID に提出された対応が無い",
      },
    ]);
  });

  it("構造の検査が無ければ、空の並びで出す（欄は常にある）", async () => {
    const bundle = await assembleBundle(input());
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.structural_checks).toEqual([]);
  });
});

// ── 材料の状態と、早期停止の診断（§1.4・§4・Issue #417）──────────────────────

describe("材料の状態と、早期停止の診断（§1.4・§4・Issue #417）", () => {
  it("検証の結果に、材料の状態の一覧と、版ごとの評価の行・回数を出す", async () => {
    const bundle = await assembleBundle(input());
    const verification = JSON.parse(findText(bundle.artifacts, VERIFICATION_FILE)) as BundleVerification;
    expect(verification.materials).toEqual(MATERIALS);
    expect(verification.evaluations).toEqual(EVALUATIONS);
    // 回数は段の記録から数える（この例は段が空なので全部 0）
    expect(verification.counts).toEqual({
      evaluations: 0,
      write_initial: 0,
      write_redos: 0,
      correspondence_generations: 0,
      repair_executions: 0,
    });
  });

  it("早期停止の診断で、宣言が無ければ宣言のファイルも manifest も作らず、一覧に未受理と未実行を区別して出す", () => {
    const materials: readonly BundleMaterialEntry[] = [
      { material: "design", state: "accepted", version: { stage_index: 1, sha256: "design-sha" } },
      { material: "test_suite", state: "unaccepted" },
      { material: "mappings", state: "unexecuted" },
      { material: "declaration", state: "unexecuted" },
      { material: "correspondence", state: "unexecuted" },
      { material: "test_run", state: "unexecuted" },
      { material: "evaluation", state: "unexecuted" },
    ];
    const diagnostics = buildDiagnostics({
      stopped: { stage: "test-suite", kind: "malformed" },
      materials,
      evaluations: [],
      counts: { evaluations: 0, write_initial: 0, write_redos: 0, correspondence_generations: 0, repair_executions: 0 },
      design: DESIGN,
    });
    const paths = diagnostics.map((artifact) => artifact.path);
    // 在る材料（設計）のファイルは作る
    expect(paths).toContain(DIAGNOSTICS_DESIGN_FILE);
    // 無い材料のファイルは作らない（宣言のファイルも、manifest も）
    expect(paths).not.toContain(DIAGNOSTICS_DECLARATION_FILE);
    expect(paths).not.toContain(DIAGNOSTICS_TEST_SUITE_FILE);
    expect(paths).not.toContain(DIAGNOSTICS_MAPPINGS_FILE);
    expect(paths).not.toContain(DIAGNOSTICS_STATIC_CHECK_FILE);
    expect(paths).not.toContain(BUNDLE_MANIFEST_FILE);

    // 一覧は常にある。未受理（試験）と未実行（対応・宣言・評価）を区別して出す
    const listing = JSON.parse(findText(diagnostics, DIAGNOSTICS_LISTING_FILE)) as {
      stopped: { stage: string; kind: string };
      materials: readonly BundleMaterialEntry[];
      evaluations: readonly BundleEvaluationRow[];
    };
    expect(listing.stopped).toEqual({ stage: "test-suite", kind: "malformed" });
    const stateOf = (material: string) => listing.materials.find((entry) => entry.material === material)?.state;
    expect(stateOf("design")).toBe("accepted");
    expect(stateOf("test_suite")).toBe("unaccepted");
    expect(stateOf("mappings")).toBe("unexecuted");
    expect(stateOf("declaration")).toBe("unexecuted");
    expect(stateOf("evaluation")).toBe("unexecuted");
    // 一覧には、材料の種類がすべて出る（1 行も欠けない）
    expect(listing.materials.map((entry) => entry.material)).toEqual([...MATERIAL_KINDS]);
  });

  it("材料のファイル名は、コードの定数である（モデル由来の ID をファイル名にしない）", async () => {
    // 診断の 5 つの材料のファイルは、エクスポートした定数と一致する
    expect(DIAGNOSTICS_DESIGN_FILE).toBe("diagnostics/design.json");
    expect(DIAGNOSTICS_TEST_SUITE_FILE).toBe("diagnostics/test-suite.json");
    expect(DIAGNOSTICS_MAPPINGS_FILE).toBe("diagnostics/mappings.json");
    expect(DIAGNOSTICS_DECLARATION_FILE).toBe("diagnostics/declaration.json");
    expect(DIAGNOSTICS_STATIC_CHECK_FILE).toBe("diagnostics/static-check.json");
    // 納品物に足す 3 ファイルも定数で決まる
    expect(DESIGN_FILE).toBe("artifacts/design.json");
    expect(TEST_SUITE_FILE).toBe("artifacts/test-suite.json");
    expect(MAPPINGS_FILE).toBe("artifacts/mappings.json");
    // 早期停止の診断は、納品物の置き場所（artifacts/）を使わない
    const diagnostics = buildDiagnostics({
      stopped: { stage: "design", kind: "malformed" },
      materials: MATERIALS,
      evaluations: EVALUATIONS,
      counts: { evaluations: 1, write_initial: 1, write_redos: 0, correspondence_generations: 1, repair_executions: 0 },
    });
    expect(diagnostics.every((artifact) => !artifact.path.startsWith("artifacts/"))).toBe(true);
  });

  it("宣言が無ければ、診断の宣言のファイルを作らないが、宣言があれば作る", () => {
    const base = {
      stopped: { stage: "write", kind: "malformed" },
      materials: MATERIALS,
      evaluations: EVALUATIONS,
      counts: { evaluations: 1, write_initial: 1, write_redos: 0, correspondence_generations: 0, repair_executions: 0 },
    };
    const withoutDeclaration = buildDiagnostics(base);
    expect(withoutDeclaration.map((artifact) => artifact.path)).not.toContain(DIAGNOSTICS_DECLARATION_FILE);

    const withDeclaration = buildDiagnostics({ ...base, declarations: [{ sha256: "declared-sha", declaration: DECLARATION_SOURCE }] });
    const file = findText(withDeclaration, DIAGNOSTICS_DECLARATION_FILE);
    const parsed = JSON.parse(file) as { declarations: readonly { sha256: string; declaration: string }[] };
    expect(parsed.declarations).toEqual([{ sha256: "declared-sha", declaration: DECLARATION_SOURCE }]);
  });
});

// ── ②・②' が断った候補の診断（Issue #501）──────────────────────────────

describe("②・②' が断った候補の診断（Issue #501）", () => {
  const MARKER = "MARKER501-value";
  const COUNTS = { evaluations: 0, write_initial: 0, write_redos: 0, correspondence_generations: 0, repair_executions: 0 };
  const DESIGN_CANDIDATE: BundleRejectedCandidate = {
    stage: "design",
    operation: null,
    call: 1,
    round: 1,
    attempt: 1,
    kind: "content",
    target: { designs: [{ requirementId: "R-1", notes: [MARKER] }] },
    target_sha256: "target-sha",
    response: { designs: [{ requirementId: "R-1", notes: [MARKER] }] },
    response_sha256: "response-sha",
    inspection_list: { requirements: [] },
    inspection_list_sha256: "list-sha",
    problems: [
      { field: "requirements[0]", message: "要件の設計が無い", reference: "target", reference_sha256: "target-sha" },
      { field: "requirements[1]", message: "要件の設計が無い", reference: "target", reference_sha256: "target-sha" },
      { field: "designs[0]", message: "文書に無い制約 ID である", code: "constraint", reference: "response", reference_sha256: "response-sha" },
    ],
  };
  const SUITE_CANDIDATE: BundleRejectedCandidate = {
    stage: "test-suite",
    operation: null,
    call: 1,
    round: 1,
    attempt: 2,
    kind: "shape",
    response: { tests: MARKER },
    response_sha256: "suite-sha",
    problems: [{ field: "tests", message: "試験の並び（array）であること", reference: "response", reference_sha256: "suite-sha" }],
  };
  const base = {
    stopped: { stage: "design", kind: "unmet" },
    materials: MATERIALS,
    evaluations: [],
    counts: COUNTS,
  };

  it("候補を渡すと、一覧の rejected に値が無く、候補のファイルは段ごとに定数の名前で作り、manifest を組まない", () => {
    const diagnostics = buildDiagnostics({ ...base, rejected: [DESIGN_CANDIDATE, SUITE_CANDIDATE] });
    const paths = diagnostics.map((artifact) => artifact.path);
    expect(DIAGNOSTICS_REJECTED_DESIGN_FILE).toBe("diagnostics/rejected-design.json");
    expect(DIAGNOSTICS_REJECTED_TEST_SUITE_FILE).toBe("diagnostics/rejected-test-suite.json");
    expect(paths).toEqual([DIAGNOSTICS_LISTING_FILE, DIAGNOSTICS_REJECTED_DESIGN_FILE, DIAGNOSTICS_REJECTED_TEST_SUITE_FILE]);
    expect(paths).not.toContain(BUNDLE_MANIFEST_FILE);

    // 一覧の rejected は、段・operation・通し番号・回・試行・種類・件数・固定文ごとの件数だけ（値なし）
    const listingText = findText(diagnostics, DIAGNOSTICS_LISTING_FILE);
    expect(listingText).not.toContain(MARKER);
    expect(listingText).not.toContain("target-sha");
    const listing = JSON.parse(listingText) as { rejected: readonly BundleRejectedSummary[] };
    expect(listing.rejected).toEqual([
      {
        stage: "design",
        operation: null,
        call: 1,
        round: 1,
        attempt: 1,
        kind: "content",
        problem_count: 3,
        messages: [
          { message: "要件の設計が無い", count: 2 },
          { message: "文書に無い制約 ID である", code: "constraint", count: 1 },
        ],
      },
      {
        stage: "test-suite",
        operation: null,
        call: 1,
        round: 1,
        attempt: 2,
        kind: "shape",
        problem_count: 1,
        messages: [{ message: "試験の並び（array）であること", count: 1 }],
      },
    ]);
    // 候補のファイルは、候補をそのまま並べる（値つき）
    const designFile = JSON.parse(findText(diagnostics, DIAGNOSTICS_REJECTED_DESIGN_FILE)) as { candidates: unknown };
    expect(designFile.candidates).toEqual([DESIGN_CANDIDATE]);
    const suiteFile = JSON.parse(findText(diagnostics, DIAGNOSTICS_REJECTED_TEST_SUITE_FILE)) as { candidates: unknown };
    expect(suiteFile.candidates).toEqual([SUITE_CANDIDATE]);
  });

  it("候補が無ければ候補のファイルを作らず、一覧の rejected は空", () => {
    for (const diagnostics of [buildDiagnostics(base), buildDiagnostics({ ...base, rejected: [] })]) {
      expect(diagnostics.map((artifact) => artifact.path)).toEqual([DIAGNOSTICS_LISTING_FILE]);
      const listing = JSON.parse(findText(diagnostics, DIAGNOSTICS_LISTING_FILE)) as { rejected: readonly unknown[] };
      expect(listing.rejected).toEqual([]);
    }
    expect(buildRejectedCandidateFiles([])).toEqual([]);
    // 片方の段だけの候補なら、その段のファイルだけを作る
    expect(buildRejectedCandidateFiles([SUITE_CANDIDATE]).map((artifact) => artifact.path)).toEqual([
      DIAGNOSTICS_REJECTED_TEST_SUITE_FILE,
    ]);
    expect(summarizeRejectedCandidates([])).toEqual([]);
  });

  it("納品物の bundleFiles の集合は変わらず、要約の wire は今までどおり受け付ける", async () => {
    const bundle = await assembleBundle(input());
    const paths = bundleFiles(bundle).map((artifact) => artifact.path);
    expect(paths.some((path) => path.startsWith("diagnostics/"))).toBe(false);
    expect(paths).not.toContain(DIAGNOSTICS_REJECTED_DESIGN_FILE);
    expect(paths).not.toContain(DIAGNOSTICS_REJECTED_TEST_SUITE_FILE);
    expect(acceptsHeadlessSummaryWire(bundle.summary)).toBe(true);
  });
});

// ── 追加の成果物（v1.1α A6'。07 §1.4・Issue #506）──────────────────────────────

describe("追加の成果物の差し込み口（v1.1α・Issue #506）", () => {
  const EXTRA = [
    { path: `${ARTIFACTS_DIR}/name-table.json`, text: '{"rows":[]}\n' },
    { path: `${ARTIFACTS_DIR}/test-spec.json`, text: '{"tests":[],"note":"追加の成果物"}\n' },
  ];

  it("省いた納品物と空の並びを渡した納品物は、成果物・manifest の本文まで同じ", async () => {
    const plain = await assembleBundle(input());
    const empty = await assembleBundle(input({ extraArtifacts: [] }));
    expect(bundleFiles(empty)).toEqual(bundleFiles(plain));
    expect(empty.manifestText).toBe(plain.manifestText);
    expect(empty).toEqual(plain);
  });

  it("渡すと v1 の成果物の後ろに並び、manifest の files に SHA-256 と大きさで載り、bundleFiles の末尾は manifest のまま", async () => {
    const plain = await assembleBundle(input());
    const extended = await assembleBundle(input({ extraArtifacts: EXTRA }));
    // v1 の成果物は同じ並び・同じ中身で先頭に残る
    expect(extended.artifacts.slice(0, plain.artifacts.length)).toEqual(plain.artifacts);
    expect(extended.artifacts.slice(plain.artifacts.length)).toEqual(EXTRA);
    const files = extended.manifest.files;
    expect(files.slice(0, plain.manifest.files.length)).toEqual(plain.manifest.files);
    const added = files.slice(plain.manifest.files.length);
    expect(added).toEqual(
      await Promise.all(
        EXTRA.map(async (artifact) => ({
          path: artifact.path,
          sha256: await sha256Hex(artifact.text),
          size_bytes: byteLength(artifact.text),
        })),
      ),
    );
    const all = bundleFiles(extended);
    expect(all.at(-1)?.path).toBe(BUNDLE_MANIFEST_FILE);
    expect(all.at(-1)?.text).toBe(extended.manifestText);
    // 検証の結果・要約は v1 のまま（追加の成果物は合否に効かない）
    expect(findText(extended.artifacts, VERIFICATION_FILE)).toBe(findText(plain.artifacts, VERIFICATION_FILE));
    expect(extended.manifest.expected_verdict).toBe(plain.manifest.expected_verdict);
  });

  it("v1 の成果物と同じ path・置き場所の外・重複した path は例外で断る（黙って上書きしない）", async () => {
    for (const path of [VERIFICATION_FILE, DESIGN_FILE, "artifacts/app.spec.yaml"]) {
      await expect(assembleBundle(input({ extraArtifacts: [{ path, text: "x" }] }))).rejects.toThrow(/同じ path/);
    }
    for (const path of [BUNDLE_MANIFEST_FILE, "diagnostics/name-table.json", "name-table.json", `${ARTIFACTS_DIR}/`]) {
      await expect(assembleBundle(input({ extraArtifacts: [{ path, text: "x" }] }))).rejects.toThrow(/置き場所/);
    }
    const twice = [EXTRA[0], EXTRA[0]].filter((artifact) => artifact !== undefined);
    await expect(assembleBundle(input({ extraArtifacts: twice }))).rejects.toThrow(/同じ path/);
  });
});

describe("v1.1α の段の断った候補（name-table・test-spec。Issue #506）", () => {
  const candidate = (stage: BundleRejectedCandidate["stage"], attempt: number): BundleRejectedCandidate => ({
    stage,
    operation: null,
    call: 1,
    round: 1,
    attempt,
    kind: "shape",
    response: { value: `${stage}-${attempt}` },
    response_sha256: `${stage}-sha`,
    problems: [{ field: "rows", message: "並び（array）であること", reference: "response", reference_sha256: `${stage}-sha` }],
  });
  const v1Candidates = [candidate("design", 1), candidate("test-suite", 1)];
  const COUNTS = { evaluations: 0, write_initial: 0, write_redos: 0, correspondence_generations: 0, repair_executions: 0 };
  const base = { stopped: { stage: "name-table", kind: "unmet" }, materials: MATERIALS, evaluations: [], counts: COUNTS };

  it("段 name-table・test-spec の候補は 2 つの新しいファイルに分かれ、v1 の 2 段のファイル名と中身は今までどおり", () => {
    expect(DIAGNOSTICS_REJECTED_NAME_TABLE_FILE).toBe("diagnostics/rejected-name-table.json");
    expect(DIAGNOSTICS_REJECTED_TEST_SPEC_FILE).toBe("diagnostics/rejected-test-spec.json");
    const mixed = [candidate("test-spec", 1), ...v1Candidates, candidate("name-table", 1), candidate("name-table", 2)];
    const files = buildRejectedCandidateFiles(mixed);
    expect(files.map((artifact) => artifact.path)).toEqual([
      DIAGNOSTICS_REJECTED_DESIGN_FILE,
      DIAGNOSTICS_REJECTED_TEST_SUITE_FILE,
      DIAGNOSTICS_REJECTED_NAME_TABLE_FILE,
      DIAGNOSTICS_REJECTED_TEST_SPEC_FILE,
    ]);
    // v1 の 2 段のファイルは、v1 の候補だけのときと同じ中身
    const v1Only = buildRejectedCandidateFiles(v1Candidates);
    expect(files.slice(0, 2)).toEqual(v1Only);
    expect(JSON.parse(findText(files, DIAGNOSTICS_REJECTED_NAME_TABLE_FILE))).toEqual({
      candidates: [candidate("name-table", 1), candidate("name-table", 2)],
    });
    expect(JSON.parse(findText(files, DIAGNOSTICS_REJECTED_TEST_SPEC_FILE))).toEqual({
      candidates: [candidate("test-spec", 1)],
    });
  });

  it("一覧の rejected の要約は、v1 の候補の分が今までどおりで、新しい段は段の名前つきで並ぶ", () => {
    const v1Listing = buildDiagnostics({ ...base, rejected: v1Candidates });
    const mixedListing = buildDiagnostics({ ...base, rejected: [...v1Candidates, candidate("name-table", 1)] });
    const rejectedOf = (artifacts: readonly { path: string; text: string }[]) =>
      (JSON.parse(findText(artifacts, DIAGNOSTICS_LISTING_FILE)) as { rejected: readonly BundleRejectedSummary[] }).rejected;
    expect(rejectedOf(mixedListing).slice(0, 2)).toEqual(rejectedOf(v1Listing));
    expect(rejectedOf(mixedListing)[2]?.stage).toBe("name-table");
    expect(summarizeRejectedCandidates(v1Candidates)).toEqual(rejectedOf(v1Listing));
    // 新しい段の候補が無ければ、新しいファイルは作らない
    expect(v1Listing.map((artifact) => artifact.path)).not.toContain(DIAGNOSTICS_REJECTED_NAME_TABLE_FILE);
    expect(v1Listing.map((artifact) => artifact.path)).not.toContain(DIAGNOSTICS_REJECTED_TEST_SPEC_FILE);
  });
});

// ── 比較元のバイトの記録（v1.1α A6'。凍結した main 2cd1586 から取った記録。Issue #506）──────────

/** 記録を読むための最小の file system（Node の型に依らない。run-replay.test.ts と同じ手） */
interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 記録の fixture（`__fixtures__/baseline-2cd1586/`）を UTF-8 の文字列として読む */
const baselineText = (name: string): string =>
  fs.readFileSync(new URL(`./__fixtures__/baseline-2cd1586/${name}`, import.meta.url), "utf8");

interface BaselineLibrary {
  readonly procedure: readonly string[];
  readonly baseCommit: string;
  readonly captures: readonly BaselineCapture[];
}

describe("比較元のバイトの記録（v1.1α・Issue #506）", () => {
  const scenariosText = baselineText("scenarios.json");
  const libraryText = baselineText("library.json");
  const definitions = JSON.parse(scenariosText) as BaselineScenarios;
  const library = JSON.parse(libraryText) as BaselineLibrary;

  it("4 経路の記録があり、先頭の欄に取り方の手順と比較元の commit の完全な SHA がある", () => {
    expect(Object.keys(library)[0]).toBe("procedure");
    expect(library.baseCommit).toBe("2cd1586f856fb1cdecf75ef035826cbffe539e69");
    const procedure = library.procedure.join("\n");
    for (const step of ["checkout", "build", "道具の呼び方", "captureBaseline", library.baseCommit]) {
      expect(procedure).toContain(step);
    }
    expect(definitions.scenarios.map((scenario) => scenario.name)).toEqual([
      "complete",
      "repair",
      "early-stop",
      "return-to-plan",
    ]);
    expect(library.captures.map((capture) => capture.name)).toEqual(definitions.scenarios.map((scenario) => scenario.name));
    // 経路が意図どおりに分かれている（完走・修復あり・早期停止・差し戻し）
    const [complete, repair, earlyStop, returnToPlan] = library.captures;
    expect(complete?.judgment.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(complete?.toolResults).toEqual([]);
    expect(repair?.toolResults.length).toBeGreaterThan(0);
    expect(repair?.requests.some((request) => (request as { kind: string }).kind === "tools")).toBe(true);
    expect(earlyStop?.bundle).toBeNull();
    expect(earlyStop?.judgment.stopped).not.toBeNull();
    expect(earlyStop?.diagnostics.length).toBeGreaterThan(0);
    expect(returnToPlan?.judgment.returnToPlan).toBe(true);
    for (const capture of library.captures) {
      expect(capture.requests.length).toBeGreaterThan(0);
      if (capture.bundle !== null) {
        expect(capture.bindings).not.toBeNull();
        expect(capture.bundle.files.at(-1)?.path).toBe(BUNDLE_MANIFEST_FILE);
      }
    }
  });

  it("任意の引数を省いた候補を同じ道具で流すと、4 経路すべてで記録と深く等しい", async () => {
    const captures = await captureBaseline(factoryModule, definitions);
    expect(captures).toHaveLength(library.captures.length);
    captures.forEach((capture, index) => {
      expect(capture, capture.name).toEqual(library.captures[index]);
    });
  });

  it("記録と 1 バイトでも違えば落ちる（要求の 1 文字・ファイルの SHA-256 の 1 文字）", async () => {
    const captures = await captureBaseline(factoryModule, definitions);
    const first = captures[0];
    if (first === undefined) throw new Error("前提が壊れた");
    const request = first.requests[0] as { request: { input: string } };
    const changedRequest = structuredClone(first) as BaselineCapture;
    (changedRequest.requests[0] as { request: { input: string } }).request.input = `${request.request.input} `;
    expect(changedRequest).not.toEqual(library.captures[0]);
    const changedFile = structuredClone(first) as unknown as { bundle: { files: { sha256: string }[] } };
    const file = changedFile.bundle.files[0];
    if (file === undefined) throw new Error("前提が壊れた");
    file.sha256 = `${file.sha256.slice(0, -1)}${file.sha256.endsWith("0") ? "1" : "0"}`;
    expect(changedFile).not.toEqual(library.captures[0]);
  });

  it("記録と経路の定義に、鍵の値・題材の言葉が無い", () => {
    for (const text of [scenariosText, libraryText]) {
      for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
      expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
      expect(text).not.toContain("OPENAI_API_KEY");
      expect(text).not.toContain("JEV_API_KEY");
      expect(text).not.toMatch(/Bearer\s/);
    }
  });
});
