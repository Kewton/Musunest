import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BIND_HOST, listen } from "./http.js";
import { Jobs } from "./jobs.js";
import { handleApiRequest } from "./routes.js";
import {
  createStudioPublisher,
  type PublishChildInput,
  type PublishChildResult,
  type PublishRecord,
  type StudioPublisher,
} from "./publish.js";
import { FakeRunner } from "./runner-fake.js";
import type { JobView, ResultVerdict } from "./runner.js";

const TOKEN = "test-token";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const NOW = new Date(2026, 10, 11, 12, 34, 56).getTime();

interface Response {
  status: number;
  body: string;
  json: <T>() => T;
  headers: IncomingHttpHeaders;
}

let home: string;
let runner: FakeRunner;
let jobs: Jobs;
let publisher: StudioPublisher;
let childCalls: PublishChildInput[];
let childResult: PublishChildResult;
let server: ReturnType<typeof createServer>;
let port: number;

const answerBody = { kind: "answers", revision: 1, answers: [{ questionId: "q1", choiceId: "newest" }] };

const manifestFor = (level = "L2") => ({
  schema_version: "commandagent.community-delivery-bundle/v1",
  storage_unit: "test",
  source_run: "run-123",
  artifact_level: level,
  expected_verdict: "partial",
  instrument: { binary_sha256: "d".repeat(64), verification_profile: "test" },
  files: [],
});

const summaryLine = (runId = "run-123") =>
  JSON.stringify({
    schema_version: "commandagent.headless-summary/v1",
    run_id: runId,
    verdict: "partial",
    assurance: "full",
    score: 1,
    acceptance_sheet_path: null,
    artifacts_dir: null,
    events_path: null,
    duration_secs: 1,
    provider_cost_usd: 0.1,
    provider_usage_by_role: {},
    stop_class: null,
    directive_round: 1,
    status: "completed",
    gate: null,
    stop_reason: null,
    next_action: null,
    changed_files: [],
    verify_commands: [],
    exit_code: 0,
  });

const jobDirectory = (id: string): string => join(home, "jobs", id);

const writeBundle = (id: string): void => {
  mkdirSync(jobDirectory(id), { recursive: true });
  writeFileSync(join(jobDirectory(id), "bundle-manifest.json"), JSON.stringify(manifestFor()), "utf8");
};

const writeSummary = (id: string): void => {
  writeFileSync(join(jobDirectory(id), "summary.json"), `${summaryLine()}\n`, "utf8");
};

const call = (
  path: string,
  options: { method?: string; body?: string; token?: string | null; origin?: string | null; host?: string } = {},
): Promise<Response> =>
  new Promise((resolveResponse, reject) => {
    const headers: Record<string, string> = { host: options.host ?? `${BIND_HOST}:${port}` };
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

const post = (path: string, body: unknown = {}): Promise<Response> =>
  call(path, { method: "POST", body: JSON.stringify(body) });

const resetRunner = (verdict: ResultVerdict): void => {
  runner = new FakeRunner({ result: { verdict, content: ["結果"] } });
  jobs = new Jobs({ home, runner, now: () => NOW });
};

const startToResult = async (): Promise<string> => {
  const started = await post("/api/jobs", { request: "日付順の一覧を作って" });
  expect(started.status).toBe(201);
  const id = started.json<JobView>().id;
  expect((await post(`/api/jobs/${id}/answers`, answerBody)).status).toBe(200);
  expect((await post(`/api/jobs/${id}/confirm`, { outcome: "build" })).status).toBe(200);
  expect((await call(`/api/jobs/${id}`)).json<JobView>().state).toBe("result");
  return id;
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "musunest-routes-publish-"));
  childCalls = [];
  childResult = { code: 0, stdout: "publish-bundle: OK env=staging 水準 L2", stderr: "" };
  runner = new FakeRunner({ result: { verdict: "full", content: ["すべて満たしました"] } });
  jobs = new Jobs({ home, runner, now: () => NOW });
  publisher = createStudioPublisher({
    home,
    env: { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    now: () => NOW,
    repoRoot: "/repo",
    runChild: async (input) => {
      childCalls.push(input);
      return childResult;
    },
  });

  server = createServer((request, response) => {
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : 0;
    void handleApiRequest(request, response, { jobs, token: TOKEN, port: actualPort, publisher });
  });
  port = await listen(server, 0);
});

afterEach(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(home, { recursive: true, force: true });
});

describe("POST /api/jobs/:id/publish（full）", () => {
  it("staging の studio- のインスタンスへ、--user-app で公開し、2 回目は 409", async () => {
    const id = await startToResult();
    writeBundle(id);

    const response = await post(`/api/jobs/${id}/publish`);
    expect(response.status).toBe(200);
    const record = response.json<PublishRecord>();
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.instanceId).toBe("studio-20261111123456");
    expect(record.level).toBe("L2");
    expect(record.path).toBe("/apps/studio-20261111123456");

    expect(childCalls).toHaveLength(1);
    const args = childCalls[0]?.args ?? [];
    expect(args[args.indexOf("--env") + 1]).toBe("staging");
    expect(args[args.indexOf("--instance") + 1]).toMatch(/^studio-/u);
    expect(args).toContain("--user-app");
    expect(args).not.toContain("--sample");
    expect(args).not.toContain("--approval");

    // 応答にオリジンを入れない（経路の後半だけ）
    expect(response.body).not.toContain("http://");
    expect(response.body).not.toContain("https://");

    const second = await post(`/api/jobs/${id}/publish`);
    expect(second.status).toBe(409);
    expect(childCalls).toHaveLength(1);
  });
});

describe("POST /api/jobs/:id/approve と publish（partial）", () => {
  it("了承なしの公開は 409、SHA の違う了承は 409、正しい了承のあとは --approval を含む", async () => {
    resetRunner("partial");
    const id = await startToResult();
    writeBundle(id);
    writeSummary(id);
    const info = await publisher.manifest(id);

    expect((await post(`/api/jobs/${id}/publish`)).status).toBe(409);

    const wrong = await post(`/api/jobs/${id}/approve`, { manifestSha256: "0".repeat(64) });
    expect(wrong.status).toBe(409);

    const approved = await post(`/api/jobs/${id}/approve`, { manifestSha256: info.sha256 });
    expect(approved.status).toBe(200);
    const record = approved.json<{ manifest_sha256: string; run_id: string }>();
    expect(record.manifest_sha256).toBe(info.sha256);
    expect(record.run_id).toBe("run-123");

    const published = await post(`/api/jobs/${id}/publish`);
    expect(published.status).toBe(200);
    const args = childCalls[0]?.args ?? [];
    expect(args).toContain("--approval");
  });

  it("none は了承も公開も 409", async () => {
    resetRunner("none");
    const id = await startToResult();

    expect((await post(`/api/jobs/${id}/approve`, { manifestSha256: "0".repeat(64) })).status).toBe(409);
    expect((await post(`/api/jobs/${id}/publish`)).status).toBe(409);
  });
});

describe("子の出力の伏せ", () => {
  it("32 桁の 16 進・workers.dev・URL が混じっても、応答と保存は伏せた形になる", async () => {
    const id = await startToResult();
    writeBundle(id);
    childResult = {
      code: 1,
      stdout: `publish-bundle: NG 段 manifest ${"e".repeat(32)} https://x.workers.dev/a`,
      stderr: "",
    };

    const response = await post(`/api/jobs/${id}/publish`);
    expect(response.status).toBe(200);
    const record = response.json<PublishRecord>();
    expect(record.ok).toBe(false);
    if (record.ok) return;
    expect(record.stage).toBe("manifest");
    expect(response.body).not.toContain("e".repeat(32));
    expect(response.body).not.toContain("workers.dev");
    expect(response.body).not.toContain("https://");

    const saved = readFileSync(join(jobDirectory(id), "publish.json"), "utf8");
    expect(saved).not.toContain("e".repeat(32));
    expect(saved).not.toContain("workers.dev");
    expect(saved).not.toContain("https://");
  });
});
