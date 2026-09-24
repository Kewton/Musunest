// @vitest-environment jsdom
//
// ダッシュボード（`type: dashboard`）の component テスト（M1.4。Issue #180）。
//
// 見るのは 3 つである。
//   1. 部品（`widgets`）が、API が返した `scope` の値を**単位つき**で出し、`null` は「—」で見せる
//      （**0 と区別する**。受入条件）
//   2. **4 つの状態**（空・多い・エラー・権限なし）をそれぞれ描く（`04-spec-evolution.md` §7.3）
//   3. **横幅 360 CSS px で崩れない**——部品は折り返し、横には流さない（同 §7.2。jsdom は layout を
//      持たないので、CSS の指定（inline style）で確かめる＝機械で測れる分）
//
// **画面は式も集計も評価しない。** 値は Data API が求めた `scope` をそのまま見せるだけである
// （`CLAUDE.md` の不変条件）。権限なし（`read` が無い）は API が 403 を返し、画面がその理由を出す。
// **多いときに上限は置かない**（全部を折り返して並べる）。

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InstantRenderer } from "./renderer";
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

/** 数値の部品（宣言の `widgets` の 1 つ） */
interface Part {
  readonly type: "number";
  readonly value: string;
  readonly label?: string;
  readonly unit?: string;
}

/** 部品の並びから、ダッシュボードの一覧を持つ宣言を組む（部品が指す計算はアプリ全体の集計である） */
const dashboardSpec = (parts: readonly Part[]): ApiSpecBody => ({
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2",
  sourceSha256: "e".repeat(64),
  spec: {
    entities: [
      { name: "activity", fields: { date: "date", cost: "number" } },
    ],
    views: [{ name: "dashboard", type: "dashboard", widgets: parts }],
    actions: [{ name: "addActivity", entity: "activity" }],
    validations: [],
    computed: [...new Set(parts.map((part) => part.value))].map((name) => ({
      name,
      scope: "app" as const,
      aggregate: { kind: "count" as const, entity: "activity", name: null, where: {} },
      type: "number" as const,
    })),
    permissions: [
      { name: "read", subject: "minIdentity" },
      { name: "write", subject: "minIdentity" },
    ],
    minIdentity: { mode: "anonymous" },
  },
  permissions: { read: true, write: true },
  actions: [{ name: "addActivity", entity: "activity" }],
});

/** ダッシュボードの応答。**行を返さず**、部品の値を `scope` に載せる（`entity` を持たない） */
const dashboardView = (scope?: Readonly<Record<string, number | null>>): ApiViewBody => ({
  instanceId: "inst-1",
  view: "dashboard",
  fields: [],
  computed: [],
  permissions: { read: true, write: true },
  actions: [],
  rows: [],
  ...(scope === undefined ? {} : { scope }),
});

const PARTS: readonly Part[] = [
  { type: "number", label: "今月の活動", value: "activityCount", unit: "回" },
  { type: "number", label: "1 回あたりの参加", value: "averageAttendees", unit: "人" },
  { type: "number", value: "averageCost", unit: "円" },
];

function dashboardClient(parts: {
  readonly spec?: MusunestClient["getSpec"];
  readonly view?: MusunestClient["getView"];
} = {}): MusunestClient {
  return {
    getSpec: parts.spec ?? (() => Promise.resolve(okResult(dashboardSpec(PARTS)))),
    getView: parts.view ?? (() => Promise.resolve(okResult(dashboardView({ activityCount: 3 })))),
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

/** `data-part` の部品が出している値（`dd` の中身） */
const partValueOf = (container: HTMLElement, name: string): string =>
  container.querySelector(`[data-part="${name}"] dd`)?.textContent ?? "";

const partCount = (container: HTMLElement): number =>
  container.querySelectorAll(".dashboard-part").length;

afterEach(cleanup);

describe("ダッシュボードの部品と値", () => {
  it("部品が指す計算の値を、宣言の単位つきで出す（受入条件）", async () => {
    const { container } = await renderScreen(
      dashboardClient({
        view: () =>
          Promise.resolve(okResult(dashboardView({ activityCount: 3, averageCost: 2000 }))),
      }),
    );

    await screen.findByText("今月の活動");
    expect(partValueOf(container, "activityCount")).toBe("3 回");
    expect(partValueOf(container, "averageCost")).toBe("2000 円");
    // 宣言の順に並ぶ
    expect(
      Array.from(container.querySelectorAll(".dashboard-part")).map((part) =>
        part.getAttribute("data-part"),
      ),
    ).toEqual(["activityCount", "averageAttendees", "averageCost"]);
  });

  it("値が null の部品は「—」で見せ、0 と区別する（受入条件）", async () => {
    const { container } = await renderScreen(
      dashboardClient({
        view: () => Promise.resolve(okResult(dashboardView({ activityCount: 0, averageCost: null }))),
      }),
    );

    await screen.findByText("今月の活動");
    // 0 はそのまま 0、求められなかった値は「—」である（**0 に読み替えない**）
    expect(partValueOf(container, "activityCount")).toBe("0 回");
    expect(partValueOf(container, "averageCost")).toBe("— 円");
    expect(partValueOf(container, "activityCount")).not.toBe(partValueOf(container, "averageCost"));
  });

  it("割り算の表示は小数第 1 位まで（四捨五入）。整数はそのままである", async () => {
    const { container } = await renderScreen(
      dashboardClient({
        view: () =>
          Promise.resolve(okResult(dashboardView({ averageAttendees: 2.666_666_6, activityCount: 2000 }))),
      }),
    );

    await screen.findByText("1 回あたりの参加");
    expect(partValueOf(container, "averageAttendees")).toBe("2.7 人");
    expect(partValueOf(container, "activityCount")).toBe("2000 回");
  });
});

describe("ダッシュボードの 4 つの状態（04 §7.3）", () => {
  it("空：部品が 1 つも無ければ「表示する部品がありません」を出す", async () => {
    const { container } = await renderScreen(
      dashboardClient({ spec: () => Promise.resolve(okResult(dashboardSpec([]))) }),
    );

    await screen.findByText("表示する部品がありません");
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(partCount(container)).toBe(0);
  });

  it("多い：上限を置かず、すべての部品を折り返して並べる（受入条件）", async () => {
    const many: readonly Part[] = Array.from({ length: 30 }, (_item, index) => ({
      type: "number" as const,
      value: `metric${index + 1}`,
    }));
    const scope: Record<string, number> = {};
    for (const part of many) scope[part.value] = 1;
    const { container } = await renderScreen(
      dashboardClient({
        spec: () => Promise.resolve(okResult(dashboardSpec(many))),
        view: () => Promise.resolve(okResult(dashboardView(scope))),
      }),
    );

    await screen.findByText("metric1");
    // 上限を置かない（30 個とも描く）。多いことは `data-state` で分かる
    expect(partCount(container)).toBe(30);
    expect(container.querySelector('.dashboard[data-state="many"]')).not.toBeNull();
  });

  it("エラー：値を載せる scope が無ければ「集計の値を表示できません」を出す", async () => {
    const { container } = await renderScreen(
      dashboardClient({ view: () => Promise.resolve(okResult(dashboardView())) }),
    );

    await screen.findByText("集計の値を表示できません");
    expect(container.querySelector('[data-state="dashboardUnavailable"]')).not.toBeNull();
    expect(partCount(container)).toBe(0);
  });

  it("エラー：一覧を読めなかった理由を出し、ダッシュボードを描かない", async () => {
    const { container } = await renderScreen(
      dashboardClient({ view: () => Promise.resolve(errResult("NOT_FOUND", 404)) }),
    );

    await screen.findByText("アプリが見つかりません");
    expect(container.querySelector('[data-state="notFound"]')).not.toBeNull();
    expect(container.querySelector(".dashboard")).toBeNull();
  });

  it("権限なし：read が無ければ 403 の理由を出す（守りは data-api 側にある）", async () => {
    const { container } = await renderScreen(
      dashboardClient({ spec: () => Promise.resolve(errResult("PERMISSION_DENIED", 403)) }),
    );

    await screen.findByText("このアプリを表示する権限がありません");
    expect(container.querySelector('[data-state="forbidden"]')).not.toBeNull();
    expect(container.querySelector(".dashboard")).toBeNull();
  });
});

describe("幅 360 CSS px（機械で見られる範囲。04 §7.2）", () => {
  it("部品は折り返し、横には流さない（ページ全体を押し広げない。受入条件）", async () => {
    const { container } = await renderScreen(dashboardClient());

    await screen.findByText("今月の活動");
    // 横に流す入れ物（`.table-scroll`）を作らない
    expect(container.querySelector(".dashboard .table-scroll")).toBeNull();

    // jsdom は layout を持たないので、幅の指定は style で確かめる（04 §7.2「機械で測れる分」）
    const styleOf = (selector: string): string =>
      (container.querySelector(selector) as HTMLElement | null)?.getAttribute("style") ?? "";
    expect(styleOf(".dashboard")).toContain("max-width: 100%");
    expect(styleOf(".dashboard-parts")).toContain("flex-wrap: wrap");
    expect(styleOf(".dashboard-parts")).toContain("max-width: 100%");
    expect(styleOf(".dashboard-part")).toContain("min-width: 0");
    expect(styleOf(".dashboard-part")).toContain("max-width: 100%");
  });
});
