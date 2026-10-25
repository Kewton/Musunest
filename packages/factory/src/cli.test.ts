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
  CONTRACT_VERSION,
  PROMPT_VERSION_V11A,
  PROMPT_VERSION_V12,
  STAGE_EFFORT_USAGE,
  STAGE_USAGE,
  VOCABULARY_VERSION,
  USAGE,
  parseCliArguments,
  parseStageEfforts,
  runCli,
} from "./cli.js";
import { AGENT_LIMITS, maxOutputTokensForEffort } from "./limits.js";
import { BUILD_CLI_RECORD_FILE, PLAN_ONLY_RESULT_SCHEMA } from "./cli-plan.js";
import * as factory from "./index.js";
import { createFakeJudge } from "./judge-fake.js";
import type { JudgeAnswer } from "./judge.js";
import { FakeLlmSchemaMismatchError, uncheckedBecause, type RecordedCall } from "./llm-fake.js";
import { createOpenAiLlmClient } from "./openai.js";
import { FIELD_REPAIR_SCHEMA_NAME, MERGE_REFUSALS } from "./v12/stages/field-repair.js";
import {
  ENVELOPE_SCHEMA,
  ENVELOPE_SCHEMA_NAME,
  ENVELOPE_SCHEMA_NAME_V11A,
  ENVELOPE_SCHEMA_V11A,
  ENVELOPE_SCHEMA_V12_IDS,
  STAGE_ENVELOPE_ENTRIES,
  STAGE_ENVELOPE_ENTRIES_V11A,
  STAGE_ENVELOPE_ENTRIES_V12_IDS,
  buildStageBranch,
  type EnvelopeId,
} from "./schema-envelope.js";
import { requirementsFromPlan, type RequirementList } from "./pipeline.js";
import { captureCliBaseline, type BaselineCliCapture, type BaselineCliScenarios } from "./__tests__/baseline-capture.js";
import {
  STAGE_DECLARATION_FILE,
  STAGE_INPUT_CODES,
  STAGE_RUN_RECORD_FILE,
  stageCheckpointFile,
  stageJsonText,
  stageOutputDigest,
  V11A_ARTIFACT_NAMES,
  V12_SEARCH_REPAIR_ARTIFACT_NAME,
  verifyStageInput,
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
  codeIdRenameOf,
  casesResponseOf,
  idsResponseList,
  idsResponsesOf,
  renameIds,
  withCodeIds,
  withoutEnumMembership,
  withoutLedgerAdditions,
  withoutWhenAndNonRequirement,
  REQUIRED_VALIDATIONS_BLOCK,
  withoutRequiredValidations,
  revert735,
  revertBundleFiles735,
} from "./v11a/__tests__/fixtures.js";
import * as ledgerModule from "./v12/ledger.js";
import type { LedgerView } from "./v12/ledger.js";
import { PROPERTY_LEDGER_VIEW } from "./v12/ledger.js";
import { isGeneratedTestId } from "./v12/generated-tests.js";
import { ruleTexts } from "./stages/prompt.js";
import {
  TEST_SPEC_DATA_NAMES,
  TEST_SPEC_FRAMES_DATA_NAME,
  TEST_SPEC_SCHEMA_NAME,
  testSpecRuleDefinitionsOf,
  testSpecSchemaOf,
} from "./v11a/stages/test-spec.js";
import * as testSpecModule from "./v11a/stages/test-spec.js";
import * as declCheckStage from "./v11a/stages/decl-check.js";
import { DECL_CHECK_SCHEMA_NAME } from "./v11a/stages/decl-check.js";
import { NAMED_FAILURE_MESSAGES } from "./v12/search-repair.js";
import { SEMANTIC_CHECK_SCHEMA_NAME, semanticCheckRuleDefinitionsOf } from "./v11a/stages/semantic-check.js";
import { structuralReadingText } from "./v12/structural-meanings.js";
import { WRITE_V11A_DATA_NAMES, WRITE_V11A_SCHEMA_NAME } from "./v11a/stages/write.js";
import { V12_CALL_LIMITS } from "./v12/limits.js";
import type { NameTable } from "./v11a/names.js";
import {
  BUNDLE_MANIFEST_FILE,
  DESIGN_FILE,
  DIAGNOSTICS_LISTING_FILE,
  DIAGNOSTICS_REJECTED_DESIGN_FILE,
  DIAGNOSTICS_REJECTED_MAPPING_FILE,
  DIAGNOSTICS_REJECTED_TEST_SPEC_FILE,
  DIAGNOSTICS_REJECTED_VOCABULARY_FILE,
  DIAGNOSTICS_TABLE_ROUNDS_FILE,
  MAPPINGS_FILE,
  TEST_SUITE_FILE,
} from "./bundle.js";
import * as runModule from "./run.js";
import type { Judge, JudgeRequest } from "./judge.js";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "./llm.js";
import { createRecordingClient, expectNoAcceptanceMaterial } from "./stages/__tests__/prompt.js";
import { ATTEMPT_KEYS, FAILURE_KINDS, RETRY_KEYS, STAGE_IDS } from "./record.js";
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

/** Issue #663 で旗 ids の走りだけ T2 の R-tsp-02 の末尾に足した、要件ごとの試験の上限の文（値は限度の表の定数から組む） */
const T2_IDS_LIMIT_TEXT = `要件ごとの試験は、コードが作った分を含めて ${String(AGENT_LIMITS.testsPerRequirement)} 本まで。必要な試験の枠の残る本数（remaining）を超えて場合を書かない。`;

/** 手 3e（#625）で旗 ids の走りだけ場合の形に差し替えた、欄の名前を指す T2 の規則 */
const CASE_FORM_RULE_IDS: readonly string[] = ["R-tsp-07", "R-tsp-09", "R-tsp-11", "R-tsp-12", "R-tsp-13", "R-tsp-14"];

/**
 * 手 3i（#653）で旗 ids の走りだけ必要な試験の枠に合わせた T2 の規則のうち、台帳の差の名指し（R-tsp-02・R-tsp-16）に無いもの
 * （R-tsp-02・R-tsp-16 の旗 ids の文は `withoutIdsGenerated` が旗 off の文に戻す）
 */
const FRAME_RULE_IDS: readonly string[] = ["R-tsp-03"];

/**
 * 旗 v12.ids の走りの T2 の応答（手 3d・Issue #624：構造の要件 R2 は要求の一覧に無く、構造の検査はコードが作るので、R2 の試験と
 * 分類を書かない）
 */
function v12TestSpec(): Record<string, unknown> {
  const spec = v11aTestSpec() as { classifications: readonly { requirementId: string }[]; tests: readonly { target: { requirementId: string } }[] };
  // 手 3e（#625）：旗 ids の T2 の応答は同じ内容の場合の形（骨組みはコードが組む）
  return casesResponseOf({
    classifications: spec.classifications.filter((entry) => entry.requirementId !== "R2"),
    tests: spec.tests.filter((test) => test.target.requirementId !== "R2"),
  });
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

/** 旗 v12.ids の走りの表（題材の表をコードの形の ID に振り直し、計算の行に集計の欄。出典なし。Issue #593） */
const V11A_CODE_RENAME = codeIdRenameOf(V11A_TABLE);
const V11A_TABLE_IDS: NameTable = withCodeIds(withAggregates(V11A_TABLE));
/** 値の中の題材の表の ID をコードの形の ID に振り直す */
const v11aRenamed = <T,>(value: T): T => renameIds(value, V11A_CODE_RENAME);

/** v1.2 の走りの C1 の 3 束と C2 の記録（台帳を渡せば、その台帳の schema に合わせる。Issue #593） */
const v12TableCalls = (ledger: LedgerView = ledgerModule.PROPERTY_LEDGER_VIEW): RecordedCall[] =>
  idsResponseList(idsResponsesOf(V11A_LIST, V11A_TABLE_IDS, ledger)).map((output) => structured(output));

/**
 * v1.2（旗 on）の走りの頭。旗 v12.ids が on なので、表は C1 の 3 束と C2 で組む（コードの形の ID。Issue #593）。T1'' の判定・
 * B1 の宣言は `v11aHead` と同じで、T2 の応答は同じ試験を新しい ID で書く
 */
const v12Head = (ledger?: LedgerView): RecordedCall[] => [
  ...v12TableCalls(ledger),
  structured(v11aJudgments()),
  structured(v11aRenamed(v12TestSpec())),
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
    for (const role of entry.roles) {
      answers[`need:${entry.requirementId}:${role.id}`] = { kind: "noul", noul: 0.9 };
      // 旗 v12.ids の走りは同じ行をコードの形の ID で問う（Issue #593）
      answers[`need:${entry.requirementId}:${V11A_CODE_RENAME.get(role.id) ?? role.id}`] = { kind: "noul", noul: 0.9 };
    }
  }
  return createFakeJudge(answers);
}

/** `--pipeline v1.1a --plan-file` を 1 回流す（偽物の LLM・判定・時計で閉じる。ファイルだけ本物。`pipeline` で v1.2 も） */
async function runV11aCli(input: {
  readonly dir: string;
  readonly calls: readonly RecordedCall[];
  readonly pipeline?: "v1.1a" | "v1.2";
  /** 末尾に足す引数（`--stage-effort` など。省けば今の引数。Issue #664） */
  readonly args?: readonly string[];
}) {
  const planPath = `${input.dir}-plan.json`;
  const planText = JSON.stringify(await v11aEnvelope());
  const recording = createCheckedRecordingClient(input.calls);
  const makeClient = vi.fn((_options: { readonly envelope?: EnvelopeId }) => recording.client);
  const lines: string[] = [];
  const written: string[] = [];
  const code = await runCli({
    argv: ["--", "request.txt", "--out", input.dir, "--pipeline", input.pipeline ?? "v1.1a", "--plan-file", planPath, ...(input.args ?? [])],
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

  /** 表を組む段の schema の名前（v1.1a は T1、v1.2 は旗 v12.ids の C1 の 3 束と C2。Issue #593） */
  const TABLE_STAGE_NAMES = new Set(["name-table", "vocabulary-entities", "vocabulary-fields", "vocabulary-behaviors", "mapping"]);
  const backToFixtureIds = [...V11A_CODE_RENAME.entries()].sort((a, b) => b[1].length - a[1].length);
  /**
   * 表を組む段の後の要求を、v1.1a の走りと比べられる形にする（Issue #593）：表を組む段の要求を除き、コードの形の ID を題材の
   * ID に戻し、T2 に見せる行の出典の欄（v1.1a は写像、v1.2 は null）を null にそろえる
   */
  const laterRequests = (requests: readonly LlmStructuredRequest[]): unknown[] =>
    requests
      .filter((request) => !TABLE_STAGE_NAMES.has(request.schemaName))
      .map((request) => {
        let text = JSON.stringify(request).replace(/\\"source\\": \{[^}]*\}/g, '\\"source\\": null');
        for (const [original, code] of backToFixtureIds) {
          text = text.replaceAll(`\\"${code}\\"`, `\\"${original}\\"`).replaceAll(`\\\\\\"${code}\\\\\\"`, `\\\\\\"${original}\\\\\\"`);
        }
        return JSON.parse(text) as unknown;
      });
  /**
   * 旗 ids on の要求から、コードが作る試験の分（Issue #595）を除く：T2 の R-tsp-16 を台帳の旗 ids の文から旗 ids off の文に戻し、
   * B1 の「固定した試験」の塊からコードが作った試験（予約の接頭辞の ID）を除く。ほかの欄は触らない。`generated` は、B1 の塊に
   * コードが作った試験があるはずか（台帳に空の集計の行が無い導出の走りは、この題材ではコードの試験を作らない）。手 4d（#666）：B1 の
   * 「要る検査の骨組み」の塊を外し、R-w11-07 を旗 ids off の文に戻す（塊が在ることを確かめてから）
   */
  const withoutIdsGenerated = (requests: readonly unknown[], ledger: LedgerView = PROPERTY_LEDGER_VIEW, generated = true): unknown[] => {
    const idsRules = ruleTexts(testSpecRuleDefinitionsOf(ledger, true));
    const offRules = ruleTexts(testSpecRuleDefinitionsOf(ledger));
    const idsSemanticRules = ruleTexts(semanticCheckRuleDefinitionsOf(ledger, true));
    const offSemanticRules = ruleTexts(semanticCheckRuleDefinitionsOf(ledger));
    const [, , testsName] = WRITE_V11A_DATA_NAMES;
    const testsBlock = new RegExp(`(<data name="${testsName}">\\n)([\\s\\S]*?)(\\n</data>)`);
    return requests.map((value) => {
      const request = value as LlmStructuredRequest;
      if (request.schemaName === TEST_SPEC_SCHEMA_NAME) {
        // Issue #663：旗 ids の R-tsp-02 は末尾に要件ごとの試験の上限の文（限度の表の定数）を持つ。在ることを確かめてから旗 off の文に戻す
        expect((request.rules ?? []).filter((text) => text.endsWith(T2_IDS_LIMIT_TEXT))).toHaveLength(1);
        return { ...request, rules: (request.rules ?? []).map((text) => { const at = idsRules.indexOf(text); return at < 0 ? text : (offRules[at] ?? text); }) };
      }
      if (request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME) {
        // Issue #732：旗 ids の C3 の R-sc-02 は構造の検査の読み方の文を持つ。在ることを確かめてから旗 ids off の文に戻す
        expect(request.rules).toEqual(idsSemanticRules);
        return { ...request, rules: offSemanticRules };
      }
      if (request.schemaName === WRITE_V11A_SCHEMA_NAME) {
        // 手 4d（#666）：旗 ids の B1 は「要る検査の骨組み」の塊と R-w11-07 の旗 ids の文を持つ。塊が在ることを確かめてから元に戻す
        expect(REQUIRED_VALIDATIONS_BLOCK.test(request.input)).toBe(true);
        const restored = withoutRequiredValidations(request);
        const input = restored.input.replace(testsBlock, (_all, head: string, body: string, tail: string) => {
          const parsed = JSON.parse(body) as { readonly tests: readonly { readonly id: string }[] };
          // 書き直しの形が元と同じこと（塊の字下げ・欄の並びを変えない）を確かめてから除く
          expect(JSON.stringify(parsed, null, 2)).toBe(body);
          expect(parsed.tests.some((test) => isGeneratedTestId(test.id))).toBe(generated);
          return `${head}${JSON.stringify({ ...parsed, tests: parsed.tests.filter((test) => !isGeneratedTestId(test.id)) }, null, 2)}${tail}`;
        });
        return { ...restored, input };
      }
      return request;
    });
  };
  /**
   * 旗 ids の手 3d（Issue #624）の差をそろえる：構造の要件 R2 は旗 ids の T2 の要求の一覧・確かめ方・所属に無く、組の分類にも無い
   * （構造の検査はコードが作る）。両側の T2 のその 3 つの塊と B1 の「固定した試験」の分類から R2 を除き、`ledger` を渡した側
   * （旗 ids の走り）の T2 の schema を旗 ids off の schema（operation に structure・assertion は写像か null）に戻す。手 3i（#653）：
   * `ledger` を渡した側の T2 の要求から、所属の後ろの必要な試験の枠の塊を除く（旗 ids の走りだけの塊）
   */
  const withoutStructuralRequirement = (requests: readonly unknown[], ledger?: LedgerView): unknown[] => {
    const [, listName, , verificationName, ownershipName] = TEST_SPEC_DATA_NAMES;
    const [, , testsName] = WRITE_V11A_DATA_NAMES;
    const notR2 = (entry: { readonly id?: string; readonly requirementId?: string }) => (entry.requirementId ?? entry.id) !== "R2";
    const rewrite = (input: string, name: string, edit: (parsed: unknown) => unknown) =>
      input.replace(new RegExp(`(<data name="${name}">\\n)([\\s\\S]*?)(\\n</data>)`), (_all, head: string, body: string, tail: string) => {
        const parsed = JSON.parse(body) as unknown;
        expect(JSON.stringify(parsed, null, 2)).toBe(body);
        return `${head}${JSON.stringify(edit(parsed), null, 2)}${tail}`;
      });
    return requests.map((value) => {
      const request = value as LlmStructuredRequest;
      if (request.schemaName === TEST_SPEC_SCHEMA_NAME) {
        let input = rewrite(request.input, listName, (parsed) => {
          const list = parsed as { readonly requirements: readonly { readonly id: string }[] };
          return { ...list, requirements: list.requirements.filter(notR2) };
        });
        for (const name of [verificationName, ownershipName]) {
          input = rewrite(input, name, (parsed) => (parsed as readonly { readonly requirementId: string }[]).filter(notR2));
        }
        if (ledger !== undefined) {
          const framesBlock = new RegExp(`\\n<data name="${TEST_SPEC_FRAMES_DATA_NAME}">\\n[\\s\\S]*?\\n</data>`);
          expect(framesBlock.test(input)).toBe(true);
          input = input.replace(framesBlock, "");
        }
        // 旗 ids の走りの規則のうち、場合の形に差し替えた欄の名前の文（R-tsp-07・09・11・12・13・14。#625）と、必要な試験の枠の
        // R-tsp-03（#653）は旗 ids off の文に戻す
        // （R-tsp-16 は台帳の差として名指しで照らし、`withoutIdsGenerated` が戻す）
        const idsDefinitions = ledger === undefined ? [] : testSpecRuleDefinitionsOf(ledger, true);
        const offDefinitions = ledger === undefined ? [] : testSpecRuleDefinitionsOf(ledger);
        const casesTexts = new Map(
          idsDefinitions.flatMap((definition, index) => {
            const off = offDefinitions[index];
            return (CASE_FORM_RULE_IDS.includes(definition.id) || FRAME_RULE_IDS.includes(definition.id)) && off !== undefined
              ? [[ruleTexts([definition])[0] ?? "", ruleTexts([off])[0] ?? ""] as const]
              : [];
          }),
        );
        const rules = (request.rules ?? []).map((text) => casesTexts.get(text) ?? text);
        return { ...request, input, ...(ledger === undefined ? {} : { rules, schema: JSON.parse(JSON.stringify(testSpecSchemaOf(ledger))) as unknown }) };
      }
      if (request.schemaName === WRITE_V11A_SCHEMA_NAME) {
        const input = rewrite(request.input, testsName, (parsed) => {
          // R2 の構造の検査は旗 ids の走りではコードが作る（組の末尾。`withoutIdsGenerated` が除く）。両側の R2 の試験と分類を除く
          const suite = parsed as {
            readonly tests: readonly { readonly target: { readonly requirementId: string } }[];
            readonly classifications?: readonly { readonly requirementId: string }[];
          };
          const tests = suite.tests.filter((test) => test.target.requirementId !== "R2");
          return suite.classifications === undefined
            ? { ...suite, tests }
            : { ...suite, tests, classifications: suite.classifications.filter(notR2) };
        });
        return { ...request, input };
      }
      return request;
    });
  };
  /**
   * 手 3e（#625）：旗 ids の走りの LLM の試験は場合から展開するので、試験 ID（case: と連番）と時計（定数）はコードが振る。B1 の
   * 「固定した試験」の塊の試験 ID と時計を両側から除いて比べる（ほかの欄は触らない）
   */
  const withoutTestIdClock = (requests: unknown): unknown[] =>
    (requests as readonly unknown[]).map(
      (request) =>
        JSON.parse(
          JSON.stringify(request)
            .replace(/\\"id\\": \\"[^\\]*\\",(\\n *)\\"target\\"/g, '\\"id\\": \\"-\\",$1\\"target\\"')
            .replace(/\\"clock\\": \\"[^\\]*\\"/g, '\\"clock\\": \\"-\\"'),
        ) as unknown,
    );
  const withoutTableStage = (diff: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> =>
    Object.fromEntries(Object.entries(diff).filter(([name]) => name !== "name-table"));

  it("完走で 0：v1.1α の経路で流れ、表を組む段（ids on は C1・C2）の後の要求の差は台帳の enum-membership（#548）と empty-aggregate（#549）の行の分だけ（名指しの場所）。条件の記録の pipeline・prompt_version が v1.2、ほかの欄は v1.1a と同じ", async () => {
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const v1Spy = vi.spyOn(runModule, "runGeneration");
    const calls = [...v11aHead(), structured(v11aJudgments())];
    const v12 = await runV11aCli({ dir: `${directory}/v12-complete`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    const v11a = await runV11aCli({ dir: `${directory}/v12-complete-v11a`, calls });

    expect(v12.code).toBe(EXIT_OK);
    expect(v1Spy).not.toHaveBeenCalled();
    expect(v11aSpy).toHaveBeenCalledTimes(2);
    // 旗 ids が on の v1.2 は、C2 の枝を検査の種類ごとの欄にした識別子 v1.2-ids の封筒（Issue #682）
    expect(v12.makeClient.mock.calls[0]).toEqual([{ apiKey: "sk-FAKE", model: "gpt-6-luna", effort: "high", envelope: "v1.2-ids" }]);
    // 表を組む段：v1.2 は C1 の 3 束と C2、v1.1a は T1（Issue #593）
    expect(v12.recording.structured.slice(0, 4).map((request) => request.schemaName)).toEqual(["vocabulary-entities", "vocabulary-fields", "vocabulary-behaviors", "mapping"]);
    expect(v11a.recording.structured[0]?.schemaName).toBe("name-table");
    // 表を組む段の後の LLM への要求は、v1.2 の旗で台帳に登録した性質（enum-membership。Issue #548・empty-aggregate。Issue #549）の
    // 分を除けば v1.1a の走りとバイト列で同じ（ID と出典の欄をそろえたうえで）。差は名指しの場所（R-sc-02・R-tsp-02・R-tsp-16・
    // R-w11 の並び・schema の enum、表を載せるデータの計算の行の aggregate）だけで、空でない
    // ids on の C3・T2 の確かめ方は構造の検査の対象の欄を持つ（C3 は表の targets、T2 は checkTargets。Issue #594）。その欄だけを除いて比べる
    const targetsPattern = /,\\n *\\"(?:targets|checkTargets)\\": \[[^\]]*\]/g;
    const withoutCheckTargets = (requests: readonly unknown[]): unknown[] =>
      requests.map((request) => JSON.parse(JSON.stringify(request).replace(targetsPattern, "")) as unknown);
    const onWithTargets = laterRequests(v12.recording.structured);
    // 手 3d（Issue #624）から構造の要件は T2 の要求に無いので、検査の対象の欄を持つのは C3 だけ
    expect(JSON.stringify(onWithTargets[0]).match(targetsPattern) !== null).toBe(true);
    expect(JSON.stringify(onWithTargets[1]).match(targetsPattern)).toBeNull();
    const onRequests = withoutStructuralRequirement(withoutCheckTargets(onWithTargets), PROPERTY_LEDGER_VIEW);
    const offRequests = withoutStructuralRequirement(laterRequests(v11a.recording.structured));
    expect(onRequests).toHaveLength(offRequests.length);
    // 試験 ID と時計はコードが振る（#625）。両側から除いて差を見る
    const diffs = requestDiffsOf(withoutTestIdClock(onRequests), withoutTestIdClock(offRequests));
    const withInput = (paths: readonly string[]): readonly string[] => {
      const at = paths.findIndex((path) => path.startsWith("$.schema"));
      return at < 0 ? [...paths, "$.input"] : [...paths.slice(0, at), "$.input", ...paths.slice(at)];
    };
    const ledgerDiff = withoutTableStage(LEDGER_REQUEST_DIFF);
    for (const diff of diffs) {
      // T1''・T2・B1・B3' は名前の表（計算の行の aggregate）を載せるデータが違う
      expect(diff.paths, diff.schemaName).toEqual(withInput(ledgerDiff[diff.schemaName] ?? []));
    }
    expect(diffs.filter((diff) => diff.paths.length > 0).map((diff) => diff.schemaName)).toEqual([...Object.keys(ledgerDiff), "decl-check"]);
    // 旗 ids on の差（Issue #595）：T2 の R-tsp-16（$.rules[15]）が台帳の旗 ids の文になり、B1 の「固定した試験」（$.input）の末尾に
    // コードが作った試験が並ぶ。この 2 つだけを ids on 側から除いて（R-tsp-16 は旗 off の文に戻して）比べる
    expect(JSON.stringify(withoutTestIdClock(withoutLedgerAdditions(withoutIdsGenerated(onRequests))))).toBe(JSON.stringify(withoutTestIdClock(offRequests)));
    // #548 までの旗 on（台帳に empty-aggregate の行が無い）は、同じ応答で差が enum-membership の行の分だけ（今までの期待）
    const spy = vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? LEDGER_VIEW_2B : undefined));
    const v12Before = await runV11aCli({ dir: `${directory}/v12-complete-2b`, calls: [...v12Head(LEDGER_VIEW_2B), structured(v11aJudgments())], pipeline: "v1.2" });
    spy.mockRestore();
    // 旗 ids on の差（Issue #595）：#548 の台帳でも R-tsp-16 は旗 ids の文（既定値・選択肢の集合の文）。空の集計の行が無いので
    // 空の集計のコードの試験は作らない。手 3d（Issue #624）から構造の検査と画面の構造の確認はコードが作るので、B1 の塊の末尾にその
    // 試験が並ぶ（除いて比べる）。R-tsp-16 は旗 off の文に戻して比べる
    const beforeRequests = withoutIdsGenerated(
      withoutStructuralRequirement(withoutCheckTargets(laterRequests(v12Before.recording.structured)), LEDGER_VIEW_2B),
      LEDGER_VIEW_2B,
      true,
    );
    const beforeDiffs = requestDiffsOf(withoutTestIdClock(beforeRequests), withoutTestIdClock(offRequests));
    const enumDiff = withoutTableStage(ENUM_MEMBERSHIP_REQUEST_DIFF);
    for (const diff of beforeDiffs) expect(diff.paths, diff.schemaName).toEqual(enumDiff[diff.schemaName] ?? []);
    expect(beforeDiffs.filter((diff) => diff.paths.length > 0).map((diff) => diff.schemaName)).toEqual(Object.keys(enumDiff));
    expect(JSON.stringify(withoutTestIdClock(withoutEnumMembership(beforeRequests)))).toBe(JSON.stringify(withoutTestIdClock(offRequests)));
    // 要約は、C1 の束 3 の参照の照合の数（#548 の台帳には集計の種類が無いので集計元の参照を数えない）のほかは同じ
    const withoutReferences = (summary: Record<string, unknown>) =>
      JSON.parse(JSON.stringify(summary, (key, value: unknown) => (key === "references" ? undefined : value))) as unknown;
    expect(withoutReferences(v12Before.summary)).toEqual(withoutReferences(v12.summary));
    // #549 までの旗 on（台帳の when の列が未定義・non-requirement の行が無い。Issue #550）は、同じ応答で今の on との差が
    // when・non-requirement の行の分（R-sc-02・R-tsp-16）だけ
    const spy2C = vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? LEDGER_VIEW_2C : undefined));
    const v12Before2C = await runV11aCli({ dir: `${directory}/v12-complete-2c`, calls: [...v12Head(LEDGER_VIEW_2C), structured(v11aJudgments())], pipeline: "v1.2" });
    spy2C.mockRestore();
    const before2CRequests = withoutStructuralRequirement(withoutCheckTargets(laterRequests(v12Before2C.recording.structured)), LEDGER_VIEW_2C);
    const diffs2C = requestDiffsOf(onRequests, before2CRequests);
    const when2C = withoutTableStage(WHEN_NON_REQUIREMENT_REQUEST_DIFF);
    for (const diff of diffs2C) expect(diff.paths, diff.schemaName).toEqual(when2C[diff.schemaName] ?? []);
    expect(diffs2C.filter((diff) => diff.paths.length > 0).map((diff) => diff.schemaName)).toEqual(Object.keys(when2C));
    expect(JSON.stringify(withoutWhenAndNonRequirement(onRequests))).toBe(JSON.stringify(before2CRequests));
    expect(v12Before2C.code).toBe(v12.code);
    expect(v12Before2C.summary).toEqual(v12.summary);
    expect(v12Before2C.record.conditions).toEqual(v12.record.conditions);
    expect(v12.summary["verdict"]).toBe("full");
    expect(v12.summary["prompt_version"]).toBe(PROMPT_VERSION_V12);
    expect(v12.summary["prompt_version"]).toBe("v1.2");
    expect(v12.record.conditions["pipeline"]).toBe("v1.2");
    expect(v12.record.conditions["prompt_version"]).toBe("v1.2");
    const { pipeline: _pipeline, prompt_version: _v12Prompt, v12_flags: _flags, v12_call_limits: _limits, ...v12Rest } = v12.record.conditions;
    const { prompt_version: v11aPrompt, ...v11aRest } = v11a.record.conditions;
    expect(v11aPrompt).toBe("v1.1a");
    expect(v12Rest).toEqual(v11aRest);
    // 要約は prompt_version・v12_flags と、旗 v12.ids の門と枝の欄 v12_calls（Issue #592）のほかは v1.1a と同じ。門の数は
    // 生成 8（C1 3・C2 1・T1'' 1・T2 1・B1 1・B3' 1。Issue #593 で T1 の 1 が 4 になった）と判定 4
    const { prompt_version: _p1, v12_flags: _f1, v12_calls: v12Calls, ...summaryRest } = v12.summary;
    // 既存の鍵の値はそのまま。T2 の束の数・同時数・段全体の計を test_spec に足す（要件が 5 件以下なので束 1。Issue #626）
    expect(v12Calls).toEqual({
      real_attempts: { limit: 144, used: 12 },
      judge_branch: { limit: 80, used: 4 },
      // C3 の束の欄（Issue #735）：対象 4 件で束 1、形のやり直しの予算は要件 5 件で束 1（使わない）
      semantic_check: { rounds: [{ round: 1, bundles: 1 }], shape_retries: { limit: 1, used: 0, remaining: 1, by: [] } },
      test_spec: { bundles: 1, concurrency: 1, total: t2TotalOf(v12.summary) },
    });
    expect(v11a.summary).not.toHaveProperty("v12_calls");
    const { prompt_version: _p2, ...v11aSummaryRest } = v11a.summary;
    // 表を組む段が C1・C2（4 要求）になった分だけ、呼び出しの数で決まる欄（費用・予算の残り・段の記録・トークンの計）が違う。
    // 段の記録は表を組む段を除けば同じ（Issue #593）
    const callDependent = ["budget_remaining_usd", "provider_cost_usd", "stages", "usage"];
    const differing = Object.keys(v11aSummaryRest).filter((key) => JSON.stringify(summaryRest[key]) !== JSON.stringify(v11aSummaryRest[key]));
    expect(differing.filter((key) => !callDependent.includes(key))).toEqual([]);
    expect(Object.keys(summaryRest).sort()).toEqual(Object.keys(v11aSummaryRest).sort());
    const laterStages = (summary: Record<string, unknown>) =>
      (summary["stages"] as readonly { readonly stage: string }[]).filter((record) => !["name-table", "vocabulary", "mapping"].includes(record.stage));
    expect(laterStages(summaryRest)).toEqual(laterStages(v11aSummaryRest));
  });

  it("旗の組の契約：export した V12_PIPELINE_FLAGS＝入口が渡した実効の旗＝要約の v12_flags＝条件の記録の v12_flags", async () => {
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const run = await runV11aCli({ dir: `${directory}/v12-flags`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    const passed = v11aSpy.mock.calls[0]?.[0];
    expect(passed?.flags).toEqual(factory.fromPublicV12Flags(factory.V12_PIPELINE_FLAGS));
    expect(passed?.flags).toEqual({ ledger: true, searchRepair: true, ids: true });
    expect(passed?.recordV12Flags).toBe(true);
    expect(run.summary["v12_flags"]).toEqual(factory.V12_PIPELINE_FLAGS);
    expect(run.record.conditions["v12_flags"]).toEqual(factory.V12_PIPELINE_FLAGS);
    expect(run.summary["v12_flags"]).toEqual(factory.toPublicV12Flags(factory.resolveV12Flags(passed?.flags)));
    expect(factory.V12_PIPELINE_FLAGS).toEqual({ ledger: true, "search-repair": true, ids: true });
    // 要約・条件の記録の旗の組は公開の鍵で ledger と search-repair（Issue #551）と ids（Issue #592）が on
    expect(run.summary["v12_flags"]).toEqual({ ledger: true, "search-repair": true, ids: true });
    expect(run.record.conditions["v12_flags"]).toEqual({ ledger: true, "search-repair": true, ids: true });
  });

  it("ids on の v1.2 の走りの条件の記録の v12_call_limits の 3 つの値は V12_CALL_LIMITS の値と欄ごとに等しい（Issue #616）", async () => {
    const run = await runV11aCli({ dir: `${directory}/v12-call-limits`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    const limits = run.record.conditions["v12_call_limits"] as Record<string, unknown>;
    expect(Object.keys(limits).sort()).toEqual(["judge_branch", "logical_calls", "real_attempts"]);
    expect(limits["logical_calls"]).toBe(V12_CALL_LIMITS.logicalCalls);
    expect(limits["real_attempts"]).toBe(V12_CALL_LIMITS.realAttempts);
    expect(limits["judge_branch"]).toBe(V12_CALL_LIMITS.judgeBranch);
    // 要約の v12_calls の門と枝の値は変えない（T2 の束の欄 test_spec を足すだけ。Issue #626）
    expect(run.summary["v12_calls"]).toEqual({
      real_attempts: { limit: 144, used: 12 },
      judge_branch: { limit: 80, used: 4 },
      // C3 の束の欄（Issue #735）：対象 4 件で束 1、形のやり直しの予算は要件 5 件で束 1（使わない）
      semantic_check: { rounds: [{ round: 1, bundles: 1 }], shape_retries: { limit: 1, used: 0, remaining: 1, by: [] } },
      test_spec: { bundles: 1, concurrency: 1, total: t2TotalOf(run.summary) },
    });
  });

  it("表を組む段（ids on は C1）で止まる走りでも要約と条件の記録に v12_flags がある（終了コード 1・納品物無し）", async () => {
    const broken = { entities: [{ name: "1member", role: "名前の規則に合わない行" }] };
    const run = await runV11aCli({
      dir: `${directory}/v12-early-stop`,
      calls: [structured(broken), structured(broken)],
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
    expect(run.summary).not.toHaveProperty("v12_calls");
    expect(run.record.conditions).not.toHaveProperty("v12_flags");
    expect(run.record.conditions).not.toHaveProperty("v12_call_limits");
    expect(run.record.conditions).not.toHaveProperty("pipeline");
    expect(v11aSpy.mock.calls[0]?.[0]).not.toHaveProperty("flags");
    expect(v11aSpy.mock.calls[0]?.[0]).not.toHaveProperty("recordV12Flags");
  });

  it("段の旗は v1.2 とも組める（Issue #637 で開いた）。v1 の経路・経路の旗が無いときは今までどおり stage-range:pipeline", () => {
    const v12 = parseCliArguments(["--", "request.txt", "--out", "out", "--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-end", "test-spec"]);
    expect("error" in v12 ? v12.error : v12.stageRange).toEqual({ start: "name-table", end: "test-spec" });
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--pipeline", "v1", "--plan-file", "plan.json", "--stage-end", "test-spec"]),
    ).toEqual({ error: "stage-range:pipeline（段の旗は --pipeline v1.1a か v1.2 と --plan-file と一緒に指定してください）" });
  });
});

describe("v1.2 の一気通貫の走りの checkpoint（`--pipeline v1.2 --plan-file`。Issue #636）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Build だけの記録の checkpoints の宣言 */
  type Declared = readonly { readonly boundary: string; readonly path: string; readonly output_digest: string }[];
  const declaredOf = (record: unknown): Declared => (record as { readonly checkpoints: Declared }).checkpoints;
  const CHECKPOINT_NAMES = [stageCheckpointFile("t1-t2"), stageCheckpointFile("t2-b1")];
  /** T2 の検査に 2 回落ちる応答（分類も場合も無い） */
  const badT2 = (): RecordedCall => structured(casesResponseOf({ classifications: [], tests: [] }));

  it("完走：段の走りと同じ名前の checkpoint が 2 つ `--out` の直下にあり、記録の checkpoints が 2 件で出力ダイジェストが中身から計算し直した値と一致する。manifest には載らない", async () => {
    const dir = `${directory}/v12-checkpoints`;
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const run = await runV11aCli({ dir, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    expect(v11aSpy.mock.calls[0]?.[0].collectBoundaries).toBe(true);
    const declared = declaredOf(run.record);
    expect(declared.map((entry) => entry.boundary)).toEqual(["t1-t2", "t2-b1"]);
    expect(declared.map((entry) => entry.path)).toEqual(CHECKPOINT_NAMES);
    for (const entry of declared) {
      const checkpoint = JSON.parse(await fs.readFile(`${dir}/${entry.path}`, "utf8")) as Record<string, unknown>;
      expect(entry.output_digest).toBe(await stageOutputDigest(checkpoint));
      expect(checkpoint["boundary"]).toBe(entry.boundary);
      // v1.2 の走りの checkpoint の版は、台帳の指紋・実効の旗の組・呼び出しの上限を足した 7 欄（Issue #637 で 4 欄から広げた）に、
      // 境界ごとの上流の台帳の部分の指紋（t1-t2 は部分の指紋、t2-b1 は null）を足した 8 欄（Issue #713 で 7 欄から広げた）
      expect(checkpoint["versions"]).toEqual({
        vocabulary: VOCABULARY_VERSION,
        contract: CONTRACT_VERSION,
        prompt: "v1.2",
        factory: "0.0.0",
        ledger: await ledgerModule.propertyLedgerSha256(),
        ledger_upstream: entry.boundary === "t1-t2" ? await ledgerModule.upstreamLedgerSha256() : null,
        flags: factory.V12_PIPELINE_FLAGS,
        call_limits: { logical_calls: V12_CALL_LIMITS.logicalCalls, real_attempts: V12_CALL_LIMITS.realAttempts, judge_branch: V12_CALL_LIMITS.judgeBranch },
      });
    }
    // checkpoint は納品物の後・Build だけの記録の前に書き、manifest の files には載らない
    expect(run.written.slice(-3)).toEqual([...CHECKPOINT_NAMES, BUILD_CLI_RECORD_FILE]);
    expect(run.written).toContain(BUNDLE_MANIFEST_FILE);
    expect(await fs.readFile(`${dir}/${BUNDLE_MANIFEST_FILE}`, "utf8")).not.toContain("stage-checkpoint");
    // Build だけの記録の既存の欄は今のまま（checkpoints を末尾に足すだけ）
    expect(Object.keys(run.record)).toEqual(["schema_version", "conditions", "plan_sha256", "source_sha256", "return_to_plan", "checkpoints"]);
  });

  it("段の入力の照合は Build だけの記録と checkpoint の組で ok を返し、壊した組は今までの符号で断る", async () => {
    const dir = `${directory}/v12-checkpoints-verify`;
    await runV11aCli({ dir, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    const envelope = await v11aEnvelope();
    const recordText = await fs.readFile(`${dir}/${BUILD_CLI_RECORD_FILE}`, "utf8");
    const verify = (start: "test-spec" | "write", checkpointText: string, record = recordText) =>
      verifyStageInput({
        start,
        checkpointText,
        checkpointFile: stageCheckpointFile(start === "write" ? "t2-b1" : "t1-t2"),
        recordText: record,
        plan: envelope["plan"] as ConfirmedPlan,
        planSha256: envelope["plan_sha256"] as string,
        sourceSha256: envelope["source_sha256"] as string,
        vocabularyVersion: VOCABULARY_VERSION,
        contractVersion: CONTRACT_VERSION,
      });
    const t1t2 = await fs.readFile(`${dir}/${stageCheckpointFile("t1-t2")}`, "utf8");
    const t2b1 = await fs.readFile(`${dir}/${stageCheckpointFile("t2-b1")}`, "utf8");
    expect(await verify("test-spec", t1t2)).toMatchObject({ ok: true });
    const fromB1 = await verify("write", t2b1);
    expect(fromB1).toMatchObject({ ok: true });
    // 壊した組：中身を 1 バイト変える → digest、記録の形の版を変える → version、別の境界 → boundary
    const edited = JSON.parse(t2b1) as Record<string, any>;
    edited["test_spec"]["suite_sha256"] = flip(edited["test_spec"]["suite_sha256"] as string);
    expect(await verify("write", `${JSON.stringify(edited, null, 2)}\n`)).toEqual({ ok: false, code: "stage-input:digest" });
    const otherSchema = JSON.stringify({ ...(JSON.parse(recordText) as Record<string, unknown>), schema_version: PLAN_ONLY_RESULT_SCHEMA });
    expect(await verify("write", t2b1, otherSchema)).toEqual({ ok: false, code: "stage-input:version" });
    expect(await verify("write", t1t2)).toEqual({ ok: false, code: "stage-input:boundary" });
    // 入口：段の走りの記録が無い `--out` の checkpoint を渡すと、Build だけの記録を前の走りの記録として読み、照合を通って流れる
    const resumed = await runStageCli({
      dir: `${directory}/v12-checkpoints-resume`,
      args: ["--stage-start", "write", "--stage-end", "judge", "--stage-input", `${dir}/${stageCheckpointFile("t2-b1")}`],
      calls: [structured({ declaration: V11A_YAML }), structured(v11aJudgments())],
    });
    expect(resumed.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(resumed.makeClient).toHaveBeenCalledTimes(1);
    expect(resumed.code).not.toBe(EXIT_STAGE_INPUT);
  });

  it("表を組む段（C1）で止まった走りは checkpoint 0 件で、記録の checkpoints が空", async () => {
    const dir = `${directory}/v12-checkpoints-c1`;
    const broken = { entities: [{ name: "1member", role: "名前の規則に合わない行" }] };
    const run = await runV11aCli({ dir, calls: [structured(broken), structured(broken)], pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_RUN_FAILED);
    expect(declaredOf(run.record)).toEqual([]);
    expect(run.written.filter((path) => path.startsWith("stage-checkpoint-"))).toEqual([]);
  });

  it("T2 で止まった走りは T1''／T2 の checkpoint だけを書き、記録もその 1 件", async () => {
    const dir = `${directory}/v12-checkpoints-t2`;
    const run = await runV11aCli({ dir, calls: [...v12Head().slice(0, 5), badT2(), badT2()], pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_RUN_FAILED);
    expect(run.summary["stop_reason"]).toBeDefined();
    expect((run.summary["stages"] as readonly { readonly stage: string }[]).at(-1)?.stage).toBe("test-spec");
    const declared = declaredOf(run.record);
    expect(declared.map((entry) => entry.boundary)).toEqual(["t1-t2"]);
    expect(run.written.filter((path) => path.startsWith("stage-checkpoint-"))).toEqual([stageCheckpointFile("t1-t2")]);
    const checkpoint = JSON.parse(await fs.readFile(`${dir}/${stageCheckpointFile("t1-t2")}`, "utf8")) as unknown;
    expect(declared[0]?.output_digest).toBe(await stageOutputDigest(checkpoint));
  });

  /** 旗 v12.ids だけ off にした v1.2 の走り（入口の旗の組は全部 on なので、実効の旗の組を差し替える） */
  const runV12IdsOff = async (dir: string) => {
    vi.spyOn(ledgerModule, "fromPublicV12Flags").mockImplementation(() => ({ ledger: true, searchRepair: true, ids: false }));
    const calls = [structured(v11aT1(true)), structured(v11aJudgments()), structured(v11aTestSpec()), structured({ declaration: V11A_YAML }), structured(v11aJudgments())];
    return runV11aCli({ dir, calls, pipeline: "v1.2" });
  };
  const BUILD_RECORD_KEYS = ["schema_version", "conditions", "plan_sha256", "source_sha256", "return_to_plan"];

  it("ids off の v1.2 の走りは境界の材料を集めさせず、checkpoint を書かず、Build だけの記録に checkpoints が無い（直す前と同じ欄・同じファイル）", async () => {
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const run = await runV12IdsOff(`${directory}/v12-ids-off-no-checkpoints`);
    expect(run.code).toBe(EXIT_OK);
    const passed = v11aSpy.mock.calls[0]?.[0];
    expect(passed?.flags).toEqual({ ledger: true, searchRepair: true, ids: false });
    expect(passed?.recordV12Flags).toBe(true);
    expect(passed).not.toHaveProperty("collectBoundaries");
    expect(run.summary["v12_flags"]).toEqual({ ledger: true, "search-repair": true, ids: false });
    expect(Object.keys(run.record)).toEqual(BUILD_RECORD_KEYS);
    expect(run.written.filter((path) => path.startsWith("stage-checkpoint-"))).toEqual([]);
    expect(run.written.at(-1)).toBe(BUILD_CLI_RECORD_FILE);
  });

  it("--stage-input の符号：v1.1a・ids off の v1.2・境界に届かなかった v1.2 の出力の場所は直す前と同じ unreadable、変わるのは ids on の v1.2 が checkpoint を書いた場所だけ", async () => {
    const v11aDir = `${directory}/stage-input-from-v11a`;
    await runV11aCli({ dir: v11aDir, calls: [...v11aHead(), structured(v11aJudgments())] });
    const idsOffDir = `${directory}/stage-input-from-v12-ids-off`;
    await runV12IdsOff(idsOffDir);
    vi.restoreAllMocks();
    const c1Dir = `${directory}/stage-input-from-v12-c1`;
    const broken = { entities: [{ name: "1member", role: "名前の規則に合わない行" }] };
    await runV11aCli({ dir: c1Dir, calls: [structured(broken), structured(broken)], pipeline: "v1.2" });
    const idsOnDir = `${directory}/stage-input-from-v12-ids-on`;
    await runV11aCli({ dir: idsOnDir, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });

    const resume = async (name: string, start: "test-spec" | "write", input: string) => {
      const run = await runStageCli({ dir: `${directory}/stage-input-out-${name}`, args: ["--stage-start", start, "--stage-input", input], calls: [] });
      expect(run.makeClient, name).not.toHaveBeenCalled();
      expect(run.written, name).toEqual([]);
      return { code: run.code, errors: run.errors };
    };
    const unreadable = { code: EXIT_STAGE_INPUT, errors: ["stage-input:unreadable"] };
    // 直す前と同じ：前の走りの記録（stage-run.json）が無い場所は、何を渡しても unreadable
    for (const [label, dir] of [["v11a", v11aDir], ["ids-off", idsOffDir]] as const) {
      expect(await resume(`${label}-t2b1`, "write", `${dir}/${stageCheckpointFile("t2-b1")}`), label).toEqual(unreadable);
      expect(await resume(`${label}-t1t2`, "test-spec", `${dir}/${stageCheckpointFile("t1-t2")}`), label).toEqual(unreadable);
      expect(await resume(`${label}-manifest`, "write", `${dir}/${BUNDLE_MANIFEST_FILE}`), label).toEqual(unreadable);
      expect(await resume(`${label}-record`, "write", `${dir}/${BUILD_CLI_RECORD_FILE}`), label).toEqual(unreadable);
    }
    // 境界に届かなかった ids on の v1.2（checkpoints が空）も同じ
    expect(declaredOf(JSON.parse(await fs.readFile(`${c1Dir}/${BUILD_CLI_RECORD_FILE}`, "utf8")))).toEqual([]);
    expect(await resume("c1-record", "write", `${c1Dir}/${BUILD_CLI_RECORD_FILE}`)).toEqual(unreadable);
    // 変わるのは ids on の v1.2 が checkpoint を書いた場所だけ：Build だけの記録を前の走りの記録として読み、境界で照合する
    expect(await resume("ids-on-record", "write", `${idsOnDir}/${BUILD_CLI_RECORD_FILE}`)).toEqual({ code: EXIT_STAGE_INPUT, errors: ["stage-input:boundary"] });
    expect(await resume("ids-on-t1t2-as-b1", "write", `${idsOnDir}/${stageCheckpointFile("t1-t2")}`)).toEqual({ code: EXIT_STAGE_INPUT, errors: ["stage-input:boundary"] });
  });

  it("--pipeline v1.1a の走りは境界の材料を集めさせず、checkpoint を書かず、記録に checkpoints が無い", async () => {
    const v11aSpy = vi.spyOn(v11aRunModule, "runGenerationV11a");
    const run = await runV11aCli({ dir: `${directory}/v11a-no-checkpoints`, calls: [...v11aHead(), structured(v11aJudgments())] });
    expect(run.code).toBe(EXIT_OK);
    expect(v11aSpy.mock.calls[0]?.[0]).not.toHaveProperty("collectBoundaries");
    expect(run.record).not.toHaveProperty("checkpoints");
    expect(run.written.filter((path) => path.startsWith("stage-checkpoint-"))).toEqual([]);
  });
});

describe("v1.2 の段の走り（`--pipeline v1.2 --plan-file` の段の旗。Issue #637）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type StageRow = { readonly stage: string };
  const stagesOf = (record: Record<string, unknown>): readonly string[] => (record["stages"] as readonly StageRow[]).map((row) => row.stage);
  const CALL_LIMITS = {
    logical_calls: V12_CALL_LIMITS.logicalCalls,
    real_attempts: V12_CALL_LIMITS.realAttempts,
    judge_branch: V12_CALL_LIMITS.judgeBranch,
  };
  const readJson = async (path: string): Promise<Record<string, any>> => JSON.parse(await fs.readFile(path, "utf8")) as Record<string, any>;
  /** 区間 0（C1 語彙 → C2 写像 → C3 意味の点検）の偽物の応答 */
  const segment0 = (): RecordedCall[] => v12Head().slice(0, 5);
  /** C2 が 2 回とも形で断られる応答（C1 の 3 束は通る） */
  const c2Broken = (): RecordedCall[] => {
    const outputs = idsResponseList(idsResponsesOf(V11A_LIST, V11A_TABLE_IDS, ledgerModule.PROPERTY_LEDGER_VIEW));
    const mapping = outputs[3] as { readonly requirements: readonly unknown[] };
    return [...outputs.slice(0, 3).map((output) => structured(output)), structured({ requirements: mapping.requirements.slice(1) }), structured({ requirements: mapping.requirements.slice(0, -1) })];
  };

  it("区間 0：段の履歴が vocabulary・mapping・semantic-check だけで、checkpoint t1-t2 の版に ledger・flags・call_limits がある。記録の条件に pipeline・v12_flags・v12_call_limits、記録に v12_calls があり、範囲が T2 を含まないので test_spec は無い", async () => {
    const dir = `${directory}/v12-stage-segment0`;
    const run = await runStageCli({ dir, args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"], calls: segment0(), pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    // 一気通貫の v1.2 と同じ封筒を選ぶ
    expect(run.makeClient.mock.calls).toEqual([[{ apiKey: "sk-FAKE", model: "gpt-6-luna", effort: "high", envelope: "v1.2-ids" }]]);
    expect(run.written).toEqual([stageCheckpointFile("t1-t2"), STAGE_RUN_RECORD_FILE, DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    const record = await stageRecordOf(dir);
    expect(new Set(stagesOf(record))).toEqual(new Set(["vocabulary", "mapping", "semantic-check"]));
    expect(record["range"]).toEqual({ start: "name-table", end: "semantic-check" });
    expect(record["stage_pass"]).toBe(true);
    const checkpoint = await readJson(`${dir}/${stageCheckpointFile("t1-t2")}`);
    // 境界 t1-t2 の版は上流の台帳の部分の指紋も持つ（Issue #713 で足した欄）
    expect(checkpoint["versions"]).toEqual({
      vocabulary: VOCABULARY_VERSION,
      contract: CONTRACT_VERSION,
      prompt: "v1.2",
      factory: "0.0.0",
      ledger: await ledgerModule.propertyLedgerSha256(),
      ledger_upstream: await ledgerModule.upstreamLedgerSha256(),
      flags: factory.V12_PIPELINE_FLAGS,
      call_limits: CALL_LIMITS,
    });
    const conditions = record["conditions"] as Record<string, unknown>;
    expect(conditions["prompt_version"]).toBe("v1.2");
    expect(conditions["pipeline"]).toBe("v1.2");
    expect(conditions["v12_flags"]).toEqual(factory.V12_PIPELINE_FLAGS);
    expect(conditions["v12_call_limits"]).toEqual(CALL_LIMITS);
    // 既存の欄の並びは今のまま（v1.2 の欄を末尾に足すだけ）
    expect(Object.keys(record).slice(-2)).toEqual(["exit_code", "v12_calls"]);
    // 門は生成 5 回（C1 の 3 束・C2・C3）と判定の枝（J4）を 1 つの数で数える
    const calls = record["v12_calls"] as { real_attempts: { limit: number; used: number }; judge_branch: { limit: number; used: number } };
    expect(calls.real_attempts.limit).toBe(V12_CALL_LIMITS.realAttempts);
    expect(calls.judge_branch.limit).toBe(V12_CALL_LIMITS.judgeBranch);
    expect(calls.judge_branch.used).toBeGreaterThan(0);
    expect(calls.real_attempts.used).toBe(5 + calls.judge_branch.used);
    expect(record).not.toHaveProperty("test_spec");
  });

  it("別名 vocabulary と正本の名前 name-table で、範囲・記録・checkpoint がバイト列で同じ（v1.1a は別名を受けない）", async () => {
    const alias = `${directory}/v12-stage-alias`;
    const canonical = `${directory}/v12-stage-canonical`;
    await runStageCli({ dir: alias, args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"], calls: segment0(), pipeline: "v1.2" });
    await runStageCli({ dir: canonical, args: ["--stage-start", "name-table", "--stage-end", "semantic-check"], calls: segment0(), pipeline: "v1.2" });
    for (const name of [STAGE_RUN_RECORD_FILE, stageCheckpointFile("t1-t2")]) {
      expect(await fs.readFile(`${alias}/${name}`, "utf8"), name).toBe(await fs.readFile(`${canonical}/${name}`, "utf8"));
    }
    const base = ["--", "request.txt", "--out", "out", "--plan-file", "plan.json", "--stage-start", "vocabulary"];
    const parsed = parseCliArguments([...base, "--pipeline", "v1.2"]);
    expect("error" in parsed ? parsed.error : parsed.stageRange).toEqual({ start: "name-table", end: "judge" });
    expect(parseCliArguments([...base, "--pipeline", "v1.1a"])).toMatchObject({ error: expect.stringMatching(/^stage-range:unknown（/u) });
  });

  it("区間 1・2 を v1.2 の checkpoint から入れる：区間 0 の t1-t2 で T2 だけ、その t2-b1 で B1〜⑦ を流す", async () => {
    const calls = [...v12Head(), structured(v11aJudgments())];
    const first = `${directory}/v12-stage-chain-a`;
    await runStageCli({ dir: first, args: ["--stage-end", "semantic-check"], calls: calls.slice(0, 5), pipeline: "v1.2" });
    const second = `${directory}/v12-stage-chain-b`;
    const t2 = await runStageCli({
      dir: second,
      args: ["--stage-start", "test-spec", "--stage-end", "test-spec", "--stage-input", `${first}/${stageCheckpointFile("t1-t2")}`],
      calls: calls.slice(5, 6),
      pipeline: "v1.2",
    });
    expect(t2.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(t2.code).toBe(EXIT_OK);
    const t2Record = await stageRecordOf(second);
    expect(new Set(stagesOf(t2Record))).toEqual(new Set(["test-spec"]));
    expect(t2Record["input"]).toMatchObject({ checkpoint: stageCheckpointFile("t1-t2"), boundary: "t1-t2" });
    const third = `${directory}/v12-stage-chain-c`;
    const b = await runStageCli({
      dir: third,
      args: ["--stage-start", "write", "--stage-input", `${second}/${stageCheckpointFile("t2-b1")}`],
      calls: calls.slice(6),
      pipeline: "v1.2",
    });
    expect(b.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(b.code).toBe(EXIT_OK);
    const bRecord = await stageRecordOf(third);
    expect(bRecord["stage_judge_verdict"]).toBe("full");
    // 範囲が T2 を含まない走りは test_spec を持たない
    expect(bRecord).not.toHaveProperty("test_spec");
    // v1.2 の一気通貫の走りの checkpoint からも、v1.2 の段の走りで入れる
    const whole = `${directory}/v12-stage-from-build`;
    await runV11aCli({ dir: whole, calls, pipeline: "v1.2" });
    const fromBuild = await runStageCli({
      dir: `${directory}/v12-stage-from-build-b`,
      args: ["--stage-start", "write", "--stage-input", `${whole}/${stageCheckpointFile("t2-b1")}`],
      calls: calls.slice(6),
      pipeline: "v1.2",
    });
    expect(fromBuild.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(fromBuild.code).toBe(EXIT_OK);
  });

  it("旗の組か台帳の指紋が違う checkpoint・欄の無い v1.1a の checkpoint を stage-input:version で断る（出力ダイジェストを書き直しても）。同じなら通り、v1.1a の段の走りは今までどおり v1.2 の checkpoint を受ける", async () => {
    const source = `${directory}/v12-stage-version-src`;
    await runStageCli({ dir: source, args: ["--stage-end", "semantic-check"], calls: segment0(), pipeline: "v1.2" });
    const v11aSource = `${directory}/v12-stage-version-v11a`;
    await runStageCli({ dir: v11aSource, args: ["--stage-end", "semantic-check"], calls: v11aHead().slice(0, 2) });
    const rejectedRun = async (name: string, input: string) => {
      const run = await runStageCli({ dir: `${directory}/v12-stage-version-out-${name}`, args: ["--stage-start", "test-spec", "--stage-input", input], calls: [], pipeline: "v1.2" });
      expect(run.makeClient, name).not.toHaveBeenCalled();
      expect(run.written, name).toEqual([]);
      return { code: run.code, errors: run.errors };
    };
    const version = { code: EXIT_STAGE_INPUT, errors: ["stage-input:version"] };
    const edits: readonly [string, (cp: Record<string, any>) => void][] = [
      ["flags-ids", (cp) => (cp["versions"]["flags"] = { ...cp["versions"]["flags"], ids: false })],
      ["flags-missing", (cp) => delete cp["versions"]["flags"]],
      // 境界 t1-t2 の台帳の照合は上流の台帳の部分の指紋（Issue #713。全体の指紋 ledger の違い・欠けは t2-b1 の試験で断る）
      ["ledger_upstream", (cp) => (cp["versions"]["ledger_upstream"] = flip(cp["versions"]["ledger_upstream"] as string))],
      ["ledger_upstream-missing", (cp) => delete cp["versions"]["ledger_upstream"]],
    ];
    for (const [name, edit] of edits) {
      const input = await tamper(source, `${directory}/v12-stage-version-${name}`, "t1-t2", edit, true);
      expect(await rejectedRun(name, input), name).toEqual(version);
    }
    // 上限は照合しない（記録だけ）：上限を変えて出力ダイジェストを書き直した checkpoint は版の照合を通る
    const limits = await tamper(source, `${directory}/v12-stage-version-limits`, "t1-t2", (cp) => (cp["versions"]["call_limits"] = null), true);
    const limitsRun = await runStageCli({ dir: `${directory}/v12-stage-version-out-limits`, args: ["--stage-start", "test-spec", "--stage-end", "test-spec", "--stage-input", limits], calls: [structured(v11aRenamed(v12TestSpec()))], pipeline: "v1.2" });
    expect(limitsRun.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(limitsRun.code).toBe(EXIT_OK);
    // 欄の無い v1.1a の checkpoint は v1.2 の段の走りでは断る
    expect(await rejectedRun("from-v11a", `${v11aSource}/${stageCheckpointFile("t1-t2")}`)).toEqual(version);
    // 今の走りの実効の旗の組が違えば、そのままの checkpoint も断る（旗の違う上流を混ぜない）
    vi.spyOn(ledgerModule, "fromPublicV12Flags").mockImplementation(() => ({ ledger: true, searchRepair: true, ids: false }));
    expect(await rejectedRun("run-flags", `${source}/${stageCheckpointFile("t1-t2")}`)).toEqual(version);
    vi.restoreAllMocks();
    // 上流の台帳の部分の指紋が今の走りと違えば断る（境界 t1-t2。Issue #713 で全体の指紋から部分の指紋に替えた）
    vi.spyOn(ledgerModule, "upstreamLedgerSha256").mockImplementation(async () => "0".repeat(64));
    expect(await rejectedRun("run-ledger", `${source}/${stageCheckpointFile("t1-t2")}`)).toEqual(version);
    vi.restoreAllMocks();
    // 同じなら通る
    const same = await runStageCli({ dir: `${directory}/v12-stage-version-out-same`, args: ["--stage-start", "test-spec", "--stage-end", "test-spec", "--stage-input", `${source}/${stageCheckpointFile("t1-t2")}`], calls: [structured(v11aRenamed(v12TestSpec()))], pipeline: "v1.2" });
    expect(same.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(same.code).toBe(EXIT_OK);
    // v1.1a の段の走りは flags・ledger を見ない（今の挙動の保持）：v1.2 の checkpoint の照合を通る
    const v11a = await runStageCli({ dir: `${directory}/v12-stage-version-out-v11a`, args: ["--stage-start", "test-spec", "--stage-end", "test-spec", "--stage-input", `${source}/${stageCheckpointFile("t1-t2")}`], calls: [structured(v11aTestSpec())] });
    expect(v11a.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(v11a.makeClient).toHaveBeenCalledTimes(1);
  });

  // ── 境界ごとの上流の台帳の部分の指紋（Issue #713）──────────────────────────────

  /** 文に目印を足す（null は null のまま） */
  const marked = (text: string | null): string | null => (text === null ? null : `${text}。目印の追記`);
  /** 上流の見方に入らない欄（T2 と B1 の規則の文・行の T2 の型）だけを変えた台帳（妥当な台帳のまま） */
  const t2OnlyLedger = (): readonly ledgerModule.PropertyRow[] =>
    ledgerModule.PROPERTY_LEDGER.map((row) => ({
      ...row,
      rules: { ...row.rules, t2: marked(row.rules.t2), t2Ids: marked(row.rules.t2Ids), b1: marked(row.rules.b1) },
      t2: row.t2 === null ? null : { ...row.t2, minTests: row.t2.minTests + 1 },
    }));
  /** 上流の見方に入る値（T1 の規則の文）を変えた台帳 */
  const upstreamLedger = (): readonly ledgerModule.PropertyRow[] =>
    ledgerModule.PROPERTY_LEDGER.map((row) => (row.rules.t1 === null ? row : { ...row, rules: { ...row.rules, t1: marked(row.rules.t1) } }));
  /** 今の工場の台帳を差し替える（全体の指紋と部分の指紋を、差し替えた台帳から本物の関数で出す） */
  const asFactoryWith = (rows: readonly ledgerModule.PropertyRow[]) => {
    const full = ledgerModule.propertyLedgerSha256;
    const upstream = ledgerModule.upstreamLedgerSha256;
    vi.spyOn(ledgerModule, "propertyLedgerSha256").mockImplementation(async () => full(rows));
    vi.spyOn(ledgerModule, "upstreamLedgerSha256").mockImplementation(async () => upstream(rows));
  };
  /** 断る段の走り（クライアントを作らない・何も書かない） */
  const refusedStage = async (name: string, start: "test-spec" | "write", input: string) => {
    const run = await runStageCli({ dir: `${directory}/v12-upstream-out-${name}`, args: ["--stage-start", start, "--stage-input", input], calls: [], pipeline: "v1.2" });
    expect(run.makeClient, name).not.toHaveBeenCalled();
    expect(run.written, name).toEqual([]);
    expect(run.lines, name).toEqual([]);
    return { code: run.code, errors: run.errors };
  };
  const versionRefusal = { code: EXIT_STAGE_INPUT, errors: ["stage-input:version"] };

  it("台帳の部分の指紋（Issue #713）：上流の見方に入らない欄だけを変えた台帳の工場は変える前の工場の t1-t2 を受けて T2 を流し、t2-b1（ledger_upstream null・新しい全体の指紋）を書く。上流の値を変えた台帳の工場は t1-t2 を、T2 の型を変えた台帳の工場は t2-b1 を stage-input:version で断る", async () => {
    expect(ledgerModule.ledgerRowDefects(t2OnlyLedger())).toEqual([]);
    expect(ledgerModule.ledgerRowDefects(upstreamLedger())).toEqual([]);
    expect(await ledgerModule.propertyLedgerSha256(t2OnlyLedger())).not.toBe(await ledgerModule.propertyLedgerSha256());
    expect(await ledgerModule.upstreamLedgerSha256(t2OnlyLedger())).toBe(await ledgerModule.upstreamLedgerSha256());
    expect(await ledgerModule.upstreamLedgerSha256(upstreamLedger())).not.toBe(await ledgerModule.upstreamLedgerSha256());
    // 変える前の工場が書いた t1-t2・t2-b1（区間 0 と T2）
    const source = `${directory}/v12-upstream-src`;
    expect((await runStageCli({ dir: source, args: ["--stage-end", "test-spec"], calls: v12Head().slice(0, 6), pipeline: "v1.2" })).code).toBe(EXIT_OK);
    // T2 から後ろだけを変えた台帳の工場：t1-t2 を照らして T2 だけを流し、t2-b1 を書く
    asFactoryWith(t2OnlyLedger());
    const t2Dir = `${directory}/v12-upstream-t2`;
    const t2 = await runStageCli({
      dir: t2Dir,
      args: ["--stage-start", "test-spec", "--stage-end", "test-spec", "--stage-input", `${source}/${stageCheckpointFile("t1-t2")}`],
      calls: [structured(v11aRenamed(v12TestSpec()))],
      pipeline: "v1.2",
    });
    expect(t2.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(t2.code).toBe(EXIT_OK);
    expect(t2.written).toEqual([stageCheckpointFile("t2-b1"), STAGE_RUN_RECORD_FILE]);
    expect((await stageRecordOf(t2Dir))["input"]).toMatchObject({ checkpoint: stageCheckpointFile("t1-t2"), boundary: "t1-t2" });
    const written = await readJson(`${t2Dir}/${stageCheckpointFile("t2-b1")}`);
    expect(written["versions"]["ledger"]).toBe(await ledgerModule.propertyLedgerSha256(t2OnlyLedger()));
    expect(written["versions"]).toHaveProperty("ledger_upstream", null);
    // 同じ工場は、変える前の工場が書いた t2-b1 を今のまま全体の指紋で断る
    expect(await refusedStage("t2-change-b1", "write", `${source}/${stageCheckpointFile("t2-b1")}`)).toEqual(versionRefusal);
    vi.restoreAllMocks();
    // 上流の見方に入る値を変えた台帳の工場は t1-t2 を断る
    asFactoryWith(upstreamLedger());
    expect(await refusedStage("upstream-change-t1", "test-spec", `${source}/${stageCheckpointFile("t1-t2")}`)).toEqual(versionRefusal);
    vi.restoreAllMocks();
    // 対照：変えない工場は同じ t1-t2 と t2-b1 を受ける
    const same = await runStageCli({
      dir: `${directory}/v12-upstream-same`,
      args: ["--stage-start", "test-spec", "--stage-end", "test-spec", "--stage-input", `${source}/${stageCheckpointFile("t1-t2")}`],
      calls: [structured(v11aRenamed(v12TestSpec()))],
      pipeline: "v1.2",
    });
    expect(same.code).toBe(EXIT_OK);
    const b1 = await runStageCli({
      dir: `${directory}/v12-upstream-same-b1`,
      args: ["--stage-start", "write", "--stage-input", `${source}/${stageCheckpointFile("t2-b1")}`],
      calls: [...v12Head(), structured(v11aJudgments())].slice(6),
      pipeline: "v1.2",
    });
    expect(b1.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(b1.code).toBe(EXIT_OK);
  });

  it("t1-t2 の入力の ledger_upstream の欠け・null・不正の形・不一致・全体の指紋への差し替えと旗の違いを、クライアントを作る前に出力なしで断る。今の工場の部分の指紋が不正の形でも断る（Issue #713）", async () => {
    const source = `${directory}/v12-upstream-t1-src`;
    await runStageCli({ dir: source, args: ["--stage-end", "semantic-check"], calls: segment0(), pipeline: "v1.2" });
    const edits: readonly [string, (cp: Record<string, any>) => void][] = [
      ["missing", (cp) => delete cp["versions"]["ledger_upstream"]],
      ["null", (cp) => (cp["versions"]["ledger_upstream"] = null)],
      ["upper", (cp) => (cp["versions"]["ledger_upstream"] = (cp["versions"]["ledger_upstream"] as string).toUpperCase())],
      ["short", (cp) => (cp["versions"]["ledger_upstream"] = (cp["versions"]["ledger_upstream"] as string).slice(1))],
      ["number", (cp) => (cp["versions"]["ledger_upstream"] = 1)],
      ["mismatch", (cp) => (cp["versions"]["ledger_upstream"] = flip(cp["versions"]["ledger_upstream"] as string))],
      ["full-instead", (cp) => (cp["versions"]["ledger_upstream"] = cp["versions"]["ledger"])],
      // 版 1（Issue #725 の前）の部分の指紋を持つ checkpoint は今の固定文で断る
      ["version-1", (cp) => (cp["versions"]["ledger_upstream"] = V12_UPSTREAM_BEFORE_725)],
      ["flags", (cp) => (cp["versions"]["flags"] = { ...cp["versions"]["flags"], ids: false })],
    ];
    for (const [name, edit] of edits) {
      const input = await tamper(source, `${directory}/v12-upstream-t1-${name}`, "t1-t2", edit, true);
      expect(await refusedStage(`t1-${name}`, "test-spec", input), name).toEqual(versionRefusal);
    }
    // 今の工場の部分の指紋の値が取れない形なら、照合を省かずに断る
    for (const [name, value] of [["empty", ""], ["short", "0".repeat(63)]] as const) {
      vi.spyOn(ledgerModule, "upstreamLedgerSha256").mockImplementation(async () => value);
      expect(await refusedStage(`t1-run-${name}`, "test-spec", `${source}/${stageCheckpointFile("t1-t2")}`), name).toEqual(versionRefusal);
      vi.restoreAllMocks();
    }
  });

  it("t2-b1 の入力は今のまま全体の指紋で照らす（Issue #713）：新しい欄の無い今までの入力・null 以外の値も受け、全体の指紋が違えば新しい欄が一致でも null でも、クライアントを作る前に出力なしで断る", async () => {
    const calls = [...v12Head(), structured(v11aJudgments())];
    const source = `${directory}/v12-upstream-b1-src`;
    await runStageCli({ dir: source, args: ["--stage-end", "test-spec"], calls: calls.slice(0, 6), pipeline: "v1.2" });
    const upstream = await ledgerModule.upstreamLedgerSha256();
    const accepted: readonly [string, (cp: Record<string, any>) => void][] = [
      ["no-field", (cp) => delete cp["versions"]["ledger_upstream"]],
      ["value", (cp) => (cp["versions"]["ledger_upstream"] = upstream)],
      ["other", (cp) => (cp["versions"]["ledger_upstream"] = "x")],
    ];
    for (const [name, edit] of accepted) {
      const input = await tamper(source, `${directory}/v12-upstream-b1-${name}`, "t2-b1", edit, true);
      const run = await runStageCli({ dir: `${directory}/v12-upstream-b1-out-${name}`, args: ["--stage-start", "write", "--stage-input", input], calls: calls.slice(6), pipeline: "v1.2" });
      expect(run.errors.filter((line) => line.startsWith("stage-input:")), name).toEqual([]);
      expect(run.code, name).toBe(EXIT_OK);
    }
    const refused: readonly [string, (cp: Record<string, any>) => void][] = [
      ["ledger-null", (cp) => (cp["versions"]["ledger"] = flip(cp["versions"]["ledger"] as string))],
      [
        "ledger-upstream-same",
        (cp) => {
          cp["versions"]["ledger"] = flip(cp["versions"]["ledger"] as string);
          cp["versions"]["ledger_upstream"] = upstream;
        },
      ],
      ["ledger-missing", (cp) => delete cp["versions"]["ledger"]],
      ["flags", (cp) => (cp["versions"]["flags"] = { ...cp["versions"]["flags"], ids: false })],
    ];
    for (const [name, edit] of refused) {
      const input = await tamper(source, `${directory}/v12-upstream-b1-${name}`, "t2-b1", edit, true);
      expect(await refusedStage(`b1-${name}`, "write", input), name).toEqual(versionRefusal);
    }
    // t2-b1 は今の工場の部分の指紋を受理の判断に使わない（値が取れない形でも、全体の指紋が同じなら通る）
    vi.spyOn(ledgerModule, "upstreamLedgerSha256").mockImplementation(async () => "");
    const run = await runStageCli({ dir: `${directory}/v12-upstream-b1-out-run`, args: ["--stage-start", "write", "--stage-input", `${source}/${stageCheckpointFile("t2-b1")}`], calls: calls.slice(6), pipeline: "v1.2" });
    expect(run.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(run.code).toBe(EXIT_OK);
  });

  it("1 段先の範囲（vocabulary..test-spec）：段の履歴が区間 0 と test-spec だけで、test_spec の dropped_tests が偽物の T2' で外した数と一致し、tests・coverage_units が t2-b1 の組と一致する", async () => {
    const original = testSpecModule.runTestSpec;
    const fakeDropped = [
      { round: 1, testId: "dropped-marker-a", requirementId: "R1", operation: "compute" as const },
      { round: 1, testId: "dropped-marker-b", requirementId: "R1", operation: "compute" as const },
      { round: 1, testId: "dropped-marker-c", requirementId: "R1", operation: "compute" as const },
    ];
    const spy = vi.spyOn(testSpecModule, "runTestSpec").mockImplementation(async (input) => {
      input.onDropped?.(fakeDropped.slice(0, 2));
      input.onDropped?.(fakeDropped.slice(2));
      return original(input);
    });
    const dir = `${directory}/v12-stage-one-ahead`;
    const run = await runStageCli({ dir, args: ["--stage-start", "vocabulary", "--stage-end", "test-spec"], calls: v12Head().slice(0, 6), pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    expect(spy).toHaveBeenCalledTimes(1);
    const record = await stageRecordOf(dir);
    expect(new Set(stagesOf(record))).toEqual(new Set(["vocabulary", "mapping", "semantic-check", "test-spec"]));
    const checkpoint = await readJson(`${dir}/${stageCheckpointFile("t2-b1")}`);
    expect(record["test_spec"]).toEqual({
      tests: (checkpoint["test_spec"]["suite"]["tests"] as readonly unknown[]).length,
      dropped_tests: fakeDropped.length,
      coverage_units: (checkpoint["test_spec"]["coverage_units"] as readonly unknown[]).length,
    });
    expect(Object.keys(record).slice(-3)).toEqual(["exit_code", "v12_calls", "test_spec"]);
    expect(record["v12_calls"]).toHaveProperty("test_spec");
  });

  it("1 段先の範囲で C2 で止めた走りは test_spec が null（T2 に届かない）。checkpoint を書かない", async () => {
    const dir = `${directory}/v12-stage-one-ahead-c2`;
    const run = await runStageCli({ dir, args: ["--stage-start", "vocabulary", "--stage-end", "test-spec"], calls: c2Broken(), pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_RUN_FAILED);
    // 形で落ちた段の走りは、記録に加えて断った候補と C2 の回ごとの行の診断を書く（Issue #683・#699）
    expect(run.written).toEqual([STAGE_RUN_RECORD_FILE, DIAGNOSTICS_REJECTED_MAPPING_FILE, DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    const record = await stageRecordOf(dir);
    expect(record["stopped"]).toMatchObject({ stage: "mapping", kind: "unmet" });
    expect(record).toHaveProperty("test_spec", null);
  });

  it("v1.1a の段の走りは直す前とバイト列で同じ：checkpoint の版は 4 欄、記録に pipeline・v12_* ・test_spec が無く、封筒は v1.1a", async () => {
    const dir = `${directory}/v11a-stage-bytes`;
    const run = await runStageCli({ dir, args: ["--stage-end", "judge"], calls: [...v11aHead(), structured(v11aJudgments())] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.makeClient.mock.calls).toEqual([[{ apiKey: "sk-FAKE", model: "gpt-6-luna", effort: "high", envelope: "v1.1a" }]]);
    for (const boundary of ["t1-t2", "t2-b1"] as const) {
      const checkpoint = await readJson(`${dir}/${stageCheckpointFile(boundary)}`);
      expect(Object.keys(checkpoint["versions"] as object)).toEqual(["vocabulary", "contract", "prompt", "factory"]);
    }
    const record = await stageRecordOf(dir);
    expect(record).not.toHaveProperty("v12_calls");
    expect(record).not.toHaveProperty("test_spec");
    const conditions = record["conditions"] as Record<string, unknown>;
    for (const key of ["pipeline", "v12_flags", "v12_call_limits"]) expect(conditions).not.toHaveProperty(key);
    // 直す前（bf68da8。#636 を載せ直した main）のバイト列の SHA-256（記録と checkpoint 2 つ。直す前のコードで測った値。手で直さない）
    const digests = await Promise.all(
      [STAGE_RUN_RECORD_FILE, stageCheckpointFile("t1-t2"), stageCheckpointFile("t2-b1")].map(async (name) => sha256Hex(await fs.readFile(`${dir}/${name}`, "utf8"))),
    );
    expect(digests).toEqual(V11A_STAGE_RUN_DIGESTS);
    expect(run.lines.at(-1)).toBe(JSON.stringify({ stage_pass: true, reached_stage: "judge", budget_scope: "stage-run", exit_code: EXIT_OK }));
  });
});

describe("v1.2 の段の走りが断った候補を診断に書く（一気通貫と同じ関数・同じ名前。Issue #683）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const outputs = () => idsResponsesOf(V11A_LIST, V11A_TABLE_IDS, ledgerModule.PROPERTY_LEDGER_VIEW);
  const raw = (): readonly Record<string, unknown>[] => idsResponseList(outputs());
  const rawFields = (): { readonly fields: readonly Record<string, unknown>[] } => raw()[1] as { readonly fields: readonly Record<string, unknown>[] };
  const fieldsWithEntity = (entity: string) => ({
    fields: rawFields().fields.map((item, index) => (index === 0 ? { ...item, entity } : item)),
  });
  const mappingRequirements = (): readonly unknown[] => (outputs().mapping as { readonly requirements: readonly unknown[] }).requirements;
  const missingFirst = () => ({ requirements: mappingRequirements().slice(1) });
  const missingLast = () => ({ requirements: mappingRequirements().slice(0, -1) });
  /** 区間 0（C1 語彙 → C2 写像 → C3 意味の点検）の偽物の応答 */
  const segment0 = (): RecordedCall[] => [
    structured(raw()[0]),
    structured(raw()[1]),
    structured(raw()[2]),
    structured(raw()[3]),
    structured(v11aJudgments()),
  ];
  /** 区間 0 の C1 の束 2 が形で落ちてやり直しで通る応答 */
  const c1Retry = (): RecordedCall[] => [
    structured(raw()[0]),
    structured(fieldsWithEntity("E8")),
    structured(raw()[1]),
    structured(raw()[2]),
    structured(raw()[3]),
    structured(v11aJudgments()),
  ];
  /** 区間 0 の C2 の初回が形で落ちて試行 2 で通る応答 */
  const c2Retry = (): RecordedCall[] => [
    structured(raw()[0]),
    structured(raw()[1]),
    structured(raw()[2]),
    structured(missingFirst()),
    structured(raw()[3]),
    structured(v11aJudgments()),
  ];
  /** 同じ台本の一気通貫（C2 のあと T2・B1・B3' まで） */
  const c2RetryWhole = (): RecordedCall[] => [
    ...c2Retry(),
    structured(v11aRenamed(v12TestSpec())),
    structured({ declaration: V11A_YAML }),
    structured(v11aJudgments()),
  ];
  /**
   * 1 段先の範囲（vocabulary..test-spec）で T2 が 1 回断ってやり直しで通る応答（一覧に無い要件 ID の場合）。旗 ids の T2 の応答は
   * 場合の形で、構造の要件 R2 は書かない（#624・#625。`v12TestSpec` と同じ内容に場合を 1 つ足す）
   */
  const t2Retry = (): RecordedCall[] => {
    const spec = v11aTestSpec() as { readonly classifications: readonly { readonly requirementId: string }[]; readonly tests: readonly { readonly target: { readonly requirementId: string } }[] };
    const bad = casesResponseOf({
      classifications: spec.classifications.filter((entry) => entry.requirementId !== "R2"),
      tests: [
        ...spec.tests.filter((test) => test.target.requirementId !== "R2"),
        v11aTest({
          id: "r9-extra",
          requirementId: "R9",
          targetKind: "field",
          roleId: "f.item.amount",
          kind: "normal",
          operation: "validate",
          observes: "validation",
          input: { "f.item.amount": 5 },
          expected: okValue("true"),
        }),
      ],
    });
    return [...segment0(), structured(v11aRenamed(bad)), structured(v11aRenamed(v12TestSpec()))];
  };
  const candidatesOf = async (dir: string, path: string): Promise<readonly Record<string, unknown>[]> =>
    (JSON.parse(await fs.readFile(`${dir}/${path}`, "utf8")) as { readonly candidates: readonly Record<string, unknown>[] }).candidates;
  const digestsOf = async (dir: string, names: readonly string[]): Promise<readonly string[]> =>
    Promise.all(names.map(async (name) => sha256Hex(await fs.readFile(`${dir}/${name}`, "utf8"))));

  it("(1) C1 の束 2 の初回が形で落ちてやり直しで通る段の走り：rejected-vocabulary に候補 1 件、記録・checkpoint・1 行の要約・終了コードは直す前とバイト列で同じ", async () => {
    const dir = `${directory}/v12-stage-diag-c1`;
    const run = await runStageCli({ dir, args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"], calls: c1Retry(), pipeline: "v1.2" });
    // Issue #713 で取り直した値（記録と t1-t2 の checkpoint。旧の値は下で確かめる。診断を足してもバイト列は変えない。手で直さない）
    expect(await digestsOf(dir, [STAGE_RUN_RECORD_FILE, stageCheckpointFile("t1-t2")])).toEqual(V12_STAGE_C1_RETRY_DIGESTS);
    // 差は checkpoint の版の ledger_upstream と、それに由来する記録の出力ダイジェストだけ（Issue #713）：欄を除いた checkpoint と、
    // その出力ダイジェストに戻した記録は、直す前（fa21c65）のバイト列と同じ
    const checkpoint = JSON.parse(await fs.readFile(`${dir}/${stageCheckpointFile("t1-t2")}`, "utf8")) as Record<string, any>;
    expect(checkpoint["versions"]["ledger_upstream"]).toBe(await ledgerModule.upstreamLedgerSha256());
    // Issue #735 で取り直した差は、論理の枠の値（checkpoint の call_limits・条件の記録の v12_call_limits）と記録の v12_calls の C3 の束の欄、
    // それに由来する記録の出力ダイジェストだけ：欄を旧の値に戻すと #735 の前と同じ。以下の #725・#713 の照合は戻した値で続ける
    expect(checkpoint["versions"]["call_limits"]["logical_calls"]).toBe(80);
    revert735(checkpoint);
    {
      const revertedRecord = await stageRecordOf(dir);
      expect((revertedRecord["v12_calls"] as Record<string, unknown>)["semantic_check"]).toEqual({ rounds: [{ round: 1, bundles: 1 }], shape_retries: { limit: 1, used: 0, remaining: 1, by: [] } });
      revert735(revertedRecord);
      (revertedRecord["checkpoints"] as { output_digest: string }[])[0]!.output_digest = await stageOutputDigest(checkpoint);
      expect([await sha256Hex(stageJsonText(revertedRecord)), await sha256Hex(stageJsonText(checkpoint))]).toEqual(V12_STAGE_C1_RETRY_DIGESTS_BEFORE_735);
    }
    // Issue #725 で取り直した差は、checkpoint の ledger_upstream と記録の出力ダイジェストだけ：版 1 の部分の指紋に戻すと #725 の前と同じ
    {
      const reverted = { ...checkpoint, versions: { ...checkpoint["versions"], ledger_upstream: V12_UPSTREAM_BEFORE_725 } };
      const revertedRecord = await stageRecordOf(dir);
      revert735(revertedRecord);
      (revertedRecord["checkpoints"] as { output_digest: string }[])[0]!.output_digest = await stageOutputDigest(reverted);
      expect([await sha256Hex(stageJsonText(revertedRecord)), await sha256Hex(stageJsonText(reverted))]).toEqual(V12_STAGE_C1_RETRY_DIGESTS_BEFORE_725);
    }
    delete checkpoint["versions"]["ledger_upstream"];
    const record = await stageRecordOf(dir);
    revert735(record);
    const before = record["checkpoints"] as { output_digest: string }[];
    before[0]!.output_digest = await stageOutputDigest(checkpoint);
    expect([await sha256Hex(stageJsonText(record)), await sha256Hex(stageJsonText(checkpoint))]).toEqual(V12_STAGE_C1_RETRY_DIGESTS_BEFORE_713);
    expect(run.code).toBe(EXIT_OK);
    expect(run.written).toEqual([stageCheckpointFile("t1-t2"), STAGE_RUN_RECORD_FILE, DIAGNOSTICS_REJECTED_VOCABULARY_FILE, DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    expect(run.lines.at(-1)).toBe(
      JSON.stringify({ stage_pass: true, reached_stage: "semantic-check", budget_scope: "stage-run", exit_code: EXIT_OK }),
    );
    // 記録は診断を宣言しない（一気通貫の Build だけの記録と同じ）
    expect(JSON.stringify(await stageRecordOf(dir))).not.toContain("diagnostics");
    const candidates = await candidatesOf(dir, DIAGNOSTICS_REJECTED_VOCABULARY_FILE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ stage: "vocabulary", operation: null, call: 2, round: 1, attempt: 1, kind: "shape" });
    // raw と SHA-256 は無加工
    const bad = fieldsWithEntity("E8");
    expect(candidates[0]?.["response"]).toEqual(bad);
    expect(candidates[0]?.["response_sha256"]).toBe(await sha256Hex(JSON.stringify(bad)));
    expectNoAcceptanceMaterial([...run.requests, ...candidates.map((candidate) => JSON.stringify(candidate))]);
  });

  it("(2) C2 の初回が形で落ちる段の走り：rejected-mapping の候補の一覧が、同じ台本の一気通貫の同じ名前の診断と深く等しい", async () => {
    const stageDir = `${directory}/v12-stage-diag-c2-stage`;
    const wholeDir = `${directory}/v12-stage-diag-c2-whole`;
    const stageRun = await runStageCli({ dir: stageDir, args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"], calls: c2Retry(), pipeline: "v1.2" });
    await runV11aCli({ dir: wholeDir, calls: c2RetryWhole(), pipeline: "v1.2" });
    const stageText = await fs.readFile(`${stageDir}/${DIAGNOSTICS_REJECTED_MAPPING_FILE}`, "utf8");
    const wholeText = await fs.readFile(`${wholeDir}/${DIAGNOSTICS_REJECTED_MAPPING_FILE}`, "utf8");
    // 同じ関数が組むので、ファイルのバイト列まで同じ
    expect(stageText).toBe(wholeText);
    const candidates = (JSON.parse(stageText) as { readonly candidates: readonly Record<string, unknown>[] }).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ stage: "mapping", operation: null, call: 1, round: 1, attempt: 1, kind: "shape" });
    expectNoAcceptanceMaterial([...stageRun.requests, stageText]);
  });

  it("(3) C2 が 2 回落ちて止まる段の走り（終了コード 1）：候補 2 件が書かれ、記録の停止は直す前と同じ", async () => {
    const dir = `${directory}/v12-stage-diag-c2-stop`;
    const run = await runStageCli({
      dir,
      args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"],
      calls: [structured(raw()[0]), structured(raw()[1]), structured(raw()[2]), structured(missingFirst()), structured(missingLast())],
      pipeline: "v1.2",
    });
    expect(run.code).toBe(EXIT_RUN_FAILED);
    // 記録の SHA-256（境界に届かないので checkpoint は無い。手で直さない）。Issue #735 で取り直した差は論理の枠の値だけで、戻すと直す前
    // （fa21c65）のコードで測った値と同じ
    expect(await digestsOf(dir, [STAGE_RUN_RECORD_FILE])).toEqual(V12_STAGE_C2_STOP_DIGESTS);
    {
      const reverted = await stageRecordOf(dir);
      expect(reverted["v12_calls"]).not.toHaveProperty("semantic_check");
      revert735(reverted);
      expect([await sha256Hex(stageJsonText(reverted))]).toEqual(V12_STAGE_C2_STOP_DIGESTS_BEFORE_735);
    }
    expect(run.written).toEqual([STAGE_RUN_RECORD_FILE, DIAGNOSTICS_REJECTED_MAPPING_FILE, DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    const record = await stageRecordOf(dir);
    expect(record["stopped"]).toMatchObject({ stage: "mapping", kind: "unmet" });
    const candidates = await candidatesOf(dir, DIAGNOSTICS_REJECTED_MAPPING_FILE);
    expect(candidates.map((candidate) => [candidate["stage"], candidate["call"], candidate["round"], candidate["attempt"]])).toEqual([
      ["mapping", 1, 1, 1],
      ["mapping", 1, 1, 2],
    ]);
    expect(candidates[0]?.["response"]).toEqual(missingFirst());
    expect(candidates[1]?.["response"]).toEqual(missingLast());
    expectNoAcceptanceMaterial([...run.requests, ...candidates.map((candidate) => JSON.stringify(candidate))]);
  });

  it("(4) 1 段先の範囲（vocabulary..test-spec）で T2 が断った候補は rejected-test-spec に書かれる", async () => {
    const dir = `${directory}/v12-stage-diag-t2`;
    const run = await runStageCli({ dir, args: ["--stage-start", "vocabulary", "--stage-end", "test-spec"], calls: t2Retry(), pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    expect(run.written).toEqual([
      stageCheckpointFile("t1-t2"),
      stageCheckpointFile("t2-b1"),
      STAGE_RUN_RECORD_FILE,
      DIAGNOSTICS_REJECTED_TEST_SPEC_FILE,
      DIAGNOSTICS_TABLE_ROUNDS_FILE,
    ]);
    const candidates = await candidatesOf(dir, DIAGNOSTICS_REJECTED_TEST_SPEC_FILE);
    expect(candidates).toHaveLength(1);
    // 旗 ids の T2 は場合の形で、一覧に無い要件 ID の場合は展開の前の形の検査で断る（#625 から kind は shape・文は場合の検査の文）
    expect(candidates[0]).toMatchObject({ stage: "test-spec", operation: null, call: 1, round: 1, attempt: 1, kind: "shape" });
    expect(JSON.stringify(candidates[0]?.["problems"])).toContain("場合の要件 ID が要件の一覧に無い");
    expectNoAcceptanceMaterial([...run.requests, ...candidates.map((candidate) => JSON.stringify(candidate))]);
  });

  it("(5) 形で 1 度も落ちない走り：診断の置き場所に C2 の回ごとの行の 1 本だけを書き、記録・checkpoint は直す前と同じ（Issue #683・#699）", async () => {
    const dir = `${directory}/v12-stage-diag-none`;
    const run = await runStageCli({ dir, args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"], calls: segment0(), pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    expect(run.written).toEqual([stageCheckpointFile("t1-t2"), STAGE_RUN_RECORD_FILE, DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    // 回ごとの行の 1 本だけを書き、候補のファイルは無い
    const rounds = (JSON.parse(await fs.readFile(`${dir}/${DIAGNOSTICS_TABLE_ROUNDS_FILE}`, "utf8")) as { readonly rounds: readonly unknown[] }).rounds;
    expect(rounds).toHaveLength(1);
    expectNoAcceptanceMaterial(run.requests);
  });

  it("(6) v1.1a の段の走り：書いたファイルの一覧とバイト列が直す前と同じ（診断を書かない）", async () => {
    const dir = `${directory}/v11a-stage-diag-none`;
    const run = await runStageCli({ dir, args: ["--stage-end", "judge"], calls: [...v11aHead(), structured(v11aJudgments())] });
    expect(run.code).toBe(EXIT_OK);
    expect(run.written).toEqual([stageCheckpointFile("t1-t2"), stageCheckpointFile("t2-b1"), STAGE_RUN_RECORD_FILE]);
    expect(run.directories).not.toContain(`${dir}/diagnostics`);
    expect(await digestsOf(dir, [STAGE_RUN_RECORD_FILE, stageCheckpointFile("t1-t2"), stageCheckpointFile("t2-b1")])).toEqual(V11A_STAGE_RUN_DIGESTS);
    expectNoAcceptanceMaterial(run.requests);
  });

  it("(6b) v1.1a の段の走りで T1 が形で 1 度落ちてやり直しで通る：結果に rejected が入っても、記録・checkpoint・要約・書いたファイルの一覧は直す前と同じ（診断を書かない）", async () => {
    const dir = `${directory}/v11a-stage-diag-t1`;
    const spy = vi.spyOn(v11aRunModule, "runStageRangeV11a");
    // T1 の初回が形で落ちて（`v11aBadDraftCall`）2 回目で通る台本。終了 T1'' なので T2 以降は呼ばない
    const run = await runStageCli({ dir, args: ["--stage-end", "semantic-check"], calls: [v11aBadDraftCall(), ...v11aHead()] });
    expect(run.code).toBe(EXIT_OK);
    // 直す前（fa21c65）のコードで測った値（記録と t1-t2 の checkpoint。v1.1a は診断を書かないのでバイト列は変わらない。手で直さない）
    expect(await digestsOf(dir, [STAGE_RUN_RECORD_FILE, stageCheckpointFile("t1-t2")])).toEqual(V11A_STAGE_T1_RETRY_DIGESTS);
    // 段の走りの結果には断った候補が入る（cli の試験で結果を読む）
    expect(spy).toHaveBeenCalledTimes(1);
    const outcome = await (spy.mock.results[0]?.value as Promise<Awaited<ReturnType<typeof v11aRunModule.runStageRangeV11a>>>);
    expect(outcome.rejected?.length).toBeGreaterThanOrEqual(1);
    // v1.1a の T1 の初回の落ちは、段が `content` として積む（`v11aBadDraftCall` の応答）
    expect(outcome.rejected?.[0]).toMatchObject({ stage: "name-table", operation: null, call: 1, round: 1, attempt: 1, kind: "content" });
    // 入口は v1.1a の段の走りで診断を書かない（置き場所も作らない）
    expect(run.written).toEqual([stageCheckpointFile("t1-t2"), STAGE_RUN_RECORD_FILE]);
    expect(run.directories).not.toContain(`${dir}/diagnostics`);
    const recordText = await fs.readFile(`${dir}/${STAGE_RUN_RECORD_FILE}`, "utf8");
    expect(recordText).not.toContain("rejected");
    expect(recordText).not.toContain("diagnostics");
    // 要約の 1 行は直す前と同じ
    expect(run.lines.at(-1)).toBe(
      JSON.stringify({ stage_pass: true, reached_stage: "semantic-check", budget_scope: "stage-run", exit_code: EXIT_OK }),
    );
    expectNoAcceptanceMaterial(run.requests);
  });

  it("(6c) ids off の v1.2 の段の走り：回ごとの行を書かず、書いたファイルの一覧が直す前と同じ（Issue #699）", async () => {
    vi.spyOn(ledgerModule, "fromPublicV12Flags").mockImplementation(() => ({ ledger: true, searchRepair: true, ids: false }));
    const dir = `${directory}/v12-stage-ids-off`;
    const run = await runStageCli({
      dir,
      args: ["--stage-end", "semantic-check"],
      calls: [structured(v11aT1(true)), structured(v11aJudgments())],
      pipeline: "v1.2",
    });
    expect(run.code).toBe(EXIT_OK);
    expect(run.written).toEqual([stageCheckpointFile("t1-t2"), STAGE_RUN_RECORD_FILE]);
    expect(run.directories).not.toContain(`${dir}/diagnostics`);
    expectNoAcceptanceMaterial(run.requests);
  });

  it("(7) 同じ台本の段の走りと一気通貫で、table-rounds のファイルがバイト列で同じ。一気通貫の manifest は診断を載せない（Issue #699）", async () => {
    const stageDir = `${directory}/v12-stage-table-rounds-stage`;
    const wholeDir = `${directory}/v12-stage-table-rounds-whole`;
    await runStageCli({ dir: stageDir, args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"], calls: segment0(), pipeline: "v1.2" });
    await runV11aCli({
      dir: wholeDir,
      calls: [...segment0(), structured(v11aRenamed(v12TestSpec())), structured({ declaration: V11A_YAML }), structured(v11aJudgments())],
      pipeline: "v1.2",
    });
    const stageText = await fs.readFile(`${stageDir}/${DIAGNOSTICS_TABLE_ROUNDS_FILE}`, "utf8");
    const wholeText = await fs.readFile(`${wholeDir}/${DIAGNOSTICS_TABLE_ROUNDS_FILE}`, "utf8");
    // 同じ関数が組むので、ファイルのバイト列まで同じ
    expect(stageText).toBe(wholeText);
    const rounds = (JSON.parse(stageText) as { readonly rounds: readonly Record<string, unknown>[] }).rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round: 1, ok: "ok", rewrite: null, adopted: true });
    // 一気通貫の納品物の manifest は診断を載せない
    const manifest = JSON.parse(await fs.readFile(`${wholeDir}/${BUNDLE_MANIFEST_FILE}`, "utf8")) as {
      readonly files: readonly { readonly path: string }[];
    };
    expect(manifest.files.some((file) => file.path.startsWith("diagnostics/"))).toBe(false);
    expectNoAcceptanceMaterial([stageText]);
  });
});

/**
/**
 * 段の走り：C1 の束 2 が形で落ちてやり直しで通る走りの記録と t1-t2 の checkpoint の SHA-256（Issue #683）。Issue #713 で取り直した
 * （checkpoint の版に ledger_upstream を足し、記録の出力ダイジェストがそれに由来して変わったため。旧の値は下の
 * `V12_STAGE_C1_RETRY_DIGESTS_BEFORE_713` に残し、欄を除けば旧の値に戻ることを試験で確かめる）。
 * v12-h3e（#650 の T2 の手）に main d926547（#712・#713）を合流して取り直した（main の値は
 * 59d1e2cca45df344fe41a22ea214c8c7a445b2f7a8ad6b87fbfd8fbaa7ce6485・d6729878920d48a8e741d880c1763428771e46a0737ddd86af4d8272eaa60219。
 * 差は h3e の台帳の全体の指紋 `propertyLedgerSha256` だけで、部分の指紋 ledger_upstream は main と同じ）
 */
const V12_STAGE_C1_RETRY_DIGESTS: readonly string[] = [
  // Issue #725 で取り直した（上流の台帳の見方に未対応の観測を足して版を 2 に上げ、checkpoint の ledger_upstream と、それに由来する
  // 記録の出力ダイジェストが変わったため。旧の値は `V12_STAGE_C1_RETRY_DIGESTS_BEFORE_725` に残し、2 つの欄を旧の値に戻せば一致する
  // ことを試験で確かめる）
  // Issue #735 で取り直した（論理の枠 L-v12-01 を 72 → 80 にして checkpoint の版の call_limits・条件の記録の v12_call_limits の
  // logical_calls が変わり、記録の v12_calls に C3 の束の欄 semantic_check を足したため。旧の値は `V12_STAGE_C1_RETRY_DIGESTS_BEFORE_735`
  // に残し、`revert735` で欄を旧の値に戻せば一致することを試験で確かめる。旧 9e94a228cc565b2d77e210828065bfa74cc337bd6c05cab330e8bbdbd5b09a3d・
  // 8cad6abfb8cd5659407e25934411c26fb9ca537adae3e88a6b4a9cd327258a5a）
  "c22cffe09c359a3e98eee0885efd47c9c3d2ab2c6158a731442e27f62572fc9b",
  "3646122573cce8254ad727db2d194021b54e683dbf9f98166cbdd36faadbf92d",
];

/** Issue #735 の前の同じ走りの記録と t1-t2 の checkpoint の SHA-256（旧の値。#725 で取り直した値） */
const V12_STAGE_C1_RETRY_DIGESTS_BEFORE_735: readonly string[] = [
  "9e94a228cc565b2d77e210828065bfa74cc337bd6c05cab330e8bbdbd5b09a3d",
  "8cad6abfb8cd5659407e25934411c26fb9ca537adae3e88a6b4a9cd327258a5a",
];


/** Issue #725 の前の同じ走りの記録と t1-t2 の checkpoint の SHA-256（旧の値。base 354cc49 で測った値） */
const V12_STAGE_C1_RETRY_DIGESTS_BEFORE_725: readonly string[] = [
  "cdaf2ba05d4a63866abb54483e97cb6867e4a14ad7761d6e1c583a89b5472f2a",
  "da9ba01f59695d1ec5e5a5fca6816932c507717a4956ba176dc6dfcea3dd4321",
];

/**
 * Issue #725 の前（上流の台帳の見方の版 1。Issue #712）の部分の指紋。base 354cc49 の作業木で v1.2 の走りの t1-t2 の checkpoint の
 * ledger_upstream を測った値（新しいコードの出力から作っていない）
 */
const V12_UPSTREAM_BEFORE_725 = "f34e414b103df9a32f8ace0a248d6cc083c3c3a9e7b147e03739c17286c407ae";

/**
 * Issue #713 の前の同じ走りの記録と t1-t2 の checkpoint の SHA-256（旧の値。Issue #683）。v12-h3e の値：手 3d・3h が性質の台帳
 * （view-structure・existence の行）を変え、checkpoint の版の台帳の指紋（main 411b79c3… → fd0adc6d…）と、それを含む checkpoint の
 * 出力ダイジェストを載せた記録が変わるため。fa21c65（main）の値は 70fa16375b25456ffd357636934df2e702a1e1cd1ec472ad26724414a71acfc0・
 * 985a79f34387d6a673ea80594421610a3552c05d35ebef2436abbd57bc14d9ee（v12-h3e の checkpoint の指紋を main の値に置き換えると一致し、
 * 記録の差は checkpoint の output_digest の 1 欄だけであることを確かめた）
 */
const V12_STAGE_C1_RETRY_DIGESTS_BEFORE_713: readonly string[] = [
  "61b797c2965f0a53c7f9085301cd5f536bc7725470d177fd43103575fbe0d5f4",
  "8f0dc33c3bd0682ecfa8f6ef064608099b46acb627cff61977ca6b1d93af7018",
];

/**
 * 段の走り：C2 が 2 回落ちて止まる走りの記録の SHA-256（Issue #683）。Issue #735 で取り直した（論理の枠 L-v12-01 を 72 → 80 にして
 * 条件の記録の v12_call_limits の logical_calls が変わったため。C3 に届かないので v12_calls は変わらない。旧の値は
 * `V12_STAGE_C2_STOP_DIGESTS_BEFORE_735` に残し、`revert735` で戻せば一致することを試験で確かめる）
 */
const V12_STAGE_C2_STOP_DIGESTS: readonly string[] = ["4edd73d295d2105783e7da7cbe36ff0a3aa6c13c32e3b1436ca3ae79caf1ed91"];

/** fa21c65（直す前）の段の走り：C2 が 2 回落ちて止まる走りの記録の SHA-256（Issue #683。Issue #735 の前の値） */
const V12_STAGE_C2_STOP_DIGESTS_BEFORE_735: readonly string[] = ["00443168d1b3bc21efa0d78604fe89bcea391c54e545a67db4e1d68f61eb7367"];

/** fa21c65（直す前）の v1.1a の段の走り：T1 が形で 1 度落ちてやり直しで通る走りの記録と t1-t2 の checkpoint の SHA-256（Issue #683） */
const V11A_STAGE_T1_RETRY_DIGESTS: readonly string[] = [
  "08aad2c4e1a7d947379fab165e80a5f6d40fac50b4c9f7e9d78a1e45ea9214be",
  "50dde03644297779f6259db18fe73422c80f2aaa48439be189ea472bfb93ec33",
];

/** v1.1a の段の走り（T1〜⑦）の記録・t1-t2・t2-b1 の checkpoint の SHA-256（直す前 bf68da8（#636 を載せ直した main）のコードで測った値。Issue #637） */
const V11A_STAGE_RUN_DIGESTS: readonly string[] = [
  "b3c10421fc24524bc0aa9ff8fa3655faf100ce6aa87a233be03a4ea6bb2fd141",
  "50dde03644297779f6259db18fe73422c80f2aaa48439be189ea472bfb93ec33",
  "0d3d1378e80402c9f7e6625191e1e9b4821b1a75a4872b62716bbc0e125eecb2",
];

describe("旗 v12.ids の C3 の構造の検査の読み方（Issue #732）：一気通貫と段の走りの C3 の要求が同じ文を持ち、ids off の走りには無い", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rsc02Of = (requests: readonly LlmStructuredRequest[]): readonly string[] =>
    requests.filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME).map((request) => request.rules?.[1] ?? "");

  it("(4) 一気通貫（旗 ids on）と段の走り（name-table..semantic-check・ids on）の C3 の R-sc-02 は同じで読み方の文を含む。ids off の一気通貫・段の走りには無い", async () => {
    const whole = await runV11aCli({ dir: `${directory}/v12-ids-reading-whole`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    const stage = await runStageCli({ dir: `${directory}/v12-ids-reading-stage`, args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"], calls: v12Head().slice(0, 5), pipeline: "v1.2" });
    expect(whole.code).toBe(EXIT_OK);
    expect(stage.code).toBe(EXIT_OK);
    const wholeRules = rsc02Of(whole.recording.structured);
    const stageRules = rsc02Of(stage.requests.map((text) => JSON.parse(text) as LlmStructuredRequest));
    expect(wholeRules).toHaveLength(1);
    expect(stageRules).toEqual(wholeRules);
    expect(wholeRules[0]).toContain(structuralReadingText());
    expect(wholeRules[0]).toBe(ruleTexts(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW, true))[1]);
    // ids off（台帳と探索は on）の走りは読み方の文を持たない
    const flags = { ledger: true, searchRepair: true, ids: false };
    vi.spyOn(ledgerModule, "fromPublicV12Flags").mockImplementation(() => flags);
    const wholeOff = await runV11aCli({
      dir: `${directory}/v12-ids-reading-whole-off`,
      calls: [structured(v11aT1(true)), structured(v11aJudgments()), structured(v11aTestSpec()), structured({ declaration: V11A_YAML }), structured(v11aJudgments())],
      pipeline: "v1.2",
    });
    const stageOff = await runStageCli({ dir: `${directory}/v12-ids-reading-stage-off`, args: ["--stage-end", "semantic-check"], calls: [structured(v11aT1(true)), structured(v11aJudgments())], pipeline: "v1.2" });
    const offRules = [...rsc02Of(wholeOff.recording.structured), ...rsc02Of(stageOff.requests.map((text) => JSON.parse(text) as LlmStructuredRequest))];
    expect(offRules).toHaveLength(2);
    for (const rule of offRules) {
      expect(rule).not.toContain(structuralReadingText());
      expect(rule).toBe(ruleTexts(semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW))[1]);
    }
  });
});

describe("部分の指紋の版 2（台帳の未対応の観測を上流の見方に足した。Issue #725）：記録と checkpoint の差は申告した 3 つの欄だけ", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Flags = { readonly ledger: boolean; readonly searchRepair: boolean; readonly ids: boolean };
  /** 走りの組（段の走り・一気通貫 × 旗の組） */
  const SCENARIOS: readonly { readonly name: string; readonly kind: "stage" | "whole"; readonly flags: Flags | null }[] = [
    { name: "段の走り・ids と ledger が on", kind: "stage", flags: null },
    { name: "段の走り・ids on・ledger off", kind: "stage", flags: { ledger: false, searchRepair: true, ids: true } },
    { name: "段の走り・ids off", kind: "stage", flags: { ledger: true, searchRepair: true, ids: false } },
    { name: "一気通貫・ids と ledger が on", kind: "whole", flags: null },
    { name: "一気通貫・ids on・ledger off", kind: "whole", flags: { ledger: false, searchRepair: true, ids: true } },
    { name: "一気通貫・ids off", kind: "whole", flags: { ledger: true, searchRepair: true, ids: false } },
  ];

  /** 1 つの組を流し、書いたファイルの SHA-256・checkpoint の部分の指紋・要求・要約・終了コードを返す */
  async function measure(scenario: (typeof SCENARIOS)[number], index: number) {
    if (scenario.flags !== null) {
      const flags = scenario.flags;
      vi.spyOn(ledgerModule, "fromPublicV12Flags").mockImplementation(() => flags);
    }
    const dir = `${directory}/v12-upstream-v2-${String(index)}`;
    const idsOff = scenario.flags?.ids === false;
    // Issue #732：ids on の C3 の要求は R-sc-02 に構造の検査の読み方の文を持ち、ids off は持たない。在る・無いを確かめてから外して照らす
    // （外した要求は #732 の前の要求とバイト列で同じ＝下の BEFORE の requests のまま）
    let semanticRequests = 0;
    const withoutC3Reading = (request: LlmStructuredRequest): LlmStructuredRequest => {
      if (request.schemaName !== SEMANTIC_CHECK_SCHEMA_NAME) return request;
      semanticRequests += 1;
      const rules = request.rules ?? [];
      expect(rules.some((text) => text.includes(structuralReadingText())), scenario.name).toBe(!idsOff);
      return { ...request, rules: rules.map((text) => text.replace(structuralReadingText(), "")) };
    };
    // ledger off の C1 の schema は計算の行に集計の欄を持たない（応答も持たせない）
    const head = scenario.flags?.ledger === false ? v12Head({ ...ledgerModule.PROPERTY_LEDGER_VIEW, aggregateKinds: [] }) : v12Head();
    let requests: unknown;
    let summary: string;
    let code: number;
    let written: readonly string[];
    if (scenario.kind === "stage") {
      const run = idsOff
        ? await runStageCli({ dir, args: ["--stage-end", "semantic-check"], calls: [structured(v11aT1(true)), structured(v11aJudgments())], pipeline: "v1.2" })
        : await runStageCli({ dir, args: ["--stage-start", "vocabulary", "--stage-end", "semantic-check"], calls: head.slice(0, 5), pipeline: "v1.2" });
      requests = run.requests.map((text) => JSON.stringify(withoutC3Reading(JSON.parse(text) as LlmStructuredRequest)));
      summary = run.lines.at(-1) ?? "";
      code = run.code;
      written = run.written;
    } else {
      const calls = idsOff
        ? [structured(v11aT1(true)), structured(v11aJudgments()), structured(v11aTestSpec()), structured({ declaration: V11A_YAML }), structured(v11aJudgments())]
        : [...head, structured(v11aJudgments())];
      const run = await runV11aCli({ dir, calls, pipeline: "v1.2" });
      requests = { structured: run.recording.structured.map(withoutC3Reading), tools: run.recording.tools };
      // Issue #735：要約の v12_calls の C3 の束の欄を外して照らす（ids on の走りだけが持つ。外した要約は #735 の前と同じ）
      const revertedSummary = structuredClone(run.summary) as Record<string, any>;
      expect(revertedSummary["v12_calls"]?.["semantic_check"] !== undefined, scenario.name).toBe(!idsOff);
      revert735(revertedSummary);
      summary = JSON.stringify(revertedSummary);
      code = run.code;
      written = run.written;
    }
    expect(semanticRequests, scenario.name).toBeGreaterThan(0);
    // manifest の storage_unit は出力の場所（試験ごとの一時の場所）なので、目印に置き換えて照らす
    const textOf = async (path: string): Promise<string> => {
      const text = await fs.readFile(`${dir}/${path}`, "utf8");
      return path === BUNDLE_MANIFEST_FILE ? text.replaceAll(JSON.stringify(dir), JSON.stringify("<out>")) : text;
    };
    const files: Record<string, string> = {};
    for (const path of [...written].sort()) files[path] = await sha256Hex(await textOf(path));
    const upstream: Record<string, unknown> = {};
    for (const path of written.filter((name) => name.startsWith("stage-checkpoint-"))) {
      upstream[path] = (JSON.parse(await fs.readFile(`${dir}/${path}`, "utf8")) as Record<string, any>)["versions"]["ledger_upstream"];
    }
    return {
      textOf,
      written,
      files,
      upstream,
      requests: await sha256Hex(JSON.stringify(requests)),
      summary: await sha256Hex(summary),
      code,
    };
  }

  /**
   * 直す前の値：base 354cc49（統合 v12-table。直す前の ledger.ts・names.ts・mapping.ts）に戻した作業木で、上の組を流して測った
   * SHA-256（書いたファイル〔manifest は storage_unit を目印に置き換えた本文〕・要求・要約の 1 行）と終了コード。新しいコードの出力
   * から作っていない。手で直さない（Issue #725）
   */
  const BEFORE: Readonly<Record<string, { readonly files: Readonly<Record<string, string>>; readonly requests: string; readonly summary: string; readonly code: number }>> = {
  "段の走り・ids と ledger が on": {
    files: {
      "diagnostics/table-rounds.json": "5be58b3cbaa9905f37fbbd9ce6fb5fd09f2db2e90ca8c4916eee3c179ebdd518",
      "stage-checkpoint-t1-t2.json": "da9ba01f59695d1ec5e5a5fca6816932c507717a4956ba176dc6dfcea3dd4321",
      "stage-run.json": "f96539e19275f83b51fc3108ccd051adf7bb781f47a6e186136c10358d9da36a",
    },
    requests: "dcfb2f82e1b00e16b8e8529b894762cb86fab11a4870d9e907b64a80949cf6bb",
    summary: "855a9d8d55150b082f06b89eccdd1e98dfa15b3a1c8f667e57354d3ca824e337",
    code: 0,
  },
  "段の走り・ids on・ledger off": {
    files: {
      "diagnostics/table-rounds.json": "654a783d66b53a393a47cafc1c6951c211383047056307857470c5716845ebc5",
      "stage-checkpoint-t1-t2.json": "27bcaadf71cdd59e9596514a9682bd972fd2deaa88ebdfce2279a757f03f8835",
      "stage-run.json": "6152f38be6a8ad6536373e084a1420ac8ce4d7526c0c6cc516a2b38832d35c65",
    },
    requests: "85c86dec759762a1fafab6166d88bbf51380638e7830a11fd8e2c5eb51bc8200",
    summary: "855a9d8d55150b082f06b89eccdd1e98dfa15b3a1c8f667e57354d3ca824e337",
    code: 0,
  },
  "段の走り・ids off": {
    files: {
      "stage-checkpoint-t1-t2.json": "b15ed78e1cd2deadd55780ce6ebef714272eecda23795c4e6a216ad714b122aa",
      "stage-run.json": "0f852e681763b54501bbbcb2b2f5914828cd9729f71a2d49050e87a07a4d273e",
    },
    requests: "26408ef9c0c70129c2144df8e8f839ed5252146be6ffcb5dea789bb6d7c8fdbb",
    summary: "855a9d8d55150b082f06b89eccdd1e98dfa15b3a1c8f667e57354d3ca824e337",
    code: 0,
  },
  "一気通貫・ids と ledger が on": {
    files: {
      "artifacts/app.spec.yaml": "c8fe455d81ff59f824563aceac4a41485197df08f46ff71af0ed9c496e75e363",
      "artifacts/arbitration.json": "934d0f70c5f8e7a2638e4f8ecd685291435ab62ccdde0da19d67ad402cf85a87",
      "artifacts/carry-over.json": "2d84a832ac76be55cfecc0faab4171394316b7086faecf00d7bec4a02fe1a0b5",
      "artifacts/correspondence.json": "0ec4b2bcae430811cbb114484336754ef7326b24543cbaf2103b2eea6c304c64",
      "artifacts/decl-check.json": "325e7cbdbbccee120e12ed6712bbdc7c93e25075194057bf173000bda6280546",
      "artifacts/design.json": "2e2e34a42d3e2318ec8ced24e989abed2ddea7188a1c34c66de9aa11b7a7774e",
      "artifacts/disputes.json": "8b6d71437a82a109d91942fe1e7a41a4c5287e7c0047f8b8dbbc1ad2160c547b",
      "artifacts/judge-advice.json": "980d2de899d653f3a10d2a2e044ba04268ab2f98cec69a28f0710754b6dcaa48",
      "artifacts/mappings.json": "57828b8f85a64f27f33908279deca1d151236df37322d1e32210f3e85c4c0aa0",
      "artifacts/name-table.json": "cf9676e8ed6f03b302816f5272a0d355df23c47e7d76ec99ea65a801aadb6f24",
      "artifacts/plan.json": "0ff2c269077514ddcd1dfd577552f0943b0848bda08524d71ed87870870309a2",
      "artifacts/requirements.json": "057b4c7e48db2131aaf4e62c418f77959828e937444bb9f6f35d80fe064327aa",
      "artifacts/search-repair.json": "aea2f8087861abeefc0269e976a466a9eb0feba25150525309f70d7cf0e3b38b",
      "artifacts/semantic-check.json": "7368b8db9144f328e89ae5ead95d856ad7d447c096384f0bcbcc1f1600d1a817",
      "artifacts/summary.json": "f63c2335030394c2e111840e5ed73f0721f692ed18c0b6c141aa829e86911955",
      "artifacts/test-spec.json": "fa52e701462e0ee5ee4f63488c3270a393865e7c78942f1501b7913429d0c6b1",
      "artifacts/test-suite.json": "118e057660c7142fcb95cc949b737ac29c70b75292a5fcd4c467a1f9b659735b",
      "artifacts/tests.json": "6a5d046101c09dcd4b7ffa9befa087ed1fe288656da2dc711c04cd00bd0ee679",
      "artifacts/unwritable.json": "7aa99d40265914de1263e06b9057bcfae145c301dcbee43ced959daae51cec93",
      "artifacts/verification-v11a.json": "433245dc099e6828d0b115141678e6e768c895524cce8172cab65acebfe411b3",
      "artifacts/verification.json": "23bb5181d89dfbf88f7681c357513c00744a41165eae273f427ca63070cafc39",
      "build-record.json": "ba72cd89a0989cc12ab676a73c1e37fe37d202476b7263a2c3e11d929523496a",
      "bundle-manifest.json": "ff37ebd9abce36a63412317351a81b09a1364db0cbaea7c51df9c9126b16baa9",
      "diagnostics/table-rounds.json": "5be58b3cbaa9905f37fbbd9ce6fb5fd09f2db2e90ca8c4916eee3c179ebdd518",
      "stage-checkpoint-t1-t2.json": "da9ba01f59695d1ec5e5a5fca6816932c507717a4956ba176dc6dfcea3dd4321",
      "stage-checkpoint-t2-b1.json": "770b203007c2ae91ee674bea0977d45e1693f6e0fde6c0cd934135faf89d76f9",
    },
    requests: "6b8bd7582dd0930257c228cb5566f014b721d36969b20d712bc9c40aef020e59",
    summary: "34995be74f75cfd12ba85667a0e1f4a5b9327367f2d2b9baeb97339ccc0a6e1b",
    code: 0,
  },
  "一気通貫・ids on・ledger off": {
    files: {
      "build-record.json": "557d87dcf3d8a5a63436ebf26a1dbe9150cca73a256109ae365e36adb319251e",
      "diagnostics/design.json": "ad9f70aebead04f7c61c2fe720891bcb4468e8677e4aa0ff325487bf5463db7c",
      "diagnostics/mappings.json": "6cd1f81d45fc5a8dcdf2c13f680b78c889871e66537d9b2913efb9ac8ee118ea",
      "diagnostics/materials.json": "e14f2b929c57a3669dd69c1865a627dfeac6128488131b0a4b28c9a5c5f00825",
      "diagnostics/table-rounds.json": "744fe6f44ae3a93b19f560b1626a324087aed155f9d90fe95d96c8115314f43b",
      "stage-checkpoint-t1-t2.json": "27bcaadf71cdd59e9596514a9682bd972fd2deaa88ebdfce2279a757f03f8835",
    },
    requests: "3af251ea9baa55848c88e8aa0e9c6a3f35a8e6a4c11e653718695f0e0ec85599",
    summary: "390f3d092dbcd7d93c1269d02bce5c61cefa658add774d2c2017081f4fa22e11",
    code: 1,
  },
  "一気通貫・ids off": {
    files: {
      "artifacts/app.spec.yaml": "c8fe455d81ff59f824563aceac4a41485197df08f46ff71af0ed9c496e75e363",
      "artifacts/arbitration.json": "934d0f70c5f8e7a2638e4f8ecd685291435ab62ccdde0da19d67ad402cf85a87",
      "artifacts/carry-over.json": "2d84a832ac76be55cfecc0faab4171394316b7086faecf00d7bec4a02fe1a0b5",
      "artifacts/correspondence.json": "0ec4b2bcae430811cbb114484336754ef7326b24543cbaf2103b2eea6c304c64",
      "artifacts/decl-check.json": "8f8b72d9f0265e5ca711f47b68c68d006bfe17152bbf9cc52fdc2bb9caa700ad",
      "artifacts/design.json": "57f7797b692e43add66c76e11f0a9a9fcbd9afcdef0e061e37e7868da8c755a4",
      "artifacts/disputes.json": "8b6d71437a82a109d91942fe1e7a41a4c5287e7c0047f8b8dbbc1ad2160c547b",
      "artifacts/judge-advice.json": "55639da2fb4cd75c81ef1338c63914a25e95ecb18c7bd5d2ebfd84dee4462d5e",
      "artifacts/mappings.json": "bd21c6d5f38a2add0ad01158cf7b082738098b42f86b6177b019e1739e4473c6",
      "artifacts/name-table.json": "1ba6b4f1d1587b3d451d4f34b27bd6f9b50023066e4f4098125868e3c2aac72e",
      "artifacts/plan.json": "0ff2c269077514ddcd1dfd577552f0943b0848bda08524d71ed87870870309a2",
      "artifacts/requirements.json": "057b4c7e48db2131aaf4e62c418f77959828e937444bb9f6f35d80fe064327aa",
      "artifacts/search-repair.json": "aea2f8087861abeefc0269e976a466a9eb0feba25150525309f70d7cf0e3b38b",
      "artifacts/semantic-check.json": "be4be78531638df843580ee880402d7291491763d6834e55ffdd34416423b1e6",
      "artifacts/summary.json": "6da50333cd726bde435dc23b0f556af6830621386361843fd50177641f7dac08",
      "artifacts/test-spec.json": "af638f5122e4b138c2b504caa78c21ab488cf45a727d9ba60082ba60e574e74a",
      "artifacts/test-suite.json": "aa0170b1fe98ea51df5590dd55a3b6418332ac9e0791f627523151d26dcc85f6",
      "artifacts/tests.json": "a41395cf78e146834e2c993d3c1da287e7c4de4e5869fb849c050b4ba5869a32",
      "artifacts/unwritable.json": "7aa99d40265914de1263e06b9057bcfae145c301dcbee43ced959daae51cec93",
      "artifacts/verification-v11a.json": "2cb132cc2ca9cda1454e42daccb40b487055cd3e59556160604d6b965e887a03",
      "artifacts/verification.json": "891ca9236cd68375c8d338f73ae0848579b46885f936f20664bdfc1e4e442a3e",
      "build-record.json": "e911360846430b8bc1d35ebd0005c71ee7b4544e858d4b5239058ed8dddbd677",
      "bundle-manifest.json": "ce64a497c63eb990491eb33fd44b78c6a340634875529fde18c0cda3fadd7c42",
    },
    requests: "d6c3a18b7e19b6e4f4bd97343a6b7979240381a186f7811ae2439e4db7be0b72",
    summary: "3224ccf3065f5c506cbd52fbe75fbcc3400f3603b7f71e11d0de71130c1a1da3",
    code: 0,
  },
  };
  const BEFORE_UPSTREAM = V12_UPSTREAM_BEFORE_725;
  /** 要求が変わってよい組（旗 ids と ledger が on の C2 のデータと規則だけ。差が C2 の要求だけであることは run.test.ts が照らす） */
  const REQUESTS_CHANGED = new Set(["段の走り・ids と ledger が on", "一気通貫・ids と ledger が on"]);
  /**
   * 変わってよいファイル（申告した 3 つの欄を持つもの：t1-t2 の checkpoint と、それを宣言する記録）。Issue #735 で、版の call_limits の
   * 論理の枠を持つ t2-b1 の checkpoint、要約の v12_calls の C3 の束の欄を持つ納品物の要約と、その SHA-256 を載せる manifest を足した
   * （`revert735`・`revertBundleFiles735` で戻して照らす）
   */
  const MAY_CHANGE = new Set([
    stageCheckpointFile("t1-t2"),
    STAGE_RUN_RECORD_FILE,
    BUILD_CLI_RECORD_FILE,
    stageCheckpointFile("t2-b1"),
    "artifacts/summary.json",
    BUNDLE_MANIFEST_FILE,
  ]);

  it("段の走りと一気通貫の Build の記録の両方で、ids と ledger の on・off に依らず、t1-t2 の ledger_upstream と記録の output_digest だけを旧の値に戻すと直す前とバイト列で同じ。要約・終了コード・納品物・ほかの診断は不変、要求は ids と ledger が on の走りだけ変わる", async () => {
    const current = await ledgerModule.upstreamLedgerSha256();
    expect(current).not.toBe(BEFORE_UPSTREAM);
    expect(Object.keys(BEFORE)).toEqual(SCENARIOS.map((scenario) => scenario.name));
    for (const [index, scenario] of SCENARIOS.entries()) {
      const run = await measure(scenario, index);
      const before = BEFORE[scenario.name]!;
      expect(run.code, scenario.name).toBe(before.code);
      expect(run.summary, scenario.name).toBe(before.summary);
      expect(Object.keys(run.files), scenario.name).toEqual(Object.keys(before.files));
      if (REQUESTS_CHANGED.has(scenario.name)) expect(run.requests, scenario.name).not.toBe(before.requests);
      else expect(run.requests, scenario.name).toBe(before.requests);
      // 変わったファイルは申告した欄を持つものだけ
      for (const [path, digest] of Object.entries(run.files)) {
        if (digest !== before.files[path]) expect(MAY_CHANGE.has(path), `${scenario.name}: ${path}`).toBe(true);
      }
      // checkpoint の ledger_upstream は今の部分の指紋（t1-t2）か null（t2-b1）。旧の値に戻して出力ダイジェストを計算し直す
      const reverted: Record<string, string> = {};
      const digestOf = new Map<string, string>();
      for (const path of run.written.filter((name) => name.startsWith("stage-checkpoint-"))) {
        const text = await run.textOf(path);
        const checkpoint = JSON.parse(text) as Record<string, any>;
        expect(stageJsonText(checkpoint), path).toBe(text);
        expect(run.upstream[path], path).toBe(path === stageCheckpointFile("t1-t2") ? current : null);
        if (checkpoint["versions"]["ledger_upstream"] !== null) checkpoint["versions"]["ledger_upstream"] = BEFORE_UPSTREAM;
        // Issue #735 で変わった論理の枠の値も旧の値に戻す（#725 の前の値と照らすため）
        revert735(checkpoint);
        digestOf.set(path, await stageOutputDigest(checkpoint));
        reverted[path] = await sha256Hex(stageJsonText(checkpoint));
      }
      // Issue #735：納品物の要約の C3 の束の欄を外し、manifest のその SHA-256 を計算し直す（ほかのファイルはそのまま）
      const bundleTexts = new Map(
        (await revertBundleFiles735(await Promise.all(run.written.map(async (path) => ({ path, text: await run.textOf(path) }))))).map((file) => [file.path, file.text] as const),
      );
      for (const path of run.written.filter((name) => !name.startsWith("stage-checkpoint-"))) {
        const text = await run.textOf(path);
        if (path !== STAGE_RUN_RECORD_FILE && path !== BUILD_CLI_RECORD_FILE) {
          reverted[path] = await sha256Hex(bundleTexts.get(path) ?? text);
          continue;
        }
        const record = JSON.parse(text) as Record<string, any>;
        // 段の走りの記録は字下げつき（stageJsonText）、Build だけの記録は 1 行の JSON。書いた形のまま書き戻す（往復で同じことを確かめる）
        const serialize = (value: unknown): string =>
          path === STAGE_RUN_RECORD_FILE ? stageJsonText(value) : `${JSON.stringify(value)}${text.endsWith("\n") ? "\n" : ""}`;
        expect(serialize(record), path).toBe(text);
        // Issue #735 で変わった論理の枠の値と C3 の束の欄も旧の値に戻す（#725 の前の値と照らすため）
        revert735(record);
        for (const entry of (record["checkpoints"] ?? []) as { path: string; output_digest: string }[]) {
          expect(entry.output_digest, path).toBe(await stageOutputDigest(JSON.parse(await run.textOf(entry.path))));
          entry.output_digest = digestOf.get(entry.path) ?? "";
        }
        reverted[path] = await sha256Hex(serialize(record));
      }
      expect(reverted, scenario.name).toEqual(before.files);
      vi.restoreAllMocks();
    }
  });
});

describe("v1.2 の段の走りが ⑦ まで流したとき、判定した宣言を書いて記録で宣言する（工程ごとの評価 U3 の口。Issue #687）", () => {
  const readJson = async (path: string): Promise<Record<string, any>> => JSON.parse(await fs.readFile(path, "utf8")) as Record<string, any>;
  /** v1.2 の一気通貫の走り（境界の checkpoint と納品物を書く）。同じ台本の段の走りの入力と比較元 */
  async function wholeRun(name: string) {
    const calls = [...v12Head(), structured(v11aJudgments())];
    const whole = `${directory}/${name}`;
    await runV11aCli({ dir: whole, calls, pipeline: "v1.2" });
    return { calls, whole };
  }

  it("範囲 write..judge の完走：宣言のファイルが判定した宣言とバイト列で同じで、記録の SHA-256 と一致し、検証の数が一気通貫の検証の記録と同じ。manifest・納品物を書かない", async () => {
    const { calls, whole } = await wholeRun("u3-whole-a");
    const dir = `${directory}/u3-write-judge`;
    const run = await runStageCli({ dir, args: ["--stage-start", "write", "--stage-input", `${whole}/${stageCheckpointFile("t2-b1")}`], calls: calls.slice(6), pipeline: "v1.2" });
    expect(run.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.written).toEqual([STAGE_DECLARATION_FILE, STAGE_RUN_RECORD_FILE]);
    const text = await fs.readFile(`${dir}/${STAGE_DECLARATION_FILE}`, "utf8");
    expect(text).toBe(V11A_YAML);
    // 一気通貫の納品物の宣言とバイト列で同じ
    expect(text).toBe(await fs.readFile(`${whole}/artifacts/app.spec.yaml`, "utf8"));
    const record = await stageRecordOf(dir);
    expect(record["stage_judge_verdict"]).toBe("full");
    expect(record["declaration"]).toEqual({ file: STAGE_DECLARATION_FILE, sha256: await sha256Hex(text), static_check_passed: true });
    // 既存の欄の並びは今のまま（v1.2 の欄の末尾に宣言と検証の数を足す。その後ろに探索の出来事の列。Issue #746 で末尾に 1 つ足した）
    expect(Object.keys(record).slice(-4)).toEqual(["v12_calls", "declaration", "verification", "search_repair"]);
    const verification = record["verification"] as Record<string, unknown>;
    const v11a = await readJson(`${whole}/${V11A_ARTIFACT_NAMES.verification}`);
    expect(verification).toEqual({
      table_sha256: v11a["table_sha256"],
      test_suite_sha256: v11a["test_suite_sha256"],
      declaration_sha256: v11a["declaration_sha256"],
      checked_declaration_sha256s: v11a["checked_declaration_sha256s"],
      decl_check: v11a["decl_check"],
      b3_misses: 0,
      c7_mismatches: 0,
      unresolved: 0,
      not_run: null,
      stop_reason: "completed",
      round_trips: 0,
    });
    expect(verification["declaration_sha256"]).toBe(await sha256Hex(text));
    // 納品物を書かない（manifest・artifacts の下・Build だけの記録が無い）
    await expect(fs.readFile(`${dir}/${BUNDLE_MANIFEST_FILE}`, "utf8")).rejects.toThrow();
    await expect(fs.readFile(`${dir}/artifacts/app.spec.yaml`, "utf8")).rejects.toThrow();
    expect(run.written.some((path) => path.startsWith("artifacts/"))).toBe(false);
    // 1 行の要約は直す前と同じ形
    expect(run.lines.at(-1)).toBe(JSON.stringify({ stage_pass: true, reached_stage: "judge", budget_scope: "stage-run", exit_code: EXIT_OK }));
    // 一気通貫の manifest は段の走りの宣言のファイルの名前を載せない
    expect(await fs.readFile(`${whole}/${BUNDLE_MANIFEST_FILE}`, "utf8")).not.toContain(STAGE_DECLARATION_FILE);
  });

  it("範囲 test-spec..judge でも同じ：宣言のファイルのバイト列と記録の宣言・検証の数が write..judge の走りと同じ", async () => {
    const { calls, whole } = await wholeRun("u3-whole-b");
    const fromB1 = `${directory}/u3-b-write`;
    await runStageCli({ dir: fromB1, args: ["--stage-start", "write", "--stage-input", `${whole}/${stageCheckpointFile("t2-b1")}`], calls: calls.slice(6), pipeline: "v1.2" });
    const fromT2 = `${directory}/u3-b-test-spec`;
    const run = await runStageCli({ dir: fromT2, args: ["--stage-start", "test-spec", "--stage-input", `${whole}/${stageCheckpointFile("t1-t2")}`], calls: calls.slice(5), pipeline: "v1.2" });
    expect(run.code).toBe(EXIT_OK);
    expect(run.written).toEqual([stageCheckpointFile("t2-b1"), STAGE_DECLARATION_FILE, STAGE_RUN_RECORD_FILE]);
    expect(await fs.readFile(`${fromT2}/${STAGE_DECLARATION_FILE}`, "utf8")).toBe(await fs.readFile(`${fromB1}/${STAGE_DECLARATION_FILE}`, "utf8"));
    const [a, b] = [await stageRecordOf(fromB1), await stageRecordOf(fromT2)];
    expect(b["declaration"]).toEqual(a["declaration"]);
    expect(b["verification"]).toEqual(a["verification"]);
  });

  it("⑦ に届かない走り（C2 で止めた走り・終了 T2'）と v1.1a の段の走りは、宣言のファイルを書かず記録に欄が無い", async () => {
    const c2 = `${directory}/u3-c2-stop`;
    const stopped = await runStageCli({ dir: c2, args: ["--stage-start", "vocabulary", "--stage-end", "judge"], calls: [...v12TableCalls().slice(0, 3), structured({ requirements: [] }), structured({ requirements: [] })], pipeline: "v1.2" });
    expect(stopped.code).toBe(EXIT_RUN_FAILED);
    const t2 = `${directory}/u3-t2-end`;
    await runStageCli({ dir: t2, args: ["--stage-end", "test-spec"], calls: v12Head().slice(0, 6), pipeline: "v1.2" });
    const v11a = `${directory}/u3-v11a`;
    const plain = await runStageCli({ dir: v11a, args: ["--stage-end", "judge"], calls: [...v11aHead(), structured(v11aJudgments())] });
    expect(plain.code).toBe(EXIT_OK);
    for (const [dir, written] of [[c2, stopped.written], [v11a, plain.written]] as const) {
      expect(written).not.toContain(STAGE_DECLARATION_FILE);
      await expect(fs.readFile(`${dir}/${STAGE_DECLARATION_FILE}`, "utf8")).rejects.toThrow();
    }
    for (const dir of [c2, t2, v11a]) {
      const record = await stageRecordOf(dir);
      expect(record).not.toHaveProperty("declaration");
      expect(record).not.toHaveProperty("verification");
    }
  });

  /** 要件の文をそのまま根拠に写した B3' の拒否（ids の要件ごと） */
  const rejecting = (ids: readonly string[]) =>
    structured(v11aJudgments(Object.fromEntries(ids.map((id) => [id, ["mismatch", V11A_BASE_LIST.requirements.find((requirement) => requirement.id === id)?.text ?? ""] as const]))));
  /** C7 で r4 の 3 本（normal・abnormal・boundary。どれも同じ参照データで率 6 を期待する）が不一致になる宣言（率の式を変える） */
  const V11A_YAML_R4_BAD = V11A_YAML.replace("expression: base * 2", "expression: base * 3");
  /**
   * 探索の直しの経路（v1.2 の旗の組。B1 から先の台本）。`unresolved` ＝ 記録の verification.unresolved の期待値を台本から手で決めた値
   * （裁定の未解決 ∪ 最終版の C7 の未解決 ∪ 停滞で足した試験 ＋ 停滞のときの最終版の B3 の落ち）
   */
  const SEARCH_STOPS = [
    {
      name: "(a) 停滞",
      // 同じ拒否の版が 2 つ続けて採れず B1 を作り直し、作り直しのあとも 2 つ採れずに止める
      calls: (): RecordedCall[] => [
        structured({ declaration: V11A_YAML }), structured(v11aJudgments(V11A_REJECT_R3)),
        v11aRepairDone(), structured(v11aJudgments(V11A_REJECT_R3)),
        v11aRepairDone(), structured(v11aJudgments(V11A_REJECT_R3)),
        structured({ declaration: V11A_YAML }), structured(v11aJudgments(V11A_REJECT_R3)),
        v11aRepairDone(), structured(v11aJudgments(V11A_REJECT_R3)),
      ],
      stopReason: "stagnation",
      roundTrips: 3,
      code: EXIT_OK,
      // 裁定 0（主張なし）＋ 最終版（一番良い版＝最初の版。どの候補も同数で採らない）の C7 の未解決 0 ＋ 停滞で足す試験 0（最終版の C7 の
      // 不一致の行き先が 0 件）＋ B3 の落ち 0 ＝ 0
      c7: 0,
      unresolved: 0,
    },
    {
      name: "(a') 停滞（C7 の不一致が残る版）",
      // (a) と同じ形で、どの版も r4 の 3 本が C7 で不一致のまま、同じ拒否 R3 で採れずに止める（R3 の拒否は欄だけの直しに写せないので道具の直し）
      calls: (): RecordedCall[] => [
        structured({ declaration: V11A_YAML_R4_BAD }), structured(v11aJudgments(V11A_REJECT_R3)),
        { kind: "tools", response: { kind: "done", declaration: { declaration: V11A_YAML_R4_BAD, disputes: [] }, usage: undefined } },
        structured(v11aJudgments(V11A_REJECT_R3)),
        { kind: "tools", response: { kind: "done", declaration: { declaration: V11A_YAML_R4_BAD, disputes: [] }, usage: undefined } },
        structured(v11aJudgments(V11A_REJECT_R3)),
        structured({ declaration: V11A_YAML_R4_BAD }), structured(v11aJudgments(V11A_REJECT_R3)),
        { kind: "tools", response: { kind: "done", declaration: { declaration: V11A_YAML_R4_BAD, disputes: [] }, usage: undefined } },
        structured(v11aJudgments(V11A_REJECT_R3)),
      ],
      stopReason: "stagnation",
      roundTrips: 3,
      code: EXIT_OK,
      // 裁定 0（主張なし）＋ 最終版の C7 の未解決 0 ＋ **停滞で足す試験 3**（最終版の C7 の不一致 r4-normal・r4-abnormal・r4-boundary の行き先）
      // ＋ B3 の落ち 0 ＝ 3。停滞で足した分を含まなければ 0 になる
      c7: 3,
      unresolved: 3,
    },
    {
      name: "(b) 上限",
      // 拒否の数が 4 → 3 → 2 → 1 と減って採り、同数の 2 版が採れずに点検 6 を使い切る（拒否は直す手 4a に渡る R3 を含む）
      calls: (): RecordedCall[] => [
        structured({ declaration: V11A_YAML }), rejecting(["R1", "R2", "R3", "R4"]),
        v11aRepairDone(), rejecting(["R2", "R3", "R4"]),
        v11aRepairDone(), rejecting(["R3", "R4"]),
        v11aRepairDone(), rejecting(["R3"]),
        v11aRepairDone(), rejecting(["R3"]),
        v11aRepairDone(), rejecting(["R3"]),
      ],
      stopReason: "limit",
      roundTrips: 5,
      code: EXIT_OK,
      // 裁定 0（主張なし）＋ 最終版（拒否 R3 の 1 件の版）の C7 の未解決 0 ＋ 停滞でないので足さない ＝ 0
      c7: 0,
      unresolved: 0,
    },
    {
      name: "(c) 差し戻し",
      // B3' の拒否 → B5 の主張 → B5' が Plan へ戻す
      // 旗 ids の走りの試験 ID はコードが場合の順に振る（case: と連番。#625）。B5 の主張と B5' の裁定が指す r4-normal を同じ試験の ID に引き直す
      calls: (): RecordedCall[] => {
        const tests = (v11aTestSpec() as { readonly tests: readonly { readonly id: string; readonly target: { readonly requirementId: string } }[] }).tests.filter((test) => test.target.requirementId !== "R2");
        const index = tests.findIndex((test) => test.id === "r4-normal");
        // 見つからなければ落とす（case:0 などへ黙って化けない）
        expect(index, "r4-normal が T2 の場合に無い").toBeGreaterThanOrEqual(0);
        return JSON.parse(JSON.stringify(v11aReturnToPlan().slice(3)).replaceAll('"r4-normal"', `"case:${String(index + 1)}"`)) as RecordedCall[];
      },
      stopReason: "unresolved",
      roundTrips: 1,
      code: EXIT_RETURN_TO_PLAN,
      // 裁定の未解決 0（r4-normal は Plan へ戻す判断で、確定した仕様があるので未解決に落とさない）＋ 最終版の C7 の未解決 0 ＋ 停滞でない ＝ 0
      c7: 0,
      unresolved: 0,
    },
  ] as const;

  it.each(SEARCH_STOPS)("探索の直しの $name で止めた範囲 write..judge の走り：stop_reason・宣言のファイル（判定した宣言とバイト列で同じ・SHA が記録と一致）・記録の欄が同じ台本の一気通貫と同じで、manifest が無く、終了コードは今までどおり", async (scenario) => {
    const { whole } = await wholeRun(`u3-search-src-${scenario.stopReason}`);
    const head = [...v12Head(), structured(v11aJudgments())].slice(0, 6);
    // 同じ台本の一気通貫（比較元の検証の記録・要約・宣言）
    const reference = `${directory}/u3-search-ref-${scenario.stopReason}`;
    const full = await runV11aCli({ dir: reference, calls: [...head, ...scenario.calls()], pipeline: "v1.2" });
    expect(full.summary["stop_reason"], JSON.stringify(full.summary)).toBe(scenario.stopReason);
    const dir = `${directory}/u3-search-${scenario.stopReason}`;
    const run = await runStageCli({ dir, args: ["--stage-start", "write", "--stage-input", `${whole}/${stageCheckpointFile("t2-b1")}`], calls: scenario.calls(), pipeline: "v1.2" });
    expect(run.errors.filter((line) => line.startsWith("stage-input:"))).toEqual([]);
    expect(run.clientErrors).toEqual([]);
    expect(run.code).toBe(scenario.code);
    expect(run.written).toEqual([STAGE_DECLARATION_FILE, STAGE_RUN_RECORD_FILE]);
    const text = await fs.readFile(`${dir}/${STAGE_DECLARATION_FILE}`, "utf8");
    // 判定した宣言（一気通貫の納品物の宣言＝一番良い版）とバイト列で同じ
    expect(text).toBe(await fs.readFile(`${reference}/artifacts/app.spec.yaml`, "utf8"));
    const record = await stageRecordOf(dir);
    expect(record["return_to_plan"]).toBe(scenario.stopReason === "unresolved");
    expect(record["stage_judge_verdict"]).toBe(full.summary["verdict"]);
    expect(record["declaration"]).toEqual({ file: STAGE_DECLARATION_FILE, sha256: await sha256Hex(text), static_check_passed: true });
    const verification = record["verification"] as Record<string, unknown>;
    const v11a = await readJson(`${reference}/${V11A_ARTIFACT_NAMES.verification}`);
    const repairs = (full.summary["stages"] as readonly { readonly stage: string }[]).filter((entry) => entry.stage === "repair").length;
    expect(verification).toMatchObject({
      table_sha256: v11a["table_sha256"],
      test_suite_sha256: v11a["test_suite_sha256"],
      declaration_sha256: await sha256Hex(text),
      checked_declaration_sha256s: v11a["checked_declaration_sha256s"],
      decl_check: v11a["decl_check"],
      b3_misses: 0,
      c7_mismatches: scenario.c7,
      not_run: null,
      stop_reason: scenario.stopReason,
    });
    expect(v11a["declaration_sha256"]).toBe(verification["declaration_sha256"]);
    expect(verification["round_trips"]).toBe(repairs);
    expect(verification["round_trips"]).toBe(scenario.roundTrips);
    expect(verification["unresolved"]).toBe(scenario.unresolved);
    // 納品物を書かない
    await expect(fs.readFile(`${dir}/${BUNDLE_MANIFEST_FILE}`, "utf8")).rejects.toThrow();
    expect(run.written.some((path) => path.startsWith("artifacts/"))).toBe(false);
  });
});

describe("封筒の枝は段が渡した schema と深く等しい（実 adapter・偽物の fetch。Issue #549 の直し）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 封筒に載る段は、起動時に組んだ封筒ではなく、その走りの段の schema（旗 on は台帳から導いたもの）で送る。
  // 段の検証と、モデルに届く形がずれる共通の原因を、送信の body で塞ぐ（旗 off・on・v1 の全段）。
  const v11aStages = STAGE_ENVELOPE_ENTRIES_V11A.map((entry) => entry.stage);

  // 旗 ids の走りの試験 ID はコードが場合の順に振る（case: と連番。#625）。B5 の主張と ⑥' の裁定が指す r4-normal を同じ試験の ID に引き直す
  const v12ReturnToPlan = (): RecordedCall[] => {
    const tests = (v11aTestSpec() as { readonly tests: readonly { readonly id: string; readonly target: { readonly requirementId: string } }[] }).tests.filter((test) => test.target.requirementId !== "R2");
    const index = tests.findIndex((test) => test.id === "r4-normal");
    // 見つからなければ落とす（case:0 などへ黙って化けない）
    expect(index, "r4-normal が T2 の場合に無い").toBeGreaterThanOrEqual(0);
    const caseId = `case:${String(index + 1)}`;
    return [...v12Head(), ...(JSON.parse(JSON.stringify(v11aReturnToPlan().slice(4)).replaceAll('"r4-normal"', `"${caseId}"`)) as RecordedCall[])];
  };

  /**
   * 走りの段の要求を、入口が作った adapter の封筒で送り直した組（`--pipeline v1.2` は v1.2 の封筒。Issue #588。旗 ids が on の
   * v1.2 は識別子 v1.2-ids。Issue #682）
   */
  async function exchangesOfRun(run: Awaited<ReturnType<typeof runV11aCli>>, pipeline: "v1.1a" | "v1.2" = "v1.1a"): Promise<WireExchange[]> {
    const options = run.makeClient.mock.calls[0]?.[0];
    expect(options).toMatchObject({ envelope: pipeline === "v1.2" ? "v1.2-ids" : pipeline });
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
      // 封筒に載る全段を照らした（v1.2 は旗 v12.ids で T1 を呼ばず、C1 の 3 束と C2 を呼ぶ。Issue #593）
      const expected = pipeline === "v1.2" ? STAGE_ENVELOPE_ENTRIES_V12_IDS.map((entry) => entry.stage).filter((stage) => stage !== "name-table") : v11aStages;
      const envelopeStages = pipeline === "v1.2" ? STAGE_ENVELOPE_ENTRIES_V12_IDS.map((entry) => entry.stage) : v11aStages;
      expect([...seen].filter((stage) => envelopeStages.includes(stage)).sort()).toEqual([...expected].sort());
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
    [...new Set(observed)].filter((name) => !envelopeStages.includes(name) && !Object.hasOwn(OUTSIDE_ENVELOPE_STAGES, name)).sort();

  it("許可の一覧が認めるのは、一覧に書いた 2 名だけ（継承したプロパティの名前は許可しない。Issue #590 の直し）", () => {
    expect(Object.keys(OUTSIDE_ENVELOPE_STAGES).sort()).toEqual(["judge-answers", FIELD_REPAIR_SCHEMA_NAME].sort());
    expect(unlistedNames(["judge-answers", FIELD_REPAIR_SCHEMA_NAME], [])).toEqual([]);
    // `in` なら原型の鎖から通ってしまう名前を、未許可として検出する
    expect(unlistedNames(["toString", "constructor", "__proto__", "hasOwnProperty"], [])).toEqual(
      ["__proto__", "constructor", "hasOwnProperty", "toString"],
    );
  });

  for (const pipeline of ["v1.1a", "v1.2"] as const) {
    it(`${pipeline}：完走と差し戻しの走りで観測した構造化出力の名前は、封筒の一覧か許可の一覧にある。許可に無い名前を足した段は落ちる`, async () => {
      const envelopeStages = (pipeline === "v1.2" ? STAGE_ENVELOPE_ENTRIES_V12_IDS : STAGE_ENVELOPE_ENTRIES_V11A).map((entry) => entry.stage);
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

  it("v1.2：送信の body の C1 の束 3 の枝の計算に aggregate があり（ids on は T1 を呼ばない。Issue #593）、v1.1a の T1 の枝には無い", async () => {
    const typeOf = (exchanges: readonly WireExchange[]) => {
      const exchange = exchanges.find((candidate) => candidate.request.schemaName === "name-table");
      expect(exchange).toBeDefined();
      const branch = sentBranchOf(exchange as WireExchange) as {
        readonly properties: { readonly rows: { readonly items: { readonly properties: { readonly type: { readonly required: readonly string[]; readonly properties: Record<string, unknown> } } } } };
      };
      return branch.properties.rows.items.properties.type;
    };
    const on = await runV11aCli({ dir: `${directory}/wire-t1-on`, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    const onExchanges = await exchangesOfRun(on, "v1.2");
    expect(onExchanges.some((candidate) => candidate.request.schemaName === "name-table")).toBe(false);
    const behaviors = onExchanges.find((candidate) => candidate.request.schemaName === "vocabulary-behaviors");
    expect(behaviors).toBeDefined();
    const computation = (sentBranchOf(behaviors as WireExchange) as {
      readonly properties: { readonly computations: { readonly items: { readonly required: readonly string[]; readonly properties: Record<string, unknown> } } };
    }).properties.computations.items;
    expect(computation.properties).toHaveProperty("aggregate");
    expect(computation.required).toContain("aggregate");
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

  it("v1.2：完走と差し戻しの道で、封筒に載る段（T1 を除く 9 段）すべての送信の名前と schema のバイト列が同じで、名前が stage-envelope-v12・schema が識別子 v1.2-ids の封筒（Issue #588・#593・#682）", async () => {
    // v1.1α の 6 段に旗 v12.ids の C1 の 3 束と C2 を足した 10 段。ids on の走りは T1 を呼ばない
    const v12Stages = STAGE_ENVELOPE_ENTRIES_V12_IDS.map((entry) => entry.stage).filter((stage) => stage !== "name-table");
    expect(STAGE_ENVELOPE_ENTRIES_V12_IDS).toHaveLength(10);
    expect(v12Stages).toHaveLength(9);
    const seen = new Set<string>();
    const sent = new Set<string>();
    for (const route of routesOf("v1.2")) {
      const run = await runV11aCli({ dir: `${directory}/wire-one-v12-${route.name}`, calls: route.calls, pipeline: "v1.2" });
      const exchanges = await exchangesOfRun(run, "v1.2");
      for (const exchange of exchanges) {
        expectSentSchemaIsStageSchema(exchange);
        const format = formatOf(exchange);
        if (!STAGE_ENVELOPE_ENTRIES_V12_IDS.some((entry) => entry.stage === exchange.request.schemaName)) {
          // 封筒に載らない口（判定の口など）は、その schema をそのまま送る
          expect(format.name, exchange.request.schemaName).toBe(exchange.request.schemaName);
          continue;
        }
        expect(format.name, exchange.request.schemaName).toBe("stage-envelope-v12");
        expect(format.schema, exchange.request.schemaName).toEqual(ENVELOPE_SCHEMA_V12_IDS);
        sent.add(JSON.stringify({ name: format.name, schema: format.schema }));
        seen.add(exchange.request.schemaName);
      }
    }
    // 9 段を照らし、全段の送信が 1 種類の前置き（名前と schema のバイト列）
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
    expect(summary).not.toHaveProperty("v12_calls");
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

/** 照合ありの偽物が投げた誤りを残してから投げ直す（入口は誤りを終了コードに畳むので、照合で落ちたことを外から見る） */
async function keepingErrors<T>(errors: unknown[], call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    errors.push(error);
    throw error;
  }
}

/**
 * 旗を省いた `--pipeline v1.1a --plan-file` を 1 経路流し、観測した値を返す（ファイルは手元の写像で閉じる）。
 * 偽物は記録を要求の schema に照らす（Issue #590）。偽物が投げた誤りは `clientErrors` に残す（記録との比較には入れない）
 */
async function captureV11aCli(
  entry: typeof runCli,
  scenario: (typeof V11A_BEFORE_SCENARIOS)[number],
  clientErrors: unknown[] = [],
): Promise<V11aBeforeCapture> {
  const planText = JSON.stringify(await v11aEnvelope());
  const recording = createCheckedRecordingClient(scenario.calls());
  const order: { readonly kind: "structured" | "tools"; readonly request: object }[] = [];
  const client: LlmClient = {
    async callStructured<T>(request: LlmStructuredRequest) {
      order.push({ kind: "structured", request });
      return keepingErrors(clientErrors, () => recording.client.callStructured<T>(request));
    },
    async callWithTools(request) {
      order.push({ kind: "tools", request });
      return keepingErrors(clientErrors, () => recording.client.callWithTools(request));
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
      const clientErrors: unknown[] = [];
      const capture = await captureV11aCli(runCli, scenario, clientErrors);
      const expected = v11aBefore.captures[index]!;
      // 記録は要求の schema に照らして通る（照らさないのは理由つきの unchecked だけ。Issue #590）
      expect(clientErrors, scenario.name).toEqual([]);
      expect(capture.clientOptions, scenario.name).toEqual(expected.clientOptions);
      expect(capture.requests, scenario.name).toEqual(expected.requests);
      expect(capture.files, scenario.name).toEqual(expected.files);
      expect(capture.lines, scenario.name).toEqual(expected.lines);
      expect(capture.exitCode, scenario.name).toBe(expected.exitCode);
      expect(capture, scenario.name).toEqual(expected);
      for (const file of capture.files) expect(file.path, scenario.name).not.toMatch(/stage-/);
    }
  });

  it("照合ありの偽物を通る：schema に合わない応答（T1 に schema に無い欄）を流すと FakeLlmSchemaMismatchError で落ちる（Issue #590 の直し）", async () => {
    const clientErrors: unknown[] = [];
    const capture = await captureV11aCli(
      runCli,
      { name: "schema-mismatch", calls: () => [structured({ ...v11aT1(), unexpected: true }), ...v11aHead().slice(1), structured(v11aJudgments())] },
      clientErrors,
    );
    expect(clientErrors).toHaveLength(1);
    expect(clientErrors[0]).toBeInstanceOf(FakeLlmSchemaMismatchError);
    expect(clientErrors[0]).toMatchObject({ recordIndex: 0, schemaName: "name-table" });
    expect(capture.exitCode).not.toBe(EXIT_OK);
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

/**
 * 段の走りを 1 回流す（偽物の LLM・判定・時計で閉じる。`--out` と前の走りの出力だけ本物のファイル）。
 * 偽物は記録を要求の schema に照らす（Issue #590）。偽物が投げた誤りは `clientErrors` に残す
 */
async function runStageCli(input: {
  readonly dir: string;
  readonly args: readonly string[];
  readonly calls: readonly RecordedCall[];
  readonly envelope?: Record<string, unknown>;
  readonly source?: string;
  /** 経路（省けば v1.1a。Issue #637） */
  readonly pipeline?: "v1.1a" | "v1.2";
  /** 偽物の時計（省けば 0 のまま）と、要求ごとに時計を進める口（出来事で進める。時刻を読む回数では進めない。Issue #746） */
  readonly clock?: { readonly now: () => number; readonly onRequest: (schemaName: string) => void };
}) {
  const planPath = `${input.dir}-plan.json`;
  const planText = JSON.stringify(input.envelope ?? (await v11aEnvelope()));
  const recording = createCheckedRecordingClient(input.calls);
  const order: string[] = [];
  const structuredRequests: LlmStructuredRequest[] = [];
  const clientErrors: unknown[] = [];
  const client: LlmClient = {
    async callStructured<T>(request: LlmStructuredRequest) {
      order.push(requestText(request));
      structuredRequests.push(request);
      input.clock?.onRequest(request.schemaName);
      return keepingErrors(clientErrors, () => recording.client.callStructured<T>(request));
    },
    async callWithTools(request) {
      order.push(requestText(request));
      input.clock?.onRequest("tools");
      return keepingErrors(clientErrors, () => recording.client.callWithTools(request));
    },
  };
  const makeClient = vi.fn((_options: { readonly envelope?: EnvelopeId }) => client);
  const lines: string[] = [];
  const errors: string[] = [];
  const written: string[] = [];
  const directories: string[] = [];
  const code = await runCli({
    argv: ["--", "request.txt", "--out", input.dir, "--pipeline", input.pipeline ?? "v1.1a", "--plan-file", planPath, ...input.args],
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
    now: input.clock?.now ?? (() => 0),
    log: (line) => lines.push(line),
    logError: (line) => errors.push(line),
  });
  return { code, lines, errors, written, directories, makeClient, requests: order, structuredRequests, clientErrors };
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
  it("照合ありの偽物を通る：schema に合わない応答（T1 に schema に無い欄）を流すと FakeLlmSchemaMismatchError で落ちる（Issue #590 の直し）", async () => {
    const run = await runStageCli({
      dir: `${directory}/stage-schema-mismatch`,
      args: ["--stage-end", "test-spec"],
      calls: [structured({ ...v11aT1(), unexpected: true }), ...v11aHead().slice(1, 3)],
    });
    expect(run.clientErrors).toHaveLength(1);
    expect(run.clientErrors[0]).toBeInstanceOf(FakeLlmSchemaMismatchError);
    expect(run.clientErrors[0]).toMatchObject({ recordIndex: 0, schemaName: "name-table" });
    expect(run.code).not.toBe(EXIT_OK);
  });

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

/**
 * 要約の段の記録から、T2（test-spec）の束の記録の項目ごとの合計を組む（`v12_calls.test_spec.total` の期待。Issue #626）。
 * 束 1 の走りでは、その 1 つの記録の計と同じ
 */
function t2TotalOf(summary: Record<string, unknown>): unknown {
  type Row = {
    readonly stage: string;
    readonly calls: number;
    readonly missing_usage_calls: number;
    readonly input_tokens: number;
    readonly cached_input_tokens: number;
    readonly cache_write_tokens: number;
    readonly output_tokens: number;
    readonly reasoning_tokens: number;
    readonly attempts: Record<string, unknown>;
    readonly retries: Record<string, unknown>;
  };
  const rows = (summary["stages"] as readonly Row[]).filter((row) => row.stage === "test-spec");
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (row === undefined) throw new Error("前提が壊れた：T2 の記録が無い");
  return {
    calls: row.calls,
    missing_usage_calls: row.missing_usage_calls,
    input_tokens: row.input_tokens,
    cached_input_tokens: row.cached_input_tokens,
    cache_write_tokens: row.cache_write_tokens,
    output_tokens: row.output_tokens,
    reasoning_tokens: row.reasoning_tokens,
    attempts: row.attempts,
    retries: row.retries,
  };
}

/** 要求から段ごとの effort と打ち切りの合図を除く（口なしの走りの要求と比べる。Issue #664） */
const withoutEffort = ({ effort: _effort, signal: _signal, ...rest }: LlmStructuredRequest) => rest;
/** 条件の記録から段ごとの effort の欄を除く（Issue #664） */
const withoutStageEfforts = (text: string): string => {
  const value = JSON.parse(text) as { conditions: Record<string, unknown> };
  const { stage_efforts: _stageEfforts, ...conditions } = value.conditions;
  return JSON.stringify({ ...value, conditions });
};

describe("段ごとの effort の口（`--pipeline v1.2` の `--stage-effort`。Issue #664）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });


  it("(1) 一気通貫：--stage-effort semantic-check=low を付けた v1.2 の走りの条件の記録の末尾に stage_efforts が段 → 値で載り、C3 の要求だけ effort low。付けない走りには欄が無く、欄と effort を除けば記録・要約・要求・納品物が同じ", async () => {
    const calls = (): RecordedCall[] => [...v12Head(), structured(v11aJudgments())];
    const plainDir = `${directory}/v12-stage-effort-plain`;
    const tunedDir = `${directory}/v12-stage-effort-tuned`;
    const plain = await runV11aCli({ dir: plainDir, calls: calls(), pipeline: "v1.2" });
    const tuned = await runV11aCli({ dir: tunedDir, calls: calls(), pipeline: "v1.2", args: ["--stage-effort", "semantic-check=low"] });
    expect(tuned.code).toBe(plain.code);
    expect(plain.record.conditions).not.toHaveProperty("stage_efforts");
    expect(tuned.record.conditions["stage_efforts"]).toEqual({ "semantic-check": "low" });
    expect(Object.keys(tuned.record.conditions).at(-1)).toBe("stage_efforts");
    // adapter の設定（effort・封筒）は今のまま。段の effort は要求で渡す
    expect(tuned.makeClient.mock.calls).toEqual(plain.makeClient.mock.calls);
    const c3 = tuned.recording.structured.filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME);
    expect(c3.length).toBeGreaterThan(0);
    for (const request of c3) {
      expect(request.effort).toBe("low");
      expect(request.maxOutputTokens).toBe(maxOutputTokensForEffort("low", "semantic-check"));
    }
    expect(tuned.recording.structured.filter((request) => request.schemaName !== SEMANTIC_CHECK_SCHEMA_NAME).some((request) => "effort" in request)).toBe(false);
    expect(plain.recording.structured.some((request) => "effort" in request)).toBe(false);
    expect(tuned.recording.structured.map(withoutEffort)).toEqual(plain.recording.structured.map(withoutEffort));
    expect(tuned.summary).toEqual(plain.summary);
    expect(tuned.written).toEqual(plain.written);
    for (const path of plain.written) {
      const plainText = await fs.readFile(`${plainDir}/${path}`, "utf8");
      // 出力の場所（納品物の storage_unit）だけは走りごとに違うので、比較元の場所に読み替えて比べる
      const tunedText = (await fs.readFile(`${tunedDir}/${path}`, "utf8")).replaceAll(tunedDir, plainDir);
      expect(path === BUILD_CLI_RECORD_FILE ? withoutStageEfforts(tunedText) : tunedText, path).toBe(plainText);
    }
    expectNoAcceptanceMaterial(tuned.recording.structured.map((request) => JSON.stringify(request)));
  });

  it("(2') 段の走り（v1.2・vocabulary..semantic-check）：段の走りの記録の conditions の末尾に stage_efforts が載り、C3 の要求の effort と上限が low でほかは今のまま。付けなければ段の走りの記録はバイト列で同じ（欄を除けば同じ）", async () => {
    const segment0 = (): RecordedCall[] => v12Head().slice(0, 5);
    const plainDir = `${directory}/v12-stage-effort-segment0-plain`;
    const tunedDir = `${directory}/v12-stage-effort-segment0-tuned`;
    const args = ["--stage-start", "vocabulary", "--stage-end", "semantic-check"];
    const plain = await runStageCli({ dir: plainDir, args, calls: segment0(), pipeline: "v1.2" });
    const tuned = await runStageCli({ dir: tunedDir, args: [...args, "--stage-effort", "semantic-check=low"], calls: segment0(), pipeline: "v1.2" });
    expect(tuned.code).toBe(EXIT_OK);
    expect(plain.code).toBe(EXIT_OK);
    const plainRecord = await stageRecordOf(plainDir);
    const tunedRecord = await stageRecordOf(tunedDir);
    expect(plainRecord["conditions"]).not.toHaveProperty("stage_efforts");
    const conditions = tunedRecord["conditions"] as Record<string, unknown>;
    expect(conditions["stage_efforts"]).toEqual({ "semantic-check": "low" });
    expect(Object.keys(conditions).at(-1)).toBe("stage_efforts");
    const c3 = tuned.structuredRequests.filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME);
    expect(c3.length).toBeGreaterThan(0);
    for (const request of c3) {
      expect(request.effort).toBe("low");
      expect(request.maxOutputTokens).toBe(maxOutputTokensForEffort("low", "semantic-check"));
    }
    expect(tuned.structuredRequests.filter((request) => request.schemaName !== SEMANTIC_CHECK_SCHEMA_NAME).some((request) => "effort" in request)).toBe(false);
    expect(tuned.structuredRequests.map(withoutEffort)).toEqual(plain.structuredRequests.map(withoutEffort));
    expect(tuned.written).toEqual(plain.written);
    for (const path of plain.written) {
      const plainText = await fs.readFile(`${plainDir}/${path}`, "utf8");
      const tunedText = await fs.readFile(`${tunedDir}/${path}`, "utf8");
      expect(path === STAGE_RUN_RECORD_FILE ? stageJsonText(JSON.parse(withoutStageEfforts(tunedText))) : tunedText, path).toBe(plainText);
    }
    expect(tuned.lines).toEqual(plain.lines);
  });

  it("引数：繰り返しを付けた順に段 → 値で読み、省けば欄が無い。一気通貫と段の走りの両方で受ける", () => {
    const base = ["--", "request.txt", "--out", "out", "--pipeline", "v1.2", "--plan-file", "plan.json"];
    const parsed = parseCliArguments([...base, "--stage-effort", "write=medium", "--stage-effort", "vocabulary=low"]);
    expect("error" in parsed ? parsed.error : parsed.stageEfforts).toEqual({ write: "medium", vocabulary: "low" });
    expect(Object.keys("error" in parsed ? {} : (parsed.stageEfforts ?? {}))).toEqual(["write", "vocabulary"]);
    const staged = parseCliArguments([...base, "--stage-end", "semantic-check", "--stage-effort", "semantic-check=low"]);
    expect("error" in staged ? staged.error : [staged.stageRange, staged.stageEfforts]).toEqual([{ start: "name-table", end: "semantic-check" }, { "semantic-check": "low" }]);
    expect(parseCliArguments(base)).not.toHaveProperty("stageEfforts");
    expect(parseStageEfforts([])).toEqual({ stageEfforts: {} });
  });

  const usageCases: readonly { readonly name: string; readonly argv: readonly string[]; readonly code: string }[] = [
    { name: "知らない段", argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort", "unknown-stage=low"], code: "stage-effort:stage" },
    { name: "配線していない段（name-table）", argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort", "name-table=low"], code: "stage-effort:stage" },
    { name: "配線していない段（repair）", argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort", "repair=low"], code: "stage-effort:stage" },
    { name: "知らない値", argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort", "semantic-check=extreme"], code: "stage-effort:value" },
    { name: "空の値", argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort", "semantic-check="], code: "stage-effort:value" },
    {
      name: "同じ段の重複",
      argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort", "mapping=low", "--stage-effort", "mapping=low"],
      code: "stage-effort:duplicate",
    },
    { name: "= の無い形", argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort", "semantic-check"], code: "stage-effort:format" },
    { name: "段の無い形", argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort", "=low"], code: "stage-effort:format" },
    { name: "値の無い旗", argv: ["--pipeline", "v1.2", "--plan-file", "plan.json", "--stage-effort"], code: "stage-effort:missing" },
    { name: "--pipeline v1.1a との組", argv: ["--pipeline", "v1.1a", "--plan-file", "plan.json", "--stage-effort", "semantic-check=low"], code: "stage-effort:pipeline" },
    { name: "--pipeline v1 との組", argv: ["--pipeline", "v1", "--plan-file", "plan.json", "--stage-effort", "semantic-check=low"], code: "stage-effort:pipeline" },
    { name: "--pipeline の省略", argv: ["--stage-effort", "semantic-check=low"], code: "stage-effort:pipeline" },
    {
      name: "v1.1a の段の走りとの組",
      argv: ["--pipeline", "v1.1a", "--plan-file", "plan.json", "--stage-end", "semantic-check", "--stage-effort", "semantic-check=low"],
      code: "stage-effort:pipeline",
    },
  ];
  it.each(usageCases)("(2) $name → $code（終了コード 2・API を呼ばない・何も書かない）", async (example) => {
    const makeClient = vi.fn();
    const writeFile = vi.fn(async () => {});
    const makeDirectory = vi.fn(async () => {});
    const readFile = vi.fn(async () => V11A_SOURCE);
    const lines: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", "out", ...example.argv],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile,
      writeFile,
      makeDirectory,
      loadDocuments: async () => [],
      makeClient,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(lines[0]).toContain(`使い方の誤り: ${example.code}（`);
    expect(lines.slice(1)).toEqual([USAGE, STAGE_EFFORT_USAGE]);
    expect(makeClient).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(makeDirectory).not.toHaveBeenCalled();
  });
});

// ── 段の走りの探索の出来事の列（旗 v12.ids・v12.search-repair が on の段の走りの `search_repair`。Issue #746）──────────────────────
//
// 偽物の LLM・判定と、出来事（要求）で進める偽物の時計で閉じる（時刻を読む回数では進めない）。時計は B1 の要求で 1000・B3' で 200・
// 道具付きの直す段で 3000・欄だけの直しで 500・ほかの構造化出力で 100 ミリ秒進み、コードの段の中では進まない。だから出来事の時間は、
// その出来事が含んだ段の行の `duration_ms` の和に等しい。期待の違反の数と失敗の集合は、台本（偽物の検証の結果）から手で組む。

describe("段の走りの探索の出来事の列（旗 v12.ids・v12.search-repair の段の走りの search_repair。Issue #746）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** C7 で R4 の 3 本が不一致になる宣言（率の式を変える） */
  const R4_BAD = V11A_YAML.replace("expression: base * 2", "expression: base * 3");
  /** C7 で R3 の境界の 1 本が不一致になる宣言（closeItem の条件を変える。失敗は場所に写るので欄だけの直しへ流れる） */
  const W1 = V11A_YAML.replace("when: amount > 0", "when: amount > 1");
  /** 静的チェックに落ちる宣言 */
  const BROKEN = `${V11A_YAML}entities: [\n`;
  /** B3 で R3 の操作が結び付かない宣言（B3' を流さない） */
  const MISS = V11A_YAML.replace("  - name: closeItem", "  - name: closeIt");
  const QUOTE_746 = "全体の率";
  /** 旗 ids の走りの試験 ID（T2 の場合の順にコードが振る `case:N`。R2 は構造の要件で T2 に書かない） */
  const caseIdOf = (name: string): string => {
    const tests = (v11aTestSpec() as { readonly tests: readonly { readonly id: string; readonly target: { readonly requirementId: string } }[] }).tests.filter(
      (test) => test.target.requirementId !== "R2",
    );
    const index = tests.findIndex((test) => test.id === name);
    expect(index, name).toBeGreaterThanOrEqual(0);
    return `case:${String(index + 1)}`;
  };
  const R4_CASES = ["r4-normal", "r4-abnormal", "r4-boundary"].map(caseIdOf);
  const R3_CASES = ["r3-normal", "r3-abnormal", "r3-boundary"].map(caseIdOf);
  const R1_CASES = ["r1-normal", "r1-abnormal", "r1-boundary"].map(caseIdOf);
  const textOf746 = (id: string): string => V11A_BASE_LIST.requirements.find((requirement) => requirement.id === id)?.text ?? "";
  /** B3' の判定（`ids` の要件に、`rejects` だけ拒否。拒否の引用は要件の文） */
  const judged = (ids: readonly string[], rejects: readonly string[] = []): RecordedCall =>
    structured({
      judgments: ids.map((requirementId) =>
        rejects.includes(requirementId)
          ? { requirementId, verdict: "reject", kind: "mismatch", quote: textOf746(requirementId) }
          : { requirementId, verdict: "accept", kind: null, quote: null },
      ),
    });
  const ALL = ["R1", "R2", "R3", "R4"] as const;
  const repairTo = (yaml: string, disputes: readonly string[] = []): RecordedCall => ({
    kind: "tools",
    response: { kind: "done", declaration: { declaration: yaml, disputes: disputes.map((testId) => ({ testId, quote: QUOTE_746 })) }, usage: undefined },
  });
  const overturn = (testIds: readonly string[]): RecordedCall =>
    structured({ decisions: testIds.map((testId) => ({ testId, verdict: "overturn", reason: "期待が誤り", quote: QUOTE_746 })) });
  const closeBody = (expression: string, extra: readonly string[] = []): string =>
    ["- name: closeItem", "  entity: item", "  kind: update", "  set:", "    kind: beta", `  when: ${expression}`, ...extra].join("\n");
  const fieldTo = (expression: string, disputes: readonly string[] = [], extra: readonly string[] = []): RecordedCall =>
    structured({
      replacements: [{ location: "action:item.closeItem", element: closeBody(expression, extra) }],
      disputes: disputes.map((testId) => ({ testId, quote: QUOTE_746 })),
    });
  const HUGE = [`  # ${"x".repeat(AGENT_LIMITS.declarationBytes)}`];
  /**
   * 目印の行（`# unmark:R1,R2`・`# reject:R4`）を持つ宣言だけ、B3' を偽物が返す（目印の要件を unmarked・拒否にし、ほかは受理。呼び出しなし）。
   * ほかの宣言は本物の段
   */
  const markedDeclCheck = (): void => {
    const original = declCheckStage.runDeclCheck;
    vi.spyOn(declCheckStage, "runDeclCheck").mockImplementation(async (input) => {
      const unmarkedIds = /# unmark:([A-Z0-9,]+)/u.exec(input.declaration.source)?.[1]?.split(",") ?? [];
      const rejectedIds = /# reject:([A-Z0-9,]+)/u.exec(input.declaration.source)?.[1]?.split(",") ?? [];
      if (unmarkedIds.length === 0 && rejectedIds.length === 0) return original(input);
      const ids = input.list.requirements.map((requirement) => requirement.id);
      return {
        ok: true,
        value: {
          declarationSha256: await sha256Hex(input.declaration.source),
          judgments: ids.map((requirementId) =>
            unmarkedIds.includes(requirementId)
              ? { requirementId, verdict: "unmarked" as const }
              : rejectedIds.includes(requirementId)
                ? { requirementId, verdict: "reject" as const, kind: "mismatch" as const, quote: textOf746(requirementId) }
                : { requirementId, verdict: "accept" as const, kind: null, quote: null },
          ),
          targets: ids.filter((id) => !unmarkedIds.includes(id)),
          unmarked: ids.filter((id) => unmarkedIds.includes(id)),
        },
      };
    });
  };

  /** 出来事で進める偽物の時計（時刻を読む回数では進まない） */
  const COSTS: Readonly<Record<string, number>> = { [WRITE_V11A_SCHEMA_NAME]: 1000, [DECL_CHECK_SCHEMA_NAME]: 200, tools: 3000, [FIELD_REPAIR_SCHEMA_NAME]: 500 };
  const eventClock = () => {
    let now = 0;
    return { now: () => now, onRequest: (schemaName: string) => (now += COSTS[schemaName] ?? 100) };
  };

  // 同じ台本の上流（C1〜T2）を 1 回流し、t2-b1 の checkpoint を共有する
  let checkpoint746 = "";
  beforeAll(async () => {
    const whole = `${directory}/sr746-whole`;
    await runV11aCli({ dir: whole, calls: [...v12Head(), structured(v11aJudgments())], pipeline: "v1.2" });
    checkpoint746 = `${whole}/${stageCheckpointFile("t2-b1")}`;
  });
  const HEAD_746 = (): RecordedCall[] => [...v12Head(), structured(v11aJudgments())].slice(0, 6);

  type Json = Record<string, any>;
  /** 範囲 write..judge の段の走りを流し、CLI が書いた stage-run.json を読む */
  async function stageRun746(name: string, calls: readonly RecordedCall[]) {
    const dir = `${directory}/sr746-${name}`;
    const run = await runStageCli({ dir, args: ["--stage-start", "write", "--stage-input", checkpoint746], calls, pipeline: "v1.2", clock: eventClock() });
    expect(run.errors.filter((line) => line.startsWith("stage-input:")), name).toEqual([]);
    const text = await fs.readFile(`${dir}/${STAGE_RUN_RECORD_FILE}`, "utf8");
    const record = JSON.parse(text) as Json;
    return { run, text, record, search: record["search_repair"] as Json | undefined, stages: record["stages"] as readonly Json[] };
  }
  /** 同じ台本の一気通貫（納品物の search-repair.json と照らす比較元） */
  async function wholeRun746(name: string, calls: readonly RecordedCall[]) {
    const dir = `${directory}/sr746-whole-${name}`;
    const run = await runV11aCli({ dir, calls: [...HEAD_746(), ...calls], pipeline: "v1.2" });
    const searchFile = JSON.parse(await fs.readFile(`${dir}/${V12_SEARCH_REPAIR_ARTIFACT_NAME}`, "utf8")) as Json;
    return { run, searchFile };
  }

  /** 違反の数の期待値（種類ごとの内訳から組む。不明は null で和に入れない） */
  const counted = (
    sha: string,
    counts: { readonly miss?: number; readonly rej?: number | null; readonly unm?: number | null; readonly mis?: number; readonly unr?: number },
    unknown: string | null = null,
  ) => {
    const breakdown = {
      "correspondence-miss": counts.miss ?? 0,
      "decl-rejection": counts.rej === undefined ? 0 : counts.rej,
      "decl-unmarked": counts.unm === undefined ? 0 : counts.unm,
      "test-mismatch": counts.mis ?? 0,
      "test-unresolved": counts.unr ?? 0,
    };
    return {
      kind: "counted",
      declaration_sha256: sha,
      breakdown,
      known_total: Object.values(breakdown).reduce<number>((sum, value) => sum + (value ?? 0), 0),
      unknown: unknown === null ? null : { reason: unknown, declaration_sha256: sha },
    };
  };
  type Tuple = readonly [string, string | null, string | null];
  /** 失敗の集合の指紋の期待値（(種類, 試験 ID, 要件 ID) の組を JSON の文字列の順に並べた配列の JSON の SHA-256） */
  const fingerprint = (tuples: readonly Tuple[]): Promise<string> =>
    sha256Hex(`[${tuples.map((tuple) => JSON.stringify(tuple)).sort().join(",")}]`);
  const rej = (id: string): Tuple => ["decl-rejection", null, id];
  const unm = (id: string): Tuple => ["decl-unmarked", null, id];
  const mis = (testId: string, id: string): Tuple => ["test-mismatch", testId, id];

  /** 版・数え直し・往復の要点（seq の順） */
  const outline = (search: Json): readonly unknown[] =>
    (search["events"] as readonly Json[]).map((event) =>
      event["event"] === "version"
        ? ["version", event["seq"], event["origin"], event["round"], event["parent_seq"], event["adoption"]]
        : event["event"] === "recount"
          ? ["recount", event["seq"], event["cause"], event["before_seq"]]
          : ["round", event["seq"], event["round"], event["hand"], event["result"]],
    );
  const eventsOf = (search: Json, kind: string): readonly Json[] => (search["events"] as readonly Json[]).filter((event) => event["event"] === kind);

  /** 区間の段の名前（添字の区間を記録の stages に当てる） */
  const namesIn = (stages: readonly Json[], span: Json | null): readonly string[] =>
    span === null ? [] : stages.slice(span["first"] as number, (span["last"] as number) + 1).map((stage) => stage["stage"] as string);
  const msIn = (stages: readonly Json[], span: Json | null): number | null =>
    span === null ? null : stages.slice(span["first"] as number, (span["last"] as number) + 1).reduce((sum, stage) => sum + (stage["duration_ms"] as number), 0);

  /**
   * (8) の構造の検査：各出来事の区間が記録の stages の実際の段に当たり、上位の区間（初版・作り直しの作る区間と評価する区間・その数え直し・
   * 往復）が段の行の 0 から隙間も重なりも無く並び、⑦ まで届いた走りは次の行が judge。時間は区間の duration_ms の和
   */
  function checkStructure(record: Json): void {
    const search = record["search_repair"] as Json;
    const stages = record["stages"] as readonly Json[];
    const events = search["events"] as readonly Json[];
    events.forEach((event, index) => expect(event["seq"]).toBe(index));
    const top: Json[] = [];
    const rounds = events.filter((event) => event["event"] === "round");
    const insideRound = (span: Json | null): boolean =>
      span !== null && rounds.some((round) => round["stage_rows"] !== null && round["stage_rows"]["first"] <= span["first"] && span["last"] <= round["stage_rows"]["last"]);
    for (const event of events) {
      if (event["event"] === "version") {
        const make = event["stage_rows"]["make"] as Json | null;
        const evaluate = event["stage_rows"]["evaluate"] as Json | null;
        expect(namesIn(stages, make)).toEqual([event["origin"] === "repair" ? "repair" : "write"]);
        expect(event["make_ms"]).toBe(msIn(stages, make));
        const names = namesIn(stages, evaluate);
        expect(names[0]).toBe("static-check");
        for (const name of names) expect(["static-check", "name-check", "decl-check", "run-tests"]).toContain(name);
        // 比べた一番良い状態は、比べた版（write でも未決でもない版）だけが持ち、それより前の出来事を指す
        if (event["origin"] === "write" || event["adoption"] === "pending") expect(event["compared_seq"]).toBeNull();
        else expect(event["compared_seq"]).toBeLessThan(event["seq"] as number);
        if (event["adoption"] !== "pending") {
          expect(event["evaluate_ms"]).toBe(msIn(stages, evaluate));
          expect(names.at(-1)).toBe(event["violations"]["kind"] === "static-check-failed" ? "static-check" : "run-tests");
        } else {
          expect(event["evaluate_ms"]).toBeNull();
        }
        if (event["origin"] !== "repair") {
          if (make !== null) top.push(make);
          if (evaluate !== null) top.push(evaluate);
        }
      } else if (event["event"] === "recount") {
        for (const name of namesIn(stages, event["stage_rows"])) expect(["static-check", "name-check", "run-tests", "carry-over"]).toContain(name);
        if (event["stage_rows"] !== null && !insideRound(event["stage_rows"])) top.push(event["stage_rows"]);
      } else {
        const span = event["stage_rows"] as Json;
        expect(namesIn(stages, span)[0]).toBe("repair");
        if (event["duration_ms"] !== null) expect(event["duration_ms"]).toBe(msIn(stages, span));
        if (event["result"]["kind"] === "version") {
          const version = events[event["result"]["version_seq"] as number] as Json;
          expect(version["round"]).toBe(event["round"]);
          expect(insideRound(version["stage_rows"]["make"])).toBe(true);
          expect(version["stage_rows"]["make"]["first"]).toBe(span["first"]);
        }
        top.push(span);
      }
    }
    const sorted = [...top].sort((a, b) => (a["first"] as number) - (b["first"] as number));
    let next = 0;
    for (const span of sorted) {
      expect(span["first"]).toBe(next);
      next = (span["last"] as number) + 1;
    }
    if (record["stopped"] === null) {
      expect(stages[next]?.["stage"]).toBe("judge");
      expect(next).toBe(stages.length - 1);
    } else {
      expect(next).toBe(stages.length);
    }
  }

  /** 一気通貫の納品物（search-repair.json）の版・数え直し・往復と、出来事の列の同じ値が一致する（記録の行き先が増えただけ） */
  function matchesDeliverable(search: Json, file: Json): void {
    expect(eventsOf(search, "version").map((event) => ({ origin: event["origin"], declaration_sha256: event["declaration_sha256"], violations: event["violations"], adopted: event["adoption"] === "adopted" }))).toEqual(
      (file["versions"] as readonly Json[]).map((version) => ({ origin: version["origin"], declaration_sha256: version["declaration_sha256"], violations: version["violations"], adopted: version["adopted"] })),
    );
    // 納品物は B3' を流していない版も空の件数を持つが、段の走りの記録は未実施を null にする（静的チェックの落ちと、理由の付いた不明）
    const declRan = (violations: Json): boolean => violations["kind"] !== "static-check-failed" && violations["unknown"] === null;
    expect(eventsOf(search, "version").map((event) => event["discarded"])).toEqual(
      (file["versions"] as readonly Json[]).map((version) =>
        version["discarded"] === null || !declRan(version["violations"])
          ? null
          : { unmarked: (version["discarded"]["unmarked"] as readonly string[]).length, rejections: version["discarded"]["rejections"] },
      ),
    );
    expect(eventsOf(search, "recount").map((event) => ({ cause: event["cause"], declaration_sha256: event["declaration_sha256"], violations: event["violations"] }))).toEqual(file["recounts"]);
    expect(
      eventsOf(search, "round").map((event) => ({
        hand: event["hand"],
        locations: event["locations"],
        unlocated: event["unlocated"],
        refused: event["result"]["kind"] === "refused" ? MERGE_REFUSALS[event["result"]["refusal"] as keyof typeof MERGE_REFUSALS] : null,
        additions: event["additions"],
      })),
    ).toEqual(file["rounds"]);
    expect(search["rewritten"]).toBe(file["rewritten"]);
    expect((eventsOf(search, "version").concat(eventsOf(search, "recount")).find((event) => event["seq"] === search["best_seq"]) as Json)["declaration_sha256"]).toBe(file["best_declaration_sha256"]);
  }

  // ── 台本 ─────────────────────────────────────────────────────────

  /** (1) 不採用が続いて停滞で止まる（作り直しを含む）：同じ拒否 R3 と R4 の不一致 3 の版が採れない */
  const STAGNATION = (): RecordedCall[] => [
    structured({ declaration: R4_BAD }), judged(ALL, ["R3"]),
    repairTo(R4_BAD), judged(ALL, ["R3"]),
    repairTo(R4_BAD), judged(ALL, ["R3"]),
    structured({ declaration: R4_BAD }), judged(ALL, ["R3"]),
    repairTo(R4_BAD), judged(ALL, ["R3"]),
  ];
  /** (2) 拒否の数が 4 → 3 → 2 → 1 と減って採り、同数の 2 版が採れずに点検 6 を使い切る */
  const ADOPTING = (): RecordedCall[] => [
    structured({ declaration: V11A_YAML }), judged(ALL, ["R1", "R2", "R3", "R4"]),
    repairTo(V11A_YAML), judged(ALL, ["R2", "R3", "R4"]),
    repairTo(V11A_YAML), judged(ALL, ["R3", "R4"]),
    repairTo(V11A_YAML), judged(ALL, ["R3"]),
    repairTo(V11A_YAML), judged(ALL, ["R3"]),
    repairTo(V11A_YAML), judged(ALL, ["R3"]),
  ];
  const UNMARK_R1 = `${V11A_YAML}# unmark:R1\n`;
  /** (3) 網羅（R4 の試験を棄却）と採用（R1 の unmarked を確定へ移す）の数え直し。どちらも SHA は同じで失敗の集合が変わる */
  const RECOUNTS = (): RecordedCall[] => [
    structured({ declaration: R4_BAD }), judged(ALL, ["R1", "R3"]),
    repairTo(R4_BAD, R4_CASES), overturn(R4_CASES),
    judged(["R1", "R2", "R3"], ["R1", "R3"]),
    repairTo(UNMARK_R1),
  ];
  /** (4) 同数で集合の違う候補・静的チェックに落ちた版・B3' を流していない版（作り直し）を交ぜて停滞で止める */
  const SETS = (): RecordedCall[] => [
    structured({ declaration: V11A_YAML }), judged(ALL, ["R3"]),
    repairTo(V11A_YAML), judged(ALL, ["R1"]),
    repairTo(BROKEN),
    structured({ declaration: MISS }),
    repairTo(V11A_YAML), judged(ALL, ["R3"]),
  ];
  /** (5)(8) 欄だけの直しのマージを断った往復と、R3 の境界の試験の棄却による網羅の数え直しを交ぜる */
  const MIXED = (): RecordedCall[] => [
    structured({ declaration: W1 }), judged(ALL),
    fieldTo("amount > 0", [], HUGE),
    fieldTo("amount > 0", [R3_CASES[2] as string]), overturn([R3_CASES[2] as string]),
    judged(["R1", "R2", "R4"]),
  ];
  /** (5) 裁定で Plan に戻した往復 */
  const RETURNED = (): RecordedCall[] => [
    structured({ declaration: V11A_YAML }), judged(ALL, ["R3"]),
    repairTo(V11A_YAML, [R4_CASES[0] as string]),
    structured({ decisions: [{ testId: R4_CASES[0], verdict: "return-to-plan", reason: "", quote: "" }] }),
  ];

  it("(1) 停滞で止まる走り：版の出どころ・往復の番号・親・採否と往復の出来事が停止の順どおりに並び、各版の違反の全欄と指紋が台本から組んだ値で、最後の一番良い状態の SHA が記録の宣言と一致する", async () => {
    const { record, search } = await stageRun746("stagnation", STAGNATION());
    if (search === undefined) throw new Error("探索の出来事の列が無い");
    expect(record["verification"]["stop_reason"]).toBe("stagnation");
    // 停止の順（stagnationAction）：直す・直す（2 つ採れない）→ 作り直し（往復を数えない）→ 直す（作り直しのあと 2 つ採れない）→ 止める
    expect(outline(search)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["round", 1, 1, "repair", { kind: "version", version_seq: 2 }],
      ["version", 2, "repair", 1, 0, "not-adopted"],
      ["round", 3, 2, "repair", { kind: "version", version_seq: 4 }],
      ["version", 4, "repair", 2, 0, "not-adopted"],
      ["version", 5, "rewrite", 2, 0, "not-adopted"],
      ["round", 6, 3, "repair", { kind: "version", version_seq: 7 }],
      ["version", 7, "repair", 3, 0, "not-adopted"],
    ]);
    const sha = await sha256Hex(R4_BAD);
    const expectedFingerprint = await fingerprint([rej("R3"), ...R4_CASES.map((testId) => mis(testId, "R4"))]);
    for (const version of eventsOf(search, "version")) {
      expect(version["declaration_sha256"]).toBe(sha);
      expect(version["violations"]).toEqual(counted(sha, { rej: 1, mis: 3 }));
      expect(version["failure_set_sha256"]).toBe(expectedFingerprint);
      expect(version["discarded"]).toEqual(version["adoption"] === "adopted" ? null : { unmarked: 0, rejections: 1 });
    }
    expect(search["best_seq"]).toBe(0);
    expect(search["rewritten"]).toBe(true);
    expect(search["stop"]).toEqual({ reason: "stagnation", stage: null, kind: null });
    expect((search["events"] as readonly Json[])[search["best_seq"] as number]?.["declaration_sha256"]).toBe(record["declaration"]["sha256"]);
    // 往復の出来事の数は記録の往復の数（rewrite を数えない）
    expect(eventsOf(search, "round")).toHaveLength(record["verification"]["round_trips"] as number);
    checkStructure(record);
    matchesDeliverable(search, (await wholeRun746("stagnation", STAGNATION())).searchFile);
  });

  it("(2) 採用が挟まる走り：採った候補のあとの候補の親は採った版を指し、採らなかった候補のあとも一番良い状態が変わらない。各版の違反は台本の拒否の数（0 に固定・一番良い版の写しは落ちる）", async () => {
    const { record, search } = await stageRun746("adopting", ADOPTING());
    if (search === undefined) throw new Error("探索の出来事の列が無い");
    expect(record["verification"]["stop_reason"]).toBe("limit");
    expect(outline(search)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["round", 1, 1, "repair", { kind: "version", version_seq: 2 }],
      ["version", 2, "repair", 1, 0, "adopted"],
      ["round", 3, 2, "repair", { kind: "version", version_seq: 4 }],
      ["version", 4, "repair", 2, 2, "adopted"],
      ["round", 5, 3, "repair", { kind: "version", version_seq: 6 }],
      ["version", 6, "repair", 3, 4, "adopted"],
      ["round", 7, 4, "repair", { kind: "version", version_seq: 8 }],
      ["version", 8, "repair", 4, 6, "not-adopted"],
      ["round", 9, 5, "repair", { kind: "version", version_seq: 10 }],
      ["version", 10, "repair", 5, 6, "not-adopted"],
    ]);
    const sha = await sha256Hex(V11A_YAML);
    const rejected = [["R1", "R2", "R3", "R4"], ["R2", "R3", "R4"], ["R3", "R4"], ["R3"], ["R3"], ["R3"]];
    const versions = eventsOf(search, "version");
    for (const [index, ids] of rejected.entries()) {
      expect(versions[index]?.["violations"]).toEqual(counted(sha, { rej: ids.length }));
      expect(versions[index]?.["failure_set_sha256"]).toBe(await fingerprint(ids.map(rej)));
    }
    expect(search["best_seq"]).toBe(6);
    // 数え直しの無い走りでは、比べた状態は親と同じ
    for (const version of versions.slice(1)) expect(version["compared_seq"]).toBe(version["parent_seq"]);
    expect(search["stop"]).toEqual({ reason: "limit", stage: null, kind: null });
    checkStructure(record);
    matchesDeliverable(search, (await wholeRun746("adopting", ADOPTING())).searchFile);
  });

  it("(3) 同じ SHA の数え直し：網羅と採用の数え直しの違反の全欄と指紋が台本から組んだ値で、数え直しのあとに始まる往復の候補の親がその数え直しを指し、同じ往復の候補の親は数え直しの前の状態で、比べた状態（compared_seq）はその数え直し（指紋だけを更新して内訳を古い値のままにする実装・比べた状態を親の写しにする実装は落ちる）", async () => {
    markedDeclCheck();
    const { record, search } = await stageRun746("recounts", RECOUNTS());
    if (search === undefined) throw new Error("探索の出来事の列が無い");
    expect(record["verification"]["stop_reason"]).toBe("completed");
    expect(outline(search)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["round", 1, 1, "repair", { kind: "version", version_seq: 3 }],
      ["recount", 2, "coverage", 0],
      ["version", 3, "repair", 1, 0, "not-adopted"],
      ["round", 4, 2, "repair", { kind: "version", version_seq: 5 }],
      ["version", 5, "repair", 2, 2, "adopted"],
      ["recount", 6, "adopted", 5],
    ]);
    const [bad, unmarked] = [await sha256Hex(R4_BAD), await sha256Hex(UNMARK_R1)];
    const events = search["events"] as readonly Json[];
    expect(events[0]?.["violations"]).toEqual(counted(bad, { rej: 2, mis: 3 }));
    expect(events[0]?.["failure_set_sha256"]).toBe(await fingerprint([rej("R1"), rej("R3"), ...R4_CASES.map((testId) => mis(testId, "R4"))]));
    // 網羅の数え直し：SHA は初版と同じで、R4 の試験が棄却されて不一致 3 → 0（拒否 R1・R3 は引き継ぐ）
    expect(events[2]?.["declaration_sha256"]).toBe(bad);
    expect(events[2]?.["violations"]).toEqual(counted(bad, { rej: 2 }));
    expect(events[2]?.["failure_set_sha256"]).toBe(await fingerprint([rej("R1"), rej("R3")]));
    expect(events[2]?.["failure_set_sha256"]).not.toBe(events[0]?.["failure_set_sha256"]);
    // 採用の数え直し：SHA は採った版と同じで、R1 の unmarked を確定へ移して unmarked 1 → 0
    expect(events[5]?.["violations"]).toEqual(counted(unmarked, { unm: 1 }));
    expect(events[5]?.["failure_set_sha256"]).toBe(await fingerprint([unm("R1")]));
    expect(events[6]?.["declaration_sha256"]).toBe(unmarked);
    expect(events[6]?.["violations"]).toEqual(counted(unmarked, {}));
    expect(events[6]?.["failure_set_sha256"]).toBe(await fingerprint([]));
    expect(search["best_seq"]).toBe(6);
    // 親と比べた状態：同じ往復の候補（seq 3）の親は数え直しの前の状態（往復を始めた時点の一番良い状態＝seq 0）で、採否は網羅の数え直し
    // （seq 2）と比べた。数え直しのあとに始まる次の往復の候補（seq 5）の親はその数え直しで、比べた状態も同じ
    expect(events[3]?.["parent_seq"]).toBe(0);
    expect(events[3]?.["compared_seq"]).toBe(2);
    expect(events[3]?.["compared_seq"]).not.toBe(events[3]?.["parent_seq"]);
    expect(events[5]?.["parent_seq"]).toBe(2);
    expect(events[5]?.["compared_seq"]).toBe(2);
    expect(events[0]?.["compared_seq"]).toBeNull();
    checkStructure(record);
    matchesDeliverable(search, (await wholeRun746("recounts", RECOUNTS())).searchFile);
  });

  it("(4) 失敗の集合の指紋：同数で集合の違う不採用の候補の指紋は候補自身の集合の値で一番良い版と違い、静的チェックに落ちた版・B3' を流していない版の違反の全欄と指紋も台本の値。初版だけで終わる走りも同じ", async () => {
    const { record, search } = await stageRun746("sets", SETS());
    if (search === undefined) throw new Error("探索の出来事の列が無い");
    expect(outline(search)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["round", 1, 1, "repair", { kind: "version", version_seq: 2 }],
      ["version", 2, "repair", 1, 0, "not-adopted"],
      ["round", 3, 2, "repair", { kind: "version", version_seq: 4 }],
      ["version", 4, "repair", 2, 0, "not-adopted"],
      ["version", 5, "rewrite", 2, 0, "not-adopted"],
      ["round", 6, 3, "repair", { kind: "version", version_seq: 7 }],
      ["version", 7, "repair", 3, 0, "not-adopted"],
    ]);
    const events = search["events"] as readonly Json[];
    const [good, broken, miss] = [await sha256Hex(V11A_YAML), await sha256Hex(BROKEN), await sha256Hex(MISS)];
    // 同数（1）で集合の違う候補：候補の指紋は候補自身の集合（R1 の拒否）の値で、一番良い版（R3 の拒否）の指紋と違う
    expect(events[0]?.["violations"]).toEqual(counted(good, { rej: 1 }));
    expect(events[2]?.["violations"]).toEqual(counted(good, { rej: 1 }));
    expect(events[0]?.["failure_set_sha256"]).toBe(await fingerprint([rej("R3")]));
    expect(events[2]?.["failure_set_sha256"]).toBe(await fingerprint([rej("R1")]));
    expect(events[2]?.["failure_set_sha256"]).not.toBe(events[0]?.["failure_set_sha256"]);
    // 静的チェックに落ちた版：違反は最悪の種類だけで、失敗の集合は静的チェックの 1 件
    expect(events[4]?.["violations"]).toEqual({ kind: "static-check-failed", declaration_sha256: broken });
    expect(events[4]?.["failure_set_sha256"]).toBe(await fingerprint([["static-check", null, null]]));
    // B3' を流していないので捨てた件数は未実施（0 にしない）
    expect(events[4]?.["discarded"]).toBeNull();
    // B3' を流していない版（B3 で R3 の操作が結び付かない）：拒否・unmarked は不明（null）で和に入れない。R3 の試験 3 本が不一致
    expect(events[5]?.["violations"]).toEqual(counted(miss, { miss: 1, rej: null, unm: null, mis: 3 }, "name-check"));
    expect(events[5]?.["failure_set_sha256"]).toBe(await fingerprint([["correspondence-miss", null, "R3"], ...R3_CASES.map((testId) => mis(testId, "R3"))]));
    expect(events[5]?.["discarded"]).toBeNull();
    expect(events[7]?.["failure_set_sha256"]).toBe(events[0]?.["failure_set_sha256"]);
    checkStructure(record);
    matchesDeliverable(search, (await wholeRun746("sets", SETS())).searchFile);
    // 初版だけで終わる走り：違反は全部 0、失敗の集合は空
    const single = await stageRun746("single", [structured({ declaration: V11A_YAML }), judged(ALL)]);
    expect(outline(single.search as Json)).toEqual([["version", 0, "write", 0, null, "adopted"]]);
    expect((single.search as Json)["events"][0]["violations"]).toEqual(counted(good, {}));
    expect((single.search as Json)["events"][0]["failure_set_sha256"]).toBe(await fingerprint([]));
    expect((single.search as Json)["stop"]).toEqual({ reason: "completed", stage: null, kind: null });
    checkStructure(single.record);
  });

  it("(5) 版を作らない往復：マージを断った往復は往復の出来事だけが増えて結果は断った分類、裁定で Plan に戻した往復も版を作らない。要求の列・停止の順・判定は同じ台本の一気通貫と同じ", async () => {
    const mixed = await stageRun746("mixed", MIXED());
    const search = mixed.search as Json;
    expect(outline(search)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["round", 1, 1, "field-repair", { kind: "refused", refusal: "bytes" }],
      ["round", 2, 2, "field-repair", { kind: "version", version_seq: 4 }],
      ["recount", 3, "coverage", 0],
      ["version", 4, "repair", 2, 0, "not-adopted"],
    ]);
    expect(eventsOf(search, "version")).toHaveLength(2);
    expect(mixed.record["verification"]["round_trips"]).toBe(2);
    const whole = await wholeRun746("mixed", MIXED());
    matchesDeliverable(search, whole.searchFile);
    // 段の走りの要求の列は一気通貫の B1 から先の要求の列と同じ（記録を足しても要求・停止の順・判定は変わらない）
    const wholeTail = whole.run.recording.structured.slice(HEAD_746().length).map((request) => request.schemaName);
    expect(mixed.run.structuredRequests.map((request) => request.schemaName)).toEqual(wholeTail);
    expect(mixed.record["verification"]["stop_reason"]).toBe(whole.run.summary["stop_reason"]);
    expect(mixed.record["stage_judge_verdict"]).toBe(whole.run.summary["verdict"]);
    expect(mixed.run.clientErrors).toEqual([]);
    checkStructure(mixed.record);

    const returned = await stageRun746("returned", RETURNED());
    expect(returned.run.code).toBe(EXIT_RETURN_TO_PLAN);
    expect(outline(returned.search as Json)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["round", 1, 1, "repair", { kind: "return-to-plan" }],
    ]);
    expect((returned.search as Json)["stop"]).toEqual({ reason: "unresolved", stage: null, kind: null });
    checkStructure(returned.record);
    matchesDeliverable(returned.search as Json, (await wholeRun746("returned", RETURNED())).searchFile);
  });

  it("(6) 早期停止：初版の評価の途中・修復の要求の途中・採用の確定（持ち越しの更新）の途中・修復の後の持ち越しで止まる走りは、止まるまでの出来事を出し、未完了の区間が pending・null。探索に入らずに止まった走りは欄を持たない", async () => {
    // 初版の評価の途中（B3' の形の落ち 2 回）
    const firstEval = await stageRun746("stop-first-eval", [structured({ declaration: V11A_YAML }), structured({ judgments: [] }), structured({ judgments: [] })]);
    expect(firstEval.record["stopped"]).toMatchObject({ stage: "decl-check", kind: "malformed" });
    const pendingFirst = (firstEval.search as Json)["events"] as readonly Json[];
    expect(pendingFirst).toHaveLength(1);
    expect(pendingFirst[0]).toMatchObject({ event: "version", origin: "write", adoption: "pending", violations: null, failure_set_sha256: null, discarded: null, evaluate_ms: null, make_ms: 1000 });
    expect(namesIn(firstEval.stages, pendingFirst[0]?.["stage_rows"]["evaluate"])).toEqual(["static-check", "name-check", "decl-check"]);
    expect((firstEval.search as Json)["best_seq"]).toBeNull();
    expect((firstEval.search as Json)["stop"]).toEqual({ reason: "stopped", stage: "decl-check", kind: "malformed" });
    checkStructure(firstEval.record);

    // 修復の要求の途中（直す段の応答が無い）
    const inRepair = await stageRun746("stop-repair", [structured({ declaration: V11A_YAML }), judged(ALL, ["R3"])]);
    expect(inRepair.record["stopped"]).toMatchObject({ stage: "repair" });
    expect(outline(inRepair.search as Json)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["round", 1, 1, "repair", { kind: "repair-stopped" }],
    ]);
    expect((inRepair.search as Json)["events"][1]["duration_ms"]).toBeNull();
    expect((inRepair.search as Json)["best_seq"]).toBe(0);
    checkStructure(inRepair.record);

    // 採用の確定（持ち越しの更新）の途中：全要件を unmarked にした候補を採り、全件持ち越しで止まる
    markedDeclCheck();
    const inCommit = await stageRun746("stop-commit", [structured({ declaration: R4_BAD }), judged(ALL, ["R1", "R3"]), repairTo(`${V11A_YAML}# unmark:R1,R2,R3,R4\n`)]);
    expect(inCommit.record["stopped"]).toMatchObject({ stage: "carry-over", kind: "unmet" });
    expect(outline(inCommit.search as Json)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["round", 1, 1, "repair", { kind: "version", version_seq: 2 }],
      ["version", 2, "repair", 1, 0, "adopted"],
      ["recount", 3, "adopted", 2],
    ]);
    const commitEvents = (inCommit.search as Json)["events"] as readonly Json[];
    expect(commitEvents[3]).toMatchObject({ violations: null, failure_set_sha256: null });
    expect(namesIn(inCommit.stages, commitEvents[3]?.["stage_rows"])).toEqual(["carry-over"]);
    expect(commitEvents[1]?.["duration_ms"]).toBeNull();
    expect((inCommit.search as Json)["best_seq"]).toBe(2);
    checkStructure(inCommit.record);

    // 修復の後の持ち越し：R3 の unmarked を確定へ移したあと、R1 の試験を全部棄却し、網羅の持ち越しが残る行の参照を壊して持ち越しの段で止まる
    // （棄却のあとの網羅の数え直しに届かない）
    const afterRepair = await stageRun746("stop-after-repair", [
      structured({ declaration: `${R4_BAD}# unmark:R3\n# reject:R1\n` }),
      repairTo(R4_BAD, R1_CASES),
      overturn(R1_CASES),
    ]);
    expect(afterRepair.record["stopped"]).toMatchObject({ stage: "carry-over", kind: "unmet" });
    expect(outline(afterRepair.search as Json)).toEqual([
      ["version", 0, "write", 0, null, "adopted"],
      ["recount", 1, "adopted", 0],
      ["round", 2, 1, "repair", { kind: "pending" }],
    ]);
    const afterEvents = (afterRepair.search as Json)["events"] as readonly Json[];
    expect(namesIn(afterRepair.stages, afterEvents[2]?.["stage_rows"])).toEqual(["repair", "arbitration", "coverage", "carry-over"]);
    expect(afterEvents[2]?.["duration_ms"]).toBeNull();
    expect((afterRepair.search as Json)["best_seq"]).toBe(1);
    checkStructure(afterRepair.record);

    // 探索に入らずに止まった走り（B1 の応答が無い）は欄を持たない
    const noSearch = await stageRun746("stop-before-search", []);
    expect(noSearch.record["stopped"]).toMatchObject({ stage: "write" });
    expect(noSearch.record).not.toHaveProperty("search_repair");
  });

  it("(7) 時間：出来事で進める時計で、作る時間・評価する時間・往復の時間が期待のミリ秒になり、段の行の duration_ms は時計から組んだ値のまま", async () => {
    const { record, search } = await stageRun746("time", STAGNATION());
    const events = (search as Json)["events"] as readonly Json[];
    // B1 1000・B3' 200・道具付きの直す段 3000（コードの段は 0）
    expect(events.filter((event) => event["event"] === "version").map((event) => [event["origin"], event["make_ms"], event["evaluate_ms"]])).toEqual([
      ["write", 1000, 200],
      ["repair", 3000, 200],
      ["repair", 3000, 200],
      ["rewrite", 1000, 200],
      ["repair", 3000, 200],
    ]);
    expect(events.filter((event) => event["event"] === "round").map((event) => event["duration_ms"])).toEqual([3200, 3200, 3200]);
    const durations: Record<string, number> = { write: 1000, "decl-check": 200, repair: 3000 };
    for (const stage of record["stages"] as readonly Json[]) expect(stage["duration_ms"], stage["stage"]).toBe(durations[stage["stage"] as string] ?? 0);
    // 網羅の数え直しと裁定を含む往復：直す段 3000・裁定 100・候補の B3' 200
    markedDeclCheck();
    const recounts = await stageRun746("time-recounts", RECOUNTS());
    expect(eventsOf(recounts.search as Json, "round").map((event) => event["duration_ms"])).toEqual([3300, 3000]);
  });

  it("(8) 段の行への対応：同じ SHA の数え直しと版を作らない往復を交ぜた走りで、各出来事の区間が記録の stages の実際の段の位置と一致する", async () => {
    const { record, search } = await stageRun746("rows", MIXED());
    const names = (record["stages"] as readonly Json[]).map((stage) => stage["stage"]);
    expect(names).toEqual([
      "write", "static-check", "name-check", "decl-check", "run-tests",
      "repair",
      "repair", "arbitration", "coverage", "name-check", "run-tests", "static-check", "name-check", "decl-check", "run-tests",
      "judge",
    ]);
    const events = (search as Json)["events"] as readonly Json[];
    expect(events.map((event) => (event["event"] === "version" ? event["stage_rows"] : event["stage_rows"]))).toEqual([
      { make: { first: 0, last: 0 }, evaluate: { first: 1, last: 4 } },
      { first: 5, last: 5 },
      { first: 6, last: 14 },
      { first: 9, last: 10 },
      { make: { first: 6, last: 6 }, evaluate: { first: 11, last: 14 } },
    ]);
    // 網羅の数え直し（seq 3）を挟む往復の候補：親は往復を始めた時点の一番良い状態（seq 0）、比べた状態はその数え直し
    expect([events[4]?.["parent_seq"], events[4]?.["compared_seq"]]).toEqual([0, 3]);
    checkStructure(record);
  });

  /**
   * 不変の比較元（直す前＝99b6478 の工場で同じ試験の台本を流した出力のダイジェスト）。段の走りの記録は search_repair を除いて照らし
   * （直す前の記録は欄を持たない）、ほかのファイル・要求の列・終了コード・1 行の要約はそのまま照らす。一時の場所の名前は目印に置き換える
   */
  const BEFORE_746: Readonly<Record<string, string>> = {
    "stage-stagnation": "055ebe51378e8035e4ea152c509710fc84473c6d954be3d1168cb17b4ced9a1f",
    "stage-adopting": "584eaf3e017350fb46a395f74ac640038a782c7b306b572e7ccbe6890fecd313",
    "stage-sets": "25a22183c57cdbb64fe6b74e699063c6356201a037265d561f2731a1ac437146",
    "stage-mixed": "c49884f9b7a556c4e0c9afd90d1a22f37b5828e44fee9d58399437dbaf5798d4",
    "stage-returned": "7669c971267262ebc921bd61046f1d9e3540a12d3892a48d9508e281b544af78",
    "stage-recounts": "de005c953d91b30fc27a7a24c2d41292be6cabf35242a0525a03804d1bd33252",
    "stage-stop-repair": "4e17820e9cd8415b24850f555bed05d332ce45a3c79eb1d6eedb93ee1a892dac",
    "stage-stop-first-eval": "fd323bfcc9d82f0f102dbf43d9ce14db17bc05cc9b8c0ff84c91939270710948",
    "stage-stop-commit": "ab11a902ec436a60193e2b2b4c5ab3bf4afd6ae88b338dbb74bc042944100909",
    "whole-stagnation": "248017e1b10f1fb414fa90af7f715214a36d0f8c410c49b6d4778f7815673a3c",
    "whole-adopting": "ca3074eb8a238a3337ed16b92892da26b9f5c05f972f84bb5b47244f350038fd",
    "whole-sets": "acd0d9b65dfc66312aff6725add8b10f2af4e3eceed1ff71d499556dd416b499",
    "whole-mixed": "175e38f8f70ca325904c33cad04d27aede2d8cd1005ebef141c9825ab4acf572",
    "whole-recounts": "0a6577566da53468d0b342279fe02ff029c479c5e9a1a231cb55817c81519876",
    "stage-ids-off": "172356f1f7f84c2aeea7d6f47abe3b139a5871b6c6cbfd27d66ed3ac10f0f427",
    "whole-ids-off": "372c315e1984e65654ec20489ac4b2061feb561eb2d4bafef70c09f34adb5ee0",
    "stage-search-repair-off": "5dc5994e2dffc41aab246647e4b9b5d61d281194cf7cfff32d01525c95c311cd",
    "whole-search-repair-off": "b54b883dcc61c988952fbce4d66ff2bc6cdd8174f24d797824d4bde1371875bb",
    "stage-v11a": "a9db8acf6308a96669bf63dba74981c54f99be372b949dee6a1a88da7a5df251",
    "whole-v11a": "fa7fab341848889ac397ac89263840c0618331179e12c35ae6ad63d1015cc7de",
  };
  type FlagsOverride = { readonly ledger: boolean; readonly searchRepair: boolean; readonly ids: boolean } | null;
  const INVARIANT_RUNS: readonly {
    readonly name: string;
    readonly kind: "stage" | "whole";
    readonly pipeline: "v1.1a" | "v1.2";
    readonly flags: FlagsOverride;
    readonly marked?: boolean;
    readonly calls: () => RecordedCall[];
    readonly args?: readonly string[];
  }[] = [
    { name: "stage-stagnation", kind: "stage", pipeline: "v1.2", flags: null, calls: STAGNATION },
    { name: "stage-adopting", kind: "stage", pipeline: "v1.2", flags: null, calls: ADOPTING },
    { name: "stage-sets", kind: "stage", pipeline: "v1.2", flags: null, calls: SETS },
    { name: "stage-mixed", kind: "stage", pipeline: "v1.2", flags: null, calls: MIXED },
    { name: "stage-returned", kind: "stage", pipeline: "v1.2", flags: null, calls: RETURNED },
    { name: "stage-recounts", kind: "stage", pipeline: "v1.2", flags: null, marked: true, calls: RECOUNTS },
    { name: "stage-stop-repair", kind: "stage", pipeline: "v1.2", flags: null, calls: () => [structured({ declaration: V11A_YAML }), judged(ALL, ["R3"])] },
    { name: "stage-stop-first-eval", kind: "stage", pipeline: "v1.2", flags: null, calls: () => [structured({ declaration: V11A_YAML }), structured({ judgments: [] }), structured({ judgments: [] })] },
    { name: "stage-stop-commit", kind: "stage", pipeline: "v1.2", flags: null, marked: true, calls: () => [structured({ declaration: R4_BAD }), judged(ALL, ["R1", "R3"]), repairTo(`${V11A_YAML}# unmark:R1,R2,R3,R4\n`)] },
    { name: "whole-stagnation", kind: "whole", pipeline: "v1.2", flags: null, calls: () => [...HEAD_746(), ...STAGNATION()] },
    { name: "whole-adopting", kind: "whole", pipeline: "v1.2", flags: null, calls: () => [...HEAD_746(), ...ADOPTING()] },
    { name: "whole-sets", kind: "whole", pipeline: "v1.2", flags: null, calls: () => [...HEAD_746(), ...SETS()] },
    { name: "whole-mixed", kind: "whole", pipeline: "v1.2", flags: null, calls: () => [...HEAD_746(), ...MIXED()] },
    { name: "whole-recounts", kind: "whole", pipeline: "v1.2", flags: null, marked: true, calls: () => [...HEAD_746(), ...RECOUNTS()] },
    // ids off の v1.2（探索は流すが出来事の列を積まない）。上流から ⑦ まで
    ...(["stage", "whole"] as const).map((kind) => ({
      name: `${kind}-ids-off`,
      kind,
      pipeline: "v1.2" as const,
      flags: { ledger: true, searchRepair: true, ids: false },
      args: ["--stage-end", "judge"],
      calls: (): RecordedCall[] => [
        structured(v11aT1(true)), structured(v11aJudgments()), structured(v11aTestSpec()),
        structured({ declaration: V11A_YAML }), structured(v11aJudgments(V11A_REJECT_R3)),
        v11aRepairDone(), structured(v11aJudgments(V11A_REJECT_R3)),
        v11aRepairDone(), structured(v11aJudgments(V11A_REJECT_R3)),
        structured({ declaration: V11A_YAML }), structured(v11aJudgments(V11A_REJECT_R3)),
        v11aRepairDone(), structured(v11aJudgments(V11A_REJECT_R3)),
      ],
    })),
    // search-repair off の v1.2（今のループ）。上流から ⑦ まで
    ...(["stage", "whole"] as const).map((kind) => ({
      name: `${kind}-search-repair-off`,
      kind,
      pipeline: "v1.2" as const,
      flags: { ledger: true, searchRepair: false, ids: true },
      args: ["--stage-start", "vocabulary", "--stage-end", "judge"],
      calls: (): RecordedCall[] => [...HEAD_746(), structured({ declaration: V11A_YAML }), judged(ALL, ["R3"]), repairTo(V11A_YAML), judged(ALL, ["R3"])],
    })),
    // v1.1a（旗なし）。上流から ⑦ まで
    { name: "stage-v11a", kind: "stage", pipeline: "v1.1a", flags: null, args: [], calls: v11aStagnation },
    { name: "whole-v11a", kind: "whole", pipeline: "v1.1a", flags: null, calls: v11aStagnation },
  ];
  /** 1 つの走りの出力のダイジェスト（書いたファイル・要求の列・終了コード・1 行の要約）と、段の走りの記録が search_repair を持つか */
  async function invariantDigest(entry: (typeof INVARIANT_RUNS)[number]): Promise<{ readonly digest: string; readonly hasSearch: boolean }> {
    if (entry.flags !== null) {
      const flags = entry.flags;
      vi.spyOn(ledgerModule, "fromPublicV12Flags").mockImplementation(() => flags);
    }
    if (entry.marked === true) markedDeclCheck();
    const dir = `${directory}/sr746-inv-${entry.name}`;
    let written: readonly string[];
    let requests: unknown;
    let code: number;
    let line: string;
    if (entry.kind === "stage") {
      const args = entry.args ?? ["--stage-start", "write", "--stage-input", checkpoint746];
      const run = await runStageCli({ dir, args, calls: entry.calls(), pipeline: entry.pipeline, clock: eventClock() });
      ({ written, code } = run);
      requests = run.requests;
      line = run.lines.at(-1) ?? "";
    } else {
      const run = await runV11aCli({ dir, calls: entry.calls(), pipeline: entry.pipeline });
      ({ written, code } = run);
      requests = {
        structured: run.recording.structured.map(({ signal: _signal, ...rest }) => rest),
        tools: run.recording.tools.map(({ signal: _signal, ...rest }) => rest),
      };
      line = JSON.stringify(run.summary);
    }
    vi.restoreAllMocks();
    let hasSearch = false;
    const files: [string, string][] = [];
    for (const path of [...written].sort()) {
      let text = (await fs.readFile(`${dir}/${path}`, "utf8")).replaceAll(directory, "<tmp>");
      if (path === STAGE_RUN_RECORD_FILE) {
        const record = JSON.parse(text) as Json;
        hasSearch = "search_repair" in record;
        delete record["search_repair"];
        text = stageJsonText(record);
      }
      files.push([path, await sha256Hex(text)]);
    }
    const body = JSON.stringify({ files, requests, code, line }).replaceAll(directory, "<tmp>");
    return { digest: await sha256Hex(body), hasSearch };
  }

  it("不変：v1・v1.1a・ids off の v1.2・search-repair off の走りと、ids on・search-repair on の一気通貫・段の走り（search_repair を除く）の全出力が直す前（99b6478）とバイト列で同じ。欄を持つのは ids on・search-repair on の段の走りで探索に入ったものだけ", async () => {
    const digests: Record<string, string> = {};
    const searched: Record<string, boolean> = {};
    for (const entry of INVARIANT_RUNS) {
      const { digest, hasSearch } = await invariantDigest(entry);
      digests[entry.name] = digest;
      searched[entry.name] = hasSearch;
    }
    expect(digests).toEqual(BEFORE_746);
    for (const entry of INVARIANT_RUNS) {
      expect(searched[entry.name], entry.name).toBe(entry.kind === "stage" && entry.flags === null && entry.pipeline === "v1.2");
    }
  });

  /** 出来事の列に出てよい文字列（列挙値と SHA-256 だけ）と鍵 */
  const ALLOWED_STRINGS = new Set<string>([
    "version", "recount", "round", "write", "repair", "rewrite", "field-repair", "adopted", "not-adopted", "pending", "coverage",
    "counted", "static-check-failed", "static-check", "name-check", "exhausted", "refused", "return-to-plan", "repair-stopped",
    ...Object.keys(MERGE_REFUSALS), "completed", "stagnation", "limit", "unresolved", "deadline", "stopped", ...STAGE_IDS, ...FAILURE_KINDS,
  ]);
  const ALLOWED_KEYS = new Set<string>([
    "events", "best_seq", "rewritten", "stop", "reason", "stage", "kind", "seq", "event", "origin", "round", "declaration_sha256", "parent_seq",
    "violations", "breakdown", "correspondence-miss", "decl-rejection", "decl-unmarked", "test-mismatch", "test-unresolved", "known_total", "unknown",
    "compared_seq", "failure_set_sha256", "adoption", "discarded", "unmarked", "rejections", "make_ms", "evaluate_ms", "stage_rows", "make", "evaluate", "first", "last",
    "cause", "before_seq", "hand", "locations", "unlocated", "additions", "result", "version_seq", "refusal", "duration_ms",
  ]);
  function walk(value: unknown, visit: (key: string | null, leaf: unknown) => void): void {
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        visit(key, undefined);
        walk(inner, visit);
      }
    } else visit(null, value);
  }

  it("(9) 漏えい：要件 ID・試験 ID・要件の文・引用・失敗の文・例外の文（止まった問題の文）を番兵にした走りで、search_repair のどこにも番兵が無く、文字列は列挙値と SHA-256 だけ。記録に題材の言葉が無い", async () => {
    markedDeclCheck();
    const runs = [
      await stageRun746("leak-stagnation", STAGNATION()),
      await stageRun746("leak-recounts", RECOUNTS()),
      await stageRun746("leak-sets", SETS()),
      await stageRun746("leak-mixed", MIXED()),
      await stageRun746("leak-returned", RETURNED()),
      await stageRun746("leak-stop", [structured({ declaration: V11A_YAML }), structured({ judgments: [] }), structured({ judgments: [] })]),
    ];
    for (const { record, text } of runs) {
      const search = record["search_repair"] as Json;
      const sentinels = [
        ...ALL,
        "case:",
        ...V11A_BASE_LIST.requirements.flatMap((requirement) => [requirement.text, requirement.quote]),
        QUOTE_746,
        "期待が誤り",
        ...Object.values(MERGE_REFUSALS),
        ...Object.values(NAMED_FAILURE_MESSAGES),
        ...((record["stopped"]?.["problems"] ?? []) as readonly Json[]).map((problem) => problem["message"] as string),
      ].filter((sentinel) => sentinel !== "");
      const serialized = JSON.stringify(search);
      for (const sentinel of sentinels) expect(serialized, sentinel).not.toContain(sentinel);
      walk(search, (key, leaf) => {
        if (key !== null) expect(ALLOWED_KEYS.has(key), key).toBe(true);
        else if (typeof leaf === "string") expect(ALLOWED_STRINGS.has(leaf) || /^[0-9a-f]{64}$/u.test(leaf), leaf).toBe(true);
        else expect(leaf === null || typeof leaf === "number" || typeof leaf === "boolean", String(leaf)).toBe(true);
      });
      expectNoAcceptanceMaterial([text]);
    }
    // 早期停止の問題の文は記録の既存の欄（stopped）にあるが、search_repair には無い
    const stopped = runs.at(-1)?.record["stopped"] as Json;
    expect((stopped["problems"] as readonly unknown[]).length).toBeGreaterThan(0);
  });
});
