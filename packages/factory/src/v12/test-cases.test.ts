// T2 の場合の形と展開の試験（v1.2 手 3e・Issue #625）。題材は v1.1α の共通の題材（担当者と項目の抽象的な題材）と、
// 大きさの生成器の抽象的な題材だけを使う。LLM は呼ばない（展開は純粋な関数。評価は偽物の宣言で B4 を流す）。
import { describe, expect, it } from "vitest";
import type { TestSuite } from "../fixed-test.js";
import type { RequirementList } from "../pipeline.js";
import { validateSchema } from "../schema-check.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import { FIXTURE_YAML, casesResponseOf, fixtureList, fixtureTable, strictDefects, withAggregates, withoutIdAndClock } from "../v11a/__tests__/fixtures.js";
import { buildSized, MEDIAN_SIZE } from "../v11a/__tests__/sizes.js";
import { correspondenceFromTable } from "../v11a/bind-by-id.js";
import { toV1 } from "../v11a/convert.js";
import { coverageUnitsOf } from "../v11a/coverage.js";
import { createV11aEvaluator } from "../v11a/evaluate.js";
import type { NameTable } from "../v11a/names.js";
import { checkEvaluabilityByLedger, checkTestSpecOutput, type TestObserves } from "../v11a/stages/test-spec.js";
import { PROPERTY_LEDGER_VIEW } from "./ledger.js";
import {
  TEST_CASE_CLOCK,
  TEST_CASE_EXPAND_MESSAGES,
  TEST_CASE_ID_PREFIX,
  TEST_CASE_SHAPE_MESSAGES,
  TEST_CASE_BUNDLE_MESSAGES,
  attributeProblemsToBundles,
  bundleRequirementIds,
  caseOperationOf,
  checkBundleCompleteness,
  mergeBundleCases,
  checkTestCasesOutput,
  expandTestCases,
  testCasesSchemaOf,
  toCasePositions,
  type TestCase,
  type TestCasesOutput,
} from "./test-cases.js";

const LEDGER = PROPERTY_LEDGER_VIEW;
/** 題材の表（計算の行に集計の種類と集計元。旗 on の走りの表） */
const TABLE: NameTable = withAggregates(fixtureTable());

/** 場合 1 つ（既定は R1 の金額の検査の正常） */
const caseOf = (patch: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  requirementId: "R1",
  targetId: "f.item.amount",
  kind: "normal",
  observes: "validation",
  input: { rowId: "row-1", values: JSON.stringify({ "f.item.amount": 5 }) },
  targetRowId: null,
  rows: [],
  expected: { kind: "ok", value: "true" },
  emptyEntities: [],
  ...patch,
});

/** 形の検査を通した場合の応答（通らなければ前提が壊れた） */
function shaped(cases: readonly unknown[], classifications: readonly unknown[] = []): TestCasesOutput {
  const checked = checkTestCasesOutput({ classifications, cases }, LEDGER);
  if (!checked.ok) throw new Error(`前提が壊れた：形に落ちた ${JSON.stringify(checked.problems)}`);
  return checked.value;
}

/** 展開して今の形の検査を掛けた組（通らなければ前提が壊れた） */
function expandedSuite(cases: readonly unknown[], table: NameTable = TABLE) {
  const expanded = expandTestCases(shaped(cases), table);
  if (!expanded.ok) throw new Error(`前提が壊れた：展開に落ちた ${JSON.stringify(expanded.problems)}`);
  const checked = checkTestSpecOutput(expanded.output, LEDGER);
  if (!checked.ok) throw new Error(`前提が壊れた：今の形に落ちた ${JSON.stringify(checked.problems)}`);
  return { ...checked.value, raw: expanded.output };
}

/** v1 の形（②' の raw）で書いた同じ試験を、今の形の検査で読む */
function v1Suite(tests: readonly Record<string, unknown>[]) {
  const checked = checkTestSpecOutput({ classifications: [], tests }, LEDGER);
  if (!checked.ok) throw new Error(`前提が壊れた：v1 の形に落ちた ${JSON.stringify(checked.problems)}`);
  return checked.value;
}

/** v1 の形の raw の試験 1 件 */
const v1Test = (patch: Readonly<Record<string, unknown>>): Record<string, unknown> => ({
  id: "v1-1",
  target: { requirementId: "R1", kind: "field", roleId: "f.item.amount" },
  kind: "normal",
  operation: "validate",
  clock: "2026-09-16T12:00:00+09:00",
  input: "{}",
  inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
  referenceData: [],
  expected: { kind: "ok", value: "true", code: null },
  assertion: null,
  observes: "validation",
  ...patch,
});

describe("場合の schema（旗 v12.ids の T2。Issue #625）", () => {
  it("strict の規則を満たし、骨組みの欄（id・operation・clock・assertion・target・inputContract・referenceData）を持たない。observes の enum は台帳の順", () => {
    const schema = testCasesSchemaOf(LEDGER);
    expect(strictDefects(schema)).toEqual([]);
    expect(schema.required).toEqual(["classifications", "cases"]);
    const items = schema.properties.cases.items;
    expect(items.required).toEqual(["requirementId", "targetId", "kind", "observes", "input", "targetRowId", "rows", "expected", "emptyEntities"]);
    expect(Object.keys(items.properties)).toEqual(items.required);
    for (const key of ["id", "operation", "clock", "assertion", "target", "inputContract", "referenceData"]) expect(Object.keys(items.properties), key).not.toContain(key);
    expect(items.properties.observes.enum).toEqual([...LEDGER.observes]);
    // 期待は kind ごとの形の anyOf（ok は value・error は code。null の欄が無い）
    expect(items.properties.expected.anyOf.map((branch) => branch.required)).toEqual([
      ["kind", "value"],
      ["kind", "code"],
    ]);
    expectNoAcceptanceMaterial([JSON.stringify(schema), JSON.stringify(TEST_CASE_EXPAND_MESSAGES), JSON.stringify(TEST_CASE_SHAPE_MESSAGES)]);
  });

  it("形の検査：型の合わない欄を場合の添字と欄名の固定文で落とす（参照の行の値は写像の JSON 文字列であること。v1 の形の検査と同じ）", () => {
    const bad = checkTestCasesOutput(
      {
        classifications: [],
        cases: [
          caseOf({ targetId: "" }),
          caseOf({ rows: [{ rowId: "r1", entityId: "e.item", values: "[1]" }] }),
          caseOf({ expected: { kind: "maybe" } }),
          caseOf({ observes: "unknown" }),
        ],
      },
      LEDGER,
    );
    if (bad.ok) throw new Error("落ちるはず");
    expect(bad.problems).toEqual([
      { field: "cases[0].targetId", message: TEST_CASE_SHAPE_MESSAGES.targetId },
      { field: "cases[1].rows[0].values", message: TEST_CASE_SHAPE_MESSAGES.rowValues },
      { field: "cases[2].expected", message: TEST_CASE_SHAPE_MESSAGES.expected },
      { field: "cases[3].observes", message: `観測する性質は ${LEDGER.observes.join("・")} のいずれかであること` },
    ]);
    const notArray = checkTestCasesOutput({ classifications: [], tests: [] }, LEDGER);
    expect(notArray).toEqual({ ok: false, problems: [{ field: "cases", message: TEST_CASE_SHAPE_MESSAGES.cases }] });
  });

  it("負例（#624 (2) の structure の負例の置き換え）：場合の形の応答に structure を書いたら schema の照合で落ちる（操作・assertion の欄が無く、observes に structure は無い）", () => {
    const schema = testCasesSchemaOf(LEDGER);
    expect(validateSchema(schema, { classifications: [], cases: [caseOf()] })).toBeUndefined();
    const withOperation = { classifications: [], cases: [{ ...caseOf(), operation: "structure" }] };
    expect(validateSchema(schema, withOperation)).toBeDefined();
    const withAssertion = { classifications: [], cases: [{ ...caseOf(), assertion: { check: "view-shows" } }] };
    expect(validateSchema(schema, withAssertion)).toBeDefined();
    const structureObserves = { classifications: [], cases: [caseOf({ observes: "structure" })] };
    expect(LEDGER.observes as readonly string[]).not.toContain("structure");
    expect(validateSchema(schema, structureObserves)).toBeDefined();
  });
});

describe("展開（純粋。場合 → 今の試験の形。Issue #625）", () => {
  it("同じ場合から 2 回同じ組。試験 ID は case: と連番、時計は定数、assertion は null、期待の null の欄を補う", () => {
    const cases = [caseOf(), caseOf({ kind: "abnormal", expected: { kind: "error", code: "E_INVALID" } })];
    const first = expandTestCases(shaped(cases), TABLE);
    const second = expandTestCases(shaped(cases), TABLE);
    expect(first).toEqual(second);
    if (!first.ok) throw new Error("通るはず");
    expect(first.output.tests.map((test) => test["id"])).toEqual([`${TEST_CASE_ID_PREFIX}1`, `${TEST_CASE_ID_PREFIX}2`]);
    expect(first.output.tests.map((test) => test["clock"])).toEqual([TEST_CASE_CLOCK, TEST_CASE_CLOCK]);
    expect(first.output.tests.map((test) => test["assertion"])).toEqual([null, null]);
    expect(first.output.tests.map((test) => test["expected"])).toEqual([
      { kind: "ok", value: "true", code: null },
      { kind: "error", value: null, code: "E_INVALID" },
    ]);
    expect([...first.caseIndexById]).toEqual([
      [`${TEST_CASE_ID_PREFIX}1`, 0],
      [`${TEST_CASE_ID_PREFIX}2`, 1],
    ]);
  });

  it("操作は対象の行の種類から決まる：計算は種別 aggregate なら aggregate・ほかは compute、項目と entity は validate、操作は action", () => {
    const rowById = new Map(TABLE.rows.map((row) => [row.id, row] as const));
    const operationOf = (id: string) => {
      const row = rowById.get(id);
      if (row === undefined) throw new Error("前提が壊れた：行が無い");
      return caseOperationOf(row);
    };
    expect(operationOf("c.itemCount")).toBe("aggregate");
    expect(operationOf("c.byKind")).toBe("aggregate");
    expect(operationOf("c.rate")).toBe("compute");
    expect(operationOf("f.item.amount")).toBe("validate");
    expect(operationOf("e.item")).toBe("validate");
    expect(operationOf("o.closeItem")).toBe("action");
    const { suite } = expandedSuite([
      caseOf({ requirementId: "R4", targetId: "c.rate", observes: "value", input: { rowId: "row-1", values: "{}" }, expected: { kind: "ok", value: "6" } }),
      caseOf({ requirementId: "R3", targetId: "o.closeItem", observes: "when" }),
    ]);
    expect(suite.tests.map((test) => [test.target.kind, test.operation])).toEqual([
      ["computation", "compute"],
      ["operation", "action"],
    ]);
  });

  it("observes・rowId・targetRowId・参照元 entity・値は場合の値がそのまま残る（行 ID を振り直さない）", () => {
    const owned = caseOf({
      requirementId: "R2",
      targetId: "c.itemCount",
      observes: "value",
      input: { rowId: "in-1", values: "{}" },
      targetRowId: "m-7",
      rows: [
        { rowId: "m-7", entityId: "e.member", values: "{}" },
        { rowId: "i-3", entityId: "e.item", values: JSON.stringify({ "f.item.owner": "m-7" }) },
      ],
      expected: { kind: "ok", value: "1" },
      emptyEntities: ["e.member"],
    });
    const { suite, observes } = expandedSuite([owned]);
    const [test] = suite.tests;
    expect(observes.get(test?.id ?? "")).toBe("value");
    expect(test?.inputContract).toEqual({ rowId: "in-1", targetRowId: "m-7", emptyEntities: ["e.member"] });
    expect(test?.referenceData).toEqual([
      { rowId: "m-7", target: { requirementId: "R2", kind: "entity", roleId: "e.member" }, values: {} },
      { rowId: "i-3", target: { requirementId: "R2", kind: "entity", roleId: "e.item" }, values: { "f.item.owner": "m-7" } },
    ]);
    expect(test?.target).toEqual({ requirementId: "R2", kind: "computation", roleId: "c.itemCount" });
  });

  it("v1 の形の応答を場合の形に書き換えて展開すると、試験 ID と時計を除いて同じ組になる（同じ内容は同じ試験）", () => {
    const v1 = [
      v1Test({ input: JSON.stringify({ "f.item.amount": 5 }) }),
      v1Test({
        id: "v1-2",
        target: { requirementId: "R2", kind: "computation", roleId: "c.itemCount" },
        operation: "aggregate",
        observes: "value",
        inputContract: { rowId: "row-1", targetRowId: "m1", emptyEntities: [] },
        referenceData: [
          { rowId: "m1", target: { requirementId: "R2", kind: "entity", roleId: "e.member" }, values: "{}" },
          { rowId: "i1", target: { requirementId: "R2", kind: "entity", roleId: "e.item" }, values: JSON.stringify({ "f.item.owner": "m1" }) },
        ],
        expected: { kind: "ok", value: "1", code: null },
      }),
    ];
    const before = v1Suite(v1);
    const after = expandedSuite(casesResponseOf({ tests: v1 }).cases);
    expect(after.suite.tests.map(withoutIdAndClock)).toEqual(before.suite.tests.map(withoutIdAndClock));
    expect(after.suite.tests.map((test) => after.observes.get(test.id))).toEqual(before.suite.tests.map((test) => before.observes.get(test.id)));
  });
});

describe("正例（レビュー R2）：空の写像の参照行・ref の値が指す行・参照行を指す評価の対象を保ち、B4 の結果が v1 の形で書いた同じ試験と等しい", () => {
  /** 組を偽物の宣言で B4 に流し、不一致と未解決の数を返す（試験 ID は位置で比べる） */
  async function b4Of(table: NameTable, list: RequirementList, source: string, suite: TestSuite, observes: ReadonlyMap<string, TestObserves>) {
    const evaluator = createV11aEvaluator({ table, observes, ledger: LEDGER });
    const report = await evaluator.report({ source }, { list, suite, correspondences: correspondenceFromTable(table), ownership: toV1(table).ownership });
    if (report.testRun === null) throw new Error("前提が壊れた：評価に届かない");
    const indexOf = (id: string) => suite.tests.findIndex((test) => test.id === id);
    return {
      mismatches: report.testRun.mismatches.map((entry) => indexOf(entry.testId)),
      unresolved: report.testRun.unresolved.map((entry) => indexOf(entry.testId)),
    };
  }
  const both = async (table: NameTable, list: RequirementList, source: string, tests: readonly Record<string, unknown>[]) => {
    const before = v1Suite(tests);
    const after = expandedSuite(casesResponseOf({ tests }).cases, table);
    const suiteOf = (suite: TestSuite): TestSuite => ({ classifications: [], tests: suite.tests });
    return {
      v1: await b4Of(table, list, source, suiteOf(before.suite), before.observes),
      cases: await b4Of(table, list, source, suiteOf(after.suite), after.observes),
      after,
    };
  };

  it("行ごとの件数：空の写像の参照行（担当者）を評価の対象にし、ref の値で別の参照行の行 ID を指す 2 行を数える（期待 2 は不一致 0・期待 3 は不一致 1）。どちらの形でも同じ", async () => {
    const rowCount = (value: string, id: string): Record<string, unknown> =>
      v1Test({
        id,
        target: { requirementId: "R2", kind: "computation", roleId: "c.itemCount" },
        operation: "aggregate",
        observes: "value",
        inputContract: { rowId: "row-1", targetRowId: "m1", emptyEntities: [] },
        referenceData: [
          { rowId: "m1", target: { requirementId: "R2", kind: "entity", roleId: "e.member" }, values: "{}" },
          ...["i1", "i2"].map((rowId) => ({ rowId, target: { requirementId: "R2", kind: "entity", roleId: "e.item" }, values: JSON.stringify({ "f.item.owner": "m1" }) })),
        ],
        expected: { kind: "ok", value, code: null },
      });
    const result = await both(TABLE, fixtureList(), FIXTURE_YAML, [rowCount("2", "count-2"), rowCount("3", "count-3")]);
    expect(result.v1).toEqual({ mismatches: [1], unresolved: [] });
    expect(result.cases).toEqual(result.v1);
    // 空の行を捨てない・空の集合に変えない：参照行 3 行と評価の対象の行 ID が残る
    const [first] = result.after.suite.tests;
    expect(first?.referenceData.map((row) => [row.rowId, row.target.roleId, row.values])).toEqual([
      ["m1", "e.member", {}],
      ["i1", "e.item", { "f.item.owner": "m1" }],
      ["i2", "e.item", { "f.item.owner": "m1" }],
    ]);
    expect(first?.inputContract?.targetRowId).toBe("m1");
  });

  it("アプリ全体の件数：値が空の写像の参照行 2 行を持つ count の正常（期待 2）が不一致 0。期待 3 は不一致 1。どちらの形でも同じ", async () => {
    const sized = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, { ledger: true }, { codeWritten: true });
    const appCount = (value: string, id: string): Record<string, unknown> =>
      v1Test({
        id,
        target: { requirementId: "R3", kind: "computation", roleId: "c.total" },
        operation: "aggregate",
        observes: "value",
        referenceData: ["i1", "i2"].map((rowId) => ({ rowId, target: { requirementId: "R3", kind: "entity", roleId: "e.item" }, values: "{}" })),
        expected: { kind: "ok", value, code: null },
      });
    const result = await both(sized.table, sized.list, sized.declaration(), [appCount("2", "app-2"), appCount("3", "app-3")]);
    expect(result.v1).toEqual({ mismatches: [1], unresolved: [] });
    expect(result.cases).toEqual(result.v1);
    expect(result.after.suite.tests[0]?.referenceData.map((row) => [row.rowId, row.values])).toEqual([
      ["i1", {}],
      ["i2", {}],
    ]);
  });
});

describe("正例（レビュー R3）：observes は導出せず場合の値を使う（網羅の単位を潰さない）", () => {
  it("行ごとの空の集計で observes を value にした場合と empty-aggregate にした場合が、どちらも評価可能性を通り、網羅の単位が別になる", () => {
    const emptyCount = (observes: string) =>
      caseOf({
        requirementId: "R2",
        targetId: "c.itemCount",
        kind: "boundary",
        observes,
        input: { rowId: "row-1", values: "{}" },
        targetRowId: "m1",
        rows: [{ rowId: "m1", entityId: "e.member", values: "{}" }],
        expected: { kind: "ok", value: "0" },
        emptyEntities: ["e.item"],
      });
    const { suite, observes } = expandedSuite([emptyCount("value"), emptyCount("empty-aggregate")]);
    expect([...observes.values()]).toEqual(["value", "empty-aggregate"]);
    expect(checkEvaluabilityByLedger(suite, observes, TABLE, LEDGER)).toEqual([]);
    const units = coverageUnitsOf({ suite, observes, natures: new Map([["R2", "ruled" as const]]) });
    expect(units).toHaveLength(2);
    expect(new Set(units.map((unit) => unit.key)).size).toBe(2);
  });
});

describe("負例：展開できない場合は場合の添字と欄名の固定文で落とし、補わない（Issue #625）", () => {
  const cases: readonly (readonly [string, Record<string, unknown>, string, string])[] = [
    ["表に無い行 ID", caseOf({ targetId: "f.item.nothing" }), "cases[1].targetId", TEST_CASE_EXPAND_MESSAGES.target],
    ["entity でない参照元", caseOf({ rows: [{ rowId: "r1", entityId: "f.item.amount", values: "{}" }] }), "cases[1].rows[0].entityId", TEST_CASE_EXPAND_MESSAGES.entity],
    [
      "その entity の項目でない鍵",
      caseOf({ rows: [{ rowId: "r1", entityId: "e.item", values: JSON.stringify({ "f.member.title": "x" }) }] }),
      "cases[1].rows[0].values",
      TEST_CASE_EXPAND_MESSAGES.valueKey,
    ],
    ["同じ場合の中の行 ID の重なり", caseOf({ rows: [{ rowId: "row-1", entityId: "e.item", values: "{}" }] }), "cases[1].rows[0].rowId", TEST_CASE_EXPAND_MESSAGES.duplicateRowId],
    ["無い行を指す targetRowId", caseOf({ targetRowId: "row-9" }), "cases[1].targetRowId", TEST_CASE_EXPAND_MESSAGES.targetRowId],
    ["entity でない空の集合", caseOf({ emptyEntities: ["c.itemCount"] }), "cases[1].emptyEntities[0]", TEST_CASE_EXPAND_MESSAGES.emptyEntity],
    ["ok に code", caseOf({ expected: { kind: "ok", code: "E_X" } }), "cases[1].expected", TEST_CASE_EXPAND_MESSAGES.expected],
    ["error に value", caseOf({ expected: { kind: "error", value: "1" } }), "cases[1].expected", TEST_CASE_EXPAND_MESSAGES.expected],
    ["ok に value と code", caseOf({ expected: { kind: "ok", value: "1", code: "E_X" } }), "cases[1].expected", TEST_CASE_EXPAND_MESSAGES.expected],
  ];
  it.each(cases)("%s：固定文で落ち、組を返さない", (_name, bad, field, message) => {
    const result = expandTestCases(shaped([caseOf(), bad]), TABLE);
    expect(result).toEqual({ ok: false, problems: [{ field, message }] });
  });

  it("問題の位置の写し：展開後の組の添字と欄を場合の添字と欄へ写す（外した試験の後ろも対応表で引く。コードの試験の位置は変えない）", () => {
    const tests = [{ id: `${TEST_CASE_ID_PREFIX}2` }, { id: `${TEST_CASE_ID_PREFIX}3` }, { id: "gen:x" }];
    const caseIndexById = new Map([
      [`${TEST_CASE_ID_PREFIX}1`, 0],
      [`${TEST_CASE_ID_PREFIX}2`, 1],
      [`${TEST_CASE_ID_PREFIX}3`, 2],
    ]);
    const mapped = toCasePositions(
      [
        { field: "tests[0].target.roleId", message: "a" },
        { field: "tests[0].target.requirementId", message: "b" },
        { field: "tests[1].referenceData[2].values", message: "c" },
        { field: "tests[1].inputContract.targetRowId", message: "d" },
        { field: "tests[1].input", message: "e" },
        { field: "tests[0]", message: "f" },
        { field: "tests[2].observes", message: "g" },
        { field: "requirements[1]", message: "h" },
        { field: "tests[1].operation", message: "i" },
      ],
      tests,
      caseIndexById,
    );
    expect(mapped.map((problem) => problem.field)).toEqual([
      "cases[1].targetId",
      "cases[1].requirementId",
      "cases[2].rows[2].values",
      "cases[2].targetRowId",
      "cases[2].input.values",
      "cases[1]",
      "tests[2].observes",
      "requirements[1]",
      "cases[2].targetId",
    ]);
  });
});

describe("T2 の束（手 3f・Issue #626。束の中で閉じる条件だけ）", () => {
  const ids = (count: number): readonly string[] => Array.from({ length: count }, (_, index) => `R${String(index + 1)}`);
  const bundleCase = (requirementId: string): TestCase => caseOf({ requirementId }) as unknown as TestCase;
  const outputOf = (classified: readonly string[], cased: readonly string[]): TestCasesOutput => ({
    classifications: classified.map((requirementId) => ({ requirementId, nature: "ruled" })),
    cases: cased.map(bundleCase),
  });

  it("一覧の順で 5 件ごとに切る（15 → 3、7 → 5＋2、25 → 5。最後の束は 5 未満でよい）", () => {
    expect(bundleRequirementIds(ids(15), 5).map((bundle) => bundle.length)).toEqual([5, 5, 5]);
    expect(bundleRequirementIds(ids(7), 5)).toEqual([ids(5), ["R6", "R7"]]);
    expect(bundleRequirementIds(ids(25), 5)).toHaveLength(5);
    expect(bundleRequirementIds([], 5)).toEqual([]);
    expect(() => bundleRequirementIds(ids(3), 0)).toThrow(RangeError);
  });

  it("束の完全性：欠落・重複・別の束の要件 ID・一覧に無い要件 ID を、分類と場合のそれぞれで固定文で落とす", () => {
    const all = ids(10);
    const bundle = all.slice(5, 10);
    expect(checkBundleCompleteness(outputOf(bundle, ["R6", "R10"]), bundle, all, all)).toEqual([]);
    expect(checkBundleCompleteness(outputOf(["R6", "R7", "R8", "R9"], []), bundle, all, all)).toEqual([
      { field: "requirements[4]", message: TEST_CASE_BUNDLE_MESSAGES.missing },
    ]);
    expect(checkBundleCompleteness(outputOf([...bundle, "R6"], []), bundle, all, all)).toEqual([
      { field: "classifications[5].requirementId", message: TEST_CASE_BUNDLE_MESSAGES.duplicate },
    ]);
    expect(checkBundleCompleteness(outputOf([...bundle, "R1"], []), bundle, all, all)).toEqual([
      { field: "classifications[5].requirementId", message: TEST_CASE_BUNDLE_MESSAGES.outside },
    ]);
    expect(checkBundleCompleteness(outputOf([...bundle, "R99"], []), bundle, all, all)).toEqual([
      { field: "classifications[5].requirementId", message: TEST_CASE_BUNDLE_MESSAGES.unknown },
    ]);
    expect(checkBundleCompleteness(outputOf(bundle, ["R6", "R2"]), bundle, all, all)).toEqual([
      { field: "cases[1].requirementId", message: TEST_CASE_BUNDLE_MESSAGES.caseOutside },
    ]);
    expect(checkBundleCompleteness(outputOf(bundle, ["R6", "R99"]), bundle, all, all)).toEqual([
      { field: "cases[1].requirementId", message: TEST_CASE_BUNDLE_MESSAGES.caseUnknown },
    ]);
  });

  it("一覧にあるがどの束にも無い要件（コードの試験だけで確かめる要件）の分類・場合は、束では断らず合併後の検査へ渡す", () => {
    const known = ids(7);
    const requested = known.slice(0, 5);
    expect(checkBundleCompleteness(outputOf([...requested, "R6"], ["R1", "R7"]), requested, requested, known)).toEqual([]);
    // 二点測定：要求の一覧に入れれば別の束の要件として断る
    expect(checkBundleCompleteness(outputOf([...requested, "R6"], ["R1", "R7"]), requested, known, known)).toEqual([
      { field: "classifications[5].requirementId", message: TEST_CASE_BUNDLE_MESSAGES.outside },
      { field: "cases[1].requirementId", message: TEST_CASE_BUNDLE_MESSAGES.caseOutside },
    ]);
  });

  it("合併は束の順・束の中の順で、場合を足しも除きもしない（束の数が増えても 1 要件あたりの場合の数は同じ）", () => {
    const cased = ["R1", "R1", "R2", "R3", "R3", "R3", "R4", "R5", "R6", "R7"];
    const perRequirement = (bundleCount: number): Readonly<Record<string, number>> => {
      const bundles = bundleRequirementIds(ids(7), Math.ceil(7 / bundleCount));
      const merged = mergeBundleCases(
        bundles.map((bundle) => outputOf(bundle, cased.filter((requirementId) => bundle.includes(requirementId)))),
      );
      expect(merged.output.cases.map((entry) => entry.requirementId)).toEqual(cased);
      const counts: Record<string, number> = {};
      for (const entry of merged.output.cases) counts[entry.requirementId] = (counts[entry.requirementId] ?? 0) + 1;
      return counts;
    };
    const one = perRequirement(1);
    expect(perRequirement(2)).toEqual(one);
    expect(perRequirement(3)).toEqual(one);
  });

  it("帰属：要件・場合・分類の位置はその束の中の添字へ写し、帰属できない位置は推測せずに分ける", () => {
    const bundles = bundleRequirementIds(ids(7), 5);
    const merged = mergeBundleCases([outputOf(bundles[0] ?? [], ["R1", "R2"]), outputOf(bundles[1] ?? [], ["R6", "R7"])]);
    const attributed = attributeProblemsToBundles(
      [
        { field: "requirements[6]", message: "a" },
        { field: "cases[3].expected", message: "b" },
        { field: "classifications[1].requirementId", message: "c" },
        { field: "tests[9].id", message: "d" },
        { field: "", message: "e" },
        { field: "cases[99]", message: "f" },
      ],
      merged,
      bundles,
    );
    expect(Object.fromEntries(attributed.byBundle)).toEqual({
      0: [{ field: "classifications[1].requirementId", message: "c" }],
      1: [
        { field: "requirements[1]", message: "a" },
        { field: "cases[1].expected", message: "b" },
      ],
    });
    expect(attributed.unattributed.map((problem) => problem.message)).toEqual(["d", "e", "f"]);
  });
});
