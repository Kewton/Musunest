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
  DIAGNOSTICS_LISTING_FILE,
  DIAGNOSTICS_REJECTED_MAPPING_FILE,
  DIAGNOSTICS_REJECTED_NAME_TABLE_FILE,
  DIAGNOSTICS_REJECTED_TEST_SPEC_FILE,
  DIAGNOSTICS_REJECTED_VOCABULARY_FILE,
  DIAGNOSTICS_TABLE_ROUNDS_FILE,
  MAPPINGS_FILE,
  TEST_SUITE_FILE,
  TESTS_FILE,
  VERIFICATION_FILE,
  bundleFiles,
  type AssembledBundle,
} from "../bundle.js";
import type { Judge, JudgeAnswer } from "../judge.js";
import { createFakeJudge } from "../judge-fake.js";
import type { RecordedCall } from "../llm-fake.js";
import type { LlmClient, LlmStructuredRequest, LlmToolRequest, LlmUsage } from "../llm.js";
import { AGENT_LIMITS, STAGE_EFFORT_STAGES, maxOutputTokensForEffort } from "../limits.js";
import { createOpenAiLlmClient, type FetchLike } from "../openai.js";
import { resolveStageEnvelope, type EnvelopeId } from "../schema-envelope.js";
import { requirementsFromPlan, type RequirementList, type TestSuite } from "../pipeline.js";
import * as bindModule from "../stages/bind.js";
import * as correspondenceStage from "../stages/correspondence.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import * as repairStage from "../stages/repair.js";
import * as runTestsStage from "../stages/run-tests.js";
import * as staticCheckStage from "../stages/static-check.js";
import * as triageStage from "../stages/unwritable-triage.js";
import { makeRunInput, structured as plainStructured } from "../__tests__/run.js";
import {
  bundledC2Client,
  bundledC3Client,
  bundledT2Client,
  createCheckedRecordingClient,
  DEFAULT_VALUE_REQUIREMENT_TEXT,
  ENUM_MEMBERSHIP_REQUEST_DIFF,
  ENUM_MEMBERSHIP_REQUIREMENT_TEXT,
  FIXTURE_DOCUMENTS,
  FIXTURE_YAML,
  draftOf,
  NegativeOutput,
  negative,
  t1ResponseOf,
  fixtureList,
  fixtureTable,
  jsonDiffPaths,
  requestDiffsOf,
  withAggregateResponses,
  withAggregates,
  fixtureDefaultValueList,
  fixtureDefaultValueTable,
  casesResponseOf,
  requestListedIds,
  codeIdRenameOf,
  idsResponseList,
  idsResponsesOf,
  renameIds,
  withCheckTargets,
  withCodeIds,
  withoutEnumMembership,
  withoutLedgerAdditions,
  LEDGER_REQUEST_DIFF,
  EMPTY_AGGREGATE_REQUEST_DIFF,
  LEDGER_VIEW_2B,
  LEDGER_VIEW_2C,
  NON_REQUIREMENT_TEXT,
  RULED_AS_NON_REQUIREMENT_QUOTE,
  RULED_AS_NON_REQUIREMENT_TEXT,
  WHEN_NON_REQUIREMENT_REQUEST_DIFF,
  withoutEmptyAggregate,
  withoutWhenAndNonRequirement,
  fixtureGeneratedTable,
  REQUIRED_VALIDATIONS_BLOCK,
  withoutRequiredValidations,
  revert735,
  revertBundleFiles735,
} from "./__tests__/fixtures.js";
import {
  STAGE_RUN_RECORD_SCHEMA,
  STAGE_VERIFICATION_NOT_RUN_STATIC_CHECK,
  V11A_ARTIFACT_NAMES,
  V12_SEARCH_REPAIR_ARTIFACT_NAME,
  buildStageCheckpoint,
  buildStageRunRecord,
  stageJsonText,
  stageOutputDigest,
  stagesInRange,
  stageVersionsAt,
  verifyStageInput,
  type BoundaryMaterials,
} from "./bundle-v11a.js";
import * as evaluateModule from "./evaluate.js";
import { DEFAULT_VALUE_DETAILS, ENUM_MEMBERSHIP_DETAILS, UNMAPPED_OBSERVES_DETAIL, type V11aEvaluatorInput } from "./evaluate.js";
import { COMPUTATION_AGGREGATE_MESSAGES, nameTableSha256, ownersByRowId, type NameTable } from "./names.js";
import {
  ALL_CARRIED_OR_NON_REQUIREMENT_PROBLEM,
  ALL_CARRIED_PROBLEM,
  runGenerationV11a,
  runStageRangeV11a,
  staticCheckForRecount,
  v11aFailureSignature,
  type GenerationInputV11a,
} from "./run.js";
import * as declCheckStage from "./stages/decl-check.js";
import { DECL_CHECK_SCHEMA_NAME } from "./stages/decl-check.js";
import { NAME_TABLE_PREVIOUS_DATA_NAMES, NAME_TABLE_SCHEMA_NAME } from "./stages/name-table.js";
import * as semanticCheckStage from "./stages/semantic-check.js";
import { SEMANTIC_CHECK_SCHEMA_NAME } from "./stages/semantic-check.js";
import { TEST_SPEC_DATA_NAMES, TEST_SPEC_SCHEMA_NAME, testSpecRuleDefinitionsOf, testSpecSchemaOf, testSuiteSha256, type TestObserves } from "./stages/test-spec.js";
import {
  WRITE_V11A_DATA_NAMES,
  WRITE_V11A_IDS_R07_DEFINITION,
  WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME,
  WRITE_V11A_RULE_DEFINITIONS,
  WRITE_V11A_REWRITE_DATA_NAME,
  WRITE_V11A_REWRITE_RULE_DEFINITIONS,
  WRITE_V11A_SCHEMA_NAME,
} from "./stages/write.js";
import { NAMED_FAILURE_MESSAGES } from "../v12/search-repair.js";
import { GENERATED_TEST_ID_PREFIX, generateTests, isGeneratedTestId } from "../v12/generated-tests.js";
import type { FixedTest } from "../fixed-test.js";
import { constraintIdsIn, ruleTexts, SHAPE_PROBLEMS_DATA_NAME } from "../stages/prompt.js";
import { MAPPING_LEDGER_DATA_NAMES, MAPPING_REWRITE_MESSAGES, MAPPING_SCHEMA_NAME } from "../v12/stages/mapping.js";
import { structuralReadingText } from "../v12/structural-meanings.js";
import { FIELD_REPAIR_DIAGNOSTIC_DATA_NAME, FIELD_REPAIR_SCHEMA_NAME, MERGE_REFUSALS } from "../v12/stages/field-repair.js";
import { natureQuestionName } from "../stages/test-suite.js";
import { captureBaselineV11a, type BaselineV11aCapture, type BaselineV11aScenarios } from "../__tests__/baseline-capture.js";
import * as factoryModule from "../index.js";
import { createFakeLlmClient, uncheckedBecause } from "../llm-fake.js";
import {
  PROPERTY_LEDGER,
  PROPERTY_LEDGER_VIEW,
  V12_PIPELINE_FLAGS,
  deriveLedgerView,
  ledgerRowDefects,
  propertyLedgerSha256,
  upstreamLedgerSha256,
  V12_FLAG_NAMES,
  V12_FLAG_PUBLIC_NAMES,
  V12_PUBLIC_FLAG_NAMES,
  fromPublicV12Flags,
  resolveV12Flags,
  toPublicV12Flags,
  type PropertyRow,
  type V12Flags,
} from "../v12/ledger.js";
import * as ledgerModule from "../v12/ledger.js";
import { V12_CALL_LIMITS } from "../v12/limits.js";
import { buildSized, MAX_SIZE, MEDIAN_SIZE, type SizedMaterials } from "./__tests__/sizes.js";

/**
 * 旗 ids on の C3 の要求の R-sc-02 から、構造の検査の読み方の文（Issue #732 で足した）を外した要求（#732 の前の要求と照らす。
 * ほかの段の要求はそのまま）
 */
function withoutIdsReading(requests: readonly LlmStructuredRequest[]): readonly LlmStructuredRequest[] {
  return requests.map((request) =>
    request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME && request.rules !== undefined
      ? { ...request, rules: request.rules.map((text) => text.replace(structuralReadingText(), "")) }
      : request,
  );
}

/** Issue #663 で旗 ids の T2 の R-tsp-02 の末尾に足した、要件ごとの試験の上限の文（値は限度の表の定数から組む） */
const T2_IDS_LIMIT_TEXT = `要件ごとの試験は、コードが作った分を含めて ${String(AGENT_LIMITS.testsPerRequirement)} 本まで。必要な試験の枠の残る本数（remaining）を超えて場合を書かない。`;

/**
 * 旗 ids on の T2 の要求の R-tsp-02 から、要件ごとの試験の上限の文（Issue #663 で足した）を外した要求（#663 の前の要求と照らす。
 * 外す前に、T2 の要求ごとに上限の文がちょうど 1 つ在ることを確かめる。ほかの段の要求はそのまま）
 */
function withoutIdsLimit(requests: readonly LlmStructuredRequest[]): readonly LlmStructuredRequest[] {
  return requests.map((request) => {
    if (request.schemaName !== TEST_SPEC_SCHEMA_NAME) return request;
    expect((request.rules ?? []).filter((text) => text.endsWith(T2_IDS_LIMIT_TEXT))).toHaveLength(1);
    return { ...request, rules: (request.rules ?? []).map((text) => (text.endsWith(T2_IDS_LIMIT_TEXT) ? text.slice(0, text.length - T2_IDS_LIMIT_TEXT.length) : text)) };
  });
}

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

/** 固定した試験（decode 済み）を strict の schema の形に戻す（コードが作った試験を LLM の応答に書いたことにする比べ方。Issue #595） */
const rawOfFixed = (test: FixedTest, observes: string): Record<string, unknown> => ({
  id: test.id,
  target: test.target,
  kind: test.kind,
  operation: test.operation,
  clock: test.clock,
  input: JSON.stringify(test.input),
  inputContract: test.inputContract,
  referenceData: test.referenceData.map((row) => ({ ...row, values: JSON.stringify(row.values) })),
  expected: test.expected.kind === "ok" ? ok(JSON.stringify(test.expected.value)) : { kind: "error", value: null, code: test.expected.code },
  // 構造の検査（手 3d・#624 からコードが作る）は strict の形の assertion に戻す（欄は null で埋める）
  assertion:
    test.assertion === undefined
      ? null
      : { check: test.assertion.check, expected: test.assertion.expected ?? null, refEntity: test.assertion.refEntity ?? null, role: test.assertion.role ?? null },
  observes,
});

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

/** 構造化出力の記録（負例の応答には `unchecked` と理由が付く。照合ありの偽物がその記録だけ schema に照らさない） */
function structured(output: unknown, usage?: LlmUsage): RecordedCall {
  if (output instanceof NegativeOutput) {
    return { ...plainStructured(output.output, usage), unchecked: uncheckedBecause(output.reason) } as RecordedCall;
  }
  return plainStructured(output, usage);
}

/**
 * 表から T1 の応答（strict の schema に合う形）を作る。表の計算の行が集計の種類と集計元（`withAggregates`）を持てば、
 * 台帳が集計の種類を持つ走り（旗 on）の schema に合わせ、持たなければ旗 off の schema に合わせる。表が集計の欄を持たない
 * まま旗 on で流す記録は、`ledgerOn` に true を渡す（全部の行の型に aggregate が要る）。
 */
const t1Of = (list: RequirementList, table: NameTable, ledgerOn?: boolean) =>
  t1ResponseOf(
    draftOf(list, table),
    (ledgerOn ?? table.rows.some((row) => row.type !== null && typeof row.type === "object" && "aggregate" in row.type))
      ? PROPERTY_LEDGER_VIEW
      : undefined,
  );

/** T1・T1''・T2・B1 の記録（既定は完走の道） */
const head = (
  options: { readonly t2?: unknown; readonly yaml?: string; readonly table?: NameTable } = {},
): RecordedCall[] => [
  structured(t1Of(LIST, options.table ?? TABLE)),
  structured(acceptAll()),
  structured(options.t2 ?? t2Response()),
  structured({ declaration: options.yaml ?? RUN_YAML }),
];

/** 旗 v12.ids の走りの表（題材の表をコードの形の ID に振り直し、C1 が組む順・出典なし。Issue #593） */
const CODE_RENAME = codeIdRenameOf(TABLE);
const TABLE_IDS: NameTable = withCodeIds(TABLE_ON);
/** 旗 v12.ids の C2 が組む表（構造の検査の確かめ方に検査ごとの対象を持つ。所属は fixture のまま。Issue #594） */
const MAPPED_IDS: NameTable = withCheckTargets(TABLE_IDS);
/** 値の中の題材の表の ID を、コードの形の ID に振り直す（T2 の応答など） */
const renamed = <T,>(value: T): T => renameIds(value, CODE_RENAME);

/**
 * 旗 v12.ids の走りの T2 の応答（手 3d・Issue #624：構造の要件 R2 は要求の一覧に無く、構造の検査と画面の試験はコードが作るので、
 * R2 の試験と分類を書かない）
 */
const idsT2Response = (tests: readonly Record<string, unknown>[] = [...r1Tests(), ...r3Tests(), ...r4Tests()], only: readonly string[] = IDS) =>
  // 手 3e（#625）：応答は同じ内容の場合の形（骨組みはコードが組む）
  casesResponseOf(t2Response(tests, only.filter((id) => id !== "R2")));

/** 旗 v12.ids（と台帳 on）の走りの C1 の 3 束・C2・T1''・T2・B1 の記録（既定は完走の道。Issue #593） */
const idsHead = (options: { readonly t2?: unknown; readonly yaml?: string; readonly table?: NameTable } = {}): RecordedCall[] => [
  ...idsResponseList(idsResponsesOf(LIST, options.table ?? TABLE_IDS, PROPERTY_LEDGER_VIEW)).map((output) => structured(output)),
  structured(acceptAll()),
  structured(renamed(options.t2 ?? idsT2Response())),
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
  // 旗 v12.ids の走りは C3 を束ごとに同時に呼ぶので、記録した C3 の応答を束ごとに読む（束 1 つなら今と同じ。Issue #735）。
  // C2 の初回も要件 6 件以上なら束ごとに読む（要件 5 件以下は今と同じ。Issue #736）
  const recording = createCheckedRecordingClient(calls, { bundledC3: overrides.flags?.ids === true, bundledC2: overrides.flags?.ids === true });
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
  return t1ResponseOf({
    ...draft,
    requirements: draft.requirements.map((entry, index) => (index === 0 ? { ...entry, copy: marker } : entry)),
  });
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

/** 要求から段ごとの effort と打ち切りの合図を除く（口なしの走りの要求と比べる。Issue #664） */
const withoutEffort664 = ({ effort: _effort, signal: _signal, ...rest }: LlmStructuredRequest) => rest;
/** 道具付きの要求から段ごとの effort と打ち切りの合図を除く（Issue #751） */
const withoutToolEffort664 = ({ effort: _effort, signal: _signal, ...rest }: LlmToolRequest) => rest;

describe("旗 v12.ids：C1 語彙（3 束）→ C2 要件の写像 → J4 → C3（Issue #593）", () => {
  const IDS_FLAGS = { ledger: true, searchRepair: true, ids: true };
  const responses = () => idsResponsesOf(LIST, TABLE_IDS, PROPERTY_LEDGER_VIEW);
  const referencesOf = (result: Awaited<ReturnType<typeof runScenario>>["result"], stage: string) =>
    result.record.stages.filter((record) => record.stage === stage).map((record) => record.references);

  it("初回で通る走り：記録は vocabulary 3・mapping 1 で name-table が無く、参照の照合の数は知らない ID・重複・別の束の ID が 0", async () => {
    const { result, recording } = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_FLAGS });
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(countStage(result, "vocabulary")).toBe(3);
    expect(countStage(result, "mapping")).toBe(1);
    expect(countStage(result, "name-table")).toBe(0);
    for (const references of [...referencesOf(result, "vocabulary"), ...referencesOf(result, "mapping")]) {
      expect(references).toMatchObject({ unknown_ids: 0, duplicates: 0, cross_bundle_ids: 0 });
    }
    // 照らした参照の数は応答の参照の全部（C2：要件 ID・所属の ID・構造の検査の対象の ID〔Issue #594〕）
    const roles = TABLE_IDS.ownership.reduce((total, entry) => total + entry.roles.length, 0);
    const targets = MAPPED_IDS.verification.reduce((total, entry) => total + (entry.kind === "structural" ? (entry.targets ?? []).reduce((sum, target) => sum + 1 + (target.sourceId === null ? 0 : 1), 0) : 0), 0);
    expect(targets).toBeGreaterThan(0);
    expect(referencesOf(result, "mapping")[0]?.checked).toBe(LIST.requirements.length + roles + targets);
    // T2 に見せる行の出典は null。C2・C3・T2 の要求に名前を見せない
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME);
    const rows = dataBlockOf(t2?.input ?? "", TEST_SPEC_DATA_NAMES[2]) as readonly Record<string, unknown>[];
    expect(rows).toHaveLength(TABLE_IDS.rows.length);
    expect(rows.every((row) => row["source"] === null && !("name" in row))).toBe(true);
    // 構造で確かめる要件は、手 3d（#624）から T2 の確かめ方に無い（C2 が書いた対象の ID からコードが構造の検査を作る）
    const verification = dataBlockOf(t2?.input ?? "", TEST_SPEC_DATA_NAMES[3]) as readonly Record<string, unknown>[];
    const structural = MAPPED_IDS.verification.filter((entry) => entry.kind === "structural");
    expect(structural.length).toBeGreaterThan(0);
    for (const entry of structural) {
      expect(verification.some((item) => item["requirementId"] === entry.requirementId), entry.requirementId).toBe(false);
    }
    // 写しの欄（copy）と出典の引用の欄（requestQuote）が C1・C2 の要求に無い
    const tableRequests = recording.structured.filter((request) => request.schemaName.startsWith("vocabulary-") || request.schemaName === "mapping");
    expect(tableRequests).toHaveLength(4);
    for (const request of tableRequests) {
      expect(JSON.stringify(request).includes('\\"copy\\"')).toBe(false);
      expect(JSON.stringify(request).includes("requestQuote")).toBe(false);
    }
  });

  it("段ごとの effort（Issue #664・#751）(6)：C1・C2・C3・T2 の束・B1・B3'・⑥ 直すに違う effort を指定した走りで、各要求（道具付きを含む）の effort と上限がその段の指定から出る。effort の欄を除いた要求・段の記録・要約・納品物・診断は口なしの走りと深く等しい", async () => {
    const efforts = { vocabulary: "low", mapping: "medium", "semantic-check": "low", "test-spec": "medium", write: "low", "decl-check": "medium", repair: "low" } as const;
    // 要求の schema の名前 → 段（C1 は束ごとの名前、B1 は v1.1α の宣言の名前）と、その段が引く出力の上限の段
    const stageOf = (schemaName: string): keyof typeof efforts | undefined =>
      schemaName.startsWith("vocabulary-")
        ? "vocabulary"
        : (({ [MAPPING_SCHEMA_NAME]: "mapping", [SEMANTIC_CHECK_SCHEMA_NAME]: "semantic-check", [TEST_SPEC_SCHEMA_NAME]: "test-spec", "declaration-v11a": "write", [DECL_CHECK_SCHEMA_NAME]: "decl-check", [FIELD_REPAIR_SCHEMA_NAME]: "repair" }) as Record<string, keyof typeof efforts>)[schemaName];
    const outputStageOf = { vocabulary: "name-table", mapping: "name-table", "semantic-check": "semantic-check", "test-spec": "test-spec", write: "write", "decl-check": "decl-check", repair: "repair" } as const;
    // 初版が不一致になり、⑥ 直す（道具付き）を 1 往復だけ実際に呼ぶ台本（旗 search-repair は外す）
    const broken = replaced(RUN_YAML, "    when: amount > 0", "    when: amount > 5");
    const flags = { ledger: true, ids: true } as const;
    const calls = [...idsHead({ yaml: broken }), structured(acceptAll()), repairDone(RUN_YAML), structured(acceptAll())];
    const plain = await runScenario(calls, { flags });
    const tuned = await runScenario(calls, { flags, stageEfforts: efforts });
    expect(tuned.result.outcome).toEqual({ result: "pass", verdict: "full" });
    const seen = new Set<string>();
    for (const request of tuned.recording.structured) {
      const stage = stageOf(request.schemaName);
      if (stage === undefined) {
        expect("effort" in request, request.schemaName).toBe(false);
        continue;
      }
      seen.add(stage);
      expect(request.effort, request.schemaName).toBe(efforts[stage]);
      expect(request.maxOutputTokens, request.schemaName).toBe(maxOutputTokensForEffort(efforts[stage], outputStageOf[stage]));
    }
    // ⑥ 直すは道具付きの要求で呼ぶ（往復の全部のターンに同じ effort）。段の集合に repair を足して 7 段を見る
    expect(tuned.recording.tools.length).toBeGreaterThan(0);
    seen.add("repair");
    for (const request of tuned.recording.tools) {
      expect(request.effort).toBe(efforts.repair);
      expect(request.maxOutputTokens).toBe(maxOutputTokensForEffort(efforts.repair, "repair"));
    }
    expect(seen).toEqual(new Set(STAGE_EFFORT_STAGES));
    expect(countStage(tuned.result, "repair")).toBeGreaterThan(0);
    // T2 は束の口で呼ぶ（旗 ids の T2 は束ごとに 1 記録）。束の口の要求も T2 の段の effort を持つ
    expect(countStage(tuned.result, "test-spec")).toBeGreaterThan(0);
    expect(tuned.recording.structured.filter((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME).every((request) => request.effort === "medium")).toBe(true);
    // 口なしの走りの要求に effort の欄は無い。effort の欄を除けば、口を付けた走りの要求と同じ
    expect(plain.recording.structured.some((request) => "effort" in request)).toBe(false);
    expect(plain.recording.tools.some((request) => "effort" in request)).toBe(false);
    expect(tuned.recording.structured.map(withoutEffort664)).toEqual(plain.recording.structured.map(withoutEffort664));
    expect(tuned.recording.tools.map(withoutToolEffort664)).toEqual(plain.recording.tools.map(withoutToolEffort664));
    // effort は記録の値を変えない（段の記録・要約・納品物・診断・終了コード）
    expect(tuned.result).toEqual(plain.result);
    expectNoAcceptanceMaterial(tuned.recording.structured.map((request) => JSON.stringify(request)));
  });

  it("段ごとの effort（Issue #664）(2')：段の走り（name-table..semantic-check）で C3 に low を付けると、C3 の要求だけ effort low・上限は low の C3 の値で、C1・C2 の要求は今のまま（effort の欄が無い）。段の走りの結果は口なしと深く等しい", async () => {
    const calls = [...idsHead(), structured(acceptAll())];
    const run = async (overrides: Partial<GenerationInputV11a>) => {
      const recording = createCheckedRecordingClient(calls);
      const outcome = await runStageRangeV11a({ ...inputOf(recording.client), flags: IDS_FLAGS, range: { start: "name-table", end: "semantic-check" }, ...overrides });
      return { outcome, recording };
    };
    const plain = await run({});
    const tuned = await run({ stageEfforts: { "semantic-check": "low" } });
    const c3 = tuned.recording.structured.filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME);
    expect(c3.length).toBeGreaterThan(0);
    for (const request of c3) {
      expect(request.effort).toBe("low");
      expect(request.maxOutputTokens).toBe(maxOutputTokensForEffort("low", "semantic-check"));
    }
    expect(tuned.recording.structured.filter((request) => request.schemaName !== SEMANTIC_CHECK_SCHEMA_NAME).some((request) => "effort" in request)).toBe(false);
    expect(tuned.outcome).toEqual(plain.outcome);
  });

  it("C1' の負例：束 2 の知らない ID が 2 回続けば段 vocabulary・unmet で止まる（終了コード 1・納品物無し）。束 1 は 1 回だけ呼ぶ", async () => {
    const good = responses();
    const unknown = { fields: (good.fields["fields"] as readonly Record<string, unknown>[]).map((item, index) => (index === 0 ? { ...item, entity: "E9" } : item)) };
    const { result, recording } = await runScenario([structured(good.entities), structured(unknown), structured(unknown)], { flags: IDS_FLAGS });
    expect(result.stopped).toMatchObject({ stage: "vocabulary", kind: "unmet" });
    expect(result.summary.exit_code).toBe(1);
    expect(result.summary.stop_reason).toBe("unmet");
    expect(result.bundle).toBeNull();
    expect(schemaNames(recording.structured)).toEqual(["vocabulary-entities", "vocabulary-fields", "vocabulary-fields"]);
    const [, fields] = referencesOf(result, "vocabulary");
    expect(fields?.unknown_ids).toBeGreaterThanOrEqual(1);
    const totalRefs = TABLE_IDS.rows.filter((row) => row.kind === "field").reduce((total, row) => total + 1 + (row.refEntity === null ? 0 : 1), 0);
    expect(fields?.checked).toBe(2 * totalRefs);
    expect(result.stopped?.problems?.map((problem) => problem.message)).toContain("知らない ID である（この表で振った ID に無い）");
  });

  /** 診断の断った候補のファイル 1 本の候補（Issue #608） */
  type IdsRejected = {
    stage: string;
    operation: null;
    call: number;
    round: number;
    attempt: number;
    kind: string;
    response: unknown;
    response_sha256: string;
    problems: { field: string; code?: string; message: string; reference: string; reference_sha256: string }[];
  };
  const rejectedOf = (result: Awaited<ReturnType<typeof runScenario>>["result"], path: string) =>
    diagnosticOf(result.diagnostics, path)["candidates"] as readonly IdsRejected[];
  const diagnosticPaths = (result: Awaited<ReturnType<typeof runScenario>>["result"]) => result.diagnostics.map((artifact) => artifact.path);
  /** 候補の問題を、段が返した問題の形（欄の位置・分類・固定文）にする（並びはそのまま） */
  const problemsOf = (candidate: IdsRejected | undefined) =>
    (candidate?.problems ?? []).map((problem) => ({ field: problem.field, ...(problem.code === undefined ? {} : { code: problem.code }), message: problem.message }));
  /** 段が返した問題（停止の問題・やり直しの要求の「前回の形の問題」）を、同じ形にする */
  const stageProblemsOf = (problems: readonly { field: string; code?: string; message: string }[] | undefined) =>
    (problems ?? []).map((problem) => ({ field: problem.field, ...(problem.code === undefined ? {} : { code: problem.code }), message: problem.message }));
  /** 形のやり直しの要求に載った、前回の形の問題（その回に C1'・C2' が返した問題の全部） */
  const retryProblemsOf = (request: LlmStructuredRequest | undefined) =>
    stageProblemsOf(dataBlockOf(request?.input ?? "", SHAPE_PROBLEMS_DATA_NAME) as readonly { field: string; code?: string; message: string }[]);
  const requestsOf = (recording: Awaited<ReturnType<typeof runScenario>>["recording"], schemaName: string) =>
    recording.structured.filter((request) => request.schemaName === schemaName);
  /**
   * 候補の raw・SHA-256 は無加工（SHA-256 は raw から計算し直した値と一致し、問題の参照元の SHA-256 も同じ）。複写した欄は段・回・試行の
   * 値だけで、要件の文・要件 ID・行の ID・題材の言葉を持たない（Issue #657）
   */
  const expectRawAndMetadata = async (candidate: IdsRejected | undefined, raw: unknown, extraKeys: readonly string[] = []) => {
    expect(candidate?.response).toEqual(raw);
    const sha = await sha256Hex(JSON.stringify(raw));
    expect(candidate?.response_sha256).toBe(sha);
    expect(candidate?.problems.every((problem) => problem.reference === "response" && problem.reference_sha256 === sha)).toBe(true);
    const { response: _response, response_sha256: _sha, problems: _problems, ...metadata } = candidate as IdsRejected;
    expect(Object.keys(metadata).sort()).toEqual(["attempt", "call", "kind", "operation", "round", "stage", ...extraKeys].sort());
    const text = JSON.stringify(metadata);
    for (const value of [...LIST.requirements.map((item) => item.text), ...LIST.requirements.map((item) => item.id), ...TABLE_IDS.rows.map((row) => row.id)]) {
      expect(text.includes(`"${value}"`), value).toBe(false);
    }
    expectNoAcceptanceMaterial([text]);
  };
  const good = () => responses();
  /** 束 2（項目）の最初の行の entity を、表で振っていない ID にした応答（C1' が断る） */
  const fieldsWithEntity = (entity: string) => ({
    fields: (good().fields["fields"] as readonly Record<string, unknown>[]).map((item, index) => (index === 0 ? { ...item, entity } : item)),
  });
  /** 初回で通る走りの C1 の 3 束・C2・T1''・T2・B1 と B3' の応答（C1・C2 の応答だけを差し替える） */
  const passingWith = (options: { readonly fields?: readonly unknown[]; readonly mapping?: readonly unknown[] } = {}) => {
    const [entities, fields, behaviors, mapping, ...rest] = idsHead();
    return [
      entities!,
      ...(options.fields ?? []).map((output) => structured(output)),
      fields!,
      behaviors!,
      ...(options.mapping ?? []).map((output) => structured(output)),
      mapping!,
      ...rest,
      structured(acceptAll()),
    ];
  };

  it("C1 の束 2 の初回が形で落ちてやり直しで通る走り：走りは通り、rejected-vocabulary に候補 1 件（束 2・試行 1・その回の問題の全部）。診断は候補の 1 本と回ごとの行の 1 本（Issue #657・#699）", async () => {
    const bad = fieldsWithEntity("E8");
    const clean = await runScenario(passingWith(), { flags: IDS_FLAGS });
    const { result, recording } = await runScenario(passingWith({ fields: [bad] }), { flags: IDS_FLAGS });
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual(clean.result.outcome);
    expect(result.summary.exit_code).toBe(0);
    expect(result.bundle).not.toBeNull();
    // 段の記録は束 2 の形のやり直し 1 回を数えるだけ（段の判定・持ち越しに候補を使わない）
    expect(result.record.stages.filter((record) => record.stage === "vocabulary").map((record) => [record.status, record.retries.shape])).toEqual([
      ["ok", 0],
      ["ok", 1],
      ["ok", 0],
    ]);
    // 通る走りの診断は回ごとの行の 1 本だけ（候補が無い段のファイルは作らない。Issue #699）
    expect(diagnosticPaths(clean.result)).toEqual([DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    expect(diagnosticPaths(result)).toEqual([DIAGNOSTICS_REJECTED_VOCABULARY_FILE, DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    const candidates = rejectedOf(result, DIAGNOSTICS_REJECTED_VOCABULARY_FILE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ stage: "vocabulary", operation: null, call: 2, round: 1, attempt: 1, kind: "shape" });
    // 問題はその回に C1' が返した問題の全部（やり直しの要求の「前回の形の問題」と、欄の位置・固定文・並びまで同じ）
    const fieldsRequests = requestsOf(recording, "vocabulary-fields");
    expect(fieldsRequests).toHaveLength(2);
    expect(problemsOf(candidates[0])).toEqual(retryProblemsOf(fieldsRequests[1]));
    expect(problemsOf(candidates[0]).map((problem) => problem.message)).toContain("知らない ID である（この表で振った ID に無い）");
    await expectRawAndMetadata(candidates[0], bad);
    // 送った要求と診断に、受入の題材の言葉が無い
    expectNoAcceptanceMaterial([...recording.structured.map((request) => JSON.stringify(request)), ...result.diagnostics.map((artifact) => artifact.text)]);
  });

  it("C2 の初回の試行 1 が形で落ちて試行 2 で通る走り：rejected-mapping に候補 1 件（回 1・試行 1・その回の問題の全部）（Issue #657）", async () => {
    const missingFirst = { requirements: (good().mapping["requirements"] as readonly unknown[]).slice(1) };
    const { result, recording } = await runScenario(passingWith({ mapping: [missingFirst] }), { flags: IDS_FLAGS });
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.record.stages.filter((record) => record.stage === "mapping").map((record) => [record.status, record.retries.shape])).toEqual([["ok", 1]]);
    expect(diagnosticPaths(result)).toEqual([DIAGNOSTICS_REJECTED_MAPPING_FILE, DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    const candidates = rejectedOf(result, DIAGNOSTICS_REJECTED_MAPPING_FILE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ stage: "mapping", operation: null, call: 1, round: 1, attempt: 1, kind: "shape" });
    expect(candidates[0]).not.toHaveProperty("bundle");
    expect(problemsOf(candidates[0])).toEqual(retryProblemsOf(requestsOf(recording, "mapping")[1]));
    expect(candidates[0]?.problems.length).toBeGreaterThan(0);
    await expectRawAndMetadata(candidates[0], missingFirst);
  });

  it("C1 の束 2 が 2 回断られる走り：rejected-vocabulary に候補 2 件（束 2・試行 1・2。それぞれその回の問題の全部）（Issue #608・#657）", async () => {
    const first = fieldsWithEntity("E8");
    const last = fieldsWithEntity("E9");
    const { result, recording } = await runScenario([structured(good().entities), structured(first), structured(last)], { flags: IDS_FLAGS });
    // 段の判定・呼び出しの数・終了コードは #593 のまま
    expect(result.stopped).toMatchObject({ stage: "vocabulary", kind: "unmet" });
    expect(result.summary.exit_code).toBe(1);
    expect(result.bundle).toBeNull();
    expect(schemaNames(recording.structured)).toEqual(["vocabulary-entities", "vocabulary-fields", "vocabulary-fields"]);
    const paths = diagnosticPaths(result);
    expect(paths.filter((path) => path === DIAGNOSTICS_REJECTED_VOCABULARY_FILE)).toHaveLength(1);
    expect(paths).not.toContain(DIAGNOSTICS_REJECTED_MAPPING_FILE);
    expect(paths).not.toContain(DIAGNOSTICS_REJECTED_NAME_TABLE_FILE);
    const candidates = rejectedOf(result, DIAGNOSTICS_REJECTED_VOCABULARY_FILE);
    expect(candidates.map((candidate) => [candidate.stage, candidate.call, candidate.round, candidate.attempt])).toEqual([
      ["vocabulary", 2, 1, 1],
      ["vocabulary", 2, 1, 2],
    ]);
    expect(problemsOf(candidates[0])).toEqual(retryProblemsOf(requestsOf(recording, "vocabulary-fields")[1]));
    expect(problemsOf(candidates[1])).toEqual(stageProblemsOf(result.stopped?.problems));
    expect(candidates[1]?.problems.map((problem) => problem.message)).toContain("知らない ID である（この表で振った ID に無い）");
    await expectRawAndMetadata(candidates[0], first);
    await expectRawAndMetadata(candidates[1], last);
    // 断った候補は納品物にも要約にも入らない（一覧の要約は値なし）
    const listing = diagnosticOf(result.diagnostics, DIAGNOSTICS_LISTING_FILE)["rejected"] as readonly { stage: string; call: number; attempt: number }[];
    expect(listing.map((entry) => [entry.stage, entry.call, entry.attempt])).toEqual([
      ["vocabulary", 2, 1],
      ["vocabulary", 2, 2],
    ]);
    expect(JSON.stringify(result.summary) + JSON.stringify(result.record)).not.toContain('"E9"');
    expect(JSON.stringify(result.summary) + JSON.stringify(result.record)).not.toContain('"E8"');
  });

  it("C2 が 2 回断られる走り：rejected-mapping に候補 2 件（回 1・試行 1・2）。rejected-vocabulary は無い（Issue #608・#657）", async () => {
    const requirements = good().mapping["requirements"] as readonly unknown[];
    const missingFirst = { requirements: requirements.slice(1) };
    const missingLast = { requirements: requirements.slice(0, -1) };
    const { result, recording } = await runScenario(
      [structured(good().entities), structured(good().fields), structured(good().behaviors), structured(missingFirst), structured(missingLast)],
      { flags: IDS_FLAGS },
    );
    expect(result.stopped).toMatchObject({ stage: "mapping", kind: "unmet" });
    expect(result.summary.exit_code).toBe(1);
    expect(schemaNames(recording.structured)).toEqual(["vocabulary-entities", "vocabulary-fields", "vocabulary-behaviors", "mapping", "mapping"]);
    const paths = diagnosticPaths(result);
    expect(paths.filter((path) => path === DIAGNOSTICS_REJECTED_MAPPING_FILE)).toHaveLength(1);
    expect(paths).not.toContain(DIAGNOSTICS_REJECTED_VOCABULARY_FILE);
    expect(paths).not.toContain(DIAGNOSTICS_REJECTED_NAME_TABLE_FILE);
    const candidates = rejectedOf(result, DIAGNOSTICS_REJECTED_MAPPING_FILE);
    expect(candidates.map((candidate) => [candidate.stage, candidate.call, candidate.round, candidate.attempt])).toEqual([
      ["mapping", 1, 1, 1],
      ["mapping", 1, 1, 2],
    ]);
    // C2 は束に切らないので、候補に束の欄は無い（Issue #627）
    for (const candidate of candidates) expect(candidate).not.toHaveProperty("bundle");
    expect(problemsOf(candidates[0])).toEqual(retryProblemsOf(requestsOf(recording, "mapping")[1]));
    expect(problemsOf(candidates[1])).toEqual(stageProblemsOf(result.stopped?.problems));
    await expectRawAndMetadata(candidates[0], missingFirst);
    await expectRawAndMetadata(candidates[1], missingLast);
  });

  it("負例（R7）：一覧に無い要件 ID・表に無い行の ID を含むから断られた候補も、raw・SHA-256・問題がそのまま残る（Issue #657）", async () => {
    const requirements = good().mapping["requirements"] as readonly Record<string, unknown>[];
    const outside = {
      requirements: requirements.map((entry, index) =>
        index === 0
          ? { ...entry, requirementId: "R9" }
          : index === 1
            ? { ...entry, roles: (entry["roles"] as readonly Record<string, unknown>[]).map((role, at) => (at === 0 ? { ...role, id: "X99" } : role)) }
            : entry,
      ),
    };
    const { result, recording } = await runScenario(
      [structured(good().entities), structured(good().fields), structured(good().behaviors), structured(outside), structured(outside)],
      { flags: IDS_FLAGS },
    );
    expect(result.stopped).toMatchObject({ stage: "mapping", kind: "unmet" });
    const candidates = rejectedOf(result, DIAGNOSTICS_REJECTED_MAPPING_FILE);
    expect(candidates.map((candidate) => [candidate.call, candidate.round, candidate.attempt])).toEqual([
      [1, 1, 1],
      [1, 1, 2],
    ]);
    // 一覧に無い ID・表に無い ID を含む raw も消さず書き換えず残す（SHA-256 は raw から計算し直した値と一致する）
    for (const candidate of candidates) {
      expect(JSON.stringify(candidate.response)).toContain('"R9"');
      expect(JSON.stringify(candidate.response)).toContain('"X99"');
      await expectRawAndMetadata(candidate, outside);
    }
    expect(problemsOf(candidates[0])).toEqual(retryProblemsOf(requestsOf(recording, "mapping")[1]));
    expect(problemsOf(candidates[1])).toEqual(stageProblemsOf(result.stopped?.problems));
    expect(candidates[1]?.problems.length).toBeGreaterThanOrEqual(2);
  });

  it("C2 の 2 回目が C2' に落ちて初回の表で持ち越す走り：rejected-mapping に round 2 の候補（問題の一覧つき）があり、持ち越し・採用した表・C3 の結果・停止しないことは変わらない（Issue #657）", async () => {
    const rejectR3 = judgments(IDS, { R3: ["unnecessary-ownership", "締められる"] });
    const missing = { requirements: (good().mapping["requirements"] as readonly unknown[]).slice(1) };
    const carried = await runScenario(
      [
        structured(good().entities),
        structured(good().fields),
        structured(good().behaviors),
        structured(good().mapping),
        structured(rejectR3),
        structured(missing),
        structured(renamed(idsT2Response([...r1Tests(), ...r4Tests()], ["R1", "R2", "R4"]))),
        structured({ declaration: RUN_YAML }),
        structured(acceptAll(["R1", "R2", "R4"])),
      ],
      { flags: IDS_FLAGS },
    );
    expect(carried.result.stopped).toBeNull();
    expect(carried.result.record.stages.filter((record) => record.stage === "mapping").map((record) => [record.status, record.failure_kind])).toEqual([
      ["ok", null],
      ["failed", "unmet"],
    ]);
    expect(countStage(carried.result, "semantic-check")).toBe(1);
    expect(carryEntriesOf(carried.result.bundle).map((entry) => entry.requirementId)).toEqual(["R3"]);
    expect(diagnosticPaths(carried.result)).toEqual([DIAGNOSTICS_REJECTED_MAPPING_FILE, DIAGNOSTICS_TABLE_ROUNDS_FILE]);
    const candidates = rejectedOf(carried.result, DIAGNOSTICS_REJECTED_MAPPING_FILE);
    expect(candidates).toHaveLength(1);
    // 2 回目は拒否された R3 だけの書き直しなので、候補は書き直した要件 1・保持した要件 3 の数を持つ（ID の値は持たない。Issue #661）
    expect(candidates[0]).toMatchObject({ stage: "mapping", operation: null, call: 2, round: 2, attempt: 1, kind: "shape", rewritten_requirements: 1, kept_requirements: 3 });
    await expectRawAndMetadata(candidates[0], missing, ["kept_requirements", "rewritten_requirements"]);
    // 問題は 2 回目の照合（R5）が返した問題の全部：R3 のほかに書いた R2・R4 の 2 件（固定文。Issue #661。直す前は C2' の問題だった）
    expect(problemsOf(candidates[0])).toEqual([
      { field: "requirements[0].requirementId", message: MAPPING_REWRITE_MESSAGES.extra },
      { field: "requirements[2].requirementId", message: MAPPING_REWRITE_MESSAGES.extra },
    ]);
    expect(candidates[0]?.problems.length).toBeGreaterThan(0);
  });

  it("形で 1 度も落ちない走り：rejected-vocabulary・rejected-mapping が無く、診断のファイルは回ごとの行の 1 本だけ（Issue #608・#657・#699）", async () => {
    const passed = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_FLAGS });
    expect(passed.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(diagnosticPaths(passed.result)).not.toContain(DIAGNOSTICS_REJECTED_VOCABULARY_FILE);
    expect(diagnosticPaths(passed.result)).not.toContain(DIAGNOSTICS_REJECTED_MAPPING_FILE);
    expect(diagnosticPaths(passed.result)).toEqual([DIAGNOSTICS_TABLE_ROUNDS_FILE]);
  });

  /**
   * (1)〜(5) の台本（上の試験と同じ応答の列）。直す前と同じであることを、段の記録・要約・LLM への要求（構造化・道具）・終了コード・
   * 納品物のファイルの一覧と各ファイル（`bundleFiles`。診断は納品物に入らない）の SHA-256 で照らす（Issue #657）
   */
  const beforeScripts = (): readonly { readonly name: string; readonly calls: readonly RecordedCall[] }[] => {
    const requirements = good().mapping["requirements"] as readonly unknown[];
    const missingFirst = { requirements: requirements.slice(1) };
    const missingLast = { requirements: requirements.slice(0, -1) };
    const vocabulary = () => [structured(good().entities), structured(good().fields), structured(good().behaviors)];
    return [
      { name: "(1) C1 の束 2 の初回が形で落ちてやり直しで通る", calls: passingWith({ fields: [fieldsWithEntity("E8")] }) },
      { name: "(2) C2 の試行 1 が形で落ちて試行 2 で通る", calls: passingWith({ mapping: [missingFirst] }) },
      {
        name: "(3) C2 の 2 回目が C2' に落ちて初回の表で持ち越す",
        calls: [
          ...vocabulary(),
          structured(good().mapping),
          structured(judgments(IDS, { R3: ["unnecessary-ownership", "締められる"] })),
          structured(missingFirst),
          structured(renamed(idsT2Response([...r1Tests(), ...r4Tests()], ["R1", "R2", "R4"]))),
          structured({ declaration: RUN_YAML }),
          structured(acceptAll(["R1", "R2", "R4"])),
        ],
      },
      { name: "(4) C2 が 2 回落ちて止まる", calls: [...vocabulary(), structured(missingFirst), structured(missingLast)] },
      { name: "(4) C1 の束 2 が 2 回落ちて止まる", calls: [structured(good().entities), structured(fieldsWithEntity("E8")), structured(fieldsWithEntity("E9"))] },
      { name: "(5) 形で 1 度も落ちない", calls: [...idsHead(), structured(acceptAll())] },
    ];
  };
  /**
   * 直す前の値：main の a61f2ce（直す前の run.ts・bundle.ts）で上の台本を流して測った SHA-256（記録・要約・要求・終了コード・納品物の順。
   * 各値は `JSON.stringify` した値の SHA-256。新しい run.ts の出力から作っていない。Issue #657）。
   *
   * **LLM への要求の SHA-256（3 番目）だけ、Issue #682・#690 で取り直した**（#682 は base d38e132 に #682 の変更を重ねた作業木、
   * #690 は base 9557d25 に #690 の変更を重ねた作業木で上の台本を流して測った値。旧の値は各行の注に残す）。理由：#690 は C2 の
   * 規則 R-map-03 の文に「当たる種類が無い要件を structural にしない」を足したため（#682 は R-map-03 の文と C2 の schema の変更の
   * ため）。C2 を呼ばない (4) C1 の束 2 が 2 回落ちて止まる台本は取り直していない。記録・要約・終了コード・納品物の SHA-256 は
   * 直す前の値のまま照らす。Issue #661 で (3) の要求の SHA-256 だけを取り直した（base 8557109 に #661 の変更を重ねた作業木で
   * 測った値）。理由：C3 の拒否のあとの C2 の 2 回目の要求を、拒否された要件だけの書き直し（部分専用の規則・「書き直す要件」）にしたため。
   *
   * **T2 に届く (1)(2)(3)(5) の要約・要求・納品物の SHA-256 は、#650 の T2 の手（手 3d〜3i・4c〜4e。統合 v12-h3e で main b018140 に
   * 合流）で取り直した**（v12-h3e の作業木で上の台本を流して測った値。旧の値は各行の注に残す）。理由：旗 ids の T2 の応答が場合の形に
   * なり（台本 (3) の T2 も構造の要件 R2 の試験を書かない場合の形に替えた）、要約に v12_calls.test_spec（束の要約）が足され、T2 と
   * B1 の要求・T2 由来の納品物が変わるため。main b018140 の作業木で同じ台本を流した出力と突き合わせ、要約の差は v12_calls.test_spec
   * だけ、要求の差は T2 と B1 の 2 本だけ（C1・C2・C3 の要求は同じ）、納品物の差は T2 由来のファイルと manifest だけであることを
   * 確かめた。記録・終了コードの SHA-256 と、T2 に届かない (4) の 2 台本は直す前の値のまま照らす
   */
  const BEFORE_DIGESTS: Readonly<Record<string, readonly string[]>> = {
    "(1) C1 の束 2 の初回が形で落ちてやり直しで通る": [
      "865511262ad4b1eec243d96a87d5716fa5dac5794bcc0967769bd9fda0974edc",
      // 要約の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 e43bf01d37bdb469dae6dd6190e30e489618ada887c17db2fe2c1eab98c9f680）
      // 要約の SHA-256 は Issue #735 で取り直した（v12_calls に C3 の束の欄 semantic_check を足したため。その欄を外すと旧の値に戻る＝`BEFORE_735`。旧 5c064c0fca66daff785b9cddf84e051ee45ea3a7bb7471bcd953e8b16bfbb927）
      "68ef6a89239bdc818759f7cac71e164122fe07351e47230cdaaa473bf22c9665",
      // 要求の SHA-256 は Issue #682・#690 で取り直した（旧 #682 752a0c66bd0921ddef70aae2a4b6a1c70b012d6003a14dccbd94bd006493e24e、#682 の前 a0093fffd46e0316db7a39788e7bc23cdbd879e9440dc900394944b4634643e3）
      // 要求の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 aa61d49da041316d61a2363ad590036a1486361eba20d106a56b7a821b1e83b5）
      // 要求の SHA-256 は Issue #724 で取り直した（C2 の checks の欄を対象の並びにし R-map-03 の文を直したため。旧 7672dc5e7cc5bb29c6e9add669a90c45a22da87b4de55a9169aafbfefc45c9fb）
      // 要求の SHA-256 は Issue #725 で取り直した（旗 ids と ledger が on の C2 のデータに台帳の未対応の観測の塊を足し、台帳版の R-map-03 の文を直したため。旧 a0e42ef4f3de48221fad469acf72b29e550d33ad7488101326d496a754a49ac6）
      // 要求の SHA-256 は Issue #732 で取り直した（旗 ids on の C3 の R-sc-02 に構造の検査の読み方の文を足したため。その文を外すと旧の値に戻る＝`BEFORE_732_REQUESTS`。旧 75f57eff2d977c6b6c8b71930987722c5e26076cc8d5d0dae2a06a4868e911a4）
      // 要求の SHA-256 は Issue #663 で取り直した（旗 ids on の T2 の R-tsp-02 に要件ごとの試験の上限の文を足したため。その文を外すと旧の値に戻る＝`BEFORE_663_REQUESTS`。旧 11ca852ea32e6f3085c5cf91987ba986e9561aea6a442458ea408d2ce851de80）
      "23e96f59c9b15af3b01e23a7b81c879a139b7776c1e0e6a823739e637b1c0852",
      "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
      // 納品物の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 d3d46bd0bae1ed1bce66a419612e4d05b1d6d0cefa9b95072d2af39c8137d700）
      // 納品物の SHA-256 は Issue #735 で取り直した（要約のファイルと manifest が変わるため。要約の欄を外して manifest を計算し直すと旧の値に戻る＝`BEFORE_735`。旧 ef2dc4cd77f101896bc8c4c377efeabe8f621d092497fdef0ee93b69490e031f）
      "e575ee2943955e7458a1a6cc6270e8967300299f9af4df9db4e8f38785f494f1",
    ],
    "(2) C2 の試行 1 が形で落ちて試行 2 で通る": [
      "771d2acf15b3903ea4b81cd6e6fb4cd6d4600944a807484c985dacbb6128e7e6",
      // 要約の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 b00502771c9776d7ca5699650d826e5e619f6d2f9688d728ba3adcec07d2d536）
      // 要約の SHA-256 は Issue #735 で取り直した（v12_calls に C3 の束の欄 semantic_check を足したため。その欄を外すと旧の値に戻る＝`BEFORE_735`。旧 e2cfd686f2296c3ff2a5f91bb45409dbb6efbc02feb54b7e246af97eaf762089）
      "e3d7a7c0ddc54deec945cf292f2a0311b13f829390b9cdadc8b1022906e5107f",
      // 要求の SHA-256 は Issue #682・#690 で取り直した（旧 #682 8921cc36209615b5948b4830e79f7b8ed1cab4c38fe1751b1825b28ff2d149e1、#682 の前 6c3f9e9cf8c384b59958beb5300a3fc50847416fbfd411fb63f2c876e239a18d）
      // 要求の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 2c75ec3f7e097736f78a181425c7360fab93d01e3571468dbcb793f2b8c60e0a）
      // 要求の SHA-256 は Issue #724 で取り直した（C2 の checks の欄を対象の並びにし R-map-03 の文を直したため。旧 5bccc6c03cf22bcd5bd9ce8ee9ddb7ecdc5987f4fa4d3a7d744db156fb7488fc）
      // 要求の SHA-256 は Issue #725 で取り直した（旗 ids と ledger が on の C2 のデータに台帳の未対応の観測の塊を足し、台帳版の R-map-03 の文を直したため。旧 d6db3501d82e82b7dbe13920732e1c256b53866bca4f79a115719448695213d6）
      // 要求の SHA-256 は Issue #732 で取り直した（旗 ids on の C3 の R-sc-02 に構造の検査の読み方の文を足したため。その文を外すと旧の値に戻る＝`BEFORE_732_REQUESTS`。旧 9e19ad5d99fa79745564a69adff2c76e4f54b63e940f2bede3a2a614824c775b）
      // 要求の SHA-256 は Issue #663 で取り直した（旗 ids on の T2 の R-tsp-02 に要件ごとの試験の上限の文を足したため。その文を外すと旧の値に戻る＝`BEFORE_663_REQUESTS`。旧 a61b8eb44bff4d25b0770176166625d28060dfa421594be3033ff047f10b3634）
      "fca5a4eeaad8ab62b049891ea21784f097cc9f715f7ffe27fdf3fa46f2f84179",
      "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
      // 納品物の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 c479ec4fc3ac733a9b470499f5d8fc631583a94ca9e4169834ae571ea7499645）
      // 納品物の SHA-256 は Issue #735 で取り直した（要約のファイルと manifest が変わるため。要約の欄を外して manifest を計算し直すと旧の値に戻る＝`BEFORE_735`。旧 a3848402cdf1bbedbdbb51431bd971ccc94a351d6bfb88ae7a9f56054cdec635）
      "c8be607630dff4415097005dc4019066d50b3cc43426793be2d2dbbc925fb676",
    ],
    "(3) C2 の 2 回目が C2' に落ちて初回の表で持ち越す": [
      "c2a1c208a549dd9320f05ca078149cff2c691f163c9de1ef9a53da25426de89c",
      // 要約の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 dfc45b40f4d4f5e04af357295a853c5d69847dc2aa260f2af52e0b08713eab11）
      // 要約の SHA-256 は Issue #735 で取り直した（v12_calls に C3 の束の欄 semantic_check を足したため。その欄を外すと旧の値に戻る＝`BEFORE_735`。旧 d4cbdb12c8d1cc33003d93b358776fb2a658517f595324bc13dd076faac0f01f）
      "4b521a13c9199048e8f1c4ea507c5e2fa114baf0a4df5fd74319790204f6796a",
      // 要求の SHA-256 は Issue #682・#690・#661 で取り直した（旧 #690 cc1e636756802ca79ef535edbff41302442ab15d70561042106c644d88cf75ce、
      // 旧 #682 f2f3aa9dc28f4b4fc536c18ea4dfae4e38cda3bfdf07d26524b8526c91674c2d、#682 の前 6af97b9e827e24b9d14505ee677d3b15af2f3e3615d6f448b90f818b8d8e061b）。
      // #661 は C2 の 2 回目の要求（部分専用の規則と「書き直す要件」）だけが変わる。それを外した要求は直す前と同じ（下の試験）
      // 要求の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 7aa71911309b5ef91f9c680ac454d31ca2a49fe63156cbbb6f1314476b3b94bd）
      // 要求の SHA-256 は Issue #724 で取り直した（C2 の checks の欄を対象の並びにし R-map-03 の文を直したため。旧 dd5f9cf02049d7f833e5a99599915ce35b0b4296b5d512535c641e5d0d71e984）
      // 要求の SHA-256 は Issue #725 で取り直した（旗 ids と ledger が on の C2 のデータに台帳の未対応の観測の塊を足し、台帳版の R-map-03 の文を直したため。旧 351709d5e31e65fc7e15cb2c289bfdb67db83c5d8d4aa1fdb8415153dad8bfd9）
      // 要求の SHA-256 は Issue #732 で取り直した（旗 ids on の C3 の R-sc-02 に構造の検査の読み方の文を足したため。その文を外すと旧の値に戻る＝`BEFORE_732_REQUESTS`。旧 298a1512256d852b1a484e660db51a2d58e39922bc0e9d9a1dd1bbe7acb25f21）
      // 要求の SHA-256 は Issue #663 で取り直した（旗 ids on の T2 の R-tsp-02 に要件ごとの試験の上限の文を足したため。その文を外すと旧の値に戻る＝`BEFORE_663_REQUESTS`。旧 37d215a03b3d1fb251479e18ff68b18cba8c3ba4bb473c2667e0bd44e480192c）
      "c71bc450115d4e4bcefe329eac1ef6280b6f20fc155782ab881cda8368fe8b9d",
      "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
      // 納品物の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 2f032bbaf50ff8e7c6c0fbe9708107eb043cca23ae2bc5b6b25680e7c2f4151a）
      // 納品物の SHA-256 は Issue #735 で取り直した（要約のファイルと manifest が変わるため。要約の欄を外して manifest を計算し直すと旧の値に戻る＝`BEFORE_735`。旧 f039481b055d8d893ee5535d5b56acc5182d6e5b392c8c4f3a21c4632403f859）
      "5bb0dd43d3dfd24dff1251fb46f241b30ae10949a4a360e1b8a9ad5c92f81963",
    ],
    "(4) C2 が 2 回落ちて止まる": [
      "14927cf4ff8e5b827eb9f11391b5c422f6b789ccb1ff6878608c6cc351fa25c1",
      "62a0d8984a6a06d59674e2a3daf142cbf34425567d43c37c53461d94613f8a8e",
      // 要求の SHA-256 は Issue #682・#690 で取り直した（旧 #682 efcc74edb8bc0ab3a4c540f0d6fe4074f5299cd5cb144f5576c54621df7863a2、#682 の前 0ed4f413a0be74f4140a5d04d48728660796a4de535442589ae78af2b53120ff）
      // 要求の SHA-256 は Issue #724 で取り直した（C2 の checks の欄を対象の並びにし R-map-03 の文を直したため。旧 2c5b83f0e36a0e8c094b261f4b27b11de51a3ff4b7b97c9e1eac0eccfc65bd9f）
      // 要求の SHA-256 は Issue #725 で取り直した（旗 ids と ledger が on の C2 のデータに台帳の未対応の観測の塊を足し、台帳版の R-map-03 の文を直したため。旧 17aea3149d429ba13dc0352224871fe191084f6459d9a83cc6d355534d6e24bc）
      "f82fa77127b88ffcb12ca79f150cbe0d16438e055cc543503e8f44b8c83181f5",
      "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    ],
    "(4) C1 の束 2 が 2 回落ちて止まる": [
      "191c0f74c9fc3a2b07234379b3c6f2e9f99e36f7300804c0325cd1f126763e58",
      "e56ba79e38dfcd5bfdde73a5eb04a9477d643dbba57c5cffc1d6194da3d8944d",
      "882bb500255319f88365477cde3e9958000907bcc6577af6a79d528473dc0f95",
      "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    ],
    "(5) 形で 1 度も落ちない": [
      "8a7be5d0b40243e22114d434e400f45dc55ff41add9d357888593eaa4d460aea",
      // 要約の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 88b91fbfc4f9030c40c8d0052d630afe65b86255f8242dbae174a000086e0e56）
      // 要約の SHA-256 は Issue #735 で取り直した（v12_calls に C3 の束の欄 semantic_check を足したため。その欄を外すと旧の値に戻る＝`BEFORE_735`。旧 14b868bfb4d6b944e2419cae0411c22b0f983c23a5ef1c7e47fc4424d7e6a298）
      "958e1dcb2de103b1d9358ed0e7af7bf6b7918a6478c15dfb0c9e5930d21f69ae",
      // 要求の SHA-256 は Issue #682・#690 で取り直した（旧 #682 46f31a920a94f54c37b32fedb8e771028ecfa6e6a6b7789133d3c11101c04deb、#682 の前 5b4777c8abe5dcdfa274689e1ff8083e1c610a80180c54792f668d1dda010e1c）
      // 要求の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 b05e55ebd15b607f7c856b6fa50c7ff31d54ae87005478ad294c825c14bab561）
      // 要求の SHA-256 は Issue #724 で取り直した（C2 の checks の欄を対象の並びにし R-map-03 の文を直したため。旧 9d0407679405956fb7d3d5ba4707f720cde73e174fa2a6c4f9a966c2929c8560）
      // 要求の SHA-256 は Issue #725 で取り直した（旗 ids と ledger が on の C2 のデータに台帳の未対応の観測の塊を足し、台帳版の R-map-03 の文を直したため。旧 d90c255d8438f58a29992f777751860ea34175f12bd2745be699ce7ee1fcba47）
      // 要求の SHA-256 は Issue #732 で取り直した（旗 ids on の C3 の R-sc-02 に構造の検査の読み方の文を足したため。その文を外すと旧の値に戻る＝`BEFORE_732_REQUESTS`。旧 700a9fd50ba0cbe0641af1e0bbb175347a6fc7042917a733be759068ec318cae）
      // 要求の SHA-256 は Issue #663 で取り直した（旗 ids on の T2 の R-tsp-02 に要件ごとの試験の上限の文を足したため。その文を外すと旧の値に戻る＝`BEFORE_663_REQUESTS`。旧 a8445592525ce05b953014bcc300b19b10bd6e4a8361d10c34ec79d20412452d）
      "f194a77e72fc71d29fb2d45966a2934dd85d47c7f74c7ad597811208892ee273",
      "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
      // 納品物の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（旧 d762715a3037b44cbc202848f40b5fa2cd1551bba549bd418f56fefc0e9def0e）
      // 納品物の SHA-256 は Issue #735 で取り直した（要約のファイルと manifest が変わるため。要約の欄を外して manifest を計算し直すと旧の値に戻る＝`BEFORE_735`。旧 4a2626d7964d9f231142488d8151d75f3c36d8ef216d65f06c6fb63bc8a102ab）
      "b9cdc24d6836b26f9d42b07c9185319786fc91c8d9b8eeef6704ad7982722a4e",
    ],
  };

  /**
   * 直す前の値：(4) の止まる 2 台本の diagnostics/materials.json から rejected の鍵だけを外した残りの SHA-256（main の a61f2ce の
   * run.ts・bundle.ts で測った値。ほかの台本は materials.json を出さない。新しい run.ts の出力から作っていない。Issue #657）
   */
  /**
   * 直す前の値：(3) の台本の要求から C2 の 2 回目の要求（6 本目の構造化の要求）を外した残りの SHA-256（base 8557109 の mapping.ts・
   * run.ts に戻した作業木で測った値。新しいコードの出力から作っていない。Issue #661）
   */
  // #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（T2 と B1 の要求が変わるため。v12-h3e の作業木で測った値。旧 cc800c696c72a5ba2708099d2be1125c0238c95dce8fc9d2255975e9c2960f1c）
  // Issue #724 で取り直した（初回の C2 の要求の規則と schema が変わるため。旧 865603b1b7822c4a8a1e5f9ce348fa1d2ae57f6a29a00270b3893f7740d5cb95）
  // Issue #725 で取り直した（旗 ids と ledger が on の初回の C2 の要求のデータに台帳の未対応の観測の塊を足し、台帳版の R-map-03 の文を直したため。旧 f557b06dfea31a88264e5db7aacb66068a3f61398e4571fcd760ccfccfe8cb37）
  const BEFORE_THIRD_REQUESTS_WITHOUT_SECOND_MAPPING = "b8760480b88790bfbe174c310a95b59f04edf06e0c921d47a7413a4ee0ce0397";
  /**
   * 直す前の値：上の台本の要求から C2 の要求（schemaName が mapping のもの）を全部外した残りの SHA-256（base 2c514cf の mapping.ts・
   * names.ts・generated-tests.ts・fixtures.ts に戻した作業木で測った値。新しいコードの出力から作っていない。Issue #724）。#724 で要求の
   * SHA-256 を取り直した差が C2 の要求だけ（C1・C3・T2・B1 の要求は同じ）であることを照らす
   */
  const BEFORE_REQUESTS_WITHOUT_MAPPING: Readonly<Record<string, string>> = {
    "(1) C1 の束 2 の初回が形で落ちてやり直しで通る": "fc5c8e4b4cf75e0c6a368d5ca88d06d391d6497c7ae4260c5afb5acb79cbadde",
    "(2) C2 の試行 1 が形で落ちて試行 2 で通る": "bcaf58d13fede8b1dde00b5f8665c75a4fc4a713f016ccbeb243f476cd997fee",
    "(3) C2 の 2 回目が C2' に落ちて初回の表で持ち越す": "ac126b65830f0b1d24d2321bb83a1201e8cf4856f2494fd5026934cb73d3a22f",
    "(4) C2 が 2 回落ちて止まる": "20058692a49f3b735bbc0bbfb63590e41c9eb4f522d84ec5943238632d4ac8e5",
    "(4) C1 の束 2 が 2 回落ちて止まる": "882bb500255319f88365477cde3e9958000907bcc6577af6a79d528473dc0f95",
    "(5) 形で 1 度も落ちない": "bcaf58d13fede8b1dde00b5f8665c75a4fc4a713f016ccbeb243f476cd997fee",
  };

  /**
   * Issue #732 の前の値：上の台本の LLM への要求の SHA-256（`BEFORE_DIGESTS` の 3 番目を #732 で取り直す前の値。#725 の値）。
   * #732 の要求から C3 の R-sc-02 の構造の検査の読み方の文（`withoutIdsReading`）を外すとこの値に戻ることを照らす
   */
  const BEFORE_732_REQUESTS: Readonly<Record<string, string>> = {
    "(1) C1 の束 2 の初回が形で落ちてやり直しで通る": "75f57eff2d977c6b6c8b71930987722c5e26076cc8d5d0dae2a06a4868e911a4",
    "(2) C2 の試行 1 が形で落ちて試行 2 で通る": "9e19ad5d99fa79745564a69adff2c76e4f54b63e940f2bede3a2a614824c775b",
    "(3) C2 の 2 回目が C2' に落ちて初回の表で持ち越す": "298a1512256d852b1a484e660db51a2d58e39922bc0e9d9a1dd1bbe7acb25f21",
    "(4) C2 が 2 回落ちて止まる": "f82fa77127b88ffcb12ca79f150cbe0d16438e055cc543503e8f44b8c83181f5",
    "(4) C1 の束 2 が 2 回落ちて止まる": "882bb500255319f88365477cde3e9958000907bcc6577af6a79d528473dc0f95",
    "(5) 形で 1 度も落ちない": "700a9fd50ba0cbe0641af1e0bbb175347a6fc7042917a733be759068ec318cae",
  };

  /**
   * Issue #663 の前の要求の SHA-256（旧の値。#732 で取り直した値）。#663 の要求から T2 の R-tsp-02 の要件ごとの試験の上限の文
   * （`withoutIdsLimit`）を外すとこの値に戻ることを照らす。T2 に届かない (4) の 2 台本は今の値と同じ
   */
  const BEFORE_663_REQUESTS: Readonly<Record<string, string>> = {
    "(1) C1 の束 2 の初回が形で落ちてやり直しで通る": "11ca852ea32e6f3085c5cf91987ba986e9561aea6a442458ea408d2ce851de80",
    "(2) C2 の試行 1 が形で落ちて試行 2 で通る": "a61b8eb44bff4d25b0770176166625d28060dfa421594be3033ff047f10b3634",
    "(3) C2 の 2 回目が C2' に落ちて初回の表で持ち越す": "37d215a03b3d1fb251479e18ff68b18cba8c3ba4bb473c2667e0bd44e480192c",
    "(4) C2 が 2 回落ちて止まる": "f82fa77127b88ffcb12ca79f150cbe0d16438e055cc543503e8f44b8c83181f5",
    "(4) C1 の束 2 が 2 回落ちて止まる": "882bb500255319f88365477cde3e9958000907bcc6577af6a79d528473dc0f95",
    "(5) 形で 1 度も落ちない": "a8445592525ce05b953014bcc300b19b10bd6e4a8361d10c34ec79d20412452d",
  };

  /**
   * Issue #735 の前の要約と納品物の SHA-256（旧の値。上の `BEFORE_DIGESTS` の 2・5 番目を #735 で取り直す前の値）。#735 の要約から
   * v12_calls の C3 の束の欄（`revert735`）を外し、納品物の要約のファイルを同じく戻して manifest を計算し直す（`revertBundleFiles735`）と
   * この値に戻ることを照らす。C3 に届かない (4) の 2 台本は取り直していない
   */
  const BEFORE_735: Readonly<Record<string, readonly string[]>> = {
    "(1) C1 の束 2 の初回が形で落ちてやり直しで通る": ["5c064c0fca66daff785b9cddf84e051ee45ea3a7bb7471bcd953e8b16bfbb927", "ef2dc4cd77f101896bc8c4c377efeabe8f621d092497fdef0ee93b69490e031f"],
    "(2) C2 の試行 1 が形で落ちて試行 2 で通る": ["e2cfd686f2296c3ff2a5f91bb45409dbb6efbc02feb54b7e246af97eaf762089", "a3848402cdf1bbedbdbb51431bd971ccc94a351d6bfb88ae7a9f56054cdec635"],
    "(3) C2 の 2 回目が C2' に落ちて初回の表で持ち越す": ["d4cbdb12c8d1cc33003d93b358776fb2a658517f595324bc13dd076faac0f01f", "f039481b055d8d893ee5535d5b56acc5182d6e5b392c8c4f3a21c4632403f859"],
    "(5) 形で 1 度も落ちない": ["14b868bfb4d6b944e2419cae0411c22b0f983c23a5ef1c7e47fc4424d7e6a298", "4a2626d7964d9f231142488d8151d75f3c36d8ef216d65f06c6fb63bc8a102ab"],
  };

  const BEFORE_MATERIALS_DIGESTS: Readonly<Record<string, string>> = {
    "(4) C2 が 2 回落ちて止まる": "a1c6f1158b66a23deb3a2fefe0b0ea6a0c315529a826a9d67b5fad4d8960cf27",
    "(4) C1 の束 2 が 2 回落ちて止まる": "2c99823924cadb18d40b4ee932938aa9349c60dbc058806d3d9fb1258b8a61c6",
  };

  it("(1)〜(5) の台本の段の記録・要約・LLM への要求・終了コード・納品物は、直す前（a61f2ce で測った SHA-256）と同じ（Issue #657）", async () => {
    const measured: Record<string, readonly string[]> = {};
    const measuredMaterials: Record<string, string> = {};
    const measuredWithoutMapping: Record<string, string> = {};
    const measuredWithoutReading: Record<string, string> = {};
    const measuredWithoutLimit: Record<string, string> = {};
    const measuredBefore735: Record<string, readonly string[]> = {};
    const rejectedSummaries: Record<string, readonly { attempt: number; problem_count: number; messages: readonly { message: string; count: number }[] }[]> = {};
    for (const script of beforeScripts()) {
      const { result, recording } = await runScenario(script.calls, { flags: IDS_FLAGS });
      const files = result.bundle === null ? [] : bundleFiles(result.bundle).map((file) => ({ path: file.path, text: file.text }));
      // 止まる走りの診断の一覧（materials.json）は、断った候補の要約（rejected）の鍵を外した残りを照らす。rejected は下で期待を固定する
      const listing = result.diagnostics.find((artifact) => artifact.path === DIAGNOSTICS_LISTING_FILE);
      if (listing !== undefined) {
        const { rejected, ...rest } = JSON.parse(listing.text) as { readonly rejected?: readonly { attempt: number; problem_count: number; messages: readonly { message: string; count: number }[] }[] };
        measuredMaterials[script.name] = await sha256Hex(JSON.stringify(rest));
        rejectedSummaries[script.name] = rejected ?? [];
      }
      measuredWithoutMapping[script.name] = await sha256Hex(
        JSON.stringify({ structured: withoutIdsReading(withoutIdsLimit(recording.structured)).filter((request) => request.schemaName !== MAPPING_SCHEMA_NAME), tools: recording.tools }),
      );
      measured[script.name] = await Promise.all(
        [result.record, result.summary, { structured: recording.structured, tools: recording.tools }, result.summary.exit_code, files].map((value) =>
          sha256Hex(JSON.stringify(value)),
        ),
      );
      // Issue #732：C3 の R-sc-02 から構造の検査の読み方の文を外した要求は、#732 の前の要求の SHA-256 と同じ（差はその文だけ）
      measuredWithoutReading[script.name] = await sha256Hex(
        JSON.stringify({ structured: withoutIdsReading(withoutIdsLimit(recording.structured)), tools: recording.tools }),
      );
      // Issue #663：T2 の R-tsp-02 から要件ごとの試験の上限の文を外した要求は、#663 の前の要求の SHA-256 と同じ（差はその文だけ）
      measuredWithoutLimit[script.name] = await sha256Hex(JSON.stringify({ structured: withoutIdsLimit(recording.structured), tools: recording.tools }));
      // Issue #735：C3 に届いた走りの要約は v12_calls に C3 の束の欄を持ち、それを外した要約・納品物は #735 の前と同じ
      const summary735 = structuredClone(result.summary) as unknown as Record<string, any>;
      if (summary735["v12_calls"]?.["semantic_check"] !== undefined) {
        expect(summary735["v12_calls"]["semantic_check"], script.name).toEqual({
          rounds: result.record.stages.filter((record) => record.stage === "semantic-check").map((_, index) => ({ round: index + 1, bundles: 1 })),
          shape_retries: { limit: 1, used: 0, remaining: 1, by: [] },
        });
        revert735(summary735);
        measuredBefore735[script.name] = await Promise.all([summary735, await revertBundleFiles735(files)].map((value) => sha256Hex(JSON.stringify(value))));
      }
      if (recording.structured.some((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME)) {
        expect(
          recording.structured.filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME).every((request) =>
            (request.rules ?? []).some((text) => text.includes(structuralReadingText())),
          ),
          script.name,
        ).toBe(true);
      }
    }
    expect(measured).toEqual(BEFORE_DIGESTS);
    expect(measuredWithoutReading).toEqual(BEFORE_732_REQUESTS);
    expect(measuredWithoutLimit).toEqual(BEFORE_663_REQUESTS);
    expect(measuredBefore735).toEqual(BEFORE_735);
    expect(measuredMaterials).toEqual(BEFORE_MATERIALS_DIGESTS);
    expect(measuredWithoutMapping).toEqual(BEFORE_REQUESTS_WITHOUT_MAPPING);
    // Issue #725 で取り直した要求の差は、旗 ids と ledger が on の C2 の要求のデータの台帳の未対応の観測の塊（文書の塊の直後）と規則の文
    const fifth = await runScenario(beforeScripts().find((script) => script.name === "(5) 形で 1 度も落ちない")?.calls ?? [], { flags: IDS_FLAGS });
    const mapping = fifth.recording.structured.filter((request) => request.schemaName === MAPPING_SCHEMA_NAME);
    expect(mapping).toHaveLength(1);
    expect(mapping[0]?.input).toContain(`</data>\n<data name="${MAPPING_LEDGER_DATA_NAMES.unsupported}">\n`);
    expect(mapping[0]?.input.indexOf(`<data name="${MAPPING_LEDGER_DATA_NAMES.unsupported}">`)).toBeGreaterThan(mapping[0]?.input.indexOf('<data name="文書">') ?? Infinity);
    // (3) の要求の SHA-256 を Issue #661 で取り直した差は、C2 の 2 回目の要求（6 本目の構造化の要求）だけ：それを外した要求は直す前と同じ
    const third = beforeScripts().find((script) => script.name === "(3) C2 の 2 回目が C2' に落ちて初回の表で持ち越す");
    const thirdRun = await runScenario(third?.calls ?? [], { flags: IDS_FLAGS });
    expect(thirdRun.recording.structured[5]?.schemaName).toBe("mapping");
    expect(await sha256Hex(JSON.stringify({ structured: withoutIdsReading(withoutIdsLimit(thirdRun.recording.structured)).filter((_, index) => index !== 5), tools: thirdRun.recording.tools }))).toBe(
      BEFORE_THIRD_REQUESTS_WITHOUT_SECOND_MAPPING,
    );
    // rejected は、形の試行ごとの候補 2 件（attempt 1・2 の順）で、それぞれ問題の一覧（problem_count と固定文）を持つ
    expect(Object.keys(rejectedSummaries)).toEqual(Object.keys(BEFORE_MATERIALS_DIGESTS));
    for (const [name, rejected] of Object.entries(rejectedSummaries)) {
      expect(rejected.map((entry) => entry.attempt), name).toEqual([1, 2]);
      for (const entry of rejected) {
        expect(entry.problem_count, name).toBeGreaterThan(0);
        expect(entry.messages.length, name).toBeGreaterThan(0);
        expect(entry.messages.every((item) => item.message !== "" && item.count > 0), name).toBe(true);
        expect(entry.messages.reduce((total, item) => total + item.count, 0), name).toBe(entry.problem_count);
      }
    }
  });

  /**
   * 初回の形のやり直しを落ちた要件だけの書き直しにする台本（Issue #660）：R1 の所属に行に無い ID を足した初回の応答 → 2 回目の応答。
   * `rewritten` なら 2 回目は R1 だけ（書き直し）、そうでなければ全要件（直す前の全体の作り直しの台本）
   */
  const rewriteScript = (rewritten: boolean): RecordedCall[] => {
    const [entities, fields, behaviors, , ...rest] = idsHead();
    const requirements = good().mapping["requirements"] as readonly Record<string, unknown>[];
    const bad = {
      requirements: requirements.map((entry, index) =>
        index === 0 ? { ...entry, roles: [...(entry["roles"] as readonly unknown[]), { id: "X99", basis: "stated", reason: null }] } : entry,
      ),
    };
    const second = rewritten ? { requirements: requirements.filter((entry) => entry["requirementId"] === "R1") } : good().mapping;
    return [entities!, fields!, behaviors!, structured(bad), structured(second), ...rest, structured(acceptAll())];
  };
  /**
   * 差を許す欄（参照の照合の数 `references`）を、値の中から全部外す（記録・要約と、それを埋め込んだ納品物の JSON）。usage の
   * トークン・所要は、偽物の LLM（呼び出しごとに同じ usage）・固定の時計なので呼び出しの数が同じなら同じ値になり、外さない
   */
  const withoutReferences = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(withoutReferences)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "references").map(([key, inner]) => [key, withoutReferences(inner)]))
        : value;
  /** 納品物のファイル（JSON は参照の照合の数を外す。各ファイルの SHA-256 を持つ manifest は、参照の数の差がそのまま映るので path だけ） */
  const filesWithoutReferences = (files: readonly { readonly path: string; readonly text: string }[]) =>
    files.map((file) => {
      if (file.path === "bundle-manifest.json") return { path: file.path };
      try {
        return { path: file.path, json: withoutReferences(JSON.parse(file.text)) };
      } catch {
        return file;
      }
    });
  /**
   * 直す前の値：base d75c7b3 の mapping.ts・run.ts に戻した作業木（この試験のファイルは新しいもの）で `rewriteScript(false)`（2 回目は
   * 全要件）を流して測った SHA-256（参照の照合の数を外した記録・要約・終了コード・納品物・結果の順。各値は `JSON.stringify` した値の
   * SHA-256。新しいコードの出力から作っていない。Issue #660）
   */
  const BEFORE_REWRITE_DIGESTS: readonly string[] = [
    "2862685c26b5b71ffd5533075aee76793425d77d087328074b8945164dc2a7d0",
    // 要約・納品物の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（v12_calls.test_spec と T2 由来の納品物が
    // 変わるため。v12-h3e の作業木で rewriteScript(true) を流して測った値。記録・終了コード・結果は直す前の値のまま。旧 8b69576c9c7358369a3f1bd6ce933a18b4f230b0730878cdc589f8bf70169348）
    // Issue #735 で取り直した（v12_calls に C3 の束の欄 semantic_check を足したため。欄を外すと旧の値に戻る＝`BEFORE_REWRITE_735`。
    // 旧 04d39e4a16f4bfb6627abda726327d068383492ec1e3cb17eae89f93df542559）
    "89b06d4bf12520b536b2860a957db6466563c292104f32264b4e56bb0bd0697f",
    "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
    // 旧 893727d4e8b6b1b2351e49a99c42749cb03247362021e1360e877c7a6723b68e
    // Issue #735 で取り直した（要約のファイルと manifest が変わるため。要約の欄を外して manifest を計算し直すと旧の値に戻る。
    // 旧 25a4fb3cec100c9e400f6ec9ebe30f6d91ae7141a5eb5a311be67a208355494b）
    "dfcb9f2d8a94e9a049c86cc6a6d8466247a76a163e23b6b6d2a492b14106a77a",
    "739efece53a3ac3e8c4a54200572be386785198297fac5d4e3375bd44aad9b8b",
  ];

  /** Issue #735 の前の要約・納品物の SHA-256（旧の値。`BEFORE_REWRITE_DIGESTS` の 2・4 番目） */
  const BEFORE_REWRITE_735: readonly string[] = [
    "04d39e4a16f4bfb6627abda726327d068383492ec1e3cb17eae89f93df542559",
    "25a4fb3cec100c9e400f6ec9ebe30f6d91ae7141a5eb5a311be67a208355494b",
  ];
  /** Issue #735 で足した要約の C3 の束の欄を外し（`revert735`）、納品物の要約と manifest を戻した（`revertBundleFiles735`）SHA-256 */
  const before735Of = async (summary: unknown, files: readonly { readonly path: string; readonly text: string }[]): Promise<readonly string[]> => {
    const reverted = structuredClone(summary) as Record<string, any>;
    revert735(reverted);
    return Promise.all([withoutReferences(reverted), filesWithoutReferences(await revertBundleFiles735(files))].map((value) => sha256Hex(JSON.stringify(value))));
  };

  it("C2 の初回の形のやり直しが R1 だけの書き直しになる走り：段の記録の回数の欄・要約・終了コード・納品物は直す前の全体の作り直しの台本と同じで、差は参照の照合の数（初回＋書き直しの k 件）だけ。候補は書き直した要件 1・保持した要件（ほかの全部）の数（Issue #660）", async () => {
    const { result, recording } = await runScenario(rewriteScript(true), { flags: IDS_FLAGS });
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const mappingRequests = requestsOf(recording, "mapping");
    expect(mappingRequests).toHaveLength(2);
    expect(dataBlockOf(mappingRequests[1]?.input ?? "", "書き直す要件")).toEqual(["R1"]);
    const files = result.bundle === null ? [] : bundleFiles(result.bundle).map((file) => ({ path: file.path, text: file.text }));
    const measured = await Promise.all(
      [withoutReferences(result.record), withoutReferences(result.summary), result.summary.exit_code, filesWithoutReferences(files), result.outcome].map((value) => sha256Hex(JSON.stringify(value))),
    );
    expect(measured).toEqual(BEFORE_REWRITE_DIGESTS);
    // Issue #735：差は要約の C3 の束の欄（対象 4 件で束 1）とそれを載せた納品物だけ
    expect((result.summary as unknown as Record<string, any>)["v12_calls"]["semantic_check"]).toEqual({
      rounds: [{ round: 1, bundles: 1 }],
      shape_retries: { limit: 1, used: 0, remaining: 1, by: [] },
    });
    expect(await before735Of(result.summary, files)).toEqual(BEFORE_REWRITE_735);
    // 回数の欄：試行の開始 2・応答 2・形の再試行 1・中身 0
    const records = result.record.stages.filter((record) => record.stage === "mapping");
    expect(records.map((record) => [record.status, record.retries])).toEqual([["ok", { communication: 0, shape: 1, content: 0 }]]);
    // 差を許す欄の期待式：照らした＝初回の応答の参照＋書き直しの応答（R1 の 1 件）の参照。知らない ID は初回の 1 件だけ
    const roles = TABLE_IDS.ownership.reduce((total, entry) => total + entry.roles.length, 0);
    const r1Roles = TABLE_IDS.ownership.find((entry) => entry.requirementId === "R1")?.roles.length ?? 0;
    const targetsOf = (entries: NameTable["verification"]) =>
      entries.reduce((total, entry) => total + (entry.kind === "structural" ? (entry.targets ?? []).reduce((sum, target) => sum + 1 + (target.sourceId === null ? 0 : 1), 0) : 0), 0);
    const targets = targetsOf(MAPPED_IDS.verification);
    const r1Targets = targetsOf(MAPPED_IDS.verification.filter((entry) => entry.requirementId === "R1"));
    expect(records[0]?.references).toEqual({
      checked: LIST.requirements.length + roles + 1 + targets + (1 + r1Roles + r1Targets),
      unknown_ids: 1,
      duplicates: 0,
      cross_bundle_ids: 0,
    });
    // 断った候補：書き直した要件と保持した要件の数（ID の値は持たない）
    const candidates = rejectedOf(result, DIAGNOSTICS_REJECTED_MAPPING_FILE) as readonly (IdsRejected & { rewritten_requirements?: number; kept_requirements?: number })[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ stage: "mapping", call: 1, round: 1, attempt: 1, kind: "shape", rewritten_requirements: 1, kept_requirements: LIST.requirements.length - 1 });
    const { response: _response, response_sha256: _sha, problems: _problems, ...metadata } = candidates[0] as IdsRejected;
    expect(Object.keys(metadata).sort()).toEqual(["attempt", "call", "kept_requirements", "kind", "operation", "rewritten_requirements", "round", "stage"]);
    for (const value of [...LIST.requirements.map((item) => item.id), ...TABLE_IDS.rows.map((row) => row.id)]) {
      expect(JSON.stringify(metadata).includes(`"${value}"`), value).toBe(false);
    }
    expect(problemsOf(candidates[0]).map((problem) => problem.message)).toEqual(["所属の表の ID が表に無い"]);
    expectNoAcceptanceMaterial([...recording.structured.map((request) => JSON.stringify(request)), ...result.diagnostics.map((artifact) => artifact.text)]);
  });

  it("既定値の value が options の外の要件（R6）は、C2 の形のやり直し 1 回（初回は要件 6 件で束 2〔Issue #736〕。3 本目は全要件の一覧で R6 だけの書き直し）で直り、表が組まれ C3 へ進む（Issue #594・#627・#660）", async () => {
    const list = fixtureDefaultValueList();
    const table = withCodeIds(withAggregates(fixtureDefaultValueTable()));
    const good = idsResponsesOf(list, table, PROPERTY_LEDGER_VIEW);
    const outside = {
      requirements: (good.mapping["requirements"] as readonly Record<string, unknown>[]).map((entry) =>
        entry["requirementId"] === "R6" ? { ...entry, verification: { ...(entry["verification"] as Record<string, unknown>), value: "gamma" } } : entry,
      ),
    };
    const recording = createCheckedRecordingClient([
      structured(good.entities),
      structured(good.fields),
      structured(good.behaviors),
      structured(outside),
      // 問題は R6 に帰属するので、2 回目の応答は R6 だけ（Issue #660）
      structured({ requirements: (good.mapping["requirements"] as readonly Record<string, unknown>[]).filter((entry) => entry["requirementId"] === "R6") }),
      structured(acceptAll(["R1", "R2", "R3", "R4", "R6"])),
    ], { bundledC2: true, bundledC3: true });
    const outcome = await runStageRangeV11a({
      ...inputOf(recording.client, { plan: planOf(list) }),
      flags: IDS_FLAGS,
      range: { start: "name-table", end: "semantic-check" },
    });
    expect(outcome.stopped).toBeNull();
    const mappingRequests = recording.structured.filter((request) => request.schemaName === "mapping");
    const listed = (request: LlmStructuredRequest) =>
      ((dataBlockOf(request.input, "要件の一覧") as { requirements: readonly { id: string }[] }).requirements).map((requirement) => requirement.id);
    const all = ["R1", "R2", "R3", "R4", "R5", "R6"];
    expect(mappingRequests.map(listed)).toEqual([all.slice(0, 5), all.slice(5), all]);
    expect(mappingRequests[2]?.input).toContain("既定値で確かめる要件の value が、所属させた選択肢の項目の options に無い");
    expect(dataBlockOf(mappingRequests[2]?.input ?? "", "書き直す要件")).toEqual(["R6"]);
    const records = outcome.stages.filter((record) => record.stage === "mapping");
    expect(records.map((record) => [record.status, record.retries.shape])).toEqual([["ok", 1]]);
    expect(schemaNames(recording.structured).at(-1)).toBe(SEMANTIC_CHECK_SCHEMA_NAME);
  });

  it("C2' の負例：要件の欠落が 2 回続けば段 mapping・unmet で止まる。C1 は 3 束 1 回ずつ", async () => {
    const good = responses();
    const missing = { requirements: (good.mapping["requirements"] as readonly unknown[]).slice(1) };
    const { result, recording } = await runScenario(
      [structured(good.entities), structured(good.fields), structured(good.behaviors), structured(missing), structured(missing)],
      { flags: IDS_FLAGS },
    );
    expect(result.stopped).toMatchObject({ stage: "mapping", kind: "unmet" });
    expect(result.summary.exit_code).toBe(1);
    expect(result.bundle).toBeNull();
    expect(schemaNames(recording.structured)).toEqual(["vocabulary-entities", "vocabulary-fields", "vocabulary-behaviors", "mapping", "mapping"]);
  });

  it("C3 の拒否 → C2 の 2 回目（前回の写像・拒否・印をデータで。C1 は呼ばない）→ 残った拒否は持ち越し（出どころ semantic-check）", async () => {
    const good = responses();
    const rejectR3 = judgments(IDS, { R3: ["unnecessary-ownership", "締められる"] });
    const { result, recording } = await runScenario(
      [
        structured(good.entities),
        structured(good.fields),
        structured(good.behaviors),
        structured(good.mapping),
        structured(rejectR3),
        // 2 回目の応答は拒否された R3 だけの書き直し（Issue #661）
        structured({ requirements: (good.mapping["requirements"] as readonly Record<string, unknown>[]).filter((entry) => entry["requirementId"] === "R3") }),
        structured(rejectR3),
        structured(renamed(idsT2Response([...r1Tests(), ...r4Tests()], ["R1", "R2", "R4"]))),
        structured({ declaration: RUN_YAML }),
        structured(acceptAll(["R1", "R2", "R4"])),
      ],
      { flags: IDS_FLAGS },
    );
    expect(schemaNames(recording.structured).slice(0, 7)).toEqual([
      "vocabulary-entities",
      "vocabulary-fields",
      "vocabulary-behaviors",
      "mapping",
      SEMANTIC_CHECK_SCHEMA_NAME,
      "mapping",
      SEMANTIC_CHECK_SCHEMA_NAME,
    ]);
    const second = recording.structured[5];
    const rejections = dataBlockOf(second?.input ?? "", "表の点検の拒否") as { requirementId: string; kind: string }[];
    expect(rejections).toEqual([expect.objectContaining({ requirementId: "R3", kind: "unnecessary-ownership" })]);
    expect(dataBlockOf(second?.input ?? "", "前回の写像")).toEqual(good.mapping);
    expect(dataBlockOf(second?.input ?? "", "助言の印")).toBeDefined();
    expect(dataBlockOf(second?.input ?? "", "書き直す要件")).toEqual(["R3"]);
    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).toBe("partial");
    expect(carryEntriesOf(result.bundle)).toEqual([{ requirementId: "R3", reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] }]);
    expect(countStage(result, "mapping")).toBe(2);
    const mappingRecords = result.record.stages.filter((record) => record.stage === "mapping");
    expect(mappingRecords[1]?.retries.content).toBe(1);
  });

  it("C2 の 2 回目が C2' に落ちても形の再試行は無く、前回の写像のまま拒否の要件を持ち越す", async () => {
    const good = responses();
    const rejectR3 = judgments(IDS, { R3: ["unnecessary-ownership", "締められる"] });
    const missing = { requirements: (good.mapping["requirements"] as readonly unknown[]).slice(1) };
    const { result, recording } = await runScenario(
      [
        structured(good.entities),
        structured(good.fields),
        structured(good.behaviors),
        structured(good.mapping),
        structured(rejectR3),
        structured(missing),
        structured(renamed(idsT2Response([...r1Tests(), ...r4Tests()], ["R1", "R2", "R4"]))),
        structured({ declaration: RUN_YAML }),
        structured(acceptAll(["R1", "R2", "R4"])),
      ],
      { flags: IDS_FLAGS },
    );
    // C2 の 2 回目は 1 回だけ（形の再試行なし）。C3 の再点検は呼ばない（前回の点検の結果のまま）
    expect(schemaNames(recording.structured).slice(0, 7)).toEqual([
      "vocabulary-entities",
      "vocabulary-fields",
      "vocabulary-behaviors",
      "mapping",
      SEMANTIC_CHECK_SCHEMA_NAME,
      "mapping",
      TEST_SPEC_SCHEMA_NAME,
    ]);
    expect(result.stopped).toBeNull();
    expect(carryEntriesOf(result.bundle)).toEqual([{ requirementId: "R3", reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] }]);
    const table = artifactOf(result.bundle, "artifacts/name-table.json") as { readonly table_sha256: string };
    expect(table.table_sha256).toBe(await nameTableSha256(MAPPED_IDS));
  });

  /**
   * C3 の拒否のあとの 2 回目を拒否された要件だけの書き直しにする台本（Issue #661）。C3 の 1 回目は R3・R4 を拒否する（種類は違う。
   * 持ち越しても残る行が壊れない要件）
   */
  const REJECT_R3_R4 = { R3: ["unnecessary-ownership", "締められる"], R4: ["weak-verification", "全体の率"] } as const;
  const mappingEntries = () => good().mapping["requirements"] as readonly Record<string, unknown>[];
  const onlyEntries = (...ids: readonly string[]) => ({ requirements: mappingEntries().filter((entry) => ids.includes(entry["requirementId"] as string)) });
  /** 分類を入れ替えた entry（C2' は通る。2 回目の部分の結果が表に混ざったかを見分ける印） */
  const flipped = (id: string) => {
    const entry = mappingEntries().find((item) => item["requirementId"] === id) as Record<string, unknown>;
    return { ...entry, nature: entry["nature"] === "ruled" ? "existence-only" : "ruled" };
  };
  const vocabularyCalls = () => [structured(good().entities), structured(good().fields), structured(good().behaviors)];
  /** 残る要件だけの T2・B1・B3' の応答 */
  const tailFor = (remaining: readonly string[]) => [
    structured(renamed(idsT2Response([...(remaining.includes("R1") ? r1Tests() : []), ...(remaining.includes("R3") ? r3Tests() : []), ...(remaining.includes("R4") ? r4Tests() : [])], remaining))),
    structured({ declaration: RUN_YAML }),
    structured(acceptAll(remaining)),
  ];
  /** C3 の要求の対象（「要件の文と引用」の要件 ID） */
  const semanticTargetsOf = (request: LlmStructuredRequest | undefined) =>
    (dataBlockOf(request?.input ?? "", "要件の文と引用") as readonly { requirementId: string }[]).map((entry) => entry.requirementId);

  it("二点測定（Issue #661）：C3 が R3・R4 を拒否した走りの 2 回目の要求は、書き直す要件が R3・R4 だけ。合併した表に C3 を全対象（4 件）で掛け直し、受理すれば持ち越し 0 で full。要求の数は今と同じ", async () => {
    const { result, recording } = await runScenario(
      [...vocabularyCalls(), structured(good().mapping), structured(judgments(IDS, REJECT_R3_R4)), structured(onlyEntries("R3", "R4")), structured(acceptAll()), ...tailFor(IDS)],
      { flags: IDS_FLAGS },
    );
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const mappingRequests = requestsOf(recording, "mapping");
    expect(mappingRequests).toHaveLength(2);
    expect(dataBlockOf(mappingRequests[1]?.input ?? "", "書き直す要件")).toEqual(["R3", "R4"]);
    expect(dataBlockOf(mappingRequests[1]?.input ?? "", "前回の写像")).toEqual(good().mapping);
    expect((dataBlockOf(mappingRequests[1]?.input ?? "", "表の点検の拒否") as { requirementId: string }[]).map((entry) => entry.requirementId)).toEqual(["R3", "R4"]);
    const semanticRequests = requestsOf(recording, SEMANTIC_CHECK_SCHEMA_NAME);
    expect(semanticRequests.map(semanticTargetsOf)).toEqual([[...IDS], [...IDS]]);
    expect(carryEntriesOf(result.bundle)).toEqual([]);
    const table = artifactOf(result.bundle, "artifacts/name-table.json") as { readonly table_sha256: string };
    expect(table.table_sha256).toBe(await nameTableSha256(MAPPED_IDS));
    expect(result.record.stages.filter((record) => record.stage === "mapping").map((record) => [record.status, record.retries])).toEqual([
      ["ok", { communication: 0, shape: 0, content: 0 }],
      ["ok", { communication: 0, shape: 0, content: 1 }],
    ]);
  });

  it("(2) 2 回目の C3 で R4 だけ拒否が残れば、R4 だけ持ち越し（出どころ semantic-check。今と同じ）", async () => {
    const { result } = await runScenario(
      [
        ...vocabularyCalls(),
        structured(good().mapping),
        structured(judgments(IDS, REJECT_R3_R4)),
        structured(onlyEntries("R3", "R4")),
        structured(judgments(IDS, { R4: REJECT_R3_R4.R4 })),
        ...tailFor(["R1", "R2", "R3"]),
      ],
      { flags: IDS_FLAGS },
    );
    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).toBe("partial");
    expect(carryEntriesOf(result.bundle)).toEqual([{ requirementId: "R4", reasons: [{ origin: "semantic-check", reason: "weak-verification" }] }]);
  });

  it.each([
    { label: "(3) R3・R4 以外の要件がある", second: () => ({ requirements: [...onlyEntries("R2")["requirements"], flipped("R3"), ...onlyEntries("R4")["requirements"]] }) },
    { label: "(3) R4 が無い", second: () => ({ requirements: [flipped("R3")] }) },
    { label: "(3) R3 が 2 回ある", second: () => ({ requirements: [flipped("R3"), flipped("R3"), ...onlyEntries("R4")["requirements"]] }) },
    {
      label: "(4) 合併後の C2' が落ちた（R4 の所属の ID が表に無い）",
      second: () => ({ requirements: [flipped("R3"), ...onlyEntries("R4")["requirements"].map((entry) => ({ ...entry, roles: [...(entry["roles"] as readonly unknown[]), { id: "X99", basis: "stated", reason: null }] }))] }),
    },
  ])("$label：unmet で追加の要求なし、C3 の再点検も無く、持ち越しは初回の表と初回の拒否（R3・R4）。2 回目の部分の結果は表・持ち越し・納品物・checkpoint に混ざらない", async ({ second }) => {
    const firstJudgments = judgments(IDS, REJECT_R3_R4);
    const { result, recording } = await runScenario(
      [...vocabularyCalls(), structured(good().mapping), structured(firstJudgments), structured(second()), ...tailFor(["R1", "R2"])],
      { flags: IDS_FLAGS, collectBoundaries: true },
    );
    expect(result.stopped).toBeNull();
    expect(requestsOf(recording, "mapping")).toHaveLength(2);
    expect(requestsOf(recording, SEMANTIC_CHECK_SCHEMA_NAME)).toHaveLength(1);
    expect(result.record.stages.filter((record) => record.stage === "mapping").map((record) => [record.status, record.failure_kind])).toEqual([
      ["ok", null],
      ["failed", "unmet"],
    ]);
    // 持ち越しは初回の拒否のまま（再抽選しない）
    expect(carryEntriesOf(result.bundle)).toEqual([
      { requirementId: "R3", reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] },
      { requirementId: "R4", reasons: [{ origin: "semantic-check", reason: "weak-verification" }] },
    ]);
    // 採用した表は初回の表（2 回目の R3 の分類の入れ替えは混ざらない）
    const table = artifactOf(result.bundle, "artifacts/name-table.json") as { readonly table_sha256: string };
    expect(table.table_sha256).toBe(await nameTableSha256(MAPPED_IDS));
    const boundary = result.boundaries?.find((entry) => entry.boundary === "t1-t2");
    expect(boundary?.table).toEqual(MAPPED_IDS);
    expect(boundary?.semanticCheck.tableSha256).toBe(await nameTableSha256(MAPPED_IDS));
    expect(boundary?.semanticCheck.judgments.map((judgment) => [judgment.requirementId, judgment.verdict])).toEqual(
      firstJudgments.judgments.map((judgment) => [judgment.requirementId, judgment.verdict]),
    );
    expect(boundary?.carryOver.entries.map((entry) => entry.requirementId)).toEqual(["R3", "R4"]);
    // 納品物（診断を除く）に 2 回目の部分の印（X99）が無い
    const files = result.bundle === null ? [] : bundleFiles(result.bundle);
    expect(files.some((file) => file.text.includes("X99"))).toBe(false);
    // 断った候補は回 2・試行 1 の 1 件で、書き直した要件 2・保持した要件 2
    const candidates = rejectedOf(result, DIAGNOSTICS_REJECTED_MAPPING_FILE) as readonly (IdsRejected & { rewritten_requirements?: number; kept_requirements?: number })[];
    expect(candidates.map((candidate) => [candidate.call, candidate.round, candidate.attempt, candidate.rewritten_requirements, candidate.kept_requirements])).toEqual([[2, 2, 1, 2, 2]]);
  });

  it("(6) C3 の 2 回目の対象は、2 回目に採用した表から今の導き方で導く：書き直した R3 が unresolved に変われば除かれる（R1・R2・R4）", async () => {
    const constraintId = [...constraintIdsIn(FIXTURE_DOCUMENTS)][0] as string;
    const unresolved = (id: string) => ({ ...flipped(id), nature: mappingEntries().find((entry) => entry["requirementId"] === id)?.["nature"], verification: { kind: "unresolved", value: null, reason: "宣言で書けない", checks: null, constraintIds: [constraintId] } });
    const { result, recording } = await runScenario(
      [...vocabularyCalls(), structured(good().mapping), structured(judgments(IDS, REJECT_R3_R4)), structured({ requirements: [unresolved("R3"), ...onlyEntries("R4")["requirements"]] }), structured(acceptAll(["R1", "R2", "R4"])), ...tailFor(["R1", "R2", "R4"])],
      { flags: IDS_FLAGS },
    );
    expect(requestsOf(recording, SEMANTIC_CHECK_SCHEMA_NAME).map(semanticTargetsOf)).toEqual([[...IDS], ["R1", "R2", "R4"]]);
    expect(result.stopped).toBeNull();
    expect(carryEntriesOf(result.bundle).map((entry) => entry.requirementId)).toEqual(["R3"]);
  });

  it("(6) 全件を拒否し、2 回目で全件が unresolved になれば、C3 の 2 回目は呼び出し 0 で、今までどおり全件持ち越しで止まる", async () => {
    const constraintId = [...constraintIdsIn(FIXTURE_DOCUMENTS)][0] as string;
    const allRejected = judgments(IDS, { R1: ["unnecessary-ownership", "金額"], R2: ["unnecessary-ownership", "担当者の名前"], ...REJECT_R3_R4 });
    const unresolvedAll = { requirements: mappingEntries().map((entry) => ({ ...entry, verification: { kind: "unresolved", value: null, reason: "宣言で書けない", checks: null, constraintIds: [constraintId] } })) };
    const { result, recording } = await runScenario([...vocabularyCalls(), structured(good().mapping), structured(allRejected), structured(unresolvedAll)], { flags: IDS_FLAGS });
    expect(requestsOf(recording, "mapping")).toHaveLength(2);
    expect(requestsOf(recording, SEMANTIC_CHECK_SCHEMA_NAME)).toHaveLength(1);
    expect(dataBlockOf(requestsOf(recording, "mapping")[1]?.input ?? "", "書き直す要件")).toEqual([...IDS]);
    expect(result.stopped).toMatchObject({ stage: "carry-over", kind: "unmet" });
  });

  /**
   * 直す前の値（Issue #661）：base 8557109 の mapping.ts・run.ts に戻した作業木（この試験のファイルは新しいもの）で、2 回目に全要件を
   * 返す台本（`rejectedRewriteScript(false)`）を流して測った SHA-256（参照の照合の数を外した記録・要約・終了コード・納品物・結果の順。
   * 新しいコードの出力から作っていない）
   */
  const BEFORE_REJECTED_REWRITE_DIGESTS: readonly string[] = [
    "713f28ac68a1035a0d2607c26174c258e4a6b55141b54a7edcfa7910522ef3ca",
    // 要約・納品物の SHA-256 は #650 の T2 の手（v12-h3e で main b018140 に合流）で取り直した（v12_calls.test_spec と T2 由来の納品物が
    // 変わるため。v12-h3e の作業木で rejectedRewriteScript(true) を流して測った値。記録・終了コード・結果は直す前の値のまま。旧 c8b6c68bc512ffd4c88d2217851d5840e169f44057aa59dce9502e6174c18bbd）
    // Issue #735 で取り直した（v12_calls に C3 の束の欄 semantic_check を足したため。欄を外すと旧の値に戻る＝`BEFORE_REJECTED_REWRITE_735`。
    // 旧 94c7718732facc7cef9f646bf0084b63c0a3d566e8177a53461674ce50dbdc05）
    "89cfe170cb494d2ddae92106d575526c860ca78bef08c6a7caa78b4cf64d3fce",
    "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
    // 旧 5c49f248dff4909035db2744ec4ff9f3e2411c2b9212d5dafe0dd5e2aa3bf9fd
    // Issue #735 で取り直した（要約のファイルと manifest が変わるため。旧 69aa0349e676c5135e8707abb9d60f831d5c672a71adf496d48abdbe64284553）
    "107da3cb08b3c8442fff317c7e8e17103854c50573d7eb9079cd5c7e24d66cae",
    "739efece53a3ac3e8c4a54200572be386785198297fac5d4e3375bd44aad9b8b",
  ];
  /** Issue #735 の前の要約・納品物の SHA-256（旧の値。`BEFORE_REJECTED_REWRITE_DIGESTS` の 2・4 番目） */
  const BEFORE_REJECTED_REWRITE_735: readonly string[] = [
    "94c7718732facc7cef9f646bf0084b63c0a3d566e8177a53461674ce50dbdc05",
    "69aa0349e676c5135e8707abb9d60f831d5c672a71adf496d48abdbe64284553",
  ];
  /** C3 が R3 を拒否した走りの 2 回目：`rewritten` なら R3 だけ（書き直し）、そうでなければ全要件（直す前の全体の作り直しの台本） */
  const rejectedRewriteScript = (rewritten: boolean): RecordedCall[] => [
    ...vocabularyCalls(),
    structured(good().mapping),
    structured(judgments(IDS, { R3: REJECT_R3_R4.R3 })),
    structured(rewritten ? onlyEntries("R3") : good().mapping),
    structured(acceptAll()),
    ...tailFor(IDS),
  ];

  it("記録（R6・Issue #661）：2 回目が R3 だけの書き直しになる走りの段の記録の回数の欄・要約・C3 の記録の回数・終了コード・納品物は直す前の全体の作り直しの台本と同じで、差は参照の照合の数（2 回目は R3 の 1 件）だけ。候補は無い", async () => {
    const { result, recording } = await runScenario(rejectedRewriteScript(true), { flags: IDS_FLAGS });
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(dataBlockOf(requestsOf(recording, "mapping")[1]?.input ?? "", "書き直す要件")).toEqual(["R3"]);
    const files = result.bundle === null ? [] : bundleFiles(result.bundle).map((file) => ({ path: file.path, text: file.text }));
    const measured = await Promise.all(
      [withoutReferences(result.record), withoutReferences(result.summary), result.summary.exit_code, filesWithoutReferences(files), result.outcome].map((value) => sha256Hex(JSON.stringify(value))),
    );
    expect(measured).toEqual(BEFORE_REJECTED_REWRITE_DIGESTS);
    // Issue #735：差は要約の C3 の束の欄（2 回の点検とも対象 4 件で束 1）とそれを載せた納品物だけ
    expect((result.summary as unknown as Record<string, any>)["v12_calls"]["semantic_check"]).toEqual({
      rounds: [
        { round: 1, bundles: 1 },
        { round: 2, bundles: 1 },
      ],
      shape_retries: { limit: 1, used: 0, remaining: 1, by: [] },
    });
    expect(await before735Of(result.summary, files)).toEqual(BEFORE_REJECTED_REWRITE_735);
    const records = result.record.stages.filter((record) => record.stage === "mapping");
    expect(records.map((record) => [record.status, record.retries])).toEqual([
      ["ok", { communication: 0, shape: 0, content: 0 }],
      ["ok", { communication: 0, shape: 0, content: 1 }],
    ]);
    expect(countStage(result, "semantic-check")).toBe(2);
    // 差を許す欄の期待式：2 回目の照らした＝R3 の 1 件（要件 ID 1・所属・検査の対象）
    const r3Roles = TABLE_IDS.ownership.find((entry) => entry.requirementId === "R3")?.roles.length ?? 0;
    const r3 = MAPPED_IDS.verification.find((entry) => entry.requirementId === "R3");
    const r3Targets = r3?.kind === "structural" ? (r3.targets ?? []).reduce((sum, target) => sum + 1 + (target.sourceId === null ? 0 : 1), 0) : 0;
    expect(records[1]?.references).toEqual({ checked: 1 + r3Roles + r3Targets, unknown_ids: 0, duplicates: 0, cross_bundle_ids: 0 });
    expect(diagnosticPaths(result)).toEqual([DIAGNOSTICS_TABLE_ROUNDS_FILE]);
  });

  // ── 回ごとの行（`diagnostics/table-rounds.json`。Issue #699）────────────────────────
  //
  // 一気通貫と段の走りの両方で、C2 の 1 回ごとの表・C3 の判定・書き直した要件の ID・採用した回を同じ関数・
  // 同じ名前で診断に残す。段の判定・持ち越し・採用した回の選び方は今までどおり（行は読まない）。

  /** 回ごとの行（診断のファイル。Issue #699） */
  type TableRound = {
    readonly round: number;
    readonly ok: "ok" | "unmet" | "failed";
    readonly table: { readonly table_sha256: string } | null;
    readonly rewrite: { readonly requirement_ids: readonly string[]; readonly rewritten: number; readonly kept: number } | null;
    readonly semantic_check: Record<string, unknown> | null;
    readonly adopted: boolean;
  };
  const tableRoundsOf = (result: { readonly diagnostics: readonly { readonly path: string; readonly text: string }[] }): readonly TableRound[] =>
    diagnosticOf(result.diagnostics, DIAGNOSTICS_TABLE_ROUNDS_FILE)["rounds"] as readonly TableRound[];
  /** 2 回目の部分の表の SHA を初回と変える印：所属の並びを逆にする（C2' は通る） */
  const reversedRoles = (id: string) => {
    const entry = mappingEntries().find((item) => item["requirementId"] === id) as Record<string, unknown>;
    return { ...entry, roles: [...(entry["roles"] as readonly unknown[])].reverse() };
  };

  it("(1) 初回の C3 が R3・R4 を拒否し、2 回目が通って全部受理する走り：行 2 つ。回 1 は ok・表と SHA・拒否の判定・rewrite null・adopted false、回 2 は rewrite（R3・R4）・2 件・表と SHA・全部受理・adopted true。回 2 の表と C3 は checkpoint の name_table・semantic_check と深く等しく、回 1 の表の SHA は採用した表と違う（Issue #699）", async () => {
    const firstJudgments = judgments(IDS, REJECT_R3_R4);
    const { result } = await runScenario(
      [
        ...vocabularyCalls(),
        structured(good().mapping),
        structured(firstJudgments),
        structured({ requirements: [reversedRoles("R3"), flipped("R4")] }),
        structured(acceptAll()),
        ...tailFor(IDS),
      ],
      { flags: IDS_FLAGS, collectBoundaries: true },
    );
    expect(result.stopped).toBeNull();
    const rounds = tableRoundsOf(result);
    expect(rounds.map((round) => [round.round, round.ok, round.rewrite, round.adopted])).toEqual([
      [1, "ok", null, false],
      [2, "ok", { requirement_ids: ["R3", "R4"], rewritten: 2, kept: 2 }, true],
    ]);
    // 回 1 は C3 の拒否を残し、表は初回のもの。回 2 の表の SHA と違う（採用したのは回 2）
    expect(rounds[0]?.table?.table_sha256).toBe(await nameTableSha256(MAPPED_IDS));
    expect(rounds[1]?.table?.table_sha256).not.toBe(rounds[0]?.table?.table_sha256);
    const recordedJudgments = rounds[0]?.semantic_check?.["judgments"] as readonly { requirementId: string; verdict: string }[] | undefined;
    expect((recordedJudgments ?? []).map((judgment) => [judgment.requirementId, judgment.verdict])).toEqual(
      firstJudgments.judgments.map((judgment) => [judgment.requirementId, judgment.verdict]),
    );
    // 回 2 の表と C3 の結果は、境界（採用した表）と一気通貫の C3 の記録の 2 回目と深く等しい
    const boundary = result.boundaries?.find((entry) => entry.boundary === "t1-t2");
    expect(rounds[1]?.table).toEqual({
      table_sha256: boundary?.tableSha256,
      rows: boundary?.table.rows,
      ownership: boundary?.table.ownership,
      verification: boundary?.table.verification,
      classification: boundary?.table.classification,
    });
    expect(rounds[1]?.table?.table_sha256).toBe(await nameTableSha256(boundary!.table));
    const c3Rounds = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.semanticCheck)["rounds"] as readonly Record<string, unknown>[];
    const { round: _round, ...secondC3 } = c3Rounds[1] as Record<string, unknown>;
    expect(rounds[1]?.semantic_check).toEqual(secondC3);
    expect((secondC3["judgments"] as readonly { requirementId: string; verdict: string }[]).map((judgment) => [judgment.requirementId, judgment.verdict])).toEqual(
      acceptAll().judgments.map((judgment) => [judgment.requirementId, judgment.verdict]),
    );
    expectNoAcceptanceMaterial(result.diagnostics.map((artifact) => artifact.text));
  });

  it("(2) 2 回目が C2' に落ちて unmet の走り：回 2 は unmet・表 null・rewrite の ID と数・C3 null、回 1 が adopted true。checkpoint の表は回 1。rewrite の数は rejected-mapping の 2 回目の候補の数と同じ（Issue #699）", async () => {
    const missing = { requirements: (good().mapping["requirements"] as readonly unknown[]).slice(1) };
    const { result } = await runScenario(
      [
        ...vocabularyCalls(),
        structured(good().mapping),
        structured(judgments(IDS, { R3: REJECT_R3_R4.R3 })),
        structured(missing),
        structured(renamed(idsT2Response([...r1Tests(), ...r4Tests()], ["R1", "R2", "R4"]))),
        structured({ declaration: RUN_YAML }),
        structured(acceptAll(["R1", "R2", "R4"])),
      ],
      { flags: IDS_FLAGS, collectBoundaries: true },
    );
    expect(result.stopped).toBeNull();
    const rounds = tableRoundsOf(result);
    expect(rounds.map((round) => [round.round, round.ok, round.table, round.semantic_check, round.rewrite, round.adopted])).toEqual([
      [1, "ok", expect.objectContaining({ table_sha256: expect.any(String) }), expect.anything(), null, true],
      [2, "unmet", null, null, { requirement_ids: ["R3"], rewritten: 1, kept: 3 }, false],
    ]);
    // 回 2 の書き直した要件の数は、C2 の段が断った候補（2 回目）の数と同じ（二重に定義しない）
    const candidates = rejectedOf(result, DIAGNOSTICS_REJECTED_MAPPING_FILE) as readonly (IdsRejected & {
      readonly rewritten_requirements?: number;
      readonly kept_requirements?: number;
    })[];
    expect(rounds[1]?.rewrite?.rewritten).toBe(candidates[0]?.rewritten_requirements);
    expect(rounds[1]?.rewrite?.kept).toBe(candidates[0]?.kept_requirements);
    // 採用した表は回 1（checkpoint の name_table と同じ）
    const boundary = result.boundaries?.find((entry) => entry.boundary === "t1-t2");
    expect(rounds[0]?.table?.table_sha256).toBe(boundary?.tableSha256);
    expect(artifactOf(result.bundle, "artifacts/name-table.json")["table_sha256"]).toBe(boundary?.tableSha256);
  });

  it("(3) 初回で全部受理：行は 1 つで adopted true（Issue #699）", async () => {
    const { result } = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_FLAGS });
    const rounds = tableRoundsOf(result);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round: 1, ok: "ok", rewrite: null, adopted: true });
    expect(rounds[0]?.table?.table_sha256).toBe(await nameTableSha256(MAPPED_IDS));
  });

  it("(4) 2 回目の C3 が形で 2 回落ちて malformed で止まる走り（終了コード 1）：回 1・回 2 とも書かれ、回 2 は表あり・C3 null、adopted は全部 false。止まっても書く（Issue #699）", async () => {
    const incomplete = { judgments: IDS.slice(0, 3).map(accept) };
    const { result } = await runScenario(
      [
        ...vocabularyCalls(),
        structured(good().mapping),
        structured(judgments(IDS, REJECT_R3_R4)),
        structured(onlyEntries("R3", "R4")),
        structured(incomplete),
        structured(incomplete),
      ],
      { flags: IDS_FLAGS },
    );
    expect(result.stopped).toMatchObject({ stage: "semantic-check", kind: "malformed" });
    expect(result.summary.exit_code).toBe(1);
    expect(result.bundle).toBeNull();
    const rounds = tableRoundsOf(result);
    expect(rounds.map((round) => [round.round, round.ok, round.table !== null, round.semantic_check !== null, round.adopted])).toEqual([
      [1, "ok", true, true, false],
      [2, "ok", true, false, false],
    ]);
    expect(rounds[1]?.rewrite).toEqual({ requirement_ids: ["R3", "R4"], rewritten: 2, kept: 2 });
  });

  it("(5) 同じ台本の段の走り（ids on・name-table..semantic-check）の tableRounds は、一気通貫の同じ名前の診断と深く等しい。一気通貫の納品物・記録・要約・要求・終了コードは (1)〜(5) の固定の SHA の試験が照らす（Issue #699）", async () => {
    const calls = [
      ...vocabularyCalls(),
      structured(good().mapping),
      structured(judgments(IDS, REJECT_R3_R4)),
      structured(onlyEntries("R3", "R4")),
      structured(acceptAll()),
    ];
    const stageRecording = createCheckedRecordingClient(calls);
    const stage = await runStageRangeV11a({
      ...inputOf(stageRecording.client),
      flags: IDS_FLAGS,
      range: { start: "name-table", end: "semantic-check" },
    });
    const { result } = await runScenario([...calls, ...tailFor(IDS)], { flags: IDS_FLAGS });
    expect(stage.tableRounds).toEqual(tableRoundsOf(result));
    expect(stage.tableRounds).toHaveLength(2);
    expectNoAcceptanceMaterial([...stageRecording.structured.map((request) => JSON.stringify(request)), ...result.diagnostics.map((artifact) => artifact.text)]);
  });

  /**
   * C1 → C2 → C3 が全件受理したあと、T2 の骨組み（`tests` の並び）が 2 回とも不正で test-spec に止まる台本（Issue #699）。
   * 骨組みが無い応答は strict の schema では出ないので、照合を外した負例として渡す
   */
  const t2SkeletonTwice = (): RecordedCall[] => {
    const badT2 = structured(
      negative({}, "T2 の骨組み（tests の並び）が無い応答。strict の schema では出ないが、段の形の検査の負例として必要"),
    );
    return [
      ...idsResponseList(idsResponsesOf(LIST, TABLE_IDS, PROPERTY_LEDGER_VIEW)).map((output) => structured(output)),
      structured(acceptAll()),
      badT2,
      badT2,
    ];
  };

  it("(6) C3 を通って表を採用したあとに T2 の骨組みが 2 回不正で test-spec・malformed で止まる走り：table-rounds の adopted は全部 false（一気通貫。Issue #699）", async () => {
    const { result } = await runScenario(t2SkeletonTwice(), { flags: IDS_FLAGS });
    expect(result.stopped).toMatchObject({ stage: "test-spec", kind: "malformed" });
    expect(result.summary.exit_code).toBe(1);
    expect(result.bundle).toBeNull();
    const rounds = tableRoundsOf(result);
    expect(rounds.map((round) => [round.round, round.ok, round.adopted])).toEqual([[1, "ok", false]]);
  });

  it("(7) 同じ台本の段の走り（ids on・name-table..test-spec）でも tableRounds の adopted は全部 false（Issue #699）", async () => {
    const recording = createCheckedRecordingClient(t2SkeletonTwice());
    const stage = await runStageRangeV11a({
      ...inputOf(recording.client),
      flags: IDS_FLAGS,
      range: { start: "name-table", end: "test-spec" },
    });
    expect(stage.stopped).toMatchObject({ stage: "test-spec", kind: "malformed" });
    expect(stage.tableRounds).toHaveLength(1);
    expect(stage.tableRounds?.map((round) => round.adopted)).toEqual([false]);
  });

  // ── C2 が組んだ表を整える手（N-map-01・N-map-02。Issue #723）─────────────────────────
  //
  // R3 の所属に、R1 が stated で持つ when 無しの操作（addItem）を dependency で足した応答。手 2 が R3 から外すので、整えた表は
  // 題材の表（MAPPED_IDS）と同じになる。前回の写像（C2 の 2 回目の要求のデータ）は整える前の raw のまま

  type NormalizedRow = { readonly requirement_id: string; readonly rule: string; readonly target_id: string | null; readonly removed_row_ids: readonly string[] };
  const ADD_ITEM = CODE_RENAME.get("o.addItem") as string;
  const R3_NORMALIZED: readonly NormalizedRow[] = [{ requirement_id: "R3", rule: "N-map-02", target_id: null, removed_row_ids: [ADD_ITEM] }];
  const withSharedAdd = (entry: Record<string, unknown>) =>
    entry["requirementId"] === "R3" ? { ...entry, roles: [...(entry["roles"] as readonly unknown[]), { id: ADD_ITEM, basis: "dependency", reason: "登録が要る" }] } : entry;
  const hitMapping = () => ({ requirements: mappingEntries().map(withSharedAdd) });
  const normalizedOf = (round: TableRound | undefined) => (round as (TableRound & { readonly normalized: readonly NormalizedRow[] | null }) | undefined)?.normalized;

  it("(7)(9) 手が当たる台本（Issue #723）：table-rounds の回に normalized が載り、C3 の対象と判定の表 SHA は整えた表の SHA（＝題材の表）。納品物の表も整えた表で、段の走りの tableRounds と深く等しい", async () => {
    const calls = [...vocabularyCalls(), structured(hitMapping()), structured(acceptAll())];
    const { result, recording } = await runScenario([...calls, ...tailFor(IDS)], { flags: IDS_FLAGS, collectBoundaries: true });
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const rounds = tableRoundsOf(result);
    expect(rounds).toHaveLength(1);
    expect(normalizedOf(rounds[0])).toEqual(R3_NORMALIZED);
    const sha = await nameTableSha256(MAPPED_IDS);
    expect(rounds[0]?.table?.table_sha256).toBe(sha);
    expect(rounds[0]?.semantic_check?.["table_sha256"]).toBe(sha);
    expect(artifactOf(result.bundle, "artifacts/name-table.json")["table_sha256"]).toBe(sha);
    expect(result.boundaries?.find((entry) => entry.boundary === "t1-t2")?.table).toEqual(MAPPED_IDS);
    // C2 の要求は 1 回（初回は手の当たり方に依らない）。C3 の要求に整える前の所属（R3 の addItem）は載らない
    expect(requestsOf(recording, "mapping")).toHaveLength(1);
    const semantic = requestsOf(recording, SEMANTIC_CHECK_SCHEMA_NAME)[0];
    expect(JSON.stringify(semantic)).toBe(JSON.stringify(requestsOf((await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_FLAGS })).recording, SEMANTIC_CHECK_SCHEMA_NAME)[0]));
    const stageRecording = createCheckedRecordingClient(calls);
    const stage = await runStageRangeV11a({ ...inputOf(stageRecording.client), flags: IDS_FLAGS, range: { start: "name-table", end: "semantic-check" } });
    expect(stage.tableRounds).toEqual(rounds);
  });

  it("(7) 当たる要件の無い走りは空の並び、C2 が落ちた回は null、C3 が形で止まった回も表があれば保持（Issue #723）", async () => {
    const clean = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_FLAGS });
    expect(tableRoundsOf(clean.result).map(normalizedOf)).toEqual([[]]);
    const missing = { requirements: mappingEntries().slice(1) };
    const failed = await runScenario(
      [
        ...vocabularyCalls(),
        structured(hitMapping()),
        structured(judgments(IDS, { R3: REJECT_R3_R4.R3 })),
        structured(missing),
        structured(renamed(idsT2Response([...r1Tests(), ...r4Tests()], ["R1", "R2", "R4"]))),
        structured({ declaration: RUN_YAML }),
        structured(acceptAll(["R1", "R2", "R4"])),
      ],
      { flags: IDS_FLAGS, collectBoundaries: true },
    );
    expect(failed.result.stopped).toBeNull();
    const failedRounds = tableRoundsOf(failed.result);
    expect(failedRounds.map((round) => [round.ok, normalizedOf(round), round.adopted])).toEqual([
      ["ok", R3_NORMALIZED, true],
      ["unmet", null, false],
    ]);
    // 2 回目が C2' に落ちたら初回の整えた表とその SHA に戻る
    const sha = await nameTableSha256(MAPPED_IDS);
    expect(failed.result.boundaries?.find((entry) => entry.boundary === "t1-t2")?.tableSha256).toBe(sha);
    expect(artifactOf(failed.result.bundle, "artifacts/name-table.json")["table_sha256"]).toBe(sha);
    const incomplete = { judgments: IDS.slice(0, 3).map(accept) };
    const stopped = await runScenario(
      [...vocabularyCalls(), structured(good().mapping), structured(judgments(IDS, REJECT_R3_R4)), structured({ requirements: [withSharedAdd(mappingEntries()[2] as Record<string, unknown>), mappingEntries()[3]] }), structured(incomplete), structured(incomplete)],
      { flags: IDS_FLAGS },
    );
    expect(stopped.result.stopped).toMatchObject({ stage: "semantic-check", kind: "malformed" });
    expect(tableRoundsOf(stopped.result).map((round) => [round.table !== null, round.semantic_check !== null, normalizedOf(round)])).toEqual([
      [true, true, []],
      [true, false, R3_NORMALIZED],
    ]);
  });

  it("(9) C3 の拒否のあと LLM が同じ raw を再提出 → 同じ表 → 拒否が残れば持ち越しで full にならない。2 回目の「前回の写像」は整える前の raw（Issue #723）", async () => {
    const rejectR3 = judgments(IDS, { R3: REJECT_R3_R4.R3 });
    const { result, recording } = await runScenario(
      [
        ...vocabularyCalls(),
        structured(hitMapping()),
        structured(rejectR3),
        structured({ requirements: hitMapping().requirements.filter((entry) => entry["requirementId"] === "R3") }),
        structured(rejectR3),
        ...tailFor(["R1", "R2", "R4"]),
      ],
      { flags: IDS_FLAGS },
    );
    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).not.toBe("full");
    expect(carryEntriesOf(result.bundle)).toEqual([{ requirementId: "R3", reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] }]);
    const mappingRequests = requestsOf(recording, "mapping");
    expect(mappingRequests).toHaveLength(2);
    expect(dataBlockOf(mappingRequests[1]?.input ?? "", "前回の写像")).toEqual(hitMapping());
    const rounds = tableRoundsOf(result);
    expect(rounds.map((round) => [round.table?.table_sha256, round.semantic_check?.["table_sha256"], normalizedOf(round)])).toEqual([
      [await nameTableSha256(MAPPED_IDS), await nameTableSha256(MAPPED_IDS), R3_NORMALIZED],
      [await nameTableSha256(MAPPED_IDS), await nameTableSha256(MAPPED_IDS), R3_NORMALIZED],
    ]);
    expectNoAcceptanceMaterial(result.diagnostics.map((artifact) => artifact.text));
  });

  it("(9) 書き直した要件が共有の操作を手放すと、保持した要件の手 2 の可否が変わる：初回は R1 から addItem が外れ、C3 が R3 を拒否して R3 が addItem を手放した 2 回目は、raw の全表の組み直しで保持した R1 に addItem が残る（孤立なし）。2 回目の C3 の対象・table-rounds の表・判定の SHA は組み直した表に一致する（Issue #723 のレビュー R1）", async () => {
    // 初回：R1 が addItem を dependency、R3 が stated で持つ（R3 の所属に addItem を足す）。手 2 が R1 から addItem を外す
    const r1Dependency = (entry: Record<string, unknown>) =>
      entry["requirementId"] === "R1"
        ? { ...entry, roles: (entry["roles"] as readonly Record<string, unknown>[]).map((role) => (role["id"] === ADD_ITEM ? { id: ADD_ITEM, basis: "dependency", reason: "登録が要る" } : role)) }
        : entry;
    const r3Stated = (entry: Record<string, unknown>) =>
      entry["requirementId"] === "R3" ? { ...entry, roles: [...(entry["roles"] as readonly unknown[]), { id: ADD_ITEM, basis: "stated", reason: null }] } : entry;
    const firstMapping = { requirements: mappingEntries().map(r1Dependency).map(r3Stated) };
    // 2 回目：R3 だけを書き直し、addItem を手放す（題材の表の R3 のまま）
    const rewrittenR3 = { requirements: mappingEntries().filter((entry) => entry["requirementId"] === "R3") };
    const rejectR3 = judgments(IDS, { R3: REJECT_R3_R4.R3 });
    const { result, recording } = await runScenario(
      [...vocabularyCalls(), structured(firstMapping), structured(rejectR3), structured(rewrittenR3), structured(acceptAll()), ...tailFor(IDS)],
      { flags: IDS_FLAGS, collectBoundaries: true },
    );
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const roleIdsOf = (table: NameTable, id: string) => table.ownership.find((entry) => entry.requirementId === id)?.roles.map((role) => role.id) ?? [];
    const withOwnership = (map: (entry: NameTable["ownership"][number]) => NameTable["ownership"][number]): NameTable => ({ ...MAPPED_IDS, ownership: MAPPED_IDS.ownership.map(map) });
    const asDependency = (entry: NameTable["ownership"][number]) =>
      entry.requirementId === "R1" ? { ...entry, roles: entry.roles.map((role) => (role.id === ADD_ITEM ? { id: ADD_ITEM, basis: "dependency" as const, reason: "登録が要る" } : role)) } : entry;
    // 期待する表：初回は R1 から addItem を外し R3 が stated で持つ表、2 回目は R1 が addItem を dependency のまま持つ表
    const firstTable = withOwnership((entry) =>
      entry.requirementId === "R1"
        ? { ...entry, roles: entry.roles.filter((role) => role.id !== ADD_ITEM) }
        : entry.requirementId === "R3"
          ? { ...entry, roles: [...entry.roles, { id: ADD_ITEM, basis: "stated" as const, reason: null }] }
          : entry,
    );
    const secondTable = withOwnership(asDependency);
    const firstSha = await nameTableSha256(firstTable);
    const secondSha = await nameTableSha256(secondTable);
    expect(secondSha).not.toBe(firstSha);
    const rounds = tableRoundsOf(result);
    expect(rounds.map((round) => [round.round, round.ok, round.table?.table_sha256, round.semantic_check?.["table_sha256"], normalizedOf(round), round.adopted])).toEqual([
      [1, "ok", firstSha, firstSha, [{ requirement_id: "R1", rule: "N-map-02", target_id: null, removed_row_ids: [ADD_ITEM] }], false],
      // 2 回目の回では R1 に手 2 の項目が無い（最終の差分。初回の整えた中身を持ち越さない）
      [2, "ok", secondSha, secondSha, [], true],
    ]);
    // 保持した R1 は、2 回目の表で addItem を持ち（初回の整えた表のままではない）、addItem は孤立しない
    const boundary = result.boundaries?.find((entry) => entry.boundary === "t1-t2");
    expect(boundary?.table).toEqual(secondTable);
    expect(boundary?.tableSha256).toBe(secondSha);
    expect(roleIdsOf(secondTable, "R1")).toContain(ADD_ITEM);
    expect(ownersByRowId(secondTable).get(ADD_ITEM)).toEqual(["R1"]);
    expect(artifactOf(result.bundle, "artifacts/name-table.json")["table_sha256"]).toBe(secondSha);
    // 2 回目の C3 は保持した R1 を含む全要件を対象にし、その表は組み直した表
    const semanticRequests = requestsOf(recording, SEMANTIC_CHECK_SCHEMA_NAME);
    expect(semanticRequests.map(semanticTargetsOf)).toEqual([[...IDS], [...IDS]]);
    expect(rounds[1]?.semantic_check?.["targets"]).toEqual([...IDS]);
    // 2 回目の C2 の要求の「前回の写像」は整える前の raw（R1 が addItem を dependency で持つ）
    expect(dataBlockOf(requestsOf(recording, "mapping")[1]?.input ?? "", "前回の写像")).toEqual(firstMapping);
    expectNoAcceptanceMaterial(result.diagnostics.map((artifact) => artifact.text));
  });

  /** 文に目印を足す（null は null のまま） */
  const markedText = (text: string | null): string | null => (text === null ? null : `${text}。目印の追記`);
  /** 固定文の欄の全部に目印を足す */
  const markedMessages = <T extends Readonly<Record<string, string | null>>>(messages: T): T =>
    Object.fromEntries(Object.entries(messages).map(([key, text]) => [key, markedText(text)])) as T;
  /**
   * 上流の見方に入らない欄（行の T2 の型・T2 と ids の T2 と B1 の規則の文・集計と条件の型のうち集計の種類以外・since・why）を
   * 全行で変えた台帳（妥当な台帳のまま。Issue #712）
   */
  const downstreamChangedLedger = (): readonly PropertyRow[] =>
    PROPERTY_LEDGER.map((row) => ({
      ...row,
      since: `${row.since}。目印の追記`,
      why: `${row.why}。目印の追記`,
      rules: { ...row.rules, t2: markedText(row.rules.t2), t2Ids: markedText(row.rules.t2Ids), b1: markedText(row.rules.b1) },
      t2: row.t2 === null ? null : { ...row.t2, minTests: row.t2.minTests + 1, messages: markedMessages(row.t2.messages) },
      t2Aggregate:
        row.t2Aggregate === null
          ? null
          : {
              ...row.t2Aggregate,
              alsoObserves: [],
              states: row.t2Aggregate.states.map((entry) => ({ ...entry, label: `${entry.label}。目印の追記` })),
              messages: markedMessages(row.t2Aggregate.messages),
            },
      t2Condition: row.t2Condition === null ? null : { ...row.t2Condition, messages: markedMessages(row.t2Condition.messages) },
    }));
  /** 上流の見方に入る値（default-value の T1 の規則の文）だけを変えた台帳（測り方の対照） */
  const upstreamChangedLedger = (): readonly PropertyRow[] =>
    PROPERTY_LEDGER.map((row) => (row.id === "default-value" ? { ...row, rules: { ...row.rules, t1: markedText(row.rules.t1) } } : row));
  /** 境界 t1-t2 までの台本（段の走り name-table..semantic-check）。ids on は C1〜C3、ids off は T1・T1'' */
  const upstreamScripts = (): readonly { readonly name: string; readonly flags: Partial<V12Flags>; readonly calls: readonly RecordedCall[] }[] => {
    const requirements = good().mapping["requirements"] as readonly unknown[];
    const missingFirst = { requirements: requirements.slice(1) };
    const missingLast = { requirements: requirements.slice(0, -1) };
    const rejectR3 = judgments(IDS, { R3: ["unnecessary-ownership", "締められる"] });
    const ledgerOnly = { ledger: true };
    return [
      { name: "正常", flags: IDS_FLAGS, calls: idsHead().slice(0, 5) },
      { name: "C1' の形の拒否と再試行", flags: IDS_FLAGS, calls: passingWith({ fields: [fieldsWithEntity("E8")] }).slice(0, 6) },
      { name: "C1' の形の拒否が 2 回で止まる", flags: IDS_FLAGS, calls: [structured(good().entities), structured(fieldsWithEntity("E8")), structured(fieldsWithEntity("E9"))] },
      { name: "C2' の形の拒否と再試行", flags: IDS_FLAGS, calls: passingWith({ mapping: [missingFirst] }).slice(0, 6) },
      { name: "C2' の形の拒否が 2 回で止まる", flags: IDS_FLAGS, calls: [...vocabularyCalls(), structured(missingFirst), structured(missingLast)] },
      { name: "C2 の形のやり直しの書き直し", flags: IDS_FLAGS, calls: rewriteScript(true).slice(0, 6) },
      { name: "C3 の拒否と C2 の中身の再試行（書き直し）と再点検で持ち越し", flags: IDS_FLAGS, calls: [...vocabularyCalls(), structured(good().mapping), structured(rejectR3), structured(onlyEntries("R3")), structured(rejectR3)] },
      { name: "C3 の拒否と再点検で全部受理", flags: IDS_FLAGS, calls: [...vocabularyCalls(), structured(good().mapping), structured(judgments(IDS, REJECT_R3_R4)), structured(onlyEntries("R3", "R4")), structured(acceptAll())] },
      { name: "C3 の拒否のあとの C2 が C2' に落ちて持ち越し", flags: IDS_FLAGS, calls: [...vocabularyCalls(), structured(good().mapping), structured(rejectR3), structured(missingFirst)] },
      { name: "ids off の T1 の正常", flags: ledgerOnly, calls: [structured(t1Of(LIST, TABLE_ON)), structured(acceptAll())] },
      { name: "ids off の T1' の拒否が 2 回で止まる", flags: ledgerOnly, calls: [structured(badDraft()), structured(badDraft())] },
      {
        name: "ids off の T1'' の拒否と T1 の 2 回目で持ち越し",
        flags: ledgerOnly,
        calls: [structured(t1Of(LIST, TABLE_ON)), structured(rejectR3), structured(t1Of(LIST, TABLE_ON)), structured(rejectR3)],
      },
    ];
  };
  /** 台本を境界 t1-t2 まで流し、C1〜C3（T1・T1''）の要求の全体・段の結果（検査の結果と文・停止・持ち越し・境界の材料）・checkpoint を集める */
  const upstreamRunOf = async (script: { readonly flags: Partial<V12Flags>; readonly calls: readonly RecordedCall[] }) => {
    const recording = createCheckedRecordingClient(script.calls);
    const outcome = await runStageRangeV11a({ ...inputOf(recording.client), flags: script.flags, range: { start: "name-table", end: "semantic-check" } });
    const versions = { vocabulary: "v1", contract: "v0.2", prompt: "v1.1a", factory: "0.0.0" };
    const checkpoints = outcome.boundaries.map((boundary) =>
      stageJsonText(buildStageCheckpoint({ materials: boundary, versions, planSha256: "a".repeat(64), sourceSha256: "b".repeat(64) })),
    );
    return { requests: { structured: recording.structured, tools: recording.tools }, outcome, checkpoints };
  };

  it("二点測定（Issue #712）：上流の見方に入らない欄を変えた台帳で、境界 t1-t2 までの台本の要求の全体・検査の結果と文・t1-t2 の checkpoint の材料が、変えない台帳と同じ。上流の見方に入る値を変えれば要求が変わる", async () => {
    const changed = downstreamChangedLedger();
    expect(ledgerRowDefects(changed)).toEqual([]);
    expect(await propertyLedgerSha256(changed)).not.toBe(await propertyLedgerSha256());
    expect(await upstreamLedgerSha256(changed)).toBe(await upstreamLedgerSha256());
    const changedView = deriveLedgerView(changed);
    const scripts = upstreamScripts();
    for (const script of scripts) {
      const before = await upstreamRunOf(script);
      const spy = vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? changedView : undefined));
      const after = await upstreamRunOf(script);
      spy.mockRestore();
      // JSON のバイト列で照らす（要求の中断の信号 signal は走りごとの別の値で、JSON に出ない）
      expect(JSON.stringify(after), script.name).toBe(JSON.stringify(before));
    }
    // 台本の分岐を通っている（停止・持ち越し・形と中身の再試行・境界の材料のある走りを含む）
    const outcomes = await Promise.all(scripts.map(async (script) => (await upstreamRunOf(script)).outcome));
    expect(outcomes.some((outcome) => outcome.stopped !== null)).toBe(true);
    expect(outcomes.some((outcome) => outcome.boundaries.some((boundary) => boundary.carryOver.entries.length > 0))).toBe(true);
    expect(outcomes.some((outcome) => outcome.stages.some((record) => record.retries.shape > 0))).toBe(true);
    expect(outcomes.some((outcome) => outcome.stages.some((record) => record.retries.content > 0))).toBe(true);
    expect(outcomes.filter((outcome) => outcome.boundaries.length > 0).length).toBeGreaterThan(5);
    // 対照：上流の見方に入る値を変えた台帳では、同じ台本の要求が変わる（差し替えが段に届いている）
    const control = deriveLedgerView(upstreamChangedLedger());
    const normal = scripts[0];
    if (normal === undefined) throw new Error("前提が壊れた：台本が無い");
    const before = await upstreamRunOf(normal);
    vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? control : undefined));
    const after = await upstreamRunOf(normal);
    expect(JSON.stringify(after.requests)).not.toBe(JSON.stringify(before.requests));
  });

  /** 台帳の行から工場の照合の版を出す（全体の指紋・上流の台帳の部分の指紋・旗の組。Issue #713） */
  const factoryVersionsOf = async (rows: readonly PropertyRow[] = PROPERTY_LEDGER) => ({
    ledger: await propertyLedgerSha256(rows),
    ledgerUpstream: await upstreamLedgerSha256(rows),
    flags: toPublicV12Flags({ ledger: true, searchRepair: true, ids: true }),
  });
  /** 境界の材料から、その工場が書く v1.2 の checkpoint と記録（境界ごとの版） */
  const writtenBy = async (factory: Awaited<ReturnType<typeof factoryVersionsOf>>, materials: BoundaryMaterials) => {
    const base = { vocabulary: "v1", contract: "v0.2", prompt: "v1.2", factory: "0.0.0", ledger: factory.ledger, flags: factory.flags, call_limits: null };
    const versions = stageVersionsAt(base, materials.boundary, factory.ledgerUpstream);
    const checkpoint = JSON.parse(stageJsonText(buildStageCheckpoint({ materials, versions, planSha256: "a".repeat(64), sourceSha256: "b".repeat(64) }))) as Record<string, unknown>;
    const record = { schema_version: STAGE_RUN_RECORD_SCHEMA, checkpoints: [{ boundary: materials.boundary, path: "cp.json", output_digest: await stageOutputDigest(checkpoint) }] };
    return { checkpoint, checkpointText: stageJsonText(checkpoint), recordText: JSON.stringify(record) };
  };
  const verifiedBy = (factory: Awaited<ReturnType<typeof factoryVersionsOf>>, start: "test-spec" | "write", texts: { checkpointText: string; recordText: string }) =>
    verifyStageInput({
      start,
      ...texts,
      checkpointFile: "cp.json",
      plan: PLAN,
      planSha256: "a".repeat(64),
      sourceSha256: "b".repeat(64),
      vocabularyVersion: "v1",
      contractVersion: "v0.2",
      v12: factory,
    });

  it("台帳の部分の指紋（Issue #713）：上流の見方に入らない欄を変えた台帳の工場は、変える前の工場が書いた t1-t2 の checkpoint を全台本で受ける。上流の値を変えた台帳の工場は t1-t2 を、T2 の型を変えた台帳の工場は t2-b1 を stage-input:version で断る", async () => {
    const before = await factoryVersionsOf();
    const downstream = await factoryVersionsOf(downstreamChangedLedger());
    const upstream = await factoryVersionsOf(upstreamChangedLedger());
    expect(downstream.ledger).not.toBe(before.ledger);
    expect(downstream.ledgerUpstream).toBe(before.ledgerUpstream);
    expect(upstream.ledgerUpstream).not.toBe(before.ledgerUpstream);
    const version = { ok: false, code: "stage-input:version" };
    let checked = 0;
    for (const script of upstreamScripts()) {
      const { outcome } = await upstreamRunOf(script);
      for (const materials of outcome.boundaries) {
        const texts = await writtenBy(before, materials);
        expect((texts.checkpoint["versions"] as Record<string, unknown>)["ledger_upstream"], script.name).toBe(before.ledgerUpstream);
        const ok = await verifiedBy(before, "test-spec", texts);
        expect(ok, script.name).toMatchObject({ ok: true });
        // 変えた台帳の工場も同じ再開の材料で受ける
        expect(await verifiedBy(downstream, "test-spec", texts), script.name).toEqual(ok);
        expect(await verifiedBy(upstream, "test-spec", texts), script.name).toEqual(version);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
    // 境界 t2-b1：T2 まで流した材料。変える前の工場が書いた t2-b1 は ledger_upstream が null で、T2 の型を変えた台帳の工場は全体の指紋で断る
    const recording = createCheckedRecordingClient(idsHead().slice(0, 6));
    const reached = await runStageRangeV11a({ ...inputOf(recording.client), flags: IDS_FLAGS, range: { start: "name-table", end: "test-spec" } });
    expect(reached.boundaries.map((materials) => materials.boundary)).toEqual(["t1-t2", "t2-b1"]);
    const t2b1 = reached.boundaries[1];
    if (t2b1 === undefined) throw new Error("前提が壊れた：t2-b1 が無い");
    const texts = await writtenBy(before, t2b1);
    expect((texts.checkpoint["versions"] as Record<string, unknown>)["ledger_upstream"]).toBeNull();
    expect(await verifiedBy(before, "write", texts)).toMatchObject({ ok: true });
    expect(await verifiedBy(downstream, "write", texts)).toEqual(version);
  });
});

describe("(c) T1'' の拒否 → T1 の 2 回目 → 残った拒否は持ち越し", () => {
  it("2 回目のデータに拒否と J4 の印があり、残った拒否は持ち越されて partial（B5 の要求は無い）", async () => {
    const rejectR3 = judgments(IDS, { R3: ["unnecessary-ownership", "締められる"] });
    const { result, recording } = await runScenario(
      [
        structured(t1Of(LIST, TABLE)),
        structured(rejectR3),
        structured(t1Of(LIST, TABLE)),
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
    const { result } = await runScenario([structured(t1Of(LIST, TABLE)), structured(incomplete), structured(incomplete)]);
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
      structured(t1Of(LIST, TABLE)),
      structured(rejectAll),
      structured(t1Of(LIST, TABLE)),
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
      structured(t1Of(LIST, TABLE)),
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
      structured(t1Of(LIST, TABLE)),
      structured(rejectR2),
      structured(t1Of(LIST, TABLE)),
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
  const ahead = (table: NameTable = TABLE): RecordedCall[] => [structured(t1Of(LIST, table)), structured(acceptAll())];

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
    structured(t1Of(D_LIST, D_TABLE)),
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
      structured(t1Of(D_LIST, D_TABLE)),
      structured(rejectR6),
      structured(t1Of(D_LIST, D_TABLE)),
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
      structured(t1Of(D_LIST, D_TABLE)),
      structured(rejectAll),
      structured(t1Of(D_LIST, D_TABLE)),
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
    structured(t1Of(E_LIST, E_TABLE)),
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
    const unregistered = negative(t1Of(E_LIST, E_TABLE_PLAIN), "旗 off の schema の確かめ方の kind の enum に enum-membership が無い。段の未登録の拒否を観測する負例");
    const { result } = await runScenario([structured(unregistered), structured(unregistered)], {
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
      structured(t1Of(E_LIST, table)),
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
      structured(t1Of(E_LIST, E_TABLE)),
      structured(rejectR6),
      structured(t1Of(E_LIST, E_TABLE)),
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
    structured(t1Of(LIST, table)),
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
    const on = await runScenario([structured(t1Of(LIST, S_TABLE)), structured(acceptAll()), structured(t2), structured(t2)], flags);
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

  it("(a) 旗 on の実際の経路：計算の行の aggregate の欄が欠けた T1 の応答は形（schema の必須の欄）で落ち、T1' の集計の検査に届かない。2 回とも欠ければ T1 で止まり full が出ない", async () => {
    const omitted = negative(t1Of(LIST, S_TABLE_PLAIN), "計算の行の型に aggregate の欄が無い応答。旗 on の schema は必須にするので strict では出ないが、段の形の検査の落ちを観測する負例");
    const { result, recording } = await runScenario([structured(omitted), structured(omitted)], flags);
    expect(result.stopped?.stage).toBe("name-table");
    expect(result.outcome.verdict).not.toBe("full");
    expect(schemaNames(recording.structured)).toEqual([NAME_TABLE_SCHEMA_NAME, NAME_TABLE_SCHEMA_NAME]);
    const candidates = diagnosticOf(result.diagnostics, DIAGNOSTICS_REJECTED_NAME_TABLE_FILE)["candidates"] as readonly {
      readonly problems: readonly { readonly field: string; readonly message: string }[];
    }[];
    expect(candidates).toHaveLength(2);
    // 計算の行（6 行）ごとに形の落ちが 1 つずつ。T1' の表の検査の固定文（種別との対応・集計元・見出しの元）は出ない
    const shapeMessage = "計算の型の aggregate は null か、集計の種類（sum・count・avg）と集計元の entity の行の id の写像であること";
    const computationRows = S_TABLE_PLAIN.rows.flatMap((row, index) => (row.kind === "computation" ? [index] : []));
    for (const candidate of candidates) {
      const aggregateProblems = candidate.problems
        .filter((problem) => problem.field.endsWith(".type.aggregate") || problem.field.endsWith(".type.aggregate.entity"))
        .map((problem) => ({ field: problem.field, message: problem.message }));
      expect(aggregateProblems).toEqual(computationRows.map((index) => ({ field: `rows[${String(index)}].type.aggregate`, message: shapeMessage })));
      for (const message of Object.values(COMPUTATION_AGGREGATE_MESSAGES)) {
        expect(candidate.problems.map((problem) => problem.message)).not.toContain(message);
      }
    }
    // 対照：同じ表に欄を足した応答は T1' を通る（落ちは欄が欠けたことだけによる）
    const fixed = await runScenario([...sHead(S_YAML), structured(acceptAll())], flags);
    expect(fixed.result.outcome.verdict).toBe("full");
  });

  it("(b) 集計の検査の省略は門の免除にならない：LLM を経ずにコードが組んだ表（計算の行に aggregate の欄が無い）から再開した旗 on の走りで、empty-aggregate の試験は T2' で 2 回とも落ちて B4 へ進まず、value の観測で空に null を期待した試験は T2' を通っても B4 の不一致で full が出ない", async () => {
    // 境界 T1''／T2 の材料を、欄の無い表（旗 off の走り＝コードが組む表と同じ形）から取る
    const first = await runStageRangeV11a({
      ...inputOf(createCheckedRecordingClient([structured(t1Of(LIST, S_TABLE_PLAIN)), structured(acceptAll())]).client),
      range: { start: "name-table", end: "semantic-check" },
    });
    expect(first.stopped).toBeNull();
    const boundary = first.boundaries[0];
    if (boundary === undefined) throw new Error("前提が壊れた：境界が無い");
    const { boundary: _boundary, ...resume } = boundary;
    expect(resume.table).toEqual(S_TABLE_PLAIN);
    // empty-aggregate の試験（形は正しい：空の合計に 0・未読に null）でも、表に集計の種類と集計元が無いので対象の落ち
    const t2 = t2S(emptyAggregateTests().slice(0, 2));
    const rejectedRecording = createCheckedRecordingClient([structured(t2), structured(t2)]);
    const rejected = await runStageRangeV11a({ ...inputOf(rejectedRecording.client), ...flags, range: { start: "test-spec", end: "judge" }, resume });
    expect(rejected.stopped?.stage).toBe("test-spec");
    expect(rejected.stages.map((record) => record.stage)).not.toContain("run-tests");
    expect(rejected.judgeVerdict).toBeNull();
    expect(schemaNames(rejectedRecording.structured)).toEqual([TEST_SPEC_SCHEMA_NAME, TEST_SPEC_SCHEMA_NAME]);
    const row = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate");
    const previous = dataBlockOf(rejectedRecording.structured[1]!.input, "前回の作り直しの指示") as { field: string; message: string }[];
    expect(previous).toContainEqual({ field: "tests[10].target", message: row?.t2Aggregate?.messages.target ?? "（無い）" });
    // value の観測で空に null を期待した試験は、表から集計元を引けないので T2' の期待の照合は掛からないが、B4（v1 の評価器）が
    // 不一致に数え、full は出ない（門は B4 に残る）
    const { reports } = spyRuns();
    const aOne = aggTest("r4-empty-null", "c.base", "boundary", ["e.item"], null, "value");
    const passed = await runStageRangeV11a({
      ...inputOf(createCheckedRecordingClient([structured(t2S([aOne])), structured({ declaration: S_YAML }), structured(acceptAll()), repairDone(S_YAML), structured(acceptAll())]).client),
      ...flags,
      range: { start: "test-spec", end: "judge" },
      resume,
    });
    expect(passed.judgeVerdict).not.toBe("full");
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]!.mismatches.map((entry) => entry.testId)).toContain("r4-empty-null");
  });

  it("旗 off では同じ表（計算の行に aggregate を持つ）は T1' の形で落ち（未登録の拒否）、full が出ない", async () => {
    const unregistered = negative(t1Of(LIST, S_TABLE), "旗 off の schema は行の型に aggregate の欄を持たない。段の未登録の拒否を観測する負例");
    const { result } = await runScenario([structured(unregistered), structured(unregistered)]);
    expect(result.stopped?.stage).toBe("name-table");
    expect(result.outcome.verdict).not.toBe("full");
  });
});

// ── 段単位の走り（08-architecture-v1.2.md §8.3。Issue #544）──────────────────────────────

// ── (t) 操作の条件（when）の試験の期待の型（旗 on。(a)③・(c)② の型。Issue #550）──────────────────────────────

describe("(t) 操作の条件（when）の試験：期待が ok なら真偽・対象は条件を持つ操作の行（旗 on。(a)③・(c)② の型。Issue #550）", () => {
  const flags: Partial<GenerationInputV11a> = { flags: { ledger: true } };
  const WHEN_T2 = PROPERTY_LEDGER.find((entry) => entry.id === "when")?.t2Condition;
  if (WHEN_T2 == null) throw new Error("前提が壊れた：台帳の when に条件の試験の型が無い");
  /** R3 の正常の試験の期待だけを替えた T2 の応答 */
  const t2With = (expected: { readonly kind: "ok"; readonly value: string; readonly code: null }) =>
    t2Response([...r1Tests(), ...r2Tests(), ...r3Tests().map((test) => (test["id"] === "r3-normal" ? { ...test, expected } : test)), ...r4Tests()]);
  /** 評価口の B4 の結果と、v1 の runTests に渡った試験を記録する（評価口はそのまま） */
  function spyRuns() {
    const reports: { readonly mismatches: readonly { readonly testId: string; readonly detail: string }[] }[] = [];
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

  it("(4) 正例：条件を持つ操作に期待 true の正常・false の異常・true の境界を書いた走りは、v1 の評価器（runTests）で照合され不一致 0・今までの門で full", async () => {
    const { reports, passed } = spyRuns();
    const { result, recording } = await runScenario([...head({ table: TABLE_ON }), structured(acceptAll())], flags);
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.summary.exit_code).toBe(0);
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) expect(report.mismatches).toEqual([]);
    for (const id of ["r3-normal", "r3-abnormal", "r3-boundary"]) expect(passed.at(-1)).toContain(id);
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    expect(t2.rules).toContainEqual(expect.stringContaining(PROPERTY_LEDGER.find((entry) => entry.id === "when")?.rules.t2 ?? "（無い）"));
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
  });

  const negatives = [
    { name: "期待に操作後の状態（写像）", expected: ok(JSON.stringify({ "f.item.kind": "beta" })) },
    { name: "期待が文字列", expected: ok(JSON.stringify("closed")) },
  ] as const;
  for (const entry of negatives) {
    it(`(2) 負例：${entry.name}の走りは、旗 on では T2' で 2 回とも落ちて B4 へ進まず full が出ない。旗 off は今までどおり B4 まで流れ「期待は真偽」の不一致`, async () => {
      const t2 = t2With(entry.expected);
      const on = await runScenario([structured(t1Of(LIST, TABLE_ON)), structured(acceptAll()), structured(t2), structured(t2)], flags);
      expect(on.result.stopped?.stage).toBe("test-spec");
      expect(on.result.outcome.verdict).not.toBe("full");
      expect(stageIds(on.result)).not.toContain("run-tests");
      expect(JSON.stringify(diagnosticOf(on.result.diagnostics, DIAGNOSTICS_REJECTED_TEST_SPEC_FILE))).toContain(WHEN_T2.messages.expected);
      const { reports } = spyRuns();
      const off = await runScenario([...head({ t2 }), structured(acceptAll()), repairDone(RUN_YAML), structured(acceptAll())]);
      expect(off.result.outcome.verdict).not.toBe("full");
      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0]!.mismatches.find((item) => item.testId === "r3-normal")?.detail).toContain("の期待は真偽（true / false）であること");
    });
  }

  it("(2) 負例：条件の無い操作（hasWhen 偽）に when の試験を書いた走りは、旗 on では T2' で 2 回とも落ちて B4 へ進まない（B4 の「条件が無く確かめられない」の前に止める）", async () => {
    const noWhen = rawTest({
      id: "r1-no-when",
      requirementId: "R1",
      targetKind: "operation",
      roleId: "o.addItem",
      operation: "action",
      observes: "when",
      expected: ok("true"),
    });
    const t2 = t2Response([...r1Tests(), noWhen, ...r2Tests(), ...r3Tests(), ...r4Tests()]);
    const on = await runScenario([structured(t1Of(LIST, TABLE_ON)), structured(acceptAll()), structured(t2), structured(t2)], flags);
    expect(on.result.stopped?.stage).toBe("test-spec");
    expect(stageIds(on.result)).not.toContain("run-tests");
    expect(JSON.stringify(diagnosticOf(on.result.diagnostics, DIAGNOSTICS_REJECTED_TEST_SPEC_FILE))).toContain(WHEN_T2.messages.target);
  });
});

// ── (u) 要件でない文（non-requirement。旗 on。§5 の負例。Issue #550）──────────────────────────────

describe("(u) 要件でない文：T1'' が受理した non-requirement の要件だけを残る一覧から除く（旗 on。§5 の負例。Issue #550）", () => {
  const flags: Partial<GenerationInputV11a> = { flags: { ledger: true } };
  const requirementOf = (id: string, text: string) => ({ id, text, quote: text, position: { start: 0, end: text.length } });
  /** 題材の一覧に要件 `id`（文 `text`）を足した一覧・確定した仕様・依頼文と、所属 0 行・non-requirement の表 */
  const materialsOf = (id: string, text: string) => {
    const base: RequirementList = { ...BASE_LIST, requirements: [...BASE_LIST.requirements, requirementOf(id, text)] };
    const plan = planOf(base);
    const table: NameTable = {
      ...TABLE_ON,
      ownership: [...TABLE_ON.ownership, { requirementId: id, roles: [] }],
      verification: [...TABLE_ON.verification, { requirementId: id, kind: "non-requirement" }],
      classification: [...TABLE_ON.classification, { requirementId: id, nature: "existence-only" }],
    };
    return {
      plan,
      list: requirementsFromPlan(plan),
      source: base.requirements.map((requirement) => requirement.text).join(""),
      table,
      ids: [...IDS, id] as const,
    };
  };
  const nonRequirementsOf = (bundle: AssembledBundle | null) => artifactOf(bundle, V11A_ARTIFACT_NAMES.carryOver)["non_requirements"];

  it("(1) 正例：前置き 1 件を non-requirement にし T1'' が受理、ほかの要件が通る走りは今までの門で full。T2 の要求の一覧・確かめ方にその要件が無く、持ち越しの記録の non_requirements にある", async () => {
    const m = materialsOf("R6", NON_REQUIREMENT_TEXT);
    const { result, recording } = await runScenario(
      [structured(t1Of(m.list, m.table)), structured(acceptAll(m.ids)), structured(t2Response()), structured({ declaration: RUN_YAML }), structured(acceptAll())],
      { ...flags, plan: m.plan, source: m.source },
    );
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.summary.exit_code).toBe(0);
    expect(carryEntriesOf(result.bundle)).toEqual([]);
    expect(nonRequirementsOf(result.bundle)).toEqual(["R6"]);
    expect(artifactOf(result.bundle, V11A_ARTIFACT_NAMES.carryOver)["remaining_requirement_ids"]).toEqual([...IDS]);
    expect(artifactOf(result.bundle, V11A_ARTIFACT_NAMES.carryOver)["excluded_row_ids"]).toEqual([]);
    // T1'' の対象のデータに kind つきで載る
    const semantic = recording.structured.find((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME)!;
    expect(dataBlockOf(semantic.input, "確かめ方")).toContainEqual({ requirementId: "R6", kind: "non-requirement" });
    // T2・B3' の要求の一覧・確かめ方に R6 が無い
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    expect((dataBlockOf(t2.input, "要件の一覧") as RequirementList).requirements.map((requirement) => requirement.id)).toEqual([...IDS]);
    expect((dataBlockOf(t2.input, "要件ごとの確かめ方") as readonly { requirementId: string }[]).map((entry) => entry.requirementId)).toEqual([...IDS]);
    expect(t2.input).not.toContain("non-requirement");
    const decl = recording.structured.find((request) => request.schemaName === DECL_CHECK_SCHEMA_NAME)!;
    expect(decl.input).not.toContain('"requirementId": "R6"');
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
  });

  it("(1') B1 の要件の一覧（PR #582 の独立レビュー F1）：T1'' が全件受理・B3' が残る 4 件を受理した走りで、B1 の要求の確定した仕様に R6 が無い。T2・B3'・B4（B6 と同じ評価の文脈）の一覧にも無く、⑦ は持ち越し 0 で full。旗 off の B1 の一覧は今までどおり全件", async () => {
    const m = materialsOf("R6", NON_REQUIREMENT_TEXT);
    const contexts: string[][] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      const evaluator = original(input);
      return {
        ...evaluator,
        runTests: (app, context, correspondence) => {
          contexts.push(context.list.requirements.map((requirement) => requirement.id));
          return evaluator.runTests(app, context, correspondence);
        },
      };
    });
    const { result, recording } = await runScenario(
      [structured(t1Of(m.list, m.table)), structured(acceptAll(m.ids)), structured(t2Response()), structured({ declaration: RUN_YAML }), structured(acceptAll())],
      { ...flags, plan: m.plan, source: m.source },
    );
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(nonRequirementsOf(result.bundle)).toEqual(["R6"]);
    const idsOf = (input: string, name: string) => (dataBlockOf(input, name) as RequirementList).requirements.map((requirement) => requirement.id);
    const write = recording.structured.find((request) => request.schemaName === WRITE_V11A_SCHEMA_NAME)!;
    const b1Ids = idsOf(write.input, WRITE_V11A_DATA_NAMES[0]);
    expect(b1Ids).toEqual([...IDS]);
    expect(write.input).not.toContain(NON_REQUIREMENT_TEXT);
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    expect(idsOf(t2.input, "要件の一覧")).toEqual([...IDS]);
    const decl = recording.structured.find((request) => request.schemaName === DECL_CHECK_SCHEMA_NAME)!;
    expect(decl.input).not.toContain('"requirementId": "R6"');
    expect(contexts.length).toBeGreaterThan(0);
    for (const ids of contexts) expect(ids).toEqual([...IDS]);
    expect(carryEntriesOf(result.bundle)).toEqual([]);
    // B1 の表の行は全行のまま（所属 0 行なので R6 の分の行は無い）
    const rows = dataBlockOf(write.input, WRITE_V11A_DATA_NAMES[1]) as readonly { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(m.table.rows.map((row) => row.id));
    // 旗 off：B1 の一覧は確定した仕様の全件のまま（題材の一覧で、持ち越しの R を含めて渡す今の契約）
    const off = await runScenario([...head(), structured(acceptAll())]);
    const offWrite = off.recording.structured.find((request) => request.schemaName === WRITE_V11A_SCHEMA_NAME)!;
    expect(idsOf(offWrite.input, WRITE_V11A_DATA_NAMES[0])).toEqual(LIST.requirements.map((requirement) => requirement.id));
  });

  for (const id of ["R6", "R:alt:x1"]) {
    it(`(2)(3) 負例：決まりのある要件（ID ${id}）を non-requirement に分類した走りは、T1'' の対象のデータに載り、拒否（2 回）で持ち越しになって full が出ない（ID の形で対象から外さない・受理を既定にしない）`, async () => {
      const m = materialsOf(id, RULED_AS_NON_REQUIREMENT_TEXT);
      const rejectIt = judgments(m.ids, { [id]: ["weak-verification", RULED_AS_NON_REQUIREMENT_QUOTE] });
      const { result, recording } = await runScenario(
        [
          structured(t1Of(m.list, m.table)),
          structured(rejectIt),
          structured(t1Of(m.list, m.table)),
          structured(rejectIt),
          structured(t2Response()),
          structured({ declaration: RUN_YAML }),
          structured(acceptAll()),
        ],
        { ...flags, plan: m.plan, source: m.source },
      );
      expect(result.stopped).toBeNull();
      expect(result.outcome.verdict).toBe("partial");
      expect(carryEntriesOf(result.bundle)).toEqual([{ requirementId: id, reasons: [{ origin: "semantic-check", reason: "weak-verification" }] }]);
      expect(nonRequirementsOf(result.bundle)).toBeUndefined();
      const semantics = recording.structured.filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME);
      expect(semantics).toHaveLength(2);
      for (const request of semantics) {
        expect(dataBlockOf(request.input, "確かめ方")).toContainEqual({ requirementId: id, kind: "non-requirement" });
        expect((dataBlockOf(request.input, "要件の文と引用") as { requirementId: string }[]).map((entry) => entry.requirementId)).toContain(id);
      }
    });
  }

  it("(4) 負例：了承した代替先の欠落（確定した仕様に R:alt: の要件があるのに、T1 の応答の確かめ方・所属・分類のどれからもその ID ごと抜けた）が 2 回続く走りは、T1' の完全性の検査で落ち、段 name-table・unmet で止まって full が出ない", async () => {
    const m = materialsOf("R:alt:x1", RULED_AS_NON_REQUIREMENT_TEXT);
    const draft = draftOf(m.list, m.table);
    const dropped = t1ResponseOf({ ...draft, requirements: draft.requirements.slice(0, -1) }, PROPERTY_LEDGER_VIEW);
    const { result, recording } = await runScenario([structured(dropped), structured(dropped)], { ...flags, plan: m.plan, source: m.source });
    expect(result.stopped?.stage).toBe("name-table");
    expect(result.stopped?.kind).toBe("unmet");
    expect(result.outcome.verdict).toBe("none");
    expect(schemaNames(recording.structured)).toEqual([NAME_TABLE_SCHEMA_NAME, NAME_TABLE_SCHEMA_NAME]);
    const messages = (result.stopped?.problems ?? []).map((problem) => problem.message);
    expect(messages).toContain("要件の所属が無い");
    expect(messages).toContain("要件の確かめ方が無い");
  });

  it("(5) 受理された non-requirement の要件 ID を T2 が試験に書けば「一覧に無い要件 ID」で 2 回とも落ち、段 test-spec で止まる（既存の検査）", async () => {
    const m = materialsOf("R6", NON_REQUIREMENT_TEXT);
    const t2 = t2Response([...r1Tests(), ...r2Tests(), ...r3Tests(), ...r4Tests(), rawTest({ id: "r6-x", requirementId: "R6", targetKind: "entity", roleId: "e.item", operation: "screen", observes: "existence", expected: ok("true") })]);
    const { result } = await runScenario(
      [structured(t1Of(m.list, m.table)), structured(acceptAll(m.ids)), structured(t2), structured(t2)],
      { ...flags, plan: m.plan, source: m.source },
    );
    expect(result.stopped?.stage).toBe("test-spec");
    expect(JSON.stringify(diagnosticOf(result.diagnostics, DIAGNOSTICS_REJECTED_TEST_SPEC_FILE))).toContain("一覧に無い要件 ID である");
  });

  it("持ち越しと要件でない文で全件なら、全件持ち越しと同じ段・種類で止まり、固定文は別（T2 を呼ばない）", async () => {
    const m = materialsOf("R6", NON_REQUIREMENT_TEXT);
    const rejectOthers = judgments(m.ids, Object.fromEntries(IDS.map((id) => [id, ["weak-verification", "項目"] as const])));
    const { result, recording } = await runScenario(
      [structured(t1Of(m.list, m.table)), structured(rejectOthers), structured(t1Of(m.list, m.table)), structured(rejectOthers)],
      { ...flags, plan: m.plan, source: m.source },
    );
    expect(result.stopped).toEqual({ stage: "carry-over", kind: "unmet", problems: [ALL_CARRIED_OR_NON_REQUIREMENT_PROBLEM] });
    expect(ALL_CARRIED_OR_NON_REQUIREMENT_PROBLEM.message).not.toBe(ALL_CARRIED_PROBLEM.message);
    expect(ALL_CARRIED_OR_NON_REQUIREMENT_PROBLEM.field).toBe(ALL_CARRIED_PROBLEM.field);
    expect(result.outcome.verdict).toBe("none");
    expect(schemaNames(recording.structured)).not.toContain(TEST_SPEC_SCHEMA_NAME);
  });

  it("旗 off では同じ表（non-requirement を持つ）は T1' で落ち（未登録の拒否）、full が出ない", async () => {
    const m = materialsOf("R6", NON_REQUIREMENT_TEXT);
    const plainTable: NameTable = { ...m.table, rows: TABLE.rows };
    const unregistered = negative(t1Of(m.list, plainTable), "旗 off の schema の確かめ方の kind の enum に non-requirement が無い。段の未登録の拒否を観測する負例");
    const { result } = await runScenario([structured(unregistered), structured(unregistered)], { plan: m.plan, source: m.source });
    expect(result.stopped?.stage).toBe("name-table");
    expect(result.outcome.verdict).toBe("none");
  });
});

describe("段単位の走り：範囲の外の段を呼ばず、納品物を組まず、境界の材料に B の結果を入れない", () => {
  it("終了 T1''：T2 以降を呼ばず、T1''／T2 の境界だけを返す", async () => {
    const recording = createCheckedRecordingClient(head().slice(0, 2));
    const outcome = await runStageRangeV11a({ ...inputOf(recording.client), range: { start: "name-table", end: "semantic-check" } });
    expect(outcome.stopped).toBeNull();
    expect(schemaNames(recording.structured)).toEqual([NAME_TABLE_SCHEMA_NAME, SEMANTIC_CHECK_SCHEMA_NAME]);
    expect(outcome.boundaries.map((boundary) => boundary.boundary)).toEqual(["t1-t2"]);
    expect(outcome.stages.map((record) => record.stage)).toEqual(["name-table", "semantic-check"]);
    expect(outcome.judgeVerdict).toBeNull();
    // 形で 1 度も落ちない走りは、断った候補の欄を持たない（Issue #683）
    expect(outcome).not.toHaveProperty("rejected");
  });

  it("段の走りの結果の断った候補は、一気通貫の診断と同じ形・同じ順。候補が無ければ欄を持たない（Issue #683）", async () => {
    const flags = { ledger: true, searchRepair: true, ids: true };
    const outputs = idsResponsesOf(LIST, TABLE_IDS, PROPERTY_LEDGER_VIEW);
    const raw = idsResponseList(outputs);
    const mapping = outputs.mapping as { readonly requirements: readonly unknown[] };
    const missingFirst = { requirements: mapping.requirements.slice(1) };
    const calls = [
      structured(raw[0]!),
      structured(raw[1]!),
      structured(raw[2]!),
      structured(missingFirst),
      structured(raw[3]!),
      structured(acceptAll()),
    ];
    const recording = createCheckedRecordingClient(calls);
    const stage = await runStageRangeV11a({ ...inputOf(recording.client), flags, range: { start: "name-table", end: "semantic-check" } });
    expect(stage.rejected).toHaveLength(1);
    expect(stage.rejected?.[0]).toMatchObject({ stage: "mapping", operation: null, call: 1, round: 1, attempt: 1, kind: "shape" });
    // 同じ台本の一気通貫の診断（同じ関数が組む候補の一覧）と深く等しい
    const { result } = await runScenario(
      [...calls, structured(renamed(t2Response())), structured({ declaration: RUN_YAML }), structured(acceptAll())],
      { flags },
    );
    expect(stage.rejected).toEqual(diagnosticOf(result.diagnostics, DIAGNOSTICS_REJECTED_MAPPING_FILE)["candidates"]);
    // 候補を段の判定・持ち越しに使わない（判定は今までどおり通る）
    expect(stage.stopped).toBeNull();
    expect(stage.stages.map((record) => record.stage)).toEqual(["vocabulary", "vocabulary", "vocabulary", "mapping", "semantic-check"]);
  });

  it("終了 ⑦：⑧（bundle）を呼ばず、⑦ の判定を別に返す。境界の持ち越しは B3' で増えた分を含まない", async () => {
    const recording = createCheckedRecordingClient([...head(), structured(judgments(IDS, REJECT_R3)), repairDone(RUN_YAML), structured(judgments(IDS, REJECT_R3))]);
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

  it("旗 v12.ids の終了 T1''：C1 の 3 束・C2・C3 だけを呼び、記録の段は範囲の段の内側。境界の checkpoint の形と照合は今と同じで、表の SHA は C2 が組んだ表に結ぶ（Issue #593）", async () => {
    const recording = createCheckedRecordingClient(idsHead().slice(0, 5));
    const flags = { ledger: true, searchRepair: true, ids: true };
    const outcome = await runStageRangeV11a({ ...inputOf(recording.client), flags, range: { start: "name-table", end: "semantic-check" } });
    expect(outcome.stopped).toBeNull();
    expect(schemaNames(recording.structured)).toEqual(["vocabulary-entities", "vocabulary-fields", "vocabulary-behaviors", "mapping", SEMANTIC_CHECK_SCHEMA_NAME]);
    expect(outcome.stages.map((record) => record.stage)).toEqual(["vocabulary", "vocabulary", "vocabulary", "mapping", "semantic-check"]);
    for (const record of outcome.stages) expect(stagesInRange("name-table", "semantic-check")).toContain(record.stage);
    const [boundary] = outcome.boundaries;
    expect(outcome.boundaries.map((entry) => entry.boundary)).toEqual(["t1-t2"]);
    if (boundary === undefined) return;
    expect(boundary.table).toEqual(MAPPED_IDS);
    expect(boundary.tableSha256).toBe(await nameTableSha256(MAPPED_IDS));
    expect(boundary.semanticCheck.tableSha256).toBe(boundary.tableSha256);
    // checkpoint は今と同じ形で組め、照合を通る（開始 T2 の入力として読める）
    const versions = { vocabulary: "v1", contract: "v0.2", prompt: "v1.1a", factory: "0.0.0" };
    const checkpoint = JSON.parse(stageJsonText(buildStageCheckpoint({ materials: boundary, versions, planSha256: "a".repeat(64), sourceSha256: "b".repeat(64) }))) as Record<string, unknown>;
    const record = { schema_version: STAGE_RUN_RECORD_SCHEMA, checkpoints: [{ boundary: "t1-t2", path: "cp.json", output_digest: await stageOutputDigest(checkpoint) }] };
    const verified = await verifyStageInput({
      start: "test-spec",
      checkpointText: stageJsonText(checkpoint),
      recordText: JSON.stringify(record),
      checkpointFile: "cp.json",
      plan: PLAN,
      planSha256: "a".repeat(64),
      sourceSha256: "b".repeat(64),
      vocabularyVersion: "v1",
      contractVersion: "v0.2",
    });
    expect(verified).toMatchObject({ ok: true });
  });

  it("通常の生成（範囲なし）は今までどおり納品物を組む", async () => {
    const { result } = await runScenario([...head(), structured(acceptAll())]);
    expect(result.bundle).not.toBeNull();
    expect(stageIds(result)).toContain("bundle");
  });

  it("開始 T2・B1 に再開の材料が無ければ、呼ばずに断る（呼ぶ側の誤り）", async () => {
    const recording = createCheckedRecordingClient([]);
    await expect(runStageRangeV11a({ ...inputOf(recording.client), range: { start: "test-spec", end: "judge" } })).rejects.toThrow();
    await expect(runStageRangeV11a({ ...inputOf(recording.client), range: { start: "write", end: "judge" } })).rejects.toThrow();
    expect(recording.structured).toHaveLength(0);
  });
});

describe("段の走りの判定した宣言と検証の数（⑦ を流したときだけ。工程ごとの評価 U3 の口。Issue #687）", () => {
  /** 静的チェックに落ちる宣言（B3・C7 を流さない） */
  const BROKEN_YAML = `${RUN_YAML}entities: [\n`;
  /** C7 で r4 の試験が不一致になる宣言 */
  const R4_BAD_YAML = replaced(RUN_YAML, "expression: base * 2", "expression: base * 3");

  /** 同じ台本を範囲 T1〜⑦ の段の走りと一気通貫に流す */
  async function both(calls: readonly RecordedCall[]) {
    const stage = await runStageRangeV11a({ ...inputOf(createCheckedRecordingClient(calls).client), range: { start: "name-table", end: "judge" } });
    const { result } = await runScenario(calls);
    return { stage, result };
  }

  /** 一気通貫の検証の記録（verification-v11a・verification）と要約・記録から、段の走りの検証の数が持つべき値を組む */
  function expectedOf(result: Awaited<ReturnType<typeof runScenario>>["result"]) {
    const v11a = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.verification);
    return {
      table_sha256: v11a["table_sha256"],
      test_suite_sha256: v11a["test_suite_sha256"],
      declaration_sha256: v11a["declaration_sha256"],
      checked_declaration_sha256s: v11a["checked_declaration_sha256s"],
      decl_check: v11a["decl_check"],
      stop_reason: result.summary.stop_reason,
      round_trips: countStage(result, "repair"),
    };
  }

  it("(1) 完走：宣言は最終版の原文と SHA-256・静的チェックの合否で、検証の数は一気通貫の検証の記録と同じ値。B3・C7・未解決は実測の 0 で、⑧ を呼ばない", async () => {
    const { stage, result } = await both([...head(), structured(acceptAll())]);
    expect(stage.judgeVerdict).toBe("full");
    expect(stage.declaration).toEqual({ source: RUN_YAML, sha256: await sha256Hex(RUN_YAML), staticCheckPassed: true });
    expect(stage.verification).toEqual({
      ...expectedOf(result),
      b3_misses: 0,
      c7_mismatches: 0,
      unresolved: 0,
      not_run: null,
    });
    expect(stage.verification?.stop_reason).toBe("completed");
    expect(stage.verification?.round_trips).toBe(0);
    expect(stage.verification?.decl_check).toEqual({ exhausted: 0, malformed: 0, rejected: 0 });
    expect(stage.stages.map((record) => record.stage)).not.toContain("bundle");
    // 宣言は一気通貫の納品物の宣言とバイト列で同じ
    expect(result.bundle?.artifacts.find((artifact) => artifact.path === DECLARATION_FILE)?.text).toBe(stage.declaration?.source);
    // 境界の材料には入れない
    for (const boundary of stage.boundaries) {
      expect(boundary).not.toHaveProperty("declaration");
      expect(boundary).not.toHaveProperty("verification");
    }
  });

  it("(2) 停滞で止めた走り：stop_reason stagnation で、未解決は停滞で足した不一致を含む（C7 の不一致と同じ数）", async () => {
    const { stage, result } = await both([...head({ yaml: R4_BAD_YAML }), structured(acceptAll()), repairDone(R4_BAD_YAML), structured(acceptAll())]);
    expect(result.summary.stop_reason).toBe("stagnation");
    const verification = stage.verification;
    expect(verification).toMatchObject({ ...expectedOf(result), b3_misses: 0, not_run: null, stop_reason: "stagnation", round_trips: 1 });
    expect(verification?.c7_mismatches).toBeGreaterThan(0);
    // 停滞の前の最後の版の C7 の不一致は、停滞で未解決に足される（版の未解決 0 に、足した分が載る）
    expect(verification?.unresolved).toBe(verification?.c7_mismatches);
    expect(artifactOf(result.bundle, VERIFICATION_FILE)["test_mismatches"]).toBe(verification?.c7_mismatches);
    expect(stage.declaration).toEqual({ source: R4_BAD_YAML, sha256: await sha256Hex(R4_BAD_YAML), staticCheckPassed: true });
  });

  it("(3) 最終版が静的チェックに落ちて判定 none の走り：宣言は落ちた版で、B3・C7・未解決は null と理由（⑦ の材料の代替の 1 を実測に写さない）", async () => {
    const { stage, result } = await both([...head({ yaml: BROKEN_YAML }), repairDone(BROKEN_YAML)]);
    expect(stage.judgeVerdict).toBe("none");
    expect(result.outcome.verdict).toBe("none");
    expect(stage.declaration).toEqual({ source: BROKEN_YAML, sha256: await sha256Hex(BROKEN_YAML), staticCheckPassed: false });
    expect(stage.verification).toEqual({
      ...expectedOf(result),
      b3_misses: null,
      c7_mismatches: null,
      unresolved: null,
      not_run: STAGE_VERIFICATION_NOT_RUN_STATIC_CHECK,
    });
    expect(stage.verification?.not_run).toBe("not-run:static-check");
    expect(stage.stages.map((record) => record.stage)).not.toContain("run-tests");
    expect(stage.stages.map((record) => record.stage)).not.toContain("name-check");
  });

  it("(4) 点検を使い切った走りは stop_reason limit、Plan へ戻した走り（差し戻し）は unresolved。差し戻しの走りも ⑦ を流したので欄を持つ", async () => {
    const limitCalls: RecordedCall[] = [...head(), structured(judgments(IDS, REJECT_R3))];
    for (let index = 1; index < 6; index += 1) {
      limitCalls.push(repairDone(RUN_YAML), structured(judgments(IDS, index % 2 === 1 ? REJECT_R4 : REJECT_R3)));
    }
    const limit = await both(limitCalls);
    expect(limit.stage.verification).toEqual({ ...expectedOf(limit.result), b3_misses: 0, c7_mismatches: 0, unresolved: 0, not_run: null });
    expect(limit.stage.verification).toMatchObject({ stop_reason: "limit", round_trips: 5, decl_check: { exhausted: 1, malformed: 0, rejected: 6 } });

    const back = await both([
      ...head(),
      structured(judgments(IDS, REJECT_R3)),
      repairDone(RUN_YAML, [dispute("r4-normal")]),
      arbitration([{ testId: "r4-normal", verdict: "return-to-plan" }]),
    ]);
    expect(back.stage.returnToPlan).toBe(true);
    expect(back.stage.verification).toMatchObject({ ...expectedOf(back.result), stop_reason: "unresolved", round_trips: 1, not_run: null });
    expect(back.stage.declaration?.sha256).toBe(await sha256Hex(RUN_YAML));
  });

  it("(5) ⑦ より前の早期停止（T1・T2・B3'）の走りは欄を持たない", async () => {
    const t1 = await runStageRangeV11a({
      ...inputOf(createCheckedRecordingClient([structured(t1Of(LIST, TABLE)), structured({ judgments: ["R1", "R2", "R3"].map((id) => ({ requirementId: id, verdict: "accept", kind: null, quote: null })) }), structured({ judgments: [] })]).client),
      range: { start: "name-table", end: "judge" },
    });
    const missing = acceptAll(["R1", "R2", "R3"]);
    const b3 = await runStageRangeV11a({
      ...inputOf(createCheckedRecordingClient([...head(), structured(missing), structured(missing)]).client),
      range: { start: "name-table", end: "judge" },
    });
    expect(b3.stopped?.stage).toBe("decl-check");
    expect(t1.stopped).not.toBeNull();
    for (const outcome of [t1, b3]) {
      expect(outcome.judgeVerdict).toBeNull();
      expect(outcome).not.toHaveProperty("declaration");
      expect(outcome).not.toHaveProperty("verification");
    }
    // 終了が ⑦ でない範囲も欄を持たない
    const t2 = await runStageRangeV11a({ ...inputOf(createCheckedRecordingClient(head().slice(0, 3)).client), range: { start: "name-table", end: "test-spec" } });
    expect(t2.stopped).toBeNull();
    expect(t2).not.toHaveProperty("declaration");
    expect(t2).not.toHaveProperty("verification");
  });

  it("(6) 範囲 test-spec..judge と write..judge（境界の材料から入る）でも、同じ台本の T1〜⑦ の走りと同じ宣言と検証の数", async () => {
    const calls = [...head({ yaml: R4_BAD_YAML }), structured(acceptAll()), repairDone(R4_BAD_YAML), structured(acceptAll())];
    const whole = await runStageRangeV11a({ ...inputOf(createCheckedRecordingClient(calls).client), range: { start: "name-table", end: "judge" } });
    const [t1t2, t2b1] = whole.boundaries;
    if (t1t2 === undefined || t2b1 === undefined) throw new Error("前提が壊れた：境界が無い");
    const { boundary: _a, ...fromT2 } = t1t2;
    const { boundary: _b, ...fromB1 } = t2b1;
    const t2 = await runStageRangeV11a({ ...inputOf(createCheckedRecordingClient(calls.slice(2)).client), range: { start: "test-spec", end: "judge" }, resume: fromT2 });
    const b1 = await runStageRangeV11a({ ...inputOf(createCheckedRecordingClient(calls.slice(3)).client), range: { start: "write", end: "judge" }, resume: fromB1 });
    for (const outcome of [t2, b1]) {
      expect(outcome.stopped).toBeNull();
      expect(outcome.declaration).toEqual(whole.declaration);
      expect(outcome.verification).toEqual(whole.verification);
    }
    expect(whole.verification?.stop_reason).toBe("stagnation");
  });
});

describe("範囲の無い走りの境界の材料（collectBoundaries。`--pipeline v1.2` の checkpoint のため。Issue #636）", () => {
  const IDS_FLAGS = { ledger: true, searchRepair: true, ids: true };
  const fullCalls = (): RecordedCall[] => [...idsHead(), structured(acceptAll())];
  /** 境界の材料を JSON の値にそろえる（Map を並びに） */
  const plainOf = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value, (_key, inner: unknown) => (inner instanceof Map ? [...inner] : inner)));

  it("省けば結果に boundaries の欄が無い（v1.1α・旗 ids on のどちらも。結果は今のまま）", async () => {
    const plain = await runScenario([...head(), structured(acceptAll())]);
    expect(plain.result).not.toHaveProperty("boundaries");
    const ids = await runScenario(fullCalls(), { flags: IDS_FLAGS, recordV12Flags: true });
    expect(ids.result).not.toHaveProperty("boundaries");
  });

  it("完走：2 つの境界を通った順に返し、材料は段の走り（T1〜⑦）の境界と同じ。合否・要約・記録・納品物・診断は集めない走りと同じ", async () => {
    const without = await runScenario(fullCalls(), { flags: IDS_FLAGS, recordV12Flags: true });
    const withBoundaries = await runScenario(fullCalls(), { flags: IDS_FLAGS, recordV12Flags: true, collectBoundaries: true });
    expect(withBoundaries.result.outcome.verdict).toBe("full");
    const { boundaries, ...rest } = withBoundaries.result;
    expect(rest).toEqual(without.result);
    expect(boundaries?.map((entry) => entry.boundary)).toEqual(["t1-t2", "t2-b1"]);
    expect(boundaries?.[0]).not.toHaveProperty("testSpec");
    expect(boundaries?.[1]?.testSpec?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(withBoundaries.recording.structured.map((request) => JSON.stringify(request))).toEqual(
      without.recording.structured.map((request) => JSON.stringify(request)),
    );
    const recording = createCheckedRecordingClient(fullCalls());
    const stage = await runStageRangeV11a({ ...inputOf(recording.client), flags: IDS_FLAGS, range: { start: "name-table", end: "judge" } });
    expect(plainOf(boundaries)).toEqual(plainOf(stage.boundaries));
  });

  it("表を組む段（C1）で止まった走りは空、T2 で止まった走りは T1''／T2 の境界だけ", async () => {
    const broken = { entities: [{ name: "1member", role: "名前の規則に合わない行" }] };
    const atTable = await runScenario([structured(broken), structured(broken)], { flags: IDS_FLAGS, collectBoundaries: true });
    expect(atTable.result.stopped).toMatchObject({ stage: "vocabulary" });
    expect(atTable.result.boundaries).toEqual([]);
    const badT2 = idsHead({ t2: idsT2Response([], []) }).slice(0, 6);
    const atT2 = await runScenario([...badT2, badT2[5]!], { flags: IDS_FLAGS, collectBoundaries: true });
    expect(atT2.result.stopped).toMatchObject({ stage: "test-spec" });
    expect(atT2.result.bundle).toBeNull();
    expect(atT2.result.boundaries?.map((entry) => entry.boundary)).toEqual(["t1-t2"]);
  });
});

describe("段の走りの結果の v12Calls・testSpec（`--pipeline v1.2` の段の走りの記録の材料。Issue #637）", () => {
  const IDS_FLAGS = { ledger: true, searchRepair: true, ids: true };

  it("旗 ids の段の走りは門と枝の数を返し、T2 を回して T2' を通れば組の試験・外した試験・網羅の単位の数を返す（t2-b1 の組と一致）", async () => {
    const recording = createCheckedRecordingClient(idsHead().slice(0, 6));
    const outcome = await runStageRangeV11a({ ...inputOf(recording.client), flags: IDS_FLAGS, range: { start: "name-table", end: "test-spec" } });
    expect(outcome.stopped).toBeNull();
    expect(outcome.v12Calls).toMatchObject({ real_attempts: { limit: V12_CALL_LIMITS.realAttempts }, judge_branch: { limit: V12_CALL_LIMITS.judgeBranch } });
    const frozen = outcome.boundaries.find((entry) => entry.boundary === "t2-b1")?.testSpec;
    expect(outcome.testSpec).toEqual({ tests: frozen?.suite.tests.length, dropped_tests: 0, coverage_units: frozen?.coverage.length });
  });

  it("T2 に届かない（区間 0 で終わる）走りは testSpec を持たず、旗 off（v1.1a）の段の走りは v12Calls を持たない", async () => {
    const idsRecording = createCheckedRecordingClient(idsHead().slice(0, 5));
    const segment0 = await runStageRangeV11a({ ...inputOf(idsRecording.client), flags: IDS_FLAGS, range: { start: "name-table", end: "semantic-check" } });
    expect(segment0).toHaveProperty("v12Calls");
    expect(segment0).not.toHaveProperty("testSpec");
    const plainRecording = createCheckedRecordingClient(head().slice(0, 3));
    const plain = await runStageRangeV11a({ ...inputOf(plainRecording.client), range: { start: "name-table", end: "test-spec" } });
    expect(plain).not.toHaveProperty("v12Calls");
    expect(plain.testSpec?.dropped_tests).toBe(0);
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
    for (const extra of [
      {},
      { flags: {} },
      { flags: { ledger: false } },
      { flags: { searchRepair: false } },
      { flags: { ledger: false, searchRepair: false } },
    ] as const) {
      const captures = await captureBaselineV11a(moduleWith(extra), BASELINE_DEFINITIONS);
      expect(captures, JSON.stringify(extra)).toEqual(BASELINE_LIBRARY.captures);
    }
  });
});

/** 走りの台帳の導出を #548 の台帳（empty-aggregate の行を除いた導出）にする（#548 までの旗 on を今の候補で再現する。Issue #549） */
const asLedger2B = () =>
  vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? LEDGER_VIEW_2B : undefined));
/** 走りの台帳の導出を #549 の台帳（手 2d の前）にする（#549 までの旗 on を今の候補で再現する。Issue #550） */
const asLedger2C = () =>
  vi.spyOn(ledgerModule, "ledgerViewOf").mockImplementation((flags) => (flags.ledger ? LEDGER_VIEW_2C : undefined));

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

  it("#549 の台帳の on と #548 の台帳の on の差は empty-aggregate の行の分だけ：手 2p の library 4 経路（T1 の応答の計算の行に集計の種類と集計元を足した写し）で、要求の差は名指しの場所（R-nt-08・R-tsp-16・R-w11 の並び・schema の行の型の aggregate・observes の enum・表を載せるデータ）だけで、その分を除けば #548 の on とバイト列で同じ。判定・段の記録・要約・道具の結果・結び付けは同じで、納品物・診断の差は表の aggregate と表の SHA の分だけ", async () => {
    const nowResults: Awaited<ReturnType<typeof runGenerationV11a>>[] = [];
    // #549 までの旗 on（台帳の when の列が未定義・non-requirement の行が無い）を今の候補で流す（Issue #550）
    const spy2C = asLedger2C();
    const now = await captureBaselineV11a(moduleCollecting({ flags: { ledger: true } }, nowResults), BASELINE_DEFINITIONS_ON);
    spy2C.mockRestore();
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

  it("内外の切り分けの型：負例 (c)①（同じ要件を validation の観測で確かめる経路 3）は #549 の台帳の on でも「対応表の外」の不一致のまま", async () => {
    // 今の台帳の on は、経路 3 の (a)③ の試験（期待に操作後の状態）を T2' で落とすので B4 へ進まない（下の手 2d の試験。Issue #550）
    asLedger2C();
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

describe("手 2d の差：今の台帳の on と #549 の台帳の on の差は when・non-requirement の行の分だけ（Issue #550）", () => {
  /** 経路 3（carry-over-stagnation）の位置。T2 の応答に (a)③ の試験（期待に操作後の状態を書いた操作の試験）を持つ */
  const STAGNATION = BASELINE_DEFINITIONS.scenarios.findIndex((scenario) => scenario.name === "carry-over-stagnation");
  const requestOf = (record: unknown) => (record as { readonly request: unknown }).request;

  it("経路 3 のほか（full・name-table-stop・repair-full）は、要求の差が名指しの場所（R-nt-08・R-sc-02・R-tsp-16・T1 の schema の確かめ方の種類の enum）だけで、その分を除けば #549 の on とバイト列で同じ。判定の問い・道具の結果・試験の結果・納品物・診断・判定は同じ", async () => {
    expect(STAGNATION).toBeGreaterThanOrEqual(0);
    const now = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS_ON);
    asLedger2C();
    const before = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS_ON);
    expect(now).toHaveLength(before.length);
    let compared = 0;
    now.forEach((capture, index) => {
      if (index === STAGNATION) return;
      compared += 1;
      const expected = before[index]!;
      expect(capture.requests, capture.name).toHaveLength(expected.requests.length);
      const diffs = requestDiffsOf(capture.requests.map(requestOf), expected.requests.map(requestOf));
      for (const diff of diffs) {
        expect(diff.paths, `${capture.name} ${diff.schemaName}`).toEqual(WHEN_NON_REQUIREMENT_REQUEST_DIFF[diff.schemaName] ?? []);
      }
      // T1 を呼ぶ走りでは、T1 の要求に差がある（差は空でない）
      expect(diffs.some((diff) => diff.paths.length > 0), capture.name).toBe(true);
      expect(JSON.stringify(withoutWhenAndNonRequirement(capture.requests)), capture.name).toBe(JSON.stringify(expected.requests));
      const { requests: _now, ...rest } = capture;
      const { requests: _before, ...expectedRest } = expected;
      expect(rest, capture.name).toEqual(expectedRest);
    });
    expect(compared).toBe(now.length - 1);
  });

  it("差は空でない：今の台帳の on の T1・T1''・T2 の要求に when の T2 の文と non-requirement の T1・T1'' の文・種類があり、#549 の台帳の on には無い", async () => {
    const now = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS_ON);
    asLedger2C();
    const before = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS_ON);
    const when = PROPERTY_LEDGER.find((entry) => entry.id === "when")!;
    const non = PROPERTY_LEDGER.find((entry) => entry.id === "non-requirement")!;
    const full = JSON.stringify(now[0]!.requests);
    const previous = JSON.stringify(before[0]!.requests);
    for (const text of [when.rules.t2, non.rules.t1, non.rules.t1Acceptance]) {
      expect(text).not.toBeNull();
      expect(full).toContain(JSON.stringify(text).slice(1, -1));
      expect(previous).not.toContain(JSON.stringify(text).slice(1, -1));
    }
    expect(full).toContain('"non-requirement"');
    expect(previous).not.toContain("non-requirement");
  });

  it("(3) (a)③ の型：経路 3 の T2 の応答（期待に操作後の状態を書いた操作の試験 r3-operation-state）を 2 回続けた走りは、旗 on では T2' で落ちて B4 へ進まない。直す前（#549 の台帳の on）は、記録の経路 3 のまま B4 の不一致「期待は真偽」", async () => {
    const scenario = BASELINE_DEFINITIONS_ON.scenarios[STAGNATION]!;
    const t2At = (scenario.recorded as readonly { readonly output?: unknown }[]).findIndex(
      (call) => call.output !== null && typeof call.output === "object" && "tests" in (call.output as object),
    );
    expect(t2At).toBeGreaterThan(0);
    const t2Call = scenario.recorded[t2At]!;
    const stateTest = ((t2Call as { readonly output: { readonly tests: readonly Record<string, unknown>[] } }).output.tests).find(
      (test) => test["id"] === "r3-operation-state",
    );
    if (stateTest === undefined) throw new Error("前提が壊れた：経路 3 に r3-operation-state が無い");
    expect(stateTest["observes"]).toBe("when");
    expect(JSON.parse((stateTest["expected"] as { value: string }).value)).toEqual({ "f.item.kind": "beta" });
    const twice: BaselineV11aScenarios = {
      ...BASELINE_DEFINITIONS_ON,
      scenarios: [{ ...scenario, recorded: [...scenario.recorded.slice(0, t2At + 1), t2Call] }],
    } as BaselineV11aScenarios;
    const onResults: Awaited<ReturnType<typeof runGenerationV11a>>[] = [];
    const [on] = await captureBaselineV11a(moduleCollecting({ flags: { ledger: true } }, onResults), twice);
    expect(on!.judgment.outcome).toEqual({ result: "failed", verdict: "none" });
    expect(on!.testRun).toBeNull();
    expect(on!.requests.map(requestOf).filter((request) => (request as { schemaName?: string }).schemaName === TEST_SPEC_SCHEMA_NAME)).toHaveLength(2);
    const when = PROPERTY_LEDGER.find((entry) => entry.id === "when")!;
    expect(onResults[0]?.stopped?.stage).toBe("test-spec");
    expect(stageIds(onResults[0]!)).not.toContain("run-tests");
    const rejected = diagnosticOf(onResults[0]!.diagnostics, DIAGNOSTICS_REJECTED_TEST_SPEC_FILE);
    expect(JSON.stringify(rejected)).toContain(when.t2Condition?.messages.expected ?? "（無い）");
    // 直す前（#549 の台帳の on）：記録の経路 3 のまま T2 を通り、B4 の不一致に「期待は真偽」が出る
    asLedger2C();
    const before = await captureBaselineV11a(moduleWith({ flags: { ledger: true } }), BASELINE_DEFINITIONS_ON);
    const stagnation = before[STAGNATION]?.testRun as { readonly mismatches: readonly { readonly testId: string; readonly detail: string }[] };
    expect(stagnation.mismatches.find((entry) => entry.testId === "r3-operation-state")?.detail).toContain("の期待は真偽（true / false）であること");
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
  it("recordV12Flags が真の走りは、完走でも表を組む段（ids on は C1）で止まる走りでも、要約に実効の旗の組 v12_flags がある（納品物の要約にも）", async () => {
    const extra = { flags: fromPublicV12Flags(V12_PIPELINE_FLAGS), recordV12Flags: true };
    // 旗の組は ids を含む（Issue #593 で表を組む段が C1・C2 になった）ので、C1・C2 の応答で流す
    const full = await runScenario([...idsHead(), structured(acceptAll())], extra);
    expect(full.result.outcome.verdict).toBe("full");
    expect((full.result.summary as unknown as Record<string, unknown>)["v12_flags"]).toEqual(V12_PIPELINE_FLAGS);
    const summaryFile = full.result.bundle?.artifacts.find((artifact) => artifact.path === "artifacts/summary.json");
    expect((JSON.parse(summaryFile?.text ?? "{}") as Record<string, unknown>)["v12_flags"]).toEqual(V12_PIPELINE_FLAGS);
    const broken = { entities: [{ name: "1member", role: "名前の規則に合わない行" }] };
    const stopped = await runScenario([structured(broken), structured(broken)], extra);
    expect(stopped.result.stopped).toMatchObject({ stage: "vocabulary", kind: "unmet" });
    expect((stopped.result.summary as unknown as Record<string, unknown>)["v12_flags"]).toEqual(V12_PIPELINE_FLAGS);
  });

  it("recordV12Flags を省いた走り（旗 on でも）・旗を省いた走りの要約に v12_flags が無い", async () => {
    for (const extra of [{}, { flags: { ledger: true } }] as const) {
      const { result } = await runScenario([...head(extra.flags === undefined ? {} : { table: TABLE_ON }), structured(acceptAll())], extra);
      expect(result.summary, JSON.stringify(extra)).not.toHaveProperty("v12_flags");
    }
  });

  it("正本の旗の組は旗の名前を全部持ち（merge 済みの手の旗は全部 on）、省いた名前は off に解く", () => {
    expect(Object.keys(V12_PIPELINE_FLAGS)).toEqual([...V12_PUBLIC_FLAG_NAMES]);
    for (const name of V12_FLAG_NAMES) expect(V12_PIPELINE_FLAGS[V12_FLAG_PUBLIC_NAMES[name]]).toBe(true);
    expect(resolveV12Flags()).toEqual({ ledger: false, searchRepair: false, ids: false });
    expect(resolveV12Flags({})).toEqual({ ledger: false, searchRepair: false, ids: false });
    expect(resolveV12Flags(fromPublicV12Flags(V12_PIPELINE_FLAGS))).toEqual({ ledger: true, searchRepair: true, ids: true });
    expect(factoryModule.V12_PIPELINE_FLAGS).toBe(V12_PIPELINE_FLAGS);
  });
});

// ── 探索型の直し（旗 v12.search-repair。手 4a。Issue #551）──────────────────────────────
//
// 偽物の LLM の台本で版の違反の数を作る。R1 の検査（validate）の式を替えると、R1 の 3 本（正常 5・異常 -1・境界 1）のうち
// 落ちる本数が決まる：`> 1` は境界だけ（1）、`> -5` は異常だけ（1）、`> 5`・`> 7` は正常と境界（2）、`< 0` は 3 本とも（3）。
// B3' の拒否は R3・R4 だけを最後まで残す（R1・R2 を持ち越すと持ち越しの関数が断る。上の REJECT_R* の注記）。

const SEARCH: Partial<GenerationInputV11a> = { flags: { searchRepair: true } };

// 手 4a の台本の失敗は、場所に写らない種類にする（手 4b。Issue #553）。旗 on の往復は、一番良い版の失敗が全部宣言の要素の場所に
// 写せると欄だけの直し（構造化出力）を呼ぶので、手 4a の直す手（道具付き）の筋を固定するこの節の台本は、どの往復にも場所なしの
// 失敗を 1 件以上残す：
//   - R1 の検査の試験の対象を、項目の行（f.item.amount）から entity の行（e.item）に替える（entity の行は置き換えの単位でない＝
//     場所なし `no-element`）。結び付けは entity の行の名前と同じ名前の検査を探すので、宣言の検査の名前を item にする
//   - (e)・(e'') の R4 の筋は、R4 が entity の行（e.item）も所属させる表にし、1 版目の B3' で R4 を拒否する（拒否は要件が所属させた
//     行から写すので場所なし）。R4 は棄却のあとの網羅で持ち越しになり、数え直しで拒否は外れる
// この節の `RUN_YAML` は、検査の名前を item にした宣言（各 describe の先頭で同じ名前に置く）。期待は手 4a のまま変えない。
// 場所に写る同じ筋は、下の「欄だけの直し（旗 v12.search-repair・手 4b）」で固定する。
const SEARCH_YAML = replaced(RUN_YAML, "  - name: amount\n    entity: item\n", "  - name: item\n    entity: item\n");
/** R1 の検査の試験の対象を entity の行にした T2 の応答（ほかの試験は既定のまま） */
const searchT2 = () =>
  t2Response([
    ...r1Tests().map((test) => ({ ...test, target: { requirementId: "R1", kind: "entity", roleId: "e.item" } })),
    ...r2Tests(),
    ...r3Tests(),
    ...r4Tests(),
  ]);
/** この節の T1・T1''・T2・B1 の記録 */
const searchHead = (options: { readonly yaml?: string; readonly table?: NameTable } = {}): RecordedCall[] =>
  head({ yaml: SEARCH_YAML, ...options, t2: searchT2() });
/** R4 が entity の行（e.item）も所属させる表（R4 の拒否を場所なしにする） */
const TABLE_R4_ENTITY: NameTable = {
  ...TABLE,
  ownership: TABLE.ownership.map((entry) =>
    entry.requirementId === "R4" ? { ...entry, roles: [...entry.roles, { id: "e.item", basis: "stated" as const, reason: null }] } : entry,
  ),
};
const validationAs = (expression: string): string => replaced(SEARCH_YAML, "expression: amount > 0", `expression: ${expression}`);
/** 不一致 1（境界だけ） */
const MIS1 = validationAs("amount > 1");
/** 不一致 1（異常だけ。MIS1 と同数の別の版） */
const MIS1B = validationAs("amount > -5");
/** 不一致 2（正常と境界） */
const MIS2 = validationAs("amount > 5");
/** 不一致 2（MIS2 と同数の別の版） */
const MIS2B = validationAs("amount > 7");
/** 不一致 3 */
const MIS3 = validationAs("amount < 0");

/** データの塊の中身（JSON にしない原文） */
function rawDataBlockOf(input: string, name: string): string {
  const match = new RegExp(`<data name="${name}">\\n([\\s\\S]*?)\\n</data>`).exec(input);
  if (match === null) throw new Error(`データの塊が無い: ${name}`);
  return match[1] ?? "";
}
const repairDeclarations = (tools: readonly LlmToolRequest[]): readonly string[] =>
  tools.map((request) => rawDataBlockOf(request.input, "宣言"));
const writeRequests = (requests: readonly LlmStructuredRequest[]): readonly LlmStructuredRequest[] =>
  requests.filter((request) => request.schemaName === WRITE_V11A_SCHEMA_NAME);
const declarationOf = (bundle: AssembledBundle | null): string =>
  bundle?.artifacts.find((artifact) => artifact.path === DECLARATION_FILE)?.text ?? "";

interface SearchVersionJson {
  readonly origin: string;
  readonly declaration_sha256: string;
  readonly violations: { readonly kind: string; readonly known_total?: number; readonly breakdown?: Record<string, number | null> };
  readonly adopted: boolean;
  readonly discarded: { readonly unmarked: readonly string[]; readonly rejections: number } | null;
}
interface SearchJson {
  readonly versions: readonly SearchVersionJson[];
  readonly recounts: readonly { readonly cause: string; readonly declaration_sha256: string; readonly violations: SearchVersionJson["violations"] }[];
  readonly best_declaration_sha256: string;
  readonly rewritten: boolean;
}
const searchOf = (bundle: AssembledBundle | null): SearchJson =>
  artifactOf(bundle, V12_SEARCH_REPAIR_ARTIFACT_NAME) as unknown as SearchJson;
const shaOf = (source: string): Promise<string> => sha256Hex(source);

describe("探索型の直し（旗 v12.search-repair）：一番良い版・厳密な減少・停滞での作り直し", () => {
  const RUN_YAML = SEARCH_YAML;
  it("(a) 不一致 2 → 1 の版を採り、次の直す段の入力がその版。0 の版で full", async () => {
    const { result, recording } = await runScenario(
      [
        ...searchHead({ yaml: MIS2 }),
        structured(acceptAll()),
        repairDone(MIS1),
        structured(acceptAll()),
        repairDone(RUN_YAML),
        structured(acceptAll()),
      ],
      SEARCH,
    );
    expect(repairDeclarations(recording.tools)).toEqual([MIS2, MIS1]);
    expect(result.outcome.verdict).toBe("full");
    const search = searchOf(result.bundle);
    expect(search.versions.map((version) => [version.origin, version.violations.known_total, version.adopted])).toEqual([
      ["write", 2, true],
      ["repair", 1, true],
      ["repair", 0, true],
    ]);
    expect(search.best_declaration_sha256).toBe(await shaOf(RUN_YAML));
    expect(search.rewritten).toBe(false);
  });

  it("(b)(c) 不一致 1 のあとの不一致 2 の版・同数の版は採らず、次の入力が不一致 1 の版。2 つ採れなければ B1 をもう 1 回呼び、作り直しのあと 2 つ採れなければ stagnation で止め、最終の版は一番良い版", async () => {
    const { result, recording } = await runScenario(
      [
        ...searchHead({ yaml: MIS2 }),
        structured(acceptAll()),
        repairDone(MIS1),
        structured(acceptAll()),
        repairDone(MIS2B),
        structured(acceptAll()),
        repairDone(MIS1B),
        structured(acceptAll()),
        // 作り直し（B1 の 2 回目）
        structured({ declaration: MIS3 }),
        structured(acceptAll()),
        repairDone(MIS2),
        structured(acceptAll()),
      ],
      SEARCH,
    );
    // 直す段の入力の宣言：不一致 2 の版のあとは、採った不一致 1 の版だけ（捨てた版を渡さない）
    expect(repairDeclarations(recording.tools)).toEqual([MIS2, MIS1, MIS1, MIS1]);
    const best = await shaOf(MIS1);
    for (const request of recording.tools.slice(1)) {
      expect(await shaOf(rawDataBlockOf(request.input, "宣言"))).toBe(best);
    }
    // 作り直しは 1 回だけ（B1 は 2 回）。そのあとの停滞で B1 を呼ばない
    expect(writeRequests(recording.structured)).toHaveLength(2);
    expect(countStage(result, "write")).toBe(2);
    expect(result.summary.stop_reason).toBe("stagnation");
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.outcome.verdict).toBe("partial");
    // 最終の版（納品物の宣言）は一番良い版で、最後に評価した版ではない
    expect(declarationOf(result.bundle)).toBe(MIS1);
    const verification = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.verification);
    expect(verification["declaration_sha256"]).toBe(best);
    const search = searchOf(result.bundle);
    expect(search.versions.map((version) => [version.origin, version.violations.known_total, version.adopted])).toEqual([
      ["write", 2, true],
      ["repair", 1, true],
      ["repair", 2, false],
      ["repair", 1, false],
      ["rewrite", 3, false],
      ["repair", 2, false],
    ]);
    expect(search.best_declaration_sha256).toBe(best);
    expect(search.rewritten).toBe(true);
    // 材料の状態の宣言の版も一番良い版（最後に静的チェックを通った版ではない）
    const materials = artifactOf(result.bundle, VERIFICATION_FILE)["materials"] as readonly { material: string; version?: { sha256: string } }[];
    expect(materials.find((entry) => entry.material === "declaration")?.version?.sha256).toBe(best);
  });

  it("(c) 作り直しの要求：前の版の宣言の原文・直す段の会話が無く、名前付きの失敗の一覧（試験 ID・要件 ID・種類・固定文）がある。最初の B1 の要求との差は末尾のデータと規則 1 つだけ", async () => {
    const { result, recording } = await runScenario(
      [
        ...searchHead({ yaml: MIS1 }),
        structured(acceptAll()),
        repairDone(MIS2),
        structured(acceptAll()),
        repairDone(MIS1B),
        structured(acceptAll()),
        structured({ declaration: RUN_YAML }),
        structured(acceptAll()),
      ],
      SEARCH,
    );
    // 作り直した版は厳密に良ければ採り、full まで進めば full
    expect(result.outcome.verdict).toBe("full");
    expect(declarationOf(result.bundle)).toBe(RUN_YAML);
    const [first, rewrite] = writeRequests(recording.structured);
    if (first === undefined || rewrite === undefined) throw new Error("前提が壊れた：B1 が 2 回呼ばれていない");
    expect(dataBlockOf(rewrite.input, WRITE_V11A_REWRITE_DATA_NAME)).toEqual([
      { testId: "r1-boundary", requirementId: "R1", kind: "test-mismatch", message: NAMED_FAILURE_MESSAGES["test-mismatch"] },
    ]);
    for (const previous of [MIS1, MIS2, MIS1B]) expect(rewrite.input).not.toContain(previous.split("\n").find((line) => line.includes("expression: amount")) ?? "");
    for (const name of ["宣言", "原文", "試験の結果", "対応表の落ち", repairStage.DECLARATION_REJECTIONS_DATA_NAME]) {
      expect(rewrite.input).not.toContain(`<data name="${name}">`);
    }
    expect(JSON.stringify(rewrite)).not.toContain("disputes");
    expect(rewrite.input.startsWith(first.input)).toBe(true);
    expect(rewrite.rules).toEqual([...(first.rules ?? []), ...WRITE_V11A_REWRITE_RULE_DEFINITIONS.map((definition) => definition.text)]);
    expect(rewrite.schema).toEqual(first.schema);
    expect(rewrite.instructions).toBe(first.instructions);
    expect(rewrite.documents).toEqual(first.documents);
    // 試験は固定のまま（作り直しの B1 も固定した試験を変えない）
    expect(dataBlockOf(rewrite.input, WRITE_V11A_DATA_NAMES[2])).toEqual(dataBlockOf(first.input, WRITE_V11A_DATA_NAMES[2]));
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
    expectNoAcceptanceMaterial(recording.tools.map((request) => JSON.stringify(request)));
  });

  it("(d) 往復と点検の上限：点検 6 で limit（7 回目の点検も次の直す段も無い）、不一致が残った最終の版で full が出ない", async () => {
    const calls: RecordedCall[] = [
      ...searchHead({ yaml: MIS3 }),
      structured(judgments(IDS, { ...REJECT_R3, ...REJECT_R4 })), // 5
      repairDone(MIS2),
      structured(judgments(IDS, { ...REJECT_R3, ...REJECT_R4 })), // 4
      repairDone(MIS2B),
      structured(judgments(IDS, REJECT_R4)), // 3
      repairDone(MIS1),
      structured(judgments(IDS, REJECT_R4)), // 2
      repairDone(MIS1B),
      structured(acceptAll()), // 1
      repairDone(MIS1),
      structured(acceptAll()), // 1（同数。採らない）
    ];
    const { result, recording } = await runScenario(calls, SEARCH);
    expect(countStage(result, "decl-check")).toBe(6);
    expect(countStage(result, "repair")).toBe(5);
    expect(recording.tools).toHaveLength(5);
    expect(writeRequests(recording.structured)).toHaveLength(1);
    expect(result.summary.stop_reason).toBe("limit");
    // 不一致が残ったまま上限で止めた版は v1 と同じ門で失敗に倒す（full も partial も出ない。終了コード 1）
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.outcome).toEqual({ result: "failed", verdict: "none" });
    expect(result.summary.exit_code).toBe(1);
    expect(declarationOf(result.bundle)).toBe(MIS1B);
    expect(artifactOf(result.bundle, V11A_ARTIFACT_NAMES.verification)["decl_check"]).toEqual({ exhausted: 1, malformed: 0, rejected: 6 });
    // 旗 off の v1.1α でも、同じ台本は同じ上限で止まり、不一致が残る最終の版を同じ ⑦ で failed・none にする（門は旗で変わらない）
    const off = await runScenario(calls);
    expect(off.result.summary.stop_reason).toBe("limit");
    expect(off.result.outcome).toEqual(result.outcome);
    expect(off.result.summary.exit_code).toBe(1);
    expect(artifactOf(off.result.bundle, VERIFICATION_FILE)["test_mismatches"]).toBeGreaterThan(0);
  });

  it("(d) 共通の口の呼び出しの上限は今までどおりの早期停止（旗 off と同じ段・種類で止まり、納品物を作らない）", async () => {
    const calls = [...searchHead({ yaml: MIS2 }), structured(acceptAll()), repairDone(MIS1), structured(acceptAll())];
    const limits = { ...factoryModule.AGENT_LIMITS, callCount: 6 };
    const on = await runScenario(calls, { ...SEARCH, limits });
    const off = await runScenario(calls, { limits });
    expect(on.result.stopped).toEqual(off.result.stopped);
    expect(on.result.stopped?.kind).toBe("call-limit");
    expect(on.result.bundle).toBeNull();
    expect(on.result.outcome.verdict).toBe("none");
    expect(on.result.summary.exit_code).toBe(1);
  });

  it("(e) 棄却（B6）で組が変わると、一番良い版の数がコードの検査だけで数え直され、判定・点検の呼び出しが旗 off と同じ数", async () => {
    const r4Bad = replaced(RUN_YAML, "expression: base * 2", "expression: base * 3");
    const r4Tests = ["r4-normal", "r4-abnormal", "r4-boundary"];
    const calls = [
      ...searchHead({ yaml: r4Bad, table: TABLE_R4_ENTITY }),
      structured(judgments(IDS, REJECT_R4)),
      repairDone(RUN_YAML, r4Tests.map(dispute)),
      arbitration(r4Tests.map((testId) => ({ testId, verdict: "overturn" }))),
      structured(acceptAll(["R1", "R2", "R3"])),
    ];
    const on = await runScenario(calls, SEARCH);
    const off = await runScenario(calls);
    expect(on.recording.structured).toHaveLength(off.recording.structured.length);
    expect(on.recording.tools).toHaveLength(off.recording.tools.length);
    expect(countStage(on.result, "decl-check")).toBe(countStage(off.result, "decl-check"));
    expect(countStage(on.result, "arbitration")).toBe(1);
    // 数え直し（棄却のあとの網羅の直後）は B3・B4 だけ（静的チェック・B3' を呼ばない）
    const stages = stageIds(on.result);
    const at = stages.indexOf("coverage");
    expect(stages.slice(at + 1, at + 4)).toEqual(["name-check", "run-tests", "static-check"]);
    const search = searchOf(on.result.bundle);
    expect(search.versions[0]?.violations.breakdown?.["test-mismatch"]).toBe(3);
    expect(search.recounts).toEqual([
      expect.objectContaining({ cause: "coverage", declaration_sha256: await shaOf(r4Bad) }),
    ]);
    expect(search.recounts[0]?.violations.breakdown?.["test-mismatch"]).toBe(0);
    expect(search.recounts[0]?.violations.known_total).toBe(0);
    // 持ち越しは今までどおり（R4 が網羅を失う）で、full が出ない
    expect(carryEntriesOf(on.result.bundle)).toEqual(carryEntriesOf(off.result.bundle));
    expect(on.result.outcome.verdict).toBe("partial");
  });

  it("(e') 数え直しの静的チェック：宣言のバイト列が同じ版だけ結果を引き継ぎ（流し直さない）、違えば流し直してその結果を使う", async () => {
    const passed = await staticCheckStage.runStaticCheck({ source: RUN_YAML });
    const rerun = vi.fn(async (declaration: { readonly source: string }) => staticCheckStage.runStaticCheck(declaration));
    // 同じバイト列：引き継ぐ（同じ値の同じ物）・流し直さない
    const same = await staticCheckForRecount(
      { declaration: { source: RUN_YAML }, declarationSha256: await shaOf(RUN_YAML), staticCheck: passed },
      rerun,
    );
    expect(same.rerun).toBe(false);
    expect(same.staticCheck).toBe(passed);
    expect(same.declarationSha256).toBe(await shaOf(RUN_YAML));
    expect(rerun).not.toHaveBeenCalled();
    // 違うバイト列（1 文字の差）：引き継がず流し直し、流し直した結果（落ちた結果）と原文の SHA-256 を返す
    const broken = `${RUN_YAML}entities: [\n`;
    const changed = await staticCheckForRecount(
      { declaration: { source: broken }, declarationSha256: await shaOf(RUN_YAML), staticCheck: passed },
      rerun,
    );
    expect(changed.rerun).toBe(true);
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(rerun).toHaveBeenCalledWith({ source: broken });
    expect(changed.staticCheck).not.toBe(passed);
    expect(changed.staticCheck.passed).toBe(false);
    expect(changed.declarationSha256).toBe(await shaOf(broken));
  });

  it("(e'') 走りの中の数え直し（棄却のあと）は、同じバイト列の一番良い版なので静的チェックを呼ばず結果を引き継ぐ", async () => {
    const r4Bad = replaced(RUN_YAML, "expression: base * 2", "expression: base * 3");
    const r4Tests = ["r4-normal", "r4-abnormal", "r4-boundary"];
    const spy = vi.spyOn(staticCheckStage, "runStaticCheck");
    const { result } = await runScenario(
      [
        ...searchHead({ yaml: r4Bad, table: TABLE_R4_ENTITY }),
        structured(judgments(IDS, REJECT_R4)),
        repairDone(RUN_YAML, r4Tests.map(dispute)),
        arbitration(r4Tests.map((testId) => ({ testId, verdict: "overturn" }))),
        structured(acceptAll(["R1", "R2", "R3"])),
      ],
      SEARCH,
    );
    // 静的チェックは版の数（B1 の版と直した版の 2 つ）だけ。数え直しでは呼ばない
    expect(spy.mock.calls.map(([declaration]) => declaration.source)).toEqual([r4Bad, RUN_YAML]);
    expect(countStage(result, "static-check")).toBe(2);
    expect(searchOf(result.bundle).recounts).toHaveLength(1);
  });

  it("(f) 探索の記録は同じ台本で 2 回同じ値（バイト列で同じ）", async () => {
    const script = (): RecordedCall[] => [
      ...searchHead({ yaml: MIS2 }),
      structured(acceptAll()),
      repairDone(MIS1),
      structured(acceptAll()),
      repairDone(MIS2B),
      structured(acceptAll()),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ];
    const first = await runScenario(script(), SEARCH);
    const second = await runScenario(script(), SEARCH);
    const textOf = (bundle: AssembledBundle | null): string | undefined =>
      bundle?.artifacts.find((artifact) => artifact.path === V12_SEARCH_REPAIR_ARTIFACT_NAME)?.text;
    expect(textOf(first.result.bundle)).toBeDefined();
    expect(textOf(second.result.bundle)).toBe(textOf(first.result.bundle));
    expect(first.result.outcome).toEqual(second.result.outcome);
  });

  it("旗 off・ledger だけ on の走りには探索の記録が無く、search-repair だけ on の走りにはある", async () => {
    const off = await runScenario([...head(), structured(acceptAll())]);
    const ledgerOnly = await runScenario([...head({ table: TABLE_ON }), structured(acceptAll())], { flags: { ledger: true, searchRepair: false } });
    const on = await runScenario([...head(), structured(acceptAll())], SEARCH);
    for (const result of [off.result, ledgerOnly.result]) {
      expect(result.bundle?.artifacts.map((artifact) => artifact.path)).not.toContain(V12_SEARCH_REPAIR_ARTIFACT_NAME);
    }
    expect(on.result.bundle?.artifacts.map((artifact) => artifact.path)).toContain(V12_SEARCH_REPAIR_ARTIFACT_NAME);
    // 1 版目で決着する台本は、旗の有無で判定・要求・記録の段が同じ
    expect(on.result.outcome).toEqual(off.result.outcome);
    expect(JSON.stringify(on.recording.structured)).toBe(JSON.stringify(off.recording.structured));
    expect(stageIds(on.result)).toEqual(stageIds(off.result));
  });
});

describe("候補の状態の負例（旗 v12.search-repair）：採らない候補は共有の持ち越し・一覧・組・除く行を変えない", () => {
  const RUN_YAML = SEARCH_YAML;
  /** 目印の行を足した宣言（B3' の偽物が R4 を unmarked にして返す版） */
  const UNMARK_R4_WORSE = `${MIS2}# unmark-r4\n`;
  const UNMARK_R4_BETTER = `${RUN_YAML}# unmark-r4\n`;
  /** 目印の行を持つ宣言だけ、B3' が R4 を unmarked（文脈なし）で返す。ほかは本物の段 */
  const unmarkR4 = (): void => {
    const original = declCheckStage.runDeclCheck;
    vi.spyOn(declCheckStage, "runDeclCheck").mockImplementation(async (input) => {
      if (!input.declaration.source.includes("# unmark-r4")) return original(input);
      const ids = input.list.requirements.map((requirement) => requirement.id);
      return {
        ok: true,
        value: {
          declarationSha256: await sha256Hex(input.declaration.source),
          judgments: ids.map((requirementId) =>
            requirementId === "R4"
              ? { requirementId, verdict: "unmarked" as const }
              : { requirementId, verdict: "accept" as const, kind: null, quote: null },
          ),
          targets: ids.filter((id) => id !== "R4"),
          unmarked: ["R4"],
        },
      };
    });
  };

  it("R4 を unmarked にし違反も多い候補は採られず、次の直す段の一覧・組・宣言が候補の前と深く等しく、R4 は持ち越しに無く、最終の判定と持ち越しの記録が候補の無い台本と同じ", async () => {
    unmarkR4();
    const withCandidate = await runScenario(
      [
        ...searchHead({ yaml: MIS1 }),
        structured(acceptAll()),
        repairDone(UNMARK_R4_WORSE),
        // 候補の B3' は偽物が返す（呼び出しなし）
        repairDone(RUN_YAML),
        structured(acceptAll()),
      ],
      SEARCH,
    );
    const withoutCandidate = await runScenario(
      [...searchHead({ yaml: MIS1 }), structured(acceptAll()), repairDone(RUN_YAML), structured(acceptAll())],
      SEARCH,
    );
    const [before, after] = withCandidate.recording.tools;
    if (before === undefined || after === undefined) throw new Error("前提が壊れた：直す段が 2 回呼ばれていない");
    // 共有の一覧・組と、直す段に渡る宣言は候補の前と同じ（R4 が一覧に残る）
    for (const name of ["要件の一覧", "固定した試験"]) expect(dataBlockOf(after.input, name)).toEqual(dataBlockOf(before.input, name));
    expect(rawDataBlockOf(after.input, "宣言")).toBe(rawDataBlockOf(before.input, "宣言"));
    expect((dataBlockOf(after.input, "要件の一覧") as RequirementList).requirements.map((requirement) => requirement.id)).toContain("R4");
    // 候補は採られず、捨てた候補の状態の要約に R4 の unmarked が残る
    const search = searchOf(withCandidate.result.bundle);
    expect(search.versions.map((version) => [version.violations.known_total, version.adopted])).toEqual([
      [1, true],
      [3, false],
      [0, true],
    ]);
    expect(search.versions[1]?.discarded).toEqual({ unmarked: ["R4"], rejections: 0 });
    expect(search.recounts).toEqual([]);
    // 最終の判定・持ち越しの記録（持ち越し・除く行・残る要件）は候補の無い台本と同じで、R4 は持ち越しに無い
    expect(withCandidate.result.outcome).toEqual(withoutCandidate.result.outcome);
    expect(withCandidate.result.outcome.verdict).toBe("full");
    const carryWith = artifactOf(withCandidate.result.bundle, V11A_ARTIFACT_NAMES.carryOver);
    expect(carryWith).toEqual(artifactOf(withoutCandidate.result.bundle, V11A_ARTIFACT_NAMES.carryOver));
    expect(carryEntriesOf(withCandidate.result.bundle).map((entry) => entry.requirementId)).not.toContain("R4");
    expect(carryWith["remaining_requirement_ids"]).toContain("R4");
  });

  it("二点測定：R4 を unmarked にしたが違反が厳密に少ない候補は同じ文脈の数で比べて採られ、そのときだけ R4 が持ち越しに入る（一番良い版はコードの検査だけで数え直す）", async () => {
    unmarkR4();
    const { result, recording } = await runScenario(
      [...searchHead({ yaml: MIS2 }), structured(acceptAll()), repairDone(UNMARK_R4_BETTER)],
      SEARCH,
    );
    const search = searchOf(result.bundle);
    // 同じ確定の文脈（R4 の試験を含む組）で、候補は unmarked 1・不一致 0 ＝ 1 < 2
    expect(search.versions.map((version) => [version.violations.known_total, version.adopted])).toEqual([
      [2, true],
      [1, true],
    ]);
    expect(search.versions[1]?.violations.breakdown?.["decl-unmarked"]).toBe(1);
    expect(search.recounts).toEqual([expect.objectContaining({ cause: "adopted", declaration_sha256: await shaOf(UNMARK_R4_BETTER) })]);
    expect(search.recounts[0]?.violations.known_total).toBe(0);
    expect(carryEntriesOf(result.bundle)).toEqual([{ requirementId: "R4", reasons: [{ origin: "decl-check", reason: "unmarked" }] }]);
    expect(result.outcome.verdict).toBe("partial");
    expect(recording.tools).toHaveLength(1);
  });

  it("対照（旗 off）：同じ候補は評価したその場で R4 を共有の持ち越しへ入れ、次の直す段の一覧から R4 が消える", async () => {
    unmarkR4();
    const { result, recording } = await runScenario([
      ...searchHead({ yaml: MIS1 }),
      structured(acceptAll()),
      repairDone(UNMARK_R4_WORSE),
      repairDone(RUN_YAML),
      structured(acceptAll(["R1", "R2", "R3"])),
    ]);
    const after = recording.tools[1];
    if (after === undefined) throw new Error("前提が壊れた：直す段が 2 回呼ばれていない");
    expect((dataBlockOf(after.input, "要件の一覧") as RequirementList).requirements.map((requirement) => requirement.id)).not.toContain("R4");
    expect(carryEntriesOf(result.bundle).map((entry) => entry.requirementId)).toContain("R4");
  });
});

// ── 欄だけの直し（旗 v12.search-repair・手 4b。Issue #553）──────────────────────────────
//
// 場所に写る筋：R3 の操作 closeItem の条件（when）の式を替えると、R3 の 3 本（正常 3 は true・異常 -1 は false・境界 1 は true）の
// うち落ちる本数が決まる：`> 1` は境界だけ（1）、`> -5` は異常だけ（1）、`> 5`・`> 7` は正常と境界（2）、`< 0` は 3 本とも（3）。
// 失敗は試験の対象の行（o.closeItem）から操作 `action:item.closeItem` に写るので、旗 on の往復は欄だけの直し（構造化出力）を呼ぶ。
// 手 4a の節と同じ筋（採る・採らない・停滞・作り直し・limit・呼び出しの上限・棄却・候補の状態）を、欄だけの直しで固定する。

const whenAs = (expression: string): string => replaced(RUN_YAML, "when: amount > 0", `when: ${expression}`);
/** 不一致 1（境界だけ） */
const W1 = whenAs("amount > 1");
/** 不一致 2（正常と境界） */
const W2 = whenAs("amount > 5");
/** 不一致 3 */
const W3 = whenAs("amount < 0");
const CLOSE = "action:item.closeItem";
/** 操作 closeItem の本文（条件の式だけを替える。`extra` は末尾に足す行） */
const closeItemBody = (expression: string, extra: readonly string[] = []): string =>
  ["- name: closeItem", "  entity: item", "  kind: update", "  set:", "    kind: beta", `  when: ${expression}`, ...extra].join("\n");
/** 欄だけの直しの応答（closeItem の条件の式を替える） */
const fieldRepair = (expression: string, disputes: readonly { testId: string; quote: string }[] = [], extra: readonly string[] = []): RecordedCall =>
  structured({ replacements: [{ location: CLOSE, element: closeItemBody(expression, extra) }], disputes });
const fieldRequests = (requests: readonly LlmStructuredRequest[]): readonly LlmStructuredRequest[] =>
  requests.filter((request) => request.schemaName === FIELD_REPAIR_SCHEMA_NAME);
const fieldDeclarations = (requests: readonly LlmStructuredRequest[]): readonly string[] =>
  fieldRequests(requests).map((request) => rawDataBlockOf(request.input, "宣言"));
const locationEnumOf = (request: LlmStructuredRequest): unknown =>
  (request.schema as { properties: { replacements: { items: { properties: { location: { enum: unknown } } } } } }).properties.replacements.items
    .properties.location.enum;
interface RoundJson {
  readonly hand: string;
  readonly locations: number;
  readonly unlocated: number;
  readonly refused: string | null;
}
const roundsOf = (bundle: AssembledBundle | null): readonly RoundJson[] =>
  (artifactOf(bundle, V12_SEARCH_REPAIR_ARTIFACT_NAME)["rounds"] ?? []) as readonly RoundJson[];
const totalsOf = (bundle: AssembledBundle | null): readonly unknown[] =>
  searchOf(bundle).versions.map((version) => [version.origin, version.violations.known_total ?? version.violations.kind, version.adopted]);
const R3_TEST_IDS = ["r3-normal", "r3-abnormal", "r3-boundary"];

describe("欄だけの直し（旗 v12.search-repair・手 4b）：失敗が全部場所に写せる往復は、その要素だけを置き換える", () => {
  it("(a) B4 の不一致の版で欄だけの直しが呼ばれ、不一致 2 → 1 → 0 の版を採り、関係の無い要素の値が変わらない（要求の場所の enum はその往復の失敗の場所）", async () => {
    const { result, recording } = await runScenario(
      [...head({ yaml: W2 }), structured(acceptAll()), fieldRepair("amount > 1"), structured(acceptAll()), fieldRepair("amount > 0"), structured(acceptAll())],
      SEARCH,
    );
    // 道具付きの直す段を呼ばない。欄だけの直しは 2 回で、2 回目の入力は採った版（マージした版）
    expect(recording.tools).toEqual([]);
    expect(fieldDeclarations(recording.structured)).toEqual([W2, W1]);
    for (const request of fieldRequests(recording.structured)) expect(locationEnumOf(request)).toEqual([CLOSE]);
    expect(result.outcome.verdict).toBe("full");
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 2, true],
      ["repair", 1, true],
      ["repair", 0, true],
    ]);
    // 置き換えたのは closeItem の行だけ：最終の版は正しい宣言とバイト列で同じ（関係の無い要素は一番良い版のまま）
    expect(declarationOf(result.bundle)).toBe(RUN_YAML);
    // (f) 探索の記録に往復ごとの直す手の種類・場所の数・場所なしの数
    expect(roundsOf(result.bundle)).toEqual([
      { hand: "field-repair", locations: 1, unlocated: 0, refused: null },
      { hand: "field-repair", locations: 1, unlocated: 0, refused: null },
    ]);
    expect(countStage(result, "repair")).toBe(2);
  });

  it("(a) 二点測定：手 4a の直す手（宣言の全文を書き直す）だけだと、同じ筋の台本で関係の無い要素（見出しごとの集計の last）が動く", async () => {
    const moved = (source: string): string => replaced(source, "      last: 6", "      last: 12");
    const { result, recording } = await runScenario([
      ...head({ yaml: W2 }),
      structured(acceptAll()),
      repairDone(moved(W1)),
      structured(acceptAll()),
      repairDone(moved(RUN_YAML)),
      structured(acceptAll()),
    ]);
    expect(recording.tools).toHaveLength(2);
    expect(result.outcome.verdict).toBe("full");
    expect(declarationOf(result.bundle)).toBe(moved(RUN_YAML));
    expect(declarationOf(result.bundle)).not.toBe(RUN_YAML);
  });

  it("(b) 場所なしが 1 件ある往復（R4 の拒否。R4 が entity の行も所属させる）では手 4a の直す手が呼ばれ、欄だけの直しの要求が無い", async () => {
    const { result, recording } = await runScenario(
      [...head({ yaml: W1, table: TABLE_R4_ENTITY }), structured(judgments(IDS, REJECT_R4)), repairDone(RUN_YAML), structured(acceptAll())],
      SEARCH,
    );
    expect(recording.tools).toHaveLength(1);
    expect(fieldRequests(recording.structured)).toEqual([]);
    expect(roundsOf(result.bundle)).toEqual([{ hand: "repair", locations: 1, unlocated: 1, refused: null }]);
    expect(result.outcome.verdict).toBe("full");
  });

  it("(c) 静的チェックに落ちた版は採られず、次の往復の入力が一番良い版", async () => {
    const { result, recording } = await runScenario(
      [...head({ yaml: W1 }), structured(acceptAll()), fieldRepair("missing > 0"), fieldRepair("amount > 0"), structured(acceptAll())],
      SEARCH,
    );
    expect(fieldDeclarations(recording.structured)).toEqual([W1, W1]);
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 1, true],
      ["repair", "static-check-failed", false],
      ["repair", 0, true],
    ]);
    expect(result.outcome.verdict).toBe("full");
    expect(declarationOf(result.bundle)).toBe(RUN_YAML);
  });

  it("(c) マージが断った往復（大きさの上限を超える）は版を作らず採れない版に数え、次の往復の入力が一番良い版。記録に断った固定文", async () => {
    const huge = [`  # ${"x".repeat(factoryModule.AGENT_LIMITS.declarationBytes)}`];
    const { result, recording } = await runScenario(
      [...head({ yaml: W1 }), structured(acceptAll()), fieldRepair("amount > 0", [], huge), fieldRepair("amount > 0"), structured(acceptAll())],
      SEARCH,
    );
    expect(fieldDeclarations(recording.structured)).toEqual([W1, W1]);
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 1, true],
      ["repair", 0, true],
    ]);
    expect(roundsOf(result.bundle)).toEqual([
      { hand: "field-repair", locations: 1, unlocated: 0, refused: MERGE_REFUSALS.bytes },
      { hand: "field-repair", locations: 1, unlocated: 0, refused: null },
    ]);
    // 断った版は静的チェックにも点検にも掛けない（版の数は 2）
    expect(countStage(result, "static-check")).toBe(2);
    expect(countStage(result, "decl-check")).toBe(2);
    expect(result.outcome.verdict).toBe("full");
  });

  it("(d) 主張は B5' に渡り、棄却で B6（網羅の持ち越し・一番良い版の数え直し）が手 4a の直す手の台本と同じに効く", async () => {
    const claims = R3_TEST_IDS.map(dispute);
    const tail = [arbitration(R3_TEST_IDS.map((testId) => ({ testId, verdict: "overturn" }))), structured(acceptAll(["R1", "R2", "R4"]))];
    const on = await runScenario([...head({ yaml: W3 }), structured(acceptAll()), structured({ replacements: [], disputes: claims }), ...tail], SEARCH);
    const off = await runScenario([...head({ yaml: W3 }), structured(acceptAll()), repairDone(W3, claims), ...tail]);
    expect(on.recording.tools).toEqual([]);
    expect(countStage(on.result, "arbitration")).toBe(1);
    expect(countStage(on.result, "coverage")).toBe(1);
    expect(carryEntriesOf(on.result.bundle)).toEqual(carryEntriesOf(off.result.bundle));
    expect(carryEntriesOf(on.result.bundle).map((entry) => entry.requirementId)).toEqual(["R3"]);
    expect(searchOf(on.result.bundle).recounts).toEqual([expect.objectContaining({ cause: "coverage", declaration_sha256: await shaOf(W3) })]);
    expect(on.result.outcome).toEqual(off.result.outcome);
    expect(on.result.outcome.verdict).toBe("partial");
    expect(countStage(on.result, "decl-check")).toBe(countStage(off.result, "decl-check"));
  });

  it("(e) 採らない・停滞・作り直しの数え方は手 4a と同じ：不一致 1 のあとの 2・同数は採らず、2 つ採れなければ B1 を 1 回だけ作り直し、作り直しのあと 2 つ採れなければ stagnation", async () => {
    const { result, recording } = await runScenario(
      [
        ...head({ yaml: W2 }),
        structured(acceptAll()),
        fieldRepair("amount > 1"),
        structured(acceptAll()),
        fieldRepair("amount > 7"),
        structured(acceptAll()),
        fieldRepair("amount > -5"),
        structured(acceptAll()),
        structured({ declaration: W3 }),
        structured(acceptAll()),
        fieldRepair("amount > 5"),
        structured(acceptAll()),
      ],
      SEARCH,
    );
    expect(recording.tools).toEqual([]);
    expect(fieldDeclarations(recording.structured)).toEqual([W2, W1, W1, W1]);
    expect(writeRequests(recording.structured)).toHaveLength(2);
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 2, true],
      ["repair", 1, true],
      ["repair", 2, false],
      ["repair", 1, false],
      ["rewrite", 3, false],
      ["repair", 2, false],
    ]);
    expect(result.summary.stop_reason).toBe("stagnation");
    expect(result.outcome.verdict).toBe("partial");
    expect(declarationOf(result.bundle)).toBe(W1);
    expect(searchOf(result.bundle).rewritten).toBe(true);
  });

  it("(e) 往復と点検の上限は手 4a と同じ：点検 6 で limit（7 回目の点検も次の直しも無い）、不一致が残った最終の版で full が出ない", async () => {
    const { result, recording } = await runScenario(
      [
        ...head({ yaml: W3 }),
        structured(acceptAll()),
        fieldRepair("amount > 5"),
        structured(acceptAll()),
        fieldRepair("amount > 7"),
        structured(acceptAll()),
        fieldRepair("amount > 1"),
        structured(acceptAll()),
        fieldRepair("amount > -5"),
        structured(acceptAll()),
        fieldRepair("amount > 1"),
        structured(acceptAll()),
      ],
      SEARCH,
    );
    expect(countStage(result, "decl-check")).toBe(6);
    expect(countStage(result, "repair")).toBe(5);
    expect(fieldRequests(recording.structured)).toHaveLength(5);
    expect(writeRequests(recording.structured)).toHaveLength(1);
    expect(result.summary.stop_reason).toBe("limit");
    expect(result.outcome).toEqual({ result: "failed", verdict: "none" });
    expect(result.summary.exit_code).toBe(1);
    expect(declarationOf(result.bundle)).toBe(W1);
  });

  it("(e) 共通の口の呼び出しの上限は今までどおりの早期停止（手 4a の直す手の台本と同じ段・種類で止まり、納品物を作らない）", async () => {
    const limits = { ...factoryModule.AGENT_LIMITS, callCount: 6 };
    const on = await runScenario([...head({ yaml: W2 }), structured(acceptAll()), fieldRepair("amount > 1"), structured(acceptAll())], { ...SEARCH, limits });
    const off = await runScenario([...head({ yaml: W2 }), structured(acceptAll()), repairDone(W1), structured(acceptAll())], { limits });
    expect(on.result.stopped).toEqual(off.result.stopped);
    expect(on.result.stopped?.kind).toBe("call-limit");
    expect(on.result.bundle).toBeNull();
    expect(on.result.summary.exit_code).toBe(1);
  });

  it("(f) 探索の記録は同じ台本で 2 回同じ値（バイト列で同じ）", async () => {
    const script = (): RecordedCall[] => [...head({ yaml: W2 }), structured(acceptAll()), fieldRepair("amount > 1"), structured(acceptAll()), fieldRepair("amount > 0"), structured(acceptAll())];
    const textOf = (bundle: AssembledBundle | null): string | undefined =>
      bundle?.artifacts.find((artifact) => artifact.path === V12_SEARCH_REPAIR_ARTIFACT_NAME)?.text;
    const first = await runScenario(script(), SEARCH);
    const second = await runScenario(script(), SEARCH);
    expect(textOf(first.result.bundle)).toBeDefined();
    expect(textOf(second.result.bundle)).toBe(textOf(first.result.bundle));
  });

  it("候補の状態の負例：R4 を unmarked にし違反も多い欄の置き換えは採られず、次の要求の一覧・組・宣言が候補の前と同じで、R4 は持ち越しに無い", async () => {
    const original = declCheckStage.runDeclCheck;
    vi.spyOn(declCheckStage, "runDeclCheck").mockImplementation(async (value) => {
      if (!value.declaration.source.includes("# unmark-r4")) return original(value);
      const ids = value.list.requirements.map((requirement) => requirement.id);
      return {
        ok: true,
        value: {
          declarationSha256: await sha256Hex(value.declaration.source),
          judgments: ids.map((requirementId) =>
            requirementId === "R4"
              ? { requirementId, verdict: "unmarked" as const }
              : { requirementId, verdict: "accept" as const, kind: null, quote: null },
          ),
          targets: ids.filter((id) => id !== "R4"),
          unmarked: ["R4"],
        },
      };
    });
    const { result, recording } = await runScenario(
      [...head({ yaml: W1 }), structured(acceptAll()), fieldRepair("amount > 5", [], ["  # unmark-r4"]), fieldRepair("amount > 0"), structured(acceptAll())],
      SEARCH,
    );
    const [before, after] = fieldRequests(recording.structured);
    if (before === undefined || after === undefined) throw new Error("前提が壊れた：欄だけの直しが 2 回呼ばれていない");
    for (const name of ["要件の一覧", "固定した試験", "宣言"]) expect(rawDataBlockOf(after.input, name)).toBe(rawDataBlockOf(before.input, name));
    expect((dataBlockOf(after.input, "要件の一覧") as RequirementList).requirements.map((requirement) => requirement.id)).toContain("R4");
    const search = searchOf(result.bundle);
    expect(search.versions.map((version) => [version.violations.known_total, version.adopted])).toEqual([
      [1, true],
      [3, false],
      [0, true],
    ]);
    expect(search.versions[1]?.discarded).toEqual({ unmarked: ["R4"], rejections: 0 });
    expect(carryEntriesOf(result.bundle).map((entry) => entry.requirementId)).not.toContain("R4");
    expect(result.outcome.verdict).toBe("full");
  });
});

describe("題材の言葉の走査（Issue #551 で足した・直したファイル）", () => {
  it("探索の部品・B1・記録・走らせる部分とその試験のソースに受入の題材の言葉が無い", () => {
    const files = [
      "../v12/search-repair.ts",
      "../v12/search-repair.test.ts",
      "../v12/ledger.ts",
      "./stages/write.ts",
      "./stages/write.test.ts",
      "./bundle-v11a.ts",
      "./bundle-v11a.test.ts",
      "./run.ts",
      "./run.test.ts",
      "./__tests__/fixtures.ts",
    ];
    expectNoAcceptanceMaterial(files.map((file) => nodeFs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});

// ── 旗 v12.ids（手 3p。Issue #592）：ids off の走りはバイト列で同じ・on の走りだけ門と枝の欄 ─────────────────

describe("旗 v12.ids：ids off（前の手の旗だけ on）の走りは今と同じで、ids on の差は要約の旗の欄と門の欄だけ", () => {
  const SCENARIOS: readonly { readonly name: string; readonly calls: () => RecordedCall[]; readonly prior: Partial<V12Flags> }[] = [
    {
      name: "台帳と探索型の直し（完走）",
      calls: () => [...head({ table: TABLE_ON }), structured(acceptAll())],
      prior: { ledger: true, searchRepair: true },
    },
    {
      name: "探索型の直し（不一致 2 → 1 → 0。探索の記録あり）",
      calls: () => [...searchHead({ yaml: MIS2 }), structured(acceptAll()), repairDone(MIS1), structured(acceptAll()), repairDone(SEARCH_YAML), structured(acceptAll())],
      prior: { searchRepair: true },
    },
  ];

  it.each(SCENARIOS)("$name：ids off は門を作らず要約に門の欄が無い。ids を明示で off にしても同じ", async (scenario) => {
    const prior = await runScenario(scenario.calls(), { flags: scenario.prior, recordV12Flags: true });
    const explicitOff = await runScenario(scenario.calls(), { flags: { ...scenario.prior, ids: false }, recordV12Flags: true });
    expect(prior.result.outcome.verdict).toBe("full");
    // ids off：要約の旗の組に ids が false で載り（旗の組の欄だけ増える）、門の欄が無い
    const priorSummary = prior.result.summary as unknown as Record<string, unknown>;
    expect(priorSummary["v12_flags"]).toEqual(toPublicV12Flags(resolveV12Flags(scenario.prior)));
    expect((priorSummary["v12_flags"] as Record<string, unknown>)["ids"]).toBe(false);
    expect(priorSummary).not.toHaveProperty("v12_calls");
    expect(explicitOff.result).toEqual(prior.result);
    // ids off の走りは T1 を呼び、C1・C2 の段の記録が無い（Issue #593）
    expect(stageIds(prior.result)).toContain("name-table");
    expect(stageIds(prior.result).some((stage) => stage === "vocabulary" || stage === "mapping")).toBe(false);
    expect(artifactOf(prior.result.bundle, "artifacts/summary.json")).not.toHaveProperty("v12_calls");
    // ids off の C3 の R-sc-02 は構造の検査の読み方の文を持たない（Issue #732）
    const semantic = prior.recording.structured.filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME);
    expect(semantic.length).toBeGreaterThan(0);
    expect(semantic.every((request) => !(request.rules ?? []).some((text) => text.includes(structuralReadingText())))).toBe(true);
  });

  /**
   * 二点測定（Issue #593）：両経路に同じコードの形の ID を持つ合成の表（`withCodeIds`）を用意し、旗 off の T1 の応答も同じ ID を
   * 書く。旗 off の T1 で入れた走りと ids on の C1・C2 で入れた走りで、段が組んだ論理要求の C3 以降（T1''・T2・B1・B3'）が
   * **行の出典の欄を除いて**バイト列で同じで、納品物の宣言・判定が同じ。表の SHA は両側で別に計算する
   */
  it("二点測定：T1 で入れた表と C1・C2 で入れた表で、C3 以降の論理要求が出典の欄を除いて同じ・判定と宣言が同じ・表の SHA はそれぞれの表に結ぶ", async () => {
    const offTable = withCodeIds(TABLE_ON, true);
    // ids on の T2 はコードが作る試験を組に足す（Issue #595）。off の T2 の応答には同じ試験（同じ ID）を LLM が書いたことにして、
    // 組・B1 の要求をそろえる（off は予約の接頭辞を見ない）
    const made = generateTests({ table: MAPPED_IDS, ledger: PROPERTY_LEDGER_VIEW, list: LIST });
    expect(made.tests.length).toBeGreaterThan(0);
    // 手 3d（#624）：R2 の構造の検査もコードが作るので、off の応答の R2 の試験は作った試験だけにする（分類は off の一覧にあるので書く）
    const offT2 = renamed(t2Response([...r1Tests(), ...r3Tests(), ...r4Tests()]));
    const offCalls = [
      structured(t1Of(LIST, offTable)),
      structured(acceptAll()),
      structured({ ...offT2, tests: [...offT2.tests, ...made.tests.map((test) => rawOfFixed(test, made.observes.get(test.id) ?? ""))] }),
      structured({ declaration: RUN_YAML }),
      structured(acceptAll()),
    ];
    const off = await runScenario(offCalls, { flags: { ledger: true, searchRepair: true }, recordV12Flags: true });
    const on = await runScenario([...idsHead(), structured(acceptAll())], { flags: { ledger: true, searchRepair: true, ids: true }, recordV12Flags: true });
    expect(off.result.stopped, JSON.stringify(off.result.stopped)).toBeNull();
    expect(off.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(on.result.outcome).toEqual(off.result.outcome);
    expect(on.result.summary.exit_code).toBe(off.result.summary.exit_code);
    // 段の記録：表を組む段だけが違う（off は name-table 1、on は vocabulary 3・mapping 1）。C3 以降の段の並びは同じ
    const tableStages = new Set(["name-table", "vocabulary", "mapping"]);
    expect(stageIds(on.result).filter((stage) => !tableStages.has(stage))).toEqual(stageIds(off.result).filter((stage) => !tableStages.has(stage)));
    expect(countStage(on.result, "vocabulary")).toBe(3);
    expect(countStage(on.result, "mapping")).toBe(1);
    expect(countStage(on.result, "name-table")).toBe(0);
    // 論理要求：表を組む段の要求を除くと、出典の欄（off は写像、on は null）を除いてバイト列で同じ
    const tableSchemas = new Set(["name-table", "vocabulary-entities", "vocabulary-fields", "vocabulary-behaviors", "mapping"]);
    const later = (requests: readonly LlmStructuredRequest[]) => requests.filter((request) => !tableSchemas.has(request.schemaName));
    const withoutSource = (text: string) => text.replace(/\\"source\\": \{[^}]*\}/g, '\\"source\\": null');
    // ids on の C3・T2 の確かめ方は構造の検査の対象の欄を持つ（C3 は表の targets、T2 は checkTargets。Issue #594）。その欄を除いて比べる
    const withoutTargets = (text: string) => text.replace(/,\\n *\\"(?:targets|checkTargets)\\": \[[^\]]*\]/g, "");
    const offLater = later(off.recording.structured);
    // 手 4d（#666）：ids on の B1 は「要る検査の骨組み」の塊と R-w11-07 の旗 ids の文を持つ（ids の走りだけ）。その分を戻して比べる
    expect(later(on.recording.structured).filter((request) => REQUIRED_VALIDATIONS_BLOCK.test(request.input)).map((request) => request.schemaName)).toEqual([WRITE_V11A_SCHEMA_NAME]);
    const onLater = later(on.recording.structured).map(withoutRequiredValidations);
    expect(onLater.map((request) => request.schemaName)).toEqual(["semantic-check", "test-spec", "declaration-v11a", "decl-check"]);
    // 手 3d（#624）から構造の要件は T2 の要求に無いので、検査の対象の欄を持つのは C3 だけ
    expect(/\\"targets\\": \[/.test(JSON.stringify(onLater[0]))).toBe(true);
    expect(/\\"checkTargets\\": \[/.test(JSON.stringify(onLater[1]))).toBe(false);
    // ids on の T2 の R-tsp-16 は台帳の旗 ids の文（Issue #595）。その 1 文を ids off の文に戻して比べる
    const idsRules = ruleTexts(testSpecRuleDefinitionsOf(PROPERTY_LEDGER_VIEW, true));
    const offRules = ruleTexts(testSpecRuleDefinitionsOf(PROPERTY_LEDGER_VIEW));
    // ids on の C3 の R-sc-02 は構造の検査の読み方の文を持つ（Issue #732）。その 1 文を ids off の文に戻して比べる
    const idsSemanticRules = ruleTexts(semanticCheckStage.semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW, true));
    const offSemanticRules = ruleTexts(semanticCheckStage.semanticCheckRuleDefinitionsOf(PROPERTY_LEDGER_VIEW));
    const withOffRules = (request: LlmStructuredRequest): LlmStructuredRequest => {
      const [from, to] =
        request.schemaName === TEST_SPEC_SCHEMA_NAME
          ? [idsRules, offRules]
          : request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME
            ? [idsSemanticRules, offSemanticRules]
            : [undefined, undefined];
      if (from === undefined) return request;
      return { ...request, rules: (request.rules ?? []).map((text) => { const at = from.indexOf(text); return at < 0 ? text : (to[at] ?? text); }) };
    };
    expect(onLater.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)?.rules).not.toEqual(
      offLater.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)?.rules,
    );
    expect(onLater.find((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME)?.rules).toEqual(idsSemanticRules);
    expect(offLater.find((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME)?.rules).toEqual(offSemanticRules);
    expect(idsSemanticRules).not.toEqual(offSemanticRules);
    // T2 の要求は、手 3d（#624）で要件の一覧・確かめ方・所属から構造の要件 R2 を除き、schema の operation・assertion を封じたので、
    // T2 を除いた C3・B1・B3' を比べる（T2 の差は下で名指しで照らす）
    const notT2 = (requests: readonly LlmStructuredRequest[]) => requests.filter((request) => request.schemaName !== TEST_SPEC_SCHEMA_NAME);
    // B1 の固定した試験の分類には、T2 が分類しない構造の要件 R2 が無い（手 3d・#624。手 3c の除いた要件と同じ扱い）。off の R2 の 1 件を除いて比べる
    const withoutR2Nature = (text: string) => text.replace('{\\n      \\"requirementId\\": \\"R2\\",\\n      \\"nature\\": \\"existence-only\\"\\n    },\\n    ', "");
    expect(notT2(offLater).some((request) => withoutR2Nature(JSON.stringify(request)) !== JSON.stringify(request))).toBe(true);
    // 手 3e（#625）：ids on の LLM の試験は場合から展開するので、試験 ID（case: と連番）と時計（定数）はコードが振る。B1 の「固定した試験」の
    // 試験 ID と時計を両側から除いて比べる（ほかの欄は同じ）
    const withoutIdClock = (text: string) =>
      text.replace(/\\"id\\": \\"[^\\]*\\",(\\n *)\\"target\\"/g, '\\"id\\": \\"-\\",$1\\"target\\"').replace(/\\"clock\\": \\"[^\\]*\\"/g, '\\"clock\\": \\"-\\"');
    expect(notT2(onLater).map((request) => withoutIdClock(withoutTargets(JSON.stringify(withOffRules(request)))))).toEqual(
      notT2(offLater).map((request) => withoutIdClock(withoutR2Nature(withoutSource(JSON.stringify(request))))),
    );
    const t2Of = (requests: readonly LlmStructuredRequest[]) => requests.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    const listedIds = (request: LlmStructuredRequest) => (dataBlockOf(request.input, TEST_SPEC_DATA_NAMES[1]) as { requirements: { id: string }[] }).requirements.map((entry) => entry.id);
    expect(listedIds(t2Of(onLater))).toEqual(IDS.filter((id) => id !== "R2"));
    expect(listedIds(t2Of(offLater))).toEqual([...IDS]);
    expect(t2Of(onLater).schema).toEqual(testSpecSchemaOf(PROPERTY_LEDGER_VIEW, true));
    expect(t2Of(offLater).schema).toEqual(testSpecSchemaOf(PROPERTY_LEDGER_VIEW));
    // 出典の欄の差だけがある（T2 の行に出典がある・無い）
    expect(offLater.map((request) => JSON.stringify(request))).not.toEqual(onLater.map((request) => JSON.stringify(request)));
    // 納品物の宣言・試験の結果が同じ
    const declarationOf = (result: typeof on.result) => result.bundle?.artifacts.find((artifact) => artifact.path === "artifacts/app.spec.yaml")?.text;
    expect(declarationOf(on.result)).toBeDefined();
    expect(declarationOf(on.result)).toBe(declarationOf(off.result));
    // 表の SHA は両側で別に計算し、それぞれの表に結ぶ（出典が違うので SHA は違う）
    const onSha = await nameTableSha256(MAPPED_IDS);
    const offSha = await nameTableSha256(offTable);
    expect(onSha).not.toBe(offSha);
    const shaOf = (result: typeof on.result) => (artifactOf(result.bundle, "artifacts/name-table.json") as { readonly table_sha256?: string })["table_sha256"];
    expect(shaOf(on.result)).toBe(onSha);
    expect(shaOf(off.result)).toBe(offSha);
    // C3 の点検の結果も、それぞれの表の SHA に結ぶ
    const semanticShaOf = (result: typeof on.result) =>
      (artifactOf(result.bundle, "artifacts/semantic-check.json") as { readonly rounds: readonly { readonly table_sha256: string }[] }).rounds.map((round) => round.table_sha256);
    expect(semanticShaOf(on.result)).toEqual([onSha]);
    expect(semanticShaOf(off.result)).toEqual([offSha]);
    // 出典を除けば、表の行は同じ（on の行の出典は null）
    const rowsOf = (result: typeof on.result) => (artifactOf(result.bundle, "artifacts/name-table.json") as { readonly rows: readonly Record<string, unknown>[] }).rows;
    expect(rowsOf(on.result).every((row) => row["source"] === null)).toBe(true);
    expect(rowsOf(on.result).map(({ source: _s, ...rest }) => rest)).toEqual(rowsOf(off.result).map(({ source: _s, ...rest }) => rest));
  });

  it("ids on で門を差し替えて生成が尽きた走りは call-limit で止まり（終了コード 1・納品物無し）、早期停止の要約にも門の欄が載る", async () => {
    const { result } = await runScenario([...idsHead(), structured(acceptAll())], {
      flags: { ledger: true, searchRepair: true, ids: true },
      v12CallLimits: { realAttempts: 2 },
    });
    // 門 2 は C1 の束 1・束 2 で尽き、束 3 が未着手のまま止まる（Issue #593 で表を組む段が C1・C2 になった）
    expect(result.stopped).toMatchObject({ stage: "vocabulary", kind: "call-limit" });
    expect(result.stopped).toMatchObject({ kind: "call-limit" });
    expect(result.summary.exit_code).toBe(1);
    expect(result.bundle).toBeNull();
    expect((result.summary as unknown as Record<string, unknown>)["v12_calls"]).toEqual({
      real_attempts: { limit: 2, used: 2 },
      judge_branch: { limit: 80, used: 0 },
    });
  });

  it("旗 off の走りは v12CallLimits を渡しても見ない（門を作らない・今の上限）", async () => {
    const base = await runScenario([...head(), structured(acceptAll())]);
    const ignored = await runScenario([...head(), structured(acceptAll())], { v12CallLimits: { realAttempts: 1, judgeBranch: 0 } });
    expect(ignored.result).toEqual(base.result);
    expect(base.result.summary).not.toHaveProperty("v12_calls");
  });
});

// ── 旗 v12.ids：コードが作る試験の走り（手 3c。Issue #595）──────────────────────────────

describe("旗 v12.ids：既定値・選択肢の集合・空の集計の要件を含む走りは、コードが作った試験で照らし、宣言が表どおりなら full・違えば full が出ない（Issue #595）", () => {
  const flags: Partial<GenerationInputV11a> = { flags: { ledger: true, ids: true } };
  const G_LIST_BASE: RequirementList = {
    ...BASE_LIST,
    requirements: [
      ...BASE_LIST.requirements,
      { id: "R6", text: DEFAULT_VALUE_REQUIREMENT_TEXT, quote: DEFAULT_VALUE_REQUIREMENT_TEXT, position: { start: 0, end: DEFAULT_VALUE_REQUIREMENT_TEXT.length } },
      { id: "R7", text: ENUM_MEMBERSHIP_REQUIREMENT_TEXT, quote: ENUM_MEMBERSHIP_REQUIREMENT_TEXT, position: { start: 0, end: ENUM_MEMBERSHIP_REQUIREMENT_TEXT.length } },
    ],
  };
  const G_PLAN = planOf(G_LIST_BASE);
  const G_LIST = requirementsFromPlan(G_PLAN);
  const G_SOURCE = G_LIST_BASE.requirements.map((requirement) => requirement.text).join("");
  const G_IDS = [...IDS, "R6", "R7"] as const;
  /** 題材の表（R5 を除く）に、アプリ全体の合計 c.base（宣言の base）と既定値の R6・選択肢の集合の R7 を足した表（コードの形の ID） */
  const G_TABLE_ON: NameTable = (() => {
    const table = fixtureGeneratedTable();
    return { rows: table.rows, ownership: without5(table.ownership), verification: without5(table.verification), classification: without5(table.classification) };
  })();
  const G_RENAME = codeIdRenameOf(G_TABLE_ON);
  const G_MAPPED: NameTable = withCheckTargets(withCodeIds(G_TABLE_ON));
  /** 区分の項目に default を足した宣言 */
  const G_YAML = replaced(RUN_YAML, "          beta: ベータ\n", "          beta: ベータ\n        default: alpha\n");
  /** T2 の応答（R6・R7 の試験も、R4 のアプリ全体・見出しごと × 選択肢の空の試験も書かない＝値の要る試験だけ） */
  const gT2 = () => renameIds(idsT2Response(), G_RENAME);
  const gHead = (yaml: string): RecordedCall[] => [
    ...idsResponseList(idsResponsesOf(G_LIST, G_MAPPED, PROPERTY_LEDGER_VIEW)).map((output) => structured(output)),
    structured(acceptAll(G_IDS)),
    structured(gT2()),
    structured({ declaration: yaml }),
  ];
  const runG = (calls: readonly RecordedCall[]) => runScenario(calls, { plan: G_PLAN, source: G_SOURCE, ...flags });
  /** 評価口の B4 の結果を記録する（評価口はそのまま） */
  function spyReports() {
    const reports: { readonly mismatches: readonly { readonly testId: string; readonly detail: string }[]; readonly unresolved: readonly { readonly testId: string }[] }[] = [];
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
  const generatedOf = (result: Awaited<ReturnType<typeof runG>>["result"]) =>
    (artifactOf(result.bundle, "artifacts/test-spec.json") as { readonly generated_test_ids?: readonly string[] }).generated_test_ids;

  it("正例：宣言が表どおりなら v1 の評価器と台帳の照合で不一致 0・今までの門で full。T2 の成果物にコードが作った試験 ID の並び（組の末尾・予約の接頭辞）がある", async () => {
    const reports = spyReports();
    const { result, recording } = await runG([...gHead(G_YAML), structured(acceptAll(G_IDS))]);
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(result.summary.exit_code).toBe(0);
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report.mismatches).toEqual([]);
      expect(report.unresolved).toEqual([]);
    }
    const spec = artifactOf(result.bundle, "artifacts/test-spec.json") as { readonly suite: TestSuite; readonly observes: Record<string, string> };
    const generatedIds = generatedOf(result) ?? [];
    // 手 3d（#624）：R2 の構造の検査と R4 の画面の構造の確認もコードが作る
    expect(generatedIds.length).toBe(8);
    expect(generatedIds.every((id) => id.startsWith(GENERATED_TEST_ID_PREFIX))).toBe(true);
    expect(spec.suite.tests.map((test) => test.id).slice(-generatedIds.length)).toEqual(generatedIds);
    expect(spec.suite.tests.filter((test) => isGeneratedTestId(test.id)).map((test) => test.id)).toEqual(generatedIds);
    expect(generatedIds.map((id) => spec.observes[id])).toEqual([
      "view-structure",
      "view-structure",
      "empty-aggregate",
      "empty-aggregate",
      "empty-aggregate",
      "empty-aggregate",
      "default-value",
      "enum-membership",
    ]);
    // T2 の要求の一覧に R6・R7（と手 3d から構造の要件 R2）が無い。B1 には作った試験が渡る
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    const listed = dataBlockOf(t2.input, TEST_SPEC_DATA_NAMES[1]) as { requirements: { id: string }[] };
    expect(listed.requirements.map((requirement) => requirement.id)).toEqual(IDS.filter((id) => id !== "R2"));
    const write = recording.structured.find((request) => request.schemaName === WRITE_V11A_SCHEMA_NAME)!;
    const shown = dataBlockOf(write.input, WRITE_V11A_DATA_NAMES[2]) as { tests: { id: string }[] };
    expect(shown.tests.map((test) => test.id).slice(-generatedIds.length)).toEqual(generatedIds);
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
  });

  // decl-check は B3・B4 の落ちが無い版にだけ掛かる（default の違いは B3 で落ちない・options の集合と集計の種類の違いは B3 でも落ちる）
  const negatives: readonly { readonly name: string; readonly yaml: string; readonly observes: string; readonly detail?: string; readonly declChecked: boolean }[] = [
    { name: "宣言の default が違う", yaml: replaced(G_YAML, "        default: alpha\n", "        default: beta\n"), observes: "default-value", detail: DEFAULT_VALUE_DETAILS.defaultDiffers, declChecked: true },
    { name: "options の集合が違う", yaml: replaced(G_YAML, "          beta: ベータ\n", "          beta: ベータ\n          gamma: ガンマ\n"), observes: "enum-membership", detail: ENUM_MEMBERSHIP_DETAILS.optionsDiffer, declChecked: false },
    { name: "空の集計が 0 でない（アプリ全体の合計を平均にした）", yaml: replaced(G_YAML, "      sum: item.amount\n    type: number\n  - name: rate", "      avg: item.amount\n    type: number\n  - name: rate"), observes: "empty-aggregate", declChecked: false },
  ];

  it.each(negatives)("負例：$name 宣言は、コードが作った試験で不一致になり full が出ない（作り手で甘くならない）", async ({ yaml, observes, detail, declChecked }) => {
    const reports = spyReports();
    const accepted = declChecked ? [structured(acceptAll(G_IDS))] : [];
    const { result } = await runG([...gHead(yaml), ...accepted, repairDone(yaml), ...accepted]);
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.summary.verdict).not.toBe("full");
    expect(reports.length).toBeGreaterThan(0);
    if (result.bundle === null) throw new Error(JSON.stringify({ stopped: result.stopped, stages: stageIds(result) }));
    const generatedIds = new Set(generatedOf(result) ?? []);
    const spec = artifactOf(result.bundle, "artifacts/test-spec.json") as { readonly observes: Record<string, string> };
    const missed = reports[0]!.mismatches.filter((entry) => generatedIds.has(entry.testId) && spec.observes[entry.testId] === observes);
    expect(missed.length).toBeGreaterThan(0);
    if (detail !== undefined) expect(missed.map((entry) => entry.detail)).toContain(detail);
  });
});

// ── 旗 v12.ids：構造の検査・画面と在ることの構造の確認をコードが作る走り（手 3d。Issue #624）──────────────────────────────

describe("旗 v12.ids：構造・画面・在ることの要件を含む走りは、コードが作った試験で照らし、宣言が表どおりなら full・違えば full が出ない（Issue #624）", () => {
  const flags: Partial<GenerationInputV11a> = { flags: { ledger: true, ids: true } };
  const R6_TEXT = "札を持てる。";
  const R7_TEXT = "項目の題名は文字列で、項目を登録できる。";
  const D_LIST_BASE: RequirementList = {
    ...BASE_LIST,
    requirements: [
      ...BASE_LIST.requirements,
      { id: "R6", text: R6_TEXT, quote: R6_TEXT, position: { start: 0, end: R6_TEXT.length } },
      { id: "R7", text: R7_TEXT, quote: R7_TEXT, position: { start: 0, end: R7_TEXT.length } },
    ],
  };
  const D_PLAN = planOf(D_LIST_BASE);
  const D_LIST = requirementsFromPlan(D_PLAN);
  const D_SOURCE = D_LIST_BASE.requirements.map((requirement) => requirement.text).join("");
  const D_IDS = [...IDS, "R6", "R7"] as const;
  const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });
  /** 札の entity（e.tag）と項目（f.tag.label）。R6 だけが所属させる（画面の行は無い） */
  const tagRow = (id: string, kind: "entity" | "field", entity: string | null, name: string, type: NameTable["rows"][number]["type"]) => ({
    id,
    kind,
    entity,
    name,
    role: "要件 R6 が使う対象",
    source: { requirementId: "R6", quote: "札" },
    type,
    options: null,
    groupBy: null,
    refEntity: null,
  });
  /** R6：画面が無く entity（札）を持つ在ることの要件。R7：checks 2 つ（field-type・action-kind）の構造の要件 */
  const D_TABLE_ON: NameTable = {
    ...TABLE_ON,
    rows: [...TABLE_ON.rows, tagRow("e.tag", "entity", null, "tag", null), tagRow("f.tag.label", "field", "e.tag", "label", "string")],
    ownership: [...TABLE_ON.ownership, { requirementId: "R6", roles: ["e.tag", "f.tag.label"].map(stated) }, { requirementId: "R7", roles: ["f.item.title", "o.addItem"].map(stated) }],
    verification: [
      ...TABLE_ON.verification,
      { requirementId: "R6", kind: "fixed-test" },
      { requirementId: "R7", kind: "structural", reason: "宣言の構造だけを求める", checks: ["field-type", "action-kind"] },
    ],
    classification: [...TABLE_ON.classification, { requirementId: "R6", nature: "existence-only" }, { requirementId: "R7", nature: "existence-only" }],
  };
  const D_RENAME = codeIdRenameOf(D_TABLE_ON);
  const D_MAPPED: NameTable = withCheckTargets(withCodeIds(D_TABLE_ON));
  /** T2 の応答（R2・R7 は要求に無い。R6 は entity だけなので試験は書かず分類だけ） */
  const dT2 = () =>
    renameIds(
      // 手 3e（#625）：応答は同じ内容の場合の形
      casesResponseOf({
        classifications: [...NATURES.filter((entry) => entry.requirementId !== "R2"), { requirementId: "R6", nature: "existence-only" }],
        tests: [...r1Tests(), ...r3Tests(), ...r4Tests()],
      }),
      D_RENAME,
    );
  /** 札の entity を足した宣言（`shown` なら札の表の画面も足す＝一覧がある） */
  const withTag = (yaml: string, shown: boolean) =>
    replaced(
      shown ? replaced(yaml, "actions:\n", "  - name: tags\n    type: table\n    entity: tag\n    show: [label]\nactions:\n") : yaml,
      "  - name: item\n    fields:\n",
      "  - name: tag\n    fields:\n      label:\n        type: string\n  - name: item\n    fields:\n",
    );
  const D_YAML = withTag(RUN_YAML, true);
  const dHead = (yaml: string): RecordedCall[] => [
    ...idsResponseList(idsResponsesOf(D_LIST, D_MAPPED, PROPERTY_LEDGER_VIEW)).map((output) => structured(output)),
    structured(acceptAll(D_IDS)),
    structured(dT2()),
    structured({ declaration: yaml }),
  ];
  const runD = (calls: readonly RecordedCall[]) => runScenario(calls, { plan: D_PLAN, source: D_SOURCE, ...flags });
  function spyReports() {
    const reports: { readonly mismatches: readonly { readonly testId: string; readonly detail: string }[]; readonly unresolved: readonly { readonly testId: string }[] }[] = [];
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
  const generatedOf = (result: Awaited<ReturnType<typeof runD>>["result"]) =>
    (artifactOf(result.bundle, "artifacts/test-spec.json") as { readonly generated_test_ids?: readonly string[] }).generated_test_ids ?? [];

  it("正例：宣言が表どおりなら不一致 0・今までの門で full。T2 の成果物のコードが作った試験 ID の並びに構造の検査（R2・R7）と画面（R4）・在ること（R6）がある", async () => {
    const reports = spyReports();
    const { result, recording } = await runD([...dHead(D_YAML), structured(acceptAll(D_IDS))]);
    expect(result.stopped, JSON.stringify(result.stopped)).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report.mismatches).toEqual([]);
      expect(report.unresolved).toEqual([]);
    }
    const spec = artifactOf(result.bundle, "artifacts/test-spec.json") as { readonly suite: TestSuite; readonly observes: Record<string, string> };
    const generatedIds = generatedOf(result);
    expect(spec.suite.tests.map((test) => test.id).slice(-generatedIds.length)).toEqual(generatedIds);
    expect(
      spec.suite.tests.filter((test) => generatedIds.includes(test.id)).map((test) => [test.target.requirementId, test.operation, spec.observes[test.id]]),
    ).toEqual([
      ["R2", "structure", "view-structure"],
      ["R4", "screen", "view-structure"],
      ["R4", "aggregate", "empty-aggregate"],
      ["R4", "aggregate", "empty-aggregate"],
      ["R6", "screen", "existence"],
      ["R7", "structure", "existence"],
      ["R7", "structure", "existence"],
    ]);
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME)!;
    const listed = dataBlockOf(t2.input, TEST_SPEC_DATA_NAMES[1]) as { requirements: { id: string }[] };
    expect(listed.requirements.map((requirement) => requirement.id)).toEqual(["R1", "R3", "R4", "R6"]);
    expectNoAcceptanceMaterial(recording.structured.map((request) => JSON.stringify(request)));
  });

  const negatives: readonly { readonly name: string; readonly yaml: string; readonly requirementId: string; readonly operation: string }[] = [
    {
      name: "宣言の項目の型が表と違う（題名を数にした）",
      yaml: replaced(D_YAML, "  - name: item\n    fields:\n      title:\n        type: string\n", "  - name: item\n    fields:\n      title:\n        type: number\n"),
      requirementId: "R7",
      operation: "structure",
    },
    {
      name: "画面が項目を見せない（担当者の表から名前を外した）",
      yaml: replaced(D_YAML, "    show: [title, itemCount]", "    show: [itemCount]"),
      requirementId: "R2",
      operation: "structure",
    },
    {
      name: "entity に create も一覧も無い（札の表を外した）",
      yaml: withTag(RUN_YAML, false),
      requirementId: "R6",
      operation: "screen",
    },
  ];

  it.each(negatives)("負例：$name 宣言は、コードが作った試験で不一致になり full が出ない（作り手で甘くならない）", async ({ yaml, requirementId, operation }) => {
    const reports = spyReports();
    const { result } = await runD([...dHead(yaml), repairDone(yaml)]);
    console.log("NEG", JSON.stringify({ stopped: result.stopped, stages: stageIds(result), reports }).slice(0, 1500));
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.summary.verdict).not.toBe("full");
    expect(reports.length).toBeGreaterThan(0);
    if (result.bundle === null) throw new Error(JSON.stringify({ stopped: result.stopped, stages: stageIds(result) }));
    const generatedIds = new Set(generatedOf(result));
    const spec = artifactOf(result.bundle, "artifacts/test-spec.json") as { readonly suite: TestSuite };
    const generatedTests = spec.suite.tests.filter((test) => generatedIds.has(test.id) && test.target.requirementId === requirementId && test.operation === operation);
    expect(generatedTests.length).toBeGreaterThan(0);
    const missed = reports[0]!.mismatches.filter((entry) => generatedTests.some((test) => test.id === entry.testId));
    expect(missed.length, JSON.stringify(reports[0])).toBeGreaterThan(0);
  });
});

// ── 旗 v12.ids：T2 は場合の形で書き、コードが展開する（手 3e。Issue #625）──────────────────────────────

describe("旗 v12.ids：値の要る要件を含む走りは、場合から展開した試験で照らし、宣言が表どおりなら full・違えば full が出ない（Issue #625）", () => {
  const IDS_FLAGS = { ledger: true, searchRepair: true, ids: true };
  /** B4 の結果を記録する（評価口はそのまま） */
  function spyMismatches() {
    const reports: (readonly string[])[] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      const evaluator = original(input);
      return {
        ...evaluator,
        runTests: (app, context, correspondence) => {
          const report = evaluator.runTests(app, context, correspondence);
          reports.push(report.mismatches.map((entry) => entry.testId));
          return report;
        },
      };
    });
    return reports;
  }

  it("正例：宣言が表どおりなら不一致 0・今までの門で full。T2 の成果物の組は展開した試験（case: の連番）で、LLM が書いた場合の数と応答の文字数の欄がある", async () => {
    const reports = spyMismatches();
    const { result } = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_FLAGS });
    vi.restoreAllMocks();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(reports.every((mismatches) => mismatches.length === 0)).toBe(true);
    if (result.bundle === null) throw new Error("納品物が無い");
    const spec = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.testSpec) as {
      readonly suite: { readonly tests: readonly { readonly id: string }[] };
      readonly llm_case_count?: number;
      readonly llm_response_chars?: number;
    };
    const response = renamed(idsT2Response());
    expect(spec.llm_case_count).toBe(response.cases.length);
    expect(spec.llm_response_chars).toBe(JSON.stringify(response).length);
    expect(spec.suite.tests.slice(0, response.cases.length).map((test) => test.id)).toEqual(response.cases.map((_, index) => `case:${String(index + 1)}`));
  });

  it("ids off（前の手の旗だけ on）の T2 の成果物には場合の数と応答の文字数の欄が無い", async () => {
    const { result } = await runScenario(
      [structured(t1Of(LIST, TABLE_ON)), structured(acceptAll()), structured(t2Response()), structured({ declaration: RUN_YAML }), structured(acceptAll())],
      { flags: { ledger: true, searchRepair: true } },
    );
    if (result.bundle === null) throw new Error(JSON.stringify(result.stopped));
    const spec = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.testSpec);
    expect(spec).not.toHaveProperty("llm_case_count");
    expect(spec).not.toHaveProperty("llm_response_chars");
    // 手 3i（#653）：必要な試験の枠の要約の欄も無い
    expect(spec).not.toHaveProperty("frame_remaining_total");
    expect(spec).not.toHaveProperty("frame_generated_count");
  });

  it("手 3i（#653）：ids on で段を回した走りの T2 の成果物に必要な試験の枠の要約の欄があり、値が組と一致する（コードの試験の数・要求の一覧の要件ごとの 16 − コードの試験の数の合計）", async () => {
    const { result, recording } = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_FLAGS });
    if (result.bundle === null) throw new Error(JSON.stringify(result.stopped));
    const spec = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.testSpec) as {
      readonly suite: { readonly tests: readonly { readonly id: string; readonly target: { readonly requirementId: string } }[] };
      readonly generated_test_ids: readonly string[];
      readonly frame_remaining_total?: number;
      readonly frame_generated_count?: number;
    };
    const t2 = recording.structured.find((request) => request.schemaName === TEST_SPEC_SCHEMA_NAME);
    if (t2 === undefined) throw new Error("T2 の要求が無い");
    const requested = requestListedIds(t2);
    const generated = spec.suite.tests.filter((test) => spec.generated_test_ids.includes(test.id));
    expect(spec.frame_generated_count).toBe(generated.length);
    expect(spec.frame_remaining_total).toBe(requested.reduce((sum, id) => sum + 16 - generated.filter((test) => test.target.requirementId === id).length, 0));
    expect(Object.keys(spec).slice(-2)).toEqual(["frame_remaining_total", "frame_generated_count"]);
  });

  const negatives = [
    { name: "検査のしきい値が違う", yaml: replaced(RUN_YAML, "    expression: amount > 0", "    expression: amount > 3"), requirementId: "R1" },
    { name: "操作の条件が違う", yaml: replaced(RUN_YAML, "    when: amount > 0", "    when: amount > 5"), requirementId: "R3" },
    { name: "計算の式が違う", yaml: replaced(RUN_YAML, "    expression: base * 2", "    expression: base * 3"), requirementId: "R4" },
  ];
  it.each(negatives)("負例：$name 宣言は、場合から展開した試験で不一致になり full が出ない（展開で甘くならない）", async ({ yaml, requirementId }) => {
    const reports = spyMismatches();
    // 直す段は道具の直し（旗 search-repair を外す）。直した版も同じ宣言なので不一致が残る
    const { result } = await runScenario([...idsHead({ yaml }), structured(acceptAll()), repairDone(yaml), structured(acceptAll())], { flags: { ledger: true, ids: true } });
    vi.restoreAllMocks();
    expect(result.outcome.verdict).not.toBe("full");
    expect(result.summary.verdict).not.toBe("full");
    if (result.bundle === null) throw new Error(JSON.stringify({ stopped: result.stopped, stages: stageIds(result) }));
    const spec = artifactOf(result.bundle, V11A_ARTIFACT_NAMES.testSpec) as { readonly suite: { readonly tests: readonly { readonly id: string; readonly target: { readonly requirementId: string } }[] } };
    const caseTests = new Set(spec.suite.tests.filter((test) => test.id.startsWith("case:") && test.target.requirementId === requirementId).map((test) => test.id));
    expect(reports[0]?.some((testId) => caseTests.has(testId))).toBe(true);
  });
});

// ── 旗 v12.ids：直す段の上限の停止を識別できる記録と、上限の塊（手 4c。Issue #665）──────────────────────────────

describe("旗 v12.ids：直す段の上限の停止に上限の名前と数を残し、直す段の入力に上限の塊を足す（Issue #665）", () => {
  // 直す段に入る宣言（R4 の計算の式が違う）。8 応答が全部道具の束（各 1 個）で、段内の上限に当たる
  const WRONG_YAML = replaced(RUN_YAML, "    expression: base * 2", "    expression: base * 3");
  const repairBundles = (): RecordedCall[] =>
    Array.from({ length: 8 }, (_, index) => repairToolCall(`rt${String(index)}`, "static-check", WRONG_YAML));
  const idsStop = () =>
    runScenario([...idsHead({ yaml: WRONG_YAML }), structured(acceptAll()), ...repairBundles()], { flags: { ledger: true, ids: true } });
  const LIMIT = { name: "repairStepTurns", max: 8, actual: 9 };

  it("ids on：失敗の帰属に limit があり、要約の v12_calls.repair に段ごとの数と合計がある。終了コード・stop_reason・診断の形は今のまま", async () => {
    const { result, recording } = await idsStop();
    expect(result.stopped).toEqual({ stage: "repair", kind: "call-limit", limit: LIMIT });
    expect(result.record.failure).toEqual({ stage: "repair", kind: "call-limit", limit: LIMIT });
    expect(result.summary.failure).toEqual({ stage: "repair", kind: "call-limit", limit: LIMIT });
    expect(result.summary.exit_code).toBe(1);
    expect(result.summary.stop_reason).toBe("call-limit");
    expect(result.summary.stop_class).toBe("call-limit");
    expect(result.outcome).toEqual({ result: "failed", verdict: "none" });
    expect(result.bundle).toBeNull();
    // 診断の一覧の止めた段と分類は段と種類だけ（形は今のまま）
    expect(diagnosticOf(result.diagnostics, DIAGNOSTICS_LISTING_FILE)["stopped"]).toEqual({ stage: "repair", kind: "call-limit" });
    const calls = (result.summary as unknown as Record<string, Record<string, unknown>>)["v12_calls"];
    if (calls === undefined) throw new Error("v12_calls が無い");
    // 既存の鍵はそのままの順で、repair は末尾に足すだけ（C3 の束の欄 semantic_check は T2 の前。Issue #735）
    expect(Object.keys(calls)).toEqual(["real_attempts", "judge_branch", "semantic_check", "test_spec", "repair"]);
    expect(calls["real_attempts"]).toEqual({ limit: 144, used: recording.structured.length + recording.tools.length });
    expect(calls["judge_branch"]).toEqual({ limit: 80, used: 0 });
    expect(calls["repair"]).toEqual({
      steps: [
        {
          responses: 8,
          tool_bundles: 8,
          tools_executed: 8,
          tool_calls_at_start: 0,
          tool_calls_at_end: 8,
          shape_retries: 0,
          limit: LIMIT,
          end: "call-limit",
        },
      ],
      total: { responses: 8, tools_executed: 8 },
    });
    // 直す段の要求：上限の塊が入力の末尾にあり、値は上限の表の定数と段の始めの累計。全往復で同じ
    expect(recording.tools).toHaveLength(8);
    for (const request of recording.tools) {
      expect(dataBlockOf(request.input, repairStage.REPAIR_STEP_LIMITS_DATA_NAME)).toEqual({
        repairStepTurns: { max: 8, received: 0 },
        toolCalls: { max: 24, usedAtStart: 0 },
      });
      expect(request.input).toBe(recording.tools[0]?.input);
      expect(request.input.endsWith("</data>")).toBe(true);
      // 手 4d（#666）：ids on の直す段は、上限の塊の後ろの末尾に「要る検査の骨組み」の塊を足す。それを外すと上限の塊が末尾
      expect(REQUIRED_VALIDATIONS_BLOCK.test(request.input)).toBe(true);
      expect(request.input.lastIndexOf("<data name=")).toBe(request.input.indexOf(`<data name="${repairStage.REPAIR_REQUIRED_VALIDATIONS_DATA_NAME}">`));
      const withoutSkeleton = withoutRequiredValidations(request).input;
      expect(withoutSkeleton.endsWith("</data>")).toBe(true);
      expect(withoutSkeleton.lastIndexOf("<data name=")).toBe(withoutSkeleton.indexOf(`<data name="${repairStage.REPAIR_STEP_LIMITS_DATA_NAME}">`));
    }
    expectNoAcceptanceMaterial(recording.tools.map((request) => request.input));
  });

  it("ids on：記録と要約のどこにも会話・道具の引数・宣言の本文が無く、同じ台本で 2 回同じ値", async () => {
    const first = await idsStop();
    const second = await idsStop();
    for (const value of [first.result.record, first.result.summary]) {
      const text = JSON.stringify(value);
      expect(text).not.toContain("base * 3");
      expect(text).not.toContain("rt0");
      expect(text).not.toContain("toolCalls\":[");
      expect(text).not.toContain("entities:");
    }
    expect(second.result.record).toEqual(first.result.record);
    expect(second.result.summary).toEqual(first.result.summary);
    expect(second.result.diagnostics).toEqual(first.result.diagnostics);
  });

  it("ids off（旗を省いた走り・ledger だけ on）：同じ台本で段内の上限に当たっても、limit の欄・repair の欄・上限の塊が無い", async () => {
    const offRuns = [
      await runScenario([...head({ yaml: WRONG_YAML }), structured(acceptAll()), ...repairBundles()]),
      await runScenario([...head({ yaml: WRONG_YAML, table: TABLE_ON }), structured(acceptAll()), ...repairBundles()], { flags: { ledger: true } }),
    ];
    for (const { result, recording } of offRuns) {
      expect(result.stopped).toEqual({ stage: "repair", kind: "call-limit" });
      expect(result.record.failure).toEqual({ stage: "repair", kind: "call-limit" });
      expect(result.summary.exit_code).toBe(1);
      expect(result.summary).not.toHaveProperty("v12_calls");
      expect(recording.tools.length).toBeGreaterThan(0);
      for (const request of recording.tools) expect(request.input).not.toContain(repairStage.REPAIR_STEP_LIMITS_DATA_NAME);
    }
  });

  it("ids on で直す段の上限に触れない走り（初回で通る）には repair の欄が無い（直す段を呼んだ走りだけ）", async () => {
    const { result } = await runScenario([...idsHead(), structured(acceptAll())], { flags: { ledger: true, ids: true } });
    const calls = (result.summary as unknown as Record<string, Record<string, unknown>>)["v12_calls"];
    expect(calls).toBeDefined();
    expect(calls).not.toHaveProperty("repair");
  });
});

// ── 窓口の条件（Issue #665 の申告 ④ の了承の条件 (i)(ii) と、ids off の search-repair の走り）──────────────────────────────
//
// 比較元のダイジェストは、**この Issue の直す前のコード**（統合の branch `integration/v12-h3d` の ed1ecd0）で同じ台本を流して取った値である。
// 直したあとも ids off の走り（旗を省いた v1.1α・ledger だけ on・ledger と search-repair が on）の記録・要約・診断・要求・
// stage-run.json と checkpoint はバイト列で同じであること（足すのは ids on の欄だけ）を固定する。

/** 要求から締切の合図を外す（値の比較に入れない） */
const requestBytes = (requests: readonly (LlmStructuredRequest | LlmToolRequest)[]): string =>
  JSON.stringify(requests.map(({ signal: _signal, ...rest }) => rest));

/** 段の走りの条件（固定の値。鍵は書かない） */
const STAGE_CONDITIONS = {
  model: "m",
  effort: "high",
  documents: [],
  judge: { primary: "llm", fallback: null },
  prompt_version: "v1.1a",
  vocabulary_version: "v1",
  contract_version: "v0.2",
  factory_version: "0.0.0",
  spec_engine_version: "0.0.0",
  budget_usd: 0.3,
  deadline_ms: 600_000,
  timeout_ms: null,
} as const;
const STAGE_VERSIONS = { vocabulary: "v1", contract: "v0.2", prompt: "v1.1a", factory: "0.0.0" } as const;

/** 段の走りの結果から、checkpoint の JSON の文字列と stage-run.json の文字列を組む（cli と同じ関数） */
async function stageRunFiles(outcome: Awaited<ReturnType<typeof runStageRangeV11a>>, range: { start: "name-table"; end: "judge" }) {
  const checkpoints = outcome.boundaries.map((materials) =>
    buildStageCheckpoint({ materials, versions: STAGE_VERSIONS, planSha256: "a".repeat(64), sourceSha256: "b".repeat(64) }),
  );
  const listed = await Promise.all(
    checkpoints.map(async (checkpoint, index) => ({
      boundary: outcome.boundaries[index]!.boundary,
      path: `cp-${String(index)}.json`,
      output_digest: await stageOutputDigest(checkpoint),
    })),
  );
  const record = buildStageRunRecord({
    range,
    input: null,
    planSha256: "a".repeat(64),
    sourceSha256: "b".repeat(64),
    checkpoints: listed,
    conditions: STAGE_CONDITIONS,
    outcome,
    exitCode: outcome.stopped === null ? 0 : 1,
  });
  return { checkpointTexts: checkpoints.map(stageJsonText), listed, recordText: stageJsonText(record), record };
}

describe("窓口の条件（Issue #665）：ids off の要約・診断・stage-run.json はバイト列で不変、再開の照合と checkpoint は limit を読まない・書かない", () => {
  const WRONG_YAML = replaced(RUN_YAML, "    expression: base * 2", "    expression: base * 3");
  const repairBundles = (): RecordedCall[] =>
    Array.from({ length: 8 }, (_, index) => repairToolCall(`rt${String(index)}`, "static-check", WRONG_YAML));
  const RANGE = { start: "name-table", end: "judge" } as const;

  /** 比較元（ed1ecd0）で同じ台本を流して取ったダイジェスト */
  const BEFORE = {
    v11aStop: "5cd420e515ce58a7c2e3345fec20a70350e653cd946085bedb19c6a003fcfdea",
    ledgerStop: "fa1933e340a873a9e19eed42eb7166e705296cac3533062ef89387f47da5f9fb",
    searchRepairDone: "6d90268e43a278eb6d0f46a278dc3a989850d6b45c85724efc07f2dadeafacb2",
    searchRepairStop: "9f7878877188b7147c613c5235c07e8d9131ff4a96d866643e3af313e33de8ca",
    stageRunOff: "8b653f6dd51a142b9753c3cc3d6a02770c939258c400a0eadacaa0199cc4e849",
  } as const;

  const digestOf = async (scenario: Awaited<ReturnType<typeof runScenario>>): Promise<string> =>
    sha256Hex(
      JSON.stringify({
        result: scenario.result,
        structured: requestBytes(scenario.recording.structured),
        tools: requestBytes(scenario.recording.tools),
      }),
    );

  it("(i) 旗を省いた v1.1α の走り：直す段の上限で止まる台本の結果（記録・要約・診断）と要求が直す前とバイト列で同じ", async () => {
    const run = await runScenario([...head({ yaml: WRONG_YAML }), structured(acceptAll()), ...repairBundles()]);
    expect(run.result.stopped).toEqual({ stage: "repair", kind: "call-limit" });
    expect(await digestOf(run)).toBe(BEFORE.v11aStop);
  });

  it("(i) ids off（ledger だけ on）の走り：同じ台本の結果と要求が直す前とバイト列で同じ", async () => {
    const run = await runScenario([...head({ yaml: WRONG_YAML, table: TABLE_ON }), structured(acceptAll()), ...repairBundles()], {
      flags: { ledger: true },
      recordV12Flags: true,
    });
    expect(run.result.stopped).toEqual({ stage: "repair", kind: "call-limit" });
    expect(await digestOf(run)).toBe(BEFORE.ledgerStop);
  });

  it("ids off で search-repair だけ on（と ledger）の走り：道具付きの直す段を通って完走する台本と、止まる台本の結果と要求が直す前とバイト列で同じ", async () => {
    const done = await runScenario(
      [...searchHead({ yaml: MIS2 }), structured(acceptAll()), repairDone(MIS1), structured(acceptAll()), repairDone(SEARCH_YAML), structured(acceptAll())],
      { flags: { searchRepair: true }, recordV12Flags: true },
    );
    expect(done.result.outcome.verdict).toBe("full");
    expect(done.recording.tools.length).toBeGreaterThan(0);
    expect(await digestOf(done)).toBe(BEFORE.searchRepairDone);
    const stop = await runScenario([...head({ yaml: WRONG_YAML, table: TABLE_ON }), structured(acceptAll()), ...repairBundles()], {
      flags: { ledger: true, searchRepair: true },
      recordV12Flags: true,
    });
    expect(stop.result.stopped).not.toBeNull();
    expect(await digestOf(stop)).toBe(BEFORE.searchRepairStop);
  });

  it("(i) 旗を省いた段の走り（T1 → ⑦）：直す段の上限で止まる台本の stage-run.json と checkpoint の文字列が直す前とバイト列で同じ", async () => {
    const recording = createCheckedRecordingClient([...head({ yaml: WRONG_YAML }), structured(acceptAll()), ...repairBundles()]);
    const outcome = await runStageRangeV11a({ ...inputOf(recording.client), range: RANGE });
    expect(outcome.stopped).toEqual({ stage: "repair", kind: "call-limit" });
    const files = await stageRunFiles(outcome, RANGE);
    const digest = await sha256Hex(JSON.stringify({ record: files.recordText, checkpoints: files.checkpointTexts }));
    expect(digest).toBe(BEFORE.stageRunOff);
    expect((files.record as Record<string, unknown>)["stopped"]).toEqual({ stage: "repair", kind: "call-limit" });
  });

  it("(ii) ids on の段の走り：stopped にだけ limit が足され、checkpoint は直す段の結果に依らず同じで limit を持たず、再開の照合は limit を読まない（stopped を差し替えても同じ結果）", async () => {
    const flags = { flags: { ledger: true, ids: true } } as const;
    const stopRecording = createCheckedRecordingClient([...idsHead({ yaml: WRONG_YAML }), structured(acceptAll()), ...repairBundles()]);
    const stopped = await runStageRangeV11a({ ...inputOf(stopRecording.client, flags), range: RANGE });
    expect(stopped.stopped).toEqual({ stage: "repair", kind: "call-limit", limit: { name: "repairStepTurns", max: 8, actual: 9 } });
    // 対照：同じ境界までの台本で、直す段が done を返して最後まで流れる走り
    const doneRecording = createCheckedRecordingClient([...idsHead({ yaml: WRONG_YAML }), structured(acceptAll()), repairDone(WRONG_YAML), structured(acceptAll())]);
    const passed = await runStageRangeV11a({ ...inputOf(doneRecording.client, flags), range: RANGE });
    expect(passed.stopped).toBeNull();

    const stopFiles = await stageRunFiles(stopped, RANGE);
    const doneFiles = await stageRunFiles(passed, RANGE);
    // checkpoint：境界は T1''／T2・T2／B1 の 2 つで、直す段の止まり方に依らずバイト列で同じ。limit も上限の名前も書かない
    expect(stopFiles.checkpointTexts).toHaveLength(2);
    expect(stopFiles.checkpointTexts).toEqual(doneFiles.checkpointTexts);
    for (const text of stopFiles.checkpointTexts) {
      expect(text).not.toContain('"limit":');
      expect(text).not.toContain("repairStepTurns");
    }
    // stage-run.json：ids on の stopped にだけ limit が載る
    expect((stopFiles.record as Record<string, unknown>)["stopped"]).toEqual(stopped.stopped);

    // 再開の照合：stopped の limit を外した記録・stopped を null にした記録と、照合の結果が同じ（limit を読まない）
    const strippedRecord = { ...stopFiles.record, stopped: { stage: "repair", kind: "call-limit" } };
    const nullRecord = { ...stopFiles.record, stopped: null };
    const boundaryIndex = stopped.boundaries.findIndex((entry) => entry.boundary === "t1-t2");
    const verifyWith = (recordText: string) =>
      verifyStageInput({
        start: "test-spec",
        checkpointText: stopFiles.checkpointTexts[boundaryIndex] ?? null,
        checkpointFile: `cp-${String(boundaryIndex)}.json`,
        recordText,
        plan: PLAN,
        planSha256: "a".repeat(64),
        sourceSha256: "b".repeat(64),
        vocabularyVersion: "v1",
        contractVersion: "v0.2",
      });
    const withLimit = await verifyWith(stopFiles.recordText);
    if (!withLimit.ok) throw new Error(`通るはず：${withLimit.code}`);
    expect(await verifyWith(stageJsonText(strippedRecord))).toEqual(withLimit);
    expect(await verifyWith(stageJsonText(nullRecord))).toEqual(withLimit);
    // 再開の材料にも limit が無い
    expect(JSON.stringify(withLimit)).not.toContain('"limit":');
    expect(JSON.stringify(withLimit)).not.toContain("repairStepTurns");
  });
});

// ── 旗 v12.ids：B1 と直す段に要る検査の骨組みを渡す（手 4d。Issue #666）──────────────────────────────

describe("旗 v12.ids：B1（初回・作り直し）と直す段に、その時点の有効な組から導いた要る検査の骨組みを渡す（Issue #666）", () => {
  const IDS_ONLY = { ledger: true, ids: true };
  /** 検査の名前だけを表の項目の名前と別にした宣言（同じ式。結び付けは名前で結ぶので結ばない） */
  const RENAMED_YAML = replaced(RUN_YAML, "  - name: amount\n    entity: item", "  - name: positive\n    entity: item");
  const R07 = WRITE_V11A_RULE_DEFINITIONS.find((definition) => definition.id === "R-w11-07");
  const writeOf = (requests: readonly LlmStructuredRequest[]) => requests.filter((request) => request.schemaName === WRITE_V11A_SCHEMA_NAME);
  type Entry = { readonly entity: string | null; readonly name: string; readonly rowId: string; readonly rowKind: string; readonly testIds: readonly string[]; readonly conflict: boolean };
  /** 納品物の試験の組（T2 で固定した組）の validate の試験 */
  /** B4 の結果（不一致・未解決の試験 ID）を版ごとに記録する（評価口はそのまま） */
  function spyRunTests() {
    const reports: { readonly mismatches: readonly string[]; readonly unresolved: readonly string[] }[] = [];
    const original = evaluateModule.createV11aEvaluator;
    vi.spyOn(evaluateModule, "createV11aEvaluator").mockImplementation((input) => {
      const evaluator = original(input);
      return {
        ...evaluator,
        runTests: (app, context, correspondence) => {
          const report = evaluator.runTests(app, context, correspondence);
          reports.push({ mismatches: report.mismatches.map((entry) => entry.testId), unresolved: report.unresolved.map((entry) => entry.testId) });
          return report;
        },
      };
    });
    return reports;
  }
  const validateTestsOf = (bundle: AssembledBundle | null) =>
    (artifactOf(bundle, V11A_ARTIFACT_NAMES.testSpec) as { readonly suite: { readonly tests: readonly FixedTest[] } }).suite.tests.filter(
      (test) => test.operation === "validate",
    );

  it("書く台本：B1 の要求の「固定した試験」の後に骨組みがあり（項目 amount の validate 試験だけ・競合なし）、R-w11-07 は旗 ids の文。B1 が骨組みどおりの検査を書けば初版の B4 の validate は結び付き、不一致 0・今までの門で full", async () => {
    const reports = spyRunTests();
    const { result, recording } = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_ONLY });
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const [write] = writeOf(recording.structured);
    if (write === undefined) throw new Error("前提が壊れた：B1 の要求が無い");
    const names = [...write.input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1]);
    expect(names).toEqual([...WRITE_V11A_DATA_NAMES, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME]);
    const skeleton = dataBlockOf(write.input, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME) as readonly Entry[];
    const amountRow = MAPPED_IDS.rows.find((row) => row.kind === "field" && row.name === "amount");
    const validated = validateTestsOf(result.bundle).filter((test) => test.target.roleId === amountRow?.id);
    expect(validated.length).toBeGreaterThan(0);
    expect(skeleton).toEqual([{ entity: "item", name: "amount", rowId: amountRow?.id, rowKind: "field", testIds: validated.map((test) => test.id), conflict: false }]);
    expect(write.rules).toContain(WRITE_V11A_IDS_R07_DEFINITION.text);
    expect(write.rules).not.toContain(R07?.text);
    // 初版の B4：validate の試験は不一致・未解決に無い
    expect(reports[0]?.mismatches.filter((id) => skeleton[0]?.testIds.includes(id))).toEqual([]);
    expect(reports[0]?.unresolved.filter((id) => skeleton[0]?.testIds.includes(id))).toEqual([]);
    expectNoAcceptanceMaterial([write.input, ...(write.rules ?? [])]);
  });

  it("書かない台本（検査の名前だけ別）：初版は今までどおり不一致になり（結び直さない）、直す段の入力の末尾に B1 と同じ骨組みが載る。直した版が骨組みどおりなら full", async () => {
    const reports = spyRunTests();
    const { result, recording } = await runScenario([...idsHead({ yaml: RENAMED_YAML }), structured(acceptAll()), repairDone(RUN_YAML), structured(acceptAll())], {
      flags: IDS_ONLY,
    });
    const [write] = writeOf(recording.structured);
    if (write === undefined) throw new Error("前提が壊れた：B1 の要求が無い");
    const skeleton = dataBlockOf(write.input, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME) as readonly Entry[];
    const testIds = skeleton.flatMap((entry) => entry.testIds);
    expect(testIds.length).toBeGreaterThan(0);
    expect(reports[0]?.mismatches).toEqual(expect.arrayContaining(testIds));
    expect(recording.tools.length).toBeGreaterThan(0);
    for (const request of recording.tools) {
      expect(dataBlockOf(request.input, repairStage.REPAIR_REQUIRED_VALIDATIONS_DATA_NAME)).toEqual(skeleton);
      expect(request.input.lastIndexOf("<data name=")).toBe(request.input.indexOf(`<data name="${repairStage.REPAIR_REQUIRED_VALIDATIONS_DATA_NAME}">`));
      expect(request.rules).toEqual(repairStage.REPAIR_RULES);
    }
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("書かない台本のまま直しても名前が別なら不一致が残り、full は出ない（骨組みを渡しても結び付かない版は今までどおり不一致）", async () => {
    const { result } = await runScenario([...idsHead({ yaml: RENAMED_YAML }), structured(acceptAll()), repairDone(RENAMED_YAML), structured(acceptAll())], { flags: IDS_ONLY });
    expect(result.outcome.verdict).not.toBe("full");
  });

  it("off（旗を省いた走り・ledger だけ on）：同じ台本で B1・直す段に骨組みの塊が無く、R-w11-07 は元の文", async () => {
    const offRuns = [
      await runScenario([...head({ yaml: RENAMED_YAML }), structured(acceptAll()), repairDone(RUN_YAML), structured(acceptAll())]),
      await runScenario([...head({ yaml: RENAMED_YAML, table: TABLE_ON }), structured(acceptAll()), repairDone(RUN_YAML), structured(acceptAll())], { flags: { ledger: true } }),
    ];
    for (const { recording } of offRuns) {
      const writes = writeOf(recording.structured);
      expect(writes.length).toBeGreaterThan(0);
      for (const request of writes) {
        expect(request.input).not.toContain(WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME);
        expect(request.rules).toContain(R07?.text);
        expect(request.rules).not.toContain(WRITE_V11A_IDS_R07_DEFINITION.text);
      }
      expect(recording.tools.length).toBeGreaterThan(0);
      for (const request of recording.tools) expect(request.input).not.toContain(repairStage.REPAIR_REQUIRED_VALIDATIONS_DATA_NAME);
    }
  });

  it("作り直し（旗 search-repair と ids）：作り直しの B1 の要求も「固定した試験」の後に同じ骨組みを持ち、R-w11-07 は旗 ids の文", async () => {
    const { result, recording } = await runScenario(
      [
        ...idsHead({ yaml: RENAMED_YAML }),
        structured(acceptAll()),
        // 手 4e（#667）：要求する検査（item.amount）が宣言に無く entity が在るので、往復は追加の場所への欄だけの直しになる。
        // 何も返さない直し（同じ版）を 2 回で停滞させ、作り直しへ進める
        structured({ replacements: [], disputes: [] }),
        structured(acceptAll()),
        structured({ replacements: [], disputes: [] }),
        structured(acceptAll()),
        structured({ declaration: RUN_YAML }),
        structured(acceptAll()),
      ],
      { flags: { ledger: true, searchRepair: true, ids: true } },
    );
    const writes = writeOf(recording.structured);
    expect(writes).toHaveLength(2);
    const [first, rewrite] = writes;
    if (first === undefined || rewrite === undefined) throw new Error("前提が壊れた");
    const names = [...rewrite.input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1]);
    expect(names).toEqual([...WRITE_V11A_DATA_NAMES, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME, WRITE_V11A_REWRITE_DATA_NAME]);
    expect(dataBlockOf(rewrite.input, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME)).toEqual(dataBlockOf(first.input, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME));
    expect(rewrite.rules).toContain(WRITE_V11A_IDS_R07_DEFINITION.text);
    expect(rewrite.rules).not.toContain(R07?.text);
    // 手 4e（#667）：往復は追加の場所への欄だけの直し（道具付きの直す段を呼ばない）。欄だけの直しの入力に骨組みの塊は載せない
    // （失敗の一覧の追加の場所が同じ事実を持つ）。道具付きの直す段に骨組みが載ることは「書かない台本」の試験が固定する
    expect(recording.tools).toEqual([]);
    const fields = recording.structured.filter((request) => request.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fields).toHaveLength(2);
    for (const request of fields) expect(request.input).not.toContain(WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME);
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
  });

  it("同じ台本で 2 回同じ要求（骨組みは決定的）。段の記録・要約・納品物は骨組みの塊の有無で変わらない（記録を足さない）", async () => {
    const first = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_ONLY });
    const second = await runScenario([...idsHead(), structured(acceptAll())], { flags: IDS_ONLY });
    expect(JSON.stringify(second.recording.structured.map(({ signal: _signal, ...rest }) => rest))).toBe(
      JSON.stringify(first.recording.structured.map(({ signal: _signal, ...rest }) => rest)),
    );
    for (const value of [first.result.record, first.result.summary]) expect(JSON.stringify(value)).not.toContain(WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME);
    expect(first.result.bundle?.artifacts.some((artifact) => artifact.text.includes(WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME))).toBe(false);
  });
});

// ── 旗 v12.ids：要求する検査が無い失敗を追加の場所として欄だけの直しに渡す（手 4e。Issue #667）──────────────────────────────
//
// 原因 2 の台本の合成：初版は検査 0（`validations: []`）で、名前の異なる 2 項目（R1 の金額と題名）の validate の試験が結び付かない
// （金額は正常・異常・境界の 3 件＝T2 の門が ruled の要件に境界を要るので 3 件、題名は正常 1 件の、計 4 件）。
// 旗 ids の走りは、要る検査の場所（結び付けと同じ関数）が宣言に無く entity が在るので追加の場所 2 つに写し、欄だけの直し（構造化
// 出力）1 回で本文を受け、コードが validations の末尾に挿し込み、静的チェック・B3・B3'・B4 を全部掛け直す。

describe("旗 v12.ids：要求する検査が宣言に無い失敗を追加の場所に写し、欄だけの直しの本文をコードが挿し込んで門を全部掛け直す（Issue #667）", () => {
  const IDS_SEARCH = { flags: { ledger: true, searchRepair: true, ids: true } };
  /** 初版：検査 0 */
  const NOVAL_YAML = replaced(RUN_YAML, "validations:\n  - name: amount\n    entity: item\n    expression: amount > 0\n", "validations: []\n");
  /** 正しい版：金額と題名の検査 */
  const FIXED_YAML = replaced(RUN_YAML, "    expression: amount > 0\n", "    expression: amount > 0\n  - name: title\n    entity: item\n    expression: title != \"\"\n");
  const AMOUNT = "validation:item.amount";
  const TITLE = "validation:item.title";
  const body = (name: string, expression: string): string => [`- name: ${name}`, "  entity: item", `  expression: ${expression}`].join("\n");
  const add = (amount: string, title: string | null = "title != \"\""): RecordedCall =>
    structured({
      replacements: [{ location: AMOUNT, element: body("amount", amount) }, ...(title === null ? [] : [{ location: TITLE, element: body("title", title) }])],
      disputes: [],
    });
  /** R1 の validate の試験 4 件（金額の正常・異常・境界と、題名の正常） */
  const titleTest = () =>
    rawTest({
      id: "r1-title",
      requirementId: "R1",
      targetKind: "field",
      roleId: "f.item.title",
      operation: "validate",
      observes: "validation",
      input: { "f.item.title": "a" },
      expected: ok("true"),
    });
  const r1Four = () => [...r1Tests(), titleTest()];
  const idsT2 = () => idsT2Response([...r1Four(), ...r3Tests(), ...r4Tests()]);
  const head667 = (yaml: string = NOVAL_YAML) => idsHead({ yaml, t2: idsT2() });

  it("二点測定（後）：追加の場所 2 → 欄だけの直し 1 回 → 挿し込み → B4 で結び付き不一致 0 で採って full。全文の直しの段は呼ばれない（往復 1・段の呼び出し 1・道具 0）", async () => {
    const { result, recording } = await runScenario([...head667(), structured(acceptAll()), add("amount > 0"), structured(acceptAll())], IDS_SEARCH);
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(recording.tools).toEqual([]);
    const fields = fieldRequests(recording.structured);
    expect(fields).toHaveLength(1);
    const [request] = fields;
    if (request === undefined) throw new Error("前提が壊れた");
    expect(locationEnumOf(request)).toEqual([AMOUNT, TITLE]);
    expect(countStage(result, "repair")).toBe(1);
    // 欄だけの直しは 1 往復に論理 1（形のやり直しなし）
    expect(result.record.stages.filter((stage) => stage.stage === "repair").map((stage) => stage.calls)).toEqual([1]);
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 4, true],
      ["repair", 0, true],
    ]);
    expect(declarationOf(result.bundle)).toBe(FIXED_YAML);
    expect(roundsOf(result.bundle)).toEqual([{ hand: "field-repair", locations: 2, unlocated: 0, refused: null, additions: 2 }]);
    expect(request.input).not.toContain(WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME);
    expectNoAcceptanceMaterial([request.input, ...(request.rules ?? [])]);
  });

  it("二点測定（前）：ids off（search-repair だけ on）の同じ初版は場所なし 4 で全文の直しの段（道具付き）へ流れる。記録に追加の欄が無い", async () => {
    const { result, recording } = await runScenario(
      [...head({ yaml: NOVAL_YAML, t2: t2Response([...r1Four(), ...r2Tests(), ...r3Tests(), ...r4Tests()]) }), structured(acceptAll()), repairDone(FIXED_YAML), structured(acceptAll())],
      SEARCH,
    );
    expect(recording.tools).toHaveLength(1);
    expect(fieldRequests(recording.structured)).toEqual([]);
    const rounds = roundsOf(result.bundle);
    expect(rounds).toEqual([{ hand: "repair", locations: 0, unlocated: 4, refused: null }]);
    for (const round of rounds) expect("additions" in round).toBe(false);
    expect(result.outcome.verdict).toBe("full");
  });

  it("負例 (a)：追加した検査の式が正常／異常を逆にし、題名の式も誤れば B4 の不一致が減らず採らない（門）。次の往復の入力は一番良い版のまま", async () => {
    const { result, recording } = await runScenario(
      [...head667(), structured(acceptAll()), add("amount < 0", "title == \"\""), structured(acceptAll()), add("amount > 0"), structured(acceptAll())],
      IDS_SEARCH,
    );
    expect(fieldDeclarations(recording.structured)).toEqual([NOVAL_YAML, NOVAL_YAML]);
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 4, true],
      ["repair", 4, false],
      ["repair", 0, true],
    ]);
    expect(result.outcome.verdict).toBe("full");
    expect(recording.tools).toEqual([]);
  });

  it("負例 (b)：2 回目の往復で同じ（entity・名前）は既に在るので置換の場所になり、追加が重複しない。記録に往復ごとの追加の場所の数", async () => {
    const { result, recording } = await runScenario(
      [
        ...head667(),
        structured(acceptAll()),
        add("amount > 0", "title == \"\""),
        structured(acceptAll()),
        structured({ replacements: [{ location: TITLE, element: body("title", "title != \"\"") }], disputes: [] }),
        structured(acceptAll()),
      ],
      IDS_SEARCH,
    );
    const fields = fieldRequests(recording.structured);
    expect(fields.map(locationEnumOf)).toEqual([[AMOUNT, TITLE], [TITLE]]);
    expect(roundsOf(result.bundle)).toEqual([
      { hand: "field-repair", locations: 2, unlocated: 0, refused: null, additions: 2 },
      { hand: "field-repair", locations: 1, unlocated: 0, refused: null, additions: 0 },
    ]);
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 4, true],
      ["repair", 1, true],
      ["repair", 0, true],
    ]);
    expect(declarationOf(result.bundle)).toBe(FIXED_YAML);
    expect(result.outcome.verdict).toBe("full");
  });

  it("負例 (d)：存在しない entity の名前を書いた追加は形で落ち、1 回だけ直させる（続けば malformed で段が止まる）", async () => {
    const wrong = structured({ replacements: [{ location: AMOUNT, element: body("amount", "amount > 0").replace("entity: item", "entity: nowhere") }], disputes: [] });
    const { result } = await runScenario([...head667(), structured(acceptAll()), wrong, add("amount > 0"), structured(acceptAll())], IDS_SEARCH);
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    // 1 往復に論理 1（形 1 を含めて応答 2）のまま
    expect(result.record.stages.filter((stage) => stage.stage === "repair").map((stage) => [stage.calls, stage.retries.shape])).toEqual([[2, 1]]);
    const stopped = await runScenario([...head667(), structured(acceptAll()), wrong, wrong], IDS_SEARCH);
    expect(stopped.result.outcome.verdict).not.toBe("full");
    expect(stopped.recording.tools).toEqual([]);
  });

  it("中身のある流れの書き方の検査の節（validations: [ … ]）の初版は追加の場所を作らず、K3 の前（ids off）と同じ経路をとる（欄だけの直しを呼ばず、道具付きの直す段へ流れる。止まり方も off と同じ）", async () => {
    // spec-engine の読み取りは `{ }` の写像を読めないので、読める中身のある流れの書き方は名前だけの並びで、静的チェックに落ちる。
    // 静的チェックに落ちた版は追加の場所を作らない（場所の純粋な試験は locate.test.ts）。挿し込みを断って往復を消費する経路は無い
    const flow = replaced(NOVAL_YAML, "validations: []\n", "validations: [amount]\n");
    const on = await runScenario([...head667(flow), structured(acceptAll()), repairDone(FIXED_YAML), structured(acceptAll())], IDS_SEARCH);
    const off = await runScenario(
      [...head({ yaml: flow, t2: t2Response([...r1Four(), ...r2Tests(), ...r3Tests(), ...r4Tests()]) }), structured(acceptAll()), repairDone(FIXED_YAML), structured(acceptAll())],
      SEARCH,
    );
    for (const run of [on, off]) {
      expect(fieldRequests(run.recording.structured)).toEqual([]);
      expect(run.recording.tools).toHaveLength(1);
    }
    expect(on.result.outcome).toEqual(off.result.outcome);
    expect(on.result.stopped).toEqual(off.result.stopped);
    expect(stageIds(on.result).slice(-2)).toEqual(stageIds(off.result).slice(-2));
  });

  it("同じ台本で 2 回同じ値（要求・記録・納品物）", async () => {
    const script = () => [
      ...head667(),
      structured(acceptAll()),
      add("amount > 0", "title == \"\""),
      structured(acceptAll()),
      structured({ replacements: [{ location: TITLE, element: body("title", "title != \"\"") }], disputes: [] }),
      structured(acceptAll()),
    ];
    const first = await runScenario(script(), IDS_SEARCH);
    const second = await runScenario(script(), IDS_SEARCH);
    expect(JSON.stringify(second.recording.structured.map(({ signal: _signal, ...rest }) => rest))).toBe(
      JSON.stringify(first.recording.structured.map(({ signal: _signal, ...rest }) => rest)),
    );
    expect(roundsOf(second.result.bundle)).toEqual(roundsOf(first.result.bundle));
    expect(second.result.bundle?.artifacts).toEqual(first.result.bundle?.artifacts);
  });
});

describe("旗 v12.ids の C2 の初回の束（Issue #736）：C3 の拒否のあとの 2 回目が落ちれば、採らなかった部分の結果は checkpoint と納品物に混ざらない", () => {
  const ALL_ON = fromPublicV12Flags(V12_PIPELINE_FLAGS);
  type Entry = Record<string, unknown>;
  const runSized = async (materials: SizedMaterials, calls: readonly RecordedCall[]) => {
    // 束 2 つ以上の C2 の初回・C3・T2 は束ごとに同時に呼ぶので、記録した応答を束ごとに読む（calls.test.ts の偽物の口と同じ重ね方）
    const structuredRequests: LlmStructuredRequest[] = [];
    const inner = bundledC2Client(bundledC3Client(bundledT2Client(createFakeLlmClient(calls, { validateAgainstSchema: true }))));
    const client: GenerationInputV11a["client"] = {
      async callStructured(request) {
        structuredRequests.push(request);
        return inner.callStructured(request);
      },
      callWithTools: (request) => inner.callWithTools(request),
    };
    const recording = { structured: structuredRequests };
    const result = await runGenerationV11a({
      ...inputOf(client, { source: materials.source, plan: materials.plan, judge: createFakeJudge(materials.adviceAnswers()), budgetUsd: 1_000, deadline: 86_400_000 }),
      flags: ALL_ON,
      collectBoundaries: true,
    });
    return { result, recording };
  };

  it("(7) 要件 15（束 3）：C3 が束 1 の X と束 3 の Y を拒否し、2 回目（X・Y だけの 1 要求）が C2' に落ちると、初回の表と初回の拒否で持ち越し、2 回目の部分の結果（X の分類の入れ替え・Y の表に無い所属）は t1-t2 の checkpoint と納品物に無い", async () => {
    const materials = buildSized(MEDIAN_SIZE.requirements, MEDIAN_SIZE.tests, ALL_ON);
    const [entities, fields, behaviors, mapping] = materials.tableResponses() as readonly Record<string, readonly Entry[]>[];
    if (entities === undefined || fields === undefined || behaviors === undefined || mapping === undefined) throw new Error("前提が壊れた：C1・C2 の応答が 4 つでない");
    const X = materials.ids[1] as string;
    const Y = materials.ids[11] as string;
    const head = [structured(entities), structured(fields), structured(behaviors), structured(mapping)];
    const tailWithout = (excluded: readonly string[]) => {
      const t2 = materials.testSpecCasesResponse();
      return [
        structured({
          classifications: (t2.classifications as readonly { requirementId: string }[]).filter((entry) => !excluded.includes(entry.requirementId)),
          cases: t2.cases.filter((entry) => !excluded.includes(String(entry["requirementId"]))),
        }),
        structured({ declaration: materials.declaration() }),
        structured({ judgments: (materials.judgments().judgments as readonly { requirementId: string }[]).filter((entry) => !excluded.includes(entry.requirementId)) }),
      ];
    };
    const entryOf = (id: string) => (mapping["requirements"] ?? []).find((entry) => entry["requirementId"] === id) as Entry;
    const flippedX = { ...entryOf(X), nature: entryOf(X)["nature"] === "ruled" ? "existence-only" : "ruled" };
    const brokenY = { ...entryOf(Y), roles: [...(entryOf(Y)["roles"] as readonly Entry[]), { id: "E1.F99", basis: "stated", reason: null }] };
    const firstJudgments = materials.judgments({ [X]: ["unnecessary-ownership", materials.textOf(X)], [Y]: ["weak-verification", materials.textOf(Y)] });
    const { result, recording } = await runSized(materials, [...head, structured(firstJudgments), structured({ requirements: [flippedX, brokenY] }), ...tailWithout([X, Y])]);
    // 初回の表の基準：同じ C2 の応答で C3 が全部受理する走り
    const clean = await runSized(materials, [...head, structured(materials.judgments()), ...tailWithout([])]);
    expect(clean.result.stopped, JSON.stringify(clean.result.stopped)).toBeNull();
    expect(clean.result.outcome).toEqual({ result: "pass", verdict: "full" });

    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).toBe("partial");
    const k = Math.ceil(MEDIAN_SIZE.requirements / 5);
    const mappingRequests = recording.structured.filter((request) => request.schemaName === MAPPING_SCHEMA_NAME);
    // 初回の束 k と 2 回目 1（X・Y だけ。形の再試行なし）。C3 の再点検は呼ばない（1 回目の束 k だけ）
    expect(mappingRequests).toHaveLength(k + 1);
    expect(dataBlockOf(mappingRequests[k]?.input ?? "", "書き直す要件")).toEqual([X, Y]);
    expect(recording.structured.filter((request) => request.schemaName === SEMANTIC_CHECK_SCHEMA_NAME)).toHaveLength(k);
    expect(result.record.stages.filter((record) => record.stage === "mapping").map((record) => [record.status, record.failure_kind])).toEqual([
      ["ok", null],
      ["failed", "unmet"],
    ]);
    // 持ち越しは初回の拒否のまま（一覧の順）
    expect(carryEntriesOf(result.bundle)).toEqual([
      { requirementId: X, reasons: [{ origin: "semantic-check", reason: "unnecessary-ownership" }] },
      { requirementId: Y, reasons: [{ origin: "semantic-check", reason: "weak-verification" }] },
    ]);
    // 納品物の表は初回の表（2 回目の X の分類の入れ替えは混ざらない）
    const table = artifactOf(result.bundle, "artifacts/name-table.json") as { readonly table_sha256: string; readonly classification: readonly { requirementId: string; nature: string }[] };
    const cleanTable = artifactOf(clean.result.bundle, "artifacts/name-table.json") as typeof table;
    expect(table.table_sha256).toBe(cleanTable.table_sha256);
    expect(table.classification.find((entry) => entry.requirementId === X)?.nature).toBe(entryOf(X)["nature"]);
    // t1-t2 の checkpoint は初回の表・初回の判定・初回の拒否の持ち越し
    const boundary = result.boundaries?.find((entry) => entry.boundary === "t1-t2");
    const cleanBoundary = clean.result.boundaries?.find((entry) => entry.boundary === "t1-t2");
    expect(boundary?.table).toEqual(cleanBoundary?.table);
    expect(boundary?.semanticCheck.tableSha256).toBe(cleanTable.table_sha256);
    expect(boundary?.semanticCheck.judgments.map((judgment) => [judgment.requirementId, judgment.verdict])).toEqual(
      (firstJudgments.judgments as readonly { requirementId: string; verdict: string }[]).map((judgment) => [judgment.requirementId, judgment.verdict]),
    );
    expect(boundary?.carryOver.entries.map((entry) => entry.requirementId)).toEqual([X, Y]);
    expect(JSON.stringify(boundary).includes("E1.F99")).toBe(false);
    // 納品物（診断を除く）に 2 回目の部分の印（E1.F99）が無い
    const files = result.bundle === null ? [] : bundleFiles(result.bundle);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.text.includes("E1.F99"))).toBe(false);
  });
});

// ── ⑥ 直すの段の effort の口（`repair`。Issue #751）────────────────────────────────
//
// 実行口（`runGenerationV11a`）から**実 adapter**（`createOpenAiLlmClient`）に偽物の `fetch` を当て、送った body の
// `reasoning.effort` を見る。段の関数を直接呼ばず、段の口も試験側で渡さない——`runGenerationV11a` が組む口を通す。
// 修復は 3 つの入口（探索 off の全文の直し・探索 on の欄だけの直し・探索 on の全文の直し）を実際に呼ぶ。

/** 送った 1 本の body（どの要求から出たか） */
interface WireSent {
  readonly kind: "structured" | "tools";
  readonly schemaName: string | undefined;
  readonly body: Record<string, unknown>;
}

/** 完了した応答（本文を載せる） */
function wireCompleted(output: readonly unknown[]): Response {
  return new Response(JSON.stringify({ id: "resp-wire", status: "completed", output }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 記録した応答を順に返す偽物の `fetch` を当てた、実 adapter の client（外部の API は呼ばない）。
 * 構造化の応答は、adapter が選ぶ封筒と同じ枝（`resolveStageEnvelope`）で包む。`failToolOnce` は最初の道具付きの
 * 要求を 1 度だけ HTTP の 5xx で失敗させ、共通の口の通信の再送を通す（記録は消費しない）。
 */
function wireClientOf(calls: readonly RecordedCall[], envelope: EnvelopeId, options: { readonly failToolOnce?: boolean } = {}) {
  const sent: WireSent[] = [];
  let index = 0;
  let toolFailures = options.failToolOnce === true ? 1 : 0;
  let current: { readonly schemaName: string; readonly schema: unknown } | undefined;
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const tools = body["tools"] !== undefined;
    sent.push({ kind: tools ? "tools" : "structured", schemaName: tools ? undefined : current?.schemaName, body });
    if (tools && toolFailures > 0) {
      toolFailures -= 1;
      return new Response(JSON.stringify({ error: { type: "server_error" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    const call = calls[index];
    index += 1;
    if (call === undefined) throw new Error(`記録した応答が尽きました（${String(index)} 件目）`);
    if (tools) {
      if (call.kind !== "tools") throw new Error("記録した応答の種別が違います（道具付き）");
      const output =
        call.response.kind === "toolCalls"
          ? call.response.toolCalls.map((tool) => ({ type: "function_call", call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.arguments ?? null) }))
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(call.response.declaration) }] }];
      return wireCompleted(output);
    }
    if (call.kind !== "structured") throw new Error("記録した応答の種別が違います（構造化）");
    const resolved = current === undefined ? undefined : resolveStageEnvelope(current.schemaName, current.schema, envelope);
    const output =
      resolved === undefined || typeof call.output !== "object" || call.output === null || Array.isArray(call.output)
        ? call.output
        : { result: { stage: resolved.entry.stage, ...(call.output as Record<string, unknown>) } };
    return wireCompleted([{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }]);
  };
  const adapter = createOpenAiLlmClient({ apiKey: "sk-FAKE", effort: "high", envelope, fetch });
  const client: LlmClient = {
    callStructured<T>(request: LlmStructuredRequest) {
      current = { schemaName: request.schemaName, schema: request.schema };
      return adapter.callStructured<T>(request);
    },
    callWithTools(request: LlmToolRequest) {
      current = undefined;
      return adapter.callWithTools(request);
    },
  };
  /** 記録を消費した数（通信の失敗では消費しない。台本の余り・不足を等値で見る） */
  const consumed = (): number => index;
  return { client, sent, consumed };
}

/** 送った body の `reasoning.effort`（無ければ undefined） */
const wireEffortOf = (sent: WireSent): string | undefined =>
  (sent.body["reasoning"] as { readonly effort?: string } | undefined)?.effort;
/** 修復の要求か（道具付きの要求と、欄だけの直しの構造化の要求） */
const isRepairWire = (sent: WireSent): boolean => sent.kind === "tools" || sent.schemaName === FIELD_REPAIR_SCHEMA_NAME;

describe("⑥ 直すの段の effort の口（repair。Issue #751）：実行口から偽物の fetch の body まで", () => {
  const EFFORTS = { repair: "medium" } as const;
  /** 静的チェックに落ちる宣言（R4 の計算の式が違う） */
  const BAD_YAML = replaced(RUN_YAML, "    expression: base * 2", "    expression: base * 3");

  /** 一気通貫の実行口（runGenerationV11a）で流す */
  async function runWire(calls: readonly RecordedCall[], envelope: EnvelopeId, overrides: Partial<GenerationInputV11a> = {}, options: { readonly failToolOnce?: boolean } = {}) {
    const wire = wireClientOf(calls, envelope, options);
    const result = await runGenerationV11a(inputOf(wire.client, overrides));
    return { result, sent: wire.sent, consumed: wire.consumed() };
  }

  /**
   * 修復の走りが**成功して止まらず**、台本を**使い切った**ことを等値で固定する（R1）。修復が起きた回数・
   * 修復の wire の数も >0 ではなく等値で見る。
   */
  function expectWireRunDone(
    run: Awaited<ReturnType<typeof runWire>>,
    calls: readonly RecordedCall[],
    expected: { readonly repairStages: number; readonly tools: number; readonly fields: number },
  ): void {
    expect(run.result.stopped).toBeNull();
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(run.consumed, "台本を使い切った").toBe(calls.length);
    expect(run.result.record.stages.filter((stage) => stage.stage === "repair")).toHaveLength(expected.repairStages);
    expect(run.sent.filter((sent) => sent.kind === "tools")).toHaveLength(expected.tools);
    expect(run.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME)).toHaveLength(expected.fields);
  }

  it("(1)(3) 探索 off の全文の直し（ids off）：道具の往復の全部のターン（道具の呼び出し → 結果 → 最後の応答）と、形の再要求・通信の再送の wire の reasoning.effort が medium。ほかの段の body は口なしの走りと同じ", async () => {
    const calls = [
      ...head({ yaml: BAD_YAML }),
      structured(acceptAll()),
      repairToolCall("call-1", "static-check", RUN_YAML),
      repairDone(""),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ];
    const plain = await runWire(calls, "v1.1a", { deadline: 600_000 });
    const tuned = await runWire(calls, "v1.1a", { stageEfforts: EFFORTS, deadline: 600_000 }, { failToolOnce: true });
    // 修復 1 回・道具の wire 4 本（道具の呼び出し・HTTP の誤りで始めなかった応答の再送・形の再要求・最後の応答）・台本を使い切る
    expectWireRunDone(tuned, calls, { repairStages: 1, tools: 4, fields: 0 });
    expect(plain.result.stopped).toBeNull();
    expect(plain.result.outcome).toEqual(tuned.result.outcome);
    // 全文の直し（道具付き）が実際に呼ばれ、通信の再送と形の再要求の数が記録に残る
    const repairStageRecord = tuned.result.record.stages.find((stage) => stage.stage === "repair");
    expect(repairStageRecord?.retries.shape).toBe(1);
    expect(repairStageRecord?.retries.communication).toBe(1);
    const tools = tuned.sent.filter((sent) => sent.kind === "tools");
    for (const sent of tools) {
      expect(wireEffortOf(sent), "道具付きの往復の全部のターン").toBe("medium");
      expect(sent.body["max_output_tokens"]).toBe(maxOutputTokensForEffort("medium", "repair"));
    }
    // 通信の再送は同じ body を送り直す（effort も同じ）
    expect(JSON.stringify(tools[0]?.body)).toBe(JSON.stringify(tools[1]?.body));
    // ほかの段（B1・B3'・B4 の判断など）の body は、repair を指定しない走りと同じ
    const others = (s: readonly WireSent[]) => s.filter((sent) => !isRepairWire(sent)).map((sent) => JSON.stringify(sent.body));
    expect(others(tuned.sent)).toEqual(others(plain.sent));
    // 口なしの走りの修復の要求は adapter の設定の effort（high）のまま
    for (const sent of plain.sent.filter((candidate) => candidate.kind === "tools")) expect(wireEffortOf(sent)).toBe("high");
  });

  it("(2)(3) 探索 on の欄だけの直し（ids off）：構造化の要求の wire の reasoning.effort が medium。道具付きの直す段は呼ばない", async () => {
    const calls = [
      ...head({ yaml: W2 }),
      structured(acceptAll()),
      fieldRepair("amount > 1"),
      structured(acceptAll()),
      fieldRepair("amount > 0"),
      structured(acceptAll()),
    ];
    const plain = await runWire(calls, "v1.1a", { flags: { searchRepair: true } });
    const tuned = await runWire(calls, "v1.1a", { flags: { searchRepair: true }, stageEfforts: EFFORTS });
    expectWireRunDone(tuned, calls, { repairStages: 2, tools: 0, fields: 2 });
    expect(plain.result.stopped).toBeNull();
    expect(tuned.result.outcome).toEqual(plain.result.outcome);
    expect(tuned.sent.filter((sent) => sent.kind === "tools")).toEqual([]);
    const fields = tuned.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fields.length).toBe(2);
    for (const sent of fields) {
      expect(wireEffortOf(sent)).toBe("medium");
      expect(sent.body["max_output_tokens"]).toBe(maxOutputTokensForEffort("medium", "repair"));
      // adapter の body の形（封筒の外の段なので、要求の schema をそのまま送る）
      expect((sent.body["text"] as { readonly format: { readonly name: string } }).format.name).toBe(FIELD_REPAIR_SCHEMA_NAME);
    }
    const others = (s: readonly WireSent[]) => s.filter((sent) => !isRepairWire(sent)).map((sent) => JSON.stringify(sent.body));
    expect(others(tuned.sent)).toEqual(others(plain.sent));
    for (const sent of plain.sent.filter((candidate) => candidate.schemaName === FIELD_REPAIR_SCHEMA_NAME)) expect(wireEffortOf(sent)).toBe("high");
  });

  it("(3) 探索 on の全文の直し（ids off）：場所なしの失敗がある往復は道具付きの直す段になり、その wire は全部 medium", async () => {
    const calls = [...head({ yaml: W1, table: TABLE_R4_ENTITY }), structured(judgments(IDS, REJECT_R4)), repairDone(RUN_YAML), structured(acceptAll())];
    const tuned = await runWire(calls, "v1.1a", { flags: { searchRepair: true }, stageEfforts: EFFORTS });
    expectWireRunDone(tuned, calls, { repairStages: 1, tools: 1, fields: 0 });
    for (const sent of tuned.sent.filter((candidate) => candidate.kind === "tools")) expect(wireEffortOf(sent)).toBe("medium");
    expect(tuned.sent.some((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME)).toBe(false);
  });

  it("(3) ids on：探索 off の全文の直しと、探索 on の欄だけの直しの wire も medium", async () => {
    // 探索 off（全文の直し。道具付き）
    const fullCalls = [...idsHead({ yaml: BAD_YAML }), structured(acceptAll()), repairDone(RUN_YAML), structured(acceptAll())];
    const full = await runWire(fullCalls, "v1.2-ids", { flags: { ledger: true, ids: true }, stageEfforts: EFFORTS });
    expectWireRunDone(full, fullCalls, { repairStages: 1, tools: 1, fields: 0 });
    for (const sent of full.sent.filter((candidate) => candidate.kind === "tools")) expect(wireEffortOf(sent)).toBe("medium");
    // 探索 on（欄だけの直し。構造化）
    const fieldCalls = [
      ...idsHead({ yaml: W2 }),
      structured(acceptAll()),
      fieldRepair("amount > 1"),
      structured(acceptAll()),
      fieldRepair("amount > 0"),
      structured(acceptAll()),
    ];
    const field = await runWire(fieldCalls, "v1.2-ids", { flags: { ledger: true, ids: true, searchRepair: true }, stageEfforts: EFFORTS });
    expectWireRunDone(field, fieldCalls, { repairStages: 2, tools: 0, fields: 2 });
    for (const sent of field.sent.filter((candidate) => candidate.schemaName === FIELD_REPAIR_SCHEMA_NAME)) expect(wireEffortOf(sent)).toBe("medium");
  });

  it("(3) 探索 on の全文の直し（ids on）：場所なしの失敗がある往復は道具付きの直す段になり、その wire は全部 medium", async () => {
    // 検査の節を読めない形（validations: [amount]）にすると静的チェックに落ち、場所を作らずに全文の直し（道具付き）へ流れる
    const NOVAL = replaced(RUN_YAML, "validations:\n  - name: amount\n    entity: item\n    expression: amount > 0\n", "validations: []\n");
    const FLOW = replaced(NOVAL, "validations: []\n", "validations: [amount]\n");
    // 初版は静的チェックに落ちるので B3'（宣言の意味の点検）を呼ばない。余分な B3' の応答を置かない
    const calls = [...idsHead({ yaml: FLOW }), repairDone(RUN_YAML), structured(acceptAll())];
    const tuned = await runWire(calls, "v1.2-ids", { flags: { ledger: true, ids: true, searchRepair: true }, stageEfforts: EFFORTS });
    expectWireRunDone(tuned, calls, { repairStages: 1, tools: 1, fields: 0 });
    for (const sent of tuned.sent.filter((candidate) => candidate.kind === "tools")) {
      expect(wireEffortOf(sent)).toBe("medium");
      expect(sent.body["max_output_tokens"]).toBe(maxOutputTokensForEffort("medium", "repair"));
    }
    expect(tuned.sent.some((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME)).toBe(false);
  });

  it("(1) 段の走りの実行口（runStageRangeV11a）でも、全文の直しの道具付きの往復の全部のターンの wire は medium", async () => {
    const calls = [...head({ yaml: BAD_YAML }), structured(acceptAll()), repairDone(RUN_YAML), structured(acceptAll())];
    const wire = wireClientOf(calls, "v1.1a");
    const outcome = await runStageRangeV11a({ ...inputOf(wire.client, { stageEfforts: EFFORTS }), range: { start: "name-table", end: "judge" } });
    expect(outcome.stopped).toBeNull();
    expect(wire.consumed(), "台本を使い切った").toBe(calls.length);
    expect(outcome.stages.filter((stage) => stage.stage === "repair")).toHaveLength(1);
    expect(wire.sent.filter((sent) => sent.kind === "tools")).toHaveLength(1);
    for (const sent of wire.sent.filter((candidate) => candidate.kind === "tools")) expect(wireEffortOf(sent)).toBe("medium");
  });

  it("(4) ほかの段の effort は変わらない：repair を指定しても B1 の作り直しは write の指定に従い、B3' は adapter の設定のまま", async () => {
    // 検査の名前だけ別の初版 → 欄だけの直しが 2 回空振りして停滞 → B1 の作り直し（declare 全文）→ 通る
    const RENAMED = replaced(RUN_YAML, "  - name: amount\n    entity: item", "  - name: positive\n    entity: item");
    const calls = [
      ...idsHead({ yaml: RENAMED }),
      structured(acceptAll()),
      structured({ replacements: [], disputes: [] }),
      structured(acceptAll()),
      structured({ replacements: [], disputes: [] }),
      structured(acceptAll()),
      structured({ declaration: RUN_YAML }),
      structured(acceptAll()),
    ];
    const tuned = await runWire(calls, "v1.2-ids", {
      flags: { ledger: true, ids: true, searchRepair: true },
      stageEfforts: { repair: "medium", write: "low" },
    });
    // 台本の余り・不足が無いこと（修復は欄だけの直しの空振り 2 回）
    expect(tuned.result.stopped).toBeNull();
    expect(tuned.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(tuned.consumed, "台本を使い切った").toBe(calls.length);
    expect(tuned.result.record.stages.filter((stage) => stage.stage === "repair")).toHaveLength(2);
    const writes = tuned.sent.filter((sent) => sent.schemaName === WRITE_V11A_SCHEMA_NAME);
    expect(writes).toHaveLength(2);
    expect(wireEffortOf(writes[0] as WireSent)).toBe("low");
    expect(wireEffortOf(writes[1] as WireSent), "B1 の作り直しは write の指定").toBe("low");
    const repairs = tuned.sent.filter((sent) => isRepairWire(sent));
    expect(repairs.length).toBeGreaterThan(0);
    for (const sent of repairs) expect(wireEffortOf(sent)).toBe("medium");
    // B3'（decl-check）は段の指定が無いので adapter の設定（high）のまま
    const declChecks = tuned.sent.filter((sent) => sent.schemaName === DECL_CHECK_SCHEMA_NAME);
    expect(declChecks.length).toBeGreaterThan(0);
    for (const sent of declChecks) expect(wireEffortOf(sent)).toBe("high");
  });

  /** 道具付きの応答（1 つの束に `count` 個の static-check）。識別子は束の中で一意にする */
  function repairToolBundle(round: number, count: number): RecordedCall {
    return {
      kind: "tools",
      response: {
        kind: "toolCalls",
        toolCalls: Array.from({ length: count }, (_, index) => ({
          id: `b${String(round)}-${String(index)}`,
          name: "static-check",
          arguments: { declaration: RUN_YAML },
        })),
        usage: undefined,
      },
    };
  }

  it("(6) 道具の呼び出しの累計が 24 を越える（24→25）：段の口を通した走りは toolCalls の上限で止まり、口なしの走りと同じ判定。台本を使い切る", async () => {
    // 束 4 個 × 6 回で累計 24、次の束 1 個で 25 になり、実行する前に断る（ids on は停止に上限の名前と数を残す）
    const calls = [
      ...idsHead({ yaml: BAD_YAML }),
      structured(acceptAll()),
      ...Array.from({ length: 6 }, (_, index) => repairToolBundle(index, 4)),
      repairToolBundle(6, 1),
    ];
    const flags = { ledger: true, ids: true } as const;
    const plain = await runWire(calls, "v1.2-ids", { flags });
    const tuned = await runWire(calls, "v1.2-ids", { flags, stageEfforts: EFFORTS });
    const limit = { name: "toolCalls", max: AGENT_LIMITS.toolCalls, actual: AGENT_LIMITS.toolCalls + 1 };
    expect(tuned.result.stopped).toEqual({ stage: "repair", kind: "call-limit", limit });
    expect(tuned.result.record.failure).toEqual({ stage: "repair", kind: "call-limit", limit });
    expect(tuned.result.outcome).toEqual({ result: "failed", verdict: "none" });
    expect(tuned.consumed, "台本を使い切った").toBe(calls.length);
    // 口なしの走り（元の口だけ）と同じ判定
    expect(plain.result.stopped).toEqual(tuned.result.stopped);
    expect(plain.result.record.failure).toEqual(tuned.result.record.failure);
    expect(plain.result.outcome).toEqual(tuned.result.outcome);
    expect(plain.result.summary).toEqual(tuned.result.summary);
  });

  it("(6) 1 回の修復の応答が 8 を越える（8→9）：段の口を通した走りは repairStepTurns の上限で止まり、口なしの走りと同じ判定。台本を使い切る", async () => {
    const calls = [
      ...idsHead({ yaml: BAD_YAML }),
      structured(acceptAll()),
      ...Array.from({ length: AGENT_LIMITS.repairStepTurns }, (_, index) => repairToolBundle(index, 1)),
    ];
    const flags = { ledger: true, ids: true } as const;
    const plain = await runWire(calls, "v1.2-ids", { flags });
    const tuned = await runWire(calls, "v1.2-ids", { flags, stageEfforts: EFFORTS });
    const limit = { name: "repairStepTurns", max: AGENT_LIMITS.repairStepTurns, actual: AGENT_LIMITS.repairStepTurns + 1 };
    expect(tuned.result.stopped).toEqual({ stage: "repair", kind: "call-limit", limit });
    expect(tuned.result.record.failure).toEqual({ stage: "repair", kind: "call-limit", limit });
    expect(tuned.result.outcome).toEqual({ result: "failed", verdict: "none" });
    expect(tuned.consumed, "台本を使い切った").toBe(calls.length);
    // 口なしの走り（元の口だけ）と同じ判定
    expect(plain.result.stopped).toEqual(tuned.result.stopped);
    expect(plain.result.record.failure).toEqual(tuned.result.record.failure);
    expect(plain.result.outcome).toEqual(tuned.result.outcome);
    expect(plain.result.summary).toEqual(tuned.result.summary);
  });
});

// ── 修復へ渡す診断（旗 v12.ids と search-repair がともに on。Issue #761・#764）──────────────────────
//
// 実行口（`runGenerationV11a`・`runStageRangeV11a`）から実 adapter に偽物の fetch を当て、修復の要求の body を見る。
// Issue #764 の後、診断の塊は**欄だけの直しにだけ**渡す（一番良い版から往復ごとに作り直す）。探索 on の全文の直しは
// #761 の前（f9bf3b3）と同じ body に戻す（偽物の fetch が実際に受けた body の SHA を試験に固定する）。

describe("修復へ渡す診断（旗 v12.ids と search-repair がともに on。Issue #761）：実行口から偽物の fetch の body まで", () => {
  const FLAGS = { ledger: true, ids: true, searchRepair: true } as const;
  /** 宣言の中の率の計算の本文（R4） */
  const rateBody = (expression: string): string => ["- name: rate", "  scope: app", `  expression: ${expression}`, "  type: number"].join("\n");
  /** 率の計算だけを直す欄だけの直しの応答 */
  const rateRepair = (expression: string, disputes: readonly { testId: string; quote: string }[] = []): RecordedCall =>
    fieldRepairWith([{ location: "computation:rate", element: rateBody(expression) }], disputes);
  const fieldRepairWith = (
    replacements: readonly { readonly location: string; readonly element: string }[],
    disputes: readonly { testId: string; quote: string }[] = [],
  ): RecordedCall => structured({ replacements, disputes });
  /** 率の式が違う宣言（R4 の 3 本が不一致） */
  const R4_BAD = replaced(RUN_YAML, "    expression: base * 2", "    expression: base * 3");
  /** 率の式と操作の条件の両方が違う宣言（R4 の 3 本と R3 の境界の 1 本が不一致） */
  const BOTH_BAD = replaced(R4_BAD, "when: amount > 0", "when: amount > 1");
  /** closeItem の操作を宣言から外した版（場所なしの失敗だけになり、全文の直しへ流れる） */
  const NO_CLOSE = replaced(
    RUN_YAML,
    "  - name: closeItem\n    entity: item\n    kind: update\n    set:\n      kind: beta\n    when: amount > 0\n",
    "",
  );
  /** 旗 ids の走りの場合の ID（応答の順。R1 の 3・R3 の 3・R4 の 3） */
  const CASE = (index: number): string => `case:${String(index + 1)}`;
  /** R3 の境界（応答の 6 番目） */
  const R3_BOUNDARY = CASE(5);
  /** R4 の 3 本（応答の 7〜9 番目） */
  const R4_CASES = [6, 7, 8].map(CASE);

  // ── R4: 候補を採る → まだ失敗が残る → 次の修復の要求（details が変わる）────────────────────────
  /** 金額の検査の本文を直す欄だけの直しの置き換え */
  const amountValidation = (expression: string): { readonly location: string; readonly element: string } => ({
    location: "validation:item.amount",
    element: ["- name: amount", "  entity: item", `  expression: ${expression}`].join("\n"),
  });
  /** 率 base*3・検査 amount<0（不一致 6） */
  const R4_FIELD_BAD = replaced(
    replaced(RUN_YAML, "    expression: base * 2", "    expression: base * 3"),
    "    expression: amount > 0",
    "    expression: amount < 0",
  );
  /** 率 base*4・検査 amount>0（rate の 3 本だけが残る。details は実際 9 → 12 に変わる） */
  const R4_FIELD_CANDIDATE = replaced(RUN_YAML, "    expression: base * 2", "    expression: base * 4");

  // ── R3: 同じ操作（validate）で observes が違う 2 つの試験（validation と default-value）────────────────
  const G_LIST_BASE: RequirementList = {
    ...BASE_LIST,
    requirements: [
      ...BASE_LIST.requirements,
      { id: "R6", text: DEFAULT_VALUE_REQUIREMENT_TEXT, quote: DEFAULT_VALUE_REQUIREMENT_TEXT, position: { start: 0, end: DEFAULT_VALUE_REQUIREMENT_TEXT.length } },
    ],
  };
  const G_PLAN = planOf(G_LIST_BASE);
  const G_LIST = requirementsFromPlan(G_PLAN);
  const G_SOURCE = G_LIST_BASE.requirements.map((requirement) => requirement.text).join("");
  const G_IDS = [...IDS, "R6"] as const;
  /** R5・R7 を持たない表（C2・C3 が 1 束に収まる 5 要件の走り） */
  const G_TABLE_ON: NameTable = (() => {
    const table = fixtureGeneratedTable();
    const keep = (entry: { readonly requirementId: string }): boolean => entry.requirementId !== "R5" && entry.requirementId !== "R7";
    return { rows: table.rows, ownership: table.ownership.filter(keep), verification: table.verification.filter(keep), classification: table.classification.filter(keep) };
  })();
  const G_RENAME = codeIdRenameOf(G_TABLE_ON);
  const G_MAPPED: NameTable = withCheckTargets(withCodeIds(G_TABLE_ON));
  /** 区分の項目に default（alpha）を足した宣言 */
  const G_YAML = replaced(RUN_YAML, "          beta: ベータ\n", "          beta: ベータ\n        default: alpha\n");
  /** 検査 kind を足した宣言（既定値の試験の場所を validation:item.kind に写す） */
  const KIND_VALIDATION = `  - name: kind\n    entity: item\n    expression: kind == "alpha"\n`;
  /** 既定値が beta（不一致）・金額の検査が amount < 0（不一致）の宣言 */
  const R3_BAD_YAML = replaced(
    replaced(G_YAML, "        default: alpha\n", "        default: beta\n"),
    "    expression: amount > 0\n",
    `    expression: amount < 0\n${KIND_VALIDATION}`,
  );
  /** 直した宣言（既定値 alpha・金額の検査 amount > 0・検査 kind は残す） */
  const R3_GOOD_YAML = replaced(G_YAML, "    expression: amount > 0\n", `    expression: amount > 0\n${KIND_VALIDATION}`);
  const gHead = (yaml: string): RecordedCall[] => [
    ...idsResponseList(idsResponsesOf(G_LIST, G_MAPPED, PROPERTY_LEDGER_VIEW)).map((output) => structured(output)),
    structured(acceptAll(G_IDS)),
    structured(renameIds(idsT2Response(), G_RENAME)),
    structured({ declaration: yaml }),
  ];
  /** R3 の走り（欄だけの直し・全文の直しのそれぞれについて、一気通貫と段の走りの実行口で流す） */
  const runR3 = async (hand: "field" | "full", execution: "generation" | "stage"): Promise<readonly WireSent[]> => {
    const calls: RecordedCall[] =
      hand === "field"
        ? [...gHead(R3_BAD_YAML), structured(acceptAll(G_IDS))]
        : [...gHead(R3_BAD_YAML), structured(judgments(G_IDS, REJECT_R3)), repairDone(R3_GOOD_YAML)];
    const wire = wireClientOf(calls, "v1.2-ids");
    const input = inputOf(wire.client, { flags: FLAGS, plan: G_PLAN, source: G_SOURCE });
    if (execution === "generation") await runGenerationV11a(input);
    else await runStageRangeV11a({ ...input, range: { start: "name-table", end: "judge" } });
    return wire.sent;
  };
  /** R3 の欄だけの直しの診断の (試験 ID, observes) の並び（検査の試験と既定値の試験がともにあること） */
  const r3ObservesOf = (sent: readonly WireSent[]): readonly (readonly [string, string | null])[] => {
    const request = sent.find((candidate) => candidate.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    if (request === undefined) throw new Error("前提が壊れた：欄だけの直しの要求が無い");
    const diagnostic = diagnosticOf(request);
    const pairs = diagnostic.tests.map((entry) => [entry.testId, entry.observes] as const);
    const validationIds = pairs.filter(([, observes]) => observes === "validation").map(([testId]) => testId);
    const defaultIds = pairs.filter(([, observes]) => observes === "default-value").map(([testId]) => testId);
    expect(validationIds.length).toBeGreaterThan(0);
    expect(validationIds.every((testId) => testId.startsWith("case:"))).toBe(true);
    expect(defaultIds).toHaveLength(1);
    expect(defaultIds[0]?.startsWith(GENERATED_TEST_ID_PREFIX)).toBe(true);
    return pairs;
  };

  /** 送った body の入力（`input` の `input_text` を順につなぐ） */
  const wireInputOf = (sent: WireSent): string => {
    const messages = sent.body["input"] as readonly { readonly content?: readonly { readonly type: string; readonly text?: string }[] }[] | undefined;
    return (messages ?? [])
      .flatMap((message) => message.content ?? [])
      .filter((part) => part.type === "input_text")
      .map((part) => part.text ?? "")
      .join("\n");
  };
  /** 診断の塊の中身（body の入力から） */
  const diagnosticOf = (sent: WireSent): { readonly tests: readonly { readonly testId: string; readonly observes: string | null; readonly table: Record<string, unknown> | null; readonly details: readonly string[] }[] } =>
    dataBlockOf(wireInputOf(sent), repairStage.REPAIR_DIAGNOSTIC_DATA_NAME) as {
      readonly tests: readonly { readonly testId: string; readonly observes: string | null; readonly table: Record<string, unknown> | null; readonly details: readonly string[] }[];
    };
  const hasDiagnostic = (sent: WireSent): boolean => wireInputOf(sent).includes(`<data name="${FIELD_REPAIR_DIAGNOSTIC_DATA_NAME}">`);
  /** 全文の直し（直す段）の診断の塊が届いたか（Issue #764 の後は届かない） */
  const hasFullDiagnostic = (sent: WireSent): boolean => wireInputOf(sent).includes(`<data name="${repairStage.REPAIR_DIAGNOSTIC_DATA_NAME}">`);
  /** 既存の C7 の塊（試験の結果）の中身 */
  const testRunOf = (sent: WireSent): {
    readonly mismatches: readonly { readonly testId: string; readonly detail: string }[];
    readonly unresolved: readonly { readonly testId: string; readonly detail: string }[];
  } =>
    dataBlockOf(wireInputOf(sent), "試験の結果") as {
      readonly mismatches: readonly { readonly testId: string; readonly detail: string }[];
      readonly unresolved: readonly { readonly testId: string; readonly detail: string }[];
    };
  /** 送った body（偽物の fetch が実際に受けた body）の SHA-256 */
  const bodyShas = async (sent: readonly WireSent[]): Promise<readonly string[]> =>
    Promise.all(sent.map(async (candidate) => await sha256Hex(JSON.stringify(candidate.body))));

  /** 欄だけの直しの 2 往復（W2 → W1 → 正しい版）で修復が 2 回・採否は 2 → 1 → 0 */
  const FIELD_CALLS = (): RecordedCall[] => [
    ...idsHead({ yaml: W2 }),
    structured(acceptAll()),
    fieldRepair("amount > 1"),
    structured(acceptAll()),
    fieldRepair("amount > 0"),
    structured(acceptAll()),
  ];
  const runFieldWire = async (options: { readonly stageEfforts?: Partial<Record<"repair", "medium">> } = {}) => {
    const calls = FIELD_CALLS();
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS, ...(options.stageEfforts === undefined ? {} : { stageEfforts: options.stageEfforts }) }));
    return { result, sent: wire.sent, consumed: wire.consumed(), calls };
  };

  it("(1)(6) 欄だけの直し：body に観測する性質と表の行（実名）が届き、往復ごとに一番良い版の失敗（2 → 1）になる。repair=medium も載る", async () => {
    const run = await runFieldWire({ stageEfforts: { repair: "medium" } });
    expect(run.result.stopped).toBeNull();
    expect(run.result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(run.consumed, "台本を使い切った").toBe(run.calls.length);
    const fields = run.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fields).toHaveLength(2);
    const diagnostics = fields.map((sent) => diagnosticOf(sent));
    expect(diagnostics.map((entry) => entry.tests.length)).toEqual([2, 1]);
    for (const diagnostic of diagnostics) {
      for (const entry of diagnostic.tests) {
        // 同じ操作の試験でも、その試験の観測する性質がそのまま届く
        expect(entry.observes).toBe("when");
        // 表の行は B1 と同じ欄で、所属の ID は実名（e.item を出さない）
        expect(entry.table).toMatchObject({ kind: "operation", entity: "item", name: "closeItem" });
      }
      expect(JSON.stringify(diagnostic)).not.toContain('"e.item"');
    }
    for (const sent of fields) expect(wireEffortOf(sent)).toBe("medium");
    // 修復の回数と採否の並びは直す前と同じ（2 往復・2 → 1 → 0）。完了条件 (7) はこのほか、cli.test の取り除きの照合が
    // 記録・要求の列・要求の数・終了コードを同じ指紋で旧値（f9bf3b3）と照らして覆う
    expect(run.result.record.stages.filter((stage) => stage.stage === "repair")).toHaveLength(2);
    expect(totalsOf(run.result.bundle)).toEqual([
      ["write", 2, true],
      ["repair", 1, true],
      ["repair", 0, true],
    ]);
    expect(run.sent.filter((sent) => sent.kind === "tools")).toEqual([]);
  });

  it("(1) 全文の直し（場所なしの失敗がある往復）：診断の塊は届かず、既存の C7 の塊（試験の結果）に一番良い版の落ちが届く。探索 off の全文の直しも同じ", async () => {
    const calls = [...idsHead({ yaml: NO_CLOSE }), repairDone(RUN_YAML), structured(acceptAll())];
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(wire.consumed()).toBe(calls.length);
    const tools = wire.sent.filter((sent) => sent.kind === "tools");
    expect(tools).toHaveLength(1);
    const sent = tools[0];
    if (sent === undefined) throw new Error("前提が壊れた：全文の直しの要求が無い");
    // Issue #764：製品の実行口（一気通貫）は、全文の直しへ診断の塊を渡さない
    expect(hasFullDiagnostic(sent)).toBe(false);
    // 既存の C7 の塊（試験の結果）はそのまま届く（診断を外しても落ちの材料は減らない）
    const testRun = testRunOf(sent);
    expect([...testRun.mismatches, ...testRun.unresolved]).toHaveLength(3);
    // 修復の規則（共通の REPAIR_RULES）は変えない（診断はデータだけだった）
    expect(sent.body).not.toHaveProperty("rules");
    expect(JSON.stringify(sent.body)).not.toContain("診断は");
    // 修復の 1 回・採否は 4 → 0（往復の数と採否は直す前と同じ）
    expect(result.record.stages.filter((stage) => stage.stage === "repair")).toHaveLength(1);
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 4, true],
      ["repair", 0, true],
    ]);

    // 探索 off（ids on の全文の直し）も、診断の塊は届かない
    const offCalls = [...idsHead({ yaml: NO_CLOSE }), repairDone(RUN_YAML), structured(acceptAll())];
    const offWire = wireClientOf(offCalls, "v1.2-ids");
    await runGenerationV11a(inputOf(offWire.client, { flags: { ledger: true, ids: true, searchRepair: false } }));
    const offTools = offWire.sent.filter((candidate) => candidate.kind === "tools");
    expect(offTools).toHaveLength(1);
    for (const candidate of offTools) expect(hasFullDiagnostic(candidate)).toBe(false);
  });

  /** 全文の直しに入り、道具の呼び出しと継続（結果を受けた最後の応答）を含む台本 */
  const FULL_REPAIR_CALLS = (): RecordedCall[] => [
    ...idsHead({ yaml: NO_CLOSE }),
    repairToolCall("call-1", "static-check", RUN_YAML),
    repairDone(RUN_YAML),
    structured(acceptAll()),
  ];
  /** 全文の直しの台本を、一気通貫の実行口で流す */
  const runFullGeneration = async () => {
    const calls = FULL_REPAIR_CALLS();
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
    return { result, sent: wire.sent, consumed: wire.consumed(), total: calls.length };
  };
  /** 全文の直しの台本を、段の走りの実行口で流す */
  const runFullStage = async () => {
    const calls = FULL_REPAIR_CALLS();
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runStageRangeV11a({
      ...inputOf(wire.client, { flags: FLAGS }),
      range: { start: "name-table", end: "judge" },
    });
    return { result, sent: wire.sent, consumed: wire.consumed(), total: calls.length };
  };
  /**
   * #761 の前（f9bf3b3）の、ids on・探索 on の全文の直しの要求の body の SHA-256（**期待**。偽物の fetch が実際に受けた body。
   * 道具の呼び出しの要求と、その結果を受けた継続の要求の 2 本）。
   *
   * 取り方：`git worktree add --detach <リポジトリの外の一時ディレクトリ> f9bf3b3` で作った一時の worktree に、`FULL_REPAIR_CALLS`
   * と同じ台本（同じ入力・同じ最良版・同じ道具の累計・同じ応答・同じ adapter の設定＝実行口から実 adapter と偽物の fetch まで）を
   * 流す一時の試験を足し、`sha256(JSON.stringify(sent.body))` を記録した（一気通貫と段の走りの両方で同じ値）。測った後に一時の
   * 試験を戻し、補助（node_modules などの link）を消してから `git worktree remove` で消した。**旧値（bb769d6・直す前）**は
   * `BB769D6_FULL_BODY_SHA`——診断の塊があるので一致しない（直す前の挙動）。
   */
  const F9BF3B3_FULL_BODY_SHA = [
    "9fbb8ee3925cc507086726de650528f4ad2a9e2808267eecb77191c835a8e5f4",
    "c68bff9ef2c2eb360703eeadcb2673bb7effeb794e1e603059905b59f653473e",
  ] as const;
  /** 直す前（bb769d6）の同じ台本の全文の直しの body の SHA-256（旧値。診断の塊の分だけ違う） */
  const BB769D6_FULL_BODY_SHA = [
    "845b580f61527578843e076eb0434355c5668ca5a5eac9a788bdb94f917c6ca0",
    "6c954f429dd0d8fa544b1fae264fa406b7cac29ddfcf8d59f8fcead50a46faa2",
  ] as const;

  it("(1) 全文の直しの要求（道具の継続を含む）の body が #761 の前（f9bf3b3）とバイト列で同じで、診断の塊が無い（一気通貫と段の走りの両方）", async () => {
    const generation = await runFullGeneration();
    const stage = await runFullStage();
    for (const run of [generation, stage]) {
      expect(run.result.stopped).toBeNull();
      expect(run.consumed, "台本を使い切った").toBe(run.total);
      const tools = run.sent.filter((sent) => sent.kind === "tools");
      expect(tools).toHaveLength(2);
      for (const sent of tools) expect(hasFullDiagnostic(sent)).toBe(false);
      expect(await bodyShas(tools)).toEqual([...F9BF3B3_FULL_BODY_SHA]);
    }
    // 直す段はどちらの実行口も 1 回（一気通貫は record、段の走りは stages）
    expect(generation.result.record.stages.filter((record) => record.stage === "repair")).toHaveLength(1);
    expect(stage.result.stages.filter((record) => record.stage === "repair")).toHaveLength(1);
    // 往復の数と採否の並びは bb769d6 と同じ（同じ台本で 4 → 0・修復 1 回）
    expect(totalsOf(generation.result.bundle)).toEqual([
      ["write", 4, true],
      ["repair", 0, true],
    ]);
    expect(roundsOf(generation.result.bundle).map((round) => round.hand)).toEqual(["repair"]);
    // 直す前（bb769d6）は診断の塊があり、同じ body ではなかった（今の body から取り除いて比べない。上の実測の旧値）
    expect(BB769D6_FULL_BODY_SHA).not.toEqual(F9BF3B3_FULL_BODY_SHA);
  });

  /**
   * 直す前（bb769d6）の、ids on・探索 on の欄だけの直しの要求の body の SHA-256（**期待**。偽物の fetch が実際に受けた body）。
   * 取り方：`git worktree add --detach <リポジトリの外の一時ディレクトリ> bb769d6` で作った一時の worktree に、下の台本と同じ走り
   * （`idsHead({ yaml: W2 })` から欄だけの直し 2 回。同じ入力・同じ一番良い版・同じ応答・同じ adapter の設定）を流す一時の試験を
   * 足して測った。測った後に一時の試験を戻し、補助を消してから `git worktree remove` で消した。診断の塊を含む body なので、
   * #764 の後も欄だけの直しの要求はこの値のまま（完了条件 (2)）。
   */
  const BB769D6_FIELD_BODY_SHA = [
    "9984b5c0d3bf27316bfdfee8a8fe95d8e7a447547c9d2637624fffea21038389",
    "fbe186d1e2de9e615527bcd9f114b0a3f990dd600a49bd7026051fb7fbfff97c",
  ] as const;

  it("(2) 欄だけの直しの要求の body は bb769d6 と同じ（診断の塊があり、往復の数と採否も同じ）", async () => {
    const calls = [
      ...idsHead({ yaml: W2 }),
      structured(acceptAll()),
      fieldRepair("amount > 1"),
      structured(acceptAll()),
      fieldRepair("amount > 0"),
      structured(acceptAll()),
    ];
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(wire.consumed(), "台本を使い切った").toBe(calls.length);
    const fields = wire.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fields).toHaveLength(2);
    for (const sent of fields) expect(hasDiagnostic(sent)).toBe(true);
    expect(await bodyShas(fields)).toEqual([...BB769D6_FIELD_BODY_SHA]);
    // 往復の数と採否の並びも直す前（bb769d6）と同じ（2 往復・2 → 1 → 0）
    expect(result.record.stages.filter((stage) => stage.stage === "repair")).toHaveLength(2);
    expect(totalsOf(result.bundle)).toEqual([
      ["write", 2, true],
      ["repair", 1, true],
      ["repair", 0, true],
    ]);
  });

  /** closeItem を外し、率の式も違う版（場所なしの失敗と R4 の 3 本が残る。全文→欄だけの切り替え用） */
  const NO_CLOSE_R4 = replaced(NO_CLOSE, "    expression: base * 2", "    expression: base * 3");
  /**
   * 全文の直しで場所なしの失敗（closeItem の欠け）を直した候補（R4_BAD。率の式はまだ違う）を採ったあと、
   * **同じ走りの中で**残った R4 の 3 本（すべて場所に写せる）を欄だけの直しで直す台本（完了条件 (2)）。
   */
  const HANDOFF_CALLS = (): RecordedCall[] => [
    ...idsHead({ yaml: NO_CLOSE_R4 }),
    repairDone(R4_BAD),
    structured(acceptAll()),
    rateRepair("base * 2"),
    structured(acceptAll()),
  ];
  /** 段の走りの探索の記録から、往復の方式の並び（記録が無ければ空） */
  const stageHandsOf = (outcome: Awaited<ReturnType<typeof runStageRangeV11a>>): readonly string[] =>
    (outcome.searchRepair?.events ?? []).flatMap((event) => (event.kind === "round" ? [event.hand] : []));
  /** 段の走りの探索の記録から、版の (出所, 違反の数, 採ったか) の並び（`totalsOf` と同じ形） */
  const stageTotalsOf = (outcome: Awaited<ReturnType<typeof runStageRangeV11a>>): readonly unknown[] =>
    (outcome.searchRepair?.events ?? []).flatMap((event) =>
      event.kind === "version"
        ? [
            [
              event.origin,
              event.violations === null
                ? null
                : event.violations.kind === "counted"
                  ? event.violations.knownTotal
                  : event.violations.kind,
              event.adoption === "adopted",
            ],
          ]
        : [],
    );

  /**
   * 直す前（bb769d6）の、下の `HANDOFF_CALLS` と同じ台本の**同じ走りの中の**欄だけの直しの body の SHA-256（**期待**）。
   * 取り方：`git worktree add --detach <リポジトリの外の一時ディレクトリ> bb769d6` で作った一時の worktree に、`HANDOFF_CALLS`
   * と同じ台本（同じ入力・同じ最良版・同じ応答・同じ adapter の設定。全文の直しの候補を採ったあと欄だけの直しへ入る）を
   * 流す一時の試験を足し、偽物の fetch が実際に受けた body の `sha256(JSON.stringify(body))` を記録した（一気通貫と段の走りで
   * 同じ値）。測った後に一時の試験を戻し、補助（node_modules・dist の link）を消してから `git worktree remove`（force なし）で
   * 消した。診断の塊を含む body なので #764 の後もこの値のまま。
   */
  const BB769D6_HANDOFF_FIELD_BODY_SHA = [
    "2f938971e45be809c0a7e4f794e278286512b308fe7684be22aaff33b2df9f46",
  ] as const;
  /**
   * #761 の前（f9bf3b3）の、`HANDOFF_CALLS` と同じ台本の**同じ走りの中の**全文の直しの要求の body の SHA-256（**期待**）。
   * 取り方：`git worktree add --detach <リポジトリの外の一時ディレクトリ> f9bf3b3` で作った一時の worktree に、`HANDOFF_CALLS`
   * と同じ台本（同じ入力・同じ最良版・同じ応答・同じ adapter の設定。全文の直しの候補を採ったあと欄だけの直しへ入る）を
   * 流す一時の試験を足し、偽物の fetch が実際に受けた body の `sha256(JSON.stringify(body))` を記録した（一気通貫と段の走りで
   * 同じ値）。この台本の全文の直しは道具の呼び出しを挟まず最後の応答が 1 本なので、継続の要求は無い。測った後に一時の試験を
   * 戻し、補助を消して `git status --porcelain` が空を確かめ、`git worktree remove`（force なし）で消した。今の body から診断を
   * 取り除いて比べた値ではない。bb769d6 の同じ台本の全文の body は診断の塊があるので `ee74d20e…` で一致しない。
   */
  const F9BF3B3_HANDOFF_FULL_BODY_SHA = [
    "6c62de47e0e97c6f20aeea9a0f8bfe7bc63cd6c0bb8e4c4e89e0b9e9d21ef23b",
  ] as const;
  /** 同じ台本の版の (出所, 違反の数, 採ったか) の並び（bb769d6 の実測。修復 2 往復・全文→欄だけ・すべて採用） */
  const HANDOFF_TOTALS: readonly unknown[] = [
    ["write", 7, true],
    ["repair", 3, true],
    ["repair", 0, true],
  ];

  it("(2) 同じ走りの中で全文の直しの候補を採ったあと残った失敗を欄だけの直しで直す（一気通貫）：両方式が呼ばれ、全文に診断が無く、欄だけの body は bb769d6 と同じ", async () => {
    const calls = HANDOFF_CALLS();
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
    expect(result.stopped).toBeNull();
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(wire.consumed(), "台本を使い切った").toBe(calls.length);
    const tools = wire.sent.filter((sent) => sent.kind === "tools");
    const fields = wire.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    // 同じ走りの中で両方式が実際に呼ばれる（全文の直し 1・欄だけの直し 1）
    expect(tools).toHaveLength(1);
    expect(fields).toHaveLength(1);
    // 全文の直しの body に診断の塊は無い
    for (const sent of tools) expect(hasFullDiagnostic(sent)).toBe(false);
    // 全文の直しの body は #761 の前（f9bf3b3）と同じ（診断の塊が無い body）
    expect(await bodyShas(tools)).toEqual([...F9BF3B3_HANDOFF_FULL_BODY_SHA]);
    // 同じ走りの中の欄だけの直しの body は、同じ台本の bb769d6 の body と一致する（診断の塊がある）
    for (const sent of fields) expect(hasDiagnostic(sent)).toBe(true);
    expect(await bodyShas(fields)).toEqual([...BB769D6_HANDOFF_FIELD_BODY_SHA]);
    // 採否と回数の並びは同じ台本の等値（修復の段は 2 回。全文→欄だけの順）
    expect(result.record.stages.filter((stage) => stage.stage === "repair")).toHaveLength(2);
    expect(roundsOf(result.bundle).map((round) => round.hand)).toEqual(["repair", "field-repair"]);
    expect(totalsOf(result.bundle)).toEqual(HANDOFF_TOTALS);
  });

  it("(2) 同じ走りの中で全文の直しの候補を採ったあと残った失敗を欄だけの直しで直す（段の走り）：両方式が呼ばれ、全文に診断が無く、欄だけの body は bb769d6 と同じ", async () => {
    const calls = HANDOFF_CALLS();
    const wire = wireClientOf(calls, "v1.2-ids");
    const outcome = await runStageRangeV11a({
      ...inputOf(wire.client, { flags: FLAGS }),
      range: { start: "name-table", end: "judge" },
    });
    expect(outcome.stopped).toBeNull();
    expect(wire.consumed(), "台本を使い切った").toBe(calls.length);
    const tools = wire.sent.filter((sent) => sent.kind === "tools");
    const fields = wire.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    // 同じ走りの中で両方式が実際に呼ばれる（全文の直し 1・欄だけの直し 1）
    expect(tools).toHaveLength(1);
    expect(fields).toHaveLength(1);
    // 全文の直しの body に診断の塊は無い
    for (const sent of tools) expect(hasFullDiagnostic(sent)).toBe(false);
    // 全文の直しの body は #761 の前（f9bf3b3）と同じ（診断の塊が無い body）
    expect(await bodyShas(tools)).toEqual([...F9BF3B3_HANDOFF_FULL_BODY_SHA]);
    // 同じ走りの中の欄だけの直しの body は、同じ台本の bb769d6 の body と一致する（診断の塊がある）
    for (const sent of fields) expect(hasDiagnostic(sent)).toBe(true);
    expect(await bodyShas(fields)).toEqual([...BB769D6_HANDOFF_FIELD_BODY_SHA]);
    // 採否と回数の並びは同じ台本の等値（修復の段は 2 回。全文→欄だけの順）
    expect(outcome.stages.filter((record) => record.stage === "repair")).toHaveLength(2);
    expect(stageHandsOf(outcome)).toEqual(["repair", "field-repair"]);
    expect(stageTotalsOf(outcome)).toEqual(HANDOFF_TOTALS);
  });

  it("(1) 直す前の挙動：ids off の欄だけの直しには、診断の塊も規則も届かない", async () => {
    const calls = [
      ...head({ yaml: W2 }),
      structured(acceptAll()),
      fieldRepair("amount > 1"),
      structured(acceptAll()),
      fieldRepair("amount > 0"),
      structured(acceptAll()),
    ];
    const wire = wireClientOf(calls, "v1.1a");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: { searchRepair: true } }));
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const fields = wire.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fields).toHaveLength(2);
    for (const sent of fields) {
      expect(hasDiagnostic(sent)).toBe(false);
      expect(JSON.stringify(sent.body)).not.toContain("R-fr-08");
    }
  });

  it("(4) 一番良い版の追随（欄だけの直し）：捨てた候補の診断に変わらず、採った候補で新しい一番良い版の診断になる", async () => {
    const calls = [
      ...idsHead({ yaml: W2 }),
      structured(acceptAll()),
      fieldRepair("amount > 1"),
      structured(acceptAll()),
      fieldRepair("amount > 7"),
      structured(acceptAll()),
      fieldRepair("amount > 0"),
      structured(acceptAll()),
    ];
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const fields = wire.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fields).toHaveLength(3);
    const [first, second, third] = fields;
    if (first === undefined || second === undefined || third === undefined) throw new Error("前提が壊れた");
    // 初期版の失敗 2 → 採った版の失敗 1
    expect(diagnosticOf(first).tests).toHaveLength(2);
    expect(diagnosticOf(second).tests).toHaveLength(1);
    // 捨てた候補（不一致 2）の失敗を混ぜず、前の一番良い版の診断のまま
    expect(JSON.stringify(diagnosticOf(third))).toBe(JSON.stringify(diagnosticOf(second)));
    expect(diagnosticOf(third).tests).toHaveLength(1);
  });

  it("(4) 一番良い版の追随（全文の直し）：捨てた候補のあとも前の一番良い版の試験の結果のまま、採った候補で新しい一番良い版の試験の結果になる", async () => {
    const calls = [
      ...idsHead({ yaml: NO_CLOSE }),
      repairDone(NO_CLOSE),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ];
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
    expect(result.outcome).toEqual({ result: "pass", verdict: "full" });
    const tools = wire.sent.filter((sent) => sent.kind === "tools");
    expect(tools).toHaveLength(2);
    const [first, second] = tools;
    if (first === undefined || second === undefined) throw new Error("前提が壊れた");
    // 捨てた候補（同じ失敗 3）のあとも、前の一番良い版の試験の結果（3 件）のまま（既存の C7 の塊で追随を見る）
    expect([...testRunOf(first).mismatches, ...testRunOf(first).unresolved]).toHaveLength(3);
    expect(JSON.stringify(testRunOf(second))).toBe(JSON.stringify(testRunOf(first)));
    for (const sent of tools) expect(hasFullDiagnostic(sent)).toBe(false);
  });

  it("(4) 宣言の SHA のまま網羅を数え直す（欄だけの直し）：捨てる/採るに依らず、数え直した失敗の診断に変わる（宣言の SHA だけで使い回す実装は落ちる）", async () => {
    const calls = [
      ...idsHead({ yaml: BOTH_BAD }),
      structured(acceptAll()),
      // 1 往復目：R3 の境界だけを直し、R3 の境界の試験を棄却する（率の式は直さない）
      fieldRepairWith([{ location: CLOSE, element: closeItemBody("amount > 0") }], [{ testId: R3_BOUNDARY, quote: QUOTE }]),
      arbitration([{ testId: R3_BOUNDARY, verdict: "overturn" }]),
      structured(acceptAll(["R1", "R2", "R4"])),
      // 2 往復目：数え直した一番良い版（同じ宣言の SHA）から、残った R4 の失敗だけの診断になる
      rateRepair("base * 2"),
      structured(acceptAll(["R1", "R2", "R4"])),
    ];
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
    // R3 は網羅の単位を失って持ち越しになる（宣言の SHA は数え直しで変えない）
    expect(result.stopped).toBeNull();
    expect(result.outcome.verdict).toBe("partial");
    const fields = wire.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fields).toHaveLength(2);
    const [first, second] = fields;
    if (first === undefined || second === undefined) throw new Error("前提が壊れた");
    // 宣言のバイト列は同じ（数え直しは宣言を変えない）
    expect(rawDataBlockOf(wireInputOf(first), "宣言")).toBe(rawDataBlockOf(wireInputOf(second), "宣言"));
    // 1 回目は R3 の境界と R4 の 3 本、2 回目は R4 の 3 本だけ（捨てた候補・前の版の失敗を混ぜない）
    expect(diagnosticOf(first).tests.map((entry) => entry.testId)).toEqual([R3_BOUNDARY, ...R4_CASES]);
    expect(diagnosticOf(second).tests.map((entry) => entry.testId)).toEqual([...R4_CASES]);
    expect(JSON.stringify(diagnosticOf(first))).not.toBe(JSON.stringify(diagnosticOf(second)));
  });

  it("(4) 宣言の SHA のまま網羅を数え直す（全文の直し）：同じ宣言の SHA でも、数え直した失敗の試験の結果に変わる", async () => {
    const calls = [
      ...idsHead({ yaml: BOTH_BAD }),
      structured(judgments(IDS, { ...REJECT_R1, ...REJECT_R3 })),
      repairDone(BOTH_BAD, [{ testId: R3_BOUNDARY, quote: QUOTE }]),
      arbitration([{ testId: R3_BOUNDARY, verdict: "overturn" }]),
      // 候補の B3' が R2 を拒否して同数になり、候補は採られない（一番良い版は数え直した版のまま）
      structured(judgments(["R1", "R2", "R4"], REJECT_R2)),
      repairDone(RUN_YAML),
      structured(acceptAll(["R1", "R2", "R4"])),
    ];
    const wire = wireClientOf(calls, "v1.2-ids");
    const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
    expect(result.stopped).toBeNull();
    expect(wire.consumed(), "台本を使い切った").toBe(calls.length);
    const tools = wire.sent.filter((sent) => sent.kind === "tools");
    expect(tools).toHaveLength(2);
    const [first, second] = tools;
    if (first === undefined || second === undefined) throw new Error("前提が壊れた");
    expect(rawDataBlockOf(wireInputOf(first), "宣言")).toBe(rawDataBlockOf(wireInputOf(second), "宣言"));
    // 1 回目は R3 の境界と R4 の 3 本、2 回目は R4 の 3 本だけ（既存の C7 の塊で数え直しを見る）
    expect([...testRunOf(first).mismatches, ...testRunOf(first).unresolved].map((entry) => entry.testId)).toEqual([R3_BOUNDARY, ...R4_CASES]);
    expect([...testRunOf(second).mismatches, ...testRunOf(second).unresolved].map((entry) => entry.testId)).toEqual([...R4_CASES]);
    expect(JSON.stringify(testRunOf(first))).not.toBe(JSON.stringify(testRunOf(second)));
    for (const sent of tools) expect(hasFullDiagnostic(sent)).toBe(false);
  });

  it("(5)(6) 段の走りの実行口からも、全文の直しの body に診断の塊は届かず、repair=medium が載る。同じ台本の探索 off の走りと、修復以外の段の要求の body が同じ", async () => {
    const calls = [...idsHead({ yaml: NO_CLOSE }), repairDone(RUN_YAML), structured(acceptAll())];
    const wire = wireClientOf(calls, "v1.2-ids");
    const outcome = await runStageRangeV11a({
      ...inputOf(wire.client, { flags: FLAGS, stageEfforts: { repair: "medium" } }),
      range: { start: "name-table", end: "judge" },
    });
    expect(outcome.stopped).toBeNull();
    expect(wire.consumed(), "台本を使い切った").toBe(calls.length);
    const tools = wire.sent.filter((sent) => sent.kind === "tools");
    expect(tools).toHaveLength(1);
    const sent = tools[0];
    if (sent === undefined) throw new Error("前提が壊れた");
    // 段の走りの実行口も、全文の直しへ診断の塊を渡さない（Issue #764）
    expect(hasFullDiagnostic(sent)).toBe(false);
    expect([...testRunOf(sent).mismatches, ...testRunOf(sent).unresolved]).toHaveLength(3);
    expect(wireEffortOf(sent)).toBe("medium");

    // 同じ台本の比較の走り（探索 off）。修復以外の段の要求の body は同じで、どちらの全文の直しにも診断の塊は無い
    const plainWire = wireClientOf(calls, "v1.2-ids");
    const plain = await runStageRangeV11a({
      ...inputOf(plainWire.client, { flags: { ledger: true, ids: true, searchRepair: false }, stageEfforts: { repair: "medium" } }),
      range: { start: "name-table", end: "judge" },
    });
    expect(plain.stopped).toBeNull();
    expect(plainWire.consumed(), "台本を使い切った").toBe(calls.length);
    const nonRepair = (wireSent: readonly WireSent[]): readonly string[] =>
      wireSent.filter((candidate) => !isRepairWire(candidate)).map((candidate) => JSON.stringify(candidate.body));
    expect(nonRepair(wire.sent).length).toBeGreaterThan(0);
    expect(nonRepair(wire.sent)).toEqual(nonRepair(plainWire.sent));
    const plainTools = plainWire.sent.filter((candidate) => candidate.kind === "tools");
    expect(plainTools).toHaveLength(1);
    for (const candidate of plainTools) expect(hasFullDiagnostic(candidate)).toBe(false);
  });

  it("(R4) 候補を採ったあとも失敗が残る例で、次の修復の要求は新しい一番良い版の材料になり、同じ版から始めた最初の要求と body が完全に等しい（同じ試験 ID の details が変わる）", async () => {
    const sentOf = async (calls: readonly RecordedCall[]): Promise<readonly WireSent[]> => {
      const wire = wireClientOf(calls, "v1.2-ids");
      await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
      return wire.sent;
    };
    // 欄だけの直しは診断の塊、全文の直しは既存の C7 の塊（試験の結果）から、同じ試験 ID（R4）の details を読む
    const rateDetails = (sent: WireSent): readonly string[] =>
      diagnosticOf(sent)
        .tests.filter((entry) => R4_CASES.includes(entry.testId))
        .flatMap((entry) => entry.details);
    const testRunDetails = (sent: WireSent): readonly string[] =>
      [...testRunOf(sent).mismatches, ...testRunOf(sent).unresolved]
        .filter((entry) => R4_CASES.includes(entry.testId))
        .map((entry) => entry.detail);

    // 欄だけの直し：率 base*3・検査 amount<0（6）→ 率 base*4・検査 amount>0（3）を採る → 次の要求は新しい一番良い版
    const fieldAdopted = await sentOf([
      ...idsHead({ yaml: R4_FIELD_BAD }),
      structured(acceptAll()),
      fieldRepairWith([amountValidation("amount > 0"), { location: "computation:rate", element: rateBody("base * 4") }]),
      structured(acceptAll()),
    ]);
    const fieldFromBest = await sentOf([...idsHead({ yaml: R4_FIELD_CANDIDATE }), structured(acceptAll())]);
    const fieldA = fieldAdopted.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    const fieldB = fieldFromBest.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fieldA).toHaveLength(2);
    expect(fieldB).toHaveLength(1);
    // 採用後の次の要求の body は、同じ一番良い版から始めた最初の要求と完全に等しい
    expect(wireInputOf(fieldA[1] as WireSent)).toBe(wireInputOf(fieldB[0] as WireSent));
    // 同じ試験 ID（rate）の details が、実際 9 から実際 12 に変わる
    expect(rateDetails(fieldA[0] as WireSent).some((detail) => detail.includes("実際 9"))).toBe(true);
    expect(rateDetails(fieldA[1] as WireSent).some((detail) => detail.includes("実際 12"))).toBe(true);
    expect(rateDetails(fieldA[0] as WireSent)).not.toEqual(rateDetails(fieldA[1] as WireSent));

    // 全文の直し：場所なし（closeItem を外す）と率 base*3・検査 amount<0（8）→ 率 base*4・検査 amount>0（場所なし 3 + rate 3）を採る
    const rejected = (): RecordedCall => structured(judgments(IDS, REJECT_R3));
    const fullAdopted = await sentOf([...idsHead({ yaml: R4_FIELD_BAD }), rejected(), repairDone(R4_FIELD_CANDIDATE), rejected()]);
    const fullFromBest = await sentOf([...idsHead({ yaml: R4_FIELD_CANDIDATE }), rejected(), repairDone(RUN_YAML)]);
    const fullA = fullAdopted.filter((sent) => sent.kind === "tools");
    const fullB = fullFromBest.filter((sent) => sent.kind === "tools");
    expect(fullA).toHaveLength(2);
    expect(fullB).toHaveLength(1);
    expect(wireInputOf(fullA[1] as WireSent)).toBe(wireInputOf(fullB[0] as WireSent));
    // 診断の塊は届かない（Issue #764）。既存の C7 の塊でも、同じ試験 ID（rate）の details が実際 9 から実際 12 に変わる
    for (const sent of [...fullA, ...fullB]) expect(hasFullDiagnostic(sent)).toBe(false);
    expect(testRunDetails(fullA[0] as WireSent).some((detail) => detail.includes("実際 9"))).toBe(true);
    expect(testRunDetails(fullA[1] as WireSent).some((detail) => detail.includes("実際 12"))).toBe(true);
    expect(testRunDetails(fullA[0] as WireSent)).not.toEqual(testRunDetails(fullA[1] as WireSent));
  });

  it("(R3) 同じ操作（validate）で observes が違う検査と既定値の 2 つの試験を、欄だけの直しの一気通貫と段の走りの両方の実行口で試験 ID ごとに照合し、全文の直しの両方の実行口には診断の塊が届かない", async () => {
    const runs = [await runR3("field", "generation"), await runR3("field", "stage")];
    const pairs = runs.map((sent) => r3ObservesOf(sent));
    // 2 つの走りで、同じ試験 ID に同じ observes が載る（body の完全な等値）
    for (const candidate of pairs.slice(1)) expect(candidate).toEqual(pairs[0]);
    // 検査（validation）と既定値（default-value）が同じ操作（validate）のまま別々に載る
    const observed = pairs[0] ?? [];
    expect(new Set(observed.map(([, observes]) => observes))).toEqual(new Set(["validation", "default-value"]));
    const defaultPair = observed.find(([, observes]) => observes === "default-value");
    if (defaultPair === undefined) throw new Error("前提が壊れた：既定値の試験が無い");
    expect(defaultPair[0].startsWith(GENERATED_TEST_ID_PREFIX)).toBe(true);
    for (const [testId] of observed.filter(([, value]) => value === "validation")) {
      expect(testId, "検査の試験は T2 の場合（同じ操作 validate）").toMatch(/^case:\d+$/u);
    }
    // 全文の直しの両方の実行口には、診断の塊が届かない（Issue #764）
    for (const execution of ["generation", "stage"] as const) {
      const sent = await runR3("full", execution);
      const request = sent.find((candidate) => candidate.kind === "tools");
      if (request === undefined) throw new Error("前提が壊れた：全文の直しの要求が無い");
      expect(hasFullDiagnostic(request)).toBe(false);
      expect([...testRunOf(request).mismatches, ...testRunOf(request).unresolved].length).toBeGreaterThan(0);
    }
  });
});

// ── 最後の答えの枠を取っておく（旗 v12.ids の探索 on の全文の直し。Issue #768）──────────────
//
// 一気通貫と段の走りの両方の実行口から、実 adapter に偽物の fetch を当てて body まで通す。7 回目からは
// 道具を選ばせない指定（`tool_choice: "none"`）が載り、6 回以内の要求と欄だけの直しの要求は今のまま。

describe("最後の答えの枠を取っておく（旗 v12.ids の探索 on の全文の直し。Issue #768）：実行口から偽物の fetch の body まで", () => {
  const FLAGS = { ledger: true, ids: true, searchRepair: true } as const;
  /** closeItem の操作を宣言から外した版（場所なしの失敗だけになり、全文の直しへ流れる） */
  const NO_CLOSE = replaced(
    RUN_YAML,
    "  - name: closeItem\n    entity: item\n    kind: update\n    set:\n      kind: beta\n    when: amount > 0\n",
    "",
  );
  /** 印の無い道具の束（静的チェック 1 個） */
  const bundle = (round: number): RecordedCall => repairToolCall(`b${String(round)}`, "static-check", RUN_YAML);
  /** 最後の答えの形が合わない done（宣言が文字列でない） */
  const malformedDone = (): RecordedCall => ({
    kind: "tools",
    response: { kind: "done", declaration: { declaration: 123 }, usage: undefined },
  });
  /** 印付きの要求に返る、3 種の道具を含む束 */
  const threeKindBundle = (): RecordedCall => ({
    kind: "tools",
    response: {
      kind: "toolCalls",
      toolCalls: [
        { id: "f0", name: "static-check", arguments: { declaration: RUN_YAML } },
        { id: "f1", name: "run-tests", arguments: { declaration: RUN_YAML } },
        { id: "f2", name: "check-correspondence", arguments: { declaration: RUN_YAML } },
      ],
      usage: undefined,
    },
  });
  /** 全文の直しの要求に印（道具を選ばせない指定）が載っているか */
  const markedOf = (sent: WireSent): boolean => sent.body["tool_choice"] === "none";
  const six = (): RecordedCall[] => Array.from({ length: 6 }, (_, round) => bundle(round));
  /** 印の 1 キーだけを外した body（7b47038 との比較用。ほかのキーは除かない） */
  const withoutToolChoice = (body: Record<string, unknown>): Record<string, unknown> => {
    const { tool_choice: _choice, ...rest } = body;
    return rest;
  };
  /**
   * 直す前（7b47038）の、(1) と同じ台本の 1〜7 回目の道具付きの要求の body の SHA-256（**期待**）。
   * 偽物の fetch が実際に受けた body を**加工しない**で `sha256(JSON.stringify(body))` にした値。
   *
   * 取り方：`git worktree add --detach <リポジトリの外の一時ディレクトリ> 7b47038` で作った一時の worktree に、
   * 下の (1) と同じ台本（同じ入力・同じ最良版・同じ応答・同じ adapter の設定＝実行口から実 adapter と
   * 偽物の fetch まで。`idsHead({ yaml: NO_CLOSE })`・道具の束 6 回・7 回目の done）を、一気通貫
   * （`runGenerationV11a`）と段の走り（`runStageRangeV11a`・`name-table`→`judge`）の両方の実行口から流し、
   * 受けた 7 本の body の SHA を記録した。**両方の実行口で 7 本とも同じ値**で、7 回目の body に
   * `tool_choice` のキーが無いことも確かめた（`Object.hasOwn(body, "tool_choice")` が全 7 本で偽）。
   * 測った後に一時の試験を戻し、`git status --porcelain` が空を確かめて `git worktree remove`（force なし）で
   * 消した。branch は作らず、push もしていない。
   *
   * 今の head では 1〜6 回目の body がこの値とそのまま一致し、7 回目は `tool_choice` の 1 キーだけを除いた
   * JSON の SHA が 7 番目の値と一致する（足されたのは道具を選ばせない指定だけ）。
   */
  const BEFORE_768_BODY_SHA = [
    "9fbb8ee3925cc507086726de650528f4ad2a9e2808267eecb77191c835a8e5f4",
    "8ec81b99f165db65ff99a68faf4f6b0935aaab6042f2bd2755feed6e28c7d204",
    "2ca54844448e22349158a578990a0a16a3527a294f87d62e5740d3979b20ddb9",
    "77609928f0c144ed23be4a0d3e511db17f624e4fb8527049d748506863e7d8ed",
    "d8a749023ba59acbf609f3fca39ac44ed6552d13ae2cf0b452c3f7e76215bfdc",
    "abb575b5ad9d3bd70187b674f57cce5f8395af2d07f4d708421e71e7af6a4a09",
    "9f1d1d6217256db704c9f621bd17989d7e8e09633e5ee405d70f373472816f5d",
  ] as const;

  /** 直す段の記録の 1 行（一気通貫は要約の v12_calls、段の走りは結果の v12Calls） */
  type Steps = readonly Record<string, unknown>[];
  const generationSteps = (result: Awaited<ReturnType<typeof runGenerationV11a>>): Steps => {
    const calls = (result.summary as unknown as { readonly v12_calls?: { readonly repair?: { readonly steps?: Steps } } }).v12_calls;
    return calls?.repair?.steps ?? [];
  };
  const stageSteps = (outcome: Awaited<ReturnType<typeof runStageRangeV11a>>): Steps => {
    const calls = outcome.v12Calls as { readonly repair?: { readonly steps?: Steps } } | undefined;
    return calls?.repair?.steps ?? [];
  };
  /**
   * 一気通貫と段の走りの両方の実行口を、同じ形の結果にそろえて流す（種類ごとに 1 本ずつ赤を測れるように、
   * 試験は実行口ごとに分ける）。
   */
  const runPath = async (
    execution: "generation" | "stage",
    calls: readonly RecordedCall[],
  ): Promise<{
    readonly sent: readonly WireSent[];
    readonly consumed: number;
    readonly total: number;
    readonly stopped: unknown;
    readonly failure: unknown;
    readonly verdict: string | null;
    readonly outcome: { readonly result: string; readonly verdict: string } | undefined;
    readonly steps: Steps;
  }> => {
    const wire = wireClientOf(calls, "v1.2-ids");
    if (execution === "generation") {
      const result = await runGenerationV11a(inputOf(wire.client, { flags: FLAGS }));
      return {
        sent: wire.sent,
        consumed: wire.consumed(),
        total: calls.length,
        stopped: result.stopped,
        failure: result.record.failure,
        verdict: result.outcome.verdict,
        outcome: result.outcome,
        steps: generationSteps(result),
      };
    }
    const outcome = await runStageRangeV11a({
      ...inputOf(wire.client, { flags: FLAGS }),
      range: { start: "name-table", end: "judge" },
    });
    return {
      sent: wire.sent,
      consumed: wire.consumed(),
      total: calls.length,
      stopped: outcome.stopped,
      failure: outcome.stopped,
      verdict: outcome.judgeVerdict,
      outcome: undefined,
      steps: stageSteps(outcome),
    };
  };
  const EXECUTIONS = ["generation", "stage"] as const;

  it.each(EXECUTIONS)("(1) 道具の束 6 回 → 7 回目に done：7 回目だけに印が載り、段は done（%s）", async (execution) => {
    const calls = [...idsHead({ yaml: NO_CLOSE }), ...six(), repairDone(RUN_YAML), structured(acceptAll())];
    const run = await runPath(execution, calls);

    expect(run.consumed, "台本を使い切った").toBe(run.total);
    const tools = run.sent.filter((sent) => sent.kind === "tools");
    expect(tools).toHaveLength(7);
    // 6 回目までは今の body（道具を選ばせない指定が無い）、7 回目だけに載る
    expect(tools.map(markedOf)).toEqual([false, false, false, false, false, false, true]);
    expect(JSON.stringify(tools[0]?.body)).not.toContain("tool_choice");
    const seventh = tools[6];
    if (seventh === undefined) throw new Error("前提が壊れた：7 回目の要求が無い");
    // 1〜6 回目の body は 7b47038 の実測とそのまま一致する（何も除かない）
    const rawShas = await Promise.all(tools.map((sent) => sha256Hex(JSON.stringify(sent.body))));
    expect(rawShas.slice(0, 6)).toEqual(BEFORE_768_BODY_SHA.slice(0, 6));
    // 7 回目に足されたのは道具を選ばせない指定だけ（その 1 キーを除いた JSON が 7b47038 の 7 回目と一致）
    expect(seventh.body["tool_choice"]).toBe("none");
    expect(await sha256Hex(JSON.stringify(withoutToolChoice(seventh.body)))).toBe(BEFORE_768_BODY_SHA[6]);
    expect(run.stopped).toBeNull();
    expect(run.verdict).toBe("full");
    if (run.outcome !== undefined) expect(run.outcome).toEqual({ result: "pass", verdict: "full" });
    expect(run.steps).toEqual([
      {
        responses: 7,
        tool_bundles: 6,
        tools_executed: 6,
        tool_calls_at_start: 0,
        tool_calls_at_end: 6,
        shape_retries: 0,
        limit: null,
        end: "done",
        finalize_responses: 1,
        finalize_refused_bundles: 0,
      },
    ]);
  });

  it.each(EXECUTIONS)("(2) 7 回目の done が形に合わない → 8 回目も印付きで done：形のやり直し 1（%s）", async (execution) => {
    const calls = [
      ...idsHead({ yaml: NO_CLOSE }),
      ...six(),
      malformedDone(),
      repairDone(RUN_YAML),
      structured(acceptAll()),
    ];
    const run = await runPath(execution, calls);

    expect(run.consumed, "台本を使い切った").toBe(run.total);
    const tools = run.sent.filter((sent) => sent.kind === "tools");
    expect(tools).toHaveLength(8);
    expect(tools.map(markedOf)).toEqual([false, false, false, false, false, false, true, true]);
    expect(run.stopped).toBeNull();
    expect(run.verdict).toBe("full");
    expect(run.steps).toEqual([
      {
        responses: 8,
        tool_bundles: 6,
        tools_executed: 6,
        tool_calls_at_start: 0,
        tool_calls_at_end: 6,
        shape_retries: 1,
        limit: null,
        end: "done",
        finalize_responses: 2,
        finalize_refused_bundles: 0,
      },
    ]);
  });

  it.each(EXECUTIONS)("(3) 印付きの要求に 3 種の道具の束が返る：1 つも実行せず unmet で終わり、8 回目を求めない（%s）", async (execution) => {
    const calls = [...idsHead({ yaml: NO_CLOSE }), ...six(), threeKindBundle()];
    const run = await runPath(execution, calls);

    // 求めた応答の契約への違反（固定の問題文 1 つ）で止まる。往復の上限ではないので limit は持たない
    const stopped = {
      stage: "repair",
      kind: "unmet",
      problems: [{ field: "", message: "最後の答えだけを求めた要求に道具の呼び出しが返った" }],
    };
    expect(run.consumed, "8 回目を求めない").toBe(run.total);
    expect(run.stopped).toEqual(stopped);
    expect(run.failure).toEqual(stopped);
    if (run.outcome === undefined) {
      // 段の走りは ⑦ に届かないので判定は無い（止まった段の帰属だけを持つ）
      expect(run.verdict).toBeNull();
    } else {
      expect(run.outcome).toEqual({ result: "failed", verdict: "none" });
    }
    const tools = run.sent.filter((sent) => sent.kind === "tools");
    expect(tools).toHaveLength(7);
    expect(tools.map(markedOf)).toEqual([false, false, false, false, false, false, true]);
    expect(run.steps).toEqual([
      {
        responses: 7,
        tool_bundles: 7,
        tools_executed: 6,
        tool_calls_at_start: 0,
        tool_calls_at_end: 9,
        shape_retries: 0,
        limit: null,
        end: "unmet",
        finalize_responses: 1,
        finalize_refused_bundles: 1,
      },
    ]);
  });

  it.each(EXECUTIONS)("(5) 欄だけの直しの要求には印が載らない（%s）", async (execution) => {
    const calls = [
      ...idsHead({ yaml: W2 }),
      structured(acceptAll()),
      fieldRepair("amount > 1"),
      structured(acceptAll()),
      fieldRepair("amount > 0"),
      structured(acceptAll()),
    ];
    const run = await runPath(execution, calls);

    expect(run.consumed, "台本を使い切った").toBe(run.total);
    const fields = run.sent.filter((sent) => sent.schemaName === FIELD_REPAIR_SCHEMA_NAME);
    expect(fields.length).toBeGreaterThan(0);
    for (const sent of fields) expect(markedOf(sent)).toBe(false);
    expect(run.stopped).toBeNull();
    expect(run.verdict).toBe("full");
  });

  it("(7) 6 回以内に終わる段と探索 off の段の記録には、足した 2 つの数が出ない", async () => {
    // 6 回以内に終わる全文の直し（探索 on）：印付きの要求は 7 回目からなので、応答は 1 回だけ
    const short = [...idsHead({ yaml: NO_CLOSE }), repairDone(RUN_YAML), structured(acceptAll())];
    const shortWire = wireClientOf(short, "v1.2-ids");
    const shortRun = await runGenerationV11a(inputOf(shortWire.client, { flags: FLAGS }));
    expect(shortRun.outcome).toEqual({ result: "pass", verdict: "full" });
    const shortSteps = generationSteps(shortRun);
    expect(shortSteps).toHaveLength(1);
    expect(shortSteps[0]).not.toHaveProperty("finalize_responses");
    expect(shortSteps[0]).not.toHaveProperty("finalize_refused_bundles");

    // 探索 off の全文の直し（ids on）：8 回の道具の束で段内の上限に当たっても、欄は出ない
    const offCalls = [
      ...idsHead({ yaml: NO_CLOSE }),
      ...Array.from({ length: AGENT_LIMITS.repairStepTurns }, (_, round) => bundle(round)),
    ];
    const wire = wireClientOf(offCalls, "v1.2-ids");
    const off = await runGenerationV11a(inputOf(wire.client, { flags: { ledger: true, ids: true, searchRepair: false } }));
    expect(off.stopped).toEqual({ stage: "repair", kind: "call-limit", limit: { name: "repairStepTurns", max: 8, actual: 9 } });
    const offTools = wire.sent.filter((sent) => sent.kind === "tools");
    expect(offTools).toHaveLength(8);
    for (const sent of offTools) expect(markedOf(sent)).toBe(false);
    const offSteps = generationSteps(off);
    expect(offSteps).toHaveLength(1);
    expect(offSteps[0]).not.toHaveProperty("finalize_responses");
    expect(offSteps[0]).not.toHaveProperty("finalize_refused_bundles");
  });
});
