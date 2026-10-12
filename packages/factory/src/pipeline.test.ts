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
  roleOwnershipIndex,
  toStageResults,
  type DesignResult,
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

// ── 了承して除いた部分の代わりの案に、元の要件と部分の文脈を添える（§5・Issue #407）──

const ORIGINAL_TEXT = "記録できる";
const ALTERNATIVE_TEXT = "代わりの案の記録";
const ORIGINAL_PART_ID = "R-1-p1";
const ORIGINAL_PART_TEXT = "記録の並べ替え";

/** 代わりの案の文脈の試験で使う、確定した仕様の土台 */
const ALTERNATIVE_BASE: ConfirmedPlan = {
  schema_version: PLAN_SPEC_SCHEMA_VERSION,
  plan_id: "plan-alt",
  revision: 1,
  vocabulary_version: "v1",
  inputs: [{ id: "in-1", kind: "source", text: SOURCE }],
  requirements: [],
  open_issues: [],
  decisions: [],
  accepted_unwritable: [],
  confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
};

/** 元の要件（部分 `R-1-p1` を「了承して除く」） */
const originalRequirement: ConfirmedPlan["requirements"][number] = {
  id: "R-1",
  text: ORIGINAL_TEXT,
  kind: "existence",
  origin: { input_id: "in-1", quote: "タスクを記録する" },
  parts: [{ id: ORIGINAL_PART_ID, text: ORIGINAL_PART_TEXT, disposition: "accepted_removal" }],
};

/** 代わりの案の要件（ID は接頭辞 `R:alt:` があってもなくてもよい） */
function alternativeRequirement(id: string): ConfirmedPlan["requirements"][number] {
  return {
    id,
    text: ALTERNATIVE_TEXT,
    kind: "existence",
    origin: { input_id: "in-1", quote: "代わりの案の記録をする" },
    parts: [{ id: `${id}-p1`, text: "代わりの案", disposition: "met" }],
  };
}

/** 代わりの案の要件と、`accepted_unwritable` の参照を持つ確定した仕様を組む */
function alternativePlan(options: {
  readonly alternativeId: string;
  /** 参照を持つか（既定 true）。false なら `accepted_unwritable` は空 */
  readonly reference?: boolean;
  /** 参照する部分 ID（既定 `R-1-p1`） */
  readonly partId?: string;
}): ConfirmedPlan {
  return {
    ...ALTERNATIVE_BASE,
    requirements: [originalRequirement, alternativeRequirement(options.alternativeId)],
    accepted_unwritable:
      options.reference === false
        ? []
        : [
            {
              part_id: options.partId ?? ORIGINAL_PART_ID,
              alternative_id: options.alternativeId,
              basis: { doc_version: "v1", location: "contract", constraint_id: "R-1" },
            },
          ],
  };
}

/** ある要件の文を返す（無ければ空文字） */
function textOf(plan: ConfirmedPlan, id: string): string {
  return requirementsFromPlan(plan).requirements.find((requirement) => requirement.id === id)?.text ?? "";
}

describe("了承して除いた部分の代わりの案に、元の要件と部分の文脈を添える（§5・Issue #407）", () => {
  it("参照から代わりの案の要件に文脈が付き、元の要件 ID・部分 ID・部分の文を含む", () => {
    const text = textOf(alternativePlan({ alternativeId: "R-2" }), "R-2");
    expect(text).toContain(CONFIRMED_REQUIREMENT_LABEL);
    expect(text).toContain(ALTERNATIVE_TEXT);
    expect(text).toContain(REFERENCE_CONTEXT_LABEL);
    expect(text).toContain("R-1"); // 元の要件 ID
    expect(text).toContain(ORIGINAL_PART_ID); // 部分 ID
    expect(text).toContain(ORIGINAL_PART_TEXT); // 部分の文
    // 参照されていない元の要件は、素の文のまま
    expect(textOf(alternativePlan({ alternativeId: "R-2" }), "R-1")).toBe(ORIGINAL_TEXT);
  });

  it("参照が欠ければ、元の文のまま", () => {
    expect(textOf(alternativePlan({ alternativeId: "R-2", reference: false }), "R-2")).toBe(ALTERNATIVE_TEXT);
  });

  it("部分 ID が `parts` に無ければ、元の文のまま", () => {
    expect(textOf(alternativePlan({ alternativeId: "R-2", partId: "R-1-pX" }), "R-2")).toBe(ALTERNATIVE_TEXT);
  });

  it("R:alt: の接頭辞があっても参照が無ければ素の文、接頭辞が無くても参照があれば文脈が付く", () => {
    // 接頭辞あり・参照なし → 素の文
    expect(textOf(alternativePlan({ alternativeId: "R:alt:R-9", reference: false }), "R:alt:R-9")).toBe(
      ALTERNATIVE_TEXT,
    );
    // 接頭辞なし・参照あり → 文脈が付く
    expect(textOf(alternativePlan({ alternativeId: "R-2" }), "R-2")).toContain(REFERENCE_CONTEXT_LABEL);
    // 接頭辞あり・参照あり → 文脈が付く
    expect(textOf(alternativePlan({ alternativeId: "R:alt:R-9" }), "R:alt:R-9")).toContain(REFERENCE_CONTEXT_LABEL);
  });

  it("要件 ID・quote・parts は変えず、同じ入力から同じ文になる", () => {
    const plan = alternativePlan({ alternativeId: "R:alt:R-9" });
    const requirement = requirementsFromPlan(plan).requirements.find(
      (candidate) => candidate.id === "R:alt:R-9",
    );
    expect(requirement?.id).toBe("R:alt:R-9");
    expect(requirement?.quote).toBe("代わりの案の記録をする");
    expect(requirement?.parts).toEqual([{ id: "R:alt:R-9-p1", text: "代わりの案", disposition: "met" }]);
    expect(textOf(plan, "R:alt:R-9")).toBe(textOf(plan, "R:alt:R-9"));
  });

  it("答えから増えた要件の既存の文脈は変わらない（代わりの案の参照が無い）", () => {
    // 既存の planWith の R-2 は added で、問いの文脈だけを持つ
    const text = requirementsFromPlan(planWith({})).requirements[0]?.text ?? "";
    expect(text).toContain(CONFIRMED_REQUIREMENT_LABEL);
    expect(text).toContain(REFERENCE_CONTEXT_LABEL);
    expect(text).toContain(QUESTION_TEXT);
    expect(text).not.toContain("の代わりの案");
  });
});

// ── 所属の索引（純粋な関数。Issue #418）────────────────────────────────

const ROLE_DESIGN: DesignResult = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: true, aliasOf: null, options: null },
    { roleId: "record.extra", kind: "computation", entity: "record", name: "extra", shared: false, aliasOf: null, options: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "行を参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "行を参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
        { roleId: "record.extra", basis: "stated", reason: null },
      ],
    },
  ],
};

describe("所属の索引は純粋で、同じ入力から同じ結果になる（Issue #418）", () => {
  it("役割 ID ごとに、所属させた要件 ID の並びを返す（同じ要件の中の重なりは 1 つ）", () => {
    const index = roleOwnershipIndex(ROLE_DESIGN);
    expect(index.get("record")).toEqual(["R-1", "R-2"]);
    expect(index.get("record.total")).toEqual(["R-1", "R-2"]);
    expect(index.get("record.extra")).toEqual(["R-2"]);
    expect(index.get("record.unknown")).toBeUndefined();
  });

  it("同じ入力からは同じ結果になる（写しを変えても、元の索引は変わらない）", () => {
    expect(roleOwnershipIndex(ROLE_DESIGN)).toEqual(roleOwnershipIndex(ROLE_DESIGN));
  });

  it("所属の無い旧形式の設計では、空の索引を返す", () => {
    const legacy: DesignResult = {
      designs: [{ requirementId: "R-1", vocabulary: [], placement: [], unwritable: [] }],
    };
    expect(roleOwnershipIndex(legacy).size).toBe(0);
  });
});
