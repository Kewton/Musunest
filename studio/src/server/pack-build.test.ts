import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PACK_CONFIG_CODE,
  PACK_ENV_KEYS,
  PACK_ENV_KEY_NAMES,
  runPackBuild,
  type PackBuildInput,
} from "./pack-build.js";

// 台本どおりにファイル・標準出力・標準エラーを書く偽物の pack。呼ばれた名と引数を calls.jsonl に残す。
const FAKE_PACK_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = path.basename(fileURLToPath(import.meta.url), '.mjs');
const dir = process.env.FAKE_PACK_SCENARIO;
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
fs.appendFileSync(
  path.join(dir, 'calls.jsonl'),
  JSON.stringify({ name, execPath: process.execPath, argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n',
);
const step = scenario[name] ?? {};
for (const file of step.files ?? []) {
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.text);
}
if (step.stdout) process.stdout.write(step.stdout);
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.exit ?? 0);
`;

const PACK_COMMAND_NAMES = ["build", "verify-install", "run", "check-result"] as const;
const COMMANDAGENT = "/virtual/bin/commandagent";
const MUSUNEST = "/virtual/musunest";

interface RecordedCall {
  readonly name: string;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

let root: string;
let packRoot: string;
let scenarioDir: string;

const outDir = (): string => join(root, "jobs", "job-1");
const operatorRoot = (): string => join(outDir(), "operator");
const workdir = (): string => join(outDir(), "run");
const declarationPath = (): string => join(workdir(), "workspace", "artifacts", "app.spec.yaml");
const resultPath = (): string => join(workdir(), "result.json");
const summaryPath = (): string => join(outDir(), "summary.json");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "musunest-pack-build-"));
  packRoot = join(root, "pack");
  scenarioDir = join(root, "scenario");
  mkdirSync(join(packRoot, "bin"), { recursive: true });
  mkdirSync(scenarioDir, { recursive: true });
  for (const name of PACK_COMMAND_NAMES) {
    writeFileSync(join(packRoot, "bin", `${name}.mjs`), FAKE_PACK_SCRIPT);
  }
  mkdirSync(outDir(), { recursive: true });
  writeFileSync(join(outDir(), "plan-result.json"), "{}");
  writeFileSync(join(outDir(), "request.txt"), "毎日の記録を一覧で見たい。");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeScenario = (scenario: Record<string, unknown>): void => {
  writeFileSync(join(scenarioDir, "scenario.json"), JSON.stringify(scenario));
};

const calls = (): readonly RecordedCall[] => {
  const path = join(scenarioDir, "calls.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedCall);
};

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  [PACK_ENV_KEYS.root]: packRoot,
  [PACK_ENV_KEYS.node]: process.execPath,
  [PACK_ENV_KEYS.commandagent]: COMMANDAGENT,
  [PACK_ENV_KEYS.musunest]: MUSUNEST,
  FAKE_PACK_SCENARIO: scenarioDir,
  ...extra,
});

const input = (overrides: Partial<PackBuildInput> = {}): PackBuildInput => ({
  env: env(),
  outDir: outDir(),
  envelopeFile: join(outDir(), "plan-result.json"),
  requestFile: join(outDir(), "request.txt"),
  summaryFile: summaryPath(),
  ...overrides,
});

const passScenario = (cost = "0.42"): Record<string, unknown> => ({
  build: { stdout: `${JSON.stringify({ operator_root: operatorRoot() })}\n` },
  "verify-install": { stdout: "install.ok\n" },
  run: {
    stdout: `starting\n${JSON.stringify({ verdict: "internal_pass", cost: { usd_total: cost } })}\n`,
    files: [{ path: declarationPath(), text: "schema: musunest.app-spec/v1\n" }],
  },
  "check-result": {
    files: [
      {
        path: resultPath(),
        text: JSON.stringify({
          schema: "musubi-ca-pack/result/v3",
          verdict: "internal_pass",
          reason: { code: null },
          cost: { usd_total: cost },
        }),
      },
    ],
  },
});

describe("pack の Build", () => {
  it("4 つのコマンドを決めた引数で build → verify-install → run → check-result の順に起こす", async () => {
    writeScenario(passScenario());

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "finished", costUsd: 0.42 });
    const recorded = calls();
    expect(recorded.map((call) => call.name)).toEqual(["build", "verify-install", "run", "check-result"]);
    for (const call of recorded) expect(call.execPath).toBe(process.execPath);

    expect(recorded[0]?.argv).toEqual([
      "--envelope",
      join(outDir(), "plan-result.json"),
      "--source",
      join(outDir(), "request.txt"),
      "--musunest",
      MUSUNEST,
      "--out",
      operatorRoot(),
    ]);
    expect(recorded[1]?.argv).toEqual([operatorRoot()]);
    expect(recorded[2]?.argv).toEqual([
      "--operator-root",
      operatorRoot(),
      "--workdir",
      workdir(),
      "--commandagent",
      COMMANDAGENT,
    ]);
    expect(recorded[2]?.argv).not.toContain("--budget");
    expect(recorded[3]?.argv).toEqual([workdir()]);
  });

  it("internal_pass なら完了し、宣言をジョブの置き場に写し、要約を書く", async () => {
    writeScenario(passScenario());

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "finished", costUsd: 0.42 });
    expect(readFileSync(join(outDir(), "app.spec.yaml"), "utf8")).toBe("schema: musunest.app-spec/v1\n");
    expect(JSON.parse(readFileSync(summaryPath(), "utf8")) as unknown).toEqual({
      verdict: "internal_pass",
      cost: { usd_total: "0.42" },
    });
  });

  it("build の失敗はそのコードで止まり、後のコマンドを起こさない", async () => {
    writeScenario({ build: { exit: 1, stderr: "build.error args.missing-envelope\n" } });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "build-error", codes: ["args.missing-envelope"], costUsd: 0 });
    expect(calls().map((call) => call.name)).toEqual(["build"]);
  });

  it("verify-install の失敗はそのコードで止まり、run を起こさない", async () => {
    writeScenario({
      build: {},
      "verify-install": { exit: 1, stderr: "verify-install.error hash-mismatch\n" },
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "verify-install-error", codes: ["hash-mismatch"], costUsd: 0 });
    expect(calls().map((call) => call.name)).toEqual(["build", "verify-install"]);
  });

  it("run の失敗はそのコードで止まり、check-result を起こさない", async () => {
    writeScenario({
      build: {},
      "verify-install": {},
      run: { exit: 2, stderr: "run.error budget.ledger-exists\n" },
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "run-error",
      codes: ["budget.ledger-exists"],
      costUsd: 0,
    });
    expect(calls().map((call) => call.name)).toEqual(["build", "verify-install", "run"]);
  });

  it("internal_fail の台本は理由のコードで止まり、費用は result.json から読む", async () => {
    writeScenario({
      build: {},
      "verify-install": {},
      run: { stdout: `${JSON.stringify({ verdict: "internal_fail", cost: { usd_total: "0.1" } })}\n` },
      "check-result": {
        files: [
          {
            path: resultPath(),
            text: JSON.stringify({
              schema: "musubi-ca-pack/result/v3",
              verdict: "internal_fail",
              reason: { code: "stage.unsealed" },
              cost: { usd_total: "0.1" },
            }),
          },
        ],
      },
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "internal-fail",
      codes: ["stage.unsealed"],
      costUsd: 0.1,
    });
    expect(calls().map((call) => call.name)).toEqual(["build", "verify-install", "run", "check-result"]);
  });

  it("4 つの環境変数のどれかが無いと pack-config で止まり、コマンドを 1 つも起こさない", async () => {
    writeScenario(passScenario());

    for (const key of PACK_ENV_KEY_NAMES) {
      const partial = env();
      delete partial[key];

      const outcome = await runPackBuild(input({ env: partial }));

      expect(outcome).toEqual({ kind: "failed", reason: PACK_CONFIG_CODE, codes: [PACK_CONFIG_CODE], costUsd: 0 });
    }
    expect(calls()).toEqual([]);
  });

  it("result.json が無ければ、check-result の後でも完了にしない", async () => {
    writeScenario({ build: {}, "verify-install": {}, run: { stdout: "{}\n" }, "check-result": {} });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "check-result-error", codes: ["result-unreadable"], costUsd: 0 });
  });

  it.each([
    ["build", "build-error", ["build"]],
    ["verify-install", "verify-install-error", ["build", "verify-install"]],
    ["run", "run-error", ["build", "verify-install", "run"]],
    ["check-result", "check-result-error", ["build", "verify-install", "run", "check-result"]],
  ] as const)("%s は stderr の先頭行の `<名>.error <code>` を拾う", async (name, reason, called) => {
    writeScenario({
      build: name === "build" ? { exit: 1, stderr: "build.error first-code\n" } : {},
      "verify-install": name === "verify-install" ? { exit: 1, stderr: "verify-install.error first-code\n" } : {},
      run: name === "run" ? { exit: 1, stderr: "run.error first-code\n" } : {},
      "check-result": name === "check-result" ? { exit: 1, stderr: "check-result.error first-code\n" } : {},
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toMatchObject({ kind: "failed", reason, codes: ["first-code"] });
    expect(calls().map((call) => call.name)).toEqual(called);
  });

  it("stderr の 2 行目以降のコードは拾わない（先頭行だけを見る）", async () => {
    writeScenario({ build: { exit: 1, stderr: "note\nbuild.error second-code\n" } });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "build-error", codes: ["build-exit-1"], costUsd: 0 });
  });

  it("run が 0 以外なら run で止まり、check-result を起こさない（exit 1 も失敗）", async () => {
    writeScenario({ build: {}, "verify-install": {}, run: { exit: 1 } });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "run-error", codes: ["run-exit-1"], costUsd: 0 });
    expect(calls().map((call) => call.name)).toEqual(["build", "verify-install", "run"]);
  });

  it("check-result が 0 以外なら失敗し、result.json があっても完了にしない", async () => {
    writeScenario({
      build: {},
      "verify-install": {},
      run: {},
      "check-result": {
        exit: 1,
        files: [
          {
            path: resultPath(),
            text: JSON.stringify({
              schema: "musubi-ca-pack/result/v3",
              verdict: "internal_pass",
              reason: { code: null },
              cost: { usd_total: "0.1" },
            }),
          },
        ],
      },
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "check-result-error",
      codes: ["check-result-exit-1"],
      costUsd: 0,
    });
  });

  it("internal_pass でも宣言が無ければ完了にしない", async () => {
    writeScenario({
      build: {},
      "verify-install": {},
      run: { stdout: `${JSON.stringify({ verdict: "internal_pass", cost: { usd_total: "0.2" } })}\n` },
      "check-result": {
        files: [
          {
            path: resultPath(),
            text: JSON.stringify({
              schema: "musubi-ca-pack/result/v3",
              verdict: "internal_pass",
              reason: { code: null },
              cost: { usd_total: "0.2" },
            }),
          },
        ],
      },
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "declaration-error",
      codes: ["declaration-missing"],
      costUsd: 0.2,
    });
  });

  it("verdict が unknown なら理由のコードで失敗する", async () => {
    writeScenario({
      build: {},
      "verify-install": {},
      run: {},
      "check-result": {
        files: [
          {
            path: resultPath(),
            text: JSON.stringify({
              schema: "musubi-ca-pack/result/v3",
              verdict: "unknown",
              reason: { code: "evidence.unreadable" },
              cost: { usd_total: "0.1" },
            }),
          },
        ],
      },
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "unknown", codes: ["evidence.unreadable"], costUsd: 0.1 });
  });

  it("要約が無ければ空の要約を書き、完了は変えない", async () => {
    writeScenario({
      build: {},
      "verify-install": {},
      run: {
        stdout: "",
        files: [{ path: declarationPath(), text: "schema: musunest.app-spec/v1\n" }],
      },
      "check-result": {
        files: [
          {
            path: resultPath(),
            text: JSON.stringify({
              schema: "musubi-ca-pack/result/v3",
              verdict: "internal_pass",
              reason: { code: null },
              cost: { usd_total: "0.05" },
            }),
          },
        ],
      },
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "finished", costUsd: 0.05 });
    expect(readFileSync(summaryPath(), "utf8")).toBe("");
  });

  it.each(["-1", "not-a-number", ""])("費用が %s なら 0 として扱う（Plan の費用に足さない）", async (raw) => {
    writeScenario({
      build: {},
      "verify-install": {},
      run: {
        stdout: `${JSON.stringify({ verdict: "internal_pass" })}\n`,
        files: [{ path: declarationPath(), text: "schema: musunest.app-spec/v1\n" }],
      },
      "check-result": {
        files: [
          {
            path: resultPath(),
            text: JSON.stringify({
              schema: "musubi-ca-pack/result/v3",
              verdict: "internal_pass",
              reason: { code: null },
              cost: { usd_total: raw },
            }),
          },
        ],
      },
    });

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "finished", costUsd: 0 });
  });
});
