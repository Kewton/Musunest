// 共通の上限値（02 §1.5・§2.2）の unit テスト。
//
// ここで固定したいのは 3 つ。
//   1. 依頼文は 4,000 文字ちょうどは通り、4,001 文字は断る（境目）
//   2. 宣言の大きさ・試験の数・参照データの行数も、ちょうどは通り、超過は断る（境目）
//   3. どの上限にも、どの段が確かめるかの番人が書かれている（書き漏らしを `satisfies` と対で見る）
import { describe, expect, it } from "vitest";
import {
  AGENT_LIMITS,
  CALL_TIMEOUT_BY_EFFORT,
  LIMIT_GUARDS,
  OUTPUT_STAGES,
  STAGE_MAX_OUTPUT_TOKENS,
  callTimeoutMsForEffort,
  checkDeclarationBytes,
  checkLimit,
  checkRequestText,
  effectiveCallTimeoutMs,
  isReasoningEffort,
  maxOutputTokensForEffort,
  type LimitName,
} from "./limits.js";

describe("共通の上限（02 §1.5・§2.2）", () => {
  it("依頼文は 4,000 文字ちょうどは通り、4,001 文字は断る", () => {
    expect(checkRequestText("x".repeat(4_000))).toBeUndefined();
    expect(checkRequestText("x".repeat(4_001))).toEqual({
      limit: "requestTextChars",
      max: 4_000,
      actual: 4_001,
    });
  });

  it("宣言の大きさはちょうどは通り、1 バイト超過は断る", () => {
    expect(checkDeclarationBytes(AGENT_LIMITS.declarationBytes)).toBeUndefined();
    expect(checkDeclarationBytes(AGENT_LIMITS.declarationBytes + 1)).toEqual({
      limit: "declarationBytes",
      max: AGENT_LIMITS.declarationBytes,
      actual: AGENT_LIMITS.declarationBytes + 1,
    });
  });

  it("試験の数はちょうどは通り、超過は断る", () => {
    expect(checkLimit("testsPerRequirement", AGENT_LIMITS.testsPerRequirement)).toBeUndefined();
    expect(checkLimit("testsPerRequirement", AGENT_LIMITS.testsPerRequirement + 1)).toEqual({
      limit: "testsPerRequirement",
      max: AGENT_LIMITS.testsPerRequirement,
      actual: AGENT_LIMITS.testsPerRequirement + 1,
    });
  });

  it("参照データの行数はちょうどは通り、超過は断る", () => {
    expect(checkLimit("referenceRowsPerTest", AGENT_LIMITS.referenceRowsPerTest)).toBeUndefined();
    expect(checkLimit("referenceRowsPerTest", AGENT_LIMITS.referenceRowsPerTest + 1)?.limit).toBe(
      "referenceRowsPerTest",
    );
  });

  it("③ のやり直し・⑤a の作り直し・停滞の回数の上限も、ちょうどは通り、超過は断る（02 §1.5・#309）", () => {
    for (const name of ["correspondenceRedos", "correspondenceChecks", "stagnationRepeats"] as const) {
      expect(checkLimit(name, AGENT_LIMITS[name]), name).toBeUndefined();
      expect(checkLimit(name, AGENT_LIMITS[name] + 1)?.limit, name).toBe(name);
    }
  });

  it("すべての上限に、どの段が確かめるかの番人が書かれている", () => {
    const names = Object.keys(AGENT_LIMITS) as readonly LimitName[];
    for (const name of names) {
      expect(LIMIT_GUARDS[name]).toBeTypeOf("string");
      expect(LIMIT_GUARDS[name].length).toBeGreaterThan(0);
    }
  });

  it("数えられる値でないものは断る（呼ぶ側の数え方の誤り）", () => {
    expect(() => checkLimit("callCount", -1)).toThrow();
    expect(() => checkLimit("callCount", 1.5)).toThrow();
    expect(() => checkLimit("callCount", Number.NaN)).toThrow();
  });
});

// ── 段の出力の上限（effort ごと。§1.5・§2）──────────────────────

describe("段の出力の上限は effort ごとに、共通の置き場所が持つ（02 §1.5・§2）", () => {
  it("effort high の上限は、medium 以上である（段ごとに）", () => {
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("high", stage), stage).toBeGreaterThanOrEqual(
        maxOutputTokensForEffort("medium", stage),
      );
      expect(maxOutputTokensForEffort("low", stage), stage).toBeLessThanOrEqual(
        maxOutputTokensForEffort("medium", stage),
      );
    }
  });

  it("上限は、共通の置き場所（STAGE_MAX_OUTPUT_TOKENS）から取る", () => {
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("low", stage)).toBe(STAGE_MAX_OUTPUT_TOKENS.low[stage]);
      expect(maxOutputTokensForEffort("medium", stage)).toBe(STAGE_MAX_OUTPUT_TOKENS.medium[stage]);
      expect(maxOutputTokensForEffort("high", stage)).toBe(STAGE_MAX_OUTPUT_TOKENS.high[stage]);
    }
  });

  it("high は、それまでの固定値（= medium）より十分に大きい（推論の分の余白）", () => {
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("high", stage), stage).toBeGreaterThan(
        maxOutputTokensForEffort("medium", stage),
      );
    }
  });

  it("知らない effort は、既定（high）へ倒す（段を止めない）", () => {
    expect(isReasoningEffort("nope")).toBe(false);
    expect(isReasoningEffort("high")).toBe(true);
    for (const stage of OUTPUT_STAGES) {
      expect(maxOutputTokensForEffort("nope", stage)).toBe(maxOutputTokensForEffort("high", stage));
    }
  });
});

// ── 呼び出しごとの timeout（effort ごと。§1.5・#302）──────────────────

describe("呼び出しごとの timeout は、effort ごとに持つ（02 §1.5・#302）", () => {
  it("effort high の timeout は、medium 以上である", () => {
    expect(callTimeoutMsForEffort("high")).toBeGreaterThanOrEqual(callTimeoutMsForEffort("medium"));
    expect(callTimeoutMsForEffort("medium")).toBeGreaterThanOrEqual(callTimeoutMsForEffort("low"));
  });

  it("基準の値は共通の置き場所（CALL_TIMEOUT_BY_EFFORT）から取り、固定の 60 秒ではない", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      expect(callTimeoutMsForEffort(effort)).toBe(CALL_TIMEOUT_BY_EFFORT[effort]);
    }
    // high は、疎通の確認で足りなかった 60 秒より十分に長い
    expect(callTimeoutMsForEffort("high")).toBeGreaterThan(60_000);
  });

  it("知らない effort は、既定（high）へ倒す（段を止めない）", () => {
    expect(callTimeoutMsForEffort("nope")).toBe(callTimeoutMsForEffort("high"));
    expect(callTimeoutMsForEffort("")).toBe(callTimeoutMsForEffort("high"));
  });

  it("実際に使う timeout は、ジョブの締切の残りを超えない", () => {
    // 残りが基準より短ければ、残りに切り詰める
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 1_000 })).toBe(1_000);
    // 残りが基準より長ければ、基準のまま
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 10_000_000 })).toBe(
      callTimeoutMsForEffort("high"),
    );
    // 残りが尽きていれば 0（呼ばない）
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 0 })).toBe(0);
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: -1 })).toBe(0);
  });

  it("呼ぶ側の指定（手元の入口の --timeout）は、effort の基準より優先し、締切の残りを超えない", () => {
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 10_000_000, timeoutMs: 1_200 })).toBe(1_200);
    expect(effectiveCallTimeoutMs({ effort: "high", remainingMs: 800, timeoutMs: 1_200 })).toBe(800);
  });
});
