import { describe, expect, it } from "vitest";
import { DEFAULT_FAKE_CONFIRMATION, DEFAULT_FAKE_QUESTION } from "./runner-fake.js";
import type { StoredJob } from "./store.js";
import { DECLARATION_TERMS, UserWordingError, buildBudgetView, buildJobView, declarationTermsIn } from "./view.js";

const makeJob = (overrides: Partial<StoredJob> = {}): StoredJob => ({
  id: "job-1",
  request: "日付順の一覧を作って",
  state: "awaiting-answer",
  stopReason: null,
  createdAt: 10_000,
  updatedAt: 20_000,
  answerDeadlineAt: 30_000,
  question: DEFAULT_FAKE_QUESTION,
  turns: [],
  confirmation: null,
  progress: { stage: "要件を整理しています", estimatedUsd: 0.05 },
  result: null,
  reservedUsd: 2,
  estimatedUsd: 0.05,
  spentUsd: null,
  note: null,
  ...overrides,
});

describe("buildJobView の表示の言葉", () => {
  it("状態と止めた理由を日本語で返す", () => {
    const sentBack = buildJobView(makeJob({ state: "sent-back" }), 20_000);
    expect(sentBack.state).toBe("sent-back");
    expect(sentBack.stateLabel).toBe("差し戻し");

    const stopped = buildJobView(
      makeJob({ state: "stopped", stopReason: "answer-timeout", answerDeadlineAt: null, question: null }),
      20_000,
    );
    expect(stopped.stateLabel).toBe("止めた");
    expect(stopped.stopReasonLabel).toBe("答えの待ちの上限");
  });

  it("進みは経過秒と概算の額を持つ", () => {
    const view = buildJobView(makeJob(), 10_000 + 61_000);
    expect(view.progress?.elapsedSeconds).toBe(61);
    expect(view.progress?.estimatedUsd).toBe(0.05);
  });

  it("質問の束は版・残り・答えの期限の時刻を持つ", () => {
    const view = buildJobView(makeJob(), 20_000);
    expect(view.question?.revision).toBe(1);
    expect(view.question?.questions[0]?.id).toBe("q1");
    expect(view.question?.remaining).toEqual({ questions: 8, roundTrips: 3 });
    expect(view.question?.deadlineAt).toBe(30_000);
  });

  it("確認と結果の表示用の欄に宣言の用語が入らない", () => {
    const view = buildJobView(
      makeJob({
        state: "result",
        question: null,
        confirmation: DEFAULT_FAKE_CONFIRMATION,
        result: { verdict: "partial", content: ["一部の写真は付けられませんでした。"] },
        spentUsd: 0.42,
      }),
      20_000,
    );

    expect(view.result?.verdictLabel).toBe("一部だけ満たしました");
    const displayed = JSON.stringify({ confirmation: view.confirmation, result: view.result });
    for (const term of DECLARATION_TERMS) {
      expect(displayed.toLowerCase()).not.toContain(term.toLowerCase());
    }
    expect(declarationTermsIn(displayed)).toEqual([]);
  });

  it("走らせる役が宣言の用語を返したら、表示に通さず例外にする", () => {
    const job = makeJob({
      state: "awaiting-confirm",
      question: null,
      confirmation: {
        ...DEFAULT_FAKE_CONFIRMATION,
        requirements: ["entity の一覧を出す"],
      },
    });
    expect(() => buildJobView(job, 20_000)).toThrow(UserWordingError);
  });
});

describe("buildBudgetView", () => {
  it("1 回の上限と 1 日の上限をコードの定数から返す", () => {
    const view = buildBudgetView({ actualUsd: 0.42, reservedUsd: 2, spentUsd: 2.42, remainingUsd: 1.58, canStart: true });
    expect(view).toEqual({ spentUsd: 2.42, remainingUsd: 1.58, perRunLimitUsd: 2, dailyLimitUsd: 4 });
  });
});
