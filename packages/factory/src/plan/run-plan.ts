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
import { CallGateway } from "../call.js";
import type { Judge } from "../judge.js";
import { JudgeBudgetExceededError, createBudgetedJudge, type BudgetedJudge } from "../judge-budget.js";
import { AGENT_LIMITS, type AgentLimits, type LimitName } from "../limits.js";
import type { LlmClient } from "../llm.js";
import type { ReverseCheckMiss, SourceRange } from "../pipeline.js";
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
import { CATALOG_FACETS, catalogDefaultOf, catalogGateQuestionName, catalogOpenIssue, runCatalog, type UnspecifiedFacet } from "./catalog.js";
import { runConfirm, type ConfirmProblem } from "./confirm.js";
import { alsoClosesOf, assignQuestionIds, runQuestions, type PlanQuestion, type PlanSourceClosure } from "./questions.js";
import {
  nextPlanStep,
  remainingPlanBudget,
  type PlanConfirmationView,
  type PlanRemaining,
  type PlanTurn,
} from "./session.js";
import { runSurface, type SurfaceCatalogData } from "./surface.js";
import { runSurfaceCheck, type SurfaceJudgment, type SurfaceUncheckedClaim } from "./surface-check.js";

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
 * P3 の「書けない」の申告の点検の記録（Issue #432）。**件数（受理・落とした・曖昧さへ・未点検）と、判定の
 * 記録（問いの ID・答え・確信度・モデルの版・adapter）**だけを持つ——申告の部分の文・理由・制約 ID の
 * 値は入れない（`02-failure-modes.md` §1）。確定・確定できない・止まったの 3 つの結果に共通で、申告 0 件
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
  /** 判定の記録（仕分けと裏付けの両方） */
  readonly judgments: readonly SurfaceJudgment[];
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
   * 値（申告の部分の文・理由・制約 ID）は入れない。
   */
  readonly surfaceCheck: PlanSurfaceCheckSummary;
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
 * 写す（Issue #432）。**値の中身（部分の文・理由・制約 ID）を含まない**——`path` は添字つきの欄の名前
 * （`unwritable[<番号>]`）をコードが組み、`code` は有限の分類（`not-stated`・`low-confidence`・`unknown`）。
 */
function surfaceCheckReasons(unchecked: readonly SurfaceUncheckedClaim[]): readonly CannotConfirmReason[] {
  return unchecked.map((claim) => ({
    source: "surface-check" as const,
    code: planDiagnosisCode(claim.code),
    path: `unwritable[${claim.index}]`,
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
  // 判定の口を、**この Plan の予算に結び付けた包み**で包む（#359）。判定の費用も、段の呼び出しと同じ
  // 予算で予約・精算する。予約できなければ判定を呼ばずに `JudgeBudgetExceededError` になる（止まる）。
  const judgeBudget: BudgetedJudge = createBudgetedJudge({
    judge: input.judge,
    budget,
    rates: input.rates,
    ...(input.judgeMaxOutputTokens === undefined ? {} : { maxOutputTokens: input.judgeMaxOutputTokens }),
  });
  const stages: PlanStageRecord[] = [];
  // 依頼文で閉じた事項（往復の記録に残す。04 §3 P4・Issue #370）
  const closedBySource: PlanSourceClosure[] = [];
  // 許可の表の既定で閉じた事項（Issue #408）
  const closedByDefaults: PlanDefaultClosure[] = [];
  // P1/P2 の往復ごとの逆照合の落ちの内訳（Issue #430）。止まったときは、止まるまでに得た分だけになる。
  let requirementsDiagnosis: ReverseCheckDiagnosis = emptyReverseCheckDiagnosis();
  // P3 の「書けない」の申告の点検の記録（Issue #432）。申告 0 件・P3 に届かなかったときは 0 のまま。
  let surfaceCheckSummary: PlanSurfaceCheckSummary = {
    accepted: 0,
    dropped: 0,
    ambiguity: 0,
    unchecked: 0,
    judgments: [],
  };
  // コードが目録から作った事項の対応（事項 ID → 未指定の観点）と、要件ごとの門の判定（Issue #408）
  const catalogIssueFacets = new Map<string, UnspecifiedFacet>();
  const aggregatesByRequirement = new Map<string, boolean | null>();

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
      pushRecord(stage, "failed", before, start, "unknown");
      throw error;
    }
    pushRecord(stage, "ok", before, start, null);
    return value;
  };

  const resultBase = (): PlanResultBase => ({
    stages: stages.slice(),
    spentUsd: budget.spentUsd,
    remainingUsd: budget.remainingUsd,
    judge: { calls_by_adapter: judgeBudget.callsByAdapter, cost_usd: judgeBudget.spentUsd },
    closedBySource: closedBySource.slice(),
    closedByDefault: closedByDefaults.slice(),
    requirementsDiagnosis,
    surfaceCheck: surfaceCheckSummary,
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
    const openIssues: PlanOpenIssue[] = list.unresolved.map((text, index) => ({
      id: `OI:unresolved:${index + 1}`,
      text,
      critical: true,
      status: "open",
    }));

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
    // 目録の門の判定（要件 ID → 集計を含むか）を、既定の適用条件の事実として組む（Issue #408）。門の
    // 答えが無い・Noul でない・範囲の外は `null`（判定できない＝閉じない）。問いの名前は、要件 ID と
    // 同じ組み立て（`catalogGateQuestionName`）で引き直す——事項 ID の接頭辞は解析しない。
    for (const facet of catalog.unspecified) {
      if (aggregatesByRequirement.has(facet.requirementId)) continue;
      const gateName = catalogGateQuestionName(facet.requirementId);
      const judgment = catalog.judgments.find(
        (candidate) => candidate.kind === "gate" && candidate.questionId === gateName,
      );
      const value = judgment?.value ?? null;
      aggregatesByRequirement.set(facet.requirementId, value === null ? null : value > 1 - threshold);
    }
    /** 未指定の観点に、許可の表の既定が当たるときだけ値と理由を返す（仮適用と確定の両方で使う。Issue #419） */
    const defaultFor = (facet: UnspecifiedFacet): { readonly value: string; readonly reason: string } | undefined => {
      const catalogFacet = CATALOG_FACETS.find((candidate) => candidate.id === facet.facetId);
      if (catalogFacet === undefined) return undefined;
      return catalogDefaultOf(catalogFacet, {
        aggregates: aggregatesByRequirement.get(facet.requirementId) ?? null,
      });
    };
    // P3 に渡す 3 つのデータを組む（Issue #419）。**ここでは決定も閉じた記録も作らない**——仮適用である。
    // 値と理由はコードの定数（`defaultFor` の返す値と、表の理由）だけを使う。依頼文・答えの本文は渡さない。
    const catalogData: SurfaceCatalogData = {
      targets: catalog.reviewed,
      openIssues: catalog.unspecified.map((facet) => {
        const issue = catalogOpenIssue(facet);
        return { id: issue.id, requirementId: facet.requirementId, facetId: facet.facetId, text: issue.text };
      }),
      defaults: catalog.unspecified.flatMap((facet) => {
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
    };

    // ── P3 洗い出し（目録に無い曖昧さ）──────────────────────────────
    const surface = await runStageOutcome("surface", () =>
      runSurface({ list, documents: input.documents, gateway, catalog: catalogData }),
    );
    for (const ambiguity of surface.ambiguities) {
      openIssues.push({
        id: ambiguity.id,
        text: ambiguity.text,
        critical: ambiguity.critical,
        status: "open",
      });
    }
    // コードが目録から作った事項を、開いている事項に足す（04 §3・Issue #408）。**ID の接頭辞は解析
    // しない**——モデルが同じ形（`OI:catalog:`）の ID を作っても、この対応には入らないので既定の対象に
    // ならない（後で `applyDefaults` が重複として弾く）。
    for (const facet of catalog.unspecified) {
      const issue = catalogOpenIssue(facet);
      openIssues.push(issue);
      catalogIssueFacets.set(issue.id, facet);
    }

    // ── surface-check（P3 の「書けない」の申告を、確認の前に判定の口で点検する。Issue #432）──
    // 申告 1 件ずつを仕分け・裏付けし、**裏付けの取れた語彙の穴だけ**を了承除外の候補にする。判定は助言で
    // あり、点検は申告を減らす・止める方向にだけ効く。申告が 0 件なら判定を呼ばず、段を `ok` で残す
    // （`runSurfaceCheck` が早期に返す）。判定の予算が尽きれば、既存どおり段 `surface-check` の失敗
    // （`budget`）で止まる（`runStage` が `JudgeBudgetExceededError` を握る）。
    const surfaceCheck = await runStage("surface-check", () =>
      runSurfaceCheck({
        surface,
        documents: input.documents,
        judge: judgeBudget,
        threshold,
      }),
    );
    surfaceCheckSummary = {
      accepted: surfaceCheck.accepted.length,
      dropped: surfaceCheck.dropped.length,
      ambiguity: surfaceCheck.ambiguities.length,
      unchecked: surfaceCheck.unchecked.length,
      judgments: surfaceCheck.judgments,
    };
    // 曖昧さと判定された申告（了承除外になるはずだった部分）は、**重大な**開いている事項にして P4 に渡す。
    // 聞かずに落とさない。
    for (const claim of surfaceCheck.ambiguities) {
      openIssues.push({
        id: `OI:surface-check:${claim.index}`,
        text: claim.part,
        critical: true,
        status: "open",
      });
    }
    // 未点検が 1 件でも残れば、P4・確認に進まず「確定できない」。理由は値の中身を含まない（Issue #432）。
    if (surfaceCheck.unchecked.length > 0) {
      return {
        kind: "cannot-confirm",
        openIssues: openIssues.filter((issue) => issue.status === "open" && issue.critical),
        reasons: surfaceCheckReasons(surfaceCheck.unchecked),
        ...resultBase(),
      };
    }

    // 受理した申告（語彙の穴で裏付けが取れたもの）だけを、了承して除く部分（`accepted_unwritable`）に写す
    // （§4・U-P2）。落とした申告・曖昧さと判定した申告の要件は**そのまま残す**（Build が書く）。代わりの案は、
    // 宣言で書ける近い形を 1 つ出したものなので、要件として残し、部分から代わりの案の ID で指す。
    const acceptedUnwritable: PlanAcceptedUnwritable[] = [];
    for (const item of surfaceCheck.accepted) {
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
    }

    // ── 往復（P4 質問 → 次の一歩 → P5 答えの反映）────────────────────────
    let revision = 1;
    const turns: PlanTurn[] = [];
    const priorAnswers: ClassifiedAnswer[] = [];
    const askedQuestionIds = new Set<string>();
    let followUpQuestions: readonly PlanQuestion[] = [];
    let allRecommended = false;
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

    const resolveIssue = (issueId: string, answerId: string): void => {
      const index = openIssues.findIndex((issue) => issue.id === issueId);
      const issue = openIssues[index];
      if (issue === undefined) return;
      openIssues[index] = { ...issue, status: "resolved", resolution: { answer_id: answerId } };
    };

    /** 問いの主の事項と、一緒に閉じる事項（`alsoCloses`）を、同じ答えの ID で閉じる（04 §3 P4） */
    const resolveQuestionIssues = (question: PlanQuestion, answerId: string): void => {
      resolveIssue(question.openIssueId, answerId);
      for (const id of alsoClosesOf(question)) resolveIssue(id, answerId);
    };

    /** 依頼文で閉じた事項を、聞かずに決めたこと（`decisions`）にして閉じる（04 §3 P4・Issue #370） */
    const applySourceClosure = (closure: PlanSourceClosure): void => {
      const index = openIssues.findIndex((issue) => issue.id === closure.issueId && issue.status === "open");
      const issue = openIssues[index];
      if (issue === undefined) return;
      const decisionId = `${SOURCE_CLOSURE_DECISION_PREFIX}${closure.issueId}`;
      decisions.push({
        id: decisionId,
        subject: issue.text,
        value: closure.value,
        reason: closure.quote,
      });
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
      }
    };

    for (;;) {
      // 表の既定で閉じるのは、**P4 の要否を決める前**（最初の往復を含む。Issue #408）
      applyDefaults();
      const open = openIssues.filter((issue) => issue.status === "open");
      const preRemaining = remainingPlanBudget(turns);
      const willAsk =
        open.length > 0 && !allRecommended && preRemaining.questions > 0 && preRemaining.roundTrips > 0;

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
        allRecommended,
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
        // 「全部推奨で進める」——どの問いも推奨で閉じ、確認に進む（§2）
        allRecommended = true;
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
          requirements.push(answerRequirement(answerId, choice?.text ?? recommended.reason));
          resolveQuestionIssues(question, answerId);
          drafts.push({ id: answerId, questionId: question.id, revision, choiceId: recommended.choiceId });
        }
        turns.push({ questions: asked, answers: drafts });
        revision += 1;
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
        priorAnswers.push(accepted);
      }
      // 矛盾から組み立てた問いを、次の往復に回す（§6 の 7）。対応する未解決の事項を開いておく
      for (const followUp of answerResult.followUpQuestions) {
        if (!openIssues.some((issue) => issue.id === followUp.openIssueId)) {
          openIssues.push({
            id: followUp.openIssueId,
            text: followUp.text,
            critical: true,
            status: "open",
          });
        }
      }
      followUpQuestions = answerResult.followUpQuestions;
      turns.push({ questions: asked, answers: rebuiltAnswers });
      revision += 1;
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
    return { kind: "confirmed", plan: confirmed.plan, ...resultBase() };
  } catch (error) {
    if (error instanceof PlanStop) {
      return { kind: "stopped", reason: error.failure.kind, failure: error.failure, ...resultBase() };
    }
    throw error;
  }
}
