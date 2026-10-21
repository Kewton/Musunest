// 名前の表の v1 の型への写し（v11a/convert.ts）の unit テスト（07-architecture-v1.1a.md §2.2。Issue #505）。
//
// 写しは決定的で、恒等の対応が全行、month の groupBy は null・enum は項目の id、nature は表の分類、語彙・置き場所・
// 書けない部分は空、写した設計は v1 の `checkDesignOwnership`・`checkGroupBy` で問題 0 であることを固定する。
import { describe, expect, it } from "vitest";
import { checkDesignOwnership, checkGroupBy } from "../stages/design.js";
import {
  LEDGER_VIEW_2A,
  LEDGER_VIEW_2C,
  fixtureDefaultValueTable,
  fixtureEnumMembershipTable,
  fixtureNonRequirementTable,
  fixtureTable,
  withAggregates,
  withCheckTargets,
} from "./__tests__/fixtures.js";
import { UNCONVERTIBLE_VERIFICATION_KIND_MESSAGE, identityMappings, toRoleEntries, toV1 } from "./convert.js";
import type { NameTable } from "./names.js";
import { PROPERTY_LEDGER_VIEW, type UpstreamLedgerView } from "../v12/ledger.js";

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

describe("確かめ方の種類の写しを台帳から導く（Issue #548）", () => {
  it("enum-membership は v1 の fixed-test に写り（v1 の型は変えない）、ほかの要件の写しは題材の表と深く等しい", () => {
    const design = toV1(fixtureEnumMembershipTable()).design;
    const r6 = design.designs.find((entry) => entry.requirementId === "R6");
    expect(r6?.verification).toEqual({ kind: "fixed-test" });
    expect(r6?.nature).toBe("ruled");
    expect(r6?.checks).toEqual([]);
    expect(design.designs.filter((entry) => entry.requirementId !== "R6")).toEqual(toV1(fixtureTable()).design.designs);
    expect(checkDesignOwnership(design)).toEqual([]);
  });

  it("既知の種類（fixed-test・structural・unresolved・default-value）の写しは今と深く等しい（台帳を省く・手 2a の台帳・今の台帳で同じ）", () => {
    for (const table of [fixtureTable(), fixtureDefaultValueTable()]) {
      const now = toV1(table);
      expect(toV1(table, PROPERTY_LEDGER_VIEW)).toEqual(now);
      expect(toV1(table, LEDGER_VIEW_2A)).toEqual(now);
    }
    expect(toV1(fixtureDefaultValueTable()).design.designs.map((entry) => entry.verification)).toEqual([
      { kind: "fixed-test" },
      { kind: "structural", reason: "画面に出ることだけを求める" },
      { kind: "fixed-test" },
      { kind: "fixed-test" },
      { kind: "unresolved", reason: "宣言で書けない" },
      { kind: "fixed-test" },
    ]);
  });

  it("二点測定：台帳に無い種類は写さず固定文の例外で落ちる（enum-membership も手 2a の台帳では落ちる。値を埋めない）", () => {
    const withKind = (kind: string): NameTable => {
      const table = fixtureEnumMembershipTable();
      return {
        ...table,
        verification: table.verification.map((entry) =>
          entry.requirementId === "R6" ? ({ requirementId: "R6", kind } as unknown as NameTable["verification"][number]) : entry,
        ),
      };
    };
    expect(() => toV1(fixtureEnumMembershipTable(), LEDGER_VIEW_2A)).toThrow(UNCONVERTIBLE_VERIFICATION_KIND_MESSAGE);
    expect(() => toV1(fixtureEnumMembershipTable(), PROPERTY_LEDGER_VIEW)).not.toThrow();
    for (const kind of ["no-such-kind", "state-after-set"]) {
      expect(() => toV1(withKind(kind))).toThrow(UNCONVERTIBLE_VERIFICATION_KIND_MESSAGE);
      expect(UNCONVERTIBLE_VERIFICATION_KIND_MESSAGE).not.toContain(kind);
    }
  });
});

describe("計算の行の集計の種類と集計元（aggregate。旗 on。Issue #549）は v1 の型への写しに載らない", () => {
  it("aggregate を持つ表の写しは、持たない表の写しと深く等しい（RoleEntry に欄が無く、表の外に残る）", () => {
    const plain = fixtureTable();
    const aggregated = withAggregates(plain);
    // 前提：表は aggregate の分だけ違う
    expect(aggregated).not.toEqual(plain);
    expect(toV1(aggregated)).toEqual(toV1(plain));
    expect(toV1(aggregated, PROPERTY_LEDGER_VIEW)).toEqual(toV1(plain, PROPERTY_LEDGER_VIEW));
    expect(toRoleEntries(aggregated)).toEqual(toRoleEntries(plain));
    expect(JSON.stringify(toV1(aggregated))).not.toContain('"aggregate":{');
    expect(identityMappings(aggregated)).toEqual(identityMappings(plain));
  });
});

describe("要件でない文（non-requirement。旗 on。Issue #550）の v1 の型への写し", () => {
  it("確かめ方は fixed-test として写り（台帳から入る。v1 の型は変えない）、所属は 0 行のまま。ほかの要件の写しは題材の表と同じ", () => {
    const table = fixtureNonRequirementTable();
    const converted = toV1(table, PROPERTY_LEDGER_VIEW);
    const design = converted.design.designs.find((entry) => entry.requirementId === "R6");
    expect(design?.verification).toEqual({ kind: "fixed-test" });
    expect(converted.ownership.find((entry) => entry.requirementId === "R6")?.ownership ?? []).toEqual([]);
    expect(converted.design.designs.filter((entry) => entry.requirementId !== "R6")).toEqual(toV1(fixtureTable()).design.designs);
    expect(converted.mappings).toEqual(toV1(fixtureTable()).mappings);
  });

  it("二点測定：#549 の台帳（non-requirement が無い）では写さず固定文の例外で落ちる", () => {
    expect(() => toV1(fixtureNonRequirementTable(), LEDGER_VIEW_2C)).toThrow(UNCONVERTIBLE_VERIFICATION_KIND_MESSAGE);
    expect(() => toV1(fixtureNonRequirementTable(), PROPERTY_LEDGER_VIEW)).not.toThrow();
  });
});

describe("旗 v12.ids の構造の検査の対象（Issue #594）", () => {
  it("v1 の型への写しは検査の種類の並びだけを写し（v1 の checks の形は変えない）、対象の無い表と同じ v1 の値になる", () => {
    const table = fixtureTable();
    const withTargets = withCheckTargets(table);
    expect(withTargets.verification.find((entry) => entry.requirementId === "R2")).toMatchObject({ targets: [{ check: "view-shows" }] });
    const converted = toV1(withTargets);
    expect(converted.design.designs.find((entry) => entry.requirementId === "R2")?.checks).toEqual(["view-shows"]);
    expect(converted).toEqual(toV1(table));
  });
});

// ── 上流の台帳の見方で受ける（読み漏れの検出。Issue #712）──────────────

/** 2 つの型が互いに代入できる（同じ型）なら true */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("読み漏れの検出：確かめ方の変換は台帳を上流の見方で受ける（Issue #712）", () => {
  it("変換の台帳の型が上流の見方で、一覧の外の欄（評価の方法の表・生の行）を読めない", () => {
    const same: true = true satisfies SameType<NonNullable<Parameters<typeof toV1>[1]>, UpstreamLedgerView>;
    const ledger: NonNullable<Parameters<typeof toV1>[1]> = PROPERTY_LEDGER_VIEW;
    // @ts-expect-error 変換の台帳は評価の方法の表を持たない
    void ledger.combinations;
    // @ts-expect-error 変換の台帳は生の行を持たない
    void ledger.rows;
    expect(same).toBe(true);
    expect([...ledger.rowByVerificationKind.keys()]).toEqual([...PROPERTY_LEDGER_VIEW.rowByVerificationKind.keys()]);
  });
});
