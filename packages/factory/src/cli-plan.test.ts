// Plan → Build の手元の入口（cli-plan.ts・cli.ts）の unit テスト（04-plan-agent.md §7・Issue #336）。
//
// **偽物の LLM・偽物の判定・偽物の端末で回す。本物の API も本物の端末も触らない。** ここで固定したいのは
// 4 つ（Issue #336 の完了条件）。
//   1. 偽物の端末で、番号・「推奨で決める」・自由入力を受け取って、確定まで進む
//   2. 答えのファイルの形で、足りない質問を推奨で埋めて確定する
//   3. 確定した仕様が生成の `plan` に渡り、Build の予算が全体から Plan の使った額を引いた残りになる
//   4. 確定できないときは Build を流さず、0 でない終了コードになる
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { API_KEY_ENV, EXIT_RUN_FAILED, parseCliArguments, runCli } from "./cli.js";
import * as runModule from "./run.js";
import {
  FREE_TEXT_INPUT,
  PLAN_CLI_RECORD_FILE,
  RECOMMENDED_INPUT,
  createAnswersFilePlanResponder,
  createInteractivePlanResponder,
  createPlanTranscript,
  parsePlanAnswers,
  type Terminal,
} from "./cli-plan.js";
import { createFakeJudge } from "./judge-fake.js";
import type { JudgeAnswer } from "./judge.js";
import { CATALOG_FACETS, catalogAppliesQuestionName, catalogQuestionName } from "./plan/catalog.js";
import { confirmQuestionName } from "./plan/confirm.js";
import { freeTextQuestionName } from "./plan/answers.js";
import {
  createRecordingClient,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  SOURCE_TEXT,
} from "./stages/__tests__/prompt.js";
import { recordedRunFromPlan, structured } from "./__tests__/run.js";

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
  directory = await fs.mkdtemp(`${os.tmpdir()}/factory-cli-plan-`);
});

afterAll(async () => {
  if (directory !== "") await fs.rm(directory, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 題材（偽物の LLM に再生させる応答・偽物の判定の答え・偽物の端末）────────────

const noul = (value: number): JudgeAnswer => ({ kind: "noul", noul: value });

/** 目録の問い（要件 × 観点 × 2 問）すべてに「当てはまる・決まっている」を返す答え（未指定の観点を作らない） */
function catalogAnswers(): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {};
  for (const requirementId of ["R-1", "R-2"]) {
    for (const facet of CATALOG_FACETS) {
      answers[catalogAppliesQuestionName(requirementId, facet.id)] = noul(1);
      answers[catalogQuestionName(requirementId, facet.id)] = noul(1);
    }
  }
  return answers;
}

/** 覆いの問い（原文の文と、答え）に「覆われている」を返す答え */
function coverAnswers(answerIds: readonly string[]): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {
    [confirmQuestionName("S-1")]: noul(0.95),
    [confirmQuestionName("S-2")]: noul(0.95),
  };
  for (const answerId of answerIds) answers[confirmQuestionName(answerId)] = noul(0.9);
  return answers;
}

/** 目録に無い曖昧さ 3 件（重大）。3 問を出し、番号・推奨・自由入力を試せるようにする */
const SURFACE_THREE = {
  ambiguities: [
    { id: "OI-1", requirementId: "R-1", text: "誰の分を数えるか", critical: true },
    { id: "OI-2", requirementId: "R-1", text: "いつの分を数えるか", critical: true },
    { id: "OI-3", requirementId: "R-2", text: "合計の丸め方", critical: true },
  ],
  unwritable: [],
};

/** P4 の答え（未解決の事項 3 つに、選択肢 2 つ・推奨 1 つ・自由入力） */
const QUESTIONS_THREE = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI-1",
      text: "誰の分を数えますか",
      choices: [
        { id: "c1", text: "全員" },
        { id: "c2", text: "自分のみ" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
    {
      id: "Q-2",
      openIssueId: "OI-2",
      text: "いつの分を数えますか",
      choices: [
        { id: "c1", text: "今日" },
        { id: "c2", text: "今週" },
      ],
      recommended: { choiceId: "c2", reason: "広く見る" },
      allowFreeText: true,
    },
    {
      id: "Q-3",
      openIssueId: "OI-3",
      text: "合計はどう丸めますか",
      choices: [
        { id: "c1", text: "切り捨て" },
        { id: "c2", text: "四捨五入" },
      ],
      recommended: { choiceId: "c1", reason: "素直" },
      allowFreeText: true,
    },
  ],
};

/** Plan の 4 段と、確定した仕様から流す Build の記録をつないだもの */
function planThenBuildRecording(): ReturnType<typeof createRecordingClient> {
  return createRecordingClient([
    structured(REQUIREMENT_LIST_OUTPUT),
    structured(REVERSE_CHECK_OUTPUT),
    structured(SURFACE_THREE),
    structured(QUESTIONS_THREE),
    ...recordedRunFromPlan(),
  ]);
}

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

/** 偽物の端末（決めた順に 1 行ずつ返し、出した行を残す） */
interface FakeTerminal extends Terminal {
  readonly out: readonly string[];
}

function fakeTerminal(lines: readonly string[]): FakeTerminal {
  const queue = [...lines];
  const out: string[] = [];
  return {
    out,
    write: (line: string) => {
      out.push(line);
    },
    readLine: async () => queue.shift(),
  };
}

interface PlanCliRecordShape {
  readonly outcome: string;
  readonly confirmation: string | null;
  readonly rounds: readonly {
    readonly answers: readonly {
      readonly id: string;
      readonly choice_id: string | null;
      readonly free_text: string | null;
    }[];
  }[];
  readonly spent_usd: number;
  readonly remaining_usd: number;
}

async function readPlanRecord(dir: string): Promise<PlanCliRecordShape> {
  return JSON.parse(await fs.readFile(`${dir}/${PLAN_CLI_RECORD_FILE}`, "utf8")) as PlanCliRecordShape;
}

// ── 引数の読み取り（--plan・--answers）─────────────────────────────

describe("--plan・--answers の読み取り（04 §7・Issue #336）", () => {
  it("--plan を付けると plan が真になる（--plan 無しの今の使い方は変わらない）", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out"])).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
    });
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--plan"])).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      plan: true,
    });
    expect(
      parseCliArguments(["--", "request.txt", "--out", "out", "--plan", "--answers", "answers.json"]),
    ).toEqual({
      requestFile: "request.txt",
      outDir: "out",
      model: "gpt-6-luna",
      effort: "high",
      plan: true,
      answersFile: "answers.json",
    });
  });

  it("--answers は --plan と一緒でなければ誤り", () => {
    expect(parseCliArguments(["--", "request.txt", "--out", "out", "--answers", "answers.json"])).toEqual({
      error: "--answers は --plan と一緒に指定してください",
    });
  });
});

// ── 答えのファイルの読取り ───────────────────────────────────────

describe("答えのファイルの読取り（04 §7）", () => {
  it("質問 ID → 選択肢 ID か自由入力の写像を読む", () => {
    expect(parsePlanAnswers('{"Q-1":"c1","Q-2":{"freeText":"全員で数える"}}')).toEqual({
      "Q-1": { choiceId: "c1" },
      "Q-2": { freeText: "全員で数える" },
    });
  });

  it("JSON でない・選択肢 ID と自由入力の両方を持つ・空の選択肢は誤り", () => {
    expect(parsePlanAnswers("ない")).toEqual({ error: "答えのファイルが JSON として読めません" });
    expect(parsePlanAnswers('{"Q-1":{"choiceId":"c1","freeText":"x"}}')).toEqual({
      error: "Q-1: 選択肢 ID（choiceId）か自由入力（freeText）のちょうど一方を書いてください",
    });
    expect(parsePlanAnswers('{"Q-1":""}')).toEqual({ error: "Q-1: 選択肢 ID が空です" });
  });
});

// ── 答える役の 2 つの形（単体。偽物の端末で確かめる）────────────────

describe("答える役の 2 つの形（04 §7）", () => {
  it("対話の形は、番号・推奨で決める・自由入力を答えに写す", async () => {
    const transcript = createPlanTranscript();
    const terminal = fakeTerminal(["1", RECOMMENDED_INPUT, FREE_TEXT_INPUT, "全員で数える"]);
    const responder = createInteractivePlanResponder(terminal, transcript);
    const questions = [
      { id: "Q-1", openIssueId: "OI-1", revision: 1, text: "?", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }], recommended: { choiceId: "c2", reason: "r" }, allowFreeText: true },
      { id: "Q-2", openIssueId: "OI-2", revision: 1, text: "?", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }], recommended: { choiceId: "c2", reason: "r" }, allowFreeText: true },
      { id: "Q-3", openIssueId: "OI-3", revision: 1, text: "?", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }], recommended: { choiceId: "c1", reason: "r" }, allowFreeText: true },
    ];

    const outcome = await responder.answer({ questions, remaining: { questions: 7, roundTrips: 2 } });

    expect(outcome).toEqual({
      kind: "answers",
      answers: [
        { id: "A:Q-1", questionId: "Q-1", revision: 1, choiceId: "c1" },
        { id: "A:Q-2", questionId: "Q-2", revision: 1, choiceId: "c2" },
        { id: "A:Q-3", questionId: "Q-3", revision: 1, freeText: "全員で数える" },
      ],
    });
    // 画面には推奨の印と「推奨で決める」が出ている
    expect(terminal.out.some((line) => line.includes("（推奨）"))).toBe(true);
    expect(terminal.out.some((line) => line.includes(RECOMMENDED_INPUT))).toBe(true);
  });

  it("答えのファイルの形は、足りない質問を推奨で埋める", async () => {
    const transcript = createPlanTranscript();
    const responder = createAnswersFilePlanResponder({ "Q-1": { choiceId: "c2" } }, transcript);
    const questions = [
      { id: "Q-1", openIssueId: "OI-1", revision: 1, text: "?", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }], recommended: { choiceId: "c1", reason: "r" }, allowFreeText: true },
      { id: "Q-2", openIssueId: "OI-2", revision: 1, text: "?", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }], recommended: { choiceId: "c2", reason: "r" }, allowFreeText: true },
    ];

    const outcome = await responder.answer({ questions, remaining: { questions: 8, roundTrips: 2 } });

    expect(outcome).toEqual({
      kind: "answers",
      answers: [
        { id: "A:Q-1", questionId: "Q-1", revision: 1, choiceId: "c2" },
        { id: "A:Q-2", questionId: "Q-2", revision: 1, choiceId: "c2" },
      ],
    });
    // 確認は自動で「これで作る」
    expect(await responder.confirm({ plan: { schema_version: "x", plan_id: "p", revision: 1, vocabulary_version: "v1", inputs: [], requirements: [], open_issues: [], decisions: [], accepted_unwritable: [] }, diff: [], unwritable: [] })).toBe("build");
    expect(transcript.confirmation).toBe("build");
  });
});

// ── 端末から確定まで（番号・推奨で決める・自由入力）──────────────────

describe("偽物の端末で、番号・推奨で決める・自由入力を受け取って確定まで進む（04 §2・§7）", () => {
  it("3 問に答えて確定し、確定した仕様が Build に渡る", async () => {
    const recording = planThenBuildRecording();
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q-1", "A:Q-2", "A:Q-3"]),
      [freeTextQuestionName("A:Q-3")]: {
        kind: "choice",
        choice: "new-requirement",
        probabilities: undefined,
        probability: undefined,
        confidence: 0.9,
      },
    });
    const terminal = fakeTerminal(["1", RECOMMENDED_INPUT, FREE_TEXT_INPUT, "全員で数える", "これで作る"]);
    const dir = `${directory}/interactive`;
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      terminal,
      log: () => {},
    });

    // 確定した仕様が生成の入力（plan）として渡る＝Plan が確定して Build が始まった
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]?.[0];
    expect(call?.plan).toBeDefined();
    expect(call?.plan?.plan_id).toBe("local-plan-0");

    // 往復の記録が --out に置かれ、3 つの答え（番号・推奨・自由入力）が残る
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("confirmed");
    expect(record.confirmation).toBe("build");
    const answers = record.rounds.flatMap((round) => round.answers);
    expect(answers.map((answer) => answer.choice_id ?? answer.free_text)).toEqual(["c1", "c2", "全員で数える"]);
  });
});

// ── 答えのファイルの形で確定まで ────────────────────────────────

describe("答えのファイルの形で、足りない質問を推奨で埋めて確定する（04 §7）", () => {
  it("1 問だけ答えて、残りは推奨で埋めて確定し、Build の予算は全体から Plan の使った額を引いた残りになる", async () => {
    const recording = planThenBuildRecording();
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q-1", "A:Q-2", "A:Q-3"]),
    });
    const dir = `${directory}/answers`;
    const answersPath = "answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--budget", "0.3"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({ "Q-1": { choiceId: "c1" } }) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("confirmed");
    // 答えた Q-1（c1）と、推奨で埋めた Q-2（c2）・Q-3（c1）
    const answers = record.rounds.flatMap((round) => round.answers);
    expect(answers.map((answer) => answer.choice_id)).toEqual(["c1", "c2", "c1"]);

    // 確定した仕様が生成の plan に渡り、予算が「全体（0.3）− Plan の使った額」になる
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]?.[0];
    expect(call?.plan).toBeDefined();
    expect(call?.budgetUsd).toBeCloseTo(record.remaining_usd, 10);
    expect(call?.budgetUsd).toBeCloseTo(0.3 - record.spent_usd, 10);
  });
});

// ── 確定できないとき ─────────────────────────────────────────────

describe("確定できないときは Build を流さず、0 でない終了コードになる（04 §2・§7）", () => {
  it("答えがどれも受け付けられなければ、上限まで往復して確定できない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured(QUESTIONS_THREE),
      structured(QUESTIONS_THREE),
      structured(QUESTIONS_THREE),
    ]);
    const judge = createFakeJudge(catalogAnswers());
    const dir = `${directory}/cannot-confirm`;
    const answersPath = "bad-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) =>
        path === answersPath
          ? JSON.stringify({ "Q-1": { choiceId: "nope" }, "Q-2": { choiceId: "nope" }, "Q-3": { choiceId: "nope" } })
          : SOURCE_TEXT,
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    // Build は流さない
    expect(spy).not.toHaveBeenCalled();
    // 往復の記録は残る（確定していない）
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("cannot-confirm");
  });
});
