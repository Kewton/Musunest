// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetView, JobView, PublishSuccessRecord } from "../../shared/api";
import { HistoryPage } from "./HistoryPage";

afterEach(cleanup);

const budget: BudgetView = {
  spentUsd: 1.25,
  remainingUsd: 2.75,
  perRunLimitUsd: 2,
  dailyLimitUsd: 4,
};

const jobOf = (overrides: Partial<JobView>): JobView => ({
  id: "job",
  request: "依頼",
  state: "result",
  stateLabel: "結果",
  stopReason: null,
  stopReasonLabel: null,
  question: null,
  confirmation: null,
  progress: null,
  result: null,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const published: PublishSuccessRecord = {
  ok: true,
  instanceId: "studio-20261111123456",
  level: "L2",
  manifestSha256: "a".repeat(64),
  path: "/apps/studio-20261111123456",
};

describe("HistoryPage", () => {
  it("新しい順に並べる", () => {
    const older = jobOf({ id: "old", request: "古い依頼", createdAt: 1_000 });
    const newer = jobOf({ id: "new", request: "新しい依頼", createdAt: 2_000 });
    render(<HistoryPage jobs={[older, newer]} budget={budget} onOpen={() => {}} />);

    const items = screen.getAllByRole("button");
    expect(items[0]?.textContent).toContain("新しい依頼");
    expect(items[1]?.textContent).toContain("古い依頼");
  });

  it("状態・日時・使った額・公開済みのインスタンス ID を出す", () => {
    const job = jobOf({
      request: "割り勘を作りたい",
      stateLabel: "結果",
      spentUsd: 0.42,
      createdAt: new Date("2026-11-11T12:34:00").getTime(),
      publish: published,
    });
    render(<HistoryPage jobs={[job]} budget={budget} onOpen={() => {}} />);

    expect(screen.getByText("結果")).toBeTruthy();
    expect(screen.getByText("割り勘を作りたい")).toBeTruthy();
    expect(screen.getByText("使った額 $0.42")).toBeTruthy();
    expect(screen.getByText("インスタンス ID: studio-20261111123456")).toBeTruthy();
  });

  it("今日の使った額と残りを出す", () => {
    render(<HistoryPage jobs={[]} budget={budget} onOpen={() => {}} />);
    expect(screen.getByText("今日の使った額")).toBeTruthy();
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.getByText("今日の残り")).toBeTruthy();
    expect(screen.getByText("$2.75")).toBeTruthy();
  });

  it("押すとそのジョブを渡す", () => {
    const onOpen = vi.fn();
    const job = jobOf({ id: "job-9", request: "開く依頼", createdAt: 5 });
    render(<HistoryPage jobs={[job]} budget={budget} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /開く依頼/ }));
    expect(onOpen).toHaveBeenCalledWith(job);
  });

  it("画面の文言に宣言の用語と 32 桁の 16 進を出さない", () => {
    const job = jobOf({ request: "割り勘を作りたい", spentUsd: 0.1, publish: published });
    const { container } = render(<HistoryPage jobs={[job]} budget={budget} onOpen={() => {}} />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/u);
  });
});
