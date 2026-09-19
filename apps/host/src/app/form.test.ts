// @vitest-environment jsdom
//
// 追加フォームの unit（Issue #104）。見本「支出の記録」の 5 項目をそのまま入力欄にして、
// **宣言の順・送る値の型・断られたときの振る舞い**を確かめる。
//
// ここで見るのはフォーム自身の約束である。
//   - string は文字列（空文字も有効）、number は有限の数、list は入力順の文字列配列として送る
//   - 入力補助で空文字・重複・順序を勝手に削らない
//   - 送信中の二重押下でも onSubmit は 1 回
//   - 失敗したら入力値を残し、項目名と検査名を見せる
// 一覧の描画と状態の区別は renderer.test.ts が見る。

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddForm } from "./form";
import type { AddFormResult, FormField } from "./form";
import type { ApiValue } from "@musunest/sdk";

const FIELDS: readonly FormField[] = [
  { name: "description", type: "string" },
  { name: "amount", type: "number" },
  { name: "discount", type: "number" },
  { name: "payer", type: "string" },
  { name: "participants", type: "list" },
];

const accepted: AddFormResult = { ok: true };

type Submit = (values: Readonly<Record<string, ApiValue>>) => Promise<AddFormResult>;

/** 引数の型を保つ spy（`vi.fn` のままだと `mock.calls` が空の tuple になり、送った値が読めない） */
const submitSpy = (impl: Submit) => vi.fn<Submit>(impl);

afterEach(cleanup);

function renderForm(onSubmit: (values: Readonly<Record<string, ApiValue>>) => Promise<AddFormResult>) {
  return render(createElement(AddForm, { action: "addExpense", fields: FIELDS, onSubmit }));
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

describe("項目の並び", () => {
  it("渡された宣言の順に 5 つの入力欄を作る", () => {
    const { container } = renderForm(() => Promise.resolve(accepted));
    const controls = Array.from(container.querySelectorAll("input, textarea"));

    expect(controls.map((control) => control.getAttribute("name"))).toEqual(FIELDS.map((field) => field.name));
    expect(container.querySelector("textarea")?.getAttribute("name")).toBe("participants");
  });
});

// ── 表示名（label）（M1.3。Issue #176） ────────────────────────────────

describe("表示名（label）", () => {
  it("label があればそれを、無ければ識別子をラベルに出す（送る値は識別子のまま。受入条件）", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    render(
      createElement(AddForm, {
        action: "addTask",
        fields: [
          { name: "title", label: "やること", type: "string" },
          { name: "memo", type: "string" },
        ],
        onSubmit,
      }),
    );

    // 見えるのは label で、入力欄の名前（送る値の手がかり）は識別子のままである
    expect((screen.getByLabelText("やること") as HTMLInputElement).getAttribute("name")).toBe("title");
    // label を書いていない項目は、識別子のままである
    expect((screen.getByLabelText("memo") as HTMLInputElement).getAttribute("name")).toBe("memo");

    fill("やること", "宿の予約");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ title: "宿の予約", memo: "" });
  });
});

describe("送る値", () => {
  it("string は文字列、number は JSON の数、list は入力順の文字列配列", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderForm(onSubmit);

    fill("description", "夕食");
    fill("amount", "6600");
    fill("discount", "600");
    fill("payer", "A");
    fill("participants", "A\nB\nC");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      description: "夕食",
      amount: 6600,
      discount: 600,
      payer: "A",
      participants: ["A", "B", "C"],
    });
  });

  it("空文字は 1 つの値としてそのまま送る", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderForm(onSubmit);

    fill("amount", "900");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ description: "", payer: "" });
  });

  it("list の空行・重複・順序を削らない（意味の決定は data-api が行う）", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderForm(onSubmit);

    fill("participants", "B\n\nA\nA\n");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.participants).toEqual(["B", "", "A", "A", ""]);
  });

  it("有限の数にならない number は数にせず、文字列のまま送って型の検査に委ねる", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderForm(onSubmit);

    fill("amount", "1e400");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.amount).toBe("1e400");

    onSubmit.mockClear();
    fill("amount", "");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.amount).toBe("");
  });
});

describe("断られたとき", () => {
  it("入力値を残し、通らなかった項目名と検査名を見せる", async () => {
    const onSubmit = submitSpy(() =>
      Promise.resolve({ ok: false, fields: ["participants", "amount"], validations: ["positiveAmount"] }),
    );
    renderForm(onSubmit);

    fill("description", "返品");
    fill("amount", "0");
    fill("payer", "A");
    fill("participants", "A");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("participants, amount");
    expect(alert.textContent).toContain("positiveAmount");
    // 打ち直させない：入力した値がそのまま残っている
    expect(fieldValue("description")).toBe("返品");
    expect(fieldValue("amount")).toBe("0");
    expect(fieldValue("participants")).toBe("A");
  });

  it("成功したら入力欄を空に戻す", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderForm(onSubmit);

    fill("description", "夕食");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(fieldValue("description")).toBe(""));
  });
});

describe("送信中の二重押下", () => {
  it("待っている間に 2 回送っても onSubmit は 1 回で、ボタンは押せない", async () => {
    let release: ((result: AddFormResult) => void) | undefined;
    const onSubmit = submitSpy(() => new Promise<AddFormResult>((done) => (release = done)));
    const { container } = renderForm(onSubmit);

    const form = container.querySelector("form");
    if (form === null) throw new Error("form が無い");
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);

    release?.(accepted);
    await waitFor(() => expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false));
  });
});

// ── 参照（ref・参照 list）と検査の文言（M1.2。Issue #106） ────────────────
//
// 画面が決めるのは「どの入力欄を出すか」と「ID を送ること」までである。
// 実在の確認も保存の可否も data-api が行う（画面の判定は守りではない）。

const MEMBER_OPTIONS = [
  { value: "m1", label: "A" },
  { value: "m2", label: "B" },
  { value: "m3", label: "C" },
] as const;

const REF_FIELDS: readonly FormField[] = [
  { name: "description", type: "string" },
  { name: "amount", type: "number" },
  { name: "payer", type: "ref", to: "member", options: MEMBER_OPTIONS },
  { name: "participants", type: "list", to: "member", options: MEMBER_OPTIONS },
];

const renderRefForm = (
  onSubmit: (values: Readonly<Record<string, ApiValue>>) => Promise<AddFormResult>,
  fields: readonly FormField[] = REF_FIELDS,
) => render(createElement(AddForm, { action: "addExpense", fields, onSubmit }));

describe("参照の入力", () => {
  it("ref は単一選択である（選べるのは候補だけ）", () => {
    renderRefForm(() => Promise.resolve(accepted));
    const select = screen.getByLabelText("payer") as HTMLSelectElement;

    expect(select.tagName).toBe("SELECT");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "（選んでください）",
      "A",
      "B",
      "C",
    ]);
  });

  it("参照 list は複数選択である（候補ごとにチェックを出す）", () => {
    renderRefForm(() => Promise.resolve(accepted));
    const boxes = MEMBER_OPTIONS.map(
      (option) => screen.getByRole("checkbox", { name: option.label }) as HTMLInputElement,
    );

    expect(boxes.map((box) => box.value)).toEqual(["m1", "m2", "m3"]);
    for (const box of boxes) expect(box.type).toBe("checkbox");
  });

  it("送るのは ID で、名前ではない（参照 list は候補の順に並べる）", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderRefForm(onSubmit);

    fill("description", "夕食");
    fill("amount", "6000");
    fireEvent.change(screen.getByLabelText("payer"), { target: { value: "m2" } });
    // C → A の順に押しても、送る並びは候補の順（A・B・C）になる
    fireEvent.click(screen.getByRole("checkbox", { name: "C" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      description: "夕食",
      amount: 6000,
      payer: "m2",
      participants: ["m1", "m3"],
    });
  });

  it("候補が 0 件でも架空の ID を作らず、先に登録するよう案内する", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderRefForm(onSubmit, [
      { name: "payer", type: "ref", to: "member", options: [] },
      { name: "participants", type: "list", to: "member", options: [] },
    ]);

    expect(screen.getAllByText("選べる候補がありません。先に登録してください。")).toHaveLength(2);
    expect(screen.queryByRole("checkbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // 空文字と空の並びを送る（data-api が断る。**もっともらしい ID をでっち上げない**）
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ payer: "", participants: [] });
  });
});

describe("検査の文言", () => {
  it("文言があれば文言を、無ければ検査の名前を出す", async () => {
    const onSubmit = submitSpy(() =>
      Promise.resolve({
        ok: false,
        fields: ["amount"],
        validations: ["positiveAmount", "someoneShares"],
        validationMessages: ["金額は 1 円以上にしてください", null],
      }),
    );
    renderForm(onSubmit);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("金額は 1 円以上にしてください");
    // 文言の無い検査は、従来どおり検査の名前で識別する
    expect(alert.textContent).toContain("someoneShares");
  });

  it("複数の失敗は、宣言の順に出す", async () => {
    const onSubmit = submitSpy(() =>
      Promise.resolve({
        ok: false,
        fields: [],
        validations: ["first", "second"],
        validationMessages: ["1 つ目", "2 つ目"],
      }),
    );
    renderForm(onSubmit);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 つ目");
    expect(alert.textContent?.indexOf("1 つ目")).toBeLessThan(
      alert.textContent.indexOf("2 つ目"),
    );
  });

  it("文言に HTML が入っていても、テキストとして出す", async () => {
    const onSubmit = submitSpy(() =>
      Promise.resolve({
        ok: false,
        fields: [],
        validations: ["positiveAmount"],
        validationMessages: ["<b>金額</b>は 1 円以上にしてください"],
      }),
    );
    const { container } = renderForm(onSubmit);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("<b>金額</b>は 1 円以上にしてください");
    expect(container.querySelector("b")).toBeNull();
  });
});

// ── 送信の前に出す文言（入力補助。M1.2） ──────────────────────────────
//
// 画面は式を評価しないので、「いつその文言が出るか」は決めない。**宣言した文言そのもの**を
// 送信の前に見せるだけである（守りは data-api 側にある。03-spec-layers-and-checker.md §2.2）。

describe("送信の前に出す文言", () => {
  const renderWithGuidance = (guidance: readonly string[]) =>
    render(
      createElement(AddForm, {
        action: "addExpense",
        fields: FIELDS,
        guidance,
        onSubmit: () => Promise.resolve(accepted),
      }),
    );

  it("宣言の文言を、送信の前に出す", () => {
    renderWithGuidance(["金額は 1 円以上にしてください", "割る人を 1 人以上選んでください"]);
    const guidance = screen.getByRole("list", { name: "保存する条件" });

    expect(guidance.textContent).toContain("金額は 1 円以上にしてください");
    expect(guidance.textContent).toContain("割る人を 1 人以上選んでください");
    // まだ送信していない（入力補助である）
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("文言が無ければ出さない（M1.1 のフォームのまま）", () => {
    renderForm(() => Promise.resolve(accepted));
    expect(screen.queryByRole("list", { name: "保存する条件" })).toBeNull();
  });

  it("文言の HTML も、テキストとして出す", () => {
    const { container } = renderWithGuidance(["<b>金額</b>は 1 円以上にしてください"]);
    expect(screen.getByRole("list", { name: "保存する条件" }).textContent).toContain(
      "<b>金額</b>は 1 円以上にしてください",
    );
    expect(container.querySelector("b")).toBeNull();
  });
});

// ── 選択肢（enum）と既定値（default）（M1.3。Issue #154） ──────────────
//
// 画面が決めるのは「選択肢を出すこと」と「キーを送ること」までである。**宣言に無い値を断るのは
// data-api だけである**（画面の選択肢は守りではない。03-spec-layers-and-checker.md §2.2）。

const STATUS_OPTIONS = [
  { value: "todo", label: "未着手" },
  { value: "doing", label: "進行中" },
  { value: "done", label: "完了" },
] as const;

const ENUM_FIELDS: readonly FormField[] = [
  { name: "title", type: "string" },
  { name: "status", type: "enum", options: STATUS_OPTIONS, default: "todo" },
];

const renderEnumForm = (
  onSubmit: (values: Readonly<Record<string, ApiValue>>) => Promise<AddFormResult>,
  fields: readonly FormField[] = ENUM_FIELDS,
) => render(createElement(AddForm, { action: "addTask", fields, onSubmit }));

describe("選択肢（enum）と既定値（default）", () => {
  it("選択肢を単一選択で出し、見せるのは表示名である（受入条件）", () => {
    renderEnumForm(() => Promise.resolve(accepted));
    const select = screen.getByLabelText("status") as HTMLSelectElement;

    expect(select.tagName).toBe("SELECT");
    // 見せるのは表示名である
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "（選んでください）",
      "未着手",
      "進行中",
      "完了",
    ]);
    // 値はキーである（**表示名ではない**。受入条件）
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "",
      "todo",
      "doing",
      "done",
    ]);
  });

  it("送るのはキーである（表示名ではない。受入条件）", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderEnumForm(onSubmit);

    fill("title", "宿の予約");
    fireEvent.change(screen.getByLabelText("status"), { target: { value: "doing" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ title: "宿の予約", status: "doing" });
  });

  it("既定値があれば、最初から選ばれている（未入力を空文字で送らない）", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderEnumForm(onSubmit);

    expect((screen.getByLabelText("status") as HTMLSelectElement).value).toBe("todo");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // 既定値は**保存の時点で**入る（data-api の仕事）が、画面も選んでおく（未入力を空文字で送らない）
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ title: "", status: "todo" });
  });

  it("既定値が無ければ、空文字を送る（断るのは data-api である）", async () => {
    const onSubmit = submitSpy(() => Promise.resolve(accepted));
    renderEnumForm(onSubmit, [
      { name: "title", type: "string" },
      { name: "status", type: "enum", options: STATUS_OPTIONS },
    ]);

    expect((screen.getByLabelText("status") as HTMLSelectElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ title: "", status: "" });
  });
});
