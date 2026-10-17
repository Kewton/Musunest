// B3 名前の照合（v11a/name-check.ts）の試験（07-architecture-v1.1a.md §1 の表・§1.2・§2.1・§2.2。Issue #510）。
//
// LLM を呼ばない純粋な関数の試験。題材は v1.1α の共通の題材（担当者と項目。`__tests__/fixtures.ts`）。宣言か表の
// 片方だけを 1 か所変えて、落ちが出ること・その落ちの場所と要件 ID を確かめる。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequirementList } from "../pipeline.js";
import * as correspondenceStage from "../stages/correspondence.js";
import { FIXTURE_YAML, fixtureList, fixtureTable, normalizedFixture, withAggregates } from "./__tests__/fixtures.js";
import { checkNames, nameCheckScope } from "./name-check.js";
import type { NameTable, NameTableRow } from "./names.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 持ち越し（R5 は書けない要件）を除いた一覧 */
const listWithout = (...ids: readonly string[]): RequirementList => ({
  ...fixtureList(),
  requirements: fixtureList().requirements.filter((requirement) => !["R5", ...ids].includes(requirement.id)),
});
const LIST = listWithout();
const TABLE = fixtureTable();

/** 項目の一覧に R1 の所属の項目を全部出した宣言（正例） */
const YAML = FIXTURE_YAML.replace("show: [title, amount, kind]", "show: [title, owner, amount, day, kind]");

function replaced(source: string, from: string, to: string): string {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
}

/** 表の 1 行を差し替える */
function withRow(id: string, patch: Partial<NameTableRow>): NameTable {
  const table = fixtureTable();
  expect(table.rows.some((row) => row.id === id)).toBe(true);
  return { ...table, rows: table.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) };
}

async function check(source: string, table: NameTable = TABLE, list: RequirementList = LIST) {
  const app = await normalizedFixture(source);
  return checkNames({ app, table, list });
}

const located = (misses: readonly { location?: { kind: string; entity: string | null; name: string } }[]) =>
  misses.map((miss) => miss.location);

describe("正例", () => {
  it("表どおりの宣言は落ち 0。導いた対応表は一覧の要件だけ", async () => {
    const result = await check(YAML);
    expect(result.misses).toEqual([]);
    expect(result.entries.map((entry) => entry.requirementId)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(result.excludedRowIds).toEqual([]);
  });

  it("⑤a の LLM（runCorrespondence）を呼ばない", async () => {
    const spy = vi.spyOn(correspondenceStage, "runCorrespondence");
    await check(YAML);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("負例（v1 の検査が効く欄）", () => {
  it("実在しない名前：表の操作 closeItem が宣言に無い", async () => {
    const source = replaced(
      YAML,
      "  - name: closeItem\n    entity: item\n    kind: update\n    set:\n      kind: beta\n    when: amount > 0\n",
      "",
    );
    const result = await check(source);
    expect(located(result.misses)).toContainEqual({ kind: "action", entity: "item", name: "closeItem" });
    expect(result.misses.find((miss) => miss.location?.name === "closeItem")?.requirementId).toBe("R3");
  });

  it("種類違い：表の操作の名前が、宣言では同じ entity の項目の名前", async () => {
    const result = await check(YAML, withRow("o.closeItem", { name: "amount" }));
    const miss = result.misses.find((entry) => entry.location?.kind === "action" && entry.location.name === "amount");
    expect(miss?.detail).toContain("field");
    expect(miss?.requirementId).toBe("R3");
  });

  it("別 entity の同名へ向けた項目：表の担当者の題名（member.title）が宣言に無く、項目の題名（item.title）だけがある", async () => {
    const source = replaced(
      replaced(YAML, "  - name: member\n    fields:\n      title:\n", "  - name: member\n    fields:\n      label:\n"),
      "show: [title, itemCount]",
      "show: [label, itemCount]",
    );
    const result = await check(source);
    expect(located(result.misses)).toContainEqual({ kind: "field", entity: "member", name: "title" });
    expect(located(result.misses)).not.toContainEqual({ kind: "field", entity: "item", name: "title" });
  });

  it("画面から辿れない：項目の一覧に出していない項目（owner・day）", async () => {
    const result = await check(FIXTURE_YAML);
    const unreachable = result.misses.filter((miss) => miss.detail.includes("画面から辿れない"));
    expect(located(unreachable)).toEqual(
      expect.arrayContaining([
        { kind: "field", entity: "item", name: "owner" },
        { kind: "field", entity: "item", name: "day" },
      ]),
    );
    expect(unreachable.every((miss) => miss.requirementId === "R1")).toBe(true);
    expect(unreachable).toHaveLength(2);
  });

  it("options の順違い：宣言の選択肢が beta・alpha の順", async () => {
    const source = replaced(YAML, "          alpha: アルファ\n          beta: ベータ\n", "          beta: ベータ\n          alpha: アルファ\n");
    const result = await check(source);
    expect(located(result.misses)).toContainEqual({ kind: "field", entity: "item", name: "kind" });
  });
});

describe("負例（v1.1α が足す検査）", () => {
  it("項目の型違い：担当者の題名を number で宣言", async () => {
    const source = replaced(
      YAML,
      "  - name: member\n    fields:\n      title:\n        type: string\n",
      "  - name: member\n    fields:\n      title:\n        type: number\n",
    );
    const result = await check(source);
    const miss = result.misses.find((entry) => entry.location?.entity === "member" && entry.location.name === "title");
    expect(miss?.detail).toContain("型");
    expect(miss?.requirementId).toBe("R2");
  });

  it("ref の参照先 entity 違い：表は項目への参照、宣言は担当者への参照", async () => {
    const result = await check(YAML, withRow("f.item.owner", { refEntity: "e.item" }));
    const miss = result.misses.find((entry) => entry.location?.name === "owner");
    expect(miss?.detail).toContain("参照先");
    expect(miss?.requirementId).toBe("R1");
  });

  it("計算の値の型違い（number と boolean）", async () => {
    const result = await check(YAML, withRow("c.rate", { type: { valueType: "boolean", scope: "app", form: "expression" } }));
    expect(result.misses.map((miss) => miss.detail)).toContainEqual(expect.stringContaining("値の型"));
  });

  it("計算の範囲違い（行ごとと app）", async () => {
    const result = await check(YAML, withRow("c.rate", { type: { valueType: "number", scope: "row", form: "expression" } }));
    expect(result.misses.map((miss) => miss.detail)).toContainEqual(expect.stringContaining("範囲"));
  });

  it("計算の種別違い（式と集計）", async () => {
    const result = await check(YAML, withRow("c.rate", { type: { valueType: "number", scope: "app", form: "aggregate" } }));
    expect(result.misses.map((miss) => miss.detail)).toContainEqual(expect.stringContaining("種別"));
  });

  it("操作の種類違いと when の有無", async () => {
    const kind = await check(YAML, withRow("o.closeItem", { type: { action: "delete", hasWhen: true } }));
    expect(kind.misses.map((miss) => miss.detail)).toContainEqual(expect.stringContaining("種類"));
    const when = await check(YAML, withRow("o.closeItem", { type: { action: "update", hasWhen: false } }));
    expect(when.misses.map((miss) => miss.detail)).toContainEqual(expect.stringContaining("when"));
    const noWhen = await check(replaced(YAML, "    when: amount > 0\n", ""));
    expect(noWhen.misses.map((miss) => miss.detail)).toContainEqual(expect.stringContaining("when"));
  });

  it("画面の種類違い", async () => {
    const result = await check(YAML, withRow("s.items", { type: { view: "list" } }));
    const miss = result.misses.find((entry) => entry.location?.kind === "view" && entry.location.name === "items");
    expect(miss?.detail).toContain("種類");
  });
});

describe("月の見出し（集計元 entity・項目・month の組）", () => {
  /** 担当者にも同名の日付の項目 day を持たせた宣言 */
  const withMemberDay = (source: string): string =>
    replaced(source, "      title:\n        type: string\n  - name: item\n", "      title:\n        type: string\n      day:\n        type: date\n  - name: item\n");

  it("正例：項目の entity の day を月で分ける宣言は落ちない", async () => {
    const result = await check(withMemberDay(YAML));
    expect(result.misses).toEqual([]);
  });

  it("負例：別 entity（担当者）の同名の date 項目へ向けた宣言が落ちる", async () => {
    const source = replaced(
      withMemberDay(YAML),
      "      sum: item.amount\n      groupBy:\n        month: item.day\n",
      "      count: member\n      groupBy:\n        month: member.day\n",
    );
    const result = await check(source);
    const miss = result.misses.find((entry) => entry.location?.name === "byMonth");
    expect(miss?.detail).toContain("月の見出し");
    expect(miss?.requirementId).toBe("R4");
  });

  it("負例：月でなく値ごとに分ける宣言が落ちる", async () => {
    const result = await check(YAML, withRow("c.byMonth", { groupBy: { kind: "month", field: "f.item.kind" } }));
    expect(result.misses.find((entry) => entry.location?.name === "byMonth")?.detail).toContain("月の見出し");
  });
});

describe("持ち越しで除く範囲（D14）", () => {
  const withoutClose = replaced(
    YAML,
    "  - name: closeItem\n    entity: item\n    kind: update\n    set:\n      kind: beta\n    when: amount > 0\n",
    "",
  );

  it("持ち越した要件（R3）だけの行（操作 closeItem）は検査されない", async () => {
    const kept = await check(withoutClose);
    expect(located(kept.misses)).toContainEqual({ kind: "action", entity: "item", name: "closeItem" });
    const carried = await check(withoutClose, TABLE, listWithout("R3"));
    expect(carried.misses).toEqual([]);
    expect(carried.excludedRowIds).toContain("o.closeItem");
    expect(carried.checkedRowIds).not.toContain("o.closeItem");
  });

  it("共有する行（金額。R1 と R3）は検査される", async () => {
    const table = withRow("f.item.amount", { type: "string" });
    const carried = await check(YAML, table, listWithout("R3"));
    expect(carried.checkedRowIds).toContain("f.item.amount");
    const miss = carried.misses.find((entry) => entry.location?.name === "amount");
    expect(miss?.requirementId).toBe("R1");
  });

  it("除く行を渡せば、一覧に所属させる要件があっても除く。範囲は表の順", () => {
    const scope = nameCheckScope(TABLE, LIST, ["s.overview"]);
    expect(scope.excludedRowIds).toEqual(["s.overview"]);
    expect(scope.table.rows.map((row) => row.id)).not.toContain("s.overview");
    expect(scope.table.ownership.map((entry) => entry.requirementId)).toEqual(["R1", "R2", "R3", "R4"]);
  });
});

describe("構成上つねに通る検査（1. 提出漏れ・3. 対応表の内側）", () => {
  it("対応の提出漏れ・対応表の外の落ちは出ない（表から恒等に導くので自己照合）", async () => {
    const result = await check(YAML);
    expect(result.misses.some((miss) => miss.detail.includes("提出されていない"))).toBe(false);
    expect(result.misses.some((miss) => miss.detail.includes("対応表に"))).toBe(false);
  });
});

describe("集計の種類と集計元（表の計算の行が aggregate を持つとき＝旗 on で台帳が集計の種類を持つ走り。Issue #549）", () => {
  /** 行ごとの件数（itemCount）を合計に替えた宣言 */
  const SUM_ITEM_COUNT = replaced(YAML, "    aggregate:\n      count: item\n      where:\n        owner: this\n", "    aggregate:\n      sum: item.amount\n      where:\n        owner: this\n");
  const details = (misses: readonly { detail: string }[]) => misses.map((miss) => miss.detail);

  it("正例：宣言の集計の種類と集計元が表の行のとおりなら落ち 0（行ごと・見出しごと enum・月）", async () => {
    expect((await check(YAML, withAggregates(TABLE))).misses).toEqual([]);
  });

  it("負例：宣言の集計の種類が表と違うと落ちる（固定の文の形・行き先は ⑥）", async () => {
    const result = await check(SUM_ITEM_COUNT, withAggregates(TABLE));
    expect(details(result.misses)).toEqual(["計算 itemCount の集計の種類が sum（表は count）"]);
    expect((result.misses[0] as { readonly route?: string } | undefined)?.route).toBe("missing-element");
    expect(result.misses[0]?.requirementId).toBe("R2");
    // 表の側の種類だけを替えても落ちる（見出しごとの集計）
    const byKind = await check(YAML, withAggregates(TABLE, { "c.byKind": { kind: "avg", entity: "e.item" } }));
    expect(details(byKind.misses)).toEqual(["計算 byKind の集計の種類が count（表は avg）"]);
  });

  it("負例：宣言の集計元の entity が表と違うと落ちる", async () => {
    const result = await check(YAML, withAggregates(TABLE, { "c.itemCount": { kind: "count", entity: "e.member" } }));
    expect(details(result.misses)).toEqual(["計算 itemCount の集計元が item（表は member）"]);
  });

  it("旗 off（表の計算の行に aggregate が無い）では見ない：種類の違う宣言も今までどおり落ちない", async () => {
    expect((await check(SUM_ITEM_COUNT, TABLE)).misses).toEqual([]);
    // 二点測定：同じ宣言を、aggregate を持つ表で照らすと落ちる
    expect((await check(SUM_ITEM_COUNT, withAggregates(TABLE))).misses).toHaveLength(1);
  });

  it("今の型・範囲・種別・月の見出しの照合は変えない（aggregate を持つ表でも同じ落ち）", async () => {
    const plain = await check(YAML, withRow("c.itemCount", { type: { valueType: "boolean", scope: "row", form: "aggregate" } }));
    const withAggregate = await check(
      YAML,
      withAggregates({ ...TABLE, rows: TABLE.rows.map((row) => (row.id === "c.itemCount" ? { ...row, type: { valueType: "boolean" as const, scope: "row" as const, form: "aggregate" as const } } : row)) }),
    );
    expect(details(withAggregate.misses)).toEqual(details(plain.misses));
    expect(details(plain.misses).length).toBeGreaterThan(0);
  });
});
