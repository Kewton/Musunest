// モデル → 単価の表を引くときの「表の持ち主の契約」（Issue #836）。
//
// 固定するのは 6 つ。
//   1. 単価を引く関数は、表が自分で持つ名前のときだけ表の値を使う。継承の名前（constructor・toString・
//      hasOwnProperty・__proto__）は既定の単価へ倒す（直す前の式は既定でない値を返すことも残す）。
//   2. --stage-model を付けない --model <継承の名前> の Build だけの走り（v1・v1.2）は、--model gpt-unknown の
//      走りと同じ単価で予約・精算し、例外で落ちない。終了コードと費用の欄はモデル名の欄を除いて同じ。
//   3. --stage-model を付けた走りは、継承の名前を段のモデルにも走りのモデルにも stage-model:model で断る。
//   4. 共通の口を直接組み、段のモデルの組に継承の名前を渡すと、その段の予約と精算が元の口の単価になる。
//   5. luna・terra・gpt-unknown の単価は直す前と等値。
//   6. 反例：差し込む表で継承の名前の値が有効な単価の形でも採らない。表がその名前を自分で持つなら採る。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PLAN_SPEC_SCHEMA_VERSION, planDigest, type ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import {
  API_KEY_ENV,
  DEFAULT_RATES,
  EXIT_OK,
  EXIT_USAGE,
  MODEL_RATES,
  STAGE_MODEL_USAGE,
  TERRA_RATES,
  isKnownModel,
  modelRatesOf,
  parseStageModels,
  runCli,
} from "../cli.js";
import { BUILD_CLI_RECORD_FILE, PLAN_ONLY_RESULT_SCHEMA } from "../cli-plan.js";
import { JobBudget, costOfUsageUsd, estimateMaxCostUsd, type TokenRates } from "../budget.js";
import {
  CallGateway,
  estimateInputUpperBoundTokens,
  hasOwnRatesKey,
  structuredInputParts,
} from "../call.js";
import { createFakeJudge } from "../judge-fake.js";
import { createRecordingClient } from "../stages/__tests__/prompt.js";
import { DEFAULT_OPENAI_MODEL } from "../openai.js";
import { requirementsFromPlan, type RequirementList } from "../pipeline.js";
import type { LedgerView } from "../v12/ledger.js";
import * as ledgerModule from "../v12/ledger.js";
import {
  FIXTURE_DOCUMENTS,
  FIXTURE_YAML,
  casesResponseOf,
  codeIdRenameOf,
  createCheckedRecordingClient,
  fixtureList,
  fixtureTable,
  idsResponseList,
  idsResponsesOf,
  renameIds,
  withAggregates,
  withCodeIds,
} from "../v11a/__tests__/fixtures.js";
import type { NameTable } from "../v11a/names.js";
import {
  CONFIRMED_PLAN,
  SOURCE_TEXT,
  USAGE as RECORDED_USAGE,
  recordedRunFromPlan,
  structured,
} from "../__tests__/run.js";
import type { RecordedCall } from "../llm-fake.js";
import type {
  LlmClient,
  LlmStructuredRequest,
  LlmStructuredResponse,
  LlmToolRequest,
  LlmToolResponse,
  LlmUsage,
} from "../llm.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const TERRA = "gpt-6.1-terra";
const LUNA = DEFAULT_OPENAI_MODEL;

let directory = "";
beforeAll(async () => {
  directory = await mkdtemp(`${tmpdir()}/factory-model-rates-own-`);
});
afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

/** オブジェクトが継承する名前（表の持ち主ではない名前。Issue #836） */
const INHERITED_NAMES = ["constructor", "toString", "hasOwnProperty", "__proto__"] as const;

/** 手計算の例（Issue #829 と同じ）：入力 1,000・キャッシュ読み 300・キャッシュ書き 200・出力 100 */
const USAGE: LlmUsage = {
  inputTokens: 1_000,
  cachedInputTokens: 300,
  cacheWriteTokens: 200,
  outputTokens: 100,
  reasoningTokens: 0,
};

describe("(1)(5)(6) 単価を引く関数は表が自分で持つ名前だけを見る（Issue #836）", () => {
  it("(1) 継承の名前は既定の単価を返す。直す前の式は既定の単価でない値を返す（試験に残す）", () => {
    for (const name of INHERITED_NAMES) {
      // 直す前の式（表をそのまま引く）は、継承した関数やオブジェクトを返していた
      expect((MODEL_RATES as Record<string, unknown>)[name]).not.toBe(DEFAULT_RATES);
      expect(isKnownModel(name)).toBe(false);
      expect(modelRatesOf(name)).toBe(DEFAULT_RATES);
      expect(modelRatesOf(name, MODEL_RATES)).toBe(DEFAULT_RATES);
    }
  });

  it("(5) luna・terra・gpt-unknown の単価は直す前と等値", () => {
    expect(isKnownModel(LUNA)).toBe(true);
    expect(isKnownModel(TERRA)).toBe(true);
    expect(isKnownModel("gpt-unknown")).toBe(false);
    expect(modelRatesOf(LUNA)).toBe(DEFAULT_RATES);
    expect(modelRatesOf(TERRA)).toBe(TERRA_RATES);
    expect(modelRatesOf("gpt-unknown")).toBe(DEFAULT_RATES);
  });

  it("(6) 継承した名前の値が有効な単価の形でも採らない。表が同じ名前を自分で持つなら採る", () => {
    const inheritedValue: TokenRates = { inputPerToken: 9, cachedInputPerToken: 9, outputPerToken: 9 };
    // プロトタイプが有効な単価の形を持つ表（表自身はその名前を持たない）
    const inheritedTable = Object.assign(Object.create({ constructor: inheritedValue, toString: inheritedValue }), {
      [TERRA]: TERRA_RATES,
    }) as Record<string, TokenRates>;
    expect((inheritedTable as Record<string, unknown>)["constructor"]).toBe(inheritedValue);
    expect(hasOwnRatesKey(inheritedTable, "constructor")).toBe(false);
    expect(isKnownModel("constructor", inheritedTable)).toBe(false);
    expect(modelRatesOf("constructor", inheritedTable)).toBe(DEFAULT_RATES);
    expect(modelRatesOf("toString", inheritedTable)).toBe(DEFAULT_RATES);

    // 表が自分で持つなら、継承の名前と同じ名前でもその単価を使う
    const ownTable: Record<string, TokenRates> = { constructor: inheritedValue, toString: inheritedValue };
    expect(hasOwnRatesKey(ownTable, "constructor")).toBe(true);
    expect(isKnownModel("constructor", ownTable)).toBe(true);
    expect(modelRatesOf("constructor", ownTable)).toBe(inheritedValue);
    expect(modelRatesOf("toString", ownTable)).toBe(inheritedValue);

    // __proto__ も、自分で持つなら採る（名前の列挙で断る直し方を防ぐ）
    const ownProto = Object.fromEntries([["__proto__", inheritedValue]]) as Record<string, TokenRates>;
    expect(hasOwnRatesKey(ownProto, "__proto__")).toBe(true);
    expect(modelRatesOf("__proto__", ownProto)).toBe(inheritedValue);
  });
});

/** 応答の usage を固定する偽物の LLM（外部 API を呼ばない） */
class RecordingLlm implements LlmClient {
  readonly structuredRequests: LlmStructuredRequest[] = [];
  constructor(private readonly usage: LlmUsage | undefined) {}
  async callStructured<T>(request: LlmStructuredRequest): Promise<LlmStructuredResponse<T>> {
    this.structuredRequests.push(request);
    return { output: {} as T, usage: this.usage };
  }
  async callWithTools(_request: LlmToolRequest): Promise<LlmToolResponse> {
    return { kind: "done", declaration: {}, usage: this.usage };
  }
}

const REQUEST = (maxOutputTokens: number): LlmStructuredRequest => ({
  instructions: "instructions",
  documents: ["document"],
  input: "data",
  schemaName: "test",
  schema: { type: "object" },
  maxOutputTokens,
});

/** 元の口の単価を既定の単価と違う値にした口（「元の口へ戻す」と「既定へ戻す」を見分ける） */
function gatewayWithInheritedStageModel(options: {
  readonly model: string;
  readonly usage: LlmUsage | undefined;
  readonly budgetUsd?: number;
}): { readonly gateway: CallGateway; readonly budget: JobBudget } {
  const budget = new JobBudget(options.budgetUsd ?? 10);
  const gateway = new CallGateway({
    client: new RecordingLlm(options.usage),
    budget,
    rates: TERRA_RATES,
    now: () => 0,
    deadline: 10 * 60 * 1000,
    effort: "high",
    stageModels: { write: options.model },
    stageModelRates: MODEL_RATES,
  });
  return { gateway, budget };
}

describe("(4) 段の見方は表が自分で持つ名前だけを見る（Issue #836）", () => {
  it("(4) 段のモデルに継承の名前を渡すと、予約と精算が元の口の単価（既定の単価ではない）になる", async () => {
    const { gateway, budget } = gatewayWithInheritedStageModel({ model: "constructor", usage: USAGE });
    const write = gateway.forStage("write");
    const result = await write.callStructured(REQUEST(write.maxOutputTokens("write")));
    expect(result.kind).toBe("ok");
    // 元の口は terra。既定（luna）ではない
    expect(budget.spentUsd).toBeCloseTo(costOfUsageUsd(USAGE, TERRA_RATES), 12);
    expect(budget.spentUsd).not.toBeCloseTo(costOfUsageUsd(USAGE, DEFAULT_RATES), 12);
  });

  it("(4) usage が返らない呼び出しの予約も、元の口の単価で取る", async () => {
    const { gateway, budget } = gatewayWithInheritedStageModel({ model: "__proto__", usage: undefined });
    const write = gateway.forStage("write");
    const maxOutputTokens = write.maxOutputTokens("write");
    const inputTokens = estimateInputUpperBoundTokens(structuredInputParts(REQUEST(maxOutputTokens)));
    const result = await write.callStructured(REQUEST(maxOutputTokens));
    expect(result.kind).toBe("ok");
    const rootReservation = estimateMaxCostUsd({ inputTokens, maxOutputTokens, rates: TERRA_RATES });
    const defaultReservation = estimateMaxCostUsd({ inputTokens, maxOutputTokens, rates: DEFAULT_RATES });
    expect(budget.reservedUsd).toBeCloseTo(rootReservation, 12);
    expect(budget.reservedUsd).not.toBeCloseTo(defaultReservation, 12);
  });

  it("(4) 表が継承の名前を自分で持つなら、その段の単価を使う", async () => {
    const ownRates: TokenRates = { inputPerToken: 1e-5, cachedInputPerToken: 1e-5, outputPerToken: 1e-5 };
    const budget = new JobBudget(10);
    const gateway = new CallGateway({
      client: new RecordingLlm(USAGE),
      budget,
      rates: TERRA_RATES,
      now: () => 0,
      deadline: 10 * 60 * 1000,
      effort: "high",
      stageModels: { write: "constructor" },
      stageModelRates: { constructor: ownRates },
    });
    const write = gateway.forStage("write");
    const result = await write.callStructured(REQUEST(write.maxOutputTokens("write")));
    expect(result.kind).toBe("ok");
    expect(budget.spentUsd).toBeCloseTo(costOfUsageUsd(USAGE, ownRates), 12);
  });

  it("(3)(6) 入口の解析：継承の名前は段のモデルにも走りのモデルにも stage-model:model", () => {
    expect(parseStageModels(["test-spec=constructor"], "openai", TERRA)).toEqual({ code: "stage-model:model" });
    expect(parseStageModels(["test-spec=__proto__"], "openai", TERRA)).toEqual({ code: "stage-model:model" });
    expect(parseStageModels([`test-spec=${TERRA}`], "openai", "constructor")).toEqual({ code: "stage-model:model" });
    expect(parseStageModels([`test-spec=${TERRA}`], "openai", "toString")).toEqual({ code: "stage-model:model" });
  });
});

// ── CLI の Build だけの走り（偽物の LLM・偽物の判定・偽物の時計）─────────────────────

const V11A_BASE_LIST: RequirementList = {
  ...fixtureList(),
  requirements: fixtureList().requirements.filter((requirement) => requirement.id !== "R5"),
};
const V11A_SOURCE = V11A_BASE_LIST.requirements.map((requirement) => requirement.text).join("");
const V11A_IDS = ["R1", "R2", "R3", "R4"] as const;

function v11aPlanBody(): ConfirmedPlan {
  return {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-v11a-cli",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: V11A_SOURCE }],
    requirements: V11A_BASE_LIST.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: "constraining" as const,
      origin: { input_id: "in-1", quote: requirement.quote },
      parts: [{ id: `${requirement.id}-p1`, text: requirement.text, disposition: "met" as const }],
    })),
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
  };
}

/** 包みの検査を通る確定した仕様（確認の SHA を中身に合わせる） */
async function v11aPlan(): Promise<ConfirmedPlan> {
  const plan = v11aPlanBody();
  return { ...plan, confirmation: { ...plan.confirmation, sha256: await planDigest(plan) } };
}

/** `--plan-file` の包み（`plan-result.json` の全欄。人が作る包みでは条件を null にする） */
async function v11aEnvelope(): Promise<Record<string, unknown>> {
  const plan = await v11aPlan();
  return {
    schema_version: PLAN_ONLY_RESULT_SCHEMA,
    outcome: "confirmed",
    plan,
    plan_sha256: await planDigest(plan),
    source_sha256: await sha256Hex(V11A_SOURCE),
    conditions: null,
    stop: null,
  };
}

/** v1 の `--plan-file` の包み（`recordedRunFromPlan` の応答と組む） */
async function v1Envelope(): Promise<Record<string, unknown>> {
  const plan = { ...CONFIRMED_PLAN, confirmation: { ...CONFIRMED_PLAN.confirmation, sha256: await planDigest(CONFIRMED_PLAN) } };
  return {
    schema_version: PLAN_ONLY_RESULT_SCHEMA,
    outcome: "confirmed",
    plan,
    plan_sha256: await planDigest(plan),
    source_sha256: await sha256Hex(SOURCE_TEXT),
    conditions: null,
    stop: null,
  };
}

const V11A_LIST = requirementsFromPlan(v11aPlanBody());
const without5 = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] =>
  entries.filter((entry) => entry.requirementId !== "R5");
const V11A_TABLE: NameTable = (() => {
  const table = fixtureTable();
  return {
    rows: table.rows,
    ownership: without5(table.ownership),
    verification: without5(table.verification),
    classification: without5(table.classification),
  };
})();
const V11A_YAML = FIXTURE_YAML.replace("show: [title, amount, kind]", "show: [title, owner, amount, day, kind]");

const V11A_KINDS = ["normal", "abnormal", "boundary"] as const;
type V11aKind = (typeof V11A_KINDS)[number];

/** strict の schema の形の試験 1 件（入力・期待の値は JSON の文字列） */
function v11aTest(options: {
  readonly id: string;
  readonly requirementId: string;
  readonly targetKind: string;
  readonly roleId: string;
  readonly kind?: V11aKind;
  readonly operation: string;
  readonly observes: string;
  readonly input?: unknown;
  readonly expected: { readonly kind: "ok" | "error"; readonly value: string | null; readonly code: string | null };
  readonly assertion?: Record<string, unknown> | null;
  readonly referenceData?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    id: options.id,
    target: { requirementId: options.requirementId, kind: options.targetKind, roleId: options.roleId },
    kind: options.kind ?? "normal",
    operation: options.operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: JSON.stringify(options.input ?? {}),
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
    referenceData: options.referenceData ?? [],
    expected: options.expected,
    assertion: options.assertion ?? null,
    observes: options.observes,
  };
}

const okValue = (value: string) => ({ kind: "ok" as const, value, code: null });
const V11A_ITEM_ROWS = [1, 2, 3].map((index) => ({
  target: { requirementId: "R4", kind: "entity", roleId: "e.item" },
  rowId: `item-${index}`,
  values: JSON.stringify({ "f.item.amount": 1 }),
}));

/** T2 の応答（要件ごとの分類と、R1〜R4 の試験） */
function v11aTestSpec(): Record<string, unknown> {
  const tests = [
    ...V11A_KINDS.map((kind) =>
      v11aTest({
        id: `r1-${kind}`,
        requirementId: "R1",
        targetKind: "field",
        roleId: "f.item.amount",
        kind,
        operation: "validate",
        observes: "validation",
        input: { "f.item.amount": kind === "abnormal" ? -1 : kind === "boundary" ? 1 : 5 },
        expected: kind === "abnormal" ? { kind: "error", value: null, code: "E_INVALID" } : okValue("true"),
      }),
    ),
    v11aTest({
      id: "r2-shows",
      requirementId: "R2",
      targetKind: "screen",
      roleId: "s.members",
      operation: "structure",
      observes: "view-structure",
      expected: okValue("true"),
      assertion: { check: "view-shows", expected: null, refEntity: null, role: "f.member.title" },
    }),
    ...V11A_KINDS.map((kind) =>
      v11aTest({
        id: `r3-${kind}`,
        requirementId: "R3",
        targetKind: "operation",
        roleId: "o.closeItem",
        kind,
        operation: "action",
        observes: "when",
        input: { "f.item.amount": kind === "abnormal" ? -1 : kind === "boundary" ? 1 : 3 },
        expected: okValue(kind === "abnormal" ? "false" : "true"),
      }),
    ),
    ...V11A_KINDS.map((kind) =>
      v11aTest({
        id: `r4-${kind}`,
        requirementId: "R4",
        targetKind: "computation",
        roleId: "c.rate",
        kind,
        operation: "compute",
        observes: "value",
        referenceData: V11A_ITEM_ROWS,
        expected: okValue("6"),
      }),
    ),
  ];
  return {
    classifications: [
      { requirementId: "R1", nature: "ruled" },
      { requirementId: "R2", nature: "existence-only" },
      { requirementId: "R3", nature: "ruled" },
      { requirementId: "R4", nature: "ruled" },
    ],
    tests,
  };
}

/** 旗 v12.ids の走りの T2 の応答（構造の要件 R2 を書かない。Issue #624） */
function v12TestSpec(): Record<string, unknown> {
  const spec = v11aTestSpec() as {
    classifications: readonly { requirementId: string }[];
    tests: readonly { target: { requirementId: string } }[];
  };
  return casesResponseOf({
    classifications: spec.classifications.filter((entry) => entry.requirementId !== "R2"),
    tests: spec.tests.filter((test) => test.target.requirementId !== "R2"),
  });
}

/** T1''・B3' の判定 */
const v11aJudgments = () => ({
  judgments: V11A_IDS.map((requirementId) => ({ requirementId, verdict: "accept", kind: null, quote: null })),
});

/** 旗 v12.ids の走りの表（題材の表をコードの形の ID に振り直し、計算の行に集計の欄。Issue #593） */
const V11A_CODE_RENAME = codeIdRenameOf(V11A_TABLE);
const V11A_TABLE_IDS: NameTable = withCodeIds(withAggregates(V11A_TABLE));
const v11aRenamed = <T,>(value: T): T => renameIds(value, V11A_CODE_RENAME);

/** v1.2 の走りの C1 の 3 束と C2 の記録（旗 ids の台帳） */
const v12TableCalls = (ledger: LedgerView = ledgerModule.PROPERTY_LEDGER_VIEW_IDS): RecordedCall[] =>
  idsResponseList(idsResponsesOf(V11A_LIST, V11A_TABLE_IDS, ledger)).map((output) => structured(output));

/** v1.2（旗 on）の走りの頭 */
const v12Head = (): RecordedCall[] => [
  ...v12TableCalls(),
  structured(v11aJudgments()),
  structured(v11aRenamed(v12TestSpec())),
  structured({ declaration: V11A_YAML }),
];

/** 判定の偽物（所属の組ごとに必要の値 0.9） */
function v11aJudge() {
  const answers: Record<string, { kind: "noul"; noul: number }> = {};
  for (const entry of V11A_TABLE.ownership) {
    for (const role of entry.roles) {
      answers[`need:${entry.requirementId}:${role.id}`] = { kind: "noul", noul: 0.9 };
      answers[`need:${entry.requirementId}:${V11A_CODE_RENAME.get(role.id) ?? role.id}`] = { kind: "noul", noul: 0.9 };
    }
  }
  return createFakeJudge(answers);
}

/** Build だけの走りを 1 回流す（v1 は `--pipeline` を付けない。v1.2 は `--pipeline v1.2`） */
async function runBuildOnly(input: {
  readonly dir: string;
  readonly pipeline: "v1" | "v1.2";
  readonly model: string;
  readonly calls: readonly RecordedCall[];
}): Promise<{
  readonly code: number;
  readonly summary: Record<string, unknown>;
  readonly record: Record<string, unknown>;
}> {
  const planPath = `${input.dir}-plan.json`;
  const planText = JSON.stringify(input.pipeline === "v1" ? await v1Envelope() : await v11aEnvelope());
  // v1 の記録は v1.2 と同じ strict の検査を持たない（既存の v1 の試験と同じ作法で流す）
  const recording =
    input.pipeline === "v1" ? createRecordingClient(input.calls) : createCheckedRecordingClient(input.calls);
  const lines: string[] = [];
  const code = await runCli({
    argv: [
      "--",
      "request.txt",
      "--out",
      input.dir,
      ...(input.pipeline === "v1.2" ? ["--pipeline", "v1.2"] : []),
      "--plan-file",
      planPath,
      "--model",
      input.model,
      "--budget",
      "1.00",
    ],
    env: { [API_KEY_ENV]: "sk-FAKE" },
    readFile: async (path) =>
      path === planPath ? planText : input.pipeline === "v1" ? SOURCE_TEXT : V11A_SOURCE,
    writeFile: async (path, text) => {
      await writeFile(path, text, "utf8");
    },
    makeDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
    loadDocuments: async () => (input.pipeline === "v1" ? [] : FIXTURE_DOCUMENTS),
    makeClient: () => recording.client,
    makeLlmJudge: () => (input.pipeline === "v1" ? createFakeJudge({}) : v11aJudge()),
    now: () => 0,
    log: (line) => lines.push(line),
    logError: () => {},
  });
  const summary = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  const record = JSON.parse(await readFile(`${input.dir}/${BUILD_CLI_RECORD_FILE}`, "utf8")) as Record<string, unknown>;
  return { code, summary, record };
}

/** モデル名の欄を除いた写し（費用の欄どうしを比べる） */
function withoutModel(value: Record<string, unknown>, key = "model"): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}
function conditionsOf(record: Record<string, unknown>): Record<string, unknown> {
  return withoutModel(record["conditions"] as Record<string, unknown>);
}

describe("(2) 継承の名前の走りのモデルは gpt-unknown と同じ単価で走る（Issue #836）", () => {
  const cases = [
    { pipeline: "v1" as const, calls: (): readonly RecordedCall[] => recordedRunFromPlan() },
    {
      pipeline: "v1.2" as const,
      calls: (): readonly RecordedCall[] => [...v12Head(), structured(v11aJudgments())],
    },
  ];

  it.each(cases)("(2) $pipeline の Build だけ：終了コードと費用の欄がモデル名の欄を除いて同じ", async (entry) => {
    const inherited = await runBuildOnly({
      dir: `${directory}/own-inherited-${entry.pipeline}`,
      pipeline: entry.pipeline,
      model: "constructor",
      calls: entry.calls(),
    });
    const unknown = await runBuildOnly({
      dir: `${directory}/own-unknown-${entry.pipeline}`,
      pipeline: entry.pipeline,
      model: "gpt-unknown",
      calls: entry.calls(),
    });
    expect(inherited.code).toBe(EXIT_OK);
    expect(unknown.code).toBe(EXIT_OK);
    expect(inherited.code).toBe(unknown.code);
    // 費用の欄（と走りの記録の条件）はモデル名の欄を除いて同じ
    expect(withoutModel(inherited.summary)).toEqual(withoutModel(unknown.summary));
    expect(inherited.summary["provider_cost_usd"]).toBe(unknown.summary["provider_cost_usd"]);
    expect(inherited.summary["budget_remaining_usd"]).toBe(unknown.summary["budget_remaining_usd"]);
    expect(inherited.summary["budget_reserved_usd"]).toBe(unknown.summary["budget_reserved_usd"]);
    expect(conditionsOf(inherited.record)).toEqual(conditionsOf(unknown.record));
    // 表に無い名前は既定の単価で数える（luna と同じ額。terra ではない）
    const n = entry.calls().length;
    expect(n).toBeGreaterThan(0);
    expect(Number(inherited.summary["provider_cost_usd"])).toBeCloseTo(
      n * costOfUsageUsd(RECORDED_USAGE, DEFAULT_RATES),
      12,
    );
    expect(Number(inherited.summary["provider_cost_usd"])).not.toBeCloseTo(
      n * costOfUsageUsd(RECORDED_USAGE, TERRA_RATES),
      12,
    );
  });
});

describe("(3) --stage-model を付けた走りは継承の名前を断る（Issue #836）", () => {
  const cases = [
    { name: "段のモデル", argv: ["--model", LUNA, "--stage-model", "test-spec=constructor"] },
    { name: "段のモデル（__proto__）", argv: ["--model", LUNA, "--stage-model", "test-spec=__proto__"] },
    { name: "走りのモデル", argv: ["--model", "constructor", "--stage-model", `test-spec=${TERRA}`] },
    { name: "走りのモデル（toString）", argv: ["--model", "toString", "--stage-model", `test-spec=${TERRA}`] },
  ];

  it.each(cases)("(3) $name → stage-model:model・exit 2・API 0 回", async (example) => {
    const makeClient = vi.fn();
    const writeFile = vi.fn(async () => {});
    const makeDirectory = vi.fn(async () => {});
    const lines: string[] = [];
    const code = await runCli({
      argv: ["--", "request.txt", "--out", "out", "--pipeline", "v1.2", "--plan-file", "plan.json", ...example.argv],
      env: { [API_KEY_ENV]: "sk-FAKE" },
      readFile: async () => "request",
      writeFile,
      makeDirectory,
      loadDocuments: async () => [],
      makeClient,
      log: (line) => lines.push(line),
      logError: () => {},
    });
    expect(code).toBe(EXIT_USAGE);
    expect(makeClient).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(lines[0]).toContain("stage-model:model");
    expect(lines).toContain(STAGE_MODEL_USAGE);
  });
});
