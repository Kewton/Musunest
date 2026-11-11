// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetView, JobView } from "../shared/api";
import { ApiRequestError, TOKEN_HEADER, createApiClient, messageForApiError } from "./api-client";

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
});

const job: JobView = {
  id: "job-1",
  request: "割り勘を作りたい",
  state: "thinking",
  stateLabel: "考え中",
  stopReason: null,
  stopReasonLabel: null,
  question: null,
  confirmation: null,
  progress: { stage: "要件を整理しています", elapsedSeconds: 3, estimatedUsd: 0.05 },
  result: null,
  createdAt: 1,
  updatedAt: 2,
};

const budget: BudgetView = {
  spentUsd: 0.5,
  remainingUsd: 3.5,
  perRunLimitUsd: 2,
  dailyLimitUsd: 4,
};

const json = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

const recordingFetch = (calls: RecordedCall[]) =>
  vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/api/budget")) return json(budget);
    if (url.endsWith("/api/jobs") && (init.method ?? "GET") === "GET") return json({ jobs: [job] });
    return json(job, (init.method ?? "GET") === "POST" ? 201 : 200);
  });

const headerOf = (init: RequestInit, name: string): string | undefined => {
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name];
};

describe("createApiClient", () => {
  it("すべての API の要求に合言葉のヘッダを付ける", async () => {
    const calls: RecordedCall[] = [];
    const client = createApiClient({ token: () => "secret-token", fetchImpl: recordingFetch(calls) });

    await client.getBudget();
    await client.listJobs();
    await client.startJob("割り勘を作りたい");
    await client.getJob("job-1");
    await client.answerQuestions("job-1", { kind: "all-recommended", revision: 2 });
    await client.confirmJob("job-1", "build");
    await client.cancelJob("job-1");

    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(headerOf(call.init, TOKEN_HEADER)).toBe("secret-token");
      expect(headerOf(call.init, "accept")).toBe("application/json");
    }
  });

  it("画面の meta の合言葉を読む", async () => {
    document.head.innerHTML = '<meta name="studio-token" content="from-meta" />';
    const calls: RecordedCall[] = [];
    const client = createApiClient({ fetchImpl: recordingFetch(calls) });

    await client.getBudget();

    expect(headerOf(calls[0]?.init ?? {}, TOKEN_HEADER)).toBe("from-meta");
  });

  it("口ごとの道と本文を送る", async () => {
    const calls: RecordedCall[] = [];
    const client = createApiClient({ token: () => "t", fetchImpl: recordingFetch(calls) });

    await client.startJob("依頼です");
    await client.answerQuestions("job 1", { kind: "all-recommended", revision: 3 });
    await client.confirmJob("job 1", "build");

    expect(calls[0]?.url).toBe("/api/jobs");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ request: "依頼です" }));
    expect(calls[1]?.url).toBe("/api/jobs/job%201/answers");
    expect(calls[1]?.init.body).toBe(
      JSON.stringify({ kind: "all-recommended", revision: 3 }),
    );
    expect(calls[2]?.url).toBe("/api/jobs/job%201/confirm");
    expect(calls[2]?.init.body).toBe(JSON.stringify({ outcome: "build" }));
  });

  it("400・409 の応答をコードつきの誤りにし、直し方を返す", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "budget", message: "今日の費用の上限に達している" }, 409));
    const client = createApiClient({ token: () => "t", fetchImpl });

    const error = await client.startJob("依頼です").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(409);
    expect((error as ApiRequestError).code).toBe("budget");
    expect(messageForApiError(error)).toContain("今日の費用の上限");
  });

  it("知らないコードはサーバの文をそのまま返す", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "teapot", message: "知らない失敗" }, 400));
    const client = createApiClient({ token: () => "t", fetchImpl });

    const error = await client.getBudget().catch((caught: unknown) => caught);

    expect(messageForApiError(error)).toBe("知らない失敗");
  });

  it("同時に 1 本・古い質問への答えの直し方を返す", () => {
    expect(messageForApiError(new ApiRequestError(409, "busy", "busy"))).toContain("別の依頼");
    expect(messageForApiError(new ApiRequestError(400, "stale-revision", "stale"))).toContain(
      "質問が新しくなっています",
    );
  });

  it("了承と公開の要求にも合言葉を付け、画面の SHA をそのまま送る", async () => {
    const calls: RecordedCall[] = [];
    const client = createApiClient({ token: () => "t", fetchImpl: recordingFetch(calls) });
    const sha = "a".repeat(64);

    await client.approveJob("job 1", sha);
    await client.publishJob("job 1");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(headerOf(call.init, TOKEN_HEADER)).toBe("t");
      expect(headerOf(call.init, "accept")).toBe("application/json");
    }
    expect(calls[0]?.url).toBe("/api/jobs/job%201/approve");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ manifestSha256: sha }));
    expect(calls[1]?.url).toBe("/api/jobs/job%201/publish");
    expect(calls[1]?.init.method).toBe("POST");
  });

  it("了承・公開の誤りに直し方を返す", () => {
    expect(messageForApiError(new ApiRequestError(409, "approval-required", "no"))).toContain(
      "了承してから公開",
    );
    expect(messageForApiError(new ApiRequestError(409, "already-published", "done"))).toContain(
      "公開済み",
    );
    expect(messageForApiError(new ApiRequestError(409, "approval-sha-mismatch", "sha"))).toContain(
      "画面を読み込み直",
    );
  });
});
