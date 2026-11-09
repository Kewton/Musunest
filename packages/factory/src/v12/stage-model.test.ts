// 段ごとのモデルの口（`--pipeline v1.2` の `--stage-model <段>=<モデル>`。Issue #829）の試験。
//
// 固定するのは 5 つ。
//   1. 解析：繰り返しを付けた順に読み、知らない段・配線していない段・表に無いモデル（走りのモデルを含む）・重複・形・
//      v1.2 以外・openai 以外の provider は、それぞれの符号で exit 2・API 0 回・何も書かない
//   2. 要求：段のモデルを指定した段だけ `model` を載せ、指定の無い段は今の要求のまま。effort と併せて指定できる
//   3. 費用：予約と精算を段のモデルの単価で数える（手計算の和に等しい）。予算が足りなければ呼び出しが始まらない
//   4. 判定の会計：LLM の判定は走りのモデルの単価、Jev は `JEV_RATES` で数える（段のモデルの単価を流さない）
//   5. 走りのモデルの単価：openai では `--stage-model` の有無と経路に依らず表から引く（表に無ければ既定）
import { describe, expect, it, vi } from "vitest";
import {
  API_KEY_ENV,
  DEFAULT_RATES,
  EXIT_USAGE,
  MODEL_RATES,
  OLLAMA_RATES,
  OPENROUTER_RATES,
  STAGE_MODEL_USAGE,
  TERRA_RATES,
  isKnownModel,
  modelRatesOf,
  parseCliArguments,
  parseStageModels,
  runCli,
  runRatesOf,
} from "../cli.js";
import { JobBudget, JEV_RATES, costOfUsageUsd, estimateMaxCostUsd } from "../budget.js";
import {
  CallGateway,
  estimateInputUpperBoundTokens,
  structuredInputParts,
} from "../call.js";
import { createBudgetedJudge } from "../judge-budget.js";
import type { Judge, JudgeResponse } from "../judge.js";
import { AGENT_LIMITS, maxOutputTokensForEffort, type StageEfforts, type StageModels } from "../limits.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmUsage,
} from "../llm.js";
import { createOpenAiLlmClient, DEFAULT_OPENAI_MODEL } from "../openai.js";

const TERRA = "gpt-6.1-terra";
const LUNA = DEFAULT_OPENAI_MODEL;
const PLAN_FILE_ARGS = ["--pipeline", "v1.2", "--plan-file", "plan.json"];

/** 手計算の例（Issue #829）：入力 1,000・キャッシュ読み 300・キャッシュ書き 200・出力 100 */
const USAGE: LlmUsage = {
  inputTokens: 1_000,
  cachedInputTokens: 300,
  cacheWriteTokens: 200,
  outputTokens: 100,
  reasoningTokens: 0,
};

/** 応答の usage を固定し、要求をそのまま記録する偽物の LLM（外部 API を呼ばない） */
class RecordingLlm implements LlmClient {
  readonly structured: LlmStructuredRequest[] = [];
  readonly tools: LlmToolRequest[] = [];
  constructor(private readonly usage: LlmUsage | undefined = USAGE) {}
  async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
    this.structured.push(request);
    return { output: {} as T, usage: this.usage };
  }
  async callWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
    this.tools.push(request);
    return { kind: "done", declaration: {}, usage: this.usage };
  }
}

const REQUEST = (maxOutputTokens: number): LlmStructuredRequest => ({
  instructions: "instructions",
  documents: ["document"],
  input: "data",
  schemaName: "test",
  schema: { type: "object" },
  maxOutputTokens,
});

function gatewayWith(options: {
  readonly budgetUsd?: number;
  readonly stageEfforts?: StageEfforts;
  readonly stageModels?: StageModels;
  readonly client?: LlmClient;
  readonly rates?: typeof DEFAULT_RATES;
}): { readonly gateway: CallGateway; readonly budget: JobBudget; readonly client: LlmClient } {
  const budget = new JobBudget(options.budgetUsd ?? 10);
  const client = options.client ?? new RecordingLlm();
  const gateway = new CallGateway({
    client,
    budget,
    rates: options.rates ?? DEFAULT_RATES,
    now: () => 0,
    deadline: 10 * 60 * 1000,
    effort: "high",
    ...(options.stageEfforts === undefined ? {} : { stageEfforts: options.stageEfforts }),
    ...(options.stageModels === undefined ? {} : { stageModels: options.stageModels }),
    stageModelRates: MODEL_RATES,
  });
  return { gateway, budget, client };
}

describe("引数：--stage-model の読み取りと断り（Issue #829）", () => {
  it("繰り返しを付けた順に段 → モデルで読み、同じ段に effort とモデルを併せて指定できる", () => {
    const parsed = parseCliArguments([
      "--",
      "request.txt",
      "--out",
      "out",
      ...PLAN_FILE_ARGS,
      "--stage-model",
      `test-spec=${TERRA}`,
      "--stage-model",
      `vocabulary=${LUNA}`,
      "--stage-effort",
      "test-spec=high",
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.stageModels).toEqual({ "test-spec": TERRA, vocabulary: LUNA });
    expect(Object.keys(parsed.stageModels ?? {})).toEqual(["test-spec", "vocabulary"]);
    expect(parsed.stageEfforts).toEqual({ "test-spec": "high" });
    expect(parseCliArguments(["--", "request.txt", "--out", "out", ...PLAN_FILE_ARGS])).not.toHaveProperty("stageModels");
  });

  it("解析の関数：空なら空の組。表に無い段のモデル・走りのモデルは model で断る", () => {
    expect(parseStageModels([], "openai", LUNA)).toEqual({ stageModels: {} });
    expect(parseStageModels([`test-spec=${TERRA}`], "openai", LUNA)).toEqual({ stageModels: { "test-spec": TERRA } });
    expect(parseStageModels([`test-spec=${TERRA}`], "openai", "gpt-unknown")).toEqual({ code: "stage-model:model" });
    expect(parseStageModels(["test-spec=gpt-unknown"], "openai", LUNA)).toEqual({ code: "stage-model:model" });
    expect(parseStageModels([`test-spec=${TERRA}`], "ollama", LUNA)).toEqual({ code: "stage-model:provider" });
    expect(isKnownModel(TERRA)).toBe(true);
    expect(isKnownModel("gpt-unknown")).toBe(false);
  });

  const cases: readonly { readonly name: string; readonly argv: readonly string[]; readonly code: string }[] = [
    { name: "知らない段", argv: ["--stage-model", `unknown=${TERRA}`], code: "stage-model:stage" },
    { name: "配線していない段（name-table）", argv: ["--stage-model", `name-table=${TERRA}`], code: "stage-model:stage" },
    { name: "配線していない段（arbitration）", argv: ["--stage-model", `arbitration=${TERRA}`], code: "stage-model:stage" },
    { name: "表に無い段のモデル", argv: ["--stage-model", "test-spec=gpt-unknown"], code: "stage-model:model" },
    {
      name: "表に無い走りのモデル",
      argv: ["--model", "gpt-unknown", "--stage-model", `test-spec=${TERRA}`],
      code: "stage-model:model",
    },
    {
      name: "同じ段の重複",
      argv: ["--stage-model", `mapping=${TERRA}`, "--stage-model", `mapping=${TERRA}`],
      code: "stage-model:duplicate",
    },
    { name: "= の無い形", argv: ["--stage-model", "test-spec"], code: "stage-model:format" },
    { name: "段の無い形", argv: ["--stage-model", `=${TERRA}`], code: "stage-model:format" },
    { name: "値の無い旗", argv: ["--stage-model"], code: "stage-model:missing" },
    {
      name: "openai 以外の provider（ollama）",
      argv: ["--provider", "ollama", "--stage-model", `test-spec=${TERRA}`],
      code: "stage-model:provider",
    },
    {
      name: "openai 以外の provider（openrouter）",
      argv: ["--provider", "openrouter", "--stage-model", `test-spec=${TERRA}`],
      code: "stage-model:provider",
    },
  ];

  it.each(cases)("$name → $code（終了コード 2・API を呼ばない・何も書かない）", async (example) => {
    const makeClient = vi.fn();
    const writeFile = vi.fn(async () => {});
    const makeDirectory = vi.fn(async () => {});
    const lines: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", "out", ...PLAN_FILE_ARGS, ...example.argv],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async () => "request",
      writeFile,
      makeDirectory,
      loadDocuments: async () => [],
      makeClient,
      log: (line) => lines.push(line),
      logError: () => {},
    });
    expect(code).toBe(EXIT_USAGE);
    expect(makeClient).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(lines[0]).toContain(example.code);
    expect(lines).toContain(STAGE_MODEL_USAGE);
  });

  it("v1.2 以外（v1.1a・v1・省略）との組は stage-model:pipeline で断る", async () => {
    for (const pipeline of [["--pipeline", "v1.1a"], ["--pipeline", "v1"], []] as const) {
      const parsed = parseCliArguments(["--", "request.txt", "--out", "out", ...pipeline, "--plan-file", "plan.json", "--stage-model", `test-spec=${TERRA}`]);
      expect("error" in parsed ? parsed.error : "").toContain("stage-model:pipeline");
    }
  });
});

describe("要求：段のモデルは指定した段だけに載る（Issue #829）", () => {
  it("(1)(2) 段のモデルを指定した段だけ model を載せ、ほかの段は今の要求のまま。effort と併せて指定できる", async () => {
    const client = new RecordingLlm();
    const { gateway } = gatewayWith({
      client,
      stageEfforts: { "test-spec": "high" },
      stageModels: { "test-spec": TERRA },
    });
    const t2 = gateway.forStage("test-spec");
    await t2.callStructured(REQUEST(t2.maxOutputTokens("test-spec")));
    const write = gateway.forStage("write");
    await write.callStructured(REQUEST(write.maxOutputTokens("write")));
    expect(client.structured).toHaveLength(2);
    const [t2Request, writeRequest] = client.structured;
    expect(t2Request?.model).toBe(TERRA);
    expect(t2Request?.effort).toBe("high");
    expect(t2Request?.maxOutputTokens).toBe(maxOutputTokensForEffort("high", "test-spec"));
    expect(writeRequest?.model).toBeUndefined();
    expect(writeRequest?.effort).toBeUndefined();
    // 指定の無い段は元の口そのもの（既存の call.test.ts の参照の試験と同じ規則）
    expect(gateway.forStage("write")).toBe(gateway);
  });

  it("モデルだけの指定でも、要求の effort・出力の上限・timeout は元の口のまま（モデルだけを載せる）", async () => {
    const client = new RecordingLlm();
    const { gateway } = gatewayWith({ client, stageModels: { write: TERRA } });
    const write = gateway.forStage("write");
    expect(write).not.toBe(gateway);
    expect(write.effort).toBe(gateway.effort);
    expect(write.callTimeoutMs).toBe(gateway.callTimeoutMs);
    await write.callStructured(REQUEST(write.maxOutputTokens("write")));
    const [request] = client.structured;
    expect(request?.model).toBe(TERRA);
    expect(request?.effort).toBeUndefined();
    expect(request?.maxOutputTokens).toBe(maxOutputTokensForEffort("high", "write"));
  });

  it("道具付きの要求（repair）にも段のモデルを載せる", async () => {
    const client = new RecordingLlm();
    const { gateway } = gatewayWith({ client, stageModels: { repair: TERRA } });
    await gateway.forStage("repair").callWithTools({
      instructions: "instructions",
      documents: ["document"],
      input: "data",
      tools: [],
      turns: [],
      maxOutputTokens: 1_024,
    });
    expect(client.tools[0]?.model).toBe(TERRA);
  });
});

describe("費用：段のモデルの単価で予約と精算する（Issue #829）", () => {
  it("手計算：入力 1,000・キャッシュ読み 300・キャッシュ書き 200・出力 100 は luna 0.000128・terra 0.001265", () => {
    expect(costOfUsageUsd(USAGE, DEFAULT_RATES)).toBeCloseTo(0.000128, 12);
    expect(costOfUsageUsd(USAGE, TERRA_RATES)).toBeCloseTo(0.001265, 12);
    // 推論のトークンは出力の内訳で、別に足さない
    expect(costOfUsageUsd({ ...USAGE, reasoningTokens: 60 }, TERRA_RATES)).toBeCloseTo(0.001265, 12);
  });

  it("(3) T2 の精算が terra・ほかが luna の単価。段の和が総支出に等しく、表に無い段は今の単価のまま", async () => {
    const client = new RecordingLlm();
    const { gateway, budget } = gatewayWith({
      client,
      stageModels: { "test-spec": TERRA },
    });
    const t2 = gateway.forStage("test-spec");
    await t2.callStructured(REQUEST(t2.maxOutputTokens("test-spec")));
    const write = gateway.forStage("write");
    await write.callStructured(REQUEST(write.maxOutputTokens("write")));
    const expected = costOfUsageUsd(USAGE, TERRA_RATES) + costOfUsageUsd(USAGE, DEFAULT_RATES);
    expect(budget.spentUsd).toBeCloseTo(expected, 12);
    expect(budget.spentUsd).toBeCloseTo(0.001265 + 0.000128, 12);
  });

  it("(4) 予算が足りなければ T2 の呼び出しが予約で始まらない（not_started.budget）。予算を緩めない", async () => {
    const maxOutputTokens = maxOutputTokensForEffort("high", "test-spec");
    const inputTokens = estimateInputUpperBoundTokens(structuredInputParts(REQUEST(maxOutputTokens)));
    const lunaMax = estimateMaxCostUsd({ inputTokens, maxOutputTokens, rates: DEFAULT_RATES });
    const terraMax = estimateMaxCostUsd({ inputTokens, maxOutputTokens, rates: TERRA_RATES });
    expect(terraMax).toBeGreaterThan(lunaMax);
    const budgetUsd = (lunaMax + terraMax) / 2;
    const client = new RecordingLlm();
    const { gateway, budget } = gatewayWith({ client, budgetUsd, stageModels: { "test-spec": TERRA } });
    // 同じ予算で、モデルを指定しない段（luna の単価）は始まる
    const write = gateway.forStage("write");
    expect((await write.callStructured(REQUEST(write.maxOutputTokens("write")))).kind).toBe("ok");
    // 段のモデル（terra）の予約は残高を超えるので、呼び出しを始めない
    const t2 = gateway.forStage("test-spec");
    const result = await t2.callStructured(REQUEST(t2.maxOutputTokens("test-spec")));
    expect(result.kind).toBe("budgetExceeded");
    expect(gateway.attempts.not_started.budget).toBe(1);
    expect(client.structured).toHaveLength(1);
    expect(budget.limitUsd).toBe(budgetUsd);
  });

  it("(8) model-rate:judge-account：LLM の判定は走りのモデルの単価、Jev は JEV_RATES。段のモデルの単価を判定に流さない", async () => {
    // 走りは luna（DEFAULT_RATES）。T2 に terra を指定しても、判定に渡るのは走りの単価だけである
    const llmJudge: Judge = {
      source: "llm",
      async judge(): Promise<JudgeResponse> {
        return { answers: {}, inputTokens: USAGE.inputTokens, usage: USAGE, model: LUNA, answeredBy: "llm" };
      },
    };
    const llmBudget = new JobBudget(10);
    const wrappedLlm = createBudgetedJudge({ judge: llmJudge, budget: llmBudget, rates: DEFAULT_RATES });
    await wrappedLlm.judge({ state: {}, questions: {} });
    expect(llmBudget.spentUsd).toBeCloseTo(costOfUsageUsd(USAGE, DEFAULT_RATES), 12);
    // 段のモデル（terra）の単価を判定に流すと、この期待が赤くなる
    expect(llmBudget.spentUsd).not.toBeCloseTo(costOfUsageUsd(USAGE, TERRA_RATES), 12);

    const jevJudge: Judge = {
      source: "jev",
      async judge(): Promise<JudgeResponse> {
        return { answers: {}, inputTokens: 1_000, model: "jev", answeredBy: "jev" };
      },
    };
    const jevBudget = new JobBudget(10);
    const wrappedJev = createBudgetedJudge({ judge: jevJudge, budget: jevBudget, rates: DEFAULT_RATES });
    await wrappedJev.judge({ state: {}, questions: {} });
    expect(jevBudget.spentUsd).toBeCloseTo(1_000 * JEV_RATES.inputPerToken, 12);
  });
});

describe("model-rate:v1-and-plan / model-rate:build-and-stage：走りのモデルの単価（Issue #829）", () => {
  it("openai では走りのモデルの単価を表から引く（terra・luna・表に無いモデルは既定）", () => {
    expect(runRatesOf({ provider: "openai", model: TERRA })).toBe(TERRA_RATES);
    expect(runRatesOf({ provider: "openai", model: LUNA })).toBe(DEFAULT_RATES);
    expect(runRatesOf({ provider: "openai", model: "gpt-unknown" })).toBe(DEFAULT_RATES);
    expect(modelRatesOf(TERRA)).toBe(TERRA_RATES);
    expect(modelRatesOf("gpt-unknown")).toBe(DEFAULT_RATES);
  });

  it("model-rate:unknown-compatibility：明示の rates が最優先。Ollama・OpenRouter の経路は変わらない", () => {
    const custom = { ...DEFAULT_RATES, outputPerToken: 9 };
    expect(runRatesOf({ provider: "openai", model: TERRA, rates: custom })).toBe(custom);
    expect(runRatesOf({ provider: "ollama", model: "any" })).toBe(OLLAMA_RATES);
    expect(runRatesOf({ provider: "openrouter", model: "any" })).toBe(OPENROUTER_RATES);
    // 表を差し込める（明示の deps.rates と同じ作法）
    const table = { "gpt-custom": custom };
    expect(runRatesOf({ provider: "openai", model: "gpt-custom", modelRates: table })).toBe(custom);
    expect(runRatesOf({ provider: "openai", model: TERRA, modelRates: table })).toBe(DEFAULT_RATES);
  });
});

describe("adapter：要求の model を body に載せる（Issue #829）", () => {
  /** 偽物の fetch で body を採る（外部 API は呼ばない。500 は捨てる） */
  async function bodyOf(configure: (client: LlmClient) => Promise<unknown>, model?: string): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> | undefined;
    const full = createOpenAiLlmClient({
      apiKey: "sk-FAKE",
      model: LUNA,
      ...(model === undefined ? {} : { model }),
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ error: { code: "server_error" } }), { status: 500 });
      },
    });
    await configure(full).catch(() => {});
    if (sent === undefined) throw new Error("body がありません");
    return sent;
  }

  it("構造化・道具付きのどちらも、要求の model が設定の値を上書きする。要求に無ければ設定の値", async () => {
    const configured = await bodyOf((client) => client.callStructured(REQUEST(100)));
    expect(configured["model"]).toBe(LUNA);
    const explicit = await bodyOf((client) => client.callStructured({ ...REQUEST(100), model: TERRA }));
    expect(explicit["model"]).toBe(TERRA);
    const tools = await bodyOf((client) =>
      client.callWithTools({
        instructions: "instructions",
        documents: ["document"],
        input: "data",
        tools: [],
        turns: [],
        maxOutputTokens: 100,
        model: TERRA,
      }),
    );
    expect(tools["model"]).toBe(TERRA);
  });
});

describe("上限と既定の値は変えない（Issue #829）", () => {
  it("予算の既定・effort の上限・timeout・呼び出しの回数の上限は今のまま", () => {
    expect(AGENT_LIMITS.callCount).toBe(24);
    expect(maxOutputTokensForEffort("high", "repair")).toBe(32_768);
    expect(maxOutputTokensForEffort("medium", "test-spec")).toBe(32_768);
  });
});
