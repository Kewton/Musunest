// 偽物の判定（Issue #330）の unit テスト。
//
// 固定したいのは 3 つ。
//   1. 問いの名前ごとに決めた答えを返す（§4）
//   2. 答えた adapter（`answeredBy: "fake"`）・モデルの版の ID・トークン数を残す（§1）
//   3. 用意していない問い・種類の食い違いは誤りにする（試験の題材のずれを黙って通さない）
import { describe, expect, it } from "vitest";
import type { Judge, JudgeRequest } from "./judge.js";
import { FakeJudgeError, createFakeJudge } from "./judge-fake.js";

const REQUEST: JudgeRequest = {
  state: { note: "x" },
  questions: {
    kind: { kind: "choice", instructions: "?", criteria: { a: "one", b: "another" } },
    open: { kind: "noul", instructions: "?" },
  },
};

describe("偽物の判定（05 §4）", () => {
  it("問いの名前ごとに決めた答えを返し、モデルとトークン数を残す", async () => {
    const judge: Judge = createFakeJudge(
      {
        kind: { kind: "choice", choice: "b", probability: 0.6, confidence: 0.7 },
        open: { kind: "noul", noul: 0.4 },
      },
      { model: "fake-1", inputTokens: 12 },
    );

    const result = await judge.judge(REQUEST);

    expect(result.answeredBy).toBe("fake");
    expect(result.model).toBe("fake-1");
    expect(result.inputTokens).toBe(12);
    expect(result.answers.kind).toEqual({ kind: "choice", choice: "b", probability: 0.6, confidence: 0.7 });
    expect(result.answers.open).toEqual({ kind: "noul", noul: 0.4 });
  });

  it("答えの既定は、モデル `fake-judge`・トークン 0 にする", async () => {
    const judge = createFakeJudge({
      kind: { kind: "choice", choice: "a", probability: undefined, confidence: undefined },
      open: { kind: "noul", noul: 0.5 },
    });
    const result = await judge.judge(REQUEST);
    expect(result.model).toBe("fake-judge");
    expect(result.inputTokens).toBe(0);
  });

  it("用意していない問いは誤りにする", async () => {
    const judge = createFakeJudge({ kind: { kind: "choice", choice: "a", probability: undefined, confidence: undefined } });
    await expect(judge.judge(REQUEST)).rejects.toBeInstanceOf(FakeJudgeError);
  });

  it("問いの種類と答えの種類が食い違えば誤りにする", async () => {
    const judge = createFakeJudge({
      kind: { kind: "noul", noul: 0.1 },
      open: { kind: "noul", noul: 0.5 },
    });
    await expect(judge.judge(REQUEST)).rejects.toBeInstanceOf(FakeJudgeError);
  });
});
