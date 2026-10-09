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
  RUN_RECORD_KEYS,
  STAGE_RECORD_KEYS,
  SUMMARY_KEYS,
  UsageMeter,
  buildRunRecord,
  buildSummary,
  makeStageRecord,
  usageDelta,
  type RunRecord,
} from "./record.js";

const USAGE: OpenAiUsage = {
  inputTokens: 10,
  cachedInputTokens: 2,
  cacheWriteTokens: 3,
  outputTokens: 4,
  reasoningTokens: 1,
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
