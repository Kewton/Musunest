import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PUBLISH_CHILD_ENV_KEYS,
  StudioPublisher,
  buildPublishArgs,
  createStudioPublisher,
  publishChildEnv,
  type PublishChildInput,
  type PublishChildRunner,
} from "./publish.js";
import { ApiError } from "./jobs.js";
import type { PublishJob } from "./publish.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const NOW = new Date(2026, 10, 11, 12, 34, 56).getTime();

const manifestFor = (level: string) => ({
  schema_version: "commandagent.community-delivery-bundle/v1",
  storage_unit: "test",
  source_run: "run-123",
  artifact_level: level,
  expected_verdict: "partial",
  instrument: { binary_sha256: "d".repeat(64), verification_profile: "test" },
  files: [],
});

const summaryLine = (runId: string) =>
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

let home: string;

const jobDirectory = (id: string): string => join(home, "jobs", id);

const writeBundle = (id: string, level = "L2"): void => {
  const directory = jobDirectory(id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "bundle-manifest.json"), JSON.stringify(manifestFor(level)), "utf8");
};

const writeSummary = (id: string, runId = "run-123"): void => {
  writeFileSync(join(jobDirectory(id), "summary.json"), `${summaryLine(runId)}\n`, "utf8");
};

interface FakeChild {
  readonly calls: PublishChildInput[];
  readonly runner: PublishChildRunner;
}

const fakeChild = (result: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" }): FakeChild => {
  const calls: PublishChildInput[] = [];
  return {
    calls,
    runner: async (input) => {
      calls.push(input);
      return result;
    },
  };
};

const makePublisher = (
  child: FakeChild,
  env: Readonly<Record<string, string | undefined>> = {
    CLOUDFLARE_API_TOKEN: "token",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  },
): StudioPublisher =>
  createStudioPublisher({ home, env, now: () => NOW, runChild: child.runner, repoRoot: "/repo" });

const fullJob = (id = "job-1"): PublishJob => ({ id, state: "result", verdict: "full" });
const partialJob = (id = "job-1"): PublishJob => ({ id, state: "result", verdict: "partial" });

const expectApiError = (run: () => Promise<unknown>, status: number, code: string): Promise<void> =>
  run().then(
    () => {
      throw new Error("例外にならなかった");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(status);
      expect((error as ApiError).code).toBe(code);
    },
  );

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "musunest-publish-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("公開の引数", () => {
  it("full は --env staging・studio- のインスタンス・--user-app を含み、--sample・--approval を含まない", () => {
    const args = buildPublishArgs({
      instanceId: "studio-20261111123456",
      bundleDir: "/bundle",
      summaryFile: "/summary.json",
    });
    expect(args).toContain("--env");
    expect(args[args.indexOf("--env") + 1]).toBe("staging");
    expect(args[args.indexOf("--instance") + 1]).toMatch(/^studio-/u);
    expect(args).toContain("--user-app");
    expect(args).not.toContain("--sample");
    expect(args).not.toContain("--approval");
  });

  it("partial は了承のファイルを --approval で渡す", () => {
    const args = buildPublishArgs({
      instanceId: "studio-20261111123456",
      bundleDir: "/bundle",
      summaryFile: "/summary.json",
      approvalFile: "/approval.json",
    });
    expect(args[args.indexOf("--approval") + 1]).toBe("/approval.json");
  });
});

describe("子に渡す環境", () => {
  it("Cloudflare の変数だけを写し、LLM の鍵を渡さない", () => {
    const env = publishChildEnv({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_ACCOUNT_ID_PROD: "prod",
      OPENAI_API_KEY: "sk-FAKE",
      JEV_API_KEY: "jev-FAKE",
      OLLAMA_API_KEY: "ollama-FAKE",
      OPENROUTER_API_KEY: "or-FAKE",
      PATH: "/usr/bin",
    });
    expect(env["CLOUDFLARE_API_TOKEN"]).toBe("token");
    expect(env["CLOUDFLARE_ACCOUNT_ID"]).toBe(ACCOUNT_ID);
    expect(env["PATH"]).toBe("/usr/bin");
    for (const key of Object.keys(env)) expect(PUBLISH_CHILD_ENV_KEYS).toContain(key);
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["JEV_API_KEY"]).toBeUndefined();
    expect(env["OLLAMA_API_KEY"]).toBeUndefined();
    expect(env["OPENROUTER_API_KEY"]).toBeUndefined();
  });
});

describe("公開", () => {
  it("full は了承なしで公開し、インスタンス・水準・manifest SHA を保存する", async () => {
    writeBundle("job-1");
    const child = fakeChild({ code: 0, stdout: "publish-bundle: OK env=staging", stderr: "" });
    const publisher = makePublisher(child);

    const info = await publisher.manifest("job-1");
    const record = await publisher.publish(fullJob());

    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.instanceId).toBe("studio-20261111123456");
    expect(record.level).toBe("L2");
    expect(record.manifestSha256).toBe(info.sha256);
    expect(record.path).toBe("/apps/studio-20261111123456");

    expect(child.calls).toHaveLength(1);
    const args = child.calls[0]?.args ?? [];
    expect(args[args.indexOf("--env") + 1]).toBe("staging");
    expect(args[args.indexOf("--instance") + 1]).toBe("studio-20261111123456");
    expect(args).toContain("--user-app");
    expect(args).not.toContain("--sample");
    expect(args).not.toContain("--approval");

    const saved = JSON.parse(readFileSync(join(jobDirectory("job-1"), "publish.json"), "utf8")) as Record<string, unknown>;
    expect(saved["instanceId"]).toBe("studio-20261111123456");
    expect(saved["level"]).toBe("L2");
    expect(saved["manifestSha256"]).toBe(info.sha256);
  });

  it("同じジョブの 2 回目の公開は 409", async () => {
    writeBundle("job-1");
    const child = fakeChild();
    const publisher = makePublisher(child);

    await publisher.publish(fullJob());
    await expectApiError(() => publisher.publish(fullJob()), 409, "already-published");
    expect(child.calls).toHaveLength(1);
  });

  it("partial は了承なしでは 409", async () => {
    writeBundle("job-1");
    const child = fakeChild();
    const publisher = makePublisher(child);

    await expectApiError(() => publisher.publish(partialJob()), 409, "approval-required");
    expect(child.calls).toHaveLength(0);
  });

  it("画面の SHA が違う了承は 409、正しい了承のあとの公開は --approval を含む", async () => {
    writeBundle("job-1");
    writeSummary("job-1", "run-123");
    const child = fakeChild();
    const publisher = makePublisher(child);
    const info = await publisher.manifest("job-1");

    await expectApiError(() => publisher.approve(partialJob(), "0".repeat(64)), 409, "approval-sha-mismatch");
    expect(child.calls).toHaveLength(0);

    const record = await publisher.approve(partialJob(), info.sha256);
    expect(record.manifest_sha256).toBe(info.sha256);
    expect(record.run_id).toBe("run-123");

    const saved = JSON.parse(readFileSync(join(jobDirectory("job-1"), "approval.json"), "utf8")) as Record<string, unknown>;
    expect(saved["manifest_sha256"]).toBe(info.sha256);
    expect(saved["run_id"]).toBe("run-123");

    const published = await publisher.publish(partialJob());
    expect(published.ok).toBe(true);
    const args = child.calls[0]?.args ?? [];
    expect(args).toContain("--approval");
    expect(args[args.indexOf("--approval") + 1]).toBe(join(jobDirectory("job-1"), "approval.json"));
  });

  it("none は了承も公開も 409", async () => {
    const publisher = makePublisher(fakeChild());
    const noneJob: PublishJob = { id: "job-1", state: "result", verdict: "none" };
    await expectApiError(() => publisher.approve(noneJob, "0".repeat(64)), 409, "not-partial");
    await expectApiError(() => publisher.publish(noneJob), 409, "nothing-to-publish");
  });

  it("production の Account ID が渡ると、子を起こす前に断る", async () => {
    writeBundle("job-1");
    const child = fakeChild();
    const publisher = makePublisher(child, {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_ACCOUNT_ID_PROD: ACCOUNT_ID.toUpperCase(),
    });

    await expectApiError(() => publisher.publish(fullJob()), 409, "production-account");
    expect(child.calls).toHaveLength(0);
  });

  it("子の出力の 32 桁の 16 進・workers.dev・URL は伏せて保存する", async () => {
    writeBundle("job-1");
    const secretText = `publish-bundle: NG 段 manifest ${"e".repeat(32)} https://x.workers.dev/a`;
    const child = fakeChild({ code: 1, stdout: secretText, stderr: "" });
    const publisher = makePublisher(child);

    const record = await publisher.publish(fullJob());
    expect(record.ok).toBe(false);
    if (record.ok) return;
    expect(record.stage).toBe("manifest");
    expect(record.message).not.toContain("e".repeat(32));
    expect(record.message).not.toContain("workers.dev");
    expect(record.message).not.toContain("https://");

    const saved = readFileSync(join(jobDirectory("job-1"), "publish.json"), "utf8");
    expect(saved).not.toContain("e".repeat(32));
    expect(saved).not.toContain("workers.dev");
    expect(saved).not.toContain("https://");
  });
});
