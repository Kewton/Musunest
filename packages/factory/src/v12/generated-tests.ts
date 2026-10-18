// コードが作る試験（08-architecture-v1.2.md §4 の C4・§5・§6。v1.2 手 3c・Issue #595）。
//
// 旗 `v12.ids` の走りだけ、台帳の型だけで値が決まる試験（期待の値の書き手が `code` の行）を、表・台帳・持ち越しを除いた一覧
// から**コードが作る**（LLM を呼ばない純粋な関数）。T2 の LLM には値の要る試験だけを書かせ、T2' の形の検査のあと、ここで作った
// 試験を組の末尾に足す（`v11a/stages/test-spec.ts`）。
//
//   - default-value・enum-membership（試験の型の書き手が `code`）：確かめ方がその種類の要件ごとに、必須の kind ごとに 1 本。
//     対象は確かめ方の選択肢の項目・入力は空の写像・参照データは空・期待は ok で、確かめ方の欄の値か対象の行の options の並び
//   - empty-aggregate（集計の試験の型の `codeRanges`。アプリ全体と見出しごと × 選択肢）：確かめ方が fixed-test で分類が ruled の
//     要件が所属させた集計の行ごとに、集計元を空と明示した境界と集計元に触れない異常（期待は台帳の表の値）。行ごとと見出しごと
//     × 月の集計は作らない（入力の行が要る／見出しの数が宣言の `last` で決まる。今までどおり LLM が書き T2' が照らす）
//
// 試験 ID はコードが振る（予約の接頭辞 `GENERATED_TEST_ID_PREFIX`。LLM の試験 ID に使えば T2' が固定文で落とす）。期待の値を
// 書くのはここだけで、評価口は作り手を区別しない（B4 の照合は今までどおり。期待と宣言が違えば不一致）。
import type { FixedTest, TestKind } from "../fixed-test.js";
import type { RequirementList } from "../pipeline.js";
import type { Problem } from "../stages/prompt.js";
import type { ComputationAggregate, ComputationRowType, NameTable } from "../v11a/names.js";
import {
  aggregateStateValueOf,
  type AggregateDataState,
  type AggregateRange,
  type LedgerView,
  type PropertyAggregateT2,
  type PropertyRow,
  type PropertyT1,
  type PropertyT2,
} from "./ledger.js";

// ── 表から引く対象（T2' の検査と、コードが作る試験の両方が使う）──────────────────

/** 確かめ方に結び付いた性質で確かめる要件の、対象の行と期待する値（表から引く。旗 on） */
export interface LedgerTarget {
  readonly row: PropertyRow & { readonly t1: PropertyT1; readonly t2: PropertyT2 };
  readonly fieldId: string;
  /** 確かめ方の欄の値（欄を持たない確かめ方は null。Issue #548） */
  readonly value: string | null;
  /** 対象の行の options（表の順。Issue #548） */
  readonly options: readonly string[];
}

/**
 * 表の確かめ方が台帳の性質に結び付いた要件 → 対象の行の `id` と期待する値（`defaultValueTargetsOf` を台帳の行の
 * 記述子で引いたもの）。対象は所属の中の、記述子の種類・型の行がちょうど `count`（1）行のときだけ載せる（fail-closed）。
 * 欄を持つ確かめ方は欄が文字列のときだけ載せる。欄を持たない確かめ方（enum-membership）は欄を見ない（Issue #548）。
 */
export function ledgerTargetsOf(table: NameTable, ledger: LedgerView): ReadonlyMap<string, LedgerTarget> {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  const rolesById = new Map(table.ownership.map((entry) => [entry.requirementId, entry.roles] as const));
  const targets = new Map<string, LedgerTarget>();
  for (const entry of table.verification) {
    const row = ledger.rowByVerificationKind.get(entry.kind);
    if (row === undefined || row.t1 === null || row.t2 === null) continue;
    const t1 = row.t1;
    const want = t1.ownership.row;
    if (want === null) continue;
    const value = t1.valueField === null ? null : (entry as unknown as Record<string, unknown>)[t1.valueField];
    if (t1.valueField !== null && typeof value !== "string") continue;
    const fields = (rolesById.get(entry.requirementId) ?? []).filter((role) => {
      const owned = rowById.get(role.id);
      return owned !== undefined && owned.kind === want.kind && (owned.type as unknown) === want.type;
    });
    const [only] = fields;
    if (fields.length === t1.ownership.count && only !== undefined) {
      const options = rowById.get(only.id)?.options ?? [];
      targets.set(entry.requirementId, { row: { ...row, t1, t2: row.t2 }, fieldId: only.id, value: value as string | null, options });
    }
  }
  return targets;
}

/** 集計の試験の型で期待を確かめる対象（表の計算の行のうち、種別 aggregate で集計の種類と集計元を持つ行） */
export interface AggregateTarget {
  readonly aggregate: ComputationAggregate;
  /** 見出しごとの集計の見出し（enum は見出しの元の項目の options の順のキー、月は値だけ見る。行ごと・アプリ全体は null） */
  readonly groups: { readonly kind: "enum"; readonly headings: readonly string[] } | { readonly kind: "month" } | null;
  /** 集計の範囲（行ごと・アプリ全体・見出しごと × 選択肢・見出しごと × 月。Issue #595） */
  readonly range: AggregateRange;
}

const isComputationRowType = (type: NameTable["rows"][number]["type"]): type is ComputationRowType =>
  type !== null && typeof type === "object" && "valueType" in type;

/**
 * 表の計算の行の `id` → 集計の試験の型で期待を確かめる対象。種別 aggregate で `aggregate` を持つ行だけを載せる（旗 on で台帳が
 * 集計の種類を持つ走りの表。T1' が形・集計元・見出しの元を確かめ済み）。見出しの元の項目が表に無い見出しごとの集計は載せない
 * （fail-closed。その行の空の集計の試験は対象の落ちになる）。
 */
export function aggregateTargetsOf(table: NameTable): ReadonlyMap<string, AggregateTarget> {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  const targets = new Map<string, AggregateTarget>();
  for (const row of table.rows) {
    if (row.kind !== "computation" || !isComputationRowType(row.type) || row.type.form !== "aggregate") continue;
    const aggregate = row.type.aggregate;
    if (aggregate === undefined || aggregate === null) continue;
    if (row.groupBy === null) {
      targets.set(row.id, { aggregate, groups: null, range: row.type.scope === "app" ? "app" : "row" });
      continue;
    }
    if (row.groupBy.kind === "month") {
      targets.set(row.id, { aggregate, groups: { kind: "month" }, range: "groups-month" });
      continue;
    }
    const options = rowById.get(row.groupBy.field)?.options;
    if (options !== undefined && options !== null) {
      targets.set(row.id, { aggregate, groups: { kind: "enum", headings: options }, range: "groups-enum" });
    }
  }
  return targets;
}

/** 試験のデータ状態（集計の試験だけ。集計元を空と明示していれば空、していなければ未読） */
export function aggregateDataStateOf(test: FixedTest, target: AggregateTarget): AggregateDataState {
  return (test.inputContract?.emptyEntities ?? []).includes(target.aggregate.entity) ? "empty" : "unread";
}

/**
 * 集計の試験の型の表から導いた、1 つの試験の期待の値（decode 済み）。行ごと・アプリ全体と未読は値そのもの（見出しごとの未読は
 * 並び全体が null）、見出しごと × 選択肢の空は options の順の `{heading, value}`。月の見出しは数が表から決まらないので undefined
 * （作らない・照らすのは各値だけ）。種類が表に無ければ undefined。
 */
export function aggregateExpectedValueOf(
  t2: PropertyAggregateT2,
  target: AggregateTarget,
  state: AggregateDataState,
): unknown {
  const base = aggregateStateValueOf(t2, target.aggregate.kind, state);
  if (base === undefined) return undefined;
  if (target.groups === null || state === "unread") return base;
  if (target.groups.kind === "month") return undefined;
  return target.groups.headings.map((heading) => ({ heading, value: base }));
}

// ── コードが作る試験 ────────────────────────────────────────────────

/** コードが作る試験の ID の予約の接頭辞（LLM の試験 ID に使えば T2' が固定文で落とす） */
export const GENERATED_TEST_ID_PREFIX = "gen:";

/** コードが作る試験の固定の日時（評価を再現できるよう定数にする） */
export const GENERATED_TEST_CLOCK = "2026-01-01T00:00:00+09:00";

/** コードが作る試験の入力の契約の、固定の行 ID */
export const GENERATED_TEST_ROW_ID = "gen-row-1";

/** LLM の試験 ID が予約の接頭辞で始まるときの固定文 */
export const GENERATED_TEST_ID_MESSAGE = "試験 ID の頭の gen: はコードが作る試験に予約してあるので、使わないこと";

/** コードが作る試験か（予約の接頭辞で始まる試験 ID） */
export const isGeneratedTestId = (id: string): boolean => id.startsWith(GENERATED_TEST_ID_PREFIX);

/** コードが作った試験の組 */
export interface GeneratedTests {
  /** 作った試験（一覧の順。要件ごとに、確かめ方の性質の試験か、所属の順の集計の行ごとにデータ状態の表の順） */
  readonly tests: readonly FixedTest[];
  /** 試験 ID → 観測する性質（作った試験だけ） */
  readonly observes: ReadonlyMap<string, string>;
  /** 試験を全部コードが作る要件（T2 の要件の一覧・確かめ方・所属・分類の完全性から除く。一覧の順） */
  readonly excludedRequirementIds: readonly string[];
}

/** 作る試験を組む入力（持ち越しを除いた表と一覧。台帳は旗 on の導出） */
export interface GeneratedTestsInput {
  readonly table: NameTable;
  readonly ledger: LedgerView;
  readonly list: RequirementList;
}

/** 試験の重なりの鍵（要件・対象・性質・データ状態） */
const keyOf = (requirementId: string, roleId: string, observes: string, state: string): string =>
  JSON.stringify([requirementId, roleId, observes, state]);

/** 確かめ方に結び付いた性質の試験のデータ状態（状態は 1 つ） */
const LEDGER_STATE = "-";

function generatedTest(
  id: string,
  requirementId: string,
  targetKind: FixedTest["target"]["kind"],
  roleId: string,
  kind: TestKind,
  operation: FixedTest["operation"],
  emptyEntities: readonly string[],
  value: unknown,
): FixedTest {
  return {
    id,
    target: { requirementId, kind: targetKind, roleId },
    kind,
    operation,
    clock: GENERATED_TEST_CLOCK,
    input: {},
    inputContract: { rowId: GENERATED_TEST_ROW_ID, targetRowId: null, emptyEntities },
    referenceData: [],
    expected: { kind: "ok", value },
  };
}

/**
 * 台帳の型だけで値が決まる試験を作る（純粋。LLM を呼ばない）。同じ表・台帳・一覧からは同じ組を返す。持ち越しの要件は一覧と
 * 表から除いて渡す（作らない）。
 */
export function generateTests(input: GeneratedTestsInput): GeneratedTests {
  const { table, ledger, list } = input;
  const ledgerTargets = ledgerTargetsOf(table, ledger);
  const aggregateTargets = aggregateTargetsOf(table);
  const verificationById = new Map(table.verification.map((entry) => [entry.requirementId, entry] as const));
  const natureById = new Map(table.classification.map((entry) => [entry.requirementId, entry.nature] as const));
  const rolesById = new Map(table.ownership.map((entry) => [entry.requirementId, entry.roles] as const));
  const aggregateRows = ledger.aggregateRows.filter((row) => row.t2Aggregate.codeRanges.length > 0);
  const tests: FixedTest[] = [];
  const observes = new Map<string, string>();
  const excluded: string[] = [];
  const push = (test: FixedTest, observed: string): void => {
    tests.push(test);
    observes.set(test.id, observed);
  };
  for (const requirement of list.requirements) {
    const target = ledgerTargets.get(requirement.id);
    if (target !== undefined) {
      const { row } = target;
      if (row.t2.expectedWriter !== "code") continue;
      const value = row.t2.expected.equals === "target-options" ? [...target.options] : target.value;
      for (const kind of row.t2.requiredKinds) {
        const id = `${GENERATED_TEST_ID_PREFIX}${row.id}:${requirement.id}:${target.fieldId}:${kind}`;
        push(generatedTest(id, requirement.id, row.t2.targetKind, target.fieldId, kind, row.t2.operation, [], value), row.id);
      }
      excluded.push(requirement.id);
      continue;
    }
    // 空の集計：確かめ方が fixed-test で分類が ruled の要件だけ（構造で確かめる要件・在ることだけの要件には境界・異常を作らない）
    if (verificationById.get(requirement.id)?.kind !== "fixed-test" || natureById.get(requirement.id) !== "ruled") continue;
    for (const role of rolesById.get(requirement.id) ?? []) {
      const aggregate = aggregateTargets.get(role.id);
      if (aggregate === undefined) continue;
      for (const row of aggregateRows) {
        const t2 = row.t2Aggregate;
        if (!t2.codeRanges.includes(aggregate.range)) continue;
        for (const { state, kind } of t2.states) {
          const value = aggregateExpectedValueOf(t2, aggregate, state);
          if (value === undefined) continue;
          const id = `${GENERATED_TEST_ID_PREFIX}${row.id}:${requirement.id}:${role.id}:${state}`;
          const empty = state === "empty" ? [aggregate.aggregate.entity] : [];
          push(generatedTest(id, requirement.id, t2.targetKind, role.id, kind, t2.operation, empty, value), row.id);
        }
      }
    }
  }
  return { tests, observes, excludedRequirementIds: excluded };
}

/**
 * LLM の試験のうち、コードが作る試験と同じ（要件・対象・性質・データ状態）の試験と、予約の接頭辞の試験 ID を固定文で落とす
 * （位置は LLM の組の添字。旗 `v12.ids`）。重なりの文は台帳の行の `notAllowed`（確かめ方の性質）か集計の試験の型の
 * `notAllowed`（空の集計）。
 */
export function checkGeneratedOverlap(
  suite: { readonly tests: readonly FixedTest[] },
  observes: ReadonlyMap<string, string>,
  generated: GeneratedTests,
  table: NameTable,
  ledger: LedgerView,
): readonly Problem[] {
  const aggregateTargets = aggregateTargetsOf(table);
  const generatedKeys = new Set<string>();
  for (const test of generated.tests) {
    const observed = generated.observes.get(test.id) ?? "";
    const roleId = test.target.roleId ?? "";
    const aggregate = aggregateTargets.get(roleId);
    const state =
      ledger.aggregateRows.some((row) => row.id === observed) && aggregate !== undefined
        ? aggregateDataStateOf(test, aggregate)
        : LEDGER_STATE;
    generatedKeys.add(keyOf(test.target.requirementId, roleId, observed, state));
  }
  const problems: Problem[] = [];
  suite.tests.forEach((test, index) => {
    if (isGeneratedTestId(test.id)) {
      problems.push({ field: `tests[${index}].id`, message: GENERATED_TEST_ID_MESSAGE });
      return;
    }
    const observed = observes.get(test.id);
    if (observed === undefined) return;
    const roleId = test.target.roleId ?? "";
    const aggregateRow = ledger.aggregateRows.find((row) => row.id === observed);
    const aggregate = aggregateTargets.get(roleId);
    const state = aggregateRow !== undefined && aggregate !== undefined ? aggregateDataStateOf(test, aggregate) : LEDGER_STATE;
    if (!generatedKeys.has(keyOf(test.target.requirementId, roleId, observed, state))) return;
    const message = aggregateRow?.t2Aggregate.messages.notAllowed ?? ledger.rowByObserves.get(observed)?.t2?.messages.notAllowed;
    if (message !== undefined) problems.push({ field: `tests[${index}].observes`, message });
  });
  return problems;
}
