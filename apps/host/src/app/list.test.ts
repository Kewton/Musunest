// @vitest-environment jsdom
//
// 一覧（`type: list`）と絞り込み（`filters`）の component テスト（M1.3。Issue #158）。
//
// 見るのは 4 つである。
//   1. `show` の順に項目が出る（受入条件。扱いは `table` と揃う）
//   2. **初期状態は「すべて」**で、選ぶと**画面の中だけ**で行が絞られる（受入条件）
//   3. 絞り込んだ結果が 0 件のとき、**行が 1 件も無いときとは別の**空の状態を出す（受入条件）
//   4. 4 つの状態（空・多い・エラー・権限なし）と、幅 360 CSS px（`04` §7.3・§7.2）
//
// **絞り込みは API を呼び直さない**——Data API に絞り込みの引数を足さない（受入条件。この file の
// 「絞り込みを変えても API を呼び直さない」が確かめる）。jsdom は layout を持たないので、幅は
// CSS の指定（inline style）で確かめる（機械で測れる分。`04` §7.2）。

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

/**
 * タスクの一覧。`show` は [title, status, assignee, due]、`filters` は [assignee, status] である
 * （member は参照先で、絞り込みの候補は member の一覧から取る）。
 */
const LIST_SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "d".repeat(64),
  spec: {
    entities: [
      { name: "member", fields: { name: "string" } },
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
          assignee: { type: "ref", to: "member" },
        },
      },
    ],
    views: [
      {
        name: "taskList",
        entity: "task",
        type: "list",
        show: ["title", "status", "assignee", "due"],
        filters: ["assignee", "status"],
      },
      { name: "memberList", entity: "member" },
    ],
    actions: [
      { name: "addMember", entity: "member" },
      { name: "addTask", entity: "task" },
    ],
    validations: [],
    computed: [],
    permissions: [
      { name: "read", subject: "minIdentity" },
      { name: "write", subject: "minIdentity" },
    ],
    minIdentity: { mode: "anonymous" },
  },
  permissions: { read: true, write: true },
  actions: [
    { name: "addMember", entity: "member" },
    { name: "addTask", entity: "task" },
  ],
};

const MEMBER_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "memberList",
  entity: "member",
  fields: ["name"],
  computed: [],
  permissions: { read: true, write: true },
  actions: [{ name: "addMember", entity: "member" }],
  rows: [
    { id: "m1", createdAt: "2026-09-19T00:00:00+09:00", updatedAt: "2026-09-19T00:00:00+09:00", fields: { name: "A" }, computed: {} },
    { id: "m2", createdAt: "2026-09-19T00:00:00+09:00", updatedAt: "2026-09-19T00:00:00+09:00", fields: { name: "B" }, computed: {} },
  ],
};

const taskRow = (
  id: string,
  title: string,
  status: string,
  assignee: string,
  due: string,
): ApiRow => ({
  id,
  createdAt: "2026-09-19T00:00:00+09:00",
  updatedAt: "2026-09-19T00:00:00+09:00",
  fields: { title, status, assignee, due } as Readonly<Record<string, ApiValue>>,
  computed: {},
});

const LIST_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "taskList",
  entity: "task",
  // 項目は宣言の順（列の順は宣言の `show` が持つ）
  fields: ["title", "due", "status", "assignee"],
  computed: [],
  permissions: { read: true, write: true },
  actions: [{ name: "addTask", entity: "task" }],
  rows: [
    taskRow("t1", "宿の予約", "doing", "m1", "2026-09-20"),
    taskRow("t2", "しおり作り", "todo", "m2", "2026-09-10"),
    taskRow("t3", "レンタカー", "done", "m1", "2026-09-25"),
  ],
};

function listClient(parts: {
  readonly spec?: MusunestClient["getSpec"];
  readonly view?: MusunestClient["getView"];
} = {}): MusunestClient {
  return {
    getSpec: parts.spec ?? (() => Promise.resolve(okResult(LIST_SPEC))),
    getView:
      parts.view ??
      ((_instanceId, name) =>
        Promise.resolve(okResult(name === "memberList" ? MEMBER_VIEW : LIST_VIEW))),
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

/** 行の ID の並び（画面に出ている順） */
const rowIds = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll(".list-row")).map((row) => row.getAttribute("data-row") ?? "");

/** 1 行に出す項目の名前の並び（`show` の順であることを見る） */
const fieldOrderOf = (container: HTMLElement, id: string): string[] =>
  Array.from(container.querySelectorAll(`[data-row="${id}"] .list-field`)).map(
    (field) => field.getAttribute("data-field") ?? "",
  );

/** 1 行の、その項目の値 */
const valueOf = (container: HTMLElement, id: string, field: string): string =>
  container.querySelector(`[data-row="${id}"] [data-field="${field}"] dd`)?.textContent ?? "";

/** 絞り込みの選択欄（`data-filter` で引く。入力フォームの欄と混ざらない） */
const selectOf = (container: HTMLElement, name: string): HTMLSelectElement => {
  const select = container.querySelector(`[data-filter="${name}"] select`);
  if (!(select instanceof HTMLSelectElement)) throw new Error(`絞り込み ${name} の選択欄が無い`);
  return select;
};

const optionsOf = (select: HTMLSelectElement): readonly string[] =>
  Array.from(select.options).map((option) => option.textContent ?? "");

afterEach(cleanup);

describe("一覧（list）の並べ方", () => {
  it("項目は show の順に出る（扱いは table と揃う。受入条件）", async () => {
    const { container } = await renderScreen(listClient());

    await screen.findByText("宿の予約");
    // 宣言の項目の順（title・due・status・assignee）ではなく、`show` の順である
    expect(fieldOrderOf(container, "t1")).toEqual(["title", "status", "assignee", "due"]);
    // 参照（assignee）は ID ではなく名前で見せる
    expect(valueOf(container, "t1", "assignee")).toBe("A");
    expect(container.textContent).not.toContain("m1");
  });

  it("行は API が返した順（登録順）のままである", async () => {
    const { container } = await renderScreen(listClient());

    await screen.findByText("宿の予約");
    expect(rowIds(container)).toEqual(["t1", "t2", "t3"]);
  });

  it("show を書いていなければ、項目（宣言の順）に続いて計算（宣言の順）である", async () => {
    const spec: ApiSpecBody = {
      ...LIST_SPEC,
      spec: {
        ...LIST_SPEC.spec,
        views: [{ name: "taskList", entity: "task", type: "list" }, { name: "memberList", entity: "member" }],
      },
    };
    const { container } = await renderScreen(listClient({ spec: () => Promise.resolve(okResult(spec)) }));

    await screen.findByText("宿の予約");
    expect(fieldOrderOf(container, "t1")).toEqual(["title", "due", "status", "assignee"]);
  });
});

describe("絞り込み（filters）", () => {
  it("選択肢に「すべて」があり、初期状態は「すべて」である（受入条件）", async () => {
    const { container } = await renderScreen(listClient());

    await screen.findByText("宿の予約");
    // 選択肢の順は、enum は options に書いた順、ref は参照先の一覧の行の順である
    expect(optionsOf(selectOf(container, "status"))).toEqual(["すべて", "未着手", "進行中", "完了"]);
    expect(optionsOf(selectOf(container, "assignee"))).toEqual(["すべて", "A", "B"]);
    // 初期状態は「すべて」である（value が空。絞り込んだ状態では始めない）
    expect(selectOf(container, "status").value).toBe("");
    expect(selectOf(container, "assignee").value).toBe("");
    // 全部の行が出ている
    expect(rowIds(container)).toEqual(["t1", "t2", "t3"]);
  });

  it("enum で選ぶと、画面の行が絞られる（受入条件）", async () => {
    const { container } = await renderScreen(listClient());
    await screen.findByText("宿の予約");

    fireEvent.change(selectOf(container, "status"), { target: { value: "done" } });

    expect(rowIds(container)).toEqual(["t3"]);
    // 「すべて」に戻せば、また全部が出る
    fireEvent.change(selectOf(container, "status"), { target: { value: "" } });
    expect(rowIds(container)).toEqual(["t1", "t2", "t3"]);
  });

  it("ref で選ぶと、参照の ID で絞られる（見せるのは名前である）", async () => {
    const { container } = await renderScreen(listClient());
    await screen.findByText("宿の予約");

    fireEvent.change(selectOf(container, "assignee"), { target: { value: "m2" } });

    expect(rowIds(container)).toEqual(["t2"]);
    expect(valueOf(container, "t2", "assignee")).toBe("B");
  });

  it("2 つの絞り込みは重なる（どちらも合う行だけが残る）", async () => {
    const { container } = await renderScreen(listClient());
    await screen.findByText("宿の予約");

    fireEvent.change(selectOf(container, "assignee"), { target: { value: "m1" } });
    expect(rowIds(container)).toEqual(["t1", "t3"]);
    fireEvent.change(selectOf(container, "status"), { target: { value: "done" } });
    expect(rowIds(container)).toEqual(["t3"]);
  });

  it("絞り込んだ結果が 0 件なら、行が無いときとは別の空の状態を出す（受入条件）", async () => {
    const { container } = await renderScreen(listClient());
    await screen.findByText("宿の予約");

    // t1 は doing・m1 である。doing かつ m2 の行は 1 件も無い
    fireEvent.change(selectOf(container, "status"), { target: { value: "doing" } });
    fireEvent.change(selectOf(container, "assignee"), { target: { value: "m2" } });

    expect(await screen.findByText("条件に合う記録がありません")).toBeDefined();
    expect(container.querySelector('[data-state="filteredEmpty"]')).not.toBeNull();
    expect(rowIds(container)).toEqual([]);
    // 「まだ記録がありません」（行が 1 件も無いとき）とは読み替えない
    expect(screen.queryByText("まだ記録がありません")).toBeNull();
    // 選び直せるように、絞り込みの選択欄は出したままである
    expect(selectOf(container, "status")).not.toBeNull();
  });

  it("filters が enum でも ref でもない項目を指しても、画面は壊れない（候補をでっち上げない）", async () => {
    // 静的チェックが先に断るが、配信された宣言が壊れていても画面は落ちない（守りはサーバ側）
    const spec: ApiSpecBody = {
      ...LIST_SPEC,
      spec: {
        ...LIST_SPEC.spec,
        views: [
          {
            name: "taskList",
            entity: "task",
            type: "list",
            show: ["title", "status"],
            filters: ["title"],
          },
          { name: "memberList", entity: "member" },
        ],
      },
    };
    const { container } = await renderScreen(listClient({ spec: () => Promise.resolve(okResult(spec)) }));

    await screen.findByText("宿の予約");
    // 絞り込みの選択欄は出さない（架空の選択肢を作らない）。行は絞られない
    expect(container.querySelector(".list-filters")).toBeNull();
    expect(rowIds(container)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("一覧の 4 つの状態（04 §7.3）", () => {
  it("空：行が 1 件も無ければ「まだ記録がありません」を出す", async () => {
    const { container } = await renderScreen(
      listClient({ view: () => Promise.resolve(okResult({ ...LIST_VIEW, rows: [] })) }),
    );

    await screen.findByText("まだ記録がありません");
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(rowIds(container)).toEqual([]);
  });

  it("多い：行の数に上限を置かず、すべてを縦に並べる", async () => {
    const many: ApiRow[] = Array.from({ length: 60 }, (_item, index) =>
      taskRow(`t${index + 1}`, `タスク ${index + 1}`, "todo", "m1", "2026-09-20"),
    );
    const { container } = await renderScreen(
      listClient({ view: () => Promise.resolve(okResult({ ...LIST_VIEW, rows: many })) }),
    );

    await screen.findByText("タスク 1");
    expect(rowIds(container)).toHaveLength(60);
  });

  it("エラー：一覧を読めなかった理由を出し、一覧を描かない", async () => {
    const { container } = await renderScreen(
      listClient({ view: () => Promise.resolve(errResult("NOT_FOUND", 404)) }),
    );

    await screen.findByText("アプリが見つかりません");
    expect(container.querySelector('[data-state="notFound"]')).not.toBeNull();
    expect(container.querySelector(".list")).toBeNull();
  });

  it("権限なし：read が無ければ 403 の理由を出す（守りは data-api 側にある）", async () => {
    const { container } = await renderScreen(
      listClient({ spec: () => Promise.resolve(errResult("PERMISSION_DENIED", 403)) }),
    );

    await screen.findByText("このアプリを表示する権限がありません");
    expect(container.querySelector('[data-state="forbidden"]')).not.toBeNull();
    expect(container.querySelector(".list")).toBeNull();
  });
});

describe("幅 360 CSS px（機械で見られる範囲。04 §7.2）", () => {
  it("縦に積み、表のように横へ流さない（ページ全体を押し広げない。受入条件）", async () => {
    const { container } = await renderScreen(listClient());

    await screen.findByText("宿の予約");
    // 横に流す入れ物（`.table-scroll`）を作らない
    expect(container.querySelector(".list")).not.toBeNull();
    expect(container.querySelector(".list .table-scroll")).toBeNull();

    // jsdom は layout を持たないので、幅の指定は style で確かめる（04 §7.2「機械で測れる分」）
    const styleOf = (selector: string): string =>
      (container.querySelector(selector) as HTMLElement | null)?.getAttribute("style") ?? "";
    expect(styleOf(".list")).toContain("max-width: 100%");
    expect(styleOf(".list-filters")).toContain("flex-wrap: wrap");
    expect(styleOf(".list-filters")).toContain("max-width: 100%");
    expect(styleOf(".list-filter")).toContain("min-width: 0");
    expect(styleOf(".list-row")).toContain("overflow-wrap: anywhere");
  });
});

describe("絞り込みは画面の中で行う（受入条件）", () => {
  it("絞り込みを変えても API を呼び直さない（/api に絞り込みの引数を足さない）", async () => {
    const getView = vi.fn((_instanceId: string, name: string) =>
      Promise.resolve(okResult(name === "memberList" ? MEMBER_VIEW : LIST_VIEW)),
    );
    const { container } = await renderScreen(listClient({ view: getView }));

    await screen.findByText("宿の予約");
    // 呼び出しは「インスタンス」と「一覧の名前」の 2 つだけである（絞り込みの引数は無い）
    expect(getView).toHaveBeenCalledWith("inst-1", "taskList");
    for (const call of getView.mock.calls) expect(call).toHaveLength(2);
    const before = getView.mock.calls.length;

    fireEvent.change(selectOf(container, "status"), { target: { value: "done" } });

    // 絞り込みは画面の中だけで行われる（読むのは全件のまま。API を呼び直さない）
    expect(rowIds(container)).toEqual(["t3"]);
    expect(getView.mock.calls.length).toBe(before);
  });
});
