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
import { acceptsHeadlessSummaryWire, planDigest, type ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { costOfUsageUsd } from "./budget.js";
import {
  ARBITRATION_FILE,
  BUNDLE_MANIFEST_FILE,
  DESIGN_FILE,
  DIAGNOSTICS_DECLARATION_FILE,
  DIAGNOSTICS_DESIGN_FILE,
  DIAGNOSTICS_LISTING_FILE,
  DIAGNOSTICS_STATIC_CHECK_FILE,
  DIAGNOSTICS_TEST_SUITE_FILE,
  MAPPINGS_FILE,
  TEST_SUITE_FILE,
  UNWRITABLE_FILE,
  VERIFICATION_FILE,
  type BundleMaterialEntry,
  type BundlePartialReasons,
  type BundleUnwritable,
  type BundleVerification,
} from "./bundle.js";
import { AGENT_LIMITS } from "./limits.js";
import { createFakeJudge } from "./judge-fake.js";
import type { Judge, JudgeAnswer, JudgeRequest, JudgeResponse } from "./judge.js";
import { createFakeLlmClient, type RecordedCall } from "./llm-fake.js";
import type { LlmClient, LlmStructuredRequest, LlmToolRequest, LlmUsage } from "./llm.js";
import { OpenAiIncompleteError, createOpenAiLlmClient, type OpenAiUsage } from "./openai.js";
import { runGeneration, countUnresolvedTests, redoDesignRecorded, type GenerationInput } from "./run.js";
import { LEGACY_DESIGN_CONTRACT } from "./pipeline.js";
import { MAPPING_REDO_SCHEMA_NAME } from "./stages/repair.js";
import * as repairTools from "./stages/tools.js";
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
  CORRESPONDENCE_OUTPUT_PLANNED,
  CORRESPONDENCE_OUTPUT_WITH_FIELD,
  DECLARATION_SOURCE,
  DECLARATION_SOURCE_FOUR,
  DECLARATION_SOURCE_MISMATCH,
  DESIGN_OUTPUT,
  DESIGN_OUTPUT_MAPPED,
  DESIGN_OUTPUT_PLANNED_PARTIAL,
  GROUPED_CORRESPONDENCE_OUTPUT,
  GROUPED_CORRESPONDENCE_OUTPUT_WITHOUT_STATUS,
  GROUPED_CORRESPONDENCE_OUTPUT_WRONG_TARGET,
  GROUPED_DECLARATION_MISSING_OPTION,
  GROUPED_DECLARATION_REVERSED,
  GROUPED_DECLARATION_REVERSED_LABEL,
  GROUPED_DECLARATION_SOURCE,
  GROUPED_DECLARATION_WRONG_TARGET,
  GROUPED_DESIGN,
  GROUPED_DESIGN_MISSING_OPTION,
  GROUPED_DESIGN_WRONG_TARGET,
  GROUPED_MAPPINGS,
  GROUPED_MAPPINGS_WRONG_TARGET,
  GROUPED_PLAN_LABEL,
  GROUPED_PLAN_OPTION,
  GROUPED_PLAN_TARGET,
  GROUPED_TEST_SUITE_OUTPUT,
  GROUPED_TEST_SUITE_WITHOUT_AGGREGATE,
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
  USAGE,
  makeRunInput,
  recordedRun,
  recordedRunFour,
  recordedRunGrouped,
  recordedRunGroupedFromPlan,
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

/** 診断の成果物から、あるパスの本文を読む（Issue #417） */
const diagnosticTextOf = (artifacts: readonly { path: string; text: string }[], path: string): string => {
  const found = artifacts.find((artifact) => artifact.path === path);
  if (found === undefined) throw new Error(`診断に無い: ${path}`);
  return found.text;
};

/** 一覧（診断の `materials.json`）を読む（Issue #417） */
const listingOf = (
  artifacts: readonly { path: string; text: string }[],
): { stopped: { stage: string; kind: string } | null; materials: readonly BundleMaterialEntry[] } =>
  JSON.parse(diagnosticTextOf(artifacts, DIAGNOSTICS_LISTING_FILE)) as {
    stopped: { stage: string; kind: string } | null;
    materials: readonly BundleMaterialEntry[];
  };

/** 一覧から、ある材料の状態を読む（Issue #417） */
const stateOf = (artifacts: readonly { path: string; text: string }[], material: string): string | undefined =>
  listingOf(artifacts).materials.find((entry) => entry.material === material)?.state;

/** 納品物の成果物から、あるパスの本文を読む（Issue #417） */
const fileTextOf = (bundle: { artifacts: readonly { path: string; text: string }[] }, path: string): string => {
  const found = bundle.artifacts.find((artifact) => artifact.path === path);
  if (found === undefined) throw new Error(`納品物に無い: ${path}`);
  return found.text;
};

/**
 * 記録を順に返しつつ、**N 回目の構造化呼び出しのあとで時計を進める**偽物（Issue #417）。
 * 締切を狙った段に当てる——次の呼び出しで締切の残りが尽きる。実 API は呼ばない。
 */
function clientWithClockJump(
  recording: { client: LlmClient },
  jumpAfter: number,
  jumpedTo: number,
  clock: { value: number },
): LlmClient {
  let calls = 0;
  return {
    async callStructured<T>(request: LlmStructuredRequest) {
      const response = await recording.client.callStructured<T>(request);
      calls += 1;
      if (calls === jumpAfter) clock.value = jumpedTo;
      return response;
    },
    callWithTools: (request: LlmToolRequest) => recording.client.callWithTools(request),
  };
}

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

    // Issue #417：納品物に、受理した材料（設計・固定した試験・提出された対応）の 3 ファイルが入り、
    // 各ファイルの中の宣言の SHA-256 が、**検証の結果の宣言の SHA-256** と一致する（02 §4）
    const verification = verificationOf(result.bundle);
    for (const path of [DESIGN_FILE, TEST_SUITE_FILE, MAPPINGS_FILE]) {
      const material = JSON.parse(fileTextOf(result.bundle, path)) as { declaration_sha256: string };
      expect(material.declaration_sha256, path).toBe(verification.declaration_sha256);
    }
    // 検証の結果の回数が、**段の記録**の件数と整合する（評価・⑤a の生成・③ の出し直し・⑥ の実行）
    const countIn = (stage: string): number => result.record.stages.filter((entry) => entry.stage === stage).length;
    expect(verification.counts).toEqual({
      evaluations: countIn("static-check"),
      write_initial: countIn("write") > 0 ? 1 : 0,
      write_redos: Math.max(0, countIn("write") - 1),
      correspondence_generations: countIn("correspondence"),
      repair_executions: countIn("repair"),
    });
    // 早期停止ではないので、診断は空（Issue #417）
    expect(result.diagnostics).toEqual([]);
    // 実行した検査は件数（0）で記され、「未実行」とは区別される（Issue #417）
    expect(verification.evaluations).toHaveLength(1);
    expect(verification.evaluations[0]?.correspondence_misses).toBe(0);
    expect(verification.evaluations[0]?.test_mismatches).toBe(0);
  });

  it("② の形が 1 回落ちて 2 回目で通る走りでは、2 つ目の ② の要求だけが前回の問題の塊を持つ（Issue #447）", async () => {
    const full = recordedRun();
    const { recording, run } = runWith([
      ...full.slice(0, 2),
      // ② の 1 回目は形の合わない応答（値は目印。問題の文には写らない）
      structured({ designs: "目印ZZ" }),
      ...full.slice(2),
    ]);
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    // 段の記録の calls は今までどおり（② は形のやり直しで 2 回呼ぶ）
    const design = result.record.stages.find((stage) => stage.stage === "design");
    expect(design).toMatchObject({ status: "ok", calls: 2 });
    // ② の要求は 2 つ。塊を持つのは 2 つ目だけである
    const designRequests = recording.structured.filter((request) => request.schemaName === DESIGN_SCHEMA_NAME);
    expect(designRequests).toHaveLength(2);
    expect(designRequests[0]?.input).not.toContain("前回の形の問題");
    expect(designRequests[1]?.input).toContain("前回の形の問題");
    // ほかの段の要求（①・①'・②'・③・⑤a）は、塊を持たない
    const others = recording.structured.filter((request) => request.schemaName !== DESIGN_SCHEMA_NAME);
    expect(others).toHaveLength(5);
    for (const request of others) {
      expect(request.input).not.toContain("前回の形の問題");
    }
  });

  it("記録が全段同じ封筒の形（result で包んだもの）でも、合格の道は同じように流れる（#353）", async () => {
    const { run } = runWith(
      [
        structured(enveloped(REQUIREMENTS_SCHEMA_NAME, REQUIREMENT_LIST_OUTPUT)),
        structured(enveloped(REVERSE_CHECK_SCHEMA_NAME, REVERSE_CHECK_OUTPUT)),
        structured(enveloped(DESIGN_SCHEMA_NAME, DESIGN_OUTPUT)),
        structured(enveloped(TEST_SUITE_SCHEMA_NAME, TEST_SUITE_OUTPUT)),
        structured(enveloped(WRITE_SCHEMA_NAME, { declaration: DECLARATION_SOURCE })),
        structured(enveloped(CORRESPONDENCE_SCHEMA_NAME, CORRESPONDENCE_OUTPUT)),
      ],
      { designVersion: LEGACY_DESIGN_CONTRACT },
    );
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("部分案の道：書けない要件があるまま最後まで流し、部分案になる", async () => {
    const { run } = runWith(recordedRun({ design: DESIGN_OUTPUT_PLANNED_PARTIAL }));
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
    // Issue #417：① の入口で止まった走りも、一覧だけは返す。全部が未実行で、材料のファイルは無い
    expect(listingOf(result.diagnostics).stopped).toEqual({ stage: "requirements", kind: "limit" });
    expect(listingOf(result.diagnostics).materials.every((entry) => entry.state === "unexecuted")).toBe(true);
    expect(result.diagnostics.map((artifact) => artifact.path)).toEqual([DIAGNOSTICS_LISTING_FILE]);
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
    const { run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(DESIGN_OUTPUT),
        structured(TEST_SUITE_OUTPUT),
        structured(malformed),
        structured(malformed),
      ],
      { designVersion: LEGACY_DESIGN_CONTRACT },
    );
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
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 0 }, designVersion: LEGACY_DESIGN_CONTRACT },
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
    const verification = verificationOf(result.bundle);
    expect(verification.unexecuted_inspections).toEqual(["correspondence", "run-tests"]);
    expect(acceptsHeadlessSummaryWire(result.summary)).toBe(true);
    expect(result.summary.verdict).toBe("none");

    // Issue #417：材料の状態の一覧。設計・固定した試験・提出された対応は受理済み、宣言は候補
    // （静的チェック不通過）、⑤a・⑤b は未実行。**この例を早期停止へ変えない**（納品物を返す）
    expect(verification.materials.map((entry) => [entry.material, entry.state])).toEqual([
      ["design", "accepted"],
      ["test_suite", "accepted"],
      ["mappings", "accepted"],
      ["declaration", "candidate"],
      ["correspondence", "unexecuted"],
      ["test_run", "unexecuted"],
      ["evaluation", "accepted"],
    ]);
    expect(verification.materials.find((entry) => entry.material === "declaration")?.static_check_passed).toBe(false);
    // 実行していない検査の落ちの件数は、0 とせず「未実行」と記す
    const row = verification.evaluations.at(-1);
    expect(row?.static_check_passed).toBe(false);
    expect(row?.correspondence_misses).toBe("unexecuted");
    expect(row?.test_mismatches).toBe("unexecuted");
    expect(row?.test_unresolved).toBe("unexecuted");
    // 早期停止ではないので、診断は空（Issue #417）
    expect(result.diagnostics).toEqual([]);
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
        design: DESIGN_OUTPUT,
        mappings: [],
        suite: TEST_SUITE_OUTPUT_WITH_UNRESOLVED,
        correspondence: CORRESPONDENCE_OUTPUT_WITH_FIELD,
      }),
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 0 }, designVersion: LEGACY_DESIGN_CONTRACT },
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
          design: DESIGN_OUTPUT,
          mappings: [],
          suite: TEST_SUITE_OUTPUT_WITH_UNRESOLVED,
          correspondence: CORRESPONDENCE_OUTPUT_WITH_FIELD,
        }),
        toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
      ],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 1 }, designVersion: LEGACY_DESIGN_CONTRACT },
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
    const result = await runGeneration(
      makeRunInput(createRecordingClient(cached).client, { designVersion: LEGACY_DESIGN_CONTRACT }),
    );

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
    const { recording, run } = runWith(
      [
        ...recordedRun({
          design: DESIGN_OUTPUT,
          mappings: [],
          suite: TEST_SUITE_OUTPUT_WITH_UNRESOLVED,
          correspondence: CORRESPONDENCE_OUTPUT_WITH_FIELD,
        }),
        toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
      ],
      { designVersion: LEGACY_DESIGN_CONTRACT },
    );
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
        // 新契約の fixture（R-1・R-2 の所属の場所を要件ごとに載せる）。③ の対応（record.total →
        // nonexistent）の不備だけが残るようにして、③ のやり直しへ回す（Issue #431）
        structured(CORRESPONDENCE_OUTPUT_PLANNED),
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

// ── 誤った所属は、要件 ID つきの落ちで ⑤a のやり直しに回る（Issue #431）────────

/**
 * 所属だけが誤った設計：R-2 が `record.total` にも所属するが、⑤a（偽物）は `total` を R-1 にだけ載せる。
 * `record.total` は 2 要件に所属するので `shared` を真にする（設計の形は通るが、所属と対応表が食い違う）。
 */
const WRONG_OWNERSHIP_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.extra", kind: "computation", entity: "record", name: "extra", shared: false, aliasOf: null, options: null, groupBy: null },
  ],
  designs: [
    {
      ...DESIGN_OUTPUT_MAPPED.designs[0],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
    },
    {
      ...DESIGN_OUTPUT_MAPPED.designs[1],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "記録の行を参照・識別するため" },
        { roleId: "record.total", basis: "dependency", reason: "同じ計算を共有するため" },
        { roleId: "record.extra", basis: "stated", reason: null },
      ],
    },
  ],
};

describe("誤った所属は、要件 ID つきの落ちで ⑤a のやり直しに回る（Issue #431）", () => {
  it("所属だけを誤らせた設計で、⑤b の試験は通るのに ⑤a のコードの落ちで ⑤a のやり直しに回り、full にならない", async () => {
    // 試験の対象・期待・宣言・⑤a の応答は、通常の成功例のまま固定する（所属だけを誤らせる）。
    // これで ⑤b の従来の outside-table ではなく、**⑤a の新しい要件ごとの落ち**が引き金になることを確かめる。
    const { recording, run } = runWith([
      ...recordedRun({ design: WRONG_OWNERSHIP_DESIGN }),
      structured(CORRESPONDENCE_OUTPUT_PLANNED), // ⑤a のやり直し（同じ応答なので停滞で止まる）
    ]);
    const result = await run;

    // 停滞で部分案になり、⑥ の失敗には誤って帰属しない（review 6）
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
    expect(result.summary.stop_reason).toBe("stagnation");
    // ⑤b の試験は通っている（不一致 0・未解決 0）。⑥ 直すへは回らない
    expect(result.record.stages.some((step) => step.stage === "repair")).toBe(false);
    if (result.bundle === null) throw new Error("納品物が無い");
    const verification = verificationOf(result.bundle);
    expect(verification.test_mismatches).toBe(0);
    expect(verification.test_unresolved).toBe(0);
    // 初回とやり直しの 2 回、⑤a を呼ぶ（段の記録も 2 件）
    expect(result.record.stages.filter((step) => step.stage === "correspondence")).toHaveLength(2);
    // やり直しの要求のデータに、前回の落ちが要件 ID と場所つきで入る
    const requests = recording.structured.filter((request) => request.schemaName === CORRESPONDENCE_SCHEMA_NAME);
    expect(requests).toHaveLength(2);
    const retry = requests[1]?.input ?? "";
    expect(retry).toContain("前回の対応表の落ち");
    expect(retry).toContain("R-2");
    expect(retry).toContain("total");
  });
});

// ── 所属 entity の対応が欠けると、⑤a ではなく ③ のやり直しに回る（レビュー 2）────

describe("所属 entity の対応が欠けると、⑤a ではなく ③ のやり直しに回る（Issue #431）", () => {
  it("entity の mapping だけ欠けると、⑤a を作り直さず ③ のやり直しを呼ぶ", async () => {
    // 計算の対応（total・extra）は正しいが、entity `record` の対応だけ欠けている
    const mappingsNoEntity = [
      { roleId: "record.total", name: "total" },
      { roleId: "record.extra", name: "extra" },
    ];
    const { run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(DESIGN_OUTPUT_MAPPED),
        structured(TEST_SUITE_OUTPUT_MAPPED),
        structured({ declaration: DECLARATION_SOURCE, mappings: mappingsNoEntity }),
        structured(CORRESPONDENCE_OUTPUT_PLANNED),
        structured(MAPPING_REDO_OUTPUT), // ③ のやり直し
      ],
      { limits: { ...AGENT_LIMITS, correspondenceRedos: 1, stagnationRepeats: 0 } },
    );
    const result = await run;

    const stages = result.record.stages.map((step) => step.stage);
    expect(stages).toContain("write"); // ③ のやり直し
    // ⑤a は作り直さない（null の場所で correspondence-redo を足さない）
    expect(result.record.stages.filter((step) => step.stage === "correspondence")).toHaveLength(1);
  });
});

// ── 構造の検査が対応表の外になると、⑤a のやり直しで結び付く（Issue #431）────────

describe("構造の検査が対応表の外になると、⑤a のやり直しで結び付く（Issue #431）", () => {
  // R-1 の対応表が操作 add を挙げていない（構造の検査の対象が結び付かない）
  const OUTSIDE_CORRESPONDENCE = {
    entries: [
      { requirementId: "R-1", locations: [{ kind: "entity", entity: null, name: "record" }] },
      {
        requirementId: "R-2",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "computation", entity: "record", name: "total" },
        ],
      },
    ],
  };
  // やり直し後の対応表（操作 add を R-1 に載せる）
  const REDONE_CORRESPONDENCE = {
    entries: [
      {
        requirementId: "R-1",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "action", entity: "record", name: "add" },
        ],
      },
      {
        requirementId: "R-2",
        locations: [
          { kind: "entity", entity: null, name: "record" },
          { kind: "computation", entity: "record", name: "total" },
        ],
      },
    ],
  };

  it("⑤a のやり直しが呼ばれ、やり直し後の対応表で結び付けば、構造の検査が実行される", async () => {
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(STRUCTURAL_CHECKS_DESIGN),
      structured(STRUCTURAL_CHECKS_SUITE),
      structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
      structured(OUTSIDE_CORRESPONDENCE), // 初回の ⑤a
      structured(REDONE_CORRESPONDENCE), // ⑤a のやり直し
    ]);
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    // 初回とやり直しの 2 回、⑤a を呼ぶ（段の記録も 2 件）
    expect(result.record.stages.filter((step) => step.stage === "correspondence")).toHaveLength(2);
    if (result.bundle === null) throw new Error("納品物が無い");
    expect(verificationOf(result.bundle).structural_checks.find((entry) => entry.test_id === "sc")?.result).toBe("pass");
  });
});

// ── 版の整合（02 §1.3.1・#309）──────────────────────────────────────

describe("宣言が変わったら、古い版の対応・結び付け・試験の結果を使わない（02 §1.3.1・#309）", () => {
  it("新しい版で ⑤a を作り直し、納品物は最後の版に結び付く", async () => {
    const { recording, run } = runWith([
      ...recordedRun({ write: DECLARATION_SOURCE_MISMATCH }),
      toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
      structured(CORRESPONDENCE_OUTPUT_PLANNED), // ⑤a の作り直し（新しい版）
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

/** ② の設計（R-1 は在ることだけ、R-2 は決まりを含む。役割の表・選択肢・所属を持つ新契約。Issue #418） */
const CREATE_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.add", kind: "operation", entity: "record", name: "add", shared: false, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "existence-only",
      verification: { kind: "structural", reason: "登録できることを構造で確かめる" },
      vocabulary: ["entity", "action"],
      placement: ["entities", "actions"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "登録する行の所属として参照するため" },
        { roleId: "record.add", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: ["computation"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "合計する行の所属として参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
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
    {
      requirementId: "R-2",
      // R-2 も entity `record` に依存として所属するので、要件ごとに載せる（Issue #431）
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
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

/** ② の設計（R-1 は構造で確かめる（checks 付き）、R-2 は固定した試験。新契約。Issue #418） */
const STRUCTURAL_CHECKS_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.add", kind: "operation", entity: "record", name: "add", shared: false, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: null },
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
      ownership: [
        { roleId: "record", basis: "dependency", reason: "登録する行の所属として参照するため" },
        { roleId: "record.add", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      checks: [],
      vocabulary: ["computation"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "合計する行の所属として参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
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
  { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
  { roleId: "record.records", kind: "screen", entity: "record", name: "records", shared: false, aliasOf: null, options: null, groupBy: null },
  { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: false, aliasOf: null, options: null, groupBy: null },
  { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: null },
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
      ownership: [
        { roleId: "record", basis: "dependency", reason: "画面と項目を載せる entity として参照するため" },
        { roleId: "record.records", basis: "stated", reason: null },
        { roleId: "record.amount", basis: "dependency", reason: "画面に表示する項目として参照するため" },
      ],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      checks: [],
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "合計する行の所属として参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
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
      input: { "record.amount": 21 },
      inputContract: { rowId: "xr1-row", targetRowId: null, emptyEntities: [] },
      referenceData: [],
      expected: { kind: "ok", value: 42 },
    },
    // R-2 の n・a・b。VIEW_SHOWS_DESIGN は項目の役割 record.amount を持つので、入力の鍵も役割 ID にする
    ...STRUCTURAL_CHECKS_SUITE.tests.slice(1, 4).map((test) => ({ ...test, input: { "record.amount": 21 } })),
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
    { roleId: "record", kind: "entity", entity: null, name: "記録", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.a", kind: "field", entity: "record", name: "項目A", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.b", kind: "field", entity: "record", name: "項目B", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.c", kind: "field", entity: "record", name: "項目C", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "other", kind: "entity", entity: null, name: "その他", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "other.a", kind: "field", entity: "other", name: "項目A", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "other.b", kind: "field", entity: "other", name: "項目B", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "other.c", kind: "field", entity: "other", name: "項目C", shared: true, aliasOf: null, options: null, groupBy: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "existence-only",
      verification: { kind: "structural", reason: "項目が一覧か表に出ていることを構造で確かめる" },
      vocabulary: ["field"],
      placement: ["entities[].fields"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "項目を載せる entity として参照するため" },
        { roleId: "record.a", basis: "stated", reason: null },
        { roleId: "record.b", basis: "stated", reason: null },
        { roleId: "record.c", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      nature: "existence-only",
      verification: { kind: "structural", reason: "項目が一覧か表に出ていることを構造で確かめる" },
      vocabulary: ["field"],
      placement: ["entities[].fields"],
      unwritable: [],
      ownership: [
        { roleId: "other", basis: "dependency", reason: "項目を載せる entity として参照するため" },
        { roleId: "other.a", basis: "stated", reason: null },
        { roleId: "other.b", basis: "stated", reason: null },
        { roleId: "other.c", basis: "stated", reason: null },
      ],
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
    const { recording, run } = runWith(recordedRunFour(), {
      source: SOURCE_TEXT_FOUR,
      designVersion: LEGACY_DESIGN_CONTRACT,
    });
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
        ...CREATE_DESIGN.designs[0],
        unwritable: [
          { part: "件数の数え方を決めていない", constraintIds: ["記録"], reason: "どちらの数え方か原文に無い" },
        ],
        notes: [],
      },
      {
        ...CREATE_DESIGN.designs[1],
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

// ── Build の裏付けに渡る ID と抜粋が正規化後のもの（Issue #398）──────────────

/** 判定の要求を記録する偽物の判定（仕分けと裏付けに渡る中身を見る） */
function recordingJudge(answers: Readonly<Record<string, JudgeAnswer>>): {
  readonly judge: Judge;
  readonly requests: JudgeRequest[];
} {
  const inner = createFakeJudge(answers);
  const requests: JudgeRequest[] = [];
  return {
    judge: {
      async judge(request: JudgeRequest): Promise<JudgeResponse> {
        requests.push(request);
        return inner.judge(request);
      },
    },
    requests,
  };
}

describe("Build の裏付けに渡る ID と抜粋が正規化後のもの（Issue #398）", () => {
  /** R-1 に、記号つきの見出し（### computed）を根拠にした「書けない」の申告を持つ設計（新契約） */
  const DESIGN_WITH_SYMBOL_CLAIM = {
    roles: DESIGN_OUTPUT_MAPPED.roles,
    designs: [
      {
        ...DESIGN_OUTPUT_MAPPED.designs[0],
        unwritable: [
          { part: "計算の並べ替えは書けない", constraintIds: ["### computed"], reason: "文書に欄が無い" },
        ],
        notes: [],
      },
      { ...DESIGN_OUTPUT_MAPPED.designs[1], notes: [] },
    ],
  };

  it("仕分けと裏付けの要求に、正規化後の ID と、その節の抜粋が載る", async () => {
    const { judge, requests } = recordingJudge({
      "triage:R-1:0": judgeChoice("vocabulary-hole", 0.9),
      "support:R-1:0": judgeChoice("supports", 0.9),
    });
    const { run } = runWith(recordedRun({ design: DESIGN_WITH_SYMBOL_CLAIM }), { judge });
    const result = await run;

    // 仕分けの問いに、正規化後の制約 ID（### computed → computed）が載る
    expect(requests[0]?.questions["triage:R-1:0"]?.instructions).toMatchObject({ constraintIds: ["computed"] });
    // 裏付けの問いに、その節（### computed の本文）の抜粋が載る
    const instructions = requests[1]?.questions["support:R-1:0"]?.instructions;
    const excerpt =
      typeof instructions === "object" ? (instructions as Record<string, unknown>)["excerpt"] : undefined;
    expect(String(excerpt)).toContain("計算の意味の説明。");
    // 申告は残るので部分案になる（門は緩めない）
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
    const withJudge = await runWith(recordedRun({ design: DESIGN_WITH_CLAIM }), {
      judge,
      designVersion: LEGACY_DESIGN_CONTRACT,
    }).run;
    const withoutJudge = await runWith(recordedRun({ design: DESIGN_WITH_CLAIM }), {
      designVersion: LEGACY_DESIGN_CONTRACT,
    }).run;

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
    // 問いの map）には足りない大きさにする。Issue #399 で low を medium（= high）と同じ値にした分、
    // 段の予約が大きくなったので、値を上げてある。
    const result = await runWith(recordedRun({ design }), {
      judge,
      effort: "low",
      budgetUsd: 0.15,
      designVersion: LEGACY_DESIGN_CONTRACT,
    }).run;

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
    const { run } = runWith(recordedRunFromPlan({ design: DESIGN_OUTPUT_PLANNED_PARTIAL }), {
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
    // さらに low を medium（= high）と同じ値にした分（Issue #399）、段の予約が大きくなったので、
    // 値を上げてある（この窓の外では、段の予約か判定の予約のどちらかが通ってしまい、この試験の
    // 前提が崩れる）。
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
      roles: [
        { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
      ],
      designs: requirements.map((requirement) => ({
        requirementId: requirement.id,
        nature: "existence-only",
        verification: { kind: "structural", reason: "在ることだけ" },
        vocabulary: [],
        placement: [],
        unwritable: [],
        ownership: [{ roleId: "record", basis: "stated", reason: null }],
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
    // 段の呼び出しの usage を欠けさせ、予約を残したままにする（Issue #399）。low を medium（= high）と
    // 同じ値にした分、段の予約が大きくなり、settle で戻ると「段は通るが判定の予約は断られる」窓が
    // ほぼ消える。予約を残せば、判定の手前の残高が判定の予約を下回るので、判定は呼ばれず ruled に倒れる
    // （幅のある窓で確かめられる）。**②' のデータが要件ごとの所属（ownership）も運ぶようになった分
    // （Issue #418）、値を上げてある。**
    const noUsage = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });
    const result = await runWith(
      [
        noUsage({ requirements, framing: [], decisions: [], unresolved: [] }),
        noUsage(REVERSE_CHECK_OUTPUT),
        noUsage(design),
        noUsage(suite),
        // 試験の段のあとの段（③）は、予算が尽きているか、この応答で形が合わずに止まる
        noUsage({}),
      ],
      { source, judge, budgetUsd: 0.5, effort: "low" },
    ).run;

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
      { plan: CONFIRMED_PLAN_ADDED, designVersion: LEGACY_DESIGN_CONTRACT },
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

// ── 誰でも行える操作を構造の検査で確かめる（02 §1.4・Issue #393）────────────────

const WRITE_CLOCK = "2026-09-16T12:00:00+09:00";

/** 操作（add・条件なし）と、read・write の権限、匿名の本人確認を持つ宣言（抽象的な題材） */
const WRITE_DECLARATION = [
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
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

/** 操作の種類が違う宣言（create ではなく delete） */
const WRITE_WRONG_KIND = WRITE_DECLARATION.replace("    kind: create", "    kind: delete");
/** 条件（when）を足した宣言（delete は when を持てる） */
const WRITE_WITH_WHEN = WRITE_DECLARATION.replace(
  "  - name: add\n    entity: record\n    kind: create\n",
  "  - name: add\n    entity: record\n    kind: delete\n    when: amount > 0\n",
);
/** 書き込みの権限（write）を外した宣言 */
const WRITE_NO_PERMISSION = WRITE_DECLARATION.replace("  - name: write\n    subject: minIdentity\n", "");
/** 対象の操作（add）を消して、別の操作（enrol）だけを残した宣言 */
const WRITE_NO_ACTION = WRITE_DECLARATION.replace(
  "  - name: add\n    entity: record\n    kind: create\n",
  "  - name: enrol\n    entity: record\n    kind: create\n",
);

/** ② の設計（R-1 は「誰でも直せる」を 3 つの構造の検査で確かめる。R-2 は固定した試験） */
const WRITE_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.add", kind: "operation", entity: "record", name: "add", shared: false, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: false, aliasOf: null, options: null, groupBy: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "existence-only",
      verification: { kind: "structural", reason: "誰でも直せることを構造で確かめる" },
      checks: ["action-kind", "action-unconditioned", "write-anonymous"],
      vocabulary: ["action"],
      placement: ["actions"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "操作の対象の entity として参照するため" },
        { roleId: "record.add", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      checks: [],
      vocabulary: ["computation"],
      placement: ["computed"],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "合計する行の所属として参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
    },
  ],
};

/** 誰でも直せる操作（R-1）の構造の検査 1 件 */
const writeStructureTest = (id: string, assertion: Record<string, unknown>): unknown => ({
  id,
  target: { requirementId: "R-1", kind: "operation", roleId: "record.add" },
  kind: "normal",
  operation: "structure",
  clock: WRITE_CLOCK,
  input: {},
  inputContract: { rowId: `${id}-row`, targetRowId: null, emptyEntities: [] },
  referenceData: [],
  expected: { kind: "ok", value: true },
  assertion,
});

/** ②' の答え（R-1 は種類・条件無し・誰でも書けるの 3 本、R-2 は計算の正常・異常・境界） */
const WRITE_SUITE = {
  classifications: [
    { requirementId: "R-1", nature: "existence-only" },
    { requirementId: "R-2", nature: "ruled" },
  ],
  tests: [
    writeStructureTest("sa", { check: "action-kind", expected: "create" }),
    writeStructureTest("su", { check: "action-unconditioned" }),
    writeStructureTest("sw", { check: "write-anonymous" }),
    ...STRUCTURAL_CHECKS_SUITE.tests.slice(1), // R-2 の n・a・b
  ],
};

/** ③ が提出する対応（役割 ID → 宣言の名前） */
const WRITE_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.add", name: "add" },
  { roleId: "record.total", name: "total" },
];

/** ⑤a の答え（R-1 は entity と操作 add、R-2 は計算 total） */
const WRITE_CORRESPONDENCE = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "action", entity: "record", name: "add" },
      ],
    },
    {
      requirementId: "R-2",
      // R-2 も entity `record` に依存として所属するので、要件ごとに載せる（Issue #431）
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
  ],
};

/** 宣言を差し替えて流す記録（①→①'→②→②'→③→⑤a） */
const writeRun = (declaration: string): readonly RecordedCall[] => [
  structured(REQUIREMENT_LIST_OUTPUT),
  structured(REVERSE_CHECK_OUTPUT),
  structured(WRITE_DESIGN),
  structured(WRITE_SUITE),
  structured({ declaration, mappings: WRITE_MAPPINGS }),
  structured(WRITE_CORRESPONDENCE),
];

describe("誰でも行える操作を構造の検査で確かめる（02 §1.4・Issue #393）", () => {
  it("3 つの構造の検査が成り立てば、合格（full）になり、write-anonymous の記録が残る", async () => {
    const { run } = runWith(writeRun(WRITE_DECLARATION));
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    if (result.bundle === null) throw new Error("納品物が無い");
    expect(verificationOf(result.bundle).structural_checks).toEqual([
      { test_id: "sa", requirement_id: "R-1", check: "action-kind", result: "pass", detail: expect.any(String) },
      { test_id: "su", requirement_id: "R-1", check: "action-unconditioned", result: "pass", detail: expect.any(String) },
      { test_id: "sw", requirement_id: "R-1", check: "write-anonymous", result: "pass", detail: expect.any(String) },
    ]);
  });

  it("操作が無ければ未解決になり、合格にならない（write-anonymous が unresolved で残る）", async () => {
    const { run } = runWith(writeRun(WRITE_NO_ACTION), {
      limits: { ...AGENT_LIMITS, repairRoundTrips: 0, correspondenceRedos: 0 },
    });
    const result = await run;

    expect(result.outcome.result).not.toBe("pass");
    if (result.bundle === null) throw new Error("納品物が無い");
    const writeCheck = verificationOf(result.bundle).structural_checks.find(
      (entry) => entry.check === "write-anonymous",
    );
    expect(writeCheck).toMatchObject({
      test_id: "sw",
      requirement_id: "R-1",
      check: "write-anonymous",
      result: "unresolved",
    });
  });

  it("操作の種類が違えば不一致になり、合格にならない", async () => {
    const { run } = runWith(writeRun(WRITE_WRONG_KIND), {
      limits: { ...AGENT_LIMITS, repairRoundTrips: 0, correspondenceRedos: 0 },
    });
    const result = await run;

    expect(result.outcome.result).not.toBe("pass");
    if (result.bundle === null) throw new Error("納品物が無い");
    const structural = verificationOf(result.bundle).structural_checks;
    expect(structural.find((entry) => entry.check === "action-kind")).toMatchObject({ result: "mismatch" });
    // 種類に依らない write-anonymous は成り立ったままである
    expect(structural.find((entry) => entry.check === "write-anonymous")).toMatchObject({ result: "pass" });
  });

  it("操作に条件（when）を足せば不一致になり、合格にならない", async () => {
    const { run } = runWith(writeRun(WRITE_WITH_WHEN), {
      limits: { ...AGENT_LIMITS, repairRoundTrips: 0, correspondenceRedos: 0 },
    });
    const result = await run;

    expect(result.outcome.result).not.toBe("pass");
    if (result.bundle === null) throw new Error("納品物が無い");
    const structural = verificationOf(result.bundle).structural_checks;
    expect(structural.find((entry) => entry.check === "action-unconditioned")).toMatchObject({ result: "mismatch" });
  });

  it("書き込みの権限（write）を外せば不一致になり、合格にならない", async () => {
    const { run } = runWith(writeRun(WRITE_NO_PERMISSION), {
      limits: { ...AGENT_LIMITS, repairRoundTrips: 0, correspondenceRedos: 0 },
    });
    const result = await run;

    expect(result.outcome.result).not.toBe("pass");
    if (result.bundle === null) throw new Error("納品物が無い");
    const structural = verificationOf(result.bundle).structural_checks;
    // action-kind・action-unconditioned は成り立っても、write-anonymous が不一致になる
    expect(structural.find((entry) => entry.check === "action-kind")).toMatchObject({ result: "pass" });
    expect(structural.find((entry) => entry.check === "action-unconditioned")).toMatchObject({ result: "pass" });
    expect(structural.find((entry) => entry.check === "write-anonymous")).toMatchObject({
      test_id: "sw",
      requirement_id: "R-1",
      result: "mismatch",
    });
  });
});

// ── 設計の段の中身の作り直し（Issue #407）────────────────────────────

/**
 * 代わりの案の要件（R-2）と、了承して除いた部分（`R-1-p1`）の参照を持つ確定した仕様（Issue #407）。
 * R-2 の文には、元の要件 R-1 の部分 R-1-p1 の文脈が添えられる（`requirementsFromPlan`）。
 */
const CONFIRMED_PLAN_ALTERNATIVE: ConfirmedPlan = {
  ...CONFIRMED_PLAN,
  plan_id: "plan-test-alternative",
  requirements: [
    { ...CONFIRMED_PLAN.requirements[0]!, parts: [{ id: "R-1-p1", text: "記録の並べ替え", disposition: "accepted_removal" }] },
    CONFIRMED_PLAN.requirements[1]!,
  ],
  accepted_unwritable: [
    {
      part_id: "R-1-p1",
      alternative_id: "R-2",
      basis: { doc_version: "v1", location: "contract", constraint_id: "R-1" },
    },
  ],
};

/** 代わりの案（R-2）の設計を落とした応答（R-1 の設計だけ。新形式） */
const DESIGN_MISSING_R2_MAPPED = {
  roles: DESIGN_OUTPUT_MAPPED.roles,
  designs: [DESIGN_OUTPUT_MAPPED.designs[0]],
};

/** ③ が提出する対応（役割 ID → 宣言の名前。R-1 は total、R-2 は extra） */
const ALT_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.total", name: "total" },
  { roleId: "record.extra", name: "extra" },
];

/** ⑤a の対応表（役割 `record` の場所も挙げ、③ のやり直しに入らないようにする） */
const ALT_CORRESPONDENCE = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
    {
      requirementId: "R-2",
      // R-2 も entity `record` に依存として所属するので、要件ごとに載せる（Issue #431）
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "computation", entity: "record", name: "extra" },
      ],
    },
  ],
};

/** 確定した仕様の代わりの案で流す記録（② の応答 2 回→②'→③→⑤a） */
const alternativeRun = (design: unknown, redo: unknown): readonly RecordedCall[] => [
  structured(design),
  structured(redo),
  structured(TEST_SUITE_OUTPUT_MAPPED),
  structured({ declaration: DECLARATION_SOURCE, mappings: ALT_MAPPINGS }),
  structured(ALT_CORRESPONDENCE),
];

describe("設計の段の中身の作り直し（§5・Issue #407）", () => {
  it("② の 1 回目が代わりの案の設計を落とし、2 回目で直して完走する（design は ok・calls 2）", async () => {
    const { recording, run } = runWith(alternativeRun(DESIGN_MISSING_R2_MAPPED, DESIGN_OUTPUT_MAPPED), {
      plan: CONFIRMED_PLAN_ALTERNATIVE,
    });
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    // 設計の段は 2 回呼ぶ（1 回目は R-2 の設計が無く、2 回目で直る）
    const design = result.record.stages.find((stage) => stage.stage === "design");
    expect(design).toMatchObject({ status: "ok", calls: 2 });
    // ② のデータの要件の文に、代わりの案の文脈が入る
    const designRequest = recording.structured.find((request) => request.schemaName === DESIGN_SCHEMA_NAME);
    expect(designRequest?.input).toContain("要件 R-1 の部分 R-1-p1");
    expect(designRequest?.input).toContain("記録の並べ替え");
    expect(designRequest?.input).toContain("の代わりの案");
  });

  it("2 回とも代わりの案の設計を落とせば、設計の段で未達として止まる（design は failed・calls 2）", async () => {
    const { run } = runWith(
      [structured(DESIGN_MISSING_R2_MAPPED), structured(DESIGN_MISSING_R2_MAPPED)],
      { plan: CONFIRMED_PLAN_ALTERNATIVE },
    );
    const result = await run;

    expect(result.stopped).toMatchObject({ stage: "design", kind: "unmet" });
    expect(result.record.failure).toMatchObject({ stage: "design", kind: "unmet" });
    const design = result.record.stages.find((stage) => stage.stage === "design");
    expect(design).toMatchObject({ status: "failed", calls: 2, failure_kind: "unmet" });
    expect(result.bundle).toBeNull();
  });
});

// ── 値の鍵と行の ID（§1・②'・Issue #409）────────────────────────────

/** entity・項目（record.amount）・計算（record.total）を持つ設計（値の鍵の検査が掛かる） */
const KEY_RUN_DESIGN = {
  roles: [
    { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.amount", kind: "field", entity: "record", name: "amount", shared: true, aliasOf: null, options: null, groupBy: null },
    { roleId: "record.total", kind: "computation", entity: "record", name: "total", shared: true, aliasOf: null, options: null, groupBy: null },
  ],
  designs: [
    {
      requirementId: "R-1",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "評価する行の所属として参照するため" },
        { roleId: "record.amount", basis: "dependency", reason: "入力の行に保存する項目として参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
    },
    {
      requirementId: "R-2",
      nature: "ruled",
      verification: { kind: "fixed-test" },
      vocabulary: [],
      placement: [],
      unwritable: [],
      ownership: [
        { roleId: "record", basis: "dependency", reason: "評価する行の所属として参照するため" },
        { roleId: "record.amount", basis: "dependency", reason: "入力の行に保存する項目として参照するため" },
        { roleId: "record.total", basis: "stated", reason: null },
      ],
    },
  ],
};

/** 要件の正常・異常・境界（`record.total` を対象にする。入力の鍵は項目の役割 ID `record.amount`） */
function keyRunTriple(requirementId: string): readonly Record<string, unknown>[] {
  return (["normal", "abnormal", "boundary"] as const).map((kind, index) => ({
    id: `${requirementId}-${index}`,
    target: { requirementId, kind: "computation", roleId: "record.total" },
    kind,
    operation: "compute",
    clock: CREATE_CLOCK,
    input: { "record.amount": 21 },
    inputContract: { rowId: `${requirementId}-${index}-row`, targetRowId: null, emptyEntities: [] },
    referenceData: [],
    expected: { kind: "ok", value: 42 },
  }));
}

/** 1 件目（R-1 の正常）の参照の行の値だけを差し替えた ②' の応答 */
function keyRunSuite(values: Readonly<Record<string, unknown>>): { readonly tests: readonly Record<string, unknown>[] } {
  return {
    tests: [...keyRunTriple("R-1"), ...keyRunTriple("R-2")].map((test, index) =>
      index === 0
        ? {
            ...test,
            referenceData: [{ rowId: "row-2", target: { requirementId: "R-1", kind: "entity", roleId: "record" }, values }],
          }
        : test,
    ),
  };
}

/** ③ が書く宣言（`records` は `amount` と `total` を出すので、どちらも画面から辿れる） */
const KEY_RUN_DECLARATION = [
  "entities:",
  "  - name: record",
  "    fields:",
  "      amount: number",
  "views:",
  "  - name: records",
  "    type: list",
  "    entity: record",
  "    show: [amount, total]",
  "actions: []",
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

/** ③ が提出する対応（役割 ID → 宣言の名前） */
const KEY_RUN_MAPPINGS = [
  { roleId: "record", name: "record" },
  { roleId: "record.amount", name: "amount" },
  { roleId: "record.total", name: "total" },
];

/** ⑤a の答え（実在し画面から辿れる場所だけを挙げる） */
const KEY_RUN_CORRESPONDENCE = {
  entries: [
    {
      requirementId: "R-1",
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "field", entity: "record", name: "amount" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
    {
      requirementId: "R-2",
      // R-2 も entity `record`・項目 `amount`・計算 `total` に所属するので、要件ごとに載せる（Issue #431）
      locations: [
        { kind: "entity", entity: null, name: "record" },
        { kind: "field", entity: "record", name: "amount" },
        { kind: "computation", entity: "record", name: "total" },
      ],
    },
  ],
};

describe("値の鍵と行の ID（§1・②'・Issue #409）", () => {
  it("参照の行に id を書いた ②' の応答を 1 回目に、直した応答を 2 回目に返すと、⑤b まで未解決 0 で完走する", async () => {
    const { recording, run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(KEY_RUN_DESIGN),
      structured(keyRunSuite({ id: "row-9" })), // 1 回目：参照の行の値の鍵が行の ID
      structured(keyRunSuite({ "record.amount": 9 })), // 2 回目：直した応答
      structured({ declaration: KEY_RUN_DECLARATION, mappings: KEY_RUN_MAPPINGS }),
      structured(KEY_RUN_CORRESPONDENCE),
    ]);
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    if (result.bundle === null) throw new Error("納品物が無い");
    const verification = verificationOf(result.bundle);
    expect(verification.test_unresolved).toBe(0);
    expect(verification.test_mismatches).toBe(0);
    // ②' は 2 回呼ぶ（1 回目は値の鍵の誤り、2 回目で直る）
    expect(recording.structured.filter((request) => request.schemaName === TEST_SUITE_SCHEMA_NAME)).toHaveLength(2);
  });
});

// ── 仕分けが呼ぶ設計のやり直しを段の記録に残す（Issue #410）────────────────────

/** やり直しの対象になる申告（R-1。制約 ID は文書の見出しにある `記録`） */
const REDO_PART = "記録の並べ替えは書けない";

/** R-1 に語彙の穴の申告を 1 件持つ設計（新形式。R-2 は申告なし。所属は CREATE_DESIGN と同じ） */
const REDO_DESIGN_ORIGINAL = {
  roles: CREATE_DESIGN.roles,
  designs: [
    {
      ...CREATE_DESIGN.designs[0],
      unwritable: [{ part: REDO_PART, constraintIds: ["記録"], reason: "文書に欄が無い" }],
      notes: [],
    },
    {
      ...CREATE_DESIGN.designs[1],
      unwritable: [],
      notes: [],
    },
  ],
};

/** やり直しの応答（R-1 の設計だけ。申告は無い＝やり直しが成功する） */
const REDO_DESIGN_OK = { roles: CREATE_DESIGN.roles, designs: [CREATE_DESIGN.designs[0]] };

/** やり直しの応答（R-1 の設計が無い＝中身の点検に落ちる。未達） */
const REDO_DESIGN_UNMET = { roles: CREATE_DESIGN.roles, designs: [] };

/** 仕分けが「語彙の穴 → 反する」を返す偽物の判定（実 API は呼ばない） */
const redoJudge = createFakeJudge({
  "triage:R-1:0": judgeChoice("vocabulary-hole", 0.9),
  "support:R-1:0": judgeChoice("contradicts", 0.9),
});

/** R-2 の異常の期待を直した ②' の答え（⑥ に入らずに完走する） */
const REDO_PASSING_SUITE = {
  classifications: CREATE_SUITE.classifications,
  tests: CREATE_SUITE.tests.map((test) =>
    test.id === "a" ? { ...test, expected: { kind: "ok", value: 42 } } : test,
  ),
};

/** 記録の並び（①→①'→②→[やり直し]→②'→③→⑤a） */
const trackedRedo = (redo: readonly RecordedCall[]): readonly RecordedCall[] => [
  structured(REQUIREMENT_LIST_OUTPUT),
  structured(REVERSE_CHECK_OUTPUT),
  structured(REDO_DESIGN_ORIGINAL),
  ...redo,
  structured(REDO_PASSING_SUITE),
  structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
  structured(CREATE_CORRESPONDENCE),
];

/** 中身の点検に入る前に例外を投げる応答（予期しない例外の経路を作る） */
function throwingDesignOutput(): unknown {
  const output: Record<string, unknown> = {};
  Object.defineProperty(output, "designs", {
    get() {
      throw new Error("予期しない誤り");
    },
  });
  return output;
}

/** 仕分けは費用を掛けず、裏付けの 1 回で予算を使い切る偽物の判定（予約で断られる予算を作る） */
function drainingJudge(huge: LlmUsage): Judge {
  let calls = 0;
  return {
    async judge(request: JudgeRequest): Promise<JudgeResponse> {
      calls += 1;
      const answers: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(request.questions)) {
        answers[name] = name.startsWith("triage:")
          ? judgeChoice("vocabulary-hole", 0.9)
          : judgeChoice("contradicts", 0.9);
      }
      if (calls === 1) {
        return { answers, inputTokens: 0, model: "fake-judge", answeredBy: "fake" };
      }
      return { answers, inputTokens: huge.inputTokens, usage: huge, model: "gpt-judge", answeredBy: "llm" };
    },
  };
}

/** 段の記録から、その段の費用（USD）を数える（`costOfUsageUsd` と同じ式） */
const stageCostUsd = (stage: {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
}): number =>
  costOfUsageUsd(
    {
      inputTokens: stage.input_tokens,
      cachedInputTokens: stage.cached_input_tokens,
      cacheWriteTokens: stage.cache_write_tokens,
      outputTokens: stage.output_tokens,
      reasoningTokens: stage.reasoning_tokens,
    },
    RATES,
  );

describe("仕分けが呼ぶ設計のやり直しを段の記録に残す（Issue #410）", () => {
  it("やり直しが成功すると、design が 2 件になり、2 件目は operation が redo-design・status が ok・calls 1・トークンは usage と一致する", async () => {
    const { run } = runWith(trackedRedo([structured(REDO_DESIGN_OK)]), { judge: redoJudge });
    const result = await run;

    expect(result.stopped).toBeNull();
    // 仕分けの結果（やり直した設計を採る・申告が無い）と verdict は変わらない
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });

    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs).toHaveLength(2);
    expect(designs[0]).toMatchObject({ status: "ok", operation: null });
    expect(designs[1]).toMatchObject({
      operation: "redo-design",
      status: "ok",
      calls: 1,
      missing_usage_calls: 0,
      input_tokens: USAGE.inputTokens,
      cached_input_tokens: USAGE.cachedInputTokens,
      cache_write_tokens: 0,
      output_tokens: USAGE.outputTokens,
      reasoning_tokens: USAGE.reasoningTokens,
      failure_kind: null,
    });
    // ほかの段の operation は null
    for (const stage of result.record.stages) {
      if (stage === designs[1]) continue;
      expect(stage.operation, stage.stage).toBeNull();
    }
    // やり直した設計を採り、申告が無い
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const list = unwritableOf(result.bundle);
    expect(list.unwritable).toEqual([]);
    expect(list.marked_requirements).toEqual([]);
    expect(list.triage.map((entry) => entry.answer)).toEqual(["vocabulary-hole", "contradicts"]);
  });

  it("やり直しが 2 回とも中身の点検に落ちると、2 件目は failed・unmet・calls 2 で残り、後段の応答を消費せず、走りは止まらず終端は同じ", async () => {
    const { recording, run } = runWith(
      trackedRedo([structured(REDO_DESIGN_UNMET), structured(REDO_DESIGN_UNMET)]),
      { judge: redoJudge },
    );
    const result = await run;

    expect(result.stopped).toBeNull();
    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]).toMatchObject({
      operation: "redo-design",
      status: "failed",
      failure_kind: "unmet",
      calls: 2,
    });
    // 後段の応答を消費していない（② は 3 回＝① の 1 回＋やり直しの 2 ラウンド、②' は 1 回だけ）
    expect(recording.structured.filter((request) => request.schemaName === DESIGN_SCHEMA_NAME)).toHaveLength(3);
    expect(recording.structured.filter((request) => request.schemaName === TEST_SUITE_SCHEMA_NAME)).toHaveLength(1);
    // 仕分けは申告を印つきで残す
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const list = unwritableOf(result.bundle);
    expect(list.marked_requirements).toEqual(["R-1"]);
    expect(list.unwritable.map((entry) => entry.requirementId)).toEqual(["R-1"]);
    // 終端は同じ（止まらず、部分案）
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
  });

  it("予約が断られる予算では、2 件目は failed・budget で残り、追加の要求を出さず、終端は同じ", async () => {
    const huge: LlmUsage = { inputTokens: 10_000_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const judge = drainingJudge(huge);
    const { recording, run } = runWith(trackedRedo([]), { judge });
    const result = await run;

    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]).toMatchObject({
      operation: "redo-design",
      status: "failed",
      failure_kind: "budget",
      calls: 0,
    });
    // やり直しは予約で断られ、要求を出していない（①・①'・② の 3 回だけ）
    expect(recording.structured).toHaveLength(3);
    // 終端は同じ（予算切れで止まる）
    expect(result.stopped?.kind).toBe("budget");
  });

  it("複数の申告を持つ例で、段の失敗では対象の要件だけ印つきで残る", async () => {
    const design = {
      roles: CREATE_DESIGN.roles,
      designs: [
        {
          ...CREATE_DESIGN.designs[0],
          unwritable: [
            { part: "記録の並べ替えは書けない", constraintIds: ["記録"], reason: "文書に欄が無い" },
            { part: "記録の見出しの付け方は書けない", constraintIds: ["記録"], reason: "文書に欄が無い" },
          ],
          notes: [],
        },
        {
          ...CREATE_DESIGN.designs[1],
          unwritable: [],
          notes: [],
        },
      ],
    };
    const judge = createFakeJudge({
      "triage:R-1:0": judgeChoice("vocabulary-hole", 0.9),
      "triage:R-1:1": judgeChoice("vocabulary-hole", 0.9),
      "support:R-1:0": judgeChoice("contradicts", 0.9),
      "support:R-1:1": judgeChoice("contradicts", 0.9),
    });
    const { run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(design),
        structured(REDO_DESIGN_UNMET),
        structured(REDO_DESIGN_UNMET),
        structured(REDO_PASSING_SUITE),
        structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
        structured(CREATE_CORRESPONDENCE),
      ],
      { judge },
    );
    const result = await run;

    expect(result.stopped).toBeNull();
    // やり直しは要件 R-1 につき 1 回だけ（calls 2 は中身の 2 ラウンド）
    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs[1]).toMatchObject({
      operation: "redo-design",
      status: "failed",
      failure_kind: "unmet",
      calls: 2,
    });
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const list = unwritableOf(result.bundle);
    // 対象の要件 R-1 だけ印つき（R-2 は申告が無く触らない）
    expect(list.marked_requirements).toEqual(["R-1"]);
    expect(list.unwritable.map((entry) => entry.requirementId)).toEqual(["R-1"]);
    expect(list.unwritable[0]?.unwritable).toHaveLength(2);
  });

  it("予期しない例外では、failed・unknown の記録を残し、仕分け全体を採らず元の設計に戻る", async () => {
    const { run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(REDO_DESIGN_ORIGINAL),
        structured(throwingDesignOutput()),
        structured(REDO_PASSING_SUITE),
        structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
        structured(CREATE_CORRESPONDENCE),
      ],
      { judge: redoJudge },
    );
    const result = await run;

    expect(result.stopped).toBeNull();
    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]).toMatchObject({
      operation: "redo-design",
      status: "failed",
      failure_kind: "unknown",
    });
    // 仕分け全体を採らない（判定の記録が無い）＝元の設計に戻る（R-1 の申告が残る）
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const list = unwritableOf(result.bundle);
    expect(list.triage).toEqual([]);
    expect(list.unwritable.map((entry) => entry.requirementId)).toEqual(["R-1"]);
    expect(list.unwritable[0]?.unwritable).toEqual([REDO_PART]);
  });

  it("usage が全件ある走りで、段の費用の合計＋判定の費用が provider_cost_usd と一致し、やり直しの記録を除くと一致しない", async () => {
    const { run } = runWith(trackedRedo([structured(REDO_DESIGN_OK)]), { judge: redoJudge });
    const result = await run;

    const provider = result.summary.provider_cost_usd ?? 0;
    const all = result.record.stages.reduce((sum, stage) => sum + stageCostUsd(stage), 0);
    expect(all + result.summary.judge.cost_usd).toBeCloseTo(provider, 12);
    // やり直しの記録（operation が redo-design）を外すと、1 要件の設計 1 回分（0.0002 USD）だけずれる
    const withoutRedo = result.record.stages.filter((stage) => stage.operation !== "redo-design");
    expect(withoutRedo.reduce((sum, stage) => sum + stageCostUsd(stage), 0) + result.summary.judge.cost_usd).not.toBeCloseTo(
      provider,
      12,
    );
  });

  it("usage の欠けた呼び出しがある走りでは、その段の missing_usage_calls で別に確かめる", async () => {
    const { run } = runWith(trackedRedo([noUsageCall(REDO_DESIGN_OK)]), { judge: redoJudge });
    const result = await run;

    expect(result.stopped).toBeNull();
    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs[1]).toMatchObject({
      operation: "redo-design",
      status: "ok",
      calls: 1,
      missing_usage_calls: 1,
      input_tokens: 0,
      output_tokens: 0,
    });
  });
});

// ── 設計のやり直しの記録を組む包み（Issue #410）────────────────────────────

/** 包みが足す記録を集める口（段の失敗と例外の 2 経路を直接見る） */
function collector(): {
  readonly pushed: { status: string; kind: string | null }[];
  readonly push: (status: "ok" | "failed", durationMs: number, failureKind: string | null) => void;
} {
  const pushed: { status: string; kind: string | null }[] = [];
  return {
    pushed,
    push: (status, _durationMs, failureKind) => {
      pushed.push({ status, kind: failureKind });
    },
  };
}

describe("設計のやり直しの記録を組む包み（Issue #410）", () => {
  it("段が成功すると、ok の記録を足して値を返す", async () => {
    const { pushed, push } = collector();
    const value = await redoDesignRecorded({
      call: async () => ({ ok: true as const, value: { designs: ["R-1"] } }),
      now: () => 0,
      push,
    });
    expect(value).toEqual({ designs: ["R-1"] });
    expect(pushed).toEqual([{ status: "ok", kind: null }]);
  });

  it("段の失敗では、failed の記録を足して undefined を返す", async () => {
    const { pushed, push } = collector();
    const value = await redoDesignRecorded<unknown>({
      call: async () => ({ ok: false, failure: { kind: "unmet", attempts: 2, problems: [] } }),
      now: () => 0,
      push,
    });
    expect(value).toBeUndefined();
    expect(pushed).toEqual([{ status: "failed", kind: "unmet" }]);
  });

  it("予約が断られる予算では、failed・budget で残す", async () => {
    const { pushed, push } = collector();
    const value = await redoDesignRecorded<unknown>({
      call: async () => ({ ok: false, failure: { kind: "budget", maxCostUsd: 1, remainingUsd: 0 } }),
      now: () => 0,
      push,
    });
    expect(value).toBeUndefined();
    expect(pushed).toEqual([{ status: "failed", kind: "budget" }]);
  });

  it("予期しない例外では、failed（unknown）の記録を足して同じ例外を投げ直す", async () => {
    const boom = new Error("予期しない例外");
    const { pushed, push } = collector();
    await expect(
      redoDesignRecorded<unknown>({
        call: async () => {
          throw boom;
        },
        now: () => 0,
        push,
      }),
    ).rejects.toBe(boom);
    expect(pushed).toEqual([{ status: "failed", kind: "unknown" }]);
  });
});

// ── 早期停止でも、受理した材料を診断に残す（§1.4・§4・Issue #417）──────────────

describe("早期停止でも、受理した材料を診断に残す（Issue #417）", () => {
  it("②' が 2 回とも形に合わず malformed で止まっても、受理した設計は診断に残る", async () => {
    const malformed = { tests: 123 };
    const { run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(DESIGN_OUTPUT),
        structured(malformed),
        structured(malformed),
      ],
      { designVersion: LEGACY_DESIGN_CONTRACT },
    );
    const result = await run;

    // 止め方（stopped・outcome・要約の exit_code・stop_reason・bundle）は今までどおり
    expect(result.stopped?.stage).toBe("test-suite");
    expect(result.stopped?.kind).toBe("malformed");
    expect(result.outcome).toEqual({ result: "failed", verdict: "none" });
    expect(result.bundle).toBeNull();
    expect(result.summary.exit_code).toBe(1);
    expect(result.summary.stop_reason).toBe("malformed");

    // 一覧：設計は受理済み、試験は未受理（段は実行したが材料を採れなかった）、対応・宣言・評価は未実行
    expect(listingOf(result.diagnostics).stopped).toEqual({ stage: "test-suite", kind: "malformed" });
    expect(stateOf(result.diagnostics, "design")).toBe("accepted");
    expect(stateOf(result.diagnostics, "test_suite")).toBe("unaccepted");
    expect(stateOf(result.diagnostics, "mappings")).toBe("unexecuted");
    expect(stateOf(result.diagnostics, "declaration")).toBe("unexecuted");
    expect(stateOf(result.diagnostics, "evaluation")).toBe("unexecuted");

    // 設計のファイルはあり、試験・宣言・manifest のファイルは無い
    const paths = result.diagnostics.map((artifact) => artifact.path);
    expect(paths).toContain(DIAGNOSTICS_DESIGN_FILE);
    expect(paths).not.toContain(DIAGNOSTICS_TEST_SUITE_FILE);
    expect(paths).not.toContain(DIAGNOSTICS_DECLARATION_FILE);
    expect(paths).not.toContain(BUNDLE_MANIFEST_FILE);
  });

  it("④ を通った後に ⑤a で締切に当たると、静的チェック通過の評価と受理した材料が診断に残る", async () => {
    const recording = createRecordingClient(recordedRun());
    const clock = { value: 0 };
    // 5 回目（③）のあとで時計を進め、6 回目（⑤a）で締切に当てる
    const client = clientWithClockJump(recording, 5, 2_000, clock);
    const result = await runGeneration(makeRunInput(client, { now: () => clock.value, deadline: 1_000 }));

    expect(result.bundle).toBeNull();
    expect(result.stopped).toEqual({ stage: "correspondence", kind: "deadline" });
    expect(result.summary.exit_code).toBe(1);

    // 設計・試験・対応は受理済み、⑤a は未受理、⑤b は未実行、宣言は候補（静的通過・最終判定なし）
    expect(stateOf(result.diagnostics, "design")).toBe("accepted");
    expect(stateOf(result.diagnostics, "test_suite")).toBe("accepted");
    expect(stateOf(result.diagnostics, "mappings")).toBe("accepted");
    expect(stateOf(result.diagnostics, "correspondence")).toBe("unaccepted");
    expect(stateOf(result.diagnostics, "test_run")).toBe("unexecuted");
    expect(stateOf(result.diagnostics, "declaration")).toBe("candidate");
    expect(
      listingOf(result.diagnostics).materials.find((entry) => entry.material === "declaration")?.static_check_passed,
    ).toBe(true);

    // 一覧に、**静的チェック通過の評価の行**がある。⑤a は実行していないので、落ちの件数は 0 ではなく未実行
    const listing = JSON.parse(diagnosticTextOf(result.diagnostics, DIAGNOSTICS_LISTING_FILE)) as {
      evaluations: readonly { static_check_passed: boolean; correspondence_misses: unknown }[];
    };
    expect(listing.evaluations.some((row) => row.static_check_passed)).toBe(true);
    expect(listing.evaluations.at(-1)?.correspondence_misses).toBe("unexecuted");
    // 静的チェックを実行したので、その診断のファイルもある
    expect(result.diagnostics.map((artifact) => artifact.path)).toContain(DIAGNOSTICS_STATIC_CHECK_FILE);
  });

  it("⑥ の途中で締切に当たると、最後に静的チェックを通った版の宣言と、版ごとの評価が診断に残る", async () => {
    const recording = createRecordingClient([
      ...recordedRun({ write: DECLARATION_SOURCE_MISMATCH }),
      toolDone({ declaration: DECLARATION_SOURCE, disputes: [] }),
    ]);
    const clock = { value: 0 };
    // 6 回目（⑤a）のあとで時計を進め、⑥（道具付き）で締切に当てる
    const client = clientWithClockJump(recording, 6, 2_000, clock);
    const result = await runGeneration(makeRunInput(client, { now: () => clock.value, deadline: 1_000 }));

    expect(result.bundle).toBeNull();
    expect(result.stopped).toEqual({ stage: "repair", kind: "deadline" });

    // 設計・試験・対応は受理済み。最後に静的チェックを通った版の宣言が候補（静的通過・最終判定なし）
    expect(stateOf(result.diagnostics, "design")).toBe("accepted");
    expect(stateOf(result.diagnostics, "test_suite")).toBe("accepted");
    expect(stateOf(result.diagnostics, "mappings")).toBe("accepted");
    expect(stateOf(result.diagnostics, "declaration")).toBe("candidate");
    expect(
      listingOf(result.diagnostics).materials.find((entry) => entry.material === "declaration")?.static_check_passed,
    ).toBe(true);

    // 版ごとの評価の行と、回数が一覧にある（回数は段の記録と整合する）
    const listing = JSON.parse(diagnosticTextOf(result.diagnostics, DIAGNOSTICS_LISTING_FILE)) as {
      evaluations: readonly unknown[];
      counts: {
        evaluations: number;
        write_initial: number;
        write_redos: number;
        correspondence_generations: number;
        repair_executions: number;
      };
    };
    expect(listing.evaluations.length).toBeGreaterThanOrEqual(1);
    expect(listing.counts).toEqual({
      evaluations: 1,
      write_initial: 1,
      write_redos: 0,
      correspondence_generations: 1,
      repair_executions: 1,
    });
  });
});

// ── 設計の契約：所属と選択肢（§1・②・Issue #418）──────────────────────

describe("設計の契約：所属と選択肢（Issue #418）", () => {
  it("新契約の fixture で ①〜⑦ が完走し、②' の要求のデータに options 込みの表と所属が入る", async () => {
    const { recording, run } = runWith(recordedRun());
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const request = recording.structured.find((candidate) => candidate.schemaName === TEST_SUITE_SCHEMA_NAME);
    expect(request?.input).toContain("役割 ID の表");
    expect(request?.input).toContain("options");
    expect(request?.input).toContain("要件ごとの所属");
  });

  it("版を省いた走りは新契約（所属の無い応答が形の誤りで止まる）", async () => {
    // 旧形式の設計（役割の表・所属・options を持たない）を、互換を明示せずに渡す
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(DESIGN_OUTPUT),
      structured(DESIGN_OUTPUT),
    ]);
    const result = await run;

    expect(result.stopped).toMatchObject({ stage: "design", kind: "malformed" });
    expect(result.bundle).toBeNull();
  });

  it("差し替えた全体の所属を壊す作り直しの設計は採らず、記録は failed・unmet・calls 2 で、元の申告を印つきで残し、終端は同じ", async () => {
    // 表は固定のまま、対象の要件の所属だけを空にする（全体の所属が壊れる）
    const brokenOwnership = {
      roles: CREATE_DESIGN.roles,
      designs: [{ ...CREATE_DESIGN.designs[0], ownership: [] }],
    };
    const { recording, run } = runWith(
      trackedRedo([structured(brokenOwnership), structured(brokenOwnership)]),
      { judge: redoJudge },
    );
    const result = await run;

    // 走りは止まらない（終端は同じ＝部分案）
    expect(result.stopped).toBeNull();
    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]).toMatchObject({
      operation: "redo-design",
      status: "failed",
      failure_kind: "unmet",
      calls: 2,
    });
    // 1 要件 1 callback（中身の 2 ラウンドだけ）。後段の応答を消費していない
    expect(recording.structured.filter((request) => request.schemaName === TEST_SUITE_SCHEMA_NAME)).toHaveLength(1);
    expect(result.bundle).not.toBeNull();
    if (result.bundle === null) return;
    const list = unwritableOf(result.bundle);
    expect(list.marked_requirements).toEqual(["R-1"]);
    expect(list.unwritable.map((entry) => entry.requirementId)).toEqual(["R-1"]);
    expect(result.outcome).toEqual({ result: "partial", verdict: "partial" });
  });

  it("整合する作り直しの設計は採る（既存の #410 の成功例と同じく、表は元のまま）", async () => {
    const { run } = runWith(trackedRedo([structured(REDO_DESIGN_OK)]), { judge: redoJudge });
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs[1]).toMatchObject({ operation: "redo-design", status: "ok" });
    const list = unwritableOf(result.bundle!);
    expect(list.unwritable).toEqual([]);
  });

  it("2 要件を続けて作り直すと、2 件目の基準に 1 件目の採用が反映され、採用後も共有・全役割の所属が成立する", async () => {
    const designTwoClaims = {
      roles: CREATE_DESIGN.roles,
      designs: [
        {
          ...CREATE_DESIGN.designs[0],
          unwritable: [{ part: "記録の並べ替えは書けない", constraintIds: ["記録"], reason: "文書に欄が無い" }],
          notes: [],
        },
        {
          ...CREATE_DESIGN.designs[1],
          unwritable: [{ part: "合計の丸め方は書けない", constraintIds: ["記録"], reason: "文書に欄が無い" }],
          notes: [],
        },
      ],
    };
    // 1 件目（R-1）のやり直しの所属に、目印の理由を入れる
    const redoR1 = {
      roles: CREATE_DESIGN.roles,
      designs: [
        {
          ...CREATE_DESIGN.designs[0],
          ownership: [
            { roleId: "record", basis: "dependency", reason: "REDO-R1-REASON" },
            { roleId: "record.add", basis: "stated", reason: null },
          ],
        },
      ],
    };
    const redoR2 = { roles: CREATE_DESIGN.roles, designs: [CREATE_DESIGN.designs[1]] };
    const judge = createFakeJudge({
      "triage:R-1:0": judgeChoice("vocabulary-hole", 0.9),
      "triage:R-2:0": judgeChoice("vocabulary-hole", 0.9),
      "support:R-1:0": judgeChoice("contradicts", 0.9),
      "support:R-2:0": judgeChoice("contradicts", 0.9),
    });
    const { recording, run } = runWith(
      [
        structured(REQUIREMENT_LIST_OUTPUT),
        structured(REVERSE_CHECK_OUTPUT),
        structured(designTwoClaims),
        structured(redoR1),
        structured(redoR2),
        structured(REDO_PASSING_SUITE),
        structured({ declaration: CREATE_DECLARATION, mappings: CREATE_MAPPINGS }),
        structured(CREATE_CORRESPONDENCE),
      ],
      { judge },
    );
    const result = await run;

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    // 初回 1 件＋作り直し 2 件
    expect(designs.filter((stage) => stage.operation === "redo-design")).toHaveLength(2);
    // 2 件目の作り直しの要求のデータに、1 件目の採用（目印の理由）が入る
    const designRequests = recording.structured.filter((request) => request.schemaName === DESIGN_SCHEMA_NAME);
    expect(designRequests.some((request) => request.input.includes("REDO-R1-REASON"))).toBe(true);
  });

  it("目印を入れた不正な所属・options・reason で止まる例で、要約と段の失敗の記録にその目印が無い", async () => {
    const marker = "MARKER418";
    const badDesign = {
      roles: [
        { roleId: "record", kind: "entity", entity: null, name: "record", shared: true, aliasOf: null, options: null, groupBy: null },
        { roleId: `record.${marker}`, kind: "field", entity: "record", name: marker, shared: false, aliasOf: null, options: [`${marker}-option`], groupBy: null },
      ],
      designs: [
        {
          requirementId: "R-1",
          nature: "ruled",
          verification: { kind: "fixed-test" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [{ roleId: `ghost-${marker}`, basis: "dependency", reason: `${marker}-reason` }],
        },
        {
          requirementId: "R-2",
          nature: "existence-only",
          verification: { kind: "structural", reason: "在ることだけ" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [],
        },
      ],
    };
    const { run } = runWith([structured(REQUIREMENT_LIST_OUTPUT), structured(REVERSE_CHECK_OUTPUT), structured(badDesign), structured(badDesign)]);
    const result = await run;

    expect(result.stopped).toMatchObject({ stage: "design", kind: "unmet" });
    expect(JSON.stringify(result.summary)).not.toContain(marker);
    expect(JSON.stringify(result.record)).not.toContain(marker);
    expect(JSON.stringify(result.diagnostics)).not.toContain(marker);
  });
});

// ── 2 つの直す段にまたがる、道具の累計の上限（02 §1.5・Issue #429）──────────────
//
// ⑥ の道具の実行は、**ジョブ全体の累計**（共通の口の `toolCalls`）を実行の前に照らして断る（§1.5）。
// 1 つの段で収まっても、⑥ を複数回回せばジョブ全体の線を越えうる——**段の局所で数え直さない**ことを、
// 2 つの直す段を続けて回す走りで固定する。**実 API は呼ばない。**

/**
 * 記録した応答を順に返す偽物。**直す段ごとに会話が切れる**ことを許す（`turns` は確かめない）——
 * 本物の記録の偽物（llm-fake.ts）は往復の順をジョブ全体で通して確かめるので、段が変わって会話が
 * 切れるこの走りには使えない。記録した応答の順だけを見る。
 */
function acrossStepsClient(recorded: readonly RecordedCall[]): LlmClient {
  let index = 0;
  const next = (): RecordedCall => {
    const call = recorded[index];
    index += 1;
    if (call === undefined) throw new Error("記録した応答が尽きました");
    return call;
  };
  return {
    async callStructured<T>() {
      const call = next();
      if (call.kind !== "structured") throw new Error("記録と種別が違います（構造化出力）");
      return { output: call.output as T, usage: call.usage };
    },
    async callWithTools() {
      const call = next();
      if (call.kind !== "tools") throw new Error("記録と種別が違います（道具付き）");
      return call.response;
    },
  };
}

/** 1 応答に載せる道具の束（静的チェック。宣言は妥当） */
const staticCheckBundle = (count: number, offset: number): RecordedCall => ({
  kind: "tools",
  response: {
    kind: "toolCalls",
    toolCalls: Array.from({ length: count }, (_, i) => ({
      id: `c${offset + i}`,
      name: "static-check",
      arguments: { declaration: DECLARATION_SOURCE },
    })),
    usage: undefined,
  },
});

describe("2 つの直す段にまたがる、道具の累計の上限（02 §1.5・Issue #429）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1 段目に 20 件、2 段目に 5 件の束を返すと、2 段目の束を 1 つも実行せずに call-limit で止まる", async () => {
    const spy = vi.spyOn(repairTools, "executeRepairTool");
    const client = acrossStepsClient([
      ...recordedRun({ write: DECLARATION_SOURCE_MISMATCH }),
      // 1 段目：道具 20 件の束（累計 20）→ 続く done（宣言は直っても一致しない）
      staticCheckBundle(20, 0),
      toolDone({ declaration: DECLARATION_SOURCE_MISMATCH, disputes: [] }),
      // 2 段目：道具 5 件の束（応答前の累計 20 に足すと 25。上限 24 を超える）
      staticCheckBundle(5, 20),
    ]);

    const result = await runGeneration(
      makeRunInput(client, { limits: { ...AGENT_LIMITS, stagnationRepeats: 0 } }),
    );

    // 止め方：⑥ の累計の上限。納品物は返さず、終了コードは 1
    expect(result.stopped).toEqual({ stage: "repair", kind: "call-limit" });
    expect(result.record.failure).toEqual({ stage: "repair", kind: "call-limit" });
    expect(result.bundle).toBeNull();
    expect(result.summary.exit_code).toBe(1);

    // 直す段は 2 回走る。道具を実行したのは 1 段目の 20 件だけ（2 段目の 5 件は 1 つも実行しない）
    expect(result.record.stages.filter((stage) => stage.stage === "repair")).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(20);
  });
});

// ── 見出しごとの集計（選択肢のキー列・見出しの期待・集計元の組。Issue #433）────────

/** 見出しごとの集計の規範の走り（①→①'→②→②'→③→⑤a） */
const groupedRun = () => runWith(recordedRunGrouped());

describe("選択肢のキー列・見出しの期待・集計元の組が、新契約の fixture で通る（Issue #433）", () => {
  it("新契約の fixture（groupBy つき）は、最後まで流れて full になる", async () => {
    const { run } = groupedRun();
    const result = await run;
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.summary.verdict).toBe("full");
  });

  it("③ が順の違うキーで書いた走りは、⑤a の落ちが ⑥ に回り、③ のやり直しには回らない", async () => {
    const { recording, run } = runWith(
      [
        ...recordedRunGrouped({ declaration: GROUPED_DECLARATION_REVERSED }),
        // ⑥ 直す（同じ宣言を返し直す。⑤a は同じ版なので作り直さない）
        toolDone({ declaration: GROUPED_DECLARATION_REVERSED, disputes: [] }),
        toolDone({ declaration: GROUPED_DECLARATION_REVERSED, disputes: [] }),
      ],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 1, stagnationRepeats: 0 } },
    );
    const result = await run;
    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages).toContain("repair"); // ⑥ 直す
    expect(recording.structured.every((request) => request.schemaName !== MAPPING_REDO_SCHEMA_NAME)).toBe(true);
    expect(result.summary.stop_reason).toBe("limit");
  });

  it("②' が見出しを推測した応答は 1 回作り直し、段の記録 test-suite の calls が 2 になる", async () => {
    const guessed = {
      tests: GROUPED_TEST_SUITE_OUTPUT.tests.map((test) =>
        test.id === "t4"
          ? { ...test, expected: { kind: "ok", value: [{ heading: "open", value: 1 }] } }
          : test,
      ),
    };
    const { run } = runWith([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(GROUPED_DESIGN),
      structured(guessed), // 1 回目：見出しを推測した応答
      structured(GROUPED_TEST_SUITE_OUTPUT), // 2 回目：直した応答
      structured({ declaration: GROUPED_DECLARATION_SOURCE, mappings: GROUPED_MAPPINGS }),
      structured(GROUPED_CORRESPONDENCE_OUTPUT),
    ]);
    const result = await run;
    const testSuite = result.record.stages.find((stage) => stage.stage === "test-suite");
    expect(testSuite?.calls).toBe(2);
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });
});

/** 見出しごとの集計の期待だけを差し替えた、②' の応答を組む */
function groupedSuiteWithAggregate(aggregate: Record<string, unknown>): unknown {
  return { tests: [...GROUPED_TEST_SUITE_OUTPUT.tests.filter((test) => test.id !== "t4"), aggregate] };
}

/** 見出しごとの集計の試験 1 件（入力の契約と参照の行は差し替えられる） */
function groupedAggregateTest(options: {
  readonly referenceData?: readonly unknown[];
  readonly emptyEntities?: readonly string[];
  readonly value: unknown;
}): Record<string, unknown> {
  return {
    id: "t4",
    target: { requirementId: "R-1", kind: "computation", roleId: "record.byStatus" },
    kind: "normal",
    operation: "aggregate",
    clock: "2026-09-16T12:00:00+09:00",
    input: {},
    inputContract: { rowId: "t4-row", targetRowId: null, emptyEntities: options.emptyEntities ?? [] },
    referenceData: options.referenceData ?? [],
    expected: { kind: "ok", value: options.value },
  };
}

const OPEN_ROW = {
  rowId: "row-2",
  target: { requirementId: "R-1", kind: "entity", roleId: "record" },
  values: { "record.status": "open" },
};

describe("見出しごとの集計の期待を、⑤b の値と照合する（Issue #433）", () => {
  it("参照元を指定しない入力で null を期待する試験は、⑤b で一致する", async () => {
    const { run } = runWith(recordedRunGrouped({ suite: groupedSuiteWithAggregate(groupedAggregateTest({ value: null })) }));
    const result = await run;
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("空の集合を明示した入力では、全見出し（0 を含む）が一致する", async () => {
    const aggregate = groupedAggregateTest({
      emptyEntities: ["record"],
      value: [{ heading: "open", value: 0 }, { heading: "closed", value: 0 }],
    });
    const { run } = runWith(recordedRunGrouped({ suite: groupedSuiteWithAggregate(aggregate) }));
    const result = await run;
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("参照行のある入力では、全見出しが一致する", async () => {
    const aggregate = groupedAggregateTest({
      referenceData: [OPEN_ROW],
      value: [{ heading: "open", value: 1 }, { heading: "closed", value: 0 }],
    });
    const { run } = runWith(recordedRunGrouped({ suite: groupedSuiteWithAggregate(aggregate) }));
    const result = await run;
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("参照行があるのに null を期待した試験は、不一致のまま残り、期待が書き換えられない", async () => {
    const aggregate = groupedAggregateTest({ referenceData: [OPEN_ROW], value: null });
    const { run } = runWith(
      [...recordedRunGrouped({ suite: groupedSuiteWithAggregate(aggregate) }), toolDone({ declaration: GROUPED_DECLARATION_SOURCE, disputes: [] })],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 1, stagnationRepeats: 0 } },
    );
    const result = await run;
    expect(result.outcome.verdict).not.toBe("full");
    if (result.bundle === null) throw new Error("納品物が無い");
    const verification = verificationOf(result.bundle);
    expect(verification.test_mismatches).toBe(1);
    // 期待は null のまま（直す段は試験の期待を書き換えられない）
    const material = JSON.parse(fileTextOf(result.bundle, TEST_SUITE_FILE)) as {
      suite: { tests: readonly { id: string; expected: { value: unknown } }[] };
    };
    expect(material.suite.tests.find((test) => test.id === "t4")?.expected.value).toBeNull();
  });
});

describe("⑤a・②' へ正本が渡り、期待・集計値・合否は渡さない（Issue #433）", () => {
  it("確定した仕様を正本にした走りで、⑤a・②' に正本が渡り、⑤a に期待・集計値・合否は渡らない", async () => {
    const { recording, run } = runWith(recordedRunFromPlan(), { plan: CONFIRMED_PLAN });
    const result = await run;
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });

    const correspondence = recording.structured.filter((request) => request.schemaName === CORRESPONDENCE_SCHEMA_NAME);
    expect(correspondence.length).toBeGreaterThan(0);
    for (const request of correspondence) {
      const names = [...request.input.matchAll(/<data name="([^"]+)"/g)].map((match) => match[1]);
      expect(names, "⑤a に正本が渡る").toContain("確定した仕様");
      // 期待・集計値・合否は、⑤a へ新たに渡していない（データの欄の名前で確かめる）
      expect(names).not.toContain("期待");
      expect(names).not.toContain("集計値");
      expect(names).not.toContain("合否");
    }

    const suites = recording.structured.filter((request) => request.schemaName === TEST_SUITE_SCHEMA_NAME);
    expect(suites.length).toBeGreaterThan(0);
    for (const request of suites) {
      expect(request.input).toContain("確定した仕様");
    }
  });

  it("設計と宣言の列が一致していても、仕様から独立に固定した試験の誤りは full にならない", async () => {
    // 見出しのキーと順は正しく、集計の値だけを誤らせる（設計と宣言の列は一致する）
    const aggregate = groupedAggregateTest({
      referenceData: [OPEN_ROW],
      value: [{ heading: "open", value: 99 }, { heading: "closed", value: 0 }],
    });
    const { run } = runWith(
      [
        ...recordedRunGrouped({ suite: groupedSuiteWithAggregate(aggregate) }),
        toolDone({ declaration: GROUPED_DECLARATION_SOURCE, disputes: [] }),
      ],
      { limits: { ...AGENT_LIMITS, repairRoundTrips: 1, stagnationRepeats: 0 } },
    );
    const result = await run;
    expect(result.outcome.verdict).not.toBe("full");
    if (result.bundle === null) throw new Error("納品物が無い");
    expect(verificationOf(result.bundle).test_mismatches).toBe(1);
  });
});

// ── 設計の意味だけを誤らせた 3 種（Issue #433・review 2）────────────────────

describe("設計の意味だけを誤らせた 3 種は、それぞれ ③・⑤a まで進んで full にならない（Issue #433・review 2）", () => {
  /** 正本（確定した仕様）が ②'・⑤a に渡り、期待・集計値・合否が ⑤a へ渡らないことを確かめる */
  const expectMeaningWiring = (recording: ReturnType<typeof createRecordingClient>, planBody: string): void => {
    const suites = recording.structured.filter((request) => request.schemaName === TEST_SUITE_SCHEMA_NAME);
    expect(suites.length).toBeGreaterThan(0);
    for (const request of suites) expect(request.input, "②' に正本の本文が渡る").toContain(planBody);
    const correspondences = recording.structured.filter((request) => request.schemaName === CORRESPONDENCE_SCHEMA_NAME);
    // **⑤a の要求が 1 件以上ある**（③・⑤a まで進んでいる）
    expect(correspondences.length).toBeGreaterThan(0);
    for (const request of correspondences) {
      // 正本の内容（欄名だけでなく本文）が ⑤a に渡る
      expect(request.input, "⑤a に正本の本文が渡る").toContain(planBody);
      const names = [...request.input.matchAll(/<data name="([^"]+)"/g)].map((match) => match[1]);
      expect(names).toContain("確定した仕様");
      // 期待・集計値・合否は、⑤a へ新たに渡していない（データの欄の名前で確かめる）
      expect(names).not.toContain("期待");
      expect(names).not.toContain("集計値");
      expect(names).not.toContain("合否");
    }
  };

  it("選択肢の意味の欠落を設計と宣言が共有しても、③・⑤a まで進んで独立の点検が落ちを残す", async () => {
    const { recording, run } = runWith(
      recordedRunGroupedFromPlan({
        design: GROUPED_DESIGN_MISSING_OPTION,
        declaration: GROUPED_DECLARATION_MISSING_OPTION,
        // 見出しの期待は設計の選択肢に合わせる（キーの形は ②' が通り、正本の意味は ⑤a が点検する）
        suites: [GROUPED_TEST_SUITE_WITHOUT_AGGREGATE],
        // ⑤a の独立の点検は、状態の項目を満たすと挙げない（作り直しでも消えない）
        correspondences: [
          GROUPED_CORRESPONDENCE_OUTPUT_WITHOUT_STATUS,
          GROUPED_CORRESPONDENCE_OUTPUT_WITHOUT_STATUS,
        ],
      }),
      { plan: GROUPED_PLAN_OPTION },
    );
    const result = await run;
    expect(result.outcome.verdict).not.toBe("full");
    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages).toContain("write");
    expect(stages).toContain("correspondence");
    expectMeaningWiring(recording, "状態には未了と完了の 2 つの選択肢が要る");
  });

  it("ラベルとキーの対応の逆転は、キーの並びを保ったままでも、③・⑤a まで進んで独立の点検が落ちを残す", async () => {
    const { recording, run } = runWith(
      recordedRunGroupedFromPlan({
        // 設計の `options` は変えない（キーの並びの整合は保つ）。宣言のラベルだけを逆にする
        declaration: GROUPED_DECLARATION_REVERSED_LABEL,
        suites: [GROUPED_TEST_SUITE_OUTPUT],
        // ⑤a の独立の点検は、ラベルの意味が逆なので状態の項目を満たすと挙げない
        correspondences: [
          GROUPED_CORRESPONDENCE_OUTPUT_WITHOUT_STATUS,
          GROUPED_CORRESPONDENCE_OUTPUT_WITHOUT_STATUS,
        ],
      }),
      { plan: GROUPED_PLAN_LABEL },
    );
    const result = await run;
    expect(result.outcome.verdict).not.toBe("full");
    const stages = result.record.stages.map((stage) => stage.stage);
    expect(stages).toContain("write");
    expect(stages).toContain("correspondence");
    // ②' の列の整合（キーの並び）では止まらない
    expect(result.stopped?.stage).not.toBe("test-suite");
    expectMeaningWiring(recording, "キー open は未了、キー closed は完了を表す");
  });

  it("集計対象の誤りを設計と宣言が共有しても、③・⑤a まで進んで ⑤b の値の照合が落ちを残す", async () => {
    const { recording, run } = runWith(
      [
        ...recordedRunGroupedFromPlan({
          design: GROUPED_DESIGN_WRONG_TARGET,
          declaration: GROUPED_DECLARATION_WRONG_TARGET,
          mappings: GROUPED_MAPPINGS_WRONG_TARGET,
          correspondences: [GROUPED_CORRESPONDENCE_OUTPUT_WRONG_TARGET],
        }),
        toolDone({ declaration: GROUPED_DECLARATION_WRONG_TARGET, disputes: [] }),
      ],
      { plan: GROUPED_PLAN_TARGET, limits: { ...AGENT_LIMITS, repairRoundTrips: 1, stagnationRepeats: 0 } },
    );
    const result = await run;
    expect(result.outcome.verdict).not.toBe("full");
    if (result.bundle === null) throw new Error("納品物が無い");
    // ⑤b の値の不一致が、⑥ の修復・再点検の後も残る
    expect(verificationOf(result.bundle).test_mismatches).toBeGreaterThanOrEqual(1);
    expect(result.record.stages.map((stage) => stage.stage)).toContain("repair");
    expectMeaningWiring(recording, "状態別の件数は項目 status で分ける");
  });
});

// ── （別の試験）正本から固定した見出しの期待は、②' の列の整合で止める ──────────────
//
// これは**意味の点検の証拠ではない**（キーの形の不一致を ②' が断るだけである）。意味の点検の証拠は、
// 上の 3 種（③・⑤a まで進むもの）である。

describe("（別の試験）正本から固定した見出しの期待は、②' の列の整合で止める（Issue #433・review 2）", () => {
  it("選択肢の欠落を設計と宣言が共有しても、正本の見出しを期待する ②' が断る（意味の点検の証拠ではない）", async () => {
    const { run } = runWith(
      recordedRunGroupedFromPlan({
        design: GROUPED_DESIGN_MISSING_OPTION,
        declaration: GROUPED_DECLARATION_MISSING_OPTION,
        suites: [GROUPED_TEST_SUITE_OUTPUT, GROUPED_TEST_SUITE_OUTPUT],
      }),
      { plan: GROUPED_PLAN_OPTION },
    );
    const result = await run;
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.stopped?.stage).toBe("test-suite");
  });
});

// ── 段の記録に、試行の終端と再試行の数・未精算の予約額が入る（Issue #446）──────────

describe("段の記録に、試行の終端と再試行の数・未精算の予約額が入る（Issue #446）", () => {
  /**
   * 指定の回数目の構造化呼び出しを返した**あとで時計を進め**、それ以降の呼び出しを返さずに待たせる
   * 偽物（Issue #446）。狙った段の次の試行で、締切の残りを 1ms にして**呼んでいる途中に打ち切る**。
   * 実 API は呼ばない。
   */
  function clientDeadlineDuringSecondCall(
    recording: { readonly client: LlmClient },
    jumpAfter: number,
    clock: { value: number },
    jumpTo: number,
  ): LlmClient {
    let calls = 0;
    return {
      async callStructured<T>(request: LlmStructuredRequest) {
        calls += 1;
        if (calls <= jumpAfter) {
          const response = await recording.client.callStructured<T>(request);
          if (calls === jumpAfter) clock.value = jumpTo;
          return response;
        }
        return new Promise<never>(() => {
          request.signal?.addEventListener("abort", () => {});
        });
      },
      callWithTools: (request: LlmToolRequest) => recording.client.callWithTools(request),
    };
  }

  /** 記録した応答を順に返し、`atCall` 回目の構造化呼び出しだけ決まった誤りにする偽物（実 API は呼ばない） */
  function failingOnce(
    recorded: readonly RecordedCall[],
    atCall: number,
    error: unknown,
  ): { readonly client: LlmClient } {
    const inner = createFakeLlmClient(recorded);
    let calls = 0;
    return {
      client: {
        async callStructured<T>(request: LlmStructuredRequest) {
          calls += 1;
          if (calls === atCall) throw error;
          return inner.callStructured<T>(request);
        },
        async callWithTools(request: LlmToolRequest) {
          calls += 1;
          if (calls === atCall) throw error;
          return inner.callWithTools(request);
        },
      },
    };
  }

  it("②' の 1 回目が中身に落ち、2 回目の途中で締切に触れると、test-suite は calls 1・開始 2・応答 1・締切の打ち切り 1・中身 1", async () => {
    const clock = { value: 0 };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(DESIGN_OUTPUT_MAPPED),
      structured({ tests: [] }),
    ]);
    const client = clientDeadlineDuringSecondCall(recording, 4, clock, 60_000 - 1);
    const result = await runGeneration(makeRunInput(client, { now: () => clock.value, deadline: 60_000 }));

    expect(result.stopped).toEqual({ stage: "test-suite", kind: "deadline" });
    const testSuite = result.record.stages.find((stage) => stage.stage === "test-suite");
    expect(testSuite).toMatchObject({
      status: "failed",
      calls: 1,
      missing_usage_calls: 0,
      failure_kind: "deadline",
      attempts: { started: 2, responded: 1, errors: 0, cancelled_deadline: 1, cancelled_timeout: 0 },
      retries: { communication: 0, shape: 0, content: 1 },
    });
    // 打ち切った呼び出しの予約は残る（減らない）
    expect(result.record.budget_reserved_usd).toBeGreaterThan(0);
  });

  it("② の前に締切が尽きると、design は calls 0・開始 0・未着手（締切）1", async () => {
    const clock = { value: 0 };
    const recording = createRecordingClient([structured(REQUIREMENT_LIST_OUTPUT), structured(REVERSE_CHECK_OUTPUT)]);
    const client = clientWithClockJump(recording, 2, 60_000, clock);
    const result = await runGeneration(makeRunInput(client, { now: () => clock.value, deadline: 60_000 }));

    expect(result.stopped).toEqual({ stage: "design", kind: "deadline" });
    const design = result.record.stages.find((stage) => stage.stage === "design");
    expect(design).toMatchObject({
      status: "failed",
      calls: 0,
      missing_usage_calls: 0,
      failure_kind: "deadline",
      attempts: { started: 0, responded: 0, errors: 0, cancelled_deadline: 0, cancelled_timeout: 0 },
      retries: { communication: 0, shape: 0, content: 0 },
    });
    expect(design?.attempts.not_started.deadline).toBe(1);
  });

  it("redo-design の記録がその往復の分の差を持ち、通信の再試行が retries.communication 1", async () => {
    const { client } = failingOnce(trackedRedo([structured(REDO_DESIGN_OK)]), 4, kindError("network"));
    const result = await runGeneration(makeRunInput(client, { judge: redoJudge, callTimeoutMs: 1_000 }));
    expect(result.stopped).toBeNull();

    const designs = result.record.stages.filter((stage) => stage.stage === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]).toMatchObject({
      operation: "redo-design",
      status: "ok",
      calls: 1,
      attempts: { started: 2, responded: 1, errors: 1, cancelled_deadline: 0, cancelled_timeout: 0 },
      retries: { communication: 1, shape: 0, content: 0 },
    });
    expect(designs[1]?.attempts.not_started).toEqual({ deadline: 0, budget: 0, limit: 0, timeout: 0 });
  });

  it("全部精算した走りでは budget_reserved_usd が 0、budget_remaining_usd は今までどおり", async () => {
    const { run } = runWith(recordedRun());
    const result = await run;
    expect(result.stopped).toBeNull();
    expect(result.record.budget_reserved_usd).toBe(0);
    // 予約の欄を足しても、残りの予算の意味は変えない
    expect(result.record.budget_remaining_usd).toBeGreaterThan(0);
    expect(result.record.budget_remaining_usd).toBeLessThanOrEqual(10);
  });
});

// ── 要約と記録の failure.problems に、検査の値（役割 ID・引用）を写さない（§1・Issue #445）──

describe("要約と記録の failure.problems に、検査の値（役割 ID・引用）を写さない（§1・Issue #445）", () => {
  const marker = "MARKER445";

  it("② が目印の役割 ID で unmet になる走りで、要約の failure.problems の直列化に目印が出ない", async () => {
    /** 目印の役割 ID を所属させた設計（表に無いので unmet） */
    const badDesign = {
      roles: [
        { roleId: "record", kind: "entity", entity: null, name: "記録", shared: true, aliasOf: null, options: null, groupBy: null },
        { roleId: "record.total", kind: "computation", entity: "record", name: "合計", shared: false, aliasOf: null, options: null, groupBy: null },
        { roleId: "record.extra", kind: "computation", entity: "record", name: "補助", shared: false, aliasOf: null, options: null, groupBy: null },
      ],
      designs: [
        {
          requirementId: "R-1",
          nature: "ruled",
          verification: { kind: "fixed-test" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [
            { roleId: "record", basis: "dependency", reason: "記録の行を参照するため" },
            { roleId: `ghost-${marker}`, basis: "stated", reason: null },
          ],
        },
        {
          requirementId: "R-2",
          nature: "ruled",
          verification: { kind: "fixed-test" },
          vocabulary: [],
          placement: [],
          unwritable: [],
          ownership: [
            { roleId: "record", basis: "dependency", reason: "記録の行を参照するため" },
            { roleId: "record.extra", basis: "stated", reason: null },
          ],
        },
      ],
    };
    const recording = createRecordingClient([
      structured(REQUIREMENT_LIST_OUTPUT),
      structured(REVERSE_CHECK_OUTPUT),
      structured(badDesign),
      structured(badDesign),
    ]);
    const result = await runGeneration(makeRunInput(recording.client));
    expect(result.stopped?.stage).toBe("design");
    expect(result.stopped?.kind).toBe("unmet");
    expect(JSON.stringify(result.stopped)).not.toContain(marker);
    expect(JSON.stringify(result.summary.failure)).not.toContain(marker);
    expect(JSON.stringify(result.record.failure)).not.toContain(marker);
  });

  it("① が目印の引用で malformed になる走りで、要約の failure.problems の直列化に目印が出ない", async () => {
    const source = `${marker}。${marker}。`;
    const badRequirements = {
      requirements: [],
      // 枠の文の引用に目印を入れ、位置を 1 か所に決められない（2 か所ある）
      framing: [{ quote: marker, position: { start: 1, end: marker.length + 2 } }],
      decisions: [],
      unresolved: [],
    };
    const recording = createRecordingClient([structured(badRequirements), structured(badRequirements)]);
    const result = await runGeneration(makeRunInput(recording.client, { source }));
    // ① と ①' は同じ段（`reverse-check`）の記録にまとまる。① の形の誤りが 2 回続いて malformed で止まる
    expect(result.stopped?.stage).toBe("reverse-check");
    expect(result.stopped?.kind).toBe("malformed");
    expect(recording.structured).toHaveLength(2);
    expect(JSON.stringify(result.stopped)).not.toContain(marker);
    expect(JSON.stringify(result.summary.failure)).not.toContain(marker);
    expect(JSON.stringify(result.record.failure)).not.toContain(marker);
  });
});
