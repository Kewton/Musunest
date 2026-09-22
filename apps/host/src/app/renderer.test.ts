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
  computed: Readonly<Record<string, number | boolean | null>>,
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
  readonly apply?: MusunestClient["setRecord"];
}): MusunestClient {
  return {
    getSpec: parts.spec ?? (() => Promise.resolve(okResult(SPEC))),
    getView: parts.view ?? (() => Promise.resolve(okResult(VIEW))),
    addRecord: parts.add ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
    deleteRecord: parts.remove ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
    setRecord: parts.apply ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
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

// ── 選択肢（enum）と既定値（default）の入力欄（M1.3。Issue #154） ────────
//
// `formFields` が**宣言を入力欄へ写す**ことを見る。`form.test.ts` は入力欄の部品だけを見ていて、
// 宣言からの写像を見ていない。ここが抜けると、部品が正しくても実画面に選択肢が出ない——
// #145（9 ゲート緑でも画面が真っ白）と同じ形の穴である。

const TASK_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: {
    ...SPEC.spec,
    entities: [
      {
        name: "task",
        fields: {
          title: "string",
          status: {
            type: "enum",
            options: { todo: "未着手", doing: "進行中", done: "完了" },
            default: "todo",
          },
          memo: "string",
        },
      },
    ],
    views: [{ name: "taskList", entity: "task" }],
    validations: [],
    computed: [],
  },
  actions: [{ name: "addTask", entity: "task" }],
};

const TASK_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "taskList",
  entity: "task",
  fields: ["title", "status", "memo"],
  computed: [],
  permissions: { read: true, write: true },
  actions: [{ name: "addTask", entity: "task" }],
  rows: [],
};

/** 選択肢を含む宣言を返す client（一覧は空。フォームは出る） */
function taskClient(parts: Parameters<typeof makeClient>[0] = {}): MusunestClient {
  return makeClient({
    spec: () => Promise.resolve(okResult(TASK_SPEC)),
    view: () => Promise.resolve(okResult(TASK_VIEW)),
    ...parts,
  });
}

describe("選択肢（enum）の入力欄", () => {
  it("宣言の選択肢が、表示名つきの単一選択として出る（受入条件）", async () => {
    await renderScreen(taskClient());

    const select = (await screen.findByLabelText("status")) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    // 見せるのは表示名である
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "（選んでください）",
      "未着手",
      "進行中",
      "完了",
    ]);
    // 送るのはキーである（**表示名ではない**）
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "",
      "todo",
      "doing",
      "done",
    ]);
    // 既定値は、宣言から写して最初から選ばれている
    expect(select.value).toBe("todo");
  });

  it("選んだキーが、そのまま送信の入力になる（宣言 → 入力欄 → 送信）", async () => {
    const addRecord = vi.fn<MusunestClient["addRecord"]>(() =>
      Promise.resolve(okResult(makeRow("t1", { title: "宿の予約", status: "doing", memo: "" }, {}))),
    );
    await renderScreen(taskClient({ add: addRecord }));

    await screen.findByLabelText("status");
    fill("title", "宿の予約");
    fireEvent.change(screen.getByLabelText("status"), { target: { value: "doing" } });
    submit();

    await waitFor(() =>
      expect(addRecord).toHaveBeenCalledWith("inst-1", "addTask", {
        title: "宿の予約",
        status: "doing",
        memo: "",
      }),
    );
  });

  it("既定値を触らなければ、既定値のキーが送られる", async () => {
    const addRecord = vi.fn<MusunestClient["addRecord"]>(() =>
      Promise.resolve(okResult(makeRow("t2", { title: "宿の予約", status: "todo", memo: "" }, {}))),
    );
    await renderScreen(taskClient({ add: addRecord }));

    await screen.findByLabelText("status");
    fill("title", "宿の予約");
    submit();

    await waitFor(() => expect(addRecord).toHaveBeenCalledTimes(1));
    expect(addRecord.mock.calls[0]?.[2]).toEqual({ title: "宿の予約", status: "todo", memo: "" });
  });
});

// ── 日付（date）の入力欄（M1.3。Issue #155） ─────────────────────────
//
// `formFields` が**宣言を入力欄へ写す**ことを見る。`form.test.ts` は入力欄の部品だけを見ていて、
// 宣言からの写像を見ていない。ここが抜けると、部品が正しくても実画面に日付の欄が出ない——
// #145（9 ゲート緑でも画面が真っ白）と同じ形の穴である。

const DUE_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: {
    ...SPEC.spec,
    entities: [
      {
        name: "task",
        fields: {
          title: "string",
          due: "date",
          memo: "string",
        },
      },
    ],
    views: [{ name: "taskList", entity: "task" }],
    validations: [],
    computed: [],
  },
  actions: [{ name: "addTask", entity: "task" }],
};

const DUE_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "taskList",
  entity: "task",
  fields: ["title", "due", "memo"],
  computed: [],
  permissions: { read: true, write: true },
  actions: [{ name: "addTask", entity: "task" }],
  rows: [],
};

/** 日付の項目を含む宣言を返す client（一覧は空。フォームは出る） */
function dueClient(parts: Parameters<typeof makeClient>[0] = {}): MusunestClient {
  return makeClient({
    spec: () => Promise.resolve(okResult(DUE_SPEC)),
    view: () => Promise.resolve(okResult(DUE_VIEW)),
    ...parts,
  });
}

describe("日付（date）の入力欄", () => {
  it("宣言の日付の項目が、日付の入力欄として出る（受入条件）", async () => {
    const { container } = await renderScreen(dueClient());

    const due = (await screen.findByLabelText("due")) as HTMLInputElement;
    expect(due.tagName).toBe("INPUT");
    // ブラウザの日付の入力欄は、`YYYY-MM-DD` の値を扱う（保存する形と同じ）
    expect(due.getAttribute("type")).toBe("date");
    // 入力欄になるのは entity の項目だけで、宣言の順に並ぶ
    expect(
      Array.from(container.querySelectorAll("input, textarea")).map((control) =>
        control.getAttribute("name"),
      ),
    ).toEqual(["title", "due", "memo"]);
  });

  it("未入力を空のまま送れる（今日を勝手に入れない。受入条件）", async () => {
    const addRecord = vi.fn<MusunestClient["addRecord"]>(() =>
      Promise.resolve(okResult(makeRow("t1", { title: "宿の予約", due: "", memo: "" }, {}))),
    );
    await renderScreen(dueClient({ add: addRecord }));

    await screen.findByLabelText("due");
    expect((screen.getByLabelText("due") as HTMLInputElement).value).toBe("");
    fill("title", "宿の予約");
    submit();

    await waitFor(() => expect(addRecord).toHaveBeenCalledTimes(1));
    // 空文字をそのまま送る。断るかどうかは data-api が決める（画面は守りではない）
    expect(addRecord.mock.calls[0]?.[2]).toEqual({ title: "宿の予約", due: "", memo: "" });
  });

  it("選んだ日付が、そのまま `YYYY-MM-DD` の文字列として送られる", async () => {
    const addRecord = vi.fn<MusunestClient["addRecord"]>(() =>
      Promise.resolve(okResult(makeRow("t2", { title: "宿の予約", due: "2026-09-20", memo: "" }, {}))),
    );
    await renderScreen(dueClient({ add: addRecord }));

    await screen.findByLabelText("due");
    fill("title", "宿の予約");
    fill("due", "2026-09-20");
    submit();

    await waitFor(() => expect(addRecord).toHaveBeenCalledTimes(1));
    expect(addRecord.mock.calls[0]?.[2]).toEqual({ title: "宿の予約", due: "2026-09-20", memo: "" });
  });
});

// ── 決まった値への書き換え（set）とボタンを出す条件（when）（M1.3。Issue #156） ──
//
// **画面は `when` の式を評価しない。** API が返した `row.allowedActions` をそのまま見て、
// ボタンを出し分けるだけである（`CLAUDE.md` の不変条件）。ボタンを隠すのは**親切**であって
// 守りではない——条件を満たさない操作を断るのは data-api である（`03` §2.2）。
// だから、サーバが 409 `ACTION_NOT_ALLOWED` を返したときは、その理由をその場に出す。

const BOARD_ACTIONS = [
  { name: "addTask", entity: "task", kind: "create" as const },
  { name: "start", entity: "task", kind: "update" as const, set: { status: "doing" }, when: 'status == "todo"' },
  { name: "finish", entity: "task", kind: "update" as const, set: { status: "done" }, when: 'status != "done"' },
];

const BOARD_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: {
    ...SPEC.spec,
    entities: [
      {
        name: "task",
        fields: {
          title: "string",
          status: {
            type: "enum",
            options: { todo: "未着手", doing: "進行中", done: "完了" },
            default: "todo",
          },
        },
      },
    ],
    views: [{ name: "taskList", entity: "task" }],
    actions: BOARD_ACTIONS,
    validations: [],
    computed: [],
  },
  actions: BOARD_ACTIONS.map(({ name, entity, kind }) => ({ name, entity, kind })),
};

/** `allowedActions` は **data-api が判定した結果**である（画面は式を評価しない） */
const boardRow = (id: string, status: string, allowedActions: readonly string[]): ApiRow => ({
  ...makeRow(id, { title: `タスク ${id}`, status }, {}),
  allowedActions,
});

const TODO_ROW = boardRow("t1", "todo", ["start", "finish"]);
const DONE_ROW = boardRow("t2", "done", []);

const BOARD_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "taskList",
  entity: "task",
  fields: ["title", "status"],
  computed: [],
  permissions: { read: true, write: true },
  actions: BOARD_SPEC.actions.filter((item) => item.entity === "task"),
  rows: [TODO_ROW, DONE_ROW],
};

function boardClient(parts: Parameters<typeof makeClient>[0] = {}): MusunestClient {
  return makeClient({
    spec: () => Promise.resolve(okResult(BOARD_SPEC)),
    view: () => Promise.resolve(okResult(BOARD_VIEW)),
    ...parts,
  });
}

describe("決まった値への書き換え（set）と条件（when）（M1.3）", () => {
  it("when が偽の行では、そのボタンを出さない（受入条件）", async () => {
    await renderScreen(boardClient());

    // 未着手の行（t1）には「始める」「完了にする」の両方が出る
    const todoButtons = Array.from(document.querySelectorAll('[data-row="t1"]')).map((node) =>
      node.getAttribute("data-action"),
    );
    expect(todoButtons).toEqual(["start", "finish"]);

    // 完了の行（t2）には、**どちらのボタンも出ない**（allowedActions が空である）
    expect(document.querySelectorAll('[data-row="t2"]')).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "start" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "start" })).toHaveLength(1);
  });

  it("allowedActions が一部だけのときは、その操作のボタンだけを出す", async () => {
    const rows = [boardRow("t3", "doing", ["finish"])];
    const client = boardClient({ view: () => Promise.resolve(okResult({ ...BOARD_VIEW, rows })) });
    await renderScreen(client);

    const actions = Array.from(document.querySelectorAll('[data-row="t3"]')).map((node) =>
      node.getAttribute("data-action"),
    );
    // 「始める」は出ない（進行中の行では when が偽である）
    expect(actions).toEqual(["finish"]);
  });

  it("押すと id だけを渡して実行し、成功したら一覧を読み直す", async () => {
    const apply = vi.fn<MusunestClient["setRecord"]>(() =>
      Promise.resolve(okResult(makeRow("t1", { title: "タスク t1", status: "doing" }, {}))),
    );
    const view = vi.fn<MusunestClient["getView"]>(() => Promise.resolve(okResult(BOARD_VIEW)));
    await renderScreen({ ...boardClient({ apply }), getView: view });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "finish" }));
    });
    // 送るのは**対象の行の ID だけ**である（何を書くかは宣言が持つ）
    expect(apply).toHaveBeenCalledWith("inst-1", "finish", "t1");
    // 成功したら一覧を読み直す（返ってきた行を勝手に足さない）。初回と合わせて 2 回
    expect(view).toHaveBeenCalledTimes(2);
  });

  it("サーバが断った理由（409 ACTION_NOT_ALLOWED）を、その場に出す", async () => {
    // 一覧の `allowedActions` は古くなっていることがある（別の操作が値を変えた）。
    // そのときは**サーバの答え**を出す——画面の判断だけを守りにしない
    const apply = vi.fn<MusunestClient["setRecord"]>(() =>
      Promise.resolve({
        ok: false,
        error: {
          status: 409,
          code: "ACTION_NOT_ALLOWED",
          fields: [],
          validations: [],
          action: "finish",
          when: 'status != "done"',
        },
      }),
    );
    await renderScreen(boardClient({ apply }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "finish" }));
    });
    const failure = screen.getByRole("alert");
    expect(failure.getAttribute("data-state")).toBe("action-failed");
    // どの操作のどの条件かを、そのまま見せる
    expect(failure.textContent).toContain("finish");
    expect(failure.textContent).toContain('status != "done"');
  });

  it("allowedActions が無い応答では、ボタンを隠さない（M1.2 の応答を変えない）", async () => {
    // `when` を 1 つも宣言していない entity では、data-api は欄そのものを載せない。
    // **「条件が宣言されていない」を「何もできない」に読み替えない**
    const rows = [makeRow("t4", { title: "タスク t4", status: "done" }, {})];
    const client = boardClient({ view: () => Promise.resolve(okResult({ ...BOARD_VIEW, rows })) });
    await renderScreen(client);

    const actions = Array.from(document.querySelectorAll('[data-row="t4"]')).map((node) =>
      node.getAttribute("data-action"),
    );
    expect(actions).toEqual(["start", "finish"]);
  });

  it("set を宣言していない entity には、操作の列そのものを出さない", async () => {
    await renderScreen(makeClient({}));
    expect(screen.queryByRole("columnheader", { name: "操作" })).toBeNull();
    expect(document.querySelectorAll("[data-action]")).toHaveLength(0);
  });
});

// ── ボード（board）と強調（highlight）（M1.3。Issue #157） ────────────────
//
// `type: board` の一覧。列は `options` に書いた順、強調は **API が行に載せた真偽の値**をそのまま見る
// （**画面は式を評価しない**。判定は data-api）。強調は**色だけに頼らない**——記号と文字の印を添える
// （`04-spec-evolution.md` §7.2）。4 つの状態と列の並びは board.test.ts が見る。

const BOARD_LAYOUT_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: {
    ...SPEC.spec,
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
  },
  actions: [{ name: "addTask", entity: "task" }],
};

/** API が判定した強調の結果（`computed.overdue`）を行に載せる */
const boardCard = (id: string, status: string, overdue: boolean): ApiRow =>
  makeRow(id, { title: `タスク ${id}`, due: "2026-09-15", status }, { overdue });

const BOARD_LAYOUT_VIEW: ApiViewBody = {
  instanceId: "inst-1",
  view: "taskBoard",
  entity: "task",
  fields: ["title", "due", "status"],
  computed: [],
  permissions: { read: true, write: true },
  actions: [{ name: "addTask", entity: "task" }],
  rows: [boardCard("t1", "todo", true), boardCard("t2", "done", false)],
};

const boardLayoutClient = (view: ApiViewBody = BOARD_LAYOUT_VIEW): MusunestClient =>
  makeClient({
    spec: () => Promise.resolve(okResult(BOARD_LAYOUT_SPEC)),
    view: () => Promise.resolve(okResult(view)),
  });

describe("ボード（board）と強調（highlight）（M1.3）", () => {
  it("強調された行に、色以外の印が付く（受入条件）", async () => {
    const { container } = await renderScreen(boardLayoutClient());

    await screen.findByText("タスク t1");
    const marked = container.querySelector('[data-card="t1"]');
    // 印は属性で見分けられる（色ではない）
    expect(marked?.getAttribute("data-highlighted")).toBe("true");
    // **色だけに頼らない**——記号と、強調の名前（文字）を添える
    const mark = marked?.querySelector(".highlight-mark");
    expect(mark).not.toBeNull();
    expect((mark?.textContent ?? "").trim()).not.toBe("");
    expect(mark?.textContent).toContain("overdue");
    expect(mark?.getAttribute("aria-label")).toContain("overdue");
    // 強調されていない行には付かない
    expect(container.querySelector('[data-card="t2"] .highlight-mark')).toBeNull();
    expect(container.querySelector('[data-card="t2"]')?.getAttribute("data-highlighted")).toBe("false");
  });
});

// ── アプリ全体の集計（`scope: app`）と平均（`avg`）を画面へ写す（M1.4。Issue #177） ──
//
// **宣言からの写像**を見る（`form.test.ts` は入力欄の部品しか見ていない）。アプリ全体の値は
// **API が返した `scope` をそのまま出す**（画面は式も集計も評価しない）。`null` は「—」で見せて
// 0 と区別する。割り算の表示は**小数第 1 位まで（四捨五入）**である（値そのものは丸めない）。

const SCOPE_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: {
    ...SPEC.spec,
    computed: [
      ...SPEC.spec.computed,
      {
        name: "activityCount",
        scope: "app",
        aggregate: { kind: "count", entity: "expense", name: null, where: {} },
        type: "number",
      },
      {
        name: "averageAttendees",
        scope: "app",
        aggregate: { kind: "avg", entity: "expense", name: "amount", where: {} },
        type: "number",
      },
    ],
  },
};

/** `scope` を差し替えて答える client（宣言にもアプリ全体の計算がある） */
const scopeClient = (scope: NonNullable<ApiViewBody["scope"]>): MusunestClient =>
  makeClient({
    spec: () => Promise.resolve(okResult(SCOPE_SPEC)),
    view: () => Promise.resolve(okResult({ ...VIEW, scope })),
  });

/** `data-scope-name` の部品が出している値（`dd` の中身） */
const scopeValueOf = (container: HTMLElement, name: string): string =>
  container.querySelector(`[data-scope-name="${name}"] dd`)?.textContent ?? "";

describe("アプリ全体の集計（scope: app）と平均（avg）を画面へ写す（M1.4）", () => {
  it("API が返した scope の値をそのまま出し、null は「—」で見せる（0 と区別する）", async () => {
    const { container } = await renderScreen(scopeClient({ activityCount: 3, averageAttendees: null }));

    expect(container.querySelector('[data-scope="true"]')).not.toBeNull();
    expect(scopeValueOf(container, "activityCount")).toBe("3");
    expect(scopeValueOf(container, "averageAttendees")).toBe("—");
  });

  it("**宣言が無ければ scope を描かない**（M1.1〜M1.3 の画面を変えない）", async () => {
    // VIEW は `scope` を持たない（宣言にもアプリ全体の計算が無い）
    const { container } = await renderScreen(makeClient({}));
    expect(container.querySelector('[data-scope="true"]')).toBeNull();
  });

  it("**割り算の表示は小数第 1 位まで（四捨五入）**。整数はそのままである", async () => {
    const { container } = await renderScreen(
      scopeClient({ activityCount: 2000, averageAttendees: 2.666_666_6 }),
    );

    // 値そのものは丸めない——**見せ方だけ**が小数第 1 位である
    expect(scopeValueOf(container, "averageAttendees")).toBe("2.7");
    // 整数はそのまま見せる（`2000.0` にしない）
    expect(scopeValueOf(container, "activityCount")).toBe("2000");
  });

  it("行の計算値にも同じ見せ方を使う（3.3333… は 3.3）", async () => {
    const row = makeRow(
      "r9",
      { description: "コーヒー", amount: 1000, discount: 0, payer: "C", participants: ["A", "B", "C"] },
      { paidAmount: 1000, headcount: 3, shareAmount: 1000 / 3 },
    );
    const { container } = await renderScreen(makeClient({ view: () => Promise.resolve(okResult({ ...VIEW, rows: [row] })) }));

    expect(rowTexts(container)).toEqual([
      ["コーヒー", "1000", "0", "C", "A, B, C", "1000", "3", "333.3"],
    ]);
  });
});

// ── 見出しごとの集計（`groupBy`・`groups`）を画面へ写す（M1.4。Issue #179） ──
//
// **宣言からの写像**を見る（`form.test.ts` は入力欄の部品しか見ていない。`docs/parallel-development.md` §7.3）。
// 見出しごとの値は **API が返した `groups` をそのまま出す**（画面は式も集計も評価しない）。`enum` の見出しは
// **宣言の `options` の表示名に写す**（送るのはキー、見せるのは表示名という `enum` の決めごとと同じ）。

/** `expense` に選択肢（`enum`）の項目 `kind` と、見出しごとの集計 `byKind` を足した宣言 */
const GROUPS_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: {
    ...SPEC.spec,
    entities: [
      {
        name: "expense",
        fields: {
          description: "string",
          amount: "number",
          discount: "number",
          payer: "string",
          participants: "list",
          kind: { type: "enum", options: { practice: "練習", match: "試合" } },
        },
      },
    ],
    computed: [
      ...SPEC.spec.computed,
      {
        name: "byKind",
        aggregate: {
          kind: "count",
          entity: "expense",
          name: null,
          where: {},
          groupBy: { field: "kind", month: false },
        },
        type: "groups",
      },
    ],
  },
};

/** `groups` を差し替えて答える client（宣言にも見出しごとの集計がある） */
const groupsClient = (groups: NonNullable<ApiViewBody["groups"]>): MusunestClient =>
  makeClient({
    spec: () => Promise.resolve(okResult(GROUPS_SPEC)),
    view: () => Promise.resolve(okResult({ ...VIEW, groups })),
  });

/** `data-group-name` の組の、[見出しの表示名, 値] を並びの順に読む */
const groupEntriesOf = (container: HTMLElement, name: string): [string, string][] =>
  [...container.querySelectorAll(`[data-group-name="${name}"] .group-entry`)].map((entry) => [
    entry.querySelector(".group-heading")?.textContent ?? "",
    entry.querySelector(".group-number")?.textContent ?? "",
  ]);

describe("見出しごとの集計（groupBy・groups）を画面へ写す（M1.4）", () => {
  it("API が返した組をそのまま出し、enum の見出しは表示名に写す。null は「—」で見せる", async () => {
    const { container } = await renderScreen(
      groupsClient({
        byKind: [
          { heading: "practice", value: 2 },
          { heading: "match", value: 1 },
          { heading: "party", value: null },
        ],
      }),
    );

    expect(container.querySelector('[data-groups="true"]')).not.toBeNull();
    // 送られてくるのはキー（practice・match）だが、見せるのは表示名（練習・試合）である。
    // 宣言に無いキー（party）は、キーのまま出す。値の `null` は「—」である（0 と区別する）
    expect(groupEntriesOf(container, "byKind")).toEqual([
      ["練習", "2"],
      ["試合", "1"],
      ["party", "—"],
    ]);
  });

  it("月の見出し（`YYYY-MM`）はそのまま出し、値はそのまま見せる", async () => {
    const { container } = await renderScreen(
      groupsClient({
        byMonth: [
          { heading: "2026-08", value: 0 },
          { heading: "2026-09", value: 3 },
        ],
      }),
    );

    expect(groupEntriesOf(container, "byMonth")).toEqual([
      ["2026-08", "0"],
      ["2026-09", "3"],
    ]);
  });

  it("**宣言が無ければ groups を描かない**（M1.1〜M1.3 の画面を変えない）", async () => {
    // VIEW は `groups` を持たない（宣言にも見出しごとの集計が無い）
    const { container } = await renderScreen(makeClient({}));
    expect(container.querySelector('[data-groups="true"]')).toBeNull();
  });
});

// ── 期間の条件（`within`）を画面へ写す（M1.4。Issue #178） ──────────────
//
// **宣言からの写像**を見る（`form.test.ts` は入力欄の部品しか見ていない。`docs/parallel-development.md` §7.3）。
// `within` は見せ方を変えない——**API が求めた今月の値をそのまま出す**（画面は式も集計も評価しない）。
// ここで確かめるのは「この Issue で足す語彙（`where` の `within`）を含む宣言を画面がそのまま読めること」と、
// 「その値が画面に出ること」である。`null` は「—」で見せて 0 と区別する。

/** `where` に `within`（今月）を持つアプリ全体の集計を足した宣言 */
const WITHIN_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: {
    ...SPEC.spec,
    computed: [
      ...SPEC.spec.computed,
      {
        name: "activityThisMonth",
        scope: "app",
        aggregate: {
          kind: "count",
          entity: "expense",
          name: null,
          where: { date: { op: "within", period: "this_month" } },
        },
        type: "number",
      },
    ],
  },
};

describe("期間の条件（within）を画面へ写す（M1.4）", () => {
  it("within を含む正規化 JSON を読み、API が返した今月の値をそのまま出す", async () => {
    const client = makeClient({
      spec: () => Promise.resolve(okResult(WITHIN_SPEC)),
      view: () => Promise.resolve(okResult({ ...VIEW, scope: { activityThisMonth: 3 } })),
    });
    const { container } = await renderScreen(client);

    expect(container.querySelector('[data-scope="true"]')).not.toBeNull();
    expect(scopeValueOf(container, "activityThisMonth")).toBe("3");
  });

  it("今月の活動が 0 件のときは「—」で見せる（0 と区別する）", async () => {
    const client = makeClient({
      spec: () => Promise.resolve(okResult(WITHIN_SPEC)),
      view: () => Promise.resolve(okResult({ ...VIEW, scope: { activityThisMonth: null } })),
    });
    const { container } = await renderScreen(client);

    expect(scopeValueOf(container, "activityThisMonth")).toBe("—");
  });
});

// ── 表示名（label）を画面へ写す（M1.3。Issue #176） ─────────────────────
//
// **宣言からの写像**を見る（`form.test.ts` は入力欄の部品しか見ていない。`04` §7.2・`docs/parallel-development.md` §7.3）。
// 表示名は API が一覧の応答の `labels` に載せ、画面は `displayNameOf` で読む——**無ければ識別子のまま**である。
// 強調の印の文字は、`highlight` が指す計算の `label` である（無ければ識別子）。

/** 表示名つきの expense。description にだけ label を書く（ほかは識別子のまま） */
const LABELED_EXPENSE_SPEC: ApiSpecBody = {
  ...SPEC,
  spec: {
    ...SPEC.spec,
    entities: [
      {
        name: "expense",
        fields: {
          description: { type: "string", label: "内容" },
          amount: "number",
          discount: "number",
          payer: "string",
          participants: "list",
        },
      },
    ],
  },
};

const LABELED_EXPENSE_VIEW: ApiViewBody = { ...VIEW, labels: { description: "内容" } };

const labeledExpenseClient = (parts: Parameters<typeof makeClient>[0] = {}): MusunestClient =>
  makeClient({
    spec: () => Promise.resolve(okResult(LABELED_EXPENSE_SPEC)),
    view: () => Promise.resolve(okResult(LABELED_EXPENSE_VIEW)),
    ...parts,
  });

describe("表示名（label）を画面へ写す（M1.3）", () => {
  it("表の見出しは label で出て、label の無いものは識別子のままである（受入条件）", async () => {
    const { container } = await renderScreen(labeledExpenseClient());

    await screen.findByText("夕食");
    expect(Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual([
      // description だけが label を持つ。ほかは識別子のままである（**混ざらない**）
      "内容",
      "amount",
      "discount",
      "payer",
      "participants",
      "paidAmount",
      "headcount",
      "shareAmount",
    ]);
  });

  it("追加フォームの入力欄の見出しも label で出る（送る値は識別子のまま）", async () => {
    const { container } = await renderScreen(labeledExpenseClient());

    await screen.findByLabelText("内容");
    // 見えるのは label である
    const input = screen.getByLabelText("内容") as HTMLInputElement;
    expect(input.getAttribute("name")).toBe("description");
    // 入力欄の名前（送る値の手がかり）は識別子のままである
    expect(container.querySelector('[data-field="description"] label')?.textContent).toBe("内容");
  });

  it("ボードの項目と、強調の印は label で出る（受入条件）", async () => {
    const spec: ApiSpecBody = {
      ...BOARD_LAYOUT_SPEC,
      spec: {
        ...BOARD_LAYOUT_SPEC.spec,
        entities: [
          {
            name: "task",
            fields: {
              title: { type: "string", label: "やること" },
              due: "date",
              status: {
                type: "enum",
                label: "状態",
                options: { todo: "未着手", doing: "進行中", done: "完了" },
                default: "todo",
              },
            },
          },
        ],
        computed: [
          { name: "overdue", entity: "task", type: "boolean", label: "期限切れ", expression: "due < today()" },
        ],
      },
    };
    const view: ApiViewBody = { ...BOARD_LAYOUT_VIEW, labels: { title: "やること", status: "状態", overdue: "期限切れ" } };
    const { container } = await renderScreen(
      makeClient({ spec: () => Promise.resolve(okResult(spec)), view: () => Promise.resolve(okResult(view)) }),
    );

    await screen.findByText("タスク t1");
    const termOf = (field: string): string =>
      container.querySelector(`[data-field="${field}"] dt`)?.textContent ?? "";
    // 項目は宣言の label で出る（**識別子ではない**）
    expect(termOf("title")).toBe("やること");
    expect(termOf("status")).toBe("状態");
    // label を書かなければ、識別子のままである
    expect(termOf("due")).toBe("due");
    // **強調の印の文字は、highlight が指す計算の label** である（無ければ識別子）
    const mark = container.querySelector('[data-card="t1"] .highlight-mark');
    expect(mark?.textContent).toContain("期限切れ");
    expect(mark?.textContent).not.toContain("overdue");
  });
});
