// 表の `id` による結び付け・該当箇所の印・追加の要素（07-architecture-v1.1a.md §1.1・§2.1・D4・D11。Issue #505）。
//
// v1 の `bindTests` は対応表の候補を名前だけで絞るので、同じ要件が別 entity の同名の項目を所属させると
// `ambiguous` になる（`stages/bind.ts`）。v1.1α は**表の `id` →（種類・entity の名前・名前）→ 宣言の場所**を
// 決定的に引き、**試験 ID で引く写像**を返す（並びで引かない。棄却で並びが変わっても古い位置を使わない）。
//
//   - 宣言に無ければ未解決（`unbound`。v1 の `BindCause` の `no-candidate`）。表に無い `id` は `no-mapping`
//   - validate の試験は v1 と同じく**項目の名前で検査を探す**（M-03 は残る。表に validation の行が無い。D3）。その場所の
//     持ち主は `requiredValidationLocation` 1 つで、B1・直す段に渡す「要る検査の骨組み」も同じ関数から導く（Issue #666）
//
// B3' の印（`markRows`）は、表の `id` ごとに正規化した JSON の中の該当箇所（要素の種類・名前・経路）と
// 参照先（式が参照する計算・項目、画面の `show`・`highlight` が指す項目と計算、集計の `entity` と `groupBy`
// ほか）を引き当てる。**「どこを見るか」を示すだけで点検の範囲を狭めない**（B3' には宣言の全文を渡す）。
// 引き当てられない `id` は印なし（受理せず持ち越す判定は A5）。
//
// 表に無い追加の要素の一覧の**正本は `extraElementsOf` 1 つ**である（B3' の入力と記録が同じ値を使う。D4）。
//
// LLM を呼ばない純粋な関数だけを置く。
import {
  isAppComputed,
  isComputedAggregate,
  isComputedExpression,
  isComputedSettle,
  isGroupComputed,
  type Aggregate,
  type Computed,
  type NormalizedAppSpec,
} from "@musunest/appspec-schema";
import { parseExpression, type AstNode } from "@musunest/spec-engine";
import type {
  CorrespondenceEntry,
  DeclarationLocation,
  FixedTest,
  TestSuite,
} from "../pipeline.js";
import type { BindResult } from "../stages/bind.js";
import { declarationHasLocation, declarationKindOfRole } from "../stages/correspondence.js";
import { deriveOwnership, type NameTable, type NameTableRow } from "./names.js";
import type { TestObserves } from "./stages/test-spec.js";

// ── 表の `id` → 宣言の場所 ────────────────────────────────────────────

/** 表の行の、宣言での場所（種類・所属 entity の名前・名前）。所属 entity の行が引けなければ undefined */
export function rowLocation(table: NameTable, id: string): DeclarationLocation | undefined {
  const row = table.rows.find((candidate) => candidate.id === id);
  if (row === undefined) return undefined;
  return locationOfRow(table, row);
}

function locationOfRow(table: NameTable, row: NameTableRow): DeclarationLocation | undefined {
  let entity: string | null = null;
  if (row.entity !== null) {
    const owner = table.rows.find((candidate) => candidate.id === row.entity && candidate.kind === "entity");
    if (owner === undefined) return undefined;
    entity = owner.name;
  }
  return { kind: declarationKindOfRole(row.kind), entity, name: row.name };
}

const locationKey = (location: DeclarationLocation): string =>
  `${location.kind}\u0000${location.entity ?? ""}\u0000${location.name}`;

/** entity の `id` → 宣言の名前（宣言にその entity が在るものだけ。参照データの行の entity を引く） */
export function entityNamesById(app: NormalizedAppSpec, table: NameTable): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const row of table.rows) {
    if (row.kind !== "entity") continue;
    if (app.spec.entities.some((entity) => entity.name === row.name)) names.set(row.id, row.name);
  }
  return names;
}

/** 結び付けの結果（試験 ID で引く写像と、entity の `id` → 宣言の名前） */
export interface IdBindings {
  readonly bindings: ReadonlyMap<string, BindResult>;
  readonly entityNames: ReadonlyMap<string, string>;
}

/**
 * 試験ごとに、表の `id` で宣言の場所を決定的に引く（D11）。試験 ID → 結果の写像を返す。
 *
 *   - selector の `roleId` が表に無い → `unbound`（`no-mapping`）
 *   - 試験の対象の種類が表の行の種類と合わない・所属 entity の行が引けない → `unbound`（`no-candidate`）
 *   - validate の試験 → 所属 entity の検査のうち、**行の名前と同じ名前**の検査を探す（M-03。v1 と同じ）
 *   - 場所が宣言に無い → `unbound`（`no-candidate`）
 */
export function bindTestsById(app: NormalizedAppSpec, table: NameTable, suite: TestSuite): IdBindings {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  const bindings = new Map<string, BindResult>();
  for (const test of suite.tests) {
    const roleId = test.target.roleId;
    const row = roleId === undefined ? undefined : rowById.get(roleId);
    if (row === undefined) {
      bindings.set(test.id, {
        kind: "unbound",
        testId: test.id,
        cause: "no-mapping",
        detail: "試験の対象の ID が名前の表に無い",
      });
      continue;
    }
    // validate の試験の場所は `requiredValidationLocation` 1 つが決める（M-03。v1 と同じ。Issue #666）
    const location: DeclarationLocation | undefined =
      test.operation === "validate"
        ? requiredValidationLocation(table, test)
        : row.kind === test.target.kind
          ? locationOfRow(table, row)
          : undefined;
    if (location === undefined || !declarationHasLocation(app, location)) {
      bindings.set(test.id, {
        kind: "unbound",
        testId: test.id,
        cause: "no-candidate",
        detail: "表の ID が指す場所が宣言に無い",
      });
      continue;
    }
    bindings.set(test.id, { kind: "bound", testId: test.id, location });
  }
  return { bindings, entityNames: entityNamesById(app, table) };
}

// ── validate の試験が要求する検査の場所と、要る検査の骨組み（Issue #666）──────────────────────────

/**
 * validate の試験 1 件が**要求する検査の場所**（結び付けの契約。M-03：名前で結ぶ）。表の id の結び付け
 * （`bindTestsById`）はこの関数で validate の場所を決める。要る検査の骨組み（`requiredValidationsOf`）も同じ関数から導く。
 *
 *   - 項目の行 → 所属 entity の名前・項目の名前
 *   - entity の行 → その entity の名前・entity の名前
 *   - validate でない・表に無い id・試験の対象の種類が行の種類と合わない・所属 entity の行が引けない → undefined
 */
export function requiredValidationLocation(table: NameTable, test: FixedTest): DeclarationLocation | undefined {
  if (test.operation !== "validate") return undefined;
  const roleId = test.target.roleId;
  const row = roleId === undefined ? undefined : table.rows.find((candidate) => candidate.id === roleId);
  if (row === undefined || row.kind !== test.target.kind) return undefined;
  const base = locationOfRow(table, row);
  if (base === undefined) return undefined;
  return { kind: "validation", entity: row.kind === "entity" ? row.name : base.entity, name: row.name };
}

/**
 * 要る検査の骨組み 1 件（B1・直す段にデータで渡す）。所属 entity の名前・検査の名前・対象の行の id と種類・要求する試験 ID の
 * 並び・競合の印だけを持つ（式・期待・分類・宣言・表の名前の写しは持たない。R2-1）。
 * `conflict` が真の件は、ほかの件に同じ名前がある（別の entity の同名の行、または同じ（entity・名前）を要求する別の行。検査の
 * 名前は宣言全体で一意なので、名前で結ぶ契約の上では両方を実現できない）。書く要求にしない（どちらかを選ばない・改名しない）。
 */
export interface RequiredValidation {
  readonly entity: string | null;
  readonly name: string;
  readonly rowId: string;
  readonly rowKind: NameTableRow["kind"];
  readonly testIds: readonly string[];
  readonly conflict: boolean;
}

/**
 * 固定した組と表から、要る検査の骨組みを導く（純粋。宣言に依らない）。観測する性質が `validation` の validate の試験だけ
 * （既定値・選択肢の集合の試験は専用の照合で検査を要求しないので除く）。同じ行の試験は 1 件にまとめ、並びは表の行の順
 * （試験 ID は組の順）。同じ名前を 2 つ以上の行が要求すれば（別 entity の同名・同じ（entity・名前）を要求する entity の行と項目の
 * 行）、その全件に競合の印を付ける（並びで選ばない）。呼ぶ側は評価の文脈と同じ組（棄却・持ち越しで外した後の組）を渡す。
 */
export function requiredValidationsOf(
  table: NameTable,
  suite: TestSuite,
  observes: ReadonlyMap<string, TestObserves>,
): readonly RequiredValidation[] {
  const rowIndex = new Map(table.rows.map((row, index) => [row.id, index] as const));
  const entries = new Map<string, { row: NameTableRow; location: DeclarationLocation; testIds: string[] }>();
  for (const test of suite.tests) {
    if (observes.get(test.id) !== "validation") continue;
    const location = requiredValidationLocation(table, test);
    const row = table.rows.find((candidate) => candidate.id === test.target.roleId);
    if (location === undefined || row === undefined) continue;
    const found = entries.get(row.id);
    if (found === undefined) entries.set(row.id, { row, location, testIds: [test.id] });
    else found.testIds.push(test.id);
  }
  const ordered = [...entries.values()].sort((a, b) => (rowIndex.get(a.row.id) ?? 0) - (rowIndex.get(b.row.id) ?? 0));
  return ordered.map((entry) => ({
    entity: entry.location.entity,
    name: entry.location.name,
    rowId: entry.row.id,
    rowKind: entry.row.kind,
    testIds: entry.testIds,
    conflict: ordered.some((other) => other !== entry && other.location.name === entry.location.name),
  }));
}

/**
 * 要件ごとの対応表を表から導く（所属させた行の場所の集合。導いた entity の所属を含む）。
 * `excludedRowIds` の行の場所は入れない（持ち越しで除く行。§1.2・D14）。要件の並びは表の所属の順。
 */
export function correspondenceFromTable(
  table: NameTable,
  excludedRowIds: ReadonlySet<string> = new Set(),
): readonly CorrespondenceEntry[] {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  return deriveOwnership(table).map((entry) => {
    const seen = new Set<string>();
    const locations: DeclarationLocation[] = [];
    for (const role of entry.roles) {
      if (excludedRowIds.has(role.id)) continue;
      const row = rowById.get(role.id);
      const location = row === undefined ? undefined : locationOfRow(table, row);
      if (location === undefined || seen.has(locationKey(location))) continue;
      seen.add(locationKey(location));
      locations.push(location);
    }
    return { requirementId: entry.requirementId, locations };
  });
}

// ── 正規化した JSON の中の要素と経路 ─────────────────────────────────────

/** 宣言の要素 1 つ（種類・所属 entity の名前・名前・正規化した JSON の中の経路） */
export interface DeclarationElement extends DeclarationLocation {
  readonly path: string;
}

/** 宣言の全要素を、決まった順（entity と項目・検査・計算・操作・画面）で並べる */
export function declarationElementsOf(app: NormalizedAppSpec): readonly DeclarationElement[] {
  const elements: DeclarationElement[] = [];
  app.spec.entities.forEach((entity, index) => {
    elements.push({ kind: "entity", entity: null, name: entity.name, path: `spec.entities[${index}]` });
    for (const name of Object.keys(entity.fields)) {
      elements.push({ kind: "field", entity: entity.name, name, path: `spec.entities[${index}].fields.${name}` });
    }
  });
  app.spec.validations.forEach((validation, index) => {
    elements.push({ kind: "validation", entity: validation.entity, name: validation.name, path: `spec.validations[${index}]` });
  });
  app.spec.computed.forEach((computed, index) => {
    elements.push({ kind: "computation", entity: computedEntity(computed), name: computed.name, path: `spec.computed[${index}]` });
  });
  app.spec.actions.forEach((action, index) => {
    elements.push({ kind: "action", entity: action.entity, name: action.name, path: `spec.actions[${index}]` });
  });
  app.spec.views.forEach((view, index) => {
    elements.push({ kind: "view", entity: view.entity ?? null, name: view.name, path: `spec.views[${index}]` });
  });
  return elements;
}

function computedEntity(computed: Computed): string | null {
  return isAppComputed(computed) || isGroupComputed(computed) ? null : computed.entity;
}

/**
 * 表に無い追加の要素の一覧（D4）。宣言の entity・項目・計算・検査・操作・画面のうち、表の（種類・entity の名前・
 * 名前）に無いものを（名前・種類・経路）で返す。表に validation の行は無いので、検査は全部入る。
 * **一覧の正本はこの関数 1 つ**（B3' の入力と記録が同じ値を使う）。
 */
export function extraElementsOf(app: NormalizedAppSpec, table: NameTable): readonly DeclarationElement[] {
  const known = new Set<string>();
  for (const row of table.rows) {
    const location = locationOfRow(table, row);
    if (location !== undefined) known.add(locationKey(location));
  }
  return declarationElementsOf(app).filter((element) => !known.has(locationKey(element)));
}

// ── B3' の印（該当箇所と参照先）──────────────────────────────────────────

/** 参照の経路（どの欄からの参照か） */
export type MarkReferenceVia =
  | "expression"
  | "when"
  | "set"
  | "ref"
  | "aggregate-entity"
  | "aggregate-name"
  | "aggregate-groupBy"
  | "aggregate-where"
  | "settle"
  | "entity"
  | "show"
  | "highlight"
  | "columns"
  | "filters"
  | "widget";

/**
 * 参照先 1 つ。`path` は正規化した JSON の中の参照先の経路で、**宣言の中に引き当てられなければ null**
 * （式の名前が項目にも計算にも無い、など。`kind` は `unknown`）。
 */
export interface MarkReference {
  readonly kind: "entity" | "field" | "computation" | "unknown";
  readonly entity: string | null;
  readonly name: string;
  readonly via: MarkReferenceVia;
  readonly path: string | null;
}

/** 表の `id` 1 つの印（該当箇所と参照先） */
export interface DeclarationMark {
  readonly id: string;
  readonly element: DeclarationElement;
  readonly references: readonly MarkReference[];
}

class Resolver {
  constructor(private readonly app: NormalizedAppSpec) {}

  entityPath(name: string): string | null {
    const index = this.app.spec.entities.findIndex((entity) => entity.name === name);
    return index < 0 ? null : `spec.entities[${index}]`;
  }

  fieldPath(entity: string, name: string): string | null {
    const index = this.app.spec.entities.findIndex((candidate) => candidate.name === entity);
    const host = this.app.spec.entities[index];
    if (host === undefined || !Object.hasOwn(host.fields, name)) return null;
    return `spec.entities[${index}].fields.${name}`;
  }

  /** 計算の経路（`entity` が null ならアプリ全体・見出しごとの計算から、そうでなければその entity の計算から） */
  computedPath(entity: string | null, name: string): string | null {
    const index = this.app.spec.computed.findIndex(
      (computed) => computed.name === name && computedEntity(computed) === entity,
    );
    return index < 0 ? null : `spec.computed[${index}]`;
  }

  entity(name: string, via: MarkReferenceVia): MarkReference {
    const path = this.entityPath(name);
    return { kind: path === null ? "unknown" : "entity", entity: null, name, via, path };
  }

  field(entity: string, name: string, via: MarkReferenceVia): MarkReference {
    const path = this.fieldPath(entity, name);
    return { kind: path === null ? "unknown" : "field", entity, name, via, path };
  }

  /** 項目か、その entity の計算（行ごとの値の名前） */
  rowValue(entity: string, name: string, via: MarkReferenceVia): MarkReference {
    const field = this.fieldPath(entity, name);
    if (field !== null) return { kind: "field", entity, name, via, path: field };
    const computed = this.computedPath(entity, name);
    if (computed !== null) return { kind: "computation", entity, name, via, path: computed };
    return { kind: "unknown", entity, name, via, path: null };
  }

  /** アプリ全体・見出しごとの計算 */
  appValue(name: string, via: MarkReferenceVia): MarkReference {
    const path = this.computedPath(null, name);
    return { kind: path === null ? "unknown" : "computation", entity: null, name, via, path };
  }

  /** 式の中の名前（host が null ならアプリ全体の計算として引く） */
  expression(text: string, host: string | null, via: MarkReferenceVia): readonly MarkReference[] {
    const parsed = parseExpression(text);
    if (!parsed.ok) return [];
    const references: MarkReference[] = [];
    const walk = (node: AstNode): void => {
      switch (node.kind) {
        case "name":
          references.push(host === null ? this.appValue(node.name, via) : this.rowValue(host, node.name, via));
          return;
        case "member":
          references.push(this.rowValue(node.entity, node.name, via));
          return;
        case "unary":
          walk(node.operand);
          return;
        case "binary":
          walk(node.left);
          walk(node.right);
          return;
        case "call":
          node.args.forEach(walk);
          return;
        case "number":
        case "string":
          return;
      }
    };
    walk(parsed.ast);
    return references;
  }

  aggregate(aggregate: Aggregate): readonly MarkReference[] {
    const references: MarkReference[] = [this.entity(aggregate.entity, "aggregate-entity")];
    if (aggregate.name !== null) references.push(this.rowValue(aggregate.entity, aggregate.name, "aggregate-name"));
    if (aggregate.groupBy !== undefined) {
      references.push(this.field(aggregate.entity, aggregate.groupBy.field, "aggregate-groupBy"));
    }
    for (const key of Object.keys(aggregate.where)) {
      references.push(this.field(aggregate.entity, key, "aggregate-where"));
    }
    return references;
  }
}

function referencesOf(app: NormalizedAppSpec, resolver: Resolver, element: DeclarationElement): readonly MarkReference[] {
  const index = Number(/\[(\d+)\]/.exec(element.path)?.[1] ?? -1);
  switch (element.kind) {
    case "entity":
    case "validation":
      return [];
    case "field": {
      const declaration = app.spec.entities.find((entity) => entity.name === element.entity)?.fields[element.name];
      if (declaration === undefined || typeof declaration === "string") return [];
      if (declaration.type === "ref") return [resolver.entity(declaration.to, "ref")];
      if ("of" in declaration) return [resolver.entity(declaration.of, "ref")];
      return [];
    }
    case "computation": {
      const computed = app.spec.computed[index];
      if (computed === undefined) return [];
      if (isComputedSettle(computed)) {
        const { expense, amount, payer, shares } = computed.settle;
        return [
          resolver.entity(expense, "settle"),
          resolver.field(expense, amount, "settle"),
          resolver.field(expense, payer, "settle"),
          resolver.field(expense, shares, "settle"),
        ];
      }
      if (isComputedAggregate(computed)) return resolver.aggregate(computed.aggregate);
      if (isComputedExpression(computed)) {
        return resolver.expression(computed.expression, computedEntity(computed), "expression");
      }
      return [];
    }
    case "action": {
      const action = app.spec.actions[index];
      if (action === undefined) return [];
      const references: MarkReference[] = [resolver.entity(action.entity, "entity")];
      for (const key of Object.keys(action.set ?? {})) references.push(resolver.field(action.entity, key, "set"));
      if (action.when !== undefined) references.push(...resolver.expression(action.when, action.entity, "when"));
      return references;
    }
    case "view": {
      const view = app.spec.views[index];
      if (view === undefined) return [];
      const references: MarkReference[] = [];
      const host = view.entity;
      if (host !== undefined) {
        references.push(resolver.entity(host, "entity"));
        for (const name of view.show ?? []) references.push(resolver.rowValue(host, name, "show"));
        if (view.highlight !== undefined) references.push(resolver.rowValue(host, view.highlight, "highlight"));
        if (view.columns !== undefined) references.push(resolver.field(host, view.columns, "columns"));
        for (const name of view.filters ?? []) references.push(resolver.field(host, name, "filters"));
      }
      for (const part of view.widgets ?? []) {
        if (part.type === "ranking") {
          references.push(resolver.entity(part.entity, "widget"));
          references.push(resolver.rowValue(part.entity, part.by, "widget"));
          for (const name of part.show) references.push(resolver.rowValue(part.entity, name, "widget"));
        } else {
          references.push(resolver.appValue(part.value, "widget"));
        }
      }
      return references;
    }
  }
}

function dedupe(references: readonly MarkReference[]): readonly MarkReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}\u0000${reference.entity ?? ""}\u0000${reference.name}\u0000${reference.via}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * B3' の印：表の `id` ごとに、宣言の該当箇所と参照先を引き当てる（§1.1）。宣言に（種類・entity の名前・名前）の
 * 場所が無い `id` は写像に入れない（印なし。`extraElementsOf` と同じ鍵）。並びは表の行の順。
 */
export function markRows(app: NormalizedAppSpec, table: NameTable): ReadonlyMap<string, DeclarationMark> {
  const elements = declarationElementsOf(app);
  const byKey = new Map<string, DeclarationElement>();
  for (const element of elements) if (!byKey.has(locationKey(element))) byKey.set(locationKey(element), element);
  const resolver = new Resolver(app);
  const marks = new Map<string, DeclarationMark>();
  for (const row of table.rows) {
    const location = locationOfRow(table, row);
    if (location === undefined) continue;
    const element = byKey.get(locationKey(location));
    if (element === undefined) continue;
    marks.set(row.id, { id: row.id, element, references: dedupe(referencesOf(app, resolver, element)) });
  }
  return marks;
}

