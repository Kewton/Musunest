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

// ── 表示名（label）と選択肢の表示名（M1.4。Issue #204） ──────────────────────
//
// 順位の部品は**別の entity の行**を並べる。ダッシュボードは `entity` を持たないので応答に `labels` が
// 載らず、画面は**手元にある宣言（`getSpec`）**から、並べる entity の項目・計算の表示名と、選択肢
// （`enum`）の `options` の表示名を引く。**値の写し方は一覧・ボードと同じ処理（`displayOf`）を通る**
// ——順位の部品の中に写し方の表や分岐を書かない。`ref` はこの Issue では ID のままである。

/** 表示名（`label`）を持つ宣言。`memo` だけは `label` を書かない（識別子のまま出ることを見る） */
const LABELED_SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "a".repeat(64),
  spec: {
    entities: [
      { name: "member", fields: { name: "string" } },
      {
        name: "activity",
        fields: {
          kind: {
            type: "enum",
            label: "種類",
            options: { practice: "練習", match: "試合", party: "飲み会" },
          },
          date: { type: "date", label: "日付" },
          attendees: { type: "list", of: "member", label: "参加した人" },
          cost: { type: "number", label: "費用" },
          memo: "string",
        },
      },
    ],
    views: [
      {
        name: "dashboard",
        type: "dashboard",
        widgets: [
          {
            type: "ranking",
            name: "topActivities",
            label: "参加の多い活動",
            entity: "activity",
            by: "attendeeCount",
            show: ["date", "kind", "attendeeCount", "memo"],
          },
        ],
      },
    ],
    actions: [{ name: "addActivity", entity: "activity" }],
    validations: [],
    computed: [
      {
        name: "attendeeCount",
        entity: "activity",
        expression: "len(attendees)",
        type: "number",
        label: "参加人数",
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

/** 選択肢（`kind`）を含む行。`attendeeCount` は行ごとの計算である */
const LABELED_RANKING: ApiViewBody = {
  instanceId: "inst-1",
  view: "dashboard",
  fields: [],
  computed: [],
  permissions: { read: true, write: true },
  actions: [],
  rows: [],
  ranking: {
    topActivities: [
      {
        id: "a1",
        createdAt: "2026-09-15T12:00:00+09:00",
        updatedAt: "2026-09-15T12:00:00+09:00",
        fields: { kind: "practice", date: "2026-09-10", attendees: [], cost: 2000, memo: "駅前" },
        computed: { attendeeCount: 3 },
      },
    ],
  },
};

/** 宣言と応答を渡して画面を描く（`getSpec` の宣言から表示名を引く道を通す） */
async function renderDashboard(spec: ApiSpecBody, view: ApiViewBody): Promise<HTMLElement> {
  const client: MusunestClient = {
    getSpec: () => Promise.resolve(okResult(spec)),
    getView: () => Promise.resolve(okResult(view)),
    addRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    deleteRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    setRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
  };
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(createElement(InstantRenderer, { instanceId: "inst-1", client }));
  });
  if (rendered === undefined) throw new Error("render できなかった");
  return rendered.container;
}

/** その位置の行の、出す項目の見出し（`show` の順）を読む */
const namesOf = (container: HTMLElement, rank: number): string[] =>
  [...container.querySelectorAll(`.ranking-row[data-rank="${rank}"] .ranking-cell-name`)].map(
    (cell) => cell.textContent ?? "",
  );

describe("順位の部品の表示名と選択肢の表示名（M1.4。Issue #204）", () => {
  it("見出しは宣言の表示名、選択肢（enum）は options の表示名で出る（受入条件）", async () => {
    const container = await renderDashboard(LABELED_SPEC, LABELED_RANKING);

    await screen.findByText("参加の多い活動");
    // 見出しは宣言の `label`（識別子ではない）。**`label` の無い `memo` は識別子のまま**である（受入条件）
    expect(namesOf(container, 1)).toEqual(["日付", "種類", "参加人数", "memo"]);
    // 選択肢（kind）は `options` の表示名に写る。ほかは値のままである（日付・計算・label の無い文字列）
    expect(valuesOf(container, 1)).toEqual(["2026-09-10", "練習", "3", "駅前"]);
  });

  it("部品自身は写し方を持たず、渡された labelOf を通す（受入条件）", async () => {
    // 部品を直に描く——`labelOf` が値を写す唯一の道であることを見る（中に写し方の表や分岐を持たない）
    const { container } = await render(
      createElement(Ranking, {
        part: PART,
        rows: ROWS,
        labelOf: (field, value) => (field === "kind" ? `＜${String(value)}＞` : String(value ?? "")),
      }),
    );

    expect(valuesOf(container, 1)).toEqual(["2026-09-10", "＜practice＞", "3"]);
  });

  it("見出しと値の間に区切り（余白）がある（受入条件）", async () => {
    const container = await renderDashboard(LABELED_SPEC, LABELED_RANKING);

    await screen.findByText("参加の多い活動");
    const styleOf = (selector: string): string =>
      (container.querySelector(selector) as HTMLElement | null)?.getAttribute("style") ?? "";
    // セルは見出しと値を並べ、**間に余白**を置く（`gap`）
    expect(styleOf(".ranking-cell")).toContain("gap");
    // 見出しは小さく薄い（値のほうを読ませる。区切りを目で分かるようにする）
    expect(styleOf(".ranking-cell-name")).toContain("font-size");
    expect(styleOf(".ranking-cell-name")).toContain("color");
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
