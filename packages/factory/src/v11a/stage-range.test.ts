// 段単位の実行口の純粋な部分（bundle-v11a.ts の段の表・checkpoint・照合・段の走りの記録）の試験
// （08-architecture-v1.2.md §8.3。Issue #544）。
//
// 偽物の LLM も API も使わない。題材は v1.1α の共通の題材（`__tests__/fixtures.ts`。R5 は表で unresolved）。
// 受入の題材の言葉は使わない。手元の入口から流す試験（分けても同じ・照合の負例・終了コード）は `cli.test.ts`。
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import { DIAGNOSTICS_TABLE_ROUNDS_FILE } from "../bundle.js";
import { requirementsFromPlan } from "../pipeline.js";
import { STAGE_IDS, type StageRecord } from "../record.js";
import { fixtureList, fixtureTable } from "./__tests__/fixtures.js";
import {
  buildStageCheckpoint,
  buildStageRunRecord,
  buildTableRoundsFile,
  resolveStageRange,
  stageCheckpointFile,
  stageJsonText,
  boundaryBefore,
  stagesInRange,
  STAGE_BOUNDARIES,
  STAGE_ENDS,
  STAGE_SEGMENTS,
  STAGE_STARTS,
  stageOutputDigest,
  stagePassOf,
  verifyStageInput,
  STAGE_CHECKPOINT_SCHEMA,
  STAGE_DECLARATION_FILE,
  STAGE_RUN_RECORD_FILE,
  STAGE_RUN_RECORD_SCHEMA,
  STAGE_START_ALIASES_V12,
  STAGE_VERIFICATION_NOT_RUN_STATIC_CHECK,
  type BoundaryMaterials,
  type StageRunOutcome,
  type TableRoundRecord,
} from "./bundle-v11a.js";
import { deriveCarryOver } from "./carry-over.js";
import { nameTableSha256 } from "./names.js";
import { undeterminedJudgeAdvice } from "./run.js";
import { UPSTREAM_LEDGER_BOUNDARY } from "../v12/ledger.js";
import type { StageSearchRepairLog } from "../v12/search-repair.js";

// ── 段の表 ─────────────────────────────────────────────────────────

describe("段の表と範囲（定数で閉じる）", () => {
  it.each([
    [{ start: undefined, end: undefined, hasInput: false }, { start: "name-table", end: "judge" }],
    [{ start: undefined, end: "semantic-check", hasInput: false }, { start: "name-table", end: "semantic-check" }],
    [{ start: "test-spec", end: "test-spec", hasInput: true }, { start: "test-spec", end: "test-spec" }],
    [{ start: "write", end: undefined, hasInput: true }, { start: "write", end: "judge" }],
  ])("%j → %j（片方だけなら他方は経路の端）", (input, expected) => {
    expect(
      resolveStageRange({
        ...(input.start === undefined ? {} : { start: input.start }),
        ...(input.end === undefined ? {} : { end: input.end }),
        hasInput: input.hasInput,
      }),
    ).toEqual(expected);
  });

  it.each([
    [{ start: "decl-check", hasInput: false }, "stage-range:unknown"],
    [{ end: "write", hasInput: false }, "stage-range:unknown"],
    [{ start: "C1", hasInput: false }, "stage-range:unknown"],
    [{ start: "test-spec", end: "semantic-check", hasInput: true }, "stage-range:order"],
    [{ start: "write", end: "test-spec", hasInput: true }, "stage-range:order"],
    [{ start: "name-table", hasInput: true }, "stage-input:not-needed"],
    [{ hasInput: true }, "stage-input:not-needed"],
    [{ start: "test-spec", hasInput: false }, "stage-input:missing"],
    [{ start: "write", hasInput: false }, "stage-input:missing"],
  ] as const)("%j → %s", (input, code) => {
    expect(resolveStageRange(input)).toEqual({ code });
  });
});

// ── checkpoint と照合 ─────────────────────────────────────────────────

/** R1〜R5 の確定した仕様（R5 は表で unresolved） */
const PLAN: ConfirmedPlan = {
  schema_version: PLAN_SPEC_SCHEMA_VERSION,
  plan_id: "plan-v11a-stage",
  revision: 1,
  vocabulary_version: "v1",
  inputs: [{ id: "in-1", kind: "source", text: fixtureList().requirements.map((requirement) => requirement.text).join("") }],
  requirements: fixtureList().requirements.map((requirement) => ({
    id: requirement.id,
    text: requirement.text,
    kind: "constraining" as const,
    origin: { input_id: "in-1", quote: requirement.quote },
    parts: [{ id: `${requirement.id}-p1`, text: requirement.text, disposition: "met" as const }],
  })),
  open_issues: [],
  decisions: [],
  accepted_unwritable: [],
  confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
};
const LIST = requirementsFromPlan(PLAN);
const TABLE = fixtureTable();
const PLAN_SHA = "a".repeat(64);
const SOURCE_SHA = "b".repeat(64);
const VERSIONS = { vocabulary: "v1", contract: "v0.2", prompt: "v1.1a", factory: "0.0.0" };

/** T1''：R1・R2・R4 受理、R3 拒否（R5 は unresolved なので対象の外） */
const JUDGMENTS = [
  { requirementId: "R1", verdict: "accept" as const },
  { requirementId: "R2", verdict: "accept" as const },
  { requirementId: "R3", verdict: "reject" as const, kind: "unnecessary-ownership", quote: "締められる" },
  { requirementId: "R4", verdict: "accept" as const },
];

async function materials(): Promise<BoundaryMaterials> {
  const tableSha256 = await nameTableSha256(TABLE);
  return {
    boundary: "t1-t2",
    table: TABLE,
    tableSha256,
    semanticCheck: { tableSha256, targets: ["R1", "R2", "R3", "R4"], judgments: JUDGMENTS },
    judgeAdvice: undeterminedJudgeAdvice(LIST, TABLE),
    carryOver: await deriveCarryOver({ list: LIST, table: TABLE, semanticCheck: { tableSha256, judgments: JUDGMENTS } }),
  };
}

/** checkpoint と、それを宣言する記録の中身 */
async function written(edit: (checkpoint: Record<string, unknown>) => void = () => {}) {
  const checkpoint = buildStageCheckpoint({ materials: await materials(), versions: VERSIONS, planSha256: PLAN_SHA, sourceSha256: SOURCE_SHA });
  const value = JSON.parse(stageJsonText(checkpoint)) as Record<string, unknown>;
  edit(value);
  const record = {
    schema_version: STAGE_RUN_RECORD_SCHEMA,
    checkpoints: [{ boundary: "t1-t2", path: "cp.json", output_digest: await stageOutputDigest(value) }],
  };
  return { checkpointText: stageJsonText(value), recordText: JSON.stringify(record) };
}

const verify = (texts: { checkpointText: string | null; recordText: string | null }) =>
  verifyStageInput({
    start: "test-spec",
    ...texts,
    checkpointFile: "cp.json",
    plan: PLAN,
    planSha256: PLAN_SHA,
    sourceSha256: SOURCE_SHA,
    vocabularyVersion: "v1",
    contractVersion: "v0.2",
  });

describe("境界の checkpoint と出力ダイジェスト", () => {
  it("checkpoint は形の版・境界・版・SHA・表・点検結果・J4・持ち越しを持ち、t1-t2 では試験の組を持たない", async () => {
    const checkpoint = buildStageCheckpoint({ materials: await materials(), versions: VERSIONS, planSha256: PLAN_SHA, sourceSha256: SOURCE_SHA });
    expect(checkpoint.schema_version).toBe(STAGE_CHECKPOINT_SCHEMA);
    expect(Object.keys(checkpoint)).toEqual([
      "schema_version",
      "boundary",
      "versions",
      "plan_sha256",
      "source_sha256",
      "name_table",
      "semantic_check",
      "judge_advice",
      "carry_over",
    ]);
    // 出力ダイジェストは書いた JSON を読み直しても同じ（正規の形で並べた SHA-256）
    expect(await stageOutputDigest(JSON.parse(stageJsonText(checkpoint)))).toBe(await stageOutputDigest(checkpoint));
  });

  it("対象と判定は R1〜R4（unresolved の R5 を含まず、reject の R3 を含む）、持ち越しは R3・R5 で、照合を通る", async () => {
    const result = await verify(await written());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resume.semanticCheck.targets).toEqual(["R1", "R2", "R3", "R4"]);
    expect(result.resume.carryOver.entries.map((entry) => entry.requirementId)).toEqual(["R3", "R5"]);
    expect(result.input).toEqual({ checkpoint: "cp.json", boundary: "t1-t2", output_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it.each([
    ["unresolved の R5 を対象に足す", (cp: Record<string, any>) => {
      cp["semantic_check"]["targets"].push("R5");
      cp["semantic_check"]["judgments"].push({ requirementId: "R5", verdict: "accept" });
    }, "stage-input:targets"],
    ["reject の R3 を対象から外す", (cp: Record<string, any>) => {
      cp["semantic_check"]["targets"] = ["R1", "R2", "R4"];
      cp["semantic_check"]["judgments"] = cp["semantic_check"]["judgments"].filter((j: { requirementId: string }) => j.requirementId !== "R3");
    }, "stage-input:targets"],
    ["判定を重ねる", (cp: Record<string, any>) => {
      cp["semantic_check"]["judgments"][0] = cp["semantic_check"]["judgments"][1];
    }, "stage-input:targets"],
    ["持ち越しから R5 を消す", (cp: Record<string, any>) => {
      cp["carry_over"]["entries"] = cp["carry_over"]["entries"].slice(0, 1);
    }, "stage-input:carry-over"],
    ["契約の版を変える", (cp: Record<string, any>) => {
      cp["versions"]["contract"] = "v0.1";
    }, "stage-input:version"],
    ["形の版を変える", (cp: Record<string, any>) => {
      cp["schema_version"] = "musunest.factory.v11a-stage-checkpoint/v0";
    }, "stage-input:version"],
  ] as const)("出力ダイジェストを書き直しても：%s → %s", async (_name, edit, code) => {
    expect(await verify(await written(edit))).toEqual({ ok: false, code });
  });

  it("prompt と工場の版は記録するが断らない（変えた段の前後比較のため）", async () => {
    const result = await verify(
      await written((cp: Record<string, any>) => {
        cp["versions"]["prompt"] = "v1.1a-next";
        cp["versions"]["factory"] = "0.0.1";
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("読めない・JSON でない入力は unreadable、記録が checkpoint を宣言しなければ boundary", async () => {
    const texts = await written();
    expect(await verify({ ...texts, checkpointText: null })).toEqual({ ok: false, code: "stage-input:unreadable" });
    expect(await verify({ ...texts, recordText: "{" })).toEqual({ ok: false, code: "stage-input:unreadable" });
    expect(await verify({ ...texts, recordText: JSON.stringify({ schema_version: STAGE_RUN_RECORD_SCHEMA, checkpoints: [] }) })).toEqual({
      ok: false,
      code: "stage-input:boundary",
    });
  });
});

// ── 段の走りの記録 ───────────────────────────────────────────────────

const stageRecord = (stage: StageRecord["stage"], status: StageRecord["status"]): StageRecord =>
  ({ stage, status }) as StageRecord;

function outcomeOf(overrides: Partial<StageRunOutcome> = {}): StageRunOutcome {
  return {
    stages: [stageRecord("name-table", "ok"), stageRecord("semantic-check", "ok")],
    stopped: null,
    boundaries: [],
    judgeVerdict: null,
    finalCarryOver: null,
    returnToPlan: false,
    costUsd: 0.01,
    durationSecs: 1,
    ...overrides,
  };
}

describe("段の通過（stage_pass）と記録の名前", () => {
  it("早期停止が無く、終了の段の最後の記録が ok なら通過", () => {
    expect(stagePassOf(outcomeOf(), "semantic-check")).toBe(true);
    expect(stagePassOf(outcomeOf(), "test-spec")).toBe(false);
    expect(
      stagePassOf(outcomeOf({ stages: [stageRecord("semantic-check", "ok"), stageRecord("semantic-check", "failed")] }), "semantic-check"),
    ).toBe(false);
    expect(stagePassOf(outcomeOf({ stopped: { stage: "carry-over", kind: "unmet" } }), "semantic-check")).toBe(false);
  });

  it("記録に stage_pass・budget_scope（stage-run）があり、verdict・pass の名前を使わず、⑦ の判定は stage_judge_verdict", () => {
    const record = buildStageRunRecord({
      range: { start: "name-table", end: "judge" },
      input: null,
      planSha256: PLAN_SHA,
      sourceSha256: SOURCE_SHA,
      checkpoints: [],
      conditions: {
        model: "m",
        effort: "high",
        documents: [],
        judge: { primary: "llm", fallback: null },
        prompt_version: "v1.1a",
        vocabulary_version: "v1",
        contract_version: "v0.2",
        factory_version: "0.0.0",
        spec_engine_version: "0.0.0",
        budget_usd: 0.3,
        deadline_ms: 600_000,
        timeout_ms: null,
      },
      outcome: outcomeOf({ stages: [stageRecord("judge", "ok")], judgeVerdict: "partial" }),
      exitCode: 0,
    });
    expect(record["stage_pass"]).toBe(true);
    expect(record["budget_scope"]).toBe("stage-run");
    expect(record["stage_judge_verdict"]).toBe("partial");
    expect(Object.keys(record)).not.toContain("verdict");
    expect(Object.keys(record)).not.toContain("pass");
  });
});

// ── 区間の表（段の名前の正本） ───────────────────────────────────────

describe("区間の表（STAGE_SEGMENTS）と範囲の段", () => {
  it("区間は 3 つで、i 番目の開始・終了・境界が既存の定数の i 番目と同じ", () => {
    expect(STAGE_SEGMENTS).toHaveLength(3);
    expect(STAGE_SEGMENTS.map((x) => x.start)).toEqual([...STAGE_STARTS]);
    expect(STAGE_SEGMENTS.map((x) => x.end)).toEqual([...STAGE_ENDS]);
    expect(STAGE_SEGMENTS.map((x) => x.boundary)).toEqual(STAGE_STARTS.map((start) => boundaryBefore(start)));
    expect(STAGE_SEGMENTS.map((x) => x.boundary).filter((b) => b !== null)).toEqual([...STAGE_BOUNDARIES]);
  });

  it("上流の台帳の部分の指紋で照らす境界は、境界の表の最初（開始 T2 の直前・上流の段だけが前にある境界）。評価の道具はこの並びで境界を選ぶ（Issue #713）", () => {
    expect(STAGE_BOUNDARIES[0]).toBe(UPSTREAM_LEDGER_BOUNDARY);
    expect(boundaryBefore("test-spec")).toBe(UPSTREAM_LEDGER_BOUNDARY);
    expect(STAGE_SEGMENTS.findIndex((segment) => segment.boundary === UPSTREAM_LEDGER_BOUNDARY)).toBe(1);
  });

  it("区間の段はすべて段の識別子の一覧にあり、開始・終了を含み、持ち越しの停止のほか区間をまたいで重ならない", () => {
    const seen = new Map<string, number>();
    for (const segment of STAGE_SEGMENTS) {
      expect(segment.stages).toContain(segment.start);
      expect(segment.stages).toContain(segment.end);
      expect(new Set(segment.stages).size).toBe(segment.stages.length);
      for (const stage of segment.stages) {
        expect(STAGE_IDS as readonly string[]).toContain(stage);
        seen.set(stage, (seen.get(stage) ?? 0) + 1);
      }
    }
    expect([...seen].filter(([, count]) => count > 1)).toEqual([["carry-over", 2]]);
    expect(STAGE_SEGMENTS[0]?.stages).toContain("carry-over");
    expect(STAGE_SEGMENTS[2]?.stages).toContain("carry-over");
    expect(STAGE_SEGMENTS[1]?.stages).not.toContain("carry-over");
  });

  it("範囲の関数：T1〜⑦ は 3 区間の段を順につなぎ、逆順・表に無い名前は空", () => {
    expect(stagesInRange("name-table", "judge")).toEqual(STAGE_SEGMENTS.flatMap((x) => [...x.stages]));
    expect(stagesInRange("write", "judge")).toEqual(STAGE_SEGMENTS[2]?.stages);
    expect(stagesInRange("test-spec", "test-spec")).toEqual(["test-spec"]);
    expect(stagesInRange("test-spec", "semantic-check")).toEqual([]);
    expect(stagesInRange("write", "test-spec")).toEqual([]);
    expect(stagesInRange("decl-check", "judge")).toEqual([]);
    expect(stagesInRange("name-table", "write")).toEqual([]);
  });

  it.each([
    [{ start: "name-table", end: "semantic-check" }, ["name-table", "semantic-check"]],
    [{ start: "test-spec", end: "test-spec" }, ["test-spec"]],
    [{ start: "write", end: "judge" }, ["write", "static-check", "judge"]],
    [{ start: "name-table", end: "judge" }, ["name-table", "semantic-check", "test-spec", "write", "judge"]],
  ] as const)("既存の段の走り %j の記録の段は範囲の段の並びの内側", (range, ran) => {
    const resolved = resolveStageRange({ ...range, hasInput: range.start !== "name-table" });
    expect("code" in resolved).toBe(false);
    const allowed = stagesInRange(range.start, range.end);
    const record = buildStageRunRecord({
      range,
      input: null,
      planSha256: PLAN_SHA,
      sourceSha256: SOURCE_SHA,
      checkpoints: [],
      conditions: {
        model: "m",
        effort: "high",
        documents: [],
        judge: { primary: "llm", fallback: null },
        prompt_version: "v1.1a",
        vocabulary_version: "v1",
        contract_version: "v0.2",
        factory_version: "0.0.0",
        spec_engine_version: "0.0.0",
        budget_usd: 0.3,
        deadline_ms: 600_000,
        timeout_ms: null,
      },
      outcome: outcomeOf({ stages: ran.map((stage) => stageRecord(stage, "ok")) }),
      exitCode: 0,
    });
    const recorded = (record["stages"] as readonly { stage: string }[]).map((x) => x.stage);
    expect(recorded).toEqual([...ran]);
    for (const stage of recorded) expect(allowed as readonly string[]).toContain(stage);
  });
});

// ── v1.2 の段の走り（Issue #637）──────────────────────────────────────

describe("v1.2 の段の走りの別名と記録の欄（Issue #637）", () => {
  const CONDITIONS = {
    model: "m",
    effort: "high",
    documents: [],
    judge: { primary: "llm", fallback: null },
    prompt_version: "v1.1a",
    vocabulary_version: "v1",
    contract_version: "v0.2",
    factory_version: "0.0.0",
    spec_engine_version: "0.0.0",
    budget_usd: 0.3,
    deadline_ms: 600_000,
    timeout_ms: null,
  } as const;
  const recordOf = (outcome: StageRunOutcome, range: { start: "name-table" | "test-spec" | "write"; end: "semantic-check" | "test-spec" | "judge" }, v12?: { testSpecInRange: boolean }) =>
    buildStageRunRecord({
      range,
      input: null,
      planSha256: PLAN_SHA,
      sourceSha256: SOURCE_SHA,
      checkpoints: [],
      conditions: CONDITIONS,
      outcome,
      exitCode: 0,
      ...(v12 === undefined ? {} : { v12 }),
    });

  it("別名は区間 0 の C1 語彙だけで、正本の開始の名前に写る（段の表は変えない。別名そのものは表の外）", () => {
    expect(STAGE_START_ALIASES_V12).toEqual({ vocabulary: "name-table" });
    for (const [alias, start] of Object.entries(STAGE_START_ALIASES_V12)) {
      expect(STAGE_STARTS as readonly string[]).not.toContain(alias);
      expect(STAGE_SEGMENTS.find((segment) => segment.start === start)?.stages).toContain(alias);
      expect(resolveStageRange({ start: alias, hasInput: false })).toEqual({ code: "stage-range:unknown" });
    }
  });

  it("v12 を渡さない記録（v1.1a）は、回す部分が数を返しても v12_calls・test_spec を持たず、渡さない記録とバイト列で同じ", () => {
    const plain = recordOf(outcomeOf(), { start: "name-table", end: "test-spec" });
    const withCounts = recordOf(
      outcomeOf({ v12Calls: { real_attempts: { limit: 1, used: 1 } }, testSpec: { tests: 1, dropped_tests: 0, coverage_units: 1 } }),
      { start: "name-table", end: "test-spec" },
    );
    expect(stageJsonText(withCounts)).toBe(stageJsonText(plain));
    expect(Object.keys(plain)).not.toContain("v12_calls");
    expect(Object.keys(plain)).not.toContain("test_spec");
  });

  it("v12 を渡す記録は末尾に v12_calls と（範囲が T2 を含むとき）test_spec を足し、T2 に届かなければ test_spec は null", () => {
    const counts = { tests: 7, dropped_tests: 2, coverage_units: 5 };
    const calls = { real_attempts: { limit: 144, used: 9 } };
    const plainKeys = Object.keys(recordOf(outcomeOf(), { start: "name-table", end: "test-spec" }));
    const reached = recordOf(outcomeOf({ v12Calls: calls, testSpec: counts }), { start: "name-table", end: "test-spec" }, { testSpecInRange: true });
    expect(Object.keys(reached)).toEqual([...plainKeys, "v12_calls", "test_spec"]);
    expect(reached["test_spec"]).toEqual(counts);
    expect(reached["v12_calls"]).toEqual(calls);
    const notReached = recordOf(outcomeOf({ v12Calls: calls }), { start: "name-table", end: "test-spec" }, { testSpecInRange: true });
    expect(notReached["test_spec"]).toBeNull();
    // 範囲が T2 を含まない・旗 ids が off（数が無い）なら欄を持たない
    const outside = recordOf(outcomeOf({ v12Calls: calls }), { start: "name-table", end: "semantic-check" }, { testSpecInRange: false });
    expect(Object.keys(outside)).toEqual([...plainKeys, "v12_calls"]);
    const idsOff = recordOf(outcomeOf(), { start: "name-table", end: "semantic-check" }, { testSpecInRange: false });
    expect(Object.keys(idsOff)).toEqual(plainKeys);
  });

  it("⑦ を流した結果の宣言と検証の数は、v12 を渡す記録だけ末尾に declaration（固定の名前・SHA-256・静的チェックの合否）と verification を足す。v1.1a の記録はバイト列で同じ（Issue #687）", () => {
    const declaration = { source: "app: {}\n", sha256: "c".repeat(64), staticCheckPassed: false };
    const verification = {
      table_sha256: "d".repeat(64),
      test_suite_sha256: "e".repeat(64),
      declaration_sha256: "c".repeat(64),
      checked_declaration_sha256s: ["c".repeat(64)],
      decl_check: { exhausted: 0, malformed: 0, rejected: 0 },
      b3_misses: null,
      c7_mismatches: null,
      unresolved: null,
      not_run: STAGE_VERIFICATION_NOT_RUN_STATIC_CHECK,
      stop_reason: "stagnation",
      round_trips: 1,
    } as const;
    const range = { start: "write", end: "judge" } as const;
    const judged = outcomeOf({ judgeVerdict: "none", declaration, verification });
    expect(stageJsonText(recordOf(judged, range))).toBe(stageJsonText(recordOf(outcomeOf({ judgeVerdict: "none" }), range)));
    const v12 = recordOf(judged, range, { testSpecInRange: false });
    expect(Object.keys(v12).slice(-2)).toEqual(["declaration", "verification"]);
    expect(v12["declaration"]).toEqual({ file: STAGE_DECLARATION_FILE, sha256: "c".repeat(64), static_check_passed: false });
    expect(v12["verification"]).toEqual(verification);
    // 原文は記録に載せない（ファイルに書く）。名前は --out の直下で、納品物の成果物の置き場所（artifacts/）と重ならない
    expect(JSON.stringify(v12)).not.toContain("app: {}");
    expect(STAGE_DECLARATION_FILE).not.toContain("/");
    expect([STAGE_RUN_RECORD_FILE, stageCheckpointFile("t1-t2"), stageCheckpointFile("t2-b1"), DIAGNOSTICS_TABLE_ROUNDS_FILE]).not.toContain(STAGE_DECLARATION_FILE);
    // ⑦ を流していない結果（欄が無い）は v12 を渡しても足さない
    expect(Object.keys(recordOf(outcomeOf(), range, { testSpecInRange: false }))).not.toContain("declaration");
  });
});

describe("段の走りの記録の search_repair（探索の出来事の列。Issue #746）", () => {
  const CONDITIONS = {
    model: "m",
    effort: "high",
    documents: [],
    judge: { primary: "llm", fallback: null },
    prompt_version: "v1.1a",
    vocabulary_version: "v1",
    contract_version: "v0.2",
    factory_version: "0.0.0",
    spec_engine_version: "0.0.0",
    budget_usd: 0.3,
    deadline_ms: 600_000,
    timeout_ms: null,
  } as const;
  const range = { start: "write", end: "judge" } as const;
  const recordOf = (outcome: StageRunOutcome, v12?: { testSpecInRange: boolean }) =>
    buildStageRunRecord({
      range,
      input: null,
      planSha256: PLAN_SHA,
      sourceSha256: SOURCE_SHA,
      checkpoints: [],
      conditions: CONDITIONS,
      outcome,
      exitCode: 1,
      ...(v12 === undefined ? {} : { v12 }),
    });
  const SENTINEL = "SENTINEL-746";
  const sha = "a".repeat(64);
  /** 番兵を許していない欄に混ぜた出来事の列（型の外の欄・違反の外の欄・往復の結果の外の欄） */
  const log = (): StageSearchRepairLog =>
    ({
      events: [
        {
          kind: "version",
          seq: 0,
          origin: "write",
          round: 0,
          declarationSha256: sha,
          parentSeq: null,
          comparedSeq: null,
          violations: {
            kind: "counted",
            declarationSha256: sha,
            breakdown: { "correspondence-miss": 0, "decl-rejection": 1, "decl-unmarked": 0, "test-mismatch": 2, "test-unresolved": 0 },
            knownTotal: 3,
            unknown: null,
            requirementId: SENTINEL,
          },
          failureSetSha256: "b".repeat(64),
          adoption: "adopted",
          discarded: null,
          makeMs: 1000,
          evaluateMs: 200,
          makeRows: { first: 0, last: 0 },
          evaluateRows: { first: 1, last: 4 },
          requirementId: SENTINEL,
          unmarked: [SENTINEL],
        },
        {
          kind: "round",
          seq: 1,
          round: 1,
          hand: "field-repair",
          locations: 1,
          unlocated: 0,
          additions: 0,
          result: { kind: "refused", refusal: "bytes", message: SENTINEL },
          durationMs: null,
          rows: { first: 5, last: 5 },
          problems: [{ message: SENTINEL }],
        },
        {
          kind: "recount",
          seq: 2,
          cause: "coverage",
          declarationSha256: sha,
          beforeSeq: 0,
          violations: null,
          failureSetSha256: null,
          rows: null,
          testId: SENTINEL,
        },
        {
          kind: "version",
          seq: 3,
          origin: "repair",
          round: 1,
          declarationSha256: sha,
          parentSeq: 0,
          comparedSeq: null,
          violations: null,
          failureSetSha256: null,
          adoption: "pending",
          discarded: null,
          makeMs: 3000,
          evaluateMs: null,
          makeRows: { first: 6, last: 6 },
          evaluateRows: { first: 7, last: 8 },
        },
      ],
      bestSeq: 0,
      rewritten: false,
      stop: { reason: "stopped", stage: "decl-check", kind: "malformed" },
    }) as unknown as StageSearchRepairLog;

  it("v12 を渡す記録だけ、探索の出来事の列を末尾の search_repair に足す。v1.1a の記録と、列の無い結果はバイト列で同じ", () => {
    const withLog = outcomeOf({ searchRepair: log() });
    expect(stageJsonText(recordOf(withLog))).toBe(stageJsonText(recordOf(outcomeOf())));
    const plain = recordOf(outcomeOf(), { testSpecInRange: false });
    const v12 = recordOf(withLog, { testSpecInRange: false });
    expect(Object.keys(v12)).toEqual([...Object.keys(plain), "search_repair"]);
    expect(stageJsonText({ ...v12, search_repair: undefined })).toBe(stageJsonText(plain));
  });

  it("投影は許した欄（数・列挙値・SHA-256・seq・ミリ秒・段の行の添字）だけを写し、未決は pending・null のまま。型の外の欄の番兵は出ない", () => {
    const projected = recordOf(outcomeOf({ searchRepair: log() }), { testSpecInRange: false })["search_repair"];
    expect(JSON.stringify(projected)).not.toContain(SENTINEL);
    expect(projected).toEqual({
      events: [
        {
          seq: 0,
          event: "version",
          origin: "write",
          round: 0,
          declaration_sha256: sha,
          parent_seq: null,
          compared_seq: null,
          violations: {
            kind: "counted",
            declaration_sha256: sha,
            breakdown: { "correspondence-miss": 0, "decl-rejection": 1, "decl-unmarked": 0, "test-mismatch": 2, "test-unresolved": 0 },
            known_total: 3,
            unknown: null,
          },
          failure_set_sha256: "b".repeat(64),
          adoption: "adopted",
          discarded: null,
          make_ms: 1000,
          evaluate_ms: 200,
          stage_rows: { make: { first: 0, last: 0 }, evaluate: { first: 1, last: 4 } },
        },
        {
          seq: 1,
          event: "round",
          round: 1,
          hand: "field-repair",
          locations: 1,
          unlocated: 0,
          additions: 0,
          result: { kind: "refused", refusal: "bytes" },
          duration_ms: null,
          stage_rows: { first: 5, last: 5 },
        },
        {
          seq: 2,
          event: "recount",
          cause: "coverage",
          declaration_sha256: sha,
          before_seq: 0,
          violations: null,
          failure_set_sha256: null,
          stage_rows: null,
        },
        {
          seq: 3,
          event: "version",
          origin: "repair",
          round: 1,
          declaration_sha256: sha,
          parent_seq: 0,
          compared_seq: null,
          violations: null,
          failure_set_sha256: null,
          adoption: "pending",
          discarded: null,
          make_ms: 3000,
          evaluate_ms: null,
          stage_rows: { make: { first: 6, last: 6 }, evaluate: { first: 7, last: 8 } },
        },
      ],
      best_seq: 0,
      rewritten: false,
      stop: { reason: "stopped", stage: "decl-check", kind: "malformed" },
    });
  });

  it("違反の内訳・不明の理由の内側に混ぜた ID・文の欄の番兵も出ない（内訳は固定の 5 つの鍵だけを写す。版・数え直しの両方。Issue #746 の R2）", () => {
    const extra = { requirementId: SENTINEL, testId: SENTINEL, message: SENTINEL };
    const breakdown = { "correspondence-miss": 1, "decl-rejection": null, "decl-unmarked": null, "test-mismatch": 3, "test-unresolved": 0, ...extra };
    const counted = {
      kind: "counted",
      declarationSha256: sha,
      breakdown,
      knownTotal: 4,
      unknown: { reason: "name-check", declarationSha256: sha, ...extra },
      ...extra,
    };
    const leaky = {
      events: [
        { ...log().events[0], violations: counted },
        { ...log().events[2], violations: { ...counted, unknown: null }, failureSetSha256: "c".repeat(64), rows: { first: 9, last: 9 } },
        { ...log().events[3], violations: { kind: "static-check-failed", declarationSha256: sha, breakdown, ...extra } },
      ],
      bestSeq: 0,
      rewritten: false,
      stop: { reason: "completed", stage: null, kind: null },
    } as unknown as StageSearchRepairLog;
    const projected = recordOf(outcomeOf({ searchRepair: leaky }), { testSpecInRange: false })["search_repair"] as {
      readonly events: readonly { readonly violations: unknown }[];
    };
    expect(JSON.stringify(projected)).not.toContain(SENTINEL);
    const fixedBreakdown = { "correspondence-miss": 1, "decl-rejection": null, "decl-unmarked": null, "test-mismatch": 3, "test-unresolved": 0 };
    expect(projected.events.map((event) => event.violations)).toEqual([
      { kind: "counted", declaration_sha256: sha, breakdown: fixedBreakdown, known_total: 4, unknown: { reason: "name-check", declaration_sha256: sha } },
      { kind: "counted", declaration_sha256: sha, breakdown: fixedBreakdown, known_total: 4, unknown: null },
      { kind: "static-check-failed", declaration_sha256: sha },
    ]);
    // 内訳の鍵の順は納品物（violationsJson）と同じ
    expect(Object.keys((projected.events[0] as { readonly violations: { readonly breakdown: object } }).violations.breakdown)).toEqual([
      "correspondence-miss",
      "decl-rejection",
      "decl-unmarked",
      "test-mismatch",
      "test-unresolved",
    ]);
  });
});

// ── 回ごとの行（旗 `v12.ids` の C2・C3。Issue #699）────────────────────────

describe("回ごとの行の診断のファイル（Issue #699）", () => {
  const recordOf = (outcome: StageRunOutcome) =>
    buildStageRunRecord({
      range: { start: "name-table", end: "semantic-check" },
      input: null,
      planSha256: PLAN_SHA,
      sourceSha256: SOURCE_SHA,
      checkpoints: [],
      conditions: {
        model: "m",
        effort: "high",
        documents: [],
        judge: { primary: "llm", fallback: null },
        prompt_version: "v1.1a",
        vocabulary_version: "v1",
        contract_version: "v0.2",
        factory_version: "0.0.0",
        spec_engine_version: "0.0.0",
        budget_usd: 0.3,
        deadline_ms: 600_000,
        timeout_ms: null,
      },
      outcome,
      exitCode: 0,
    });
  const roundsOf = async (): Promise<readonly TableRoundRecord[]> => {
    const tableSha256 = await nameTableSha256(TABLE);
    return [
      {
        round: 1,
        ok: "ok",
        table: {
          table_sha256: tableSha256,
          rows: TABLE.rows,
          ownership: TABLE.ownership,
          verification: TABLE.verification,
          classification: TABLE.classification,
        },
        normalized: [],
        rewrite: null,
        semantic_check: { table_sha256: tableSha256, targets: ["R1", "R2"], judgments: JUDGMENTS.slice(0, 2), advice: [] },
        adopted: false,
      },
      {
        round: 2,
        ok: "unmet",
        table: null,
        normalized: null,
        rewrite: { requirement_ids: ["R3"], rewritten: 1, kept: 4 },
        semantic_check: null,
        adopted: false,
      },
    ];
  };

  it("行が無ければファイルを作らず、行があれば diagnostics/table-rounds.json に rounds として並べる（同じ入力から同じバイト列）", async () => {
    expect(buildTableRoundsFile([])).toEqual([]);
    const rounds = await roundsOf();
    const files = buildTableRoundsFile(rounds);
    expect(files.map((file) => file.path)).toEqual([DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    expect(DIAGNOSTICS_TABLE_ROUNDS_FILE).toBe("diagnostics/table-rounds.json");
    expect(files[0]?.text).toBe(`${JSON.stringify({ rounds }, null, 2)}\n`);
    expect(JSON.parse(files[0]?.text ?? "{}")).toEqual({ rounds });
  });

  it("段の走りの記録は回ごとの行を載せない（結果の欄だけ。段の走りの記録はバイト列で同じ）", async () => {
    const rounds = await roundsOf();
    const plain = recordOf(outcomeOf());
    const withRounds = recordOf(outcomeOf({ tableRounds: rounds }));
    expect(stageJsonText(withRounds)).toBe(stageJsonText(plain));
    expect(Object.keys(plain)).not.toContain("table_rounds");
    expect(Object.keys(plain)).not.toContain("tableRounds");
  });
});
