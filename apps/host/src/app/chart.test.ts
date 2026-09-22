// @vitest-environment jsdom
//
// 棒（`bar`）と円（`pie`）のグラフの部品の component テスト（M1.4。Issue #181）。
//
// 窓口の決定（2026-09-19 の追記 3）の **7 つを、そのままテストの名前にする**——読み上げ・キーボード・
// 軸と凡例・空・多い・エラー・権限なし。加えて、**横幅 360 CSS px で崩れない**ことを確かめる。
//
// **色だけに頼らない**（`04` §7.2）。**見出しと値の両方が文字でも読める**（円は**割合（%）**も）。
// **外の部品（グラフの library）を足さない**——SVG は自分で組み、`aria-hidden="true"` にして、
// 読み上げは**表**が受け持つ。
//
// 画面（renderer）を通して描く——宣言（`widgets`）からグラフへの写像と、`enum` の見出しの表示名への
// 写し替えまで、**実際の経路**で確かめるためである（`docs/parallel-development.md` §7.3）。
// **画面は式も集計も評価しない**（`CLAUDE.md` の不変条件）。値は API が返した `groups` をそのまま出す。

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InstantRenderer } from "./renderer";
import { MANY_HEADINGS, OTHER_HEADING, PIE_TOP } from "./chart";
import type {
  ApiSpecBody,
  ApiViewBody,
  ClientErrorCode,
  ClientResult,
  MusunestClient,
} from "@musunest/sdk";

const okResult = <T,>(value: T): ClientResult<T> => ({ ok: true, value });
const errResult = (code: ClientErrorCode, status: number | null): ClientResult<never> => ({
  ok: false,
  error: { status, code, fields: [], validations: [] },
});

/** グラフの部品（棒・円）と、その値の元になる見出しごとの集計を持つ宣言 */
const CHART_SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "e".repeat(64),
  spec: {
    entities: [
      {
        name: "activity",
        fields: {
          // `enum` の見出しは、画面が宣言の `options` の表示名に写す（送るのはキー、見せるのは表示名）
          kind: { type: "enum", options: { practice: "練習", match: "試合", party: "飲み会" } },
          date: "date",
        },
      },
    ],
    views: [
      {
        name: "dashboard",
        type: "dashboard",
        widgets: [
          { type: "number", label: "今月の活動", value: "activityCount", unit: "回" },
          { type: "bar", label: "月ごとの活動回数", value: "activitiesByMonth", unit: "回" },
          { type: "pie", label: "種類の内訳", value: "activitiesByKind", unit: "回" },
        ],
      },
    ],
    actions: [{ name: "addActivity", entity: "activity" }],
    validations: [],
    computed: [
      {
        name: "activitiesByMonth",
        aggregate: {
          kind: "count",
          entity: "activity",
          name: null,
          where: {},
          groupBy: { field: "date", month: true },
          last: 6,
        },
        type: "groups",
      },
      {
        name: "activitiesByKind",
        aggregate: {
          kind: "count",
          entity: "activity",
          name: null,
          where: {},
          groupBy: { field: "kind", month: false },
        },
        type: "groups",
      },
      {
        name: "activityCount",
        scope: "app",
        aggregate: { kind: "count", entity: "activity", name: null, where: {} },
        type: "number",
      },
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

/** ダッシュボードの応答。**行を返さず**、部品の値（`scope` と `groups`）を載せる（`entity` を持たない） */
const dashboardView = (values: {
  readonly scope?: Readonly<Record<string, number | null>>;
  readonly groups?: Readonly<Record<string, readonly { heading: string; value: number | null }[] | null>>;
}): ApiViewBody => ({
  instanceId: "inst-1",
  view: "dashboard",
  fields: [],
  computed: [],
  permissions: { read: true, write: true },
  actions: [],
  rows: [],
  ...(values.scope === undefined ? {} : { scope: values.scope }),
  ...(values.groups === undefined ? {} : { groups: values.groups }),
});

const SCOPE = { activityCount: 3 } as const;

/** 棒（月）3 つと、円（種類）3 つ（1 つは求められなかった `null`）を持つ既定の応答 */
const DEFAULT_VIEW = (): ApiViewBody =>
  dashboardView({
    scope: SCOPE,
    groups: {
      activitiesByMonth: [
        { heading: "2026-08", value: 0 },
        { heading: "2026-09", value: 3 },
      ],
      activitiesByKind: [
        { heading: "practice", value: 2 },
        { heading: "match", value: 1 },
        { heading: "party", value: null },
      ],
    },
  });

function chartClient(view: ApiViewBody = DEFAULT_VIEW()): MusunestClient {
  return {
    getSpec: () => Promise.resolve(okResult(CHART_SPEC)),
    getView: () => Promise.resolve(okResult(view)),
    addRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    deleteRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    setRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
  };
}

async function renderScreen(client: MusunestClient) {
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(createElement(InstantRenderer, { instanceId: "inst-1", client }));
  });
  if (rendered === undefined) throw new Error("render できなかった");
  return rendered;
}

/** `data-chart` の部品 */
const chartOf = (container: HTMLElement, name: string): HTMLElement | null =>
  container.querySelector(`[data-chart="${name}"]`);

/** グラフの表の行（見出しと値の組）。1 行 = 棒 1 本、または円の扇形 1 つである */
const chartRows = (container: HTMLElement, name: string): HTMLElement[] =>
  Array.from(container.querySelectorAll(`[data-chart="${name}"] .chart-entry`));

/** 1 行のセル（見出し・値・割合）の文字 */
const cellsOf = (row: HTMLElement): string[] =>
  Array.from(row.querySelectorAll("th, td")).map((cell) => cell.textContent ?? "");

const cellOf = (container: HTMLElement, name: string, heading: string): string[] => {
  const row = container.querySelector<HTMLElement>(
    `[data-chart="${name}"] [data-heading="${heading}"]`,
  );
  if (row === null) throw new Error(`組 ${heading} が無い`);
  return cellsOf(row);
};

/** 見出しを 12 個（`MANY_HEADINGS` 以上）持つ組を作る。値は大きい順に振る */
const manyEntries = (count: number): readonly { heading: string; value: number }[] =>
  Array.from({ length: count }, (_item, index) => ({
    heading: `2026-${String(index + 1).padStart(2, "0")}`,
    value: count - index,
  }));

afterEach(cleanup);

describe("グラフの部品（bar・pie）（M1.4。Issue #181）", () => {
  it("読み上げ：グラフは表としても読める（見出しの列と値の列、caption に部品の名前、SVG は aria-hidden）", async () => {
    const { container } = await renderScreen(chartClient());

    await screen.findByText("月ごとの活動回数");
    for (const [name, title] of [
      ["activitiesByMonth", "月ごとの活動回数"],
      ["activitiesByKind", "種類の内訳"],
    ] as const) {
      const chart = chartOf(container, name);
      expect(chart, name).not.toBeNull();
      // 表が読み上げを受け持つ。`<caption>` に部品の名前（宣言の `label`）が入る
      const table = chart?.querySelector("table.chart-table");
      expect(table?.querySelector("caption")?.textContent, name).toBe(title);
      const head = Array.from(table?.querySelectorAll("thead th") ?? []).map((th) => th.textContent);
      expect(head?.slice(0, 2), name).toEqual(["見出し", "値"]);
      // 見出しと値は、どの行にも文字である
      for (const row of chartRows(container, name)) {
        expect(cellsOf(row).length, name).toBeGreaterThanOrEqual(2);
        expect(cellsOf(row)[1], name).not.toBe("");
      }
      // **SVG は aria-hidden である**（読み上げは表が受け持つ）
      const svg = chart?.querySelector("svg.chart-svg");
      expect(svg?.getAttribute("aria-hidden"), name).toBe("true");
    }
  });

  it("キーボード：操作の要素を作らない（見るだけの部品である）", async () => {
    const { container } = await renderScreen(chartClient());

    await screen.findByText("月ごとの活動回数");
    for (const name of ["activitiesByMonth", "activitiesByKind"]) {
      const chart = chartOf(container, name);
      const interactive = chart?.querySelectorAll("button, a, input, select, textarea, [tabindex]");
      expect(interactive?.length ?? 1, name).toBe(0);
    }
  });

  it("軸と凡例：棒は見出しと値を各棒に文字で添え、円は割合（%）も文字で出す", async () => {
    const { container } = await renderScreen(chartClient());

    await screen.findByText("月ごとの活動回数");
    // 棒は、見出しと値（単位つき）を各棒に添える（軸の目盛りは作らない）
    expect(cellOf(container, "activitiesByMonth", "2026-09")).toEqual(["2026-09", "3 回"]);
    // 月は `YYYY-MM` のまま出す
    expect(cellOf(container, "activitiesByMonth", "2026-08")).toEqual(["2026-08", "0 回"]);
    // 円は、見出し（宣言の `options` の表示名）・値・割合（%）を凡例に出す
    expect(cellOf(container, "activitiesByKind", "practice")).toEqual(["練習", "2 回", "66.7%"]);
    expect(cellOf(container, "activitiesByKind", "match")).toEqual(["試合", "1 回", "33.3%"]);
    // 求められなかった値は「—」で見せ、0 と区別する（割合も求められない）
    expect(cellOf(container, "activitiesByKind", "party")).toEqual(["飲み会", "— 回", "—"]);
  });

  it("空：「データがありません」を出し、0 の棒を描かない", async () => {
    const empty = await renderScreen(
      chartClient(
        dashboardView({
          scope: SCOPE,
          groups: { activitiesByMonth: [], activitiesByKind: [] },
        }),
      ),
    );
    // 組が 1 つも無ければ、グラフを描かずに「データがありません」を出す（0 の棒を描かない）
    await screen.findAllByText("データがありません");
    expect(chartOf(empty.container, "activitiesByMonth")?.getAttribute("data-state")).toBe("empty");
    expect(chartRows(empty.container, "activitiesByMonth")).toEqual([]);
    cleanup();

    // 値が 0 の棒は描かない（見出しと値は文字で残す）
    const withZero = await renderScreen(chartClient());
    await screen.findByText("月ごとの活動回数");
    const bars = chartOf(withZero.container, "activitiesByMonth");
    expect(bars?.querySelector('[data-bar="2026-08"]')).toBeNull();
    expect(bars?.querySelector('[data-bar="2026-09"]')).not.toBeNull();
    expect(cellOf(withZero.container, "activitiesByMonth", "2026-08")).toEqual(["2026-08", "0 回"]);
  });

  it("多い：見出しが 12 個以上なら、棒は縦に積み、円は上位 8 つと「その他」にまとめる", async () => {
    // ちょうど 12 個（`MANY_HEADINGS`）——ここから「多い」である。値は大きい順に振る
    const entries = manyEntries(MANY_HEADINGS);
    const { container } = await renderScreen(
      chartClient(
        dashboardView({
          scope: SCOPE,
          groups: { activitiesByMonth: entries, activitiesByKind: entries },
        }),
      ),
    );

    await screen.findByText("月ごとの活動回数");
    // 棒は上限を置かない——見出しが多いときも、全部を縦に積む（横に流さない）
    const bar = chartOf(container, "activitiesByMonth");
    expect(bar?.getAttribute("data-state")).toBe("many");
    expect(chartRows(container, "activitiesByMonth")).toHaveLength(entries.length);
    expect(bar?.querySelector(".table-scroll")).toBeNull();

    // 円は上位 `PIE_TOP` つと「その他」にまとめる（**捨てずに合算する**）
    const pie = chartOf(container, "activitiesByKind");
    expect(pie?.getAttribute("data-state")).toBe("many");
    const pieRows = chartRows(container, "activitiesByKind");
    expect(pieRows).toHaveLength(PIE_TOP + 1);

    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const rest = entries.slice(PIE_TOP).reduce((sum, entry) => sum + entry.value, 0);
    const first = pieRows[0];
    const other = pieRows[PIE_TOP];
    if (first === undefined || other === undefined) throw new Error("円の組が足りない");
    // まとめても、上位 8 つ（値の大きい順）はそのまま出る
    expect(cellsOf(first)).toEqual([
      entries[0]?.heading ?? "",
      `${entries[0]?.value ?? 0} 回`,
      `${Math.round(((entries[0]?.value ?? 0) / total) * 1000) / 10}%`,
    ]);
    expect(other.getAttribute("data-heading")).toBe("__other__");
    expect(cellsOf(other)).toEqual([
      OTHER_HEADING,
      `${rest} 回`,
      `${Math.round((rest / total) * 1000) / 10}%`,
    ]);
  });

  it("エラー：部品の値が null なら「—」を出す（0 と区別する）", async () => {
    const { container } = await renderScreen(
      chartClient(
        dashboardView({
          scope: SCOPE,
          groups: {
            activitiesByMonth: null,
            activitiesByKind: [{ heading: "practice", value: 0 }],
          },
        }),
      ),
    );

    await screen.findByText("月ごとの活動回数");
    const chart = chartOf(container, "activitiesByMonth");
    expect(chart?.getAttribute("data-state")).toBe("error");
    expect(chart?.textContent).toContain("—");
    // 求められなかった値は、空の並びに読み替えない（表を描かない）
    expect(chart?.querySelector(".chart-table")).toBeNull();
    // もう一方の部品は、そのまま描ける（部品ごとに状態は決まる）
    expect(chartOf(container, "activitiesByKind")?.getAttribute("data-state")).toBe("ready");
  });

  it("エラー：値を載せる groups が無ければ「集計の値を表示できません」を出す（空の並びに読み替えない）", async () => {
    // 宣言は棒・円の部品を持つが、応答に `groups` の欄そのものが無い（配信された応答の不整合である）
    const { container } = await renderScreen(chartClient(dashboardView({ scope: SCOPE })));

    await screen.findByText("集計の値を表示できません");
    expect(container.querySelector('[data-state="dashboardUnavailable"]')).not.toBeNull();
    expect(container.querySelector(".chart")).toBeNull();
  });

  it("権限なし：read が無ければ 403 の理由を出し、グラフを描かない", async () => {
    const client: MusunestClient = {
      ...chartClient(),
      getSpec: () => Promise.resolve(errResult("PERMISSION_DENIED", 403)),
    };
    const { container } = await renderScreen(client);

    await screen.findByText("このアプリを表示する権限がありません");
    expect(container.querySelector('[data-state="forbidden"]')).not.toBeNull();
    expect(container.querySelector(".chart")).toBeNull();
  });
});

describe("グラフの幅 360 CSS px（機械で見られる範囲。04 §7.2）", () => {
  it("グラフは横に流さず、幅を親に合わせる（ページ全体を押し広げない）", async () => {
    const { container } = await renderScreen(chartClient());

    await screen.findByText("月ごとの活動回数");
    // 横に流す入れ物（`.table-scroll`）を作らない
    expect(container.querySelector(".chart .table-scroll")).toBeNull();

    const styleOf = (selector: string): string =>
      (container.querySelector(selector) as HTMLElement | null)?.getAttribute("style") ?? "";
    expect(styleOf(".chart")).toContain("max-width: 100%");
    expect(styleOf(".chart-table")).toContain("max-width: 100%");
    expect(styleOf(".chart-svg")).toContain("max-width: 100%");
  });
});
