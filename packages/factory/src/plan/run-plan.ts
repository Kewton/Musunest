// Plan を 1 回流す口（04-plan-agent.md §2・§3・§6・§8。Issue #363）。
//
// P1〜P6（要件にする・逆照合・洗い出し・目録の点検・質問・答えの反映・照合と確定）を順に回し、
// **確定した仕様**まで進める。**端末にもファイルにも縛られない**——答える役（利用者）は口
// （`PlanResponder`）として外から差し込む。端末・ファイル・評価の利用者役は、この口の実装として外側に置く。
//
// 流れ：P1 要件にする・P2 逆照合（`runReverseCheckLoop`）→ P3 目録の点検（`runCatalog`）と洗い出し
// （`runSurface`）→ P4 質問（`runQuestions`）→ 往復の関数（`nextPlanStep`）で次の一歩を決める →
// 答える役の口で答えを受け取り P5 で反映する（`runAnswers`）→ …（上限は往復をまたいで数える）→
// P6 照合と確定（`runConfirm`）。**目録の点検は洗い出しより先に回す**——点検した対象・開いている事項・
// 仮に適用した既定を洗い出しに渡し、同じ決めどころの重複を抑える（Issue #419）。既定の確定は今までどおり
// 洗い出しの後（各往復の P4 の前）である。
//
// 結果は 3 つの形である：**確定した**（`checkConfirmedPlan` を通った仕様）／**確定できない**（残った
// 重大な未解決の事項）／**止まった**（予算・締切・段の失敗・答える役が「やめる」）。
//
// LLM の呼び出しは生成と同じ共通の口（`CallGateway`）を通す。判定の口は #359 の予算の包み
// （`createBudgetedJudge`）で包む。**使った額（USD）と段ごとの記録**（生成の段の記録と同じ形）を結果に
// 入れ、呼ぶ側が Build に残りの予算（`remainingUsd`）を渡せるようにする。
//
// **実 API は呼ばない。** 差し込まれた `LlmClient`・`Judge`・`PlanResponder` だけを使い、鍵もファイルも
// 環境変数も扱わない（CLAUDE.md の不変条件）。
import {
  PLAN_SPEC_SCHEMA_VERSION,
  checkConfirmedPlan,
  type ConfirmedPlan,
  type PlanAcceptedUnwritable,
  type PlanAnswerInput,
  type PlanChange,
  type PlanDecision,
  type PlanInput,
  type PlanOpenIssue,
  type PlanPart,
  type PlanProblem,
  type PlanQuestionInput,
  type PlanRequirement,
  type PlanSourceInput,
} from "@musunest/appspec-schema";
import { JobBudget, type TokenRates } from "../budget.js";
import type { BundleJudgeUsage } from "../bundle.js";
import { CallGateway, createCallGate } from "../call.js";
import type { Judge } from "../judge.js";
import { JudgeBudgetExceededError, JudgeCallLimitExceededError, JudgeDeadlineExceededError, createBudgetedJudge, type BudgetedJudge } from "../judge-budget.js";
import { AGENT_LIMITS, type AgentLimits, type LimitName } from "../limits.js";
import type { LlmClient } from "../llm.js";
import { requirementTextWithQuestionContext, type RequirementList, type ReverseCheckMiss, type SourceRange } from "../pipeline.js";
import { UsageMeter, usageDelta, type FailureKind, type StageStatus, type UsageSnapshot } from "../record.js";
import type { PromptDocument, StageFailure, StageOutcome } from "../stages/prompt.js";
import { normalizeConstraintId } from "../stages/prompt.js";
import {
  emptyReverseCheckDiagnosis,
  runReverseCheckLoopWithOperation,
  splitSourceSentences,
  type ReverseCheckDiagnosis,
  type ReverseCheckOperation,
} from "../stages/reverse-check.js";
import { runAnswers, validateAnswer, type ClassifiedAnswer, type PlanAnswerDraft } from "./answers.js";
import {
  CATALOG_FACETS,
  INHERIT_FACET_KINDS,
  INHERIT_FACET_MISSES,
  catalogDefaultOf,
  catalogGateQuestionName,
  catalogOpenIssue,
  inheritFacetsForAnswer,
  runCatalog,
  type CatalogResult,
  type InheritFacetKind,
  type InheritFacetMissKind,
  type InheritedFacet,
  type UnspecifiedFacet,
} from "./catalog.js";
import { runConfirm, type ConfirmProblem } from "./confirm.js";
import { alsoClosesOf, assignQuestionIds, runQuestions, type PlanQuestion, type PlanSourceClosure } from "./questions.js";
import {
  nextPlanStep,
  remainingPlanBudget,
  type PlanConfirmationView,
  type PlanRemaining,
  type PlanTurn,
} from "./session.js";
import { checkSurfaceTargets, runSurface, type PlanSurface, type PlanUnwritable, type SurfaceCatalogData, type SurfaceContext, type SurfaceContextQuestionAnswer, type SurfaceOutOfScopeRef, type SurfaceTargetResult } from "./surface.js";
import {
  PLAN_OPEN_ISSUE_SOURCES,
  detectOpenIssueCollisions,
  resolveTargetOf,
  surfaceCheckOpenIssueId,
  type PlanOpenIssueConflicts,
  type PlanOpenIssueSource,
} from "./open-issues.js";
import { runSurfaceCheck, type SurfaceClaimDiagnostic, type SurfaceJudgment, type SurfaceUncheckedClaim } from "./surface-check.js";

export type { PlanOpenIssueConflicts, PlanOpenIssueSource } from "./open-issues.js";

/** Plan の段（記録の `stage` に使う。生成の段とは別の一覧である） */
export const PLAN_STAGE_IDS = [
  "requirements", // P1 要件にする・P2 逆照合（`runReverseCheckLoop`）
  "catalog", // P3 目録の点検（`runCatalog`）
  "surface", // P3 洗い出し（`runSurface`）
  "surface-check", // P3 の「書けない」の申告を判定の口で点検する（`runSurfaceCheck`。Issue #432）
  "questions", // P4 質問を組み立てる（`runQuestions`）
  "answers", // P5 答えを反映する（`runAnswers`）
  "confirm", // P6 照合と確定（`runConfirm`）
] as const;
export type PlanStageId = (typeof PLAN_STAGE_IDS)[number];

/**
 * 判定の確率の閾値の既定（これ**未満**を未指定・未解決と見なす）。生成の
 * `UNWRITABLE_CONFIDENCE_THRESHOLD` と同じ側へ倒す。
 */
export const DEFAULT_PLAN_JUDGE_THRESHOLD = 0.6;

/**
 * Plan の段ごとの記録（生成の段の記録＝`StageRecord` と同じ形）。列挙した欄だけを持つ。
 * `stage` だけが生成の段の名前ではなく、Plan の段の名前（`PlanStageId`）である。
 */
export interface PlanStageRecord {
  readonly stage: PlanStageId;
  readonly status: StageStatus;
  readonly duration_ms: number;
  readonly calls: number;
  readonly missing_usage_calls: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly failure_kind: FailureKind | null;
}

/**
 * 段の失敗の診断に載せる、問題の分類の有限の一覧（Issue #397）。**`other` 以外は、既存の分類
 * （質問の段・答え・P6 の照合・確定した仕様の検査・上限）を保持する対応表である**——発生側が付けた
 * 分類がこの一覧にあればそれを残し、無ければ `other` にする。
 */
export const PLAN_DIAGNOSIS_CODES = [
  /** 形（欄の欠け・型違い・知らない値。質問・答え・確定した仕様の形） */
  "shape",
  // 引用（P1 要件にする・P2 逆照合）
  "quote-not-found",
  "position-mismatch",
  "uncovered-source",
  // 制約 ID の裏付け（P3 洗い出し）
  "constraint-id-missing",
  "constraint-id-unknown",
  // 差分の洗い出しが指す要件 ID が、点検の対象（その往復の差分）に無い（Issue #434）
  "requirement-id-unknown",
  // P3 の「書けない」の申告の点検（Issue #432）。未点検の分類（低確信・書いていない・読めない）
  "not-stated",
  "low-confidence",
  "unknown",
  // 質問（P4）
  "question-count",
  "choices-count",
  "recommendation",
  "free-text",
  "issue-mapping",
  "duplicate-issue",
  "duplicate-question-id",
  "also-closes",
  "source-closure",
  // 依頼文で閉じる事項の引用（Issue #408。逐語でない引用の診断。どちらも形の誤りとして断る）
  "source-closure-quote",
  "source-closure-quote-whitespace",
  "question-coverage",
  // 答え（P5）
  "unknown-question",
  "unknown-choice",
  "stale-revision",
  "free-text-length",
  // P6 照合
  "uncovered-answer",
  "origin-not-answer",
  // 確定した仕様の検査（#331 の `checkPlan`）
  "unknown_reference",
  "accepted_outside_parts",
  "accepted_not_removal",
  "resolution_without_basis",
  "open_issue",
  "open_critical",
  "confirmation_expired",
  // API が返した誤りの種類（`invalidRequest.code`。既知の値だけ残す）
  "invalid_json_schema",
  "invalid_request_error",
  // 打ち切りの理由（`incomplete.reason`。既知の値だけ残す）
  "max_output_tokens",
  "content_filter",
  // 上限の種類
  "limit-request-text",
  "limit-declaration-bytes",
  "limit-call-count",
  "limit-tool-calls",
  "limit-plan-questions",
  "limit-plan-round-trips",
  "limit-other",
  // 往復の制御（`cannot-confirm` の `source: session`）
  "question-limit",
  "round-trip-limit",
  "critical-no-question",
  // 同じ ID の開いている事項の行が 2 つ以上ある（問いを出す前に止める。Issue #460）
  "duplicate-open-issue",
  // 上限のあとに重大でない事項だけが残った（既定の無い観点・自由文など。Issue #408）
  "noncritical-without-default",
  // 一覧に無いもの
  "other",
] as const;

/** 診断の問題の分類の集合（`other` にするかの判定に使う） */
const DIAGNOSIS_CODES: ReadonlySet<string> = new Set(PLAN_DIAGNOSIS_CODES);

/**
 * 診断の欄の名前を、**既知の欄と配列の位置から組み直す**（Issue #397）。生の path を写して加工しない。
 * `name[0].field` の形の各段の名前を既知の一覧（`KNOWN_FIELD_NAMES`）と照らし、無い名前は `*` に伏せる。
 * **出力に由来する ID・原文・答えの文字列は、欄の名前に入らない。**
 */
const KNOWN_FIELD_NAMES: ReadonlySet<string> = new Set([
  // Plan の仕様の欄
  "schema_version",
  "plan_id",
  "revision",
  "vocabulary_version",
  "inputs",
  "requirements",
  "open_issues",
  "decisions",
  "accepted_unwritable",
  "ambiguities",
  "requirementId",
  "confirmation",
  "sha256",
  "confirmed_at",
  "confirmed_by",
  // 入出力の欄
  "source",
  "framing",
  "unresolved",
  "questions",
  "closedBySource",
  "uncovered",
  // 要素の欄
  "id",
  "unwritable",
  "text",
  "quote",
  "position",
  "start",
  "end",
  "kind",
  "critical",
  "status",
  "value",
  "reason",
  "origin",
  "input_id",
  "change",
  "answer_id",
  "from_requirement_id",
  "question_id",
  "choice_id",
  "choices",
  "recommended",
  "choiceId",
  "allowFreeText",
  "alsoCloses",
  "openIssueId",
  "issueId",
  "parts",
  "part_id",
  "alternative_id",
  "disposition",
  "basis",
  "doc_version",
  "location",
  "constraint_id",
  "resolution",
  "decision_id",
  "constraintIds",
  "part",
  "alternative",
  // 診断の欄
  "limit",
  "invalidRequest",
  "incomplete",
  "code",
]);

/** 1 つの段の名前（`name[0][1]` の形）を、既知の欄と配列の位置から組み直す */
function safeFieldSegment(segment: string): string {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)?((?:\[\d+\]|\[\*\])*)$/.exec(segment);
  if (match === null) return "*";
  const name = match[1];
  const indices = match[2] ?? "";
  if (name === undefined || name === "") return indices === "" ? "*" : indices;
  return KNOWN_FIELD_NAMES.has(name) ? `${name}${indices}` : "*";
}

/** 診断の欄の名前を組み直す（`rawPath` に由来する値を持ち込まない） */
export function planDiagnosisField(rawPath: string): string {
  if (rawPath === "") return "";
  return rawPath.split(".").map(safeFieldSegment).join(".");
}

/** 分類を有限の一覧に写す（一覧に無いものは `other`） */
export function planDiagnosisCode(code: string | undefined): string {
  return code !== undefined && DIAGNOSIS_CODES.has(code) ? code : "other";
}

/** 上限の名前を、診断の分類に写す */
function limitDiagnosisCode(limit: LimitName): string {
  switch (limit) {
    case "requestTextChars":
      return "limit-request-text";
    case "declarationBytes":
      return "limit-declaration-bytes";
    case "callCount":
      return "limit-call-count";
    case "toolCalls":
      return "limit-tool-calls";
    case "planQuestions":
      return "limit-plan-questions";
    case "planRoundTrips":
      return "limit-plan-round-trips";
    default:
      return "limit-other";
  }
}

/** API が返した誤りの種類を、既知の一覧に写す（知らない値は `other`） */
function apiDiagnosisCode(code: string): string {
  return code === "invalid_json_schema" || code === "invalid_request_error" ? code : "other";
}

/** 打ち切りの理由を、既知の一覧に写す（知らない値は `other`） */
function incompleteDiagnosisCode(reason: string): string {
  return reason === "max_output_tokens" || reason === "content_filter" ? reason : "other";
}

/**
 * 段の失敗から、**値の中身を含まない**診断（欄の名前と分類）を取り出す（Issue #397）。生の `message`・
 * API の誤りの種類・打ち切りの理由はそのまま転記せず、有限の一覧に写す（一覧に無い値は `other`）。
 */
function diagnoseStageFailure(failure: StageFailure): readonly PlanFailureProblem[] {
  switch (failure.kind) {
    case "malformed":
    case "unmet":
      return failure.problems.map((problem) => ({
        field: planDiagnosisField(problem.field),
        code: planDiagnosisCode(problem.code),
      }));
    case "limit":
      return [{ field: "limit", code: limitDiagnosisCode(failure.limit) }];
    case "callLimit":
      return [{ field: "limit", code: limitDiagnosisCode(failure.limit) }];
    case "invalidRequest":
      return [{ field: "invalidRequest.code", code: apiDiagnosisCode(failure.code) }];
    case "incomplete":
      return [{ field: "incomplete.reason", code: incompleteDiagnosisCode(failure.reason) }];
    default:
      return [];
  }
}

/** 段の失敗の診断（欄の名前と分類。値の中身を含まない。Issue #397） */
export interface PlanFailureProblem {
  readonly field: string;
  readonly code: string;
}

/** P1/P2 のどの呼び出しで止まったか（有限の値。Issue #397） */
export const PLAN_OPERATIONS = ["requirements", "reverse-check", "requirements-redo", "reverse-check-redo"] as const;
export type PlanOperation = (typeof PLAN_OPERATIONS)[number];

/** 早く止まった帰属（どの段の・どの種類の失敗か。P1/P2 ではどの呼び出しかも持つ） */
export interface PlanFailure {
  readonly stage: PlanStageId;
  readonly kind: FailureKind;
  /** 段の失敗の診断（形が合わない・コードの検査に合わない・上限・要求の誤り・打ち切り。Issue #397） */
  readonly problems?: readonly PlanFailureProblem[];
  /** P1/P2 で、どの呼び出しで止まったか（有限の値。Issue #397） */
  readonly operation?: PlanOperation;
}

/** 確定できなかった理由の出どころ（有限の 5 つ。Issue #397・#432） */
export const CANNOT_CONFIRM_SOURCES = [
  /** P6 の覆いの問題（覆われていない原文・使われていない答え） */
  "confirm",
  /** P6 の中の仕様の検査と、外側の確定した仕様の検査 */
  "plan-check",
  /** 逆照合で落ちが残った */
  "reverse-check",
  /** P3 の「書けない」の申告に未点検が残った（Issue #432） */
  "surface-check",
  /** 往復の制御（質問数の上限・往復数の上限・重大な事項があるのに問いが無い） */
  "session",
] as const;
export type CannotConfirmSource = (typeof CANNOT_CONFIRM_SOURCES)[number];

/** 確定できなかった理由 1 つ（**値の中身を含まない**。欄の名前はコードが組み、分類は有限の一覧。Issue #397） */
export interface CannotConfirmReason {
  readonly source: CannotConfirmSource;
  readonly code: string;
  readonly path: string;
  /**
   * 申告の点検で確定できなかったときの、**点検の番号**（1 始まり。初回が 1）。同じ問いの名前・局所の
   * 申告の添字が点検ごとに繰り返すので、どの点検かを一意に引けるようにする（Issue #434）。申告の点検
   * 以外の理由には付かない。
   */
  readonly check?: number;
}

/** 止まった理由（`declined` は答える役が「やめる」と言ったとき。それ以外は失敗の分類） */
export type PlanStopReason = "declined" | FailureKind;

/** 既定で閉じた事項 1 つ（Issue #408）。事項 ID・観点 ID・値を持つ（値はコードの定数なので記録してよい） */
export interface PlanDefaultClosure {
  /** 既定で閉じた未解決の事項の ID */
  readonly issueId: string;
  /** 当てた観点の ID */
  readonly facetId: string;
  /** 観点の定数の値（コードの定数だけ） */
  readonly value: string;
}

/**
 * 点検 1 回ぶんの判定の記録（Issue #432・#434）。**点検の番号**（1 始まり。初回が 1）を添える——同じ問いの
 * 名前（`plan-triage:0` など）が点検ごとに繰り返すので、どの点検の判定かを一意に引けるようにする。
 */
export interface PlanSurfaceJudgment extends SurfaceJudgment {
  /** 点検の番号（1 始まり。初回が 1、各差分で増える） */
  readonly check: number;
}

/**
 * 点検 1 回ぶんの診断（Issue #432・#434）。**点検の番号**を添える——申告の添字（`index`）は点検ごとに
 * 0 から振られるので、どの点検の申告かを一意に引けるようにする。
 */
export interface PlanSurfaceCheckDiagnostic extends SurfaceClaimDiagnostic {
  /** 点検の番号（1 始まり。初回が 1、各差分で増える） */
  readonly check: number;
}

/**
 * P3 の「書けない」の申告の点検の記録（Issue #432・#434）。**件数（受理・落とした・曖昧さへ・未点検）と、
 * 判定の記録（問いの ID・答え・確信度・モデルの版・adapter・**点検の番号**）**を持つ——申告の部分の文・
 * 理由・制約 ID の値は入れない（`02-failure-modes.md` §1）。**初回と各往復の差分の点検を連結**したもので、
 * 判定は `check` でどの点検かに一意に引ける。確定・確定できない・止まったの 3 つの結果に共通で、申告 0 件
 * なら件数も 0、記録も空である。
 */
export interface PlanSurfaceCheckSummary {
  /** 受理した申告（語彙の穴で裏付けが取れたもの）の件数 */
  readonly accepted: number;
  /** 落とした申告（問題ではない・裏付けが反する）の件数 */
  readonly dropped: number;
  /** 曖昧さと判定した申告（開いている事項に写した）の件数 */
  readonly ambiguity: number;
  /** 未点検の申告（裏付けが書いていない・確信度が閾値未満・答えが読めない）の件数 */
  readonly unchecked: number;
  /** 判定の記録（仕分けと裏付けの両方。点検の番号つき） */
  readonly judgments: readonly PlanSurfaceJudgment[];
  /**
   * 点検の段が最後まで終えたか（Issue #432）。`false` は、仕分けの途中で止まった（判定の予算が尽きた）などで
   * **全部の申告を点検し終えていない**ことを示す——申告 0 件（`accepted`・`dropped`・`ambiguity`・`unchecked`
   * がすべて 0・`judgments` も空）と区別する。**すべての点検が終えたときだけ真**である。
   */
  readonly completed: boolean;
}

/**
 * 対象外の参照の分類（有限。**モデルに選ばせず**、内部の対応でコードが決める。値は入れない。Issue #434）。
 *
 *   - `source` … 原文（`sourceInputs`）に由来する要件への参照
 *   - `previous-answer` … 前の往復の答えに由来する要件への参照
 *   - `alternative` … 了承除外の代わりの案（`accepted_unwritable.alternative_id`）への参照
 *   - `unknown` … 存在しない要件 ID
 *   - `unclassified` … 存在するが、内部の対応から分類できない（既知・分類不明）
 */
export const DIFF_OUT_OF_SCOPE_KINDS = [
  "source",
  "previous-answer",
  "alternative",
  "unknown",
  "unclassified",
] as const;
export type DiffOutOfScopeKind = (typeof DIFF_OUT_OF_SCOPE_KINDS)[number];

/** 分類別の件数（申告／曖昧さ別。Issue #434） */
export interface PlanDiffOutOfScopeKindCount {
  readonly kind: DiffOutOfScopeKind;
  readonly claims: number;
  readonly ambiguities: number;
}

/**
 * 差分点検 1 回の、**対象外の参照の記録**（Issue #434）。**値は持たず、件数と分類と添字だけ**である。
 * 原応答で対象外だった件数・コードが重複として除いた件数・重複と認めず断った件数を区別して持つ。
 */
export interface PlanDiffOutOfScopeRecord {
  /**
   * **形が正しい応答を走査したか**（Issue #434）。`false` は、応答の形が合わずに対象外の走査に届かなかった
   * ことを示す——件数の 0 が「未照合」なのか「真に 0 件」なのかを区別する。
   */
  readonly scanned: boolean;
  /** 原応答で対象外だった「書けない」の申告の件数 */
  readonly claims: number;
  /** 原応答で対象外だった未解決の事項の件数 */
  readonly ambiguities: number;
  /** コードが重複として除いた件数（申告だけ） */
  readonly deduped: number;
  /** 重複と認めず断った「書けない」の申告の件数 */
  readonly rejectedClaims: number;
  /** 断った未解決の事項の件数（曖昧さは重複と認めない） */
  readonly rejectedAmbiguities: number;
  /** 対象外の参照の分類別の件数 */
  readonly kinds: readonly PlanDiffOutOfScopeKindCount[];
  /**
   * 重複として除いた申告の、**原応答での添字**（数値だけ）。**フィルター後の F1 の添字と同一だと
   * 推測させない**——原応答と F1 の対応を、この数値だけで追えるようにする。
   */
  readonly dedupedIndexes: readonly number[];
}

/**
 * 引き継いだ観点の件数（種類ごと・観点 ID ごと。Issue #461）。**値・事項 ID・要件 ID・文・答えは
 * 入れない**——有限の種類と観点 ID と件数だけである。
 */
export interface PlanInheritedFacetCount {
  readonly kind: InheritFacetKind;
  readonly facetId: string;
  readonly count: number;
}

/** 根拠が引けず引き継がなかった件数（分類別。Issue #461） */
export interface PlanInheritMissCount {
  readonly kind: InheritFacetMissKind;
  readonly count: number;
}

/**
 * 差分点検で新しく開いた事項の出どころの種類（有限。Issue #461）。差分の点検が開く事項の出どころは、
 * 目録（`runCatalog`）・洗い出し（`runSurface`）・申告の点検（`runSurfaceCheck`）の 3 つである。
 */
export const PLAN_DIFF_OPEN_ISSUE_SOURCES = ["catalog", "surface", "surface-check"] as const;
export type PlanDiffOpenIssueSource = (typeof PLAN_DIFF_OPEN_ISSUE_SOURCES)[number];

/** 出どころ別の、開いた事項の件数（Issue #461） */
export interface PlanDiffOpenIssueSourceCount {
  readonly source: PlanDiffOpenIssueSource;
  readonly count: number;
}

/**
 * 差分点検 1 回の、**引き継ぎの記録**（Issue #461）。**値を持たず、件数と有限の分類だけ**である——
 * 引き継いだ件数（種類ごと・観点 ID ごと）・親なしの件数・親が複数で (a) だけにした件数・根拠が引けず
 * 引き継がなかった件数（分類ごと）・新しく開いた事項の出どころ別の件数を持つ。事項 ID・要件 ID・文・
 * 答えは入れない。
 */
export interface PlanInheritRecord {
  readonly facets: readonly PlanInheritedFacetCount[];
  readonly noParent: number;
  readonly multipleParents: number;
  readonly unresolved: readonly PlanInheritMissCount[];
  readonly openBySource: readonly PlanDiffOpenIssueSourceCount[];
}

/**
 * 差分点検 1 回の記録（Issue #434）。**値を持たず、件数だけ**である——点検した対象（その往復で増えた
 * 要件）の件数と、そこで新しく開いた事項・了承除外に加えた件数、対象外の参照の記録。往復ごとに 1 件積む。
 */
export interface PlanDiffReviewRecord {
  /** 何往復目の P5 のあとの点検か（1 始まり） */
  readonly round: number;
  /** 点検した差分の要件の件数 */
  readonly added: number;
  /** 新しく開いた事項の件数（目録・洗い出し・申告の点検の曖昧さの合計） */
  readonly openIssues: number;
  /** 了承除外（`accepted_unwritable`）に加えた件数 */
  readonly acceptedUnwritable: number;
  /** 対象外の参照の記録（値なし） */
  readonly outOfScope: PlanDiffOutOfScopeRecord;
  /** 引き継いだ観点の記録（件数と有限の分類だけ。Issue #461） */
  readonly inherit: PlanInheritRecord;
}

/** 3 つの結果に共通する記録（使った額・残りの額・段ごとの記録・判定の呼び出し） */
export interface PlanResultBase {
  /** 段ごとの記録（生成の段の記録と同じ形） */
  readonly stages: readonly PlanStageRecord[];
  /** 使った額（USD。LLM と判定の費用を合わせたもの） */
  readonly spentUsd: number;
  /** 残りの予算（USD。呼ぶ側が Build に渡す） */
  readonly remainingUsd: number;
  /** 判定の呼び出しの数（答えた adapter ごと）と費用（USD） */
  readonly judge: BundleJudgeUsage;
  /** 依頼文で閉じた事項（往復の記録に残す。04 §3 P4・Issue #370） */
  readonly closedBySource: readonly PlanSourceClosure[];
  /** 許可の表の既定で閉じた事項（04 §3・Issue #408） */
  readonly closedByDefault: readonly PlanDefaultClosure[];
  /**
   * P1/P2 の往復ごとの逆照合の落ちの内訳（種類ごと・出どころごと。Issue #430）。確定・確定できない・
   * 止まったの 3 つの結果に共通で、P1/P2 で止まったときは、止まるまでに得た往復の分だけを持つ。
   * **値は件数だけ**である（落ちの文言・引用・位置は入れない。`02-failure-modes.md` §1）。
   */
  readonly requirementsDiagnosis: ReverseCheckDiagnosis;
  /**
   * P3 の「書けない」の申告の点検の記録（受理・落とした・曖昧さへ・未点検の件数と、判定の記録。Issue #432）。
   * 値（申告の部分の文・理由・制約 ID）は入れない。**往復の記録（`plan-record.json`）に載せる要約**である。
   */
  readonly surfaceCheck: PlanSurfaceCheckSummary;
  /**
   * P3 の申告 1 件ずつの診断（申告の添字・要件 ID・部分・理由・制約 ID・文書の版と、点検の段階・分類・
   * adapter・確信度・根拠 ID。Issue #432）。**受理・落とした・途中停止のどれも**残す——呼ぶ側（`cli.ts`）が
   * 別の診断ファイルに書く。`plan-record.json`（`surfaceCheck`）には入れない。
   */
  readonly surfaceCheckDiagnostics: readonly PlanSurfaceCheckDiagnostic[];
  /**
   * 差分点検（各往復の P5 のあと、その往復で増えた要件だけを掛けた目録・洗い出し・申告の点検）の記録
   * （Issue #434）。往復ごとに 1 件。**値を持たず件数だけ**である。増えた要件が 0 件の往復では積まない。
   */
  readonly diffReviews: readonly PlanDiffReviewRecord[];
  /**
   * 同じ ID の開いている事項の行の衝突の記録（**値を持たず件数と有限の分類だけ**。Issue #460）。衝突した
   * ID の件数・衝突した行の件数（既存の出どころ × 追加の出どころの組ごと）・解決の対象が 0 行だった件数・
   * 衝突を検出した往復の版を持つ。事項 ID・要件 ID・文・答えは入れない。
   */
  readonly openIssueConflicts: PlanOpenIssueConflicts;
}

/** 依頼文で閉じた事項から作る `decisions` の ID の頭（確認の画面が「依頼文で決めたこと」を見分ける） */
export const SOURCE_CLOSURE_DECISION_PREFIX = "D:source:" as const;

/** その `decisions` が、依頼文で閉じた事項から作られたものか */
export function isSourceClosureDecision(decision: PlanDecision): boolean {
  return decision.id.startsWith(SOURCE_CLOSURE_DECISION_PREFIX);
}

/** 許可の表の既定で閉じた事項から作る `decisions` の ID の頭（決定の ID は安定した形。Issue #408） */
export const DEFAULT_DECISION_PREFIX = "D:default:" as const;

/** 既定で閉じた事項の決定の ID（`D:default:<事項 ID>`。事項 ID から安定して決まる） */
export function defaultDecisionId(issueId: string): string {
  return `${DEFAULT_DECISION_PREFIX}${issueId}`;
}

/** 引き継いだ観点の決定の ID の頭（`D:inherit:<事項 ID>`。Issue #461） */
export const INHERIT_DECISION_PREFIX = "D:inherit:" as const;

/** 引き継いだ観点の決定の理由に置く固定文（親の事項 ID を添える。Issue #461） */
export const INHERIT_DECISION_REASON = "答えが解いた観点（親の要件で決まっている）を引き継いだ" as const;

/** Plan を 1 回流した結果（3 つの形） */
export type PlanResult =
  | ({ readonly kind: "confirmed"; readonly plan: ConfirmedPlan } & PlanResultBase)
  | ({
      readonly kind: "cannot-confirm";
      readonly openIssues: readonly PlanOpenIssue[];
      /** 確定できなかった理由（全件。値の中身を含まない。Issue #397） */
      readonly reasons: readonly CannotConfirmReason[];
    } & PlanResultBase)
  | ({ readonly kind: "stopped"; readonly reason: PlanStopReason; readonly failure: PlanFailure | null } & PlanResultBase);

/** 答える役に渡す、質問の束と残り */
export interface PlanAnswerRequest {
  readonly questions: readonly PlanQuestion[];
  readonly remaining: PlanRemaining;
}

/** 答える役の答え（問いごとの答え、または「全部推奨で進める」） */
export type PlanAnswerOutcome =
  | { readonly kind: "answers"; readonly answers: readonly PlanAnswerDraft[] }
  | { readonly kind: "all-recommended" };

/** 確認の画面への答え（「これで作る」か「やめる」） */
export type PlanConfirmOutcome = "build" | "stop";

/**
 * 答える役の口（port。04 §2・§7）。端末・ファイル・評価の利用者役は、この口の実装として**外側**に置く。
 *
 *   - `answer` … 質問の束と残り（質問の数・往復の数）を受け取り、答えか「全部推奨で進める」を返す
 *   - `confirm` … 確認の画面に出すもの（元の依頼との差分・書けないことと代わりの案）を受け取り、
 *     「これで作る」か「やめる」を返す
 */
export interface PlanResponder {
  answer(request: PlanAnswerRequest): Promise<PlanAnswerOutcome>;
  confirm(view: PlanConfirmationView): Promise<PlanConfirmOutcome>;
}

/** `runPlan` が受け取るもの（端末にもファイルにも縛られない） */
export interface PlanRunInput {
  /** 依頼文（原文） */
  readonly source: string;
  /** 信頼する文書（契約・語彙の意味・語彙の台帳）。呼ぶ側が文字列で渡す */
  readonly documents: readonly PromptDocument[];
  /** 素の LLM の呼び出し（adapter）。**この file は鍵も環境変数も触らない** */
  readonly client: LlmClient;
  /** 判定の口（Jev・LLM・偽物。試験は偽物を差し込む） */
  readonly judge: Judge;
  /**
   * **再点検専用の Luna の口**（Issue #432）。渡すと、これを同じ Plan 予算で包み、P3 の未確定の申告の
   * 再点検の宛先にする。渡さなければ `judge.fallback` を使い、それも無ければ再点検しない（未点検に残す）
   * ——合成した口をもう一度呼ぶと主（Jev）が答え直すだけなので、主を再点検には使わない。
   */
  readonly recheckJudge?: Judge;
  /** 答える役の口（端末・ファイル・評価の利用者役は外側に置く） */
  readonly responder: PlanResponder;
  /** Plan の費用の上限（USD。呼ぶ側が Plan と Build で分けて渡す。§8） */
  readonly budgetUsd: number;
  /** トークンの単価（コードに埋め込まない） */
  readonly rates: TokenRates;
  /** いまの時刻（ミリ秒）。時計は差し込む（試験は固定する） */
  readonly now: () => number;
  /** 締切（ミリ秒。この時刻で打ち切る） */
  readonly deadline: number;
  /** 推論の effort（段の出力の上限と、呼び出しごとの timeout の基準を決める） */
  readonly effort: string;
  /** 仕様の ID（`plan_id`） */
  readonly planId: string;
  /** P3 が照らした文書（語彙）の版（`vocabulary_version`） */
  readonly vocabularyVersion: string;
  /** 確認した人（`confirmed_by`） */
  readonly confirmedBy: string;
  /** 上限（既定は `AGENT_LIMITS`） */
  readonly limits?: AgentLimits;
  /** 呼び出し 1 回ごとの timeout の基準（ミリ秒）。指定しなければ effort から出す */
  readonly callTimeoutMs?: number;
  /** 判定の確率の閾値（既定は `DEFAULT_PLAN_JUDGE_THRESHOLD`） */
  readonly judgeThreshold?: number;
  /** 自由入力の長さの上限（既定は `AGENT_LIMITS.planFreeTextChars`） */
  readonly freeTextMax?: number;
  /** 判定の呼び出しの出力の上界（予約に使う。既定は判定の adapter の既定） */
  readonly judgeMaxOutputTokens?: number;
}

/** 早く止まる合図（`runPlan` の中だけで使う） */
class PlanStop extends Error {
  readonly failure: PlanFailure;
  constructor(failure: PlanFailure) {
    super(`段 ${failure.stage} で止まりました（${failure.kind}）`);
    this.name = "PlanStop";
    this.failure = failure;
  }
}

/**
 * 同じ ID の open の行が 2 つ以上あるのに解決しようとした合図（Issue #460）。問いを出す前の衝突の停止で
 * 先に止まる設計なので、ここへ来るのは不変条件の破れである。同じ理由（`duplicate-open-issue`）で止める。
 */
class PlanOpenIssueConflictStop extends Error {
  constructor() {
    super("同じ ID の開いている事項が 2 つ以上あります");
    this.name = "PlanOpenIssueConflictStop";
  }
}

/** 段の失敗を、記録の失敗の分類に写す（run.ts と同じ扱い） */
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

/**
 * 段の失敗を、記録の帰属（`PlanFailure`）に写す（Issue #397）。段の失敗の診断（欄の名前と分類。
 * **値の中身を含まない**）と、P1/P2 のときだけどの呼び出しか（`operation`）を付ける。
 */
function planFailureOf(
  stage: PlanStageId,
  failure: StageFailure,
  operation?: ReverseCheckOperation,
): PlanFailure {
  const problems = diagnoseStageFailure(failure);
  return {
    stage,
    kind: stageFailureToKind(failure),
    ...(problems.length === 0 ? {} : { problems }),
    ...(operation === undefined ? {} : { operation }),
  };
}

/** 質問を、確定した仕様の入力（`PlanQuestionInput`）に写す */
function toQuestionInput(question: PlanQuestion): PlanQuestionInput {
  const recommended = question.recommended ?? { choiceId: question.choices[0]?.id ?? "", reason: "" };
  return {
    id: question.id,
    kind: "question",
    open_issue_id: question.openIssueId,
    text: question.text,
    choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })),
    recommended: { choice_id: recommended.choiceId, reason: recommended.reason },
  };
}

/** 答え 1 つを、確定した仕様の入力（`PlanAnswerInput`）に写す。選択肢か自由入力のちょうど一方を持つ */
function toAnswerInput(answer: PlanAnswerDraft): PlanAnswerInput | undefined {
  if (answer.choiceId !== undefined) {
    return { id: answer.id, kind: "answer", question_id: answer.questionId, choice_id: answer.choiceId };
  }
  if (answer.freeText !== undefined && answer.freeText !== "") {
    return { id: answer.id, kind: "answer", question_id: answer.questionId, free_text: answer.freeText };
  }
  return undefined;
}

/** 答えから増えた要件（「足した」の関係と、答えの出どころを持つ） */
function answerRequirement(answerId: string, text: string): PlanRequirement {
  return {
    id: `R:${answerId}`,
    text,
    kind: "constraining",
    origin: { input_id: answerId, quote: text },
    change: { kind: "added", answer_id: answerId },
    parts: [],
  };
}

/** 答えが指す要件の文（選択肢に当たるなら選択肢の文、そうでなければ自由入力） */
function requirementTextOf(answer: ClassifiedAnswer, question: PlanQuestion): string {
  if (answer.choiceId !== undefined) {
    const choice = question.choices.find((candidate) => candidate.id === answer.choiceId);
    if (choice !== undefined) return choice.text;
  }
  return answer.freeText ?? question.text;
}

/** 差分の点検の対象の選択の結果（Issue #434） */
export type PlanDiffSelection =
  | { readonly kind: "targets"; readonly targets: readonly PlanRequirement[] }
  /** 変更・削除が指す元の要件を解決できなかった（確定させない側に倒す） */
  | { readonly kind: "unresolved" };

/**
 * 要件の `change` を、**点検済みを数える鍵**に写す（Issue #434）。ID だけでは、同じ ID の要件が後の
 * 答えで変更・削除されても「点検済み」と見なされてしまう——**答えと変更の関係**（変更の種類・答えの ID・
 * 元の要件の ID）まで含めて区別する。`change` を持たない要件は `undefined`（点検の対象にならない）。
 */
export function diffChangeKey(requirement: PlanRequirement): string | undefined {
  const change = requirement.change;
  if (change === undefined) return undefined;
  const from = change.from_requirement_id ?? "";
  return `${requirement.id}\u0000${change.kind}\u0000${change.answer_id}\u0000${from}`;
}

/**
 * **その往復で増えた・変わった要件**を選ぶ（Issue #434）。点検の対象にするのは、まだ点検していない
 * `change` 付きの要件だけである。**点検済みは ID ではなく `diffChangeKey` で数える**——同じ ID の要件が
 * 後の答えで変更・削除されると、鍵が変わるので、また対象になる。
 *
 *   - `added` … その要件自身を対象にする
 *   - `changed`・`removed` … **元の要件 ID（`change.from_requirement_id`）を引く**。引けても引けなくても
 *     その要件自身を対象にするが、**引けない（欄が無い・知らない ID）ときは `unresolved`** にして、
 *     呼ぶ側が確定させない側に倒す（点検の対象を勝手に作らない）
 *
 * **同じ入力からは同じ結果になる純粋な関数**である。
 */
export function selectDiffRequirements(
  requirements: readonly PlanRequirement[],
  reviewedKeys: ReadonlySet<string>,
): PlanDiffSelection {
  const known = new Set(requirements.map((requirement) => requirement.id));
  const targets: PlanRequirement[] = [];
  for (const requirement of requirements) {
    const change = requirement.change;
    if (change === undefined) continue;
    const key = diffChangeKey(requirement);
    if (key !== undefined && reviewedKeys.has(key)) continue;
    if (change.kind !== "added") {
      const from = change.from_requirement_id;
      if (typeof from !== "string" || from === "" || !known.has(from)) return { kind: "unresolved" };
    }
    targets.push(requirement);
  }
  return { kind: "targets", targets };
}

/** 差分点検 1 回の記録の、書き込み用の中身（Issue #434）。結果に写すときに分類別に組み直す */
interface MutableDiffReview {
  round: number;
  added: number;
  openIssues: number;
  acceptedUnwritable: number;
  scanned: boolean;
  claims: number;
  ambiguities: number;
  deduped: number;
  rejectedClaims: number;
  rejectedAmbiguities: number;
  kinds: Map<DiffOutOfScopeKind, { claims: number; ambiguities: number }>;
  dedupedIndexes: number[];
  /** 引き継いだ観点の件数（種類 × 観点 ID。Issue #461） */
  inheritKinds: Map<string, number>;
  inheritNoParent: number;
  inheritMultipleParents: number;
  inheritMisses: Map<InheritFacetMissKind, number>;
  openBySource: Map<PlanDiffOpenIssueSource, number>;
}

/** 受理した申告 1 つぶんの控え（重複の照合に使う。Issue #434） */
export interface AcceptedClaimSnapshot {
  readonly requirementId: string;
  /** 受理して要件に付けた部分の ID（現在の対応と一致することの証明に使う） */
  readonly partId: string;
  readonly part: string;
  readonly reason: string;
  readonly alternative: string;
  /** 受理して作った代わりの案の要件 ID（現在の対応と一致することの証明に使う） */
  readonly alternativeId: string;
  /**
   * 受理した時点の制約 ID。**保存用に 1 回だけ正規化した値**である（`runSurface` が返す値。呼ぶ側は
   * もう正規化しない。Issue #434・D2）。
   */
  readonly constraintIds: readonly string[];
  /** 受理した時点の要件の文（変わっていないことの確認） */
  readonly requirementText: string;
  /** 受理した時点の変更の版（`diffChangeKey`。変わっていないことの確認） */
  readonly changeKey: string | undefined;
  /** 受理した時点の文書（語彙）の版 */
  readonly docVersion: string;
}

/**
 * 対象外の「書けない」の申告が、**受理済みの申告の正確な再申告**か（§3 の 2・3。Issue #434）。
 * 完全一致を部分一致・空白除去・意味の推測へ広げない。部分 ID の接頭辞やモデル作の申告 ID を正本にせず、
 * `parts` と `accepted_unwritable` の実際の参照で引く。**純粋な関数**である。
 *
 * `claim.constraintIds` は**保存用に 1 回だけ正規化した値**として受け取る（もう正規化しない。D2）。
 * 正規化は一般の文字列で冪等でないため、二重に正規化すると別の既知集合を同一視してしまう。
 */
export function isAcceptedUnwritableDuplicate(input: {
  readonly claim: PlanUnwritable;
  readonly requirements: readonly PlanRequirement[];
  readonly acceptedUnwritable: readonly PlanAcceptedUnwritable[];
  readonly snapshots: readonly AcceptedClaimSnapshot[];
  readonly docVersion: string;
}): boolean {
  const { claim, requirements, acceptedUnwritable, snapshots, docVersion } = input;
  // §3 の 2：現在存在する一意な要件を指し、同じ部分文が accepted_removal の部分に完全一致し、
  // その part_id に受理済みの了承除外が一意に対応し、対応する代案も存在すること
  const matches = requirements.filter((requirement) => requirement.id === claim.requirementId);
  if (matches.length !== 1) return false;
  const requirement = matches[0];
  if (requirement === undefined) return false;
  const parts = requirement.parts.filter(
    (part) => part.disposition === "accepted_removal" && part.text === claim.part,
  );
  if (parts.length !== 1) return false;
  const part = parts[0];
  if (part === undefined) return false;
  // §3 の 2（D3）：**全要件**を通じて当該 part_id の出現が一意で、それが対象要件の当該部分であること。
  // ほかの要件・別の部分が同じ part_id を持つなら、重複と認めない。
  const sameIdParts = requirements.flatMap((one) => one.parts.filter((candidate) => candidate.id === part.id));
  if (sameIdParts.length !== 1) return false;
  const entries = acceptedUnwritable.filter((entry) => entry.part_id === part.id);
  if (entries.length !== 1) return false;
  const entry = entries[0];
  if (entry === undefined) return false;
  if (requirements.filter((one) => one.id === entry.alternative_id).length !== 1) return false;
  // §3 の 3：受理した元の申告と、部分文・理由・代案は完全一致、要件 ID は一致、制約集合は同値。
  // **受理した控えの対応（part_id・代わりの案の ID）が、現在の了承除外の対応と一致する**こと（D3）。
  const snapshot = snapshots.find(
    (one) =>
      one.requirementId === claim.requirementId &&
      one.partId === part.id &&
      one.part === claim.part &&
      one.reason === claim.reason &&
      one.alternative === claim.alternative &&
      one.alternativeId === entry.alternative_id &&
      sameStringSet(one.constraintIds, claim.constraintIds),
  );
  if (snapshot === undefined) return false;
  // 受理時から、要件の内容・変更の版と、文書の版が変わっていないこと
  if (snapshot.docVersion !== docVersion) return false;
  if (snapshot.requirementText !== requirement.text) return false;
  if (snapshot.changeKey !== diffChangeKey(requirement)) return false;
  return true;
}

/** 文字列の集合が等しいか（順序と重複は無視。空・追加・欠落は等しくない。Issue #434） */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/** 差分点検の記録を、結果の形（分類別の件数を組み直す）に写す（Issue #434） */
function finalizeDiffReview(review: MutableDiffReview): PlanDiffReviewRecord {
  return {
    round: review.round,
    added: review.added,
    openIssues: review.openIssues,
    acceptedUnwritable: review.acceptedUnwritable,
    outOfScope: {
      scanned: review.scanned,
      claims: review.claims,
      ambiguities: review.ambiguities,
      deduped: review.deduped,
      rejectedClaims: review.rejectedClaims,
      rejectedAmbiguities: review.rejectedAmbiguities,
      kinds: DIFF_OUT_OF_SCOPE_KINDS.map((kind) => ({
        kind,
        claims: review.kinds.get(kind)?.claims ?? 0,
        ambiguities: review.kinds.get(kind)?.ambiguities ?? 0,
      })),
      dedupedIndexes: review.dedupedIndexes.slice(),
    },
    // 引き継ぎの記録を、有限の分類ごとに組み直す（種類と観点 ID の順で決まる。Issue #461）
    inherit: {
      facets: INHERIT_FACET_KINDS.flatMap((kind) =>
        [...review.inheritKinds.keys()]
          .filter((key) => key.startsWith(`${kind}\u0000`))
          .map((key) => key.slice(kind.length + 1))
          .sort()
          .map((facetId) => ({
            kind,
            facetId,
            count: review.inheritKinds.get(`${kind}\u0000${facetId}`) ?? 0,
          })),
      ),
      noParent: review.inheritNoParent,
      multipleParents: review.inheritMultipleParents,
      unresolved: INHERIT_FACET_MISSES.map((kind) => ({
        kind,
        count: review.inheritMisses.get(kind) ?? 0,
      })),
      openBySource: PLAN_DIFF_OPEN_ISSUE_SOURCES.map((source) => ({
        source,
        count: review.openBySource.get(source) ?? 0,
      })),
    },
  };
}

/**
 * 答える役から受け取った答えの ID を、コードが組み直す（`A:<組み直した質問 ID>`。Issue #405）。
 *
 * **現在の束にある質問を指し、版が現在のもの**の答えだけを組み直す。質問 ID・版・選択肢 ID は補正しない
 * （合わない答えは今までどおり P5 の検査で断る）。組み直す前に、既存の `validateAnswer` で検査し、
 * **問題の無いものだけ**組み直す——空の答えの ID など、不合格の答えは補正せずそのまま渡し、既存の検査の
 * 順と分類で断らせ、判定・入力・要件・事項の解決に採らせない。同じ質問に 2 つ以上の答えが来たら、
 * **黙って 1 つを選ばず**、その質問の答えを全部断る（要件にせず、事項は開いたまま）。
 */
function rebuildAnswerIds(
  questions: readonly PlanQuestion[],
  answers: readonly PlanAnswerDraft[],
  revision: number,
  freeTextMax: number | undefined,
): readonly PlanAnswerDraft[] {
  const countByQuestion = new Map<string, number>();
  for (const answer of answers) {
    countByQuestion.set(answer.questionId, (countByQuestion.get(answer.questionId) ?? 0) + 1);
  }
  const rebuilt: PlanAnswerDraft[] = [];
  for (const answer of answers) {
    if ((countByQuestion.get(answer.questionId) ?? 0) > 1) continue;
    const problems = validateAnswer({
      questions,
      revision,
      answer,
      ...(freeTextMax === undefined ? {} : { freeTextMax }),
    });
    rebuilt.push(problems.length > 0 ? answer : { ...answer, id: `A:${answer.questionId}` });
  }
  return rebuilt;
}

/**
 * 逆照合で残った**引用にまつわる落ち**（引用が原文に無い・位置が 1 か所に決まらない。Issue #382）。
 * これが残ったまま Plan を確定させない——`run.ts` が同じ落ちを未達として数えるのと揃える。
 */
function quoteMissesOf(misses: readonly ReverseCheckMiss[]): readonly ReverseCheckMiss[] {
  return misses.filter((miss) => miss.kind === "quote-not-found" || miss.kind === "position-mismatch");
}

/** 逆照合の落ちを、確定できなかった理由（`source: reverse-check`）に写す（Issue #397） */
function reverseCheckReasons(misses: readonly ReverseCheckMiss[]): readonly CannotConfirmReason[] {
  return misses.map((miss) => ({
    source: "reverse-check" as const,
    code: planDiagnosisCode(miss.kind),
    path:
      miss.kind === "uncovered-source"
        ? "source[*]"
        : `requirements[*].${miss.kind === "quote-not-found" ? "quote" : "position"}`,
  }));
}

/**
 * P3 の「書けない」の申告の点検で未点検が残ったことを、確定できなかった理由（`source: surface-check`）に
 * 写す（Issue #432・#434）。**値の中身（部分の文・理由・制約 ID）を含まない**——`path` は添字つきの欄の名前
 * （`unwritable[<番号>]`）をコードが組み、`code` は有限の分類（`not-stated`・`low-confidence`・`unknown`）。
 * **点検の番号**（`check`。1 始まり）も添えて、どの点検の申告かを一意に引けるようにする。
 */
function surfaceCheckReasons(
  unchecked: readonly SurfaceUncheckedClaim[],
  check: number,
): readonly CannotConfirmReason[] {
  return unchecked.map((claim) => ({
    source: "surface-check" as const,
    code: planDiagnosisCode(claim.code),
    path: `unwritable[${claim.index}]`,
    check,
  }));
}

/** P6 の覆いの問題を、確定できなかった理由（`source: confirm`）に写す（Issue #397） */
function confirmReasons(problems: readonly ConfirmProblem[]): readonly CannotConfirmReason[] {
  return problems.map((problem) => ({
    source: "confirm" as const,
    code: planDiagnosisCode(problem.code),
    path: planDiagnosisField(problem.path),
  }));
}

/**
 * 確定した仕様の検査の問題を、確定できなかった理由（`source: plan-check`）に写す（Issue #397）。
 * **P6 の中の検査（`planProblems`）と外側の検査（`checkConfirmedPlan`）の重なりだけ**を、同じ
 * `source`・`code`・`path` の組で 1 件にまとめる（`path` が違えば別件として残す）。
 */
function planCheckReasons(problems: readonly PlanProblem[]): readonly CannotConfirmReason[] {
  const seen = new Set<string>();
  const reasons: CannotConfirmReason[] = [];
  for (const problem of problems) {
    const code = planDiagnosisCode(problem.code);
    const path = planDiagnosisField(problem.path);
    const key = `${code}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push({ source: "plan-check", code, path });
  }
  return reasons;
}

/**
 * 往復の制御で確定できなかった理由（`source: session`）を、有限の `code` で区別する（Issue #397・#408）。
 * 残った事項が**重大でないものだけ**なら `noncritical-without-default`（既定の無い観点・自由文など。
 * 既定で閉じられないまま上限に触れた）。重大な事項が残れば、質問の数の上限・往復の数の上限・
 * 重大な事項があるのに問いが無い、を今までどおり分ける。**重大な事項の理由を非重大の分類に置き換えない。**
 */
export function sessionCannotConfirmReason(
  turns: readonly PlanTurn[],
  openIssues: readonly PlanOpenIssue[],
): CannotConfirmReason {
  const open = openIssues.filter((issue) => issue.status === "open");
  if (open.length > 0 && open.every((issue) => !issue.critical)) {
    return { source: "session", code: "noncritical-without-default", path: "open_issues" };
  }
  const remaining = remainingPlanBudget(turns);
  const code =
    remaining.questions <= 0
      ? "question-limit"
      : remaining.roundTrips <= 0
        ? "round-trip-limit"
        : "critical-no-question";
  return { source: "session", code, path: "open_issues" };
}

/**
 * Plan を 1 回流す（04 §2・§3・§6・§8）。
 *
 * 段を決まった順に回し、答える役の口が答えたら答えを反映し、往復の上限（合わせて 10 問・3 往復）まで
 * 進める。上限のあとも重大な未解決の事項が残れば「確定できない」、確認で「やめる」なら「止まった」、
 * 予算・締切・段の失敗でも「止まった」を返す。**確定した仕様は `checkConfirmedPlan` を通ったものだけ**を
 * 「確定した」として返す。
 */
export async function runPlan(input: PlanRunInput): Promise<PlanResult> {
  const limits = input.limits ?? AGENT_LIMITS;
  const threshold = input.judgeThreshold ?? DEFAULT_PLAN_JUDGE_THRESHOLD;
  const meter = new UsageMeter();
  const budget = new JobBudget(input.budgetUsd);
  // 生成と判定で共有する実試行の門（Issue #432）。生成の呼び出し・その再試行・判定の呼び出し・Jev→Luna の
  // 切り替え・独立した再点検が、**同じ 1 つの数**で締切と総呼び出し数に掛かる。
  const gate = createCallGate({ now: input.now, deadline: input.deadline, limit: limits.callCount });
  const gateway = new CallGateway({
    client: meter.wrap(input.client),
    budget,
    rates: input.rates,
    now: input.now,
    deadline: input.deadline,
    limits,
    effort: input.effort,
    gate,
    ...(input.callTimeoutMs === undefined ? {} : { callTimeoutMs: input.callTimeoutMs }),
  });
  // 判定の口を、**この Plan の予算に結び付けた包み**で包む（#359）。判定の費用も、段の呼び出しと同じ
  // 予算で予約・精算する。予約できなければ判定を呼ばずに `JudgeBudgetExceededError` になる（止まる）。
  // **締切と総呼び出し数の門**（生成と同じ `gate`）も掛け、実試行の直前に照らす（Issue #432）。落とし先
  // （Luna）は**明示の `recheckJudge`** を優先し、無ければ `judge.fallback` を使う（主を再点検に使わない）。
  const judgeBudget: BudgetedJudge = createBudgetedJudge({
    judge: input.judge,
    budget,
    rates: input.rates,
    ...(input.judgeMaxOutputTokens === undefined ? {} : { maxOutputTokens: input.judgeMaxOutputTokens }),
    ...(input.recheckJudge === undefined ? {} : { recheck: input.recheckJudge }),
    gate,
  });
  const stages: PlanStageRecord[] = [];
  // 依頼文で閉じた事項（往復の記録に残す。04 §3 P4・Issue #370）
  const closedBySource: PlanSourceClosure[] = [];
  // 許可の表の既定で閉じた事項（Issue #408）
  const closedByDefaults: PlanDefaultClosure[] = [];
  // P1/P2 の往復ごとの逆照合の落ちの内訳（Issue #430）。止まったときは、止まるまでに得た分だけになる。
  let requirementsDiagnosis: ReverseCheckDiagnosis = emptyReverseCheckDiagnosis();
  // P3 の「書けない」の申告の点検の記録（Issue #432・#434）。**点検 1 回ごとに 1 件積む**——初回と、
  // 各往復の差分の点検である。途中停止・未点検でも、そこまでに終えた分類・判定・診断を残す
  // （成功や 0 件に見せない）。申告 0 件でも点検は 1 件積み、`completed` を真にする。
  const surfaceChecks: {
    accepted: number;
    dropped: number;
    ambiguity: number;
    unchecked: number;
    judgments: readonly SurfaceJudgment[];
    diagnostics: readonly SurfaceClaimDiagnostic[];
    completed: boolean;
  }[] = [];
  /** 点検ごとの記録を、結果の要約（件数と判定の記録）に合わせる（Issue #432・#434） */
  const aggregateSurfaceCheck = (): PlanSurfaceCheckSummary => {
    if (surfaceChecks.length === 0) {
      return { accepted: 0, dropped: 0, ambiguity: 0, unchecked: 0, judgments: [], completed: false };
    }
    return {
      accepted: surfaceChecks.reduce((total, check) => total + check.accepted, 0),
      dropped: surfaceChecks.reduce((total, check) => total + check.dropped, 0),
      ambiguity: surfaceChecks.reduce((total, check) => total + check.ambiguity, 0),
      unchecked: surfaceChecks.reduce((total, check) => total + check.unchecked, 0),
      // 判定に点検の番号（1 始まり）を添える——同じ問いの名前が点検ごとに繰り返すので、一意に引ける（Issue #434）
      judgments: surfaceChecks.flatMap((check, index) =>
        check.judgments.map((judgment) => ({ ...judgment, check: index + 1 })),
      ),
      // すべての点検が最後まで終えたときだけ `true`（途中停止・未点検を成功に見せない）
      completed: surfaceChecks.every((check) => check.completed),
    };
  };
  /** 点検ごとの診断を、1 本の並びにまとめる（受理・落とした・途中停止のどれも。点検の番号つき。Issue #432・#434） */
  const aggregateSurfaceCheckDiagnostics = (): readonly PlanSurfaceCheckDiagnostic[] =>
    surfaceChecks.flatMap((check, index) =>
      check.diagnostics.map((diagnostic) => ({ ...diagnostic, check: index + 1 })),
    );
  // コードが目録から作った事項の対応（事項 ID → 未指定の観点）と、要件ごとの門の判定（Issue #408）
  const catalogIssueFacets = new Map<string, UnspecifiedFacet>();
  const aggregatesByRequirement = new Map<string, boolean | null>();
  // 差分点検で点検済みの**変更の鍵**（要件 ID だけでなく、変更の種類・答えの ID・元の要件 ID も含む。
  // 同じ ID の後の変更・削除を取りこぼさない。Issue #434）
  const reviewedDiffKeys = new Set<string>();
  // 差分点検 1 回ずつの記録（値を持たず件数だけ。Issue #434）
  const diffReviews: MutableDiffReview[] = [];
  // 受理した「書けない」の申告の控え（重複の照合に使う。Issue #434）
  const acceptedClaimSnapshots: AcceptedClaimSnapshot[] = [];
  // 答えの ID → 問いが指した事項の ID の集合（主の事項と `alsoCloses`。引き継ぎの判定に使う。Issue #461）
  const answerIssueIds = new Map<string, readonly string[]>();
  // 答え由来の要件（ID は `R:<答えの ID>`。引き継ぎの判定に使う。Issue #461）
  const answerDerivedRequirements: { id: string; text: string }[] = [];
  // 既定・依頼文で閉じた事項の、**実際に作った決定の ID**（引き継ぎの分類に使う。Issue #461）
  const closureDecisionIds = new Map<string, string>();
  // それまでの引き継ぎの表（事項 ID → 要件 ID・観点 ID・決定 ID・値。Issue #461）
  const inheritedFacetTable = new Map<
    string,
    { requirementId: string; facetId: string; decisionId: string; value: string }
  >();

  // ── 開いている事項の行と、その出どころ・衝突の記録（Issue #460）─────────────────
  // `openIssues` と `openIssueSources` は**同じ長さ**である（行を畳まない・並べ替えない。状態の書き換えは
  // index で行うので、出どころの対応もずれない）。
  const openIssues: PlanOpenIssue[] = [];
  const openIssueSources: PlanOpenIssueSource[] = [];
  // 仕様の版（往復ごとに上がる）。衝突を検出した版の記録にも使う（Issue #460）
  let revision = 1;
  // 衝突の記録（値ではなく件数だけ。事項 ID は集合の大きさにしか使わない。Issue #460）
  const conflictIds = new Set<string>();
  const conflictRows = new Map<string, number>();
  let emptyResolveTargets = 0;
  let conflictRound: number | null = null;
  /** 衝突した ID を記録する（出どころの組ごとに件数を数える。Issue #460） */
  const recordConflict = (existing: PlanOpenIssueSource, added: PlanOpenIssueSource, id: string): void => {
    conflictIds.add(id);
    const key = `${existing}\u0000${added}`;
    conflictRows.set(key, (conflictRows.get(key) ?? 0) + 1);
    if (conflictRound === null) conflictRound = revision;
  };
  /**
   * 開いている事項に行を 1 つ足す（Issue #460）。**渡された形のまま足す**——畳まない・ID を振り直さない。
   * 同じ ID の行（状態を問わない）が既にあれば、衝突として記録する（止めるのは呼ぶ側）。出どころの種類は
   * 記録の分類にだけ使う。
   */
  const addOpenIssue = (issue: PlanOpenIssue, source: PlanOpenIssueSource): void => {
    const collision = detectOpenIssueCollisions([...openIssues, issue]).find(
      (candidate) => candidate.addedIndex === openIssues.length,
    );
    if (collision !== undefined) {
      recordConflict(openIssueSources[collision.existingIndex] ?? "unresolved", source, issue.id);
    }
    openIssues.push(issue);
    openIssueSources.push(source);
  };
  /** 衝突の記録を、結果の形（組ごとの件数を組み直す）に写す（Issue #460） */
  const buildOpenIssueConflicts = (): PlanOpenIssueConflicts => ({
    ids: conflictIds.size,
    rows: PLAN_OPEN_ISSUE_SOURCES.flatMap((existing) =>
      PLAN_OPEN_ISSUE_SOURCES.flatMap((added) => {
        const count = conflictRows.get(`${existing}\u0000${added}`) ?? 0;
        return count === 0 ? [] : [{ existing, added, count }];
      }),
    ),
    emptyTargets: emptyResolveTargets,
    round: conflictRound,
  });

  const pushRecord = (
    stage: PlanStageId,
    status: StageStatus,
    before: UsageSnapshot,
    start: number,
    failureKind: FailureKind | null,
  ): void => {
    const delta = usageDelta(before, meter.snapshot);
    stages.push({
      stage,
      status,
      duration_ms: input.now() - start,
      calls: delta.calls,
      missing_usage_calls: delta.missing_usage_calls,
      input_tokens: delta.input_tokens,
      cached_input_tokens: delta.cached_input_tokens,
      cache_write_tokens: delta.cache_write_tokens,
      output_tokens: delta.output_tokens,
      reasoning_tokens: delta.reasoning_tokens,
      failure_kind: failureKind,
    });
  };

  /** 値を返す段（目録の点検・答えの反映・照合と確定）を回し、所要時間とトークンを記録する */
  const runStage = async <T>(stage: PlanStageId, fn: () => Promise<T>): Promise<T> => {
    const before = meter.snapshot;
    const start = input.now();
    try {
      const value = await fn();
      pushRecord(stage, "ok", before, start, null);
      return value;
    } catch (error) {
      if (error instanceof PlanStop) {
        pushRecord(stage, "failed", before, start, error.failure.kind);
        throw error;
      }
      if (error instanceof JudgeBudgetExceededError) {
        pushRecord(stage, "failed", before, start, "budget");
        throw new PlanStop({ stage, kind: "budget" });
      }
      if (error instanceof JudgeDeadlineExceededError) {
        pushRecord(stage, "failed", before, start, "deadline");
        throw new PlanStop({ stage, kind: "deadline" });
      }
      if (error instanceof JudgeCallLimitExceededError) {
        pushRecord(stage, "failed", before, start, "call-limit");
        throw new PlanStop({ stage, kind: "call-limit" });
      }
      pushRecord(stage, "failed", before, start, "unknown");
      throw error;
    }
  };

  /**
   * LLM の段を回す。**段の失敗は、記録してから早期停止にする**（止めた段と理由、診断を残す）。
   * P1/P2 の呼び出しは、どの呼び出しで止まったか（`operation`）も付ける（Issue #397）。
   */
  const runStageOutcome = async <T>(
    stage: PlanStageId,
    fn: () => Promise<StageOutcome<T> | { readonly ok: false; readonly failure: StageFailure; readonly operation: ReverseCheckOperation }>,
  ): Promise<T> => {
    const before = meter.snapshot;
    const start = input.now();
    let value: T;
    try {
      const outcome = await fn();
      if (!outcome.ok) {
        const operation = "operation" in outcome ? outcome.operation : undefined;
        throw new PlanStop(planFailureOf(stage, outcome.failure, operation));
      }
      value = outcome.value;
    } catch (error) {
      if (error instanceof PlanStop) {
        pushRecord(stage, "failed", before, start, error.failure.kind);
        throw error;
      }
      if (error instanceof JudgeBudgetExceededError) {
        pushRecord(stage, "failed", before, start, "budget");
        throw new PlanStop({ stage, kind: "budget" });
      }
      if (error instanceof JudgeDeadlineExceededError) {
        pushRecord(stage, "failed", before, start, "deadline");
        throw new PlanStop({ stage, kind: "deadline" });
      }
      if (error instanceof JudgeCallLimitExceededError) {
        pushRecord(stage, "failed", before, start, "call-limit");
        throw new PlanStop({ stage, kind: "call-limit" });
      }
      pushRecord(stage, "failed", before, start, "unknown");
      throw error;
    }
    pushRecord(stage, "ok", before, start, null);
    return value;
  };

  /**
   * **次の実試行を始めてよいか**の門（Issue #432）。判定の実呼び出しの直前（判定の口の包み）と同じ基準で、
   * 段の外（再点検のあと・確認へ渡す前）でも照らす——締切を過ぎていれば `deadline`、総呼び出し数の上限に
   * **達していれば** `call-limit`（これから 1 回始めるので、`attempts >= limit` で拒む）。
   */
  const checkGate = (stage: PlanStageId): void => {
    if (gate.now() >= gate.deadline) throw new PlanStop({ stage, kind: "deadline" });
    if (gate.attempts() >= gate.limit) throw new PlanStop({ stage, kind: "call-limit" });
  };

  /**
   * **終わった時点で上限の内か**の門（Issue #432）。もう実試行を始めない場所（確定を返す前）で使う。
   * 締切の検査は残す——仕様の検査の間に締切を越えても `confirmed` を返さない。総呼び出し数は、共通の
   * 上限検査（`checkLimit`。`actual > max` を超過とする）と同じく **`attempts > limit` を超過**とする——
   * **上限ちょうどで正常に終わった Plan を、上限の停止と誤って報告しない。**
   */
  const checkGateAtEnd = (stage: PlanStageId): void => {
    if (gate.now() >= gate.deadline) throw new PlanStop({ stage, kind: "deadline" });
    if (gate.attempts() > gate.limit) throw new PlanStop({ stage, kind: "call-limit" });
  };

  /**
   * 目録の門の判定（要件 ID → 集計を含むか）を、既定の適用条件の事実として組む（Issue #408・#434）。
   * 門の答えが無い・Noul でない・範囲の外は `null`（判定できない＝閉じない）。問いの名前は、要件 ID と
   * 同じ組み立て（`catalogGateQuestionName`）で引き直す——事項 ID の接頭辞は解析しない。初回と差分で
   * 同じ関数を使う。
   */
  const recordAggregates = (reviewed: CatalogResult): void => {
    for (const facet of reviewed.unspecified) {
      if (aggregatesByRequirement.has(facet.requirementId)) continue;
      const gateName = catalogGateQuestionName(facet.requirementId);
      const judgment = reviewed.judgments.find(
        (candidate) => candidate.kind === "gate" && candidate.questionId === gateName,
      );
      const value = judgment?.value ?? null;
      aggregatesByRequirement.set(facet.requirementId, value === null ? null : value > 1 - threshold);
    }
  };

  /** 未指定の観点に、許可の表の既定が当たるときだけ値と理由を返す（仮適用と確定の両方で使う。Issue #419） */
  const defaultFor = (facet: UnspecifiedFacet): { readonly value: string; readonly reason: string } | undefined => {
    const catalogFacet = CATALOG_FACETS.find((candidate) => candidate.id === facet.facetId);
    if (catalogFacet === undefined) return undefined;
    return catalogDefaultOf(catalogFacet, {
      aggregates: aggregatesByRequirement.get(facet.requirementId) ?? null,
    });
  };

  /**
   * 目録の点検の結果から、P3 に渡す 3 つのデータを組む（Issue #419・#434）。**初回と差分で同じ関数**を
   * 使う——点検した対象・開いている事項・仮に適用した既定を、点検した分だけ組む（`reviewed.reviewed` は
   * 点検した要件の分だけになる）。値と理由はコードの定数（`defaultFor` の返す値と、表の理由）だけを
   * 使う。依頼文・答えの本文は渡さない。
   */
  const buildCatalogData = (reviewed: CatalogResult): SurfaceCatalogData => ({
    targets: reviewed.reviewed,
    openIssues: reviewed.unspecified.map((facet) => {
      const issue = catalogOpenIssue(facet);
      return { id: issue.id, requirementId: facet.requirementId, facetId: facet.facetId, text: issue.text };
    }),
    defaults: reviewed.unspecified.flatMap((facet) => {
      // 重大な事項は既定の対象にしない（Issue #408）
      if (facet.critical) return [];
      const applied = defaultFor(facet);
      if (applied === undefined) return [];
      return [
        {
          issueId: catalogOpenIssue(facet).id,
          requirementId: facet.requirementId,
          facetId: facet.facetId,
          value: applied.value,
          reason: applied.reason,
        },
      ];
    }),
  });

  const resultBase = (): PlanResultBase => ({
    stages: stages.slice(),
    spentUsd: budget.spentUsd,
    remainingUsd: budget.remainingUsd,
    judge: { calls_by_adapter: judgeBudget.callsByAdapter, cost_usd: judgeBudget.spentUsd },
    closedBySource: closedBySource.slice(),
    closedByDefault: closedByDefaults.slice(),
    requirementsDiagnosis,
    surfaceCheck: aggregateSurfaceCheck(),
    surfaceCheckDiagnostics: aggregateSurfaceCheckDiagnostics(),
    diffReviews: diffReviews.map(finalizeDiffReview),
    openIssueConflicts: buildOpenIssueConflicts(),
  });

  /**
   * 同じ ID の開いている事項の行の衝突で確定できない結果（Issue #460）。**値の中身を含まない**——理由は
   * 有限の分類（`session`・`duplicate-open-issue`）と欄の名前だけである。開いている事項は既存の
   * `cannot-confirm` と同じ形（開いている重大な事項）で載せる。`try` の外にも置けるよう、ここで組む。
   */
  const openIssueConflictResult = (): PlanResult => ({
    kind: "cannot-confirm",
    openIssues: openIssues.filter((issue) => issue.status === "open" && issue.critical),
    reasons: [{ source: "session", code: "duplicate-open-issue", path: "open_issues" }],
    ...resultBase(),
  });

  try {
    // ── P1 要件にする・P2 逆照合（① → ①'。落ちがあれば ① を 1 回だけやり直す）────────────
    const reverse = await runStageOutcome("requirements", async () => {
      const outcome = await runReverseCheckLoopWithOperation({
        source: input.source,
        documents: input.documents,
        gateway,
      });
      // 止まったときも、止まるまでに終えた往復の分を結果へ残す（Issue #430）
      requirementsDiagnosis = outcome.ok ? outcome.value.diagnosis : outcome.diagnosis;
      return outcome;
    });
    const list = reverse.list;
    // P1 の枠の文の範囲。**P6 の照合に渡し、枠の範囲も覆われていると数える**（Issue #372）。枠の文は
    // 要件にしないので、そのままでは原文が覆われていないと見なされて確定できない。
    const framing: SourceRange[] = (list.framing ?? []).map((entry) => entry.position);

    // ── 入力（原文）と、原文を覆う要件を組む ──────────────────────────────
    // 原文を文に切り、文ごとに 1 つの `source` の入力を作る（`checkSourceCoverage` が文と入力の本文を
    // 突き合わせるので、本文は文そのものにする）。要件の出どころは、その位置を覆う文の入力にする。
    const sentences = splitSourceSentences(input.source);
    const sourceInputs: PlanSourceInput[] = sentences.map((range, index) => ({
      id: `S-${index + 1}`,
      kind: "source",
      text: input.source.slice(range.start, range.end),
    }));
    const sourceInputFor = (position: SourceRange): string | undefined => {
      const covering =
        sentences.find((range) => range.start < position.end && position.start < range.end) ??
        sentences.find((range) => range.start <= position.start && position.start < range.end);
      if (covering !== undefined) return sourceInputs[sentences.indexOf(covering)]?.id;
      return sourceInputs[0]?.id;
    };

    const questionInputs: PlanQuestionInput[] = [];
    const answerInputs: PlanAnswerInput[] = [];
    const requirements: PlanRequirement[] = list.requirements.flatMap((requirement) => {
      const inputId = sourceInputFor(requirement.position);
      if (inputId === undefined) return [];
      return [
        {
          id: requirement.id,
          text: requirement.text,
          kind: "existence" as const,
          origin: { input_id: inputId, quote: requirement.quote },
          parts: [],
        },
      ];
    });
    const decisions: PlanDecision[] = list.decisions.map((decision, index) => ({
      id: `D-${index + 1}`,
      subject: "既定で決めた",
      value: decision,
      reason: "Plan が既定で決めた（確認の画面で直せる）",
    }));
    for (const [index, text] of list.unresolved.entries()) {
      addOpenIssue(
        { id: `OI:unresolved:${index + 1}`, text, critical: true, status: "open" },
        "unresolved",
      );
    }

    // P1 の逆照合で、引用が原文に無い・1 か所に決まらない要件が残っていれば、Plan を確定させない
    // （Issue #382）。`run.ts` は同じ落ちを未達として数える（⑦ の合否）。ここでも同じ扱いにする。
    const quoteMisses = quoteMissesOf(reverse.unmet);
    if (quoteMisses.length > 0) {
      const missIssues: PlanOpenIssue[] = quoteMisses.map((miss, index) => ({
        id: `OI:reverse:${index + 1}`,
        text: miss.detail,
        critical: true,
        status: "open",
      }));
      const critical = openIssues.filter((issue) => issue.status === "open" && issue.critical);
      return {
        kind: "cannot-confirm",
        openIssues: [...critical, ...missIssues],
        reasons: reverseCheckReasons(quoteMisses),
        ...resultBase(),
      };
    }

    // ── P3 目録の点検（語彙の決めどころ）。**P3 の洗い出しより先に回す**（Issue #419）────────
    const catalog = await runStage("catalog", () =>
      runCatalog({
        requirements: list.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
        judge: judgeBudget,
        source: input.source,
        threshold,
      }),
    );
    // 目録の門の判定を、既定の適用条件の事実として組む（Issue #408・#434。初回と差分で同じ関数）。
    recordAggregates(catalog);
    // P3 に渡す 3 つのデータを組む（Issue #419。初回と差分で同じ関数）。**ここでは決定も閉じた記録も
    // 作らない**——仮適用である。
    const catalogData: SurfaceCatalogData = buildCatalogData(catalog);

    // ── P3 洗い出し（目録に無い曖昧さ）──────────────────────────────
    const surface = await runStageOutcome("surface", () =>
      runSurface({ list, documents: input.documents, gateway, catalog: catalogData }),
    );
    for (const ambiguity of surface.ambiguities) {
      addOpenIssue(
        {
          id: ambiguity.id,
          text: ambiguity.text,
          critical: ambiguity.critical,
          status: "open",
        },
        "surface",
      );
    }
    // コードが目録から作った事項を、開いている事項に足す（04 §3・Issue #408）。**ID の接頭辞は解析
    // しない**——モデルが同じ形（`OI:catalog:`）の ID を作っても、この対応には入らないので既定の対象に
    // ならない（後で `applyDefaults` が重複として弾く）。
    for (const facet of catalog.unspecified) {
      const issue = catalogOpenIssue(facet);
      addOpenIssue(issue, "catalog");
      catalogIssueFacets.set(issue.id, facet);
    }

    // ── surface-check（P3 の「書けない」の申告を、確認の前に判定の口で点検する。Issue #432）──
    // 申告 1 件ずつを仕分け・裏付けし、**裏付けの取れた語彙の穴だけ**を了承除外の候補にする。判定は助言で
    // あり、点検は申告を減らす・止める方向にだけ効く。申告が 0 件なら判定を呼ばず、段を `ok` で残す
    // （`runSurfaceCheck` が早期に返す）。判定の予算が尽きれば、既存どおり段 `surface-check` の失敗
    // （`budget`）で止まる（`runStage` が `JudgeBudgetExceededError` を握る）。
    // 点検 1 回ぶんの記録を、開始時に積む（途中停止でも件数が残る。Issue #434）
    surfaceChecks.push({ accepted: 0, dropped: 0, ambiguity: 0, unchecked: 0, judgments: [], diagnostics: [], completed: false });
    const initialCheckIndex = surfaceChecks.length - 1;
    const surfaceCheck = await runStage("surface-check", async () => {
      const value = await runSurfaceCheck({
        surface,
        documents: input.documents,
        judge: judgeBudget,
        // 再点検の宛先（Luna）は、同じ予算で包んだ落とし先だけを使う（主を再点検に使わない。Issue #432）
        ...(judgeBudget.fallback === undefined ? {} : { recheckJudge: judgeBudget.fallback }),
        threshold,
        // 対象の要件の文（再点検の対象のデータ。Issue #432）
        requirements: new Map(requirements.map((requirement) => [requirement.id, requirement.text])),
        docVersion: input.vocabularyVersion,
        // 段の途中までに得た分類・判定・診断を、続く裏付けや再点検の予算が尽きても残す（Issue #432）。
        // 段が止まっても途中までの記録が結果と診断ファイルに載る（`completed` は false のまま）。
        onProgress: (partial) => {
          surfaceChecks[initialCheckIndex] = {
            accepted: partial.accepted.length,
            dropped: partial.dropped.length,
            ambiguity: partial.ambiguities.length,
            unchecked: partial.unchecked.length,
            judgments: partial.judgments,
            diagnostics: partial.diagnostics,
            completed: false,
          };
        },
      });
      // 再点検のあとにも、生成と共有する締切・総呼び出し数の門を守る（Issue #432）
      checkGate("surface-check");
      return value;
    });
    surfaceChecks[initialCheckIndex] = {
      accepted: surfaceCheck.accepted.length,
      dropped: surfaceCheck.dropped.length,
      ambiguity: surfaceCheck.ambiguities.length,
      unchecked: surfaceCheck.unchecked.length,
      judgments: surfaceCheck.judgments,
      diagnostics: surfaceCheck.diagnostics,
      completed: true,
    };
    // 曖昧さと判定された申告（了承除外になるはずだった部分）は、**重大な**開いている事項にして P4 に渡す。
    // 聞かずに落とさない。
    for (const claim of surfaceCheck.ambiguities) {
      addOpenIssue(
        {
          id: surfaceCheckOpenIssueId(initialCheckIndex + 1, claim.index),
          text: claim.part,
          critical: true,
          status: "open",
        },
        "surface-check",
      );
    }
    // 未点検が 1 件でも残れば、P4・確認に進まず「確定できない」。理由は値の中身を含まない（Issue #432）。
    if (surfaceCheck.unchecked.length > 0) {
      return {
        kind: "cannot-confirm",
        openIssues: openIssues.filter((issue) => issue.status === "open" && issue.critical),
        reasons: surfaceCheckReasons(surfaceCheck.unchecked, initialCheckIndex + 1),
        ...resultBase(),
      };
    }

    /**
     * 受理した申告を、了承して除く部分（`accepted_unwritable`）に写す（§4・U-P2。Issue #434 で初回と
     * 差分の共通の関数に切り出した）。代わりの案の要件を足し、加えた件数を返す。
     */
    const applyAcceptedUnwritable = (items: readonly PlanUnwritable[]): number => {
      let added = 0;
      for (const item of items) {
        const index = requirements.findIndex((requirement) => requirement.id === item.requirementId);
        const target = requirements[index];
        if (target === undefined) continue;
        const alternativeId = `R:alt:${item.id}`;
        const part: PlanPart = { id: `P:${item.id}`, text: item.part, disposition: "accepted_removal" };
        requirements[index] = { ...target, parts: [...target.parts, part] };
        requirements.push({
          id: alternativeId,
          text: item.alternative,
          kind: "existence",
          origin: { input_id: target.origin.input_id, quote: item.alternative },
          parts: [],
        });
        acceptedUnwritable.push({
          part_id: part.id,
          alternative_id: alternativeId,
          basis: {
            doc_version: input.vocabularyVersion,
            location: item.part,
            // 根拠の ID は**確認の前・SHA を計算する前**に正規化する（Issue #398）。
            // 確定済みの Plan を読み込むときに書き換えない（読み込みの側では正規化しない）。
            constraint_id: normalizeConstraintId(item.constraintIds[0] ?? ""),
          },
        });
        // 受理した申告の控えを残す（対象外の再申告を、安全に証明できる重複としてだけ除く。Issue #434・D3）
        acceptedClaimSnapshots.push({
          requirementId: item.requirementId,
          partId: part.id,
          part: item.part,
          reason: item.reason,
          alternative: item.alternative,
          alternativeId,
          constraintIds: item.constraintIds.slice(),
          requirementText: target.text,
          changeKey: diffChangeKey(target),
          docVersion: input.vocabularyVersion,
        });
        added += 1;
      }
      return added;
    };

    // 受理した申告（語彙の穴で裏付けが取れたもの）だけを、了承して除く部分（`accepted_unwritable`）に写す
    // （§4・U-P2）。落とした申告・曖昧さと判定した申告の要件は**そのまま残す**（Build が書く）。代わりの案は、
    // 宣言で書ける近い形を 1 つ出したものなので、要件として残し、部分から代わりの案の ID で指す。
    // **初回と差分で同じ関数**を使う（Issue #434）。
    const acceptedUnwritable: PlanAcceptedUnwritable[] = [];
    applyAcceptedUnwritable(surfaceCheck.accepted);

    // ── 往復（P4 質問 → 次の一歩 → P5 答えの反映）────────────────────────
    const turns: PlanTurn[] = [];
    const priorAnswers: ClassifiedAnswer[] = [];
    const askedQuestionIds = new Set<string>();
    let followUpQuestions: readonly PlanQuestion[] = [];
    /** 既定で決めたこと（確認の画面が「既定で決めたこと」を出すための並び。Issue #408） */
    const defaultDecisions: PlanDecision[] = [];

    const planDraft = () => ({
      schema_version: PLAN_SPEC_SCHEMA_VERSION,
      plan_id: input.planId,
      revision,
      vocabulary_version: input.vocabularyVersion,
      inputs: [...sourceInputs, ...questionInputs, ...answerInputs] as readonly PlanInput[],
      requirements: requirements as readonly PlanRequirement[],
      open_issues: openIssues as readonly PlanOpenIssue[],
      decisions,
      accepted_unwritable: acceptedUnwritable,
    });
    const confirmationView = (): PlanConfirmationView => ({
      plan: planDraft(),
      diff: requirements.flatMap((requirement): readonly PlanChange[] =>
        requirement.change === undefined ? [] : [requirement.change],
      ),
      unwritable: acceptedUnwritable,
      // 既定で決めたこと（ID の接頭辞では見分けない。下書きの並びから出す。Issue #408）
      closedByDefault: defaultDecisions.slice(),
    });

    /**
     * 解決の対象（同じ ID の open の行）を 1 つに取る（Issue #460）。open の行がちょうど 1 行ならその位置を
     * 返す。0 行なら何も閉じず件数を記録して `undefined`。2 行以上なら ID だけで閉じず（畳まない・
     * まとめて閉じない）、問いを出す前の停止で先に止まる設計だが、到達したら不変条件の破れとして同じ理由で
     * 止める（`undefined` を返さずに投げる）。
     */
    const resolveTargetIndex = (issueId: string): number | undefined => {
      const target = resolveTargetOf(openIssues, issueId);
      if (target.kind === "none") {
        emptyResolveTargets += 1;
        return undefined;
      }
      if (target.kind === "multiple") throw new PlanOpenIssueConflictStop();
      return target.index;
    };

    const resolveIssue = (issueId: string, answerId: string): void => {
      const index = resolveTargetIndex(issueId);
      const issue = index === undefined ? undefined : openIssues[index];
      if (index === undefined || issue === undefined) return;
      openIssues[index] = { ...issue, status: "resolved", resolution: { answer_id: answerId } };
    };

    /** 問いの主の事項と、一緒に閉じる事項（`alsoCloses`）を、同じ答えの ID で閉じる（04 §3 P4） */
    const resolveQuestionIssues = (question: PlanQuestion, answerId: string): void => {
      resolveIssue(question.openIssueId, answerId);
      for (const id of alsoClosesOf(question)) resolveIssue(id, answerId);
    };

    /**
     * 答えの、問いが指した事項の集合（主の事項と `alsoCloses`）と、答え由来の要件を控える（Issue #461）。
     * 引き継ぎの判定は、この控えと、目録の対応・決定・閉じた記録だけを使う。
     */
    const recordAnswerContext = (answerId: string, question: PlanQuestion, requirementText: string): void => {
      answerIssueIds.set(answerId, [question.openIssueId, ...alsoClosesOf(question)]);
      answerDerivedRequirements.push({ id: `R:${answerId}`, text: requirementText });
    };

    /** 依頼文で閉じた事項を、聞かずに決めたこと（`decisions`）にして閉じる（04 §3 P4・Issue #370） */
    const applySourceClosure = (closure: PlanSourceClosure): void => {
      const index = resolveTargetIndex(closure.issueId);
      const issue = index === undefined ? undefined : openIssues[index];
      if (index === undefined || issue === undefined) return;
      const decisionId = `${SOURCE_CLOSURE_DECISION_PREFIX}${closure.issueId}`;
      decisions.push({
        id: decisionId,
        subject: issue.text,
        value: closure.value,
        reason: closure.quote,
      });
      closureDecisionIds.set(closure.issueId, decisionId);
      openIssues[index] = {
        ...issue,
        status: "resolved",
        resolution: { decision_id: decisionId, reason: closure.quote },
      };
    };

    /**
     * 許可の表の既定で、未指定の事項のうち適用条件に合う**重大でない**ものを閉じる（04 §3「既定で
     * 決めてよいものは聞かない」・Issue #408）。**最初の往復を含め、各往復で P4 の要否を決める前に**
     * 呼ぶ。閉じた事項は P4 の材料に含めず、問数・往復も消費しない。
     *
     * 対象は、**コードが目録から作った事項**（`catalogIssueFacets`）だけである。モデルが同じ形
     * （`OI:catalog:`）の ID を作った事項・重複した ID の事項・重大な事項は対象にしない。適用条件は、
     * 目録の判定の結果（要件ごとの門の判定）だけを見る。**表の外の事項（権限・自由文・矛盾の再質問・
     * P1 の未解決）は閉じない。**
     */
    const applyDefaults = (): void => {
      const counts = new Map<string, number>();
      for (const issue of openIssues) counts.set(issue.id, (counts.get(issue.id) ?? 0) + 1);
      for (const [issueId, facet] of catalogIssueFacets) {
        // 重複した ID は既定の対象にしない（同じ ID の事項が 2 つ以上ある）
        if ((counts.get(issueId) ?? 0) !== 1) continue;
        const index = openIssues.findIndex((issue) => issue.id === issueId && issue.status === "open");
        const issue = openIssues[index];
        // 重大な事項は既定の対象にしない
        if (issue === undefined || issue.critical) continue;
        const applied = defaultFor(facet);
        // 表に無い観点・適用条件に合わない（no-match）・判定できない（unknown）は閉じない
        if (applied === undefined) continue;
        const decisionId = defaultDecisionId(issueId);
        const reason = `${applied.reason}（観点: ${facet.facetId}）`;
        const decision: PlanDecision = { id: decisionId, subject: issue.text, value: applied.value, reason };
        decisions.push(decision);
        defaultDecisions.push(decision);
        openIssues[index] = { ...issue, status: "resolved", resolution: { decision_id: decisionId, reason } };
        closedByDefaults.push({ issueId, facetId: facet.facetId, value: applied.value });
        closureDecisionIds.set(issueId, decisionId);
      }
    };

    /** 参照用の文脈に載せる、関係する問いと答え（差分の判定に要る文脈。Issue #434） */
    const relatedQuestionsAndAnswers = (
      allInputs: readonly PlanInput[],
    ): readonly SurfaceContextQuestionAnswer[] => {
      const questionMap = new Map(
        allInputs
          .filter((one): one is PlanQuestionInput => one.kind === "question")
          .map((question) => [question.id, question]),
      );
      const entries: SurfaceContextQuestionAnswer[] = [];
      for (const answer of allInputs) {
        if (answer.kind !== "answer") continue;
        const question = questionMap.get(answer.question_id);
        if (question === undefined) continue;
        const answerText =
          answer.choice_id !== undefined
            ? question.choices.find((choice) => choice.id === answer.choice_id)?.text ?? answer.choice_id
            : answer.free_text ?? "";
        entries.push({ questionId: question.id, question: question.text, answerId: answer.id, answer: answerText });
      }
      return entries;
    };

    /**
     * その往復の P5 のあと（「全部推奨で進める」の道を含む）、**その往復で増えた・変わった要件だけ**を
     * 目録・洗い出し・申告の点検に掛ける（Issue #434）。対象は `selectDiffRequirements` で選ぶ
     * （`changed`・`removed` は元の要件 ID を引く。引けなければ確定させない側に倒す）。判定に要る文脈
     * （点検時点の全要件・既存の決定・了承除外・関係する問いと答え）は**参照用のデータ**として渡し、
     * 応答が指す要件 ID は**この往復の差分の集合**へ照合する。新しく開いた事項・了承除外は、既存の既定の
     * 適用と P4 の流れに載る（`turns` に積んだあとに呼ぶ）。未点検の申告が残れば「確定できない」を返す。
     * **対象が 0 件なら、どの段も呼ばず `undefined`**。
     */
    const reviewAddedRequirements = async (): Promise<PlanResult | undefined> => {
      const unreviewedChanges = requirements.filter((requirement) => {
        const key = diffChangeKey(requirement);
        return key !== undefined && !reviewedDiffKeys.has(key);
      });
      if (unreviewedChanges.length === 0) return undefined;
      // 差分点検 1 回ぶんの記録を、**開始時に積む**——途中で止まった往復も数えられる（Issue #434）
      const reviewRecord: MutableDiffReview = {
        round: turns.length,
        added: unreviewedChanges.length,
        openIssues: 0,
        acceptedUnwritable: 0,
        // 形が正しい応答を走査できたときだけ真にする（未照合と真の 0 件を区別する。D1）
        scanned: false,
        claims: 0,
        ambiguities: 0,
        deduped: 0,
        rejectedClaims: 0,
        rejectedAmbiguities: 0,
        kinds: new Map(),
        dedupedIndexes: [],
        inheritKinds: new Map(),
        inheritNoParent: 0,
        inheritMultipleParents: 0,
        inheritMisses: new Map(),
        openBySource: new Map(),
      };
      diffReviews.push(reviewRecord);

      // 対象（この往復で増えた・変わった要件）を選ぶ。変更・削除が指す元の要件を解決できなければ、
      // 勝手に点検の対象を作らず、確定させない側に倒す（Issue #434）
      const selection = selectDiffRequirements(requirements, reviewedDiffKeys);
      if (selection.kind === "unresolved") {
        return {
          kind: "cannot-confirm",
          openIssues: openIssues.filter((issue) => issue.status === "open" && issue.critical),
          reasons: [{ source: "plan-check", code: "unknown_reference", path: "requirements" }],
          ...resultBase(),
        };
      }
      const diff = selection.targets;
      for (const requirement of diff) {
        const key = diffChangeKey(requirement);
        if (key !== undefined) reviewedDiffKeys.add(key);
      }
      // この往復の差分の要件 ID の集合（応答が指す要件 ID を照合する。Issue #434）
      const targetRequirementIds = new Set(diff.map((requirement) => requirement.id));

      /** 対象外の参照を、内部の対応で有限の分類に写す（Issue #434。モデルに選ばせない） */
      const classifyOutOfScope = (requirementId: string): DiffOutOfScopeKind => {
        const matches = requirements.filter((requirement) => requirement.id === requirementId);
        // 存在しない ID と、存在するが分類できない ID を混同しない（§3）
        if (matches.length === 0) return "unknown";
        if (matches.length !== 1) return "unclassified";
        // 代案（accepted_unwritable の参照）を先に見る——代案の origin は元の要件から継承される（§3）
        if (acceptedUnwritable.some((entry) => entry.alternative_id === requirementId)) return "alternative";
        const requirement = matches[0];
        if (requirement === undefined) return "unclassified";
        const inputId = requirement.origin.input_id;
        if (sourceInputs.some((source) => source.id === inputId)) return "source";
        if (answerInputs.some((answer) => answer.id === inputId)) return "previous-answer";
        return "unclassified";
      };
      /** 対象外の参照 1 つを、分類別の件数に数える */
      const bumpKind = (kind: DiffOutOfScopeKind, ref: SurfaceOutOfScopeRef, count: number): void => {
        const current = reviewRecord.kinds.get(kind) ?? { claims: 0, ambiguities: 0 };
        if (ref.kind === "claim") current.claims += count;
        else current.ambiguities += count;
        reviewRecord.kinds.set(kind, current);
      };
      /**
       * 対象外の「書けない」の申告が、**受理済みの申告の正確な再申告**か（§3 の 2・3。Issue #434）。
       * 判定は純粋な関数 `isAcceptedUnwritableDuplicate` が行う。
       */
      const isAcceptedDuplicateClaim = (claim: PlanUnwritable): boolean =>
        isAcceptedUnwritableDuplicate({
          claim,
          requirements,
          acceptedUnwritable,
          snapshots: acceptedClaimSnapshots,
          docVersion: input.vocabularyVersion,
        });

      const inputsNow: readonly PlanInput[] = [...sourceInputs, ...questionInputs, ...answerInputs];
      const textOf = (requirement: PlanRequirement): string =>
        requirementTextWithQuestionContext(requirement, inputsNow, openIssues);

      // ── 差分の目録（対象は差分だけ。Issue #434）────────────────────────
      const diffCatalog = await runStage("catalog", () =>
        runCatalog({
          requirements: diff.map((requirement) => ({ id: requirement.id, text: textOf(requirement) })),
          judge: judgeBudget,
          source: input.source,
          threshold,
        }),
      );
      recordAggregates(diffCatalog);

      // ── 引き継ぐ観点を決める（Issue #461）──────────────────────────────
      // 答えから生まれた要件について、その答えが解いた観点と、親の要件で答え・依頼文・既定・引き継ぎで
      // 決まっている観点を、コードが持つ対応と一意に引けた根拠だけで引き継ぐ。引き継いだ観点は、開いた
      // 事項として足さず・既定の対応にも入れず・P4 に渡さない（答え直後の連鎖を止める）。根拠が引けない
      // 観点は今までどおり開く（分類と件数だけ記録に残す）。
      const appliedInheritance: { facet: InheritedFacet; diffFacet: UnspecifiedFacet }[] = [];
      const inheritedSkip = new Set<string>();
      const inheritanceMisses = new Map<InheritFacetMissKind, number>();
      const inheritanceKinds = new Map<string, number>();
      let inheritanceNoParent = 0;
      let inheritanceMultipleParents = 0;
      for (const requirement of diff) {
        const change = requirement.change;
        if (change === undefined || change.kind !== "added") continue;
        const answerId = change.answer_id;
        // 答えから生まれた要件（`R:<答えの ID>`）だけを対象にする
        if (requirement.id !== `R:${answerId}`) continue;
        const result = inheritFacetsForAnswer({
          answerId,
          issueIds: answerIssueIds.get(answerId) ?? [],
          issues: openIssues.map((issue) => ({
            id: issue.id,
            status: issue.status,
            ...(issue.resolution === undefined ? {} : { resolution: issue.resolution }),
          })),
          catalogFacets: [...catalogIssueFacets.entries()].map(([issueId, facet]) => ({
            issueId,
            requirementId: facet.requirementId,
            facetId: facet.facetId,
          })),
          answerRequirements: answerDerivedRequirements.slice(),
          decisions: decisions.map((decision) => ({ id: decision.id, value: decision.value })),
          defaultClosures: closedByDefaults.map((closure) => ({
            issueId: closure.issueId,
            facetId: closure.facetId,
            decisionId: closureDecisionIds.get(closure.issueId) ?? "",
            value: closure.value,
          })),
          sourceClosures: closedBySource.map((closure) => ({
            issueId: closure.issueId,
            decisionId: closureDecisionIds.get(closure.issueId) ?? "",
            value: closure.value,
          })),
          previous: [...inheritedFacetTable.entries()].map(([issueId, entry]) => ({
            issueId,
            requirementId: entry.requirementId,
            facetId: entry.facetId,
            decisionId: entry.decisionId,
            value: entry.value,
          })),
        });
        inheritanceNoParent += result.noParent;
        inheritanceMultipleParents += result.multipleParents;
        for (const miss of result.unresolved) {
          inheritanceMisses.set(miss.kind, (inheritanceMisses.get(miss.kind) ?? 0) + miss.count);
        }
        for (const facet of result.facets) {
          const key = `${requirement.id}\u0000${facet.facetId}`;
          if (inheritedSkip.has(key)) continue;
          // 目録が開かなかった観点は、引き継ぐ対象（開き直す事項）が無い
          const diffFacet = diffCatalog.unspecified.find(
            (candidate) => candidate.requirementId === requirement.id && candidate.facetId === facet.facetId,
          );
          if (diffFacet === undefined) continue;
          inheritedSkip.add(key);
          appliedInheritance.push({ facet, diffFacet });
          inheritanceKinds.set(
            `${facet.kind}\u0000${facet.facetId}`,
            (inheritanceKinds.get(`${facet.kind}\u0000${facet.facetId}`) ?? 0) + 1,
          );
        }
      }
      for (const [kind, count] of inheritanceMisses) {
        reviewRecord.inheritMisses.set(kind, (reviewRecord.inheritMisses.get(kind) ?? 0) + count);
      }
      for (const [key, count] of inheritanceKinds) {
        reviewRecord.inheritKinds.set(key, (reviewRecord.inheritKinds.get(key) ?? 0) + count);
      }
      reviewRecord.inheritNoParent += inheritanceNoParent;
      reviewRecord.inheritMultipleParents += inheritanceMultipleParents;
      const effectiveUnspecified = diffCatalog.unspecified.filter(
        (facet) => !inheritedSkip.has(`${facet.requirementId}\u0000${facet.facetId}`),
      );
      const diffCatalogData = buildCatalogData({ ...diffCatalog, unspecified: effectiveUnspecified });

      // 引き継いだ観点の**根拠の決定**を、この往復の P3 の参照用文脈にも載せる（Issue #461・F2）。
      // 決定の実体（事項の文・値・理由）はここで組み、diff の点検が終わってから `decisions` と
      // `openIssues` に足す——**この往復の P3 には参照用の文脈として渡す**（決定そのものはここで 1 つに組む）。
      const inheritDecisions = appliedInheritance.map(({ facet, diffFacet }) => {
        const issue = catalogOpenIssue(diffFacet);
        const decisionId = `${INHERIT_DECISION_PREFIX}${issue.id}`;
        const reason = `${INHERIT_DECISION_REASON}（親の事項: ${facet.sourceIssueId}）`;
        const decision: PlanDecision = { id: decisionId, subject: issue.text, value: facet.value, reason };
        return { facet, diffFacet, issue, decisionId, reason, decision };
      });

      // ── 差分の洗い出し（対象は差分だけ。文脈は参照用のデータで渡す。Issue #434）────
      const diffList: RequirementList = {
        requirements: diff.map((requirement) => ({
          id: requirement.id,
          text: textOf(requirement),
          quote: requirement.origin.quote,
          // 位置は無いので、確定した仕様を正本にするときと同じ（0〜0）扱いにする（Issue #434）
          position: { start: 0, end: 0 },
          parts: requirement.parts.map((part) => ({
            id: part.id,
            text: part.text,
            disposition: part.disposition,
          })),
        })),
        decisions: [],
        unresolved: [],
      };
      const context: SurfaceContext = {
        requirements: requirements.map((requirement) => ({
          id: requirement.id,
          text: textOf(requirement),
          origin: requirement.origin.input_id,
        })),
        decisions: [...decisions, ...inheritDecisions.map((entry) => entry.decision)],
        acceptedUnwritable: acceptedUnwritable.slice(),
        questionsAndAnswers: relatedQuestionsAndAnswers(inputsNow),
      };
      // 対象外の照合と記録は、**形が正しい応答**について、制約 ID の裏付けの検査より前に済ませる
      // ——制約検査で失敗を返すときも、対象外の集合・分類・識別済みの件数を記録に残す（D1）。
      // 対象外の「書けない」の申告は、**受理済みの申告の正確な再申告だけ**を重複として除く
      // （曖昧さは除かない。§3 の 5）
      let targetCheck: SurfaceTargetResult | undefined;
      const evaluateTargets = (surface: PlanSurface): void => {
        const target = checkSurfaceTargets(surface, targetRequirementIds, (claim) =>
          isAcceptedDuplicateClaim(claim),
        );
        targetCheck = target;
        for (const ref of target.rejected) {
          const requirementId = ref.kind === "claim" ? ref.claim.requirementId : ref.ambiguity.requirementId;
          bumpKind(classifyOutOfScope(requirementId), ref, 1);
          if (ref.kind === "claim") reviewRecord.rejectedClaims += 1;
          else reviewRecord.rejectedAmbiguities += 1;
        }
        for (const item of target.dropped) {
          bumpKind(
            classifyOutOfScope(item.claim.requirementId),
            { kind: "claim", index: item.index, claim: item.claim },
            1,
          );
          reviewRecord.deduped += 1;
          reviewRecord.dedupedIndexes.push(item.index);
        }
        reviewRecord.claims = target.dropped.length + target.rejected.filter((ref) => ref.kind === "claim").length;
        reviewRecord.ambiguities = target.rejected.filter((ref) => ref.kind === "ambiguity").length;
        reviewRecord.scanned = true;
      };
      const diffSurface = await runStageOutcome("surface", async () => {
        const outcome = await runSurface({
          list: diffList,
          documents: input.documents,
          gateway,
          catalog: diffCatalogData,
          context,
          onShapeValid: evaluateTargets,
        });
        // 形の失敗・制約検査の失敗のどちらも、対象外の記録は evaluateTargets で済んでいる（D1）
        if (!outcome.ok) return outcome;
        if (targetCheck === undefined) return outcome;
        if (targetCheck.problems.length > 0) {
          return {
            ok: false as const,
            failure: { kind: "unmet" as const, attempts: 1, problems: targetCheck.problems },
          };
        }
        const value =
          targetCheck.dropped.length === 0
            ? outcome.value
            : { ...outcome.value, unwritable: targetCheck.keptUnwritable };
        return { ok: true as const, value };
      });
      reviewRecord.openIssues = diffSurface.ambiguities.length + effectiveUnspecified.length;
      reviewRecord.openBySource.set("catalog", effectiveUnspecified.length);
      reviewRecord.openBySource.set("surface", diffSurface.ambiguities.length);
      for (const ambiguity of diffSurface.ambiguities) {
        addOpenIssue({ id: ambiguity.id, text: ambiguity.text, critical: ambiguity.critical, status: "open" }, "surface");
      }
      // コードが目録から作った事項を、開いている事項に足す（`catalogIssueFacets` にも入れて既定の対象にする）。
      // **引き継いだ観点はここに入れない**——開いた事項として足さず、既定の対応にも入れない（Issue #461）。
      for (const facet of effectiveUnspecified) {
        const issue = catalogOpenIssue(facet);
        addOpenIssue(issue, "catalog");
        catalogIssueFacets.set(issue.id, facet);
      }
      // 引き継いだ観点を、確定した仕様に**根拠つきで**残す（既定・依頼文で閉じる処理と同じ型。Issue #461）。
      // 根拠の決定を 1 つ作り（値は元の解決の値そのもの）、事項を状態 resolved で足す。行を足す経路
      // （`addOpenIssue`）を通すので、同じ ID の行が既にあれば畳まず、#460 の衝突として記録される。
      for (const { facet, diffFacet, issue, decisionId, reason, decision } of inheritDecisions) {
        decisions.push(decision);
        inheritedFacetTable.set(issue.id, {
          requirementId: diffFacet.requirementId,
          facetId: facet.facetId,
          decisionId,
          value: facet.value,
        });
        addOpenIssue({ ...issue, status: "resolved", resolution: { decision_id: decisionId, reason } }, "catalog");
      }

      // ── 差分の申告の点検（F1 と同じ条件・同じ規則で掛ける。Issue #432・#434）──────
      // 点検 1 回ぶんの記録を、開始時に積む（途中停止でも件数・診断が残る。Issue #434）
      surfaceChecks.push({ accepted: 0, dropped: 0, ambiguity: 0, unchecked: 0, judgments: [], diagnostics: [], completed: false });
      const diffCheckIndex = surfaceChecks.length - 1;
      const diffSurfaceCheck = await runStage("surface-check", async () => {
        const value = await runSurfaceCheck({
          surface: diffSurface,
          documents: input.documents,
          judge: judgeBudget,
          ...(judgeBudget.fallback === undefined ? {} : { recheckJudge: judgeBudget.fallback }),
          threshold,
          requirements: new Map(requirements.map((requirement) => [requirement.id, requirement.text])),
          docVersion: input.vocabularyVersion,
          // 段の途中までに得た分類・判定・診断を、裏付けや再点検の予算が尽きても残す（Issue #432・#434）
          onProgress: (partial) => {
            surfaceChecks[diffCheckIndex] = {
              accepted: partial.accepted.length,
              dropped: partial.dropped.length,
              ambiguity: partial.ambiguities.length,
              unchecked: partial.unchecked.length,
              judgments: partial.judgments,
              diagnostics: partial.diagnostics,
              completed: false,
            };
          },
        });
        checkGate("surface-check");
        return value;
      });
      surfaceChecks[diffCheckIndex] = {
        accepted: diffSurfaceCheck.accepted.length,
        dropped: diffSurfaceCheck.dropped.length,
        ambiguity: diffSurfaceCheck.ambiguities.length,
        unchecked: diffSurfaceCheck.unchecked.length,
        judgments: diffSurfaceCheck.judgments,
        diagnostics: diffSurfaceCheck.diagnostics,
        completed: true,
      };
      reviewRecord.openIssues += diffSurfaceCheck.ambiguities.length;
      reviewRecord.openBySource.set("surface-check", diffSurfaceCheck.ambiguities.length);
      // 曖昧さと判定された申告は、**重大な**開いている事項にして P4 に渡す（聞かずに落とさない）
      for (const claim of diffSurfaceCheck.ambiguities) {
        addOpenIssue(
          {
            id: surfaceCheckOpenIssueId(diffCheckIndex + 1, claim.index),
            text: claim.part,
            critical: true,
            status: "open",
          },
          "surface-check",
        );
      }
      // 未点検が残れば確定できない（理由は値の中身を含まない。点検の番号つき。Issue #432・#434）
      if (diffSurfaceCheck.unchecked.length > 0) {
        return {
          kind: "cannot-confirm",
          openIssues: openIssues.filter((issue) => issue.status === "open" && issue.critical),
          reasons: surfaceCheckReasons(diffSurfaceCheck.unchecked, diffCheckIndex + 1),
          ...resultBase(),
        };
      }
      // 受理した申告だけを了承除外と代わりの案にする
      reviewRecord.acceptedUnwritable = applyAcceptedUnwritable(diffSurfaceCheck.accepted);
      return undefined;
    };

    for (;;) {
      // 同じ ID の行の衝突は、**既定の適用と P4 を行う前に**有限の理由で止める（Issue #460）。同じ ID の
      // 行が 2 つある仕様は確定に至らないので、早く止めても失うものは無い。
      if (conflictIds.size > 0) return openIssueConflictResult();
      // 表の既定で閉じるのは、**P4 の要否を決める前**（最初の往復を含む。Issue #408）
      applyDefaults();
      const open = openIssues.filter((issue) => issue.status === "open");
      const preRemaining = remainingPlanBudget(turns);
      // 「全部推奨で進める」は**そのとき提示した束への答え**であり、走り全体のラッチにしない（Issue #434）。
      // 差分点検で新しい事項が開いた場合は、それまでの答えと消費した問数を保ったまま、新しい束を作る。
      const willAsk = open.length > 0 && preRemaining.questions > 0 && preRemaining.roundTrips > 0;

      let questions: readonly PlanQuestion[] = [];
      if (willAsk) {
        const generated = await runStageOutcome("questions", () =>
          runQuestions({
            source: input.source,
            openIssues: open,
            remaining: preRemaining.questions,
            revision,
            documents: input.documents,
            gateway,
          }),
        );
        // 依頼文で決まっている事項は、**次の一歩を決める前に**反映する（聞かずに閉じる。04 §3 P4）
        for (const closure of generated.closedBySource) {
          closedBySource.push(closure);
          applySourceClosure(closure);
        }
        // 前の往復の矛盾から組み立てた問い（まだ未解決の事項に対応するものだけ）を足す（§6 の 7）。
        // 通常の問いの ID は、コードが `Q<版>-<n>` に組み直す（LLM の ID は仕様の ID にしない。Issue #405）。
        // 矛盾の再質問は、すでに答えの ID から組んであるのでその形のまま（`n` に数えない）
        const openIds = new Set(openIssues.map((issue) => issue.id));
        const carried = followUpQuestions.filter((question) => openIds.has(question.openIssueId));
        questions = [...assignQuestionIds(generated.questions, revision), ...carried];
      }

      // 確認の画面に出す下書きは、依頼文で閉じた分を反映した**後**に組む（閉じた事項を載せるため）
      const view = confirmationView();
      const step = nextPlanStep({
        source: input.source,
        turns,
        openIssues,
        questions,
        view,
      });
      if (step.kind === "cannot-confirm") {
        return {
          kind: "cannot-confirm",
          openIssues: step.openIssues,
          reasons: [sessionCannotConfirmReason(turns, openIssues)],
          ...resultBase(),
        };
      }
      if (step.kind === "confirm") {
        // 確認へ渡す前にも、生成と共有する締切・総呼び出し数の門を守る（Issue #432）
        checkGate("confirm");
        const decision = await input.responder.confirm(view);
        if (decision === "stop") {
          return { kind: "stopped", reason: "declined", failure: null, ...resultBase() };
        }
        break;
      }

      // ── 質問を出す（P4）。残りの問数の範囲だけを出す ────────────────────
      const asked = step.questions;
      for (const question of asked) {
        if (askedQuestionIds.has(question.id)) {
          // 一意化のあとで重なりは起きない。起きたら**黙って捨てず**、段の失敗として止める（Issue #405）
          throw new PlanStop({ stage: "questions", kind: "unknown" });
        }
        askedQuestionIds.add(question.id);
        questionInputs.push(toQuestionInput(question));
      }

      const answer = await input.responder.answer({ questions: asked, remaining: step.remaining });

      if (answer.kind === "all-recommended") {
        // 「全部推奨で進める」——提示した問いをすべて推奨で閉じ、次の往復（差分点検で開いた事項があれば）
        // へ進む（§2・Issue #434）。新しい事項まで推奨を採ったことにしない。
        const drafts: PlanAnswerDraft[] = [];
        for (const question of asked) {
          const recommended = question.recommended;
          if (recommended === undefined) continue;
          const answerId = `A:${question.id}`;
          answerInputs.push({
            id: answerId,
            kind: "answer",
            question_id: question.id,
            choice_id: recommended.choiceId,
          });
          const choice = question.choices.find((candidate) => candidate.id === recommended.choiceId);
          const requirementText = choice?.text ?? recommended.reason;
          requirements.push(answerRequirement(answerId, requirementText));
          resolveQuestionIssues(question, answerId);
          recordAnswerContext(answerId, question, requirementText);
          drafts.push({ id: answerId, questionId: question.id, revision, choiceId: recommended.choiceId });
        }
        turns.push({ questions: asked, answers: drafts });
        revision += 1;
        // その往復で増えた要件だけを差分点検する（Issue #434）
        const stopped = await reviewAddedRequirements();
        if (stopped !== undefined) return stopped;
        continue;
      }

      // ── 答えを反映する（P5）。コードで断った答えは要件にしない。ID は組み直したものを使う ──────
      const rebuiltAnswers = rebuildAnswerIds(asked, answer.answers, revision, input.freeTextMax);
      const answerResult = await runStage("answers", () =>
        runAnswers({
          questions: asked,
          answers: rebuiltAnswers,
          revision,
          source: input.source,
          priorAnswers,
          judge: judgeBudget,
          ...(input.freeTextMax === undefined ? {} : { freeTextMax: input.freeTextMax }),
        }),
      );
      const byId = new Map(rebuiltAnswers.map((draft) => [draft.id, draft]));
      for (const accepted of answerResult.accepted) {
        const draft = byId.get(accepted.answerId);
        const question = asked.find((candidate) => candidate.id === accepted.questionId);
        if (draft === undefined || question === undefined) continue;
        const text = requirementTextOf(accepted, question);
        if (text === "") continue;
        const answerInput = toAnswerInput(draft);
        if (answerInput === undefined) continue;
        answerInputs.push(answerInput);
        requirements.push(answerRequirement(draft.id, text));
        resolveQuestionIssues(question, draft.id);
        recordAnswerContext(draft.id, question, text);
        priorAnswers.push(accepted);
      }
      // 矛盾から組み立てた問いを、次の往復に回す（§6 の 7）。対応する未解決の事項を開いておく
      for (const followUp of answerResult.followUpQuestions) {
        if (!openIssues.some((issue) => issue.id === followUp.openIssueId)) {
          addOpenIssue(
            { id: followUp.openIssueId, text: followUp.text, critical: true, status: "open" },
            "contradiction",
          );
        }
      }
      followUpQuestions = answerResult.followUpQuestions;
      turns.push({ questions: asked, answers: rebuiltAnswers });
      revision += 1;
      // その往復で増えた要件だけを差分点検する（Issue #434）
      const stopped = await reviewAddedRequirements();
      if (stopped !== undefined) return stopped;
    }

    // ── P6 照合と確定。**`checkConfirmedPlan` を通ったものだけ**を「確定した」として返す ──────
    const confirmed = await runStage("confirm", () =>
      runConfirm({
        planId: input.planId,
        revision,
        vocabularyVersion: input.vocabularyVersion,
        source: input.source,
        framing,
        inputs: [...sourceInputs, ...questionInputs, ...answerInputs],
        requirements,
        openIssues,
        decisions,
        acceptedUnwritable,
        confirmedBy: input.confirmedBy,
        confirmedAt: new Date(input.now()).toISOString(),
        judge: judgeBudget,
        threshold,
      }),
    );
    const problems = await checkConfirmedPlan(confirmed.plan);
    if (!confirmed.confirmed || problems.length > 0) {
      // 確定できなかった理由を全件残す（P6 の覆い・確定した仕様の検査。値の中身は含めない。Issue #397）。
      // `planProblems`（P6 の中の検査）と `problems`（外側の検査）の重なりは、同じ source・code・path
      // の組で 1 件にまとめる（`path` が違えば別件）。
      return {
        kind: "cannot-confirm",
        openIssues: openIssues.filter((issue) => issue.status === "open" && issue.critical),
        reasons: [
          ...confirmReasons(confirmed.problems),
          ...planCheckReasons([...confirmed.planProblems, ...problems]),
        ],
        ...resultBase(),
      };
    }
    // **確定を返す前にも**、生成と共有する締切の門を守る（Issue #432）。P6 の判定が締切を越えて返る経路は
    // 包みが止めるが、仕様の検査の間にも時計は進む——締切後に `confirmed` を返さないよう、ここでも照らす。
    // 総呼び出し数は「終わった時点で上限の内か」で見る（上限ちょうどで正常に終わった Plan を、上限の停止と
    // 誤って報告しない。次の試行を始めてよいかの判定とは別）。
    checkGateAtEnd("confirm");
    return { kind: "confirmed", plan: confirmed.plan, ...resultBase() };
  } catch (error) {
    // 同じ ID の open の行が 2 つ以上あるのに解決しようとした（不変条件の破れ。Issue #460）。
    // 問いを出す前の衝突の停止と同じ理由で止める。
    if (error instanceof PlanOpenIssueConflictStop) return openIssueConflictResult();
    if (error instanceof PlanStop) {
      return { kind: "stopped", reason: error.failure.kind, failure: error.failure, ...resultBase() };
    }
    throw error;
  }
}
