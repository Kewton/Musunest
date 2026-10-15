// P6 照合と確定（plan/confirm.ts）の unit テスト（04-plan-agent.md §3 P6・§4）。
//
// **偽物の判定で回す。実 API は呼ばない。** ここで固定したいのは 3 つ。
//   1. 答えから増えた要件の出どころが、その答えの ID になる
//   2. 覆われていない原文の文があれば確定しない
//   3. どの要件にも使われていない答えがあれば確定しない
import { describe, expect, it } from "vitest";
import type {
  PlanAcceptedUnwritable,
  PlanAnswerInput,
  PlanDecision,
  PlanInput,
  PlanOpenIssue,
  PlanQuestionInput,
  PlanRequirement,
  PlanSourceInput,
} from "@musunest/appspec-schema";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer, JudgeQuestion, JudgeRequest, JudgeResponse } from "../judge.js";
import { confirmQuestionName, runConfirm, type ConfirmInput } from "./confirm.js";

const noul = (value: number): JudgeAnswer => ({ kind: "noul", noul: value });

/** 問いの `instructions` を写像として読む（object でないときは undefined） */
function instructionsOf(question: JudgeQuestion | undefined): Record<string, unknown> | undefined {
  const instructions = question?.instructions;
  return typeof instructions === "object" ? (instructions as Record<string, unknown>) : undefined;
}

/** すべての覆いの問いに「覆われている」を返しつつ、受け取った要求を残す偽物の判定 */
function recordingJudge(): { readonly judge: Judge; readonly requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  const judge: Judge = {
    async judge(request: JudgeRequest) {
      requests.push(request);
      const answers: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(request.questions)) answers[name] = noul(0.9);
      return { answers, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
    },
  };
  return { judge, requests };
}

const THRESHOLD = 0.6;

const SOURCE = "タスクを記録する。";

const sourceInput: PlanSourceInput = { id: "S-1", kind: "source", text: "タスクを記録する。" };
const questionInput: PlanQuestionInput = {
  id: "Q-1",
  kind: "question",
  open_issue_id: "OI-1",
  text: "誰の分を数えるか",
  choices: [
    { id: "c1", text: "全員" },
    { id: "c2", text: "自分のみ" },
  ],
  recommended: { choice_id: "c1", reason: "依頼に沿う" },
};
const answerInput: PlanAnswerInput = { id: "A-1", kind: "answer", question_id: "Q-1", free_text: "自分のみ" };

const OPEN_ISSUE: PlanOpenIssue = {
  id: "OI-1",
  text: "誰の分を数えるか",
  critical: true,
  status: "resolved",
  resolution: { answer_id: "A-1" },
};

/** 正しい仕様を作る材料（要件 R-1 が原文を覆い、R-2 が答えから増える） */
function validInput(overrides: Partial<ConfirmInput> = {}): ConfirmInput {
  const requirements: readonly PlanRequirement[] = [
    { id: "R-1", text: "タスクを記録できる", kind: "existence", origin: { input_id: "S-1", quote: "タスクを記録する。" }, parts: [] },
    {
      id: "R-2",
      text: "自分の分だけを数える",
      kind: "constraining",
      origin: { input_id: "S-1", quote: "タスクを記録する。" },
      change: { kind: "added", answer_id: "A-1" },
      parts: [],
    },
  ];
  const inputs: readonly PlanInput[] = [sourceInput, questionInput, answerInput];
  const answers: Record<string, JudgeAnswer> = {
    [confirmQuestionName("S-1")]: noul(0.95),
    [confirmQuestionName("A-1")]: noul(0.9),
  };
  return {
    planId: "plan-1",
    revision: 1,
    vocabularyVersion: "vocab-1",
    source: SOURCE,
    inputs,
    requirements,
    openIssues: [OPEN_ISSUE],
    decisions: [],
    acceptedUnwritable: [],
    confirmedBy: "tester",
    confirmedAt: "2026-10-10T00:00:00Z",
    judge: createFakeJudge(answers, { model: "fake-judge" }),
    threshold: THRESHOLD,
    ...overrides,
  };
}

describe("P6 の照合と確定（04 §3 P6・§4）", () => {
  it("答えから増えた要件の出どころが、その答えの ID になる", async () => {
    const result = await runConfirm(validInput());
    const added = result.plan.requirements.find((requirement) => requirement.id === "R-2");
    expect(added?.origin.input_id).toBe("A-1");
    expect(added?.origin.quote).toBe("自分の分だけを数える");
    expect(result.confirmed).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("確認の SHA-256 が仕様と一致する（§4）", async () => {
    const result = await runConfirm(validInput());
    expect(result.plan.confirmation.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plan.confirmation.confirmed_by).toBe("tester");
  });

  it("覆われていない原文の文があれば確定しない", async () => {
    const result = await runConfirm(
      validInput({
        source: "タスクを記録する。件数を合計する。",
        requirements: [
          { id: "R-1", text: "タスクを記録できる", kind: "existence", origin: { input_id: "S-1", quote: "タスクを記録する。" }, parts: [] },
        ],
      }),
    );
    expect(result.confirmed).toBe(false);
    expect(result.problems.map((problem) => problem.code)).toContain("uncovered-source");
    // 誤りの文は固定文で、原文の値を埋めない。位置は path の添字で示す（Issue #445）
    expect(
      result.problems.some(
        (problem) =>
          problem.code === "uncovered-source" &&
          problem.path === "source[1]" &&
          problem.message === "原文の文がどの要件にも覆われていない",
      ),
    ).toBe(true);
    expect(result.problems.some((problem) => problem.message.includes("件数を合計する。"))).toBe(false);
  });

  it("枠の文は要件にしなくても、枠の範囲で覆われていれば確定できる（Issue #372）", async () => {
    const source = "アプリを作ってください。タスクを記録する。";
    const framingQuote = "アプリを作ってください";
    const framing: PlanSourceInput = { id: "S-1", kind: "source", text: "アプリを作ってください。" };
    const record: PlanSourceInput = { id: "S-2", kind: "source", text: "タスクを記録する。" };
    const result = await runConfirm(
      validInput({
        source,
        framing: [{ start: 0, end: framingQuote.length }],
        requirements: [
          {
            id: "R-1",
            text: "タスクを記録できる",
            kind: "existence",
            origin: { input_id: "S-2", quote: "タスクを記録する" },
            parts: [],
          },
        ],
        inputs: [framing, record],
        openIssues: [],
        decisions: [],
        judge: createFakeJudge(
          { [confirmQuestionName("S-1")]: noul(0.9), [confirmQuestionName("S-2")]: noul(0.95) },
          { model: "fake-judge" },
        ),
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.confirmed).toBe(true);
    // 確定した仕様に framing は入らず、枠の要件も増えない（枠の文は要件にしない）
    expect(Object.keys(result.plan)).not.toContain("framing");
    expect(result.plan.requirements.map((requirement) => requirement.id)).toEqual(["R-1"]);
  });

  it("枠の範囲を渡さなければ、枠の文は覆われていない原文として扱われる（Issue #372）", async () => {
    const source = "アプリを作ってください。タスクを記録する。";
    const result = await runConfirm(
      validInput({
        source,
        requirements: [
          {
            id: "R-1",
            text: "タスクを記録できる",
            kind: "existence",
            origin: { input_id: "S-2", quote: "タスクを記録する" },
            parts: [],
          },
        ],
        inputs: [
          { id: "S-1", kind: "source", text: "アプリを作ってください。" },
          { id: "S-2", kind: "source", text: "タスクを記録する。" },
        ],
        openIssues: [],
        decisions: [],
        judge: createFakeJudge(
          { [confirmQuestionName("S-1")]: noul(0.9), [confirmQuestionName("S-2")]: noul(0.95) },
          { model: "fake-judge" },
        ),
      }),
    );
    expect(result.confirmed).toBe(false);
    expect(result.problems.map((problem) => problem.code)).toContain("uncovered-source");
  });

  it("どの要件にも使われていない答えがあれば確定しない", async () => {
    const extraAnswer: PlanAnswerInput = { id: "A-2", kind: "answer", question_id: "Q-1", free_text: "全員" };
    const result = await runConfirm(
      validInput({
        inputs: [sourceInput, questionInput, answerInput, extraAnswer],
        judge: createFakeJudge(
          {
            [confirmQuestionName("S-1")]: noul(0.95),
            [confirmQuestionName("A-1")]: noul(0.9),
            [confirmQuestionName("A-2")]: noul(0.9),
          },
          { model: "fake-judge" },
        ),
      }),
    );
    expect(result.confirmed).toBe(false);
    expect(result.problems.map((problem) => problem.code)).toContain("uncovered-answer");
  });

  it("#331 の検査の誤り（重大な事項が開いたまま）も、確定できない理由になる", async () => {
    const openIssue: PlanOpenIssue = { id: "OI-1", text: "誰の分を数えるか", critical: true, status: "open" };
    const result = await runConfirm(validInput({ openIssues: [openIssue] }));
    expect(result.confirmed).toBe(false);
    expect(result.planProblems.map((problem) => problem.code)).toContain("open_critical");
  });

  it("P6 の問いに、原文の文・自由入力の答え・選択式の答えの選択肢の文（元の問いの文つき）を問いごとに載せる（Issue #376）", async () => {
    const { judge, requests } = recordingJudge();
    const freeAnswer: PlanAnswerInput = { id: "A-1", kind: "answer", question_id: "Q-1", free_text: "全員で数える" };
    const choiceAnswer: PlanAnswerInput = { id: "A-2", kind: "answer", question_id: "Q-1", choice_id: "c2" };
    await runConfirm(
      validInput({
        inputs: [sourceInput, questionInput, freeAnswer, choiceAnswer],
        judge,
      }),
    );

    const questions = requests[0]?.questions ?? {};
    const sourceQuestion = questions[confirmQuestionName("S-1")];
    const freeQuestion = questions[confirmQuestionName("A-1")];
    const choiceQuestion = questions[confirmQuestionName("A-2")];

    // instructions は object（対象の部分の文を問いの中に載せる）
    expect(sourceQuestion?.instructions).toBeTypeOf("object");
    expect(sourceQuestion?.instructions).toMatchObject({ part: "タスクを記録する。" });
    expect(freeQuestion?.instructions).toMatchObject({ part: "全員で数える" });
    // 選択式の答えは、質問 ID と選択肢 ID から選択肢の文（c2「自分のみ」）を引き、元の問いの文も添える
    expect(choiceQuestion?.instructions).toMatchObject({
      part: "自分のみ",
      choice_id: "c2",
      question: "誰の分を数えるか",
    });
    // 問いの文は英語
    expect(String(instructionsOf(sourceQuestion)?.ask)).toMatch(/^[\x20-\x7E]+$/);
    // 同じ呼び出しの中の 2 つの問いで、対象の文が別々になる
    expect(instructionsOf(sourceQuestion)?.part).not.toBe(instructionsOf(freeQuestion)?.part);
    expect(instructionsOf(freeQuestion)?.part).not.toBe(instructionsOf(choiceQuestion)?.part);
  });

  it("判定の記録に、覆いの問い・確率・閾値を満たしたかを残す", async () => {
    const result = await runConfirm(validInput());
    expect(result.judgments).toEqual([
      { questionId: "cover:S-1", value: 0.95, meetsThreshold: true, model: "fake-judge", answeredBy: "fake" },
      { questionId: "cover:A-1", value: 0.9, meetsThreshold: true, model: "fake-judge", answeredBy: "fake" },
    ]);
  });

  it("了承して除く部分の根拠も、§4 の形で持ち越せる", async () => {
    const accepted: readonly PlanAcceptedUnwritable[] = [
      {
        part_id: "P-1",
        alternative_id: "R-1",
        basis: { doc_version: "vocab-1", location: "### 記録", constraint_id: "記録" },
      },
    ];
    const requirements: readonly PlanRequirement[] = [
      {
        id: "R-1",
        text: "タスクを記録できる",
        kind: "existence",
        origin: { input_id: "S-1", quote: "タスクを記録する。" },
        parts: [{ id: "P-1", text: "アプリの名前", disposition: "accepted_removal" }],
      },
    ];
    const decisions: readonly PlanDecision[] = [];
    const result = await runConfirm(
      validInput({
        requirements,
        acceptedUnwritable: accepted,
        decisions,
        inputs: [sourceInput],
        judge: createFakeJudge({ [confirmQuestionName("S-1")]: noul(0.95) }, { model: "fake-judge" }),
        openIssues: [],
      }),
    );
    expect(result.confirmed).toBe(true);
    expect(result.plan.accepted_unwritable[0]?.part_id).toBe("P-1");
  });
});

// ── P6 の理由の code・path を保ち、message に値を埋めない（§3 P6・Issue #445）──────────

describe("P6 の理由の code・path を保ち、message に値を埋めない（§3 P6・Issue #445）", () => {
  const mark = "MARKER445";

  it("覆われていない原文の文の目印が、理由の直列化に出ない（code・path は今までどおり）", async () => {
    const marked = `${mark}。`;
    const result = await runConfirm(
      validInput({
        source: `${marked}タスクを記録する。`,
        inputs: [
          { id: "S-1", kind: "source", text: marked },
          { id: "S-2", kind: "source", text: "タスクを記録する。" },
        ],
        requirements: [
          { id: "R-1", text: "タスクを記録できる", kind: "existence", origin: { input_id: "S-2", quote: "タスクを記録する" }, parts: [] },
        ],
        openIssues: [],
        decisions: [],
        judge: createFakeJudge(
          { [confirmQuestionName("S-1")]: noul(0.9), [confirmQuestionName("S-2")]: noul(0.95) },
          { model: "fake-judge" },
        ),
      }),
    );
    expect(result.confirmed).toBe(false);
    const problem = result.problems.find((one) => one.code === "uncovered-source");
    expect(problem?.path).toBe("source[0]");
    expect(problem?.message).toBe("原文の文がどの要件にも覆われていない");
    expect(JSON.stringify(result.problems)).not.toContain(mark);
  });

  it("要件 ID の目印が、理由の直列化に出ない（code・path は今までどおり）", async () => {
    const result = await runConfirm(
      validInput({
        source: `タスクを記録する。${mark}を出す。`,
        inputs: [
          { id: "S-1", kind: "source", text: "タスクを記録する。" },
          { id: "S-2", kind: "source", text: `${mark}を出す。` },
        ],
        requirements: [
          { id: `R-${mark}`, text: "タスクを記録できる", kind: "existence", origin: { input_id: "S-1", quote: "タスクを記録する" }, parts: [] },
        ],
        openIssues: [],
        decisions: [],
        judge: createFakeJudge(
          { [confirmQuestionName("S-1")]: noul(0.95), [confirmQuestionName("S-2")]: noul(0.9) },
          { model: "fake-judge" },
        ),
      }),
    );
    expect(result.confirmed).toBe(false);
    const problem = result.problems.find((one) => one.code === "uncovered-source");
    expect(problem?.path).toBe("source[1]");
    // 要件 ID の目印は、理由の直列化（code・path・message）のどこにも出ない
    expect(JSON.stringify(result.problems)).not.toContain(mark);
  });
});

// ── 複数の文にまたがる引用の、原文の文との対応を P6 まで保つ（Issue #487）───────

describe("対応（重なる文の入力 ID）を P6 の覆いに使う（Issue #487）", () => {
  const TWO_SOURCE = "タスクを記録する。件数を合計する。";
  const twoInputs: readonly PlanInput[] = [
    { id: "S-1", kind: "source", text: "タスクを記録する。" },
    { id: "S-2", kind: "source", text: "件数を合計する。" },
  ];
  /** 2 文にまたがる引用を持つ要件 1 つ（出どころは最初の文の入力 `S-1`） */
  const spanning: readonly PlanRequirement[] = [
    {
      id: "R-1",
      text: "記録して合計できる",
      kind: "existence",
      origin: { input_id: "S-1", quote: "タスクを記録する。件数を合計する。" },
      parts: [],
    },
  ];
  /** 2 文の覆いの問いに「覆われている」を返す偽物の判定 */
  const twoSentenceJudge = () =>
    createFakeJudge(
      { [confirmQuestionName("S-1")]: noul(0.95), [confirmQuestionName("S-2")]: noul(0.95) },
      { model: "fake-judge" },
    );

  it("(c) 2 文の原文で、出どころが S-1、対応が S-1・S-2 の要件 1 つなら、覆いの誤りは無く確定できる", async () => {
    const result = await runConfirm(
      validInput({
        source: TWO_SOURCE,
        inputs: twoInputs,
        requirements: spanning,
        openIssues: [],
        decisions: [],
        sourceCorrespondence: new Map([["R-1", ["S-1", "S-2"]]]),
        judge: twoSentenceJudge(),
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.confirmed).toBe(true);
  });

  it("(d) 同じ組で対応を渡さないと、uncovered-source・source[1] の 1 件で確定しない（今の振る舞いの再現）", async () => {
    const result = await runConfirm(
      validInput({
        source: TWO_SOURCE,
        inputs: twoInputs,
        requirements: spanning,
        openIssues: [],
        decisions: [],
        judge: twoSentenceJudge(),
      }),
    );
    expect(result.confirmed).toBe(false);
    expect(result.problems).toEqual([
      { code: "uncovered-source", path: "source[1]", message: "原文の文がどの要件にも覆われていない" },
    ]);
  });

  it("(d2) 有効な対応が第 1・第 2 文だけを覆う 3 文の組では、第 3 文の 1 件が残って確定しない", async () => {
    const threeInputs: readonly PlanInput[] = [
      { id: "S-1", kind: "source", text: "タスクを記録する。" },
      { id: "S-2", kind: "source", text: "件数を合計する。" },
      { id: "S-3", kind: "source", text: "印を出す。" },
    ];
    const result = await runConfirm(
      validInput({
        source: "タスクを記録する。件数を合計する。印を出す。",
        inputs: threeInputs,
        requirements: spanning,
        openIssues: [],
        decisions: [],
        sourceCorrespondence: new Map([["R-1", ["S-1", "S-2"]]]),
        judge: createFakeJudge(
          {
            [confirmQuestionName("S-1")]: noul(0.95),
            [confirmQuestionName("S-2")]: noul(0.95),
            [confirmQuestionName("S-3")]: noul(0.95),
          },
          { model: "fake-judge" },
        ),
      }),
    );
    expect(result.confirmed).toBe(false);
    expect(result.problems).toEqual([
      { code: "uncovered-source", path: "source[2]", message: "原文の文がどの要件にも覆われていない" },
    ]);
  });

  it("(e) 対応の要件 ID が一覧に無い・原文の入力でない ID・実在しない ID は数えず、uncovered-source が残る", async () => {
    const result = await runConfirm(
      validInput({
        source: TWO_SOURCE,
        inputs: twoInputs,
        requirements: spanning,
        openIssues: [],
        decisions: [],
        sourceCorrespondence: new Map([
          // 要件の一覧に無い ID
          ["R-not-in-list", ["S-1", "S-2"]],
          // 一覧にある要件でも、原文の入力でない ID（答え）と実在しない ID は数えない
          ["R-1", ["A-1", "S-999"]],
        ]),
        judge: twoSentenceJudge(),
      }),
    );
    expect(result.confirmed).toBe(false);
    expect(result.problems).toEqual([
      { code: "uncovered-source", path: "source[1]", message: "原文の文がどの要件にも覆われていない" },
    ]);
  });

  it("(e) 出どころが答えへ正規化された要件の対応は数えず、uncovered-source が残る", async () => {
    const requirements: readonly PlanRequirement[] = [
      {
        id: "R-1",
        text: "記録できる",
        kind: "existence",
        origin: { input_id: "S-1", quote: "タスクを記録する。" },
        parts: [],
      },
      {
        id: "R-2",
        text: "合計できる",
        kind: "constraining",
        // 答えから増えた要件（`normalizeOrigins` で出どころが `A-1` へ寄る）
        origin: { input_id: "S-1", quote: "件数を合計する。" },
        change: { kind: "added", answer_id: "A-1" },
        parts: [],
      },
    ];
    const result = await runConfirm(
      validInput({
        source: TWO_SOURCE,
        inputs: [
          ...twoInputs,
          {
            id: "Q-1",
            kind: "question",
            open_issue_id: "OI-1",
            text: "誰の分を数えるか",
            choices: [
              { id: "c1", text: "全員" },
              { id: "c2", text: "自分のみ" },
            ],
            recommended: { choice_id: "c1", reason: "依頼に沿う" },
          },
          { id: "A-1", kind: "answer", question_id: "Q-1", free_text: "自分のみ" },
        ],
        requirements,
        openIssues: [{ id: "OI-1", text: "誰の分を数えるか", critical: true, status: "resolved", resolution: { answer_id: "A-1" } }],
        decisions: [],
        // `R-2` の対応は第 2 文を覆うが、出どころが答えへ正規化されるので数えない
        sourceCorrespondence: new Map([["R-2", ["S-2"]]]),
        judge: createFakeJudge(
          {
            [confirmQuestionName("S-1")]: noul(0.95),
            [confirmQuestionName("S-2")]: noul(0.95),
            [confirmQuestionName("A-1")]: noul(0.9),
          },
          { model: "fake-judge" },
        ),
      }),
    );
    expect(result.confirmed).toBe(false);
    expect(result.problems).toEqual([
      { code: "uncovered-source", path: "source[1]", message: "原文の文がどの要件にも覆われていない" },
    ]);
  });

  it("(f) 対応を渡しても、判定の口へ渡る state と問いの集合、plan（SHA-256 を含む）は渡さないときと等しい", async () => {
    const options = {
      source: TWO_SOURCE,
      inputs: twoInputs,
      requirements: spanning,
      openIssues: [],
      decisions: [],
    };
    const withCorrespondence = recordingJudge();
    const withoutCorrespondence = recordingJudge();
    const withResult = await runConfirm(
      validInput({ ...options, judge: withCorrespondence.judge, sourceCorrespondence: new Map([["R-1", ["S-1", "S-2"]]]) }),
    );
    const withoutResult = await runConfirm(validInput({ ...options, judge: withoutCorrespondence.judge }));

    expect(withCorrespondence.requests[0]?.state).toEqual(withoutCorrespondence.requests[0]?.state);
    expect(Object.keys(withCorrespondence.requests[0]?.questions ?? {}).sort()).toEqual(
      Object.keys(withoutCorrespondence.requests[0]?.questions ?? {}).sort(),
    );
    expect(withResult.plan).toEqual(withoutResult.plan);
    expect(withResult.plan.confirmation.sha256).toBe(withoutResult.plan.confirmation.sha256);
    // 対応の有無で変わるのは覆いの判定だけである（確定の可否は変わるが、仕様は変わらない）
    expect(withResult.confirmed).toBe(true);
    expect(withoutResult.confirmed).toBe(false);
  });
});

// ── P6 の文ごとの覆いを、番号と有限の分類で残す（Issue #488）────────────────────

describe("P6 の文ごとの覆いを、番号と有限の分類で残す（Issue #488）", () => {
  const SOURCE4 = "枠の文。出どころの文。対応の文。覆われない文。";
  const spanOf = (quote: string): { readonly start: number; readonly end: number } => {
    const start = SOURCE4.indexOf(quote);
    return { start, end: start + quote.length };
  };
  const sourceInputs4: readonly PlanInput[] = [
    { id: "S-1", kind: "source", text: "枠の文。" },
    { id: "S-2", kind: "source", text: "出どころの文。" },
    { id: "S-3", kind: "source", text: "対応の文。" },
    { id: "S-4", kind: "source", text: "覆われない文。" },
  ];
  const requirements4: readonly PlanRequirement[] = [
    { id: "R-1", text: "枠を出せる", kind: "existence", origin: { input_id: "S-1", quote: "枠の文。" }, parts: [] },
    { id: "R-2", text: "出どころを出せる", kind: "existence", origin: { input_id: "S-2", quote: "出どころの文。" }, parts: [] },
  ];
  /** 枠の範囲（1 文目の「枠の文」） */
  const framing4 = [spanOf("枠の文")];
  /** 対応（R-1 は S-1 由来。対応の並びに S-3 を持つ） */
  const correspondence4 = new Map([["R-1", ["S-3"]]]);
  /** 4 文への覆いの助言（閾値 0.6 の直前・ちょうど・直後を分ける） */
  const judge4 = () =>
    createFakeJudge(
      {
        [confirmQuestionName("S-1")]: noul(0.59),
        [confirmQuestionName("S-2")]: noul(0.6),
        [confirmQuestionName("S-3")]: noul(0.61),
        [confirmQuestionName("S-4")]: noul(0.9),
      },
      { model: "fake-judge" },
    );

  it("(e) 枠・出どころ・対応・無しを 1 つずつ持ち、複数の覆いが成立する文は先の分類になり、助言の閾値の前後を分ける", async () => {
    const result = await runConfirm(
      validInput({
        source: SOURCE4,
        inputs: sourceInputs4,
        requirements: requirements4,
        framing: framing4,
        sourceCorrespondence: correspondence4,
        openIssues: [],
        decisions: [],
        judge: judge4(),
      }),
    );
    expect(result.coverage).toEqual([
      { sentence: 1, coverage: "framing", correspondence: "false", meetsThreshold: false },
      { sentence: 2, coverage: "origin", correspondence: "false", meetsThreshold: true },
      { sentence: 3, coverage: "correspondence", correspondence: "true", meetsThreshold: true },
      { sentence: 4, coverage: "none", correspondence: "false", meetsThreshold: true },
    ]);
    // 既存の `problems`・`confirmed` は欄を足す前と等しい（4 文目だけが覆われていない）
    expect(result.problems).toEqual([
      { code: "uncovered-source", path: "source[3]", message: "原文の文がどの要件にも覆われていない" },
    ]);
    expect(result.confirmed).toBe(false);
    // `plan` に新しい欄は混ざらず、確認の SHA-256 も持つ
    expect(Object.keys(result.plan)).not.toContain("coverage");
    expect(result.plan.confirmation.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(e) 対応を渡さない単独呼び出しでは、対応が未観測になり、対応の文は覆いの根拠にならない", async () => {
    const result = await runConfirm(
      validInput({
        source: SOURCE4,
        inputs: sourceInputs4,
        requirements: requirements4,
        framing: framing4,
        openIssues: [],
        decisions: [],
        judge: judge4(),
      }),
    );
    expect(result.coverage.map((row) => row.correspondence)).toEqual([
      "unobserved",
      "unobserved",
      "unobserved",
      "unobserved",
    ]);
    expect(result.coverage.map((row) => row.coverage)).toEqual(["framing", "origin", "none", "none"]);
    // 対応が無いので、3 文目・4 文目が覆われていない
    expect(result.problems.map((problem) => problem.path)).toEqual(["source[2]", "source[3]"]);
  });

  it("(e) 対応を渡して、当該文を含まなければ、その文の対応は偽になる", async () => {
    const result = await runConfirm(
      validInput({
        source: SOURCE4,
        inputs: sourceInputs4,
        requirements: requirements4,
        framing: framing4,
        // 対応の並びに S-3 を含まない（3 文目は対応で覆われない）
        sourceCorrespondence: new Map([["R-1", ["S-2"]]]),
        openIssues: [],
        decisions: [],
        judge: judge4(),
      }),
    );
    expect(result.coverage[2]).toEqual({
      sentence: 3,
      coverage: "none",
      correspondence: "false",
      meetsThreshold: true,
    });
  });

  it("(指摘2) 同じ文が2回現れても、診断は文番号の入力を用い、2 文目の対応の重なりを偽にしない", async () => {
    // 1 文目を枠、2 文目を唯一の候補要件の引用にする（本文は同じ「甲。」）
    const TWO_SAME = "甲。甲。";
    const twoSameInputs: readonly PlanInput[] = [
      { id: "S-1", kind: "source", text: "甲。" },
      { id: "S-2", kind: "source", text: "甲。" },
    ];
    const twoSameRequirements: readonly PlanRequirement[] = [
      { id: "R-1", text: "記録できる", kind: "existence", origin: { input_id: "S-2", quote: "甲。" }, parts: [] },
    ];
    const result = await runConfirm(
      validInput({
        source: TWO_SAME,
        inputs: twoSameInputs,
        requirements: twoSameRequirements,
        framing: [{ start: 0, end: 2 }],
        sourceCorrespondence: new Map([["R-1", ["S-2"]]]),
        openIssues: [],
        decisions: [],
        judge: createFakeJudge(
          { [confirmQuestionName("S-1")]: noul(0.95), [confirmQuestionName("S-2")]: noul(0.95) },
          { model: "fake-judge" },
        ),
      }),
    );
    // 文番号の入力（2 文目＝S-2）で診断する。P2 の対応に S-2 が含まれ、覆いの分類も出どころになる
    expect(result.coverage).toEqual([
      { sentence: 1, coverage: "framing", correspondence: "false", meetsThreshold: true },
      { sentence: 2, coverage: "origin", correspondence: "true", meetsThreshold: true },
    ]);
    // ゲート（`covered`・`problems`）は今までどおり本文の一致で見るので、2 文目は覆われていないままである
    expect(result.problems).toEqual([
      { code: "uncovered-source", path: "source[1]", message: "原文の文がどの要件にも覆われていない" },
    ]);
    expect(result.confirmed).toBe(false);
  });

  it("(指摘6) 助言が欠けた・種類が違う場合は閾値以上かを未観測にし、実際の 0 と区別する", async () => {
    const threeInputs: readonly PlanInput[] = [
      { id: "S-1", kind: "source", text: "枠の文。" },
      { id: "S-2", kind: "source", text: "対応の文。" },
      { id: "S-3", kind: "source", text: "印の文。" },
    ];
    // S-1 には答えない（欠落）、S-2 には別の種類、S-3 には Noul の 0 を返す
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        const answers: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) {
          if (name === confirmQuestionName("S-2")) {
            answers[name] = { kind: "choice", choice: "x", probabilities: undefined, probability: undefined, confidence: 0.9 };
          } else if (name === confirmQuestionName("S-3")) {
            answers[name] = noul(0);
          }
        }
        return { answers, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
      },
    };
    const result = await runConfirm(
      validInput({
        source: "枠の文。対応の文。印の文。",
        inputs: threeInputs,
        requirements: [],
        openIssues: [],
        decisions: [],
        judge,
      }),
    );
    // 有効な助言が無い 1・2 文目は未観測（`null`）、実際に 0 を返した 3 文目だけが閾値未満（偽）になる
    expect(result.coverage).toEqual([
      { sentence: 1, coverage: "none", correspondence: "unobserved", meetsThreshold: null },
      { sentence: 2, coverage: "none", correspondence: "unobserved", meetsThreshold: null },
      { sentence: 3, coverage: "none", correspondence: "unobserved", meetsThreshold: false },
    ]);
    // 既存の `judgments` は、欠落・種類違いも 0 として必ず行を作る（値・型・意味は今までどおり）
    expect(result.judgments.map((entry) => [entry.questionId, entry.value, entry.meetsThreshold])).toEqual([
      ["cover:S-1", 0, false],
      ["cover:S-2", 0, false],
      ["cover:S-3", 0, false],
    ]);
  });
});
