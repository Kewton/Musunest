// 段どうしのつなぎ（走らせる部分が各段に何を渡すか）の試験（Issue #316）。
//
// 偽物の LlmClient で ① から ⑦ まで 1 回ぶん流し、**各段が受け取った入力**を観測して、省略できる引数
// ——②' の設計、⑤a・⑤b・⑥ の役割 ID の表と ③ の提出した対応——が、走らせる部分から**省かれていない**
// ことを 1 つずつ確かめる。とくに、**設計が無いときの古い経路**（②' に設計を渡さない呼び出し）が
// 走らせる部分からは呼ばれないことを確かめる（呼ばれれば、この試験が誤りになる）。
//
// **実 API は呼ばない。** 記録した応答を返す偽物（llm-fake.ts）と、手で書いた記録で閉じる。題材は
// 抽象的なものだけを使い、受入の題材の言葉は使わない。
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGeneration } from "./run.js";
import { ATTEMPT_KEYS, RETRY_KEYS } from "./record.js";
import { DESIGN_FILE, MAPPINGS_FILE, TEST_SUITE_FILE } from "./bundle.js";
import type { RecordedCall } from "./llm-fake.js";
import { requirementsFromPlan, LEGACY_DESIGN_CONTRACT } from "./pipeline.js";
import * as arbitrateStage from "./stages/arbitrate.js";
import * as correspondenceStage from "./stages/correspondence.js";
import * as designStage from "./stages/design.js";
import { DESIGN_SCHEMA_NAME } from "./stages/design.js";
import * as promptModule from "./stages/prompt.js";
import { createFakeJudge } from "./judge-fake.js";
import type { JudgeAnswer } from "./judge.js";
import * as repairStage from "./stages/repair.js";
import * as runTestsStage from "./stages/run-tests.js";
import { TEST_SUITE_SCHEMA_NAME } from "./stages/test-suite.js";
import * as testSuiteStage from "./stages/test-suite.js";
import * as writeStage from "./stages/write.js";
import { createRecordingClient, expectNoAcceptanceMaterial } from "./stages/__tests__/prompt.js";
import {
  CONFIRMED_PLAN_ADDED,
  CORRESPONDENCE_OUTPUT,
  DECLARATION_SOURCE,
  DECLARATION_SOURCE_MISMATCH,
  DESIGN_OUTPUT,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  TEST_SUITE_OUTPUT,
  makeRunInput,
  structured,
} from "./__tests__/run.js";

const CLOCK = "2026-09-16T12:00:00+09:00";

/** 納品物の成果物を読み、JSON として返す（Issue #417） */
function readArtifact(
  bundle: { readonly artifacts: readonly { readonly path: string; readonly text: string }[] },
  path: string,
): Record<string, unknown> {
  const found = bundle.artifacts.find((artifact) => artifact.path === path);
  if (found === undefined) throw new Error(`納品物に無い: ${path}`);
  return JSON.parse(found.text) as Record<string, unknown>;
}

/** ② の設計（役割 ID の表・選択肢・所属を持つ新契約。Issue #307・#316・#418） */
const DESIGN_PLANNED = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.extra", kind: "computation", entity: "record", name: "extra", shared: false, aliasOf: null, options: null, groupBy: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
        { roleId: "record.extra", basis: "stated", reason: null },
      ],
    },
  ],
};

/** ③ が提出する対応（役割 ID → 宣言の名前）。宣言に実在する名前だけを挙げる */
const GOOD_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.total", name: "total" },
  { roleId: "record.extra", name: "extra" },
];

/** 役割 ID で対象を指す試験 1 件（計算の期待は、宣言の式に合う値にする） */
function suiteTest(
  id: string,
  requirementId: string,
  roleId: string,
  kind: "normal" | "abnormal" | "boundary",
): Record<string, unknown> {
  const r1 = requirementId === "R-1";
  return {
    id,
    target: { requirementId, kind: "computation", roleId },
    kind,
    operation: "compute",
    clock: CLOCK,
    input: { amount: 21 },
    inputContract: { rowId: `${id}-row`, targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: r1 ? 42 : 22 },
  };
}

/** ②' の答え（役割 ID で指し、要件ごとの種類を持つ） */
const TEST_SUITE_PLANNED = {
  classifications: [
    { requirementId: "R-1", nature: "ruled" },
    { requirementId: "R-2", nature: "ruled" },
  ],
  tests: [
    suiteTest("t1", "R-1", "record.total", "normal"),
    suiteTest("t2", "R-1", "record.total", "abnormal"),
    suiteTest("t3", "R-1", "record.total", "boundary"),
    suiteTest("t4", "R-2", "record.extra", "normal"),
    suiteTest("t5", "R-2", "record.extra", "abnormal"),
    suiteTest("t6", "R-2", "record.extra", "boundary"),
  ],
};

/**
 * ⑤a の答え（entity record と、計算 total・extra の場所を挙げる）。R-1・R-2 はどちらも entity
 * `record` に依存として所属するので、**要件ごとに**両方の要件へ載せる（Issue #431）。
 */
const CORRESPONDENCE_PLANNED = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
    {
      requirementId: "R-2",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "extra" },
      ],
    },
  ],
};

/** 道具付きの段（⑥）の「最後の答え」の記録（宣言は何でもよい） */
const toolDone = (declaration: unknown): RecordedCall => ({
  kind: "tools",
  response: { kind: "done", declaration, usage: undefined },
});

/**
 * ① → ⑦ を 1 回ぶん流す記録。③ の 1 回目は R-1 の計算が合わず（`amount * 3`）、⑥ で正しい宣言に
 * 直して、2 回目の ⑤a・⑤b で通る。各行は会話の順である（llm-fake.ts が種別と順を確かめる）。
 */
function recordedWiring(): readonly RecordedCall[] {
  return [
    structured(REQUIREMENT_LIST_OUTPUT),
    structured(REVERSE_CHECK_OUTPUT),
    structured(DESIGN_PLANNED),
    structured(TEST_SUITE_PLANNED),
    structured({ declaration: DECLARATION_SOURCE_MISMATCH, mappings: GOOD_MAPPINGS }),
    structured(CORRESPONDENCE_PLANNED),
    toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
    structured(CORRESPONDENCE_PLANNED),
  ];
}

describe("段どうしのつなぎ：各段の任意の入力が走らせる部分から省略されていない（Issue #316）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("① から ⑦ まで流し、②' の設計・⑤a と ⑥ の役割 ID の表と対応・⑤b の対応が渡っている", async () => {
    const testSuiteSpy = vi.spyOn(testSuiteStage, "runTestSuite");
    const correspondenceSpy = vi.spyOn(correspondenceStage, "runCorrespondence");
    const runTestsSpy = vi.spyOn(runTestsStage, "runTests");
    const repairSpy = vi.spyOn(repairStage, "runRepairStep");
    const writeSpy = vi.spyOn(writeStage, "runWrite");

    const recording = createRecordingClient(recordedWiring());
    const result = await runGeneration(makeRunInput(recording.client));

    // ①→⑦ を完走する（つなぎが欠けていれば、ここで止まるか結果が変わる）
    expect(result.stopped).toBeNull();
    expect(result.outcome.result).toBe("pass");

    // ② 設計する → ③ と ②' に設計が渡っている
    expect(writeSpy.mock.calls[0]?.[0]?.design, "③ に設計が渡る").toBeDefined();
    expect(testSuiteSpy.mock.calls[0]?.[0]?.design, "②' に設計が渡る").toBeDefined();

    // ②' のプロンプトのデータに、役割 ID の表と要件ごとの種類が入る
    const testSuiteRequest = recording.structured.find((request) => request.schemaName === TEST_SUITE_SCHEMA_NAME);
    expect(testSuiteRequest).toBeDefined();
    expect(testSuiteRequest?.input).toContain("役割 ID の表");
    expect(testSuiteRequest?.input).toContain("record.total");
    expect(testSuiteRequest?.input).toContain("要件ごとの種類");

    // ⑤a に、② の役割 ID の表と ③ の提出した対応が渡っている
    expect(correspondenceSpy.mock.calls[0]?.[0]?.roles, "⑤a に役割 ID の表が渡る").toBeDefined();
    expect(correspondenceSpy.mock.calls[0]?.[0]?.mappings, "⑤a に提出された対応が渡る").toBeDefined();
    // ⑤a に、要件ごとの所属と版（新契約なので省略）が渡る（Issue #431）
    expect(correspondenceSpy.mock.calls[0]?.[0]?.ownership, "⑤a に要件ごとの所属が渡る").toBeDefined();
    expect(correspondenceSpy.mock.calls[0]?.[0]?.version).toBeUndefined();
    // ⑥ にも同じ所属と版が渡る（1 つの段にだけ渡す形にしない。Issue #431）
    expect(repairSpy.mock.calls[0]?.[0]?.ownership, "⑥ に要件ごとの所属が渡る").toBeDefined();
    expect(repairSpy.mock.calls[0]?.[0]?.version).toBeUndefined();

    // ⑤b に、③ の提出した対応が渡っている
    expect(runTestsSpy.mock.calls[0]?.[0]?.mappings, "⑤b に提出された対応が渡る").toBeDefined();

    // ⑥ に、② の役割 ID の表と ③ の提出した対応が渡っている
    expect(repairSpy.mock.calls[0]?.[0]?.roles, "⑥ に役割 ID の表が渡る").toBeDefined();
    expect(repairSpy.mock.calls[0]?.[0]?.mappings, "⑥ に提出された対応が渡る").toBeDefined();

    // 送った要求に、受入の題材の言葉が無い
    for (const request of recording.structured) {
      expectNoAcceptanceMaterial([request.instructions, ...(request.rules ?? []), request.input, ...request.documents]);
    }

    // Issue #417：納品物の成果物（設計・固定した試験・提出された対応）が、各段に渡ったものと同じ値である
    const bundle = result.bundle;
    expect(bundle).not.toBeNull();
    if (bundle === null) return;
    expect(readArtifact(bundle, DESIGN_FILE).design).toEqual(testSuiteSpy.mock.calls[0]?.[0]?.design);
    expect(readArtifact(bundle, TEST_SUITE_FILE).suite).toEqual(repairSpy.mock.calls[0]?.[0]?.suite);
    expect(readArtifact(bundle, MAPPINGS_FILE).mappings).toEqual(correspondenceSpy.mock.calls[0]?.[0]?.mappings);
  });

  it("設計が無いときの古い経路は、走らせる部分から呼ばれない（呼ばれればこの試験が誤りになる）", async () => {
    const testSuiteSpy = vi.spyOn(testSuiteStage, "runTestSuite");
    const recording = createRecordingClient(recordedWiring());
    const result = await runGeneration(makeRunInput(recording.client));

    expect(result.outcome.result).toBe("pass");
    // 旧経路（設計を渡さない呼び出し）なら design は undefined になる。渡っていれば undefined にならず、
    // ここが誤りになる（Issue #316 の回帰の番人）
    expect(testSuiteSpy.mock.calls[0]?.[0]?.design).toBeDefined();
  });

  it("版（designVersion）が初回の設計と ②' に同じ値で渡り、②' のデータに options と所属が入る（Issue #418）", async () => {
    const designSpy = vi.spyOn(designStage, "runDesign");
    const testSuiteSpy = vi.spyOn(testSuiteStage, "runTestSuite");

    // 版を省いた走り（新契約）。初回の設計と ②' に、どちらも省略（undefined）が渡る
    const recording = createRecordingClient(recordedWiring());
    const result = await runGeneration(makeRunInput(recording.client));
    expect(result.outcome.result).toBe("pass");
    const omitted = designSpy.mock.calls[0]?.[0]?.version;
    expect(omitted).toBeUndefined();
    expect(testSuiteSpy.mock.calls[0]?.[0]?.version).toBe(omitted);
    const request = recording.structured.find((candidate) => candidate.schemaName === TEST_SUITE_SCHEMA_NAME);
    expect(request?.input).toContain("options");
    expect(request?.input).toContain("要件ごとの所属");

    // 互換を明示した走りでは、同じ値（legacy）が両方に渡る
    vi.restoreAllMocks();
    const designSpy2 = vi.spyOn(designStage, "runDesign");
    const testSuiteSpy2 = vi.spyOn(testSuiteStage, "runTestSuite");
    const recording2 = createRecordingClient(recordedWiring());
    await runGeneration(makeRunInput(recording2.client, { designVersion: LEGACY_DESIGN_CONTRACT }));
    const legacy = designSpy2.mock.calls[0]?.[0]?.version;
    expect(legacy).toBe(LEGACY_DESIGN_CONTRACT);
    expect(testSuiteSpy2.mock.calls[0]?.[0]?.version).toBe(legacy);
  });

  it("②' のデータの役割 ID の表に、選択肢（options）と見出しの元の項目（groupBy）が入る（Issue #433）", async () => {
    const recording = createRecordingClient(recordedWiring());
    const result = await runGeneration(makeRunInput(recording.client));
    expect(result.outcome.result).toBe("pass");
    const request = recording.structured.find((candidate) => candidate.schemaName === TEST_SUITE_SCHEMA_NAME);
    expect(request?.input).toContain("役割 ID の表");
    expect(request?.input).toContain("options");
    expect(request?.input).toContain("groupBy");
  });

  it("⑤a のやり直しにも、同じ所属と版が渡り、前回の落ちに要件 ID と場所が入る（Issue #431）", async () => {
    const correspondenceSpy = vi.spyOn(correspondenceStage, "runCorrespondence");
    // 所属だけが誤っている：R-2 も `record.total` に所属するが、⑤a は `total` を R-1 にだけ載せる
    const wrongOwnershipDesign = {
      roles: [
        ...DESIGN_PLANNED.roles.filter((role) => role.roleId !== "record.total"),
        { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: true, aliasOf: null, options: null, groupBy: null },
      ],
      designs: [
        {
          ...DESIGN_PLANNED.designs[0],
          ownership: [
            { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
            { roleId: "record.total", basis: "stated", reason: null },
          ],
        },
        {
          ...DESIGN_PLANNED.designs[1],
          ownership: [
            { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
            { roleId: "record.total", basis: "dependency", reason: "同じ計算を共有するため" },
            { roleId: "record.extra", basis: "stated", reason: null },
          ],
        },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(wrongOwnershipDesign),
      structured(TEST_SUITE_PLANNED),
      structured({ declaration: DECLARATION_SOURCE, mappings: GOOD_MAPPINGS }),
      structured(CORRESPONDENCE_PLANNED), // 初回の ⑤a
      structured(CORRESPONDENCE_PLANNED), // ⑤a のやり直し（同じ応答なので停滞で止まる）
    ]);
    const result = await runGeneration(makeRunInput(recording.client));

    // 停滞で部分案になる（⑤a のコードの落ちだけでも、未解決として ⑦ へ渡る。review 6）
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(result.summary.stop_reason).toBe("stagnation");
    // 初回とやり直しの 2 回、⑤a を呼ぶ（段の記録も 2 件）
    expect(correspondenceSpy.mock.calls).toHaveLength(2);
    expect(result.record.stages.filter((step) => step.stage === "correspondence")).toHaveLength(2);
    const retry = correspondenceSpy.mock.calls[1]?.[0];
    expect(retry?.ownership, "やり直しにも要件ごとの所属が渡る").toBeDefined();
    expect(retry?.version).toBeUndefined();
    const previous = retry?.previousMisses ?? [];
    expect(previous.some((miss) => miss.requirementId === "R-2" && miss.location?.name === "total")).toBe(true);
  });
});

// ── 確定した仕様を正本にした道でも、全段が同じ要件の一覧を受け取る（§5・Issue #391）──

/**
 * 確定した仕様を正本にした道で、⑥ 直す・⑥' 裁定まで回る記録。③ の宣言（`amount * 3`）は R-1 の
 * 期待（`amount * 2`）と合わず、⑥ が異議（原文の引用つき）を出し、⑥' が「確定した仕様と食い違う」と
 * 裁定して Plan に戻す（返答は新しい抽象的な題材。既存の共通の Plan や本物の応答は置き換えない）。
 */
function recordedPlanRepairToPlan(): readonly RecordedCall[] {
  return [
    structured(DESIGN_OUTPUT),
    structured(TEST_SUITE_OUTPUT),
    structured({ declaration: DECLARATION_SOURCE_MISMATCH }),
    structured(CORRESPONDENCE_OUTPUT),
    toolDone({
      declaration: DECLARATION_SOURCE_MISMATCH,
      disputes: [{ testId: "t1", quote: "件数を合計する" }],
    }),
    structured({
      decisions: [{ testId: "t1", verdict: "return-to-plan", reason: "確定した仕様と食い違う", quote: "" }],
    }),
  ];
}

describe("確定した仕様を正本にした道でも、全段が同じ要件の一覧を受け取る（§5・Issue #391）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("②・②'・③・⑤a・⑥・⑥' に渡る一覧は同じ変換の結果で、⑤a・⑥' には確定した仕様が入力のまま渡る", async () => {
    const designSpy = vi.spyOn(designStage, "runDesign");
    const testSuiteSpy = vi.spyOn(testSuiteStage, "runTestSuite");
    const writeSpy = vi.spyOn(writeStage, "runWrite");
    const correspondenceSpy = vi.spyOn(correspondenceStage, "runCorrespondence");
    const repairSpy = vi.spyOn(repairStage, "runRepairStep");
    const arbitrateSpy = vi.spyOn(arbitrateStage, "runArbitration");

    const recording = createRecordingClient(recordedPlanRepairToPlan());
    const result = await runGeneration(
      makeRunInput(recording.client, { plan: CONFIRMED_PLAN_ADDED, designVersion: LEGACY_DESIGN_CONTRACT }),
    );

    // すべての段に渡る要件の一覧が、同じ変換の結果（`requirementsFromPlan`）である
    const expected = requirementsFromPlan(CONFIRMED_PLAN_ADDED);
    expect(designSpy.mock.calls[0]?.[0]?.list, "② に同じ一覧が渡る").toEqual(expected);
    expect(testSuiteSpy.mock.calls[0]?.[0]?.list, "②' に同じ一覧が渡る").toEqual(expected);
    expect(writeSpy.mock.calls[0]?.[0]?.list, "③ に同じ一覧が渡る").toEqual(expected);
    expect(correspondenceSpy.mock.calls[0]?.[0]?.list, "⑤a に同じ一覧が渡る").toEqual(expected);
    expect(repairSpy.mock.calls[0]?.[0]?.list, "⑥ に同じ一覧が渡る").toEqual(expected);
    expect(arbitrateSpy.mock.calls[0]?.[0]?.list, "⑥' に同じ一覧が渡る").toEqual(expected);

    // 確定した仕様を受け取る段（⑤a・⑥'）には、入力の Plan がそのまま渡る
    expect(correspondenceSpy.mock.calls[0]?.[0]?.plan, "⑤a に確定した仕様が入力のまま渡る").toBe(CONFIRMED_PLAN_ADDED);
    expect(arbitrateSpy.mock.calls[0]?.[0]?.plan, "⑥' に確定した仕様が入力のまま渡る").toBe(CONFIRMED_PLAN_ADDED);

    // Plan への差し戻しの判断があれば、合格（full）にならず、差し戻しが結果に残る
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.returnToPlan).toBe(true);
  });
});

// ── 各段の記録に、試行の終端と再試行の数が入る（Issue #446）──────────────

describe("①〜⑦ の各段の記録に、試行の終端と再試行の数が入る（Issue #446）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("各段に attempts・retries があり、不変の式（開始＝応答＋誤り＋打ち切り）が成り立つ", async () => {
    const recording = createRecordingClient(recordedWiring());
    const result = await runGeneration(makeRunInput(recording.client));
    expect(result.outcome.result).toBe("pass");
    expect(result.record.stages.length).toBeGreaterThan(0);
    for (const stage of result.record.stages) {
      expect(Object.keys(stage.attempts).sort(), stage.stage).toEqual([...ATTEMPT_KEYS].sort());
      expect(Object.keys(stage.retries).sort(), stage.stage).toEqual([...RETRY_KEYS].sort());
      expect(stage.attempts.started, stage.stage).toBe(
        stage.attempts.responded +
          stage.attempts.errors +
          stage.attempts.cancelled_deadline +
          stage.attempts.cancelled_timeout,
      );
    }
  });

  it("1 度通って 1 回で通る段は開始 1・応答 1・再試行 0、LLM を呼ばない段は開始 0・応答 0", async () => {
    const recording = createRecordingClient(recordedWiring());
    const result = await runGeneration(makeRunInput(recording.client));
    expect(result.outcome.result).toBe("pass");
    const byStage = (id: string): readonly (typeof result.record.stages)[number][] =>
      result.record.stages.filter((stage) => stage.stage === id);

    // 共通の口を 1 度通って 1 回で通る段（②・②'・③・⑤a・⑥）
    for (const id of ["design", "test-suite", "write", "correspondence", "repair"]) {
      for (const stage of byStage(id)) {
        expect(stage.calls, id).toBe(1);
        expect(stage.attempts.started, id).toBe(1);
        expect(stage.attempts.responded, id).toBe(1);
        expect(stage.retries, id).toEqual({ communication: 0, shape: 0, content: 0 });
      }
    }

    // LLM を呼ばない段（コードの静的チェック・試験を流す・終わりの判定）は開始 0・応答 0
    for (const id of ["static-check", "run-tests", "judge"]) {
      for (const stage of byStage(id)) {
        expect(stage.attempts.started, id).toBe(0);
        expect(stage.attempts.responded, id).toBe(0);
        expect(stage.attempts.not_started, id).toEqual({ deadline: 0, budget: 0, limit: 0, timeout: 0 });
      }
    }
  });
});

// ── ②・②' に断った候補の通知の口が渡り、ほかの段には形の口が無い（Issue #501）──────────────

/** 判定の答え（choice。確信度 0.9） */
const choice = (value: string): JudgeAnswer => ({
  kind: "choice",
  choice: value,
  probabilities: undefined,
  probability: undefined,
  confidence: 0.9,
});

describe("②・②' に断った候補の通知の口が渡り、ほかの段の予定に形の口が無い（Issue #501）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** R-1 に語彙の穴の申告を 1 件持つ設計（仕分けが R-1 だけを作り直す） */
  const designWithClaim = {
    roles: DESIGN_PLANNED.roles,
    designs: [
      {
        ...DESIGN_PLANNED.designs[0],
        unwritable: [{ part: "記録の並べ替えは書けない", constraintIds: ["記録"], reason: "文書に欄が無い" }],
        notes: [],
      },
      { ...DESIGN_PLANNED.designs[1], unwritable: [], notes: [] },
    ],
  };
  const judge = createFakeJudge({
    "triage:R-1:0": choice("vocabulary-hole"),
    "support:R-1:0": choice("contradicts"),
  });

  it("①〜⑦ の走りで、初回の ②・作り直しの ②・②' に通知の口が渡り、形の口は ②・②' の予定にだけある", async () => {
    const designSpy = vi.spyOn(designStage, "runDesign");
    const testSuiteSpy = vi.spyOn(testSuiteStage, "runTestSuite");
    const callSpy = vi.spyOn(promptModule, "callStructuredChecked");
    const base = recordedWiring();
    const recording = createRecordingClient([
      base[0]!,
      base[1]!,
      structured(designWithClaim),
      // 作り直し（R-1 の設計だけ。申告は無い）
      structured({ roles: DESIGN_PLANNED.roles, designs: [DESIGN_PLANNED.designs[0]] }),
      ...base.slice(3),
    ]);
    const result = await runGeneration(makeRunInput(recording.client, { judge }));

    expect(result.stopped).toBeNull();
    expect(result.outcome.result).toBe("pass");
    // 初回の ② と作り直しの ② の両方に、通知の口が渡る
    expect(designSpy.mock.calls).toHaveLength(2);
    expect(designSpy.mock.calls[0]?.[0]?.redo).toBeUndefined();
    expect(designSpy.mock.calls[1]?.[0]?.redo).toBeDefined();
    for (const call of designSpy.mock.calls) expect(typeof call[0]?.onRejected).toBe("function");
    // ②' にも通知の口が渡る（外した試験の口も今までどおり）
    expect(typeof testSuiteSpy.mock.calls[0]?.[0]?.onRejected).toBe("function");
    expect(typeof testSuiteSpy.mock.calls[0]?.[0]?.onDropped).toBe("function");
    // 共通の窓口の予定に形の口があるのは ②・②' だけ（ほかの段の予定は変えない）
    const withHook = new Set<string>();
    const withoutHook = new Set<string>();
    for (const [, plan] of callSpy.mock.calls) {
      (plan.onShapeRejected === undefined ? withoutHook : withHook).add(plan.request.schemaName);
    }
    expect([...withHook].sort()).toEqual([DESIGN_SCHEMA_NAME, TEST_SUITE_SCHEMA_NAME].sort());
    expect(withoutHook.has(DESIGN_SCHEMA_NAME)).toBe(false);
    expect(withoutHook.has(TEST_SUITE_SCHEMA_NAME)).toBe(false);
    expect(withoutHook.size).toBeGreaterThan(0);
  });
});
