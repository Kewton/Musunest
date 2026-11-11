// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiQuestionBundle, BudgetView, JobView, PublishSuccessRecord } from "../shared/api";
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

// ── Issue #870：結果・了承と公開・履歴（偽の fetch。実際の時計で待つ）─────────

const SHA = "0123456789abcdef".repeat(4);

const resultBase = {
  request: "割り勘を作りたい",
  stateLabel: "結果",
  stopReason: null,
  stopReasonLabel: null,
  question: null,
  confirmation: null,
  progress: null,
  createdAt: 1,
  updatedAt: 2,
} as const;

const fullResultJob = {
  ...resultBase,
  id: "job-full",
  state: "result",
  result: { verdict: "full" as const, verdictLabel: "すべて満たしました", content: ["依頼どおりに作りました。"] },
};

const partialResultJob = {
  ...resultBase,
  id: "job-partial",
  state: "result",
  manifestSha256: SHA,
  partial: {
    built: ["一覧を新しい順に並べる"],
    missing: [{ what: "写真の添付", alternative: "題名に写真の名前を書く" }],
    decided: ["画面の名前は「一覧」にする"],
  },
  result: {
    verdict: "partial" as const,
    verdictLabel: "一部だけ満たしました",
    content: ["一覧を新しい順に並べる"],
  },
};

const noneResultJob = {
  ...resultBase,
  id: "job-none",
  state: "result",
  result: { verdict: "none" as const, verdictLabel: "作れませんでした", content: ["写真を扱うものは作れません。"] },
};

const publishedRecord: PublishSuccessRecord = {
  ok: true,
  instanceId: "studio-20261111123456",
  level: "L2",
  manifestSha256: SHA,
  path: "/apps/studio-20261111123456",
};

interface FakeResultOptions {
  readonly jobs: readonly unknown[];
  readonly publish: () => Response;
}

function installResultFetch(options: FakeResultOptions) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    const method = init.method ?? "GET";
    if (input === "/api/budget") return json(budget);
    if (input === "/api/jobs" && method === "GET") return json({ jobs: options.jobs });
    if (input.endsWith("/publish") && method === "POST") return options.publish();
    if (input.endsWith("/approve") && method === "POST") {
      return json({ manifest_sha256: SHA, run_id: "run-1" });
    }
    throw new Error(`知らない要求: ${method} ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function openResultFromHistory(requestText: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "履歴" }));
  await waitFor(() => {
    expect(screen.getByText(requestText)).toBeTruthy();
  });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(requestText) }));
}

describe("App（結果・了承と公開・履歴）", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("full：公開の要求を 1 回だけ送り、インスタンス ID と「開いて試す」を出す", async () => {
    document.head.innerHTML =
      '<meta name="studio-token" content="t" /><meta name="studio-staging-origin" content="https://staging.example" />';
    const { calls } = installResultFetch({ jobs: [fullResultJob], publish: () => json(publishedRecord) });

    render(<App />);
    await openResultFromHistory("割り勘を作りたい");

    const publishButton = screen.getByRole("button", { name: "公開する" });
    fireEvent.click(publishButton);
    fireEvent.click(publishButton);
    fireEvent.click(publishButton);

    await waitFor(() => {
      expect(screen.getByText("公開しました")).toBeTruthy();
    });

    expect(calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(1);
    expect(screen.getByText("studio-20261111123456")).toBeTruthy();
    const link = screen.getByRole("link", { name: "開いて試す" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://staging.example/apps/studio-20261111123456");
  });

  it("オリジンが無ければ「開いて試す」を出さない", async () => {
    document.head.innerHTML = '<meta name="studio-token" content="t" />';
    installResultFetch({ jobs: [fullResultJob], publish: () => json(publishedRecord) });

    render(<App />);
    await openResultFromHistory("割り勘を作りたい");

    fireEvent.click(screen.getByRole("button", { name: "公開する" }));
    await waitFor(() => {
      expect(screen.getByText("公開しました")).toBeTruthy();
    });

    expect(screen.getByText("studio-20261111123456")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "開いて試す" })).toBeNull();
  });

  it("partial：了承の前は公開のボタンが無く、了承の要求に画面の SHA をそのまま入れる", async () => {
    document.head.innerHTML = '<meta name="studio-token" content="t" />';
    const { calls } = installResultFetch({ jobs: [partialResultJob], publish: () => json(publishedRecord) });

    render(<App />);
    await openResultFromHistory("割り勘を作りたい");

    expect(screen.queryByRole("button", { name: "公開する" })).toBeNull();
    expect(screen.getByText(`いまの納品物の SHA（短い形）: ${SHA.slice(0, 12)}`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "了承して公開する" }));

    await waitFor(() => {
      expect(screen.getByText("公開しました")).toBeTruthy();
    });

    const approve = calls.find((call) => call.url.endsWith("/approve"));
    expect(approve).toBeTruthy();
    expect(JSON.parse(String(approve?.init.body))).toEqual({ manifestSha256: SHA });
    expect(calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(1);
  });

  it("none：理由と「依頼を直してやり直す」を出し、押すと元の依頼文が入った依頼の画面になる", async () => {
    document.head.innerHTML = '<meta name="studio-token" content="t" />';
    installResultFetch({ jobs: [noneResultJob], publish: () => json(publishedRecord) });

    render(<App />);
    await openResultFromHistory("割り勘を作りたい");

    expect(screen.getByText("作れませんでした")).toBeTruthy();
    expect(screen.getByText("写真を扱うものは作れません。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "依頼を直してやり直す" }));

    const field = (await screen.findByLabelText("つくりたいもの")) as HTMLTextAreaElement;
    expect(field.value).toBe("割り勘を作りたい");
  });
});

// ── Issue #886：要件を固めきれなかった走りと、やり直しの依頼文 ─────────────

const failedJob: JobView = {
  id: "job-1",
  request: "割り勘を作りたい",
  state: "failed",
  stateLabel: "失敗",
  stopReason: "factory-failure",
  stopReasonLabel: "工場の失敗",
  question: null,
  confirmation: null,
  progress: null,
  result: null,
  createdAt: 1,
  updatedAt: 2,
};

const cannotConfirmJob: JobView = {
  ...failedJob,
  state: "stopped",
  stateLabel: "止めた",
  stopReason: "cannot-confirm",
  stopReasonLabel: "要件を固めきれませんでした",
  stopReasonCategory: "質問の回数の中で決めきれないことが残りました",
};

const receivedJob: JobView = {
  ...failedJob,
  state: "received",
  stateLabel: "依頼を受けた",
  stopReason: null,
  stopReasonLabel: null,
};

const submitNewRequest = async (): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "新しく作る" }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText("つくりたいもの"), { target: { value: "割り勘を作りたい" } });
    fireEvent.click(screen.getByRole("button", { name: "依頼を送る" }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
};

describe("App（Issue #886 やり直し）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
  });

  const installFlowFetch = (jobAfterPoll: JobView) => {
    const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (input === "/api/budget") return json(budget);
      if (input === "/api/jobs" && method === "POST") return json(receivedJob, 201);
      if (input === "/api/jobs/job-1") return json(jobAfterPoll);
      throw new Error(`知らない要求: ${method} ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("新しく作る → 送る → 問い合わせ中に failed → やり直しで元の依頼文が入る", async () => {
    document.head.innerHTML = '<meta name="studio-token" content="t" />';
    installFlowFetch(failedJob);

    render(<App />);
    await submitNewRequest();
    expect(screen.getByText("工場の失敗")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "依頼を直してやり直す" }));
    });

    const field = screen.getByLabelText("つくりたいもの") as HTMLTextAreaElement;
    expect(field.value).toBe("割り勘を作りたい");
  });

  it("要件を固めきれなかった走りでも、やり直しで元の依頼文が入る", async () => {
    document.head.innerHTML = '<meta name="studio-token" content="t" />';
    installFlowFetch(cannotConfirmJob);

    render(<App />);
    await submitNewRequest();
    expect(screen.getByText("要件を固めきれませんでした")).toBeTruthy();
    expect(screen.getByText(/質問の回数の中で決めきれないことが残りました/)).toBeTruthy();
    expect(screen.queryByText("工場の失敗")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "依頼を直してやり直す" }));
    });

    const field = screen.getByLabelText("つくりたいもの") as HTMLTextAreaElement;
    expect(field.value).toBe("割り勘を作りたい");
  });

  it("履歴から開いた failed のジョブでも、やり直しで元の依頼文が入る", async () => {
    document.head.innerHTML = '<meta name="studio-token" content="t" />';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        if (input === "/api/budget") return json(budget);
        if (input === "/api/jobs" && method === "GET") return json({ jobs: [failedJob] });
        throw new Error(`知らない要求: ${method} ${input}`);
      }),
    );

    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "履歴" }));
    });
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /割り勘を作りたい/ }));
    });

    expect(screen.getByText("工場の失敗")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "依頼を直してやり直す" }));
    });

    const field = screen.getByLabelText("つくりたいもの") as HTMLTextAreaElement;
    expect(field.value).toBe("割り勘を作りたい");
  });
});
