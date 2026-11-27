// 確定した Plan の後の Build を、工場の代わりに musubi-ca-pack で走らせる（Issue #989）。
//
// pack の 4 つの CLI（bin/build.mjs・bin/verify-install.mjs・bin/run.mjs・bin/check-result.mjs）を、
// pack の pin の Node で子プロセスとして順に起こす。pack と CommandAgent のコードは持ち込まず、
// 呼び方と出力のファイルの読み方だけを持つ（CLAUDE.md の例外の 1 本。#987）。
//
// 4 つのコマンドは、どれかが失敗したらその理由のコード（stderr の 1 行目）で止まり、後を起こさない。
// 費用と判定は check-result の result.json（`musubi-ca-pack/result/*`）から読み、宣言は run の
// workspace の app.spec.yaml をジョブの置き場へ写す。要約は run の標準出力の最後の JSON を書く。
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Build を pack に替える値（`STUDIO_BUILD_ARM`） */
export const PACK_ARM = "ca-pack" as const;

/** pack の場所を受ける環境変数 */
export const PACK_ENV_KEYS = {
  root: "MUSUBI_PACK_ROOT",
  node: "MUSUBI_PACK_NODE",
  commandagent: "MUSUBI_PACK_COMMANDAGENT",
  musunest: "MUSUBI_PACK_MUSUNEST",
} as const;
export const PACK_ENV_KEY_NAMES = [
  PACK_ENV_KEYS.root,
  PACK_ENV_KEYS.node,
  PACK_ENV_KEYS.commandagent,
  PACK_ENV_KEYS.musunest,
] as const;

/** 4 つのコマンドの実体 */
export const PACK_COMMANDS = {
  build: "bin/build.mjs",
  verifyInstall: "bin/verify-install.mjs",
  run: "bin/run.mjs",
  checkResult: "bin/check-result.mjs",
} as const;

/** ジョブの置き場の下の operator root */
export const PACK_OPERATOR_DIR = "operator";
/** ジョブの置き場の下の run の作業場 */
export const PACK_RUN_DIR = "run";
/** ジョブの置き場に写す宣言の名前 */
export const PACK_DECLARATION_FILE = "app.spec.yaml";
/** run の作業場に check-result が書く結果 */
export const PACK_RESULT_FILE = "result.json";
/** 設定が欠けたときの理由のコード */
export const PACK_CONFIG_CODE = "pack-config";

/** pack の場所（4 つとも揃っているときだけ） */
export interface PackConfig {
  readonly packRoot: string;
  readonly node: string;
  readonly commandagent: string;
  readonly musunest: string;
}

export interface PackCommandOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface PackCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** コマンドを 1 つ起こす（試験は偽物を差し込める） */
export type PackExec = (
  command: string,
  args: readonly string[],
  options: PackCommandOptions,
) => Promise<PackCommandResult>;

export interface PackBuildInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly outDir: string;
  readonly envelopeFile: string;
  readonly requestFile: string;
  readonly summaryFile: string;
}

export type PackBuildOutcome =
  | { readonly kind: "finished"; readonly costUsd: number }
  | { readonly kind: "failed"; readonly reason: string; readonly codes: readonly string[]; readonly costUsd: number };

/** 1 行が写像（object）の JSON か */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 4 つの環境変数が揃っていれば pack の場所を返す（空文字は無いとみなす） */
export function packConfigOf(env: Readonly<Record<string, string | undefined>>): PackConfig | undefined {
  const packRoot = env[PACK_ENV_KEYS.root];
  const node = env[PACK_ENV_KEYS.node];
  const commandagent = env[PACK_ENV_KEYS.commandagent];
  const musunest = env[PACK_ENV_KEYS.musunest];
  if (!packRoot || !node || !commandagent || !musunest) return undefined;
  return { packRoot, node, commandagent, musunest };
}

/** 子へ渡す環境（定義されている値だけ） */
function stringEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** stderr の 1 行目から理由のコードを読む（読めなければ終了コードで代える） */
function codeFrom(stderr: string, pattern: RegExp, command: string, exitCode: number): string {
  const match = pattern.exec(stderr);
  return match?.[1] ?? `${command}-exit-${String(exitCode)}`;
}

/** result.json の費用（`cost.usd_total`）。読めなければ 0 */
function costOf(result: Record<string, unknown>): number {
  const cost = result["cost"];
  if (!isRecord(cost)) return 0;
  const raw = cost["usd_total"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** result.json の判定（知らない値・無い欄は `unknown`） */
function verdictOf(result: Record<string, unknown>): "internal_pass" | "internal_fail" | "unknown" {
  const raw = result["verdict"];
  return raw === "internal_pass" || raw === "internal_fail" ? raw : "unknown";
}

/** result.json の理由のコード（`reason.code`） */
function reasonCodeOf(result: Record<string, unknown>): string | undefined {
  const reason = result["reason"];
  if (!isRecord(reason)) return undefined;
  const code = reason["code"];
  return typeof code === "string" ? code : undefined;
}

/** 標準出力の最後の JSON（写像）を 1 行にしたもの。読めなければ undefined */
function lastJsonOf(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  try {
    const whole: unknown = JSON.parse(trimmed);
    if (isRecord(whole)) return JSON.stringify(whole);
  } catch {
    // 複数行の出力。最後の JSON の行を探す
  }
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) return JSON.stringify(value);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** result.json を読む（読めなければ undefined） */
async function readResult(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 本物のコマンド（Node の `spawn`） */
function spawnPackCommand(
  command: string,
  args: readonly string[],
  options: PackCommandOptions,
): Promise<PackCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number, stdout: string, stderr: string): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(127, "", "");
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", () => finish(127, Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8")));
    child.on("close", (code) =>
      finish(code ?? 127, Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8")),
    );
  });
}

/**
 * pack の 4 つのコマンドを順に起こし、結果を返す。設定が欠ければ 1 つも起こさない。
 * **後ろのコマンドは、前のコマンドが通ったときだけ起こす。**
 */
export async function runPackBuild(
  input: PackBuildInput,
  exec: PackExec = spawnPackCommand,
): Promise<PackBuildOutcome> {
  const config = packConfigOf(input.env);
  if (config === undefined) {
    return { kind: "failed", reason: PACK_CONFIG_CODE, codes: [PACK_CONFIG_CODE], costUsd: 0 };
  }

  const operatorRoot = join(input.outDir, PACK_OPERATOR_DIR);
  const workdir = join(input.outDir, PACK_RUN_DIR);
  const options: PackCommandOptions = { cwd: input.outDir, env: stringEnv(input.env) };

  const build = await exec(
    config.node,
    [
      join(config.packRoot, PACK_COMMANDS.build),
      "--envelope",
      input.envelopeFile,
      "--source",
      input.requestFile,
      "--musunest",
      config.musunest,
      "--out",
      operatorRoot,
    ],
    options,
  );
  if (build.code !== 0) {
    return {
      kind: "failed",
      reason: "build-error",
      codes: [codeFrom(build.stderr, /^build\.error (\S+)/m, "build", build.code)],
      costUsd: 0,
    };
  }

  const install = await exec(
    config.node,
    [join(config.packRoot, PACK_COMMANDS.verifyInstall), operatorRoot],
    options,
  );
  if (install.code !== 0) {
    return {
      kind: "failed",
      reason: "verify-install-error",
      codes: [codeFrom(install.stderr, /^install\.([a-z0-9.-]+)/m, "verify-install", install.code)],
      costUsd: 0,
    };
  }

  // 既定の wallet で走らせる（`--budget` は付けない）。run 自身も check-result を呼ぶが、
  // 記録はそのあとの check-result で書き直させる（出力の読み方を 1 か所に寄せる）。
  const run = await exec(
    config.node,
    [
      join(config.packRoot, PACK_COMMANDS.run),
      "--operator-root",
      operatorRoot,
      "--workdir",
      workdir,
      "--commandagent",
      config.commandagent,
    ],
    options,
  );
  // run の 0 は完了、1 は check-result の判定（internal_fail・unknown）。2 以上は run の拒否。
  if (run.code !== 0 && run.code !== 1) {
    return {
      kind: "failed",
      reason: "run-error",
      codes: [codeFrom(run.stderr, /^run\.error (\S+)/m, "run", run.code)],
      costUsd: 0,
    };
  }

  const summary = lastJsonOf(run.stdout);
  await writeFile(input.summaryFile, summary === undefined ? "" : `${summary}\n`);

  const check = await exec(
    config.node,
    [join(config.packRoot, PACK_COMMANDS.checkResult), workdir],
    options,
  );
  if (check.code !== 0 && check.code !== 1) {
    return {
      kind: "failed",
      reason: "check-result-error",
      codes: [codeFrom(check.stderr, /^result\.([a-z0-9.-]+)/m, "check-result", check.code)],
      costUsd: 0,
    };
  }

  const result = await readResult(join(workdir, PACK_RESULT_FILE));
  if (result === undefined) {
    return { kind: "failed", reason: "check-result-error", codes: ["result-unreadable"], costUsd: 0 };
  }

  const costUsd = costOf(result);
  const verdict = verdictOf(result);
  if (verdict !== "internal_pass") {
    const code = reasonCodeOf(result) ?? verdict;
    return {
      kind: "failed",
      reason: verdict === "internal_fail" ? "internal-fail" : "unknown",
      codes: [code],
      costUsd,
    };
  }

  try {
    await mkdir(input.outDir, { recursive: true });
    await copyFile(join(workdir, "workspace", "artifacts", PACK_DECLARATION_FILE), join(input.outDir, PACK_DECLARATION_FILE));
  } catch {
    return { kind: "failed", reason: "declaration-error", codes: ["declaration-missing"], costUsd };
  }

  return { kind: "finished", costUsd };
}
