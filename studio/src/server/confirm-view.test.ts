import type { ConfirmedPlan } from "@musunest/appspec-schema";
import type { PlanConfirmationView } from "@musunest/factory";
import { describe, expect, it } from "vitest";
import { toRunnerConfirmation } from "./confirm-view.js";

const plan: Omit<ConfirmedPlan, "confirmation"> = {
  schema_version: "musunest.plan-spec/v1",
  plan_id: "PLAN-901",
  revision: 1,
  vocabulary_version: "v1",
  inputs: [
    { id: "entity-source-1", kind: "source", text: "毎日の記録を一覧で見たい。" },
    {
      id: "Q-1",
      kind: "question",
      open_issue_id: "OI-77",
      text: "記録は何で並べますか。",
      choices: [
        { id: "C-1", text: "新しい順" },
        { id: "C-2", text: "古い順" },
      ],
      recommended: { choice_id: "C-1", reason: "ふつうは新しい順に読むため" },
    },
    { id: "A-1", kind: "answer", question_id: "Q-1", choice_id: "C-1" },
  ],
  requirements: [
    {
      id: "REQ-111",
      text: "記録の一覧を出す。",
      kind: "existence",
      origin: { input_id: "entity-source-1", quote: "毎日の記録を一覧で見たい。" },
      parts: [{ id: "PART-222", text: "一覧を出す。", disposition: "met" }],
    },
    {
      id: "REQ-333",
      text: "一覧は新しい順に並べる。",
      kind: "constraining",
      origin: { input_id: "A-1", quote: "新しい順" },
      change: { kind: "added", answer_id: "A-1" },
      parts: [{ id: "PART-444", text: "写真の添付", disposition: "accepted_removal" }],
    },
    {
      id: "REQ-555",
      text: "題名に写真の名前を書く。",
      kind: "existence",
      origin: { input_id: "A-1", quote: "代わりの案" },
      parts: [],
    },
  ],
  open_issues: [
    { id: "OI-77", text: "並べる順が決まっていない。", critical: true, status: "resolved", resolution: { answer_id: "A-1" } },
  ],
  decisions: [{ id: "D:default:OI-77", subject: "見出し", value: "記録", reason: "項目名をそのまま使う" }],
  accepted_unwritable: [
    {
      part_id: "PART-444",
      alternative_id: "REQ-555",
      basis: { doc_version: "v1", location: "contract/rules.md#R-1", constraint_id: "R-1" },
    },
  ],
};

const view: PlanConfirmationView = {
  plan,
  diff: [
    { kind: "added", answer_id: "A-1" },
    { kind: "changed", from_requirement_id: "REQ-111", answer_id: "A-1" },
    { kind: "removed", from_requirement_id: "REQ-333", answer_id: "A-1" },
  ],
  unwritable: plan.accepted_unwritable,
  closedByDefault: plan.decisions,
};

describe("確認の表示の変換", () => {
  it("要件・差分・書けないこと・既定で決めたことを文にする", () => {
    const confirmation = toRunnerConfirmation(view);
    expect(confirmation.requirements).toEqual([
      "記録の一覧を出す。",
      "一覧は新しい順に並べる。",
      "題名に写真の名前を書く。",
    ]);
    expect(confirmation.diff).toEqual({
      added: ["一覧は新しい順に並べる。"],
      changed: ["記録の一覧を出す。"],
      removed: ["一覧は新しい順に並べる。"],
    });
    expect(confirmation.limitations).toEqual([
      { what: "写真の添付", alternative: "題名に写真の名前を書く。" },
    ]);
    expect(confirmation.decided).toEqual(["見出し: 記録"]);
  });

  it("要件 ID・事項 ID・宣言の用語の語を表示用の欄に出さない", () => {
    const text = JSON.stringify(toRunnerConfirmation(view));
    for (const marker of [
      "PLAN-901",
      "REQ-111",
      "REQ-333",
      "REQ-555",
      "PART-222",
      "PART-444",
      "OI-77",
      "Q-1",
      "A-1",
      "C-1",
      "D:default",
      "entity-source-1",
    ]) {
      expect(text).not.toContain(marker);
    }
  });
});
