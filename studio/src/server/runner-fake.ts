// 試験用の偽の走らせる役（Issue #866 の目的・2）。工場は呼ばない。
//
// 既定の台本：開始で進みと質問 → 答えで確認 → 「作る」で進みと結果。
// `outcome` で差し戻し・失敗を選べる。`deferFinish` を真にすると「作成中」のまま止まり、
// `finish()` を呼ぶまで終わらない（状態の移りを 1 つずつ読む試験のため）。
import type {
  ConfirmOutcome,
  Runner,
  RunnerAnswers,
  RunnerConfirmation,
  RunnerEvent,
  RunnerNotify,
  RunnerProgress,
  RunnerQuestionBundle,
  RunnerResult,
  RunnerStartInput,
  StopReason,
} from "./runner.js";

/** 既定の質問（利用者の言葉。宣言の用語を使わない） */
export const DEFAULT_FAKE_QUESTION: RunnerQuestionBundle = {
  revision: 1,
  remaining: { questions: 8, roundTrips: 3 },
  questions: [
    {
      id: "q1",
      text: "一覧はどの順に並べますか？",
      choices: [
        { id: "newest", text: "新しい順" },
        { id: "oldest", text: "古い順" },
      ],
      recommended: { choiceId: "newest", reason: "最近のものから見られるから" },
      allowFreeText: true,
    },
  ],
};

/** 既定の確認 */
export const DEFAULT_FAKE_CONFIRMATION: RunnerConfirmation = {
  requirements: ["一覧を新しい順に並べる", "題名と日付を表示する"],
  diff: {
    added: ["題名と日付を表示する"],
    changed: [],
    removed: [],
  },
  limitations: [{ what: "写真の添付", alternative: "題名に写真の名前を書く" }],
  decided: ["画面の名前は「一覧」にする"],
};

/** 既定の結果 */
export const DEFAULT_FAKE_RESULT: RunnerResult = {
  verdict: "full",
  content: ["依頼どおりに作りました。", "一覧を開いて確かめられます。"],
};

/** 偽の走らせる役の台本 */
export interface FakeRunnerOptions {
  readonly question?: RunnerQuestionBundle;
  readonly confirmation?: RunnerConfirmation;
  readonly result?: RunnerResult;
  /** 確認のあとの終わり方（既定は結果まで） */
  readonly outcome?: "finish" | "sent-back" | "fail";
  /** 終わりに報告する実額（既定 0.42） */
  readonly spentUsd?: number;
  /** 開始のときに出す進み（null なら出さない） */
  readonly startProgress?: RunnerProgress | null;
  /** 「作る」のあと、終わらせずに「作成中」のまま止まる */
  readonly deferFinish?: boolean;
}

interface StartCall {
  readonly jobId: string;
  readonly request: string;
}

interface AnswerCall {
  readonly jobId: string;
  readonly answers: RunnerAnswers;
}

interface ConfirmCall {
  readonly jobId: string;
  readonly outcome: ConfirmOutcome;
}

interface CancelCall {
  readonly jobId: string;
  readonly reason: StopReason;
}

/** 偽の走らせる役。呼ばれた回数と中身を記録し、状態の移りを試験から読めるようにする。 */
export class FakeRunner implements Runner {
  private readonly options: FakeRunnerOptions;
  private readonly notifiers = new Map<string, RunnerNotify>();
  private readonly startCalls: StartCall[] = [];
  private readonly answerCalls: AnswerCall[] = [];
  private readonly confirmCalls: ConfirmCall[] = [];
  private readonly cancelCalls: CancelCall[] = [];

  constructor(options: FakeRunnerOptions = {}) {
    this.options = options;
  }

  /** 開始の呼び出しの記録 */
  get starts(): readonly StartCall[] {
    return this.startCalls;
  }

  /** 答えの呼び出しの記録 */
  get answers(): readonly AnswerCall[] {
    return this.answerCalls;
  }

  /** 確認の呼び出しの記録 */
  get confirms(): readonly ConfirmCall[] {
    return this.confirmCalls;
  }

  /** 取り消しの呼び出しの記録 */
  get cancels(): readonly CancelCall[] {
    return this.cancelCalls;
  }

  start(input: RunnerStartInput): void {
    this.startCalls.push({ jobId: input.jobId, request: input.request });
    this.notifiers.set(input.jobId, input.notify);
    const startProgress = this.options.startProgress === undefined
      ? { stage: "要件を整理しています", estimatedUsd: 0.05 }
      : this.options.startProgress;
    if (startProgress !== null) this.emit(input.jobId, { kind: "progress", progress: startProgress });
    this.emit(input.jobId, { kind: "question", question: this.options.question ?? DEFAULT_FAKE_QUESTION });
  }

  answer(jobId: string, answers: RunnerAnswers): void {
    this.answerCalls.push({ jobId, answers });
    this.emit(jobId, { kind: "confirmation", confirmation: this.options.confirmation ?? DEFAULT_FAKE_CONFIRMATION });
  }

  confirm(jobId: string, outcome: ConfirmOutcome): void {
    this.confirmCalls.push({ jobId, outcome });
    if (outcome !== "build") return;
    this.emit(jobId, {
      kind: "progress",
      progress: { stage: "作っています", estimatedUsd: this.options.spentUsd ?? 0.42 },
    });
    if (this.options.deferFinish === true) return;
    this.end(jobId);
  }

  cancel(jobId: string, reason: StopReason): void {
    this.cancelCalls.push({ jobId, reason });
  }

  /** 「作成中」のまま止めた走りを、台本どおりに終わらせる */
  finish(jobId: string): void {
    this.emit(jobId, {
      kind: "finished",
      result: this.options.result ?? DEFAULT_FAKE_RESULT,
      spentUsd: this.options.spentUsd ?? 0.42,
    });
  }

  /** 差し戻しを返す */
  sendBack(jobId: string, reason = "仕様を決め直したい"): void {
    this.emit(jobId, { kind: "sent-back", reason, spentUsd: this.options.spentUsd ?? 0.42 });
  }

  /** 失敗を返す */
  fail(jobId: string, reason = "工場の走りが失敗した"): void {
    this.emit(jobId, { kind: "failed", reason, spentUsd: this.options.spentUsd ?? 0.42 });
  }

  /** 工場の失敗ではない止まり方（要件を固めきれなかった・費用の上限・時間切れ）を返す */
  stop(jobId: string, reason: StopReason, codes: readonly string[] = []): void {
    this.emit(jobId, {
      kind: "stopped",
      reason,
      note: null,
      codes,
      spentUsd: this.options.spentUsd ?? 0.42,
    });
  }

  private end(jobId: string): void {
    const outcome = this.options.outcome ?? "finish";
    if (outcome === "sent-back") {
      this.sendBack(jobId);
      return;
    }
    if (outcome === "fail") {
      this.fail(jobId);
      return;
    }
    this.finish(jobId);
  }

  private emit(jobId: string, event: RunnerEvent): void {
    this.notifiers.get(jobId)?.(event);
  }
}

/** 偽の走らせる役を作る */
export function createFakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  return new FakeRunner(options);
}
