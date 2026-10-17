// B3 名前の照合（07-architecture-v1.1a.md §1 の表・§1.2・§2.1・§2.2・D3・D14。Issue #510）。
//
// 名前は T1 の表で固定済みなので、**対応（mappings）を LLM に提出させない**。表から恒等の対応
// （`identityMappings`）と要件ごとの対応表（`correspondenceFromTable`）を導き、v1 の `checkRoleMappings` を
// **新契約（所属つき）**で呼ぶ。⑤a の LLM（`runCorrespondence`）は呼ばない。
//
// v1 の検査のうち効くのは次だけである：
//   2. 実在・種類・所属 entity・画面からの到達（entity・項目）／計算の画面からの到達（`checkCorrespondence`）
//   5. 選択肢（enum）の options の順・enum の見出しの組（集計元 entity・項目・month === false）
// **1.（対応の提出漏れ・重複）と 3.（所属の場所が要件の対応表の内側）は構成上つねに通る**——対応も対応表も
// 同じ表から導くので、提出漏れも対応表の外も起きない（自己照合であって点検ではない。§1.1）。
//
// 足す検査（v1 の型へ写すと落ちる欄。§2.2）：
//   - 項目の型（`FieldKind`）。参照（`ref`）・並び（`list`）は参照先（`refEntity` の行の名前）まで
//   - 計算の値の型（宣言の `type`）・範囲（`entity` の有無／`scope: app`／どちらも無い＝見出しごと）・
//     種別（`expression`／`aggregate`／`settle` の欄）。精算は `type` を持たないので値の型は照らさない
//   - 月の見出し（`groupBy.month === true`・分ける項目の名前・**`aggregate.entity` が表の集計元 entity の名前**）
//   - 操作の種類（省略は create）と `when` の有無
//   - 画面の種類（`type` を省いた画面はどの種類とも一致しない。fail-closed）
//   - 集計の種類と集計元（表の計算の行が `aggregate` を持つときだけ＝旗 on で台帳が集計の種類を持つ走り。Issue #549）：
//     宣言の `aggregate.kind` が表の種類と、`aggregate.entity` が表の集計元の entity の行の名前と同じこと。off の表は
//     欄を持たない（T1' が形で落とす）ので見ない
// 落ちはすべて `CorrespondenceMiss`（行き先 `missing-element`）にして、⑥（B5）へ回す。
//
// 除く範囲（D14）：持ち越しの要件は一覧から除いて渡し、**一覧のどの要件も所属させない行**（持ち越しの
// 要件だけが所属させる行）は役割の表・恒等の対応・対応表から除く（`checkRoleMappings` は渡した全部の役割を
// 照合するため）。共有する行は残して検査する。
//
// LLM を呼ばない純粋な関数だけを置く。
import {
  actionKind,
  fieldKind,
  fieldTarget,
  isAppComputed,
  isComputedAggregate,
  isComputedSettle,
  isGroupComputed,
  type Computed,
  type NormalizedAppSpec,
} from "@musunest/appspec-schema";
import type { CorrespondenceEntry, CorrespondenceMiss, DeclarationLocation, RequirementList } from "../pipeline.js";
import {
  checkCorrespondence,
  checkRoleMappings,
  declarationHasLocation,
  findComputed,
  findEntity,
  type RequirementRoleOwnership,
  type RoleMappingMiss,
} from "../stages/correspondence.js";
import { correspondenceFromTable, rowLocation } from "./bind-by-id.js";
import { toRoleEntries, toV1, type V1Conversion } from "./convert.js";
import {
  ownersByRowId,
  type ComputationRowType,
  type NameTable,
  type NameTableRow,
  type OperationRowType,
  type ScreenRowType,
} from "./names.js";

/** B3 が受け取るもの */
export interface NameCheckInput {
  readonly app: NormalizedAppSpec;
  /** 名前の表（builder に見せた全行） */
  readonly table: NameTable;
  /** 照合する要件の一覧（持ち越しを除いた残り） */
  readonly list: RequirementList;
  /**
   * 要件ごとの所属（評価の文脈の所属。v1 の型）。一覧の要件と照合する行に絞って使う。省けば表から導く
   * （A1 の写し。導いた entity の所属を含む）
   */
  readonly ownership?: readonly RequirementRoleOwnership[];
  /** 除く行の `id`（持ち越しの要件だけが所属させる行。一覧に所属させる要件が無い行も除く） */
  readonly excludedRowIds?: readonly string[];
}

/** 照合する範囲（一覧と、照合する行に絞った表とその写し） */
export interface NameCheckScope {
  /** 照合する行と一覧の要件だけの表 */
  readonly table: NameTable;
  /** 絞った表の v1 の写し（役割の表・恒等の対応・所属） */
  readonly conversion: V1Conversion;
  /** 除いた行の `id`（表の順） */
  readonly excludedRowIds: readonly string[];
}

/** B3 の結果 */
export interface NameCheckResult {
  /** 表から導いた要件ごとの対応表（一覧の要件だけ） */
  readonly entries: readonly CorrespondenceEntry[];
  /** 落ち（v1 の検査と足した検査。行き先は ⑥） */
  readonly misses: readonly CorrespondenceMiss[];
  /** 照合した行の `id`（表の順） */
  readonly checkedRowIds: readonly string[];
  /** 除いた行の `id`（表の順） */
  readonly excludedRowIds: readonly string[];
}

/**
 * 照合する範囲を決める（D14）。一覧の要件が 1 つでも所属させる行（導いた entity の所属を含む）だけを残し、
 * 渡された除く行と、一覧のどの要件も所属させない行を除く。
 */
export function nameCheckScope(
  table: NameTable,
  list: RequirementList,
  excludedRowIds: readonly string[] = [],
): NameCheckScope {
  const listed = new Set(list.requirements.map((requirement) => requirement.id));
  const given = new Set(excludedRowIds);
  const owners = ownersByRowId(table);
  const kept = new Set(
    table.rows
      .filter((row) => !given.has(row.id) && (owners.get(row.id) ?? []).some((owner) => listed.has(owner)))
      .map((row) => row.id),
  );
  const inList = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] =>
    entries.filter((entry) => listed.has(entry.requirementId));
  const scoped: NameTable = {
    rows: table.rows.filter((row) => kept.has(row.id)),
    ownership: inList(table.ownership).map((entry) => ({
      requirementId: entry.requirementId,
      roles: entry.roles.filter((role) => kept.has(role.id)),
    })),
    verification: inList(table.verification),
    classification: inList(table.classification),
  };
  return {
    table: scoped,
    conversion: toV1(scoped),
    excludedRowIds: table.rows.filter((row) => !kept.has(row.id)).map((row) => row.id),
  };
}

// ── 足す検査（型・参照先・月の見出し・操作・画面）─────────────────────────

const isComputationType = (type: NameTableRow["type"]): type is ComputationRowType =>
  type !== null && typeof type === "object" && "valueType" in type;
const isOperationType = (type: NameTableRow["type"]): type is OperationRowType =>
  type !== null && typeof type === "object" && "action" in type;
const isScreenType = (type: NameTableRow["type"]): type is ScreenRowType =>
  type !== null && typeof type === "object" && "view" in type;

/** 計算の範囲（宣言の `entity`・`scope` の有無から） */
function computedScope(computed: Computed): "row" | "app" | "groups" {
  if (isGroupComputed(computed)) return "groups";
  if (isAppComputed(computed)) return "app";
  return "row";
}

/** 計算の種別（宣言の `expression`・`aggregate`・`settle` の欄から） */
function computedForm(computed: Computed): "expression" | "aggregate" | "settle" {
  if (isComputedSettle(computed)) return "settle";
  if (isComputedAggregate(computed)) return "aggregate";
  return "expression";
}

/** 行の `id` → 名前（表の行） */
const nameOfRow = (table: NameTable, id: string | null): string | null =>
  id === null ? null : (table.rows.find((row) => row.id === id)?.name ?? null);

/**
 * 1 行の足す検査。宣言にその（種類・所属 entity の名前・名前）の場所が無い行は検査しない（実在の落ちは v1 の
 * 検査が出す）。合わない欄ごとに 1 つの理由を返す。
 */
function extraProblems(
  app: NormalizedAppSpec,
  table: NameTable,
  row: NameTableRow,
  location: DeclarationLocation,
  fullTable: NameTable = table,
): readonly string[] {
  const problems: string[] = [];
  switch (row.kind) {
    case "entity":
      return problems;
    case "field": {
      const declaration = findEntity(app, location.entity)?.fields[location.name];
      if (declaration === undefined || typeof row.type !== "string") return problems;
      const actual = fieldKind(declaration);
      if (actual !== row.type) {
        problems.push(`項目 ${location.name} の型が ${actual}（表は ${row.type}）`);
        return problems;
      }
      if (actual === "ref" || actual === "list") {
        const expected = nameOfRow(table, row.refEntity);
        const target = fieldTarget(declaration);
        if (target !== expected) {
          problems.push(`項目 ${location.name} の参照先が ${target ?? "無し"}（表は ${expected ?? "無し"}）`);
        }
      }
      return problems;
    }
    case "computation": {
      const computed = findComputed(app, location);
      if (computed === undefined || !isComputationType(row.type)) return problems;
      const { valueType, scope, form } = row.type;
      // 精算は `type` を持たない（値は送金の並び）ので、値の型は照らさない
      if (!isComputedSettle(computed) && computed.type !== valueType) {
        problems.push(`計算 ${location.name} の値の型が ${computed.type}（表は ${valueType}）`);
      }
      const actualScope = computedScope(computed);
      if (actualScope !== scope) problems.push(`計算 ${location.name} の範囲が ${actualScope}（表は ${scope}）`);
      const actualForm = computedForm(computed);
      if (actualForm !== form) problems.push(`計算 ${location.name} の種別が ${actualForm}（表は ${form}）`);
      // 集計の種類と集計元（表の行が持つときだけ。種別が集計でない宣言は上の種別の落ちに任せる。Issue #549）
      const aggregate = row.type.aggregate;
      if (aggregate !== undefined && aggregate !== null && isComputedAggregate(computed)) {
        if (computed.aggregate.kind !== aggregate.kind) {
          problems.push(`計算 ${location.name} の集計の種類が ${computed.aggregate.kind}（表は ${aggregate.kind}）`);
        }
        // 集計元の entity の行は照合の範囲の外（持ち越しの要件だけが所属させる行）でも名前を引ける（全行の表から）
        const expectedEntity = nameOfRow(fullTable, aggregate.entity);
        if (computed.aggregate.entity !== expectedEntity) {
          problems.push(`計算 ${location.name} の集計元が ${computed.aggregate.entity}（表は ${expectedEntity ?? "無し"}）`);
        }
      }
      if (row.groupBy !== null && row.groupBy.kind === "month") {
        // 月の見出し：（集計元 entity・項目・month）の組で照らす。項目名と month だけでは、別 entity の同名の
        // date 項目へ向けた宣言を通してしまう（見出しごとの集計は自身の entity を持たない。§2.2）
        const fieldRow = table.rows.find((candidate) => candidate.id === row.groupBy?.field);
        const fieldName = fieldRow?.name ?? null;
        const entityName = nameOfRow(table, fieldRow?.entity ?? null);
        const grouping = isGroupComputed(computed) ? computed.aggregate.groupBy : undefined;
        const matches =
          isGroupComputed(computed) &&
          grouping !== undefined &&
          grouping.month === true &&
          grouping.field === fieldName &&
          computed.aggregate.entity === entityName;
        if (!matches) {
          problems.push(
            `見出しごとの集計 ${location.name} が、表の月の見出しの組（entity ${String(entityName)} の項目 ${String(fieldName)}・month）で分けていない`,
          );
        }
      }
      return problems;
    }
    case "operation": {
      const action = app.spec.actions.find(
        (candidate) => candidate.name === location.name && (location.entity === null || candidate.entity === location.entity),
      );
      if (action === undefined || !isOperationType(row.type)) return problems;
      const actual = actionKind(action);
      if (actual !== row.type.action) problems.push(`操作 ${location.name} の種類が ${actual}（表は ${row.type.action}）`);
      const hasWhen = action.when !== undefined;
      if (hasWhen !== row.type.hasWhen) {
        problems.push(`操作 ${location.name} の条件（when）が${hasWhen ? "ある" : "無い"}（表は${row.type.hasWhen ? "ある" : "無い"}）`);
      }
      return problems;
    }
    case "screen": {
      const view = app.spec.views.find((candidate) => candidate.name === location.name);
      if (view === undefined || !isScreenType(row.type)) return problems;
      if (view.type !== row.type.view) {
        problems.push(`画面 ${location.name} の種類が ${view.type ?? "無し"}（表は ${row.type.view}）`);
      }
      return problems;
    }
  }
}

const missKey = (miss: CorrespondenceMiss): string | null =>
  miss.location === undefined
    ? null
    : `${miss.requirementId}\u0000${miss.location.kind}\u0000${miss.location.entity ?? ""}\u0000${miss.location.name}`;

/**
 * B3 を掛ける。一覧と所属（文脈）で照合する範囲を決め、v1 の検査（`checkCorrespondence`・新契約の
 * `checkRoleMappings`）と足す検査を掛ける。落ちの並びは、対応表の検査・役割の照合・足す検査の順。
 */
export function checkNames(input: NameCheckInput): NameCheckResult {
  const scope = nameCheckScope(input.table, input.list, input.excludedRowIds);
  const kept = new Set(scope.table.rows.map((row) => row.id));
  const listed = new Set(input.list.requirements.map((requirement) => requirement.id));
  const ownership: readonly RequirementRoleOwnership[] =
    input.ownership === undefined
      ? scope.conversion.ownership
      : input.ownership
          .filter((entry) => listed.has(entry.requirementId))
          .map((entry) => ({
            requirementId: entry.requirementId,
            ownership: entry.ownership.filter((own) => kept.has(own.roleId)),
          }));
  const entries = correspondenceFromTable(scope.table);
  const roles = toRoleEntries(scope.table);
  const mappingMisses = checkRoleMappings(input.app, roles, entries, scope.conversion.mappings, { ownership });
  // 実在しない場所は 2 つの v1 の検査がどちらも挙げる。同じ要件・同じ場所の落ちは役割の照合の側だけを残す
  const mapped = new Set(mappingMisses.map(missKey).filter((key): key is string => key !== null));
  const entryMisses = checkCorrespondence(input.app, input.list, entries).filter((miss) => {
    const key = missKey(miss);
    return key === null || !mapped.has(key);
  });

  /** その行を所属させた一覧の要件のうち、所属の順で最初のもの（落ちの要件 ID。空にしない） */
  const firstOwner = (id: string): string =>
    ownership.find((entry) => entry.ownership.some((own) => own.roleId === id))?.requirementId ?? "";
  const extraMisses: RoleMappingMiss[] = [];
  for (const row of scope.table.rows) {
    const location = rowLocation(scope.table, row.id);
    if (location === undefined || !declarationHasLocation(input.app, location)) continue;
    for (const detail of extraProblems(input.app, scope.table, row, location, input.table)) {
      extraMisses.push({ requirementId: firstOwner(row.id), location, detail, route: "missing-element" });
    }
  }
  const misses: readonly CorrespondenceMiss[] = [...entryMisses, ...mappingMisses, ...extraMisses];
  return {
    entries,
    misses,
    checkedRowIds: scope.table.rows.map((row) => row.id),
    excludedRowIds: scope.excludedRowIds,
  };
}
