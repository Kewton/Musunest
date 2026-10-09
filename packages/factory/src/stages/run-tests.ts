// ⑤b 試験を流す（02-architecture.md §1・§1.3・F-9・R-8）。
//
// 固定した試験を、結び付けの規則（bind.ts）で宣言の実在の要素に結び付けてから、spec-engine の
// 評価器で流す。**合否はコードが決める**（LLM の自己申告ではない）：
//
//   計算の値   … `evaluateRecord` の `computed`
//   検査       … `evaluateRecord` の `validations`
//   操作の条件 … `allowsAction`（`when` の式）
//   印         … `holdsExpression`（真偽の計算をその行で解く）
//   アプリ全体の集計 … `evaluateScope`
//   見出しごとの集計 … `groupValuesOf`
//   精算       … `settleEntity`
//
// **入力の型（フォームが受け付ける値）と、操作の実行（`set` を当てたあとの状態）だけは流さず**、
// 未解決として数える（§1.3・U-G）。未解決は合格にしない（⑦ が部分案へ倒す）。
//
// 結び付けられなかった試験・実在しない場所を指す試験は**不一致**にする。評価器は存在しない entity にも
// 空の結果を返すので、実在はここで先に確かめる（R-8）。
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
  TestBinding,
  TestExpected,
  TestMismatch,
  TestRunResult,
  TestSuite,
  TestTarget,
  TestUnresolved,
} from "../pipeline.js";
import { bindTests } from "./bind.js";
import { checkLocation, findComputed, findEntity } from "./correspondence.js";

/** ⑤b 試験を流す、が受け取るもの */
export interface RunTestsInput {
  readonly app: NormalizedAppSpec;
  readonly suite: TestSuite;
  readonly correspondence: CorrespondenceResult;
}

/** 1 件の試験の判定 */
type Verdict =
  | { readonly kind: "match" }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "unresolved"; readonly detail: string };

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

/** 参照データの対象（selector）を、実在の entity の名前に結び付ける */
function resolveEntityTarget(target: TestTarget, input: RunTestsInput): string | null {
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
    const entity = resolveEntityTarget(row.target, input);
    if (entity === null) {
      return {
        sources,
        problem: `参照データの対象（要件 ${row.target.requirementId}・役割 ${row.target.role}）が実在の entity に結び付かない`,
      };
    }
    const count = (counts.get(entity) ?? 0) + 1;
    counts.set(entity, count);
    const records = sources[entity] ?? [];
    records.push({ id: `${entity}-${count}`, data: row.values });
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

/** 1 件の試験を判定する */
function judgeOne(test: FixedTest, binding: TestBinding | undefined, input: RunTestsInput): Verdict {
  if (binding === undefined || binding.kind === "unbound") {
    return { kind: "mismatch", detail: binding?.detail ?? "結び付けられない" };
  }
  const location = binding.location;
  const checked = checkLocation(input.app, location);
  if (!checked.ok) return { kind: "mismatch", detail: checked.reason };
  // 入力の型（フォームが受け付ける値）は評価器で確かめられない（U-G）
  if (test.target.kind === "field") {
    return { kind: "unresolved", detail: `入力の型は評価器で確かめられない（${location.name}）` };
  }
  switch (test.operation) {
    case "action":
      return judgeAction(test, location, input);
    case "validate":
      return judgeValidation(test, location, input);
    case "compute":
    case "aggregate":
    case "screen":
      return judgeValue(test, location, input);
  }
}

/**
 * 固定した試験の組を流し、不一致と未解決を返す（§1.3・F-9）。
 * 結び付けられなかった試験も不一致として数える（R-8）。
 */
export function runTests(input: RunTestsInput): TestRunResult {
  const bindings = bindTests({ suite: input.suite, correspondence: input.correspondence });
  const mismatches: TestMismatch[] = [];
  const unresolved: TestUnresolved[] = [];
  input.suite.tests.forEach((test, index) => {
    const verdict = judgeOne(test, bindings[index], input);
    if (verdict.kind === "mismatch") mismatches.push({ testId: test.id, detail: verdict.detail });
    else if (verdict.kind === "unresolved") unresolved.push({ testId: test.id, detail: verdict.detail });
  });
  return { mismatches, unresolved };
}
