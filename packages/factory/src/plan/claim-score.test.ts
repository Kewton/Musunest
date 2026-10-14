// 票と成績の集計（plan/claim-score.ts）の unit テスト（Issue #459）。
//
// **合否は宣言しない。** 固定するのは、仕分けの形だけが種類で採点されること、経路が宣言の一覧どおりに
// 組まれること、T と S の票が同じ対に数えられないこと、`undetermined` が分母に入らないこと、混同表と率が
// 分母つきで出ることである。
import { describe, expect, it } from "vitest";
import {
  SCORE_PATHS,
  expectedDestination,
  repeatAgreementOf,
  scoreClaims,
  validateLabels,
  type BaselineInput,
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

  it("率は経路ごと・層ごとに、分母つきで出る（基準の経路 T1＋S1 の all を見る）", () => {
    const byName = new Map(
      score.rates.filter((rate) => rate.path === "T1+S1" && rate.stratum === "all").map((rate) => [rate.name, rate]),
    );
    expect(byName.get("真の穴の誤った取り落としと最終の未確定")).toMatchObject({ numerator: 0, denominator: 1 });
    expect(byName.get("曖昧さの取りこぼし")).toMatchObject({ numerator: 1, denominator: 1 });
    // 語彙の穴（資料不足を除く）の分母は 1（c1 だけ）
    expect(byName.get("語彙の穴を曖昧さとする誤り")?.denominator).toBe(1);
    // 文脈不足・資料不足の申告は分母に入れない（c1・c2 の 2 件）
    expect(byName.get("再点検への回付率")?.denominator).toBe(2);
  });

  it("undetermined は採点の対象外で、件数だけ出す", () => {
    expect(score.undetermined).toBe(1);
    expect(expectedDestination({ id: "c3", kind: "vocabulary-hole", expressible: "undetermined" })).toBeNull();
  });
});

describe("基準の 2 経路を経路として受け取り、混同表・率を層別する（Issue #459・F8）", () => {
  const baselines = new Map<string, BaselineInput>([
    ["baseline:recheck", { destinations: new Map([["c1", "accept"], ["c2", "unchecked"]]), referred: new Set(["c1"]) }],
    ["baseline:no-recheck", { destinations: new Map([["c1", "unchecked"], ["c2", "unchecked"]]), referred: new Set() }],
  ]);

  it("基準の 2 経路が paths に入り、混同表の鍵に path が入る", () => {
    const scored = scoreClaims({ claims: CLAIMS, votes: fixedVotes(), labels: LABELS, rule: "majority", baselines });
    const keys = new Set(scored.paths.map((entry) => `${entry.path}:${entry.claimId}:${entry.destination}`));
    expect(keys.has("baseline:recheck:c1:accept")).toBe(true);
    expect(keys.has("baseline:no-recheck:c1:unchecked")).toBe(true);
    expect(scored.confusion.every((cell) => cell.path.length > 0)).toBe(true);
    expect(scored.confusion.some((cell) => cell.path === "baseline:recheck")).toBe(true);
  });

  it("率が経路ごと・層（run・制約 ID・要件の文の有無）ごとに出る", () => {
    const scored = scoreClaims({ claims: CLAIMS, votes: fixedVotes(), labels: LABELS, rule: "majority", baselines });
    const strata = new Set(scored.rates.map((rate) => rate.stratum));
    expect(strata.has("all")).toBe(true);
    expect(strata.has("text:yes")).toBe(true);
    expect(strata.has("constraint:yes")).toBe(true);
    expect([...strata].some((key) => key.startsWith("run:"))).toBe(true);
    // 経路も複数（基準 + 形の経路）になる
    expect(new Set(scored.rates.map((rate) => rate.path)).size).toBeGreaterThan(1);
  });

  it("文脈不足の申告は分母から外す", () => {
    const scored = scoreClaims({
      claims: CLAIMS,
      votes: fixedVotes(),
      labels: LABELS,
      rule: "majority",
      contextInsufficient: new Set(["c2"]),
    });
    expect(scored.contextInsufficient).toBe(1);
    const referral = scored.rates.find(
      (rate) => rate.path === "T1+S1" && rate.stratum === "all" && rate.name === "再点検への回付率",
    );
    // c2 を外すと分母は 1（c1 だけ）
    expect(referral?.denominator).toBe(1);
  });
});

describe("回付率は、実際に回した申告で数える（最終の行き先で代用しない。Issue #459・N3）", () => {
  it("回付→受理は数え、回付なし→未点検は数えない", () => {
    const baselines = new Map<string, BaselineInput>([
      // 回付して受理された c1 を数える（最終の行き先が accept でも 1）
      ["baseline:recheck", { destinations: new Map([["c1", "accept"], ["c2", "drop"]]), referred: new Set(["c1"]) }],
      // 回付せずに未点検の c1・c2 は数えない（0）
      ["baseline:no-recheck", { destinations: new Map([["c1", "unchecked"], ["c2", "unchecked"]]), referred: new Set() }],
    ]);
    const scored = scoreClaims({ claims: CLAIMS, votes: fixedVotes(), labels: LABELS, rule: "majority", baselines });
    const rate = (path: string) =>
      scored.rates.find((entry) => entry.path === path && entry.stratum === "all" && entry.name === "再点検への回付率");
    expect(rate("baseline:recheck")).toMatchObject({ numerator: 1, denominator: 2 });
    expect(rate("baseline:no-recheck")).toMatchObject({ numerator: 0, denominator: 2 });
  });
});

describe("選ばなかった形は、誤答にも同時誤りにも数えない（Issue #459・N4）", () => {
  it("--forms T1 だけなら、T2・T3 の誤答と対が増えない", () => {
    const scored = scoreClaims({ claims: CLAIMS, votes: fixedVotes(), labels: LABELS, rule: "majority", forms: ["T1"] });
    expect(scored.answer.triage.find((entry) => entry.form === "T2")).toEqual({ form: "T2", correct: 0, incorrect: 0, undetermined: 0 });
    expect(scored.answer.triage.find((entry) => entry.form === "T3")).toEqual({ form: "T3", correct: 0, incorrect: 0, undetermined: 0 });
    for (const pair of scored.answer.pairs) {
      expect(pair.bothWrong, `${pair.a}/${pair.b}`).toBe(0);
      expect(pair.disagree, `${pair.a}/${pair.b}`).toBe(0);
    }
  });
});

describe("反復の一致率は、初回も含め、反転と混ぜない（Issue #459・F9）", () => {
  const vote = (operation: string, value: ClaimVote): FormVoteRecord => ({
    claimId: "c1",
    claimIndex: 0,
    form: "T1",
    operation,
    vote: { vote: value, evidenceId: null, insideClaimConstraintIds: false },
  });

  it("初回を捨てない（forward と forward#2 の不一致を 0 にする）", () => {
    expect(repeatAgreementOf([vote("forward", "vocabulary-hole"), vote("forward#2", "ambiguity")])).toBe(0);
    expect(repeatAgreementOf([vote("forward", "vocabulary-hole"), vote("forward#2", "vocabulary-hole")])).toBe(1);
  });

  it("反転だけ（反復なし）では一致率を出さない", () => {
    expect(repeatAgreementOf([vote("forward", "vocabulary-hole"), vote("reverse", "ambiguity")])).toBeNull();
  });

  it("反転の反復は、順方向とは別の群として数える", () => {
    expect(
      repeatAgreementOf([
        vote("forward", "vocabulary-hole"),
        vote("forward#2", "vocabulary-hole"),
        vote("reverse", "ambiguity"),
        vote("reverse#2", "ambiguity"),
      ]),
    ).toBe(1);
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
