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
import {
  BUNDLE_MANIFEST_FILE,
  PLAN_FILE,
  REQUIREMENTS_FILE,
  UNWRITABLE_FILE,
  VERIFICATION_FILE,
  assembleBundle,
  bundleFiles,
  toBundleNatureDiscrepancies,
  type BundleInput,
  type BundleJudgeUsage,
  type BundleNatureDiscrepancy,
  type BundlePartialReasons,
  type BundleSummary,
  type BundleUnwritable,
  type BundleVerification,
} from "./bundle.js";
import { requirementsFromPlan, type CorrespondenceResult, type Declaration, type RequirementList } from "./pipeline.js";
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
