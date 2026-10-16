// 持ち越しの集合と除く範囲（v11a/carry-over.ts）の unit テスト（07-architecture-v1.1a.md §1.2・D14・D15。Issue #505）。
import { describe, expect, it } from "vitest";
import { checkDesignOwnership } from "../stages/design.js";
import { fixtureList, fixtureTable } from "./__tests__/fixtures.js";
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
