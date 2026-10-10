// 手元の入口（cli.ts）の unit テスト（02 §3.2）。
//
// ここで固定したいのは 3 つ。
//   1. 鍵が無いときに **API を呼ばずに**使い方の誤り（終了コード 2）で終わること
//   2. 引数が足りないときも、使い方の誤りで終わること
//   3. 偽物を差し込んで 1 回の生成を流し、**ディレクトリに納品物を書く**こと
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  API_KEY_ENV,
  DEFAULT_BUDGET_USD,
  DEFAULT_DEADLINE_MS,
  EXIT_OK,
  EXIT_RUN_FAILED,
  EXIT_USAGE,
  JEV_API_KEY_ENV,
  parseCliArguments,
  runCli,
} from "./cli.js";
import { BUNDLE_MANIFEST_FILE } from "./bundle.js";
import * as runModule from "./run.js";
import type { Judge, JudgeRequest } from "./judge.js";
import type { LlmClient, LlmStructuredRequest, LlmStructuredResponse, LlmToolResponse } from "./llm.js";
import { createRecordingClient } from "./stages/__tests__/prompt.js";
import { SOURCE_TEXT, recordedRun } from "./__tests__/run.js";

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
    const code = await runCli({
      argv: ["--", "request.txt", "--out", directory],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_OK);
    const manifest = JSON.parse(await fs.readFile(`${directory}/${BUNDLE_MANIFEST_FILE}`, "utf8")) as {
      files: readonly { path: string }[];
    };
    expect(manifest.files.map((file) => file.path)).toContain("artifacts/app.spec.yaml");
    for (const file of manifest.files) {
      expect(await fs.readFile(`${directory}/${file.path}`, "utf8")).not.toBe("");
    }

    const last = lines.at(-1) ?? "";
    const summary = JSON.parse(last) as { schema_version: string; verdict: string };
    expect(summary.schema_version).toBe("commandagent.headless-summary/v1");
    expect(summary.verdict).toBe("full");
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
