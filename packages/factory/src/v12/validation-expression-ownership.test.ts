// Issue #824 の二点測定（(1)〜(8)）。題材に依らない人工の表だけを使い、直す前の挙動も残す。
//
// 直す前（Issue #800 のまま）は、検査の式（validation-expression）の要件の所属の形が targets の項目とその entity だけ
// だった。検査は保存の前にレコード全体に当たるので、targets の entity の条件（when）の無い create・update の操作
// （検査が守る操作）を所属に入れるのは要件の意味として自然で、しかもその行は値の対象にならない。Issue #824 は、その行
// だけを所属の形で許す（targets の照合の関数が返す「所属に足してよい ID」は変えない）。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import type { RequirementList } from "../pipeline.js";
import {
  baseCheckValidationExpressionTargets,
  createCheckedRecordingClient,
  FIXTURE_DOCUMENTS,
  FIXTURE_YAML,
  fixtureList,
  fixtureTable,
  jsonDiffPaths,
  normalizedFixture,
  planOf,
  recordedStructured,
} from "../v11a/__tests__/fixtures.js";
import {
  checkMappedTable,
  checkNameTable,
  checkValidationExpressionTargets,
  checkValidationExpressionVerification,
  nameTableSha256,
  ownershipWithValidationTargets,
  validationExpressionTargetsValid,
  type NameTable,
  type NameTableRoleOwnership,
  type NameTableRow,
} from "../v11a/names.js";
import { runDeclCheck } from "../v11a/stages/decl-check.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../stages/__tests__/prompt.js";
import { frameValueTargetIdsOf, generateTests, normalOnlyOwnershipRequirementIds } from "./generated-tests.js";
import { PROPERTY_LEDGER_VIEW_IDS } from "./ledger.js";
import { initialTestCaseFramesOf } from "./test-cases.js";

const VALIDATION_ROW = PROPERTY_LEDGER_VIEW_IDS.rowByVerificationKind.get("validation-expression")?.t1;
if (VALIDATION_ROW === undefined || VALIDATION_ROW === null) throw new Error("前提が壊れた：台帳に検査の式の行が無い");
const T1 = VALIDATION_ROW;
const TARGET_MESSAGES = T1.targetMessages;
const OTHERS = T1.messages.others;

const R1_TEXT = "値が決まりを満たさなければ登録できない。";

const LIST: RequirementList = {
  requirements: [{ id: "R1", text: R1_TEXT, quote: R1_TEXT, position: { start: 0, end: R1_TEXT.length } }],
  decisions: [],
  unresolved: [],
};

const row = (id: string, kind: NameTableRow["kind"], entity: string | null, name: string, type: NameTableRow["type"]): NameTableRow => ({
  id,
  kind,
  entity,
  name,
  role: `${id} の役割`,
  source: { requirementId: "R1", quote: R1_TEXT },
  type,
  options: null,
  groupBy: null,
  refEntity: null,
});

const E1 = row("E1", "entity", null, "item", null);
const F1 = row("E1.F1", "field", "E1", "alpha", "string");
const E2 = row("E2", "entity", null, "other", null);
const F2 = row("E2.F1", "field", "E2", "beta", "string");
const C1 = row("C1", "computation", null, "rate", { valueType: "number", scope: "app", form: "expression", aggregate: null });
const V1 = row("V1", "screen", "E1", "viewOne", { view: "table" });
const OP1 = row("OP1", "operation", "E1", "createOne", { action: "create", hasWhen: false });
const OP2 = row("OP2", "operation", "E1", "updateOne", { action: "update", hasWhen: false });
const OP3 = row("OP3", "operation", "E1", "createWhen", { action: "create", hasWhen: true });
const OP4 = row("OP4", "operation", "E1", "updateWhen", { action: "update", hasWhen: true });
const OP5 = row("OP5", "operation", "E1", "deleteOne", { action: "delete", hasWhen: false });
const OP7 = row("OP7", "operation", "E2", "otherCreate", { action: "create", hasWhen: false });

const owned = (id: string, basis: NameTableRoleOwnership["basis"] = "stated"): NameTableRoleOwnership => ({
  id,
  basis,
  reason: basis === "dependency" ? "要件の決まりを守る操作" : null,
});

const tableOf = (rows: readonly NameTableRow[], roles: readonly NameTableRoleOwnership[], targets: readonly string[] = ["E1.F1"]): NameTable => ({
  rows,
  ownership: [{ requirementId: "R1", roles }],
  verification: [{ requirementId: "R1", kind: "validation-expression", targets }],
  classification: [{ requirementId: "R1", nature: "ruled" }],
});

const c2Of = (table: NameTable) => checkMappedTable(LIST, table, FIXTURE_DOCUMENTS, { ledger: PROPERTY_LEDGER_VIEW_IDS });
const messagesOf = (table: NameTable): readonly string[] => c2Of(table).map((problem) => problem.message);

/** 直す前（Issue #800 のまま）の所属の形：`targets` の照合が返す集合だけを許す（二点測定の「前」を残すためだけ） */
function baseOwnershipOthers(rows: readonly NameTableRow[], targets: readonly string[], roles: readonly NameTableRoleOwnership[]): readonly string[] {
  const { valid, allowed } = checkValidationExpressionTargets(rows, targets, "verification", TARGET_MESSAGES, []);
  if (!valid) return [];
  return roles.some((role) => !allowed.has(role.id)) ? [OTHERS] : [];
}

/**
 * 変異の模型（製品の述語の写しではない）。どの条件を外すとどの負例が通ってしまうか（＝負例の試験が赤になるか）を、
 * 同じ行の集合で示すためだけのもの
 */
function guardedOperationIdsWith(
  rows: readonly NameTableRow[],
  entity: string | null,
  guards: { readonly checkWhen: boolean; readonly checkEntity: boolean },
): readonly string[] {
  return rows
    .filter((candidate) => {
      if (candidate.kind !== "operation") return false;
      if (guards.checkEntity && (entity === null || candidate.entity !== entity)) return false;
      const type = candidate.type;
      if (type === null || typeof type !== "object" || !("action" in type) || !("hasWhen" in type)) return false;
      if (type.action !== "create" && type.action !== "update") return false;
      return !guards.checkWhen || type.hasWhen === false;
    })
    .map((candidate) => candidate.id);
}

describe("Issue #824 の二点測定（(1)〜(8)）", () => {
  it("(1) 回帰の型：同じ entity の条件の無い create・update の操作を所属させた検査の式の要件は C2'（と T1'）を通る。直す前は固定文 others で落ちる", () => {
    const create = tableOf([E1, F1, OP1], [owned("E1.F1"), owned("OP1", "dependency")]);
    expect(c2Of(create)).toEqual([]);
    // T1' も同じ関数を通る
    expect(checkNameTable(LIST, create, FIXTURE_DOCUMENTS, { ledger: PROPERTY_LEDGER_VIEW_IDS })).toEqual([]);
    // 直す前の同じ表は固定文 others で落ちる（所属は導いた entity を含めて見る）
    expect(baseOwnershipOthers([E1, F1, OP1], ["E1.F1"], [owned("E1.F1"), owned("OP1", "dependency"), owned("E1", "dependency")])).toEqual([OTHERS]);

    const update = tableOf([E1, F1, OP2], [owned("E1.F1"), owned("OP2", "dependency")]);
    expect(c2Of(update)).toEqual([]);

    const stated = tableOf([E1, F1, OP1], [owned("E1.F1"), owned("OP1", "stated")]);
    expect(c2Of(stated)).toEqual([]);
  });

  it("(2) 負例：別の entity の行（項目・操作・entity）・計算・画面・条件のある操作・delete を所属させると、今のまま固定文 others で落ちる", () => {
    const cases: readonly (readonly [string, readonly NameTableRow[], readonly NameTableRoleOwnership[]])[] = [
      ["別の entity の項目", [E1, F1, E2, F2], [owned("E1.F1"), owned("E2.F1")]],
      ["別の entity の操作", [E1, F1, E2, OP7], [owned("E1.F1"), owned("OP7", "dependency")]],
      ["別の entity の entity", [E1, F1, E2], [owned("E1.F1"), owned("E2")]],
      ["計算", [E1, F1, C1], [owned("E1.F1"), owned("C1")]],
      ["画面", [E1, F1, V1], [owned("E1.F1"), owned("V1")]],
      ["条件のある create", [E1, F1, OP3], [owned("E1.F1"), owned("OP3")]],
      ["条件のある update", [E1, F1, OP4], [owned("E1.F1"), owned("OP4")]],
      ["delete", [E1, F1, OP5], [owned("E1.F1"), owned("OP5")]],
    ];
    for (const [label, rows, roles] of cases) {
      expect(messagesOf(tableOf(rows, roles)), label).toContain(OTHERS);
    }
    // 別の entity の操作は、導いた entity を除いた所属で直接照らしても落ちる（操作の行そのものが許されていないことを見る。
    // C2' は導いた entity でも落ちるので、entity の照合を外す変異はこの断言で赤になる）
    const problems: { field: string; message: string }[] = [];
    checkValidationExpressionVerification(
      T1,
      null,
      ["E1.F1"],
      "verification",
      [owned("E1.F1"), owned("OP7", "dependency")],
      undefined,
      [F1, OP7],
      problems,
    );
    expect(problems.map((problem) => problem.message)).toContain(OTHERS);
  });

  it("(3) targets が正しくない表は、今の targets の固定文で落ち、所属の形は見ない（base と同じ）", () => {
    const bad = tableOf([E1, F1, OP1], [owned("E1.F1"), owned("OP1", "dependency")], ["E1.F1", "E1.UNKNOWN"]);
    const messages = messagesOf(bad);
    expect(messages).toContain(TARGET_MESSAGES?.unknown);
    expect(messages).not.toContain(OTHERS);
    expect(baseOwnershipOthers([E1, F1, OP1], ["E1.F1", "E1.UNKNOWN"], [owned("E1.F1"), owned("OP1", "dependency")])).toEqual([]);
  });

  it("(4) C2' の前の手：所属を足す手と targets の照合が返す「所属に足してよい ID」は base と同じ（操作の行を足さない）", () => {
    const current = checkValidationExpressionTargets([E1, F1, OP1], ["E1.F1"], "verification", TARGET_MESSAGES, []);
    const base = baseCheckValidationExpressionTargets([E1, F1, OP1], ["E1.F1"], "verification", TARGET_MESSAGES, []);
    expect([...current.allowed].sort()).toEqual([...base.allowed].sort());
    expect(current.allowed.has("OP1")).toBe(false);
    expect(validationExpressionTargetsValid([E1, F1, OP1], ["E1.F1"])).toBe(true);
    expect(ownershipWithValidationTargets([], [E1, F1, OP1], ["E1.F1"]).map((role) => role.id)).toEqual(["E1.F1", "E1"]);
  });

  it("(5) 門の目的が保たれる：許した操作の行の有無で、値の対象・T2 の枠・コードの試験の組が変わらない", () => {
    const withOperation = tableOf([E1, F1, OP1], [owned("E1.F1"), owned("OP1", "dependency")]);
    const withoutOperation = tableOf([E1, F1, OP1], [owned("E1.F1")]);
    expect(frameValueTargetIdsOf(withOperation, PROPERTY_LEDGER_VIEW_IDS, "R1")).toEqual(
      frameValueTargetIdsOf(withoutOperation, PROPERTY_LEDGER_VIEW_IDS, "R1"),
    );
    expect(normalOnlyOwnershipRequirementIds(withOperation, PROPERTY_LEDGER_VIEW_IDS, LIST)).toEqual(
      normalOnlyOwnershipRequirementIds(withoutOperation, PROPERTY_LEDGER_VIEW_IDS, LIST),
    );
    const generatedWith = generateTests({ table: withOperation, ledger: PROPERTY_LEDGER_VIEW_IDS, list: LIST });
    const generatedWithout = generateTests({ table: withoutOperation, ledger: PROPERTY_LEDGER_VIEW_IDS, list: LIST });
    expect(generatedWith.tests).toEqual(generatedWithout.tests);
    const framesWith = initialTestCaseFramesOf(
      { table: withOperation, ledger: PROPERTY_LEDGER_VIEW_IDS, list: LIST, generated: generatedWith },
      ["R1"],
    );
    const framesWithout = initialTestCaseFramesOf(
      { table: withoutOperation, ledger: PROPERTY_LEDGER_VIEW_IDS, list: LIST, generated: generatedWithout },
      ["R1"],
    );
    expect(framesWith).toEqual(framesWithout);
  });

  it("(6) B3' の要求：操作の行を所属させた表と外した表で、要求の差はその要件の所属の行 ID の分だけ（ほかの塊・規則の文は同じ）", async () => {
    const full = fixtureTable();
    const withoutOperation: NameTable = {
      ...full,
      ownership: full.ownership.map((entry) =>
        entry.requirementId === "R1" ? { ...entry, roles: entry.roles.filter((role) => role.id !== "o.addItem") } : entry,
      ),
    };
    const list = fixtureList();
    const plan: ConfirmedPlan = planOf(list);
    const targetIds = ["R1", "R2", "R3", "R4"];
    const accept = (requirementId: string) => ({ requirementId, verdict: "accept" as const, kind: null, quote: null });
    const requestOf = async (table: NameTable) => {
      const app = await normalizedFixture(FIXTURE_YAML);
      const recording = createCheckedRecordingClient([recordedStructured({ judgments: targetIds.map(accept) })]);
      await runDeclCheck({
        plan,
        list,
        table,
        declaration: { source: FIXTURE_YAML },
        app,
        documents: FIXTURE_DOCUMENTS,
        gateway: makeGateway(recording.client),
      });
      return recording.structured[0]!;
    };
    const dataBlocks = (input: string) =>
      [...input.matchAll(/<data name="([^"]+)">\n([\s\S]*?)\n<\/data>/g)].map((match) => ({ name: match[1] as string, text: match[2] as string }));
    const rowsById = (request: { readonly input: string }) => {
      const block = dataBlocks(request.input).find((entry) => entry.name === "所属の行");
      if (block === undefined) throw new Error("前提が壊れた：所属の行の塊が無い");
      const parsed = JSON.parse(block.text) as readonly { readonly requirementId: string; readonly rows: readonly { readonly id: string }[] }[];
      return new Map(parsed.map((entry) => [entry.requirementId, entry.rows.map((rowEntry) => rowEntry.id)] as const));
    };
    const withRequest = await requestOf(full);
    const withoutRequest = await requestOf(withoutOperation);
    // 規則の文とほかの塊は同じ
    expect(withRequest.rules).toEqual(withoutRequest.rules);
    const withBlocks = dataBlocks(withRequest.input);
    const withoutBlocks = dataBlocks(withoutRequest.input);
    expect(withBlocks.map((block) => block.name)).toEqual(withoutBlocks.map((block) => block.name));
    for (const index of withBlocks.keys()) {
      if (withBlocks[index]?.name === "所属の行") continue;
      expect(withBlocks[index]?.text).toBe(withoutBlocks[index]?.text);
    }
    // 差はその要件の所属の行 ID の分だけ
    const withRows = rowsById(withRequest);
    const withoutRows = rowsById(withoutRequest);
    expect(withRows.get("R1")).toEqual([...(withoutRows.get("R1") ?? []), "o.addItem"]);
    for (const requirementId of targetIds.filter((id) => id !== "R1")) {
      expect(withRows.get(requirementId), requirementId).toEqual(withoutRows.get(requirementId));
    }
  });

  it("(7) 変異の証跡：許す行を base の集合に戻す・条件の有無を外す・entity の照合を外すと、それぞれ対応する試験が赤になる", () => {
    // 許す行を base の集合に戻すと (1) は赤（others）
    expect(baseOwnershipOthers([E1, F1, OP1], ["E1.F1"], [owned("E1.F1"), owned("OP1", "dependency"), owned("E1", "dependency")])).toEqual([OTHERS]);
    // 変異の模型：(2) の条件のある操作と別の entity の操作は、どちらの条件を外すと通ってしまうか
    const rows = [E1, F1, OP1, OP3, OP7];
    expect(guardedOperationIdsWith(rows, "E1", { checkWhen: true, checkEntity: true })).toEqual(["OP1"]);
    expect(guardedOperationIdsWith(rows, "E1", { checkWhen: false, checkEntity: true })).toEqual(["OP1", "OP3"]);
    expect(guardedOperationIdsWith(rows, "E1", { checkWhen: true, checkEntity: false })).toEqual(["OP1", "OP7"]);
  });

  it("(8) 指紋：操作の行を所属させない台本は表の中身が同じなので旧の値のまま。所属させた台本は所属の差を機械で示したうえで新しい値を等値で固定する（旧の挙動は C2' が通らず表が無い）", async () => {
    const withOperation = tableOf([E1, F1, OP1], [owned("E1.F1"), owned("OP1", "dependency")]);
    const withoutOperation = tableOf([E1, F1, OP1], [owned("E1.F1")]);
    // 差は所属の行の並びだけ
    expect(jsonDiffPaths(withOperation.ownership, withoutOperation.ownership)).toEqual(["$[0].roles"]);
    // 分岐が変わらない台本（操作を所属させない）は、直す前と同じ表なので旧の値のまま
    expect(await nameTableSha256(withoutOperation)).toBe("508b830b102cd7c33f40935065f38f8fbc5dc4b61e22c0bfbad0c91127fe7259");
    // 分岐が変わる台本（操作を所属させる）は新しい値。直す前は固定文 others で表が採られなかったので旧の値は無い
    expect(await nameTableSha256(withOperation)).toBe("3b8acbd1a627ba190cc7e228cdcb3499f6b28a19905d99d1572b9e44edd4b20c");
  });

  it("題材：要求・試験・fixture のどこにも受入の題材の言葉が無い", () => {
    expectNoAcceptanceMaterial([
      R1_TEXT,
      ...[E1, F1, E2, F2, C1, V1, OP1, OP2, OP3, OP4, OP5, OP7].map((entry) => `${entry.id} ${entry.name} ${entry.role ?? ""}`),
      JSON.stringify(tableOf([E1, F1, OP1], [owned("E1.F1"), owned("OP1", "dependency")])),
      JSON.stringify(tableOf([E1, F1, OP1], [owned("E1.F1"), owned("OP1", "dependency")], ["E1.F1", "E1.UNKNOWN"])),
    ]);
  });
});
