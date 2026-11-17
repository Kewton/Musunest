// Plan の探針（Issue #956）。
//
// Plan の上流（P1・P2・その往復）だけを、**Plan と同じ要求・同じ選択・同じ共通の口**で流し、段ごとの
// 記録を残す。採点はしない——正解の表・保持率・検出率は持たない。重なりは**観測**であって合否ではない。
//
// 要求を組み立て直さない。P1 は `runRequirements`、P2 は `runReverseCheckWithDiagnosis`、往復は
// `runReverseCheckLoopWithOperation` を、Plan の経路と同じ引数・同じ選択
// （`PLAN_REVERSE_CHECK_SELECTIONS`）で呼ぶ。ここに写しを置くと、Plan が選択を足したときに古い写しを送る。
//
// 予算・usage は起動の全体で 1 つを共有し、門（呼び出しの上限）と共通の口は**回ごとに作り直す**。
// 締切は起動の全体の絶対時刻である。1 回も呼ばずに断った回は `not-run`、呼んでから止まった回は `failed`。
// 予算・締切・usage 不明など起動の全体に効く理由では後続も `not-run` にし、回ごとの呼び出しの上限では
// 後続を止めない。
import { JobBudget, type TokenRates } from "../budget.js";
import {
  CallGateway,
  callCountsDelta,
  createCallGate,
  type CallCounts,
} from "../call.js";
import { sha256Hex } from "../cli-plan.js";
import { AGENT_LIMITS, type AgentLimits } from "../limits.js";
import type { LlmClient, LlmStructuredRequest } from "../llm.js";
import type { Framing, Requirement, RequirementList } from "../pipeline.js";
import { UsageMeter, usageDelta, type UsageSnapshot } from "../record.js";
import { decideQuotePosition, runRequirements } from "../stages/requirements.js";
import {
  checkRequirementCoverage,
  runReverseCheckLoopWithOperation,
  runReverseCheckWithDiagnosis,
  type ReverseCheckDiagnosis,
  type ReverseCheckOperation,
  type ReverseCheckTrace,
} from "../stages/reverse-check.js";
import { serializeJson, type PromptDocument, type StageFailure } from "../stages/prompt.js";
import { PLAN_REVERSE_CHECK_SELECTIONS } from "./run-plan.js";

/** 探針が流す段 */
export const PLAN_PROBE_STAGES = ["p1", "p2", "loop"] as const;
export type PlanProbeStage = (typeof PLAN_PROBE_STAGES)[number];

/** 題材の組の版 */
export const PLAN_PROBE_CASES_SCHEMA = "musunest-factory/plan-probe-cases/v1" as const;
/** 1 回ごとの記録の版 */
export const PLAN_PROBE_RUN_SCHEMA = "musunest-factory/plan-probe-run/v1" as const;
/** 起動ごとの条件の版 */
export const PLAN_PROBE_CONDITIONS_SCHEMA = "musunest-factory/plan-probe-conditions/v1" as const;
/** 集計の版 */
export const PLAN_PROBE_SUMMARY_SCHEMA = "musunest-factory/plan-probe-summary/v1" as const;

/** 題材 1 件の要件（`p2` で渡す一覧の 1 件。`Requirement` と同じ形） */
export interface PlanProbeRequirement {
  readonly id: string;
  readonly text: string;
  readonly quote: string;
  readonly position: { readonly start: number; readonly end: number };
}

/** 題材 1 件の原文の範囲（重なりの観測にだけ使う） */
export interface PlanProbeRange {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

/** 題材 1 件。`requirements` は `p2` のとき必須（`p1`・`loop` では使わない） */
export interface PlanProbeCase {
  readonly id: string;
  readonly source: string;
  readonly requirements?: readonly PlanProbeRequirement[];
  readonly ranges?: readonly PlanProbeRange[];
  /** `p2` の一覧に付ける枠の文（原文からそのまま写した文字列。無ければ `[]`） */
  readonly framing?: readonly string[];
}

/** 題材の組（JSON 1 本） */
export interface PlanProbeCaseSet {
  readonly schema_version: string;
  readonly cases_version: string;
  readonly cases: readonly PlanProbeCase[];
}

/** 題材の組を読んだ結果 */
export type PlanProbeCaseSetParse =
  | { readonly cases: PlanProbeCaseSet }
  | { readonly code: string; readonly error: string };

/** 題材の組の検査の符号（固定。値を含めない） */
export const PLAN_PROBE_CASE_ERROR_CODES = [
  "probe-cases:json",
  "probe-cases:schema",
  "probe-cases:shape",
  "probe-cases:duplicate-case",
  "probe-cases:duplicate-requirement",
  "probe-cases:duplicate-range",
  "probe-cases:range",
  "probe-cases:missing-requirements",
  "probe-cases:coverage",
  "probe-cases:reposition",
  "probe-cases:framing",
] as const;
export type PlanProbeCaseErrorCode = (typeof PLAN_PROBE_CASE_ERROR_CODES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** 原文の範囲として正しいか（0 以上・start <= end・原文の外に出ない） */
function isValidRange(source: string, start: number, end: number): boolean {
  return start >= 0 && start <= end && end <= source.length;
}

/** 題材 1 件の形を読む。形の誤りは `probe-cases:shape` にする（値を文に載せない） */
function readCase(value: unknown): PlanProbeCase | { readonly code: PlanProbeCaseErrorCode; readonly error: string } {
  if (!isRecord(value)) return { code: "probe-cases:shape", error: "題材は写像（object）であること" };
  const id = value["id"];
  const source = value["source"];
  if (typeof id !== "string" || id === "") {
    return { code: "probe-cases:shape", error: "題材の ID は空でない文字列であること" };
  }
  if (typeof source !== "string") {
    return { code: "probe-cases:shape", error: "題材の原文は文字列であること" };
  }
  const rawRequirements = value["requirements"];
  let requirements: PlanProbeRequirement[] | undefined;
  if (rawRequirements !== undefined) {
    if (!Array.isArray(rawRequirements)) {
      return { code: "probe-cases:shape", error: "要件の一覧は並び（array）であること" };
    }
    requirements = [];
    const seen = new Set<string>();
    for (const item of rawRequirements) {
      if (!isRecord(item)) return { code: "probe-cases:shape", error: "要件は写像（object）であること" };
      const requirementId = item["id"];
      const text = item["text"];
      const quote = item["quote"];
      const position = item["position"];
      if (
        typeof requirementId !== "string" ||
        requirementId === "" ||
        typeof text !== "string" ||
        typeof quote !== "string" ||
        !isRecord(position) ||
        !isInteger(position["start"]) ||
        !isInteger(position["end"])
      ) {
        return { code: "probe-cases:shape", error: "要件の欄（id・text・quote・position）の形が違います" };
      }
      if (seen.has(requirementId)) {
        return { code: "probe-cases:duplicate-requirement", error: "同じ題材の中で要件の ID が重複しています" };
      }
      seen.add(requirementId);
      requirements.push({
        id: requirementId,
        text,
        quote,
        position: { start: position["start"], end: position["end"] },
      });
    }
  }
  const rawRanges = value["ranges"];
  let ranges: PlanProbeRange[] | undefined;
  if (rawRanges !== undefined) {
    if (!Array.isArray(rawRanges)) {
      return { code: "probe-cases:shape", error: "原文の範囲の集合は並び（array）であること" };
    }
    ranges = [];
    const seen = new Set<string>();
    for (const item of rawRanges) {
      if (!isRecord(item)) return { code: "probe-cases:shape", error: "原文の範囲は写像（object）であること" };
      const rangeId = item["id"];
      const start = item["start"];
      const end = item["end"];
      if (typeof rangeId !== "string" || rangeId === "" || !isInteger(start) || !isInteger(end)) {
        return { code: "probe-cases:shape", error: "原文の範囲の欄（id・start・end）の形が違います" };
      }
      if (seen.has(rangeId)) {
        return { code: "probe-cases:duplicate-range", error: "同じ題材の中で原文の範囲の ID が重複しています" };
      }
      seen.add(rangeId);
      if (!isValidRange(source, start, end)) {
        return { code: "probe-cases:range", error: "原文の範囲が原文の外に出ています" };
      }
      ranges.push({ id: rangeId, start, end });
    }
  }
  const rawFraming = value["framing"];
  let framing: string[] | undefined;
  if (rawFraming !== undefined) {
    if (!Array.isArray(rawFraming)) {
      return { code: "probe-cases:shape", error: "枠の文の一覧は並び（array）であること" };
    }
    framing = [];
    for (const item of rawFraming) {
      if (typeof item !== "string" || item === "") {
        return { code: "probe-cases:shape", error: "枠の文は空でない文字列であること" };
      }
      framing.push(item);
    }
  }
  return {
    id,
    source,
    ...(requirements === undefined ? {} : { requirements }),
    ...(ranges === undefined ? {} : { ranges }),
    ...(framing === undefined ? {} : { framing }),
  };
}

/** 題材を、流す段に照らして検査する（`p2` は一覧の必須と、引用・位置のコードの検査を通す） */
function checkCaseForStage(
  probeCase: PlanProbeCase,
  stage: PlanProbeStage,
): { readonly code: PlanProbeCaseErrorCode; readonly error: string } | null {
  if (stage !== "p2") return null;
  if (probeCase.requirements === undefined || probeCase.requirements.length === 0) {
    return { code: "probe-cases:missing-requirements", error: "p2 の題材には要件の一覧が要ります" };
  }
  const list: RequirementList = {
    requirements: probeCase.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      quote: requirement.quote,
      position: { start: requirement.position.start, end: requirement.position.end },
    })),
    decisions: [],
    unresolved: [],
  };
  // 引用の実在（コードの検査）→ 位置を決め直さないこと、の順に見る。引用が原文に無い件は
  // `coverage`、引用は在るが渡した位置と決め直した位置が違う件は `reposition` として区別する。
  const misses = checkRequirementCoverage(probeCase.source, list);
  if (misses.some((miss) => miss.kind === "quote-not-found")) {
    return { code: "probe-cases:coverage", error: "p2 の一覧が、引用の実在のコードの検査に落ちます" };
  }
  for (const requirement of probeCase.requirements) {
    const decided = decideQuotePosition(probeCase.source, requirement.quote, requirement.position);
    if (
      decided === undefined ||
      decided.start !== requirement.position.start ||
      decided.end !== requirement.position.end
    ) {
      return { code: "probe-cases:reposition", error: "p2 の一覧の位置を、コードの検査が決め直します" };
    }
  }
  for (const quote of probeCase.framing ?? []) {
    if (decideQuotePosition(probeCase.source, quote, { start: 0, end: 0 }) === undefined) {
      return { code: "probe-cases:framing", error: "p2 の枠の文が、原文の中で 1 か所に決まりません" };
    }
  }
  return null;
}

/**
 * 題材の組の文字列を読む（Issue #956）。JSON・版・形・ID の重複・原文の外の範囲を**流す前に**確かめる。
 * 誤りは固定の符号と人の読む文で返す（例外にしない）。要件の一覧のコードの検査は `stage` を知る
 * `validatePlanProbeCaseSet` が行う。
 */
export function parsePlanProbeCases(text: string): PlanProbeCaseSetParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { code: "probe-cases:json", error: "題材の組が JSON として読めません" };
  }
  if (!isRecord(value)) return { code: "probe-cases:shape", error: "題材の組は写像（object）であること" };
  if (value["schema_version"] !== PLAN_PROBE_CASES_SCHEMA) {
    return { code: "probe-cases:schema", error: `題材の組の版が違います（${PLAN_PROBE_CASES_SCHEMA} を期待）` };
  }
  const casesVersion = value["cases_version"];
  if (typeof casesVersion !== "string" || casesVersion === "") {
    return { code: "probe-cases:shape", error: "組の版（cases_version）は空でない文字列であること" };
  }
  const rawCases = value["cases"];
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    return { code: "probe-cases:shape", error: "題材の並び（cases）は 1 件以上であること" };
  }
  const cases: PlanProbeCase[] = [];
  const seen = new Set<string>();
  for (const raw of rawCases) {
    const read = readCase(raw);
    if ("code" in read) return read;
    if (seen.has(read.id)) {
      return { code: "probe-cases:duplicate-case", error: "題材の ID が重複しています" };
    }
    seen.add(read.id);
    cases.push(read);
  }
  return { cases: { schema_version: PLAN_PROBE_CASES_SCHEMA, cases_version: casesVersion, cases } };
}

/**
 * 題材の組を、流す段に照らして検査する（Issue #956）。**1 件でも誤りがあれば、呼び出し 0 回で断る**。
 * 要件の一覧のコードの検査（引用の実在・位置）と、検査が位置を決め直す件もここで断る。
 */
export function validatePlanProbeCaseSet(
  cases: PlanProbeCaseSet,
  stage: PlanProbeStage,
): { readonly code: PlanProbeCaseErrorCode; readonly error: string } | null {
  for (const probeCase of cases.cases) {
    const checked = checkCaseForStage(probeCase, stage);
    if (checked !== null) return checked;
  }
  return null;
}

/** 1 回の走りの状態 */
export const PLAN_PROBE_RUN_STATES = ["ok", "failed", "not-run"] as const;
export type PlanProbeRunState = (typeof PLAN_PROBE_RUN_STATES)[number];

/** 後続を止めた理由（固定の符号） */
export const PLAN_PROBE_STOP_REASONS = [
  "budget",
  "deadline",
  "call-limit",
  "malformed",
  "usage-unknown",
  "timeout",
  "network",
  "http",
  "balance",
  "refused",
  "tool-arguments",
  "invalid-request",
  "incomplete",
  "limit",
  "unmet",
  "unknown",
] as const;
export type PlanProbeStopReason = (typeof PLAN_PROBE_STOP_REASONS)[number];

/** 保存する失敗の分類（値・本文を持たない） */
export interface PlanProbeFailureRecord {
  readonly kind: StageFailure["kind"];
  readonly operation: ReverseCheckOperation | null;
  readonly limit: string | null;
  readonly max: number | null;
  readonly actual: number | null;
  readonly attempts: number | null;
  readonly code: string | null;
}

/** 生の範囲 1 つ（P2 が返した範囲と、残った断片） */
export interface PlanProbeReportedRange {
  readonly start: number;
  readonly end: number;
  readonly destination: string;
  readonly fragments: readonly { readonly start: number; readonly end: number }[];
}

/** コードが見つけた落ち 1 件 */
export interface PlanProbeCodeMiss {
  readonly kind: string;
  readonly requirement: number | null;
  readonly range: { readonly start: number; readonly end: number } | null;
}

/** 1 往復の P2 の記録（値の本文ではなく、範囲・断片・分類だけ） */
export interface PlanProbeP2Round {
  readonly fix: string;
  readonly list_sha256: string;
  readonly raw_ranges: readonly PlanProbeReportedRange[];
  readonly code_misses: readonly PlanProbeCodeMiss[];
  readonly remaining_fragments: readonly { readonly start: number; readonly end: number }[];
  readonly condition_findings: unknown;
}

/** P2 の記録 */
export interface PlanProbeP2Record {
  readonly quotes_valid: boolean | null;
  readonly raw_ranges: readonly PlanProbeReportedRange[];
  readonly code_misses: readonly PlanProbeCodeMiss[];
  readonly remaining_fragments: readonly { readonly start: number; readonly end: number }[];
  readonly rounds: readonly PlanProbeP2Round[];
}

/** 得た一覧の全体（本文・引用・位置・枠・決定・未解決） */
export interface PlanProbeListRecord {
  readonly requirements: readonly PlanProbeRequirement[];
  readonly framing: readonly PlanProbeRequirement[];
  readonly decisions: readonly string[];
  readonly unresolved: readonly string[];
}

/** 重なりの観測（**合否ではない**） */
export interface PlanProbeOverlap {
  readonly range_id: string;
  readonly requirement_ids: readonly string[];
  /** 残った断片。状態が `ok` でない、または P2 が無い回は観測できないので `null` */
  readonly remaining_fragments: readonly { readonly start: number; readonly end: number }[] | null;
}

/** 1 回ごとの記録（`--out` の `run-NNNN.json`） */
export interface PlanProbeRunRecord {
  readonly schema_version: string;
  readonly stage: PlanProbeStage;
  readonly case_id: string;
  readonly run: number;
  readonly state: PlanProbeRunState;
  /** その回で止まった理由（止まらずに終われば `null`。後続を止めたかは理由の種類で決まる） */
  readonly stop_reason: PlanProbeStopReason | null;
  readonly source_sha256: string;
  /** 送った要求 1 つずつの SHA-256（送った順） */
  readonly request_sha256: readonly string[];
  /** 得た一覧（止まった回は、止まるまでに得た一覧。無ければ `null`） */
  readonly list: PlanProbeListRecord | null;
  readonly list_sha256: string | null;
  readonly p2: PlanProbeP2Record | null;
  /** 往復の trace（往復が無ければ `null`） */
  readonly trace: unknown;
  /** 落ちの内訳（往復が無ければ `null`） */
  readonly diagnosis: ReverseCheckDiagnosis | null;
  /**
   * 段の呼び出しの数。**Plan の記録の `calls` と同じなのは `calls` のほう**で、こちらは
   * `calls` から形のやり直しの数（`shape_retries`）を引いた値である。**通信の再試行は除かない**
   * ——usage の数え方のままで、1 回の論理呼び出しが再送で複数回に数えられうる。
   */
  readonly stage_calls: number;
  /** 形のやり直しの数（`stage_calls` と `calls` の差。段の呼び出しとは別に数える） */
  readonly shape_retries: number;
  /**
   * **Plan の記録の `calls` と同じ欄**。usage が見た呼び出しの数で、形のやり直しと
   * 通信の再試行を**どちらも含む**（`usageDelta(...).calls` と同じ数え方）。
   */
  readonly calls: number;
  readonly usage: UsageSnapshot;
  readonly cost_usd: number;
  /** usage が返らず、予約が戻らなかったか */
  readonly usage_unknown: boolean;
  readonly failure: PlanProbeFailureRecord | null;
  /** 範囲の重なりの観測。一覧が無い回は `null` */
  readonly overlaps: readonly PlanProbeOverlap[] | null;
}

/** 集計の 1 件（題材ごと） */
export interface PlanProbeCaseSummary {
  readonly case_id: string;
  readonly planned: number;
  readonly completed: number;
  readonly failed: number;
  readonly not_run: number;
}

/** 集計（`--out` の `summary.json`） */
export interface PlanProbeSummary {
  readonly schema_version: string;
  readonly stage: PlanProbeStage;
  readonly cases_version: string;
  readonly repeat: number;
  readonly planned: number;
  readonly completed: number;
  readonly failed: number;
  readonly not_run: number;
  readonly stops: readonly { readonly case_id: string; readonly run: number; readonly reason: PlanProbeStopReason }[];
  readonly cases: readonly PlanProbeCaseSummary[];
  readonly cost: {
    readonly budget_usd: number;
    readonly spent_usd: number;
    readonly reserved_usd: number;
    readonly usage_unknown_runs: number;
  };
}

/** 条件の記録（`--out` の `conditions.json`） */
export interface PlanProbeConditions {
  readonly schema_version: string;
  readonly stage: PlanProbeStage;
  readonly cases_version: string;
  readonly case_set_sha256: string;
  /** 題材の組のファイルのバイト列の SHA-256 */
  readonly case_file_sha256: string;
  readonly documents: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[];
  readonly sources: readonly { readonly case_id: string; readonly sha256: string }[];
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly repeat: number;
  readonly budget_usd: number;
  readonly deadline_ms: number;
  readonly limits: AgentLimits;
  readonly rates: TokenRates;
  readonly selections: typeof PLAN_REVERSE_CHECK_SELECTIONS;
}

/** 走りの入力 */
export interface PlanProbeInput {
  readonly stage: PlanProbeStage;
  readonly cases: PlanProbeCaseSet;
  readonly documents: readonly PromptDocument[];
  readonly client: LlmClient;
  readonly budgetUsd: number;
  readonly deadline: number;
  readonly now: () => number;
  readonly rates: TokenRates;
  readonly effort: string;
  readonly repeat: number;
  readonly limits?: AgentLimits;
  readonly callTimeoutMs?: number;
  /** 完了した回ごとに呼ばれる（途中で止まっても、完了した回はここまでに残る） */
  readonly onRun?: (record: PlanProbeRunRecord) => void | Promise<void>;
}

/** 走りの結果 */
export interface PlanProbeResult {
  readonly runs: readonly PlanProbeRunRecord[];
  readonly summary: PlanProbeSummary;
  readonly caseSetSha256: string;
  readonly sourceSha256: Readonly<Record<string, string>>;
}

/** 一覧を、記録の形（本文・引用・位置・枠・決定・未解決）に写す */
function toListRecord(list: RequirementList): PlanProbeListRecord {
  return {
    requirements: list.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      quote: requirement.quote,
      position: { start: requirement.position.start, end: requirement.position.end },
    })),
    framing: (list.framing ?? []).map((frame) => ({
      id: "",
      text: "",
      quote: frame.quote,
      position: { start: frame.position.start, end: frame.position.end },
    })),
    decisions: list.decisions.slice(),
    unresolved: list.unresolved.slice(),
  };
}

/** 要件の一覧の SHA-256（P2 が要求に載せる文と同じ組み立て） */
function listSha256Of(list: RequirementList): Promise<string> {
  return sha256Hex(serializeJson({ ...list, framing: list.framing ?? [] }));
}

/** 失敗を、値を持たない記録に写す */
function toFailureRecord(failure: StageFailure, operation?: ReverseCheckOperation): PlanProbeFailureRecord {
  const limited = failure.kind === "limit" || failure.kind === "callLimit" ? failure : null;
  return {
    kind: failure.kind,
    operation: operation ?? null,
    limit: limited === null ? null : limited.limit,
    max: limited === null ? null : limited.max,
    actual: limited === null ? null : limited.actual,
    attempts: "attempts" in failure ? failure.attempts : null,
    code: failure.kind === "invalidRequest" ? failure.code : null,
  };
}

/** 止まった理由を、固定の符号に写す */
export function planProbeStopReasonOf(failure: StageFailure): PlanProbeStopReason {
  if (failure.kind === "budget") return "budget";
  if (failure.kind === "deadline") return "deadline";
  if (failure.kind === "callLimit") return "call-limit";
  if (failure.kind === "malformed") return "malformed";
  if (failure.kind === "toolArguments") return "tool-arguments";
  if (failure.kind === "invalidRequest") return "invalid-request";
  if (failure.kind === "refused") return "refused";
  if (failure.kind === "limit") return "limit";
  return failure.kind;
}

/** P2 の trace から、範囲・断片・コードの落ち・条件の指摘を写す */
function toP2Record(trace: ReverseCheckTrace | undefined, quotesValid: boolean | null): PlanProbeP2Record | null {
  if (trace === undefined) return null;
  const rounds: PlanProbeP2Round[] = trace.rounds.map((round) => ({
    fix: round.fix,
    list_sha256: round.listSha256,
    raw_ranges: round.reported.map((entry) => ({
      start: entry.range.start,
      end: entry.range.end,
      destination: entry.destination,
      fragments: entry.fragments.map((fragment) => ({ start: fragment.start, end: fragment.end })),
    })),
    code_misses: round.codeMisses.map((miss) => ({
      kind: miss.kind,
      requirement: miss.requirement,
      range: miss.range === null ? null : { start: miss.range.start, end: miss.range.end },
    })),
    remaining_fragments: round.reported.flatMap((entry) =>
      entry.destination === "remaining" ? entry.fragments.map((fragment) => ({ start: fragment.start, end: fragment.end })) : [],
    ),
    condition_findings: round.conditionFindings ?? null,
  }));
  return {
    quotes_valid: quotesValid,
    raw_ranges: rounds[rounds.length - 1]?.raw_ranges ?? [],
    code_misses: rounds[rounds.length - 1]?.code_misses ?? [],
    remaining_fragments: rounds[rounds.length - 1]?.remaining_fragments ?? [],
    rounds,
  };
}

/** 位置が重なるか */
function overlaps(left: { readonly start: number; readonly end: number }, right: { readonly start: number; readonly end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * 範囲ごとの重なりを観測する（**合否ではない**）。範囲に重なる要件の ID と、P2 の残った断片を機械的に返す。
 * 一覧が無い回は `null`（観測していない）。状態が `ok` でない回、または P2 が無い回は、断片を `null` にする
 * ——「残った断片が 0 件」と「観測できなかった」を混ぜない。重なりの有無で、状態・集計は変えない。
 */
export function observePlanProbeOverlaps(
  ranges: readonly PlanProbeRange[] | undefined,
  list: RequirementList | null,
  p2: PlanProbeP2Record | null,
  state: PlanProbeRunState,
): readonly PlanProbeOverlap[] | null {
  if (list === null) return null;
  if (ranges === undefined) return [];
  const observed = state === "ok" && p2 !== null;
  return ranges.map((range) => {
    const requirementIds = list.requirements
      .filter((requirement) => overlaps(requirement.position, range))
      .map((requirement) => requirement.id);
    const remainingFragments = !observed
      ? null
      : p2.remaining_fragments.filter((fragment) => overlaps(fragment, range));
    return { range_id: range.id, requirement_ids: requirementIds, remaining_fragments: remainingFragments };
  });
}

/** 要求を記録する包み（`gateway` が adapter へ送った要求を、送った順に残す） */
interface RequestRecorder {
  readonly client: LlmClient;
  readonly requests: LlmStructuredRequest[];
}

function createRequestRecorder(client: LlmClient): RequestRecorder {
  const requests: LlmStructuredRequest[] = [];
  return {
    requests,
    client: {
      async callStructured<T>(request: LlmStructuredRequest) {
        requests.push(request);
        return client.callStructured<T>(request);
      },
      callWithTools: (request) => client.callWithTools(request),
    },
  };
}

/** usage が返らず予約が戻らなかったか（金額の丸めで誤判定しないよう、ごく小さい差は無視する） */
function hasUnsettledReservation(before: number, after: number): boolean {
  return after - before > 1e-12;
}

/** 段の呼び出し（p1・p2・loop）の結果を、1 回の記録に組む */
interface StageRunOutcome {
  readonly list: RequirementList | null;
  readonly p2: PlanProbeP2Record | null;
  readonly trace: ReverseCheckTrace | undefined;
  readonly diagnosis: ReverseCheckDiagnosis | null;
  readonly failure: PlanProbeFailureRecord | null;
  readonly stopReason: PlanProbeStopReason | null;
}

/** 題材の枠の文を、原文の中の 1 か所の位置へ決める（流す前の検査が決まることを保証する） */
function framingOf(probeCase: PlanProbeCase): readonly Framing[] {
  return (probeCase.framing ?? []).map((quote) => {
    const position = decideQuotePosition(probeCase.source, quote, { start: 0, end: 0 });
    if (position === undefined) throw new RangeError("枠の文の位置が 1 か所に決まりません");
    return { quote, position };
  });
}

/**
 * 題材 1 件を 1 回流す（段に依らず、同じ共通の口を使う）。**Plan の経路と同じ関数・同じ選択**を呼ぶ。
 */
async function runStage(
  input: PlanProbeInput,
  probeCase: PlanProbeCase,
  gateway: CallGateway,
  findingCheckGateway: CallGateway,
): Promise<StageRunOutcome> {
  if (input.stage === "p1") {
    const outcome = await runRequirements({
      source: probeCase.source,
      documents: input.documents,
      gateway,
      conditionRule: PLAN_REVERSE_CHECK_SELECTIONS.conditionRule,
    });
    if (!outcome.ok) {
      return { list: null, p2: null, trace: undefined, diagnosis: null, failure: toFailureRecord(outcome.failure), stopReason: planProbeStopReasonOf(outcome.failure) };
    }
    return { list: outcome.value, p2: null, trace: undefined, diagnosis: null, failure: null, stopReason: null };
  }
  if (input.stage === "p2") {
    // P1 の正規化が付ける欄（`framing`・`positionCorrections`）まで同じ順で組み、Plan の初回の P2 へ
    // 渡る一覧とバイト列で同じにする（Issue #956）。要件は渡された一覧のまま送り、枠の文は原文の中の
    // 1 か所に決まる位置を付ける（`validatePlanProbeCaseSet` が流す前に確かめる）。
    const list: RequirementList = {
      requirements: (probeCase.requirements ?? []).map(
        (requirement): Requirement => ({
          id: requirement.id,
          text: requirement.text,
          quote: requirement.quote,
          position: { start: requirement.position.start, end: requirement.position.end },
        }),
      ),
      framing: framingOf(probeCase),
      decisions: [],
      unresolved: [],
      positionCorrections: 0,
    };
    const outcome = await runReverseCheckWithDiagnosis({
      source: probeCase.source,
      list,
      documents: input.documents,
      gateway,
      fix: "initial",
      ...PLAN_REVERSE_CHECK_SELECTIONS,
    });
    if (!outcome.ok) {
      return { list, p2: null, trace: undefined, diagnosis: null, failure: toFailureRecord(outcome.failure), stopReason: planProbeStopReasonOf(outcome.failure) };
    }
    return {
      list,
      p2: toP2Record(
        { sourceSha256: await sha256Hex(probeCase.source), sourceLength: probeCase.source.length, rounds: [outcome.value.trace] },
        outcome.value.result.quotesValid,
      ),
      trace: { sourceSha256: await sha256Hex(probeCase.source), sourceLength: probeCase.source.length, rounds: [outcome.value.trace] },
      diagnosis: null,
      failure: null,
      stopReason: null,
    };
  }
  const outcome = await runReverseCheckLoopWithOperation({
    source: probeCase.source,
    documents: input.documents,
    gateway,
    // Plan と同じ選択（指摘の確かめを含む。Issue #967）。確かめ役は**門を持たない口**を通す。
    ...PLAN_REVERSE_CHECK_SELECTIONS,
    findingCheckGateway,
  });
  if (!outcome.ok) {
    return {
      list: null,
      p2: toP2Record(outcome.trace, null),
      trace: outcome.trace,
      diagnosis: outcome.diagnosis,
      failure: toFailureRecord(outcome.failure, outcome.operation),
      stopReason: planProbeStopReasonOf(outcome.failure),
    };
  }
  return {
    list: outcome.value.list,
    p2: toP2Record(outcome.value.trace, outcome.value.report.quotesValid),
    trace: outcome.value.trace,
    diagnosis: outcome.value.diagnosis,
    failure: null,
    stopReason: null,
  };
}

/** 題材の組の SHA-256（条件の記録に載せる。`case_set_sha256`） */
export function planProbeCaseSetSha256(cases: PlanProbeCaseSet): Promise<string> {
  return sha256Hex(serializeJson(cases));
}

/** 題材ごとの原文の SHA-256（条件の記録に載せる） */
export async function planProbeSourceSha256(cases: PlanProbeCaseSet): Promise<Record<string, string>> {
  const sha256: Record<string, string> = {};
  for (const probeCase of cases.cases) {
    sha256[probeCase.id] = await sha256Hex(probeCase.source);
  }
  return sha256;
}

/**
 * 探針の本体（Issue #956）。予算・usage・記録の包みは起動の全体で 1 つを共有し、**逐次に**流す。
 * 門（呼び出しの上限）と `CallGateway` は**回ごとに作り直す**——1 回は 1 つの Plan の走りに当たるので、
 * 呼び出しの上限も回ごとに数え直す。締切は起動の全体の絶対時刻で、回を始める前に過ぎていれば、その回と
 * 残りを `not-run` にする。
 *
 * 状態は、1 回も呼ばずに予算・締切・呼び出しの上限で断った回を `not-run`、1 回でも呼んでから止まった回を
 * `failed`、止まらずに終わった回を `ok` とする。後続を止めるのは、起動の全体に効く理由（予算・締切・
 * usage 不明と、その他の失敗）だけである。呼び出しの上限は回ごとなので後続を止めない。
 */
export async function runPlanProbe(input: PlanProbeInput): Promise<PlanProbeResult> {
  const limits = input.limits ?? AGENT_LIMITS;
  const meter = new UsageMeter();
  const budget = new JobBudget(input.budgetUsd);
  const recorder = createRequestRecorder(meter.wrap(input.client));

  const runs: PlanProbeRunRecord[] = [];
  const sourceSha256 = await planProbeSourceSha256(input.cases);
  let stopped: PlanProbeStopReason | null = null;
  for (const probeCase of input.cases.cases) {
    for (let run = 1; run <= input.repeat; run += 1) {
      if (stopped !== null) {
        const record = notRunRecord(input, probeCase, run, stopped, sourceSha256[probeCase.id] ?? "");
        runs.push(record);
        await input.onRun?.(record);
        continue;
      }
      // 締切は起動の全体のもの。回を始める前に過ぎていれば、この回も残りも `not-run` にする。
      if (input.now() >= input.deadline) {
        stopped = "deadline";
        const record = notRunRecord(input, probeCase, run, stopped, sourceSha256[probeCase.id] ?? "");
        runs.push(record);
        await input.onRun?.(record);
        continue;
      }

      // 門と口は回ごとに作り直す（予算・usage・記録の包みは起動の全体で共有する）。
      const gate = createCallGate({ now: input.now, deadline: input.deadline, limit: limits.callCount });
      const gateway = new CallGateway({
        client: recorder.client,
        budget,
        rates: input.rates,
        now: input.now,
        deadline: input.deadline,
        limits,
        effort: input.effort,
        gate,
        ...(input.callTimeoutMs === undefined ? {} : { callTimeoutMs: input.callTimeoutMs }),
      });
      // 確かめ役の口（Issue #967）。Plan と同じく総呼び出しの門を持たない。
      const findingCheckGateway = new CallGateway({
        client: recorder.client,
        budget,
        rates: input.rates,
        now: input.now,
        deadline: input.deadline,
        limits,
        effort: input.effort,
        ...(input.callTimeoutMs === undefined ? {} : { callTimeoutMs: input.callTimeoutMs }),
      });

      const beforeUsage = meter.snapshot;
      const beforeCounts: CallCounts = gateway.counts;
      const beforeRequests = recorder.requests.length;
      const beforeSpent = budget.spentUsd;
      const beforeReserved = budget.reservedUsd;

      let outcome: StageRunOutcome;
      try {
        outcome = await runStage(input, probeCase, gateway, findingCheckGateway);
      } catch {
        outcome = {
          list: null,
          p2: null,
          trace: undefined,
          diagnosis: null,
          failure: { kind: "unknown", operation: null, limit: null, max: null, actual: null, attempts: null, code: null },
          stopReason: "unknown",
        };
      }

      const calls = callCountsDelta(beforeCounts, gateway.counts);
      const usage = usageDelta(beforeUsage, meter.snapshot);
      const usageUnknown = hasUnsettledReservation(beforeReserved, budget.reservedUsd);
      const list = outcome.list;
      const p2 = outcome.p2;
      /** 1 回も呼ばずに断った回は `not-run`、1 回でも呼んでから止まった回は `failed` */
      const state: PlanProbeRunState =
        outcome.failure === null ? "ok" : calls.attempts.started === 0 ? "not-run" : "failed";
      const stopReason = outcome.stopReason ?? (usageUnknown ? "usage-unknown" : null);
      const record: PlanProbeRunRecord = {
        schema_version: PLAN_PROBE_RUN_SCHEMA,
        stage: input.stage,
        case_id: probeCase.id,
        run,
        state,
        stop_reason: stopReason,
        source_sha256: sourceSha256[probeCase.id] ?? "",
        request_sha256: await Promise.all(
          recorder.requests.slice(beforeRequests).map((request) => sha256Hex(JSON.stringify(request))),
        ),
        list: list === null ? null : toListRecord(list),
        list_sha256: list === null ? null : await listSha256Of(list),
        p2,
        trace: outcome.trace ?? null,
        diagnosis: outcome.diagnosis,
        stage_calls: Math.max(0, usage.calls - calls.retries.shape),
        shape_retries: calls.retries.shape,
        calls: usage.calls,
        usage,
        cost_usd: budget.spentUsd - beforeSpent,
        usage_unknown: usageUnknown,
        failure: outcome.failure,
        overlaps: observePlanProbeOverlaps(probeCase.ranges, list, p2, state),
      };
      runs.push(record);
      await input.onRun?.(record);
      // 呼び出しの上限は回ごとの門なので、その失敗は後続を止めない（次の回は 0 から数える）。
      if (stopReason !== null && stopReason !== "call-limit") stopped = stopReason;
    }
  }

  return {
    runs,
    summary: buildPlanProbeSummary(input, runs, budget),
    caseSetSha256: await planProbeCaseSetSha256(input.cases),
    sourceSha256,
  };
}

/** 未実行の回の記録（状態と停止の理由を残す。一覧・費用は持たない） */
function notRunRecord(
  input: PlanProbeInput,
  probeCase: PlanProbeCase,
  run: number,
  reason: PlanProbeStopReason,
  sourceSha256: string,
): PlanProbeRunRecord {
  return {
    schema_version: PLAN_PROBE_RUN_SCHEMA,
    stage: input.stage,
    case_id: probeCase.id,
    run,
    state: "not-run",
    stop_reason: reason,
    source_sha256: sourceSha256,
    request_sha256: [],
    list: null,
    list_sha256: null,
    p2: null,
    trace: null,
    diagnosis: null,
    stage_calls: 0,
    shape_retries: 0,
    calls: 0,
    usage: {
      calls: 0,
      missing_usage_calls: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
    },
    cost_usd: 0,
    usage_unknown: false,
    failure: null,
    overlaps: null,
  };
}

/**
 * 集計を組む（Issue #956）。予定・完了・失敗・未実行を分けて数え、停止の理由と費用を残す。
 * **採点の数（保持率・検出率）は出さない。** 重なりの有無では何も変えない。
 */
export function buildPlanProbeSummary(
  input: Pick<PlanProbeInput, "stage" | "cases" | "repeat" | "budgetUsd">,
  runs: readonly PlanProbeRunRecord[],
  budget: JobBudget,
): PlanProbeSummary {
  const cases = input.cases.cases.map((probeCase): PlanProbeCaseSummary => {
    const own = runs.filter((record) => record.case_id === probeCase.id);
    return {
      case_id: probeCase.id,
      planned: own.length,
      completed: own.filter((record) => record.state === "ok").length,
      failed: own.filter((record) => record.state === "failed").length,
      not_run: own.filter((record) => record.state === "not-run").length,
    };
  });
  return {
    schema_version: PLAN_PROBE_SUMMARY_SCHEMA,
    stage: input.stage,
    cases_version: input.cases.cases_version,
    repeat: input.repeat,
    planned: runs.length,
    completed: runs.filter((record) => record.state === "ok").length,
    failed: runs.filter((record) => record.state === "failed").length,
    not_run: runs.filter((record) => record.state === "not-run").length,
    stops: runs.flatMap((record) =>
      record.stop_reason === null ? [] : [{ case_id: record.case_id, run: record.run, reason: record.stop_reason }],
    ),
    cases,
    cost: {
      budget_usd: input.budgetUsd,
      spent_usd: budget.spentUsd,
      reserved_usd: budget.reservedUsd,
      usage_unknown_runs: runs.filter((record) => record.usage_unknown).length,
    },
  };
}

/** 起動ごとの条件を組む（鍵・環境変数の値は残さない） */
export async function buildPlanProbeConditions(input: {
  readonly stage: PlanProbeStage;
  readonly cases: PlanProbeCaseSet;
  readonly caseSetSha256: string;
  readonly caseFileSha256: string;
  readonly documents: readonly PromptDocument[];
  readonly sourceSha256: Readonly<Record<string, string>>;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly repeat: number;
  readonly budgetUsd: number;
  readonly deadlineMs: number;
  readonly limits: AgentLimits;
  readonly rates: TokenRates;
}): Promise<PlanProbeConditions> {
  return {
    schema_version: PLAN_PROBE_CONDITIONS_SCHEMA,
    stage: input.stage,
    cases_version: input.cases.cases_version,
    case_set_sha256: input.caseSetSha256,
    case_file_sha256: input.caseFileSha256,
    documents: await Promise.all(
      input.documents.map(async (document) => ({
        name: document.name,
        bytes: utf8Bytes(document.text),
        sha256: await sha256Hex(document.text),
      })),
    ),
    sources: input.cases.cases.map((probeCase) => ({
      case_id: probeCase.id,
      sha256: input.sourceSha256[probeCase.id] ?? "",
    })),
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    repeat: input.repeat,
    budget_usd: input.budgetUsd,
    deadline_ms: input.deadlineMs,
    limits: input.limits,
    rates: input.rates,
    selections: PLAN_REVERSE_CHECK_SELECTIONS,
  };
}

/** 文字列の UTF-8 のバイト数 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
