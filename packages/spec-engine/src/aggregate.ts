// entity をまたぐ集計（`aggregate` の `sum`・`count`）の、評価に使う純粋な道具（Issue #107）。
// 意味は packages/appspec-schema/docs/semantics.md（「aggregate」「sum」「count」）にある。
//
// ここは**評価そのものを持たない**。行を絞る条件（`where`）と、要るレコードの集め方と、合計の畳み方だけを置く。
// 集計の値は src/evaluate.ts が、ここを使って求める（集計元の計算を解くために、評価を再帰させる必要がある）。
//
// **同じインスタンスのレコードしか見ない。** 別インスタンスのレコードは、渡された `sources` に現れない。

import { isAppComputed, type AggregateWhere, type NormalizedAppSpec } from "@musunest/appspec-schema";
import { periodRange, type Clock } from "./clock.js";

/** 集計の元になる 1 件。`id` は `this`（出力先のレコードの ID）と比べる値である */
export interface SourceRecord {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * entity の名前 → そのレコードの並び（同じインスタンスのもの）。
 * **「まだ読んでいない」（キーが無い）と「0 件」（空の並び）を区別する**——前者は集計を `null` にし、
 * 後者は 0 にする（黙って 0 に読み替えない）。
 */
export type SourceRecords = Readonly<Record<string, readonly SourceRecord[]>>;

/**
 * `where` に `this`（出力先のレコードの ID）と比べる条件があるか（`equals`・`contains`）。
 * **アプリ全体の集計（`scope: app`）は出力先のレコードを持たない**ので、これが真になる宣言は
 * 静的チェックが `LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH` で断る（評価側も、念のため `null` にする）。
 * **期間の条件（`within`）は `this` を要らない**——比べる相手が期間の名前だからである（M1.4）。
 */
export const needsThis = (where: AggregateWhere): boolean =>
  Object.values(where).some(
    (condition) => condition.op === "equals" || condition.op === "contains",
  );

/**
 * 1 件のレコードが `where` に合うか。`thisId` は出力先のレコードの ID、`clock` は期間の条件
 * （`within`）が「今月」を決めるのに使う時計である。
 *   `equals`   … 参照（`ref`）の一致（値が `thisId` と等しい）
 *   `contains` … 参照の並び（`list of`）の包含（値の並びに `thisId` がある）
 *   `within`   … 期間の条件（M1.4）。値（`date`）が、その期間の半開区間にある
 * `where` が空なら、すべての行が合う。
 *
 * **時計は引数で受け取る**（Q17。評価の中で現在時刻を読まない）。`within` の対象が `YYYY-MM-DD` の
 * 形でない行は**合わないものとする**（0 件に読み替えない。形は静的チェックと data-api が見ている）。
 */
export function matchesWhere(
  where: AggregateWhere,
  data: Readonly<Record<string, unknown>>,
  thisId: string,
  clock: Clock,
): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const value = data[field];
    if (condition.op === "equals") {
      if (value !== thisId) return false;
    } else if (condition.op === "contains") {
      if (!Array.isArray(value) || !value.includes(thisId)) return false;
    } else {
      const range = periodRange(condition.period, clock);
      if (range === null) return false;
      if (typeof value !== "string" || value < range.from || value >= range.to) return false;
    }
  }
  return true;
}

/**
 * 合計。**合う行が 1 件も無ければ 0**（空の集計は 0。Q3）。
 * **`null` が 1 つでもあれば `null`** にする——空集合の 0 と区別し、黙って 0 に読み替えない（受入条件）。
 */
export function sumValues(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
    if (!Number.isFinite(total)) return null;
  }
  return total;
}

/**
 * その entity を評価するのに要る、**ほかの entity のレコード**（集計の集計元）を推移的に集める。
 * 集計の対象が計算（`sum: expense.shareAmount`）なら、その計算を解くために集計元の集計元も要る。
 * 自分自身は含めない（自分を集計する宣言は、検査が循環として断る）。
 *
 * **アプリ全体（`scope: app`）の集計は見ない。** あちらは出力先の entity を持たないので、
 * `appAggregateSourceEntities` が別に集める。
 */
export function aggregateSourceEntities(
  app: NormalizedAppSpec,
  entity: string,
): readonly string[] {
  const sources = new Set<string>();
  const queue: string[] = [entity];
  const seen = new Set<string>([entity]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const computed of app.spec.computed) {
      if (isAppComputed(computed) || computed.entity !== current || !("aggregate" in computed)) {
        continue;
      }
      const target = computed.aggregate.entity;
      if (target === entity) continue;
      sources.add(target);
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...sources];
}

/**
 * **アプリ全体の集計（`scope: app`。M1.4。Issue #177）を解くのに要る**、集計元の entity のレコードを
 * 推移的に集める。集計の対象が計算なら、その計算を解くために要る集計元（`aggregateSourceEntities`）も
 * 足す——**どの entity の計算を解くにも、同じ `sources` を渡す**ためである（決定 7）。
 */
export function appAggregateSourceEntities(app: NormalizedAppSpec): readonly string[] {
  const sources = new Set<string>();
  const queue: string[] = [];
  for (const computed of app.spec.computed) {
    if (isAppComputed(computed) && "aggregate" in computed) queue.push(computed.aggregate.entity);
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const name of aggregateSourceEntities(app, current)) {
      if (!sources.has(name)) {
        sources.add(name);
        queue.push(name);
      }
    }
    sources.add(current);
  }
  return [...sources];
}

/**
 * 平均（`avg`。M1.4。Issue #177）。**値の無い行（`null`・空・不正な値）は数えない**
 * ——1 行の欠損で画面全体が「—」になるのを避ける（窓口の決定 2026-09-19）。
 *
 * 数える行が 1 つも無ければ **`null`** である（0 に読み替えない）。
 * `sum` が「`null` が 1 つでもあれば `null`」であるのとは**別の決めごと**である——
 * 合計は 1 行でも読めなければ確定できないが、平均は読めた行だけで求められる。
 */
export function avgValues(values: readonly (number | null)[]): number | null {
  const valid = values.filter((value): value is number => value !== null);
  if (valid.length === 0) return null;
  const total = sumValues(valid);
  if (total === null) return null;
  const average = total / valid.length;
  // 割り切れても有限である。桁あふれは `sumValues` と同じく `null` にする
  return Number.isFinite(average) ? average : null;
}
