// コードが作る試験（v12/generated-tests.ts）の試験（08-architecture-v1.2.md §4 の C4・§5・§6。v1.2 手 3c・Issue #595）。
//
// 固定したいこと：
//   1. 純粋：同じ表・台帳・一覧から 2 回同じ組（LLM を呼ばない）
//   2. 既定値 1 本・選択肢の集合 1 本（形は台帳の試験の型どおり、期待は確かめ方の値と options の並び）
//   3. アプリ全体の sum に境界（0）と異常（null）、見出しごと × 選択肢の count に境界（options の順の 0 の並び）と異常（null）、
//      avg × 空に null。行ごとの集計と見出しごと × 月の集計は作らない。持ち越しの要件・構造の要件・在ることだけの要件には作らない
//   4. 試験 ID が予約の接頭辞で一意
//   5. 重なりの検査：コードが作る試験と同じ（要件・対象・性質・データ状態）の LLM の試験と、予約の接頭辞の試験 ID を固定文で落とす
//
// 偽物も含めて LLM を呼ばない。外部の API を呼ばない。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import type { FixedTest } from "../fixed-test.js";
import { ACCEPTANCE_MATERIAL_WORDS } from "../stages/__tests__/prompt.js";
import { fixtureGeneratedList, fixtureGeneratedTable, fixtureList, fixtureTable, withAggregates } from "../v11a/__tests__/fixtures.js";
import type { NameTable } from "../v11a/names.js";
import {
  GENERATED_TEST_CLOCK,
  GENERATED_TEST_ID_MESSAGE,
  GENERATED_TEST_ID_PREFIX,
  GENERATED_TEST_ROW_ID,
  aggregateTargetsOf,
  checkGeneratedOverlap,
  generateTests,
  isGeneratedTestId,
} from "./generated-tests.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW } from "./ledger.js";

const LIST = fixtureGeneratedList();
const TABLE = fixtureGeneratedTable();
const ledger = PROPERTY_LEDGER_VIEW;
const generate = (table: NameTable = TABLE, list = LIST) => generateTests({ table, ledger, list });

const rowOf = (id: string) => {
  const row = PROPERTY_LEDGER.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`前提が壊れた：台帳に ${id} が無い`);
  return row;
};

/** 作った試験のうち、要件・対象・観測する性質で引いたもの */
const testsOf = (tests: readonly FixedTest[], observes: ReadonlyMap<string, string>, requirementId: string, roleId: string, observed: string) =>
  tests.filter((test) => test.target.requirementId === requirementId && test.target.roleId === roleId && observes.get(test.id) === observed);

describe("コードが作る試験：純粋で、同じ入力から同じ組（Issue #595）", () => {
  it("同じ表・台帳・一覧から 2 回同じ組（試験・観測する性質・除く要件）", () => {
    const first = generate();
    const second = generate();
    expect(second.tests).toEqual(first.tests);
    expect([...second.observes]).toEqual([...first.observes]);
    expect(second.excludedRequirementIds).toEqual(first.excludedRequirementIds);
    // 入力の表を書き換えない
    expect(TABLE).toEqual(fixtureGeneratedTable());
  });

  it("試験 ID は予約の接頭辞で始まり、組の中で一意。観測する性質の写像は作った試験とちょうど同じ鍵", () => {
    const { tests, observes } = generate();
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.every((test) => test.id.startsWith(GENERATED_TEST_ID_PREFIX) && isGeneratedTestId(test.id))).toBe(true);
    expect(new Set(tests.map((test) => test.id)).size).toBe(tests.length);
    expect([...observes.keys()]).toEqual(tests.map((test) => test.id));
    expect(isGeneratedTestId("r1-normal")).toBe(false);
  });

  it("一覧の順に並び、要件ごとの数：R4 は見出しごと × 選択肢（c.byKind）とアプリ全体（c.base）に 2 本ずつ（所属の順）、R6・R7 は 1 本ずつ。除く要件は R6・R7", () => {
    const { tests, observes, excludedRequirementIds } = generate();
    expect(tests.map((test) => [test.target.requirementId, test.target.roleId, test.kind, observes.get(test.id)])).toEqual([
      ["R4", "c.byKind", "boundary", "empty-aggregate"],
      ["R4", "c.byKind", "abnormal", "empty-aggregate"],
      ["R4", "c.base", "boundary", "empty-aggregate"],
      ["R4", "c.base", "abnormal", "empty-aggregate"],
      ["R6", "f.item.kind", "normal", "default-value"],
      ["R7", "f.item.kind", "normal", "enum-membership"],
    ]);
    expect(excludedRequirementIds).toEqual(["R6", "R7"]);
  });
});

describe("既定値・選択肢の集合：台帳の試験の型どおりの 1 本（Issue #595）", () => {
  it("既定値：対象は確かめ方の選択肢の項目・normal・validate・入力は空の写像・参照データは空・期待は ok で確かめ方のキー", () => {
    const { tests, observes } = generate();
    const [only, ...rest] = testsOf(tests, observes, "R6", "f.item.kind", "default-value");
    expect(rest).toEqual([]);
    expect(only).toEqual({
      id: `${GENERATED_TEST_ID_PREFIX}default-value:R6:f.item.kind:normal`,
      target: { requirementId: "R6", kind: "field", roleId: "f.item.kind" },
      kind: "normal",
      operation: "validate",
      clock: GENERATED_TEST_CLOCK,
      input: {},
      inputContract: { rowId: GENERATED_TEST_ROW_ID, targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: "alpha" },
    });
  });

  it("選択肢の集合：同じ形で、期待は対象の行の options を表の順に並べた並び（options を並べ替えた表なら並びも替わる）", () => {
    const { tests, observes } = generate();
    const [only] = testsOf(tests, observes, "R7", "f.item.kind", "enum-membership");
    expect(only?.expected).toEqual({ kind: "ok", value: ["alpha", "beta"] });
    expect(only?.input).toEqual({});
    expect(only?.referenceData).toEqual([]);
    const reordered: NameTable = { ...TABLE, rows: TABLE.rows.map((row) => (row.id === "f.item.kind" ? { ...row, options: ["beta", "alpha", "gamma"] } : row)) };
    const [other] = testsOf(generate(reordered).tests, generate(reordered).observes, "R7", "f.item.kind", "enum-membership");
    expect(other?.expected).toEqual({ kind: "ok", value: ["beta", "alpha", "gamma"] });
  });

  it("持ち越しの要件（一覧と表から除いた要件）の試験は作らない", () => {
    const list = { ...LIST, requirements: LIST.requirements.filter((requirement) => requirement.id !== "R6") };
    const { tests, excludedRequirementIds } = generate(TABLE, list);
    expect(tests.some((test) => test.target.requirementId === "R6")).toBe(false);
    expect(excludedRequirementIds).toEqual(["R7"]);
  });

  it("所属の選択肢の項目が 1 つに決まらない要件（2 つ所属させた表）には作らず、除く要件にも入れない（fail-closed。T2' の対象の落ちに任せる）", () => {
    const table: NameTable = {
      ...TABLE,
      ownership: TABLE.ownership.map((entry) =>
        entry.requirementId === "R6" ? { ...entry, roles: [...entry.roles, { id: "f.item.title", basis: "stated" as const, reason: null }] } : entry,
      ),
    };
    // 項目の型が enum の行は 1 つのまま（title は文字列）なので作る。enum の行を 2 つ所属させれば作らない
    expect(generate(table).excludedRequirementIds).toEqual(["R6", "R7"]);
    const twoEnums: NameTable = {
      ...TABLE,
      rows: TABLE.rows.map((row) => (row.id === "f.item.title" ? { ...row, type: "enum" as const, options: ["x"] } : row)),
      ownership: table.ownership,
    };
    expect(generate(twoEnums).excludedRequirementIds).toEqual(["R7"]);
    expect(generate(twoEnums).tests.some((test) => test.target.requirementId === "R6")).toBe(false);
  });
});

describe("空の集計：アプリ全体と見出しごと × 選択肢だけ。値は台帳の表（Issue #595）", () => {
  const aggregateOf = (id: string) => rowOf("empty-aggregate").t2Aggregate?.states.find((entry) => entry.state === id);

  it("アプリ全体の sum：集計元を空と明示した境界は 0、集計元に触れない異常は null。参照データは空・入力の契約はコードが書く", () => {
    const { tests, observes } = generate();
    const [empty, unread] = testsOf(tests, observes, "R4", "c.base", "empty-aggregate");
    expect(empty?.kind).toBe(aggregateOf("empty")?.kind);
    expect(empty?.kind).toBe("boundary");
    expect(empty?.operation).toBe("aggregate");
    expect(empty?.target).toEqual({ requirementId: "R4", kind: "computation", roleId: "c.base" });
    expect(empty?.inputContract).toEqual({ rowId: GENERATED_TEST_ROW_ID, targetRowId: null, emptyEntities: ["e.item"] });
    expect(empty?.referenceData).toEqual([]);
    expect(empty?.expected).toEqual({ kind: "ok", value: 0 });
    expect(unread?.kind).toBe("abnormal");
    expect(unread?.inputContract).toEqual({ rowId: GENERATED_TEST_ROW_ID, targetRowId: null, emptyEntities: [] });
    expect(unread?.expected).toEqual({ kind: "ok", value: null });
  });

  it("見出しごと × 選択肢の count：境界は options の順の {heading, value: 0} の並び、異常は null", () => {
    const { tests, observes } = generate();
    const [empty, unread] = testsOf(tests, observes, "R4", "c.byKind", "empty-aggregate");
    expect(empty?.expected).toEqual({
      kind: "ok",
      value: [
        { heading: "alpha", value: 0 },
        { heading: "beta", value: 0 },
      ],
    });
    expect(unread?.expected).toEqual({ kind: "ok", value: null });
  });

  it("avg × 空は null（アプリ全体も見出しごとも）", () => {
    const table = withAggregates(TABLE, { "c.base": { kind: "avg", entity: "e.item" }, "c.byKind": { kind: "avg", entity: "e.item" } });
    const { tests, observes } = generate(table);
    expect(testsOf(tests, observes, "R4", "c.base", "empty-aggregate").map((test) => test.expected)).toEqual([
      { kind: "ok", value: null },
      { kind: "ok", value: null },
    ]);
    expect(testsOf(tests, observes, "R4", "c.byKind", "empty-aggregate")[0]?.expected).toEqual({
      kind: "ok",
      value: [
        { heading: "alpha", value: null },
        { heading: "beta", value: null },
      ],
    });
  });

  it("行ごとの集計と見出しごと × 月の集計は作らない（同じ要件が所属させていても）", () => {
    const table: NameTable = {
      ...TABLE,
      ownership: TABLE.ownership.map((entry) =>
        entry.requirementId === "R4" ? { ...entry, roles: [...entry.roles, { id: "c.itemCount", basis: "stated" as const, reason: null }] } : entry,
      ),
    };
    const targets = aggregateTargetsOf(table);
    expect(targets.get("c.itemCount")?.range).toBe("row");
    expect(targets.get("c.byMonth")?.range).toBe("groups-month");
    const { tests } = generate(table);
    expect(tests.some((test) => test.target.roleId === "c.itemCount" || test.target.roleId === "c.byMonth")).toBe(false);
  });

  it("構造で確かめる要件・在ることだけ（T1 の分類）の要件・持ち越しの要件の集計には作らない", () => {
    // R4 を構造で確かめる要件にした表
    const structural: NameTable = {
      ...TABLE,
      verification: TABLE.verification.map((entry) =>
        entry.requirementId === "R4" ? { requirementId: "R4", kind: "structural" as const, reason: "画面に出ることだけ", checks: ["view-shows" as const] } : entry,
      ),
    };
    expect(generate(structural).tests.some((test) => test.target.requirementId === "R4")).toBe(false);
    const existence: NameTable = {
      ...TABLE,
      classification: TABLE.classification.map((entry) => (entry.requirementId === "R4" ? { ...entry, nature: "existence-only" as const } : entry)),
    };
    expect(generate(existence).tests.some((test) => test.target.requirementId === "R4")).toBe(false);
    const carried = { ...LIST, requirements: LIST.requirements.filter((requirement) => requirement.id !== "R4") };
    expect(generate(TABLE, carried).tests.some((test) => test.target.requirementId === "R4")).toBe(false);
  });

  it("集計の種類と集計元を持たない表（旗 off の表の形）と、コードが作る範囲を持たない台帳では、空の集計の試験を作らない", () => {
    const plain: NameTable = { ...fixtureTable(), rows: fixtureTable().rows };
    expect(generateTests({ table: plain, ledger, list: fixtureList() }).tests).toEqual([]);
    const noRanges = {
      ...ledger,
      aggregateRows: ledger.aggregateRows.map((row) => ({ ...row, t2Aggregate: { ...row.t2Aggregate, codeRanges: [] } })),
    };
    expect(generateTests({ table: TABLE, ledger: noRanges, list: LIST }).tests.some((test) => test.target.requirementId === "R4")).toBe(false);
  });
});

describe("重なりの検査：コードが作る試験と同じ組の LLM の試験と、予約の接頭辞の ID を固定文で落とす（Issue #595）", () => {
  const generated = generate();
  const llm = (test: Partial<FixedTest> & Pick<FixedTest, "id" | "target">): FixedTest => ({
    kind: "normal",
    operation: "validate",
    clock: "2026-09-16T12:00:00+09:00",
    input: {},
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: null },
    ...test,
  });
  const check = (tests: readonly FixedTest[], observes: Readonly<Record<string, string>>) =>
    checkGeneratedOverlap({ tests }, new Map(Object.entries(observes)), generated, TABLE, ledger);

  it("同じ要件・対象・性質（既定値・選択肢の集合）は台帳の行の notAllowed で落ちる", () => {
    const tests = [
      llm({ id: "r6-default", target: { requirementId: "R6", kind: "field", roleId: "f.item.kind" } }),
      llm({ id: "r7-enum", target: { requirementId: "R7", kind: "field", roleId: "f.item.kind" } }),
    ];
    expect(check(tests, { "r6-default": "default-value", "r7-enum": "enum-membership" })).toEqual([
      { field: "tests[0].observes", message: rowOf("default-value").t2?.messages.notAllowed },
      { field: "tests[1].observes", message: rowOf("enum-membership").t2?.messages.notAllowed },
    ]);
  });

  it("空の集計：同じデータ状態（空と明示・触れない）は集計の試験の型の notAllowed で落ち、ほかの性質（value）・ほかの対象（月）・コードが作らない要件は落ちない", () => {
    const message = rowOf("empty-aggregate").t2Aggregate?.messages.notAllowed;
    const target = { requirementId: "R4", kind: "computation" as const, roleId: "c.byKind" };
    const empty = llm({ id: "a-empty", target, kind: "boundary", operation: "aggregate", inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: ["e.item"] } });
    const unread = llm({ id: "a-unread", target, kind: "abnormal", operation: "aggregate" });
    const value = llm({ id: "a-value", target, operation: "aggregate", inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: ["e.item"] } });
    const month = llm({ id: "a-month", target: { ...target, roleId: "c.byMonth" }, kind: "boundary", operation: "aggregate", inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: ["e.item"] } });
    const other = llm({ id: "a-other", target: { ...target, requirementId: "R1" }, kind: "boundary", operation: "aggregate", inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: ["e.item"] } });
    expect(
      check([empty, unread, value, month, other], {
        "a-empty": "empty-aggregate",
        "a-unread": "empty-aggregate",
        "a-value": "value",
        "a-month": "empty-aggregate",
        "a-other": "empty-aggregate",
      }),
    ).toEqual([
      { field: "tests[0].observes", message },
      { field: "tests[1].observes", message },
    ]);
  });

  it("予約の接頭辞で始まる LLM の試験 ID は固定文で落ちる（重ならない試験でも）", () => {
    const tests = [llm({ id: `${GENERATED_TEST_ID_PREFIX}x`, target: { requirementId: "R1", kind: "field", roleId: "f.item.amount" } })];
    expect(check(tests, { [`${GENERATED_TEST_ID_PREFIX}x`]: "validation" })).toEqual([{ field: "tests[0].id", message: GENERATED_TEST_ID_MESSAGE }]);
  });

  it("重ならない応答は問題 0。固定文は値を埋めず、題材の言葉が無い", () => {
    expect(check([llm({ id: "r1-normal", target: { requirementId: "R1", kind: "field", roleId: "f.item.amount" } })], { "r1-normal": "validation" })).toEqual([]);
    const texts = JSON.stringify([GENERATED_TEST_ID_MESSAGE, rowOf("empty-aggregate").t2Aggregate?.messages.notAllowed, generated.tests]);
    for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(texts).not.toContain(word);
    expect(GENERATED_TEST_ID_MESSAGE).not.toContain("R4");
  });
});
