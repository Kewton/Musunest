// 段を順に回す部分（run.ts）の unit テスト（02 §1・§1.4・§1.5・§4）。
//
// ここで固定したいのは 5 つ。
//   1. **通常の完走**：偽物の LlmClient で合格と部分案の道を最後まで流し、逆照合（①'）・試験の固定（②'）・
//      対応表（⑤a）・試験を流す（⑤b）の段が必ず通ること（LLM の出力で段を飛ばさない）
//   2. **早期停止**：前半の段の失敗・依頼文の上限超え・残高切れ・締切切れ・呼び出しの数の超過で止まり、
//      止めた段と理由が記録されること
//   3. **未実行の検査**がある結果が、合格にならないこと
//   4. ⑧ の納品物が組まれ、検証の結果の SHA-256 が最後の宣言のバイト列と一致すること
//   5. 送った要求に、受入の題材の言葉が無いこと
import { acceptsHeadlessSummaryWire } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { costOfUsageUsd } from "./budget.js";
import { VERIFICATION_FILE, type BundleVerification } from "./bundle.js";
import { AGENT_LIMITS } from "./limits.js";
import { createFakeLlmClient, type RecordedCall } from "./llm-fake.js";
import type { LlmClient, LlmStructuredRequest, LlmToolRequest, LlmUsage } from "./llm.js";
import { OpenAiIncompleteError } from "./openai.js";
import { runGeneration, type GenerationInput } from "./run.js";
import { createRecordingClient, expectNoAcceptanceMaterial } from "./stages/__tests__/prompt.js";
import {
  CORRESPONDENCE_OUTPUT,
  DECLARATION_SOURCE,
  DESIGN_OUTPUT,
  DESIGN_OUTPUT_PARTIAL,
  INVALID_DECLARATION_SOURCE,
  RATES,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  TEST_SUITE_OUTPUT,
  makeRunInput,
  recordedRun,
  structured,
} from "./__tests__/run.js";

const runWith = (recorded: readonly RecordedCall[], overrides: Partial<GenerationInput> = {}) => {
  const recording = createRecordingClient(recorded);
  return { recording, run: runGeneration(makeRunInput(recording.client, overrides)) };
};

const verificationOf = (bundle: { artifacts: readonly { path: string; text: string }[] }): BundleVerification => {
  const found = bundle.artifacts.find((artifact) => artifact.path === VERIFICATION_FILE);
  if (found === undefined) throw new Error("検証の結果が無い");
  return JSON.parse(found.text) as BundleVerification;
};

// ── 1. 通常の完走 ────────────────────────────────────────────────

describe("通常の完走（02 §1）", () => {
  it("合格の道：最後まで流し、逆照合・試験の固定・対応表・試験を流す段が必ず通る", async () => {
    const { recording, run } = runWith(recordedRun());
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.record.failure).toBeNull();

    const stages = result.record.stages.map((stage) => stage.stage);
    for (const stage of [
      "reverse-check",
      "design",
      "test-suite",
      "write",
      "static-check",
      "correspondence",
      "run-tests",
      "judge",
    ]) {
      expect(stages, stage).toContain(stage);
    }
    // ①→①'→②→②'→③→⑤a の 6 回だけ呼ぶ（⑥ には入らない）
    expect(recording.structured).toHaveLength(6);
    for (const request of recording.structured) {
      expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents]);
    }

    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const expected = await sha256Hex(DECLARATION_SOURCE);
    expect(result.bundle.declarationSha256).toBe(expected);
    expect(verificationOf(result.bundle).declaration_sha256).toBe(expected);
    expect(acceptsHeadlessSummaryWire(result.summary)).toBe(true);
    expect(result.summary.verdict).toBe("full");
    expect(result.summary.spec_engine_version).toBe("0.0.0");
    expect(result.summary.factory_version).toBe("0.0.0");
  });

  it("部分案の道：書けない要件があるまま最後まで流し、部分案になる", async () => {
    const { run } = runWith(recordedRun({ design: DESIGN_OUTPUT_PARTIAL }));
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(result.bundle).not.toBeNull();
    expect(acceptsHeadlessSummaryWire(result.summary)).toBe(true);
    // 書けない要件があっても、書ける要件の段は全部通る
    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages).toContain("correspondence");
    expect(stages).toContain("run-tests");
  });
});

// ── 2. 早期停止 ──────────────────────────────────────────────────

describe("早期停止：止めた段と理由が記録される（02 §1.5・S-7）", () => {
  it("依頼文の上限超え（① の入口）", async () => {
    const { run } = runWith([], { source: "あ".repeat(AGENT_LIMITS.requestTextChars + 1) });
    const result = await run;
    expect(result.stopped).toEqual({ stage: "requirements", kind: "limit" });
    expect(result.bundle).toBeNull();
    expect(result.record.failure).toEqual({ stage: "requirements", kind: "limit" });
    expect(result.record.stages.at(-1)).toMatchObject({
      stage: "requirements",
      status: "failed",
      failure_kind: "limit",
    });
  });

  it("予約の残高切れ", async () => {
    const { run } = runWith([structured(REQUIREMENT_LIST_OUTPUT)], { budgetUsd: 0 });
    const result = await run;
    expect(result.stopped?.kind).toBe("budget");
    expect(result.bundle).toBeNull();
  });

  it("締切切れ", async () => {
    const { run } = runWith([structured(REQUIREMENT_LIST_OUTPUT)], { now: () => 0, deadline: 0 });
    const result = await run;
    expect(result.stopped?.kind).toBe("deadline");
  });

  it("呼び出しの数の超過", async () => {
    const { run } = runWith([structured(REQUIREMENT_LIST_OUTPUT)], {
      limits: { ...AGENT_LIMITS, callCount: 1 },
    });
    const result = await run;
    expect(result.stopped?.kind).toBe("call-limit");
  });

  it("前半の段の失敗（③ が形の合わない応答を返し続ける）", async () => {
    const malformed = { declaration: 123 };
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(DESIGN_OUTPUT),
      structured(TEST_SUITE_OUTPUT),
      structured(malformed),
      structured(malformed),
    ]);
    const result = await run;
    expect(result.stopped).toEqual({ stage: "write", kind: "malformed" });
    expect(result.record.stages.at(-1)).toMatchObject({
      stage: "write",
      status: "failed",
      failure_kind: "malformed",
    });
  });
});

// ── 3. 未実行の検査は合格にしない ────────────────────────────────

describe("未実行の検査がある結果は、合格にならない（02 §1.4）", () => {
  it("④ を通らない宣言のまま止まると、失敗になり、⑤a・⑤b は実行しない", async () => {
    const { run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(DESIGN_OUTPUT),
        structured(TEST_SUITE_OUTPUT),
        structured({ declaration: INVALID_DECLARATION_SOURCE }),
      ],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 0 } },
    );
    const result = await run;

    expect(result.outcome.result).toBe("failed");
    expect(result.record.failure).toEqual({ stage: "static-check", kind: "incomplete" });
    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages).toContain("static-check");
    expect(stages).not.toContain("correspondence");
    expect(stages).not.toContain("run-tests");
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    expect(verificationOf(result.bundle).unexecuted_inspections).toEqual(["correspondence", "run-tests"]);
    expect(acceptsHeadlessSummaryWire(result.summary)).toBe(true);
    expect(result.summary.verdict).toBe("none");
  });
});

// ── 4. 未完了の応答の段の失敗と精算（02 §2.2・§1.5）────────────────

/** 記録した応答を順に返し、`failAfter` 回を超えると未完了の誤りを返す偽物（実 API を呼ばない） */
function incompleteAfter(
  recorded: readonly RecordedCall[],
  failAfter: number,
  usage: LlmUsage | undefined,
): { readonly client: LlmClient; calls: () => number } {
  const inner = createFakeLlmClient(recorded);
  let calls = 0;
  const fail = (): never => {
    throw new OpenAiIncompleteError("max_output_tokens", usage, "応答が完了していません（reason=max_output_tokens）");
  };
  return {
    client: {
      async callStructured<T>(request: LlmStructuredRequest) {
        calls += 1;
        if (calls > failAfter) return fail();
        return inner.callStructured<T>(request);
      },
      async callWithTools(request: LlmToolRequest) {
        calls += 1;
        if (calls > failAfter) return fail();
        return inner.callWithTools(request);
      },
    },
    calls: () => calls,
  };
}

const noUsageCall = (output: unknown): RecordedCall => ({ kind: "structured", output, usage: undefined });

describe("未完了の応答の段の失敗と精算（02 §2.2・§1.5）", () => {
  it("usage 付きの未完了の応答は、拒否ではなく段の失敗になり、精算されて記録と費用に入る", async () => {
    const usage: LlmUsage = { inputTokens: 200, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 40 };
    const failing = incompleteAfter([noUsageCall(REQUIREMENT_LIST_OUTPUT), noUsageCall(REVERSE_CHECK_OUTPUT)], 2, usage);
    const input = makeRunInput(failing.client);
    const result = await runGeneration(input);

    expect(result.stopped).toEqual({ stage: "design", kind: "incomplete" });
    expect(result.bundle).toBeNull();
    expect(result.summary.stop_class).toBe("incomplete");

    const design = result.record.stages.find((stage) => stage.stage === "design");
    expect(design).toMatchObject({
      status: "failed",
      calls: 1,
      missing_usage_calls: 0,
      failure_kind: "incomplete",
    });
    expect(design?.output_tokens).toBe(100);
    // 精算されて、要約の費用に入る（この走りでは、usage 付きは未完了の 1 回だけ）
    expect(result.summary.provider_cost_usd).toBeCloseTo(costOfUsageUsd(usage, RATES), 12);
    // 同じ要求のままやり直さない（設計の段は 1 回だけ。① と ①' で 2 回、合わせて 3 回）
    expect(failing.calls()).toBe(3);
  });

  it("usage の無い未完了の応答では、予約が残る", async () => {
    const failing = incompleteAfter([noUsageCall(REQUIREMENT_LIST_OUTPUT), noUsageCall(REVERSE_CHECK_OUTPUT)], 2, undefined);
    const input = makeRunInput(failing.client);
    const result = await runGeneration(input);

    expect(result.stopped).toEqual({ stage: "design", kind: "incomplete" });
    const design = result.record.stages.find((stage) => stage.stage === "design");
    expect(design).toMatchObject({ calls: 1, missing_usage_calls: 1, failure_kind: "incomplete" });
    // 精算しないので費用は 0。予約は残るので、残高は上限より小さい（戻らない）
    expect(result.summary.provider_cost_usd).toBe(0);
    expect(result.summary.budget_remaining_usd).toBeLessThan(input.budgetUsd);
  });

  it("段ごとに、キャッシュに当たった入力のトークンを記録に出す（02 §1.5・§2）", async () => {
    const cachedUsage: LlmUsage = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningTokens: 0 };
    const cached: readonly RecordedCall[] = [
      structured(REQUIREMENT_LIST_OUTPUT, cachedUsage),
      structured(REVERSE_CHECK_OUTPUT, cachedUsage),
      structured(DESIGN_OUTPUT, cachedUsage),
      structured(TEST_SUITE_OUTPUT, cachedUsage),
      structured({ declaration: DECLARATION_SOURCE }, cachedUsage),
      structured(CORRESPONDENCE_OUTPUT, cachedUsage),
    ];
    const result = await runGeneration(makeRunInput(createRecordingClient(cached).client));

    for (const stage of ["design", "write"] as const) {
      const record = result.record.stages.find((candidate) => candidate.stage === stage);
      expect(record?.cached_input_tokens, stage).toBe(80);
    }
  });
});
