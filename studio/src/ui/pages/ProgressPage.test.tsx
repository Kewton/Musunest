// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView } from "../../shared/api";
import { ProgressPage } from "./ProgressPage";

afterEach(cleanup);

const jobOf = (): JobView => ({
  id: "job-1",
  request: "一覧を作りたい",
  state: "building",
  stateLabel: "作成中",
  stopReason: null,
  stopReasonLabel: null,
  question: null,
  confirmation: null,
  progress: { stage: "試験", elapsedSeconds: 42, estimatedUsd: 0.2 },
  result: null,
  createdAt: 1,
  updatedAt: 2,
});

describe("ProgressPage", () => {
  it("段の表示名と経過時間を出す", () => {
    const { container } = render(<ProgressPage job={jobOf()} onCancel={() => {}} />);
    expect(container.querySelector(".progress__stage")?.textContent).toBe("試験");
    expect(screen.getByText("42 秒")).toBeTruthy();
    expect(screen.getByText("作っています。終わるまで数分かかります。")).toBeTruthy();
  });

  it("閉じても履歴から戻れることを伝える", () => {
    render(<ProgressPage job={jobOf()} onCancel={() => {}} />);
    expect(screen.getByText("閉じても、履歴から続きを見られます。")).toBeTruthy();
  });

  it("取り消しは、確かめのあとにだけ要求を送る", () => {
    const onCancel = vi.fn();
    render(<ProgressPage job={jobOf()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "取り消し" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("取り消しますか？")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("「やめる」を押すと、確かめを閉じて要求を送らない", () => {
    const onCancel = vi.fn();
    render(<ProgressPage job={jobOf()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "取り消し" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByText("取り消しますか？")).toBeNull();
  });

  it("画面の文言に宣言の用語と 32 桁の 16 進を出さない", () => {
    const { container } = render(<ProgressPage job={jobOf()} onCancel={() => {}} />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/u);
  });
});
