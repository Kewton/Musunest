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
//   7. 手 3h（#652）：画面も entity も無く所属の行がすべて項目の行の fixed-test の要件に、項目の行ごとに 項目 × screen を 1 本（要件の
//      種類に依らない。導いた親 entity・操作や計算の混じる要件・持ち越しの要件には作らない。免除は広げない）
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
  emptyAggregateCodeTestsOf,
  generateTests,
  isGeneratedTestId,
  ledgerTargetsOf,
  normalOnlyOwnershipRequirementIds,
} from "./generated-tests.js";
import { OWNERSHIP_STRUCTURE_NOT_ALLOWED, PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, deriveLedgerView } from "./ledger.js";

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

describe("手 3h：所属が項目の行だけの fixed-test の要件に 項目 × screen をコードが作る（台帳の view-structure の代わりの対象の種類。Issue #652）", () => {
  const text = (id: string, body: string) => ({ id, text: body, quote: body, position: { start: 0, end: body.length } });
  const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });
  /**
   * R9：項目 2 行だけ（在ることだけ）、R10：項目と画面、R11：項目と entity、R12：項目と操作、R13：項目と計算、R14：項目 1 行だけ（ruled）。
   * 項目の所属 entity（e.item）は表の所属に無い（導いた親 entity）
   */
  const ADDED = [
    ["R9", "項目に題名と金額がある。", ["f.item.title", "f.item.amount"], "existence-only"],
    ["R10", "項目の一覧に題名がある。", ["f.item.title", "s.items"], "existence-only"],
    ["R11", "項目に日付がある。", ["f.item.day", "e.item"], "existence-only"],
    ["R12", "項目の担当者を締められる。", ["f.item.owner", "o.closeItem"], "existence-only"],
    ["R13", "項目の金額から率を見られる。", ["f.item.amount", "c.rate"], "existence-only"],
    ["R14", "項目の種類は決まった値だけをとる。", ["f.item.kind"], "ruled"],
  ] as const;
  const LIST_H = { ...LIST, requirements: [...LIST.requirements, ...ADDED.map(([id, body]) => text(id, body))] };
  const TABLE_H: NameTable = withCheckTargets({
    ...TABLE,
    ownership: [...TABLE.ownership, ...ADDED.map(([id, , roles]) => ({ requirementId: id, roles: roles.map(stated) }))],
    verification: [...TABLE.verification, ...ADDED.map(([id]) => ({ requirementId: id, kind: "fixed-test" as const }))],
    classification: [...TABLE.classification, ...ADDED.map(([id, , , nature]) => ({ requirementId: id, nature }))],
  });
  const generateH = (table: NameTable = TABLE_H, list = LIST_H) => generateTests({ table, ledger, list });
  const shapeOf = (made: ReturnType<typeof generateH>, requirementId: string) =>
    made.tests
      .filter((test) => test.target.requirementId === requirementId)
      .map((test) => [test.target.kind, test.target.roleId, test.operation, test.kind, made.observes.get(test.id)]);

  it("台帳：view-structure の代わりの対象の種類は項目（why・since つき）で、組ごとの対象の種類・免除の種類（画面・entity）は変わらない。existence には無い", () => {
    const view = rowOf("view-structure").t2;
    expect(view?.targetKinds).toEqual(["screen"]);
    expect(view?.fallback?.targetKinds).toEqual(["field"]);
    expect(view?.fallback?.since).toBe("Issue #652");
    expect(view?.fallback?.why).toContain("親 entity の在ることで代用しない");
    expect(rowOf("existence").t2?.fallback).toBeNull();
    expect(rowOf("default-value").t2?.fallback).toBeNull();
    expect(rowOf("enum-membership").t2?.fallback).toBeNull();
  });

  it("(1) 項目 2 行だけの fixed-test の要件に 項目 × screen 2 本：observes view-structure・normal・期待 ok の定数・入力空・参照空・時計と固定の行 ID は定数・ID は接頭辞で一意", () => {
    const made = generateH();
    expect(shapeOf(made, "R9")).toEqual([
      ["field", "f.item.title", "screen", "normal", "view-structure"],
      ["field", "f.item.amount", "screen", "normal", "view-structure"],
    ]);
    const tests = made.tests.filter((test) => test.target.requirementId === "R9");
    expect(tests.map((test) => test.id)).toEqual([
      `${GENERATED_TEST_ID_PREFIX}view-structure:R9:f.item.title:normal`,
      `${GENERATED_TEST_ID_PREFIX}view-structure:R9:f.item.amount:normal`,
    ]);
    for (const test of tests) {
      expect(test.expected).toEqual({ kind: "ok", value: true });
      expect(test.input).toEqual({});
      expect(test.referenceData).toEqual([]);
      expect(test.clock).toBe(GENERATED_TEST_CLOCK);
      expect(test.inputContract).toEqual({ rowId: GENERATED_TEST_ROW_ID, targetRowId: null, emptyEntities: [] });
      expect(test.assertion).toBeUndefined();
    }
    expect(new Set(made.tests.map((test) => test.id)).size).toBe(made.tests.length);
    // fixed-test の要件は除かない（分類は LLM が独立に書く）
    expect(made.excludedRequirementIds).not.toContain("R9");
    expect(made.stopped).toEqual([]);
  });

  it("(2) 項目＋画面は画面の 1 本だけ、項目＋entity は entity の 1 本だけ、項目＋操作・項目＋計算は項目の分を作らない（今までどおり）", () => {
    const made = generateH();
    expect(shapeOf(made, "R10")).toEqual([["screen", "s.items", "screen", "normal", "view-structure"]]);
    expect(shapeOf(made, "R11")).toEqual([["entity", "e.item", "screen", "normal", "existence"]]);
    expect(shapeOf(made, "R12")).toEqual([]);
    expect(shapeOf(made, "R13")).toEqual([]);
  });

  it("(3) 表の所属に entity の行が無い要件には entity × screen が出ない（導いた親 entity を対象にしない）", () => {
    const made = generateH();
    for (const id of ["R9", "R14"]) {
      expect(made.tests.some((test) => test.target.requirementId === id && test.target.kind === "entity"), id).toBe(false);
    }
  });

  it("(4) 要件の種類（ruled・existence-only）に依らず同じ組（R14 は ruled の項目 1 行だけ。分類を入れ替えても同じ）", () => {
    const made = generateH();
    expect(shapeOf(made, "R14")).toEqual([["field", "f.item.kind", "screen", "normal", "view-structure"]]);
    const flipped: NameTable = {
      ...TABLE_H,
      classification: TABLE_H.classification.map((entry) =>
        entry.requirementId === "R9" || entry.requirementId === "R14"
          ? { ...entry, nature: entry.nature === "ruled" ? ("existence-only" as const) : ("ruled" as const) }
          : entry,
      ),
    };
    const again = generateH(flipped);
    for (const id of ["R9", "R14"]) expect(shapeOf(again, id), id).toEqual(shapeOf(made, id));
  });

  it("(5) 持ち越しの要件（一覧と表から除いた要件）には作らない。同じ入力から 2 回同じ組", () => {
    const list = { ...LIST_H, requirements: LIST_H.requirements.filter((requirement) => requirement.id !== "R9") };
    expect(generateH(TABLE_H, list).tests.some((test) => test.target.requirementId === "R9")).toBe(false);
    const first = generateH();
    const second = generateH();
    expect(second.tests).toEqual(first.tests);
    expect([...second.observes]).toEqual([...first.observes]);
    expect(second.excludedRequirementIds).toEqual(first.excludedRequirementIds);
  });

  it("所属の行に表に無い行が混じる要件には作らない（すべてが項目の行であることを求める＝fail-closed）", () => {
    const table: NameTable = {
      ...TABLE_H,
      ownership: TABLE_H.ownership.map((entry) => (entry.requirementId === "R14" ? { ...entry, roles: [...entry.roles, stated("f.item.nosuch")] } : entry)),
    };
    expect(shapeOf(generateH(table), "R14")).toEqual([]);
  });

  it("免除は広がらない：項目だけの要件（R9・R14）は免除の対象でない（台帳の型の組ごとの対象の種類＝画面・entity のまま）", () => {
    const exempt = normalOnlyOwnershipRequirementIds(TABLE_H, ledger, LIST_H);
    expect(exempt).not.toContain("R9");
    expect(exempt).not.toContain("R14");
  });

  it("二点測定：代わりの対象の種類を外した台帳（#651 まで）では、項目だけの要件に何も作らない", () => {
    const before = deriveLedgerView(PROPERTY_LEDGER.map((row) => (row.t2?.fallback == null ? row : { ...row, t2: { ...row.t2, fallback: null } })));
    const made = generateTests({ table: TABLE_H, ledger: before, list: LIST_H });
    expect(shapeOf(made, "R9")).toEqual([]);
    expect(shapeOf(made, "R14")).toEqual([]);
    // ほかの要件の組は変わらない
    const now = generateH();
    for (const id of ["R10", "R11", "R12", "R13", "R4", "R6", "R7"]) expect(shapeOf(made, id), id).toEqual(shapeOf(now, id));
  });

  it("混在の回帰（#624 R1）：既定値・選択肢の集合・構造・画面・項目だけ・集計の要件を 1 表に入れると、要件ごとの作る試験が優先の順どおりで、合併した組に台帳の型の全試験の検査・集計・評価可能性・重なりの検査を掛けて問題 0", () => {
    const table = TABLE_H;
    const made = generateH(table);
    const operationsOf = (requirementId: string) =>
      made.tests.filter((test) => test.target.requirementId === requirementId).map((test) => `${test.target.kind}:${test.operation}:${made.observes.get(test.id) ?? ""}`);
    // 既定値・選択肢の集合：専用の 1 本だけ（項目の在ることは足さない）
    expect(operationsOf("R6")).toEqual(["field:validate:default-value"]);
    expect(operationsOf("R7")).toEqual(["field:validate:enum-membership"]);
    // 構造：構造の検査だけ（所属の項目の分は足さない）
    expect(operationsOf("R2")).toEqual(["screen:structure:view-structure"]);
    // 画面を持つ集計の要件：画面と空の集計
    expect(operationsOf("R4")[0]).toBe("screen:screen:view-structure");
    expect(operationsOf("R4").slice(1).every((entry) => entry === "computation:aggregate:empty-aggregate")).toBe(true);
    // 項目だけ：項目 × screen
    expect(operationsOf("R9")).toEqual(["field:screen:view-structure", "field:screen:view-structure"]);
    expect(operationsOf("R14")).toEqual(["field:screen:view-structure"]);
    const suite = { tests: made.tests };
    const observes = made.observes as ReadonlyMap<string, TestObserves>;
    const quoted = new Set(made.tests.map((test) => test.id));
    expect(checkLedgerTests(suite, observes, ledgerTargetsOf(table, ledger), quoted)).toEqual([]);
    expect(checkAggregateTests(suite, observes, table, ledger)).toEqual([]);
    expect(checkEvaluabilityByLedger(suite, observes, table, ledger)).toEqual([]);
    expect(checkGeneratedOverlap({ tests: [] }, new Map(), made, table, ledger)).toEqual([]);
  });

  it("負例 (c)：LLM の組に 項目 × screen の試験があれば固定文で落ちる（構造の検査と画面の試験はコードが作る）", () => {
    const made = generateH();
    const llm: FixedTest = {
      id: "f1",
      target: { requirementId: "R9", kind: "field", roleId: "f.item.title" },
      kind: "normal",
      operation: "screen",
      clock: "2026-09-16T12:00:00+09:00",
      input: {},
      inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: true },
    };
    expect(checkGeneratedOverlap({ tests: [llm] }, new Map([["f1", "view-structure"]]), made, TABLE_H, ledger)).toEqual([
      { field: "tests[0].operation", message: OWNERSHIP_STRUCTURE_NOT_ALLOWED },
    ]);
  });
});

describe("空の集計のコードの試験の計画（emptyAggregateCodeTestsOf。必要な試験の枠と生成が同じ関数で引く。Issue #653）", () => {
  it("表の分類が ruled の要件では generateTests の空の集計の試験と同じ組・同じ順。分類を見ないので existence-only の要件でも同じ計画を返す（生成は作らない）", () => {
    const made = generate();
    const aggregateIds = new Set(ledger.aggregateRows.map((row) => row.id));
    const roles = new Map(TABLE.ownership.map((entry) => [entry.requirementId, entry.roles] as const));
    const planned = LIST.requirements.flatMap((requirement) =>
      TABLE.verification.find((entry) => entry.requirementId === requirement.id)?.kind === "fixed-test" &&
      TABLE.classification.find((entry) => entry.requirementId === requirement.id)?.nature === "ruled"
        ? emptyAggregateCodeTestsOf(requirement.id, roles.get(requirement.id) ?? [], aggregateTargetsOf(TABLE), ledger)
        : [],
    );
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.map((entry) => entry.test)).toEqual(made.tests.filter((test) => aggregateIds.has(made.observes.get(test.id) ?? "")));
    expect(planned.map((entry) => entry.observed)).toEqual(planned.map(() => "empty-aggregate"));
    expect(planned.map((entry) => [entry.test.kind, entry.state])).toEqual(planned.map((entry) => (entry.state === "empty" ? ["boundary", "empty"] : ["abnormal", "unread"])));
    const existence: NameTable = { ...TABLE, classification: TABLE.classification.map((entry) => ({ ...entry, nature: "existence-only" as const })) };
    const notMade = generate(existence);
    expect(notMade.tests.some((test) => aggregateIds.has(notMade.observes.get(test.id) ?? ""))).toBe(false);
    const [first] = planned;
    if (first === undefined) throw new Error("前提が壊れた");
    expect(emptyAggregateCodeTestsOf(first.test.target.requirementId, roles.get(first.test.target.requirementId) ?? [], aggregateTargetsOf(existence), ledger).length).toBeGreaterThan(0);
  });
});
