// 問いの形（plan/claim-forms.ts）の unit テスト（Issue #459）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定するのは**問いの組み立てと票の写し**である。
import { describe, expect, it } from "vitest";
import type { Judge, JudgeAnswer, JudgeRequest } from "../judge.js";
import { SAMPLE_DOCUMENTS, expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import type { PromptDocument } from "../stages/prompt.js";
import {
  CLAIM_FORM_MAX_CHOICES,
  CLAIM_FORMS_VERSION,
  ClaimFormsThresholdMissingError,
  T2_RAW_TO_COMMON,
  buildOperations,
  evaluateForms,
  formAppliesTo,
  requireClaimFormThreshold,
  supportFormsFor,
  triageFormsFor,
  type ClaimFormId,
  type ClaimInput,
  type ClaimOperation,
  type EvaluateResult,
} from "./claim-forms.js";
import { createCallHash } from "./claim-recorded-judge.js";
import { surfaceSupportQuestion, surfaceTriageQuestion } from "./surface-check.js";

const OPERATION: ClaimOperation = { id: "forward", reverse: false, repeat: 0 };
const THRESHOLD = 0.5;

/** choice の答えを作る（確率は任意） */
function choice(value: string, probability?: number): JudgeAnswer {
  return { kind: "choice", choice: value, probabilities: undefined, probability, confidence: undefined };
}

/** 問いの名前ごとに決めた答えを返し、受け取った要求を記録する偽物 */
function recording(answers: Readonly<Record<string, JudgeAnswer>>): { judge: Judge; requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  const judge: Judge = {
    async judge(request) {
      requests.push(request);
      const out: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(request.questions)) {
        const answer = answers[name];
        if (answer === undefined) throw new Error(`問い ${name} の答えが用意されていません`);
        out[name] = answer;
      }
      return { answers: out, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
    },
  };
  return { judge, requests };
}

/** 申告 1 件を作る */
function claim(id: string, overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    id,
    runId: "run-1",
    index: 0,
    requirementId: "R-1",
    requirementText: "要件の文",
    part: "書けない部分",
    reason: "理由",
    constraintIds: ["記録"],
    alternative: "代わりの案",
    ...overrides,
  };
}

/** 形を 1 つだけ流す */
function evaluate(
  form: ClaimFormId,
  claims: readonly ClaimInput[],
  answers: Readonly<Record<string, JudgeAnswer>>,
  overrides: Partial<Parameters<typeof evaluateForms>[0]> = {},
): { readonly result: Promise<EvaluateResult>; readonly requests: JudgeRequest[] } {
  const fake = recording(answers);
  return {
    requests: fake.requests,
    result: evaluateForms({
      claims,
      documents: SAMPLE_DOCUMENTS,
      judge: fake.judge,
      threshold: THRESHOLD,
      modelVersion: "fake-judge",
      operation: OPERATION,
      forms: [form],
      ...overrides,
    }),
  };
}

/** 票を引く */
function voteOf(result: EvaluateResult, form: string): string | undefined {
  return result.votes.find((entry) => entry.form === form)?.vote.vote;
}

describe("T1・S1 は点検と同じ関数で組まれる（Issue #459）", () => {
  it("T1 の問いは surfaceTriageQuestion と一致する", async () => {
    const target = claim("U-1");
    const asUnwritable = { ...target, alternative: target.alternative ?? "" };
    const { result, requests } = evaluate("T1", [target], { "claim-t1:U-1": choice("vocabulary-hole", 0.9) });
    await result;
    expect(requests[0]?.questions["claim-t1:U-1"]).toEqual(surfaceTriageQuestion(asUnwritable));
  });

  it("S1 の問いは surfaceSupportQuestion と一致する", async () => {
    const target = claim("U-1");
    const asUnwritable = { ...target, alternative: target.alternative ?? "" };
    const { result, requests } = evaluate("S1", [target], { "claim-s1:U-1": choice("supports", 0.9) });
    await result;
    expect(requests[0]?.questions["claim-s1:U-1"]).toEqual(surfaceSupportQuestion(asUnwritable, SAMPLE_DOCUMENTS));
  });
});

describe("T2 は 05 §2 E1 の忠実な再現（1 申告＝1 要求・state に要件と申告）", () => {
  it("生ラベルの写しを宣言している", () => {
    expect(T2_RAW_TO_COMMON).toEqual({
      ambiguity: "ambiguity",
      vocabulary_gap: "vocabulary-hole",
      not_an_issue: "not-a-problem",
    });
  });

  it("2 件の申告で 2 つの要求になり、各要求は対象 1 つだけを参照し、ハッシュが別になる", async () => {
    const first = claim("U-1", { requirementId: "R-1", requirementText: "要件 1", part: "部分 1" });
    const second = claim("U-2", { requirementId: "R-2", requirementText: "要件 2", part: "部分 2" });
    const { result, requests } = evaluate("T2", [first, second], {
      "claim-t2:U-1": choice("vocabulary_gap", 0.9),
      "claim-t2:U-2": choice("not_an_issue", 0.9),
    });
    await result;
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(Object.keys(request.questions)).toHaveLength(1);
      expect(request.state).toMatchObject({ requirement: expect.any(String), claim: expect.any(Object) });
    }
    expect(await createCallHash(requests[0]!)).not.toBe(await createCallHash(requests[1]!));
  });

  it("生ラベルは共通の 3 ラベルへ写る", async () => {
    const { result } = evaluate("T2", [claim("U-1")], { "claim-t2:U-1": choice("vocabulary_gap", 0.9) });
    expect(voteOf(await result, "T2")).toBe("vocabulary-hole");
  });
});

describe("未実施の条件（Issue #459）", () => {
  it("要件の文が無い申告では T2・T3 を適用しない", () => {
    const target = claim("U-1", { requirementText: null });
    expect(formAppliesTo("T2", target)).toBe(false);
    expect(formAppliesTo("T3", target)).toBe(false);
    expect(triageFormsFor(target)).toEqual(["T1"]);
  });

  it("制約 ID の無い申告では S1・S2・S4 を適用しない", () => {
    const target = claim("U-1", { constraintIds: [] });
    expect(formAppliesTo("S1", target)).toBe(false);
    expect(formAppliesTo("S2", target)).toBe(false);
    expect(formAppliesTo("S4", target)).toBe(false);
    expect(supportFormsFor(target)).toEqual(["S3"]);
  });

  it("要件の文が無い申告では T2・T3 の呼び出しが起きない", async () => {
    const { result } = evaluate("T2", [claim("U-1", { requirementText: null })], {});
    const evaluated = await result;
    expect(evaluated.calls).toEqual([]);
    expect(evaluated.votes).toEqual([]);
  });
});

describe("新しい形の欄に正解・依頼文・題材の文字列が無い（Issue #459）", () => {
  it("T2・T3・S2・S3・S4 の要求に、正解の値と題材の言葉が入らない", async () => {
    const target = claim("U-1");
    const answers = {
      "claim-t2:U-1": choice("vocabulary_gap", 0.9),
      "claim-t3:U-1": choice("vocabulary-hole", 0.9),
      "claim-s2:U-1": choice("restricts", 0.9),
      "claim-s3-select:U-1": choice("記録", 0.9),
      "claim-s3-section:U-1": choice("restricts", 0.9),
      "claim-s4:U-1:0": choice("restricts", 0.9),
    };
    const { result, requests } = evaluate("T2", [target], answers, {
      forms: ["T2", "T3", "S2", "S3", "S4"] as readonly ClaimFormId[],
    });
    await result;
    const text = JSON.stringify(requests);
    // 受入の題材の言葉は、試験の記録にもプロンプトにも使わない（許された道具で確認する）
    expectNoAcceptanceMaterial([text]);
    // 正解・依頼文の原文も、新しい形の欄には入らない
    for (const word of ["正解", "依頼文の原文"]) {
      expect(text.includes(word), `${word} が入っている`).toBe(false);
    }
  });
});

describe("S1 の票は別の根拠種別（四値へ写さない）（Issue #459）", () => {
  it("supports／contradicts／not-stated のままで、S2〜S4 の票に入らない", async () => {
    const { result } = evaluate("S1", [claim("U-1")], { "claim-s1:U-1": choice("supports", 0.9) });
    const evaluated = await result;
    expect(voteOf(evaluated, "S1")).toBe("supports");
    // S2〜S4 の票は作らない（別の根拠種別）
    expect(evaluated.votes.some((entry) => entry.form !== "S1")).toBe(false);
  });
});

describe("S3 は文書の制約 ID の集合＋「どれでもない」（Issue #459）", () => {
  it("選択肢が文書の制約 ID＋どれでもないで、選ばれた ID だけでは票が決まらない", async () => {
    const first = evaluate("S3", [claim("U-1", { constraintIds: [] })], {
      "claim-s3-select:U-1": choice("記録", 0.9),
      "claim-s3-section:U-1": choice("restricts", 0.9),
    });
    const restricting = await first.result;
    expect(restricting.votes[0]?.vote.vote).toBe("restricts");
    expect(restricting.votes[0]?.vote.evidenceId).toBe("記録");

    // 同じ選択でも、節の点検の答えが変われば票が変わる
    const second = evaluate("S3", [claim("U-1", { constraintIds: [] })], {
      "claim-s3-select:U-1": choice("記録", 0.9),
      "claim-s3-section:U-1": choice("provides", 0.9),
    });
    expect((await second.result).votes[0]?.vote.vote).toBe("provides");

    // 選択肢は文書の制約 ID の集合＋「どれでもない」
    const request = first.requests[0];
    const criteria = request?.questions["claim-s3-select:U-1"];
    expect(Object.keys(criteria?.kind === "choice" ? criteria.criteria : {})).toContain("none-of-them");
  });

  it("「どれでもない」なら not-found", async () => {
    const { result } = evaluate("S3", [claim("U-1", { constraintIds: [] })], {
      "claim-s3-select:U-1": choice("none-of-them", 0.9),
    });
    expect((await result).votes[0]?.vote.vote).toBe("not-found");
  });

  it("255 超は送る前に止まる（呼ばない）", async () => {
    const { result, requests } = evaluate("S3", [claim("U-1", { constraintIds: [] })], {}, { maxChoices: 2 });
    const evaluated = await result;
    expect(evaluated.tooManyChoices).toEqual([{ form: "S3", count: 13 }]);
    expect(requests).toEqual([]);
    expect(evaluated.votes[0]?.vote.vote).toBe("not-run");
    expect(CLAIM_FORM_MAX_CHOICES).toBe(255);
  });
});

describe("S4 の量化が固定どおり（Issue #459）", () => {
  const DOCS: readonly PromptDocument[] = [
    { name: "契約", text: "R-A-01 節 A の規則。\n" },
    { name: "語彙の意味", text: "### sec\n段落 1 の文。\n\n段落 2 の文。\n" },
  ];

  it("段落に無効が 1 つでもあれば形の票は無効（優先順どおり）", async () => {
    const target = claim("U-1", { constraintIds: ["sec"] });
    const { result } = evaluate("S4", [target], {
      "claim-s4:U-1:0": choice("restricts", 0.9),
      "claim-s4:U-1:1": choice("???", 0.9),
    }, { documents: DOCS });
    expect((await result).votes[0]?.vote.vote).toBe("unknown-answer");
  });

  it("全部有効なら provides があれば provides、無ければ restricts", async () => {
    const target = claim("U-1", { constraintIds: ["sec"] });
    const provides = evaluate("S4", [target], {
      "claim-s4:U-1:0": choice("restricts", 0.9),
      "claim-s4:U-1:1": choice("provides", 0.9),
    }, { documents: DOCS });
    expect((await provides.result).votes[0]?.vote.vote).toBe("provides");

    const restricts = evaluate("S4", [target], {
      "claim-s4:U-1:0": choice("restricts", 0.9),
      "claim-s4:U-1:1": choice("neither", 0.9),
    }, { documents: DOCS });
    expect((await restricts.result).votes[0]?.vote.vote).toBe("restricts");
  });
});

describe("全答えが票の値に写る（Issue #459）", () => {
  it("集合の外は unknown-answer、確率不明は probability-unknown、閾値未満は low-probability", async () => {
    const unknown = evaluate("T1", [claim("U-1")], { "claim-t1:U-1": choice("???", 0.9) });
    expect(voteOf(await unknown.result, "T1")).toBe("unknown-answer");

    const noProbability = evaluate("T1", [claim("U-1")], { "claim-t1:U-1": choice("vocabulary-hole") });
    expect(voteOf(await noProbability.result, "T1")).toBe("probability-unknown");

    const low = evaluate("T1", [claim("U-1")], { "claim-t1:U-1": choice("vocabulary-hole", 0.2) });
    expect(voteOf(await low.result, "T1")).toBe("low-probability");
  });
});

describe("閾値の表に無い組は送る前に止まる（Issue #459）", () => {
  it("登録の無いモデルでは投げる", () => {
    expect(() => requireClaimFormThreshold(CLAIM_FORMS_VERSION, "no-such-model")).toThrow(
      ClaimFormsThresholdMissingError,
    );
  });
});

describe("操作の組み立て（Issue #459）", () => {
  it("反復は申告の数に足さず、操作として別に記録される。反転は別の操作", () => {
    expect(buildOperations(3, false).map((operation) => operation.id)).toEqual(["forward", "forward#2", "forward#3"]);
    expect(buildOperations(1, true).map((operation) => operation.id)).toEqual(["forward", "reverse"]);
  });
});
