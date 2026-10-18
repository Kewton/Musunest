// 今の v1.1α の経路の呼び出し数の回帰の契約試験（08-architecture-v1.2.md §9 の手 2 の前提・Issue #546）。
//
// **これは今の v1.1α（段を束に分けない）の呼び出し数の回帰の試験である。** 設計書 §4.1 の束の契約試験（要件 5 件ごとの
// T1・13 試験ごとの束・段別の論理の枠・生成と判定の共通の門・判定の枝）は、段を束に分ける手 3 の前提として残す。
// ここは §4.1 の前提を満たしたとは言わない。また v1.2 専用の上限の表（論理 72・実試行 144・判定 80）も手 3 で足す。
// ここでは v1・v1.1α の上限の値（`AGENT_LIMITS`）と配線を変えない。
//
// 偽物の LLM（記録した応答）・偽物の判定・固定の時計で、`runGenerationV11a` を要件 N・試験 M の大きさ
// （`__tests__/sizes.ts`の生成器。中央値 15・39 と観測した最大 25・68）で流し、呼び出しを**別々に**数える：
//
//   - 論理要求 … 段のコードが組んだ要求の数（初回・形のやり直し・中身のやり直し・修復・裁定）。試験側の偽物の口が、
//     要求の中身（schema 名・道具付きか）から段を、通信の再送でない要求を数えて出す。**1 回も始められなかった要求
//     （門で未着手）は口に届かないので、ここには数えない**——その数は段の記録の `not_started.limit` で別に読む
//   - 実開始 … 共通の口が実際に始めた試行（段の記録の `attempts.started`。通信の再送を含む）
//   - 応答 … 使用量の計器が数えた応答（段の記録の `calls`。通常の通信失敗は加算されず、未完了の応答は加算される
//     ので、論理要求と一致するとは限らない）
//   - 通信の再送 … 実開始のうち再送の数（段の記録の `retries.communication`）
//   - 判定 … 判定の口の呼び出し（偽物の判定が受けた要求の数。J4 は要件ごとに 1 要求・J2 は種類の食い違いの要件を
//     まとめて 1 要求。**門（`callCount`）に数えない**）
//
// 手 3p（08 §4.1・Issue #592）で、同じ数え方を**旗の組ごと**（全部 off／前の手の旗だけ on〔ledger・search-repair。ids off〕／
// 全部 on〔`--pipeline v1.2` と同じ組〕）に流す節と、旗 `v12.ids` の 3 層の枠（段ごとの論理の枠・生成と判定で共有する実試行の
// 門・判定の枝）の契約試験を足した。期待の表は段 × 旗の組の 1 つの表（`FLAG_SET_TABLE`）で、手 3a〜3c がそこへ C1・C2・C4 の
// 束の行を足す。旗 `v12.ids` の走りでは判定も門に数える（上の「判定」の行の「門に数えない」は旗 off の走りの話）。
//
// 外部の API は呼ばない。題材は抽象的なもので、受入の題材の言葉は使わない。
import { TEST_CASE_ID_PREFIX } from "../v12/test-cases.js";
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer } from "../judge.js";
import type { StageRecord } from "../record.js";
import type { LlmClient } from "../llm.js";
import { createFakeLlmClient, type RecordedCall } from "../llm-fake.js";
import { AGENT_LIMITS } from "../limits.js";
import { estimateMaxCostUsd, type TokenRates } from "../budget.js";
import { estimateInputUpperBoundTokens, structuredInputParts } from "../call.js";
import type { LlmStructuredRequest } from "../llm.js";
import { DEFAULT_BUDGET_USD, DEFAULT_RATES } from "../cli.js";
import { DIAGNOSTICS_REJECTED_TEST_SPEC_FILE } from "../bundle.js";
import { USAGE, RATES } from "../__tests__/run.js";
import { ARBITRATION_SCHEMA_NAME } from "../stages/arbitrate.js";
import {
  FIXTURE_DOCUMENTS,
  bundledT2Client,
  negative,
  recordedStructured,
  requestListedIds,
  requestRetainedIds,
  withCodeIds,
} from "./__tests__/fixtures.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import { buildSized, CODE_WRITTEN_TEST_COUNT, MAX_SIZE, MEDIAN_SIZE, type SizedMaterials } from "./__tests__/sizes.js";
import { isGeneratedTestId } from "../v12/generated-tests.js";
import { runGenerationV11a, runStageRangeV11a } from "./run.js";
import { createFallbackJudge } from "../judge.js";
import { FIELD_REPAIR_SCHEMA_NAME } from "../v12/stages/field-repair.js";
import { MAPPING_SCHEMA_NAME } from "../v12/stages/mapping.js";
import { VOCABULARY_SCHEMA_NAMES } from "../v12/stages/vocabulary.js";
import { fromPublicV12Flags, V12_PIPELINE_FLAGS, type V12Flags } from "../v12/ledger.js";
import {
  V12_CALL_LIMITS,
  V12_T2_BUNDLE,
  V12_STAGE_FRAMES,
  V12_V11A_FRAME_MAP,
  type V12CallLimits,
  type V12FrameStage,
} from "../v12/limits.js";
import { DECL_CHECK_SCHEMA_NAME } from "./stages/decl-check.js";
import { NAME_TABLE_SCHEMA_NAME } from "./stages/name-table.js";
import { SEMANTIC_CHECK_SCHEMA_NAME } from "./stages/semantic-check.js";
import { TEST_SPEC_RETRY_DATA_NAMES, TEST_SPEC_SCHEMA_NAME } from "./stages/test-spec.js";
import { WRITE_V11A_SCHEMA_NAME } from "./stages/write.js";

// ── 偽物の口と観測 ─────────────────────────────────────────────────

/** 数える段（段の記録の `stage` と同じ名前） */
const STAGES = ["name-table", "semantic-check", "test-spec", "write", "decl-check", "repair", "arbitration"] as const;
/** 数える段の全部（v1.1α の段に、旗 v12.ids の C1・C2 の段を足す。Issue #593） */
const COUNTED_STAGES = [...STAGES, "vocabulary", "mapping"] as const;
type StageKey = (typeof COUNTED_STAGES)[number];

const STAGE_BY_SCHEMA: Readonly<Record<string, StageKey>> = {
  [NAME_TABLE_SCHEMA_NAME]: "name-table",
  [SEMANTIC_CHECK_SCHEMA_NAME]: "semantic-check",
  [TEST_SPEC_SCHEMA_NAME]: "test-spec",
  [WRITE_V11A_SCHEMA_NAME]: "write",
  [DECL_CHECK_SCHEMA_NAME]: "decl-check",
  [ARBITRATION_SCHEMA_NAME]: "arbitration",
  // 旗 v12.search-repair の欄だけの直し（構造化出力。段の ID は repair のまま。Issue #553）
  [FIELD_REPAIR_SCHEMA_NAME]: "repair",
  // 旗 v12.ids の C1 の 3 束と C2（Issue #593）
  ...Object.fromEntries(Object.values(VOCABULARY_SCHEMA_NAMES).map((name) => [name, "vocabulary" as const])),
  [MAPPING_SCHEMA_NAME]: "mapping",
};

type StageCounts = Record<StageKey, number>;
const zeroCounts = (): StageCounts => ({
  "name-table": 0,
  "semantic-check": 0,
  "test-spec": 0,
  write: 0,
  "decl-check": 0,
  repair: 0,
  arbitration: 0,
  vocabulary: 0,
  mapping: 0,
});

/** 通信の失敗（共通の口が `network` と分類し、長くした timeout でやり直す） */
const networkError = (): Error => Object.assign(new Error("fetch が失敗しました"), { kind: "network" });

/**
 * 偽物の口。記録した応答を順に返す偽物の LlmClient を包み、要求の中身から段を引いて数える。
 * `failFirst` が真なら、**各論理要求の 1 回目の試行を通信の失敗にし、2 回目（再送）を成功にする**
 * （失敗した試行は記録の応答を使わない）。再送かどうかは「同じ要求の直前の試行が失敗したか」で決める。
 */
function createMouth(
  recorded: readonly RecordedCall[],
  failFirst: boolean,
  bySchema?: Readonly<Record<string, readonly RecordedCall[]>>,
  home?: readonly (readonly [string, string])[],
) {
  // `bySchema` を渡すと、要求の schema 名ごとの記録から順に返す（段の数が走りで変わる二点測定用。Issue #594）
  const routed =
    bySchema === undefined
      ? undefined
      : new Map(Object.entries(bySchema).map(([name, calls]) => [name, bundledT2Client(createFakeLlmClient(calls, { validateAgainstSchema: true }), home)] as const));
  // 旗 v12.ids の T2 は束ごとに同時に呼ぶので、記録した T2 の応答を束ごとに独立に読んで絞る（順序に依らない。Issue #626）
  const ordered = bundledT2Client(createFakeLlmClient(recorded, { validateAgainstSchema: true }), home);
  const inner: LlmClient = {
    callStructured: (request) => (routed?.get(request.schemaName) ?? ordered).callStructured(request),
    callWithTools: (request) => ordered.callWithTools(request),
  };
  const logical = zeroCounts();
  const started = zeroCounts();
  const requests: string[] = [];
  // 再送かどうかは「同じ要求の直前の試行が失敗したか」で決める（旗 v12.ids の T2 の束は同時に走るので、要求ごとに持つ。Issue #626）
  const retrying = new Set<string>();
  const enter = (stage: StageKey, key: string): void => {
    started[stage] += 1;
    if (retrying.delete(key)) return;
    logical[stage] += 1;
    if (failFirst) {
      retrying.add(key);
      throw networkError();
    }
  };
  const stageOf = (schemaName: string): StageKey => {
    const stage = STAGE_BY_SCHEMA[schemaName];
    if (stage === undefined) throw new Error(`前提が壊れた：数えていない schema ${schemaName}`);
    return stage;
  };
  const client: LlmClient = {
    async callStructured(request) {
      const key = JSON.stringify(request);
      requests.push(key);
      enter(stageOf(request.schemaName), key);
      return inner.callStructured(request);
    },
    async callWithTools(request) {
      const key = JSON.stringify(request);
      requests.push(key);
      enter("repair", key);
      return inner.callWithTools(request);
    },
  };
  return { client, logical, started, requests };
}

/**
 * 偽物の判定を包み、受けた要求の数を J4（所属の組の問い）と J2（それ以外）に分けて数える。`wrap` を渡すと、偽物の判定を
 * その口で包んだもの（切り替えの合成など）を数える
 */
function createCountingJudge(answers: Readonly<Record<string, JudgeAnswer>>, wrap?: (fake: Judge) => Judge) {
  const fake = createFakeJudge(answers);
  const inner = wrap === undefined ? fake : wrap(fake);
  const counts = { j4: 0, j2: 0 };
  const judge: Judge = {
    source: "fake",
    async judge(request) {
      const names = Object.keys(request.questions);
      if (names.every((name) => name.startsWith("need:"))) counts.j4 += 1;
      else counts.j2 += 1;
      return inner.judge(request);
    },
    ...(inner.primary === undefined ? {} : { primary: inner.primary }),
    ...(inner.fallback === undefined ? {} : { fallback: inner.fallback }),
  };
  return { judge, counts };
}

/** 段の記録を段ごとに足した値（同じ段が何度も走る——T1・T1''・B3' は回・版ごと——ので足す） */
interface StageTotals {
  /** 応答（段の記録の `calls`） */
  readonly responses: number;
  readonly started: number;
  readonly errors: number;
  readonly notStartedLimit: number;
  readonly retries: { readonly communication: number; readonly shape: number; readonly content: number };
}

function totalsOf(stages: readonly { readonly stage: string }[], stage: StageKey): StageTotals {
  const records = (stages as readonly StageRecord[]).filter((record) => record.stage === stage);
  const sum = (pick: (record: StageRecord) => number): number =>
    records.reduce((total, record) => total + pick(record), 0);
  return {
    responses: sum((record) => record.calls),
    started: sum((record) => record.attempts.started),
    errors: sum((record) => record.attempts.errors),
    notStartedLimit: sum((record) => record.attempts.not_started.limit),
    retries: {
      communication: sum((record) => record.retries.communication),
      shape: sum((record) => record.retries.shape),
      content: sum((record) => record.retries.content),
    },
  };
}

const structured = (output: unknown): RecordedCall => ({ ...recordedStructured(output), usage: USAGE });
const repairDone = (declaration: string, disputes: readonly { testId: string; quote: string }[] = []): RecordedCall => ({
  kind: "tools",
  response: { kind: "done", declaration: { declaration, disputes }, usage: USAGE },
});

interface RunOptions {
  readonly failFirst?: boolean;
  readonly flags?: Partial<V12Flags>;
  readonly v12CallLimits?: Partial<V12CallLimits>;
  /** 上限の一部の上書き（`AGENT_LIMITS` に重ねる） */
  readonly limits?: Readonly<Partial<Record<keyof typeof AGENT_LIMITS, number>>>;
  /** 判定の口を包む（切り替えの合成など。省けば偽物の判定そのもの） */
  readonly wrapJudge?: (fake: Judge) => Judge;
  /** 要求の schema 名ごとの記録（渡せば構造化の要求はこちらから返す） */
  readonly bySchema?: Readonly<Record<string, readonly RecordedCall[]>>;
  /** 旗 v12.ids の T2 の束の偽物で、どの束の要件でもない分類・場合を残す束（`[要件 ID, 束の先頭の要件 ID]`。Issue #626） */
  readonly home?: readonly (readonly [string, string])[];
  /** 予算（USD。省けば十分な 1,000） */
  readonly budgetUsd?: number;
  /** 単価（省けば試験の単価 `RATES`） */
  readonly rates?: TokenRates;
  /** 旗 v12.ids の T2 の束の同時数（省けば既定。Issue #626） */
  readonly v12T2Concurrency?: number;
}

/** 材料と記録した応答で流し、観測を返す（時計は 0・締切は通信の再送で timeout を伸ばせる長さ・予算は十分） */
function generationInputOf(materials: SizedMaterials, client: LlmClient, judge: Judge, options: RunOptions) {
  return {
    source: materials.source,
    documents: FIXTURE_DOCUMENTS,
    client,
    judge,
    budgetUsd: options.budgetUsd ?? 1_000,
    rates: options.rates ?? RATES,
    now: () => 0,
    deadline: 86_400_000,
    runId: "run-calls",
    storageUnit: "unit-calls",
    builder: "musunest-factory",
    model: "gpt-test",
    effort: "high",
    promptVersion: "v1.1a",
    contractVersion: "v0.2",
    specEngineVersion: "0.0.0",
    factoryVersion: "0.0.0",
    plan: materials.plan,
    ...(options.limits === undefined ? {} : { limits: { ...AGENT_LIMITS, ...options.limits } }),
    ...(options.flags === undefined ? {} : { flags: options.flags }),
    ...(options.v12CallLimits === undefined ? {} : { v12CallLimits: options.v12CallLimits }),
    ...(options.v12T2Concurrency === undefined ? {} : { v12T2Concurrency: options.v12T2Concurrency }),
  };
}

async function observe(materials: SizedMaterials, recorded: readonly RecordedCall[], options: RunOptions = {}) {
  const mouth = createMouth(recorded, options.failFirst ?? false, options.bySchema, options.home);
  const judge = createCountingJudge(materials.adviceAnswers(), options.wrapJudge);
  const result = await runGenerationV11a(generationInputOf(materials, mouth.client, judge.judge, options));
  const stages = Object.fromEntries(COUNTED_STAGES.map((stage) => [stage, totalsOf(result.record.stages, stage)])) as Record<StageKey, StageTotals>;
  const sumOf = (pick: (totals: StageTotals) => number): number => COUNTED_STAGES.reduce((total, stage) => total + pick(stages[stage]), 0);
  return {
    result,
    logical: mouth.logical,
    startedByMouth: mouth.started,
    requests: mouth.requests,
    stages,
    judge: judge.counts,
    totalLogical: COUNTED_STAGES.reduce((total, stage) => total + mouth.logical[stage], 0),
    totalStarted: sumOf((totals) => totals.started),
    totalResponses: sumOf((totals) => totals.responses),
    totalCommunicationRetries: sumOf((totals) => totals.retries.communication),
    totalErrors: sumOf((totals) => totals.errors),
    /** 旗 v12.ids の走りの門と枝（要約の `v12_calls`。旗 off の走りは undefined） */
    calls: (result.summary as unknown as { readonly v12_calls?: V12CallsSummary }).v12_calls,
  };
}

/** 要約の門と枝の欄（旗 v12.ids の走りだけ。Issue #592） */
interface V12CallsSummary {
  readonly real_attempts: { readonly limit: number; readonly used: number };
  readonly judge_branch: { readonly limit: number; readonly used: number };
  /** T2 の束の数・同時数・段全体の計（T2 を呼んだ走りだけ。Issue #626） */
  readonly test_spec?: unknown;
}

/**
 * 要約の `v12_calls.test_spec` の期待（Issue #626）：束の数（T2 の記録の数）・同時数（既定の上限と束の数の小さいほう）・段全体の計
 * （T2 の束の記録の項目ごとの合計。全体の計量の前後差と束の合計が等しいことも、ここで固定する）
 */
function t2SummaryOf(run: { readonly result: { readonly record: { readonly stages: readonly StageRecord[] } } }, concurrency: number = V12_T2_BUNDLE.concurrency) {
  const records = run.result.record.stages.filter((record) => record.stage === "test-spec");
  const sum = (pick: (record: StageRecord) => number): number => records.reduce((total, record) => total + pick(record), 0);
  return {
    bundles: records.length,
    concurrency: Math.min(concurrency, records.length),
    total: {
      calls: sum((record) => record.calls),
      missing_usage_calls: sum((record) => record.missing_usage_calls),
      input_tokens: sum((record) => record.input_tokens),
      cached_input_tokens: sum((record) => record.cached_input_tokens),
      cache_write_tokens: sum((record) => record.cache_write_tokens),
      output_tokens: sum((record) => record.output_tokens),
      reasoning_tokens: sum((record) => record.reasoning_tokens),
      attempts: {
        started: sum((record) => record.attempts.started),
        responded: sum((record) => record.attempts.responded),
        errors: sum((record) => record.attempts.errors),
        cancelled_deadline: sum((record) => record.attempts.cancelled_deadline),
        cancelled_timeout: sum((record) => record.attempts.cancelled_timeout),
        not_started: {
          deadline: sum((record) => record.attempts.not_started.deadline),
          budget: sum((record) => record.attempts.not_started.budget),
          limit: sum((record) => record.attempts.not_started.limit),
          timeout: sum((record) => record.attempts.not_started.timeout),
        },
      },
      retries: {
        communication: sum((record) => record.retries.communication),
        shape: sum((record) => record.retries.shape),
        content: sum((record) => record.retries.content),
      },
    },
  };
}

/** 初回で全段が通る走りの記録（T1〔旗 v12.ids の走りは C1 の 3 束と C2〕・T1''・T2・B1・B3' を 1 回ずつ） */
const cleanCalls = (materials: SizedMaterials): RecordedCall[] => [
  ...materials.tableResponses().map(structured),
  structured(materials.judgments()),
  structured(materials.t2Response()),
  structured({ declaration: materials.declaration() }),
  structured(materials.judgments()),
];

/** 値を縛る要件の検査の本文（欄だけの直しが置き換える要素。`v<i> > bound`） */
const validationElement = (requirementId: string, bound: number): string => {
  const n = requirementId.slice(1);
  return [`- name: v${n}`, "  entity: item", `  expression: v${n} > ${String(bound)}`].join("\n");
};
/** 欄だけの直しの応答（旗 v12.search-repair の往復。R の検査の式を替える） */
const fieldRepairCall = (requirementId: string, bound: number, disputes: readonly { testId: string; quote: string }[] = []): RecordedCall =>
  structured({
    replacements: [{ location: `validation:item.v${requirementId.slice(1)}`, element: validationElement(requirementId, bound) }],
    disputes,
  });

/**
 * やり直しを含む走りの記録（要件 R1・R2 は値を縛る要件）。段ごとの論理要求は次の表のとおり（合計 17）：
 *
 * | 段 | 論理要求 | 内訳 |
 * |---|---|---|
 * | name-table（T1） | 3 | 1 回目の形の落ち → 形のやり直し（1）／T1'' の拒否のあとの 2 回目＝中身のやり直し（1） |
 * | semantic-check（T1'') | 3 | 1 回目は判定が欠けて形の落ち → 形のやり直しで R1 を拒否（2）／2 回目で全部受理（1） |
 * | test-spec（T2） | 3 | 形の落ち → 形のやり直し（2）で R1 の異常の試験が欠け、T2' が落とす → 中身のやり直し（1） |
 * | write（B1） | 1 | 版 1（R1 の検査が誤った宣言） |
 * | decl-check（B3'） | 4 | 版 1 は判定が欠けて形の落ち → 形のやり直し（2）／版 2（1）／版 3（1）＝3 版 |
 * | repair（B5） | 2 | 版 2（R2 の検査が誤った宣言。主張 1 件つき）／版 3（誤りなし） |
 * | arbitration（B5'） | 1 | 版 2 を返した B5 の主張を維持（uphold） |
 *
 * 判定の口：J4 は T1 のたびに要件ごとに 1 要求（T1 が 2 回走るので 2N）・J2 は 0。
 * 段の記録の再試行：name-table は shape 1・content 1、semantic-check は shape 1、test-spec は shape 1・content 1、
 * decl-check は shape 1。
 */
/** 要求のデータの「要件の一覧」の要件 ID */
const listedIds = (request: string): readonly string[] => {
  const parsed = JSON.parse(request) as { readonly input: string };
  const block = parsed.input.split('<data name="要件の一覧">\n')[1]?.split("\n</data>")[0] ?? "null";
  return ((JSON.parse(block) as { readonly requirements: readonly { readonly id: string }[] }).requirements ?? []).map((requirement) => requirement.id);
};

/**
 * 旗 v12.ids の走りのやり直しを含む走りの頭（表を組む段と T1''。Issue #593）。C1 は束 2 が知らない ID で落ちて形のやり直し
 * 1 回（束 1・3 は 1 回ずつ。計 4）、C2 は要件の欠落で落ちて形のやり直し 1 回・T1'' の拒否のあとの 2 回目 1 回（計 3）、
 * T1'' は旗 off と同じ 3 回（形の落ち → 形のやり直しで R1 を拒否／2 回目で全部受理）
 */
function idsRetryHead(materials: SizedMaterials, incomplete: unknown, rejectR1: unknown): RecordedCall[] {
  const [entities, fields, behaviors, mapping] = materials.tableResponses() as readonly Record<string, readonly Record<string, unknown>[]>[];
  if (entities === undefined || fields === undefined || behaviors === undefined || mapping === undefined) throw new Error("前提が壊れた：C1・C2 の応答が 4 つでない");
  const unknownEntity = { fields: (fields["fields"] ?? []).map((item, index) => (index === 0 ? { ...item, entity: "E9" } : item)) };
  const missingRequirement = { requirements: (mapping["requirements"] ?? []).slice(1) };
  return [
    structured(entities),
    structured(unknownEntity),
    structured(fields),
    structured(behaviors),
    structured(missingRequirement),
    structured(mapping),
    structured(incomplete),
    structured(rejectR1),
    structured(mapping),
    structured(materials.judgments()),
  ];
}

function retryCalls(materials: SizedMaterials): RecordedCall[] {
  const incomplete = { judgments: materials.judgments().judgments.slice(0, -1) };
  const rejectR1 = materials.judgments({ R1: ["unnecessary-ownership", materials.textOf("R1")] });
  // 旗 v12.ids の走りの試験 ID はコードが場合の順に振る（case: と連番。#625）。同じ試験（R5 の正常）の ID を引く
  const t5Index = (materials.testSpecResponse().tests as readonly { readonly id: string }[]).findIndex((test) => test.id === "t5-normal");
  const dispute = { testId: materials.flags.ids ? `${TEST_CASE_ID_PREFIX}${String(t5Index + 1)}` : "t5-normal", quote: materials.textOf("R5") };
  // 旗 v12.search-repair の走りは、失敗が全部場所（R1 の検査）に写るので B5 は欄だけの直しになる。版 2 は R1 の検査を
  // 境界だけが落ちる式にして違反の数を厳密に減らし（採る）、版 3 で誤りなし。往復・裁定・B3' の版の数は旗 off と同じ
  const search = materials.flags.searchRepair;
  const repair1 = search ? fieldRepairCall("R1", 1, [dispute]) : repairDone(materials.declaration(["R2"]), [dispute]);
  const repair2 = search ? fieldRepairCall("R1", 0) : repairDone(materials.declaration());
  return [
    ...(materials.flags.ids ? idsRetryHead(materials, incomplete, rejectR1) : [
      structured(negative({ rows: "x", requirements: "x" }, "rows・requirements が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
      structured(materials.nameTableResponse()),
      structured(incomplete),
      structured(rejectR1),
      structured(materials.nameTableResponse()),
      structured(materials.judgments()),
    ]),
    structured(negative({ classifications: "x", tests: "x" }, "classifications・tests が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
    structured(materials.t2Response({ omitAbnormalOf: "R1" })),
    structured(materials.t2Response()),
    structured({ declaration: materials.declaration(["R1"]) }),
    structured(incomplete),
    structured(materials.judgments()),
    repair1,
    structured({ decisions: [{ testId: dispute.testId, verdict: "uphold", reason: "", quote: "" }] }),
    structured(materials.judgments()),
    repair2,
    structured(materials.judgments()),
  ];
}

// ── 生成器 ─────────────────────────────────────────────────────────

describe("大きさの生成器（要件 N・試験 M）", () => {
  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests：同じ N・M から同じ値を返し、試験の数が M ちょうど", (size) => {
    const first = buildSized(size.requirements, size.tests);
    const second = buildSized(size.requirements, size.tests);
    expect(second.plan).toEqual(first.plan);
    expect(second.list).toEqual(first.list);
    expect(second.table).toEqual(first.table);
    expect(second.nameTableResponse()).toEqual(first.nameTableResponse());
    expect(second.adviceAnswers()).toEqual(first.adviceAnswers());
    expect(second.judgments()).toEqual(first.judgments());
    expect(second.testSpecResponse()).toEqual(first.testSpecResponse());
    expect(second.declaration()).toBe(first.declaration());
    expect(second.declaration(["R1"])).toBe(first.declaration(["R1"]));

    expect(first.list.requirements).toHaveLength(size.requirements);
    const tests = first.testSpecResponse().tests as readonly { target: { requirementId: string }; kind: string }[];
    expect(tests).toHaveLength(size.tests);
    // 値を縛る要件には正常・異常・境界が揃い、1 要件の試験は上限の内側
    for (const id of first.ids) {
      const ofRequirement = tests.filter((test) => test.target.requirementId === id);
      expect(ofRequirement.length, id).toBeGreaterThan(0);
      expect(ofRequirement.length, id).toBeLessThanOrEqual(AGENT_LIMITS.testsPerRequirement);
    }
    const ruled = first.ids.slice(0, size.requirements - first.structuralCount);
    for (const id of ruled) {
      const kinds = new Set(tests.filter((test) => test.target.requirementId === id).map((test) => test.kind));
      expect([...kinds].sort(), id).toEqual(["abnormal", "boundary", "normal"]);
    }
  });

  it("旗の組を渡しても同じ N・M・旗の組から同じ値を返す。台帳 on の T1 の応答は台帳の schema の形（行の型に aggregate）で、ほかの材料は旗によらず同じ", () => {
    const allOn = fromPublicV12Flags(V12_PIPELINE_FLAGS);
    for (const flags of [{}, { ledger: true, searchRepair: true }, allOn]) {
      for (const size of [MEDIAN_SIZE, MAX_SIZE]) {
        const first = buildSized(size.requirements, size.tests, flags);
        const second = buildSized(size.requirements, size.tests, flags);
        expect(second.flags).toEqual(first.flags);
        expect(second.tableResponses()).toEqual(first.tableResponses());
        expect(second.testSpecResponse()).toEqual(first.testSpecResponse());
        expect(second.judgments()).toEqual(first.judgments());
        expect(second.adviceAnswers()).toEqual(first.adviceAnswers());
        expect(second.declaration(["R1"])).toBe(first.declaration(["R1"]));
      }
    }
    const off = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests);
    // 台帳 on・ids off（T1 を呼ぶ走り）の T1 の応答は台帳の schema の形（Issue #593 で ids on は C1・C2 の応答になった）
    const on = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, { ledger: true, searchRepair: true });
    const ids = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, allOn);
    expect(ids.flags).toEqual({ ledger: true, searchRepair: true, ids: true });
    // ids on：表はコードの形の ID（C1 が組む順・出典なし）で、表を組む段の応答は C1 の 3 束と C2 の 4 つ。宣言は同じ
    expect(ids.table).toEqual(withCodeIds(off.table));
    expect(ids.tableResponses()).toHaveLength(4);
    expect(ids.declaration()).toBe(off.declaration());
    // 手 3d（#624）：ids on の応答は構造の要件の構造の検査（コードが作る）を除いた分だけ少ない
    expect(ids.generatedTestCount).toBe(ids.structuralCount);
    expect(off.generatedTestCount).toBe(0);
    expect(ids.testSpecResponse().tests).toHaveLength(off.testSpecResponse().tests.length - ids.generatedTestCount);
    const rowTypes = (response: Record<string, unknown>) => (response["rows"] as readonly { type: Record<string, unknown> }[]).map((entry) => entry.type);
    expect(rowTypes(on.nameTableResponse()).every((type) => "aggregate" in type)).toBe(true);
    expect(rowTypes(off.nameTableResponse()).some((type) => "aggregate" in type)).toBe(false);
    expect(on.table).toEqual(off.table);
    expect(on.testSpecResponse()).toEqual(off.testSpecResponse());
    expect(on.declaration()).toBe(off.declaration());
  });

  it("中央値と最大で構造の要件の数が決まり、足りない大きさは例外にする", () => {
    expect(buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests).structuralCount).toBe(3);
    expect(buildSized(MAX_SIZE.requirements, MAX_SIZE.tests).structuralCount).toBe(4);
    expect(() => buildSized(5, 4)).toThrow(RangeError);
    expect(() => buildSized(0, 10)).toThrow(RangeError);
    expect(() => buildSized(2, 100)).toThrow(RangeError);
  });
});

// ── (1) 初回で全段が通る走り ──────────────────────────────────────────

describe("(1) 初回で全段が通る走り：段ごとの論理要求・応答・retries・J4・J2・実開始・再送が表どおり", () => {
  /**
   * | 段 | 論理要求 | 応答 | 実開始 | 再送 |
   * |---|---|---|---|---|
   * | name-table（T1） | 1 | 1 | 1 | 0 |
   * | semantic-check（T1'') | 1 | 1 | 1 | 0 |
   * | test-spec（T2） | 1 | 1 | 1 | 0 |
   * | write（B1） | 1 | 1 | 1 | 0 |
   * | decl-check（B3'） | 1（版 1） | 1 | 1 | 0 |
   * | repair（B5） | 0 | 0 | 0 | 0 |
   *
   * 判定：J4＝要件の数 N（要件ごとに 1 要求）・J2＝0。合計は論理要求＝応答＝実開始＝5、門（24）の内側。
   */
  const EXPECTED_PER_STAGE: Record<StageKey, number> = {
    vocabulary: 0,
    mapping: 0,
    "name-table": 1,
    "semantic-check": 1,
    "test-spec": 1,
    write: 1,
    "decl-check": 1,
    repair: 0,
    arbitration: 0,
  };

  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests", async (size) => {
    const materials = buildSized(size.requirements, size.tests);
    const run = await observe(materials, cleanCalls(materials));
    expect(run.result.stopped).toBeNull();
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    for (const stage of STAGES) {
      const expected = EXPECTED_PER_STAGE[stage];
      expect(run.logical[stage], `${stage} の論理要求`).toBe(expected);
      expect(run.stages[stage].responses, `${stage} の応答`).toBe(expected);
      expect(run.stages[stage].started, `${stage} の実開始`).toBe(expected);
      expect(run.stages[stage].retries, `${stage} の retries`).toEqual({ communication: 0, shape: 0, content: 0 });
      expect(run.stages[stage].errors, `${stage} の誤り`).toBe(0);
      expect(run.stages[stage].notStartedLimit, `${stage} の未着手`).toBe(0);
    }
    expect(run.judge).toEqual({ j4: size.requirements, j2: 0 });
    expect(run.totalLogical).toBe(5);
    expect(run.totalResponses).toBe(5);
    expect(run.totalStarted).toBe(5);
    expect(run.totalCommunicationRetries).toBe(0);
    // 実開始は門（callCount）の内側。判定の呼び出しは門に数えない（実開始は LLM の試行だけ）
    expect(run.totalStarted).toBeLessThanOrEqual(AGENT_LIMITS.callCount);
    // 偽物の口が数えた実開始と、段の記録の実開始が同じ
    for (const stage of STAGES) expect(run.startedByMouth[stage], stage).toBe(run.stages[stage].started);
  });
});

// ── (2) やり直しを含む走り ────────────────────────────────────────────

describe("(2) やり直しを含む走り：段ごとの論理要求・応答・retries が表どおり", () => {
  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests（形のやり直し 4 段・中身のやり直し 2 段・B5 の往復 2・裁定 1・B3' 3 版）", async (size) => {
    const materials = buildSized(size.requirements, size.tests);
    const run = await observe(materials, retryCalls(materials));
    expect(run.result.stopped).toBeNull();
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });

    // 段ごとの論理要求（retryCalls の表）。通信の失敗が無いので、応答＝実開始＝論理要求
    const expectedLogical: StageCounts = {
      vocabulary: 0,
      mapping: 0,
      "name-table": 3,
      "semantic-check": 3,
      "test-spec": 3,
      write: 1,
      "decl-check": 4,
      repair: 2,
      arbitration: 1,
    };
    const expectedRetries: Record<StageKey, { communication: number; shape: number; content: number }> = {
      vocabulary: { communication: 0, shape: 0, content: 0 },
      mapping: { communication: 0, shape: 0, content: 0 },
      "name-table": { communication: 0, shape: 1, content: 1 },
      "semantic-check": { communication: 0, shape: 1, content: 0 },
      "test-spec": { communication: 0, shape: 1, content: 1 },
      write: { communication: 0, shape: 0, content: 0 },
      "decl-check": { communication: 0, shape: 1, content: 0 },
      repair: { communication: 0, shape: 0, content: 0 },
      arbitration: { communication: 0, shape: 0, content: 0 },
    };
    for (const stage of STAGES) {
      expect(run.logical[stage], `${stage} の論理要求`).toBe(expectedLogical[stage]);
      expect(run.stages[stage].responses, `${stage} の応答`).toBe(expectedLogical[stage]);
      expect(run.stages[stage].started, `${stage} の実開始`).toBe(expectedLogical[stage]);
      expect(run.stages[stage].retries, `${stage} の retries`).toEqual(expectedRetries[stage]);
    }
    // J4 は T1 が 2 回走るので、要件の数の 2 倍。J2 は 0
    expect(run.judge).toEqual({ j4: 2 * size.requirements, j2: 0 });
    expect(run.totalLogical).toBe(17);
    expect(run.totalResponses).toBe(17);
    expect(run.totalStarted).toBe(17);
    expect(run.totalStarted).toBeLessThanOrEqual(AGENT_LIMITS.callCount);
    // B3' は 3 版（版 1 が形のやり直しを含む）、B5 は往復 2
    expect(run.result.record.stages.filter((record) => record.stage === "repair")).toHaveLength(2);
    expect(run.result.record.stages.filter((record) => record.stage === "decl-check")).toHaveLength(3);
  });
});

// ── (3) 通信の再送を全部使う経路 ──────────────────────────────────────

describe("(3) 通信の再送を全部使う経路：各要求の 1 回目を通信の失敗、2 回目を成功にする", () => {
  it.each([MEDIAN_SIZE, MAX_SIZE])("初回で全段が通る走り（要件 $requirements）：実開始＝論理要求の 2 倍・応答＝論理要求・再送＝論理要求", async (size) => {
    const materials = buildSized(size.requirements, size.tests);
    const run = await observe(materials, cleanCalls(materials), { failFirst: true });
    expect(run.result.stopped).toBeNull();
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(run.totalLogical).toBe(5);
    expect(run.totalStarted).toBe(2 * run.totalLogical);
    expect(run.totalResponses).toBe(run.totalLogical);
    expect(run.totalCommunicationRetries).toBe(run.totalLogical);
    expect(run.totalErrors).toBe(run.totalLogical);
    for (const stage of STAGES) {
      const logical = run.logical[stage];
      expect(run.stages[stage].started, `${stage} の実開始`).toBe(2 * logical);
      expect(run.stages[stage].responses, `${stage} の応答`).toBe(logical);
      expect(run.stages[stage].retries.communication, `${stage} の再送`).toBe(logical);
      expect(run.stages[stage].errors, `${stage} の誤り`).toBe(logical);
      expect(run.stages[stage].notStartedLimit, `${stage} の未着手`).toBe(0);
    }
    // 実開始 10 は門の内側。判定の数は再送の影響を受けない（判定の口は共通の口を通らない）
    expect(run.totalStarted).toBe(10);
    expect(run.totalStarted).toBeLessThanOrEqual(AGENT_LIMITS.callCount);
    expect(run.judge).toEqual({ j4: size.requirements, j2: 0 });
  });

  it("やり直しを含む走りで全要求が再送を使うと、門（24）を超えて call-limit で止まる：最初の未着手の要求は 13 本目で、途中で止まった要求は無い", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests);
    const run = await observe(materials, retryCalls(materials), { failFirst: true });
    // 12 本の論理要求が 24 の実開始（各 2 回）を使い切り、13 本目（B5 の最初の要求）は 1 回も始められない
    expect(AGENT_LIMITS.callCount).toBe(24);
    expect(run.totalStarted).toBe(24);
    expect(run.totalLogical).toBe(12);
    expect(run.totalResponses).toBe(12);
    expect(run.totalCommunicationRetries).toBe(12);
    expect(run.stages.repair).toMatchObject({ started: 0, responses: 0, notStartedLimit: 1 });
    expect(run.logical.repair).toBe(0);
    // 区間（止まるまで）：全要求が失敗 1 回＋成功 1 回まで進んだので、実開始＝論理要求の 2 倍
    expect(run.totalStarted).toBe(2 * run.totalLogical);
    // 止まり方：段 repair・call-limit・終了コード 1・納品物無し
    expect(run.result.stopped).toMatchObject({ stage: "repair" });
    expect(run.result.outcome.verdict).toBe("none");
    expect(run.result.summary.exit_code).toBe(1);
    expect(run.result.bundle).toBeNull();
    const failed = run.result.record.stages.find((record) => record.status === "failed");
    expect(failed?.stage).toBe("repair");
    expect(failed?.failure_kind).toBe("call-limit");
    expect(run.result.summary.stop_reason).toBe("call-limit");
  });

  it("門を 1 下げる（23）と、12 本目の要求は 1 回目だけ開始して途中で止まる：未着手の要求と別に数える", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests);
    const run = await observe(materials, retryCalls(materials), { failFirst: true, limits: { callCount: 23 } });
    // 11 本は完了（22 の実開始）。12 本目（B3' 版 1 のやり直した要求）は 1 回目を始め（23）、2 回目が門で断られる
    expect(run.totalStarted).toBe(23);
    expect(run.totalLogical).toBe(12);
    expect(run.totalResponses).toBe(11);
    expect(run.totalCommunicationRetries).toBe(11);
    expect(run.totalErrors).toBe(12);
    expect(run.stages["decl-check"]).toMatchObject({ started: 3, responses: 1, errors: 2, notStartedLimit: 1 });
    expect(run.stages["decl-check"].retries.communication).toBe(1);
    // 1 回も始められなかった要求は無い（途中で止まった要求の 2 回目の試行が 1 つ、未着手に数えられる）
    expect(run.stages.repair).toMatchObject({ started: 0, notStartedLimit: 0 });
    expect(run.logical.repair).toBe(0);
    expect(run.result.stopped).toMatchObject({ stage: "decl-check" });
    expect(run.result.record.stages.find((record) => record.status === "failed")?.failure_kind).toBe("call-limit");
    expect(run.result.summary.exit_code).toBe(1);
    expect(run.result.bundle).toBeNull();
    // 実開始は 23（門の値）を超えない
    expect(run.totalStarted).toBeLessThanOrEqual(23);
  });
});

// ── (4) 中央値と最大で (1) の数が同じ ──────────────────────────────────

describe("(4) 大きさで呼び出し数が変わらない：中央値と最大で (1) の数が同じ", () => {
  it("段ごとの論理要求・応答・実開始・再送・retries・J2 が同じ（J4 だけが要件の数に比例する）", async () => {
    const median = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests);
    const max = buildSized(MAX_SIZE.requirements, MAX_SIZE.tests);
    const medianRun = await observe(median, cleanCalls(median));
    const maxRun = await observe(max, cleanCalls(max));
    expect(maxRun.logical).toEqual(medianRun.logical);
    expect(maxRun.stages).toEqual(medianRun.stages);
    expect(maxRun.totalStarted).toBe(medianRun.totalStarted);
    expect(maxRun.judge.j2).toBe(medianRun.judge.j2);
    expect(medianRun.judge.j4).toBe(MEDIAN_SIZE.requirements);
    expect(maxRun.judge.j4).toBe(MAX_SIZE.requirements);
    // 呼び出し数の外側の前提：1 要件の試験は上限（testsPerRequirement）の内側、参照データの行は使わない
    const tests = max.testSpecResponse().tests as readonly { referenceData: readonly unknown[] }[];
    expect(tests.every((test) => test.referenceData.length <= AGENT_LIMITS.referenceRowsPerTest)).toBe(true);
    expect(AGENT_LIMITS.testsPerRequirement).toBe(16);
    expect(AGENT_LIMITS.referenceRowsPerTest).toBe(64);
  });

  it("やり直しを含む走りも、中央値と最大で段ごとの数が同じ", async () => {
    const median = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests);
    const max = buildSized(MAX_SIZE.requirements, MAX_SIZE.tests);
    const medianRun = await observe(median, retryCalls(median));
    const maxRun = await observe(max, retryCalls(max));
    expect(maxRun.logical).toEqual(medianRun.logical);
    expect(maxRun.stages).toEqual(medianRun.stages);
  });
});

// ── (5) 旗の組ごとの論理の枠（手 3p。08 §4.1・Issue #592）────────────────────────────

/** 旗の組（全部 off／前の手の旗だけ on〔ids off〕／全部 on〔`--pipeline v1.2` と同じ組〕） */
const FLAG_SETS = [
  { name: "全部 off", flags: {} },
  { name: "前の手の旗だけ on（ledger・search-repair。ids off）", flags: { ledger: true, searchRepair: true } },
  { name: "全部 on（--pipeline v1.2 と同じ組）", flags: fromPublicV12Flags(V12_PIPELINE_FLAGS) },
] as const satisfies readonly { readonly name: string; readonly flags: Partial<V12Flags> }[];
type FlagSetName = (typeof FLAG_SETS)[number]["name"];

/** 段 × 走りの期待（論理要求・応答・実開始・再送）。再送を全部使う走りは止まり方も持つ */
interface StageRow {
  readonly logical: number;
  readonly responses: number;
  readonly started: number;
  readonly communication: number;
}
type RunTable = Readonly<Record<StageKey, StageRow>>;
const row = (logical: number, responses = logical, started = logical, communication = 0): StageRow => ({
  logical,
  responses,
  started,
  communication,
});

/** 初回で通る走り（旗の組によらず同じ） */
const CLEAN_TABLE: RunTable = {
  "name-table": row(1),
  "semantic-check": row(1),
  "test-spec": row(1),
  write: row(1),
  "decl-check": row(1),
  repair: row(0),
  arbitration: row(0),
  vocabulary: row(0),
  mapping: row(0),
};
/** やり直しを含む走り（旗の組によらず同じ。旗 v12.search-repair の B5 は欄だけの直しで往復の数は同じ） */
const RETRY_TABLE: RunTable = {
  "name-table": row(3),
  "semantic-check": row(3),
  "test-spec": row(3),
  write: row(1),
  "decl-check": row(4),
  repair: row(2),
  arbitration: row(1),
  vocabulary: row(0),
  mapping: row(0),
};
/** 旗 v12.ids の T2 の束の数（要件 5 件ごと。台本の要件は全部 T2 の要求に残る。Issue #626） */
const t2Bundles = (requirements: number): number => Math.ceil(requirements / V12_T2_BUNDLE.size);
/**
 * 全部 on の初回で通る走りの生成の論理要求（C1 3・C2 1・T1'' 1・T2 束 k・B1 1・B3' 1。手 3a で T1 の 1 が C1・C2 の 4 になった。
 * Issue #593。手 3f で T2 の 1 が束 k〔要件 5 件ごと〕になった。Issue #626）
 */
const cleanGeneration = (requirements: number): number => 7 + t2Bundles(requirements);
/** 走りの T2 の記録（束ごとに 1 つ。Issue #626） */
const t2RecordsOfRun = (run: { readonly result: { readonly record: { readonly stages: readonly StageRecord[] } } }): readonly StageRecord[] =>
  run.result.record.stages.filter((record) => record.stage === "test-spec");
/** 旗 v12.ids の台本の T2 の束の数（その台本の T2 の応答が分類する要件＝T2 の要求の一覧の数から。Issue #626） */
const t2BundlesOf = (materials: SizedMaterials): number => t2Bundles(((materials.t2Response().classifications ?? []) as readonly unknown[]).length);
/**
 * 旗 v12.ids の初回で通る走り（T1 の代わりに C1 3〔束ごと 1〕・C2 1。Issue #593）。T2 は束 k（要件 5 件ごと）に 1 つずつ（Issue #626）
 */
const cleanIdsTable = (k: number): RunTable => ({ ...CLEAN_TABLE, "name-table": row(0), vocabulary: row(3), mapping: row(1), "test-spec": row(k) });
/**
 * 旗 v12.ids のやり直しを含む走り（C1 4〔束 2 の形 1〕・C2 3〔形 1・T1'' の拒否のあとの 2 回目 1〕。Issue #593）。T2 は束 k の
 * 初回 k・形 k（台本の負例は全部の束が読む）・中身 1（R1 の異常の欠けは R1 の束だけに帰属する）で 2k＋1（Issue #626）
 */
const retryIdsTable = (k: number): RunTable => ({ ...RETRY_TABLE, "name-table": row(0), vocabulary: row(4), mapping: row(3), "test-spec": row(2 * k + 1) });
/** 再送を全部使う（実開始＝論理要求の 2 倍・再送＝論理要求） */
const doubled = (table: RunTable): RunTable =>
  Object.fromEntries(COUNTED_STAGES.map((stage) => [stage, row(table[stage].logical, table[stage].logical, 2 * table[stage].logical, table[stage].logical)])) as unknown as RunTable;
/** 再送を全部使う初回で通る走り（実開始＝論理要求の 2 倍・再送＝論理要求） */
const CLEAN_FAIL_TABLE: RunTable = doubled(CLEAN_TABLE);

/** 再送を全部使うやり直しを含む走り・旗 v12.ids off（v1・v1.1α の門 24 で B5 の最初の要求が未着手のまま call-limit） */
const RETRY_FAIL_GATE24_TABLE: RunTable = {
  "name-table": row(3, 3, 6, 3),
  "semantic-check": row(3, 3, 6, 3),
  "test-spec": row(3, 3, 6, 3),
  write: row(1, 1, 2, 1),
  "decl-check": row(2, 2, 4, 2),
  repair: row(0),
  arbitration: row(0),
  vocabulary: row(0),
  mapping: row(0),
};

/**
 * 段 × 旗の組の期待の表（§4.1 の列で書く。手 3a〜3c が C1・C2・C4 の束の行を足す）。値は論理要求（応答・実開始・再送は各表）。
 *
 * | v1.1α の段 | §4.1 の行（単位） | 初回で通る | やり直しを含む（初回＋形＋中身） | 再送を全部使う（初回で通る：実開始） | 再送を全部使う（やり直し）：off・前の手 | 同：全部 on |
 * |---|---|---|---|---|---|---|
 * | name-table（T1） | C1・C2（段全体＝束 1） | 1 | 3（1＋形 1＋中身 1） | 2 | 3（実開始 6） | 3（実開始 6） |
 * | semantic-check（T1''） | C3（段全体） | 1 | 3（1＋形 1＋拒否後 1） | 2 | 3（6） | 3（6） |
 * | test-spec（T2） | C4（off・前の手は段全体＝束 1。全部 on は要件 5 件ごとの束 k） | 1（全部 on は k） | 3（1＋形 1＋中身 1。全部 on は 2k＋1） | 2（2k） | 3（6） | 2k＋1（4k＋2） |
 * | write（B1） | （C5。手 6） | 1 | 1 | 2 | 1（2） | 1（2） |
 * | decl-check（B3'） | C6（版ごと 1・形は段全体） | 1 | 4（3 版＋形 1） | 2 | 2（4） | 4（8） |
 * | repair（B5） | ループ（往復ごと） | 0 | 2（往復 2） | 0 | 0（未着手 1） | 2（4） |
 * | arbitration（B5'） | ループ（往復ごと 0〜1） | 0 | 1 | 0 | 0 | 1（2） |
 * | 合計 | | 5 | 17 | 10 | 12（24・call-limit） | 15＋2k（30＋4k・完走） |
 *
 * 判定：J4 は T1 のたびに要件ごとに 1 要求（初回で通る N・やり直し 2N）、J2 は 0。全部 on では判定も実試行の門に数える。
 */
type FlagSetTables = { readonly clean: RunTable; readonly retry: RunTable; readonly cleanFail: RunTable; readonly retryFail: RunTable };
const FLAG_SET_TABLE: Readonly<Record<FlagSetName, (requirements: number) => FlagSetTables>> = {
  "全部 off": () => ({ clean: CLEAN_TABLE, retry: RETRY_TABLE, cleanFail: CLEAN_FAIL_TABLE, retryFail: RETRY_FAIL_GATE24_TABLE }),
  "前の手の旗だけ on（ledger・search-repair。ids off）": () => ({
    clean: CLEAN_TABLE,
    retry: RETRY_TABLE,
    cleanFail: CLEAN_FAIL_TABLE,
    retryFail: RETRY_FAIL_GATE24_TABLE,
  }),
  // 再送を全部使うやり直しを含む走りも門 144 の内側で完走
  "全部 on（--pipeline v1.2 と同じ組）": (requirements) => {
    const k = t2Bundles(requirements);
    return { clean: cleanIdsTable(k), retry: retryIdsTable(k), cleanFail: doubled(cleanIdsTable(k)), retryFail: doubled(retryIdsTable(k)) };
  },
};

/** 走りの段ごとの数が表どおりか */
function expectTable(run: Awaited<ReturnType<typeof observe>>, table: RunTable, label: string): void {
  for (const stage of COUNTED_STAGES) {
    const expected = table[stage];
    expect(run.logical[stage], `${label} ${stage} の論理要求`).toBe(expected.logical);
    expect(run.stages[stage].responses, `${label} ${stage} の応答`).toBe(expected.responses);
    expect(run.stages[stage].started, `${label} ${stage} の実開始`).toBe(expected.started);
    expect(run.stages[stage].retries.communication, `${label} ${stage} の再送`).toBe(expected.communication);
    expect(run.startedByMouth[stage], `${label} ${stage} の口の実開始`).toBe(run.stages[stage].started);
  }
}
const totalOf = (table: RunTable, pick: (row: StageRow) => number): number => COUNTED_STAGES.reduce((sum, stage) => sum + pick(table[stage]), 0);

describe("(5) 旗の組ごとの論理の枠：段 × 旗の組の期待の表（全部 off／前の手の旗だけ on／全部 on）", () => {
  for (const set of FLAG_SETS) {
    const ids = resolveIds(set.flags);
    it.each([MEDIAN_SIZE, MAX_SIZE])(`${set.name}：要件 $requirements・試験 $tests の初回で通る走り・やり直しを含む走り・再送を全部使う走り`, async (size) => {
      const expected = FLAG_SET_TABLE[set.name](size.requirements);
      const materials = buildSized(size.requirements, size.tests, set.flags);
      const clean = await observe(materials, cleanCalls(materials), { flags: set.flags });
      const retry = await observe(materials, retryCalls(materials), { flags: set.flags });
      const cleanFail = await observe(materials, cleanCalls(materials), { flags: set.flags, failFirst: true });
      const retryFail = await observe(materials, retryCalls(materials), { flags: set.flags, failFirst: true });
      expectTable(clean, expected.clean, "初回");
      expectTable(retry, expected.retry, "やり直し");
      expectTable(cleanFail, expected.cleanFail, "再送（初回）");
      expectTable(retryFail, expected.retryFail, "再送（やり直し）");
      for (const run of [clean, retry, cleanFail]) {
        expect(run.result.stopped).toBeNull();
        expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
      }
      // 判定：J4 は T1 のたびに要件ごとに 1 要求、J2 は 0（再送の影響を受けない）
      expect(clean.judge).toEqual({ j4: size.requirements, j2: 0 });
      expect(retry.judge).toEqual({ j4: 2 * size.requirements, j2: 0 });
      expect(cleanFail.judge).toEqual({ j4: size.requirements, j2: 0 });
      expect(retryFail.judge).toEqual({ j4: 2 * size.requirements, j2: 0 });
      expect(retry.totalLogical).toBe(totalOf(expected.retry, (entry) => entry.logical));
      // 要求に受入の題材の言葉が無い
      for (const run of [clean, retry]) expectNoAcceptanceMaterial(run.requests);
      if (ids) {
        // 全部 on：再送を全部使うやり直しの走りも門 144 の内側で完走。論理 72・実試行 144・判定 80 の内側
        expect(retryFail.result.outcome).toEqual({ result: "pass", verdict: "full" });
        for (const run of [clean, retry, cleanFail, retryFail]) {
          const judged = run.judge.j4 + run.judge.j2;
          expect(run.totalLogical).toBeLessThanOrEqual(V12_CALL_LIMITS.logicalCalls);
          // 門の数＝生成の実開始＋判定の実試行（偽物の判定は内部の再送を持たないので、要求の数＝実試行）
          expect(run.calls).toEqual({
            test_spec: t2SummaryOf(run),
            real_attempts: { limit: V12_CALL_LIMITS.realAttempts, used: run.totalStarted + judged },
            judge_branch: { limit: V12_CALL_LIMITS.judgeBranch, used: judged },
          });
          expect(run.calls?.real_attempts.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.realAttempts);
          expect(judged).toBeLessThanOrEqual(V12_CALL_LIMITS.judgeBranch);
        }
      } else {
        // ids off：門を作らず要約に門の欄が無い。再送を全部使うやり直しの走りは今の門 24 で B5 の最初の要求が未着手のまま止まる
        for (const run of [clean, retry, cleanFail, retryFail]) expect(run.result.summary).not.toHaveProperty("v12_calls");
        expect(retryFail.totalStarted).toBe(AGENT_LIMITS.callCount);
        expect(retryFail.stages.repair.notStartedLimit).toBe(1);
        expect(retryFail.result.stopped).toMatchObject({ stage: "repair", kind: "call-limit" });
        expect(retryFail.result.summary.exit_code).toBe(1);
        expect(retryFail.result.bundle).toBeNull();
      }
    });
  }

  it("中央値と最大で段ごとの数が同じ（J4 だけ要件の数に比例。全部 on の T2 は束の数 k に従う）。旗の組の間でも段ごとの論理要求は同じ", async () => {
    const logicalBySet: unknown[] = [];
    for (const set of FLAG_SETS) {
      const median = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, set.flags);
      const max = buildSized(MAX_SIZE.requirements, MAX_SIZE.tests, set.flags);
      for (const make of [cleanCalls, retryCalls]) {
        const medianRun = await observe(median, make(median), { flags: set.flags });
        const maxRun = await observe(max, make(max), { flags: set.flags });
        // 全部 on の T2 は束の数に従う（要件 15 で束 3・要件 25 で束 5。Issue #626）。ほかの段は同じ
        const withoutT2 = (run: typeof medianRun) => {
          const { "test-spec": _logical, ...logical } = run.logical;
          const { "test-spec": _stages, ...stages } = run.stages;
          return resolveIds(set.flags) ? { logical, stages } : { logical: run.logical, stages: run.stages };
        };
        expect(withoutT2(maxRun), set.name).toEqual(withoutT2(medianRun));
        if (resolveIds(set.flags)) {
          const perBundle = make === cleanCalls ? [1, 0] : [2, 1];
          for (const [size, run] of [
            [MEDIAN_SIZE, medianRun],
            [MAX_SIZE, maxRun],
          ] as const) {
            expect(run.logical["test-spec"]).toBe(perBundle[0]! * t2Bundles(size.requirements) + perBundle[1]!);
          }
        }
        expect(maxRun.judge.j2).toBe(medianRun.judge.j2);
        expect(maxRun.judge.j4 / MAX_SIZE.requirements).toBe(medianRun.judge.j4 / MEDIAN_SIZE.requirements);
        logicalBySet.push(medianRun.logical);
      }
    }
    // ids off の 2 組は段ごとに同じ。全部 on（ids）は表を組む段（T1 → C1・C2）だけが違い、ほかの段は同じ（Issue #593）
    expect(logicalBySet.slice(2, 4)).toEqual(logicalBySet.slice(0, 2));
    const outsideTable = (counts: unknown) => {
      const { "name-table": _t1, vocabulary: _c1, mapping: _c2, ...rest } = counts as StageCounts;
      return rest;
    };
    // 全部 on の T2 は束 3（要件 15）：初回 3・やり直し 7。ids off は 1・3（Issue #626）
    const outsideT2 = (counts: unknown) => {
      const { "test-spec": _t2, ...rest } = outsideTable(counts) as Record<string, number>;
      return rest;
    };
    expect(logicalBySet.slice(4).map(outsideT2)).toEqual(logicalBySet.slice(0, 2).map(outsideT2));
    expect(logicalBySet.slice(4).map((counts) => (counts as StageCounts)["test-spec"])).toEqual([3, 7]);
    expect(logicalBySet.slice(0, 2).map((counts) => (counts as StageCounts)["test-spec"])).toEqual([1, 3]);
    expect(logicalBySet.slice(4).map((counts) => (counts as StageCounts)["name-table"])).toEqual([0, 0]);
  });

  it("束 1（要件 5 件以下）では、全部 on の T2 の期待の式が手 3e までの値（初回 1・やり直し 3・再送 2・6・生成の論理要求 8）に一致し、走りもその値になる", async () => {
    expect(t2Bundles(5)).toBe(1);
    const tables = FLAG_SET_TABLE["全部 on（--pipeline v1.2 と同じ組）"](5);
    expect(tables.clean["test-spec"]).toEqual(row(1));
    expect(tables.retry["test-spec"]).toEqual(row(3));
    expect(tables.cleanFail["test-spec"]).toEqual(row(1, 1, 2, 1));
    expect(tables.retryFail["test-spec"]).toEqual(row(3, 3, 6, 3));
    // 手 3e までの全部 on の表（T2 は段全体＝束 1）と、T2 の行を含めて全部の段で等しい
    expect(tables.clean).toEqual({ ...CLEAN_TABLE, "name-table": row(0), vocabulary: row(3), mapping: row(1) });
    expect(tables.retry).toEqual({ ...RETRY_TABLE, "name-table": row(0), vocabulary: row(4), mapping: row(3) });
    expect(cleanGeneration(5)).toBe(8);
    // 走り：要件 5・試験 15 の全部 on で、T2 の論理要求が初回 1・やり直し 3、再送を全部使うと実開始 2・6
    const set = FLAG_SETS[2];
    const materials = buildSized(5, 15, set.flags);
    expect(t2BundlesOf(materials)).toBe(1);
    const clean = await observe(materials, cleanCalls(materials), { flags: set.flags });
    const retry = await observe(materials, retryCalls(materials), { flags: set.flags });
    const cleanFail = await observe(materials, cleanCalls(materials), { flags: set.flags, failFirst: true });
    const retryFail = await observe(materials, retryCalls(materials), { flags: set.flags, failFirst: true });
    expectTable(clean, tables.clean, "束 1 初回");
    expectTable(retry, tables.retry, "束 1 やり直し");
    expectTable(cleanFail, tables.cleanFail, "束 1 再送（初回）");
    expectTable(retryFail, tables.retryFail, "束 1 再送（やり直し）");
    expect(clean.totalLogical).toBe(8);
    expect(t2RecordsOfRun(retry)).toHaveLength(1);
  });

  it("段 × 旗の組の表の段は、上限の表の v1.1α の写し（V12_V11A_FRAME_MAP）の段と同じ。§4.1 の列の枠を超えない", () => {
    expect(new Set(V12_V11A_FRAME_MAP.map((entry) => entry.v11a))).toEqual(new Set(STAGES));
    expect(V12_V11A_FRAME_MAP).toHaveLength(STAGES.length);
    const frameOf = (stage: V12FrameStage) => V12_STAGE_FRAMES.find((frame) => frame.stage === stage);
    for (const entry of V12_V11A_FRAME_MAP) {
      const logical = RETRY_TABLE[entry.v11a as StageKey].logical;
      // やり直しを含む走りの段の論理要求は、v1.1α の回数（回 × 形の試行 × 版・往復）の内側
      expect(logical, entry.v11a).toBeLessThanOrEqual(entry.rounds * entry.shapeAttempts * (entry.units ?? 1));
      for (const frame of entry.frames) expect(frameOf(frame), frame).toBeDefined();
    }
  });
});

describe("(5') 旗 v12.ids の C1・C2 の枠（手 3a・Issue #593）", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);

  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements：記録は vocabulary が束の数・mapping が呼び出しの回の数で name-table が無く、retries は束 2 の形 1・C2 の形 1・中身 1", async (size) => {
    const materials = buildSized(size.requirements, size.tests, ALL_ON);
    const clean = await observe(materials, cleanCalls(materials), { flags: ALL_ON });
    const retry = await observe(materials, retryCalls(materials), { flags: ALL_ON });
    for (const run of [clean, retry]) {
      const stages = run.result.record.stages;
      expect(stages.filter((record) => record.stage === "vocabulary")).toHaveLength(3);
      expect(stages.some((record) => record.stage === "name-table")).toBe(false);
      for (const record of stages.filter((entry) => entry.stage === "vocabulary" || entry.stage === "mapping")) {
        expect(record.references, record.stage).toBeDefined();
      }
      for (const record of stages.filter((entry) => entry.stage !== "vocabulary" && entry.stage !== "mapping")) {
        expect(record, record.stage).not.toHaveProperty("references");
      }
    }
    expect(clean.result.record.stages.filter((record) => record.stage === "mapping")).toHaveLength(1);
    // C3 の拒否のあとの 2 回目は C2 だけ（C1 は呼ばない）。mapping の記録は 2 回
    expect(retry.result.record.stages.filter((record) => record.stage === "mapping")).toHaveLength(2);
    expect(retry.stages.vocabulary.retries).toEqual({ communication: 0, shape: 1, content: 0 });
    expect(retry.stages.mapping.retries).toEqual({ communication: 0, shape: 1, content: 1 });
    expect(retry.stages["semantic-check"].retries).toEqual({ communication: 0, shape: 1, content: 0 });
    // 2 回目の C2 の要求は前回の写像・拒否・印のデータを持つ
    const mappingRequests = retry.requests.filter((request) => request.includes(`"schemaName":"${MAPPING_SCHEMA_NAME}"`));
    expect(mappingRequests).toHaveLength(3);
    expect(mappingRequests[2]).toContain("前回の写像");
    expect(mappingRequests[2]).toContain("表の点検の拒否");
    // 束 2 の形のやり直しは束 2 の要求だけ（束 1・3 は 1 回ずつ）
    const bundleRequests = (name: string) => retry.requests.filter((request) => request.includes(`"schemaName":"${name}"`)).length;
    expect(Object.values(VOCABULARY_SCHEMA_NAMES).map(bundleRequests)).toEqual([1, 2, 1]);
    expect(retry.totalLogical).toBeLessThanOrEqual(V12_CALL_LIMITS.logicalCalls);
    // 落ちた束 2・C2 の記録の参照の照合の数（知らない ID・欠落）
    const fieldsRecord = retry.result.record.stages.filter((record) => record.stage === "vocabulary")[1];
    expect(fieldsRecord?.references?.unknown_ids).toBeGreaterThanOrEqual(1);
  });
});

describe("(5'') 旗 v12.ids の C2 は全要件を 1 回で写す（手 3b の束を戻した。Issue #627）", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
  const [entities, fields, behaviors, mapping, ...rest] = materials.tableResponses() as readonly Record<string, readonly Record<string, unknown>[]>[];
  if (entities === undefined || fields === undefined || behaviors === undefined || mapping === undefined || rest.length > 0) {
    throw new Error("前提が壊れた：C1 の 3 束と C2 の 1 つでない");
  }
  type Entry = Record<string, unknown>;
  const entries = (): Entry[] => ((mapping["requirements"] ?? []) as readonly Entry[]).map((entry) => ({ ...entry }));
  const vocabulary = () => [structured(entities), structured(fields), structured(behaviors)];
  const mappingRequestsOf = (run: Awaited<ReturnType<typeof observe>>) => run.requests.filter((request) => request.includes(`"schemaName":"${MAPPING_SCHEMA_NAME}"`));
  const mappingRecordsOf = (run: Awaited<ReturnType<typeof observe>>) => run.result.record.stages.filter((record) => record.stage === "mapping");
  const carryOf = (run: Awaited<ReturnType<typeof observe>>) =>
    JSON.parse(run.result.bundle?.artifacts.find((artifact) => artifact.path === "artifacts/carry-over.json")?.text ?? "{}") as Record<string, unknown>;
  /** C3 が拒否した要件を除いた T2・B1・B3' の応答（持ち越しの要件は T2 に見せない） */
  const tailWithout = (excluded: readonly string[]) => {
    const t2 = materials.testSpecCasesResponse();
    return [
      structured({
        classifications: (t2.classifications as readonly { requirementId: string }[]).filter((entry) => !excluded.includes(entry.requirementId)),
        // 旗 v12.ids の走りの T2 は場合の形（#625）
        cases: t2.cases.filter((entry) => !excluded.includes(String(entry["requirementId"]))),
      }),
      structured({ declaration: materials.declaration() }),
      structured({ judgments: (materials.judgments().judgments as readonly { requirementId: string }[]).filter((entry) => !excluded.includes(entry.requirementId)) }),
    ];
  };
  /** 一覧の末尾の要件（C3 が R1 と一緒に拒否する要件。要件 15 では束 3 にあった要件） */
  const LAST = materials.ids.at(-1) as string;

  it.each([MEDIAN_SIZE.requirements, 7])("要件 %i でも、C2 の初回の要求は 1 本で、データに全要件がある（記録も 1 つ）", async (count) => {
    const sized = buildSized(count, 3 * count, ALL_ON);
    const run = await observe(sized, cleanCalls(sized), { flags: ALL_ON });
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(mappingRequestsOf(run).map(listedIds)).toEqual([sized.ids]);
    expect(mappingRecordsOf(run)).toHaveLength(1);
  });

  it("形で落ちると、やり直しの要求は 1 本（全要件）。2 回続けば段 mapping・unmet で止まる（終了コード 1・納品物無し）。断った候補に束の欄は無い", async () => {
    const missing = { requirements: entries().slice(1) };
    const run = await observe(materials, [...vocabulary(), structured(missing), structured(missing)], { flags: ALL_ON });
    expect(run.result.stopped).toMatchObject({ stage: "mapping", kind: "unmet" });
    expect(run.result.summary.exit_code).toBe(1);
    expect(run.result.bundle).toBeNull();
    expect(mappingRequestsOf(run).map(listedIds)).toEqual([materials.ids, materials.ids]);
    expect(mappingRequestsOf(run)[1]).toContain("前回の形の問題");
    expect(mappingRecordsOf(run).map((record) => [record.status, record.retries.shape])).toEqual([["failed", 1]]);
    const file = run.result.diagnostics.find((artifact) => artifact.path === "diagnostics/rejected-mapping.json");
    const candidates = (JSON.parse(file?.text ?? "{}") as { readonly candidates?: readonly Record<string, unknown>[] }).candidates ?? [];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ stage: "mapping", call: 1, attempt: 2 });
    expect(candidates[0]).not.toHaveProperty("bundle");
  });

  it("どの要件にも所属しない行がある応答は、C2' の固定文で形のやり直し 1 回のあと段 mapping・unmet で止まる（C3 を呼ばない）", async () => {
    const first = entries();
    const orphan = { requirements: first.map((entry, index) => (index === 0 ? { ...entry, roles: first[1]?.["roles"] } : entry)) };
    const run = await observe(materials, [...vocabulary(), structured(orphan), structured(orphan)], { flags: ALL_ON });
    expect(run.result.stopped).toMatchObject({ stage: "mapping", kind: "unmet" });
    expect(run.result.stopped?.problems?.map((problem) => problem.message)).toContain("どの要件にも所属しない行がある");
    expect(mappingRequestsOf(run)).toHaveLength(2);
    expect(run.logical["semantic-check"]).toBe(0);
  });

  it("C3 の拒否のあとの 2 回目の要求は 1 本（全要件・前回の写像・拒否・印）で、C3 の再点検は 1 回。再び拒否なら持ち越し（partial）", async () => {
    const reject = materials.judgments({ [LAST]: ["unnecessary-ownership", materials.textOf(LAST)] });
    const run = await observe(materials, [...vocabulary(), structured(mapping), structured(reject), structured(mapping), structured(reject), ...tailWithout([LAST])], { flags: ALL_ON });
    const requests = mappingRequestsOf(run);
    expect(requests.map(listedIds)).toEqual([materials.ids, materials.ids]);
    for (const name of ["前回の写像", "表の点検の拒否", "助言の印"]) expect(requests[1]).toContain(`<data name=\\"${name}\\">`);
    expect(requests[1]).toContain(LAST);
    expect(run.logical["semantic-check"]).toBe(2);
    expect(mappingRecordsOf(run).map((record) => [record.status, record.retries.content])).toEqual([
      ["ok", 0],
      ["ok", 1],
    ]);
    expect(run.result.outcome.verdict).toBe("partial");
    expect(carryOf(run)).toMatchObject({ entries: [{ requirementId: LAST, reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] }] });
  });

  it("C3 が要件 2 件を拒否し、2 回目の応答が C2' に落ちると、形の再試行も C3 の再点検も無く、2 件とも持ち越しに残り full にならない（#623 の性質）", async () => {
    const reject = materials.judgments({
      R1: ["unnecessary-ownership", materials.textOf("R1")],
      [LAST]: ["unnecessary-ownership", materials.textOf(LAST)],
    });
    const run = await observe(
      materials,
      [...vocabulary(), structured(mapping), structured(reject), structured({ requirements: entries().slice(1) }), ...tailWithout(["R1", LAST])],
      { flags: ALL_ON },
    );
    expect(mappingRequestsOf(run)).toHaveLength(2);
    expect(mappingRecordsOf(run).map((record) => [record.status, record.failure_kind])).toEqual([
      ["ok", null],
      ["failed", "unmet"],
    ]);
    expect(run.logical["semantic-check"]).toBe(1);
    expect(run.result.stopped).toBeNull();
    expect(run.result.outcome.verdict).toBe("partial");
    const reasons = [{ origin: "semantic-check", reason: "unnecessary-ownership" }];
    expect(carryOf(run)).toEqual(expect.objectContaining({ entries: [{ requirementId: "R1", reasons }, { requirementId: LAST, reasons }] }));
  });

  it("同じ走りで T2 の応答に拒否の 2 件を含め、後続の段を全件受理にしても、full にならず 2 件は持ち越し（出どころ semantic-check）に残る（#623 の再現の単回の形）", async () => {
    const reject = materials.judgments({
      R1: ["unnecessary-ownership", materials.textOf("R1")],
      [LAST]: ["unnecessary-ownership", materials.textOf(LAST)],
    });
    const bySchema = (): Readonly<Record<string, readonly RecordedCall[]>> => ({
      ...Object.fromEntries(Object.values(VOCABULARY_SCHEMA_NAMES).map((name, index) => [name, [structured([entities, fields, behaviors][index])]])),
      [MAPPING_SCHEMA_NAME]: [structured(mapping), structured({ requirements: entries().slice(1) })],
      [SEMANTIC_CHECK_SCHEMA_NAME]: [structured(reject), structured(materials.judgments())],
      [TEST_SPEC_SCHEMA_NAME]: [1, 2, 3].map(() => structured(materials.t2Response())),
      [WRITE_V11A_SCHEMA_NAME]: [structured({ declaration: materials.declaration() })],
      [DECL_CHECK_SCHEMA_NAME]: [structured(materials.judgments())],
    });
    // 持ち越しの 2 件の分類・場合は、T2 の最初の束（残る要件の先頭 R2 の束）の応答に残す（Issue #626）
    const firstRequested = materials.ids.find((id) => id !== "R1" && id !== LAST) ?? "";
    const run = await observe(materials, [], { flags: ALL_ON, bySchema: bySchema(), home: [["R1", firstRequested], [LAST, firstRequested]] });
    // 同じ記録を C3 の後の境界で止めて、採用した持ち越しを読む：2 件とも出どころ semantic-check で残る
    const ranged = await runStageRangeV11a({
      source: materials.source,
      documents: FIXTURE_DOCUMENTS,
      client: createMouth([], false, bySchema()).client,
      judge: createCountingJudge(materials.adviceAnswers()).judge,
      budgetUsd: 1_000,
      rates: RATES,
      now: () => 0,
      deadline: 86_400_000,
      runId: "run-calls",
      storageUnit: "unit-calls",
      builder: "musunest-factory",
      model: "gpt-test",
      effort: "high",
      promptVersion: "v1.1a",
      contractVersion: "v0.2",
      specEngineVersion: "0.0.0",
      factoryVersion: "0.0.0",
      plan: materials.plan,
      flags: ALL_ON,
      range: { start: "name-table", end: "semantic-check" },
    });
    expect(ranged.stopped).toBeNull();
    const reasons = [{ origin: "semantic-check", reason: "unnecessary-ownership" }];
    expect(ranged.boundaries[0]?.carryOver.entries).toEqual([
      { requirementId: "R1", reasons },
      { requirementId: LAST, reasons },
    ]);
    expect(run.logical["semantic-check"]).toBe(1);
    expect(run.result.outcome.verdict).not.toBe("full");
    // 2 件は残る要件に戻らない：T2 の要求の要件の一覧に無い
    const t2Requests = run.requests.filter((request) => request.includes(`"schemaName":"${TEST_SPEC_SCHEMA_NAME}"`));
    expect(t2Requests.length).toBeGreaterThan(0);
    for (const request of t2Requests) {
      const listed = listedIds(request);
      expect(listed).not.toContain("R1");
      expect(listed).not.toContain(LAST);
    }
    // T2 の応答が持ち越しの要件の分類・試験を含むので断り、段 test-spec で止まる（終了コード 1・納品物無し）。手 3f（Issue #626）
    // から、一覧に無い要件 ID は束の形の検査が同じ固定文で断るので、2 回続けば形の落ち（malformed）で止まる
    expect(run.result.stopped).toMatchObject({ stage: "test-spec", kind: "malformed" });
    expect(run.result.stopped?.problems?.map((problem) => problem.message)).toContain("要件の一覧に無い要件 ID の分類である");
    // 診断の断った候補にも同じ固定文が残る（Issue #626 の窓口の条件）
    const rejected = JSON.parse(run.result.diagnostics.find((artifact) => artifact.path === DIAGNOSTICS_REJECTED_TEST_SPEC_FILE)?.text ?? "null") as {
      readonly candidates: readonly { readonly problems: readonly { readonly message: string }[] }[];
    } | null;
    expect(rejected?.candidates.flatMap((candidate) => candidate.problems.map((problem) => problem.message))).toContain("要件の一覧に無い要件 ID の分類である");
    expect(run.result.outcome).toEqual({ result: "failed", verdict: "none" });
    expect(run.result.summary.exit_code).toBe(1);
    expect(run.result.bundle).toBeNull();
  });
});

/** 旗の組の ids が on か */
function resolveIds(flags: Partial<V12Flags>): boolean {
  return flags.ids === true;
}

// ── (6) 旗 v12.ids の門と枝（手 3p。Issue #592）──────────────────────────────────────

describe("(6) 旗 v12.ids の実試行の門と判定の枝", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  /** 表を組む段（C1・C2）の要求の数（J4 より前の生成） */
  const TABLE_GENERATION = 4;

  it("(1) 全部 on の初回で通る走り：門の数＝生成の実開始＋判定の実試行、枝の数＝J4 の要件の数。再送を全部使うと門は再送の分だけ増える", async () => {
    for (const size of [MEDIAN_SIZE, MAX_SIZE]) {
      const materials = buildSized(size.requirements, size.tests, ALL_ON);
      const clean = await observe(materials, cleanCalls(materials), { flags: ALL_ON });
      expect(clean.result.outcome).toEqual({ result: "pass", verdict: "full" });
      expect(clean.calls).toEqual({
            test_spec: t2SummaryOf(clean),
        real_attempts: { limit: 144, used: clean.totalStarted + size.requirements },
        judge_branch: { limit: 80, used: size.requirements },
      });
      const failed = await observe(materials, cleanCalls(materials), { flags: ALL_ON, failFirst: true });
      expect(failed.result.outcome).toEqual({ result: "pass", verdict: "full" });
      expect(failed.totalCommunicationRetries).toBe(cleanGeneration(size.requirements));
      expect(failed.calls?.real_attempts.used).toBe((clean.calls?.real_attempts.used ?? 0) + failed.totalCommunicationRetries);
      expect(failed.calls?.judge_branch.used).toBe(size.requirements);
    }
  });

  it("(1') Jev→LLM の切り替え：主が落ちて落とし先が答えると、切り替えの 2 試行とも門と枝に数える", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const failing: Judge = {
      source: "jev",
      async judge() {
        throw new Error("主の判定が落ちた");
      },
    };
    const run = await observe(materials, cleanCalls(materials), {
      flags: ALL_ON,
      wrapJudge: (fake) => createFallbackJudge({ primary: failing, fallback: fake }),
    });
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(run.calls).toEqual({
            test_spec: t2SummaryOf(run),
      real_attempts: { limit: 144, used: cleanGeneration(MEDIAN_SIZE.requirements) + 2 * MEDIAN_SIZE.requirements },
      judge_branch: { limit: 80, used: 2 * MEDIAN_SIZE.requirements },
    });
  });

  it("(2) 門を要件 15 の初回の合計より 1 小さくすると、生成の call-limit で止まり（B3'・終了コード 1・納品物無し）、判定の呼び出しはそれ以上増えない", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const firstTotal = cleanGeneration(MEDIAN_SIZE.requirements) + MEDIAN_SIZE.requirements;
    const run = await observe(materials, cleanCalls(materials), { flags: ALL_ON, v12CallLimits: { realAttempts: firstTotal - 1 } });
    expect(run.result.stopped).toMatchObject({ stage: "decl-check", kind: "call-limit" });
    expect(run.result.summary.stop_reason).toBe("call-limit");
    expect(run.result.outcome.verdict).toBe("none");
    expect(run.result.summary.exit_code).toBe(1);
    expect(run.result.bundle).toBeNull();
    expect(run.stages["decl-check"]).toMatchObject({ started: 0, notStartedLimit: 1 });
    expect(run.judge).toEqual({ j4: MEDIAN_SIZE.requirements, j2: 0 });
    expect(run.calls).toEqual({
            test_spec: t2SummaryOf(run),
      real_attempts: { limit: firstTotal - 1, used: firstTotal - 1 },
      judge_branch: { limit: 80, used: MEDIAN_SIZE.requirements },
    });
  });

  it("(2') 門が J4 の途中で尽きると、残りの J4 は未判定（gate）で判定を呼ばず、次の生成（T1''）が call-limit で止まる", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    // J4 の前の生成（C1・C2）の 4 試行のあと、J4 を 9 本だけ通す門
    const gate = TABLE_GENERATION + 9;
    const run = await observe(materials, cleanCalls(materials), { flags: ALL_ON, v12CallLimits: { realAttempts: gate } });
    expect(run.judge).toEqual({ j4: 9, j2: 0 });
    expect(run.result.stopped).toMatchObject({ stage: "semantic-check", kind: "call-limit" });
    expect(run.result.summary.exit_code).toBe(1);
    expect(run.result.bundle).toBeNull();
    expect(run.calls?.real_attempts.used).toBe(gate);
  });

  it("(3) 判定の枝を J4 の要件の数より 1 小さくすると、最後の要件の J4 が未判定（gate）、J2 は ruled、本は止まらず、門に判定の失敗を数えない", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    // T2 の分類で R1 を existence-only にして、T1 の分類（ruled）と食い違わせる（J2 を呼ぶ道）
    const t2 = materials.t2Response();
    const discrepant = {
      ...t2,
      classifications: (t2.classifications as readonly { requirementId: string; nature: string }[]).map((entry) =>
        entry.requirementId === "R1" ? { ...entry, nature: "existence-only" } : entry,
      ),
    };
    const calls = cleanCalls(materials);
    calls[materials.tableResponses().length + 1] = structured(discrepant);
    const branch = MEDIAN_SIZE.requirements - 1;
    const run = await observe(materials, calls, { flags: ALL_ON, v12CallLimits: { judgeBranch: branch } });
    expect(run.result.stopped).toBeNull();
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    // 枝が断った J4（最後の要件）と J2 は、判定の口に届かない
    expect(run.judge).toEqual({ j4: branch, j2: 0 });
    const advice = JSON.parse(run.result.bundle?.artifacts.find((artifact) => artifact.path === "artifacts/judge-advice.json")?.text ?? "{}") as {
      readonly rounds: readonly { readonly requests: readonly { readonly requirementId: string; readonly adapter: string | null; readonly questions: readonly { readonly undetermined: string | null }[] }[] }[];
    };
    const requests = advice.rounds[0]?.requests ?? [];
    const last = requests.at(-1);
    expect(last?.requirementId).toBe(`R${String(MEDIAN_SIZE.requirements)}`);
    expect(last?.adapter).toBeNull();
    expect(last?.questions.every((question) => question.undetermined === "gate")).toBe(true);
    expect(requests.slice(0, -1).every((request) => request.questions.every((question) => question.undetermined === null))).toBe(true);
    // J2 は既定 ruled（判定に聞かず落とし先にも切り替えない。受理で埋めない）
    expect(run.result.summary.nature_discrepancies).toEqual([
      { requirement_id: "R1", design: "ruled", classified: "existence-only", resolved: "ruled", resolution: "fallback" },
    ]);
    // 門の数は生成の実開始＋枝を通った判定だけ（断った判定を数えない）
    expect(run.calls).toEqual({
            test_spec: t2SummaryOf(run),
      real_attempts: { limit: 144, used: run.totalStarted + branch },
      judge_branch: { limit: branch, used: branch },
    });
  });

  it("(4) 旗 off（全部 off・前の手の旗だけ on）の走りは判定を門に数えない（実開始は生成だけ・今と同じ数・要約に門の欄が無い）", async () => {
    for (const flags of [{}, { ledger: true, searchRepair: true }]) {
      const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, flags);
      const run = await observe(materials, cleanCalls(materials), { flags });
      expect(run.totalStarted).toBe(5);
      expect(run.judge).toEqual({ j4: MEDIAN_SIZE.requirements, j2: 0 });
      expect(run.result.summary).not.toHaveProperty("v12_calls");
      // 門 24 を 5 に下げても、判定（15）は数えられず完走する
      const tight = await observe(materials, cleanCalls(materials), { flags, limits: { callCount: 5 } });
      expect(tight.result.outcome).toEqual({ result: "pass", verdict: "full" });
    }
  });
});

// ── (7) 旗 v12.ids のコードが作る試験（手 3c・Issue #595）──────────────────────────────

describe("(7) 旗 v12.ids のコードが作る試験：既定値・選択肢の集合・空の集計の要件を含む台本で、T2 の論理要求は初回 1・形 1・中身 1 のまま、組の数が同じで応答の試験の数が作った分だけ少ない", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  const PRIOR = { ledger: true, searchRepair: true } as const;
  /** 表を組む段・T1''・T2（形の落ち → R4 の異常が欠けて中身の落ち → 通る）・B1・B3' */
  const t2RetryCalls = (materials: SizedMaterials): RecordedCall[] => [
    ...materials.tableResponses().map(structured),
    structured(materials.judgments()),
    structured(negative({ classifications: "x", tests: "x" }, "classifications・tests が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
    structured(materials.t2Response({ omitAbnormalOf: "R4" })),
    structured(materials.t2Response()),
    structured({ declaration: materials.declaration() }),
    structured(materials.judgments()),
  ];
  const suiteOf = (run: Awaited<ReturnType<typeof observe>>) => {
    const artifact = run.result.bundle?.artifacts.find((entry) => entry.path === "artifacts/test-spec.json");
    if (artifact === undefined) throw new Error("前提が壊れた：T2 の成果物が無い");
    return JSON.parse(artifact.text) as { readonly suite: { readonly tests: readonly { readonly id: string }[] }; readonly generated_test_ids?: readonly string[] };
  };

  it("台本の生成器：同じ N・M から同じ値。組の試験の数は M（ids off の応答）で、ids on の応答はコードが作る分（4）だけ少ない。台帳 off には組めない", () => {
    for (const size of [MEDIAN_SIZE, MAX_SIZE]) {
      const off = buildSized(size.requirements, size.tests, PRIOR, { codeWritten: true });
      const on = buildSized(size.requirements, size.tests, ALL_ON, { codeWritten: true });
      expect(buildSized(size.requirements, size.tests, ALL_ON, { codeWritten: true }).testSpecResponse()).toEqual(on.testSpecResponse());
      expect(off.testSpecResponse().tests).toHaveLength(size.tests);
      // 手 3d（#624）から、構造の要件の構造の検査と R3 の在ることの確認もコードが作る
      expect(on.generatedTestCount).toBe(CODE_WRITTEN_TEST_COUNT + 1 + on.structuralCount);
      expect(on.testSpecResponse().tests).toHaveLength(size.tests - on.generatedTestCount);
      expect(off.table.verification.slice(0, 3).map((entry) => entry.kind)).toEqual(["default-value", "enum-membership", "fixed-test"]);
      expect(on.declaration()).toBe(off.declaration());
      // 台本を渡さない材料は今のまま
      expect(buildSized(size.requirements, size.tests, PRIOR, {}).testSpecResponse()).toEqual(buildSized(size.requirements, size.tests, PRIOR).testSpecResponse());
    }
    expect(() => buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, {}, { codeWritten: true })).toThrow(RangeError);
  });

  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests：ids on・ids off とも T2 の論理要求 3（初回 1・形 1・中身 1）・retries 形 1 中身 1 で full。組の数は M で同じ、ids on の応答は 4 少なく、作った試験 ID が 4 つ", async (size) => {
    const off = buildSized(size.requirements, size.tests, PRIOR, { codeWritten: true });
    const on = buildSized(size.requirements, size.tests, ALL_ON, { codeWritten: true });
    const offRun = await observe(off, t2RetryCalls(off), { flags: PRIOR });
    const onRun = await observe(on, t2RetryCalls(on), { flags: ALL_ON });
    for (const run of [offRun, onRun]) {
      expect(run.result.stopped, JSON.stringify(run.result.stopped)).toBeNull();
      expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
      // ids off は 1 回の要求（初回 1・形 1・中身 1）。ids on は束 k（初回 k・形 k・中身 1。中身の落ちは R の束だけ。Issue #626）
      const k = run === onRun ? t2BundlesOf(on) : 1;
      expect(run.logical["test-spec"]).toBe(2 * k + 1);
      expect(run.stages["test-spec"].retries).toEqual({ communication: 0, shape: k, content: 1 });
      expect(suiteOf(run).suite.tests).toHaveLength(size.tests);
      expectNoAcceptanceMaterial(run.requests);
    }
    // ids on：作った試験は組の末尾（予約の接頭辞）。手 3d（#624）から構造の検査と在ることの確認を含む。ids off の成果物に欄は無い
    const generatedIds = suiteOf(onRun).generated_test_ids ?? [];
    expect(generatedIds).toHaveLength(on.generatedTestCount);
    expect(suiteOf(onRun).suite.tests.slice(-on.generatedTestCount).map((test) => test.id)).toEqual(generatedIds);
    expect(generatedIds.every(isGeneratedTestId)).toBe(true);
    expect(suiteOf(offRun)).not.toHaveProperty("generated_test_ids");
    // 論理の枠・門・枝の内側（全部 on）
    expect(onRun.totalLogical).toBeLessThanOrEqual(V12_CALL_LIMITS.logicalCalls);
    expect(onRun.calls?.real_attempts.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.realAttempts);
    expect(onRun.calls?.judge_branch.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.judgeBranch);
  });
});

// ── (8) 旗 v12.ids の構造の検査と画面・在ることの構造の確認（手 3d・Issue #624）──────────────────────────────

describe("(8) 旗 v12.ids の構造の検査と画面・在ることの構造の確認：画面の行を所属に持つ決まりの要件と checks 2 つの構造の要件を含む台本で、T2 の論理要求は初回 1・形 1・中身 1 のまま、LLM に書かせる試験は M − コードが作る数、応答は手 3c の応答の (M − コードが作る数)／M 以下", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  const PRIOR = { ledger: true, searchRepair: true } as const;
  const OPTIONS = { codeWritten: true, screens: true } as const;
  const t2RetryCalls = (materials: SizedMaterials): RecordedCall[] => [
    ...materials.tableResponses().map(structured),
    structured(materials.judgments()),
    structured(negative({ classifications: "x", tests: "x" }, "classifications・tests が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
    structured(materials.t2Response({ omitAbnormalOf: "R4" })),
    structured(materials.t2Response()),
    structured({ declaration: materials.declaration() }),
    structured(materials.judgments()),
  ];
  const firstPassCalls = (materials: SizedMaterials): RecordedCall[] => [
    ...materials.tableResponses().map(structured),
    structured(materials.judgments()),
    structured(materials.t2Response()),
    structured({ declaration: materials.declaration() }),
    structured(materials.judgments()),
  ];
  const suiteOf = (run: Awaited<ReturnType<typeof observe>>) => {
    const artifact = run.result.bundle?.artifacts.find((entry) => entry.path === "artifacts/test-spec.json");
    if (artifact === undefined) throw new Error("前提が壊れた：T2 の成果物が無い");
    return JSON.parse(artifact.text) as { readonly suite: { readonly tests: readonly { readonly id: string; readonly operation: string }[] }; readonly generated_test_ids?: readonly string[] };
  };

  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests：LLM に書かせる試験の数は M − コードが作る数で、応答の JSON の文字数は手 3c の応答の (M − コードが作る数)／M 以下", (size) => {
    // 台本 screens だけ（手 3c がコードで作る試験の無い台本。手 3c の応答は M 件）
    const on = buildSized(size.requirements, size.tests, ALL_ON, { screens: true });
    const off = buildSized(size.requirements, size.tests, PRIOR, { screens: true });
    const generated = on.generatedTestCount;
    // コードが作る数：構造の検査（構造の要件の checks の数＝構造の要件の数＋1）と画面 1
    expect(generated).toBe(on.structuralCount + 1 + 1);
    expect(off.testSpecResponse().tests).toHaveLength(size.tests);
    expect(on.testSpecResponse({ asOf3c: true }).tests).toHaveLength(size.tests);
    expect(on.testSpecResponse().tests).toHaveLength(size.tests - generated);
    const now = JSON.stringify(on.testSpecResponse()).length;
    const as3c = JSON.stringify(on.testSpecResponse({ asOf3c: true })).length;
    expect(now).toBeLessThanOrEqual((as3c * (size.tests - generated)) / size.tests);
    // 台本 codeWritten を足しても、LLM に書かせる試験の数は M − コードが作る数（手 3c の応答は 4 件少ない M − 4 件）
    const both = buildSized(size.requirements, size.tests, ALL_ON, OPTIONS);
    expect(both.generatedTestCount).toBe(on.structuralCount + 1 + 1 + CODE_WRITTEN_TEST_COUNT + 1);
    expect(both.testSpecResponse().tests).toHaveLength(size.tests - both.generatedTestCount);
    expect(both.testSpecResponse({ asOf3c: true }).tests).toHaveLength(size.tests - CODE_WRITTEN_TEST_COUNT);
  });

  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests：ids on・ids off とも T2 の論理要求 3（初回 1・形 1・中身 1）で full。組の数は M で同じ、作った試験 ID に構造の検査と画面の確認がある。呼び出しの合計は論理 72・実試行 144・判定 80 以下", async (size) => {
    const off = buildSized(size.requirements, size.tests, PRIOR, OPTIONS);
    const on = buildSized(size.requirements, size.tests, ALL_ON, OPTIONS);
    const offRun = await observe(off, t2RetryCalls(off), { flags: PRIOR });
    const onRun = await observe(on, t2RetryCalls(on), { flags: ALL_ON });
    for (const run of [offRun, onRun]) {
      expect(run.result.stopped, JSON.stringify(run.result.stopped)).toBeNull();
      expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
      // ids off は 1 回の要求（初回 1・形 1・中身 1）。ids on は束 k（初回 k・形 k・中身 1。中身の落ちは R の束だけ。Issue #626）
      const k = run === onRun ? t2BundlesOf(on) : 1;
      expect(run.logical["test-spec"]).toBe(2 * k + 1);
      expect(run.stages["test-spec"].retries).toEqual({ communication: 0, shape: k, content: 1 });
      expect(suiteOf(run).suite.tests).toHaveLength(size.tests);
      expectNoAcceptanceMaterial(run.requests);
    }
    const generatedIds = suiteOf(onRun).generated_test_ids ?? [];
    expect(generatedIds).toHaveLength(on.generatedTestCount);
    const generatedOps = suiteOf(onRun).suite.tests.filter((test) => generatedIds.includes(test.id)).map((test) => test.operation);
    expect(generatedOps.filter((operation) => operation === "structure")).toHaveLength(on.structuralCount + 1);
    expect(generatedOps.filter((operation) => operation === "screen")).toHaveLength(2);
    expect(onRun.totalLogical).toBeLessThanOrEqual(V12_CALL_LIMITS.logicalCalls);
    expect(onRun.calls?.real_attempts.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.realAttempts);
    expect(onRun.calls?.judge_branch.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.judgeBranch);
    // 初回で通る走りの T2 の論理要求は束の数（束ごとに 1。Issue #626）
    const passed = await observe(on, firstPassCalls(on), { flags: ALL_ON });
    expect(passed.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(passed.logical["test-spec"]).toBe(t2BundlesOf(on));
  });
});

// ── (9) 旗 v12.ids の場合の形の T2（手 3e・Issue #625）──────────────────────────────

describe("(9) 旗 v12.ids の場合の形の T2：T2 の論理要求は初回 1・形 1・中身 1 のまま、応答の文字数は同じ N・M の手 3d の応答の 0.65 倍以下で、組の数は M", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  /** 表を組む段・T1''・T2（形の落ち → R1 の異常が欠けて中身の落ち → 通る）・B1・B3' */
  const t2RetryCalls = (materials: SizedMaterials): RecordedCall[] => [
    ...materials.tableResponses().map(structured),
    structured(materials.judgments()),
    structured(negative({ classifications: "x", cases: "x" }, "classifications・cases が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
    structured(materials.t2Response({ omitAbnormalOf: "R1" })),
    structured(materials.t2Response()),
    structured({ declaration: materials.declaration() }),
    structured(materials.judgments()),
  ];
  const suiteOf = (run: Awaited<ReturnType<typeof observe>>) => {
    const artifact = run.result.bundle?.artifacts.find((entry) => entry.path === "artifacts/test-spec.json");
    if (artifact === undefined) throw new Error("前提が壊れた：T2 の成果物が無い");
    return JSON.parse(artifact.text) as { readonly suite: { readonly tests: readonly unknown[] }; readonly llm_case_count?: number; readonly llm_response_chars?: number };
  };

  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests：場合の形の応答の JSON の文字数が手 3d の応答（同じ内容・同じ直列化）の 0.65 倍以下で、場合の数は手 3d の試験の数と同じ", (size) => {
    for (const options of [{}, { codeWritten: true, screens: true }] as const) {
      const on = buildSized(size.requirements, size.tests, ALL_ON, options);
      const as3d = on.testSpecResponse();
      const cases = on.testSpecCasesResponse();
      expect(cases.cases).toHaveLength(as3d.tests.length);
      expect(on.t2Response()).toEqual(cases);
      expect(JSON.stringify(cases).length).toBeLessThanOrEqual(JSON.stringify(as3d).length * 0.65);
      // 旗 ids off の走りの応答は今の形のまま
      expect(buildSized(size.requirements, size.tests, { ledger: true, searchRepair: true }, options).t2Response()).toEqual(
        buildSized(size.requirements, size.tests, { ledger: true, searchRepair: true }, options).testSpecResponse(),
      );
    }
  });

  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests：T2 の論理要求 3（初回 1・形 1・中身 1）で full、組の数は M。初回で通る走りは 1。呼び出しの合計は論理 72・実試行 144・判定 80 以下", async (size) => {
    const on = buildSized(size.requirements, size.tests, ALL_ON);
    const retried = await observe(on, t2RetryCalls(on), { flags: ALL_ON });
    expect(retried.result.stopped, JSON.stringify(retried.result.stopped)).toBeNull();
    expect(retried.result.outcome).toEqual({ result: "pass", verdict: "full" });
    // 束 k：初回 k・形 k・中身 1（R1 の束だけ。Issue #626）
    const k = t2BundlesOf(on);
    expect(retried.logical["test-spec"]).toBe(2 * k + 1);
    expect(retried.stages["test-spec"].retries).toEqual({ communication: 0, shape: k, content: 1 });
    expect(suiteOf(retried).suite.tests).toHaveLength(size.tests);
    expect(suiteOf(retried).llm_case_count).toBe(on.testSpecCasesResponse().cases.length);
    expect(retried.totalLogical).toBeLessThanOrEqual(V12_CALL_LIMITS.logicalCalls);
    expect(retried.calls?.real_attempts.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.realAttempts);
    expect(retried.calls?.judge_branch.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.judgeBranch);
    expectNoAcceptanceMaterial(retried.requests);
    const passed = await observe(on, cleanCalls(on), { flags: ALL_ON });
    expect(passed.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(passed.logical["test-spec"]).toBe(k);
    expect(suiteOf(passed).suite.tests).toHaveLength(size.tests);
  });
});

// ── (10) 旗 v12.ids の T2 の束：束ごとの記録・予算・呼び出しの数の契約（手 3f・Issue #626）──────────────────

describe("(10) 旗 v12.ids の T2 の束（手 3f・Issue #626）：束ごとの記録・予算・呼び出しの数の契約", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  const t2RecordsOf = (run: Awaited<ReturnType<typeof observe>>): readonly StageRecord[] =>
    run.result.record.stages.filter((record) => record.stage === "test-spec");
  const t2RequestsOf = (requests: readonly string[]): readonly LlmStructuredRequest[] =>
    requests.filter((request) => request.includes(`"schemaName":"${TEST_SPEC_SCHEMA_NAME}"`)).map((request) => JSON.parse(request) as LlmStructuredRequest);
  /** 束の要求 1 本の予約（入力の上限と出力の上限から。共通の口と同じ関数） */
  const reservationOf = (request: LlmStructuredRequest, rates: TokenRates): number =>
    estimateMaxCostUsd({ inputTokens: estimateInputUpperBoundTokens(structuredInputParts(request)), maxOutputTokens: request.maxOutputTokens ?? 0, rates });
  /** 段の記録の項目ごとの合計（束の記録を足す） */
  const sumRecords = (records: readonly StageRecord[]) =>
    records.reduce(
      (sum, record) => ({
        calls: sum.calls + record.calls,
        missing_usage_calls: sum.missing_usage_calls + record.missing_usage_calls,
        input_tokens: sum.input_tokens + record.input_tokens,
        output_tokens: sum.output_tokens + record.output_tokens,
        started: sum.started + record.attempts.started,
        responded: sum.responded + record.attempts.responded,
        errors: sum.errors + record.attempts.errors,
        budget: sum.budget + record.attempts.not_started.budget,
        communication: sum.communication + record.retries.communication,
        shape: sum.shape + record.retries.shape,
        content: sum.content + record.retries.content,
      }),
      { calls: 0, missing_usage_calls: 0, input_tokens: 0, output_tokens: 0, started: 0, responded: 0, errors: 0, budget: 0, communication: 0, shape: 0, content: 0 },
    );

  /** 表を組む段まで流して、境界 T1''／T2 の材料を取る */
  async function resumeOf(materials: SizedMaterials) {
    const head = await runStageRangeV11a({
      ...generationInputOf(materials, createMouth([...materials.tableResponses().map(structured), structured(materials.judgments())], false).client, createCountingJudge(materials.adviceAnswers()).judge, { flags: ALL_ON }),
      range: { start: "name-table", end: "semantic-check" },
    });
    const boundary = head.boundaries[0];
    if (head.stopped !== null || boundary === undefined) throw new Error("前提が壊れた：境界が無い");
    const { boundary: _boundary, ...resume } = boundary;
    return resume;
  }
  /** T2 だけを流す（開始 T2・終了 T2'） */
  async function t2Only(materials: SizedMaterials, recorded: readonly RecordedCall[], options: RunOptions) {
    const resume = await resumeOf(materials);
    const mouth = createMouth(recorded, false);
    const outcome = await runStageRangeV11a({
      ...generationInputOf(materials, mouth.client, createCountingJudge(materials.adviceAnswers()).judge, { ...options, flags: ALL_ON }),
      range: { start: "test-spec", end: "test-spec" },
      resume,
    });
    return { outcome, mouth, records: outcome.stages.filter((record) => record.stage === "test-spec") };
  }

  it("記録：test-spec の記録は束の数だけあり（やり直しは同じ束の記録に数える）、束の計と usage の合計が口で数えた T2 の全体と項目ごとに等しい", async () => {
    for (const size of [MEDIAN_SIZE, MAX_SIZE]) {
      const materials = buildSized(size.requirements, size.tests, ALL_ON);
      const k = t2BundlesOf(materials);
      const clean = await observe(materials, cleanCalls(materials), { flags: ALL_ON });
      const retry = await observe(materials, retryCalls(materials), { flags: ALL_ON });
      const failed = await observe(materials, retryCalls(materials), { flags: ALL_ON, failFirst: true });
      for (const [run, label] of [
        [clean, "初回"],
        [retry, "やり直し"],
        [failed, "再送"],
      ] as const) {
        const records = t2RecordsOf(run);
        expect(records, label).toHaveLength(k);
        expect(records.every((record) => record.status === "ok" && record.failure_kind === null)).toBe(true);
        const sum = sumRecords(records);
        // 口で数えた T2 の全体（偽物の口は応答ごとに同じ usage を返す）
        expect(sum.started, label).toBe(run.startedByMouth["test-spec"]);
        expect(sum.calls, label).toBe(sum.responded);
        expect(sum.input_tokens, label).toBe(sum.calls * USAGE.inputTokens);
        expect(sum.output_tokens, label).toBe(sum.calls * USAGE.outputTokens);
        expect(sum.missing_usage_calls).toBe(0);
        expect(sum.started - sum.communication, label).toBe(run.logical["test-spec"]);
        // 段の集計（記録を段で足したもの）と等しい
        expect({ started: sum.started, responded: sum.responded, errors: sum.errors }).toEqual({
          started: run.stages["test-spec"].started,
          responded: run.stages["test-spec"].responses,
          errors: run.stages["test-spec"].errors,
        });
      }
      // やり直し：束 1（R1 の異常の欠け）だけ中身 1、全部の束が形 1
      expect(t2RecordsOf(retry).map((record) => [record.retries.shape, record.retries.content])).toEqual(
        Array.from({ length: k }, (_, index) => [1, index === 0 ? 1 : 0]),
      );
      // 再送：束ごとに論理要求の数だけ再送（束 1 は 3、ほかは 2）
      expect(t2RecordsOf(failed).map((record) => record.retries.communication)).toEqual(Array.from({ length: k }, (_, index) => (index === 0 ? 3 : 2)));
      expect(sumRecords(t2RecordsOf(failed)).errors).toBe(sumRecords(t2RecordsOf(failed)).communication);
    }
  });

  it("呼び出しの数の契約：要件 15 で T2 初回 3・形 ≤ 3・中身 ≤ 3（束ごとに 3 以下）、要件 25 で初回 5。やり直しを全部使う台本が表どおりで、論理 72・実試行 144・判定 80 以下", async () => {
    for (const size of [MEDIAN_SIZE, MAX_SIZE]) {
      const materials = buildSized(size.requirements, size.tests, ALL_ON);
      const k = t2BundlesOf(materials);
      expect(k).toBe(size.requirements === 15 ? 3 : 5);
      // 全部の束の先頭の要件の異常を欠く応答（どの束も中身で 1 回落ちる）
      const full = materials.t2Response() as { readonly classifications: readonly unknown[]; readonly cases: readonly { readonly requirementId: string; readonly kind: string }[] };
      const heads = new Set(materials.ids.filter((_, index) => index % V12_T2_BUNDLE.size === 0));
      const omitted = { ...full, cases: full.cases.filter((entry) => !(heads.has(entry.requirementId) && entry.kind === "abnormal")) };
      const calls = retryCalls(materials);
      const t2At = calls.findIndex((call) => call.kind === "structured" && (call.output as { classifications?: unknown }).classifications === "x");
      const allRetries = [
        ...calls.slice(0, t2At),
        structured(negative({ classifications: "x", cases: "x" }, "classifications・cases が並びでない応答。束ごとの形のやり直しを使い切る負例")),
        structured(omitted),
        structured(full),
        ...calls.slice(t2At + 3),
      ];
      for (const failFirst of [false, true]) {
        const run = await observe(materials, allRetries, { flags: ALL_ON, failFirst });
        expect(run.result.stopped, JSON.stringify(run.result.stopped)).toBeNull();
        expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
        expect(run.logical["test-spec"]).toBe(3 * k);
        // 中身のやり直しの要求の一覧は、書き直す要件（問題の帰属した束の先頭の要件 1 件）だけで、束の残りの要件は保持した要件の ID の
        // 塊にある（一覧は 1〜5 件。一覧と保持の合計は束の要件の数。Issue #651）
        const t2 = t2RequestsOf(run.requests);
        const retried = t2.filter((request) => request.input.includes(`<data name="${TEST_SPEC_RETRY_DATA_NAMES[1]}">`));
        expect(new Set(retried.map((request) => request.input)).size).toBe(k);
        const firstOf = (head: string) => t2.find((request) => requestListedIds(request)[0] === head);
        for (const request of retried) {
          const listed = requestListedIds(request);
          expect(listed).toHaveLength(1);
          expect(heads.has(listed[0] ?? "")).toBe(true);
          const bundle = requestListedIds(firstOf(listed[0] ?? "") ?? request);
          expect(bundle.length).toBeLessThanOrEqual(V12_T2_BUNDLE.size);
          expect(requestRetainedIds(request)).toEqual(bundle.filter((id) => !listed.includes(id)));
        }
        const records = t2RecordsOf(run);
        expect(records.map((record) => [record.retries.shape, record.retries.content])).toEqual(Array.from({ length: k }, () => [1, 1]));
        for (const record of records) expect(record.attempts.started - record.retries.communication).toBeLessThanOrEqual(3);
        expect(run.totalLogical).toBeLessThanOrEqual(V12_CALL_LIMITS.logicalCalls);
        expect(run.calls?.real_attempts.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.realAttempts);
        expect(run.calls?.judge_branch.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.judgeBranch);
      }
      const clean = await observe(materials, cleanCalls(materials), { flags: ALL_ON });
      expect(clean.logical["test-spec"]).toBe(k);
    }
  });

  it("(9) 束 5 の最大費用の予約が同時に立っても、既定の単価で 1 本の予算（既定 0.30 USD）の中に収まり、全部の束が始まる", async () => {
    const materials = buildSized(MAX_SIZE.requirements, MAX_SIZE.tests, ALL_ON);
    const { outcome, mouth, records } = await t2Only(materials, [structured(materials.t2Response())], { budgetUsd: DEFAULT_BUDGET_USD, rates: DEFAULT_RATES });
    expect(outcome.stopped).toBeNull();
    const requests = t2RequestsOf(mouth.requests);
    expect(requests).toHaveLength(5);
    const reserved = requests.reduce((sum, request) => sum + reservationOf(request, DEFAULT_RATES), 0);
    expect(reserved).toBeLessThanOrEqual(DEFAULT_BUDGET_USD);
    expect(records.map((record) => record.attempts.not_started.budget)).toEqual([0, 0, 0, 0, 0]);
  });

  it("(9)(a) 予算 0 で 2 束を同時に呼ぶと、両束が budget で止まる（束の開始 0・予算での未着手 2・口の呼び出し 0・束の計量の calls 0）。一部の束だけで進まない", async () => {
    const materials = buildSized(7, 21, ALL_ON);
    const { outcome, mouth, records } = await t2Only(materials, [], { budgetUsd: 0 });
    expect(outcome.stopped).toMatchObject({ stage: "test-spec", kind: "budget" });
    expect(mouth.started["test-spec"]).toBe(0);
    expect(records).toHaveLength(2);
    expect(records.map((record) => [record.status, record.failure_kind])).toEqual([
      ["failed", "budget"],
      ["failed", "budget"],
    ]);
    expect(sumRecords(records)).toMatchObject({ started: 0, budget: 2, calls: 0 });
  });

  it("要約の v12_calls：既存の鍵（real_attempts・judge_branch）は今の値のまま、test_spec に束の数・同時数・段全体の計を足す", async () => {
    for (const size of [MEDIAN_SIZE, MAX_SIZE]) {
      const materials = buildSized(size.requirements, size.tests, ALL_ON);
      const k = t2BundlesOf(materials);
      for (const concurrency of [undefined, 1]) {
        const run = await observe(materials, retryCalls(materials), { flags: ALL_ON, ...(concurrency === undefined ? {} : { v12T2Concurrency: concurrency }) });
        const v12Calls = (run.result.summary as unknown as Record<string, unknown>)["v12_calls"] as Record<string, unknown>;
        expect(Object.keys(v12Calls)).toEqual(["real_attempts", "judge_branch", "test_spec"]);
        const judged = run.judge.j4 + run.judge.j2;
        expect(v12Calls["real_attempts"]).toEqual({ limit: V12_CALL_LIMITS.realAttempts, used: run.totalStarted + judged });
        expect(v12Calls["judge_branch"]).toEqual({ limit: V12_CALL_LIMITS.judgeBranch, used: judged });
        const t2 = v12Calls["test_spec"] as { readonly bundles: number; readonly concurrency: number; readonly total: Record<string, unknown> };
        expect([t2.bundles, t2.concurrency]).toEqual([k, concurrency ?? Math.min(V12_T2_BUNDLE.concurrency, k)]);
        // 段全体の計（全体の計量の前後差と、束別の計の合計）は、束の記録の項目ごとの合計と等しい
        expect(t2).toEqual(t2SummaryOf(run, concurrency));
        expect(t2.total).toMatchObject({ calls: 2 * k + 1, attempts: { started: 2 * k + 1, responded: 2 * k + 1 }, retries: { shape: k, content: 1 } });
      }
    }
  });

  it("束の計量は全体の計量の内側に重ねる：usage の欠けた T2 の応答は、束の記録と全体の記録（usage の欠けた呼び出しの数）の両方に数える", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const k = t2BundlesOf(materials);
    const calls = cleanCalls(materials);
    const t2At = materials.tableResponses().length + 1;
    const withoutUsage: RecordedCall[] = calls.map((call, index) => (index === t2At && call.kind === "structured" ? { ...call, usage: undefined } : call));
    const run = await observe(materials, withoutUsage, { flags: ALL_ON });
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(t2RecordsOf(run).map((record) => record.missing_usage_calls)).toEqual(Array.from({ length: k }, () => 1));
    expect(run.result.record.missing_usage_calls).toBe(k);
  });

  it("(d) 成功 2 束の台本で、T2 の束の記録の合計（段全体）の開始と応答はそれぞれ 2、usage は応答 2 回分", async () => {
    const materials = buildSized(7, 21, ALL_ON);
    const { outcome, mouth, records } = await t2Only(materials, [structured(materials.t2Response())], {});
    expect(outcome.stopped).toBeNull();
    expect(records).toHaveLength(2);
    expect(sumRecords(records)).toMatchObject({ started: 2, responded: 2, calls: 2, budget: 0, input_tokens: 2 * USAGE.inputTokens });
    expect(mouth.started["test-spec"]).toBe(2);
  });

  it("(9) 予算を束 1 本分だけにすると、ほかの束が budget で止まり、先に答えた束だけを採用して進まない", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const probe = await t2Only(materials, [structured(materials.t2Response())], {});
    const one = Math.max(...t2RequestsOf(probe.mouth.requests).map((request) => reservationOf(request, RATES)));
    const { outcome, mouth, records } = await t2Only(materials, [structured(materials.t2Response())], { budgetUsd: one * 1.5 });
    expect(outcome.stopped).toMatchObject({ stage: "test-spec", kind: "budget" });
    expect(outcome.boundaries).toEqual([]);
    expect(mouth.started["test-spec"]).toBe(1);
    expect(records.map((record) => record.attempts.not_started.budget)).toEqual([0, 1, 1]);
  });

  it("(8) 同じ台本で同時数 1 の走りと同時の走りの成果物（組・組の SHA・要約の判定）が深く等しい", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const concurrent = await observe(materials, retryCalls(materials), { flags: ALL_ON });
    const serial = await observe(materials, retryCalls(materials), { flags: ALL_ON, v12T2Concurrency: 1 });
    const artifactOf = (run: typeof concurrent, path: string) => run.result.bundle?.artifacts.find((entry) => entry.path === path)?.text;
    expect(artifactOf(serial, "artifacts/test-spec.json")).toBe(artifactOf(concurrent, "artifacts/test-spec.json"));
    expect(serial.result.outcome).toEqual(concurrent.result.outcome);
    expect(serial.logical).toEqual(concurrent.logical);
    expect(t2RecordsOf(serial).map(({ duration_ms: _d, ...rest }) => rest)).toEqual(t2RecordsOf(concurrent).map(({ duration_ms: _d, ...rest }) => rest));
  });

  it("診断：束の形で断った候補に束の添字（0 から）と束の要件の数、書き直した要件の数と保持した要件の数を添える（要件 ID の値は書かない）", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const bad = negative({ classifications: "x", cases: "x" }, "classifications・cases が並びでない応答。束の形の落ちの診断を観測する負例");
    const run = await observe(materials, [...materials.tableResponses().map(structured), structured(materials.judgments()), structured(bad), structured(bad)], { flags: ALL_ON });
    expect(run.result.stopped).toMatchObject({ stage: "test-spec", kind: "malformed" });
    const rejected = JSON.parse(run.result.diagnostics.find((artifact) => artifact.path === DIAGNOSTICS_REJECTED_TEST_SPEC_FILE)?.text ?? "null") as {
      readonly candidates: readonly { readonly stage: string; readonly kind: string; readonly bundle?: unknown }[];
    } | null;
    const rows = rejected?.candidates ?? [];
    const t2 = rows.filter((row) => row.stage === "test-spec");
    expect(t2.length).toBeGreaterThan(0);
    // 束の要件の数は、要求の一覧（コードの試験だけで確かめる要件を除く）を 5 件ごとに切った数
    const requested = ((materials.t2Response().classifications ?? []) as readonly unknown[]).length;
    const sizes = Array.from({ length: t2Bundles(requested) }, (_, index) => Math.min(V12_T2_BUNDLE.size, requested - index * V12_T2_BUNDLE.size));
    for (const row of t2) {
      const bundle = row.bundle as { readonly index: number; readonly requirements: number; readonly rewritten: number; readonly retained: number };
      expect(Object.keys(bundle).sort()).toEqual(["index", "requirements", "retained", "rewritten"]);
      expect(bundle.requirements).toBe(sizes[bundle.index]);
      // 初回の要求は束の要件の全部を書かせる（書き直した要件の数＝束の要件の数・保持 0。Issue #651）
      expect([bundle.rewritten, bundle.retained]).toEqual([bundle.requirements, 0]);
    }
    expect(new Set(t2.map((row) => (row.bundle as { index: number }).index))).toEqual(new Set(sizes.map((_, index) => index)));
    expect(JSON.stringify(t2.map((row) => row.bundle))).not.toMatch(/R\d/);
  });
});
