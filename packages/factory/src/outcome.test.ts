// 終わりの判定（02 §1.4）の unit テスト。Issue #278 の受入条件のうち、判定に閉じる分。
//
// ここで固定したいのは、3 つの結果それぞれの条件と、境目である。
//   - 合格：静的な検査を通り、落ち・不一致・未解決・書けない要件が 0
//   - 部分案：静的な検査を通るが、書けない要件がある／未解決を残した
//   - 失敗：静的な検査を通った版が無い、または上限に触れて部分案の条件も満たさない
//   - 境目：未解決が 1 つでもあれば合格にならない／静的な検査を通った版が無ければ失敗
import { describe, expect, it } from "vitest";
import { decideOutcome, type StageResults } from "./outcome.js";

const SATISFIED: StageResults = {
  staticCheckPassed: true,
  correspondenceMisses: 0,
  testMismatches: 0,
  unresolved: 0,
  unwritableRequirements: 0,
  limitReached: false,
};

describe("終わりの判定（02 §1.4）", () => {
  it("すべて満たせば合格（verdict: full）", () => {
    expect(decideOutcome(SATISFIED)).toEqual({ result: "pass", verdict: "full" });
  });

  it("書けない要件があれば部分案（verdict: partial）", () => {
    expect(decideOutcome({ ...SATISFIED, unwritableRequirements: 1 })).toEqual({
      result: "partial",
      verdict: "partial",
    });
  });

  it("設計の notes だけがある要件は、部分案の理由にならない（Issue #332）", () => {
    // notes は曖昧さ・決めたこと・不確かさのメモであり、書けないことではない。合格のままにする
    expect(decideOutcome({ ...SATISFIED, notedRequirements: 3 })).toEqual({ result: "pass", verdict: "full" });
    // 書けない部分（語彙の穴）が 1 つでも残れば、notes があっても部分案
    expect(decideOutcome({ ...SATISFIED, unwritableRequirements: 1, notedRequirements: 3 }).result).toBe("partial");
  });

  it("未解決（重大な曖昧さ・裁定できなかった試験）があれば部分案", () => {
    expect(decideOutcome({ ...SATISFIED, unresolved: 2 })).toEqual({
      result: "partial",
      verdict: "partial",
    });
  });

  it("静的な検査を通った版が無ければ失敗（verdict: none）", () => {
    expect(decideOutcome({ ...SATISFIED, staticCheckPassed: false })).toEqual({
      result: "failed",
      verdict: "none",
    });
  });

  it("上限に触れて止まり、部分案の条件も満たさなければ失敗", () => {
    expect(decideOutcome({ ...SATISFIED, correspondenceMisses: 1, limitReached: true })).toEqual({
      result: "failed",
      verdict: "none",
    });
  });

  // 境目
  it("未解決が 1 つでもあれば合格にならない", () => {
    expect(decideOutcome({ ...SATISFIED, unresolved: 1 }).result).not.toBe("pass");
  });

  it("対応表の落ち・試験の不一致が 1 つでもあれば合格にならない", () => {
    expect(decideOutcome({ ...SATISFIED, correspondenceMisses: 1 }).result).not.toBe("pass");
    expect(decideOutcome({ ...SATISFIED, testMismatches: 1 }).result).not.toBe("pass");
  });

  it("静的な検査を通った版が無ければ、未解決が 0 でも失敗", () => {
    expect(decideOutcome({ ...SATISFIED, staticCheckPassed: false, unresolved: 0 }).result).toBe("failed");
    expect(decideOutcome({ ...SATISFIED, staticCheckPassed: false }).verdict).toBe("none");
  });
});
