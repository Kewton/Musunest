// 名前の表の v1 の型への写し（v11a/convert.ts）の unit テスト（07-architecture-v1.1a.md §2.2。Issue #505）。
//
// 写しは決定的で、恒等の対応が全行、month の groupBy は null・enum は項目の id、nature は表の分類、語彙・置き場所・
// 書けない部分は空、写した設計は v1 の `checkDesignOwnership`・`checkGroupBy` で問題 0 であることを固定する。
import { describe, expect, it } from "vitest";
import { checkDesignOwnership, checkGroupBy } from "../stages/design.js";
import { fixtureDefaultValueTable, fixtureTable } from "./__tests__/fixtures.js";
import { identityMappings, toV1 } from "./convert.js";

describe("名前の表を v1 の型へ写す（07 §2.2）", () => {
  it("写しは決定的（2 回深く等しい）", () => {
    expect(toV1(fixtureTable())).toEqual(toV1(fixtureTable()));
  });

  it("恒等の対応が全行ある（roleId＝id・name＝name）", () => {
    const table = fixtureTable();
    const { mappings } = toV1(table);
    expect(mappings).toEqual(table.rows.map((row) => ({ roleId: row.id, name: row.name })));
    expect(identityMappings(table)).toEqual(mappings);
  });

  it("month の groupBy は null に、enum は分ける項目の id に写る。aliasOf は null、shared は所属の数から", () => {
    const roles = toV1(fixtureTable()).design.roles ?? [];
    const byId = new Map(roles.map((role) => [role.roleId, role] as const));
    expect(byId.get("c.byMonth")?.groupBy).toBeNull();
    expect(byId.get("c.byKind")?.groupBy).toBe("f.item.kind");
    expect(byId.get("f.item.kind")?.options).toEqual(["alpha", "beta"]);
    expect(roles.every((role) => role.aliasOf === null)).toBe(true);
    expect(byId.get("f.item.title")?.shared).toBe(true);
    expect(byId.get("f.member.title")?.shared).toBe(false);
  });

  it("nature は表の分類と要件ごとに一致し、語彙・置き場所・書けない部分は空", () => {
    const table = fixtureTable();
    const { design } = toV1(table);
    for (const entry of table.classification) {
      const written = design.designs.find((candidate) => candidate.requirementId === entry.requirementId);
      expect(written?.nature, entry.requirementId).toBe(entry.nature);
    }
    for (const written of design.designs) {
      expect(written.vocabulary).toEqual([]);
      expect(written.placement).toEqual([]);
      expect(written.unwritable).toEqual([]);
    }
    const r2 = design.designs.find((entry) => entry.requirementId === "R2");
    expect(r2?.verification).toEqual({ kind: "structural", reason: "画面に出ることだけを求める" });
    expect(r2?.checks).toEqual(["view-shows"]);
    const r5 = design.designs.find((entry) => entry.requirementId === "R5");
    expect(r5?.verification).toEqual({ kind: "unresolved", reason: "宣言で書けない" });
  });

  it("所属は導いた entity の所属（basis dependency・reason）を含む", () => {
    const { ownership, design } = toV1(fixtureTable());
    const r2 = ownership.find((entry) => entry.requirementId === "R2");
    expect(r2?.ownership).toContainEqual({ roleId: "e.member", basis: "dependency", reason: "f.member.title" });
    expect(design.designs.find((entry) => entry.requirementId === "R2")?.ownership).toEqual(r2?.ownership);
  });

  it("写した DesignResult は v1 の checkDesignOwnership・checkGroupBy で問題 0", () => {
    const { design } = toV1(fixtureTable());
    expect(checkDesignOwnership(design)).toEqual([]);
    expect(checkGroupBy(design.roles ?? [])).toEqual([]);
  });

  it("default-value は v1 の fixed-test に写り（v1 の型は変えない）、ほかの種類は今までどおり（Issue #533）", () => {
    const { design } = toV1(fixtureDefaultValueTable());
    const r6 = design.designs.find((entry) => entry.requirementId === "R6");
    expect(r6?.verification).toEqual({ kind: "fixed-test" });
    expect(r6?.checks).toEqual([]);
    expect(r6?.nature).toBe("ruled");
    expect(r6?.ownership).toEqual([
      { roleId: "f.item.kind", basis: "stated", reason: null },
      { roleId: "e.item", basis: "dependency", reason: "f.item.kind" },
    ]);
    // R6 を足しても、ほかの要件の写しは題材の表の写しと同じ
    const base = toV1(fixtureTable()).design.designs;
    expect(design.designs.filter((entry) => entry.requirementId !== "R6")).toEqual(base);
    expect(checkDesignOwnership(design)).toEqual([]);
  });
});
