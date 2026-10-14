// 票の集計と、申告の行き先（純関数。全状態を真理表で固定する。Issue #459）。
//
// 分母 n は**予定した適用可能な形の数**である（無効の票を分母から除かない）。n＝0 は `no-forms`。
// 仕分けと裏付けの集計は、`unanimous`（全会一致）と `majority`（厳密な過半数）の 2 つの規則を固定する。
// 集計の結果と、申告の行き先（受理・落とす・曖昧さへ・未点検）は**有限の状態**で、各入力がちょうど 1 つに
// 落ちる。
import {
  isInvalidVote,
  type ClaimVote,
  type ClaimVoteValue,
  type InvalidVoteReason,
  type S1Vote,
  type SupportVote,
  type TriageVote,
} from "./claim-forms.js";

/** 集計の規則 */
export type TallyRule = "unanimous" | "majority";

/** 仕分けの集計の状態（有限） */
export const TRIAGE_TALLY_STATES = [
  "ambiguity",
  "vocabulary-hole",
  "not-a-problem",
  "split",
  "insufficient",
  "no-forms",
] as const;
export type TriageTallyState = (typeof TRIAGE_TALLY_STATES)[number];

/** 裏付けの集計の状態（有限） */
export const SUPPORT_TALLY_STATES = [
  "backed",
  "refuted",
  "not-found",
  "split",
  "insufficient",
  "no-forms",
] as const;
export type SupportTallyState = (typeof SUPPORT_TALLY_STATES)[number];

const TRIAGE_VOTE_SET: ReadonlySet<string> = new Set(["ambiguity", "vocabulary-hole", "not-a-problem"]);
const SUPPORT_VOTE_SET: ReadonlySet<string> = new Set(["restricts", "provides", "not-found", "undecidable"]);

/** 仕分けの票か */
export function isTriageVote(vote: string): vote is TriageVote {
  return TRIAGE_VOTE_SET.has(vote);
}

/** 裏付けの票（四値）か */
export function isSupportVote(vote: string): vote is SupportVote {
  return SUPPORT_VOTE_SET.has(vote);
}

/** 仕分けの票を集計する（分母 n は票の数。無効を除かない） */
export function triageTally(votes: readonly ClaimVote[], rule: TallyRule): TriageTallyState {
  const n = votes.length;
  if (n === 0) return "no-forms";
  const invalid = votes.filter((vote) => isInvalidVote(vote)).length;
  const valid = votes.filter((vote): vote is TriageVote => isTriageVote(vote));
  if (rule === "unanimous") {
    if (invalid > 0) return "insufficient";
    if (valid.length === n) {
      const first = valid[0];
      if (first !== undefined && valid.every((vote) => vote === first)) return first;
    }
    return "split";
  }
  // majority：あるラベルが n の厳密な過半数ならそのラベル
  for (const label of ["ambiguity", "vocabulary-hole", "not-a-problem"] as const) {
    const count = valid.filter((vote) => vote === label).length;
    if (count * 2 > n) return label;
  }
  // 有効票が過半数に届かなければ insufficient、それ以外（衝突）は split
  if (valid.length * 2 <= n) return "insufficient";
  return "split";
}

/** 裏付けの票を集計する（分母 n は票の数。無効を除かない） */
export function supportTally(votes: readonly ClaimVote[], rule: TallyRule): SupportTallyState {
  const n = votes.length;
  if (n === 0) return "no-forms";
  const invalid = votes.filter((vote) => isInvalidVote(vote)).length;
  const valid = votes.filter((vote): vote is SupportVote => isSupportVote(vote));
  const restricts = valid.filter((vote) => vote === "restricts").length;
  const provides = valid.filter((vote) => vote === "provides").length;
  // 有効な restricts と provides が両方あれば、規則に依らず split
  if (restricts > 0 && provides > 0) return "split";
  if (rule === "unanimous") {
    if (invalid > 0) return "insufficient";
    if (valid.length === n && restricts === n) return "backed";
    if (valid.length === n && provides === n) return "refuted";
    return "not-found";
  }
  // majority
  if (restricts * 2 > n) return "backed";
  if (provides * 2 > n) return "refuted";
  if (valid.length * 2 <= n) return "insufficient";
  return "not-found";
}

/** 1 つの仕分けの票から、集計と同じ形の状態を出す（1 形だけの経路に使う） */
export function triageStateOfVote(vote: ClaimVote): TriageTallyState {
  return isTriageVote(vote) ? vote : "insufficient";
}

/** 1 つの裏付けの票から、集計と同じ形の状態を出す（1 形だけの経路に使う） */
export function supportStateOfVote(vote: ClaimVote): SupportTallyState {
  if (vote === "restricts") return "backed";
  if (vote === "provides") return "refuted";
  if (vote === "not-found" || vote === "undecidable") return "not-found";
  return "insufficient";
}

// ── 申告の行き先（有限。Issue #459）───────────────────────────────

/** 申告の行き先（有限） */
export const CLAIM_DESTINATIONS = ["ambiguity", "drop", "accept", "unchecked"] as const;
export type ClaimDestination = (typeof CLAIM_DESTINATIONS)[number];

/** 裏付けの結果（S2〜S4 の集計か、S1 の 1 票か） */
export type SupportOutcome =
  | {
      readonly kind: "tally";
      readonly state: SupportTallyState;
      readonly evidenceId: string | null;
      readonly insideClaimConstraintIds: boolean;
    }
  | { readonly kind: "s1"; readonly vote: S1Vote | InvalidVoteReason };

/** 行き先の判定の入力 */
export interface DestinationInput {
  readonly triage: TriageTallyState;
  readonly support: SupportOutcome;
  /** 申告自身の制約 ID（S1 の受理の根拠 ID に使う） */
  readonly claimConstraintIds: readonly string[];
}

/** 行き先の判定の結果 */
export interface DestinationResult {
  readonly destination: ClaimDestination;
  /** 受理の根拠 ID（受理のときだけ。無ければ `null`） */
  readonly evidenceId: string | null;
  /** 根拠が申告自身の制約 ID の内側か（受理のときだけ true） */
  readonly insideClaimConstraintIds: boolean;
}

const UNCHECKED: DestinationResult = { destination: "unchecked", evidenceId: null, insideClaimConstraintIds: false };
const DROPPED: DestinationResult = { destination: "drop", evidenceId: null, insideClaimConstraintIds: false };

/**
 * 申告の行き先を決める（有限）。**仕分けが決まらない申告は、裏付けだけで受理しない**。`vocabulary-hole`
 * かつ裏付けが `backed`（S1 なら `supports`）のときだけ受理する——根拠 ID と、申告自身の制約 ID の
 * 内側かの印を添える。
 */
export function destinationOf(input: DestinationInput): DestinationResult {
  if (input.triage === "ambiguity") return { destination: "ambiguity", evidenceId: null, insideClaimConstraintIds: false };
  if (input.triage === "not-a-problem") return DROPPED;
  if (input.triage !== "vocabulary-hole") return UNCHECKED;
  const support = input.support;
  if (support.kind === "s1") {
    if (support.vote === "supports") {
      const evidenceId = input.claimConstraintIds[0] ?? null;
      return { destination: "accept", evidenceId, insideClaimConstraintIds: evidenceId !== null };
    }
    if (support.vote === "contradicts") return DROPPED;
    return UNCHECKED;
  }
  if (support.state === "backed") {
    return { destination: "accept", evidenceId: support.evidenceId, insideClaimConstraintIds: support.insideClaimConstraintIds };
  }
  if (support.state === "refuted") return DROPPED;
  return UNCHECKED;
}

/** 申告自身の制約 ID の内側かを引く（S1 の受理の印に使う） */
export function insideConstraintIds(claimConstraintIds: readonly string[], evidenceId: string | null): boolean {
  return evidenceId !== null && claimConstraintIds.includes(evidenceId);
}

/** 票の並びから、裏付けの結果（集計）を作る（根拠 ID は `restricts` の票から取る） */
export function supportOutcomeOfVotes(votes: readonly ClaimVoteValue[], rule: TallyRule): SupportOutcome {
  const state = supportTally(
    votes.map((entry) => entry.vote),
    rule,
  );
  const restricting = votes.find((entry) => entry.vote === "restricts");
  return {
    kind: "tally",
    state,
    evidenceId: restricting?.evidenceId ?? null,
    insideClaimConstraintIds: restricting?.insideClaimConstraintIds ?? false,
  };
}

/** 票の並びから、仕分けの集計を作る */
export function triageStateOfVotes(votes: readonly ClaimVoteValue[], rule: TallyRule): TriageTallyState {
  return triageTally(
    votes.map((entry) => entry.vote),
    rule,
  );
}
