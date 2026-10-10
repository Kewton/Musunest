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
import type { JudgeAnswer } from "../judge.js";
import { confirmQuestionName, runConfirm, type ConfirmInput } from "./confirm.js";

const noul = (value: number): JudgeAnswer => ({ kind: "noul", noul: value });

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
    expect(result.problems.some((problem) => problem.message.includes("件数を合計する。"))).toBe(true);
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
