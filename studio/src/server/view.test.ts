import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FAKE_CONFIRMATION, DEFAULT_FAKE_QUESTION } from "./runner-fake.js";
import type { StoredJob } from "./store.js";
import {
  CONFIRM_CATEGORY_LABELS,
  DECLARATION_TERMS,
  UserWordingError,
  buildBudgetView,
  buildJobView,
  confirmCategoryOf,
  declarationTermsIn,
} from "./view.js";

const makeJob = (overrides: Partial<StoredJob> = {}): StoredJob => ({
  id: "job-1",
  request: "日付順の一覧を作って",
  state: "awaiting-answer",
  stopReason: null,
  stopReasonCodes: [],
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

  it("使った額と、差し戻しの理由を返す", () => {
    const view = buildJobView(
      makeJob({ state: "sent-back", spentUsd: 0.42, note: "仕様を決め直してください" }),
      20_000,
    );
    expect(view.spentUsd).toBe(0.42);
    expect(view.note).toBe("仕様を決め直してください");
  });

  it("結果の manifest の SHA と partial の 3 つを返す", () => {
    const sha = "a".repeat(64);
    const view = buildJobView(
      makeJob({
        state: "result",
        question: null,
        result: {
          verdict: "partial",
          content: ["一部だけ満たしました。"],
          manifestSha256: sha,
          built: ["一覧を新しい順に並べる"],
          missing: [{ what: "写真の添付", alternative: "題名に写真の名前を書く" }],
          decided: ["画面の名前は「一覧」にする"],
        },
      }),
      20_000,
    );

    expect(view.manifestSha256).toBe(sha);
    expect(view.partial).toEqual({
      built: ["一覧を新しい順に並べる"],
      missing: [{ what: "写真の添付", alternative: "題名に写真の名前を書く" }],
      decided: ["画面の名前は「一覧」にする"],
    });
  });

  it("partial の表示の言葉に宣言の用語が混ざったら例外にする", () => {
    const job = makeJob({
      state: "result",
      question: null,
      result: {
        verdict: "partial",
        content: [],
        built: ["entity の一覧を出す"],
      },
    });
    expect(() => buildJobView(job, 20_000)).toThrow(UserWordingError);
  });
});

describe("buildJobView の manifest の SHA", () => {
  it("partial の結果は、ジョブの置き場所の manifest のバイト列から SHA-256 を求める", () => {
    const home = mkdtempSync(join(tmpdir(), "musunest-view-"));
    const previous = process.env.STUDIO_HOME;
    process.env.STUDIO_HOME = home;
    try {
      const id = "job-partial";
      mkdirSync(join(home, "jobs", id), { recursive: true });
      const text = '{"schema_version":"test"}';
      writeFileSync(join(home, "jobs", id, "bundle-manifest.json"), text, "utf8");

      const view = buildJobView(
        makeJob({
          id,
          state: "result",
          question: null,
          result: { verdict: "partial", content: ["一部だけ満たしました。"] },
        }),
        20_000,
      );

      expect(view.manifestSha256).toBe(createHash("sha256").update(text).digest("hex"));
    } finally {
      if (previous === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("保存した公開の結果を返す（履歴のインスタンス ID）", () => {
    const home = mkdtempSync(join(tmpdir(), "musunest-view-"));
    const previous = process.env.STUDIO_HOME;
    process.env.STUDIO_HOME = home;
    try {
      const id = "job-published";
      mkdirSync(join(home, "jobs", id), { recursive: true });
      const record = {
        ok: true,
        instanceId: "studio-20261111123456",
        level: "L2",
        manifestSha256: "a".repeat(64),
        path: "/apps/studio-20261111123456",
      };
      writeFileSync(join(home, "jobs", id, "publish.json"), JSON.stringify(record), "utf8");

      const view = buildJobView(makeJob({ id, state: "result", question: null }), 20_000);

      expect(view.publish).toEqual(record);
    } finally {
      if (previous === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("buildBudgetView", () => {
  it("1 回の上限と 1 日の上限をコードの定数から返す", () => {
    const view = buildBudgetView({ actualUsd: 0.42, reservedUsd: 2, spentUsd: 2.42, remainingUsd: 1.58, canStart: true });
    expect(view).toEqual({ spentUsd: 2.42, remainingUsd: 1.58, perRunLimitUsd: 2, dailyLimitUsd: 4 });
  });
});

describe("要件を固めきれなかった理由の分類（Issue #886）", () => {
  const category1 = CONFIRM_CATEGORY_LABELS[1];
  const category2 = CONFIRM_CATEGORY_LABELS[2];
  const category3 = CONFIRM_CATEGORY_LABELS[3];
  const category4 = CONFIRM_CATEGORY_LABELS[4];

  const table: readonly (readonly [string, string])[] = [
    ["question-limit", category1],
    ["round-trip-limit", category1],
    ["critical-no-question", category1],
    ["noncritical-without-default", category1],
    ["open_issue", category1],
    ["open_critical", category1],
    ["not-stated", category2],
    ["low-confidence", category2],
    ["unknown", category2],
    ["duplicate-open-issue", category3],
    ["quote-not-found", category3],
    ["position-mismatch", category3],
    ["uncovered-source", category3],
    ["uncovered-answer", category3],
    ["origin-not-answer", category3],
    ["unknown_reference", category3],
    ["accepted_outside_parts", category3],
    ["accepted_not_removal", category3],
    ["resolution_without_basis", category3],
    ["other", category4],
    ["confirmation_expired", category4],
  ];

  it("表のすべての符号を、決めた分類に写す", () => {
    for (const [code, expected] of table) {
      expect(confirmCategoryOf([code])).toBe(expected);
    }
  });

  it("空の並びと知らない符号は 4 にする", () => {
    expect(confirmCategoryOf([])).toBe(category4);
    expect(confirmCategoryOf(["知らない符号"])).toBe(category4);
    expect(confirmCategoryOf(["nonsense"])).toBe(category4);
  });

  it("複数の符号は、番号の小さい分類が勝つ", () => {
    expect(confirmCategoryOf(["not-stated", "question-limit"])).toBe(category1);
    expect(confirmCategoryOf(["duplicate-open-issue", "low-confidence"])).toBe(category2);
    expect(confirmCategoryOf(["nonsense", "duplicate-open-issue"])).toBe(category3);
    expect(confirmCategoryOf(["nonsense", "other"])).toBe(category4);
  });

  it("分類の文は、符号・事項 ID・要件 ID・宣言の用語を含まない", () => {
    for (const [code, expected] of table) {
      expect(expected).not.toContain(code);
      expect(expected).not.toMatch(/\b[RI]\d+/u);
      expect(declarationTermsIn(expected)).toEqual([]);
    }
  });

  it("JobView の JSON 全体に、符号と OI:・R: で始まる文字列を出さない", () => {
    const codes = table.map(([code]) => code);
    const view = buildJobView(
      makeJob({
        state: "stopped",
        stopReason: "cannot-confirm",
        stopReasonCodes: codes,
        answerDeadlineAt: null,
        question: null,
      }),
      20_000,
    );

    expect(view.stopReasonCategory).toBe(category1);
    const json = JSON.stringify(view);
    for (const code of codes) {
      expect(json).not.toContain(code);
    }
    expect(json).not.toContain("OI:");
    expect(json).not.toMatch(/\bR:/u);
    expect(json).not.toMatch(/\b[RI]\d+\b/u);
  });
});
