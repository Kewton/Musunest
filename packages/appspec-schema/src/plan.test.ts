// 確定した仕様（v1）の型・検査・SHA-256 の unit テスト（Issue #331）。
//
// 設計の正本は workspace/mvp/m1/agent/04-plan-agent.md §4。見るのは 4 つである。
//   1. 正しい仕様を受け取ること
//   2. 実在しない ID の参照・部分 ID の外の了承・根拠の無い解決・開いた重大な事項を、**それぞれ別の
//      誤り**として断ること（`code` が別であることを実測する）
//   3. キーの順だけが違う 2 つの仕様の SHA が同じであること（正規化）
//   4. 中身が 1 か所違えば SHA が違い、確認が失効すること
import { describe, expect, it } from "vitest";
import {
  PLAN_SPEC_SCHEMA_VERSION,
  checkConfirmedPlan,
  checkPlan,
  isConfirmationValid,
  planDigest,
  type PlanProblemCode,
} from "./index.js";

// ── 見本の仕様 ──────────────────────────────────────────────────
//
// 受入の題材の言葉は使わない（管理からの前提 4）。ここは中身の無い、検査を通るためだけの仕様である。

interface PlanSourceFixture {
  id: string;
  kind: string;
  text?: string;
  open_issue_id?: string;
  choices?: { id: string; text: string }[];
  recommended?: { choice_id: string; reason: string };
  question_id?: string;
  choice_id?: string;
  free_text?: string;
}
interface PlanPartFixture {
  id: string;
  text: string;
  disposition: string;
  alternative_id?: string;
}
interface PlanRequirementFixture {
  id: string;
  text: string;
  kind: string;
  origin: { input_id: string; quote: string };
  change?: { kind: string; from_requirement_id?: string; answer_id: string };
  parts: PlanPartFixture[];
}
interface PlanOpenIssueFixture {
  id: string;
  text: string;
  critical: boolean;
  status: string;
  resolution?: { answer_id?: string; decision_id?: string; reason?: string };
}
interface PlanFixture {
  schema_version: string;
  plan_id: string;
  revision: number;
  vocabulary_version: string;
  inputs: PlanSourceFixture[];
  requirements: PlanRequirementFixture[];
  open_issues: PlanOpenIssueFixture[];
  decisions: { id: string; subject: string; value: string; reason: string }[];
  accepted_unwritable: {
    part_id: string;
    alternative_id: string;
    basis: { doc_version: string; location: string; constraint_id: string };
  }[];
  confirmation: { sha256: string; confirmed_at: string; confirmed_by: string };
}

const validPlan = (): PlanFixture => ({
  schema_version: PLAN_SPEC_SCHEMA_VERSION,
  plan_id: "plan-1",
  revision: 2,
  vocabulary_version: "community.app-spec/v0.2",
  inputs: [
    { id: "p-text-1", kind: "source", text: "毎日の記録を一覧で見たい。" },
    {
      id: "p-question-1",
      kind: "question",
      open_issue_id: "p-issue-1",
      text: "記録は何で並べますか。",
      choices: [
        { id: "p-choice-new", text: "新しい順" },
        { id: "p-choice-old", text: "古い順" },
      ],
      recommended: { choice_id: "p-choice-new", reason: "ふつうは新しい順に読むため" },
    },
    { id: "p-answer-1", kind: "answer", question_id: "p-question-1", choice_id: "p-choice-new" },
  ],
  requirements: [
    {
      id: "p-req-1",
      text: "記録の一覧を出す。",
      kind: "existence",
      origin: { input_id: "p-text-1", quote: "毎日の記録を一覧で見たい。" },
      parts: [{ id: "p-part-1", text: "一覧を出す。", disposition: "met" }],
    },
    {
      id: "p-req-2",
      text: "一覧は新しい順に並べる。",
      kind: "constraining",
      origin: { input_id: "p-answer-1", quote: "新しい順" },
      change: { kind: "added", answer_id: "p-answer-1" },
      parts: [
        { id: "p-part-2", text: "新しい順に並べる。", disposition: "met" },
        { id: "p-part-3", text: "並べ替えの指定を保存する。", disposition: "accepted_removal" },
      ],
    },
  ],
  open_issues: [
    {
      id: "p-issue-1",
      text: "並べる順が決まっていない。",
      critical: true,
      status: "resolved",
      resolution: { answer_id: "p-answer-1" },
    },
  ],
  decisions: [
    { id: "p-decision-1", subject: "一覧の見出し", value: "記録", reason: "項目名をそのまま使う" },
  ],
  accepted_unwritable: [
    {
      part_id: "p-part-3",
      alternative_id: "p-req-1",
      basis: {
        doc_version: "community.app-spec/v0.2",
        location: "contract/rules.md#R-VOCAB-04",
        constraint_id: "R-VOCAB-04",
      },
    },
  ],
  confirmation: {
    sha256: "",
    confirmed_at: "2026-10-10T09:00:00+09:00",
    confirmed_by: "tester",
  },
});

/** 確認の欄に、いまの仕様の SHA を入れる（`planDigest` は `confirmation` を混ぜないので値は安定する） */
async function sign(plan: PlanFixture): Promise<PlanFixture> {
  return { ...plan, confirmation: { ...plan.confirmation, sha256: await planDigest(plan) } };
}

/** strict の noUncheckedIndexedAccess の下で、並びの要素を取る */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`${index} 番目が無い`);
  return item;
}

/** 中身はそのままで、写像のキーを逆順に並べ直した写しを作る（正規化の実測に使う） */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).reverse()) out[key] = reverseKeys(record[key]);
    return out;
  }
  return value;
}

const codesOf = (problems: readonly { code: PlanProblemCode }[]): PlanProblemCode[] =>
  problems.map((problem) => problem.code);

const codeSet = (problems: readonly { code: PlanProblemCode }[]): Set<PlanProblemCode> =>
  new Set(codesOf(problems));

describe("確定した仕様（v1）の検査（checkPlan）", () => {
  it("正しい仕様を受け取り、問題を返さない", async () => {
    const plan = await sign(validPlan());
    expect(checkPlan(plan)).toEqual([]);
    expect(await checkConfirmedPlan(plan)).toEqual([]);
    expect(await isConfirmationValid(plan)).toBe(true);
  });

  it("形が違えば shape で断る（版・欄の型）", () => {
    const plan = validPlan();
    plan.schema_version = "musunest.plan-spec/v0";
    plan.revision = 0;
    const codes = codesOf(checkPlan(plan));
    expect(codes).toContain("shape");
    expect(codes.every((code) => code === "shape")).toBe(true);
  });
});

describe("別の誤りとして断る（Issue #331 の受入）", () => {
  it("実在しない ID の参照は unknown_reference", async () => {
    const plan = await sign(validPlan());
    at(plan.requirements, 0).origin.input_id = "p-missing";
    expect(codesOf(checkPlan(plan))).toEqual(["unknown_reference"]);

    // ほかの参照の場所も独立に見る
    const answerPlan = await sign(validPlan());
    at(answerPlan.inputs, 2).question_id = "p-missing";
    expect(codeSet(checkPlan(answerPlan))).toEqual(new Set(["unknown_reference"]));

    const alternativePlan = await sign(validPlan());
    at(alternativePlan.accepted_unwritable, 0).alternative_id = "p-missing";
    expect(codeSet(checkPlan(alternativePlan))).toEqual(new Set(["unknown_reference"]));
  });

  it("部分 ID の外の了承は accepted_outside_parts", async () => {
    const plan = await sign(validPlan());
    at(plan.accepted_unwritable, 0).part_id = "p-missing";
    expect(codeSet(checkPlan(plan))).toEqual(new Set(["accepted_outside_parts"]));
  });

  it("parts にあるが「了承して除く」でない部分の了承は accepted_not_removal", async () => {
    const plan = await sign(validPlan());
    // p-part-1 は disposition: met である（了承して除くになっていない）
    at(plan.accepted_unwritable, 0).part_id = "p-part-1";
    expect(codeSet(checkPlan(plan))).toEqual(new Set(["accepted_not_removal"]));
  });

  it("根拠の無い解決は resolution_without_basis", async () => {
    const plan = await sign(validPlan());
    at(plan.open_issues, 0).resolution = {};
    expect(codeSet(checkPlan(plan))).toEqual(new Set(["resolution_without_basis"]));
  });

  it("開いた重大な事項は open_critical（確定できない）", async () => {
    const plan = await sign(validPlan());
    at(plan.open_issues, 0).status = "open";
    expect(codeSet(checkPlan(plan))).toEqual(new Set(["open_critical"]));
  });

  it("重大でない未解決の事項も open_issue で断る（未解決が残れば確定できない）", async () => {
    const plan = await sign(validPlan());
    at(plan.open_issues, 0).critical = false;
    at(plan.open_issues, 0).status = "open";
    expect(codeSet(checkPlan(plan))).toEqual(new Set(["open_issue"]));
  });

  it("4 つの誤りは、それぞれ別の値（code）で返る", async () => {
    const unknown = await sign(validPlan());
    at(unknown.requirements, 0).origin.input_id = "p-missing";

    const outside = await sign(validPlan());
    at(outside.accepted_unwritable, 0).part_id = "p-missing";

    const noBasis = await sign(validPlan());
    at(noBasis.open_issues, 0).resolution = {};

    const critical = await sign(validPlan());
    at(critical.open_issues, 0).status = "open";

    const codes = [
      ...codeSet(checkPlan(unknown)),
      ...codeSet(checkPlan(outside)),
      ...codeSet(checkPlan(noBasis)),
      ...codeSet(checkPlan(critical)),
    ];
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(codes)).toEqual(
      new Set(["unknown_reference", "accepted_outside_parts", "resolution_without_basis", "open_critical"]),
    );
  });
});

describe("仕様の SHA-256（正規化）", () => {
  it("キーの順だけが違う 2 つの仕様の SHA は同じ", async () => {
    const plan = validPlan();
    const reordered = reverseKeys(plan);
    expect(await planDigest(plan)).toBe(await planDigest(reordered));
    expect(await planDigest(plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("中身が 1 か所違えば SHA が違い、確認が失効する", async () => {
    const signed = await sign(validPlan());
    const before = await planDigest(signed);
    expect(await isConfirmationValid(signed)).toBe(true);

    const changed = JSON.parse(JSON.stringify(signed)) as PlanFixture;
    changed.revision = signed.revision + 1;
    const after = await planDigest(changed);

    expect(after).not.toBe(before);
    expect(await isConfirmationValid(changed)).toBe(false);
    expect(codeSet(await checkConfirmedPlan(changed))).toEqual(new Set(["confirmation_expired"]));
  });

  it("確認の欄（sha256・時刻・人）は SHA に混ざらない", async () => {
    const signed = await sign(validPlan());
    const other = JSON.parse(JSON.stringify(signed)) as PlanFixture;
    other.confirmation = { sha256: "0".repeat(64), confirmed_at: "2000-01-01T00:00:00+09:00", confirmed_by: "x" };
    expect(await planDigest(other)).toBe(await planDigest(signed));
  });
});
