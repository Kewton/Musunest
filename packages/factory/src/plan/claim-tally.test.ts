// 票の集計と申告の行き先（plan/claim-tally.ts）の unit テスト（Issue #459）。
//
// **全状態を真理表で固定する**——n＝0〜4 の票の全組合せを機械で生成し、各入力が有限の状態のちょうど 1 つに
// 落ちることを確かめる（`unanimous`・`majority` の両方）。
import { describe, expect, it } from "vitest";
import type { Judge, JudgeAnswer } from "../judge.js";
import { SAMPLE_DOCUMENTS } from "../stages/__tests__/prompt.js";
import type { PromptDocument } from "../stages/prompt.js";
import {
  CLAIM_DESTINATIONS,
  SUPPORT_TALLY_STATES,
  TRIAGE_TALLY_STATES,
  destinationOf,
  supportTally,
  triageTally,
  type ClaimDestination,
  type TallyRule,
} from "./claim-tally.js";
import {
  evaluateForms,
  type ClaimFormId,
  type ClaimInput,
  type ClaimVote,
} from "./claim-forms.js";
import { pathResultOf, votesByClaimForm, type ScorePath } from "./claim-score.js";

const RULES: readonly TallyRule[] = ["unanimous", "majority"];

/** 長さ n の組合せをすべて作る */
function combinations(values: readonly string[], n: number): string[][] {
  if (n === 0) return [[]];
  const rest = combinations(values, n - 1);
  return values.flatMap((value) => rest.map((tail) => [value, ...tail]));
}

describe("仕分けの集計は、各入力が有限の状態のちょうど 1 つに落ちる（Issue #459）", () => {
  it("n＝0〜4 の全組合せが TRIAGE_TALLY_STATES のどれかになる", () => {
    const values = ["ambiguity", "vocabulary-hole", "not-a-problem", "unknown-answer"];
    for (let n = 0; n <= 4; n += 1) {
      for (const votes of combinations(values, n)) {
        for (const rule of RULES) {
          const state = triageTally(votes as readonly ClaimVote[], rule);
          expect(TRIAGE_TALLY_STATES, `${votes.join(",")} / ${rule}`).toContain(state);
        }
      }
    }
  });

  it("n＝0 は no-forms", () => {
    expect(triageTally([], "unanimous")).toBe("no-forms");
    expect(supportTally([], "majority")).toBe("no-forms");
  });

  it("衝突は split、無効は分母から除かない", () => {
    expect(triageTally(["ambiguity", "vocabulary-hole"], "majority")).toBe("split");
    // n=3（無効を除かない）：語彙の穴が 2 → 厳密な過半数
    expect(triageTally(["vocabulary-hole", "vocabulary-hole", "unknown-answer"], "majority")).toBe("vocabulary-hole");
    // 有効が 1 票だけ → insufficient
    expect(triageTally(["vocabulary-hole", "unknown-answer", "unknown-answer"], "majority")).toBe("insufficient");
    // unanimous は無効 1 票で insufficient
    expect(triageTally(["vocabulary-hole", "vocabulary-hole", "unknown-answer"], "unanimous")).toBe("insufficient");
    expect(triageTally(["vocabulary-hole", "vocabulary-hole"], "unanimous")).toBe("vocabulary-hole");
  });
});

describe("裏付けの集計は、各入力が有限の状態のちょうど 1 つに落ちる（Issue #459）", () => {
  it("n＝0〜4 の全組合せが SUPPORT_TALLY_STATES のどれかになる", () => {
    const values = ["restricts", "provides", "not-found", "undecidable", "failed"];
    for (let n = 0; n <= 4; n += 1) {
      for (const votes of combinations(values, n)) {
        for (const rule of RULES) {
          const state = supportTally(votes as readonly ClaimVote[], rule);
          expect(SUPPORT_TALLY_STATES, `${votes.join(",")} / ${rule}`).toContain(state);
        }
      }
    }
  });

  it("restricts と provides が両方あれば規則に依らず split", () => {
    expect(supportTally(["restricts", "provides"], "unanimous")).toBe("split");
    expect(supportTally(["restricts", "provides", "restricts"], "majority")).toBe("split");
  });

  it("unanimous は全票 restricts → backed、全票 provides → refuted、それ以外 not-found", () => {
    expect(supportTally(["restricts", "restricts"], "unanimous")).toBe("backed");
    expect(supportTally(["provides", "provides"], "unanimous")).toBe("refuted");
    expect(supportTally(["not-found", "not-found"], "unanimous")).toBe("not-found");
  });

  it("majority は厳密な過半数。有効が過半数未満なら insufficient", () => {
    expect(supportTally(["restricts", "restricts", "not-found"], "majority")).toBe("backed");
    expect(supportTally(["restricts", "not-found", "not-found"], "majority")).toBe("not-found");
    expect(supportTally(["restricts", "not-found", "unknown-answer"], "majority")).toBe("not-found");
    expect(supportTally(["restricts", "unknown-answer", "unknown-answer"], "majority")).toBe("insufficient");
  });
});

describe("申告の行き先（Issue #459）", () => {
  it("仕分けが決まらない申告は、裏付けが backed でも受理しない", () => {
    const result = destinationOf({
      triage: "split",
      support: { kind: "tally", state: "backed", evidenceId: "節", insideClaimConstraintIds: true },
      claimConstraintIds: ["節"],
    });
    expect(result.destination).toBe("unchecked");
    expect(CLAIM_DESTINATIONS).toContain(result.destination);
  });

  it("語彙の穴かつ backed のときだけ受理し、根拠 ID を添える", () => {
    const result = destinationOf({
      triage: "vocabulary-hole",
      support: { kind: "tally", state: "backed", evidenceId: "節", insideClaimConstraintIds: true },
      claimConstraintIds: ["節"],
    });
    expect(result).toEqual({ destination: "accept", evidenceId: "節", insideClaimConstraintIds: true });
  });

  it("not-found は受理の票にしない", () => {
    expect(
      destinationOf({
        triage: "vocabulary-hole",
        support: { kind: "tally", state: "not-found", evidenceId: null, insideClaimConstraintIds: false },
        claimConstraintIds: ["節"],
      }).destination,
    ).toBe("unchecked");
  });

  it("S1 の経路は今の点検の規則（supports → 受理、contradicts → 落とす、not-stated は未点検）", () => {
    const accepts = destinationOf({ triage: "vocabulary-hole", support: { kind: "s1", vote: "supports" }, claimConstraintIds: ["節"] });
    expect(accepts).toEqual({ destination: "accept", evidenceId: "節", insideClaimConstraintIds: true });
    expect(destinationOf({ triage: "vocabulary-hole", support: { kind: "s1", vote: "contradicts" }, claimConstraintIds: ["節"] }).destination).toBe("drop");
    expect(destinationOf({ triage: "vocabulary-hole", support: { kind: "s1", vote: "not-stated" }, claimConstraintIds: ["節"] }).destination).toBe("unchecked");
    // 無効の票も未点検
    expect(destinationOf({ triage: "vocabulary-hole", support: { kind: "s1", vote: "failed" }, claimConstraintIds: ["節"] }).destination).toBe("unchecked");
  });
});

// ── 合成の反例 3 つ（固定の文書の材料から、形の答えを経て、期待の行き先になる。Issue #459）──

const COMPOSED_DOCS: readonly PromptDocument[] = [
  { name: "契約", text: "### secA\n節 A は手段を与えない。\n\n### secB\n節 B は手段を与える。\n" },
];

function choice(value: string, probability = 0.9): JudgeAnswer {
  return { kind: "choice", choice: value, probabilities: undefined, probability, confidence: undefined };
}

function judgeOf(answers: Readonly<Record<string, JudgeAnswer>>): Judge {
  return {
    async judge(request) {
      const out: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(request.questions)) {
        const answer = answers[name];
        if (answer === undefined) throw new Error(`問い ${name} の答えが用意されていません`);
        out[name] = answer;
      }
      return { answers: out, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
    },
  };
}

async function destinationsOf(
  claim: ClaimInput,
  answers: Readonly<Record<string, JudgeAnswer>>,
): Promise<Readonly<Record<ScorePath, ClaimDestination>>> {
  const forms: readonly ClaimFormId[] = ["T1", "S2", "S3", "S4"];
  const result = await evaluateForms({
    claims: [claim],
    documents: COMPOSED_DOCS,
    judge: judgeOf(answers),
    threshold: 0.5,
    modelVersion: "fake-judge",
    operation: { id: "forward", reverse: false, repeat: 0 },
    forms,
  });
  const byClaim = votesByClaimForm(result.votes);
  const map = byClaim.get(claim.id) ?? new Map();
  return Object.fromEntries(
    (["T1+S2", "T1+S3", "T1+S4"] as const).map((path) => [
      path,
      pathResultOf(path, claim, map, "majority").destination,
    ]),
  ) as Record<ScorePath, ClaimDestination>;
}

describe("合成の反例（Issue #459）", () => {
  const base = (overrides: Partial<ClaimInput> = {}): ClaimInput => ({
    id: "U-1",
    runId: "run-1",
    index: 0,
    requirementId: "R-1",
    requirementText: "要件の文",
    part: "部分",
    reason: "理由",
    constraintIds: ["secA"],
    alternative: "代案",
    ...overrides,
  });

  it("別の節に手段がある：S2 は自分の節（どちらも無い）で未点検、S3 は節 B を見つけて落とす", async () => {
    const destinations = await destinationsOf(base(), {
      "claim-t1:U-1": choice("vocabulary-hole"),
      "claim-s2:U-1": choice("neither"),
      "claim-s3-select:U-1": choice("secB"),
      "claim-s3-section:U-1": choice("provides"),
      "claim-s4:U-1:0": choice("neither"),
    });
    expect(destinations["T1+S2"]).toBe("unchecked");
    expect(destinations["T1+S3"]).toBe("drop");
  });

  it("複数の節の組み合わせで書ける：S4 は段落ごとにどちらも無いで未点検、S2 は合わせて読んで落とす", async () => {
    const destinations = await destinationsOf(base({ constraintIds: ["secA", "secB"] }), {
      "claim-t1:U-1": choice("vocabulary-hole"),
      "claim-s2:U-1": choice("provides"),
      "claim-s3-select:U-1": choice("none-of-them"),
      "claim-s4:U-1:0": choice("neither"),
      "claim-s4:U-1:1": choice("neither"),
    });
    expect(destinations["T1+S4"]).toBe("unchecked");
    expect(destinations["T1+S2"]).toBe("drop");
  });

  it("節が明示的に制限する：S2 も S4 も受理する", async () => {
    const destinations = await destinationsOf(base(), {
      "claim-t1:U-1": choice("vocabulary-hole"),
      "claim-s2:U-1": choice("restricts"),
      "claim-s3-select:U-1": choice("secA"),
      "claim-s3-section:U-1": choice("restricts"),
      "claim-s4:U-1:0": choice("restricts"),
    });
    expect(destinations["T1+S2"]).toBe("accept");
    expect(destinations["T1+S4"]).toBe("accept");
    void SAMPLE_DOCUMENTS;
  });
});
