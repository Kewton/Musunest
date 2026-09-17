// 精算（`settle`）の unit テスト（Issue #108）。
//
// ここで固定したいのは 5 つ。
//   1. **窓口が受入条件に名指しした数字**（1000 円を 3 人で割ったときの基準額・負担・差し引き・送金の順）
//   2. 正当な入力では、送金が正・自己送金が無い・送金後の各人の差し引きが 0・件数が高々 n − 1
//   3. 同額は登録順・一組ごとに残額で並べ直す・同じ入力からは同じ並び（決定 3。2026-09-16 窓口）
//   4. 非数値・非有限値・合計の不一致は、成功の精算結果にしない
//   5. 見本 warikan（正本は採点のシナリオ）の精算が、受入条件の 1 件（C → A 3000）になる
//
// 期待値は見本の隣の採点のシナリオ（appspec-schema の正本）から読む。ここに写すと、
// 見本やシナリオを直したときに片方だけが古くなる。窓口が受入条件に書いた数字は、突き合わせたうえで別の it に書く。
import { describe, expect, it } from "vitest";
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { readScoringScenario } from "@musunest/appspec-schema";
import { sampleScenarioFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import type { SourceRecord, SourceRecords } from "./aggregate.js";
import { allocateExpense } from "./allocation.js";
import { normalizeSpec } from "./normalize.js";
import {
  settle,
  settlementBalances,
  settleEntity,
  type SettleExpense,
  type SettleMember,
} from "./settle.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;
const read = (url: URL): string => fs.readFileSync(url, "utf8");

/** 差し引き額を渡すだけの、最小の入力（並びは**登録順**である） */
const members = (...balances: readonly number[]): readonly SettleMember[] =>
  balances.map((balance, index) => ({ id: `m${index + 1}`, balance }));

/** 送金の並びを、`from → to 金額` の文字列にして比べる（並びまで見る） */
const lines = (transfers: readonly { from: string; to: string; amount: number }[]): string[] =>
  transfers.map((entry) => `${entry.from}→${entry.to} ${entry.amount}`);

/** 登録順の ID → 順（余りの担当を決めるのに使う） */
const orderOf = (...ids: readonly string[]): ReadonlyMap<string, number> =>
  new Map(ids.map((id, index) => [id, index]));

const A_BILL: SettleExpense = { amount: 1000, payer: "a", participants: ["a", "b", "c"] };

// ── 1. 受入条件の数字 ───────────────────────────────────────────

describe("受入条件の数字（2026-09-17 窓口）", () => {
  it("メンバー 0 人・全員の差し引きが 0 なら、送金は空の並びである", () => {
    expect(settle([])).toEqual({ ok: true, transfers: [] });
    expect(settle(members(0, 0, 0))).toEqual({ ok: true, transfers: [] });
  });

  it("1 人だけで払い、その人が負担した支出も、送金は空の並びである", () => {
    // A が 1000 円を払い、A だけで割る（差し引きは 0）
    const balances = settlementBalances(["a"], [{ amount: 1000, payer: "a", participants: ["a"] }]);
    expect(balances).toEqual([0]);
    expect(settle(members(...(balances ?? []))).ok).toBe(true);
    expect(settle(members(...(balances ?? [])))).toEqual({ ok: true, transfers: [] });
  });

  it("1000 円を A が払い A/B/C で割ると、基準額 333・負担 A=334/B=333/C=333", () => {
    // 割る人を書いた並びは A・B・C である（余りは払った人 A が持つ）
    const allocation = allocateExpense({ amount: 1000, payer: "a", participants: ["a", "b", "c"] }, orderOf("a", "b", "c"));
    expect(allocation?.base).toBe(333);
    expect(allocation?.remainder).toBe(1);
    expect(allocation?.bearer).toBe("a");
    expect(Object.fromEntries(allocation?.burden ?? [])).toEqual({ a: 334, b: 333, c: 333 });
    // 負担の合計は、支出の額とちょうど一致する
    expect([...(allocation?.burden.values() ?? [])].reduce((sum, value) => sum + value, 0)).toBe(1000);
  });

  it("1000 円を A が払い A/B/C で割ると、差し引きは A=666/B=-333/C=-333、送金は B→A 333 と C→A 333 の順", () => {
    const balances = settlementBalances(["a", "b", "c"], [A_BILL]);
    expect(balances).toEqual([666, -333, -333]);
    const result = settle(members(...(balances ?? [])));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lines(result.transfers)).toEqual(["m2→m1 333", "m3→m1 333"]);
  });

  it("登録順 A/B/C/D で D が 1000 円を払い、参加者を入力順 C/B/A にしても、負担は A=334/B=333/C=333/D=0", () => {
    // **余りの担当を、参加者の入力順（C/B/A）で決めない**。登録が最も早い参加者 A が持つ
    const expense: SettleExpense = { amount: 1000, payer: "d", participants: ["c", "b", "a"] };
    const allocation = allocateExpense(expense, orderOf("a", "b", "c", "d"));
    expect(allocation?.base).toBe(333);
    expect(allocation?.remainder).toBe(1);
    expect(allocation?.bearer).toBe("a");
    expect(Object.fromEntries(allocation?.burden ?? [])).toEqual({ a: 334, b: 333, c: 333 });
  });

  it("登録順 A/B/C/D で D が 1000 円を払うと、差し引きは D=1000・A=-334・B=-333・C=-333、送金は A→D 334・B→D 333・C→D 333", () => {
    const balances = settlementBalances(
      ["a", "b", "c", "d"],
      [{ amount: 1000, payer: "d", participants: ["c", "b", "a"] }],
    );
    expect(balances).toEqual([-334, -333, -333, 1000]);
    const result = settle(members(...(balances ?? [])));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lines(result.transfers)).toEqual(["m1→m4 334", "m2→m4 333", "m3→m4 333"]);
  });
});

// ── 2. 正当な入力の性質 ─────────────────────────────────────────

/** 2 支出を A が半分ずつ払う形（割り切れる） */
const EVEN: readonly SettleExpense[] = [
  { amount: 6000, payer: "a", participants: ["a", "b", "c"] },
  { amount: 3000, payer: "b", participants: ["a", "b", "c"] },
];

describe("正当な入力の性質（受入条件）", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const cases: readonly (readonly SettleExpense[])[] = [
    [],
    [A_BILL],
    [{ amount: 1000, payer: "d", participants: ["c", "b", "a"] }],
    EVEN,
    [{ amount: 1, payer: "a", participants: ids }],
    [{ amount: 999, payer: "e", participants: ids }],
    [
      { amount: 1000, payer: "a", participants: ["a", "b"] },
      { amount: 500, payer: "b", participants: ["b", "c"] },
      { amount: 300, payer: "c", participants: ["a", "c"] },
    ],
  ];

  it.each(cases.map((expenses, index) => [index, expenses] as const))(
    "事例 %i では、送金が正で・自己送金が無く・送金後の差し引きが全員 0 で・件数が高々 n − 1",
    (_index, expenses) => {
      const balances = settlementBalances(ids, expenses);
      expect(balances).not.toBeNull();
      const people = members(...(balances ?? []));
      const result = settle(people);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const rest = new Map(people.map((member) => [member.id, member.balance]));
      for (const entry of result.transfers) {
        expect(entry.amount).toBeGreaterThan(0);
        expect(Number.isFinite(entry.amount)).toBe(true);
        expect(entry.from).not.toBe(entry.to);
        expect(rest.has(entry.from)).toBe(true);
        expect(rest.has(entry.to)).toBe(true);
        rest.set(entry.from, (rest.get(entry.from) ?? 0) + entry.amount);
        rest.set(entry.to, (rest.get(entry.to) ?? 0) - entry.amount);
      }
      for (const value of rest.values()) expect(value).toBe(0);
      expect(result.transfers.length).toBeLessThanOrEqual(Math.max(people.length - 1, 0));
      // 差し引きが 0 の人は、送金に現れない
      for (const member of people) {
        if (member.balance !== 0) continue;
        expect(result.transfers.some((entry) => entry.from === member.id || entry.to === member.id)).toBe(false);
      }
    },
  );
});

// ── 3. 並びの決めごと（Q13・Q18-7） ──────────────────────────────

describe("送金の並び（Q13・Q18-7）", () => {
  it("同額の払う側は、メンバーの登録順になる（差し引きは A=+100・B=-200・C=+100）", () => {
    const result = settle(members(100, -200, 100));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // B の 200 は、同額（100）の A と C へ**登録順**に配る
    expect(lines(result.transfers)).toEqual(["m2→m1 100", "m2→m3 100"]);
  });

  it("一組を処理するたびに残額で並べ直す（Q18-7）", () => {
    // 素直に「最初に並べた順」で組むと D→A 5・D→B 2・C→B 3 になる。並べ直すと C が先に来る
    const result = settle(members(5, 5, -3, -7));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lines(result.transfers)).toEqual(["m4→m1 5", "m3→m2 3", "m4→m2 2"]);
  });

  it("同じ入力からは、同じ順・同じ値になる", () => {
    const first = settle(members(5, 5, -3, -7));
    const second = settle(members(5, 5, -3, -7));
    expect(second).toEqual(first);
  });
});

// ── 4. 成功の精算結果にしない入力 ────────────────────────────────

describe("成功の精算結果にしない入力", () => {
  it("数でない差し引き額は断る", () => {
    expect(settle([{ id: "a", balance: "0" as unknown as number }])).toEqual({
      ok: false,
      failure: "NOT_NUMBER",
    });
  });

  it("有限でない差し引き額は断る", () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(settle([{ id: "a", balance: value }]), String(value)).toEqual({
        ok: false,
        failure: "NOT_FINITE",
      });
    }
  });

  it("差し引きの合計が 0 でなければ断る（差額を誰かに寄せない）", () => {
    expect(settle(members(666, -333, -333, 1))).toEqual({ ok: false, failure: "NOT_BALANCED" });
    expect(settle(members(1))).toEqual({ ok: false, failure: "NOT_BALANCED" });
  });

  it("割れない支出（割る人が 0 人・知らない人・数でない額）があれば、差し引きを求めない", () => {
    expect(settlementBalances(["a"], [{ amount: 1000, payer: "a", participants: [] }])).toBeNull();
    expect(
      settlementBalances(["a"], [{ amount: 1000, payer: "a", participants: ["a", "unknown"] }]),
    ).toBeNull();
    expect(settlementBalances(["a"], [{ amount: 1000, payer: "unknown", participants: ["a"] }])).toBeNull();
  });
});

// ── 5. 宣言から（見本 warikan） ─────────────────────────────────

const WARIKAN = await (async (): Promise<NormalizedAppSpec> => {
  const result = await normalizeSpec(read(sampleSpecFile("warikan")));
  if (!result.ok) throw new Error("warikan が静的チェックに通らない");
  return result.app;
})();
const WARIKAN_SCENARIO = readScoringScenario(JSON.parse(read(sampleScenarioFile("warikan"))));

/** 集計の元になる 1 件（ID と項目） */
const row = (id: string, data: Readonly<Record<string, unknown>>): SourceRecord => ({ id, data });

/** 見本のシナリオの入力：メンバー A・B・C と、夕食（A が払い 3 人で割る）・タクシー（B が払い 3 人で割る） */
const A = row("m1", { name: "A" });
const B = row("m2", { name: "B" });
const C = row("m3", { name: "C" });
const DINNER = row("e1", { description: "夕食", amount: 6000, payer: "m1", participants: ["m1", "m2", "m3"] });
const TAXI = row("e2", { description: "タクシー", amount: 3000, payer: "m2", participants: ["m1", "m2", "m3"] });

const sources = (expenses: readonly SourceRecord[]): SourceRecords => ({
  member: [A, B, C],
  expense: expenses,
});

const settleMembers = (app: NormalizedAppSpec, expenses: readonly SourceRecord[] = [DINNER, TAXI]) =>
  settleEntity({ app, entity: "member", records: [A, B, C], sources: sources(expenses) });

describe("見本 warikan の精算（宣言から）", () => {
  it("差し引きは採点のシナリオの paid/owed/balance と一致し、精算は C → A 3000 の 1 件だけである", () => {
    const [a = {}, b = {}, c = {}] = WARIKAN_SCENARIO.views["memberList"] ?? [];
    // 差し引きは `paid - owed`（基準額の集計）である。割り切れる額なので、端数の負担は入らない
    expect(settlementBalances(["m1", "m2", "m3"], [expenseOf(DINNER), expenseOf(TAXI)])).toEqual([
      a["balance"],
      b["balance"],
      c["balance"],
    ]);
    const result = settleMembers(WARIKAN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lines(result.transfers)).toEqual(["m3→m1 3000"]);
  });

  it("支出が 0 件・1 件でも、送金は決まった形になる", () => {
    expect(settleMembers(WARIKAN, [])).toEqual({ ok: true, transfers: [] });
    const dinner = settleMembers(WARIKAN, [DINNER]);
    expect(dinner.ok).toBe(true);
    if (!dinner.ok) return;
    // 夕食だけなら、A が 4000 受け取り、B と C が 2000 ずつ払う（同額なので登録順）
    expect(lines(dinner.transfers)).toEqual(["m2→m1 2000", "m3→m1 2000"]);
  });

  it("精算を宣言していない entity では、空の並びを返す", () => {
    expect(settleEntity({ app: WARIKAN, entity: "expense", records: [DINNER], sources: sources([DINNER]) })).toEqual({
      ok: true,
      transfers: [],
    });
  });

  it("読めない支出の行があれば、空の並びに読み替えずに断る", () => {
    // 有限でない額は入力の検査が断るので、**保存された行**として直接置く（壊れた成果物でも 0 に読み替えない）
    const broken = row("e9", { description: "壊れた", amount: Number.POSITIVE_INFINITY, payer: "m1", participants: ["m1"] });
    expect(settleMembers(WARIKAN, [DINNER, broken])).toEqual({ ok: false, failure: "NOT_FINITE" });
  });
});

/** 支出の行を、宣言が指す項目（amount・payer・participants）だけの形にする */
function expenseOf(source: SourceRecord): SettleExpense {
  return {
    amount: Number(source.data["amount"]),
    payer: String(source.data["payer"]),
    participants: (source.data["participants"] as readonly string[]) ?? [],
  };
}
