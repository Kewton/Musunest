// Plan の探針の入口（Issue #956）の試験。
//
// **実 API は呼ばない。** 記録した応答を返す偽物の LLM と、ファイルの偽物で閉じる。確かめるのは、引数の
// 読み方・出力先の断り方・題材の組の検査（呼び出し 0 回）・回ごとの記録の残り方・鍵の値を書かないこと。
import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_RUN_FAILED, EXIT_USAGE } from "./cli.js";
import {
  PLAN_PROBE_USAGE,
  parsePlanProbeArguments,
  runPlanProbeCli,
  type PlanProbeCliDeps,
} from "./cli-plan-probe.js";
import {
  PLAN_PROBE_CASES_SCHEMA,
  PLAN_PROBE_SUMMARY_SCHEMA,
} from "./plan/probe.js";
import { createRecordingClient, REQUIREMENT_LIST_OUTPUT, SAMPLE_DOCUMENTS, SOURCE_TEXT } from "./stages/__tests__/prompt.js";
import { structured } from "./__tests__/run.js";
import { sha256Hex } from "./cli-plan.js";

const SECRET = "sk-SECRET-SENTINEL-956";

function casesText(): string {
  return JSON.stringify({
    schema_version: PLAN_PROBE_CASES_SCHEMA,
    cases_version: "cases-v1",
    cases: [{ id: "case-1", source: SOURCE_TEXT }],
  });
}

interface Harness {
  readonly deps: PlanProbeCliDeps;
  readonly reads: string[];
  readonly written: { readonly path: string; readonly text: string }[];
  readonly directories: string[];
  readonly clientOptions: { readonly apiKey: string; readonly model: string; readonly effort: string }[];
  /** 書いた・作った・呼んだの順（条件を流す前に書いたことを見る） */
  readonly events: string[];
}

function harness(options: {
  readonly argv?: readonly string[];
  readonly cases?: string;
  readonly exists?: ReadonlySet<string>;
  readonly calls?: ReturnType<typeof structured>[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly makeDirectoryError?: { readonly code: string };
} = {}): Harness {
  const casesPath = "cases.json";
  const reads: string[] = [];
  const written: { path: string; text: string }[] = [];
  const directories: string[] = [];
  const clientOptions: { apiKey: string; model: string; effort: string }[] = [];
  const events: string[] = [];
  const recording = createRecordingClient(options.calls ?? [structured(REQUIREMENT_LIST_OUTPUT)]);
  const deps: PlanProbeCliDeps = {
    argv:
      options.argv ??
      ["--", "--stage", "p1", "--cases", casesPath, "--out", "out", "--repeat", "1", "--budget", "1"],
    env: options.env ?? { OPENAI_API_KEY: SECRET },
    readFile: async (path) => {
      reads.push(path);
      if (path !== casesPath) throw new Error(`unexpected read: ${path}`);
      return options.cases ?? casesText();
    },
    writeFile: async (path, text) => {
      written.push({ path, text });
      events.push(`write:${path}`);
    },
    makeDirectory: async (path) => {
      if (options.makeDirectoryError !== undefined) {
        throw Object.assign(new Error("cannot create"), options.makeDirectoryError);
      }
      directories.push(path);
      events.push(`mkdir:${path}`);
    },
    pathExists: async (path) => options.exists?.has(path) ?? false,
    loadDocuments: async () => SAMPLE_DOCUMENTS,
    makeClient: (client) => {
      clientOptions.push({ apiKey: client.apiKey, model: client.model, effort: client.effort });
      return {
        callStructured: async (request) => {
          events.push("call");
          return recording.client.callStructured(request);
        },
        callWithTools: (request) => recording.client.callWithTools(request),
      };
    },
    log: () => undefined,
  };
  return { deps, reads, written, directories, clientOptions, events };
}

function writtenNamed(harnessResult: Harness, name: string): string | undefined {
  return harnessResult.written.find((entry) => entry.path === `out/${name}`)?.text;
}

describe("Plan の探針の入口", () => {
  it("引数を読み、予算が無ければ使い方の誤りにする", () => {
    expect(parsePlanProbeArguments(["--stage", "p1", "--cases", "a.json", "--out", "o"])).toMatchObject({
      error: expect.stringContaining("--budget"),
    });
    expect(parsePlanProbeArguments(["--stage", "nope", "--cases", "a.json", "--out", "o", "--budget", "1"])).toMatchObject({
      error: expect.stringContaining("--stage"),
    });
    expect(parsePlanProbeArguments(["--stage", "loop", "--cases", "a.json", "--out", "o", "--budget", "1"])).toMatchObject({
      stage: "loop",
      repeat: 1,
      budgetUsd: 1,
      effort: "high",
      model: "gpt-6-luna",
    });
  });

  it("既にある出力先を断り、何も読まず・呼ばず・書かない", async () => {
    const run = harness({ exists: new Set(["out"]) });
    const code = await runPlanProbeCli(run.deps);
    expect(code).toBe(EXIT_USAGE);
    expect(run.reads).toEqual([]);
    expect(run.clientOptions).toEqual([]);
    expect(run.written).toEqual([]);
  });

  it(".env という名前のファイルを断る", async () => {
    const run = harness({ argv: ["--stage", "p1", "--cases", ".env", "--out", "out", "--budget", "1"] });
    expect(await runPlanProbeCli(run.deps)).toBe(EXIT_USAGE);
    expect(run.reads).toEqual([]);
  });

  it("題材の組の検査に落ちると、client を作らず・呼ばずに断る", async () => {
    const missingRequirements = JSON.stringify({
      schema_version: PLAN_PROBE_CASES_SCHEMA,
      cases_version: "cases-v1",
      cases: [{ id: "case-1", source: SOURCE_TEXT }],
    });
    const run = harness({
      argv: ["--stage", "p2", "--cases", "cases.json", "--out", "out", "--budget", "1"],
      cases: missingRequirements,
    });
    expect(await runPlanProbeCli(run.deps)).toBe(EXIT_USAGE);
    expect(run.clientOptions).toEqual([]);
    expect(run.written).toEqual([]);
  });

  it("引数で渡した題材の組だけを読み、回・条件・集計を書く", async () => {
    const run = harness();
    const code = await runPlanProbeCli(run.deps);
    expect(code).toBe(EXIT_OK);
    expect(run.reads).toEqual(["cases.json"]);
    expect(run.directories).toEqual(["out"]);
    const paths = run.written.map((entry) => entry.path);
    expect(paths).toHaveLength(3);
    expect(paths).toEqual(
      expect.arrayContaining(["out/conditions.json", "out/run-0001.json", "out/summary.json"]),
    );
    const summary = JSON.parse(writtenNamed(run, "summary.json") ?? "null");
    expect(summary).toMatchObject({ schema_version: PLAN_PROBE_SUMMARY_SCHEMA, planned: 1, completed: 1 });
  });

  it("条件のファイルを流す前に書き、題材の組のファイルの SHA も残す", async () => {
    const run = harness();
    expect(await runPlanProbeCli(run.deps)).toBe(EXIT_OK);
    const conditions = JSON.parse(writtenNamed(run, "conditions.json") ?? "null");
    expect(conditions.case_file_sha256).toBe(await sha256Hex(casesText()));
    expect(conditions.case_set_sha256).toEqual(expect.any(String));
    const conditionsAt = run.events.indexOf("write:out/conditions.json");
    const firstCall = run.events.indexOf("call");
    expect(conditionsAt).toBeGreaterThanOrEqual(0);
    expect(firstCall).toBeGreaterThan(conditionsAt);
    expect(run.events.at(-1)).toBe("write:out/summary.json");
  });

  it("出力先を作れないとき（既にある）は、呼ばず・書かずに使い方の誤りで終わる", async () => {
    const run = harness({ makeDirectoryError: { code: "EEXIST" } });
    expect(await runPlanProbeCli(run.deps)).toBe(EXIT_USAGE);
    expect(run.events).not.toContain("call");
    expect(run.written).toEqual([]);
  });

  it("鍵と環境変数の値の目印文字列を、条件・回・集計のファイルに書かない", async () => {
    const run = harness({
      env: { OPENAI_API_KEY: SECRET, JEV_API_KEY: `${SECRET}-jev`, OTHER: `${SECRET}-other` },
    });
    expect(await runPlanProbeCli(run.deps)).toBe(EXIT_OK);
    for (const entry of run.written) {
      expect(entry.text, entry.path).not.toContain(SECRET);
    }
    const conditions = writtenNamed(run, "conditions.json") ?? "";
    expect(conditions).not.toContain("apiKey");
    expect(conditions).not.toContain("OPENAI_API_KEY");
  });

  it("途中で止まっても、完了した回のファイルを残し、集計で未実行と失敗を分ける", async () => {
    const run = harness({
      argv: ["--stage", "p1", "--cases", "cases.json", "--out", "out", "--repeat", "2", "--budget", "1"],
      calls: [structured({}), structured({})],
    });
    const code = await runPlanProbeCli(run.deps);
    expect(code).toBe(EXIT_RUN_FAILED);
    const paths = run.written.map((entry) => entry.path);
    expect(paths).toHaveLength(4);
    expect(paths).toEqual(
      expect.arrayContaining(["out/conditions.json", "out/run-0001.json", "out/run-0002.json", "out/summary.json"]),
    );
    const first = JSON.parse(writtenNamed(run, "run-0001.json") ?? "null");
    const second = JSON.parse(writtenNamed(run, "run-0002.json") ?? "null");
    expect(first).toMatchObject({ state: "failed", stop_reason: "malformed" });
    expect(second).toMatchObject({ state: "not-run", stop_reason: "malformed" });
    const summary = JSON.parse(writtenNamed(run, "summary.json") ?? "null");
    expect(summary).toMatchObject({ completed: 0, failed: 1, not_run: 1 });
  });

  it("鍵が無ければ、client を作らずに使い方の誤りで終わる", async () => {
    const run = harness({ env: {} });
    expect(await runPlanProbeCli(run.deps)).toBe(EXIT_USAGE);
    expect(run.clientOptions).toEqual([]);
    expect(run.written).toEqual([]);
  });

  it("使い方の文に、流す段と必須の予算を出す", () => {
    expect(PLAN_PROBE_USAGE).toContain("--stage p1|p2|loop");
    expect(PLAN_PROBE_USAGE).toContain("--budget <USD>");
  });
});
