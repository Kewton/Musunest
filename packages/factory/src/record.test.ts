// 記録（record.ts）の unit テスト（02 §3.5・§4・S-5・S-7・S-8）。
//
// ここで固定したいのは 4 つ。
//   1. 記録・段の記録・要約が、**列挙した欄だけ**を持つこと（余分な欄を渡しても落ちること）
//   2. 要約が appspec-schema の wire の型（`headless-summary/v1`）に合うこと
//   3. 版・裁定の数・予約の残り・usage が欠けた呼び出しの数・失敗の帰属が要約に入ること
//   4. 偽の API キー・依頼文の全文・応答の全文・生の HTTP の誤りの本文が、要約にも記録にも**出ない**こと
import { HEADLESS_REQUIRED_KEYS, HEADLESS_SCHEMA_VERSION, acceptsHeadlessSummaryWire } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import type { LlmClient } from "./llm.js";
import { OpenAiIncompleteError, type OpenAiUsage } from "./openai.js";
import {
  ATTEMPT_KEYS,
  FAILURE_KINDS,
  NOT_STARTED_KEYS,
  RETRY_KEYS,
  RUN_RECORD_KEYS,
  STAGE_IDS,
  STAGE_OPERATIONS,
  STAGE_RECORD_KEYS,
  SUMMARY_KEYS,
  UsageMeter,
  buildRunRecord,
  buildSummary,
  makeStageRecord,
  usageDelta,
  type RunRecord,
  type StageRecord,
  REFERENCE_COUNT_KEYS,
  REFERENCE_COUNT_STAGES,
  type StageReferenceCounts,
  CallRequestLog,
} from "./record.js";
import type { CallCounts } from "./call.js";
import type { LlmUsage } from "./llm.js";

const USAGE: OpenAiUsage = {
  inputTokens: 10,
  cachedInputTokens: 2,
  cacheWriteTokens: 3,
  outputTokens: 4,
  reasoningTokens: 1,
};

/** 段の前後で取った差の計（試行の終端と再試行。Issue #446） */
const COUNTS: CallCounts = {
  attempts: {
    started: 2,
    responded: 1,
    errors: 1,
    cancelled_deadline: 0,
    cancelled_timeout: 0,
    not_started: { deadline: 0, budget: 0, limit: 0, timeout: 0 },
  },
  retries: { communication: 1, shape: 1, content: 0 },
};

const stage = () =>
  makeStageRecord(
    "write",
    "ok",
    12,
    {
      calls: 1,
      missing_usage_calls: 0,
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_tokens: 3,
      output_tokens: 4,
      reasoning_tokens: 1,
    },
    COUNTS,
    null,
  );

const record = (): RunRecord => ({
  builder: "musunest-factory",
  model: "gpt-test",
  effort: "high",
  prompt_version: "v1",
  contract_version: "v0.2",
  spec_engine_version: "0.0.0",
  factory_version: "0.0.0",
  stages: [stage()],
  arbitration: { upheld: 1, overturned: 2, undecidable: 3 },
  budget_remaining_usd: 0.05,
  budget_reserved_usd: 0.02,
  missing_usage_calls: 1,
  failure: { stage: "repair", kind: "unmet" },
});

const summary = () =>
  buildSummary(record(), {
    run_id: "run-1",
    verdict: "partial",
    assurance: "partial",
    duration_secs: 1.5,
    provider_cost_usd: 0.02,
    stop_class: "completed",
    exit_code: 1,
  });

// ── 1. 列挙した欄だけを持つ ──────────────────────────────────────

describe("記録の欄は列挙した欄だけである（02 §3.5）", () => {
  it("段の記録の欄", () => {
    expect(Object.keys(stage()).sort()).toEqual([...STAGE_RECORD_KEYS].sort());
  });

  it("記録の欄", () => {
    expect(Object.keys(buildRunRecord(record())).sort()).toEqual([...RUN_RECORD_KEYS].sort());
  });

  it("要約の欄（wire の必須の欄＋記録の欄）", () => {
    expect(Object.keys(summary()).sort()).toEqual([...SUMMARY_KEYS].sort());
    expect(new Set(SUMMARY_KEYS).size).toBe(SUMMARY_KEYS.length);
  });

  it("余分な欄を渡しても、列挙した欄の外は写さない", () => {
    const raw = {
      ...record(),
      api_key: "sk-FAKE-KEY",
      request_text: "依頼文の全文",
      response_text: "LLM の応答の全文",
      http_body: "生の HTTP の誤りの本文",
      stages: [{ ...stage(), extra: "余分" }],
    } as unknown as RunRecord;
    const picked = buildRunRecord(raw);
    expect(Object.keys(picked).sort()).toEqual([...RUN_RECORD_KEYS].sort());
    expect(Object.keys(picked.stages[0] ?? {}).sort()).toEqual([...STAGE_RECORD_KEYS].sort());
  });
});

// ── 1b. 段の記録の operation（Issue #410）────────────────────────

describe("段の記録の operation（Issue #410）", () => {
  const snapshot = {
    calls: 1,
    missing_usage_calls: 0,
    input_tokens: 10,
    cached_input_tokens: 2,
    cache_write_tokens: 3,
    output_tokens: 4,
    reasoning_tokens: 1,
  };

  it("欄の一覧に operation がある", () => {
    expect(STAGE_RECORD_KEYS).toContain("operation");
  });

  it("makeStageRecord は、省けば null、redo-design を渡せばその値を写す", () => {
    expect(makeStageRecord("design", "ok", 12, snapshot, COUNTS, null).operation).toBeNull();
    expect(makeStageRecord("design", "ok", 12, snapshot, COUNTS, null, "redo-design").operation).toBe("redo-design");
  });

  it("上限のある値の並びの外（有限でない値）は写さず null にする", () => {
    expect(makeStageRecord("design", "ok", 12, snapshot, COUNTS, null, "model-output" as never).operation).toBeNull();
    expect(makeStageRecord("design", "ok", 12, snapshot, COUNTS, null, 42 as never).operation).toBeNull();
  });

  it("buildRunRecord で組み直しても値が残り、余分な欄は残らない", () => {
    const redone = { ...makeStageRecord("design", "ok", 12, snapshot, COUNTS, null, "redo-design"), extra: "余分" };
    const picked = buildRunRecord({ ...record(), stages: [redone as unknown as StageRecord] });
    expect(picked.stages[0]?.operation).toBe("redo-design");
    expect(Object.keys(picked.stages[0] ?? {}).sort()).toEqual([...STAGE_RECORD_KEYS].sort());
    expect((picked.stages[0] as unknown as Record<string, unknown>)["extra"]).toBeUndefined();
  });

  it("buildSummary の要約の同じ段にも値が残り、余分な欄は残らず、wire に受け付けられる", () => {
    const redone = { ...makeStageRecord("design", "ok", 12, snapshot, COUNTS, null, "redo-design"), extra: "余分" };
    const built = buildSummary(
      { ...record(), stages: [redone as unknown as StageRecord] },
      {
        run_id: "run-1",
        verdict: "partial",
        assurance: "partial",
        duration_secs: 1.5,
        provider_cost_usd: 0.02,
        stop_class: "completed",
        exit_code: 1,
      },
    );
    expect(built.stages[0]?.operation).toBe("redo-design");
    expect(Object.keys(built.stages[0] ?? {}).sort()).toEqual([...STAGE_RECORD_KEYS].sort());
    expect((built.stages[0] as unknown as Record<string, unknown>)["extra"]).toBeUndefined();
    expect(acceptsHeadlessSummaryWire(built)).toBe(true);
  });
});

// ── 1c. 試行の終端と再試行、未精算の予約額の欄（Issue #446）──────────

describe("段の記録に attempts・retries、記録に budget_reserved_usd がある（Issue #446）", () => {
  it("欄の一覧に attempts・retries・budget_reserved_usd がある", () => {
    expect(STAGE_RECORD_KEYS).toContain("attempts");
    expect(STAGE_RECORD_KEYS).toContain("retries");
    expect(RUN_RECORD_KEYS).toContain("budget_reserved_usd");
  });

  it("attempts の下位の欄は、試行の終端と未着手の 4 種だけである", () => {
    expect(ATTEMPT_KEYS).toEqual([
      "started",
      "responded",
      "errors",
      "cancelled_deadline",
      "cancelled_timeout",
      "not_started",
    ]);
    expect(NOT_STARTED_KEYS).toEqual(["deadline", "budget", "limit", "timeout"]);
    expect(RETRY_KEYS).toEqual(["communication", "shape", "content"]);
  });

  it("makeStageRecord は、渡した計の下位の欄だけを写す（余分な下位の欄は残さない）", () => {
    const rawCounts = {
      attempts: {
        ...COUNTS.attempts,
        extra: "余分",
        not_started: { ...COUNTS.attempts.not_started, extra: "余分" },
      },
      retries: { ...COUNTS.retries, extra: "余分" },
    } as unknown as CallCounts;
    const usage = {
      calls: 1,
      missing_usage_calls: 0,
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_tokens: 3,
      output_tokens: 4,
      reasoning_tokens: 1,
    };
    const built = makeStageRecord("write", "ok", 12, usage, rawCounts, null);
    expect(Object.keys(built.attempts).sort()).toEqual([...ATTEMPT_KEYS].sort());
    expect(Object.keys(built.attempts.not_started).sort()).toEqual([...NOT_STARTED_KEYS].sort());
    expect(Object.keys(built.retries).sort()).toEqual([...RETRY_KEYS].sort());
    expect((built.attempts as unknown as Record<string, unknown>)["extra"]).toBeUndefined();
    expect((built.attempts.not_started as unknown as Record<string, unknown>)["extra"]).toBeUndefined();
    expect((built.retries as unknown as Record<string, unknown>)["extra"]).toBeUndefined();
  });

  it("試行の終端と再試行、未精算の予約額が、記録と要約に写る", () => {
    const picked = buildRunRecord(record());
    expect(picked.stages[0]?.attempts).toEqual(COUNTS.attempts);
    expect(picked.stages[0]?.retries).toEqual(COUNTS.retries);
    expect(picked.budget_reserved_usd).toBe(0.02);
    const built = summary();
    expect(built.stages[0]?.attempts).toEqual(COUNTS.attempts);
    expect(built.stages[0]?.retries).toEqual(COUNTS.retries);
    expect(built.budget_reserved_usd).toBe(0.02);
  });

  it("予約額を省いた記録でも、要約の欄は 0 で埋まる", () => {
    const { budget_reserved_usd: _omit, ...withoutReserved } = record();
    const built = buildSummary(withoutReserved as RunRecord, {
      run_id: "run-1",
      verdict: "none",
      assurance: "none",
      duration_secs: 0,
      provider_cost_usd: 0,
      stop_class: "completed",
      exit_code: 1,
    });
    expect(built.budget_reserved_usd).toBe(0);
  });
});

// ── 2. 要約は appspec-schema の wire に合う ──────────────────────

describe("要約は appspec-schema の wire に合う（02 §4・Issue #283）", () => {
  it("wire として受け付けられる", () => {
    expect(acceptsHeadlessSummaryWire(summary())).toBe(true);
  });

  it("版と必須の欄を持つ", () => {
    const built = summary();
    expect(built.schema_version).toBe(HEADLESS_SCHEMA_VERSION);
    for (const key of HEADLESS_REQUIRED_KEYS) expect(key in built, key).toBe(true);
  });
});

// ── 3. 要約に入る欄 ──────────────────────────────────────────────

describe("版・裁定の数・予約の残り・usage が欠けた呼び出し・失敗の帰属が要約に入る（02 §4・S-5・S-7）", () => {
  it("それぞれの値が写る", () => {
    const built = summary();
    expect(built.spec_engine_version).toBe("0.0.0");
    expect(built.factory_version).toBe("0.0.0");
    expect(built.prompt_version).toBe("v1");
    expect(built.contract_version).toBe("v0.2");
    expect(built.model).toBe("gpt-test");
    expect(built.effort).toBe("high");
    expect(built.builder).toBe("musunest-factory");
    expect(built.arbitration).toEqual({ upheld: 1, overturned: 2, undecidable: 3 });
    expect(built.budget_remaining_usd).toBe(0.05);
    expect(built.budget_reserved_usd).toBe(0.02);
    expect(built.missing_usage_calls).toBe(1);
    expect(built.failure).toEqual({ stage: "repair", kind: "unmet" });
    expect(built.stages).toHaveLength(1);
    // キャッシュの書き込みと読み取りを、段ごとに分けて出す（#302）
    expect(built.stages[0]?.cache_write_tokens).toBe(3);
    expect(built.stages[0]?.cached_input_tokens).toBe(2);
    expect(built.verdict).toBe("partial");
  });
});

// ── 4. 禁じた内容は入らない ──────────────────────────────────────

describe("禁じた内容は、要約にも記録にも出ない（02 §3.5・S-8）", () => {
  const forbidden = [
    "sk-FAKE-KEY",
    "依頼文の全文",
    "LLM の応答の全文",
    "生の HTTP の誤りの本文",
  ];

  it("余分な欄として渡しても、記録にも要約にも出ない", () => {
    const raw = {
      ...record(),
      api_key: "sk-FAKE-KEY",
      request_text: "依頼文の全文",
      response_text: "LLM の応答の全文",
      http_body: "生の HTTP の誤りの本文",
    } as unknown as RunRecord;
    const picked = buildRunRecord(raw);
    const built = buildSummary(picked, {
      run_id: "run-1",
      verdict: "none",
      assurance: "none",
      duration_secs: 0,
      provider_cost_usd: 0,
      stop_class: "malformed",
      exit_code: 1,
    });
    const texts = [JSON.stringify(picked), JSON.stringify(built)];
    for (const needle of forbidden) {
      for (const text of texts) expect(text.includes(needle), needle).toBe(false);
    }
  });
});

// ── 使用トークンの計（呼び出しの数と、usage が欠けた呼び出し） ────

describe("使用トークンの計（02 §1.5）", () => {
  it("usage がある呼び出しと、無い呼び出しの両方を数える", async () => {
    const client: LlmClient = {
      callStructured: async <T>() => ({ output: {} as T, usage: USAGE }),
      callWithTools: async () => ({ kind: "done", declaration: {}, usage: undefined }),
    };
    const meter = new UsageMeter();
    const wrapped = meter.wrap(client);
    await wrapped.callStructured({} as never);
    await wrapped.callWithTools({} as never);

    expect(meter.snapshot).toEqual({
      calls: 2,
      missing_usage_calls: 1,
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_tokens: 3,
      output_tokens: 4,
      reasoning_tokens: 1,
    });
  });

  it("2 つの時点の差を取れる", () => {
    const before = {
      calls: 1,
      missing_usage_calls: 0,
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_tokens: 1,
      output_tokens: 4,
      reasoning_tokens: 1,
    };
    const after = {
      calls: 3,
      missing_usage_calls: 1,
      input_tokens: 30,
      cached_input_tokens: 4,
      cache_write_tokens: 5,
      output_tokens: 14,
      reasoning_tokens: 3,
    };
    expect(usageDelta(before, after)).toEqual({
      calls: 2,
      missing_usage_calls: 1,
      input_tokens: 20,
      cached_input_tokens: 2,
      cache_write_tokens: 4,
      output_tokens: 10,
      reasoning_tokens: 2,
    });
  });

  it("未完了の応答の usage も数える（拒否は usage が無いので欠けた呼び出しとして数える）", async () => {
    const incomplete: LlmClient = {
      callStructured: async () => {
        throw new OpenAiIncompleteError("max_output_tokens", USAGE, "未完了");
      },
      callWithTools: async () => ({ kind: "done", declaration: {}, usage: undefined }),
    };
    const meter = new UsageMeter();
    const wrapped = meter.wrap(incomplete);
    await expect(wrapped.callStructured({} as never)).rejects.toBeInstanceOf(OpenAiIncompleteError);
    expect(meter.snapshot).toEqual({
      calls: 1,
      missing_usage_calls: 0,
      input_tokens: 10,
      cached_input_tokens: 2,
      cache_write_tokens: 3,
      output_tokens: 4,
      reasoning_tokens: 1,
    });
  });

  it("usage の無い応答は、欠けた呼び出しとして数える", async () => {
    const missing: LlmClient = {
      callStructured: async () => {
        throw new OpenAiIncompleteError("max_output_tokens", undefined, "未完了");
      },
      callWithTools: async () => ({ kind: "done", declaration: {}, usage: undefined }),
    };
    const meter = new UsageMeter();
    const wrapped = meter.wrap(missing);
    await expect(wrapped.callStructured({} as never)).rejects.toBeInstanceOf(OpenAiIncompleteError);
    expect(meter.snapshot.calls).toBe(1);
    expect(meter.snapshot.missing_usage_calls).toBe(1);
  });
});

// ── 呼び出しの数の上限の失敗に、上限の名前と数を写す（Issue #665）──

describe("失敗の帰属の上限（limit）は、あるときだけ名前・上限値・実際の値を写す（Issue #665）", () => {
  const withLimit = (extra: Record<string, unknown> = {}): RunRecord => ({
    ...record(),
    failure: {
      stage: "repair",
      kind: "call-limit",
      limit: { name: "repairStepTurns", max: 8, actual: 9, ...extra },
    } as RunRecord["failure"],
  });

  it("記録と要約の失敗の欄に、上限の名前・上限値・実際の値が出る（余分な欄は落ちる）", () => {
    const picked = buildRunRecord(withLimit({ conversation: "会話の本文" }));
    expect(picked.failure).toEqual({ stage: "repair", kind: "call-limit", limit: { name: "repairStepTurns", max: 8, actual: 9 } });
    const built = buildSummary(picked, {
      run_id: "run-1",
      verdict: "none",
      assurance: "none",
      duration_secs: 0,
      provider_cost_usd: 0,
      stop_class: "call-limit",
      exit_code: 1,
    });
    expect(built.failure).toEqual({ stage: "repair", kind: "call-limit", limit: { name: "repairStepTurns", max: 8, actual: 9 } });
    expect(JSON.stringify(built)).not.toContain("会話の本文");
  });

  it("上限の無い失敗では、limit の欄を持たない（形は今のまま）", () => {
    const plain = buildRunRecord({ ...record(), failure: { stage: "repair", kind: "call-limit" } });
    expect(plain.failure).toEqual({ stage: "repair", kind: "call-limit" });
    expect("limit" in (plain.failure ?? {})).toBe(false);
    expect(Object.keys(buildRunRecord(record()).failure ?? {})).toEqual(["stage", "kind"]);
  });
});

// ── 形・未達の失敗に、欄の名前と種類を写す（02 §3.5・S-8・#304）──

describe("形・未達の失敗の帰属に、欄の名前と種類を写す（02 §3.5・S-8・#304）", () => {
  const problem = { field: "declaration", message: "直した宣言は空でない文字列（YAML の原文）であること" };
  const withProblems = (): RunRecord => ({
    ...record(),
    failure: { stage: "repair", kind: "malformed", problems: [problem] },
  });

  it("記録と要約の失敗の欄に、欄の名前と種類が出る", () => {
    const picked = buildRunRecord(withProblems());
    expect(picked.failure).toEqual({ stage: "repair", kind: "malformed", problems: [problem] });
    const built = buildSummary(picked, {
      run_id: "run-1",
      verdict: "none",
      assurance: "none",
      duration_secs: 0,
      provider_cost_usd: 0,
      stop_class: "malformed",
      exit_code: 1,
    });
    expect(built.failure).toEqual({ stage: "repair", kind: "malformed", problems: [problem] });
  });

  it("問題の無い失敗では、problems の欄を持たない", () => {
    const picked = buildRunRecord(record());
    expect(picked.failure).toEqual({ stage: "repair", kind: "unmet" });
    expect("problems" in (picked.failure ?? {})).toBe(false);
  });
});

// ── 形の誤りの種類を、段の記録と失敗の帰属に写す（Issue #783）──

describe("形の誤りの種類を、段の記録と失敗の帰属に写す（Issue #783）", () => {
  const MALFORMED_ZERO = { "no-body": 0, "not-json": 0, envelope: 0, "wrong-stage": 0, schema: 0, other: 0 };
  const usage = {
    calls: 1,
    missing_usage_calls: 0,
    input_tokens: 10,
    cached_input_tokens: 2,
    cache_write_tokens: 3,
    output_tokens: 4,
    reasoning_tokens: 1,
  };

  it("(6) 段の記録：0 でない鍵があるときだけ malformed の欄を持ち、集計の鍵 6 つを名指しで写す", () => {
    const counts: CallCounts = {
      attempts: { ...COUNTS.attempts, malformed: { ...MALFORMED_ZERO, schema: 1 } },
      retries: COUNTS.retries,
    };
    const built = makeStageRecord("write", "failed", 12, usage, counts, "malformed");
    expect(built.attempts.malformed).toEqual({ ...MALFORMED_ZERO, schema: 1 });
    // 余分な鍵は写さない
    const raw = {
      attempts: { ...COUNTS.attempts, malformed: { ...MALFORMED_ZERO, schema: 1, extra: 9 } },
      retries: COUNTS.retries,
    } as unknown as CallCounts;
    const named = makeStageRecord("write", "failed", 12, usage, raw, "malformed");
    expect(Object.keys(named.attempts.malformed ?? {}).sort()).toEqual(Object.keys(MALFORMED_ZERO).sort());
  });

  it("(2') 0 だけの段・欄の無い段は、malformed の欄を持たない", () => {
    const zeroCounts: CallCounts = {
      attempts: { ...COUNTS.attempts, malformed: { ...MALFORMED_ZERO } },
      retries: COUNTS.retries,
    };
    const zero = makeStageRecord("write", "ok", 12, usage, zeroCounts, null);
    expect("malformed" in (zero.attempts as unknown as Record<string, unknown>)).toBe(false);
    const absent = makeStageRecord("write", "ok", 12, usage, COUNTS, null);
    expect("malformed" in (absent.attempts as unknown as Record<string, unknown>)).toBe(false);
    // 段の記録の差でも同じ：記録と要約の両方で欄が無い
    expect(Object.keys(buildRunRecord(record()).stages[0]?.attempts ?? {}).sort()).toEqual([...ATTEMPT_KEYS].sort());
    expect(Object.keys(summary().stages[0]?.attempts ?? {}).sort()).toEqual([...ATTEMPT_KEYS].sort());
  });

  it("(2')(6) 段の差分の和：集計の鍵の合計は errors を超えない（保存と要約で値が残る）", () => {
    const counts: CallCounts = {
      attempts: { ...COUNTS.attempts, malformed: { ...MALFORMED_ZERO, "no-body": 1 } },
      retries: COUNTS.retries,
    };
    const stageWithMalformed = makeStageRecord("write", "failed", 12, usage, counts, "malformed");
    const withStage = buildRunRecord({ ...record(), stages: [stageWithMalformed] });
    const sum = Object.values(withStage.stages[0]!.attempts.malformed!).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(withStage.stages[0]!.attempts.errors);
    expect(summary().stages[0]?.attempts.malformed).toBeUndefined();
  });

  it("(6) 失敗の帰属：印を持つときだけ malformed_kind を写す（保存と要約の両方）", () => {
    const withMark: RunRecord = { ...record(), failure: { stage: "repair", kind: "malformed", malformed_kind: "envelope" } };
    const picked = buildRunRecord(withMark);
    expect(picked.failure).toEqual({ stage: "repair", kind: "malformed", malformed_kind: "envelope" });
    const built = buildSummary(withMark, {
      run_id: "run-1",
      verdict: "none",
      assurance: "none",
      duration_secs: 0,
      provider_cost_usd: 0,
      stop_class: "malformed",
      exit_code: 1,
    });
    expect(built.failure).toEqual({ stage: "repair", kind: "malformed", malformed_kind: "envelope" });
  });

  it("(3) 印の無い malformed（段の検査の problems あり・other の側）は malformed_kind を持たない", () => {
    const problem = { field: "declaration", message: "直した宣言は空でない文字列であること" };
    const noMark = buildRunRecord({ ...record(), failure: { stage: "repair", kind: "malformed", problems: [problem] } });
    expect(noMark.failure).toEqual({ stage: "repair", kind: "malformed", problems: [problem] });
    expect("malformed_kind" in (noMark.failure ?? {})).toBe(false);
    // 余分な欄（malformed_kind を持つ malformed に problems を渡す）は、どちらも写す
    const both = buildRunRecord({
      ...record(),
      failure: { stage: "repair", kind: "malformed", problems: [problem], malformed_kind: "schema" },
    });
    expect(both.failure).toEqual({ stage: "repair", kind: "malformed", malformed_kind: "schema", problems: [problem] });
  });

  it("(2') 段の実試行の行（CallRequestLog）：error_kind が malformed の行だけ malformed_kind を持つ", () => {
    const log = new CallRequestLog(0, () => 0);
    const unit = log.beginUnit();
    const observer = log.observer(unit);
    observer.beginAttempt().settle({ kind: "error", errorKind: "malformed", malformedKind: "wrong-stage" });
    observer.beginAttempt().settle({ kind: "error", errorKind: "malformed" });
    observer.beginAttempt().settle({ kind: "error", errorKind: "network" });
    log.finishUnit(unit, 0);
    const rows = log.requests();
    expect(rows[0]).toMatchObject({ error_kind: "malformed", malformed_kind: "wrong-stage" });
    expect("malformed_kind" in (rows[1] ?? {})).toBe(false);
    expect("malformed_kind" in (rows[2] ?? {})).toBe(false);
  });
});

describe("段の識別子は v1 の並びを保ち、v1.1α の段を末尾に足す（07 §3・Issue #505）", () => {
  it("先頭 12 個は今までどおりの並びで、v1.1α の 7 個が末尾にある", () => {
    expect(STAGE_IDS.slice(0, 12)).toEqual([
      "requirements",
      "reverse-check",
      "design",
      "test-suite",
      "write",
      "static-check",
      "correspondence",
      "run-tests",
      "repair",
      "arbitration",
      "judge",
      "bundle",
    ]);
    expect(STAGE_IDS.slice(12, 19)).toEqual([
      "name-table",
      "semantic-check",
      "test-spec",
      "name-check",
      "decl-check",
      "coverage",
      "carry-over",
    ]);
    // v1.2 の段（Issue #593）は v1.1α の 7 個のさらに後ろ（上の並びは変えない）
    expect(STAGE_IDS.slice(19)).toEqual(["vocabulary", "mapping"]);
    expect(new Set(STAGE_IDS).size).toBe(STAGE_IDS.length);
  });

  it("参照の照合の数は vocabulary・mapping の記録だけが固定の鍵で持ち、ほかの段の記録には欄が無い（Issue #593）", () => {
    const usage = { calls: 1, missing_usage_calls: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
    const counts: CallCounts = {
      attempts: { started: 1, responses: 1, errors: 0, aborted: 0, not_started: { deadline: 0, budget: 0, limit: 0, timeout: 0 } },
      retries: { communication: 0, shape: 0, content: 0 },
    } as unknown as CallCounts;
    const references = { checked: 3, unknown_ids: 1, duplicates: 1, cross_bundle_ids: 1, extra: 9 } as unknown as StageReferenceCounts;
    for (const stage of REFERENCE_COUNT_STAGES) {
      const record = makeStageRecord(stage, "ok", 0, usage, counts, null, null, references);
      expect(record.references).toEqual({ checked: 3, unknown_ids: 1, duplicates: 1, cross_bundle_ids: 1 });
      expect(Object.keys(record.references ?? {})).toEqual([...REFERENCE_COUNT_KEYS]);
    }
    expect(REFERENCE_COUNT_STAGES).toEqual(["vocabulary", "mapping"]);
    const other = makeStageRecord("name-table", "ok", 0, usage, counts, null, null, references);
    expect(other).not.toHaveProperty("references");
    expect(Object.keys(other).sort()).toEqual([...STAGE_RECORD_KEYS].sort());
    expect(makeStageRecord("vocabulary", "ok", 0, usage, counts, null)).not.toHaveProperty("references");
  });

  it("FAILURE_KINDS・STAGE_OPERATIONS の並びは変わらない", () => {
    expect(FAILURE_KINDS).toEqual([
      "limit",
      "deadline",
      "budget",
      "call-limit",
      "timeout",
      "network",
      "http",
      "balance",
      "malformed",
      "refused",
      "tool-arguments",
      "invalid-request",
      "unmet",
      "incomplete",
      "unknown",
    ]);
    expect(STAGE_OPERATIONS).toEqual(["redo-design"]);
  });
});

// ── 実試行の行と段全体の span（旗 v12.ids の段の走りだけ。Issue #748）──────────────────────────────

describe("実試行の行と段全体の span（Issue #748）：行は開始の順に段の行を指し、遅着の加算を含んだ段の行を解く", () => {
  /** 出来事で進める偽物の時計（時刻を読む回数では進まない） */
  function clockAt(start = 1_000) {
    let now = start;
    return { now: () => now, set: (value: number) => (now = value) };
  }

  it("行は開始の順に、開始・終わり・終わり方・トークンを持ち、段の行の位置を指す", () => {
    const clock = clockAt();
    const log = new CallRequestLog(1_000, clock.now);
    const unit = log.beginUnit();
    const observer = log.observer();
    clock.set(1_005);
    const first = observer.beginAttempt();
    first.settle({ kind: "response", usage: USAGE });
    clock.set(1_012);
    const second = observer.beginAttempt();
    second.settle({ kind: "incomplete", usage: undefined });
    clock.set(1_020);
    const third = observer.beginAttempt();
    third.settle({ kind: "error", errorKind: "network" });
    clock.set(1_030);
    const fourth = observer.beginAttempt();
    fourth.settle({ kind: "timeout" });
    log.finishUnit(unit, 4);

    expect(log.requests()).toEqual([
      { stage_index: 4, start_ms: 5, end_ms: 5, end: "response", error_kind: null, usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_tokens: 3, output_tokens: 4, reasoning_tokens: 1 }, late: { usage: null, metered_stage_index: null } },
      { stage_index: 4, start_ms: 12, end_ms: 12, end: "incomplete", error_kind: null, usage: null, late: { usage: null, metered_stage_index: null } },
      { stage_index: 4, start_ms: 20, end_ms: 20, end: "error", error_kind: "network", usage: null, late: { usage: null, metered_stage_index: null } },
      { stage_index: 4, start_ms: 30, end_ms: 30, end: "timeout", error_kind: null, usage: null, late: { usage: null, metered_stage_index: null } },
    ]);
    // 行はちょうど 1 度だけ確定する（2 度目の settle は無視）
    first.settle({ kind: "error", errorKind: "unknown" });
    expect(log.requests()[0]?.end).toBe("response");
  });

  it("遅着の usage は行の終わり方を変えず、加算を含んだ段の行の位置を解く（段の中・段と段の間・次の段の中。同じ試行が遅着する）", () => {
    const clock = clockAt();
    const log = new CallRequestLog(1_000, clock.now);

    // 段 1 の中で 2 本を打ち切る。1 本は段 1 の中で遅着し、もう 1 本は段 2 に遅着する（同じ試行）
    const unit1 = log.beginUnit();
    const observer = log.observer();
    const row1 = observer.beginAttempt();
    row1.settle({ kind: "timeout" });
    const rowLate = observer.beginAttempt();
    rowLate.settle({ kind: "timeout" });
    clock.set(1_010);
    row1.late({ inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 } as LlmUsage);
    log.finishUnit(unit1, 0);

    // 段 1 の確定と段 2 の開始の間の遅着 → どの行にも入らない（null）
    const row2 = observer.beginAttempt();
    row2.settle({ kind: "timeout" });
    clock.set(1_020);
    row2.late(undefined);
    expect(log.requests()[2]?.stage_index).toBeNull();

    // 段 2 の中の遅着（段 1 で打ち切った同じ試行）→ 段 2 の行
    const unit2 = log.beginUnit();
    const row3 = observer.beginAttempt();
    row3.settle({ kind: "timeout" });
    clock.set(1_030);
    rowLate.late({ inputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0 } as LlmUsage);
    log.finishUnit(unit2, 2);

    const requests = log.requests();
    expect(requests[0]).toMatchObject({ stage_index: 0, end: "timeout", late: { usage: { input_tokens: 1, output_tokens: 2 }, metered_stage_index: 0 } });
    // 段 1 で打ち切った同じ試行が、段 2 の行に遅着する
    expect(requests[1]).toMatchObject({ stage_index: 0, end: "timeout", late: { usage: { input_tokens: 4, output_tokens: 5 }, metered_stage_index: 2 } });
    expect(requests[2]).toMatchObject({ stage_index: null, end: "timeout", late: { usage: null, metered_stage_index: null } });
    expect(requests[3]).toMatchObject({ stage_index: 2, end: "timeout", late: { usage: null, metered_stage_index: null } });
  });

  it("T2 の束の遅着は、束の確定の前ならその束の行、確定のあとなら後続の段の行、どの行にも入らなければ null", () => {
    const clock = clockAt();
    const log = new CallRequestLog(1_000, clock.now);

    // 束 A：確定の前の遅着 → 束 A の行
    const bundleA = log.beginBoundUnit();
    const a = log.observer(bundleA);
    const rowA = a.beginAttempt();
    clock.set(1_010);
    rowA.settle({ kind: "timeout" });
    clock.set(1_020);
    rowA.late(undefined);
    log.finishUnit(bundleA, 6);

    // 束 B：確定のあとに遅着し、次の段（B1）の中に来る → B1 の行
    const bundleB = log.beginBoundUnit();
    const b = log.observer(bundleB);
    const rowB = b.beginAttempt();
    clock.set(1_030);
    rowB.settle({ kind: "timeout" });
    log.finishUnit(bundleB, 7);
    const b1 = log.beginUnit();
    clock.set(1_040);
    rowB.late(undefined);
    log.finishUnit(b1, 8);

    // 束 C：確定のあと、どの段も開いていない間の遅着 → null
    const bundleC = log.beginBoundUnit();
    const c = log.observer(bundleC);
    const rowC = c.beginAttempt();
    clock.set(1_050);
    rowC.settle({ kind: "timeout" });
    log.finishUnit(bundleC, 9);
    clock.set(1_060);
    rowC.late(undefined);

    const requests = log.requests();
    expect(requests[0]).toMatchObject({ stage_index: 6, late: { metered_stage_index: 6 } });
    expect(requests[1]).toMatchObject({ stage_index: 7, late: { metered_stage_index: 8 } });
    expect(requests[2]).toMatchObject({ stage_index: 9, late: { metered_stage_index: null } });
  });

  it("段全体の span は開始の順に、対応する段の行の位置と終わり（途中で止まれば null）を持つ", () => {
    const clock = clockAt();
    const log = new CallRequestLog(1_000, clock.now);
    const mapping = log.openSpan("mapping", 1, 0);
    log.closeSpan(mapping, [3], 50);
    const c3 = log.openSpan("semantic-check", 1, 60);
    log.failSpan(c3, [4]);
    const t2 = log.openSpan("test-spec", null, 70);
    log.closeSpan(t2, [5, 6, 7], 240);
    expect(log.stageSpans()).toEqual([
      { stage: "mapping", round: 1, start_ms: 0, end_ms: 50, stage_indices: [3] },
      { stage: "semantic-check", round: 1, start_ms: 60, end_ms: null, stage_indices: [4] },
      { stage: "test-spec", round: null, start_ms: 70, end_ms: 240, stage_indices: [5, 6, 7] },
    ]);
  });

  it("T2 の 3 つの束が逆の順で終わっても、各行は自分の束の段の行を指す（漏れなし・取り違えなし）", () => {
    const clock = clockAt();
    const log = new CallRequestLog(1_000, clock.now);
    const units = [0, 1, 2].map(() => log.beginBoundUnit());
    const observers = units.map((unit) => log.observer(unit));
    // 開始は束 0・1・2 の順
    const rows = observers.map((observer, index) => {
      clock.set(1_010 + index * 10);
      return observer.beginAttempt();
    });
    // 完了は束 2・1・0 の順（逆）。行の数は開始の数と同じで、漏れがない
    clock.set(1_110);
    rows[2]!.settle({ kind: "response", usage: USAGE });
    clock.set(1_120);
    rows[1]!.settle({ kind: "response", usage: USAGE });
    clock.set(1_130);
    rows[0]!.settle({ kind: "response", usage: USAGE });
    // 段の行は束の順に積む（T2 の settle と同じ）
    units.forEach((unit, index) => log.finishUnit(unit, 10 + index));

    expect(log.requests()).toHaveLength(3);
    expect(log.requests().map((request) => request.stage_index)).toEqual([10, 11, 12]);
    // 終わった時刻は完了の順（逆）で、開始は束の順（完了の順で番号を振っていない）
    expect(log.requests().map((request) => [request.start_ms, request.end_ms])).toEqual([
      [10, 130], [20, 120], [30, 110],
    ]);
  });
});
