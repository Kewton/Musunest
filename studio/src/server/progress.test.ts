import {
  DECL_CHECK_SCHEMA_NAME,
  NAME_TABLE_SCHEMA_NAME,
  TEST_SPEC_SCHEMA_NAME,
  TERRA_RATES,
  modelRatesOf,
  type LlmClient,
  type LlmStructuredRequest,
  type LlmStructuredResponse,
  type LlmToolResponse,
  type LlmUsage,
} from "@musunest/factory";
import { describe, expect, it } from "vitest";
import type { RunnerProgress } from "./runner.js";
import { UNKNOWN_STAGE_LABEL, createProgressTracker, stageLabelOf } from "./progress.js";

const usage = (inputTokens: number): LlmUsage => ({
  inputTokens,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

const clientWith = (value: LlmUsage): LlmClient => ({
  async callStructured<T>(_request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
    return { output: {} as T, usage: value };
  },
  async callWithTools(): Promise<LlmToolResponse> {
    throw new Error("道具付きの呼び出しは使わない");
  },
});

const request = (schemaName: string, model?: string): LlmStructuredRequest => ({
  instructions: "",
  documents: [],
  input: "",
  schemaName,
  schema: {},
  maxOutputTokens: 1,
  ...(model === undefined ? {} : { model }),
});

describe("段の表示名", () => {
  it("既知の schemaName は段の表示名に、未知・無しは「作業中」になる", () => {
    expect(stageLabelOf(NAME_TABLE_SCHEMA_NAME)).toBe("名前の表");
    expect(stageLabelOf(TEST_SPEC_SCHEMA_NAME)).toBe("試験");
    expect(stageLabelOf(DECL_CHECK_SCHEMA_NAME)).toBe("点検");
    expect(stageLabelOf("v12-unknown-stage")).toBe(UNKNOWN_STAGE_LABEL);
    expect(stageLabelOf(undefined)).toBe(UNKNOWN_STAGE_LABEL);
    expect(UNKNOWN_STAGE_LABEL).toBe("作業中");
  });
});

describe("進みの概算", () => {
  it("呼び出しごとに概算の額が増え、段の表示名が変わる", async () => {
    const progress: RunnerProgress[] = [];
    const tracker = createProgressTracker({ notify: (event) => progress.push(event) });
    const wrapped = tracker.wrap(clientWith(usage(1_000_000)));

    const first = await wrapped.callStructured(request(TEST_SPEC_SCHEMA_NAME));
    expect(first.usage).toEqual(usage(1_000_000));
    expect(progress.at(-1)?.stage).toBe("試験");
    expect(progress.at(-1)?.estimatedUsd).toBeCloseTo(0.1, 10);
    expect(tracker.estimatedUsd).toBeCloseTo(0.1, 10);
    expect(tracker.stage).toBe("試験");

    await wrapped.callStructured(request(NAME_TABLE_SCHEMA_NAME));
    expect(progress.at(-1)?.stage).toBe("名前の表");
    expect(progress.at(-1)?.estimatedUsd).toBeCloseTo(0.2, 10);

    await wrapped.callStructured(request("v12-unknown-stage"));
    expect(progress.at(-1)?.stage).toBe("作業中");
    expect(progress.at(-1)?.estimatedUsd).toBeCloseTo(0.3, 10);

    const estimates = progress.map((event) => event.estimatedUsd);
    for (let index = 1; index < estimates.length; index += 1) {
      expect(estimates[index] ?? 0).toBeGreaterThanOrEqual(estimates[index - 1] ?? 0);
    }
  });

  it("要求のモデルがあればその単価で数える", async () => {
    const progress: RunnerProgress[] = [];
    const tracker = createProgressTracker({ notify: (event) => progress.push(event) });
    const wrapped = tracker.wrap(clientWith(usage(1_000_000)));

    await wrapped.callStructured(request(TEST_SPEC_SCHEMA_NAME, "gpt-6.1-terra"));
    expect(tracker.estimatedUsd).toBeCloseTo(TERRA_RATES.inputPerToken * 1_000_000, 10);
    expect(progress.at(-1)?.estimatedUsd).toBeCloseTo(1, 10);

    const defaultTracker = createProgressTracker({ notify: () => {} });
    await defaultTracker.wrap(clientWith(usage(1_000_000))).callStructured(request(TEST_SPEC_SCHEMA_NAME));
    expect(defaultTracker.estimatedUsd).toBeCloseTo(modelRatesOf("").inputPerToken * 1_000_000, 10);
  });
});
