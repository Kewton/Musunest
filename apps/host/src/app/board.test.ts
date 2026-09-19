// @vitest-environment jsdom
//
// ボード（`type: board`）の component テスト（M1.3。Issue #157）。
//
// 見るのは 3 つである。
//   1. **列は `columns` が指す選択肢（enum）の `options` に書いた順**で、**空の列も出る**（受入条件）
//   2. **4 つの状態**（空・多い・エラー・権限なし）をそれぞれ描く（`04-spec-evolution.md` §7.3）
//   3. **1 列に並べるカードの数には上限を置かない**（上限は M1.5。measurements.md §6）。
//      横幅 360 CSS px は、jsdom が layout を持たないので **CSS の規則**で確かめる（機械で測れる分）
//
// **画面は式を評価しない。** 強調は API が行に載せた真偽の値（`computed.overdue`）をそのまま見る
// （`CLAUDE.md` の不変条件）。判定そのものは data-api の仕事である（app-api.test.ts が見る）。

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InstantRenderer } from "./renderer";
import type {
  ApiRow,
  ApiSpecBody,
  ApiValue,
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

/** タスクのボード。`columns` は選択肢の項目 status、`highlight` は真偽の計算 overdue である */
const BOARD_SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "c".repeat(64),
  spec: {
    entities: [
      {
        name: "task",
        fields: {
          title: "string",
          due: "date",
          status: {
            type: "enum",
            options: { todo: "未着手", doing: "進行中", done: "完了" },
            default: "todo",
          },
        },
      },
    ],
    views: [{ name: "taskBoard", entity: "task", type: "board", columns: "status", highlight: "overdue" }],
    actions: [{ name: "addTask", entity: "task" }],
    validations: [],
    computed: [{ name: "overdue", entity: "task", expression: "due < today()", type: "boolean" }],
    permissions: [
      { name: "read", subject: "minIdentity" },
      { name: "write", subject: "minIdentity" },
    ],
    minIdentity: { mode: "anonymous" },
  },
  permissions: { read: true, write: true },
  actions: [{ name: "addTask", entity: "task" }],
};

/** API が判定した強調の結果（`computed.overdue`）を行に載せる */
const taskCard = (id: string, status: string, overdue: boolean): ApiRow => ({
  id,
  createdAt: "2026-09-16T12:00:00+09:00",
  updatedAt: "2026-09-16T12:00:00+09:00",
  fields: { title: `タスク ${id}`, due: "2026-09-15", status } as Readonly<Record<string, ApiValue>>,
  computed: { overdue },
});

const BOARD_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "taskBoard",
  entity: "task",
  fields: ["title", "due", "status"],
  computed: [],
  permissions: { read: true, write: true },
  actions: [{ name: "addTask", entity: "task" }],
  rows: [
    taskCard("t1", "done", false),
    taskCard("t2", "todo", true),
    taskCard("t3", "todo", false),
  ],
};

function boardClient(parts: {
  readonly spec?: MusunestClient["getSpec"];
  readonly view?: MusunestClient["getView"];
} = {}): MusunestClient {
  return {
    getSpec: parts.spec ?? (() => Promise.resolve(okResult(BOARD_SPEC))),
    getView: parts.view ?? (() => Promise.resolve(okResult(BOARD_VIEW))),
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

/** 列の見出し（`data-column`）の並び */
const columnKeys = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll(".board-column")).map(
    (column) => column.getAttribute("data-column") ?? "",
  );

/** 列に入っているカードの ID の並び */
const cardIds = (container: HTMLElement, column: string): string[] =>
  Array.from(container.querySelectorAll(`[data-column="${column}"] .board-card`)).map(
    (card) => card.getAttribute("data-card") ?? "",
  );

afterEach(cleanup);

describe("ボードの列とカード", () => {
  it("列は options に書いた順（todo・doing・done）に並ぶ（受入条件）", async () => {
    const { container } = await renderScreen(boardClient());

    await screen.findByText("タスク t2");
    // 行の順（done が先）ではなく、宣言の `options` の順である
    expect(columnKeys(container)).toEqual(["todo", "doing", "done"]);
    // 表示名は options の右側である
    expect(
      Array.from(container.querySelectorAll(".board-column-title")).map((title) => title.textContent),
    ).toEqual(["未着手", "進行中", "完了"]);
    // カードは、その値の列に入る
    expect(cardIds(container, "todo")).toEqual(["t2", "t3"]);
    expect(cardIds(container, "done")).toEqual(["t1"]);
  });

  it("空の列も出す（カードが 0 枚でも列が見える。受入条件）", async () => {
    const { container } = await renderScreen(boardClient());

    await screen.findByText("タスク t2");
    // doing の行は 1 件も無いが、列は出る
    expect(cardIds(container, "doing")).toEqual([]);
    expect(container.querySelector('[data-column="doing"]')).not.toBeNull();
  });

  it("強調された行に、色以外の印が付く（受入条件）", async () => {
    const { container } = await renderScreen(boardClient());

    await screen.findByText("タスク t2");
    expect(container.querySelector('[data-card="t2"]')?.getAttribute("data-highlighted")).toBe("true");
    expect(container.querySelector('[data-card="t2"] .highlight-mark')?.textContent).toContain("overdue");
    // 強調されていない行には付かない
    expect(container.querySelector('[data-card="t1"] .highlight-mark')).toBeNull();
  });
});

describe("ボードの 4 つの状態（04 §7.3）", () => {
  it("空：行が 0 件でも、列は描く（空の列も出すためである）", async () => {
    const empty = { ...BOARD_VIEW, rows: [] };
    const { container } = await renderScreen(
      boardClient({ view: () => Promise.resolve(okResult(empty)) }),
    );

    await screen.findByText("まだ記録がありません");
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();
    // **列は 3 つとも出る**（空のボードでも、状態の列が消えない）
    expect(columnKeys(container)).toEqual(["todo", "doing", "done"]);
    expect(container.querySelectorAll(".board-card")).toHaveLength(0);
  });

  it("多い：1 列に上限を置かず、すべてのカードを縦に並べる（受入条件）", async () => {
    const many: ApiRow[] = Array.from({ length: 60 }, (_item, index) =>
      taskCard(`t${index + 1}`, "todo", index === 0),
    );
    const { container } = await renderScreen(
      boardClient({ view: () => Promise.resolve(okResult({ ...BOARD_VIEW, rows: many })) }),
    );

    await screen.findByText("タスク t1");
    // 上限を置かない（60 枚とも描く）
    expect(container.querySelectorAll(".board-card")).toHaveLength(60);
    expect(cardIds(container, "todo")).toEqual(many.map((row) => row.id));
  });

  it("エラー：一覧を読めなかった理由を出し、ボードを描かない", async () => {
    const { container } = await renderScreen(
      boardClient({ view: () => Promise.resolve(errResult("NOT_FOUND", 404)) }),
    );

    await screen.findByText("アプリが見つかりません");
    expect(container.querySelector('[data-state="notFound"]')).not.toBeNull();
    expect(container.querySelector(".board")).toBeNull();
  });

  it("権限なし：read が無ければ 403 の理由を出す（守りは data-api 側にある）", async () => {
    const { container } = await renderScreen(
      boardClient({ spec: () => Promise.resolve(errResult("PERMISSION_DENIED", 403)) }),
    );

    await screen.findByText("このアプリを表示する権限がありません");
    expect(container.querySelector('[data-state="forbidden"]')).not.toBeNull();
    expect(container.querySelector(".board")).toBeNull();
  });
});

describe("幅 360 CSS px（機械で見られる範囲。04 §7.2）", () => {
  it("列は折り返し、横には流さない（ページ全体を押し広げない。受入条件）", async () => {
    const { container } = await renderScreen(boardClient());

    await screen.findByText("タスク t2");
    // 横に流す入れ物（`.table-scroll`）を作らない
    expect(container.querySelector(".board-scroll")).not.toBeNull();
    expect(container.querySelector(".board-scroll .table-scroll")).toBeNull();

    // jsdom は layout を持たないので、幅の指定は style で確かめる（04 §7.2「機械で測れる分」）
    const styleOf = (selector: string): string =>
      (container.querySelector(selector) as HTMLElement | null)?.getAttribute("style") ?? "";
    expect(styleOf(".board-scroll")).toContain("max-width: 100%");
    expect(styleOf(".board")).toContain("flex-wrap: wrap");
    expect(styleOf(".board")).toContain("max-width: 100%");
    expect(styleOf(".board-column")).toContain("flex: 1 1 160px");
    expect(styleOf(".board-column")).toContain("min-width: 0");
    expect(styleOf(".board-card")).toContain("overflow-wrap: anywhere");
  });
});
