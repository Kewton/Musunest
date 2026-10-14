// 票と成績の集計（plan/claim-score.ts）の unit テスト（Issue #459）。
//
// **合否は宣言しない。** 固定するのは、仕分けの形だけが種類で採点されること、経路が宣言の一覧どおりに
// 組まれること、T と S の票が同じ対に数えられないこと、`undetermined` が分母に入らないこと、混同表と率が
// 分母つきで出ることである。
import { describe, expect, it } from "vitest";
import {
  SCORE_PATHS,
  expectedDestination,
  scoreClaims,
  validateLabels,
  type LabelSet,
} from "./claim-score.js";
import type { ClaimFormId, ClaimInput, ClaimVote, FormVoteRecord } from "./claim-forms.js";

const CLAIMS: readonly ClaimInput[] = [
  { id: "c1", runId: "run", index: 0, requirementId: "R-1", requirementText: "要件 1", part: "p1", reason: "r1", constraintIds: ["記録"], alternative: null },
  { id: "c2", runId: "run", index: 1, requirementId: "R-2", requirementText: "要件 2", part: "p2", reason: "r2", constraintIds: ["合計"], alternative: null },
  { id: "c3", runId: "run", index: 2, requirementId: "R-3", requirementText: "要件 3", part: "p3", reason: "r3", constraintIds: ["記録"], alternative: null },
];

function vote(claimId: string, form: ClaimFormId, value: ClaimVote, evidenceId: string | null = null): FormVoteRecord {
  return {
    claimId,
    claimIndex: 0,
    form,
    operation: "forward",
    vote: { vote: value, evidenceId, insideClaimConstraintIds: evidenceId !== null },
  };
}

/** c1 は正しい穴（表現できない）→ 受理。c2 は曖昧さ（誤って語彙の穴とした）→ 未点検。c3 は資料不足 */
function fixedVotes(): readonly FormVoteRecord[] {
  return [
    vote("c1", "T1", "vocabulary-hole"),
    vote("c1", "T2", "vocabulary-hole"),
    vote("c1", "T3", "vocabulary-hole"),
    vote("c1", "S1", "supports"),
    vote("c1", "S2", "restricts", "記録"),
    vote("c1", "S3", "restricts", "記録"),
    vote("c1", "S4", "restricts", "記録"),
    vote("c2", "T1", "vocabulary-hole"),
    vote("c2", "T2", "vocabulary-hole"),
    vote("c2", "T3", "vocabulary-hole"),
    vote("c2", "S1", "not-stated"),
    vote("c2", "S2", "not-found"),
    vote("c2", "S3", "not-found"),
    vote("c2", "S4", "not-found"),
    vote("c3", "T1", "unknown-answer"),
    vote("c3", "T2", "unknown-answer"),
    vote("c3", "T3", "unknown-answer"),
    vote("c3", "S1", "failed"),
    vote("c3", "S2", "failed"),
    vote("c3", "S3", "failed"),
    vote("c3", "S4", "failed"),
  ];
}

const LABELS: LabelSet = {
  docVersion: "v1",
  docHash: "hash",
  labels: [
    { id: "c1", kind: "vocabulary-hole", expressible: "false" },
    { id: "c2", kind: "ambiguity", expressible: "true" },
    { id: "c3", kind: "vocabulary-hole", expressible: "undetermined" },
  ],
};

describe("仕分けの形だけを種類で採点する（Issue #459）", () => {
  const score = scoreClaims({ claims: CLAIMS, votes: fixedVotes(), labels: LABELS, rule: "majority" });

  it("仕分けの形（T1〜T3）は正誤を持つ", () => {
    expect(score.answer.triage.map((entry) => entry.form)).toEqual(["T1", "T2", "T3"]);
    // c1（穴）は正しく、c2（曖昧さ）と c3（答えが unknown-answer）は誤り。種類が undetermined の申告だけが対象外
    expect(score.answer.triage[0]).toEqual({ form: "T1", correct: 1, incorrect: 2, undetermined: 0 });
  });

  it("裏付けの生の答えは採点せず、分布と保留の件数だけ出す", () => {
    const s2 = score.answer.support.find((entry) => entry.form === "S2");
    expect(s2?.notFound).toBe(1);
    expect(s2?.counts["restricts"]).toBe(1);
    // 採点の欄（correct/incorrect）を持たない
    expect(s2).not.toHaveProperty("correct");
  });

  it("同じ種類の形の対の同時誤りと不一致を出す（T の対だけ）", () => {
    for (const pair of score.answer.pairs) {
      expect(["T1", "T2", "T3"]).toContain(pair.a);
      expect(["T1", "T2", "T3"]).toContain(pair.b);
    }
    expect(score.answer.pairs).toHaveLength(3);
  });
});

describe("経路は宣言の一覧どおりに組まれる（Issue #459）", () => {
  const score = scoreClaims({ claims: CLAIMS, votes: fixedVotes(), labels: LABELS, rule: "majority" });

  it("SCORE_PATHS の各経路が、適用できる申告について組まれる", () => {
    const paths = new Set(score.paths.map((entry) => entry.path));
    for (const path of SCORE_PATHS) expect(paths).toContain(path);
  });

  it("基準の経路（T1＋S1）の行き先が正解と比べられる", () => {
    const c1 = score.paths.find((entry) => entry.claimId === "c1" && entry.path === "T1+S1");
    expect(c1?.destination).toBe("accept");
    const c2 = score.paths.find((entry) => entry.claimId === "c2" && entry.path === "T1+S1");
    expect(c2?.destination).toBe("unchecked");
  });
});

describe("混同表と率は分母つきで出る（Issue #459）", () => {
  const score = scoreClaims({ claims: CLAIMS, votes: fixedVotes(), labels: LABELS, rule: "majority" });

  it("混同表が正解 × 行き先で出る", () => {
    expect(score.confusion.some((cell) => cell.expected === "accept" && cell.actual === "accept")).toBe(true);
    expect(score.confusion.some((cell) => cell.expected === "ambiguity" && cell.actual === "unchecked")).toBe(true);
  });

  it("率に分母が明示される", () => {
    const byName = new Map(score.rates.map((rate) => [rate.name, rate]));
    expect(byName.get("真の穴の取り落としと未確定")).toEqual({ name: "真の穴の取り落としと未確定", numerator: 0, denominator: 1 });
    expect(byName.get("曖昧さの取りこぼし")).toEqual({ name: "曖昧さの取りこぼし", numerator: 1, denominator: 1 });
    // 語彙の穴（資料不足を除く）の分母は 1（c1 だけ）
    expect(byName.get("語彙の穴を曖昧さとする誤り")?.denominator).toBe(1);
    expect(byName.get("再点検への回付率")?.denominator).toBe(3);
  });

  it("undetermined は採点の対象外で、件数だけ出す", () => {
    expect(score.undetermined).toBe(1);
    expect(expectedDestination({ id: "c3", kind: "vocabulary-hole", expressible: "undetermined" })).toBeNull();
  });
});

describe("正解のファイルの不備を検出する（Issue #459）", () => {
  it("ID の重複・不足・余分と文書の不一致", () => {
    const problems = validateLabels(
      {
        docVersion: "v1",
        docHash: "other",
        labels: [
          { id: "c1", kind: "vocabulary-hole", expressible: "false" },
          { id: "c1", kind: "ambiguity", expressible: "true" },
          { id: "extra", kind: "ambiguity", expressible: "true" },
        ],
      },
      ["c1", "c2"],
      "hash",
    );
    expect(problems.duplicates).toEqual(["c1"]);
    expect(problems.missing).toEqual(["c2"]);
    expect(problems.extra).toEqual(["extra"]);
    expect(problems.docMismatch).toEqual({ expected: "other", actual: "hash" });
  });
});
