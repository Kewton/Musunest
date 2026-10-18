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
  EXIT_STAGE_INPUT,
  EXIT_USAGE,
  JEV_API_KEY_ENV,
  PROMPT_VERSION_V11A,
  PROMPT_VERSION_V12,
  STAGE_USAGE,
  USAGE,
  parseCliArguments,
  runCli,
} from "./cli.js";
import { BUILD_CLI_RECORD_FILE, PLAN_ONLY_RESULT_SCHEMA } from "./cli-plan.js";
import * as factory from "./index.js";
import { createFakeJudge } from "./judge-fake.js";
import type { JudgeAnswer } from "./judge.js";
import { uncheckedBecause, type RecordedCall } from "./llm-fake.js";
import { createOpenAiLlmClient } from "./openai.js";
import { FIELD_REPAIR_SCHEMA_NAME } from "./v12/stages/field-repair.js";
import {
  ENVELOPE_SCHEMA,
  ENVELOPE_SCHEMA_NAME,
  ENVELOPE_SCHEMA_NAME_V11A,
  ENVELOPE_SCHEMA_V11A,
  STAGE_ENVELOPE_ENTRIES,
  STAGE_ENVELOPE_ENTRIES_V11A,
  STAGE_ENVELOPE_ENTRIES_V12,
  buildStageBranch,
  type EnvelopeId,
} from "./schema-envelope.js";
import { requirementsFromPlan, type RequirementList } from "./pipeline.js";
import { captureCliBaseline, type BaselineCliCapture, type BaselineCliScenarios } from "./__tests__/baseline-capture.js";
import {
  STAGE_INPUT_CODES,
  STAGE_RUN_RECORD_FILE,
  stageCheckpointFile,
  stageOutputDigest,
  V11A_ARTIFACT_NAMES,
  type StageInputCode,
} from "./v11a/bundle-v11a.js";
import * as v11aRunModule from "./v11a/run.js";
import {
  ENUM_MEMBERSHIP_REQUEST_DIFF,
  FIXTURE_DOCUMENTS,
  FIXTURE_YAML,
  LEDGER_REQUEST_DIFF,
  LEDGER_VIEW_2B,
  LEDGER_VIEW_2C,
  WHEN_NON_REQUIREMENT_REQUEST_DIFF,
  createCheckedRecordingClient,
  draftOf,
  fixtureList,
  fixtureTable,
  requestDiffsOf,
  t1ResponseOf,
  withAggregates,
  withoutEnumMembership,
  withoutLedgerAdditions,
  withoutWhenAndNonRequirement,
} from "./v11a/__tests__/fixtures.js";
import * as ledgerModule from "./v12/ledger.js";
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

  it("--pipeline v1.2 --plan-file <ファイル> を読む（Issue #547）", () => {
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--pipeline", "v1.2", "--plan-file", "plan.json"]),
    ).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      planFile: "plan.json",
      pipeline: "v1.2",
    });
    expect(USAGE).toContain("[--pipeline v1|v1.1a|v1.2]");
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
    { name: "知らない値", args: ["--pipeline", "v2"], error: "--pipeline には v1 か v1.1a か v1.2 を指定してください" },
    { name: "値が無い", args: ["--pipeline"], error: "--pipeline には v1 か v1.1a か v1.2 を指定してください" },
    {
      name: "--pipeline v1.2 だけ（--plan-file が無い）",
      args: ["--pipeline", "v1.2"],
      error: "--pipeline v1.2 は --plan-file と一緒に指定してください",
    },
    {
      name: "--pipeline v1.2 と --plan",
      args: ["--pipeline", "v1.2", "--plan"],
      error: "--pipeline と --plan は同時に指定できません",
    },
    {
      name: "--pipeline v1.2 と --plan-only",
      args: ["--pipeline", "v1.2", "--plan-only"],
      error: "--pipeline と --plan-only は同時に指定できません",
    },
    {
      name: "--pipeline v1.2 と --plan と --plan-file",
      args: ["--pipeline", "v1.2", "--plan", "--plan-file", "plan.json"],
      error: "--plan と --plan-file は同時に指定できません",
    },
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

/** T1 の応答（strict の schema に合う形）。旗 on（`ledgerOn`）は計算の行に集計の種類と集計元を持つ台帳の schema に合わせる */
const v11aT1 = (ledgerOn = false, table: NameTable = V11A_TABLE): Record<string, unknown> =>
  t1ResponseOf(draftOf(V11A_LIST, ledgerOn ? withAggregates(table) : table), ledgerOn ? ledgerModule.PROPERTY_LEDGER_VIEW : undefined);

/** T1・T1''・T2・B1 の記録（完走の道の頭） */
const v11aHead = (): RecordedCall[] => [
  structured(v11aT1()),
  structured(v11aJudgments()),
  structured(v11aTestSpec()),
  structured({ declaration: V11A_YAML }),
];

/**
 * v1.2（旗 on）の走りの頭。T1 の応答の計算の行に集計の種類と集計元を持つ（今の台帳の strict の schema で必須。Issue #549）。
 * ほかは `v11aHead` と同じ
 */
const v12Head = (): RecordedCall[] => [
  structured(v11aT1(true)),
  ...v11aHead().slice(1),
];

/** T1' に落ちる下書き（要件の写しを入れ替える） */
function v11aBadDraft(): unknown {
  const draft = draftOf(V11A_LIST, V11A_TABLE);
  return {
    ...draft,
    requirements: draft.requirements.map((entry, index) => (index === 0 ? { ...entry, copy: "目印の値の写し" } : entry)),
  };
}

/**
 * `v11aBadDraft` の記録。直す前（fb9e122）の記録とバイト列で同じにする経路（`early-stop`）が、やり直しの要求に
 * 前回の応答を写すので、A1 の形のまま使う（strict の schema の形に直さない）。照合を外す。
 */
const v11aBadDraftCall = (): RecordedCall => ({
  ...(structured(v11aBadDraft()) as Extract<RecordedCall, { kind: "structured" }>),
  unchecked: uncheckedBecause(
    "直す前（fb9e122）の記録とバイト列で同じにする経路の応答。T1 の応答が A1 の形（type が欄を並べた写像でない）で、strict の schema の形ではない。記録は手で直さない",
  ),
});

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

/** `--pipeline v1.1a --plan-file` を 1 回流す（偽物の LLM・判定・時計で閉じる。ファイルだけ本物。`pipeline` で v1.2 も） */
async function runV11aCli(input: {
  readonly dir: string;
  readonly calls: readonly RecordedCall[];
  readonly pipeline?: "v1.1a" | "v1.2";
}) {
  const planPath = `${input.dir}-plan.json`;
  const planText = JSON.stringify(await v11aEnvelope());
  const recording = createCheckedRecordingClient(input.calls);
  const makeClient = vi.fn((_options: { readonly envelope?: EnvelopeId }) => recording.client);
  const lines: string[] = [];
  const written: string[] = [];
  const code = await runCli({
    argv: ["--", "request.txt", "--out", input.dir, "--pipeline", input.pipeline ?? "v1.1a", "--plan-file", planPath],
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

/** 実 adapter に当てた 1 回の構造化出力（段が渡した要求と、実際に送った body） */
interface WireExchange {
  readonly request: LlmStructuredRequest;
  readonly body: Record<string, unknown>;
}

/**
 * 段が渡した要求を、実 adapter（`createOpenAiLlmClient`）に偽物の fetch を当てて送り、送信の body を取る
 * （外部の API は呼ばない。偽物の fetch は body を残して 500 を返すので、adapter の誤りは捨てる。Issue #549 の直し）。
 * 封筒は、入口が adapter に渡した `envelope` で選ぶ。
 */
async function sentExchangesOf(
  requests: readonly LlmStructuredRequest[],
  envelope: EnvelopeId | undefined,
): Promise<WireExchange[]> {
  const exchanges: WireExchange[] = [];
  for (const request of requests) {
    let sent: Record<string, unknown> | undefined;
    const client = createOpenAiLlmClient({
      apiKey: "sk-FAKE",
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ error: { code: "server_error" } }), { status: 500 });
      },
      ...(envelope === undefined ? {} : { envelope }),
    });
    const { signal: _signal, ...unsignalled } = request;
    await expect(client.callStructured(unsignalled)).rejects.toThrow();
    expect(sent, request.schemaName).toBeDefined();
    exchanges.push({ request, body: sent as Record<string, unknown> });
  }
  return exchanges;
}

/** 送った body の封筒から、その段の枝を引く（封筒でなければ text.format.schema そのもの） */
function sentBranchOf(exchange: WireExchange): unknown {
  const format = (exchange.body["text"] as { readonly format: { readonly name: string; readonly schema: Record<string, unknown> } }).format;
  if (format.name === exchange.request.schemaName) return format.schema;
  const anyOf = (format.schema["properties"] as { readonly result: { readonly anyOf: readonly Record<string, unknown>[] } }).result.anyOf;
  const branches = anyOf.filter(
    (branch) => (branch["properties"] as { readonly stage: { readonly enum: readonly string[] } }).stage.enum[0] === exchange.request.schemaName,
  );
  expect(branches, exchange.request.schemaName).toHaveLength(1);
  return branches[0];
}

/** その要求について、モデルに届く形（封筒ならその段の枝）が、段が渡した schema（封筒なら stage を足した枝）と深く等しいか */
function expectSentSchemaIsStageSchema(exchange: WireExchange): void {
  const format = (exchange.body["text"] as { readonly format: { readonly name: string } }).format;
  const stageSchema = JSON.parse(JSON.stringify(exchange.request.schema)) as unknown;
  const expected =
    format.name === exchange.request.schemaName
      ? stageSchema
      : buildStageBranch({ stage: exchange.request.schemaName, schema: stageSchema });
  expect(sentBranchOf(exchange), exchange.request.schemaName).toEqual(expected);
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
    const run = await runV11aCli({ dir, calls: [v11aBadDraftCall(), v11aBadDraftCall()] });

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

describe("v1.2 の走り（`--pipeline v1.2 --plan-file`。Issue #547）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("完走で 0：v1.1α の経路で流れ、要求の差は台帳の enum-membership（#548）と empty-aggregate（#549）の行の分だけ（名指しの場所）。条件の記録の pipeline・prompt_version が v1.2、ほかの欄は v1.1a と同じ", async () => {
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const v1Spy = vi.spyOn(runModule, "runGeneration");
    const calls = [...v11aHead(), structured(v11aJudgments())];
    const v12 = await runV11aCli({ dir: `${directory}/v12-complete`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    const v11a = await runV11aCli({ dir: `${directory}/v12-complete-v11a`, calls });

    expect(v12.code).toBe(EXIT_OK);
    expect(v1Spy).not.toHaveBeenCalled();
    expect(v11aSpy).toHaveBeenCalledTimes(2);
    expect(v12.makeClient.mock.calls[0]).toEqual([{ apiKey: "sk-FAKE", model: "gpt-6-luna", effort: "high", envelope: "v1.2" }]);
    // LLM への要求は、v1.2 の旗で台帳に登録した性質（enum-membership。Issue #548・empty-aggregate。Issue #549）の分を除けば
    // v1.1a の走りとバイト列で同じ。差は名指しの場所（R-nt-08・R-sc-02・R-tsp-02・R-tsp-16・R-w11 の並び・schema の enum・
    // T1 の schema の行の型の aggregate、表を載せるデータの計算の行の aggregate）だけで、空でない
    const onRequests = JSON.parse(JSON.stringify(v12.recording.structured)) as unknown[];
    const offRequests = JSON.parse(JSON.stringify(v11a.recording.structured)) as unknown[];
    expect(onRequests).toHaveLength(offRequests.length);
    const diffs = requestDiffsOf(onRequests, offRequests);
    const withInput = (paths: readonly string[]): readonly string[] => {
      const at = paths.findIndex((path) => path.startsWith("$.schema"));
      return at < 0 ? [...paths, "$.input"] : [...paths.slice(0, at), "$.input", ...paths.slice(at)];
    };
    for (const diff of diffs) {
      const named = LEDGER_REQUEST_DIFF[diff.schemaName] ?? [];
      // T1''・T2・B1・B3' は名前の表（計算の行の aggregate）を載せるデータが違う。T1 の 1 回目は表を載せない
      expect(diff.paths, diff.schemaName).toEqual(diff.schemaName === "name-table" ? named : withInput(named));
    }
    expect(diffs.filter((diff) => diff.paths.length > 0).map((diff) => diff.schemaName)).toEqual([...Object.keys(LEDGER_REQUEST_DIFF), "decl-check"]);
    expect(JSON.stringify(withoutLedgerAdditions(onRequests))).toBe(JSON.stringify(v11a.recording.structured));
    // #548 までの旗 on（台帳に empty-aggregate の行が無い）は、同じ応答で差が enum-membership の行の分だけ（今までの期待）
    const spy = vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? LEDGER_VIEW_2B : undefined));
    const v12Before = await runV11aCli({ dir: `${directory}/v12-complete-2b`, calls, pipeline: "v1.2" });
    spy.mockRestore();
    const beforeRequests = JSON.parse(JSON.stringify(v12Before.recording.structured)) as unknown[];
    const beforeDiffs = requestDiffsOf(beforeRequests, offRequests);
    for (const diff of beforeDiffs) expect(diff.paths, diff.schemaName).toEqual(ENUM_MEMBERSHIP_REQUEST_DIFF[diff.schemaName] ?? []);
    expect(beforeDiffs.filter((diff) => diff.paths.length > 0).map((diff) => diff.schemaName)).toEqual(Object.keys(ENUM_MEMBERSHIP_REQUEST_DIFF));
    expect(JSON.stringify(withoutEnumMembership(beforeRequests))).toBe(JSON.stringify(v11a.recording.structured));
    expect(v12Before.summary).toEqual(v12.summary);
    // #549 までの旗 on（台帳の when の列が未定義・non-requirement の行が無い。Issue #550）は、同じ応答で今の on との差が
    // when・non-requirement の行の分（R-nt-08・R-sc-02・R-tsp-16・T1 の schema の確かめ方の種類の enum）だけ
    const spy2C = vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? LEDGER_VIEW_2C : undefined));
    const v12Before2C = await runV11aCli({ dir: `${directory}/v12-complete-2c`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    spy2C.mockRestore();
    const before2CRequests = JSON.parse(JSON.stringify(v12Before2C.recording.structured)) as unknown[];
    const diffs2C = requestDiffsOf(onRequests, before2CRequests);
    for (const diff of diffs2C) expect(diff.paths, diff.schemaName).toEqual(WHEN_NON_REQUIREMENT_REQUEST_DIFF[diff.schemaName] ?? []);
    expect(diffs2C.filter((diff) => diff.paths.length > 0).map((diff) => diff.schemaName)).toEqual(Object.keys(WHEN_NON_REQUIREMENT_REQUEST_DIFF));
    expect(JSON.stringify(withoutWhenAndNonRequirement(onRequests))).toBe(JSON.stringify(before2CRequests));
    expect(v12Before2C.code).toBe(v12.code);
    expect(v12Before2C.summary).toEqual(v12.summary);
    expect(v12Before2C.record.conditions).toEqual(v12.record.conditions);
    expect(v12.summary["verdict"]).toBe("full");
    expect(v12.summary["prompt_version"]).toBe(PROMPT_VERSION_V12);
    expect(v12.summary["prompt_version"]).toBe("v1.2");
    expect(v12.record.conditions["pipeline"]).toBe("v1.2");
    expect(v12.record.conditions["prompt_version"]).toBe("v1.2");
    const { pipeline: _pipeline, prompt_version: _v12Prompt, v12_flags: _flags, ...v12Rest } = v12.record.conditions;
    const { prompt_version: v11aPrompt, ...v11aRest } = v11a.record.conditions;
    expect(v11aPrompt).toBe("v1.1a");
    expect(v12Rest).toEqual(v11aRest);
    // 要約は prompt_version と v12_flags のほかは v1.1a と同じ
    const { prompt_version: _p1, v12_flags: _f1, ...summaryRest } = v12.summary;
    const { prompt_version: _p2, ...v11aSummaryRest } = v11a.summary;
    expect(summaryRest).toEqual(v11aSummaryRest);
  });

  it("旗の組の契約：export した V12_PIPELINE_FLAGS＝入口が渡した実効の旗＝要約の v12_flags＝条件の記録の v12_flags", async () => {
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const run = await runV11aCli({ dir: `${directory}/v12-flags`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    const passed = v11aSpy.mock.calls[0]?.[0];
    expect(passed?.flags).toEqual(factory.fromPublicV12Flags(factory.V12_PIPELINE_FLAGS));
    expect(passed?.flags).toEqual({ ledger: true, searchRepair: true });
    expect(passed?.recordV12Flags).toBe(true);
    expect(run.summary["v12_flags"]).toEqual(factory.V12_PIPELINE_FLAGS);
    expect(run.record.conditions["v12_flags"]).toEqual(factory.V12_PIPELINE_FLAGS);
    expect(run.summary["v12_flags"]).toEqual(factory.toPublicV12Flags(factory.resolveV12Flags(passed?.flags)));
    expect(factory.V12_PIPELINE_FLAGS).toEqual({ ledger: true, "search-repair": true });
    // 要約・条件の記録の旗の組は公開の鍵で ledger と search-repair が on（Issue #551）
    expect(run.summary["v12_flags"]).toEqual({ ledger: true, "search-repair": true });
    expect(run.record.conditions["v12_flags"]).toEqual({ ledger: true, "search-repair": true });
  });

  it("T1 で止まる走りでも要約と条件の記録に v12_flags がある（終了コード 1・納品物無し）", async () => {
    const run = await runV11aCli({
      dir: `${directory}/v12-early-stop`,
      calls: [v11aBadDraftCall(), v11aBadDraftCall()],
      pipeline: "v1.2",
    });
    expect(run.code).toBe(EXIT_RUN_FAILED);
    expect(run.written).not.toContain(BUNDLE_MANIFEST_FILE);
    expect(run.summary["stop_reason"]).toBe("unmet");
    expect(run.summary["prompt_version"]).toBe("v1.2");
    expect(run.summary["v12_flags"]).toEqual(factory.V12_PIPELINE_FLAGS);
    expect(run.record.conditions["v12_flags"]).toEqual(factory.V12_PIPELINE_FLAGS);
  });

  it("--pipeline v1.1a の走りの要約・条件の記録に v12_flags・pipeline が無く、旗を渡さない", async () => {
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const run = await runV11aCli({ dir: `${directory}/v11a-no-flags`, calls: [...v11aHead(), structured(v11aJudgments())] });
    expect(run.summary).not.toHaveProperty("v12_flags");
    expect(run.record.conditions).not.toHaveProperty("v12_flags");
    expect(run.record.conditions).not.toHaveProperty("pipeline");
    expect(v11aSpy.mock.calls[0]?.[0]).not.toHaveProperty("flags");
    expect(v11aSpy.mock.calls[0]?.[0]).not.toHaveProperty("recordV12Flags");
  });

  it("段の旗は v1.2 と組めない（今の段の走りは --pipeline v1.1a だけ。使い方の誤りで 2）", () => {
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-end", "test-spec"]),
    ).toEqual({ error: "stage-range:pipeline（段の旗は --pipeline v1.1a --plan-file と一緒に指定してください）" });
  });
});

describe("封筒の枝は段が渡した schema と深く等しい（実 adapter・偽物の fetch。Issue #549 の直し）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 封筒に載る段は、起動時に組んだ封筒ではなく、その走りの段の schema（旗 on は台帳から導いたもの）で送る。
  // 段の検証と、モデルに届く形がずれる共通の原因を、送信の body で塞ぐ（旗 off・on・v1 の全段）。
  const v11aStages = STAGE_ENVELOPE_ENTRIES_V11A.map((entry) => entry.stage);

  const v12ReturnToPlan = (): RecordedCall[] => [structured(v11aT1(true)), ...v11aReturnToPlan().slice(1)];

  /** 走りの段の要求を、入口が作った adapter の封筒で送り直した組（`--pipeline v1.2` は v1.2 の封筒。Issue #588） */
  async function exchangesOfRun(run: Awaited<ReturnType<typeof runV11aCli>>, pipeline: "v1.1a" | "v1.2" = "v1.1a"): Promise<WireExchange[]> {
    const options = run.makeClient.mock.calls[0]?.[0];
    expect(options).toMatchObject({ envelope: pipeline });
    return sentExchangesOf(run.recording.structured, options?.envelope);
  }

  /** 完走と差し戻しの道（`--pipeline` ごとの応答の列） */
  const routesOf = (pipeline: "v1.1a" | "v1.2") => [
    { name: "complete", calls: [...(pipeline === "v1.2" ? v12Head() : v11aHead()), structured(v11aJudgments())] },
    { name: "return", calls: pipeline === "v1.2" ? v12ReturnToPlan() : v11aReturnToPlan() },
  ];

  for (const pipeline of ["v1.1a", "v1.2"] as const) {
    it(`${pipeline}：完走と差し戻しの道で、封筒に載る全段の送信の枝が段の schema と等しい`, async () => {
      const seen = new Set<string>();
      for (const route of routesOf(pipeline)) {
        const run = await runV11aCli({ dir: `${directory}/wire-${pipeline}-${route.name}`, calls: route.calls, pipeline });
        const exchanges = await exchangesOfRun(run, pipeline);
        expect(exchanges.length, route.name).toBeGreaterThan(0);
        for (const exchange of exchanges) {
          expectSentSchemaIsStageSchema(exchange);
          seen.add(exchange.request.schemaName);
        }
      }
      // 封筒に載る v1.1α の全段を照らした
      expect([...seen].filter((stage) => v11aStages.includes(stage)).sort()).toEqual([...v11aStages].sort());
    });
  }

  // ── 封筒に載らない段の名前の許可の一覧（Issue #590）──────────────────────────────
  //
  // 構造化出力に使う schema の名前は、その経路の封筒に載っているか、封筒の外で送る段の許可の一覧にある。
  // どちらにも無い名前は、封筒の枝が無いまま段の schema を直に送る段（adapter は封筒に載らない名前をそのまま送る）で、
  // 段の検証と送る形のずれ（v12-cmp2 の型）が封筒の試験の外に出る。段を足すときは、封筒に載せるか、ここに理由つきで足す。
  const OUTSIDE_ENVELOPE_STAGES: Readonly<Record<string, string>> = {
    "judge-answers": "判定の口（J2・J4）。応答は判定の答えの写像で、段の応答の封筒を使わない",
    [FIELD_REPAIR_SCHEMA_NAME]: "手 4b の欄だけの直し。要素ごとの置き換えを返す段で、封筒の外で送る",
  };

  /** 観測した名前のうち、封筒の一覧にも許可の一覧にも無いもの */
  const unlistedNames = (observed: Iterable<string>, envelopeStages: readonly string[]): string[] =>
    [...new Set(observed)].filter((name) => !envelopeStages.includes(name) && !(name in OUTSIDE_ENVELOPE_STAGES)).sort();

  for (const pipeline of ["v1.1a", "v1.2"] as const) {
    it(`${pipeline}：完走と差し戻しの走りで観測した構造化出力の名前は、封筒の一覧か許可の一覧にある。許可に無い名前を足した段は落ちる`, async () => {
      const envelopeStages = (pipeline === "v1.2" ? STAGE_ENVELOPE_ENTRIES_V12 : STAGE_ENVELOPE_ENTRIES_V11A).map((entry) => entry.stage);
      const observed = new Set<string>();
      for (const route of routesOf(pipeline)) {
        const run = await runV11aCli({ dir: `${directory}/names-${pipeline}-${route.name}`, calls: route.calls, pipeline });
        for (const request of run.recording.structured) observed.add(request.schemaName);
      }
      expect(observed.size).toBeGreaterThan(0);
      expect(unlistedNames(observed, envelopeStages)).toEqual([]);
      // 二点測定：許可の一覧に無い名前を 1 つ足した偽物の段は、同じ照合で落ちる
      expect(unlistedNames([...observed, "stage-not-listed"], envelopeStages)).toEqual(["stage-not-listed"]);
    });
  }

  it("v1.2：送信の body の T1 の枝の行の型に aggregate があり、v1.1a の T1 の枝には無い", async () => {
    const typeOf = (exchanges: readonly WireExchange[]) => {
      const exchange = exchanges.find((candidate) => candidate.request.schemaName === "name-table");
      expect(exchange).toBeDefined();
      const branch = sentBranchOf(exchange as WireExchange) as {
        readonly properties: { readonly rows: { readonly items: { readonly properties: { readonly type: { readonly required: readonly string[]; readonly properties: Record<string, unknown> } } } } };
      };
      return branch.properties.rows.items.properties.type;
    };
    const on = await runV11aCli({ dir: `${directory}/wire-t1-on`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    const onType = typeOf(await exchangesOfRun(on, "v1.2"));
    expect(onType.properties).toHaveProperty("aggregate");
    expect(onType.required).toContain("aggregate");
    const off = await runV11aCli({ dir: `${directory}/wire-t1-off`, calls: [...v11aHead(), structured(v11aJudgments())] });
    const offType = typeOf(await exchangesOfRun(off));
    expect(offType.properties).not.toHaveProperty("aggregate");
    expect(offType.required).not.toContain("aggregate");
  });

  it("v1：封筒に載る段の送信の枝が段の schema と等しく、送る封筒は起動時の定数のまま", async () => {
    const recording = createRecordingClient(recordedRun());
    const makeClient = vi.fn((_options: { readonly envelope?: EnvelopeId }) => recording.client);
    const code = await runCli({
      argv: ["--", "request.txt", "--out", `${directory}/wire-v1`],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient,
      log: () => undefined,
    });
    expect(code).toBe(EXIT_OK);
    const exchanges = await sentExchangesOf(recording.structured, makeClient.mock.calls[0]?.[0].envelope);
    const v1Stages = STAGE_ENVELOPE_ENTRIES.map((entry) => entry.stage);
    const enveloped = exchanges.filter((exchange) => v1Stages.includes(exchange.request.schemaName));
    expect(enveloped.length).toBeGreaterThan(0);
    for (const exchange of exchanges) expectSentSchemaIsStageSchema(exchange);
    for (const exchange of enveloped) {
      expect((exchange.body["text"] as { readonly format: unknown }).format).toEqual({
        type: "json_schema",
        name: ENVELOPE_SCHEMA_NAME,
        schema: ENVELOPE_SCHEMA,
        strict: true,
      });
    }
  });

  /** 送った body の `text.format`（名前と schema） */
  const formatOf = (exchange: WireExchange) =>
    (exchange.body["text"] as { readonly format: { readonly name: string; readonly schema: Record<string, unknown> } }).format;

  it("v1.2：完走と差し戻しの道で、封筒に載る 6 段すべての送信の名前と schema のバイト列が同じで、名前が stage-envelope-v12（Issue #588）", async () => {
    const v12Stages = STAGE_ENVELOPE_ENTRIES_V12.map((entry) => entry.stage);
    expect(v12Stages).toHaveLength(6);
    const seen = new Set<string>();
    const sent = new Set<string>();
    for (const route of routesOf("v1.2")) {
      const run = await runV11aCli({ dir: `${directory}/wire-one-v12-${route.name}`, calls: route.calls, pipeline: "v1.2" });
      const exchanges = await exchangesOfRun(run, "v1.2");
      for (const exchange of exchanges) {
        expectSentSchemaIsStageSchema(exchange);
        const format = formatOf(exchange);
        if (!v12Stages.includes(exchange.request.schemaName)) {
          // 封筒に載らない口（判定の口など）は、その schema をそのまま送る
          expect(format.name, exchange.request.schemaName).toBe(exchange.request.schemaName);
          continue;
        }
        expect(format.name, exchange.request.schemaName).toBe("stage-envelope-v12");
        sent.add(JSON.stringify({ name: format.name, schema: format.schema }));
        seen.add(exchange.request.schemaName);
      }
    }
    // 6 段を照らし、全段の送信が 1 種類の前置き（名前と schema のバイト列）
    expect([...seen].sort()).toEqual([...v12Stages].sort());
    expect(sent.size).toBe(1);
  });

  it("v1.1a：同じ道の送信の封筒は直す前と同じ（名前 stage-envelope-v11a・schema が v1.1α の封筒の定数。Issue #588）", async () => {
    const seen = new Set<string>();
    for (const route of routesOf("v1.1a")) {
      const run = await runV11aCli({ dir: `${directory}/wire-same-v11a-${route.name}`, calls: route.calls });
      for (const exchange of await exchangesOfRun(run, "v1.1a")) {
        if (!v11aStages.includes(exchange.request.schemaName)) continue;
        expect(exchange.body["text"], exchange.request.schemaName).toEqual({
          format: { type: "json_schema", name: ENVELOPE_SCHEMA_NAME_V11A, schema: ENVELOPE_SCHEMA_V11A, strict: true },
        });
        expect(JSON.stringify(formatOf(exchange).schema)).toBe(JSON.stringify(ENVELOPE_SCHEMA_V11A));
        seen.add(exchange.request.schemaName);
      }
    }
    expect([...seen].sort()).toEqual([...v11aStages].sort());
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
    expect(summary).not.toHaveProperty("v12_flags");
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

// ── 段単位の実行口（Issue #544）：旗を省いた v1.1α の走りは、直す前の記録とバイト列で同じ ──────────────

/** 直す前の v1.1α の走りの記録の 1 経路 */
interface V11aBeforeCapture {
  readonly name: string;
  /** `makeClient` に渡った options（鍵を除く） */
  readonly clientOptions: readonly unknown[];
  /** LLM への要求の列（種別・schema 名・締切の合図を外した要求の JSON の SHA-256） */
  readonly requests: readonly { readonly kind: string; readonly schemaName: string | null; readonly sha256: string }[];
  /** 入口が書いた全ファイル（`--out` からの相対パス。書いた順） */
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly sizeBytes: number }[];
  /** 出した行（最後の行が要約） */
  readonly lines: readonly string[];
  readonly exitCode: number;
}

/** 直す前の記録を取る経路（合成の応答。題材は v1.1α の共通の題材） */
const V11A_BEFORE_SCENARIOS: readonly { readonly name: string; readonly calls: () => readonly RecordedCall[] }[] = [
  { name: "complete", calls: () => [...v11aHead(), structured(v11aJudgments())] },
  { name: "early-stop", calls: () => [v11aBadDraftCall(), v11aBadDraftCall()] },
  { name: "return-to-plan", calls: () => v11aReturnToPlan() },
  {
    name: "stagnation",
    calls: () => [
      ...v11aHead(),
      structured(v11aJudgments({ R3: ["mismatch", "金額が 0 より大きい項目だけ"] })),
      { kind: "tools", response: { kind: "done", declaration: { declaration: V11A_YAML, disputes: [] }, usage: undefined } },
      structured(v11aJudgments({ R3: ["mismatch", "金額が 0 より大きい項目だけ"] })),
    ],
  },
];

/** 要求から締切の合図（値を持たない）を外して JSON にする */
const requestText = (request: object): string => {
  const { signal: _signal, ...rest } = request as { readonly signal?: unknown };
  return JSON.stringify(rest);
};

/** 旗を省いた `--pipeline v1.1a --plan-file` を 1 経路流し、観測した値を返す（ファイルは手元の写像で閉じる） */
async function captureV11aCli(
  entry: typeof runCli,
  scenario: (typeof V11A_BEFORE_SCENARIOS)[number],
): Promise<V11aBeforeCapture> {
  const planText = JSON.stringify(await v11aEnvelope());
  const recording = createRecordingClient(scenario.calls());
  const order: { readonly kind: "structured" | "tools"; readonly request: object }[] = [];
  const client: LlmClient = {
    async callStructured<T>(request: LlmStructuredRequest) {
      order.push({ kind: "structured", request });
      return recording.client.callStructured<T>(request);
    },
    async callWithTools(request) {
      order.push({ kind: "tools", request });
      return recording.client.callWithTools(request);
    },
  };
  const clientOptions: unknown[] = [];
  const written: { readonly path: string; readonly text: string }[] = [];
  const lines: string[] = [];
  const exitCode = await entry({
    argv: ["--", "request.txt", "--out", "out", "--pipeline", "v1.1a", "--plan-file", "plan.json"],
    env: { [API_KEY_ENV]: "sk-FAKE" },
    readFile: async (path) => (path === "plan.json" ? planText : V11A_SOURCE),
    writeFile: async (path, text) => {
      written.push({ path: path.slice("out/".length), text });
    },
    makeDirectory: async () => {},
    loadDocuments: async () => FIXTURE_DOCUMENTS,
    makeClient: (options) => {
      clientOptions.push(Object.fromEntries(Object.entries(options).filter(([key]) => key !== "apiKey")));
      return client;
    },
    makeLlmJudge: () => v11aJudge(),
    now: () => 0,
    log: (line) => lines.push(line),
  });
  return {
    name: scenario.name,
    clientOptions,
    requests: await Promise.all(
      order.map(async ({ kind, request }) => ({
        kind,
        schemaName: kind === "structured" ? (request as LlmStructuredRequest).schemaName : null,
        sha256: await sha256Hex(requestText(request)),
      })),
    ),
    files: await Promise.all(
      written.map(async (file) => ({
        path: file.path,
        sha256: await sha256Hex(file.text),
        sizeBytes: new TextEncoder().encode(file.text).length,
      })),
    ),
    lines,
    exitCode,
  };
}

interface V11aBeforeFixture {
  readonly procedure: readonly string[];
  readonly baseCommit: string;
  readonly captures: readonly V11aBeforeCapture[];
}

const v11aBefore = JSON.parse(
  await fs.readFile(new URL("./__fixtures__/v11a-before-stage-range/run.json", import.meta.url).pathname, "utf8"),
) as V11aBeforeFixture;

describe("旗を省いた v1.1α の走りは、直す前（fb9e122）の記録とバイト列で同じ（Issue #544）", () => {
  it("記録に 4 経路（完走・早期停止・差し戻し・停滞）と取り方の手順・直す前の完全な SHA がある", () => {
    expect(v11aBefore.baseCommit).toBe("fb9e122a81fd35a34d64a22865d7b744ffbcd9c8");
    expect(v11aBefore.procedure.join("\n")).toContain(v11aBefore.baseCommit);
    expect(v11aBefore.captures.map((capture) => capture.name)).toEqual(V11A_BEFORE_SCENARIOS.map((scenario) => scenario.name));
    expect(v11aBefore.captures.map((capture) => capture.exitCode)).toEqual([
      EXIT_OK,
      EXIT_RUN_FAILED,
      EXIT_RETURN_TO_PLAN,
      EXIT_OK,
    ]);
  });

  it("4 経路を候補の入口に流すと、要求の列・全ファイルの SHA-256・出した行・終了コードが記録と深く等しく、checkpoint を書かない", async () => {
    for (const [index, scenario] of V11A_BEFORE_SCENARIOS.entries()) {
      const capture = await captureV11aCli(runCli, scenario);
      const expected = v11aBefore.captures[index]!;
      expect(capture.clientOptions, scenario.name).toEqual(expected.clientOptions);
      expect(capture.requests, scenario.name).toEqual(expected.requests);
      expect(capture.files, scenario.name).toEqual(expected.files);
      expect(capture.lines, scenario.name).toEqual(expected.lines);
      expect(capture.exitCode, scenario.name).toBe(expected.exitCode);
      expect(capture, scenario.name).toEqual(expected);
      for (const file of capture.files) expect(file.path, scenario.name).not.toMatch(/stage-/);
    }
  });

  it("記録の JSON に鍵の値・題材の言葉が無い", async () => {
    const text = await fs.readFile(
      new URL("./__fixtures__/v11a-before-stage-range/run.json", import.meta.url).pathname,
      "utf8",
    );
    for (const word of ["sk-FAKE", "Bearer", "持ち寄り", "当番表", "会費", "出欠", "貸し出し"]) {
      expect(text.includes(word), word).toBe(false);
    }
  });
});

// ── 段単位の実行口（`--stage-start`・`--stage-end`・`--stage-input`。08 §8.3・Issue #544）──────────────

/** 段の走りを 1 回流す（偽物の LLM・判定・時計で閉じる。`--out` と前の走りの出力だけ本物のファイル） */
async function runStageCli(input: {
  readonly dir: string;
  readonly args: readonly string[];
  readonly calls: readonly RecordedCall[];
  readonly envelope?: Record<string, unknown>;
  readonly source?: string;
}) {
  const planPath = `${input.dir}-plan.json`;
  const planText = JSON.stringify(input.envelope ?? (await v11aEnvelope()));
  const recording = createRecordingClient(input.calls);
  const order: string[] = [];
  const client: LlmClient = {
    async callStructured<T>(request: LlmStructuredRequest) {
      order.push(requestText(request));
      return recording.client.callStructured<T>(request);
    },
    async callWithTools(request) {
      order.push(requestText(request));
      return recording.client.callWithTools(request);
    },
  };
  const makeClient = vi.fn((_options: { readonly envelope?: EnvelopeId }) => client);
  const lines: string[] = [];
  const errors: string[] = [];
  const written: string[] = [];
  const directories: string[] = [];
  const code = await runCli({
    argv: ["--", "request.txt", "--out", input.dir, "--pipeline", "v1.1a", "--plan-file", planPath, ...input.args],
    env: { [API_KEY_ENV]: "sk-FAKE" },
    readFile: async (path) => {
      if (path === planPath) return planText;
      if (path === "request.txt") return input.source ?? V11A_SOURCE;
      return fs.readFile(path, "utf8");
    },
    writeFile: async (path, text) => {
      written.push(path.slice(input.dir.length + 1));
      await fs.writeFile(path, text, "utf8");
    },
    makeDirectory: async (path) => {
      directories.push(path);
      await fs.mkdir(path, { recursive: true });
    },
    loadDocuments: async () => FIXTURE_DOCUMENTS,
    makeClient,
    makeLlmJudge: () => v11aJudge(),
    now: () => 0,
    log: (line) => lines.push(line),
    logError: (line) => errors.push(line),
  });
  return { code, lines, errors, written, directories, makeClient, requests: order };
}

/** 段の走りの記録を読む */
async function stageRecordOf(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(`${dir}/${STAGE_RUN_RECORD_FILE}`, "utf8")) as Record<string, unknown>;
}

/** 旗を省いた通しの走りの要求の列（同じ偽物の応答） */
async function fullRunRequests(dir: string, calls: readonly RecordedCall[]) {
  const run = await runStageCli({ dir, args: [], calls });
  return { ...run, summary: JSON.parse(run.lines.at(-1) ?? "{}") as Record<string, unknown> };
}

/** 値の中の全部の鍵（深さ優先） */
function keysOf(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  }
  return [];
}

const V11A_REJECT_R3 = { R3: ["mismatch", "金額が 0 より大きい項目だけ"] as const };
const v11aRepairDone = (): RecordedCall => ({
  kind: "tools",
  response: { kind: "done", declaration: { declaration: V11A_YAML, disputes: [] }, usage: undefined },
});
/** B3' の拒否が残って停滞し、B が持ち越しを足す経路（T1〜⑦） */
const v11aStagnation = (): RecordedCall[] => [
  ...v11aHead(),
  structured(v11aJudgments(V11A_REJECT_R3)),
  v11aRepairDone(),
  structured(v11aJudgments(V11A_REJECT_R3)),
];
/** T1'' が R3 を 2 回とも拒否し、R3 を持ち越す T1〜T1'' の経路 */
const v11aRejectR3Head = (): RecordedCall[] => [
  structured(v11aT1()),
  structured(v11aJudgments({ R3: ["unnecessary-ownership", "締められる"] })),
  structured(v11aT1()),
  structured(v11aJudgments({ R3: ["unnecessary-ownership", "締められる"] })),
];

describe("段の旗の使い方の誤り（exit 2・固定の符号・API を呼ばない・何も書かない）", () => {
  const cases: readonly { readonly name: string; readonly argv: readonly string[]; readonly code: string }[] = [
    {
      name: "表に無い段",
      argv: ["--pipeline", "v1.1a", "--plan-file", "plan.json", "--stage-end", "decl-check"],
      code: "stage-range:unknown",
    },
    {
      name: "開始が終了より後",
      argv: ["--pipeline", "v1.1a", "--plan-file", "plan.json", "--stage-start", "write", "--stage-end", "test-spec", "--stage-input", "x.json"],
      code: "stage-range:order",
    },
    { name: "v1.1α の経路の旗が無い", argv: ["--plan-file", "plan.json", "--stage-end", "test-spec"], code: "stage-range:pipeline" },
    { name: "--plan-file が無い", argv: ["--stage-end", "test-spec"], code: "stage-range:pipeline" },
    {
      name: "開始 T1 で入力を付けた",
      argv: ["--pipeline", "v1.1a", "--plan-file", "plan.json", "--stage-start", "name-table", "--stage-input", "x.json"],
      code: "stage-input:not-needed",
    },
    {
      name: "開始 T2 で入力が無い",
      argv: ["--pipeline", "v1.1a", "--plan-file", "plan.json", "--stage-start", "test-spec"],
      code: "stage-input:missing",
    },
  ];
  it.each(cases)("$name → $code", async (example) => {
    const makeClient = vi.fn();
    const writeFile = vi.fn(async () => {});
    const makeDirectory = vi.fn(async () => {});
    const lines: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", "out", ...example.argv],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async () => V11A_SOURCE,
      writeFile,
      makeDirectory,
      loadDocuments: async () => [],
      makeClient,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(lines[0]).toContain(`使い方の誤り: ${example.code}`);
    expect(lines.slice(1)).toEqual([USAGE, STAGE_USAGE]);
    expect(makeClient).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(makeDirectory).not.toHaveBeenCalled();
  });

  it("片方だけなら他方は経路の端（--stage-end だけ → 開始 T1、--stage-start だけ → 終了 ⑦）", () => {
    const base = ["--", "request.txt", "--out", "out", "--pipeline", "v1.1a", "--plan-file", "plan.json"];
    const endOnly = parseCliArguments([...base, "--stage-end", "test-spec"]);
    expect("error" in endOnly ? null : endOnly.stageRange).toEqual({ start: "name-table", end: "test-spec" });
    const startOnly = parseCliArguments([...base, "--stage-start", "write", "--stage-input", "x.json"]);
    expect("error" in startOnly ? null : startOnly.stageRange).toEqual({ start: "write", end: "judge" });
    expect("error" in startOnly ? null : startOnly.stageInput).toBe("x.json");
    // 旗を省けば段の範囲の欄を置かない
    expect(parseCliArguments(base)).not.toHaveProperty("stageRange");
  });
});

describe("分けても同じ（要求の列をつなげると通しの走りと一致し、⑦ の判定が同じ）", () => {
  it("T2／B1 の境界で分ける：開始 T1・終了 T2' → その checkpoint で開始 B1・終了 ⑦", async () => {
    const calls = [...v11aHead(), structured(v11aJudgments())];
    const full = await fullRunRequests(`${directory}/split-b1-full`, calls);
    const first = await runStageCli({ dir: `${directory}/split-b1-a`, args: ["--stage-end", "test-spec"], calls: calls.slice(0, 3) });
    expect(first.code).toBe(EXIT_OK);
    expect(first.written).toEqual([stageCheckpointFile("t1-t2"), stageCheckpointFile("t2-b1"), STAGE_RUN_RECORD_FILE]);
    const second = await runStageCli({
      dir: `${directory}/split-b1-b`,
      args: ["--stage-start", "write", "--stage-input", `${directory}/split-b1-a/${stageCheckpointFile("t2-b1")}`],
      calls: calls.slice(3),
    });
    expect(second.code).toBe(EXIT_OK);
    expect(second.written).toEqual([STAGE_RUN_RECORD_FILE]);
    expect([...first.requests, ...second.requests]).toEqual(full.requests);
    const record = await stageRecordOf(`${directory}/split-b1-b`);
    expect(record["stage_judge_verdict"]).toBe(full.summary["verdict"]);
    expect(record["stage_judge_verdict"]).toBe("full");
  });

  it("T1''／T2 の境界で分ける：開始 T1・終了 T1'' → その checkpoint で開始 T2・終了 ⑦（停滞の経路でも同じ）", async () => {
    const calls = v11aStagnation();
    const full = await fullRunRequests(`${directory}/split-t2-full`, calls);
    const first = await runStageCli({ dir: `${directory}/split-t2-a`, args: ["--stage-end", "semantic-check"], calls: calls.slice(0, 2) });
    expect(first.code).toBe(EXIT_OK);
    expect(first.written).toEqual([stageCheckpointFile("t1-t2"), STAGE_RUN_RECORD_FILE]);
    const second = await runStageCli({
      dir: `${directory}/split-t2-b`,
      args: ["--stage-start", "test-spec", "--stage-input", `${directory}/split-t2-a/${stageCheckpointFile("t1-t2")}`],
      calls: calls.slice(2),
    });
    expect(second.code).toBe(EXIT_OK);
    expect([...first.requests, ...second.requests]).toEqual(full.requests);
    const record = await stageRecordOf(`${directory}/split-t2-b`);
    expect(record["stage_judge_verdict"]).toBe(full.summary["verdict"]);
    expect(record["stage_judge_verdict"]).toBe("partial");
  });
});

describe("B の結果を上流へ戻さない", () => {
  it("B3' で持ち越しが増えた T1〜⑦ の走りの T2／B1 の checkpoint で開始 B1 を流すと、B は T2 の直前の持ち越しを受ける", async () => {
    const calls = v11aStagnation();
    const dir = `${directory}/no-return-a`;
    const whole = await runStageCli({ dir, args: ["--stage-end", "judge"], calls });
    expect(whole.code).toBe(EXIT_OK);
    const record = await stageRecordOf(dir);
    // B3' の拒否が残って R3 が持ち越しに増えた（最終の持ち越しは記録だけ）
    expect(record["final_carry_over"]).toEqual([{ requirementId: "R3", reasons: [{ origin: "decl-check", reason: "mismatch" }] }]);
    const t1t2 = JSON.parse(await fs.readFile(`${dir}/${stageCheckpointFile("t1-t2")}`, "utf8")) as Record<string, unknown>;
    const t2b1 = JSON.parse(await fs.readFile(`${dir}/${stageCheckpointFile("t2-b1")}`, "utf8")) as Record<string, unknown>;
    expect(t2b1["carry_over"]).toEqual(t1t2["carry_over"]);
    expect(t2b1["carry_over"]).toEqual({ entries: [], excluded_row_ids: [], remaining_requirement_ids: [...V11A_IDS] });

    const resumed = await runStageCli({
      dir: `${directory}/no-return-b`,
      args: ["--stage-start", "write", "--stage-input", `${dir}/${stageCheckpointFile("t2-b1")}`],
      calls: calls.slice(3),
    });
    expect(resumed.code).toBe(EXIT_OK);
    // B の要求は通しの走りの B の要求と同じ（増えた持ち越し R3 を含まない一覧で B3' が流れる）
    expect(resumed.requests).toEqual(whole.requests.slice(3));
    const declCheck = JSON.parse(resumed.requests[1]!) as { input: string };
    expect(declCheck.input).toContain("R3");

    // 同じ走りの最終の記録を入力にすると、境界の照合で断る
    const rejected = await runStageCli({
      dir: `${directory}/no-return-c`,
      args: ["--stage-start", "write", "--stage-input", `${dir}/${STAGE_RUN_RECORD_FILE}`],
      calls: [],
    });
    expect(rejected.code).toBe(EXIT_STAGE_INPUT);
    expect(rejected.errors).toEqual(["stage-input:boundary"]);
  });
});

describe("段の走りの記録・納品物・終了コード", () => {
  it("段の通過 0：記録に stage_pass・budget_scope・出力ダイジェストがあり、verdict・pass の名前の欄が無く、納品物を書かない", async () => {
    const dir = `${directory}/stage-record`;
    const run = await runStageCli({ dir, args: ["--stage-end", "judge"], calls: [...v11aHead(), structured(v11aJudgments())] });
    expect(run.code).toBe(EXIT_OK);
    // 段の走り（今は v1.1a だけ）は v1.1α の封筒を選ぶ（Issue #588）
    expect(run.makeClient.mock.calls).toEqual([[{ apiKey: "sk-FAKE", model: "gpt-6-luna", effort: "high", envelope: "v1.1a" }]]);
    const record = await stageRecordOf(dir);
    expect(record["stage_pass"]).toBe(true);
    expect(record["budget_scope"]).toBe("stage-run");
    expect(record["stage_judge_verdict"]).toBe("full");
    expect(record["range"]).toEqual({ start: "name-table", end: "judge" });
    expect(record["reached_stage"]).toBe("judge");
    const checkpoints = record["checkpoints"] as readonly { boundary: string; path: string; output_digest: string }[];
    expect(checkpoints.map((entry) => entry.boundary)).toEqual(["t1-t2", "t2-b1"]);
    for (const entry of checkpoints) {
      const checkpoint = JSON.parse(await fs.readFile(`${dir}/${entry.path}`, "utf8")) as unknown;
      expect(entry.output_digest).toBe(await stageOutputDigest(checkpoint));
    }
    const keys = keysOf(record);
    expect(keys).not.toContain("verdict");
    expect(keys).not.toContain("pass");
    // 条件：model・effort・文書の指紋・判定の口の構成（鍵は書かない）・版・1 本の予算と締切
    const conditions = record["conditions"] as Record<string, unknown>;
    expect(conditions["judge"]).toEqual({ primary: "llm", fallback: null });
    expect(conditions["budget_usd"]).toBe(DEFAULT_BUDGET_USD);
    expect(conditions["deadline_ms"]).toBe(DEFAULT_DEADLINE_MS);
    expect((conditions["documents"] as readonly unknown[]).length).toBe(FIXTURE_DOCUMENTS.length);
    expect(JSON.stringify(record)).not.toContain("sk-FAKE");
    // 要約の verdict を書かない・納品物（manifest と宣言の束）を書かない
    expect(run.lines.join("\n")).not.toContain("verdict");
    expect(run.written).toEqual([stageCheckpointFile("t1-t2"), stageCheckpointFile("t2-b1"), STAGE_RUN_RECORD_FILE]);
    await expect(fs.readFile(`${dir}/${BUNDLE_MANIFEST_FILE}`, "utf8")).rejects.toThrow();
    await expect(fs.readFile(`${dir}/artifacts/app.spec.yaml`, "utf8")).rejects.toThrow();
    expect(run.written).not.toContain(BUILD_CLI_RECORD_FILE);
  });

  it("範囲の中の早期停止 1：通らなかった境界の checkpoint を書かない", async () => {
    const dir = `${directory}/stage-early-stop`;
    const run = await runStageCli({ dir, args: ["--stage-end", "test-spec"], calls: [v11aBadDraftCall(), v11aBadDraftCall()] });
    expect(run.code).toBe(EXIT_RUN_FAILED);
    expect(run.written).toEqual([STAGE_RUN_RECORD_FILE]);
    const record = await stageRecordOf(dir);
    expect(record["stage_pass"]).toBe(false);
    expect(record["stopped"]).toMatchObject({ stage: "name-table", kind: "unmet" });
    expect(record["checkpoints"]).toEqual([]);
  });

  it("確定した仕様の道の差し戻しは今と同じ 3", async () => {
    const run = await runStageCli({ dir: `${directory}/stage-return`, args: ["--stage-end", "judge"], calls: v11aReturnToPlan() });
    expect(run.code).toBe(EXIT_RETURN_TO_PLAN);
    expect((await stageRecordOf(`${directory}/stage-return`))["return_to_plan"]).toBe(true);
  });
});

describe("予算の単位は段の走り 1 本", () => {
  it("予算を小さくした開始 B1 の走りは、その走りの中で予算切れで止まり、前の走りの額を引かない", async () => {
    const dir = `${directory}/budget-a`;
    const calls = [...v11aHead(), structured(v11aJudgments())];
    await runStageCli({ dir, args: ["--stage-end", "test-spec"], calls: calls.slice(0, 3) });
    const args = ["--stage-start", "write", "--stage-input", `${dir}/${stageCheckpointFile("t2-b1")}`, "--budget", "0.0000001"];
    const small = await runStageCli({ dir: `${directory}/budget-b`, args, calls: calls.slice(3) });
    expect(small.code).toBe(EXIT_RUN_FAILED);
    const smallRecord = await stageRecordOf(`${directory}/budget-b`);
    expect(smallRecord["stopped"]).toMatchObject({ stage: "write", kind: "budget" });
    // 前の走りの記録に大きな額を書いても、結果は同じ（前の走りの額を引かない）
    const previous = await stageRecordOf(dir);
    await fs.writeFile(`${dir}/${STAGE_RUN_RECORD_FILE}`, JSON.stringify({ ...previous, provider_cost_usd: 1000 }), "utf8");
    const again = await runStageCli({ dir: `${directory}/budget-c`, args, calls: calls.slice(3) });
    expect(again.code).toBe(EXIT_RUN_FAILED);
    expect(await stageRecordOf(`${directory}/budget-c`)).toEqual(smallRecord);
    // 十分な予算なら同じ入力で通る（前の走りの額を引かない）
    const enough = await runStageCli({ dir: `${directory}/budget-d`, args: args.slice(0, 4), calls: calls.slice(3) });
    expect(enough.code).toBe(EXIT_OK);
  });
});

/** checkpoint を書き換え、出力ダイジェストを記録に書き直すかどうかを選ぶ */
async function tamper(
  source: string,
  target: string,
  boundary: "t1-t2" | "t2-b1",
  edit: (checkpoint: Record<string, any>) => void,
  rewriteDigest: boolean,
): Promise<string> {
  await fs.mkdir(target, { recursive: true });
  const checkpoint = JSON.parse(await fs.readFile(`${source}/${stageCheckpointFile(boundary)}`, "utf8")) as Record<string, any>;
  edit(checkpoint);
  const record = await stageRecordOf(source);
  if (rewriteDigest) {
    const digest = await stageOutputDigest(checkpoint);
    record["checkpoints"] = (record["checkpoints"] as { boundary: string; output_digest: string }[]).map((entry) =>
      entry.boundary === boundary ? { ...entry, output_digest: digest } : entry,
    );
  }
  await fs.writeFile(`${target}/${stageCheckpointFile(boundary)}`, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await fs.writeFile(`${target}/${STAGE_RUN_RECORD_FILE}`, JSON.stringify(record), "utf8");
  return `${target}/${stageCheckpointFile(boundary)}`;
}

/** 1 バイト変える（文字列の最後の 1 文字を別の文字に） */
const flip = (text: string): string => `${text.slice(0, -1)}${text.endsWith("x") ? "y" : "x"}`;

describe("再開の入力の照合（exit 4・固定の符号・クライアントを作らない・何も書かない）", () => {
  const seen = new Set<StageInputCode>();
  const sourceB1 = () => `${directory}/verify-src-b1`;
  const sourceT2 = () => `${directory}/verify-src-t2`;

  beforeAll(async () => {
    // T1〜T2'（全件受理）と、T1〜T1''（R3 を拒否して持ち越す）の 2 つの前の走り
    await runStageCli({ dir: sourceB1(), args: ["--stage-end", "test-spec"], calls: v11aHead().slice(0, 3) });
    await runStageCli({ dir: sourceT2(), args: ["--stage-end", "semantic-check"], calls: v11aRejectR3Head() });
  });

  afterAll(() => {
    // 符号が全部 1 回以上出る
    expect([...seen].sort()).toEqual([...STAGE_INPUT_CODES].sort());
  });

  async function expectRejected(
    name: string,
    start: "test-spec" | "write",
    input: string,
    code: StageInputCode,
    options: { readonly envelope?: Record<string, unknown>; readonly source?: string } = {},
  ): Promise<void> {
    const dir = `${directory}/verify-out-${name}`;
    const run = await runStageCli({ dir, args: ["--stage-start", start, "--stage-input", input], calls: [], ...options });
    expect(run.code, name).toBe(EXIT_STAGE_INPUT);
    expect(run.errors, name).toEqual([code]);
    expect(run.makeClient, name).not.toHaveBeenCalled();
    expect(run.written, name).toEqual([]);
    expect(run.directories, name).toEqual([]);
    await expect(fs.readFile(`${dir}/${STAGE_RUN_RECORD_FILE}`, "utf8"), name).rejects.toThrow();
    seen.add(code);
  }

  it("照合を通る入力（対照）：前の走りの checkpoint をそのまま渡せば、開始 B1・開始 T2 とも流れる", async () => {
    const b1 = await runStageCli({
      dir: `${directory}/verify-ok-b1`,
      args: ["--stage-start", "write", "--stage-end", "judge", "--stage-input", `${sourceB1()}/${stageCheckpointFile("t2-b1")}`],
      calls: [structured({ declaration: V11A_YAML }), structured(v11aJudgments())],
    });
    expect(b1.code).toBe(EXIT_OK);
    const t2 = await runStageCli({
      dir: `${directory}/verify-ok-t2`,
      args: ["--stage-start", "test-spec", "--stage-end", "test-spec", "--stage-input", `${sourceT2()}/${stageCheckpointFile("t1-t2")}`],
      calls: [structured(v11aTestSpec())],
    });
    // T2 は持ち越した R3 を除いた一覧で呼ばれる（応答の組は R3 を含むので T2 の検査で止まってよい。照合は通った）
    expect(t2.makeClient).toHaveBeenCalledTimes(1);
    expect(t2.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
  });

  it("読めない入力 → unreadable", async () => {
    await expectRejected("unreadable", "write", `${directory}/verify-missing/${stageCheckpointFile("t2-b1")}`, "stage-input:unreadable");
  });

  it("別の境界・最終の記録 → boundary", async () => {
    await expectRejected("boundary-other", "write", `${sourceB1()}/${stageCheckpointFile("t1-t2")}`, "stage-input:boundary");
    await expectRejected("boundary-record", "write", `${sourceB1()}/${STAGE_RUN_RECORD_FILE}`, "stage-input:boundary");
  });

  it("語彙の版を変えた入力 → version（出力ダイジェストを書き直しても）", async () => {
    const input = await tamper(sourceB1(), `${directory}/verify-vocab`, "t2-b1", (cp) => {
      cp["versions"]["vocabulary"] = "v0";
    }, true);
    await expectRejected("version", "write", input, "stage-input:version");
  });

  it("表・点検・試験の組の各記録を 1 バイト変えた入力 → digest", async () => {
    const edits: readonly [string, (cp: Record<string, any>) => void][] = [
      ["table", (cp) => (cp["name_table"]["rows"][0]["id"] = flip(cp["name_table"]["rows"][0]["id"]))],
      ["semantic", (cp) => (cp["semantic_check"]["targets"][0] = flip(cp["semantic_check"]["targets"][0]))],
      ["suite", (cp) => (cp["test_spec"]["suite"]["tests"][0]["id"] = flip(cp["test_spec"]["suite"]["tests"][0]["id"]))],
    ];
    for (const [name, edit] of edits) {
      const input = await tamper(sourceB1(), `${directory}/verify-byte-${name}`, "t2-b1", edit, false);
      await expectRejected(`digest-${name}`, "write", input, "stage-input:digest");
    }
  });

  it("確定した仕様か依頼文を変えた入力 → plan-sha256・source-sha256", async () => {
    const input = `${sourceB1()}/${stageCheckpointFile("t2-b1")}`;
    const body = { ...v11aPlanBody(), plan_id: "plan-v11a-cli-other" };
    const plan = { ...body, confirmation: { ...body.confirmation, sha256: await planDigest(body) } };
    const envelope = { ...(await v11aEnvelope()), plan, plan_sha256: await planDigest(plan) };
    await expectRejected("plan", "write", input, "stage-input:plan-sha256", { envelope });
    const source = `${V11A_SOURCE}。`;
    const sourceEnvelope = { ...(await v11aEnvelope()), source_sha256: await sha256Hex(source) };
    await expectRejected("source", "write", input, "stage-input:source-sha256", { envelope: sourceEnvelope, source });
  });

  it("出力ダイジェストを書き直しても：表 → table-sha256・点検の表の SHA → semantic-sha256・試験の組 → suite-sha256", async () => {
    const table = await tamper(sourceB1(), `${directory}/verify-table`, "t2-b1", (cp) => {
      cp["name_table"]["rows"][0]["name"] = flip(String(cp["name_table"]["rows"][0]["name"]));
    }, true);
    await expectRejected("table-sha256", "write", table, "stage-input:table-sha256");
    const semantic = await tamper(sourceB1(), `${directory}/verify-semantic`, "t2-b1", (cp) => {
      cp["semantic_check"]["table_sha256"] = "0".repeat(64);
    }, true);
    await expectRejected("semantic-sha256", "write", semantic, "stage-input:semantic-sha256");
    const suite = await tamper(sourceB1(), `${directory}/verify-suite`, "t2-b1", (cp) => {
      cp["test_spec"]["suite"]["tests"][0]["clock"] = "2026-09-17T12:00:00+09:00";
    }, true);
    await expectRejected("suite-sha256", "write", suite, "stage-input:suite-sha256");
    const observes = await tamper(sourceB1(), `${directory}/verify-observes`, "t2-b1", (cp) => {
      cp["test_spec"]["observes"] = cp["test_spec"]["observes"].slice(1);
    }, true);
    await expectRejected("suite-observes", "write", observes, "stage-input:suite-sha256");
  });

  it("表の SHA を保ったまま判定 1 つを reject から accept に変えた → digest（書き直せば carry-over）", async () => {
    const toAccept = (cp: Record<string, any>) => {
      cp["semantic_check"]["judgments"] = cp["semantic_check"]["judgments"].map((judgment: Record<string, unknown>) =>
        judgment["verdict"] === "reject" ? { requirementId: judgment["requirementId"], verdict: "accept", kind: null, quote: null } : judgment,
      );
    };
    await expectRejected("flip-digest", "test-spec", await tamper(sourceT2(), `${directory}/verify-flip-a`, "t1-t2", toAccept, false), "stage-input:digest");
    await expectRejected("flip-carry", "test-spec", await tamper(sourceT2(), `${directory}/verify-flip-b`, "t1-t2", toAccept, true), "stage-input:carry-over");
  });

  it("判定を 1 つ消した → digest（書き直せば targets）", async () => {
    const drop = (cp: Record<string, any>) => {
      cp["semantic_check"]["judgments"] = cp["semantic_check"]["judgments"].slice(1);
    };
    await expectRejected("drop-digest", "test-spec", await tamper(sourceT2(), `${directory}/verify-drop-a`, "t1-t2", drop, false), "stage-input:digest");
    await expectRejected("drop-targets", "test-spec", await tamper(sourceT2(), `${directory}/verify-drop-b`, "t1-t2", drop, true), "stage-input:targets");
  });

  it("持ち越しの 1 件を消した → digest（書き直しても carry-over）", async () => {
    const drop = (cp: Record<string, any>) => {
      cp["carry_over"]["entries"] = cp["carry_over"]["entries"].slice(1);
    };
    await expectRejected("carry-digest", "test-spec", await tamper(sourceT2(), `${directory}/verify-carry-a`, "t1-t2", drop, false), "stage-input:digest");
    await expectRejected("carry-rewrite", "test-spec", await tamper(sourceT2(), `${directory}/verify-carry-b`, "t1-t2", drop, true), "stage-input:carry-over");
  });
});
