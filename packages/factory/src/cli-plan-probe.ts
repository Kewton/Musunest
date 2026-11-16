// Plan の探針の入口（Issue #956）。`factory:plan-probe -- ...` で、Plan の上流（P1・P2・その往復）だけを
// 流し、回ごとの記録・条件・集計を新しいディレクトリに書く。
//
// **環境変数とファイルを扱うのは入口だけ**である（`cli.ts`・`cli-claims.ts` と同じ作法）。鍵は provider の
// 環境変数から読み、client の組み立ては `cli.ts` の公開の口（`makeLlmClient`）を使う。文書は
// `loadDocumentsFromFiles`（既存の口）で読む。**引数で渡した題材の組だけを読む**——ディレクトリの走査・
// 既定のパス・環境変数からのパスの解決はしない。`.env` という名前のファイルは断る。
//
// 出力先は**新しいディレクトリだけ**を受ける（既にあれば断る。上書き・再開はしない）。完了した回は
// その都度書くので、途中で止まっても完了した回は残る。条件・回・集計のファイルには、鍵・環境変数の値を
// 書かない。
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_EFFORT,
  EXIT_OK,
  EXIT_RUN_FAILED,
  EXIT_USAGE,
  PROVIDERS,
  apiKeyEnvOf,
  loadDocumentsFromFiles,
  makeLlmClient,
  runRatesOf,
  type LlmClientOptions,
  type Provider,
} from "./cli.js";
import type { TokenRates } from "./budget.js";
import { AGENT_LIMITS, type AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import type { PromptDocument } from "./stages/prompt.js";
import {
  buildPlanProbeConditions,
  parsePlanProbeCases,
  planProbeCaseSetSha256,
  planProbeSourceSha256,
  runPlanProbe,
  validatePlanProbeCaseSet,
  PLAN_PROBE_STAGES,
  type PlanProbeStage,
} from "./plan/probe.js";
import { sha256Hex } from "./cli-plan.js";
import { DEFAULT_OLLAMA_MODEL } from "./ollama.js";
import { DEFAULT_OPENAI_MODEL } from "./openai.js";
import { DEFAULT_OPENROUTER_MODEL } from "./openrouter.js";

/** 使い方の文 */
export const PLAN_PROBE_USAGE =
  `使い方: factory:plan-probe -- --stage ${PLAN_PROBE_STAGES.join("|")} --cases <題材の組のファイル> --out <新しいディレクトリ> [--repeat <回>] --budget <USD> [--deadline <分>] [--provider ${PROVIDERS.join("|")}] [--model <名前>] [--effort <値>]`;

/** 引数 */
export interface PlanProbeArguments {
  readonly stage: PlanProbeStage;
  readonly casesFile: string;
  readonly outDir: string;
  readonly repeat: number;
  /** 必須（USD） */
  readonly budgetUsd: number;
  readonly deadlineMs?: number;
  readonly model: string;
  readonly effort: string;
  readonly provider?: Provider;
}

function isStage(value: string): value is PlanProbeStage {
  return (PLAN_PROBE_STAGES as readonly string[]).includes(value);
}

function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** 引数を読む。誤りは `error` に人の読む文を入れて返す（例外にしない） */
export function parsePlanProbeArguments(argv: readonly string[]): PlanProbeArguments | { readonly error: string } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let stage: PlanProbeStage | undefined;
  let casesFile: string | undefined;
  let outDir: string | undefined;
  let repeat = 1;
  let budgetUsd: number | undefined;
  let deadlineMs: number | undefined;
  let explicitModel: string | undefined;
  let effort: string = DEFAULT_EFFORT;
  let provider: Provider | undefined;
  const valueAfter = (index: number, option: string): string | { readonly error: string } => {
    const raw = args[index + 1];
    return raw === undefined ? { error: `${option} には値が要ります` } : raw;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (
      arg === "--stage" ||
      arg === "--cases" ||
      arg === "--out" ||
      arg === "--repeat" ||
      arg === "--budget" ||
      arg === "--deadline" ||
      arg === "--model" ||
      arg === "--effort" ||
      arg === "--provider"
    ) {
      const value = valueAfter(index, arg);
      index += 1;
      if (typeof value !== "string") return value;
      if (arg === "--stage") {
        if (!isStage(value)) return { error: `--stage には ${PLAN_PROBE_STAGES.join(" か ")} を指定してください` };
        stage = value;
      } else if (arg === "--cases") {
        casesFile = value;
      } else if (arg === "--out") {
        outDir = value;
      } else if (arg === "--repeat") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) return { error: "--repeat には 1 以上の整数を指定してください" };
        repeat = parsed;
      } else if (arg === "--budget") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return { error: "--budget には 0 より大きい数（USD）を指定してください" };
        budgetUsd = parsed;
      } else if (arg === "--deadline") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return { error: "--deadline には 0 より大きい数（分）を指定してください" };
        deadlineMs = parsed * 60_000;
      } else if (arg === "--model") {
        explicitModel = value;
      } else if (arg === "--effort") {
        effort = value;
      } else if (arg === "--provider") {
        if (!isProvider(value)) return { error: `--provider には ${PROVIDERS.join(" か ")} を指定してください` };
        provider = value;
      }
      continue;
    }
    return { error: `知らない選択肢: ${arg}` };
  }
  if (stage === undefined) return { error: "--stage を指定してください" };
  if (casesFile === undefined) return { error: "--cases で題材の組のファイルを指定してください" };
  if (outDir === undefined) return { error: "--out で新しい出力のディレクトリを指定してください" };
  if (budgetUsd === undefined) return { error: "--budget（USD）は必須です" };
  const model =
    explicitModel ??
    (provider === "ollama"
      ? DEFAULT_OLLAMA_MODEL
      : provider === "openrouter"
        ? DEFAULT_OPENROUTER_MODEL
        : DEFAULT_OPENAI_MODEL);
  return {
    stage,
    casesFile,
    outDir,
    repeat,
    budgetUsd,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    model,
    effort,
    ...(provider === undefined ? {} : { provider }),
  };
}

/** 入口の依存（試験は偽物を差し込む） */
export interface PlanProbeCliDeps {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
  /** 既にあるかを確かめる（出力先を上書きしないため。Node の入口は `fs.stat` を使う） */
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly loadDocuments?: () => Promise<readonly PromptDocument[]>;
  readonly makeClient?: (options: LlmClientOptions) => LlmClient;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly rates?: TokenRates;
  readonly modelRates?: Readonly<Record<string, TokenRates>>;
  readonly limits?: AgentLimits;
  readonly budgetUsd?: number;
  readonly deadlineMs?: number;
}

/** パスの最後の名前 */
function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** パスを組む（`/` 区切り） */
function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** 記録のファイル名（完了した順の通し番号） */
function runFileName(index: number): string {
  return `run-${String(index).padStart(4, "0")}.json`;
}

/**
 * 探針を 1 回流す（Issue #956）。題材の組の検査と鍵の確認を**client を作る前**に行い、出力先が既にあれば
 * 何も書かない。流し始めた後は、完了した回をその都度書き、条件と集計を最後に書く。
 */
export async function runPlanProbeCli(deps: PlanProbeCliDeps): Promise<number> {
  const log = deps.log ?? ((): void => {});
  const parsed = parsePlanProbeArguments(deps.argv);
  if ("error" in parsed) {
    log(`使い方の誤り: ${parsed.error}`);
    log(PLAN_PROBE_USAGE);
    return EXIT_USAGE;
  }
  if (baseNameOf(parsed.casesFile) === ".env") {
    log("使い方の誤り: .env という名前のファイルは読みません");
    log(PLAN_PROBE_USAGE);
    return EXIT_USAGE;
  }
  if (await deps.pathExists(parsed.outDir)) {
    log(`使い方の誤り: 出力先 ${parsed.outDir} は既にあります（新しいディレクトリだけを受けます）`);
    return EXIT_USAGE;
  }

  let text: string;
  try {
    text = await deps.readFile(parsed.casesFile);
  } catch {
    log(`使い方の誤り: 題材の組のファイル ${parsed.casesFile} を読めません`);
    return EXIT_USAGE;
  }
  const parsedCases = parsePlanProbeCases(text);
  if ("code" in parsedCases) {
    log(`使い方の誤り: ${parsedCases.code}（${parsedCases.error}）`);
    log(PLAN_PROBE_USAGE);
    return EXIT_USAGE;
  }
  const invalid = validatePlanProbeCaseSet(parsedCases.cases, parsed.stage);
  if (invalid !== null) {
    log(`使い方の誤り: ${invalid.code}（${invalid.error}）`);
    log(PLAN_PROBE_USAGE);
    return EXIT_USAGE;
  }

  const provider = parsed.provider ?? "openai";
  const apiKeyEnv = apiKeyEnvOf(provider);
  const apiKey = deps.env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    log(`使い方の誤り: 環境変数 ${apiKeyEnv} がありません`);
    log(PLAN_PROBE_USAGE);
    return EXIT_USAGE;
  }

  const documents = await (deps.loadDocuments ?? loadDocumentsFromFiles)();
  const now = deps.now ?? ((): number => Date.now());
  const budgetUsd = parsed.budgetUsd;
  const deadlineMs = parsed.deadlineMs ?? deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const limits = deps.limits ?? AGENT_LIMITS;
  const rates =
    deps.rates ??
    runRatesOf({
      provider,
      model: parsed.model,
      ...(deps.modelRates === undefined ? {} : { modelRates: deps.modelRates }),
    });
  const makeClient = deps.makeClient ?? ((options: LlmClientOptions): LlmClient => makeLlmClient(options));
  const client = makeClient({
    apiKey,
    model: parsed.model,
    effort: parsed.effort,
    ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
  });

  try {
    // 親は既存であることを要する（recursive にしない）。既にあれば `EEXIST` で断る。
    await deps.makeDirectory(parsed.outDir);
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    log(
      code === "EEXIST"
        ? `使い方の誤り: 出力先 ${parsed.outDir} は既にあります（新しいディレクトリだけを受けます）`
        : `使い方の誤り: 出力先 ${parsed.outDir} を作れません`,
    );
    return EXIT_USAGE;
  }

  // 条件は**流す前**に書く（回の途中で止まっても、何を流したかが残る）。集計は最後に書く。
  const conditions = await buildPlanProbeConditions({
    stage: parsed.stage,
    cases: parsedCases.cases,
    caseSetSha256: await planProbeCaseSetSha256(parsedCases.cases),
    caseFileSha256: await sha256Hex(text),
    documents,
    sourceSha256: await planProbeSourceSha256(parsedCases.cases),
    provider,
    model: parsed.model,
    effort: parsed.effort,
    repeat: parsed.repeat,
    budgetUsd,
    deadlineMs,
    limits,
    rates,
  });
  await deps.writeFile(joinPath(parsed.outDir, "conditions.json"), JSON.stringify(conditions));

  let completedOrder = 0;
  const result = await runPlanProbe({
    stage: parsed.stage,
    cases: parsedCases.cases,
    documents,
    client,
    budgetUsd,
    deadline: now() + deadlineMs,
    now,
    rates,
    effort: parsed.effort,
    repeat: parsed.repeat,
    limits,
    onRun: async (record) => {
      completedOrder += 1;
      await deps.writeFile(joinPath(parsed.outDir, runFileName(completedOrder)), JSON.stringify(record));
    },
  });

  await deps.writeFile(joinPath(parsed.outDir, "summary.json"), JSON.stringify(result.summary));

  log(
    JSON.stringify({
      stage: parsed.stage,
      planned: result.summary.planned,
      completed: result.summary.completed,
      failed: result.summary.failed,
      not_run: result.summary.not_run,
      spent_usd: result.summary.cost.spent_usd,
    }),
  );
  return result.summary.failed === 0 && result.summary.not_run === 0 ? EXIT_OK : EXIT_RUN_FAILED;
}

// ── Node 側（ファイルと環境変数を扱う。動的に読む）────────────────────

interface NodeProcess {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  exitCode?: number;
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
}

interface NodeFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string): Promise<string | undefined>;
  stat(path: string): Promise<unknown>;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

function selfUrl(): string {
  return (import.meta as ImportMeta & { url: string }).url;
}

function isEntryPoint(proc: NodeProcess): boolean {
  const entry = proc.argv[1];
  if (entry === undefined) return false;
  return selfUrl().endsWith(entry);
}

/** 実入口の依存を組む（ファイル・環境変数・鍵・client の組み立てはここで用意する） */
export async function nodePlanProbeDeps(proc: NodeProcess): Promise<PlanProbeCliDeps> {
  const fs = (await importUntyped("node:fs/promises")) as NodeFs;
  return {
    argv: proc.argv.slice(2),
    env: proc.env,
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, text) => fs.writeFile(path, text, "utf8"),
    makeDirectory: async (path) => {
      // 親は既存であることを要する。既にある出力先は `EEXIST` で断る（recursive にしない）。
      await fs.mkdir(path);
    },
    pathExists: async (path) => {
      try {
        await fs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    loadDocuments: loadDocumentsFromFiles,
    makeClient: (options) => makeLlmClient(options),
    log: (line) => proc.stdout.write(`${line}\n`),
  };
}

/** 手元から流す入口（`node dist/cli-plan-probe.js -- --stage p1 ...`） */
export async function main(): Promise<void> {
  const proc = (globalThis as unknown as { process?: NodeProcess }).process;
  if (proc === undefined || !isEntryPoint(proc)) return;
  proc.exitCode = await runPlanProbeCli(await nodePlanProbeDeps(proc));
}

void main();
