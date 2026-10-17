// 評価口（v11a/evaluate.ts）の試験（07-architecture-v1.1a.md §3・D11。Issue #510）。
//
// LLM を呼ばない。題材は v1.1α の共通の題材（担当者と項目）。評価の文脈（A6' の型）を変えて呼び、組・一覧・所属を
// 毎回文脈から取ること、試験 ID で結び付けること（並びで引かない）、④ に落ちる版の扱いを確かめる。
import { sha256Hex } from "@musunest/spec-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixedTest, TestKind, TestSuite } from "../fixed-test.js";
import type { RequirementList } from "../pipeline.js";
import * as bindModule from "../stages/bind.js";
import * as runTestsStage from "../stages/run-tests.js";
import { runTests } from "../stages/run-tests.js";
import type { EvaluationContext } from "../stages/tools.js";
import { FIXTURE_YAML, fixtureList, fixtureTable, normalizedFixture } from "./__tests__/fixtures.js";
import { bindTestsById, correspondenceFromTable } from "./bind-by-id.js";
import { identityMappings, toRoleEntries, toV1 } from "./convert.js";
import {
  DEFAULT_VALUE_DETAILS,
  LEDGER_OBSERVES_DETAILS,
  UNMAPPED_OBSERVES_DETAIL,
  V11A_EVALUATION_JUDGES,
  V11A_EVALUATION_NAMES,
  createV11aEvaluator,
  createV11aEvaluator as createV11aEvaluatorBase,
  judgeDefaultValue,
} from "./evaluate.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW, deriveLedgerView, type LedgerView } from "../v12/ledger.js";
import type { TestObserves } from "./stages/test-spec.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 旗 off（台帳を渡さない）と旗 on（台帳の導出を渡す）。評価口の試験を両方で同じ結果に照らす（Issue #547） */
const LEDGER_CASES: readonly { readonly name: string; readonly ledger: LedgerView | undefined }[] = [
  { name: "off", ledger: undefined },
  { name: "on", ledger: PROPERTY_LEDGER_VIEW },
];

/** 旗に合わせた評価口の作り方（on は台帳の導出を閉包に渡す） */
const evaluatorFactory =
  (ledger: LedgerView | undefined): typeof createV11aEvaluatorBase =>
  (input) =>
    createV11aEvaluatorBase(ledger === undefined ? input : { ...input, ledger });

const TABLE = fixtureTable();
const listWithout = (...ids: readonly string[]): RequirementList => ({
  ...fixtureList(),
  requirements: fixtureList().requirements.filter((requirement) => !["R5", ...ids].includes(requirement.id)),
});

/** 項目の一覧に R1 の所属の項目を全部出した宣言（B3 を通る） */
const YAML = FIXTURE_YAML.replace("show: [title, amount, kind]", "show: [title, owner, amount, day, kind]");

const CLOCK = "2026-09-16T12:00:00+09:00";

function valueTest(id: string, requirementId: string, kind: TestKind, expected: unknown): FixedTest {
  return {
    id,
    target: { requirementId, kind: "computation", roleId: "c.rate" },
    kind,
    operation: "compute",
    clock: CLOCK,
    input: {},
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: ["e.item"] },
    referenceData: [],
    expected: { kind: "ok", value: expected },
  };
}

function actionTest(id: string, kind: TestKind, amount: number, expected: boolean): FixedTest {
  return {
    id,
    target: { requirementId: "R3", kind: "operation", roleId: "o.closeItem" },
    kind,
    operation: "action",
    clock: CLOCK,
    input: { "f.item.amount": amount },
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: expected },
  };
}

function showsTest(id: string, role: string): FixedTest {
  return {
    id,
    target: { requirementId: "R2", kind: "screen", roleId: "s.members" },
    kind: "normal",
    operation: "structure",
    clock: CLOCK,
    input: {},
    referenceData: [],
    expected: { kind: "ok", value: true },
    assertion: { check: "view-shows", role },
  };
}

/** 一致・不一致・未解決（表に無い ID）が混ざった組 */
const SUITE: TestSuite = {
  classifications: [
    { requirementId: "R2", nature: "existence-only" },
    { requirementId: "R3", nature: "ruled" },
    { requirementId: "R4", nature: "ruled" },
  ],
  tests: [
    actionTest("t-when-ok", "normal", 3, true),
    actionTest("t-when-bad", "abnormal", -1, true),
    showsTest("t-shows", "f.member.title"),
    valueTest("t-rate", "R4", "normal", 0),
    { ...showsTest("t-unknown", "f.member.title"), target: { requirementId: "R2", kind: "screen", roleId: "s.nowhere" } },
  ],
};

/** SUITE の観測する性質（T2 で固定した写像の写し） */
const OBSERVES: ReadonlyMap<string, TestObserves> = new Map<string, TestObserves>([
  ["t-when-ok", "when"],
  ["t-when-bad", "when"],
  ["t-shows", "view-structure"],
  ["t-rate", "value"],
  ["t-unknown", "view-structure"],
]);

/** 写像から試験 ID を除いたもの */
const observesWithout = (...ids: readonly string[]): ReadonlyMap<string, TestObserves> =>
  new Map([...OBSERVES].filter(([testId]) => !ids.includes(testId)));

function contextOf(list: RequirementList, suite: TestSuite = SUITE): EvaluationContext {
  const table = {
    ...TABLE,
    ownership: TABLE.ownership.filter((entry) => list.requirements.some((requirement) => requirement.id === entry.requirementId)),
  };
  return {
    list,
    suite,
    correspondences: correspondenceFromTable(table),
    ownership: toV1(table).ownership,
  };
}

/** 試験 ID → 結果（一致・不一致・未解決） */
function outcomesById(testRun: { mismatches: readonly { testId: string }[]; unresolved: readonly { testId: string }[] }, suite: TestSuite) {
  const outcomes = new Map<string, string>();
  for (const test of suite.tests) outcomes.set(test.id, "match");
  for (const entry of testRun.mismatches) outcomes.set(entry.testId, "mismatch");
  for (const entry of testRun.unresolved) outcomes.set(entry.testId, "unresolved");
  return outcomes;
}

describe("④ に落ちる版", () => {
  it("correspondence・testRun が null で、版の SHA-256 を持つ", async () => {
    const evaluator = createV11aEvaluator({ table: TABLE, observes: OBSERVES });
    const source = YAML.replace("type: number\n  - name: rate", "type: nosuchtype\n  - name: rate");
    expect(source).not.toBe(YAML);
    const report = await evaluator.report({ source }, contextOf(listWithout()));
    expect(report.staticCheck.passed).toBe(false);
    expect(report.correspondence).toBeNull();
    expect(report.testRun).toBeNull();
    expect(report.declarationSha256).toBe(await sha256Hex(source));
    expect(report.defectMisses).toEqual([]);
    expect(report.redoMisses).toEqual([]);
  });
});

describe.each(LEDGER_CASES)("通る版（旗 $name）", ({ ledger }) => {
  const createV11aEvaluator = evaluatorFactory(ledger);
  it("B3 の落ちと、表の id で結び付けて流した結果を持ち、defectMisses・redoMisses は空", async () => {
    const evaluator = createV11aEvaluator({ table: TABLE, observes: OBSERVES });
    // B3 の落ち（画面から辿れない項目）がある宣言
    const report = await evaluator.report({ source: FIXTURE_YAML }, contextOf(listWithout()));
    expect(report.staticCheck.passed).toBe(true);
    expect(report.declarationSha256).toBe(await sha256Hex(FIXTURE_YAML));
    expect(report.correspondence?.misses.length).toBeGreaterThan(0);
    expect(report.correspondence?.entries.map((entry) => entry.requirementId)).toEqual(["R1", "R2", "R3", "R4"]);
    const outcomes = outcomesById(report.testRun!, SUITE);
    expect(Object.fromEntries(outcomes)).toEqual({
      "t-when-ok": "match",
      "t-when-bad": "mismatch",
      "t-shows": "match",
      "t-rate": "match",
      "t-unknown": "unresolved",
    });
    expect(report.routes).toEqual((report.testRun as { routes?: unknown } | null)?.routes);
    expect(report.routes.length).toBeGreaterThan(0);
    expect(report.defectMisses).toEqual([]);
    expect(report.redoMisses).toEqual([]);
  });

  it("同じ宣言と文脈で 2 回同じ結果", async () => {
    const evaluator = createV11aEvaluator({ table: TABLE, observes: OBSERVES });
    const context = contextOf(listWithout());
    const first = await evaluator.report({ source: YAML }, context);
    const second = await evaluator.report({ source: YAML }, context);
    expect(second).toEqual(first);
  });

  it("bindTests を呼ばない", async () => {
    const spy = vi.spyOn(bindModule, "bindTests");
    const evaluator = createV11aEvaluator({ table: TABLE, observes: OBSERVES });
    await evaluator.report({ source: YAML }, contextOf(listWithout()));
    const app = await normalizedFixture(YAML);
    await evaluator.evaluate(app, { source: YAML }, contextOf(listWithout()));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("組・一覧・所属は毎回文脈から取る", () => {
  it("文脈の組から試験を 1 つ外すと、外した試験を流さず、残りの結果が試験 ID で一致する（並びの変化で結果がずれない）", async () => {
    const evaluator = createV11aEvaluator({ table: TABLE, observes: OBSERVES });
    const app = await normalizedFixture(YAML);
    const full = await evaluator.evaluate(app, { source: YAML }, contextOf(listWithout()));
    const reduced: TestSuite = { ...SUITE, tests: SUITE.tests.filter((test) => test.id !== "t-when-ok") };
    const partial = await evaluator.evaluate(app, { source: YAML }, contextOf(listWithout(), reduced));
    const before = outcomesById(full.testRun, SUITE);
    const after = outcomesById(partial.testRun, reduced);
    expect(after.has("t-when-ok")).toBe(false);
    for (const [testId, outcome] of after) expect(outcome).toBe(before.get(testId));
    // 並びが 1 つずれても、同じ試験 ID の結果を返す（行き先も試験 ID で付く）
    expect(partial.testRun.mismatches.map((entry) => entry.testId)).toEqual(["t-when-bad"]);
    expect(partial.testRun.unresolved.map((entry) => entry.testId)).toEqual(["t-unknown"]);
  });

  it("文脈の一覧から要件を除くと、その要件だけの行は B3 で検査されず、共有の行は検査される", async () => {
    const evaluator = createV11aEvaluator({ table: TABLE, observes: OBSERVES });
    const app = await normalizedFixture(YAML.replace("    when: amount > 0\n", ""));
    const all = evaluator.nameCheck(app, contextOf(listWithout()));
    expect(all.checkedRowIds).toContain("o.closeItem");
    expect(all.misses.some((miss) => miss.location?.name === "closeItem")).toBe(true);
    const without = evaluator.nameCheck(app, contextOf(listWithout("R3")));
    expect(without.checkedRowIds).not.toContain("o.closeItem");
    expect(without.checkedRowIds).toContain("f.item.amount");
    expect(without.misses).toEqual([]);
  });

  it("閉包の除く行は、文脈の一覧に所属させる要件があっても除く", async () => {
    const evaluator = createV11aEvaluator({ table: TABLE, excludedRowIds: ["o.closeItem"], observes: OBSERVES });
    const app = await normalizedFixture(YAML);
    const result = evaluator.nameCheck(app, contextOf(listWithout()));
    expect(result.checkedRowIds).not.toContain("o.closeItem");
  });
});

describe.each(LEDGER_CASES)("観測する性質の写像（observes。必須。Issue #526。旗 $name）", ({ ledger }) => {
  const createV11aEvaluator = evaluatorFactory(ledger);
  /** v1 の runTests を、表の id の結び付けで直接流す（評価口を通さない） */
  async function directRun(source: string, suite: TestSuite, dropBindingOf: readonly string[] = []) {
    const app = await normalizedFixture(source);
    const context = contextOf(listWithout(), suite);
    const checked = createV11aEvaluator({ table: TABLE, observes: OBSERVES }).nameCheck(app, context);
    const correspondence = { entries: checked.entries, misses: checked.misses };
    const bound = bindTestsById(app, TABLE, suite);
    const tests = new Map([...bound.bindings].filter(([testId]) => !dropBindingOf.includes(testId)));
    return {
      app,
      context,
      correspondence,
      report: runTests({
        app,
        suite,
        correspondence,
        mappings: identityMappings(TABLE),
        roles: toRoleEntries(TABLE),
        bindings: { tests, entityNames: bound.entityNames },
      }),
    };
  }

  /** 試験 ID → その試験の結果（不一致・未解決・行き先・構造の検査） */
  function byTestId(report: ReturnType<typeof runTests>, suite: TestSuite) {
    return Object.fromEntries(
      suite.tests.map((test) => [
        test.id,
        {
          mismatches: report.mismatches.filter((entry) => entry.testId === test.id),
          unresolved: report.unresolved.filter((entry) => entry.testId === test.id),
          routes: report.routes.filter((entry) => entry.testId === test.id),
          structural: report.structural.filter((entry) => entry.testId === test.id),
        },
      ]),
    );
  }

  it("observes を省いた材料では評価口を作れない（型）", () => {
    // 呼ばない（型の検査だけ）。observes を省けば型で落ちる
    const build = () =>
      // @ts-expect-error observes は必須
      createV11aEvaluator({ table: TABLE });
    expect(typeof build).toBe("function");
  });

  it("写像が組を覆えば、B4 の結果は v1 の runTests を表の id の結び付けで直接流した結果と試験 ID ごとに深く等しい", async () => {
    const { app, context, correspondence, report } = await directRun(YAML, SUITE);
    const evaluator = createV11aEvaluator({ table: TABLE, observes: OBSERVES });
    const viaEvaluator = evaluator.runTests(app, context, correspondence);
    expect(byTestId(viaEvaluator, SUITE)).toEqual(byTestId(report, SUITE));
    expect(viaEvaluator).toEqual(report);
    // 同じ関数が ⑥ の道具・版の再検査に渡る（材料に足す以外の配線は要らない）
    const evaluated = await evaluator.evaluate(app, { source: YAML }, context);
    expect(evaluated.testRun).toEqual(report);
  });

  it("写像に無い試験 ID を 1 つ含む文脈では、その試験だけが未解決（行き先は no-mapping と同じ）で、ほかの結果は変わらない", async () => {
    for (const missing of ["t-when-ok", "t-shows"]) {
      const { app, context, correspondence, report } = await directRun(YAML, SUITE);
      // 対照：v1 の no-mapping（結び付けの表に無い）の未解決
      const noMapping = (await directRun(YAML, SUITE, [missing])).report;
      const evaluator = createV11aEvaluator({ table: TABLE, observes: observesWithout(missing) });
      const viaEvaluator = evaluator.runTests(app, context, correspondence);
      const expected = byTestId(report, SUITE);
      const actual = byTestId(viaEvaluator, SUITE);
      for (const test of SUITE.tests) {
        if (test.id !== missing) expect(actual[test.id]).toEqual(expected[test.id]);
      }
      const reference = byTestId(noMapping, SUITE)[missing];
      expect(actual[missing]?.mismatches).toEqual([]);
      expect(actual[missing]?.unresolved).toEqual([{ testId: missing, detail: UNMAPPED_OBSERVES_DETAIL }]);
      expect(reference?.unresolved).toHaveLength(1);
      expect(actual[missing]?.routes.map((entry) => entry.route)).toEqual(reference?.routes.map((entry) => entry.route));
      expect(actual[missing]?.routes).toEqual([{ testId: missing, route: "ambiguity", detail: UNMAPPED_OBSERVES_DETAIL }]);
      expect(actual[missing]?.structural.map((entry) => entry.result)).toEqual(
        reference?.structural.map((entry) => entry.result),
      );
      // 並びは組のまま（未解決は組の並びに差し込む）
      const order = SUITE.tests.map((test) => test.id);
      const indices = viaEvaluator.unresolved.map((entry) => order.indexOf(entry.testId));
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
      // 版の再検査・道具に渡る関数も同じ結果
      const evaluated = await evaluator.evaluate(app, { source: YAML }, context);
      expect(evaluated.testRun).toEqual(viaEvaluator);
    }
  });

  it("写像に無い試験は v1 の runTests に渡さず、文脈の組から外した試験も流さない", async () => {
    const suites: string[][] = [];
    const original = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      suites.push(input.suite.tests.map((test) => test.id));
      return original(input);
    });
    const app = await normalizedFixture(YAML);
    const evaluator = createV11aEvaluator({ table: TABLE, observes: observesWithout("t-rate") });
    const reduced: TestSuite = { ...SUITE, tests: SUITE.tests.filter((test) => test.id !== "t-when-ok") };
    const result = await evaluator.evaluate(app, { source: YAML }, contextOf(listWithout(), reduced));
    expect(suites).toEqual([["t-when-bad", "t-shows", "t-unknown"]]);
    const outcomes = outcomesById(result.testRun, reduced);
    expect(outcomes.has("t-when-ok")).toBe(false);
    expect(outcomes.get("t-rate")).toBe("unresolved");
  });

  it("写像に無い試験を含む文脈でも、同じ入力で 2 回同じ結果で、bindTests を呼ばない", async () => {
    const spy = vi.spyOn(bindModule, "bindTests");
    const evaluator = createV11aEvaluator({ table: TABLE, observes: observesWithout("t-shows") });
    const context = contextOf(listWithout());
    const first = await evaluator.report({ source: YAML }, context);
    const second = await evaluator.report({ source: YAML }, context);
    expect(second).toEqual(first);
    expect(first.testRun?.unresolved.map((entry) => entry.testId)).toEqual(["t-shows", "t-unknown"]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe.each(LEDGER_CASES)("既定値の試験（observes が default-value）は v1 に渡さず、宣言の default と照合する（Issue #533。旗 $name）", ({ ledger }) => {
  const createV11aEvaluator = evaluatorFactory(ledger);
  /** 区分の項目の既定値を alpha にした宣言（静的チェックを通る） */
  const withDefault = (key: string | null, source: string = YAML): string => {
    const from = "          beta: ベータ\n";
    if (source.split(from).length !== 2) throw new Error("前提が壊れた：置き換えの元が 1 か所でない");
    return key === null ? source : source.replace(from, `${from}        default: ${key}\n`);
  };
  const DYAML = withDefault("alpha");

  function defaultTest(id: string, expected: unknown, roleId = "f.item.kind"): FixedTest {
    return {
      id,
      target: { requirementId: "R6", kind: "field", roleId },
      kind: "normal",
      operation: "validate",
      clock: CLOCK,
      input: {},
      inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: expected },
    };
  }

  /** 組の途中（3 番目）に既定値の試験を差した組 */
  const suiteWith = (test: FixedTest): TestSuite => ({ ...SUITE, tests: [...SUITE.tests.slice(0, 2), test, ...SUITE.tests.slice(2)] });
  const observesWith = (testId: string): ReadonlyMap<string, TestObserves> => new Map([...OBSERVES, [testId, "default-value" as const]]);

  /** 表に、宣言に無い選択肢の項目の行を足したもの（項目が宣言に無い例） */
  const TABLE_WITH_EXTRA = {
    ...TABLE,
    rows: [
      ...TABLE.rows,
      { ...TABLE.rows.find((row) => row.id === "f.item.kind")!, id: "f.item.extra", name: "extra" },
    ],
  };

  async function evaluateWith(source: string, test: FixedTest, table = TABLE) {
    const app = await normalizedFixture(source);
    const suite = suiteWith(test);
    const context = contextOf(listWithout(), suite);
    const evaluator = createV11aEvaluator({ table, observes: observesWith(test.id) });
    const checked = evaluator.nameCheck(app, context);
    const correspondence = { entries: checked.entries, misses: checked.misses };
    return { app, suite, context, evaluator, correspondence, report: evaluator.runTests(app, context, correspondence) };
  }

  it("default が期待のキーと一致なら、既定値の試験の不一致・未解決は 0", async () => {
    const { report } = await evaluateWith(DYAML, defaultTest("t-default", "alpha"));
    expect(report.mismatches.filter((entry) => entry.testId === "t-default")).toEqual([]);
    expect(report.unresolved.filter((entry) => entry.testId === "t-default")).toEqual([]);
    expect(report.routes.filter((entry) => entry.testId === "t-default")).toEqual([]);
    expect(report.structural.filter((entry) => entry.testId === "t-default")).toEqual([]);
  });

  it("default が別のキー・default が無い・項目が選択肢でない・項目が宣言に無い、はそれぞれ不一致（固定文。行き先は v1 の不一致と同じ）", async () => {
    const cases = [
      { source: withDefault("beta"), test: defaultTest("t-default", "alpha"), detail: DEFAULT_VALUE_DETAILS.defaultDiffers },
      { source: YAML, test: defaultTest("t-default", "alpha"), detail: DEFAULT_VALUE_DETAILS.defaultMissing },
      { source: DYAML, test: defaultTest("t-default", "alpha", "f.item.title"), detail: DEFAULT_VALUE_DETAILS.notEnum },
      { source: DYAML, test: defaultTest("t-default", "alpha", "f.item.extra"), detail: DEFAULT_VALUE_DETAILS.fieldMissing, table: TABLE_WITH_EXTRA },
    ];
    // 対照：v1 の不一致の行き先（t-when-bad は v1 が不一致にする）
    const v1Mismatch = (await evaluateWith(DYAML, defaultTest("t-default", "alpha"))).report.routes.find(
      (entry) => entry.testId === "t-when-bad",
    );
    expect(v1Mismatch?.route).toBe("missing-element");
    for (const entry of cases) {
      const { report } = await evaluateWith(entry.source, entry.test, entry.table);
      expect(report.mismatches.filter((item) => item.testId === "t-default")).toEqual([{ testId: "t-default", detail: entry.detail }]);
      expect(report.unresolved.filter((item) => item.testId === "t-default")).toEqual([]);
      expect(report.routes.filter((item) => item.testId === "t-default")).toEqual([
        { testId: "t-default", route: v1Mismatch?.route, detail: entry.detail },
      ]);
    }
    // 固定文はキー・名前を埋めない
    for (const detail of Object.values(DEFAULT_VALUE_DETAILS)) {
      for (const value of ["alpha", "beta", "kind", "item", "extra", "title"]) expect(detail).not.toContain(value);
    }
  });

  it("期待が文字列でない試験は未解決（行き先は v1 の未解決と同じ）", async () => {
    const v1Unresolved = (await evaluateWith(DYAML, defaultTest("t-default", "alpha"))).report.routes.find(
      (entry) => entry.testId === "t-unknown",
    );
    expect(v1Unresolved?.route).toBe("ambiguity");
    for (const expected of [1, null, true, ["alpha"]]) {
      const { report } = await evaluateWith(DYAML, defaultTest("t-default", expected));
      expect(report.unresolved.filter((item) => item.testId === "t-default")).toEqual([
        { testId: "t-default", detail: DEFAULT_VALUE_DETAILS.expectedNotString },
      ]);
      expect(report.mismatches.filter((item) => item.testId === "t-default")).toEqual([]);
      expect(report.routes.filter((item) => item.testId === "t-default").map((item) => item.route)).toEqual([v1Unresolved?.route]);
    }
    // 期待が誤りコードの試験も文字列のキーでないので未解決
    const errorTest = { ...defaultTest("t-default", "alpha"), expected: { kind: "error" as const, code: "E" } };
    const { report } = await evaluateWith(DYAML, errorTest);
    expect(report.unresolved.filter((item) => item.testId === "t-default").map((item) => item.detail)).toEqual([
      DEFAULT_VALUE_DETAILS.expectedNotString,
    ]);
  });

  it("ほかの試験の結果は、既定値の試験を外した組の v1 の結果と試験 ID ごとに深く等しく、順は組の順。既定値の試験は v1 の runTests に渡らない", async () => {
    const passed: string[][] = [];
    const original = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      passed.push(input.suite.tests.map((test) => test.id));
      return original(input);
    });
    const { app, suite, correspondence, report } = await evaluateWith(withDefault("beta"), defaultTest("t-default", "alpha"));
    expect(passed).toEqual([SUITE.tests.map((test) => test.id)]);
    // 対照：既定値の試験を外した組を v1 に表の id の結び付けで直接流す
    const bound = bindTestsById(app, TABLE, SUITE);
    const direct = original({
      app,
      suite: SUITE,
      correspondence,
      mappings: identityMappings(TABLE),
      roles: toRoleEntries(TABLE),
      bindings: { tests: bound.bindings, entityNames: bound.entityNames },
    });
    const pick = (from: typeof report, testId: string) => ({
      mismatches: from.mismatches.filter((entry) => entry.testId === testId),
      unresolved: from.unresolved.filter((entry) => entry.testId === testId),
      routes: from.routes.filter((entry) => entry.testId === testId),
      structural: from.structural.filter((entry) => entry.testId === testId),
    });
    for (const test of SUITE.tests) expect(pick(report, test.id)).toEqual(pick(direct, test.id));
    // 順は組の順（既定値の試験は組の 3 番目に合流する）
    const order = suite.tests.map((test) => test.id);
    for (const list of [report.mismatches, report.unresolved, report.routes]) {
      const indices = list.map((entry) => order.indexOf(entry.testId));
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    }
    expect(report.mismatches.map((entry) => entry.testId)).toEqual(["t-when-bad", "t-default"]);
  });

  it("B5 の道具・版の再検査（evaluate・report）が同じ結果で、同じ入力で 2 回同じ結果。bindTests を呼ばない", async () => {
    const spy = vi.spyOn(bindModule, "bindTests");
    const { app, context, evaluator, report } = await evaluateWith(withDefault("beta"), defaultTest("t-default", "alpha"));
    const evaluated = await evaluator.evaluate(app, { source: withDefault("beta") }, context);
    expect(evaluated.testRun).toEqual(report);
    const first = await evaluator.report({ source: withDefault("beta") }, context);
    const second = await evaluator.report({ source: withDefault("beta") }, context);
    expect(first.testRun).toEqual(report);
    expect(second).toEqual(first);
    expect(spy).not.toHaveBeenCalled();
    // 純粋な関数として 2 回同じ判定
    const test = defaultTest("t-default", "alpha");
    expect(judgeDefaultValue(app, TABLE, test)).toEqual(judgeDefaultValue(app, TABLE, test));
  });

  it("options の外の default は静的チェック（既存の固定文）で落ち、評価に進まない（B4 では照合しない）", async () => {
    const source = withDefault("gamma");
    const evaluator = createV11aEvaluator({ table: TABLE, observes: observesWith("t-default") });
    const report = await evaluator.report({ source }, contextOf(listWithout(), suiteWith(defaultTest("t-default", "gamma"))));
    expect(report.staticCheck.passed).toBe(false);
    expect(report.staticCheck.diagnostics.map((diagnostic) => diagnostic.code)).toContain("DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS");
    expect(report.testRun).toBeNull();
    expect(report.correspondence).toBeNull();
  });
});

// ── 旗 on：台帳の照合の名前で振り分ける（Issue #547）────────────────────────────

describe("旗 on：評価口に台帳に無い・登録済み未対応の観測する性質を渡すと未解決で、v1 の runTests に渡らない", () => {
  const createV11aEvaluator = evaluatorFactory(PROPERTY_LEDGER_VIEW);

  async function evaluateWith(observes: ReadonlyMap<string, TestObserves>, view: LedgerView = PROPERTY_LEDGER_VIEW) {
    const passed: string[][] = [];
    const original = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      passed.push(input.suite.tests.map((test) => test.id));
      return original(input);
    });
    const app = await normalizedFixture(YAML);
    const context = contextOf(listWithout());
    const evaluator = createV11aEvaluatorBase({ table: TABLE, observes, ledger: view });
    const checked = evaluator.nameCheck(app, context);
    const report = evaluator.runTests(app, context, { entries: checked.entries, misses: checked.misses });
    const evaluated = await evaluator.evaluate(app, { source: YAML }, context);
    const versioned = await evaluator.report({ source: YAML }, context);
    return { report, passed, evaluated, versioned };
  }
  const pick = (report: ReturnType<typeof runTests>, testId: string) => ({
    mismatches: report.mismatches.filter((entry) => entry.testId === testId),
    unresolved: report.unresolved.filter((entry) => entry.testId === testId),
    routes: report.routes.filter((entry) => entry.testId === testId),
    structural: report.structural.filter((entry) => entry.testId === testId),
  });

  it("二点測定：台帳にある性質（when）は v1 に渡り、台帳に無い性質・未対応の性質は固定文の未解決（行き先 ambiguity）で v1 に渡らない", async () => {
    const control = await evaluateWith(OBSERVES);
    expect(control.passed.every((ids) => ids.includes("t-when-ok"))).toBe(true);
    for (const [observed, detail] of [
      ["enum-membership", LEDGER_OBSERVES_DETAILS.unregistered],
      ["other", LEDGER_OBSERVES_DETAILS.unregistered],
      ["state-after-set", LEDGER_OBSERVES_DETAILS.unsupported],
    ] as const) {
      const observes = new Map([...OBSERVES, ["t-when-ok", observed as TestObserves]]);
      const { report, passed, evaluated, versioned } = await evaluateWith(observes);
      expect(pick(report, "t-when-ok"), observed).toEqual({
        mismatches: [],
        unresolved: [{ testId: "t-when-ok", detail }],
        routes: [{ testId: "t-when-ok", route: "ambiguity", detail }],
        structural: [],
      });
      expect(passed.length, observed).toBeGreaterThan(0);
      for (const ids of passed) expect(ids, observed).not.toContain("t-when-ok");
      // ほかの試験の結果は対照と同じ。B5 の道具・版の再検査も同じ結果
      for (const test of SUITE.tests.filter((entry) => entry.id !== "t-when-ok")) {
        expect(pick(report, test.id), test.id).toEqual(pick(control.report, test.id));
      }
      expect(evaluated.testRun).toEqual(report);
      expect(versioned.testRun).toEqual(report);
      // 固定文は性質の値を埋めない
      expect(detail).not.toContain(observed);
    }
  });

  it("未解決の行き先は、写像に無い試験（今の v1 の no-mapping の未解決）と同じ ambiguity。構造の検査は構造の記録も未解決", async () => {
    const unmapped = await evaluateWith(observesWithout("t-shows"));
    const unregistered = await evaluateWith(new Map([...OBSERVES, ["t-shows", "enum-membership" as TestObserves]]));
    expect(pick(unregistered.report, "t-shows").routes.map((entry) => entry.route)).toEqual(
      pick(unmapped.report, "t-shows").routes.map((entry) => entry.route),
    );
    expect(pick(unregistered.report, "t-shows").structural).toEqual([
      { testId: "t-shows", requirementId: "R2", check: "view-shows", result: "unresolved", detail: LEDGER_OBSERVES_DETAILS.unregistered },
    ]);
  });

  it("台帳の行の照合の名前が評価口の表に無ければ未解決（固定文）で v1 に渡らない", async () => {
    const rows = PROPERTY_LEDGER.map((row) => (row.id === "when" ? { ...row, evaluation: "no-such-evaluation" } : row));
    const { report, passed } = await evaluateWith(OBSERVES, deriveLedgerView(rows));
    for (const testId of ["t-when-ok", "t-when-bad"]) {
      expect(pick(report, testId).unresolved).toEqual([{ testId, detail: LEDGER_OBSERVES_DETAILS.unknownEvaluation }]);
      for (const ids of passed) expect(ids).not.toContain(testId);
    }
  });

  it("写像に無い試験は on でも今と同じ固定文の未解決", async () => {
    const { report } = await evaluateWith(observesWithout("t-rate"));
    expect(pick(report, "t-rate").unresolved).toEqual([{ testId: "t-rate", detail: UNMAPPED_OBSERVES_DETAIL }]);
  });

  it("評価口の表は台帳の有効の行の照合の名前を全部持ち、v1 の振り分けと既定値の関数を指す", () => {
    expect(Object.keys(V11A_EVALUATION_JUDGES)).toEqual([...V11A_EVALUATION_NAMES]);
    expect(V11A_EVALUATION_JUDGES["v1-run-tests"].kind).toBe("v1");
    expect(V11A_EVALUATION_JUDGES["default-value"].kind).toBe("judge");
    expect(createV11aEvaluator).toBeTypeOf("function");
  });
});
