// 名前の表を v1 の型へ写す（07-architecture-v1.1a.md §2.2。Issue #505）。
//
// 写しは **⑤b の評価・⑥・⑥'・⑦・⑧・⑤a のコードの検査の入力**にだけ使う。契約の検査は v1.1α 側で表に
// 対して行う（`names.ts`・B3 は A5）。**純粋な関数**で、同じ表からは同じ写しになる。
//
// 写す欄：
//   - `RoleEntry` … `roleId`＝`id`、`kind`・`entity`・`options` はそのまま、`name`＝`name`、`shared`＝所属の数
//     から導いた値、`aliasOf`＝null、`groupBy`＝enum なら分ける項目の `id`・month なら null
//   - `RoleNameMapping` … 恒等の対応（`roleId`＝`id`、`name`＝`name`）を全行
//   - `RequirementRoleOwnership` … 導いた entity の所属（basis `dependency`・reason）を含む
//   - `RequirementDesign` … `verification`（`default-value` は `fixed-test` に写す）・`checks`・`nature`（表の分類）。`vocabulary`・`placement`・
//     `unwritable` は空の並び
//
// 写さない欄（失われる情報。v1.1α の成果物と検査にだけ残る。§2.2 の表）：
//   - `role`・`source`（役割の説明と出典）… `name-table.json` に残す
//   - `type`・`refEntity`（項目の型・参照先、計算の値の型・範囲・種別、操作・画面の種類）… B3 の追加の検査
//   - `groupBy` の month（`RoleEntry.groupBy` は null になり v1 の検査が掛からない）… B3 の（集計元 entity・
//     項目・month）の組の検査
//   - default-value の `value`（期待する既定値のキー）… T2 の検査と B4 の照合が表から読む（Issue #533）
//   - unresolved の `constraintIds`（v1 の `RequirementVerification` に欄が無い）… `carry-over.json` に残す
//   - `RoleEntry.name` の意味（v1 では呼び名の欄。ここには宣言の名前が入る）
//   - 試験の `observes` と網羅の単位（表の外。`coverage.ts`）
import type { RequirementRoleOwnership } from "../stages/correspondence.js";
import type {
  DesignResult,
  RequirementDesign,
  RequirementVerification,
  RoleEntry,
  RoleNameMapping,
} from "../pipeline.js";
import { deriveOwnership, sharedRowIds, type NameTable, type NameTableVerification } from "./names.js";

/** v1 の型への写し */
export interface V1Conversion {
  readonly design: DesignResult;
  /** 恒等の対応（全行） */
  readonly mappings: readonly RoleNameMapping[];
  /** 要件ごとの所属（導いた entity の所属を含む。⑤a のコードの検査の入力） */
  readonly ownership: readonly RequirementRoleOwnership[];
}

/** 表の行を v1 の役割の表の行へ写す */
export function toRoleEntries(table: NameTable): readonly RoleEntry[] {
  const shared = sharedRowIds(table);
  return table.rows.map((row) => ({
    roleId: row.id,
    kind: row.kind,
    entity: row.entity,
    name: row.name,
    shared: shared.has(row.id),
    aliasOf: null,
    options: row.options,
    groupBy: row.groupBy !== null && row.groupBy.kind === "enum" ? row.groupBy.field : null,
  }));
}

/** 恒等の対応（`roleId`＝`id`、`name`＝`name`）を全行ぶん返す */
export function identityMappings(table: NameTable): readonly RoleNameMapping[] {
  return table.rows.map((row) => ({ roleId: row.id, name: row.name }));
}

function toVerification(entry: NameTableVerification): RequirementVerification {
  switch (entry.kind) {
    case "fixed-test":
      return { kind: "fixed-test" };
    case "structural":
      return { kind: "structural", reason: entry.reason };
    case "unresolved":
      return { kind: "unresolved", reason: entry.reason };
    case "default-value":
      // v1 の型は変えない（既定値の免除は v1.1α の T2 が表の確かめ方で掛ける。Issue #533）
      return { kind: "fixed-test" };
  }
}

/** 名前の表を v1 の型へ写す（決定的。§2.2） */
export function toV1(table: NameTable): V1Conversion {
  const ownership: readonly RequirementRoleOwnership[] = deriveOwnership(table).map((entry) => ({
    requirementId: entry.requirementId,
    ownership: entry.roles.map((role) => ({ roleId: role.id, basis: role.basis, reason: role.reason })),
  }));
  const ownershipById = new Map(ownership.map((entry) => [entry.requirementId, entry.ownership] as const));
  const natureById = new Map(table.classification.map((entry) => [entry.requirementId, entry.nature] as const));
  const designs: readonly RequirementDesign[] = table.verification.map((entry) => {
    const nature = natureById.get(entry.requirementId);
    return {
      requirementId: entry.requirementId,
      ...(nature === undefined ? {} : { nature }),
      verification: toVerification(entry),
      checks: entry.kind === "structural" ? entry.checks : [],
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: ownershipById.get(entry.requirementId) ?? [],
    };
  });
  return { design: { roles: toRoleEntries(table), designs }, mappings: identityMappings(table), ownership };
}
