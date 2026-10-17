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
import { UNMAPPED_OBSERVES_DETAIL, createV11aEvaluator } from "./evaluate.js";
import type { TestObserves } from "./stages/test-spec.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("通る版", () => {
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

describe("観測する性質の写像（observes。必須。Issue #526）", () => {
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
