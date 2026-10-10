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
import type { RecordedCall } from "./llm-fake.js";
import * as correspondenceStage from "./stages/correspondence.js";
import * as repairStage from "./stages/repair.js";
import * as runTestsStage from "./stages/run-tests.js";
import { TEST_SUITE_SCHEMA_NAME } from "./stages/test-suite.js";
import * as testSuiteStage from "./stages/test-suite.js";
import * as writeStage from "./stages/write.js";
import { createRecordingClient, expectNoAcceptanceMaterial } from "./stages/__tests__/prompt.js";
import {
  DECLARATION_SOURCE,
  DECLARATION_SOURCE_MISMATCH,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  makeRunInput,
  structured,
} from "./__tests__/run.js";

const CLOCK = "2026-09-16T12:00:00+09:00";

/** ② の設計（役割 ID の表と要件ごとの種類を持つ新しい契約。Issue #307・#316） */
const DESIGN_PLANNED = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
    { roleId: "record.extra", kind: "computation", entity: "record", name: "extra", shared: false, aliasOf: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [],
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

/** ⑤a の答え（entity record と、計算 total・extra の場所を挙げる） */
const CORRESPONDENCE_PLANNED = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
    { requirementId: "R-2", locations: [{ kind: "computation", entity: "record", name: "extra" }] },
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

    // ⑤b に、③ の提出した対応が渡っている
    expect(runTestsSpy.mock.calls[0]?.[0]?.mappings, "⑤b に提出された対応が渡る").toBeDefined();

    // ⑥ に、② の役割 ID の表と ③ の提出した対応が渡っている
    expect(repairSpy.mock.calls[0]?.[0]?.roles, "⑥ に役割 ID の表が渡る").toBeDefined();
    expect(repairSpy.mock.calls[0]?.[0]?.mappings, "⑥ に提出された対応が渡る").toBeDefined();

    // 送った要求に、受入の題材の言葉が無い
    for (const request of recording.structured) {
      expectNoAcceptanceMaterial([request.instructions, ...(request.rules ?? []), request.input, ...request.documents]);
    }
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
});
