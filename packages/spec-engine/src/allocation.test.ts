// 割り勘の端数（Q13。語彙ではなく店頭の内部規約）の unit テスト（Issue #108）。
//
// ここで固定したいのは 4 つ。
//   1. 1 人あたりの基準額は **1 円未満を切り捨てる**（`amount / 人数` の小数をそのまま使わない）
//   2. 余りは、**払った人が割る人に入っていれば払った人**が、入っていなければ
//      **割る人のうち登録が最も早い人**が負担する（**入力の並び順では決めない**）
//   3. 人ごとの負担の合計は、**支出の額とちょうど一致する**（余りを 1 円ずつ配るのではない）
//   4. 割れない入力（0 人・知らない人・有限でない額・負の額）は `null` にする（0 に読み替えない）
import { describe, expect, it } from "vitest";
import { allocateExpense, type SettleExpense } from "./allocation.js";

const order = (...ids: readonly string[]): ReadonlyMap<string, number> =>
  new Map(ids.map((id, index) => [id, index]));

const burdenOf = (expense: SettleExpense, ...ids: readonly string[]): Readonly<Record<string, number>> =>
  Object.fromEntries(allocateExpense(expense, order(...ids))?.burden ?? []);

describe("基準額と余り（Q13）", () => {
  it("割り切れるときは、余りが 0 で基準額がそのまま負担になる", () => {
    const allocation = allocateExpense({ amount: 6000, payer: "a", participants: ["a", "b", "c"] }, order("a", "b", "c"));
    expect(allocation?.base).toBe(2000);
    expect(allocation?.remainder).toBe(0);
    expect([...(allocation?.burden.values() ?? [])]).toEqual([2000, 2000, 2000]);
  });

  it("1 円未満は切り捨てる（1000 円を 3 人なら基準額 333・余り 1）", () => {
    const allocation = allocateExpense({ amount: 1000, payer: "a", participants: ["a", "b", "c"] }, order("a", "b", "c"));
    // 333.33… をそのまま負担にしない
    expect(allocation?.base).toBe(333);
    expect(allocation?.remainder).toBe(1);
  });

  it("負担の合計は、支出の額とちょうど一致する（余りを 1 円ずつ配るのではない）", () => {
    for (const [amount, people] of [
      [1000, 3],
      [999, 5],
      [1, 5],
      [100, 7],
    ] as const) {
      const ids = Array.from({ length: people }, (_value, index) => `m${index + 1}`);
      const allocation = allocateExpense({ amount, payer: ids[0] ?? "", participants: ids }, order(...ids));
      const total = [...(allocation?.burden.values() ?? [])].reduce((sum, value) => sum + value, 0);
      expect(total, `${amount} 円を ${people} 人`).toBe(amount);
      expect(allocation?.base).toBe(Math.floor(amount / people));
      expect(allocation?.remainder).toBe(amount - Math.floor(amount / people) * people);
      expect(allocation?.remainder).toBeLessThan(people);
      // 余りを持つ人は 1 人だけである
      const extra = [...(allocation?.burden.values() ?? [])].filter((value) => value === (allocation?.base ?? 0) + (allocation?.remainder ?? 0));
      expect(extra).toHaveLength(allocation?.remainder === 0 ? 0 : 1);
    }
  });

  it("余りは、払った人が割る人に入っていれば払った人（A が払い、割る人は A・B・C）", () => {
    const allocation = allocateExpense({ amount: 1000, payer: "a", participants: ["a", "b", "c"] }, order("a", "b", "c"));
    expect(allocation?.bearer).toBe("a");
    expect(burdenOf({ amount: 1000, payer: "a", participants: ["a", "b", "c"] }, "a", "b", "c")).toEqual({
      a: 334,
      b: 333,
      c: 333,
    });
  });

  it("払った人が割る人に入っていなければ、**登録が最も早い割る人**が余りを持つ（入力の並び順では決めない）", () => {
    const expense: SettleExpense = { amount: 1000, payer: "d", participants: ["c", "b", "a"] };
    const allocation = allocateExpense(expense, order("a", "b", "c", "d"));
    // 並びの先頭は C だが、登録が最も早いのは A である
    expect(allocation?.bearer).toBe("a");
    expect(burdenOf(expense, "a", "b", "c", "d")).toEqual({ a: 334, b: 333, c: 333 });
  });

  it("割る人が 1 人なら、その人が全部を負担する（余りは 0 である）", () => {
    const allocation = allocateExpense({ amount: 1000, payer: "b", participants: ["a"] }, order("a", "b"));
    expect(allocation?.base).toBe(1000);
    expect(allocation?.remainder).toBe(0);
    expect(allocation?.bearer).toBe("a");
    expect(burdenOf({ amount: 1000, payer: "b", participants: ["a"] }, "a", "b")).toEqual({ a: 1000 });
  });
});

describe("割れない入力", () => {
  it.each([
    ["割る人が 0 人", { amount: 1000, payer: "a", participants: [] }],
    ["割る人に知らない人", { amount: 1000, payer: "a", participants: ["a", "unknown"] }],
    ["有限でない額", { amount: Number.POSITIVE_INFINITY, payer: "a", participants: ["a"] }],
    ["数でない額", { amount: "1000" as unknown as number, payer: "a", participants: ["a"] }],
    ["負の額", { amount: -1000, payer: "a", participants: ["a"] }],
  ] as const)("%s なら null にする（0 に読み替えない）", (_label, expense) => {
    expect(allocateExpense(expense, order("a"))).toBeNull();
  });
});
