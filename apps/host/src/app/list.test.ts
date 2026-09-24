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

// ── 消す（Issue #214。見本 dashboard の一覧） ──────────────────────────────
//
// 見本 dashboard の一覧（`activities`・`members`）は `deleteActivity`・`deleteMember`
// （`kind: delete`）を宣言している。**一覧の種類が list でも、table・ボードと同じ処理で行ごとに
// 消すボタンを出す**——参照されている行にはボタンの代わりに理由を出す（`03` §2.2）。

const DASHBOARD_ACTIONS = [
  { name: "addMember", entity: "member", kind: "create" },
  { name: "addActivity", entity: "activity", kind: "create" },
  { name: "deleteActivity", entity: "activity", kind: "delete" },
  { name: "deleteMember", entity: "member", kind: "delete" },
] as const;

/** 見本 dashboard の 2 つの一覧（`activities`・`members`）と、消す操作 */
const DASHBOARD_LIST_SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "e".repeat(64),
  spec: {
    entities: [
      { name: "member", fields: { name: "string" } },
      {
        name: "activity",
        fields: {
          kind: { type: "enum", options: { practice: "練習", match: "試合", party: "飲み会" } },
          date: "date",
          attendees: { type: "list", of: "member" },
          cost: "number",
        },
      },
    ],
    views: [
      { name: "activities", entity: "activity", type: "list", show: ["kind", "attendees", "cost", "attendeeCount"] },
      { name: "members", entity: "member", type: "list", show: ["name"] },
    ],
    actions: [...DASHBOARD_ACTIONS],
    validations: [],
    computed: [{ name: "attendeeCount", entity: "activity", expression: "len(attendees)", type: "number" }],
    permissions: [
      { name: "read", subject: "minIdentity" },
      { name: "write", subject: "minIdentity" },
    ],
    minIdentity: { mode: "anonymous" },
  },
  permissions: { read: true, write: true },
  actions: [...DASHBOARD_ACTIONS],
};

const dashActivity = (id: string, kind: string, referenced: boolean): ApiRow => ({
  id,
  createdAt: "2026-09-20T00:00:00+09:00",
  updatedAt: "2026-09-20T00:00:00+09:00",
  fields: { kind, date: "2026-09-20", attendees: ["m1"], cost: 3000 } as Readonly<Record<string, ApiValue>>,
  computed: { attendeeCount: 1 },
  references: referenced ? [{ entity: "activity", field: "parent", count: 1 }] : [],
});

const DASH_ACTIVITIES_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "activities",
  entity: "activity",
  fields: ["kind", "date", "attendees", "cost"],
  computed: ["attendeeCount"],
  permissions: { read: true, write: true },
  actions: [...DASHBOARD_ACTIONS],
  rows: [dashActivity("a1", "practice", false), dashActivity("a2", "party", true)],
};

const DASH_MEMBERS_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "members",
  entity: "member",
  fields: ["name"],
  computed: [],
  permissions: { read: true, write: true },
  actions: [...DASHBOARD_ACTIONS],
  rows: [
    { id: "m1", createdAt: "2026-09-20T00:00:00+09:00", updatedAt: "2026-09-20T00:00:00+09:00", fields: { name: "田中" }, computed: {} },
  ],
};

function dashboardListClient(parts: {
  readonly spec?: MusunestClient["getSpec"];
  readonly view?: MusunestClient["getView"];
  readonly remove?: MusunestClient["deleteRecord"];
} = {}): MusunestClient {
  return {
    getSpec: parts.spec ?? (() => Promise.resolve(okResult(DASHBOARD_LIST_SPEC))),
    getView:
      parts.view ??
      ((_instanceId, name) =>
        Promise.resolve(okResult(name === "members" ? DASH_MEMBERS_VIEW : DASH_ACTIVITIES_VIEW))),
    addRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    deleteRecord: parts.remove ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
    setRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
  };
}

describe("一覧の消すボタン（Issue #214。見本 dashboard）", () => {
  it("消す操作がある entity の一覧に、行ごとに消すボタンが出る（参照されている行には理由）", async () => {
    const { container } = await renderScreen(dashboardListClient());

    await screen.findAllByText("練習");
    // 消せる行（a1）にだけボタンが出る
    const buttons = screen.getAllByRole("button", { name: "削除" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("data-delete")).toBe("a1");
    // 印は **table が使うものと同じ**である（`delete` クラス。Issue #214）
    expect(buttons[0]?.className).toBe("delete");
    // 参照されている行（a2）にはボタンを出さず、**table と同じ**断りの理由を出す
    expect(container.querySelector('[data-row="a2"] button')).toBeNull();
    const blocked = container.querySelector('[data-row="a2"] .delete-blocked');
    expect(blocked?.getAttribute("data-blocked")).toBe("true");
    expect(blocked?.textContent).toContain("activity.parent 1 件");
  });

  it("メンバーの一覧（type list）にも、消すボタンが出る", async () => {
    const { container } = await renderScreen(dashboardListClient());
    await screen.findAllByText("練習");

    // 一覧を切り替える（views が 2 つあるので切替が出る）
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "members" }));
    });

    await screen.findByText("田中");
    const buttons = screen.getAllByRole("button", { name: "削除" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("data-delete")).toBe("m1");
    expect(container.querySelector('[data-row="m1"] .delete')?.getAttribute("data-delete")).toBe("m1");
  });

  it("消したら、一覧を読み直す（返ってきた行を勝手に足さない）", async () => {
    const remove = vi.fn<MusunestClient["deleteRecord"]>(() =>
      Promise.resolve(okResult({ entity: "activity", id: "a1", deleted: true })),
    );
    const getView = vi.fn<MusunestClient["getView"]>((_instanceId, name) =>
      Promise.resolve(okResult(name === "members" ? DASH_MEMBERS_VIEW : DASH_ACTIVITIES_VIEW)),
    );
    await renderScreen(dashboardListClient({ view: getView, remove }));

    await screen.findAllByText("練習");
    const before = getView.mock.calls.filter((call) => call[1] === "activities").length;
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "削除" })[0] as HTMLElement);
    });

    expect(remove).toHaveBeenCalledWith("inst-1", "deleteActivity", "a1");
    // 成功したら**一覧を読み直す**（読んだ回数が増える）
    const after = getView.mock.calls.filter((call) => call[1] === "activities").length;
    expect(after).toBe(before + 1);
  });
});

// ── 直す（`set` を持たない `kind: update`。M1.5。Issue #215） ──────────────
//
// 一覧（`type: list`）でも、**table・ボードと同じ処理**で行ごとに「直す」を出す。押すと、**今の値を
// 入れたフォーム**が開く（入力欄は追加と同じ部品である）。ここでは一覧が「直す」を出してフォームが
// 開くことまでを見る（送信と一覧の読み直しは renderer.test.ts が見る）。

/** 見本 task-board の一覧に「直す」（`editTask`。`set` を持たない `kind: update`）を足した宣言 */
const LIST_EDIT_SPEC: ApiSpecBody = {
  ...LIST_SPEC,
  spec: {
    ...LIST_SPEC.spec,
    actions: [...LIST_SPEC.spec.actions, { name: "editTask", entity: "task", kind: "update" }],
  },
  actions: [...LIST_SPEC.actions, { name: "editTask", entity: "task", kind: "update" }],
};

describe("一覧の「直す」ボタン（M1.5。Issue #215）", () => {
  it("行ごとに「直す」が出て、押すと今の値が入ったフォームが開く（受入条件）", async () => {
    const { container } = await renderScreen(
      listClient({ spec: () => Promise.resolve(okResult(LIST_EDIT_SPEC)) }),
    );

    await screen.findByText("宿の予約");
    const buttons = screen.getAllByRole("button", { name: "直す" });
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.getAttribute("data-edit")).toBe("t1");
    expect(buttons[0]?.getAttribute("data-action")).toBe("editTask");
    // 印は **table・ボードが使うものと同じ**である（`edit` クラス）
    expect(buttons[0]?.className).toBe("edit");
    // 押すまではフォームは開いていない
    expect(container.querySelector(".edit-form")).toBeNull();

    fireEvent.click(buttons[0] as HTMLElement);

    const form = container.querySelector<HTMLFormElement>(".edit-form form");
    if (form === null) throw new Error("直すのフォームが無い");
    const valueOf = (name: string): string =>
      (
        form.querySelector(
          `[data-field="${name}"] input, [data-field="${name}"] textarea, [data-field="${name}"] select`,
        ) as HTMLInputElement | null
      )?.value ?? "";
    // **今の値が入っている**（参照は ID で、見せるのは名前である）
    expect(valueOf("title")).toBe("宿の予約");
    expect(valueOf("status")).toBe("doing");
    expect(valueOf("assignee")).toBe("m1");
    expect(valueOf("due")).toBe("2026-09-20");
  });

  it("直す操作を宣言していなければ、ボタンを出さない（M1.3 の画面を変えない）", async () => {
    await renderScreen(listClient());
    await screen.findByText("宿の予約");
    expect(screen.queryByRole("button", { name: "直す" })).toBeNull();
  });
});
