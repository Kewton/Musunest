// ジョブの走らせる役の本物（studio-s1.md §4.4・Issue #867 の目的・7）。
//
// 工場は工房自身の子プロセスの中で動かす（`runCli` は止める口を持たないので、取り消しは子を止める）。
// 親は子を起こして依頼を送り、子からの質問・確認・進みをジョブの通知に写す。答えは子へ送る。
// **ここではタイマーを持たない**——答えの期限の持ち主はジョブの側だけである。
//
// 子に渡す環境は LLM の鍵（と Jev の鍵）と実行に要る最小の変数だけにする（Cloudflare の変数は渡さない）。
import { fork } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryChildOutcome, FactoryChildRequest } from "./factory-child.js";
import {
  PER_RUN_LIMIT_USD,
  type ConfirmOutcome,
  type Runner,
  type RunnerAnswers,
  type RunnerEvent,
  type RunnerProgress,
  type RunnerStartInput,
  type StopReason,
} from "./runner.js";

/** 子プロセスに渡してよい環境変数（LLM の鍵と、実行に要る最小のもの）。Cloudflare の変数は入れない */
export const FACTORY_CHILD_ENV_KEYS = [
  "OPENAI_API_KEY",
  "JEV_API_KEY",
  "OLLAMA_API_KEY",
  "OPENROUTER_API_KEY",
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
] as const;

/** 子へ渡す環境を作る（定義されている鍵だけを写す） */
export function factoryChildEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const key of FACTORY_CHILD_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") childEnv[key] = value;
  }
  return childEnv;
}

/** 子のプロセスの口（本物の `ChildProcess` と、試験の偽物の両方を受ける） */
export interface FactoryChildHandle {
  send(message: unknown): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** 親が子へ送る開始のメッセージ */
export interface FactoryChildStartMessage {
  readonly type: "start";
  readonly request: FactoryChildRequest;
}

export interface FactoryRunnerOptions {
  /** ジョブの置き場所の親（子の置き場所は `<home>/jobs/<jobId>`） */
  readonly home: string;
  /** 起動時の環境（子へは allowlist だけを渡す） */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 子を起こす（試験は偽物を差し込む） */
  readonly spawn?: (message: FactoryChildStartMessage, env: Record<string, string>) => FactoryChildHandle;
}

interface ActiveJob {
  readonly child: FactoryChildHandle;
  readonly notify: RunnerStartInput["notify"];
  lastEstimatedUsd: number;
  done: boolean;
  cancelled: boolean;
}

/** 本物の子を起こす（工房の `factory-child.js` を Node で fork する） */
function spawnFactoryChild(message: FactoryChildStartMessage, env: Record<string, string>): FactoryChildHandle {
  const childPath = fileURLToPath(new URL("./factory-child.js", import.meta.url));
  const child = fork(childPath, [], {
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return child as unknown as FactoryChildHandle;
}

/** 子の結果を、ジョブの通知に写す */
function outcomeEvent(outcome: FactoryChildOutcome): RunnerEvent {
  if (outcome.kind === "finished") {
    return {
      kind: "finished",
      result: {
        verdict: outcome.verdict,
        content: [`納品物の置き場所: ${outcome.outDir}`],
      },
      spentUsd: outcome.spentUsd,
    };
  }
  if (outcome.kind === "sent-back") {
    return { kind: "sent-back", reason: "仕様を決め直してください", spentUsd: outcome.spentUsd };
  }
  if (outcome.kind === "failed") {
    return { kind: "failed", reason: outcome.reason, spentUsd: outcome.spentUsd };
  }
  const reason =
    outcome.reason === "timeout" || outcome.reason === "deadline"
      ? "時間切れ"
      : outcome.reason === "budget"
        ? "費用の上限に達しました"
        : outcome.reason === "declined"
          ? "確認で止めました"
          : "Plan を確定できませんでした";
  return { kind: "failed", reason, spentUsd: outcome.spentUsd };
}

/**
 * 子プロセスで工場を走らせる走らせる役。`start` で子を起こし、`answer`・`confirm` を子へ送り、
 * `cancel` で子を止める。子が結果を返さずに終わったら、最後の概算で失敗を返す（台帳はジョブが締める）。
 */
export class FactoryRunner implements Runner {
  private readonly home: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly spawn: (message: FactoryChildStartMessage, env: Record<string, string>) => FactoryChildHandle;
  private readonly active = new Map<string, ActiveJob>();

  constructor(options: FactoryRunnerOptions) {
    this.home = options.home;
    this.env = options.env;
    this.spawn = options.spawn ?? spawnFactoryChild;
  }

  start(input: RunnerStartInput): void {
    const outDir = join(this.home, "jobs", input.jobId);
    const message: FactoryChildStartMessage = {
      type: "start",
      request: { jobId: input.jobId, request: input.request, budgetUsd: PER_RUN_LIMIT_USD, outDir },
    };
    const child = this.spawn(message, factoryChildEnv(this.env));
    const job: ActiveJob = {
      child,
      notify: input.notify,
      lastEstimatedUsd: 0,
      done: false,
      cancelled: false,
    };
    this.active.set(input.jobId, job);

    child.on("message", (payload) => this.onMessage(input.jobId, job, payload));
    child.on("exit", () => this.onExit(input.jobId, job));
    child.on("error", () => this.onChildError(input.jobId, job));
    child.send(message);
  }

  answer(jobId: string, answers: RunnerAnswers): void {
    const job = this.active.get(jobId);
    if (job === undefined || job.done) return;
    job.child.send({ type: "answer", answers });
  }

  confirm(jobId: string, outcome: ConfirmOutcome): void {
    const job = this.active.get(jobId);
    if (job === undefined || job.done) return;
    job.child.send({ type: "confirm", outcome });
  }

  cancel(jobId: string, _reason: StopReason): void {
    const job = this.active.get(jobId);
    if (job === undefined) return;
    job.cancelled = true;
    job.child.kill("SIGTERM");
  }

  private onMessage(jobId: string, job: ActiveJob, payload: unknown): void {
    if (!isRecord(payload)) return;
    if (payload["type"] === "event" && isRecord(payload["event"])) {
      const event = payload["event"] as unknown as RunnerEvent;
      if (event.kind === "progress") {
        job.lastEstimatedUsd = (event as { readonly progress: RunnerProgress }).progress.estimatedUsd;
      }
      job.notify(event);
      return;
    }
    if (payload["type"] === "result") {
      job.done = true;
      this.active.delete(jobId);
      const outcome = payload["outcome"] as FactoryChildOutcome;
      job.notify(outcomeEvent(outcome));
    }
  }

  private onExit(jobId: string, job: ActiveJob): void {
    this.active.delete(jobId);
    if (job.done || job.cancelled) return;
    job.notify({
      kind: "failed",
      reason: "工場の子が結果を返さずに終わりました",
      spentUsd: job.lastEstimatedUsd,
    });
  }

  private onChildError(jobId: string, job: ActiveJob): void {
    this.active.delete(jobId);
    if (job.done || job.cancelled) return;
    job.notify({
      kind: "failed",
      reason: "工場の子を起こせませんでした",
      spentUsd: job.lastEstimatedUsd,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 子プロセスで工場を走らせる走らせる役を作る */
export function createFactoryRunner(options: FactoryRunnerOptions): FactoryRunner {
  return new FactoryRunner(options);
}
