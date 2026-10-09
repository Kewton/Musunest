// 手元の入口（02-architecture.md §3.2）。
//
// `factory:run -- <依頼文のファイル> --out <ディレクトリ>` で、手元から 1 回の生成を流す。出力は納品物の
// ディレクトリである。**この入口だけが環境変数とファイルを扱う**——鍵は環境変数 `OPENAI_API_KEY` から読み、
// 文書（契約・語彙の意味・語彙の台帳）はファイルから読む。単価はここで渡す（日付付きの既定値）。
//
// **ライブラリ（run.ts・bundle.ts・record.ts・段）は、環境変数もファイルも Node 固有の API も持たない。**
// ここが外側との境目である。鍵が無ければ、API を呼ばずに使い方の誤りで終わる。
//
// `node:fs` は**動的**に読む（Worker が根（index.ts）から import しても、この経路は呼ばれない限り動かない。
// appspec-schema の contract.ts と同じやり方）。
import type { TokenRates } from "./budget.js";
import { bundleFiles } from "./bundle.js";
import type { AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import { createOpenAiLlmClient, DEFAULT_OPENAI_MODEL } from "./openai.js";
import { runGeneration } from "./run.js";
import type { PromptDocument } from "./stages/prompt.js";

/** 工場の識別（要約の `builder`。S-5） */
export const BUILDER = "musunest-factory" as const;
/** プロンプトの版（§3・S-5） */
export const PROMPT_VERSION = "v1" as const;
/** 契約の版（`03-evaluation.md` §1 が v0.2 に固定する） */
export const CONTRACT_VERSION = "v0.2" as const;
/** spec-engine の版（§4。改名は U-B） */
export const SPEC_ENGINE_VERSION = "0.0.0" as const;
/** factory の版（§4。改名は U-B） */
export const FACTORY_VERSION = "0.0.0" as const;

/** 既定の effort（§2「品質優先で high から始める」） */
export const DEFAULT_EFFORT = "high" as const;
/** 既定の費用の上限（USD。C-1） */
export const DEFAULT_BUDGET_USD = 0.1 as const;
/** 既定の締切（ミリ秒。T-1「ジョブ全体で 5 分」） */
export const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;
/** 鍵を読む環境変数の名前 */
export const API_KEY_ENV = "OPENAI_API_KEY" as const;

/** 単価（USD / 1 トークン）。2026-10-09 の公開値（入力 $0.10・キャッシュ $0.01・出力 $0.50／100 万） */
export const DEFAULT_RATES: TokenRates = {
  inputPerToken: 0.1 / 1_000_000,
  cachedInputPerToken: 0.01 / 1_000_000,
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
  "使い方: factory:run -- <依頼文のファイル> --out <ディレクトリ> [--model <名前>] [--effort <値>]";

/** 手元の入口が受け取る引数 */
export interface CliArguments {
  readonly requestFile: string;
  readonly outDir: string;
  readonly model: string;
  readonly effort: string;
}

/** 引数を読む。誤りは `error` に人の読む文を入れて返す（例外にしない） */
export function parseCliArguments(argv: readonly string[]): CliArguments | { readonly error: string } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let requestFile: string | undefined;
  let outDir: string | undefined;
  let model: string = DEFAULT_OPENAI_MODEL;
  let effort: string = DEFAULT_EFFORT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
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
    if (arg.startsWith("--")) return { error: `知らない選択肢: ${arg}` };
    if (requestFile === undefined) {
      requestFile = arg;
      continue;
    }
    return { error: `余分な引数: ${arg}` };
  }
  if (requestFile === undefined) return { error: "依頼文のファイルを指定してください" };
  if (outDir === undefined) return { error: "--out で出力のディレクトリを指定してください" };
  return { requestFile, outDir, model, effort };
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
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly rates?: TokenRates;
  readonly budgetUsd?: number;
  readonly deadlineMs?: number;
  readonly limits?: AgentLimits;
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
 * 1 回の生成を流し、納品物をディレクトリに書く（§3.2）。
 *
 * 鍵が無ければ **`makeClient` を呼ばずに**使い方の誤りで終わる（API を呼ばない）。納品物を書けたら
 * `EXIT_OK`、生成が失敗したら `EXIT_RUN_FAILED` を返す。要約は最後の行に 1 行の JSON で出す。
 */
export async function runCli(deps: CliDeps): Promise<number> {
  const log = deps.log ?? ((): void => {});
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
  const now = deps.now ?? ((): number => Date.now());
  const run = await runGeneration({
    source,
    documents,
    client,
    budgetUsd: deps.budgetUsd ?? DEFAULT_BUDGET_USD,
    rates: deps.rates ?? DEFAULT_RATES,
    now,
    deadline: now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS),
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    runId: `local-${String(now())}`,
    storageUnit: parsed.outDir,
    builder: BUILDER,
    model: parsed.model,
    effort: parsed.effort,
    promptVersion: PROMPT_VERSION,
    contractVersion: CONTRACT_VERSION,
    specEngineVersion: SPEC_ENGINE_VERSION,
    factoryVersion: FACTORY_VERSION,
  });

  if (run.bundle !== null) {
    await deps.makeDirectory(parsed.outDir);
    for (const file of bundleFiles(run.bundle)) {
      const parent = parentOf(file.path);
      if (parent !== "") await deps.makeDirectory(joinPath(parsed.outDir, parent));
      await deps.writeFile(joinPath(parsed.outDir, file.path), file.text);
    }
  }
  log(JSON.stringify(run.summary));
  return run.bundle === null ? EXIT_RUN_FAILED : EXIT_OK;
}

// ── Node 側（ファイルと環境変数を扱う。動的に読む）────────────────────

interface NodeProcess {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  exitCode?: number;
  readonly stdout: { write(text: string): void };
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
    log: (line) => proc.stdout.write(`${line}\n`),
  });
  proc.exitCode = code;
}

void main();
