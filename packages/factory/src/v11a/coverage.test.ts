// 網羅の単位と棄却のあとの網羅（v11a/coverage.ts）の unit テスト（07-architecture-v1.1a.md §1.3・D6。Issue #505）。
//
// §1.3 の負例のうちコードで閉じる 5 つ（全棄却・一部棄却（正常だけ残る）・X だけ残る・同じ画面の view-shows の
// Y だけを失う・同じ check を求める別の対象を失う）で、失った要件が返ることを固定する。
import { describe, expect, it } from "vitest";
import type {
  FixedTest,
  RequirementNature,
  StructuralAssertion,
  TestKind,
  TestOperation,
  TestSuite,
  TestTargetKind,
} from "../fixed-test.js";
import { coverageUnitKey, coverageUnitsOf, lostCoverage, type CoverageInput } from "./coverage.js";

const valueTest = (
  id: string,
  requirementId: string,
  roleId: string,
  kind: TestKind,
  operation: TestOperation = "compute",
  targetKind: TestTargetKind = "field",
): FixedTest => ({
  id,
  target: { requirementId, kind: targetKind, roleId },
  kind,
  operation,
  clock: "2026-09-16T12:00:00+09:00",
  input: null,
  referenceData: [],
  expected: { kind: "ok", value: null },
});

const structureTest = (
  id: string,
  requirementId: string,
  roleId: string,
  targetKind: TestTargetKind,
  assertion: StructuralAssertion,
): FixedTest => ({
  id,
  target: { requirementId, kind: targetKind, roleId },
  kind: "normal",
  operation: "structure",
  clock: "2026-09-16T12:00:00+09:00",
  input: null,
  referenceData: [],
  expected: { kind: "ok", value: true },
  assertion,
});

/** 固定時の組：RA（ruled）は X・Y の正常・異常・境界、RS は同じ画面の view-shows(X)・view-shows(Y)、RO は 2 つの操作の action-kind */
const SAVED_TESTS: readonly FixedTest[] = [
  valueTest("ra-x-n", "RA", "X", "normal"),
  valueTest("ra-x-a", "RA", "X", "abnormal"),
  valueTest("ra-x-b", "RA", "X", "boundary"),
  valueTest("ra-y-n", "RA", "Y", "normal"),
  valueTest("ra-y-a", "RA", "Y", "abnormal"),
  valueTest("ra-y-b", "RA", "Y", "boundary"),
  structureTest("rs-x", "RS", "S", "screen", { check: "view-shows", role: "X" }),
  structureTest("rs-y", "RS", "S", "screen", { check: "view-shows", role: "Y" }),
  structureTest("ro-add", "RO", "O1", "operation", { check: "action-kind", expected: "create" }),
  structureTest("ro-close", "RO", "O2", "operation", { check: "action-kind", expected: "create" }),
];

const NATURES: ReadonlyMap<string, RequirementNature> = new Map([
  ["RA", "ruled"],
  ["RS", "existence-only"],
  ["RO", "existence-only"],
  ["RE", "existence-only"],
]);

const observesOf = (tests: readonly FixedTest[]): ReadonlyMap<string, string> =>
  new Map(tests.filter((test) => test.operation !== "structure").map((test) => [test.id, "value"] as const));

const inputOf = (tests: readonly FixedTest[], observes = observesOf(SAVED_TESTS)): CoverageInput => ({
  suite: { tests } satisfies TestSuite,
  observes,
  natures: NATURES,
});

const saved = coverageUnitsOf(inputOf(SAVED_TESTS));
const without = (...ids: readonly string[]) => SAVED_TESTS.filter((test) => !ids.includes(test.id));
const lostIds = (remaining: readonly FixedTest[]) => lostCoverage(saved, inputOf(remaining)).map((loss) => loss.requirementId);

describe("棄却のあとの網羅：失った要件を返す（07 §1.3）", () => {
  it("棄却の無い組は、失った要件 0", () => {
    expect(lostCoverage(saved, inputOf(SAVED_TESTS))).toEqual([]);
  });

  it("全棄却：全部の要件が単位を失う", () => {
    expect(lostIds([])).toEqual(["RA", "RS", "RO"]);
  });

  it("一部棄却（正常だけ残る）：異常・境界の単位を失った要件が返る", () => {
    const losses = lostCoverage(saved, inputOf(without("ra-x-a", "ra-x-b", "ra-y-a", "ra-y-b")));
    expect(losses.map((loss) => loss.requirementId)).toEqual(["RA"]);
    expect(losses[0]?.units).toHaveLength(4);
  });

  it("X だけ残る（Y の単位を全部失う）：X の正常・異常・境界が残っても返る", () => {
    const losses = lostCoverage(saved, inputOf(without("ra-y-n", "ra-y-a", "ra-y-b")));
    expect(losses.map((loss) => loss.requirementId)).toEqual(["RA"]);
    expect(losses[0]?.units.every((unit) => unit.targetId === "Y")).toBe(true);
  });

  it("同じ画面の view-shows(X)・view-shows(Y) のうち Y だけを失うと返る（check 名だけの単位では見逃す）", () => {
    const losses = lostCoverage(saved, inputOf(without("rs-y")));
    expect(losses.map((loss) => loss.requirementId)).toEqual(["RS"]);
    expect(losses[0]?.units).toHaveLength(1);
  });

  it("同じ check を求める別の対象を失うと返る", () => {
    const losses = lostCoverage(saved, inputOf(without("ro-close")));
    expect(losses.map((loss) => loss.requirementId)).toEqual(["RO"]);
    expect(losses[0]?.units.map((unit) => unit.targetId)).toEqual(["O2"]);
  });
});

describe("単位の鍵（固定時と棄却後で同じ関数）", () => {
  it("固定時と棄却後の鍵は同じ関数から出て等しい", () => {
    const again = coverageUnitsOf(inputOf(SAVED_TESTS));
    expect(again).toEqual(saved);
    for (const test of SAVED_TESTS) {
      const key = coverageUnitKey(test, observesOf(SAVED_TESTS), NATURES);
      expect(saved.some((unit) => unit.key === key), test.id).toBe(true);
    }
    expect(saved).toHaveLength(SAVED_TESTS.length);
  });

  it("操作か observes だけが違う 2 試験は別の単位", () => {
    const byOperation = [valueTest("p", "RA", "X", "normal", "compute"), valueTest("q", "RA", "X", "normal", "aggregate")];
    expect(coverageUnitsOf(inputOf(byOperation, observesOf(byOperation)))).toHaveLength(2);
    const sameOperation = [valueTest("p", "RA", "X", "normal"), valueTest("q", "RA", "X", "normal")];
    const observes = new Map([
      ["p", "value"],
      ["q", "when"],
    ]);
    expect(coverageUnitsOf(inputOf(sameOperation, observes))).toHaveLength(2);
    // 対照：操作も observes も同じなら 1 つの単位
    expect(coverageUnitsOf(inputOf(sameOperation, observesOf(sameOperation)))).toHaveLength(1);
  });

  it("existence-only の要件は正常の試験だけが単位になる", () => {
    const tests = [valueTest("e-n", "RE", "X", "normal"), valueTest("e-a", "RE", "X", "abnormal")];
    const units = coverageUnitsOf(inputOf(tests, observesOf(tests)));
    expect(units).toHaveLength(1);
    expect(coverageUnitKey(tests[1]!, observesOf(tests), NATURES)).toBeNull();
  });

  it("観測する性質・要件の種類が引けなければ例外（単位を作らずに通さない）", () => {
    const test = valueTest("lonely", "RA", "X", "normal");
    expect(() => coverageUnitKey(test, new Map(), NATURES)).toThrow();
    expect(() => coverageUnitKey(test, new Map([["lonely", "value"]]), new Map())).toThrow();
  });
});
