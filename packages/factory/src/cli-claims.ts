// 記録した「書けない」の申告を判定の口へ流し直し、今の点検（再点検なし／あり）と、形を変えた問いの
// 単独・組の票を、**同じ申告・同じ正解**で対にして比べる道具の入口（Issue #459）。
//
// **正解付けと本物の Jev での比較は窓口が別に行う。** ここは API を呼ばず、試験は偽物の判定で閉じる。
// Plan の確定経路・既定の点検・今の問い（T1・S1）の文と criteria・Build 側の仕分けは変えない。
//
// 端末もファイルも扱うのは、この入口（と cli.ts）だけである。文書の読み込みと判定の口の組み立ては
// `factory:run`（cli.ts）と共有する（`loadDocumentsFromFiles`・`assembleJudge`）。
import type { CallGate } from "./call.js";
import { createCallGate } from "./call.js";
import { JobBudget, type TokenRates } from "./budget.js";
import {
  API_KEY_ENV,
  DEFAULT_RATES,
  EXIT_OK,
  EXIT_USAGE,
  JEV_API_KEY_ENV,
  assembleJudge,
  loadDocumentsFromFiles,
} from "./cli.js";
import type { Judge } from "./judge.js";
import { createJevJudge } from "./judge-jev.js";
import { createLlmJudge } from "./judge-llm.js";
import {
  JudgeBudgetExceededError,
  JudgeCallLimitExceededError,
  JudgeDeadlineExceededError,
  createBudgetedJudge,
} from "./judge-budget.js";
import { AGENT_LIMITS, type AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
import { createOpenAiLlmClient, DEFAULT_OPENAI_MODEL } from "./openai.js";
import {
  CLAIM_FORMS_VERSION,
  CLAIM_FORM_IDS,
  buildOperations,
  evaluateForms,
  requireClaimFormThreshold,
  ClaimFormsThresholdMissingError,
  type ClaimFormId,
  type ClaimInput,
  type ClaimOperation,
  type FormCallRecord,
  type FormVoteRecord,
} from "./plan/claim-forms.js";
import {
  createJudgeRecorder,
  createRecordedJudge,
  recordJudge,
  type RecordedJudgeEntry,
} from "./plan/claim-recorded-judge.js";
import {
  scoreClaims,
  validateLabels,
  type BaselineInput,
  type ClaimLabel,
  type ClaimScore,
  type LabelProblems,
} from "./plan/claim-score.js";
import { DEFAULT_PLAN_JUDGE_THRESHOLD } from "./plan/run-plan.js";
import { runSurfaceCheck, type SurfaceCheckResult } from "./plan/surface-check.js";
import type { PlanSurface, PlanUnwritable } from "./plan/surface.js";
import type { PromptDocument } from "./stages/prompt.js";

/** 終了コード：出力を書いた */
export const JUDGE_CLAIMS_EXIT_OK = EXIT_OK;
/** 終了コード：判定を呼ばずに止まった（文書のハッシュ不一致・閾値の表に無い組） */
export const JUDGE_CLAIMS_EXIT_STOPPED = 1;
/** 終了コード：使い方の誤り（引数・鍵） */
export const JUDGE_CLAIMS_EXIT_USAGE = EXIT_USAGE;

/** 出力の版 */
export const JUDGE_CLAIMS_SCHEMA = "musunest-factory/judge-claims/v1" as const;
/** 申告の組 v1 の版 */
export const CLAIMS_SET_SCHEMA = "musunest-factory/claims-set/v1" as const;
/** 点検の診断の版（`plan-surface-check.json` と同じ） */
export const CLAIMS_DIAGNOSTIC_SCHEMA = "musunest-factory/plan-surface-check/v1" as const;

/** 既定のモデルの版（閾値の表の鍵）。`factory:run` と同じ既定のモデルを使う */
export const DEFAULT_JUDGE_CLAIMS_MODEL = DEFAULT_OPENAI_MODEL;
/** 既定の集計の規則 */
export const DEFAULT_TALLY_RULE = "majority" as const;

/** 使い方の文 */
export const JUDGE_CLAIMS_USAGE =
  "使い方: factory:judge-claims -- (--claims <ファイル> | --diagnostic <ファイル>) --out <ファイル> [--doc-version <版> --doc-hash <ハッシュ>] [--judge jev|fallback] [--repeat <回>] [--reverse-options] [--labels <ファイル>] [--model <名前>] [--rule unanimous|majority] [--forms <T1,T2,...>] [--budget <USD>] [--deadline <分>] [--max-calls <回>]";

/** 引数 */
export interface JudgeClaimsArguments {
  readonly claimsFile?: string;
  readonly diagnosticFile?: string;
  readonly outFile: string;
  readonly docVersion?: string;
  readonly docHash?: string;
  readonly judge: "jev" | "fallback";
  readonly repeat: number;
  readonly reverseOptions: boolean;
  readonly labelsFile?: string;
  readonly model: string;
  readonly rule: "unanimous" | "majority";
  readonly forms: readonly ClaimFormId[];
  readonly budgetUsd?: number;
  readonly deadlineMs?: number;
  readonly maxCalls?: number;
}

function valueAfter(args: readonly string[], index: number, option: string): string | { error: string } {
  const raw = args[index + 1];
  if (raw === undefined) return { error: `${option} には値が要ります` };
  return raw;
}

/** 引数を読む。誤りは `error` に人の読む文を入れて返す（例外にしない） */
export function parseJudgeClaimsArguments(
  argv: readonly string[],
): JudgeClaimsArguments | { readonly error: string } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let claimsFile: string | undefined;
  let diagnosticFile: string | undefined;
  let outFile: string | undefined;
  let docVersion: string | undefined;
  let docHash: string | undefined;
  let judge: "jev" | "fallback" = "fallback";
  let repeat = 1;
  let reverseOptions = false;
  let labelsFile: string | undefined;
  let model: string = DEFAULT_JUDGE_CLAIMS_MODEL;
  let rule: "unanimous" | "majority" = DEFAULT_TALLY_RULE;
  let forms: readonly ClaimFormId[] = CLAIM_FORM_IDS;
  let budgetUsd: number | undefined;
  let deadlineMs: number | undefined;
  let maxCalls: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--reverse-options") {
      reverseOptions = true;
      continue;
    }
    if (arg === "--claims" || arg === "--diagnostic" || arg === "--out" || arg === "--doc-version" || arg === "--doc-hash" || arg === "--judge" || arg === "--repeat" || arg === "--labels" || arg === "--model" || arg === "--rule" || arg === "--forms" || arg === "--budget" || arg === "--deadline" || arg === "--max-calls") {
      const value = valueAfter(args, index, arg);
      index += 1;
      if (typeof value !== "string") return value;
      if (arg === "--claims") claimsFile = value;
      else if (arg === "--diagnostic") diagnosticFile = value;
      else if (arg === "--out") outFile = value;
      else if (arg === "--doc-version") docVersion = value;
      else if (arg === "--doc-hash") docHash = value;
      else if (arg === "--labels") labelsFile = value;
      else if (arg === "--model") model = value;
      else if (arg === "--judge") {
        if (value !== "jev" && value !== "fallback") return { error: "--judge は jev か fallback です" };
        judge = value;
      } else if (arg === "--repeat") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) return { error: "--repeat には 1 以上の整数を指定してください" };
        repeat = parsed;
      } else if (arg === "--rule") {
        if (value !== "unanimous" && value !== "majority") return { error: "--rule は unanimous か majority です" };
        rule = value;
      } else if (arg === "--forms") {
        const names = value.split(",").map((name) => name.trim()).filter((name) => name !== "");
        const invalid = names.filter((name) => !(CLAIM_FORM_IDS as readonly string[]).includes(name));
        if (names.length === 0 || invalid.length > 0) return { error: `--forms に知らない形があります: ${invalid.join(", ")}` };
        forms = names as readonly ClaimFormId[];
      } else if (arg === "--budget") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return { error: "--budget には 0 より大きい数（USD）を指定してください" };
        budgetUsd = parsed;
      } else if (arg === "--deadline") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return { error: "--deadline には 0 より大きい数（分）を指定してください" };
        deadlineMs = parsed * 60_000;
      } else if (arg === "--max-calls") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) return { error: "--max-calls には 1 以上の整数を指定してください" };
        maxCalls = parsed;
      }
      continue;
    }
    return { error: `知らない選択肢: ${arg}` };
  }
  if ((claimsFile === undefined) === (diagnosticFile === undefined)) {
    return { error: "--claims か --diagnostic のちょうど一方を指定してください" };
  }
  if (outFile === undefined) return { error: "--out で出力のファイルを指定してください" };
  if (diagnosticFile !== undefined && (docVersion === undefined || docHash === undefined)) {
    return { error: "診断からの変換には、評価用の文書の版（--doc-version）とハッシュ（--doc-hash）の明示の指定が要ります" };
  }
  return {
    ...(claimsFile === undefined ? {} : { claimsFile }),
    ...(diagnosticFile === undefined ? {} : { diagnosticFile }),
    outFile,
    ...(docVersion === undefined ? {} : { docVersion }),
    ...(docHash === undefined ? {} : { docHash }),
    judge,
    repeat,
    reverseOptions,
    ...(labelsFile === undefined ? {} : { labelsFile }),
    model,
    rule,
    forms,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(maxCalls === undefined ? {} : { maxCalls }),
  };
}

// ── 入力の読み込みと変換（過去の判定を写さない）──────────────────────────

/** 読み込んだ申告の組（文書の版とハッシュと、出典） */
export interface LoadedClaims {
  readonly docVersion: string;
  readonly docHash: string;
  readonly source: "set" | "diagnostic";
  readonly claims: readonly ClaimInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 申告の組 v1 を読む */
export function parseClaimsSet(text: string): LoadedClaims | { readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "申告の組が JSON として読めません" };
  }
  if (!isRecord(value)) return { error: "申告の組は写像（object）であること" };
  if (value["schema_version"] !== CLAIMS_SET_SCHEMA) return { error: `申告の組の版が違います（${CLAIMS_SET_SCHEMA} を期待）` };
  const docVersion = value["doc_version"];
  const docHash = value["doc_hash"];
  const rawClaims = value["claims"];
  if (typeof docVersion !== "string" || typeof docHash !== "string" || !Array.isArray(rawClaims)) {
    return { error: "申告の組に doc_version・doc_hash・claims が要ります" };
  }
  const claims: ClaimInput[] = [];
  for (const entry of rawClaims) {
    if (!isRecord(entry)) return { error: "claims の要素は写像であること" };
    const id = entry["id"];
    const runId = entry["run_id"];
    const index = entry["index"];
    const requirementId = entry["requirement_id"];
    const requirementText = entry["requirement_text"];
    const part = entry["part"];
    const reason = entry["reason"];
    const constraintIds = entry["constraint_ids"];
    const alternative = entry["alternative"];
    if (
      typeof id !== "string" ||
      typeof runId !== "string" ||
      typeof index !== "number" ||
      typeof requirementId !== "string" ||
      (requirementText !== null && typeof requirementText !== "string") ||
      typeof part !== "string" ||
      typeof reason !== "string" ||
      !Array.isArray(constraintIds) ||
      (alternative !== null && typeof alternative !== "string")
    ) {
      return { error: "claims の欄の形が違います" };
    }
    claims.push({
      id,
      runId,
      index,
      requirementId,
      requirementText,
      part,
      reason,
      constraintIds: constraintIds.map((item) => String(item)),
      alternative,
    });
  }
  return { docVersion, docHash, source: "set", claims };
}

/**
 * 点検の診断を、申告の組に変換する（Issue #459）。診断には**文書の内容のハッシュが無い**ので、評価用の
 * 文書の版とハッシュを**明示の引数**で受けて出典を記録する（今の文書のハッシュを黙って旧記録に付けない）。
 * **過去の分類・確信度・根拠は写さない**。要件の文と代わりの案は診断に無いので `null` にする。
 */
export function convertDiagnostic(
  text: string,
  docVersion: string,
  docHash: string,
): LoadedClaims | { readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "診断が JSON として読めません" };
  }
  if (!isRecord(value)) return { error: "診断は写像（object）であること" };
  const planId = typeof value["plan_id"] === "string" ? value["plan_id"] : "diagnostic";
  const rawClaims = value["claims"];
  if (!Array.isArray(rawClaims)) return { error: "診断に claims が要ります" };
  const claims: ClaimInput[] = [];
  for (const entry of rawClaims) {
    if (!isRecord(entry)) return { error: "claims の要素は写像であること" };
    const index = entry["index"];
    const requirementId = entry["requirement_id"];
    const part = entry["part"];
    const reason = entry["reason"];
    const constraintIds = entry["constraint_ids"];
    if (
      typeof index !== "number" ||
      typeof requirementId !== "string" ||
      typeof part !== "string" ||
      typeof reason !== "string" ||
      !Array.isArray(constraintIds)
    ) {
      return { error: "診断の claims の欄の形が違います" };
    }
    claims.push({
      id: `claim-${String(entry["check"] ?? 0)}-${String(index)}`,
      runId: planId,
      index,
      requirementId,
      requirementText: null,
      part,
      reason,
      constraintIds: constraintIds.map((item) => String(item)),
      alternative: null,
    });
  }
  return { docVersion, docHash, source: "diagnostic", claims };
}

// ── 入口の依存（試験は偽物を差し込む）────────────────────────────────

/** 入口の依存 */
export interface JudgeClaimsDeps {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, text: string) => Promise<void>;
  /** 文書を読む（`factory:run` と同じ組み立てを共有。既定は `loadDocumentsFromFiles`） */
  readonly loadDocuments?: () => Promise<readonly PromptDocument[]>;
  readonly makeClient?: (options: { apiKey: string; model: string; effort: string }) => LlmClient;
  readonly makeJevJudge?: (options: { apiKey: string }) => Judge;
  readonly makeLlmJudge?: (options: { client: LlmClient; model: string }) => Judge;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly rates?: TokenRates;
  readonly budgetUsd?: number;
  readonly deadlineMs?: number;
  readonly limits?: AgentLimits;
}

/** 申告 1 件の分類（基準の経路の行き先） */
type ClaimClassification = "accept" | "drop" | "ambiguity" | "unchecked";

/**
 * 基準の経路の要約。**元の申告 ID と分類の対応**で持つ（配列の位置で番号を作り直さない。Issue #459・F6）。
 * `referred` は**実際に再点検へ回した**申告の ID（最終の行き先とは別に持つ。N3）。
 */
interface SurfaceSummary {
  readonly claims: readonly { readonly claim_id: string; readonly classification: ClaimClassification }[];
  readonly referred: readonly string[];
  readonly judgments: number;
}

/** 点検の結果を、**申告 ID → 分類**に写す（点検の添字ではなく、申告自身の ID で結ぶ） */
function summarizeSurface(surface: PlanSurface, result: SurfaceCheckResult): SurfaceSummary {
  const ids = surface.unwritable.map((claim) => claim.id);
  const byId = new Map<string, ClaimClassification>();
  for (const claim of result.accepted) byId.set(claim.id, "accept");
  for (const entry of result.dropped) byId.set(ids[entry.index] ?? `#${entry.index}`, "drop");
  for (const entry of result.ambiguities) byId.set(ids[entry.index] ?? `#${entry.index}`, "ambiguity");
  for (const entry of result.unchecked) byId.set(ids[entry.index] ?? `#${entry.index}`, "unchecked");
  // 再点検の段に達した申告＝**実際に回した**申告（低確信・不明・「書いていない」）
  const referred = [
    ...new Set(
      result.diagnostics
        .filter((entry) => entry.stage === "recheck")
        .map((entry) => ids[entry.index])
        .filter((id): id is string => id !== undefined),
    ),
  ];
  return {
    claims: ids.map((id) => ({ claim_id: id, classification: byId.get(id) ?? "unchecked" })),
    referred,
    judgments: result.judgments.length,
  };
}

/** 要約を、経路ごとの行き先の写像（申告 ID → 分類）にする */
function destinationsOf(summary: SurfaceSummary): Map<string, ClaimClassification> {
  return new Map(summary.claims.map((entry) => [entry.claim_id, entry.classification]));
}

/** 要約を、実際に再点検へ回した申告の集合にする */
function referredOf(summary: SurfaceSummary): Set<string> {
  return new Set(summary.referred);
}

/** 複数の束の要約を 1 つにまとめる（run ごとに分けた束を足し合わせる） */
function mergeSummaries(parts: readonly SurfaceSummary[]): SurfaceSummary {
  return {
    claims: parts.flatMap((part) => part.claims.slice()),
    referred: [...new Set(parts.flatMap((part) => part.referred.slice()))],
    judgments: parts.reduce((sum, part) => sum + part.judgments, 0),
  };
}

/**
 * 申告を、**同じ要件 ID に異なる要件の文が混ざらない**束に分ける（Issue #459・N1）。点検は要件 ID
 * （run を含まない）で文を引くので、run だけで分けても、同じ要件 ID に別の版の文があれば上書きされる。
 * 版は推測で補わず、文が食い違う申告を別の束にする。
 */
function bundleClaims(claims: readonly ClaimInput[]): readonly (readonly ClaimInput[])[] {
  const bundles: ClaimInput[][] = [];
  const texts: Map<string, string>[] = [];
  for (const claim of claims) {
    const key = claim.requirementId;
    const value = claim.requirementText ?? "";
    let placed = false;
    for (let index = 0; index < bundles.length; index += 1) {
      const existing = texts[index]?.get(key);
      if (existing === undefined || existing === value) {
        bundles[index]?.push(claim);
        texts[index]?.set(key, value);
        placed = true;
        break;
      }
    }
    if (!placed) {
      bundles.push([claim]);
      texts.push(new Map([[key, value]]));
    }
  }
  return bundles;
}

/** 申告の束を `PlanSurface` に写す */
function surfaceOf(claims: readonly ClaimInput[]): PlanSurface {
  const unwritable: PlanUnwritable[] = claims.map((claim) => ({
    id: claim.id,
    requirementId: claim.requirementId,
    part: claim.part,
    reason: claim.reason,
    constraintIds: claim.constraintIds,
    alternative: claim.alternative ?? "",
  }));
  return { ambiguities: [], unwritable };
}

/** gate・予算で止まる誤りか */
function isStopError(error: unknown): boolean {
  return (
    error instanceof JudgeBudgetExceededError ||
    error instanceof JudgeDeadlineExceededError ||
    error instanceof JudgeCallLimitExceededError
  );
}

/** 記録の口の欠落（握らずに投げ直される）か */
function isRecordedMiss(error: unknown): boolean {
  return error instanceof Error && error.name === "RecordedJudgeMissError";
}

/** 門（締切・総回数）と予算を掛けた判定の口。**門も返す**（形の評価で「呼ぶ前」の締切を見るのに使う） */
function gatedJudge(judge: Judge, input: {
  readonly budgetUsd: number;
  readonly rates: TokenRates;
  readonly now: () => number;
  readonly deadline: number;
  readonly maxCalls: number;
  readonly recheckJudge?: Judge;
}): { readonly judge: ReturnType<typeof createBudgetedJudge>; readonly gate: CallGate } {
  const gate: CallGate = createCallGate({ now: input.now, deadline: input.deadline, limit: input.maxCalls });
  return {
    gate,
    judge: createBudgetedJudge({
      judge,
      budget: new JobBudget(input.budgetUsd),
      rates: input.rates,
      gate,
      ...(input.recheckJudge === undefined ? {} : { recheck: input.recheckJudge }),
    }),
  };
}

/** 呼び出しの記録を、使用量と**生の答え**つきで出力の形に写す（**使用量は原値のまま**。Issue #459・F12） */
function callRecordToOutput(record: FormCallRecord): Record<string, unknown> {
  const response = record.response;
  const usage = response?.usage;
  const inputTokens = response?.inputTokens ?? 0;
  // Jev の入力トークンが 0（または usage が欠けている）ときは、**実測 0 と欠落を区別できない**印を付ける。
  // **null に変換しない**（原値のまま）。
  const usageMarked = response !== null && response.answeredBy === "jev" && usage === undefined && inputTokens === 0;
  return {
    id: record.id,
    form: record.form,
    stage: record.stage,
    operation: record.operation,
    request_hash: record.requestHash,
    context_ids: record.contextIds,
    question_ids: record.questionIds,
    state: record.state,
    answered_by: record.answeredBy,
    model: record.model,
    // 生の答え（T2 の生ラベル・S3 の選択・S4 の段落答え・確率を後から検証できるように残す。F12）
    answers: response === null ? null : (response.answers as unknown),
    input_tokens: response === null ? null : inputTokens,
    usage: usage === undefined ? null : { ...usage },
    usage_unmeasurable: usageMarked,
  };
}

/** 問いの ID（`<頭>:<番号>`）から、束の申告 ID を引く（基準の生の答えを元の申告へ結ぶ。N5） */
function claimIdsOf(questionIds: readonly string[], orderedClaimIds: readonly string[]): readonly string[] {
  const ids = questionIds
    .map((name) => {
      const suffix = name.split(":")[1];
      const index = suffix === undefined ? Number.NaN : Number(suffix);
      return Number.isInteger(index) ? orderedClaimIds[index] : undefined;
    })
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}

/**
 * 基準の経路の呼び出し（主・再点検）を、出力の形に写す（F12/N5）。**run と、束の申告 ID の対応**、
 * **原値の入力トークン**、使用量の印を残す——Jev は正の使用量を `inputTokens` で返すので、`usage` だけで
 * 写すと正の値も 0 の印も消える。
 */
function baselineCallToOutput(
  entry: RecordedJudgeEntry,
  role: "primary" | "recheck",
  runId: string,
  orderedClaimIds: readonly string[],
): Record<string, unknown> {
  const common = {
    role,
    run_id: runId,
    request_hash: entry.requestHash,
    question_ids: entry.questionIds,
    claim_ids: claimIdsOf(entry.questionIds, orderedClaimIds),
  };
  if (entry.kind === "stop") {
    return { ...common, state: "failed", error_name: entry.errorName, answered_by: "none", input_tokens: null, usage: null, usage_unmeasurable: false, answers: null };
  }
  const response = entry.response;
  const usage = response.usage;
  const inputTokens = response.inputTokens;
  // Jev の入力トークンが 0（または usage が欠けている）ときは、**実測 0 と欠落を区別できない**印を付ける
  const usageMarked = response.answeredBy === "jev" && usage === undefined && inputTokens === 0;
  return {
    ...common,
    state: "ok",
    error_name: null,
    answered_by: response.answeredBy,
    model: response.model,
    input_tokens: inputTokens,
    usage: usage === undefined ? null : { ...usage },
    usage_unmeasurable: usageMarked,
    answers: response.answers as unknown,
  };
}

/** 票の記録を出力の形に写す */
function voteToOutput(record: FormVoteRecord): Record<string, unknown> {
  return {
    claim_id: record.claimId,
    form: record.form,
    operation: record.operation,
    vote: record.vote.vote,
    evidence_id: record.vote.evidenceId,
    inside_claim_constraint_ids: record.vote.insideClaimConstraintIds,
  };
}

function parseLabelsFile(text: string): { readonly labels: readonly ClaimLabel[]; readonly docVersion: string; readonly docHash: string } | { readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "正解のファイルが JSON として読めません" };
  }
  if (!isRecord(value)) return { error: "正解は写像（object）であること" };
  const docVersion = value["doc_version"];
  const docHash = value["doc_hash"];
  const rawLabels = value["labels"];
  if (typeof docVersion !== "string" || typeof docHash !== "string" || !Array.isArray(rawLabels)) {
    return { error: "正解に doc_version・doc_hash・labels が要ります" };
  }
  const labels: ClaimLabel[] = [];
  for (const entry of rawLabels) {
    if (!isRecord(entry)) return { error: "labels の要素は写像であること" };
    const id = entry["id"];
    const kind = entry["kind"];
    const expressible = entry["expressible"];
    if (typeof id !== "string" || typeof kind !== "string" || typeof expressible !== "string") {
      return { error: "labels の欄の形が違います" };
    }
    labels.push({ id, kind: kind as ClaimLabel["kind"], expressible: expressible as ClaimLabel["expressible"] });
  }
  return { labels, docVersion, docHash };
}

/**
 * 1 回の比較を流す。**実 API は呼ばない**（差し込まれた偽物の判定だけを使う）。手順は、
 *   1. 引数を読み、申告の組（または診断の変換）を読む（過去の判定は写さない）
 *   2. 文書を読み、そのハッシュが組と違えば**呼ばずに**止まる
 *   3. 判定の口を組み立てる（`--judge jev` は鍵が無ければ使い方の誤りで止まり、LLM で代用しない）
 *   4. 基準の 2 経路（再点検あり／なし）と、全申告 × 選んだ形 × 操作を流す
 *   5. **判定の後に**正解を読み、経路ごとの混同表と率を出す
 *   6. 出力を書く
 */
export async function runJudgeClaims(deps: JudgeClaimsDeps): Promise<number> {
  const log = deps.log ?? ((): void => {});
  const parsed = parseJudgeClaimsArguments(deps.argv);
  if ("error" in parsed) {
    log(`使い方の誤り: ${parsed.error}`);
    log(JUDGE_CLAIMS_USAGE);
    return JUDGE_CLAIMS_EXIT_USAGE;
  }

  // ── 1. 入力の読み込み ────────────────────────────────────────
  let loaded: LoadedClaims | { readonly error: string };
  if (parsed.claimsFile !== undefined) {
    loaded = parseClaimsSet(await deps.readFile(parsed.claimsFile));
  } else {
    const text = await deps.readFile(parsed.diagnosticFile ?? "");
    loaded = convertDiagnostic(text, parsed.docVersion ?? "", parsed.docHash ?? "");
  }
  if ("error" in loaded) {
    log(`使い方の誤り: ${loaded.error}`);
    return JUDGE_CLAIMS_EXIT_USAGE;
  }

  // ── 2. 文書の読み込みとハッシュの照合（不一致なら呼ばずに止まる）──────
  const loadDocuments = deps.loadDocuments ?? loadDocumentsFromFiles;
  const documents = await loadDocuments();
  const { sha256Hex } = await import("@musunest/spec-engine");
  const actualHash = await sha256Hex(JSON.stringify(documents));
  if (actualHash !== loaded.docHash) {
    log(`文書のハッシュが組と違うので止めます（組 ${loaded.docHash} / 文書 ${actualHash}）`);
    return JUDGE_CLAIMS_EXIT_STOPPED;
  }

  // ── 3. 判定の口の組み立て（`factory:run` と同じ既定の生成関数を使う。F2）────
  const apiKey = deps.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    log(`使い方の誤り: 環境変数 ${API_KEY_ENV} がありません`);
    log(JUDGE_CLAIMS_USAGE);
    return JUDGE_CLAIMS_EXIT_USAGE;
  }
  // **注入が無くても実入口が起動できる**よう、既定は本物の生成関数にする（F2）
  const makeClient = deps.makeClient ?? ((options: { apiKey: string; model: string; effort: string }): LlmClient => createOpenAiLlmClient(options));
  const makeJevJudge = deps.makeJevJudge ?? ((options: { apiKey: string }): Judge => createJevJudge(options));
  const makeLlmJudge = deps.makeLlmJudge ?? ((options: { client: LlmClient; model: string }): Judge => createLlmJudge(options));
  // **実施の事実**（N2）：下の判定の口が実際に呼ばれた回数を数える。門の拒否は下の口を呼ばないので数えない。
  const invocations = { count: 0 };
  const countInvocations = (judge: Judge): Judge => ({
    async judge(request) {
      invocations.count += 1;
      return judge.judge(request);
    },
  });
  const makeJevJudgeCounted = (options: { apiKey: string }): Judge => countInvocations(makeJevJudge(options));
  const makeLlmJudgeCounted = (options: { client: LlmClient; model: string }): Judge => countInvocations(makeLlmJudge(options));
  const client = makeClient({ apiKey, model: parsed.model, effort: "high" });
  const jevApiKey = deps.env[JEV_API_KEY_ENV];
  let primaryJudge: Judge;
  let recheckJudge: Judge;
  if (parsed.judge === "jev") {
    // 主だけ。鍵が無ければ使い方の誤りで止まり、**LLM で代用しない**
    if (jevApiKey === undefined || jevApiKey === "") {
      log(`使い方の誤り: --judge jev には環境変数 ${JEV_API_KEY_ENV} が要ります（LLM では代用しません）`);
      return JUDGE_CLAIMS_EXIT_USAGE;
    }
    primaryJudge = makeJevJudgeCounted({ apiKey: jevApiKey });
    recheckJudge = makeLlmJudgeCounted({ client, model: parsed.model });
  } else {
    const assembled = assembleJudge({
      env: deps.env,
      model: parsed.model,
      client,
      makeJevJudge: makeJevJudgeCounted,
      makeLlmJudge: makeLlmJudgeCounted,
      logError: log,
    });
    primaryJudge = assembled.judge;
    recheckJudge = assembled.recheckJudge;
  }

  // 閾値の表を引く（無ければ**送る前に**止まる）
  let threshold: number;
  try {
    threshold = requireClaimFormThreshold(CLAIM_FORMS_VERSION, parsed.model);
  } catch (error) {
    if (error instanceof ClaimFormsThresholdMissingError) {
      log(`閾値の表に無い組なので止めます（${error.formsVersion} × ${error.modelVersion}）`);
      return JUDGE_CLAIMS_EXIT_STOPPED;
    }
    throw error;
  }

  const now = deps.now ?? ((): number => Date.now());
  const deadline = now() + (parsed.deadlineMs ?? deps.deadlineMs ?? 600_000);
  const maxCalls = parsed.maxCalls ?? deps.limits?.callCount ?? AGENT_LIMITS.callCount;
  const rates = deps.rates ?? DEFAULT_RATES;
  const budgetUsd = parsed.budgetUsd ?? deps.budgetUsd ?? 0.3;
  const { judge: budgeted, gate } = gatedJudge(primaryJudge, {
    budgetUsd,
    rates,
    now,
    deadline,
    maxCalls,
    recheckJudge,
  });
  const budgetedRecheck: Judge = budgeted.fallback ?? recheckJudge;

  const claims = loaded.claims;
  const contextInsufficientClaims = claims.filter((claim) => claim.requirementText === null);
  const contextInsufficient = contextInsufficientClaims.map((claim) => claim.id);

  // ── 4. 基準の 2 経路（run ごとに束を分ける。F5/F6/F7）─────────────
  const baselineCalls: Record<string, unknown>[] = [];
  const withRecheckParts: SurfaceSummary[] = [];
  const withoutRecheckParts: SurfaceSummary[] = [];
  let baselineStopped = false;
  for (const group of bundleClaims(claims.filter((claim) => claim.requirementText !== null))) {
    const surface = surfaceOf(group);
    const orderedClaimIds = group.map((claim) => claim.id);
    const runId = group[0]?.runId ?? "";
    // **run と版を含む対応**：束の中の要件 ID → 文（run と版をまたいだ同じ ID の取り違えを避ける。F5/N1）
    const requirements = new Map(group.map((claim) => [claim.requirementId, claim.requirementText ?? ""]));
    const recorder = createJudgeRecorder();
    const recheckRecorder = createJudgeRecorder();
    const recordedPrimary = recordJudge(budgeted, recorder);
    const recordedRecheck = recordJudge(budgetedRecheck, recheckRecorder);

    let partialA: SurfaceCheckResult | null = null;
    try {
      partialA = await runSurfaceCheck({
        surface,
        documents,
        judge: recordedPrimary,
        recheckJudge: recordedRecheck,
        threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
        requirements,
        docVersion: loaded.docVersion,
        onProgress: (entry) => {
          partialA = entry;
        },
      });
    } catch (error) {
      if (isRecordedMiss(error)) {
        log("基準の経路で記録の口の欠落により止まりました");
        return JUDGE_CLAIMS_EXIT_STOPPED;
      }
      if (isStopError(error)) baselineStopped = true;
      else throw error;
    }
    if (partialA !== null) withRecheckParts.push(summarizeSurface(surface, partialA));
    for (const entry of recorder.entries) baselineCalls.push(baselineCallToOutput(entry, "primary", runId, orderedClaimIds));
    for (const entry of recheckRecorder.entries) baselineCalls.push(baselineCallToOutput(entry, "recheck", runId, orderedClaimIds));

    // 「再点検なし」：記録した応答・停止を、ハッシュの一致で返す記録の口へ流し直す。**止まっても流す**（F7）
    let partialB: SurfaceCheckResult | null = null;
    try {
      partialB = await runSurfaceCheck({
        surface,
        documents,
        judge: createRecordedJudge(recorder.entries),
        threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
        requirements,
        docVersion: loaded.docVersion,
        onProgress: (entry) => {
          partialB = entry;
        },
      });
    } catch (error) {
      if (isRecordedMiss(error)) {
        log("基準の経路（再点検なし）で記録の口の欠落により止まりました");
        return JUDGE_CLAIMS_EXIT_STOPPED;
      }
      if (isStopError(error)) baselineStopped = true;
      else throw error;
    }
    if (partialB !== null) withoutRecheckParts.push(summarizeSurface(surface, partialB));
  }
  for (const group of bundleClaims(contextInsufficientClaims)) {
    // 要件の文が無い申告は、再点検の口なしで流し（空文字を送らない）、文脈不足の層とする
    const surface = surfaceOf(group);
    const requirements = new Map(group.map((claim) => [claim.requirementId, ""]));
    try {
      await runSurfaceCheck({
        surface,
        documents,
        judge: budgeted,
        threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
        requirements,
        docVersion: loaded.docVersion,
      });
    } catch (error) {
      if (isRecordedMiss(error)) {
        log("文脈不足の経路で記録の口の欠落により止まりました");
        return JUDGE_CLAIMS_EXIT_STOPPED;
      }
      if (isStopError(error)) baselineStopped = true;
      else throw error;
    }
  }
  const withRecheck = mergeSummaries(withRecheckParts);
  const withoutRecheck = mergeSummaries(withoutRecheckParts);
  if (baselineStopped) log("基準の経路で門に止まりました（途中までを残します）");

  // ── 5. 全申告 × 選んだ形 × 操作 ──────────────────────────────
  const operations: readonly ClaimOperation[] = buildOperations(parsed.repeat, parsed.reverseOptions);
  const allVotes: FormVoteRecord[] = [];
  const allCalls: FormCallRecord[] = [];
  for (const operation of operations) {
    const result = await evaluateForms({
      claims,
      documents,
      judge: budgeted,
      threshold,
      formsVersion: CLAIM_FORMS_VERSION,
      modelVersion: parsed.model,
      operation,
      forms: parsed.forms,
      gate,
      // **実施の事実**で、呼ぶ前の拒否と実施後の停止を分ける（N2）
      invocations: () => invocations.count,
    });
    allVotes.push(...result.votes);
    allCalls.push(...result.calls);
  }

  const forwardVotes = allVotes.filter((vote) => vote.operation === "forward");
  const planned = allCalls.length;
  const executed = allCalls.filter((call) => call.state !== "not-run").length;
  const notRun = allCalls.filter((call) => call.state === "not-run").length;

  // ── 6. 正解は**判定の後に**読む ──────────────────────────────
  let score: ClaimScore | null = null;
  let labelProblems: LabelProblems | null = null;
  if (parsed.labelsFile !== undefined) {
    const parsedLabels = parseLabelsFile(await deps.readFile(parsed.labelsFile));
    if ("error" in parsedLabels) {
      log(`使い方の誤り: ${parsedLabels.error}`);
      return JUDGE_CLAIMS_EXIT_USAGE;
    }
    labelProblems = validateLabels(
      { docVersion: parsedLabels.docVersion, docHash: parsedLabels.docHash, labels: parsedLabels.labels },
      claims.map((claim) => claim.id),
      actualHash,
    );
    // 基準の 2 経路を経路として渡し、**実際に回した**申告を分けて渡す。文脈不足の申告は分母から外す（F8/N3）
    const baselines = new Map<string, BaselineInput>([
      ["baseline:recheck", { destinations: destinationsOf(withRecheck), referred: referredOf(withRecheck) }],
      ["baseline:no-recheck", { destinations: destinationsOf(withoutRecheck), referred: referredOf(withoutRecheck) }],
    ]);
    score = scoreClaims({
      claims,
      votes: forwardVotes,
      repeatVotes: allVotes,
      labels: { docVersion: parsedLabels.docVersion, docHash: parsedLabels.docHash, labels: parsedLabels.labels },
      rule: parsed.rule,
      forms: parsed.forms,
      baselines,
      contextInsufficient: new Set(contextInsufficient),
    });
  }

  const output = {
    schema_version: JUDGE_CLAIMS_SCHEMA,
    forms_version: CLAIM_FORMS_VERSION,
    doc_version: loaded.docVersion,
    doc_hash: actualHash,
    source: loaded.source,
    no_claims: claims.length === 0,
    operations: operations.map((operation) => operation.id),
    forms: parsed.forms,
    rule: parsed.rule,
    claims: claims.map((claim) => ({
      id: claim.id,
      run_id: claim.runId,
      index: claim.index,
      requirement_id: claim.requirementId,
      requirement_text: claim.requirementText,
      part: claim.part,
      reason: claim.reason,
      constraint_ids: claim.constraintIds,
      alternative: claim.alternative,
    })),
    calls: allCalls.map(callRecordToOutput),
    votes: allVotes.map(voteToOutput),
    // 基準の 2 経路の呼び出し（主・再点検）を、生の答えつきで残す（F12）
    baseline_calls: baselineCalls,
    baselines: { with_recheck: withRecheck, without_recheck: withoutRecheck },
    context_insufficient: contextInsufficient,
    planned,
    executed,
    not_run: notRun,
    labels: labelProblems,
    score,
    // 費用の按分は、呼び出しの問い数を分母にした推定である（明記する）
    cost: {
      note: "呼び出しごとの費用は単価と使用量からの推定。比較の分母は呼び出しの問い数",
      budget_usd: budgetUsd,
      spent_usd: budgeted.spentUsd,
      calls_by_adapter: budgeted.callsByAdapter,
      // 実試行の数（成功・失敗の合計。adapter ごとの内訳は judge-budget.ts の外）
      attempts: budgeted.attempts,
    },
  };

  await deps.writeFile(parsed.outFile, JSON.stringify(output));
  return JUDGE_CLAIMS_EXIT_OK;
}

// ── Node 側（ファイルと環境変数を扱う。動的に読む）────────────────────

/** Node の入口が受け取るもの（`process` と同じ形） */
export interface NodeProcess {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  exitCode?: number;
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
}

interface NodeFs {
  readFile(path: URL | string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

function selfUrl(): string {
  return (import.meta as ImportMeta & { url: string }).url;
}

function isEntryPoint(proc: NodeProcess): boolean {
  const entry = proc.argv[1];
  if (entry === undefined) return false;
  return selfUrl().endsWith(entry);
}

/**
 * 実入口の依存を組む（Issue #459・F2）。`factory:run` と同じく、**ファイル・環境変数・鍵・判定の生成関数を
 * ここで用意する**——`main` がこれを使うので、注入が無くても実入口が起動できる。
 */
export async function nodeJudgeClaimsDeps(proc: NodeProcess): Promise<JudgeClaimsDeps> {
  const fs = (await importUntyped("node:fs/promises")) as NodeFs;
  return {
    argv: proc.argv.slice(2),
    env: proc.env,
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, text) => fs.writeFile(path, text, "utf8"),
    loadDocuments: loadDocumentsFromFiles,
    makeClient: (options) => createOpenAiLlmClient(options),
    makeJevJudge: (options) => createJevJudge(options),
    makeLlmJudge: (options) => createLlmJudge(options),
    log: (line) => proc.stdout.write(`${line}\n`),
  };
}

/** 手元から流す入口（`node dist/cli-claims.js -- ...`） */
export async function main(): Promise<void> {
  const proc = (globalThis as unknown as { process?: NodeProcess }).process;
  if (proc === undefined || !isEntryPoint(proc)) return;
  proc.exitCode = await runJudgeClaims(await nodeJudgeClaimsDeps(proc));
}

void main();
