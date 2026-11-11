// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiQuestionBundle, BudgetView, JobView } from "../shared/api";
import { App } from "./App";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
});

const questionBundle: ApiQuestionBundle = {
  revision: 1,
  questions: [
    {
      id: "q1",
      text: "一覧はどの順に並べますか？",
      choices: [
        { id: "newest", text: "新しい順" },
        { id: "oldest", text: "古い順" },
      ],
      recommended: { choiceId: "newest", reason: "最近のものから見られるから" },
      allowFreeText: true,
    },
  ],
  remaining: { questions: 8, roundTrips: 3 },
  deadlineAt: Date.now() + 25 * 60_000,
};

const budget: BudgetView = {
  spentUsd: 0.5,
  remainingUsd: 3.5,
  perRunLimitUsd: 2,
  dailyLimitUsd: 4,
};

const jobReceived: JobView = {
  id: "job-1",
  request: "割り勘を作りたい",
  state: "received",
  stateLabel: "依頼を受けた",
  stopReason: null,
  stopReasonLabel: null,
  question: null,
  confirmation: null,
  progress: null,
  result: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const jobThinking: JobView = {
  ...jobReceived,
  state: "thinking",
  stateLabel: "考え中",
  progress: { stage: "要件を整理しています", elapsedSeconds: 2, estimatedUsd: 0.05 },
};

const jobQuestions: JobView = {
  ...jobReceived,
  state: "awaiting-answer",
  stateLabel: "質問待ち",
  question: questionBundle,
};

const json = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe("App", () => {
  it("「新しく作る」と「履歴」の2つの入口を出す", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "新しく作る" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "履歴" })).toBeTruthy();
  });

  it("画面の文言に entity・computed・view・action の語を出さない", () => {
    const { container } = render(<App />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
  });

  it("状態が質問待ちに変わると質問の画面へ移り、画面を外すと問い合わせが止まる", async () => {
    document.head.innerHTML = '<meta name="studio-token" content="test-token" />';
    let jobReads = 0;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (input === "/api/budget") return json(budget);
      if (input === "/api/jobs" && method === "POST") return json(jobReceived, 201);
      if (input === "/api/jobs/job-1") {
        jobReads += 1;
        return json(jobReads === 1 ? jobThinking : jobQuestions);
      }
      throw new Error(`知らない要求: ${method} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "新しく作る" }));
    });
    expect(screen.getByLabelText("つくりたいもの")).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("つくりたいもの"), {
        target: { value: "割り勘を作りたい" },
      });
      fireEvent.click(screen.getByRole("button", { name: "依頼を送る" }));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jobs",
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("要件を整理しています")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText(/一覧はどの順に並べますか/)).toBeTruthy();

    const text = (document.body.textContent ?? "").toLowerCase();
    for (const word of ["entity", "computed", "view", "action"]) {
      expect(text).not.toContain(word);
    }
    expect(document.body.textContent ?? "").not.toMatch(/\b[RI]\d+\b/);

    unmount();
    const readsAtUnmount = jobReads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(jobReads).toBe(readsAtUnmount);
  });

  it("画面の CSS に 375px を超える固定幅が無い", () => {
    const css = readFileSync(resolve(process.cwd(), "src/ui/style.css"), "utf8");
    const widths = [...css.matchAll(/(?:^|[;{}\s])(min-width|width)\s*:\s*([0-9.]+)px\b/g)];
    for (const match of widths) {
      expect(Number(match[2] ?? "0")).toBeLessThanOrEqual(375);
    }
  });
});
