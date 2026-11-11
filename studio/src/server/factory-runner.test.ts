import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FACTORY_CHILD_ENV_KEYS,
  createFactoryRunner,
  factoryChildEnv,
  type FactoryChildHandle,
  type FactoryChildStartMessage,
} from "./factory-runner.js";
import { Jobs } from "./jobs.js";
import { Ledger } from "./ledger.js";
import type { RunnerEvent } from "./runner.js";

interface FakeChild {
  readonly handle: FactoryChildHandle;
  readonly sent: unknown[];
  readonly killed: () => boolean;
  emitMessage(message: unknown): void;
  emitExit(code?: number | null): void;
}

const makeFakeChild = (): FakeChild => {
  const messageListeners: ((message: unknown) => void)[] = [];
  const exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const sent: unknown[] = [];
  let killed = false;

  const handle = {
    send: (message: unknown): boolean => {
      sent.push(message);
      return true;
    },
    kill: (): boolean => {
      killed = true;
      return true;
    },
    on: (event: string, listener: (...args: never[]) => void): unknown => {
      if (event === "message") messageListeners.push(listener as (message: unknown) => void);
      else if (event === "exit") exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      else if (event === "error") errorListeners.push(listener as (error: Error) => void);
      return handle;
    },
  } as unknown as FactoryChildHandle;

  return {
    handle,
    sent,
    killed: () => killed,
    emitMessage: (message) => {
      for (const listener of messageListeners) listener(message);
    },
    emitExit: (code = 0) => {
      for (const listener of exitListeners) listener(code, null);
    },
  };
};

describe("子に渡す環境", () => {
  it("LLM の鍵と最小の変数だけを渡し、Cloudflare の変数を渡さない", () => {
    const env = factoryChildEnv({
      OPENAI_API_KEY: "sk-FAKE",
      JEV_API_KEY: "jev-FAKE",
      PATH: "/usr/bin",
      HOME: "/home/studio",
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "cf-account",
      CF_ACCOUNT_ID: "cf-account-2",
    });

    expect(env["OPENAI_API_KEY"]).toBe("sk-FAKE");
    expect(env["JEV_API_KEY"]).toBe("jev-FAKE");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/studio");
    for (const key of Object.keys(env)) {
      expect(FACTORY_CHILD_ENV_KEYS).toContain(key);
      expect(key.toLowerCase()).not.toContain("cloudflare");
      expect(key.toLowerCase()).not.toContain("cf_");
    }
    expect(env["CLOUDFLARE_API_TOKEN"]).toBeUndefined();
    expect(env["CLOUDFLARE_ACCOUNT_ID"]).toBeUndefined();
  });
});

describe("工場の走らせる役", () => {
  it("子を起こして依頼を送り、質問・確認・進みをジョブの通知に写す", () => {
    const fake = makeFakeChild();
    const spawned: FactoryChildStartMessage[] = [];
    const runner = createFactoryRunner({
      home: "/virtual/home",
      env: { OPENAI_API_KEY: "sk-FAKE" },
      spawn: (message) => {
        spawned.push(message);
        return fake.handle;
      },
    });
    const events: RunnerEvent[] = [];

    runner.start({ jobId: "job-1", request: "一覧を作って", notify: (event) => events.push(event) });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({
      type: "start",
      request: { jobId: "job-1", request: "一覧を作って", budgetUsd: 2, outDir: join("/virtual/home", "jobs", "job-1") },
    });
    expect(fake.sent[0]).toEqual(spawned[0]);

    const progress = { stage: "試験", estimatedUsd: 0.3 };
    fake.emitMessage({ type: "event", event: { kind: "progress", progress } });
    const question = { revision: 1, questions: [], remaining: { questions: 0, roundTrips: 0 } };
    fake.emitMessage({ type: "event", event: { kind: "question", question } });
    const confirmation = {
      requirements: [],
      diff: { added: [], changed: [], removed: [] },
      limitations: [],
      decided: [],
    };
    fake.emitMessage({ type: "event", event: { kind: "confirmation", confirmation } });

    expect(events).toEqual([
      { kind: "progress", progress },
      { kind: "question", question },
      { kind: "confirmation", confirmation },
    ]);
  });

  it("子の結果をジョブの通知に写す", () => {
    const fake = makeFakeChild();
    const runner = createFactoryRunner({
      home: "/virtual/home",
      env: {},
      spawn: () => fake.handle,
    });
    const events: RunnerEvent[] = [];
    runner.start({ jobId: "job-1", request: "一覧を作って", notify: (event) => events.push(event) });

    fake.emitMessage({
      type: "result",
      outcome: { kind: "finished", verdict: "full", spentUsd: 0.9, outDir: "/virtual/home/jobs/job-1" },
    });

    expect(events).toEqual([
      {
        kind: "finished",
        result: { verdict: "full", content: ["納品物の置き場所: /virtual/home/jobs/job-1"] },
        spentUsd: 0.9,
      },
    ]);
  });

  it("子が結果を返さずに終わったら、最後の概算で失敗を返す", () => {
    const fake = makeFakeChild();
    const runner = createFactoryRunner({ home: "/virtual/home", env: {}, spawn: () => fake.handle });
    const events: RunnerEvent[] = [];
    runner.start({ jobId: "job-1", request: "一覧を作って", notify: (event) => events.push(event) });

    fake.emitMessage({ type: "event", event: { kind: "progress", progress: { stage: "試験", estimatedUsd: 0.37 } } });
    fake.emitExit(1);

    expect(events.at(-1)).toEqual({
      kind: "failed",
      reason: "工場の子が結果を返さずに終わりました",
      spentUsd: 0.37,
    });
  });

  it("取り消しで子を止め、そのあとの終了では失敗を返さない", () => {
    const fake = makeFakeChild();
    const runner = createFactoryRunner({ home: "/virtual/home", env: {}, spawn: () => fake.handle });
    const events: RunnerEvent[] = [];
    runner.start({ jobId: "job-1", request: "一覧を作って", notify: (event) => events.push(event) });

    runner.cancel("job-1", "cancel");
    expect(fake.killed()).toBe(true);

    fake.emitExit(0);
    expect(events).toEqual([]);
  });
});

describe("ジョブとの組み合わせ", () => {
  let home: string;
  let now: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "musunest-factory-runner-"));
    now = new Date(2026, 10, 11, 12, 0, 0).getTime();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("取り消しで子が止まり、ジョブが「止めた」になり、台帳が概算で締まる", () => {
    const fake = makeFakeChild();
    const runner = createFactoryRunner({ home, env: {}, spawn: () => fake.handle });
    const jobs = new Jobs({ home, runner, now: () => now });

    const started = jobs.start("一覧を作って");
    fake.emitMessage({ type: "event", event: { kind: "progress", progress: { stage: "試験", estimatedUsd: 0.37 } } });

    const view = jobs.cancel(started.id);
    expect(view.state).toBe("stopped");
    expect(view.stateLabel).toBe("止めた");
    expect(fake.killed()).toBe(true);

    const ledger = new Ledger(join(home, "ledger.jsonl"), () => now);
    expect(ledger.summary(now).actualUsd).toBeCloseTo(0.37, 2);
    expect(ledger.openReservations()).toEqual([]);
  });

  it("工場の終了コード 3 の差し戻しが、ジョブの結果になる", () => {
    const fake = makeFakeChild();
    const runner = createFactoryRunner({ home, env: {}, spawn: () => fake.handle });
    const jobs = new Jobs({ home, runner, now: () => now });

    const started = jobs.start("一覧を作って");
    fake.emitMessage({
      type: "result",
      outcome: { kind: "sent-back", spentUsd: 0.6, outDir: join(home, "jobs", started.id) },
    });

    const view = jobs.get(started.id);
    expect(view?.state).toBe("sent-back");
    expect(view?.stateLabel).toBe("差し戻し");
  });
});
