// 失敗の場所（v12/locate.ts）の試験（08-architecture-v1.2.md §3 の 1 (c)・§4 のループの行・§9 の手 4 の後半。Issue #553）。
//
// 純粋な関数だけを照らす。LLM・判定・時計を使わない。題材は v1.1α の共通の題材（`v11a/__tests__/fixtures.ts`）。
import { describe, expect, it } from "vitest";
import type { FixedTest, TestSuite } from "../fixed-test.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import { FIXTURE_YAML, fixtureList, fixtureTable, fixtureYaml, normalizedFixture } from "../v11a/__tests__/fixtures.js";
import { bindTestsById, correspondenceFromTable, requiredValidationsOf } from "../v11a/bind-by-id.js";
import { toV1 } from "../v11a/convert.js";
import { createV11aEvaluator } from "../v11a/evaluate.js";
import type { TestObserves } from "../v11a/stages/test-spec.js";
import {
  canRepairFields,
  declarationSpans,
  locateFailures,
  spanOf,
  UNLOCATED_REASONS,
  type LocateInput,
} from "./locate.js";
import { NAMED_FAILURE_MESSAGES } from "./search-repair.js";

const TABLE = fixtureTable();

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const nodeFs = (await importUntyped("node:fs")) as NodeFileSystem;

/** 試験 1 本（対象の行・操作だけを決める。ほかの欄は場所に効かない） */
const test = (id: string, requirementId: string, kind: string, roleId: string, operation: string): FixedTest =>
  ({
    id,
    target: { requirementId, kind, roleId },
    kind: "normal",
    operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: {},
    referenceData: [],
    expected: { kind: "ok", value: "true", code: null },
  }) as unknown as FixedTest;

const SUITE: TestSuite = {
  tests: [
    test("r1-validate", "R1", "field", "f.item.amount", "validate"),
    test("r3-when", "R3", "operation", "o.closeItem", "action"),
    test("r4-rate", "R4", "computation", "c.rate", "compute"),
    test("r1-entity", "R1", "entity", "e.item", "validate"),
    test("x-missing-row", "R1", "field", "f.item.none", "validate"),
    test("r2-title", "R2", "field", "f.member.title", "validate"),
  ],
};

/** 静的チェック・B3・B3'・B4 を通った版（失敗は上書きする） */
const input = (overrides: Partial<LocateInput> = {}): LocateInput => ({
  source: FIXTURE_YAML,
  table: TABLE,
  suite: SUITE,
  staticCheckPassed: true,
  diagnostics: [],
  correspondenceMisses: [],
  rejections: [],
  unmarked: [],
  mismatches: [],
  unresolved: [],
  ...overrides,
});

/** 原文の中で、ちょうど 1 回現れる行の 1 始まりの番号 */
const lineOf = (source: string, text: string): number => {
  const lines = source.split("\n");
  const found = lines.flatMap((line, index) => (line === text ? [index + 1] : []));
  if (found.length !== 1) throw new Error(`前提が壊れた：行が 1 つでない（${text}）`);
  return found[0] ?? 0;
};

describe("宣言の要素の行の範囲", () => {
  it("entity の項目・検査・計算・操作・画面の範囲を決まった順で出し、範囲の行を並べると要素の原文になる", () => {
    const read = declarationSpans(FIXTURE_YAML);
    if (!read.ok) throw new Error("前提が壊れた：題材の宣言が読めない");
    expect(read.spans.map((span) => span.key)).toEqual([
      "field:member.title",
      "field:item.title",
      "field:item.owner",
      "field:item.amount",
      "field:item.day",
      "field:item.kind",
      "validation:item.amount",
      "computation:member.itemCount",
      "computation:base",
      "computation:rate",
      "computation:byKind",
      "computation:byMonth",
      "action:item.addItem",
      "action:item.closeItem",
      "view:item.items",
      "view:member.members",
      "view:overview",
    ]);
    const lines = FIXTURE_YAML.split("\n");
    const textOf = (key: string): string => {
      const span = read.spans.find((candidate) => candidate.key === key);
      if (span === undefined) throw new Error(`範囲が無い: ${key}`);
      return lines.slice(span.start, span.end).join("\n");
    };
    expect(textOf("field:item.kind")).toBe(
      ["      kind:", "        type: enum", "        options:", "          alpha: アルファ", "          beta: ベータ"].join("\n"),
    );
    expect(textOf("computation:rate")).toBe(["  - name: rate", "    scope: app", "    expression: base * 2", "    type: number"].join("\n"));
    expect(textOf("action:item.closeItem")).toBe(
      ["  - name: closeItem", "    entity: item", "    kind: update", "    set:", "      kind: beta", "    when: amount > 0"].join("\n"),
    );
    expect(textOf("view:overview")).toContain("        value: byKind");
  });

  it("読めない宣言は範囲を出さない。行の数え方が読み取りの値と合わない節（流れの書き方）の要素は出さない", () => {
    expect(declarationSpans("entities: [\n").ok).toBe(false);
    const flow = FIXTURE_YAML.replace("validations:\n  - name: amount\n    entity: item\n    expression: amount > 0\n", "validations: []\n");
    const read = declarationSpans(flow);
    if (!read.ok) throw new Error("前提が壊れた：読めない");
    expect(read.spans.some((span) => span.kind === "validation")).toBe(false);
  });

  it("場所の要素はちょうど 1 つのときだけ引ける（entity は置き換えの単位でない・名前の重なる要素は引かない）", () => {
    const read = declarationSpans(FIXTURE_YAML);
    if (!read.ok) throw new Error("前提が壊れた");
    expect(spanOf(read.spans, { kind: "computation", entity: null, name: "rate" })?.key).toBe("computation:rate");
    expect(spanOf(read.spans, { kind: "field", entity: "member", name: "title" })?.key).toBe("field:member.title");
    expect(spanOf(read.spans, { kind: "entity", entity: null, name: "item" })).toBeUndefined();
    expect(spanOf(read.spans, { kind: "computation", entity: null, name: "missing" })).toBeUndefined();
    const twice = [...read.spans, ...read.spans.filter((span) => span.key === "computation:rate")];
    expect(spanOf(twice, { kind: "computation", entity: null, name: "rate" })).toBeUndefined();
  });
});

describe("失敗の場所：B4・B3・B3'・静的チェックが正しい要素に写り、写せない失敗は場所なし", () => {
  it("B4 の不一致は試験の対象の行から（検査の試験は同じ名前の検査、操作・計算はその要素）、B3 の落ちはその場所から、B3' の拒否は所属させた行から写る", () => {
    const result = locateFailures(
      input({
        correspondenceMisses: [{ requirementId: "R4", location: { kind: "computation", entity: null, name: "byKind" }, detail: "落ち" }],
        rejections: [{ requirementId: "R4" }],
        mismatches: [{ testId: "r1-validate" }, { testId: "r3-when" }],
        unresolved: [{ testId: "r4-rate" }],
      }),
    );
    expect(result.unlocated).toEqual([]);
    expect(result.located).toEqual([
      { testId: null, requirementId: "R4", kind: "correspondence-miss", message: NAMED_FAILURE_MESSAGES["correspondence-miss"], locations: ["computation:byKind"] },
      {
        testId: null,
        requirementId: "R4",
        kind: "decl-rejection",
        message: NAMED_FAILURE_MESSAGES["decl-rejection"],
        locations: ["computation:byKind", "computation:byMonth", "computation:rate", "view:overview"],
      },
      { testId: "r1-validate", requirementId: "R1", kind: "test-mismatch", message: NAMED_FAILURE_MESSAGES["test-mismatch"], locations: ["validation:item.amount"] },
      { testId: "r3-when", requirementId: "R3", kind: "test-mismatch", message: NAMED_FAILURE_MESSAGES["test-mismatch"], locations: ["action:item.closeItem"] },
      { testId: "r4-rate", requirementId: "R4", kind: "test-unresolved", message: NAMED_FAILURE_MESSAGES["test-unresolved"], locations: ["computation:rate"] },
    ]);
    // 場所の並びは最初に現れた順・重複なし
    expect(result.locations).toEqual([
      "computation:byKind",
      "computation:byMonth",
      "computation:rate",
      "view:overview",
      "validation:item.amount",
      "action:item.closeItem",
    ]);
    expect(canRepairFields(result)).toBe(true);
  });

  it("静的チェックの問題は、その位置を含む要素へ写る。要素の外の位置（節の見出し・permissions）は場所なし", () => {
    const result = locateFailures(
      input({
        staticCheckPassed: false,
        diagnostics: [
          { line: lineOf(FIXTURE_YAML, "    expression: base * 2") },
          { line: lineOf(FIXTURE_YAML, "        to: member") },
          { line: lineOf(FIXTURE_YAML, "permissions:") },
        ],
        mismatches: [{ testId: "r3-when" }],
      }),
    );
    // 静的チェックに落ちた版は静的チェックの問題だけ（namedFailuresOf と同じ向き）
    expect(result.located.map((failure) => [failure.kind, failure.locations])).toEqual([
      ["static-check", ["computation:rate"]],
      ["static-check", ["field:item.owner"]],
    ]);
    expect(result.unlocated).toEqual([
      { testId: null, requirementId: null, kind: "static-check", message: NAMED_FAILURE_MESSAGES["static-check"], reason: "outside-element" },
    ]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("負例：行の場所が無い・要素が宣言に無い（entity の行・宣言から消えた要素）失敗は場所なしに入り、近い要素に写らない", () => {
    const withoutClose = FIXTURE_YAML.replace(
      "  - name: closeItem\n    entity: item\n    kind: update\n    set:\n      kind: beta\n    when: amount > 0\n",
      "",
    );
    const result = locateFailures(
      input({
        source: withoutClose,
        correspondenceMisses: [
          { requirementId: "R3", location: { kind: "action", entity: "item", name: "closeItem" }, detail: "宣言に無い" },
          { requirementId: "R2", detail: "対応そのものが無い" },
        ],
        rejections: [{ requirementId: "R5" }],
        unmarked: ["R4"],
        mismatches: [{ testId: "r1-entity" }, { testId: "x-missing-row" }, { testId: "r2-title" }, { testId: "not-in-suite" }],
      }),
    );
    expect(result.located).toEqual([]);
    expect(result.locations).toEqual([]);
    expect(result.unlocated.map((failure) => [failure.kind, failure.testId ?? failure.requirementId, failure.reason])).toEqual([
      ["correspondence-miss", "R3", "no-element"],
      ["correspondence-miss", "R2", "no-row-location"],
      // R5 は所属させた行が無い
      ["decl-rejection", "R5", "no-row-location"],
      ["decl-unmarked", "R4", "no-element"],
      // entity の行は置き換えの単位でない
      ["test-mismatch", "r1-entity", "no-element"],
      ["test-mismatch", "x-missing-row", "no-row-location"],
      // 検査 title は宣言に無い（項目 member.title が在っても、近い要素に写さない）
      ["test-mismatch", "r2-title", "no-element"],
      ["test-mismatch", "not-in-suite", "no-row-location"],
    ]);
    expect(UNLOCATED_REASONS).toEqual(["no-row-location", "no-element", "outside-element"]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("拒否の所属は導いた entity の所属を含み、entity の行を含む拒否（R3 は操作と項目から entity item を導く）は場所なし", () => {
    const result = locateFailures(input({ rejections: [{ requirementId: "R3" }], mismatches: [{ testId: "r3-when" }] }));
    expect(result.unlocated.map((failure) => [failure.kind, failure.requirementId, failure.reason])).toEqual([["decl-rejection", "R3", "no-element"]]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("拒否の要件が所属させた行の 1 つでも写せなければ、その拒否は場所なし（一部の場所だけに写さない）", () => {
    const table = {
      ...TABLE,
      ownership: TABLE.ownership.map((entry) =>
        entry.requirementId === "R4" ? { ...entry, roles: [...entry.roles, { id: "e.item", basis: "stated" as const, reason: null }] } : entry,
      ),
    };
    const result = locateFailures(input({ table, rejections: [{ requirementId: "R4" }], mismatches: [{ testId: "r3-when" }] }));
    expect(result.unlocated.map((failure) => [failure.requirementId, failure.reason])).toEqual([["R4", "no-element"]]);
    expect(result.locations).toEqual(["action:item.closeItem"]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("並びは決定的：同じ版と文脈で 2 回同じ結果。重なった失敗は 1 つ", () => {
    const value = input({ mismatches: [{ testId: "r3-when" }, { testId: "r3-when" }, { testId: "r1-validate" }], unresolved: [{ testId: "r1-entity" }] });
    const first = locateFailures(value);
    expect(locateFailures(value)).toEqual(first);
    expect(JSON.stringify(locateFailures(value))).toBe(JSON.stringify(first));
    expect(first.located.map((failure) => failure.testId)).toEqual(["r3-when", "r1-validate"]);
    expect(first.unlocated.map((failure) => failure.testId)).toEqual(["r1-entity"]);
  });

  it("場所に写した失敗が無い往復は欄だけの直しを使わない", () => {
    expect(canRepairFields(locateFailures(input()))).toBe(false);
  });
});

// ── 旗 v12.ids：結び付けと同じ関数で場所を決め、要求する検査が無い失敗を追加の場所に写す（手 4e。Issue #667）──────────

/** 検査の節を空にした宣言（`validations: []`） */
const NO_VALIDATION_YAML = fixtureYaml({ validation: false });
/** 検査の節を差し替えた宣言 */
const withValidations = (lines: readonly string[]): string =>
  FIXTURE_YAML.replace("validations:\n  - name: amount\n    entity: item\n    expression: amount > 0\n", ["validations:", ...lines, ""].join("\n"));

/** validate の試験（対象の行・種類だけを決める） */
const vtest = (id: string, roleId: string, kind: "field" | "entity" = "field", testKind = "normal"): FixedTest =>
  ({ ...test(id, "R1", kind, roleId, "validate"), kind: testKind }) as FixedTest;

/** 旗 ids の場所の入力（観測する性質は既定で全部 validation。骨組みは同じ組から `requiredValidationsOf` で導く） */
const idsInput = (
  suite: TestSuite,
  overrides: Partial<LocateInput> = {},
  observes: ReadonlyMap<string, TestObserves> = new Map(suite.tests.map((entry) => [entry.id, "validation" as const])),
): LocateInput => {
  const table = overrides.table ?? TABLE;
  return input({ suite, ids: { observes, requiredValidations: requiredValidationsOf(table, suite, observes) }, ...overrides });
};

describe("旗 v12.ids の場所（純粋）：validate の試験は結び付けと同じ関数で場所を決め、要求する検査が無ければ追加の場所（Issue #667）", () => {
  it("(1) 項目 F の validate の不一致で、同じ entity に検査 F が在る → 置換の場所（今と同じ）。追加は 0", () => {
    const suite: TestSuite = { tests: [vtest("v-amount", "f.item.amount")] };
    const result = locateFailures(idsInput(suite, { mismatches: [{ testId: "v-amount" }] }));
    expect(result.located.map((failure) => failure.locations)).toEqual([["validation:item.amount"]]);
    expect(result.unlocated).toEqual([]);
    expect(result.additions).toEqual([]);
    // off と同じ場所
    expect(locateFailures(input({ suite, mismatches: [{ testId: "v-amount" }] })).located).toEqual(result.located);
  });

  it("(2) 検査が無く entity が在る → 追加の場所 validation:E.F が 1 つ。同じ要求の試験 2 件（normal・abnormal）でも 1 つ。欄だけの直しを使える", () => {
    const suite: TestSuite = { tests: [vtest("v-normal", "f.item.amount"), vtest("v-abnormal", "f.item.amount", "field", "abnormal")] };
    const result = locateFailures(idsInput(suite, { source: NO_VALIDATION_YAML, mismatches: [{ testId: "v-normal" }], unresolved: [{ testId: "v-abnormal" }] }));
    expect(result.unlocated).toEqual([]);
    expect(result.located.map((failure) => [failure.kind, failure.testId, failure.locations])).toEqual([
      ["test-mismatch", "v-normal", ["validation:item.amount"]],
      ["test-unresolved", "v-abnormal", ["validation:item.amount"]],
    ]);
    expect(result.locations).toEqual(["validation:item.amount"]);
    expect(result.additions).toEqual([{ key: "validation:item.amount", entity: "item", name: "amount" }]);
    expect(canRepairFields(result)).toBe(true);
    // 二点測定の「前」：off（ids を渡さない）は同じ失敗が全部場所なし（no-element）で、欄だけの直しを使えない
    const off = locateFailures(input({ suite, source: NO_VALIDATION_YAML, mismatches: [{ testId: "v-normal" }], unresolved: [{ testId: "v-abnormal" }] }));
    expect(off.unlocated.map((failure) => failure.reason)).toEqual(["no-element", "no-element"]);
    expect(canRepairFields(off)).toBe(false);
  });

  it("(2') 既定値の validate の不一致（同名の検査が無い）→ 場所なし。選択肢の集合・写像に無い性質の試験も場所なし（追加しない）", () => {
    const suite: TestSuite = { tests: [vtest("v-default", "f.item.kind"), vtest("v-options", "f.item.kind"), vtest("v-unmapped", "f.item.kind")] };
    const observes = new Map<string, TestObserves>([
      ["v-default", "default-value"],
      // 選択肢の集合（台帳の性質。T2 の性質の型の外から写像に入る）
      ["v-options", "enum-membership" as unknown as TestObserves],
    ]);
    const result = locateFailures(
      idsInput(suite, { source: NO_VALIDATION_YAML, mismatches: [{ testId: "v-default" }, { testId: "v-options" }, { testId: "v-unmapped" }] }, observes),
    );
    expect(result.located).toEqual([]);
    expect(result.unlocated.map((failure) => [failure.testId, failure.reason])).toEqual([
      ["v-default", "no-element"],
      ["v-options", "no-element"],
      ["v-unmapped", "no-element"],
    ]);
    expect(result.additions).toEqual([]);
  });

  it("(3) entity の行の validate → 検査 E.E の場所（在れば置換・無ければ追加）。entity の行の validate 以外の試験は今までどおり no-element", () => {
    const suite: TestSuite = { tests: [vtest("v-entity", "e.item", "entity"), test("x-entity-compute", "R1", "entity", "e.item", "compute")] };
    const failures = { mismatches: [{ testId: "v-entity" }, { testId: "x-entity-compute" }] };
    const added = locateFailures(idsInput(suite, { ...failures }));
    expect(added.located.map((failure) => [failure.testId, failure.locations])).toEqual([["v-entity", ["validation:item.item"]]]);
    expect(added.additions).toEqual([{ key: "validation:item.item", entity: "item", name: "item" }]);
    expect(added.unlocated.map((failure) => [failure.testId, failure.reason])).toEqual([["x-entity-compute", "no-element"]]);
    const present = withValidations(["  - name: item", "    entity: item", "    expression: amount > 0"]);
    const replaced = locateFailures(idsInput(suite, { source: present, ...failures }));
    expect(replaced.located.map((failure) => [failure.testId, failure.locations])).toEqual([["v-entity", ["validation:item.item"]]]);
    expect(replaced.additions).toEqual([]);
    // off（ids を渡さない）は entity の行の validate を no-element のまま
    expect(locateFailures(input({ suite, source: present, ...failures })).unlocated.map((failure) => [failure.testId, failure.reason])).toEqual([
      ["v-entity", "no-element"],
      ["x-entity-compute", "no-element"],
    ]);
  });

  it("(4) 別 entity に同名の検査が在る → 場所なし（追加も選び直しもしない）", () => {
    const source = withValidations(["  - name: title", "    entity: member", "    expression: len(title) > 0"]);
    const suite: TestSuite = { tests: [vtest("v-item-title", "f.item.title")] };
    const result = locateFailures(idsInput(suite, { source, mismatches: [{ testId: "v-item-title" }] }));
    expect(result.located).toEqual([]);
    expect(result.unlocated.map((failure) => [failure.testId, failure.reason])).toEqual([["v-item-title", "no-element"]]);
    expect(result.additions).toEqual([]);
  });

  it("(4') 検査 0 の版で 2 つの entity の同名の項目が両方 validate 不一致 → 骨組みの競合の印でどちらも追加の場所にならず場所なし（片方を選ばない）", () => {
    const suite: TestSuite = { tests: [vtest("v-member-title", "f.member.title"), vtest("v-item-title", "f.item.title")] };
    const value = idsInput(suite, { source: NO_VALIDATION_YAML, mismatches: [{ testId: "v-member-title" }, { testId: "v-item-title" }] });
    expect(value.ids?.requiredValidations.map((entry) => [entry.entity, entry.name, entry.conflict])).toEqual([
      ["member", "title", true],
      ["item", "title", true],
    ]);
    const result = locateFailures(value);
    expect(result.located).toEqual([]);
    expect(result.unlocated.map((failure) => [failure.testId, failure.reason])).toEqual([
      ["v-member-title", "no-element"],
      ["v-item-title", "no-element"],
    ]);
    expect(result.additions).toEqual([]);
    expect(canRepairFields(result)).toBe(false);
  });

  it("(g) 追加予定の 2 件が同名なら、骨組みに競合の印が無くても両方を候補から外す（検査の名前は宣言全体で一意。推測・改名・一方の選択をしない）", () => {
    const suite: TestSuite = { tests: [vtest("v-member-title", "f.member.title"), vtest("v-item-title", "f.item.title")] };
    const base = idsInput(suite, { source: NO_VALIDATION_YAML, mismatches: [{ testId: "v-member-title" }, { testId: "v-item-title" }] });
    const ids = base.ids;
    if (ids === undefined) throw new Error("前提が壊れた");
    const unmarked = { ...ids, requiredValidations: ids.requiredValidations.map((entry) => ({ ...entry, conflict: false })) };
    const result = locateFailures({ ...base, ids: unmarked });
    expect(result.located).toEqual([]);
    expect(result.additions).toEqual([]);
    expect(result.unlocated.map((failure) => failure.reason)).toEqual(["no-element", "no-element"]);
  });

  it("(5) entity が宣言に無い → 場所なし", () => {
    const source = NO_VALIDATION_YAML.replace("  - name: member\n    fields:", "  - name: person\n    fields:");
    const suite: TestSuite = { tests: [vtest("v-member-title", "f.member.title")] };
    const result = locateFailures(idsInput(suite, { source, mismatches: [{ testId: "v-member-title" }] }));
    expect(result.unlocated.map((failure) => [failure.testId, failure.reason])).toEqual([["v-member-title", "no-element"]]);
    expect(result.additions).toEqual([]);
  });

  it("(6) 計算・操作の不一致で要素が無い → 場所なし（追加しない）。(7) 要件の拒否・結び付けの落ち・unmarked は今までどおり", () => {
    const source = NO_VALIDATION_YAML.replace("  - name: closeItem\n    entity: item\n    kind: update\n    set:\n      kind: beta\n    when: amount > 0\n", "")
      .replace("  - name: rate\n    scope: app\n    expression: base * 2\n    type: number\n", "");
    const value = idsInput(SUITE, {
      source,
      correspondenceMisses: [
        { requirementId: "R3", location: { kind: "action", entity: "item", name: "closeItem" }, detail: "宣言に無い" },
        { requirementId: "R2", detail: "対応そのものが無い" },
      ],
      rejections: [{ requirementId: "R5" }, { requirementId: "R3" }],
      unmarked: ["R4"],
      mismatches: [{ testId: "r3-when" }, { testId: "r4-rate" }],
    });
    const on = locateFailures(value);
    const { ids: _ids, ...offInput } = value;
    const off = locateFailures(offInput);
    expect(on.unlocated).toEqual(off.unlocated);
    expect(on.located).toEqual(off.located);
    expect(on.unlocated.map((failure) => [failure.kind, failure.testId ?? failure.requirementId, failure.reason])).toEqual([
      ["correspondence-miss", "R3", "no-element"],
      ["correspondence-miss", "R2", "no-row-location"],
      ["decl-rejection", "R5", "no-row-location"],
      ["decl-rejection", "R3", "no-element"],
      ["decl-unmarked", "R4", "no-element"],
      ["test-mismatch", "r3-when", "no-element"],
      ["test-mismatch", "r4-rate", "no-element"],
    ]);
    expect(on.additions).toEqual([]);
  });

  it("静的チェックに落ちた版には追加の場所を作らない（静的チェックの問題だけ）", () => {
    const suite: TestSuite = { tests: [vtest("v-amount", "f.item.amount")] };
    const result = locateFailures(idsInput(suite, { source: NO_VALIDATION_YAML, staticCheckPassed: false, diagnostics: [], mismatches: [{ testId: "v-amount" }] }));
    expect(result.additions).toEqual([]);
    expect(result.located).toEqual([]);
    expect(result.unlocated.map((failure) => failure.kind)).toEqual(["static-check"]);
  });

  it("(e) 結び付かない別名の検査が在っても選び直さない：要求する名前の追加の場所になり、別名の検査は場所の選択肢に入らない", () => {
    const source = withValidations(["  - name: positive", "    entity: item", "    expression: amount > 0"]);
    const suite: TestSuite = { tests: [vtest("v-amount", "f.item.amount")] };
    const result = locateFailures(idsInput(suite, { source, mismatches: [{ testId: "v-amount" }] }));
    expect(result.locations).toEqual(["validation:item.amount"]);
    expect(result.additions).toEqual([{ key: "validation:item.amount", entity: "item", name: "amount" }]);
    expect(result.locations).not.toContain("validation:item.positive");
  });

  it("(8) 同じ入力から 2 回同じ結果。ids off（ids を渡さない）の結果は追加の欄を持たない", () => {
    const suite: TestSuite = { tests: [vtest("v-amount", "f.item.amount"), vtest("v-entity", "e.item", "entity"), ...SUITE.tests] };
    const failures = { source: NO_VALIDATION_YAML, mismatches: [{ testId: "v-amount" }, { testId: "v-entity" }, { testId: "r3-when" }] };
    const value = idsInput(suite, failures);
    expect(JSON.stringify(locateFailures(value))).toBe(JSON.stringify(locateFailures(value)));
    expect(locateFailures(value).additions).toEqual([
      { key: "validation:item.amount", entity: "item", name: "amount" },
      { key: "validation:item.item", entity: "item", name: "item" },
    ]);
    expect("additions" in locateFailures(input({ suite, ...failures }))).toBe(false);
  });

  it("結び付けと場所は同じ関数から：結び付いた validate の試験は、その場所と同じ名前の置換の場所に写り、結び付かない試験は置換の場所に写らない", async () => {
    const yaml = withValidations([
      "  - name: amount",
      "    entity: item",
      "    expression: amount > 0",
      "  - name: item",
      "    entity: item",
      "    expression: amount < 100",
    ]).replace("show: [title, amount, kind]", "show: [title, owner, amount, day, kind]");
    const app = await normalizedFixture(yaml);
    const suite: TestSuite = {
      tests: [vtest("v-amount", "f.item.amount"), vtest("v-entity", "e.item", "entity"), vtest("v-title", "f.item.title"), vtest("v-member", "e.member", "entity")],
    };
    const bound = bindTestsById(app, TABLE, suite).bindings;
    const result = locateFailures(idsInput(suite, { source: yaml, mismatches: suite.tests.map((entry) => ({ testId: entry.id })) }));
    for (const entry of suite.tests) {
      const binding = bound.get(entry.id);
      const located = result.located.find((failure) => failure.testId === entry.id);
      if (binding?.kind === "bound") {
        expect(located?.locations).toEqual([`validation:${binding.location.entity ?? ""}.${binding.location.name}`]);
        expect(result.additions?.some((addition) => located?.locations.includes(addition.key))).toBe(false);
      } else {
        // 結び付かない試験は置換の場所に写らない（追加の場所か場所なし）
        const keys = located?.locations ?? [];
        expect(keys.every((key) => result.additions?.some((addition) => addition.key === key))).toBe(true);
      }
    }
    expect([...bound.values()].map((entry) => entry.kind)).toEqual(["bound", "bound", "unbound", "unbound"]);
    expect(result.additions).toEqual([
      { key: "validation:item.title", entity: "item", name: "title" },
      { key: "validation:member.member", entity: "member", name: "member" },
    ]);
  });

  it("(f) 既定値の試験の不一致に同名の検査を足した合成例でも不一致が残る（専用の照合が検査の式を見ない＝追加先を作らない根拠）", async () => {
    const yaml = FIXTURE_YAML.replace("show: [title, amount, kind]", "show: [title, owner, amount, day, kind]");
    const defaultTest: FixedTest = {
      ...vtest("v-default", "f.item.kind"),
      target: { requirementId: "R1", kind: "field", roleId: "f.item.kind" },
      inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
      expected: { kind: "ok", value: "alpha" },
    } as FixedTest;
    const suite: TestSuite = { tests: [defaultTest] };
    const observes = new Map<string, TestObserves>([["v-default", "default-value"]]);
    const list = { ...fixtureList(), requirements: fixtureList().requirements.filter((requirement) => requirement.id !== "R5") };
    const table = { ...TABLE, ownership: TABLE.ownership.filter((entry) => entry.requirementId !== "R5") };
    const context = { list, suite, correspondences: correspondenceFromTable(table), ownership: toV1(table).ownership };
    const mismatchesOf = async (source: string): Promise<readonly string[]> => {
      const app = await normalizedFixture(source);
      const evaluator = createV11aEvaluator({ table: TABLE, observes });
      const checked = evaluator.nameCheck(app, context);
      return evaluator.runTests(app, context, { entries: checked.entries, misses: checked.misses }).mismatches.map((entry) => entry.testId);
    };
    // default の無い宣言は不一致。場所は作らない（追加の候補にならない）
    expect(await mismatchesOf(yaml)).toEqual(["v-default"]);
    expect(locateFailures(idsInput(suite, { source: yaml, mismatches: [{ testId: "v-default" }] }, observes)).additions).toEqual([]);
    // 同名の検査 kind を足しても、既定値の照合は検査の式を見ないので不一致が残る
    const withKind = yaml.replace("    expression: amount > 0\n", "    expression: amount > 0\n  - name: kind\n    entity: item\n    expression: kind == \"alpha\"\n");
    expect(withKind).not.toBe(yaml);
    expect(await mismatchesOf(withKind)).toEqual(["v-default"]);
  });
});

describe("題材の言葉の走査（Issue #553・#667 で足した・直したファイル）", () => {
  it("場所・欄だけの直し・探索の部品とその試験のソースに受入の題材の言葉が無い", () => {
    const files = [
      "../v11a/bind-by-id.ts",
      "../v11a/bind-by-id.test.ts",
      "./locate.ts",
      "./locate.test.ts",
      "./search-repair.ts",
      "./search-repair.test.ts",
      "./stages/field-repair.ts",
      "./stages/field-repair.test.ts",
      "./stages/field-repair-wire.test.ts",
      "../v11a/run.ts",
      "../v11a/run.test.ts",
      "../v11a/__tests__/fixtures.ts",
      "../index.ts",
    ];
    expectNoAcceptanceMaterial(files.map((file) => nodeFs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});
