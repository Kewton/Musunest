// Plan の答える役の実装と、往復の記録（04-plan-agent.md §2・§7・Issue #336）。
//
// Plan を回す口（`plan/run-plan.ts`・#363）は**答える役を口（`PlanResponder`）として外へ出してある**。
// ここはその口の 2 つの実装を置く：
//
//   - **対話の形**（`createInteractivePlanResponder`）… `Terminal` の口に問いと選択肢・推奨・「推奨で
//     決める」・自由入力を出し、答えを受け取る。最後に確認の画面（差分・書けないこと）を出して
//     「これで作る」かを聞く
//   - **答えのファイルの形**（`createAnswersFilePlanResponder`）… 質問 ID → 選択肢 ID か自由入力の JSON を
//     読み、**足りない質問は推奨で埋める**。確認は自動で「これで作る」（評価用。§7）
//
// **端末もファイルも扱わない**——`Terminal` は呼ぶ側（cli.ts）が用意し、答えのファイルは文字列で受け取る。
// 実 API も本物の端末も使わない（試験は偽物を差し込む。CLAUDE.md の不変条件）。
import type { BundleJudgeUsage } from "./bundle.js";
import type { PlanAnswerDraft } from "./plan/answers.js";
import type { PlanQuestion } from "./plan/questions.js";
import type { PlanConfirmationView } from "./plan/session.js";
import type {
  PlanAnswerOutcome,
  PlanAnswerRequest,
  PlanConfirmOutcome,
  PlanResponder,
  PlanResult,
  PlanStageRecord,
} from "./plan/run-plan.js";
import { isRecord } from "./stages/prompt.js";

/** 端末の口（1 行を出し、1 行を読む）。本物と偽物を差し替えられる。入力が尽きたら `undefined` */
export interface Terminal {
  readonly write: (line: string) => void;
  readonly readLine: () => Promise<string | undefined>;
}

/** 「推奨で決める」を表す入力（空行・0 と同じ扱い） */
export const RECOMMENDED_INPUT = "推奨で決める" as const;
/** 「全部推奨で進める」を表す入力（その往復の問いをすべて推奨で閉じる） */
export const ALL_RECOMMENDED_INPUT = "全部推奨で進める" as const;
/** 「自由入力」を選ぶ入力 */
export const FREE_TEXT_INPUT = "f" as const;
/** 「これで作る」を表す入力 */
const BUILD_INPUTS = ["y", "yes", "build", "はい", "これで作る", "作る"] as const;

/** 1 往復の記録（質問と、それへの答え） */
export interface PlanTranscriptRound {
  readonly questions: readonly PlanQuestion[];
  readonly answers: readonly PlanAnswerDraft[];
  /** 「全部推奨で進める」で閉じた往復か */
  readonly allRecommended: boolean;
}

/**
 * 往復の記録。`--out` のディレクトリに置く（納品物には入れない。§7・Issue #336）。
 * `rounds` は答える役が追記する（`readonly` は差し替えを禁じるだけ）。
 */
export interface PlanTranscript {
  readonly rounds: PlanTranscriptRound[];
  /** 確認の画面への答え（まだなら null） */
  confirmation: "build" | "stop" | null;
}

/** 空の往復の記録を作る */
export function createPlanTranscript(): PlanTranscript {
  return { rounds: [], confirmation: null };
}

/** 答えのファイルの 1 件（選択肢 ID か自由入力のちょうど一方） */
export type PlanAnswerEntry =
  | { readonly choiceId: string }
  | { readonly freeText: string };

/** 答えのファイル（質問 ID → 選択肢 ID か自由入力） */
export type PlanAnswers = Readonly<Record<string, PlanAnswerEntry>>;

/**
 * 答えのファイルの文字列を読む（§7）。JSON の写像で、値は選択肢 ID の文字列か、`choiceId`／`freeText` を
 * ちょうど一方持つ写像である。誤りは人の読む文にして返す（例外にしない）。
 */
export function parsePlanAnswers(text: string): PlanAnswers | { readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "答えのファイルが JSON として読めません" };
  }
  if (!isRecord(value)) return { error: "答えのファイルは写像（object）であること" };
  const entries: Record<string, PlanAnswerEntry> = {};
  for (const [questionId, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      if (raw === "") return { error: `${questionId}: 選択肢 ID が空です` };
      entries[questionId] = { choiceId: raw };
      continue;
    }
    if (isRecord(raw)) {
      const choiceId = raw["choiceId"];
      const freeText = raw["freeText"];
      if (typeof choiceId === "string" && choiceId !== "" && freeText === undefined) {
        entries[questionId] = { choiceId };
        continue;
      }
      if (typeof freeText === "string" && freeText !== "" && choiceId === undefined) {
        entries[questionId] = { freeText };
        continue;
      }
      return { error: `${questionId}: 選択肢 ID（choiceId）か自由入力（freeText）のちょうど一方を書いてください` };
    }
    return { error: `${questionId}: 選択肢 ID（文字列）か、choiceId／freeText を持つ写像であること` };
  }
  return entries;
}

/** 問い 1 つへの答えの下書きを組む（答えの ID は問いから決める。答えは 1 往復に 1 回だけ聞く） */
function answerDraft(question: PlanQuestion, value: PlanAnswerEntry): PlanAnswerDraft {
  const base = { id: `A:${question.id}`, questionId: question.id, revision: question.revision };
  return "choiceId" in value ? { ...base, choiceId: value.choiceId } : { ...base, freeText: value.freeText };
}

/** 推奨で閉じる答えの下書きを組む（推奨が無ければ最初の選択肢を使う） */
function recommendedDraft(question: PlanQuestion): PlanAnswerDraft | undefined {
  const choiceId = question.recommended?.choiceId ?? question.choices[0]?.id;
  if (choiceId === undefined) return undefined;
  return { id: `A:${question.id}`, questionId: question.id, revision: question.revision, choiceId };
}

/**
 * 答えのファイルの形の答える役（評価用。§7）。質問 ID の答えがあればそれを使い、**足りない質問は推奨で
 * 埋める**。確認の画面は自動で「これで作る」を返す。
 */
export function createAnswersFilePlanResponder(
  answers: PlanAnswers,
  transcript: PlanTranscript,
): PlanResponder {
  return {
    async answer(request: PlanAnswerRequest): Promise<PlanAnswerOutcome> {
      const drafts: PlanAnswerDraft[] = [];
      for (const question of request.questions) {
        const entry = answers[question.id];
        const draft = entry === undefined ? recommendedDraft(question) : answerDraft(question, entry);
        if (draft !== undefined) drafts.push(draft);
      }
      const outcome: PlanAnswerOutcome = { kind: "answers", answers: drafts };
      transcript.rounds.push({ questions: request.questions, answers: drafts, allRecommended: false });
      return outcome;
    },
    async confirm(_view: PlanConfirmationView): Promise<PlanConfirmOutcome> {
      transcript.confirmation = "build";
      return "build";
    },
  };
}

/** 問い 1 つを端末に出し、答えを受け取る。入力が尽きたら `"eof"`、「全部推奨」なら `"all-recommended"` */
async function askQuestion(
  terminal: Terminal,
  question: PlanQuestion,
): Promise<PlanAnswerDraft | "all-recommended" | "eof"> {
  terminal.write(question.text);
  question.choices.forEach((choice, index) => {
    const mark = question.recommended?.choiceId === choice.id ? "（推奨）" : "";
    terminal.write(`  ${index + 1}) ${choice.text}${mark}`);
  });
  terminal.write(`  0) ${RECOMMENDED_INPUT}`);
  terminal.write(`  f) 自由入力`);
  for (;;) {
    const raw = await terminal.readLine();
    if (raw === undefined) return "eof";
    const input = raw.trim();
    if (input === ALL_RECOMMENDED_INPUT) return "all-recommended";
    if (input === "" || input === "0" || input === RECOMMENDED_INPUT) {
      const draft = recommendedDraft(question);
      if (draft !== undefined) return draft;
      continue;
    }
    if (input === FREE_TEXT_INPUT || input === "自由入力") {
      terminal.write("自由入力を書いてください");
      const text = await terminal.readLine();
      if (text === undefined) return "eof";
      if (text.trim() !== "") {
        return { id: `A:${question.id}`, questionId: question.id, revision: question.revision, freeText: text };
      }
      continue;
    }
    const index = Number(input);
    if (Number.isInteger(index) && index >= 1 && index <= question.choices.length) {
      const choice = question.choices[index - 1];
      if (choice !== undefined) {
        return { id: `A:${question.id}`, questionId: question.id, revision: question.revision, choiceId: choice.id };
      }
    }
    terminal.write(`番号か「${RECOMMENDED_INPUT}」か「f」を入れてください`);
  }
}

/** 確認の画面を端末に出す（元の依頼との差分・書けないことと代わりの案。§2） */
function writeConfirmation(terminal: Terminal, view: PlanConfirmationView): void {
  terminal.write("この仕様で作ります。");
  if (view.diff.length === 0) {
    terminal.write("元の依頼からの差分: なし");
  } else {
    terminal.write("元の依頼からの差分:");
    for (const change of view.diff) terminal.write(`  - ${JSON.stringify(change)}`);
  }
  if (view.unwritable.length === 0) {
    terminal.write("書けないこと: なし");
  } else {
    terminal.write("書けないこと（代わりの案）:");
    for (const item of view.unwritable) terminal.write(`  - ${item.part_id} → ${item.alternative_id}`);
  }
  terminal.write(`これで作る [y/n]`);
}

/**
 * 対話の形の答える役（§7）。問いを端末に出す（選択肢の番号・推奨の印・「推奨で決める」・自由入力）。
 * 最後に確認の画面を出し、「これで作る」なら Build に進む。入力が尽きたら、その回の答えだけ返す。
 */
export function createInteractivePlanResponder(
  terminal: Terminal,
  transcript: PlanTranscript,
): PlanResponder {
  return {
    async answer(request: PlanAnswerRequest): Promise<PlanAnswerOutcome> {
      const drafts: PlanAnswerDraft[] = [];
      for (const question of request.questions) {
        const answer = await askQuestion(terminal, question);
        if (answer === "all-recommended") {
          const outcome: PlanAnswerOutcome = { kind: "all-recommended" };
          transcript.rounds.push({ questions: request.questions, answers: [], allRecommended: true });
          return outcome;
        }
        if (answer === "eof") break;
        drafts.push(answer);
      }
      const outcome: PlanAnswerOutcome = { kind: "answers", answers: drafts };
      transcript.rounds.push({ questions: request.questions, answers: drafts, allRecommended: false });
      return outcome;
    },
    async confirm(view: PlanConfirmationView): Promise<PlanConfirmOutcome> {
      writeConfirmation(terminal, view);
      const raw = await terminal.readLine();
      const input = (raw ?? "").trim().toLowerCase();
      const decision: PlanConfirmOutcome = (BUILD_INPUTS as readonly string[]).includes(input) ? "build" : "stop";
      transcript.confirmation = decision;
      return decision;
    },
  };
}

/** 往復の記録を置くファイルの名前（`--out` の直下。納品物には入れない） */
export const PLAN_CLI_RECORD_FILE = "plan-record.json" as const;
/** 往復の記録の版 */
export const PLAN_CLI_RECORD_SCHEMA = "musunest-factory/plan-cli-record/v1" as const;

/** 記録に入れる問い（安定した形に写す） */
export interface PlanCliQuestionRecord {
  readonly id: string;
  readonly open_issue_id: string;
  readonly text: string;
  readonly choices: readonly { readonly id: string; readonly text: string }[];
  readonly recommended: { readonly choice_id: string; readonly reason: string } | null;
  readonly allow_free_text: boolean;
}

/** 記録に入れる答え（選択肢 ID か自由入力のちょうど一方） */
export interface PlanCliAnswerRecord {
  readonly id: string;
  readonly question_id: string;
  readonly choice_id: string | null;
  readonly free_text: string | null;
}

/** 記録に入れる 1 往復 */
export interface PlanCliRoundRecord {
  readonly questions: readonly PlanCliQuestionRecord[];
  readonly answers: readonly PlanCliAnswerRecord[];
  readonly all_recommended: boolean;
}

/** 往復の記録（`--out` の `plan-record.json`。質問・答え・段の記録・使った額） */
export interface PlanCliRecord {
  readonly schema_version: string;
  readonly plan_id: string;
  readonly outcome: PlanResult["kind"];
  readonly rounds: readonly PlanCliRoundRecord[];
  readonly confirmation: "build" | "stop" | null;
  readonly stages: readonly PlanStageRecord[];
  readonly judge: BundleJudgeUsage;
  readonly budget_usd: number;
  readonly spent_usd: number;
  readonly remaining_usd: number;
}

function toQuestionRecord(question: PlanQuestion): PlanCliQuestionRecord {
  const recommended = question.recommended;
  return {
    id: question.id,
    open_issue_id: question.openIssueId,
    text: question.text,
    choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })),
    recommended: recommended === undefined ? null : { choice_id: recommended.choiceId, reason: recommended.reason },
    allow_free_text: question.allowFreeText ?? false,
  };
}

function toAnswerRecord(answer: PlanAnswerDraft): PlanCliAnswerRecord {
  return {
    id: answer.id,
    question_id: answer.questionId,
    choice_id: answer.choiceId ?? null,
    free_text: answer.freeText ?? null,
  };
}

/** 往復の記録を組む（`--out` に書く。納品物には入れない。§7・Issue #336） */
export function buildPlanCliRecord(input: {
  readonly result: PlanResult;
  readonly transcript: PlanTranscript;
  readonly budgetUsd: number;
  readonly planId: string;
}): PlanCliRecord {
  return {
    schema_version: PLAN_CLI_RECORD_SCHEMA,
    plan_id: input.planId,
    outcome: input.result.kind,
    rounds: input.transcript.rounds.map((round) => ({
      questions: round.questions.map(toQuestionRecord),
      answers: round.answers.map(toAnswerRecord),
      all_recommended: round.allRecommended,
    })),
    confirmation: input.transcript.confirmation,
    stages: input.result.stages,
    judge: input.result.judge,
    budget_usd: input.budgetUsd,
    spent_usd: input.result.spentUsd,
    remaining_usd: input.result.remainingUsd,
  };
}

/** Plan を確定できずに止まったときの、理由の 1 行（Build を流さないとき出す） */
export function planStopReasonLine(result: PlanResult): string {
  if (result.kind === "cannot-confirm") {
    return `Plan で確定できませんでした（重大な未解決の事項が ${result.openIssues.length} 件残りました）`;
  }
  if (result.kind === "stopped") {
    return `Plan を止めました（${result.reason}）`;
  }
  return "";
}

/** Plan と Build の合計の費用の版 */
export const PLAN_BUILD_COST_SCHEMA = "musunest-factory/plan-build-cost/v1" as const;

/** Plan と Build の合計の費用を 1 行にして返す（最後に出す。§8・Issue #336） */
export function planBuildCostLine(planUsd: number, buildUsd: number): string {
  return JSON.stringify({
    schema_version: PLAN_BUILD_COST_SCHEMA,
    plan_usd: planUsd,
    build_usd: buildUsd,
    total_usd: planUsd + buildUsd,
  });
}
