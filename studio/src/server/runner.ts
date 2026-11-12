// 画面とサーバの間の型（共有）と、走らせる役の口（port）。
//
// 工場を実際に呼ぶ部分は口の向こうに置き、この Issue では偽物だけで試す（Issue #866 の禁止事項
// 「工場を変えない・この Issue では工場を呼ばない」）。
//
// **共有の型をこの file に置く理由。** studio/tsconfig.json の `include` は `src/index.ts` と
// `src/server/**/*` だけで、`src/shared` は入っていない。合成プロジェクト（`composite`）は
// プログラムに入る file をすべて include で列挙することを要求するため、`src/server` から
// `src/shared/api.ts` を直接 import すると TS6307 で typecheck が落ちる。`studio/tsconfig.json` は
// この Issue の変更範囲の外なので、共有の型は `src/server` の中の**実行時の依存を持たない**この file に
// 置き、`src/shared/api.ts` がここを再輸出する（画面側の import の入口は今までどおり `shared/api.ts`）。
//
// 表示用の欄には宣言の用語（entity・computed など）を入れない（04-plan-agent.md §3）。
// 状態・理由・結果の判定は、コードの値（英字）と表示の言葉（日本語）を分けて持つ。
import type { PublishRecord } from "./publish.js";

// ── 上限と定数（所有者の決定。2026-11-11）─────────────────────────────

/** 費用の上限（studio-s1.md §2 D3・§5） */
export const PER_RUN_LIMIT_USD = 2;
export const DAILY_LIMIT_USD = 4;

/** 答えの待ちの上限（studio-s1.md §4.1「答えの待ち 1 回 30 分」） */
export const ANSWER_WAIT_MINUTES = 30;
export const ANSWER_WAIT_MS = ANSWER_WAIT_MINUTES * 60 * 1000;

/** 依頼文の長さの上限（工場の入口と同じ 4,000 文字。packages/factory/src/limits.ts の requestTextChars） */
export const MAX_REQUEST_CHARS = 4_000;

/** 自由入力の長さの上限（工場の planFreeTextChars） */
export const MAX_FREE_TEXT_CHARS = 500;

// ── ジョブの状態（Issue #866 の目的・1）──────────────────────────────

export const JOB_STATES = [
  "received", // 依頼を受けた
  "thinking", // 考え中
  "awaiting-answer", // 質問待ち
  "awaiting-confirm", // 確認待ち
  "building", // 作成中
  "result", // 結果
  "sent-back", // 差し戻し（工場がもう一度聞き直したいと返した）
  "published", // 公開済み
  "stopped", // 止めた
  "failed", // 失敗
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** 状態の表示の言葉（利用者の言葉。宣言の用語を使わない） */
export const JOB_STATE_LABELS = {
  received: "依頼を受けた",
  thinking: "考え中",
  "awaiting-answer": "質問待ち",
  "awaiting-confirm": "確認待ち",
  building: "作成中",
  result: "結果",
  "sent-back": "差し戻し",
  published: "公開済み",
  stopped: "止めた",
  failed: "失敗",
} as const satisfies Record<JobState, string>;

/** 走りが続いている状態（同時に走るのは 1 本だけ。Issue #866 の 5） */
export const ACTIVE_JOB_STATES = [
  "received",
  "thinking",
  "awaiting-answer",
  "awaiting-confirm",
  "building",
] as const;
export type ActiveJobState = (typeof ACTIVE_JOB_STATES)[number];

export function isActiveJobState(state: JobState): state is ActiveJobState {
  return (ACTIVE_JOB_STATES as readonly string[]).includes(state);
}

/** 止めた理由の分類（Issue #866 の目的・1・Issue #886 の目的・1） */
export const STOP_REASONS = [
  "cancel", // 取り消し
  "answer-timeout", // 答えの待ちの上限
  "timeout", // 時間切れ
  "budget", // 費用の上限
  "cannot-confirm", // 要件を固めきれなかった（工場の失敗ではない）
  "factory-failure", // 工場の失敗
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** 止めた理由の表示の言葉 */
export const STOP_REASON_LABELS = {
  cancel: "取り消し",
  "answer-timeout": "答えの待ちの上限",
  timeout: "時間切れ",
  budget: "費用の上限",
  "cannot-confirm": "要件を固めきれませんでした",
  "factory-failure": "工場の失敗",
} as const satisfies Record<StopReason, string>;

/** 結果の 3 つ（02-architecture.md §1.4） */
export const RESULT_VERDICTS = ["full", "partial", "none"] as const;
export type ResultVerdict = (typeof RESULT_VERDICTS)[number];

/** 結果の表示の言葉 */
export const RESULT_VERDICT_LABELS = {
  full: "すべて満たしました",
  partial: "一部だけ満たしました",
  none: "作れませんでした",
} as const satisfies Record<ResultVerdict, string>;

/** 質問の選択肢 */
export interface ApiChoice {
  readonly id: string;
  readonly text: string;
}

/** 質問の推奨と理由 */
export interface ApiRecommended {
  readonly choiceId: string;
  readonly reason: string;
}

/** 質問 1 つ（Issue #866 の目的・1） */
export interface ApiQuestion {
  readonly id: string;
  readonly text: string;
  readonly choices: readonly ApiChoice[];
  readonly recommended: ApiRecommended;
  readonly allowFreeText: boolean;
}

/** 残りの問数と往復 */
export interface ApiRemaining {
  readonly questions: number;
  readonly roundTrips: number;
}

/** 質問の束（版・残り・答えの期限の時刻） */
export interface ApiQuestionBundle {
  readonly revision: number;
  readonly questions: readonly ApiQuestion[];
  readonly remaining: ApiRemaining;
  /** 答えの期限の時刻（ミリ秒）。質問待ち・確認待ちでだけ値を持つ */
  readonly deadlineAt: number | null;
}

/** 確認の画面に出すもの（要件の並び・差分・書けないこと・既定で決めたこと） */
export interface ApiConfirmation {
  readonly requirements: readonly string[];
  readonly diff: {
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly removed: readonly string[];
  };
  readonly limitations: readonly {
    readonly what: string;
    readonly alternative: string;
  }[];
  readonly decided: readonly string[];
}

/** 進み（段の表示名・経過秒・概算の額） */
export interface ApiProgress {
  readonly stage: string;
  readonly elapsedSeconds: number;
  readonly estimatedUsd: number;
}

/** できなかったこと 1 つ（partial の結果に並べる。利用者の言葉） */
export interface ApiPartialLimitation {
  readonly what: string;
  readonly alternative: string;
}

/** partial の結果に並べる 3 つ（できたこと・できなかったこと・決めたこと） */
export interface ApiPartialDetails {
  readonly built: readonly string[];
  readonly missing: readonly ApiPartialLimitation[];
  readonly decided: readonly string[];
}

/** 結果（3 つの判定と中身） */
export interface ApiResult {
  readonly verdict: ResultVerdict;
  readonly verdictLabel: string;
  readonly content: readonly string[];
}

/** ジョブの状態（GET /api/jobs/:id の応答） */
export interface JobView {
  readonly id: string;
  readonly request: string;
  readonly state: JobState;
  readonly stateLabel: string;
  readonly stopReason: StopReason | null;
  readonly stopReasonLabel: string | null;
  /**
   * `cannot-confirm` のときの、理由の符号から決めた分類（利用者の言葉の短い 1 文）。
   * 符号そのものは載せない（符号・事項 ID・要件 ID を画面へ出さない）。他の理由では null。
   */
  readonly stopReasonCategory?: string | null;
  readonly question: ApiQuestionBundle | null;
  readonly confirmation: ApiConfirmation | null;
  readonly progress: ApiProgress | null;
  readonly result: ApiResult | null;
  /** 了承の要求にそのまま送る、納品物の manifest の SHA-256（無ければ null） */
  readonly manifestSha256?: string | null;
  /** partial の 3 つ（partial でなければ null） */
  readonly partial?: ApiPartialDetails | null;
  /** 実際に使った額（USD。終わっていなければ null） */
  readonly spentUsd?: number | null;
  /** 差し戻し・失敗の理由（利用者に見せる言葉） */
  readonly note?: string | null;
  /** 公開の結果（まだ公開していなければ null） */
  readonly publish?: PublishRecord | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 費用の状態（GET /api/budget の応答） */
export interface BudgetView {
  /** 今日の使った額（実額＋未決の予約） */
  readonly spentUsd: number;
  /** 今日の残り（上限−使った額。負にはならない） */
  readonly remainingUsd: number;
  /** 1 回の上限 */
  readonly perRunLimitUsd: number;
  /** 1 日の上限 */
  readonly dailyLimitUsd: number;
}

/** 答え 1 つ（選択肢か自由入力のちょうど一方） */
export interface SubmittedAnswer {
  readonly questionId: string;
  readonly choiceId?: string;
  readonly freeText?: string;
}

/** 答えの送り方（問いごとの答え、または「全部推奨で進める」） */
export type AnswersRequest =
  | { readonly kind: "answers"; readonly revision: number; readonly answers: readonly SubmittedAnswer[] }
  | { readonly kind: "all-recommended"; readonly revision: number };

/** 確認の答え（作る／やめる） */
export type ConfirmOutcome = "build" | "stop";

/** API の誤りの応答 */
export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
}

// ── 走らせる役の口（port）────────────────────────────────────────

/** 質問 1 つ（表示に要る欄だけ。宣言の用語は使わない） */
export interface RunnerQuestion {
  readonly id: string;
  readonly text: string;
  readonly choices: readonly { readonly id: string; readonly text: string }[];
  readonly recommended: { readonly choiceId: string; readonly reason: string };
  readonly allowFreeText: boolean;
}

/** 質問の束（版・残りの問数と往復） */
export interface RunnerQuestionBundle {
  readonly revision: number;
  readonly questions: readonly RunnerQuestion[];
  readonly remaining: { readonly questions: number; readonly roundTrips: number };
}

/** 確認の画面に出すもの（利用者の言葉。要件の文・差分・書けないことと代わりの案・既定で決めたこと） */
export interface RunnerConfirmation {
  readonly requirements: readonly string[];
  readonly diff: {
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly removed: readonly string[];
  };
  readonly limitations: readonly {
    readonly what: string;
    readonly alternative: string;
  }[];
  readonly decided: readonly string[];
}

/** 進み（段の表示名・概算の額） */
export interface RunnerProgress {
  readonly stage: string;
  readonly estimatedUsd: number;
}

/** 結果（3 つの判定と、利用者の言葉の中身） */
export interface RunnerResult {
  readonly verdict: ResultVerdict;
  readonly content: readonly string[];
  /** 納品物の manifest の SHA-256（小文字の 16 進 64 桁。分かるときだけ） */
  readonly manifestSha256?: string | null;
  /** partial の 3 つ（走らせる役が分かるときだけ） */
  readonly built?: readonly string[];
  readonly missing?: readonly ApiPartialLimitation[];
  readonly decided?: readonly string[];
}

/** 走らせる役からの通知 */
export type RunnerEvent =
  | { readonly kind: "question"; readonly question: RunnerQuestionBundle }
  | { readonly kind: "confirmation"; readonly confirmation: RunnerConfirmation }
  | { readonly kind: "progress"; readonly progress: RunnerProgress }
  | { readonly kind: "finished"; readonly result: RunnerResult; readonly spentUsd: number }
  | { readonly kind: "sent-back"; readonly reason: string; readonly spentUsd: number }
  | {
      /**
       * 走りは止まったが、工場の失敗ではない（費用の上限・時間切れ・要件を固めきれなかった）。
       * `codes` は理由の符号の並びで、ジョブの記録にだけ残す（画面へは出さない）。
       */
      readonly kind: "stopped";
      readonly reason: StopReason;
      readonly note: string | null;
      readonly codes: readonly string[];
      readonly spentUsd: number;
    }
  | { readonly kind: "failed"; readonly reason: string; readonly spentUsd: number };

/** 通知の受け口 */
export type RunnerNotify = (event: RunnerEvent) => void;

/** 走らせる役に渡す開始の入力 */
export interface RunnerStartInput {
  readonly jobId: string;
  readonly request: string;
  readonly notify: RunnerNotify;
}

/** 答えの送り方（版つき。古い版は受け付けない） */
export type RunnerAnswers = AnswersRequest;

/**
 * 走らせる役の口。
 *
 *   - `start` … 依頼を始める。進み・質問・確認・終わりは `notify` で知らせる
 *   - `answer` … 質問に答える
 *   - `confirm` … 確認に答える（作る／やめる）
 *   - `cancel` … 走りを止める（理由を添える）
 */
export interface Runner {
  start(input: RunnerStartInput): void | Promise<void>;
  answer(jobId: string, answers: RunnerAnswers): void | Promise<void>;
  confirm(jobId: string, outcome: ConfirmOutcome): void | Promise<void>;
  cancel(jobId: string, reason: StopReason): void | Promise<void>;
}

/** 取消の理由が、走らせる役へ渡す分類として正しいか */
export function isStopReason(value: string): value is StopReason {
  return (STOP_REASONS as readonly string[]).includes(value);
}
