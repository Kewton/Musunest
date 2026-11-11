import type { PlanAnswerRequest, PlanConfirmationView, PlanQuestion } from "@musunest/factory";
import { describe, expect, it } from "vitest";
import type {
  ConfirmOutcome,
  RunnerAnswers,
  RunnerConfirmation,
  RunnerQuestionBundle,
} from "./runner.js";
import { createPlanResponder, type PlanResponderChannel } from "./plan-responder.js";

class TestChannel implements PlanResponderChannel {
  readonly asks: RunnerQuestionBundle[] = [];
  readonly confirmations: RunnerConfirmation[] = [];
  private readonly answerResolvers: ((answers: RunnerAnswers) => void)[] = [];
  private readonly confirmResolvers: ((outcome: ConfirmOutcome) => void)[] = [];

  ask(bundle: RunnerQuestionBundle): Promise<RunnerAnswers> {
    this.asks.push(bundle);
    return new Promise((resolve) => {
      this.answerResolvers.push(resolve);
    });
  }

  confirm(confirmation: RunnerConfirmation): Promise<ConfirmOutcome> {
    this.confirmations.push(confirmation);
    return new Promise((resolve) => {
      this.confirmResolvers.push(resolve);
    });
  }

  answer(answers: RunnerAnswers): void {
    this.answerResolvers.shift()?.(answers);
  }

  answerConfirm(outcome: ConfirmOutcome): void {
    this.confirmResolvers.shift()?.(outcome);
  }
}

const question = (revision: number): PlanQuestion => ({
  id: `Q${revision}-1`,
  revision,
  openIssueId: "OI-1",
  text: "一覧はどの順に並べますか？",
  choices: [
    { id: "newest", text: "新しい順" },
    { id: "oldest", text: "古い順" },
  ],
  recommended: { choiceId: "newest", reason: "最近のものから見られるから" },
  allowFreeText: true,
});

const request = (revision: number): PlanAnswerRequest => ({
  questions: [question(revision)],
  remaining: { questions: 8, roundTrips: 3 },
  revision,
  issues: [],
});

const view: PlanConfirmationView = {
  plan: {
    schema_version: "musunest.plan-spec/v1",
    plan_id: "plan-1",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [],
    requirements: [],
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
  },
  diff: [],
  unwritable: [],
  closedByDefault: [],
};

describe("画面の答えを待つ答え役", () => {
  it("質問を通知し、答えが届くまで Plan が進まない", async () => {
    const channel = new TestChannel();
    const responder = createPlanResponder({ channel });

    let settled = false;
    const pending = responder.answer(request(1));
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(channel.asks).toHaveLength(1);
    expect(channel.asks[0]?.revision).toBe(1);
    expect(channel.asks[0]?.questions[0]?.text).toBe("一覧はどの順に並べますか？");
    expect(settled).toBe(false);

    channel.answer({ kind: "answers", revision: 1, answers: [{ questionId: "Q1-1", choiceId: "newest" }] });
    await expect(pending).resolves.toEqual({
      kind: "answers",
      answers: [{ id: "A:Q1-1", questionId: "Q1-1", revision: 1, choiceId: "newest" }],
    });
  });

  it("2 往復目の質問の版が上がる", async () => {
    const channel = new TestChannel();
    const responder = createPlanResponder({ channel });

    const first = responder.answer(request(1));
    channel.answer({ kind: "answers", revision: 1, answers: [{ questionId: "Q1-1", freeText: "新しい順" }] });
    await first;

    const second = responder.answer(request(2));
    channel.answer({ kind: "answers", revision: 2, answers: [{ questionId: "Q2-1", choiceId: "oldest" }] });
    await second;

    expect(channel.asks.map((bundle) => bundle.revision)).toEqual([1, 2]);
    expect(channel.asks.map((bundle) => bundle.questions[0]?.id)).toEqual(["Q1-1", "Q2-1"]);
  });

  it("「全部推奨」が工場へそのまま渡る", async () => {
    const channel = new TestChannel();
    const responder = createPlanResponder({ channel });

    const pending = responder.answer(request(1));
    channel.answer({ kind: "all-recommended", revision: 1 });
    await expect(pending).resolves.toEqual({ kind: "all-recommended" });
  });

  it("確認の答えを画面の型にして送り、やめるなら stop を返す", async () => {
    const channel = new TestChannel();
    const responder = createPlanResponder({ channel });

    const pending = responder.confirm(view);
    await Promise.resolve();
    expect(channel.confirmations).toHaveLength(1);
    expect(channel.confirmations[0]).toEqual({
      requirements: [],
      diff: { added: [], changed: [], removed: [] },
      limitations: [],
      decided: [],
    });

    channel.answerConfirm("stop");
    await expect(pending).resolves.toBe("stop");
  });
});

describe("確認の締切", () => {
  it("締切の 1 分前に届いた答えは確定し、Build が起きる", async () => {
    const channel = new TestChannel();
    const deadline = 10_000_000;
    let now = deadline - 60_000;
    const responder = createPlanResponder({ channel, now: () => now, deadline });

    const pending = responder.confirm(view);
    await Promise.resolve();
    channel.answerConfirm("build");
    await expect(pending).resolves.toBe("build");
    expect(responder.timedOut).toBe(false);
    now += 1;
    expect(responder.timedOut).toBe(false);
  });

  it("締切を過ぎてから届いた確認は Build を起こさず、時間切れになる", async () => {
    const channel = new TestChannel();
    const deadline = 10_000_000;
    let now = deadline - 60_000;
    const responder = createPlanResponder({ channel, now: () => now, deadline });

    const pending = responder.confirm(view);
    await Promise.resolve();
    now = deadline + 1;
    channel.answerConfirm("build");
    await expect(pending).resolves.toBe("stop");
    expect(responder.timedOut).toBe(true);
  });
});
