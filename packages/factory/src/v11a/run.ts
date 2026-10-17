// v1.1α の走らせる部分（07-architecture-v1.1a.md §1 の流れ図と表・§1.2〜§1.4・§3。Issue #510）。
//
// 確定した仕様（`plan`。最初の比較では凍結した組の確定した仕様）を入力に取り、planner は流さない。段の順：
//
//   T1 名前の表（T1' を含む）→ J4 助言 → T1'' 表の意味の点検 →（拒否・落ちは T1 の 2 回目）→ 持ち越し →
//   T2 試験の仕様 → B1 書く → 版ごとに［B2 静的チェック → B3 名前の照合 → B3' 宣言の意味の点検 → B4 試験］→
//   B5 直す（⑥）→ B5' 裁定（⑥'）→ B6 棄却のあとの網羅 → … → ⑦ 終わりの判定 → ⑧ 納品物（＋v1.1α の記録）
//
// **合否は v1 と同じコード（`decideOutcome`）が決め、同じ門を通す。** v1 の走らせる部分（`../run.ts`）は
// 変えず、内部の補助（早期停止の合図・段の記録・材料の入れ物）はここに自前で持つ。呼ばないもの：v1 の ①・
// ①'・②・②'・③・⑤a（`runCorrespondence`・`runCorrespondenceRedo`）・申告の仕分け（`runUnwritableTriage`）・
// `bindTests`。LLM は共通の口（`CallGateway`）経由でだけ呼ぶ。
//
// 止まり方（早期停止。`verdict` none・終了コード 1。納品物は作らない）：
//   - `name-table`・`unmet` … T1' に 2 回落ちた
//   - `semantic-check`・`malformed` … T1'' の完全な結果が得られない（形の落ち 2 回・表の SHA の合わない結果・
//     判定の欠落）。点検していない状態で先へ進まない
//   - `carry-over`・`unmet` … 残る要件が 0（全件持ち越し。D15。T1'' のあとなら T2 を呼ばない。B3'・B6 で
//     0 になったときも ⑦ の前に止める）。**持ち越しを導く・除く関数（A1 の `deriveCarryOver`・
//     `pruneForCarryOver` と、ここの `composeCarryOver`）が例外で断ったとき**（残る行・残る試験の参照が除いた
//     行を指す）も同じ段・同じ種類で止め、問題に A1 の固定文を 1 件載せる（例外のまま外へ出さない）
//   - `decl-check`・`malformed` … B3' の完全な結果が得られない（形の落ち 2 回・宣言の SHA の合わない結果・
//     判定の欠落）
//   - そのほかは v1 と同じ（段の失敗の分類をそのまま写す）
//
// 段単位の走り（`runStageRangeV11a`。08-architecture-v1.2.md §8.3・Issue #544）は、同じ回す部分を開始の段と
// 終了の段で切って流す。開始 T2・B1 は凍結した境界の材料（照合済みの checkpoint）から入り、範囲の外の段は呼ばず、
// 終了の段のあとで止まる。境界（T1''／T2・T2／B1）を通るたびにその時点の材料を返し、**B の結果は入れない**。
// ⑦ まで流しても ⑧（納品物）は組まない。範囲を省いた `runGenerationV11a` は今までと同じに振る舞う。
//
// 旗（`flags`。08-architecture-v1.2.md §9・Issue #547）：省けば全部 off で、今の v1.1α とバイト列で同じに流れる。
// `flags.ledger` が on なら、性質の台帳の導出（`v12/ledger.ts`）を T1（T1' を含む）・T2（T2' を含む）・評価口（B4・
// B5 の道具・版の再検査）へ渡し、手 2b（Issue #548）から T1''・B1 へも渡す。`recordV12Flags` が真の走り（`--pipeline v1.2`）だけ、
// 要約に実効の旗の組を `v12_flags` で書く（早期停止の要約にも）。
//
// 持ち越し（§1.2）の出どころは 4 つ。T1 の unresolved と T1'' の拒否は A1 の `deriveCarryOver` で導く。
// B3' の文脈なし・点検が尽きるか停滞したあとに残った拒否と、B6 の網羅の落ちは、版の輪の途中で足していく
// ので `composeCarryOver` で重ねる（`deriveCarryOver` は 4 つの出どころを 1 回で受け、B3' の判定を
// 「T1・T1'' のあとに残った全要件」に求める形なので、B6 で除いたあとの版の B3' の結果と組めない）。除く行の
// 規則（その要件だけが所属させる行）とぶら下がりの検査は A1 と同じ関数（`ownersByRowId`・
// `danglingRowReferences`・`pruneForCarryOver`）で掛ける。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex, type Diagnostic } from "@musunest/spec-engine";
import { JobBudget } from "../budget.js";
import {
  assembleBundle,
  buildDiagnostics,
  buildRejectedCandidateFiles,
  materialCounts,
  toBundleNatureDiscrepancies,
  toDroppedNonstructuralTests,
  UNEXECUTED,
  type BundleArtifact,
  type BundleMaterialEntry,
  type BundleNatureDiscrepancy,
  type BundleRejectedCandidate,
  type BundleSummary,
  type BundleJudgeUsage,
  type InspectionCount,
  type MaterialKind,
  type RejectedCandidateStage,
} from "../bundle.js";
import { CallGateway, callCountsDelta, type CallCounts } from "../call.js";
import type { TestSuite } from "../fixed-test.js";
import { createBudgetedJudge, type BudgetedJudge } from "../judge-budget.js";
import { AGENT_LIMITS } from "../limits.js";
import { decideOutcome, type Outcome } from "../outcome.js";
import {
  requirementsFromPlan,
  toStageResults,
  type ArbitrationResult,
  type Declaration,
  type DesignResult,
  type Dispute,
  type JudgeMaterials,
  type OverturnedTest,
  type RejectedDispute,
  type RequirementList,
  type RoleNameMapping,
  type StaticCheckResult,
} from "../pipeline.js";
import {
  buildRunRecord,
  buildSummary,
  makeStageRecord,
  usageDelta,
  UsageMeter,
  type FailureAttribution,
  type FailureKind,
  type RunRecord,
  type StageId,
  type StageOperation,
  type StageRecord,
  type StageStatus,
  type StopReason,
  type UsageSnapshot,
} from "../record.js";
import { countUnresolvedTests, type GenerationInput, type GenerationResult } from "../run.js";
import { runArbitration } from "../stages/arbitrate.js";
import type { Problem, RejectedCandidate, StageFailure, StageOutcome } from "../stages/prompt.js";
import { failureSignature, isStagnant, runRepairStep, type DeclarationRejection, type VersionReport } from "../stages/repair.js";
import { runStaticCheck } from "../stages/static-check.js";
import type { DroppedNonstructuralTest } from "../stages/test-suite.js";
import type { EvaluationContext } from "../stages/tools.js";
import { correspondenceFromTable, extraElementsOf, markRows } from "./bind-by-id.js";
import {
  buildV11aArtifacts,
  type BoundaryMaterials,
  type CoverageCheckRecord,
  type DeclCheckVersionRecord,
  type FrozenTestSpec,
  type JudgeAdviceRound,
  type ResumeMaterials,
  type SemanticCheckRound,
  type StageBoundary,
  type StageRange,
  type StageRunOutcome,
} from "./bundle-v11a.js";
import {
  danglingRowReferences,
  deriveCarryOver,
  pruneForCarryOver,
  type CarryOver,
  type CarryOverReason,
  type DeclJudgment,
  type PrunedForCarryOver,
} from "./carry-over.js";
import { identityMappings, toV1 } from "./convert.js";
import { lostCoverage } from "./coverage.js";
import { createV11aEvaluator, type V11aEvaluator } from "./evaluate.js";
import { nameTableSha256, ownersByRowId, type NameTable } from "./names.js";
import { runDeclCheck, type DeclCheckOutput } from "./stages/decl-check.js";
import {
  JUDGE_ADVICE_THRESHOLDS,
  judgeAdviceMarks,
  judgeAdviceQuestionId,
  runJudgeAdvice,
  type JudgeAdviceRecord,
} from "./stages/judge-advice.js";
import {
  NAME_TABLE_ROUNDS,
  runNameTable,
  type NameTableOutcome,
  type NameTablePrevious,
  type SemanticRejection,
} from "./stages/name-table.js";
import { runSemanticCheck, semanticCheckTargets, type SemanticCheckOutput } from "./stages/semantic-check.js";
import { runTestSpec, type TestSpecValue } from "./stages/test-spec.js";
import { runWriteV11a } from "./stages/write.js";
import { ledgerViewOf, resolveV12Flags, type V12Flags } from "../v12/ledger.js";

/** v1.1α の入力（v1 の `GenerationInput` と同じ形で、確定した仕様を必須にしたもの） */
export interface GenerationInputV11a extends Omit<GenerationInput, "plan"> {
  /** 確定した仕様（全段の正本。planner は流さない） */
  readonly plan: ConfirmedPlan;
  /** v1.2 の旗（省いた名前は off。全部省けば今の v1.1α。Issue #547） */
  readonly flags?: Partial<V12Flags>;
  /** 真なら、要約に実効の旗の組を `v12_flags` で書く（`--pipeline v1.2` の走り。省けば書かない。Issue #547） */
  readonly recordV12Flags?: boolean;
}

/** 全件持ち越しの停止の問題（固定文。値を埋めない） */
export const ALL_CARRIED_PROBLEM: Problem = {
  field: "requirements",
  message: "残る要件が 0 である（全要件を持ち越した）",
};

/** 早期停止を、段の外へ伝えるための合図（この file の中でだけ使う） */
class RunStop extends Error {
  readonly attribution: FailureAttribution;
  constructor(attribution: FailureAttribution) {
    super(`段 ${attribution.stage} で止まりました（${attribution.kind}）`);
    this.name = "RunStop";
    this.attribution = attribution;
  }
}

/** 段の失敗を、記録の失敗の分類に写す（v1 と同じ写し） */
function stageFailureToKind(failure: StageFailure): FailureKind {
  switch (failure.kind) {
    case "limit":
      return "limit";
    case "deadline":
      return "deadline";
    case "budget":
      return "budget";
    case "callLimit":
      return "call-limit";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "http":
      return "http";
    case "balance":
      return "balance";
    case "malformed":
      return "malformed";
    case "refused":
      return "refused";
    case "toolArguments":
      return "tool-arguments";
    case "invalidRequest":
      return "invalid-request";
    case "incomplete":
      return "incomplete";
    case "unknown":
      return "unknown";
    case "unmet":
      return "unmet";
  }
}

/** 段の失敗を、記録の失敗の帰属に写す（v1 と同じ。値の中身は残さない） */
function stageFailureAttribution(stage: StageId, failure: StageFailure): FailureAttribution {
  const kind = stageFailureToKind(failure);
  if (failure.kind === "invalidRequest") return { stage, kind, code: failure.code };
  if ((failure.kind === "malformed" || failure.kind === "unmet") && failure.problems.length > 0) {
    return {
      stage,
      kind,
      problems: failure.problems.map((problem) => ({ field: problem.field, message: problem.message })),
    };
  }
  return { stage, kind };
}

/** 要約の `assurance` */
function assuranceOf(outcome: Outcome): string {
  if (outcome.result === "pass") return "full";
  if (outcome.result === "partial") return "partial";
  return "none";
}

/** ⑥' の裁定を、重複させずに集める */
function collectArbitration(
  result: ArbitrationResult,
  upheld: string[],
  overturned: OverturnedTest[],
  unresolved: string[],
): void {
  for (const testId of result.upheld) if (!upheld.includes(testId)) upheld.push(testId);
  for (const entry of result.overturned) {
    if (!overturned.some((candidate) => candidate.testId === entry.testId)) overturned.push(entry);
  }
  for (const testId of result.unresolved) if (!unresolved.includes(testId)) unresolved.push(testId);
}

/** 失敗の行き先ごとの件数 */
const countRoutes = (routes: readonly { readonly route: string }[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const route of routes) counts[route.route] = (counts[route.route] ?? 0) + 1;
  return counts;
};

/** 材料の JSON の SHA-256（版の値） */
const materialDigest = (value: unknown): Promise<string> => sha256Hex(JSON.stringify(value));

/** JSON にできない `undefined` を `null` にそろえる */
const jsonValue = (value: unknown): unknown => (value === undefined ? null : value);

/** T1・T2 が断った候補 1 つと、それを出した段の呼び出し（#501 と同じ作法） */
interface RejectedCandidateSlot {
  readonly stage: RejectedCandidateStage;
  readonly operation: StageOperation | null;
  readonly call: number;
  readonly candidate: RejectedCandidate;
}

/** 断った候補に、対象・raw・一覧の SHA-256 と、問題ごとの参照元の SHA-256 を付ける（v1 と同じ形） */
async function toBundleRejectedCandidate(slot: RejectedCandidateSlot): Promise<BundleRejectedCandidate> {
  const { candidate } = slot;
  const response = jsonValue(candidate.response);
  const responseSha256 = await materialDigest(response);
  const head = {
    stage: slot.stage,
    operation: slot.operation,
    call: slot.call,
    round: candidate.round,
    attempt: candidate.attempt,
    kind: candidate.kind,
  };
  if (candidate.kind === "shape") {
    return {
      ...head,
      response,
      response_sha256: responseSha256,
      problems: candidate.problems.map((problem) => ({ ...problem, reference_sha256: responseSha256 })),
    };
  }
  const target = jsonValue(candidate.target);
  const targetSha256 = await materialDigest(target);
  return {
    ...head,
    target,
    target_sha256: targetSha256,
    response,
    response_sha256: responseSha256,
    inspection_list: candidate.inspectionList,
    inspection_list_sha256: await materialDigest(candidate.inspectionList),
    problems: candidate.problems.map((problem) => ({
      ...problem,
      reference_sha256: problem.reference === "target" ? targetSha256 : responseSha256,
    })),
  };
}

/**
 * 停滞の署名（v1.1α）。v1 の `failureSignature` の値に、B3' の拒否の**要件 ID と種類**を足す（文言・引用・
 * 値は入れない）。v1 の署名は B3' の拒否を読まないので、拒否だけが変わる版を「同じ落ち」と誤る。v1 の
 * 関数と停滞の回数（`stagnationRepeats`）は変えない。
 */
export function v11aFailureSignature(
  report: VersionReport,
  rejections: readonly { readonly requirementId: string; readonly kind: string }[],
): string {
  const declParts = [...new Set(rejections.map((rejection) => `decl-check:${rejection.requirementId}:${rejection.kind}`))].sort();
  return [failureSignature(report), ...declParts].join("|");
}

/**
 * 持ち越しに、版の輪の途中で足す出どころ（B3' の文脈なし・残った拒否、B6 の網羅の落ち）を重ねる（§1.2）。
 * 除く行は A1 と同じ規則（所属させた要件が全部持ち越しの行。共有する行は残す）で導き、残る行の参照が
 * 除いた行を指せば例外で断る（A1 の固定文）。要件の並びは一覧の順、理由は基の理由のあとに足した順。
 */
export function composeCarryOver(
  list: RequirementList,
  table: NameTable,
  base: CarryOver,
  added: ReadonlyMap<string, readonly CarryOverReason[]>,
): CarryOver {
  const reasons = new Map<string, CarryOverReason[]>(base.entries.map((entry) => [entry.requirementId, [...entry.reasons]]));
  for (const [requirementId, more] of added) reasons.set(requirementId, [...(reasons.get(requirementId) ?? []), ...more]);
  const carried = new Set(reasons.keys());
  const owners = ownersByRowId(table);
  const excludedRowIds = table.rows
    .filter((row) => {
      const rowOwners = owners.get(row.id) ?? [];
      return rowOwners.length > 0 && rowOwners.every((owner) => carried.has(owner));
    })
    .map((row) => row.id);
  if (danglingRowReferences(table, new Set(excludedRowIds)).length > 0) {
    throw new Error("持ち越し：残る行の参照（所属 entity・見出しの元・参照先）が除いた行を指している");
  }
  const ids = list.requirements.map((requirement) => requirement.id);
  const remainingRequirementIds = ids.filter((id) => !carried.has(id));
  return {
    entries: ids.flatMap((id) => {
      const listed = reasons.get(id);
      return listed === undefined ? [] : [{ requirementId: id, reasons: listed }];
    }),
    excludedRowIds,
    remainingRequirementIds,
    allCarried: remainingRequirementIds.length === 0,
  };
}

/**
 * 判定の口が無い走りの J4 の記録（`runJudgeAdvice` と同じ対象の問いを、全部「未判定（答えの欠落）」で並べる）。
 * 判定の口が門で拒否された走りと同じ印（未判定）になるので、T1'' のデータ・呼び出しは同じになる（D5）。
 */
export function undeterminedJudgeAdvice(list: RequirementList, table: NameTable): JudgeAdviceRecord {
  const rowIds = new Set(table.rows.map((row) => row.id));
  const unresolved = new Set(
    table.verification.filter((entry) => entry.kind === "unresolved").map((entry) => entry.requirementId),
  );
  const ownershipById = new Map(table.ownership.map((entry) => [entry.requirementId, entry] as const));
  return {
    thresholds: JUDGE_ADVICE_THRESHOLDS,
    requests: list.requirements.flatMap((requirement) => {
      if (unresolved.has(requirement.id)) return [];
      const ids = (ownershipById.get(requirement.id)?.roles ?? []).map((role) => role.id).filter((id) => rowIds.has(id));
      if (ids.length === 0) return [];
      return [
        {
          requirementId: requirement.id,
          adapter: null,
          model: null,
          questions: ids.map((id) => ({
            questionId: judgeAdviceQuestionId(requirement.id, id),
            requirementId: requirement.id,
            id,
            value: null,
            mark: null,
            llmUnknownConfidence: false,
            undetermined: "missing" as const,
          })),
        },
      ];
    }),
  };
}

/** 判定の並びが、対象の要件にちょうど 1 つずつか（欠落・重複・対象の外が無いか） */
function coversExactly(judgments: readonly { readonly requirementId: string }[], targets: readonly string[]): boolean {
  const ids = judgments.map((judgment) => judgment.requirementId);
  return ids.length === targets.length && new Set(ids).size === ids.length && ids.every((id) => targets.includes(id));
}

/** 候補の宣言の 1 版 */
interface CandidateDeclaration {
  readonly source: string;
  readonly sha256: string;
  staticCheckPassed: boolean;
}

/** 評価の行（組み立てる間は可変） */
interface MutableEvaluationRow {
  declaration_sha256: string;
  static_check_passed: boolean;
  static_check_diagnostics: number;
  correspondence_misses: InspectionCount;
  test_mismatches: InspectionCount;
  test_unresolved: InspectionCount;
  routes: Record<string, number>;
}

/** 段が受理した材料の 1 つ */
interface MaterialSlot<T> {
  readonly value: T;
  readonly stageIndex: number;
  readonly sha256: string;
}

/** 版の B3' の状態 */
type DeclState =
  | { readonly ran: true; readonly output: DeclCheckOutput }
  | { readonly ran: false; readonly reason: "static-check" | "name-check" | "exhausted" };

/** 1 つの版の結果（④・B3・B3'・B4） */
interface VersionState {
  readonly report: VersionReport;
  readonly decl: DeclState;
  /** この版の B3' の拒否（要件 ID・種類・引用） */
  readonly rejections: readonly DeclarationRejection[];
}

/** 段単位の走りの入力（08-architecture-v1.2.md §8.3。Issue #544） */
export interface StageRunInputV11a extends GenerationInputV11a {
  readonly range: StageRange;
  /** 開始の段の直前の境界の checkpoint から読んだ材料（開始 T1 では省く。照合は呼ぶ側が済ませる） */
  readonly resume?: ResumeMaterials;
}

/** 回す部分の結果（通常の生成か、段の走りか） */
type CoreResult =
  | { readonly kind: "generation"; readonly result: GenerationResult }
  | { readonly kind: "stage"; readonly result: StageRunOutcome };

/**
 * v1.1α の 1 回の生成を流す（§1）。早期停止では `bundle` を返さない。完走では、合否・記録・要約・
 * 納品物（v1 の成果物＋v1.1α の 7 つの記録）を返す。**合否はコード（`decideOutcome`）が決める。**
 */
export async function runGenerationV11a(input: GenerationInputV11a): Promise<GenerationResult> {
  const core = await runV11a(input, undefined);
  if (core.kind !== "generation") throw new Error("v1.1α：通常の生成が段の走りの結果を返した（回す部分の前提が壊れた）");
  return core.result;
}

/**
 * v1.1α の経路を段の範囲だけ流す（08 §8.3。Issue #544）。段の中身・順・上限・門・合否の規則は通常の生成と
 * 同じ関数で、範囲の外の段は呼ばない。開始 T2・B1 は凍結した境界の材料から入り、終了の段のあとで止まる。
 * **納品物を組まない**（⑦ まで流しても ⑧ を呼ばない）。境界を通るたびに、その材料を返す（B の結果は入れない）。
 */
export async function runStageRangeV11a(input: StageRunInputV11a): Promise<StageRunOutcome> {
  if (input.range.start !== "name-table" && input.resume === undefined) {
    throw new Error("段の走り：開始 T2・B1 には再開の材料が要る");
  }
  if (input.range.start === "write" && input.resume?.testSpec === undefined) {
    throw new Error("段の走り：開始 B1 には試験の組が要る");
  }
  const core = await runV11a(input, { range: input.range, ...(input.resume === undefined ? {} : { resume: input.resume }) });
  if (core.kind !== "stage") throw new Error("v1.1α：段の走りが通常の生成の結果を返した（回す部分の前提が壊れた）");
  return core.result;
}

/** 回す部分（通常の生成は `stage` を省く。省けば今までの振る舞いと同じ） */
async function runV11a(
  input: GenerationInputV11a,
  stageControl: { readonly range: StageRange; readonly resume?: ResumeMaterials } | undefined,
): Promise<CoreResult> {
  const resume = stageControl?.resume;
  // 実効の旗と、旗で選んだ台帳の導出（off なら undefined。段へは渡さない＝今の定数と関数。Issue #547）
  const flags = resolveV12Flags(input.flags);
  const ledger = ledgerViewOf(flags);
  const withLedger = ledger === undefined ? {} : { ledger };
  const flagsRecord = input.recordV12Flags === true ? { v12_flags: flags } : {};
  const limits = input.limits ?? AGENT_LIMITS;
  const meter = new UsageMeter();
  const budget = new JobBudget(input.budgetUsd);
  const gateway = new CallGateway({
    client: meter.wrap(input.client),
    budget,
    rates: input.rates,
    now: input.now,
    deadline: input.deadline,
    limits,
    effort: input.effort,
    ...(input.callTimeoutMs === undefined ? {} : { callTimeoutMs: input.callTimeoutMs }),
  });
  // 判定の口（渡されたときだけ）を、この生成の予算に結び付けた包みで包む（v1 と同じ）。J4・J2 に渡す
  const judgeBudget: BudgetedJudge | undefined =
    input.judge === undefined ? undefined : createBudgetedJudge({ judge: input.judge, budget, rates: input.rates });
  const startedAt = input.now();
  const stages: StageRecord[] = [];
  const upheld: string[] = [];
  const overturned: OverturnedTest[] = [];
  const unresolved: string[] = [];
  const disputes: Dispute[] = [];
  const rejected: RejectedDispute[] = [];
  let returnToPlan = false;
  const returnedToPlan: string[] = [];

  const materialStore: {
    design: MaterialSlot<DesignResult> | null;
    testSuite: MaterialSlot<TestSuite> | null;
    mappings: MaterialSlot<readonly RoleNameMapping[]> | null;
    declarations: CandidateDeclaration[];
    evaluations: Map<string, MutableEvaluationRow>;
    staticChecks: Map<string, { readonly passed: boolean; readonly diagnostics: readonly Diagnostic[] }>;
  } = {
    design: null,
    testSuite: null,
    mappings: null,
    declarations: [],
    evaluations: new Map(),
    staticChecks: new Map(),
  };

  // T1・T2 が断った候補（#501 と同じ作法）。断った時点で積む。T1 の通し番号は呼んだ順（初回を 1）
  const rejectedCandidates: RejectedCandidateSlot[] = [];
  const rejectionSink =
    (stage: RejectedCandidateStage, call: number) =>
    (candidate: RejectedCandidate): void => {
      rejectedCandidates.push({ stage, operation: null, call, candidate });
    };
  const rejectedCandidateRows = (): Promise<readonly BundleRejectedCandidate[]> =>
    Promise.all(rejectedCandidates.map(toBundleRejectedCandidate));

  const acceptSlot = async <T>(value: T, stageIndex: number): Promise<MaterialSlot<T>> => ({
    value,
    stageIndex,
    sha256: await materialDigest(value),
  });

  const lastOkStageIndex = (stage: StageId): number => {
    for (let index = stages.length - 1; index >= 0; index -= 1) {
      const record = stages[index];
      if (record !== undefined && record.stage === stage && record.status === "ok") return index;
    }
    return -1;
  };

  /** 材料ごとの状態（v1 の材料の種類に、v1.1α の段を当てる。設計＝表の写し・対応＝恒等の対応は T1） */
  const materialEntries = (): readonly BundleMaterialEntry[] => {
    const ran = (stage: StageId): boolean => stages.some((record) => record.stage === stage);
    const ok = (stage: StageId): boolean => stages.some((record) => record.stage === stage && record.status === "ok");
    const slot = (material: MaterialKind, value: MaterialSlot<unknown> | null, stage: StageId): BundleMaterialEntry =>
      value === null
        ? { material, state: ran(stage) ? "unaccepted" : "unexecuted" }
        : { material, state: "accepted", version: { stage_index: value.stageIndex, sha256: value.sha256 } };
    const passed = materialStore.declarations.filter((entry) => entry.staticCheckPassed);
    const declaration = passed.at(-1) ?? materialStore.declarations.at(-1);
    return [
      slot("design", materialStore.design, "name-table"),
      slot("test_suite", materialStore.testSuite, "test-spec"),
      slot("mappings", materialStore.mappings, "name-table"),
      {
        material: "declaration",
        state:
          materialStore.declarations.length > 0
            ? "candidate"
            : ran("write") || ran("repair")
              ? "unaccepted"
              : "unexecuted",
        ...(declaration === undefined
          ? {}
          : { version: { sha256: declaration.sha256 }, static_check_passed: declaration.staticCheckPassed }),
      },
      {
        material: "correspondence",
        state: ok("name-check") ? "accepted" : ran("name-check") ? "unaccepted" : "unexecuted",
      },
      { material: "test_run", state: ok("run-tests") ? "accepted" : ran("run-tests") ? "unaccepted" : "unexecuted" },
      {
        material: "evaluation",
        state: ok("static-check") ? "accepted" : ran("static-check") ? "unaccepted" : "unexecuted",
      },
    ];
  };

  const recordDeclaration = (declaration: Declaration, sha256: string, staticCheck: StaticCheckResult): void => {
    materialStore.staticChecks.set(sha256, { passed: staticCheck.passed, diagnostics: staticCheck.diagnostics });
    const existing = materialStore.declarations.find((entry) => entry.sha256 === sha256);
    if (existing === undefined) {
      materialStore.declarations.push({ source: declaration.source, sha256, staticCheckPassed: staticCheck.passed });
    } else {
      existing.staticCheckPassed = staticCheck.passed;
    }
  };

  const evaluationRow = (sha256: string, staticCheck: StaticCheckResult): MutableEvaluationRow => {
    let row = materialStore.evaluations.get(sha256);
    if (row === undefined) {
      row = {
        declaration_sha256: sha256,
        static_check_passed: staticCheck.passed,
        static_check_diagnostics: staticCheck.diagnostics.length,
        correspondence_misses: UNEXECUTED,
        test_mismatches: UNEXECUTED,
        test_unresolved: UNEXECUTED,
        routes: {},
      };
      materialStore.evaluations.set(sha256, row);
    } else {
      row.static_check_passed = staticCheck.passed;
      row.static_check_diagnostics = staticCheck.diagnostics.length;
    }
    return row;
  };

  /** 早期停止の診断（積んだ材料だけから組む。#417 と同じ） */
  const diagnosticsFor = (
    attribution: FailureAttribution,
    record: RunRecord,
    rejectedRows: readonly BundleRejectedCandidate[],
  ): readonly BundleArtifact[] =>
    buildDiagnostics({
      stopped: { stage: attribution.stage, kind: attribution.kind },
      materials: materialEntries(),
      evaluations: [...materialStore.evaluations.values()],
      counts: materialCounts(record.stages),
      ...(materialStore.design === null ? {} : { design: materialStore.design.value }),
      ...(materialStore.testSuite === null ? {} : { testSuite: materialStore.testSuite.value }),
      ...(materialStore.mappings === null ? {} : { mappings: materialStore.mappings.value }),
      ...(materialStore.declarations.length === 0
        ? {}
        : { declarations: materialStore.declarations.map((entry) => ({ sha256: entry.sha256, declaration: entry.source })) }),
      ...(materialStore.staticChecks.size === 0
        ? {}
        : {
            staticChecks: [...materialStore.staticChecks.entries()].map(([sha256, check]) => ({
              declaration_sha256: sha256,
              passed: check.passed,
              diagnostics: check.diagnostics,
            })),
          }),
      ...(rejectedRows.length === 0 ? {} : { rejected: rejectedRows }),
    });

  const meterState = (): { readonly usage: UsageSnapshot; readonly counts: CallCounts } => ({
    usage: meter.snapshot,
    counts: gateway.counts,
  });

  const pushRecord = (
    stage: StageId,
    status: StageStatus,
    before: { readonly usage: UsageSnapshot; readonly counts: CallCounts },
    start: number,
    failureKind: FailureKind | null,
  ): void => {
    stages.push(
      makeStageRecord(
        stage,
        status,
        input.now() - start,
        usageDelta(before.usage, meter.snapshot),
        callCountsDelta(before.counts, gateway.counts),
        failureKind,
        null,
      ),
    );
  };

  /** 値を返す段（コードの段）を回し、所要時間とトークンを記録する */
  const runStage = async <T>(stage: StageId, fn: () => Promise<T>): Promise<T> => {
    const before = meterState();
    const start = input.now();
    try {
      const value = await fn();
      pushRecord(stage, "ok", before, start, null);
      return value;
    } catch (error) {
      pushRecord(stage, "failed", before, start, error instanceof RunStop ? error.attribution.kind : null);
      throw error;
    }
  };

  /** LLM の段を回す。段の失敗は、記録してから早期停止にする */
  const runStageOk = async <T>(stage: StageId, fn: () => Promise<StageOutcome<T>>): Promise<T> => {
    const before = meterState();
    const start = input.now();
    let value: T;
    try {
      const outcome = await fn();
      if (!outcome.ok) throw new RunStop(stageFailureAttribution(stage, outcome.failure));
      value = outcome.value;
    } catch (error) {
      pushRecord(stage, "failed", before, start, error instanceof RunStop ? error.attribution.kind : null);
      throw error;
    }
    pushRecord(stage, "ok", before, start, null);
    return value;
  };

  /** 持ち越しの段で止める（全件持ち越し・持ち越しの関数が断った）。記録を足して合図を投げる */
  const stopAtCarryOver = (problem: Problem): never => {
    pushRecord("carry-over", "failed", meterState(), input.now(), "unmet");
    throw new RunStop({ stage: "carry-over", kind: "unmet", problems: [{ field: problem.field, message: problem.message }] });
  };
  /** 持ち越しの関数（A1・`composeCarryOver`）を呼び、例外を `carry-over`・`unmet` の停止に写す */
  const carryOverStep = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RunStop) throw error;
      return stopAtCarryOver({
        field: "carry-over",
        message: error instanceof Error ? error.message : "持ち越し：持ち越しを導けない",
      });
    }
  };

  const buildRecord = (failure: FailureAttribution | null): RunRecord =>
    buildRunRecord({
      builder: input.builder,
      model: input.model,
      effort: input.effort,
      prompt_version: input.promptVersion,
      contract_version: input.contractVersion,
      spec_engine_version: input.specEngineVersion,
      factory_version: input.factoryVersion,
      stages: stages.slice(),
      arbitration: { upheld: upheld.length, overturned: overturned.length, undecidable: unresolved.length },
      budget_remaining_usd: budget.remainingUsd,
      budget_reserved_usd: budget.reservedUsd,
      missing_usage_calls: meter.snapshot.missing_usage_calls,
      failure,
    });

  const judgeUsageOf = (): BundleJudgeUsage => ({
    calls_by_adapter: judgeBudget?.callsByAdapter ?? { jev: 0, llm: 0, fake: 0 },
    cost_usd: judgeBudget?.spentUsd ?? 0,
  });

  let natureDiscrepancies: readonly BundleNatureDiscrepancy[] = [];
  const droppedTests: DroppedNonstructuralTest[] = [];

  const stopResult = async (attribution: FailureAttribution): Promise<GenerationResult> => {
    const outcome: Outcome = { result: "failed", verdict: "none" };
    const record = buildRecord(attribution);
    const droppedSummary = toDroppedNonstructuralTests(droppedTests);
    const summary: BundleSummary = {
      ...buildSummary(record, {
        run_id: input.runId,
        verdict: "none",
        assurance: "none",
        duration_secs: (input.now() - startedAt) / 1000,
        provider_cost_usd: budget.spentUsd,
        stop_class: attribution.kind,
        stopReason: attribution.kind,
        exit_code: 1,
      }),
      judge: judgeUsageOf(),
      nature_discrepancies: natureDiscrepancies,
      ...(droppedSummary === undefined ? {} : { dropped_nonstructural_tests: droppedSummary }),
      ...flagsRecord,
    };
    return {
      outcome,
      record,
      summary,
      bundle: null,
      stopped: attribution,
      diagnostics: diagnosticsFor(attribution, record, await rejectedCandidateRows()),
    };
  };

  // 段の走り：通った境界の材料（通った順）と、段の走りの結果
  const boundaries: BoundaryMaterials[] = [];
  const stageOutcome = (
    stopped: FailureAttribution | null,
    extra: { readonly judgeVerdict?: StageRunOutcome["judgeVerdict"]; readonly finalCarryOver?: StageRunOutcome["finalCarryOver"] } = {},
  ): CoreResult => ({
    kind: "stage",
    result: {
      stages: buildRecord(stopped).stages,
      stopped,
      boundaries: boundaries.slice(),
      judgeVerdict: extra.judgeVerdict ?? null,
      finalCarryOver: extra.finalCarryOver ?? null,
      returnToPlan,
      costUsd: budget.spentUsd,
      durationSecs: (input.now() - startedAt) / 1000,
    },
  });
  /** 範囲の中で境界を通ったか（開始の段の直前の境界は入力であって、この走りでは通らない） */
  const crosses = (boundary: StageBoundary): boolean =>
    stageControl !== undefined &&
    (boundary === "t1-t2" ? stageControl.range.start === "name-table" : stageControl.range.start !== "write");

  try {
    const list = requirementsFromPlan(input.plan);

    // ── T1 → J4 → T1''（中身の 2 回目は回す側＝ここ。§1 の表）──────────────────
    const semanticRounds: SemanticCheckRound[] = [];
    const judgeAdviceRounds: JudgeAdviceRound[] = [];
    let previous: NameTablePrevious | undefined;
    let adopted:
      | {
          readonly table: NameTable;
          readonly tableSha256: string;
          readonly semantic: Pick<SemanticCheckOutput, "tableSha256" | "targets" | "judgments">;
          readonly advice: JudgeAdviceRecord;
        }
      | undefined =
      resume === undefined
        ? undefined
        : { table: resume.table, tableSha256: resume.tableSha256, semantic: resume.semanticCheck, advice: resume.judgeAdvice };
    // 開始 T2・B1 は T1〜T1'' を呼ばない（凍結した表と点検結果から入る）
    const nameTableRounds = resume === undefined ? NAME_TABLE_ROUNDS : 0;
    for (let round = 1; round <= nameTableRounds; round += 1) {
      const call = round;
      const retry = previous;
      const before = meterState();
      const start = input.now();
      let outcome: NameTableOutcome;
      try {
        // 中身のやり直し（T1 の 2 回目）を共通の口へ告げる（この段の記録の再試行に数える）
        if (retry !== undefined) gateway.noteRetry("content");
        outcome = await runNameTable({
          plan: input.plan,
          list,
          documents: input.documents,
          gateway,
          ...(retry === undefined ? {} : { previous: retry }),
          onRejected: rejectionSink("name-table", call),
          ...withLedger,
        });
      } catch (error) {
        pushRecord("name-table", "failed", before, start, null);
        throw error;
      }
      if (!outcome.ok) {
        const attribution = stageFailureAttribution("name-table", outcome.failure);
        pushRecord("name-table", "failed", before, start, attribution.kind);
        // T1' の落ち（中身）は 2 回目へ（前回の候補と作り直しの指示をデータで）。それ以外の失敗は止める
        if (outcome.failure.kind === "unmet" && outcome.response !== undefined && round < NAME_TABLE_ROUNDS) {
          previous = { response: outcome.response, problems: outcome.failure.problems, rejections: [], advice: [] };
          continue;
        }
        throw new RunStop(attribution);
      }
      pushRecord("name-table", "ok", before, start, null);
      const output = outcome.value;

      // J4（判定の口があるときだけ。予算の包みを渡す。助言であって門ではない。D5）
      const advice =
        judgeBudget === undefined
          ? undeterminedJudgeAdvice(list, output.table)
          : await runJudgeAdvice({ list, table: output.table, judge: judgeBudget });
      judgeAdviceRounds.push({ round, tableSha256: output.tableSha256, record: advice });
      const marks = judgeAdviceMarks(advice);

      // T1''（完全な結果だけを受ける。表の SHA の合わない結果・判定の欠落は形の落ちとして止める）
      const targets = semanticCheckTargets(list, output.table);
      const semantic = await runStageOk("semantic-check", async (): Promise<StageOutcome<SemanticCheckOutput>> => {
        const checked = await runSemanticCheck({
          plan: input.plan,
          list,
          table: output.table,
          advice: marks,
          documents: input.documents,
          gateway,
          ...withLedger,
        });
        if (!checked.ok) return checked;
        const problems: Problem[] = [];
        if (checked.value.tableSha256 !== output.tableSha256) {
          problems.push({ field: "tableSha256", message: "表の意味の点検の結果が、採用した表の SHA-256 と合わない" });
        }
        if (!coversExactly(checked.value.judgments, targets)) {
          problems.push({ field: "judgments", message: "表の意味の点検の判定が、対象の要件にちょうど 1 つずつでない" });
        }
        return problems.length > 0 ? { ok: false, failure: { kind: "malformed", attempts: 1, problems } } : checked;
      });
      semanticRounds.push({
        round,
        tableSha256: semantic.tableSha256,
        targets: semantic.targets,
        judgments: semantic.judgments,
        advice: marks,
      });
      const rejections = semantic.judgments.filter(
        (judgment): judgment is SemanticRejection => judgment.verdict === "reject",
      );
      // 拒否が残れば、2 回目が未使用なら 2 回目（拒否と印をデータで）。使用済みなら持ち越し
      if (rejections.length > 0 && round < NAME_TABLE_ROUNDS) {
        previous = { response: output.response, problems: [], rejections, advice: marks };
        continue;
      }
      adopted = { table: output.table, tableSha256: output.tableSha256, semantic, advice };
      break;
    }
    if (adopted === undefined) throw new Error("名前の表：採用した表が無い（回す部分の前提が壊れた）");
    const table = adopted.table;
    const tableSha256 = adopted.tableSha256;
    const conversion = toV1(table);
    materialStore.design = await acceptSlot(conversion.design, lastOkStageIndex("name-table"));
    materialStore.mappings = await acceptSlot(conversion.mappings, lastOkStageIndex("name-table"));

    // ── 持ち越し（T1 の unresolved・T1'' の拒否。A1）。残る要件が 0 なら T2 を呼ばない（D15）────
    const baseCarry = await carryOverStep(() =>
      deriveCarryOver({
        list,
        table,
        semanticCheck: { tableSha256: adopted.semantic.tableSha256, judgments: adopted.semantic.judgments },
      }),
    );
    const addedCarry = new Map<string, CarryOverReason[]>();
    let carry: CarryOver = baseCarry;
    if (carry.allCarried) stopAtCarryOver(ALL_CARRIED_PROBLEM);
    await carryOverStep(() => pruneForCarryOver(list, table, carry));

    // 段の走り：T1''／T2 の境界（持ち越しを導き、T2 を呼ぶ直前）。終了 T1'' ならここで止める
    const adoptedNow = adopted;
    const boundaryOf = (boundary: StageBoundary, frozen?: FrozenTestSpec): BoundaryMaterials => ({
      boundary,
      table,
      tableSha256,
      semanticCheck: {
        tableSha256: adoptedNow.semantic.tableSha256,
        targets: adoptedNow.semantic.targets,
        judgments: adoptedNow.semantic.judgments,
      },
      judgeAdvice: adoptedNow.advice,
      carryOver: baseCarry,
      ...(frozen === undefined ? {} : { testSpec: frozen }),
    });
    if (crosses("t1-t2")) boundaries.push(boundaryOf("t1-t2"));
    if (stageControl?.range.end === "semantic-check") return stageOutcome(null);

    // ── T2 試験の仕様（除いた一覧と所属で。宣言も名前も見せない）。開始 B1 は凍結した組から入る ────────
    const runTestSpecStage = async (): Promise<FrozenTestSpec> => {
      const value: TestSpecValue = await runStageOk("test-spec", () =>
        runTestSpec({
          plan: input.plan,
          list,
          table,
          carryOver: carry,
          documents: input.documents,
          gateway,
          ...(judgeBudget === undefined ? {} : { judge: judgeBudget }),
          onDropped: (dropped) => {
            for (const entry of dropped) droppedTests.push(entry);
          },
          onRejected: rejectionSink("test-spec", 1),
          ...withLedger,
        }),
      );
      natureDiscrepancies = toBundleNatureDiscrepancies(value.discrepancies);
      materialStore.testSuite = await acceptSlot(value.suite, lastOkStageIndex("test-spec"));
      return value;
    };
    const testSpec: FrozenTestSpec =
      stageControl?.range.start === "write" && resume?.testSpec !== undefined ? resume.testSpec : await runTestSpecStage();
    // 段の走り：T2／B1 の境界（T2' を終え、B1 を始める直前）。終了 T2' ならここで止める
    if (crosses("t2-b1")) boundaries.push(boundaryOf("t2-b1", testSpec));
    if (stageControl?.range.end === "test-spec") return stageOutcome(null);

    // ── B1 書く（表の全行・固定した試験）──────────────────────────────────
    const written = await runStageOk("write", () =>
      runWriteV11a({
        list,
        table,
        suite: testSpec.suite,
        observes: testSpec.observes,
        documents: input.documents,
        gateway,
        ...withLedger,
      }),
    );

    // ── 版の輪の状態 ─────────────────────────────────────────────────
    const withoutOverturned = (): TestSuite => ({
      ...(testSpec.suite.classifications === undefined ? {} : { classifications: testSpec.suite.classifications }),
      tests: testSpec.suite.tests.filter((test) => !overturned.some((entry) => entry.testId === test.id)),
    });
    let pruned: PrunedForCarryOver = await carryOverStep(() => pruneForCarryOver(list, table, carry, withoutOverturned()));
    // 評価口は T2 で固定した観測する性質の写像を閉包で持つ（作り直すときも同じ写像。Issue #526）
    let evaluator: V11aEvaluator = createV11aEvaluator({
      table,
      excludedRowIds: carry.excludedRowIds,
      observes: testSpec.observes,
      ...withLedger,
    });
    /** いまの評価の文脈（棄却で外した後の組・持ち越しを除いた一覧と所属） */
    const contextNow = (): EvaluationContext => ({
      list: pruned.list,
      suite: pruned.suite ?? { tests: [] },
      correspondences: correspondenceFromTable(pruned.table),
      ownership: pruned.conversion.ownership,
    });
    /** 持ち越しか棄却が変わったら、除く範囲・文脈・評価口を作り直す。全件持ち越しなら止める（D15） */
    const refreshCarry = async (): Promise<void> => {
      carry = await carryOverStep(() => composeCarryOver(list, table, baseCarry, addedCarry));
      if (carry.allCarried) stopAtCarryOver(ALL_CARRIED_PROBLEM);
      pruned = await carryOverStep(() => pruneForCarryOver(list, table, carry, withoutOverturned()));
      evaluator = createV11aEvaluator({ table, excludedRowIds: carry.excludedRowIds, observes: testSpec.observes, ...withLedger });
    };
    const addCarry = (requirementId: string, reason: CarryOverReason): void => {
      const listed = addedCarry.get(requirementId) ?? [];
      if (!listed.some((entry) => entry.origin === reason.origin && entry.reason === reason.reason)) listed.push(reason);
      addedCarry.set(requirementId, listed);
    };
    const isCarried = (requirementId: string): boolean =>
      carry.entries.some((entry) => entry.requirementId === requirementId);

    let declChecksUsed = 0;
    let declExhausted = 0;
    const declVersions: DeclCheckVersionRecord[] = [];
    const coverageChecks: CoverageCheckRecord[] = [];
    const checkedDeclarationSha256s: string[] = [];

    /** ある版に ④ → B3 → B3'（点検を 1 消費）→ B4 を流す */
    const evaluateVersion = async (declaration: Declaration): Promise<VersionState> => {
      const staticCheck = await runStage("static-check", () => runStaticCheck(declaration));
      const declarationSha256 = await sha256Hex(declaration.source);
      if (!checkedDeclarationSha256s.includes(declarationSha256)) checkedDeclarationSha256s.push(declarationSha256);
      recordDeclaration(declaration, declarationSha256, staticCheck);
      const row = evaluationRow(declarationSha256, staticCheck);
      if (!staticCheck.passed || staticCheck.app === null) {
        return {
          report: {
            declaration,
            declarationSha256,
            staticCheck,
            correspondence: null,
            testRun: null,
            routes: [],
            defectMisses: [],
            redoMisses: [],
          },
          decl: { ran: false, reason: "static-check" },
          rejections: [],
        };
      }
      const app = staticCheck.app;
      const named = await runStage("name-check", async () => evaluator.nameCheck(app, contextNow()));
      const correspondence = { entries: named.entries, misses: named.misses };
      row.correspondence_misses = named.misses.length;

      let decl: DeclState = { ran: false, reason: "name-check" };
      let rejections: readonly DeclarationRejection[] = [];
      if (named.misses.length === 0) {
        if (declChecksUsed >= limits.declChecks) {
          // 点検が尽きた版（通常は B5 の前に止めるので来ない）。受理を作らず、点検していない版として扱う
          decl = { ran: false, reason: "exhausted" };
          declExhausted += 1;
        } else {
          declChecksUsed += 1;
          const context = contextNow();
          const targets = context.list.requirements.map((requirement) => requirement.id);
          // 追加の要素の一覧は A1 の関数 1 つが正本（B3' の段も同じ関数・同じ入力で作る。D4）
          const extraElements = extraElementsOf(app, table);
          const output = await runStageOk("decl-check", async (): Promise<StageOutcome<DeclCheckOutput>> => {
            const checked = await runDeclCheck({
              plan: input.plan,
              list: context.list,
              table,
              declaration,
              app,
              documents: input.documents,
              gateway,
            });
            if (!checked.ok) return checked;
            const problems: Problem[] = [];
            if (checked.value.declarationSha256 !== declarationSha256) {
              problems.push({ field: "declarationSha256", message: "宣言の意味の点検の結果が、点検した宣言の SHA-256 と合わない" });
            }
            const verdictsKnown = checked.value.judgments.every((judgment: DeclJudgment) =>
              ["accept", "reject", "unmarked"].includes(judgment.verdict),
            );
            if (!coversExactly(checked.value.judgments, targets) || !verdictsKnown) {
              problems.push({ field: "judgments", message: "宣言の意味の点検の判定が、対象の要件にちょうど 1 つずつでない" });
            }
            return problems.length > 0 ? { ok: false, failure: { kind: "malformed", attempts: 1, problems } } : checked;
          });
          decl = { ran: true, output };
          declVersions.push({
            declarationSha256,
            targets: output.targets,
            judgments: output.judgments,
            marks: [...markRows(app, table).values()],
            extraElements,
            remainingChecks: limits.declChecks - declChecksUsed,
          });
          rejections = output.judgments.flatMap((judgment) =>
            judgment.verdict === "reject"
              ? [{ requirementId: judgment.requirementId, kind: judgment.kind, quote: judgment.quote }]
              : [],
          );
          // 文脈（該当箇所・参照先）を引き当てられない要件は受理せず持ち越す
          if (output.unmarked.length > 0) {
            for (const requirementId of output.unmarked) addCarry(requirementId, { origin: "decl-check", reason: "unmarked" });
            await refreshCarry();
          }
        }
      }

      const context = contextNow();
      const testRun = await runStage("run-tests", async () => evaluator.runTests(app, context, correspondence));
      row.test_mismatches = testRun.mismatches.length;
      row.test_unresolved = testRun.unresolved.length;
      row.routes = countRoutes(testRun.routes);
      return {
        report: {
          declaration,
          declarationSha256,
          staticCheck,
          correspondence,
          testRun,
          routes: testRun.routes,
          defectMisses: [],
          redoMisses: [],
        },
        decl,
        rejections,
      };
    };

    const isSettled = (state: VersionState): boolean =>
      state.report.staticCheck.passed &&
      state.report.correspondence !== null &&
      state.report.correspondence.misses.length === 0 &&
      state.decl.ran &&
      state.rejections.length === 0 &&
      state.report.testRun !== null &&
      state.report.testRun.mismatches.length === 0 &&
      state.report.testRun.unresolved.length === 0 &&
      unresolved.length === 0;

    let current = await evaluateVersion({ source: written.declaration });
    let lastPassed: VersionState | null = current.report.staticCheck.passed ? current : null;
    let rounds = 0;
    let limitReached = false;
    let stopReason: StopReason = "completed";
    let stagnant = false;
    const history: string[] = [v11aFailureSignature(current.report, current.rejections)];

    // B5（⑥）→ 流し直し（④・B3・B3'・B4）→ B5'（⑥'）→ B6 を、上限まで回す
    while (!isSettled(current)) {
      // 停滞：同じ落ち（v1 の署名＋B3' の拒否の要件 ID と種類）が続いたら、それ以上直さない
      if (isStagnant(history, limits.stagnationRepeats)) {
        stagnant = true;
        stopReason = "stagnation";
        break;
      }
      // B5 を回す前に残りの点検を確かめる。0 なら次の版を作らず止める（D16。今の版の拒否・不一致は未解決）
      if (declChecksUsed >= limits.declChecks) {
        declExhausted += 1;
        limitReached = true;
        stopReason = "limit";
        break;
      }
      if (rounds >= limits.repairRoundTrips) {
        limitReached = true;
        stopReason = "limit";
        break;
      }
      rounds += 1;
      const context = contextNow();
      const step = await runStageOk("repair", () =>
        runRepairStep({
          source: input.source,
          list: context.list,
          suite: context.suite,
          current: current.report,
          correspondences: current.report.correspondence?.entries ?? [],
          ...(context.ownership === undefined ? {} : { ownership: context.ownership }),
          documents: input.documents,
          gateway,
          // 道具と版の再検査は、評価口から v1.1α の結び付けと B3 を使う（その時点の文脈で。D11）
          evaluate: evaluator.evaluate,
          ...(current.rejections.length === 0 ? {} : { declRejections: current.rejections }),
        }),
      );
      for (const dispute of step.disputes) disputes.push(dispute);
      for (const item of step.rejected) rejected.push(item);
      if (step.disputes.length > 0) {
        const overturnedBefore = overturned.length;
        const arbitration = await runStageOk("arbitration", () =>
          runArbitration({
            source: input.source,
            list: context.list,
            suite: context.suite,
            declaration: step.declaration,
            disputes: step.disputes,
            documents: input.documents,
            gateway,
            plan: input.plan,
          }),
        );
        collectArbitration(arbitration, upheld, overturned, unresolved);
        // 確定した仕様そのものと食い違う主張があれば、裁定せず Plan に戻して止める（v1 と同じ）
        if (arbitration.returnToPlan !== undefined && arbitration.returnToPlan.length > 0) {
          returnToPlan = true;
          for (const testId of arbitration.returnToPlan) if (!returnedToPlan.includes(testId)) returnedToPlan.push(testId);
          stopReason = "unresolved";
          break;
        }
        // B6：棄却のたびに、保存した全単位を残った組に掛け直し、単位を失った要件を持ち越す
        if (overturned.length > overturnedBefore) {
          const losses = await runStage("coverage", async () =>
            lostCoverage(testSpec.coverage, {
              suite: withoutOverturned(),
              observes: testSpec.observes,
              natures: testSpec.natures,
            }),
          );
          coverageChecks.push({ overturnedTestIds: overturned.map((entry) => entry.testId), losses });
          for (const loss of losses) addCarry(loss.requirementId, { origin: "coverage", reason: "lost-coverage-units" });
          await refreshCarry();
        }
      }
      const next = await evaluateVersion(step.declaration);
      current = next;
      if (current.report.staticCheck.passed) lastPassed = current;
      history.push(v11aFailureSignature(current.report, current.rejections));
    }

    const final = lastPassed ?? current;

    // 停滞で止めたら、残った不一致を未解決に数える（v1 と同じ）
    if (stagnant) {
      for (const route of current.report.routes) if (!unresolved.includes(route.testId)) unresolved.push(route.testId);
    }
    const stalledCorrespondenceMisses = stagnant ? (final.report.correspondence?.misses.length ?? 0) : 0;

    // 決着しないまま止めたとき：最終版の B3' の拒否は持ち越し（未解決）。B3 を通ったのに点検していない最終版は、
    // 残る要件を全部持ち越す（点検が尽きれば止めて持ち越し。§1 の流れ図）
    if (!isSettled(final)) {
      const final3Passed = final.report.correspondence !== null && final.report.correspondence.misses.length === 0;
      if (final.decl.ran) {
        for (const rejection of final.rejections) {
          if (!isCarried(rejection.requirementId)) addCarry(rejection.requirementId, { origin: "decl-check", reason: rejection.kind });
        }
      } else if (final3Passed && final.decl.reason === "exhausted") {
        for (const requirementId of carry.remainingRequirementIds) {
          addCarry(requirementId, { origin: "decl-check", reason: "unchecked" });
        }
      }
      if (addedCarry.size > 0) await refreshCarry();
    }

    // ⑦ 終わりの判定（v1 と同じコード）。持ち越しは `carriedOver.testSuite` に載せて未解決に数える
    const carriedIds = carry.entries.map((entry) => entry.requirementId);
    const materials: JudgeMaterials = {
      staticCheckPassed: final.report.staticCheck.passed,
      correspondenceMisses: final.report.correspondence === null ? 1 : final.report.correspondence.misses.length,
      testMismatches: final.report.testRun === null ? 1 : final.report.testRun.mismatches.length,
      testUnresolved: countUnresolvedTests(unresolved, final.report.testRun) + stalledCorrespondenceMisses,
      unwritableRequirements: 0,
      acceptedUnwritable: 0,
      limitReached,
      carriedOver: { reverseCheck: [], testSuite: carriedIds },
    };
    const outcome = await runStage("judge", async () => decideOutcome(toStageResults(materials)));
    // 段の走り：⑦ の判定を別の名前で返し、納品物（⑧）を組まない
    if (stageControl !== undefined) return stageOutcome(null, { judgeVerdict: outcome.verdict, finalCarryOver: carry.entries });
    const failure: FailureAttribution | null =
      outcome.result === "failed"
        ? final.report.staticCheck.passed
          ? { stage: "repair", kind: "unmet" }
          : { stage: "static-check", kind: "incomplete" }
        : null;

    // ⑧ v1.1α の記録を組む（段 `bundle`）。記録と要約を組んでから、納品物に埋め込む
    const declStageRecords = stages.filter((record) => record.stage === "decl-check");
    const extraArtifacts = await runStage("bundle", async () =>
      buildV11aArtifacts({
        nameTable: { table, sha256: tableSha256 },
        semanticCheck: semanticRounds,
        judgeAdvice: judgeAdviceRounds,
        testSpec: {
          suite: testSpec.suite,
          sha256: testSpec.sha256,
          observes: testSpec.observes,
          coverage: testSpec.coverage,
          overturnedTestIds: overturned.map((entry) => entry.testId),
          coverageChecks,
        },
        declCheck: { limit: limits.declChecks, versions: declVersions },
        carryOver: {
          entries: carry.entries,
          excludedRowIds: carry.excludedRowIds,
          remainingRequirementIds: carry.remainingRequirementIds,
        },
        verification: {
          tableSha256: await nameTableSha256(table),
          testSuiteSha256: testSpec.sha256,
          declarationSha256: final.report.declarationSha256,
          checkedDeclarationSha256s,
          declCheck: {
            exhausted: declExhausted,
            malformed: declStageRecords.reduce((sum, record) => sum + record.retries.shape, 0),
            rejected: declVersions.reduce(
              (sum, version) => sum + version.judgments.filter((judgment) => judgment.verdict === "reject").length,
              0,
            ),
          },
        },
      }),
    );

    const record = buildRecord(failure);
    const droppedSummary = toDroppedNonstructuralTests(droppedTests);
    const summary: BundleSummary = {
      ...buildSummary(record, {
        run_id: input.runId,
        verdict: outcome.verdict,
        assurance: assuranceOf(outcome),
        duration_secs: (input.now() - startedAt) / 1000,
        provider_cost_usd: budget.spentUsd,
        stop_class: failure === null ? "completed" : failure.kind,
        stopReason,
        exit_code: outcome.result === "failed" ? 1 : 0,
      }),
      judge: judgeUsageOf(),
      nature_discrepancies: natureDiscrepancies,
      ...(droppedSummary === undefined ? {} : { dropped_nonstructural_tests: droppedSummary }),
      ...flagsRecord,
    };
    const bundle = await assembleBundle({
      runId: input.runId,
      storageUnit: input.storageUnit,
      artifactLevel: input.artifactLevel ?? "L2",
      declaration: final.report.declaration,
      declarationSha256: final.report.declarationSha256,
      outcome,
      summary,
      requirements: list,
      unwritable: [],
      triage: [],
      markedRequirements: [],
      dropped: [],
      correspondence: final.report.correspondence,
      testRun: final.report.testRun,
      disputes,
      rejected,
      arbitration: {
        upheld,
        overturned,
        unresolved,
        ...(returnedToPlan.length === 0 ? {} : { returnToPlan: returnedToPlan }),
      },
      builder: input.builder,
      verificationProfile: input.verificationProfile ?? "musunest-factory/l2",
      specEngineVersion: input.specEngineVersion,
      factoryVersion: input.factoryVersion,
      plan: input.plan,
      // v1 の成果物（設計・試験・対応）は A1 の写し（表の v1 の型への写し・固定した組・恒等の対応）
      design: conversion.design,
      testSuite: testSpec.suite,
      mappings: identityMappings(table),
      materials: materialEntries(),
      evaluations: [...materialStore.evaluations.values()],
      extraArtifacts,
    });
    const diagnostics = buildRejectedCandidateFiles(await rejectedCandidateRows());
    return {
      kind: "generation",
      result: {
        outcome,
        record,
        summary,
        bundle,
        stopped: failure,
        diagnostics,
        ...(returnToPlan ? { returnToPlan: true } : {}),
      },
    };
  } catch (error) {
    if (error instanceof RunStop) {
      return stageControl === undefined
        ? { kind: "generation", result: await stopResult(error.attribution) }
        : stageOutcome(error.attribution);
    }
    throw error;
  }
}
