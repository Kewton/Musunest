// Plan の往復を**純粋な関数**にする（04-plan-agent.md §2・§3・§6・§7）。
//
// 入力は「依頼文・これまでの質問と答え・いまの未解決の事項・次の質問の候補・確認の画面に出す下書き」、出力は
// 「次の質問の束（`ask`）」か「確認の画面に出すもの（`confirm`）」か「確定できない（`cannot-confirm`）」。
// **端末とファイルは扱わない**——答えを待つあいだは状態（`turns`）を返して終わり、再開は呼ぶ側が行う（§7）。
//
// 上限（`AGENT_LIMITS.planQuestions`・`planRoundTrips`）は**往復をまたいで**数え、直し・再開で戻さない
// （§2・§6 の 2）。だから **11 問目**も **4 回目の往復**も出さない。上限のあとも**重大な**未解決の事項が
// 残っていれば「確定できない」を返す（§2）。「全部推奨で進める」なら、推奨で閉じて確認に進む。
import type { ConfirmedPlan, PlanAcceptedUnwritable, PlanChange, PlanOpenIssue } from "@musunest/appspec-schema";
import { AGENT_LIMITS } from "../limits.js";
import type { PlanAnswerDraft } from "./answers.js";
import type { PlanQuestion } from "./questions.js";

/** 確認の画面に出す仕様の下書き（確認前なので `confirmation` はまだ無い） */
export type PlanDraft = Omit<ConfirmedPlan, "confirmation">;

/** 確認の画面に出すもの（04 §2。確定した仕様の案・元の依頼との差分・書けないことと代わりの案） */
export interface PlanConfirmationView {
  readonly plan: PlanDraft;
  /** 元の依頼との差分（足した・直した・外した要件） */
  readonly diff: readonly PlanChange[];
  /** 書けないこと（了承して除く部分）と、代わりの案 */
  readonly unwritable: readonly PlanAcceptedUnwritable[];
}

/** 1 往復（質問の束と、それへの答え） */
export interface PlanTurn {
  readonly questions: readonly PlanQuestion[];
  readonly answers: readonly PlanAnswerDraft[];
}

/** 残りの問数と往復の数 */
export interface PlanRemaining {
  /** 合わせてあと何問聞けるか */
  readonly questions: number;
  /** あと何回往復できるか */
  readonly roundTrips: number;
}

/** Plan の往復の状態（純粋な関数への入力） */
export interface PlanSessionInput {
  /** 依頼文（原文） */
  readonly source: string;
  /** これまでの往復（質問と答え） */
  readonly turns: readonly PlanTurn[];
  /** いまの未解決の事項（開いているものと閉じたもの） */
  readonly openIssues: readonly PlanOpenIssue[];
  /** 未解決の事項から組み立てた、次の質問の候補 */
  readonly questions: readonly PlanQuestion[];
  /** 確認の画面に出す下書き */
  readonly view: PlanConfirmationView;
  /** 「全部推奨で進める」。真なら、推奨で閉じて確認に進む */
  readonly allRecommended?: boolean;
}

/** 次の一歩 */
export type PlanStep =
  | { readonly kind: "ask"; readonly questions: readonly PlanQuestion[]; readonly remaining: PlanRemaining }
  | { readonly kind: "confirm"; readonly view: PlanConfirmationView }
  | { readonly kind: "cannot-confirm"; readonly openIssues: readonly PlanOpenIssue[] };

/** これまでの往復で聞いた質問の合計（往復をまたいで数える。§6 の 2） */
export function askedQuestionCount(turns: readonly PlanTurn[]): number {
  return turns.reduce((total, turn) => total + turn.questions.length, 0);
}

/** これまでの往復の回数 */
export function roundTripCount(turns: readonly PlanTurn[]): number {
  return turns.length;
}

/** 残りの問数と往復の数（上限から、これまでの往復を引く。負にはならない） */
export function remainingPlanBudget(turns: readonly PlanTurn[]): PlanRemaining {
  return {
    questions: Math.max(0, AGENT_LIMITS.planQuestions - askedQuestionCount(turns)),
    roundTrips: Math.max(0, AGENT_LIMITS.planRoundTrips - roundTripCount(turns)),
  };
}

/** 開いている事項のうち、重大なものだけを返す */
function criticalOpenIssues(openIssues: readonly PlanOpenIssue[]): readonly PlanOpenIssue[] {
  return openIssues.filter((issue) => issue.status === "open" && issue.critical);
}

/** 開いている事項（重大かによらず） */
function openIssuesOf(openIssues: readonly PlanOpenIssue[]): readonly PlanOpenIssue[] {
  return openIssues.filter((issue) => issue.status === "open");
}

/**
 * 次の一歩を決める（**純粋な関数**。04 §2・§6）。LLM も端末もファイルも触らない。
 *
 * - 開いている事項が無ければ、質問 0 問で確認に進む（`confirm`）
 * - 「全部推奨で進める」なら、推奨で閉じて確認に進む（`confirm`）
 * - 開いている事項があり、まだ上限の内側なら、**残りの問数の範囲で**次の質問を出す（`ask`）。
 *   11 問目と 4 回目の往復は出さない
 * - 上限のあとも**重大な**事項が残れば「確定できない」（`cannot-confirm`）。重大でなければ既定で閉じる
 */
export function nextPlanStep(input: PlanSessionInput): PlanStep {
  const open = openIssuesOf(input.openIssues);
  if (open.length === 0) return { kind: "confirm", view: input.view };
  if (input.allRecommended === true) return { kind: "confirm", view: input.view };

  const remaining = remainingPlanBudget(input.turns);
  const exhausted = remaining.questions <= 0 || remaining.roundTrips <= 0;
  if (exhausted) {
    const critical = criticalOpenIssues(input.openIssues);
    return critical.length > 0
      ? { kind: "cannot-confirm", openIssues: critical }
      : { kind: "confirm", view: input.view };
  }

  const questions = input.questions.slice(0, remaining.questions);
  if (questions.length === 0) {
    const critical = criticalOpenIssues(input.openIssues);
    return critical.length > 0
      ? { kind: "cannot-confirm", openIssues: critical }
      : { kind: "confirm", view: input.view };
  }

  return {
    kind: "ask",
    questions,
    remaining: { questions: remaining.questions - questions.length, roundTrips: remaining.roundTrips },
  };
}
