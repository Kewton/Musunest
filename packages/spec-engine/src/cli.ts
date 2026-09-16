// 宣言（app.spec.yaml）の静的チェックの入口。**中身は checkSpec（src/check.ts）で、ここは薄い。**
//
//   pnpm --filter @musunest/spec-engine spec:check -- samples/expense-log/app.spec.yaml
//
// 終了コード（README「入口」）：
//   0  診断なし
//   1  診断あり（宣言が誤っている）
//   2  使い方の誤り（原本のパスを 1 つだけ渡す）
//   3  原本を読めない（パスが無い・ディレクトリ・権限が無い）
//
// **ライブラリと同じ判定を使う。** ここで宣言を読み直したり、検査を足したりしない
// （CLI とライブラリで診断が食い違うと、CI と publish の判定がずれる）。publish も評価もしない。

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { checkSpec } from "./check.js";

/** pnpm workspace の目印。相対パスの 2 つ目の候補（リポジトリの直下）を探すのに使う */
export const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** 終了コード。README の表と同じ並び */
export const EXIT_CODES = {
  ok: 0,
  diagnostics: 1,
  usage: 2,
  unreadable: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** 診断 1 行の形（エディタと grep でたどれる形。`ファイル:行:列: コード: 説明`） */
export function formatDiagnosticLine(
  path: string,
  diagnostic: { readonly line: number; readonly column: number; readonly code: string; readonly message: string },
): string {
  return `${path}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.code}: ${diagnostic.message}`;
}

export const USAGE = [
  "使い方: spec:check <app.spec.yaml>",
  "",
  "  宣言（app.spec.yaml）を実行せずに検査する。誤りがあれば、位置つきで出す。",
  "  リポジトリの直下からは次のように呼ぶ。",
  "",
  "    pnpm --filter @musunest/spec-engine spec:check -- <app.spec.yaml>",
  "",
  "終了コード: 0 診断なし / 1 診断あり / 2 使い方の誤り / 3 原本を読めない",
].join("\n");

/** CLI が使う入出力。テストから差し替えられるように、ここだけを外から渡す */
export interface CliIo {
  readonly readFile: (path: string) => string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** 走っているディレクトリから上へたどって、リポジトリ（pnpm workspace）の直下を探す */
export function findWorkspaceRoot(cwd: string, exists: (path: string) => boolean): string | null {
  let directory = cwd;
  for (;;) {
    if (exists(join(directory, WORKSPACE_FILE))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * 原本のパスの候補を、試す順に返す。
 *
 * **pnpm は script を package のディレクトリで走らせる**（`process.cwd()` は `packages/spec-engine`）。
 * だから相対パスは、まず**走っているディレクトリ**を基準に見て、次に**リポジトリの直下**を基準に見る。
 * リポジトリの直下から `pnpm --filter @musunest/spec-engine spec:check -- packages/.../app.spec.yaml`
 * と呼べるようにするためである（README「入口」）。絶対パスはそのまま使う。
 */
export function specPathCandidates(
  path: string,
  cwd: string,
  exists: (path: string) => boolean,
): readonly string[] {
  if (isAbsolute(path)) return [path];
  const candidates = [resolve(cwd, path)];
  const root = findWorkspaceRoot(cwd, exists);
  if (root !== null) {
    const fromRoot = resolve(root, path);
    if (!candidates.includes(fromRoot)) candidates.push(fromRoot);
  }
  return candidates;
}

/** 原本のパスを 1 つに決める。見つからなければ null（呼ぶ側が読めなかったと報告する） */
export function resolveSpecPath(
  path: string,
  environment: { readonly cwd: string; readonly exists: (candidate: string) => boolean },
): string | null {
  const candidates = specPathCandidates(path, environment.cwd, environment.exists);
  return candidates.find((candidate) => environment.exists(candidate)) ?? null;
}

const messageOf = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown);

/**
 * 引数を読んで、検査の結果を終了コードにする。**例外を外へ出さない**
 * （読み取りの失敗も、process を落とさずに終了コードにする）。
 *
 * `pnpm --filter @musunest/spec-engine spec:check -- <原本>` の `--` は、pnpm がそのまま
 * 引数として渡す（2026-09-16 実測・pnpm 10.13.1）。だから先頭の `--` 1 つだけを読み飛ばす。
 */
export function runCli(argv: readonly string[], io: CliIo): ExitCode {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.includes("-h") || args.includes("--help")) {
    io.out(`${USAGE}\n`);
    return EXIT_CODES.ok;
  }
  if (args.length === 0) {
    io.err(`原本のパスが無い。\n${USAGE}\n`);
    return EXIT_CODES.usage;
  }
  if (args.length > 1) {
    io.err(`引数は 1 つだけ（原本のパス）。\n${USAGE}\n`);
    return EXIT_CODES.usage;
  }
  const path = args[0] ?? "";
  let source: string;
  try {
    source = io.readFile(path);
  } catch (thrown) {
    io.err(`原本を読めない: ${path}: ${messageOf(thrown)}\n`);
    return EXIT_CODES.unreadable;
  }
  const result = checkSpec(source);
  if (result.ok) return EXIT_CODES.ok;
  for (const diagnostic of result.diagnostics) {
    io.err(`${formatDiagnosticLine(path, diagnostic)}\n`);
  }
  return EXIT_CODES.diagnostics;
}

/** このファイルが入口として起動されたか（テストから import したときは走らせない） */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return (import.meta as ImportMeta & { url: string }).url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  process.exitCode = runCli(process.argv.slice(2), {
    readFile: (path) => {
      const candidates = specPathCandidates(path, process.cwd(), existsSync);
      const target = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? path;
      return readFileSync(target, "utf8");
    },
    out: (line) => {
      process.stdout.write(line);
    },
    err: (line) => {
      process.stderr.write(line);
    },
  });
}
