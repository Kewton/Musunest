import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BIND_HOST, listen } from "./http.js";
import { Jobs } from "./jobs.js";
import { handleApiRequest } from "./routes.js";
import { FakeRunner } from "./runner-fake.js";
import type { JobView } from "./runner.js";

const TOKEN = "test-token";

interface Response {
  status: number;
  body: string;
  json: <T>() => T;
  headers: IncomingHttpHeaders;
}

let home: string;
let now: number;
let runner: FakeRunner;
let jobs: Jobs;
let server: ReturnType<typeof createServer>;
let port: number;

const call = (
  path: string,
  options: { method?: string; body?: string; token?: string | null; origin?: string | null; host?: string } = {},
): Promise<Response> =>
  new Promise((resolveResponse, reject) => {
    const headers: Record<string, string> = {
      host: options.host ?? `${BIND_HOST}:${port}`,
    };
    const token = options.token === undefined ? TOKEN : options.token;
    if (token !== null) headers["x-studio-token"] = token;
    if (options.method === "POST") {
      const origin = options.origin === undefined ? `http://${BIND_HOST}:${port}` : options.origin;
      if (origin !== null) headers.origin = origin;
    }
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const request = httpRequest(
      { host: BIND_HOST, port, path, method: options.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolveResponse({
            status: response.statusCode ?? 0,
            body,
            json: <T,>() => JSON.parse(body) as T,
            headers: response.headers,
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });

const post = (path: string, body: unknown): Promise<Response> =>
  call(path, { method: "POST", body: JSON.stringify(body) });

const answerBody = { kind: "answers", revision: 1, answers: [{ questionId: "q1", choiceId: "newest" }] };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "musunest-routes-"));
  now = new Date(2026, 10, 11, 12, 0, 0).getTime();
  runner = new FakeRunner({ deferFinish: true });
  jobs = new Jobs({ home, runner, now: () => now });
  server = createServer((request, response) => {
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : 0;
    void handleApiRequest(request, response, { jobs, token: TOKEN, port: actualPort }).then((handled) => {
      if (!handled) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "not_found" }));
      }
    });
  });
  port = await listen(server, 0);
});

afterEach(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/jobs/:id の状態の移り", () => {
  it("質問 → 答え → 確認 → 作成中 → 結果 を順に読める", async () => {
    const started = await post("/api/jobs", { request: "日付順の一覧を作って" });
    expect(started.status).toBe(201);
    const job = started.json<JobView>();
    expect(job.state).toBe("awaiting-answer");
    expect((await call(`/api/jobs/${job.id}`)).json<JobView>().state).toBe("awaiting-answer");

    const answered = await post(`/api/jobs/${job.id}/answers`, answerBody);
    expect(answered.status).toBe(200);
    expect((await call(`/api/jobs/${job.id}`)).json<JobView>().state).toBe("awaiting-confirm");

    const building = await post(`/api/jobs/${job.id}/confirm`, { outcome: "build" });
    expect(building.status).toBe(200);
    expect((await call(`/api/jobs/${job.id}`)).json<JobView>().state).toBe("building");

    runner.finish(job.id);
    const result = await call(`/api/jobs/${job.id}`);
    expect(result.status).toBe(200);
    expect(result.json<JobView>().state).toBe("result");
    expect(result.json<JobView>().result?.verdict).toBe("full");
  });

  it("差し戻しを返すと状態が「差し戻し」になる", async () => {
    runner = new FakeRunner({ outcome: "sent-back" });
    jobs = new Jobs({ home, runner, now: () => now });

    const started = await post("/api/jobs", { request: "日付順の一覧を作って" });
    const job = started.json<JobView>();
    await post(`/api/jobs/${job.id}/answers`, answerBody);
    await post(`/api/jobs/${job.id}/confirm`, { outcome: "build" });

    const view = await call(`/api/jobs/${job.id}`);
    expect(view.json<JobView>().state).toBe("sent-back");
    expect(view.json<JobView>().stateLabel).toBe("差し戻し");
  });
});

describe("GET /api/jobs の履歴と GET /api/budget", () => {
  it("履歴と費用の状態を返す", async () => {
    const started = await post("/api/jobs", { request: "日付順の一覧を作って" });
    const job = started.json<JobView>();

    const history = await call("/api/jobs");
    expect(history.status).toBe(200);
    expect(history.json<{ jobs: JobView[] }>().jobs.map((entry) => entry.id)).toEqual([job.id]);

    const budget = await call("/api/budget");
    expect(budget.status).toBe(200);
    expect(budget.json()).toEqual({ spentUsd: 2, remainingUsd: 2, perRunLimitUsd: 2, dailyLimitUsd: 4 });
  });
});

describe("答えの検査は 400 で止め、走らせる役に渡さない", () => {
  it("4 種の誤りをそれぞれ 400 にする", async () => {
    const started = await post("/api/jobs", { request: "日付順の一覧を作って" });
    const id = started.json<JobView>().id;

    const invalid = [
      { ...answerBody, revision: 99 },
      { ...answerBody, answers: [{ questionId: "missing", choiceId: "newest" }] },
      { ...answerBody, answers: [{ questionId: "q1", choiceId: "newest", freeText: "両方" }] },
      { ...answerBody, answers: [{ questionId: "q1" }] },
      { ...answerBody, answers: [{ questionId: "q1", freeText: "あ".repeat(501) }] },
    ];
    for (const body of invalid) {
      const response = await post(`/api/jobs/${id}/answers`, body);
      expect(response.status).toBe(400);
    }
    expect(runner.answers).toHaveLength(0);

    const accepted = await post(`/api/jobs/${id}/answers`, answerBody);
    expect(accepted.status).toBe(200);
    expect(runner.answers).toHaveLength(1);
  });
});

describe("答えの期限", () => {
  it("29 分では止まらず、30 分を過ぎた問い合わせで止める", async () => {
    const started = await post("/api/jobs", { request: "日付順の一覧を作って" });
    const id = started.json<JobView>().id;

    now += 29 * 60 * 1000;
    const before = await call(`/api/jobs/${id}`);
    expect(before.json<JobView>().state).toBe("awaiting-answer");
    expect(runner.cancels).toHaveLength(0);

    now += 60 * 1000;
    const after = await call(`/api/jobs/${id}`);
    expect(after.json<JobView>().state).toBe("stopped");
    expect(after.json<JobView>().stopReasonLabel).toBe("答えの待ちの上限");
    expect(runner.cancels).toEqual([{ jobId: id, reason: "answer-timeout" }]);
  });
});

describe("取り消し", () => {
  it("走らせる役の取り消しが呼ばれ、状態が「止めた」になる", async () => {
    const started = await post("/api/jobs", { request: "日付順の一覧を作って" });
    const id = started.json<JobView>().id;

    const cancelled = await post(`/api/jobs/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.json<JobView>().state).toBe("stopped");
    expect(cancelled.json<JobView>().stateLabel).toBe("止めた");
    expect(runner.cancels).toEqual([{ jobId: id, reason: "cancel" }]);
  });
});

describe("守りと入力の誤り", () => {
  it("合言葉・Host・Origin を確かめる", async () => {
    expect((await call("/api/jobs", { token: null })).status).toBe(403);
    expect((await call("/api/jobs", { host: "evil.example" })).status).toBe(421);
    expect((await post("/api/jobs", { request: "x" })).status).toBe(201);
    expect((await call("/api/jobs", { method: "POST", body: JSON.stringify({ request: "x" }), origin: null })).status).toBe(403);
  });

  it("JSON でない本文・知らないジョブ・知らない口を断る", async () => {
    expect((await call("/api/jobs", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await call("/api/jobs/missing")).status).toBe(404);
    expect((await call("/api/jobs/a/b/c")).status).toBe(404);
  });
});
