// 固定する試験の判別可能な型（02 §1.3・②'）の unit テスト。
//
// ここで固定したいのは 2 つ。
//   1. 種類・selector（要件 ID と役割）・操作・時計・参照データ・期待の形を確かめ、形の合う試験は固定できる
//   2. 形の合わない欄を断り、**どの欄か**を返す（名前ではなく要件 ID と役割で指すことも、ここで担保する）
import { describe, expect, it } from "vitest";
import { checkFixedTest, checkTestSuite, type FixedTest } from "./fixed-test.js";

const VALID = {
  id: "test-1",
  target: { requirementId: "R-1", kind: "computation", role: "合計を出す計算" },
  kind: "normal",
  operation: "compute",
  clock: "2026-09-16T12:00:00+09:00",
  input: { left: 1, right: 2 },
  referenceData: [
    { target: { requirementId: "R-2", kind: "entity", role: "参照する行" }, values: { amount: 10 } },
  ],
  expected: { kind: "ok", value: 3 },
};

const problemFields = (value: unknown): readonly string[] => {
  const checked = checkFixedTest(value);
  return checked.ok ? [] : checked.problems.map((problem) => problem.field);
};

describe("固定する試験の型（02 §1.3・②'）", () => {
  it("形の合う試験は、型の付いた試験として固定できる", () => {
    const checked = checkFixedTest(VALID);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.test).toEqual(VALID);
  });

  it("期待が誤りコードでもよい（異常の試験）", () => {
    const checked = checkFixedTest({ ...VALID, kind: "abnormal", expected: { kind: "error", code: "E_1" } });
    expect(checked.ok).toBe(true);
  });

  it("時計は Z のオフセットでもよい", () => {
    expect(checkFixedTest({ ...VALID, clock: "2026-09-16T12:00:00Z" }).ok).toBe(true);
  });

  it("種類・selector・操作・時計・参照データ・期待の形が合わなければ断る", () => {
    expect(problemFields({ ...VALID, kind: "unknown" })).toContain("kind");
    expect(problemFields({ ...VALID, target: { ...VALID.target, kind: "wrong" } })).toContain("target.kind");
    expect(problemFields({ ...VALID, target: { ...VALID.target, requirementId: "" } })).toContain(
      "target.requirementId",
    );
    expect(problemFields({ ...VALID, target: { ...VALID.target, role: "" } })).toContain("target.role");
    expect(problemFields({ ...VALID, operation: "wrong" })).toContain("operation");
    // オフセットの無い時刻は断る（環境の時間帯で別の瞬間になる）
    expect(problemFields({ ...VALID, clock: "2026-09-16T12:00:00" })).toContain("clock");
    expect(problemFields({ ...VALID, referenceData: "nope" })).toContain("referenceData");
    expect(
      problemFields({ ...VALID, referenceData: [{ target: VALID.target, values: 3 }] }),
    ).toContain("referenceData[0].values");
    expect(problemFields({ ...VALID, expected: { kind: "error" } })).toContain("expected.code");
    expect(problemFields({ ...VALID, expected: { kind: "nope" } })).toContain("expected.kind");
    expect(problemFields({ ...VALID, id: "" })).toContain("id");
  });

  it("対象・入力が無ければ断る", () => {
    const { target, ...withoutTarget } = VALID;
    const { input, ...withoutInput } = VALID;
    expect(target).toBeDefined();
    expect(input).toBeDefined();
    expect(problemFields(withoutTarget)).toContain("target");
    expect(problemFields(withoutInput)).toContain("input");
  });

  it("写像でない値は断る", () => {
    expect(checkFixedTest("nope").ok).toBe(false);
    expect(checkFixedTest(null).ok).toBe(false);
  });

  it("試験の組は、形の合わない件を欄つきで断る", () => {
    const ok = checkTestSuite([VALID]);
    expect(ok.ok).toBe(true);
    const bad = checkTestSuite([{ ...VALID, kind: "unknown" }]);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((problem) => problem.field)).toContain("tests[0].kind");
  });

  it("固定した試験の型は、参照データ・期待・時計を持つ（判別できる）", () => {
    const checked = checkFixedTest(VALID);
    if (!checked.ok) throw new Error("前提が壊れた");
    const fixed: FixedTest = checked.test;
    expect(fixed.kind).toBe("normal");
    expect(fixed.target.kind).toBe("computation");
    expect(fixed.expected.kind).toBe("ok");
    expect(fixed.clock).toContain("+09:00");
  });
});
