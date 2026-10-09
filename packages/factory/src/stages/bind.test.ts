// ⑤b 結び付け（stages/bind.ts）の unit テスト（02 §1・§1.3）。
//
// ここで固定したいのは 2 つ。
//   1. selector が当たる要素が 0 個・1 個・2 個以上のとき、それぞれ
//      不一致（理由つき）・結び付け・不一致（理由つき）になること
//   2. selector の種類が、どの場所の種類に当たるか（検査は validation、操作は action、画面は view）
import { describe, expect, it } from "vitest";
import { checkFixedTest, checkTestSuite, type FixedTest, type TestSuite } from "../fixed-test.js";
import type {
  CorrespondenceEntry,
  CorrespondenceResult,
  TestOperation,
  TestTargetKind,
} from "../pipeline.js";
import { bindTests, locationKindFor } from "./bind.js";
import { fixedTest } from "./__tests__/prompt.js";

function suiteOf(tests: readonly unknown[]): TestSuite {
  const checked = checkTestSuite(tests);
  if (!checked.ok) {
    throw new Error(`前提が壊れた: ${checked.problems.map((problem) => problem.field).join("・")}`);
  }
  return checked.suite;
}

/** 種類と操作だけを決めた、型の付いた 1 件の試験（`locationKindFor` を測るのに使う） */
function typedTest(targetKind: TestTargetKind, operation: TestOperation): FixedTest {
  const checked = checkFixedTest({
    id: "t",
    target: { requirementId: "R-1", kind: targetKind, role: "役割" },
    kind: "normal",
    operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: null,
    referenceData: [],
    expected: { kind: "ok", value: null },
  });
  if (!checked.ok) throw new Error("前提が壊れた");
  return checked.test;
}

const entry = (
  requirementId: string,
  locations: readonly CorrespondenceEntry["locations"][number][],
): CorrespondenceEntry => ({ requirementId, locations });

/** 対応表（落ちはここでは扱わない。結び付けだけを見る） */
const correspondence = (entries: readonly CorrespondenceEntry[]): CorrespondenceResult => ({
  entries,
  misses: [],
});

/** R-2（計算を対象にする 1 件の試験） */
const computationTest = () =>
  fixedTest("t1", "R-2", "computation", "合計を出す計算", "normal", "compute");

describe("selector が当たる要素の数で決める（02 §1.3）", () => {
  it("1 個に当たれば結び付ける", () => {
    const bindings = bindTests({
      suite: suiteOf([computationTest()]),
      correspondence: correspondence([
        entry("R-2", [{ kind: "computation", entity: "record", name: "total" }]),
      ]),
    });
    expect(bindings).toHaveLength(1);
    const [binding] = bindings;
    expect(binding?.kind).toBe("bound");
    if (binding?.kind !== "bound") return;
    expect(binding.location).toEqual({ kind: "computation", entity: "record", name: "total" });
  });

  it("0 個（種類が違う場所しか無い）なら、理由つきで結び付けない", () => {
    const bindings = bindTests({
      suite: suiteOf([computationTest()]),
      correspondence: correspondence([entry("R-2", [{ kind: "field", entity: "record", name: "amount" }])]),
    });
    const [binding] = bindings;
    expect(binding?.kind).toBe("unbound");
    if (binding?.kind !== "unbound") return;
    expect(binding.detail).toContain("当たる");
    expect(binding.detail).toContain("無い");
  });

  it("2 個以上に当たれば、理由つきで結び付けない（1 つに決まらない）", () => {
    const bindings = bindTests({
      suite: suiteOf([computationTest()]),
      correspondence: correspondence([
        entry("R-2", [
          { kind: "computation", entity: "record", name: "total" },
          { kind: "computation", entity: "record", name: "hidden" },
        ]),
      ]),
    });
    const [binding] = bindings;
    expect(binding?.kind).toBe("unbound");
    if (binding?.kind !== "unbound") return;
    expect(binding.detail).toContain("1 つに決まらない");
    expect(binding.detail).toContain("2 個");
  });

  it("対応表の項目が無ければ、理由つきで結び付けない", () => {
    const bindings = bindTests({
      suite: suiteOf([computationTest()]),
      correspondence: correspondence([]),
    });
    const [binding] = bindings;
    expect(binding?.kind).toBe("unbound");
    if (binding?.kind !== "unbound") return;
    expect(binding.detail).toContain("対応表の項目が無い");
  });
});

describe("selector の種類が当たる場所の種類（02 §1.3）", () => {
  it("検査は validation・操作は action・画面は view に当たる", () => {
    expect(locationKindFor(typedTest("entity", "validate"))).toBe("validation");
    expect(locationKindFor(typedTest("operation", "action"))).toBe("action");
    expect(locationKindFor(typedTest("screen", "screen"))).toBe("view");
    expect(locationKindFor(typedTest("computation", "compute"))).toBe("computation");
    expect(locationKindFor(typedTest("entity", "compute"))).toBe("entity");
    expect(locationKindFor(typedTest("field", "compute"))).toBe("field");
  });
});
