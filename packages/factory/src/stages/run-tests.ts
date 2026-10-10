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
//   entity × 在ることだけ     … 構造の確認（create の操作がある・一覧か表に出る）
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
import {
  isAppComputed,
  isComputedExpression,
  isComputedSettle,
  isGroupComputed,
  type Computed,
  type ComputedSettle,
  type NormalizedAppSpec,
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
  RoleNameMapping,
  TestExpected,
  TestMismatch,
  TestRunResult,
  TestSuite,
  TestTarget,
  TestUnresolved,
} from "../pipeline.js";
import { bindTests, type BindResult } from "./bind.js";
import { checkLocation, findComputed, findEntity } from "./correspondence.js";

/** ⑤b 試験を流す、が受け取るもの */
export interface RunTestsInput {
  readonly app: NormalizedAppSpec;
  readonly suite: TestSuite;
  readonly correspondence: CorrespondenceResult;
  /** ③ が提出した「役割 ID → 宣言の名前」の対応（§1・Issue #308）。旧形式の経路では省ける */
  readonly mappings?: readonly RoleNameMapping[];
}

/** 失敗の行き先（§1.3.1・Issue #308） */
export const FAILURE_ROUTES = ["correspondence-defect", "missing-element", "ambiguity"] as const;
export type FailureRoute = (typeof FAILURE_ROUTES)[number];

/** 行き先を分けた 1 件の失敗 */
export interface RoutedFailure {
  readonly testId: string;
  readonly route: FailureRoute;
  readonly detail: string;
}

/**
 * ⑤b の結果（`TestRunResult` に、失敗の行き先を足したもの）。`routes` は不一致・未解決になった
 * 試験の行き先である（⑦ の先の段が、③ のやり直し・⑥ 直す・未解決へ振り分ける。§1.3.1）。
 */
export interface TestRunReport extends TestRunResult {
  readonly routes: readonly RoutedFailure[];
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

/**
 * 参照データを、評価器が読む `sources`（entity の名前 → レコードの並び）にする。
 * 対象が実在の entity に結び付かない行があれば、その旨を `problem` に返す（黙って落とさない）。
 */
function buildSources(
  referenceData: readonly ReferenceRow[],
  input: RunTestsInput,
): { readonly sources: SourceRecords; readonly problem: string | null } {
  const sources: Record<string, SourceRecord[]> = {};
  const counts = new Map<string, number>();
  for (const row of referenceData) {
    const entity = resolveReferenceEntity(row.target, input);
    if (entity === null) {
      return {
        sources,
        problem: `参照データの対象（要件 ${row.target.requirementId}・役割 ${row.target.roleId ?? row.target.role ?? ""}）が実在の entity に結び付かない`,
      };
    }
    const count = (counts.get(entity) ?? 0) + 1;
    counts.set(entity, count);
    const records = sources[entity] ?? [];
    records.push({ id: row.rowId ?? `${entity}-${count}`, data: row.values });
    sources[entity] = records;
  }
  return { sources, problem: null };
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
  const record = asRecord(test.input);
  if (record === null) return { kind: "unresolved", detail: "入力が写像（object）でない" };
  const { sources } = buildSources(test.referenceData, input);
  const clock = fixedClock(test.clock);
  const allowed = allowsAction({ app: input.app, entity: action.entity, record, clock, sources }, action.when);
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
  const record = asRecord(test.input);
  if (record === null) return { kind: "unresolved", detail: "入力が写像（object）でない" };
  const { sources, problem } = buildSources(test.referenceData, input);
  if (problem !== null) return { kind: "mismatch", detail: problem };
  const clock = fixedClock(test.clock);
  const evaluation = evaluateRecord({
    app: input.app,
    entity: validation.entity,
    record,
    clock,
    sources,
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
  const { sources, problem } = buildSources(test.referenceData, input);
  if (problem !== null) return { kind: "mismatch", detail: problem };

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
  const record = asRecord(test.input);
  if (record === null) return { kind: "unresolved", detail: "入力が写像（object）でない" };
  if (isComputedExpression(computed) && computed.type === "boolean") {
    const holds = holdsExpression({ app: input.app, entity, record, clock, sources }, computed.expression);
    return compareBoolean(holds, test.expected, `印 ${computed.name}`);
  }
  const evaluation = evaluateRecord({ app: input.app, entity, record, clock, sources });
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
 * 「在ることだけ」の entity を**構造の確認**で判定する（§1.3 の表・Issue #308）。
 * create の操作があるか、一覧か表に出ていることを見る。
 */
function judgeExistenceStructural(app: NormalizedAppSpec, location: DeclarationLocation): Verdict {
  const entity = location.name;
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

/** 評価の方法（§1.3 の表・Issue #308）。未対応は `unresolved` に数える */
type Method = "value" | "validation" | "action" | "view" | "existence" | "unresolved";

/**
 * 対象の種類 × 操作で、評価の方法を決める（§1.3 の表）。
 *
 *   - 計算（`computation`）… 値の評価（`compute`・`aggregate`。画面の印も値の評価）
 *   - 項目・entity × `validate` … 検査の式（値の評価）
 *   - 操作 × `action`（`when`）… 値の評価
 *   - 画面 … 構造の確認
 *   - entity（在ることだけ・画面）… 構造の確認
 *   - それ以外（操作の実行・項目の既定値など）… 未対応（未解決）
 */
function evaluationMethod(test: FixedTest, nature: RequirementNature): Method {
  if (test.operation === "validate") return "validation";
  if (test.operation === "action") {
    return test.target.kind === "operation" ? "action" : "unresolved";
  }
  if (test.target.kind === "computation") return "value";
  if (test.target.kind === "screen") return "view";
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

/** 1 件の試験を判定し、失敗の行き先も返す */
function judgeOne(
  test: FixedTest,
  binding: BindResult | undefined,
  input: RunTestsInput,
  natures: ReadonlyMap<string, RequirementNature>,
): Judged {
  if (binding === undefined || binding.kind === "unbound") {
    // 提出された対応が無い・1 つに決まらない → 未解決（曖昧さ）。それ以外は対応の表の不備（③ のやり直し）
    if (binding?.cause === "no-mapping" || binding?.cause === "ambiguous") {
      return {
        verdict: { kind: "unresolved", detail: binding.detail },
        route: "ambiguity",
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
  const method = evaluationMethod(test, nature);
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
    case "existence":
      return { verdict: judgeExistenceStructural(input.app, location), route: null };
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
  input.suite.tests.forEach((test, index) => {
    const judged = judgeOne(test, bindings[index], input, natures);
    if (judged.verdict.kind === "mismatch") {
      mismatches.push({ testId: test.id, detail: judged.verdict.detail });
    } else if (judged.verdict.kind === "unresolved") {
      unresolved.push({ testId: test.id, detail: judged.verdict.detail });
    }
    if (judged.verdict.kind !== "match" && judged.route !== null) {
      routes.push({ testId: test.id, route: judged.route, detail: judged.verdict.detail });
    }
  });
  return { mismatches, unresolved, routes };
}
