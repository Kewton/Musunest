// @vitest-environment jsdom
//
// Instant Renderer の component テスト（Issue #104）。見本「支出の記録」の形（expense の 5 項目・
// computed 3 つ・view 1 つ）を宣言と応答として与え、画面が何をどう描くかを確かめる。
//
// 約束は「画面は式を評価しない」ことである。計算値も操作の可否も、**API が返した値をそのまま**見せる。
// だから sentinel の計算値もそのまま出るし、`null` は空欄になり、write が無ければフォームが出ない。
// 状態（読込中・空・404・403・通信失敗）は data-state で区別できるようにしてある。

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstantRenderer } from "./renderer";
import type { ApiRow, ApiSpecBody, ApiTransfer, ApiValue, ApiViewBody, ClientErrorCode, ClientResult, MusunestClient } from "@musunest/sdk";

const okResult = <T,>(value: T): ClientResult<T> => ({ ok: true, value });
const errResult = (code: ClientErrorCode, status: number | null): ClientResult<never> => ({
  ok: false,
  error: { status, code, fields: [], validations: [] },
});

const SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "a".repeat(64),
  spec: {
    entities: [
      {
        name: "expense",
        fields: {
          description: "string",
          amount: "number",
          discount: "number",
          payer: "string",
          participants: "list",
        },
      },
    ],
    views: [{ name: "expenseList", entity: "expense" }],
    actions: [{ name: "addExpense", entity: "expense" }],
    validations: [
      { name: "positiveAmount", entity: "expense", expression: "amount > 0" },
      { name: "nonNegativeDiscount", entity: "expense", expression: "discount >= 0" },
    ],
    computed: [
      { name: "paidAmount", entity: "expense", expression: "amount - min(discount, amount)", type: "number" },
      { name: "headcount", entity: "expense", expression: "len(participants)", type: "number" },
      { name: "shareAmount", entity: "expense", expression: "paidAmount / max(1, headcount)", type: "number" },
    ],
    permissions: [
      { name: "read", subject: "minIdentity" },
      { name: "write", subject: "minIdentity" },
    ],
    minIdentity: { mode: "anonymous" },
  },
  permissions: { read: true, write: true },
  actions: [{ name: "addExpense", entity: "expense" }],
};

function makeRow(
  id: string,
  fields: Readonly<Record<string, ApiValue>>,
  computed: Readonly<Record<string, number | null>>,
): ApiRow {
  return {
    id,
    createdAt: "2026-09-16T12:00:00+09:00",
    updatedAt: "2026-09-16T12:00:00+09:00",
    fields,
    computed,
  };
}

const DINNER = makeRow(
  "r1",
  { description: "夕食", amount: 6600, discount: 600, payer: "A", participants: ["A", "B", "C"] },
  { paidAmount: 6000, headcount: 3, shareAmount: 2000 },
);
const TAXI = makeRow(
  "r2",
  { description: "タクシー", amount: 3000, discount: 0, payer: "B", participants: ["A", "B", "C"] },
  { paidAmount: 3000, headcount: 3, shareAmount: 1000 },
);

const VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "expenseList",
  entity: "expense",
  fields: ["description", "amount", "discount", "payer", "participants"],
  computed: ["paidAmount", "headcount", "shareAmount"],
  permissions: { read: true, write: true },
  actions: [{ name: "addExpense", entity: "expense" }],
  rows: [DINNER, TAXI],
};

const viewWith = (changes: Partial<ApiViewBody>): ApiViewBody => ({ ...VIEW, ...changes });
const specWith = (views: ApiSpecBody["spec"]["views"]): ApiSpecBody => ({
  ...SPEC,
  spec: { ...SPEC.spec, views },
});

/** 応答を差し替えられる client。呼出の回数と引数は vi.fn の記録で見る */
function makeClient(parts: {
  readonly spec?: MusunestClient["getSpec"];
  readonly view?: MusunestClient["getView"];
  readonly add?: MusunestClient["addRecord"];
  readonly remove?: MusunestClient["deleteRecord"];
}): MusunestClient {
  return {
    getSpec: parts.spec ?? (() => Promise.resolve(okResult(SPEC))),
    getView: parts.view ?? (() => Promise.resolve(okResult(VIEW))),
    addRecord: parts.add ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
    deleteRecord: parts.remove ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
  };
}

/** 応答の反映まで act の中で待つ（fetch の解決で state が変わるため） */
async function renderScreen(client: MusunestClient) {
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(createElement(InstantRenderer, { instanceId: "inst-1", client }));
  });
  if (rendered === undefined) throw new Error("render できなかった");
  return rendered;
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function submit(): void {
  const form = screen.getByRole("button", { name: "保存" }).closest("form");
  if (form === null) throw new Error("保存のフォームが無い");
  fireEvent.submit(form);
}

afterEach(cleanup);

describe("状態を区別して描く", () => {
  it("読込中", async () => {
    const client = makeClient({ spec: () => new Promise<ClientResult<ApiSpecBody>>(() => {}) });
    const { container } = await renderScreen(client);

    expect(screen.getByRole("status").textContent).toContain("読み込み中");
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull();
  });

  it("未存在（404）", async () => {
    const client = makeClient({ spec: () => Promise.resolve(errResult("NOT_FOUND", 404)) });
    const { container } = await renderScreen(client);

    await screen.findByText("アプリが見つかりません");
    expect(container.querySelector('[data-state="notFound"]')).not.toBeNull();
  });

  it("権限不足（403）", async () => {
    const client = makeClient({ spec: () => Promise.resolve(errResult("PERMISSION_DENIED", 403)) });
    const { container } = await renderScreen(client);

    await screen.findByText("このアプリを表示する権限がありません");
    expect(container.querySelector('[data-state="forbidden"]')).not.toBeNull();
  });

  it("通信失敗（ネットワークの例外）", async () => {
    const client = makeClient({ spec: () => Promise.resolve(errResult("NETWORK_FAILURE", null)) });
    const { container } = await renderScreen(client);

    await screen.findByText("通信に失敗しました");
    expect(container.querySelector('[data-state="network"]')).not.toBeNull();
  });

  it("空一覧は、一覧の空と未存在を混ぜずに描く（フォームは出る）", async () => {
    const client = makeClient({ view: () => Promise.resolve(okResult(viewWith({ rows: [] }))) });
    const { container } = await renderScreen(client);

    await screen.findByText("まだ記録がありません");
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存" })).toBeDefined();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  });
});

describe("一覧の並べ方", () => {
  it("列は項目（宣言の順）→ 計算（宣言の順）。行は API の順のまま", async () => {
    const { container } = await renderScreen(makeClient({}));

    await screen.findByText("夕食");
    expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual([
      "description",
      "amount",
      "discount",
      "payer",
      "participants",
      "paidAmount",
      "headcount",
      "shareAmount",
    ]);
    expect(rowTexts(container)).toEqual([
      ["夕食", "6600", "600", "A", "A, B, C", "6000", "3", "2000"],
      ["タクシー", "3000", "0", "B", "A, B, C", "3000", "3", "1000"],
    ]);
  });

  it("API が返した sentinel の計算値をそのまま出し、null は「—」で見せる", async () => {
    const sentinel = viewWith({
      rows: [
        makeRow(
          "r3",
          { description: "コーヒー", amount: 400, discount: 500, payer: "C", participants: ["C"] },
          { paidAmount: null, headcount: 1, shareAmount: 777777 },
        ),
      ],
    });
    const { container } = await renderScreen(makeClient({ view: () => Promise.resolve(okResult(sentinel)) }));

    await screen.findByText("コーヒー");
    // 求められなかった計算は「—」である（M1.2。空欄にも 0 にも読み替えない）
    expect(rowTexts(container)).toEqual([["コーヒー", "400", "500", "C", "C", "—", "1", "777777"]]);
  });

  it("利用者の入力を HTML として挿入しない", async () => {
    const injected = viewWith({
      rows: [
        makeRow(
          "r4",
          { description: "<b>夕食</b>", amount: 6600, discount: 0, payer: "A", participants: ["A"] },
          { paidAmount: 6600, headcount: 1, shareAmount: 6600 },
        ),
      ],
    });
    const { container } = await renderScreen(makeClient({ view: () => Promise.resolve(okResult(injected)) }));

    await screen.findByText("<b>夕食</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  it("view が複数あれば名前で切り替えられる", async () => {
    const getView = vi.fn((_instanceId: string, name: string) =>
      Promise.resolve(okResult(name === "expenseList" ? VIEW : viewWith({ view: "byPayer", rows: [TAXI] }))),
    );
    const client = makeClient({ spec: () => Promise.resolve(okResult(specWith([{ name: "expenseList", entity: "expense" }, { name: "byPayer", entity: "expense" }]))) , view: getView });
    const { container } = await renderScreen(client);

    await screen.findByText("夕食");
    fireEvent.click(screen.getByRole("button", { name: "byPayer" }));

    await screen.findByText("タクシー");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.queryByText("夕食")).toBeNull();
    expect(getView).toHaveBeenLastCalledWith("inst-1", "byPayer");
  });

  it("write が無ければ追加の操作を出さない（一覧は読める）", async () => {
    const readOnly = viewWith({ permissions: { read: true, write: false } });
    const { container } = await renderScreen(makeClient({ view: () => Promise.resolve(okResult(readOnly)) }));

    await screen.findByText("夕食");
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.queryByLabelText("amount")).toBeNull();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("検査が文言を宣言していなければ、送信の前の文言は出さない（M1.1 のフォームのまま）", async () => {
    await renderScreen(makeClient({}));

    await screen.findByText("夕食");
    expect(screen.queryByRole("list", { name: "保存する条件" })).toBeNull();
  });
});

describe("追加フォーム", () => {
  it("入力欄は entity の項目だけで、宣言の順に並ぶ（computed・ID・日時は無い）", async () => {
    const { container } = await renderScreen(makeClient({}));

    await screen.findByText("夕食");
    expect(Array.from(container.querySelectorAll("input, textarea")).map((c) => c.getAttribute("name"))).toEqual([
      "description",
      "amount",
      "discount",
      "payer",
      "participants",
    ]);
    for (const notAField of ["paidAmount", "shareAmount", "id", "createdAt", "updatedAt"]) {
      expect(screen.queryByLabelText(notAField)).toBeNull();
    }
  });

  it("送ると client に型の合った値を渡し、成功したら一覧を読み直す", async () => {
    let current = viewWith({ rows: [] });
    const getView = vi.fn(() => Promise.resolve(okResult(current)));
    const addRecord = vi.fn(() => {
      current = VIEW;
      return Promise.resolve(okResult(DINNER));
    });
    const { container } = await renderScreen(makeClient({ view: getView, add: addRecord }));

    await screen.findByText("まだ記録がありません");
    fill("description", "夕食");
    fill("amount", "6600");
    fill("discount", "600");
    fill("payer", "A");
    fill("participants", "A\nB\nC");
    submit();

    await screen.findByText("夕食");
    expect(addRecord).toHaveBeenCalledWith("inst-1", "addExpense", {
      description: "夕食",
      amount: 6600,
      discount: 600,
      payer: "A",
      participants: ["A", "B", "C"],
    });
    expect(getView).toHaveBeenCalledTimes(2);
    expect(rowTexts(container)).toEqual([
      ["夕食", "6600", "600", "A", "A, B, C", "6000", "3", "2000"],
      ["タクシー", "3000", "0", "B", "A, B, C", "3000", "3", "1000"],
    ]);
  });

  it("送信待ちの二重押下でも POST は 1 回", async () => {
    let release: ((result: ClientResult<ApiRow>) => void) | undefined;
    const addRecord = vi.fn(
      () => new Promise<ClientResult<ApiRow>>((done) => (release = done)),
    );
    const { container } = await renderScreen(makeClient({ add: addRecord }));

    await screen.findByLabelText("amount");
    // 1 回目の送信でボタンの文言は「送信中…」に変わるので、同じ form へ 2 回送る
    const form = container.querySelector("form");
    if (form === null) throw new Error("追加のフォームが無い");
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(addRecord).toHaveBeenCalledTimes(1);
    release?.(okResult(DINNER));
    await waitFor(() => expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false));
  });

  it("422 では入力が残り、項目名と検査名が出て、成功扱いの行が増えない", async () => {
    const addRecord = vi.fn(
      (): Promise<ClientResult<ApiRow>> =>
        Promise.resolve({
          ok: false,
          error: {
            status: 422,
            code: "INPUT_REJECTED",
            fields: ["participants"],
            validations: ["positiveAmount"],
          },
        }),
    );
    const { container } = await renderScreen(
      makeClient({ view: () => Promise.resolve(okResult(viewWith({ rows: [] }))), add: addRecord }),
    );

    await screen.findByText("まだ記録がありません");
    fill("description", "昼食");
    fill("amount", "3000");
    fill("participants", "A");
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("participants");
    expect(alert.textContent).toContain("positiveAmount");
    expect((screen.getByLabelText("description") as HTMLInputElement).value).toBe("昼食");
    expect((screen.getByLabelText("amount") as HTMLInputElement).value).toBe("3000");
    // 成功したことにしない：一覧は空のまま
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  });
});

describe("幅 360 CSS px の表示（機械で見られる範囲）", () => {
  it("表だけを横に流し、フォームと保存ボタンは画面幅に収める", async () => {
    const { container } = await renderScreen(makeClient({}));

    await screen.findByText("夕食");
    // 横に長くなる表は入れ物の中でだけ流れる（ページ全体を押し広げない）
    expect(container.querySelector(".table-scroll > table.instant-table")).not.toBeNull();
    // 入力欄と保存ボタンは DOM にあり、隠されていない
    expect(screen.getByLabelText("amount")).toBeDefined();
    expect(screen.getByRole("button", { name: "保存" })).toBeDefined();

    // jsdom 環境では import.meta.url が file: にならないので、vitest の root（このパッケージ）から辿る
    const css = readFileSync(resolvePath(process.cwd(), "src/app/renderer.css"), "utf8");
    expect(css).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.instant-renderer\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.field \.field-input\s*\{[^}]*width:\s*100%/);
  });
});

// ── 参照（ref・参照 list）と検査の文言（M1.2。Issue #106） ────────────────
//
// 見本 warikan の形（member と expense、payer は ref、participants は list of）を宣言と応答として与える。
// 画面が決めるのは「候補をどこから取るか」と「送るのは ID、見せるのは名前」までである。

const WARIKAN_SPEC: ApiSpecBody = {
  instanceId: "inst-1",
  schemaVersion: "community.app-spec/v0.2-draft",
  sourceSha256: "b".repeat(64),
  spec: {
    entities: [
      { name: "member", fields: { name: "string" } },
      {
        name: "expense",
        fields: {
          description: "string",
          amount: "number",
          payer: { type: "ref", to: "member" },
          participants: { type: "list", of: "member" },
        },
      },
    ],
    views: [
      { name: "expenseList", entity: "expense" },
      { name: "memberList", entity: "member" },
    ],
    actions: [
      { name: "addMember", entity: "member" },
      { name: "addExpense", entity: "expense" },
    ],
    validations: [
      {
        name: "positiveAmount",
        entity: "expense",
        expression: "amount > 0",
        message: "金額は 1 円以上にしてください",
      },
      {
        name: "someoneShares",
        entity: "expense",
        expression: "len(participants) > 0",
        message: "割る人を 1 人以上選んでください",
      },
    ],
    computed: [{ name: "headcount", entity: "expense", expression: "len(participants)", type: "number" }],
    permissions: [
      { name: "read", subject: "minIdentity" },
      { name: "write", subject: "minIdentity" },
    ],
    minIdentity: { mode: "anonymous" },
  },
  permissions: { read: true, write: true },
  actions: [
    { name: "addMember", entity: "member" },
    { name: "addExpense", entity: "expense" },
  ],
};

const MEMBER_A = makeRow("m1", { name: "A" }, {});
const MEMBER_B = makeRow("m2", { name: "B" }, {});
const MEMBER_C = makeRow("m3", { name: "C" }, {});

const MEMBER_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "memberList",
  entity: "member",
  fields: ["name"],
  computed: [],
  permissions: { read: true, write: true },
  actions: [{ name: "addMember", entity: "member" }],
  rows: [MEMBER_A, MEMBER_B, MEMBER_C],
};

const WARIKAN_EXPENSE_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "expenseList",
  entity: "expense",
  fields: ["description", "amount", "payer", "participants"],
  computed: ["headcount"],
  permissions: { read: true, write: true },
  actions: [{ name: "addExpense", entity: "expense" }],
  rows: [
    makeRow(
      "e1",
      { description: "夕食", amount: 6000, payer: "m1", participants: ["m1", "m2", "m3"] },
      { headcount: 3 },
    ),
  ],
};

/** warikan の応答を返す client（一覧は名前で切り替える） */
function makeWarikanClient(parts: {
  readonly members?: ApiViewBody;
  readonly add?: MusunestClient["addRecord"];
} = {}): MusunestClient {
  const members = parts.members ?? MEMBER_VIEW;
  const getView = (instanceId: string, name: string): Promise<ClientResult<ApiViewBody>> =>
    Promise.resolve(okResult(name === "memberList" ? members : WARIKAN_EXPENSE_VIEW));
  return makeClient({
    spec: () => Promise.resolve(okResult(WARIKAN_SPEC)),
    view: getView,
    ...(parts.add === undefined ? {} : { add: parts.add }),
  });
}

describe("参照の表示（warikan の形）", () => {
  it("一覧は、ID ではなく名前で見せる", async () => {
    const { container } = await renderScreen(makeWarikanClient());

    await screen.findByText("夕食");
    // payer は A、participants は A・B・C（ID は画面に出さない）
    expect(rowTexts(container)).toEqual([["夕食", "6000", "A", "A, B, C", "3"]]);
    expect(container.textContent).not.toContain("m1");
  });

  it("候補は参照先の一覧から取る（参照の項目が無ければ読まない）", async () => {
    const getView = vi.fn((_instanceId: string, name: string) =>
      Promise.resolve(okResult(name === "memberList" ? MEMBER_VIEW : WARIKAN_EXPENSE_VIEW)),
    );
    const client = makeClient({
      spec: () => Promise.resolve(okResult(WARIKAN_SPEC)),
      view: getView,
    });
    await renderScreen(client);

    await screen.findByText("夕食");
    expect(getView.mock.calls.map((call) => call[1])).toEqual(["expenseList", "memberList"]);
  });

  it("フォームは ref を単一選択、参照 list を複数選択にする", async () => {
    await renderScreen(makeWarikanClient());

    await screen.findByText("夕食");
    const payer = screen.getByLabelText("payer") as HTMLSelectElement;
    expect(payer.tagName).toBe("SELECT");
    expect(Array.from(payer.options).map((option) => option.textContent)).toEqual([
      "（選んでください）",
      "A",
      "B",
      "C",
    ]);
    for (const name of ["A", "B", "C"]) {
      expect(screen.getByRole("checkbox", { name })).toBeDefined();
    }
  });

  it("送るのは ID である（名前ではない）", async () => {
    const addRecord = vi.fn(() => Promise.resolve(okResult(WARIKAN_EXPENSE_VIEW.rows[0] as ApiRow)));
    await renderScreen(makeWarikanClient({ add: addRecord }));

    await screen.findByText("夕食");
    fill("description", "タクシー");
    fill("amount", "3000");
    fireEvent.change(screen.getByLabelText("payer"), { target: { value: "m2" } });
    for (const name of ["A", "B", "C"]) fireEvent.click(screen.getByRole("checkbox", { name }));
    submit();

    await waitFor(() => expect(addRecord).toHaveBeenCalledTimes(1));
    expect(addRecord).toHaveBeenCalledWith("inst-1", "addExpense", {
      description: "タクシー",
      amount: 3000,
      payer: "m2",
      participants: ["m1", "m2", "m3"],
    });
  });

  it("候補が 0 件なら、架空の ID を作らず、先に登録するよう案内する", async () => {
    const { container } = await renderScreen(makeWarikanClient({ members: { ...MEMBER_VIEW, rows: [] } }));

    await screen.findByText("夕食");
    expect(screen.getAllByText("選べる候補がありません。先に登録してください。")).toHaveLength(2);
    expect(screen.queryByRole("checkbox")).toBeNull();
    // 名前を引けないので、分かる範囲（ID）をそのまま出す（**分からないものを消さない**）
    expect(rowTexts(container)).toEqual([["夕食", "6000", "m1", "m1, m2, m3", "3"]]);
  });

  it("送信の前に、宣言した文言を出す（入力補助であって、守りではない）", async () => {
    const { container } = await renderScreen(makeWarikanClient());

    await screen.findByText("夕食");
    const guidance = screen.getByRole("list", { name: "保存する条件" });
    expect(guidance.textContent).toContain("金額は 1 円以上にしてください");
    expect(guidance.textContent).toContain("割る人を 1 人以上選んでください");
    // まだ送信していない（入力補助である）
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelectorAll("b")).toHaveLength(0);
  });

  it("検査の文言を、テキストとして出す（HTML として解釈しない）", async () => {
    const addRecord = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          status: 422,
          code: "INPUT_REJECTED" as const,
          fields: [],
          validations: ["positiveAmount"],
          validationMessages: ["<b>金額</b>は 1 円以上にしてください"],
        },
      }),
    );
    const { container } = await renderScreen(makeWarikanClient({ add: addRecord }));

    await screen.findByText("夕食");
    fill("amount", "0");
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("<b>金額</b>は 1 円以上にしてください");
    expect(container.querySelector("b")).toBeNull();
  });
});

// ── 集計の表示（member の一覧。Issue #107） ─────────────────────────
//
// API が返す member の計算値（`paid`・`owed`・`balance`。entity をまたぐ集計）を、画面は**そのまま**見せる。
// 画面は式も集計も評価しない（`03-spec-layers-and-checker.md` §2.3）。求められなかった集計の `null` は「—」である。

const MEMBER_VIEW_WITH_AGGREGATES: ApiViewBody = {
  ...MEMBER_VIEW,
  computed: ["paid", "owed", "balance"],
  rows: [
    makeRow("m1", { name: "A" }, { paid: 6000, owed: 3000, balance: 3000 }),
    makeRow("m2", { name: "B" }, { paid: 3000, owed: 3000, balance: 0 }),
    makeRow("m3", { name: "C" }, { paid: null, owed: 3000, balance: null }),
  ],
};

describe("集計の表示（member の一覧。M1.2）", () => {
  it("API の member 一覧の計算値をそのまま出し、null は「—」で見せる（0 と区別する）", async () => {
    const getView = (_instanceId: string, name: string) =>
      Promise.resolve(okResult(name === "memberList" ? MEMBER_VIEW_WITH_AGGREGATES : WARIKAN_EXPENSE_VIEW));
    const client = makeClient({ spec: () => Promise.resolve(okResult(WARIKAN_SPEC)), view: getView });
    const { container } = await renderScreen(client);

    await screen.findByText("夕食");
    fireEvent.click(screen.getByRole("button", { name: "memberList" }));
    await screen.findByText("paid");

    // 列は項目（宣言の順）→ 計算（宣言の順）。集計の値は API が返したものをそのまま出す
    expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual([
      "name",
      "paid",
      "owed",
      "balance",
    ]);
    expect(rowTexts(container)).toEqual([
      ["A", "6000", "3000", "3000"],
      ["B", "3000", "3000", "0"],
      ["C", "—", "3000", "—"],
    ]);
  });
});

// ── 表の show と精算の表示（M1.2。Issue #142） ──────────────────────
//
// 見本 warikan の M1.2 の形（`views` に `type: table` と `type: settlement` があり、`expenseList` は
// `show` を持つ）。**画面は宣言をそのまま使う**——`show` の順に列を並べ、精算は API が返した並びを
// 見せるだけである（画面は計算しない。03-spec-layers-and-checker.md §2.3）。

const M12_SPEC: ApiSpecBody = {
  ...WARIKAN_SPEC,
  spec: {
    ...WARIKAN_SPEC.spec,
    views: [
      // `show` を書かない表は、項目（宣言の順）に続いて計算（宣言の順）である
      { name: "memberList", entity: "member", type: "table" },
      // `show` を書けば、その順で列が出る（計算の shareAmount を項目の間に置ける）
      {
        name: "expenseList",
        entity: "expense",
        type: "table",
        show: ["description", "shareAmount", "amount", "payer"],
      },
      // 精算の表示は列の並びを持たない
      { name: "settlement", entity: "member", type: "settlement" },
    ],
  },
};

const M12_MEMBERS: readonly ApiRow[] = [
  makeRow("m1", { name: "A" }, { paid: 6000, owed: 3000, balance: 3000 }),
  makeRow("m2", { name: "B" }, { paid: 3000, owed: 3000, balance: 0 }),
  makeRow("m3", { name: "C" }, { paid: 0, owed: 3000, balance: -3000 }),
];

const M12_EXPENSE_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "expenseList",
  entity: "expense",
  fields: ["description", "amount", "payer", "participants"],
  computed: ["headcount", "shareAmount"],
  permissions: { read: true, write: true },
  actions: [{ name: "addExpense", entity: "expense" }],
  rows: [
    makeRow(
      "e1",
      { description: "夕食", amount: 6000, payer: "m1", participants: ["m1", "m2", "m3"] },
      { headcount: 3, shareAmount: 2000 },
    ),
    makeRow(
      "e2",
      { description: "タクシー", amount: 3000, payer: "m2", participants: ["m1", "m2", "m3"] },
      { headcount: 3, shareAmount: 1000 },
    ),
  ],
};

/** M1.2 の見本の形で答える client。`settlement` を差し替えて、空・読めなかったも作れる */
function makeM12Client(parts: { readonly settlement?: readonly ApiTransfer[] | null } = {}): MusunestClient {
  const settlement: readonly ApiTransfer[] | null =
    parts.settlement === undefined ? [{ from: "m3", to: "m1", amount: 3000 }] : parts.settlement;
  const memberView = (view: string): ApiViewBody => ({
    instanceId: "inst-1",
    view,
    entity: "member",
    fields: ["name"],
    computed: ["paid", "owed", "balance"],
    permissions: { read: true, write: true },
    actions: [{ name: "addMember", entity: "member" }],
    rows: M12_MEMBERS,
    settlement,
  });
  return makeClient({
    spec: () => Promise.resolve(okResult(M12_SPEC)),
    view: (_instanceId, name) =>
      Promise.resolve(okResult(name === "expenseList" ? M12_EXPENSE_VIEW : memberView(name))),
  });
}

/** 一覧の切替のボタンで、見る一覧を選ぶ */
function showTable(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("表の列の順（M1.2）", () => {
  it("show を書かない表は、項目（宣言の順）に続いて計算（宣言の順）である（受入条件）", async () => {
    const { container } = await renderScreen(makeM12Client());

    expect(await screen.findByText("A")).toBeDefined();
    // メンバーの表は name・paid・owed・balance の順に出る
    expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual([
      "name",
      "paid",
      "owed",
      "balance",
    ]);
    expect(rowTexts(container)).toEqual([
      ["A", "6000", "3000", "3000"],
      ["B", "3000", "3000", "0"],
      ["C", "0", "3000", "-3000"],
    ]);
  });

  it("show を書いた表は、その順で列が出る（計算を項目の間にも置ける。受入条件）", async () => {
    const { container } = await renderScreen(makeM12Client());
    expect(await screen.findByText("A")).toBeDefined();

    showTable("expenseList");
    expect(await screen.findByText("夕食")).toBeDefined();

    expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual([
      "description",
      "shareAmount",
      "amount",
      "payer",
    ]);
    // 列の順に、値も並ぶ（payer は ID ではなく名前で見せる）
    expect(rowTexts(container)).toEqual([
      ["夕食", "2000", "6000", "A"],
      ["タクシー", "1000", "3000", "B"],
    ]);
  });
});

describe("精算の表示（M1.2）", () => {
  it("送金元・送金先の ID を名前に写し、「C さん → A さん 3,000 円」の 1 件として見せる（受入条件）", async () => {
    const { container } = await renderScreen(makeM12Client());
    expect(await screen.findByText("A")).toBeDefined();

    showTable("settlement");
    const list = await screen.findByRole("list", { name: "精算" });

    const items = container.querySelectorAll(".settlement li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe("C さん → A さん 3,000 円");
    expect(list.textContent).not.toContain("m3");
    // 精算の表示は表ではない（一覧の部品を `type` で選ぶ）
    expect(container.querySelector(".instant-table")).toBeNull();
  });

  it("精算が空なら「送金は要りません」の状態を出す（受入条件）", async () => {
    const { container } = await renderScreen(makeM12Client({ settlement: [] }));
    expect(await screen.findByText("A")).toBeDefined();

    showTable("settlement");

    expect(await screen.findByText("送金は要りません")).toBeDefined();
    expect(container.querySelector('[data-state="settlementEmpty"]')).not.toBeNull();
    expect(container.querySelectorAll(".settlement li")).toHaveLength(0);
  });

  it("精算を読めなかった（null）なら、空の並びに読み替えずエラーを出す", async () => {
    const { container } = await renderScreen(makeM12Client({ settlement: null }));
    expect(await screen.findByText("A")).toBeDefined();

    showTable("settlement");

    expect(await screen.findByText("精算の結果を表示できません")).toBeDefined();
    expect(container.querySelector('[data-state="settlementUnavailable"]')).not.toBeNull();
    expect(screen.queryByText("送金は要りません")).toBeNull();
  });

  it("行が多いときも全部を縦に並べ、360 CSS px の幅は CSS の規則で崩さない（受入条件）", async () => {
    // 実際の精算では、組（送金元・送金先）は互いに異なる（docs/semantics.md「settle」）
    const many: readonly ApiTransfer[] = Array.from({ length: 30 }, (_item, index) => ({
      from: `m${index + 2}`,
      to: "m1",
      amount: (index + 1) * 1000,
    }));
    const { container } = await renderScreen(makeM12Client({ settlement: many }));
    expect(await screen.findByText("A")).toBeDefined();

    showTable("settlement");
    await screen.findByRole("list", { name: "精算" });

    expect(container.querySelectorAll(".settlement li")).toHaveLength(30);
    expect(container.querySelector(".settlement")?.textContent).toContain("30,000 円");

    // jsdom は layout を持たないので、幅は CSS の規則で確かめる（04 §7.2「機械で測れる分」）
    const css = readFileSync(resolvePath(process.cwd(), "src/app/renderer.css"), "utf8");
    expect(css).toMatch(/\.settlement\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.settlement-transfer\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

describe("失敗したときのエラーの位置（04 §7.2。M1.2）", () => {
  it("エラーは、失敗した項目の入力欄と同じフォームの中に出す（項目のそば）", async () => {
    // **jsdom は layout を持たない**（04 §7.2）。機械で確かめられるのは「どのフォームの、どの項目の話か」
    // までである——実機での見え方は人のデモで見る。ここでは、エラーをページの外（別の入れ物）へ出さず、
    // 入力欄と同じフォームの中に置き、**エラー自身が通らなかった項目を名指しする**ことを固定する。
    const addRecord = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          status: 422,
          code: "INPUT_REJECTED" as const,
          fields: ["participants", "amount"],
          validations: ["positiveAmount"],
        },
      }),
    );
    const { container } = await renderScreen(
      makeClient({ view: () => Promise.resolve(okResult(viewWith({ rows: [] }))), add: addRecord }),
    );

    await screen.findByText("まだ記録がありません");
    const form = container.querySelector("form");
    if (form === null) throw new Error("追加のフォームが無い");
    fill("description", "昼食");
    fill("amount", "0");
    fill("participants", "A");
    submit();

    const alert = await screen.findByRole("alert");
    // エラーは、失敗した項目の入力欄と同じフォームの中にある
    expect(alert.closest("form")).toBe(form);
    for (const name of ["participants", "amount"]) {
      const field = form.querySelector(`[data-field="${name}"]`);
      expect(field, name).not.toBeNull();
      expect(field?.closest("form"), name).toBe(form);
    }
    // どの項目が通らなかったかを、エラーそのものが名指しする
    expect(alert.textContent).toContain("participants");
    expect(alert.textContent).toContain("amount");
    // 打ち直させない（入力値は残る）
    expect((screen.getByLabelText("amount") as HTMLInputElement).value).toBe("0");
  });
});

function rowTexts(container: HTMLElement): string[][] {
  return Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""),
  );
}

// ── 消す（M1.2。Issue #109） ──────────────────────────────────────────
//
// 「参照されているものは消せない」を**画面の非表示で守ろうとしない**（03 §2.2）。
// 画面は data-api が返した `references` を見て、**消せる行にだけボタンを出し、消せない行には理由を出す**。
// 断るのは data-api（唯一の権限強制点）であって、ここはその答えの見せ方である。

const DELETE_ACTIONS = [
  { name: "addExpense", entity: "expense", kind: "create" },
  { name: "deleteExpense", entity: "expense", kind: "delete" },
] as const;

const DELETE_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: { ...SPEC.spec, actions: [...DELETE_ACTIONS] },
  actions: [...DELETE_ACTIONS],
};

const FREE = { ...DINNER, id: "r1", references: [] };
const REFERENCED = {
  ...TAXI,
  id: "r2",
  references: [{ entity: "expense", field: "payer", count: 2 }],
};

const DELETE_VIEW: ApiViewBody = {
  ...VIEW,
  actions: [...DELETE_ACTIONS],
  rows: [FREE, REFERENCED],
};

const deleteClient = (parts: {
  readonly remove?: MusunestClient["deleteRecord"];
} = {}): MusunestClient =>
  makeClient({
    spec: () => Promise.resolve(okResult(DELETE_SPEC)),
    view: () => Promise.resolve(okResult(DELETE_VIEW)),
    remove: parts.remove ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
  });

describe("消す（M1.2）", () => {
  it("delete を宣言していなければ、削除の列そのものを出さない", async () => {
    await renderScreen(makeClient({}));
    // M1.1 の一覧は、見出しも操作の欄も持たない
    expect(screen.queryByRole("columnheader", { name: "操作" })).toBeNull();
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
  });

  it("参照の無い行には削除ボタンが出て、押すと id を渡して一覧を読み直す", async () => {
    const remove = vi.fn<MusunestClient["deleteRecord"]>(() =>
      Promise.resolve(okResult({ entity: "expense", id: "r1", deleted: true })),
    );
    const view = vi.fn<MusunestClient["getView"]>(() => Promise.resolve(okResult(DELETE_VIEW)));
    await renderScreen({ ...deleteClient({ remove }), getView: view });

    // 参照が無い行（r1）にだけボタンが出る
    const buttons = screen.getAllByRole("button", { name: "削除" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("data-delete")).toBe("r1");

    await act(async () => {
      fireEvent.click(buttons[0] as HTMLElement);
    });
    expect(remove).toHaveBeenCalledWith("inst-1", "deleteExpense", "r1");
    // 成功したら**一覧を読み直す**（返ってきた行を勝手に足さない）。初回と合わせて 2 回
    expect(view).toHaveBeenCalledTimes(2);
  });

  it("参照されている行には削除ボタンを出さず、参照元と件数を理由として出す", async () => {
    await renderScreen(deleteClient());

    // ボタンは 1 つだけ（参照されている r2 には無い）
    expect(screen.getAllByRole("button", { name: "削除" })).toHaveLength(1);
    // 理由は、サーバが返した参照元と件数をそのまま見せる
    const blocked = screen.getByText(/他の記録から参照されています/);
    expect(blocked.textContent).toContain("expense.payer 2 件");
  });

  it("サーバが断った理由（409 REFERENCE_IN_USE）を、その場に出す", async () => {
    // 一覧の `references` は古くなっていることがある（別の操作が参照を足した）。
    // そのときは**サーバの答え**を出す——画面の判断だけを守りにしない
    const remove = vi.fn<MusunestClient["deleteRecord"]>(() =>
      Promise.resolve({
        ok: false,
        error: {
          status: 409,
          code: "REFERENCE_IN_USE",
          fields: [],
          validations: [],
          references: [{ entity: "expense", field: "participants", count: 1 }],
        },
      }),
    );
    const client = deleteClient({ remove });
    await renderScreen(client);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "削除" })[0] as HTMLElement);
    });
    const failure = screen.getByRole("alert");
    expect(failure.getAttribute("data-state")).toBe("delete-failed");
    expect(failure.textContent).toContain("expense.participants 1 件");
  });
});
