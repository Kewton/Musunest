// 欄だけの直し（v12/stages/field-repair.ts）の試験（08-architecture-v1.2.md §3 の 1 (c)・§4 のループの行・§9 の手 4 の後半。
// Issue #553）。
//
// 偽物の LLM（記録した応答を返す）と共通の口で回す。外部の API・鍵・判定・時計を使わない（時計は 0 に固定）。
import { readSpecDocument } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { structured } from "../../__tests__/run.js";
import type { FixedTest, TestSuite } from "../../fixed-test.js";
import { AGENT_LIMITS } from "../../limits.js";
import type { RecordedCall } from "../../llm-fake.js";
import { envelopeStageFor } from "../../schema-envelope.js";
import { createRecordingClient, makeGateway } from "../../stages/__tests__/prompt.js";
import { ruleDefinitionDefects, SHAPE_PROBLEMS_DATA_NAME } from "../../stages/prompt.js";
import { strictSchemaProblems } from "../../stages/schema-strict.test.js";
import { FIXTURE_DOCUMENTS, FIXTURE_YAML, fixtureList, fixtureTable } from "../../v11a/__tests__/fixtures.js";
import { canonicalJson } from "../../v11a/names.js";
import { declarationSpans, locateFailures, type LocateInput } from "../locate.js";
import {
  FIELD_REPAIR_DATA_NAMES,
  FIELD_REPAIR_PROBLEMS,
  FIELD_REPAIR_RULE_DEFINITIONS,
  FIELD_REPAIR_SCHEMA_NAME,
  MERGE_REFUSALS,
  checkFieldRepairAnswer,
  fieldRepairSchemaOf,
  mergeReplacements,
  runFieldRepair,
} from "./field-repair.js";

const LIST = fixtureList();
const SOURCE = LIST.requirements.map((requirement) => requirement.text).join("");
const TABLE = fixtureTable();

const test = (id: string, requirementId: string, kind: string, roleId: string, operation: string): FixedTest =>
  ({
    id,
    target: { requirementId, kind, roleId },
    kind: "normal",
    operation,
    clock: "2026-09-16T12:00:00+09:00",
    input: {},
    referenceData: [],
    expected: { kind: "ok", value: "true", code: null },
  }) as unknown as FixedTest;

const SUITE: TestSuite = {
  tests: [test("r3-when", "R3", "operation", "o.closeItem", "action"), test("r4-rate", "R4", "computation", "c.rate", "compute")],
};

const locateInput = (mismatches: readonly string[]): LocateInput => ({
  source: FIXTURE_YAML,
  table: TABLE,
  suite: SUITE,
  staticCheckPassed: true,
  diagnostics: [],
  correspondenceMisses: [],
  rejections: [],
  unmarked: [],
  mismatches: mismatches.map((testId) => ({ testId })),
  unresolved: [],
});

/** 操作 closeItem の本文（条件だけを差し替える） */
const closeItem = (when: string): string =>
  ["- name: closeItem", "  entity: item", "  kind: update", "  set:", "    kind: beta", `  when: ${when}`].join("\n");
const CLOSE = "action:item.closeItem";
const RATE = "computation:rate";

/** 段を 1 回流す（記録した応答で） */
async function runWith(calls: readonly RecordedCall[], mismatches: readonly string[] = ["r3-when", "r4-rate"]) {
  const recording = createRecordingClient(calls);
  const outcome = await runFieldRepair({
    source: SOURCE,
    list: LIST,
    suite: SUITE,
    declaration: FIXTURE_YAML,
    failures: locateFailures(locateInput(mismatches)),
    documents: FIXTURE_DOCUMENTS,
    gateway: makeGateway(recording.client),
  });
  return { outcome, recording };
}

/** 要求の schema の場所の enum */
const enumOf = (schema: unknown): unknown =>
  (schema as { properties: { replacements: { items: { properties: { location: { enum: unknown } } } } } }).properties.replacements.items.properties.location.enum;

/** データの塊の名前の並び */
const dataNamesOf = (input: string): readonly string[] => [...input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1] ?? "");
const dataBlockOf = (input: string, name: string): string => {
  const match = new RegExp(`<data name="${name}">\\n([\\s\\S]*?)\\n</data>`).exec(input);
  if (match === null) throw new Error(`データの塊が無い: ${name}`);
  return match[1] ?? "";
};

describe("schema と規則", () => {
  it("応答の schema は strict で、場所は往復の場所だけの enum。規則は why・since があり ruleDefinitionDefects で不備 0", () => {
    const schema = fieldRepairSchemaOf([CLOSE, RATE]);
    expect(strictSchemaProblems(schema)).toEqual([]);
    expect(Object.keys(schema["properties"] as object)).toEqual(["replacements", "disputes"]);
    const items = (schema as { properties: { replacements: { items: { properties: { location: { enum: string[] } } } } } }).properties.replacements.items;
    expect(items.properties.location.enum).toEqual([CLOSE, RATE]);
    expect(ruleDefinitionDefects(FIELD_REPAIR_RULE_DEFINITIONS)).toEqual([]);
    // 試験・要件・名前の表・網羅の単位の欄は持たない
    for (const word of ["tests", "requirements", "table", "coverage", "declaration"]) expect(JSON.stringify(schema)).not.toContain(`"${word}"`);
    // この段の名前はどちらの封筒にも無い
    expect(envelopeStageFor(FIELD_REPAIR_SCHEMA_NAME, "v1")).toBeUndefined();
    expect(envelopeStageFor(FIELD_REPAIR_SCHEMA_NAME, "v1.1a")).toBeUndefined();
  });
});

describe("(1) 要求：場所の enum はこの往復の失敗の場所とちょうど同じ集合。データに前の版の失敗・会話が無い", () => {
  it("場所の集合が違う 2 往復で、要求の enum もそれぞれ違う。データは宣言・失敗の一覧・固定した試験・要件の一覧だけ", async () => {
    const answer = { replacements: [{ location: CLOSE, element: closeItem("amount > 1") }], disputes: [] };
    const both = await runWith([structured(answer)]);
    const one = await runWith([structured(answer)], ["r3-when"]);
    const [first] = both.recording.structured;
    const [second] = one.recording.structured;
    if (first === undefined || second === undefined) throw new Error("前提が壊れた：要求が無い");
    expect(new Set(enumOf(first.schema) as string[])).toEqual(new Set(locateFailures(locateInput(["r3-when", "r4-rate"])).locations));
    expect(enumOf(first.schema)).toEqual([CLOSE, RATE]);
    expect(enumOf(second.schema)).toEqual([CLOSE]);
    expect(first.schemaName).toBe(FIELD_REPAIR_SCHEMA_NAME);
    expect(dataNamesOf(first.input)).toEqual([...FIELD_REPAIR_DATA_NAMES]);
    expect(dataBlockOf(first.input, "宣言")).toBe(FIXTURE_YAML);
    expect(JSON.parse(dataBlockOf(first.input, "失敗の一覧"))).toEqual([
      { testId: "r3-when", requirementId: "R3", kind: "test-mismatch", message: "固定した試験の期待と宣言の振る舞いが一致しない", locations: [CLOSE] },
      { testId: "r4-rate", requirementId: "R4", kind: "test-mismatch", message: "固定した試験の期待と宣言の振る舞いが一致しない", locations: [RATE] },
    ]);
    // 原文・試験の結果・対応表の落ち・前の版・会話（前回の応答・形の問題）の塊を載せない
    for (const name of ["原文", "試験の結果", "対応表の落ち", "静的チェックの結果", "前回の応答", SHAPE_PROBLEMS_DATA_NAME]) {
      expect(first.input).not.toContain(`<data name="${name}">`);
    }
    expect(first.rules).toEqual(FIELD_REPAIR_RULE_DEFINITIONS.map((definition) => definition.text));
    expect(both.recording.tools).toEqual([]);
    expect(both.outcome).toEqual({ ok: true, value: { replacements: answer.replacements, disputes: [], rejected: [] } });
  });

  it("場所なしが残る・場所が 0 の失敗では呼ばない（前提の誤りとして投げる）", async () => {
    const recording = createRecordingClient([]);
    const call = (mismatches: readonly string[]) =>
      runFieldRepair({
        source: SOURCE,
        list: LIST,
        suite: { tests: [...SUITE.tests, test("x", "R1", "entity", "e.item", "validate")] },
        declaration: FIXTURE_YAML,
        failures: locateFailures({ ...locateInput(mismatches), suite: { tests: [...SUITE.tests, test("x", "R1", "entity", "e.item", "validate")] } }),
        documents: FIXTURE_DOCUMENTS,
        gateway: makeGateway(recording.client),
      });
    await expect(call(["r3-when", "x"])).rejects.toThrow();
    await expect(call([])).rejects.toThrow();
    expect(recording.structured).toEqual([]);
  });
});

describe("(2) 形の検査：固定文で落とし、1 回だけ直させ、続けば malformed", () => {
  const good = { replacements: [{ location: CLOSE, element: closeItem("amount > 1") }], disputes: [] };
  const bad: readonly (readonly [string, unknown, string, string])[] = [
    ["選択肢の外の場所", { replacements: [{ location: "computation:byKind", element: "- name: byKind" }], disputes: [] }, "replacements[0].location", FIELD_REPAIR_PROBLEMS.outsideChoices],
    [
      "同じ場所が 2 回",
      { replacements: [{ location: CLOSE, element: closeItem("amount > 1") }, { location: CLOSE, element: closeItem("amount > 2") }], disputes: [] },
      "replacements[1].location",
      FIELD_REPAIR_PROBLEMS.duplicate,
    ],
    ["名前を変えた要素", { replacements: [{ location: CLOSE, element: closeItem("amount > 1").replace("closeItem", "shutItem") }], disputes: [] }, "replacements[0].element", FIELD_REPAIR_PROBLEMS.wrongName],
    ["所属 entity を変えた要素", { replacements: [{ location: CLOSE, element: closeItem("amount > 1").replace("entity: item", "entity: member") }], disputes: [] }, "replacements[0].element", FIELD_REPAIR_PROBLEMS.wrongName],
    ["種類の違う要素（項目の形）", { replacements: [{ location: CLOSE, element: "closeItem:\n  type: string" }], disputes: [] }, "replacements[0].element", FIELD_REPAIR_PROBLEMS.wrongKind],
    ["読めない本文", { replacements: [{ location: CLOSE, element: "- name: closeItem\n  when: &x" }], disputes: [] }, "replacements[0].element", FIELD_REPAIR_PROBLEMS.unreadable],
    ["空の本文", { replacements: [{ location: CLOSE, element: "  " }], disputes: [] }, "replacements[0].element", FIELD_REPAIR_PROBLEMS.emptyElement],
    ["試験の欄を足した応答", { ...good, tests: [] }, "tests", FIELD_REPAIR_PROBLEMS.extraKey],
    ["要件の欄を足した応答", { ...good, requirements: [] }, "requirements", FIELD_REPAIR_PROBLEMS.extraKey],
    ["置き換えに欄を足した応答", { replacements: [{ ...good.replacements[0], table: [] }], disputes: [] }, "replacements[0].table", FIELD_REPAIR_PROBLEMS.replacementExtraKey],
  ];

  it.each(bad)("%s は固定文で落ち、2 回目の要求に問題（欄と固定文）だけが足され、直れば受ける", async (_name, response, field, message) => {
    const { outcome, recording } = await runWith([structured(response), structured(good)]);
    expect(outcome.ok).toBe(true);
    const [first, second] = recording.structured;
    if (first === undefined || second === undefined) throw new Error("前提が壊れた：要求が 2 つ無い");
    const problems = JSON.parse(dataBlockOf(second.input, SHAPE_PROBLEMS_DATA_NAME)) as { field: string; message: string }[];
    expect(problems).toContainEqual({ field, message });
    // 問題の文は固定文（値を埋めない）
    for (const problem of problems) expect(Object.values(FIELD_REPAIR_PROBLEMS) as string[]).toContain(problem.message);
    // 前置きと schema は 1 文字も変えない（場所の選択肢を広げない）
    expect(second.schema).toEqual(first.schema);
    expect(second.rules).toEqual(first.rules);
    expect(second.input.startsWith(first.input)).toBe(true);
  });

  it.each(bad)("%s が 2 回続けば malformed（3 回目を呼ばない）", async (_name, response) => {
    const { outcome, recording } = await runWith([structured(response), structured(response), structured(good)]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    expect(recording.structured).toHaveLength(2);
  });

  it("項目の場所は、項目の名前の行から始まる本文を受ける", () => {
    const read = declarationSpans(FIXTURE_YAML);
    if (!read.ok) throw new Error("前提が壊れた");
    const context = { locations: ["field:item.amount"], spans: read.spans, source: SOURCE, testIds: new Set<string>() };
    expect(checkFieldRepairAnswer({ replacements: [{ location: "field:item.amount", element: "amount:\n  type: number" }], disputes: [] }, context).ok).toBe(true);
    const renamed = checkFieldRepairAnswer({ replacements: [{ location: "field:item.amount", element: "price:\n  type: number" }], disputes: [] }, context);
    expect(renamed).toEqual({ ok: false, problems: [{ field: "replacements[0].element", message: FIELD_REPAIR_PROBLEMS.wrongName }] });
    const item = checkFieldRepairAnswer({ replacements: [{ location: "field:item.amount", element: "- name: amount" }], disputes: [] }, context);
    expect(item).toEqual({ ok: false, problems: [{ field: "replacements[0].element", message: FIELD_REPAIR_PROBLEMS.wrongKind }] });
  });
});

describe("(3) 主張：v1 の直す段と同じ検査", () => {
  it("引用が原文に無い主張・一覧に無い試験の主張は受けず、原文に在る引用の主張だけを受ける", async () => {
    const quote = LIST.requirements[2]?.text.slice(0, 6) ?? "";
    const { outcome } = await runWith([
      structured({
        replacements: [],
        disputes: [
          { testId: "r3-when", quote },
          { testId: "r4-rate", quote: "原文に無い引用" },
          { testId: "x-unknown", quote },
        ],
      }),
    ]);
    if (!outcome.ok) throw new Error("前提が壊れた：段が落ちた");
    expect(outcome.value.disputes).toEqual([{ testId: "r3-when", quote }]);
    expect(outcome.value.rejected.map((entry) => entry.testId)).toEqual(["r4-rate", "x-unknown"]);
  });
});

/** 宣言の読み取りの値 */
const valuesOf = (source: string): Record<string, unknown> => {
  const document = readSpecDocument(source);
  if (!document.ok) throw new Error("前提が壊れた：読めない");
  return document.document as Record<string, unknown>;
};

describe("マージ（コード）：置き換えた要素だけが変わり、外の値は一番良い版と深く等しい", () => {
  const read = declarationSpans(FIXTURE_YAML);
  if (!read.ok) throw new Error("前提が壊れた");
  const spans = read.spans;

  it("置き換えた要素だけが変わり、ほかの値（ほかの操作・計算・項目・権限）は一番良い版と深く等しい。字下げは要素の最初の行にそろう", () => {
    const merged = mergeReplacements(
      FIXTURE_YAML,
      [
        { location: CLOSE, element: closeItem("amount > 1") },
        { location: "field:item.amount", element: "amount:\n  type: number\n  label: 金額" },
      ],
      spans,
    );
    if (!merged.ok) throw new Error(`断られた: ${merged.refusal}`);
    expect(merged.source).toBe(
      FIXTURE_YAML.replace("    when: amount > 0", "    when: amount > 1").replace("      amount:\n        type: number\n", "      amount:\n        type: number\n        label: 金額\n"),
    );
    const before = valuesOf(FIXTURE_YAML);
    const after = valuesOf(merged.source);
    for (const key of ["computed", "views", "validations", "permissions", "minIdentity"]) expect(canonicalJson(after[key])).toBe(canonicalJson(before[key]));
    expect((after["actions"] as unknown[])[0]).toEqual((before["actions"] as unknown[])[0]);
  });

  it("負例：別の要素に触れる置き換え（本文が隣の項目まで書く・要素を増やす）は固定文で断る", () => {
    const spill = mergeReplacements(FIXTURE_YAML, [{ location: "field:item.amount", element: "amount:\n  type: number\nday:\n  type: string" }], spans);
    expect(spill).toEqual({ ok: false, refusal: MERGE_REFUSALS.outside });
    const extra = mergeReplacements(FIXTURE_YAML, [{ location: CLOSE, element: `${closeItem("amount > 0")}\n- name: other\n  entity: item` }], spans);
    expect(extra).toEqual({ ok: false, refusal: MERGE_REFUSALS.outside });
    const unknown = mergeReplacements(FIXTURE_YAML, [{ location: "action:item.none", element: closeItem("amount > 0") }], spans);
    expect(unknown).toEqual({ ok: false, refusal: MERGE_REFUSALS.unknownLocation });
    const unreadable = mergeReplacements(FIXTURE_YAML, [{ location: CLOSE, element: "- name: closeItem\n  when: &x" }], spans);
    expect(unreadable).toEqual({ ok: false, refusal: MERGE_REFUSALS.unreadable });
  });

  it("負例：上限（declarationBytes）を超える版は断る", () => {
    const comment = `  # ${"x".repeat(AGENT_LIMITS.declarationBytes)}`;
    const huge = mergeReplacements(FIXTURE_YAML, [{ location: CLOSE, element: `${closeItem("amount > 1")}\n${comment}` }], spans);
    expect(huge).toEqual({ ok: false, refusal: MERGE_REFUSALS.bytes });
  });

  it("同じ置き換えは同じ原文になる（決定的）", () => {
    const replacements = [{ location: RATE, element: "- name: rate\n  scope: app\n  expression: base * 3\n  type: number" }];
    expect(mergeReplacements(FIXTURE_YAML, replacements, spans)).toEqual(mergeReplacements(FIXTURE_YAML, replacements, spans));
  });
});
