import { planDigest, PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { EXIT_USAGE, VOCABULARY_VERSION, runCli, type CliDeps, type PlanResult } from "@musunest/factory";
import { describe, expect, it } from "vitest";
import { STANDARD_BUILD_EFFORT, STANDARD_BUILD_MODEL } from "./build-args.js";
import { FACTORY_PLAN_DEADLINE_MS } from "./factory-child.js";
import { buildPlanEnvelope, defaultPlanEnvelopeConditions } from "./plan-envelope.js";

const SOURCE = "毎日の記録を一覧で見たい。新しい順に並べる。";
const REQUEST_PATH = "/virtual/request.txt";
const PLAN_PATH = "/virtual/plan-result.json";
const OUT_DIR = "/virtual/out";
const REACHED_BUILD = "envelope-accepted";

const makePlan = async (): Promise<ConfirmedPlan> => {
  const unsigned: ConfirmedPlan = {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-envelope-1",
    revision: 1,
    vocabulary_version: VOCABULARY_VERSION,
    inputs: [
      { id: "S-1", kind: "source", text: SOURCE },
      {
        id: "Q-1",
        kind: "question",
        open_issue_id: "OI-1",
        text: "一覧はどの順に並べますか？",
        choices: [
          { id: "c1", text: "新しい順" },
          { id: "c2", text: "古い順" },
        ],
        recommended: { choice_id: "c1", reason: "最近のものから見られるから" },
      },
      { id: "A-1", kind: "answer", question_id: "Q-1", choice_id: "c1" },
    ],
    requirements: [
      {
        id: "R-1",
        text: "一覧を新しい順に並べる。",
        kind: "existence",
        origin: { input_id: "S-1", quote: SOURCE },
        parts: [],
      },
    ],
    open_issues: [
      {
        id: "OI-1",
        text: "並び順が決まっていない。",
        critical: true,
        status: "resolved",
        resolution: { answer_id: "A-1" },
      },
    ],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "", confirmed_at: "2026-11-11T09:00:00+09:00", confirmed_by: "studio-owner" },
  };
  return { ...unsigned, confirmation: { ...unsigned.confirmation, sha256: await planDigest(unsigned) } };
};

const makeEnvelopeText = async (): Promise<{ readonly text: string; readonly plan: ConfirmedPlan }> => {
  const plan = await makePlan();
  const result = { kind: "confirmed", plan, spentUsd: 0.3 } as unknown as PlanResult;
  const envelope = await buildPlanEnvelope({
    result,
    source: SOURCE,
    conditions: defaultPlanEnvelopeConditions({
      model: STANDARD_BUILD_MODEL,
      effort: STANDARD_BUILD_EFFORT,
      budgetUsd: 2,
      deadlineMs: FACTORY_PLAN_DEADLINE_MS,
    }),
  });
  return { text: JSON.stringify(envelope), plan };
};

const buildArgs = (): readonly string[] => [
  REQUEST_PATH,
  "--out",
  OUT_DIR,
  "--pipeline",
  "v1.2",
  "--plan-file",
  PLAN_PATH,
  "--model",
  "gpt-6-luna",
  "--effort",
  "medium",
  "--stage-effort",
  "test-spec=high",
  "--stage-model",
  "test-spec=gpt-6.1-terra",
  "--budget",
  "1.70",
];

const depsFor = (planText: string, log: string[]): CliDeps => ({
  argv: buildArgs(),
  env: { OPENAI_API_KEY: "sk-FAKE" },
  readFile: async (path) => {
    if (path === REQUEST_PATH) return SOURCE;
    if (path === PLAN_PATH) return planText;
    throw new Error("知らないファイル");
  },
  writeFile: async () => {},
  makeDirectory: async () => {},
  loadDocuments: async () => {
    throw new Error(REACHED_BUILD);
  },
  makeClient: () => {
    throw new Error(REACHED_BUILD);
  },
  log: (line) => log.push(line),
});

describe("Build の入力の包み", () => {
  it("仕様と依頼文の SHA-256 を、工場と同じ値で組む", async () => {
    const { text, plan } = await makeEnvelopeText();
    const envelope = JSON.parse(text) as {
      schema_version: string;
      outcome: string;
      plan_sha256: string;
      source_sha256: string;
      stop: unknown;
    };
    expect(envelope.schema_version).toBe("musunest-factory/plan-only-result/v1");
    expect(envelope.outcome).toBe("confirmed");
    expect(envelope.plan_sha256).toBe(await planDigest(plan));
    expect(envelope.stop).toBeNull();
    expect(envelope.source_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("工場の手元の入口に --plan-file で渡しても、包みの検査で断られない", async () => {
    const { text } = await makeEnvelopeText();
    const log: string[] = [];
    await expect(runCli(depsFor(text, log))).rejects.toThrow(REACHED_BUILD);
    const output = log.join("\n");
    expect(output).not.toContain("plan-file-reject");
    expect(output).not.toContain("plan-file-error");
  });

  it("仕様を 1 文字変えると包みの検査で断られる（二点測定）", async () => {
    const { text } = await makeEnvelopeText();
    const parsed = JSON.parse(text) as { plan: { requirements: { text: string }[] } };
    const first = parsed.plan.requirements[0];
    if (first === undefined) throw new Error("要件が無い");
    const lastCharacter = first.text.slice(-1);
    first.text = `${first.text.slice(0, -1)}${lastCharacter === "。" ? "、" : "。"}`;
    const mutated = JSON.stringify(parsed);

    const log: string[] = [];
    const code = await runCli(depsFor(mutated, log));
    expect(code).toBe(EXIT_USAGE);
    const output = log.join("\n");
    expect(output).toContain("\"schema_version\":\"musunest-factory/plan-file-reject/v1\"");
    expect(output).not.toContain(first.text);
  });
});
