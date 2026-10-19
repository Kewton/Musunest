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
import { checkConfirmedPlan, planDigest, type ConfirmedPlan } from "@musunest/appspec-schema";
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
import { SCRIPT_MATCHER_VERSION, type PlanScriptMatch, type ScriptMatchState } from "./plan/script-responder.js";
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
  /** 台本の答える役が残した、問いごとの照合の結果（台本を使わないときは空。Issue #444） */
  readonly scriptMatches: PlanScriptMatch[];
  /** 確認の画面への答え（まだなら null） */
  confirmation: "build" | "stop" | null;
}

/** 空の往復の記録を作る */
export function createPlanTranscript(): PlanTranscript {
  return { rounds: [], scriptMatches: [], confirmation: null };
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

/** 記録に入れる、台本の照合の結果 1 つ（**値を持たない**。Issue #444） */
export interface PlanCliScriptMatchRecord {
  /** コードが振った質問 ID */
  readonly question_id: string;
  /** その問いを組み立てた仕様の版（往復の版） */
  readonly revision: number;
  /** 有限の照合状態（答えた・不明・重複・選択肢が決まらない・古い版） */
  readonly state: ScriptMatchState;
  /** 当たった台本の項目の添字（1 件に当たったときだけ。それ以外は `null`） */
  readonly entry_index: number | null;
}

/**
 * 記録に入れる、台本の照合（内容の SHA-256・当て方の版・問いごとの結果。Issue #444）。**台本の鍵・
 * 根拠の文・事項 ID の文字列は入れない**——識別は、コードが振った質問 ID・往復の版・項目の添字で行う。
 */
export interface PlanCliScriptRecord {
  /** 台本の内容の SHA-256（小文字の 16 進 64 桁） */
  readonly sha256: string;
  /** 当て方の版 */
  readonly matcher: typeof SCRIPT_MATCHER_VERSION;
  readonly matches: readonly PlanCliScriptMatchRecord[];
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
 * 記録に入れる、照合まで届いた試行 1 つぶん（**値（要件 ID・事項 ID・文）は入れない**。Issue #484）。
 * 点検の版（初回 1、差分で増える）と試行（1・2）ごとに、試行の結果（形で不成立／対象の照合で不成立／
 * 受理）と、断った申告の数・事項の数・分類別の件数を持つ。形の不成立も残す（件数 0 は未照合を表す）。
 */
export interface PlanCliSurfaceTargetAttempt {
  readonly check: number;
  readonly attempt: number;
  /** 試行の結果（`shape`・`target`・`accepted`） */
  readonly result: string;
  readonly rejected_claims: number;
  readonly rejected_ambiguities: number;
  readonly kinds: readonly PlanCliDiffOutOfScopeKindCount[];
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

/** 記録に入れる、原文の文 1 つの覆いの記録（文番号・引用が重なる候補要件の通し番号・枠の有無。Issue #488） */
export interface PlanCliSentenceCoverageRecord {
  readonly sentence: number;
  readonly requirements: readonly number[];
  readonly framing: boolean;
}

/**
 * 記録に入れる、指摘 1 件の記録（種類・見つけた側・重なる文番号・関わる候補要件の通し番号・枠をまたいだか。
 * Issue #488）。**引用・原文の断片・文字の位置・要件の ID は入れない**。
 */
export interface PlanCliMissEntryRecord {
  readonly kind: string;
  readonly found_by: string;
  readonly sentences: readonly number[];
  readonly requirements: readonly number[];
  /** 会話が挙げた断片で、元の範囲が枠と重なっていたか（コードの落ちは false） */
  readonly framing_overlap: boolean;
}

/** 記録に入れる 1 往復の逆照合の診断（Issue #430・#488）。 */
export interface PlanCliRoundDiagnosisRecord {
  readonly misses: PlanCliMissCountsRecord;
  readonly dropped_blank_misses: number;
  /** 原文の文の数 */
  readonly sentence_count: number;
  /** その往復の一覧の候補要件の数 */
  readonly requirement_count: number;
  /** 文ごとの覆い（文番号の順） */
  readonly sentences: readonly PlanCliSentenceCoverageRecord[];
  /** 指摘 1 件ごとの記録（値は入れない） */
  readonly miss_entries: readonly PlanCliMissEntryRecord[];
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

/** 記録に入れる、由来別の、新しく開いた事項の件数（Issue #488） */
export interface PlanCliIssueFlowOriginCount {
  readonly origin: string;
  readonly count: number;
}

/** 記録に入れる、往復で新しく開いた事項の件数（Issue #488） */
export interface PlanCliIssueFlowOpened {
  readonly total: number;
  readonly initial: number;
  readonly diff: number;
  readonly by_origin: readonly PlanCliIssueFlowOriginCount[];
}

/** 記録に入れる、往復で閉じた事項の件数（閉じ方の別。Issue #488） */
export interface PlanCliIssueFlowClosed {
  readonly total: number;
  readonly answer_main: number;
  readonly also_closes: number;
  readonly source: number;
  readonly default: number;
}

/** 記録に入れる、終了時に開いている事項の件数（重大・重大でない別。Issue #488） */
export interface PlanCliIssueFlowOpenCounts {
  readonly critical: number;
  readonly non_critical: number;
}

/**
 * 記録に入れる、往復 1 つぶんの事項の流れ（Issue #488）。**件数と有限の分類だけ**で、事項 ID・要件 ID・
 * 文・答えは入れない。終了時の開いている件数＝開始時の件数＋新しく開いた件数−閉じた件数である。
 */
export interface PlanCliIssueFlowRecord {
  readonly revision: number;
  readonly start_open: number;
  readonly opened: PlanCliIssueFlowOpened;
  readonly closed: PlanCliIssueFlowClosed;
  readonly inherited_resolved: number;
  readonly end_open: PlanCliIssueFlowOpenCounts;
  readonly end: string;
}

/**
 * 記録に入れる、終わりに残った（開いている）事項 1 つぶん（Issue #488）。**値は入れない**——由来・開いた
 * 往復の版・重大か・対象の要件の種類・目録の観点 ID（目録の行だけ）だけである。
 */
export interface PlanCliRemainingOpenIssueRecord {
  readonly origin: string;
  readonly revision: number;
  readonly critical: boolean;
  readonly requirement_kind: string;
  readonly facet_id: string | null;
}

/**
 * 記録に入れる、P6 の文ごとの覆いの記録（Issue #488）。文番号と、覆いの分類（枠・出どころ・対応・無し）と、
 * P2 の引用が重なっていたか（真／偽／未観測）と、判定の助言が閾値以上か（無ければ `null`）を持つ。**値
 * （原文の文・引用・ID）は入れない**。
 */
export interface PlanCliConfirmCoverageRecord {
  readonly sentence: number;
  readonly coverage: string;
  readonly correspondence: string;
  readonly meets_threshold: boolean | null;
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
  /** 照合まで届いた試行 1 つずつの記録（版・試行・結果・件数・分類。値は入れない。Issue #484） */
  readonly surface_target_attempts: readonly PlanCliSurfaceTargetAttempt[];
  /** 往復ごとの事項の流れ（件数と有限の分類だけ。Issue #488） */
  readonly issue_flow: readonly PlanCliIssueFlowRecord[];
  /** 終わりに残った（開いている）事項 1 つずつ（値は入れない。Issue #488） */
  readonly remaining_open_issues: readonly PlanCliRemainingOpenIssueRecord[];
  /** P6 の文ごとの覆い（文番号と分類。値は入れない。P6 まで届かなければ空。Issue #488） */
  readonly confirm_coverage: readonly PlanCliConfirmCoverageRecord[];
  readonly confirmation: "build" | "stop" | null;
  /** 台本の照合の記録（`--script` のときだけ。内容の SHA-256・当て方の版・問いごとの結果。Issue #444） */
  readonly script?: PlanCliScriptRecord;
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

/** 往復ごとの逆照合の診断を、記録の形（snake_case）に写す（Issue #430・#488） */
function toRequirementsDiagnosisRecord(diagnosis: ReverseCheckDiagnosis): PlanCliRequirementsDiagnosisRecord {
  return {
    rounds: diagnosis.rounds.map((round) => ({
      misses: toMissCountsRecord(round.misses),
      dropped_blank_misses: round.droppedBlankMisses,
      sentence_count: round.sentenceCount,
      requirement_count: round.requirementCount,
      sentences: round.sentences.map((sentence) => ({
        sentence: sentence.sentence,
        requirements: sentence.requirements.slice(),
        framing: sentence.framing,
      })),
      miss_entries: round.missEntries.map((entry) => ({
        kind: entry.kind,
        found_by: entry.foundBy,
        sentences: entry.sentences.slice(),
        requirements: entry.requirements.slice(),
        framing_overlap: entry.framingOverlap,
      })),
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

/**
 * 文字列（UTF-8）の SHA-256 を、小文字の 16 進 64 桁で返す（台本の内容の指紋。Issue #444）。
 * `crypto.subtle` を使うので依存を増やさない（`planDigest` と同じ手）。
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 往復の記録を組む（`--out` に書く。納品物には入れない。§7・Issue #336） */
export function buildPlanCliRecord(input: {
  readonly result: PlanResult;
  readonly transcript: PlanTranscript;
  readonly budgetUsd: number;
  readonly planId: string;
  /** 台本を使ったときだけ、その内容の SHA-256（Issue #444） */
  readonly script?: { readonly sha256: string };
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
    surface_target_attempts: input.result.surfaceTargetAttempts.map((entry) => ({
      check: entry.check,
      attempt: entry.attempt,
      result: entry.result,
      rejected_claims: entry.rejectedClaims,
      rejected_ambiguities: entry.rejectedAmbiguities,
      kinds: entry.kinds.map((kind) => ({ kind: kind.kind, claims: kind.claims, ambiguities: kind.ambiguities })),
    })),
    // 往復ごとの事項の流れ（値ではなく件数と有限の分類だけ。Issue #488）
    issue_flow: input.result.issueFlow.map((row) => ({
      revision: row.revision,
      start_open: row.startOpen,
      opened: {
        total: row.opened.total,
        initial: row.opened.initial,
        diff: row.opened.diff,
        by_origin: row.opened.byOrigin.map((entry) => ({ origin: entry.origin, count: entry.count })),
      },
      closed: {
        total: row.closed.total,
        answer_main: row.closed.answerMain,
        also_closes: row.closed.alsoCloses,
        source: row.closed.source,
        default: row.closed.default,
      },
      inherited_resolved: row.inheritedResolved,
      end_open: { critical: row.endOpen.critical, non_critical: row.endOpen.nonCritical },
      end: row.end,
    })),
    // 終わりに残った事項（値は入れない。Issue #488）
    remaining_open_issues: input.result.remainingOpenIssues.map((issue) => ({
      origin: issue.origin,
      revision: issue.revision,
      critical: issue.critical,
      requirement_kind: issue.requirementKind,
      facet_id: issue.facetId,
    })),
    // P6 の文ごとの覆い（P6 まで届かなければ空。値は入れない。Issue #488）
    confirm_coverage: input.result.confirmCoverage.map((sentence) => ({
      sentence: sentence.sentence,
      coverage: sentence.coverage,
      correspondence: sentence.correspondence,
      meets_threshold: sentence.meetsThreshold,
    })),
    confirmation: input.transcript.confirmation,
    // 台本の照合の記録（台本を使ったときだけ。内容の SHA-256・当て方の版・問いごとの結果。Issue #444）
    ...(input.script === undefined
      ? {}
      : {
          script: {
            sha256: input.script.sha256,
            matcher: SCRIPT_MATCHER_VERSION,
            matches: input.transcript.scriptMatches.map((match) => ({
              question_id: match.questionId,
              revision: match.revision,
              state: match.state,
              entry_index: match.entryIndex,
            })),
          },
        }),
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

// ── Plan だけを流す口と、確定した仕様から Build だけを流す口（Issue #495）───────
//
// 工場の評価を Plan 評価・Build 評価・通し評価に分ける（2026-10-15 所有者の決定）。`--plan-only` は Plan を
// 1 回流して、確定した仕様とその SHA-256・原文の SHA-256・実際に使った条件をファイルに書き、Build は
// 流さない。`--plan-file` はそのファイルの包みを検査してから、仕様を正本にして Build だけを流す。
//
// 値を持たない分類（止まり方・検査の符号）だけを書き、原文の文・答え・誤りの文は写さない（02 §1）。

/** Plan だけ／Build だけの実行条件（実際に使った値。Issue #495） */
export interface PlanCliConditions {
  readonly model: string;
  readonly effort: string;
  readonly budget_usd: number;
  readonly deadline_ms: number;
  readonly timeout_ms: number | null;
  readonly vocabulary_version: string;
  readonly prompt_version: string;
  readonly contract_version: string;
  readonly factory_version: string;
  readonly spec_engine_version: string;
}

/** Plan だけの結果を置くファイルの名前（`--out` の直下。納品物には入れない。Issue #495） */
export const PLAN_ONLY_RESULT_FILE = "plan-result.json" as const;
/** Plan だけの結果の版 */
export const PLAN_ONLY_RESULT_SCHEMA = "musunest-factory/plan-only-result/v1" as const;
/** Build だけの記録を置くファイルの名前（`--out` の直下。納品物には入れない。Issue #495） */
export const BUILD_CLI_RECORD_FILE = "build-record.json" as const;
/** Build だけの記録の版 */
export const BUILD_CLI_RECORD_SCHEMA = "musunest-factory/build-cli-record/v1" as const;

/**
 * 確定しなかったときの、止まり方の分類（**値を持たない**。結果の種類・止めた理由・分類の符号だけ。
 * 誤りの文・原文の文は写さない。Issue #495）。
 */
export interface PlanOnlyStopRecord {
  readonly kind: "cannot-confirm" | "stopped";
  /** 止めた理由（`stopped` のときだけ。`cannot-confirm` は `null`） */
  readonly reason: string | null;
  /** 確定できない理由・段の失敗の分類の符号（重複を除く） */
  readonly codes: readonly string[];
}

/** Plan だけの結果（`--out` の `plan-result.json`。Issue #495） */
export interface PlanOnlyResult {
  readonly schema_version: string;
  readonly outcome: PlanResult["kind"];
  /** 確定した仕様（確定しなければ `null`） */
  readonly plan: ConfirmedPlan | null;
  /** 仕様の SHA-256（`planDigest` の値。確認の SHA に等しい。確定しなければ `null`） */
  readonly plan_sha256: string | null;
  /** 原文の SHA-256（`sha256Hex` で求める） */
  readonly source_sha256: string;
  readonly conditions: PlanCliConditions;
  /** 止まり方の分類（確定したときは `null`） */
  readonly stop: PlanOnlyStopRecord | null;
}

/** 符号の並びから重複を除く（順は保つ） */
function uniqueCodes(codes: readonly string[]): readonly string[] {
  return [...new Set(codes)];
}

/** 止まり方の分類を組む（**値を持たない**。符号と、止めた理由だけ。Issue #495） */
export function planOnlyStop(result: PlanResult): PlanOnlyStopRecord | null {
  if (result.kind === "confirmed") return null;
  if (result.kind === "cannot-confirm") {
    return { kind: "cannot-confirm", reason: null, codes: uniqueCodes(result.reasons.map((reason) => reason.code)) };
  }
  return { kind: "stopped", reason: result.reason, codes: uniqueCodes(failureCodes(result.failure)) };
}

/** Plan だけの結果を組む（`--out` に書く。Issue #495） */
export function buildPlanOnlyResult(input: {
  readonly result: PlanResult;
  readonly planSha256: string | null;
  readonly sourceSha256: string;
  readonly conditions: PlanCliConditions;
}): PlanOnlyResult {
  return {
    schema_version: PLAN_ONLY_RESULT_SCHEMA,
    outcome: input.result.kind,
    plan: input.result.kind === "confirmed" ? input.result.plan : null,
    plan_sha256: input.result.kind === "confirmed" ? input.planSha256 : null,
    source_sha256: input.sourceSha256,
    conditions: input.conditions,
    stop: planOnlyStop(input.result),
  };
}

/** Build だけの記録（`--out` の `build-record.json`。条件・2 つの SHA・差し戻しの欄だけ。Issue #495） */
export interface BuildCliRecord {
  readonly schema_version: string;
  readonly conditions: PlanCliConditions;
  readonly plan_sha256: string;
  readonly source_sha256: string;
  /** 差し戻し（`returnToPlan`）が立ったか */
  readonly return_to_plan: boolean;
  /**
   * 書いた境界の checkpoint（境界・ファイル名・出力ダイジェスト。段の走りの記録の `checkpoints` と同じ形）。`--pipeline v1.2`
   * の走りだけが持つ（境界に届かなければ空）。ほかの経路は欄を置かない（Issue #636）
   */
  readonly checkpoints?: readonly BuildCliCheckpoint[];
}

/** Build だけの記録が宣言する checkpoint の 1 件（段の走りの記録の `checkpoints` の 1 件と同じ形。Issue #636） */
export interface BuildCliCheckpoint {
  readonly boundary: string;
  readonly path: string;
  readonly output_digest: string;
}

/** Build だけの記録を組む（`--out` に書く。値は写さない。Issue #495） */
export function buildBuildCliRecord(input: {
  readonly conditions: PlanCliConditions;
  readonly planSha256: string;
  readonly sourceSha256: string;
  readonly returnToPlan: boolean;
  /** 書いた境界の checkpoint（`--pipeline v1.2` の走りだけ渡す。省けば欄を置かない。Issue #636） */
  readonly checkpoints?: readonly BuildCliCheckpoint[];
}): BuildCliRecord {
  return {
    schema_version: BUILD_CLI_RECORD_SCHEMA,
    conditions: input.conditions,
    plan_sha256: input.planSha256,
    source_sha256: input.sourceSha256,
    return_to_plan: input.returnToPlan,
    ...(input.checkpoints === undefined ? {} : { checkpoints: input.checkpoints }),
  };
}

// ── `--plan-file` の包みの読み取りと検査（Issue #495）────────────────────────

/** 包みの読み取りの失敗の版（値を持たない固定の符号だけを 1 行で出す） */
export const PLAN_FILE_ERROR_SCHEMA = "musunest-factory/plan-file-error/v1" as const;
/** 包みの検査で断ったときの版（断った検査の名前と問題の符号だけを出す） */
export const PLAN_FILE_REJECT_SCHEMA = "musunest-factory/plan-file-reject/v1" as const;

/**
 * 包みの読み取りの失敗の固定の符号（**区別する**。Issue #495）。例外の文・ファイル名・入力の値は出さない。
 */
export const PLAN_FILE_ERROR_CODES = [
  /** ファイルを読めない（読取の失敗。cli.ts が出す） */
  "plan-file-read",
  /** JSON として読めない */
  "plan-file-json",
  /** 包みが写像（object）でない */
  "plan-file-envelope",
  /** 必須の欄が欠けている */
  "plan-file-required",
  /** 欄の型が違う */
  "plan-file-type",
] as const;
export type PlanFileErrorCode = (typeof PLAN_FILE_ERROR_CODES)[number];

/**
 * `--plan-file` が読む包み（`plan-result.json` の形。Issue #495）。`plan` は確定した仕様（確定しなければ
 * `null`）。`plan_sha256` も確定しなければ `null`（書く側の `PlanOnlyResult` とそろえる）。
 * `conditions` は人が作る包みでは `null`、または値の無い欄を `null` にした写像でよい。
 * **実行条件は使わない**——Build には今回の `--budget`・`--deadline` を渡す。
 */
export interface PlanFileEnvelope {
  readonly schema_version: string;
  readonly outcome: string;
  readonly plan: unknown;
  readonly plan_sha256: string | null;
  readonly source_sha256: string;
}

/** 包みを読んだ結果（写像と必須欄・型の検査まで） */
export type PlanFileParse =
  | { readonly envelope: PlanFileEnvelope }
  | { readonly code: PlanFileErrorCode };

/** 欄の型の検査（`undefined` は欠落として先に断るので、ここには来ない） */
type FieldCheck = (raw: unknown) => boolean;

const isString: FieldCheck = (raw) => typeof raw === "string";
const isNullableString: FieldCheck = (raw) => raw === null || typeof raw === "string";
const isNullableNumber: FieldCheck = (raw) => raw === null || (typeof raw === "number" && Number.isFinite(raw));

/** `conditions` の欄（`PlanCliConditions` の全欄。人が作る包みでは値の無い欄を `null` にしてよい） */
const CONDITION_FIELDS: readonly (readonly [keyof PlanCliConditions, FieldCheck])[] = [
  ["model", isNullableString],
  ["effort", isNullableString],
  ["budget_usd", isNullableNumber],
  ["deadline_ms", isNullableNumber],
  ["timeout_ms", isNullableNumber],
  ["vocabulary_version", isNullableString],
  ["prompt_version", isNullableString],
  ["contract_version", isNullableString],
  ["factory_version", isNullableString],
  ["spec_engine_version", isNullableString],
];

/** `stop` の欄（`PlanOnlyStopRecord` の全欄） */
const STOP_FIELDS: readonly (readonly [keyof PlanOnlyStopRecord, FieldCheck])[] = [
  ["kind", (raw) => raw === "cannot-confirm" || raw === "stopped"],
  ["reason", isNullableString],
  ["codes", (raw) => Array.isArray(raw) && raw.every((code) => typeof code === "string")],
];

/** 写像の欄を照らす（欠落があれば `plan-file-required`、型違いがあれば `plan-file-type`。欠落を先に見る） */
function checkFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly (readonly [string, FieldCheck])[],
): PlanFileErrorCode | null {
  if (fields.some(([key]) => value[key] === undefined)) return "plan-file-required";
  if (fields.some(([key, check]) => !check(value[key]))) return "plan-file-type";
  return null;
}

/** null か、欄をすべて持つ写像か（入れ子の写像の検査） */
function nullableRecord(fields: readonly (readonly [string, FieldCheck])[]): (raw: unknown) => PlanFileErrorCode | null {
  return (raw) => {
    if (raw === null) return null;
    if (!isRecord(raw)) return "plan-file-type";
    return checkFields(raw, fields);
  };
}

const checkConditions = nullableRecord(CONDITION_FIELDS);
const checkStop = nullableRecord(STOP_FIELDS);

/** 包みの最上位の欄（`PlanOnlyResult` の全欄） */
const ENVELOPE_FIELDS: readonly (readonly [keyof PlanOnlyResult, FieldCheck])[] = [
  ["schema_version", isString],
  ["outcome", isString],
  ["plan", (raw) => raw === null || isRecord(raw)],
  ["plan_sha256", isNullableString],
  ["source_sha256", isString],
  ["conditions", (raw) => raw === null || isRecord(raw)],
  ["stop", (raw) => raw === null || isRecord(raw)],
];

/**
 * 包みの文字列を読む（Issue #495）。JSON でない・写像でない・必須欄が欠ける・型が違うときは、**区別する
 * 固定の符号**を返す（例外の文・入力の値は返さない）。最上位の欄を先に照らし、そのあと `conditions`・`stop`
 * の中の欄を照らす（どれも client を作る前）。確定した仕様の中身の検査は `validatePlanFile` が行う。
 */
export function parsePlanFile(text: string): PlanFileParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { code: "plan-file-json" };
  }
  if (!isRecord(value)) return { code: "plan-file-envelope" };
  const code = checkFields(value, ENVELOPE_FIELDS) ?? checkConditions(value["conditions"]) ?? checkStop(value["stop"]);
  if (code !== null) return { code };
  return {
    envelope: {
      schema_version: value["schema_version"] as string,
      outcome: value["outcome"] as string,
      plan: value["plan"],
      plan_sha256: value["plan_sha256"] as string | null,
      source_sha256: value["source_sha256"] as string,
    },
  };
}

/** 包みの検査で断った内容（断った検査の名前と問題の符号だけ。Issue #495） */
export interface PlanFileRejection {
  readonly check: string;
  readonly codes: readonly string[];
}

/** 包みの検査の結果（通れば仕様と 2 つの SHA、断れば検査の名前と符号） */
export type PlanFileValidation =
  | {
      readonly kind: "ok";
      readonly plan: ConfirmedPlan;
      readonly planSha256: string;
      readonly sourceSha256: string;
    }
  | ({ readonly kind: "rejected" } & PlanFileRejection);

/**
 * 包みを検査する（Issue #495）。次の順で照らし、**1 つでも通らなければ、断った検査の名前と問題の符号**を
 * 返す（`client` を作る前に呼ぶ）。
 *
 *   1. 包みの版が `PLAN_ONLY_RESULT_SCHEMA` と一致する（`envelope-version`）
 *   2. 結果の種類が確定である（`outcome`）
 *   3. `checkConfirmedPlan` が空を返す（形・参照・了承・解決・確認の失効。`plan`）
 *   4. `planDigest` の値が包みの `plan_sha256` と一致する（`plan-sha256`）
 *   5. 依頼文の SHA-256 が `source_sha256` と一致する（`source-sha256`）
 *   6. 仕様の語彙の版が CLI の語彙の版と一致する（`vocabulary`）
 */
export async function validatePlanFile(input: {
  readonly envelope: PlanFileEnvelope;
  readonly source: string;
  readonly vocabularyVersion: string;
}): Promise<PlanFileValidation> {
  const { envelope, source, vocabularyVersion } = input;
  if (envelope.schema_version !== PLAN_ONLY_RESULT_SCHEMA) {
    return { kind: "rejected", check: "envelope-version", codes: ["mismatch"] };
  }
  if (envelope.outcome !== "confirmed") {
    return { kind: "rejected", check: "outcome", codes: ["not-confirmed"] };
  }
  const problems = await checkConfirmedPlan(envelope.plan);
  if (problems.length > 0) {
    return { kind: "rejected", check: "plan", codes: uniqueCodes(problems.map((problem) => problem.code)) };
  }
  const plan = envelope.plan as ConfirmedPlan;
  const planSha256 = await planDigest(plan);
  if (planSha256 !== envelope.plan_sha256) {
    return { kind: "rejected", check: "plan-sha256", codes: ["mismatch"] };
  }
  const sourceSha256 = await sha256Hex(source);
  if (sourceSha256 !== envelope.source_sha256) {
    return { kind: "rejected", check: "source-sha256", codes: ["mismatch"] };
  }
  if (plan.vocabulary_version !== vocabularyVersion) {
    return { kind: "rejected", check: "vocabulary", codes: ["mismatch"] };
  }
  return { kind: "ok", plan, planSha256, sourceSha256 };
}

/** 包みの読み取りの失敗を、1 行（固定の符号だけ）にする（Issue #495） */
export function planFileErrorLine(code: PlanFileErrorCode): string {
  return JSON.stringify({ schema_version: PLAN_FILE_ERROR_SCHEMA, code });
}

/** 包みの検査で断ったときの 1 行（断った検査の名前と問題の符号だけ。Issue #495） */
export function planFileRejectLine(rejection: PlanFileRejection): string {
  return JSON.stringify({
    schema_version: PLAN_FILE_REJECT_SCHEMA,
    check: rejection.check,
    codes: [...rejection.codes],
  });
}
