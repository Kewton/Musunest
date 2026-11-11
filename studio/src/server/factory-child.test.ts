import type { ConfirmedPlan } from "@musunest/appspec-schema";
import type {
  CliDeps,
  LlmClient,
  LlmStructuredResponse,
  LlmToolResponse,
  PlanAnswerRequest,
  PlanConfirmationView,
  PlanQuestion,
  PlanResult,
} from "@musunest/factory";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFactoryBuildArgs } from "./build-args.js";
import {
  FACTORY_PLAN_DEADLINE_MS,
  runFactoryChild,
  type FactoryChildChannel,
  type FactoryChildDeps,
  type FactoryChildRequest,
} from "./factory-child.js";
import type {
  ConfirmOutcome,
  RunnerAnswers,
  RunnerConfirmation,
  RunnerEvent,
  RunnerQuestionBundle,
} from "./runner.js";

const SOURCE = "社外秘の依頼文。毎日の記録を一覧で見たい。";
const OUT_DIR = "/virtual/jobs/job-1";

class TestChannel implements FactoryChildChannel {
  readonly events: RunnerEvent[] = [];
  readonly asks: RunnerQuestionBundle[] = [];
  readonly confirmations: RunnerConfirmation[] = [];
  private readonly answerResolvers: ((answers: RunnerAnswers) => void)[] = [];
  private readonly confirmResolvers: ((outcome: ConfirmOutcome) => void)[] = [];

  notify(event: RunnerEvent): void {
    this.events.push(event);
  }

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

const question: PlanQuestion = {
  id: "Q1-1",
  revision: 1,
  openIssueId: "OI-1",
  text: "一覧はどの順に並べますか？",
  choices: [
    { id: "c1", text: "新しい順" },
    { id: "c2", text: "古い順" },
  ],
  recommended: { choiceId: "c1", reason: "最近のものから見られるから" },
  allowFreeText: true,
};

const answerRequest = (revision: number): PlanAnswerRequest => ({
  questions: [{ ...question, id: `Q${revision}-1`, revision }],
  remaining: { questions: 8, roundTrips: 3 },
  revision,
  issues: [],
});

const confirmationView: PlanConfirmationView = {
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

const confirmedPlan = {
  schema_version: "musunest.plan-spec/v1",
  plan_id: "plan-1",
  revision: 1,
  vocabulary_version: "v1",
  inputs: [],
  requirements: [],
  open_issues: [],
  decisions: [],
  accepted_unwritable: [],
  confirmation: { sha256: "", confirmed_at: "2026-11-11T09:00:00+09:00", confirmed_by: "studio-owner" },
} as ConfirmedPlan;

const confirmedResult = (spentUsd: number): PlanResult =>
  ({ kind: "confirmed", plan: confirmedPlan, spentUsd, remainingUsd: 2 - spentUsd }) as unknown as PlanResult;

const stoppedResult = (spentUsd: number): PlanResult =>
  ({ kind: "stopped", reason: "declined", failure: null, spentUsd, remainingUsd: 2 - spentUsd }) as unknown as PlanResult;

const noopClient: LlmClient = {
  async callStructured<T>(): Promise<LlmStructuredResponse<T>> {
    return { output: {} as T, usage: undefined };
  },
  async callWithTools(): Promise<LlmToolResponse> {
    throw new Error("道具付きの呼び出しは使わない");
  },
};

interface DepsParts {
  readonly runPlan: FactoryChildDeps["runPlan"];
  readonly runCli: FactoryChildDeps["runCli"];
  readonly writeFile?: FactoryChildDeps["writeFile"];
  readonly now?: FactoryChildDeps["now"];
  readonly env?: FactoryChildDeps["env"];
}

const makeDeps = (parts: DepsParts): FactoryChildDeps => ({
  runPlan: parts.runPlan,
  runCli: parts.runCli,
  loadDocuments: async () => [],
  makeClient: () => noopClient,
  readFile: async () => "",
  writeFile: parts.writeFile ?? (async () => {}),
  makeDirectory: async () => {},
  now: parts.now ?? (() => 1_000_000),
  env: parts.env ?? { OPENAI_API_KEY: "sk-FAKE" },
});

const request = (): FactoryChildRequest => ({
  jobId: "job-1",
  request: SOURCE,
  budgetUsd: 2,
  outDir: OUT_DIR,
});

const tick = async (): Promise<void> => {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
};

const deadlineOf = (now: number): number => now + FACTORY_PLAN_DEADLINE_MS;

describe("工場の子", () => {
  it("答えが届くまで Plan が進まず、確定したら標準の組で Build を流す", async () => {
    const channel = new TestChannel();
    const writes: string[] = [];
    const buildDeps: CliDeps[] = [];
    const deps = makeDeps({
      runPlan: async (input) => {
        const outcome = await input.responder.answer(answerRequest(1));
        expect(outcome.kind).toBe("answers");
        return confirmedResult(0.4);
      },
      runCli: async (cli) => {
        buildDeps.push(cli);
        cli.log?.(JSON.stringify({ verdict: "full", provider_cost_usd: 0.5 }));
        return 0;
      },
      writeFile: async (path) => {
        writes.push(path);
      },
    });

    let settled = false;
    const pending = runFactoryChild(request(), channel, deps);
    void pending.then(() => {
      settled = true;
    });
    await tick();

    expect(channel.asks).toHaveLength(1);
    expect(channel.asks[0]?.revision).toBe(1);
    expect(settled).toBe(false);

    channel.answer({ kind: "answers", revision: 1, answers: [{ questionId: "Q1-1", choiceId: "c1" }] });
    const outcome = await pending;

    expect(outcome).toEqual({ kind: "finished", verdict: "full", spentUsd: 0.9, outDir: OUT_DIR });
    expect(buildDeps).toHaveLength(1);
    expect(buildDeps[0]?.argv).toEqual(
      buildFactoryBuildArgs({
        requestFile: join(OUT_DIR, "request.txt"),
        outDir: OUT_DIR,
        planFile: join(OUT_DIR, "plan-result.json"),
        planSpentUsd: 0.4,
        perRunLimitUsd: 2,
      }),
    );

    expect(writes).toContain(join(OUT_DIR, "request.txt"));
    expect(writes).toContain(join(OUT_DIR, "plan-result.json"));
    expect(writes).toContain(join(OUT_DIR, "summary.json"));
    expect(writes.every((path) => path.startsWith(OUT_DIR))).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("社外秘");
  });

  it("確認で「やめる」なら Build を起こさない", async () => {
    const channel = new TestChannel();
    let buildCalled = false;
    const deps = makeDeps({
      runPlan: async (input) => {
        const decision = await input.responder.confirm(confirmationView);
        return decision === "stop" ? stoppedResult(0.1) : confirmedResult(0.1);
      },
      runCli: async () => {
        buildCalled = true;
        return 0;
      },
    });

    const pending = runFactoryChild(request(), channel, deps);
    await tick();
    expect(channel.confirmations).toHaveLength(1);
    channel.answerConfirm("stop");

    await expect(pending).resolves.toEqual({
      kind: "stopped",
      reason: "declined",
      spentUsd: 0.1,
      codes: [],
    });
    expect(buildCalled).toBe(false);
  });

  it("工場の終了コード 3 は「差し戻し」になる", async () => {
    const channel = new TestChannel();
    const deps = makeDeps({
      runPlan: async () => confirmedResult(0.4),
      runCli: async (cli) => {
        cli.log?.(JSON.stringify({ verdict: "none", provider_cost_usd: 0.2 }));
        return 3;
      },
    });

    const outcome = await runFactoryChild(request(), channel, deps);
    expect(outcome.kind).toBe("sent-back");
    if (outcome.kind !== "sent-back") return;
    expect(outcome.outDir).toBe(OUT_DIR);
    expect(outcome.spentUsd).toBeCloseTo(0.6, 10);
  });

  it("確定できない Plan は理由の分類だけを返す", async () => {
    const channel = new TestChannel();
    const deps = makeDeps({
      runPlan: async () =>
        ({
          kind: "cannot-confirm",
          openIssues: [],
          reasons: [{ source: "confirm", code: "open_critical", path: "open_issues" }],
          spentUsd: 0.2,
        }) as unknown as PlanResult,
      runCli: async () => {
        throw new Error("Build を起こさない");
      },
    });

    const outcome = await runFactoryChild(request(), channel, deps);
    expect(outcome).toEqual({ kind: "stopped", reason: "cannot-confirm", spentUsd: 0.2, codes: ["open_critical"] });
    expect(JSON.stringify(outcome)).not.toContain("社外秘");
  });

  it("締切の 1 分前の確認は Build を起こし、締切を過ぎた確認は時間切れになる", async () => {
    let beforeNow = 1_000_000;
    const beforeChannel = new TestChannel();
    let beforeBuild = false;
    const beforeDeps = makeDeps({
      now: () => beforeNow,
      runPlan: async (input) => {
        const decision = await input.responder.confirm(confirmationView);
        return decision === "stop" ? stoppedResult(0.1) : confirmedResult(0.1);
      },
      runCli: async () => {
        beforeBuild = true;
        return 0;
      },
    });
    const before = runFactoryChild(request(), beforeChannel, beforeDeps);
    await tick();
    beforeNow = deadlineOf(1_000_000) - 60_000;
    beforeChannel.answerConfirm("build");
    await expect(before).resolves.toMatchObject({ kind: "finished" });
    expect(beforeBuild).toBe(true);

    let afterNow = 2_000_000;
    const afterChannel = new TestChannel();
    let afterBuild = false;
    const afterDeps = makeDeps({
      now: () => afterNow,
      runPlan: async (input) => {
        const decision = await input.responder.confirm(confirmationView);
        return decision === "stop" ? stoppedResult(0.1) : confirmedResult(0.1);
      },
      runCli: async () => {
        afterBuild = true;
        return 0;
      },
    });
    const after = runFactoryChild(request(), afterChannel, afterDeps);
    await tick();
    afterNow = deadlineOf(2_000_000) + 1;
    afterChannel.answerConfirm("build");
    await expect(after).resolves.toEqual({ kind: "stopped", reason: "timeout", spentUsd: 0.1, codes: [] });
    expect(afterBuild).toBe(false);
  });

  it("LLM の鍵が無ければ、工場を呼ばずに失敗を返す", async () => {
    const channel = new TestChannel();
    let called = false;
    const deps = makeDeps({
      env: {},
      runPlan: async () => {
        called = true;
        return confirmedResult(0);
      },
      runCli: async () => 0,
    });
    await expect(runFactoryChild(request(), channel, deps)).resolves.toEqual({
      kind: "failed",
      reason: "missing-openai-key",
      spentUsd: 0,
    });
    expect(called).toBe(false);
  });
});
