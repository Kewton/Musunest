// Plan の往復を純粋な関数にする（plan/session.ts）の unit テスト（04-plan-agent.md §2・§6）。
//
// **LLM も端末もファイルも触らない。** ここで固定したいのは 4 つ。
//   1. 曖昧さの無い依頼（開いている事項が無い）は 0 問で確認に進む
//   2. 11 問目と 4 回目の往復を出さない（上限は往復をまたいで数える）
//   3. 上限のあとも重大な事項が残れば「確定できない」を返す
//   4. 「全部推奨で進める」で確定できる
import { describe, expect, it } from "vitest";
import type { PlanOpenIssue } from "@musunest/appspec-schema";
import { AGENT_LIMITS } from "../limits.js";
import type { PlanAnswerDraft } from "./answers.js";
import type { PlanQuestion } from "./questions.js";
import {
  askedQuestionCount,
  nextPlanStep,
  remainingPlanBudget,
  roundTripCount,
  type PlanConfirmationView,
  type PlanTurn,
} from "./session.js";

function question(id: string, openIssueId: string): PlanQuestion {
  return {
    id,
    openIssueId,
    revision: 1,
    text: `${openIssueId} をどうしますか`,
    choices: [
      { id: "c1", text: "こちら" },
      { id: "c2", text: "あちら" },
    ],
    recommended: { choiceId: "c1", reason: "依頼に沿う" },
    allowFreeText: true,
  };
}

function answer(id: string, questionId: string): PlanAnswerDraft {
  return { id: `A-${id}`, questionId, revision: 1, choiceId: "c1" };
}

/** 質問 `count` 問ぶんの 1 往復を作る */
function turn(prefix: string, count: number): PlanTurn {
  const questions = Array.from({ length: count }, (_value, index) => question(`${prefix}-${index}`, `OI-${prefix}-${index}`));
  return { questions, answers: questions.map((one, index) => answer(`${prefix}-${index}`, one.id)) };
}

function openIssue(id: string, critical: boolean): PlanOpenIssue {
  return { id, text: `${id} の問い`, critical, status: "open" };
}

const VIEW: PlanConfirmationView = {
  plan: {
    schema_version: "musunest.plan-spec/v1",
    plan_id: "plan-1",
    revision: 1,
    vocabulary_version: "vocab-1",
    inputs: [],
    requirements: [],
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
  },
  diff: [],
  unwritable: [],
};

describe("Plan の往復の上限の数え方（04 §6 の 2）", () => {
  it("問数と往復の数は、往復をまたいで数える", () => {
    const turns = [turn("a", 3), turn("b", 2)];
    expect(askedQuestionCount(turns)).toBe(5);
    expect(roundTripCount(turns)).toBe(2);
    expect(remainingPlanBudget(turns)).toEqual({
      questions: AGENT_LIMITS.planQuestions - 5,
      roundTrips: AGENT_LIMITS.planRoundTrips - 2,
    });
  });
});

describe("次の一歩（04 §2・§6）", () => {
  it("曖昧さの無い依頼は、0 問で確認に進む", () => {
    const step = nextPlanStep({ source: "記録する。", turns: [], openIssues: [], questions: [], view: VIEW });
    expect(step.kind).toBe("confirm");
  });

  it("11 問目は出さない（合わせて 10 問まで）", () => {
    const questions = Array.from({ length: 11 }, (_value, index) => question(`x-${index}`, `OI-x-${index}`));
    const step = nextPlanStep({
      source: "記録する。",
      turns: [],
      openIssues: [openIssue("OI-x-0", true)],
      questions,
      view: VIEW,
    });
    expect(step.kind).toBe("ask");
    if (step.kind !== "ask") return;
    expect(step.questions).toHaveLength(AGENT_LIMITS.planQuestions);
    expect(step.remaining.questions).toBe(0);
  });

  it("残りの問数の範囲だけを出す（すでに 8 問聞いていれば、あと 2 問）", () => {
    const turns = [turn("a", 5), turn("b", 3)];
    const questions = [question("x-0", "OI-x-0"), question("x-1", "OI-x-1"), question("x-2", "OI-x-2")];
    const step = nextPlanStep({
      source: "記録する。",
      turns,
      openIssues: [openIssue("OI-x-0", true)],
      questions,
      view: VIEW,
    });
    expect(step.kind).toBe("ask");
    if (step.kind !== "ask") return;
    expect(step.questions).toHaveLength(2);
  });

  it("4 回目の往復は出さない（往復は 3 回まで）", () => {
    const turns = [turn("a", 1), turn("b", 1), turn("c", 1)];
    const step = nextPlanStep({
      source: "記録する。",
      turns,
      openIssues: [openIssue("OI-x-0", true)],
      questions: [question("x-0", "OI-x-0")],
      view: VIEW,
    });
    // 上限に触れたので、次の質問は出さず、重大な事項が残るので確定できない
    expect(step.kind).toBe("cannot-confirm");
  });

  it("上限のあとも重大な事項が残れば「確定できない」を返す", () => {
    const turns = [turn("a", 1), turn("b", 1), turn("c", 1)];
    const step = nextPlanStep({
      source: "記録する。",
      turns,
      openIssues: [openIssue("OI-1", true), openIssue("OI-2", false)],
      questions: [question("x-0", "OI-1"), question("x-1", "OI-2")],
      view: VIEW,
    });
    expect(step.kind).toBe("cannot-confirm");
    if (step.kind !== "cannot-confirm") return;
    // 残った重大な事項だけを返す
    expect(step.openIssues.map((issue) => issue.id)).toEqual(["OI-1"]);
  });

  it("上限のあとに残った重大でない事項は、既定で閉じて確認に進む", () => {
    const turns = [turn("a", AGENT_LIMITS.planQuestions)];
    const step = nextPlanStep({
      source: "記録する。",
      turns,
      openIssues: [openIssue("OI-1", false)],
      questions: [question("x-0", "OI-1")],
      view: VIEW,
    });
    expect(step.kind).toBe("confirm");
  });

  it("「全部推奨で進める」で確定できる", () => {
    const step = nextPlanStep({
      source: "記録する。",
      turns: [],
      openIssues: [openIssue("OI-1", true)],
      questions: [question("x-0", "OI-1")],
      view: VIEW,
      allRecommended: true,
    });
    expect(step.kind).toBe("confirm");
  });
});
