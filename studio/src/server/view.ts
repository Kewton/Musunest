// 画面に返す表示用の欄（Issue #866 の目的・9）。
//
// 確認と結果は**利用者の言葉**で返す。宣言の用語（entity・computed など。04-plan-agent.md §3）を
// API の表示用の欄に入れない。コードの値を日本語の表示に写し、本文は走らせる役が利用者の言葉で
// 書いたものだけを通す。宣言の用語が混ざっていたら、黙って通さずに例外にする。
import {
  DAILY_LIMIT_USD,
  JOB_STATE_LABELS,
  PER_RUN_LIMIT_USD,
  RESULT_VERDICT_LABELS,
  STOP_REASON_LABELS,
  type ApiConfirmation,
  type ApiProgress,
  type ApiQuestionBundle,
  type ApiResult,
  type BudgetView,
  type JobView,
  type RunnerConfirmation,
  type RunnerResult,
} from "./runner.js";
import type { LedgerSummary } from "./ledger.js";
import type { StoredJob } from "./store.js";

/**
 * 表示の欄に入れてはいけない宣言の用語（04-plan-agent.md §3「宣言の用語（entity・computed など）」）。
 * 試験はこの一覧を表示の欄に照らす。
 */
export const DECLARATION_TERMS = [
  "entity",
  "computed",
  "aggregate",
  "selector",
  "action",
  "view",
  "screen",
  "table",
  "board",
  "dashboard",
  "permission",
  "schema",
  "field",
  "relation",
  "validation",
  "ref",
  "enum",
  "filters",
  "groupBy",
  "settle",
  "within",
  "show",
] as const;

const termPatterns = DECLARATION_TERMS.map((term) => ({
  term,
  pattern: new RegExp(`\\b${term}\\b`, "i"),
}));

/** 本文に混ざっている宣言の用語をすべて返す（無ければ空） */
export function declarationTermsIn(text: string): readonly string[] {
  return termPatterns.filter(({ pattern }) => pattern.test(text)).map(({ term }) => term);
}

/** 表示の言葉に宣言の用語が混ざっていた */
export class UserWordingError extends Error {
  constructor(field: string, terms: readonly string[]) {
    super(`${field} に宣言の用語が混ざっている: ${terms.join(", ")}`);
    this.name = "UserWordingError";
  }
}

const assertUserWording = (field: string, text: string): string => {
  const terms = declarationTermsIn(text);
  if (terms.length > 0) throw new UserWordingError(field, terms);
  return text;
};

const buildQuestionBundle = (job: StoredJob): ApiQuestionBundle | null => {
  if (job.question === null) return null;
  return {
    revision: job.question.revision,
    questions: job.question.questions.map((question) => ({
      id: question.id,
      text: question.text,
      choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })),
      recommended: { choiceId: question.recommended.choiceId, reason: question.recommended.reason },
      allowFreeText: question.allowFreeText,
    })),
    remaining: { questions: job.question.remaining.questions, roundTrips: job.question.remaining.roundTrips },
    deadlineAt: job.answerDeadlineAt,
  };
};

const buildConfirmation = (confirmation: RunnerConfirmation): ApiConfirmation => ({
  requirements: confirmation.requirements.map((text) => assertUserWording("confirmation.requirements", text)),
  diff: {
    added: confirmation.diff.added.map((text) => assertUserWording("confirmation.diff.added", text)),
    changed: confirmation.diff.changed.map((text) => assertUserWording("confirmation.diff.changed", text)),
    removed: confirmation.diff.removed.map((text) => assertUserWording("confirmation.diff.removed", text)),
  },
  limitations: confirmation.limitations.map((entry) => ({
    what: assertUserWording("confirmation.limitations.what", entry.what),
    alternative: assertUserWording("confirmation.limitations.alternative", entry.alternative),
  })),
  decided: confirmation.decided.map((text) => assertUserWording("confirmation.decided", text)),
});

const buildResult = (result: RunnerResult): ApiResult => ({
  verdict: result.verdict,
  verdictLabel: RESULT_VERDICT_LABELS[result.verdict],
  content: result.content.map((text) => assertUserWording("result.content", text)),
});

const buildProgress = (job: StoredJob, now: number): ApiProgress | null => {
  if (job.progress === null) return null;
  return {
    stage: job.progress.stage,
    elapsedSeconds: Math.max(0, Math.floor((now - job.createdAt) / 1000)),
    estimatedUsd: job.progress.estimatedUsd,
  };
};

/** ジョブの状態を、画面に返す形に写す */
export function buildJobView(job: StoredJob, now: number): JobView {
  return {
    id: job.id,
    request: job.request,
    state: job.state,
    stateLabel: JOB_STATE_LABELS[job.state],
    stopReason: job.stopReason,
    stopReasonLabel: job.stopReason === null ? null : STOP_REASON_LABELS[job.stopReason],
    question: buildQuestionBundle(job),
    confirmation: job.confirmation === null ? null : buildConfirmation(job.confirmation),
    progress: buildProgress(job, now),
    result: job.result === null ? null : buildResult(job.result),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** 費用の状態を、画面に返す形に写す */
export function buildBudgetView(summary: LedgerSummary): BudgetView {
  return {
    spentUsd: summary.spentUsd,
    remainingUsd: summary.remainingUsd,
    perRunLimitUsd: PER_RUN_LIMIT_USD,
    dailyLimitUsd: DAILY_LIMIT_USD,
  };
}
