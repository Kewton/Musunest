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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  readonly remove?: MusunestClient["deleteRecord"];
} = {}): MusunestClient {
  return {
    getSpec: parts.spec ?? (() => Promise.resolve(okResult(BOARD_SPEC))),
    getView: parts.view ?? (() => Promise.resolve(okResult(BOARD_VIEW))),
    addRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    deleteRecord: parts.remove ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
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

// ── 強調の色と印（M1.3。Issue #176） ──────────────────────────────────
//
// 「色だけに頼らない」は「色を使わない」ではない（`04` §7.2）。**色 ＋ もう 1 つの手がかり**である。
// だから強調された行には、**色**と、**色以外の印（二重の枠線と記号）**の両方が付く。
// jsdom は layout を持たないので、色と枠線は inline style で確かめる（機械で測れる分。`04` §7.2）。

describe("強調の色と印（M1.3）", () => {
  it("強調された行に、色と、色以外の印（二重の枠線と記号）の両方が付く（受入条件）", async () => {
    const { container } = await renderScreen(boardClient());

    await screen.findByText("タスク t2");
    const marked = container.querySelector('[data-card="t2"]') as HTMLElement | null;
    const plain = container.querySelector('[data-card="t1"]') as HTMLElement | null;
    expect(marked).not.toBeNull();
    expect(plain).not.toBeNull();

    // **色**（背景）
    expect(marked?.style.backgroundColor).not.toBe("");
    // **色以外の印**（二重の枠線）
    expect(marked?.style.borderStyle).toBe("double");
    // **色以外の印**（記号）
    expect(container.querySelector('[data-card="t2"] .highlight-mark')?.textContent).toContain("▲");

    // 強調されていない行には、色も二重の枠線も付かない（**色だけに頼っていないことの裏返し**）
    expect(plain?.style.backgroundColor).toBe("");
    expect(plain?.style.borderStyle).toBe("solid");
  });

  it("強調の印の文字は、highlight が指す計算の label である（無ければ識別子のまま。受入条件）", async () => {
    const spec: ApiSpecBody = {
      ...BOARD_SPEC,
      spec: {
        ...BOARD_SPEC.spec,
        computed: [
          {
            name: "overdue",
            entity: "task",
            type: "boolean",
            label: "期限切れ",
            expression: "due < today()",
          },
        ],
      },
    };
    const view: ApiViewBody = { ...BOARD_VIEW, labels: { title: "やること", overdue: "期限切れ" } };
    const { container } = await renderScreen(
      boardClient({
        spec: () => Promise.resolve(okResult(spec)),
        view: () => Promise.resolve(okResult(view)),
      }),
    );

    await screen.findByText("タスク t2");
    // 印の文字は計算の label である（**識別子 overdue ではない**）
    const mark = container.querySelector('[data-card="t2"] .highlight-mark');
    expect(mark?.textContent).toContain("期限切れ");
    expect(mark?.textContent).not.toContain("overdue");
    // カードの項目も label で出る
    expect(container.querySelector('[data-field="title"] dt')?.textContent).toBe("やること");
    // label を書いていない項目は、識別子のままである
    expect(container.querySelector('[data-field="due"] dt')?.textContent).toBe("due");
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

// ── 消す（Issue #214。見本 task-board のボード） ──────────────────────────
//
// 見本 task-board のボードは `deleteTask`（`kind: delete`）を宣言している。**一覧の種類が board でも、
// table・一覧と同じ処理でカードごとに消すボタンを出す**——参照されている行にはボタンの代わりに理由を出す。
// 判定は data-api で、画面は返ってきた `references` をそのまま見る（`03` §2.2）。

const BOARD_DELETE_ACTIONS = [
  { name: "addTask", entity: "task", kind: "create" },
  { name: "deleteTask", entity: "task", kind: "delete" },
] as const;

/** 見本 task-board のボード（`deleteTask` を宣言している）と、消せる行・参照されている行 */
const DELETE_BOARD_SPEC: ApiSpecBody = {
  ...BOARD_SPEC,
  spec: { ...BOARD_SPEC.spec, actions: [...BOARD_DELETE_ACTIONS] },
  actions: [...BOARD_DELETE_ACTIONS],
};

const FREE_CARD: ApiRow = { ...taskCard("t1", "todo", false), references: [] };
const USED_CARD: ApiRow = {
  ...taskCard("t2", "todo", false),
  references: [{ entity: "task", field: "parent", count: 2 }],
};

const DELETE_BOARD_VIEW: ApiViewBody = {
  ...BOARD_VIEW,
  actions: [...BOARD_DELETE_ACTIONS],
  rows: [FREE_CARD, USED_CARD],
};

const deleteBoardClient = (parts: {
  readonly remove?: MusunestClient["deleteRecord"];
  readonly view?: MusunestClient["getView"];
} = {}): MusunestClient =>
  boardClient({
    spec: () => Promise.resolve(okResult(DELETE_BOARD_SPEC)),
    view: () => Promise.resolve(okResult(DELETE_BOARD_VIEW)),
    ...(parts.view === undefined ? {} : { view: parts.view }),
    ...(parts.remove === undefined ? {} : { remove: parts.remove }),
  });

describe("ボードの消すボタン（Issue #214）", () => {
  it("消す操作がある entity のボードに、カードごとに消すボタンが出る（参照されている行には理由）", async () => {
    const { container } = await renderScreen(deleteBoardClient());

    await screen.findByText("タスク t1");
    // 消せる行（t1）にだけボタンが出る
    const buttons = screen.getAllByRole("button", { name: "削除" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("data-delete")).toBe("t1");
    // 印は **table が使うものと同じ**である（`delete` クラス。Issue #214）
    expect(buttons[0]?.className).toBe("delete");
    // 参照されている行（t2）にはボタンを出さず、**table と同じ**断りの理由を出す
    expect(container.querySelector('[data-card="t2"] button')).toBeNull();
    const blocked = container.querySelector('[data-card="t2"] .delete-blocked');
    expect(blocked?.getAttribute("data-blocked")).toBe("true");
    expect(blocked?.textContent).toContain("task.parent 2 件");
  });

  it("消したら、ボードを読み直す（返ってきた行を勝手に足さない）", async () => {
    const remove = vi.fn<MusunestClient["deleteRecord"]>(() =>
      Promise.resolve(okResult({ entity: "task", id: "t1", deleted: true })),
    );
    const view = vi.fn<MusunestClient["getView"]>(() => Promise.resolve(okResult(DELETE_BOARD_VIEW)));
    await renderScreen(deleteBoardClient({ remove, view }));

    await screen.findByText("タスク t1");
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "削除" })[0] as HTMLElement);
    });

    expect(remove).toHaveBeenCalledWith("inst-1", "deleteTask", "t1");
    // 成功したら**一覧を読み直す**（初回と合わせて 2 回）
    expect(view).toHaveBeenCalledTimes(2);
  });

  it("消す操作を宣言していなければ、消すボタンを出さない", async () => {
    await renderScreen(boardClient());

    await screen.findByText("タスク t2");
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
  });
});
