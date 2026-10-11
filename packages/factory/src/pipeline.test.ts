// 段の型と、前半の未達の持ち越し（pipeline.ts）の unit テスト（02 §1.4・§1.2・②'）。
//
// ここで固定したいのは 2 つ。
//   1. 前半（①' 逆照合・②' 試験）から持ち越した未達を、⑦ の入力（未解決）に**そのまま**数えること
//   2. 持ち越しが残るかぎり、終わりの判定は合格（full）にならないこと（部分案へ倒す）
import { describe, expect, it } from "vitest";
import {
  PLAN_SPEC_SCHEMA_VERSION,
  type ConfirmedPlan,
  type PlanInput,
  type PlanOpenIssue,
} from "@musunest/appspec-schema";
import { decideOutcome } from "./outcome.js";
import {
  CONFIRMED_REQUIREMENT_LABEL,
  REFERENCE_CONTEXT_LABEL,
  requirementsFromPlan,
  toStageResults,
  type UnmetCarryOver,
} from "./pipeline.js";

const carriedOver = (reverseCheck: readonly string[], testSuite: readonly string[]): UnmetCarryOver => ({
  reverseCheck,
  testSuite,
});

/** すべての段が満たした状態の材料（持ち越しだけを差し替える） */
const base = {
  staticCheckPassed: true,
  correspondenceMisses: 0,
  testMismatches: 0,
  testUnresolved: 0,
  unwritableRequirements: 0,
  limitReached: false,
} as const;

describe("前半から持ち越した未達を、結果に残す（02 §1.2・②'）", () => {
  it("①' の落ちと ②' の欠けを、未解決として数える", () => {
    const stage = toStageResults({
      ...base,
      carriedOver: carriedOver(
        ["引用が見つからない"],
        ["R-2 に boundary の試験が無い", "R-3 の試験が無い"],
      ),
    });
    expect(stage.unresolved).toBe(3);
    // 未解決が残るかぎり、合格にはならない（部分案）
    expect(decideOutcome(stage)).toEqual({ result: "partial", verdict: "partial" });
  });

  it("持ち越しが無く、ほかもすべて満たせば、合格になる", () => {
    const stage = toStageResults({ ...base, carriedOver: carriedOver([], []) });
    expect(stage.unresolved).toBe(0);
    expect(decideOutcome(stage)).toEqual({ result: "pass", verdict: "full" });
  });

  it("後半の未解決（評価器で確かめられない試験）も、持ち越しと合わせて数える", () => {
    const stage = toStageResults({
      ...base,
      testUnresolved: 2,
      carriedOver: carriedOver([], ["R-1 の試験が無い"]),
    });
    expect(stage.unresolved).toBe(3);
    expect(decideOutcome(stage).verdict).toBe("partial");
  });
});

// ── 答えから増えた要件の文に問いの文脈を添える（§5・Issue #391）──────────────

const SOURCE = "タスクを記録する。件数を合計する。";
const QUESTION_ID = "q-1";
const QUESTION_TEXT = "件数の合計をどう出すかの問い";
const ANSWER_ID = "a-1";
const OPEN_ISSUE_ID = "o-1";
const OPEN_ISSUE_TEXT = "合計の出し方が未決である";

/** 問い・答え・未解決の事項を組む（答えは選択肢か自由入力のどちらか） */
function inputsWithAnswer(
  options: { readonly choiceId?: string; readonly freeText?: string; readonly questionId?: string } = {},
): readonly PlanInput[] {
  const questionId = options.questionId ?? QUESTION_ID;
  return [
    { id: "in-1", kind: "source", text: SOURCE },
    {
      id: questionId,
      kind: "question",
      open_issue_id: OPEN_ISSUE_ID,
      text: QUESTION_TEXT,
      choices: [
        { id: "c-1", text: "いつでも出す" },
        { id: "c-2", text: "締めのときだけ出す" },
      ],
      recommended: { choice_id: "c-1", reason: "素直な解釈である" },
    },
    options.freeText === undefined
      ? { id: ANSWER_ID, kind: "answer", question_id: questionId, choice_id: options.choiceId ?? "c-1" }
      : { id: ANSWER_ID, kind: "answer", question_id: questionId, free_text: options.freeText },
  ];
}

const OPEN_ISSUES: readonly PlanOpenIssue[] = [
  {
    id: OPEN_ISSUE_ID,
    text: OPEN_ISSUE_TEXT,
    critical: false,
    status: "resolved",
    resolution: { answer_id: ANSWER_ID },
  },
];

/** 答えから増えた要件（`change.kind` が `added`） */
function addedRequirement(
  id: string,
  text: string,
  answerId: string = ANSWER_ID,
): ConfirmedPlan["requirements"][number] {
  return {
    id,
    text,
    kind: "constraining",
    origin: { input_id: "in-1", quote: "件数を合計する" },
    change: { kind: "added", answer_id: answerId },
    parts: [{ id: `${id}-p1`, text: "合計", disposition: "met" }],
  };
}

/** 確定した仕様を組む（必要な欄だけ差し替える） */
function planWith(overrides: Partial<ConfirmedPlan>): ConfirmedPlan {
  return {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-test",
    revision: 1,
    vocabulary_version: "v1",
    inputs: inputsWithAnswer(),
    requirements: [addedRequirement("R-2", "合計できる")],
    open_issues: OPEN_ISSUES,
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
    ...overrides,
  };
}

describe("答えから増えた要件の文に問いの文脈を添える（§5・Issue #391）", () => {
  it("選択肢で答えた added の要件に、問いの文と未解決の事項の文を添え、確定した要件の文をそのまま残す", () => {
    const text = requirementsFromPlan(planWith({})).requirements[0]?.text ?? "";
    expect(text).toContain(CONFIRMED_REQUIREMENT_LABEL);
    expect(text).toContain("合計できる");
    expect(text).toContain(REFERENCE_CONTEXT_LABEL);
    expect(text).toContain(QUESTION_ID);
    expect(text).toContain(QUESTION_TEXT);
    expect(text).toContain(OPEN_ISSUE_ID);
    expect(text).toContain(OPEN_ISSUE_TEXT);
  });

  it("自由入力を選択肢に正規化した答え・確認の画面で文を直した要件でも、確定した要件の文を使う（生の答えに戻らない）", () => {
    const rawAnswer = "とりあえず合計を出すでよい";
    const list = requirementsFromPlan(
      planWith({
        inputs: inputsWithAnswer({ freeText: rawAnswer }),
        requirements: [addedRequirement("R-2", "合計を確認できる")],
      }),
    );
    const text = list.requirements[0]?.text ?? "";
    expect(text).toContain("合計を確認できる");
    expect(text).not.toContain(rawAnswer);
  });

  it("答え・問い・未解決の事項のどれかが引けない要件は、元の文のままにする", () => {
    const original = "合計できる";
    // 答えが引けない（change.answer_id が指す答えが inputs に無い）
    const noAnswer = requirementsFromPlan(
      planWith({ requirements: [addedRequirement("R-2", original, "a-unknown")] }),
    );
    expect(noAnswer.requirements[0]?.text).toBe(original);
    // 問いが引けない（答えの question_id が指す問いが inputs に無い）
    const noQuestion = requirementsFromPlan(
      planWith({
        inputs: [
          { id: "in-1", kind: "source", text: SOURCE },
          { id: ANSWER_ID, kind: "answer", question_id: "q-unknown", choice_id: "c-1" },
        ],
      }),
    );
    expect(noQuestion.requirements[0]?.text).toBe(original);
    // 未解決の事項が引けない（問いの open_issue_id が指す事項が open_issues に無い）
    const noIssue = requirementsFromPlan(planWith({ open_issues: [] }));
    expect(noIssue.requirements[0]?.text).toBe(original);
  });

  it("changed・removed の要件と、原文から来た要件は、元の文のままにする", () => {
    const fromSource: ConfirmedPlan["requirements"][number] = {
      id: "R-1",
      text: "記録できる",
      kind: "existence",
      origin: { input_id: "in-1", quote: "タスクを記録する" },
      parts: [{ id: "R-1-p1", text: "記録", disposition: "met" }],
    };
    const changed: ConfirmedPlan["requirements"][number] = {
      ...addedRequirement("R-3", "直した合計"),
      change: { kind: "changed", from_requirement_id: "R-1", answer_id: ANSWER_ID },
    };
    const removed: ConfirmedPlan["requirements"][number] = {
      ...addedRequirement("R-4", "外した合計"),
      change: { kind: "removed", from_requirement_id: "R-1", answer_id: ANSWER_ID },
    };
    const list = requirementsFromPlan(planWith({ requirements: [fromSource, changed, removed] }));
    expect(list.requirements[0]?.text).toBe("記録できる");
    expect(list.requirements[1]?.text).toBe("直した合計");
    expect(list.requirements[2]?.text).toBe("外した合計");
  });

  it("要件 ID・quote・parts は変えない", () => {
    const requirement = requirementsFromPlan(planWith({})).requirements[0];
    expect(requirement?.id).toBe("R-2");
    expect(requirement?.quote).toBe("件数を合計する");
    expect(requirement?.parts).toEqual([{ id: "R-2-p1", text: "合計", disposition: "met" }]);
  });

  it("同じ入力からは同じ文になり、同じ名前の対象が複数あっても、参考の ID で区別できる", () => {
    expect(requirementsFromPlan(planWith({})).requirements[0]?.text).toBe(
      requirementsFromPlan(planWith({})).requirements[0]?.text,
    );
    // 同じ文の対象を、別々の問いの答えから増やした 2 つの要件
    const questionIds = ["q-1", "q-2"];
    const inputs: readonly PlanInput[] = [
      { id: "in-1", kind: "source", text: SOURCE },
      ...questionIds.flatMap((questionId, index): PlanInput[] => [
        {
          id: questionId,
          kind: "question",
          open_issue_id: `o-${index + 1}`,
          text: `${QUESTION_TEXT}${index + 1}`,
          choices: [
            { id: `c-${index + 1}-1`, text: "いつでも出す" },
            { id: `c-${index + 1}-2`, text: "締めのときだけ出す" },
          ],
          recommended: { choice_id: `c-${index + 1}-1`, reason: "素直な解釈である" },
        },
        { id: `a-${index + 1}`, kind: "answer", question_id: questionId, choice_id: `c-${index + 1}-1` },
      ]),
    ];
    const openIssues: readonly PlanOpenIssue[] = questionIds.map((_, index) => ({
      id: `o-${index + 1}`,
      text: `${OPEN_ISSUE_TEXT}${index + 1}`,
      critical: false,
      status: "resolved",
      resolution: { answer_id: `a-${index + 1}` },
    }));
    const list = requirementsFromPlan(
      planWith({
        inputs,
        open_issues: openIssues,
        requirements: [addedRequirement("R-2", "合計できる", "a-1"), addedRequirement("R-3", "合計できる", "a-2")],
      }),
    );
    const first = list.requirements[0]?.text ?? "";
    const second = list.requirements[1]?.text ?? "";
    expect(first).not.toBe(second);
    expect(first).toContain("q-1");
    expect(second).toContain("q-2");
  });
});
