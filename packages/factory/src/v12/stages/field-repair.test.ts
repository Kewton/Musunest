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
import { FIXTURE_DOCUMENTS, FIXTURE_YAML, fixtureList, fixtureTable, fixtureYaml } from "../../v11a/__tests__/fixtures.js";
import { requiredValidationsOf } from "../../v11a/bind-by-id.js";
import { canonicalJson } from "../../v11a/names.js";
import type { TestObserves } from "../../v11a/stages/test-spec.js";
import { expectNoAcceptanceMaterial } from "../../stages/__tests__/prompt.js";
import { declarationSpans, buildRepairDiagnostic, locateFailures, type LocateInput, type RepairDiagnostic } from "../locate.js";
import {
  FIELD_REPAIR_DATA_NAMES,
  FIELD_REPAIR_DIAGNOSTIC_DATA_NAME,
  FIELD_REPAIR_IDS_DIAGNOSTIC_RULE_DEFINITIONS,
  FIELD_REPAIR_IDS_R07_DEFINITION,
  FIELD_REPAIR_IDS_R08_DEFINITION,
  FIELD_REPAIR_IDS_RULE_DEFINITIONS,
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

// ── 旗 v12.ids：追加の場所（手 4e。Issue #667）──────────────────────────────────────

describe("旗 v12.ids の欄だけの直し：追加の場所を enum とデータに載せ、形を照らし、コードが validations の末尾に挿し込む（Issue #667）", () => {
  /** 検査の節を空にした宣言（`validations: []`） */
  const EMPTY_YAML = fixtureYaml({ validation: false });
  /** 検査の節そのものが無い宣言 */
  const NO_SECTION_YAML = EMPTY_YAML.replace("validations: []\n", "");
  const AMOUNT = "validation:item.amount";
  const ITEM = "validation:item.item";
  const validationBody = (name: string, expression: string, extra: readonly string[] = []): string =>
    [`- name: ${name}`, "  entity: item", `  expression: ${expression}`, ...extra].join("\n");
  const vtest = (id: string, roleId: string, kind = "field", testKind = "normal"): FixedTest =>
    ({ ...test(id, "R1", kind, roleId, "validate"), kind: testKind }) as FixedTest;
  const IDS_SUITE: TestSuite = {
    tests: [vtest("v-normal", "f.item.amount"), vtest("v-abnormal", "f.item.amount", "field", "abnormal"), vtest("v-entity", "e.item", "entity"), ...SUITE.tests],
  };
  const OBSERVES = new Map<string, TestObserves>([
    ["v-normal", "validation"],
    ["v-abnormal", "validation"],
    ["v-entity", "validation"],
    ["r3-when", "when"],
    ["r4-rate", "value"],
  ]);
  const idsLocate = (source: string, mismatches: readonly string[]) =>
    locateFailures({
      ...locateInput(mismatches),
      source,
      suite: IDS_SUITE,
      ids: { observes: OBSERVES, requiredValidations: requiredValidationsOf(TABLE, IDS_SUITE, OBSERVES) },
    });
  const runIds = async (calls: readonly RecordedCall[], source: string, mismatches: readonly string[]) => {
    const recording = createRecordingClient(calls);
    const failures = idsLocate(source, mismatches);
    const outcome = await runFieldRepair({
      source: SOURCE,
      list: LIST,
      suite: IDS_SUITE,
      declaration: source,
      failures,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
    });
    return { outcome, recording, failures };
  };

  it("schema の enum に追加の場所があり、データの各場所に種類（replace・add）。規則は off の 6 つの後ろに R-fr-07（why・since。不備 0）", async () => {
    const answer = {
      replacements: [
        { location: AMOUNT, element: validationBody("amount", "amount > 0") },
        { location: CLOSE, element: closeItem("amount > 0") },
      ],
      disputes: [],
    };
    const { outcome, recording, failures } = await runIds([structured(answer)], EMPTY_YAML, ["v-normal", "v-abnormal", "r3-when"]);
    expect(outcome).toEqual({ ok: true, value: { replacements: answer.replacements, disputes: [], rejected: [] } });
    expect(failures.additions).toEqual([{ key: AMOUNT, entity: "item", name: "amount" }]);
    const [request] = recording.structured;
    if (request === undefined) throw new Error("前提が壊れた：要求が無い");
    expect(enumOf(request.schema)).toEqual([AMOUNT, CLOSE]);
    expect(request.schema).toEqual(fieldRepairSchemaOf([AMOUNT, CLOSE]));
    expect(dataNamesOf(request.input)).toEqual([...FIELD_REPAIR_DATA_NAMES]);
    expect(JSON.parse(dataBlockOf(request.input, "失敗の一覧"))).toEqual([
      { testId: "v-normal", requirementId: "R1", kind: "test-mismatch", message: "固定した試験の期待と宣言の振る舞いが一致しない", locations: [{ location: AMOUNT, kind: "add" }] },
      { testId: "v-abnormal", requirementId: "R1", kind: "test-mismatch", message: "固定した試験の期待と宣言の振る舞いが一致しない", locations: [{ location: AMOUNT, kind: "add" }] },
      { testId: "r3-when", requirementId: "R3", kind: "test-mismatch", message: "固定した試験の期待と宣言の振る舞いが一致しない", locations: [{ location: CLOSE, kind: "replace" }] },
    ]);
    expect(request.rules).toEqual(FIELD_REPAIR_IDS_RULE_DEFINITIONS.map((definition) => definition.text));
    expect(FIELD_REPAIR_IDS_RULE_DEFINITIONS).toEqual([...FIELD_REPAIR_RULE_DEFINITIONS, FIELD_REPAIR_IDS_R07_DEFINITION]);
    expect(FIELD_REPAIR_IDS_R07_DEFINITION.text).toBe(
      "追加の場所には、その entity と名前の検査 1 つの本文を `-` で始まる行から書く。名前と entity は変えない。式は要件と固定した試験から書く。別の要素を書かない。",
    );
    expect(ruleDefinitionDefects(FIELD_REPAIR_IDS_RULE_DEFINITIONS)).toEqual([]);
    expect(FIELD_REPAIR_RULE_DEFINITIONS.map((definition) => definition.id)).toEqual(["R-fr-01", "R-fr-02", "R-fr-03", "R-fr-04", "R-fr-05", "R-fr-06"]);
    // 欄だけの直しの入力に要る検査の骨組みの塊は載せない（失敗の一覧の追加の場所が同じ事実を持つ）
    expect(request.input).not.toContain("要る検査の骨組み");
    expectNoAcceptanceMaterial([request.input, ...(request.rules ?? [])]);
  });

  const good = { replacements: [{ location: AMOUNT, element: validationBody("amount", "amount > 0") }], disputes: [] };
  const badShapes: readonly (readonly [string, string, string, string])[] = [
    ["名前が場所と違う追加", AMOUNT, validationBody("positive", "amount > 0"), FIELD_REPAIR_PROBLEMS.wrongName],
    ["存在しない entity の名前を書いた追加", AMOUNT, validationBody("amount", "amount > 0").replace("entity: item", "entity: nowhere"), FIELD_REPAIR_PROBLEMS.wrongName],
    ["検査 2 つの追加", AMOUNT, `${validationBody("amount", "amount > 0")}\n${validationBody("other", "amount > 1")}`, FIELD_REPAIR_PROBLEMS.wrongKind],
    ["検査以外の要素（計算の欄）の追加", AMOUNT, validationBody("amount", "amount > 0", ["  type: number"]), FIELD_REPAIR_PROBLEMS.notValidation],
    ["項目の形の追加", AMOUNT, "amount:\n  type: number", FIELD_REPAIR_PROBLEMS.wrongKind],
  ];

  it.each(badShapes)("形の検査：%s は固定文で落ち、2 回目の要求に問題が足され、直れば受ける。続けば malformed", async (_name, location, element, message) => {
    const response = { replacements: [{ location, element }], disputes: [] };
    const fixed = await runIds([structured(response), structured(good)], EMPTY_YAML, ["v-normal"]);
    expect(fixed.outcome.ok).toBe(true);
    const [first, second] = fixed.recording.structured;
    if (first === undefined || second === undefined) throw new Error("前提が壊れた：要求が 2 つ無い");
    expect(JSON.parse(dataBlockOf(second.input, SHAPE_PROBLEMS_DATA_NAME))).toContainEqual({ field: "replacements[0].element", message });
    expect(second.schema).toEqual(first.schema);
    const twice = await runIds([structured(response), structured(response), structured(good)], EMPTY_YAML, ["v-normal"]);
    expect(twice.outcome.ok).toBe(false);
    if (!twice.outcome.ok) expect(twice.outcome.failure.kind).toBe("malformed");
    expect(twice.recording.structured).toHaveLength(2);
  });

  it("形の検査：旗 ids の走りの置換の場所（検査）に検査以外の要素 → 固定文で落とす。off の置換の場所は今のまま（検査の欄を照らさない）", async () => {
    const replaceGood = { replacements: [{ location: AMOUNT, element: validationBody("amount", "amount > 1") }], disputes: [] };
    const notValidation = { replacements: [{ location: AMOUNT, element: validationBody("amount", "amount > 1", ["  type: number"]) }], disputes: [] };
    const on = await runIds([structured(notValidation), structured(replaceGood)], FIXTURE_YAML, ["v-normal"]);
    expect(on.failures.additions).toEqual([]);
    const [, second] = on.recording.structured;
    if (second === undefined) throw new Error("前提が壊れた");
    expect(JSON.parse(dataBlockOf(second.input, SHAPE_PROBLEMS_DATA_NAME))).toEqual([{ field: "replacements[0].element", message: FIELD_REPAIR_PROBLEMS.notValidation }]);
    // off（additions が無い文脈）は今の形の検査のまま
    const read = declarationSpans(FIXTURE_YAML);
    if (!read.ok) throw new Error("前提が壊れた");
    expect(checkFieldRepairAnswer(notValidation, { locations: [AMOUNT], spans: read.spans, source: SOURCE, testIds: new Set() }).ok).toBe(true);
  });

  it("マージ：validations: [] の宣言は並びの形に直して末尾に挿し込み、外の値が深く等しく、検査の数が +1", () => {
    const failures = idsLocate(EMPTY_YAML, ["v-normal"]);
    const merged = mergeReplacements(EMPTY_YAML, [{ location: AMOUNT, element: validationBody("amount", "amount > 0") }], failures.spans, failures.additions);
    if (!merged.ok) throw new Error(`断られた: ${merged.refusal}`);
    expect(merged.source).toBe(EMPTY_YAML.replace("validations: []\n", "validations:\n  - name: amount\n    entity: item\n    expression: amount > 0\n"));
    expect(merged.source).toBe(FIXTURE_YAML);
    const before = valuesOf(EMPTY_YAML);
    const after = valuesOf(merged.source);
    expect(after["validations"]).toEqual([{ name: "amount", entity: "item", expression: "amount > 0" }]);
    expect(canonicalJson({ ...after, validations: [] })).toBe(canonicalJson(before));
    // (b) 2 回目の往復：同じ（entity・名前）は既に在るので置換の場所になり、追加が重複しない
    const second = idsLocate(merged.source, ["v-normal"]);
    expect(second.locations).toEqual([AMOUNT]);
    expect(second.additions).toEqual([]);
  });

  it("マージ：並びのある宣言は末尾に挿し込み、既存の検査と外の値が深く等しく、検査の数が +1。追加と置換の混在が 1 回で通る", () => {
    const failures = idsLocate(FIXTURE_YAML, ["v-entity", "v-normal", "r3-when"]);
    expect(failures.additions).toEqual([{ key: ITEM, entity: "item", name: "item" }]);
    expect(failures.locations).toEqual([ITEM, AMOUNT, CLOSE]);
    const merged = mergeReplacements(
      FIXTURE_YAML,
      [
        { location: ITEM, element: validationBody("item", "amount < 100") },
        { location: AMOUNT, element: validationBody("amount", "amount > 1") },
        { location: CLOSE, element: closeItem("amount > 1") },
      ],
      failures.spans,
      failures.additions,
    );
    if (!merged.ok) throw new Error(`断られた: ${merged.refusal}`);
    expect(merged.source).toBe(
      FIXTURE_YAML.replace("    when: amount > 0", "    when: amount > 1").replace(
        "    expression: amount > 0\n",
        "    expression: amount > 1\n  - name: item\n    entity: item\n    expression: amount < 100\n",
      ),
    );
    const after = valuesOf(merged.source);
    expect(after["validations"]).toEqual([
      { name: "amount", entity: "item", expression: "amount > 1" },
      { name: "item", entity: "item", expression: "amount < 100" },
    ]);
    const before = valuesOf(FIXTURE_YAML);
    for (const key of ["entities", "computed", "views", "permissions"]) expect(canonicalJson(after[key])).toBe(canonicalJson(before[key]));
  });

  it("負例（マージ）：節の無い宣言は固定文で断る。追加の本文が検査を増やす・別の要素の値を変える版は断る", () => {
    // 節の無い宣言には場所の段で追加の場所を作らない（場所なしのまま今までの経路へ。往復を消費しない）。それでも追加を渡せばマージが断る
    const none = idsLocate(NO_SECTION_YAML, ["v-normal"]);
    expect(none.additions).toEqual([]);
    expect(none.unlocated.map((failure) => failure.reason)).toEqual(["no-element"]);
    const addition = { key: AMOUNT, entity: "item", name: "amount" };
    expect(mergeReplacements(NO_SECTION_YAML, [{ location: AMOUNT, element: validationBody("amount", "amount > 0") }], none.spans, [addition])).toEqual({
      ok: false,
      refusal: MERGE_REFUSALS.noSection,
    });
    const empty = idsLocate(EMPTY_YAML, ["v-normal"]);
    // (c) 追加の本文に別の要素（2 つ目の検査）を含む → 検査の数が追加の数と合わず断る
    const two = `${validationBody("amount", "amount > 0")}\n${validationBody("other", "amount > 1")}`;
    expect(mergeReplacements(EMPTY_YAML, [{ location: AMOUNT, element: two }], empty.spans, empty.additions)).toEqual({ ok: false, refusal: MERGE_REFUSALS.added });
    // (c) 追加の本文が節の外（次の節の欄）まで書く → 外の値が違うので断る
    const spill = `${validationBody("amount", "amount > 0")}\npermissions: []`;
    const spilled = mergeReplacements(EMPTY_YAML, [{ location: AMOUNT, element: spill }], empty.spans, empty.additions);
    expect(spilled.ok).toBe(false);
    // 追加の場所に別の名前の検査を書いた本文（形の検査を経ずに渡した場合）も、その位置に無いので断る
    expect(mergeReplacements(EMPTY_YAML, [{ location: AMOUNT, element: validationBody("positive", "amount > 0") }], empty.spans, empty.additions)).toEqual({
      ok: false,
      refusal: MERGE_REFUSALS.added,
    });
    // off（additions を渡さない）は追加の場所を知らないので、今までどおり場所の無い置き換えとして断る
    expect(mergeReplacements(EMPTY_YAML, [{ location: AMOUNT, element: validationBody("amount", "amount > 0") }], empty.spans)).toEqual({
      ok: false,
      refusal: MERGE_REFUSALS.unknownLocation,
    });
  });
});

// ── 診断の塊と規則（旗 v12.ids と探索がともに on。Issue #761）──────────────────────────

describe("診断（Issue #761）：渡したときだけ既存の 4 つの塊の後に 1 つ増え、ids の規則の後ろに R-fr-08 が 1 つ増える", () => {
  const EMPTY_YAML = fixtureYaml({ validation: false });
  const vtest = (id: string, roleId: string): FixedTest => ({ ...test(id, "R1", "field", roleId, "validate") }) as FixedTest;
  const DIAGNOSTIC_SUITE: TestSuite = { tests: [vtest("v-normal", "f.item.amount"), ...SUITE.tests] };
  const DIAGNOSTIC_OBSERVES = new Map<string, TestObserves>([
    ["v-normal", "validation"],
    ["r3-when", "when"],
    ["r4-rate", "value"],
  ]);
  const failuresOf = () =>
    locateFailures({
      ...locateInput(["v-normal", "r3-when"]),
      source: EMPTY_YAML,
      suite: DIAGNOSTIC_SUITE,
      ids: { observes: DIAGNOSTIC_OBSERVES, requiredValidations: requiredValidationsOf(TABLE, DIAGNOSTIC_SUITE, DIAGNOSTIC_OBSERVES) },
    });
  const diagnosticOf = (): RepairDiagnostic =>
    buildRepairDiagnostic({
      table: TABLE,
      suite: DIAGNOSTIC_SUITE,
      observes: DIAGNOSTIC_OBSERVES,
      mismatches: [
        { testId: "v-normal", detail: "検査が落ちない（期待は落ちること）" },
        { testId: "r3-when", detail: "操作 closeItem が無い" },
      ],
      unresolved: [],
      correspondenceMisses: [],
      rejections: [],
      routes: [],
    });
  const requestOf = async (diagnostic?: RepairDiagnostic) => {
    const recording = createRecordingClient([structured({ replacements: [], disputes: [] })]);
    const outcome = await runFieldRepair({
      source: SOURCE,
      list: LIST,
      suite: DIAGNOSTIC_SUITE,
      declaration: EMPTY_YAML,
      failures: failuresOf(),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
    });
    expect(outcome.ok).toBe(true);
    const [request] = recording.structured;
    if (request === undefined) throw new Error("前提が壊れた：要求が無い");
    return request;
  };

  it("診断を省いた要求は今の 4 つの塊と ids の規則のまま。渡すと入力の末尾に塊が 1 つだけ増え、前置き・文書・schema は同じ", async () => {
    const plain = await requestOf();
    const diagnostic = diagnosticOf();
    const withDiagnostic = await requestOf(diagnostic);
    expect(dataNamesOf(plain.input)).toEqual([...FIELD_REPAIR_DATA_NAMES]);
    expect(dataNamesOf(withDiagnostic.input)).toEqual([...FIELD_REPAIR_DATA_NAMES, FIELD_REPAIR_DIAGNOSTIC_DATA_NAME]);
    // 塊は既存の 4 つの後ろ（末尾）に 1 つだけ
    const block = `<data name="${FIELD_REPAIR_DIAGNOSTIC_DATA_NAME}">\n${JSON.stringify(diagnostic, null, 2)}\n</data>`;
    expect(withDiagnostic.input).toBe(`${plain.input}\n${block}`);
    expect(JSON.parse(dataBlockOf(withDiagnostic.input, FIELD_REPAIR_DIAGNOSTIC_DATA_NAME))).toEqual(diagnostic);
    expect(withDiagnostic.instructions).toBe(plain.instructions);
    expect(withDiagnostic.documents).toEqual(plain.documents);
    expect(withDiagnostic.schema).toEqual(plain.schema);
    expect(withDiagnostic.maxOutputTokens).toBe(plain.maxOutputTokens);
  });

  it("規則は ids の 6+1 の後ろに R-fr-08 が 1 つ（文と順序は変えない）。id・why・since を持ち、不備 0", async () => {
    const plain = await requestOf();
    const withDiagnostic = await requestOf(diagnosticOf());
    expect(plain.rules).toEqual(FIELD_REPAIR_IDS_RULE_DEFINITIONS.map((definition) => definition.text));
    expect(withDiagnostic.rules).toEqual(FIELD_REPAIR_IDS_DIAGNOSTIC_RULE_DEFINITIONS.map((definition) => definition.text));
    expect(withDiagnostic.rules).toEqual([...FIELD_REPAIR_IDS_RULE_DEFINITIONS.map((definition) => definition.text), FIELD_REPAIR_IDS_R08_DEFINITION.text]);
    expect(FIELD_REPAIR_IDS_DIAGNOSTIC_RULE_DEFINITIONS).toEqual([...FIELD_REPAIR_IDS_RULE_DEFINITIONS, FIELD_REPAIR_IDS_R08_DEFINITION]);
    expect(FIELD_REPAIR_IDS_RULE_DEFINITIONS).toEqual([...FIELD_REPAIR_RULE_DEFINITIONS, FIELD_REPAIR_IDS_R07_DEFINITION]);
    expect(FIELD_REPAIR_IDS_R08_DEFINITION.id).toBe("R-fr-08");
    expect(FIELD_REPAIR_IDS_R08_DEFINITION.since).toBe("Issue #761");
    expect(FIELD_REPAIR_IDS_R08_DEFINITION.text).toBe(
      "データ「診断」は、今の一番良い版の失敗の説明である。書き換えの対象ではない。示された試験・名前の表・要件・観測する性質を変えない。",
    );
    expect(ruleDefinitionDefects(FIELD_REPAIR_IDS_DIAGNOSTIC_RULE_DEFINITIONS)).toEqual([]);
    expectNoAcceptanceMaterial([withDiagnostic.input, ...(withDiagnostic.rules ?? [])]);
  });
});
