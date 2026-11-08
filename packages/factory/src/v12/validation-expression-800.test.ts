// Issue #800 の二点測定（(1)〜(9)）。題材に依らない人工の表だけを使い、直す前の挙動も各試験に残す。
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../pipeline.js";
import { UNCONVERTIBLE_VERIFICATION_KIND_MESSAGE, toV1 } from "../v11a/convert.js";
import { CHECK_TARGET_MESSAGES, checkCheckTargets, checkValidationExpressionTargets, type NameTable, type NameTableRow } from "../v11a/names.js";
import { SEMANTIC_CHECK_LEDGER_RULE_ID, semanticCheckRuleDefinitionsOf } from "../v11a/stages/semantic-check.js";
import { checkEvaluabilityByLedger, type TestObserves } from "../v11a/stages/test-spec.js";
import { withoutValidationExpression } from "../v11a/__tests__/fixtures.js";
import { frameValueTargetIdsOf, normalOnlyOwnershipRequirementIds } from "./generated-tests.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, PROPERTY_LEDGER_VIEW_IDS, fromPublicV12Flags, propertyLedgerSha256, type LedgerView } from "./ledger.js";

const rowOf = (row: Omit<NameTableRow, "role" | "source" | "options" | "groupBy" | "refEntity">): NameTableRow => ({
  role: "要件が使う対象",
  source: { requirementId: "R1", quote: "題名は決まった値だけをとる" },
  options: null,
  groupBy: null,
  refEntity: null,
  ...row,
});

const TABLE: NameTable = {
  rows: [
    rowOf({ id: "e.item", kind: "entity", entity: null, name: "item", type: null }),
    rowOf({ id: "f.item.title", kind: "field", entity: "e.item", name: "title", type: "string" }),
    rowOf({ id: "f.item.amount", kind: "field", entity: "e.item", name: "amount", type: "number" }),
    rowOf({ id: "c.rate", kind: "computation", entity: null, name: "rate", type: { valueType: "number", scope: "app", form: "expression", aggregate: null } }),
    rowOf({ id: "s.board", kind: "screen", entity: "e.item", name: "board", type: { view: "board" } }),
  ],
  ownership: [
    {
      requirementId: "R1",
      roles: [
        { id: "e.item", basis: "stated", reason: null },
        { id: "f.item.title", basis: "stated", reason: null },
        { id: "f.item.amount", basis: "stated", reason: null },
        { id: "c.rate", basis: "stated", reason: null },
      ],
    },
  ],
  verification: [{ requirementId: "R1", kind: "validation-expression", targets: ["f.item.title"] }],
  classification: [{ requirementId: "R1", nature: "ruled" }],
};

const LIST = { requirements: [{ id: "R1", text: "題名は決まった値だけをとる" }] } as unknown as RequirementList;

const row800 = PROPERTY_LEDGER.find((row) => row.id === "validation-expression");
const targetMessages = row800?.t1?.targetMessages;

const validateTest = (roleId: string) => ({
  id: `t-${roleId}`,
  target: { requirementId: "R1", kind: "field" as const, roleId },
  kind: "normal" as const,
  operation: "validate" as const,
  clock: "2026-01-01T00:00:00+09:00",
  input: { [roleId]: 1 },
  referenceData: [],
  expected: { kind: "ok" as const, value: 1 },
});

describe("Issue #800 の二点測定（(1)〜(9)）", () => {
  it("(1) 台帳：検査の式の行は旗 ids を要し、targets を持ち、off の見方からは除かれる（直す前の挙動として、off の見方に行は無い）", () => {
    expect(row800?.requires).toBe("ids");
    expect(row800?.rules.t1).toContain("targets");
    expect(PROPERTY_LEDGER_VIEW.rowByVerificationKind.has("validation-expression")).toBe(false);
    expect(PROPERTY_LEDGER_VIEW_IDS.rowByVerificationKind.has("validation-expression")).toBe(true);
  });

  it("(2) 変換：台帳にある確かめ方の種類は fixed-test へ写る。直す前の挙動として、台帳 off の見方では写さずに断る", () => {
    expect(toV1(TABLE).design.designs[0]?.verification).toEqual({ kind: "fixed-test" });
    expect(() => toV1(TABLE, PROPERTY_LEDGER_VIEW)).toThrow(UNCONVERTIBLE_VERIFICATION_KIND_MESSAGE);
  });

  it("(3) C2'：targets は同じ entity の項目だけで、空・entity・重なりは赤。正しい targets は緑（変異で赤→復元で緑）", () => {
    const problems: { field: string; message: string }[] = [];
    const good = checkValidationExpressionTargets(TABLE.rows, ["f.item.title"], "verification", targetMessages, problems);
    expect(good.valid).toBe(true);
    expect(problems).toEqual([]);
    for (const bad of [[], ["e.item"], ["f.item.title", "f.item.title"]]) {
      const out: { field: string; message: string }[] = [];
      const result = checkValidationExpressionTargets(TABLE.rows, bad, "verification", targetMessages, out);
      expect(result.valid).toBe(false);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("(4) C3 と持ち越し：ids の受理の文は台帳の t1Acceptance を含み、off は含まない（直す前の挙動として、off は文を足さない）", () => {
    const textOf = (ledger: LedgerView) =>
      (semanticCheckRuleDefinitionsOf(ledger).find((definition) => definition.id === SEMANTIC_CHECK_LEDGER_RULE_ID)?.text ?? "");
    expect(textOf(PROPERTY_LEDGER_VIEW_IDS)).toContain(row800?.rules.t1Acceptance ?? "");
    expect(textOf(PROPERTY_LEDGER_VIEW)).not.toContain(row800?.rules.t1Acceptance ?? "");
  });

  it("(5) 枠と門：値の対象は計算・条件つき操作・targets だけで、項目だけの要件は免除（直す前の挙動として、項目も値の対象だった）", () => {
    expect(frameValueTargetIdsOf(TABLE, PROPERTY_LEDGER_VIEW_IDS, "R1")).toEqual(["c.rate", "f.item.title"]);
    const fieldOnly: NameTable = {
      ...TABLE,
      rows: TABLE.rows.filter((row) => row.kind !== "screen"),
      ownership: [{ requirementId: "R1", roles: [{ id: "f.item.title", basis: "stated", reason: null }] }],
      verification: [{ requirementId: "R1", kind: "fixed-test" }],
    };
    expect(normalOnlyOwnershipRequirementIds(fieldOnly, PROPERTY_LEDGER_VIEW_IDS, LIST)).toEqual(["R1"]);
    // 計算を所属に足すと免除から外れる（同じ関数の値で決まる）
    const withComputation: NameTable = {
      ...fieldOnly,
      ownership: [{ requirementId: "R1", roles: [...fieldOnly.ownership[0]!.roles, { id: "c.rate", basis: "stated", reason: null }] }],
    };
    expect(normalOnlyOwnershipRequirementIds(withComputation, PROPERTY_LEDGER_VIEW_IDS, LIST)).toEqual([]);
  });

  it("(6) T2'：検査の式の試験は targets の項目にだけ書け、外の項目は赤（直す前の挙動として、targets の制約は無かった）", () => {
    const observes = new Map([
      ["t-f.item.title", "validation-expression" as unknown as TestObserves],
      ["t-f.item.amount", "validation-expression" as unknown as TestObserves],
    ]);
    expect(checkEvaluabilityByLedger({ tests: [validateTest("f.item.title")] }, observes, TABLE, PROPERTY_LEDGER_VIEW_IDS as LedgerView)).toEqual([]);
    expect(checkEvaluabilityByLedger({ tests: [validateTest("f.item.amount")] }, observes, TABLE, PROPERTY_LEDGER_VIEW_IDS as LedgerView)).not.toEqual([]);
  });

  it("(7) P5：view-shows の対象の画面がボードなら固定文で赤（直す前の挙動として、ボードを対象にできた）", () => {
    const problems: { field: string; message: string }[] = [];
    checkCheckTargets(TABLE.rows, [{ check: "view-shows", targetId: "s.board", sourceId: "f.item.title" }], "verification", problems);
    expect(problems.map((problem) => problem.message)).toContain(CHECK_TARGET_MESSAGES.boardView);
  });

  it("(8) 暫定の結び付け：targets の項目だけが結び付き、外の項目・entity は結び付かない（直す前の挙動として、どの項目も結び付いた）", () => {
    const problems: { field: string; message: string }[] = [];
    expect(checkValidationExpressionTargets(TABLE.rows, ["f.item.title"], "verification", targetMessages, problems).valid).toBe(true);
    expect(problems).toEqual([]);
    expect(checkValidationExpressionTargets(TABLE.rows, ["e.item"], "verification", targetMessages, []).valid).toBe(false);
    const observes = new Map([["t-f.item.amount", "validation-expression" as unknown as TestObserves]]);
    expect(checkEvaluabilityByLedger({ tests: [validateTest("f.item.amount")] }, observes, TABLE, PROPERTY_LEDGER_VIEW_IDS as LedgerView)).not.toEqual([]);
  });

  it("(9) 指紋：ids off の指紋は変わらず、ids on だけが変わる。復元は台帳の文を外して旧の形に戻す", async () => {
    const off = await propertyLedgerSha256();
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, fromPublicV12Flags({ ids: false }))).toBe(off);
    expect(await propertyLedgerSha256(PROPERTY_LEDGER, fromPublicV12Flags({ ids: true }))).not.toBe(off);
    expect(row800?.rules.t1).toBeTruthy();
    expect(withoutValidationExpression({ rules: [`前${row800?.rules.t1 ?? ""}後`] })).toEqual({ rules: ["前後"] });
  });
});
