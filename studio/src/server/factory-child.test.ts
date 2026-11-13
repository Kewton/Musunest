import type { ConfirmedPlan } from "@musunest/appspec-schema";
import { PLAN_CLI_RECORD_FILE, PLAN_SURFACE_CHECK_FILE } from "@musunest/factory";
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

/** 記録の組み立てが読む欄をすべて持つ、偽物の Plan の結果（値は最小。Issue #885） */
const recordFields = (): Record<string, unknown> => ({
  stages: [],
  judge: { calls_by_adapter: {}, cost_usd: 0 },
  closedBySource: [],
  closedByDefault: [],
  requirementsDiagnosis: {
    rounds: [],
    redone: false,
    unmet: { quoteNotFound: 0, positionMismatch: 0, uncoveredSource: { code: 0, conversation: 0 } },
  },
  surfaceCheck: { accepted: 0, dropped: 0, ambiguity: 0, unchecked: 0, completed: true, judgments: [] },
  surfaceCheckDiagnostics: [],
  diffReviews: [],
  openIssueConflicts: {
    ids: 1,
    rows: [{ existing: "catalog", added: "surface", count: 1 }],
    attribution: [],
    emptyTargets: 0,
    round: 2,
  },
  surfaceIdReuse: [],
  surfaceTargetAttempts: [],
  issueFlow: [
    {
      revision: 2,
      startOpen: 1,
      opened: { total: 1, initial: 0, diff: 1, byOrigin: [{ origin: "surface", count: 1 }] },
      closed: { total: 1, answerMain: 1, alsoCloses: 0, source: 0, default: 0 },
      inheritedResolved: 0,
      endOpen: { critical: 1, nonCritical: 0 },
      end: "cannot-confirm",
    },
  ],
  remainingOpenIssues: [
    {
      origin: "surface",
      revision: 2,
      critical: true,
      requirementKind: "behavior",
      facetId: null,
      issueId: "OI-extra",
      requirementId: "R-1",
    },
  ],
  answerClosures: [
    {
      answerId: "A:Q2-1",
      questionId: "Q2-1",
      revision: 2,
      answerRequirementId: "R:A:Q2-1",
      closed: [
        { issueId: "OI:catalog:R-1:aggregation", how: "main", requirementId: "R-1", facetId: "aggregation" },
      ],
    },
  ],
  confirmCoverage: [],
});

const recordCannotConfirmResult = (): PlanResult =>
  ({
    kind: "cannot-confirm",
    openIssues: [],
    reasons: [{ source: "confirm", code: "open_critical", path: "open_issues" }],
    spentUsd: 0.2,
    remainingUsd: 1.8,
    ...recordFields(),
  }) as unknown as PlanResult;

const recordDeclinedResult = (): PlanResult =>
  ({
    kind: "stopped",
    reason: "declined",
    failure: null,
    spentUsd: 0.2,
    remainingUsd: 1.8,
    ...recordFields(),
  }) as unknown as PlanResult;

const recordStoppedResult = (): PlanResult =>
  ({
    kind: "stopped",
    reason: "budget",
    failure: null,
    spentUsd: 0.2,
    remainingUsd: 1.8,
    ...recordFields(),
  }) as unknown as PlanResult;

const recordConfirmedResult = (): PlanResult =>
  ({
    kind: "confirmed",
    plan: confirmedPlan,
    spentUsd: 0.2,
    remainingUsd: 1.8,
    ...recordFields(),
  }) as unknown as PlanResult;

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

  it("確定できない Plan でも記録と診断を書き、事項の流れ・残った事項・衝突が結果と一致する", async () => {
    const channel = new TestChannel();
    const written = new Map<string, string>();
    const deps = makeDeps({
      runPlan: async () => recordCannotConfirmResult(),
      runCli: async () => {
        throw new Error("Build を起こさない");
      },
      writeFile: async (path, text) => {
        written.set(path, text);
      },
    });

    const outcome = await runFactoryChild(request(), channel, deps);
    expect(outcome).toEqual({
      kind: "stopped",
      reason: "cannot-confirm",
      spentUsd: 0.2,
      codes: ["open_critical"],
    });

    const record = JSON.parse(written.get(join(OUT_DIR, PLAN_CLI_RECORD_FILE)) ?? "null") as Record<string, unknown>;
    expect(record["outcome"]).toBe("cannot-confirm");
    expect(record["cannot_confirm"]).toEqual([{ source: "confirm", code: "open_critical", path: "open_issues" }]);
    expect(record["issue_flow"]).toHaveLength(1);
    expect(record["issue_flow"]).toMatchObject([
      { revision: 2, start_open: 1, closed: { total: 1, answer_main: 1 }, end: "cannot-confirm" },
    ]);
    expect(record["remaining_open_issues"]).toEqual([
      {
        origin: "surface",
        revision: 2,
        critical: true,
        requirement_kind: "behavior",
        facet_id: null,
        issue_id: "OI-extra",
        requirement_id: "R-1",
      },
    ]);
    expect(record["answer_closures"]).toEqual([
      {
        answer_id: "A:Q2-1",
        question_id: "Q2-1",
        revision: 2,
        answer_requirement_id: "R:A:Q2-1",
        closed: [
          { issue_id: "OI:catalog:R-1:aggregation", how: "main", requirement_id: "R-1", facet_id: "aggregation" },
        ],
      },
    ]);
    expect(record["open_issue_conflicts"]).toMatchObject({
      ids: 1,
      rows: [{ existing: "catalog", added: "surface", count: 1 }],
      round: 2,
    });

    const diagnostic = JSON.parse(written.get(join(OUT_DIR, PLAN_SURFACE_CHECK_FILE)) ?? "null") as Record<
      string,
      unknown
    >;
    expect(diagnostic).toMatchObject({ plan_id: "studio-job-1", claims: [] });
  });

  it("確認でやめた・段の失敗・確定した、の各場合も同じ 2 つを書く", async () => {
    for (const makeResult of [recordDeclinedResult, recordStoppedResult, recordConfirmedResult]) {
      const written: string[] = [];
      const deps = makeDeps({
        runPlan: async () => makeResult(),
        runCli: async () => 0,
        writeFile: async (path) => {
          written.push(path);
        },
      });
      await runFactoryChild(request(), new TestChannel(), deps);
      expect(written).toContain(join(OUT_DIR, PLAN_CLI_RECORD_FILE));
      expect(written).toContain(join(OUT_DIR, PLAN_SURFACE_CHECK_FILE));
    }
  });

  it("記録の書き込みが失敗しても、子の結果は書き込みが成功した場合と同じ", async () => {
    const control = await runFactoryChild(
      request(),
      new TestChannel(),
      makeDeps({
        runPlan: async () => recordCannotConfirmResult(),
        runCli: async () => {
          throw new Error("Build を起こさない");
        },
      }),
    );

    const logs: string[] = [];
    const failingDeps = makeDeps({
      runPlan: async () => recordCannotConfirmResult(),
      runCli: async () => {
        throw new Error("Build を起こさない");
      },
      writeFile: async (path) => {
        if (path.endsWith(PLAN_CLI_RECORD_FILE) || path.endsWith(PLAN_SURFACE_CHECK_FILE)) {
          throw new Error("記録の書き込みの失敗");
        }
      },
    });
    const failing = await runFactoryChild(request(), new TestChannel(), {
      ...failingDeps,
      log: (line) => logs.push(line),
    });

    expect(failing).toEqual(control);
    expect(logs.filter((line) => line === "Plan の記録を書けませんでした")).toHaveLength(1);
  });

  it("Plan が例外で終わったら記録を書かず、今までどおり失敗を返す", async () => {
    const written: string[] = [];
    const deps = makeDeps({
      runPlan: async () => {
        throw new Error("Plan の失敗");
      },
      runCli: async () => 0,
      writeFile: async (path) => {
        written.push(path);
      },
    });

    await expect(runFactoryChild(request(), new TestChannel(), deps)).resolves.toEqual({
      kind: "failed",
      reason: "factory-failure",
      spentUsd: 0,
    });
    expect(written).not.toContain(join(OUT_DIR, PLAN_CLI_RECORD_FILE));
    expect(written).not.toContain(join(OUT_DIR, PLAN_SURFACE_CHECK_FILE));
  });
});
