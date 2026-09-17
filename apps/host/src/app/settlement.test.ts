// @vitest-environment jsdom
//
// 精算の表示の unit（M1.2。Issue #142）。**計算はしない**——API が返した送金の並びを、名前に対応づけて
// 見せるだけである（workspace/mvp/m1/03-spec-layers-and-checker.md §2.3）。ここで見るのは 5 つ。
//   1. 送金元・送金先の ID を名前に写し、**`C さん → A さん 3,000 円`** の 1 件として出す
//   2. 額は整数円で、3 桁の区切りを入れる（丸めない）
//   3. 空の並び（送金が要らない）は「送金は要りません」。`null`（読めなかった）と混ぜない
//   4. 名前を引けない ID は、消さずにそのまま出す
//   5. 行が多いときも全部を縦に並べる（360 CSS px の幅は renderer.css の規則で確かめる）
// 画面全体の状態（権限不足など）と、宣言とのつなぎは renderer.test.ts が見る。

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiRow, ApiTransfer } from "@musunest/sdk";
import { SettlementList } from "./settlement";

/** 精算に現れる人のレコード（ID から名前を引くのに使う） */
const member = (id: string, name: string): ApiRow => ({
  id,
  createdAt: "2026-09-16T12:00:00+09:00",
  updatedAt: "2026-09-16T12:00:00+09:00",
  fields: { name },
  computed: {},
});

const MEMBERS = [member("m1", "A"), member("m2", "B"), member("m3", "C")];

type Transfer = ApiTransfer;

const renderList = (
  transfers: readonly Transfer[] | null,
  rows: readonly ApiRow[] = MEMBERS,
  labelField: string | null = "name",
) => render(createElement(SettlementList, { transfers, rows, labelField }));

afterEach(cleanup);

describe("精算の表示（M1.2）", () => {
  it("送金元・送金先の ID を名前に写し、1 件を 1 行で見せる（受入条件）", () => {
    const { container } = renderList([{ from: "m3", to: "m1", amount: 3000 }]);

    const items = container.querySelectorAll(".settlement li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe("C さん → A さん 3,000 円");
    // ID は画面に出さない
    expect(container.textContent).not.toContain("m3");
  });

  it("金額は整数円で、3 桁の区切りを入れる（丸めない）", () => {
    const { container } = renderList([
      { from: "m1", to: "m2", amount: 1234567 },
      { from: "m3", to: "m1", amount: 0 },
    ]);

    const items = container.querySelectorAll(".settlement li");
    expect(items[0]?.textContent).toBe("A さん → B さん 1,234,567 円");
    expect(items[1]?.textContent).toBe("C さん → A さん 0 円");
  });

  it("空の並びは「送金は要りません」を出す（0 円の行は作らない）", () => {
    const { container } = renderList([]);

    expect(screen.getByText("送金は要りません")).toBeDefined();
    expect(container.querySelector('[data-state="settlementEmpty"]')).not.toBeNull();
    expect(container.querySelectorAll(".settlement li")).toHaveLength(0);
  });

  it("null（読めなかった）を、空の並びに読み替えない", () => {
    const { container } = renderList(null);

    expect(screen.getByText("精算の結果を表示できません")).toBeDefined();
    expect(container.querySelector('[data-state="settlementUnavailable"]')).not.toBeNull();
    expect(screen.queryByText("送金は要りません")).toBeNull();
  });

  it("名前を引けない ID は、消さずにそのまま出す", () => {
    const { container } = renderList([{ from: "m9", to: "m1", amount: 500 }]);

    expect(container.querySelector(".settlement li")?.textContent).toBe("m9 さん → A さん 500 円");
  });

  it("名前に使う項目が無ければ、ID をそのまま出す（分かる範囲を見せる）", () => {
    const { container } = renderList([{ from: "m3", to: "m1", amount: 3000 }], MEMBERS, null);

    expect(container.querySelector(".settlement li")?.textContent).toBe("m3 さん → m1 さん 3,000 円");
  });

  it("行が多いときも、全部を縦に並べる（読める形を崩さない）", () => {
    // 実際の精算では、組（送金元・送金先）は互いに異なる（同じ 2 人の間に 2 件は出ない。
    // docs/semantics.md「settle」）。ここもその形で作る
    const many: readonly Transfer[] = manyTransfers(30);
    const { container } = renderList(many, MEMBERS, null);

    expect(container.querySelectorAll(".settlement li")).toHaveLength(30);
    expect(container.querySelector(".settlement")?.textContent).toContain("30,000 円");
  });
});

/** `count` 件の送金。組（送金元・送金先）は互いに異なる */
function manyTransfers(count: number): readonly Transfer[] {
  return Array.from({ length: count }, (_item, index) => ({
    from: `m${index + 2}`,
    to: "m1",
    amount: (index + 1) * 1000,
  }));
}
