// 共通の上限値（02 §1.5・§2.2）の unit テスト。
//
// ここで固定したいのは 3 つ。
//   1. 依頼文は 4,000 文字ちょうどは通り、4,001 文字は断る（境目）
//   2. 宣言の大きさ・試験の数・参照データの行数も、ちょうどは通り、超過は断る（境目）
//   3. どの上限にも、どの段が確かめるかの番人が書かれている（書き漏らしを `satisfies` と対で見る）
import { describe, expect, it } from "vitest";
import {
  AGENT_LIMITS,
  LIMIT_GUARDS,
  checkDeclarationBytes,
  checkLimit,
  checkRequestText,
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
