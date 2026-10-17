// 段単位の実行口の純粋な部分（bundle-v11a.ts の段の表・checkpoint・照合・段の走りの記録）の試験
// （08-architecture-v1.2.md §8.3。Issue #544）。
//
// 偽物の LLM も API も使わない。題材は v1.1α の共通の題材（`__tests__/fixtures.ts`。R5 は表で unresolved）。
// 受入の題材の言葉は使わない。手元の入口から流す試験（分けても同じ・照合の負例・終了コード）は `cli.test.ts`。
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import { requirementsFromPlan } from "../pipeline.js";
import type { StageRecord } from "../record.js";
import { fixtureList, fixtureTable } from "./__tests__/fixtures.js";
import {
  buildStageCheckpoint,
  buildStageRunRecord,
  resolveStageRange,
  stageJsonText,
  stageOutputDigest,
  stagePassOf,
  verifyStageInput,
  STAGE_CHECKPOINT_SCHEMA,
  STAGE_RUN_RECORD_SCHEMA,
  type BoundaryMaterials,
  type StageRunOutcome,
} from "./bundle-v11a.js";
import { deriveCarryOver } from "./carry-over.js";
import { nameTableSha256 } from "./names.js";
import { undeterminedJudgeAdvice } from "./run.js";

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
