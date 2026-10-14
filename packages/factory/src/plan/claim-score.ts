// 票と成績の集計（純関数。Issue #459）。**合否は宣言しない**——経路ごとの混同表と、分母を明示した率を
// 出すだけである。
//
//   ① **問いへの答えの成績**：仕分けの形（T1〜T3）の答えを、正解の「申告の種類」で採点し、形ごとの
//      正誤・同じ種類の形の対の同時誤りと不一致・反復の一致率を出す。**適用できない形は採点に数えない**。
//      **裏付けの形の生の答えは今回採点しない**（分布と、`not-found`・`undecidable` の件数と範囲だけ出す）。
//   ② **経路の成績**：最終の行き先を正解で採点する。経路は**基準の 2 本**（再点検あり／なし）と、
//      仕分けを 1 つだけ替えたもの（T2＋S1・T3＋S1・T の票＋S1）、裏付けを 1 つだけ替えたもの（T1＋S2・
//      T1＋S3・T1＋S4・T1＋S の票）である。混同表と率は**経路ごと**に出し、元 run・制約 ID・要件の文の
//      有無で**層別**する。**異種の T 票と S 票を同じ正誤の対に数えない**。
//
// `undetermined`（資料不足）と**文脈不足（要件の文が無い）**の申告は採点の対象外とし、分母に入れない。
import { formAppliesTo, isInvalidVote, type ClaimFormId } from "./claim-forms.js";
import type { ClaimInput, ClaimVoteValue, FormVoteRecord } from "./claim-forms.js";
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

/** 混同表の 1 セル（経路 × 正解 → 行き先） */
export interface ConfusionCell {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  readonly count: number;
}

/** 層別した、分母つきの率 */
export interface Rate {
  readonly path: string;
  /** 層（`all`・`run:<ID>`・`constraint:yes|no`・`text:yes|no`） */
  readonly stratum: string;
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
  /** 採点の対象外（`undetermined`・文脈不足）の件数 */
  readonly undetermined: number;
  /** 文脈不足で分母から外した件数 */
  readonly contextInsufficient: number;
}

/** 形の経路の一覧（基準から、仕分けを 1 つ替える・裏付けを 1 つ替える） */
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

/** 基準の 2 経路の名前（点検の結果から作る） */
export const BASELINE_PATHS = ["baseline:recheck", "baseline:no-recheck"] as const;
export type BaselinePath = (typeof BASELINE_PATHS)[number];

/** 率の名前（分母の定義とともに固定する） */
export const RATE_NAMES = {
  falseHole: "偽の穴の受理",
  trueHoleMiss: "真の穴の誤った取り落としと最終の未確定",
  ambiguityMiss: "曖昧さの取りこぼし",
  holeAsAmbiguity: "語彙の穴を曖昧さとする誤り",
  recheckReferral: "再点検への回付率",
} as const;

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
  return (["T1", "T2", "T3"] as const)
    .map((form) => forms.get(form))
    .filter((entry): entry is ClaimVoteValue => entry !== undefined);
}

/** 裏付けの集計（S の票）を、存在する S2〜S4 の票から作る（S1 は四値でないので入れない） */
function supportVotesOf(forms: ReadonlyMap<ClaimFormId, ClaimVoteValue>): readonly ClaimVoteValue[] {
  return (["S2", "S3", "S4"] as const)
    .map((form) => forms.get(form))
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

/** ① の成績を出す（仕分けの形だけ採点する。**適用できない形は数えない**） */
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
      if (!formAppliesTo(form, claim)) continue;
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
        if (!formAppliesTo(first, claim) || !formAppliesTo(second, claim)) continue;
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

  const repeatAgreement = repeatAgreementOf(repeatVotes);

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

/** 操作の向き（`forward` か `reverse` か）を、操作の ID から出す */
function directionOf(operation: string): "forward" | "reverse" {
  return operation.startsWith("reverse") ? "reverse" : "forward";
}

/**
 * 反復の一致率（issue #459・F9）。**同じ形 × 同じ申告 × 同じ向き**の反復を 1 つの群にまとめ、**初回も
 * 群に含める**。反復（2 回以上）を持つ群だけを数え、**反転と混ぜない**。反復が無ければ `null`。
 */
export function repeatAgreementOf(repeatVotes: readonly FormVoteRecord[]): number | null {
  const groups = new Map<string, Set<string>>();
  for (const record of repeatVotes) {
    const key = `${record.claimId}\0${record.form}\0${directionOf(record.operation)}`;
    const set = groups.get(key) ?? new Set<string>();
    set.add(String(record.vote.vote));
    groups.set(key, set);
  }
  // 群の大きさ（反復の回数）は operation の数で数える——同じ (claim, form, 向き) で 2 回以上あるものだけ
  const counts = new Map<string, number>();
  for (const record of repeatVotes) {
    const key = `${record.claimId}\0${record.form}\0${directionOf(record.operation)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let total = 0;
  let agree = 0;
  for (const [key, set] of groups) {
    if ((counts.get(key) ?? 0) < 2) continue;
    total += 1;
    if (set.size === 1) agree += 1;
  }
  if (total === 0) return null;
  return agree / total;
}

/** 層の一覧（`all`・run ごと・制約 ID の有無・要件の文の有無） */
function strataOf(claims: readonly ClaimInput[]): readonly { readonly key: string; readonly ids: ReadonlySet<string> }[] {
  const strata: { key: string; ids: ReadonlySet<string> }[] = [
    { key: "all", ids: new Set(claims.map((claim) => claim.id)) },
  ];
  const runs = new Set(claims.map((claim) => claim.runId));
  for (const runId of runs) {
    strata.push({ key: `run:${runId}`, ids: new Set(claims.filter((claim) => claim.runId === runId).map((claim) => claim.id)) });
  }
  for (const [label, predicate] of [
    ["constraint:yes", (claim: ClaimInput): boolean => claim.constraintIds.length > 0],
    ["constraint:no", (claim: ClaimInput): boolean => claim.constraintIds.length === 0],
    ["text:yes", (claim: ClaimInput): boolean => claim.requirementText !== null],
    ["text:no", (claim: ClaimInput): boolean => claim.requirementText === null],
  ] as const) {
    strata.push({ key: label, ids: new Set(claims.filter(predicate).map((claim) => claim.id)) });
  }
  return strata;
}

/** 分母つきの 5 つの率を、層の中で数える */
function ratesOf(input: {
  readonly path: string;
  readonly stratum: string;
  readonly claims: readonly ClaimInput[];
  readonly labels: ReadonlyMap<string, ClaimLabel>;
  readonly destinationOf: (claimId: string) => ClaimDestination | null;
}): readonly Rate[] {
  const { path, stratum, claims, labels } = input;
  const dest = input.destinationOf;
  const count = (predicate: (label: ClaimLabel, destination: ClaimDestination) => boolean): number => {
    let n = 0;
    for (const claim of claims) {
      const label = labels.get(claim.id);
      const destination = dest(claim.id);
      if (label === undefined || destination === null) continue;
      if (predicate(label, destination)) n += 1;
    }
    return n;
  };
  const denom = (predicate: (label: ClaimLabel) => boolean): number =>
    claims.filter((claim) => {
      const label = labels.get(claim.id);
      return label !== undefined && dest(claim.id) !== null && predicate(label);
    }).length;

  const rate = (name: string, numerator: number, denominator: number): Rate => ({ path, stratum, name, numerator, denominator });
  return [
    rate(
      RATE_NAMES.falseHole,
      count((label, destination) => label.expressible === "true" && destination === "accept"),
      denom((label) => label.expressible === "true"),
    ),
    rate(
      RATE_NAMES.trueHoleMiss,
      count((label, destination) => label.kind === "vocabulary-hole" && label.expressible === "false" && destination !== "accept"),
      denom((label) => label.kind === "vocabulary-hole" && label.expressible === "false"),
    ),
    rate(
      RATE_NAMES.ambiguityMiss,
      count((label, destination) => label.kind === "ambiguity" && destination !== "ambiguity"),
      denom((label) => label.kind === "ambiguity"),
    ),
    rate(
      RATE_NAMES.holeAsAmbiguity,
      count((label, destination) => label.kind === "vocabulary-hole" && label.expressible !== "undetermined" && destination === "ambiguity"),
      denom((label) => label.kind === "vocabulary-hole" && label.expressible !== "undetermined"),
    ),
    rate(
      RATE_NAMES.recheckReferral,
      count((_label, destination) => destination === "unchecked"),
      denom(() => true),
    ),
  ];
}

/** ② の成績と混同表・率を出す */
export function scoreClaims(input: {
  readonly claims: readonly ClaimInput[];
  readonly votes: readonly FormVoteRecord[];
  readonly repeatVotes?: readonly FormVoteRecord[];
  readonly labels: LabelSet;
  readonly rule: TallyRule;
  /** 基準の 2 経路の行き先（経路名 → 申告 ID → 行き先） */
  readonly baselines?: ReadonlyMap<string, ReadonlyMap<string, ClaimDestination>>;
  /** 文脈不足（要件の文が無い）で分母から外す申告の ID */
  readonly contextInsufficient?: ReadonlySet<string>;
}): ClaimScore {
  const forms = votesByClaimForm(input.votes);
  const labels = new Map(input.labels.labels.map((label) => [label.id, label]));
  const excluded = input.contextInsufficient ?? new Set<string>();

  // 仕分けの答えを採点する申告（文脈不足だけを外す。種類が undetermined の申告は答えの成績で数える）
  const notExcluded = input.claims.filter((claim) => !excluded.has(claim.id));
  // 経路・混同表・率に使う申告（文脈不足と、期待の行き先が定まらない申告を外す。F8）
  const scored = notExcluded.filter((claim) => expectedDestination(labels.get(claim.id)) !== null);

  // 経路ごとの行き先（形の経路 + 基準の 2 経路）
  const destByPath = new Map<string, Map<string, ClaimDestination>>();
  const paths: PathResult[] = [];
  for (const claim of scored) {
    const byForm = forms.get(claim.id) ?? new Map<ClaimFormId, ClaimVoteValue>();
    for (const path of SCORE_PATHS) {
      const result = pathResultOf(path, claim, byForm, input.rule);
      paths.push(result);
      if (result.applicable) {
        const map = destByPath.get(path) ?? new Map<string, ClaimDestination>();
        map.set(claim.id, result.destination);
        destByPath.set(path, map);
      }
    }
  }
  for (const baseline of BASELINE_PATHS) {
    const map = input.baselines?.get(baseline);
    if (map === undefined) continue;
    const kept = new Map<string, ClaimDestination>();
    for (const [claimId, destination] of map) if (!excluded.has(claimId)) kept.set(claimId, destination);
    destByPath.set(baseline, kept);
    for (const claim of scored) {
      if (kept.has(claim.id)) {
        paths.push({ path: baseline, claimId: claim.id, destination: kept.get(claim.id) ?? "unchecked", evidenceId: null, applicable: true });
      }
    }
  }

  // 混同表（経路 × 正解 → 行き先）
  const cellCounts = new Map<string, number>();
  let undetermined = 0;
  let contextInsufficient = 0;
  for (const claim of input.claims) {
    if (excluded.has(claim.id)) {
      contextInsufficient += 1;
      continue;
    }
    const expected = expectedDestination(labels.get(claim.id));
    if (expected === null) {
      undetermined += 1;
      continue;
    }
  }
  for (const [path, byClaim] of destByPath) {
    for (const [claimId, destination] of byClaim) {
      const expected = expectedDestination(labels.get(claimId));
      if (expected === null) continue;
      const key = `${path}\0${expected}\0${destination}`;
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
  }
  const confusion: ConfusionCell[] = [...cellCounts.entries()].sort().map(([key, count]) => {
    const [path, expected, actual] = key.split("\0");
    return { path: path ?? "", expected: expected ?? "", actual: actual ?? "", count };
  });

  // 率（経路ごと・層ごと）
  const rates: Rate[] = [];
  for (const [path, byClaim] of destByPath) {
    for (const stratum of strataOf(scored)) {
      const claims = scored.filter((claim) => stratum.ids.has(claim.id));
      rates.push(
        ...ratesOf({
          path,
          stratum: stratum.key,
          claims,
          labels,
          destinationOf: (claimId) => byClaim.get(claimId) ?? null,
        }),
      );
    }
  }

  return {
    answer: answerScoreOf(notExcluded, forms, labels, input.repeatVotes ?? input.votes),
    paths,
    confusion,
    rates,
    undetermined,
    contextInsufficient,
  };
}
