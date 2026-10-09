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
import { OpenAiIncompleteError, createOpenAiLlmClient, type OpenAiUsage } from "./openai.js";
import { runGeneration, countUnresolvedTests, type GenerationInput } from "./run.js";
import { createRecordingClient, expectNoAcceptanceMaterial } from "./stages/__tests__/prompt.js";
import {
  CORRESPONDENCE_OUTPUT,
  CORRESPONDENCE_OUTPUT_WITH_FIELD,
  DECLARATION_SOURCE,
  DESIGN_OUTPUT,
  DESIGN_OUTPUT_PARTIAL,
  INVALID_DECLARATION_SOURCE,
  RATES,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  SOURCE_TEXT,
  TEST_SUITE_OUTPUT,
  TEST_SUITE_OUTPUT_WITH_UNRESOLVED,
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

/** 道具付きの段（⑥）の「最後の答え」の記録（宣言は何でもよい） */
const toolDone = (declaration: unknown): RecordedCall => ({
  kind: "tools",
  response: { kind: "done", declaration, usage: undefined },
});

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
      expectNoAcceptanceMaterial([
        request.instructions,
        ...(request.rules ?? []),
        request.input,
        ...request.documents,
      ]);
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
    expect(result.stopped).toEqual({
      stage: "write",
      kind: "malformed",
      // ほかの段の「形が合わない」も、どの欄がどう合わなかったかを記録に出す（#304）
      problems: [{ field: "declaration", message: "宣言は空でない文字列（YAML の原文）であること" }],
    });
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

// ── 3b. ⑦ へ渡す未解決に、最終版の試験の未解決も数える（02 §1.4・#306）────

describe("⑦ へ渡す未解決の数（02 §1.4・#306）", () => {
  it("期待の裁定の未解決と試験の未解決が同じ試験 ID のときは、二重に数えない", () => {
    expect(
      countUnresolvedTests(["t1"], { mismatches: [], unresolved: [{ testId: "t1", detail: "未解決" }] }),
    ).toBe(1);
  });

  it("期待の裁定の未解決と試験の未解決が別の ID のときは、どちらも数える", () => {
    expect(
      countUnresolvedTests(["t1"], { mismatches: [], unresolved: [{ testId: "t2", detail: "未解決" }] }),
    ).toBe(2);
  });

  it("試験を流していないときは、期待の裁定の未解決だけを数える", () => {
    expect(countUnresolvedTests(["t1", "t2"], null)).toBe(2);
  });

  it("最終版の試験に未解決が 1 つだけ残ると、不一致と対応表の落ちが 0 でも部分案になる", async () => {
    const { run } = runWith(
      recordedRun({
        suite: TEST_SUITE_OUTPUT_WITH_UNRESOLVED,
        correspondence: CORRESPONDENCE_OUTPUT_WITH_FIELD,
      }),
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 0 } },
    );
    const result = await run;

    expect(result.stopped).toBeNull();
    // 未解決だけが残った版を合格（full）にしない（#306 の直す前は full になっていた）
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(result.record.failure).toBeNull();
    expect(result.summary.verdict).toBe("partial");

    // 試験の結果：不一致 0・対応表の落ち 0・未解決 1
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const verification = verificationOf(result.bundle);
    expect(verification.correspondence_misses).toBe(0);
    expect(verification.test_mismatches).toBe(0);
    expect(verification.test_unresolved).toBe(1);
    expect(verification.outcome).toEqual({ result: "partial", verdict: "partial" });
  });

  it("直しの往復の上限で止まり、未解決だけが残った版が合格（full）にならない", async () => {
    // 直しは 1 回だけ通り、直しても未解決が残るので、往復の上限（1 回）で止まる
    const { run } = runWith(
      [
        ...recordedRun({
          suite: TEST_SUITE_OUTPUT_WITH_UNRESOLVED,
          correspondence: CORRESPONDENCE_OUTPUT_WITH_FIELD,
        }),
        toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
      ],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 1 } },
    );
    const result = await run;

    expect(result.stopped).toBeNull();
    // 直しの段は上限の 1 回だけ通る（それ以上は回らない）
    const repairStages = result.record.stages.filter((stage) => stage.stage === "repair");
    expect(repairStages).toHaveLength(1);
    // 未解決が残ったままなので、合格にならない
    expect(result.outcome.result).not.toBe("pass");
    expect(result.outcome.verdict).toBe("partial");
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

  it("段ごとに、キャッシュの書き込みと読み取りのトークンを記録に出す（02 §1.5・§2・#302）", async () => {
    const cachedUsage: OpenAiUsage = {
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteTokens: 12,
      outputTokens: 20,
      reasoningTokens: 0,
    };
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
      // 読み取りと書き込みを分けて出す（#302）
      expect(record?.cached_input_tokens, stage).toBe(80);
      expect(record?.cache_write_tokens, stage).toBe(12);
    }
  });
});

// ── 呼び出しの誤りの種類が、段の失敗と記録に別々に出る（02 §2.2・S-7・#302）──

/** 記録した応答を順に返し、`failAfter` 回を超えると決まった誤りを返す偽物（実 API を呼ばない） */
function failingAfter(
  recorded: readonly RecordedCall[],
  failAfter: number,
  error: unknown,
): { readonly client: LlmClient } {
  const inner = createFakeLlmClient(recorded);
  let calls = 0;
  return {
    client: {
      async callStructured<T>(request: LlmStructuredRequest) {
        calls += 1;
        if (calls > failAfter) throw error;
        return inner.callStructured<T>(request);
      },
      async callWithTools(request: LlmToolRequest) {
        calls += 1;
        if (calls > failAfter) throw error;
        return inner.callWithTools(request);
      },
    },
  };
}

/** 誤りを作る（adapter が投げる形をまねる） */
const kindError = (kind: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`誤り（${kind}）`), { kind }, extra);

describe("呼び出しの誤りの種類が、段の失敗と記録に別々に出る（02 §2.2・S-7・#302）", () => {
  const cases: readonly { readonly name: string; readonly error: unknown; readonly kind: string }[] = [
    { name: "timeout", error: kindError("timeout"), kind: "timeout" },
    { name: "network", error: kindError("network"), kind: "network" },
    { name: "HTTP の 5xx", error: kindError("http", { status: 503 }), kind: "http" },
    { name: "balance", error: kindError("balance"), kind: "balance" },
    { name: "refusal", error: kindError("refusal"), kind: "refused" },
    { name: "分類できない例外", error: new Error("分類できない"), kind: "unknown" },
  ];

  for (const one of cases) {
    it(`${one.name} は、${one.kind} として段の失敗と記録に出る（拒否にしない）`, async () => {
      const failing = failingAfter(
        [structured(REQUIREMENT_LIST_OUTPUT), structured(REVERSE_CHECK_OUTPUT)],
        2,
        one.error,
      );
      const result = await runGeneration(
        makeRunInput(failing.client, { callTimeoutMs: 100, deadline: 100_000 }),
      );

      expect(result.stopped).toEqual({ stage: "design", kind: one.kind });
      expect(result.record.failure).toEqual({ stage: "design", kind: one.kind });
      expect(result.summary.stop_class).toBe(one.kind);
      const design = result.record.stages.find((stage) => stage.stage === "design");
      expect(design).toMatchObject({ status: "failed", failure_kind: one.kind });
    });
  }
});

// ── 要求そのものが不正な誤り（HTTP 400）は、拒否と分け、記録に種類だけを残す（02 §2.2・S-8）──

/** 完了した応答を手で書く（差し込む fetch 用） */
function completedResponse(output: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("要求そのものが不正な誤り（HTTP 400）は、拒否と分け、記録に種類だけを残す（02 §2.2・S-8）", () => {
  it("invalid_json_schema は、拒否ではなく段の失敗になり、やり直さず、本文の全文を記録に出さない", async () => {
    const bodySentinel = "BODY_SENTINEL: schema must have a 'type' key";
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) return completedResponse(REQUIREMENT_LIST_OUTPUT);
      if (calls === 2) return completedResponse(REVERSE_CHECK_OUTPUT);
      // 設計の段の要求が、schema の不正で断られた（疎通の確認で起きた形）
      return new Response(
        JSON.stringify({
          error: { message: bodySentinel, type: "invalid_request_error", code: "invalid_json_schema" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };
    const client = createOpenAiLlmClient({ apiKey: "test-key", fetch });
    const result = await runGeneration(makeRunInput(client));

    // 拒否と分け、同じ要求のままやり直さない（設計の段で 1 回だけ呼んで止まる）
    expect(calls).toBe(3);
    expect(result.stopped).toEqual({ stage: "design", kind: "invalid-request", code: "invalid_json_schema" });
    expect(result.bundle).toBeNull();
    expect(result.summary.stop_class).toBe("invalid-request");
    expect(result.record.failure).toEqual({
      stage: "design",
      kind: "invalid-request",
      code: "invalid_json_schema",
    });
    // 記録に、誤りの種類は出るが、本文の全文は出ない
    const recordText = JSON.stringify(result.record);
    expect(recordText).toContain("invalid_json_schema");
    expect(recordText).not.toContain("BODY_SENTINEL");
  });
});

// ── ⑥ の最後の答えの形が合わないと、欄の名前と種類が記録と要約に出る（02 §2.2・S-8・#304）──

describe("直す段の最後の答えの形が合わないとき、欄の名前と種類を記録と要約に出す（02 §2.2・S-8・#304）", () => {
  /** 直す役が最後の答えとして提案した宣言（記録に出てはならない値） */
  const REPAIR_DECLARATION_SENTINEL = "DECLARATION_SENTINEL_FROM_REPAIR";

  it("欄の名前と種類を出し、宣言の原文と依頼文は出さない", async () => {
    // 書いた宣言は R-1 の計算が 3 倍で、固定した試験（2 倍を期待）に落ちる → ⑥ へ入る
    const failingWrite = DECLARATION_SOURCE.replace("expression: amount * 2", "expression: amount * 3");
    // ⑥ の最後の答えは、宣言はあるが余分な欄（tests）を返すので形が合わない。2 回続く。
    const malformedAnswer = { declaration: REPAIR_DECLARATION_SENTINEL, tests: [] };
    const { run } = runWith([
      ...recordedRun({ write: failingWrite }),
      toolDone(malformedAnswer),
      toolDone(malformedAnswer),
    ]);
    const result = await run;

    // 止めた段と理由：⑥ の malformed
    expect(result.stopped?.stage).toBe("repair");
    expect(result.stopped?.kind).toBe("malformed");
    expect(result.bundle).toBeNull();

    // 記録と要約の失敗の欄に、欄の名前と種類が出る
    const failure = result.record.failure;
    expect(failure?.stage).toBe("repair");
    expect(failure?.kind).toBe("malformed");
    expect(failure?.problems?.map((problem) => problem.field)).toContain("tests");
    expect(failure?.problems?.[0]?.message).toContain("tests");
    expect(result.summary.failure).toEqual(failure);
    expect(result.summary.stop_class).toBe("malformed");

    // 値の中身（宣言の原文・依頼文）は、記録にも要約にも出ない
    for (const text of [JSON.stringify(result.record), JSON.stringify(result.summary)]) {
      expect(text).not.toContain(REPAIR_DECLARATION_SENTINEL);
      expect(text).not.toContain(SOURCE_TEXT);
    }
  });
});
