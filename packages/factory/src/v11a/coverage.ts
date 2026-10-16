// 網羅の単位と、棄却のあとの網羅（B6。07-architecture-v1.1a.md §1.3・D6。Issue #505）。
//
// v1 の網羅の検査は要件ごとの種類の集合と check 名の集合しか見ない（`stages/test-suite.ts`）ので、1 要件の
// 対象 X・Y のうち Y の試験を全部棄却しても、X の正常・異常・境界が残れば通る。同じ画面の `view-shows(X)` と
// `view-shows(Y)` も 1 つの単位になる。v1.1α は固定時に、組が覆う**網羅の単位**を保存し、棄却のたびに
// 残った組へ掛け直す。単位の鍵は**検査の内容まで**含める：
//
//   - ruled … （要件・対象の `id`・正常／異常／境界・操作・`observes`）
//   - existence-only … （要件・対象の `id`・正常・操作・`observes`）。正常の試験だけが単位になる
//   - structural（操作 `structure`）… （要件・対象の `id`・正規化した assertion 全体＝check・expected・refEntity・role）
//
// `observes`（試験が観測する性質）は `FixedTest` に欄を足さず、**試験 ID → 性質の写像**で受ける。
// **固定時と棄却後で同じ鍵を同じ関数（`coverageUnitKey`）で作る**（v1 の `checkSuitePlan` の check 名の集合は
// 使わない）。入力が欠けていれば（性質・種類が引けない）例外で断る——単位を作らずに通さない。
//
// LLM を呼ばない純粋な関数だけを置く。
import type { FixedTest, RequirementNature, TestSuite } from "../fixed-test.js";
import { canonicalJson } from "./names.js";

/** 網羅の単位 1 つ（鍵と、鍵を作った欄） */
export interface CoverageUnit {
  readonly requirementId: string;
  readonly targetId: string;
  /** 単位の鍵（正規化 JSON。固定時と棄却後で同じ関数が作る） */
  readonly key: string;
}

/** 単位を作る入力（試験の組・試験 ID → 観測する性質・要件 ID → 種類） */
export interface CoverageInput {
  readonly suite: TestSuite;
  readonly observes: ReadonlyMap<string, string>;
  readonly natures: ReadonlyMap<string, RequirementNature>;
}

/** 単位を失った要件 1 つ（失った単位を添える） */
export interface CoverageLoss {
  readonly requirementId: string;
  readonly units: readonly CoverageUnit[];
}

/**
 * 1 件の試験の単位の鍵を作る（固定時も棄却後もこの関数だけが作る）。単位にならない試験（existence-only の
 * 正常でない試験）は `null`。性質・種類・対象の `id` が引けなければ例外。
 */
export function coverageUnitKey(
  test: FixedTest,
  observes: ReadonlyMap<string, string>,
  natures: ReadonlyMap<string, RequirementNature>,
): string | null {
  const requirementId = test.target.requirementId;
  const targetId = test.target.roleId;
  if (targetId === undefined || targetId === "") {
    throw new Error("網羅の単位：試験の対象の ID が無い");
  }
  if (test.operation === "structure") {
    const assertion = test.assertion;
    if (assertion === undefined) throw new Error("網羅の単位：構造の検査に assertion が無い");
    return canonicalJson({
      basis: "structure",
      requirementId,
      targetId,
      assertion: {
        check: assertion.check,
        expected: assertion.expected ?? null,
        refEntity: assertion.refEntity ?? null,
        role: assertion.role ?? null,
      },
    });
  }
  const nature = natures.get(requirementId);
  if (nature === undefined) throw new Error("網羅の単位：要件の種類が引けない");
  const observed = observes.get(test.id);
  if (observed === undefined || observed === "") throw new Error("網羅の単位：試験の観測する性質が引けない");
  if (nature === "existence-only" && test.kind !== "normal") return null;
  return canonicalJson({
    basis: "value",
    requirementId,
    targetId,
    kind: test.kind,
    operation: test.operation,
    observes: observed,
  });
}

/** 試験の組が覆う網羅の単位（鍵で重なりを 1 つにする。並びは試験の順） */
export function coverageUnitsOf(input: CoverageInput): readonly CoverageUnit[] {
  const seen = new Set<string>();
  const units: CoverageUnit[] = [];
  for (const test of input.suite.tests) {
    const key = coverageUnitKey(test, input.observes, input.natures);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    units.push({ requirementId: test.target.requirementId, targetId: test.target.roleId as string, key });
  }
  return units;
}

/**
 * 棄却のあと（B6）：保存した全単位を、残った組（`remaining`）に掛け直し、単位を 1 つでも失った要件を返す。
 * 残った組の単位は固定時と同じ `coverageUnitKey` で作る。並びは保存した単位の要件の順。
 */
export function lostCoverage(saved: readonly CoverageUnit[], remaining: CoverageInput): readonly CoverageLoss[] {
  const kept = new Set(coverageUnitsOf(remaining).map((unit) => unit.key));
  const lost = new Map<string, CoverageUnit[]>();
  for (const unit of saved) {
    if (kept.has(unit.key)) continue;
    const list = lost.get(unit.requirementId) ?? [];
    list.push(unit);
    lost.set(unit.requirementId, list);
  }
  return [...lost].map(([requirementId, units]) => ({ requirementId, units }));
}
