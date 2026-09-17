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
