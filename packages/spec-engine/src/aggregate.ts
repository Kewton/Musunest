// entity をまたぐ集計（`aggregate` の `sum`・`count`）の、評価に使う純粋な道具（Issue #107）。
// 意味は packages/appspec-schema/docs/semantics.md（「aggregate」「sum」「count」）にある。
//
// ここは**評価そのものを持たない**。行を絞る条件（`where`）と、要るレコードの集め方と、合計の畳み方だけを置く。
// 集計の値は src/evaluate.ts が、ここを使って求める（集計元の計算を解くために、評価を再帰させる必要がある）。
//
// **同じインスタンスのレコードしか見ない。** 別インスタンスのレコードは、渡された `sources` に現れない。

import {
  DATE_VALUE_PATTERN,
  GROUP_LIMIT_DEFAULT,
  enumKeys,
  isAppComputed,
  isGroupComputed,
  type Aggregate,
  type AggregateWhere,
  type NormalizedAppSpec,
} from "@musunest/appspec-schema";
import { periodRange, todayInTokyo, type Clock } from "./clock.js";

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
      if (
        isAppComputed(computed) ||
        isGroupComputed(computed) ||
        computed.entity !== current ||
        !("aggregate" in computed)
      ) {
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

// ── 見出しごとの集計（`groupBy`。M1.4。Issue #179） ──────────────────────
//
// **「見出しと値」の組の並び**を返す。分けられるのは `enum` の項目（値ごと）と、`date` の項目（月ごと）
// だけである。並びは決めたとおりに安定させる——**月は古い順**、**`enum` は `options` に書いた順**である
// （窓口の決定 2026-09-19。docs/semantics.md「groupBy」「groups」）。同じ値が並んでも、この順は変わらない。

/** 見出しごとの集計の 1 組（「見出しと値」）。見出しは月なら `YYYY-MM`、`enum` なら `options` のキーである */
export interface GroupEntry {
  readonly heading: string;
  /** その見出しの値。求められなければ `null`（0 に読み替えない）。`count` は常に数である */
  readonly value: number | null;
}

/** 日付（`YYYY-MM-DD`）の「月」を `YYYY-MM` で返す。形に合わなければ `null`（その行は数えない） */
function monthKeyOf(date: unknown): string | null {
  return typeof date === "string" && DATE_VALUE_PATTERN.test(date) ? date.slice(0, 7) : null;
}

/**
 * 日本時間の「今月」を終わりとして、直近 `count` か月の `YYYY-MM` を**古い順**に返す。
 * **データの無い月も見出しとして出す**（棒グラフの軸を揃え、0 件の月も 0 として見せるためである）。
 */
function recentMonths(clock: Clock, count: number): readonly string[] {
  const today = todayInTokyo(clock);
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  const months: string[] = [];
  for (let index = 0; index < count; index += 1) {
    months.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return months.reverse();
}

/**
 * 1 つの見出しの値。`count` は行数、`sum`・`avg` は**対象の項目**（数）を畳む。
 * 対象が数でない行は `null` にして数えない——`sum` は「1 つでも欠ければ `null`」、`avg` は
 * 「読めた行だけで平均する」（`sumValues`・`avgValues` の注記と同じ決めごとである）。
 */
function groupValueOf(
  aggregate: Aggregate,
  rows: readonly SourceRecord[],
): number | null {
  if (aggregate.kind === "count") return rows.length;
  const name = aggregate.name;
  if (name === null) return null;
  const values = rows.map((row) => {
    const value = row.data[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  return aggregate.kind === "sum" ? sumValues(values) : avgValues(values);
}

/**
 * 見出しごとの集計（`groupBy`。M1.4。Issue #179）の値を求める。
 *
 * - **`groupBy` が無ければ `null`**（呼ぶ側は、その計算を `groups` の欄に載せない）
 * - **集計元のレコードを読めなければ（キーが無ければ）`null`** である——空の並びに読み替えない
 *   （`computed` と同じ約束である。「読めなかった」と「0 件」は別の事実である）
 * - **`enum`**：`options` のキーを**書いた順に全部**返す（値が 0 の見出しも出す。ボードの列と同じ考え方）
 * - **月**：日本時間の今月を終わりとして、直近 `last`（既定 `GROUP_LIMIT_DEFAULT`＝6）か月を**古い順**に
 *   返す（データの無い月も 0 で出す）。**上限を超える古い月は落ちる**
 * - `where` に合わない行・日付が形に合わない行は数えない。**集計そのものは `null` にしない**
 *   （0 件なら `count` は 0、`avg` は `null`。窓口の決定 2026-09-19）
 *
 * **時計は引数で受け取る**（Q17。評価の中で現在時刻を読まない）。
 */
export function groupValuesOf(
  app: NormalizedAppSpec,
  aggregate: Aggregate,
  sources: SourceRecords,
  clock: Clock,
): readonly GroupEntry[] | null {
  const grouping = aggregate.groupBy;
  if (grouping === undefined) return null;
  const rows = sources[aggregate.entity];
  if (rows === undefined) return null;
  const entity = app.spec.entities.find((candidate) => candidate.name === aggregate.entity);
  if (entity === undefined) return null;
  const matched = rows.filter((row) => matchesWhere(aggregate.where, row.data, "", clock));

  if (grouping.month) {
    const limit = aggregate.last ?? GROUP_LIMIT_DEFAULT;
    return recentMonths(clock, limit).map((month) => ({
      heading: month,
      value: groupValueOf(
        aggregate,
        matched.filter((row) => monthKeyOf(row.data[grouping.field]) === month),
      ),
    }));
  }

  const declaration = entity.fields[grouping.field];
  if (declaration === undefined) return null;
  return enumKeys(declaration).map((key) => ({
    heading: key,
    value: groupValueOf(
      aggregate,
      matched.filter((row) => row.data[grouping.field] === key),
    ),
  }));
}

/**
 * **見出しごとの集計（`groupBy`。M1.4。Issue #179）を解くのに要る** entity の名前を集める。
 * 分ける対象も集計の対象も `aggregate.entity` のレコードなので、その名前を返す
 * （集計の対象は**項目だけ**である——計算は指せない。静的チェックが保証する）。
 */
export function groupSourceEntities(app: NormalizedAppSpec): readonly string[] {
  const sources = new Set<string>();
  for (const computed of app.spec.computed) {
    if (isGroupComputed(computed)) sources.add(computed.aggregate.entity);
  }
  return [...sources];
}
