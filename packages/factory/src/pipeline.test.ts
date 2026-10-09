// 段の型と、前半の未達の持ち越し（pipeline.ts）の unit テスト（02 §1.4・§1.2・②'）。
//
// ここで固定したいのは 2 つ。
//   1. 前半（①' 逆照合・②' 試験）から持ち越した未達を、⑦ の入力（未解決）に**そのまま**数えること
//   2. 持ち越しが残るかぎり、終わりの判定は合格（full）にならないこと（部分案へ倒す）
import { describe, expect, it } from "vitest";
import { decideOutcome } from "./outcome.js";
import { toStageResults, type UnmetCarryOver } from "./pipeline.js";

const carriedOver = (reverseCheck: readonly string[], testSuite: readonly string[]): UnmetCarryOver => ({
  reverseCheck,
  testSuite,
});

/** すべての段が満たした状態の材料（持ち越しだけを差し替える） */
const base = {
  staticCheckPassed: true,
  correspondenceMisses: 0,
  testMismatches: 0,
  testUnresolved: 0,
  unwritableRequirements: 0,
  limitReached: false,
} as const;

describe("前半から持ち越した未達を、結果に残す（02 §1.2・②'）", () => {
  it("①' の落ちと ②' の欠けを、未解決として数える", () => {
    const stage = toStageResults({
      ...base,
      carriedOver: carriedOver(
        ["引用が見つからない"],
        ["R-2 に boundary の試験が無い", "R-3 の試験が無い"],
      ),
    });
    expect(stage.unresolved).toBe(3);
    // 未解決が残るかぎり、合格にはならない（部分案）
    expect(decideOutcome(stage)).toEqual({ result: "partial", verdict: "partial" });
  });

  it("持ち越しが無く、ほかもすべて満たせば、合格になる", () => {
    const stage = toStageResults({ ...base, carriedOver: carriedOver([], []) });
    expect(stage.unresolved).toBe(0);
    expect(decideOutcome(stage)).toEqual({ result: "pass", verdict: "full" });
  });

  it("後半の未解決（評価器で確かめられない試験）も、持ち越しと合わせて数える", () => {
    const stage = toStageResults({
      ...base,
      testUnresolved: 2,
      carriedOver: carriedOver([], ["R-1 の試験が無い"]),
    });
    expect(stage.unresolved).toBe(3);
    expect(decideOutcome(stage).verdict).toBe("partial");
  });
});
