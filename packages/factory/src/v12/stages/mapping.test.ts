// C2 要件の写像の試験（Issue #593・#594・#627・#682・#660・#661）。偽物の LLM（照合ありの記録）と固定の時計で回す。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { STRUCTURAL_ASSERTIONS, type StructuralAssertionKind } from "../../fixed-test.js";
import { validateSchema } from "../../schema-check.js";
import { PREVIOUS_RESPONSE_DATA_NAME, SHAPE_PROBLEMS_DATA_NAME, constraintIdsIn, ruleDefinitionDefects, ruleTexts } from "../../stages/prompt.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import {
  FIXTURE_DOCUMENTS,
  checkFieldsResponseOf,
  createCheckedRecordingClient,
  fixtureDefaultValueList,
  fixtureDefaultValueTable,
  fixtureList,
  fixtureNonRequirementList,
  fixtureNonRequirementTable,
  fixtureTable,
  NegativeOutput,
  idsResponsesOf,
  negative,
  planOf,
  recordedStructured,
  strictDefects,
  withAggregates,
  withCheckTargets,
  withCodeIds,
} from "../../v11a/__tests__/fixtures.js";
import { buildSized } from "../../v11a/__tests__/sizes.js";
import { CHECK_TARGET_MESSAGES, checkMappedTable, nameTableSha256, type NameTable } from "../../v11a/names.js";
import type { RequirementList } from "../../pipeline.js";
import { semanticCheckTargets } from "../../v11a/stages/semantic-check.js";
import { PROPERTY_LEDGER_VIEW, type LedgerView, type UpstreamLedgerView } from "../ledger.js";
import type { ReferenceCounts } from "../ids.js";
import {
  MAPPING_DATA_NAMES,
  MAPPING_MESSAGES,
  MAPPING_RULE_DEFINITIONS,
  MAPPING_REWRITE_DATA_NAMES,
  MAPPING_REWRITE_MESSAGES,
  MAPPING_SCHEMA_NAME,
  attributeMappingProblems,
  inspectMapping,
  inspectMappingSourced,
  mappingRewriteRuleDefinitionsOf,
  legacyMappingSchemaOf,
  mappingRuleDefinitionsOf,
  mappingSchemaOf,
  rejectedRequirementIds,
  runMapping,
  type MappingInspector,
  type MappingInput,
  type MappingPrevious,
  type MappingRejectedCandidate,
} from "./mapping.js";

const LIST = fixtureList();
const TABLE = withCodeIds(fixtureTable());
/** C2 が組む表（構造の検査の確かめ方に検査ごとの対象を持つ。Issue #594） */
const MAPPED = withCheckTargets(TABLE);
const GOOD = idsResponsesOf(LIST, TABLE).mapping;

async function run(
  outputs: readonly unknown[],
  options: { previous?: MappingPrevious; table?: NameTable; list?: RequirementList; ledger?: LedgerView } = {},
) {
  const list = options.list ?? LIST;
  const recording = createCheckedRecordingClient(outputs.map(recordedStructured));
  const outcome = await runMapping({
    plan: planOf(list),
    list,
    documents: FIXTURE_DOCUMENTS,
    gateway: makeGateway(recording.client),
    rows: (options.table ?? TABLE).rows,
    ...(options.previous === undefined ? {} : { previous: options.previous }),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
  });
  return { outcome, recording };
}

type Entry = Record<string, unknown>;
const entries = (): Entry[] => (GOOD["requirements"] as Entry[]).map((entry) => ({ ...entry }));
const withEntries = (list: readonly Entry[]) => ({ requirements: list });
const messagesOf = (outcome: Awaited<ReturnType<typeof runMapping>>): readonly string[] =>
  outcome.ok || outcome.failure.kind !== "unmet" ? [] : outcome.failure.problems.map((problem) => problem.message);
/** C2 の応答の checks（検査の種類ごとの欄）：渡した欄のほかは null（Issue #682） */
const fields = (set: Partial<Record<StructuralAssertionKind, unknown>> = {}): Entry =>
  Object.fromEntries(STRUCTURAL_ASSERTIONS.map((check) => [check, set[check] ?? null]));
/** 要件 index の確かめ方の checks だけを差し替えた応答 */
const withChecksAt = (at: number, checks: unknown) =>
  withEntries(entries().map((entry, index) => (index === at ? { ...entry, verification: { ...(entry["verification"] as Entry), checks } } : entry)));
/**
 * 書き直しの応答（Issue #660）：応答から書き直す要件の entry だけを残したもの（負例の応答は理由ごと保つ）。`rewrite` が undefined なら
 * 全体の作り直しなので応答のまま
 */
const rewriteOf = (output: unknown, rewrite: readonly string[] | undefined): unknown => {
  if (rewrite === undefined) return output;
  if (output instanceof NegativeOutput) return negative(rewriteOf(output.output, rewrite), output.reason);
  return withEntries(((output as Entry)["requirements"] as Entry[]).filter((entry) => rewrite.includes(entry["requirementId"] as string)));
};
/** 要求のデータの塊（無ければ null） */
const blockOf = (input: string | undefined, name: string): unknown => {
  const text = (input ?? "").split(`<data name="${name}">\n`)[1]?.split("\n</data>")[0];
  return text === undefined ? null : (JSON.parse(text) as unknown);
};

describe("C2 の規則と schema", () => {
  it("規則の定義に why・since があり不備 0（台帳の文で組み直しても）。schema は strict で写し・出典の欄が無く、checks は検査の種類ごとの欄（Issue #682）", () => {
    expect(ruleDefinitionDefects(MAPPING_RULE_DEFINITIONS)).toEqual([]);
    expect(ruleDefinitionDefects(mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW))).toEqual([]);
    for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
      const schema = mappingSchemaOf(ledger);
      expect(strictDefects(schema)).toEqual([]);
      const text = JSON.stringify(schema);
      for (const key of ['"copy"', '"source"', '"quote"', '"anyOf"']) expect(text.includes(key), key).toBe(false);
      const properties = (((schema["properties"] as Entry)["requirements"] as Entry)["items"] as Entry)["properties"] as Entry;
      const checks = ((properties["verification"] as Entry)["properties"] as Entry)["checks"] as Entry;
      // checks は検査の種類ごとの欄（6 欄が全部 required・固定の順・additionalProperties false）を持つ写像か null
      expect(checks["type"]).toEqual(["object", "null"]);
      expect(checks["additionalProperties"]).toBe(false);
      expect(checks["required"]).toEqual([...STRUCTURAL_ASSERTIONS]);
      expect(Object.keys(checks["properties"] as Entry)).toEqual([...STRUCTURAL_ASSERTIONS]);
      for (const check of STRUCTURAL_ASSERTIONS) {
        const field = (checks["properties"] as Entry)[check] as Entry;
        // 各欄は null か対象の写像。view-shows だけ sourceId（文字列）を持つ
        expect(field["type"], check).toEqual(["object", "null"]);
        expect(field["additionalProperties"], check).toBe(false);
        expect(field["required"], check).toEqual(check === "view-shows" ? ["targetId", "sourceId"] : ["targetId"]);
        expect(((field["properties"] as Entry)["targetId"] as Entry)["type"], check).toBe("string");
        if (check === "view-shows") expect(((field["properties"] as Entry)["sourceId"] as Entry)["type"]).toBe("string");
      }
      // 旧の schema（識別子 v1.2 の封筒の枝を保つためだけのもの）は checks だけが違う
      const legacy = legacyMappingSchemaOf(ledger);
      expect(strictDefects(legacy)).toEqual([]);
      const legacyProperties = (((legacy["properties"] as Entry)["requirements"] as Entry)["items"] as Entry)["properties"] as Entry;
      const legacyChecks = ((legacyProperties["verification"] as Entry)["properties"] as Entry)["checks"] as Entry;
      expect(legacyChecks["type"]).toBe("array");
      expect(((legacyChecks["items"] as Entry)["required"])).toEqual(["check", "targetId", "sourceId"]);
      const swapped = JSON.parse(JSON.stringify(legacy)) as Entry;
      ((((((swapped["properties"] as Entry)["requirements"] as Entry)["items"] as Entry)["properties"] as Entry)["verification"] as Entry)["properties"] as Entry)["checks"] = checks;
      expect(swapped).toEqual(schema);
    }
    expect(MAPPING_SCHEMA_NAME).toBe("mapping");
    // 規則の文は所属に含めよと求めず、対象の欄を書かせる（旗 on では「view-shows の検査に…所属が無い」を規則で求めない）
    const r3 = MAPPING_RULE_DEFINITIONS.find((definition) => definition.id === "R-map-03");
    expect(r3?.text).toContain("targetId");
    expect(r3?.text).not.toContain("検査ごとに合う種類の行を所属させる");
    expect(r3?.since).toContain("#594");
    expect(r3?.since).toContain("#682");
    expect(r3?.since).toContain("#690");
    // 一覧は全要件を 1 回で渡す（束は Issue #627 で戻した）
    const r1 = MAPPING_RULE_DEFINITIONS.find((definition) => definition.id === "R-map-01");
    expect(r1?.why).not.toContain("別の束の ID");
    expect(r1?.since).toContain("#627");
  });
});

describe("1 回の写像（束に切らない。Issue #627）", () => {
  it.each([15, 7])("要件 %i でも、初回の要求は 1 本で、データに全要件（一覧・確定した仕様）と C1 の全行がある", async (count) => {
    const sized = buildSized(count, 3 * count, { ledger: true, searchRepair: true, ids: true });
    const responses = sized.tableResponses().slice(3);
    expect(responses).toHaveLength(1);
    const { outcome, recording } = await run(responses, { list: sized.list, table: sized.table, ledger: PROPERTY_LEDGER_VIEW });
    expect(outcome.ok).toBe(true);
    expect(recording.structured).toHaveLength(1);
    const input = recording.structured[0]?.input ?? "";
    const block = (name: string) => JSON.parse(input.split(`<data name="${name}">\n`)[1]?.split("\n</data>")[0] ?? "null") as Entry;
    const ids = sized.list.requirements.map((requirement) => requirement.id);
    expect((block(MAPPING_DATA_NAMES.list)["requirements"] as readonly { id: string }[]).map((requirement) => requirement.id)).toEqual(ids);
    expect((block(MAPPING_DATA_NAMES.plan)["requirements"] as readonly { id: string }[]).map((requirement) => requirement.id)).toEqual(ids);
    expect(block(MAPPING_DATA_NAMES.rows)).toHaveLength(sized.table.rows.length);
    if (outcome.ok) expect(outcome.value.table).toEqual(withCheckTargets(sized.table));
  });
});

describe("C2' の正例", () => {
  it("要件ごとに 1 件・行の ID で所属と検査の対象を書いた応答は問題 0 で、組んだ表が fixture の表（検査の対象つき）と深く等しい。参照の照合の数は 0", async () => {
    const { outcome, recording } = await run([GOOD]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.table).toEqual(MAPPED);
    expect(outcome.value.tableSha256).toBe(await nameTableSha256(MAPPED));
    const roles = TABLE.ownership.reduce((total, entry) => total + entry.roles.length, 0);
    // 照らした参照：要件 ID・所属の ID・検査の対象の ID（R2 の view-shows の targetId と sourceId）
    expect(outcome.references).toEqual({ checked: LIST.requirements.length + roles + 2, unknown: 0, duplicate: 0, crossBundle: 0 });
    // 要求：名前を見せない・写しの欄が無い・要件 ID と文と引用を渡す
    const [request] = recording.structured;
    const rowsBlock = request?.input.split(`<data name="${MAPPING_DATA_NAMES.rows}">`)[1]?.split("</data>")[0] ?? "";
    expect(rowsBlock.includes('"name"')).toBe(false);
    expect(request?.input.includes('"copy"')).toBe(false);
    expect(request?.input).toContain('"id": "R1"');
    expectNoAcceptanceMaterial([JSON.stringify(recording.structured)]);
  });

  it("応答の要件の順を入れ替えても、表は一覧の順に並ぶ（表の SHA は応答の順に依らない）", async () => {
    const { outcome } = await run([withEntries(entries().reverse())]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.table).toEqual(MAPPED);
  });

  it("default-value の要件（R6）は所属させた選択肢の項目の options の値で通る", async () => {
    const list = fixtureDefaultValueList();
    const table = withCodeIds(fixtureDefaultValueTable());
    const { outcome } = await run([idsResponsesOf(list, table).mapping], { list, table });
    expect(outcome.ok).toBe(true);
  });
});

describe("C2' の負例：固定文で落ち、形のやり直し 1 回のあと 2 回で unmet", () => {
  const rowOf = (index: number) => entries()[index] as Entry;
  const r2Checks = (checks: unknown) => withChecksAt(1, checks);
  const viewShows = (targetId: string, sourceId: string) => fields({ "view-shows": { targetId, sourceId } });
  // rewrite：初回の問題が全部帰属できるときに書き直す要件（Issue #660）。undefined は帰属できない問題があり全体の作り直し
  const cases: readonly {
    readonly label: string;
    readonly bad: () => unknown;
    readonly message: string;
    readonly count?: keyof ReferenceCounts;
    readonly rewrite?: readonly string[];
  }[] = [
    { label: "要件の欠落", bad: () => withEntries(entries().slice(1)), message: "要件の所属が無い" },
    { label: "同じ要件 2 件（重複）", bad: () => withEntries([...entries(), rowOf(0)]), message: "同じ要件の項目が重なっている", count: "duplicate" },
    { label: "一覧に無い要件 ID（知らない ID）", bad: () => withEntries([...entries(), { ...rowOf(0), requirementId: "R99" }]), message: "一覧に無い要件 ID である", count: "unknown" },
    {
      label: "行に無い ID の所属（知らない ID）",
      bad: () => withEntries(entries().map((entry, index) => (index === 0 ? { ...entry, roles: [...(entry["roles"] as unknown[]), { id: "E1.F99", basis: "stated", reason: null }] } : entry))),
      message: "所属の表の ID が表に無い",
      count: "unknown",
      rewrite: ["R1"],
    },
    {
      label: "同じ要件の中で同じ行を 2 回所属（重複）",
      bad: () => withEntries(entries().map((entry, index) => (index === 0 ? { ...entry, roles: [...(entry["roles"] as unknown[]), (entry["roles"] as unknown[])[0]] } : entry))),
      message: "同じ要件の中で所属が重なっている",
      count: "duplicate",
      rewrite: ["R1"],
    },
    {
      label: "所属の欄に要件 ID（別の束の ID）",
      bad: () => withEntries(entries().map((entry, index) => (index === 0 ? { ...entry, roles: [...(entry["roles"] as unknown[]), { id: "R2", basis: "stated", reason: null }] } : entry))),
      message: "所属の表の ID が表に無い",
      count: "crossBundle",
      rewrite: ["R1"],
    },
    // checks の 6 欄が全部 null の structural（と checks が null の structural）は、表の検査の今の固定文で落ちる（Issue #682 の (5)）
    { label: "structural で checks の 6 欄が全部 null", bad: () => r2Checks(fields()), message: "構造で確かめる要件に checks が無い", rewrite: ["R2"] },
    { label: "structural で checks が null", bad: () => r2Checks(null), message: "構造で確かめる要件に checks が無い", rewrite: ["R2"] },
    // 構造の検査の対象（Issue #594。欄の写像は Issue #682）。R2 は画面 V2（entity E1）・V1（E2）、項目 E1.F1・E2.F1、計算 C1（E1）を所属させる
    { label: "検査の対象の種類が違う（view-shows に項目）", bad: () => r2Checks(viewShows("E1.F1", "E1.F1")), message: CHECK_TARGET_MESSAGES.targetKind, rewrite: ["R2"] },
    { label: "検査の対象の種類が違う（field-type に画面）", bad: () => r2Checks(fields({ "field-type": { targetId: "V2" } })), message: CHECK_TARGET_MESSAGES.targetKind, rewrite: ["R2"] },
    { label: "view-shows の対の entity が違う", bad: () => r2Checks(viewShows("V2", "E2.F1")), message: CHECK_TARGET_MESSAGES.sourcePair, rewrite: ["R2"] },
    { label: "dashboard の画面に entity を持つ項目を組にした", bad: () => r2Checks(viewShows("V3", "E2.F1")), message: CHECK_TARGET_MESSAGES.sourcePair, rewrite: ["R2"] },
    { label: "dashboard の画面に entity を持つ計算を組にした", bad: () => r2Checks(viewShows("V3", "C1")), message: CHECK_TARGET_MESSAGES.sourcePair, rewrite: ["R2"] },
    { label: "view-shows の組に画面を書いた", bad: () => r2Checks(viewShows("V2", "V1")), message: CHECK_TARGET_MESSAGES.sourcePair, rewrite: ["R2"] },
    { label: "検査の対象の ID が行に無い", bad: () => r2Checks(viewShows("V9", "E1.F1")), message: CHECK_TARGET_MESSAGES.unknownTarget, count: "unknown", rewrite: ["R2"] },
    { label: "view-shows の組の ID が行に無い", bad: () => r2Checks(viewShows("V2", "E1.F9")), message: CHECK_TARGET_MESSAGES.unknownSource, count: "unknown", rewrite: ["R2"] },
    // 欄の写像では書けない形（strict の schema では出ない。照合を外して流すと形の固定文で落ちる。Issue #682 の (6)）
    {
      label: "view-shows の sourceId が null（schema では出ない）",
      bad: () => negative(r2Checks(fields({ "view-shows": { targetId: "V2", sourceId: null } })), "view-shows の sourceId は schema では文字列"),
      message: MAPPING_MESSAGES.checksShape,
      rewrite: ["R2"],
    },
    {
      label: "view-shows でない欄に sourceId（schema では出ない）",
      bad: () => negative(r2Checks(fields({ "field-type": { targetId: "E1.F1", sourceId: "E1.F1" } })), "view-shows でない欄は schema で sourceId を持たない"),
      message: MAPPING_MESSAGES.checksShape,
      rewrite: ["R2"],
    },
    {
      label: "配列の形の checks（schema では出ない）",
      bad: () => negative(r2Checks([{ check: "view-shows", targetId: "V2", sourceId: "E1.F1" }]), "checks は schema で欄の写像か null"),
      message: MAPPING_MESSAGES.checksShape,
      rewrite: ["R2"],
    },
    {
      label: "欄が欠けた checks（schema では出ない）",
      bad: () => {
        const { "write-anonymous": _omit, ...rest } = viewShows("V2", "E1.F1");
        return negative(r2Checks(rest), "checks の 6 欄は schema で全部 required");
      },
      message: MAPPING_MESSAGES.checksShape,
      rewrite: ["R2"],
    },
    {
      label: "targetId が空の欄（構造の形）",
      bad: () => r2Checks(viewShows("", "E1.F1")),
      message: MAPPING_MESSAGES.checksShape,
      rewrite: ["R2"],
    },
    // 未解決の要件の制約 ID が空（規則の文だけを直し、検査は今のまま。Issue #682 の (3)）
    {
      label: "unresolved の constraintIds が空",
      bad: () => withEntries(entries().map((entry, index) => (index === 4 ? { ...entry, verification: { ...(entry["verification"] as Entry), constraintIds: [] } } : entry))),
      message: "未解決の要件に制約 ID が無い",
      rewrite: ["R5"],
    },
  ];

  it.each(cases)("$label", async ({ bad, message, count, rewrite }) => {
    // 2 回目の応答は、帰属できれば書き直す要件だけ（合併すると初回と同じ写像）、帰属できなければ全体（Issue #660）
    const { outcome, recording } = await run([bad(), rewriteOf(bad(), rewrite)]);
    expect(recording.structured).toHaveLength(2);
    expect(blockOf(recording.structured[1]?.input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual(rewrite ?? null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
    expect(messagesOf(outcome)).toContain(message);
    if (count !== undefined) expect(outcome.references[count]).toBeGreaterThanOrEqual(1);
    const fixed = await run([bad(), rewriteOf(GOOD, rewrite)]);
    expect(fixed.outcome.ok).toBe(true);
  });

  it("今の対の条件で落ちる組（画面と entity の違う項目・計算、dashboard と entity を持つ項目・計算）は、対象の欄でも全部落ちる", () => {
    const screens = TABLE.rows.filter((row) => row.kind === "screen");
    const sources = TABLE.rows.filter((row) => row.kind === "field" || row.kind === "computation");
    for (const screen of screens) {
      for (const source of sources) {
        if (source.entity === screen.entity) continue;
        const problems = inspectMapping(LIST, TABLE.rows, r2Checks(viewShows(screen.id, source.id)), FIXTURE_DOCUMENTS);
        expect(problems.ok, `${screen.id}・${source.id}`).toBe(false);
        if (!problems.ok) expect(problems.problems.map((problem) => problem.message)).toContain(CHECK_TARGET_MESSAGES.sourcePair);
      }
    }
  });

  it("default-value の value が options の外は、C2' の固定文で落ちる（形のやり直し 1 回のあと 2 回で unmet）", async () => {
    const list = fixtureDefaultValueList();
    const table = withCodeIds(fixtureDefaultValueTable());
    const good = idsResponsesOf(list, table).mapping["requirements"] as Entry[];
    const outside = good.map((entry) => (entry["requirementId"] === "R6" ? { ...entry, verification: { ...(entry["verification"] as Entry), value: "gamma" } } : entry));
    const first = await run([withEntries(outside), rewriteOf(withEntries(outside), ["R6"])], { list, table });
    expect(first.recording.structured).toHaveLength(2);
    expect(blockOf(first.recording.structured[1]?.input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual(["R6"]);
    expect(messagesOf(first.outcome)).toContain("既定値で確かめる要件の value が、所属させた選択肢の項目の options に無い");
  });

  it("要件でない文（non-requirement）に実在する行を所属させた応答は、台帳の固定文で 2 回落ちて unmet（要求 2 回）。所属 0 行に直せば通る（旗 ledger on）", async () => {
    const list = fixtureNonRequirementList();
    const table = withCodeIds(withAggregates(fixtureNonRequirementTable()));
    const good = idsResponsesOf(list, table, PROPERTY_LEDGER_VIEW).mapping["requirements"] as Entry[];
    const nonRequirement = good.find((entry) => entry["requirementId"] === "R6");
    expect((nonRequirement?.["verification"] as Entry | undefined)?.["kind"]).toBe("non-requirement");
    expect(nonRequirement?.["roles"]).toEqual([]);
    const existing = table.rows[0]?.id;
    expect(existing).toBeDefined();
    const owned = good.map((entry) => (entry["requirementId"] === "R6" ? { ...entry, roles: [{ id: existing, basis: "stated", reason: null }] } : entry));
    const options = { list, table, ledger: PROPERTY_LEDGER_VIEW };
    const failed = await run([withEntries(owned), rewriteOf(withEntries(owned), ["R6"])], options);
    expect(failed.recording.structured).toHaveLength(2);
    expect(blockOf(failed.recording.structured[1]?.input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual(["R6"]);
    expect(failed.outcome.ok).toBe(false);
    if (!failed.outcome.ok) expect(failed.outcome.failure.kind).toBe("unmet");
    expect(messagesOf(failed.outcome)).toContain("要件でない文（non-requirement）には行を所属させないこと");
    const fixed = await run([withEntries(owned), rewriteOf(withEntries(good), ["R6"])], options);
    expect(fixed.outcome.ok).toBe(true);
    expect(fixed.recording.structured).toHaveLength(2);
  });

  it("写し由来の固定文（長さ・一覧に無い写し・引用が原文に無い）は C2' の落ちに出ない", async () => {
    const copyMessages = [
      "要件の文の写しが指示した長さと合わない",
      "出典の要件の文の写しが一覧のどの要件とも合わない",
      "出典の引用が、写しが指す要件の原文に無い",
    ];
    for (const { bad, rewrite } of cases) {
      const { outcome } = await run([bad(), rewriteOf(bad(), rewrite)]);
      for (const message of messagesOf(outcome)) expect(copyMessages).not.toContain(message);
    }
  });
});

describe("構造の検査の対象の欄（Issue #594）", () => {
  it("checks が欄の写像でない（種類の文字列の並び・検査ごとの写像の並び。strict の schema では出ない）応答は、形の固定文で落ちる", () => {
    for (const checks of [["view-shows"], [{ check: "view-shows", targetId: "V2", sourceId: "E1.F1" }], "view-shows", 0]) {
      const inspected = inspectMapping(LIST, TABLE.rows, withChecksAt(1, checks), FIXTURE_DOCUMENTS);
      expect(inspected.ok, JSON.stringify(checks)).toBe(false);
      if (!inspected.ok) expect(inspected.problems.map((problem) => problem.message)).toEqual([MAPPING_MESSAGES.checksShape]);
    }
    // structural でない要件も checks の形は同じ（欄の写像か null。並びは形の固定文）
    const fixedTest = inspectMapping(LIST, TABLE.rows, withChecksAt(0, []), FIXTURE_DOCUMENTS);
    expect(fixedTest.ok).toBe(false);
    if (!fixedTest.ok) expect(fixedTest.problems).toEqual([{ field: "requirements[0].verification.checks", message: MAPPING_MESSAGES.checksShape }]);
  });

  // R2 に画面（V2・V1）だけを所属させる。R2 だけが持っていた計算 C1 は、どの要件にも所属しない行を作らないよう R4 に移す
  // （1 回の写像では表全体の C2' が同じ応答に掛かるため。Issue #627）
  const SCREENS_ONLY = [
    { id: "V2", basis: "stated", reason: null },
    { id: "V1", basis: "stated", reason: null },
  ] as const;
  const screenOnly = () =>
    withEntries(
      entries().map((entry, index) =>
        index === 1
          ? {
              ...entry,
              roles: [...SCREENS_ONLY],
              verification: { ...(entry["verification"] as Entry), checks: fields({ "view-shows": { targetId: "V2", sourceId: "E1.F1" } }) },
            }
          : index === 3
            ? { ...entry, roles: [...(entry["roles"] as Entry[]), { id: "C1", basis: "stated", reason: null }] }
            : entry,
      ),
    );

  it("正例：view-shows に画面の ID と同じ entity の項目の ID を書いた応答は問題 0 で、対象の行が所属に無ければ basis dependency・reason に検査の種類で足される", () => {
    const inspected = inspectMapping(LIST, TABLE.rows, screenOnly(), FIXTURE_DOCUMENTS);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    const r2 = inspected.table.ownership.find((entry) => entry.requirementId === "R2");
    expect(r2?.roles).toEqual([
      ...SCREENS_ONLY,
      { id: "E1.F1", basis: "dependency", reason: "view-shows" },
    ]);
    expect(inspected.table.verification.find((entry) => entry.requirementId === "R2")).toEqual({
      requirementId: "R2",
      kind: "structural",
      reason: "画面に出ることだけを求める",
      checks: ["view-shows"],
      targets: [{ check: "view-shows", targetId: "V2", sourceId: "E1.F1" }],
    });
    // 既に所属にある行は足さない（fixture の応答の R2 は組の行を名指しで所属させている）
    const good = inspectMapping(LIST, TABLE.rows, GOOD, FIXTURE_DOCUMENTS);
    expect(good.ok && good.table.ownership[1]?.roles).toEqual(TABLE.ownership[1]?.roles);
  });

  it("二点測定：画面だけを所属させた応答は、手 3a の表の検査では「view-shows の検査に…所属が無い」で落ち、ここでは対象の欄から所属が導かれて通る", () => {
    const threeA: NameTable = {
      ...TABLE,
      ownership: TABLE.ownership.map((entry) =>
        entry.requirementId === "R2"
          ? { ...entry, roles: [...SCREENS_ONLY] }
          : entry.requirementId === "R4"
            ? { ...entry, roles: [...entry.roles, { id: "C1", basis: "stated" as const, reason: null }] }
            : entry,
      ),
    };
    const before = checkMappedTable(LIST, threeA, FIXTURE_DOCUMENTS).map((problem) => problem.message);
    expect(before).toContain("view-shows の検査に、画面と同じ entity の項目か計算の所属が無い");
    const after = inspectMapping(LIST, TABLE.rows, screenOnly(), FIXTURE_DOCUMENTS);
    expect(after.ok).toBe(true);
  });
});

describe("検査の種類ごとの欄（Issue #682）", () => {
  /** R2 の確かめ方を、種類の違う 2 つの検査（field-type・view-shows）にした表（手で組んだ表。並びは種類の固定の順） */
  const twoKinds: NameTable = {
    ...TABLE,
    verification: TABLE.verification.map((entry) =>
      entry.requirementId === "R2" ? { requirementId: "R2", kind: "structural" as const, reason: "画面に出ることと型だけを求める", checks: ["field-type" as const, "view-shows" as const] } : entry,
    ),
  };

  it("二点測定 (1)：同じ要件に同じ種類の検査を 2 行に書いた応答は、直す前の形（並び）なら表の検査の固定文で落ちたが、欄の写像では書けない（schema の不一致・形の固定文）", async () => {
    // 直す前：並びの形は同じ種類を 2 行に書けて、組んだ表は表の検査の今の固定文で落ちた
    const duplicated: NameTable = {
      ...TABLE,
      verification: TABLE.verification.map((entry) => (entry.requirementId === "R2" ? { ...entry, checks: ["view-shows", "view-shows"] as const } : entry)),
    };
    expect(checkMappedTable(LIST, duplicated, FIXTURE_DOCUMENTS).map((problem) => problem.message)).toContain("checks の中身が重なっている");
    // 直す前の応答の形（structural は検査ごとの写像の並び、ほかは空の並び）
    const legacyResponse = withEntries(
      (withChecksAt(1, [
        { check: "view-shows", targetId: "V2", sourceId: "E1.F1" },
        { check: "view-shows", targetId: "V1", sourceId: "E2.F1" },
      ])["requirements"]).map((entry) => {
        const verification = entry["verification"] as Entry;
        return verification["checks"] === null ? { ...entry, verification: { ...verification, checks: [] } } : entry;
      }),
    );
    expect(validateSchema(legacyMappingSchemaOf(), legacyResponse)).toBeUndefined();
    // 直した後：同じ内容は今の schema に合わない（偽物の LLM・adapter が共有する検査で不一致）
    expect(validateSchema(mappingSchemaOf(), legacyResponse)).toBeDefined();
    expect(validateSchema(mappingSchemaOf(PROPERTY_LEDGER_VIEW), legacyResponse)).toBeDefined();
    // 欄は種類ごとに 1 つなので、同じ種類の 2 件目は書く場所が無い（欄の写像に 2 件は置けない）
    expect(() => checkFieldsResponseOf([
      { check: "view-shows", targetId: "V2", sourceId: "E1.F1" },
      { check: "view-shows", targetId: "V1", sourceId: "E2.F1" },
    ])).toThrow();
    // 照合を外して流しても、形の固定文で 2 回落ちて unmet
    const { outcome } = await run([negative(legacyResponse, "並びの checks は schema では出ない"), negative(legacyResponse, "同上")]);
    expect(outcome.ok).toBe(false);
    expect(new Set(messagesOf(outcome))).toEqual(new Set([MAPPING_MESSAGES.checksShape]));
  });

  it("二点測定 (1)：欄の写像で 1 種類 1 件の応答は問題 0 で、組んだ表（検査の対象・所属に足した行・表の SHA）が直す前の並びの形（固定の順）の同じ内容から組んだ表と深く等しい", async () => {
    const expected = withCheckTargets(twoKinds);
    const targets = expected.verification.find((entry) => entry.requirementId === "R2");
    expect(targets).toMatchObject({ checks: ["field-type", "view-shows"], targets: [{ check: "field-type" }, { check: "view-shows" }] });
    const response = idsResponsesOf(LIST, twoKinds).mapping;
    // 応答の欄の鍵の順に依らず、種類の固定の順に写す
    const reversedKeys = withEntries(
      (response["requirements"] as Entry[]).map((entry) => {
        const verification = entry["verification"] as Entry;
        const checks = verification["checks"];
        return checks === null ? entry : { ...entry, verification: { ...verification, checks: Object.fromEntries(Object.entries(checks as Entry).reverse()) } };
      }),
    );
    for (const output of [response, reversedKeys]) {
      const { outcome } = await run([output]);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.table).toEqual(expected);
      expect(outcome.value.tableSha256).toBe(await nameTableSha256(expected));
      // 検査の対象の行は所属に足される（fixture の R2 は対象の行を名指しで所属させているので、所属は表のまま）
      expect(outcome.value.table.ownership).toEqual(twoKinds.ownership);
    }
    // 対象の行を所属から外しても、検査の対象から所属に足される（今の導出のまま）
    const derived = inspectMapping(
      LIST,
      TABLE.rows,
      withEntries(
        (response["requirements"] as Entry[]).map((entry, index) =>
          index === 1 ? { ...entry, roles: (entry["roles"] as Entry[]).filter((role) => role["id"] !== "E1.F1") } : entry,
        ),
      ),
      FIXTURE_DOCUMENTS,
    );
    expect(derived.ok).toBe(true);
    if (derived.ok) expect(derived.table.ownership[1]?.roles).toContainEqual({ id: "E1.F1", basis: "dependency", reason: "field-type" });
  });

  it("二点測定 (2)：同じ種類の検査を 2 つの行に掛ける要件（複数の操作）を、それらの行を所属させて fixed-test にした応答は問題 0（所属の検査は今のまま）", async () => {
    const operations = TABLE.rows.filter((row) => row.kind === "operation").map((row) => row.id);
    expect(operations.length).toBeGreaterThanOrEqual(2);
    const fixedTest = withEntries(
      entries().map((entry, index) =>
        index === 2
          ? {
              ...entry,
              roles: [...(entry["roles"] as Entry[]), ...operations.filter((id) => !(entry["roles"] as Entry[]).some((role) => role["id"] === id)).map((id) => ({ id, basis: "stated", reason: null }))],
              verification: { ...(entry["verification"] as Entry), kind: "fixed-test", checks: null },
            }
          : entry,
      ),
    );
    const { outcome } = await run([fixedTest]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r3 = outcome.value.table.ownership.find((entry) => entry.requirementId === "R3");
    for (const id of operations) expect(r3?.roles.map((role) => role.id)).toContain(id);
    expect(outcome.value.table.verification.find((entry) => entry.requirementId === "R3")).toEqual({ requirementId: "R3", kind: "fixed-test" });
    // 同じ 2 つの操作を structural の action-kind の 2 件にした表は、表の検査の今の固定文で落ちる
    const asStructural: NameTable = {
      ...outcome.value.table,
      verification: outcome.value.table.verification.map((entry) =>
        entry.requirementId === "R3" ? { requirementId: "R3", kind: "structural" as const, reason: "操作の種類だけ", checks: ["action-kind", "action-kind"] as const } : entry,
      ),
    };
    expect(checkMappedTable(LIST, asStructural, FIXTURE_DOCUMENTS).map((problem) => problem.message)).toContain("checks の中身が重なっている");
  });

  it("二点測定 (3)：unresolved で constraintIds が 1 件以上なら通り、空なら今の固定文で落ちる（検査は不変。規則の文だけを直した）", async () => {
    const r5 = entries()[4] as Entry;
    expect((r5["verification"] as Entry)["kind"]).toBe("unresolved");
    expect(((r5["verification"] as Entry)["constraintIds"] as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((await run([GOOD])).outcome.ok).toBe(true);
    const empty = withEntries(entries().map((entry, index) => (index === 4 ? { ...entry, verification: { ...(entry["verification"] as Entry), constraintIds: [] } } : entry)));
    // 問題は R5 に帰属するので、2 回目は R5 だけの書き直し（Issue #660）
    const { outcome } = await run([empty, rewriteOf(empty, ["R5"])]);
    expect(outcome.ok).toBe(false);
    expect(messagesOf(outcome)).toContain("未解決の要件に制約 ID が無い");
  });

  it("負例 (4)：手で組んだ表で同じ種類が 2 件なら、表の検査が今の固定文で落ちる。復号した表の checks は重ならない", async () => {
    for (const checks of [["view-shows", "view-shows"], ["field-type", "view-shows", "field-type"]] as const) {
      const table: NameTable = {
        ...withCheckTargets(twoKinds),
        verification: twoKinds.verification.map((entry) => (entry.requirementId === "R2" ? { ...entry, checks } : entry)),
      };
      expect(checkMappedTable(LIST, table, FIXTURE_DOCUMENTS).map((problem) => problem.message), checks.join()).toContain("checks の中身が重なっている");
    }
    // 6 欄を全部埋めた応答も、復号した checks は種類の固定の順で重ならない
    const all = fields({
      "field-type": { targetId: "E1.F1" },
      "action-kind": { targetId: "OP1" },
      "action-unconditioned": { targetId: "OP1" },
      "view-shows": { targetId: "V2", sourceId: "E1.F1" },
      "aggregate-no-period": { targetId: "C1" },
      "write-anonymous": { targetId: "OP1" },
    });
    const inspected = inspectMapping(LIST, TABLE.rows, withChecksAt(1, all), FIXTURE_DOCUMENTS);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      const r2 = inspected.table.verification.find((entry) => entry.requirementId === "R2");
      expect(r2 && r2.kind === "structural" ? r2.checks : []).toEqual([...STRUCTURAL_ASSERTIONS]);
    }
  });

  it("負例 (7)：どの検査の対象にも roles にも無い行は所属させない（推測で足さない）。孤立行は今の固定文で落ちる", () => {
    // R4 から C2 を外し、R2 の検査の対象にも書かない
    const orphan = withEntries(entries().map((entry, index) => (index === 3 ? { ...entry, roles: (entry["roles"] as Entry[]).filter((role) => role["id"] !== "C2") } : entry)));
    const inspected = inspectMapping(LIST, TABLE.rows, orphan, FIXTURE_DOCUMENTS);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.problems.map((problem) => problem.message)).toEqual(["どの要件にも所属しない行がある"]);
    // 同じ行を検査の対象（aggregate-no-period）に書けば所属に足され、孤立行にならない
    const r2 = (entries()[1] as Entry)["verification"] as Entry;
    const viaCheck = withEntries(
      (orphan["requirements"] as Entry[]).map((entry, index) =>
        index === 1 ? { ...entry, verification: { ...r2, checks: { ...(r2["checks"] as Entry), "aggregate-no-period": { targetId: "C2" } } } } : entry,
      ),
    );
    const derived = inspectMapping(LIST, TABLE.rows, viaCheck, FIXTURE_DOCUMENTS);
    expect(derived.ok).toBe(true);
    if (derived.ok) expect(derived.table.ownership[1]?.roles).toContainEqual({ id: "C2", basis: "dependency", reason: "aggregate-no-period" });
  });

  it("参照の照合の数は欄の写像の targetId・sourceId を数える（null の欄は数えない）", async () => {
    const roles = TABLE.ownership.reduce((total, entry) => total + entry.roles.length, 0);
    const { outcome } = await run([withChecksAt(1, fields({ "field-type": { targetId: "E1.F1" }, "view-shows": { targetId: "V2", sourceId: "E1.F1" } }))]);
    expect(outcome.references).toEqual({ checked: LIST.requirements.length + roles + 3, unknown: 0, duplicate: 0, crossBundle: 0 });
  });

  it("要求：R-map-03 の新しい文（種類ごと 1 件・fixed-test への選び方・当たる種類が無い要件の選び方・制約 ID 1 件以上）があり、ほかの規則の文・順・データの塊の名前は直す前と同じ", () => {
    for (const definitions of [MAPPING_RULE_DEFINITIONS, mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)]) {
      expect(definitions.map((definition) => definition.id)).toEqual(["R-map-01", "R-map-02", "R-map-03", "R-map-04"]);
      const r3 = definitions.find((definition) => definition.id === "R-map-03")?.text ?? "";
      for (const phrase of [
        "checks は検査の種類ごとの欄で、同じ種類の検査は要件ごとに 1 件である。",
        "view-shows の欄は sourceId に画面と同じ entity の項目か計算の行の ID",
        "使わない種類の欄は null にする。",
        "structural は、検査の種類のうち 1 つ以上で確かめられる要件だけである。",
        "確かめ方の種類を選ぶ既存の条件（default-value など、専用の種類を指定する文）は今までどおり先に当てる。",
        "そのうえで structural にしようとした要件に当たる種類が 1 つも無いなら（行が在ることだけを求める要件など）structural にせず、固定した試験で確かめられるなら fixed-test、宣言で書けず根拠となる文書の制約 ID を一覧から 1 件以上挙げられるなら unresolved にする。",
        "欄が全部 null の structural は表の検査で断られる。",
        "同じ種類の検査を 2 つ以上の行に掛けなければ確かめられない要件（複数の操作・複数の項目・1 つの画面と複数の項目）は structural にせず、kind を fixed-test にしてそれらの行を所属させる。",
        "constraintIds に書けない根拠となる文書の制約 ID を 1 件以上（文書の制約 ID の一覧にあるものだけ）書く。",
        "根拠となる制約 ID を一覧から挙げられない要件は unresolved にしない。",
        "使わない欄は null か空の並びにする。",
      ]) {
        expect(r3, phrase).toContain(phrase);
      }
      expect(r3).not.toContain("1 件ずつ並べる");
      expectNoAcceptanceMaterial([...definitions.map((definition) => JSON.stringify(definition)), JSON.stringify(mappingSchemaOf(PROPERTY_LEDGER_VIEW)), MAPPING_MESSAGES.checksShape]);
    }
    // ほかの規則の文は直す前（d38e132）と同じ固定文
    expect(MAPPING_RULE_DEFINITIONS.filter((definition) => definition.id !== "R-map-03").map((definition) => definition.text)).toEqual([
      "要件の一覧の要件ごとに 1 件ずつ、requirementId に一覧の要件 ID をそのまま書く。一覧に無い要件 ID を書かない。同じ要件を 2 件書かない。",
      "roles は、その要件が使う行の所属である。id には表の行の ID をそのまま書く。要件の文が名指しする対象は basis を stated にし reason を null にする。要件の文は名指ししないが実現に要る対象は basis を dependency にし、reason に要る理由を 1 文で書く。項目・計算・操作・画面の所属 entity はコードが足すので書かなくてよい。同じ要件の中で同じ行を 2 回書かない。どの要件にも所属しない行を残さない。",
      "nature は要件ごとの種類である。要件の文から分類する：値や振る舞いを縛る決まりを含むなら ruled、そのものが在ればよいなら existence-only にする。前回の写像・表の点検の拒否・助言の印が渡されたときは、拒否が指す要件を直した写像を返す。助言の印は参考であり、印だけを理由に所属を消さない。",
    ]);
    expect(MAPPING_DATA_NAMES).toEqual({
      plan: "確定した仕様",
      list: "要件の一覧",
      rows: "表の行",
      documents: "文書",
      response: "前回の写像",
      rejections: "表の点検の拒否",
      advice: "助言の印",
    });
    // 台帳の文で組み直す版は R-map-03 の頭が同じ（台帳の文の前に構造・未解決の文が来る）
    const plain = MAPPING_RULE_DEFINITIONS.find((definition) => definition.id === "R-map-03")?.text ?? "";
    const ledger = mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW).find((definition) => definition.id === "R-map-03")?.text ?? "";
    const head = plain.slice(0, plain.indexOf("要件の決まりが"));
    expect(ledger.startsWith(head)).toBe(true);
  });
});

describe("どの要件にも所属しない行", () => {
  it("どの要件にも所属しない行がある写像は、C2' の固定文で落ちる（形のやり直し 1 回のあと 2 回で unmet）", async () => {
    const orphan = withEntries(entries().map((entry, index) => (index === 3 ? { ...entry, roles: (entry["roles"] as Entry[]).filter((role) => role["id"] !== "C2") } : entry)));
    const { outcome, recording } = await run([orphan, orphan]);
    expect(recording.structured).toHaveLength(2);
    expect(outcome.ok).toBe(false);
    expect(messagesOf(outcome)).toEqual(["どの要件にも所属しない行がある"]);
  });
});

describe("C3 の拒否のあとの 2 回目", () => {
  const previous: MappingPrevious = {
    response: GOOD,
    rejections: [{ requirementId: "R2", verdict: "reject", kind: "unnecessary-ownership", quote: "一覧で見られる" }] as unknown as MappingPrevious["rejections"],
    advice: [],
  };

  it("要求に前回の写像・拒否・印のデータがあり、1 回だけ呼ぶ。C2' に落ちても形の再試行は無く unmet（attempts 1）", async () => {
    // 2 回目の応答は拒否された要件（R2）だけの書き直し（Issue #661）
    const ok = await run([rewriteOf(GOOD, ["R2"])], { previous });
    expect(ok.outcome.ok).toBe(true);
    const input = ok.recording.structured[0]?.input ?? "";
    for (const name of [MAPPING_DATA_NAMES.response, MAPPING_DATA_NAMES.rejections, MAPPING_DATA_NAMES.advice]) expect(input).toContain(`<data name="${name}">`);
    // 前回の写像は新しい形（検査の種類ごとの欄）の raw のまま載る（Issue #682）
    const response = JSON.parse(input.split(`<data name="${MAPPING_DATA_NAMES.response}">\n`)[1]?.split("\n</data>")[0] ?? "null") as unknown;
    expect(response).toEqual(GOOD);
    expect(blockOf(input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual(["R2"]);
    expect(((GOOD["requirements"] as Entry[])[1] as Entry)["verification"]).toHaveProperty("checks", fields({ "view-shows": { targetId: "V2", sourceId: "E1.F1" } }));
    const bad = withEntries(entries().slice(1));
    const failed = await run([bad, GOOD], { previous });
    expect(failed.recording.structured).toHaveLength(1);
    expect(failed.outcome.ok).toBe(false);
    if (!failed.outcome.ok) expect(failed.outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
  });
});

describe("初回の形のやり直しを落ちた要件だけの書き直しにする（Issue #660）", () => {
  /** 要件 at の所属に、行に無い ID を足した entry の並び */
  const withUnknownRoleAt = (list: readonly Entry[], ats: readonly number[]): Entry[] =>
    list.map((entry, index) => (ats.includes(index) ? { ...entry, roles: [...(entry["roles"] as Entry[]), { id: "E1.F99", basis: "stated", reason: null }] } : entry));
  const sourcedOf = (output: Entry, list: RequirementList = LIST, table: NameTable = TABLE) => {
    const inspected = inspectMappingSourced(list, table.rows, output, FIXTURE_DOCUMENTS);
    if (inspected.ok) throw new Error("前提が壊れた：落ちる応答であること");
    return inspected;
  };
  const attributionOf = (output: Entry, list: RequirementList = LIST, table: NameTable = TABLE) =>
    attributeMappingProblems(list, output, sourcedOf(output, list, table));
  /** 偽物の LLM と、形の再試行の数を読める口で 1 回回す */
  const runCounted = async (outputs: readonly unknown[], options: { list?: RequirementList; table?: NameTable; inspect?: MappingInspector } = {}) => {
    const list = options.list ?? LIST;
    const recording = createCheckedRecordingClient(outputs.map(recordedStructured));
    const gateway = makeGateway(recording.client);
    const rejected: MappingRejectedCandidate[] = [];
    const outcome = await runMapping({
      plan: planOf(list),
      list,
      documents: FIXTURE_DOCUMENTS,
      gateway,
      rows: (options.table ?? TABLE).rows,
      onRejected: (candidate) => rejected.push(candidate),
      ...(options.inspect === undefined ? {} : { inspect: options.inspect }),
    });
    return { outcome, recording, gateway, rejected };
  };
  const only = (output: Entry, ids: readonly string[]) => rewriteOf(output, ids) as Entry;

  describe("帰属（純粋）", () => {
    it("応答の位置・表の位置・一覧の欠落がそれぞれ要件 ID に写り、同じ要件の問題がまとまる。同じ入力から 2 回同じ", () => {
      // 応答の位置：応答の順を逆にし、R2 の checks の形を崩す（応答の 3 番目＝R2。一覧の添字 1 ではない）
      const reversed = entries().reverse();
      const responseBad = withEntries(reversed.map((entry) => (entry["requirementId"] === "R2" ? { ...entry, verification: { ...(entry["verification"] as Entry), checks: ["view-shows"] } } : entry)));
      const byResponse = attributionOf(responseBad);
      expect(sourcedOf(responseBad).problems.map((problem) => problem.field)).toEqual(["requirements[3].verification.checks"]);
      expect(byResponse.requirementIds).toEqual(["R2"]);
      // 表の位置：R1 の所属に行に無い ID を 2 つ足すと、問題 2 件が R1 にまとまる
      const twice = withEntries(entries().map((entry, index) => (index === 0 ? { ...entry, roles: [...(entry["roles"] as Entry[]), { id: "E1.F98", basis: "stated", reason: null }, { id: "E1.F99", basis: "stated", reason: null }] } : entry)));
      const byTable = attributionOf(twice);
      expect(byTable.requirementIds).toEqual(["R1", "R1"]);
      expect(byTable.groups?.map((group) => [group.requirementId, group.problems.length])).toEqual([["R1", 2]]);
      // 一覧の欠落：所属 0 行の R5 が無い応答は、一覧の 4 番目（R5）の 3 件（所属・確かめ方・分類）
      const missingLast = withEntries(entries().slice(0, -1));
      const byList = attributionOf(missingLast);
      expect(sourcedOf(missingLast).problems.map((problem) => problem.field)).toEqual(["requirements[4]", "requirements[4]", "requirements[4]"]);
      expect(byList.groups).toEqual([{ requirementId: "R5", problems: sourcedOf(missingLast).problems }]);
      // 2 件の要件が落ちれば一覧の順に 2 組
      const two = withEntries(withUnknownRoleAt(entries(), [3, 0]));
      expect(attributionOf(two).groups?.map((group) => group.requirementId)).toEqual(["R1", "R4"]);
      for (const output of [responseBad, twice, missingLast, two]) expect(attributionOf(output)).toEqual(attributionOf(output));
    });

    it("帰属できない問題：孤立行・要件 ID の重複・一覧に無い要件 ID は帰属できず、組は無い（推測しない）", () => {
      const orphan = withEntries(entries().map((entry, index) => (index === 3 ? { ...entry, roles: (entry["roles"] as Entry[]).filter((role) => role["id"] !== "C2") } : entry)));
      const duplicate = withEntries([...entries(), entries()[0] as Entry]);
      const unknown = withEntries([...entries(), { ...(entries()[0] as Entry), requirementId: "R99" }]);
      for (const [label, output, message] of [
        ["孤立行", orphan, "どの要件にも所属しない行がある"],
        ["要件 ID の重複", duplicate, "同じ要件の項目が重なっている"],
        ["一覧に無い要件 ID", unknown, "一覧に無い要件 ID である"],
      ] as const) {
        const attribution = attributionOf(output);
        const problems = sourcedOf(output).problems;
        expect(attribution.groups, label).toBeNull();
        problems.forEach((problem, index) => {
          if (problem.message === message) expect(attribution.requirementIds[index], label).toBeNull();
        });
      }
      // 孤立行と帰属できる問題（R1 の所属の不正）が混ざっても、組は無い
      const mixed = withEntries(withUnknownRoleAt((orphan["requirements"] as Entry[]).map((entry) => ({ ...entry })), [0]));
      expect(attributionOf(mixed).requirementIds).toContain("R1");
      expect(attributionOf(mixed).groups).toBeNull();
    });

    it("負例（R1）：先頭の要件が欠落し、別の要件の所属の ID が表に無い応答で、欠落は先頭の要件 ID、所属の不正は表の entry の要件 ID（R2）に帰属し、先頭の要件へ寄らない", () => {
      const output = withEntries(withUnknownRoleAt(entries(), [1]).slice(1));
      const sourced = sourcedOf(output);
      const attribution = attributeMappingProblems(LIST, output, sourced);
      const at = (field: string) => attribution.requirementIds[sourced.problems.findIndex((problem) => problem.field === field)];
      // 表の 0 番は R1 が欠落しているので R2 になる
      expect(sourced.tableRequirementIds?.[0]).toBe("R2");
      expect(sourced.problems.find((problem) => problem.message === "所属の表の ID が表に無い")?.field).toMatch(/^ownership\[0\]\.roles\[\d+\]\.id$/);
      expect(attribution.requirementIds[sourced.problems.findIndex((problem) => problem.message === "所属の表の ID が表に無い")]).toBe("R2");
      expect(at("requirements[0]")).toBe("R1");
    });
  });

  describe("二点測定（ids on・要件 15）", () => {
    const sized = buildSized(15, 45, { ledger: true, searchRepair: true, ids: true });
    const sizedGood = sized.tableResponses().slice(3)[0] as Entry;
    const sizedEntries = (): Entry[] => (sizedGood["requirements"] as Entry[]).map((entry) => ({ ...entry }));
    const X = "R7";
    const Y = "R12";
    const indexOf = (id: string) => sized.ids.indexOf(id);
    /** 台帳 on の要件 15 の走り（`buildSized` の ids on の表は台帳の形） */
    const ledgerRun = async (outputs: readonly unknown[]) => {
      const recording = createCheckedRecordingClient(outputs.map(recordedStructured));
      const gateway = makeGateway(recording.client);
      const rejected: MappingRejectedCandidate[] = [];
      const outcome = await runMapping({
        plan: planOf(sized.list),
        list: sized.list,
        documents: FIXTURE_DOCUMENTS,
        gateway,
        rows: sized.table.rows,
        ledger: PROPERTY_LEDGER_VIEW,
        onRejected: (candidate) => rejected.push(candidate),
      });
      return { outcome, recording, gateway, rejected };
    };

    it("(1) 要件 X の所属の ID が表に無い応答：2 本目は X だけの書き直しの要求（前回の写像・X・X の問題）。X 以外の 14 件はバイト列で同じまま合併され、採用した表は X を直した応答から組んだ表と深く等しい。要求は 2", async () => {
      expect(sized.table.rows.some((row) => row.id === "E1.F99")).toBe(false);
      const bad = withEntries(withUnknownRoleAt(sizedEntries(), [indexOf(X)]));
      const { outcome, recording, gateway, rejected } = await ledgerRun([bad, only(sizedGood, [X])]);
      expect(recording.structured).toHaveLength(2);
      expect(gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 0 });
      const [first, second] = recording.structured;
      // 書き直しの要求：前置き・文書・schema・出力の上限は初回と同じ。規則は部分専用、データは初回のデータの後ろに 3 塊
      expect(second?.instructions).toBe(first?.instructions);
      expect(second?.documents).toEqual(first?.documents);
      expect(second?.schema).toEqual(first?.schema);
      expect(second?.schemaName).toBe(first?.schemaName);
      expect(second?.maxOutputTokens).toBe(first?.maxOutputTokens);
      expect(second?.rules).toEqual(ruleTexts(mappingRewriteRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)));
      expect(second?.input.startsWith(`${first?.input ?? ""}\n<data name="${MAPPING_DATA_NAMES.response}">`)).toBe(true);
      expect(blockOf(second?.input, MAPPING_DATA_NAMES.response)).toEqual(bad);
      expect(blockOf(second?.input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual([X]);
      const problems = blockOf(second?.input, MAPPING_REWRITE_DATA_NAMES.problems) as { requirementId: string; problems: { field: string; message: string }[] }[];
      expect(problems.map((group) => group.requirementId)).toEqual([X]);
      expect(problems[0]?.problems.map((problem) => problem.message)).toEqual(["所属の表の ID が表に無い"]);
      // 全体の作り直しの塊（前回の応答・前回の形の問題）は無い
      expect(second?.input.includes(`<data name="${PREVIOUS_RESPONSE_DATA_NAME}">`)).toBe(false);
      expect(second?.input.includes(`<data name="${SHAPE_PROBLEMS_DATA_NAME}">`)).toBe(false);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // X 以外はバイト列で同じ、X は書き直しの entry。並びは一覧の順
      const merged = (outcome.value.response as Entry)["requirements"] as Entry[];
      expect(merged.map((entry) => entry["requirementId"])).toEqual(sized.ids);
      merged.forEach((entry, index) => {
        const want = entry["requirementId"] === X ? (sizedGood["requirements"] as Entry[])[index] : (bad["requirements"] as Entry[])[index];
        expect(JSON.stringify(entry), String(entry["requirementId"])).toBe(JSON.stringify(want));
      });
      const direct = await ledgerRun([sizedGood]);
      expect(direct.outcome.ok).toBe(true);
      if (direct.outcome.ok) {
        expect(outcome.value.table).toEqual(direct.outcome.value.table);
        expect(outcome.value.tableSha256).toBe(direct.outcome.value.tableSha256);
      }
      // 断った候補は初回の 1 件で、書き直した要件 1・保持した要件 14（ID の値は持たない）
      expect(rejected.map((candidate) => [candidate.round, candidate.attempt, candidate.rewrite])).toEqual([[1, 1, { rewritten: 1, kept: 14 }]]);
    });

    it("(2) X と Y の 2 件が落ちれば、書き直す要件は一覧の順に X・Y", async () => {
      const bad = withEntries(withUnknownRoleAt(sizedEntries(), [indexOf(Y), indexOf(X)]));
      const { outcome, recording, rejected } = await ledgerRun([bad, only(sizedGood, [Y, X])]);
      expect(blockOf(recording.structured[1]?.input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual([X, Y]);
      expect(outcome.ok).toBe(true);
      expect(rejected[0]?.rewrite).toEqual({ rewritten: 2, kept: 13 });
    });

    it("(3) 孤立行が 1 つでも混ざる応答は、今までどおり全体の作り直しの要求（前回の応答・前回の形の問題を初回の要求の末尾に足す。規則は初回と同じ）", async () => {
      const owned = sizedEntries();
      const xRoles = owned[indexOf(X)]?.["roles"] as Entry[];
      // X が使う行のうち、X だけが所属させた行を X から外すと孤立行になる
      const solo = xRoles.find((role) => owned.filter((entry) => (entry["roles"] as Entry[]).some((other) => other["id"] === role["id"])).length === 1);
      expect(solo).toBeDefined();
      const orphaned = owned.map((entry, index) => (index === indexOf(X) ? { ...entry, roles: xRoles.filter((role) => role !== solo) } : entry));
      const bad = withEntries(withUnknownRoleAt(orphaned, [indexOf(Y)]));
      const { outcome, recording, gateway, rejected } = await ledgerRun([bad, sizedGood]);
      expect(outcome.ok).toBe(true);
      expect(recording.structured).toHaveLength(2);
      expect(gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 0 });
      const [first, second] = recording.structured;
      expect(second?.rules).toEqual(first?.rules);
      expect(second?.input.startsWith(`${first?.input ?? ""}\n<data name="${PREVIOUS_RESPONSE_DATA_NAME}">`)).toBe(true);
      expect(blockOf(second?.input, PREVIOUS_RESPONSE_DATA_NAME)).toEqual(bad);
      expect(second?.input).toContain(`<data name="${SHAPE_PROBLEMS_DATA_NAME}">`);
      expect(second?.input.includes(`<data name="${MAPPING_REWRITE_DATA_NAMES.requirements}">`)).toBe(false);
      expect(second?.instructions).toBe(first?.instructions);
      expect(second?.documents).toEqual(first?.documents);
      expect(second?.schema).toEqual(first?.schema);
      // 全体の作り直しの候補は今の形のまま（書き直しの数を持たない）
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).not.toHaveProperty("rewrite");
    });
  });

  describe("負例（R5）と合併後の C2'", () => {
    const bad = () => withEntries(withUnknownRoleAt(entries(), [0]));
    it.each([
      { label: "(4) 書き直しの応答に R1 以外の要件がある", second: () => only(GOOD, ["R1", "R3"]), message: MAPPING_REWRITE_MESSAGES.extra },
      { label: "(5) R1 が無い", second: () => withEntries([]), message: MAPPING_REWRITE_MESSAGES.missing },
      { label: "(5) R1 が 2 回ある", second: () => withEntries([...(only(GOOD, ["R1"])["requirements"] as Entry[]), ...(only(GOOD, ["R1"])["requirements"] as Entry[])]), message: MAPPING_REWRITE_MESSAGES.duplicate },
    ])("$label：固定文で unmet、追加の要求なし。段の形の再試行は 1", async ({ second, message }) => {
      const { outcome, recording, gateway, rejected } = await runCounted([bad(), second(), GOOD]);
      expect(recording.structured).toHaveLength(2);
      expect(gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 0 });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 2 });
      expect(messagesOf(outcome)).toEqual([message]);
      expect(rejected.map((candidate) => [candidate.attempt, candidate.rewrite])).toEqual([
        [1, { rewritten: 1, kept: 4 }],
        [2, { rewritten: 1, kept: 4 }],
      ]);
      expect(rejected[1]?.response).toEqual(second());
      expectNoAcceptanceMaterial([...Object.values(MAPPING_REWRITE_MESSAGES), JSON.stringify(outcome.failure)]);
    });

    it("(6) 合併後の表の孤立行は C2' が今までどおり落とす（部分の規則に書かない）。合併後に掛ける検査は初回と同じ検査（偽物の検査で数える）", async () => {
      const calls: { readonly list: RequirementList; readonly rows: readonly unknown[]; readonly output: Entry; readonly documents: unknown; readonly ledger: unknown }[] = [];
      const counting: MappingInspector = (list, rows, output, documents, ledger) => {
        calls.push({ list, rows, output, documents, ledger });
        return inspectMappingSourced(list, rows, output, documents, ledger);
      };
      // R4 を書き直させ、R4 だけが所属させた行（C2）を外した応答を返すと、合併した表に孤立行が残る
      const r4bad = withEntries(withUnknownRoleAt(entries(), [3]));
      const r4 = only(GOOD, ["R4"]);
      const orphaned = withEntries((r4["requirements"] as Entry[]).map((entry) => ({ ...entry, roles: (entry["roles"] as Entry[]).filter((role) => role["id"] !== "C2") })));
      const { outcome, recording, rejected } = await runCounted([r4bad, orphaned, GOOD], { inspect: counting });
      expect(recording.structured).toHaveLength(2);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 2 });
      expect(messagesOf(outcome)).toEqual(["どの要件にも所属しない行がある"]);
      // 検査は 2 回（初回の応答・合併した写像）、同じ一覧・行・文書・台帳。2 回目は合併した写像（一覧の順の全要件）
      expect(calls).toHaveLength(2);
      expect(calls[1]?.list).toBe(calls[0]?.list);
      expect(calls[1]?.rows).toBe(calls[0]?.rows);
      expect(calls[1]?.documents).toBe(calls[0]?.documents);
      expect(calls[1]?.ledger).toBe(calls[0]?.ledger);
      expect(calls[0]?.output).toEqual(r4bad);
      expect(((calls[1]?.output["requirements"] ?? []) as Entry[]).map((entry) => entry["requirementId"])).toEqual(LIST.requirements.map((requirement) => requirement.id));
      // 断った 2 件目の候補は、C2' に掛けた合併した写像と、その問題の全部
      expect(rejected[1]?.response).toEqual(calls[1]?.output);
      expect(rejected[1]?.problems.map((problem) => problem.message)).toEqual(["どの要件にも所属しない行がある"]);
      // 同じ写像を初回に渡せば、初回の検査も同じ固定文で落とす（検査は同じもの）
      const direct = inspectMapping(LIST, TABLE.rows, calls[1]?.output as Entry, FIXTURE_DOCUMENTS);
      expect(direct.ok ? [] : direct.problems.map((problem) => problem.message)).toEqual(messagesOf(outcome));
    });

    it("(7) 書き直しが C2' に 2 回目も落ちれば unmet で止まり、段の形の再試行は 1（中身の再試行は無い）", async () => {
      const { outcome, recording, gateway } = await runCounted([bad(), only(bad(), ["R1"]), GOOD]);
      expect(recording.structured).toHaveLength(2);
      expect(gateway.retryCounts).toEqual({ communication: 0, shape: 1, content: 0 });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 2 });
      expect(messagesOf(outcome)).toEqual(["所属の表の ID が表に無い"]);
    });

    it("書き直しの応答の骨組みが崩れていれば malformed（追加の要求なし）", async () => {
      const { outcome, recording } = await runCounted([bad(), negative({ requirements: "x" }, "requirements が並びでない応答。strict の schema では出ないが、骨組みの負例"), GOOD]);
      expect(recording.structured).toHaveLength(2);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toMatchObject({ kind: "malformed", attempts: 2 });
    });
  });

  describe("記録と要求（R2・R6）", () => {
    it("参照の照合の数は、初回の応答の参照＋書き直しの応答（k 件）の参照（保持した要件を新たな応答として数えない）", async () => {
      const roles = TABLE.ownership.reduce((total, entry) => total + entry.roles.length, 0);
      const r1Roles = TABLE.ownership.find((entry) => entry.requirementId === "R1")?.roles.length ?? 0;
      const bad = withEntries(withUnknownRoleAt(entries(), [0]));
      const { outcome } = await runCounted([bad, only(GOOD, ["R1"])]);
      expect(outcome.ok).toBe(true);
      // 初回：要件 ID 5・所属（＋行に無い 1）・R2 の view-shows の対象 2。書き直し：要件 ID 1・R1 の所属（R1 は検査の対象を持たない）
      expect(outcome.references).toEqual({
        checked: LIST.requirements.length + roles + 1 + 2 + (1 + r1Roles),
        unknown: 1,
        duplicate: 0,
        crossBundle: 0,
      });
    });

    it("要求（R2）：部分の規則は全件を求める文と全行の所属を求める文を含まず、書き直す要件だけを求める文と所属しない行は合併後にコードが見る文を含む。ほかの規則の文は同じ。初回の規則は直す前のまま", () => {
      for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
        const full = mappingRuleDefinitionsOf(ledger);
        const partial = mappingRewriteRuleDefinitionsOf(ledger);
        expect(ruleDefinitionDefects(partial)).toEqual([]);
        expect(partial.map((definition) => definition.id)).toEqual(["R-map-01r", "R-map-02r", "R-map-03", "R-map-04"]);
        const texts = partial.map((definition) => definition.text).join("\n");
        expect(texts.includes("要件の一覧の要件ごとに 1 件")).toBe(false);
        expect(texts.includes("どの要件にも所属しない行を残さない")).toBe(false);
        expect(texts).toContain("書き直す要件ごとに 1 件ずつ、requirementId にその要件 ID をそのまま書く。書き直す要件のほかの要件を書かない。");
        expect(texts).toContain("どの要件にも所属しない行の条件は、合併した表でコードが見る。");
        expect(partial.slice(2)).toEqual(full.slice(2));
        // R-map-02 の所属の文は、全行の所属の文を差し替えただけ
        const r2 = full.find((definition) => definition.id === "R-map-02")?.text ?? "";
        expect(partial[1]?.text).toBe(r2.replace("どの要件にも所属しない行を残さない。", "どの要件にも所属しない行の条件は、合併した表でコードが見る。"));
        for (const definition of partial.slice(0, 2)) expect(definition.since).toContain("#660");
        expectNoAcceptanceMaterial([...partial.map((definition) => JSON.stringify(definition)), ...Object.values(MAPPING_REWRITE_DATA_NAMES)]);
      }
      // 初回（と全体の作り直し）の規則は直す前の定義のまま
      expect(MAPPING_RULE_DEFINITIONS.map((definition) => definition.id)).toEqual(["R-map-01", "R-map-02", "R-map-03", "R-map-04"]);
    });

    it("初回の要求は、書き直しの有無によらずバイト列で同じ（初回で通る走りと、書き直しに入る走りの 1 本目）", async () => {
      const clean = await runCounted([GOOD]);
      const rewritten = await runCounted([withEntries(withUnknownRoleAt(entries(), [0])), only(GOOD, ["R1"])]);
      expect(JSON.stringify(rewritten.recording.structured[0])).toBe(JSON.stringify(clean.recording.structured[0]));
      expectNoAcceptanceMaterial([JSON.stringify(rewritten.recording.structured)]);
    });
  });
});

describe("C3 の拒否のあとの 2 回目を拒否された要件だけの書き直しにする（Issue #661）", () => {
  const sized = buildSized(15, 45, { ledger: true, searchRepair: true, ids: true });
  const sizedGood = sized.tableResponses().slice(3)[0] as Entry;
  const sizedEntries = (): Entry[] => (sizedGood["requirements"] as Entry[]).map((entry) => ({ ...entry }));
  const X = "R7";
  const Y = "R12";
  const indexOf = (id: string) => sized.ids.indexOf(id);
  const rejectionOf = (requirementId: string, kind: string) => ({ requirementId, verdict: "reject", kind, quote: "一覧の要件の文" });
  /** 前回の写像（採用した表の応答）と C3 の拒否（X・Y。種類は違う）・J4 の印 */
  const previousOf = (rejections: readonly ReturnType<typeof rejectionOf>[] = [rejectionOf(Y, "missing-target"), rejectionOf(X, "weak-verification")]): MappingPrevious => ({
    response: sizedGood,
    rejections: rejections as unknown as MappingPrevious["rejections"],
    advice: [{ requirementId: X, id: "E1.F1", mark: "undetermined" }],
  });
  /** X を直した entry（分類を入れ替える。C2' は通る） */
  const fixedX = (): Entry => {
    const entry = sizedEntries()[indexOf(X)] as Entry;
    return { ...entry, nature: entry["nature"] === "ruled" ? "existence-only" : "ruled" };
  };
  const partial = (...list: readonly Entry[]) => withEntries(list);
  const entryOf = (id: string) => sizedEntries()[indexOf(id)] as Entry;
  /** 台帳 on の要件 15 の 2 回目を 1 回回す（`inspect` は試験の口） */
  const secondRun = async (outputs: readonly unknown[], options: { previous?: MappingPrevious; inspect?: MappingInspector } = {}) => {
    const recording = createCheckedRecordingClient(outputs.map(recordedStructured));
    const gateway = makeGateway(recording.client);
    const rejected: MappingRejectedCandidate[] = [];
    const outcome = await runMapping({
      plan: planOf(sized.list),
      list: sized.list,
      documents: FIXTURE_DOCUMENTS,
      gateway,
      rows: sized.table.rows,
      ledger: PROPERTY_LEDGER_VIEW,
      previous: options.previous ?? previousOf(),
      onRejected: (candidate) => rejected.push(candidate),
      ...(options.inspect === undefined ? {} : { inspect: options.inspect }),
    });
    return { outcome, recording, gateway, rejected };
  };
  /** 初回の要求（2 回目の要求の頭と照らす） */
  const firstRequest = async () => {
    const recording = createCheckedRecordingClient([sizedGood].map(recordedStructured));
    await runMapping({ plan: planOf(sized.list), list: sized.list, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(recording.client), rows: sized.table.rows, ledger: PROPERTY_LEDGER_VIEW });
    return recording.structured[0];
  };

  it("書き直す要件は C3 が拒否した要件 ID の集合（拒否の種類に依らず全部・重複なし・一覧の順）。同じ入力から同じ", () => {
    const rejections = [rejectionOf(Y, "unnecessary-ownership"), rejectionOf(X, "missing-target"), rejectionOf(Y, "weak-verification")] as unknown as MappingPrevious["rejections"];
    expect(rejectedRequirementIds(sized.list, rejections)).toEqual([X, Y]);
    expect(rejectedRequirementIds(sized.list, rejections)).toEqual(rejectedRequirementIds(sized.list, rejections));
    expect(rejectedRequirementIds(sized.list, [])).toEqual([]);
  });

  it("二点測定 (1)：C3 が X・Y を拒否した 2 回目の要求は、書き直す要件が X・Y だけ（データに前回の写像の全体・拒否・印・X・Y）。X・Y 以外の 13 件はバイト列で同じまま合併され、採用した表は X・Y を直した応答から組んだ表と深く等しい。要求は 1", async () => {
    const { outcome, recording, gateway, rejected } = await secondRun([partial(fixedX(), entryOf(Y))]);
    expect(recording.structured).toHaveLength(1);
    // 中身のやり直しの告知は呼ぶ側（run.ts）。C2 の中では形の再試行を足さない
    expect(gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 0 });
    const [second] = recording.structured;
    const first = await firstRequest();
    // 前置き・文書・schema・出力の上限は初回と同じ。規則は部分専用（I3 と同じ定義）、データは初回のデータの後ろに前回の写像・拒否・印・書き直す要件
    expect(second?.instructions).toBe(first?.instructions);
    expect(second?.documents).toEqual(first?.documents);
    expect(second?.schema).toEqual(first?.schema);
    expect(second?.schemaName).toBe(first?.schemaName);
    expect(second?.maxOutputTokens).toBe(first?.maxOutputTokens);
    expect(second?.rules).toEqual(ruleTexts(mappingRewriteRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)));
    expect(second?.input.startsWith(`${first?.input ?? ""}\n<data name="${MAPPING_DATA_NAMES.response}">`)).toBe(true);
    const names = [...(second?.input ?? "").matchAll(/<data name="([^"]+)">/g)].map((match) => match[1]);
    expect(names.slice(-4)).toEqual([MAPPING_DATA_NAMES.response, MAPPING_DATA_NAMES.rejections, MAPPING_DATA_NAMES.advice, MAPPING_REWRITE_DATA_NAMES.requirements]);
    expect(blockOf(second?.input, MAPPING_DATA_NAMES.response)).toEqual(sizedGood);
    expect((blockOf(second?.input, MAPPING_DATA_NAMES.rejections) as { requirementId: string }[]).map((rejection) => rejection.requirementId)).toEqual([Y, X]);
    expect(blockOf(second?.input, MAPPING_DATA_NAMES.advice)).toEqual([{ requirementId: X, id: "E1.F1", mark: "undetermined" }]);
    expect(blockOf(second?.input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual([X, Y]);
    // 形の書き直しの問題の塊・全体の作り直しの塊は無い
    for (const name of [MAPPING_REWRITE_DATA_NAMES.problems, PREVIOUS_RESPONSE_DATA_NAME, SHAPE_PROBLEMS_DATA_NAME]) expect(second?.input.includes(`<data name="${name}">`), name).toBe(false);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const merged = (outcome.value.response as Entry)["requirements"] as Entry[];
    expect(merged.map((entry) => entry["requirementId"])).toEqual(sized.ids);
    merged.forEach((entry, index) => {
      const want = entry["requirementId"] === X ? fixedX() : (sizedGood["requirements"] as Entry[])[index];
      expect(JSON.stringify(entry), String(entry["requirementId"])).toBe(JSON.stringify(want));
    });
    const fixedWhole = withEntries(sizedEntries().map((entry) => (entry["requirementId"] === X ? fixedX() : entry)));
    const direct = inspectMapping(sized.list, sized.table.rows, fixedWhole, FIXTURE_DOCUMENTS, PROPERTY_LEDGER_VIEW);
    expect(direct.ok).toBe(true);
    if (direct.ok) {
      expect(outcome.value.table).toEqual(direct.table);
      expect(outcome.value.tableSha256).toBe(await nameTableSha256(direct.table));
    }
    expect(rejected).toEqual([]);
    expectNoAcceptanceMaterial([JSON.stringify(recording.structured)]);
  });

  it("要求（R2）：2 回目の規則は全件を求める文と全行の所属を求める文を含まず、書き直す要件だけを求める文と、拒否が指す要件を直す 2 回目の既存の文を含む", async () => {
    const { recording } = await secondRun([partial(entryOf(X), entryOf(Y))]);
    const rules = (recording.structured[0]?.rules ?? []).join("\n");
    expect(rules.includes("要件の一覧の要件ごとに 1 件")).toBe(false);
    expect(rules.includes("どの要件にも所属しない行を残さない")).toBe(false);
    expect(rules).toContain("書き直す要件ごとに 1 件ずつ、requirementId にその要件 ID をそのまま書く。書き直す要件のほかの要件を書かない。");
    expect(rules).toContain("前回の写像・表の点検の拒否・助言の印が渡されたときは、拒否が指す要件を直した写像を返す。");
  });

  it("参照の照合の数は、2 回目の応答（書き直した k 件）の参照だけ（保持した要件を新たな応答として数えない）", async () => {
    const { outcome } = await secondRun([partial(entryOf(X), entryOf(Y))]);
    const rolesOf = (id: string) => (entryOf(id)["roles"] as unknown[]).length;
    expect(outcome.references).toEqual({ checked: 2 + rolesOf(X) + rolesOf(Y), unknown: 0, duplicate: 0, crossBundle: 0 });
  });

  describe("負例（R5）と合併後の C2'：固定文で unmet（attempts 1）、追加の要求なし", () => {
    it.each([
      { label: "(3) X・Y 以外の要件がある", second: () => partial(entryOf(X), entryOf(Y), entryOf("R1")), messages: [MAPPING_REWRITE_MESSAGES.extra] },
      { label: "(3) X が無い", second: () => partial(entryOf(Y)), messages: [MAPPING_REWRITE_MESSAGES.missing] },
      { label: "(3) X が 2 回ある", second: () => partial(entryOf(X), entryOf(X), entryOf(Y)), messages: [MAPPING_REWRITE_MESSAGES.duplicate] },
    ])("$label", async ({ second, messages }) => {
      const { outcome, recording, gateway, rejected } = await secondRun([second(), partial(entryOf(X), entryOf(Y))]);
      expect(recording.structured).toHaveLength(1);
      expect(gateway.retryCounts).toEqual({ communication: 0, shape: 0, content: 0 });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
      expect(messagesOf(outcome)).toEqual(messages);
      // 断った候補は回 2・試行 1 の 1 件で、raw の応答と書き直した要件 2・保持した要件 13（ID の値は持たない）
      expect(rejected.map((candidate) => [candidate.round, candidate.attempt, candidate.rewrite])).toEqual([[2, 1, { rewritten: 2, kept: 13 }]]);
      expect(rejected[0]?.response).toEqual(second());
    });

    it("(4) 合併後の C2' が落ちた（X の所属の ID が表に無い）：unmet（attempts 1）、追加の要求なし。候補は合併した写像とその問題", async () => {
      const badX = { ...entryOf(X), roles: [...(entryOf(X)["roles"] as Entry[]), { id: "E1.F99", basis: "stated", reason: null }] };
      const { outcome, recording, rejected } = await secondRun([partial(badX, entryOf(Y)), partial(entryOf(X), entryOf(Y))]);
      expect(recording.structured).toHaveLength(1);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
      expect(messagesOf(outcome)).toEqual(["所属の表の ID が表に無い"]);
      const merged = ((rejected[0]?.response ?? {}) as Entry)["requirements"] as Entry[];
      expect(merged.map((entry) => entry["requirementId"])).toEqual(sized.ids);
      expect(merged[indexOf(X)]).toEqual(badX);
      expect(rejected.map((candidate) => [candidate.round, candidate.attempt, candidate.rewrite])).toEqual([[2, 1, { rewritten: 2, kept: 13 }]]);
    });

    it("(5) 合併後の表の孤立行は C2' が今までどおり落とす（部分の規則に書かない）。合併後に掛ける検査は初回と同じ検査で 1 回", async () => {
      const calls: Entry[] = [];
      const counting: MappingInspector = (list, rows, output, documents, ledger) => {
        calls.push(output);
        return inspectMappingSourced(list, rows, output, documents, ledger);
      };
      // X が使う行のうち、X だけが所属させた行を外すと孤立行になる
      const owned = sizedEntries();
      const xRoles = entryOf(X)["roles"] as Entry[];
      const solo = xRoles.find((role) => owned.filter((entry) => (entry["roles"] as Entry[]).some((other) => other["id"] === role["id"])).length === 1);
      expect(solo).toBeDefined();
      const orphaning = { ...entryOf(X), roles: xRoles.filter((role) => role["id"] !== solo?.["id"]) };
      const { outcome, recording } = await secondRun([partial(orphaning, entryOf(Y))], { inspect: counting });
      expect(recording.structured).toHaveLength(1);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
      // X の所属が 1 行だけなら、所属 0 の固定文も一緒に出る（どちらも合併後の表の検査の今の文）
      expect(messagesOf(outcome)).toContain("どの要件にも所属しない行がある");
      expect(calls).toHaveLength(1);
      expect(((calls[0]?.["requirements"] ?? []) as Entry[]).map((entry) => entry["requirementId"])).toEqual(sized.ids);
      expect(MAPPING_REWRITE_MESSAGES).not.toHaveProperty("orphan");
    });

    it("骨組みが崩れた応答も、直す前と同じく unmet（attempts 1）。追加の要求なし", async () => {
      const { outcome, recording, rejected } = await secondRun([negative({ requirements: "x" }, "requirements が並びでない応答。strict の schema では出ないが、骨組みの負例"), partial(entryOf(X), entryOf(Y))]);
      expect(recording.structured).toHaveLength(1);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
      expect(rejected).toHaveLength(1);
    });
  });

  it("(6) 書き直した要件が fixed-test から unresolved に変われば、採用した表で unresolved になる（C3 の対象は呼ぶ側がその表から導く）", async () => {
    const unresolvedX = { ...entryOf(X), verification: { kind: "unresolved", value: null, reason: "宣言で書けない", checks: null, constraintIds: [...constraintIdsIn(FIXTURE_DOCUMENTS)].slice(0, 1) } };
    const { outcome } = await secondRun([partial(unresolvedX, entryOf(Y))]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.table.verification.find((entry) => entry.requirementId === X)?.kind).toBe("unresolved");
    expect(semanticCheckTargets(sized.list, outcome.value.table)).toEqual(sized.ids.filter((id) => id !== X));
  });
});

// ── 上流の台帳の見方で受ける（読み漏れの検出。Issue #712）──────────────

/** 2 つの型が互いに代入できる（同じ型）なら true */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("読み漏れの検出：C2・C2'・C2 の書き直しは台帳を上流の見方で受ける（Issue #712）", () => {
  it("規則・書き直しの規則・schema・検査・段の入力の台帳の型が上流の見方で、一覧の外の欄（T2 系の文・生の行）を読めない", () => {
    const same: readonly true[] = [
      true satisfies SameType<NonNullable<Parameters<typeof mappingRuleDefinitionsOf>[0]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<Parameters<typeof mappingRewriteRuleDefinitionsOf>[0]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<Parameters<typeof mappingSchemaOf>[0]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<Parameters<typeof legacyMappingSchemaOf>[0]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<Parameters<typeof inspectMapping>[4]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<Parameters<typeof inspectMappingSourced>[4]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<Parameters<MappingInspector>[4]>, UpstreamLedgerView>,
      true satisfies SameType<NonNullable<MappingInput["ledger"]>, UpstreamLedgerView>,
    ];
    const ledger: NonNullable<MappingInput["ledger"]> = PROPERTY_LEDGER_VIEW;
    // @ts-expect-error C2 の段の台帳は旗 ids の T2 の文を持たない
    void ledger.t2IdsFormTexts;
    // @ts-expect-error C2 の段の引き当ての値は T1 の記述子だけ（T2 の試験の型を読めない）
    void ledger.rowByVerificationKind.get("default-value")?.t2;
    expect(same).toHaveLength(8);
    expect(ledger.t1RuleTexts).toEqual(PROPERTY_LEDGER_VIEW.t1RuleTexts);
  });
});
