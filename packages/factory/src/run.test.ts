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
import { VERIFICATION_FILE, type BundleVerification } from "./bundle.js";
import { AGENT_LIMITS } from "./limits.js";
import type { RecordedCall } from "./llm-fake.js";
import { runGeneration, type GenerationInput } from "./run.js";
import { createRecordingClient, expectNoAcceptanceMaterial } from "./stages/__tests__/prompt.js";
import {
  DECLARATION_SOURCE,
  DESIGN_OUTPUT,
  DESIGN_OUTPUT_PARTIAL,
  INVALID_DECLARATION_SOURCE,
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
