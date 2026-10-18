// コードが作る試験（v12/generated-tests.ts）の試験（08-architecture-v1.2.md §4 の C4・§5・§6。v1.2 手 3c・Issue #595）。
//
// 固定したいこと：
//   1. 純粋：同じ表・台帳・一覧から 2 回同じ組（LLM を呼ばない）
//   2. 既定値 1 本・選択肢の集合 1 本（形は台帳の試験の型どおり、期待は確かめ方の値と options の並び）
//   3. アプリ全体の sum に境界（0）と異常（null）、見出しごと × 選択肢の count に境界（options の順の 0 の並び）と異常（null）、
//      avg × 空に null。行ごとの集計と見出しごと × 月の集計は作らない。持ち越しの要件・構造の要件・在ることだけの要件には作らない
//   4. 試験 ID が予約の接頭辞で一意
//   5. 重なりの検査：コードが作る試験と同じ（要件・対象・性質・データ状態）の LLM の試験と、予約の接頭辞の試験 ID を固定文で落とす
//   6. 手 3d（#624）：構造の検査（checks の各項目に 1 本。assertion は表の行の型と元の行 ID）と、fixed-test の要件の画面・在ることの
//      構造の確認（所属の画面の行ごと／画面が無ければ entity の行ごと）。作る対象は確かめ方の種類の優先の順で 1 つの枝だけ。対象の
//      行が無い checks は固定文で止まり近い行に結ばない。混在の回帰（R1）と負例（既定値の要件に entity × screen を足すと落ちる）
//
// 偽物も含めて LLM を呼ばない。外部の API を呼ばない。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import type { FixedTest } from "../fixed-test.js";
import { ACCEPTANCE_MATERIAL_WORDS } from "../stages/__tests__/prompt.js";
import {
  fixtureGeneratedList,
  fixtureGeneratedTable,
  fixtureList,
  fixtureTable,
  withAggregates,
  withCheckTargets,
} from "../v11a/__tests__/fixtures.js";
import type { NameTable } from "../v11a/names.js";
import {
  STRUCTURE_OBSERVES,
  checkAggregateTests,
  checkEvaluabilityByLedger,
  checkLedgerTests,
  type TestObserves,
} from "../v11a/stages/test-spec.js";
import {
  GENERATED_STRUCTURE_OBSERVES,
  GENERATED_STRUCTURE_STOP_MESSAGES,
  GENERATED_TEST_CLOCK,
  GENERATED_TEST_ID_MESSAGE,
  GENERATED_TEST_ID_PREFIX,
  GENERATED_TEST_ROW_ID,
  aggregateTargetsOf,
  checkGeneratedOverlap,
  generateTests,
  isGeneratedTestId,
  ledgerTargetsOf,
  normalOnlyOwnershipRequirementIds,
} from "./generated-tests.js";
import { OWNERSHIP_STRUCTURE_NOT_ALLOWED, PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW } from "./ledger.js";

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

  it("一覧の順に並び、要件ごとの数：R4 は所属の画面（s.overview）に 1 本（#624）と、見出しごと × 選択肢（c.byKind）とアプリ全体（c.base）に 2 本ずつ（所属の順）、R6・R7 は 1 本ずつ。除く要件は R6・R7（検査ごとの対象の無い R2 は止める）", () => {
    const { tests, observes, excludedRequirementIds, stopped } = generate();
    expect(stopped).toEqual([{ field: "requirements[1]", message: GENERATED_STRUCTURE_STOP_MESSAGES.targets }]);
    expect(tests.map((test) => [test.target.requirementId, test.target.roleId, test.kind, observes.get(test.id)])).toEqual([
      ["R4", "s.overview", "normal", "view-structure"],
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
    // 在ることだけの要件にも画面の構造の確認は作る（要件の種類に依らない。#624）が、空の集計は作らない
    const aggregatesOf = (made: ReturnType<typeof generate>, requirementId: string) =>
      made.tests.filter((test) => test.target.requirementId === requirementId && made.observes.get(test.id) === "empty-aggregate");
    expect(aggregatesOf(generate(existence), "R4")).toEqual([]);
    expect(generate(existence).tests.filter((test) => test.target.requirementId === "R4").map((test) => test.operation)).toEqual(["screen"]);
    const carried = { ...LIST, requirements: LIST.requirements.filter((requirement) => requirement.id !== "R4") };
    expect(generate(TABLE, carried).tests.some((test) => test.target.requirementId === "R4")).toBe(false);
  });

  it("集計の種類と集計元を持たない表（旗 off の表の形）と、コードが作る範囲を持たない台帳では、空の集計の試験を作らない", () => {
    const plain: NameTable = { ...fixtureTable(), rows: fixtureTable().rows };
    const onlyAggregates = (made: ReturnType<typeof generateTests>) => made.tests.filter((test) => made.observes.get(test.id) === "empty-aggregate");
    expect(onlyAggregates(generateTests({ table: plain, ledger, list: fixtureList() }))).toEqual([]);
    const noRanges = {
      ...ledger,
      aggregateRows: ledger.aggregateRows.map((row) => ({ ...row, t2Aggregate: { ...row.t2Aggregate, codeRanges: [] } })),
    };
    expect(onlyAggregates(generateTests({ table: TABLE, ledger: noRanges, list: LIST })).some((test) => test.target.requirementId === "R4")).toBe(false);
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

describe("除く要件の fail-closed：除いた要件ごとにコードの試験が 1 本以上あり、作れない要件は除かない（Issue #595）", () => {
  const everyExcludedHasTests = (made: ReturnType<typeof generate>) =>
    made.excludedRequirementIds.every((id) => made.tests.filter((test) => test.target.requirementId === id).length >= 1);

  it("今の表・台帳：除いた R6・R7 にそれぞれ 1 本以上", () => {
    const made = generate();
    expect(made.excludedRequirementIds).toEqual(["R6", "R7"]);
    expect(everyExcludedHasTests(made)).toBe(true);
  });

  it("対象が引けない（確かめ方の値が文字列でない・選択肢の項目を所属させない）要件は作らず、除かない", () => {
    const noField: NameTable = { ...TABLE, ownership: TABLE.ownership.map((entry) => (entry.requirementId === "R7" ? { ...entry, roles: [] } : entry)) };
    const made = generate(noField);
    expect(made.excludedRequirementIds).toEqual(["R6"]);
    expect(made.tests.some((test) => test.target.requirementId === "R7")).toBe(false);
    expect(everyExcludedHasTests(made)).toBe(true);
  });

  it("必須の kind が無い試験の型（作れない型）の台帳なら、その要件は除かない", () => {
    const noKinds = {
      ...ledger,
      rowByVerificationKind: new Map(
        [...ledger.rowByVerificationKind].map(([kind, row]) => [kind, row.t2 === null || kind !== "default-value" ? row : { ...row, t2: { ...row.t2, requiredKinds: [] } }] as const),
      ),
    };
    const made = generateTests({ table: TABLE, ledger: noKinds, list: LIST });
    expect(made.excludedRequirementIds).toEqual(["R7"]);
    expect(made.tests.some((test) => test.target.requirementId === "R6")).toBe(false);
    expect(everyExcludedHasTests(made)).toBe(true);
  });
});

// ── 手 3d：構造の検査と、画面・在ることの構造の確認（Issue #624）──────────────────────

describe("手 3d：構造の検査・画面と在ることの構造の確認をコードが作る（Issue #624）", () => {
  const text = (id: string, body: string) => ({ id, text: body, quote: body, position: { start: 0, end: body.length } });
  const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });
  /** R9：checks 3 つの構造の要件、R10：画面 2 行の fixed-test、R11：画面が無く entity 1 行、R12：画面と項目を持つ fixed-test */
  const LIST_D = {
    ...LIST,
    requirements: [
      ...LIST.requirements,
      text("R9", "項目の担当者は担当者を指し、登録の操作があり、項目の一覧に題名が出る。"),
      text("R10", "担当者の一覧と項目の一覧の画面がある。"),
      text("R11", "項目を持てる。"),
      text("R12", "項目の一覧で題名を見られる。"),
    ],
  };
  const TABLE_D: NameTable = withCheckTargets({
    ...TABLE,
    ownership: [
      ...TABLE.ownership,
      { requirementId: "R9", roles: ["f.item.owner", "o.addItem", "s.items", "f.item.title"].map(stated) },
      { requirementId: "R10", roles: ["s.members", "s.items"].map(stated) },
      { requirementId: "R11", roles: ["e.item"].map(stated) },
      { requirementId: "R12", roles: ["s.items", "f.item.title"].map(stated) },
    ],
    verification: [
      ...TABLE.verification,
      { requirementId: "R9", kind: "structural", reason: "宣言の構造だけを求める", checks: ["field-type", "action-kind", "view-shows"] },
      { requirementId: "R10", kind: "fixed-test" },
      { requirementId: "R11", kind: "fixed-test" },
      { requirementId: "R12", kind: "fixed-test" },
    ],
    classification: [
      ...TABLE.classification,
      { requirementId: "R9", nature: "existence-only" },
      { requirementId: "R10", nature: "existence-only" },
      { requirementId: "R11", nature: "existence-only" },
      { requirementId: "R12", nature: "ruled" },
    ],
  });
  const generateD = (table: NameTable = TABLE_D) => generateTests({ table, ledger, list: LIST_D });
  const ofRequirement = (made: ReturnType<typeof generateD>, requirementId: string) =>
    made.tests.filter((test) => test.target.requirementId === requirementId).map((test) => ({ test, observed: made.observes.get(test.id) }));

  it("純粋：同じ表・台帳・一覧から 2 回同じ組（止めた要件は無い）。試験 ID は接頭辞で始まり一意", () => {
    const first = generateD();
    const second = generateD();
    expect(second.tests).toEqual(first.tests);
    expect([...second.observes]).toEqual([...first.observes]);
    expect(second.excludedRequirementIds).toEqual(first.excludedRequirementIds);
    expect(first.stopped).toEqual([]);
    expect(first.tests.every((test) => isGeneratedTestId(test.id))).toBe(true);
    expect(new Set(first.tests.map((test) => test.id)).size).toBe(first.tests.length);
    // 構造の要件（R2・R9）は試験を全部コードが作るので除く（T2 の一覧に無い）
    expect(first.excludedRequirementIds).toEqual(["R2", "R6", "R7", "R9"]);
  });

  it("checks 3 つの構造の要件に 3 本：field-type の参照は項目の種類と参照先 entity、action-kind は操作の種類、view-shows は元の行 ID。operation structure・kind normal・期待 ok true・入力空・参照データ空・入力の契約は固定", () => {
    const made = ofRequirement(generateD(), "R9");
    expect(made.map(({ test, observed }) => [test.target, test.assertion, observed])).toEqual([
      [{ requirementId: "R9", kind: "field", roleId: "f.item.owner" }, { check: "field-type", expected: "ref", refEntity: "e.member" }, "existence"],
      [{ requirementId: "R9", kind: "operation", roleId: "o.addItem" }, { check: "action-kind", expected: "create" }, "existence"],
      [{ requirementId: "R9", kind: "screen", roleId: "s.items" }, { check: "view-shows", role: "f.item.owner" }, "view-structure"],
    ]);
    for (const { test } of made) {
      expect(test.operation).toBe("structure");
      expect(test.kind).toBe("normal");
      expect(test.expected).toEqual({ kind: "ok", value: true });
      expect(test.input).toEqual({});
      expect(test.referenceData).toEqual([]);
      expect(test.clock).toBe(GENERATED_TEST_CLOCK);
      expect(test.inputContract).toEqual({ rowId: GENERATED_TEST_ROW_ID, targetRowId: null, emptyEntities: [] });
    }
    // 検査の中身ごとの観測する性質は T2' の対応表と同じ
    expect(GENERATED_STRUCTURE_OBSERVES).toEqual(STRUCTURE_OBSERVES);
  });

  it("ほかの検査（action-unconditioned など）の assertion は中身だけ（期待・参照先・元の行は持たない）。field-type の参照でない項目は参照先を持たない", () => {
    const table = withCheckTargets({
      ...TABLE_D,
      verification: TABLE_D.verification.map((entry) =>
        entry.requirementId === "R9" ? { requirementId: "R9", kind: "structural" as const, reason: "宣言の構造だけ", checks: ["action-unconditioned" as const] } : entry,
      ),
    });
    expect(ofRequirement(generateD(table), "R9").map(({ test }) => test.assertion)).toEqual([{ check: "action-unconditioned" }]);
    const plainField = withCheckTargets({
      ...TABLE_D,
      ownership: TABLE_D.ownership.map((entry) => (entry.requirementId === "R9" ? { ...entry, roles: [stated("f.item.amount")] } : entry)),
      verification: TABLE_D.verification.map((entry) =>
        entry.requirementId === "R9" ? { requirementId: "R9", kind: "structural" as const, reason: "宣言の構造だけ", checks: ["field-type" as const] } : entry,
      ),
    });
    expect(ofRequirement(generateD(plainField), "R9").map(({ test }) => test.assertion)).toEqual([{ check: "field-type", expected: "number" }]);
  });

  it("画面 2 行の fixed-test の要件に screen × screen 2 本、画面が無く entity 1 行の要件に entity × screen 1 本、画面と項目を持つ要件には画面の 1 本だけ（項目には作らない）", () => {
    const made = generateD();
    const shape = (requirementId: string) =>
      ofRequirement(made, requirementId).map(({ test, observed }) => [test.target.kind, test.target.roleId, test.operation, test.kind, observed, test.expected]);
    expect(shape("R10")).toEqual([
      ["screen", "s.members", "screen", "normal", "view-structure", { kind: "ok", value: true }],
      ["screen", "s.items", "screen", "normal", "view-structure", { kind: "ok", value: true }],
    ]);
    expect(shape("R11")).toEqual([["entity", "e.item", "screen", "normal", "existence", { kind: "ok", value: true }]]);
    expect(shape("R12")).toEqual([["screen", "s.items", "screen", "normal", "view-structure", { kind: "ok", value: true }]]);
    for (const { test } of ofRequirement(made, "R10")) {
      expect(test.input).toEqual({});
      expect(test.referenceData).toEqual([]);
      expect(test.assertion).toBeUndefined();
    }
    // fixed-test の要件は除かない（種類の分類は LLM が独立に行う）
    for (const id of ["R10", "R11", "R12"]) expect(made.excludedRequirementIds).not.toContain(id);
  });

  it("持ち越しの要件（一覧と表から除いた要件）には作らない", () => {
    const list = { ...LIST_D, requirements: LIST_D.requirements.filter((requirement) => requirement.id !== "R9" && requirement.id !== "R10") };
    const made = generateTests({ table: TABLE_D, ledger, list });
    expect(made.tests.some((test) => test.target.requirementId === "R9" || test.target.requirementId === "R10")).toBe(false);
  });

  it("fail-closed：対象の行が表に無い checks・種類の合わない checks・対象の無い確かめ方は作らず、その要件を固定文で止める（近い行に結び付けない。ほかの要件は作る）", () => {
    const withTargets = (targets: readonly { check: "field-type" | "action-kind" | "view-shows"; targetId: string; sourceId: string | null }[]): NameTable => ({
      ...TABLE_D,
      verification: TABLE_D.verification.map((entry) => (entry.requirementId === "R9" && entry.kind === "structural" ? { ...entry, targets } : entry)),
    });
    const r9Index = LIST_D.requirements.findIndex((requirement) => requirement.id === "R9");
    const cases: readonly [NameTable, string][] = [
      [withTargets([{ check: "field-type", targetId: "f.item.ownerx", sourceId: null }, { check: "action-kind", targetId: "o.addItem", sourceId: null }, { check: "view-shows", targetId: "s.items", sourceId: "f.item.title" }]), GENERATED_STRUCTURE_STOP_MESSAGES.unknownRow],
      [withTargets([{ check: "field-type", targetId: "f.item.owner", sourceId: null }, { check: "action-kind", targetId: "o.addItem", sourceId: null }, { check: "view-shows", targetId: "s.items", sourceId: "f.item.titlex" }]), GENERATED_STRUCTURE_STOP_MESSAGES.unknownRow],
      [withTargets([{ check: "field-type", targetId: "o.addItem", sourceId: null }, { check: "action-kind", targetId: "o.addItem", sourceId: null }, { check: "view-shows", targetId: "s.items", sourceId: "f.item.title" }]), GENERATED_STRUCTURE_STOP_MESSAGES.rowKind],
      [withTargets([{ check: "field-type", targetId: "f.item.owner", sourceId: null }]), GENERATED_STRUCTURE_STOP_MESSAGES.targets],
      [{ ...TABLE_D, verification: TABLE_D.verification.map((entry) => (entry.requirementId === "R9" && entry.kind === "structural" ? { requirementId: "R9", kind: "structural" as const, reason: entry.reason, checks: entry.checks } : entry)) }, GENERATED_STRUCTURE_STOP_MESSAGES.targets],
    ];
    for (const [table, message] of cases) {
      const made = generateD(table);
      expect(made.stopped, message).toEqual([{ field: `requirements[${String(r9Index)}]`, message }]);
      expect(made.tests.some((test) => test.target.requirementId === "R9"), message).toBe(false);
      expect(made.excludedRequirementIds, message).not.toContain("R9");
      // 近い行（f.item.owner・f.item.title）に結び付けた試験は無い
      expect(made.tests.some((test) => test.assertion?.check === "field-type" && test.target.requirementId === "R9")).toBe(false);
      // ほかの要件は作る
      expect(made.tests.some((test) => test.target.requirementId === "R10")).toBe(true);
    }
    for (const text of Object.values(GENERATED_STRUCTURE_STOP_MESSAGES)) {
      expect(text).not.toMatch(/R\d/);
      for (const word of ACCEPTANCE_MATERIAL_WORDS) expect(text).not.toContain(word);
    }
  });

  it("免除の対象（所属の行がすべて画面・entity の行）は台帳の型と所属で決める：R10・R11 は対象、R12（項目あり）・R4（計算あり）は対象でない。作った試験を消しても対象は変わらない", () => {
    expect(normalOnlyOwnershipRequirementIds(TABLE_D, ledger, LIST_D)).toEqual(["R10", "R11"]);
    const noScreens = { ...ledger, ownershipRows: [] };
    expect(normalOnlyOwnershipRequirementIds(TABLE_D, noScreens, LIST_D)).toEqual([]);
  });

  it("混在の回帰（R1）：既定値・選択肢の集合・構造・画面を持つ fixed-test・集計を持つ fixed-test の要件を 1 表に入れると、要件ごとの作る試験が優先の順どおりで、合併した組に台帳の型の全試験の検査・集計・評価可能性・重なりの検査を掛けて問題 0", () => {
    const made = generateD();
    const operationsOf = (requirementId: string) => ofRequirement(made, requirementId).map(({ test, observed }) => `${test.operation}:${observed ?? ""}`);
    // 既定値・選択肢の集合：専用の 1 本だけ（画面・在ることは無い。所属の項目の entity が表の所属にあっても足さない）
    expect(operationsOf("R6")).toEqual(["validate:default-value"]);
    expect(operationsOf("R7")).toEqual(["validate:enum-membership"]);
    // 構造：構造の検査だけ（R2・R9 は画面を所属させるが、画面の試験は無い）
    expect(operationsOf("R2")).toEqual(["structure:view-structure"]);
    expect(operationsOf("R9").every((entry) => entry.startsWith("structure:"))).toBe(true);
    // 集計を持つ fixed-test（R4）：画面と空の集計の両方
    expect(operationsOf("R4")).toEqual([
      "screen:view-structure",
      "aggregate:empty-aggregate",
      "aggregate:empty-aggregate",
      "aggregate:empty-aggregate",
      "aggregate:empty-aggregate",
    ]);
    // 合併した組の検査
    const suite = { tests: made.tests };
    const observes = made.observes as ReadonlyMap<string, TestObserves>;
    const quoted = new Set(made.tests.map((test) => test.id));
    expect(checkLedgerTests(suite, observes, ledgerTargetsOf(TABLE_D, ledger), quoted)).toEqual([]);
    expect(checkAggregateTests(suite, observes, TABLE_D, ledger)).toEqual([]);
    expect(checkEvaluabilityByLedger(suite, observes, TABLE_D, ledger)).toEqual([]);
    expect(checkGeneratedOverlap({ tests: [] }, new Map(), made, TABLE_D, ledger)).toEqual([]);
  });

  it("負例：既定値の要件に entity × screen を足した組は、台帳の型の全試験の検査（操作・対象・性質・期待の 4 件）で落ちる。生成器はそれを作らない", () => {
    const made = generateD();
    expect(made.tests.some((test) => test.target.requirementId === "R6" && test.operation === "screen")).toBe(false);
    const extra: FixedTest = {
      id: "gen:existence:R6:e.item:normal",
      target: { requirementId: "R6", kind: "entity", roleId: "e.item" },
      kind: "normal",
      operation: "screen",
      clock: GENERATED_TEST_CLOCK,
      input: {},
      inputContract: { rowId: GENERATED_TEST_ROW_ID, targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: true },
    };
    const tests = [...made.tests, extra];
    const observes = new Map([...made.observes, [extra.id, "existence"]]) as ReadonlyMap<string, TestObserves>;
    const index = tests.length - 1;
    expect(checkLedgerTests({ tests }, observes, ledgerTargetsOf(TABLE_D, ledger), new Set(tests.map((test) => test.id)))).toEqual([
      { field: `tests[${String(index)}].operation`, message: rowOf("default-value").t2?.messages.operation },
      { field: `tests[${String(index)}].target`, message: rowOf("default-value").t2?.messages.target },
      { field: `tests[${String(index)}].observes`, message: rowOf("default-value").t2?.messages.observes },
      { field: `tests[${String(index)}].expected`, message: rowOf("default-value").t2?.messages.expected },
    ]);
  });

  it("重なりの検査：LLM の組に operation が structure か screen の試験があれば固定文で落ちる（構造の検査と画面の試験はコードが作る）", () => {
    const made = generateD();
    const base = {
      kind: "normal" as const,
      clock: "2026-09-16T12:00:00+09:00",
      input: {},
      inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok" as const, value: true },
    };
    const tests: FixedTest[] = [
      { ...base, id: "s1", target: { requirementId: "R12", kind: "screen", roleId: "s.items" }, operation: "screen" },
      { ...base, id: "s2", target: { requirementId: "R12", kind: "field", roleId: "f.item.title" }, operation: "screen" },
      { ...base, id: "s3", target: { requirementId: "R12", kind: "screen", roleId: "s.items" }, operation: "structure", assertion: { check: "view-shows", role: "f.item.title" } },
      { ...base, id: "s4", target: { requirementId: "R12", kind: "field", roleId: "f.item.title" }, operation: "validate" },
    ];
    const observes = new Map([["s1", "view-structure"], ["s2", "view-structure"], ["s3", "view-structure"], ["s4", "validation"]]);
    expect(checkGeneratedOverlap({ tests }, observes, made, TABLE_D, ledger)).toEqual([
      { field: "tests[0].operation", message: OWNERSHIP_STRUCTURE_NOT_ALLOWED },
      { field: "tests[1].operation", message: OWNERSHIP_STRUCTURE_NOT_ALLOWED },
      { field: "tests[2].operation", message: OWNERSHIP_STRUCTURE_NOT_ALLOWED },
    ]);
  });
});
