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
import {
  isSourceClosureDecision,
  type CannotConfirmReason,
  type PlanAnswerOutcome,
  type PlanAnswerRequest,
  type PlanConfirmOutcome,
  type PlanFailure,
  type PlanResponder,
  type PlanResult,
  type PlanStageRecord,
  type PlanSurfaceCheckSummary,
} from "./plan/run-plan.js";
import { isRecord } from "./stages/prompt.js";
import type { ReverseCheckDiagnosis, ReverseCheckMissCounts } from "./stages/reverse-check.js";

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
/** 答えのファイルの形で、確認を自動で受けたことを示す 1 行（Issue #419） */
export const AUTO_BUILD_LINE = "自動で これで作る" as const;
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
 * 埋める**。確認では、**対話の形と同じ関数**で同じ内容（差分・書けないことと代わりの案・依頼文で決めた
 * こと・既定で決めたこと）を `log` に出し、**端末の入力は待たず**に「自動で これで作る」の 1 行を出して
 * `build` を返す（Issue #419）。`log` は呼ぶ側（入口）が渡す。
 */
export function createAnswersFilePlanResponder(
  answers: PlanAnswers,
  transcript: PlanTranscript,
  log: (line: string) => void = (): void => {},
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
    async confirm(view: PlanConfirmationView): Promise<PlanConfirmOutcome> {
      writeConfirmationBody(log, view);
      log(AUTO_BUILD_LINE);
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

/**
 * 確認の内容（元の依頼との差分・書けないことと代わりの案・依頼文で決めたこと・既定で決めたこと）を
 * 1 行ずつ出す。**対話の形と答えのファイルの形が共有する**——出力の口（`write`）だけを変える（Issue #419）。
 * 「はい・いいえ」の問いと、自動の選択の 1 行は**ここに入れない**（呼ぶ側が分けて出す）。
 */
export function writeConfirmationBody(write: (line: string) => void, view: PlanConfirmationView): void {
  write("この仕様で作ります。");
  if (view.diff.length === 0) {
    write("元の依頼からの差分: なし");
  } else {
    write("元の依頼からの差分:");
    for (const change of view.diff) write(`  - ${JSON.stringify(change)}`);
  }
  if (view.unwritable.length === 0) {
    write("書けないこと: なし");
  } else {
    write("書けないこと（代わりの案）:");
    for (const item of view.unwritable) write(`  - ${item.part_id} → ${item.alternative_id}`);
  }
  // 依頼文で決めたこと（事項・決めた中身・引用）を出す（直す機能は今回は作らない。04 §3 P4・Issue #370）
  const sourceDecisions = view.plan.decisions.filter(isSourceClosureDecision);
  if (sourceDecisions.length > 0) {
    write("依頼文で決めたこと:");
    for (const decision of sourceDecisions) {
      write(`  - ${decision.subject}: ${decision.value}（引用: ${decision.reason}）`);
    }
  }
  // 既定で決めたこと（観点・値・理由）を、依頼文で決めたことと**別の見出し**で出す（Issue #408）。
  // ID の接頭辞では見分けず、下書きの並び（`closedByDefault`）から出す。
  if (view.closedByDefault.length > 0) {
    write("既定で決めたこと（観点・値・理由）:");
    for (const decision of view.closedByDefault) {
      write(`  - ${decision.subject}: ${decision.value}（理由: ${decision.reason}）`);
    }
  }
}

/** 確認の画面を端末に出す（本文のあとに「はい・いいえ」の問いを出す。§2・Issue #419） */
function writeConfirmation(terminal: Terminal, view: PlanConfirmationView): void {
  writeConfirmationBody(terminal.write, view);
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
/**
 * P3 の申告の点検の診断を置くファイルの名前（`--out` の直下。`plan-record.json` とは**別**。Issue #432）。
 * 申告 1 件ずつの対応（受理・落とした・途中停止のどれも）を持ち、`plan-record.json` は今の要約のままにする。
 */
export const PLAN_SURFACE_CHECK_FILE = "plan-surface-check.json" as const;
/** 点検の診断の版 */
export const PLAN_SURFACE_CHECK_SCHEMA = "musunest-factory/plan-surface-check/v1" as const;

/** 記録に入れる問い（安定した形に写す） */
export interface PlanCliQuestionRecord {
  readonly id: string;
  readonly open_issue_id: string;
  /** この問いを組み立てた仕様の版（往復ごとに ID を追えるようにする。Issue #405） */
  readonly revision: number;
  readonly text: string;
  readonly choices: readonly { readonly id: string; readonly text: string }[];
  readonly recommended: { readonly choice_id: string; readonly reason: string } | null;
  readonly allow_free_text: boolean;
  /** この問いの答えで一緒に閉じる事項の ID（04 §3 P4・Issue #370） */
  readonly also_closes: readonly string[];
}

/** 記録に入れる、依頼文で閉じた事項（04 §3 P4・Issue #370） */
export interface PlanCliSourceClosureRecord {
  readonly issue_id: string;
  readonly quote: string;
  readonly value: string;
}

/** 記録に入れる、既定で閉じた事項（事項 ID・観点 ID・値。04 §3・Issue #408） */
export interface PlanCliDefaultClosureRecord {
  readonly issue_id: string;
  readonly facet_id: string;
  readonly value: string;
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

/**
 * 記録に入れる、対象外の参照の分類別の件数（Issue #434）。分類はコードが内部の対応で決める（モデルに
 * 選ばせない）。**値ではなく件数**である。
 */
export interface PlanCliDiffOutOfScopeKindCount {
  readonly kind: string;
  readonly claims: number;
  readonly ambiguities: number;
}

/**
 * 記録に入れる、差分点検 1 回の**対象外の参照の記録**（Issue #434）。原応答で対象外だった件数・コードが
 * 重複として除いた件数・重複と認めず断った件数を区別して持つ。**値は持たない**。
 */
export interface PlanCliDiffOutOfScopeRecord {
  readonly scanned: boolean;
  readonly claims: number;
  readonly ambiguities: number;
  readonly deduped: number;
  readonly rejected_claims: number;
  readonly rejected_ambiguities: number;
  readonly kinds: readonly PlanCliDiffOutOfScopeKindCount[];
  readonly deduped_indexes: readonly number[];
}

/**
 * 記録に入れる、差分点検 1 回の記録（Issue #434）。**値ではなく件数だけ**である——何往復目の P5 のあとに、
 * その往復で増えた何件の要件を点検し、そこで何件の事項が開き、何件を了承除外に加え、対象外の参照をどう
 * 扱ったか。
 */
export interface PlanCliDiffReviewRecord {
  readonly round: number;
  readonly added: number;
  readonly open_issues: number;
  readonly accepted_unwritable: number;
  readonly out_of_scope: PlanCliDiffOutOfScopeRecord;
  /** 引き継いだ観点の記録（件数と有限の分類だけ。Issue #461） */
  readonly inherit: PlanCliInheritRecord;
}

/**
 * 記録に入れる、引き継いだ観点の件数（種類ごと・観点 ID ごと。Issue #461）。**値・事項 ID・要件 ID・文・
 * 答えは入れない**——有限の種類と観点 ID と件数だけである。
 */
export interface PlanCliInheritedFacetCount {
  readonly kind: string;
  readonly facet_id: string;
  readonly count: number;
}

/** 記録に入れる、根拠が引けず引き継がなかった件数（分類別。Issue #461） */
export interface PlanCliInheritMissCount {
  readonly kind: string;
  readonly count: number;
}

/** 記録に入れる、新しく開いた事項の出どころ別の件数（Issue #461） */
export interface PlanCliDiffOpenIssueSourceCount {
  readonly source: string;
  readonly count: number;
}

/**
 * 記録に入れる、差分点検 1 回の**引き継ぎの記録**（Issue #461）。**値を持たず、件数と有限の分類だけ**で
 * ある——引き継いだ件数（種類ごと・観点 ID ごと）・親なしの件数・親が複数で (a) だけにした件数・根拠が
 * 引けず引き継がなかった件数（分類ごと）・新しく開いた事項の出どころ別の件数。
 */
export interface PlanCliInheritRecord {
  readonly facets: readonly PlanCliInheritedFacetCount[];
  readonly no_parent: number;
  readonly multiple_parents: number;
  readonly unresolved: readonly PlanCliInheritMissCount[];
  readonly open_by_source: readonly PlanCliDiffOpenIssueSourceCount[];
}

/** 記録に入れる、衝突した行の件数（既存の出どころ × 追加の出どころの組ごと。Issue #460） */
export interface PlanCliOpenIssueConflictKindCount {
  readonly existing: string;
  readonly added: string;
  readonly count: number;
}

/** 記録に入れる、衝突した片側の行の帰属（由来・状態・今回か以前か。値は入れない。Issue #464） */
export interface PlanCliOpenIssueRowAttribution {
  readonly origin: string;
  readonly status: string;
  /** その行を、衝突を検出した往復と同じ往復で作ったか */
  readonly current: boolean;
}

/** 記録に入れる、衝突した 2 行の帰属の組ごとの件数（足した順によらない。Issue #464） */
export interface PlanCliOpenIssueConflictAttributionCount {
  readonly first: PlanCliOpenIssueRowAttribution;
  readonly second: PlanCliOpenIssueRowAttribution;
  readonly count: number;
}

/**
 * 記録に入れる、同じ ID の開いている事項の行の衝突の記録（Issue #460・#464）。**値ではなく件数と分類、
 * 版だけ**である。衝突した ID の件数・衝突した行の件数（出どころの組ごと）・衝突した 2 行の帰属
 * （由来・状態・今回か以前か）の組ごとの件数・解決の対象が 0 行だった件数・衝突を検出した往復の版を持つ。
 * 事項 ID・要件 ID・文・答えは入れない。
 */
export interface PlanCliOpenIssueConflictRecord {
  readonly ids: number;
  readonly rows: readonly PlanCliOpenIssueConflictKindCount[];
  /** 衝突した 2 行の帰属（由来・状態・今回か以前か）の組ごとの件数（足した順によらない。Issue #464） */
  readonly attribution: readonly PlanCliOpenIssueConflictAttributionCount[];
  readonly empty_targets: number;
  readonly round: number | null;
}

/** 記録に入れる、提示元ごとの、使い回しで断った ID の数（値は入れない。Issue #464） */
export interface PlanCliSurfaceIdReuseSourceCount {
  readonly source: string;
  readonly count: number;
}

/**
 * 記録に入れる、使い回しで断った応答 1 つぶん（**値は入れない**。Issue #464）。点検の版（初回 1、差分で
 * 増える）と試行（1・2）ごとに、応答の数・断った ID の異なる数・提示元ごとの ID の数を持つ。1 回断って
 * 成功・2 回断って `malformed`・断ったあとの途中停止のどの終わり方でも残る（最終の失敗の欄とは別）。
 */
export interface PlanCliSurfaceIdReuseEntry {
  readonly check: number;
  readonly attempt: number;
  readonly responses: number;
  readonly distinct_ids: number;
  readonly by_source: readonly PlanCliSurfaceIdReuseSourceCount[];
}

/**
 * 記録に入れる落ちの件数の内訳（種類ごと・出どころごと。Issue #430）。**件数だけ**を持ち、落ちの文言・
 * 引用・原文の断片・位置は入れない（`02-failure-modes.md` §1）。
 */
export interface PlanCliMissCountsRecord {
  readonly quote_not_found: number;
  readonly position_mismatch: number;
  readonly uncovered_source: {
    readonly code: number;
    readonly conversation: number;
  };
}

/** 記録に入れる 1 往復の逆照合の診断（Issue #430）。落ちの内訳と、捨てた中身の無い断片の数。 */
export interface PlanCliRoundDiagnosisRecord {
  readonly misses: PlanCliMissCountsRecord;
  readonly dropped_blank_misses: number;
}

/** 記録に入れる、P1/P2 の往復ごとの逆照合の診断（Issue #430）。 */
export interface PlanCliRequirementsDiagnosisRecord {
  readonly rounds: readonly PlanCliRoundDiagnosisRecord[];
  readonly redone: boolean;
  readonly unmet: PlanCliMissCountsRecord;
}

/**
 * 記録に入れる、P3 の「書けない」の申告の点検の判定 1 件（問いの ID・答え・確信度・モデルの版・adapter。
 * 依頼文の全文・申告の文は残さない。Issue #432）。**点検の番号**（`check`。1 始まり）も残す——同じ問いの
 * 名前が点検ごとに繰り返すので、どの点検の判定かを一意に引けるようにする（Issue #434）。
 */
export interface PlanCliSurfaceJudgmentRecord {
  readonly check: number;
  readonly question_id: string;
  readonly answer: string;
  readonly confidence: number | null;
  readonly model: string;
  readonly answered_by: string;
}

/**
 * 記録に入れる、P3 の申告の点検（件数＝受理・落とした・曖昧さへ・未点検と、判定の記録。Issue #432）。
 * **値は件数と判定の記録だけ**である（申告の部分の文・理由・制約 ID は入れない）。
 */
export interface PlanCliSurfaceCheckRecord {
  readonly accepted: number;
  readonly dropped: number;
  readonly ambiguity: number;
  readonly unchecked: number;
  /**
   * 点検が最後まで終えたか（Issue #432）。`false` は予算切れなどで途中で止まり、**申告 0 件と区別**して
   * 全部を点検し終えていないことを示す。
   */
  readonly completed: boolean;
  readonly judgments: readonly PlanCliSurfaceJudgmentRecord[];
}

/**
 * 別ファイルの診断（`--out` の `plan-surface-check.json`。Issue #432）に載せる、申告 1 件の記録。
 * 申告の添字・要件 ID・部分・理由・制約 ID・文書の版と、点検の段階・分類・adapter・確信度・根拠 ID を
 * 結び付ける。**P3 の応答全体や会話の全文は入れない**。
 */
export interface PlanCliSurfaceClaimRecord {
  readonly check: number;
  readonly index: number;
  readonly requirement_id: string;
  readonly part: string;
  readonly reason: string;
  readonly constraint_ids: readonly string[];
  readonly doc_version: string;
  /** 点検の段階（`triage`・`support`・`recheck`） */
  readonly stage: string;
  readonly classification: string;
  /** 答えた adapter（jev・llm・fake。答えが無ければ `none`） */
  readonly adapter: string;
  /** 確信度（不明は `null`） */
  readonly confidence: number | null;
  readonly evidence_id: string | null;
}

/** 別ファイルの診断（`--out` の診断。Issue #432）。`plan-record.json` とは別に置く */
export interface PlanCliSurfaceCheckDiagnostic {
  readonly schema_version: string;
  readonly plan_id: string;
  readonly claims: readonly PlanCliSurfaceClaimRecord[];
}

/** 往復の記録（`--out` の `plan-record.json`。質問・答え・段の記録・使った額） */
export interface PlanCliRecord {
  readonly schema_version: string;
  readonly plan_id: string;
  readonly outcome: PlanResult["kind"];
  readonly rounds: readonly PlanCliRoundRecord[];
  /** 依頼文で閉じた事項（ID・引用・決めた中身。04 §3 P4・Issue #370） */
  readonly closed_by_source: readonly PlanCliSourceClosureRecord[];
  /** 既定で閉じた事項（事項 ID・観点 ID・値。04 §3・Issue #408） */
  readonly closed_by_default: readonly PlanCliDefaultClosureRecord[];
  /** P1/P2 の往復ごとの逆照合の落ちの内訳（種類ごと・出どころごと。値は件数だけ。Issue #430） */
  readonly requirements_diagnosis: PlanCliRequirementsDiagnosisRecord;
  /** P3 の「書けない」の申告の点検（件数と判定の記録。値は件数と記録だけ。Issue #432） */
  readonly surface_check: PlanCliSurfaceCheckRecord;
  /** 差分点検（各往復の P5 のあと）の記録。**値ではなく件数だけ**（Issue #434） */
  readonly diff_reviews: readonly PlanCliDiffReviewRecord[];
  /** 同じ ID の開いている事項の行の衝突の記録（件数と分類と版だけ。Issue #460・#464） */
  readonly open_issue_conflicts: PlanCliOpenIssueConflictRecord;
  /** 使い回しで断った応答の記録（版・試行・応答の数・異なる数・提示元ごとの数。値は入れない。Issue #464） */
  readonly surface_id_reuse: readonly PlanCliSurfaceIdReuseEntry[];
  readonly confirmation: "build" | "stop" | null;
  readonly stages: readonly PlanStageRecord[];
  readonly judge: BundleJudgeUsage;
  readonly budget_usd: number;
  readonly spent_usd: number;
  readonly remaining_usd: number;
  /** 段の失敗の診断（止まったときだけ。値の中身を含まない。Issue #397） */
  readonly failure?: PlanFailure | null;
  /** 確定できなかった理由（確定できないときだけ。値の中身を含まない。Issue #397） */
  readonly cannot_confirm?: readonly CannotConfirmReason[];
}

function toQuestionRecord(question: PlanQuestion): PlanCliQuestionRecord {
  const recommended = question.recommended;
  return {
    id: question.id,
    open_issue_id: question.openIssueId,
    revision: question.revision,
    text: question.text,
    choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })),
    recommended: recommended === undefined ? null : { choice_id: recommended.choiceId, reason: recommended.reason },
    allow_free_text: question.allowFreeText ?? false,
    also_closes: question.alsoCloses ?? [],
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

/** 落ちの内訳を、記録の形（snake_case）に写す（件数だけ。Issue #430） */
function toMissCountsRecord(counts: ReverseCheckMissCounts): PlanCliMissCountsRecord {
  return {
    quote_not_found: counts.quoteNotFound,
    position_mismatch: counts.positionMismatch,
    uncovered_source: { code: counts.uncoveredSource.code, conversation: counts.uncoveredSource.conversation },
  };
}

/** 往復ごとの逆照合の診断を、記録の形（snake_case）に写す（Issue #430） */
function toRequirementsDiagnosisRecord(diagnosis: ReverseCheckDiagnosis): PlanCliRequirementsDiagnosisRecord {
  return {
    rounds: diagnosis.rounds.map((round) => ({
      misses: toMissCountsRecord(round.misses),
      dropped_blank_misses: round.droppedBlankMisses,
    })),
    redone: diagnosis.redone,
    unmet: toMissCountsRecord(diagnosis.unmet),
  };
}

/** P3 の申告の点検の記録を、記録の形（snake_case。確信度は `null`）に写す（Issue #432・#434） */
function toSurfaceCheckRecord(summary: PlanSurfaceCheckSummary): PlanCliSurfaceCheckRecord {
  return {
    accepted: summary.accepted,
    dropped: summary.dropped,
    ambiguity: summary.ambiguity,
    unchecked: summary.unchecked,
    completed: summary.completed,
    judgments: summary.judgments.map((judgment) => ({
      check: judgment.check,
      question_id: judgment.questionId,
      answer: judgment.answer,
      confidence: judgment.confidence ?? null,
      model: judgment.model,
      answered_by: judgment.answeredBy,
    })),
  };
}

/** P3 の申告の点検の診断を、別ファイルに書く形（snake_case）に組む（Issue #432） */
export function buildSurfaceCheckDiagnostic(input: {
  readonly result: PlanResult;
  readonly planId: string;
}): PlanCliSurfaceCheckDiagnostic {
  return {
    schema_version: PLAN_SURFACE_CHECK_SCHEMA,
    plan_id: input.planId,
    claims: input.result.surfaceCheckDiagnostics.map((claim) => ({
      check: claim.check,
      index: claim.index,
      requirement_id: claim.requirementId,
      part: claim.part,
      reason: claim.reason,
      constraint_ids: claim.constraintIds,
      doc_version: claim.docVersion,
      stage: claim.stage,
      classification: claim.classification,
      adapter: claim.adapter,
      confidence: claim.confidence,
      evidence_id: claim.evidenceId,
    })),
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
    closed_by_source: input.result.closedBySource.map((closure) => ({
      issue_id: closure.issueId,
      quote: closure.quote,
      value: closure.value,
    })),
    closed_by_default: input.result.closedByDefault.map((closure) => ({
      issue_id: closure.issueId,
      facet_id: closure.facetId,
      value: closure.value,
    })),
    requirements_diagnosis: toRequirementsDiagnosisRecord(input.result.requirementsDiagnosis),
    surface_check: toSurfaceCheckRecord(input.result.surfaceCheck),
    diff_reviews: input.result.diffReviews.map((review) => ({
      round: review.round,
      added: review.added,
      open_issues: review.openIssues,
      accepted_unwritable: review.acceptedUnwritable,
      out_of_scope: {
        scanned: review.outOfScope.scanned,
        claims: review.outOfScope.claims,
        ambiguities: review.outOfScope.ambiguities,
        deduped: review.outOfScope.deduped,
        rejected_claims: review.outOfScope.rejectedClaims,
        rejected_ambiguities: review.outOfScope.rejectedAmbiguities,
        kinds: review.outOfScope.kinds.map((entry) => ({
          kind: entry.kind,
          claims: entry.claims,
          ambiguities: entry.ambiguities,
        })),
        deduped_indexes: review.outOfScope.dedupedIndexes.slice(),
      },
      inherit: {
        facets: review.inherit.facets.map((entry) => ({
          kind: entry.kind,
          facet_id: entry.facetId,
          count: entry.count,
        })),
        no_parent: review.inherit.noParent,
        multiple_parents: review.inherit.multipleParents,
        unresolved: review.inherit.unresolved.map((entry) => ({ kind: entry.kind, count: entry.count })),
        open_by_source: review.inherit.openBySource.map((entry) => ({ source: entry.source, count: entry.count })),
      },
    })),
    open_issue_conflicts: {
      ids: input.result.openIssueConflicts.ids,
      rows: input.result.openIssueConflicts.rows.map((entry) => ({
        existing: entry.existing,
        added: entry.added,
        count: entry.count,
      })),
      attribution: input.result.openIssueConflicts.attribution.map((entry) => ({
        first: { origin: entry.first.origin, status: entry.first.status, current: entry.first.current },
        second: { origin: entry.second.origin, status: entry.second.status, current: entry.second.current },
        count: entry.count,
      })),
      empty_targets: input.result.openIssueConflicts.emptyTargets,
      round: input.result.openIssueConflicts.round,
    },
    surface_id_reuse: input.result.surfaceIdReuse.map((entry) => ({
      check: entry.check,
      attempt: entry.attempt,
      responses: entry.responses,
      distinct_ids: entry.distinctIds,
      by_source: entry.bySource.map((source) => ({ source: source.source, count: source.count })),
    })),
    confirmation: input.transcript.confirmation,
    stages: input.result.stages,
    judge: input.result.judge,
    budget_usd: input.budgetUsd,
    spent_usd: input.result.spentUsd,
    remaining_usd: input.result.remainingUsd,
    // 確定したときは、どちらの欄も残さない（Issue #397）
    ...(input.result.kind === "stopped" ? { failure: input.result.failure } : {}),
    ...(input.result.kind === "cannot-confirm" ? { cannot_confirm: input.result.reasons } : {}),
  };
}

/** 分類の先頭の何件かを 1 つの文にする（値の中身は含まない。Issue #397） */
function summarizeCodes(codes: readonly string[], head = 3): string {
  const unique = [...new Set(codes)];
  const shown = unique.slice(0, head);
  const rest = unique.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} ほか ${rest} 件` : shown.join(", ");
}

/** 止まった理由の行に出す分類（段の失敗の診断と、P1/P2 のoperation。Issue #397） */
function failureCodes(failure: PlanFailure | null): readonly string[] {
  if (failure === null) return [];
  const codes = (failure.problems ?? []).map((problem) => problem.code);
  if (failure.operation !== undefined) codes.push(failure.operation);
  return codes;
}

/** Plan を確定できずに止まったときの、理由の 1 行（Build を流さないとき出す） */
export function planStopReasonLine(result: PlanResult): string {
  if (result.kind === "cannot-confirm") {
    const codes = summarizeCodes(result.reasons.map((reason) => reason.code));
    return `Plan で確定できませんでした（重大な未解決の事項が ${result.openIssues.length} 件残りました。分類: ${codes}）`;
  }
  if (result.kind === "stopped") {
    const codes = summarizeCodes(failureCodes(result.failure));
    return codes === ""
      ? `Plan を止めました（${result.reason}）`
      : `Plan を止めました（${result.reason}。分類: ${codes}）`;
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
