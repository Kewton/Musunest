// 納品物に足す v1.1α の記録（v11a/bundle-v11a.ts）の試験（07-architecture-v1.1a.md §1.4。Issue #510）。
import { describe, expect, it } from "vitest";
import * as bundleModule from "../bundle.js";
import { ARTIFACTS_DIR } from "../bundle.js";
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { requirementsFromPlan } from "../pipeline.js";
import { fixtureNonRequirementList, fixtureNonRequirementTable, fixtureTable } from "./__tests__/fixtures.js";
import {
  buildStageCheckpoint,
  buildV11aArtifacts,
  stageJsonText,
  stageOutputDigest,
  verifyStageInput,
  STAGE_RUN_RECORD_SCHEMA,
  V11A_ARTIFACT_NAMES,
  type V11aRecordsInput,
} from "./bundle-v11a.js";
import { deriveCarryOver } from "./carry-over.js";
import { nameTableSha256 } from "./names.js";
import { undeterminedJudgeAdvice } from "./run.js";
import { JUDGE_ADVICE_THRESHOLDS } from "./stages/judge-advice.js";

function input(): V11aRecordsInput {
  const table = fixtureTable();
  return {
    nameTable: { table, sha256: "a".repeat(64) },
    semanticCheck: [
      {
        round: 1,
        tableSha256: "a".repeat(64),
        targets: ["R1", "R2"],
        judgments: [
          { requirementId: "R1", verdict: "accept" },
          { requirementId: "R2", verdict: "reject", kind: "missing-target", quote: "担当者" },
        ],
        advice: [{ requirementId: "R2", id: "s.members", mark: "unclear" }],
      },
    ],
    judgeAdvice: [
      {
        round: 1,
        tableSha256: "a".repeat(64),
        record: {
          thresholds: JUDGE_ADVICE_THRESHOLDS,
          requests: [
            {
              requirementId: "R2",
              adapter: "fake",
              model: "fake-judge",
              questions: [
                {
                  questionId: "need:R2:s.members",
                  requirementId: "R2",
                  id: "s.members",
                  value: 0.5,
                  mark: "unclear",
                  llmUnknownConfidence: false,
                  undetermined: null,
                },
              ],
            },
          ],
        },
      },
    ],
    testSpec: {
      suite: { tests: [] },
      sha256: "b".repeat(64),
      observes: new Map([
        ["t2", "value"],
        ["t1", "when"],
      ]),
      coverage: [{ requirementId: "R3", targetId: "o.closeItem", key: "{}" }],
      overturnedTestIds: ["t1"],
      coverageChecks: [{ overturnedTestIds: ["t1"], losses: [] }],
    },
    declCheck: {
      limit: 6,
      versions: [
        {
          declarationSha256: "c".repeat(64),
          targets: ["R1"],
          judgments: [{ requirementId: "R1", verdict: "accept" }],
          marks: [],
          extraElements: [{ kind: "computation", entity: null, name: "base", path: "spec.computed[1]" }],
          remainingChecks: 5,
        },
      ],
    },
    carryOver: {
      entries: [{ requirementId: "R2", reasons: [{ origin: "semantic-check", reason: "missing-target" }] }],
      excludedRowIds: ["f.member.title"],
      remainingRequirementIds: ["R1"],
    },
    verification: {
      tableSha256: "a".repeat(64),
      testSuiteSha256: "b".repeat(64),
      declarationSha256: "c".repeat(64),
      checkedDeclarationSha256s: ["c".repeat(64)],
      declCheck: { exhausted: 0, malformed: 1, rejected: 0 },
    },
  };
}

describe("v1.1α の 7 つの記録", () => {
  it("名前が定数と一致し、成果物の置き場所の下にある", () => {
    const artifacts = buildV11aArtifacts(input());
    expect(artifacts.map((artifact) => artifact.path)).toEqual(Object.values(V11A_ARTIFACT_NAMES));
    expect(Object.values(V11A_ARTIFACT_NAMES)).toEqual([
      "artifacts/name-table.json",
      "artifacts/test-spec.json",
      "artifacts/semantic-check.json",
      "artifacts/decl-check.json",
      "artifacts/carry-over.json",
      "artifacts/judge-advice.json",
      "artifacts/verification-v11a.json",
    ]);
    for (const path of Object.values(V11A_ARTIFACT_NAMES)) expect(path.startsWith(`${ARTIFACTS_DIR}/`)).toBe(true);
  });

  it("同じ入力で同じバイト列（決まった字下げの JSON・末尾に改行 1 つ）", () => {
    const first = buildV11aArtifacts(input());
    const second = buildV11aArtifacts(input());
    expect(second).toEqual(first);
    for (const artifact of first) {
      expect(artifact.text.endsWith("}\n")).toBe(true);
      expect(`${JSON.stringify(JSON.parse(artifact.text), null, 2)}\n`).toBe(artifact.text);
    }
  });

  it("v1 の成果物の path と重ならない", () => {
    const v1Paths = Object.entries(bundleModule)
      .filter(([name, value]) => name.endsWith("_FILE") && typeof value === "string")
      .map(([, value]) => value as string);
    expect(v1Paths).toContain(bundleModule.VERIFICATION_FILE);
    expect(v1Paths).toContain(bundleModule.TEST_SUITE_FILE);
    for (const path of Object.values(V11A_ARTIFACT_NAMES)) expect(v1Paths).not.toContain(path);
  });

  it("記録の中身：表の SHA・組・observes・持ち越し・追加の要素・件数", () => {
    const byPath = new Map(buildV11aArtifacts(input()).map((artifact) => [artifact.path, JSON.parse(artifact.text)]));
    expect(byPath.get(V11A_ARTIFACT_NAMES.nameTable).table_sha256).toBe("a".repeat(64));
    expect(byPath.get(V11A_ARTIFACT_NAMES.testSpec).observes).toEqual({ t2: "value", t1: "when" });
    expect(byPath.get(V11A_ARTIFACT_NAMES.testSpec).overturned_test_ids).toEqual(["t1"]);
    expect(byPath.get(V11A_ARTIFACT_NAMES.carryOver).entries[0].reasons[0].origin).toBe("semantic-check");
    expect(byPath.get(V11A_ARTIFACT_NAMES.declCheck).versions[0].extra_elements[0].name).toBe("base");
    expect(byPath.get(V11A_ARTIFACT_NAMES.declCheck).versions[0].remaining_checks).toBe(5);
    expect(byPath.get(V11A_ARTIFACT_NAMES.judgeAdvice).rounds[0].thresholds).toEqual(JUDGE_ADVICE_THRESHOLDS);
    expect(byPath.get(V11A_ARTIFACT_NAMES.verification).decl_check).toEqual({ exhausted: 0, malformed: 1, rejected: 0 });
  });
});

// ── 要件でない文の記録（持ち越しの記録の non_requirements。Issue #550）──────────────────────────────

describe("持ち越しの記録の non_requirements（T1'' が受理した要件でない文。Issue #550）", () => {
  it("要件でない文が無ければ欄を書かない（今の記録とバイト列で同じ）。あれば末尾に並びを書き、ほかの欄は今のまま", () => {
    const plain = buildV11aArtifacts(input());
    const carryText = (artifacts: ReturnType<typeof buildV11aArtifacts>) => artifacts.find((artifact) => artifact.path === V11A_ARTIFACT_NAMES.carryOver)!.text;
    expect(Object.keys(JSON.parse(carryText(plain)) as object)).toEqual(["entries", "excluded_row_ids", "remaining_requirement_ids"]);
    const base = input();
    const withNon = buildV11aArtifacts({ ...base, carryOver: { ...base.carryOver, nonRequirements: ["R6"] } });
    const parsed = JSON.parse(carryText(withNon)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["entries", "excluded_row_ids", "remaining_requirement_ids", "non_requirements"]);
    expect(parsed["non_requirements"]).toEqual(["R6"]);
    const { non_requirements: _omit, ...rest } = parsed;
    expect(rest).toEqual(JSON.parse(carryText(plain)));
    // 検証の記録・ほかの記録は変わらない
    expect(withNon.filter((artifact) => artifact.path !== V11A_ARTIFACT_NAMES.carryOver)).toEqual(
      plain.filter((artifact) => artifact.path !== V11A_ARTIFACT_NAMES.carryOver),
    );
  });

  /** R1〜R4・R5（unresolved）・R6（non-requirement）の確定した仕様 */
  const list = fixtureNonRequirementList();
  const PLAN: ConfirmedPlan = {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-v11a-non-requirement",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: list.requirements.map((requirement) => requirement.text).join("") }],
    requirements: list.requirements.map((requirement) => ({
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
  const TABLE = fixtureNonRequirementTable();
  const JUDGMENTS = ["R1", "R2", "R3", "R4", "R6"].map((requirementId) => ({ requirementId, verdict: "accept" as const }));

  async function written(edit: (checkpoint: Record<string, unknown>) => void = () => {}) {
    const tableSha256 = await nameTableSha256(TABLE);
    const planList = requirementsFromPlan(PLAN);
    const carryOver = await deriveCarryOver({ list: planList, table: TABLE, semanticCheck: { tableSha256, judgments: JUDGMENTS } });
    const checkpoint = buildStageCheckpoint({
      materials: {
        boundary: "t1-t2",
        table: TABLE,
        tableSha256,
        semanticCheck: { tableSha256, targets: JUDGMENTS.map((judgment) => judgment.requirementId), judgments: JUDGMENTS },
        judgeAdvice: undeterminedJudgeAdvice(planList, TABLE),
        carryOver,
      },
      versions: { vocabulary: "v1", contract: "v0.2", prompt: "v1.1a", factory: "0.0.0" },
      planSha256: "a".repeat(64),
      sourceSha256: "b".repeat(64),
    });
    const value = JSON.parse(stageJsonText(checkpoint)) as Record<string, unknown>;
    edit(value);
    const record = { schema_version: STAGE_RUN_RECORD_SCHEMA, checkpoints: [{ boundary: "t1-t2", path: "cp.json", output_digest: await stageOutputDigest(value) }] };
    return { checkpoint: value, checkpointText: stageJsonText(value), recordText: JSON.stringify(record) };
  }
  const verify = (texts: { checkpointText: string; recordText: string }) =>
    verifyStageInput({
      start: "test-spec",
      ...texts,
      checkpointFile: "cp.json",
      plan: PLAN,
      planSha256: "a".repeat(64),
      sourceSha256: "b".repeat(64),
      vocabularyVersion: "v1",
      contractVersion: "v0.2",
    });

  it("checkpoint の持ち越しに non_requirements が載り、再開の照合で導き直した持ち越しと一致して通る（再開の材料に要件でない文が残る）", async () => {
    const texts = await written();
    expect((texts.checkpoint["carry_over"] as Record<string, unknown>)["non_requirements"]).toEqual(["R6"]);
    const verified = await verify(texts);
    if (!verified.ok) throw new Error(`通るはず：${verified.code}`);
    expect(verified.resume.carryOver.nonRequirements).toEqual(["R6"]);
    expect(verified.resume.carryOver.remainingRequirementIds).toEqual(["R1", "R2", "R3", "R4"]);
  });

  it("二点測定：checkpoint から non_requirements を消す・別の要件に替えると、持ち越しの照合で断る", async () => {
    for (const change of [
      (carry: Record<string, unknown>) => delete carry["non_requirements"],
      (carry: Record<string, unknown>) => (carry["non_requirements"] = ["R1"]),
    ]) {
      const texts = await written((checkpoint) => change(checkpoint["carry_over"] as Record<string, unknown>));
      expect(await verify(texts)).toEqual({ ok: false, code: "stage-input:carry-over" });
    }
  });
});
