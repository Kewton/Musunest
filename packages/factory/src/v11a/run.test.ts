// v1.1α の走らせる部分（v11a/run.ts）の試験（07-architecture-v1.1a.md §1〜§1.4・D15・D16。Issue #510）。
//
// 偽物の LLM（記録した応答）・偽物の判定・固定の時計で ①〜⑦ 相当を流す。外部の API は呼ばない。題材は
// v1.1α の共通の題材（`__tests__/fixtures.ts`。担当者と項目の抽象的な題材）から、書けない要件 R5 を除いたもの。
// パターンは P 番号でなく題材の要件 ID（R1〜R4）で書く。受入の題材の言葉は使わない。
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { sha256Hex } from "@musunest/spec-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DECLARATION_FILE,
  DESIGN_FILE,
  DIAGNOSTICS_REJECTED_NAME_TABLE_FILE,
  DIAGNOSTICS_REJECTED_TEST_SPEC_FILE,
  MAPPINGS_FILE,
  TEST_SUITE_FILE,
  TESTS_FILE,
  VERIFICATION_FILE,
  type AssembledBundle,
} from "../bundle.js";
import type { Judge, JudgeAnswer } from "../judge.js";
import { createFakeJudge } from "../judge-fake.js";
import type { RecordedCall } from "../llm-fake.js";
import type { LlmStructuredRequest, LlmToolRequest } from "../llm.js";
import { requirementsFromPlan, type RequirementList, type TestSuite } from "../pipeline.js";
import * as bindModule from "../stages/bind.js";
import * as correspondenceStage from "../stages/correspondence.js";
import { createRecordingClient, expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import * as repairStage from "../stages/repair.js";
import * as runTestsStage from "../stages/run-tests.js";
import * as staticCheckStage from "../stages/static-check.js";
import * as triageStage from "../stages/unwritable-triage.js";
import { makeRunInput, structured } from "../__tests__/run.js";
import {
  DEFAULT_VALUE_REQUIREMENT_TEXT,
  ENUM_MEMBERSHIP_REQUEST_DIFF,
  ENUM_MEMBERSHIP_REQUIREMENT_TEXT,
  FIXTURE_DOCUMENTS,
  FIXTURE_YAML,
  draftOf,
  fixtureList,
  fixtureTable,
  jsonDiffPaths,
  requestDiffsOf,
  withAggregateResponses,
  withAggregates,
  withoutEnumMembership,
  withoutLedgerAdditions,
  LEDGER_REQUEST_DIFF,
  EMPTY_AGGREGATE_REQUEST_DIFF,
  LEDGER_VIEW_2B,
  withoutEmptyAggregate,
} from "./__tests__/fixtures.js";
import { V11A_ARTIFACT_NAMES } from "./bundle-v11a.js";
import * as evaluateModule from "./evaluate.js";
import { DEFAULT_VALUE_DETAILS, UNMAPPED_OBSERVES_DETAIL, type V11aEvaluatorInput } from "./evaluate.js";
import { nameTableSha256, type NameTable } from "./names.js";
import {
  ALL_CARRIED_PROBLEM,
  runGenerationV11a,
  runStageRangeV11a,
  v11aFailureSignature,
  type GenerationInputV11a,
} from "./run.js";
import * as declCheckStage from "./stages/decl-check.js";
import { DECL_CHECK_SCHEMA_NAME } from "./stages/decl-check.js";
import { NAME_TABLE_PREVIOUS_DATA_NAMES, NAME_TABLE_SCHEMA_NAME } from "./stages/name-table.js";
import * as semanticCheckStage from "./stages/semantic-check.js";
import { SEMANTIC_CHECK_SCHEMA_NAME } from "./stages/semantic-check.js";
import { TEST_SPEC_SCHEMA_NAME, testSuiteSha256, type TestObserves } from "./stages/test-spec.js";
import { WRITE_V11A_DATA_NAMES, WRITE_V11A_SCHEMA_NAME } from "./stages/write.js";
import { natureQuestionName } from "../stages/test-suite.js";
import { captureBaselineV11a, type BaselineV11aCapture, type BaselineV11aScenarios } from "../__tests__/baseline-capture.js";
import * as factoryModule from "../index.js";
import { createFakeLlmClient } from "../llm-fake.js";
import { PROPERTY_LEDGER, V12_PIPELINE_FLAGS, V12_FLAG_NAMES, resolveV12Flags } from "../v12/ledger.js";
import * as ledgerModule from "../v12/ledger.js";
import { buildSized, MAX_SIZE, MEDIAN_SIZE, type SizedMaterials } from "./__tests__/sizes.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 題材 ──────────────────────────────────────────────────────────

const without5 = <T extends { readonly requirementId: string }>(entries: readonly T[]): readonly T[] =>
  entries.filter((entry) => entry.requirementId !== "R5");

const BASE_LIST: RequirementList = {
  ...fixtureList(),
  requirements: fixtureList().requirements.filter((requirement) => requirement.id !== "R5"),
};

function planOf(list: RequirementList): ConfirmedPlan {
  return {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-v11a-run",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: list.requirements.map((requirement) => requirement.text).join("") }],
    requirements: list.requirements.map((requirement) => ({
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

const PLAN = planOf(BASE_LIST);
const LIST = requirementsFromPlan(PLAN);
const SOURCE = BASE_LIST.requirements.map((requirement) => requirement.text).join("");
const IDS = ["R1", "R2", "R3", "R4"] as const;

/** 名前の表（題材の表から R5 を除いたもの。R5 だけが所属させる行は無い） */
const TABLE: NameTable = (() => {
  const table = fixtureTable();
  return {
    rows: table.rows,
    ownership: without5(table.ownership),
    verification: without5(table.verification),
    classification: without5(table.classification),
  };
})();

/**
 * 旗 on の走りの名前の表（題材の表の計算の行に、集計の種類と集計元を足したもの。strict の schema で必須。Issue #549）。
 * off の走りには渡さない（未登録で落ちる）
 */
const TABLE_ON: NameTable = withAggregates(TABLE);

/**
 * R1 も担当者の entity（e.member）を所属させる表。R2 を持ち越しても e.member は共有の行として残るので、R1 の
 * 参照の項目（f.item.owner）の参照先が除いた行を指さない（R2 の網羅を失う例に使う）
 */
const TABLE_SHARED_MEMBER: NameTable = {
  ...TABLE,
  ownership: TABLE.ownership.map((entry) =>
    entry.requirementId === "R1"
      ? { ...entry, roles: [...entry.roles, { id: "e.member", basis: "stated" as const, reason: null }] }
      : entry,
  ),
};

/** 宣言（表の全要素。項目の一覧に R1 の所属の項目を全部出す） */
const RUN_YAML = FIXTURE_YAML.replace("show: [title, amount, kind]", "show: [title, owner, amount, day, kind]");

/** 置き換えが 1 か所に効いたことを確かめて置き換える */
function replaced(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) throw new Error(`前提が壊れた：置き換えの元が 1 か所でない（${from}）`);
  return source.replace(from, to);
}

/** 表に無い要素 `realRate`（本当の率の計算）を足した宣言 */
const withRealRate = (source: string): string =>
  replaced(source, "  - name: byKind\n", "  - name: realRate\n    scope: app\n    expression: base * 2\n    type: number\n  - name: byKind\n");

const KINDS = ["normal", "abnormal", "boundary"] as const;
type Kind = (typeof KINDS)[number];

interface RawTestOptions {
  readonly id: string;
  readonly requirementId: string;
  readonly targetKind: string;
  readonly roleId: string;
  readonly kind?: Kind;
  readonly operation: string;
  readonly observes: string;
  readonly input?: unknown;
  readonly expected: { readonly kind: "ok" | "error"; readonly value: string | null; readonly code: string | null };
  readonly assertion?: Record<string, unknown> | null;
  readonly referenceData?: readonly Record<string, unknown>[];
}

/** strict の schema の形の試験 1 件（入力・期待の値は JSON の文字列） */
function rawTest(options: RawTestOptions): Record<string, unknown> {
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

const ok = (value: string) => ({ kind: "ok" as const, value, code: null });

/** 項目の行 3 つ（金額 1 ずつ。合計 3・件数 3） */
const ITEM_ROWS = [1, 2, 3].map((index) => ({
  target: { requirementId: "R4", kind: "entity", roleId: "e.item" },
  rowId: `item-${index}`,
  values: JSON.stringify({ "f.item.amount": 1 }),
}));

const r1Tests = () =>
  KINDS.map((kind) =>
    rawTest({
      id: `r1-${kind}`,
      requirementId: "R1",
      targetKind: "field",
      roleId: "f.item.amount",
      kind,
      operation: "validate",
      observes: "validation",
      input: { "f.item.amount": kind === "abnormal" ? -1 : kind === "boundary" ? 1 : 5 },
      expected: kind === "abnormal" ? { kind: "error", value: null, code: "E_INVALID" } : ok("true"),
    }),
  );

const viewShows = (id: string, screen: string, role: string) =>
  rawTest({
    id,
    requirementId: "R2",
    targetKind: "screen",
    roleId: screen,
    operation: "structure",
    observes: "view-structure",
    expected: ok("true"),
    assertion: { check: "view-shows", expected: null, refEntity: null, role },
  });

const r2Tests = () => [viewShows("r2-shows", "s.members", "f.member.title")];

const r3Tests = () =>
  KINDS.map((kind) =>
    rawTest({
      id: `r3-${kind}`,
      requirementId: "R3",
      targetKind: "operation",
      roleId: "o.closeItem",
      kind,
      operation: "action",
      observes: "when",
      input: { "f.item.amount": kind === "abnormal" ? -1 : kind === "boundary" ? 1 : 3 },
      expected: ok(kind === "abnormal" ? "false" : "true"),
    }),
  );

const r4Test = (kind: Kind, id = `r4-${kind}`, expected = "6") =>
  rawTest({
    id,
    requirementId: "R4",
    targetKind: "computation",
    roleId: "c.rate",
    kind,
    operation: "compute",
    observes: "value",
    referenceData: ITEM_ROWS,
    expected: ok(expected),
  });
const r4Tests = () => KINDS.map((kind) => r4Test(kind));

type NatureRow = { readonly requirementId: string; readonly nature: "ruled" | "existence-only" };
const NATURES: readonly NatureRow[] = [
  { requirementId: "R1", nature: "ruled" },
  { requirementId: "R2", nature: "existence-only" },
  { requirementId: "R3", nature: "ruled" },
  { requirementId: "R4", nature: "ruled" },
];

/** T2 の応答（`only` の要件の分類と試験だけ） */
function t2Response(
  tests: readonly Record<string, unknown>[] = [...r1Tests(), ...r2Tests(), ...r3Tests(), ...r4Tests()],
  only: readonly string[] = IDS,
) {
  return { classifications: NATURES.filter((entry) => only.includes(entry.requirementId)), tests };
}

const accept = (requirementId: string) => ({ requirementId, verdict: "accept", kind: null, quote: null });
const reject = (requirementId: string, kind: string, quote: string) => ({ requirementId, verdict: "reject", kind, quote });
const judgments = (ids: readonly string[], rejects: Readonly<Record<string, readonly [string, string]>> = {}) => ({
  judgments: ids.map((id) => {
    const found = rejects[id];
    return found === undefined ? accept(id) : reject(id, found[0], found[1]);
  }),
});
const acceptAll = (ids: readonly string[] = IDS) => judgments(ids);

/**
 * B3' の拒否。最後まで残って持ち越しになる拒否には R3・R4 を使う——R1・R2 を持ち越すと、その要件だけが所属させる
 * 行（R1 の区分・日付の項目、R2 の担当者の entity）を残る行（見出しの元・参照先）が指し、持ち越しの関数が断る
 * （段 carry-over で止まる。末尾の試験）。R1・R2 の拒否は、直した版で受理される道にだけ使う。
 */
const REJECT_R1 = { R1: ["mismatch", "金額"] as const };
const REJECT_R2 = { R2: ["mismatch", "担当者の名前"] as const };
const REJECT_R3 = { R3: ["mismatch", "金額が 0 より大きい項目だけ"] as const };
const REJECT_R4 = { R4: ["mismatch", "全体の率"] as const };

/** T1・T1''・T2・B1 の記録（既定は完走の道） */
const head = (
  options: { readonly t2?: unknown; readonly yaml?: string; readonly table?: NameTable } = {},
): RecordedCall[] => [
  structured(draftOf(LIST, options.table ?? TABLE)),
  structured(acceptAll()),
  structured(options.t2 ?? t2Response()),
  structured({ declaration: options.yaml ?? RUN_YAML }),
];

/** ⑥ の最後の答え（直した宣言と主張） */
const repairDone = (declaration: string, disputes: readonly { testId: string; quote: string }[] = []): RecordedCall => ({
  kind: "tools",
  response: { kind: "done", declaration: { declaration, disputes }, usage: undefined },
});

/** ⑥ の道具の呼び出し（1 つ） */
const repairToolCall = (id: string, name: string, declaration: string): RecordedCall => ({
  kind: "tools",
  response: { kind: "toolCalls", toolCalls: [{ id, name, arguments: { declaration } }], usage: undefined },
});

/** 主張の引用（原文に実在する） */
const QUOTE = "全体の率";
const dispute = (testId: string) => ({ testId, quote: QUOTE });
const arbitration = (decisions: readonly { testId: string; verdict: string }[]) =>
  structured({
    decisions: decisions.map((decision) => ({
      testId: decision.testId,
      verdict: decision.verdict,
      reason: decision.verdict === "overturn" ? "期待が誤り" : "",
      quote: decision.verdict === "overturn" ? QUOTE : "",
    })),
  });

function inputOf(client: GenerationInputV11a["client"], overrides: Partial<GenerationInputV11a> = {}): GenerationInputV11a {
  return { ...makeRunInput(client), source: SOURCE, documents: FIXTURE_DOCUMENTS, plan: PLAN, ...overrides };
}

async function runScenario(calls: readonly RecordedCall[], overrides: Partial<GenerationInputV11a> = {}) {
  const recording = createRecordingClient(calls);
  const result = await runGenerationV11a(inputOf(recording.client, overrides));
  return { result, recording };
}

function artifactOf(bundle: AssembledBundle | null, path: string): Record<string, unknown> {
  const found = bundle?.artifacts.find((artifact) => artifact.path === path);
  if (found === undefined) throw new Error(`納品物に無い: ${path}`);
  return JSON.parse(found.text) as Record<string, unknown>;
}

function diagnosticOf(diagnostics: readonly { path: string; text: string }[], path: string): Record<string, unknown> {
  const found = diagnostics.find((artifact) => artifact.path === path);
  if (found === undefined) throw new Error(`診断に無い: ${path}`);
  return JSON.parse(found.text) as Record<string, unknown>;
}

const stageIds = (result: { record: { stages: readonly { stage: string }[] } }): readonly string[] =>
  result.record.stages.map((record) => record.stage);
const countStage = (result: { record: { stages: readonly { stage: string }[] } }, stage: string): number =>
  stageIds(result).filter((id) => id === stage).length;
const schemaNames = (requests: readonly LlmStructuredRequest[]): readonly string[] =>
  requests.map((request) => request.schemaName);

/** データの塊の中身（JSON）を読む */
function dataBlockOf(input: string, name: string): unknown {
  const match = new RegExp(`<data name="${name}">\\n([\\s\\S]*?)\\n</data>`).exec(input);
  if (match === null) throw new Error(`データの塊が無い: ${name}`);
  return JSON.parse(match[1] ?? "null");
}

/** 並びの中に、`expected` が順に（間をあけてよい）現れるか */
function containsInOrder(actual: readonly string[], expected: readonly string[]): boolean {
  let at = 0;
  for (const item of actual) if (item === expected[at]) at += 1;
  return at === expected.length;
}

const carryEntriesOf = (bundle: AssembledBundle | null) =>
  artifactOf(bundle, V11A_ARTIFACT_NAMES.carryOver)["entries"] as readonly {
    requirementId: string;
    reasons: readonly { origin: string; reason: string }[];
  }[];

/** J4 の偽物の判定（所属の組ごとの値。R3 の操作だけ値 0.1 ＝不要の疑い） */
function adviceJudge(): Judge {
  const answers: Record<string, JudgeAnswer> = {};
  for (const entry of TABLE.ownership) {
    for (const role of entry.roles) {
      const value = entry.requirementId === "R3" && role.id === "o.closeItem" ? 0.1 : 0.9;
      answers[`need:${entry.requirementId}:${role.id}`] = { kind: "noul", noul: value };
    }
  }
  return createFakeJudge(answers);
}

// ── (a) 完走 ────────────────────────────────────────────────────────

describe("(a) 完走：v1 と同じ門で full。v1 の成果物と 7 つの記録", () => {
  it("verdict full・prompt_version は入力のまま・段の順・呼ばない段・schema 名", async () => {
    const correspondenceSpy = vi.spyOn(correspondenceStage, "runCorrespondence");
    const redoSpy = vi.spyOn(repairStage, "runCorrespondenceRedo");
    const triageSpy = vi.spyOn(triageStage, "runUnwritableTriage");
    const bindSpy = vi.spyOn(bindModule, "bindTests");
    const { result, recording } = await runScenario([...head(), structured(acceptAll())], {
      promptVersion: "v1.1a-test",
    });

    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.summary.verdict).toBe("full");
    expect(result.summary.exit_code).toBe(0);
    expect(result.summary.prompt_version).toBe("v1.1a-test");
    expect(result.record.prompt_version).toBe("v1.1a-test");

    const stages = stageIds(result);
    expect(
      containsInOrder(stages, [
        "name-table",
        "semantic-check",
        "test-spec",
        "write",
        "static-check",
        "name-check",
        "decl-check",
        "run-tests",
        "judge",
        "bundle",
      ]),
    ).toBe(true);
    for (const v1Only of ["correspondence", "design", "test-suite", "requirements", "reverse-check"]) {
      expect(stages).not.toContain(v1Only);
    }
    expect(correspondenceSpy).not.toHaveBeenCalled();
    expect(redoSpy).not.toHaveBeenCalled();
    expect(triageSpy).not.toHaveBeenCalled();
    expect(bindSpy).not.toHaveBeenCalled();

    const names = schemaNames(recording.structured);
    expect(names).toEqual([
      NAME_TABLE_SCHEMA_NAME,
      SEMANTIC_CHECK_SCHEMA_NAME,
      TEST_SPEC_SCHEMA_NAME,
      "declaration-v11a",
      DECL_CHECK_SCHEMA_NAME,
    ]);
    expect(names).not.toContain("requirement-correspondence");
    expect(names).not.toContain("role-name-mappings");
    expect(recording.tools).toHaveLength(0);
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
  });

  it("納品物に v1 の成果物と 7 つの記録があり、verification の記録の SHA が表・組・宣言から計算し直した値と一致", async () => {
    const { result } = await runScenario([...head(), structured(acceptAll())]);
    const bundle = result.bundle;
    if (bundle === null) throw new Error("納品物が無い");
    const paths = bundle.artifacts.map((artifact) => artifact.path);
    for (const v1Path of [DECLARATION_FILE, DESIGN_FILE, TEST_SUITE_FILE, MAPPINGS_FILE, TESTS_FILE, VERIFICATION_FILE]) {
      expect(paths).toContain(v1Path);
    }
    for (const path of Object.values(V11A_ARTIFACT_NAMES)) expect(paths).toContain(path);
    // manifest の files に 7 つの記録が載る
    const files = (bundle.manifest as unknown as { files: readonly { path: string }[] }).files.map((file) => file.path);
    for (const path of Object.values(V11A_ARTIFACT_NAMES)) expect(files).toContain(path);

    const nameTable = artifactOf(bundle, V11A_ARTIFACT_NAMES.nameTable);
    const table: NameTable = {
      rows: nameTable["rows"] as NameTable["rows"],
      ownership: nameTable["ownership"] as NameTable["ownership"],
      verification: nameTable["verification"] as NameTable["verification"],
      classification: nameTable["classification"] as NameTable["classification"],
    };
    const testSpec = artifactOf(bundle, V11A_ARTIFACT_NAMES.testSpec);
    const observes = new Map(Object.entries(testSpec["observes"] as Record<string, TestObserves>));
    const declaration = bundle.artifacts.find((artifact) => artifact.path === DECLARATION_FILE)?.text ?? "";
    const verification = artifactOf(bundle, V11A_ARTIFACT_NAMES.verification);
    expect(verification["table_sha256"]).toBe(await nameTableSha256(table));
    expect(verification["table_sha256"]).toBe(nameTable["table_sha256"]);
    expect(verification["test_suite_sha256"]).toBe(await testSuiteSha256(testSpec["suite"] as TestSuite, observes));
    expect(verification["declaration_sha256"]).toBe(await sha256Hex(declaration));
    expect(declaration).toBe(RUN_YAML);
    // v1 の成果物（設計・対応）は A1 の写し。持ち越しは無い
    expect(carryEntriesOf(bundle)).toEqual([]);
  });
});

// ── (b)〜(e) T1・T1''・持ち越しの止まり方 ───────────────────────────────

/** T1' に落ちる下書き（要件の写しを入れ替える） */
function badDraft(marker = "目印の値の写し") {
  const draft = draftOf(LIST, TABLE);
  return {
    ...draft,
    requirements: draft.requirements.map((entry, index) => (index === 0 ? { ...entry, copy: marker } : entry)),
  };
}

describe("(b) T1' に 2 回落ちる", () => {
  it("段 name-table・unmet で止まり、断った候補の通し番号が 1・2", async () => {
    const { result, recording } = await runScenario([structured(badDraft()), structured(badDraft())]);
    expect(result.stopped?.stage).toBe("name-table");
    expect(result.stopped?.kind).toBe("unmet");
    expect(result.outcome.verdict).toBe("none");
    expect(result.summary.exit_code).toBe(1);
    expect(result.bundle).toBeNull();
    const records = result.record.stages.filter((record) => record.stage === "name-table");
    expect(records.map((record) => [record.status, record.failure_kind])).toEqual([
      ["failed", "unmet"],
      ["failed", "unmet"],
    ]);
    // 2 回目は中身のやり直しとして共通の口へ告げた（その段の記録に数える）
    expect(records[1]?.retries.content).toBe(1);
    // 2 回目の要求に前回の候補と作り直しの指示がある
    const second = recording.structured[1]!;
    expect(dataBlockOf(second.input, NAME_TABLE_PREVIOUS_DATA_NAMES.response)).toEqual(badDraft());
    expect((dataBlockOf(second.input, NAME_TABLE_PREVIOUS_DATA_NAMES.problems) as unknown[]).length).toBeGreaterThan(0);
    const rejected = diagnosticOf(result.diagnostics, DIAGNOSTICS_REJECTED_NAME_TABLE_FILE)["candidates"] as readonly {
      stage: string;
      call: number;
      round: number;
    }[];
    expect(rejected.map((candidate) => [candidate.stage, candidate.call, candidate.round])).toEqual([
      ["name-table", 1, 1],
      ["name-table", 2, 2],
    ]);
  });
});

describe("(c) T1'' の拒否 → T1 の 2 回目 → 残った拒否は持ち越し", () => {
  it("2 回目のデータに拒否と J4 の印があり、残った拒否は持ち越されて partial（B5 の要求は無い）", async () => {
    const rejectR3 = judgments(IDS, { R3: ["unnecessary-ownership", "締められる"] });
    const { result, recording } = await runScenario(
      [
        structured(draftOf(LIST, TABLE)),
        structured(rejectR3),
        structured(draftOf(LIST, TABLE)),
        structured(rejectR3),
        structured(t2Response([...r1Tests(), ...r2Tests(), ...r4Tests()], ["R1", "R2", "R4"])),
        structured({ declaration: RUN_YAML }),
        structured(acceptAll(["R1", "R2", "R4"])),
      ],
      { judge: adviceJudge() },
    );
    const second = recording.structured[2]!;
    expect(second.schemaName).toBe(NAME_TABLE_SCHEMA_NAME);
    const copy = (dataBlockOf(second.input, NAME_TABLE_PREVIOUS_DATA_NAMES.rejections) as { copy: string; kind: string }[])[0];
    expect(copy?.kind).toBe("unnecessary-ownership");
    expect(LIST.requirements[2]?.text.startsWith(copy?.copy ?? "#")).toBe(true);
    const advice = dataBlockOf(second.input, NAME_TABLE_PREVIOUS_DATA_NAMES.advice) as { id: string; mark: string }[];
    expect(advice).toContainEqual(expect.objectContaining({ id: "o.closeItem", mark: "suspect-unnecessary" }));

    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).toBe("partial");
    expect(recording.tools).toHaveLength(0);
    expect(carryEntriesOf(result.bundle)).toEqual([
      { requirementId: "R3", reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] },
    ]);
    const carry = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.carryOver);
    expect(carry["excluded_row_ids"]).toEqual(["o.closeItem"]);
    // T2 に見せた一覧から持ち越しの要件を除く
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    const t2List = dataBlockOf(t2.input, "要件の一覧") as RequirementList;
    expect(t2List.requirements.map((requirement) => requirement.id)).toEqual(["R1", "R2", "R4"]);
  });
});

describe("(d) T1'' の不完全な結果が 2 回", () => {
  it("段 semantic-check・malformed・exit_code 1", async () => {
    const incomplete = { judgments: ["R1", "R2", "R3"].map(accept) };
    const { result } = await runScenario([structured(draftOf(LIST, TABLE)), structured(incomplete), structured(incomplete)]);
    expect(result.stopped?.stage).toBe("semantic-check");
    expect(result.stopped?.kind).toBe("malformed");
    expect(result.summary.exit_code).toBe(1);
    expect(result.outcome.verdict).toBe("none");
  });
});

describe("(e) 全件持ち越し（D15）", () => {
  it("T1'' の拒否で全件 → 段 carry-over・verdict none・T2 の要求無し", async () => {
    const rejectAll = judgments(IDS, {
      R1: ["weak-verification", "登録できる"],
      R2: ["weak-verification", "一覧で見られる"],
      R3: ["weak-verification", "締められる"],
      R4: ["weak-verification", "まとめの画面"],
    });
    const { result, recording } = await runScenario([
      structured(draftOf(LIST, TABLE)),
      structured(rejectAll),
      structured(draftOf(LIST, TABLE)),
      structured(rejectAll),
    ]);
    expect(result.stopped).toEqual({ stage: "carry-over", kind: "unmet", problems: [ALL_CARRIED_PROBLEM] });
    expect(result.outcome.verdict).toBe("none");
    expect(schemaNames(recording.structured)).not.toContain(TEST_SPEC_SCHEMA_NAME);
  });

  it("B3' の文脈なしで全件 → verdict none", async () => {
    const sha = await sha256Hex(RUN_YAML);
    vi.spyOn(declCheckStage, "runDeclCheck").mockResolvedValue({
      ok: true,
      value: {
        declarationSha256: sha,
        judgments: IDS.map((requirementId) => ({ requirementId, verdict: "unmarked" as const })),
        targets: [],
        unmarked: [...IDS],
      },
    });
    const { result } = await runScenario(head());
    expect(result.stopped?.stage).toBe("carry-over");
    expect(result.outcome.verdict).toBe("none");
  });

  it("B6 で全件 → verdict none", async () => {
    const { result } = await runScenario([
      ...head(),
      structured(judgments(IDS, REJECT_R1)),
      repairDone(RUN_YAML, ["r1-normal", "r2-shows", "r3-normal", "r4-normal"].map(dispute)),
      arbitration(["r1-normal", "r2-shows", "r3-normal", "r4-normal"].map((testId) => ({ testId, verdict: "overturn" }))),
    ]);
    expect(result.stopped).toEqual({ stage: "carry-over", kind: "unmet", problems: [ALL_CARRIED_PROBLEM] });
    expect(result.outcome.verdict).toBe("none");
    expect(stageIds(result)).toContain("coverage");
  });
});

// ── (f) 宣言の意味の点検が効いていること ────────────────────────────────

interface Counterexample {
  readonly label: string;
  readonly requirementId: string;
  readonly kind: string;
  readonly quote: string;
  readonly bad: string;
  readonly control: string;
}

const COUNTEREXAMPLES: readonly Counterexample[] = [
  {
    label: "宣言だけを変える（操作の when が要件より緩い）",
    requirementId: "R3",
    kind: "mismatch",
    quote: "金額が 0 より大きい項目だけ",
    bad: replaced(RUN_YAML, "when: amount > 0", "when: amount >= 0"),
    control: RUN_YAML,
  },
  {
    label: "振る舞いが追加の要素へ移る（所属の計算が定数で、本当の計算は表に無い要素にある）",
    requirementId: "R4",
    kind: "behavior-outside-ownership",
    quote: "全体の率",
    bad: withRealRate(replaced(RUN_YAML, "expression: base * 2", "expression: 2 * 3")),
    control: withRealRate(RUN_YAML),
  },
  {
    label: "補助の定義だけを変える（参照する補助の計算の式だけが誤り）",
    requirementId: "R4",
    kind: "auxiliary-mismatch",
    quote: "全体の率",
    bad: replaced(
      RUN_YAML,
      "  - name: base\n    scope: app\n    aggregate:\n      sum: item.amount\n",
      "  - name: base\n    scope: app\n    aggregate:\n      count: item\n",
    ),
    control: RUN_YAML,
  },
];

describe("(f) A2 の 3 つの反例：B3' の拒否が残れば full にならず、宣言だけを対照に替えれば full", () => {
  it.each(COUNTEREXAMPLES)("$label", async (example) => {
    const rejection = judgments(IDS, { [example.requirementId]: [example.kind, example.quote] });
    const bad = await runScenario([
      ...head({ yaml: example.bad }),
      structured(rejection),
      repairDone(example.bad),
      structured(rejection),
    ]);
    // 静的チェック・B3・B4 は通っている
    const verification = artifactOf(bad.result.bundle, VERIFICATION_FILE);
    expect(verification["correspondence_misses"]).toBe(0);
    expect(verification["test_mismatches"]).toBe(0);
    expect(verification["test_unresolved"]).toBe(0);
    expect((verification["unexecuted_inspections"] as unknown[]).length).toBe(0);
    expect(bad.result.outcome.verdict).not.toBe("full");
    expect(bad.result.outcome.verdict).toBe("partial");
    expect(bad.result.summary.stop_reason).toBe("stagnation");
    expect(carryEntriesOf(bad.result.bundle)).toEqual([
      { requirementId: example.requirementId, reasons: [{ origin: "decl-check", reason: example.kind }] },
    ]);

    const control = await runScenario([...head({ yaml: example.control }), structured(acceptAll())]);
    expect(control.result.outcome.verdict).toBe("full");
  });

  it("B3' の拒否 → B5 のデータに拒否 → 直した版に B3' が掛かり宣言の SHA が変わる", async () => {
    const [example] = COUNTEREXAMPLES;
    if (example === undefined) throw new Error("前提が壊れた");
    const { result, recording } = await runScenario([
      ...head({ yaml: example.bad }),
      structured(judgments(IDS, { R3: [example.kind, example.quote] })),
      repairDone(example.control),
      structured(acceptAll()),
    ]);
    expect(result.outcome.verdict).toBe("full");
    const repair = recording.tools[0]!;
    expect(dataBlockOf(repair.input, repairStage.DECLARATION_REJECTIONS_DATA_NAME)).toEqual([
      { requirementId: "R3", kind: example.kind, quote: example.quote },
    ]);
    const versions = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.declCheck)["versions"] as readonly {
      declaration_sha256: string;
    }[];
    expect(versions.map((version) => version.declaration_sha256)).toEqual([
      await sha256Hex(example.bad),
      await sha256Hex(example.control),
    ]);
  });

  it("表の SHA の合わない T1'' の結果では先へ進まない（semantic-check・malformed）", async () => {
    const original = semanticCheckStage.runSemanticCheck;
    vi.spyOn(semanticCheckStage, "runSemanticCheck").mockImplementation(async (input) => {
      const outcome = await original(input);
      return outcome.ok ? { ok: true, value: { ...outcome.value, tableSha256: "0".repeat(64) } } : outcome;
    });
    const { result, recording } = await runScenario(head());
    expect(result.stopped?.stage).toBe("semantic-check");
    expect(result.stopped?.kind).toBe("malformed");
    expect(result.outcome.verdict).toBe("none");
    expect(schemaNames(recording.structured)).not.toContain(TEST_SPEC_SCHEMA_NAME);
  });

  it("宣言の SHA の合わない B3' の結果では先へ進まない（decl-check・malformed）", async () => {
    const original = declCheckStage.runDeclCheck;
    vi.spyOn(declCheckStage, "runDeclCheck").mockImplementation(async (input) => {
      const outcome = await original(input);
      return outcome.ok ? { ok: true, value: { ...outcome.value, declarationSha256: "0".repeat(64) } } : outcome;
    });
    const { result } = await runScenario([...head(), structured(acceptAll())]);
    expect(result.stopped?.stage).toBe("decl-check");
    expect(result.stopped?.kind).toBe("malformed");
    expect(result.outcome.verdict).toBe("none");
  });

  it("判定が 1 件欠けた B3' の結果では先へ進まない（形の落ち 2 回で decl-check・malformed）", async () => {
    const missing = acceptAll(["R1", "R2", "R3"]);
    const { result } = await runScenario([...head(), structured(missing), structured(missing)]);
    expect(result.stopped?.stage).toBe("decl-check");
    expect(result.stopped?.kind).toBe("malformed");
    expect(result.outcome.verdict).toBe("none");
  });

  it("判定が 1 件欠けた B3' の結果を段が返しても受けない（decl-check・malformed）", async () => {
    const original = declCheckStage.runDeclCheck;
    vi.spyOn(declCheckStage, "runDeclCheck").mockImplementation(async (input) => {
      const outcome = await original(input);
      return outcome.ok ? { ok: true, value: { ...outcome.value, judgments: outcome.value.judgments.slice(1) } } : outcome;
    });
    const { result } = await runScenario([...head(), structured(acceptAll())]);
    expect(result.stopped?.stage).toBe("decl-check");
    expect(result.stopped?.kind).toBe("malformed");
  });
});

// ── (g) 点検が尽きる（D16）──────────────────────────────────────────────

describe("(g) 点検 6 回を使い切る", () => {
  it("7 回目の B3' も次の B5 も無く、stop_reason limit・partial・残りの点検 0", async () => {
    const calls: RecordedCall[] = [...head(), structured(judgments(IDS, REJECT_R3))];
    for (let index = 1; index < 6; index += 1) {
      calls.push(repairDone(RUN_YAML), structured(judgments(IDS, index % 2 === 1 ? REJECT_R4 : REJECT_R3)));
    }
    const { result, recording } = await runScenario(calls);
    expect(countStage(result, "decl-check")).toBe(6);
    expect(countStage(result, "repair")).toBe(5);
    expect(recording.tools).toHaveLength(5);
    expect(result.summary.stop_reason).toBe("limit");
    expect(result.outcome.verdict).toBe("partial");
    const versions = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.declCheck)["versions"] as readonly {
      remaining_checks: number;
    }[];
    expect(versions.map((version) => version.remaining_checks)).toEqual([5, 4, 3, 2, 1, 0]);
    const counts = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.verification)["decl_check"];
    expect(counts).toEqual({ exhausted: 1, malformed: 0, rejected: 6 });
    // 最終版（6 回目）の拒否（R4）は持ち越し・未解決
    expect(carryEntriesOf(result.bundle)).toEqual([{ requirementId: "R4", reasons: [{ origin: "decl-check", reason: "mismatch" }] }]);
  });
});

// ── (h) B3 の落ちだけ ─────────────────────────────────────────────────

describe("(h) B3 の落ちだけがある版", () => {
  it("B5 へ行き、⑤a の要求が無い。直した版は B3・B3' を通って full", async () => {
    const correspondenceSpy = vi.spyOn(correspondenceStage, "runCorrespondence");
    const { result, recording } = await runScenario([
      ...head({ yaml: FIXTURE_YAML }),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ]);
    expect(correspondenceSpy).not.toHaveBeenCalled();
    expect(schemaNames(recording.structured)).not.toContain("requirement-correspondence");
    expect(recording.tools).toHaveLength(1);
    // 1 版目は B3 に落ちて B3' を掛けない（点検を消費しない）
    expect(countStage(result, "decl-check")).toBe(1);
    const misses = dataBlockOf(recording.tools[0]!.input, "対応表の落ち") as { requirementId: string; detail: string }[];
    expect(misses.length).toBeGreaterThan(0);
    expect(misses.every((miss) => miss.requirementId === "R1")).toBe(true);
    expect(result.outcome.verdict).toBe("full");
  });
});

// ── (i) 棄却のあとの網羅（B6）──────────────────────────────────────────

interface CoverageCase {
  readonly label: string;
  readonly tests: readonly Record<string, unknown>[];
  readonly disputes: readonly string[];
  readonly verdict: "overturn" | "undecidable" | "return-to-plan";
  /** 持ち越しになる要件（網羅の落ち） */
  readonly lost: readonly string[];
  readonly table?: NameTable;
}

const BASE_TESTS = () => [...r1Tests(), ...r2Tests(), ...r3Tests(), ...r4Tests()];

const COVERAGE_CASES: readonly CoverageCase[] = [
  { label: "全棄却", tests: BASE_TESTS(), disputes: ["r4-normal", "r4-abnormal", "r4-boundary"], verdict: "overturn", lost: ["R4"] },
  { label: "一部棄却（正常だけ残る）", tests: BASE_TESTS(), disputes: ["r4-abnormal", "r4-boundary"], verdict: "overturn", lost: ["R4"] },
  {
    label: "X だけ残る（Y の単位を全部失う）",
    tests: [
      ...BASE_TESTS(),
      rawTest({
        id: "r4-month",
        requirementId: "R4",
        targetKind: "computation",
        roleId: "c.byMonth",
        operation: "aggregate",
        observes: "value",
        expected: ok("[]"),
      }),
    ],
    disputes: ["r4-month"],
    verdict: "overturn",
    lost: ["R4"],
  },
  {
    label: "同じ画面の view-shows(X)・view-shows(Y) のうち Y だけを失う",
    tests: [...BASE_TESTS(), viewShows("r2-shows-count", "s.members", "c.itemCount")],
    disputes: ["r2-shows-count"],
    verdict: "overturn",
    lost: ["R2"],
    table: TABLE_SHARED_MEMBER,
  },
  {
    label: "同じ check を求める別の対象を失う",
    tests: [...BASE_TESTS(), viewShows("r2-shows-items", "s.items", "f.item.title")],
    disputes: ["r2-shows-items"],
    verdict: "overturn",
    lost: ["R2"],
    table: TABLE_SHARED_MEMBER,
  },
];

describe("(i) B4 の不一致・B3' の拒否 → B5 → B5' → B6", () => {
  it.each(COVERAGE_CASES)("$label：単位を失った要件が持ち越され full が出ない", async (example) => {
    const { result } = await runScenario([
      ...head({ t2: t2Response(example.tests), ...(example.table === undefined ? {} : { table: example.table }) }),
      structured(judgments(IDS, REJECT_R3)),
      repairDone(RUN_YAML, example.disputes.map(dispute)),
      arbitration(example.disputes.map((testId) => ({ testId, verdict: example.verdict }))),
      structured(acceptAll(IDS.filter((id) => !example.lost.includes(id)))),
    ]);
    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).toBe("partial");
    expect(carryEntriesOf(result.bundle)).toEqual(
      example.lost.map((requirementId) => ({
        requirementId,
        reasons: [{ origin: "coverage", reason: "lost-coverage-units" }],
      })),
    );
    const testSpec = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.testSpec);
    expect(testSpec["overturned_test_ids"]).toEqual(example.disputes);
    const checks = testSpec["coverage_checks"] as readonly { losses: readonly { requirementId: string }[] }[];
    expect(checks.at(-1)?.losses.map((loss) => loss.requirementId)).toEqual(example.lost);
  });

  it("裁定不能：未解決に数えて full が出ない（網羅の落ちは無い）", async () => {
    const { result } = await runScenario([
      ...head(),
      structured(judgments(IDS, REJECT_R1)),
      repairDone(RUN_YAML, [dispute("r4-normal")]),
      arbitration([{ testId: "r4-normal", verdict: "undecidable" }]),
      structured(acceptAll()),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ]);
    expect(result.outcome.verdict).toBe("partial");
    expect(result.record.arbitration.undecidable).toBe(1);
    expect(stageIds(result)).not.toContain("coverage");
    expect(carryEntriesOf(result.bundle)).toEqual([]);
  });

  it("Plan へ戻す：returnToPlan 真・stop_reason unresolved で別に数え、full が出ない", async () => {
    const { result } = await runScenario([
      ...head(),
      structured(judgments(IDS, REJECT_R3)),
      repairDone(RUN_YAML, [dispute("r4-normal")]),
      arbitration([{ testId: "r4-normal", verdict: "return-to-plan" }]),
    ]);
    expect(result.returnToPlan).toBe(true);
    expect(result.summary.stop_reason).toBe("unresolved");
    expect(result.outcome.verdict).not.toBe("full");
    const arbitrationFile = artifactOf(result.bundle, "artifacts/arbitration.json");
    expect(arbitrationFile["returnToPlan"]).toEqual(["r4-normal"]);
  });

  it("棄却のあとの版の再検査と次の道具が受ける文脈の組に、棄却した試験が無い", async () => {
    const suites: string[][] = [];
    const original = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      suites.push(input.suite.tests.map((test) => test.id));
      return original(input);
    });
    // r4-normal と同じ単位の試験 r4-normal-2 を足す（棄却しても単位は残り、要件は持ち越さない）
    const tests = [...BASE_TESTS(), r4Test("normal", "r4-normal-2")];
    const { result, recording } = await runScenario([
      ...head({ t2: t2Response(tests) }),
      structured(judgments(IDS, REJECT_R1)),
      repairDone(RUN_YAML, [dispute("r4-normal")]),
      arbitration([{ testId: "r4-normal", verdict: "overturn" }]),
      structured(judgments(IDS, REJECT_R2)),
      repairToolCall("call-1", "run-tests", RUN_YAML),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ]);
    expect(result.outcome.verdict).toBe("full");
    expect(carryEntriesOf(result.bundle)).toEqual([]);
    // 1 版目は棄却前の組。棄却のあとの版の再検査（B4）・道具（2 回目の B5 の run-tests）・最後の版は棄却後の組
    expect(suites[0]).toContain("r4-normal");
    expect(suites.length).toBeGreaterThanOrEqual(4);
    for (const suite of suites.slice(1)) {
      expect(suite).not.toContain("r4-normal");
      expect(suite).toContain("r4-normal-2");
    }
    const secondRepair: LlmToolRequest = recording.tools[1]!;
    const fixed = dataBlockOf(secondRepair.input, "固定した試験") as TestSuite;
    expect(fixed.tests.map((test) => test.id)).not.toContain("r4-normal");
  });
});

// ── (j) 停滞 ─────────────────────────────────────────────────────────

describe("(j) 停滞（v11a の署名）", () => {
  it("同じ B3' の拒否（要件 ID・種類）が stagnationRepeats 回続けば止まり、未解決（持ち越し）に数える", async () => {
    const { result, recording } = await runScenario([
      ...head(),
      structured(judgments(IDS, REJECT_R3)),
      repairDone(RUN_YAML),
      structured(judgments(IDS, REJECT_R3)),
    ]);
    expect(result.summary.stop_reason).toBe("stagnation");
    expect(recording.tools).toHaveLength(1);
    expect(result.outcome.verdict).toBe("partial");
    expect(carryEntriesOf(result.bundle)).toEqual([{ requirementId: "R3", reasons: [{ origin: "decl-check", reason: "mismatch" }] }]);
  });

  it("拒否が別の要件・別の種類に変われば止まらない", async () => {
    const { result, recording } = await runScenario([
      ...head(),
      structured(judgments(IDS, REJECT_R1)),
      repairDone(RUN_YAML),
      structured(judgments(IDS, REJECT_R2)),
      repairDone(RUN_YAML),
      structured(judgments(IDS, { R2: ["empty-location", "担当者の名前"] })),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ]);
    expect(recording.tools).toHaveLength(3);
    expect(result.summary.stop_reason).toBe("completed");
    expect(result.outcome.verdict).toBe("full");
  });

  it("B3・B4 が通り拒否だけが変わる 2 版で v11a の署名が変わり、v1 の failureSignature は同じ値", async () => {
    const suites: TestSuite[] = [];
    const original = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      suites.push(input.suite);
      return original(input);
    });
    const signatureSpy = vi.spyOn(repairStage, "failureSignature");
    await runScenario([
      ...head(),
      structured(judgments(IDS, REJECT_R1)),
      repairDone(RUN_YAML),
      structured(judgments(IDS, REJECT_R2)),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ]);
    const v1Signatures = signatureSpy.mock.results.map((entry) => entry.value as string);
    expect(v1Signatures.length).toBeGreaterThanOrEqual(2);
    expect(v1Signatures[0]).toBe(v1Signatures[1]);
    const report = {
      declaration: { source: RUN_YAML },
      declarationSha256: "x",
      staticCheck: { passed: true, diagnostics: [], app: null },
      correspondence: { entries: [], misses: [] },
      testRun: { mismatches: [], unresolved: [], routes: [], structural: [] },
      routes: [],
      defectMisses: [],
      redoMisses: [],
    } as const;
    const a = v11aFailureSignature(report, [{ requirementId: "R1", kind: "mismatch" }]);
    const b = v11aFailureSignature(report, [{ requirementId: "R2", kind: "mismatch" }]);
    expect(a).not.toBe(b);
    expect(repairStage.failureSignature(report)).toBe(repairStage.failureSignature({ ...report }));
    expect(v11aFailureSignature(report, [{ requirementId: "R1", kind: "mismatch" }])).toBe(a);
  });
});

// ── (k) J4 の判定の口が無い走りと門が拒否する走り ───────────────────────────

describe("(k) J4 は助言（判定の口の有無で結果が変わらない）", () => {
  it("判定の口が無い走りと、門が拒否する走りで verdict・要求・calls が同じで、judge-advice の記録は未判定", async () => {
    const gateJudge: Judge = {
      source: "fake",
      async judge() {
        throw Object.assign(new Error("門が断った"), { kind: "gateLimit" });
      },
    };
    const calls = (): RecordedCall[] => [...head(), structured(acceptAll())];
    const none = await runScenario(calls());
    const gated = await runScenario(calls(), { judge: gateJudge });
    expect(gated.result.outcome).toEqual(none.result.outcome);
    expect(gated.recording.structured.map((request) => request.input)).toEqual(
      none.recording.structured.map((request) => request.input),
    );
    expect(gated.result.record.stages.map((record) => record.calls)).toEqual(none.result.record.stages.map((record) => record.calls));
    for (const run of [none, gated]) {
      const rounds = artifactOf(run.result.bundle, V11A_ARTIFACT_NAMES.judgeAdvice)["rounds"] as readonly {
        requests: readonly { questions: readonly { undetermined: string | null; value: number | null }[] }[];
      }[];
      const questions = rounds.flatMap((round) => round.requests.flatMap((request) => request.questions));
      expect(questions.length).toBeGreaterThan(0);
      expect(questions.every((question) => question.undetermined !== null && question.value === null)).toBe(true);
    }
  });
});

// ── (l) 断った候補は診断のファイルにだけ ──────────────────────────────────

describe("(l) T1・T2 の断った候補", () => {
  it("診断のファイルに残り、要約・記録に値が無い", async () => {
    const marker = "目印の値の写し-9471";
    const t2Bad = t2Response([...r1Tests(), ...r2Tests(), ...r4Tests(), { ...r3Tests()[0]!, id: "目印の試験-5823" }]);
    const { result } = await runScenario([
      structured(badDraft(marker)),
      structured(draftOf(LIST, TABLE)),
      structured(acceptAll()),
      structured(t2Bad),
      structured(t2Response()),
      structured({ declaration: RUN_YAML }),
      structured(acceptAll()),
    ]);
    expect(result.outcome.verdict).toBe("full");
    const names = result.diagnostics.map((artifact) => artifact.path);
    expect(names).toEqual([DIAGNOSTICS_REJECTED_NAME_TABLE_FILE, DIAGNOSTICS_REJECTED_TEST_SPEC_FILE]);
    expect(JSON.stringify(result.diagnostics)).toContain(marker);
    expect(JSON.stringify(result.diagnostics)).toContain("目印の試験-5823");
    const summaryText = JSON.stringify(result.summary) + JSON.stringify(result.record);
    expect(summaryText).not.toContain(marker);
    expect(summaryText).not.toContain("目印の試験-5823");
    const bundleText = JSON.stringify(result.bundle?.artifacts);
    expect(bundleText).not.toContain(marker);
  });
});

// ── (m) 枯渇・形の失敗・意味の拒否の件数 ────────────────────────────────

describe("(m) B3' の件数は別の欄", () => {
  it("形の失敗 1・意味の拒否 1・枯渇 0", async () => {
    const { result } = await runScenario([
      ...head(),
      structured(acceptAll(["R1", "R2", "R3"])),
      structured(judgments(IDS, REJECT_R1)),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ]);
    expect(result.outcome.verdict).toBe("full");
    expect(artifactOf(result.bundle, V11A_ARTIFACT_NAMES.verification)["decl_check"]).toEqual({
      exhausted: 0,
      malformed: 1,
      rejected: 1,
    });
  });
});

// ── (n) 追加の要素の一覧 ───────────────────────────────────────────────

describe("(n) 追加の要素の一覧", () => {
  it("B3' の要求のデータと decl-check の記録で同じ値", async () => {
    const { result, recording } = await runScenario([...head(), structured(acceptAll())]);
    const request = recording.structured.find((entry) => entry.schemaName === DECL_CHECK_SCHEMA_NAME)!;
    const sent = dataBlockOf(request.input, "追加の要素");
    const versions = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.declCheck)["versions"] as readonly {
      extra_elements: unknown;
    }[];
    expect(versions[0]?.extra_elements).toEqual(sent);
    expect((sent as { name: string }[]).map((element) => element.name)).toContain("base");
  });
});

// ── 持ち越しの関数が断ったときの止まり方 ───────────────────────────────

describe("持ち越しの関数（A1）が断ったとき", () => {
  it("段 carry-over・unmet で止め、A1 の固定文を問題に 1 件載せる（例外のまま外へ出さない）", async () => {
    // R2 だけが所属させる entity の行（e.member）を、R1 の行（項目の参照 f.item.owner）が参照先として指す。
    // R2 を T1'' の拒否で持ち越すと e.member が除かれ、残る行の参照先が除いた行を指す
    const rejectR2 = judgments(IDS, { R2: ["unnecessary-ownership", "担当者の名前"] });
    const { result } = await runScenario([
      structured(draftOf(LIST, TABLE)),
      structured(rejectR2),
      structured(draftOf(LIST, TABLE)),
      structured(rejectR2),
    ]);
    expect(result.stopped?.stage).toBe("carry-over");
    expect(result.stopped?.kind).toBe("unmet");
    expect(result.stopped?.problems).toHaveLength(1);
    expect(result.stopped?.problems?.[0]?.field).toBe("carry-over");
    expect(result.stopped?.problems?.[0]?.message).toMatch(/^持ち越し：/);
    expect(result.outcome.verdict).toBe("none");
  });
});

// ── (o) T2 の分類の完全性と J2 の判断の保持（レビュー #521 の指摘 1・2）─────────────────

describe("(o) T2 の分類の完全性と J2 の判断の保持：どちらも full にならない", () => {
  const ahead = (table: NameTable = TABLE): RecordedCall[] => [structured(draftOf(LIST, table)), structured(acceptAll())];

  it("分類が空配列・1 件欠落・重複・対象外の T2 が 2 回 → 段 test-spec・unmet で止まり、full にならない", async () => {
    const cases: readonly (readonly NatureRow[])[] = [
      [],
      NATURES.filter((entry) => entry.requirementId !== "R1"),
      [...NATURES, { requirementId: "R1", nature: "ruled" }],
      [...NATURES, { requirementId: "R9", nature: "ruled" }],
    ];
    for (const classifications of cases) {
      const t2 = { classifications, tests: BASE_TESTS() };
      const { result, recording } = await runScenario([...ahead(), structured(t2), structured(t2)]);
      expect(result.stopped?.stage).toBe("test-spec");
      expect(result.stopped?.kind).toBe("unmet");
      expect(result.outcome.verdict).not.toBe("full");
      expect(result.summary.verdict).not.toBe("full");
      expect(schemaNames(recording.structured)).not.toContain("declaration-v11a");
    }
  });

  it("対照：1 回目が空配列でも、2 回目に完全な分類なら full", async () => {
    const { result } = await runScenario([
      ...ahead(),
      structured({ classifications: [], tests: BASE_TESTS() }),
      structured(t2Response()),
      structured({ declaration: RUN_YAML }),
      structured(acceptAll()),
    ]);
    expect(result.outcome.verdict).toBe("full");
  });

  /** T1 の R1 を existence-only にした表 */
  const TABLE_R1_EXISTENCE: NameTable = {
    ...TABLE,
    classification: TABLE.classification.map((entry) =>
      entry.requirementId === "R1" ? { requirementId: "R1", nature: "existence-only" as const } : entry,
    ),
  };
  const agreeing = NATURES.map((entry) =>
    entry.requirementId === "R1" ? { requirementId: "R1", nature: "existence-only" as const } : entry,
  );
  // 1 回目：T2 の R1 は ruled（T1 と食い違い J2 が ruled）。別の要件（R3）の境界が欠けて作り直しになる
  const round1 = () => ({
    classifications: NATURES,
    tests: [...r1Tests(), ...r2Tests(), ...r3Tests().filter((test) => test["kind"] !== "boundary"), ...r4Tests()],
  });
  const ruledJudge = () =>
    createFakeJudge({
      [natureQuestionName("R1")]: { kind: "choice", choice: "ruled", probabilities: undefined, probability: 0.99, confidence: undefined },
    });

  it("T1=existence-only・1 回目 T2=ruled・J2=ruled → 2 回目 T2=existence-only・R1 は正常 1 本：段 test-spec で止まり full にならない", async () => {
    const round2 = {
      classifications: agreeing,
      tests: [...r1Tests().filter((test) => test["kind"] === "normal"), ...r2Tests(), ...r3Tests(), ...r4Tests()],
    };
    const { result, recording } = await runScenario([...ahead(TABLE_R1_EXISTENCE), structured(round1()), structured(round2)], {
      judge: ruledJudge(),
    });
    expect(result.stopped?.stage).toBe("test-spec");
    expect(result.stopped?.kind).toBe("unmet");
    expect(result.stopped?.problems).toContainEqual({ field: "requirements[0]", message: "abnormal の試験が無い" });
    expect(result.outcome.verdict).not.toBe("full");
    expect(schemaNames(recording.structured)).not.toContain("declaration-v11a");
  });

  it("対照：2 回目に R1 の正常・異常・境界がそろえば full で、要約の食い違いに判断（judged・ruled）が残る", async () => {
    const round2 = { classifications: agreeing, tests: BASE_TESTS() };
    const { result } = await runScenario(
      [...ahead(TABLE_R1_EXISTENCE), structured(round1()), structured(round2), structured({ declaration: RUN_YAML }), structured(acceptAll())],
      { judge: ruledJudge() },
    );
    expect(result.outcome.verdict).toBe("full");
    expect(result.summary.nature_discrepancies).toEqual([
      expect.objectContaining({ requirement_id: "R1", design: "existence-only", classified: "ruled", resolved: "ruled", resolution: "judged" }),
    ]);
  });
});

// ── (p) 評価口に観測する性質の写像を渡す（Issue #526）─────────────────────────────

describe("(p) 評価口を作る 2 か所の両方に T2 の写像が渡る", () => {
  /** 評価口を作る材料を記録する（`alter` で写像を差し替えられる） */
  function spyEvaluatorInputs(alter: (input: V11aEvaluatorInput) => V11aEvaluatorInput = (input) => input) {
    const inputs: V11aEvaluatorInput[] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      inputs.push(input);
      return original(alter(input));
    });
    return inputs;
  }

  it("最初と、棄却で作り直すときの両方で、T2 の observes（記録の写像）が渡る", async () => {
    const inputs = spyEvaluatorInputs();
    const tests = [...BASE_TESTS(), r4Test("normal", "r4-normal-2")];
    const { result } = await runScenario([
      ...head({ t2: t2Response(tests) }),
      structured(judgments(IDS, REJECT_R1)),
      repairDone(RUN_YAML, [dispute("r4-normal")]),
      arbitration([{ testId: "r4-normal", verdict: "overturn" }]),
      structured(acceptAll()),
    ]);
    expect(result.outcome.verdict).toBe("full");
    // 最初の 1 回と、棄却のあとの作り直し（refreshCarry）の 1 回以上
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    const recorded = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.testSpec)["observes"] as Record<string, TestObserves>;
    expect(Object.keys(recorded).sort()).toEqual(tests.map((test) => String(test["id"])).sort());
    for (const input of inputs) expect(Object.fromEntries(input.observes)).toEqual(recorded);
    // 2 か所は同じ写像を渡す
    expect(new Set(inputs.map((input) => input.observes)).size).toBe(1);
  });

  it("写像に無い試験 ID を含む文脈では、その試験が未解決に数えられ full が出ない", async () => {
    const reports: { readonly unresolved: readonly { readonly testId: string; readonly detail: string }[] }[] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      // 偽物：T2 の写像から r2-shows を外して評価口を作り、B4 の結果を記録する
      const evaluator = original({ ...input, observes: new Map([...input.observes].filter(([testId]) => testId !== "r2-shows")) });
      return {
        ...evaluator,
        runTests: (app, context, correspondence) => {
          const report = evaluator.runTests(app, context, correspondence);
          reports.push(report);
          return report;
        },
      };
    });
    const passed: string[][] = [];
    const runTestsOriginal = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      passed.push(input.suite.tests.map((test) => test.id));
      return runTestsOriginal(input);
    });
    const { result } = await runScenario([
      ...head(),
      structured(acceptAll()),
      repairDone(RUN_YAML),
      structured(acceptAll()),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ]);
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.summary.verdict).not.toBe("full");
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report.unresolved).toEqual([{ testId: "r2-shows", detail: UNMAPPED_OBSERVES_DETAIL }]);
    }
    // 写像に無い試験は v1 の runTests に渡らない
    expect(passed.length).toBeGreaterThan(0);
    for (const ids of passed) expect(ids).not.toContain("r2-shows");
  });

  it("対照：写像を差し替えなければ、同じ記録で full", async () => {
    spyEvaluatorInputs();
    const { result } = await runScenario([...head(), structured(acceptAll())]);
    expect(result.outcome.verdict).toBe("full");
  });
});

// ── (q) 既定値の要件（default-value。Issue #533）────────────────────────────

/** 旗 off（`flags` を省く）と旗 on（`flags.ledger`）。(q) を両方で同じ結果に照らす（Issue #547） */
const FLAG_CASES: readonly { readonly name: string; readonly flags: Partial<GenerationInputV11a> }[] = [
  { name: "off", flags: {} },
  { name: "on", flags: { flags: { ledger: true } } },
];

describe.each(FLAG_CASES)("(q) 既定値の要件：宣言の default が合えば今までの門で full、違えば不一致で full が出ない（旗 $name）", ({ flags }) => {
  /** 旗 on の T1 の応答は計算の行に集計の種類と集計元を持つ（Issue #549） */
  const tableFor = (table: NameTable): NameTable => (flags.flags?.ledger === true ? withAggregates(table) : table);
  const D_LIST_BASE: RequirementList = {
    ...BASE_LIST,
    requirements: [
      ...BASE_LIST.requirements,
      { id: "R6", text: DEFAULT_VALUE_REQUIREMENT_TEXT, quote: DEFAULT_VALUE_REQUIREMENT_TEXT, position: { start: 0, end: DEFAULT_VALUE_REQUIREMENT_TEXT.length } },
    ],
  };
  const D_PLAN = planOf(D_LIST_BASE);
  const D_LIST = requirementsFromPlan(D_PLAN);
  const D_SOURCE = D_LIST_BASE.requirements.map((requirement) => requirement.text).join("");
  const D_IDS = [...IDS, "R6"] as const;
  /** 題材の表に、区分の項目の既定値だけを決める R6（default-value・alpha・ruled）を足した表 */
  const D_TABLE: NameTable = tableFor({
    ...TABLE,
    ownership: [...TABLE.ownership, { requirementId: "R6", roles: [{ id: "f.item.kind", basis: "stated", reason: null }] }],
    verification: [...TABLE.verification, { requirementId: "R6", kind: "default-value", value: "alpha" }],
    classification: [...TABLE.classification, { requirementId: "R6", nature: "ruled" }],
  });
  /** 区分の項目に default を足した宣言（key が null なら足さない） */
  const dYaml = (key: string | null): string =>
    key === null ? RUN_YAML : replaced(RUN_YAML, "          beta: ベータ\n", `          beta: ベータ\n        default: ${key}\n`);
  const r6Test = () =>
    rawTest({
      id: "r6-default",
      requirementId: "R6",
      targetKind: "field",
      roleId: "f.item.kind",
      operation: "validate",
      observes: "default-value",
      expected: ok(JSON.stringify("alpha")),
    });
  const D_NATURES: readonly NatureRow[] = [...NATURES, { requirementId: "R6", nature: "ruled" }];
  const t2D = (withR6 = true) => ({
    classifications: withR6 ? D_NATURES : NATURES,
    tests: [...r1Tests(), ...r2Tests(), ...r3Tests(), ...r4Tests(), ...(withR6 ? [r6Test()] : [])],
  });
  const dHead = (yaml: string): RecordedCall[] => [
    structured(draftOf(D_LIST, D_TABLE)),
    structured(acceptAll(D_IDS)),
    structured(t2D()),
    structured({ declaration: yaml }),
  ];
  async function runD(calls: readonly RecordedCall[], overrides: Partial<GenerationInputV11a> = {}) {
    return runScenario(calls, { plan: D_PLAN, source: D_SOURCE, ...flags, ...overrides });
  }
  /** 評価口の B4 の結果を記録する（評価口はそのまま） */
  function spyReports() {
    const reports: { readonly mismatches: readonly { readonly testId: string; readonly detail: string }[] }[] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      const evaluator = original(input);
      return {
        ...evaluator,
        runTests: (app, context, correspondence) => {
          const report = evaluator.runTests(app, context, correspondence);
          reports.push(report);
          return report;
        },
      };
    });
    return reports;
  }

  it("(1) default が期待のキーと合えば今までの門で full。B1 の要求の「固定した試験」に observes が渡り、既定値の試験は v1 の runTests に渡らない", async () => {
    const passed: string[][] = [];
    const original = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      passed.push(input.suite.tests.map((test) => test.id));
      return original(input);
    });
    const { result, recording } = await runD([...dHead(dYaml("alpha")), structured(acceptAll(D_IDS))]);
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.summary.exit_code).toBe(0);
    expect(carryEntriesOf(result.bundle)).toEqual([]);
    const write = recording.structured.find((request) => request.schemaName === WRITE_V11A_SCHEMA_NAME)!;
    const shown = dataBlockOf(write.input, WRITE_V11A_DATA_NAMES[2]) as { tests: { id: string; observes: string }[] };
    expect(shown.tests.map((test) => [test.id, test.observes])).toEqual(
      t2D().tests.map((test) => [test["id"], test["observes"]]),
    );
    expect(shown.tests.find((test) => test.id === "r6-default")?.observes).toBe("default-value");
    expect(passed.length).toBeGreaterThan(0);
    for (const ids of passed) expect(ids).not.toContain("r6-default");
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
  });

  it("(1) default が期待のキーと違えば不一致に数えられ、full が出ない", async () => {
    const reports = spyReports();
    const { result } = await runD([
      ...dHead(dYaml("beta")),
      structured(acceptAll(D_IDS)),
      repairDone(dYaml("beta")),
      structured(acceptAll(D_IDS)),
    ]);
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.summary.verdict).not.toBe("full");
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report.mismatches).toContainEqual({ testId: "r6-default", detail: DEFAULT_VALUE_DETAILS.defaultDiffers });
    }
    // default を書かない宣言も不一致
    const missing = spyReports();
    const none = await runD([...dHead(dYaml(null)), structured(acceptAll(D_IDS)), repairDone(dYaml(null)), structured(acceptAll(D_IDS))]);
    expect(none.result.outcome.verdict).not.toBe("full");
    expect(missing.at(-1)?.mismatches).toContainEqual({ testId: "r6-default", detail: DEFAULT_VALUE_DETAILS.defaultMissing });
  });

  it("(1) options の外の default を書いた宣言は静的チェックで落ち（既存の固定文）、B4 へ進まず full が出ない", async () => {
    const codes: string[][] = [];
    const original = staticCheckStage.runStaticCheck;
    vi.spyOn(staticCheckStage, "runStaticCheck").mockImplementation(async (declaration) => {
      const checked = await original(declaration);
      codes.push(checked.diagnostics.map((diagnostic) => diagnostic.code));
      return checked;
    });
    const { result } = await runD([...dHead(dYaml("gamma")), repairDone(dYaml("gamma"))]);
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.summary.verdict).not.toBe("full");
    expect(stageIds(result)).not.toContain("run-tests");
    expect(stageIds(result)).not.toContain("decl-check");
    expect(codes.length).toBeGreaterThan(0);
    for (const list of codes) expect(list).toContain("DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS");
  });

  it("(2) 拒否の配線：T1'' が default-value の要件を weak-verification で 2 回とも拒否すれば持ち越し、T2 の一覧と確かめ方に無く、full が出ない", async () => {
    const rejectR6 = judgments(D_IDS, { R6: ["weak-verification", "未入力なら保存の時点で alpha になる"] });
    const { result, recording } = await runD([
      structured(draftOf(D_LIST, D_TABLE)),
      structured(rejectR6),
      structured(draftOf(D_LIST, D_TABLE)),
      structured(rejectR6),
      structured(t2D(false)),
      structured({ declaration: dYaml("alpha") }),
      structured(acceptAll(IDS)),
    ]);
    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).toBe("partial");
    expect(carryEntriesOf(result.bundle)).toEqual([
      { requirementId: "R6", reasons: [{ origin: "semantic-check", reason: "weak-verification" }] },
    ]);
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    const list = dataBlockOf(t2.input, "要件の一覧") as RequirementList;
    expect(list.requirements.map((requirement) => requirement.id)).toEqual([...IDS]);
    const verification = dataBlockOf(t2.input, "要件ごとの確かめ方") as readonly { requirementId: string }[];
    expect(verification.map((entry) => entry.requirementId)).toEqual([...IDS]);
    expect(t2.input).not.toContain("default-value");
  });

  it("(2) 残る要件が全部拒否なら T2 を呼ばない（既存）", async () => {
    const rejectAll = judgments(
      D_IDS,
      Object.fromEntries(D_IDS.map((id) => [id, ["weak-verification", "項目"] as const])),
    );
    const { result, recording } = await runD([
      structured(draftOf(D_LIST, D_TABLE)),
      structured(rejectAll),
      structured(draftOf(D_LIST, D_TABLE)),
      structured(rejectAll),
    ]);
    expect(result.stopped?.stage).toBe("carry-over");
    expect(result.outcome.verdict).toBe("none");
    expect(schemaNames(recording.structured)).not.toContain(TEST_SPEC_SCHEMA_NAME);
  });
});

// ── (r) 選択肢の集合の要件（旗 on。Issue #548）──────────────────────────────

describe("(r) 選択肢の集合の要件：enum-membership で確かめる走りは宣言の options が表どおりなら今までの門で full（旗 on。内外の切り分けの型。Issue #548）", () => {
  const flags: Partial<GenerationInputV11a> = { flags: { ledger: true } };
  const E_LIST_BASE: RequirementList = {
    ...BASE_LIST,
    requirements: [
      ...BASE_LIST.requirements,
      {
        id: "R6",
        text: ENUM_MEMBERSHIP_REQUIREMENT_TEXT,
        quote: ENUM_MEMBERSHIP_REQUIREMENT_TEXT,
        position: { start: 0, end: ENUM_MEMBERSHIP_REQUIREMENT_TEXT.length },
      },
    ],
  };
  const E_PLAN = planOf(E_LIST_BASE);
  const E_LIST = requirementsFromPlan(E_PLAN);
  const E_SOURCE = E_LIST_BASE.requirements.map((requirement) => requirement.text).join("");
  const E_IDS = [...IDS, "R6"] as const;
  /** 題材の表に、区分の項目の選択肢の集合だけを決める R6（enum-membership・ruled）を足した表 */
  const E_TABLE_PLAIN: NameTable = {
    ...TABLE,
    ownership: [...TABLE.ownership, { requirementId: "R6", roles: [{ id: "f.item.kind", basis: "stated", reason: null }] }],
    verification: [...TABLE.verification, { requirementId: "R6", kind: "enum-membership" }],
    classification: [...TABLE.classification, { requirementId: "R6", nature: "ruled" }],
  };
  /** 旗 on の T1 の応答は計算の行に集計の種類と集計元を持つ（Issue #549） */
  const E_TABLE: NameTable = withAggregates(E_TABLE_PLAIN);
  /** 区分の項目の options の順を表と逆にした宣言（B3 の options の照合が落とす） */
  const REORDERED_YAML = replaced(RUN_YAML, "          alpha: アルファ\n          beta: ベータ\n", "          beta: ベータ\n          alpha: アルファ\n");
  const r6Test = () =>
    rawTest({
      id: "r6-enum",
      requirementId: "R6",
      targetKind: "field",
      roleId: "f.item.kind",
      operation: "validate",
      observes: "enum-membership",
      expected: ok(JSON.stringify(["alpha", "beta"])),
    });
  const E_NATURES: readonly NatureRow[] = [...NATURES, { requirementId: "R6", nature: "ruled" }];
  const t2E = (withR6 = true) => ({
    classifications: withR6 ? E_NATURES : NATURES,
    tests: [...r1Tests(), ...r2Tests(), ...r3Tests(), ...r4Tests(), ...(withR6 ? [r6Test()] : [])],
  });
  const eHead = (yaml: string): RecordedCall[] => [
    structured(draftOf(E_LIST, E_TABLE)),
    structured(acceptAll(E_IDS)),
    structured(t2E()),
    structured({ declaration: yaml }),
  ];
  async function runE(calls: readonly RecordedCall[], overrides: Partial<GenerationInputV11a> = {}) {
    return runScenario(calls, { plan: E_PLAN, source: E_SOURCE, ...flags, ...overrides });
  }

  it("正例：宣言の options が表どおりなら今までの門で full。B1 の規則に台帳の 1 文があり、固定した試験に observes が渡り、選択肢の集合の試験は v1 の runTests に渡らない", async () => {
    const passed: string[][] = [];
    const original = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      passed.push(input.suite.tests.map((test) => test.id));
      return original(input);
    });
    const { result, recording } = await runE([...eHead(RUN_YAML), structured(acceptAll(E_IDS))]);
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.summary.exit_code).toBe(0);
    expect(carryEntriesOf(result.bundle)).toEqual([]);
    const row = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership");
    const write = recording.structured.find((request) => request.schemaName === WRITE_V11A_SCHEMA_NAME)!;
    expect(write.rules).toContain(row?.rules.b1);
    const shown = dataBlockOf(write.input, WRITE_V11A_DATA_NAMES[2]) as { tests: { id: string; observes: string }[] };
    expect(shown.tests.find((test) => test.id === "r6-enum")?.observes).toBe("enum-membership");
    const semantic = recording.structured.find((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME)!;
    expect(semantic.rules?.some((text) => text.includes(row?.rules.t1Acceptance ?? "（無い）"))).toBe(true);
    expect(passed.length).toBeGreaterThan(0);
    for (const ids of passed) expect(ids).not.toContain("r6-enum");
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
  });

  it("旗 off では同じ表は T1' の形で落ち（台帳に無い種類）、full が出ない（未登録の拒否）", async () => {
    const { result } = await runScenario([structured(draftOf(E_LIST, E_TABLE_PLAIN)), structured(draftOf(E_LIST, E_TABLE_PLAIN))], {
      plan: E_PLAN,
      source: E_SOURCE,
    });
    expect(result.outcome.verdict).not.toBe("full");
    expect(stageIds(result)).not.toContain("semantic-check");
  });

  it("options の順が表と違う宣言は B3 の落ちで B5 へ行き、直した版で full", async () => {
    const reports: { readonly mismatches: readonly { readonly testId: string }[] }[] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      const evaluator = original(input);
      return {
        ...evaluator,
        runTests: (app, context, correspondence) => {
          const report = evaluator.runTests(app, context, correspondence);
          reports.push(report);
          return report;
        },
      };
    });
    const { result, recording } = await runE([...eHead(REORDERED_YAML), repairDone(RUN_YAML), structured(acceptAll(E_IDS))]);
    expect(recording.tools).toHaveLength(1);
    const misses = dataBlockOf(recording.tools[0]!.input, "対応表の落ち") as { requirementId: string; detail: string }[];
    expect(misses.length).toBeGreaterThan(0);
    // 1 版目は B3 に落ちて B3' を掛けない
    expect(countStage(result, "decl-check")).toBe(1);
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    for (const report of reports) expect(report.mismatches.map((entry) => entry.testId)).not.toContain("r6-enum");
  });

  it("負例 (c)①：同じ要件を validation の観測で確かめる試験は、台帳でも今までどおり「対応表の外」の不一致（名前の一致で救わない）で full が出ない", async () => {
    const reports: { readonly mismatches: readonly { readonly testId: string; readonly detail: string }[]; readonly routes: readonly { readonly testId: string; readonly route: string }[] }[] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      const evaluator = original(input);
      return {
        ...evaluator,
        runTests: (app, context, correspondence) => {
          const report = evaluator.runTests(app, context, correspondence);
          reports.push(report);
          return report;
        },
      };
    });
    // 確かめ方は fixed-test（validation の観測）で、選択肢の項目の validate を書く（手 2p の経路 (3) の形）
    const table: NameTable = {
      ...E_TABLE,
      verification: E_TABLE.verification.map((entry) => (entry.requirementId === "R6" ? { requirementId: "R6", kind: "fixed-test" as const } : entry)),
    };
    const validationTest = (kind: Kind) =>
      rawTest({
        id: `r6-option-${kind}`,
        requirementId: "R6",
        targetKind: "field",
        roleId: "f.item.kind",
        kind,
        operation: "validate",
        observes: "validation",
        input: { "f.item.kind": kind === "abnormal" ? "gamma" : "alpha" },
        expected: kind === "abnormal" ? { kind: "error", value: null, code: "E_INVALID" } : ok("true"),
      });
    const t2 = { classifications: E_NATURES, tests: [...r1Tests(), ...r2Tests(), ...r3Tests(), ...r4Tests(), ...KINDS.map(validationTest)] };
    const { result } = await runE([
      structured(draftOf(E_LIST, table)),
      structured(acceptAll(E_IDS)),
      structured(t2),
      structured({ declaration: RUN_YAML }),
      structured(acceptAll(E_IDS)),
      repairDone(RUN_YAML),
      structured(acceptAll(E_IDS)),
    ]);
    expect(result.outcome.verdict).not.toBe("full");
    expect(reports.length).toBeGreaterThan(0);
    const first = reports[0]!;
    const routes = first.routes.filter((entry) => entry.testId.startsWith("r6-option-"));
    expect(routes.length).toBeGreaterThan(0);
    for (const entry of routes) expect(entry.route).toBe("correspondence-defect");
    for (const entry of first.mismatches.filter((item) => item.testId.startsWith("r6-option-"))) {
      expect(entry.detail).toBe("表の ID が指す場所が宣言に無い");
    }
  });

  it("拒否の配線：T1'' が enum-membership の要件を weak-verification で 2 回とも拒否すれば持ち越し、T2 の一覧と確かめ方に無く、full が出ない", async () => {
    const rejectR6 = judgments(E_IDS, { R6: ["weak-verification", "alpha・beta のどれかである"] });
    const { result, recording } = await runE([
      structured(draftOf(E_LIST, E_TABLE)),
      structured(rejectR6),
      structured(draftOf(E_LIST, E_TABLE)),
      structured(rejectR6),
      structured(t2E(false)),
      structured({ declaration: RUN_YAML }),
      structured(acceptAll(IDS)),
    ]);
    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).toBe("partial");
    expect(carryEntriesOf(result.bundle)).toEqual([
      { requirementId: "R6", reasons: [{ origin: "semantic-check", reason: "weak-verification" }] },
    ]);
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    const verification = dataBlockOf(t2.input, "要件ごとの確かめ方") as readonly { requirementId: string }[];
    expect(verification.map((entry) => entry.requirementId)).toEqual([...IDS]);
  });
});

// ── (s) 空の集計の要件（旗 on。Issue #549）──────────────────────────────

describe("(s) 空の集計の要件：空の境界・未読の異常を empty-aggregate で持つ集計の要件の走りは、宣言の集計が表どおりなら v1 の評価器で不一致 0・今までの門で full（旗 on。(a)① の型。Issue #549）", () => {
  const flags: Partial<GenerationInputV11a> = { flags: { ledger: true } };
  /** アプリ全体の集計の行（宣言の補助の計算 base＝金額の合計と、足した平均 avgAmount。R4 が所属させる） */
  const appRow = (id: string, name: string, quote: string): NameTable["rows"][number] => ({
    id,
    kind: "computation",
    entity: null,
    name,
    role: "要件 R4 が使う対象",
    source: { requirementId: "R4", quote },
    type: { valueType: "number", scope: "app", form: "aggregate" },
    options: null,
    groupBy: null,
    refEntity: null,
  });
  /** 題材の表に、アプリ全体の合計・平均の行を足した表（集計の種類と集計元は持たない） */
  const S_TABLE_PLAIN: NameTable = {
    ...TABLE,
    rows: [...TABLE.rows, appRow("c.base", "base", "金額の合計"), appRow("c.avgAmount", "avgAmount", "全体の率")],
    ownership: TABLE.ownership.map((entry) =>
      entry.requirementId === "R4"
        ? { ...entry, roles: [...entry.roles, ...["c.base", "c.avgAmount"].map((id) => ({ id, basis: "stated" as const, reason: null }))] }
        : entry,
    ),
  };
  /** 旗 on の表（計算の行に集計の種類と集計元を持つ） */
  const S_TABLE: NameTable = withAggregates(S_TABLE_PLAIN, {
    "c.base": { kind: "sum", entity: "e.item" },
    "c.avgAmount": { kind: "avg", entity: "e.item" },
  });
  /** 宣言（平均の計算 avgAmount をアプリ全体に足し、まとめの画面に出す） */
  const S_YAML = replaced(
    replaced(RUN_YAML, "  - name: rate\n", "  - name: avgAmount\n    scope: app\n    aggregate:\n      avg: item.amount\n    type: number\n  - name: rate\n"),
    "      - type: bar\n",
    "      - type: number\n        value: avgAmount\n      - type: bar\n",
  );
  /** 見出しごとの集計の種類を件数から合計に替えた宣言（表は件数。B3 の集計の種類の照合が落とす） */
  const WRONG_KIND_YAML = replaced(S_YAML, "    aggregate:\n      count: item\n      groupBy: item.kind\n", "    aggregate:\n      sum: item.amount\n      groupBy: item.kind\n");
  /** 集計の試験 1 件（入力の契約の空の集合を指定する） */
  const aggTest = (id: string, roleId: string, kind: Kind, empty: readonly string[], value: unknown, observes = "empty-aggregate"): Record<string, unknown> => ({
    ...rawTest({ id, requirementId: "R4", targetKind: "computation", roleId, kind, operation: "aggregate", observes, expected: ok(JSON.stringify(value)) }),
    inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: empty },
  });
  const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
  /** 空の境界（集計元を空と明示）と未読の異常（集計元に触れない）。sum・count は 0、avg は null、見出しごとは並び */
  const emptyAggregateTests = () => [
    aggTest("r4-base-empty", "c.base", "boundary", ["e.item"], 0),
    aggTest("r4-base-unread", "c.base", "abnormal", [], null),
    aggTest("r4-avg-empty", "c.avgAmount", "boundary", ["e.item"], null),
    aggTest("r4-avg-unread", "c.avgAmount", "abnormal", [], null),
    aggTest("r4-kind-empty", "c.byKind", "boundary", ["e.item"], [
      { heading: "alpha", value: 0 },
      { heading: "beta", value: 0 },
    ]),
    aggTest("r4-kind-unread", "c.byKind", "abnormal", [], null),
    aggTest("r4-month-empty", "c.byMonth", "boundary", ["e.item"], MONTHS.map((heading) => ({ heading, value: 0 }))),
    aggTest("r4-month-unread", "c.byMonth", "abnormal", [], null),
  ];
  const t2S = (extra = emptyAggregateTests()) => t2Response([...r1Tests(), ...r2Tests(), ...r3Tests(), ...r4Tests(), ...extra]);
  const sHead = (yaml: string, table: NameTable = S_TABLE, t2: unknown = t2S()): RecordedCall[] => [
    structured(draftOf(LIST, table)),
    structured(acceptAll()),
    structured(t2),
    structured({ declaration: yaml }),
  ];
  /** 評価口の B4 の結果と、v1 の runTests に渡った試験を記録する（評価口はそのまま） */
  function spyRuns() {
    const reports: { readonly mismatches: readonly { readonly testId: string; readonly detail: string }[]; readonly unresolved: readonly { readonly testId: string }[] }[] = [];
    const passed: string[][] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      const evaluator = original(input);
      return {
        ...evaluator,
        runTests: (app, context, correspondence) => {
          const report = evaluator.runTests(app, context, correspondence);
          reports.push(report);
          return report;
        },
      };
    });
    const runTestsOriginal = runTestsStage.runTests;
    vi.spyOn(runTestsStage, "runTests").mockImplementation((input) => {
      passed.push(input.suite.tests.map((test) => test.id));
      return runTestsOriginal(input);
    });
    return { reports, passed };
  }

  it("(1) 正例：宣言の集計が表どおりなら v1 の評価器で不一致 0・今までの門で full（sum の空は 0、avg の空は null、見出しごとは並び、未読は null）。空の集計の試験は v1 の runTests に渡る", async () => {
    const { reports, passed } = spyRuns();
    const { result, recording } = await runScenario([...sHead(S_YAML), structured(acceptAll())], flags);
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.summary.exit_code).toBe(0);
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report.mismatches).toEqual([]);
      expect(report.unresolved).toEqual([]);
    }
    const ids = emptyAggregateTests().map((test) => test["id"]);
    expect(passed.length).toBeGreaterThan(0);
    for (const id of ids) expect(passed.at(-1)).toContain(id);
    // B1 の規則に台帳の 1 文があり、固定した試験に observes が渡り、名前の表の計算の行に aggregate が載る
    const row = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate");
    const write = recording.structured.find((request) => request.schemaName === WRITE_V11A_SCHEMA_NAME)!;
    expect(write.rules).toContain(row?.rules.b1);
    const shown = dataBlockOf(write.input, WRITE_V11A_DATA_NAMES[2]) as { tests: { id: string; observes: string }[] };
    expect(shown.tests.find((test) => test.id === "r4-base-empty")?.observes).toBe("empty-aggregate");
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
  });

  it("(2) (c)② の型：宣言の集計の種類が表と違えば B3 の落ちで B5 へ行き、直した版で full", async () => {
    const { result, recording } = await runScenario([...sHead(WRONG_KIND_YAML), repairDone(S_YAML), structured(acceptAll())], flags);
    expect(recording.tools).toHaveLength(1);
    const misses = dataBlockOf(recording.tools[0]!.input, "対応表の落ち") as { requirementId: string; detail: string }[];
    expect(misses.map((miss) => miss.detail)).toContain("計算 byKind の集計の種類が sum（表は count）");
    // 1 版目は B3 に落ちて B3' を掛けない
    expect(countStage(result, "decl-check")).toBe(1);
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("(3) (a)① の型（手 2p の経路 (3) の、空と明示して null を期待する試験の形を集計の行に書いたもの）：旗 on では T2' で落ちて B4 へ進まない。直す前（旗 off）は B4 の不一致", async () => {
    const aOne = aggTest("r4-empty-null", "c.base", "boundary", ["e.item"], null, "value");
    const t2 = t2S([aOne]);
    // 旗 on：T2' が 2 回とも落とし、段 test-spec で止まる（B4 へ進まない）
    const on = await runScenario([structured(draftOf(LIST, S_TABLE)), structured(acceptAll()), structured(t2), structured(t2)], flags);
    expect(on.result.stopped?.stage).toBe("test-spec");
    expect(on.result.outcome.verdict).not.toBe("full");
    expect(stageIds(on.result)).not.toContain("run-tests");
    const rejected = diagnosticOf(on.result.diagnostics, DIAGNOSTICS_REJECTED_TEST_SPEC_FILE) as { candidates?: { problems?: { field: string; message: string }[] }[] };
    const row = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate");
    expect(JSON.stringify(rejected)).toContain(row?.t2Aggregate?.messages.alsoExpected ?? "（無い）");
    // 直す前（旗 off。表は aggregate を持たない）：T2 を通り、B4 の不一致（空の合計は 0 で、期待は null）
    const { reports } = spyRuns();
    const off = await runScenario([
      ...sHead(S_YAML, S_TABLE_PLAIN, t2),
      structured(acceptAll()),
      repairDone(S_YAML),
      structured(acceptAll()),
    ]);
    expect(off.result.outcome.verdict).not.toBe("full");
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]!.mismatches.map((entry) => entry.testId)).toContain("r4-empty-null");
  });

  it("旗 off では同じ表（計算の行に aggregate を持つ）は T1' の形で落ち（未登録の拒否）、full が出ない", async () => {
    const { result } = await runScenario([structured(draftOf(LIST, S_TABLE)), structured(draftOf(LIST, S_TABLE))]);
    expect(result.stopped?.stage).toBe("name-table");
    expect(result.outcome.verdict).not.toBe("full");
  });
});

// ── 段単位の走り（08-architecture-v1.2.md §8.3。Issue #544）──────────────────────────────

describe("段単位の走り：範囲の外の段を呼ばず、納品物を組まず、境界の材料に B の結果を入れない", () => {
  it("終了 T1''：T2 以降を呼ばず、T1''／T2 の境界だけを返す", async () => {
    const recording = createRecordingClient(head().slice(0, 2));
    const outcome = await runStageRangeV11a({ ...inputOf(recording.client), range: { start: "name-table", end: "semantic-check" } });
    expect(outcome.stopped).toBeNull();
    expect(schemaNames(recording.structured)).toEqual([NAME_TABLE_SCHEMA_NAME, SEMANTIC_CHECK_SCHEMA_NAME]);
    expect(outcome.boundaries.map((boundary) => boundary.boundary)).toEqual(["t1-t2"]);
    expect(outcome.stages.map((record) => record.stage)).toEqual(["name-table", "semantic-check"]);
    expect(outcome.judgeVerdict).toBeNull();
  });

  it("終了 ⑦：⑧（bundle）を呼ばず、⑦ の判定を別に返す。境界の持ち越しは B3' で増えた分を含まない", async () => {
    const recording = createRecordingClient([...head(), structured(judgments(IDS, REJECT_R3)), repairDone(RUN_YAML), structured(judgments(IDS, REJECT_R3))]);
    const outcome = await runStageRangeV11a({ ...inputOf(recording.client), range: { start: "name-table", end: "judge" } });
    expect(outcome.stopped).toBeNull();
    expect(outcome.stages.map((record) => record.stage)).not.toContain("bundle");
    expect(outcome.stages.at(-1)?.stage).toBe("judge");
    expect(outcome.judgeVerdict).toBe("partial");
    expect(outcome.finalCarryOver).toEqual([{ requirementId: "R3", reasons: [{ origin: "decl-check", reason: "mismatch" }] }]);
    expect(outcome.boundaries.map((boundary) => boundary.boundary)).toEqual(["t1-t2", "t2-b1"]);
    for (const boundary of outcome.boundaries) expect(boundary.carryOver.entries).toEqual([]);
    expect(outcome).not.toHaveProperty("bundle");
  });

  it("通常の生成（範囲なし）は今までどおり納品物を組む", async () => {
    const { result } = await runScenario([...head(), structured(acceptAll())]);
    expect(result.bundle).not.toBeNull();
    expect(stageIds(result)).toContain("bundle");
  });

  it("開始 T2・B1 に再開の材料が無ければ、呼ばずに断る（呼ぶ側の誤り）", async () => {
    const recording = createRecordingClient([]);
    await expect(runStageRangeV11a({ ...inputOf(recording.client), range: { start: "test-spec", end: "judge" } })).rejects.toThrow();
    await expect(runStageRangeV11a({ ...inputOf(recording.client), range: { start: "write", end: "judge" } })).rejects.toThrow();
    expect(recording.structured).toHaveLength(0);
  });
});

// ── 旗（v1.2 の旗 `v12.ledger`。08-architecture-v1.2.md §9 手 2・Issue #547）──────────────────

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const nodeFs = (await importUntyped("node:fs")) as NodeFileSystem;
/** 手 2p の比較元のバイトの記録（`__fixtures__/baseline-v11a-800411c/`。#546。読むだけ） */
const baselineJson = <T>(name: string): T =>
  JSON.parse(nodeFs.readFileSync(new URL(`../__fixtures__/baseline-v11a-800411c/${name}`, import.meta.url), "utf8")) as T;
const BASELINE_DEFINITIONS = baselineJson<BaselineV11aScenarios>("scenarios.json");
const BASELINE_LIBRARY = baselineJson<{ readonly captures: readonly BaselineV11aCapture[] }>("library.json");

/** 工場の module の `runGenerationV11a` に旗（と要約に旗を書く印）を足して流す口 */
const moduleWith = (extra: Partial<GenerationInputV11a>): typeof factoryModule => ({
  ...factoryModule,
  runGenerationV11a: (input) => factoryModule.runGenerationV11a({ ...input, ...extra }),
});

describe("旗を省いた・off の走りは v1.1α の記録（手 2p の library 4 経路）とバイト列で同じ", () => {
  it("flags を省いた走りと flags.ledger を off にした走りが、4 経路とも記録と深く等しい", async () => {
    for (const extra of [{}, { flags: {} }, { flags: { ledger: false } }] as const) {
      const captures = await captureBaselineV11a(moduleWith(extra), BASELINE_DEFINITIONS);
      expect(captures, JSON.stringify(extra)).toEqual(BASELINE_LIBRARY.captures);
    }
  });
});

/** 走りの台帳の導出を #548 の台帳（empty-aggregate の行を除いた導出）にする（#548 までの旗 on を今の候補で再現する。Issue #549） */
const asLedger2B = () =>
  vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? LEDGER_VIEW_2B : undefined));

/** 手 2p の経路の定義の T1 の応答の計算の行に、集計の種類と集計元を足した写し（今の台帳の旗 on の走りに流す。Issue #549） */
const BASELINE_DEFINITIONS_ON: BaselineV11aScenarios = {
  ...BASELINE_DEFINITIONS,
  scenarios: BASELINE_DEFINITIONS.scenarios.map((scenario) => ({ ...scenario, recorded: withAggregateResponses(scenario.recorded) })),
} as BaselineV11aScenarios;

/**
 * 今の台帳の旗 on の走りと #548 の台帳の旗 on の走りで違ってよい納品物のファイル（表の計算の行の aggregate と、表の SHA を
 * 持つもの・その SHA を並べる manifest。Issue #549）
 */
const EMPTY_AGGREGATE_BUNDLE_DIFF = [
  "artifacts/name-table.json",
  "artifacts/semantic-check.json",
  "artifacts/judge-advice.json",
  "artifacts/verification-v11a.json",
  "bundle-manifest.json",
] as const;
/** 同じく違ってよい診断のファイル（断った表の候補） */
const EMPTY_AGGREGATE_DIAGNOSTICS_DIFF = ["diagnostics/rejected-name-table.json"] as const;
/** 表を載せるデータを持つ要求（今の台帳の on は、計算の行の aggregate の分だけデータ `$.input` が違ってよい） */
const TABLE_DATA_SCHEMAS: readonly string[] = [
  NAME_TABLE_SCHEMA_NAME,
  SEMANTIC_CHECK_SCHEMA_NAME,
  TEST_SPEC_SCHEMA_NAME,
  WRITE_V11A_SCHEMA_NAME,
  DECL_CHECK_SCHEMA_NAME,
];
/** 名指しの場所に、データ（`$.input`）の位置を足す（規則の後・schema の前。`jsonDiffPaths` の順） */
const withInputPath = (paths: readonly string[]): readonly string[] => {
  const at = paths.findIndex((path) => path.startsWith("$.schema"));
  return at < 0 ? [...paths, "$.input"] : [...paths.slice(0, at), "$.input", ...paths.slice(at)];
};

/** 工場の module の `runGenerationV11a` の結果を集める口（納品物と診断の中身を比べる） */
const moduleCollecting = (extra: Partial<GenerationInputV11a>, results: Awaited<ReturnType<typeof runGenerationV11a>>[]): typeof factoryModule => ({
  ...factoryModule,
  runGenerationV11a: async (input) => {
    const result = await factoryModule.runGenerationV11a({ ...input, ...extra });
    results.push(result);
    return result;
  },
});

describe("旗 on の要求の差は台帳に足した行の分だけ：flags.ledger を on にした走りの要求（T1・T1''・T2・B1）の差の場所を固定し、ほかの要求・納品物・要約・記録が同じ（Issue #547・#548・#549）", () => {
  it("#548 の台帳の on：手 2p の library 4 経路で、要求の差は名指しの場所（R-nt-08・R-sc-02・R-tsp-02・R-tsp-16・R-w11 の並び・schema の enum）だけで、その分を除けば記録と深く等しい。判定の問い・道具の結果・納品物の全ファイル・段の記録・要約は記録と深く等しい", async () => {
    // #548 までの旗 on（台帳に empty-aggregate の行が無い）を今の候補で流す（Issue #549）
    asLedger2B();
    const captures = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS);
    expect(captures).toHaveLength(BASELINE_LIBRARY.captures.length);
    captures.forEach((capture, index) => {
      const expected = BASELINE_LIBRARY.captures[index]!;
      const requestOf = (record: unknown) => (record as { readonly request: unknown }).request;
      expect(capture.requests, capture.name).toHaveLength(expected.requests.length);
      const diffs = requestDiffsOf(capture.requests.map(requestOf), expected.requests.map(requestOf));
      for (const diff of diffs) {
        expect(diff.paths, `${capture.name} ${diff.schemaName}`).toEqual(ENUM_MEMBERSHIP_REQUEST_DIFF[diff.schemaName] ?? []);
      }
      // 要求の外側（kind・hasSignal）は同じで、差の分を除けば記録とバイト列で同じ
      expect(capture.requests.map((record) => ({ ...(record as object), request: null })), capture.name).toEqual(
        expected.requests.map((record) => ({ ...(record as object), request: null })),
      );
      expect(JSON.stringify(withoutEnumMembership(capture.requests)), capture.name).toBe(JSON.stringify(expected.requests));
      const { requests: _onRequests, ...rest } = capture;
      const { requests: _offRequests, ...expectedRest } = expected;
      expect(rest.bundle, capture.name).toEqual(expectedRest.bundle);
      expect(rest.judgment.summary, capture.name).toEqual(expectedRest.judgment.summary);
      expect(rest.judgment.stages, capture.name).toEqual(expectedRest.judgment.stages);
      expect(rest, capture.name).toEqual(expectedRest);
    });
  });

  it("今の台帳の on と #548 の台帳の on の差は empty-aggregate の行の分だけ：手 2p の library 4 経路（T1 の応答の計算の行に集計の種類と集計元を足した写し）で、要求の差は名指しの場所（R-nt-08・R-tsp-16・R-w11 の並び・schema の行の型の aggregate・observes の enum・表を載せるデータ）だけで、その分を除けば #548 の on とバイト列で同じ。判定・段の記録・要約・道具の結果・結び付けは同じで、納品物・診断の差は表の aggregate と表の SHA の分だけ", async () => {
    const nowResults: Awaited<ReturnType<typeof runGenerationV11a>>[] = [];
    const now = await captureBaselineV11a(moduleCollecting({ flags: { ledger: true } }, nowResults), BASELINE_DEFINITIONS_ON);
    const spy = asLedger2B();
    const beforeResults: Awaited<ReturnType<typeof runGenerationV11a>>[] = [];
    const before = await captureBaselineV11a(moduleCollecting({ flags: { ledger: true } }, beforeResults), BASELINE_DEFINITIONS);
    spy.mockRestore();
    expect(now).toHaveLength(before.length);
    now.forEach((capture, index) => {
      const expected = before[index]!;
      const requestOf = (record: unknown) => (record as { readonly request: unknown }).request;
      expect(capture.requests, capture.name).toHaveLength(expected.requests.length);
      for (const diff of requestDiffsOf(capture.requests.map(requestOf), expected.requests.map(requestOf))) {
        const named = EMPTY_AGGREGATE_REQUEST_DIFF[diff.schemaName] ?? [];
        const allowed = TABLE_DATA_SCHEMAS.includes(diff.schemaName) && diff.paths.includes("$.input") ? withInputPath(named) : named;
        expect(diff.paths, `${capture.name} ${diff.schemaName}`).toEqual(allowed);
      }
      expect(JSON.stringify(withoutEmptyAggregate(capture.requests)), capture.name).toBe(JSON.stringify(expected.requests));
      expect(capture.judgment, capture.name).toEqual(expected.judgment);
      expect(capture.toolResults, capture.name).toEqual(expected.toolResults);
      // 納品物・診断：ファイルの並びは同じで、違ってよいのは名指しのファイルだけ
      const changed = (files: readonly { readonly path: string; readonly sha256: string }[], others: readonly { readonly path: string; readonly sha256: string }[]) =>
        files.filter((file, at) => file.sha256 !== others[at]?.sha256).map((file) => file.path);
      expect(capture.bundle?.files.map((file) => file.path), capture.name).toEqual(expected.bundle?.files.map((file) => file.path));
      for (const path of changed(capture.bundle?.files ?? [], expected.bundle?.files ?? [])) expect(EMPTY_AGGREGATE_BUNDLE_DIFF, capture.name).toContain(path);
      expect(capture.diagnostics.map((file) => file.path), capture.name).toEqual(expected.diagnostics.map((file) => file.path));
      for (const path of changed(capture.diagnostics, expected.diagnostics)) expect(EMPTY_AGGREGATE_DIAGNOSTICS_DIFF, capture.name).toContain(path);
    });
    // 中身：表の計算の行の aggregate の欄を除き、表の SHA を #548 の on の表の SHA に置き換えれば、manifest のほかの全ファイルと
    // 診断がバイト列で同じ（差は表の aggregate の分だけ）
    expect(nowResults).toHaveLength(beforeResults.length);
    nowResults.forEach((result, index) => {
      const other = beforeResults[index]!;
      const tableShaOf = (files: readonly { readonly path: string; readonly text: string }[]) =>
        (JSON.parse(files.find((file) => file.path === "artifacts/name-table.json")?.text ?? "{}") as { table_sha256?: string }).table_sha256;
      const nowSha = tableShaOf(result.bundle?.artifacts ?? []);
      const beforeSha = tableShaOf(other.bundle?.artifacts ?? []);
      const normalized = (text: string) => {
        const stripped = withoutEmptyAggregate(text) as string;
        return nowSha === undefined || beforeSha === undefined ? stripped : stripped.split(nowSha).join(beforeSha);
      };
      const filesOf = (files: readonly { readonly path: string; readonly text: string }[]) => files.filter((file) => file.path !== "bundle-manifest.json");
      expect(filesOf(result.bundle?.artifacts ?? []).map((file) => [file.path, normalized(file.text)])).toEqual(
        filesOf(other.bundle?.artifacts ?? []).map((file) => [file.path, file.text]),
      );
      // 診断の断った候補は候補そのものの SHA を持つ（aggregate の分だけ違う）ので、SHA の値は伏せて比べる
      const masked = (text: string) => text.replace(/[0-9a-f]{64}/g, "<sha256>");
      expect(result.diagnostics.map((file) => [file.path, masked(normalized(file.text))])).toEqual(
        other.diagnostics.map((file) => [file.path, masked(file.text)]),
      );
      if (result.bundle !== null) expect(nowSha).not.toBe(beforeSha);
    });
  });

  it("差は空でない（Issue #549）：今の台帳の on の T1・T2・B1 の要求に台帳の empty-aggregate の文と schema の aggregate・表の計算の行の aggregate があり、#548 の台帳の on・off（記録）には無い", async () => {
    const now = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS_ON);
    asLedger2B();
    const before = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS);
    const row = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate")!;
    const full = JSON.stringify(now[0]!.requests);
    const previous = JSON.stringify(before[0]!.requests);
    const recorded = JSON.stringify(BASELINE_LIBRARY.captures[0]!.requests);
    for (const text of [row.rules.t1, row.rules.t2, row.rules.b1]) {
      expect(text).not.toBeNull();
      expect(full).toContain(JSON.stringify(text).slice(1, -1));
      expect(previous).not.toContain(JSON.stringify(text).slice(1, -1));
      expect(recorded).not.toContain(JSON.stringify(text).slice(1, -1));
    }
    for (const text of ['"enum-membership","empty-aggregate"]', '"aggregate":{"type":["object","null"]', '\\"aggregate\\": {']) {
      expect(full, text).toContain(text);
      expect(previous, text).not.toContain(text);
      expect(recorded, text).not.toContain(text);
    }
  });

  it("差は空でない：on の T1・T1''・T2・B1 の要求に台帳の enum-membership の文があり、off（記録）には無い", async () => {
    const captures = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS_ON);
    const row = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership")!;
    const full = JSON.stringify(captures[0]!.requests);
    const recorded = JSON.stringify(BASELINE_LIBRARY.captures[0]!.requests);
    for (const text of [row.rules.t1, row.rules.t1Acceptance, row.rules.t2, row.rules.b1]) {
      expect(text).not.toBeNull();
      expect(full).toContain(JSON.stringify(text).slice(1, -1));
      expect(recorded).not.toContain(JSON.stringify(text).slice(1, -1));
    }
    expect(recorded).not.toContain("enum-membership");
  });

  it("二点測定：差の場所の外の要求を 1 文字変えると、差の場所の照らしが落ちる（照らしは差の場所を固定している）", () => {
    const off = { rules: ["a", "b"], schema: { x: 1 }, input: "i" };
    expect(jsonDiffPaths({ ...off, input: "j" }, off)).toEqual(["$.input"]);
    expect(jsonDiffPaths({ ...off, rules: ["a", "b", "c"] }, off)).toEqual(["$.rules"]);
    expect(jsonDiffPaths(off, off)).toEqual([]);
    expect(withoutEnumMembership({ e: ["default-value", "enum-membership"], t: "structural・default-value・enum-membership" })).toEqual({
      e: ["default-value"],
      t: "structural・default-value",
    });
  });

  it("内外の切り分けの型：負例 (c)①（同じ要件を validation の観測で確かめる経路 3）は on でも「対応表の外」の不一致のまま", async () => {
    const captures = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS_ON);
    const stagnation = captures[2]?.testRun as {
      readonly mismatches: readonly { readonly testId: string; readonly detail: string }[];
      readonly routes: readonly { readonly testId: string; readonly route: string }[];
    };
    expect(stagnation.mismatches.find((entry) => entry.testId === "r1-option-validate")?.detail).toBe("表の ID が指す場所が宣言に無い");
    expect(stagnation.routes.find((entry) => entry.testId === "r1-option-validate")?.route).toBe("correspondence-defect");
    expect(captures[2]?.judgment.outcome).toEqual({ result: "partial", verdict: "partial" });
  });

  it("台帳の導出を段へ渡している（on の T1'・T2'・評価口は台帳の関数を通る。off は通らない）", async () => {
    const seen: (V11aEvaluatorInput["ledger"] | undefined)[] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      seen.push(input.ledger);
      return original(input);
    });
    await runScenario([...head(), structured(acceptAll())]);
    await runScenario([...head({ table: TABLE_ON }), structured(acceptAll())], { flags: { ledger: true } });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBeUndefined();
    expect(seen.at(-1)?.observes).toContain("default-value");
  });
});

describe("呼び出し数の回帰の契約試験（手 2p）の走りが、旗 on・off で同じ数", () => {
  /** 初回で全段が通る走り（calls.test.ts の (1) と同じ並び） */
  const cleanCalls = (materials: SizedMaterials): RecordedCall[] => [
    structured(materials.nameTableResponse()),
    structured(materials.judgments()),
    structured(materials.testSpecResponse()),
    structured({ declaration: materials.declaration() }),
    structured(materials.judgments()),
  ];
  /** やり直しを含む走り（calls.test.ts の (2) と同じ並び。形・中身のやり直し・修復・裁定） */
  const retryCalls = (materials: SizedMaterials): RecordedCall[] => {
    const incomplete = { judgments: materials.judgments().judgments.slice(0, -1) };
    const rejectR1 = materials.judgments({ R1: ["unnecessary-ownership", materials.textOf("R1")] });
    const dispute = { testId: "t5-normal", quote: materials.textOf("R5") };
    return [
      structured({ rows: "x", requirements: "x" }),
      structured(materials.nameTableResponse()),
      structured(incomplete),
      structured(rejectR1),
      structured(materials.nameTableResponse()),
      structured(materials.judgments()),
      structured({ classifications: "x", tests: "x" }),
      structured(materials.testSpecResponse({ omitAbnormalOf: "R1" })),
      structured(materials.testSpecResponse()),
      structured({ declaration: materials.declaration(["R1"]) }),
      structured(incomplete),
      structured(materials.judgments()),
      repairDone(materials.declaration(["R2"]), [dispute]),
      structured({ decisions: [{ testId: dispute.testId, verdict: "uphold", reason: "", quote: "" }] }),
      structured(materials.judgments()),
      repairDone(materials.declaration()),
      structured(materials.judgments()),
    ];
  };

  async function observeWith(materials: SizedMaterials, calls: readonly RecordedCall[], extra: Partial<GenerationInputV11a>) {
    const inner = createFakeLlmClient(calls);
    const requests: unknown[] = [];
    const client: GenerationInputV11a["client"] = {
      async callStructured(request) {
        requests.push({ kind: "structured", request });
        return inner.callStructured(request);
      },
      async callWithTools(request) {
        requests.push({ kind: "tools", request });
        return inner.callWithTools(request);
      },
    };
    const judged: unknown[] = [];
    const fake = createFakeJudge(materials.adviceAnswers());
    const judge: Judge = {
      source: "fake",
      async judge(request) {
        judged.push(Object.keys(request.questions));
        return fake.judge(request);
      },
    };
    const result = await runGenerationV11a({
      ...inputOf(client, { source: materials.source, plan: materials.plan, judge, budgetUsd: 1_000, deadline: 86_400_000 }),
      ...extra,
    });
    return { stages: result.record.stages, requests: JSON.stringify(requests), judged, outcome: result.outcome, summary: result.summary };
  }

  it.each([MEDIAN_SIZE, MAX_SIZE])("要件 $requirements・試験 $tests：初回で通る走りとやり直しを含む走りの段の記録（応答・実開始・再試行・門）・要求・判定が同じ", async (size) => {
    const materials = buildSized(size.requirements, size.tests);
    for (const calls of [cleanCalls(materials), retryCalls(materials)]) {
      const off = await observeWith(materials, calls, {});
      const on = await observeWith(materials, calls, { flags: { ledger: true } });
      expect(on.stages).toEqual(off.stages);
      // 要求は呼び出しの数と並びが同じで、差は台帳の enum-membership（Issue #548）・empty-aggregate（Issue #549）の行の分だけ
      // （この組の名前の表に計算の行は無いので、表を載せるデータは同じ）
      expect(JSON.stringify(withoutLedgerAdditions(JSON.parse(on.requests)))).toBe(off.requests);
      const onRequests = (JSON.parse(on.requests) as { readonly request: unknown }[]).map((entry) => entry.request);
      const offRequests = (JSON.parse(off.requests) as { readonly request: unknown }[]).map((entry) => entry.request);
      expect(onRequests).toHaveLength(offRequests.length);
      for (const diff of requestDiffsOf(onRequests, offRequests)) {
        expect(diff.paths, diff.schemaName).toEqual(LEDGER_REQUEST_DIFF[diff.schemaName] ?? []);
      }
      expect(on.judged).toEqual(off.judged);
      expect(on.outcome).toEqual(off.outcome);
      expect(on.summary).toEqual(off.summary);
      expect(off.stages.length).toBeGreaterThan(0);
    }
  });
});

describe("旗の組の契約（要約の v12_flags）", () => {
  it("recordV12Flags が真の走りは、完走でも T1 で止まる走りでも、要約に実効の旗の組 v12_flags がある（納品物の要約にも）", async () => {
    const extra = { flags: V12_PIPELINE_FLAGS, recordV12Flags: true };
    const full = await runScenario([...head({ table: TABLE_ON }), structured(acceptAll())], extra);
    expect(full.result.outcome.verdict).toBe("full");
    expect((full.result.summary as unknown as Record<string, unknown>)["v12_flags"]).toEqual(V12_PIPELINE_FLAGS);
    const summaryFile = full.result.bundle?.artifacts.find((artifact) => artifact.path === "artifacts/summary.json");
    expect((JSON.parse(summaryFile?.text ?? "{}") as Record<string, unknown>)["v12_flags"]).toEqual(V12_PIPELINE_FLAGS);
    const bad = draftOf(LIST, TABLE);
    const broken = { ...bad, requirements: bad.requirements.map((entry, index) => (index === 0 ? { ...entry, copy: "目印の値の写し" } : entry)) };
    const stopped = await runScenario([structured(broken), structured(broken)], extra);
    expect(stopped.result.stopped?.stage).toBe("name-table");
    expect((stopped.result.summary as unknown as Record<string, unknown>)["v12_flags"]).toEqual(V12_PIPELINE_FLAGS);
  });

  it("recordV12Flags を省いた走り（旗 on でも）・旗を省いた走りの要約に v12_flags が無い", async () => {
    for (const extra of [{}, { flags: { ledger: true } }] as const) {
      const { result } = await runScenario([...head(extra.flags === undefined ? {} : { table: TABLE_ON }), structured(acceptAll())], extra);
      expect(result.summary, JSON.stringify(extra)).not.toHaveProperty("v12_flags");
    }
  });

  it("正本の旗の組は旗の名前を全部持ち（merge 済みの手の旗は全部 on）、省いた名前は off に解く", () => {
    expect(Object.keys(V12_PIPELINE_FLAGS)).toEqual([...V12_FLAG_NAMES]);
    for (const name of V12_FLAG_NAMES) expect(V12_PIPELINE_FLAGS[name]).toBe(true);
    expect(resolveV12Flags()).toEqual({ ledger: false });
    expect(resolveV12Flags({})).toEqual({ ledger: false });
    expect(resolveV12Flags(V12_PIPELINE_FLAGS)).toEqual(V12_PIPELINE_FLAGS);
    expect(factoryModule.V12_PIPELINE_FLAGS).toBe(V12_PIPELINE_FLAGS);
  });
});
