// P3 の「書けない」の申告を、判定の口で仕分け・裏付け・再点検する（plan/surface-check.ts）の unit テスト
// （04-plan-agent.md §3 P3・05-judge-model.md §3・Issue #432）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定するのは**配線と拒否の条件**である——固定の応答を
// 返す偽物で、どの問いをどの口へ送るか・どの答えを受理しないかを確かめる。**意味の点検の効き目の証明では
// ない**（効き目は §7 のラベル付きの組で測る）。
//   1. 申告 4 件が、受理・落とした・曖昧さへ・未点検に分かれる
//   2. 確信度が閾値未満・不明・裏付けの「書いていない」は、**Luna の別の会話**（落とし先）で再点検する
//   3. 根拠（有限の ID）が取れたときだけ受理し、判定不能なら未点検にする
//   4. 仕分けが未確定の申告を、裏付けだけで通さない
//   5. 診断に、申告の添字・要件 ID・部分・理由・制約 ID・文書の版・段階・分類・adapter・確信度・根拠 ID を残す
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
  SURFACE_RECHECK_NO_EVIDENCE,
  SURFACE_SUPPORT_QUESTION_PREFIX,
  SURFACE_TRIAGE_QUESTION_PREFIX,
  runSurfaceCheck,
  surfaceRecheckEvidenceQuestionName,
  surfaceRecheckKindQuestionName,
  surfaceSupportQuestionName,
  surfaceTriageQuestionName,
  type SurfaceCheckInput,
} from "./surface-check.js";

/** choice の答えを作る（確信度は任意＝不明は undefined） */
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

/** 要件 ID → 文（再点検の対象のデータ） */
const REQUIREMENTS = new Map([
  ["R-1", "要件 R-1 の文"],
  ["R-2", "要件 R-2 の文"],
]);

/**
 * 主の判定と落とし先（Luna）の判定を別々に持つ、要求を記録する偽物。
 * 既定では落とし先も同じ答えを使う（落とし先を指定しない試験は、同じ写像で再点検にも答える）。
 */
function recordingJudge(
  answers: Readonly<Record<string, JudgeAnswer>>,
  fallbackAnswers: Readonly<Record<string, JudgeAnswer>> = answers,
  fallbackModel = "fake-judge",
): { readonly judge: Judge; readonly requests: JudgeRequest[] } {
  const primary = createFakeJudge(answers, { model: "fake-judge" });
  const luna = createFakeJudge(fallbackAnswers, { model: fallbackModel });
  const requests: JudgeRequest[] = [];
  return {
    judge: {
      async judge(request: JudgeRequest) {
        requests.push(request);
        return primary.judge(request);
      },
      fallback: {
        async judge(request: JudgeRequest) {
          requests.push(request);
          return luna.judge(request);
        },
      },
    },
    requests,
  };
}

/** 常に失敗する偽物（落とし先の失敗を見る用） */
function failingJudge(): Judge {
  return {
    async judge() {
      throw new Error("落とし先が失敗した");
    },
  };
}

/** 点検を 1 回回す（閾値は共通の置き場所から取る。既定では落とし先も同じ答えを使う） */
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
      requirements: REQUIREMENTS,
      docVersion: "v1",
      ...overrides,
    }),
  };
}

/** 語彙の意味の見出し（SAMPLE_DOCUMENTS にある制約 ID）を使った申告 */
const HOLE = claim("U-0", "R-1", "アプリ自体の名前・説明", ["アプリの名前・説明"], "宣言に欄が無い");

/** 申告 1 件を再点検に回す答え（主の仕分けが確信度不明）と、落とし先の答え */
const RECHECK_ACCEPT = {
  [surfaceTriageQuestionName(0)]: choice("vocabulary-hole"),
  [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
  [surfaceRecheckEvidenceQuestionName(0)]: choice("アプリの名前・説明", 0.9),
};

describe("申告の仕分けと裏付け（04 §3 P3・Issue #432）", () => {
  it("申告 4 件が、受理 1・落とした 1・曖昧さへ 1・未点検 1 に分かれる（未点検は再点検で判定不能）", async () => {
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
      // 3 件目（書いていない）は再点検で判定不能 → 未点検
      [surfaceRecheckKindQuestionName(3)]: choice("undecidable", 0.9),
      [surfaceRecheckEvidenceQuestionName(3)]: choice(SURFACE_RECHECK_NO_EVIDENCE, 0.9),
    });
    const result = await run;

    expect(result.accepted).toEqual([hole]);
    expect(result.dropped).toEqual([
      { index: 1, requirementId: "R-1", part: "問題ではない部分", reason: "理由 1", code: "not-a-problem" },
    ]);
    expect(result.ambiguities).toEqual([
      { index: 2, requirementId: "R-2", part: "曖昧さの部分", reason: "理由 2" },
    ]);
    expect(result.unchecked).toEqual([
      { index: 3, requirementId: "R-2", part: "書いていない部分", code: "unknown" },
    ]);
  });

  it("答えが読めない（unknown）は未点検として残す（再点検へは回さない）", async () => {
    const { run } = check(surface(HOLE), {
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

    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["plan-triage:0"]);
    expect(Object.keys(requests[1]?.questions ?? {})).toEqual(["plan-support:0"]);
    const triageQuestion = requests[0]?.questions[surfaceTriageQuestionName(0)];
    expect(triageQuestion?.instructions).toMatchObject({
      part: "アプリ自体の名前・説明",
      reason: "宣言に欄が無い",
      constraintIds: ["アプリの名前・説明"],
    });
    const instructions = instructionsOf(requests[1]?.questions[surfaceSupportQuestionName(0)]);
    expect(String(instructions?.excerpt)).toContain("アプリ自体の名前や説明を置く欄は無い。");
    expect(String(instructionsOf(triageQuestion)?.ask)).toMatch(/^[\x20-\x7E]+$/);
    expect(String(instructions?.ask)).toMatch(/^[\x20-\x7E]+$/);
    // state には依頼文（原文）を入れない
    expect(requests[0]?.state).toEqual({});
    expect(requests[1]?.state).toEqual({});
  });

  it("問いの名前の頭は、Build の仕分け（triage・support）と違う", () => {
    expect(SURFACE_TRIAGE_QUESTION_PREFIX).not.toBe(TRIAGE_QUESTION_PREFIX);
    expect(SURFACE_SUPPORT_QUESTION_PREFIX).not.toBe(SUPPORT_QUESTION_PREFIX);
    expect(surfaceTriageQuestionName(0)).toBe("plan-triage:0");
    expect(surfaceSupportQuestionName(0)).toBe("plan-support:0");
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
    expect(result).toEqual({
      accepted: [],
      dropped: [],
      ambiguities: [],
      unchecked: [],
      judgments: [],
      diagnostics: [],
    });
  });
});

// ── 再点検（Luna の別の会話）。確信度不明・低確信・書いていないを独立に点検する（Issue #432）──

describe("未確定の申告を、Luna の別の会話で再点検する（05 §3・Issue #432）", () => {
  it("確信度を返せない正常な LLM の判定でも、証拠つきの独立の点検に届く（落とし先で受理）", async () => {
    const { run, requests } = check(surface(HOLE), RECHECK_ACCEPT);
    const result = await run;

    expect(result.accepted).toEqual([HOLE]);
    // 仕分け（主）と再点検（落とし先）の 2 回だけ
    expect(requests).toHaveLength(2);
    expect(Object.keys(requests[0]?.questions ?? {})).toEqual(["plan-triage:0"]);
    expect(Object.keys(requests[1]?.questions ?? {})).toEqual([
      "plan-recheck-kind:0",
      "plan-recheck-evidence:0",
    ]);
    // 根拠（有限の ID）が診断に残る
    const diagnostic = result.diagnostics[0];
    expect(diagnostic).toMatchObject({
      index: 0,
      requirementId: "R-1",
      stage: "recheck",
      classification: "vocabulary-hole",
      evidenceId: "アプリの名前・説明",
      docVersion: "v1",
    });
  });

  it("再点検は落とし先（Luna）へ行く（同じ口を送り直さない）。問いの欄に要件と候補の節が載る", async () => {
    const primary = createFakeJudge({ [surfaceTriageQuestionName(0)]: choice("vocabulary-hole") }, { model: "fake-primary" });
    const luna = createFakeJudge(
      {
        [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
        [surfaceRecheckEvidenceQuestionName(0)]: choice("アプリの名前・説明", 0.9),
      },
      { model: "fake-luna" },
    );
    const requests: JudgeRequest[] = [];
    const judge: Judge = {
      async judge(request) {
        requests.push(request);
        return primary.judge(request);
      },
      fallback: {
        async judge(request) {
          requests.push(request);
          return luna.judge(request);
        },
      },
    };
    const result = await runSurfaceCheck({
      surface: surface(HOLE),
      documents: SAMPLE_DOCUMENTS,
      judge,
      threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
      requirements: REQUIREMENTS,
      docVersion: "v1",
    });

    // 再点検の答えは落とし先（fake-luna）から来ている（主 fake-primary ではない）
    const recheck = result.judgments.find((judgment) => judgment.questionId === "plan-recheck-kind:0");
    expect(recheck?.model).toBe("fake-luna");
    // 再点検の仕分けの問いに、対象の要件がデータとして載る（生成役の会話は引き継がない）
    const recheckRequest = requests[1];
    expect(recheckRequest?.questions[surfaceRecheckKindQuestionName(0)]?.instructions).toMatchObject({
      requirement: "要件 R-1 の文",
    });
    // 根拠の問いに、候補の節（コードが取り出した本文つき）が載る
    const evidenceInstructions = instructionsOf(recheckRequest?.questions[surfaceRecheckEvidenceQuestionName(0)]);
    expect(JSON.stringify(evidenceInstructions?.candidates)).toContain("アプリの名前・説明");
    expect(result.accepted).toEqual([HOLE]);
  });

  it("落とし先が根拠（none）を返したら、受理せず未点検（根拠不足）にする", async () => {
    const { run } = check(surface(HOLE), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole"),
      [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceRecheckEvidenceQuestionName(0)]: choice(SURFACE_RECHECK_NO_EVIDENCE, 0.9),
    });
    const result = await run;

    expect(result.accepted).toEqual([]);
    expect(result.unchecked).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "not-stated" },
    ]);
    expect(result.diagnostics[0]).toMatchObject({ stage: "recheck", classification: "not-stated", evidenceId: null });
  });

  it("落とし先が判定不能（undecidable）なら、受理せず未点検にする", async () => {
    const { run } = check(surface(HOLE), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole"),
      [surfaceRecheckKindQuestionName(0)]: choice("undecidable", 0.9),
      [surfaceRecheckEvidenceQuestionName(0)]: choice("アプリの名前・説明", 0.9),
    });
    const result = await run;

    expect(result.accepted).toEqual([]);
    expect(result.unchecked).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "unknown" },
    ]);
  });

  it("確信度不明を数値で補わない（診断の確信度は null のまま）", async () => {
    const { run } = check(surface(HOLE), {
      // 主も落とし先も確信度を返せない（不明）
      [surfaceTriageQuestionName(0)]: choice("not-a-problem"),
      [surfaceRecheckKindQuestionName(0)]: choice("not-a-problem"),
      [surfaceRecheckEvidenceQuestionName(0)]: choice(SURFACE_RECHECK_NO_EVIDENCE),
    });
    const result = await run;

    expect(result.dropped).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", reason: "宣言に欄が無い", code: "not-a-problem" },
    ]);
    // 確信度は不明（null）。0 や 0.6 で補わない
    expect(result.diagnostics[0]?.confidence).toBeNull();
  });

  it("仕分けが未確定の申告を、裏付けだけで通さない（裏付けは呼ばない）", async () => {
    const { run, requests } = check(surface(HOLE), {
      // 仕分けは低確信（語彙の穴）——裏付けは高確信 supports でも通してはならない
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", DEFAULT_PLAN_JUDGE_THRESHOLD - 0.1),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
      // 再点検は判定不能
      [surfaceRecheckKindQuestionName(0)]: choice("undecidable", 0.9),
      [surfaceRecheckEvidenceQuestionName(0)]: choice(SURFACE_RECHECK_NO_EVIDENCE, 0.9),
    });
    const result = await run;

    // 仕分けが未確定なので、裏付けの問いは送らない
    expect(requests.some((request) => Object.keys(request.questions).includes(surfaceSupportQuestionName(0)))).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.unchecked).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "unknown" },
    ]);
  });

  it("落とし先も失敗したら、受理せず未点検にする（確認へ進ませない）", async () => {
    const judge: Judge = {
      ...createFakeJudge({ [surfaceTriageQuestionName(0)]: choice("vocabulary-hole") }, { model: "fake-primary" }),
      fallback: failingJudge(),
    };
    const result = await runSurfaceCheck({
      surface: surface(HOLE),
      documents: SAMPLE_DOCUMENTS,
      judge,
      threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
      requirements: REQUIREMENTS,
      docVersion: "v1",
    });

    expect(result.accepted).toEqual([]);
    expect(result.unchecked).toEqual([
      { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "unknown" },
    ]);
    expect(result.diagnostics[0]).toMatchObject({ stage: "recheck", adapter: "none", evidenceId: null });
  });

  it("同じ問いの無限の再試行にしない（再点検は 1 回だけ）", async () => {
    const { run, requests } = check(surface(HOLE), RECHECK_ACCEPT);
    await run;
    // 仕分け 1 回 + 再点検 1 回だけ
    expect(requests).toHaveLength(2);
  });
});

// ── 診断（C）。受理・落とした・途中停止のどれも、申告と判定を結び付ける（Issue #432）──

describe("診断に、申告と点検を結び付けて残す（Issue #432）", () => {
  it("受理した申告の診断に、申告の欄と点検の欄がそろう", async () => {
    const { run } = check(surface(HOLE), RECHECK_ACCEPT);
    const result = await run;

    expect(result.diagnostics).toEqual([
      {
        index: 0,
        requirementId: "R-1",
        part: "アプリ自体の名前・説明",
        reason: "宣言に欄が無い",
        constraintIds: ["アプリの名前・説明"],
        docVersion: "v1",
        stage: "recheck",
        classification: "vocabulary-hole",
        adapter: "fake",
        confidence: 0.9,
        evidenceId: "アプリの名前・説明",
      },
    ]);
  });

  it("落とした申告の診断も残す（受理と同じく、要件 ID・部分・分類を持つ）", async () => {
    const { run } = check(surface(HOLE), {
      [surfaceTriageQuestionName(0)]: choice("not-a-problem", 0.9),
    });
    const result = await run;

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        index: 0,
        requirementId: "R-1",
        part: "アプリ自体の名前・説明",
        stage: "triage",
        classification: "not-a-problem",
        adapter: "fake",
        confidence: 0.9,
        evidenceId: null,
      }),
    ]);
  });
});
