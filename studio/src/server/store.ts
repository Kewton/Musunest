// ジョブの保存（Issue #866 の目的・3）。記録の置き場所の下にジョブごとのディレクトリを作り、
// 依頼文・状態・往復・結果の要約を置く。サーバを再起動しても履歴が読めるようにする。
//
// **記録はリポジトリの外に書く**（studio-s1.md §3・§8）。置き場所は呼ぶ側（main.ts）が
// `resolveStudioHome()` で決め、試験は一時ディレクトリを渡す。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { JOB_STATES, STOP_REASONS } from "./runner.js";
import type {
  JobState,
  RunnerConfirmation,
  RunnerProgress,
  RunnerQuestion,
  RunnerQuestionBundle,
  RunnerResult,
  StopReason,
  SubmittedAnswer,
} from "./runner.js";

/** 往復 1 つ（質問と、それへの答え） */
export interface StoredTurn {
  readonly revision: number;
  readonly questions: readonly RunnerQuestion[];
  readonly answers: readonly SubmittedAnswer[];
  /** 「全部推奨で進める」で答えたか */
  readonly allRecommended: boolean;
  readonly askedAt: number;
  /** 答えを受けた時刻（まだなら null） */
  readonly answeredAt: number | null;
}

/** 保存するジョブ（依頼文は `request.txt`、ほかは `job.json` に置く） */
export interface StoredJob {
  readonly id: string;
  readonly request: string;
  readonly state: JobState;
  readonly stopReason: StopReason | null;
  /**
   * 止めた理由の符号の並び（Issue #886 の目的・2）。ジョブの記録にだけ残し、画面へは出さない。
   * 符号の欄の無い古い記録は空の並びとして読む。
   */
  readonly stopReasonCodes: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 答えの期限の時刻（ミリ秒。質問待ち・確認待ちでだけ値を持つ） */
  readonly answerDeadlineAt: number | null;
  readonly question: RunnerQuestionBundle | null;
  /** これまでの往復（質問と答え） */
  readonly turns: readonly StoredTurn[];
  readonly confirmation: RunnerConfirmation | null;
  readonly progress: RunnerProgress | null;
  readonly result: RunnerResult | null;
  /** 台帳に予約した額（USD） */
  readonly reservedUsd: number;
  /** 進みから分かる最後の概算の額（USD） */
  readonly estimatedUsd: number;
  /** 実際に使った額（終わったときだけ値を持つ） */
  readonly spentUsd: number | null;
  /** 差し戻し・失敗の理由（利用者に見せる言葉） */
  readonly note: string | null;
}

/** `job.json` に書く中身（依頼文は別のファイル。符号の欄は古い記録に無いことがある） */
type SerializedJob = Omit<StoredJob, "request" | "stopReasonCodes"> & {
  readonly stopReasonCodes?: readonly string[];
};

const JOB_ID = /^[A-Za-z0-9-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isQuestion = (value: unknown): value is RunnerQuestion => {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.text !== "string") return false;
  if (!Array.isArray(value.choices)) return false;
  if (!value.choices.every((choice) => isRecord(choice) && typeof choice.id === "string" && typeof choice.text === "string")) {
    return false;
  }
  const recommended = value.recommended;
  if (!isRecord(recommended) || typeof recommended.choiceId !== "string" || typeof recommended.reason !== "string") {
    return false;
  }
  return typeof value.allowFreeText === "boolean";
};

const isQuestionBundle = (value: unknown): value is RunnerQuestionBundle => {
  if (!isRecord(value)) return false;
  if (typeof value.revision !== "number" || !Array.isArray(value.questions)) return false;
  const remaining = value.remaining;
  if (!isRecord(remaining) || typeof remaining.questions !== "number" || typeof remaining.roundTrips !== "number") {
    return false;
  }
  return value.questions.every(isQuestion);
};

const isSubmittedAnswer = (value: unknown): value is SubmittedAnswer =>
  isRecord(value) &&
  typeof value.questionId === "string" &&
  (value.choiceId === undefined || typeof value.choiceId === "string") &&
  (value.freeText === undefined || typeof value.freeText === "string");

const isStoredTurn = (value: unknown): value is StoredTurn =>
  isRecord(value) &&
  typeof value.revision === "number" &&
  Array.isArray(value.questions) &&
  value.questions.every(isQuestion) &&
  Array.isArray(value.answers) &&
  value.answers.every(isSubmittedAnswer) &&
  typeof value.allRecommended === "boolean" &&
  typeof value.askedAt === "number" &&
  (value.answeredAt === null || typeof value.answeredAt === "number");

const isConfirmation = (value: unknown): value is RunnerConfirmation => {
  if (!isRecord(value)) return false;
  if (!isStringArray(value.requirements) || !isStringArray(value.decided)) return false;
  const diff = value.diff;
  if (!isRecord(diff) || !isStringArray(diff.added) || !isStringArray(diff.changed) || !isStringArray(diff.removed)) {
    return false;
  }
  if (!Array.isArray(value.limitations)) return false;
  return value.limitations.every(
    (entry) => isRecord(entry) && typeof entry.what === "string" && typeof entry.alternative === "string",
  );
};

const isProgress = (value: unknown): value is RunnerProgress =>
  isRecord(value) && typeof value.stage === "string" && typeof value.estimatedUsd === "number";

const isResult = (value: unknown): value is RunnerResult =>
  isRecord(value) &&
  (value.verdict === "full" || value.verdict === "partial" || value.verdict === "none") &&
  isStringArray(value.content);

const isStoredJob = (value: unknown): value is SerializedJob => {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.state !== "string") return false;
  if (!(JOB_STATES as readonly string[]).includes(value.state)) return false;
  if (value.stopReason !== null && !(STOP_REASONS as readonly string[]).includes(value.stopReason as string)) {
    return false;
  }
  if (value.stopReasonCodes !== undefined && !isStringArray(value.stopReasonCodes)) return false;
  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return false;
  if (typeof value.reservedUsd !== "number" || typeof value.estimatedUsd !== "number") return false;
  if (value.answerDeadlineAt !== null && typeof value.answerDeadlineAt !== "number") return false;
  if (value.spentUsd !== null && typeof value.spentUsd !== "number") return false;
  if (value.note !== null && typeof value.note !== "string") return false;
  if (value.question !== null && !isQuestionBundle(value.question)) return false;
  if (!Array.isArray(value.turns) || !value.turns.every(isStoredTurn)) return false;
  if (value.confirmation !== null && !isConfirmation(value.confirmation)) return false;
  if (value.progress !== null && !isProgress(value.progress)) return false;
  if (value.result !== null && !isResult(value.result)) return false;
  return true;
};

/**
 * ジョブの保存。`<baseDir>/jobs/<id>/request.txt` と `<baseDir>/jobs/<id>/job.json` を使う。
 * 1 つのジョブの書き込みは仮ファイルに書いてから rename する（途中の書きかけを読ませない）。
 */
export class JobStore {
  private readonly jobsDir: string;

  constructor(baseDir: string) {
    this.jobsDir = join(baseDir, "jobs");
  }

  /** 保存する。新しいジョブならディレクトリも作る */
  save(job: StoredJob): void {
    if (!JOB_ID.test(job.id)) throw new Error(`ジョブの ID に使えない文字がある: ${job.id}`);
    const directory = join(this.jobsDir, job.id);
    mkdirSync(directory, { recursive: true });
    this.writeAtomic(join(directory, "request.txt"), job.request);
    const serialized: SerializedJob = {
      id: job.id,
      state: job.state,
      stopReason: job.stopReason,
      stopReasonCodes: job.stopReasonCodes,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      answerDeadlineAt: job.answerDeadlineAt,
      question: job.question,
      turns: job.turns,
      confirmation: job.confirmation,
      progress: job.progress,
      result: job.result,
      reservedUsd: job.reservedUsd,
      estimatedUsd: job.estimatedUsd,
      spentUsd: job.spentUsd,
      note: job.note,
    };
    this.writeAtomic(join(directory, "job.json"), JSON.stringify(serialized, null, 2));
  }

  /** 1 つのジョブを読む。無い・壊れているなら null */
  load(id: string): StoredJob | null {
    if (!JOB_ID.test(id)) return null;
    const directory = join(this.jobsDir, id);
    const jsonPath = join(directory, "job.json");
    const requestPath = join(directory, "request.txt");
    if (!existsSync(jsonPath) || !existsSync(requestPath)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      return null;
    }
    if (!isStoredJob(parsed) || parsed.id !== id) return null;

    return {
      ...parsed,
      stopReasonCodes: parsed.stopReasonCodes ?? [],
      request: readFileSync(requestPath, "utf8"),
    };
  }

  /** 保存されているすべてのジョブ（新しい順） */
  list(): readonly StoredJob[] {
    if (!existsSync(this.jobsDir)) return [];
    const jobs: StoredJob[] = [];
    for (const entry of readdirSync(this.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = this.load(entry.name);
      if (job !== null) jobs.push(job);
    }
    jobs.sort((left, right) => right.createdAt - left.createdAt);
    return jobs;
  }

  /** ジョブのディレクトリが置かれている根（試験がリポジトリの外を確かめるため） */
  get directory(): string {
    return this.jobsDir;
  }

  private writeAtomic(path: string, content: string): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  }
}
