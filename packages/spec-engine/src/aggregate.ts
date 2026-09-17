// entity をまたぐ集計（`aggregate` の `sum`・`count`）の、評価に使う純粋な道具（Issue #107）。
// 意味は packages/appspec-schema/docs/semantics.md（「aggregate」「sum」「count」）にある。
//
// ここは**評価そのものを持たない**。行を絞る条件（`where`）と、要るレコードの集め方と、合計の畳み方だけを置く。
// 集計の値は src/evaluate.ts が、ここを使って求める（集計元の計算を解くために、評価を再帰させる必要がある）。
//
// **同じインスタンスのレコードしか見ない。** 別インスタンスのレコードは、渡された `sources` に現れない。

import type { AggregateWhere, NormalizedAppSpec } from "@musunest/appspec-schema";

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

/** `where` が 1 つでも条件を持つか（`this` が要るかどうか） */
export const hasConditions = (where: AggregateWhere): boolean => Object.keys(where).length > 0;

/**
 * 1 件のレコードが `where` に合うか。`thisId` は出力先のレコードの ID である。
 *   `equals`   … 参照（`ref`）の一致（値が `thisId` と等しい）
 *   `contains` … 参照の並び（`list of`）の包含（値の並びに `thisId` がある）
 * `where` が空なら、すべての行が合う。
 */
export function matchesWhere(
  where: AggregateWhere,
  data: Readonly<Record<string, unknown>>,
  thisId: string,
): boolean {
  for (const [field, op] of Object.entries(where)) {
    const value = data[field];
    if (op === "equals") {
      if (value !== thisId) return false;
    } else if (!Array.isArray(value) || !value.includes(thisId)) {
      return false;
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
      if (computed.entity !== current || !("aggregate" in computed)) continue;
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
