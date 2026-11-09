// Issue #826：旗 `v12.ids` で、所属が条件の無い操作（とその entity の項目）だけの fixed-test の要件に試験の行き止まりを
// 残さない。
//
//   (1) 操作だけ：C2 の整える手 N-map-03 が structural（操作ごとの action-kind）にし、コードの検査 2 本で T2 が通る
//   (2) 項目つき：T2 のコードが項目 × screen の在ることの試験を作り、採った種類が existence-only のときだけ組に残す
//   (3) 採った種類の交差：表の分類ではなく採った種類（J2 の後）で決まる
//   (4) 負例：entity・画面・計算・条件つきの操作・別 entity の項目・項目だけ・fixed-test でない・重複や表に無い ID には当たらない
//   (5) 枠：対象の要件では初回の existence-only の枝だけが変わり、ruled の枝・codeTests・remaining は変わらない
//   (6) 門：fixed-test への構造の検査を LLM が書けば今までどおり落ちる
//   (7) 指紋：当たらない表は同じ表のまま（同じ参照を返す）
//   (8) C3 の拒否：N-map-03 で整えた操作だけの要件を、偽物の C3 が weak-verification で拒否し、持ち越しの出どころが
//       semantic-check になる
//
// 偽物の LLM・抽象的な ID だけを使う。外部の API は呼ばない。題材の言葉は書かない。
import { PLAN_SPEC_SCHEMA_VERSION, type ConfirmedPlan } from "@musunest/appspec-schema";
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../limits.js";
import type { RequirementList } from "../pipeline.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../stages/__tests__/prompt.js";
import { createCheckedRecordingClient, fixtureTable, recordedStructured, casesResponseOf, retainingT2Client, FIXTURE_DOCUMENTS } from "../v11a/__tests__/fixtures.js";
import { deriveCarryOver } from "../v11a/carry-over.js";
import type { Judge, JudgeAnswer } from "../judge.js";
import { IDS_NO_SOURCE, nameTableSha256, type NameTable, type NameTableRow, type NameTableVerification } from "../v11a/names.js";
import { runSemanticCheck, SEMANTIC_CHECK_SCHEMA_NAME } from "../v11a/stages/semantic-check.js";
import { runTestSpec } from "../v11a/stages/test-spec.js";
import {
  GENERATED_TEST_ID_PREFIX,
  WHENLESS_FIELD_SCREEN_ID_MARKER,
  checkGeneratedOverlap,
  generateTests,
  isWhenlessFieldScreenTestId,
} from "./generated-tests.js";
import { OWNERSHIP_STRUCTURE_NOT_ALLOWED, PROPERTY_LEDGER_VIEW } from "./ledger.js";
import {
  MAPPING_NORMALIZATION_DEFINITIONS,
  MAPPING_NORMALIZATION_OPERATION_REASON,
  inspectMappingSourced,
  normalizeMappedTable,
} from "./stages/mapping.js";
import { TEST_CASE_FRAME_TEXTS, initialTestCaseFramesOf } from "./test-cases.js";

const LEDGER = PROPERTY_LEDGER_VIEW;
const LIMIT = AGENT_LIMITS.testsPerRequirement;

const stated = (id: string) => ({ id, basis: "stated" as const, reason: null });

function requirement(id: string, text: string) {
  return { id, text, quote: text, position: { start: 0, end: text.length } };
}

function listOf(defs: readonly { readonly id: string; readonly text: string }[]): RequirementList {
  return { requirements: defs.map(({ id, text }) => requirement(id, text)), decisions: [], unresolved: [] };
}

function planOf(list: RequirementList): ConfirmedPlan {
  return {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-826",
    revision: 1,
    vocabulary_version: "v1",
    inputs: [{ id: "in-1", kind: "source", text: list.requirements.map((entry) => entry.text).join("") }],
    requirements: list.requirements.map((entry) => ({
      id: entry.id,
      text: entry.text,
      kind: "constraining" as const,
      origin: { input_id: "in-1", quote: entry.quote },
      parts: [{ id: `${entry.id}-p1`, text: entry.text, disposition: "met" as const }],
    })),
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-09-16T12:00:00+09:00", confirmed_by: "tester" },
  };
}

/** 表の行（抽象的な ID。出典なし） */
function rowOf(
  id: string,
  kind: NameTableRow["kind"],
  entity: string | null,
  type: NameTableRow["type"],
  extra: Partial<Pick<NameTableRow, "options" | "refEntity">> = {},
): NameTableRow {
  return { id, kind, entity, name: id, role: `${id} の役割`, source: IDS_NO_SOURCE, type, options: extra.options ?? null, groupBy: null, refEntity: extra.refEntity ?? null };
}

interface Spec {
  readonly id: string;
  readonly roles: readonly string[];
  readonly verification?: NameTableVerification;
  readonly nature?: "ruled" | "existence-only";
}

function tableOf(rows: readonly NameTableRow[], specs: readonly Spec[]): NameTable {
  return {
    rows,
    ownership: specs.map((spec) => ({ requirementId: spec.id, roles: spec.roles.map(stated) })),
    verification: specs.map((spec) => ({ ...(spec.verification ?? { kind: "fixed-test" as const }), requirementId: spec.id }) as NameTableVerification),
    classification: specs.map((spec) => ({ requirementId: spec.id, nature: spec.nature ?? "ruled" })),
  };
}

/** C2 の応答（fixed-test の要件だけ。所属は表のまま、残りの欄は null/空） */
function responseOf(specs: readonly Spec[]) {
  return {
    requirements: specs.map((spec) => ({
      requirementId: spec.id,
      roles: spec.roles.map(stated),
      verification: { kind: spec.verification?.kind ?? "fixed-test", value: null, reason: null, checks: null, constraintIds: [] },
      nature: spec.nature ?? "ruled",
    })),
  };
}

// ── (1) 操作だけ ─────────────────────────────────────────────────────────

describe("(1) 操作だけ：N-map-03 が操作ごとの action-kind の構造の検査にする（Issue #826）", () => {
  const OPS = [rowOf("OP1", "operation", null, { action: "create", hasWhen: false }), rowOf("OP2", "operation", null, { action: "update", hasWhen: false })];
  const SPECS: readonly Spec[] = [{ id: "R1", roles: ["OP1", "OP2"] }];
  const LIST = listOf([{ id: "R1", text: "二つの操作ができる。" }]);

  it("整える前（base）は fixed-test のままでコードの試験が 0 本（試験の行き止まり。直す前の挙動として残す）", () => {
    const raw = tableOf(OPS, SPECS);
    const made = generateTests({ table: raw, ledger: LEDGER, list: LIST });
    expect(made.tests.filter((test) => test.target.requirementId === "R1")).toEqual([]);
    expect(made.existenceOnlyTestIds.size).toBe(0);
  });

  it("N-map-03：kind structural・checks は所属の順の action-kind 2 件・targets は各操作（sourceId null）・reason は固定文。所属と分類は変えない。記録に N-map-03 が載る", () => {
    const raw = tableOf(OPS, SPECS);
    const { table, normalized } = normalizeMappedTable(raw);
    expect(table.verification).toEqual([
      {
        requirementId: "R1",
        kind: "structural",
        reason: MAPPING_NORMALIZATION_OPERATION_REASON,
        checks: ["action-kind", "action-kind"],
        targets: [
          { check: "action-kind", targetId: "OP1", sourceId: null },
          { check: "action-kind", targetId: "OP2", sourceId: null },
        ],
      },
    ]);
    expect(table.ownership).toEqual(raw.ownership);
    expect(table.classification).toEqual(raw.classification);
    expect(normalized).toEqual([{ requirementId: "R1", rule: "N-map-03", targetId: null, removedRowIds: [] }]);
  });

  it("整えた表から generateTests はコードの検査 2 本を作り、T2 の要求から除く（T2 はコードの検査 2 本で通る）", () => {
    const { table } = normalizeMappedTable(tableOf(OPS, SPECS));
    const made = generateTests({ table, ledger: LEDGER, list: LIST });
    const tests = made.tests.filter((test) => test.target.requirementId === "R1");
    expect(tests.map((test) => [test.target.roleId, test.assertion])).toEqual([
      ["OP1", { check: "action-kind", expected: "create" }],
      ["OP2", { check: "action-kind", expected: "update" }],
    ]);
    expect(tests.every((test) => test.operation === "structure" && test.kind === "normal")).toBe(true);
    expect(made.excludedRequirementIds).toEqual(["R1"]);
    expect(made.stopped).toEqual([]);
  });

  it("手 3 の定義に why・since がある（LLM に送らない）", () => {
    const definition = MAPPING_NORMALIZATION_DEFINITIONS.find((entry) => entry.id === "N-map-03");
    expect(definition?.since).toBe("Issue #826");
    expect(definition?.why.trim()).not.toBe("");
    expectNoAcceptanceMaterial([definition?.text ?? "", definition?.why ?? "", MAPPING_NORMALIZATION_OPERATION_REASON]);
  });
});

// ── (2)(3)(5) 項目つき と 採った種類 ────────────────────────────────────

describe("(2)(3)(5) 項目つき：項目 × screen は採った種類が existence-only のときだけ残る（Issue #826）", () => {
  const baseRows = fixtureTable().rows;
  const roles = ["f.item.title", "f.item.amount", "o.addItem"];
  const TEXT = "金額と題名のある項目を登録できる。";
  const LIST = listOf([{ id: "R1", text: TEXT }]);
  function withWhenlessFields(): NameTable {
    return {
      rows: baseRows,
      ownership: [{ requirementId: "R1", roles: roles.map(stated) }],
      verification: [{ requirementId: "R1", kind: "fixed-test" }],
      classification: [{ requirementId: "R1", nature: "ruled" }],
    };
  }
  const table = withWhenlessFields();
  const generated = generateTests({ table, ledger: LEDGER, list: LIST });
  const conditional = generated.tests.filter((test) => generated.existenceOnlyTestIds.has(test.id));
  const frame = () => {
    const [found] = initialTestCaseFramesOf({ table, ledger: LEDGER, list: LIST, generated }, ["R1"]);
    if (found === undefined) throw new Error("前提が壊れた：枠が無い");
    return found;
  };

  it("(2) コードが項目ごとに 1 本作る（2 本）。#652 の試験と区別できる ID で、採った種類が existence-only のときだけ残す印を持つ", () => {
    expect(conditional.map((test) => [test.target.roleId, test.operation, test.kind])).toEqual([
      ["f.item.title", "screen", "normal"],
      ["f.item.amount", "screen", "normal"],
    ]);
    for (const test of conditional) {
      expect(test.id.startsWith(`${GENERATED_TEST_ID_PREFIX}${WHENLESS_FIELD_SCREEN_ID_MARKER}:R1:`)).toBe(true);
      expect(isWhenlessFieldScreenTestId(test.id)).toBe(true);
    }
    expect(generated.observes.get(conditional[0]?.id ?? "")).toBe("view-structure");
    // 項目だけの #652 の試験（この印を持たない）とは区別する
    const fieldOnly = { ...table, ownership: [{ requirementId: "R1", roles: ["f.item.title"].map(stated) }] };
    const made = generateTests({ table: fieldOnly, ledger: LEDGER, list: LIST });
    expect(made.tests.filter((test) => test.target.requirementId === "R1")).toHaveLength(1);
    expect(made.existenceOnlyTestIds.size).toBe(0);
  });

  it("(5) 初回の枠：existence-only の枝だけに条件つきの欄が付き、ruled の枝・codeTests・remaining は #813 のまま", () => {
    const found = frame();
    expect(found.codeTests).toEqual([]);
    expect(found.ifRuled).toEqual({
      kinds: ["normal"],
      caseTargets: ["f.item.title", "f.item.amount"],
      note: TEST_CASE_FRAME_TEXTS.ruledNormalOnly,
      codeIfTableRuled: [],
      remaining: LIMIT,
    });
    expect(found.ifExistenceOnly).toEqual({
      kinds: [],
      caseTargets: [],
      maxCases: 0,
      note: TEST_CASE_FRAME_TEXTS.existenceConditional,
      remaining: LIMIT,
      codeIfExistenceOnly: [
        { targetId: "f.item.title", kind: "normal", observes: "view-structure" },
        { targetId: "f.item.amount", kind: "normal", observes: "view-structure" },
      ],
    });
  });

  it("(5) 対象でない要件（項目だけ）の existence-only の枝は今までどおり（欄が付かない）", () => {
    const fieldOnly: NameTable = { ...table, ownership: [{ requirementId: "R1", roles: ["f.item.title"].map(stated) }] };
    const made = generateTests({ table: fieldOnly, ledger: LEDGER, list: LIST });
    const [found] = initialTestCaseFramesOf({ table: fieldOnly, ledger: LEDGER, list: LIST, generated: made }, ["R1"]);
    expect(Object.keys(found?.ifExistenceOnly ?? {})).toEqual(["kinds", "caseTargets", "maxCases", "note", "remaining"]);
  });
});

// ── (3) 採った種類の交差（表と ②' が食い違う入力）─────────────────────────

describe("(3) 取得の交差：表と ②' の分類が食い違っても、J2 の採った種類で残る本数が決まる（Issue #826）", () => {
  type Nature = "ruled" | "existence-only";
  const ROLES = ["f.item.title", "f.item.amount", "o.addItem"];
  const TEXT = "金額と題名のある項目を登録できる。";
  const EXISTENCE_IDS = [
    `${GENERATED_TEST_ID_PREFIX}${WHENLESS_FIELD_SCREEN_ID_MARKER}:R1:f.item.title:normal`,
    `${GENERATED_TEST_ID_PREFIX}${WHENLESS_FIELD_SCREEN_ID_MARKER}:R1:f.item.amount:normal`,
  ];

  function materials(tableNature: Nature) {
    const list = listOf([
      { id: "R1", text: TEXT },
      { id: "R2", text: "題名を持つ。" },
    ]);
    const table: NameTable = {
      rows: fixtureTable().rows,
      ownership: [
        { requirementId: "R1", roles: ROLES.map(stated) },
        // 組が空にならないよう、項目だけの #652 のコードの試験を 1 本持つ要件を置く
        { requirementId: "R2", roles: ["f.item.title"].map(stated) },
      ],
      verification: [
        { requirementId: "R1", kind: "fixed-test" },
        { requirementId: "R2", kind: "fixed-test" },
      ],
      classification: [
        { requirementId: "R1", nature: tableNature },
        { requirementId: "R2", nature: "ruled" },
      ],
    };
    return { list, table, plan: planOf(list) };
  }

  /** ②' の分類だけを返す場合の応答（R2 は ruled で固定） */
  const responseOfNature = (nature: Nature) =>
    casesResponseOf({
      classifications: [
        { requirementId: "R1", nature },
        { requirementId: "R2", nature: "ruled" },
      ],
      tests: [],
    });

  /** J2 の偽物（choice の確率は閾値以上） */
  const judgePicking = (nature: Nature): Judge => ({
    async judge(request) {
      const answers: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(request.questions)) {
        answers[name] = { kind: "choice", choice: nature, probabilities: undefined, probability: 0.95, confidence: undefined };
      }
      return { answers, inputTokens: 0, model: "fake-826", answeredBy: "fake" };
    },
  });

  /**
   * 表の分類 `tableNature`・②' の分類 `llmNature`・J2 の採否 `judgeNature`（`"fallback"` は判定を渡さない）で
   * `runTestSpec` を 1 回流す（内容のやり直しに備えて同じ応答を 2 本）。
   */
  async function runIntersection(tableNature: Nature, llmNature: Nature, judgeNature: Nature | "fallback") {
    const m = materials(tableNature);
    const tableSha256 = await nameTableSha256(m.table);
    const carryOver = await deriveCarryOver({
      list: m.list,
      table: m.table,
      semanticCheck: {
        tableSha256,
        judgments: [
          { requirementId: "R1", verdict: "accept" as const },
          { requirementId: "R2", verdict: "accept" as const },
        ],
      },
    });
    const response = responseOfNature(llmNature);
    const recording = createCheckedRecordingClient([recordedStructured(response), recordedStructured(response)]);
    const outcome = await runTestSpec({
      plan: m.plan,
      list: m.list,
      table: m.table,
      documents: FIXTURE_DOCUMENTS,
      carryOver,
      gateway: makeGateway(retainingT2Client(recording.client), { maxAttempts: 1 }),
      ledger: LEDGER,
      ids: true,
      ...(judgeNature === "fallback" ? {} : { judge: judgePicking(judgeNature) }),
    });
    const remaining = outcome.ok ? outcome.value.suite.tests.filter((test) => test.target.requirementId === "R1").map((test) => test.id) : [];
    const messages = outcome.ok ? [] : outcome.failure.kind === "unmet" || outcome.failure.kind === "malformed" ? outcome.failure.problems.map((problem) => problem.message) : [];
    return { outcome, remaining, messages };
  }

  it("表 ruled・②' existence-only・J2 が existence-only を採る → 2 本が残る", async () => {
    const { outcome, remaining } = await runIntersection("ruled", "existence-only", "existence-only");
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(remaining).toEqual(EXISTENCE_IDS);
    expect(outcome.value.natures.get("R1")).toBe("existence-only");
  });

  it("同じ入力で J2 が ruled を採る → 残らず、「要件の試験が無い」で落ちる", async () => {
    const { outcome, remaining, messages } = await runIntersection("ruled", "existence-only", "ruled");
    expect(outcome.ok).toBe(false);
    expect(remaining).toEqual([]);
    expect(messages).toContain("要件の試験が無い");
  });

  it("同じ入力で J2 が倒れる（判定を渡さない fallback）→ ruled になり、残らず「要件の試験が無い」", async () => {
    const { outcome, remaining, messages } = await runIntersection("ruled", "existence-only", "fallback");
    expect(outcome.ok).toBe(false);
    expect(remaining).toEqual([]);
    expect(messages).toContain("要件の試験が無い");
  });

  it("逆向き（表 existence-only・②' ruled）でも、J2 が existence-only を採れば 2 本が残る", async () => {
    const { outcome, remaining } = await runIntersection("existence-only", "ruled", "existence-only");
    if (!outcome.ok) throw new Error(`通るはず：${JSON.stringify(outcome.failure)}`);
    expect(remaining).toEqual(EXISTENCE_IDS);
    expect(outcome.value.natures.get("R1")).toBe("existence-only");
  });

  it("逆向きで J2 が ruled を採る → 残らず「要件の試験が無い」", async () => {
    const { outcome, remaining, messages } = await runIntersection("existence-only", "ruled", "ruled");
    expect(outcome.ok).toBe(false);
    expect(remaining).toEqual([]);
    expect(messages).toContain("要件の試験が無い");
  });

  it("初回の枠は、表と ②' の分類を入れ替えても同じ（分類を読まない）", () => {
    const frameFor = (tableNature: Nature) => {
      const m = materials(tableNature);
      const generated = generateTests({ table: m.table, ledger: LEDGER, list: m.list });
      return initialTestCaseFramesOf({ table: m.table, ledger: LEDGER, list: m.list, generated }, ["R1"])[0];
    };
    expect(JSON.stringify(frameFor("ruled"))).toBe(JSON.stringify(frameFor("existence-only")));
  });
});

// ── (4) 負例 ─────────────────────────────────────────────────────────────

describe("(4) 負例：条件の無い操作だけの形でなければ N-map-03 も項目つきの試験も作らない", () => {
  const ROWS = [
    rowOf("E1", "entity", null, null),
    rowOf("E2", "entity", null, null),
    rowOf("F1", "field", "E1", "string"),
    rowOf("F2", "field", "E2", "string"),
    rowOf("C1", "computation", "E1", { valueType: "number", scope: "row", form: "expression" }),
    rowOf("OP1", "operation", "E1", { action: "create", hasWhen: false }),
    rowOf("OP2", "operation", "E1", { action: "update", hasWhen: true }),
    rowOf("S1", "screen", "E1", { view: "table" }),
  ];

  it("entity・画面・計算・条件つきの操作を含む所属には N-map-03 を当てない", () => {
    const negatives: readonly Spec[] = [
      { id: "R1", roles: ["OP1", "E1"] },
      { id: "R2", roles: ["OP1", "S1"] },
      { id: "R3", roles: ["OP1", "C1"] },
      { id: "R4", roles: ["OP1", "OP2"] },
      { id: "R5", roles: ["F1"] },
      { id: "R6", roles: ["OP1", "F2"] },
      { id: "R7", roles: ["OP1"], verification: { requirementId: "R7", kind: "structural", reason: "構造で確かめる", checks: [] } },
    ];
    const raw = tableOf(ROWS, negatives);
    const { table, normalized } = normalizeMappedTable(raw);
    expect(normalized).toEqual([]);
    expect(table).toBe(raw);
  });

  it("重複か表に無い ID を含む所属には当てない", () => {
    for (const roles of [
      ["OP1", "OP1"],
      ["OP1", "OP9"],
    ]) {
      const raw = tableOf(ROWS, [{ id: "R1", roles }]);
      expect(normalizeMappedTable(raw).normalized).toEqual([]);
    }
  });

  it("項目つきの試験は、所属の項目が操作の entity の項目でなければ作らない（別 entity・操作の無い項目だけは #652 のまま）", () => {
    const other = tableOf(ROWS, [{ id: "R1", roles: ["OP1", "F2"] }]);
    const madeOther = generateTests({ table: other, ledger: LEDGER, list: listOf([{ id: "R1", text: "別の entity の項目を登録できる。" }]) });
    expect(madeOther.tests.filter((test) => test.target.requirementId === "R1")).toEqual([]);

    const fieldOnly = tableOf(ROWS, [{ id: "R1", roles: ["F1"] }]);
    const madeField = generateTests({ table: fieldOnly, ledger: LEDGER, list: listOf([{ id: "R1", text: "題名を持つ。" }]) });
    const made = madeField.tests.filter((test) => test.target.requirementId === "R1");
    expect(made).toHaveLength(1);
    expect(madeField.existenceOnlyTestIds.size).toBe(0);
  });

  it("fixed-test でない要件には当てない（N-map-03 も項目つきの試験も作らない）", () => {
    const structural = tableOf([rowOf("OP1", "operation", null, { action: "create", hasWhen: false })], [
      { id: "R1", roles: ["OP1"], verification: { requirementId: "R1", kind: "structural", reason: "構造で確かめる", checks: [] } },
    ]);
    expect(normalizeMappedTable(structural).normalized).toEqual([]);
    const made = generateTests({ table: structural, ledger: LEDGER, list: listOf([{ id: "R1", text: "操作がある。" }]) });
    expect(made.existenceOnlyTestIds.size).toBe(0);
  });
});

// ── (6) 門 ───────────────────────────────────────────────────────────────

describe("(6) 門：fixed-test への構造の検査を LLM が書けば今までどおり落ちる", () => {
  it("コードの試験があっても、LLM の operation structure の試験は OWNERSHIP_STRUCTURE_NOT_ALLOWED で落ちる", () => {
    const table: NameTable = {
      ...fixtureTable(),
      ownership: [{ requirementId: "R1", roles: ["f.item.title"].map(stated) }],
      verification: [{ requirementId: "R1", kind: "fixed-test" }],
      classification: [{ requirementId: "R1", nature: "ruled" }],
    };
    const list = listOf([{ id: "R1", text: "題名を持つ。" }]);
    const generated = generateTests({ table, ledger: LEDGER, list });
    const llm = {
      tests: [
        {
          id: "llm-structure",
          target: { requirementId: "R1", kind: "field" as const, roleId: "f.item.title" },
          kind: "normal" as const,
          operation: "structure" as const,
          clock: "2026-01-01T00:00:00+09:00",
          input: {},
          inputContract: { rowId: "row-1", targetRowId: null, emptyEntities: [] },
          referenceData: [],
          expected: { kind: "ok" as const, value: true },
          assertion: { check: "field-type" as const, expected: "string" as const },
        },
      ],
    };
    expect(checkGeneratedOverlap(llm, new Map([["llm-structure", "existence"]]), generated, table, LEDGER)).toEqual([
      { field: "tests[0].operation", message: OWNERSHIP_STRUCTURE_NOT_ALLOWED },
    ]);
  });
});

// ── (7) 指紋（当たらない表は同じ）─────────────────────────────────────────

describe("(7) 当たらない表は同じ表のまま（経路が変わらない台本の指紋）", () => {
  it("N-map-03 の当たらない表は同じ参照を返し、記録は空", () => {
    const raw = tableOf([rowOf("F1", "field", "E1", "string")], [{ id: "R1", roles: ["F1"] }]);
    const once = normalizeMappedTable(raw);
    expect(once.table).toBe(raw);
    expect(once.normalized).toEqual([]);
    expect(normalizeMappedTable(raw)).toEqual(once);
  });
});

// ── (8) C3 の拒否を保つ ───────────────────────────────────────────────────

describe("(8) C3 の拒否：N-map-03 で整えた操作だけの要件を、偽物の C3 が weak-verification で拒否する", () => {
  const OPS = [rowOf("E1", "entity", null, null), rowOf("OP1", "operation", "E1", { action: "create", hasWhen: false })];
  const TEXT = "決まりを伴う操作ができる。";
  const LIST = listOf([
    { id: "R1", text: TEXT },
    { id: "R2", text: "entity がある。" },
  ]);
  const SPECS: readonly Spec[] = [
    { id: "R1", roles: ["OP1"] },
    { id: "R2", roles: ["E1"] },
  ];
  const RAW = tableOf(OPS, SPECS);

  it("C3 は整えた表（structural）を受け、拒否が残り、持ち越しの出どころが semantic-check になる", async () => {
    const inspected = inspectMappingSourced(LIST, OPS, responseOf(SPECS), FIXTURE_DOCUMENTS, LEDGER);
    if (!inspected.ok) throw new Error(`通るはず：${JSON.stringify(inspected.problems)}`);
    expect(inspected.normalized).toEqual([{ requirementId: "R1", rule: "N-map-03", targetId: null, removedRowIds: [] }]);
    // 所属と分類は変えない（C3 が見る要件の意味と行は今までどおり）
    expect(inspected.table.ownership).toEqual(RAW.ownership);
    expect(inspected.table.classification).toEqual(RAW.classification);

    const rejection = { requirementId: "R1", verdict: "reject" as const, kind: "weak-verification", quote: TEXT };
    const accepted = { requirementId: "R2", verdict: "accept" as const };
    const acceptedInput = { ...accepted, kind: null, quote: null };
    const recording = createCheckedRecordingClient([recordedStructured({ judgments: [rejection, acceptedInput] })]);
    const outcome = await runSemanticCheck({
      plan: planOf(LIST),
      list: LIST,
      table: inspected.table,
      documents: FIXTURE_DOCUMENTS,
      gateway: makeGateway(recording.client, { maxAttempts: 1 }),
      ids: true,
    });
    if (!outcome.ok) throw new Error(`C3 が段として落ちた：${JSON.stringify(outcome.failure)}`);
    expect(outcome.value.judgments).toEqual([rejection, accepted]);
    expect(recording.structured[0]?.schemaName).toBe(SEMANTIC_CHECK_SCHEMA_NAME);

    const carry = await deriveCarryOver({
      list: LIST,
      table: inspected.table,
      semanticCheck: { tableSha256: outcome.value.tableSha256, judgments: outcome.value.judgments },
    });
    expect(carry.entries).toEqual([{ requirementId: "R1", reasons: [{ origin: "semantic-check", reason: "weak-verification" }] }]);
  });
});
