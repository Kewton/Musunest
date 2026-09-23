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
import {
  aggregateSourceEntities,
  appAggregateSourceEntities,
  avgValues,
  groupSourceEntities,
  groupValuesOf,
  matchesWhere,
  sumValues,
} from "./aggregate.js";
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
  // 参照先（member）を画面から選べるようにする一覧（M1.4。Issue #201）
  "views:",
  "  - name: memberList",
  "    entity: member",
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
    // 参照先（member）を画面から選べるようにする一覧（M1.4。Issue #201）
    "views:",
    "  - name: memberList",
    "    entity: member",
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
        // 参照先（member）を画面から選べるようにする一覧（M1.4。Issue #201）
        "views:",
        "  - name: memberList",
        "    entity: member",
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
    const clock = fixedClock("2026-09-15T12:00:00+09:00");
    expect(matchesWhere({}, data, "m1", clock)).toBe(true);
    expect(matchesWhere({ payer: { op: "equals" } }, data, "m1", clock)).toBe(true);
    expect(matchesWhere({ payer: { op: "equals" } }, data, "m2", clock)).toBe(false);
    expect(matchesWhere({ participants: { op: "contains" } }, data, "m2", clock)).toBe(true);
    expect(matchesWhere({ participants: { op: "contains" } }, data, "m3", clock)).toBe(false);
    // 参照の一致に並びを渡しても、合わない（型は静的チェックが見る）
    expect(matchesWhere({ participants: { op: "equals" } }, data, "m1", clock)).toBe(false);
  });

  it("matchesWhere は、期間の条件（within）を、差し込んだ時計の日本時間で見る（M1.4。Issue #178）", () => {
    const where = { paidOn: { op: "within", period: "this_month" } } as const;
    const clock = fixedClock("2026-09-15T12:00:00+09:00");
    // 今月（日本時間の 2026-09）は合う
    expect(matchesWhere(where, { paidOn: "2026-09-01" }, "", clock)).toBe(true);
    expect(matchesWhere(where, { paidOn: "2026-09-30" }, "", clock)).toBe(true);
    // 先月・翌月は合わない（半開区間である）
    expect(matchesWhere(where, { paidOn: "2026-08-31" }, "", clock)).toBe(false);
    expect(matchesWhere(where, { paidOn: "2026-10-01" }, "", clock)).toBe(false);
    // 形に合わない値・欠けている値は合わない（0 件に読み替えない）
    expect(matchesWhere(where, { paidOn: "" }, "", clock)).toBe(false);
    expect(matchesWhere(where, { paidOn: "2026/09/01" }, "", clock)).toBe(false);
    expect(matchesWhere(where, {}, "", clock)).toBe(false);
    // **時計を替えれば「今月」も替わる**（値は時計に依る。Q17）
    expect(matchesWhere(where, { paidOn: "2026-10-01" }, "", fixedClock("2026-10-01T00:00:00+09:00"))).toBe(
      true,
    );
  });

  it("月末・月初の境目が日本時間で正しい（月初の 0 時ちょうど・前月の末日の 23:59。受入条件）", () => {
    const where = { paidOn: { op: "within", period: "this_month" } } as const;
    // 日本時間の 2026-10-01 00:00 ちょうど → 今月は 10 月。9 月の末日は合わない
    const firstOfMonth = fixedClock("2026-10-01T00:00:00+09:00");
    expect(matchesWhere(where, { paidOn: "2026-10-01" }, "", firstOfMonth)).toBe(true);
    expect(matchesWhere(where, { paidOn: "2026-09-30" }, "", firstOfMonth)).toBe(false);
    // 日本時間の 2026-09-30 23:59:59 → まだ 9 月。10 月 1 日は合わない
    const lastMoment = fixedClock("2026-09-30T23:59:59+09:00");
    expect(matchesWhere(where, { paidOn: "2026-09-30" }, "", lastMoment)).toBe(true);
    expect(matchesWhere(where, { paidOn: "2026-10-01" }, "", lastMoment)).toBe(false);
    // UTC の 2026-09-30 15:00 は日本時間の 2026-10-01 00:00 である（**UTC の日付では数えない**）
    expect(matchesWhere(where, { paidOn: "2026-10-01" }, "", fixedClock("2026-09-30T15:00:00Z"))).toBe(true);
    expect(matchesWhere(where, { paidOn: "2026-09-30" }, "", fixedClock("2026-09-30T15:00:00Z"))).toBe(false);
  });

  it("集計の照合（aggregate.ts）に Date.now() の直接の呼び出しが無い（時計は引数で受け取る。Q17）", () => {
    // 現在時刻を読むのは、時計の境界（clock.ts。`systemClock` の 1 か所）だけである
    expect(read(new URL("./aggregate.ts", import.meta.url)).includes("Date.now")).toBe(false);
  });

  it("aggregateSourceEntities は、集計元を推移的に集める（自分は含めない）", () => {
    expect(aggregateSourceEntities(WARIKAN, "member")).toEqual(["expense"]);
    // member の集計は expense.shareAmount（expense の計算）を使うが、expense 自身は集計を持たない
    expect(aggregateSourceEntities(WARIKAN, "expense")).toEqual([]);
  });

  it("aggregateSourceEntities は、アプリ全体（scope: app）の集計を混ぜない（M1.4）", async () => {
    // dashboard には scope: app の集計（activity を数える）がある。行ごとの集計元には混ざらない
    const dashboard = await normalized(read(sampleSpecFile("dashboard")));
    expect(aggregateSourceEntities(dashboard, "activity")).toEqual([]);
    expect(aggregateSourceEntities(dashboard, "member")).toEqual([]);
  });

  it("appAggregateSourceEntities は、アプリ全体の集計が要る entity を推移的に集める（M1.4）", async () => {
    const dashboard = await normalized(read(sampleSpecFile("dashboard")));
    expect(appAggregateSourceEntities(dashboard)).toEqual(["activity"]);
    // scope: app の集計が 1 つも無ければ空である（従来の宣言には余計な読みを足さない）
    expect(appAggregateSourceEntities(WARIKAN)).toEqual([]);
  });
});

// ── 平均（avg。M1.4。Issue #177） ────────────────────────────────

describe("avgValues（M1.4）", () => {
  it("読めた行だけで平均を求める（値の無い行は数えない）", () => {
    expect(avgValues([])).toBeNull();
    expect(avgValues([null])).toBeNull();
    expect(avgValues([2, 4])).toBe(3);
    // **`null` の行を数えない**——`sum` と別の決めごとである（1 行の欠損で画面全体を「—」にしない）
    expect(avgValues([2, null, 4])).toBe(3);
    expect(avgValues([0, 0])).toBe(0);
  });
});

// ── 見出しごとの集計（`groupBy`・`groups`。M1.4。Issue #179） ────────────
//
// **「見出しと値」の組の並び**を返す。分けられるのは `enum`（値ごと）と `date`（月ごと）だけである。
// 並びは決めたとおりに安定させる——**月は古い順**、**`enum` は `options` に書いた順**（窓口の決定 2026-09-19）。

const GROUP_DECLARATION = [
  "entities:",
  "  - name: activity",
  "    fields:",
  "      date: date",
  "      cost: number",
  "      kind:",
  "        type: enum",
  "        options:",
  "          practice: 練習",
  "          match: 試合",
  "          party: 飲み会",
  "views: []",
  "actions: []",
  "validations: []",
  "computed:",
  "  - name: byKind",
  "    aggregate:",
  "      count: activity",
  "      groupBy: activity.kind",
  "    type: groups",
  "  - name: byMonth",
  "    aggregate:",
  "      count: activity",
  "      groupBy:",
  "        month: activity.date",
  "      last: 6",
  "    type: groups",
  "  - name: costByKind",
  "    aggregate:",
  "      sum: activity.cost",
  "      groupBy: activity.kind",
  "    type: groups",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

const GROUPS_APP = await normalized(GROUP_DECLARATION);
/** 日本時間の 2026-09-15（今月は 2026-09）。月の見出しの窓は 2026-04〜2026-09 になる */
const GROUP_CLOCK = fixedClock("2026-09-15T12:00:00+09:00");

const aggregateOf = (app: NormalizedAppSpec, name: string) => {
  const entry = app.spec.computed.find((candidate) => candidate.name === name);
  if (entry === undefined || !("aggregate" in entry)) throw new Error(`集計 ${name} が無い`);
  return entry.aggregate;
};

const groupBy = (
  app: NormalizedAppSpec,
  name: string,
  rows: readonly SourceRecord[],
  clock = GROUP_CLOCK,
) => groupValuesOf(app, aggregateOf(app, name), { activity: rows }, clock);

describe("見出しごとの集計（groupBy・groups）（M1.4。Issue #179）", () => {
  const activity = (id: string, kind: string, date: string, cost: number): SourceRecord =>
    row(id, { kind, date, cost });

  const ROWS = [
    activity("a1", "practice", "2026-09-10", 3000),
    activity("a2", "practice", "2026-09-05", 1000),
    activity("a3", "party", "2026-09-12", 5000),
    activity("a4", "match", "2026-08-31", 2000),
    // 窓の外（2026-03。今月から 6 か月より古い）。**落ちる**（上限が効く）
    activity("a5", "practice", "2026-03-01", 100),
  ];

  it("`enum` は `options` に書いた順に、値が 0 の見出しも含めて返す", () => {
    expect(groupBy(GROUPS_APP, "byKind", ROWS)).toEqual([
      { heading: "practice", value: 3 },
      { heading: "match", value: 1 },
      { heading: "party", value: 1 },
    ]);
  });

  it("**同じ値が並んだときの順も安定している**（match と party が同数でも options の順のまま）", () => {
    // options は practice → match → party である。値が同じでも、この順は入れ替わらない
    const rows = [
      activity("a1", "party", "2026-09-12", 0),
      activity("a2", "match", "2026-09-10", 0),
    ];
    expect(groupBy(GROUPS_APP, "byKind", rows)).toEqual([
      { heading: "practice", value: 0 },
      { heading: "match", value: 1 },
      { heading: "party", value: 1 },
    ]);
  });

  it("月は古い順に、直近 `last` か月を返す。データの無い月も 0 で出し、窓の外の月は落ちる", () => {
    expect(groupBy(GROUPS_APP, "byMonth", ROWS)).toEqual([
      { heading: "2026-04", value: 0 },
      { heading: "2026-05", value: 0 },
      { heading: "2026-06", value: 0 },
      { heading: "2026-07", value: 0 },
      { heading: "2026-08", value: 1 },
      { heading: "2026-09", value: 3 },
    ]);
  });

  it("**件数の上限（`last`）が効く**。上限を超える月数のデータでも、直近 `last` か月だけを返す", () => {
    // 2026-02〜2026-09 の 8 か月にデータがある。`last: 6` なので 2026-04〜2026-09 の 6 か月だけ
    const many = [
      activity("m02", "practice", "2026-02-01", 0),
      activity("m03", "practice", "2026-03-01", 0),
      activity("m04", "practice", "2026-04-01", 0),
      activity("m05", "practice", "2026-05-01", 0),
      activity("m06", "practice", "2026-06-01", 0),
      activity("m07", "practice", "2026-07-01", 0),
      activity("m08", "practice", "2026-08-01", 0),
      activity("m09", "practice", "2026-09-01", 0),
    ];
    const groups = groupBy(GROUPS_APP, "byMonth", many);
    expect(groups?.map((entry) => entry.heading)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    // 上限を超えた古い月（2 月・3 月）は落ちている
    expect(groups?.some((entry) => entry.heading === "2026-02")).toBe(false);
    expect(groups?.some((entry) => entry.heading === "2026-03")).toBe(false);
  });

  it("`last` を省いたときの既定は 6 か月である", async () => {
    const declaration = GROUP_DECLARATION.replace("      last: 6\n", "");
    const app = await normalized(declaration);
    const headings = groupBy(app, "byMonth", [])?.map((entry) => entry.heading) ?? [];
    expect(headings).toHaveLength(6);
  });

  it("`sum` の見出しごとの集計は、その見出しの行の値を足す", () => {
    expect(groupBy(GROUPS_APP, "costByKind", ROWS)).toEqual([
      { heading: "practice", value: 4100 },
      { heading: "match", value: 2000 },
      { heading: "party", value: 5000 },
    ]);
  });

  it("合う行が 0 件でも、見出しは残る（count は 0、値は null にしない）", () => {
    expect(groupBy(GROUPS_APP, "byKind", [])).toEqual([
      { heading: "practice", value: 0 },
      { heading: "match", value: 0 },
      { heading: "party", value: 0 },
    ]);
  });

  it("**集計元を読めなければ（キーが無ければ）`null`** にする（空の並びに読み替えない）", () => {
    expect(groupValuesOf(GROUPS_APP, aggregateOf(GROUPS_APP, "byKind"), {}, GROUP_CLOCK)).toBeNull();
  });

  it("日付が形に合わない行・`where` に合わない行は数えない", () => {
    const rows = [
      activity("ok", "practice", "2026-09-10", 0),
      // 形に合わない日付（月の見出しに入らない）
      row("bad", { kind: "practice", date: "2026/09/10", cost: 0 }),
    ];
    // `byKind` は日付を見ないので 2 件、`byMonth` は形に合わない行を数えないので 9 月は 1 件
    expect(groupBy(GROUPS_APP, "byKind", rows)?.[0]).toEqual({ heading: "practice", value: 2 });
    expect(groupBy(GROUPS_APP, "byMonth", rows)?.at(-1)).toEqual({ heading: "2026-09", value: 1 });
  });

  it("groupSourceEntities は、見出しごとの集計が要る entity を集める（dashboard でも）", async () => {
    expect(groupSourceEntities(GROUPS_APP)).toEqual(["activity"]);
    // 見出しごとの集計が 1 つも無ければ空である（従来の宣言には余計な読みを足さない）
    expect(groupSourceEntities(WARIKAN)).toEqual([]);
    const dashboard = await normalized(read(sampleSpecFile("dashboard")));
    expect(groupSourceEntities(dashboard)).toEqual(["activity"]);
  });

  it("見本 dashboard の見出しごとの集計が、宣言のまま読める（語彙と評価が一致している）", async () => {
    const dashboard = await normalized(read(sampleSpecFile("dashboard")));
    // 時計は 8 月〜9 月に活動がある資料ではなく、窓の形だけを見る（0 件でも 6 か月が返る）
    const byMonth = groupValuesOf(
      dashboard,
      aggregateOf(dashboard, "activitiesByMonth"),
      { activity: [] },
      GROUP_CLOCK,
    );
    expect(byMonth?.map((entry) => entry.heading)).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    const byKind = groupValuesOf(
      dashboard,
      aggregateOf(dashboard, "activitiesByKind"),
      { activity: [] },
      GROUP_CLOCK,
    );
    // dashboard の kind の options は practice・match・party である
    expect(byKind?.map((entry) => entry.heading)).toEqual(["practice", "match", "party"]);
  });
});
