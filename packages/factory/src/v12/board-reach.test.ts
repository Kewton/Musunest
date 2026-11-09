// Issue #804 の二点測定（(1)〜(7)・(10)）。
//
// host のボードは、カードに**その entity の項目を宣言の順に全部**出し、強調の印に `highlight` の計算を使う。
// 到達の判定はこの事実のうち一覧・表と `highlight` だけを持っていたので、ボードだけで見せている entity の
// 項目を「画面から辿れない」と落としていた。旗 `v12.ids` の走りだけが**規則の選択**（`BOARD_REACH_RULES`）を
// B3・B4 へ渡し、渡されたときだけボードを数える。**渡さなければ今の判定**（ids off・v1・v1.1a）。
//
// 題材は抽象的な名前だけで組む（受入の題材の言葉は使わない）。偽物の LLM は呼ばない。
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { normalizeSpec } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import type { FixedTest, TestSuite } from "../fixed-test.js";
import type { CorrespondenceEntry, DeclarationLocation, RequirementList, RoleEntry } from "../pipeline.js";
import {
  BOARD_REACH_RULES,
  checkLocation,
  fieldReachableFromScreen,
  type ReachRules,
} from "../stages/correspondence.js";
import { runTests, type TestRunReport } from "../stages/run-tests.js";
import { bindTestsById, correspondenceFromTable } from "../v11a/bind-by-id.js";
import { identityMappings, toRoleEntries, toV1 } from "../v11a/convert.js";
import { createV11aEvaluator } from "../v11a/evaluate.js";
import { checkNames } from "../v11a/name-check.js";
import type { NameTable, NameTableRow } from "../v11a/names.js";
import type { EvaluationContext } from "../stages/tools.js";
import type { TestObserves } from "../v11a/stages/test-spec.js";

const CLOCK = "2026-01-01T00:00:00+09:00";

/** 抽象的な題材の宣言。ボードだけの entity（`solo`）と、ボードを持つ `item`、別の entity のボードを持たない `other`、
 * 精算の表示だけの `ledger`、ダッシュボードの `panel` を持つ。 */
const DECLARATION = [
  "entities:",
  "  - name: item",
  "    fields:",
  "      title: string",
  "      amount: number",
  "      status:",
  "        type: enum",
  "        options:",
  "          open: 未処理",
  "          closed: 完了",
  "  - name: other",
  "    fields:",
  "      code: string",
  "  - name: solo",
  "    fields:",
  "      label: string",
  "      state:",
  "        type: enum",
  "        options:",
  "          on: 入",
  "          off: 切",
  "  - name: ledger",
  "    fields:",
  "      total: number",
  "  - name: panel",
  "    fields:",
  "      label: string",
  "      extra: number",
  "computed:",
  "  - name: isOpen",
  "    entity: item",
  '    expression: status == "open"',
  "    type: boolean",
  "  - name: doubled",
  "    entity: item",
  "    expression: amount * 2",
  "    type: number",
  "  - name: score",
  "    entity: panel",
  "    expression: extra * 2",
  "    type: number",
  "views:",
  "  - name: items",
  "    type: list",
  "    entity: item",
  "    show: [title]",
  "  - name: itemsTable",
  "    type: table",
  "    entity: item",
  "    show: [title]",
  "  - name: board",
  "    type: board",
  "    entity: item",
  "    columns: status",
  "    highlight: isOpen",
  "  - name: soloBoard",
  "    type: board",
  "    entity: solo",
  "    columns: state",
  "  - name: ledgerView",
  "    type: settlement",
  "    entity: ledger",
  "  - name: overview",
  "    type: dashboard",
  "    widgets:",
  "      - type: ranking",
  "        name: topPanel",
  "        entity: panel",
  "        by: score",
  "        show: [score]",
  "actions: []",
  "validations: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const APP: NormalizedAppSpec = await (async (): Promise<NormalizedAppSpec> => {
  const result = await normalizeSpec(DECLARATION);
  if (!result.ok) throw new Error(`前提が壊れた：${result.diagnostics.map((diagnostic) => diagnostic.code).join("・")}`);
  return result.app;
})();

const rowOf = (row: Omit<NameTableRow, "role" | "source" | "options" | "groupBy" | "refEntity">): NameTableRow => ({
  role: "要件が使う対象",
  source: { requirementId: "R1", quote: "対象" },
  options: null,
  groupBy: null,
  refEntity: null,
  ...row,
});

const ROWS: readonly NameTableRow[] = [
  rowOf({ id: "e.item", kind: "entity", entity: null, name: "item", type: null }),
  rowOf({ id: "f.item.title", kind: "field", entity: "e.item", name: "title", type: "string" }),
  rowOf({ id: "f.item.amount", kind: "field", entity: "e.item", name: "amount", type: "number" }),
  rowOf({ id: "f.item.status", kind: "field", entity: "e.item", name: "status", type: "enum" }),
  rowOf({
    id: "c.itemIsOpen",
    kind: "computation",
    entity: "e.item",
    name: "isOpen",
    type: { valueType: "boolean", scope: "row", form: "expression" },
  }),
  rowOf({
    id: "c.itemDoubled",
    kind: "computation",
    entity: "e.item",
    name: "doubled",
    type: { valueType: "number", scope: "row", form: "expression" },
  }),
  rowOf({ id: "s.board", kind: "screen", entity: "e.item", name: "board", type: { view: "board" } }),
  rowOf({ id: "s.items", kind: "screen", entity: "e.item", name: "items", type: { view: "list" } }),
  rowOf({ id: "s.itemsTable", kind: "screen", entity: "e.item", name: "itemsTable", type: { view: "table" } }),
  rowOf({ id: "e.other", kind: "entity", entity: null, name: "other", type: null }),
  rowOf({ id: "f.other.code", kind: "field", entity: "e.other", name: "code", type: "string" }),
  rowOf({ id: "e.solo", kind: "entity", entity: null, name: "solo", type: null }),
  rowOf({ id: "f.solo.label", kind: "field", entity: "e.solo", name: "label", type: "string" }),
  rowOf({ id: "f.solo.state", kind: "field", entity: "e.solo", name: "state", type: "enum" }),
  rowOf({ id: "s.soloBoard", kind: "screen", entity: "e.solo", name: "soloBoard", type: { view: "board" } }),
  rowOf({ id: "e.ledger", kind: "entity", entity: null, name: "ledger", type: null }),
  rowOf({ id: "f.ledger.total", kind: "field", entity: "e.ledger", name: "total", type: "number" }),
  rowOf({ id: "s.ledgerView", kind: "screen", entity: "e.ledger", name: "ledgerView", type: { view: "settlement" } }),
  rowOf({ id: "e.panel", kind: "entity", entity: null, name: "panel", type: null }),
  rowOf({ id: "f.panel.label", kind: "field", entity: "e.panel", name: "label", type: "string" }),
  rowOf({ id: "f.panel.extra", kind: "field", entity: "e.panel", name: "extra", type: "number" }),
  rowOf({ id: "c.panelScore", kind: "computation", entity: "e.panel", name: "score", type: { valueType: "number", scope: "row", form: "expression" } }),
  rowOf({ id: "s.overview", kind: "screen", entity: null, name: "overview", type: { view: "dashboard" } }),
];

const TABLE: NameTable = {
  rows: ROWS,
  ownership: [{ requirementId: "R1", roles: ROWS.map((row) => ({ id: row.id, basis: "stated" as const, reason: null })) }],
  verification: [{ requirementId: "R1", kind: "fixed-test" }],
  classification: [{ requirementId: "R1", nature: "ruled" }],
};

const LIST = { requirements: [{ id: "R1", text: "対象を画面から見られる。" }] } as unknown as RequirementList;

const location = (kind: DeclarationLocation["kind"], entity: string | null, name: string): DeclarationLocation => ({
  kind,
  entity,
  name,
});

/** B3 の落ちのうち、その場所のものを取り出す（要件 ID は問わない） */
const missesAt = (
  misses: readonly { readonly location?: DeclarationLocation; readonly detail: string }[],
  expected: DeclarationLocation,
): readonly { readonly detail: string; readonly route?: string }[] =>
  misses.filter(
    (miss) =>
      miss.location !== undefined &&
      miss.location.kind === expected.kind &&
      (miss.location.entity ?? null) === expected.entity &&
      miss.location.name === expected.name,
  );

describe("Issue #804 の二点測定", () => {
  it("(1) B3 の項目：ボードだけでも、規則を渡せば辿れ、渡さなければ「画面から辿れない」の落ち（直す前の挙動）", () => {
    const locationOfAmount = location("field", "item", "amount");
    // 規則を渡さない（base）：一覧の show に無い項目は辿れない
    const base = checkNames({ app: APP, table: TABLE, list: LIST });
    expect(missesAt(base.misses, locationOfAmount).some((miss) => miss.detail.includes("画面から辿れない"))).toBe(true);
    // 規則を渡す：同じ entity のボードが項目を全部出すので辿れる
    const withRules = checkNames({ app: APP, table: TABLE, list: LIST, reach: BOARD_REACH_RULES });
    expect(missesAt(withRules.misses, locationOfAmount)).toEqual([]);
    // 一覧が無く、ボードだけでも同じ（solo はボードだけ）
    expect(missesAt(base.misses, location("field", "solo", "label")).length).toBe(1);
    expect(missesAt(withRules.misses, location("field", "solo", "label"))).toEqual([]);
    // `columns` の項目も辿れる（status はボードの列）
    expect(missesAt(base.misses, location("field", "item", "status")).length).toBe(1);
    expect(missesAt(withRules.misses, location("field", "solo", "state"))).toEqual([]);
    expect(missesAt(withRules.misses, location("field", "item", "status"))).toEqual([]);
  });

  it("(2) 負例：別の entity のボード・highlight 以外の行ごとの計算・精算・ダッシュボードは、規則を渡しても base と同じ", () => {
    const base = checkNames({ app: APP, table: TABLE, list: LIST });
    const withRules = checkNames({ app: APP, table: TABLE, list: LIST, reach: BOARD_REACH_RULES });
    // 別の entity のボード（item のボード）では、other の項目は辿れない
    const other = location("field", "other", "code");
    expect(missesAt(withRules.misses, other)).toEqual(missesAt(base.misses, other));
    expect(missesAt(withRules.misses, other).length).toBe(1);
    // 同じ entity のボードがあっても、highlight 以外の行ごとの計算は辿れないまま（base と同じ文言・記録の形）
    const doubled = location("computation", "item", "doubled");
    expect(missesAt(withRules.misses, doubled)).toEqual(missesAt(base.misses, doubled));
    expect(missesAt(withRules.misses, doubled)[0]?.detail).toBe("計算 doubled は画面から辿れない");
    // highlight の計算は base と同じく辿れる
    expect(checkLocation(APP, location("computation", "item", "isOpen")).ok).toBe(true);
    expect(checkLocation(APP, location("computation", "item", "doubled")).ok).toBe(false);
    // 精算の表示だけの entity の項目は辿れないまま
    const ledger = location("field", "ledger", "total");
    expect(missesAt(withRules.misses, ledger)).toEqual(missesAt(base.misses, ledger));
    expect(missesAt(withRules.misses, ledger).length).toBe(1);
    // ダッシュボードの判定は base と同じ（順位の show にも出ない項目）
    const extra = location("field", "panel", "extra");
    expect(missesAt(withRules.misses, extra)).toEqual(missesAt(base.misses, extra));
    expect(missesAt(withRules.misses, extra).length).toBe(1);
    // 規則を渡しても、落ちの文言と行き先の形は変わらない
    expect(missesAt(withRules.misses, other)[0]?.detail).toBe(missesAt(base.misses, other)[0]?.detail);
    expect(missesAt(withRules.misses, other)[0]?.route).toBe("missing-element");
  });

  it("(3) B3 の entity：create が無くボードだけで見せる entity は、規則を渡せば辿れ、渡さなければ落ちる", () => {
    const solo = location("entity", null, "solo");
    const base = checkNames({ app: APP, table: TABLE, list: LIST });
    const withRules = checkNames({ app: APP, table: TABLE, list: LIST, reach: BOARD_REACH_RULES });
    expect(missesAt(base.misses, solo).some((miss) => miss.detail.includes("画面から辿れない"))).toBe(true);
    expect(missesAt(withRules.misses, solo)).toEqual([]);
  });

  it("(4) B4 の項目 × 画面：規則を渡せば一致、渡さなければ「画面から辿れない」の不一致で行き先 missing-element（base）", () => {
    const suite = suiteOf([fieldScreenTest("amount", "f.item.amount")]);
    const without = runBoardTests(suite, undefined);
    expect(without.mismatches.map((entry) => entry.testId)).toEqual(["amount"]);
    expect(without.mismatches[0]?.detail).toContain("画面から辿れない");
    expect(without.routes.find((route) => route.testId === "amount")?.route).toBe("missing-element");
    const withRules = runBoardTests(suite, BOARD_REACH_RULES);
    expect({ mismatches: withRules.mismatches, unresolved: withRules.unresolved, routes: withRules.routes }).toEqual({
      mismatches: [],
      unresolved: [],
      routes: [],
    });
  });

  it("(5) B4 の在ること：ボードだけの entity の在ることの試験は、規則を渡せば一致、渡さなければ不一致", () => {
    const suite = suiteWithClassification([existenceTest("solo-exists", "e.solo")], "R1", "existence-only");
    const without = runBoardTests(suite);
    expect(without.mismatches.map((entry) => entry.testId)).toEqual(["solo-exists"]);
    expect(without.mismatches[0]?.detail).toContain("create の操作も、一覧か表の表示も無い");
    const withRules = runBoardTests(suite, BOARD_REACH_RULES);
    expect(withRules.mismatches).toEqual([]);
    expect(withRules.routes).toEqual([]);
  });

  it("(6) view-shows：ボードは項目を全部表示し、highlight は表示、それ以外の行ごとの計算は表示しない。table・list・dashboard は base と同じ", () => {
    const base = runBoardTests(suiteOf([
      viewShowsTest("board-amount", "s.board", "f.item.amount"),
      viewShowsTest("board-status", "s.board", "f.item.status"),
      viewShowsTest("board-highlight", "s.board", "c.itemIsOpen"),
      viewShowsTest("board-other-computed", "s.board", "c.itemDoubled"),
      viewShowsTest("list-amount", "s.items", "f.item.amount"),
      viewShowsTest("table-amount", "s.itemsTable", "f.item.amount"),
      viewShowsTest("dashboard-extra", "s.overview", "f.panel.extra"),
    ]));
    // 規則を渡さなければ、ボードは highlight と columns だけ（base と同じ）
    expect(base.mismatches.map((entry) => entry.testId).sort()).toEqual([
      "board-amount",
      "board-other-computed",
      "dashboard-extra",
      "list-amount",
      "table-amount",
    ]);
    const withRules = runBoardTests(
      suiteOf([
        viewShowsTest("board-amount", "s.board", "f.item.amount"),
        viewShowsTest("board-status", "s.board", "f.item.status"),
        viewShowsTest("board-highlight", "s.board", "c.itemIsOpen"),
        viewShowsTest("board-other-computed", "s.board", "c.itemDoubled"),
        viewShowsTest("list-amount", "s.items", "f.item.amount"),
        viewShowsTest("table-amount", "s.itemsTable", "f.item.amount"),
        viewShowsTest("dashboard-extra", "s.overview", "f.panel.extra"),
      ]),
      BOARD_REACH_RULES,
    );
    // ボードは項目を全部表示する（規則を渡したときだけ）
    expect(withRules.mismatches.map((entry) => entry.testId).sort()).toEqual([
      "board-other-computed",
      "dashboard-extra",
      "list-amount",
      "table-amount",
    ]);
    expect(withRules.mismatches.find((entry) => entry.testId === "board-other-computed")?.detail).toBe("一覧 board は doubled を表示しない");
    // table・list の判定は base と同じ
    expect(base.mismatches.some((entry) => entry.testId === "list-amount")).toBe(true);
    expect(withRules.mismatches.some((entry) => entry.testId === "list-amount")).toBe(true);
    // dashboard の判定は base と同じ
    expect(withRules.mismatches.some((entry) => entry.testId === "dashboard-extra")).toBe(true);
  });

  it("(7) 配線：規則を渡した評価口は B3 と B4 の両方でボードを数え、渡さない評価口はどちらも数えない", () => {
    const context = contextOf();
    const suite = suiteWithClassification(
      [
        fieldScreenTest("amount", "f.item.amount"),
        existenceTest("solo-exists", "e.solo"),
        viewShowsTest("board-amount", "s.board", "f.item.amount"),
      ],
      "R1",
      "existence-only",
    );
    const runWith = (reach: ReachRules | undefined) => {
      const evaluator = createV11aEvaluator({
        table: TABLE,
        observes: new Map<string, TestObserves>(suite.tests.map((test) => [test.id, "view-structure"])),
        ...(reach === undefined ? {} : { reach }),
      });
      const checked = evaluator.nameCheck(APP, { ...context, suite });
      const run = evaluator.runTests(APP, { ...context, suite }, { entries: checked.entries, misses: checked.misses });
      return { misses: checked.misses, run };
    };
    const without = runWith(undefined);
    expect(missesAt(without.misses, location("field", "item", "amount")).length).toBe(1);
    expect(missesAt(without.misses, location("entity", null, "solo")).length).toBe(1);
    expect(without.run.mismatches.map((entry) => entry.testId).sort()).toEqual(["amount", "board-amount", "solo-exists"]);
    const withRules = runWith(BOARD_REACH_RULES);
    expect(missesAt(withRules.misses, location("field", "item", "amount"))).toEqual([]);
    expect(missesAt(withRules.misses, location("entity", null, "solo"))).toEqual([]);
    expect(tidyRun(withRules.run)).toEqual({ mismatches: [], unresolved: [], routes: [] });
  });

  it("(10) 指紋：規則を渡さない値は base のまま（board でも他の view でも変わらない）、渡したときだけ board の項目が真になる", () => {
    // 規則を渡さない到達の関数の値は base（今の判定）のまま
    expect(fieldReachableFromScreen(APP, location("field", "item", "amount"))).toBe(false);
    expect(fieldReachableFromScreen(APP, location("field", "item", "status"))).toBe(false);
    expect(fieldReachableFromScreen(APP, location("field", "solo", "label"))).toBe(false);
    expect(fieldReachableFromScreen(APP, location("field", "item", "title"))).toBe(true);
    expect(checkLocation(APP, location("computation", "item", "doubled")).ok).toBe(false);
    expect(checkLocation(APP, location("computation", "panel", "score")).ok).toBe(true);
    // 規則を渡しても、board 以外の view の値は変わらない
    for (const rules of [undefined, BOARD_REACH_RULES]) {
      expect(fieldReachableFromScreen(APP, location("field", "item", "title"), rules)).toBe(true);
      expect(fieldReachableFromScreen(APP, location("field", "other", "code"), rules)).toBe(false);
      expect(fieldReachableFromScreen(APP, location("field", "ledger", "total"), rules)).toBe(false);
      expect(fieldReachableFromScreen(APP, location("field", "panel", "extra"), rules)).toBe(false);
      expect(checkLocation(APP, location("computation", "item", "doubled")).ok).toBe(false);
    }
    // 規則を渡したときだけ、board の項目が真になる
    expect(fieldReachableFromScreen(APP, location("field", "item", "amount"), BOARD_REACH_RULES)).toBe(true);
    expect(fieldReachableFromScreen(APP, location("field", "solo", "label"), BOARD_REACH_RULES)).toBe(true);
  });
});

// ── 試験の組み立て ────────────────────────────────────────────────────

/** B3・B4 の評価の文脈 */
function contextOf(): EvaluationContext {
  return {
    list: LIST,
    suite: { tests: [] },
    correspondences: correspondenceFromTable(TABLE),
    ownership: toV1(TABLE).ownership,
  };
}

const ENTRIES: readonly CorrespondenceEntry[] = correspondenceFromTable(TABLE);
const MAPPINGS = identityMappings(TABLE);
const ROLES: readonly RoleEntry[] = toRoleEntries(TABLE);

/** ボードの題材の表で B4 を流す（bindTestsById で試験 ID ごとに結び付ける） */
function runBoardTests(suite: TestSuite, reach?: ReachRules): TestRunReport {
  const bound = bindTestsById(APP, TABLE, suite);
  return runTests({
    app: APP,
    suite,
    correspondence: { entries: ENTRIES, misses: [] },
    mappings: MAPPINGS,
    roles: ROLES,
    bindings: { tests: bound.bindings, entityNames: bound.entityNames },
    ...(reach === undefined ? {} : { reach }),
  });
}

function suiteOf(tests: readonly FixedTest[]): TestSuite {
  return { tests };
}

function suiteWithClassification(
  tests: readonly FixedTest[],
  requirementId: string,
  nature: "ruled" | "existence-only",
): TestSuite {
  return { tests, classifications: [{ requirementId, nature }] };
}

function fieldScreenTest(id: string, roleId: string): FixedTest {
  return {
    id,
    target: { requirementId: "R1", kind: "field", roleId },
    kind: "normal",
    operation: "screen",
    clock: CLOCK,
    input: {},
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: null },
  };
}

function existenceTest(id: string, roleId: string): FixedTest {
  return {
    id,
    target: { requirementId: "R1", kind: "entity", roleId },
    kind: "normal",
    operation: "screen",
    clock: CLOCK,
    input: {},
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: null },
  };
}

function viewShowsTest(id: string, viewRowId: string, role: string): FixedTest {
  return {
    id,
    target: { requirementId: "R1", kind: "screen", roleId: viewRowId },
    kind: "normal",
    operation: "structure",
    clock: CLOCK,
    input: {},
    referenceData: [],
    expected: { kind: "ok", value: true },
    assertion: { check: "view-shows", role },
  };
}

/** 一致・不一致・未解決と行き先だけを取り出す */
function tidyRun(report: TestRunReport): Pick<TestRunReport, "mismatches" | "unresolved" | "routes"> {
  return { mismatches: report.mismatches, unresolved: report.unresolved, routes: report.routes };
}
