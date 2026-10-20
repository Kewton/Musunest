// v1.2 の呼び出しの上限の表（08-architecture-v1.2.md §4.1。手 3p・Issue #592）の試験。
//
// 固定するもの：本全体の暫定の上限（論理 72・実試行 144・判定 80）と、その定義の `why`・`since`・見直す条件／段ごとの論理の枠が
// §4.1 の列のまま／今の v1.1α の段がそのまま列に写り、その値が段のコードの定数と同じ／v1・v1.1α の上限の表（`AGENT_LIMITS`）の
// 値と欄が直す前と同じ／表と、手 3p で足した試験・fixture に受入の題材の言葉が無い。外部の API は呼ばない。
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../limits.js";
import { ruleDefinitionDefects, STEP_ATTEMPTS } from "../stages/prompt.js";
import { ACCEPTANCE_MATERIAL_WORDS, expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import { NAME_TABLE_ROUNDS } from "../v11a/stages/name-table.js";
import { TEST_SPEC_ROUNDS } from "../v11a/stages/test-spec.js";
import * as factory from "../index.js";
import {
  V12_CALL_LIMIT_DEFINITIONS,
  V12_CALL_LIMITS,
  V12_FRAME_STAGES,
  V12_FRAME_UNIT_LABELS,
  V12_FRAME_UNITS,
  V12_STAGE_FRAME_DEFINITIONS,
  V12_STAGE_FRAMES,
  V12_V11A_FRAME_MAP,
  V12_IDS_FRAME_MAP,
  V12_C3_BUNDLE,
  V12_C3_BUNDLE_DEFINITIONS,
  c3BundleCount,
  c3MaxLogical,
} from "./limits.js";
import { VOCABULARY_BUNDLES } from "./ids.js";
import { MAPPING_ROUNDS } from "./stages/mapping.js";
import { SEARCH_REPAIR_BUDGET } from "./search-repair.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 段ごとの論理の枠の行 */
const frame = (stage: string) => V12_STAGE_FRAMES.find((entry) => entry.stage === stage);

describe("本全体の暫定の上限（論理 72・実試行 144・判定 80）", () => {
  it("値と、値ごとの定義（why・since・見直す条件）。ruleDefinitionDefects で不備 0", () => {
    expect(V12_CALL_LIMITS).toEqual({ logicalCalls: 72, realAttempts: 144, judgeBranch: 80 });
    expect(ruleDefinitionDefects(V12_CALL_LIMIT_DEFINITIONS)).toEqual([]);
    expect(V12_CALL_LIMIT_DEFINITIONS.map((definition) => definition.limit)).toEqual(Object.keys(V12_CALL_LIMITS));
    for (const definition of V12_CALL_LIMIT_DEFINITIONS) {
      expect(definition.review.trim(), definition.id).not.toBe("");
      expect(definition.text, definition.id).toContain(String(V12_CALL_LIMITS[definition.limit]));
    }
    // 見直す条件（08 §4.1）：門の停止で束の大きさ・実試行が論理の 1.2 倍で通信の再送・枝が尽きれば J4 を束にするか枝を広げる
    const reviews = V12_CALL_LIMIT_DEFINITIONS.map((definition) => definition.review).join("\n");
    expect(reviews).toContain("最初の 30 本で門の停止が 1 本以上あれば");
    expect(reviews).toContain("束の大きさを見直す");
    expect(reviews).toContain("実試行が論理の 1.2 倍を超えた本があれば通信の再送を調べる");
    expect(reviews).toContain("判定の枝が尽きた本が出れば、J4 を束にするか枝を広げる");
  });

  it("二点測定：why・since を空にした定義は不備になる", () => {
    const [first] = V12_CALL_LIMIT_DEFINITIONS;
    if (first === undefined) throw new Error("前提が壊れた：定義が無い");
    expect(ruleDefinitionDefects([{ ...first, why: " " }])).toHaveLength(1);
    expect(ruleDefinitionDefects([{ ...first, since: "" }])).toHaveLength(1);
  });

  it("v1・v1.1α の上限の表（AGENT_LIMITS）の値と欄は直す前と同じ（v1.2 の表は足さない）", () => {
    expect(AGENT_LIMITS).toEqual({
      requestTextChars: 4_000,
      declarationBytes: 65_536,
      testsPerRequirement: 16,
      referenceRowsPerTest: 64,
      recordRows: 256,
      callCount: 24,
      toolCalls: 24,
      repairRoundTrips: 6,
      repairStepTurns: 8,
      correspondenceRedos: 2,
      correspondenceChecks: 6,
      declChecks: 6,
      stagnationRepeats: 2,
      planQuestions: 10,
      planRoundTrips: 3,
      planChoices: 4,
      planFreeTextChars: 500,
    });
    expect(AGENT_LIMITS).not.toHaveProperty("v12");
  });
});

describe("段ごとの論理の枠（§4.1 の列のまま）", () => {
  it("段・初回・形のやり直し・中身のやり直し・単位・版／往復の上限", () => {
    const columns = V12_STAGE_FRAMES.map((frame) => [
      frame.stage,
      frame.initial === null ? null : `${String(frame.initial.count)}/${V12_FRAME_UNIT_LABELS[frame.initial.unit]}`,
      frame.shape === null ? null : `${String(frame.shape.count)}/${V12_FRAME_UNIT_LABELS[frame.shape.unit]}`,
      frame.content === null ? null : `${String(frame.content.count)}/${V12_FRAME_UNIT_LABELS[frame.content.unit]}`,
      frame.maxUnits,
    ]);
    expect(columns).toEqual([
      ["C1", "1/束ごと", "1/束ごと", null, null],
      ["C2", "1/束ごと", "1/束ごと", "1/束ごと", null],
      // C3 は束ごとに初回 1・形のやり直し 段全体で通算 1・再点検 束ごとに 1（段全体で 1 回。Issue #662）
      ["C3", "1/束ごと", "1/段全体", "1/束ごと", null],
      ["C4", "1/束ごと", "1/束ごと", null, null],
      ["C6", "1/版ごと", "2/段全体", null, 6],
      ["loop", null, "1/往復ごと", "2/往復ごと", 6],
      ["rewrite", null, "1/段全体", "1/段全体", null],
    ]);
    expect(V12_STAGE_FRAMES.map((frame) => frame.stage)).toEqual([...V12_FRAME_STAGES]);
    expect(Object.keys(V12_FRAME_UNIT_LABELS)).toEqual([...V12_FRAME_UNITS]);
  });

  it("行ごとの定義（why・since）が段ごとに 1 つずつあり、不備 0", () => {
    expect(ruleDefinitionDefects(V12_STAGE_FRAME_DEFINITIONS)).toEqual([]);
    expect(V12_STAGE_FRAME_DEFINITIONS.map((definition) => definition.stage)).toEqual([...V12_FRAME_STAGES]);
  });

  it("ループと作り直しの行は探索型の直しの予算の行（手 4a）と同じ値、C6 の版は v1.1α の declChecks と同じ値", () => {
    expect(frame("loop")?.maxUnits).toBe(SEARCH_REPAIR_BUDGET.repairRoundTrips);
    expect(frame("rewrite")?.content?.count).toBe(SEARCH_REPAIR_BUDGET.rewrites);
    expect(frame("rewrite")?.shape?.count).toBe(SEARCH_REPAIR_BUDGET.rewriteShapeRetries);
    expect(frame("C6")?.maxUnits).toBe(AGENT_LIMITS.declChecks);
  });

  it("今の v1.1α の段がそのまま列に写る（T1 2 回・T2 2 回・形のやり直し 2 試行・B3' 6 版・B5 往復 6）。値は段のコードの定数と同じ", () => {
    const map = Object.fromEntries(V12_V11A_FRAME_MAP.map((entry) => [entry.v11a, entry]));
    expect(map["name-table"]).toMatchObject({ frames: ["C1", "C2"], rounds: NAME_TABLE_ROUNDS, shapeAttempts: STEP_ATTEMPTS, units: null });
    expect(map["semantic-check"]).toMatchObject({ frames: ["C3"], rounds: NAME_TABLE_ROUNDS, shapeAttempts: STEP_ATTEMPTS });
    expect(map["test-spec"]).toMatchObject({ frames: ["C4"], rounds: TEST_SPEC_ROUNDS, shapeAttempts: STEP_ATTEMPTS });
    expect(map["decl-check"]).toMatchObject({ frames: ["C6"], units: AGENT_LIMITS.declChecks, shapeAttempts: STEP_ATTEMPTS });
    expect(map["repair"]).toMatchObject({ frames: ["loop"], units: AGENT_LIMITS.repairRoundTrips });
    expect(map["arbitration"]).toMatchObject({ frames: ["loop"], units: AGENT_LIMITS.repairRoundTrips });
    expect(map["write"]).toMatchObject({ frames: ["rewrite"] });
    // やり直しの回数の定数は変えない（門を緩めない）
    expect([NAME_TABLE_ROUNDS, TEST_SPEC_ROUNDS, STEP_ATTEMPTS, AGENT_LIMITS.declChecks, AGENT_LIMITS.repairRoundTrips, AGENT_LIMITS.stagnationRepeats]).toEqual([
      2, 2, 2, 6, 6, 2,
    ]);
    // 写した段の枠は、表にある行だけ
    for (const entry of V12_V11A_FRAME_MAP) for (const stage of entry.frames) expect(V12_FRAME_STAGES).toContain(stage);
  });

  it("入口（index）から上限の表を読める", () => {
    expect(factory.V12_CALL_LIMITS).toBe(V12_CALL_LIMITS);
    expect(factory.V12_STAGE_FRAMES).toBe(V12_STAGE_FRAMES);
  });
});

describe("受入の題材の言葉が無い（表・手 3p の試験・fixture・生成器）", () => {
  const files = [
    "./limits.ts",
    "./limits.test.ts",
    "../judge-budget.ts",
    "../v11a/calls.test.ts",
    "../v11a/__tests__/sizes.ts",
    "../v11a/__tests__/fixtures.ts",
    // C3 の束（Issue #662）の段・走らせる部分・試験
    "../v11a/stages/semantic-check.ts",
    "../v11a/stages/semantic-check.test.ts",
    "../v11a/run.ts",
    "../record.ts",
    "../record.test.ts",
  ];
  it.each(files)("%s", (file) => {
    const text = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    // この試験のファイルは、走査する言葉の並びを import するだけで、言葉そのものは書かない
    expectNoAcceptanceMaterial([text]);
  });

  it("二点測定：言葉を 1 つ混ぜると落ちる", () => {
    const [word] = ACCEPTANCE_MATERIAL_WORDS;
    expect(() => expectNoAcceptanceMaterial([`上限の表 ${word ?? ""}`])).toThrow();
  });

  it("上限の表の文（定義の text・why・review）に言葉が無い", () => {
    expectNoAcceptanceMaterial(
      [...V12_CALL_LIMIT_DEFINITIONS, ...V12_STAGE_FRAME_DEFINITIONS, ...V12_C3_BUNDLE_DEFINITIONS].flatMap((definition) => [
        definition.text,
        definition.why,
        ...("review" in definition ? [definition.review] : []),
      ]),
    );
  });
});

describe("旗 v12.ids の段の枠（手 3a・Issue #593）", () => {
  it("C1（vocabulary）・C2（mapping）の写しの値は段のコードの定数と同じで、§4.1 の C1・C2 の行の枠を超えない。上限の表の値は変えない", () => {
    const vocabulary = V12_IDS_FRAME_MAP.find((entry) => entry.stage === "vocabulary");
    const mapping = V12_IDS_FRAME_MAP.find((entry) => entry.stage === "mapping");
    expect(vocabulary).toEqual({ stage: "vocabulary", frame: "C1", rounds: 1, shapeAttempts: STEP_ATTEMPTS, units: VOCABULARY_BUNDLES.length, maxLogical: VOCABULARY_BUNDLES.length * STEP_ATTEMPTS });
    expect(mapping).toEqual({ stage: "mapping", frame: "C2", rounds: MAPPING_ROUNDS, shapeAttempts: STEP_ATTEMPTS, units: 1, maxLogical: STEP_ATTEMPTS + 1 });
    for (const entry of V12_IDS_FRAME_MAP) {
      const frame = V12_STAGE_FRAMES.find((candidate) => candidate.stage === entry.frame);
      expect(frame, entry.frame).toBeDefined();
      if (frame === undefined) continue;
      const perUnit = (frame.initial?.count ?? 0) + (frame.shape?.count ?? 0) + (frame.content?.count ?? 0);
      expect(entry.maxLogical, entry.stage).toBeLessThanOrEqual(perUnit * entry.units);
    }
    expect(V12_CALL_LIMITS).toEqual({ logicalCalls: 72, realAttempts: 144, judgeBranch: 80 });
    expect(factory.V12_IDS_FRAME_MAP).toBe(V12_IDS_FRAME_MAP);
  });
});

describe("旗 v12.ids の C3 の束（Issue #662）", () => {
  it("束の大きさ 6・同時数 5。値ごとの定義（why・since・見直す条件）が不備 0 で、観測した最大の要件 25 の束の数が同時数の内側", () => {
    expect(V12_C3_BUNDLE).toEqual({ size: 6, concurrency: 5 });
    expect(ruleDefinitionDefects(V12_C3_BUNDLE_DEFINITIONS)).toEqual([]);
    expect(V12_C3_BUNDLE_DEFINITIONS.map((definition) => definition.key)).toEqual(Object.keys(V12_C3_BUNDLE));
    for (const definition of V12_C3_BUNDLE_DEFINITIONS) {
      expect(definition.review.trim(), definition.id).not.toBe("");
      expect(definition.text, definition.id).toContain(String(V12_C3_BUNDLE[definition.key]));
      expect(definition.since, definition.id).toContain("Issue #662");
    }
    expect(c3BundleCount(25)).toBeLessThanOrEqual(V12_C3_BUNDLE.concurrency);
    expect(factory.V12_C3_BUNDLE).toBe(V12_C3_BUNDLE);
  });

  it("束の数は ceil(対象の数 ÷ 6)、論理の最大は 2B＋1（要件 15・17 で 7、25 で 11、6 以下で 3、0 件で 0）", () => {
    expect([0, 1, 6, 7, 12, 13, 15, 17, 25].map(c3BundleCount)).toEqual([0, 1, 1, 2, 2, 3, 3, 3, 5]);
    expect([0, 6, 15, 17, 25].map(c3MaxLogical)).toEqual([0, 3, 7, 7, 11]);
  });

  it("C3 の行と対応の行：why・since が Issue #662 を名指しし、対応の行は束 ceil(25÷6)・論理の最大 2B＋1。段全体の枠の内側", () => {
    const definition = V12_STAGE_FRAME_DEFINITIONS.find((entry) => entry.stage === "C3");
    expect(definition?.since).toContain("Issue #662");
    expect(definition?.text).toContain("形のやり直しは段全体で通算 1");
    const semantic = V12_IDS_FRAME_MAP.find((entry) => entry.stage === "semantic-check");
    expect(semantic).toEqual({
      stage: "semantic-check",
      frame: "C3",
      rounds: NAME_TABLE_ROUNDS,
      shapeAttempts: STEP_ATTEMPTS,
      units: Math.ceil(25 / V12_C3_BUNDLE.size),
      maxLogical: 2 * Math.ceil(25 / V12_C3_BUNDLE.size) + 1,
    });
    // 枠の列から計算した値（初回 束ごと × B ＋ 形 段全体 ＋ 再点検 束ごと × B）と同じ
    const c3 = frame("C3");
    const units = semantic?.units ?? 0;
    expect(semantic?.maxLogical).toBe((c3?.initial?.count ?? 0) * units + (c3?.shape?.count ?? 0) + (c3?.content?.count ?? 0) * units);
    // 呼び出しの上限は変えない
    expect(V12_CALL_LIMITS).toEqual({ logicalCalls: 72, realAttempts: 144, judgeBranch: 80 });
  });
});
