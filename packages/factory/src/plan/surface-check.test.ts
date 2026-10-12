// P3 の「書けない」の申告を、判定の口で仕分け・裏付けする（plan/surface-check.ts）の unit テスト
// （04-plan-agent.md §3 P3・05-judge-model.md §3・Issue #432）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定したいのは 5 つ。
//   1. 申告 4 件が、受理 1・落とした 1・曖昧さへ 1・未点検 1 に分かれる
//   2. 確信度が閾値未満の裏付け・答えが読めない（unknown）は未点検
//   3. `contradicts` は落とす（分類つき）
//   4. 問いの欄に部分・理由・制約 ID と抜粋が載り、state に依頼文が無い
//   5. 申告 0 件なら判定を呼ばず、記録に問いの ID・答え・確信度・モデルの版・adapter を残す
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeQuestion, JudgeRequest } from "../judge.js";
import { SAMPLE_DOCUMENTS } from "../stages/__tests__/prompt.js";
import {
  SUPPORT_QUESTION_PREFIX,
  TRIAGE_QUESTION_PREFIX,
  supportQuestionName,
  triageQuestionName,
} from "../stages/unwritable-triage.js";
import { DEFAULT_PLAN_JUDGE_THRESHOLD } from "./run-plan.js";
import type { PlanSurface, PlanUnwritable } from "./surface.js";
import {
  SURFACE_SUPPORT_QUESTION_PREFIX,
  SURFACE_TRIAGE_QUESTION_PREFIX,
  runSurfaceCheck,
  surfaceSupportQuestionName,
  surfaceTriageQuestionName,
  type SurfaceCheckInput,
} from "./surface-check.js";

/** choice の答えを作る（確信度は任意） */
const choice = (value: string, confidence?: number): JudgeAnswer => ({
  kind: "choice",
  choice: value,
  probabilities: undefined,
  probability: undefined,
  confidence,
});

/** 問いの `instructions` を写像として読む（object でないときは undefined） */
function instructionsOf(question: JudgeQuestion | undefined): Record<string, unknown> | undefined {
  const instructions = question?.instructions;
  return typeof instructions === "object" ? (instructions as Record<string, unknown>) : undefined;
}

/** 申告 1 件を作る */
function claim(
  id: string,
  requirementId: string,
  part: string,
  constraintIds: readonly string[],
  reason: string,
  alternative = "代わりの案",
): PlanUnwritable {
  return { id, requirementId, part, constraintIds, reason, alternative };
}

/** P3 の出力（申告の並び。曖昧さの並びは点検に関係しないので空にする） */
function surface(...unwritable: readonly PlanUnwritable[]): PlanSurface {
  return { ambiguities: [], unwritable };
}

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

/** 点検を 1 回回す（閾値は共通の置き場所から取る） */
function check(
  output: PlanSurface,
  answers: Readonly<Record<string, JudgeAnswer>>,
  overrides: Partial<SurfaceCheckInput> = {},
) {
  const recording = recordingJudge(answers);
  return {
    requests: recording.requests,
    run: runSurfaceCheck({
      surface: output,
      documents: SAMPLE_DOCUMENTS,
      judge: recording.judge,
      threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
      ...overrides,
    }),
  };
}

/** 語彙の意味の見出し（SAMPLE_DOCUMENTS にある制約 ID）を使った申告 */
const HOLE = claim("U-0", "R-1", "アプリ自体の名前・説明", ["アプリの名前・説明"], "宣言に欄が無い");

describe("申告の仕分けと裏付け（04 §3 P3・Issue #432）", () => {
  it("申告 4 件が、受理 1・落とした 1・曖昧さへ 1・未点検 1 に分かれる", async () => {
    const hole = claim("U-0", "R-1", "語彙の穴の部分", ["アプリの名前・説明"], "理由 0");
    const notAProblem = claim("U-1", "R-1", "問題ではない部分", ["記録"], "理由 1");
    const ambiguity = claim("U-2", "R-2", "曖昧さの部分", ["合計"], "理由 2");
    const notStated = claim("U-3", "R-2", "書いていない部分", ["記録"], "理由 3");
    const { run } = check(surface(hole, notAProblem, ambiguity, notStated), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.9),
      [surfaceTriageQuestionName(1)]: choice("not-a-problem", 0.8),
      [surfaceTriageQuestionName(2)]: choice("ambiguity", 0.9),
      [surfaceTriageQuestionName(3)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(3)]: choice("not-stated", 0.9),
    });
    const result = await run;

    // 受理は 1 件（語彙の穴で裏付けが取れたもの）
    expect(result.accepted).toEqual([hole]);
    // 落としたのは 1 件（問題ではない。分類つき）
    expect(result.dropped).toEqual([
      { index: 1, requirementId: "R-1", part: "問題ではない部分", reason: "理由 1", code: "not-a-problem" },
    ]);
    // 曖昧さへ 1 件
    expect(result.ambiguities).toEqual([
      { index: 2, requirementId: "R-2", part: "曖昧さの部分", reason: "理由 2" },
    ]);
    // 未点検は 1 件（書いていない）
    expect(result.unchecked).toEqual([
      { index: 3, requirementId: "R-2", part: "書いていない部分", code: "not-stated" },
    ]);
  });

  it("確信度が閾値より低い裏付けは、未点検として残す（消さない）", async () => {
    const { run } = check(surface(HOLE), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", DEFAULT_PLAN_JUDGE_THRESHOLD - 0.1),
    });
    const result = await run;

    expect(result.accepted).toEqual([]);
    expect(result.unchecked).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "low-confidence" },
    ]);
  });

  it("答えが読めない（unknown）も未点検として残す", async () => {
    const { run } = check(surface(HOLE), {
      // 種類は choice だが、知らないラベル（読めない答え）
      [surfaceTriageQuestionName(0)]: choice("???", 0.9),
    });
    const result = await run;

    expect(result.dropped).toEqual([]);
    expect(result.unchecked).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "unknown" },
    ]);
  });

  it("裏付けが「反する」なら、落とす（分類つき）", async () => {
    const { run } = check(surface(HOLE), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("contradicts", 0.9),
    });
    const result = await run;

    expect(result.accepted).toEqual([]);
    expect(result.dropped).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", reason: "宣言に欄が無い", code: "contradicts" },
    ]);
    expect(result.unchecked).toEqual([]);
  });
});

describe("判定への渡し方（05 §3・§4・Issue #376・#432）", () => {
  it("問いの欄に部分・理由・制約 ID と抜粋が載り、state に依頼文が無い", async () => {
    const { run, requests } = check(surface(HOLE), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.9),
    });
    await run;

    // 1 回目は仕分け、2 回目は裏付け
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["plan-triage:0"]);
    expect(Object.keys(requests[1]?.questions ?? {})).toEqual(["plan-support:0"]);
    // 仕分けの問いに、対象の申告（部分と理由と制約 ID）を載せる
    const triageQuestion = requests[0]?.questions[surfaceTriageQuestionName(0)];
    expect(triageQuestion?.instructions).toBeTypeOf("object");
    expect(triageQuestion?.instructions).toMatchObject({
      part: "アプリ自体の名前・説明",
      reason: "宣言に欄が無い",
      constraintIds: ["アプリの名前・説明"],
    });
    // 裏付けの問いに、根拠にした制約 ID の節の抜粋を載せる
    const supportQuestion = requests[1]?.questions[surfaceSupportQuestionName(0)];
    const instructions = instructionsOf(supportQuestion);
    expect(String(instructions?.excerpt)).toContain("アプリの名前・説明");
    expect(String(instructions?.excerpt)).toContain("アプリ自体の名前や説明を置く欄は無い。");
    // 問いの文は英語（仕分けと裏付けの両方）
    expect(String(instructionsOf(triageQuestion)?.ask)).toMatch(/^[\x20-\x7E]+$/);
    expect(String(instructions?.ask)).toMatch(/^[\x20-\x7E]+$/);
    // state には依頼文（原文）を入れない（問いの名前だけでは判定が読めないので、対象は問いの欄へ移した）
    expect(requests[0]?.state).toEqual({});
    expect(requests[1]?.state).toEqual({});
  });

  it("問いの名前の頭は、Build の仕分け（triage・support）と違う", () => {
    expect(SURFACE_TRIAGE_QUESTION_PREFIX).not.toBe(TRIAGE_QUESTION_PREFIX);
    expect(SURFACE_SUPPORT_QUESTION_PREFIX).not.toBe(SUPPORT_QUESTION_PREFIX);
    expect(surfaceTriageQuestionName(0)).toBe("plan-triage:0");
    expect(surfaceSupportQuestionName(0)).toBe("plan-support:0");
    // Build の問いの名前とは重ならない
    expect(surfaceTriageQuestionName(0)).not.toBe(triageQuestionName("R-1", 0));
    expect(surfaceSupportQuestionName(0)).not.toBe(supportQuestionName("R-1", 0));
  });

  it("判定の記録に、問いの ID・答え・確信度・答えたモデルの版・adapter を残す", async () => {
    const { run } = check(surface(HOLE), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.7),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.55),
    });
    const result = await run;

    expect(result.judgments).toEqual([
      { questionId: "plan-triage:0", answer: "vocabulary-hole", confidence: 0.7, model: "fake-judge", answeredBy: "fake" },
      { questionId: "plan-support:0", answer: "supports", confidence: 0.55, model: "fake-judge", answeredBy: "fake" },
    ]);
  });

  it("申告が無ければ、判定を呼ばずに空の結果を返す", async () => {
    const { run, requests } = check(surface(), {});
    const result = await run;

    expect(requests).toEqual([]);
    expect(result).toEqual({ accepted: [], dropped: [], ambiguities: [], unchecked: [], judgments: [] });
  });
});

// ── 仕分けにも閾値を掛ける（独立の点検が成立していなければ未点検。Issue #432）──────────

describe("仕分けの確信度が閾値未満・不明なら、分類先へ流さず未点検にする（Issue #432）", () => {
  const labels = ["ambiguity", "vocabulary-hole", "not-a-problem"] as const;

  it("3 つの仕分けラベルとも、確信度が閾値未満なら未点検（落とさず・分類しない）", async () => {
    for (const label of labels) {
      const { run } = check(surface(HOLE), {
        [surfaceTriageQuestionName(0)]: choice(label, DEFAULT_PLAN_JUDGE_THRESHOLD - 0.1),
      });
      const result = await run;
      expect(result.accepted, label).toEqual([]);
      expect(result.dropped, label).toEqual([]);
      expect(result.ambiguities, label).toEqual([]);
      expect(result.unchecked, label).toEqual([
        { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "low-confidence" },
      ]);
    }
  });

  it("3 つの仕分けラベルとも、確信度が不明（返せない adapter）なら未点検", async () => {
    for (const label of labels) {
      const { run } = check(surface(HOLE), {
        // 確信度を渡さない＝不明（Jev が使えず LLM に落ちたときと同じ）
        [surfaceTriageQuestionName(0)]: choice(label),
      });
      const result = await run;
      expect(result.accepted, label).toEqual([]);
      expect(result.dropped, label).toEqual([]);
      expect(result.ambiguities, label).toEqual([]);
      expect(result.unchecked, label).toEqual([
        { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "low-confidence" },
      ]);
    }
  });

  it("低確信の仕分け（語彙の穴）＋高確信の裏付けでも、受理しない（裏付けだけでは独立の仕分けを保証できない）", async () => {
    const { run, requests } = check(surface(HOLE), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", DEFAULT_PLAN_JUDGE_THRESHOLD - 0.1),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    const result = await run;

    // 裏付けの問いは呼ばれない（仕分けが成立していないので、裏付けへ流さない）
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["plan-triage:0"]);
    expect(result.accepted).toEqual([]);
    expect(result.unchecked).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "low-confidence" },
    ]);
  });
});
