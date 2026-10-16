// 表の `id` による結び付け・印・追加の要素（v11a/bind-by-id.ts）の unit テスト
// （07-architecture-v1.1a.md §1.1・§2.1・D4・D11。Issue #505）。
import { describe, expect, it } from "vitest";
import type { FixedTest, TestOperation, TestSuite, TestTargetKind } from "../fixed-test.js";
import { bindTests } from "../stages/bind.js";
import { fixtureTable, fixtureYaml, normalizedFixture } from "./__tests__/fixtures.js";
import {
  bindTestsById,
  correspondenceFromTable,
  extraElementsOf,
  markRows,
  type MarkReference,
} from "./bind-by-id.js";
import { identityMappings } from "./convert.js";

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
