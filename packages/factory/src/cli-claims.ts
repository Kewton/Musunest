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
import {
  JudgeBudgetExceededError,
  JudgeCallLimitExceededError,
  JudgeDeadlineExceededError,
  createBudgetedJudge,
} from "./judge-budget.js";
import { AGENT_LIMITS, type AgentLimits } from "./limits.js";
import type { LlmClient } from "./llm.js";
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
} from "./plan/claim-recorded-judge.js";
import {
  scoreClaims,
  validateLabels,
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

/** 既定のモデルの版（閾値の表の鍵） */
export const DEFAULT_JUDGE_CLAIMS_MODEL = "gpt-6-luna" as const;
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

/** 申告の行き先の要約（基準の経路の分類・行き先） */
interface SurfaceSummary {
  readonly accepted: readonly number[];
  readonly dropped: readonly number[];
  readonly ambiguities: readonly number[];
  readonly unchecked: readonly number[];
  readonly judgments: number;
}

function summarizeSurface(result: SurfaceCheckResult): SurfaceSummary {
  return {
    accepted: result.accepted.map((_claim, index) => index + 1),
    dropped: result.dropped.map((entry) => entry.index),
    ambiguities: result.ambiguities.map((entry) => entry.index),
    unchecked: result.unchecked.map((entry) => entry.index),
    judgments: result.judgments.length,
  };
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

/** 門（締切・総回数）と予算を掛けた判定の口を作る */
function gatedJudge(judge: Judge, input: {
  readonly budgetUsd: number;
  readonly rates: TokenRates;
  readonly now: () => number;
  readonly deadline: number;
  readonly maxCalls: number;
  readonly recheckJudge?: Judge;
}): ReturnType<typeof createBudgetedJudge> {
  const gate: CallGate = createCallGate({ now: input.now, deadline: input.deadline, limit: input.maxCalls });
  return createBudgetedJudge({
    judge,
    budget: new JobBudget(input.budgetUsd),
    rates: input.rates,
    gate,
    ...(input.recheckJudge === undefined ? {} : { recheck: input.recheckJudge }),
  });
}

/** 呼び出しの記録を、使用量の印つきで出力の形に写す（**使用量は原値のまま**） */
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
    input_tokens: response === null ? null : inputTokens,
    usage: usage === undefined ? null : { ...usage },
    usage_unmeasurable: usageMarked,
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

  // ── 3. 判定の口の組み立て ────────────────────────────────────
  const apiKey = deps.env[API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    log(`使い方の誤り: 環境変数 ${API_KEY_ENV} がありません`);
    log(JUDGE_CLAIMS_USAGE);
    return JUDGE_CLAIMS_EXIT_USAGE;
  }
  const makeClient = deps.makeClient ?? ((): never => {
    throw new Error("makeClient がありません");
  });
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
    primaryJudge = (deps.makeJevJudge ?? ((): never => {
      throw new Error("makeJevJudge がありません");
    }))({ apiKey: jevApiKey });
    recheckJudge = (deps.makeLlmJudge ?? ((): never => {
      throw new Error("makeLlmJudge がありません");
    }))({ client, model: parsed.model });
  } else {
    const assembled = assembleJudge({
      env: deps.env,
      model: parsed.model,
      client,
      ...(deps.makeJevJudge === undefined ? {} : { makeJevJudge: deps.makeJevJudge }),
      ...(deps.makeLlmJudge === undefined ? {} : { makeLlmJudge: deps.makeLlmJudge }),
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
  const budgeted = gatedJudge(primaryJudge, {
    budgetUsd,
    rates,
    now,
    deadline,
    maxCalls,
    recheckJudge,
  });
  const budgetedRecheck: Judge = budgeted.fallback ?? recheckJudge;

  const claims = loaded.claims;
  const withRequirement = claims.filter((claim) => claim.requirementText !== null);
  const withoutRequirement = claims.filter((claim) => claim.requirementText === null);
  const requirements = new Map(
    withRequirement.map((claim) => [claim.requirementId, claim.requirementText ?? ""]),
  );

  // ── 4. 基準の 2 経路 ─────────────────────────────────────────
  const recorder = createJudgeRecorder();
  const recordedPrimary = recordJudge(budgeted, recorder);
  let withRecheck: SurfaceSummary | null = null;
  let withoutRecheck: SurfaceSummary | null = null;
  let contextInsufficient: readonly string[] = [];
  try {
    if (withRequirement.length > 0) {
      const result = await runSurfaceCheck({
        surface: surfaceOf(withRequirement),
        documents,
        judge: recordedPrimary,
        recheckJudge: budgetedRecheck,
        threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
        requirements,
        docVersion: loaded.docVersion,
      });
      withRecheck = summarizeSurface(result);
      // 「再点検なし」：記録した応答を、ハッシュの一致で返す記録の口へ流し直す（途中報告を数えない）
      const replayed = await runSurfaceCheck({
        surface: surfaceOf(withRequirement),
        documents,
        judge: createRecordedJudge(recorder.entries),
        threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
        requirements,
        docVersion: loaded.docVersion,
      });
      withoutRecheck = summarizeSurface(replayed);
    }
    if (withoutRequirement.length > 0) {
      // 要件の文が無い申告は、再点検の口なしで流し（空文字を送らない）、文脈不足の層とする
      const result = await runSurfaceCheck({
        surface: surfaceOf(withoutRequirement),
        documents,
        judge: budgeted,
        threshold: DEFAULT_PLAN_JUDGE_THRESHOLD,
        requirements,
        docVersion: loaded.docVersion,
      });
      contextInsufficient = withoutRequirement.map((claim) => claim.id);
      void result;
    }
  } catch (error) {
    if (isStopError(error)) {
      log("基準の経路で門に止まりました");
    } else {
      throw error;
    }
  }

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
    score = scoreClaims({
      claims,
      votes: forwardVotes,
      repeatVotes: allVotes,
      labels: { docVersion: parsedLabels.docVersion, docHash: parsedLabels.docHash, labels: parsedLabels.labels },
      rule: parsed.rule,
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
    },
  };

  await deps.writeFile(parsed.outFile, JSON.stringify(output));
  return JUDGE_CLAIMS_EXIT_OK;
}

// ── Node 側（ファイルと環境変数を扱う。動的に読む）────────────────────

interface NodeProcess {
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

/** 手元から流す入口（`node dist/cli-claims.js -- ...`） */
export async function main(): Promise<void> {
  const proc = (globalThis as unknown as { process?: NodeProcess }).process;
  if (proc === undefined || !isEntryPoint(proc)) return;
  const fs = (await importUntyped("node:fs/promises")) as NodeFs;
  const code = await runJudgeClaims({
    argv: proc.argv.slice(2),
    env: proc.env,
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, text) => fs.writeFile(path, text, "utf8"),
    log: (line) => proc.stdout.write(`${line}\n`),
  });
  proc.exitCode = code;
}

void main();
