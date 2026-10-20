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
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer } from "../judge.js";
import type { StageRecord } from "../record.js";
import type { LlmClient, LlmStructuredRequest } from "../llm.js";
import { createFakeLlmClient, type RecordedCall } from "../llm-fake.js";
import { AGENT_LIMITS } from "../limits.js";
import { USAGE, RATES } from "../__tests__/run.js";
import { ARBITRATION_SCHEMA_NAME } from "../stages/arbitrate.js";
import { FIXTURE_CONSTRAINT_ID, FIXTURE_DOCUMENTS, negative, recordedStructured, withCodeIds } from "./__tests__/fixtures.js";
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
  c3BundleCount,
  c3MaxLogical,
  V12_C3_BUNDLE,
  V12_CALL_LIMITS,
  V12_IDS_FRAME_MAP,
  V12_STAGE_FRAMES,
  V12_V11A_FRAME_MAP,
  type V12CallLimits,
  type V12FrameStage,
} from "../v12/limits.js";
import { DECL_CHECK_SCHEMA_NAME } from "./stages/decl-check.js";
import { STEP_ATTEMPTS } from "../stages/prompt.js";
import { NAME_TABLE_SCHEMA_NAME } from "./stages/name-table.js";
import { SEMANTIC_CHECK_SCHEMA_NAME, semanticCheckBundles } from "./stages/semantic-check.js";
import { TEST_SPEC_ROUNDS, TEST_SPEC_SCHEMA_NAME } from "./stages/test-spec.js";
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
 * （失敗した試行は記録の応答を使わない）。再送かどうかは「同じ要求の 1 回目が失敗したまま再送を待っているか」で決める
 * （旗 v12.ids の C3 の束は同時に始まるので、直前の試行では決められない。Issue #662）。
 */
/** 偽物の口の追加の台本（Issue #662。省けば今のまま） */
interface MouthScript {
  /** 渡せば、構造化の要求にこの答え（undefined なら記録から返す）を返す（要求の中身で決める答え） */
  readonly answer?: (request: LlmStructuredRequest) => unknown;
  /** 渡せば、この要求の試行を毎回通信の失敗にする */
  readonly alwaysFail?: (request: LlmStructuredRequest) => boolean;
  /** 渡せば、この段の要求は偽物の時計で `ms` 掛かる（開始の時刻から数え、ほかの要求が始まれるように 1 度タスクを譲る） */
  readonly slow?: { readonly stage: StageKey; readonly ms: number; readonly clock: { t: number } };
  /** 開始と応答の順（段の名前と要求の要件の頭） */
  readonly events?: string[];
}

function createMouth(
  recorded: readonly RecordedCall[],
  failFirst: boolean,
  bySchema?: Readonly<Record<string, readonly RecordedCall[]>>,
  script: MouthScript = {},
) {
  // `bySchema` を渡すと、要求の schema 名ごとの記録から順に返す（段の数が走りで変わる二点測定用。Issue #594）
  const routed = bySchema === undefined ? undefined : new Map(Object.entries(bySchema).map(([name, calls]) => [name, createFakeLlmClient(calls, { validateAgainstSchema: true })] as const));
  const ordered = createFakeLlmClient(recorded, { validateAgainstSchema: true });
  const inner: LlmClient = {
    callStructured: (request) => (routed?.get(request.schemaName) ?? ordered).callStructured(request),
    callWithTools: (request) => ordered.callWithTools(request),
  };
  const logical = zeroCounts();
  const started = zeroCounts();
  const requests: string[] = [];
  // 1 回目が通信の失敗で終わり、再送を待っている要求（要求の直列化で引く）
  const awaitingResend = new Set<string>();
  const enter = (stage: StageKey, key: string): void => {
    started[stage] += 1;
    if (awaitingResend.delete(key)) return;
    logical[stage] += 1;
    if (failFirst) {
      awaitingResend.add(key);
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
      const stage = stageOf(request.schemaName);
      enter(stage, key);
      if (script.alwaysFail?.(request) === true) throw networkError();
      const label = `${stage}:${c3IdsOf(request.input)[0] ?? ""}`;
      script.events?.push(`start:${label}`);
      if (script.slow !== undefined && script.slow.stage === stage) {
        const { clock, ms } = script.slow;
        const start = clock.t;
        await new Promise((resolve) => setTimeout(resolve, 0));
        clock.t = Math.max(clock.t, start + ms);
      } else if (script.events !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      script.events?.push(`end:${label}`);
      const answered = script.answer?.(request);
      if (answered !== undefined) return { output: answered as never, usage: USAGE };
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

/** T1''（C3）の要求の「要件の文と引用」の要件 ID（ほかの段の要求は空） */
function c3IdsOf(input: string): readonly string[] {
  const block = input.split('<data name="要件の文と引用">\n')[1]?.split("\n</data>")[0];
  if (block === undefined) return [];
  return (JSON.parse(block) as readonly { readonly requirementId: string }[]).map((entry) => entry.requirementId);
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
  /** 旗 v12.ids の C3 の束を同時に始める数の上限（省けば既定。Issue #662） */
  readonly v12C3Concurrency?: number;
  /** 予算（省けば 1,000 USD） */
  readonly budgetUsd?: number;
  /** 偽物の口の追加の台本（Issue #662） */
  readonly script?: MouthScript;
  /** 境界の材料を集める（checkpoint の材料を比べる。Issue #662） */
  readonly collectBoundaries?: boolean;
}

/** 材料と記録した応答で流し、観測を返す（時計は 0・締切は通信の再送で timeout を伸ばせる長さ・予算は十分） */
async function observe(materials: SizedMaterials, recorded: readonly RecordedCall[], options: RunOptions = {}) {
  const mouth = createMouth(recorded, options.failFirst ?? false, options.bySchema, options.script);
  const judge = createCountingJudge(materials.adviceAnswers(), options.wrapJudge);
  const result = await runGenerationV11a({
    source: materials.source,
    documents: FIXTURE_DOCUMENTS,
    client: mouth.client,
    judge: judge.judge,
    budgetUsd: options.budgetUsd ?? 1_000,
    rates: RATES,
    now: () => options.script?.slow?.clock.t ?? 0,
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
    ...(options.v12C3Concurrency === undefined ? {} : { v12C3Concurrency: options.v12C3Concurrency }),
    ...(options.collectBoundaries === true ? { collectBoundaries: true } : {}),
    ...(options.limits === undefined ? {} : { limits: { ...AGENT_LIMITS, ...options.limits } }),
    ...(options.flags === undefined ? {} : { flags: options.flags }),
    ...(options.v12CallLimits === undefined ? {} : { v12CallLimits: options.v12CallLimits }),
  });
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
    /** 旗 v12.ids の走りの門と枝（要約の `v12_calls` の門と枝の欄。旗 off の走りは undefined） */
    calls: gateAndBranchOf(result.summary),
    /** 旗 v12.ids の走りの C3 の束の欄（要約の `v12_calls.semantic_check`。C3 を回さない走り・旗 off は undefined。Issue #662） */
    c3Bundles: (result.summary as unknown as { readonly v12_calls?: { readonly semantic_check?: C3BundlesSummary } }).v12_calls?.semantic_check,
  };
}

/** 要約の C3 の束の欄（Issue #662） */
interface C3BundlesSummary {
  readonly bundles: number;
  readonly concurrency: number;
  readonly total: Omit<StageRecord, "stage" | "operation" | "status" | "duration_ms" | "failure_kind" | "references">;
}

/** 要約の `v12_calls` から門と枝の欄だけを取る（C3 の束の欄は `c3Bundles` で別に読む。Issue #662） */
function gateAndBranchOf(summary: unknown): V12CallsSummary | undefined {
  const calls = (summary as { readonly v12_calls?: V12CallsSummary & { readonly semantic_check?: unknown } }).v12_calls;
  if (calls === undefined) return undefined;
  const { semantic_check: _bundles, ...rest } = calls;
  return rest;
}

/** 要約の門と枝の欄（旗 v12.ids の走りだけ。Issue #592） */
interface V12CallsSummary {
  readonly real_attempts: { readonly limit: number; readonly used: number };
  readonly judge_branch: { readonly limit: number; readonly used: number };
}

/** 初回で全段が通る走りの記録（T1〔旗 v12.ids の走りは C1 の 3 束と C2〕・T1''・T2・B1・B3' を 1 回ずつ） */
const cleanCalls = (materials: SizedMaterials): RecordedCall[] => [
  ...materials.tableResponses().map(structured),
  // T1''（旗 v12.ids の走りは C3 の束ごとに 1 つ。Issue #662）
  ...materials.c3Responses().map(structured),
  structured(materials.testSpecResponse()),
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
 * 1 回（束 1・3 は 1 回ずつ。計 4）、C2 は要件の欠落で落ちて形のやり直し 1 回・T1'' の拒否のあとの 2 回目 1 回（計 3）。
 * C3 は要件 6 件ごとの束 B（Issue #662）：初回は R1 を拒否し、最後の束だけ判定が欠けて形の落ち → 段全体で通算 1 の形の
 * やり直しで最後の束だけ通る（B＋1）／C2 の 2 回目のあとの再点検は全束で全部受理（B）。計 2B＋1（やり直しを全部使う）
 */
function idsRetryHead(materials: SizedMaterials): RecordedCall[] {
  const [entities, fields, behaviors, mapping] = materials.tableResponses() as readonly Record<string, readonly Record<string, unknown>[]>[];
  if (entities === undefined || fields === undefined || behaviors === undefined || mapping === undefined) throw new Error("前提が壊れた：C1・C2 の応答が 4 つでない");
  const unknownEntity = { fields: (fields["fields"] ?? []).map((item, index) => (index === 0 ? { ...item, entity: "E9" } : item)) };
  const missingRequirement = { requirements: (mapping["requirements"] ?? []).slice(1) };
  const rejectR1 = materials.c3Responses({ R1: ["unnecessary-ownership", materials.textOf("R1")] });
  const last = rejectR1.at(-1);
  if (last === undefined) throw new Error("前提が壊れた：C3 の束が無い");
  return [
    structured(entities),
    structured(unknownEntity),
    structured(fields),
    structured(behaviors),
    structured(missingRequirement),
    structured(mapping),
    ...rejectR1.slice(0, -1).map(structured),
    structured({ judgments: last.judgments.slice(0, -1) }),
    structured(last),
    structured(mapping),
    ...materials.c3Responses().map(structured),
  ];
}

function retryCalls(materials: SizedMaterials): RecordedCall[] {
  const incomplete = { judgments: materials.judgments().judgments.slice(0, -1) };
  const rejectR1 = materials.judgments({ R1: ["unnecessary-ownership", materials.textOf("R1")] });
  const dispute = { testId: "t5-normal", quote: materials.textOf("R5") };
  // 旗 v12.search-repair の走りは、失敗が全部場所（R1 の検査）に写るので B5 は欄だけの直しになる。版 2 は R1 の検査を
  // 境界だけが落ちる式にして違反の数を厳密に減らし（採る）、版 3 で誤りなし。往復・裁定・B3' の版の数は旗 off と同じ
  const search = materials.flags.searchRepair;
  const repair1 = search ? fieldRepairCall("R1", 1, [dispute]) : repairDone(materials.declaration(["R2"]), [dispute]);
  const repair2 = search ? fieldRepairCall("R1", 0) : repairDone(materials.declaration());
  return [
    ...(materials.flags.ids ? idsRetryHead(materials) : [
      structured(negative({ rows: "x", requirements: "x" }, "rows・requirements が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
      structured(materials.nameTableResponse()),
      structured(incomplete),
      structured(rejectR1),
      structured(materials.nameTableResponse()),
      structured(materials.judgments()),
    ]),
    structured(negative({ classifications: "x", tests: "x" }, "classifications・tests が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
    structured(materials.testSpecResponse({ omitAbnormalOf: "R1" })),
    structured(materials.testSpecResponse()),
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
    expect(ids.testSpecResponse().tests).toHaveLength(off.testSpecResponse().tests.length);
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
/**
 * 旗 v12.ids の初回で通る走り（T1 の代わりに C1 3〔束ごと 1〕・C2 1。Issue #593）。C3 は束ごとに 1（束の数 B は要件の数から
 * 束の定数で計算する。Issue #662）
 */
const cleanIdsTable = (requirements: number): RunTable => ({
  ...CLEAN_TABLE,
  "name-table": row(0),
  vocabulary: row(3),
  mapping: row(1),
  "semantic-check": row(c3BundleCount(requirements)),
});
/**
 * 旗 v12.ids のやり直しを含む走り（C1 4〔束 2 の形 1〕・C2 3〔形 1・T1'' の拒否のあとの 2 回目 1〕。Issue #593）。C3 は初回 B・
 * 形のやり直し 段全体で 1・再点検 B の 2B＋1（Issue #662）
 */
const retryIdsTable = (requirements: number): RunTable => ({
  ...RETRY_TABLE,
  "name-table": row(0),
  vocabulary: row(4),
  mapping: row(3),
  "semantic-check": row(c3MaxLogical(requirements)),
});
/** 再送を全部使う（実開始＝論理要求の 2 倍・再送＝論理要求） */
const doubled = (table: RunTable): RunTable =>
  Object.fromEntries(COUNTED_STAGES.map((stage) => [stage, row(table[stage].logical, table[stage].logical, 2 * table[stage].logical, table[stage].logical)])) as unknown as RunTable;
/** 再送を全部使う初回で通る走り（実開始＝論理要求の 2 倍・再送＝論理要求） */
const CLEAN_FAIL_TABLE: RunTable = doubled(CLEAN_TABLE);
/** 再送を全部使うやり直しを含む走り・旗 v12.ids on（門 144 の内側で完走） */
const retryFailIdsTable = (requirements: number): RunTable => doubled(retryIdsTable(requirements));
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
 * | semantic-check（T1''） | C3（off は段全体。on は要件 6 件ごとの束 B。Issue #662） | 1（on は B） | 3（1＋形 1＋拒否後 1。on は B＋形 1＋再点検 B の 2B＋1） | 2（on は 2B） | 3（6） | 2B＋1（2(2B＋1)） |
 * | test-spec（T2） | C4（段全体＝束 1） | 1 | 3（1＋形 1＋中身 1） | 2 | 3（6） | 3（6） |
 * | write（B1） | （C5。手 6） | 1 | 1 | 2 | 1（2） | 1（2） |
 * | decl-check（B3'） | C6（版ごと 1・形は段全体） | 1 | 4（3 版＋形 1） | 2 | 2（4） | 4（8） |
 * | repair（B5） | ループ（往復ごと） | 0 | 2（往復 2） | 0 | 0（未着手 1） | 2（4） |
 * | arbitration（B5'） | ループ（往復ごと 0〜1） | 0 | 1 | 0 | 0 | 1（2） |
 * | 合計 | | 5（on は 4＋B＋3） | 17（on は 2B＋1 の分だけ増える） | 10 | 12（24・call-limit） | 完走（実開始は論理の 2 倍） |
 *
 * 判定：J4 は T1 のたびに要件ごとに 1 要求（初回で通る N・やり直し 2N）、J2 は 0。全部 on では判定も実試行の門に数える。
 */
const FLAG_SET_TABLE: Readonly<
  Record<FlagSetName, (requirements: number) => { readonly clean: RunTable; readonly retry: RunTable; readonly cleanFail: RunTable; readonly retryFail: RunTable }>
> = {
  "全部 off": () => ({ clean: CLEAN_TABLE, retry: RETRY_TABLE, cleanFail: CLEAN_FAIL_TABLE, retryFail: RETRY_FAIL_GATE24_TABLE }),
  "前の手の旗だけ on（ledger・search-repair。ids off）": () => ({
    clean: CLEAN_TABLE,
    retry: RETRY_TABLE,
    cleanFail: CLEAN_FAIL_TABLE,
    retryFail: RETRY_FAIL_GATE24_TABLE,
  }),
  "全部 on（--pipeline v1.2 と同じ組）": (requirements) => ({
    clean: cleanIdsTable(requirements),
    retry: retryIdsTable(requirements),
    cleanFail: doubled(cleanIdsTable(requirements)),
    retryFail: retryFailIdsTable(requirements),
  }),
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

  it("中央値と最大で段ごとの数が同じ（J4 だけ要件の数に比例）。旗の組の間でも段ごとの論理要求は同じ", async () => {
    const logicalBySet: unknown[] = [];
    for (const set of FLAG_SETS) {
      const median = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, set.flags);
      const max = buildSized(MAX_SIZE.requirements, MAX_SIZE.tests, set.flags);
      for (const make of [cleanCalls, retryCalls]) {
        const medianRun = await observe(median, make(median), { flags: set.flags });
        const maxRun = await observe(max, make(max), { flags: set.flags });
        // 旗 v12.ids の C3 だけは束の数が要件の数で決まる（Issue #662）。それ以外の段は中央値と最大で同じ
        const withoutC3 = <T extends Record<string, unknown>>(value: T) => {
          if (!resolveIds(set.flags)) return value;
          const { "semantic-check": _c3, ...rest } = value;
          return rest;
        };
        expect(withoutC3(maxRun.logical), set.name).toEqual(withoutC3(medianRun.logical));
        expect(withoutC3(maxRun.stages), set.name).toEqual(withoutC3(medianRun.stages));
        expect(maxRun.judge.j2).toBe(medianRun.judge.j2);
        expect(maxRun.judge.j4 / MAX_SIZE.requirements).toBe(medianRun.judge.j4 / MEDIAN_SIZE.requirements);
        logicalBySet.push(medianRun.logical);
      }
    }
    // ids off の 2 組は段ごとに同じ。全部 on（ids）は表を組む段（T1 → C1・C2）と C3 の束（Issue #662）だけが違い、ほかの段は同じ（Issue #593）
    expect(logicalBySet.slice(2, 4)).toEqual(logicalBySet.slice(0, 2));
    const outsideTable = (counts: unknown) => {
      const { "name-table": _t1, vocabulary: _c1, mapping: _c2, "semantic-check": _c3, ...rest } = counts as StageCounts;
      return rest;
    };
    expect(logicalBySet.slice(4).map(outsideTable)).toEqual(logicalBySet.slice(0, 2).map(outsideTable));
    expect(logicalBySet.slice(4).map((counts) => (counts as StageCounts)["name-table"])).toEqual([0, 0]);
  });

  it("段 × 旗の組の表の段は、上限の表の v1.1α の写し（V12_V11A_FRAME_MAP）の段と同じ。§4.1 の列の枠を超えない", () => {
    expect(new Set(V12_V11A_FRAME_MAP.map((entry) => entry.v11a))).toEqual(new Set(STAGES));
    expect(V12_V11A_FRAME_MAP).toHaveLength(STAGES.length);
    const frameOf = (stage: V12FrameStage) => V12_STAGE_FRAMES.find((frame) => frame.stage === stage);
    for (const entry of V12_V11A_FRAME_MAP) {
      const logical = RETRY_TABLE[entry.v11a as StageKey].logical;
      // （ids off の写し。旗 v12.ids の C3 の束は V12_IDS_FRAME_MAP で照らす。Issue #662）
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
    const t2 = materials.testSpecResponse();
    return [
      structured({
        classifications: (t2.classifications as readonly { requirementId: string }[]).filter((entry) => !excluded.includes(entry.requirementId)),
        tests: (t2.tests as readonly { target: { requirementId: string } }[]).filter((test) => !excluded.includes(test.target.requirementId)),
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
    // 形の試行ごとに断った時点で全部積む（Issue #657。今までは最後の 1 件だけ）
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ stage: "mapping", call: 1, attempt: 1 });
    expect(candidates[1]).toMatchObject({ stage: "mapping", call: 1, attempt: 2 });
    for (const candidate of candidates) expect(candidate).not.toHaveProperty("bundle");
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

  it("C3 の拒否のあとの 2 回目の要求は 1 本（全要件・前回の写像・拒否・印）で、C3 の再点検は 1 回（束ごとに 1。Issue #662）。再び拒否なら持ち越し（partial）", async () => {
    const reject = materials.c3Responses({ [LAST]: ["unnecessary-ownership", materials.textOf(LAST)] }).map(structured);
    const run = await observe(materials, [...vocabulary(), structured(mapping), ...reject, structured(mapping), ...reject, ...tailWithout([LAST])], { flags: ALL_ON });
    const requests = mappingRequestsOf(run);
    expect(requests.map(listedIds)).toEqual([materials.ids, materials.ids]);
    for (const name of ["前回の写像", "表の点検の拒否", "助言の印"]) expect(requests[1]).toContain(`<data name=\\"${name}\\">`);
    expect(requests[1]).toContain(LAST);
    expect(run.logical["semantic-check"]).toBe(2 * c3BundleCount(materials.ids.length));
    expect(mappingRecordsOf(run).map((record) => [record.status, record.retries.content])).toEqual([
      ["ok", 0],
      ["ok", 1],
    ]);
    expect(run.result.outcome.verdict).toBe("partial");
    expect(carryOf(run)).toMatchObject({ entries: [{ requirementId: LAST, reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] }] });
  });

  it("C3 が要件 2 件を拒否し、2 回目の応答が C2' に落ちると、形の再試行も C3 の再点検も無く、2 件とも持ち越しに残り full にならない（#623 の性質）", async () => {
    const reject = materials.c3Responses({
      R1: ["unnecessary-ownership", materials.textOf("R1")],
      [LAST]: ["unnecessary-ownership", materials.textOf(LAST)],
    });
    const run = await observe(
      materials,
      [...vocabulary(), structured(mapping), ...reject.map(structured), structured({ requirements: entries().slice(1) }), ...tailWithout(["R1", LAST])],
      { flags: ALL_ON },
    );
    expect(mappingRequestsOf(run)).toHaveLength(2);
    expect(mappingRecordsOf(run).map((record) => [record.status, record.failure_kind])).toEqual([
      ["ok", null],
      ["failed", "unmet"],
    ]);
    expect(run.logical["semantic-check"]).toBe(c3BundleCount(materials.ids.length));
    expect(run.result.stopped).toBeNull();
    expect(run.result.outcome.verdict).toBe("partial");
    const reasons = [{ origin: "semantic-check", reason: "unnecessary-ownership" }];
    expect(carryOf(run)).toEqual(expect.objectContaining({ entries: [{ requirementId: "R1", reasons }, { requirementId: LAST, reasons }] }));
  });

  it("同じ走りで T2 の応答に拒否の 2 件を含め、後続の段を全件受理にしても、full にならず 2 件は持ち越し（出どころ semantic-check）に残る（#623 の再現の単回の形）", async () => {
    const reject = materials.c3Responses({
      R1: ["unnecessary-ownership", materials.textOf("R1")],
      [LAST]: ["unnecessary-ownership", materials.textOf(LAST)],
    });
    const bySchema = (): Readonly<Record<string, readonly RecordedCall[]>> => ({
      ...Object.fromEntries(Object.values(VOCABULARY_SCHEMA_NAMES).map((name, index) => [name, [structured([entities, fields, behaviors][index])]])),
      [MAPPING_SCHEMA_NAME]: [structured(mapping), structured({ requirements: entries().slice(1) })],
      [SEMANTIC_CHECK_SCHEMA_NAME]: [...reject.map(structured), ...materials.c3Responses().map(structured)],
      [TEST_SPEC_SCHEMA_NAME]: [1, 2, 3].map(() => structured(materials.testSpecResponse())),
      [WRITE_V11A_SCHEMA_NAME]: [structured({ declaration: materials.declaration() })],
      [DECL_CHECK_SCHEMA_NAME]: [structured(materials.judgments())],
    });
    const run = await observe(materials, [], { flags: ALL_ON, bySchema: bySchema() });
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
    expect(run.logical["semantic-check"]).toBe(c3BundleCount(materials.ids.length));
    expect(run.result.outcome.verdict).not.toBe("full");
    // 2 件は残る要件に戻らない：T2 の要求の要件の一覧に無い
    const t2Requests = run.requests.filter((request) => request.includes(`"schemaName":"${TEST_SPEC_SCHEMA_NAME}"`));
    expect(t2Requests.length).toBeGreaterThan(0);
    for (const request of t2Requests) {
      const listed = listedIds(request);
      expect(listed).not.toContain("R1");
      expect(listed).not.toContain(LAST);
    }
    // T2 の応答が持ち越しの要件の分類・試験を含むので T2' が断り、段 test-spec・unmet で止まる（終了コード 1・納品物無し）
    expect(run.result.stopped).toMatchObject({ stage: "test-spec", kind: "unmet" });
    expect(run.result.stopped?.problems?.map((problem) => problem.message)).toContain("要件の一覧に無い要件 ID の分類である");
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
  /**
   * 全部 on の初回で通る走りの生成の論理要求（C1 3・C2 1・T1'' B・T2 1・B1 1・B3' 1。手 3a で T1 の 1 が C1・C2 の 4 になった。
   * Issue #593。T1'' は要件 6 件ごとの束 B。Issue #662）
   */
  const cleanGeneration = (requirements: number): number => 7 + c3BundleCount(requirements);
  const CLEAN_GENERATION = cleanGeneration(MEDIAN_SIZE.requirements);
  /** 表を組む段（C1・C2）の要求の数（J4 より前の生成） */
  const TABLE_GENERATION = 4;

  it("(1) 全部 on の初回で通る走り：門の数＝生成の実開始＋判定の実試行、枝の数＝J4 の要件の数。再送を全部使うと門は再送の分だけ増える", async () => {
    for (const size of [MEDIAN_SIZE, MAX_SIZE]) {
      const materials = buildSized(size.requirements, size.tests, ALL_ON);
      const clean = await observe(materials, cleanCalls(materials), { flags: ALL_ON });
      expect(clean.result.outcome).toEqual({ result: "pass", verdict: "full" });
      expect(clean.calls).toEqual({
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
      real_attempts: { limit: 144, used: CLEAN_GENERATION + 2 * MEDIAN_SIZE.requirements },
      judge_branch: { limit: 80, used: 2 * MEDIAN_SIZE.requirements },
    });
  });

  it("(2) 門を要件 15 の初回の合計より 1 小さくすると、生成の call-limit で止まり（B3'・終了コード 1・納品物無し）、判定の呼び出しはそれ以上増えない", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const firstTotal = CLEAN_GENERATION + MEDIAN_SIZE.requirements;
    const run = await observe(materials, cleanCalls(materials), { flags: ALL_ON, v12CallLimits: { realAttempts: firstTotal - 1 } });
    expect(run.result.stopped).toMatchObject({ stage: "decl-check", kind: "call-limit" });
    expect(run.result.summary.stop_reason).toBe("call-limit");
    expect(run.result.outcome.verdict).toBe("none");
    expect(run.result.summary.exit_code).toBe(1);
    expect(run.result.bundle).toBeNull();
    expect(run.stages["decl-check"]).toMatchObject({ started: 0, notStartedLimit: 1 });
    expect(run.judge).toEqual({ j4: MEDIAN_SIZE.requirements, j2: 0 });
    expect(run.calls).toEqual({
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
    const t2 = materials.testSpecResponse();
    const discrepant = {
      ...t2,
      classifications: (t2.classifications as readonly { requirementId: string; nature: string }[]).map((entry) =>
        entry.requirementId === "R1" ? { ...entry, nature: "existence-only" } : entry,
      ),
    };
    const calls = cleanCalls(materials);
    calls[materials.tableResponses().length + materials.c3Responses().length] = structured(discrepant);
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
    ...materials.c3Responses().map(structured),
    structured(negative({ classifications: "x", tests: "x" }, "classifications・tests が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
    structured(materials.testSpecResponse({ omitAbnormalOf: "R4" })),
    structured(materials.testSpecResponse()),
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
      expect(on.testSpecResponse().tests).toHaveLength(size.tests - CODE_WRITTEN_TEST_COUNT);
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
      expect(run.logical["test-spec"]).toBe(3);
      expect(run.stages["test-spec"].retries).toEqual({ communication: 0, shape: 1, content: 1 });
      expect(suiteOf(run).suite.tests).toHaveLength(size.tests);
      expectNoAcceptanceMaterial(run.requests);
    }
    // ids on：作った試験は組の末尾の 4 つ（予約の接頭辞）。ids off の成果物に欄は無い
    const generatedIds = suiteOf(onRun).generated_test_ids ?? [];
    expect(generatedIds).toHaveLength(CODE_WRITTEN_TEST_COUNT);
    expect(suiteOf(onRun).suite.tests.slice(-CODE_WRITTEN_TEST_COUNT).map((test) => test.id)).toEqual(generatedIds);
    expect(generatedIds.every(isGeneratedTestId)).toBe(true);
    expect(suiteOf(offRun)).not.toHaveProperty("generated_test_ids");
    // 論理の枠・門・枝の内側（全部 on）
    expect(onRun.totalLogical).toBeLessThanOrEqual(V12_CALL_LIMITS.logicalCalls);
    expect(onRun.calls?.real_attempts.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.realAttempts);
    expect(onRun.calls?.judge_branch.used ?? Infinity).toBeLessThanOrEqual(V12_CALL_LIMITS.judgeBranch);
  });
});

// ── (8) 旗 v12.ids の C3 の束（Issue #662）──────────────────────────────────────────

describe("(8) 旗 v12.ids の C3 を要件 6 件ごとの束で同時に呼ぶ（Issue #662）", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  /** C3 の要求に、束の要件の判定で答える（`rejects` の要件だけ拒否。`drop` の要件は判定を書かない） */
  const c3Answer =
    (materials: SizedMaterials, rejects: Readonly<Record<string, readonly [string, string]>> = {}, drop: readonly string[] = []) =>
    (request: LlmStructuredRequest): unknown => {
      if (request.schemaName !== SEMANTIC_CHECK_SCHEMA_NAME) return undefined;
      return {
        judgments: c3IdsOf(request.input)
          .filter((id) => !drop.includes(id))
          .map((id) => {
            const found = rejects[id];
            return found === undefined
              ? { requirementId: id, verdict: "accept", kind: null, quote: null }
              : { requirementId: id, verdict: "reject", kind: found[0], quote: found[1] };
          }),
      };
    };
  /** C3 の要求（呼んだ順）の要件 ID */
  const c3RequestsOf = (requests: readonly string[]): readonly (readonly string[])[] =>
    requests
      .map((request) => JSON.parse(request) as LlmStructuredRequest)
      .filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME)
      .map((request) => c3IdsOf(request.input));
  const semanticRecordsOf = (run: Awaited<ReturnType<typeof observe>>) => run.result.record.stages.filter((record) => record.stage === "semantic-check");

  it.each([MEDIAN_SIZE, MAX_SIZE])("束の数で 1 要件の要求が増えない（#627 の教訓）：要件 $requirements の初回で通る走りで、どの要件も C3 の要求のちょうど 1 本に載る", async (size) => {
    const materials = buildSized(size.requirements, size.tests, ALL_ON);
    const run = await observe(materials, cleanCalls(materials), { flags: ALL_ON });
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    const c3 = c3RequestsOf(run.requests);
    expect(c3).toHaveLength(c3BundleCount(size.requirements));
    for (const id of materials.ids) expect(c3.filter((ids) => ids.includes(id)), id).toHaveLength(1);
    for (const ids of c3) expect(ids.length).toBeLessThanOrEqual(V12_C3_BUNDLE.size);
    // やり直しを全部使う走りでも、1 要件の要求は回ごとに 1 本（形のやり直しの束の要件だけ ＋1）
    const retry = await observe(materials, retryCalls(materials), { flags: ALL_ON });
    const retried = c3RequestsOf(retry.requests);
    const lastBundle = materials.c3Bundles.at(-1) ?? [];
    for (const id of materials.ids) expect(retried.filter((ids) => ids.includes(id)), id).toHaveLength(lastBundle.includes(id) ? 3 : 2);
    expectNoAcceptanceMaterial(run.requests);
  });

  it("(6) 偽物の時計で各束に 10 秒掛かるとき、C3 の壁の時間は 1 束分（同時数 1 なら束の数の分）。束の記録はそれぞれ 10 秒", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const bundles = c3BundleCount(MEDIAN_SIZE.requirements);
    const together = await observe(materials, cleanCalls(materials), { flags: ALL_ON, script: { slow: { stage: "semantic-check", ms: 10_000, clock: { t: 0 } } } });
    const serial = await observe(materials, cleanCalls(materials), {
      flags: ALL_ON,
      v12C3Concurrency: 1,
      script: { slow: { stage: "semantic-check", ms: 10_000, clock: { t: 0 } } },
    });
    expect(together.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(together.result.summary.duration_secs).toBe(10);
    expect(serial.result.summary.duration_secs).toBe(10 * bundles);
    for (const run of [together, serial]) expect(semanticRecordsOf(run).map((record) => record.duration_ms)).toEqual(Array.from({ length: bundles }, () => 10_000));
  });

  it("(5)(7) 開始の順：束 3 の開始がどの応答よりも前。同時数 1 の走りと同時の走りで、判定・成果物・checkpoint の材料が深く等しい（開始の順・要約の同時数を除く）", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const rejects = { R2: ["unnecessary-ownership", materials.textOf("R2")] as const, R14: ["missing-target", materials.textOf("R14")] as const };
    const tail = (): RecordedCall[] => [
      structured(materials.tableResponses()[3] ?? {}),
      structured(materials.testSpecResponse()),
      structured({ declaration: materials.declaration() }),
      structured(materials.judgments()),
    ];
    const run = async (concurrency: number | undefined) => {
      const events: string[] = [];
      const observed = await observe(materials, [...materials.tableResponses().map(structured), ...tail()], {
        flags: ALL_ON,
        collectBoundaries: true,
        ...(concurrency === undefined ? {} : { v12C3Concurrency: concurrency }),
        // 初回は R2・R14 を拒否、2 回目（C2 の 2 回目のあと）は全部受理
        script: {
          events,
          answer: (request) => {
            if (request.schemaName !== SEMANTIC_CHECK_SCHEMA_NAME) return undefined;
            const first = events.filter((event) => event.startsWith("start:semantic-check")).length <= c3BundleCount(MEDIAN_SIZE.requirements);
            return c3Answer(materials, first ? rejects : {})(request);
          },
        },
      });
      return { observed, events };
    };
    const together = await run(undefined);
    const serial = await run(1);
    const c3Events = (events: readonly string[]) => events.filter((event) => event.includes("semantic-check"));
    // (5) 同時：束 3（R13 から）の開始が、どの C3 の応答よりも前
    const first = c3Events(together.events).slice(0, 2 * c3BundleCount(MEDIAN_SIZE.requirements));
    expect(first.slice(0, 3)).toEqual(["start:semantic-check:R1", "start:semantic-check:R7", "start:semantic-check:R13"]);
    expect(c3Events(serial.events).slice(0, 4)).toEqual(["start:semantic-check:R1", "end:semantic-check:R1", "start:semantic-check:R7", "end:semantic-check:R7"]);
    // (7) 判定・成果物（要約の同時数の欄を除く）・checkpoint の材料・記録が同じ
    for (const { observed } of [together, serial]) expect(observed.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(serial.observed.result.record).toEqual(together.observed.result.record);
    expect(serial.observed.result.boundaries).toEqual(together.observed.result.boundaries);
    const artifactsOf = (observed: Awaited<ReturnType<typeof observe>>) =>
      (observed.result.bundle?.artifacts ?? []).filter((artifact) => artifact.path !== "artifacts/summary.json");
    expect(artifactsOf(serial.observed)).toEqual(artifactsOf(together.observed));
    expect(serial.observed.c3Bundles?.concurrency).toBe(1);
    expect(together.observed.c3Bundles?.concurrency).toBe(c3BundleCount(MEDIAN_SIZE.requirements));
    const { concurrency: _a, ...restSerial } = serial.observed.c3Bundles ?? { concurrency: 0 };
    const { concurrency: _b, ...restTogether } = together.observed.c3Bundles ?? { concurrency: 0 };
    expect(restSerial).toEqual(restTogether);
    // 2 回目の C3 は初回と同じ表なので同じ対象・同じ束
    expect(c3RequestsOf(together.observed.requests)).toEqual([...materials.c3Bundles, ...materials.c3Bundles]);
  });

  it("(8) 1 束の失敗（通信）で、ほかの束の判定を採用して進まない：段 semantic-check で止まり、束の記録は全部 failed、T2 を呼ばない", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const run = await observe(materials, materials.tableResponses().map(structured), {
      flags: ALL_ON,
      script: { answer: c3Answer(materials), alwaysFail: (request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME && c3IdsOf(request.input)[0] === "R7" },
    });
    expect(run.result.stopped).toMatchObject({ stage: "semantic-check" });
    expect(run.result.summary.exit_code).toBe(1);
    expect(run.result.bundle).toBeNull();
    const records = semanticRecordsOf(run);
    expect(records).toHaveLength(c3BundleCount(MEDIAN_SIZE.requirements));
    expect(records.every((record) => record.status === "failed")).toBe(true);
    expect(run.logical["test-spec"]).toBe(0);
  });

  it("(8') 予算 0 では、表を組む段で予算に止まり C3 を呼ばない（受理で埋めない。今と同じ止まり方）", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const run = await observe(materials, cleanCalls(materials), { flags: ALL_ON, budgetUsd: 0 });
    expect(run.result.stopped).toMatchObject({ kind: "budget" });
    expect(run.logical["semantic-check"]).toBe(0);
    expect(run.result.bundle).toBeNull();
  });

  describe("(9) 再点検（R3）：C2 の 2 回目のあとの C3 は、その回の表から導いた全対象を同じ束の切り方で B 要求", () => {
    const COUNT = 13;
    const materials = buildSized(COUNT, 3 * COUNT, ALL_ON);
    const [, , , mapping] = materials.tableResponses() as readonly Record<string, readonly Record<string, unknown>[]>[];
    if (mapping === undefined) throw new Error("前提が壊れた：C2 の応答が無い");
    const unresolvedOf = (entry: Record<string, unknown>) => ({
      ...entry,
      verification: { kind: "unresolved", value: null, reason: "宣言で書けない", constraintIds: [FIXTURE_CONSTRAINT_ID], checks: null },
    });
    const mappingWith = (unresolved: (id: string) => boolean) => ({
      requirements: (mapping["requirements"] ?? []).map((entry) => (unresolved(entry["requirementId"] as string) ? unresolvedOf(entry) : entry)),
    });
    const runRange = async (second: unknown) => {
      const events: string[] = [];
      const mouth = createMouth([...materials.tableResponses().map(structured), structured(second)], false, undefined, {
        events,
        answer: (request) => {
          if (request.schemaName !== SEMANTIC_CHECK_SCHEMA_NAME) return undefined;
          const first = events.filter((event) => event.startsWith("start:semantic-check")).length <= c3BundleCount(COUNT);
          return c3Answer(materials, first ? { R1: ["unnecessary-ownership", materials.textOf("R1")] } : {})(request);
        },
      });
      const result = await runStageRangeV11a({
        source: materials.source,
        documents: FIXTURE_DOCUMENTS,
        client: mouth.client,
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
      const c3 = c3RequestsOf(mouth.requests);
      return { result, first: c3.slice(0, c3BundleCount(COUNT)), second: c3.slice(c3BundleCount(COUNT)) };
    };

    it("同じ表なら、再点検の対象と束は初回と同じ", async () => {
      const { result, first, second } = await runRange(mapping);
      expect(result.stopped).toBeNull();
      expect(first).toEqual(semanticCheckBundles(materials.ids));
      expect(second).toEqual(first);
    });

    it("1 件が fixed-test から unresolved に変わった表では、その要件を対象から除き、B はその数で決まる（初回の集合を固定しない）", async () => {
      const last = materials.ids.at(-1) as string;
      const { result, first, second } = await runRange(mappingWith((id) => id === last));
      expect(result.stopped).toBeNull();
      expect(first).toHaveLength(c3BundleCount(COUNT));
      const targets = materials.ids.filter((id) => id !== last);
      expect(second).toEqual(semanticCheckBundles(targets));
      expect(second).toHaveLength(c3BundleCount(targets.length));
      expect(second.length).toBeLessThan(first.length);
      expect(result.boundaries[0]?.semanticCheck.targets).toEqual(targets);
    });

    it("全件が unresolved になった表では、再点検は呼び出し 0 で、今までどおり全件持ち越しで止まる", async () => {
      const { result, second } = await runRange(mappingWith(() => true));
      expect(second).toEqual([]);
      expect(result.stopped).toMatchObject({ stage: "carry-over", kind: "unmet" });
      // 呼び出し 0 の回の記録は今までどおり 1 つ（0 件）
      const records = result.stages.filter((record) => record.stage === "semantic-check");
      expect(records).toHaveLength(c3BundleCount(COUNT) + 1);
      expect(records.at(-1)).toMatchObject({ status: "ok", calls: 0 });
    });
  });

  describe("(10) 組合せ全体の呼び出し数の契約試験（やり直しを全部使う台本。数字は限度の表と束の定数から計算する）", () => {
    /** C5（宣言のコンパイル。手 6）の紙上の論理の最大（08 §4.1 の表の C5 の行。この表にはまだ行が無い） */
    const PAPER_C5 = 6;
    /** 組合せ全体の論理の最大（C5 の 6 を含む。T2 は束なし）。T2 を要件 5 件ごとの束（手 3f）で数えると 59／62／69 */
    const EXPECTED_TOTAL: Readonly<Record<number, number>> = { 15: 54, 17: 54, 25: 58 };
    const frameOf = (stage: string) => {
      const found = V12_STAGE_FRAMES.find((entry) => entry.stage === stage);
      if (found === undefined) throw new Error(`前提が壊れた：枠の行 ${stage} が無い`);
      return found;
    };
    const perUnit = (stage: string) => {
      const found = frameOf(stage);
      return (found.initial?.count ?? 0) + (found.shape?.count ?? 0) + (found.content?.count ?? 0);
    };
    /** 走らせて数える段（C1・C2・C3・T2）の論理の最大（限度の表・束の定数・段の定数から） */
    const runMax = (requirements: number) => ({
      vocabulary: V12_IDS_FRAME_MAP.find((entry) => entry.stage === "vocabulary")?.maxLogical ?? NaN,
      mapping: V12_IDS_FRAME_MAP.find((entry) => entry.stage === "mapping")?.maxLogical ?? NaN,
      "semantic-check": c3MaxLogical(requirements),
      // T2（この base では束にしていない＝束 1）：回 2 × 形の試行 2
      "test-spec": TEST_SPEC_ROUNDS * STEP_ATTEMPTS,
    });
    /** 紙の上で数える段（C6・ループ・空の文脈での作り直し）の論理の最大（限度の表の列から） */
    const paperMax = (): number =>
      (frameOf("C6").initial?.count ?? 0) * (frameOf("C6").maxUnits ?? 0) +
      (frameOf("C6").shape?.count ?? 0) +
      ((frameOf("loop").shape?.count ?? 0) + (frameOf("loop").content?.count ?? 0)) * (frameOf("loop").maxUnits ?? 0) +
      perUnit("rewrite");
    /** C1 の 3 束・C2・C3・T2 のやり直しを全部使う台本（T2' を通ったところで止める） */
    const maxCalls = (materials: SizedMaterials): RecordedCall[] => {
      const [entities, fields, behaviors, mapping] = materials.tableResponses() as readonly Record<string, readonly Record<string, unknown>[]>[];
      if (entities === undefined || fields === undefined || behaviors === undefined || mapping === undefined) throw new Error("前提が壊れた");
      const broken = negative({ classifications: "x", tests: "x" }, "classifications・tests が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例");
      return [
        structured(negative({ entities: "x" }, "entities が並びでない応答。形のやり直しの数を観測する負例")),
        structured(entities),
        structured(negative({ fields: "x" }, "fields が並びでない応答。形のやり直しの数を観測する負例")),
        structured(fields),
        structured(negative({ computations: "x", operations: "x", screens: "x" }, "並びでない応答。形のやり直しの数を観測する負例")),
        structured(behaviors),
        structured({ requirements: (mapping["requirements"] ?? []).slice(1) }),
        structured(mapping),
        structured(mapping),
        structured(broken),
        structured(materials.testSpecResponse({ omitAbnormalOf: "R1" })),
        structured(broken),
        structured(materials.testSpecResponse()),
      ];
    };
    /** C3：初回は R1 を拒否し最後の束の判定が欠けて形のやり直し 1、再点検は全部受理（2B＋1） */
    const maxC3 = (materials: SizedMaterials, events: string[]) => (request: LlmStructuredRequest): unknown => {
      if (request.schemaName !== SEMANTIC_CHECK_SCHEMA_NAME) return undefined;
      const seen = events.filter((event) => event.startsWith("start:semantic-check")).length;
      const bundles = materials.c3Bundles.length;
      const ids = c3IdsOf(request.input);
      const isLast = ids[0] === materials.c3Bundles.at(-1)?.[0];
      if (seen <= bundles) {
        return c3Answer(materials, { R1: ["unnecessary-ownership", materials.textOf("R1")] }, isLast ? [ids.at(-1) ?? ""] : [])(request);
      }
      return c3Answer(materials, seen === bundles + 1 ? { R1: ["unnecessary-ownership", materials.textOf("R1")] } : {})(request);
    };
    const runMaxRange = async (materials: SizedMaterials, failFirst: boolean) => {
      const events: string[] = [];
      const mouth = createMouth(maxCalls(materials), failFirst, undefined, { events, answer: maxC3(materials, events) });
      const judge = createCountingJudge(materials.adviceAnswers());
      const result = await runStageRangeV11a({
        source: materials.source,
        documents: FIXTURE_DOCUMENTS,
        client: mouth.client,
        judge: judge.judge,
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
        range: { start: "name-table", end: "test-spec" },
      });
      return { result, mouth, judge: judge.counts };
    };

    it.each([15, 17, 25])("要件 %i：走らせた段の論理要求が計算した最大と一致し、紙の段と C5 を足した合計が 72 以下・実試行 144 以下・判定 80 以下", async (requirements) => {
      const materials = buildSized(requirements, 3 * requirements, ALL_ON);
      const { result, mouth, judge } = await runMaxRange(materials, false);
      expect(result.stopped, JSON.stringify(result.stopped)).toBeNull();
      const expected = runMax(requirements);
      for (const [stage, value] of Object.entries(expected)) expect(mouth.logical[stage as StageKey], stage).toBe(value);
      const observed = Object.values(expected).reduce((sum, value) => sum + value, 0);
      const total = observed + paperMax() + PAPER_C5;
      // 完了条件 (10)（管理の判断で改めた）：今の main（T2 は束なし）で計算した合計は要件 15／17／25 で 54／54／58
      expect(total).toBe(EXPECTED_TOTAL[requirements]);
      expect(total).toBeLessThanOrEqual(V12_CALL_LIMITS.logicalCalls);
      // 実試行：論理 × 通信の試行 2 が門の内側。判定：J4 は要件ごとに 1 × 点検 2 回
      expect(2 * total).toBeLessThanOrEqual(V12_CALL_LIMITS.realAttempts);
      expect(judge.j4).toBe(2 * requirements);
      expect(judge.j4 + judge.j2).toBeLessThanOrEqual(V12_CALL_LIMITS.judgeBranch);
      // 通信の再送を全部使っても、門の数＝生成の開始＋判定の実試行（走らせた段の分）
      const failed = await runMaxRange(materials, true);
      expect(failed.result.stopped).toBeNull();
      const started = failed.result.stages.reduce((sum, record) => sum + record.attempts.started, 0);
      expect(started).toBe(2 * observed);
      expect(failed.result.v12Calls).toEqual({
        real_attempts: { limit: V12_CALL_LIMITS.realAttempts, used: started + failed.judge.j4 + failed.judge.j2 },
        judge_branch: { limit: V12_CALL_LIMITS.judgeBranch, used: failed.judge.j4 + failed.judge.j2 },
      });
    });

    it("C3 の増分（2B＋1 − 直す前の 3）は Issue の見積もり（55→59・58→62・61→69 の差）と一致する。合計そのものはこの base の T2（束 1）で数える", () => {
      // Issue #662 の見積もりの差（直す前の C3 は段全体で 3）。合計 59／62／69 は T2 を要件 5 件ごとの束（手 3f。この base に無い）で
      // 数えた値なので、ここでは差だけを照らし、合計はこの base の限度の表から計算した値を上で照らす
      const issueDelta: Readonly<Record<number, number>> = { 15: 59 - 55, 17: 62 - 58, 25: 69 - 61 };
      for (const [requirements, delta] of Object.entries(issueDelta)) expect(c3MaxLogical(Number(requirements)) - 3, requirements).toBe(delta);
    });
  });

  it("(11) 門が C3 の束の途中で尽きると、残りの束は未着手（limit）で、生成は call-limit で止まり、一部の束だけで進まない", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    // 表を組む段（C1・C2）の 4 試行と J4 の要件の数のあと、C3 の束を 1 つだけ通す門
    const gate = 4 + MEDIAN_SIZE.requirements + 1;
    const run = await observe(materials, cleanCalls(materials), { flags: ALL_ON, v12CallLimits: { realAttempts: gate } });
    expect(run.result.stopped).toMatchObject({ stage: "semantic-check", kind: "call-limit" });
    expect(run.result.summary.exit_code).toBe(1);
    const records = semanticRecordsOf(run);
    expect(records).toHaveLength(c3BundleCount(MEDIAN_SIZE.requirements));
    expect(records.every((record) => record.status === "failed" && record.failure_kind === "call-limit")).toBe(true);
    expect(run.stages["semantic-check"]).toMatchObject({ started: 1, notStartedLimit: c3BundleCount(MEDIAN_SIZE.requirements) - 1 });
    expect(run.calls?.real_attempts.used).toBe(gate);
    expect(run.logical["test-spec"]).toBe(0);
  });

  it.each([MEDIAN_SIZE, MAX_SIZE])("(12) 要件 $requirements：C3 の記録は回ごとに束の数だけあり、束の計の合計が要約の段全体の計と項目ごとに等しい。共有の門の増分の式が成り立つ", async (size) => {
    const materials = buildSized(size.requirements, size.tests, ALL_ON);
    const bundles = c3BundleCount(size.requirements);
    for (const [make, rounds] of [[cleanCalls, 1], [retryCalls, 2]] as const) {
      for (const failFirst of [false, true]) {
        const run = await observe(materials, make(materials), { flags: ALL_ON, failFirst });
        expect(run.result.outcome.result).toBe("pass");
        const records = semanticRecordsOf(run);
        expect(records).toHaveLength(rounds * bundles);
        const summary = run.c3Bundles;
        if (summary === undefined) throw new Error("前提が壊れた：要約に C3 の束の欄が無い");
        expect(summary.bundles).toBe(rounds * bundles);
        expect(summary.concurrency).toBe(Math.min(V12_C3_BUNDLE.concurrency, bundles));
        const sum = (pick: (record: StageRecord) => number) => records.reduce((total, record) => total + pick(record), 0);
        expect(summary.total).toEqual({
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
        });
        // 段全体の usage は全体の計量のうち C3 の分（偽物の usage は 1 応答ごとに同じ）
        expect(summary.total.calls).toBe(run.stages["semantic-check"].responses);
        // 共有の門の増分＝Σ束（と段）の開始＋予算と timeout の未着手＋判定の枝の増分
        const all = run.result.record.stages;
        const gateUsed = all.reduce((total, record) => total + record.attempts.started + record.attempts.not_started.budget + record.attempts.not_started.timeout, 0);
        expect(run.calls?.real_attempts.used).toBe(gateUsed + (run.calls?.judge_branch.used ?? 0));
      }
    }
  });
});
