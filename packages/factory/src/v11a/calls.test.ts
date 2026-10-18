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
// 外部の API は呼ばない。題材は抽象的なもので、受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { createFakeJudge } from "../judge-fake.js";
import type { Judge, JudgeAnswer } from "../judge.js";
import type { StageRecord } from "../record.js";
import type { LlmClient } from "../llm.js";
import { createFakeLlmClient, type RecordedCall } from "../llm-fake.js";
import { AGENT_LIMITS } from "../limits.js";
import { USAGE, RATES } from "../__tests__/run.js";
import { ARBITRATION_SCHEMA_NAME } from "../stages/arbitrate.js";
import { FIXTURE_DOCUMENTS, negative, recordedStructured } from "./__tests__/fixtures.js";
import { buildSized, MAX_SIZE, MEDIAN_SIZE, type SizedMaterials } from "./__tests__/sizes.js";
import { runGenerationV11a } from "./run.js";
import { DECL_CHECK_SCHEMA_NAME } from "./stages/decl-check.js";
import { NAME_TABLE_SCHEMA_NAME } from "./stages/name-table.js";
import { SEMANTIC_CHECK_SCHEMA_NAME } from "./stages/semantic-check.js";
import { TEST_SPEC_SCHEMA_NAME } from "./stages/test-spec.js";
import { WRITE_V11A_SCHEMA_NAME } from "./stages/write.js";

// ── 偽物の口と観測 ─────────────────────────────────────────────────

/** 数える段（段の記録の `stage` と同じ名前） */
const STAGES = ["name-table", "semantic-check", "test-spec", "write", "decl-check", "repair", "arbitration"] as const;
type StageKey = (typeof STAGES)[number];

const STAGE_BY_SCHEMA: Readonly<Record<string, StageKey>> = {
  [NAME_TABLE_SCHEMA_NAME]: "name-table",
  [SEMANTIC_CHECK_SCHEMA_NAME]: "semantic-check",
  [TEST_SPEC_SCHEMA_NAME]: "test-spec",
  [WRITE_V11A_SCHEMA_NAME]: "write",
  [DECL_CHECK_SCHEMA_NAME]: "decl-check",
  [ARBITRATION_SCHEMA_NAME]: "arbitration",
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
});

/** 通信の失敗（共通の口が `network` と分類し、長くした timeout でやり直す） */
const networkError = (): Error => Object.assign(new Error("fetch が失敗しました"), { kind: "network" });

/**
 * 偽物の口。記録した応答を順に返す偽物の LlmClient を包み、要求の中身から段を引いて数える。
 * `failFirst` が真なら、**各論理要求の 1 回目の試行を通信の失敗にし、2 回目（再送）を成功にする**
 * （失敗した試行は記録の応答を使わない）。再送かどうかは「直前の試行が失敗したか」で決める。
 */
function createMouth(recorded: readonly RecordedCall[], failFirst: boolean) {
  const inner = createFakeLlmClient(recorded, { validateAgainstSchema: true });
  const logical = zeroCounts();
  const started = zeroCounts();
  let retrying = false;
  const enter = (stage: StageKey): void => {
    started[stage] += 1;
    if (!retrying) logical[stage] += 1;
    if (failFirst && !retrying) {
      retrying = true;
      throw networkError();
    }
    retrying = false;
  };
  const stageOf = (schemaName: string): StageKey => {
    const stage = STAGE_BY_SCHEMA[schemaName];
    if (stage === undefined) throw new Error(`前提が壊れた：数えていない schema ${schemaName}`);
    return stage;
  };
  const client: LlmClient = {
    async callStructured(request) {
      enter(stageOf(request.schemaName));
      return inner.callStructured(request);
    },
    async callWithTools(request) {
      enter("repair");
      return inner.callWithTools(request);
    },
  };
  return { client, logical, started };
}

/** 偽物の判定を包み、受けた要求の数を J4（所属の組の問い）と J2（それ以外）に分けて数える */
function createCountingJudge(answers: Readonly<Record<string, JudgeAnswer>>) {
  const inner = createFakeJudge(answers);
  const counts = { j4: 0, j2: 0 };
  const judge: Judge = {
    source: "fake",
    async judge(request) {
      const names = Object.keys(request.questions);
      if (names.every((name) => name.startsWith("need:"))) counts.j4 += 1;
      else counts.j2 += 1;
      return inner.judge(request);
    },
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
  /** 上限の一部の上書き（`AGENT_LIMITS` に重ねる） */
  readonly limits?: Readonly<Partial<Record<keyof typeof AGENT_LIMITS, number>>>;
}

/** 材料と記録した応答で流し、観測を返す（時計は 0・締切は通信の再送で timeout を伸ばせる長さ・予算は十分） */
async function observe(materials: SizedMaterials, recorded: readonly RecordedCall[], options: RunOptions = {}) {
  const mouth = createMouth(recorded, options.failFirst ?? false);
  const judge = createCountingJudge(materials.adviceAnswers());
  const result = await runGenerationV11a({
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
    ...(options.limits === undefined ? {} : { limits: { ...AGENT_LIMITS, ...options.limits } }),
  });
  const stages = Object.fromEntries(STAGES.map((stage) => [stage, totalsOf(result.record.stages, stage)])) as Record<StageKey, StageTotals>;
  const sumOf = (pick: (totals: StageTotals) => number): number => STAGES.reduce((total, stage) => total + pick(stages[stage]), 0);
  return {
    result,
    logical: mouth.logical,
    startedByMouth: mouth.started,
    stages,
    judge: judge.counts,
    totalLogical: STAGES.reduce((total, stage) => total + mouth.logical[stage], 0),
    totalStarted: sumOf((totals) => totals.started),
    totalResponses: sumOf((totals) => totals.responses),
    totalCommunicationRetries: sumOf((totals) => totals.retries.communication),
    totalErrors: sumOf((totals) => totals.errors),
  };
}

/** 初回で全段が通る走りの記録（T1・T1''・T2・B1・B3' を 1 回ずつ） */
const cleanCalls = (materials: SizedMaterials): RecordedCall[] => [
  structured(materials.nameTableResponse()),
  structured(materials.judgments()),
  structured(materials.testSpecResponse()),
  structured({ declaration: materials.declaration() }),
  structured(materials.judgments()),
];

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
function retryCalls(materials: SizedMaterials): RecordedCall[] {
  const incomplete = { judgments: materials.judgments().judgments.slice(0, -1) };
  const rejectR1 = materials.judgments({ R1: ["unnecessary-ownership", materials.textOf("R1")] });
  const dispute = { testId: "t5-normal", quote: materials.textOf("R5") };
  return [
    structured(negative({ rows: "x", requirements: "x" }, "rows・requirements が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
    structured(materials.nameTableResponse()),
    structured(incomplete),
    structured(rejectR1),
    structured(materials.nameTableResponse()),
    structured(materials.judgments()),
    structured(negative({ classifications: "x", tests: "x" }, "classifications・tests が並びでない応答。strict の schema では出ないが、形のやり直しの数を観測する負例")),
    structured(materials.testSpecResponse({ omitAbnormalOf: "R1" })),
    structured(materials.testSpecResponse()),
    structured({ declaration: materials.declaration(["R1"]) }),
    structured(incomplete),
    structured(materials.judgments()),
    repairDone(materials.declaration(["R2"]), [dispute]),
    structured({ decisions: [{ testId: dispute.testId, verdict: "uphold", reason: "", quote: "" }] }),
    structured(materials.judgments()),
    repairDone(materials.declaration()),
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
      "name-table": 3,
      "semantic-check": 3,
      "test-spec": 3,
      write: 1,
      "decl-check": 4,
      repair: 2,
      arbitration: 1,
    };
    const expectedRetries: Record<StageKey, { communication: number; shape: number; content: number }> = {
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
