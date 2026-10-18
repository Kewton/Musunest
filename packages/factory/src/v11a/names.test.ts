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
  fixtureDefaultValueList,
  fixtureDefaultValueTable,
  fixtureEnumMembershipList,
  fixtureEnumMembershipTable,
  fixtureList,
  fixtureListWithRequestQuotes,
  fixtureRows,
  fixtureTable,
  LEDGER_VIEW_2A,
  LEDGER_VIEW_2B,
  LEDGER_VIEW_2C,
  fixtureNonRequirementList,
  fixtureNonRequirementTable,
  withAggregates,
  withCodeIds,
  withoutEnumMembership,
  withoutWhenAndNonRequirement,
} from "./__tests__/fixtures.js";
import {
  CHECK_TARGET_MESSAGES,
  checkCheckTargets,
  ownershipWithCheckTargets,
  NULL_SOURCE_MESSAGE,
  checkMappedTable,
  checkVocabularyRows,
  hasNoSource,
  shapeOfMappingEntry,
  MIN_COPY_LENGTH,
  checkNameTable,
  checkNameTable as checkNameTableOf,
  checkNameTableDraftShape,
  checkNameTableDraftShape as checkNameTableDraftShapeOf,
  copyLengthFor,
  deriveOwnership,
  inspectNameTable,
  inspectNameTable as inspectNameTableOf,
  nameTableSha256,
  requirementCopy,
  resolveNameTableDraft,
  sharedRowIds,
  sourcePositionOf,
  UNREGISTERED_AGGREGATE_MESSAGE,
  UNREGISTERED_VERIFICATION_KIND_MESSAGE,
  COMPUTATION_AGGREGATE_MESSAGES,
  type NameTable,
  type NameTableLedgerOptions,
  type NameTableRow,
} from "./names.js";
import { PROPERTY_LEDGER_VIEW, type LedgerView } from "../v12/ledger.js";

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
const expectProblemOf = (...args: Parameters<typeof expectProblem>): readonly Problem[] => expectProblem(...args);
function expectProblem(
  table: NameTable,
  field: string,
  message: string,
  extra: readonly string[] = [],
  against: RequirementList = list,
  options: NameTableLedgerOptions = {},
): readonly Problem[] {
  const problems = checkNameTable(against, table, FIXTURE_DOCUMENTS, options);
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

  describe("出典の引用は、写しが指す要件の文か依頼文の引用の部分文字列なら受ける（#505・#507）", () => {
    const quoted = fixtureListWithRequestQuotes();
    const ownerAt = rowIndex("f.item.owner");
    /** 行の出典の引用を、その要件の依頼文の引用（全体か一部）に置き換えた下書き */
    const draftWithRequestQuotes = (pick: (quote: string) => string) => {
      const draft = draftOf(quoted, fixtureTable());
      return {
        ...draft,
        rows: draft.rows.map((row, index) => {
          const requirementId = fixtureRows()[index]!.source.requirementId;
          const quote = quoted.requirements.find((requirement) => requirement.id === requirementId)!.quote;
          return { ...row, source: { ...row.source, quote: pick(quote) } };
        }),
      };
    };

    it("前提：依頼文の引用はどの要件の文にも、別の要件の引用にも無い", () => {
      quoted.requirements.forEach((requirement, at) => {
        for (const other of quoted.requirements) {
          expect(other.text.includes(requirement.quote)).toBe(false);
          if (other !== quoted.requirements[at]) expect(other.quote.includes(requirement.quote)).toBe(false);
        }
      });
    });

    it("依頼文の引用の全体・一部を写した出典は通り、表の出典はその引用のまま要件 ID が付く", () => {
      for (const pick of [(quote: string) => quote, (quote: string) => Array.from(quote).slice(2, 9).join("")]) {
        const draft = draftWithRequestQuotes(pick);
        const result = inspectNameTable(quoted, draft, FIXTURE_DOCUMENTS);
        if (!result.ok) throw new Error(JSON.stringify(result.problems));
        expect(result.table.rows.map((row) => row.source)).toEqual(
          fixtureTable().rows.map((row, index) => ({
            requirementId: row.source.requirementId,
            quote: draft.rows[index]!.source.quote,
          })),
        );
      }
    });

    it("要件の文の部分文字列の出典は今までどおり通る", () => {
      expect(inspectNameTable(quoted, draftOf(quoted, fixtureTable()), FIXTURE_DOCUMENTS)).toEqual({
        ok: true,
        table: fixtureTable(),
      });
    });

    it("別の要件の依頼文の引用は、写しが指す要件に無いので結び付けずに落ちる", () => {
      const draft = draftWithRequestQuotes((quote) => quote);
      const other = quoted.requirements[1]!.quote;
      const shifted = {
        ...draft,
        rows: draft.rows.map((row, index) => (index === ownerAt ? { ...row, source: { ...row.source, quote: other } } : row)),
      };
      const result = resolveNameTableDraft(quoted, shifted);
      expect(result).toEqual({
        ok: false,
        problems: [{ field: `rows[${ownerAt}].source.quote`, message: "出典の引用が、写しが指す要件の原文に無い" }],
      });
      expectNoValues(result.ok ? [] : result.problems, [other]);
    });

    it("言い換えた引用（語を言い換えた・区切りに空白を足した・先頭に空白を足した）は正規化せずに落ちる", () => {
      const own = quoted.requirements[0]!.quote;
      for (const paraphrased of [own.replace("登録", "記録"), own.replace("：", ": "), ` ${own}`]) {
        const draft = draftWithRequestQuotes((quote) => quote);
        const edited = {
          ...draft,
          rows: draft.rows.map((row, index) =>
            index === ownerAt ? { ...row, source: { ...row.source, quote: paraphrased } } : row,
          ),
        };
        expect(resolveNameTableDraft(quoted, edited)).toEqual({
          ok: false,
          problems: [{ field: `rows[${ownerAt}].source.quote`, message: "出典の引用が、写しが指す要件の原文に無い" }],
        });
      }
    });

    it("表の検査（T1'）も、依頼文の引用の出典を受け、別の要件の引用を落とす", () => {
      const fromRequest = patchRow(fixtureTable(), ownerAt, {
        source: { requirementId: "R1", quote: quoted.requirements[0]!.quote },
      });
      expect(checkNameTable(quoted, fromRequest, FIXTURE_DOCUMENTS)).toEqual([]);
      const fromOther = patchRow(fixtureTable(), ownerAt, {
        source: { requirementId: "R1", quote: quoted.requirements[1]!.quote },
      });
      expectProblem(fromOther, `rows[${ownerAt}].source.quote`, "出典の引用が要件の文に無い", [], quoted);
    });
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

// ── 1 回で全部挙げる（K2）・view-shows の所属・画面の entity の固定文（K5。Issue #527）────────────────

describe("inspectNameTable は形・写し・表の問題を 1 回で全部挙げる（K2）", () => {
  const base = () => draftOf(list, fixtureTable());
  const problemsOf = (draft: unknown): readonly Problem[] => {
    const result = inspectNameTable(list, draft, FIXTURE_DOCUMENTS);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.problems;
  };
  const editRow = (draft: ReturnType<typeof base>, id: string, patch: Record<string, unknown>) => ({
    ...draft,
    rows: draft.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
  });
  const editRequirement = (draft: ReturnType<typeof base>, index: number, patch: Record<string, unknown>) => ({
    ...draft,
    requirements: draft.requirements.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
  });
  const copyMismatch = { field: `rows[${rowIndex("f.item.amount")}].source.copy`, message: "出典の要件の文の写しが一覧のどの要件とも合わない" };
  const entityMissing = {
    field: `rows[${rowIndex("s.items")}].entity`,
    message: "所属 entity が無い（entity・アプリ全体の計算・見出しごとの集計・dashboard 以外の行は所属 entity を持つ）",
  };

  it("(1) 写しが合わず画面の entity が null の下書きは、写しの問題と entity の問題の両方を返す", () => {
    const draft = editRow(editRow(base(), "f.item.amount", { source: { copy: "どの要件とも違う写し", quote: "金額" } }), "s.items", {
      entity: null,
    });
    // 直す前（写しの段で止まる）は写しの問題だけ
    expect(resolveNameTableDraft(list, draft)).toEqual({ ok: false, problems: [copyMismatch] });
    expect(problemsOf(draft)).toEqual([copyMismatch, entityMissing]);
  });

  it("(2) 形の問題（structural の reason が null）と、別の要件の checks が空の問題の両方を返す", () => {
    const draft = editRequirement(
      editRequirement(base(), 1, { verification: { kind: "structural", reason: null, checks: ["view-shows"] } }),
      3,
      { verification: { kind: "structural", reason: "画面に出ることだけを求める", checks: [] } },
    );
    expect(problemsOf(draft)).toEqual([
      { field: "requirements[1].verification.reason", message: "構造で確かめる理由は空でない文字列であること" },
      { field: "verification[3].checks", message: "構造で確かめる要件に checks が無い" },
    ]);
  });

  it("(3) 形で落ちた要件・行から生じる派生の問題は出さず、独立した問題は報告する", () => {
    // R2 は形で落ちる。R2 だけが所属させていた行（member.title・計算・画面）を孤立にしない
    const r2Broken = editRequirement(base(), 1, { verification: { kind: "structural", reason: null, checks: ["view-shows"] } });
    expect(problemsOf(r2Broken)).toEqual([
      { field: "requirements[1].verification.reason", message: "構造で確かめる理由は空でない文字列であること" },
    ]);
    // R2 の形の壊れに、独立した孤立した行と未知の参照を重ねると、その 2 つは報告される
    const orphan = { ...r2Broken.rows[rowIndex("f.item.day")]!, id: "f.item.note", name: "note" };
    const independent = {
      ...r2Broken,
      rows: [...r2Broken.rows, orphan],
      requirements: r2Broken.requirements.map((entry, at) =>
        at === 0 ? { ...entry, roles: [...entry.roles, { id: "f.nothing", basis: "stated", reason: null }] } : entry,
      ),
    };
    expect(problemsOf(independent)).toEqual([
      { field: "requirements[1].verification.reason", message: "構造で確かめる理由は空でない文字列であること" },
      { field: "ownership[0].roles[6].id", message: "所属の表の ID が表に無い" },
      { field: `rows[${r2Broken.rows.length}]`, message: "どの要件にも所属しない行がある" },
    ]);
    // 行が形で落ちる：その id を参照する所属・見出しの元は「表に無い ID」にしない
    const rowBroken = editRow(base(), "f.item.day", { kind: "widget" });
    expect(problemsOf(rowBroken)).toEqual([
      {
        field: `rows[${rowIndex("f.item.day")}].kind`,
        message: "行の種類は entity・field・computation・operation・screen のいずれかであること",
      },
    ]);
    // 形で落ちた entity を指す行の entity も、表に無い ID にしない
    const entityBroken = editRow(base(), "e.item", { kind: "widget" });
    expect(problemsOf(entityBroken)).toHaveLength(1);
  });

  it("(4) 問題の順は形 → 写し → 表で、field の添字は元の候補の位置を指す（形で落ちた行の後ろの行で確かめる）", () => {
    const shapeAt = rowIndex("f.item.day");
    const nameAt = rowIndex("c.itemCount");
    expect(nameAt).toBeGreaterThan(shapeAt);
    const draft = editRow(
      editRow(editRow(base(), "c.itemCount", { name: "zz_bad" }), "f.item.amount", { source: { copy: "どの要件とも違う写し", quote: "金額" } }),
      "f.item.day",
      { kind: "widget" },
    );
    expect(problemsOf(draft)).toEqual([
      { field: `rows[${shapeAt}].kind`, message: "行の種類は entity・field・computation・operation・screen のいずれかであること" },
      copyMismatch,
      { field: `rows[${nameAt}].name`, message: "名前が規則（英字で始まる英数字）に合わない" },
    ]);
  });

  it("(5) 問題 0 の下書きは ok で、表は resolveNameTableDraft の結果と深く等しい。問題が残れば仮の表は返らない", () => {
    const draft = base();
    const inspected = inspectNameTable(list, draft, FIXTURE_DOCUMENTS);
    expect(inspected).toEqual(resolveNameTableDraft(list, draft));
    expect(inspected).toEqual({ ok: true, table: fixtureTable() });
    const failed = inspectNameTable(
      list,
      editRow(draft, "f.item.amount", { source: { copy: "どの要件とも違う写し", quote: "金額" } }),
      FIXTURE_DOCUMENTS,
    );
    expect(failed.ok).toBe(false);
    expect(failed).not.toHaveProperty("table");
  });

  it("(6) 写しの入れ替え・別の要件の引用は、写しの問題を今までどおり挙げる（固定文・field は同じ）", () => {
    const draft = base();
    const [first, second, ...rest] = draft.requirements;
    const swapped = { ...draft, requirements: [second!, first!, ...rest] };
    expect(problemsOf(swapped)).toEqual(
      expect.arrayContaining([
        { field: "requirements[0].copy", message: "要件の文の写しが一覧の同じ位置の要件と合わない" },
        { field: "requirements[1].copy", message: "要件の文の写しが一覧の同じ位置の要件と合わない" },
      ]),
    );
    const at = rowIndex("f.item.owner");
    const quoteOfOther = editRow(draft, "f.item.owner", { source: { copy: draft.rows[at]!.source.copy, quote: "担当者の名前" } });
    expect(problemsOf(quoteOfOther)).toEqual([
      { field: `rows[${at}].source.quote`, message: "出典の引用が、写しが指す要件の原文に無い" },
    ]);
  });

  it("形の壊れた並び（rows が空）は形の問題だけを返す", () => {
    expect(problemsOf({ rows: [], requirements: base().requirements })).toEqual([
      { field: "rows", message: "行は空でない並びであること" },
    ]);
  });
});

describe("view-shows の所属（K5(a)）", () => {
  const withRoles = (requirementId: string, ids: readonly string[]): NameTable => {
    const base = fixtureTable();
    return {
      ...base,
      ownership: base.ownership.map((entry) =>
        entry.requirementId === requirementId
          ? { ...entry, roles: ids.map((id) => ({ id, basis: "stated" as const, reason: null })) }
          : entry,
      ),
    };
  };
  const viewShowsOn = (table: NameTable, requirementId: string): NameTable => ({
    ...table,
    verification: table.verification.map((entry) =>
      entry.requirementId === requirementId
        ? { requirementId, kind: "structural" as const, reason: "画面に出ることだけを求める", checks: ["view-shows" as const] }
        : entry,
    ),
  });
  const message = "view-shows の検査に、画面と同じ entity の項目か計算の所属が無い";

  it("画面と同じ entity の項目を所属させた表は通る（fixture の R2）", () => {
    expect(checkNameTable(list, fixtureTable(), FIXTURE_DOCUMENTS)).toEqual([]);
  });

  it("画面だけを所属させた表は落ちる", () => {
    const table = withRoles("R2", ["s.items"]);
    expect(checkNameTable(list, table, FIXTURE_DOCUMENTS)).toContainEqual({ field: "verification[1].checks[0]", message });
  });

  it("別 entity の項目だけを所属させた表は落ちる", () => {
    const table = withRoles("R2", ["s.items", "f.member.title"]);
    const problems = checkNameTable(list, table, FIXTURE_DOCUMENTS);
    expect(problems).toContainEqual({ field: "verification[1].checks[0]", message });
  });

  it("dashboard とアプリ全体の計算の組は通る", () => {
    const table = viewShowsOn(withRoles("R4", ["s.overview", "c.rate", "c.byKind", "c.byMonth"]), "R4");
    expect(checkNameTable(list, table, FIXTURE_DOCUMENTS)).toEqual([]);
  });

  it("dashboard だけは落ちる", () => {
    const moved = withRoles("R4", ["s.overview"]);
    const table = viewShowsOn(
      {
        ...moved,
        ownership: moved.ownership.map((entry) =>
          entry.requirementId === "R3"
            ? { ...entry, roles: [...entry.roles, ...["c.rate", "c.byKind", "c.byMonth"].map((id) => ({ id, basis: "stated" as const, reason: null }))] }
            : entry,
        ),
      },
      "R4",
    );
    expect(checkNameTable(list, table, FIXTURE_DOCUMENTS)).toEqual([
      { field: "verification[3].checks[0]", message },
    ]);
  });
});

describe("画面の entity の固定文（K5(b)）", () => {
  it("entity が null と、表に無い ID とで固定文が違い、field は同じ", () => {
    const at = rowIndex("s.items");
    const asNull = checkNameTable(list, patchRow(fixtureTable(), at, { entity: null }), FIXTURE_DOCUMENTS);
    const unknown = checkNameTable(list, patchRow(fixtureTable(), at, { entity: "e.nothing" }), FIXTURE_DOCUMENTS);
    const field = `rows[${at}].entity`;
    expect(asNull).toContainEqual({
      field,
      message: "所属 entity が無い（entity・アプリ全体の計算・見出しごとの集計・dashboard 以外の行は所属 entity を持つ）",
    });
    expect(unknown).toContainEqual({ field, message: "所属 entity の ID が表の entity の行に無い" });
    expect(asNull.filter((problem) => problem.field === field)).toHaveLength(1);
    expect(unknown.filter((problem) => problem.field === field)).toHaveLength(1);
  });
});

// ── 形で落ちた行の派生だけを抑え、独立した不足・孤立は報告する（PR #532 のレビューの指摘 1・2。#527）─────────
//
// 最小の表：entity `e.record` と、その項目 `f.record.title` の 2 行。R1 は項目だけを名指しで所属させる。
// 直す前は、(指摘 1) 項目の name だけが壊れると kind が読めるのに要件ごと種類の問いを抑え、操作の不足が消えた。
// (指摘 2) 項目が形で落ちると、項目から導かれていた e.record の所属が消え、e.record を孤立した行と返した。
describe("形で落ちた行の派生だけを抑える（PR #532 のレビュー 1・2）", () => {
  const single: RequirementList = {
    requirements: [{ id: "R1", text: "記録を題名つきで登録できる。", quote: "記録を題名つきで登録できる。", position: { start: 0, end: 14 } }],
    decisions: [],
    unresolved: [],
  };
  const copy = requirementCopy(single.requirements[0]!.text, copyLengthFor(single)!);
  const rowOf = (id: string, kind: string, entity: string | null, name: unknown, type: unknown) => ({
    id,
    kind,
    entity,
    name,
    role: "要件 R1 が使う対象",
    source: { copy, quote: "記録" },
    type,
    options: null,
    groupBy: null,
    refEntity: null,
  });
  const draft = (
    options: {
      readonly name?: unknown;
      readonly kind?: string;
      readonly entity?: string;
      readonly verification?: unknown;
      readonly extraRows?: readonly unknown[];
      readonly extraRoles?: readonly string[];
    } = {},
  ) => ({
    rows: [
      rowOf("e.record", "entity", null, "record", null),
      rowOf("f.record.title", options.kind ?? "field", options.entity ?? "e.record", options.name ?? "title", "string"),
      ...(options.extraRows ?? []),
    ],
    requirements: [
      {
        copy,
        roles: ["f.record.title", ...(options.extraRoles ?? [])].map((id) => ({ id, basis: "stated", reason: null })),
        verification: options.verification ?? { kind: "fixed-test" },
        nature: "ruled",
      },
    ],
  });
  const inspect = (value: unknown) => inspectNameTable(single, value, FIXTURE_DOCUMENTS);
  const nameShape = { field: "rows[1].name", message: "名前は文字列であること" };
  const kindShape = { field: "rows[1].kind", message: "行の種類は entity・field・computation・operation・screen のいずれかであること" };
  const actionKind = { kind: "structural", reason: "操作の種類だけを求める", checks: ["action-kind"] };
  const kindMissing = { field: "verification[0].checks[0]", message: "checks の検査に合う種類の所属が無い" };

  it("前提：正常な最小の表は ok", () => {
    expect(inspect(draft()).ok).toBe(true);
  });

  it("指摘 2：所属させた項目が形で落ちても、その項目から導かれていた entity を孤立にしない", () => {
    // 直す前：[nameShape, { field: "rows[0]", message: "どの要件にも所属しない行がある" }]
    expect(inspect(draft({ name: 42 }))).toEqual({ ok: false, problems: [nameShape] });
  });

  it("指摘 2 の対照：元から独立した孤立 entity は報告する", () => {
    const other = rowOf("e.other", "entity", null, "other", null);
    expect(inspect(draft({ name: 42, extraRows: [other] }))).toEqual({
      ok: false,
      problems: [nameShape, { field: "rows[2]", message: "どの要件にも所属しない行がある" }],
    });
  });

  it("指摘 1：kind が読める壊れた行は、その kind で数え、なお足りない種類の不足は報告する", () => {
    // 対照：name が正常なら種類の不足が出る
    expect(inspect(draft({ verification: actionKind }))).toEqual({ ok: false, problems: [kindMissing] });
    // 直す前：[nameShape, { field: "rows[0]", message: "どの要件にも所属しない行がある" }]（種類の不足が消えた）
    expect(inspect(draft({ name: 42, verification: actionKind }))).toEqual({ ok: false, problems: [nameShape, kindMissing] });
  });

  it("指摘 1 の対照：既知の kind で満たせる checks は不足にしない", () => {
    const fieldType = { kind: "structural", reason: "項目の型だけを求める", checks: ["field-type"] };
    expect(inspect(draft({ name: 42, verification: fieldType }))).toEqual({ ok: false, problems: [nameShape] });
  });

  it("指摘 1 の対照：本当に kind が読めない行は、満たす可能性が残るので種類の不足を抑える", () => {
    expect(inspect(draft({ kind: "widget", verification: actionKind }))).toEqual({ ok: false, problems: [kindShape] });
  });

  // PR #532 の再確認の指摘 1：壊れた行の entity が entity でない行を指しても、その行の孤立は消さない
  // （deriveOwnership が所属を導くのは、表に在る kind が entity の行だけである）
  describe("壊れた行の entity が entity でない行を指す（PR #532 の再確認 1）", () => {
    const other = rowOf("f.record.other", "field", "e.record", "other", "string");
    const misreferenced = (name: unknown) =>
      draft({ name, entity: "f.record.other", extraRows: [other], extraRoles: ["e.record"] });
    const orphanOther = { field: "rows[2]", message: "どの要件にも所属しない行がある" };

    it("対照：name が正常なら、参照先の種類違反と rows[2] の孤立が出る", () => {
      expect(inspect(misreferenced("title"))).toEqual({
        ok: false,
        problems: [{ field: "rows[1].entity", message: "所属 entity の ID が表の entity の行に無い" }, orphanOther],
      });
    });

    it("name だけを壊しても、独立した rows[2] の孤立は報告する", () => {
      // 直す前：[nameShape]（rows[2] の孤立が消えた）
      expect(inspect(misreferenced(42))).toEqual({ ok: false, problems: [nameShape, orphanOther] });
    });
  });
});

/** 旗 off（台帳を渡さない）と旗 on（台帳の導出を渡す）。#533 の T1' の試験を両方で同じ結果に照らす（Issue #547） */
const LEDGER_CASES: readonly { readonly name: string; readonly options: NameTableLedgerOptions }[] = [
  { name: "off", options: {} },
  { name: "on", options: { ledger: PROPERTY_LEDGER_VIEW } },
];

describe.each(LEDGER_CASES)("既定値の確かめ方 default-value（T1' の所属の fail-closed と下書きの形。Issue #533。旗 $name）", ({ options }) => {
  const checkNameTable: typeof checkNameTableOf = (l, t, d) => checkNameTableOf(l, t, d, options);
  const inspectNameTable: typeof inspectNameTableOf = (l, v, d) => inspectNameTableOf(l, v, d, options);
  const checkNameTableDraftShape: typeof checkNameTableDraftShapeOf = (v) => checkNameTableDraftShapeOf(v, options);
  const expectProblem: typeof expectProblemOf = (table, field, message, extra, against) =>
    expectProblemOf(table, field, message, extra, against, options);
  /**
   * 旗 on の T1 の応答（下書き）と、そこから戻る表は計算の行に集計の種類と集計元を持つ（strict の schema で必須。Issue #549）。
   * off は今の表のまま
   */
  const tableFor = (table: NameTable): NameTable => (options.ledger === undefined ? table : withAggregates(table));
  const dlist = fixtureDefaultValueList();
  /** R6（一覧の 6 番目）の確かめ方の位置 */
  const R6 = "verification[5]";
  const withR6 = (patch: { roles?: readonly string[]; value?: string; nature?: "ruled" | "existence-only" }): NameTable => {
    const table = fixtureDefaultValueTable(patch.value ?? "alpha");
    return {
      ...table,
      ownership: table.ownership.map((entry) =>
        entry.requirementId === "R6" && patch.roles !== undefined
          ? { ...entry, roles: patch.roles.map((id) => ({ id, basis: "stated" as const, reason: null })) }
          : entry,
      ),
      classification: table.classification.map((entry) =>
        entry.requirementId === "R6" && patch.nature !== undefined ? { ...entry, nature: patch.nature } : entry,
      ),
    };
  };
  const VALUES = ["alpha", "beta", "gamma"];

  it("正例：enum の項目 1 つ（value が options にある）と entity だけを所属させ、分類が ruled なら問題 0", () => {
    expect(checkNameTable(dlist, fixtureDefaultValueTable(), FIXTURE_DOCUMENTS)).toEqual([]);
    // 所属 entity を名指しで書いても同じ（entity はコードが足すが、書いてもよい）
    expect(checkNameTable(dlist, withR6({ roles: ["f.item.kind", "e.item"] }), FIXTURE_DOCUMENTS)).toEqual([]);
    // 下書きから一覧の順で要件 ID を付けると、value つきの確かめ方に戻る
    const result = inspectNameTable(dlist, draftOf(dlist, tableFor(fixtureDefaultValueTable())), FIXTURE_DOCUMENTS);
    expect(result).toEqual({ ok: true, table: tableFor(fixtureDefaultValueTable()) });
    if (!result.ok) return;
    expect(result.table.verification[5]).toEqual({ requirementId: "R6", kind: "default-value", value: "alpha" });
  });

  it("負例：ほかの行（操作・画面・別の項目）も所属させると落ちる", () => {
    for (const other of ["o.addItem", "s.items", "f.item.amount"]) {
      expectProblem(
        withR6({ roles: ["f.item.kind", other] }),
        R6,
        "既定値で確かめる要件は、選択肢の項目とその所属 entity のほかの行を所属させないこと",
        VALUES,
        dlist,
      );
    }
  });

  it("負例：enum でない項目だけ・所属が無いと落ちる", () => {
    for (const roles of [["f.item.amount"], []]) {
      expectProblem(
        withR6({ roles }),
        R6,
        "既定値で確かめる要件は、選択肢（enum）の項目をちょうど 1 つ所属させること",
        VALUES,
        dlist,
      );
    }
  });

  it("負例：value が options に無いと落ちる（キーを埋めない）", () => {
    expectProblem(
      withR6({ value: "gamma" }),
      `${R6}.value`,
      "既定値で確かめる要件の value が、所属させた選択肢の項目の options に無い",
      VALUES,
      dlist,
    );
  });

  it("負例：分類が existence-only だと落ちる", () => {
    expectProblem(withR6({ nature: "existence-only" }), R6, "既定値で確かめる要件の分類は ruled であること", VALUES, dlist);
  });

  it("負例：value が空の文字列・null・無い下書きは形で落ちる。型付きの表の空の value も落ちる", () => {
    const draft = draftOf(dlist, tableFor(fixtureDefaultValueTable()));
    for (const value of ["", "  ", null, undefined]) {
      const broken = {
        ...draft,
        requirements: draft.requirements.map((entry, index) =>
          index === 5 ? { ...entry, verification: { kind: "default-value", ...(value === undefined ? {} : { value }) } } : entry,
        ),
      };
      const problem = {
        field: "requirements[5].verification.value",
        message: "既定値で確かめる要件の value は空でない文字列（期待する既定値のキー）であること",
      };
      expect(checkNameTableDraftShape(broken)).toEqual({ ok: false, problems: [problem] });
      const inspected = inspectNameTable(dlist, broken, FIXTURE_DOCUMENTS);
      expect(inspected.ok).toBe(false);
      if (!inspected.ok) expect(inspected.problems).toContainEqual(problem);
    }
    expectProblem(withR6({ value: "" }), `${R6}.value`, "既定値で確かめる要件の value が空である", VALUES, dlist);
  });

  it("ほかの種類で value が null でない下書きは固定文で落ち、null・無しは今までどおり通る", () => {
    const draft = draftOf(list, tableFor(fixtureTable()));
    // R1 は fixed-test、R2 は structural、R5 は unresolved
    for (const index of [0, 1, 4]) {
      const broken = {
        ...draft,
        requirements: draft.requirements.map((entry, at) =>
          at === index ? { ...entry, verification: { ...entry.verification, value: "alpha" } } : entry,
        ),
      };
      const problem = {
        field: `requirements[${index}].verification.value`,
        message: "既定値で確かめる要件でない確かめ方の value は null であること",
      };
      expect(checkNameTableDraftShape(broken)).toEqual({ ok: false, problems: [problem] });
      expectNoValues([problem], VALUES);
    }
    // strict の schema の形（ほかの種類も value の欄を null で持つ）は通り、fixture の表に戻る
    const withNull = {
      ...draft,
      requirements: draft.requirements.map((entry) => ({ ...entry, verification: { ...entry.verification, value: null } })),
    };
    expect(inspectNameTable(list, withNull, FIXTURE_DOCUMENTS)).toEqual({ ok: true, table: tableFor(fixtureTable()) });
  });

  it("確かめ方の種類の固定文に default-value が入り（旗 on は台帳の enum-membership・non-requirement も。Issue #548・#550）、知らない種類は今までどおり落ちる", () => {
    const draft = draftOf(list, tableFor(fixtureTable()));
    const broken = {
      ...draft,
      requirements: draft.requirements.map((entry, at) => (at === 0 ? { ...entry, verification: { kind: "other" } } : entry)),
    };
    expect(checkNameTableDraftShape(broken)).toEqual({
      ok: false,
      problems: [
        {
          field: "requirements[0].verification.kind",
          message: `確かめ方の種類は fixed-test・structural・unresolved・default-value${options.ledger === undefined ? "" : "・enum-membership・non-requirement"} のいずれかであること`,
        },
      ],
    });
  });
});

// ── 旗 on：台帳に無い確かめ方の種類（Issue #547）────────────────────────────────

describe("旗 on：T1' に台帳に無い確かめ方の種類を直接渡すと固定文で落ちる（未登録の性質の拒否）", () => {
  const dlist = fixtureDefaultValueList();
  /** R6 の確かめ方の種類だけを、台帳に無い種類に差し替えた表（形の検査を迂回して型付きの表で直接渡す） */
  const unregistered = (kind: string): NameTable => {
    const table = fixtureDefaultValueTable();
    return {
      ...table,
      verification: table.verification.map((entry) =>
        entry.requirementId === "R6" ? ({ requirementId: "R6", kind, value: "alpha" } as unknown as NameTable["verification"][number]) : entry,
      ),
    };
  };

  it("二点測定：台帳にある default-value は問題 0、台帳に無い種類は位置 verification[5].kind・固定文（値を埋めない）で落ちる", () => {
    const options = { ledger: PROPERTY_LEDGER_VIEW };
    expect(checkNameTableOf(dlist, fixtureDefaultValueTable(), FIXTURE_DOCUMENTS, options)).toEqual([]);
    for (const kind of ["no-such-kind", "state-after-set", "other"]) {
      const problems = checkNameTableOf(dlist, unregistered(kind), FIXTURE_DOCUMENTS, options);
      expect(problems, kind).toEqual([{ field: "verification[5].kind", message: UNREGISTERED_VERIFICATION_KIND_MESSAGE }]);
      expect(UNREGISTERED_VERIFICATION_KIND_MESSAGE).not.toContain(kind);
    }
  });

  it("二点測定（Issue #548）：enum-membership は手 2a の台帳（その行が無い）では台帳に無い種類で落ち、今の台帳では所属の形が合えば問題 0", () => {
    const elist = fixtureEnumMembershipList();
    expect(checkNameTableOf(elist, fixtureEnumMembershipTable(), FIXTURE_DOCUMENTS, { ledger: LEDGER_VIEW_2A })).toEqual([
      { field: "verification[5].kind", message: UNREGISTERED_VERIFICATION_KIND_MESSAGE },
    ]);
    expect(checkNameTableOf(elist, fixtureEnumMembershipTable(), FIXTURE_DOCUMENTS, { ledger: PROPERTY_LEDGER_VIEW })).toEqual([]);
  });

  it("台帳から確かめ方に結び付いた行を外すと、default-value も台帳に無い種類として落ちる（台帳の行から掛けている）", () => {
    const withoutDefault: LedgerView = {
      ...LEDGER_VIEW_2A,
      verificationKinds: LEDGER_VIEW_2A.verificationKinds.filter((kind) => kind !== "default-value"),
      rowByVerificationKind: new Map(),
    };
    expect(checkNameTableOf(dlist, fixtureDefaultValueTable(), FIXTURE_DOCUMENTS, { ledger: withoutDefault })).toEqual([
      { field: "verification[5].kind", message: UNREGISTERED_VERIFICATION_KIND_MESSAGE },
    ]);
    // 下書きの形も、台帳の種類の一覧の固定文で落ちる
    const shape = checkNameTableDraftShapeOf(draftOf(dlist, fixtureDefaultValueTable()), { ledger: withoutDefault });
    // （手 2a の台帳には集計の種類が無いので、下書きの計算の行は今の 3 つ組のまま。Issue #549）
    expect(shape).toEqual({
      ok: false,
      problems: [
        { field: "requirements[5].verification.kind", message: "確かめ方の種類は fixed-test・structural・unresolved のいずれかであること" },
      ],
    });
  });

  it("下書きの知らない種類は、手 2a の台帳の on でも off と同じ固定文（種類の一覧は台帳から導いて同じ並び）", () => {
    const draft = draftOf(list, fixtureTable());
    const broken = {
      ...draft,
      requirements: draft.requirements.map((entry, at) => (at === 0 ? { ...entry, verification: { kind: "enum-membership" } } : entry)),
    };
    expect(checkNameTableDraftShapeOf(broken, { ledger: LEDGER_VIEW_2A })).toEqual(checkNameTableDraftShapeOf(broken));
    expect(inspectNameTableOf(list, broken, FIXTURE_DOCUMENTS, { ledger: LEDGER_VIEW_2A })).toEqual(
      inspectNameTableOf(list, broken, FIXTURE_DOCUMENTS),
    );
  });

  it("#549 の台帳の on では、下書きの知らない種類の固定文は off の文に台帳の enum-membership が 1 つ増えるだけ（Issue #548）。今の台帳はさらに non-requirement が 1 つ増えるだけ（Issue #550）", () => {
    const brokenOf = (table: NameTable) => {
      const draft = draftOf(list, table);
      return {
        ...draft,
        requirements: draft.requirements.map((entry, at) => (at === 0 ? { ...entry, verification: { kind: "no-such-kind" } } : entry)),
      };
    };
    // 旗 on の下書きは計算の行に集計の種類と集計元を持つ（Issue #549）
    const on = checkNameTableDraftShapeOf(brokenOf(withAggregates(fixtureTable())), { ledger: LEDGER_VIEW_2C });
    const off = checkNameTableDraftShapeOf(brokenOf(fixtureTable()));
    expect(checkNameTableDraftShapeOf(brokenOf(fixtureTable()), { ledger: LEDGER_VIEW_2B })).toEqual(on);
    const now = checkNameTableDraftShapeOf(brokenOf(withAggregates(fixtureTable())), { ledger: PROPERTY_LEDGER_VIEW });
    expect(now).toEqual({
      ok: false,
      problems: [
        {
          field: "requirements[0].verification.kind",
          message: "確かめ方の種類は fixed-test・structural・unresolved・default-value・enum-membership・non-requirement のいずれかであること",
        },
      ],
    });
    expect(withoutWhenAndNonRequirement(now)).toEqual(on);
    expect(on).toEqual({
      ok: false,
      problems: [
        {
          field: "requirements[0].verification.kind",
          message: "確かめ方の種類は fixed-test・structural・unresolved・default-value・enum-membership のいずれかであること",
        },
      ],
    });
    expect(withoutEnumMembership(on)).toEqual(off);
  });

  it("今の題材の表（default-value の無い表）も on と off で同じ結果（on は計算の行の集計の種類と集計元の分だけ違う。Issue #549）", () => {
    expect(checkNameTableOf(list, fixtureTable(), FIXTURE_DOCUMENTS, { ledger: PROPERTY_LEDGER_VIEW })).toEqual([]);
    expect(checkNameTableOf(list, withAggregates(fixtureTable()), FIXTURE_DOCUMENTS, { ledger: PROPERTY_LEDGER_VIEW })).toEqual([]);
    const draft = draftOf(list, fixtureTable());
    // #548 の台帳の on は off と同じ結果
    expect(inspectNameTableOf(list, draft, FIXTURE_DOCUMENTS, { ledger: LEDGER_VIEW_2B })).toEqual(inspectNameTableOf(list, draft, FIXTURE_DOCUMENTS));
    expect(inspectNameTableOf(list, draft, FIXTURE_DOCUMENTS)).toEqual({ ok: true, table: fixtureTable() });
    // 今の台帳の on は、計算の行に集計の種類と集計元を持つ下書きから、それを持つ表に戻る
    expect(inspectNameTableOf(list, draftOf(list, withAggregates(fixtureTable())), FIXTURE_DOCUMENTS, { ledger: PROPERTY_LEDGER_VIEW })).toEqual({
      ok: true,
      table: withAggregates(fixtureTable()),
    });
  });
});

// ── 選択肢の集合 enum-membership（T1' の所属の形。Issue #548）──────────────────────────────

describe("旗 on：選択肢の集合の確かめ方 enum-membership（T1' の所属の形は default-value と同じ記述子から value の照合を除いたもの。Issue #548）", () => {
  const options: NameTableLedgerOptions = { ledger: PROPERTY_LEDGER_VIEW };
  const elist = fixtureEnumMembershipList();
  const R6 = "verification[5]";
  const VALUES = ["alpha", "beta", "gamma"];
  const check = (table: NameTable) => checkNameTableOf(elist, table, FIXTURE_DOCUMENTS, options);
  const withR6 = (patch: { roles?: readonly string[]; nature?: "ruled" | "existence-only"; value?: unknown; options?: readonly string[] }): NameTable => {
    const table = fixtureEnumMembershipTable(patch.options);
    return {
      ...table,
      ownership: table.ownership.map((entry) =>
        entry.requirementId === "R6" && patch.roles !== undefined
          ? { ...entry, roles: patch.roles.map((id) => ({ id, basis: "stated" as const, reason: null })) }
          : entry,
      ),
      verification: table.verification.map((entry) =>
        entry.requirementId === "R6" && patch.value !== undefined ? ({ ...entry, value: patch.value } as unknown as typeof entry) : entry,
      ),
      classification: table.classification.map((entry) =>
        entry.requirementId === "R6" && patch.nature !== undefined ? { ...entry, nature: patch.nature } : entry,
      ),
    };
  };
  const expectOnly = (table: NameTable, problem: Problem) => {
    const problems = check(table);
    expect(problems).toContainEqual(problem);
    expectNoValues(problems, VALUES);
  };

  it("正例：enum の項目 1 つと entity だけを所属させ、分類が ruled なら問題 0。下書きから value の無い確かめ方に戻る", () => {
    expect(check(fixtureEnumMembershipTable())).toEqual([]);
    expect(check(withR6({ roles: ["f.item.kind", "e.item"] }))).toEqual([]);
    // 旗 on の下書きは計算の行に集計の種類と集計元を持つ（Issue #549）
    const table = withAggregates(fixtureEnumMembershipTable());
    const result = inspectNameTableOf(elist, draftOf(elist, table), FIXTURE_DOCUMENTS, options);
    expect(result).toEqual({ ok: true, table });
    if (!result.ok) return;
    expect(result.table.verification[5]).toEqual({ requirementId: "R6", kind: "enum-membership" });
    // strict の schema の形（value の欄を null で持つ）も同じ表に戻る
    const draft = draftOf(elist, table);
    const withNull = { ...draft, requirements: draft.requirements.map((entry) => ({ ...entry, verification: { ...entry.verification, value: null } })) };
    expect(inspectNameTableOf(elist, withNull, FIXTURE_DOCUMENTS, options)).toEqual({ ok: true, table });
  });

  it("負例：ほかの行（操作・画面・別の項目）も所属させると固定文で落ちる", () => {
    for (const other of ["o.addItem", "s.items", "f.item.amount"]) {
      expectOnly(withR6({ roles: ["f.item.kind", other] }), {
        field: R6,
        message: "選択肢の集合で確かめる要件は、選択肢の項目とその所属 entity のほかの行を所属させないこと",
      });
    }
  });

  it("負例：enum でない項目だけ・所属が無いと固定文で落ちる", () => {
    for (const roles of [["f.item.amount"], ["f.item.title"], []]) {
      expectOnly(withR6({ roles }), { field: R6, message: "選択肢の集合で確かめる要件は、選択肢（enum）の項目をちょうど 1 つ所属させること" });
    }
  });

  it("負例：所属させた選択肢の項目の options が空なら固定文で落ちる", () => {
    expectOnly(withR6({ options: [] }), { field: R6, message: "選択肢の集合で確かめる要件の、所属させた選択肢の項目の options が空である" });
  });

  it("負例：分類が existence-only だと固定文で落ちる", () => {
    expectOnly(withR6({ nature: "existence-only" }), { field: R6, message: "選択肢の集合で確かめる要件の分類は ruled であること" });
  });

  it("負例：value が null でない（型付きの表・下書き）と固定文で落ちる（値を埋めない）", () => {
    for (const value of ["alpha", "", 1]) {
      expectOnly(withR6({ value }), { field: `${R6}.value`, message: "選択肢の集合で確かめる要件の value は null であること" });
    }
    const draft = draftOf(elist, withAggregates(fixtureEnumMembershipTable()));
    const broken = {
      ...draft,
      requirements: draft.requirements.map((entry, index) => (index === 5 ? { ...entry, verification: { kind: "enum-membership", value: "alpha" } } : entry)),
    };
    const problem = { field: "requirements[5].verification.value", message: "選択肢の集合で確かめる要件の value は null であること" };
    expect(checkNameTableDraftShapeOf(broken, options)).toEqual({ ok: false, problems: [problem] });
    expectNoValues([problem], VALUES);
  });

  it("既存の負例と正例は今までどおり（default-value の表・題材の表は on で今と同じ結果）", () => {
    expect(checkNameTableOf(list, fixtureTable(), FIXTURE_DOCUMENTS, options)).toEqual([]);
    const dlist = fixtureDefaultValueList();
    expect(checkNameTableOf(dlist, fixtureDefaultValueTable(), FIXTURE_DOCUMENTS, options)).toEqual([]);
    expect(checkNameTableOf(dlist, fixtureDefaultValueTable("gamma"), FIXTURE_DOCUMENTS, options)).toEqual(
      checkNameTableOf(dlist, fixtureDefaultValueTable("gamma"), FIXTURE_DOCUMENTS),
    );
  });

  it("旗 off で kind に enum-membership を書くと、下書きは schema の enum に無く形で落ち、型付きの表も固定文で落ちる（未登録の拒否）", () => {
    const draft = draftOf(elist, fixtureEnumMembershipTable());
    expect(checkNameTableDraftShapeOf(draft)).toEqual({
      ok: false,
      problems: [
        {
          field: "requirements[5].verification.kind",
          message: "確かめ方の種類は fixed-test・structural・unresolved・default-value のいずれかであること",
        },
      ],
    });
    const inspected = inspectNameTableOf(elist, draft, FIXTURE_DOCUMENTS);
    expect(inspected.ok).toBe(false);
    expect(checkNameTableOf(elist, fixtureEnumMembershipTable(), FIXTURE_DOCUMENTS)).toContainEqual({
      field: "verification[5].kind",
      message: "確かめ方の種類は fixed-test・structural・unresolved・default-value のいずれかであること",
    });
  });
});

// ── 集計の種類と集計元（計算の行の型の aggregate。旗 on。Issue #549）──────────────────────────────

describe("旗 on：計算の行の型の aggregate（集計の種類と集計元。T1' の形・種別との対応・集計元・見出しの元。Issue #549）", () => {
  const options: NameTableLedgerOptions = { ledger: PROPERTY_LEDGER_VIEW };
  const check = (table: NameTable) => checkNameTableOf(list, table, FIXTURE_DOCUMENTS, options);
  /** アプリ全体の集計の行 `c.base`（金額の合計。R4 が所属させる）を足した表（行ごと・アプリ全体・見出しごとの集計を全部持つ） */
  const withAppAggregate = (aggregate: { readonly kind: "sum" | "count" | "avg"; readonly entity: string } | null = { kind: "sum", entity: "e.item" }): NameTable => {
    const table = withAggregates(fixtureTable());
    const base: NameTableRow = {
      id: "c.base",
      kind: "computation",
      entity: null,
      name: "base",
      role: "要件 R4 が使う対象",
      source: { requirementId: "R4", quote: "金額の合計" },
      type: { valueType: "number", scope: "app", form: "aggregate", aggregate },
      options: null,
      groupBy: null,
      refEntity: null,
    };
    return {
      ...table,
      rows: [...table.rows, base],
      ownership: table.ownership.map((entry) =>
        entry.requirementId === "R4" ? { ...entry, roles: [...entry.roles, { id: "c.base", basis: "stated" as const, reason: null }] } : entry,
      ),
    };
  };
  const BASE_AT = fixtureRows().length;
  const patchAggregate = (table: NameTable, id: string, aggregate: unknown): NameTable => ({
    ...table,
    rows: table.rows.map((row) =>
      row.id === id && row.type !== null && typeof row.type === "object" ? ({ ...row, type: { ...row.type, aggregate } } as NameTableRow) : row,
    ),
  });
  const at = (id: string) => `rows[${String(rowIndex(id))}].type.aggregate`;

  it("(1) 正例：行ごと・アプリ全体・見出しごと（enum・月）の集計の行に種類と集計元を書いた表は問題 0。下書きからそのまま表に戻る", () => {
    expect(check(withAppAggregate())).toEqual([]);
    for (const kind of ["sum", "count", "avg"] as const) expect(check(withAppAggregate({ kind, entity: "e.item" })), kind).toEqual([]);
    const result = inspectNameTableOf(list, draftOf(list, withAppAggregate()), FIXTURE_DOCUMENTS, options);
    expect(result).toEqual({ ok: true, table: withAppAggregate() });
    if (!result.ok) return;
    const base = result.table.rows.find((row) => row.id === "c.base");
    expect(base?.type).toEqual({ valueType: "number", scope: "app", form: "aggregate", aggregate: { kind: "sum", entity: "e.item" } });
  });

  it("(2) 負例：種別 aggregate で aggregate が null は固定文で落ちる（行ごと・アプリ全体・見出しごと）", () => {
    for (const id of ["c.itemCount", "c.byKind", "c.byMonth"]) {
      expect(check(patchAggregate(withAggregates(fixtureTable()), id, null)), id).toEqual([{ field: at(id), message: COMPUTATION_AGGREGATE_MESSAGES.missing }]);
    }
    expect(check(withAppAggregate(null))).toEqual([{ field: `rows[${String(BASE_AT)}].type.aggregate`, message: COMPUTATION_AGGREGATE_MESSAGES.missing }]);
    // 下書きでも同じ（形は通り、表の検査で落ちる）
    const inspected = inspectNameTableOf(list, draftOf(list, patchAggregate(withAggregates(fixtureTable()), "c.itemCount", null)), FIXTURE_DOCUMENTS, options);
    expect(inspected).toEqual({ ok: false, problems: [{ field: at("c.itemCount"), message: COMPUTATION_AGGREGATE_MESSAGES.missing }] });
  });

  it("(2) 負例：種別 expression で aggregate があると固定文で落ちる", () => {
    const problems = check(patchAggregate(withAggregates(fixtureTable()), "c.rate", { kind: "sum", entity: "e.item" }));
    expect(problems).toEqual([{ field: at("c.rate"), message: COMPUTATION_AGGREGATE_MESSAGES.extra }]);
    expectNoValues(problems);
  });

  it("(2) 負例：集計元が entity でない行・表に無い id は固定文で落ちる（値を埋めない）", () => {
    for (const entity of ["f.item.amount", "s.items", "e.none"]) {
      const problems = check(patchAggregate(withAggregates(fixtureTable()), "c.itemCount", { kind: "count", entity }));
      expect(problems, entity).toEqual([{ field: `${at("c.itemCount")}.entity`, message: COMPUTATION_AGGREGATE_MESSAGES.entity }]);
      expectNoValues(problems, ["e.none"]);
    }
  });

  it("(2) 負例：見出しごとの集計の集計元が、見出しの元の項目の所属 entity と違うと固定文で落ちる（enum・月）", () => {
    for (const id of ["c.byKind", "c.byMonth"]) {
      const problems = check(patchAggregate(withAggregates(fixtureTable()), id, { kind: "count", entity: "e.member" }));
      expect(problems, id).toEqual([{ field: `${at(id)}.entity`, message: COMPUTATION_AGGREGATE_MESSAGES.groups }]);
    }
  });

  it("(2) 負例：下書きの aggregate の形（無い・知らない種類・集計元が空・写像でない）は形で落ちる。種類の一覧は台帳の表の順", () => {
    const draft = draftOf(list, withAggregates(fixtureTable()));
    const index = rowIndex("c.itemCount");
    const message = "計算の型の aggregate は null か、集計の種類（sum・count・avg）と集計元の entity の行の id の写像であること";
    for (const aggregate of [undefined, { kind: "max", entity: "e.item" }, { kind: "sum", entity: "" }, "count", { kind: "count" }]) {
      const broken = {
        ...draft,
        rows: draft.rows.map((row, at2) => {
          if (at2 !== index || row.type === null || typeof row.type !== "object") return row;
          const { aggregate: _omit, ...rest } = row.type as unknown as Record<string, unknown>;
          return { ...row, type: aggregate === undefined ? rest : { ...rest, aggregate } };
        }),
      };
      expect(checkNameTableDraftShapeOf(broken, options), JSON.stringify(aggregate)).toEqual({
        ok: false,
        problems: [{ field: `rows[${String(index)}].type.aggregate`, message }],
      });
    }
  });

  it("(3) 既存の負例と正例は今までどおり（題材の表・既定値の表・選択肢の集合の表は、集計の種類と集計元を足しても同じ結果）", () => {
    expect(check(withAggregates(fixtureTable()))).toEqual([]);
    const dlist = fixtureDefaultValueList();
    expect(checkNameTableOf(dlist, withAggregates(fixtureDefaultValueTable()), FIXTURE_DOCUMENTS, options)).toEqual([]);
    expect(checkNameTableOf(dlist, withAggregates(fixtureDefaultValueTable("gamma")), FIXTURE_DOCUMENTS, options)).toEqual(
      checkNameTableOf(dlist, fixtureDefaultValueTable("gamma"), FIXTURE_DOCUMENTS),
    );
    const elist = fixtureEnumMembershipList();
    expect(checkNameTableOf(elist, withAggregates(fixtureEnumMembershipTable([])), FIXTURE_DOCUMENTS, options)).toEqual(
      checkNameTableOf(elist, fixtureEnumMembershipTable([]), FIXTURE_DOCUMENTS, options),
    );
    // 既存の負例（見出しの元の項目に options が無い）も同じ固定文
    const noOptions = patchRow(withAggregates(fixtureTable()), rowIndex("f.item.kind"), { options: null, type: "string" });
    expect(check(noOptions)).toContainEqual({ field: `rows[${String(rowIndex("c.byKind"))}].groupBy.field`, message: "見出しの元の項目に選択肢（options）が無い" });
  });

  it("未登録の拒否：旗 off・#548 の台帳で aggregate を書いた下書きと型付きの表は形で落ちる（null・無しは今までどおり通る）", () => {
    const aggregated = withAggregates(fixtureTable());
    const draft = draftOf(list, aggregated);
    const index = rowIndex("c.itemCount");
    for (const ledgerOptions of [{}, { ledger: LEDGER_VIEW_2B }, { ledger: LEDGER_VIEW_2A }] as const) {
      const shape = checkNameTableDraftShapeOf(draft, ledgerOptions);
      expect(shape.ok).toBe(false);
      if (!shape.ok) {
        expect(shape.problems).toContainEqual({ field: `rows[${String(index)}].type.aggregate`, message: UNREGISTERED_AGGREGATE_MESSAGE });
        // 種別 aggregate の 3 行だけ（c.rate は null なので落ちない）
        expect(shape.problems.map((problem) => problem.message)).toEqual(Array(3).fill(UNREGISTERED_AGGREGATE_MESSAGE));
      }
      expect(checkNameTableOf(list, aggregated, FIXTURE_DOCUMENTS, ledgerOptions)).toContainEqual({
        field: `rows[${String(index)}].type.aggregate`,
        message: UNREGISTERED_AGGREGATE_MESSAGE,
      });
    }
    // null だけを書いた下書きは off でも今の表に戻る（欄を持たない）
    const nulls = draftOf(list, withAggregates(fixtureTable(), { "c.itemCount": null, "c.byKind": null, "c.byMonth": null }));
    expect(inspectNameTableOf(list, nulls, FIXTURE_DOCUMENTS)).toEqual({ ok: true, table: fixtureTable() });
  });

  it("二点測定：旗 on の下書きで aggregate を省くと形で落ち（strict の schema で必須）、型付きの表で省いた行は集計の検査を掛けない", () => {
    const shape = checkNameTableDraftShapeOf(draftOf(list, fixtureTable()), options);
    expect(shape.ok).toBe(false);
    if (!shape.ok) expect(shape.problems).toHaveLength(4);
    expect(checkNameTableDraftShapeOf(draftOf(list, withAggregates(fixtureTable())), options).ok).toBe(true);
    expect(check(fixtureTable())).toEqual([]);
  });
});

// ── 要件でない文 non-requirement（T1' の所属 0 行。Issue #550）──────────────────────────────

describe("旗 on：要件でない文の確かめ方 non-requirement（所属 0 行・value は null・分類は欄だけ。Issue #550）", () => {
  const options: NameTableLedgerOptions = { ledger: PROPERTY_LEDGER_VIEW };
  const nlist = fixtureNonRequirementList();
  const ntable = (): NameTable => withAggregates(fixtureNonRequirementTable());
  const NON_ROW = PROPERTY_LEDGER_VIEW.rowByVerificationKind.get("non-requirement");
  if (NON_ROW?.t1 == null) throw new Error("前提が壊れた：台帳に non-requirement の行が無い");
  const t1 = NON_ROW.t1;
  const withR6 = (table: NameTable, patch: (entry: NameTable) => NameTable): NameTable => patch(table);

  it("(1) 正例：所属 0 行・kind non-requirement の要件は問題 0。分類は欄だけ（existence-only でも ruled でも問題 0）。下書きから同じ表に戻る", () => {
    expect(checkNameTableOf(nlist, ntable(), FIXTURE_DOCUMENTS, options)).toEqual([]);
    const ruled = withR6(ntable(), (table) => ({
      ...table,
      classification: table.classification.map((entry) => (entry.requirementId === "R6" ? { ...entry, nature: "ruled" as const } : entry)),
    }));
    expect(checkNameTableOf(nlist, ruled, FIXTURE_DOCUMENTS, options)).toEqual([]);
    expect(inspectNameTableOf(nlist, draftOf(nlist, ntable()), FIXTURE_DOCUMENTS, options)).toEqual({ ok: true, table: ntable() });
    // strict の schema の形（value を null で持つ）でも同じ表に戻る
    const draft = draftOf(nlist, ntable());
    const withNull = { ...draft, requirements: draft.requirements.map((entry) => ({ ...entry, verification: { ...entry.verification, value: null } })) };
    expect(inspectNameTableOf(nlist, withNull, FIXTURE_DOCUMENTS, options)).toEqual({ ok: true, table: ntable() });
  });

  it("(2) 負例：行を 1 つでも所属させた（表に在る行・entity・表に無い ID）は固定文で落ちる", () => {
    for (const id of ["f.item.title", "e.item"]) {
      const owned = withR6(ntable(), (table) => ({
        ...table,
        ownership: table.ownership.map((entry) => (entry.requirementId === "R6" ? { ...entry, roles: [{ id, basis: "stated" as const, reason: null }] } : entry)),
      }));
      expect(checkNameTableOf(nlist, owned, FIXTURE_DOCUMENTS, options), id).toEqual([{ field: "verification[5]", message: t1.messages.count }]);
    }
    const unknown = withR6(ntable(), (table) => ({
      ...table,
      ownership: table.ownership.map((entry) => (entry.requirementId === "R6" ? { ...entry, roles: [{ id: "f.no.such", basis: "stated" as const, reason: null }] } : entry)),
    }));
    expect(checkNameTableOf(nlist, unknown, FIXTURE_DOCUMENTS, options)).toEqual([
      { field: "ownership[5].roles[0].id", message: "所属の表の ID が表に無い" },
      { field: "verification[5]", message: t1.messages.count },
    ]);
  });

  it("(2) 負例：value が null でない（型付きの表・下書き）は固定文で落ちる", () => {
    const valued = withR6(ntable(), (table) => ({
      ...table,
      verification: table.verification.map((entry) => (entry.requirementId === "R6" ? ({ ...entry, value: "x" } as unknown as typeof entry) : entry)),
    }));
    expect(checkNameTableOf(nlist, valued, FIXTURE_DOCUMENTS, options)).toEqual([{ field: "verification[5].value", message: t1.messages.valueEmpty }]);
    const draft = draftOf(nlist, ntable());
    const broken = {
      ...draft,
      requirements: draft.requirements.map((entry, at) => (at === 5 ? { ...entry, verification: { kind: "non-requirement", value: "x" } } : entry)),
    };
    expect(checkNameTableDraftShapeOf(broken, options)).toEqual({
      ok: false,
      problems: [{ field: "requirements[5].verification.value", message: t1.messages.valueShape }],
    });
  });

  it("未登録の拒否：旗 off・#549 の台帳で kind に non-requirement を書けば落ちる（下書きは種類の一覧の固定文・型付きの表も通さない）", () => {
    const offShape = checkNameTableDraftShapeOf(draftOf(nlist, fixtureNonRequirementTable()));
    expect(offShape).toEqual({
      ok: false,
      problems: [
        { field: "requirements[5].verification.kind", message: "確かめ方の種類は fixed-test・structural・unresolved・default-value のいずれかであること" },
      ],
    });
    expect(checkNameTableOf(nlist, fixtureNonRequirementTable(), FIXTURE_DOCUMENTS)).toEqual([
      { field: "verification[5].kind", message: "確かめ方の種類は fixed-test・structural・unresolved・default-value のいずれかであること" },
    ]);
    expect(checkNameTableOf(nlist, ntable(), FIXTURE_DOCUMENTS, { ledger: LEDGER_VIEW_2C })).toEqual([
      { field: "verification[5].kind", message: UNREGISTERED_VERIFICATION_KIND_MESSAGE },
    ]);
  });

  it("完全性は免除しない：non-requirement の要件も所属・確かめ方・分類がちょうど 1 つ要る（分類を欠けば落ちる。旗 on・off とも、要件 ID の形に依らない）", () => {
    for (const id of ["R6", "R:alt:x1"]) {
      const list = fixtureNonRequirementList(undefined, id);
      const table = withAggregates(fixtureNonRequirementTable(id));
      expect(checkNameTableOf(list, table, FIXTURE_DOCUMENTS, options), id).toEqual([]);
      const noClass = { ...table, classification: table.classification.filter((entry) => entry.requirementId !== id) };
      expect(checkNameTableOf(list, noClass, FIXTURE_DOCUMENTS, options), id).toEqual([{ field: "requirements[5]", message: "要件の分類が無い" }]);
      // 了承した代替先の欠落：確かめ方・所属・分類のどれからもその ID ごと抜けた表
      const dropped = {
        ...table,
        ownership: table.ownership.filter((entry) => entry.requirementId !== id),
        verification: table.verification.filter((entry) => entry.requirementId !== id),
        classification: table.classification.filter((entry) => entry.requirementId !== id),
      };
      for (const ledger of [PROPERTY_LEDGER_VIEW, undefined]) {
        const problems = checkNameTableOf(list, ledger === undefined ? fixtureTable() : withAggregates(fixtureTable()), FIXTURE_DOCUMENTS, ledger === undefined ? {} : { ledger });
        expect(problems, `${id} ${ledger === undefined ? "off" : "on"}`).toEqual([
          { field: "requirements[5]", message: "要件の所属が無い" },
          { field: "requirements[5]", message: "要件の確かめ方が無い" },
          { field: "requirements[5]", message: "要件の分類が無い" },
        ]);
      }
      expect(checkNameTableOf(list, dropped, FIXTURE_DOCUMENTS, options)).toEqual([
        { field: "requirements[5]", message: "要件の所属が無い" },
        { field: "requirements[5]", message: "要件の確かめ方が無い" },
        { field: "requirements[5]", message: "要件の分類が無い" },
      ]);
    }
  });
});

// ── 旗 v12.ids の検査の口（C1'・C2'。Issue #593）────────────────────────────────

describe("旗 v12.ids の検査の口（出典は null。写し・引用の検査は掛からない）", () => {
  const list = fixtureList();
  const table = withCodeIds(fixtureTable());

  it("C1'（checkVocabularyRows）：コードの形の ID の行は問題 0。名前の規則・同じ場所・options の固定文は今の T1' と同じ", () => {
    expect(checkVocabularyRows(list, table.rows)).toEqual([]);
    const [first, ...rest] = table.rows;
    if (first === undefined) return;
    const messages = checkVocabularyRows(list, [{ ...first, name: "1bad" }, ...rest]).map((problem) => problem.message);
    expect(messages).toContain("名前が規則（英字で始まる英数字）に合わない");
    const duplicated = checkVocabularyRows(list, [...table.rows, { ...first, id: "E9" }]).map((problem) => problem.message);
    expect(duplicated).toContain("同じ場所（種類・entity・名前）を指す ID が 2 つある（別名は書けない）");
    // 所属・確かめ方・分類（(e)(g)）と孤立した行は見ない
    expect(duplicated).not.toContain("どの要件にも所属しない行がある");
  });

  it("C2'（checkMappedTable）：表全体は問題 0。所属の欠落は今の (g) の固定文で落ちる", () => {
    expect(checkMappedTable(list, table, FIXTURE_DOCUMENTS)).toEqual([]);
    const missing = checkMappedTable(list, { ...table, ownership: table.ownership.slice(1) }, FIXTURE_DOCUMENTS).map((problem) => problem.message);
    expect(missing).toContain("要件の所属が無い");
  });

  it("旗 off の表の検査（checkNameTable）は出典が null の行を固定文で落とす（出典を要る形のまま）", () => {
    const messages = checkNameTable(list, table, FIXTURE_DOCUMENTS).map((problem) => problem.message);
    expect(messages).toContain(NULL_SOURCE_MESSAGE);
    expect(messages.filter((message) => message === NULL_SOURCE_MESSAGE)).toHaveLength(table.rows.length);
    expect(hasNoSource(table.rows[0] ?? fixtureTable().rows[0]!)).toBe(true);
    expect(hasNoSource(fixtureTable().rows[0]!)).toBe(false);
  });

  it("C2 の要件ごとの 1 件の形（shapeOfMappingEntry）：要件 ID が要り、写し（copy）の欄は見ない", () => {
    const problems: Problem[] = [];
    const entry = shapeOfMappingEntry({ requirementId: "R1", roles: [], verification: { kind: "fixed-test", value: null }, nature: "ruled" }, "requirements[0]", problems);
    expect(problems).toEqual([]);
    expect(entry).toEqual({ requirementId: "R1", roles: [], verification: { kind: "fixed-test" }, nature: "ruled" });
    const bad: Problem[] = [];
    expect(shapeOfMappingEntry({ requirementId: "", roles: [], verification: { kind: "fixed-test" }, nature: "ruled" }, "requirements[0]", bad)).toBeUndefined();
    expect(bad.map((problem) => problem.message)).toEqual(["要件 ID は空でない文字列であること"]);
  });
});

// ── 旗 v12.ids の構造の検査の対象（C2'。Issue #594）────────────────────────────

describe("構造の検査の対象の照合と所属への足し込み（旗 v12.ids）", () => {
  const rows = fixtureTable().rows;
  const messages = (targets: Parameters<typeof checkCheckTargets>[1]) => {
    const problems: Problem[] = [];
    checkCheckTargets(rows, targets, "verification", problems);
    return problems.map((problem) => problem.message);
  };

  it("種類の合う対象・画面と同じ entity の項目か計算の組は問題 0。entity を持たない画面は entity を持たない計算と組める", () => {
    expect(messages([{ check: "view-shows", targetId: "s.members", sourceId: "f.member.title" }])).toEqual([]);
    expect(messages([{ check: "view-shows", targetId: "s.members", sourceId: "c.itemCount" }])).toEqual([]);
    expect(messages([{ check: "view-shows", targetId: "s.overview", sourceId: "c.rate" }])).toEqual([]);
    expect(messages([{ check: "field-type", targetId: "f.item.title", sourceId: null }])).toEqual([]);
    expect(messages([{ check: "action-kind", targetId: "o.addItem", sourceId: null }])).toEqual([]);
  });

  it("負例は固定文で落ちる（対象が無い・種類が違う・組が無い・組が行に無い・組の entity が違う・dashboard に entity を持つ行・view-shows でない検査の組）", () => {
    expect(messages([{ check: "view-shows", targetId: "s.none", sourceId: "f.item.title" }])).toContain(CHECK_TARGET_MESSAGES.unknownTarget);
    expect(messages([{ check: "field-type", targetId: "o.addItem", sourceId: null }])).toEqual([CHECK_TARGET_MESSAGES.targetKind]);
    expect(messages([{ check: "view-shows", targetId: "s.items", sourceId: null }])).toEqual([CHECK_TARGET_MESSAGES.sourceMissing]);
    expect(messages([{ check: "view-shows", targetId: "s.items", sourceId: "f.none" }])).toEqual([CHECK_TARGET_MESSAGES.unknownSource]);
    expect(messages([{ check: "view-shows", targetId: "s.items", sourceId: "f.member.title" }])).toEqual([CHECK_TARGET_MESSAGES.sourcePair]);
    expect(messages([{ check: "view-shows", targetId: "s.overview", sourceId: "f.item.title" }])).toEqual([CHECK_TARGET_MESSAGES.sourcePair]);
    expect(messages([{ check: "view-shows", targetId: "s.overview", sourceId: "c.itemCount" }])).toEqual([CHECK_TARGET_MESSAGES.sourcePair]);
    expect(messages([{ check: "action-kind", targetId: "o.addItem", sourceId: "o.addItem" }])).toEqual([CHECK_TARGET_MESSAGES.sourceExtra]);
  });

  it("所属に無い対象の行だけを basis dependency・reason に検査の種類で足す（既にある行・重なる行は足さない）", () => {
    const roles = [{ id: "s.items", basis: "stated" as const, reason: null }];
    expect(
      ownershipWithCheckTargets(roles, [
        { check: "view-shows", targetId: "s.items", sourceId: "f.item.title" },
        { check: "field-type", targetId: "f.item.title", sourceId: null },
      ]),
    ).toEqual([...roles, { id: "f.item.title", basis: "dependency", reason: "view-shows" }]);
    expect(ownershipWithCheckTargets(roles, [])).toBe(roles);
  });
});
