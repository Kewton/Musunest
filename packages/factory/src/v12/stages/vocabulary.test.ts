// C1 語彙の試験（Issue #593）。偽物の LLM（照合ありの記録）と固定の時計で回す。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { ruleDefinitionDefects, type Problem } from "../../stages/prompt.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import {
  FIXTURE_DOCUMENTS,
  createCheckedRecordingClient,
  fixtureList,
  fixtureTable,
  idsResponsesOf,
  negative,
  planOf,
  recordedStructured,
  strictDefects,
  withAggregates,
  withCodeIds,
} from "../../v11a/__tests__/fixtures.js";
import type { NameTableRow } from "../../v11a/names.js";
import { ID_MESSAGES, VOCABULARY_BUNDLES, type ReferenceCounts, type VocabularyBundle } from "../ids.js";
import { PROPERTY_LEDGER_VIEW, type UpstreamLedgerView } from "../ledger.js";
import {
  VOCABULARY_AGGREGATE_RULE,
  VOCABULARY_RULE_DEFINITIONS,
  VOCABULARY_SCHEMA_NAMES,
  assembleVocabularyBundle,
  runVocabularyBundle,
  vocabularyRuleDefinitionsOf,
  vocabularySchemaOf,
  type VocabularyBundleInput,
} from "./vocabulary.js";

const LIST = fixtureList();
const PLAN = planOf(LIST);
const TABLE = withCodeIds(fixtureTable());
const GOOD = idsResponsesOf(LIST, TABLE);
const ZERO: ReferenceCounts = { checked: 0, unknown: 0, duplicate: 0, crossBundle: 0 };

const rowsBefore = (bundle: VocabularyBundle): readonly NameTableRow[] => {
  const kinds = bundle === "entities" ? [] : bundle === "fields" ? ["entity"] : ["entity", "field"];
  return TABLE.rows.filter((row) => kinds.includes(row.kind));
};

async function runBundle(bundle: VocabularyBundle, outputs: readonly unknown[], rows = rowsBefore(bundle)) {
  const recording = createCheckedRecordingClient(outputs.map(recordedStructured));
  const outcome = await runVocabularyBundle({
    bundle,
    plan: PLAN,
    list: LIST,
    documents: FIXTURE_DOCUMENTS,
    gateway: makeGateway(recording.client),
    rows,
  });
  return { outcome, recording };
}

const messagesOf = (outcome: Awaited<ReturnType<typeof runVocabularyBundle>>): readonly string[] =>
  outcome.ok || outcome.failure.kind !== "unmet" ? [] : outcome.failure.problems.map((problem: Problem) => problem.message);

describe("C1 の規則と schema", () => {
  it("束ごとの規則の定義に why・since があり不備 0。束 3 は台帳が集計の種類を持つ走りだけ R-voc-07 を足す", () => {
    for (const bundle of VOCABULARY_BUNDLES) {
      expect(ruleDefinitionDefects(VOCABULARY_RULE_DEFINITIONS[bundle])).toEqual([]);
      expect(ruleDefinitionDefects(vocabularyRuleDefinitionsOf(bundle, PROPERTY_LEDGER_VIEW))).toEqual([]);
    }
    expect(vocabularyRuleDefinitionsOf("behaviors", PROPERTY_LEDGER_VIEW).at(-1)).toBe(VOCABULARY_AGGREGATE_RULE);
    expect(vocabularyRuleDefinitionsOf("behaviors")).toBe(VOCABULARY_RULE_DEFINITIONS.behaviors);
  });

  it("3 束の schema は strict の規則を満たし、写しの欄（copy）と出典・引用の欄（source・quote）が無い", () => {
    for (const bundle of VOCABULARY_BUNDLES) {
      for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
        const schema = vocabularySchemaOf(bundle, ledger);
        expect(strictDefects(schema), bundle).toEqual([]);
        const text = JSON.stringify(schema);
        for (const key of ['"copy"', '"source"', '"quote"']) expect(text.includes(key), `${bundle} ${key}`).toBe(false);
      }
    }
    // 静的：同じ入力から同じ schema（走りごとに変わらない）
    expect(vocabularySchemaOf("behaviors", PROPERTY_LEDGER_VIEW)).toEqual(vocabularySchemaOf("behaviors", PROPERTY_LEDGER_VIEW));
    expect(Object.values(VOCABULARY_SCHEMA_NAMES)).toEqual(["vocabulary-entities", "vocabulary-fields", "vocabulary-behaviors"]);
  });
});

describe("C1 の正例：fixture の表と同じ内容を 3 束の応答で渡す", () => {
  it("3 束とも問題 0・参照の照合の数は知らない ID・重複・別の束の ID が 0。組み上げた行は fixture の行と ID と出典を除いて等しい", async () => {
    let rows: readonly NameTableRow[] = [];
    const requests: unknown[] = [];
    for (const bundle of VOCABULARY_BUNDLES) {
      const { outcome, recording } = await runBundle(bundle, [GOOD[bundle]], rows);
      requests.push(...recording.structured);
      expect(outcome.ok, bundle).toBe(true);
      if (!outcome.ok) return;
      expect({ ...outcome.references, checked: 0 }).toEqual(ZERO);
      rows = outcome.rows;
    }
    expect(rows).toEqual(TABLE.rows);
    // 元の fixture の行と、ID・出典（と ID を指す欄）を除いて同じ
    const strip = (row: NameTableRow) => ({ kind: row.kind, name: row.name, role: row.role, options: row.options });
    const kinds = ["entity", "field", "computation", "operation", "screen"];
    const original = kinds.flatMap((kind) => fixtureTable().rows.filter((row) => row.kind === kind));
    expect(rows.map(strip)).toEqual(original.map(strip));
    expect(rows.every((row) => (row.source as unknown) === null)).toBe(true);
    // 要求に写しの欄・出典の引用の欄が無く、受入の題材の言葉も無い
    const text = JSON.stringify(requests);
    expect(text.includes('\\"copy\\"')).toBe(false);
    expect(text.includes("requestQuote")).toBe(false);
    expectNoAcceptanceMaterial([text]);
  });

  it("照らした参照の数は応答の ID の参照の全部（束 2：所属と参照先、束 3：所属・見出しの元）", async () => {
    const fields = await runBundle("fields", [GOOD.fields]);
    const expectedFields = TABLE.rows.filter((row) => row.kind === "field").reduce((total, row) => total + 1 + (row.refEntity === null ? 0 : 1), 0);
    expect(fields.outcome.references.checked).toBe(expectedFields);
    const behaviors = await runBundle("behaviors", [GOOD.behaviors]);
    const expectedBehaviors = TABLE.rows
      .filter((row) => ["computation", "operation", "screen"].includes(row.kind))
      .reduce((total, row) => total + (row.entity === null ? 0 : 1) + (row.groupBy === null ? 0 : 1), 0);
    expect(behaviors.outcome.references.checked).toBe(expectedBehaviors);
  });

  it("台帳が集計の種類を持つ走りは、束 3 の計算の aggregate（集計元は E の ID）を受ける", async () => {
    const table = withCodeIds(withAggregates(fixtureTable()));
    const responses = idsResponsesOf(LIST, table, PROPERTY_LEDGER_VIEW);
    const recording = createCheckedRecordingClient([recordedStructured(responses.behaviors)]);
    const outcome = await runVocabularyBundle({
      bundle: "behaviors",
      plan: PLAN,
      list: LIST,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client),
      rows: table.rows.filter((row) => row.kind === "entity" || row.kind === "field"),
      ledger: PROPERTY_LEDGER_VIEW,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.rows).toEqual(table.rows);
  });
});

/** 束の応答の 1 件を差し替える */
function withItem(response: Record<string, unknown>, key: string, index: number, patch: Record<string, unknown>): Record<string, unknown> {
  const items = (response[key] as readonly Record<string, unknown>[]).map((item, at) => (at === index ? { ...item, ...patch } : item));
  return { ...response, [key]: items };
}

describe("C1' の負例：固定文で落ち、その束だけが形のやり直しで 1 回作り直され、2 回で unmet", () => {
  const cases: readonly {
    readonly label: string;
    readonly bundle: VocabularyBundle;
    readonly bad: Record<string, unknown>;
    readonly message: string;
    readonly count?: keyof ReferenceCounts;
  }[] = [
    { label: "知らない ID（束 1 に無い E）", bundle: "fields", bad: withItem(GOOD.fields, "fields", 0, { entity: "E9" }), message: ID_MESSAGES.unknown, count: "unknown" },
    { label: "別の束の ID（束 2 の entity に F の形の ID）", bundle: "fields", bad: withItem(GOOD.fields, "fields", 0, { entity: "E1.F1" }), message: ID_MESSAGES.crossBundle, count: "crossBundle" },
    { label: "別の束の ID（束 2 の entity に C の形の ID）", bundle: "fields", bad: withItem(GOOD.fields, "fields", 0, { entity: "C1" }), message: ID_MESSAGES.crossBundle, count: "crossBundle" },
    { label: "別の束の ID（束 3 の計算の所属に V の形の ID）", bundle: "behaviors", bad: withItem(GOOD.behaviors, "computations", 0, { entity: "V1" }), message: ID_MESSAGES.crossBundle, count: "crossBundle" },
    {
      label: "重複（同じ束の中で同じ場所を指す行を 2 回）",
      bundle: "entities",
      bad: { entities: [...(GOOD.entities["entities"] as unknown[]), (GOOD.entities["entities"] as unknown[])[0]] },
      message: "同じ場所（種類・entity・名前）を指す ID が 2 つある（別名は書けない）",
      count: "duplicate",
    },
    { label: "entity でない行を参照先に（束 3 の見出しの元に E）", bundle: "behaviors", bad: withItem(GOOD.behaviors, "computations", 2, { groupBy: { kind: "enum", field: "E2" } }), message: ID_MESSAGES.wrongKind },
    { label: "entity でない行を所属に（束 3 の操作の所属に項目の ID）", bundle: "behaviors", bad: withItem(GOOD.behaviors, "operations", 0, { entity: "E2.F1" }), message: ID_MESSAGES.wrongKind },
    { label: "enum でない項目の options", bundle: "fields", bad: withItem(GOOD.fields, "fields", 0, { options: ["x", "y"] }), message: "options を持てるのは選択肢（enum）の項目だけである" },
    { label: "名前の規則違反", bundle: "entities", bad: withItem(GOOD.entities, "entities", 0, { name: "1member" }), message: "名前が規則（英字で始まる英数字）に合わない" },
  ];

  it.each(cases)("$label", async ({ bundle, bad, message, count }) => {
    const twice = await runBundle(bundle, [bad, bad]);
    expect(twice.recording.structured).toHaveLength(2);
    expect(twice.outcome.ok).toBe(false);
    if (twice.outcome.ok) return;
    expect(twice.outcome.failure.kind).toBe("unmet");
    expect(messagesOf(twice.outcome)).toContain(message);
    if (count !== undefined) expect(twice.outcome.references[count]).toBeGreaterThanOrEqual(1);
    // 2 回目の要求は前回の応答と問題をデータで持つ（前置き・schema は同じ）
    const [first, second] = twice.recording.structured;
    expect(second?.schema).toEqual(first?.schema);
    expect(second?.input.startsWith(first?.input ?? "")).toBe(true);
    expect(second?.input).toContain(message);
    // 1 回の作り直しで直れば通る
    const fixed = await runBundle(bundle, [bad, GOOD[bundle]]);
    expect(fixed.outcome.ok).toBe(true);
    expect(fixed.recording.structured).toHaveLength(2);
  });

  it("写し由来の固定文（長さ・一覧に無い写し・引用が原文に無い）は C1' の落ちに出ない", async () => {
    const copyMessages = [
      "要件の文の写しが指示した長さと合わない",
      "出典の要件の文の写しが一覧のどの要件とも合わない",
      "出典の引用が、写しが指す要件の原文に無い",
    ];
    for (const { bundle, bad } of cases) {
      const { outcome } = await runBundle(bundle, [bad, bad]);
      for (const message of messagesOf(outcome)) expect(copyMessages).not.toContain(message);
    }
  });

  it("骨組みの形の落ちが 2 回続けば malformed（今の窓口と同じ）", async () => {
    const broken = negative({ entities: "x" }, "entities が並びでない応答。strict の schema では出ないが、骨組みの形の負例");
    const recording = createCheckedRecordingClient([recordedStructured(broken), recordedStructured(broken)]);
    const outcome = await runVocabularyBundle({ bundle: "entities", plan: PLAN, list: LIST, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(recording.client), rows: [] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("malformed");
  });
});

// ── 上流の台帳の見方で受ける（読み漏れの検出。Issue #712）──────────────

/** 2 つの型が互いに代入できる（同じ型）なら true */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("読み漏れの検出：C1・C1' は台帳を上流の見方で受ける（Issue #712）", () => {
  it("規則・schema・組立て・段の入力の台帳の型が上流の見方で、一覧の外の欄（T2 系の文・生の行）を読めない", () => {
    const same: readonly true[] = [
      true satisfies SameType<NonNullable<Parameters<typeof vocabularyRuleDefinitionsOf>[1]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<Parameters<typeof vocabularySchemaOf>[1]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<Parameters<typeof assembleVocabularyBundle>[4]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<VocabularyBundleInput["ledger"]>, UpstreamLedgerView>,
    ];
    const ledger: NonNullable<VocabularyBundleInput["ledger"]> = PROPERTY_LEDGER_VIEW;
    // @ts-expect-error C1 の段の台帳は T2 の規則の文を持たない
    void ledger.t2FormTexts;
    // @ts-expect-error C1 の段の台帳は生の行を持たない
    void ledger.rows;
    expect(same).toHaveLength(4);
    expect(ledger.aggregateKinds).toEqual(PROPERTY_LEDGER_VIEW.aggregateKinds);
  });
});
