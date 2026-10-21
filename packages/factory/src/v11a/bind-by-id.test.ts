// 表の `id` による結び付け・印・追加の要素（v11a/bind-by-id.ts）の unit テスト
// （07-architecture-v1.1a.md §1.1・§2.1・D4・D11。Issue #505）。
import { normalizeSpec } from "@musunest/spec-engine";
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import type { FixedTest, TestOperation, TestSuite, TestTargetKind } from "../fixed-test.js";
import type { DeclarationLocation } from "../pipeline.js";
import { bindTests, type BindResult } from "../stages/bind.js";
import { declarationHasLocation, declarationKindOfRole } from "../stages/correspondence.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import { FIXTURE_YAML, fixtureList, fixtureTable, fixtureYaml, normalizedFixture } from "./__tests__/fixtures.js";
import {
  bindTestsById,
  correspondenceFromTable,
  extraElementsOf,
  markRows,
  requiredValidationLocation,
  requiredValidationsOf,
  type MarkReference,
} from "./bind-by-id.js";
import { identityMappings, toV1 } from "./convert.js";
import { createV11aEvaluator } from "./evaluate.js";
import type { NameTable } from "./names.js";
import type { TestObserves } from "./stages/test-spec.js";

const fixed = (
  id: string,
  requirementId: string,
  kind: TestTargetKind,
  roleId: string,
  operation: TestOperation,
): FixedTest => ({
  id,
  target: { requirementId, kind, roleId },
  kind: "normal",
  operation,
  clock: "2026-09-16T12:00:00+09:00",
  input: null,
  referenceData: [],
  expected: { kind: "ok", value: null },
});

const suiteOf = (...tests: readonly FixedTest[]): TestSuite => ({ tests });

describe("試験は表の id で決定的に結び付く（D11）", () => {
  it("同じ要件が別 entity の同名の項目を 2 つ所属させても、2 つの試験は別の場所に結び付く", async () => {
    const app = await normalizedFixture();
    const table = fixtureTable();
    const suite = suiteOf(
      fixed("t-member-title", "R2", "field", "f.member.title", "screen"),
      fixed("t-item-title", "R2", "field", "f.item.title", "screen"),
    );
    const { bindings } = bindTestsById(app, table, suite);
    expect(bindings.get("t-member-title")).toEqual({
      kind: "bound",
      testId: "t-member-title",
      location: { kind: "field", entity: "member", name: "title" },
    });
    expect(bindings.get("t-item-title")).toEqual({
      kind: "bound",
      testId: "t-item-title",
      location: { kind: "field", entity: "item", name: "title" },
    });

    // 対照：v1 の bindTests は名前だけで候補を絞るので、同じ対応表と恒等の対応でも ambiguous になる
    const v1 = bindTests({
      suite,
      correspondence: { entries: correspondenceFromTable(table), misses: [] },
      mappings: identityMappings(table),
    });
    expect(v1.map((result) => (result.kind === "unbound" ? result.cause : result.kind))).toEqual([
      "ambiguous",
      "ambiguous",
    ]);
  });

  it("結果は試験 ID で引く（並びが変わっても同じ結果）", async () => {
    const app = await normalizedFixture();
    const a = fixed("a", "R1", "operation", "o.addItem", "action");
    const b = fixed("b", "R3", "operation", "o.closeItem", "action");
    const forward = bindTestsById(app, fixtureTable(), suiteOf(a, b)).bindings;
    const backward = bindTestsById(app, fixtureTable(), suiteOf(b, a)).bindings;
    expect(forward.get("a")).toEqual(backward.get("a"));
    expect(forward.get("b")).toEqual(backward.get("b"));
  });

  it("宣言に無い名前は unbound（no-candidate）、表に無い id は unbound（no-mapping）", async () => {
    const app = await normalizedFixture(fixtureYaml({ closeItem: false }));
    const { bindings } = bindTestsById(
      app,
      fixtureTable(),
      suiteOf(fixed("gone", "R3", "operation", "o.closeItem", "action"), fixed("nope", "R3", "operation", "o.nothing", "action")),
    );
    expect(bindings.get("gone")).toMatchObject({ kind: "unbound", cause: "no-candidate" });
    expect(bindings.get("nope")).toMatchObject({ kind: "unbound", cause: "no-mapping" });
  });

  it("validate の試験は項目の名前で検査を探す（M-03 は残る）", async () => {
    const app = await normalizedFixture();
    const { bindings } = bindTestsById(
      app,
      fixtureTable(),
      suiteOf(fixed("v-amount", "R3", "field", "f.item.amount", "validate"), fixed("v-day", "R1", "field", "f.item.day", "validate")),
    );
    expect(bindings.get("v-amount")).toEqual({
      kind: "bound",
      testId: "v-amount",
      location: { kind: "validation", entity: "item", name: "amount" },
    });
    // 同名の検査が無い項目は結び付かない（M-03。名前の違う検査を推測しない）
    expect(bindings.get("v-day")).toMatchObject({ kind: "unbound", cause: "no-candidate" });
  });

  it("参照データの entity を引くため、entity の id → 宣言の名前も返す", async () => {
    const app = await normalizedFixture();
    const { entityNames } = bindTestsById(app, fixtureTable(), suiteOf());
    expect([...entityNames]).toEqual([
      ["e.member", "member"],
      ["e.item", "item"],
    ]);
  });
});

describe("要件ごとの対応表を表から導く（§1.2・D14）", () => {
  it("所属させた行の場所の集合（導いた entity を含む）", () => {
    const entries = correspondenceFromTable(fixtureTable());
    const r2 = entries.find((entry) => entry.requirementId === "R2");
    expect(r2?.locations).toContainEqual({ kind: "field", entity: "member", name: "title" });
    expect(r2?.locations).toContainEqual({ kind: "field", entity: "item", name: "title" });
    expect(r2?.locations).toContainEqual({ kind: "entity", entity: null, name: "member" });
  });

  it("除く行の集合を渡すとその場所が消え、共有する行は残る", () => {
    const excluded = new Set(["f.member.title", "c.itemCount", "s.members", "e.member"]);
    const entries = correspondenceFromTable(fixtureTable(), excluded);
    const r2 = entries.find((entry) => entry.requirementId === "R2");
    expect(r2?.locations).not.toContainEqual({ kind: "field", entity: "member", name: "title" });
    expect(r2?.locations).not.toContainEqual({ kind: "computation", entity: "member", name: "itemCount" });
    expect(r2?.locations).toContainEqual({ kind: "field", entity: "item", name: "title" });
    const r1 = entries.find((entry) => entry.requirementId === "R1");
    expect(r1?.locations).toContainEqual({ kind: "field", entity: "item", name: "title" });
  });
});

const refOf = (reference: MarkReference) => ({
  kind: reference.kind,
  entity: reference.entity,
  name: reference.name,
  via: reference.via,
});

describe("B3' の印（該当箇所と参照先。§1.1）", () => {
  it("計算の式が参照する補助の計算が参照先に入る", async () => {
    const app = await normalizedFixture();
    const mark = markRows(app, fixtureTable()).get("c.rate");
    expect(mark?.element).toEqual({ kind: "computation", entity: null, name: "rate", path: "spec.computed[2]" });
    expect(mark?.references).toContainEqual({
      kind: "computation",
      entity: null,
      name: "base",
      via: "expression",
      path: "spec.computed[1]",
    });
  });

  it("画面の show の項目・計算が参照先に入る", async () => {
    const app = await normalizedFixture();
    const marks = markRows(app, fixtureTable());
    expect(marks.get("s.items")?.references).toContainEqual({
      kind: "field",
      entity: "item",
      name: "title",
      via: "show",
      path: "spec.entities[1].fields.title",
    });
    expect(marks.get("s.members")?.references.map(refOf)).toContainEqual({
      kind: "computation",
      entity: "member",
      name: "itemCount",
      via: "show",
    });
  });

  it("集計の entity と groupBy が参照先に入る", async () => {
    const app = await normalizedFixture();
    const marks = markRows(app, fixtureTable());
    const byKind = marks.get("c.byKind")?.references.map(refOf);
    expect(byKind).toContainEqual({ kind: "entity", entity: null, name: "item", via: "aggregate-entity" });
    expect(byKind).toContainEqual({ kind: "field", entity: "item", name: "kind", via: "aggregate-groupBy" });
    expect(marks.get("c.byMonth")?.references.map(refOf)).toContainEqual({
      kind: "field",
      entity: "item",
      name: "day",
      via: "aggregate-groupBy",
    });
    // 操作の when が参照する項目も入る
    expect(marks.get("o.closeItem")?.references.map(refOf)).toContainEqual({
      kind: "field",
      entity: "item",
      name: "amount",
      via: "when",
    });
  });

  it("宣言に引き当てられない id は印なし", async () => {
    const app = await normalizedFixture(fixtureYaml({ closeItem: false }));
    const marks = markRows(app, fixtureTable());
    expect(marks.has("o.closeItem")).toBe(false);
    expect(marks.has("o.addItem")).toBe(true);
  });
});

describe("表に無い追加の要素の一覧（D4）", () => {
  it("表の全要素だけの宣言では空", async () => {
    const app = await normalizedFixture(fixtureYaml({ helper: false, validation: false }));
    expect(extraElementsOf(app, fixtureTable())).toEqual([]);
  });

  it("補助の計算を 1 つ足せば、その 1 件（名前・種類・経路）", async () => {
    const app = await normalizedFixture(fixtureYaml({ helper: true, validation: false }));
    expect(extraElementsOf(app, fixtureTable())).toEqual([
      { kind: "computation", entity: null, name: "base", path: "spec.computed[1]" },
    ]);
  });

  it("別 entity の同名の項目は表にあれば出ず、validation は一覧に入る", async () => {
    const app = await normalizedFixture(fixtureYaml({ helper: false, validation: true }));
    const extras = extraElementsOf(app, fixtureTable());
    expect(extras).toEqual([{ kind: "validation", entity: "item", name: "amount", path: "spec.validations[0]" }]);
    expect(extras.some((element) => element.name === "title")).toBe(false);
  });
});

// ── validate の試験が要求する検査の場所と、要る検査の骨組み（Issue #666）──────────────────────────

/** 直す前（69e7b0c）の `bindTestsById`（validate の場所を関数の中で決めていた形）。置き換えが結果を変えないことの照らし合わせ用 */
function bindTestsByIdBefore(app: NormalizedAppSpec, table: NameTable, suite: TestSuite): ReadonlyMap<string, BindResult> {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  const locationOfRow = (row: NameTable["rows"][number]): DeclarationLocation | undefined => {
    let entity: string | null = null;
    if (row.entity !== null) {
      const owner = table.rows.find((candidate) => candidate.id === row.entity && candidate.kind === "entity");
      if (owner === undefined) return undefined;
      entity = owner.name;
    }
    return { kind: declarationKindOfRole(row.kind), entity, name: row.name };
  };
  const bindings = new Map<string, BindResult>();
  for (const test of suite.tests) {
    const roleId = test.target.roleId;
    const row = roleId === undefined ? undefined : rowById.get(roleId);
    if (row === undefined) {
      bindings.set(test.id, { kind: "unbound", testId: test.id, cause: "no-mapping", detail: "試験の対象の ID が名前の表に無い" });
      continue;
    }
    const base = row.kind === test.target.kind ? locationOfRow(row) : undefined;
    let location: DeclarationLocation | undefined = base;
    if (base !== undefined && test.operation === "validate") {
      const entity = row.kind === "entity" ? row.name : base.entity;
      location = { kind: "validation", entity, name: row.name };
    }
    if (location === undefined || !declarationHasLocation(app, location)) {
      bindings.set(test.id, { kind: "unbound", testId: test.id, cause: "no-candidate", detail: "表の ID が指す場所が宣言に無い" });
      continue;
    }
    bindings.set(test.id, { kind: "bound", testId: test.id, location });
  }
  return bindings;
}

const FIXTURE_VALIDATIONS = ["validations:", "  - name: amount", "    entity: item", "    expression: amount > 0"].join("\n");

/** 宣言の検査の欄だけを差し替えた YAML（項目・計算・画面は fixture のまま） */
const withValidations = (...entries: readonly (readonly [name: string, entity: string, expression: string])[]): string => {
  if (FIXTURE_YAML.split(FIXTURE_VALIDATIONS).length !== 2) throw new Error("前提が壊れた：検査の欄が 1 か所でない");
  const section =
    entries.length === 0
      ? "validations: []"
      : ["validations:", ...entries.flatMap(([name, entity, expression]) => [`  - name: ${name}`, `    entity: ${entity}`, `    expression: ${expression}`])].join("\n");
  return FIXTURE_YAML.replace(FIXTURE_VALIDATIONS, section);
};

const CLOCK = "2026-09-16T12:00:00+09:00";

/** 項目 F（f.item.amount）の validate の試験（正常は 5 で通る・異常は -1 で落ちる） */
const validateTest = (id: string, kind: "normal" | "abnormal", roleId = "f.item.amount", requirementId = "R1", targetKind: TestTargetKind = "field"): FixedTest => ({
  id,
  target: { requirementId, kind: targetKind, roleId },
  kind,
  operation: "validate",
  clock: CLOCK,
  input: roleId === "f.item.amount" ? { "f.item.amount": kind === "abnormal" ? -1 : 5 } : {},
  inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
  referenceData: [],
  expected: kind === "abnormal" ? { kind: "error", code: "E_INVALID" } : { kind: "ok", value: true },
});

const observesOf = (suite: TestSuite, overrides: Readonly<Record<string, TestObserves>> = {}): ReadonlyMap<string, TestObserves> =>
  new Map(suite.tests.map((test) => [test.id, overrides[test.id] ?? (test.operation === "validate" ? "validation" : "when")] as const));

/** 鍵の集合（骨組みの 1 件が持つ欄。式・期待・分類・宣言・表の型の写しを持たない） */
const SKELETON_KEYS = ["conflict", "entity", "name", "rowId", "rowKind", "testIds"];

describe("validate の試験が要求する検査の場所（結び付けの契約。Issue #666）", () => {
  it("項目の行 → 所属 entity の名前・項目の名前。entity の行 → entity の名前・entity の名前。表に無い id・種類違い・所属 entity が引けない・validate でない → undefined", () => {
    const table = fixtureTable();
    expect(requiredValidationLocation(table, validateTest("a", "normal"))).toEqual({ kind: "validation", entity: "item", name: "amount" });
    expect(requiredValidationLocation(table, validateTest("e", "normal", "e.item", "R1", "entity"))).toEqual({ kind: "validation", entity: "item", name: "item" });
    expect(requiredValidationLocation(table, validateTest("u", "normal", "f.item.nowhere"))).toBeUndefined();
    expect(requiredValidationLocation(table, validateTest("k", "normal", "f.item.amount", "R1", "entity"))).toBeUndefined();
    const orphan: NameTable = { ...table, rows: table.rows.filter((row) => row.id !== "e.item") };
    expect(requiredValidationLocation(orphan, validateTest("o", "normal"))).toBeUndefined();
    expect(requiredValidationLocation(table, { ...validateTest("c", "normal"), operation: "compute" })).toBeUndefined();
  });

  it("契約試験：新しい関数経由の結び付けは、直す前の結び付けと結果（bound／unbound・cause・location）が深く等しい（別 entity の同名の項目・entity の validate・既定値・種類違い・表に無い id・ほかの操作を含む）", async () => {
    const table = fixtureTable();
    const orphanTable: NameTable = { ...table, rows: table.rows.filter((row) => row.id !== "e.member") };
    const suite = suiteOf(
      validateTest("v-amount", "normal"),
      validateTest("v-amount-bad", "abnormal"),
      validateTest("v-day", "normal", "f.item.day"),
      validateTest("v-member-title", "normal", "f.member.title", "R2"),
      validateTest("v-item-title", "normal", "f.item.title", "R2"),
      validateTest("v-entity", "normal", "e.item", "R1", "entity"),
      validateTest("v-default", "normal", "f.item.kind"),
      validateTest("v-kind-mismatch", "normal", "f.item.amount", "R1", "entity"),
      validateTest("v-unknown", "normal", "f.item.nowhere"),
      fixed("a-close", "R3", "operation", "o.closeItem", "action"),
      fixed("s-items", "R2", "screen", "s.items", "screen"),
      fixed("c-rate", "R4", "computation", "c.rate", "compute"),
    );
    const sources = [
      FIXTURE_YAML,
      withValidations(),
      withValidations(["item", "item", "amount > 0"], ["title", "item", "amount > 0"]),
      withValidations(["title", "member", "1 > 0"], ["day", "item", "amount > 0"], ["kind", "item", "amount > 0"]),
      withValidations(["positive", "item", "amount > 0"]),
    ];
    let bound = 0;
    for (const source of sources) {
      const app = await normalizedFixture(source);
      for (const candidate of [table, orphanTable]) {
        const after = bindTestsById(app, candidate, suite).bindings;
        expect([...after]).toEqual([...bindTestsByIdBefore(app, candidate, suite)]);
        bound += [...after.values()].filter((entry) => entry.kind === "bound" && entry.location.kind === "validation").length;
      }
    }
    // 照らし合わせに validate の bound と unbound の両方が入っている（空の照合で通らない）
    expect(bound).toBeGreaterThan(0);
  });
});

describe("要る検査の骨組み（純粋。Issue #666）", () => {
  const table = fixtureTable();

  it("(1) 同じ項目の validate 試験 2 件 → 1 件（entity・項目名・試験 ID 2）。(2) entity の行の validate → entity 名・entity 名", () => {
    const suite = suiteOf(validateTest("n", "normal"), validateTest("x", "abnormal"), validateTest("e", "normal", "e.item", "R1", "entity"));
    expect(requiredValidationsOf(table, suite, observesOf(suite))).toEqual([
      { entity: "item", name: "item", rowId: "e.item", rowKind: "entity", testIds: ["e"], conflict: false },
      { entity: "item", name: "amount", rowId: "f.item.amount", rowKind: "field", testIds: ["n", "x"], conflict: false },
    ]);
  });

  it("(3) 既定値・選択肢の集合の validate 試験 → 入らない（観測する性質が validation の試験だけ）。ほかの操作も入らない", () => {
    const suite = suiteOf(
      validateTest("d", "normal", "f.item.kind"),
      validateTest("m", "normal", "f.item.kind"),
      fixed("a", "R3", "operation", "o.closeItem", "action"),
      validateTest("n", "normal"),
    );
    const observes = observesOf(suite, { d: "default-value", m: "enum-membership" as TestObserves });
    expect(requiredValidationsOf(table, suite, observes).map((entry) => entry.testIds)).toEqual([["n"]]);
    // 写像に無い試験も入らない
    expect(requiredValidationsOf(table, suite, new Map())).toEqual([]);
  });

  it("(4) 別 entity の同名の項目 → 2 件とも競合の印（entity で区別）。同じ entity の 2 試験なら競合にならない", () => {
    const suite = suiteOf(validateTest("mt", "normal", "f.member.title", "R2"), validateTest("it", "normal", "f.item.title", "R2"), validateTest("it2", "abnormal", "f.item.title", "R2"));
    expect(requiredValidationsOf(table, suite, observesOf(suite))).toEqual([
      { entity: "member", name: "title", rowId: "f.member.title", rowKind: "field", testIds: ["mt"], conflict: true },
      { entity: "item", name: "title", rowId: "f.item.title", rowKind: "field", testIds: ["it", "it2"], conflict: true },
    ]);
    const same = suiteOf(validateTest("it", "normal", "f.item.title", "R2"), validateTest("it2", "abnormal", "f.item.title", "R2"));
    expect(requiredValidationsOf(table, same, observesOf(same)).map((entry) => entry.conflict)).toEqual([false]);
  });

  it("負例：entity の行と同名の項目の行が同じ（entity・名前）を要求する組は、(a) 骨組みの書く要求に載らず (b) 両方の行に競合の印が付き（並びで選ばない）(c) 結び付けの結果は直す前と同じ", async () => {
    const amount = table.rows.find((row) => row.id === "f.item.amount");
    if (amount === undefined) throw new Error("前提が壊れた：項目 amount の行が無い");
    // entity item の中に、entity と同じ名前の項目 item の行を足した表
    const same: NameTable = { ...table, rows: [...table.rows, { ...amount, id: "f.item.item", name: "item" }] };
    const suite = suiteOf(
      validateTest("ef", "normal", "f.item.item"),
      validateTest("ee", "normal", "e.item", "R1", "entity"),
      validateTest("ee2", "abnormal", "e.item", "R1", "entity"),
    );
    expect(requiredValidationLocation(same, suite.tests[0]!)).toEqual(requiredValidationLocation(same, suite.tests[1]!));
    const skeleton = requiredValidationsOf(same, suite, observesOf(suite));
    // (a) 書く要求（競合なし）の件は無い
    expect(skeleton.filter((entry) => !entry.conflict)).toEqual([]);
    // (b) 行ごとに 1 件ずつ、両方に競合の印（表の行の順。どちらも選ばない）
    expect(skeleton).toEqual([
      { entity: "item", name: "item", rowId: "e.item", rowKind: "entity", testIds: ["ee", "ee2"], conflict: true },
      { entity: "item", name: "item", rowId: "f.item.item", rowKind: "field", testIds: ["ef"], conflict: true },
    ]);
    // 片方の行の試験だけなら競合にならない
    const entityOnly = suiteOf(...suite.tests.filter((test) => test.target.roleId === "e.item"));
    expect(requiredValidationsOf(same, entityOnly, observesOf(entityOnly)).map((entry) => entry.conflict)).toEqual([false]);
    // (c) 結び付けの結果は直す前と同じ（検査 item が在る版・無い版）
    for (const source of [withValidations(["item", "item", "amount > 0"]), withValidations()]) {
      const app = await normalizedFixture(source);
      expect([...bindTestsById(app, same, suite).bindings]).toEqual([...bindTestsByIdBefore(app, same, suite)]);
    }
  });

  it("(5) 棄却で外れた試験の分は入らない（呼ぶ側が評価の文脈と同じ組を渡す）。並びは表の行の順", () => {
    const suite = suiteOf(validateTest("x", "abnormal"), validateTest("t", "normal", "f.item.title", "R1"), validateTest("n", "normal"));
    const all = requiredValidationsOf(table, suite, observesOf(suite));
    expect(all.map((entry) => entry.name)).toEqual(["title", "amount"]);
    const afterOverturn = suiteOf(...suite.tests.filter((test) => test.id !== "t"));
    expect(requiredValidationsOf(table, afterOverturn, observesOf(suite))).toEqual([
      { entity: "item", name: "amount", rowId: "f.item.amount", rowKind: "field", testIds: ["x", "n"], conflict: false },
    ]);
  });

  it("(6) 同じ入力から 2 回同じ。鍵の集合は固定で、期待・式・分類・宣言・表の型の鍵が無い（g：型の制約は混ざらない）", () => {
    const suite = suiteOf(validateTest("n", "normal"), validateTest("x", "abnormal"), validateTest("o", "normal", "f.item.owner"), validateTest("k", "normal", "f.item.kind"));
    const first = requiredValidationsOf(table, suite, observesOf(suite));
    expect(requiredValidationsOf(table, suite, observesOf(suite))).toEqual(first);
    for (const entry of first) expect(Object.keys(entry).sort()).toEqual(SKELETON_KEYS);
    const text = JSON.stringify(first);
    for (const word of ["expected", "expression", "nature", "classification", "type", "options", "refEntity", "declaration", "E_INVALID", "alpha", "member"]) {
      expect(text).not.toContain(word);
    }
  });

  it("(h) 宣言に依らない：骨組みは組と表だけで決まり（宣言を受け取らない）、項目が既に在る版の結び付けの場所と同じ場所を指す。検査の無い版でも骨組みは同じ", async () => {
    const suite = suiteOf(validateTest("n", "normal"), validateTest("x", "abnormal"));
    expect(requiredValidationsOf.length).toBe(3);
    const skeleton = requiredValidationsOf(table, suite, observesOf(suite));
    const [entry] = skeleton;
    const withCheck = bindTestsById(await normalizedFixture(FIXTURE_YAML), table, suite).bindings;
    expect(withCheck.get("n")).toEqual({ kind: "bound", testId: "n", location: { kind: "validation", entity: entry?.entity, name: entry?.name } });
    const withoutCheck = bindTestsById(await normalizedFixture(withValidations()), table, suite).bindings;
    expect(withoutCheck.get("n")).toMatchObject({ kind: "unbound", cause: "no-candidate" });
    expect(requiredValidationsOf(table, suite, observesOf(suite))).toEqual(skeleton);
  });
});

describe("二点測定（原因 1 の台本）：骨組みの検査の場所と名前で書けば結び付き、名前が違えば今までどおり不一致（結び直さない。Issue #666）", () => {
  const table = fixtureTable();
  const suite = suiteOf(validateTest("f-normal", "normal"), validateTest("f-abnormal", "abnormal"));
  const observes = observesOf(suite);
  const list = { ...fixtureList(), requirements: fixtureList().requirements.filter((requirement) => requirement.id === "R1") };

  /** 宣言を B4（評価口の runTests）に掛け、試験ごとの結び付けと不一致を返す */
  async function evaluate(source: string) {
    const app = await normalizedFixture(source);
    const r1Table = { ...table, ownership: table.ownership.filter((entry) => entry.requirementId === "R1") };
    const context = { list, suite, correspondences: correspondenceFromTable(r1Table), ownership: toV1(r1Table).ownership };
    const evaluator = createV11aEvaluator({ table, observes });
    const checked = evaluator.nameCheck(app, context);
    const report = evaluator.runTests(app, context, { entries: checked.entries, misses: checked.misses });
    const bindings = bindTestsById(app, table, suite).bindings;
    return { bindings, mismatches: report.mismatches.map((entry) => entry.testId), unresolved: report.unresolved.map((entry) => entry.testId) };
  }

  it("骨組みは 1 件（item・amount・試験 2 件・競合なし）", () => {
    expect(requiredValidationsOf(table, suite, observes)).toEqual([
      { entity: "item", name: "amount", rowId: "f.item.amount", rowKind: "field", testIds: ["f-normal", "f-abnormal"], conflict: false },
    ]);
  });

  it("(a) 宣言の検査の名前が F で同じ entity → bound、B4 が式を評価し、式が期待どおりなら不一致 0", async () => {
    const result = await evaluate(withValidations(["amount", "item", "amount > 0"]));
    for (const id of ["f-normal", "f-abnormal"]) {
      expect(result.bindings.get(id)).toEqual({ kind: "bound", testId: id, location: { kind: "validation", entity: "item", name: "amount" } });
    }
    expect(result.mismatches).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("(i) 骨組みの検査を書いても式が逆（正常を落とす）なら B4 で不一致", async () => {
    const result = await evaluate(withValidations(["amount", "item", "amount <= 0"]));
    expect(result.bindings.get("f-normal")?.kind).toBe("bound");
    expect(result.mismatches).toEqual(["f-normal", "f-abnormal"]);
  });

  const unboundCases = [
    { name: "(b) 同じ式で名前だけ別", source: () => withValidations(["positive", "item", "amount > 0"]) },
    { name: "(c) 検査 0", source: () => withValidations() },
    { name: "(d)(f) 骨組みの名前を持つが別 entity に書いた検査", source: () => withValidations(["amount", "member", "1 > 0"]) },
    { name: "(e) 同じ項目を参照する別名の 2 検査", source: () => withValidations(["positive", "item", "amount > 0"], ["nonzero", "item", "amount != 0"]) },
  ];
  it.each(unboundCases)("$name → 今までどおり no-candidate の不一致（直す前も後も同じ。結び直さない）。骨組みは 1 件のまま", async ({ source }) => {
    const text = source();
    const result = await evaluate(text);
    const app = await normalizedFixture(text);
    for (const id of ["f-normal", "f-abnormal"]) {
      expect(result.bindings.get(id)).toMatchObject({ kind: "unbound", cause: "no-candidate" });
      expect(bindTestsByIdBefore(app, table, suite).get(id)).toEqual(result.bindings.get(id));
    }
    expect(result.mismatches).toEqual(["f-normal", "f-abnormal"]);
    expect(requiredValidationsOf(table, suite, observes)).toHaveLength(1);
  });

  it("(k) 競合の 2 件を両方書いた宣言は静的チェックの同名の重複で落ちる。片方だけ書けばその 1 件が結び付き、もう片方は不一致のまま（自動で選ばない）", async () => {
    const titles = suiteOf(validateTest("mt", "normal", "f.member.title", "R2"), validateTest("it", "normal", "f.item.title", "R2"));
    expect(requiredValidationsOf(table, titles, observesOf(titles)).map((entry) => entry.conflict)).toEqual([true, true]);
    const both = await normalizeSpec(withValidations(["title", "member", "1 > 0"], ["title", "item", "amount > 0"]));
    expect(both.ok).toBe(false);
    if (both.ok) return;
    expect(both.diagnostics.map((diagnostic) => diagnostic.code)).toContain("LOGIC_VALIDATION_DUPLICATE_NAME");
    const one = bindTestsById(await normalizedFixture(withValidations(["title", "item", "amount > 0"])), table, titles).bindings;
    expect(one.get("it")).toEqual({ kind: "bound", testId: "it", location: { kind: "validation", entity: "item", name: "title" } });
    expect(one.get("mt")).toMatchObject({ kind: "unbound", cause: "no-candidate" });
  });

  it("この手で直したファイル（結び付けの契約・B1・直す段・走らせる部分・呼び出し数の契約・fixture とその試験。cli.test.ts は走査の語の並びを持つので除く）に受入の題材の言葉が無い（走査）", async () => {
    const fs = (await import(/* @vite-ignore */ "node:fs")) as { readFileSync(path: URL, encoding: "utf8"): string };
    const files = [
      "./bind-by-id.ts",
      "./bind-by-id.test.ts",
      "./stages/write.ts",
      "./stages/write.test.ts",
      "../stages/repair.ts",
      "../stages/repair.test.ts",
      "./run.ts",
      "./run.test.ts",
      "./calls.test.ts",
      "./__tests__/fixtures.ts",
    ];
    expectNoAcceptanceMaterial(files.map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});
