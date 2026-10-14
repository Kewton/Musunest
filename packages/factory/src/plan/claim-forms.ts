// 記録した「書けない」の申告を、今の点検と形を変えた問いの組で比べるための**問いの形**（Issue #459）。
//
// ここは**判定の口（`Judge`）に閉じた問い**の形だけを定義する——文は作らない（05-judge-model.md §3・
// 03-fix-layer.md H6）。形は ID と版（`v1`）を持ち、次の 7 つである。
//
//   - **T1** … 今の点検の仕分けの問いを、点検と同じ関数（`surfaceTriageQuestion`）で組む
//   - **T2** … 05 §2 E1 の忠実な再現。**1 申告＝1 要求**で、state（要件の文と申告）を渡す。生ラベル
//     （`ambiguity`／`vocabulary_gap`／`not_an_issue`）から共通の 3 ラベルへの写しを宣言する
//   - **T3** … T1 の欄に、要件の文と代わりの案を足す（問いごとに自分の欄。束でよい）
//   - **S1** … 今の点検の裏付けの問いを、同じ関数（`surfaceSupportQuestion`）で組む。票は従来の 3 値で、
//     **四値へ写さず**、S2〜S4 の票にも入れない（別の根拠種別）
//   - **S2** … 申告の制約 ID の節の抜粋に、書く手段を与える／明示的に制限する／どちらも無い／判定不能
//   - **S3** … 語の一覧の形。選択肢はコードが**文書の制約 ID の集合**から組み「どれでもない」を足す。
//     選ばれた ID だけでは票が決まらず、その節に **S2** を掛けた答えで決まる（段ごとに 1 回）
//   - **S4** … 節を段落に切り、段落ごとに S2 と同じ Choice を掛ける（Noul は使わない）
//
// 生の答え →（形の中の集計）→ **一票**の写しをここで固定する。票の値は有限である。集合の外の答えは
// `unknown-answer`、確率が返らない答えは `probability-unknown`、閾値未満は `low-probability`、流さない
// ものは `not-run`、呼び出しの失敗は `failed` にする（黙って消さない）。**`not-found` は「渡した材料に
// 手段が見つからない」であって、表現できない証明ではない**——受理の票にしない。
//
// **実 API は呼ばない。** 判定は差し込まれた `Judge` だけを使う（試験は偽物）。
import type { CallGate } from "../call.js";
import type { Judge, JudgeAnswer, JudgeChoiceQuestion, JudgeQuestion, JudgeRequest, JudgeResponse } from "../judge.js";
import { createCallHash } from "./claim-recorded-judge.js";
import { constraintExcerpt, constraintIdsIn, type PromptDocument } from "../stages/prompt.js";
import type { PlanUnwritable } from "./surface.js";
import { surfaceSupportQuestion, surfaceTriageQuestion } from "./surface-check.js";

/** 問いの形の版（Issue #459）。閾値の表はこの版 × モデルの版で引く */
export const CLAIM_FORMS_VERSION = "v1" as const;

/** 形の ID */
export const CLAIM_FORM_IDS = ["T1", "T2", "T3", "S1", "S2", "S3", "S4"] as const;
export type ClaimFormId = (typeof CLAIM_FORM_IDS)[number];

/** 形の種類（仕分け・裏付け） */
export type ClaimFormKind = "triage" | "support";

/** 形の種類の対応（比較の経路を組むのに使う） */
export const CLAIM_FORM_KIND: Readonly<Record<ClaimFormId, ClaimFormKind>> = {
  T1: "triage",
  T2: "triage",
  T3: "triage",
  S1: "support",
  S2: "support",
  S3: "support",
  S4: "support",
};

/** 仕分けの票のラベル（共通の 3 値） */
export const TRIAGE_VOTES = ["ambiguity", "vocabulary-hole", "not-a-problem"] as const;
export type TriageVote = (typeof TRIAGE_VOTES)[number];

/** 裏付けの票（S2〜S4。四値） */
export const SUPPORT_VOTES = ["restricts", "provides", "not-found", "undecidable"] as const;
export type SupportVote = (typeof SUPPORT_VOTES)[number];

/** 裏付けの票（S1。従来の 3 値で、四値へ写さない。別の根拠種別） */
export const S1_VOTES = ["supports", "contradicts", "not-stated"] as const;
export type S1Vote = (typeof S1_VOTES)[number];

/** 無効の票の理由（有限） */
export const INVALID_VOTE_REASONS = [
  "unknown-answer",
  "low-probability",
  "probability-unknown",
  "not-run",
  "failed",
] as const;
export type InvalidVoteReason = (typeof INVALID_VOTE_REASONS)[number];

/** 1 つの票の値（形の票・無効の票のいずれか） */
export type ClaimVote = TriageVote | SupportVote | S1Vote | InvalidVoteReason;

/** 無効の理由の優先順（1 つだけ選ぶときに使う。failed > not-run > unknown-answer > probability-unknown > low-probability） */
export const INVALID_VOTE_REASON_PRIORITY: readonly InvalidVoteReason[] = [
  "failed",
  "not-run",
  "unknown-answer",
  "probability-unknown",
  "low-probability",
];

const INVALID_VOTE_SET: ReadonlySet<string> = new Set(INVALID_VOTE_REASONS);

/** 無効の票か */
export function isInvalidVote(vote: string): vote is InvalidVoteReason {
  return INVALID_VOTE_SET.has(vote);
}

/** 無効の理由の中から、優先順で 1 つを選ぶ（無ければ `undefined`） */
export function pickInvalidVote(reasons: readonly InvalidVoteReason[]): InvalidVoteReason | undefined {
  for (const reason of INVALID_VOTE_REASON_PRIORITY) {
    if (reasons.includes(reason)) return reason;
  }
  return undefined;
}

// ── 閾値の表（形の版 × モデルの版。Issue #459）────────────────────────────

/**
 * 形の版 × モデルの版の**確率の閾値**（暫定の明示の値）。観測が無い組（または新しいモデル）は登録しない
 * ——登録の無い組では、**送る前に止まる**（勝手な既定で流さない）。確信度からの換算式は根拠が未確認なので
 * 使わない（S3 に 3 択の値を使い回さない）。
 */
export const CLAIM_FORM_THRESHOLDS: Readonly<Record<string, number>> = {
  "v1:fake-judge": 0.5,
  "v1:fake-luna": 0.5,
  "v1:jev-1.13.0": 0.5,
  "v1:gpt-6-luna": 0.5,
};

/** 閾値の表に無い組のときに投げる誤り（送る前に止まる） */
export class ClaimFormsThresholdMissingError extends Error {
  constructor(
    readonly formsVersion: string,
    readonly modelVersion: string,
  ) {
    super(`閾値の表に無い組です（形 ${formsVersion} × モデル ${modelVersion}）`);
    this.name = "ClaimFormsThresholdMissingError";
  }
}

/** 閾値を引く（無ければ `undefined`） */
export function lookupClaimFormThreshold(formsVersion: string, modelVersion: string): number | undefined {
  return CLAIM_FORM_THRESHOLDS[`${formsVersion}:${modelVersion}`];
}

/** 閾値を引き、無ければ投げる（送る前に止まる） */
export function requireClaimFormThreshold(formsVersion: string, modelVersion: string): number {
  const value = lookupClaimFormThreshold(formsVersion, modelVersion);
  if (value === undefined) throw new ClaimFormsThresholdMissingError(formsVersion, modelVersion);
  return value;
}

// ── 申告（道具の入力）──────────────────────────────────────────────

/** 比較の道具の入力の申告 1 件（申告の組 v1。過去の判定は写さない） */
export interface ClaimInput {
  readonly id: string;
  readonly runId: string;
  readonly index: number;
  readonly requirementId: string;
  /** 要件の文（無ければ `null`。T2・T3 は未実施になる） */
  readonly requirementText: string | null;
  readonly part: string;
  readonly reason: string;
  readonly constraintIds: readonly string[];
  /** 代わりの案（無ければ `null`。T3 の欄に載せる） */
  readonly alternative: string | null;
}

/** 申告を、点検の問い（T1・S1）が受け取る形に写す */
function asUnwritable(claim: ClaimInput): PlanUnwritable {
  return {
    id: claim.id,
    requirementId: claim.requirementId,
    part: claim.part,
    reason: claim.reason,
    constraintIds: claim.constraintIds,
    alternative: claim.alternative ?? "",
  };
}

// ── 形の適用（未実施の条件。Issue #459）───────────────────────────────

/** その形が、その申告に適用できるか（適用できない形は**未実施**にする） */
export function formAppliesTo(form: ClaimFormId, claim: ClaimInput): boolean {
  switch (form) {
    case "T1":
      return true;
    case "T2":
      return claim.requirementText !== null;
    case "T3":
      return claim.requirementText !== null;
    case "S1":
      return claim.constraintIds.length > 0;
    case "S2":
      return claim.constraintIds.length > 0;
    case "S3":
      return true;
    case "S4":
      return claim.constraintIds.length > 0;
  }
}

/** 適用できる仕分けの形（順は T1・T2・T3） */
export function triageFormsFor(claim: ClaimInput): readonly ClaimFormId[] {
  return CLAIM_FORM_IDS.filter((form) => CLAIM_FORM_KIND[form] === "triage" && formAppliesTo(form, claim));
}

/** 適用できる裏付けの形（順は S1・S2・S3・S4） */
export function supportFormsFor(claim: ClaimInput): readonly ClaimFormId[] {
  return CLAIM_FORM_IDS.filter((form) => CLAIM_FORM_KIND[form] === "support" && formAppliesTo(form, claim));
}

// ── T2 の生ラベル（05 §2 E1 の忠実な再現。Issue #459）───────────────────

/** T2 の生ラベル（E1 の選択肢の名前） */
export const T2_RAW_LABELS = ["ambiguity", "vocabulary_gap", "not_an_issue"] as const;
export type T2RawLabel = (typeof T2_RAW_LABELS)[number];

/** 生ラベル → 共通の 3 ラベル（宣言した写し。E1 の成績は流用しない） */
export const T2_RAW_TO_COMMON: Readonly<Record<T2RawLabel, TriageVote>> = {
  ambiguity: "ambiguity",
  vocabulary_gap: "vocabulary-hole",
  not_an_issue: "not-a-problem",
};

/** 生ラベルの意味（日本語。新しい形は英語の定型にし、題材の言葉を入れない） */
export const T2_RAW_CRITERIA: Readonly<Record<T2RawLabel, string>> = {
  ambiguity: "曖昧さ・決めたこと・不確かさのメモ（語彙の穴ではない）",
  vocabulary_gap: "文書の語彙に無いために書けない（語彙の穴）",
  not_an_issue: "問題ではない（要件の言い直しなど。実際には書けている）",
};

/** T2 の問いの名前の頭 */
export const T2_QUESTION_PREFIX = "claim-t2" as const;
/** T3 の問いの名前の頭 */
export const T3_QUESTION_PREFIX = "claim-t3" as const;
/** S1 の問いの名前の頭 */
export const S1_QUESTION_PREFIX = "claim-s1" as const;
/** S2 の問いの名前の頭 */
export const S2_QUESTION_PREFIX = "claim-s2" as const;
/** S3 の段 0（語の一覧）の問いの名前の頭 */
export const S3_SELECT_QUESTION_PREFIX = "claim-s3-select" as const;
/** S3 の段 1（選ばれた節の点検）の問いの名前の頭 */
export const S3_SECTION_QUESTION_PREFIX = "claim-s3-section" as const;
/** S4 の問いの名前の頭 */
export const S4_QUESTION_PREFIX = "claim-s4" as const;

/** T2 の問い（1 申告＝1 要求。state に要件の文と申告を置く） */
export function t2Question(): JudgeChoiceQuestion {
  return {
    kind: "choice",
    instructions: {
      ask: "Which kind of 'cannot write' claim is this? Only a claim that is genuinely unwritable because the vocabulary is missing is a vocabulary_gap.",
    },
    criteria: { ...T2_RAW_CRITERIA },
  };
}

/** T2 の要求の state（要件の文と申告） */
export function t2State(claim: ClaimInput): Readonly<Record<string, unknown>> {
  return {
    requirement: claim.requirementText,
    claim: {
      part: claim.part,
      reason: claim.reason,
      constraintIds: claim.constraintIds,
      alternative: claim.alternative,
    },
  };
}

/** T3 の問い（T1 の欄に、要件の文と代わりの案を足す） */
export function t3Question(claim: ClaimInput): JudgeChoiceQuestion {
  return {
    kind: "choice",
    instructions: {
      part: claim.part,
      reason: claim.reason,
      constraintIds: claim.constraintIds,
      requirement: claim.requirementText,
      alternative: claim.alternative,
      ask: "Which kind of 'cannot write' claim is this? Only a claim that is genuinely unwritable because the vocabulary is missing is a vocabulary-hole.",
    },
    criteria: {
      ambiguity: "曖昧さ・決めたこと・不確かさのメモ（語彙の穴ではない）",
      "vocabulary-hole": "文書の語彙に無いために書けない（語彙の穴）",
      "not-a-problem": "問題ではない（要件の言い直しなど。実際には書けている）",
    },
  };
}

// ── 裏付けの 4 択（S2〜S4）──────────────────────────────────────────

/** S2〜S4 の選択肢の名前 */
export const SUPPORT_CHOICE_PROVIDES = "provides" as const;
export const SUPPORT_CHOICE_RESTRICTS = "restricts" as const;
export const SUPPORT_CHOICE_NEITHER = "neither" as const;
export const SUPPORT_CHOICE_UNDECIDABLE = "undecidable" as const;

/** S2〜S4 の選択肢の意味 */
export const SUPPORT_CHOICE_CRITERIA: Readonly<Record<string, string>> = {
  provides: "その節が、書く手段を与える（この部分を書けるようにする語彙・規則がある）",
  restricts: "その節が、明示的に制限する（この部分を書けないと述べている）",
  neither: "どちらも無い（その節はこの部分について何も述べていない）",
  undecidable: "その節からは判定できない",
};

/** S3 の「どれでもない」の選択肢の名前 */
export const S3_NONE_CHOICE = "none-of-them" as const;

/** S2〜S4 の選択肢の集合（生の答えの所属を確かめるのに使う） */
export const SUPPORT_CHOICE_SET: ReadonlySet<string> = new Set([
  SUPPORT_CHOICE_PROVIDES,
  SUPPORT_CHOICE_RESTRICTS,
  SUPPORT_CHOICE_NEITHER,
  SUPPORT_CHOICE_UNDECIDABLE,
]);

/** S2 の問い（申告の制約 ID の節の抜粋に、4 択で答える） */
export function s2Question(claim: ClaimInput, documents: readonly PromptDocument[]): JudgeChoiceQuestion {
  return {
    kind: "choice",
    instructions: {
      // 対象を**データとして**（本文はコードが取り出す。生成させない）
      part: claim.part,
      reason: claim.reason,
      excerpt: constraintExcerpt(documents, claim.constraintIds),
      ask: "Does this section of the documents provide a way to write the part, explicitly restrict it, state neither, or is it undecidable from this section?",
    },
    criteria: { ...SUPPORT_CHOICE_CRITERIA },
  };
}

/** S4 の問い（節を段落に切り、段落ごとに S2 と同じ Choice を掛ける。Noul は使わない） */
export function s4Question(claim: ClaimInput, paragraph: string): JudgeChoiceQuestion {
  return {
    kind: "choice",
    instructions: {
      part: claim.part,
      reason: claim.reason,
      paragraph,
      ask: "Does this paragraph of the documents provide a way to write the part, explicitly restrict it, state neither, or is it undecidable from this paragraph?",
    },
    criteria: { ...SUPPORT_CHOICE_CRITERIA },
  };
}

/**
 * 節の抜粋を段落に切る（S4。空行で切り、空の段落は落とす）。抜粋はコードが取り出す。
 */
export function sectionParagraphs(excerpt: string): readonly string[] {
  return excerpt
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

// ── 答え →（形の中の集計）→ 一票（Issue #459）────────────────────────

/** 票の値に根拠 ID と「申告自身の制約 ID の内側か」の印を添えたもの */
export interface ClaimVoteValue {
  readonly vote: ClaimVote;
  /** 根拠の ID（`provides`／`restricts` のときだけ。それ以外は `null`） */
  readonly evidenceId: string | null;
  /** 根拠が申告自身の制約 ID の内側か（受理の印に使う） */
  readonly insideClaimConstraintIds: boolean;
}

/** 票だけを作る（根拠なし） */
function plainVote(vote: ClaimVote): ClaimVoteValue {
  return { vote, evidenceId: null, insideClaimConstraintIds: false };
}

/**
 * choice の答えから、選んだ値と**確率**を取り出す（Issue #459・F10）。**確信度（`confidence`）で代用しない**
 * ——確率（`probability`）と確信度は別の値であり、確率が返らない答えは `probability-unknown` にする契約である。
 */
function choiceAndProbability(answer: JudgeAnswer | undefined): {
  readonly choice: string | undefined;
  readonly probability: number | undefined;
} {
  if (answer === undefined || answer.kind !== "choice") return { choice: undefined, probability: undefined };
  return { choice: answer.choice, probability: answer.probability };
}

/**
 * 1 つの答えを、無効の理由に写す（無効でなければ `undefined`）。**集合の外は `unknown-answer`、確率が
 * 返らなければ `probability-unknown`、閾値未満は `low-probability`** にする。
 */
export function invalidReasonOf(
  choice: string | undefined,
  probability: number | undefined,
  validChoices: ReadonlySet<string>,
  threshold: number,
): InvalidVoteReason | undefined {
  if (choice === undefined || !validChoices.has(choice)) return "unknown-answer";
  if (probability === undefined) return "probability-unknown";
  if (probability < threshold) return "low-probability";
  return undefined;
}

/** 仕分けの票（T1・T3）の選択肢の集合 */
const TRIAGE_CHOICE_SET: ReadonlySet<string> = new Set(TRIAGE_VOTES);
/** T2 の生ラベルの集合 */
const T2_RAW_SET: ReadonlySet<string> = new Set(T2_RAW_LABELS);
/** S1 の選択肢の集合 */
const S1_CHOICE_SET: ReadonlySet<string> = new Set(S1_VOTES);

/** 仕分けの票（T1・T3）を、1 つの答えから作る */
export function triageVoteOfAnswer(answer: JudgeAnswer | undefined, threshold: number): ClaimVoteValue {
  const { choice, probability } = choiceAndProbability(answer);
  const invalid = invalidReasonOf(choice, probability, TRIAGE_CHOICE_SET, threshold);
  if (invalid !== undefined) return plainVote(invalid);
  return plainVote(choice as TriageVote);
}

/** T2 の票を、1 つの答えから作る（生ラベルを共通の 3 ラベルへ写す） */
export function t2VoteOfAnswer(answer: JudgeAnswer | undefined, threshold: number): ClaimVoteValue {
  const { choice, probability } = choiceAndProbability(answer);
  const invalid = invalidReasonOf(choice, probability, T2_RAW_SET, threshold);
  if (invalid !== undefined) return plainVote(invalid);
  return plainVote(T2_RAW_TO_COMMON[choice as T2RawLabel]);
}

/** S1 の票を、1 つの答えから作る（従来の 3 値。四値へ写さない） */
export function s1VoteOfAnswer(answer: JudgeAnswer | undefined, threshold: number): ClaimVoteValue {
  const { choice, probability } = choiceAndProbability(answer);
  const invalid = invalidReasonOf(choice, probability, S1_CHOICE_SET, threshold);
  if (invalid !== undefined) return plainVote(invalid);
  return plainVote(choice as S1Vote);
}

/** S2・S4 の選択肢を、票の値（四値）に写す */
export function supportVoteOfChoice(choice: string): SupportVote {
  switch (choice) {
    case SUPPORT_CHOICE_PROVIDES:
      return "provides";
    case SUPPORT_CHOICE_RESTRICTS:
      return "restricts";
    case SUPPORT_CHOICE_UNDECIDABLE:
      return "undecidable";
    default:
      return "not-found";
  }
}

/**
 * S2 の票を、1 つの答えから作る（Issue #459）。`evidenceIds` は根拠に使う節の ID、`claimConstraintIds` は
 * **申告自身の制約 ID** である。**根拠が申告の内側かの印は、実際に `claimConstraintIds` に含まれるかで
 * 決める**（S3 は申告の外の節を選びうる。F11）。
 */
export function s2VoteOfAnswer(
  answer: JudgeAnswer | undefined,
  threshold: number,
  evidenceIds: readonly string[],
  claimConstraintIds: readonly string[],
): ClaimVoteValue {
  const { choice, probability } = choiceAndProbability(answer);
  const invalid = invalidReasonOf(choice, probability, SUPPORT_CHOICE_SET, threshold);
  if (invalid !== undefined) return plainVote(invalid);
  const vote = supportVoteOfChoice(choice as string);
  const evidenceId = vote === "provides" || vote === "restricts" ? (evidenceIds[0] ?? null) : null;
  return {
    vote,
    evidenceId,
    insideClaimConstraintIds: evidenceId !== null && claimConstraintIds.includes(evidenceId),
  };
}

/**
 * S3 の段 0 の票（選んだ ID と、その節に S2 を掛けた答え）から、形の票を決める。**選ばれた ID だけでは
 * 決まらず、節の点検の答えで決まる**——選択が無効ならその無効、「どれでもない」なら `not-found`、
 * それ以外は節の点検の答え。
 */
export function combineS3Vote(selection: ClaimVoteValue, section: ClaimVoteValue): ClaimVoteValue {
  if (isInvalidVote(selection.vote)) return selection;
  if (selection.evidenceId === null) return plainVote("not-found");
  return section;
}

/**
 * S4 の段落ごとの票を、形の 1 票にまとめる。**段落に無効が 1 つでもあれば形の票は無効**（残りの答えだけ
 * から `restricts` を作らない）。全部有効なら、`provides` が 1 つでもあれば `provides`、無ければ
 * `restricts` があれば `restricts`、無ければ `undecidable` があれば `undecidable`、全部 `not-found`
 * なら `not-found`。無効の理由は優先順で 1 つ。
 */
export function combineS4Votes(paragraphs: readonly ClaimVoteValue[]): ClaimVoteValue {
  const invalid = pickInvalidVote(
    paragraphs.map((entry) => entry.vote).filter((vote): vote is InvalidVoteReason => isInvalidVote(vote)),
  );
  if (invalid !== undefined) return plainVote(invalid);
  const firstOf = (vote: SupportVote): ClaimVoteValue | undefined =>
    paragraphs.find((entry) => entry.vote === vote);
  return firstOf("provides") ?? firstOf("restricts") ?? firstOf("undecidable") ?? plainVote("not-found");
}

// ── 操作（反復・選択肢の反転。Issue #459）──────────────────────────

/** 操作（1 つの要求の組み方） */
export interface ClaimOperation {
  /** 操作の ID（記録に残す） */
  readonly id: string;
  /** 選択肢の順を反転するか */
  readonly reverse: boolean;
  /** 何回目の反復か（0 始まり） */
  readonly repeat: number;
}

/** 操作の一覧を組む（反復は申告の数に足さない） */
export function buildOperations(repeat: number, reverse: boolean): readonly ClaimOperation[] {
  if (!Number.isInteger(repeat) || repeat < 1) throw new RangeError("反復の回数は 1 以上の整数であること");
  const operations: ClaimOperation[] = [];
  for (let index = 0; index < repeat; index += 1) {
    operations.push({ id: index === 0 ? "forward" : `forward#${index + 1}`, reverse: false, repeat: index });
  }
  if (reverse) {
    for (let index = 0; index < repeat; index += 1) {
      operations.push({ id: index === 0 ? "reverse" : `reverse#${index + 1}`, reverse: true, repeat: index });
    }
  }
  return operations;
}

/** 選択肢の順を反転する（criteria の並びを逆にする。値は変えない） */
function reverseCriteria(criteria: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(criteria).reverse();
  return Object.fromEntries(entries);
}

/** 要求の問いの選択肢の順を、操作に従って反転する */
export function applyOperation(request: JudgeRequest, operation: ClaimOperation): JudgeRequest {
  if (!operation.reverse) return request;
  const questions: Record<string, JudgeQuestion> = {};
  for (const [name, question] of Object.entries(request.questions)) {
    questions[name] =
      question.kind === "choice" ? { ...question, criteria: reverseCriteria(question.criteria) } : question;
  }
  return { ...request, questions };
}

// ── 要求の組み立て ────────────────────────────────────────────────

/** 呼び出しの記録（出力に残す。要求のハッシュと、答えた adapter・モデル・使用量） */
export interface FormCallRecord {
  readonly id: string;
  readonly form: ClaimFormId;
  readonly stage: number;
  readonly operation: string;
  readonly requestHash: string;
  readonly contextIds: readonly string[];
  readonly questionIds: readonly string[];
  readonly state: "ok" | "failed" | "not-run";
  readonly answeredBy: string;
  readonly model: string;
  readonly response: JudgeResponse | null;
}

/** 1 申告 × 1 形 × 1 操作の票（生の答えと票を出力に残す） */
export interface FormVoteRecord {
  readonly claimId: string;
  readonly claimIndex: number;
  readonly form: ClaimFormId;
  readonly operation: string;
  readonly vote: ClaimVoteValue;
}

/**
 * 問い 1 つがどの申告（と段落）に写るか。**申告自身の一意な ID で結ぶ**（別 run・別点検の申告が同じ局所
 * 添字を持ちうるので、添字を束全体の鍵にしない。F4）。
 */
interface QuestionTarget {
  readonly questionId: string;
  readonly claimId: string;
  readonly paragraph?: number;
}

/** 呼び出しの結果（形ごとの票と、呼び出しの記録） */
export interface EvaluateResult {
  readonly votes: readonly FormVoteRecord[];
  readonly calls: readonly FormCallRecord[];
  /** 閾値の表に無い組で止まったか（送る前の停止） */
  readonly thresholdMissing: { readonly formsVersion: string; readonly modelVersion: string } | null;
  /** 選択肢が多すぎて送れなかった形（S3。255 超） */
  readonly tooManyChoices: readonly { readonly form: ClaimFormId; readonly count: number }[];
}

/** 形の評価の入力 */
export interface EvaluateInput {
  readonly claims: readonly ClaimInput[];
  readonly documents: readonly PromptDocument[];
  readonly judge: Judge;
  /** 確率の閾値（形の版 × モデルの版で引く。呼ぶ側が `requireClaimFormThreshold` で引く） */
  readonly threshold: number;
  readonly formsVersion?: string;
  readonly modelVersion: string;
  readonly operation: ClaimOperation;
  /** 実試行の門（上限・締切）。偽なら**呼ばずに** `not-run` にする */
  readonly shouldRun?: () => boolean;
  /**
   * 実試行の門（共有）。**呼ぶ前**に締切を過ぎていれば `not-run`、**呼んだ後**の締切停止は `failed`
   * （実施数に数える）にする（Issue #459・F13）。
   */
  readonly gate?: CallGate;
  /** 選んだ形（省くと全部）。候補は**全申告 × 選んだ形**である */
  readonly forms?: readonly ClaimFormId[];
  /** 選択肢の上限（S3。既定 255） */
  readonly maxChoices?: number;
}

/** S3 の選択肢の上限（255 超は送る前に止める） */
export const CLAIM_FORM_MAX_CHOICES = 255;

/** choice の答えを、問いの答えから取る（無ければ `undefined`） */
function answerOf(response: JudgeResponse | null, questionId: string): JudgeAnswer | undefined {
  return response === null ? undefined : response.answers[questionId];
}

/** 記録（呼び出し）を 1 つ作る（`request` は**実際に送った**要求） */
async function makeCallRecord(input: {
  readonly id: string;
  readonly form: ClaimFormId;
  readonly stage: number;
  readonly operation: ClaimOperation;
  readonly request: JudgeRequest;
  readonly contextIds: readonly string[];
  readonly response: JudgeResponse | null;
  readonly state: CallState;
}): Promise<FormCallRecord> {
  return {
    id: input.id,
    form: input.form,
    stage: input.stage,
    operation: input.operation.id,
    requestHash: await createCallHash(input.request),
    contextIds: input.contextIds,
    questionIds: Object.keys(input.request.questions),
    state: input.state,
    answeredBy: input.response === null ? "none" : input.response.answeredBy,
    model: input.response === null ? "" : input.response.model,
    response: input.response,
  };
}

/** 呼び出しの状態 */
type CallState = "ok" | "failed" | "not-run";

/**
 * 1 つの要求を（門を見て）呼ぶ。**操作（選択肢の反転）はここで実際の要求へ掛ける**——記録だけでなく、
 * **送る要求そのもの**を反転する（Issue #459・F3）。門の締切は、**呼ぶ前に過ぎていれば** `not-run`
 * （未実施）、**呼んだ後に検出すれば** `failed`（実施してから止まった。使用量も数に入る）にする（F13）。
 */
async function callOnce(
  input: EvaluateInput,
  request: JudgeRequest,
): Promise<{ readonly request: JudgeRequest; readonly response: JudgeResponse | null; readonly state: CallState }> {
  const effective = applyOperation(request, input.operation);
  const gate = input.gate;
  if (gate !== undefined && gate.now() >= gate.deadline) {
    return { request: effective, response: null, state: "not-run" };
  }
  if (input.shouldRun !== undefined && !input.shouldRun()) {
    return { request: effective, response: null, state: "not-run" };
  }
  try {
    const response = await input.judge.judge(effective);
    return { request: effective, response, state: "ok" };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    // 上限・予算は**呼ぶ前に**止まる（未実施）。締切は、呼ぶ前の検査を過ぎているので**実施してから**止まった
    // ものとして `failed` にする（未実施に数えない。F13）。それ以外の失敗も `failed`（黙って消さない）
    const notRun = name === "JudgeCallLimitExceededError" || name === "JudgeBudgetExceededError";
    return { request: effective, response: null, state: notRun ? "not-run" : "failed" };
  }
}

/**
 * 申告の束に、選んだ形（T1・T2・T3・S1・S2・S3・S4）を掛ける。**T2 以外は 1 回の呼び出し＝1 形 ×
 * 申告の束**、T2 は 1 申告＝1 要求、S3 は段ごとに 1 回である。**実 API は呼ばない**（差し込まれた
 * `Judge` だけを使う）。
 */
export async function evaluateForms(input: EvaluateInput): Promise<EvaluateResult> {
  const votes: FormVoteRecord[] = [];
  const calls: FormCallRecord[] = [];
  const tooManyChoices: { readonly form: ClaimFormId; readonly count: number }[] = [];
  const threshold = input.threshold;
  const maxChoices = input.maxChoices ?? CLAIM_FORM_MAX_CHOICES;
  const active = input.forms ?? CLAIM_FORM_IDS;
  /** その形が選ばれていて、その申告に適用できるか */
  const applies = (form: ClaimFormId, claim: ClaimInput): boolean =>
    active.includes(form) && formAppliesTo(form, claim);

  const pushVote = (claim: ClaimInput, form: ClaimFormId, value: ClaimVoteValue): void => {
    votes.push({ claimId: claim.id, claimIndex: claim.index, form, operation: input.operation.id, vote: value });
  };

  /** 1 つの要求を（操作を掛けて）呼び、記録を積む */
  const callAndRecord = async (spec: {
    readonly id: string;
    readonly form: ClaimFormId;
    readonly stage: number;
    readonly request: JudgeRequest;
    readonly contextIds: readonly string[];
  }): Promise<{ readonly response: JudgeResponse | null; readonly state: CallState }> => {
    const sent = await callOnce(input, spec.request);
    calls.push(
      await makeCallRecord({
        id: spec.id,
        form: spec.form,
        stage: spec.stage,
        operation: input.operation,
        request: sent.request,
        contextIds: spec.contextIds,
        response: sent.response,
        state: sent.state,
      }),
    );
    return { response: sent.response, state: sent.state };
  };

  // ── T1（今の点検の仕分け。束）────────────────────────────────
  const t1Claims = input.claims.filter((claim) => applies("T1", claim));
  if (t1Claims.length > 0) {
    const questions: Record<string, JudgeChoiceQuestion> = {};
    const targets: QuestionTarget[] = [];
    for (const claim of input.claims) {
      if (!applies("T1", claim)) continue;
      const name = `claim-t1:${claim.id}`;
      questions[name] = surfaceTriageQuestion(asUnwritable(claim));
      targets.push({ questionId: name, claimId: claim.id });
    }
    const request: JudgeRequest = { state: {}, questions };
    const result = await callAndRecord({
      id: "T1",
      form: "T1",
      stage: 0,
      request,
      contextIds: t1Claims.map((claim) => claim.id),
    });
    for (const target of targets) {
      const claim = input.claims.find((entry) => entry.id === target.claimId);
      if (claim === undefined) continue;
      if (result.state !== "ok") {
        pushVote(claim, "T1", plainVote(result.state === "not-run" ? "not-run" : "failed"));
        continue;
      }
      pushVote(claim, "T1", triageVoteOfAnswer(answerOf(result.response, target.questionId), threshold));
    }
  }

  // ── T2（E1 の再現。1 申告＝1 要求）──────────────────────────
  for (const claim of input.claims) {
    if (!applies("T2", claim)) continue;
    const name = `${T2_QUESTION_PREFIX}:${claim.id}`;
    const request: JudgeRequest = { state: t2State(claim), questions: { [name]: t2Question() } };
    const result = await callAndRecord({
      id: `T2:${claim.id}`,
      form: "T2",
      stage: 0,
      request,
      contextIds: [claim.id],
    });
    if (result.state !== "ok") {
      pushVote(claim, "T2", plainVote(result.state === "not-run" ? "not-run" : "failed"));
      continue;
    }
    pushVote(claim, "T2", t2VoteOfAnswer(answerOf(result.response, name), threshold));
  }

  // ── T3（T1 の欄＋要件・代案。束）────────────────────────────
  const t3Claims = input.claims.filter((claim) => applies("T3", claim));
  if (t3Claims.length > 0) {
    const questions: Record<string, JudgeChoiceQuestion> = {};
    const targets: QuestionTarget[] = [];
    for (const claim of t3Claims) {
      const name = `${T3_QUESTION_PREFIX}:${claim.id}`;
      questions[name] = t3Question(claim);
      targets.push({ questionId: name, claimId: claim.id });
    }
    const request: JudgeRequest = { state: {}, questions };
    const result = await callAndRecord({
      id: "T3",
      form: "T3",
      stage: 0,
      request,
      contextIds: t3Claims.map((claim) => claim.id),
    });
    for (const target of targets) {
      const claim = input.claims.find((entry) => entry.id === target.claimId);
      if (claim === undefined) continue;
      if (result.state !== "ok") {
        pushVote(claim, "T3", plainVote(result.state === "not-run" ? "not-run" : "failed"));
        continue;
      }
      pushVote(claim, "T3", triageVoteOfAnswer(answerOf(result.response, target.questionId), threshold));
    }
  }

  // ── S1（今の点検の裏付け。束）────────────────────────────────
  const s1Claims = input.claims.filter((claim) => applies("S1", claim));
  if (s1Claims.length > 0) {
    const questions: Record<string, JudgeChoiceQuestion> = {};
    const targets: QuestionTarget[] = [];
    for (const claim of s1Claims) {
      const name = `${S1_QUESTION_PREFIX}:${claim.id}`;
      questions[name] = surfaceSupportQuestion(asUnwritable(claim), input.documents);
      targets.push({ questionId: name, claimId: claim.id });
    }
    const request: JudgeRequest = { state: {}, questions };
    const result = await callAndRecord({
      id: "S1",
      form: "S1",
      stage: 0,
      request,
      contextIds: s1Claims.map((claim) => claim.id),
    });
    for (const target of targets) {
      const claim = input.claims.find((entry) => entry.id === target.claimId);
      if (claim === undefined) continue;
      if (result.state !== "ok") {
        pushVote(claim, "S1", plainVote(result.state === "not-run" ? "not-run" : "failed"));
        continue;
      }
      pushVote(claim, "S1", s1VoteOfAnswer(answerOf(result.response, target.questionId), threshold));
    }
  }

  // ── S2（手段の形。束）────────────────────────────────────────
  const s2Claims = input.claims.filter((claim) => applies("S2", claim));
  if (s2Claims.length > 0) {
    const questions: Record<string, JudgeChoiceQuestion> = {};
    const targets: QuestionTarget[] = [];
    for (const claim of s2Claims) {
      const name = `${S2_QUESTION_PREFIX}:${claim.id}`;
      questions[name] = s2Question(claim, input.documents);
      targets.push({ questionId: name, claimId: claim.id });
    }
    const request: JudgeRequest = { state: {}, questions };
    const result = await callAndRecord({
      id: "S2",
      form: "S2",
      stage: 0,
      request,
      contextIds: s2Claims.map((claim) => claim.id),
    });
    for (const target of targets) {
      const claim = input.claims.find((entry) => entry.id === target.claimId);
      if (claim === undefined) continue;
      if (result.state !== "ok") {
        pushVote(claim, "S2", plainVote(result.state === "not-run" ? "not-run" : "failed"));
        continue;
      }
      pushVote(
        claim,
        "S2",
        s2VoteOfAnswer(answerOf(result.response, target.questionId), threshold, claim.constraintIds, claim.constraintIds),
      );
    }
  }

  // ── S3（語の一覧。段ごとに 1 回）────────────────────────────
  {
    const s3Claims = input.claims.filter((claim) => applies("S3", claim));
    const documentIds = [...constraintIdsIn(input.documents)];
    if (s3Claims.length > 0) {
      if (documentIds.length + 1 > maxChoices) {
        // 255 超は**送る前に**止める（呼ばない）
        tooManyChoices.push({ form: "S3", count: documentIds.length + 1 });
        for (const claim of s3Claims) pushVote(claim, "S3", plainVote("not-run"));
      } else {
        const selectCriteria: Record<string, string> = {};
        for (const id of documentIds) selectCriteria[id] = `節 ${id} の抜粋`;
        selectCriteria[S3_NONE_CHOICE] = "どれでもない";
        const selectQuestions: Record<string, JudgeChoiceQuestion> = {};
        const selectTargets: QuestionTarget[] = [];
        for (const claim of s3Claims) {
          const name = `${S3_SELECT_QUESTION_PREFIX}:${claim.id}`;
          selectQuestions[name] = {
            kind: "choice",
            instructions: {
              part: claim.part,
              reason: claim.reason,
              ask: "Which candidate section (by id) states that this part cannot be written in the vocabulary? Answer none-of-them if no candidate states it.",
            },
            criteria: selectCriteria,
          };
          selectTargets.push({ questionId: name, claimId: claim.id });
        }
        const selectRequest: JudgeRequest = { state: {}, questions: selectQuestions };
        const selectResult = await callAndRecord({
          id: "S3:select",
          form: "S3",
          stage: 0,
          request: selectRequest,
          contextIds: s3Claims.map((claim) => claim.id),
        });
        const selectionSet = new Set<string>([...documentIds, S3_NONE_CHOICE]);
        const selections: { readonly claim: ClaimInput; readonly section: string | undefined; readonly invalid: ClaimVoteValue | null }[] = [];
        for (const target of selectTargets) {
          const claim = input.claims.find((entry) => entry.id === target.claimId);
          if (claim === undefined) continue;
          if (selectResult.state !== "ok") {
            selections.push({ claim, section: undefined, invalid: plainVote(selectResult.state === "not-run" ? "not-run" : "failed") });
            continue;
          }
          const { choice, probability } = choiceAndProbability(answerOf(selectResult.response, target.questionId));
          const invalid = invalidReasonOf(choice, probability, selectionSet, threshold);
          if (invalid !== undefined) {
            selections.push({ claim, section: undefined, invalid: plainVote(invalid) });
          } else {
            // 選ばれた ID は候補の根拠に留める（票は節の点検の答えで決まる）
            selections.push({ claim, section: choice, invalid: null });
          }
        }
        // 段 1：選ばれた節に S2 を掛ける（どれでもないは掛けない）
        const sectionClaims = selections.filter((entry) => entry.invalid === null && entry.section !== S3_NONE_CHOICE);
        if (sectionClaims.length > 0) {
          const sectionQuestions: Record<string, JudgeChoiceQuestion> = {};
          const sectionTargets: QuestionTarget[] = [];
          for (const entry of sectionClaims) {
            const name = `${S3_SECTION_QUESTION_PREFIX}:${entry.claim.id}`;
            sectionQuestions[name] = {
              kind: "choice",
              instructions: {
                part: entry.claim.part,
                reason: entry.claim.reason,
                excerpt: constraintExcerpt(input.documents, [entry.section ?? ""]),
                ask: "Does this section of the documents provide a way to write the part, explicitly restrict it, state neither, or is it undecidable from this section?",
              },
              criteria: { ...SUPPORT_CHOICE_CRITERIA },
            };
            sectionTargets.push({ questionId: name, claimId: entry.claim.id });
          }
          const sectionRequest: JudgeRequest = { state: {}, questions: sectionQuestions };
          const sectionResult = await callAndRecord({
            id: "S3:section",
            form: "S3",
            stage: 1,
            request: sectionRequest,
            contextIds: sectionClaims.map((entry) => entry.claim.id),
          });
          for (const target of sectionTargets) {
            const entry = sectionClaims.find((candidate) => candidate.claim.id === target.claimId);
            if (entry === undefined) continue;
            if (sectionResult.state !== "ok") {
              pushVote(entry.claim, "S3", plainVote(sectionResult.state === "not-run" ? "not-run" : "failed"));
              continue;
            }
            const sectionVote = s2VoteOfAnswer(
              answerOf(sectionResult.response, target.questionId),
              threshold,
              entry.section === undefined ? [] : [entry.section],
              entry.claim.constraintIds,
            );
            pushVote(
              entry.claim,
              "S3",
              combineS3Vote(
                {
                  vote: "provides",
                  evidenceId: entry.section ?? null,
                  insideClaimConstraintIds: entry.section !== undefined && entry.claim.constraintIds.includes(entry.section),
                },
                sectionVote,
              ),
            );
          }
        }
        // 選択が無効・どれでもない・段 1 が未実行の申告の票
        for (const entry of selections) {
          if (entry.invalid !== null) {
            pushVote(entry.claim, "S3", entry.invalid);
            continue;
          }
          if (entry.section === S3_NONE_CHOICE) {
            pushVote(entry.claim, "S3", plainVote("not-found"));
            continue;
          }
          if (sectionClaims.some((candidate) => candidate.claim.id === entry.claim.id)) continue;
          pushVote(entry.claim, "S3", plainVote("not-run"));
        }
      }
    }
  }

  // ── S4（段落ごと。束）────────────────────────────────────────
  const s4Claims = input.claims.filter((claim) => applies("S4", claim));
  if (s4Claims.length > 0) {
    const questions: Record<string, JudgeChoiceQuestion> = {};
    const targets: { readonly questionId: string; readonly claimId: string; readonly paragraph: number }[] = [];
    for (const claim of s4Claims) {
      const paragraphs = sectionParagraphs(constraintExcerpt(input.documents, claim.constraintIds));
      const usable = paragraphs.length === 0 ? [constraintExcerpt(input.documents, claim.constraintIds)] : paragraphs;
      usable.forEach((paragraph, index) => {
        const name = `${S4_QUESTION_PREFIX}:${claim.id}:${index}`;
        questions[name] = s4Question(claim, paragraph);
        targets.push({ questionId: name, claimId: claim.id, paragraph: index });
      });
    }
    const request: JudgeRequest = { state: {}, questions };
    const result = await callAndRecord({
      id: "S4",
      form: "S4",
      stage: 0,
      request,
      contextIds: s4Claims.map((claim) => claim.id),
    });
    for (const claim of s4Claims) {
      if (result.state !== "ok") {
        pushVote(claim, "S4", plainVote(result.state === "not-run" ? "not-run" : "failed"));
        continue;
      }
      const paragraphVotes = targets
        .filter((target) => target.claimId === claim.id)
        .map((target) =>
          s2VoteOfAnswer(answerOf(result.response, target.questionId), threshold, claim.constraintIds, claim.constraintIds),
        );
      pushVote(claim, "S4", combineS4Votes(paragraphVotes));
    }
  }

  return { votes, calls, thresholdMissing: null, tooManyChoices };
}
