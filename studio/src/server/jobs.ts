// ジョブの管理（Issue #866 の目的・3〜6）。1 回の依頼を 1 つのジョブにし、状態の移りを
// 画面が短い間隔の問い合わせで読めるようにする。走らせる役（runner）は口だけに頼る。
//
//   - 同時に走るジョブは 1 本だけ
//   - 費用の台帳で 2.00 を予約し、終わりで実額に置き換える（断るのは台帳の仕事）
//   - 質問待ち・確認待ちは 30 分で期限。過ぎたら走らせる役を取り消して「止めた（答えの待ちの上限）」
//   - 記録は JobStore に書き、再起動で履歴を戻す。走っていたジョブは「止めた」にする
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ANSWER_WAIT_MS,
  MAX_FREE_TEXT_CHARS,
  MAX_REQUEST_CHARS,
  PER_RUN_LIMIT_USD,
  isActiveJobState,
  type AnswersRequest,
  type BudgetView,
  type ConfirmOutcome,
  type JobState,
  type JobView,
  type Runner,
  type RunnerAnswers,
  type RunnerEvent,
  type RunnerQuestionBundle,
  type StopReason,
} from "./runner.js";
import { LEDGER_FILE, Ledger } from "./ledger.js";
import { JobStore, type StoredJob } from "./store.js";
import { buildBudgetView, buildJobView } from "./view.js";

/** 書き換えられるジョブ（保存の形は読み取り専用なので、こちらで持つ） */
type JobRecord = { -readonly [K in keyof StoredJob]: StoredJob[K] };

/** API の誤り（routes.ts が HTTP の状態に写す） */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface JobsOptions {
  /** 記録の置き場所（リポジトリの外） */
  readonly home: string;
  readonly runner: Runner;
  /** いまの時刻（試験は固定する） */
  readonly now?: () => number;
  /** 保存先を差し替える（試験用） */
  readonly store?: JobStore;
  /** 台帳を差し替える（試験用） */
  readonly ledger?: Ledger;
}

interface AnswerProblem {
  readonly code: string;
  readonly message: string;
}

const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["result", "sent-back", "published", "stopped", "failed"]);

/** 答えをコードで確かめる（工場に渡す前に断る。Issue #866 の目的・8） */
export function validateAnswers(
  bundle: RunnerQuestionBundle,
  request: AnswersRequest,
): readonly AnswerProblem[] {
  if (request.revision !== bundle.revision) {
    return [{ code: "stale-revision", message: `古い版への答えである（いまの版 ${bundle.revision}、答えの版 ${request.revision}）` }];
  }
  if (request.kind === "all-recommended") return [];
  if (request.answers.length === 0) {
    return [{ code: "shape", message: "答えが 1 つも無い" }];
  }

  for (const answer of request.answers) {
    const question = bundle.questions.find((candidate) => candidate.id === answer.questionId);
    if (question === undefined) {
      return [{ code: "unknown-question", message: `${answer.questionId}: 質問に無い` }];
    }
    const hasChoice = answer.choiceId !== undefined;
    const hasFreeText = answer.freeText !== undefined;
    if (hasChoice === hasFreeText) {
      return [{ code: "shape", message: `${answer.questionId}: 選択肢か自由入力のちょうど一方を書く` }];
    }
    if (hasChoice && !question.choices.some((choice) => choice.id === answer.choiceId)) {
      return [{ code: "unknown-choice", message: `${answer.choiceId ?? ""}: その質問の選択肢に無い` }];
    }
    if (hasFreeText && (answer.freeText ?? "").length > MAX_FREE_TEXT_CHARS) {
      return [{ code: "free-text-length", message: `自由入力が長すぎる（上限 ${MAX_FREE_TEXT_CHARS}）` }];
    }
  }
  return [];
}

/**
 * ジョブの管理。状態の変化はそのつど JobStore に保存する。
 * `get` と `list` は問い合わせのたびに答えの期限を照らす（短い間隔の問い合わせが期限を進める）。
 */
export class Jobs {
  private readonly clock: () => number;
  private readonly runner: Runner;
  private readonly store: JobStore;
  private readonly ledger: Ledger;
  private readonly jobs = new Map<string, JobRecord>();

  constructor(options: JobsOptions) {
    this.clock = options.now ?? (() => Date.now());
    this.runner = options.runner;
    this.store = options.store ?? new JobStore(options.home);
    this.ledger = options.ledger ?? new Ledger(join(options.home, LEDGER_FILE), this.clock);

    for (const stored of this.store.list()) {
      this.jobs.set(stored.id, { ...stored });
    }
    this.recover();
  }

  /** 依頼を始める。`POST /api/jobs` */
  start(request: string): JobView {
    if (request.trim() === "") throw new ApiError(400, "empty-request", "依頼文が空である");
    if (request.length > MAX_REQUEST_CHARS) {
      throw new ApiError(400, "request-too-long", `依頼文が長すぎる（上限 ${MAX_REQUEST_CHARS} 文字）`);
    }
    if (this.activeJob() !== undefined) {
      throw new ApiError(409, "busy", "同時に走れるジョブは 1 本だけである");
    }
    if (!this.ledger.canStart(this.clock())) {
      throw new ApiError(409, "budget", "今日の費用の上限に達している");
    }

    const now = this.clock();
    const job: JobRecord = {
      id: randomUUID(),
      request,
      state: "received",
      stopReason: null,
      stopReasonCodes: [],
      createdAt: now,
      updatedAt: now,
      answerDeadlineAt: null,
      question: null,
      turns: [],
      confirmation: null,
      progress: null,
      result: null,
      reservedUsd: PER_RUN_LIMIT_USD,
      estimatedUsd: 0,
      spentUsd: null,
      note: null,
    };
    this.jobs.set(job.id, job);
    this.ledger.reserve(job.id, PER_RUN_LIMIT_USD);
    this.persist(job);

    this.callRunner(() => this.runner.start({ jobId: job.id, request, notify: (event) => this.onEvent(job, event) }), job);
    return buildJobView(job, this.clock());
  }

  /** ジョブの状態を読む。無ければ null。`GET /api/jobs/:id` */
  get(id: string): JobView | null {
    const job = this.jobs.get(id);
    if (job === undefined) return null;
    this.expire(job);
    return buildJobView(job, this.clock());
  }

  /** 履歴（新しい順）。`GET /api/jobs` */
  list(): readonly JobView[] {
    this.expireAll();
    return [...this.jobs.values()]
      // oxlint-disable-next-line unicorn/no-array-sort -- 写しを並べ替えるだけ（ES2022 の lib に toSorted が無い）
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((job) => buildJobView(job, this.clock()));
  }

  /** 費用の状態。`GET /api/budget` */
  budget(): BudgetView {
    this.expireAll();
    return buildBudgetView(this.ledger.summary(this.clock()));
  }

  /** 質問に答える。`POST /api/jobs/:id/answers` */
  answer(id: string, request: AnswersRequest): JobView {
    const job = this.requireJob(id);
    this.expire(job);
    if (job.state !== "awaiting-answer" || job.question === null) {
      throw new ApiError(409, "not-awaiting-answer", "質問待ちではない");
    }

    const problems = validateAnswers(job.question, request);
    if (problems.length > 0) {
      const first = problems[0] as AnswerProblem;
      throw new ApiError(400, first.code, first.message);
    }

    job.state = "thinking";
    job.question = null;
    job.answerDeadlineAt = null;
    this.recordAnswers(job, request, this.clock());
    job.updatedAt = this.clock();
    this.persist(job);

    const answers: RunnerAnswers =
      request.kind === "answers"
        ? { kind: "answers", revision: request.revision, answers: request.answers }
        : { kind: "all-recommended", revision: request.revision };
    this.callRunner(() => this.runner.answer(job.id, answers), job);
    return buildJobView(job, this.clock());
  }

  /** 確認に答える。`POST /api/jobs/:id/confirm` */
  confirm(id: string, outcome: ConfirmOutcome): JobView {
    const job = this.requireJob(id);
    this.expire(job);
    if (job.state !== "awaiting-confirm") {
      throw new ApiError(409, "not-awaiting-confirm", "確認待ちではない");
    }

    if (outcome === "stop") {
      job.updatedAt = this.clock();
      this.stopJob(job, "cancel", false);
      this.callRunner(() => this.runner.confirm(job.id, "stop"), job);
      return buildJobView(job, this.clock());
    }

    job.state = "building";
    job.confirmation = null;
    job.answerDeadlineAt = null;
    job.updatedAt = this.clock();
    this.persist(job);
    this.callRunner(() => this.runner.confirm(job.id, "build"), job);
    return buildJobView(job, this.clock());
  }

  /** 走りを取り消す。`POST /api/jobs/:id/cancel` */
  cancel(id: string): JobView {
    const job = this.requireJob(id);
    if (!isActiveJobState(job.state)) {
      throw new ApiError(409, "not-running", "走っていない");
    }
    this.stopJob(job, "cancel", true);
    return buildJobView(job, this.clock());
  }

  private requireJob(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (job === undefined) throw new ApiError(404, "not_found", `ジョブが無い: ${id}`);
    return job;
  }

  /** 走っているジョブ（同時に 1 本だけ） */
  private activeJob(): JobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (isActiveJobState(job.state)) return job;
    }
    return undefined;
  }

  /** 起動時の復元（Issue #866 の目的・3）。走っていたジョブを止め、未決の予約を概算で締める。 */
  private recover(): void {
    for (const job of this.jobs.values()) {
      if (!isActiveJobState(job.state)) continue;
      job.state = "stopped";
      job.stopReason = "cancel";
      job.stopReasonCodes = [];
      job.answerDeadlineAt = null;
      job.question = null;
      job.confirmation = null;
      job.updatedAt = this.clock();
      this.persist(job);
    }
    for (const open of this.ledger.openReservations()) {
      const job = this.jobs.get(open.jobId);
      const estimate = job?.progress?.estimatedUsd ?? job?.estimatedUsd ?? 0;
      this.ledger.settle(open.jobId, estimate, true);
      // 保存したジョブにも概算の額を残す（同じ予約を二重に締めない。表示には出さない）
      if (job !== undefined && job.spentUsd === null) {
        job.spentUsd = estimate;
        this.persist(job);
      }
    }
  }

  /** 走らせる役からの通知 */
  private onEvent(job: JobRecord, event: RunnerEvent): void {
    if (TERMINAL_STATES.has(job.state)) return;
    const now = this.clock();

    switch (event.kind) {
      case "progress":
        job.progress = event.progress;
        job.estimatedUsd = event.progress.estimatedUsd;
        if (job.state === "received") job.state = "thinking";
        job.updatedAt = now;
        this.persist(job);
        return;
      case "question":
        job.state = "awaiting-answer";
        job.question = event.question;
        job.turns = [
          ...job.turns,
          {
            revision: event.question.revision,
            questions: event.question.questions,
            answers: [],
            allRecommended: false,
            askedAt: now,
            answeredAt: null,
          },
        ];
        job.confirmation = null;
        job.answerDeadlineAt = now + ANSWER_WAIT_MS;
        job.updatedAt = now;
        this.persist(job);
        return;
      case "confirmation":
        job.state = "awaiting-confirm";
        job.confirmation = event.confirmation;
        job.question = null;
        job.answerDeadlineAt = now + ANSWER_WAIT_MS;
        job.updatedAt = now;
        this.persist(job);
        return;
      case "finished":
        this.finish(job, event.result, event.spentUsd);
        return;
      case "sent-back":
        job.state = "sent-back";
        job.stopReason = null;
        job.stopReasonCodes = [];
        job.note = event.reason;
        job.result = null;
        this.clearWait(job);
        this.closeLedger(job, event.spentUsd, false);
        job.updatedAt = now;
        this.persist(job);
        return;
      case "stopped":
        job.state = "stopped";
        job.stopReason = event.reason;
        job.stopReasonCodes = event.codes;
        job.note = event.note;
        job.result = null;
        this.clearWait(job);
        this.closeLedger(job, event.spentUsd, false);
        job.updatedAt = now;
        this.persist(job);
        return;
      case "failed":
        job.state = "failed";
        job.stopReason = "factory-failure";
        job.stopReasonCodes = [];
        job.note = event.reason;
        job.result = null;
        this.clearWait(job);
        this.closeLedger(job, event.spentUsd, false);
        job.updatedAt = now;
        this.persist(job);
    }
  }

  private finish(job: JobRecord, result: NonNullable<JobRecord["result"]>, spentUsd: number): void {
    job.state = "result";
    job.stopReason = null;
    job.stopReasonCodes = [];
    job.result = result;
    this.clearWait(job);
    this.closeLedger(job, spentUsd, false);
    job.updatedAt = this.clock();
    this.persist(job);
  }

  /** 走りを止める（取り消し・答えの待ちの上限）。予約は最後の概算で締める。 */
  private stopJob(job: JobRecord, reason: StopReason, cancelRunner: boolean): void {
    job.state = "stopped";
    job.stopReason = reason;
    job.stopReasonCodes = [];
    this.clearWait(job);
    this.closeLedger(job, job.progress?.estimatedUsd ?? job.estimatedUsd, true);
    job.updatedAt = this.clock();
    this.persist(job);
    if (cancelRunner) this.callRunner(() => this.runner.cancel(job.id, reason), job);
  }

  /** 答えの期限を過ぎたジョブを止める（29 分では止めない） */
  private expire(job: JobRecord): void {
    if (!isActiveJobState(job.state) || job.answerDeadlineAt === null) return;
    if (this.clock() < job.answerDeadlineAt) return;
    this.stopJob(job, "answer-timeout", true);
  }

  private expireAll(): void {
    const now = this.clock();
    for (const job of this.jobs.values()) {
      if (!isActiveJobState(job.state) || job.answerDeadlineAt === null) continue;
      if (now >= job.answerDeadlineAt) this.stopJob(job, "answer-timeout", true);
    }
  }

  private clearWait(job: JobRecord): void {
    job.question = null;
    job.confirmation = null;
    job.answerDeadlineAt = null;
  }

  /** 答えを受けた往復を記録する（質問の版が合う、まだ答えていない往復） */
  private recordAnswers(job: JobRecord, request: AnswersRequest, at: number): void {
    let index = -1;
    for (let i = job.turns.length - 1; i >= 0; i -= 1) {
      const turn = job.turns[i];
      if (turn !== undefined && turn.revision === request.revision && turn.answeredAt === null) {
        index = i;
        break;
      }
    }
    if (index < 0) return;

    const answers = request.kind === "answers" ? request.answers : [];
    const allRecommended = request.kind === "all-recommended";
    job.turns = job.turns.map((turn, position) =>
      position === index ? { ...turn, answers, allRecommended, answeredAt: at } : turn,
    );
  }

  /** 台帳の予約を締める（二重に締めない） */
  private closeLedger(job: JobRecord, usd: number, estimated: boolean): void {
    if (job.spentUsd !== null) return;
    job.spentUsd = usd;
    this.ledger.settle(job.id, usd, estimated);
  }

  /** 走らせる役の失敗を、ジョブの失敗にする（予約は概算で締める） */
  private failJob(job: JobRecord, error: unknown): void {
    if (TERMINAL_STATES.has(job.state)) return;
    job.state = "failed";
    job.stopReason = "factory-failure";
    job.stopReasonCodes = [];
    job.note = error instanceof Error ? error.message : String(error);
    this.clearWait(job);
    this.closeLedger(job, job.progress?.estimatedUsd ?? job.estimatedUsd, true);
    job.updatedAt = this.clock();
    this.persist(job);
  }

  /** 走らせる役の同期の失敗・非同期の失敗を、どちらもジョブの失敗にする */
  private callRunner(call: () => void | Promise<void>, job: JobRecord): void {
    try {
      const pending = call();
      if (pending instanceof Promise) {
        pending.catch((error: unknown) => this.failJob(job, error));
      }
    } catch (error) {
      this.failJob(job, error);
    }
  }

  private persist(job: JobRecord): void {
    this.store.save(job);
  }
}
