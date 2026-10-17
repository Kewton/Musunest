// 持ち越しの集合と除く範囲（v11a/carry-over.ts）の unit テスト（07-architecture-v1.1a.md §1.2・D14・D15。Issue #505）。
import { describe, expect, it } from "vitest";
import { checkDesignOwnership } from "../stages/design.js";
import {
  LEDGER_VIEW_2C,
  fixtureList,
  fixtureNonRequirementList,
  fixtureNonRequirementTable,
  fixtureTable,
} from "./__tests__/fixtures.js";
import type { FixedTest } from "../fixed-test.js";
import {
  danglingRowReferences,
  deriveCarryOver,
  pruneForCarryOver,
  type CarryOverInput,
  type DeclJudgment,
  type SemanticJudgment,
} from "./carry-over.js";
import { nameTableSha256 } from "./names.js";

const accept = (requirementId: string) => ({ requirementId, verdict: "accept" as const });
const reject = (requirementId: string, kind: string) => ({
  requirementId,
  verdict: "reject" as const,
  kind,
  quote: "引用",
});
const DECL_SHA = "d".repeat(64);

/** 4 つの出どころがそろう入力：R5＝name-table、R4＝semantic-check、R3＝decl-check、R1＝coverage、R2 は残る */
async function fullInput(overrides: {
  readonly semantic?: readonly SemanticJudgment[];
  readonly decl?: readonly DeclJudgment[];
  readonly tableSha?: string;
  readonly declSha?: string;
} = {}): Promise<CarryOverInput> {
  const table = fixtureTable();
  return {
    list: fixtureList(),
    table,
    semanticCheck: {
      tableSha256: overrides.tableSha ?? (await nameTableSha256(table)),
      judgments: overrides.semantic ?? [accept("R1"), accept("R2"), accept("R3"), reject("R4", "missing-target")],
    },
    declCheck: {
      declarationSha256: DECL_SHA,
      result: {
        declarationSha256: overrides.declSha ?? DECL_SHA,
        judgments: overrides.decl ?? [accept("R1"), accept("R2"), reject("R3", "condition-mismatch")],
      },
    },
    coverage: [{ requirementId: "R1", units: [{ requirementId: "R1", targetId: "f.item.amount", key: "k" }] }],
  };
}

describe("持ち越しの集合（07 §1.2）", () => {
  it("4 つの出どころが要件ごとに残る", async () => {
    const carry = await deriveCarryOver(await fullInput());
    expect(carry.entries).toEqual([
      { requirementId: "R1", reasons: [{ origin: "coverage", reason: "lost-coverage-units" }] },
      { requirementId: "R3", reasons: [{ origin: "decl-check", reason: "condition-mismatch" }] },
      { requirementId: "R4", reasons: [{ origin: "semantic-check", reason: "missing-target" }] },
      { requirementId: "R5", reasons: [{ origin: "name-table", reason: "宣言で書けない" }] },
    ]);
    expect(carry.remainingRequirementIds).toEqual(["R2"]);
    expect(carry.allCarried).toBe(false);
  });

  it("B3' の該当箇所を引き当てられない要件（unmarked）も持ち越す", async () => {
    const carry = await deriveCarryOver(
      await fullInput({ decl: [accept("R1"), { requirementId: "R2", verdict: "unmarked" }, accept("R3")] }),
    );
    expect(carry.entries.find((entry) => entry.requirementId === "R2")?.reasons).toEqual([
      { origin: "decl-check", reason: "unmarked" },
    ]);
  });

  it("その要件だけが所属させる行は除かれ、共有する行は残る", async () => {
    const carry = await deriveCarryOver(await fullInput());
    expect(carry.excludedRowIds).toEqual([
      "f.item.owner",
      "f.item.amount",
      "f.item.day",
      "f.item.kind",
      "c.rate",
      "c.byKind",
      "c.byMonth",
      "o.addItem",
      "o.closeItem",
      "s.overview",
    ]);
    // 残る要件 R2 も所属させる行（項目 item.title と、導いた entity item）は残る
    expect(carry.excludedRowIds).not.toContain("f.item.title");
    expect(carry.excludedRowIds).not.toContain("e.item");

    const pruned = pruneForCarryOver(fixtureList(), fixtureTable(), carry);
    expect(pruned.list.requirements.map((requirement) => requirement.id)).toEqual(["R2"]);
    const roleIds = (pruned.conversion.design.roles ?? []).map((role) => role.roleId);
    expect(roleIds).toContain("f.item.title");
    expect(roleIds).toContain("e.item");
    expect(roleIds).not.toContain("f.item.amount");
    expect(pruned.conversion.mappings.map((mapping) => mapping.roleId)).toEqual(roleIds);
    expect(pruned.conversion.ownership.map((entry) => entry.requirementId)).toEqual(["R2"]);
    expect(checkDesignOwnership(pruned.conversion.design)).toEqual([]);
  });

  it("全件持ち越しの判定：残る要件が 0 なら真", async () => {
    const all = await deriveCarryOver({
      ...(await fullInput({
        semantic: [reject("R1", "a"), reject("R2", "b"), reject("R3", "c"), reject("R4", "d")],
      })),
      declCheck: { declarationSha256: DECL_SHA, result: { declarationSha256: DECL_SHA, judgments: [] } },
    });
    expect(all.allCarried).toBe(true);
    expect(all.remainingRequirementIds).toEqual([]);
    const some = await deriveCarryOver(await fullInput());
    expect(some.allCarried).toBe(false);
  });
});

describe("SHA の合わない結果・不完全な結果は例外で断る（持ち越しを空にして進まない）", () => {
  it("表の SHA の合わない T1'' の結果", async () => {
    await expect(deriveCarryOver(await fullInput({ tableSha: "0".repeat(64) }))).rejects.toThrow(/SHA-256/);
  });

  it("宣言の SHA の合わない B3' の結果", async () => {
    await expect(deriveCarryOver(await fullInput({ declSha: "e".repeat(64) }))).rejects.toThrow(/SHA-256/);
  });

  it("判定が 1 件欠けた結果", async () => {
    await expect(deriveCarryOver(await fullInput({ semantic: [accept("R1"), accept("R2"), accept("R3")] }))).rejects.toThrow(
      /欠けた/,
    );
    await expect(deriveCarryOver(await fullInput({ decl: [accept("R1"), accept("R2")] }))).rejects.toThrow(/欠けた/);
  });

  it("重複した結果", async () => {
    await expect(
      deriveCarryOver(await fullInput({ semantic: [accept("R1"), accept("R1"), accept("R2"), accept("R3"), accept("R4")] })),
    ).rejects.toThrow(/重なって/);
  });

  it("対象の外の要件 ID の判定（unresolved の要件・一覧に無い要件）", async () => {
    await expect(
      deriveCarryOver(
        await fullInput({ semantic: [accept("R1"), accept("R2"), accept("R3"), accept("R4"), accept("R5")] }),
      ),
    ).rejects.toThrow(/対象の外/);
  });
});

const r2Test = (id: string, referenceRole?: string): FixedTest => ({
  id,
  target: { requirementId: "R2", kind: "screen", roleId: "s.members" },
  kind: "normal",
  operation: "screen",
  clock: "2026-09-16T12:00:00+09:00",
  input: null,
  referenceData:
    referenceRole === undefined ? [] : [{ target: { requirementId: "R2", kind: "entity", roleId: referenceRole }, values: {} }],
  expected: { kind: "ok", value: null },
});

describe("除いた行を指す参照は黙って進めずに例外で断る（窓口の判断・PR #515）", () => {
  it("残る行の groupBy が除いた行を指すと deriveCarryOver が断る", async () => {
    // R1 だけが持ち越し（R5 は unresolved）。R1 だけが所属させる項目 item.kind・item.day を、残る R4 の
    // 見出しごとの計算（byKind・byMonth）が見出しの元に指している
    const input = await fullInput({
      semantic: [reject("R1", "missing-target"), accept("R2"), accept("R3"), accept("R4")],
      decl: [accept("R2"), accept("R3"), accept("R4")],
    });
    await expect(deriveCarryOver({ ...input, coverage: [] })).rejects.toThrow(/除いた行を指している/);
    const table = fixtureTable();
    const index = (id: string) => table.rows.findIndex((row) => row.id === id);
    expect(danglingRowReferences(table, new Set(["f.item.kind", "f.item.day"]))).toEqual([
      { field: `rows[${index("c.byKind")}].groupBy.field`, message: "残る行の見出しの元が除いた行を指している" },
      { field: `rows[${index("c.byMonth")}].groupBy.field`, message: "残る行の見出しの元が除いた行を指している" },
    ]);
  });

  it("残る行の refEntity が除いた行を指す位置を挙げる", () => {
    const table = fixtureTable();
    const owner = table.rows.findIndex((row) => row.id === "f.item.owner");
    expect(danglingRowReferences(table, new Set(["e.member"]))).toContainEqual({
      field: `rows[${owner}].refEntity`,
      message: "残る行の参照先が除いた行を指している",
    });
  });

  it("残る試験の参照が除いた行を指すと pruneForCarryOver が断る", async () => {
    const carry = await deriveCarryOver(await fullInput());
    expect(carry.excludedRowIds).toContain("f.item.amount");
    expect(() =>
      pruneForCarryOver(fixtureList(), fixtureTable(), carry, { tests: [r2Test("bad", "f.item.amount")] }),
    ).toThrow(/除いた行を指している/);
  });

  it("参照が残る行だけなら、残る要件の試験に絞って返す", async () => {
    const carry = await deriveCarryOver(await fullInput());
    const carriedTest: FixedTest = { ...r2Test("carried"), target: { requirementId: "R4", kind: "screen", roleId: "s.overview" } };
    const pruned = pruneForCarryOver(fixtureList(), fixtureTable(), carry, {
      tests: [r2Test("ok", "e.member"), carriedTest],
    });
    expect(pruned.suite?.tests.map((test) => test.id)).toEqual(["ok"]);
  });
});

// ── 要件でない文（non-requirement。T1'' が受理したものだけ。Issue #550）──────────────────────────────

describe("要件でない文：T1'' が受理した non-requirement の要件は持ち越しに数えず、残る一覧から除く（除く行は増えない）", () => {
  const ids = ["R1", "R2", "R3", "R4"];
  async function nonInput(id: string, judgment: SemanticJudgment, extra: Partial<CarryOverInput> = {}): Promise<CarryOverInput> {
    const table = fixtureNonRequirementTable(id);
    return {
      list: fixtureNonRequirementList(undefined, id),
      table,
      semanticCheck: { tableSha256: await nameTableSha256(table), judgments: [...ids.map(accept), judgment] },
      ...extra,
    };
  }
  const plainCarry = async () =>
    deriveCarryOver({
      list: fixtureList(),
      table: fixtureTable(),
      semanticCheck: { tableSha256: await nameTableSha256(fixtureTable()), judgments: ids.map(accept) },
    });

  for (const id of ["R6", "R:alt:x1"]) {
    it(`受理された non-requirement（ID ${id}）は残る一覧にも持ち越しの項目にも無く、除く行が増えない。記録の nonRequirements にあり、ほかの欄は今のまま`, async () => {
      const carry = await deriveCarryOver(await nonInput(id, accept(id)));
      const plain = await plainCarry();
      expect(carry.entries).toEqual(plain.entries);
      expect(carry.remainingRequirementIds).toEqual(plain.remainingRequirementIds);
      expect(carry.excludedRowIds).toEqual(plain.excludedRowIds);
      expect(carry.allCarried).toBe(false);
      expect(carry.nonRequirements).toEqual([id]);
      expect(Object.keys(carry)).toEqual(["entries", "excludedRowIds", "remainingRequirementIds", "allCarried", "nonRequirements"]);
      // 除いた版：一覧・所属・確かめ方・分類から除く
      const pruned = pruneForCarryOver(fixtureNonRequirementList(undefined, id), fixtureNonRequirementTable(id), carry);
      expect(pruned.list.requirements.map((requirement) => requirement.id)).toEqual(ids);
      for (const entries of [pruned.table.ownership, pruned.table.verification, pruned.table.classification]) {
        expect(entries.map((entry) => entry.requirementId)).toEqual(ids);
      }
      expect(pruned.table.rows).toEqual(fixtureTable().rows);
    });

    it(`拒否された non-requirement（ID ${id}）は今までどおり持ち越し（出どころ semantic-check）で、nonRequirements の欄を持たない`, async () => {
      const carry = await deriveCarryOver(await nonInput(id, reject(id, "weak-verification")));
      expect(carry.entries.map((entry) => entry.requirementId)).toEqual(["R5", id]);
      expect(carry.entries.at(-1)?.reasons).toEqual([{ origin: "semantic-check", reason: "weak-verification" }]);
      expect(carry.remainingRequirementIds).toEqual(ids);
      expect(carry.nonRequirements).toBeUndefined();
      expect("nonRequirements" in carry).toBe(false);
    });
  }

  it("持ち越しと要件でない文で全件なら全件持ち越しと同じく allCarried（段・種類は同じ。固定文は走らせる部分が分ける）", async () => {
    const table = fixtureNonRequirementTable();
    const carry = await deriveCarryOver({
      list: fixtureNonRequirementList(),
      table,
      semanticCheck: { tableSha256: await nameTableSha256(table), judgments: [...ids.map((id) => reject(id, "weak-verification")), accept("R6")] },
    });
    expect(carry.remainingRequirementIds).toEqual([]);
    expect(carry.allCarried).toBe(true);
    expect(carry.nonRequirements).toEqual(["R6"]);
  });

  it("要件でない文は B3' の対象に入らない（判定があれば対象の外として断る）・網羅の落ちにあれば一覧の外として断る", async () => {
    const base = await nonInput("R6", accept("R6"));
    const declOf = (judgments: readonly DeclJudgment[]): Partial<CarryOverInput> => ({
      declCheck: { declarationSha256: DECL_SHA, result: { declarationSha256: DECL_SHA, judgments } },
    });
    await expect(deriveCarryOver({ ...base, ...declOf(ids.map(accept)) })).resolves.toMatchObject({ nonRequirements: ["R6"] });
    await expect(deriveCarryOver({ ...base, ...declOf([...ids.map(accept), accept("R6")]) })).rejects.toThrow("対象の外の要件 ID の判定がある");
    await expect(
      deriveCarryOver({ ...base, coverage: [{ requirementId: "R6", units: [{ requirementId: "R6", targetId: "e.item", key: "k" }] }] }),
    ).rejects.toThrow("網羅の落ちに一覧の外の要件 ID がある");
  });

  it("受理で除くかは台帳の確かめ方の種類で決める（要件 ID の形・文では決めない）。#549 の台帳では受理されても要件でない文にならない（二点測定）", async () => {
    const input = await nonInput("R6", accept("R6"));
    expect((await deriveCarryOver(input)).nonRequirements).toEqual(["R6"]);
    const before = await deriveCarryOver({ ...input, ledger: LEDGER_VIEW_2C });
    expect(before.nonRequirements).toBeUndefined();
    expect(before.remainingRequirementIds).toEqual([...ids, "R6"]);
    // 確かめ方が fixed-test なら、R:alt: の ID でも要件でない文にならない
    const table = fixtureNonRequirementTable("R:alt:x1");
    const fixed = {
      ...table,
      ownership: table.ownership.map((entry) => (entry.requirementId === "R:alt:x1" ? { ...entry, roles: [{ id: "e.item", basis: "stated" as const, reason: null }] } : entry)),
      verification: table.verification.map((entry) => (entry.requirementId === "R:alt:x1" ? { requirementId: entry.requirementId, kind: "fixed-test" as const } : entry)),
    };
    const carry = await deriveCarryOver({
      list: fixtureNonRequirementList(undefined, "R:alt:x1"),
      table: fixed,
      semanticCheck: { tableSha256: await nameTableSha256(fixed), judgments: [...ids.map(accept), accept("R:alt:x1")] },
    });
    expect(carry.nonRequirements).toBeUndefined();
    expect(carry.remainingRequirementIds).toEqual([...ids, "R:alt:x1"]);
  });
});
