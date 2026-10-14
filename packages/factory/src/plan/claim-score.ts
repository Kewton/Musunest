// 票と成績の集計（純関数。Issue #459）。**合否は宣言しない**——経路ごとの混同表と、分母を明示した率を
// 出すだけである。
//
//   ① **問いへの答えの成績**：仕分けの形（T1〜T3）の答えを、正解の「申告の種類」で採点し、形ごとの
//      正誤・同じ種類の形の対の同時誤りと不一致・反復の一致率を出す。**裏付けの形の生の答えは今回
//      採点しない**（分布と、`not-found`・`undecidable` の件数と範囲だけ出す）。
//   ② **経路の成績**：最終の行き先を正解で採点する。経路は基準（T1＋S1）から、**仕分けを 1 つだけ
//      替えた**もの（T2＋S1・T3＋S1・T の票＋S1）と、**裏付けを 1 つだけ替えた**もの（T1＋S2・T1＋S3・
//      T1＋S4・T1＋S の票）である。**異種の T 票と S 票を同じ正誤の対に数えない**。
//
// `undetermined`（資料不足）は採点の対象外とし、件数だけ出す（分母に入れない）。
import type { ClaimFormId } from "./claim-forms.js";
import { isInvalidVote } from "./claim-forms.js";
import type { ClaimInput } from "./claim-forms.js";
import {
  destinationOf,
  isTriageVote,
  supportTally,
  triageTally,
  type ClaimDestination,
  type SupportOutcome,
  type TallyRule,
  type TriageTallyState,
} from "./claim-tally.js";
import type { FormVoteRecord, ClaimVoteValue } from "./claim-forms.js";

/** 正解の申告の種類（`undetermined` は採点の対象外） */
export const CLAIM_KIND_LABELS = ["ambiguity", "vocabulary-hole", "not-a-problem", "undetermined"] as const;
export type ClaimKindLabel = (typeof CLAIM_KIND_LABELS)[number];

/** 表現できるかの正解（`undetermined` は採点の対象外） */
export const EXPRESSIBLE_LABELS = ["true", "false", "undetermined"] as const;
export type ExpressibleLabel = (typeof EXPRESSIBLE_LABELS)[number];

/** 正解 1 件 */
export interface ClaimLabel {
  readonly id: string;
  readonly kind: ClaimKindLabel;
  readonly expressible: ExpressibleLabel;
}

/** 正解のファイル（文書の版とハッシュつき） */
export interface LabelSet {
  readonly docVersion: string;
  readonly docHash: string;
  readonly labels: readonly ClaimLabel[];
}

/** 正解のファイルの不備 */
export interface LabelProblems {
  readonly duplicates: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  /** 文書のハッシュの不一致（正解のハッシュ → 文書のハッシュ） */
  readonly docMismatch: { readonly expected: string; readonly actual: string } | null;
}

/** 正解のファイルを、申告の ID と文書のハッシュに照らして検査する */
export function validateLabels(
  labels: LabelSet,
  claimIds: readonly string[],
  docHash: string,
): LabelProblems {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const label of labels.labels) {
    if (seen.has(label.id)) duplicates.push(label.id);
    seen.add(label.id);
  }
  const known = new Set(claimIds);
  const missing = claimIds.filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !known.has(id));
  const docMismatch = labels.docHash === docHash ? null : { expected: labels.docHash, actual: docHash };
  return { duplicates, missing, extra, docMismatch };
}

/** 形 1 つの正誤（仕分けの形だけ） */
export interface FormAnswerScore {
  readonly form: ClaimFormId;
  readonly correct: number;
  readonly incorrect: number;
  readonly undetermined: number;
}

/** 同じ種類の形の対の同時誤りと不一致（仕分けの形） */
export interface FormPairScore {
  readonly a: ClaimFormId;
  readonly b: ClaimFormId;
  readonly bothWrong: number;
  readonly disagree: number;
}

/** 裏付けの形の分布（生の答え。**採点しない**） */
export interface SupportDistribution {
  readonly form: ClaimFormId;
  readonly counts: Readonly<Record<string, number>>;
  readonly notFound: number;
  readonly undecidable: number;
}

/** ① 問いへの答えの成績 */
export interface AnswerScore {
  readonly triage: readonly FormAnswerScore[];
  readonly pairs: readonly FormPairScore[];
  /** 反復の一致率（反復が無ければ `null`） */
  readonly repeatAgreement: number | null;
  readonly support: readonly SupportDistribution[];
}

/** ② 経路の成績（1 申告 × 1 経路） */
export interface PathResult {
  readonly path: string;
  readonly claimId: string;
  readonly destination: ClaimDestination;
  readonly evidenceId: string | null;
  /** その経路が、この申告で組めたか（適用できない形を含む経路は組めない） */
  readonly applicable: boolean;
}

/** 混同表の 1 セル（正解 → 行き先） */
export interface ConfusionCell {
  readonly expected: string;
  readonly actual: string;
  readonly count: number;
}

/** 分母つきの率 */
export interface Rate {
  readonly name: string;
  readonly numerator: number;
  readonly denominator: number;
}

/** 成績 */
export interface ClaimScore {
  readonly answer: AnswerScore;
  readonly paths: readonly PathResult[];
  readonly confusion: readonly ConfusionCell[];
  readonly rates: readonly Rate[];
  /** 採点の対象外（`undetermined`）の件数 */
  readonly undetermined: number;
}

/** 経路の一覧（基準・仕分けを 1 つ替える・裏付けを 1 つ替える） */
export const SCORE_PATHS = [
  "T1+S1",
  "T2+S1",
  "T3+S1",
  "T-vote+S1",
  "T1+S2",
  "T1+S3",
  "T1+S4",
  "T1+S-vote",
] as const;
export type ScorePath = (typeof SCORE_PATHS)[number];

/** 経路が参照する形 */
const PATH_FORMS: Readonly<Record<ScorePath, readonly ClaimFormId[]>> = {
  "T1+S1": ["T1", "S1"],
  "T2+S1": ["T2", "S1"],
  "T3+S1": ["T3", "S1"],
  "T-vote+S1": ["T1", "T2", "T3", "S1"],
  "T1+S2": ["T1", "S2"],
  "T1+S3": ["T1", "S3"],
  "T1+S4": ["T1", "S4"],
  "T1+S-vote": ["T1", "S1", "S2", "S3", "S4"],
};

/** 申告ごとの票の写像（forward の操作の票だけを使う） */
export function votesByClaimForm(votes: readonly FormVoteRecord[]): Map<string, Map<ClaimFormId, ClaimVoteValue>> {
  const byClaim = new Map<string, Map<ClaimFormId, ClaimVoteValue>>();
  for (const record of votes) {
    let byForm = byClaim.get(record.claimId);
    if (byForm === undefined) {
      byForm = new Map<ClaimFormId, ClaimVoteValue>();
      byClaim.set(record.claimId, byForm);
    }
    byForm.set(record.form, record.vote);
  }
  return byClaim;
}

/** その経路が、その申告で組めるか（適用できない形を含むなら組めない） */
export function pathApplicable(path: ScorePath, forms: ReadonlyMap<ClaimFormId, ClaimVoteValue>): boolean {
  return PATH_FORMS[path].every((form) => forms.has(form));
}

/** 仕分けの集計（T の票）を、存在する T の票から作る */
function triageVotesOf(forms: ReadonlyMap<ClaimFormId, ClaimVoteValue>): readonly ClaimVoteValue[] {
  return ["T1", "T2", "T3"]
    .map((form) => forms.get(form as ClaimFormId))
    .filter((entry): entry is ClaimVoteValue => entry !== undefined);
}

/** 裏付けの集計（S の票）を、存在する S2〜S4 の票から作る（S1 は四値でないので入れない） */
function supportVotesOf(forms: ReadonlyMap<ClaimFormId, ClaimVoteValue>): readonly ClaimVoteValue[] {
  return ["S2", "S3", "S4"]
    .map((form) => forms.get(form as ClaimFormId))
    .filter((entry): entry is ClaimVoteValue => entry !== undefined);
}

/** 経路 1 つの行き先を求める（組めなければ `applicable: false`） */
export function pathResultOf(
  path: ScorePath,
  claim: ClaimInput,
  forms: ReadonlyMap<ClaimFormId, ClaimVoteValue>,
  rule: TallyRule,
): PathResult {
  if (!pathApplicable(path, forms)) {
    return { path, claimId: claim.id, destination: "unchecked", evidenceId: null, applicable: false };
  }
  const triageVote = (form: ClaimFormId): TriageTallyState => {
    const entry = forms.get(form);
    return entry === undefined ? "no-forms" : isTriageVote(entry.vote) ? entry.vote : "insufficient";
  };
  const triage: TriageTallyState = path.startsWith("T-vote")
    ? triageTally(
        triageVotesOf(forms).map((entry) => entry.vote),
        rule,
      )
    : triageVote(path.slice(0, 2) as ClaimFormId);

  let support: SupportOutcome;
  if (path.endsWith("+S1")) {
    const vote = forms.get("S1")?.vote;
    const s1Vote: string =
      vote === "supports" || vote === "contradicts" || vote === "not-stated"
        ? vote
        : vote !== undefined && isInvalidVote(vote)
          ? vote
          : "not-stated";
    support = { kind: "s1", vote: s1Vote as "supports" | "contradicts" | "not-stated" };
  } else if (path.endsWith("+S-vote")) {
    support = supportOutcomeOf(forms, rule);
  } else {
    const form = path.slice(-2) as ClaimFormId;
    const entry = forms.get(form);
    support = {
      kind: "tally",
      state: supportStateOfVote(entry),
      evidenceId: entry?.vote === "restricts" ? entry.evidenceId : null,
      insideClaimConstraintIds: entry?.vote === "restricts" ? entry.insideClaimConstraintIds : false,
    };
  }
  const result = destinationOf({ triage, support, claimConstraintIds: claim.constraintIds });
  return { path, claimId: claim.id, destination: result.destination, evidenceId: result.evidenceId, applicable: true };
}

/** 1 つの S の票から、集計と同じ形の状態を出す（四値のみ。それ以外は `insufficient`） */
function supportStateOfVote(entry: ClaimVoteValue | undefined): "backed" | "refuted" | "not-found" | "insufficient" {
  if (entry === undefined) return "insufficient";
  if (entry.vote === "restricts") return "backed";
  if (entry.vote === "provides") return "refuted";
  if (entry.vote === "not-found" || entry.vote === "undecidable") return "not-found";
  return "insufficient";
}

/** S の票の集計を、裏付けの結果にする */
function supportOutcomeOf(forms: ReadonlyMap<ClaimFormId, ClaimVoteValue>, rule: TallyRule): SupportOutcome {
  const entries = supportVotesOf(forms);
  const state = supportTally(
    entries.map((entry) => entry.vote),
    rule,
  );
  const restricting = entries.find((entry) => entry.vote === "restricts");
  return {
    kind: "tally",
    state,
    evidenceId: restricting?.evidenceId ?? null,
    insideClaimConstraintIds: restricting?.insideClaimConstraintIds ?? false,
  };
}

/** 正解から、期待する行き先を出す（採点の対象外なら `null`） */
export function expectedDestination(label: ClaimLabel | undefined): ClaimDestination | null {
  if (label === undefined) return null;
  if (label.kind === "ambiguity") return "ambiguity";
  if (label.kind === "not-a-problem") return "drop";
  if (label.kind !== "vocabulary-hole") return null;
  if (label.expressible === "true") return "drop";
  if (label.expressible === "false") return "accept";
  return null;
}

/** 仕分けの形の答え（正解の種類と比べる値。無効は `invalid`） */
function triageAnswerOf(entry: ClaimVoteValue | undefined): string {
  if (entry === undefined) return "missing";
  if (isTriageVote(entry.vote)) return entry.vote;
  return "invalid";
}

/** ① の成績を出す（仕分けの形だけ採点する） */
function answerScoreOf(
  claims: readonly ClaimInput[],
  forms: ReadonlyMap<string, ReadonlyMap<ClaimFormId, ClaimVoteValue>>,
  labels: ReadonlyMap<string, ClaimLabel>,
  repeatVotes: readonly FormVoteRecord[],
): AnswerScore {
  const triageForms: readonly ClaimFormId[] = ["T1", "T2", "T3"];
  const triage: FormAnswerScore[] = triageForms.map((form) => {
    let correct = 0;
    let incorrect = 0;
    let undetermined = 0;
    for (const claim of claims) {
      const label = labels.get(claim.id);
      if (label === undefined || label.kind === "undetermined") {
        undetermined += 1;
        continue;
      }
      const answer = triageAnswerOf(forms.get(claim.id)?.get(form));
      if (answer === label.kind) correct += 1;
      else incorrect += 1;
    }
    return { form, correct, incorrect, undetermined };
  });

  const pairs: FormPairScore[] = [];
  for (let a = 0; a < triageForms.length; a += 1) {
    for (let b = a + 1; b < triageForms.length; b += 1) {
      const first = triageForms[a];
      const second = triageForms[b];
      if (first === undefined || second === undefined) continue;
      let bothWrong = 0;
      let disagree = 0;
      for (const claim of claims) {
        const label = labels.get(claim.id);
        if (label === undefined || label.kind === "undetermined") continue;
        const answerA = triageAnswerOf(forms.get(claim.id)?.get(first));
        const answerB = triageAnswerOf(forms.get(claim.id)?.get(second));
        if (answerA !== label.kind && answerB !== label.kind) bothWrong += 1;
        if (answerA !== answerB) disagree += 1;
      }
      pairs.push({ a: first, b: second, bothWrong, disagree });
    }
  }

  // 反復の一致率（同じ形 × 同じ申告の、反復をまたいだ票の一致）
  const repeatAgreement = repeatAgreementOf(repeatVotes);

  // 裏付けの形の分布（採点しない）
  const support: SupportDistribution[] = (["S1", "S2", "S3", "S4"] as const).map((form) => {
    const counts: Record<string, number> = {};
    let notFound = 0;
    let undecidable = 0;
    for (const claim of claims) {
      const entry = forms.get(claim.id)?.get(form);
      const key = entry === undefined ? "missing" : entry.vote;
      counts[key] = (counts[key] ?? 0) + 1;
      if (entry?.vote === "not-found") notFound += 1;
      if (entry?.vote === "undecidable") undecidable += 1;
    }
    return { form, counts, notFound, undecidable };
  });

  return { triage, pairs, repeatAgreement, support };
}

/** 反復の一致率（同じ形 × 同じ申告で、反復をまたいで票が一致した割合） */
export function repeatAgreementOf(repeatVotes: readonly FormVoteRecord[]): number | null {
  const groups = new Map<string, Set<string>>();
  for (const record of repeatVotes) {
    if (record.operation === "forward") continue; // forward を基準にする
    const key = `${record.claimId}\0${record.form}`;
    const set = groups.get(key) ?? new Set<string>();
    set.add(String(record.vote.vote));
    groups.set(key, set);
  }
  if (groups.size === 0) return null;
  let agree = 0;
  for (const set of groups.values()) if (set.size === 1) agree += 1;
  return agree / groups.size;
}

/** ② の成績と混同表・率を出す */
export function scoreClaims(input: {
  readonly claims: readonly ClaimInput[];
  readonly votes: readonly FormVoteRecord[];
  readonly repeatVotes?: readonly FormVoteRecord[];
  readonly labels: LabelSet;
  readonly rule: TallyRule;
}): ClaimScore {
  const forms = votesByClaimForm(input.votes);
  const labels = new Map(input.labels.labels.map((label) => [label.id, label]));

  const paths: PathResult[] = [];
  for (const claim of input.claims) {
    const byForm = forms.get(claim.id) ?? new Map<ClaimFormId, ClaimVoteValue>();
    for (const path of SCORE_PATHS) paths.push(pathResultOf(path, claim, byForm, input.rule));
  }

  const confusion: ConfusionCell[] = [];
  const cellCounts = new Map<string, number>();
  let undetermined = 0;
  for (const claim of input.claims) {
    const label = labels.get(claim.id);
    const expected = expectedDestination(label);
    if (expected === null) {
      undetermined += 1;
      continue;
    }
    for (const result of paths.filter((entry) => entry.claimId === claim.id && entry.applicable)) {
      const key = `${expected}\0${result.destination}`;
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of [...cellCounts.entries()].sort()) {
    const [expected, actual] = key.split("\0");
    confusion.push({ expected: expected ?? "", actual: actual ?? "", count });
  }

  // 分母つきの率（経路ごと。ここでは基準の経路 T1+S1 の率を出す）
  const baseline = "T1+S1";
  const baselineResults = paths.filter((entry) => entry.path === baseline && entry.applicable);
  const expressibleClaims = input.claims.filter((claim) => labels.get(claim.id)?.kind === "vocabulary-hole" && labels.get(claim.id)?.expressible === "true");
  const trueHoles = input.claims.filter(
    (claim) => labels.get(claim.id)?.kind === "vocabulary-hole" && labels.get(claim.id)?.expressible === "false",
  );
  const ambiguities = input.claims.filter((claim) => labels.get(claim.id)?.kind === "ambiguity");
  // `undetermined`（資料不足）は分母に入れない（採点の対象外）
  const vocabularyHoles = input.claims.filter((claim) => {
    const label = labels.get(claim.id);
    return label?.kind === "vocabulary-hole" && label.expressible !== "undetermined";
  });

  const countDest = (claims: readonly ClaimInput[], destinations: readonly ClaimDestination[]): number =>
    baselineResults.filter(
      (entry) => claims.some((claim) => claim.id === entry.claimId) && destinations.includes(entry.destination),
    ).length;

  const rates: Rate[] = [
    { name: "偽の穴の受理", numerator: countDest(expressibleClaims, ["accept"]), denominator: expressibleClaims.length },
    {
      name: "真の穴の取り落としと未確定",
      numerator: countDest(trueHoles, ["drop", "unchecked"]),
      denominator: trueHoles.length,
    },
    { name: "曖昧さの取りこぼし", numerator: countDest(ambiguities, ["drop", "unchecked", "accept"]), denominator: ambiguities.length },
    { name: "語彙の穴を曖昧さとする誤り", numerator: countDest(vocabularyHoles, ["ambiguity"]), denominator: vocabularyHoles.length },
    {
      name: "再点検への回付率",
      numerator: input.claims.filter((claim) => baselineResults.some((entry) => entry.claimId === claim.id && entry.destination === "unchecked")).length,
      denominator: input.claims.length,
    },
  ];

  return {
    answer: answerScoreOf(input.claims, forms, labels, input.repeatVotes ?? input.votes),
    paths,
    confusion,
    rates,
    undetermined,
  };
}
