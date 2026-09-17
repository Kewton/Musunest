// entity をまたぐ集計（`sum`・`count`。Issue #107）の評価の unit テスト。
//
// ここで固定したいのは 7 つ。
//   1. 見本 warikan の集計値が、採点のシナリオ（正本）の期待値と一致する（A・B・C と 2 支出）
//   2. `count <entity> where ...` が該当行数を返す（参照の一致と、参照の並びの包含）
//   3. 支出 0 件・該当行 0 件の sum/count はどちらも 0 である
//   4. where に合わない支出・別インスタンスの支出を足しても、対象メンバーの値は変わらない
//   5. computed の宣言順を入れ替えても、依存関係が同じなら結果が同じである
//   6. **集計元に `null` が 1 つでもあれば、合計も `null`** である（空集合の 0 と区別する）
//   7. 集計の元のレコードは、渡された `sources` の外へは出ない（同じインスタンスのものだけを見る）
//
// 期待値は見本の隣の採点のシナリオ（appspec-schema の正本）から読む。ここに写すと、
// 見本やシナリオを直したときに片方だけが古くなる。窓口が受入条件に書いた数字は、突き合わせたうえで別の it に書く。
import { describe, expect, it } from "vitest";
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { readScoringScenario } from "@musunest/appspec-schema";
import { sampleScenarioFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import type { SourceRecord, SourceRecords } from "./aggregate.js";
import { aggregateSourceEntities, matchesWhere, sumValues } from "./aggregate.js";
import { fixedClock } from "./clock.js";
import { evaluateRecord, type Evaluation } from "./evaluate.js";
import { normalizeSpec } from "./normalize.js";

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;
const read = (url: URL): string => fs.readFileSync(url, "utf8");

/** 宣言を検査して正規化する。**評価の入口はこの成果物だけ**である（未検査の YAML は渡せない） */
const normalized = async (source: string): Promise<NormalizedAppSpec> => {
  const result = await normalizeSpec(source);
  if (!result.ok) {
    throw new Error(`正規化できない: ${result.diagnostics.map((d) => d.code).join(" / ")}`);
  }
  return result.app;
};

const WARIKAN = await normalized(read(sampleSpecFile("warikan")));
const WARIKAN_SCENARIO = readScoringScenario(JSON.parse(read(sampleScenarioFile("warikan"))));
const CLOCK = fixedClock(WARIKAN_SCENARIO.clock);

/** 集計の元の 1 件（ID と項目） */
const row = (id: string, data: Readonly<Record<string, unknown>>): SourceRecord => ({ id, data });

/** 見本のシナリオの入力：メンバー A・B・C と、夕食（A が払い 3 人で割る）・タクシー（B が払い 3 人で割る） */
const A = row("m1", { name: "A" });
const B = row("m2", { name: "B" });
const C = row("m3", { name: "C" });
const DINNER = row("e1", { description: "夕食", amount: 6000, payer: "m1", participants: ["m1", "m2", "m3"] });
const TAXI = row("e2", { description: "タクシー", amount: 3000, payer: "m2", participants: ["m1", "m2", "m3"] });

const sourceMap = (expenses: readonly SourceRecord[]): SourceRecords => ({
  member: [A, B, C],
  expense: expenses,
});

const evaluateMember = (
  app: NormalizedAppSpec,
  memberRow: SourceRecord,
  expenses: readonly SourceRecord[] = [DINNER, TAXI],
): Evaluation =>
  evaluateRecord({
    app,
    entity: "member",
    record: memberRow.data,
    recordId: memberRow.id,
    clock: CLOCK,
    sources: sourceMap(expenses),
  });

const evaluateExpense = (app: NormalizedAppSpec, expenseRow: SourceRecord): Evaluation =>
  evaluateRecord({
    app,
    entity: "expense",
    record: expenseRow.data,
    recordId: expenseRow.id,
    clock: CLOCK,
  });

// ── 見本 warikan（sum。受入条件の数字） ───────────────────────────

describe("見本 warikan の集計（A・B・C と 2 支出）", () => {
  it("採点のシナリオの期待値と一致する（shareAmount と paid/owed/balance）", () => {
    const [a = {}, b = {}, c = {}] = WARIKAN_SCENARIO.views["memberList"] ?? [];
    expect(evaluateMember(WARIKAN, A).computed).toEqual({
      paid: a["paid"],
      owed: a["owed"],
      balance: a["balance"],
    });
    expect(evaluateMember(WARIKAN, B).computed).toEqual({
      paid: b["paid"],
      owed: b["owed"],
      balance: b["balance"],
    });
    expect(evaluateMember(WARIKAN, C).computed).toEqual({
      paid: c["paid"],
      owed: c["owed"],
      balance: c["balance"],
    });
    // 支出 1 件ごとの計算（集計の対象 expense.shareAmount がこれである）
    expect(evaluateExpense(WARIKAN, DINNER).computed).toMatchObject({ headcount: 3, shareAmount: 2000 });
    expect(evaluateExpense(WARIKAN, TAXI).computed).toMatchObject({ headcount: 3, shareAmount: 1000 });
  });

  it("受入条件の数字：夕食 2000 / タクシー 1000 / A 6000・3000・3000 / B 3000・3000・0 / C 0・3000・−3000", () => {
    expect(evaluateExpense(WARIKAN, DINNER).computed["shareAmount"]).toBe(2000);
    expect(evaluateExpense(WARIKAN, TAXI).computed["shareAmount"]).toBe(1000);
    expect(evaluateMember(WARIKAN, A).computed).toEqual({ paid: 6000, owed: 3000, balance: 3000 });
    expect(evaluateMember(WARIKAN, B).computed).toEqual({ paid: 3000, owed: 3000, balance: 0 });
    expect(evaluateMember(WARIKAN, C).computed).toEqual({ paid: 0, owed: 3000, balance: -3000 });
  });

  it("計算の値は宣言の順に返る", () => {
    expect(Object.keys(evaluateMember(WARIKAN, A).computed)).toEqual(["paid", "owed", "balance"]);
  });

  it("集計が見るのは渡された sources だけであり、別インスタンスの支出を足しても値は変わらない", () => {
    // 同じインスタンスのレコードだけを渡すのは data-api の仕事である（この評価は sources をそのまま見る）
    expect(evaluateMember(WARIKAN, A, [DINNER]).computed["paid"]).toBe(6000);
    expect(evaluateMember(WARIKAN, A, []).computed["paid"]).toBe(0);
    // 別インスタンスの支出（このインスタンスのメンバーを指さない）を足しても、A の値は変わらない
    const foreign = row("o1", {
      description: "別の旅行",
      amount: 50000,
      payer: "m-elsewhere",
      participants: ["m-elsewhere"],
    });
    expect(evaluateMember(WARIKAN, A, [DINNER, TAXI, foreign]).computed).toEqual(
      evaluateMember(WARIKAN, A, [DINNER, TAXI]).computed,
    );
  });
});

// ── count（受入条件の試験） ─────────────────────────────────────

/** メンバーの集計だけを持つ、最小の宣言（count の 2 通りを試す） */
const COUNT_DECLARATION = [
  "entities:",
  "  - name: member",
  "    fields:",
  "      name: string",
  "  - name: expense",
  "    fields:",
  "      amount: number",
  "      payer:",
  "        type: ref",
  "        to: member",
  "      participants:",
  "        type: list",
  "        of: member",
  "views: []",
  "actions: []",
  "validations: []",
  "computed:",
  "  - name: paidCount",
  "    entity: member",
  "    aggregate:",
  "      count: expense",
  "      where:",
  "        payer: this",
  "    type: number",
  "  - name: shareCount",
  "    entity: member",
  "    aggregate:",
  "      count: expense",
  "      where:",
  "        participants:",
  "          contains: this",
  "    type: number",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const COUNT_APP = await normalized(COUNT_DECLARATION);

describe("count の集計（M1.2）", () => {
  it("count expense where payer=this は A=1・B=1・C=0", () => {
    expect(evaluateMember(COUNT_APP, A).computed["paidCount"]).toBe(1);
    expect(evaluateMember(COUNT_APP, B).computed["paidCount"]).toBe(1);
    expect(evaluateMember(COUNT_APP, C).computed["paidCount"]).toBe(0);
  });

  it("参加者 contains this の count は A/B/C とも 2", () => {
    expect(evaluateMember(COUNT_APP, A).computed["shareCount"]).toBe(2);
    expect(evaluateMember(COUNT_APP, B).computed["shareCount"]).toBe(2);
    expect(evaluateMember(COUNT_APP, C).computed["shareCount"]).toBe(2);
  });

  it("支出 0 件・該当行 0 件の sum/count はどちらも 0（null ではない）", () => {
    // 支出 0 件
    expect(evaluateMember(WARIKAN, A, []).computed).toEqual({ paid: 0, owed: 0, balance: 0 });
    expect(evaluateMember(COUNT_APP, A, []).computed).toEqual({ paidCount: 0, shareCount: 0 });
    // 支出はあるが、該当行 0 件（A が払ってもいないし、割ってもいない支出）
    const unrelated = [row("e9", { description: "他の人", amount: 500, payer: "m9", participants: ["m9"] })];
    expect(evaluateMember(WARIKAN, A, unrelated).computed).toEqual({ paid: 0, owed: 0, balance: 0 });
    expect(evaluateMember(COUNT_APP, A, unrelated).computed).toEqual({ paidCount: 0, shareCount: 0 });
  });

  it("where に合わない支出・別インスタンスの支出を足しても、対象メンバーの値は変わらない", () => {
    const before = evaluateMember(WARIKAN, A).computed;
    const extra = [
      DINNER,
      TAXI,
      // 別のメンバー（この sources に居ない）の支出
      row("e3", { description: "昼食", amount: 9999, payer: "m-other", participants: ["m-other"] }),
      // 別インスタンスの支出（同じ形だが ID が外）
      row("e4", { description: "別の旅行", amount: 5000, payer: "m-elsewhere", participants: ["m-elsewhere"] }),
    ];
    expect(evaluateMember(WARIKAN, A, extra).computed).toEqual(before);
    expect(evaluateMember(COUNT_APP, A, extra).computed).toEqual({ paidCount: 1, shareCount: 2 });
  });
});

// ── 宣言順と null（受入条件の残り） ───────────────────────────────

/** メンバーの集計 1 つ（sum か count）を組み立てる */
const memberAggregate = (name: string, body: readonly string[]): string =>
  [
    `  - name: ${name}`,
    "    entity: member",
    "    aggregate:",
    ...body.map((line) => `      ${line}`),
    "    type: number",
  ].join("\n");

const PAID = memberAggregate("paid", ["sum: expense.amount", "where:", "  payer: this"]);
const OWED = memberAggregate("owed", [
  "sum: expense.shareAmount",
  "where:",
  "  participants:",
  "    contains: this",
]);
const BALANCE = [
  "  - name: balance",
  "    entity: member",
  "    expression: paid - owed",
  "    type: number",
].join("\n");

/** 支出 1 件ごとの計算（集計の対象。順を変えても壊れないことを見る） */
const EXPENSE_COMPUTED = [
  ["  - name: headcount", "    entity: expense", "    expression: len(participants)", "    type: number"].join(
    "\n",
  ),
  [
    "  - name: shareAmount",
    "    entity: expense",
    "    expression: amount / max(1, headcount)",
    "    type: number",
  ].join("\n"),
];

/** メンバーの計算の並びだけを差し替えた宣言（ほかは同じ） */
const declarationWithOrder = (memberOrder: readonly string[]): string =>
  [
    "entities:",
    "  - name: member",
    "    fields:",
    "      name: string",
    "  - name: expense",
    "    fields:",
    "      description: string",
    "      amount: number",
    "      payer:",
    "        type: ref",
    "        to: member",
    "      participants:",
    "        type: list",
    "        of: member",
    "views: []",
    "actions: []",
    "validations: []",
    "computed:",
    ...EXPENSE_COMPUTED,
    ...memberOrder,
    "permissions:",
    "  - name: read",
    "    subject: minIdentity",
    "  - name: write",
    "    subject: minIdentity",
    "minIdentity:",
    "  mode: anonymous",
    "",
  ].join("\n");

describe("宣言順と null（M1.2）", () => {
  it("computed の宣言順を入れ替えても、依存関係が同じなら結果が同じである", async () => {
    const forward = await normalized(declarationWithOrder([PAID, OWED, BALANCE]));
    const backward = await normalized(declarationWithOrder([BALANCE, OWED, PAID]));
    for (const [memberRow, expected] of [
      [A, { paid: 6000, owed: 3000, balance: 3000 }],
      [B, { paid: 3000, owed: 3000, balance: 0 }],
      [C, { paid: 0, owed: 3000, balance: -3000 }],
    ] as const) {
      expect(evaluateMember(forward, memberRow).computed).toEqual(expected);
      expect(evaluateMember(backward, memberRow).computed).toEqual(expected);
    }
  });

  it("集計元に null が 1 つでもあれば、合計も null になる（空集合の 0 と区別する）", async () => {
    // 支出 1 件ごとの計算 `ratio` は、`amount - amount` が 0 なので null になる
    const app = await normalized(
      [
        "entities:",
        "  - name: member",
        "    fields:",
        "      name: string",
        "  - name: expense",
        "    fields:",
        "      amount: number",
        "      payer:",
        "        type: ref",
        "        to: member",
        "views: []",
        "actions: []",
        "validations: []",
        "computed:",
        "  - name: ratio",
        "    entity: expense",
        "    expression: amount / (amount - amount)",
        "    type: number",
        memberAggregate("ratioSum", ["sum: expense.ratio", "where:", "  payer: this"]),
        memberAggregate("payerCount", ["count: expense", "where:", "  payer: this"]),
        "permissions:",
        "  - name: read",
        "    subject: minIdentity",
        "  - name: write",
        "    subject: minIdentity",
        "minIdentity:",
        "  mode: anonymous",
        "",
      ].join("\n"),
    );

    const withNull = [row("e1", { amount: 100, payer: "m1" })];
    const atM1 = evaluateMember(app, A, withNull).computed;
    // 合計は null（黙って 0 にしない）。count は値を読まないので影響されない
    expect(atM1).toEqual({ ratioSum: null, payerCount: 1 });
    // 空集合は 0 である（null と区別する）
    expect(evaluateMember(app, A, []).computed).toEqual({ ratioSum: 0, payerCount: 0 });
    expect(evaluateMember(app, B, withNull).computed).toEqual({ ratioSum: 0, payerCount: 0 });
  });
});

// ── 集計の道具（純粋な部分） ────────────────────────────────────

describe("集計の道具", () => {
  it("sumValues は、空なら 0、null が 1 つでもあれば null にする", () => {
    expect(sumValues([])).toBe(0);
    expect(sumValues([1, 2, 3])).toBe(6);
    expect(sumValues([1, null, 3])).toBeNull();
  });

  it("matchesWhere は、参照の一致と参照の並びの包含を見る", () => {
    const data = { payer: "m1", participants: ["m1", "m2"] };
    expect(matchesWhere({}, data, "m1")).toBe(true);
    expect(matchesWhere({ payer: "equals" }, data, "m1")).toBe(true);
    expect(matchesWhere({ payer: "equals" }, data, "m2")).toBe(false);
    expect(matchesWhere({ participants: "contains" }, data, "m2")).toBe(true);
    expect(matchesWhere({ participants: "contains" }, data, "m3")).toBe(false);
    // 参照の一致に並びを渡しても、合わない（型は静的チェックが見る）
    expect(matchesWhere({ participants: "equals" }, data, "m1")).toBe(false);
  });

  it("aggregateSourceEntities は、集計元を推移的に集める（自分は含めない）", () => {
    expect(aggregateSourceEntities(WARIKAN, "member")).toEqual(["expense"]);
    // member の集計は expense.shareAmount（expense の計算）を使うが、expense 自身は集計を持たない
    expect(aggregateSourceEntities(WARIKAN, "expense")).toEqual([]);
  });
});
