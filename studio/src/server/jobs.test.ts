import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, Jobs } from "./jobs.js";
import { Ledger } from "./ledger.js";
import { DEFAULT_FAKE_CONFIRMATION, FakeRunner } from "./runner-fake.js";
import { JobStore } from "./store.js";

let home: string;
let now: number;

const makeJobs = (runner: FakeRunner): Jobs => new Jobs({ home, runner, now: () => now });

const apiError = (call: () => unknown): ApiError => {
  try {
    call();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("例外が出なかった");
};

const answer = { kind: "answers" as const, revision: 1, answers: [{ questionId: "q1", choiceId: "newest" }] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "musunest-jobs-"));
  now = new Date(2026, 10, 11, 12, 0, 0).getTime();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("ジョブの状態の移り", () => {
  it("質問 → 答え → 確認 → 作成中 → 結果 を順に読める", () => {
    const runner = new FakeRunner({ deferFinish: true });
    const jobs = makeJobs(runner);

    const started = jobs.start("日付順の一覧を作って");
    expect(started.state).toBe("awaiting-answer");
    expect(started.question?.questions[0]?.text).toBe("一覧はどの順に並べますか？");

    const answered = jobs.answer(started.id, answer);
    expect(answered.state).toBe("awaiting-confirm");
    expect(answered.confirmation?.requirements).toEqual(DEFAULT_FAKE_CONFIRMATION.requirements);

    const turn = new JobStore(home).load(started.id)?.turns[0];
    expect(turn?.answers).toEqual(answer.answers);
    expect(turn?.answeredAt).not.toBeNull();

    const building = jobs.confirm(started.id, "build");
    expect(building.state).toBe("building");

    runner.finish(started.id);
    const result = jobs.get(started.id);
    expect(result?.state).toBe("result");
    expect(result?.result?.verdict).toBe("full");
    expect(result?.result?.verdictLabel).toBe("すべて満たしました");
  });

  it("偽の走らせる役が差し戻しを返すと状態が「差し戻し」になる", () => {
    const jobs = makeJobs(new FakeRunner({ outcome: "sent-back" }));
    const started = jobs.start("日付順の一覧を作って");
    jobs.answer(started.id, answer);
    jobs.confirm(started.id, "build");

    const view = jobs.get(started.id);
    expect(view?.state).toBe("sent-back");
    expect(view?.stateLabel).toBe("差し戻し");
  });

  it("確認で「やめる」を選ぶと、走らせずに止める", () => {
    const runner = new FakeRunner();
    const jobs = makeJobs(runner);
    const started = jobs.start("日付順の一覧を作って");
    jobs.answer(started.id, answer);

    const view = jobs.confirm(started.id, "stop");
    expect(view.state).toBe("stopped");
    expect(view.stopReason).toBe("cancel");
    expect(runner.confirms).toEqual([{ jobId: started.id, outcome: "stop" }]);
  });
});

describe("同時に走るジョブは 1 本だけ", () => {
  it("2 本目の開始は断られ、1 本目が終われば通る", () => {
    const jobs = makeJobs(new FakeRunner());
    const first = jobs.start("1 本目");

    const busy = apiError(() => jobs.start("2 本目"));
    expect(busy.status).toBe(409);
    expect(busy.code).toBe("busy");

    jobs.answer(first.id, answer);
    jobs.confirm(first.id, "build");
    expect(jobs.get(first.id)?.state).toBe("result");

    expect(() => jobs.start("3 本目")).not.toThrow();
  });
});

describe("答えの期限", () => {
  it("29 分では止まらず、30 分を過ぎると走らせる役の取り消しが呼ばれる", () => {
    const runner = new FakeRunner();
    const jobs = makeJobs(runner);
    const started = jobs.start("日付順の一覧を作って");

    now += 29 * 60 * 1000;
    expect(jobs.get(started.id)?.state).toBe("awaiting-answer");
    expect(runner.cancels).toHaveLength(0);

    now += 60 * 1000;
    const view = jobs.get(started.id);
    expect(view?.state).toBe("stopped");
    expect(view?.stopReason).toBe("answer-timeout");
    expect(view?.stopReasonLabel).toBe("答えの待ちの上限");
    expect(runner.cancels).toEqual([{ jobId: started.id, reason: "answer-timeout" }]);
  });
});

describe("答えの検査", () => {
  it("4 種の誤りはどれも 400 になり、走らせる役に渡らない", () => {
    const runner = new FakeRunner();
    const jobs = makeJobs(runner);
    const started = jobs.start("日付順の一覧を作って");

    const stale = apiError(() => jobs.answer(started.id, { ...answer, revision: 99 }));
    expect(stale.status).toBe(400);
    expect(stale.code).toBe("stale-revision");

    const unknown = apiError(() =>
      jobs.answer(started.id, { ...answer, answers: [{ questionId: "missing", choiceId: "newest" }] }),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.code).toBe("unknown-question");

    const both = apiError(() =>
      jobs.answer(started.id, {
        ...answer,
        answers: [{ questionId: "q1", choiceId: "newest", freeText: "両方" }],
      }),
    );
    expect(both.status).toBe(400);
    expect(both.code).toBe("shape");

    const neither = apiError(() => jobs.answer(started.id, { ...answer, answers: [{ questionId: "q1" }] }));
    expect(neither.status).toBe(400);
    expect(neither.code).toBe("shape");

    const tooLong = apiError(() =>
      jobs.answer(started.id, { ...answer, answers: [{ questionId: "q1", freeText: "あ".repeat(501) }] }),
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.code).toBe("free-text-length");

    expect(runner.answers).toHaveLength(0);

    const accepted = jobs.answer(started.id, answer);
    expect(accepted.state).toBe("awaiting-confirm");
    expect(runner.answers).toHaveLength(1);
  });
});

describe("取り消し", () => {
  it("走らせる役の取り消しが呼ばれ、状態が「止めた」になる", () => {
    const runner = new FakeRunner();
    const jobs = makeJobs(runner);
    const started = jobs.start("日付順の一覧を作って");

    const view = jobs.cancel(started.id);
    expect(view.state).toBe("stopped");
    expect(view.stateLabel).toBe("止めた");
    expect(view.stopReason).toBe("cancel");
    expect(runner.cancels).toEqual([{ jobId: started.id, reason: "cancel" }]);

    expect(() => jobs.start("次の依頼")).not.toThrow();
  });
});

describe("依頼文の検査", () => {
  it("空・長すぎる依頼は断る", () => {
    const jobs = makeJobs(new FakeRunner());
    expect(apiError(() => jobs.start("   ")).code).toBe("empty-request");
    expect(apiError(() => jobs.start("あ".repeat(4_001))).code).toBe("request-too-long");
  });
});

describe("費用の上限", () => {
  it("今日の実額が 2.10 なら開始を断る", () => {
    const ledger = new Ledger(join(home, "ledger.jsonl"), () => now);
    ledger.reserve("seed");
    ledger.settle("seed", 2.1, false);
    const jobs = new Jobs({ home, runner: new FakeRunner(), now: () => now, ledger });

    const error = apiError(() => jobs.start("日付順の一覧を作って"));
    expect(error.status).toBe(409);
    expect(error.code).toBe("budget");
  });

  it("開始で 2.00 を予約し、費用の状態に出す", () => {
    const jobs = makeJobs(new FakeRunner());
    jobs.start("日付順の一覧を作って");
    expect(jobs.budget()).toEqual({ spentUsd: 2, remainingUsd: 2, perRunLimitUsd: 2, dailyLimitUsd: 4 });
  });
});

describe("再起動", () => {
  it("保存したジョブが履歴に戻り、走っていたジョブは「止めた」になる", () => {
    const firstRunner = new FakeRunner({ startProgress: { stage: "要件を整理しています", estimatedUsd: 0.37 } });
    const first = new Jobs({ home, runner: firstRunner, now: () => now });
    const started = first.start("日付順の一覧を作って");
    expect(first.get(started.id)?.state).toBe("awaiting-answer");

    const secondRunner = new FakeRunner();
    const second = new Jobs({ home, runner: secondRunner, now: () => now });

    const view = second.get(started.id);
    expect(view?.state).toBe("stopped");
    expect(view?.stopReason).toBe("cancel");
    expect(second.list().map((job) => job.id)).toContain(started.id);

    const ledger = new Ledger(join(home, "ledger.jsonl"), () => now);
    expect(ledger.openReservations()).toEqual([]);
    expect(ledger.summary().actualUsd).toBeCloseTo(0.37, 2);
    expect(secondRunner.starts).toHaveLength(0);

    const settled = readFileSync(join(home, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.kind === "settle" && line.jobId === started.id);
    expect(settled).toMatchObject({ estimated: true, usd: 0.37 });
  });
});
