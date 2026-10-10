// 設計の「書けない」の申告を、仕分けて裏を取る（stages/unwritable-triage.ts）の unit テスト
// （05-judge-model.md §3・Issue #332）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定したいのは 4 つ。
//   1. 曖昧さ → 設計の `notes` に移し、書けない申告からは外す
//   2. 問題ではない → 落とす（落としたことを記録に残す）
//   3. 語彙の穴で「反する」→ その要件だけ設計をやり直す（1 回）
//   4. 確信度が閾値より低い（と「書いていない」）→ 印つきで残す（捨てない）
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest } from "../judge.js";
import { UNWRITABLE_CONFIDENCE_THRESHOLD } from "../limits.js";
import type { DesignOutput, RequirementDesignEntry, UnwritableClaim } from "./design.js";
import {
  runUnwritableTriage,
  supportQuestionName,
  triageQuestionName,
  type UnwritableTriageInput,
} from "./unwritable-triage.js";
import { SAMPLE_DOCUMENTS } from "./__tests__/prompt.js";

/** choice の答えを作る（確信度は任意） */
const choice = (value: string, confidence?: number): JudgeAnswer => ({
  kind: "choice",
  choice: value,
  probabilities: undefined,
  probability: undefined,
  confidence,
});

/** 申告 1 件を作る */
const claim = (part: string, constraintIds: readonly string[], reason: string): UnwritableClaim => ({
  part,
  constraintIds,
  reason,
});

/** 要件ごとの設計 1 行を作る */
const entry = (
  requirementId: string,
  claims: readonly UnwritableClaim[],
  notes: readonly string[] = [],
): RequirementDesignEntry => ({
  requirementId,
  vocabulary: [],
  placement: [],
  unwritable: claims.map((one) => one.part),
  unwritableClaims: claims,
  notes,
});

/** 設計（要件の並び）を作る */
const design = (...entries: readonly RequirementDesignEntry[]): DesignOutput => ({ designs: entries });

/** 問いの答えを返しつつ、受け取った要求を残す偽物の判定（実 API は呼ばない） */
function recordingJudge(answers: Readonly<Record<string, JudgeAnswer>>): {
  readonly judge: Judge;
  readonly requests: JudgeRequest[];
} {
  const inner = createFakeJudge(answers, { model: "fake-judge" });
  const requests: JudgeRequest[] = [];
  return {
    judge: {
      async judge(request: JudgeRequest) {
        requests.push(request);
        return inner.judge(request);
      },
    },
    requests,
  };
}

const CLAIM = claim("アプリ自体の名前・説明", ["アプリの名前・説明"], "宣言に欄が無い");

/** 仕分けと裏付けを 1 回回す（閾値は共通の置き場所から取る） */
function triage(
  output: DesignOutput,
  answers: Readonly<Record<string, JudgeAnswer>>,
  overrides: Partial<UnwritableTriageInput> = {},
) {
  const recording = recordingJudge(answers);
  return {
    requests: recording.requests,
    run: runUnwritableTriage({
      design: output,
      documents: SAMPLE_DOCUMENTS,
      judge: recording.judge,
      threshold: UNWRITABLE_CONFIDENCE_THRESHOLD,
      ...overrides,
    }),
  };
}

describe("申告の仕分けと裏付け（05 §3・Issue #332）", () => {
  it("曖昧さの申告は、設計の notes に移し、書けない申告から外す", async () => {
    const { run } = triage(design(entry("R-1", [CLAIM])), {
      [triageQuestionName("R-1", 0)]: choice("ambiguity", 0.9),
    });
    const result = await run;

    // 書けない申告ではなくなり、曖昧さのメモとして残る
    expect(result.kept).toEqual([]);
    expect(result.design.designs[0]?.unwritableClaims).toEqual([]);
    expect(result.design.designs[0]?.notes).toEqual(["アプリ自体の名前・説明"]);
    // 落としたことを記録に残す（ラベルは ambiguity）
    expect(result.dropped).toEqual([
      { requirementId: "R-1", part: "アプリ自体の名前・説明", label: "ambiguity", reason: "宣言に欄が無い" },
    ]);
  });

  it("問題ではない申告は落とし、落としたことを記録に残す", async () => {
    const { run } = triage(design(entry("R-1", [CLAIM])), {
      [triageQuestionName("R-1", 0)]: choice("not-a-problem", 0.8),
    });
    const result = await run;

    expect(result.kept).toEqual([]);
    expect(result.design.designs[0]?.unwritableClaims).toEqual([]);
    // notes には移さない（書けないことでも、曖昧さでもない）
    expect(result.design.designs[0]?.notes).toEqual([]);
    expect(result.dropped).toEqual([
      { requirementId: "R-1", part: "アプリ自体の名前・説明", label: "not-a-problem", reason: "宣言に欄が無い" },
    ]);
  });

  it("語彙の穴で「反する」なら、その要件だけ設計をやり直す（1 回）", async () => {
    let redoCalls = 0;
    const redone = entry("R-1", []);
    const { run } = triage(
      design(entry("R-1", [CLAIM])),
      {
        [triageQuestionName("R-1", 0)]: choice("vocabulary-hole", 0.9),
        [supportQuestionName("R-1", 0)]: choice("contradicts", 0.9),
      },
      {
        redoDesign: async (requirementId) => {
          redoCalls += 1;
          expect(requirementId).toBe("R-1");
          return redone;
        },
      },
    );
    const result = await run;

    expect(redoCalls).toBe(1);
    // やり直した設計を採る（申告は無くなり、kept にも入らない）
    expect(result.design.designs[0]?.unwritableClaims).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it("語彙の穴で「反する」が複数あっても、やり直しは 1 回までである", async () => {
    let redoCalls = 0;
    const claimA = claim("部分 A", ["記録"], "理由 A");
    const claimB = claim("部分 B", ["合計"], "理由 B");
    const redoneClaim = claim("やり直しの申告", ["記録"], "やり直しの理由");
    const { run } = triage(
      design(entry("R-1", [claimA, claimB])),
      {
        [triageQuestionName("R-1", 0)]: choice("vocabulary-hole", 0.9),
        [triageQuestionName("R-1", 1)]: choice("vocabulary-hole", 0.9),
        [supportQuestionName("R-1", 0)]: choice("contradicts", 0.9),
        [supportQuestionName("R-1", 1)]: choice("contradicts", 0.9),
      },
      {
        redoDesign: async () => {
          redoCalls += 1;
          return entry("R-1", [redoneClaim]);
        },
      },
    );
    const result = await run;

    // やり直しは 1 回だけ（2 件目の「反する」ではやり直さない）
    expect(redoCalls).toBe(1);
    // やり直した設計を採る
    expect(result.kept).toEqual([{ requirementId: "R-1", claims: [redoneClaim], marked: false, redone: true }]);
  });

  it("確信度が閾値より低い裏付けは、印つきで残す（捨てない）", async () => {
    const { run } = triage(design(entry("R-1", [CLAIM])), {
      [triageQuestionName("R-1", 0)]: choice("vocabulary-hole", 0.9),
      // 「裏付ける」だが確信度が閾値未満（= 閾値より低い）
      [supportQuestionName("R-1", 0)]: choice("supports", UNWRITABLE_CONFIDENCE_THRESHOLD - 0.1),
    });
    const result = await run;

    expect(result.kept).toEqual([{ requirementId: "R-1", claims: [CLAIM], marked: true, redone: false }]);
    expect(result.design.designs[0]?.unwritableClaims).toEqual([CLAIM]);
  });

  it("裏付けが「書いていない」なら、印つきで残す", async () => {
    const { run } = triage(design(entry("R-1", [CLAIM])), {
      [triageQuestionName("R-1", 0)]: choice("vocabulary-hole", 0.9),
      [supportQuestionName("R-1", 0)]: choice("not-stated", 0.9),
    });
    const result = await run;

    expect(result.kept).toEqual([{ requirementId: "R-1", claims: [CLAIM], marked: true, redone: false }]);
  });

  it("裏付けが取れた語彙の穴は、印をつけずに残す", async () => {
    const { run } = triage(design(entry("R-1", [CLAIM])), {
      [triageQuestionName("R-1", 0)]: choice("vocabulary-hole", 0.9),
      [supportQuestionName("R-1", 0)]: choice("supports", 0.95),
    });
    const result = await run;

    expect(result.kept).toEqual([{ requirementId: "R-1", claims: [CLAIM], marked: false, redone: false }]);
  });
});

describe("判定への渡し方（05 §2.2・§4・Issue #332）", () => {
  it("問いの名前は要件 ID と申告の番号で決まり、裏付けの state に制約 ID の節の抜粋を渡す", async () => {
    const { run, requests } = triage(design(entry("R-1", [CLAIM])), {
      [triageQuestionName("R-1", 0)]: choice("vocabulary-hole", 0.9),
      [supportQuestionName("R-1", 0)]: choice("supports", 0.9),
    });
    await run;

    // 1 回目は仕分け、2 回目は裏付け
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["triage:R-1:0"]);
    expect(Object.keys(requests[1]?.questions ?? {})).toEqual(["support:R-1:0"]);
    // 裏付けの state に、根拠にした制約 ID の節の抜粋（語彙の意味の見出し）が入る
    const supportState = JSON.stringify(requests[1]?.state);
    expect(supportState).toContain("アプリの名前・説明");
    expect(supportState).toContain("アプリ自体の名前や説明を置く欄は無い。");
  });

  it("判定の記録に、問いの ID・答え・確信度・答えたモデルの版を残す", async () => {
    const { run } = triage(design(entry("R-1", [CLAIM])), {
      [triageQuestionName("R-1", 0)]: choice("vocabulary-hole", 0.7),
      [supportQuestionName("R-1", 0)]: choice("supports", 0.55),
    });
    const result = await run;

    expect(result.judgments).toEqual([
      { questionId: "triage:R-1:0", answer: "vocabulary-hole", confidence: 0.7, model: "fake-judge", answeredBy: "fake" },
      { questionId: "support:R-1:0", answer: "supports", confidence: 0.55, model: "fake-judge", answeredBy: "fake" },
    ]);
  });

  it("申告が無ければ、判定を呼ばずにそのまま返す", async () => {
    const { run, requests } = triage(design(entry("R-1", [], ["曖昧さのメモ"])), {});
    const result = await run;

    expect(requests).toEqual([]);
    expect(result.judgments).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.design.designs[0]?.notes).toEqual(["曖昧さのメモ"]);
  });
});
