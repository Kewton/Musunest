// 入口（CLI）の unit テスト（Issue #97 の受入条件のうち、入口に閉じる分）。
//
//   1. 正例の終了コードは 0、負例は非 0。**ライブラリの結果と一致する**
//   2. 使い方の誤り・読めない原本も、落ちずに終了コードで返す
//   3. 不正な入力でも未捕捉例外や無限ループにならない（子プロセスで実測する）
//   4. リポジトリの直下から、`pnpm --filter @musunest/spec-engine spec:check -- <原本>` で呼べる
//
// 1〜3 は本物の子プロセスで測る（`runCli` を直接呼ぶだけでは、process を落とす経路を見逃す）。
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { negativeSpecFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import { checkSpec } from "./check.js";
import {
  EXIT_CODES,
  formatDiagnosticLine,
  resolveSpecPath,
  runCli,
  specPathCandidates,
  type CliIo,
} from "./cli.js";

// tsconfig の types は workers-types と node の両方を読み、**グローバルの URL の型が食い違う**
// （workers-types の URL を node:fs に渡せない）。このファイルは Node（vitest）で動くので、
// 使う関数の形だけをここで宣言する（appspec-schema・data-api のテストと同じやり方）。
interface NodeApis {
  mkdtempSync(prefix: string): string;
  readFileSync(path: string, encoding: "utf8"): string;
  rmSync(path: string, options: { recursive: true; force: true }): void;
  tmpdir(): string;
  writeFileSync(path: string, text: string): void;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

async function loadNodeApis(): Promise<NodeApis> {
  const [fs, os] = await Promise.all([importUntyped("node:fs"), importUntyped("node:os")]);
  return {
    mkdtempSync: fs.mkdtempSync,
    readFileSync: fs.readFileSync,
    rmSync: fs.rmSync,
    tmpdir: os.tmpdir,
    writeFileSync: fs.writeFileSync,
  };
}

const node = await loadNodeApis();

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url).href);
const CLI_FILE = fileURLToPath(new URL("./cli.ts", import.meta.url).href);
const TSX_FILE = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

/** 見本（正例）と負例の本文。期待値はライブラリ（checkSpec）から取る */
const samplePath = fileURLToPath(sampleSpecFile("expense-log").href);
const negativePath = fileURLToPath(negativeSpecFile("string-in-arithmetic").href);
const negativeCyclePath = fileURLToPath(negativeSpecFile("computed-cycle").href);

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** 入出力を差し替えて runCli を回す（プロセスを起こさない経路のテスト） */
function callCli(argv: readonly string[], files: Readonly<Record<string, string>> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { code: runCli(argv, io), out: out.join(""), err: err.join("") };
}

/** 本物の子プロセスで CLI を回す */
function spawnCli(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TSX_FILE, CLI_FILE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** リポジトリの直下から、README に書いたとおりの呼び方をする */
function spawnPackageScript(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("pnpm", ["--filter", "@musunest/spec-engine", "spec:check", "--", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

const DIAGNOSTIC_LINE = /^(.*):(\d+):(\d+): ([A-Z0-9_]+): (.+)$/;

/** 出力した診断の行を、[コード, 行, 列, 説明] にする */
const parseLines = (output: string): readonly (readonly [string, string, string, string])[] =>
  output
    .split("\n")
    .flatMap((line) => {
      const match = DIAGNOSTIC_LINE.exec(line);
      return match === null ? [] : [[match[4] ?? "", match[2] ?? "", match[3] ?? "", match[5] ?? ""] as const];
    });

const codesOfOutput = (output: string): readonly string[] =>
  [...new Set(parseLines(output).map((line) => line[0]))].sort();

/** 子プロセスが落ちていないこと（未捕捉例外・無限ループが無いこと）を確かめる */
const expectAlive = (result: SpawnSyncReturns<string>): void => {
  expect(result.error, String(result.error)).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).not.toContain("    at ");
  expect(result.stderr).not.toContain("Unhandled");
};

describe("runCli（入出力を差し替えて）", () => {
  it("診断が無ければ 0 で、何も出力しない", () => {
    const result = callCli(["--", samplePath], { [samplePath]: node.readFileSync(samplePath, "utf8") });
    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.out).toBe("");
    expect(result.err).toBe("");
  });

  it("診断があれば 1 で、位置つきで出す（負例 computed-cycle）", () => {
    const text = node.readFileSync(negativeCyclePath, "utf8");
    const result = callCli([negativeCyclePath], { [negativeCyclePath]: text });
    expect(result.code).toBe(EXIT_CODES.diagnostics);
    expect(codesOfOutput(result.err)).toEqual(["LOGIC_COMPUTED_CYCLE"]);
    // 出す形は README のとおり（ファイル:行:列: コード: 説明）
    const [first] = parseLines(result.err);
    expect(first).toBeDefined();
    expect(Number(first?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(first?.[2])).toBeGreaterThanOrEqual(1);
    expect(first?.[3]).not.toBe("");
  });

  it("診断の内容は、ライブラリの結果と一致する（見本と負例 24 件）", () => {
    for (const file of [samplePath, negativePath, negativeCyclePath]) {
      const text = node.readFileSync(file, "utf8");
      const library = checkSpec(text);
      const result = callCli([file], { [file]: text });
      expect(result.code, file).toBe(library.ok ? EXIT_CODES.ok : EXIT_CODES.diagnostics);
      expect(codesOfOutput(result.err), file).toEqual(
        [...new Set(library.diagnostics.map((diagnostic) => diagnostic.code))].sort(),
      );
      // 件数も一致する（同じ誤りを 2 回出していない）
      expect(parseLines(result.err).length, file).toBe(library.diagnostics.length);
    }
  });

  it("使い方の誤りは 2（原本のパスが無い・2 つ以上・`--help` は 0）", () => {
    const none = callCli([]);
    expect(none.code).toBe(EXIT_CODES.usage);
    expect(none.err).toContain("使い方");
    const tooMany = callCli(["a.yaml", "b.yaml"]);
    expect(tooMany.code).toBe(EXIT_CODES.usage);
    expect(tooMany.err).toContain("1 つだけ");
    for (const flag of ["-h", "--help"]) {
      const help = callCli([flag]);
      expect(help.code, flag).toBe(EXIT_CODES.ok);
      expect(help.out).toContain("使い方");
    }
  });

  it("読めない原本は 3（未捕捉の例外にしない）", () => {
    const result = callCli(["nope.yaml"]);
    expect(result.code).toBe(EXIT_CODES.unreadable);
    expect(result.err).toContain("nope.yaml");
  });

  it("読み取りが投げる例外も、終了コードにする（例外のまま外へ出さない）", () => {
    const result = callCli(["locked.yaml"], {});
    expect(result.code).toBe(EXIT_CODES.unreadable);
  });

  it("出力の形は formatDiagnosticLine と一致する", () => {
    const text = node.readFileSync(negativePath, "utf8");
    const diagnostics = checkSpec(text).diagnostics;
    const result = callCli([negativePath], { [negativePath]: text });
    expect(result.err.trim()).toBe(
      diagnostics.map((diagnostic) => formatDiagnosticLine(negativePath, diagnostic)).join("\n"),
    );
  });
});

describe("本物の CLI（子プロセス）", () => {
  it("正例は終了コード 0 で、何も出力しない", () => {
    const result = spawnCli(["packages/appspec-schema/samples/expense-log/app.spec.yaml"]);
    expectAlive(result);
    expect(result.status).toBe(EXIT_CODES.ok);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }, 60_000);

  it("負例は非 0 で、ライブラリと同じ誤りコードを出す", () => {
    const result = spawnCli([
      "packages/appspec-schema/samples/negatives/string-in-arithmetic.app.spec.yaml",
    ]);
    expectAlive(result);
    expect(result.status).toBe(EXIT_CODES.diagnostics);
    const library = checkSpec(node.readFileSync(negativePath, "utf8"));
    expect(codesOfOutput(result.stderr)).toEqual(
      [...new Set(library.diagnostics.map((diagnostic) => diagnostic.code))].sort(),
    );
  }, 60_000);

  it("不正な YAML も診断として返す（落ちない）", () => {
    // 一時ファイルに書いて渡す（リポジトリの中に壊れた宣言を残さない）
    const directory = node.mkdtempSync(join(node.tmpdir(), "spec-engine-cli-"));
    const path = join(directory, "broken.app.spec.yaml");
    node.writeFileSync(path, "entities:\n\t- name: expense\n");
    try {
      const result = spawnCli([path]);
      expectAlive(result);
      expect(result.status).toBe(EXIT_CODES.diagnostics);
      expect(codesOfOutput(result.stderr)).toEqual(["SHAPE_YAML_INVALID"]);
    } finally {
      node.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("読めない原本は 3、使い方の誤りは 2", () => {
    const missing = spawnCli(["does-not-exist.app.spec.yaml"]);
    expectAlive(missing);
    expect(missing.status).toBe(EXIT_CODES.unreadable);
    const usage = spawnCli([]);
    expectAlive(usage);
    expect(usage.status).toBe(EXIT_CODES.usage);
  }, 60_000);

  it("見本の式の上限を超えると、その診断を出す（深さ 9）", () => {
    const directory = node.mkdtempSync(join(node.tmpdir(), "spec-engine-cli-limit-"));
    const path = join(directory, "deep.app.spec.yaml");
    // 深さ 9 の入れ子（上限は 8）
    const expression = "min(min(min(min(min(min(min(min(1, 1), 1), 1), 1), 1), 1), 1), 1)";
    const text = node.readFileSync(samplePath, "utf8").replace(
      "expression: amount - min(discount, amount)",
      `expression: ${expression}`,
    );
    node.writeFileSync(path, text);
    try {
      const result = spawnCli([path]);
      expectAlive(result);
      expect(result.status).toBe(EXIT_CODES.diagnostics);
      expect(codesOfOutput(result.stderr)).toEqual(["LOGIC_EXPRESSION_DEPTH_EXCEEDED"]);
    } finally {
      node.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("リポジトリの直下からの呼び出し（README の入口）", () => {
  it("`pnpm --filter @musunest/spec-engine spec:check -- <原本>` で正例は 0、負例は非 0", () => {
    const sample = spawnPackageScript(["packages/appspec-schema/samples/expense-log/app.spec.yaml"]);
    expectAlive(sample);
    expect(sample.status, sample.stderr).toBe(EXIT_CODES.ok);

    const negative = spawnPackageScript([
      "packages/appspec-schema/samples/negatives/computed-cycle.app.spec.yaml",
    ]);
    expectAlive(negative);
    expect(negative.status).toBe(EXIT_CODES.diagnostics);
    // pnpm の見出しが混ざるので、診断の行だけを数える
    expect(codesOfOutput(negative.stderr)).toEqual(["LOGIC_COMPUTED_CYCLE"]);
  }, 120_000);
});

/** リポジトリの直下だけが workspace である（`pnpm-workspace.yaml` がある） */
const workspaceAt = (root: string) => (path: string) => path === join(root, "pnpm-workspace.yaml");
/** 走っているディレクトリにある原本 */
const inPackage = (path: string): boolean => path === "/repo/packages/spec-engine/src/x.yaml";
/** リポジトリの直下にある原本 */
const inRoot = (path: string): boolean => path === "/repo/pnpm-workspace.yaml" || path === "/repo/app.yaml";

describe("原本のパスの解決", () => {
  it("絶対パスはそのまま使う", () => {
    expect(specPathCandidates("/tmp/a.yaml", "/repo/packages/spec-engine", () => false)).toEqual(["/tmp/a.yaml"]);
  });

  it("相対パスは、走っているディレクトリとリポジトリの直下の順に見る", () => {
    expect(
      specPathCandidates("packages/spec-engine/pkg.yaml", "/repo/packages/spec-engine", workspaceAt("/repo")),
    ).toEqual([
      "/repo/packages/spec-engine/packages/spec-engine/pkg.yaml",
      "/repo/packages/spec-engine/pkg.yaml",
    ]);
  });

  it("pnpm workspace の目印が無ければ、走っているディレクトリだけで解決する", () => {
    expect(specPathCandidates("a.yaml", "/tmp/here", () => false)).toEqual(["/tmp/here/a.yaml"]);
  });

  it("見つかった最初の候補を返す。無ければ null（呼ぶ側が読めなかったと報告する）", () => {
    expect(resolveSpecPath("src/x.yaml", { cwd: "/repo/packages/spec-engine", exists: inPackage })).toBe(
      "/repo/packages/spec-engine/src/x.yaml",
    );
    // 走っているディレクトリに無ければ、リポジトリの直下を基準にした候補を使う
    expect(resolveSpecPath("app.yaml", { cwd: "/repo/packages/spec-engine", exists: inRoot })).toBe(
      "/repo/app.yaml",
    );
    expect(resolveSpecPath("nope.yaml", { cwd: "/repo/packages/spec-engine", exists: () => false })).toBeNull();
  });
});
