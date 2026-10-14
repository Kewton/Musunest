// Plan の開いている事項（open_issues）の、解決の対象と衝突の**純粋な関数**の unit テスト（Issue #460）。
//
// **値の中身を持ち込まない。** ここで確かめるのは、同じ ID の行の件数と状態だけで決まる有限の結果と、
// 同じ ID の行が 2 つ以上あれば（状態・文・重大度・対応する要件に関わらず）衝突と報告することである。
import { describe, expect, it } from "vitest";
import type { PlanOpenIssue } from "@musunest/appspec-schema";
import {
  classifyOpenIssueConflict,
  detectOpenIssueCollisions,
  resolveTargetOf,
  type PlanOpenIssueOrigin,
  type PlanOpenIssueRowAttribution,
} from "./open-issues.js";

/** 同じ ID の行を 1 つ作る（既定は open。欄を上書きして負例を作る） */
function rowOf(overrides: Partial<PlanOpenIssue> = {}): PlanOpenIssue {
  return { id: "X", text: "事項", critical: true, status: "open", ...overrides };
}

describe("解決の対象を、同じ ID の open の行の件数から決める（Issue #460）", () => {
  it("同じ ID の行が 0・1・2 行以上 × 状態 open／resolved の全組合せを機械で生成し、ちょうど 1 つの結果に落ちる", () => {
    const kinds = new Set<string>();
    // 行数 0〜3。各行を open／resolved のすべての組合せにする（open の行の件数だけで結果が決まる）
    for (let length = 0; length <= 3; length += 1) {
      for (let mask = 0; mask < 2 ** length; mask += 1) {
        const rows = Array.from({ length }, (_value, index) => {
          const open = (mask & (1 << index)) !== 0;
          return open ? rowOf() : rowOf({ status: "resolved", resolution: { reason: "r" } });
        });
        const openIndexes = rows.flatMap((row, index) => (row.status === "open" ? [index] : []));
        const target = resolveTargetOf(rows, "X");
        kinds.add(target.kind);
        // 各入力は、ちょうど 1 つの結果に落ちる
        if (openIndexes.length === 0) {
          expect(target.kind).toBe("none");
        } else if (openIndexes.length === 1) {
          expect(target).toEqual({ kind: "one", index: openIndexes[0] });
        } else {
          expect(target).toEqual({ kind: "multiple", count: openIndexes.length });
        }
      }
    }
    // 3 つの有限の結果がすべて現れる
    expect([...kinds].sort()).toEqual(["multiple", "none", "one"]);
  });

  it("[resolved(X), open(X)] に X の答えを当てると、open の行だけが対象になり、resolved の行は書き換えない", () => {
    const rows = [rowOf({ status: "resolved", resolution: { reason: "前の根拠" } }), rowOf()];
    const target = resolveTargetOf(rows, "X");
    expect(target).toEqual({ kind: "one", index: 1 });
    // 解決済みの行（index 0）は対象にしない（前の resolution を保つ）
    expect(target.kind === "one" && rows[target.index]?.status).toBe("open");
  });

  it("[open(X), open(X)] はどちらの行も対象にしない（黙って片方を選ばない）", () => {
    const rows = [rowOf(), rowOf()];
    expect(resolveTargetOf(rows, "X")).toEqual({ kind: "multiple", count: 2 });
  });

  it("別の ID の行は対象にしない（0 行として扱う）", () => {
    expect(resolveTargetOf([rowOf({ id: "Y" })], "X")).toEqual({ kind: "none" });
  });
});

describe("同じ ID の行が 2 つ以上あれば、状態・文・重大度・対応する要件に関わらず衝突と報告する（Issue #460）", () => {
  it("同じ ID の行が 2 つあれば、衝突として報告する（1 行に畳まない）", () => {
    expect(detectOpenIssueCollisions([rowOf(), rowOf()])).toEqual([{ existingIndex: 0, addedIndex: 1 }]);
  });

  it("同じ ID の行が 3 つあれば、あとの 2 つをそれぞれ衝突にする", () => {
    expect(detectOpenIssueCollisions([rowOf(), rowOf(), rowOf()])).toEqual([
      { existingIndex: 0, addedIndex: 1 },
      { existingIndex: 0, addedIndex: 2 },
    ]);
  });

  it("負例：文・重大度・状態・resolution が違っても、同じ ID なら衝突になる", () => {
    const rows = [
      rowOf({ text: "A", critical: true, status: "open" }),
      rowOf({ text: "B", critical: false, status: "resolved", resolution: { decision_id: "d" } }),
    ];
    expect(detectOpenIssueCollisions(rows)).toEqual([{ existingIndex: 0, addedIndex: 1 }]);
  });

  it("負例：内容が完全に同じ 2 行でも、畳まずに衝突になる", () => {
    const same = rowOf();
    expect(detectOpenIssueCollisions([same, { ...same }])).toEqual([{ existingIndex: 0, addedIndex: 1 }]);
  });

  it("負例：既存が resolved の同じ ID でも、衝突になる", () => {
    const rows = [rowOf({ status: "resolved", resolution: { answer_id: "A:1" } }), rowOf()];
    expect(detectOpenIssueCollisions(rows)).toEqual([{ existingIndex: 0, addedIndex: 1 }]);
  });

  it("ID が違えば、内容が同じでも衝突にしない", () => {
    expect(detectOpenIssueCollisions([rowOf({ id: "X" }), rowOf({ id: "Y" })])).toEqual([]);
  });

  it("行が 0・1 件なら衝突は無い", () => {
    expect(detectOpenIssueCollisions([])).toEqual([]);
    expect(detectOpenIssueCollisions([rowOf()])).toEqual([]);
  });
});

// ── Issue #464：衝突した 2 行の帰属を、足した順によらず組にする ─────────────────────

describe("衝突した 2 行の帰属（由来・状態・今回か以前か）を、足した順によらず組にする（Issue #464）", () => {
  /** 帰属 1 つを作る（既定は open・以前の往復） */
  function attr(
    origin: PlanOpenIssueOrigin,
    status: "open" | "resolved" = "open",
    current = false,
  ): PlanOpenIssueRowAttribution {
    return { origin, status, current };
  }

  it("通常の目録の行どうしの衝突と、通常の目録の行と引き継ぎの行の衝突は、別の組になる", () => {
    const catalogCatalog = classifyOpenIssueConflict(attr("catalog"), attr("catalog"));
    const catalogInherit = classifyOpenIssueConflict(attr("catalog"), attr("inherit"));
    // 由来の組が違えば、別の組になる
    expect(catalogCatalog).not.toEqual(catalogInherit);
    expect(catalogInherit).toEqual({ first: attr("catalog"), second: attr("inherit") });
  });

  it("足した順によらない（existing と added を入れ替えても同じ組になる）", () => {
    const forward = classifyOpenIssueConflict(attr("catalog", "open", false), attr("inherit", "resolved", true));
    const backward = classifyOpenIssueConflict(attr("inherit", "resolved", true), attr("catalog", "open", false));
    expect(forward).toEqual(backward);
    // 状態（open／resolved）と、作った往復が今回か以前かも、組に残る
    expect(forward).toEqual({ first: attr("catalog", "open", false), second: attr("inherit", "resolved", true) });
  });

  it("同じ由来でも、状態や今回か以前かが違えば別の組になる", () => {
    const openBoth = classifyOpenIssueConflict(attr("surface"), attr("surface"));
    const oneResolved = classifyOpenIssueConflict(attr("surface"), attr("surface", "resolved"));
    const oneCurrent = classifyOpenIssueConflict(attr("surface"), attr("surface", "open", true));
    expect(openBoth).not.toEqual(oneResolved);
    expect(oneResolved).not.toEqual(oneCurrent);
  });

  it("衝突の検出（detectOpenIssueCollisions）の結果を、そのまま帰属の組に写せる", () => {
    const rows = [rowOf({ id: "X" }), rowOf({ id: "X" })];
    const collisions = detectOpenIssueCollisions(rows);
    expect(collisions).toEqual([{ existingIndex: 0, addedIndex: 1 }]);
    const group = classifyOpenIssueConflict(attr("catalog"), attr("surface", "open", true));
    expect(group.first.origin).toBe("catalog");
    expect(group.second.origin).toBe("surface");
  });
});
