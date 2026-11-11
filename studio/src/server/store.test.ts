import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FAKE_QUESTION } from "./runner-fake.js";
import { JobStore, type StoredJob } from "./store.js";

let home: string;
let store: JobStore;

const makeJob = (overrides: Partial<StoredJob> = {}): StoredJob => ({
  id: "job-1",
  request: "日付順の一覧を作って",
  state: "awaiting-answer",
  stopReason: null,
  stopReasonCodes: [],
  createdAt: 1_000,
  updatedAt: 2_000,
  answerDeadlineAt: 3_000,
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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "musunest-store-"));
  store = new JobStore(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("JobStore", () => {
  it("依頼文・状態・往復・結果の要約を保存して読み戻す", () => {
    store.save(makeJob());

    const loaded = store.load("job-1");
    expect(loaded).not.toBeNull();
    expect(loaded?.request).toBe("日付順の一覧を作って");
    expect(loaded?.state).toBe("awaiting-answer");
    expect(loaded?.question?.revision).toBe(1);
    expect(loaded?.reservedUsd).toBe(2);

    const directory = join(store.directory, "job-1");
    expect(readFileSync(join(directory, "request.txt"), "utf8")).toBe("日付順の一覧を作って");
    expect(existsSync(join(directory, "job.json"))).toBe(true);
  });

  it("往復（質問と答え）を保存して読み戻す", () => {
    store.save(
      makeJob({
        turns: [
          {
            revision: 1,
            questions: DEFAULT_FAKE_QUESTION.questions,
            answers: [{ questionId: "q1", choiceId: "newest" }],
            allRecommended: false,
            askedAt: 1_500,
            answeredAt: 2_000,
          },
        ],
      }),
    );

    const turn = store.load("job-1")?.turns[0];
    expect(turn?.revision).toBe(1);
    expect(turn?.answers).toEqual([{ questionId: "q1", choiceId: "newest" }]);
    expect(turn?.answeredAt).toBe(2_000);
  });

  it("保存し直すと状態が置き換わる", () => {
    store.save(makeJob());
    store.save(makeJob({ state: "result", stopReason: null, spentUsd: 0.42, result: { verdict: "full", content: ["できました"] } }));

    const loaded = store.load("job-1");
    expect(loaded?.state).toBe("result");
    expect(loaded?.spentUsd).toBe(0.42);
    expect(loaded?.result?.verdict).toBe("full");
  });

  it("履歴は新しい順に返す", () => {
    store.save(makeJob({ id: "old", createdAt: 1_000 }));
    store.save(makeJob({ id: "new", createdAt: 9_000 }));
    expect(store.list().map((job) => job.id)).toEqual(["new", "old"]);
  });

  it("止めた理由の符号の並びを保存して読み戻す", () => {
    store.save(
      makeJob({
        state: "stopped",
        stopReason: "cannot-confirm",
        stopReasonCodes: ["noncritical-without-default", "not-stated"],
        answerDeadlineAt: null,
        question: null,
      }),
    );

    const loaded = store.load("job-1");
    expect(loaded?.stopReason).toBe("cannot-confirm");
    expect(loaded?.stopReasonCodes).toEqual(["noncritical-without-default", "not-stated"]);
  });

  it("符号の欄の無い古い記録も、空の並びとして読める", () => {
    store.save(makeJob({ state: "stopped", stopReason: "cannot-confirm", answerDeadlineAt: null, question: null }));
    const jobPath = join(store.directory, "job-1", "job.json");
    const parsed = JSON.parse(readFileSync(jobPath, "utf8")) as Record<string, unknown>;
    delete parsed["stopReasonCodes"];
    writeFileSync(jobPath, JSON.stringify(parsed), "utf8");

    const loaded = store.load("job-1");
    expect(loaded?.stopReason).toBe("cannot-confirm");
    expect(loaded?.stopReasonCodes).toEqual([]);
  });

  it("知らない ID・壊れた記録は null にする", () => {
    expect(store.load("missing")).toBeNull();
    expect(store.load("../escape")).toBeNull();

    store.save(makeJob({ id: "broken" }));
    writeFileSync(join(store.directory, "broken", "job.json"), "{ not json", "utf8");
    expect(store.load("broken")).toBeNull();
  });

  it("記録はリポジトリの外（試験の一時ディレクトリ）に置かれる", () => {
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(store.directory.startsWith(process.cwd())).toBe(false);
  });
});
