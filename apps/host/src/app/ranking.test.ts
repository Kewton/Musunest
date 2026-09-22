// @vitest-environment jsdom
//
// 順位の部品（`type: ranking`）の component テスト（M1.4。Issue #182）。
//
// 見るのは 3 つである。
//   1. **API が並べた順をそのまま出す**——`by` の降順（同数は登録した順）は API が決める。**画面は並べ替えない**
//      （受入条件）。出す項目は宣言の `show` の順で、`null` の値は「—」で見せる（0 と区別する）
//   2. **4 つの状態**（空・多い・エラー・権限なし）をそれぞれ描く（`04-spec-evolution.md` §7.3）
//   3. **横幅 360 CSS px で崩れない**——行は折り返し、横には流さない（同 §7.2。jsdom は layout を
//      持たないので、CSS の指定（inline style）で確かめる＝機械で測れる分）
//
// **画面は式も集計も評価しない。** 値は Data API が並べて返した行（`ApiRow`）をそのまま見せるだけである
// （`CLAUDE.md` の不変条件）。権限なし（`read` が無い）は API が 403 を返し、画面（renderer）がその理由を出す。

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Ranking } from "./ranking";
import type { RankingPart } from "./ranking";
import { InstantRenderer } from "./renderer";
import type {
  ApiRow,
  ApiSpecBody,
  ClientErrorCode,
  ClientResult,
  MusunestClient,
} from "@musunest/sdk";

const okResult = <T,>(value: T): ClientResult<T> => ({ ok: true, value });
const errResult = (code: ClientErrorCode, status: number | null): ClientResult<never> => ({
  ok: false,
  error: { status, code, fields: [], validations: [] },
});

/** 順位の部品（宣言の `widgets` の 1 つ） */
const PART: RankingPart = {
  type: "ranking",
  name: "topActivities",
  label: "参加の多い活動",
  entity: "activity",
  by: "attendeeCount",
  show: ["date", "kind", "attendeeCount"],
};

/** 1 行（`ApiRow` と同じ形。`attendeeCount` は行ごとの計算である） */
function makeRow(id: string, kind: string, date: string, count: number | null): ApiRow {
  return {
    id,
    createdAt: "2026-09-15T12:00:00+09:00",
    updatedAt: "2026-09-15T12:00:00+09:00",
    fields: { kind, date, attendees: [] },
    computed: { attendeeCount: count },
  };
}

/** API が並べて返す行（`by` の降順。同数は登録した順） */
const ROWS: readonly ApiRow[] = [
  makeRow("r1", "practice", "2026-09-10", 3),
  makeRow("r2", "party", "2026-09-12", 2),
  makeRow("r3", "match", "2026-09-14", 1),
];

async function renderRanking(rows: readonly ApiRow[] | null | undefined) {
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(createElement(Ranking, { part: PART, rows }));
  });
  if (rendered === undefined) throw new Error("render できなかった");
  return rendered;
}

/** 描いた行の位置（`data-rank`）を、上から順に読む */
const ranksOf = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll(".ranking-row")].map((row) => row.getAttribute("data-rank"));

/** その位置の行の、出す項目の値（`show` の順）を読む */
const valuesOf = (container: HTMLElement, rank: number): string[] =>
  [...container.querySelectorAll(`.ranking-row[data-rank="${rank}"] .ranking-cell-value`)].map(
    (cell) => cell.textContent ?? "",
  );

afterEach(cleanup);

describe("順位の部品が出すもの", () => {
  it("API が並べた順をそのまま出す（画面は並べ替えない。受入条件）", async () => {
    const { container } = await renderRanking(ROWS);

    // `show` の順（date・kind・attendeeCount）で出す。**順は API が決めた順のまま**である
    expect(ranksOf(container)).toEqual(["1", "2", "3"]);
    expect(valuesOf(container, 1)).toEqual(["2026-09-10", "practice", "3"]);
    expect(valuesOf(container, 2)).toEqual(["2026-09-12", "party", "2"]);
    expect(valuesOf(container, 3)).toEqual(["2026-09-14", "match", "1"]);
    // 見出しは宣言の `label` である
    expect(container.querySelector(".ranking h3")?.textContent).toBe("参加の多い活動");
  });

  it("求められなかった値（計算の null）は「—」で見せ、0 と区別する", async () => {
    const { container } = await renderRanking([makeRow("r1", "practice", "2026-09-10", null)]);

    expect(valuesOf(container, 1)).toEqual(["2026-09-10", "practice", "—"]);
  });

  it("`label` を書かない部品は、鍵（`name`）を見出しにする", async () => {
    // `exactOptionalPropertyTypes` があるので、`label: undefined` ではなく**欄そのものを省く**
    const withoutLabel: RankingPart = {
      type: "ranking",
      name: "topActivities",
      entity: "activity",
      by: "attendeeCount",
      show: ["date", "kind", "attendeeCount"],
    };
    const { container } = await render(createElement(Ranking, { part: withoutLabel, rows: ROWS }));

    expect(container.querySelector(".ranking h3")?.textContent).toBe("topActivities");
  });

  it("見出しに表示名（`label`）を渡せば、それを使う", async () => {
    const { container } = await render(
      createElement(Ranking, { part: PART, rows: ROWS, displayName: (name) => `＜${name}＞` }),
    );

    expect(
      container.querySelector('.ranking-row[data-rank="1"] .ranking-cell-name')?.textContent,
    ).toBe("＜date＞");
  });
});

describe("順位の部品の 4 つの状態（04 §7.3）", () => {
  it("空：行が 1 件も無ければ「該当がありません」を出す（`null` と区別する）", async () => {
    const { container } = await renderRanking([]);

    await screen.findByText("該当がありません");
    expect(container.querySelector('.ranking[data-state="empty"]')).not.toBeNull();
    expect(container.querySelectorAll(".ranking-row")).toHaveLength(0);
  });

  it("多い：上限を置かず、すべての行を折り返して並べる（受入条件）", async () => {
    const many = Array.from({ length: 30 }, (_item, index) =>
      makeRow(`r${index + 1}`, "practice", "2026-09-10", 30 - index),
    );
    const { container } = await renderRanking(many);

    // 上限を置かない（30 行とも描く）。**切るのは API の `limit` の仕事である**。状態だけを伝える
    expect(container.querySelectorAll(".ranking-row")).toHaveLength(30);
    expect(container.querySelector('.ranking[data-state="many"]')).not.toBeNull();
  });

  it("エラー：順位を求められなかった（`null`）ときは「順位を表示できません」を出す", async () => {
    const { container } = await renderRanking(null);

    await screen.findByText("順位を表示できません");
    expect(container.querySelector('[data-state="rankingUnavailable"]')).not.toBeNull();
    expect(container.querySelectorAll(".ranking-row")).toHaveLength(0);
  });

  it("エラー：順位を載せる欄そのものが無い（`undefined`）ときも同じである", async () => {
    const { container } = await renderRanking(undefined);

    await screen.findByText("順位を表示できません");
    expect(container.querySelector('[data-state="rankingUnavailable"]')).not.toBeNull();
  });

  it("権限なし：read が無ければ 403 の理由を出す（守りは data-api 側にある）", async () => {
    // 宣言は正しいが、一覧の取得が PERMISSION_DENIED になる（`read` の宣言が無い）
    const client: MusunestClient = {
      getSpec: () => Promise.resolve(okResult(RANKING_SPEC)),
      getView: () => Promise.resolve(errResult("PERMISSION_DENIED", 403)),
      addRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
      deleteRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
      setRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    };
    let rendered: ReturnType<typeof render> | undefined;
    await act(async () => {
      rendered = render(createElement(InstantRenderer, { instanceId: "inst-1", client }));
    });
    const container = rendered?.container;
    if (container === undefined) throw new Error("render できなかった");

    await screen.findByText("このアプリを表示する権限がありません");
    expect(container.querySelector('[data-state="forbidden"]')).not.toBeNull();
    expect(container.querySelector(".ranking")).toBeNull();
  });
});

describe("幅 360 CSS px（機械で見られる範囲。04 §7.2）", () => {
  it("行は折り返し、横には流さない（ページ全体を押し広げない。受入条件）", async () => {
    const { container } = await renderRanking(ROWS);

    // 横に流す入れ物（`.table-scroll`）を作らない
    expect(container.querySelector(".ranking .table-scroll")).toBeNull();

    // jsdom は layout を持たないので、幅の指定は style で確かめる（04 §7.2「機械で測れる分」）
    const styleOf = (selector: string): string =>
      (container.querySelector(selector) as HTMLElement | null)?.getAttribute("style") ?? "";
    expect(styleOf(".ranking")).toContain("max-width: 100%");
    expect(styleOf(".ranking-row")).toContain("flex-wrap: wrap");
    expect(styleOf(".ranking-row")).toContain("min-width: 0");
    expect(styleOf(".ranking-row")).toContain("max-width: 100%");
  });
});

/** 順位の部品を 1 つ持つダッシュボードの宣言（権限なしの状態を見るのに使う） */
const RANKING_SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "f".repeat(64),
  spec: {
    entities: [{ name: "activity", fields: { date: "date", kind: "string", attendees: "list" } }],
    views: [
      {
        name: "dashboard",
        type: "dashboard",
        widgets: [PART],
      },
    ],
    actions: [{ name: "addActivity", entity: "activity" }],
    validations: [],
    computed: [
      { name: "attendeeCount", entity: "activity", expression: "len(attendees)", type: "number" },
    ],
    permissions: [
      { name: "read", subject: "minIdentity" },
      { name: "write", subject: "minIdentity" },
    ],
    minIdentity: { mode: "anonymous" },
  },
  permissions: { read: true, write: true },
  actions: [{ name: "addActivity", entity: "activity" }],
};
