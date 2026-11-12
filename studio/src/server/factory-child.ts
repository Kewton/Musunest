// 工場を走らせる子プロセスの入口（studio-s1.md §4.1〜§4.4・Issue #867 の目的・1〜7）。
//
// 親から IPC で依頼文・予算・置き場所を受け取り、工場の Plan の口（`runPlan`）を呼ぶ。答え役は、質問・
// 確認を親へ送り、親から答えが届くまで待つ Promise を返す（`plan-responder.ts`）。確定したら包みと依頼文を
// 置き場所に書き、工場の手元の入口（`runCli`）を同じプロセスで `--plan-file` で呼んで Build を流す。
//
// 取り消しは子プロセスを止める形にする（`runCli` は止める口を持たない）。費用は概算で親へ返す。
// **鍵・依頼文の原文をログ（標準出力）に出さない**——工場の log はこのプロセスの内側に溜める。
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OPENAI_MODEL,
  EXIT_OK,
  EXIT_RETURN_TO_PLAN,
  VOCABULARY_VERSION,
  assembleJudge,
  buildPlanCliRecord,
  buildSurfaceCheckDiagnostic,
  createOpenAiLlmClient,
  createPlanTranscript,
  loadDocumentsFromFiles,
  modelRatesOf,
  PLAN_CLI_RECORD_FILE,
  PLAN_SURFACE_CHECK_FILE,
  runCli,
  runPlan,
  type CliDeps,
  type LlmClient,
  type PlanResult,
  type PlanRunInput,
  type PlanTranscript,
  type PromptDocument,
} from "@musunest/factory";
import { remainingBuildBudgetUsd, buildFactoryBuildArgs } from "./build-args.js";
import { buildPlanEnvelope, defaultPlanEnvelopeConditions } from "./plan-envelope.js";
import { createPlanResponder, type PlanResponderChannel } from "./plan-responder.js";
import { createProgressTracker } from "./progress.js";
import type {
  ConfirmOutcome,
  ResultVerdict,
  RunnerAnswers,
  RunnerEvent,
} from "./runner.js";

/** 標準の組のモデル */
export const FACTORY_MODEL = DEFAULT_OPENAI_MODEL;
/** 標準の組の effort */
export const FACTORY_EFFORT = "medium";
/** Plan の締切（180 分。答えの待ち 30 分 × 4 ＋ 計算の余裕） */
export const FACTORY_PLAN_DEADLINE_MS = 180 * 60 * 1000;
/** 確認した人 */
export const STUDIO_CONFIRMED_BY = "studio-owner";
/** 置き場所に書く依頼文のファイル */
export const FACTORY_REQUEST_FILE = "request.txt";
/** 置き場所に書く確定した仕様の包み */
export const FACTORY_PLAN_RESULT_FILE = "plan-result.json";
/** 置き場所に保存する要約のファイル */
export const FACTORY_SUMMARY_FILE = "summary.json";

/** 親から受け取る開始の依頼 */
export interface FactoryChildRequest {
  readonly jobId: string;
  readonly request: string;
  /** 1 回の走りの上限（USD。台帳が許す額） */
  readonly budgetUsd: number;
  /** ジョブの置き場所（納品物・包み・要約をここに書く） */
  readonly outDir: string;
}

/** 親とのやり取り（質問・確認の待ちと、進みの通知） */
export interface FactoryChildChannel extends PlanResponderChannel {
  readonly notify: (event: RunnerEvent) => void;
}

/** 子の依存（本物は Node の関数、試験は偽物を差し込む） */
export interface FactoryChildDeps {
  readonly runPlan: (input: PlanRunInput) => Promise<PlanResult>;
  readonly runCli: (deps: CliDeps) => Promise<number>;
  readonly loadDocuments: () => Promise<readonly PromptDocument[]>;
  readonly makeClient: CliDeps["makeClient"];
  readonly makeJevJudge?: NonNullable<CliDeps["makeJevJudge"]>;
  readonly makeLlmJudge?: NonNullable<CliDeps["makeLlmJudge"]>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly now: () => number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
}

/** 止まった理由の分類（原文・答えを写さない） */
export const FACTORY_CHILD_STOP_REASONS = [
  "timeout",
  "declined",
  "budget",
  "deadline",
  "cannot-confirm",
  "factory-failure",
] as const;
export type FactoryChildStopReason = (typeof FACTORY_CHILD_STOP_REASONS)[number];

/** 子が親へ返す結果 */
export type FactoryChildOutcome =
  | { readonly kind: "finished"; readonly verdict: ResultVerdict; readonly spentUsd: number; readonly outDir: string }
  | { readonly kind: "sent-back"; readonly spentUsd: number; readonly outDir: string }
  | {
      readonly kind: "stopped";
      readonly reason: FactoryChildStopReason;
      readonly spentUsd: number;
      readonly codes: readonly string[];
    }
  | { readonly kind: "failed"; readonly reason: string; readonly spentUsd: number };

/** 1 行が写像（object）の JSON か */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** log の最後の JSON（要約）。読めない行は飛ばす */
function lastJsonLine(lines: readonly string[]): { readonly line: string; readonly value: Record<string, unknown> } | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) return { line, value };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** 要約の verdict を読む（知らない値・無い欄は `none`） */
function verdictOf(value: Record<string, unknown> | undefined): ResultVerdict {
  const raw = value?.["verdict"];
  return raw === "full" || raw === "partial" || raw === "none" ? raw : "none";
}

/** 要約の数値の欄を読む（無ければ 0） */
function numberOf(value: Record<string, unknown> | undefined, key: string): number {
  const raw = value?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/** Plan の止まり方を、子の分類に写す */
function stopReasonOf(reason: string): FactoryChildStopReason {
  if (reason === "declined") return "declined";
  if (reason === "deadline") return "deadline";
  if (reason === "budget") return "budget";
  return "factory-failure";
}

/** 止まった Plan の分類（段の失敗の問題の符号だけ。値は写さない） */
function failureCodesOf(result: Extract<PlanResult, { kind: "stopped" }>): readonly string[] {
  return [...new Set((result.failure?.problems ?? []).map((problem) => problem.code))];
}

/**
 * Plan の往復の記録と、申告の点検の診断をジョブの置き場に書く（納品物・公開の対象には入れない。
 * 記録の形は工場の CLI と同じ組み立てを使う。Issue #885）。
 */
async function writePlanRecords(
  deps: FactoryChildDeps,
  request: FactoryChildRequest,
  planId: string,
  result: PlanResult,
  transcript: PlanTranscript,
): Promise<void> {
  await deps.writeFile(
    join(request.outDir, PLAN_CLI_RECORD_FILE),
    JSON.stringify(buildPlanCliRecord({ result, transcript, budgetUsd: request.budgetUsd, planId })),
  );
  await deps.writeFile(
    join(request.outDir, PLAN_SURFACE_CHECK_FILE),
    JSON.stringify(buildSurfaceCheckDiagnostic({ result, planId })),
  );
}

/**
 * 子の仕事。Plan を回し、確定したら包みを書いて Build を流し、結果を親へ返す。
 * **例外の文・依頼文・答えを結果に写さない**——分類と数だけを返す。
 */
export async function runFactoryChild(
  request: FactoryChildRequest,
  channel: FactoryChildChannel,
  deps: FactoryChildDeps,
): Promise<FactoryChildOutcome> {
  await deps.makeDirectory(request.outDir);
  const requestFile = join(request.outDir, FACTORY_REQUEST_FILE);
  await deps.writeFile(requestFile, request.request);

  const apiKey = deps.env["OPENAI_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    return { kind: "failed", reason: "missing-openai-key", spentUsd: 0 };
  }

  const deadline = deps.now() + FACTORY_PLAN_DEADLINE_MS;
  const tracker = createProgressTracker({
    notify: (progress) => channel.notify({ kind: "progress", progress }),
  });
  const transcript = createPlanTranscript();
  const planId = `studio-${request.jobId}`;
  const responder = createPlanResponder({ channel, transcript, now: deps.now, deadline });
  const client: LlmClient = tracker.wrap(
    deps.makeClient({ apiKey, model: FACTORY_MODEL, effort: FACTORY_EFFORT }),
  );
  const { judge, recheckJudge } = assembleJudge({
    env: deps.env,
    model: FACTORY_MODEL,
    client,
    ...(deps.makeJevJudge === undefined ? {} : { makeJevJudge: deps.makeJevJudge }),
    ...(deps.makeLlmJudge === undefined ? {} : { makeLlmJudge: deps.makeLlmJudge }),
    logError: (line) => deps.log?.(line),
  });

  const documents = await deps.loadDocuments();
  let result: PlanResult;
  try {
    result = await deps.runPlan({
      source: request.request,
      documents,
      client,
      judge,
      recheckJudge,
      responder,
      budgetUsd: request.budgetUsd,
      rates: modelRatesOf(FACTORY_MODEL),
      now: deps.now,
      deadline,
      effort: FACTORY_EFFORT,
      planId,
      vocabularyVersion: VOCABULARY_VERSION,
      confirmedBy: STUDIO_CONFIRMED_BY,
    });
  } catch {
    return { kind: "failed", reason: "factory-failure", spentUsd: tracker.estimatedUsd };
  }

  // 確定したかどうかによらず、Plan の記録と診断をジョブの置き場に書く（Issue #885）。書けなくても、
  // 子の結果（止まった理由・符号・費用）は変えない——記録の失敗はログに 1 行だけ残す。
  try {
    await writePlanRecords(deps, request, planId, result, transcript);
  } catch {
    deps.log?.("Plan の記録を書けませんでした");
  }

  if (result.kind !== "confirmed") {
    if (responder.timedOut) {
      return { kind: "stopped", reason: "timeout", spentUsd: result.spentUsd, codes: [] };
    }
    if (result.kind === "cannot-confirm") {
      return {
        kind: "stopped",
        reason: "cannot-confirm",
        spentUsd: result.spentUsd,
        codes: [...new Set(result.reasons.map((reason) => reason.code))],
      };
    }
    return {
      kind: "stopped",
      reason: stopReasonOf(result.reason),
      spentUsd: result.spentUsd,
      codes: failureCodesOf(result),
    };
  }

  const conditions = defaultPlanEnvelopeConditions({
    model: FACTORY_MODEL,
    effort: FACTORY_EFFORT,
    budgetUsd: request.budgetUsd,
    deadlineMs: FACTORY_PLAN_DEADLINE_MS,
  });
  const envelope = await buildPlanEnvelope({ result, source: request.request, conditions });
  const planFile = join(request.outDir, FACTORY_PLAN_RESULT_FILE);
  await deps.writeFile(planFile, JSON.stringify(envelope));

  const buildBudgetUsd = remainingBuildBudgetUsd(result.spentUsd, request.budgetUsd);
  if (buildBudgetUsd <= 0) {
    return { kind: "stopped", reason: "budget", spentUsd: result.spentUsd, codes: ["build-budget"] };
  }

  const argv = buildFactoryBuildArgs({
    requestFile,
    outDir: request.outDir,
    planFile,
    planSpentUsd: result.spentUsd,
    perRunLimitUsd: request.budgetUsd,
  });
  const buildLines: string[] = [];
  const code = await deps.runCli({
    argv,
    env: deps.env,
    readFile: deps.readFile,
    writeFile: deps.writeFile,
    makeDirectory: deps.makeDirectory,
    loadDocuments: deps.loadDocuments,
    makeClient: (options) => tracker.wrap(deps.makeClient(options)),
    ...(deps.makeJevJudge === undefined ? {} : { makeJevJudge: deps.makeJevJudge }),
    ...(deps.makeLlmJudge === undefined ? {} : { makeLlmJudge: deps.makeLlmJudge }),
    now: deps.now,
    log: (line) => buildLines.push(line),
    logError: (line) => buildLines.push(line),
  });

  const summary = lastJsonLine(buildLines);
  await deps.writeFile(
    join(request.outDir, FACTORY_SUMMARY_FILE),
    summary === undefined ? "" : `${summary.line}\n`,
  );

  const spentUsd = result.spentUsd + numberOf(summary?.value, "provider_cost_usd");
  if (code === EXIT_RETURN_TO_PLAN) {
    return { kind: "sent-back", spentUsd, outDir: request.outDir };
  }
  if (code !== EXIT_OK) {
    return { kind: "failed", reason: `build-exit-${String(code)}`, spentUsd };
  }
  return { kind: "finished", verdict: verdictOf(summary?.value), spentUsd, outDir: request.outDir };
}

/** 本物の依存（Node のファイルと工場の公開の口） */
export async function createNodeFactoryChildDeps(): Promise<FactoryChildDeps> {
  const fs = await import("node:fs/promises");
  return {
    runPlan,
    runCli,
    loadDocuments: loadDocumentsFromFiles,
    makeClient: (options) =>
      createOpenAiLlmClient({
        apiKey: options.apiKey,
        model: options.model,
        effort: options.effort,
        ...(options.envelope === undefined ? {} : { envelope: options.envelope }),
      }),
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, text) => fs.writeFile(path, text, "utf8"),
    makeDirectory: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
    now: () => Date.now(),
    env: process.env,
  };
}

/** 親との IPC の形（`process` と、試験の偽物の両方を受ける） */
interface IpcProcess {
  on(event: "message", listener: (message: unknown) => void): unknown;
  send(message: unknown): unknown;
}

/** 親からの開始の依頼か */
function isStartMessage(value: unknown): value is { readonly type: "start"; readonly request: FactoryChildRequest } {
  return isRecord(value) && value["type"] === "start" && isRecord(value["request"]) && typeof value["request"]["jobId"] === "string";
}

/** IPC を、答え役の口と進みの通知に写す */
function createIpcChannel(proc: IpcProcess): FactoryChildChannel {
  const answerWaiters: ((answers: RunnerAnswers) => void)[] = [];
  const confirmWaiters: ((outcome: ConfirmOutcome) => void)[] = [];

  proc.on("message", (message) => {
    if (!isRecord(message)) return;
    if (message["type"] === "answer" && isRecord(message["answers"])) {
      answerWaiters.shift()?.(message["answers"] as unknown as RunnerAnswers);
      return;
    }
    if (message["type"] === "confirm") {
      const outcome = message["outcome"];
      if (outcome === "build" || outcome === "stop") confirmWaiters.shift()?.(outcome);
    }
  });

  return {
    notify: (event) => {
      proc.send({ type: "event", event });
    },
    ask: (question) =>
      new Promise((resolve) => {
        answerWaiters.push(resolve);
        proc.send({ type: "event", event: { kind: "question", question } });
      }),
    confirm: (confirmation) =>
      new Promise((resolve) => {
        confirmWaiters.push(resolve);
        proc.send({ type: "event", event: { kind: "confirmation", confirmation } });
      }),
  };
}

/** この file が入口として起動されたときだけ動く（import したときは動かさない） */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(import.meta.url) === entry;
}

/** 子プロセスの入口。親から開始の依頼を受けたら 1 回だけ走る */
export async function main(): Promise<void> {
  if (!isEntryPoint()) return;
  const proc = process as unknown as IpcProcess & { on(event: "message", listener: (message: unknown) => void): unknown };
  let started = false;
  proc.on("message", (message) => {
    if (started || !isStartMessage(message)) return;
    started = true;
    void (async () => {
      const deps = await createNodeFactoryChildDeps();
      const outcome = await runFactoryChild(message.request, createIpcChannel(proc), deps);
      proc.send({ type: "result", outcome });
    })();
  });
}

void main();
