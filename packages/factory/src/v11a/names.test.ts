// 名前の表（v11a/names.ts）の unit テスト（07-architecture-v1.1a.md §2.1・D1・D3・D9・D10。Issue #505）。
//
// 固定したいのは 4 つ。
//   1. 正例の表は問題 0（別 entity の同名の項目は通る）
//   2. 負例のそれぞれが、位置（`field`）と固定文（`message`）の問題になり、値を埋めない
//   3. 導く欄：entity の所属は basis `dependency`・reason に導いた行の `id`、`shared` は所属 2 以上だけ
//   4. 表の SHA-256 は決定的で、行の順と分類で変わる
import { describe, expect, it } from "vitest";
import type { Problem } from "../stages/prompt.js";
import type { RequirementList } from "../pipeline.js";
import {
  FIXTURE_CONSTRAINT_ID,
  FIXTURE_DOCUMENTS,
  draftOf,
  fixtureList,
  fixtureRows,
  fixtureTable,
} from "./__tests__/fixtures.js";
import {
  MIN_COPY_LENGTH,
  checkNameTable,
  checkNameTableDraftShape,
  copyLengthFor,
  deriveOwnership,
  inspectNameTable,
  nameTableSha256,
  requirementCopy,
  resolveNameTableDraft,
  sharedRowIds,
  sourcePositionOf,
  type NameTable,
  type NameTableRow,
} from "./names.js";

const list = fixtureList();

/** 表の値（要件 ID・表の ID・名前）を問題の欄と文に埋めていないこと */
function expectNoValues(problems: readonly Problem[], extra: readonly string[] = []): void {
  const forbidden = [
    ...list.requirements.map((requirement) => requirement.id),
    ...fixtureRows().map((row) => row.id),
    ...extra,
  ];
  for (const problem of problems) {
    for (const value of forbidden) {
      expect(problem.field.includes(value), `${problem.field} に ${value}`).toBe(false);
      expect(problem.message.includes(value), `${problem.message} に ${value}`).toBe(false);
    }
  }
}

/** 表を書き換えて検査し、名指しの問題があることと値を埋めないことを確かめる */
function expectProblem(
  table: NameTable,
  field: string,
  message: string,
  extra: readonly string[] = [],
  against: RequirementList = list,
): readonly Problem[] {
  const problems = checkNameTable(against, table, FIXTURE_DOCUMENTS);
  expect(problems).toContainEqual({ field, message });
  expectNoValues(problems, extra);
  return problems;
}

const withRows = (table: NameTable, rows: readonly NameTableRow[]): NameTable => ({ ...table, rows });
const patchRow = (table: NameTable, index: number, patch: Partial<NameTableRow>): NameTable =>
  withRows(
    table,
    table.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)),
  );
const rowIndex = (id: string): number => fixtureRows().findIndex((row) => row.id === id);

describe("正例の表は問題 0（07 §2.1）", () => {
  it("fixture の表は問題 0 で、別 entity の同名の項目（member.title と item.title）は通る", () => {
    const table = fixtureTable();
    const titles = table.rows.filter((row) => row.kind === "field" && row.name === "title");
    expect(titles.map((row) => row.entity)).toEqual(["e.member", "e.item"]);
    expect(checkNameTable(list, table, FIXTURE_DOCUMENTS)).toEqual([]);
  });

  it("T1 の応答の形（下書き）から、一覧の順で要件 ID を付けると fixture の表に戻る", () => {
    const result = inspectNameTable(list, draftOf(list, fixtureTable()), FIXTURE_DOCUMENTS);
    expect(result).toEqual({ ok: true, table: fixtureTable() });
  });

  it("出典の引用の位置はコードが要件の文から求める", () => {
    const row = fixtureTable().rows[rowIndex("f.item.amount")];
    expect(row).toBeDefined();
    const position = sourcePositionOf(list, row!.source);
    const text = list.requirements[0]!.text;
    expect(position).not.toBeNull();
    expect(text.slice(position!.start, position!.end)).toBe("金額");
  });
});

describe("負例は固定文の問題になる（値を埋めない。07 §2.1）", () => {
  it("id の重複", () => {
    const table = patchRow(fixtureTable(), rowIndex("f.item.title"), { id: "f.member.title" });
    expectProblem(table, `rows[${rowIndex("f.item.title")}].id`, "表の ID が重なっている");
  });

  it("予約語の名前", () => {
    const at = rowIndex("f.item.day");
    expectProblem(patchRow(fixtureTable(), at, { name: "createdAt" }), `rows[${at}].name`, "名前が予約語である", ["createdAt"]);
  });

  it("規則に合わない名前", () => {
    const at = rowIndex("f.item.day");
    expectProblem(
      patchRow(fixtureTable(), at, { name: "zz_bad" }),
      `rows[${at}].name`,
      "名前が規則（英字で始まる英数字）に合わない",
      ["zz_bad"],
    );
  });

  it("同じ名前空間の同名（entity は全体）", () => {
    const at = rowIndex("e.item");
    expectProblem(patchRow(fixtureTable(), at, { name: "member" }), `rows[${at}].name`, "同じ名前空間に同じ名前の行がある");
  });

  it("同じ名前空間の同名（同じ entity の項目）", () => {
    const at = rowIndex("f.item.day");
    expectProblem(patchRow(fixtureTable(), at, { name: "amount" }), `rows[${at}].name`, "同じ名前空間に同じ名前の行がある");
  });

  it("同じ entity の中で計算と項目が同じ名前なら落ちる（窓口の判断・PR #515）", () => {
    const at = rowIndex("c.itemCount");
    // member に項目 title があるので、member の計算 title は重なる
    expectProblem(
      patchRow(fixtureTable(), at, { name: "title" }),
      `rows[${at}].name`,
      "計算の名前が同じ entity の項目の名前と重なっている",
    );
  });

  it("別 entity の項目と同じ名前の計算は通る（正例）", () => {
    const at = rowIndex("c.itemCount");
    // amount は item の項目で、計算は member のもの
    expect(checkNameTable(list, patchRow(fixtureTable(), at, { name: "amount" }), FIXTURE_DOCUMENTS)).toEqual([]);
  });

  it("同じ場所（種類・entity・名前）を指す 2 つの id は落ちる（別名を書けない）", () => {
    const base = fixtureTable();
    const alias = { ...base.rows[rowIndex("c.itemCount")]!, id: "c.itemCountAlias" };
    const table: NameTable = {
      ...withRows(base, [...base.rows, alias]),
      ownership: base.ownership.map((entry) =>
        entry.requirementId === "R2"
          ? { ...entry, roles: [...entry.roles, { id: "c.itemCountAlias", basis: "stated" as const, reason: null }] }
          : entry,
      ),
    };
    expectProblem(
      table,
      `rows[${base.rows.length}]`,
      "同じ場所（種類・entity・名前）を指す ID が 2 つある（別名は書けない）",
      ["c.itemCountAlias"],
    );
  });

  it("無い entity", () => {
    const at = rowIndex("f.item.amount");
    expectProblem(
      patchRow(fixtureTable(), at, { entity: "e.nothing" }),
      `rows[${at}].entity`,
      "所属 entity の ID が表の entity の行に無い",
      ["e.nothing"],
    );
  });

  it("無い groupBy.field", () => {
    const at = rowIndex("c.byKind");
    expectProblem(
      patchRow(fixtureTable(), at, { groupBy: { kind: "enum", field: "f.nothing" } }),
      `rows[${at}].groupBy.field`,
      "見出しの元の項目の ID が表の項目の行に無い",
      ["f.nothing"],
    );
  });

  it("無い refEntity", () => {
    const at = rowIndex("f.item.owner");
    expectProblem(
      patchRow(fixtureTable(), at, { refEntity: "e.nothing" }),
      `rows[${at}].refEntity`,
      "参照先の ID が表の entity の行に無い",
      ["e.nothing"],
    );
  });

  it("enum の groupBy の先に options が無い", () => {
    const at = rowIndex("c.byKind");
    expectProblem(
      patchRow(fixtureTable(), at, { groupBy: { kind: "enum", field: "f.item.title" } }),
      `rows[${at}].groupBy.field`,
      "見出しの元の項目に選択肢（options）が無い",
    );
  });

  it("month の groupBy の先が date でない", () => {
    const at = rowIndex("c.byMonth");
    expectProblem(
      patchRow(fixtureTable(), at, { groupBy: { kind: "month", field: "f.item.amount" } }),
      `rows[${at}].groupBy.field`,
      "月の見出しの元の項目が日付（date）でない",
    );
  });

  it("fixed-test の要件に所属が無い", () => {
    const base = fixtureTable();
    const table: NameTable = {
      ...base,
      ownership: base.ownership.map((entry) => (entry.requirementId === "R3" ? { ...entry, roles: [] } : entry)),
    };
    expectProblem(table, "verification[2]", "固定した試験で確かめる要件に所属が無い");
  });

  it("structural の checks に合う種類の所属が無い", () => {
    const base = fixtureTable();
    const table: NameTable = {
      ...base,
      verification: base.verification.map((entry) =>
        entry.requirementId === "R2" && entry.kind === "structural"
          ? { ...entry, checks: ["view-shows", "action-kind"] }
          : entry,
      ),
    };
    expectProblem(table, "verification[1].checks[1]", "checks の検査に合う種類の所属が無い");
  });

  it("unresolved に制約 ID が無い", () => {
    const base = fixtureTable();
    const table: NameTable = {
      ...base,
      verification: base.verification.map((entry) =>
        entry.kind === "unresolved" ? { ...entry, constraintIds: [] } : entry,
      ),
    };
    expectProblem(table, "verification[4].constraintIds", "未解決の要件に制約 ID が無い");
  });

  it("unresolved の制約 ID が文書に無い", () => {
    const base = fixtureTable();
    const table: NameTable = {
      ...base,
      verification: base.verification.map((entry) =>
        entry.kind === "unresolved" ? { ...entry, constraintIds: ["文書に無い制約"] } : entry,
      ),
    };
    expectProblem(table, "verification[4].constraintIds[0]", "制約 ID が文書に無い", ["文書に無い制約"]);
    // 文書にある ID は通る（正例の対照）
    expect(FIXTURE_CONSTRAINT_ID).toBe("外部への通知");
  });

  it("どの要件にも所属しない行", () => {
    const base = fixtureTable();
    const orphan: NameTableRow = { ...base.rows[rowIndex("f.item.day")]!, id: "f.item.note", name: "note" };
    expectProblem(withRows(base, [...base.rows, orphan]), `rows[${base.rows.length}]`, "どの要件にも所属しない行がある", [
      "f.item.note",
    ]);
  });

  it("分類が欠けた要件", () => {
    const base = fixtureTable();
    const table: NameTable = {
      ...base,
      classification: base.classification.filter((entry) => entry.requirementId !== "R3"),
    };
    expectProblem(table, "requirements[2]", "要件の分類が無い");
  });

  it("重複した分類", () => {
    const base = fixtureTable();
    const table: NameTable = {
      ...base,
      classification: [...base.classification, { requirementId: "R1", nature: "existence-only" }],
    };
    expectProblem(table, "classification[5].requirementId", "同じ要件の項目が重なっている");
  });

  it("未知の分類の値", () => {
    const base = fixtureTable();
    const table = {
      ...base,
      classification: base.classification.map((entry, index) =>
        index === 0 ? { ...entry, nature: "maybe" } : entry,
      ),
    } as unknown as NameTable;
    expectProblem(table, "classification[0].nature", "分類の値は ruled・existence-only のいずれかであること", ["maybe"]);
  });
});

describe("要件 ID は一覧の順でコードが付け、写しと照合する（D10）", () => {
  it("写しの長さは一覧の中で一意になる長さ（最短は MIN_COPY_LENGTH）", () => {
    expect(copyLengthFor(list)).toBe(MIN_COPY_LENGTH);
    const sharedHead: RequirementList = {
      ...list,
      requirements: [
        { ...list.requirements[0]!, text: "共通の長い先頭の文がここまで続き、そのあと一つ目" },
        { ...list.requirements[1]!, text: "共通の長い先頭の文がここまで続き、そのあと二つ目" },
      ],
    };
    const length = copyLengthFor(sharedHead);
    expect(length).toBe(Array.from("共通の長い先頭の文がここまで続き、そのあと").length + 1);
    const copies = sharedHead.requirements.map((requirement) => requirementCopy(requirement.text, length!));
    expect(new Set(copies).size).toBe(2);
  });

  it("要件の文の写しが一覧の順と合わない（入れ替え）と落ちる", () => {
    const draft = draftOf(list, fixtureTable());
    const [first, second, ...rest] = draft.requirements;
    const swapped = { ...draft, requirements: [second!, first!, ...rest] };
    const result = resolveNameTableDraft(list, swapped);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual({
      field: "requirements[0].copy",
      message: "要件の文の写しが一覧の同じ位置の要件と合わない",
    });
    expectNoValues(result.problems);
  });

  it("写しが一意にならない長さ（指示より短い）だと落ちる", () => {
    const sharedHead: RequirementList = {
      ...list,
      requirements: list.requirements.map((requirement, index) =>
        index < 2 ? { ...requirement, text: `共通の長い先頭の文が続く${requirement.text}` } : requirement,
      ),
    };
    const table: NameTable = {
      ...fixtureTable(),
      rows: fixtureTable().rows.map((row) => ({ ...row, source: { ...row.source, quote: "共通" } })),
    };
    const draft = draftOf(sharedHead, table);
    const short = requirementCopy(sharedHead.requirements[0]!.text, MIN_COPY_LENGTH);
    expect(short).toBe(requirementCopy(sharedHead.requirements[1]!.text, MIN_COPY_LENGTH));
    const result = resolveNameTableDraft(sharedHead, {
      ...draft,
      requirements: draft.requirements.map((entry, index) => (index === 0 ? { ...entry, copy: short } : entry)),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual({ field: "requirements[0].copy", message: "要件の文の写しが指示した長さと合わない" });
  });

  it("全文が同じ 2 要件は、表を見る前に落ちる", () => {
    const duplicated: RequirementList = {
      ...list,
      requirements: [list.requirements[0]!, { ...list.requirements[1]!, text: list.requirements[0]!.text }],
    };
    expect(copyLengthFor(duplicated)).toBeNull();
    const result = inspectNameTable(duplicated, { 表ではない: true }, FIXTURE_DOCUMENTS);
    expect(result).toEqual({
      ok: false,
      problems: [{ field: "requirements[1]", message: "全文が同じ要件が一覧にある（写しで要件を区別できない）" }],
    });
  });

  it("引用がその位置の要件の原文に無ければ、別の要件の原文に在っても結び付けずに落ちる（窓口の判断・PR #515）", () => {
    const draft = draftOf(list, fixtureTable());
    const at = rowIndex("f.item.owner");
    // 写しは R1 を指すが、引用「担当者の名前」は R1 に無く R2 の原文に在る
    expect(list.requirements[0]!.text.includes("担当者の名前")).toBe(false);
    expect(list.requirements[1]!.text.includes("担当者の名前")).toBe(true);
    const shifted = {
      ...draft,
      rows: draft.rows.map((row, index) =>
        index === at ? { ...row, source: { ...row.source, quote: "担当者の名前" } } : row,
      ),
    };
    const result = resolveNameTableDraft(list, shifted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      { field: `rows[${at}].source.quote`, message: "出典の引用が、写しが指す要件の原文に無い" },
    ]);
    expectNoValues(result.problems, ["担当者の名前"]);
    expect(inspectNameTable(list, shifted, FIXTURE_DOCUMENTS).ok).toBe(false);
  });

  it("要件ごとの並びが一覧より少ないと落ちる（欠落）", () => {
    const draft = draftOf(list, fixtureTable());
    const result = resolveNameTableDraft(list, { ...draft, requirements: draft.requirements.slice(0, -1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual({ field: "requirements", message: "要件ごとの並びの数が一覧の要件の数と合わない" });
  });

  it("要件ごとの並びが一覧より多いと落ちる（余り）", () => {
    const draft = draftOf(list, fixtureTable());
    const extra = draft.requirements[0]!;
    const result = resolveNameTableDraft(list, { ...draft, requirements: [...draft.requirements, extra] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual({ field: "requirements", message: "要件ごとの並びの数が一覧の要件の数と合わない" });
  });

  it("形の合わない応答は (a) で落ちる（固定文）", () => {
    const draft = draftOf(list, fixtureTable());
    const broken = { ...draft, rows: draft.rows.map((row, index) => (index === 0 ? { ...row, kind: "widget" } : row)) };
    const shape = checkNameTableDraftShape(broken);
    expect(shape.ok).toBe(false);
    if (shape.ok) return;
    expect(shape.problems).toContainEqual({
      field: "rows[0].kind",
      message: "行の種類は entity・field・computation・operation・screen のいずれかであること",
    });
  });
});

describe("導く欄（D9）", () => {
  it("項目を所属させた要件に、entity の所属が basis dependency・reason に項目の id で足される", () => {
    const derived = deriveOwnership(fixtureTable());
    const r2 = derived.find((entry) => entry.requirementId === "R2");
    expect(r2?.roles).toContainEqual({ id: "e.member", basis: "dependency", reason: "f.member.title" });
    expect(r2?.roles).toContainEqual({ id: "e.item", basis: "dependency", reason: "f.item.title" });
    // entity を持たない行（アプリ全体の計算・ダッシュボード）からは導かない
    const r4 = derived.find((entry) => entry.requirementId === "R4");
    expect(r4?.roles.every((role) => role.basis === "stated")).toBe(true);
  });

  it("shared は所属 2 以上の行だけ真", () => {
    expect([...sharedRowIds(fixtureTable())].sort()).toEqual(["e.item", "f.item.amount", "f.item.title"]);
  });
});

describe("表の SHA-256（分類を含む正規化 JSON）", () => {
  it("同じ表は 2 回同じ値で、行の順を入れ替えても分類を 1 つ変えても変わる", async () => {
    const table = fixtureTable();
    const first = await nameTableSha256(table);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await nameTableSha256(fixtureTable())).toBe(first);
    const [a, b, ...rest] = table.rows;
    expect(await nameTableSha256(withRows(table, [b!, a!, ...rest]))).not.toBe(first);
    const reclassified: NameTable = {
      ...table,
      classification: table.classification.map((entry, index) =>
        index === 0 ? { ...entry, nature: "existence-only" } : entry,
      ),
    };
    expect(await nameTableSha256(reclassified)).not.toBe(first);
  });
});
