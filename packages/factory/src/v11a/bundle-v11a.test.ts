// 納品物に足す v1.1α の記録（v11a/bundle-v11a.ts）の試験（07-architecture-v1.1a.md §1.4。Issue #510）。
import { describe, expect, it } from "vitest";
import * as bundleModule from "../bundle.js";
import { ARTIFACTS_DIR } from "../bundle.js";
import { fixtureTable } from "./__tests__/fixtures.js";
import { buildV11aArtifacts, V11A_ARTIFACT_NAMES, type V11aRecordsInput } from "./bundle-v11a.js";
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
