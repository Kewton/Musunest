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
import { acceptsHeadlessSummaryWire, planDigest } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { costOfUsageUsd } from "./budget.js";
import { ARBITRATION_FILE, UNWRITABLE_FILE, VERIFICATION_FILE, type BundlePartialReasons, type BundleUnwritable, type BundleVerification } from "./bundle.js";
import { AGENT_LIMITS } from "./limits.js";
import { createFakeJudge } from "./judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest, JudgeResponse } from "./judge.js";
import { createFakeLlmClient, type RecordedCall } from "./llm-fake.js";
import type { LlmClient, LlmStructuredRequest, LlmToolRequest, LlmUsage } from "./llm.js";
import { OpenAiIncompleteError, createOpenAiLlmClient, type OpenAiUsage } from "./openai.js";
import { runGeneration, countUnresolvedTests, type GenerationInput } from "./run.js";
import { MAPPING_REDO_SCHEMA_NAME } from "./stages/repair.js";
import { ARBITRATION_SCHEMA_NAME } from "./stages/arbitrate.js";
import { CORRESPONDENCE_SCHEMA_NAME } from "./stages/correspondence.js";
import { REVERSE_CHECK_SCHEMA_NAME } from "./stages/reverse-check.js";
import { REQUIREMENTS_SCHEMA_NAME } from "./stages/requirements.js";
import { DESIGN_SCHEMA_NAME } from "./stages/design.js";
import { NATURE_JUDGE_THRESHOLD_VERSION, TEST_SUITE_SCHEMA_NAME, natureQuestionName } from "./stages/test-suite.js";
import { WRITE_SCHEMA_NAME } from "./stages/write.js";
import { createRecordingClient, expectNoAcceptanceMaterial } from "./stages/__tests__/prompt.js";
import {
  ADDED_OPEN_ISSUE_TEXT,
  ADDED_QUESTION_TEXT,
  BAD_MAPPINGS,
  CONFIRMED_PLAN,
  CONFIRMED_PLAN_ACCEPTED,
  CONFIRMED_PLAN_ADDED,
  CORRESPONDENCE_OUTPUT,
  CORRESPONDENCE_OUTPUT_WITH_FIELD,
  DECLARATION_SOURCE,
  DECLARATION_SOURCE_FOUR,
  DECLARATION_SOURCE_MISMATCH,
  DESIGN_OUTPUT,
  DESIGN_OUTPUT_MAPPED,
  DESIGN_OUTPUT_PARTIAL,
  INVALID_DECLARATION_SOURCE,
  MAPPING_REDO_OUTPUT,
  RATES,
  REQUIREMENT_LIST_OUTPUT,
  REVERSE_CHECK_OUTPUT,
  SOURCE_TEXT,
  SOURCE_TEXT_FOUR,
  TEST_SUITE_OUTPUT,
  TEST_SUITE_OUTPUT_MAPPED,
  TEST_SUITE_OUTPUT_WITH_UNRESOLVED,
  makeRunInput,
  recordedRun,
  recordedRunFour,
  recordedRunFromPlan,
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

/**
 * 構造化出力の記録を、全段で同じ「封筒」の形にする（#353）。adapter は封筒の `result` を取り出し、
 * `stage` がその段でなければ形の誤りにする。偽物（llm-fake.ts）も、本物の adapter と同じように
 * 封筒をほどく——**封筒の有無にかかわらず、段の試験は今までどおり通る**（#353「守ること」）。
 */
const enveloped = (stage: string, output: Record<string, unknown>): Record<string, unknown> => ({
  result: { stage, ...output },
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

  it("記録が全段同じ封筒の形（result で包んだもの）でも、合格の道は同じように流れる（#353）", async () => {
    const { run } = runWith([
      structured(enveloped(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_OUTPUT)),
      structured(enveloped(REVERSE_CHECK_SCHEMA_NAME, REVERSE_CHECK_OUTPUT)),
      structured(enveloped(DESIGN_SCHEMA_NAME, DESIGN_OUTPUT)),
      structured(enveloped(TEST_SUITE_SCHEMA_NAME, TEST_SUITE_OUTPUT)),
      structured(enveloped(WRITE_SCHEMA_NAME, { declaration: DECLARATION_SOURCE })),
      structured(enveloped(CORRESPONDENCE_SCHEMA_NAME, CORRESPONDENCE_OUTPUT)),
    ]);
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
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
      if (calls === 1) return completedResponse(enveloped(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_OUTPUT));
      if (calls === 2) return completedResponse(enveloped(REVERSE_CHECK_SCHEMA_NAME, REVERSE_CHECK_OUTPUT));
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

// ── 停滞の検知・裁定の呼び分け（02 §1.3.1・#309）──────────────────────

describe("停滞の検知：同じ不一致が続いたら ⑥ は止める（02 §1.3.1・#309）", () => {
  it("同じ不一致が 2 回続いたら直す段を止め、未解決として部分案で終える（裁定へは回さない）", async () => {
    // 未解決（曖昧さ）が残る版。⑥ は直しても同じ宣言を返すので、不一致は変わらない
    const { recording, run } = runWith([
      ...recordedRun({
        suite: TEST_SUITE_OUTPUT_WITH_UNRESOLVED,
        correspondence: CORRESPONDENCE_OUTPUT_WITH_FIELD,
      }),
      toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
    ]);
    const result = await run;

    expect(result.stopped).toBeNull();
    // 未解決だけが残ったので、合格（full）ではなく部分案
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    // 止めた理由（停滞）が記録に出る
    expect(result.summary.stop_reason).toBe("stagnation");
    // ⑥ は 1 回だけ（同じ不一致が 2 回続いた時点で止まる。往復の上限 6 までは回らない）
    expect(result.record.stages.filter((stage) => stage.stage === "repair")).toHaveLength(1);
    // 停滞だけを理由に、期待の裁定（⑥'）へは回さない
    expect(result.record.stages.map((stage) => stage.stage)).not.toContain("arbitration");
    expect(recording.structured.every((request) => request.schemaName !== ARBITRATION_SCHEMA_NAME)).toBe(true);
  });

  it("原文の根拠つきの異議があるときだけ、期待の裁定（⑥'）を呼ぶ", async () => {
    const { recording, run } = runWith([
      ...recordedRun({ write: DECLARATION_SOURCE_MISMATCH }),
      toolDone({
        declaration: DECLARATION_SOURCE_MISMATCH,
        disputes: [
          { testId: "t1", quote: "件数を合計する" },
          { testId: "t2", quote: "件数を合計する" },
          { testId: "t3", quote: "件数を合計する" },
        ],
      }),
      structured({
        decisions: [
          { testId: "t1", verdict: "overturn", reason: "原文の数え方が違う", quote: "件数を合計する" },
          { testId: "t2", verdict: "overturn", reason: "原文の数え方が違う", quote: "件数を合計する" },
          { testId: "t3", verdict: "overturn", reason: "原文の数え方が違う", quote: "件数を合計する" },
        ],
      }),
    ]);
    const result = await run;

    expect(result.record.stages.map((stage) => stage.stage)).toContain("arbitration");
    expect(recording.structured.some((request) => request.schemaName === ARBITRATION_SCHEMA_NAME)).toBe(true);
    // 棄却された試験を外すと、残り（R-2）は満たして合格する
    expect(result.record.arbitration.overturned).toBe(3);
    expect(result.outcome.result).toBe("pass");
  });
});

// ── 失敗の振り分け（02 §1.3.1・#309）────────────────────────────────

describe("失敗の行き先で次の一手が変わる（02 §1.3.1・#309）", () => {
  it("対応の表の不備は ③ のやり直しに回り、その上限で止まる（⑥ ではない）", async () => {
    const { recording, run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(DESIGN_OUTPUT_MAPPED),
        structured(TEST_SUITE_OUTPUT_MAPPED),
        structured({ declaration: DECLARATION_SOURCE, mappings: BAD_MAPPINGS }),
        structured(CORRESPONDENCE_OUTPUT),
        structured(MAPPING_REDO_OUTPUT), // ③ のやり直し（同じ不備を出し直す）
      ],
      { limits: { ...AGENT_LIMITS, correspondenceRedos: 1, stagnationRepeats: 0 } },
    );
    const result = await run;

    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages).toContain("write"); // ③ のやり直し
    expect(stages).not.toContain("repair"); // ⑥ 直すではない
    expect(recording.structured.at(-1)?.schemaName).toBe(MAPPING_REDO_SCHEMA_NAME);
    expect(result.summary.stop_reason).toBe("limit");
  });

  it("要件に要る要素の欠落は ⑥ 直すに回り、往復の上限で止まる", async () => {
    const { recording, run } = runWith(
      [
        ...recordedRun({ write: DECLARATION_SOURCE_MISMATCH }),
        toolDone({ declaration: DECLARATION_SOURCE_MISMATCH, disputes: [] }),
      ],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 1, stagnationRepeats: 0 } },
    );
    const result = await run;

    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages).toContain("repair"); // ⑥ 直す
    // ③ のやり直しへは回さない
    expect(recording.structured.every((request) => request.schemaName !== MAPPING_REDO_SCHEMA_NAME)).toBe(true);
    expect(result.summary.stop_reason).toBe("limit");
  });
});

// ── 版の整合（02 §1.3.1・#309）──────────────────────────────────────

describe("宣言が変わったら、古い版の対応・結び付け・試験の結果を使わない（02 §1.3.1・#309）", () => {
  it("新しい版で ⑤a を作り直し、納品物は最後の版に結び付く", async () => {
    const { recording, run } = runWith([
      ...recordedRun({ write: DECLARATION_SOURCE_MISMATCH }),
      toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
      structured(CORRESPONDENCE_OUTPUT), // ⑤a の作り直し（新しい版）
    ]);
    const result = await run;

    expect(result.outcome.result).toBe("pass");
    // ⑤a は、最初の版と直した版の 2 回呼ぶ（同じ版なら使い回す）
    expect(result.record.stages.filter((stage) => stage.stage === "correspondence")).toHaveLength(2);
    expect(recording.structured.at(-1)?.schemaName).toBe(CORRESPONDENCE_SCHEMA_NAME);
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    expect(result.bundle.declarationSha256).toBe(await sha256Hex(DECLARATION_SOURCE));
  });
});

// ── 予算・記録（02 §1.5・#309）─────────────────────────────────────

describe("新しい呼び出しも予算と上限に入り、段ごとの所要と止めた理由が出る（02 §1.5・#309）", () => {
  it("⑤a の作り直しの呼び出しも、総呼び出しの上限に数えられる", async () => {
    const { run } = runWith(
      [
        ...recordedRun({ write: DECLARATION_SOURCE_MISMATCH }),
        toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
        // ⑤a の作り直しは呼ばれない（先に総呼び出しの上限で止まる）
      ],
      { limits: { ...AGENT_LIMITS, callCount: 7 } },
    );
    const result = await run;

    expect(result.stopped).toEqual({ stage: "correspondence", kind: "call-limit" });
    expect(result.summary.stop_reason).toBe("call-limit");
    expect(result.bundle).toBeNull();
  });

  it("段ごとの所要（時間・呼び出しの数）と、止めた理由が記録に出る", async () => {
    const { run } = runWith(recordedRun());
    const result = await run;

    expect(result.summary.stop_reason).toBe("completed");
    const write = result.record.stages.find((stage) => stage.stage === "write");
    expect(write?.calls).toBe(1);
    expect(typeof write?.duration_ms).toBe("number");
    for (const stage of result.record.stages) {
      expect(typeof stage.duration_ms).toBe("number");
      expect(stage.calls).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── 裁定で外した試験を除いた組でも、分類を保つ（02 §1・②'・Issue #322）──────

const CREATE_CLOCK = "2026-09-16T12:00:00+09:00";

/** 在ることだけの要件の create の操作と、決まりを含む要件の計算を持つ宣言（抽象的な題材） */
const CREATE_DECLARATION = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      amount: number",
  "views:",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [total]",
  "actions:",
  "  - name: add",
  "    entity: record",
  "    kind: create",
  "validations: []",
  "computed:",
  "  - name: total",
  "    entity: record",
  "    expression: amount * 2",
  "    type: number",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** ② の設計（R-1 は在ることだけ、R-2 は決まりを含む） */
const CREATE_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
    { roleId: "record.add", kind: "operation", entity: "record", name: "add", shared: false, aliasOf: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "existence-only",
      verification: { kind: "structural", reason: "登録できることを構造で確かめる" },
      vocabulary: ["entity", "action"],
      placement: ["entities", "actions"],
      unwritable: [],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["computation"],
      placement: ["computed"],
      unwritable: [],
    },
  ],
};

/** ②' の答え（R-1 の create は構造の確認。R-2 の異常の期待が誤りで、裁定で棄却される） */
const CREATE_SUITE = {
  classifications: [
    { requirementId: "R-1", nature: "existence-only" },
    { requirementId: "R-2", nature: "ruled" },
  ],
  tests: [
    {
      id: "create",
      target: { requirementId: "R-1", kind: "operation", roleId: "record.add" },
      kind: "normal",
      operation: "action",
      clock: CREATE_CLOCK,
      input: {},
      inputContract: { rowId: "create-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: null },
    },
    {
      id: "n",
      target: { requirementId: "R-2", kind: "computation", roleId: "record.total" },
      kind: "normal",
      operation: "compute",
      clock: CREATE_CLOCK,
      input: { amount: 21 },
      inputContract: { rowId: "n-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: 42 },
    },
    {
      id: "a",
      target: { requirementId: "R-2", kind: "computation", roleId: "record.total" },
      kind: "abnormal",
      operation: "compute",
      clock: CREATE_CLOCK,
      input: { amount: 21 },
      inputContract: { rowId: "a-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: 100 },
    },
    {
      id: "b",
      target: { requirementId: "R-2", kind: "computation", roleId: "record.total" },
      kind: "boundary",
      operation: "compute",
      clock: CREATE_CLOCK,
      input: { amount: 21 },
      inputContract: { rowId: "b-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: 42 },
    },
  ],
};

/** ③ が提出する対応（役割 ID → 宣言の名前） */
const CREATE_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.add", name: "add" },
  { roleId: "record.total", name: "total" },
];

/** ⑤a の答え（実在して画面から辿れる場所だけを挙げる） */
const CREATE_CORRESPONDENCE = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "action", entity: "record", name: "add" },
      ],
    },
    { requirementId: "R-2", locations: [{ kind: "computation", entity: "record", name: "total" }] },
  ],
};

describe("裁定で外した試験を除いた組でも、分類を保つ（02 §1・②'・Issue #322）", () => {
  it("棄却で外した後も、在ることだけの要件の create の試験が構造の確認で通る", async () => {
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(CREATE_DESIGN),
      structured(CREATE_SUITE),
      structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
      structured(CREATE_CORRESPONDENCE),
      // ⑥ 直す：期待が誤りの主張（原文の引用つき）だけを返し、宣言は変えない
      toolDone({ declaration: CREATE_DECLARATION, disputes: [{ testId: "a", quote: "件数を合計する" }] }),
      structured({
        decisions: [{ testId: "a", verdict: "overturn", reason: "原文のとおり", quote: "件数を合計する" }],
      }),
    ]);
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.record.arbitration.overturned).toBe(1);
    // 棄却で外した後も、在ることだけの create の試験は未解決にならず、構造の確認で通る（分類が保たれる）。
    // 分類を落とすと（#322 の直す前）、全要件が「決まりを含む」になり 3 本が未解決になって部分案になる
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });
});

// ── 構造の要件を含む生成は、合格（full）にならない（02 §1.4・Issue #386）──────

/** ② の設計（R-1 は構造で確かめる（checks 付き）、R-2 は固定した試験） */
const STRUCTURAL_CHECKS_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
    { roleId: "record.add", kind: "operation", entity: "record", name: "add", shared: false, aliasOf: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "existence-only",
      verification: { kind: "structural", reason: "登録を構造で確かめる" },
      checks: ["action-kind"],
      vocabulary: ["action"],
      placement: ["actions"],
      unwritable: [],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      checks: [],
      vocabulary: ["computation"],
      placement: ["computed"],
      unwritable: [],
    },
  ],
};

/** ②' の答え（R-1 は構造の検査 1 本、R-2 は計算の正常・異常・境界） */
const STRUCTURAL_CHECKS_SUITE = {
  classifications: [
    { requirementId: "R-1", nature: "existence-only" },
    { requirementId: "R-2", nature: "ruled" },
  ],
  tests: [
    {
      id: "sc",
      target: { requirementId: "R-1", kind: "operation", roleId: "record.add" },
      kind: "normal",
      operation: "structure",
      clock: CREATE_CLOCK,
      input: {},
      inputContract: { rowId: "sc-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: true },
      assertion: { check: "action-kind", expected: "create" },
    },
    {
      id: "n",
      target: { requirementId: "R-2", kind: "computation", roleId: "record.total" },
      kind: "normal",
      operation: "compute",
      clock: CREATE_CLOCK,
      input: { amount: 21 },
      inputContract: { rowId: "n-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: 42 },
    },
    {
      id: "a",
      target: { requirementId: "R-2", kind: "computation", roleId: "record.total" },
      kind: "abnormal",
      operation: "compute",
      clock: CREATE_CLOCK,
      input: { amount: 21 },
      inputContract: { rowId: "a-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: 42 },
    },
    {
      id: "b",
      target: { requirementId: "R-2", kind: "computation", roleId: "record.total" },
      kind: "boundary",
      operation: "compute",
      clock: CREATE_CLOCK,
      input: { amount: 21 },
      inputContract: { rowId: "b-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: 42 },
    },
  ],
};

// ── 構造の要件を含む生成：検査を実行し、判定と照合の記録に入れる（02 §1.4・Issue #387）──────

/** ③ が直した宣言（R-1 の create の操作を update に変える） */
const CREATE_DECLARATION_UPDATED = CREATE_DECLARATION.replace("kind: create", "kind: update");

/** ②' の答え（R-1 の構造の検査が update を期待するので、直す前は成り立たない） */
const STRUCTURAL_CHECKS_SUITE_UPDATE = {
  classifications: STRUCTURAL_CHECKS_SUITE.classifications,
  tests: STRUCTURAL_CHECKS_SUITE.tests.map((test) =>
    test.id === "sc" ? { ...test, assertion: { check: "action-kind", expected: "update" } } : test,
  ),
};

/** ②' の答え（R-2 の異常の試験を、評価器で確かめられない試験に差し替える＝未解決が残る） */
const STRUCTURAL_CHECKS_SUITE_UNRESOLVED = {
  classifications: STRUCTURAL_CHECKS_SUITE.classifications,
  tests: STRUCTURAL_CHECKS_SUITE.tests.map((test) =>
    test.id === "a" ? { ...test, operation: "action", expected: { kind: "ok", value: null } } : test,
  ),
};

describe("構造の要件を含む生成（02 §1.4・Issue #387）", () => {
  it("構造の検査がすべて成り立ち、ほかの試験と対応表に落ちが無ければ合格（full）になる", async () => {
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(STRUCTURAL_CHECKS_DESIGN),
      structured(STRUCTURAL_CHECKS_SUITE),
      structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
      structured(CREATE_CORRESPONDENCE),
    ]);
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    if (result.bundle === null) throw new Error("納品物が無い");
    const verification = verificationOf(result.bundle);
    expect(verification.test_mismatches).toBe(0);
    expect(verification.test_unresolved).toBe(0);
    // 構造の検査の記録が、照合の記録に入る（合格）
    expect(verification.structural_checks).toEqual([
      { test_id: "sc", requirement_id: "R-1", check: "action-kind", result: "pass", detail: expect.any(String) },
    ]);
  });

  it("構造の検査が 1 本でも成り立たなければ、合格にならない", async () => {
    const { run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(STRUCTURAL_CHECKS_DESIGN),
        structured(STRUCTURAL_CHECKS_SUITE_UPDATE),
        structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
        structured(CREATE_CORRESPONDENCE),
      ],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 0 } },
    );
    const result = await run;

    // 成り立たない構造の検査は不一致として数えられ、合格（pass）にしない
    expect(result.outcome.result).not.toBe("pass");
    if (result.bundle === null) throw new Error("納品物が無い");
    const verification = verificationOf(result.bundle);
    expect(verification.test_mismatches).toBeGreaterThanOrEqual(1);
    expect(verification.structural_checks).toEqual([
      { test_id: "sc", requirement_id: "R-1", check: "action-kind", result: "mismatch", detail: expect.any(String) },
    ]);
  });

  it("直す段で宣言が変わったとき、最終の宣言に対して構造の検査を実行し直す", async () => {
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(STRUCTURAL_CHECKS_DESIGN),
      structured(STRUCTURAL_CHECKS_SUITE_UPDATE),
      structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
      structured(CREATE_CORRESPONDENCE),
      // ⑥ 直す：create の操作を update に変えて、構造の検査が成り立つようにする
      toolDone({ declaration: CREATE_DECLARATION_UPDATED, disputes: [] }),
      // 宣言が変わったので、⑤a を作り直す
      structured(CREATE_CORRESPONDENCE),
    ]);
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    if (result.bundle === null) throw new Error("納品物が無い");
    // 納品物は最後の宣言（直した版）に結び付き、構造の検査もその版で実行し直されている（合格）
    expect(result.bundle.declarationSha256).toBe(await sha256Hex(CREATE_DECLARATION_UPDATED));
    expect(verificationOf(result.bundle).structural_checks).toEqual([
      { test_id: "sc", requirement_id: "R-1", check: "action-kind", result: "pass", detail: expect.any(String) },
    ]);
  });

  it("構造の検査が成り立っても、ほかの試験の未解決は残る", async () => {
    const { run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(STRUCTURAL_CHECKS_DESIGN),
        structured(STRUCTURAL_CHECKS_SUITE_UNRESOLVED),
        structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
        structured(CREATE_CORRESPONDENCE),
      ],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 0 } },
    );
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    if (result.bundle === null) throw new Error("納品物が無い");
    const verification = verificationOf(result.bundle);
    // 構造の検査は成り立っている（合格）が、ほかの試験の未解決は残る
    expect(verification.structural_checks).toEqual([
      { test_id: "sc", requirement_id: "R-1", check: "action-kind", result: "pass", detail: expect.any(String) },
    ]);
    expect(verification.test_unresolved).toBeGreaterThanOrEqual(1);
  });
});

// ── 構造で確かめる要件には、構造の検査だけを固定する（02 §1.4・Issue #392）──────────

/** ②' の答え（R-1 の構造の検査に、外される実行の試験を混ぜる。`xe` の期待はわざと違える） */
const STRUCTURAL_CHECKS_SUITE_WITH_EXECUTION = {
  classifications: STRUCTURAL_CHECKS_SUITE.classifications,
  tests: [
    STRUCTURAL_CHECKS_SUITE.tests[0]!, // sc（構造の検査）
    {
      id: "xe",
      target: { requirementId: "R-1", kind: "computation", roleId: "record.total" },
      kind: "normal",
      operation: "compute",
      clock: CREATE_CLOCK,
      input: { amount: 21 },
      inputContract: { rowId: "xe-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      // 外さなければ一致しない期待（外したことを、合格で示す）
      expected: { kind: "ok", value: 999 },
    },
    {
      id: "xa",
      target: { requirementId: "R-1", kind: "operation", roleId: "record.add" },
      kind: "normal",
      operation: "action",
      clock: CREATE_CLOCK,
      input: {},
      inputContract: { rowId: "xa-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: null },
    },
    ...STRUCTURAL_CHECKS_SUITE.tests.slice(1), // R-2 の n・a・b
  ],
};

/** R-2 の境界の試験を、外されない集計の値の試験にして、期待を違える（Issue #392） */
const STRUCTURAL_CHECKS_SUITE_WITH_AGGREGATE_MISMATCH = {
  classifications: STRUCTURAL_CHECKS_SUITE_WITH_EXECUTION.classifications,
  tests: STRUCTURAL_CHECKS_SUITE_WITH_EXECUTION.tests.map((test) =>
    test.id === "b" ? { ...test, operation: "aggregate", expected: { kind: "ok", value: 999 } } : test,
  ),
};

/** ②' の答え（R-2 の試験が欠けたまま。②' 自体が最後に失敗する。外す対象は残っている） */
const STRUCTURAL_CHECKS_SUITE_INCOMPLETE = {
  classifications: STRUCTURAL_CHECKS_SUITE.classifications,
  tests: [
    STRUCTURAL_CHECKS_SUITE.tests[0]!, // sc
    STRUCTURAL_CHECKS_SUITE_WITH_EXECUTION.tests[1]!, // xe（外される）
    STRUCTURAL_CHECKS_SUITE.tests[1]!, // R-2 の n だけ（異常・境界が無い）
  ],
};

/** ④ を通らない宣言（`STRUCTURAL_CHECKS_DESIGN` に対する宣言・対応）を流す記録の後ろ 3 段 */
const structuralRunTail = (): readonly RecordedCall[] => [
  structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
  structured(CREATE_CORRESPONDENCE),
];

const structuralRun = (suite: unknown): readonly RecordedCall[] => [
  structured(REQUIREMENT_LIST_OUTPUT),
  structured(REVERSE_CHECK_OUTPUT),
  structured(STRUCTURAL_CHECKS_DESIGN),
  structured(suite),
  ...structuralRunTail(),
];

const DROPPED_EXECUTION_SUMMARY = { count: 2, by_operation: { compute: 1, action: 1 } };

describe("構造で確かめる要件には、構造の検査だけを固定する（02 §1.4・Issue #392）", () => {
  it("実行の試験が混ざっていても、構造の検査が成り立てば合格になり、要約に外した件数が出る", async () => {
    const { run } = runWith(structuralRun(STRUCTURAL_CHECKS_SUITE_WITH_EXECUTION));
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    // 外した件数（回ごとに数えた合計と、操作ごとの内訳）
    expect(result.summary.dropped_nonstructural_tests).toEqual(DROPPED_EXECUTION_SUMMARY);
    if (result.bundle === null) throw new Error("納品物が無い");
    const verification = verificationOf(result.bundle);
    expect(verification.test_mismatches).toBe(0);
    expect(verification.structural_checks).toEqual([
      { test_id: "sc", requirement_id: "R-1", check: "action-kind", result: "pass", detail: expect.any(String) },
    ]);
  });

  it("構造の検査が 1 本でも成り立たなければ、合格にならず、外した件数は残る", async () => {
    const suite = {
      classifications: STRUCTURAL_CHECKS_SUITE.classifications,
      tests: STRUCTURAL_CHECKS_SUITE_WITH_EXECUTION.tests.map((test) =>
        test.id === "sc" ? { ...test, assertion: { check: "action-kind", expected: "update" } } : test,
      ),
    };
    const { run } = runWith(structuralRun(suite), { limits: { ...AGENT_LIMITS, repairRoundTrips: 0 } });
    const result = await run;

    expect(result.outcome.result).not.toBe("pass");
    if (result.bundle === null) throw new Error("納品物が無い");
    const verification = verificationOf(result.bundle);
    expect(verification.structural_checks[0]).toMatchObject({ test_id: "sc", result: "mismatch" });
    expect(result.summary.dropped_nonstructural_tests).toEqual(DROPPED_EXECUTION_SUMMARY);
  });

  it("別の要件（fixed-test）の集計の値の試験が不一致なら、合格にならない（外さない）", async () => {
    const { run } = runWith(structuralRun(STRUCTURAL_CHECKS_SUITE_WITH_AGGREGATE_MISMATCH), {
      limits: { ...AGENT_LIMITS, repairRoundTrips: 0 },
    });
    const result = await run;

    expect(result.outcome.result).not.toBe("pass");
    // R-1 の実行の試験（2 本）だけを外し、fixed-test の R-2 の集計の試験は外さない
    expect(result.summary.dropped_nonstructural_tests).toEqual(DROPPED_EXECUTION_SUMMARY);
    if (result.bundle === null) throw new Error("納品物が無い");
    expect(verificationOf(result.bundle).test_mismatches).toBeGreaterThanOrEqual(1);
  });

  it("外したあとに後の段で早く止まっても、要約に外した件数が残る", async () => {
    const malformed = { declaration: 123 };
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(STRUCTURAL_CHECKS_DESIGN),
      structured(STRUCTURAL_CHECKS_SUITE_WITH_EXECUTION),
      structured(malformed),
      structured(malformed),
    ]);
    const result = await run;

    expect(result.stopped?.stage).toBe("write");
    expect(result.summary.dropped_nonstructural_tests).toEqual(DROPPED_EXECUTION_SUMMARY);
  });

  it("②' 自体が最後に失敗しても、要約に外した件数が残る（回ごとに数える）", async () => {
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(STRUCTURAL_CHECKS_DESIGN),
      structured(STRUCTURAL_CHECKS_SUITE_INCOMPLETE),
      structured(STRUCTURAL_CHECKS_SUITE_INCOMPLETE),
    ]);
    const result = await run;

    expect(result.stopped).toMatchObject({ stage: "test-suite", kind: "unmet" });
    // やり直しの 2 回とも xe を外すので、回ごとに数えて 2 件
    expect(result.summary.dropped_nonstructural_tests).toEqual({ count: 2, by_operation: { compute: 2 } });
  });
});

// ── 残った view-shows の参照の不備・役割の対応の欠け（02 §1.3・Issue #392）──────────

/** 画面（record.records）・項目（record.amount）・計算（record.total）を持つ役割 ID の表 */
const VIEW_SHOWS_ROLES = [
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: false, aliasOf: null },
  { roleId: "record.records", kind: "screen", entity: "record", name: "records", shared: false, aliasOf: null },
  { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: false, aliasOf: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null },
];

/** ② の設計（R-1 は view-shows で確かめる。実行の試験も混ざる） */
const VIEW_SHOWS_DESIGN = {
  roles: VIEW_SHOWS_ROLES,
  designs: [
    {
      requirementId: "R-1",
      nature: "existence-only",
      verification: { kind: "structural", reason: "表示を構造で確かめる" },
      checks: ["view-shows"],
      vocabulary: [],
      placement: [],
      unwritable: [],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      checks: [],
      vocabulary: [],
      placement: [],
      unwritable: [],
    },
  ],
};

/** ②' の答え（R-1 の view-shows は、一覧が出さない項目 amount を期待する。実行の試験も混ざる） */
const VIEW_SHOWS_SUITE = {
  classifications: [
    { requirementId: "R-1", nature: "existence-only" },
    { requirementId: "R-2", nature: "ruled" },
  ],
  tests: [
    {
      id: "vs",
      target: { requirementId: "R-1", kind: "screen", roleId: "record.records" },
      kind: "normal",
      operation: "structure",
      clock: CREATE_CLOCK,
      input: {},
      inputContract: { rowId: "vs-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: true },
      assertion: { check: "view-shows", role: "record.amount" },
    },
    {
      id: "xr1",
      target: { requirementId: "R-1", kind: "computation", roleId: "record.total" },
      kind: "normal",
      operation: "compute",
      clock: CREATE_CLOCK,
      input: { amount: 21 },
      inputContract: { rowId: "xr1-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: 42 },
    },
    ...STRUCTURAL_CHECKS_SUITE.tests.slice(1, 4), // R-2 の n・a・b
  ],
};

const VIEW_SHOWS_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.records", name: "records" },
  { roleId: "record.amount", name: "amount" },
  { roleId: "record.total", name: "total" },
];

const VIEW_SHOWS_CORRESPONDENCE = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "view", entity: null, name: "records" },
      ],
    },
    { requirementId: "R-2", locations: [{ kind: "computation", entity: "record", name: "total" }] },
  ],
};

const viewShowsRun = (mappings: readonly unknown[]): readonly RecordedCall[] => [
  structured(REQUIREMENT_LIST_OUTPUT),
  structured(REVERSE_CHECK_OUTPUT),
  structured(VIEW_SHOWS_DESIGN),
  structured(VIEW_SHOWS_SUITE),
  structured({ declaration: CREATE_DECLARATION, mappings }),
  structured(VIEW_SHOWS_CORRESPONDENCE),
];

describe("残った view-shows の参照の不備・役割の対応の欠け（02 §1.3・Issue #392）", () => {
  it("一覧が出さない項目を期待する view-shows は不一致になり、合格にならない", async () => {
    const { run } = runWith(viewShowsRun(VIEW_SHOWS_MAPPINGS), {
      limits: { ...AGENT_LIMITS, repairRoundTrips: 0, correspondenceRedos: 0, correspondenceChecks: 0 },
    });
    const result = await run;

    expect(result.outcome.result).not.toBe("pass");
    if (result.bundle === null) throw new Error("納品物が無い");
    expect(verificationOf(result.bundle).structural_checks[0]).toMatchObject({ test_id: "vs", result: "mismatch" });
    // 外したのは R-1 の実行の試験 1 本だけ
    expect(result.summary.dropped_nonstructural_tests).toEqual({ count: 1, by_operation: { compute: 1 } });
  });

  it("表示を期待する役割の対応が欠けていれば未解決になり、合格にならない", async () => {
    const withoutAmount = VIEW_SHOWS_MAPPINGS.filter((mapping) => mapping.roleId !== "record.amount");
    const { run } = runWith(viewShowsRun(withoutAmount), {
      limits: { ...AGENT_LIMITS, repairRoundTrips: 0, correspondenceRedos: 0, correspondenceChecks: 0 },
    });
    const result = await run;

    expect(result.outcome.result).not.toBe("pass");
    if (result.bundle === null) throw new Error("納品物が無い");
    expect(verificationOf(result.bundle).structural_checks[0]).toMatchObject({ test_id: "vs", result: "unresolved" });
    expect(result.summary.dropped_nonstructural_tests).toEqual({ count: 1, by_operation: { compute: 1 } });
  });
});

// ── 項目 × 画面の試験と、`show` に出ていない項目の落ち（02 §1.3・§1.3.1・Issue #324）──

/**
 * ② の設計（抽象的な題材）。要件は在ることだけ（existence-only）で、2 つの entity に 3 つずつ、
 * 合計 6 つの項目の役割 ID を持つ（②' は「項目 × 画面」の試験を 6 本作る）。
 */
const FIELD_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "記録", shared: true, aliasOf: null },
    { roleId: "record.a", kind: "field", entity: "record", name: "項目A", shared: true, aliasOf: null },
    { roleId: "record.b", kind: "field", entity: "record", name: "項目B", shared: true, aliasOf: null },
    { roleId: "record.c", kind: "field", entity: "record", name: "項目C", shared: true, aliasOf: null },
    { roleId: "other", kind: "entity", entity: null, name: "その他", shared: true, aliasOf: null },
    { roleId: "other.a", kind: "field", entity: "other", name: "項目A", shared: true, aliasOf: null },
    { roleId: "other.b", kind: "field", entity: "other", name: "項目B", shared: true, aliasOf: null },
    { roleId: "other.c", kind: "field", entity: "other", name: "項目C", shared: true, aliasOf: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "existence-only",
      verification: { kind: "structural", reason: "項目が一覧か表に出ていることを構造で確かめる" },
      vocabulary: ["field"],
      placement: ["entities[].fields"],
      unwritable: [],
    },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "項目が一覧か表に出ていることを構造で確かめる" },
      vocabulary: ["field"],
      placement: ["entities[].fields"],
      unwritable: [],
    },
  ],
};

/** ②' の「項目 × 画面」の試験 1 件（抽象的な題材） */
const fieldScreenTest = (id: string, requirementId: string, roleId: string): unknown => ({
  id,
  target: { requirementId, kind: "field", roleId },
  kind: "normal",
  operation: "screen",
  clock: CREATE_CLOCK,
  input: {},
  inputContract: { rowId: `${id}-row`, targetRowId: null, emptyEntities: [] },
  referenceData: [],
  expected: { kind: "ok", value: null },
});

/** ②' の答え（「項目 × 画面」の試験 6 本） */
const FIELD_SUITE = {
  classifications: [
    { requirementId: "R-1", nature: "existence-only" },
    { requirementId: "R-2", nature: "existence-only" },
  ],
  tests: [
    fieldScreenTest("t-ra", "R-1", "record.a"),
    fieldScreenTest("t-rb", "R-1", "record.b"),
    fieldScreenTest("t-rc", "R-1", "record.c"),
    fieldScreenTest("t-oa", "R-2", "other.a"),
    fieldScreenTest("t-ob", "R-2", "other.b"),
    fieldScreenTest("t-oc", "R-2", "other.c"),
  ],
};

/** ③ が提出する対応（項目の役割 ID → 宣言の項目の名前） */
const FIELD_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.a", name: "a" },
  { roleId: "record.b", name: "b" },
  { roleId: "record.c", name: "c" },
  { roleId: "other", name: "other" },
  { roleId: "other.a", name: "a" },
  { roleId: "other.b", name: "b" },
  { roleId: "other.c", name: "c" },
];

/**
 * ③ が書く宣言（抽象的な題材）。`records` の `show` は `[a, b]` で、**項目 c が画面に出ていない**
 * （疎通の確認で、要件に要る項目が画面から辿れない形）。
 */
const FIELD_DECLARATION_BEFORE = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      a: string",
  "      b: string",
  "      c: string",
  "  - name: other",
  "    fields:",
  "      a: string",
  "      b: string",
  "      c: string",
  "views:",
  "  - name: records",
  "    type: table",
  "    entity: record",
  "    show: [a, b]",
  "  - name: others",
  "    type: table",
  "    entity: other",
  "    show: [a, b, c]",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** ⑥ が直した宣言（`records` の `show` に、抜けていた項目 c を足す） */
const FIELD_DECLARATION_AFTER = FIELD_DECLARATION_BEFORE.replace("show: [a, b]", "show: [a, b, c]");

/** ⑤a の答え（実在して画面から辿れる場所だけを挙げる…直す前は c が辿れない） */
const FIELD_CORRESPONDENCE = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "field", entity: "record", name: "a" },
        { kind: "field", entity: "record", name: "b" },
        { kind: "field", entity: "record", name: "c" },
      ],
    },
    {
      requirementId: "R-2",
      locations: [
        { kind: "entity", entity: null, name: "other" },
        { kind: "field", entity: "other", name: "a" },
        { kind: "field", entity: "other", name: "b" },
        { kind: "field", entity: "other", name: "c" },
      ],
    },
  ],
};

/** 記録した要求の中の、1 つのデータ（`<data name="…">…</data>`）の中身を取り出す */
function dataBlock(input: string, name: string): string {
  const start = input.indexOf(`<data name="${name}">`);
  if (start < 0) return "";
  const end = input.indexOf("</data>", start);
  return input.slice(start, end < 0 ? undefined : end);
}

describe("項目 × 画面の試験と、`show` に出ていない項目の落ち（02 §1.3・§1.3.1・Issue #324）", () => {
  it("画面から辿れない落ちは ⑥ 直すに回り、③ のやり直しには回らず、落ちに要件 ID が入る", async () => {
    const { recording, run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(FIELD_DESIGN),
      structured(FIELD_SUITE),
      structured({ declaration: FIELD_DECLARATION_BEFORE, mappings: FIELD_MAPPINGS }),
      structured(FIELD_CORRESPONDENCE),
      // ⑥ 直す：抜けていた項目 c を `show` に足した宣言を返す
      toolDone({ declaration: FIELD_DECLARATION_AFTER, disputes: [] }),
      // 宣言が変わったので、⑤a を作り直す
      structured(FIELD_CORRESPONDENCE),
    ]);
    const result = await run;

    const stages = result.record.stages.map((stage) => stage.stage);
    // 「画面から辿れない」落ちは ⑥ 直すへ回る
    expect(stages).toContain("repair");
    // ③ のやり直し（対応の表の出し直し）へは回さない
    expect(recording.structured.every((request) => request.schemaName !== MAPPING_REDO_SCHEMA_NAME)).toBe(true);

    // ⑥ に渡した「対応表の落ち」に、もとの要件 ID が入っている
    const misses = dataBlock(recording.tools[0]?.input ?? "", "対応表の落ち");
    expect(misses).toContain("画面から辿れない");
    expect(misses).toContain("R-1");

    // 直した後は、項目 × 画面の試験 6 本も含めてすべて一致し、完走する
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });
});

// ── 書けなかった要件の一覧と、部分案になった理由（02 §1.4・§4・Issue #326）──────

/** 納品物から、書けなかった要件の一覧（`artifacts/unwritable.json`）を読む */
const unwritableOf = (bundle: { artifacts: readonly { path: string; text: string }[] }): BundleUnwritable => {
  const found = bundle.artifacts.find((artifact) => artifact.path === UNWRITABLE_FILE);
  if (found === undefined) throw new Error("書けなかった要件の一覧が無い");
  return JSON.parse(found.text) as BundleUnwritable;
};

describe("書けなかった要件の一覧と、部分案になった理由（02 §1.4・§4・Issue #326）", () => {
  it("R-1 と R-4 が書けない設計から、一覧（要件 ID・要件の文・引用・書けない部分）が納品物に出る", async () => {
    const { recording, run } = runWith(recordedRunFour(), { source: SOURCE_TEXT_FOUR });
    const result = await run;

    // 送った要求に、受入の題材の言葉が無い
    for (const request of recording.structured) {
      expectNoAcceptanceMaterial([
        request.instructions,
        ...(request.rules ?? []),
        request.input,
        ...request.documents,
      ]);
    }

    // 早期停止はしない。書けない要件が 2 つあるので部分案になる
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;

    // 一覧に、設計が書けないと申告した要件が出る（要件 ID・要件の文・引用・書けない部分）。
    // 検証の結果と同じく、宣言のバイト列の SHA-256 に結び付いている
    const list = unwritableOf(result.bundle);
    expect(list.declaration_sha256).toBe(await sha256Hex(DECLARATION_SOURCE_FOUR));
    expect(list.unwritable).toEqual([
      {
        requirementId: "R-1",
        text: "タスクを記録できる",
        quote: "タスクを記録する。",
        unwritable: ["記録の並べ替えは書けない"],
      },
      {
        requirementId: "R-4",
        text: "印を出せる",
        quote: "印を出す。",
        unwritable: ["印の色分けは書けない"],
      },
    ]);

    // manifest に載っている
    expect(result.bundle.manifest.files.map((file) => file.path)).toContain(UNWRITABLE_FILE);

    // 検証の結果の理由にも、書けない要件の数と ID が出る（つなぎの抜けは 0 なので、ほかは空）
    const reasons: BundlePartialReasons = verificationOf(result.bundle).partial_reasons;
    expect(reasons.unwritable_requirements).toEqual({ count: 2, requirement_ids: ["R-1", "R-4"] });
    expect(reasons.unresolved).toEqual({ count: 0, ids: [] });
    expect(reasons.ambiguities).toEqual([]);
    expect(reasons.unresolved_tests).toEqual([]);
    expect(reasons.correspondence_misses).toEqual([]);
  });

  it("合格の道では、部分案の理由を空で出す（欄は常にある）", async () => {
    const { run } = runWith(recordedRun());
    const result = await run;
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;

    // 書けなかった要件の一覧も、空の並びで出る（欄は常にある）
    expect(unwritableOf(result.bundle).unwritable).toEqual([]);
    expect(verificationOf(result.bundle).partial_reasons).toEqual({
      unwritable_requirements: { count: 0, requirement_ids: [] },
      unresolved: { count: 0, ids: [] },
      ambiguities: [],
      unresolved_tests: [],
      correspondence_misses: [],
    });
  });
});


// ── ② の「書けない」の申告を仕分けて裏を取る（判定の口。#330・Issue #332）────────

/** 判定の答え（choice）を作る */
const judgeChoice = (value: string, confidence?: number): JudgeAnswer => ({
  kind: "choice",
  choice: value,
  probabilities: undefined,
  probability: undefined,
  confidence,
});

describe("② の申告を仕分けて裏を取る（判定の口。Issue #332）", () => {
  /** R-1 に、語彙の穴ではない（曖昧さの）申告を 1 件足した設計（新形式） */
  const CREATE_DESIGN_WITH_CLAIM = {
    roles: CREATE_DESIGN.roles,
    designs: [
      {
        requirementId: "R-1",
        nature: "existence-only",
        verification: { kind: "structural", reason: "登録できることを構造で確かめる" },
        vocabulary: ["entity", "action"],
        placement: ["entities", "actions"],
        unwritable: [
          { part: "件数の数え方を決めていない", constraintIds: ["記録"], reason: "どちらの数え方か原文に無い" },
        ],
        notes: [],
      },
      {
        requirementId: "R-2",
        nature: "ruled",
        verification: { kind: "fixed-test" },
        vocabulary: ["computation"],
        placement: ["computed"],
        unwritable: [],
        notes: [],
      },
    ],
  };

  /** R-2 の異常の期待を直して、⑥ 直すに入らずに完走する ②' の答え */
  const PASSING_CREATE_SUITE = {
    classifications: CREATE_SUITE.classifications,
    tests: CREATE_SUITE.tests.map((test) =>
      test.id === "a" ? { ...test, expected: { kind: "ok", value: 42 } } : test,
    ),
  };

  const recorded = (design: unknown): readonly RecordedCall[] => [
    structured(REQUIREMENT_LIST_OUTPUT),
    structured(REVERSE_CHECK_OUTPUT),
    structured(design),
    structured(PASSING_CREATE_SUITE),
    structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
    structured(CREATE_CORRESPONDENCE),
  ];

  it("曖昧さの申告は notes に移り、部分案の理由にならない（合格のまま）", async () => {
    const judge = createFakeJudge({ "triage:R-1:0": judgeChoice("ambiguity", 0.9) });
    const { recording, run } = runWith(recorded(CREATE_DESIGN_WITH_CLAIM), { judge });
    const result = await run;

    expect(result.stopped).toBeNull();
    // 誤った「書けない」を落としたので、合格のまま（判定を回さなければ部分案になっていた）
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const list = unwritableOf(result.bundle);
    expect(list.unwritable).toEqual([]);
    // 判定の記録と、落とした申告が残る（依頼文の全文は残さない）
    expect(list.triage).toEqual([
      { question_id: "triage:R-1:0", answer: "ambiguity", confidence: 0.9, model: "fake-judge", answered_by: "fake" },
    ]);
    expect(list.dropped).toEqual([
      {
        requirement_id: "R-1",
        part: "件数の数え方を決めていない",
        label: "ambiguity",
        reason: "どちらの数え方か原文に無い",
      },
    ]);
    // 判定は LlmClient を呼ばない（記録した応答は 6 回のまま）
    expect(recording.structured).toHaveLength(6);
  });

  it("判定を渡さなければ、申告をそのまま残し、部分案になる（後方互換）", async () => {
    const { run } = runWith(recorded(CREATE_DESIGN_WITH_CLAIM));
    const result = await run;
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
  });
});

// ── 判定の呼び出しを生成の予算に数える（05 §4〜§5・Issue #359）──────────────

/** 呼ばれた回数を数える偽物の判定（包みが判定を呼ばないことを確かめる） */
function spyJudge(inner: Judge): { readonly judge: Judge; readonly calls: () => number } {
  let calls = 0;
  return {
    judge: {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        calls += 1;
        return inner.judge(request);
      },
    },
    calls: () => calls,
  };
}

/** どの問いにも同じ答えを返し、LLM の使用量を載せる判定（実 API は呼ばない。Issue #359） */
function llmAnsweringJudge(usage: LlmUsage, answer: JudgeAnswer): Judge {
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      const answers: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(request.questions)) answers[name] = answer;
      return { answers, inputTokens: usage.inputTokens, usage, model: "gpt-judge", answeredBy: "llm" };
    },
  };
}

/** R-2 に「書けない」の申告を 1 件持つ設計（旧形式の欄は持たない＝中身の点検は掛からない） */
const DESIGN_WITH_CLAIM = {
  designs: [
    { requirementId: "R-1", vocabulary: ["計算"], placement: ["computed"], unwritable: [], notes: [] },
    {
      requirementId: "R-2",
      vocabulary: ["計算"],
      placement: ["computed"],
      unwritable: [{ part: "補助の値の並べ替えは書けない", constraintIds: ["R-2"], reason: "文書に無い" }],
      notes: [],
    },
  ],
};

describe("判定の呼び出しを生成の予算に数える（05 §4〜§5・Issue #359）", () => {
  it("判定の費用が予算の使用額に入り、要約に adapter ごとの数と費用が残る", async () => {
    const usage: LlmUsage = { inputTokens: 800, cachedInputTokens: 200, outputTokens: 120, reasoningTokens: 0 };
    const judge = llmAnsweringJudge(usage, judgeChoice("ambiguity", 0.9));

    // 同じ記録を、判定あり／判定なしで流す（段の呼び出しは同じ。記録した usage で精算される）
    const withJudge = await runWith(recordedRun({ design: DESIGN_WITH_CLAIM }), { judge }).run;
    const withoutJudge = await runWith(recordedRun({ design: DESIGN_WITH_CLAIM })).run;

    const judgeCost = costOfUsageUsd(usage, RATES);
    expect(judgeCost).toBeGreaterThan(0);

    // 要約に、答えた adapter（llm）ごとの呼び出しの数と、判定の費用が残る
    expect(withJudge.summary.judge.calls_by_adapter).toEqual({ jev: 0, llm: 1, fake: 0 });
    expect(withJudge.summary.judge.cost_usd).toBeCloseTo(judgeCost, 12);
    // 判定の費用は、段の費用と同じ予算に入る（使用額が、判定なしの走り＋判定の費用になる）
    expect(withJudge.summary.provider_cost_usd ?? 0).toBeCloseTo(
      (withoutJudge.summary.provider_cost_usd ?? 0) + judgeCost,
      12,
    );
    // 曖昧さとして落ちたので、合格のまま（判定を使った生成）
    expect(withJudge.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("予算が尽きていると、判定を呼ばずに申告をそのまま残す", async () => {
    // R-1 に多数の「書けない」を持つ設計。判定の問いの map（1 申告 = 1 問）が大きくなり、呼ぶ前の予約が、
    // 残りの段の呼び出しより大きくなる。予算は段の呼び出しには足りるが、判定の予約には足りない。
    const claims = Array.from({ length: 500 }, (_, index) => ({
      part: `p${index}`,
      constraintIds: ["R-1"],
      reason: "理由",
    }));
    const design = {
      designs: [
        { requirementId: "R-1", vocabulary: ["計算"], placement: ["computed"], unwritable: claims, notes: [] },
        { requirementId: "R-2", vocabulary: ["計算"], placement: ["computed"], unwritable: [], notes: [] },
      ],
    };

    const { judge, calls } = spyJudge(createFakeJudge({}));
    // 予算は、段の呼び出し（③ は 500 件の設計を運ぶ）には足りるが、判定の予約（1 申告 = 1 問の
    // 問いの map）には足りない大きさにする。
    const result = await runWith(recordedRun({ design }), { judge, effort: "low", budgetUsd: 0.1 }).run;

    // 予約できないので、判定は 1 回も呼ばれない（呼べるなら問いの答えが無くて誤りになるはず）
    expect(calls()).toBe(0);
    expect(result.summary.judge.calls_by_adapter).toEqual({ jev: 0, llm: 0, fake: 0 });
    expect(result.summary.judge.cost_usd).toBe(0);

    // 申告はそのまま残る（仕分けを回さない）。書けない要件があるので部分案になる
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const list = unwritableOf(result.bundle);
    expect(list.triage).toEqual([]);
    expect(list.unwritable).toHaveLength(1);
    expect(list.unwritable[0]?.requirementId).toBe("R-1");
    expect(list.unwritable[0]?.unwritable).toHaveLength(500);
  });
});

// ── 確定した仕様（plan.json）を全段の正本にする（§5・Issue #334）──────────────

describe("確定した仕様を正本にする（§5・Issue #334）", () => {
  it("確定した仕様を渡すと、①・①' を行わず、その要件で最後まで流れる", async () => {
    const { recording, run } = runWith(recordedRunFromPlan(), { plan: CONFIRMED_PLAN });
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    // ①（要件）・①'（逆照合）の段は回さない
    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages).not.toContain("reverse-check");
    expect(stages).toContain("design");
    // 送った要求に、①・①' の schema が無い（② から始まる）
    expect(recording.structured.every((request) => request.schemaName !== REQUIREMENTS_SCHEMA_NAME)).toBe(true);
    expect(recording.structured.every((request) => request.schemaName !== REVERSE_CHECK_SCHEMA_NAME)).toBe(true);
    // ②'・⑤a の根拠に、確定した仕様が入る
    expect(recording.structured.some((request) => request.input.includes("確定した仕様"))).toBe(true);
    // 納品物に plan.json が入り、仕様の SHA-256 が載る
    expect(result.bundle).not.toBeNull();
    expect(result.bundle?.planSha256).toBe(await planDigest(CONFIRMED_PLAN));
  });

  it("了承して除いた部分だけが書けない仕様は、合格（full）になる", async () => {
    const { run } = runWith(recordedRunFromPlan({ design: DESIGN_OUTPUT_PARTIAL }), {
      plan: CONFIRMED_PLAN_ACCEPTED,
    });
    const result = await run;

    // 設計は R-2 を「書けない」と申告するが、確定した仕様で了承して除いているので合格のまま
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.bundle?.planSha256).toBe(await planDigest(CONFIRMED_PLAN_ACCEPTED));
  });

  it("確定した仕様を渡さなければ、これまでどおり原文から ①・①' を回す", async () => {
    const { recording, run } = runWith(recordedRun());
    const result = await run;
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.record.stages.map((stage) => stage.stage)).toContain("reverse-check");
    expect(recording.structured.some((request) => request.schemaName === REQUIREMENTS_SCHEMA_NAME)).toBe(true);
    expect(recording.structured.some((request) => request.schemaName === REVERSE_CHECK_SCHEMA_NAME)).toBe(true);
  });
});

// ── 試験の段の種類の食い違いを判定に選ばせる（02 §1・②'・Issue #373）──────────

/** 種類の判定の答え（choice。選んだ選択肢の確率つき） */
const judgeChoiceProb = (value: string, probability: number): JudgeAnswer => ({
  kind: "choice",
  choice: value,
  probabilities: undefined,
  probability,
  confidence: undefined,
});

/** 種類の食い違いを含む完走の記録（①→①'→②→②'→③→⑤a） */
const recordedWithNature = (design: unknown, suite: unknown): readonly RecordedCall[] => [
  structured(REQUIREMENT_LIST_OUTPUT),
  structured(REVERSE_CHECK_OUTPUT),
  structured(design),
  structured(suite),
  structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
  structured(CREATE_CORRESPONDENCE),
];

/** R-1 の create の正常 1 本（在ることだけの要件） */
const R1_CREATE_NORMAL = CREATE_SUITE.tests.filter((test) => test.target.requirementId === "R-1");

/** R-2 の正常・異常・境界（決まりを含む要件。異常の期待を直して、計算の結果と一致させる） */
const R2_RULED_TRIPLE = CREATE_SUITE.tests
  .filter((test) => test.target.requirementId === "R-2")
  .map((test) => (test.id === "a" ? { ...test, expected: { kind: "ok", value: 42 } } : test));

/** 設計が R-1 を「在ることだけ」、R-2 を「決まりを含む」とする（CREATE_DESIGN と同じ種類） */
const DESIGN_CREATE = CREATE_DESIGN;

describe("試験の段の種類の食い違いを判定に選ばせる（Issue #373）", () => {
  it("使用量の付いた判定の呼び出しが、要約の judge 欄と生成の予算に入る", async () => {
    // 設計は R-2 を「在ることだけ」とするが、②' は ruled と分類する（食い違い）。判定は ruled を選ぶ
    const design = {
      roles: CREATE_DESIGN.roles,
      designs: CREATE_DESIGN.designs.map((entry) => ({
        ...entry,
        nature: "existence-only",
        verification: { kind: "structural", reason: "在ることだけ" },
      })),
    };
    const suite = {
      classifications: [
        { requirementId: "R-1", nature: "existence-only" },
        { requirementId: "R-2", nature: "ruled" },
      ],
      tests: [...R1_CREATE_NORMAL, ...R2_RULED_TRIPLE],
    };
    const usage: LlmUsage = { inputTokens: 800, cachedInputTokens: 200, outputTokens: 120, reasoningTokens: 0 };
    const judge = llmAnsweringJudge(usage, judgeChoiceProb("ruled", 0.9));

    const withJudge = await runWith(recordedWithNature(design, suite), { judge }).run;
    const withoutJudge = await runWith(recordedWithNature(design, suite)).run;

    const judgeCost = costOfUsageUsd(usage, RATES);
    expect(judgeCost).toBeGreaterThan(0);
    // 要約の judge 欄に、呼び出しの数（llm）と費用が入る
    expect(withJudge.summary.judge.calls_by_adapter).toEqual({ jev: 0, llm: 1, fake: 0 });
    expect(withJudge.summary.judge.cost_usd).toBeCloseTo(judgeCost, 12);
    // 判定の費用は、生成の使用額に入り、残りの予算から引かれる
    expect(withJudge.summary.provider_cost_usd ?? 0).toBeCloseTo(
      (withoutJudge.summary.provider_cost_usd ?? 0) + judgeCost,
      12,
    );
    expect(withJudge.summary.budget_remaining_usd).toBeCloseTo(
      (withoutJudge.summary.budget_remaining_usd ?? 0) - judgeCost,
      12,
    );
    // どちらも合格（判定は助言。門は変えない）
    expect(withJudge.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(withoutJudge.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("判定で採った種類で、試験の段のあとの段も評価される", async () => {
    // 設計は R-1 を「在ることだけ」とするが、②' は ruled と分類する。判定が existence-only を選ぶ
    const suite = {
      classifications: [
        { requirementId: "R-1", nature: "ruled" },
        { requirementId: "R-2", nature: "ruled" },
      ],
      tests: [...R1_CREATE_NORMAL, ...R2_RULED_TRIPLE],
    };
    const judge = createFakeJudge({ [natureQuestionName("R-1")]: judgeChoiceProb("existence-only", 0.9) });
    const { run } = runWith(recordedWithNature(DESIGN_CREATE, suite), { judge });
    const result = await run;

    // 採った種類（existence-only）が分類に書き込まれ、後の段（試験を流す）が構造の確認で評価する。
    // 書き込まなければ（ruled のまま）R-1 の create の試験は実行として扱われ、合格にならない
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    // 要約にも、食い違いの記録（決め方・確率・判定のモデル・閾値の版）が残る
    expect(result.summary.nature_discrepancies).toEqual([
      {
        requirement_id: "R-1",
        design: "existence-only",
        classified: "ruled",
        resolved: "existence-only",
        resolution: "judged",
        probability: 0.9,
        model: "fake-judge",
        threshold_version: NATURE_JUDGE_THRESHOLD_VERSION,
      },
    ]);
  });

  it("予算の予約が断られると、判定を呼ばずに ruled に倒れる", async () => {
    // 判定の予約は、問いの数（＝食い違った要件の数）で大きくなる。要件を多くして、試験の段の
    // 呼び出しは通るが、判定の予約だけが残高を超えるようにする（設計はすべて existence-only、
    // ②' はすべて ruled と分類する＝食い違い）。**残高は、段の要求の大きさに合わせてある**——
    // ②' のデータが要件ごとの確かめ方の種類（verification.kind）も運ぶようになった分（Issue #392）、
    // 段の予約が少し大きくなったので、値を上げてある（この窓の外では、段の予約か判定の予約の
    // どちらかが通ってしまい、この試験の前提が崩れる）。
    const count = 300;
    const quotes = Array.from({ length: count }, (_, index) => `項目${index + 1}。`);
    const source = quotes.join("");
    let offset = 0;
    const requirements = quotes.map((quote, index) => {
      const start = offset;
      offset += quote.length;
      return {
        id: `R-${index + 1}`,
        text: `${quote.slice(0, -1)}できる`,
        quote,
        position: { start, end: offset },
      };
    });
    const design = {
      roles: [{ roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null }],
      designs: requirements.map((requirement) => ({
        requirementId: requirement.id,
        nature: "existence-only",
        verification: { kind: "structural", reason: "在ることだけ" },
        vocabulary: [],
        placement: [],
        unwritable: [],
      })),
    };
    // 正常・異常・境界をそろえる（判定が断られて ruled に倒れたときに、試験の段は通る）
    const suite = {
      classifications: requirements.map((requirement) => ({ requirementId: requirement.id, nature: "ruled" })),
      tests: requirements.flatMap((requirement, index) =>
        (["normal", "abnormal", "boundary"] as const).map((kind, kindIndex) => ({
          id: `t${index * 3 + kindIndex + 1}`,
          target: { requirementId: requirement.id, kind: "entity", roleId: "record" },
          kind,
          operation: "action",
          clock: "2026-09-16T12:00:00+09:00",
          input: {},
          inputContract: { rowId: `row-${index + 1}`, targetRowId: null, emptyEntities: [] },
          referenceData: [],
          expected: { kind: "ok", value: null },
        })),
      ),
    };

    // 答えを用意しない偽物（呼ばれれば誤りになる）。予約が断られれば 1 回も呼ばれない
    const { judge, calls } = spyJudge(createFakeJudge({}));
    const { run } = runWith(
      [
        structured({ requirements, framing: [], decisions: [], unresolved: [] }),
        structured(REVERSE_CHECK_OUTPUT),
        structured(design),
        structured(suite),
        // 試験の段のあとの段（③）は、予算が尽きているか、この応答で形が合わずに止まる
        structured({}),
      ],
      { source, judge, budgetUsd: 0.115, effort: "low" },
    );
    const result = await run;

    // 予約が断られたので、判定は 1 回も呼ばれない（要約の judge 欄にも入らない）
    expect(calls()).toBe(0);
    expect(result.summary.judge.calls_by_adapter).toEqual({ jev: 0, llm: 0, fake: 0 });
    expect(result.summary.judge.cost_usd).toBe(0);
    // 採らずに ruled へ倒れたことが、要約の食い違いの記録に残る（決め方は fallback）
    expect(result.summary.nature_discrepancies).toHaveLength(count);
    expect(
      result.summary.nature_discrepancies.every(
        (entry) => entry.resolution === "fallback" && entry.resolved === "ruled",
      ),
    ).toBe(true);
  });
});

// ── 答えから増えた要件の文に問いの文脈を添える（§5・Issue #391）────────────────

describe("答えから増えた要件の文に問いの文脈を添える（§5・Issue #391）", () => {
  it("答えから増えた要件を含む確定した仕様で、② のデータの要件の文に問いの文脈が入る", async () => {
    const { recording, run } = runWith(recordedRunFromPlan(), { plan: CONFIRMED_PLAN_ADDED });
    const result = await run;

    // 答えから増えた R-2 があるが、仕様どおりなので合格のまま流れる
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });

    // ② のデータ（要件の一覧）の R-2 の文に、問いと未解決の事項の文が参考として入る
    const designRequest = recording.structured.find((request) => request.schemaName === DESIGN_SCHEMA_NAME);
    expect(designRequest).toBeDefined();
    expect(designRequest?.input).toContain(ADDED_QUESTION_TEXT);
    expect(designRequest?.input).toContain(ADDED_OPEN_ISSUE_TEXT);
    // 原文から来た要件の文は、そのまま
    expect(designRequest?.input).toContain("記録できる");
  });

  it("Plan への差し戻しの判断があれば、合格（full）にならず、差し戻しが結果に残る", async () => {
    const { recording, run } = runWith(
      [
        structured(DESIGN_OUTPUT),
        structured(TEST_SUITE_OUTPUT),
        structured({ declaration: DECLARATION_SOURCE_MISMATCH }),
        structured(CORRESPONDENCE_OUTPUT),
        toolDone({
          declaration: DECLARATION_SOURCE_MISMATCH,
          disputes: [{ testId: "t1", quote: "件数を合計する" }],
        }),
        structured({
          decisions: [{ testId: "t1", verdict: "return-to-plan", reason: "確定した仕様と食い違う", quote: "" }],
        }),
      ],
      { plan: CONFIRMED_PLAN_ADDED },
    );
    const result = await run;

    // ⑥' まで回り、差し戻しの判断が返る
    expect(result.record.stages.map((stage) => stage.stage)).toContain("arbitration");
    expect(recording.structured.some((request) => request.schemaName === ARBITRATION_SCHEMA_NAME)).toBe(true);
    // 差し戻しの判断があれば合格（full）にはならない
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.summary.verdict).not.toBe("full");
    // 差し戻しが結果に残る
    expect(result.returnToPlan).toBe(true);
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const arbitrationText = result.bundle.artifacts.find((artifact) => artifact.path === ARBITRATION_FILE)?.text ?? "{}";
    const arbitration = JSON.parse(arbitrationText) as { readonly returnToPlan?: readonly string[] };
    expect(arbitration.returnToPlan).toEqual(["t1"]);
  });
});
