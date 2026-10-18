// ID の振り方と参照の照合（純粋。Issue #593）
import { describe, expect, it } from "vitest";
import type { Problem } from "../stages/prompt.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import type { NameTableKind } from "../v11a/names.js";
import { fixtureList, fixtureTable, idsResponsesOf, withCodeIds } from "../v11a/__tests__/fixtures.js";
import {
  ID_MESSAGES,
  ReferenceTally,
  addReferenceCounts,
  checkReference,
  computationIdAt,
  entityIdAt,
  fieldIdAt,
  idKindOf,
  operationIdAt,
  screenIdAt,
  ZERO_REFERENCE_COUNTS,
} from "./ids.js";
import { assembleVocabularyBundle } from "./stages/vocabulary.js";


describe("ID の形", () => {
  it("E・E.F・C・OP・V の形で振り、形から種類を読める。形に合わない文字列は null", () => {
    expect([entityIdAt(0), fieldIdAt("E2", 2), computationIdAt(0), operationIdAt(1), screenIdAt(4)]).toEqual(["E1", "E2.F3", "C1", "OP2", "V5"]);
    const kinds: Record<string, NameTableKind | null> = { E1: "entity", "E12.F3": "field", C4: "computation", OP2: "operation", V9: "screen" };
    for (const [id, kind] of Object.entries(kinds)) expect(idKindOf(id)).toBe(kind);
    for (const id of ["e.item", "E0", "F1", "E1.F", "R1", "", "OP", "E1.C1"]) expect(idKindOf(id), id).toBeNull();
  });
});

describe("ID の振り方（純粋）", () => {
  const list = fixtureList();
  const table = withCodeIds(fixtureTable());
  const responses = idsResponsesOf(list, table);
  const entities = table.rows.filter((row) => row.kind === "entity");
  const assemble = (bundle: "entities" | "fields" | "behaviors", output: Record<string, unknown>, previous = entities) =>
    assembleVocabularyBundle(bundle, output, bundle === "entities" ? [] : previous, new ReferenceTally());

  it("同じ応答から 2 回同じ ID。表の中で一意", () => {
    const first = assemble("fields", responses.fields);
    const second = assemble("fields", responses.fields);
    expect(first.rows.map((row) => row.id)).toEqual(second.rows.map((row) => row.id));
    const all = table.rows.map((row) => row.id);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(idKindOf(id), id).not.toBeNull();
  });

  it("応答の順を入れ替えると ID が変わる（並びで決まる。名前や文には依らない）", () => {
    const items = responses.entities["entities"] as readonly Record<string, unknown>[];
    const reversed = assemble("entities", { entities: [...items].reverse() });
    const original = assemble("entities", responses.entities);
    expect(reversed.rows.map((row) => row.id)).toEqual(original.rows.map((row) => row.id));
    expect(reversed.rows.map((row) => row.name)).toEqual(original.rows.map((row) => row.name).reverse());
    expect(reversed.rows.find((row) => row.name === "member")?.id).not.toBe(original.rows.find((row) => row.name === "member")?.id);
  });

  it("項目の ID は entity ごとに応答の順で 1 から", () => {
    const rows = assemble("fields", responses.fields).rows;
    const byEntity = new Map<string, string[]>();
    for (const row of rows) byEntity.set(row.entity ?? "", [...(byEntity.get(row.entity ?? "") ?? []), row.id]);
    for (const [entity, ids] of byEntity) expect(ids).toEqual(ids.map((_, index) => `${entity}.F${String(index + 1)}`));
  });
});

describe("参照の照合（fail-closed）", () => {
  const known = new Map<string, NameTableKind>([
    ["E1", "entity"],
    ["E1.F1", "field"],
  ]);
  const check = (id: string, bundle: "fields" | "behaviors", want: NameTableKind) => {
    const problems: Problem[] = [];
    const tally = new ReferenceTally();
    const ok = checkReference(id, "x", bundle, known, want, problems, tally);
    return { ok, messages: problems.map((problem) => problem.message), counts: tally.counts };
  };

  it("知らない ID・別の束の ID・種類違いを固定文で落とし、近い ID に結び付けない。照らした参照は毎回 1 増える", () => {
    expect(check("E1", "fields", "entity")).toEqual({ ok: true, messages: [], counts: { ...ZERO_REFERENCE_COUNTS, checked: 1 } });
    expect(check("E2", "fields", "entity")).toMatchObject({ ok: false, messages: [ID_MESSAGES.unknown], counts: { checked: 1, unknown: 1 } });
    expect(check("e1", "fields", "entity")).toMatchObject({ ok: false, messages: [ID_MESSAGES.unknown] });
    expect(check("E1.F1", "fields", "entity")).toMatchObject({ ok: false, messages: [ID_MESSAGES.crossBundle], counts: { crossBundle: 1 } });
    expect(check("C1", "behaviors", "entity")).toMatchObject({ ok: false, messages: [ID_MESSAGES.crossBundle] });
    expect(check("E1.F1", "behaviors", "entity")).toMatchObject({ ok: false, messages: [ID_MESSAGES.wrongKind] });
    expect(check("E1.F1", "behaviors", "field").ok).toBe(true);
  });

  it("数を足せる", () => {
    expect(addReferenceCounts({ checked: 1, unknown: 2, duplicate: 3, crossBundle: 4 }, { checked: 1, unknown: 1, duplicate: 1, crossBundle: 1 })).toEqual({
      checked: 2,
      unknown: 3,
      duplicate: 4,
      crossBundle: 5,
    });
  });
});

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

describe("題材の言葉の走査（Issue #593 で足した・直したファイル）", () => {
  it("C1・C2 の段・ID の関数・試験・fixture・走らせる部分のソースに受入の題材の言葉が無い", () => {
    const files = [
      "./ids.ts",
      "./ids.test.ts",
      "./stages/vocabulary.ts",
      "./stages/vocabulary.test.ts",
      "./stages/mapping.ts",
      "./stages/mapping.test.ts",
      "./limits.ts",
      "../v11a/names.ts",
      "../v11a/run.ts",
      "../v11a/__tests__/fixtures.ts",
      "../v11a/__tests__/sizes.ts",
      "../schema-envelope.ts",
      "../record.ts",
    ];
    expectNoAcceptanceMaterial(files.map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});
