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
import { JudgeBudgetExceededError } from "../judge-budget.js";
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
import { createCallHash } from "./claim-recorded-judge.js";
import {
  SURFACE_CHECK_VERSION,
  SURFACE_RECHECK_EVIDENCE_ASK_V2,
  SURFACE_RECHECK_KIND_ASK_V2,
  SURFACE_RECHECK_NO_EVIDENCE,
  SURFACE_SUPPORT_ASK_V2,
  SURFACE_SUPPORT_QUESTION_PREFIX,
  SURFACE_TRIAGE_ASK_V2,
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
 * 主の判定と再点検（Luna）の判定を別々に持つ、要求を記録する偽物。再点検の宛先は**明示的に渡す**
 * （`recheckJudge`。合成した口をもう一度呼ぶと主が答え直すだけなので、主は再点検に使わない）。
 * 既定では再点検も同じ答えを使う（落とし先を指定しない試験は、同じ写像で再点検にも答える）。
 */
function recordingJudge(
  answers: Readonly<Record<string, JudgeAnswer>>,
  recheckAnswers: Readonly<Record<string, JudgeAnswer>> = answers,
): { readonly judge: Judge; readonly recheckJudge: Judge; readonly requests: JudgeRequest[] } {
  const primary = createFakeJudge(answers, { model: "fake-judge" });
  const luna = createFakeJudge(recheckAnswers, { model: "fake-luna" });
  const requests: JudgeRequest[] = [];
  return {
    judge: {
      async judge(request: JudgeRequest) {
        requests.push(request);
        return primary.judge(request);
      },
    },
    recheckJudge: {
      async judge(request: JudgeRequest) {
        requests.push(request);
        return luna.judge(request);
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
      recheckJudge: recording.recheckJudge,
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
    // state には依頼文（原文）を入れない。載るのは文書と要件の一覧（点検の材料）だけ（Issue #910）
    expect(Object.keys(requests[0]?.state ?? {})).toEqual(["documents", "requirements"]);
    expect(Object.keys(requests[1]?.state ?? {})).toEqual(["documents", "requirements"]);
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
    };
    const recheckJudge: Judge = {
      async judge(request) {
        requests.push(request);
        return luna.judge(request);
      },
    };
    const result = await runSurfaceCheck({
      surface: surface(HOLE),
      documents: SAMPLE_DOCUMENTS,
      judge,
      recheckJudge,
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
    const judge = createFakeJudge({ [surfaceTriageQuestionName(0)]: choice("vocabulary-hole") }, { model: "fake-primary" });
    const result = await runSurfaceCheck({
      surface: surface(HOLE),
      documents: SAMPLE_DOCUMENTS,
      judge,
      recheckJudge: failingJudge(),
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

// ── 未知の答えは、確信度にかかわらず拒否する（Issue #432）──────────────────────

describe("未知の答えを、確信度で分けない（Issue #432）", () => {
  it("仕分けの未知のラベルは、高確信・低確信・不明のどれでも未点検に残し、再点検へ回さない", async () => {
    for (const confidence of [0.9, DEFAULT_PLAN_JUDGE_THRESHOLD - 0.1, undefined]) {
      const { run, requests } = check(surface(HOLE), {
        [surfaceTriageQuestionName(0)]: choice("???", confidence),
      });
      const result = await run;
      // 有限の選択肢に無い答えは、確信度にかかわらず未点検（受理にも落とすにも転じない）
      expect(result.accepted, String(confidence)).toEqual([]);
      expect(result.dropped, String(confidence)).toEqual([]);
      expect(result.ambiguities, String(confidence)).toEqual([]);
      expect(result.unchecked, String(confidence)).toEqual([
        { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "unknown" },
      ]);
      // 再点検へは回さない（仕分け 1 回だけ）
      expect(requests, String(confidence)).toHaveLength(1);
    }
  });

  it("裏付けの未知のラベルも、高確信・低確信・不明のどれでも未点検に残す（再点検へ回さない）", async () => {
    for (const confidence of [0.9, DEFAULT_PLAN_JUDGE_THRESHOLD - 0.1, undefined]) {
      const { run, requests } = check(surface(HOLE), {
        [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
        [surfaceSupportQuestionName(0)]: choice("???", confidence),
      });
      const result = await run;
      expect(result.accepted, String(confidence)).toEqual([]);
      expect(result.unchecked, String(confidence)).toEqual([
        { index: 0, requirementId: "R-1", part: "アプリ自体の名前・説明", code: "unknown" },
      ]);
      // 仕分け + 裏付けの 2 回だけ（再点検はしない）
      expect(requests, String(confidence)).toHaveLength(2);
    }
  });
});

// ── Luna の口が無ければ再点検しない（主を再点検に使わない。Issue #432）───────────

describe("再点検の宛先が無いとき（Issue #432）", () => {
  it("Luna の口が無ければ、再点検せず未点検に残す（主を再点検に使わない）", async () => {
    const judge = createFakeJudge({
      // 仕分けは確信度不明（閾値未満）→ 再点検へ回したいが、宛先が無い
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole"),
      // 主が万一再点検に使われたら受理してしまう答えを持たせておく（使われないことを確かめる）
      [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceRecheckEvidenceQuestionName(0)]: choice("アプリの名前・説明", 0.9),
    });
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
});

// ── 最初の判定の予約が失敗しても、全申告の診断が残る（Issue #432）───────────────

describe("最初の判定で止まっても、全申告の診断が残る（Issue #432）", () => {
  it("最初の判定の予約が失敗したら、全申告が未実行の印で報告される", async () => {
    const second = claim("U-1", "R-2", "部分 2", ["記録"], "理由 2");
    const judge: Judge = {
      async judge() {
        throw new JudgeBudgetExceededError(1, 0);
      },
    };
    const progress: { readonly index: number; readonly stage: string; readonly classification: string; readonly docVersion: string }[][] = [];
    await expect(
      runSurfaceCheck({
        surface: surface(HOLE, second),
        documents: SAMPLE_DOCUMENTS,
        judge,
        threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
        requirements: REQUIREMENTS,
        docVersion: "v1",
        onProgress: (partial) =>
          progress.push(
            partial.diagnostics.map((entry) => ({
              index: entry.index,
              stage: entry.stage,
              classification: entry.classification,
              docVersion: entry.docVersion,
            })),
          ),
      }),
    ).rejects.toBeInstanceOf(JudgeBudgetExceededError);

    // 判定を呼ぶ前に、全申告の最小データと未実行の印が報告される（申告が無かった場合と区別できる）
    expect(progress.at(-1)).toEqual([
      { index: 0, stage: "unexecuted", classification: "unexecuted", docVersion: "v1" },
      { index: 1, stage: "unexecuted", classification: "unexecuted", docVersion: "v1" },
    ]);
  });
});

// ── v2：独立点検に要件と文書の全体を渡し、要件が書けるかを問う（Issue #910）──────────────
//
// **偽物の判定で回す。** ここで固定するのは**要求の材料と問いの文と門**である——偽物の答えの緑は、
// 意味の判断の効き目の証明ではない（効き目は窓口が実 Plan で確かめる）。

/** 主の仕分け → 裏付け（書いていない）→ 再点検、の 3 要求をすべて出させる答え */
const ALL_THREE = {
  [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
  [surfaceSupportQuestionName(0)]: choice("not-stated", 0.9),
  [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
  [surfaceRecheckEvidenceQuestionName(0)]: choice("記録", 0.9),
};

/** 一般名の申告（制約 ID 1 つ。要件を書く別の表現が文書の他の節にある型） */
const GENERIC = claim("U-0", "R-1", "参照ごとの件数", ["記録"], "記録の節に参照ごとの件数を数える手段が無い");

/** 申告の制約の節（記録）の**外**にある文書の本文（他の節・他の文書） */
const OUTSIDE_SECTION_TEXTS = [
  "合計の意味の説明。",
  "計算の意味の説明。",
  "アプリ自体の名前や説明を置く欄は無い。",
  "R-NAME-10 集計の where は this を使う。",
  "使ってよい語彙の台帳。",
];

describe("v2：主の 2 問と再点検に、文書の全体と全要件を渡す（Issue #910）", () => {
  it("一般名の申告から組み立てた 3 要求に、申告の節の外の文書の本文と、全要件の id・text が含まれる", async () => {
    const { run, requests } = check(surface(GENERIC), ALL_THREE);
    await run;

    expect(requests.map((request) => Object.keys(request.questions))).toEqual([
      ["plan-triage:0"],
      ["plan-support:0"],
      ["plan-recheck-kind:0", "plan-recheck-evidence:0"],
    ]);
    for (const request of requests) {
      const sent = JSON.stringify(request);
      for (const text of OUTSIDE_SECTION_TEXTS) expect(sent).toContain(JSON.stringify(text).slice(1, -1));
      for (const [id, text] of REQUIREMENTS) {
        expect(sent).toContain(id);
        expect(sent).toContain(text);
      }
      // 材料は、渡した文書の全体（名前と本文）と要件の一覧（id と text）そのもの
      expect(request.state).toEqual({
        documents: SAMPLE_DOCUMENTS.map((document) => ({ name: document.name, text: document.text })),
        requirements: [
          { id: "R-1", text: "要件 R-1 の文" },
          { id: "R-2", text: "要件 R-2 の文" },
        ],
      });
    }
  });

  it("主の 2 問の欄に、対象の要件（id と文）が載る", async () => {
    const { run, requests } = check(surface(GENERIC), ALL_THREE);
    await run;

    for (const [index, name] of [
      [0, surfaceTriageQuestionName(0)],
      [1, surfaceSupportQuestionName(0)],
      [2, surfaceRecheckKindQuestionName(0)],
      [2, surfaceRecheckEvidenceQuestionName(0)],
    ] as const) {
      expect(requests[index]?.questions[name]?.instructions).toMatchObject({
        requirementId: "R-1",
        requirement: "要件 R-1 の文",
      });
    }
  });

  it("同じ文書の組・要件の組なら、申告の制約 ID・部分・要件 ID を変えても材料が変わらない", async () => {
    const other = claim("U-9", "R-2", "別の部分", ["アプリの名前・説明", "R-NAME-10"], "別の理由");
    const a = check(surface(GENERIC), ALL_THREE);
    await a.run;
    const b = check(surface(other), ALL_THREE);
    await b.run;

    expect(a.requests).toHaveLength(3);
    expect(b.requests).toHaveLength(3);
    for (let index = 0; index < 3; index += 1) {
      expect(b.requests[index]?.state).toEqual(a.requests[index]?.state);
    }
  });

  it("材料の要件は、呼ぶ側が渡した一覧だけ（代わりの案の要件・了承除外の印・代わりの案の文は載らない）", async () => {
    const withAlternative = claim("U-0", "R-1", "参照ごとの件数", ["記録"], "理由", "代わりの案の文（採否）");
    const { run, requests } = check(surface(withAlternative), ALL_THREE, {
      requirements: new Map([
        ["R-1", "要件 R-1 の文"],
        ["R:alt:U-7", "前の代わりの案の要件"],
      ]),
      materialRequirements: [{ id: "R-1", text: "要件 R-1 の文" }],
    });
    await run;

    for (const request of requests) {
      const material = JSON.stringify(request.state);
      expect(material).not.toContain("R:alt:");
      expect(material).not.toContain("前の代わりの案の要件");
      expect(material).not.toContain("accepted_removal");
      // 申告の代わりの案（過去の判断）は、問いにも材料にも載らない
      expect(JSON.stringify(request)).not.toContain("代わりの案の文（採否）");
    }
  });

  it("問いは、申告の方法ではなく要件が文書の許すどの表現でも書けないかを問う（文は ASCII）", async () => {
    const { run, requests } = check(surface(GENERIC), ALL_THREE);
    await run;

    const asks = [
      [requests[0]?.questions[surfaceTriageQuestionName(0)], SURFACE_TRIAGE_ASK_V2],
      [requests[1]?.questions[surfaceSupportQuestionName(0)], SURFACE_SUPPORT_ASK_V2],
      [requests[2]?.questions[surfaceRecheckKindQuestionName(0)], SURFACE_RECHECK_KIND_ASK_V2],
      [requests[2]?.questions[surfaceRecheckEvidenceQuestionName(0)], SURFACE_RECHECK_EVIDENCE_ASK_V2],
    ] as const;
    for (const [question, ask] of asks) {
      // 送った問いの文そのものが、対象の要件を、文書の許す表現の**どれでも**書けないかを問う
      const sent = String(instructionsOf(question)?.ask);
      expect(sent).toContain("target requirement");
      expect(sent).toMatch(/any expression the documents (in state )?permit/);
      expect(sent).toMatch(/^[\x20-\x7E]+$/);
      expect(sent).toBe(ask);
    }
  });

  it("答えの有限の集合は前後で同じ（仕分け 3・裏付け 3・再点検 4）。根拠の候補は申告の制約 ID と none だけ", async () => {
    const { run, requests } = check(surface(GENERIC), ALL_THREE);
    await run;
    const keys = (question: JudgeQuestion | undefined): string[] =>
      question !== undefined && question.kind === "choice" ? Object.keys(question.criteria).sort() : [];

    expect(keys(requests[0]?.questions[surfaceTriageQuestionName(0)])).toEqual(["ambiguity", "not-a-problem", "vocabulary-hole"]);
    expect(keys(requests[1]?.questions[surfaceSupportQuestionName(0)])).toEqual(["contradicts", "not-stated", "supports"]);
    expect(keys(requests[2]?.questions[surfaceRecheckKindQuestionName(0)])).toEqual([
      "ambiguity",
      "not-a-problem",
      "undecidable",
      "vocabulary-hole",
    ]);
    // 文書の他の節（合計・computed・アプリの名前・説明）は、照らす文脈であって根拠の候補ではない
    expect(keys(requests[2]?.questions[surfaceRecheckEvidenceQuestionName(0)])).toEqual(["none", "記録"]);
  });

  it("再点検が申告の外の節を根拠に選んでも受理しない（根拠の候補の外は根拠なし）", async () => {
    const { run } = check(surface(GENERIC), {
      ...ALL_THREE,
      [surfaceRecheckEvidenceQuestionName(0)]: choice("合計", 0.9),
    });
    const result = await run;

    expect(result.accepted).toEqual([]);
    expect(result.unchecked).toEqual([{ index: 0, requirementId: "R-1", part: "参照ごとの件数", code: "not-stated" }]);
  });

  it("正しい申告は偽の判定の下で今までどおり受理され、反証された申告は落ちる", async () => {
    const accepted = check(surface(GENERIC), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.9),
    });
    expect((await accepted.run).accepted).toEqual([GENERIC]);

    const refuted = check(surface(GENERIC), {
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("contradicts", 0.9),
    });
    const result = await refuted.run;
    expect(result.accepted).toEqual([]);
    expect(result.dropped.map((entry) => entry.code)).toEqual(["contradicts"]);
  });

  it("主の supports だけでは、仕分けが未確定の申告を通さない（門は前後で同じ）", async () => {
    const requests: JudgeRequest[] = [];
    const primary = createFakeJudge({
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", DEFAULT_PLAN_JUDGE_THRESHOLD - 0.1),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    // 再点検の宛先（Luna）を渡さない
    const result = await runSurfaceCheck({
      surface: surface(GENERIC),
      documents: SAMPLE_DOCUMENTS,
      judge: {
        async judge(request) {
          requests.push(request);
          return primary.judge(request);
        },
      },
      threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
      requirements: REQUIREMENTS,
      docVersion: "v1",
    });

    expect(result.accepted).toEqual([]);
    expect(result.unchecked.map((entry) => entry.code)).toEqual(["unknown"]);
    // 裏付けは呼ばず、再点検の宛先が無いので再試行も足さない（主の 1 回だけ）
    expect(requests).toHaveLength(1);
  });

  it("本番の版は v2", () => {
    expect(SURFACE_CHECK_VERSION).toBe("v2");
  });
});

describe("v1 の要求は、過去の記録のハッシュが当たる形のまま再生できる（Issue #910）", () => {
  it("checkVersion: v1 の 3 要求は、変更前の要求とハッシュが一致する（state は空）", async () => {
    const { run, requests } = check(surface(HOLE), ALL_THREE, { checkVersion: "v1" });
    await run;

    // 変更前（main・e471996）の点検で同じ申告・文書・要件から組んだ要求のハッシュ
    const hashes = await Promise.all(requests.map((request) => createCallHash(request)));
    expect(hashes).toEqual([
      "79038243148e03195132f2296c2e2f80c62e6761b7f94a978580dbd7f678bbbf",
      "a056b02ac4e2569fd325c5657ce334e57b39ffa5157e833ef945ea5cabd7fde4",
      "5417167c85abd38d0d98fab84970c2b97c2503104c66f5cae1d0d4b446e7e20f",
    ]);
    for (const request of requests) expect(request.state).toEqual({});
  });

  it("v2 の要求は、同じ申告の v1 の要求とハッシュが違う（過去の記録を新しい要求の記録にしない）", async () => {
    const v1 = check(surface(HOLE), ALL_THREE, { checkVersion: "v1" });
    await v1.run;
    const v2 = check(surface(HOLE), ALL_THREE);
    await v2.run;

    const v1Hashes = await Promise.all(v1.requests.map((request) => createCallHash(request)));
    const v2Hashes = await Promise.all(v2.requests.map((request) => createCallHash(request)));
    expect(v2Hashes).toHaveLength(3);
    for (const hash of v2Hashes) expect(v1Hashes).not.toContain(hash);
  });
});
