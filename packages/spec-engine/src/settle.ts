// 精算（`settle`。Issue #108 / Q18-4）の、評価に使う純粋な道具。
// 意味は packages/appspec-schema/docs/semantics.md（「settle」）にある。
//
// 引き受けるのは 2 つである。
//   1. **差し引き額の並びから、送金の組を出す**（`settle`。Q13 の「精算の組み方」）
//   2. **宣言と 1 インスタンスのレコードから、差し引き額を求めて 1 を呼ぶ**（`settleEntity`。Q13 の端数）
//
// 決めごと（Q13。2026-09-15 所有者 / Q18-4・Q18-5。2026-09-16 所有者）:
//   1. 差し引き額が**正なら受け取る人、負なら払う人、0 なら送金に現れない**
//   2. 受け取る人と払う人を、それぞれ**金額の大きい順**に組にする。**同額はメンバーの登録順**である
//   3. **一組を処理するたびに、残額で並べ直す**（Q18-7）。最少送金回数の探索は行わない
//   4. 送金の件数は、人数 n に対し**高々 n − 1**。n = 0 または全員 0 なら空の並びである
//   5. 差し引き額は**数（有限）**でなければならず、**合計は 0 でなければならない**。
//      どちらかが崩れた入力は成功の精算結果にしない（**黙って丸めたり、差額を誰かに寄せたりしない**）
//
// **式を実行しない。** ここは数を並べ替えて引くだけである。レコードを書き換えない。

import type { NormalizedAppSpec, SettleDeclaration } from "@musunest/appspec-schema";
import { isComputedSettle } from "@musunest/appspec-schema";
import type { SourceRecord, SourceRecords } from "./aggregate.js";
import { allocateExpense, type SettleExpense } from "./allocation.js";

// 端数の決めごと（基準額と余りの配賦）は src/allocation.ts にある。**語彙ではない**ので、
// 宣言から読める形にはしない（Q18-5）。使う側が 1 か所で読めるように、ここから再輸出する。
export * from "./allocation.js";

/** 精算に渡す 1 人。**並びが登録順である**（同額の組を決めるのに使う。Q13） */
export interface SettleMember {
  readonly id: string;
  /** 差し引き額（正なら受け取る、負なら払う、0 なら現れない） */
  readonly balance: number;
}

/** 送金 1 件。`from` が払う人、`to` が受け取る人、`amount` は**正の数**である */
export interface Transfer {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/**
 * 精算できなかった理由。**成功の精算結果に読み替えない**ので、理由を区別して返す。
 *   NOT_NUMBER    … 差し引き額が数でない
 *   NOT_FINITE    … 差し引き額が有限の数でない
 *   NOT_BALANCED  … 差し引き額の合計が 0 でない
 *   UNKNOWN_MEMBER … 支出が知らない人の ID を指している（このインスタンスのメンバーでない）
 */
export const SETTLE_FAILURES = ["NOT_NUMBER", "NOT_FINITE", "NOT_BALANCED", "UNKNOWN_MEMBER"] as const;
export type SettleFailure = (typeof SETTLE_FAILURES)[number];

export type SettleResult =
  | { readonly ok: true; readonly transfers: readonly Transfer[] }
  | { readonly ok: false; readonly failure: SettleFailure };

/**
 * 差し引き額の並びから、送金の組を出す。**並びは登録順**である（同額の組を登録順にするため）。
 *
 * 有限でない額・合計が 0 でない並びは `ok: false` にする（決定 5）。
 * 同じ入力からは**同じ並び・同じ値**になる（並べ替えは「金額の大きい順、同額は登録順」だけで決まる）。
 */
export function settle(members: readonly SettleMember[]): SettleResult {
  for (const member of members) {
    if (typeof member.balance !== "number") return { ok: false, failure: "NOT_NUMBER" };
    if (!Number.isFinite(member.balance)) return { ok: false, failure: "NOT_FINITE" };
  }
  const total = members.reduce((sum, member) => sum + member.balance, 0);
  if (total !== 0) return { ok: false, failure: "NOT_BALANCED" };

  // 受け取る側と払う側を、残額の大きい順（同額は登録順）に保つ
  const entries = members.map((member, index) => ({ id: member.id, rest: member.balance, index }));
  const creditors = entries.filter((entry) => entry.rest > 0);
  const debtors = entries.filter((entry) => entry.rest < 0).map((entry) => ({ ...entry, rest: -entry.rest }));
  const bySizeThenOrder = (a: { rest: number; index: number }, b: { rest: number; index: number }): number =>
    b.rest - a.rest || a.index - b.index;

  const transfers: Transfer[] = [];
  for (;;) {
    // **一組を処理するたびに並べ直す**（決定 3）。残額が 0 になった人は落ちる
    const live = creditors.filter((entry) => entry.rest > 0).sort(bySizeThenOrder);
    const owing = debtors.filter((entry) => entry.rest > 0).sort(bySizeThenOrder);
    const creditor = live[0];
    const debtor = owing[0];
    if (creditor === undefined || debtor === undefined) break;
    const amount = Math.min(creditor.rest, debtor.rest);
    transfers.push({ from: debtor.id, to: creditor.id, amount });
    creditor.rest -= amount;
    debtor.rest -= amount;
  }
  return { ok: true, transfers };
}

/** `settleEntity` に渡すもの。**宣言は検査済み**（正規化した JSON）で、レコードは登録順である */
export interface SettleEntityRequest {
  readonly app: NormalizedAppSpec;
  /** 精算する人（メンバー）の entity の名前 */
  readonly entity: string;
  /** その entity のレコード（**登録順**） */
  readonly records: readonly SourceRecord[];
  /** 同じインスタンスのほかの entity のレコード（支出はここから読む） */
  readonly sources: SourceRecords;
}

/** その entity に宣言した精算（無ければ `undefined`）。**1 つだけ**書ける（重複は静的チェックが見る） */
function settleDeclarationOf(
  app: NormalizedAppSpec,
  entity: string,
): SettleDeclaration | undefined {
  for (const entry of app.spec.computed) {
    if (entry.entity === entity && isComputedSettle(entry)) return entry.settle;
  }
  return undefined;
}

/** その entity の精算が読む支出の entity（宣言が無ければ空）。データを読む側が、要る行を知るのに使う */
export function settleSourceEntities(app: NormalizedAppSpec, entity: string): readonly string[] {
  const names = new Set<string>();
  for (const entry of app.spec.computed) {
    if (entry.entity === entity && isComputedSettle(entry)) names.add(entry.settle.expense);
  }
  return [...names];
}

/**
 * **整数円**でなければならない項目（Q18-6）。その entity のレコードが、いずれかの精算の
 * 「支出の額」として指している項目である。data-api が入力の検査で使う。
 */
export function wholeYenFields(app: NormalizedAppSpec, entity: string): readonly string[] {
  const names = new Set<string>();
  for (const entry of app.spec.computed) {
    if (isComputedSettle(entry) && entry.settle.expense === entity) names.add(entry.settle.amount);
  }
  return [...names];
}

/**
 * 宣言と 1 インスタンスのレコードから、精算（送金の並び）を求める。
 *
 * 差し引き額は、**この関数が求める**——宣言の `balance`（`paid - owed`）は基準額の集計であり、
 * 端数の負担が入っていないからである（Q18-5。余りは店頭の内部規約で解く）。
 * 支出ごとに基準額と余りを配り（src/allocation.ts）、払った額から負担を引く。合計は必ず 0 になる。
 *
 * 宣言が無い entity では空の並びを返す（精算を求められていない）。読めないレコードがあれば `ok: false`。
 */
export function settleEntity(request: SettleEntityRequest): SettleResult {
  const declaration = settleDeclarationOf(request.app, request.entity);
  if (declaration === undefined) return { ok: true, transfers: [] };

  const rows = request.sources[declaration.expense] ?? [];
  const expenses: SettleExpense[] = [];
  for (const row of rows) {
    const amount = row.data[declaration.amount];
    const payer = row.data[declaration.payer];
    const shares = row.data[declaration.shares];
    if (typeof amount !== "number") return { ok: false, failure: "NOT_NUMBER" };
    if (!Number.isFinite(amount)) return { ok: false, failure: "NOT_FINITE" };
    if (typeof payer !== "string" || !Array.isArray(shares)) return { ok: false, failure: "UNKNOWN_MEMBER" };
    if (!shares.every((id): id is string => typeof id === "string")) {
      return { ok: false, failure: "UNKNOWN_MEMBER" };
    }
    expenses.push({ amount, payer, participants: shares });
  }

  const balances = settlementBalances(
    request.records.map((record) => record.id),
    expenses,
  );
  if (balances === null) return { ok: false, failure: "UNKNOWN_MEMBER" };
  return settle(request.records.map((record, index) => ({ id: record.id, balance: balances[index] ?? 0 })));
}

/**
 * 人ごとの差し引き額（**登録順**）を求める。`members` は登録順の ID である。
 * 割れない支出（割る人が 0 人・知らない ID）があれば `null` にする。
 *
 * 払った額と負担の合計は、支出ごとに同じ額だけ動くので、**合計は必ず 0 になる**
 * （残額が 0 に残ることはない。決定 5 の「合計不一致」は、外から渡された額にだけ起こりうる）。
 */
export function settlementBalances(
  members: readonly string[],
  expenses: readonly SettleExpense[],
): readonly number[] | null {
  const order = new Map(members.map((id, index) => [id, index]));
  const paid = new Map<string, number>(members.map((id) => [id, 0]));
  const burden = new Map<string, number>(members.map((id) => [id, 0]));

  for (const expense of expenses) {
    if (!order.has(expense.payer)) return null;
    const allocation = allocateExpense(expense, order);
    if (allocation === null) return null;
    paid.set(expense.payer, (paid.get(expense.payer) ?? 0) + expense.amount);
    for (const [id, value] of allocation.burden) burden.set(id, (burden.get(id) ?? 0) + value);
  }
  return members.map((id) => (paid.get(id) ?? 0) - (burden.get(id) ?? 0));
}
