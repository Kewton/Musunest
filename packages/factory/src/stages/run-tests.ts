// ⑤b 試験を流す（02-architecture.md §1・§1.3・F-9・R-8・Issue #308）。
//
// 固定した試験を、**③ が提出した対応**（結び付けの規則、bind.ts）で宣言の実在の要素に結び付けてから、
// **評価の方法の表**（§1.3。対象の種類 × 操作）に従って流す。**合否はコードが決める**（LLM の自己申告
// ではない）：
//
//   計算 × compute・aggregate … `evaluateRecord`・`evaluateScope`・`groupValuesOf`・`settleEntity`
//   項目・entity × validate   … `evaluateRecord` の `validations`（検査の式）
//   操作 × action（when）     … `allowsAction`
//   画面 × screen            … 構造の確認（view が実在し、show の名前と highlight が実在する）
//   項目 × screen            … 構造の確認（項目が実在し、その entity の一覧か表から辿れる。Issue #324）
//   entity × 在ることだけ     … 構造の確認（create の操作がある・一覧か表に出る）
//   操作 structure           … **構造の検査**（field-type・action-kind・action-unconditioned・view-shows・
//                               aggregate-no-period・write-anonymous）。結び付けた場所と、提出された対応で
//                               写した参照の役割で判定する（Issue #387・#393）。成り立てば合格、成り立たなければ
//                               不一致、役割が結び付かない・宣言に対象が無いときは未解決。1 件ごとに結果を記録する
//
// **操作の実行（`set` を当てたあとの状態）と、項目の既定値は未対応**にして、未解決として数える
// （§1.3・U-G）。未解決は合格にしない（⑦ が部分案へ倒す）。
//
// 結び付けられない試験は、**行き先を分けて**結果に出す（§1.3.1・Issue #308）：
//   対応の表の不備（対応表の外・当たる場所が無い）… ③ のやり直し（不一致）
//   要件に要る要素の欠落（結び付けた場所が実在しない・値が合わない）… ⑥ 直す（不一致）
//   意味の曖昧さ（1 つに決まらない・提出された対応が無い）… 未解決
//
// 参照の entity も、**提出された対応**で結び付ける（対応表の先頭の entity を採る経路をなくす。R2-6）。
//
// 入力と参照データの**値の鍵**（項目の役割 ID）は、提出された対応で宣言の項目の名前へ写してから評価器へ
// 渡す（Issue #320）。写せない鍵は、その試験を未解決にする（黙って落とさない）。参照（`ref`・`list of`）の
// 値の行 ID はそのまま渡す。
import {
  actionKind,
  fieldKind,
  fieldTarget,
  isAppComputed,
  isComputedAggregate,
  isComputedExpression,
  isComputedSettle,
  isGroupComputed,
  type ActionKind,
  type Computed,
  type ComputedSettle,
  type FieldKind,
  type NormalizedAppSpec,
  type View,
} from "@musunest/appspec-schema";
import {
  allowsAction,
  evaluateRecord,
  evaluateScope,
  fixedClock,
  groupValuesOf,
  holdsExpression,
  settleEntity,
  type Clock,
  type SourceRecord,
  type SourceRecords,
} from "@musunest/spec-engine";
import type {
  CorrespondenceResult,
  DeclarationLocation,
  FixedTest,
  ReferenceRow,
  RequirementNature,
  RoleEntry,
  RoleNameMapping,
  StructuralAssertion,
  StructuralCheckOutcome,
  TestExpected,
  TestMismatch,
  TestRunResult,
  TestSuite,
  TestTarget,
  TestUnresolved,
} from "../pipeline.js";
import { bindTests, locationKindFor, type BindResult } from "./bind.js";
import {
  checkLocation,
  declarationHasLocation,
  declarationHasNamedLocation,
  fieldReachableFromScreen,
  findComputed,
  findEntity,
} from "./correspondence.js";
import { rowIdValueKeyReason } from "./test-suite.js";

/** ⑤b 試験を流す、が受け取るもの */
export interface RunTestsInput {
  readonly app: NormalizedAppSpec;
  readonly suite: TestSuite;
  readonly correspondence: CorrespondenceResult;
  /** ③ が提出した「役割 ID → 宣言の名前」の対応（§1・Issue #308）。旧形式の経路では省ける */
  readonly mappings?: readonly RoleNameMapping[];
  /**
   * ② の役割 ID の表（§1・Issue #431）。結び付けられなかった試験の落ちに、**所属 entity を引いて**
   * 場所（種類・entity・名前）を組むのに使う——別 entity の同名を実在と誤認しないため。省ける。
   */
  readonly roles?: readonly RoleEntry[];
}

/** 失敗の行き先（§1.3.1・Issue #308・#322） */
export const FAILURE_ROUTES = [
  "correspondence-redo",
  "correspondence-defect",
  "missing-element",
  "ambiguity",
] as const;
export type FailureRoute = (typeof FAILURE_ROUTES)[number];

/** 行き先を分けた 1 件の失敗 */
export interface RoutedFailure {
  readonly testId: string;
  readonly route: FailureRoute;
  readonly detail: string;
  /** 対応表の外（⑤a のやり直し）のとき、落ちた場所（Issue #322） */
  readonly requirementId?: string;
  readonly location?: DeclarationLocation;
}

/**
 * ⑤b の結果（`TestRunResult` に、失敗の行き先を足したもの）。`routes` は不一致・未解決になった
 * 試験の行き先である（⑦ の先の段が、③ のやり直し・⑥ 直す・未解決へ振り分ける。§1.3.1）。
 * `structural` は**構造の検査の 1 件ごとの記録**で、結果（合格・不一致・未解決）を必ず持つ（Issue #387）。
 */
export interface TestRunReport extends TestRunResult {
  readonly routes: readonly RoutedFailure[];
  readonly structural: readonly StructuralCheckOutcome[];
}

/** 1 件の試験の判定 */
type Verdict =
  | { readonly kind: "match" }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "unresolved"; readonly detail: string };

/** 判定と、失敗のときの行き先 */
interface Judged {
  readonly verdict: Verdict;
  readonly route: FailureRoute | null;
  /** 対応表の外（⑤a のやり直し）のとき、落ちた場所（Issue #322） */
  readonly requirementId?: string;
  readonly location?: DeclarationLocation;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 入力（レコード）として読む。写像でなければ `null` */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  isObject(value) ? value : null;

/** 値の深い一致（評価器が返す値と期待を比べる）。キーの並びに依らない */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/** 期待と値を比べる。期待が誤り（error）のときは、値が `null`（求められなかった）であることを求める */
function compareValue(actual: unknown, expected: TestExpected, label: string): Verdict {
  if (expected.kind === "error") {
    return actual === null
      ? { kind: "match" }
      : { kind: "mismatch", detail: `${label} が値を返した（期待は求められないこと）` };
  }
  return deepEqual(actual, expected.value)
    ? { kind: "match" }
    : { kind: "mismatch", detail: `${label} が期待と違う（期待 ${show(expected.value)}、実際 ${show(actual)}）` };
}

/** 期待と真偽を比べる（操作の条件・印）。期待が誤り（error）のときは、成り立たないことを求める */
function compareBoolean(actual: boolean, expected: TestExpected, label: string): Verdict {
  if (expected.kind === "error") {
    return actual === false
      ? { kind: "match" }
      : { kind: "mismatch", detail: `${label} が成り立った（期待は成り立たないこと）` };
  }
  if (typeof expected.value !== "boolean") {
    return { kind: "mismatch", detail: `${label} の期待は真偽（true / false）であること` };
  }
  return actual === expected.value
    ? { kind: "match" }
    : { kind: "mismatch", detail: `${label} が期待と違う（期待 ${String(expected.value)}、実際 ${String(actual)}）` };
}

/** 人向けの短い値の表示（誤りメッセージ用） */
function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

/**
 * 参照データの対象（selector）を、実在の entity の名前に結び付ける（§1.3・R2-6・Issue #308）。
 * **③ が提出した対応があればそれを使い**、対応表の先頭の entity は採らない。対応が無ければ
 * （旧形式）、対応表が挙げた entity の場所を使う。
 */
export function resolveReferenceEntity(target: TestTarget, input: RunTestsInput): string | null {
  if (input.mappings !== undefined && target.roleId !== undefined) {
    const mapping = input.mappings.find((candidate) => candidate.roleId === target.roleId);
    if (mapping === undefined) return null;
    return findEntity(input.app, mapping.name) === undefined ? null : mapping.name;
  }
  const entry = input.correspondence.entries.find(
    (candidate) => candidate.requirementId === target.requirementId,
  );
  if (entry === undefined) return null;
  const entity = entry.locations.find((location) => location.kind === "entity");
  if (entity === undefined) return null;
  return findEntity(input.app, entity.name) === undefined ? null : entity.name;
}

/** 値の鍵の写しの結果（写せなければ理由つきで断る） */
type ValueKeyMapping =
  | { readonly ok: true; readonly values: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

/**
 * 値の鍵（項目の役割 ID）を、**提出された対応**（役割 ID → 宣言の名前）で宣言の項目の名前へ写す
 * （§1.3・Issue #320）。写せない鍵は理由を返し、その試験を未解決にする（黙って落とさない）。
 *
 *   - 対応にある鍵 … その名前へ写す。名前が対象の entity の項目でなければ「別の entity の項目の役割 ID」
 *     として断る
 *   - 対応に無い鍵 … 既に宣言の項目の名前なら、そのまま使う（旧形式の記録の互換）。そうでなければ
 *     「対応に無い役割 ID」として断る
 *
 * 提出された対応が渡されていなければ（旧形式の経路）、値をそのまま渡す。
 */
function mapValueKeys(
  values: Readonly<Record<string, unknown>>,
  entity: string | null,
  app: NormalizedAppSpec,
  mappings: readonly RoleNameMapping[] | undefined,
): ValueKeyMapping {
  if (mappings === undefined) return { ok: true, values };
  const nameByRoleId = new Map(mappings.map((mapping) => [mapping.roleId, mapping.name]));
  const host = entity === null ? undefined : findEntity(app, entity);
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const name = nameByRoleId.get(key);
    if (name !== undefined) {
      if (host !== undefined && !Object.hasOwn(host.fields, name)) {
        return {
          ok: false,
          reason: `値の鍵 ${key} の対応（${name}）は entity ${entity ?? ""} の項目でない（別の entity の項目の役割 ID）`,
        };
      }
      mapped[name] = value;
      continue;
    }
    if (host !== undefined && Object.hasOwn(host.fields, key)) {
      mapped[key] = value;
      continue;
    }
    // 従来から断っている鍵のうち、行の ID（`id`・`rowId`）だけは、②' と同じ文言にする（Issue #409）
    if (key === "id" || key === "rowId") {
      return { ok: false, reason: rowIdValueKeyReason(key) };
    }
    return { ok: false, reason: `値の鍵 ${key} に提出された対応が無い（対応に無い役割 ID）` };
  }
  return { ok: true, values: mapped };
}

/** 参照データを組むときに見つかった問題（不一致か、写せない鍵で未解決か） */
interface SourceProblem {
  readonly kind: "mismatch" | "unresolved";
  readonly detail: string;
}

/**
 * 「空であることを明示した entity」（役割 ID の並び）を、宣言の entity の名前に結び付ける
 * （§1・②'・Issue #322）。結び付かない役割 ID があれば理由を返し、その試験を未解決にする。
 * 提出された対応が渡されていなければ（旧形式の経路）、役割 ID をそのまま entity の名前として見る。
 */
function resolveEmptyEntities(
  roleIds: readonly string[],
  input: RunTestsInput,
): { readonly ok: true; readonly names: readonly string[] } | { readonly ok: false; readonly reason: string } {
  const names: string[] = [];
  for (const roleId of roleIds) {
    if (input.mappings === undefined) {
      if (findEntity(input.app, roleId) !== undefined) {
        names.push(roleId);
        continue;
      }
      return { ok: false, reason: `空の集合の entity の役割 ID ${roleId} が宣言の entity に結び付かない` };
    }
    const mapping = input.mappings.find((candidate) => candidate.roleId === roleId);
    if (mapping === undefined) {
      return { ok: false, reason: `空の集合の entity の役割 ID ${roleId} に提出された対応が無い` };
    }
    if (findEntity(input.app, mapping.name) === undefined) {
      return { ok: false, reason: `空の集合の entity の対応（${mapping.name}）が宣言に無い` };
    }
    names.push(mapping.name);
  }
  return { ok: true, names };
}

/**
 * 参照データを、評価器が読む `sources`（entity の名前 → レコードの並び）にする。
 * 対象が実在の entity に結び付かない行があればその旨を、値の鍵が写せなければその旨を `problem` に返す
 * （黙って落とさない）。**参照（`ref`・`list of`）の値の行 ID はそのまま渡す。**
 *
 * `emptyEntityRoleIds`（入力の契約の「空であることを明示した entity」）は、**空の集合として**渡す
 * ——「行が 0 件」と「評価できない」を区別する（§1・②'・Issue #322）。参照データに行があれば
 * そちらを採り、無いときだけ空の並びを置く。
 */
function buildSources(
  referenceData: readonly ReferenceRow[],
  input: RunTestsInput,
  emptyEntityRoleIds: readonly string[],
): { readonly sources: SourceRecords; readonly problem: SourceProblem | null } {
  const sources: Record<string, SourceRecord[]> = {};
  const counts = new Map<string, number>();
  for (const row of referenceData) {
    const entity = resolveReferenceEntity(row.target, input);
    if (entity === null) {
      return {
        sources,
        problem: {
          kind: "mismatch",
          detail: `参照データの対象（要件 ${row.target.requirementId}・役割 ${row.target.roleId ?? row.target.role ?? ""}）が実在の entity に結び付かない`,
        },
      };
    }
    const mapped = mapValueKeys(row.values, entity, input.app, input.mappings);
    if (!mapped.ok) {
      return { sources, problem: { kind: "unresolved", detail: mapped.reason } };
    }
    const count = (counts.get(entity) ?? 0) + 1;
    counts.set(entity, count);
    const records = sources[entity] ?? [];
    records.push({ id: row.rowId ?? `${entity}-${count}`, data: mapped.values });
    sources[entity] = records;
  }
  const empty = resolveEmptyEntities(emptyEntityRoleIds, input);
  if (!empty.ok) return { sources, problem: { kind: "unresolved", detail: empty.reason } };
  for (const name of empty.names) {
    if (sources[name] === undefined) sources[name] = [];
  }
  return { sources, problem: null };
}

/** 試験の入力の契約の「空の集合」を取り出す（無ければ空。§1・②'・Issue #322） */
function emptyEntitiesOf(test: FixedTest): readonly string[] {
  return test.inputContract?.emptyEntities ?? [];
}

/** 操作の条件（`when`）を評価する。`set` を当てたあとの状態（実行）は確かめられないので未解決にする */
function judgeAction(test: FixedTest, location: DeclarationLocation, input: RunTestsInput): Verdict {
  if (test.target.kind !== "operation") {
    return { kind: "unresolved", detail: "操作の実行（set を当てたあとの状態）は評価器で確かめられない" };
  }
  const action = input.app.spec.actions.find(
    (candidate) =>
      candidate.name === location.name &&
      (location.entity === null || candidate.entity === location.entity),
  );
  if (action === undefined) return { kind: "mismatch", detail: `宣言に操作 ${location.name} が無い` };
  if (action.when === undefined) {
    return {
      kind: "unresolved",
      detail: `操作 ${action.name} に条件（when）が無く、実行は評価器で確かめられない`,
    };
  }
  const rawRecord = asRecord(test.input);
  if (rawRecord === null) return { kind: "unresolved", detail: "入力が写像（object）でない" };
  const mapped = mapValueKeys(rawRecord, action.entity, input.app, input.mappings);
  if (!mapped.ok) return { kind: "unresolved", detail: mapped.reason };
  const { sources, problem } = buildSources(test.referenceData, input, emptyEntitiesOf(test));
  if (problem !== null) return { kind: problem.kind, detail: problem.detail };
  const clock = fixedClock(test.clock);
  const recordId = test.inputContract?.targetRowId ?? test.inputContract?.rowId;
  const allowed = allowsAction(
    {
      app: input.app,
      entity: action.entity,
      record: mapped.values,
      clock,
      sources,
      ...(recordId === undefined ? {} : { recordId }),
    },
    action.when,
  );
  return compareBoolean(allowed, test.expected, `操作 ${action.name} の条件`);
}

/** 検査（`validate`）を評価する。結び付けた検査が落ちたかどうかを期待と比べる */
function judgeValidation(test: FixedTest, location: DeclarationLocation, input: RunTestsInput): Verdict {
  const validation = input.app.spec.validations.find(
    (candidate) =>
      candidate.name === location.name &&
      (location.entity === null || candidate.entity === location.entity),
  );
  if (validation === undefined) return { kind: "mismatch", detail: `宣言に検査 ${location.name} が無い` };
  const rawRecord = asRecord(test.input);
  if (rawRecord === null) return { kind: "unresolved", detail: "入力が写像（object）でない" };
  const mapped = mapValueKeys(rawRecord, validation.entity, input.app, input.mappings);
  if (!mapped.ok) return { kind: "unresolved", detail: mapped.reason };
  const { sources, problem } = buildSources(test.referenceData, input, emptyEntitiesOf(test));
  if (problem !== null) return { kind: problem.kind, detail: problem.detail };
  const clock = fixedClock(test.clock);
  const recordId = test.inputContract?.targetRowId ?? test.inputContract?.rowId;
  const evaluation = evaluateRecord({
    app: input.app,
    entity: validation.entity,
    record: mapped.values,
    clock,
    sources,
    ...(recordId === undefined ? {} : { recordId }),
  });
  const failed = evaluation.validations.includes(validation.name);
  if (test.expected.kind === "ok") {
    return failed
      ? { kind: "mismatch", detail: `検査 ${validation.name} が落ちた（期待は通ること）` }
      : { kind: "match" };
  }
  return failed
    ? { kind: "match" }
    : { kind: "mismatch", detail: `検査 ${validation.name} が落ちなかった（期待は落ちること）` };
}

/** 精算（`settle`）を評価する。送金の並びを期待と比べる */
function judgeSettle(
  test: FixedTest,
  computed: ComputedSettle,
  input: RunTestsInput,
  clock: Clock,
  sources: SourceRecords,
): Verdict {
  const entity = computed.entity;
  const result = settleEntity({ app: input.app, entity, records: sources[entity] ?? [], sources });
  if (result.ok) {
    return compareValue(result.transfers, test.expected, `精算 ${computed.name}`);
  }
  if (test.expected.kind === "error" && test.expected.code === result.failure) {
    return { kind: "match" };
  }
  return { kind: "mismatch", detail: `精算 ${computed.name} が失敗した（${result.failure}）` };
}

/** 計算（式・集計・精算・見出しごとの集計・アプリ全体・印）を評価する */
function judgeValue(test: FixedTest, location: DeclarationLocation, input: RunTestsInput): Verdict {
  const computed: Computed | undefined = findComputed(input.app, location);
  if (computed === undefined) return { kind: "mismatch", detail: `宣言に計算 ${location.name} が無い` };
  const clock = fixedClock(test.clock);
  const { sources, problem } = buildSources(test.referenceData, input, emptyEntitiesOf(test));
  if (problem !== null) return { kind: problem.kind, detail: problem.detail };

  if (isComputedSettle(computed)) return judgeSettle(test, computed, input, clock, sources);
  if (isGroupComputed(computed)) {
    const actual = groupValuesOf(input.app, computed.aggregate, sources, clock);
    return compareValue(actual, test.expected, `見出しごとの集計 ${computed.name}`);
  }
  if (isAppComputed(computed)) {
    const values = evaluateScope({ app: input.app, clock, sources });
    return compareValue(values[computed.name] ?? null, test.expected, `アプリ全体の集計 ${computed.name}`);
  }

  const entity = "entity" in computed ? computed.entity : null;
  if (entity === null) return { kind: "mismatch", detail: `計算 ${location.name} の entity が決まらない` };
  const rawRecord = asRecord(test.input);
  if (rawRecord === null) return { kind: "unresolved", detail: "入力が写像（object）でない" };
  const mapped = mapValueKeys(rawRecord, entity, input.app, input.mappings);
  if (!mapped.ok) return { kind: "unresolved", detail: mapped.reason };
  const recordId = test.inputContract?.targetRowId ?? test.inputContract?.rowId;
  if (isComputedExpression(computed) && computed.type === "boolean") {
    const holds = holdsExpression(
      {
        app: input.app,
        entity,
        record: mapped.values,
        clock,
        sources,
        ...(recordId === undefined ? {} : { recordId }),
      },
      computed.expression,
    );
    return compareBoolean(holds, test.expected, `印 ${computed.name}`);
  }
  const evaluation = evaluateRecord({
    app: input.app,
    entity,
    record: mapped.values,
    clock,
    sources,
    ...(recordId === undefined ? {} : { recordId }),
  });
  if (!Object.hasOwn(evaluation.computed, computed.name)) {
    return { kind: "mismatch", detail: `計算 ${computed.name} が評価結果に無い` };
  }
  return compareValue(evaluation.computed[computed.name] ?? null, test.expected, `計算 ${computed.name}`);
}

/**
 * 画面（view）を**構造の確認**で判定する（§1.3 の表・Issue #308）。view が実在し、`show` の名前と
 * `highlight` が実在することを見る。値は評価しない（画面は計算しない）。
 */
function judgeViewStructural(app: NormalizedAppSpec, location: DeclarationLocation): Verdict {
  const view = app.spec.views.find((candidate) => candidate.name === location.name);
  if (view === undefined) return { kind: "mismatch", detail: `宣言に一覧 ${location.name} が無い` };
  if (view.entity !== undefined) {
    const entity = findEntity(app, view.entity);
    if (entity === undefined) {
      return { kind: "mismatch", detail: `一覧 ${view.name} の entity ${view.entity} が無い` };
    }
    for (const name of view.show ?? []) {
      const isField = Object.hasOwn(entity.fields, name);
      const isComputed = app.spec.computed.some(
        (computed) => computed.name === name && "entity" in computed && computed.entity === view.entity,
      );
      if (!isField && !isComputed) {
        return { kind: "mismatch", detail: `一覧 ${view.name} の show の ${name} が entity ${view.entity} に無い` };
      }
    }
    if (view.type === "board" && view.highlight !== undefined) {
      const isComputed = app.spec.computed.some(
        (computed) => computed.name === view.highlight && "entity" in computed && computed.entity === view.entity,
      );
      if (!isComputed) {
        return { kind: "mismatch", detail: `ボード ${view.name} の highlight ${view.highlight} が計算に無い` };
      }
    }
  }
  return { kind: "match" };
}

/**
 * 「在ることだけ」の要件を**構造の確認**で判定する（§1.3 の表・Issue #308・#320）。
 * 対象の場所が載っている entity に create の操作があるか、一覧か表に出ていることを見る。操作（create）を
 * 対象にした試験も同じ——**評価器で操作を実行しようとしない**。
 */
function judgeExistenceStructural(app: NormalizedAppSpec, location: DeclarationLocation): Verdict {
  const entity = location.kind === "entity" ? location.name : location.entity;
  if (entity === null) {
    return { kind: "mismatch", detail: `場所 ${location.name} の entity が決まらない` };
  }
  const hasCreate = app.spec.actions.some(
    (action) => (action.kind ?? "create") === "create" && action.entity === entity,
  );
  const shown = app.spec.views.some(
    (view) =>
      view.entity === entity && (view.type === undefined || view.type === "table" || view.type === "list"),
  );
  if (hasCreate || shown) return { kind: "match" };
  return { kind: "mismatch", detail: `entity ${entity} に create の操作も、一覧か表の表示も無い` };
}

/** 結び付けた場所の操作が create か（在ることだけの要件の構造の確認に使う。§1.3・Issue #320） */
function isCreateOperation(app: NormalizedAppSpec, location: DeclarationLocation): boolean {
  const action = app.spec.actions.find(
    (candidate) =>
      candidate.name === location.name &&
      (location.entity === null || candidate.entity === location.entity),
  );
  return action !== undefined && (action.kind ?? "create") === "create";
}

/**
 * 「項目 × 画面」の試験を**構造の確認**で判定する（§1.3 の表・Issue #324）。その項目が、その entity の
 * 一覧か表（`show` に入っている・`show` の省略で全部が出る）から辿れることを見る。値は評価しない
 * （画面は計算しない）。実在は `checkLocation` が先に確かめる。辿れなければ**理由つきの不一致**にする
 * （未解決にしない）。
 */
function judgeFieldScreen(app: NormalizedAppSpec, location: DeclarationLocation): Verdict {
  if (fieldReachableFromScreen(app, location)) return { kind: "match" };
  return {
    kind: "mismatch",
    detail: `項目 ${location.name} は画面から辿れない（entity ${location.entity ?? ""} の一覧か表に出ていない）`,
  };
}

/**
 * 役割 ID を、**③ が提出した対応（役割 ID → 宣言の名前）**で宣言の名前へ写す（§1.3・Issue #387）。
 * 対応が無ければ `undefined` を返し、呼ぶ側がその検査を未解決にする（名前を推測しない）。提出された
 * 対応が渡されていなければ（旧形式の経路）、役割 ID をそのまま名前として見る。
 */
function mappedNameOf(roleId: string, input: RunTestsInput): string | undefined {
  if (input.mappings === undefined) return roleId;
  return input.mappings.find((mapping) => mapping.roleId === roleId)?.name;
}

/** 結び付けた場所の名前で操作を引く（構造の検査で使う。Issue #387） */
function findActionAt(app: NormalizedAppSpec, location: DeclarationLocation) {
  return app.spec.actions.find(
    (candidate) =>
      candidate.name === location.name &&
      (location.entity === null || candidate.entity === location.entity),
  );
}

/**
 * 構造の検査 `field-type`：項目の種類（`FieldKind`）と、参照（`ref`・参照の並び）の参照先が期待どおりか
 * （§1.3・Issue #387）。**文字列の並びと参照の並びを区別する**——参照先を書かなければ文字列の並び、
 * 書けば参照の並びである。役割が結び付かない・宣言に項目が無いときは未解決にする。
 */
function judgeFieldType(
  location: DeclarationLocation,
  assertion: StructuralAssertion,
  input: RunTestsInput,
): Verdict {
  const entity = findEntity(input.app, location.entity);
  if (entity === undefined) {
    return { kind: "unresolved", detail: `宣言に entity ${location.entity ?? ""} が無い` };
  }
  const field = entity.fields[location.name];
  if (field === undefined) {
    return { kind: "unresolved", detail: `entity ${entity.name} に項目 ${location.name} が無い` };
  }
  const actual = fieldKind(field);
  const expected = assertion.expected as FieldKind;
  if (actual !== expected) {
    return { kind: "mismatch", detail: `項目 ${location.name} の種類が ${actual}（期待 ${expected}）` };
  }
  if (assertion.refEntity !== undefined) {
    const want = mappedNameOf(assertion.refEntity, input);
    if (want === undefined) {
      return { kind: "unresolved", detail: `参照先の役割 ID ${assertion.refEntity} に提出された対応が無い` };
    }
    const target = fieldTarget(field);
    if (target !== want) {
      return {
        kind: "mismatch",
        detail: `項目 ${location.name} の参照先が ${target ?? "無し"}（期待 ${want}）`,
      };
    }
    return { kind: "match" };
  }
  // 参照先を書かないのは「文字列の並び」のときだけである（参照の並びは `of` を持つ）
  if (expected === "list" && fieldTarget(field) !== null) {
    return { kind: "mismatch", detail: `項目 ${location.name} は参照の並び（期待は文字列の並び）` };
  }
  return { kind: "match" };
}

/** 構造の検査 `action-kind`：操作の種類（省略は `create`）が期待どおりか（§1.3・Issue #387） */
function judgeActionKind(
  location: DeclarationLocation,
  assertion: StructuralAssertion,
  input: RunTestsInput,
): Verdict {
  const action = findActionAt(input.app, location);
  if (action === undefined) return { kind: "unresolved", detail: `宣言に操作 ${location.name} が無い` };
  const actual = actionKind(action);
  const expected = assertion.expected as ActionKind;
  if (actual !== expected) {
    return { kind: "mismatch", detail: `操作 ${action.name} の種類が ${actual}（期待 ${expected}）` };
  }
  return { kind: "match" };
}

/** 構造の検査 `action-unconditioned`：操作が条件（`when`）を持たないか（§1.3・Issue #387） */
function judgeActionUnconditioned(location: DeclarationLocation, input: RunTestsInput): Verdict {
  const action = findActionAt(input.app, location);
  if (action === undefined) return { kind: "unresolved", detail: `宣言に操作 ${location.name} が無い` };
  if (action.when !== undefined) {
    return { kind: "mismatch", detail: `操作 ${action.name} は条件（when）を持つ` };
  }
  return { kind: "match" };
}

/**
 * 構造の検査 `write-anonymous` が成り立つか（§1.3・Issue #393）。アプリ全体の権限（`permissions`）に
 * `name: write`・`subject: minIdentity` の行があり、本人確認（`minIdentity.mode`）が `anonymous` であること
 * を見る。**本人確認と書き込みの権限で制限されていないことだけ**を確かめる——読むこと（`read`）は別の要件で
 * 確かめ、入力の検査・参照・保存の成功は確かめない。宣言に無い値（不正な `mode`・`subject`）は成り立たない
 * 側に倒す（宣言は静的チェックが止めるが、ここでも防御する）。
 */
export function holdsWriteAnonymous(app: NormalizedAppSpec): boolean {
  const hasWrite = app.spec.permissions.some(
    (permission) => permission.name === "write" && permission.subject === "minIdentity",
  );
  return hasWrite && app.spec.minIdentity.mode === "anonymous";
}

/**
 * 構造の検査 `write-anonymous`：対象の操作が宣言に実在し、誰でも書き込めるか（§1.3・Issue #393）。
 * 操作が無ければ未解決、権限（`write`）または本人確認（`anonymous`）で制限されていれば不一致。
 */
function judgeWriteAnonymous(location: DeclarationLocation, input: RunTestsInput): Verdict {
  const action = findActionAt(input.app, location);
  if (action === undefined) return { kind: "unresolved", detail: `宣言に操作 ${location.name} が無い` };
  if (holdsWriteAnonymous(input.app)) return { kind: "match" };
  return {
    kind: "mismatch",
    detail: `操作 ${action.name} は、書き込みの権限（write）か本人確認（anonymous）で制限されている`,
  };
}

/** 名前が、宣言のどこかの項目か計算として実在するか（構造の検査の参照の実在確認。Issue #387） */
function declarationHasFieldOrComputed(app: NormalizedAppSpec, name: string): boolean {
  if (app.spec.entities.some((entity) => Object.hasOwn(entity.fields, name))) return true;
  return app.spec.computed.some((computed) => computed.name === name);
}

/**
 * 一覧が、その名前（項目か計算）を表示するか（§1.3・Issue #387）。**`show` を省いた部品は、語彙の
 * 決まり（省略は、項目に続いて計算を全部並べる）どおりに扱う**。種類ごとに表示の仕方が決まる。
 */
function viewShows(app: NormalizedAppSpec, view: View, name: string): boolean {
  if (view.show !== undefined) return view.show.includes(name);
  if (view.type === "dashboard") {
    return (view.widgets ?? []).some(
      (part) =>
        ("value" in part && part.value === name) ||
        (part.type === "ranking" && (part.by === name || part.show.includes(name))),
    );
  }
  if (view.type === "board") return view.highlight === name || view.columns === name;
  if (view.type === "settlement") return false;
  // 種類なし・table・list：`show` を省くと、項目（宣言の順）に続いて計算（宣言の順）を全部出す
  const entity = findEntity(app, view.entity ?? null);
  if (entity !== undefined && Object.hasOwn(entity.fields, name)) return true;
  return app.spec.computed.some(
    (computed) => computed.name === name && "entity" in computed && computed.entity === view.entity,
  );
}

/**
 * 構造の検査 `view-shows`：**対象の画面の部品**が、期待した項目または計算を表示するか（§1.3・Issue #387）。
 * 別の画面だけに表示していても合格にしない（対象の画面だけを見る）。役割が結び付かない・宣言に無いときは
 * 未解決にする。
 */
function judgeViewShows(
  location: DeclarationLocation,
  assertion: StructuralAssertion,
  input: RunTestsInput,
): Verdict {
  const role = assertion.role;
  if (role === undefined) {
    return { kind: "unresolved", detail: "view-shows の表示を期待する役割 ID（role）が無い" };
  }
  const name = mappedNameOf(role, input);
  if (name === undefined) {
    return { kind: "unresolved", detail: `表示を期待する役割 ID ${role} に提出された対応が無い` };
  }
  const view = input.app.spec.views.find((candidate) => candidate.name === location.name);
  if (view === undefined) return { kind: "unresolved", detail: `宣言に一覧 ${location.name} が無い` };
  if (!declarationHasFieldOrComputed(input.app, name)) {
    return { kind: "unresolved", detail: `宣言に ${name} という項目も計算も無い` };
  }
  if (viewShows(input.app, view, name)) return { kind: "match" };
  return { kind: "mismatch", detail: `一覧 ${view.name} は ${name} を表示しない` };
}

/**
 * 構造の検査 `aggregate-no-period`：集計の絞り込みに期間の条件（`within`）が無いか（§1.3・Issue #387）。
 * 行を結び付ける絞り込み（`equals`・`contains` など）はあってよい。集計でなければ不一致にする。
 */
function judgeAggregateNoPeriod(location: DeclarationLocation, input: RunTestsInput): Verdict {
  const computed = findComputed(input.app, location);
  if (computed === undefined) return { kind: "unresolved", detail: `宣言に計算 ${location.name} が無い` };
  if (!isComputedAggregate(computed)) {
    return { kind: "mismatch", detail: `計算 ${computed.name} は集計ではない` };
  }
  const hasPeriod = Object.values(computed.aggregate.where).some((condition) => condition.op === "within");
  if (hasPeriod) {
    return { kind: "mismatch", detail: `集計 ${computed.name} の絞り込みに期間の条件（within）がある` };
  }
  return { kind: "match" };
}

/**
 * 構造の検査を、結び付けた場所と検査の中身で判定する（§1.3・Issue #387）。検査の中身ごとに、対象と
 * 参照する役割は、**提出された対応（役割 ID → 宣言の名前）だけ**で結び付ける（名前を推測しない）。
 */
function judgeStructure(test: FixedTest, location: DeclarationLocation, input: RunTestsInput): Verdict {
  const assertion = test.assertion;
  if (assertion === undefined) {
    return { kind: "unresolved", detail: "構造の検査の中身（assertion）が無い" };
  }
  switch (assertion.check) {
    case "field-type":
      return judgeFieldType(location, assertion, input);
    case "action-kind":
      return judgeActionKind(location, assertion, input);
    case "action-unconditioned":
      return judgeActionUnconditioned(location, input);
    case "view-shows":
      return judgeViewShows(location, assertion, input);
    case "aggregate-no-period":
      return judgeAggregateNoPeriod(location, input);
    case "write-anonymous":
      return judgeWriteAnonymous(location, input);
  }
}

/** 評価の方法（§1.3 の表・Issue #308・#324・#387）。未対応は `unresolved` に数える */
type Method =
  | "value"
  | "validation"
  | "action"
  | "view"
  | "field-screen"
  | "existence"
  | "structure"
  | "unresolved";

/**
 * 対象の種類 × 操作で、評価の方法を決める（§1.3 の表）。
 *
 *   - 計算（`computation`）… 値の評価（`compute`・`aggregate`。画面の印も値の評価）
 *   - 項目・entity × `validate` … 検査の式（値の評価）
 *   - 操作 × `action`（`when`）… 値の評価
 *   - 画面 … 構造の確認
 *   - 項目 × `screen` … 構造の確認（項目が実在し、その entity の一覧か表から辿れる。Issue #324）
 *   - entity（在ることだけ・画面）… 構造の確認
 *   - 在ることだけの要件の create の操作 … 構造の確認（実行は評価器で確かめられない。Issue #320）
 *   - それ以外（操作の実行・項目の既定値など）… 未対応（未解決）
 */
function evaluationMethod(
  test: FixedTest,
  nature: RequirementNature,
  location: DeclarationLocation,
  app: NormalizedAppSpec,
): Method {
  // 構造の検査を、宣言に対して実行する（§1.3・Issue #387）
  if (test.operation === "structure") return "structure";
  if (test.operation === "validate") return "validation";
  if (test.operation === "action") {
    if (test.target.kind !== "operation") return "unresolved";
    // 決まりを含む要件の操作の条件（when）は allowsAction で確かめる。在ることだけの要件の create は構造で見る
    if (nature === "existence-only" && isCreateOperation(app, location)) return "existence";
    return "action";
  }
  if (test.target.kind === "computation") return "value";
  if (test.target.kind === "screen") return "view";
  // 項目を対象にした画面の試験は、構造の確認にする（在ることだけの要件で作られる。Issue #324）
  if (test.target.kind === "field") return test.operation === "screen" ? "field-screen" : "unresolved";
  if (test.target.kind === "entity") {
    return test.operation === "screen" || nature === "existence-only" ? "existence" : "unresolved";
  }
  return "unresolved";
}

/** 要件ごとの種類（②' の独立の分類）。無ければ `ruled` として扱う（旧形式） */
function natureMap(suite: TestSuite): ReadonlyMap<string, RequirementNature> {
  const map = new Map<string, RequirementNature>();
  for (const entry of suite.classifications ?? []) map.set(entry.requirementId, entry.nature);
  return map;
}

/** 評価の結果に、失敗の行き先を付ける（不一致は ⑥、未解決は曖昧さ） */
function routeOf(verdict: Verdict): FailureRoute | null {
  if (verdict.kind === "mismatch") return "missing-element";
  if (verdict.kind === "unresolved") return "ambiguity";
  return null;
}

/**
 * 結び付けられなかった試験の selector の役割 ID から、その**所属 entity の名前**を引く（Issue #431）。
 * ② の役割 ID の表（`roles`）から役割の所属 entity を引き、その entity の役割 ID を提出された対応で
 * 名前へ写す。表が渡されていなければ `null`（旧形式の経路）。**別 entity の同名を実在と誤認しない**ため、
 * 構造の検査の行き先（`correspondence-redo` か `correspondence-defect` か）の判定に使う。
 */
function mappedEntityOf(roleId: string, input: RunTestsInput): string | null | undefined {
  // 役割の表が無い（旧形式）ときは、所属 entity を引けないので null（entity を問わない場所を組む）
  if (input.roles === undefined || input.mappings === undefined) return null;
  const role = input.roles.find((candidate) => candidate.roleId === roleId);
  if (role === undefined || role.entity === null) return null;
  const entityMapping = input.mappings.find((candidate) => candidate.roleId === role.entity);
  // 所属 entity の対応が引けないときは **未確定**（`undefined`）。null と区別する（別 entity の同名を
  // 実在と誤認しないため。Issue #431）
  return entityMapping === undefined ? undefined : entityMapping.name;
}

/**
 * 結び付けられなかった試験の selector の対応（役割 ID → 名前）から、落ちた場所を組む（Issue #322・#431）。
 * ⑤a のやり直しへ渡し、対応表へ足させる。**所属の entity は、② の役割 ID の表があれば引いて null に
 * しない**——別 entity の同名を実在と見なさないためである。表が無ければ entity は null。
 */
function mappedLocationOf(test: FixedTest, input: RunTestsInput): DeclarationLocation | null {
  const roleId = test.target.roleId;
  if (roleId === undefined || input.mappings === undefined) return null;
  const mapping = input.mappings.find((candidate) => candidate.roleId === roleId);
  if (mapping === undefined) return null;
  const entity = mappedEntityOf(roleId, input);
  // 所属 entity の対応が引けない（未確定）ときは、場所を組まない（null の場所で実在と誤認しない。Issue #431）
  if (entity === undefined) return null;
  return { kind: locationKindFor(test), entity, name: mapping.name };
}

/** 1 件の試験を判定し、失敗の行き先も返す */
function judgeOne(
  test: FixedTest,
  binding: BindResult | undefined,
  input: RunTestsInput,
  natures: ReadonlyMap<string, RequirementNature>,
): Judged {
  // 構造の検査を、宣言に対して実行する（§1.3・Issue #387）。**役割が結び付かない・宣言に対象が無い
  // ときは未解決**にする（結び付けの行き先を分けず、合格（一致）にも不一致にもしない）。
  if (test.operation === "structure") {
    if (binding === undefined || binding.kind === "unbound") {
      const detail = binding?.detail ?? "構造の検査の対象の役割が結び付かない";
      // 対応表の外（`outside-table`）で、対応の場所が宣言に実在するなら、**判定は未解決のまま**⑤a の
      // やり直しへ回す（要件 ID と場所つき。Issue #431）。実在しない・種類違いは③ のやり直し
      // （`correspondence-defect`）。`no-mapping`・`ambiguous`・`no-table-entry`・`no-candidate` は、
      // 今までどおり曖昧さ（未解決）で、行き先を付けない。
      if (binding?.cause === "outside-table") {
        const location = mappedLocationOf(test, input);
        if (location !== null) {
          if (declarationHasLocation(input.app, location)) {
            return {
              verdict: { kind: "unresolved", detail },
              route: "correspondence-redo",
              requirementId: test.target.requirementId,
              location,
            };
          }
          return { verdict: { kind: "unresolved", detail }, route: "correspondence-defect" };
        }
      }
      return { verdict: { kind: "unresolved", detail }, route: "ambiguity" };
    }
    const verdict = judgeStructure(test, binding.location, input);
    return { verdict, route: routeOf(verdict) };
  }
  if (binding === undefined || binding.kind === "unbound") {
    // 提出された対応が無い・1 つに決まらない → 未解決（曖昧さ）
    if (binding?.cause === "no-mapping" || binding?.cause === "ambiguous") {
      return {
        verdict: { kind: "unresolved", detail: binding.detail },
        route: "ambiguity",
      };
    }
    // 対応の名前が宣言に実在するのに、⑤a の対応表の外にある → **⑤a のやり直し**（Issue #322）。
    // ③ の対応は正しく、足りないのは対応表の場所なので、③ をやり直しても直らない。
    // 名前が実在しない・種類違いなら ③ の対応そのものが誤りなので、③ のやり直し（対応の表の不備）。
    const location = binding?.cause === "outside-table" ? mappedLocationOf(test, input) : null;
    if (location !== null && declarationHasNamedLocation(input.app, location.kind, location.name)) {
      return {
        verdict: { kind: "mismatch", detail: binding?.detail ?? "結び付けられない" },
        route: "correspondence-redo",
        requirementId: test.target.requirementId,
        location,
      };
    }
    return {
      verdict: { kind: "mismatch", detail: binding?.detail ?? "結び付けられない" },
      route: "correspondence-defect",
    };
  }
  const location = binding.location;
  const checked = checkLocation(input.app, location);
  if (!checked.ok) return { verdict: { kind: "mismatch", detail: checked.reason }, route: "missing-element" };

  const nature = natures.get(test.target.requirementId) ?? "ruled";
  const method = evaluationMethod(test, nature, location, input.app);
  switch (method) {
    case "value": {
      const verdict = judgeValue(test, location, input);
      return { verdict, route: routeOf(verdict) };
    }
    case "validation": {
      const verdict = judgeValidation(test, location, input);
      return { verdict, route: routeOf(verdict) };
    }
    case "action": {
      const verdict = judgeAction(test, location, input);
      return { verdict, route: routeOf(verdict) };
    }
    case "view":
      return { verdict: judgeViewStructural(input.app, location), route: null };
    case "field-screen": {
      // 辿れなければ不一致 → ⑥ 直す（宣言に項目を出す）。未解決にはしない（Issue #324）
      const verdict = judgeFieldScreen(input.app, location);
      return { verdict, route: routeOf(verdict) };
    }
    case "existence":
      return { verdict: judgeExistenceStructural(input.app, location), route: null };
    case "structure": {
      const verdict = judgeStructure(test, location, input);
      return { verdict, route: routeOf(verdict) };
    }
    case "unresolved":
      return {
        verdict: {
          kind: "unresolved",
          detail: `評価の方法の表で未対応である（対象 ${test.target.kind} × 操作 ${test.operation}）`,
        },
        route: "ambiguity",
      };
  }
}

/**
 * 固定した試験の組を流し、不一致と未解決、失敗の行き先を返す（§1.3・F-9・Issue #308）。
 * 結び付けられなかった試験も、行き先つきで数える（R-8）。
 */
export function runTests(input: RunTestsInput): TestRunReport {
  const natures = natureMap(input.suite);
  const bindings = bindTests({
    suite: input.suite,
    correspondence: input.correspondence,
    ...(input.mappings === undefined ? {} : { mappings: input.mappings }),
  });
  const mismatches: TestMismatch[] = [];
  const unresolved: TestUnresolved[] = [];
  const routes: RoutedFailure[] = [];
  const structural: StructuralCheckOutcome[] = [];
  input.suite.tests.forEach((test, index) => {
    const judged = judgeOne(test, bindings[index], input, natures);
    if (judged.verdict.kind === "mismatch") {
      mismatches.push({ testId: test.id, detail: judged.verdict.detail });
    } else if (judged.verdict.kind === "unresolved") {
      unresolved.push({ testId: test.id, detail: judged.verdict.detail });
    }
    // 構造の検査は、1 件ごとに結果（合格・不一致・未解決）を記録する（照合の記録へ残す。Issue #387）
    if (test.operation === "structure" && test.assertion !== undefined) {
      structural.push({
        testId: test.id,
        requirementId: test.target.requirementId,
        check: test.assertion.check,
        result: judged.verdict.kind === "match" ? "pass" : judged.verdict.kind,
        detail: judged.verdict.kind === "match" ? "成り立った" : judged.verdict.detail,
      });
    }
    if (judged.verdict.kind !== "match" && judged.route !== null) {
      routes.push({
        testId: test.id,
        route: judged.route,
        detail: judged.verdict.detail,
        ...(judged.requirementId === undefined ? {} : { requirementId: judged.requirementId }),
        ...(judged.location === undefined ? {} : { location: judged.location }),
      });
    }
  });
  return { mismatches, unresolved, routes, structural };
}
