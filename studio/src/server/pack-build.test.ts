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
const RESULT_V3 = "musubi-ca-pack/result/v3";

interface RecordedCall {
  readonly name: string;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

interface ResultFields {
  readonly schema?: string;
  readonly verdict?: string;
  readonly reasonCode?: string | null;
  readonly cost?: unknown;
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

const resultText = (fields: ResultFields): string => {
  const value: Record<string, unknown> = {
    reason: { code: fields.reasonCode ?? null },
    cost: { usd_total: fields.cost ?? "0.42" },
  };
  if (fields.schema !== undefined) value["schema"] = fields.schema;
  if (fields.verdict !== undefined) value["verdict"] = fields.verdict;
  return JSON.stringify(value);
};

const resultFile = (fields: ResultFields): Record<string, unknown> => ({
  files: [{ path: resultPath(), text: resultText(fields) }],
});

const declarationFile = (): Record<string, unknown> => ({
  files: [{ path: declarationPath(), text: "schema: musunest.app-spec/v1\n" }],
});

const scenario = (parts: {
  readonly build?: Record<string, unknown>;
  readonly install?: Record<string, unknown>;
  readonly run?: Record<string, unknown>;
  readonly check?: Record<string, unknown>;
}): Record<string, unknown> => ({
  build: parts.build ?? {},
  "verify-install": parts.install ?? {},
  run: parts.run ?? {},
  "check-result": parts.check ?? {},
});

const passScenario = (cost = "0.42"): Record<string, unknown> =>
  scenario({
    build: { stdout: `${JSON.stringify({ operator_root: operatorRoot() })}\n` },
    install: { stdout: "install.ok\n" },
    run: {
      stdout: `starting\n${JSON.stringify({ verdict: "internal_pass", cost: { usd_total: cost } })}\n`,
      ...declarationFile(),
    },
    check: resultFile({ schema: RESULT_V3, verdict: "internal_pass", cost }),
  });

describe("pack の Build", () => {
  it("「順」4 つのコマンドを決めた引数で build → verify-install → run → check-result の順に起こす", async () => {
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

  it("「合格」internal_pass なら完了し、宣言をジョブの置き場に写し、要約を書く", async () => {
    writeScenario(passScenario());

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "finished", costUsd: 0.42 });
    expect(readFileSync(join(outDir(), "app.spec.yaml"), "utf8")).toBe("schema: musunest.app-spec/v1\n");
    expect(JSON.parse(readFileSync(summaryPath(), "utf8")) as unknown).toEqual({
      verdict: "internal_pass",
      cost: { usd_total: "0.42" },
    });
  });

  it("「失敗」build は build.error のコードで止まり、後のコマンドを起こさない", async () => {
    writeScenario(scenario({ build: { exit: 1, stderr: "build.error args.missing-envelope\n" } }));

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "build-error", codes: ["args.missing-envelope"], costUsd: 0 });
    expect(calls().map((call) => call.name)).toEqual(["build"]);
  });

  it("「失敗」verify-install は install.<code> のコードで止まり、run を起こさない", async () => {
    writeScenario(
      scenario({ install: { exit: 1, stderr: "install.hash-mismatch operator-index.json\n" } }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "verify-install-error", codes: ["hash-mismatch"], costUsd: 0 });
    expect(calls().map((call) => call.name)).toEqual(["build", "verify-install"]);
  });

  it("「失敗」run の終了 2 は run.error のコードで止まり、check-result を起こさない", async () => {
    writeScenario(scenario({ run: { exit: 2, stderr: "run.error key.missing\n" } }));

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "run-error", codes: ["key.missing"], costUsd: 0 });
    expect(calls().map((call) => call.name)).toEqual(["build", "verify-install", "run"]);
  });

  it("「内部の不合格」run の終了 1 から check-result の終了 1 へ進み、reason.code で失敗して費用を足す", async () => {
    writeScenario(
      scenario({
        run: {
          exit: 1,
          stdout: `starting\n${JSON.stringify({ verdict: "internal_fail", cost: { usd_total: "0.1" } })}\n`,
        },
        check: {
          exit: 1,
          ...resultFile({
            schema: RESULT_V3,
            verdict: "internal_fail",
            reasonCode: "stage.not-sealed",
            cost: "0.1",
          }),
        },
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "internal-fail",
      codes: ["stage.not-sealed"],
      costUsd: 0.1,
    });
    expect(calls().map((call) => call.name)).toEqual(["build", "verify-install", "run", "check-result"]);
    expect(JSON.parse(readFileSync(summaryPath(), "utf8")) as unknown).toEqual({
      verdict: "internal_fail",
      cost: { usd_total: "0.1" },
    });
  });

  it.each(["v3", "v4", "v5"])("「結果の版」schema が %s なら受け入れる", async (version) => {
    writeScenario(
      scenario({
        run: {
          stdout: `${JSON.stringify({ verdict: "internal_pass" })}\n`,
          ...declarationFile(),
        },
        check: resultFile({
          schema: `musubi-ca-pack/result/${version}`,
          verdict: "internal_pass",
          cost: "0.3",
        }),
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "finished", costUsd: 0.3 });
  });

  it("「結果の版」知らない schema は result-schema で止まり、読めた費用は数える", async () => {
    writeScenario(
      scenario({
        run: {
          stdout: `${JSON.stringify({ verdict: "internal_pass" })}\n`,
          ...declarationFile(),
        },
        check: resultFile({
          schema: "musubi-ca-pack/result/v9",
          verdict: "internal_pass",
          cost: "0.7",
        }),
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "result-schema", codes: ["result-schema"], costUsd: 0.7 });
  });

  it("「結果の版」verdict の欠けは result-schema で止まる", async () => {
    writeScenario(
      scenario({
        run: {
          stdout: `${JSON.stringify({ verdict: "internal_pass" })}\n`,
          ...declarationFile(),
        },
        check: resultFile({ schema: RESULT_V3, cost: "0.7" }),
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "result-schema", codes: ["result-schema"], costUsd: 0.7 });
  });

  it("run の終了 3 は run-exit-3 で止まる", async () => {
    writeScenario(scenario({ run: { exit: 3, stderr: "run.error ignored\n" } }));

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "run-error", codes: ["run-exit-3"], costUsd: 0 });
    expect(calls().map((call) => call.name)).toEqual(["build", "verify-install", "run"]);
  });

  it("check-result の終了 2 は result.<code> のコードで止まる", async () => {
    writeScenario(
      scenario({ check: { exit: 2, stderr: "result.args usage: node bin/check-result.mjs <workdir>\n" } }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "check-result-error",
      codes: ["args"],
      costUsd: 0,
    });
  });

  it("check-result の終了 3 は check-result-exit-3 で止まる", async () => {
    writeScenario(scenario({ check: { exit: 3 } }));

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "check-result-error",
      codes: ["check-result-exit-3"],
      costUsd: 0,
    });
  });

  it.each([
    ["build", "build-error", 1, "build.error first-code\n", ["build"]],
    ["verify-install", "verify-install-error", 1, "install.first-code operator-index.json\n", ["build", "verify-install"]],
    ["run", "run-error", 2, "run.error first-code\n", ["build", "verify-install", "run"]],
    [
      "check-result",
      "check-result-error",
      2,
      "result.first-code usage: node bin/check-result.mjs <workdir>\n",
      ["build", "verify-install", "run", "check-result"],
    ],
  ] as const)("%s は stderr の先頭行のコードを拾う", async (name, reason, exitCode, stderr, called) => {
    const step = { exit: exitCode, stderr };
    writeScenario(
      scenario({
        ...(name === "build" ? { build: step } : {}),
        ...(name === "verify-install" ? { install: step } : {}),
        ...(name === "run" ? { run: step } : {}),
        ...(name === "check-result" ? { check: step } : {}),
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toMatchObject({ kind: "failed", reason, codes: ["first-code"] });
    expect(calls().map((call) => call.name)).toEqual(called);
  });

  it("stderr の 2 行目以降のコードは拾わない（先頭行だけを見る）", async () => {
    writeScenario(scenario({ build: { exit: 1, stderr: "note\nbuild.error second-code\n" } }));

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "build-error", codes: ["build-exit-1"], costUsd: 0 });
  });

  it("「設定」4 つの環境変数のどれかが無いと pack-config で止まり、コマンドを 1 つも起こさない", async () => {
    writeScenario(passScenario());

    for (const key of PACK_ENV_KEY_NAMES) {
      const partial = env();
      delete partial[key];

      const outcome = await runPackBuild(input({ env: partial }));

      expect(outcome).toEqual({ kind: "failed", reason: PACK_CONFIG_CODE, codes: [PACK_CONFIG_CODE], costUsd: 0 });
    }
    expect(calls()).toEqual([]);
  });

  it("result.json が無ければ result-schema で止まる", async () => {
    writeScenario(scenario({ run: { stdout: "{}\n" } }));

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "result-schema", codes: ["result-schema"], costUsd: 0 });
  });

  it("internal_pass でも宣言が無ければ完了にしない", async () => {
    writeScenario(
      scenario({
        run: { stdout: `${JSON.stringify({ verdict: "internal_pass", cost: { usd_total: "0.2" } })}\n` },
        check: resultFile({ schema: RESULT_V3, verdict: "internal_pass", cost: "0.2" }),
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({
      kind: "failed",
      reason: "declaration-error",
      codes: ["declaration-missing"],
      costUsd: 0.2,
    });
  });

  it("verdict が unknown なら reason.code で失敗する", async () => {
    writeScenario(
      scenario({
        check: resultFile({
          schema: RESULT_V3,
          verdict: "unknown",
          reasonCode: "evidence.unreadable",
          cost: "0.1",
        }),
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "failed", reason: "unknown", codes: ["evidence.unreadable"], costUsd: 0.1 });
  });

  it("要約が無ければ空の要約を書き、完了は変えない", async () => {
    writeScenario(
      scenario({
        run: { stdout: "", ...declarationFile() },
        check: resultFile({ schema: RESULT_V3, verdict: "internal_pass", cost: "0.05" }),
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "finished", costUsd: 0.05 });
    expect(readFileSync(summaryPath(), "utf8")).toBe("");
  });

  it.each(["-1", "not-a-number", ""])("費用が %s なら 0 として扱う（Plan の費用に足さない）", async (raw) => {
    writeScenario(
      scenario({
        run: { stdout: `${JSON.stringify({ verdict: "internal_pass" })}\n`, ...declarationFile() },
        check: resultFile({ schema: RESULT_V3, verdict: "internal_pass", cost: raw }),
      }),
    );

    const outcome = await runPackBuild(input());

    expect(outcome).toEqual({ kind: "finished", costUsd: 0 });
  });
});
