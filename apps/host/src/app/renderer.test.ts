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
import type { ApiRow, ApiSpecBody, ApiValue, ApiViewBody, ClientErrorCode, ClientResult, MusunestClient } from "@musunest/sdk";

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
}): MusunestClient {
  return {
    getSpec: parts.spec ?? (() => Promise.resolve(okResult(SPEC))),
    getView: parts.view ?? (() => Promise.resolve(okResult(VIEW))),
    addRecord: parts.add ?? (() => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503))),
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

  it("API が返した sentinel の計算値をそのまま出し、null は空欄にする", async () => {
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
    expect(rowTexts(container)).toEqual([["コーヒー", "400", "500", "C", "C", "", "1", "777777"]]);
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

function rowTexts(container: HTMLElement): string[][] {
  return Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
    Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? ""),
  );
}
