// 手元の入口（02-architecture.md §3.2）。
//
// `factory:run -- <依頼文のファイル> --out <ディレクトリ>` で、手元から 1 回の生成を流す。出力は納品物の
// ディレクトリである。**この入口だけが環境変数とファイルを扱う**——鍵は環境変数 `OPENAI_API_KEY`（LLM）と
// `JEV_API_KEY`（Jev）から読み、文書（契約・語彙の意味・語彙の台帳）はファイルから読む。単価はここで渡す
// （日付付きの既定値）。**判定の口（05 §4）もここで組み立てて生成に渡す**——`JEV_API_KEY` があれば Jev を
// 主・LLM を落とし先にした組み合わせ、無ければ LLM だけを使う（標準エラーに 1 行出す）。
//
// **ライブラリ（run.ts・bundle.ts・record.ts・段）は、環境変数もファイルも Node 固有の API も持たない。**
// ここが外側との境目である。鍵が無ければ、API を呼ばずに使い方の誤りで終わる。
//
// `node:fs` は**動的**に読む（Worker が根（index.ts）から import しても、この経路は呼ばれない限り動かない。
// appspec-schema の contract.ts と同じやり方）。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import type { TokenRates } from "./budget.js";
import { bundleFiles } from "./bundle.js";
import {
  buildPlanCliRecord,
  createAnswersFilePlanResponder,
  createInteractivePlanResponder,
  createPlanTranscript,
  parsePlanAnswers,
  PLAN_CLI_RECORD_FILE,
  planBuildCostLine,
  planStopReasonLine,
  type Terminal,
} from "./cli-plan.js";
import { createFallbackJudge, type Judge } from "./judge.js";
import { createJevJudge } from "./judge-jev.js";
import { createLlmJudge } from "./judge-llm.js";
import type { AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import { createOpenAiLlmClient, DEFAULT_OPENAI_MODEL } from "./openai.js";
import { runPlan, type PlanResponder } from "./plan/run-plan.js";
import { runGeneration } from "./run.js";
import type { PromptDocument } from "./stages/prompt.js";

/** 工場の識別（要約の `builder`。S-5） */
export const BUILDER = "musunest-factory" as const;
/** プロンプトの版（§3・S-5） */
export const PROMPT_VERSION = "v1" as const;
/** 契約の版（`03-evaluation.md` §1 が v0.2 に固定する） */
export const CONTRACT_VERSION = "v0.2" as const;
/** P3 が照らす語彙の版（確定した仕様の `vocabulary_version`。04 §4・Issue #336） */
export const VOCABULARY_VERSION = "v1" as const;
/** spec-engine の版（§4。改名は U-B） */
export const SPEC_ENGINE_VERSION = "0.0.0" as const;
/** factory の版（§4。改名は U-B） */
export const FACTORY_VERSION = "0.0.0" as const;

/** 既定の effort（§2「品質優先で high から始める」） */
export const DEFAULT_EFFORT = "high" as const;
/** 既定の費用の上限（USD。C-1。2026-10-09 所有者の決定で 0.30 に広げた） */
export const DEFAULT_BUDGET_USD = 0.3 as const;
/** 既定の締切（ミリ秒。T-1。2026-10-09 所有者の決定で 10 分に広げた） */
export const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;
/** 鍵を読む環境変数の名前 */
export const API_KEY_ENV = "OPENAI_API_KEY" as const;
/** Jev の鍵を読む環境変数の名前。**鍵を読むのは手元の入口だけ**（adapter は環境変数を読まない。§4） */
export const JEV_API_KEY_ENV = "JEV_API_KEY" as const;

/**
 * 単価（USD / 1 トークン）。2026-10-09 の公開値（入力 $0.10・キャッシュの読み取り $0.01・
 * キャッシュの書き込み $0.125・出力 $0.50／100 万）。書き込みは入力の 1.25 倍である（§1.2・#342）。
 */
export const DEFAULT_RATES: TokenRates = {
  inputPerToken: 0.1 / 1_000_000,
  cachedInputPerToken: 0.01 / 1_000_000,
  cacheWritePerToken: 0.125 / 1_000_000,
  outputPerToken: 0.5 / 1_000_000,
};

/** 終了コード：成功（納品物を書いた） */
export const EXIT_OK = 0;
/** 終了コード：生成が失敗した（早期停止。納品物を書かなかった） */
export const EXIT_RUN_FAILED = 1;
/** 終了コード：使い方の誤り（鍵が無い・引数が足りない） */
export const EXIT_USAGE = 2;

/** 使い方の文（誤りを人に見せる） */
export const USAGE =
  "使い方: factory:run -- <依頼文のファイル> --out <ディレクトリ> [--model <名前>] [--effort <値>] [--budget <USD>] [--deadline <分>] [--timeout <分>] [--plan [--answers <ファイル>]]";

/** 手元の入口が受け取る引数 */
export interface CliArguments {
  readonly requestFile: string;
  readonly outDir: string;
  readonly model: string;
  readonly effort: string;
  /** 費用の上限（USD）。指定しなければ既定（`DEFAULT_BUDGET_USD`）を使う */
  readonly budgetUsd?: number;
  /** 締切（ミリ秒）。指定しなければ既定（`DEFAULT_DEADLINE_MS`）を使う */
  readonly deadlineMs?: number;
  /**
   * 呼び出し 1 回ごとの timeout（ミリ秒）。指定しなければ effort から出す（#302）。
   * 実際に使う値は締切の残りを超えない（共通の口が頭を打つ）。
   */
  readonly timeoutMs?: number;
  /** `--plan` を付けると、Plan を回してから Build を流す（04 §7・Issue #336） */
  readonly plan?: boolean;
  /** 答えのファイル（`--answers <ファイル>`。付けると対話の代わりにファイルから答える。評価用） */
  readonly answersFile?: string;
}

/** 引数を読む。誤りは `error` に人の読む文を入れて返す（例外にしない） */
export function parseCliArguments(argv: readonly string[]): CliArguments | { readonly error: string } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let requestFile: string | undefined;
  let outDir: string | undefined;
  let model: string = DEFAULT_OPENAI_MODEL;
  let effort: string = DEFAULT_EFFORT;
  let budgetUsd: number | undefined;
  let deadlineMs: number | undefined;
  let timeoutMs: number | undefined;
  let plan = false;
  let answersFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--plan") {
      plan = true;
      continue;
    }
    if (arg === "--answers") {
      const raw = args[index + 1];
      index += 1;
      if (raw === undefined) return { error: "--answers には答えのファイルを指定してください" };
      answersFile = raw;
      continue;
    }
    if (arg === "--out") {
      outDir = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = args[index + 1] ?? model;
      index += 1;
      continue;
    }
    if (arg === "--effort") {
      effort = args[index + 1] ?? effort;
      index += 1;
      continue;
    }
    if (arg === "--budget") {
      const raw = args[index + 1];
      index += 1;
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        return { error: "--budget には 0 より大きい数（USD）を指定してください" };
      }
      budgetUsd = value;
      continue;
    }
    if (arg === "--deadline") {
      const raw = args[index + 1];
      index += 1;
      const minutes = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { error: "--deadline には 0 より大きい数（分）を指定してください" };
      }
      deadlineMs = minutes * 60_000;
      continue;
    }
    if (arg === "--timeout") {
      const raw = args[index + 1];
      index += 1;
      const minutes = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { error: "--timeout には 0 より大きい数（分）を指定してください" };
      }
      timeoutMs = minutes * 60_000;
      continue;
    }
    if (arg.startsWith("--")) return { error: `知らない選択肢: ${arg}` };
    if (requestFile === undefined) {
      requestFile = arg;
      continue;
    }
    return { error: `余分な引数: ${arg}` };
  }
  if (requestFile === undefined) return { error: "依頼文のファイルを指定してください" };
  if (outDir === undefined) return { error: "--out で出力のディレクトリを指定してください" };
  if (answersFile !== undefined && !plan) {
    return { error: "--answers は --plan と一緒に指定してください" };
  }
  return {
    requestFile,
    outDir,
    model,
    effort,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(plan ? { plan: true } : {}),
    ...(answersFile === undefined ? {} : { answersFile }),
  };
}

/** 手元の入口の依存（試験は偽物を差し込む） */
export interface CliDeps {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly loadDocuments: () => Promise<readonly PromptDocument[]>;
  readonly makeClient: (options: { apiKey: string; model: string; effort: string }) => LlmClient;
  /**
   * Jev の判定の adapter を作る（05 §4）。**鍵を読むのは手元の入口だけ**——`JEV_API_KEY` を環境変数
   * から読んで渡す（adapter は環境変数を読まない）。試験は偽物を差し込む（実 API を呼ばない）。
   */
  readonly makeJevJudge?: (options: { apiKey: string }) => Judge;
  /** LLM の判定の adapter を作る（05 §4）。試験は偽物を差し込む。既定は本物（`judge-llm.ts`） */
  readonly makeLlmJudge?: (options: { client: LlmClient; model: string }) => Judge;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** 標準エラーに 1 行出す（判定を落としたときの注意。既定は何もしない） */
  readonly logError?: (line: string) => void;
  readonly rates?: TokenRates;
  readonly budgetUsd?: number;
  readonly deadlineMs?: number;
  readonly limits?: AgentLimits;
  /**
   * 対話の端末（`--plan` を `--answers` 無しで使うときに要る。04 §7）。本物は `main` が用意し、
   * 試験は偽物を差し込む（本物の端末を触らない）。
   */
  readonly terminal?: Terminal;
}

/** 出力のパスを組む（納品物の相対パスは `/` 区切り） */
function joinPath(directory: string, path: string): string {
  return directory.endsWith("/") ? `${directory}${path}` : `${directory}/${path}`;
}

/** 相対パスの親ディレクトリ（`artifacts/app.spec.yaml` → `artifacts`。直下なら空文字） */
function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

/**
 * 判定の口を組み立てる（05 §4・Issue #355）。`JEV_API_KEY` があれば **Jev を主・LLM を落とし先**にした
 * 組み合わせ、無ければ LLM だけを使う（その旨を標準エラーに 1 行出す）。**鍵を読むのはここだけ**——adapter
 * （Jev・LLM）は環境変数を読まない。Plan にも Build にも**同じ判定の口**を渡す（Issue #336）。
 */
function assembleJudge(deps: CliDeps, model: string, client: LlmClient, logError: (line: string) => void): Judge {
  const llmJudge = (deps.makeLlmJudge ?? createLlmJudge)({ client, model });
  const jevApiKey = deps.env[JEV_API_KEY_ENV];
  if (jevApiKey !== undefined && jevApiKey !== "") {
    return createFallbackJudge({
      primary: (deps.makeJevJudge ?? createJevJudge)({ apiKey: jevApiKey }),
      fallback: llmJudge,
    });
  }
  logError(`環境変数 ${JEV_API_KEY_ENV} が無いので、判定は LLM（${model}）だけを使います`);
  return llmJudge;
}

/** 生成の入力のうち、Plan の有無で変わらない部分（`--out` のディレクトリ・締切・上限） */
interface BuildJob {
  readonly source: string;
  readonly documents: readonly PromptDocument[];
  readonly client: LlmClient;
  readonly judge: Judge;
  readonly outDir: string;
  readonly model: string;
  readonly effort: string;
  readonly budgetUsd: number;
  readonly deadline: number;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

/**
 * 1 回の生成を流し、納品物をディレクトリに書く（§3.2）。要約は 1 行の JSON で出す。
 * 返すのは、終了コードと**生成が使った額（USD）**（Plan と合わせて最後に 1 行出すため。Issue #336）。
 */
async function runBuild(
  deps: CliDeps,
  job: BuildJob & { readonly plan?: ConfirmedPlan },
  log: (line: string) => void,
): Promise<{ readonly code: number; readonly costUsd: number }> {
  const run = await runGeneration({
    source: job.source,
    documents: job.documents,
    client: job.client,
    budgetUsd: job.budgetUsd,
    rates: deps.rates ?? DEFAULT_RATES,
    now: job.now,
    deadline: job.deadline,
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(job.timeoutMs === undefined ? {} : { callTimeoutMs: job.timeoutMs }),
    judge: job.judge,
    runId: `local-${String(job.now())}`,
    storageUnit: job.outDir,
    builder: BUILDER,
    model: job.model,
    effort: job.effort,
    promptVersion: PROMPT_VERSION,
    contractVersion: CONTRACT_VERSION,
    specEngineVersion: SPEC_ENGINE_VERSION,
    factoryVersion: FACTORY_VERSION,
    ...(job.plan === undefined ? {} : { plan: job.plan }),
  });

  if (run.bundle !== null) {
    await deps.makeDirectory(job.outDir);
    for (const file of bundleFiles(run.bundle)) {
      const parent = parentOf(file.path);
      if (parent !== "") await deps.makeDirectory(joinPath(job.outDir, parent));
      await deps.writeFile(joinPath(job.outDir, file.path), file.text);
    }
  }
  log(JSON.stringify(run.summary));
  return {
    code: run.bundle === null ? EXIT_RUN_FAILED : EXIT_OK,
    costUsd: run.summary.provider_cost_usd ?? 0,
  };
}

/**
 * `--plan` の道（Issue #336）。Plan を 1 回流し、確定した仕様を Build に渡す。**予算は Plan と Build で
 * 1 つ**——Build には、全体の予算から Plan で使った額を引いた残りを渡す（§8）。確定できなければ Build を
 * 流さず、理由を 1 行出して 0 でない終了コードで終わる。往復の記録は `--out` に置く（納品物には入れない）。
 */
async function runPlanThenBuild(
  deps: CliDeps,
  parsed: CliArguments,
  job: BuildJob,
  log: (line: string) => void,
): Promise<number> {
  const transcript = createPlanTranscript();
  let responder: PlanResponder;
  if (parsed.answersFile !== undefined) {
    const answersText = await deps.readFile(parsed.answersFile);
    const answers = parsePlanAnswers(answersText);
    if ("error" in answers) {
      log(`使い方の誤り: ${answers.error}`);
      return EXIT_USAGE;
    }
    responder = createAnswersFilePlanResponder(answers, transcript);
  } else {
    const terminal = deps.terminal;
    if (terminal === undefined) {
      log(`使い方の誤り: --plan の対話には端末が要ります（--answers <ファイル> でも渡せます）`);
      return EXIT_USAGE;
    }
    responder = createInteractivePlanResponder(terminal, transcript);
  }

  const planId = `local-plan-${String(job.now())}`;
  const result = await runPlan({
    source: job.source,
    documents: job.documents,
    client: job.client,
    judge: job.judge,
    responder,
    budgetUsd: job.budgetUsd,
    rates: deps.rates ?? DEFAULT_RATES,
    now: job.now,
    deadline: job.deadline,
    effort: job.effort,
    planId,
    vocabularyVersion: VOCABULARY_VERSION,
    confirmedBy: "local",
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(job.timeoutMs === undefined ? {} : { callTimeoutMs: job.timeoutMs }),
  });

  await deps.makeDirectory(job.outDir);
  await deps.writeFile(
    joinPath(job.outDir, PLAN_CLI_RECORD_FILE),
    JSON.stringify(buildPlanCliRecord({ result, transcript, budgetUsd: job.budgetUsd, planId })),
  );

  if (result.kind !== "confirmed") {
    log(planStopReasonLine(result));
    log(planBuildCostLine(result.spentUsd, 0));
    return EXIT_RUN_FAILED;
  }
  if (result.remainingUsd <= 0) {
    log("Plan で予算を使い切ったので、Build を流しません");
    log(planBuildCostLine(result.spentUsd, 0));
    return EXIT_RUN_FAILED;
  }

  // 確定した仕様を Build の正本にし、残りの予算を渡す（§5・§8）
  const build = await runBuild(deps, { ...job, budgetUsd: result.remainingUsd, plan: result.plan }, log);
  log(planBuildCostLine(result.spentUsd, build.costUsd));
  return build.code;
}

/**
 * 1 回の生成を流し、納品物をディレクトリに書く（§3.2）。`--plan` があれば、Plan を回してから Build を流す
 * （Issue #336）。鍵が無ければ **`makeClient` を呼ばずに**使い方の誤りで終わる（API を呼ばない）。
 */
export async function runCli(deps: CliDeps): Promise<number> {
  const log = deps.log ?? ((): void => {});
  const logError = deps.logError ?? ((): void => {});
  const parsed = parseCliArguments(deps.argv);
  if ("error" in parsed) {
    log(`使い方の誤り: ${parsed.error}`);
    log(USAGE);
    return EXIT_USAGE;
  }
  const apiKey = deps.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    log(`使い方の誤り: 環境変数 ${API_KEY_ENV} がありません`);
    log(USAGE);
    return EXIT_USAGE;
  }

  const source = await deps.readFile(parsed.requestFile);
  const documents = await deps.loadDocuments();
  const client = deps.makeClient({ apiKey, model: parsed.model, effort: parsed.effort });
  const judge = assembleJudge(deps, parsed.model, client, logError);

  const now = deps.now ?? ((): number => Date.now());
  const deadline = now() + (parsed.deadlineMs ?? deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const job: BuildJob = {
    source,
    documents,
    client,
    judge,
    outDir: parsed.outDir,
    model: parsed.model,
    effort: parsed.effort,
    budgetUsd: parsed.budgetUsd ?? deps.budgetUsd ?? DEFAULT_BUDGET_USD,
    deadline,
    now,
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
  };

  if (parsed.plan === true) return runPlanThenBuild(deps, parsed, job, log);
  const build = await runBuild(deps, job, log);
  return build.code;
}

// ── Node 側（ファイルと環境変数を扱う。動的に読む）────────────────────

interface NodeProcess {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  exitCode?: number;
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
  readonly stdin?: unknown;
}

interface NodeFs {
  readFile(path: URL | string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readdir(path: URL | string): Promise<readonly string[]>;
}

interface SchemaFiles {
  readonly CONTRACT_DIR: string;
  vocabularyFile(): URL;
  semanticsFile(): URL;
  packageFile(relativePath: string): URL;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

async function nodeFs(): Promise<NodeFs> {
  return (await importUntyped("node:fs/promises")) as NodeFs;
}

/** 契約・語彙の意味・語彙の台帳を、appspec-schema のファイルから読む（§2） */
async function loadDocumentsFromFiles(): Promise<readonly PromptDocument[]> {
  const fs = await nodeFs();
  const files = (await importUntyped("@musunest/appspec-schema/files")) as SchemaFiles;
  const contractDirectory = files.packageFile(`${files.CONTRACT_DIR}/`);
  const names = (await fs.readdir(contractDirectory)).filter((name) => !name.startsWith(".")).sort();
  const contractParts: string[] = [];
  for (const name of names) {
    contractParts.push(await fs.readFile(new URL(name, contractDirectory), "utf8"));
  }
  return [
    { name: "契約", text: contractParts.join("\n") },
    { name: "語彙の意味", text: await fs.readFile(files.semanticsFile(), "utf8") },
    { name: "語彙の台帳", text: await fs.readFile(files.vocabularyFile(), "utf8") },
  ];
}

function selfUrl(): string {
  return (import.meta as ImportMeta & { url: string }).url;
}

/** この file が入口として起動されたときだけ動く（import したときは動かさない） */
function isEntryPoint(proc: NodeProcess): boolean {
  const entry = proc.argv[1];
  if (entry === undefined) return false;
  return selfUrl().endsWith(entry);
}

/** 本物の端末（1 行を読み書きする。readline は必要になったときだけ動的に読む。§7） */
function createNodeTerminal(proc: NodeProcess): Terminal {
  let reader: { question(query: string): Promise<string>; close(): void } | undefined;
  return {
    write: (line) => proc.stdout.write(`${line}\n`),
    readLine: async () => {
      if (reader === undefined) {
        const readline = (await importUntyped("node:readline/promises")) as {
          createInterface(options: { input: unknown; output: unknown }): {
            question(query: string): Promise<string>;
            close(): void;
          };
        };
        reader = readline.createInterface({ input: proc.stdin, output: proc.stdout });
      }
      try {
        return await reader.question("");
      } catch {
        return undefined;
      }
    },
  };
}

/** 手元から流す入口（`node dist/cli.js -- <依頼文> --out <ディレクトリ>`） */
export async function main(): Promise<void> {
  const proc = (globalThis as unknown as { process?: NodeProcess }).process;
  if (proc === undefined || !isEntryPoint(proc)) return;
  const fs = await nodeFs();
  const code = await runCli({
    argv: proc.argv.slice(2),
    env: proc.env,
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, text) => fs.writeFile(path, text, "utf8"),
    makeDirectory: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
    loadDocuments: loadDocumentsFromFiles,
    makeClient: ({ apiKey, model, effort }) => createOpenAiLlmClient({ apiKey, model, effort }),
    terminal: createNodeTerminal(proc),
    log: (line) => proc.stdout.write(`${line}\n`),
    logError: (line) => proc.stderr.write(`${line}\n`),
  });
  proc.exitCode = code;
}

void main();
