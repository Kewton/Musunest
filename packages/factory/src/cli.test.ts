// 手元の入口（cli.ts）の unit テスト（02 §3.2）。
//
// ここで固定したいのは 3 つ。
//   1. 鍵が無いときに **API を呼ばずに**使い方の誤り（終了コード 2）で終わること
//   2. 引数が足りないときも、使い方の誤りで終わること
//   3. 偽物を差し込んで 1 回の生成を流し、**ディレクトリに納品物を書く**こと
//   4. `--pipeline v1.1a` は `--plan-file` と組んでだけ受け、v1.1α の経路を流す。`--pipeline` を省いた走りは、
//      凍結した比較元（main `2cd1586`）から取ったバイトの記録と深く等しい（Issue #511）
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PLAN_SPEC_SCHEMA_VERSION, planDigest, type ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import {
  API_KEY_ENV,
  DEFAULT_BUDGET_USD,
  DEFAULT_DEADLINE_MS,
  EXIT_OK,
  EXIT_RETURN_TO_PLAN,
  EXIT_RUN_FAILED,
  EXIT_USAGE,
  JEV_API_KEY_ENV,
  PROMPT_VERSION_V11A,
  USAGE,
  parseCliArguments,
  runCli,
} from "./cli.js";
import { BUILD_CLI_RECORD_FILE, PLAN_ONLY_RESULT_SCHEMA } from "./cli-plan.js";
import * as factory from "./index.js";
import { createFakeJudge } from "./judge-fake.js";
import type { JudgeAnswer } from "./judge.js";
import type { RecordedCall } from "./llm-fake.js";
import { requirementsFromPlan, type RequirementList } from "./pipeline.js";
import { captureCliBaseline, type BaselineCliCapture, type BaselineCliScenarios } from "./__tests__/baseline-capture.js";
import { V11A_ARTIFACT_NAMES } from "./v11a/bundle-v11a.js";
import * as v11aRunModule from "./v11a/run.js";
import { FIXTURE_DOCUMENTS, FIXTURE_YAML, draftOf, fixtureList, fixtureTable } from "./v11a/__tests__/fixtures.js";
import type { NameTable } from "./v11a/names.js";
import {
  BUNDLE_MANIFEST_FILE,
  DESIGN_FILE,
  DIAGNOSTICS_LISTING_FILE,
  DIAGNOSTICS_REJECTED_DESIGN_FILE,
  MAPPINGS_FILE,
  TEST_SUITE_FILE,
} from "./bundle.js";
import * as runModule from "./run.js";
import type { Judge, JudgeRequest } from "./judge.js";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "./llm.js";
import { createRecordingClient } from "./stages/__tests__/prompt.js";
import { ATTEMPT_KEYS, RETRY_KEYS } from "./record.js";
import { DESIGN_OUTPUT_MAPPED, SOURCE_TEXT, recordedRun, structured } from "./__tests__/run.js";

interface NodeFs {
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

interface NodeOs {
  tmpdir(): string;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs/promises")) as NodeFs;
const os = (await importUntyped("node:os")) as NodeOs;

let directory = "";

beforeAll(async () => {
  directory = await fs.mkdtemp(`${os.tmpdir()}/factory-cli-`);
});

afterAll(async () => {
  if (directory !== "") await fs.rm(directory, { recursive: true, force: true });
});

/** 実在のファイルに書く依存（鍵と文書は偽物、ファイルだけ本物） */
const realFileDeps = () => ({
  readFile: async () => SOURCE_TEXT,
  writeFile: async (path: string, text: string) => {
    await fs.writeFile(path, text, "utf8");
  },
  makeDirectory: async (path: string) => {
    await fs.mkdir(path, { recursive: true });
  },
});

// ── 引数の読み取り ───────────────────────────────────────────────

describe("引数の読み取り（02 §3.2）", () => {
  it("`-- <依頼文> --out <ディレクトリ>` を読む", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out"])).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
    });
  });

  it("依頼文が無ければ誤り", () => {
    expect(parseCliArguments(["--out", "out"])).toEqual({ error: "依頼文のファイルを指定してください" });
  });

  it("--out が無ければ誤り", () => {
    expect(parseCliArguments(["request.txt"])).toEqual({
      error: "--out で出力のディレクトリを指定してください",
    });
  });
});

// ── --plan-only・--plan-file の読み取り（Issue #495）──────────────

describe("--plan-only・--plan-file の読み取り（Issue #495）", () => {
  it("--plan-only を読む（--answers・--script を一緒に受けられる）", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--plan-only"])).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      planOnly: true,
    });
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--plan-only", "--answers", "a.json"]),
    ).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      planOnly: true,
      answersFile: "a.json",
    });
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--plan-only", "--script", "s.json"]),
    ).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      planOnly: true,
      scriptFile: "s.json",
    });
  });

  it("--plan-file を読む", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--plan-file", "plan.json"])).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      planFile: "plan.json",
    });
  });

  it("--plan-only と --plan、--plan-only と --plan-file、--plan と --plan-file は誤り", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--plan-only", "--plan"])).toEqual({
      error: "--plan と --plan-only は同時に指定できません",
    });
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--plan-only", "--plan-file", "plan.json"]),
    ).toEqual({ error: "--plan-only と --plan-file は同時に指定できません" });
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--plan", "--plan-file", "plan.json"]),
    ).toEqual({ error: "--plan と --plan-file は同時に指定できません" });
  });

  it("--plan-file に値が無ければ誤り", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--plan-file"])).toEqual({
      error: "--plan-file には出力ファイルを指定してください",
    });
  });

  it("--plan-file と --answers・--script は誤り", () => {
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--plan-file", "plan.json", "--answers", "a.json"]),
    ).toEqual({ error: "--plan-file と --answers は同時に指定できません" });
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--plan-file", "plan.json", "--script", "s.json"]),
    ).toEqual({ error: "--plan-file と --script は同時に指定できません" });
  });
});

// ── 既定の上限と、引数での変更（02 §1.5）─────────────────────────

describe("既定の上限は 0.30 USD・10 分で、引数で変えられる（02 §1.5）", () => {
  it("既定の費用の上限は 0.30 USD、締切は 10 分", () => {
    expect(DEFAULT_BUDGET_USD).toBe(0.3);
    expect(DEFAULT_DEADLINE_MS).toBe(10 * 60 * 1000);
  });

  it("指定しなければ、既定（budgetUsd・deadlineMs は持たない）", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out"])).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
    });
  });

  it("--budget と --deadline で、既定の上限を変えられる", () => {
    expect(
      parseCliArguments([
        "--",
        "request.txt",
        "--out",
        "out",
        "--budget",
        "1.5",
        "--deadline",
        "2",
      ]),
    ).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      budgetUsd: 1.5,
      deadlineMs: 2 * 60 * 1000,
    });
  });

  it("--budget / --deadline の値が数でなければ誤り", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--budget", "abc"])).toEqual({
      error: "--budget には 0 より大きい数（USD）を指定してください",
    });
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--deadline", "0"])).toEqual({
      error: "--deadline には 0 より大きい数（分）を指定してください",
    });
  });

  it("--timeout で、呼び出し 1 回ごとの timeout を変えられる（#302）", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--timeout", "3"])).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      timeoutMs: 3 * 60_000,
    });
  });

  it("--timeout の値が数でなければ誤り", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--timeout", "0"])).toEqual({
      error: "--timeout には 0 より大きい数（分）を指定してください",
    });
  });
});

// ── 鍵が無いとき ─────────────────────────────────────────────────

describe("鍵が無いときは、API を呼ばずに使い方の誤りで終わる（02 §3.2・R-15）", () => {
  it("makeClient を呼ばずに 2 を返す", async () => {
    const makeClient = vi.fn();
    const log = vi.fn();
    const code = await runCli({
      argv: ["--", "request.txt", "--out", "out"],
      env: {},
      readFile: async () => SOURCE_TEXT,
      writeFile: async () => {},
      makeDirectory: async () => {},
      loadDocuments: async () => [],
      makeClient,
      log,
    });
    expect(code).toBe(EXIT_USAGE);
    expect(makeClient).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([line]) => String(line).includes(API_KEY_ENV))).toBe(true);
  });

  it("引数が足りないときも 2 を返す", async () => {
    const makeClient = vi.fn();
    const code = await runCli({
      argv: [],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async () => SOURCE_TEXT,
      writeFile: async () => {},
      makeDirectory: async () => {},
      loadDocuments: async () => [],
      makeClient,
      log: () => {},
    });
    expect(code).toBe(EXIT_USAGE);
    expect(makeClient).not.toHaveBeenCalled();
  });
});

// ── 偽物を差し込んで 1 回の生成を流す ────────────────────────────

describe("偽物を差し込んで 1 回の生成を流し、ディレクトリに納品物を書く（02 §3.2）", () => {
  it("納品物を書き、最後の行に要約を出す", async () => {
    const recording = createRecordingClient(recordedRun());
    const lines: string[] = [];
    const written: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", directory],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async () => SOURCE_TEXT,
      writeFile: async (path: string, text: string) => {
        written.push(path);
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path: string) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_OK);
    const manifest = JSON.parse(await fs.readFile(`${directory}/${BUNDLE_MANIFEST_FILE}`, "utf8")) as {
      files: readonly { path: string }[];
    };
    expect(manifest.files.map((file) => file.path)).toContain("artifacts/app.spec.yaml");
    // Issue #417：受理した材料（設計・固定した試験・提出された対応）の 3 ファイルが manifest に載る
    const paths = manifest.files.map((file) => file.path);
    for (const path of [DESIGN_FILE, TEST_SUITE_FILE, MAPPINGS_FILE]) {
      expect(paths, path).toContain(path);
    }
    for (const file of manifest.files) {
      expect(await fs.readFile(`${directory}/${file.path}`, "utf8")).not.toBe("");
    }
    // 書いたファイルの集合は、納品物のファイル（manifest 自身を含む）の集合と一致する
    const expected = [...paths.map((path) => `${directory}/${path}`), `${directory}/${BUNDLE_MANIFEST_FILE}`].sort();
    expect([...written].sort()).toEqual(expected);
    // 完走では、診断の置き場所に書かない（Issue #417）
    expect(written.some((path) => path.includes("/diagnostics/"))).toBe(false);

    const last = lines.at(-1) ?? "";
    const summary = JSON.parse(last) as {
      schema_version: string;
      verdict: string;
      budget_reserved_usd?: number;
      stages: readonly { readonly attempts: object; readonly retries: object }[];
    };
    expect(summary.schema_version).toBe("commandagent.headless-summary/v1");
    expect(summary.verdict).toBe("full");
    // Issue #446：未精算の予約額と、段ごとの試行の終端・再試行の数が要約に入る
    expect(summary.budget_reserved_usd).toBe(0);
    expect(summary.stages.length).toBeGreaterThan(0);
    for (const stage of summary.stages) {
      expect(Object.keys(stage.attempts).sort()).toEqual([...ATTEMPT_KEYS].sort());
      expect(Object.keys(stage.retries).sort()).toEqual([...RETRY_KEYS].sort());
    }
    // 依頼文の目印の文字列は出ない
    expect(last).not.toContain("タスクを記録する");
  });
});

// ── 引数で変えた上限が、生成に届く（02 §1.5）─────────────────────

describe("引数で変えた費用の上限が、生成に届く（02 §1.5）", () => {
  it("--budget を小さくすると、その上限で残高切れとして止まる", async () => {
    const recording = createRecordingClient(recordedRun());
    const lines: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", `${directory}-budget`, "--budget", "0.000001"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    const summary = JSON.parse(lines.at(-1) ?? "{}") as { stop_class: string | null };
    expect(summary.stop_class).toBe("budget");

    // Issue #417：早期停止では、出力のディレクトリの下の**診断の置き場所**に一覧が書かれる。
    // **納品物の成果物と manifest は書かない**
    const listing = JSON.parse(
      await fs.readFile(`${directory}-budget/${DIAGNOSTICS_LISTING_FILE}`, "utf8"),
    ) as { stopped: { stage: string; kind: string } | null; materials: readonly { material: string }[] };
    expect(listing.stopped?.kind).toBe("budget");
    expect(listing.materials.length).toBeGreaterThan(0);
    await expect(fs.readFile(`${directory}-budget/${BUNDLE_MANIFEST_FILE}`, "utf8")).rejects.toThrow();
    await expect(fs.readFile(`${directory}-budget/artifacts/app.spec.yaml`, "utf8")).rejects.toThrow();
  });
});

// ── 引数で変えた呼び出しごとの timeout が、生成に届く（#302）──────

describe("引数で変えた呼び出しごとの timeout が、生成に届く（#302）", () => {
  it("--timeout を短くすると、拒否ではなく timeout として止まる", async () => {
    const hanging: LlmClient = {
      callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        return new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      callWithTools(): Promise<LlmToolResponse> {
        return Promise.reject(new Error("未使用"));
      },
    };
    const lines: string[] = [];
    const code = await runCli({
      // 0.001 分 = 60ms。締切（10 分）には触れないので、呼び出しごとの timeout で打ち切られる
      argv: ["--", "request.txt", "--out", `${directory}-timeout`, "--timeout", "0.001"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient: () => hanging,
      log: (line) => lines.push(line),
      now: () => 0,
      deadlineMs: 600_000,
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    const summary = JSON.parse(lines.at(-1) ?? "{}") as { stop_class: string | null };
    expect(summary.stop_class).toBe("timeout");
  });
});

// ── 判定の口を組み立てて生成に渡す（05 §4・Issue #355）─────────────

/**
 * 偽物の判定（実 API を呼ばない）。`answeredBy` でどちらの adapter が答えたかを見る。`stop` を渡すと、
 * 呼ばれた時点で止まる（Jev の障害を模す）。
 */
function fakeJudge(source: "jev" | "llm", options: { readonly stop?: boolean } = {}): Judge {
  return {
    async judge(request: JudgeRequest) {
      if (options.stop === true) throw new Error(`${source} は止まった`);
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((name) => [name, { kind: "noul" as const, noul: source === "jev" ? 1 : 0 }]),
      );
      return {
        answers,
        inputTokens: source === "jev" ? 10 : 20,
        model: `${source}-model`,
        answeredBy: source,
      };
    },
  };
}

/** 組み立てた判定の口に投げる、最小の問い（はい／いいえ 1 つ） */
const JUDGE_REQUEST: JudgeRequest = {
  state: { claim: "x" },
  questions: { q: { kind: "noul", instructions: "?" } },
};

describe("判定の口を組み立てて生成に渡す（05 §4・Issue #355）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("JEV_API_KEY があると、Jev を主・LLM を落とし先にした判定の口が生成に渡る", async () => {
    const spy = vi.spyOn(runModule, "runGeneration");
    const makeJevJudge = vi.fn(() => fakeJudge("jev"));
    const makeLlmJudge = vi.fn(() => fakeJudge("llm"));
    const logError = vi.fn();
    const recording = createRecordingClient(recordedRun());
    const code = await runCli({
      argv: ["--", "request.txt", "--out", `${directory}/jev`],
      env: { [API_KEY_ENV]: "sk-FAKE", [JEV_API_KEY_ENV]: "jev-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeJevJudge,
      makeLlmJudge,
      log: () => {},
      logError,
    });

    expect(code).toBe(EXIT_OK);
    const judge = spy.mock.calls[0]?.[0]?.judge;
    expect(judge, "判定の口が judge として生成に届く").toBeDefined();
    expect(makeJevJudge).toHaveBeenCalledWith({ apiKey: "jev-FAKE" });
    // 主（Jev）が元気なら、Jev が答える
    expect(judge === undefined ? "" : (await judge.judge(JUDGE_REQUEST)).answeredBy).toBe("jev");
    // 鍵があるときは、標準エラーに何も出さない
    expect(logError).not.toHaveBeenCalled();
  });

  it("Jev が止まると、落とし先の LLM が答える（主・落とし先の順）", async () => {
    const spy = vi.spyOn(runModule, "runGeneration");
    const makeJevJudge = vi.fn(() => fakeJudge("jev", { stop: true }));
    const recording = createRecordingClient(recordedRun());
    await runCli({
      argv: ["--", "request.txt", "--out", `${directory}/fallback`],
      env: { [API_KEY_ENV]: "sk-FAKE", [JEV_API_KEY_ENV]: "jev-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeJevJudge,
      makeLlmJudge: () => fakeJudge("llm"),
      log: () => {},
      logError: vi.fn(),
    });

    const judge = spy.mock.calls[0]?.[0]?.judge;
    expect(judge, "判定の口が judge として生成に届く").toBeDefined();
    expect(judge === undefined ? "" : (await judge.judge(JUDGE_REQUEST)).answeredBy).toBe("llm");
  });

  it("JEV_API_KEY が無いと、LLM の判定の口が渡り、標準エラーに 1 行出る", async () => {
    const spy = vi.spyOn(runModule, "runGeneration");
    const makeJevJudge = vi.fn(() => fakeJudge("jev"));
    const logError = vi.fn();
    const recording = createRecordingClient(recordedRun());
    await runCli({
      argv: ["--", "request.txt", "--out", `${directory}/llm`],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeJevJudge,
      makeLlmJudge: () => fakeJudge("llm"),
      log: () => {},
      logError,
    });

    const judge = spy.mock.calls[0]?.[0]?.judge;
    expect(judge, "判定の口が judge として生成に届く").toBeDefined();
    expect(judge === undefined ? "" : (await judge.judge(JUDGE_REQUEST)).answeredBy).toBe("llm");
    // Jev は組み立てない（鍵が無いので呼ばない）
    expect(makeJevJudge).not.toHaveBeenCalled();
    // 標準エラーに 1 行だけ出す
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).toContain(JEV_API_KEY_ENV);
  });
});

// ── ②・②' が断った候補のファイルを、診断の置き場所に書く（Issue #501）──────────────

describe("②・②' が断った候補のファイルを、診断の置き場所に書く（Issue #501）", () => {
  afterAll(async () => {
    for (const suffix of ["-rejected-stop", "-rejected-done"]) {
      if (directory !== "") await fs.rm(`${directory}${suffix}`, { recursive: true, force: true });
    }
  });

  /** 書いたパスを残しつつ、本物のファイルに書く依存 */
  const writingDeps = (written: string[]) => ({
    readFile: async () => SOURCE_TEXT,
    writeFile: async (path: string, text: string) => {
      written.push(path);
      await fs.writeFile(path, text, "utf8");
    },
    makeDirectory: async (path: string) => {
      await fs.mkdir(path, { recursive: true });
    },
  });

  it("② が 2 回 unmet の走りで、設計の候補のファイルが書かれ、manifest と成果物が無く、終了コード 1、要約に目印が無い", async () => {
    const marker = "MARKER501";
    const base = recordedRun();
    const badDesign = {
      ...DESIGN_OUTPUT_MAPPED,
      designs: [
        { ...DESIGN_OUTPUT_MAPPED.designs[0], ownership: [{ roleId: `ghost-${marker}`, basis: "dependency", reason: marker }] },
        ...DESIGN_OUTPUT_MAPPED.designs.slice(1),
      ],
    };
    const recording = createRecordingClient([
      base[0]!,
      base[1]!,
      { kind: "structured", output: badDesign, usage: undefined },
      { kind: "structured", output: badDesign, usage: undefined },
    ]);
    const out = `${directory}-rejected-stop`;
    const lines: string[] = [];
    const written: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", out],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...writingDeps(written),
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    const candidates = await fs.readFile(`${out}/${DIAGNOSTICS_REJECTED_DESIGN_FILE}`, "utf8");
    expect(candidates).toContain(marker);
    expect(await fs.readFile(`${out}/${DIAGNOSTICS_LISTING_FILE}`, "utf8")).not.toContain(marker);
    await expect(fs.readFile(`${out}/${BUNDLE_MANIFEST_FILE}`, "utf8")).rejects.toThrow();
    expect(written.some((path) => path.includes("/artifacts/"))).toBe(false);
    expect(lines.at(-1) ?? "").not.toContain(marker);
  });

  it("② の作り直し 1 回の完走で、診断の置き場所には候補のファイルだけがあり、納品物の集合と終了コードは今までどおり", async () => {
    const base = recordedRun();
    const missingR2 = { ...DESIGN_OUTPUT_MAPPED, designs: DESIGN_OUTPUT_MAPPED.designs.slice(0, 1) };
    const recording = createRecordingClient([
      base[0]!,
      base[1]!,
      { kind: "structured", output: missingR2, usage: undefined },
      ...base.slice(2),
    ]);
    const out = `${directory}-rejected-done`;
    const written: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", out],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...writingDeps(written),
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      log: () => undefined,
    });

    expect(code).toBe(EXIT_OK);
    const manifest = JSON.parse(await fs.readFile(`${out}/${BUNDLE_MANIFEST_FILE}`, "utf8")) as {
      files: readonly { path: string }[];
    };
    const bundlePaths = [...manifest.files.map((file) => `${out}/${file.path}`), `${out}/${BUNDLE_MANIFEST_FILE}`];
    // 診断の置き場所には、設計の候補のファイルだけ（一覧は書かない）
    const diagnosticsWritten = written.filter((path) => path.includes("/diagnostics/"));
    expect(diagnosticsWritten).toEqual([`${out}/${DIAGNOSTICS_REJECTED_DESIGN_FILE}`]);
    // 書いたファイルの集合は、納品物のファイルと候補のファイルだけ。manifest は候補を載せない
    expect([...written].sort()).toEqual([...bundlePaths, ...diagnosticsWritten].sort());
    expect(manifest.files.some((file) => file.path.startsWith("diagnostics/"))).toBe(false);
  });
});

// ── `--pipeline`（v1.1α。07-architecture-v1.1a.md §3・D12・Issue #511）──────────────────

describe("--pipeline の読み取り（Issue #511）", () => {
  it("--pipeline v1.1a --plan-file <ファイル> を読む", () => {
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--pipeline", "v1.1a", "--plan-file", "plan.json"]),
    ).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      planFile: "plan.json",
      pipeline: "v1.1a",
    });
  });

  it("--pipeline v1 を読み、--pipeline を省けば欄を持たない（既定は v1）", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--pipeline", "v1"])).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      pipeline: "v1",
    });
    expect(parseCliArguments(["--", "request.txt", "--out", "out"])).not.toHaveProperty("pipeline");
  });

  const usageCases: readonly { readonly name: string; readonly args: readonly string[]; readonly error: string }[] = [
    {
      name: "--pipeline v1.1a だけ（--plan-file が無い）",
      args: ["--pipeline", "v1.1a"],
      error: "--pipeline v1.1a は --plan-file と一緒に指定してください",
    },
    {
      name: "--pipeline v1.1a と --plan",
      args: ["--pipeline", "v1.1a", "--plan"],
      error: "--pipeline と --plan は同時に指定できません",
    },
    {
      name: "--pipeline v1.1a と --plan-only",
      args: ["--pipeline", "v1.1a", "--plan-only"],
      error: "--pipeline と --plan-only は同時に指定できません",
    },
    {
      name: "--pipeline v1 と --plan",
      args: ["--pipeline", "v1", "--plan"],
      error: "--pipeline と --plan は同時に指定できません",
    },
    {
      name: "--pipeline v1 と --plan-only",
      args: ["--pipeline", "v1", "--plan-only"],
      error: "--pipeline と --plan-only は同時に指定できません",
    },
    { name: "知らない値", args: ["--pipeline", "v2"], error: "--pipeline には v1 か v1.1a を指定してください" },
    { name: "値が無い", args: ["--pipeline"], error: "--pipeline には v1 か v1.1a を指定してください" },
  ];

  it.each(usageCases)("$name は誤りで 2 を返し、makeClient を呼ばない", async (example) => {
    const argv = ["--", "request.txt", "--out", "out", ...example.args];
    expect(parseCliArguments(argv)).toEqual({ error: example.error });
    const makeClient = vi.fn(() => createRecordingClient([]).client);
    const lines: string[] = [];
    const code = await runCli({
      argv,
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async () => SOURCE_TEXT,
      writeFile: async () => {},
      makeDirectory: async () => {},
      loadDocuments: async () => [],
      makeClient,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(makeClient).not.toHaveBeenCalled();
    expect(lines).toEqual([`使い方の誤り: ${example.error}`, USAGE]);
  });
});

// v1.1α の走りの題材（v1.1α の共通の題材から、書けない要件 R5 を除いたもの。`v11a/run.test.ts` と同じ組み方）
const V11A_BASE_LIST: RequirementList = {
  ...fixtureList(),
  requirements: fixtureList().requirements.filter((requirement) => requirement.id !== "R5"),
};
const V11A_SOURCE = V11A_BASE_LIST.requirements.map((requirement) => requirement.text).join("");
const V11A_IDS = ["R1", "R2", "R3", "R4"] as const;

function v11aPlanBody(): ConfirmedPlan {
  return {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-v11a-cli",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: V11A_SOURCE }],
    requirements: V11A_BASE_LIST.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: "constraining" as const,
      origin: { input_id: "in-1", quote: requirement.quote },
      parts: [{ id: `${requirement.id}-p1`, text: requirement.text, disposition: "met" as const }],
    })),
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
  };
}

/** 包みの検査を通る確定した仕様（確認の SHA を中身に合わせる） */
async function v11aPlan(): Promise<ConfirmedPlan> {
  const plan = v11aPlanBody();
  return { ...plan, confirmation: { ...plan.confirmation, sha256: await planDigest(plan) } };
}

/** `--plan-file` の包み（`plan-result.json` の全欄。人が作る包みでは条件を null にする） */
async function v11aEnvelope(): Promise<Record<string, unknown>> {
  const plan = await v11aPlan();
  return {
    schema_version: PLAN_ONLY_RESULT_SCHEMA,
    outcome: "confirmed",
    plan,
    plan_sha256: await planDigest(plan),
    source_sha256: await sha256Hex(V11A_SOURCE),
    conditions: null,
    stop: null,
  };
}

const V11A_LIST = requirementsFromPlan(v11aPlanBody());
const without5 = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] =>
  entries.filter((entry) => entry.requirementId !== "R5");
const V11A_TABLE: NameTable = (() => {
  const table = fixtureTable();
  return {
    rows: table.rows,
    ownership: without5(table.ownership),
    verification: without5(table.verification),
    classification: without5(table.classification),
  };
})();
const V11A_YAML = FIXTURE_YAML.replace("show: [title, amount, kind]", "show: [title, owner, amount, day, kind]");

const V11A_KINDS = ["normal", "abnormal", "boundary"] as const;
type V11aKind = (typeof V11A_KINDS)[number];

/** strict の schema の形の試験 1 件（入力・期待の値は JSON の文字列） */
function v11aTest(options: {
  readonly id: string;
  readonly requirementId: string;
  readonly targetKind: string;
  readonly roleId: string;
  readonly kind?: V11aKind;
  readonly operation: string;
  readonly observes: string;
  readonly input?: unknown;
  readonly expected: { readonly kind: "ok" | "error"; readonly value: string | null; readonly code: string | null };
  readonly assertion?: Record<string, unknown> | null;
  readonly referenceData?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    id: options.id,
    target: { requirementId: options.requirementId, kind: options.targetKind, roleId: options.roleId },
    kind: options.kind ?? "normal",
    operation: options.operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: JSON.stringify(options.input ?? {}),
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: options.referenceData ?? [],
    expected: options.expected,
    assertion: options.assertion ?? null,
    observes: options.observes,
  };
}

const okValue = (value: string) => ({ kind: "ok" as const, value, code: null });
const V11A_ITEM_ROWS = [1, 2, 3].map((index) => ({
  target: { requirementId: "R4", kind: "entity", roleId: "e.item" },
  rowId: `item-${index}`,
  values: JSON.stringify({ "f.item.amount": 1 }),
}));

/** T2 の応答（要件ごとの分類と、R1〜R4 の試験） */
function v11aTestSpec(): Record<string, unknown> {
  const tests = [
    ...V11A_KINDS.map((kind) =>
      v11aTest({
        id: `r1-${kind}`,
        requirementId: "R1",
        targetKind: "field",
        roleId: "f.item.amount",
        kind,
        operation: "validate",
        observes: "validation",
        input: { "f.item.amount": kind === "abnormal" ? -1 : kind === "boundary" ? 1 : 5 },
        expected: kind === "abnormal" ? { kind: "error", value: null, code: "E_INVALID" } : okValue("true"),
      }),
    ),
    v11aTest({
      id: "r2-shows",
      requirementId: "R2",
      targetKind: "screen",
      roleId: "s.members",
      operation: "structure",
      observes: "view-structure",
      expected: okValue("true"),
      assertion: { check: "view-shows", expected: null, refEntity: null, role: "f.member.title" },
    }),
    ...V11A_KINDS.map((kind) =>
      v11aTest({
        id: `r3-${kind}`,
        requirementId: "R3",
        targetKind: "operation",
        roleId: "o.closeItem",
        kind,
        operation: "action",
        observes: "when",
        input: { "f.item.amount": kind === "abnormal" ? -1 : kind === "boundary" ? 1 : 3 },
        expected: okValue(kind === "abnormal" ? "false" : "true"),
      }),
    ),
    ...V11A_KINDS.map((kind) =>
      v11aTest({
        id: `r4-${kind}`,
        requirementId: "R4",
        targetKind: "computation",
        roleId: "c.rate",
        kind,
        operation: "compute",
        observes: "value",
        referenceData: V11A_ITEM_ROWS,
        expected: okValue("6"),
      }),
    ),
  ];
  return {
    classifications: [
      { requirementId: "R1", nature: "ruled" },
      { requirementId: "R2", nature: "existence-only" },
      { requirementId: "R3", nature: "ruled" },
      { requirementId: "R4", nature: "ruled" },
    ],
    tests,
  };
}

/** T1''・B3' の判定（`rejects` の要件だけ拒否） */
const v11aJudgments = (rejects: Readonly<Record<string, readonly [string, string]>> = {}) => ({
  judgments: V11A_IDS.map((requirementId) => {
    const found = rejects[requirementId];
    return found === undefined
      ? { requirementId, verdict: "accept", kind: null, quote: null }
      : { requirementId, verdict: "reject", kind: found[0], quote: found[1] };
  }),
});

/** T1・T1''・T2・B1 の記録（完走の道の頭） */
const v11aHead = (): RecordedCall[] => [
  structured(draftOf(V11A_LIST, V11A_TABLE)),
  structured(v11aJudgments()),
  structured(v11aTestSpec()),
  structured({ declaration: V11A_YAML }),
];

/** T1' に落ちる下書き（要件の写しを入れ替える） */
function v11aBadDraft(): unknown {
  const draft = draftOf(V11A_LIST, V11A_TABLE);
  return {
    ...draft,
    requirements: draft.requirements.map((entry, index) => (index === 0 ? { ...entry, copy: "目印の値の写し" } : entry)),
  };
}

/** 差し戻しの道（B3' の拒否 → B5 の主張 → B5' が Plan へ戻す） */
const v11aReturnToPlan = (): RecordedCall[] => [
  ...v11aHead(),
  structured(v11aJudgments({ R3: ["mismatch", "金額が 0 より大きい項目だけ"] })),
  {
    kind: "tools",
    response: {
      kind: "done",
      declaration: { declaration: V11A_YAML, disputes: [{ testId: "r4-normal", quote: "全体の率" }] },
      usage: undefined,
    },
  },
  structured({ decisions: [{ testId: "r4-normal", verdict: "return-to-plan", reason: "", quote: "" }] }),
];

/** J4 の偽物の判定（所属の組ごとに必要の値 0.9） */
function v11aJudge() {
  const answers: Record<string, JudgeAnswer> = {};
  for (const entry of V11A_TABLE.ownership) {
    for (const role of entry.roles) answers[`need:${entry.requirementId}:${role.id}`] = { kind: "noul", noul: 0.9 };
  }
  return createFakeJudge(answers);
}

/** `--pipeline v1.1a --plan-file` を 1 回流す（偽物の LLM・判定・時計で閉じる。ファイルだけ本物） */
async function runV11aCli(input: { readonly dir: string; readonly calls: readonly RecordedCall[] }) {
  const planPath = `${input.dir}-plan.json`;
  const planText = JSON.stringify(await v11aEnvelope());
  const recording = createRecordingClient(input.calls);
  const makeClient = vi.fn(() => recording.client);
  const lines: string[] = [];
  const written: string[] = [];
  const code = await runCli({
    argv: ["--", "request.txt", "--out", input.dir, "--pipeline", "v1.1a", "--plan-file", planPath],
    env: { [API_KEY_ENV]: "sk-FAKE" },
    readFile: async (path) => (path === planPath ? planText : V11A_SOURCE),
    writeFile: async (path, text) => {
      written.push(path.slice(input.dir.length + 1));
      await fs.writeFile(path, text, "utf8");
    },
    makeDirectory: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
    loadDocuments: async () => FIXTURE_DOCUMENTS,
    makeClient,
    makeLlmJudge: () => v11aJudge(),
    now: () => 0,
    log: (line) => lines.push(line),
  });
  const summary = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  const record = JSON.parse(await fs.readFile(`${input.dir}/${BUILD_CLI_RECORD_FILE}`, "utf8")) as {
    readonly conditions: Record<string, unknown>;
    readonly return_to_plan: boolean;
  };
  return { code, summary, record, written, makeClient, recording };
}

describe("v1.1a の走り（`--pipeline v1.1a --plan-file`。Issue #511）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("完走で 0：v1 の成果物と 7 つの記録があり、要約と記録の prompt_version が v1.1a、envelope が v1.1a", async () => {
    const dir = `${directory}/v11a-complete`;
    const v1Spy = vi.spyOn(runModule, "runGeneration");
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const run = await runV11aCli({ dir, calls: [...v11aHead(), structured(v11aJudgments())] });

    expect(run.code).toBe(EXIT_OK);
    expect(v1Spy).not.toHaveBeenCalled();
    expect(v11aSpy).toHaveBeenCalledTimes(1);
    expect(run.makeClient).toHaveBeenCalledTimes(1);
    expect(run.makeClient.mock.calls[0]).toEqual([
      { apiKey: "sk-FAKE", model: "gpt-6-luna", effort: "high", envelope: "v1.1a" },
    ]);
    expect(run.summary["verdict"]).toBe("full");
    expect(run.summary["prompt_version"]).toBe(PROMPT_VERSION_V11A);
    expect(run.summary["prompt_version"]).toBe("v1.1a");
    expect(run.record.conditions["prompt_version"]).toBe("v1.1a");
    expect(run.record.return_to_plan).toBe(false);

    const manifest = JSON.parse(await fs.readFile(`${dir}/${BUNDLE_MANIFEST_FILE}`, "utf8")) as {
      files: readonly { path: string }[];
    };
    const paths = manifest.files.map((file) => file.path);
    for (const path of [
      "artifacts/app.spec.yaml",
      DESIGN_FILE,
      TEST_SUITE_FILE,
      MAPPINGS_FILE,
      ...Object.values(V11A_ARTIFACT_NAMES),
    ]) {
      expect(paths, path).toContain(path);
      expect(run.written, path).toContain(path);
      expect(await fs.readFile(`${dir}/${path}`, "utf8"), path).not.toBe("");
    }
    // LLM への要求は v1.1α の段だけ（v1 の ①〜③ の段を呼ばない）
    expect(run.recording.structured.map((request) => request.schemaName)).toEqual([
      "name-table",
      "semantic-check",
      "test-spec",
      "declaration-v11a",
      "decl-check",
    ]);
  });

  it("早期停止で 1・manifest 無し（T1' に 2 回落ちる：段 name-table・unmet）", async () => {
    const dir = `${directory}/v11a-early-stop`;
    const run = await runV11aCli({ dir, calls: [structured(v11aBadDraft()), structured(v11aBadDraft())] });

    expect(run.code).toBe(EXIT_RUN_FAILED);
    expect(run.written).not.toContain(BUNDLE_MANIFEST_FILE);
    await expect(fs.readFile(`${dir}/${BUNDLE_MANIFEST_FILE}`, "utf8")).rejects.toThrow();
    expect(run.summary["verdict"]).toBe("none");
    expect(run.summary["stop_reason"]).toBe("unmet");
    expect(run.summary["prompt_version"]).toBe("v1.1a");
    const stages = run.summary["stages"] as readonly { readonly stage: string; readonly status: string }[];
    expect(stages.filter((stage) => stage.stage === "name-table").map((stage) => stage.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(run.record.return_to_plan).toBe(false);
  });

  it("差し戻しで 3：記録の差し戻し欄が真・要約と納品物は書かれる", async () => {
    const dir = `${directory}/v11a-return`;
    const run = await runV11aCli({ dir, calls: v11aReturnToPlan() });

    expect(run.code).toBe(EXIT_RETURN_TO_PLAN);
    expect(run.record.return_to_plan).toBe(true);
    expect(run.record.conditions["prompt_version"]).toBe("v1.1a");
    expect(run.summary["stop_reason"]).toBe("unresolved");
    expect(run.summary["verdict"]).not.toBe("full");
    expect(run.written).toContain(BUNDLE_MANIFEST_FILE);
  });
});

describe("--pipeline を省いた走りは v1 のまま（Issue #511）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makeClient の options に envelope が無く、要約の prompt_version が v1", async () => {
    const dir = `${directory}/v1-default`;
    const recording = createRecordingClient(recordedRun());
    const makeClient = vi.fn((_options: Record<string, unknown>) => recording.client);
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const lines: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(EXIT_OK);
    expect(v11aSpy).not.toHaveBeenCalled();
    expect(makeClient.mock.calls[0]).toEqual([{ apiKey: "sk-FAKE", model: "gpt-6-luna", effort: "high" }]);
    expect(makeClient.mock.calls[0]?.[0]).not.toHaveProperty("envelope");
    const summary = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(summary["prompt_version"]).toBe("v1");
  });
});

// ── 比較元のバイトの記録（手元の入口の分。v1.1α A6・Issue #511）────────────────────

interface CliBaselineFixture {
  readonly procedure: readonly string[];
  readonly baseCommit: string;
  readonly definitions: BaselineCliScenarios;
  readonly captures: readonly BaselineCliCapture[];
}

const cliBaseline = JSON.parse(
  await fs.readFile(new URL("./__fixtures__/baseline-2cd1586/cli.json", import.meta.url).pathname, "utf8"),
) as CliBaselineFixture;

describe("--pipeline を省いた入口は、凍結した比較元（2cd1586）のバイトの記録と同じ（Issue #511）", () => {
  it("記録に 4 経路（完走・修復あり・早期停止・差し戻し）・取り方の手順・比較元の完全な SHA がある", () => {
    expect(cliBaseline.baseCommit).toBe("2cd1586f856fb1cdecf75ef035826cbffe539e69");
    expect(cliBaseline.procedure.length).toBeGreaterThan(0);
    expect(cliBaseline.procedure.join("\n")).toContain(cliBaseline.baseCommit);
    expect(cliBaseline.captures.map((capture) => capture.name)).toEqual([
      "complete",
      "repair",
      "early-stop",
      "return-to-plan",
    ]);
    // 4 経路は、それぞれの終わり方になっている（完走・修復ありは 0、早期停止は 1、差し戻しは 3）
    expect(cliBaseline.captures.map((capture) => capture.exitCode)).toEqual([
      EXIT_OK,
      EXIT_OK,
      EXIT_RUN_FAILED,
      EXIT_RETURN_TO_PLAN,
    ]);
    const repair = cliBaseline.captures[1]!.requests as readonly { readonly tools?: unknown }[];
    expect(repair.some((body) => body.tools !== undefined)).toBe(true);
    expect(cliBaseline.captures[2]!.manifest).toBeNull();
  });

  it("記録の JSON に鍵の値・題材の言葉が無い", async () => {
    const text = await fs.readFile(
      new URL("./__fixtures__/baseline-2cd1586/cli.json", import.meta.url).pathname,
      "utf8",
    );
    for (const word of ["baseline-fake-key", "sk-", "Bearer", "持ち寄り", "当番表", "会費", "出欠", "貸し出し"]) {
      expect(text.includes(word), word).toBe(false);
    }
  });

  it("4 経路を同じ道具で候補に流すと、body・全ファイルの SHA-256 と manifest・要約・終了コードが記録と深く等しい", async () => {
    const captures = await captureCliBaseline(factory, cliBaseline.definitions);
    expect(captures).toHaveLength(cliBaseline.captures.length);
    for (const [index, capture] of captures.entries()) {
      const expected = cliBaseline.captures[index]!;
      // 経路ごとに比べる（落ちたときにどの経路かが分かる）。最後に全体も深く等しいことを確かめる
      expect(capture.clientOptions, capture.name).toEqual(expected.clientOptions);
      expect(capture.requests, capture.name).toEqual(expected.requests);
      expect(capture.files, capture.name).toEqual(expected.files);
      expect(capture.manifest, capture.name).toEqual(expected.manifest);
      expect(capture.summary, capture.name).toBe(expected.summary);
      expect(capture.exitCode, capture.name).toBe(expected.exitCode);
    }
    expect(captures).toEqual(cliBaseline.captures);
    // v1 の走りでは makeClient の options に envelope が無い
    for (const capture of captures) {
      for (const options of capture.clientOptions) expect(options, capture.name).not.toHaveProperty("envelope");
    }
  });
});
