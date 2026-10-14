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
  AUTO_BUILD_LINE,
  FREE_TEXT_INPUT,
  PLAN_CLI_RECORD_FILE,
  PLAN_CLI_RECORD_SCHEMA,
  PLAN_SURFACE_CHECK_FILE,
  RECOMMENDED_INPUT,
  createAnswersFilePlanResponder,
  createInteractivePlanResponder,
  createPlanTranscript,
  parsePlanAnswers,
  type Terminal,
} from "./cli-plan.js";
import { createFakeJudge } from "./judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest, JudgeResponse } from "./judge.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmUsage,
} from "./llm.js";
import type { RecordedCall } from "./llm-fake.js";
import {
  CATALOG_FACETS,
  catalogAppliesQuestionName,
  catalogGateQuestionName,
  catalogQuestionName,
} from "./plan/catalog.js";
import { confirmQuestionName } from "./plan/confirm.js";
import { freeTextQuestionName } from "./plan/answers.js";
import {
  SURFACE_RECHECK_NO_EVIDENCE,
  surfaceRecheckEvidenceQuestionName,
  surfaceRecheckKindQuestionName,
  surfaceSupportQuestionName,
  surfaceTriageQuestionName,
} from "./plan/surface-check.js";
import {
  createRecordingClient,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  SAMPLE_DOCUMENTS,
  SOURCE_TEXT,
} from "./stages/__tests__/prompt.js";
import { ATTEMPT_KEYS, RETRY_KEYS } from "./record.js";
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

/** choice の答えを作る（確信度は任意） */
function choice(value: string, confidence?: number): JudgeAnswer {
  return { kind: "choice", choice: value, probabilities: undefined, probability: undefined, confidence };
}

/**
 * 目録の問い（要件ごとの門 + 要件 × 観点 × 2 問）すべてに「当てはまる・決まっている」を返す答え
 * （未指定の観点を作らない）。門にも答える（Issue #384）。**差分点検で増える要件の ID も含める**
 * （Issue #434。余分な答えは無害）。
 */
function catalogAnswers(): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {};
  for (const requirementId of ["R-1", "R-2", "R:A:Q1-1", "R:A:Q1-2", "R:A:Q1-3", "R:A:Q2-1"]) {
    answers[catalogGateQuestionName(requirementId)] = noul(1);
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

/**
 * 目録の答え（Issue #408）。指定した要件の、指定した観点だけを「決まっていない」にし、ほかは
 * 「決まっている」にする。門は既定で「集計を含む」（1）。
 */
function catalogUnspecifiedFor(
  unspecified: Readonly<Record<string, readonly string[]>>,
  requirementIds: readonly string[] = ["R-1", "R-2"],
): Record<string, JudgeAnswer> {
  const answers: Record<string, JudgeAnswer> = {};
  for (const requirementId of requirementIds) {
    answers[catalogGateQuestionName(requirementId)] = noul(1);
    const open = new Set(unspecified[requirementId] ?? []);
    for (const facet of CATALOG_FACETS) {
      answers[catalogAppliesQuestionName(requirementId, facet.id)] = noul(1);
      answers[catalogQuestionName(requirementId, facet.id)] = noul(open.has(facet.id) ? 0 : 1);
    }
  }
  return answers;
}

/** 曖昧さ 0 件の P3 の答え */
const SURFACE_CLEAR = { ambiguities: [], unwritable: [] };

/** 対象外の参照が無いときの、差分点検の記録の `out_of_scope`（Issue #434） */
const NO_CLI_OUT_OF_SCOPE = {
  scanned: true,
  claims: 0,
  ambiguities: 0,
  deduped: 0,
  rejected_claims: 0,
  rejected_ambiguities: 0,
  kinds: [
    { kind: "source", claims: 0, ambiguities: 0 },
    { kind: "previous-answer", claims: 0, ambiguities: 0 },
    { kind: "alternative", claims: 0, ambiguities: 0 },
    { kind: "unknown", claims: 0, ambiguities: 0 },
    { kind: "unclassified", claims: 0, ambiguities: 0 },
  ],
  deduped_indexes: [],
};

/** 差分点検の記録の `inherit`（引き継ぎの件数。Issue #461）を、指定した件数で作る */
function cliInherit(
  overrides: {
    no_parent?: number;
    multiple_parents?: number;
    open_by_source?: Partial<Record<"catalog" | "surface" | "surface-check", number>>;
  } = {},
) {
  return {
    facets: [],
    no_parent: overrides.no_parent ?? 0,
    multiple_parents: overrides.multiple_parents ?? 0,
    unresolved: [
      { kind: "missing", count: 0 },
      { kind: "multiple", count: 0 },
      { kind: "mismatch", count: 0 },
    ],
    open_by_source: (["catalog", "surface", "surface-check"] as const).map((source) => ({
      source,
      count: overrides.open_by_source?.[source] ?? 0,
    })),
  };
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
    // 差分点検（その往復で増えた要件だけ）の P3 の応答（Issue #434）
    structured(SURFACE_CLEAR),
    ...recordedRunFromPlan(),
  ]);
}

/** 同じことを聞く重大な事項 2 件（Issue #370） */
const GROUPED_SURFACE_TWO = {
  ambiguities: [
    { id: "OI-1", requirementId: "R-1", text: "誰の分を数えるか", critical: true },
    { id: "OI-2", requirementId: "R-1", text: "誰の分を数えるか（同じ問い）", critical: true },
  ],
  unwritable: [],
};

/** 2 件を 1 問で閉じる P4 の答え（主の OI-1 と、一緒に閉じる OI-2。Issue #370） */
const GROUPED_QUESTIONS_ONE = {
  questions: [
    {
      id: "Q-1",
      openIssueId: "OI-1",
      alsoCloses: ["OI-2"],
      text: "誰の分を数えますか",
      choices: [
        { id: "c1", text: "全員" },
        { id: "c2", text: "自分のみ" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    },
  ],
};

/** 依頼文で決まっている事項 1 件（Issue #370） */
const SOURCE_CLOSURE_SURFACE_ONE = {
  ambiguities: [{ id: "OI-1", requirementId: "R-1", text: "誰の分を数えるか", critical: true }],
  unwritable: [],
};

/** 依頼文の引用で、唯一の事項を聞かずに閉じる P4 の答え（Issue #370） */
const SOURCE_CLOSURE_ONE = {
  questions: [],
  closedBySource: [{ issueId: "OI-1", quote: "タスクを記録する", value: "記録する内容を 1 行にする" }],
};

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
  readonly schema_version: string;
  readonly outcome: string;
  readonly confirmation: string | null;
  readonly rounds: readonly {
    readonly questions: readonly {
      readonly id: string;
      readonly open_issue_id: string;
      readonly revision: number;
      readonly also_closes: readonly string[];
    }[];
    readonly answers: readonly {
      readonly id: string;
      readonly choice_id: string | null;
      readonly free_text: string | null;
    }[];
  }[];
  readonly closed_by_source: readonly {
    readonly issue_id: string;
    readonly quote: string;
    readonly value: string;
  }[];
  /** 既定で閉じた事項（事項 ID・観点 ID・値。Issue #408） */
  readonly closed_by_default: readonly {
    readonly issue_id: string;
    readonly facet_id: string;
    readonly value: string;
  }[];
  /** P1/P2 の往復ごとの逆照合の落ちの内訳（種類ごと・出どころごと。Issue #430） */
  readonly requirements_diagnosis: {
    readonly rounds: readonly {
      readonly misses: {
        readonly quote_not_found: number;
        readonly position_mismatch: number;
        readonly uncovered_source: { readonly code: number; readonly conversation: number };
      };
      readonly dropped_blank_misses: number;
    }[];
    readonly redone: boolean;
    readonly unmet: {
      readonly quote_not_found: number;
      readonly position_mismatch: number;
      readonly uncovered_source: { readonly code: number; readonly conversation: number };
    };
  };
  /** P3 の「書けない」の申告の点検（件数と判定の記録。Issue #432） */
  readonly surface_check: {
    readonly accepted: number;
    readonly dropped: number;
    readonly ambiguity: number;
    readonly unchecked: number;
    readonly completed: boolean;
    readonly judgments: readonly {
      readonly check: number;
      readonly question_id: string;
      readonly answer: string;
      readonly confidence: number | null;
      readonly model: string;
      readonly answered_by: string;
    }[];
  };
  /** 差分点検（各往復の P5 のあと）の記録。値ではなく件数だけ（Issue #434） */
  readonly diff_reviews: readonly {
    readonly round: number;
    readonly added: number;
    readonly open_issues: number;
    readonly accepted_unwritable: number;
    readonly out_of_scope: {
      readonly scanned: boolean;
      readonly claims: number;
      readonly ambiguities: number;
      readonly deduped: number;
      readonly rejected_claims: number;
      readonly rejected_ambiguities: number;
      readonly kinds: readonly { readonly kind: string; readonly claims: number; readonly ambiguities: number }[];
      readonly deduped_indexes: readonly number[];
    };
    /** 引き継いだ観点の記録（件数と有限の分類だけ。Issue #461） */
    readonly inherit: {
      readonly facets: readonly { readonly kind: string; readonly facet_id: string; readonly count: number }[];
      readonly no_parent: number;
      readonly multiple_parents: number;
      readonly unresolved: readonly { readonly kind: string; readonly count: number }[];
      readonly open_by_source: readonly { readonly source: string; readonly count: number }[];
    };
  }[];
  /** 同じ ID の開いている事項の行の衝突の記録（件数と分類と版だけ。Issue #460・#464） */
  readonly open_issue_conflicts: {
    readonly ids: number;
    readonly rows: readonly { readonly existing: string; readonly added: string; readonly count: number }[];
    readonly attribution: readonly {
      readonly first: { readonly origin: string; readonly status: string; readonly current: boolean };
      readonly second: { readonly origin: string; readonly status: string; readonly current: boolean };
      readonly count: number;
    }[];
    readonly empty_targets: number;
    readonly round: number | null;
  };
  /** 使い回しで断った応答の記録（版・試行・応答の数・異なる数・提示元ごとの数。値は入れない。Issue #464） */
  readonly surface_id_reuse: readonly {
    readonly check: number;
    readonly attempt: number;
    readonly responses: number;
    readonly distinct_ids: number;
    readonly by_source: readonly { readonly source: string; readonly count: number }[];
  }[];
  readonly spent_usd: number;
  readonly remaining_usd: number;
  readonly budget_usd: number;
  /** 段ごとの記録（試行の終端と再試行の数を含む。Issue #446） */
  readonly stages: readonly {
    readonly stage: string;
    readonly attempts: object;
    readonly retries: object;
  }[];
  /** 段の失敗の診断（止まったときだけ。Issue #397） */
  readonly failure?: {
    readonly stage: string;
    readonly kind: string;
    readonly problems?: readonly { readonly field: string; readonly code: string }[];
    readonly operation?: string;
  } | null;
  /** 確定できなかった理由（確定できないときだけ。Issue #397） */
  readonly cannot_confirm?: readonly {
    readonly source: string;
    readonly code: string;
    readonly path: string;
  }[];
}

async function readPlanRecord(dir: string): Promise<PlanCliRecordShape> {
  return JSON.parse(await fs.readFile(`${dir}/${PLAN_CLI_RECORD_FILE}`, "utf8")) as PlanCliRecordShape;
}

/** 別ファイルの診断（`plan-surface-check.json`。Issue #432） */
interface PlanSurfaceCheckShape {
  readonly schema_version: string;
  readonly plan_id: string;
  readonly claims: readonly {
    readonly check: number;
    readonly index: number;
    readonly requirement_id: string;
    readonly part: string;
    readonly reason: string;
    readonly constraint_ids: readonly string[];
    readonly doc_version: string;
    readonly stage: string;
    readonly classification: string;
    readonly adapter: string;
    readonly confidence: number | null;
    readonly evidence_id: string | null;
  }[];
}

async function readSurfaceCheck(dir: string): Promise<PlanSurfaceCheckShape> {
  return JSON.parse(await fs.readFile(`${dir}/${PLAN_SURFACE_CHECK_FILE}`, "utf8")) as PlanSurfaceCheckShape;
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

  it("答えのファイルの形は、組み直した質問 ID の鍵で答え、足りない質問を推奨で埋める", async () => {
    const transcript = createPlanTranscript();
    const responder = createAnswersFilePlanResponder({ "Q1-1": { choiceId: "c2" } }, transcript);
    const questions = [
      { id: "Q1-1", openIssueId: "OI-1", revision: 1, text: "?", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }], recommended: { choiceId: "c1", reason: "r" }, allowFreeText: true },
      { id: "Q1-2", openIssueId: "OI-2", revision: 1, text: "?", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }], recommended: { choiceId: "c2", reason: "r" }, allowFreeText: true },
    ];

    const outcome = await responder.answer({ questions, remaining: { questions: 8, roundTrips: 2 } });

    expect(outcome).toEqual({
      kind: "answers",
      answers: [
        { id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c2" },
        { id: "A:Q1-2", questionId: "Q1-2", revision: 1, choiceId: "c2" },
      ],
    });
    // 確認は自動で「これで作る」
    expect(await responder.confirm({ plan: { schema_version: "x", plan_id: "p", revision: 1, vocabulary_version: "v1", inputs: [], requirements: [], open_issues: [], decisions: [], accepted_unwritable: [] }, diff: [], unwritable: [], closedByDefault: [] })).toBe("build");
    expect(transcript.confirmation).toBe("build");
  });

  it("答えのファイルの鍵は、組み直した質問 ID と一致するときだけ使われ、LLM 由来の古い鍵は変換されずに推奨で埋まる（Issue #405）", async () => {
    const transcript = createPlanTranscript();
    // 古い鍵（LLM 由来の ID）は自動で変換しない——現在の質問 ID（Q1-1）と一致しないので、無いものとして推奨で埋める
    const responder = createAnswersFilePlanResponder({ "Q-1": { choiceId: "c1" } }, transcript);
    const questions = [
      { id: "Q1-1", openIssueId: "OI-1", revision: 1, text: "?", choices: [{ id: "c1", text: "A" }, { id: "c2", text: "B" }], recommended: { choiceId: "c2", reason: "r" }, allowFreeText: true },
    ];

    const outcome = await responder.answer({ questions, remaining: { questions: 8, roundTrips: 2 } });

    expect(outcome).toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "c2" }],
    });
  });
});

// ── 端末から確定まで（番号・推奨で決める・自由入力）──────────────────

describe("偽物の端末で、番号・推奨で決める・自由入力を受け取って確定まで進む（04 §2・§7）", () => {
  it("3 問に答えて確定し、確定した仕様が Build に渡る", async () => {
    const recording = planThenBuildRecording();
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]),
      [freeTextQuestionName("A:Q1-3")]: {
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
      ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]),
    });
    const dir = `${directory}/answers`;
    const answersPath = "answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--budget", "0.3"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({ "Q1-1": { choiceId: "c1" } }) : SOURCE_TEXT),
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
    // 確定したときは failure・cannot_confirm の欄が無い（Issue #397）
    expect(record.failure).toBeUndefined();
    expect(record.cannot_confirm).toBeUndefined();

    // 確定した仕様が生成の plan に渡り、予算が「全体（0.3）− Plan の使った額」になる
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]?.[0];
    expect(call?.plan).toBeDefined();
    expect(call?.budgetUsd).toBeCloseTo(record.remaining_usd, 10);
    expect(call?.budgetUsd).toBeCloseTo(0.3 - record.spent_usd, 10);
  });
});

// ── 答えのファイルの形でも、確認の内容を log に出す（04 §7・Issue #419）──────

describe("答えのファイルの形でも、確認の内容を log に出す（04 §7・Issue #419）", () => {
  /** 計測の道具（評価の外側）と同じ抽出：JSON として読める行を `schema_version` で絞って最後を取る */
  function extractFromLog(lines: readonly string[]): {
    readonly summary: Record<string, unknown> | null;
    readonly planCost: Record<string, unknown> | null;
  } {
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((value): value is Record<string, unknown> => value !== null);
    return {
      summary: parsed.filter((value) => value.schema_version === "commandagent.headless-summary/v1").at(-1) ?? null,
      planCost: parsed.filter((value) => value.schema_version === "musunest-factory/plan-build-cost/v1").at(-1) ?? null,
    };
  }

  it("確認の内容と「自動で これで作る」を出し、対話の問いは出さず、要約と費用の行は JSON として読め、確認の行は読めない", async () => {
    const MARK = "MARK_SOURCE_FILE";
    const markedSource = `${MARK}する。件数を合計する。`;
    const spanOf = (quote: string): { readonly start: number; readonly end: number } => {
      const start = markedSource.indexOf(quote);
      return { start, end: start + quote.length };
    };
    const markedList = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: `${MARK}する`, position: spanOf(`${MARK}する`) },
        { id: "R-2", text: "件数を合計できる", quote: "件数を合計する", position: spanOf("件数を合計する") },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(markedList),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured(QUESTIONS_THREE),
      structured(SURFACE_CLEAR),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]),
    });
    const dir = `${directory}/answers-file-log`;
    const answersPath = "log-answers.json";
    const lines: string[] = [];

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({ "Q1-1": { choiceId: "c1" } }) : markedSource),
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
      log: (line) => lines.push(line),
    });

    const text = lines.join("\n");
    // 確認の内容（差分・書けないこと・既定で決めたこと）の見出しと、自動の 1 行が出る
    expect(text).toContain("元の依頼からの差分");
    expect(text).toContain("書けないこと");
    expect(text).toContain("既定で決めたこと（観点・値・理由）");
    expect(text).toContain(AUTO_BUILD_LINE);
    // 対話の「はい・いいえ」の問いは出ない
    expect(text).not.toContain("これで作る [y/n]");
    // 既定の値・理由に、依頼文の目印が出ない
    const defaultLines = lines.filter(
      (line) => line.includes("期間の条件を足さない") || line.includes("理由:"),
    );
    expect(defaultLines.join("\n")).not.toContain(MARK);

    // 確認の行は JSON として読めない（抽出の経路を壊さない）
    for (const line of lines) {
      if (
        line.includes("元の依頼") ||
        line.includes("書けないこと") ||
        line.includes("既定で決めたこと") ||
        line === AUTO_BUILD_LINE
      ) {
        expect(() => JSON.parse(line)).toThrow();
      }
    }
    // 計測の道具と同じ抽出で、要約の行の stop_reason・exit_code と、費用の行の合計が読める
    const { summary, planCost } = extractFromLog(lines);
    expect(summary?.stop_reason).toBeDefined();
    expect(typeof summary?.exit_code).toBe("number");
    expect(typeof planCost?.total_usd).toBe("number");
    expect(planCost?.total_usd).toBeGreaterThanOrEqual(0);
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
    const lines: string[] = [];
    // 答えにも目印を入れる（往復の記録には残るが、診断と理由の行には出ない。Issue #397）
    const answerMark = "MARK_ANSWER_FREE";

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) =>
        path === answersPath
          ? JSON.stringify({
              // 1 往復目は目印つきの選択肢、2・3 往復目は存在しない選択肢——どれも採られない（Issue #405）
              "Q1-1": { choiceId: answerMark },
              "Q1-2": { choiceId: "nope" },
              "Q1-3": { choiceId: "nope" },
              "Q2-1": { choiceId: "nope" },
              "Q2-2": { choiceId: "nope" },
              "Q2-3": { choiceId: "nope" },
              "Q3-1": { choiceId: "nope" },
              "Q3-2": { choiceId: "nope" },
              "Q3-3": { choiceId: "nope" },
            })
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
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    // Build は流さない
    expect(spy).not.toHaveBeenCalled();
    // 往復の記録は残る（確定していない）
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("cannot-confirm");
    // 確定できなかった理由が記録に残る（Issue #397）
    expect(record.cannot_confirm).toEqual([{ source: "session", code: "round-trip-limit", path: "open_issues" }]);
    expect(record.failure).toBeUndefined();
    // 止まった理由の行に、分類（先頭の数件）が出る
    expect(lines.some((line) => line.includes("round-trip-limit"))).toBe(true);
    // 値が漏れない：答えの目印は、往復の記録には残るが、診断と理由の行には出ない
    expect(JSON.stringify(record.rounds)).toContain(answerMark);
    expect(JSON.stringify(record.cannot_confirm)).not.toContain(answerMark);
    expect(lines.join("\n")).not.toContain(answerMark);
  });

  it("段の失敗で止まると、plan-record に failure が入り、理由の行に分類が出る（Issue #397）", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured({ questions: "並びでない" }),
      structured({ questions: "並びでない" }),
    ]);
    const judge = createFakeJudge(catalogAnswers());
    const dir = `${directory}/stopped`;
    const answersPath = "empty-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");
    const lines: string[] = [];

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
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
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.stage).toBe("questions");
    expect(record.failure?.kind).toBe("malformed");
    expect(record.failure?.problems).toEqual([{ field: "questions", code: "shape" }]);
    expect(record.cannot_confirm).toBeUndefined();
    // 止まった理由の行に、分類が出る（値の中身は出ない）
    expect(lines.some((line) => line.includes("malformed") && line.includes("shape"))).toBe(true);
  });
});

// ── 一緒に閉じた事項と、依頼文で閉じた事項の記録（Issue #370）────────────

describe("往復の記録に、一緒に閉じた事項と依頼文で閉じた事項が残る（04 §3 P4・Issue #370）", () => {
  it("答えのファイルの形で、問いの一緒に閉じた事項の ID が記録に残る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(GROUPED_SURFACE_TWO),
      structured(GROUPED_QUESTIONS_ONE),
      structured(SURFACE_CLEAR),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers(["A:Q1-1"]) });
    const dir = `${directory}/grouped-record`;
    const answersPath = "grouped-answers.json";

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) =>
        path === answersPath ? JSON.stringify({ "Q1-1": { choiceId: "c1" } }) : SOURCE_TEXT,
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
    // 問いごとの、一緒に閉じた事項の ID が残る
    expect(record.rounds[0]?.questions[0]?.also_closes).toEqual(["OI-2"]);
    // 依頼文で閉じた事項は無い
    expect(record.closed_by_source).toEqual([]);
  });

  it("対話の形で、依頼文で決めたことが確認の画面に出て、記録にも残る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SOURCE_CLOSURE_SURFACE_ONE),
      structured(SOURCE_CLOSURE_ONE),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers([]) });
    const dir = `${directory}/source-closure`;
    const terminal = fakeTerminal(["これで作る"]);
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

    // 確認の画面に、依頼文で決めたこと（事項・決めた中身・引用）が出る
    expect(
      terminal.out.some(
        (line) => line.includes("記録する内容を 1 行にする") && line.includes("タスクを記録する"),
      ),
    ).toBe(true);

    // 往復の記録に、依頼文で閉じた事項（ID・引用・決めた中身）が残る
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("confirmed");
    expect(record.closed_by_source).toEqual([
      { issue_id: "OI-1", quote: "タスクを記録する", value: "記録する内容を 1 行にする" },
    ]);
    // 問いは 0 問（一緒に閉じた事項も無い）
    expect(record.rounds).toEqual([]);
    // 確定したので Build が流れる
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── 上限を上げても、Plan のあとの Build の予算と締切の扱いは変わらない（Issue #399）──

describe("上限を上げても、Plan のあとの Build の予算と締切の扱いは変わらない（Issue #399）", () => {
  /** usage の欠けた構造化出力の記録（精算されず、予約が残る側） */
  const withoutUsage = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

  it("Plan で usage の欠けた呼び出しがあると、Build の予算は「全体 − 使った額 − 残る予約」になる", async () => {
    const recording = createRecordingClient([
      withoutUsage(REQUIREMENT_LIST_OUTPUT),
      withoutUsage(REVERSE_CHECK_OUTPUT),
      withoutUsage(SURFACE_THREE),
      withoutUsage(QUESTIONS_THREE),
      // 差分点検（増えた要件）の P3 の応答（Issue #434）。usage の欠けた呼び出しの数え方を試す
      withoutUsage(SURFACE_CLEAR),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]) });
    const dir = `${directory}/reserved-budget`;
    const answersPath = "reserved-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--budget", "0.3"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({ "Q1-1": { choiceId: "c1" } }) : SOURCE_TEXT),
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
    // usage が欠けた呼び出しは精算されないので、使った額は 0、予約だけが残る
    expect(record.spent_usd).toBe(0);
    expect(record.remaining_usd).toBeLessThan(record.budget_usd);
    // Build に渡る予算は、残高そのもの（全体 − 使った額 − 残る予約）
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]?.[0];
    expect(call?.budgetUsd).toBeCloseTo(record.remaining_usd, 12);
    expect(call?.budgetUsd).toBeLessThan(record.budget_usd - record.spent_usd);
  });

  it("Plan に時間を使ったあとの Build が、締切を取り直さない", async () => {
    const recording = planThenBuildRecording();
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]) });
    const dir = `${directory}/deadline`;
    const answersPath = "deadline-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");
    let clock = 0;
    // 呼ぶたびに時計を進める偽物（Plan が時間を使うことを模す）
    const tickingClient: LlmClient = {
      callStructured: (request) => {
        clock += 1_000;
        return recording.client.callStructured(request);
      },
      callWithTools: (request) => {
        clock += 1_000;
        return recording.client.callWithTools(request);
      },
    };

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--deadline", "10"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({ "Q1-1": { choiceId: "c1" } }) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => [],
      makeClient: () => tickingClient,
      makeLlmJudge: () => judge,
      now: () => clock,
      log: () => {},
    });

    // Plan に時間を使った（時計が進んだ）
    expect(clock).toBeGreaterThan(0);
    const call = spy.mock.calls[0]?.[0];
    // 締切は入口で 1 度だけ決めた値（開始 0 + 10 分）のまま——Build が取り直さない
    expect(call?.deadline).toBe(600_000);
  });
});

// ── 質問 ID と答えの ID を往復をまたいで一意にする（Issue #405）──────────────────

describe("往復をまたいで質問 ID が重ならない（Issue #405）", () => {
  /** 重大な事項 1 件の P3 の答え */
  const SURFACE_ONE = {
    ambiguities: [{ id: "OI-1", requirementId: "R-1", text: "誰の分を数えるか", critical: true }],
    unwritable: [],
  };

  /** 未解決の事項 1 つへの P4 の答え（2 往復とも LLM が同じ `id`（Q-1）を返す） */
  const QUESTIONS_ONE = {
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
    ],
  };

  it("対話の形で 2 往復を答えて確定し、記録の問いに版が載り、確定した仕様が Build に渡る", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_ONE),
      structured(QUESTIONS_ONE),
      // 1 往復目は運用の指示で要件が増えない（差分点検の段は呼ばれない）
      structured(QUESTIONS_ONE),
      // 2 往復目で増えた要件の差分点検（Issue #434）
      structured(SURFACE_CLEAR),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q2-1"]),
      // 1 往復目の自由入力は運用の指示——要件にせず、事項を開いたまま残す（3 往復目に進ませない）
      [freeTextQuestionName("A:Q1-1")]: {
        kind: "choice",
        choice: "operational",
        probabilities: undefined,
        probability: undefined,
        confidence: 0.9,
      },
    });
    const dir = `${directory}/two-rounds`;
    const terminal = fakeTerminal([FREE_TEXT_INPUT, "運用で決める", "1", "これで作る"]);
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

    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("confirmed");
    // 2 往復になり、問いの ID が往復をまたいで重ならない（1 往復目は Q1-1、2 往復目は Q2-1）
    expect(record.rounds.map((round) => round.questions.map((question) => question.id))).toEqual([
      ["Q1-1"],
      ["Q2-1"],
    ]);
    // 記録に版（revision）が載る
    expect(record.rounds.map((round) => round.questions.map((question) => question.revision))).toEqual([
      [1],
      [2],
    ]);
    // 答える役に渡った問いの数と、往復の記録の問いの数が一致する（黙って捨てる分岐が無い）
    const recordedQuestions = record.rounds.flatMap((round) => round.questions);
    const planQuestions = (spy.mock.calls[0]?.[0]?.plan?.inputs ?? []).filter(
      (input) => input.kind === "question",
    );
    expect(recordedQuestions).toHaveLength(planQuestions.length);
    // 対話の形で 2 往復を答えて確定し、確定した仕様が Build に渡る
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.plan?.plan_id).toBe("local-plan-0");
  });

  it("目印を含む重複 ID の応答で止まると、記録と停止の行に添字と分類だけが残り、ID の値と message が無い", async () => {
    const mark = "MARK_DUP_QQQ";
    const questionOf = (text: string) => ({
      id: `Q-${mark}`,
      openIssueId: "OI-1",
      text,
      choices: [
        { id: "c1", text: "全員" },
        { id: "c2", text: "自分のみ" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    });
    const duplicated = { questions: [questionOf("問い a"), questionOf("問い b")] };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured(duplicated),
      structured(duplicated),
    ]);
    const judge = createFakeJudge(catalogAnswers());
    const dir = `${directory}/duplicate-question-id`;
    const answersPath = "empty-answers.json";
    const lines: string[] = [];

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
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
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.problems).toEqual([{ field: "questions[1].id", code: "duplicate-question-id" }]);
    // 目印を含む重複 ID の値と、問題の message が、記録と停止の行のどこにも無い
    const recordText = JSON.stringify(record);
    expect(recordText).not.toContain(mark);
    expect(recordText).not.toContain("message");
    expect(lines.join("\n")).not.toContain(mark);
    expect(lines.join("\n")).toContain("duplicate-question-id");
  });
});

// ── 既定で決めたことの表示と記録（04 §3・Issue #408）───────────────────────

describe("既定で決めたことを、依頼文で決めたことと別の見出しで出し、記録に残す（04 §3・Issue #408）", () => {
  const MARK = "MARK_SOURCE_ZZZ";
  /** 依頼文の目印を含む 2 文。要件はそのまま引用する */
  const markedSource = `${MARK}する。件数を合計する。`;
  const spanOf = (quote: string) => {
    const start = markedSource.indexOf(quote);
    return { start, end: start + quote.length };
  };
  const markedList = {
    requirements: [
      { id: "R-1", text: "印を出せる", quote: `${MARK}する`, position: spanOf(`${MARK}する`) },
      { id: "R-2", text: "件数を合計できる", quote: "件数を合計する", position: spanOf("件数を合計する") },
    ],
    framing: [],
    decisions: [],
    unresolved: [],
  };

  it("対話の形で、既定で決めたことが別の見出しで出て、P4 を呼ばずに確定し、記録の closed_by_default に残り、Build に渡る", async () => {
    const recording = createRecordingClient([
      structured(markedList),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_CLEAR),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period", "current-period", "include-zero"] }),
      ...coverAnswers([]),
    });
    const dir = `${directory}/closed-by-default`;
    const terminal = fakeTerminal(["これで作る"]);
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      readFile: async () => markedSource,
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      terminal,
      log: () => {},
    });

    // 既定で決めたことが、依頼文で決めたことと別の見出しで出る
    expect(terminal.out.some((line) => line.includes("既定で決めたこと（観点・値・理由）"))).toBe(true);
    // 既定の値・理由に、依頼文の目印の文字列が出ない
    const defaultLines = terminal.out.filter((line) => line.includes("期間の条件を足さない") || line.includes("理由:"));
    expect(defaultLines.join("\n")).not.toContain(MARK);

    // 往復の記録：P4 を 1 回も呼ばず（rounds が空）、closed_by_default に事項 ID・観点 ID・値が残る
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("confirmed");
    expect(record.rounds).toEqual([]);
    expect(record.closed_by_default).toEqual([
      { issue_id: "OI:catalog:R-1:period", facet_id: "period", value: "期間の条件を足さない" },
      { issue_id: "OI:catalog:R-1:current-period", facet_id: "current-period", value: "今の期間を含む" },
      { issue_id: "OI:catalog:R-1:include-zero", facet_id: "include-zero", value: "0 件の見出しも出す" },
    ]);
    // 既定の値に目印が出ない
    expect(JSON.stringify(record.closed_by_default)).not.toContain(MARK);

    // 既定を当てた仕様が Build に渡る
    expect(spy).toHaveBeenCalledTimes(1);
    const plan = spy.mock.calls[0]?.[0]?.plan;
    expect(plan).toBeDefined();
    const decisions = (plan?.decisions ?? []).map((decision) => decision.id);
    expect(decisions).toContain("D:default:OI:catalog:R-1:period");
  });

  it("確認で「やめる」なら、既定で決めていても Build を呼ばない", async () => {
    const recording = createRecordingClient([
      structured(markedList),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_CLEAR),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor({ "R-1": ["period"] }),
      ...coverAnswers([]),
    });
    const dir = `${directory}/closed-by-default-stop`;
    const terminal = fakeTerminal(["やめる"]);
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      ...realFileDeps(),
      readFile: async () => markedSource,
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      terminal,
      log: () => {},
    });

    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.confirmation).toBe("stop");
  });
});

// ── P1/P2 の往復ごとの内訳を plan-record に残す（Issue #430）────────────────

describe("P1/P2 の往復ごとの内訳を plan-record に残す（Issue #430）", () => {
  it("requirements_diagnosis に往復の数・種類・出どころの件数が残り、依頼文の目印が出ず、schema_version は変わらない", async () => {
    const mark = "MARK_SOURCE_DIAG";
    const source = `${mark}する。件数を合計する。`;
    const spanOf = (quote: string): { readonly start: number; readonly end: number } => {
      const start = source.indexOf(quote);
      return { start, end: start + quote.length };
    };
    // R-2 は引用が原文に無く、位置も退避しているので、コードの落ち（引用なし・覆われない原文）を作る
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: `${mark}する`, position: spanOf(`${mark}する`) },
        { id: "R-2", text: "合計できる", quote: "件数を数える", position: { start: 0, end: 0 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    // 会話が挙げた、覆われていない部分（コードの落ちとは重ならない）
    const conversation = { uncovered: [{ start: 0, end: 2 }] };
    const recording = createRecordingClient([
      structured(list),
      structured(conversation),
      structured(list),
      structured(conversation),
    ]);
    const dir = `${directory}/requirements-diagnosis`;
    const answersPath = "diagnosis-answers.json";
    const lines: string[] = [];

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : source),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeLlmJudge: () => createFakeJudge({}),
      now: () => 0,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    const record = await readPlanRecord(dir);
    // 引用の落ちが残るので、確定できない
    expect(record.outcome).toBe("cannot-confirm");
    // 版の文字列は今までどおり
    expect(record.schema_version).toBe(PLAN_CLI_RECORD_SCHEMA);
    // Issue #446：plan-record の stages に、段ごとの試行の終端と再試行の数が入る
    expect(record.stages.length).toBeGreaterThan(0);
    for (const stage of record.stages) {
      expect(Object.keys(stage.attempts).sort(), stage.stage).toEqual([...ATTEMPT_KEYS].sort());
      expect(Object.keys(stage.retries).sort(), stage.stage).toEqual([...RETRY_KEYS].sort());
    }
    // 往復は 2（初回 + やり直し）。種類ごと・出どころごとの件数が結果と一致する
    const expected = {
      quote_not_found: 1,
      position_mismatch: 0,
      uncovered_source: { code: 1, conversation: 1 },
    };
    expect(record.requirements_diagnosis).toEqual({
      rounds: [
        { misses: expected, dropped_blank_misses: 0 },
        { misses: expected, dropped_blank_misses: 0 },
      ],
      redone: true,
      unmet: expected,
    });
    // 値（依頼文の目印・原文の断片・位置）は、内訳にも記録のどこにも出ない
    expect(JSON.stringify(record.requirements_diagnosis)).not.toContain(mark);
    expect(JSON.stringify(record.requirements_diagnosis)).not.toContain("件数を");
    expect(JSON.stringify(record)).not.toContain(mark);
    expect(lines.join("\n")).not.toContain(mark);
  });
});

// ── P2 の覆いの落ちで止まった本を plan-record に残す（Issue #440）────────────

describe("覆われていない原文がやり直し後も残って止まった本を plan-record に残す（Issue #440）", () => {
  it("plan-record に cannot_confirm の理由と内訳が残り、依頼文の目印が出ず、Build を流さない", async () => {
    const mark = "MARK_UNCOVERED_SRC";
    // 3 文の原文。要件が前の 2 文を覆い、最後の 1 文が覆われていない（コードの落ち）
    const source = `${mark}を記録する。件数を合計する。印を出す。`;
    const spanOf = (quote: string): { readonly start: number; readonly end: number } => {
      const start = source.indexOf(quote);
      return { start, end: start + quote.length };
    };
    const list = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: `${mark}を記録する。`, position: spanOf(`${mark}を記録する。`) },
        { id: "R-2", text: "合計できる", quote: "件数を合計する。", position: spanOf("件数を合計する。") },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
    ]);
    const dir = `${directory}/uncovered-source-stop`;
    const answersPath = "uncovered-source-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");
    const lines: string[] = [];

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : source),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeLlmJudge: () => createFakeJudge({}),
      now: () => 0,
      log: (line) => lines.push(line),
    });

    // Build を流さず、終了コードは 0 でない
    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("cannot-confirm");
    // 確定できない理由（値の中身を含まない）
    expect(record.cannot_confirm).toEqual([
      { source: "reverse-check", code: "uncovered-source", path: "source[*]" },
    ]);
    expect(record.failure).toBeUndefined();
    // 往復の記録の内訳（G1a）に、覆われていない原文の件数が残る
    expect(record.requirements_diagnosis.unmet).toEqual({
      quote_not_found: 0,
      position_mismatch: 0,
      uncovered_source: { code: 1, conversation: 0 },
    });
    // 値（依頼文の目印・原文の断片）は、理由・内訳・記録のどこにも出ない
    expect(JSON.stringify(record)).not.toContain(mark);
    expect(lines.join("\n")).not.toContain(mark);
  });
});

// ── 止まったときの内訳も plan-record に写る（Issue #430 の直し）──────────────

describe("止まったときの内訳も plan-record に写る（Issue #430 の直し）", () => {
  /** `failAt` 回目の構造化出力の呼び出しでだけ要求の誤りを投げる偽物の呼び出し */
  function clientThrowingAt(recorded: readonly RecordedCall[], failAt: number): LlmClient {
    const inner = createRecordingClient(recorded);
    let calls = 0;
    return {
      async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
        calls += 1;
        if (calls === failAt) {
          throw Object.assign(new Error("要求が不正です"), { kind: "invalidRequest", code: "invalid_json_schema" });
        }
        return inner.client.callStructured<T>(request);
      },
      async callWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
        return inner.client.callWithTools(request);
      },
    };
  }

  it("① のやり直しが成功したあと ①' で止まると、記録の redone が true になる", async () => {
    // 引用の落ちと覆いの落ちを作る一覧（やり直しが走る）
    const list = {
      requirements: [
        { id: "R-1", text: "記録できる", quote: "タスクを記録する", position: { start: 0, end: 8 } },
        { id: "R-2", text: "合計できる", quote: "件数を数える", position: { start: 0, end: 0 } },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const conversation = { uncovered: [{ start: 0, end: 2 }] };
    // 1: ①／2: ①'（落ちを作る）／3: ① のやり直し／4: ①' のやり直しで要求の誤り
    const client = clientThrowingAt([structured(list), structured(conversation), structured(list)], 4);
    const dir = `${directory}/stopped-diagnosis`;
    const answersPath = "stopped-diagnosis-answers.json";
    const lines: string[] = [];

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => [],
      makeClient: () => client,
      makeLlmJudge: () => createFakeJudge({}),
      now: () => 0,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.operation).toBe("reverse-check-redo");
    // ① のやり直しは成功しているので、止まった記録でも redone は true（Issue #430 の直し）
    expect(record.requirements_diagnosis.redone).toBe(true);
    expect(record.requirements_diagnosis.rounds).toHaveLength(1);
    // 止まったので、やり直し後に残った落ちの内訳は 0 のまま
    expect(record.requirements_diagnosis.unmet).toEqual({
      quote_not_found: 0,
      position_mismatch: 0,
      uncovered_source: { code: 0, conversation: 0 },
    });
    expect(lines.some((line) => line.includes("reverse-check-redo"))).toBe(true);
  });
});

// ── P3 の「書けない」の申告の点検を plan-record に残す（Issue #432）──────────────

describe("P3 の申告の点検を plan-record.json の surface_check に残す（Issue #432）", () => {
  /** 語彙の穴の申告 1 件（制約 ID は文書に実在する） */
  const SURFACE_ONE_CLAIM = {
    ambiguities: [],
    unwritable: [
      { id: "U-0", requirementId: "R-1", part: "部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
    ],
  };

  it("受理された申告の件数と判定の記録が残り、Build に進む", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_ONE_CLAIM),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers([]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    const dir = `${directory}/surface-check`;
    const answersPath = "surface-check-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("confirmed");
    // 件数（受理 1・落とした 0・曖昧さへ 0・未点検 0）
    expect(record.surface_check.accepted).toBe(1);
    expect(record.surface_check.dropped).toBe(0);
    expect(record.surface_check.ambiguity).toBe(0);
    expect(record.surface_check.unchecked).toBe(0);
    // 最後まで点検し終えている
    expect(record.surface_check.completed).toBe(true);
    // 判定の記録（点検の番号・問いの ID・答え・確信度・モデルの版・adapter）
    expect(record.surface_check.judgments).toEqual([
      { check: 1, question_id: "plan-triage:0", answer: "vocabulary-hole", confidence: 0.9, model: "fake-judge", answered_by: "fake" },
      { check: 1, question_id: "plan-support:0", answer: "supports", confidence: 0.95, model: "fake-judge", answered_by: "fake" },
    ]);
    // 別ファイルの診断（`plan-surface-check.json`）に、申告 1 件の対応が残る
    const diagnostic = await readSurfaceCheck(dir);
    expect(diagnostic.schema_version).toBe("musunest-factory/plan-surface-check/v1");
    expect(diagnostic.claims).toEqual([
      {
        check: 1,
        index: 0,
        requirement_id: "R-1",
        part: "部分",
        reason: "理由",
        constraint_ids: ["記録"],
        doc_version: "v1",
        stage: "support",
        classification: "supports",
        adapter: "fake",
        confidence: 0.95,
        evidence_id: null,
      },
    ]);
    // 確定したので Build が流れる
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("未点検が残れば、Build を呼ばず終了コードが 0 でなく、cannot_confirm に surface-check の理由が残る", async () => {
    const MARK = "MARK_SURFACE_ZZZ";
    const surface = {
      ambiguities: [],
      unwritable: [
        {
          id: "U-0",
          requirementId: "R-1",
          part: `${MARK}の部分`,
          constraintIds: ["記録"],
          reason: `${MARK}の理由`,
          alternative: `${MARK}の代案`,
        },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      // 裏付けが「書いていない」→ 未点検
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("not-stated", 0.9),
      // 再点検（Luna）も根拠が取れない → 未点検（根拠不足）のまま
      [surfaceRecheckKindQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceRecheckEvidenceQuestionName(0)]: choice(SURFACE_RECHECK_NO_EVIDENCE, 0.9),
    });
    const dir = `${directory}/surface-check-unchecked`;
    const answersPath = "surface-check-unchecked-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");
    const lines: string[] = [];

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: (line) => lines.push(line),
    });

    // Build を呼ばず、終了コードは 0 でない
    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("cannot-confirm");
    // 確定できない理由に、surface-check の理由（点検の番号つき）が残る
    expect(record.cannot_confirm).toEqual([
      { source: "surface-check", code: "not-stated", path: "unwritable[0]", check: 1 },
    ]);
    expect(record.surface_check.unchecked).toBe(1);
    // 値（部分の文・理由・制約 ID）は、理由にも停止の行にも出ない
    expect(JSON.stringify(record.cannot_confirm)).not.toContain(MARK);
    expect(lines.join("\n")).not.toContain(MARK);
    expect(lines.some((line) => line.includes("not-stated"))).toBe(true);
  });

  it("裏付けの予算が尽きても、仕分けまでに得た分類と判定が plan-record に残る（completed は false）", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const surface = {
      ambiguities: [],
      unwritable: [
        { id: "U-0", requirementId: "R-1", part: "部分 0", constraintIds: ["記録"], reason: "理由 0", alternative: "代案 0" },
        { id: "U-1", requirementId: "R-2", part: "部分 1", constraintIds: ["合計"], reason: "理由 1", alternative: "代案 1" },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
    ]);
    // 仕分けの判定は答えつつ、巨大な usage（LLM の adapter）で予算を使い切る → 裏付けの予約が失敗する
    const triageAnswers: Record<string, JudgeAnswer> = {
      [surfaceTriageQuestionName(0)]: choice("not-a-problem", 0.9),
      [surfaceTriageQuestionName(1)]: choice("vocabulary-hole", 0.9),
    };
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        const answers: Record<string, JudgeAnswer> = {};
        let triage = false;
        for (const name of Object.keys(request.questions)) {
          if (name.startsWith("plan-triage:")) triage = true;
          answers[name] = triageAnswers[name] ?? choice("supports", 0.9);
        }
        // 仕分けの呼び出しだけ巨大な usage（LLM の adapter）で予算を使い切る → 裏付けの予約が失敗する
        return triage
          ? { answers, inputTokens: 0, usage: hugeUsage, model: "judge", answeredBy: "llm" }
          : { answers, inputTokens: 0, model: "judge", answeredBy: "fake" };
      },
    };
    const dir = `${directory}/surface-check-partial`;
    const answersPath = "surface-check-partial-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--budget", "1"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.stage).toBe("surface-check");
    expect(record.failure?.kind).toBe("budget");
    // 途中までの分類と判定が記録に残る（全件 0 と区別できる）
    expect(record.surface_check.completed).toBe(false);
    expect(record.surface_check.dropped).toBe(1);
    expect(record.surface_check.judgments).toHaveLength(2);
    expect(record.surface_check.judgments.map((judgment) => judgment.answer)).toEqual(["not-a-problem", "vocabulary-hole"]);
    // 途中停止でも、申告 1 件ずつの診断が別ファイルに残る（落とした 1 件目と、裏付けの前に止まった 2 件目）
    const diagnostic = await readSurfaceCheck(dir);
    expect(diagnostic.claims).toHaveLength(2);
    expect(diagnostic.claims[0]).toMatchObject({ index: 0, stage: "triage", classification: "not-a-problem" });
    expect(diagnostic.claims[1]).toMatchObject({ index: 1, stage: "triage", classification: "vocabulary-hole" });
  });

  it("最初の判定の予約が失敗しても、診断ファイルに全申告が未実行で残る（申告 0 件と区別できる）", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const surface = {
      ambiguities: [],
      unwritable: [
        { id: "U-0", requirementId: "R-1", part: "部分 0", constraintIds: ["記録"], reason: "理由 0", alternative: "代案 0" },
        { id: "U-1", requirementId: "R-2", part: "部分 1", constraintIds: ["合計"], reason: "理由 1", alternative: "代案 1" },
      ],
    };
    // surface の応答で予算を使い切る → surface-check の最初の判定の予約が失敗する
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface, hugeUsage),
    ]);
    const judge = createFakeJudge(catalogAnswers());
    const dir = `${directory}/surface-check-unexecuted`;
    const answersPath = "surface-check-unexecuted-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--budget", "1"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.stage).toBe("surface-check");
    expect(record.failure?.kind).toBe("budget");
    // 全申告が「未実行」で別ファイルに残る（申告が無かった場合と区別できる）
    const diagnostic = await readSurfaceCheck(dir);
    expect(diagnostic.claims).toEqual([
      expect.objectContaining({ index: 0, requirement_id: "R-1", stage: "unexecuted", classification: "unexecuted", doc_version: "v1" }),
      expect.objectContaining({ index: 1, requirement_id: "R-2", stage: "unexecuted", classification: "unexecuted", doc_version: "v1" }),
    ]);
  });
});

// ── Issue #434：差分点検の記録と、2 往復目に差分の事項が聞かれる道 ───────────────

describe("差分点検の記録を残し、答えのファイルの形で 2 往復目に差分の事項が聞かれる（04 §7・Issue #434）", () => {
  /** 差分点検の洗い出しが返す、重大な事項 1 件（差分の要件に由来する） */
  const DIFF_CRITICAL = {
    ambiguities: [{ id: "OI-diff", requirementId: "R:A:Q1-1", text: "差分で開いた重大な事項", critical: true }],
    unwritable: [],
  };
  /** 2 往復目に聞く、差分の事項への問い（ID はコードが組み直す） */
  const QUESTIONS_DIFF = {
    questions: [
      {
        id: "Q-1",
        openIssueId: "OI-diff",
        text: "差分の事項をどうしますか",
        choices: [
          { id: "c1", text: "こちら" },
          { id: "c2", text: "あちら" },
        ],
        recommended: { choiceId: "c1", reason: "依頼に沿う" },
        allowFreeText: true,
      },
    ],
  };

  it("往復の記録に差分点検の回数と件数が残り、依頼文・答えの目印が出ず、2 往復目に差分の事項が聞かれて確定する", async () => {
    const sourceMark = "MARK_SOURCE_DIFF";
    const answerMark = "MARK_ANSWER_DIFF";
    const source = `${sourceMark}する。件数を合計する。`;
    const spanOf = (quote: string): { readonly start: number; readonly end: number } => {
      const start = source.indexOf(quote);
      return { start, end: start + quote.length };
    };
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: `${sourceMark}する`, position: spanOf(`${sourceMark}する`) },
        { id: "R-2", text: "件数を合計できる", quote: "件数を合計する", position: spanOf("件数を合計する") },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured(QUESTIONS_THREE),
      // 1 往復目の差分点検：重大な事項を開く（Issue #434）
      structured(DIFF_CRITICAL),
      // 2 往復目：差分の事項への問い
      structured(QUESTIONS_DIFF),
      // 2 往復目の差分点検：もう開かない
      structured(SURFACE_CLEAR),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3", "A:Q2-1"]),
      // 1 往復目の自由入力（目印つき）は新しい要件——要件の文になる（記録の差分点検には出ない）
      [freeTextQuestionName("A:Q1-1")]: {
        kind: "choice",
        choice: "new-requirement",
        probabilities: undefined,
        probability: undefined,
        confidence: 0.9,
      },
    });
    const dir = `${directory}/diff-review-record`;
    const answersPath = "diff-review-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) =>
        path === answersPath ? JSON.stringify({ "Q1-1": { freeText: answerMark } }) : source,
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
    // 差分点検の記録（1 往復目は 3 件増えて 1 件開き、2 往復目は 1 件増えた。値ではなく件数）
    expect(record.diff_reviews).toEqual([
      { round: 1, added: 3, open_issues: 1, accepted_unwritable: 0, out_of_scope: NO_CLI_OUT_OF_SCOPE, inherit: cliInherit({ no_parent: 3, open_by_source: { surface: 1 } }) },
      { round: 2, added: 1, open_issues: 0, accepted_unwritable: 0, out_of_scope: NO_CLI_OUT_OF_SCOPE, inherit: cliInherit({ no_parent: 1 }) },
    ]);
    // 依頼文・答えの目印は、差分点検の記録に出ない
    expect(JSON.stringify(record.diff_reviews)).not.toContain(sourceMark);
    expect(JSON.stringify(record.diff_reviews)).not.toContain(answerMark);
    // 2 往復目に、差分の事項が聞かれて確定する
    expect(record.rounds[1]?.questions[0]?.open_issue_id).toBe("OI-diff");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── Issue #434：差分点検でも、途中停止・未点検の記録を plan-record に残す ─────────

describe("差分点検でも、受理・未点検・途中停止の記録を plan-record に残す（Issue #432・#434）", () => {
  /** 差分の洗い出しが返す、書けない申告 1 件（差分の要件に由来する。制約 ID は文書に実在する） */
  const DIFF_UNWRITABLE = {
    ambiguities: [],
    unwritable: [
      { id: "U-0", requirementId: "R:A:Q1-1", part: "差分の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
    ],
  };
  /** 差分の洗い出しが返す、書けない申告 2 件 */
  const DIFF_TWO = {
    ambiguities: [],
    unwritable: [
      { id: "U-0", requirementId: "R:A:Q1-1", part: "部分 0", constraintIds: ["記録"], reason: "理由 0", alternative: "代案 0" },
      { id: "U-1", requirementId: "R:A:Q1-1", part: "部分 1", constraintIds: ["合計"], reason: "理由 1", alternative: "代案 1" },
    ],
  };

  it("差分の点検で受理された申告が、surface_check と診断ファイルに積まれ、Build に進む", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured(QUESTIONS_THREE),
      structured(DIFF_UNWRITABLE),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    const dir = `${directory}/diff-accepted`;
    const answersPath = "diff-accepted-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("confirmed");
    // 差分の受理が surface_check に積まれる（初回は申告 0 件）
    expect(record.surface_check.accepted).toBe(1);
    expect(record.surface_check.completed).toBe(true);
    expect(record.surface_check.judgments.map((judgment) => judgment.question_id)).toEqual([
      "plan-triage:0",
      "plan-support:0",
    ]);
    expect(record.diff_reviews).toEqual([{ round: 1, added: 3, open_issues: 0, accepted_unwritable: 1, out_of_scope: NO_CLI_OUT_OF_SCOPE, inherit: cliInherit({ no_parent: 3 }) }]);
    // 別ファイルの診断に、差分の申告 1 件が残る
    const diagnostic = await readSurfaceCheck(dir);
    expect(diagnostic.claims).toEqual([
      expect.objectContaining({ index: 0, requirement_id: "R:A:Q1-1", stage: "support", classification: "supports" }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("差分の点検で未点検が残れば、surface_check に積み、Build を呼ばない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured(QUESTIONS_THREE),
      structured(DIFF_UNWRITABLE),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      // 裏付けが「書いていない」→ 落とし先（Luna）が無いので未点検
      [surfaceSupportQuestionName(0)]: choice("not-stated", 0.9),
    });
    const dir = `${directory}/diff-unchecked`;
    const answersPath = "diff-unchecked-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("cannot-confirm");
    expect(record.surface_check.unchecked).toBe(1);
    expect(record.surface_check.accepted).toBe(0);
    // 差分点検は 2 回目の点検（初回は申告 0 件）なので、点検の番号は 2
    expect(record.cannot_confirm).toEqual([
      { source: "surface-check", code: "unknown", path: "unwritable[0]", check: 2 },
    ]);
  });

  it("差分の点検の最初の予約が失敗しても、件数と未実行の診断が plan-record に残る（completed は false）", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured(QUESTIONS_THREE),
      // 差分の洗い出しの応答で予算を使い切る → 差分の申告の点検の最初の予約が失敗する
      structured(DIFF_UNWRITABLE, hugeUsage),
    ]);
    const judge = createFakeJudge({ ...catalogAnswers(), ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]) });
    const dir = `${directory}/diff-unexecuted`;
    const answersPath = "diff-unexecuted-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--budget", "1"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.stage).toBe("surface-check");
    expect(record.failure?.kind).toBe("budget");
    expect(record.surface_check.completed).toBe(false);
    expect(record.surface_check.accepted).toBe(0);
    // 開始時に積んだ差分点検の記録が残る（停止した往復も数える）
    expect(record.diff_reviews).toEqual([{ round: 1, added: 3, open_issues: 0, accepted_unwritable: 0, out_of_scope: NO_CLI_OUT_OF_SCOPE, inherit: cliInherit({ no_parent: 3 }) }]);
    // 全申告が「未実行」で別ファイルに残る
    const diagnostic = await readSurfaceCheck(dir);
    expect(diagnostic.claims).toEqual([
      expect.objectContaining({ index: 0, requirement_id: "R:A:Q1-1", stage: "unexecuted", classification: "unexecuted" }),
    ]);
  });

  it("差分の点検の裏付けが途中で止まっても、仕分けまでの記録が plan-record に残る（completed は false）", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_THREE),
      structured(QUESTIONS_THREE),
      structured(DIFF_TWO),
    ]);
    const inner = createFakeJudge({ ...catalogAnswers(), ...coverAnswers(["A:Q1-1", "A:Q1-2", "A:Q1-3"]) });
    const triageAnswers: Record<string, JudgeAnswer> = {
      [surfaceTriageQuestionName(0)]: choice("not-a-problem", 0.9),
      [surfaceTriageQuestionName(1)]: choice("vocabulary-hole", 0.9),
    };
    const judge: Judge = {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        const hasTriage = Object.keys(request.questions).some((name) => name.startsWith("plan-triage:"));
        if (!hasTriage) return inner.judge(request);
        const answers: Record<string, JudgeAnswer> = {};
        for (const name of Object.keys(request.questions)) answers[name] = triageAnswers[name] ?? choice("supports", 0.9);
        // 仕分けの呼び出しだけ巨大な usage で予算を使い切る → 裏付けの予約が失敗する
        return { answers, inputTokens: 0, usage: hugeUsage, model: "judge", answeredBy: "llm" };
      },
    };
    const dir = `${directory}/diff-partial`;
    const answersPath = "diff-partial-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--budget", "1"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.stage).toBe("surface-check");
    // 仕分けまでに得た分類と判定が残る（全件 0 と区別できる）
    expect(record.surface_check.completed).toBe(false);
    expect(record.surface_check.dropped).toBe(1);
    expect(record.surface_check.judgments).toHaveLength(2);
    expect(record.diff_reviews).toEqual([{ round: 1, added: 3, open_issues: 0, accepted_unwritable: 0, out_of_scope: NO_CLI_OUT_OF_SCOPE, inherit: cliInherit({ no_parent: 3 }) }]);
    const diagnostic = await readSurfaceCheck(dir);
    expect(diagnostic.claims.map((claim) => claim.classification)).toEqual(["not-a-problem", "vocabulary-hole"]);
  });
});

// ── Issue #434：点検の番号を plan-record に残し、どの点検かを一意に引く ──────────

describe("点検の番号を plan-record に残し、判定・診断を一意に引く（Issue #434）", () => {
  /** 問い 1 つを手で作る（ID は LLM 由来で、コードが `Q<版>-<n>` に組み直す） */
  function questionOf(openIssueId: string, id: string) {
    return {
      id,
      openIssueId,
      text: "どうしますか",
      choices: [
        { id: "c1", text: "こちら" },
        { id: "c2", text: "あちら" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    };
  }
  /** 初回の洗い出し：曖昧さ 3 件と、書けない申告 1 件（添字 0） */
  const ISSUES = {
    ambiguities: [
      { id: "OI-1", requirementId: "R-1", text: "曖昧 1", critical: true },
      { id: "OI-2", requirementId: "R-1", text: "曖昧 2", critical: true },
      { id: "OI-3", requirementId: "R-1", text: "曖昧 3", critical: true },
    ],
    unwritable: [
      { id: "U-0", requirementId: "R-1", part: "初回の部分", constraintIds: ["記録"], reason: "理由", alternative: "代案" },
    ],
  };
  /** 差分の洗い出し：書けない申告 1 件（添字 0） */
  const DIFF_CLAIM = {
    ambiguities: [],
    unwritable: [
      { id: "U-1", requirementId: "R:A:Q2-1", part: "差分の部分", constraintIds: ["合計"], reason: "理由", alternative: "代案" },
    ],
  };

  it("初回と差分が同じ添字 0 を使い、申告 0 件の点検と途中停止を挟んでも、記録の対応が失われない", async () => {
    const hugeUsage: LlmUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 10_000_000,
      reasoningTokens: 0,
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      // 初回の洗い出し（点検 1 の申告。添字 0）
      structured(ISSUES),
      structured({ questions: [questionOf("OI-1", "Q-1"), questionOf("OI-2", "Q-2"), questionOf("OI-3", "Q-3")] }),
      // 1 往復目の差分（点検 2。申告 0 件）
      structured(SURFACE_CLEAR),
      structured({ questions: [questionOf("OI-2", "Q-1"), questionOf("OI-3", "Q-2")] }),
      // 2 往復目の差分（点検 3。予算を使い切って、最初の予約が失敗して止まる）
      structured(DIFF_CLAIM, hugeUsage),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    const dir = `${directory}/check-number`;
    const answersPath = "check-number-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath, "--budget", "1"],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) =>
        path === answersPath
          ? JSON.stringify({
              // 1 往復目：Q1-1 だけ受理し、Q1-2・Q1-3 は存在しない選択肢で断る（事項を開いたまま残す）
              "Q1-1": { choiceId: "c1" },
              "Q1-2": { choiceId: "nope" },
              "Q1-3": { choiceId: "nope" },
              // 2 往復目：Q2-1 だけ受理し、Q2-2 は断る
              "Q2-1": { choiceId: "c1" },
              "Q2-2": { choiceId: "nope" },
            })
          : SOURCE_TEXT,
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.stage).toBe("surface-check");
    expect(record.failure?.kind).toBe("budget");
    // 判定は、点検の番号（1=初回）つき。同じ問いの名前（添字 0）が点検で区別できる
    expect(record.surface_check.judgments.map((judgment) => [judgment.check, judgment.question_id])).toEqual([
      [1, "plan-triage:0"],
      [1, "plan-support:0"],
    ]);
    expect(record.surface_check.completed).toBe(false);
    // 診断も点検の番号つき。申告 0 件の点検（2）は空、途中停止の点検（3）は未実行
    const diagnostic = await readSurfaceCheck(dir);
    expect(diagnostic.claims.map((claim) => [claim.check, claim.index, claim.classification])).toEqual([
      [1, 0, "supports"],
      [3, 0, "unexecuted"],
    ]);
    // 差分点検の記録は往復ごとに 2 件（停止した往復も数える）
    expect(record.diff_reviews).toEqual([
      { round: 1, added: 1, open_issues: 0, accepted_unwritable: 0, out_of_scope: NO_CLI_OUT_OF_SCOPE, inherit: cliInherit({ no_parent: 1 }) },
      { round: 2, added: 1, open_issues: 0, accepted_unwritable: 0, out_of_scope: NO_CLI_OUT_OF_SCOPE, inherit: cliInherit({ no_parent: 1 }) },
    ]);
  });
});

// ── Issue #434・§3：重複の除外と分類を plan-record に残す（値は転記しない）────────

describe("差分点検・§3：受理済み申告の再申告を除いた記録を保存する（値は転記しない。Issue #434）", () => {
  /** 問い 1 つを手で作る */
  function questionOf(openIssueId: string, id: string) {
    return {
      id,
      openIssueId,
      text: "どうしますか",
      choices: [
        { id: "c1", text: "こちら" },
        { id: "c2", text: "あちら" },
      ],
      recommended: { choiceId: "c1", reason: "依頼に沿う" },
      allowFreeText: true,
    };
  }
  const MARK = "MARK_DUP_VALUE";
  /** 初回に受理される申告（部分・理由・代案に目印を入れる） */
  const accepted = {
    id: "U-0",
    requirementId: "R-1",
    part: `${MARK}の部分`,
    constraintIds: ["記録", "合計"],
    reason: `${MARK}の理由`,
    alternative: `${MARK}の代案`,
  };
  const base = {
    ambiguities: [{ id: "OI-1", requirementId: "R-1", text: "曖昧", critical: true }],
    unwritable: [accepted],
  };

  it("正確な再申告を除いた件数と分類が保存され、値（部分・理由・代案・要件 ID）は転記されない", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(base),
      structured({ questions: [questionOf("OI-1", "Q-1")] }),
      // 同じ部分・理由・代案の再申告（申告 ID だけ変えてある）
      structured({ ambiguities: [], unwritable: [{ ...accepted, id: "U-dup" }] }),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q1-1"]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    const dir = `${directory}/dedup-record`;
    const answersPath = "dedup-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("confirmed");
    expect(record.diff_reviews).toEqual([
      {
        round: 1,
        added: 1,
        open_issues: 0,
        accepted_unwritable: 0,
        out_of_scope: {
          scanned: true,
          claims: 1,
          ambiguities: 0,
          deduped: 1,
          rejected_claims: 0,
          rejected_ambiguities: 0,
          kinds: [
            { kind: "source", claims: 1, ambiguities: 0 },
            { kind: "previous-answer", claims: 0, ambiguities: 0 },
            { kind: "alternative", claims: 0, ambiguities: 0 },
            { kind: "unknown", claims: 0, ambiguities: 0 },
            { kind: "unclassified", claims: 0, ambiguities: 0 },
          ],
          deduped_indexes: [0],
        },
        inherit: cliInherit({ no_parent: 1 }),
      },
    ]);
    // 値（部分・理由・代案・要件 ID）は、新しい記録（diff_reviews）に転記されない
    expect(JSON.stringify(record.diff_reviews)).not.toContain(MARK);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("正確な再申告と未知が同時にあるときは、段ごと止まり、識別した重複件数も保存される", async () => {
    const unknown = { id: "U-x", requirementId: "R:unknown", part: `${MARK}の部分`, constraintIds: ["記録"], reason: "理由", alternative: "代案" };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(base),
      structured({ questions: [questionOf("OI-1", "Q-1")] }),
      structured({ ambiguities: [], unwritable: [{ ...accepted, id: "U-dup" }, unknown] }),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q1-1"]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    const dir = `${directory}/dedup-stop`;
    const answersPath = "dedup-stop-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");
    const lines: string[] = [];

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.stage).toBe("surface");
    expect(record.failure?.kind).toBe("unmet");
    const out = record.diff_reviews[0]?.out_of_scope;
    expect(out?.claims).toBe(2);
    expect(out?.deduped).toBe(1);
    expect(out?.rejected_claims).toBe(1);
    expect(out?.deduped_indexes).toEqual([0]);
    expect(out?.kinds.find((entry) => entry.kind === "unknown")?.claims).toBe(1);
    // 値は、記録（diff_reviews）にも停止の行にも出ない
    expect(JSON.stringify(record.diff_reviews)).not.toContain(MARK);
    expect(lines.join("\n")).not.toContain(MARK);
  });

  it("制約検査で止まっても、対象外の集合・分類と識別済みの件数を保存する（D1）", async () => {
    const empty = { id: "U-empty", requirementId: "R:unknown", part: "部分", constraintIds: [], reason: "理由", alternative: "代案" };
    const outAmbiguity = { id: "OI-old", requirementId: "R-1", text: "古い曖昧", critical: true };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(base),
      structured({ questions: [questionOf("OI-1", "Q-1")] }),
      structured({ ambiguities: [outAmbiguity], unwritable: [{ ...accepted, id: "U-dup" }, empty] }),
    ]);
    const judge = createFakeJudge({
      ...catalogAnswers(),
      ...coverAnswers(["A:Q1-1"]),
      [surfaceTriageQuestionName(0)]: choice("vocabulary-hole", 0.9),
      [surfaceSupportQuestionName(0)]: choice("supports", 0.95),
    });
    const dir = `${directory}/dedup-constraint-stop`;
    const answersPath = "dedup-constraint-stop-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => SAMPLE_DOCUMENTS,
      makeClient: () => recording.client,
      makeLlmJudge: () => judge,
      now: () => 0,
      log: () => {},
    });

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.stage).toBe("surface");
    expect(record.failure?.kind).toBe("unmet");
    expect(record.failure?.problems).toEqual([{ field: "unwritable[1].constraintIds", code: "constraint-id-missing" }]);
    // 制約検査で止まっても、対象外の集合・分類と、識別済みの重複件数（原添字つき）が保存される
    const out = record.diff_reviews[0]?.out_of_scope;
    expect(out?.scanned).toBe(true);
    expect(out?.claims).toBe(2);
    expect(out?.ambiguities).toBe(1);
    expect(out?.deduped).toBe(1);
    expect(out?.rejected_claims).toBe(1);
    expect(out?.rejected_ambiguities).toBe(1);
    expect(out?.deduped_indexes).toEqual([0]);
    expect(out?.kinds.find((entry) => entry.kind === "source")).toEqual({ kind: "source", claims: 1, ambiguities: 1 });
    expect(out?.kinds.find((entry) => entry.kind === "unknown")?.claims).toBe(1);
    // 値は転記されない
    expect(JSON.stringify(record.diff_reviews)).not.toContain(MARK);
  });
});

// ── Issue #460：同じ ID の開いている事項の行の衝突を、値を含めずに plan-record に残す ──────────

describe("同じ ID の開いている事項の行の衝突を、値を含めずに plan-record に残す（Issue #460・#464）", () => {
  it("衝突した ID の件数・行の件数・帰属・0 行の件数・版が残り、duplicate-open-issue が other に消えず、値は転記されない", async () => {
    const mark = "MARK_CONFLICT_ZZZ";
    // モデルが、**見せていない**同じ ID の事項を同一応答内に 2 件返す（足す時点で衝突する）
    const surface = {
      ambiguities: [
        { id: "OI-dup", requirementId: "R-1", text: `${mark}の事項`, critical: true },
        { id: "OI-dup", requirementId: "R-1", text: `${mark}の事項 2`, critical: true },
      ],
      unwritable: [],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(surface),
    ]);
    const judge = createFakeJudge({ ...catalogUnspecifiedFor({ "R-1": ["period"] }) });
    const dir = `${directory}/open-issue-conflict`;
    const answersPath = "conflict-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
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
    // Build を流さない
    expect(spy).not.toHaveBeenCalled();
    const record = await readPlanRecord(dir);
    expect(record.outcome).toBe("cannot-confirm");
    // 新しい有限の分類は other に消えない
    expect(record.cannot_confirm).toEqual([{ source: "session", code: "duplicate-open-issue", path: "open_issues" }]);
    // 衝突の記録（件数と分類と版だけ。0 行の件数も残る）
    expect(record.open_issue_conflicts).toEqual({
      ids: 1,
      rows: [{ existing: "surface", added: "surface", count: 1 }],
      // 帰属の組（由来・状態・今回か以前か。足した順によらない）
      attribution: [
        {
          first: { origin: "surface", status: "open", current: true },
          second: { origin: "surface", status: "open", current: true },
          count: 1,
        },
      ],
      empty_targets: 0,
      round: 1,
    });
    // 新しい記録に、事項 ID・要件 ID・文の目印が出ない
    const conflictsText = JSON.stringify(record.open_issue_conflicts);
    expect(conflictsText).not.toContain(mark);
    expect(conflictsText).not.toContain("OI-dup");
    expect(conflictsText).not.toContain("R-1");
    // 使い回しの記録は、この衝突（見せていない ID）では空
    expect(record.surface_id_reuse).toEqual([]);
    // もともと値を保存する既存の欄は変えない（問いの事項 ID・一緒に閉じる ID・答えの本文の形はそのまま）
    expect(record.rounds).toEqual([]);
    expect(record.closed_by_default).toEqual([]);
    expect(record.closed_by_source).toEqual([]);
    expect(record.diff_reviews).toEqual([]);
  });
});

// ── Issue #461：引き継いだ観点の記録を plan-record に残す（値は転記しない）──────────────

describe("差分点検：引き継いだ観点の記録を plan-record に残す（04 §7・Issue #461）", () => {
  it("引き継いだ件数（種類・観点 ID）・親なし・親が複数・根拠が引けなかった件数（分類別）・開いた事項の出どころが残り、事項 ID・要件 ID・文・答えの目印は出ない", async () => {
    const sourceMark = "MARK_SOURCE_INHERIT";
    const answerMark = "MARK_ANSWER_INHERIT";
    const source = `${sourceMark}する。件数を合計する。`;
    const spanOf = (quote: string): { readonly start: number; readonly end: number } => {
      const start = source.indexOf(quote);
      return { start, end: start + quote.length };
    };
    const list = {
      requirements: [
        { id: "R-1", text: "印を出せる", quote: `${sourceMark}する`, position: spanOf(`${sourceMark}する`) },
        { id: "R-2", text: "件数を合計できる", quote: "件数を合計する", position: spanOf("件数を合計する") },
      ],
      framing: [],
      decisions: [],
      unresolved: [],
    };
    const inheritQuestions = {
      questions: [
        {
          id: "Q-1",
          openIssueId: "OI:catalog:R-1:aggregation",
          text: "どう数えますか",
          choices: [
            { id: "c1", text: `${answerMark}を数える` },
            { id: "c2", text: "自分のみ数える" },
          ],
          recommended: { choiceId: "c1", reason: "依頼に沿う" },
          allowFreeText: true,
        },
      ],
    };
    const recording = createRecordingClient([
      structured(list),
      structured(REVERSE_CHECK_OUTPUT),
      structured(SURFACE_CLEAR),
      structured(inheritQuestions),
      structured(SURFACE_CLEAR),
      ...recordedRunFromPlan(),
    ]);
    const judge = createFakeJudge({
      ...catalogUnspecifiedFor(
        { "R-1": ["aggregation"], "R:A:Q1-1": ["aggregation"] },
        ["R-1", "R-2", "R:A:Q1-1"],
      ),
      ...coverAnswers(["A:Q1-1"]),
    });
    const dir = `${directory}/inherit-record`;
    const answersPath = "inherit-answers.json";
    const spy = vi.spyOn(runModule, "runGeneration");

    await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : source),
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
    expect(record.diff_reviews).toHaveLength(1);
    // 引き継ぎの記録は、件数と有限の分類だけ（種類・観点 ID・出どころ別の件数）
    expect(record.diff_reviews[0]?.inherit).toEqual({
      facets: [{ kind: "a", facet_id: "aggregation", count: 1 }],
      no_parent: 0,
      multiple_parents: 0,
      unresolved: [
        { kind: "missing", count: 0 },
        { kind: "multiple", count: 0 },
        { kind: "mismatch", count: 0 },
      ],
      open_by_source: [
        { source: "catalog", count: 0 },
        { source: "surface", count: 0 },
        { source: "surface-check", count: 0 },
      ],
    });
    // 新しい記録に、事項 ID・要件 ID・文・答えの目印が出ない
    const inheritText = JSON.stringify(record.diff_reviews[0]?.inherit);
    expect(inheritText).not.toContain("OI:");
    expect(inheritText).not.toContain("R-1");
    expect(inheritText).not.toContain("R:A:");
    expect(inheritText).not.toContain(sourceMark);
    expect(inheritText).not.toContain(answerMark);
    // もともと値を持つ既存の欄は対象外——引き継ぎの記録は新しい欄だけに留まる
    expect(record.rounds).toHaveLength(1);
    expect(record.closed_by_default).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── Issue #464：使い回しで断った応答を、plan-record の新しい欄に残す ──────────────────

describe("使い回しで断った応答を、plan-record の新しい欄に残す（04 §7・Issue #464）", () => {
  /** 目録の period を未指定にする（コード作の事項 OI:catalog:R-1:period が、P3 に見せた ID になる） */
  const reuseJudge = () =>
    createFakeJudge({ ...catalogUnspecifiedFor({ "R-1": ["period"] }), ...coverAnswers([]) });

  /** 見せた ID（目録の開いている事項。仮の既定にも同じ ID が入る）を使い回した応答 */
  const reuseSurface = (mark = "MARK_REUSE_ZZZ") => ({
    ambiguities: [{ id: "OI:catalog:R-1:period", requirementId: "R-1", text: `${mark}の事項`, critical: false }],
    unwritable: [],
  });

  /** CLI を 1 回回して、plan-record を読む */
  async function runPlanOnce(dir: string, recording: ReturnType<typeof createRecordingClient>) {
    const answersPath = "answers.json";
    const code = await runCli({
      argv: ["--", "request.txt", "--out", dir, "--plan", "--answers", answersPath],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async (path) => (path === answersPath ? JSON.stringify({}) : SOURCE_TEXT),
      writeFile: async (path, text) => {
        await fs.writeFile(path, text, "utf8");
      },
      makeDirectory: async (path) => {
        await fs.mkdir(path, { recursive: true });
      },
      loadDocuments: async () => [],
      makeClient: () => recording.client,
      makeLlmJudge: () => reuseJudge(),
      now: () => 0,
      log: () => {},
    });
    return { code, record: await readPlanRecord(dir) };
  }

  it("1 回断って成功：断った件の記録（版・試行・応答の数・異なる数・提示元ごとの数）が残り、failure が無い", async () => {
    const mark = "MARK_REUSE_ZZZ";
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(reuseSurface(mark)),
      structured(SURFACE_CLEAR),
      ...recordedRunFromPlan(),
    ]);
    const { record } = await runPlanOnce(`${directory}/id-reuse-confirmed`, recording);

    expect(record.outcome).toBe("confirmed");
    // 確定したので failure が無い
    expect(record.failure).toBeUndefined();
    // 版 1・試行 1。同じ ID が目録と仮の既定の両方に当たるので、両方に数える
    expect(record.surface_id_reuse).toEqual([
      {
        check: 1,
        attempt: 1,
        responses: 1,
        distinct_ids: 1,
        by_source: [
          { source: "catalog", count: 1 },
          { source: "defaults", count: 1 },
          { source: "inherited", count: 0 },
          { source: "decisions", count: 0 },
        ],
      },
    ]);
    // 新しい欄に、事項 ID と文の目印が出ない
    const text = JSON.stringify(record.surface_id_reuse);
    expect(text).not.toContain(mark);
    expect(text).not.toContain("OI:catalog");
    expect(text).not.toContain("R-1");
  });

  it("2 回断って malformed：outcome は stopped、failure.kind は malformed、problems[].code は issue-id-reused", async () => {
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(reuseSurface()),
      structured(reuseSurface()),
    ]);
    const { code, record } = await runPlanOnce(`${directory}/id-reuse-malformed`, recording);

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(record.outcome).toBe("stopped");
    expect(record.failure?.kind).toBe("malformed");
    expect(record.failure?.problems?.some((problem) => problem.code === "issue-id-reused")).toBe(true);
    // 版 1・試行 1 と 2 の両方が残る
    expect(record.surface_id_reuse.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(record.surface_id_reuse.every((entry) => entry.check === 1 && entry.distinct_ids === 1)).toBe(true);
  });

  it("断ったあとに途中で止まったときは、実際の最終の分類（制約の未達）を保ち、issue-id-reused に置き換えない。断った履歴は別の欄に残る", async () => {
    // 1 回目：使い回しで断る。2 回目：形は正しいが、制約 ID が無い（制約の検査で未達）
    const badConstraint = {
      ambiguities: [],
      unwritable: [
        { id: "U-1", requirementId: "R-2", part: "部分", constraintIds: [], reason: "理由", alternative: "代わり" },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(reuseSurface()),
      structured(badConstraint),
    ]);
    const { code, record } = await runPlanOnce(`${directory}/id-reuse-stop`, recording);

    expect(code).toBe(EXIT_RUN_FAILED);
    expect(record.outcome).toBe("stopped");
    // 最終の失敗は、制約の未達（使い回しに置き換えない）
    expect(record.failure?.kind).toBe("unmet");
    expect(record.failure?.problems?.some((problem) => problem.code === "constraint-id-missing")).toBe(true);
    expect(record.failure?.problems?.some((problem) => problem.code === "issue-id-reused")).toBe(false);
    // 断った履歴は、最終の失敗の欄とは別の欄に残る
    expect(record.surface_id_reuse).toHaveLength(1);
    expect(record.surface_id_reuse[0]?.distinct_ids).toBe(1);
  });
});
