// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetView } from "../../shared/api";
import { RequestPage } from "./RequestPage";

afterEach(cleanup);

const budgetOf = (remainingUsd: number): BudgetView => ({
  spentUsd: 4 - remainingUsd,
  remainingUsd,
  perRunLimitUsd: 2,
  dailyLimitUsd: 4,
});

const renderPage = (overrides: Partial<Parameters<typeof RequestPage>[0]> = {}) =>
  render(<RequestPage budget={budgetOf(4)} onStart={() => {}} {...overrides} />);

describe("RequestPage", () => {
  it("空のままでは送れない", () => {
    renderPage();
    const button = screen.getByRole("button", { name: "依頼を送る" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("依頼を書いてください。")).toBeTruthy();
  });

  it("今日の残りが 1 回の上限に足りなければ送れず、理由を出す", () => {
    renderPage({ budget: budgetOf(1.5) });
    const button = screen.getByRole("button", { name: "依頼を送る" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const alerts = screen.getAllByRole("alert").map((node) => node.textContent ?? "");
    expect(alerts.some((text) => text.includes("今日の残り"))).toBe(true);
  });

  it("例のチップで依頼文が入る", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "割り勘" }));
    const field = screen.getByLabelText("つくりたいもの") as HTMLTextAreaElement;
    expect(field.value).toContain("割り勘");
  });

  it("所要・1 回の上限・今日の残りを出す", () => {
    renderPage();
    expect(screen.getByText("所要は数分です。")).toBeTruthy();
    expect(screen.getByText("1 回の上限")).toBeTruthy();
    expect(screen.getByText("$2.00")).toBeTruthy();
    expect(screen.getByText("今日の残り")).toBeTruthy();
    expect(screen.getByText("$4.00")).toBeTruthy();
  });

  it("送ると前後の空白を落とした依頼文を渡す", () => {
    const onStart = vi.fn();
    renderPage({ onStart });
    fireEvent.change(screen.getByLabelText("つくりたいもの"), {
      target: { value: "  買い物メモを作りたい  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "依頼を送る" }));
    expect(onStart).toHaveBeenCalledWith("買い物メモを作りたい");
  });

  it("API の誤りをそのまま出す", () => {
    renderPage({ error: "今日の費用の上限に達しました。" });
    const alerts = screen.getAllByRole("alert").map((node) => node.textContent ?? "");
    expect(alerts.some((text) => text.includes("今日の費用の上限"))).toBe(true);
  });
});
