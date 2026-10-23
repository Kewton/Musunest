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
import {
  CHECK_TARGET_MESSAGES,
  IDS_NO_SOURCE,
  checkMappedTable,
  nameTableSha256,
  ownersByRowId,
  type NameTable,
  type NameTableDraftVerification,
  type NameTableRow,
  type NameTableVerification,
} from "../../v11a/names.js";
import { generateTests } from "../generated-tests.js";
import type { RequirementList } from "../../pipeline.js";
import { semanticCheckTargets } from "../../v11a/stages/semantic-check.js";
import { PROPERTY_LEDGER_VIEW, type LedgerView, type UpstreamLedgerView } from "../ledger.js";
import type { ReferenceCounts } from "../ids.js";
import {
  MAPPING_DATA_NAMES,
  MAPPING_LEDGER_DATA_NAMES,
  MAPPING_MESSAGES,
  MAPPING_NORMALIZATION_DEFINITIONS,
  MAPPING_NORMALIZATION_REASON,
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
  normalizeMappedTable,
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
/** C2 の応答の checks（検査の種類ごとの欄）を、渡した値のまま組む：渡した欄のほかは null（Issue #682。直す前の写像の欄も組める） */
const rawFields = (set: Partial<Record<StructuralAssertionKind, unknown>> = {}): Entry =>
  Object.fromEntries(STRUCTURAL_ASSERTIONS.map((check) => [check, set[check] ?? null]));
/**
 * C2 の応答の checks（検査の種類ごとの欄。各欄は null か対象の並び。Issue #724）：渡した欄のほかは null。写像 1 つを渡した欄は
 * その 1 件の並びにする（並びはそのまま）
 */
const fields = (set: Partial<Record<StructuralAssertionKind, unknown>> = {}): Entry =>
  Object.fromEntries(
    STRUCTURAL_ASSERTIONS.map((check) => {
      const value = set[check] ?? null;
      return [check, value !== null && typeof value === "object" && !Array.isArray(value) ? [value] : value];
    }),
  );
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
  it("規則の定義に why・since があり不備 0（台帳の文で組み直しても）。schema は strict で写し・出典の欄が無く、checks は検査の種類ごとの欄（Issue #682）で、各欄は null か対象の写像の並び（Issue #724）", () => {
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
        // 各欄は null か対象の写像の並び（Issue #724。直す前は null か対象の写像）。view-shows の要素だけ sourceId（文字列）を持つ。
        // 空の並びは schema の minItems に頼らず復号の形の検査で断る
        expect(field["type"], check).toEqual(["array", "null"]);
        expect("minItems" in field, check).toBe(false);
        const item = field["items"] as Entry;
        expect(item["type"], check).toBe("object");
        expect(item["additionalProperties"], check).toBe(false);
        expect(item["required"], check).toEqual(check === "view-shows" ? ["targetId", "sourceId"] : ["targetId"]);
        expect(((item["properties"] as Entry)["targetId"] as Entry)["type"], check).toBe("string");
        if (check === "view-shows") expect(((item["properties"] as Entry)["sourceId"] as Entry)["type"]).toBe("string");
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

  it("二点測定 (1)：同じ要件に同じ種類の検査を 2 行に書いた応答は、直す前の形（並び）なら表の検査の固定文で落ちた。その形は今の schema に合わない（形の固定文）。同じ内容は欄の対象の並びに書ける（Issue #724）", async () => {
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
    // Issue #724：同じ内容は欄の対象の並び（view-shows の欄に 2 件）に書け、今の schema に合う（#682 では欄の写像に 2 件目を書く場所が無かった）
    const listed = withChecksAt(1, checkFieldsResponseOf([
      { check: "view-shows", targetId: "V2", sourceId: "E1.F1" },
      { check: "view-shows", targetId: "V1", sourceId: "E2.F1" },
    ]));
    expect(validateSchema(mappingSchemaOf(), listed)).toBeUndefined();
    expect(validateSchema(mappingSchemaOf(PROPERTY_LEDGER_VIEW), listed)).toBeUndefined();
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
        index === 1 ? { ...entry, verification: { ...r2, checks: { ...(r2["checks"] as Entry), "aggregate-no-period": [{ targetId: "C2" }] } } } : entry,
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

  it("要求：R-map-03 の新しい文（対象の並び・同じ組を 2 回書かない〔Issue #724〕・当たる種類が無い要件の選び方・制約 ID 1 件以上）があり、ほかの規則の文・順・データの塊の名前は直す前と同じ", () => {
    for (const definitions of [MAPPING_RULE_DEFINITIONS, mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)]) {
      expect(definitions.map((definition) => definition.id)).toEqual(["R-map-01", "R-map-02", "R-map-03", "R-map-04"]);
      const r3 = definitions.find((definition) => definition.id === "R-map-03")?.text ?? "";
      for (const phrase of [
        "checks は検査の種類ごとの欄で、各欄は検査の対象の並びである。",
        "view-shows の対象は sourceId に画面と同じ entity の項目か計算の行の ID",
        "使わない種類の欄は空の並びにせず null にする。",
        "同じ種類の検査を 2 つ以上の行に掛けて確かめる要件は、その種類の欄に行ごとに 1 件ずつ並べる。同じ組（view-shows は画面と表示元の組、ほかは行）を 2 回書かない。",
        "structural は、検査の種類のうち 1 つ以上で確かめられる要件だけである。",
        "確かめ方の種類を選ぶ既存の条件（default-value など、専用の種類を指定する文）は今までどおり先に当てる。",
        "欄が全部 null の structural は表の検査で断られる。",
        "使わない欄は null か空の並びにする。",
      ]) {
        expect(r3, phrase).toContain(phrase);
      }
      // unresolved の根拠の文：台帳を受けない版は文書の制約 ID だけ（直す前と同じ文）、台帳を受けた版は台帳の未対応の観測を足した
      // 文（構造の文の中の誘導も同じ条件。Issue #725。台帳版の期待をこの節で置き換えた）
      const documentOnly = [
        "そのうえで structural にしようとした要件に当たる種類が 1 つも無いなら（行が在ることだけを求める要件など）structural にせず、固定した試験で確かめられるなら fixed-test、宣言で書けず根拠となる文書の制約 ID を一覧から 1 件以上挙げられるなら unresolved にする。",
        "constraintIds に書けない根拠となる文書の制約 ID を 1 件以上（文書の制約 ID の一覧にあるものだけ）書く。",
        "根拠となる制約 ID を一覧から挙げられない要件は unresolved にしない。",
      ];
      const withLedger = [
        "そのうえで structural にしようとした要件に当たる種類が 1 つも無いなら（行が在ることだけを求める要件など）structural にせず、固定した試験で確かめられるなら fixed-test、宣言で書けないか台帳が未対応とする観測でしか確かめられず、根拠の ID を文書の制約 ID の一覧か台帳の未対応の観測の一覧から 1 件以上挙げられるなら unresolved にする。",
        "宣言で書けない、または台帳が未対応とする観測でしか確かめられない要件は kind を unresolved にし、reason に理由を書き、constraintIds に根拠の ID を 1 件以上（文書の制約 ID の一覧か台帳の未対応の観測の一覧にあるものだけ）書く。根拠を一覧から挙げられない要件は unresolved にしない。",
      ];
      const [present, absent] = definitions === MAPPING_RULE_DEFINITIONS ? [documentOnly, withLedger] : [withLedger, documentOnly];
      for (const phrase of present) expect(r3, phrase).toContain(phrase);
      for (const phrase of absent) expect(r3, phrase).not.toContain(phrase);
      // Issue #724 で外した文（#682 の 1 種類 1 件と、2 つ以上の行に掛ける要件の fixed-test への選び方）
      expect(r3).not.toContain("同じ種類の検査は要件ごとに 1 件である");
      expect(r3).not.toContain("2 つ以上の行に掛けなければ確かめられない要件");
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
    // 台帳の文で組み直す版は R-map-03 の頭が、unresolved の 2 文（構造の文の中の誘導と未解決の文）だけを台帳の版に差し替えた
    // 通常版の頭と同じ（台帳の文の前に構造・未解決の文が来る。Issue #725 で startsWith の期待をこの差し替えの一致に置き換えた）
    const plain = MAPPING_RULE_DEFINITIONS.find((definition) => definition.id === "R-map-03")?.text ?? "";
    const ledger = mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW).find((definition) => definition.id === "R-map-03")?.text ?? "";
    const head = plain.slice(0, plain.indexOf("要件の決まりが"));
    const ledgerHead = head
      .replace(
        "宣言で書けず根拠となる文書の制約 ID を一覧から 1 件以上挙げられるなら unresolved にする。",
        "宣言で書けないか台帳が未対応とする観測でしか確かめられず、根拠の ID を文書の制約 ID の一覧か台帳の未対応の観測の一覧から 1 件以上挙げられるなら unresolved にする。",
      )
      .replace(
        "宣言で書けない要件は kind を unresolved にし、reason に理由、constraintIds に書けない根拠となる文書の制約 ID を 1 件以上（文書の制約 ID の一覧にあるものだけ）書く。根拠となる制約 ID を一覧から挙げられない要件は unresolved にしない。",
        "宣言で書けない、または台帳が未対応とする観測でしか確かめられない要件は kind を unresolved にし、reason に理由を書き、constraintIds に根拠の ID を 1 件以上（文書の制約 ID の一覧か台帳の未対応の観測の一覧にあるものだけ）書く。根拠を一覧から挙げられない要件は unresolved にしない。",
      );
    expect(ledgerHead).not.toBe(head);
    expect(ledger.startsWith(ledgerHead)).toBe(true);
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

describe("C2 が組んだ表を整える手（N-map-01・N-map-02。Issue #723）", () => {
  // 行（コードの形の ID・出典なし）。E1 の項目：F1 文字列・F2 参照（→E2）・F3 参照の並び（→E2）・F4 参照先の無い並び。E2 の項目：
  // F1 文字列・F2 選択肢。操作：OP1（when 無し・E1）・OP2（when 付き・E1）・OP3（when 無し・E2）。画面：V1（E1）
  const rowOf = (
    id: string,
    kind: NameTableRow["kind"],
    entity: string | null,
    name: string,
    type: NameTableRow["type"],
    extra: Partial<Pick<NameTableRow, "options" | "refEntity">> = {},
  ): NameTableRow => ({
    id,
    kind,
    entity,
    name,
    role: `${id} の役割`,
    source: IDS_NO_SOURCE,
    type,
    options: extra.options ?? null,
    groupBy: null,
    refEntity: extra.refEntity ?? null,
  });
  const ROWS: readonly NameTableRow[] = [
    rowOf("E1", "entity", null, "alpha", null),
    rowOf("E2", "entity", null, "beta", null),
    rowOf("E1.F1", "field", "E1", "label", "string"),
    rowOf("E1.F2", "field", "E1", "target", "ref", { refEntity: "E2" }),
    rowOf("E1.F3", "field", "E1", "targets", "list", { refEntity: "E2" }),
    rowOf("E1.F4", "field", "E1", "notes", "list"),
    rowOf("E2.F1", "field", "E2", "label", "string"),
    rowOf("E2.F2", "field", "E2", "grade", "enum", { options: ["a", "b"] }),
    rowOf("OP1", "operation", "E1", "addAlpha", { action: "create", hasWhen: false }),
    rowOf("OP2", "operation", "E1", "markAlpha", { action: "update", hasWhen: true }),
    rowOf("OP3", "operation", "E2", "dropBeta", { action: "delete", hasWhen: false }),
    rowOf("V1", "screen", "E1", "alphas", { view: "table" }),
  ];
  const ALL_IDS = ROWS.map((row) => row.id);
  /** 要件の仕様：所属は `s:ID`（stated）か `d:ID`（dependency）。確かめ方の既定は fixed-test */
  type Spec = { readonly id: string; readonly roles: readonly string[]; readonly verification?: NameTableDraftVerification };
  const roleOf = (text: string) =>
    text.startsWith("s:") ? { id: text.slice(2), basis: "stated" as const, reason: null } : { id: text.slice(2), basis: "dependency" as const, reason: "実現に要る" };
  /** 表の残りの行を全部 stated で持つ要件（`except` の行は持たない。手の当たらない fixed-test） */
  const cover = (except: readonly string[] = []): Spec => ({ id: "R9", roles: ALL_IDS.filter((id) => !except.includes(id)).map((id) => `s:${id}`) });
  const listOf = (specs: readonly Spec[]): RequirementList => ({
    requirements: specs.map((spec) => {
      const text = `要件 ${spec.id} の文。`;
      return { id: spec.id, text, quote: text, position: { start: 0, end: text.length } };
    }),
    decisions: [],
    unresolved: [],
  });
  const tableOf = (specs: readonly Spec[]): NameTable => ({
    rows: ROWS,
    ownership: specs.map((spec) => ({ requirementId: spec.id, roles: spec.roles.map(roleOf) })),
    verification: specs.map((spec) => ({ ...(spec.verification ?? { kind: "fixed-test" as const }), requirementId: spec.id }) as NameTableVerification),
    classification: specs.map((spec) => ({ requirementId: spec.id, nature: "ruled" as const })),
  });
  /** 表を C2 の応答の形（検査の種類ごとの欄）に戻す */
  const responseOf = (table: NameTable): Entry => ({
    requirements: table.verification.map((verification, index) => {
      const { requirementId, ...rest } = verification;
      const { targets: _targets, ...withoutTargets } = rest as typeof rest & { readonly targets?: unknown };
      return {
        requirementId,
        roles: table.ownership[index]?.roles ?? [],
        verification: {
          value: null,
          reason: null,
          constraintIds: [],
          ...withoutTargets,
          checks: verification.kind === "structural" ? checkFieldsResponseOf(verification.targets ?? []) : null,
        },
        nature: table.classification[index]?.nature,
      };
    }),
  });
  const FIELD_TYPE_OF = (requirementId: string, targetId: string): NameTableVerification => ({
    requirementId,
    kind: "structural",
    reason: MAPPING_NORMALIZATION_REASON,
    checks: ["field-type"],
    targets: [{ check: "field-type", targetId, sourceId: null }],
  });
  const messagesOfProblems = (problems: readonly { readonly field: string; readonly message: string }[]) => problems.map((problem) => `${problem.field}:${problem.message}`);
  /** 当たった要件と外した行の集合（要件 ID で対応づける。順に依らない比較用） */
  const hitsOf = (normalized: ReturnType<typeof normalizeMappedTable>["normalized"]) =>
    Object.fromEntries(normalized.map((entry) => [entry.requirementId, { rule: entry.rule, targetId: entry.targetId, removed: [...entry.removedRowIds].sort() }]));
  const deepFreeze = <T,>(value: T): T => {
    if (value !== null && typeof value === "object") {
      for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
      Object.freeze(value);
    }
    return value;
  };

  it("手の定義に why・since があり不備 0。ID は N-map-01・N-map-02 の 2 つ（規則の文の定義とは別。LLM に送らない）", () => {
    expect(ruleDefinitionDefects(MAPPING_NORMALIZATION_DEFINITIONS)).toEqual([]);
    expect(MAPPING_NORMALIZATION_DEFINITIONS.map((definition) => definition.id)).toEqual(["N-map-01", "N-map-02"]);
    for (const definition of MAPPING_NORMALIZATION_DEFINITIONS) {
      expect(definition.why.trim()).not.toBe("");
      expect(definition.since).toBe("Issue #723");
    }
    const sent = ruleTexts(mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)).join("\n");
    for (const definition of MAPPING_NORMALIZATION_DEFINITIONS) expect(sent.includes(definition.text)).toBe(false);
    expectNoAcceptanceMaterial([...MAPPING_NORMALIZATION_DEFINITIONS.flatMap((definition) => [definition.text, definition.why]), MAPPING_NORMALIZATION_REASON]);
  });

  describe("(1) 手 1 の正例", () => {
    const specs: readonly Spec[] = [
      { id: "R1", roles: ["s:E1.F2"] },
      { id: "R2", roles: ["s:E1.F2", "d:E1", "d:E2"] },
      { id: "R3", roles: ["s:E1.F3", "d:E2"] },
      cover(),
    ];
    const raw = tableOf(specs);

    it("参照の項目 1 行（とその entity・参照先の entity）だけの fixed-test は structural・field-type 1 件・targets はその項目・reason は固定文。並びの項目も同じ。所属は変えない", () => {
      const { table, normalized } = normalizeMappedTable(raw);
      expect(table.verification).toEqual([FIELD_TYPE_OF("R1", "E1.F2"), FIELD_TYPE_OF("R2", "E1.F2"), FIELD_TYPE_OF("R3", "E1.F3"), raw.verification[3]]);
      expect(table.ownership).toEqual(raw.ownership);
      expect(table.rows).toBe(raw.rows);
      expect(table.classification).toEqual(raw.classification);
      expect(normalized).toEqual([
        { requirementId: "R1", rule: "N-map-01", targetId: "E1.F2", removedRowIds: [] },
        { requirementId: "R2", rule: "N-map-01", targetId: "E1.F2", removedRowIds: [] },
        { requirementId: "R3", rule: "N-map-01", targetId: "E1.F3", removedRowIds: [] },
      ]);
      // 応答から組む段の口（C2'）でも同じ表になり、C2' を通る
      const inspected = inspectMappingSourced(listOf(specs), ROWS, responseOf(raw), FIXTURE_DOCUMENTS, PROPERTY_LEDGER_VIEW);
      expect(inspected.ok).toBe(true);
      if (inspected.ok) {
        expect(inspected.table).toEqual(table);
        expect(inspected.normalized).toEqual(normalized);
      }
    });

    it("整えた表から generateTests は、その要件に構造の検査 1 本（期待は種類と参照先）を作り、画面・在ることの試験を作らない（整える前は在ることの試験を作る）", () => {
      const list = listOf(specs);
      const { table } = normalizeMappedTable(raw);
      const made = generateTests({ table, ledger: PROPERTY_LEDGER_VIEW, list });
      expect(made.stopped).toEqual([]);
      const testsOf = (tests: typeof made.tests, id: string) => tests.filter((test) => test.target.requirementId === id);
      for (const [id, target, expected] of [
        ["R1", "E1.F2", "ref"],
        ["R3", "E1.F3", "list"],
      ] as const) {
        const tests = testsOf(made.tests, id);
        expect(tests).toHaveLength(1);
        expect(tests[0]?.target).toMatchObject({ kind: "field", roleId: target });
        expect(tests[0]?.assertion).toEqual({ check: "field-type", expected, refEntity: "E2" });
        expect(made.excludedRequirementIds).toContain(id);
      }
      const before = generateTests({ table: raw, ledger: PROPERTY_LEDGER_VIEW, list });
      expect(testsOf(before.tests, "R1").some((test) => test.assertion === undefined)).toBe(true);
      expect(before.excludedRequirementIds).not.toContain("R1");
    });
  });

  it("(2) 手 1 の負例：項目 2 行・ref でない項目・参照先の無い並び・操作か画面を含む・structural／unresolved／default-value・所属に表に無い ID は当てない", () => {
    const negatives: readonly Spec[] = [
      { id: "R1", roles: ["s:E1.F2", "s:E1.F3"] },
      { id: "R2", roles: ["s:E1.F1"] },
      { id: "R3", roles: ["s:E1.F4"] },
      { id: "R4", roles: ["s:E1.F2", "s:OP2"] },
      { id: "R5", roles: ["s:E1.F2", "s:V1"] },
      {
        id: "R6",
        roles: ["s:E1.F2"],
        verification: { kind: "structural", reason: "構造で確かめる", checks: ["field-type"], targets: [{ check: "field-type", targetId: "E1.F2", sourceId: null }] },
      },
      { id: "R7", roles: ["s:E1.F2"], verification: { kind: "unresolved", reason: "書けない", constraintIds: [constraintIdsIn(FIXTURE_DOCUMENTS).values().next().value as string] } },
      { id: "R8", roles: ["s:E2.F2"], verification: { kind: "default-value", value: "a" } },
      { id: "R10", roles: ["s:E1.F2", "s:E9"] },
      cover(),
    ];
    const raw = tableOf(negatives);
    const { table, normalized } = normalizeMappedTable(raw);
    expect(normalized).toEqual([]);
    expect(table).toBe(raw);
  });

  it("(3) 手 2 の正例：stated の項目と dependency の when 無しの操作（ほかの要件も所属させる）→ 外れ、外した行 ID が結果に載る。when 付きの操作・stated の操作・dependency の項目・画面は残る", () => {
    const specs: readonly Spec[] = [{ id: "R1", roles: ["s:E1.F1", "s:OP3", "d:OP1", "d:OP2", "d:E2.F1", "d:V1"] }, cover()];
    const raw = tableOf(specs);
    const { table, normalized } = normalizeMappedTable(raw);
    expect(normalized).toEqual([{ requirementId: "R1", rule: "N-map-02", targetId: null, removedRowIds: ["OP1"] }]);
    expect(table.ownership[0]?.roles.map((role) => role.id)).toEqual(["E1.F1", "OP3", "OP2", "E2.F1", "V1"]);
    expect(table.ownership[1]).toEqual(raw.ownership[1]);
    expect(table.verification).toEqual(raw.verification);
    expect(checkMappedTable(listOf(specs), raw, FIXTURE_DOCUMENTS)).toEqual([]);
    expect(checkMappedTable(listOf(specs), table, FIXTURE_DOCUMENTS)).toEqual([]);
  });

  describe("(4) 手 2 の負例と、結果が候補の集合で決まること", () => {
    it("全部 dependency／その操作をほかの要件が持たない／操作の entity をほかに持たない → 残る（所属の無い行は増えない）", () => {
      const cases: readonly (readonly Spec[])[] = [
        [{ id: "R1", roles: ["d:E1.F1", "d:OP1"] }, cover()],
        [{ id: "R1", roles: ["s:E1.F1", "d:OP1"] }, cover(["OP1"])],
        [{ id: "R1", roles: ["s:E1.F1", "d:OP3"] }, cover(["OP3", "E2", "E2.F1", "E2.F2"])],
      ];
      for (const specs of cases) {
        const raw = tableOf(specs);
        const { table, normalized } = normalizeMappedTable(raw);
        expect(normalized).toEqual([]);
        expect(table).toBe(raw);
        expect([...ownersByRowId(table).keys()].sort()).toEqual([...ownersByRowId(raw).keys()].sort());
      }
    });

    it("共有の操作を 2 つの要件がともに dependency で持ち、ほかに持ち主が無い → 両方残る。片方が stated で持つ対照では他方から外れる", () => {
      const both = tableOf([{ id: "R1", roles: ["s:E1.F1", "d:OP1"] }, { id: "R2", roles: ["s:E2.F1", "d:OP1"] }, cover(["OP1"])]);
      expect(normalizeMappedTable(both).normalized).toEqual([]);
      const control = tableOf([{ id: "R1", roles: ["s:E1.F1", "d:OP1"] }, { id: "R2", roles: ["s:E2.F1", "s:OP1"] }, cover(["OP1"])]);
      const { table, normalized } = normalizeMappedTable(control);
      expect(normalized).toEqual([{ requirementId: "R1", rule: "N-map-02", targetId: null, removedRowIds: ["OP1"] }]);
      expect(table.ownership[1]).toEqual(control.ownership[1]);
    });

    it("normalized は仮に外した分でなく最終の差分（孤立で戻した候補は載らない）", () => {
      // 全部外すと OP1 が孤立するので OP1 の候補を戻す。OP3 は R9 が持つので R1 から外れたまま
      const raw = tableOf([{ id: "R1", roles: ["s:E1.F1", "d:OP1", "d:OP3"] }, { id: "R2", roles: ["s:E2.F1", "d:OP1"] }, cover(["OP1"])]);
      const { table, normalized } = normalizeMappedTable(raw);
      expect(normalized).toEqual([{ requirementId: "R1", rule: "N-map-02", targetId: null, removedRowIds: ["OP3"] }]);
      expect(table.ownership.map((entry) => entry.roles.map((role) => role.id))).toEqual([["E1.F1", "OP1"], ["E2.F1", "OP1"], raw.ownership[2]?.roles.map((role) => role.id)]);
    });

    it("所属に同じ行 ID の重複か表に無い ID がある要件には当てない", () => {
      for (const roles of [["s:E1.F1", "d:OP1", "d:OP1"], ["s:E1.F1", "d:OP1", "s:E9"]]) {
        const raw = tableOf([{ id: "R1", roles }, cover()]);
        expect(normalizeMappedTable(raw).normalized).toEqual([]);
      }
    });

    it("並べ替えた入力（要件の順・所属の順）の間で、要件 ID・行 ID で対応づけた結果が同じ。同じ入力からは順序・表・SHA が同じ", async () => {
      const specs: readonly Spec[] = [
        { id: "R1", roles: ["s:E1.F1", "d:OP1", "d:OP3"] },
        { id: "R2", roles: ["s:E2.F1", "d:OP1"] },
        { id: "R3", roles: ["s:E1.F2", "d:E2"] },
        { id: "R4", roles: ["s:E1.F3", "d:OP3"] },
        cover(["OP1"]),
      ];
      const permuted = [...specs].reverse().map((spec) => ({ ...spec, roles: [...spec.roles].reverse() }));
      const a = normalizeMappedTable(tableOf(specs));
      const b = normalizeMappedTable(tableOf(permuted));
      expect(hitsOf(b.normalized)).toEqual(hitsOf(a.normalized));
      expect(hitsOf(a.normalized)).toEqual({
        R1: { rule: "N-map-02", targetId: null, removed: ["OP3"] },
        R3: { rule: "N-map-01", targetId: "E1.F2", removed: [] },
        R4: { rule: "N-map-02", targetId: null, removed: ["OP3"] },
      });
      const again = normalizeMappedTable(tableOf(specs));
      expect(again).toEqual(a);
      expect(await nameTableSha256(again.table)).toBe(await nameTableSha256(a.table));
    });
  });

  describe("(5) 門の不変", () => {
    it("整える前に C2' を通る表は整えたあとも通り、整える前に落ちる表（孤立行・重なり・制約 ID 空・所属 0）は同じ固定文で落ちる", () => {
      const hit: Spec = { id: "R1", roles: ["s:E1.F1", "d:OP1"] };
      const ref: Spec = { id: "R2", roles: ["s:E1.F2"] };
      const passing = [tableOf([hit, ref, cover()]), tableOf([{ id: "R1", roles: ["s:E1.F3", "d:E2"] }, cover()])];
      for (const raw of passing) {
        const list = listOf(raw.ownership.map((entry) => ({ id: entry.requirementId, roles: [] })));
        expect(checkMappedTable(list, raw, FIXTURE_DOCUMENTS)).toEqual([]);
        const { table, normalized } = normalizeMappedTable(raw);
        expect(normalized.length).toBeGreaterThan(0);
        expect(checkMappedTable(list, table, FIXTURE_DOCUMENTS)).toEqual([]);
      }
      const failing: readonly (readonly Spec[])[] = [
        [hit, ref, cover(["V1"])],
        [hit, ref, { id: "R3", roles: ["s:E1.F1", "s:E1.F1"] }, cover()],
        [hit, ref, { id: "R3", roles: ["s:E1.F1"], verification: { kind: "unresolved", reason: "書けない", constraintIds: [] } }, cover()],
        [hit, ref, { id: "R3", roles: [] }, cover()],
      ];
      const expected = ["どの要件にも所属しない行がある", "同じ要件の中で所属が重なっている", "未解決の要件に制約 ID が無い", "固定した試験で確かめる要件に所属が無い"];
      failing.forEach((specs, index) => {
        const list = listOf(specs);
        const raw = tableOf(specs);
        const before = checkMappedTable(list, raw, FIXTURE_DOCUMENTS);
        const { table, normalized } = normalizeMappedTable(raw);
        expect(normalized.map((entry) => entry.requirementId)).toEqual(["R1", "R2"]);
        expect(messagesOfProblems(checkMappedTable(list, table, FIXTURE_DOCUMENTS))).toEqual(messagesOfProblems(before));
        expect(before.map((problem) => problem.message)).toContain(expected[index]);
      });
    });

    const dupSpecs: readonly Spec[] = [{ id: "R1", roles: ["s:E1.F1", "d:OP1", "d:OP1"] }, { id: "R2", roles: ["s:E2.F1"] }, { id: "R3", roles: ["s:E2.F2", "s:OP1"] }, cover(["OP1"])];
    const dupList = listOf(dupSpecs);
    const dupResponse = responseOf(tableOf(dupSpecs));
    const goodResponse = responseOf(tableOf([{ id: "R1", roles: ["s:E1.F1", "d:OP1"] }, ...dupSpecs.slice(1)]));
    const r1Of = (output: Entry) => withEntries((output["requirements"] as Entry[]).filter((entry) => entry["requirementId"] === "R1"));
    const runCustom = async (outputs: readonly unknown[], previous?: MappingPrevious) => {
      const recording = createCheckedRecordingClient(outputs.map(recordedStructured));
      const outcome = await runMapping({
        plan: planOf(dupList),
        list: dupList,
        documents: FIXTURE_DOCUMENTS,
        gateway: makeGateway(recording.client),
        rows: ROWS,
        ledger: PROPERTY_LEDGER_VIEW,
        ...(previous === undefined ? {} : { previous }),
      });
      return { outcome, recording };
    };

    it("stated の項目と同じ when 無しの操作を dependency で 2 回持つ要件（その操作をほかの要件が stated で持つ）は、初回・書き直しの合併・2 回目の合併のどれでも重なりの固定文で落ちる", async () => {
      const first = inspectMappingSourced(dupList, ROWS, dupResponse, FIXTURE_DOCUMENTS, PROPERTY_LEDGER_VIEW);
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.problems.map((problem) => problem.message)).toEqual(["同じ要件の中で所属が重なっている"]);
      // 初回の落ちは R1 に帰属するので R1 だけを書き直させ、書き直しも重なれば合併後の C2' が同じ文で落とす
      const rewritten = await runCustom([dupResponse, r1Of(dupResponse)]);
      expect(rewritten.recording.structured).toHaveLength(2);
      expect(rewritten.outcome.ok).toBe(false);
      expect(messagesOf(rewritten.outcome)).toEqual(["同じ要件の中で所属が重なっている"]);
      // C3 の拒否のあとの 2 回目（R1 を拒否）も同じ
      const previous: MappingPrevious = {
        response: goodResponse,
        rejections: [{ requirementId: "R1", kind: "unnecessary-ownership", quote: "要件 R1 の文" }] as unknown as MappingPrevious["rejections"],
        advice: [],
      };
      const second = await runCustom([r1Of(dupResponse)], previous);
      expect(second.recording.structured).toHaveLength(1);
      expect(messagesOf(second.outcome)).toEqual(["同じ要件の中で所属が重なっている"]);
    });

    it("(6) 落ちた要件だけの書き直しの合併と、C3 の拒否のあとの 2 回目の合併にも同じ手が当たる。結果の response は整える前の raw で、2 回目の要求の「前回の写像」も raw。初回の要求は手の当たり方に依らない", async () => {
      // 初回：R2 の所属に表に無い ID（R2 に帰属）→ R2 だけ書き直す。合併した表で R1 の OP1（R3 が stated で持つ）が外れる
      const r2Bad = withEntries((goodResponse["requirements"] as Entry[]).map((entry) => (entry["requirementId"] === "R2" ? { ...entry, roles: [...(entry["roles"] as Entry[]), { id: "E9", basis: "stated", reason: null }] } : entry)));
      const r2Only = withEntries((goodResponse["requirements"] as Entry[]).filter((entry) => entry["requirementId"] === "R2"));
      const merged = await runCustom([r2Bad, r2Only]);
      expect(merged.recording.structured).toHaveLength(2);
      expect(merged.outcome.ok).toBe(true);
      if (!merged.outcome.ok) return;
      expect(merged.outcome.value.normalized).toEqual([{ requirementId: "R1", rule: "N-map-02", targetId: null, removedRowIds: ["OP1"] }]);
      expect(merged.outcome.value.response).toEqual(goodResponse);
      expect(merged.outcome.value.table.ownership[0]?.roles.map((role) => role.id)).toEqual(["E1.F1"]);
      expect(merged.outcome.value.tableSha256).toBe(await nameTableSha256(merged.outcome.value.table));
      // 初回の要求は、手が当たらない応答を返す走りの初回の要求とバイト列で同じ
      const plain = await runCustom([responseOf(tableOf([{ id: "R1", roles: ["s:E1.F1"] }, ...dupSpecs.slice(1)]))]);
      expect(JSON.stringify(merged.recording.structured[0])).toBe(JSON.stringify(plain.recording.structured[0]));
      // 2 回目：R2 を拒否。前回の写像は raw（R1 が OP1 を dependency で持つまま）で、合併した表にまた手が当たる
      const previous: MappingPrevious = {
        response: merged.outcome.value.response,
        rejections: [{ requirementId: "R2", kind: "weak-verification", quote: "要件 R2 の文" }] as unknown as MappingPrevious["rejections"],
        advice: [],
      };
      const second = await runCustom([r2Only], previous);
      expect(blockOf(second.recording.structured[0]?.input, MAPPING_DATA_NAMES.response)).toEqual(goodResponse);
      expect(second.outcome.ok).toBe(true);
      if (second.outcome.ok) {
        expect(second.outcome.value.normalized).toEqual(merged.outcome.value.normalized);
        expect(second.outcome.value.response).toEqual(goodResponse);
      }
    });

    it("(9) 書き直した要件が共有の操作を手放すと、保持した要件の手 2 の可否が変わる：合併した全表に手が掛かり直す", async () => {
      // 初回：R1・R3 がともに OP1 を dependency で持ち、ほかに持ち主が無い → どちらも外れない
      const shared: readonly Spec[] = [{ id: "R1", roles: ["s:E1.F1", "d:OP1"] }, { id: "R2", roles: ["s:E2.F1"] }, { id: "R3", roles: ["s:E2.F2", "d:OP1"] }, cover(["OP1"])];
      const sharedResponse = responseOf(tableOf(shared));
      const first = await runCustom([sharedResponse]);
      expect(first.outcome.ok && first.outcome.value.normalized).toEqual([]);
      // C3 が R3 を拒否し、R3 が OP1 を stated で持つ形に書き直す → 保持した R1 から OP1 が外れる
      const r3Stated = withEntries((goodResponse["requirements"] as Entry[]).filter((entry) => entry["requirementId"] === "R3"));
      const previous: MappingPrevious = {
        response: sharedResponse,
        rejections: [{ requirementId: "R3", kind: "missing-target", quote: "要件 R3 の文" }] as unknown as MappingPrevious["rejections"],
        advice: [],
      };
      const second = await runCustom([r3Stated], previous);
      expect(second.outcome.ok).toBe(true);
      if (second.outcome.ok) {
        expect(second.outcome.value.normalized).toEqual([{ requirementId: "R1", rule: "N-map-02", targetId: null, removedRowIds: ["OP1"] }]);
        expect(second.outcome.value.table.ownership[0]?.roles.map((role) => role.id)).toEqual(["E1.F1"]);
      }
    });
  });

  it("(8) 手の非破壊：raw を凍結した入力で、整えた表に手を再適用すると 1 回の結果と異なる例がある。段は raw から 1 回しか当てず、同じ raw から同じ表になる", async () => {
    // 参照の項目 1 行の stated と、共有の when 無しの操作の dependency を持つ fixed-test：1 回目は手 2 だけ、2 回目なら手 1 に当たる
    const specs: readonly Spec[] = [{ id: "R1", roles: ["s:E1.F2", "d:OP1"] }, cover()];
    const list = listOf(specs);
    const raw = deepFreeze(tableOf(specs));
    const once = normalizeMappedTable(raw);
    expect(once.normalized).toEqual([{ requirementId: "R1", rule: "N-map-02", targetId: null, removedRowIds: ["OP1"] }]);
    expect(once.table.verification[0]?.kind).toBe("fixed-test");
    const twice = normalizeMappedTable(once.table);
    expect(twice.normalized).toEqual([{ requirementId: "R1", rule: "N-map-01", targetId: "E1.F2", removedRowIds: [] }]);
    expect(twice.table).not.toEqual(once.table);
    // 段（C2' の口）は応答から組んだ表に 1 回だけ当てる：凍結した同じ応答から 2 回とも 1 回の結果
    const response = deepFreeze(responseOf(tableOf(specs)));
    const shaOf = async () => {
      const inspected = inspectMappingSourced(list, ROWS, response, FIXTURE_DOCUMENTS, PROPERTY_LEDGER_VIEW);
      if (!inspected.ok) throw new Error("前提が壊れた：通る応答であること");
      expect(inspected.table).toEqual(once.table);
      expect(inspected.normalized).toEqual(once.normalized);
      return nameTableSha256(inspected.table);
    };
    expect(await shaOf()).toBe(await shaOf());
    expect(await shaOf()).toBe(await nameTableSha256(once.table));
    expect(response).toEqual(responseOf(tableOf(specs)));
  });

  it("要求・試験の題材に受入の題材の言葉が無い", () => {
    expectNoAcceptanceMaterial([JSON.stringify(ROWS), ...listOf([cover()]).requirements.map((requirement) => requirement.text)]);
  });
});

describe("検査の対象の並び（同じ種類の検査を 2 つ以上の行に掛ける。Issue #724）", () => {
  /** R3 を、同じ種類（action-kind）の検査を 2 つの操作（OP1・OP2）に掛ける structural にした応答（所属は項目だけ。操作は検査の対象から足す） */
  const twoOperations = (
    checks: unknown = fields({ "action-kind": [{ targetId: "OP1" }, { targetId: "OP2" }] }),
    roles: readonly Entry[] = [{ id: "E2.F3", basis: "stated", reason: null }],
  ) =>
    withEntries(
      entries().map((entry, index) =>
        index === 2
          ? {
              ...entry,
              roles: [...roles],
              verification: { kind: "structural", value: null, reason: "操作の種類を確かめる", checks, constraintIds: [] },
            }
          : entry,
      ),
    );
  /** R2 の view-shows を、同じ画面 V2 に表示元 2 つ（E1.F1・C1。どちらも V2 と同じ entity）を掛けた応答 */
  const twoSources = () => withChecksAt(1, fields({ "view-shows": [{ targetId: "V2", sourceId: "E1.F1" }, { targetId: "V2", sourceId: "C1" }] }));
  const r3Of = (table: NameTable) => table.verification.find((entry) => entry.requirementId === "R3");

  for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
    const label = ledger === undefined ? "ledger off" : "ledger on";
    it(`二点測定 (1)（${label}）：同じ種類を 2 つの操作に掛けた応答は問題 0 で、表の checks に同じ種類が 2 回・targets に 2 つの対象が並び、2 行とも所属に足される`, async () => {
      const output = twoOperations();
      expect(validateSchema(mappingSchemaOf(ledger), output)).toBeUndefined();
      const inspected = inspectMapping(LIST, TABLE.rows, output, FIXTURE_DOCUMENTS, ledger);
      expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
      if (!inspected.ok) return;
      expect(r3Of(inspected.table)).toEqual({
        requirementId: "R3",
        kind: "structural",
        reason: "操作の種類を確かめる",
        checks: ["action-kind", "action-kind"],
        targets: [
          { check: "action-kind", targetId: "OP1", sourceId: null },
          { check: "action-kind", targetId: "OP2", sourceId: null },
        ],
      });
      expect(inspected.table.ownership[2]?.roles).toEqual([
        { id: "E2.F3", basis: "stated", reason: null },
        { id: "OP1", basis: "dependency", reason: "action-kind" },
        { id: "OP2", basis: "dependency", reason: "action-kind" },
      ]);
      // 段を通しても同じ表（形のやり直し無し・要求 1）
      const { outcome, recording } = await run([output], ledger === undefined ? {} : { ledger });
      expect(recording.structured).toHaveLength(1);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.value.table).toEqual(inspected.table);
    });
  }

  it("二点測定 (1)：手で組んだ型付きの複数対象の表（同じ種類が 2 回・対象が別）は表の検査を通り、targets を外すと今の固定文「checks の中身が重なっている」で落ちる", () => {
    const inspected = inspectMapping(LIST, TABLE.rows, twoOperations(), FIXTURE_DOCUMENTS);
    if (!inspected.ok) throw new Error("前提が壊れた：通る応答であること");
    expect(checkMappedTable(LIST, inspected.table, FIXTURE_DOCUMENTS)).toEqual([]);
    const withoutTargets: NameTable = {
      ...inspected.table,
      verification: inspected.table.verification.map((entry) => {
        if (entry.requirementId !== "R3" || entry.kind !== "structural") return entry;
        const { targets: _omit, ...rest } = entry;
        return rest;
      }),
    };
    expect(checkMappedTable(LIST, withoutTargets, FIXTURE_DOCUMENTS)).toEqual([{ field: "verification[2].checks[1]", message: "checks の中身が重なっている" }]);
    // checks と並びの合わない targets（種類の順が違う）も、今までどおり同じ種類が 2 回で落ちる
    const mismatched: NameTable = {
      ...inspected.table,
      verification: inspected.table.verification.map((entry) =>
        entry.requirementId === "R3" && entry.kind === "structural"
          ? { ...entry, targets: [{ check: "field-type" as const, targetId: "E2.F3", sourceId: null }, { check: "action-kind" as const, targetId: "OP2", sourceId: null }] }
          : entry,
      ),
    };
    expect(checkMappedTable(LIST, mismatched, FIXTURE_DOCUMENTS).map((problem) => problem.message)).toContain("checks の中身が重なっている");
  });

  it("二点測定 (2)：種類ごとに対象 1 つの応答から組んだ表（検査の対象・所属・表の SHA）と参照の数は、直す前（欄が写像）の同じ内容と深く等しい", async () => {
    // 直す前の値：base 2c514cf で GOOD（R2 の view-shows 1 件）から組んだ表は MAPPED、参照の数は要件 ID 5・所属・対象 2
    const { outcome } = await run([GOOD]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.table).toEqual(MAPPED);
    expect(outcome.value.tableSha256).toBe(await nameTableSha256(MAPPED));
    const roles = TABLE.ownership.reduce((total, entry) => total + entry.roles.length, 0);
    expect(outcome.references).toEqual({ checked: LIST.requirements.length + roles + 2, unknown: 0, duplicate: 0, crossBundle: 0 });
    // R2 の欄は 1 件の並び
    const r2 = ((entries()[1] as Entry)["verification"] as Entry)["checks"] as Entry;
    expect(r2["view-shows"]).toEqual([{ targetId: "V2", sourceId: "E1.F1" }]);
  });

  it("二点測定 (2)：複数対象の応答は並びの全要素の targetId・sourceId を数え、知らない ID も要素ごとに数える", async () => {
    const roles = TABLE.ownership.reduce((total, entry) => total + entry.roles.length, 0);
    const r3Roles = TABLE.ownership[2]?.roles.length ?? 0;
    const multi = await run([twoOperations()]);
    // 要件 ID 5・所属（R3 は 1 行）・R2 の view-shows 2・R3 の action-kind 2
    expect(multi.outcome.references).toEqual({ checked: LIST.requirements.length + roles - r3Roles + 1 + 2 + 2, unknown: 0, duplicate: 0, crossBundle: 0 });
    const sources = await run([twoSources()]);
    expect(sources.outcome.references).toEqual({ checked: LIST.requirements.length + roles + 4, unknown: 0, duplicate: 0, crossBundle: 0 });
    const unknown = twoOperations(fields({ "action-kind": [{ targetId: "OP1" }, { targetId: "OP9" }, { targetId: "R1" }] }));
    const counted = await run([unknown, rewriteOf(unknown, ["R3"])]);
    expect(counted.outcome.references.unknown).toBe(2);
    expect(counted.outcome.references.crossBundle).toBe(2);
  });

  it("二点測定 (2)：落ちた要件だけの書き直しは、保った複数対象の要件を数え直さない", async () => {
    const roles = TABLE.ownership.reduce((total, entry) => total + entry.roles.length, 0);
    const r1Roles = TABLE.ownership[0]?.roles.length ?? 0;
    const r3Roles = TABLE.ownership[2]?.roles.length ?? 0;
    const good = twoOperations();
    const bad = withEntries(
      (good["requirements"] as Entry[]).map((entry, index) =>
        index === 0 ? { ...entry, roles: [...(entry["roles"] as Entry[]), { id: "E1.F99", basis: "stated", reason: null }] } : entry,
      ),
    );
    const { outcome, recording } = await run([bad, rewriteOf(good, ["R1"])]);
    expect(recording.structured).toHaveLength(2);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(r3Of(outcome.value.table)).toMatchObject({ checks: ["action-kind", "action-kind"] });
    // 初回：要件 ID 5・所属（＋行に無い 1）・対象 4。書き直し：要件 ID 1・R1 の所属（R3 の対象を数え直さない）
    expect(outcome.references).toEqual({
      checked: LIST.requirements.length + roles - r3Roles + 1 + 1 + 4 + (1 + r1Roles),
      unknown: 1,
      duplicate: 0,
      crossBundle: 0,
    });
  });

  it("(3) の前提：同じ画面に表示元 2 つの view-shows は問題 0 で、targets に 2 組が応答の順に並ぶ", () => {
    const inspected = inspectMapping(LIST, TABLE.rows, twoSources(), FIXTURE_DOCUMENTS);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.table.verification[1]).toMatchObject({
      checks: ["view-shows", "view-shows"],
      targets: [
        { check: "view-shows", targetId: "V2", sourceId: "E1.F1" },
        { check: "view-shows", targetId: "V2", sourceId: "C1" },
      ],
    });
  });

  it("復号：種類の固定の順に並べ、種類の中は応答の順のまま（応答の欄の鍵の順に依らない）", () => {
    const checks = fields({ "write-anonymous": [{ targetId: "OP2" }, { targetId: "OP1" }], "action-kind": [{ targetId: "OP2" }, { targetId: "OP1" }] });
    const reversed = Object.fromEntries(Object.entries(checks).reverse());
    for (const set of [checks, reversed]) {
      const inspected = inspectMapping(LIST, TABLE.rows, twoOperations(set), FIXTURE_DOCUMENTS);
      expect(inspected.ok).toBe(true);
      if (inspected.ok) {
        expect(r3Of(inspected.table)).toMatchObject({
          checks: ["action-kind", "action-kind", "write-anonymous", "write-anonymous"],
          targets: [
            { check: "action-kind", targetId: "OP2" },
            { check: "action-kind", targetId: "OP1" },
            { check: "write-anonymous", targetId: "OP2" },
            { check: "write-anonymous", targetId: "OP1" },
          ],
        });
      }
    }
  });

  describe("負例 (5)：同じ組を 2 回は今の固定文「checks の中身が重なっている」で落ちる（形のやり直し 1 回のあと 2 回で unmet）", () => {
    const cases = [
      { label: "同じ操作に同じ種類を 2 回", bad: () => twoOperations(fields({ "action-kind": [{ targetId: "OP2" }, { targetId: "OP2" }] })), rewrite: ["R3"] },
      {
        label: "view-shows で同じ画面・同じ表示元を 2 回",
        bad: () => withChecksAt(1, fields({ "view-shows": [{ targetId: "V2", sourceId: "E1.F1" }, { targetId: "V2", sourceId: "E1.F1" }] })),
        rewrite: ["R2"],
      },
    ] as const;
    it.each(cases)("$label", async ({ bad, rewrite }) => {
      const inspected = inspectMapping(LIST, TABLE.rows, bad(), FIXTURE_DOCUMENTS);
      expect(inspected.ok).toBe(false);
      if (!inspected.ok) expect(inspected.problems.map((problem) => problem.message)).toEqual(["checks の中身が重なっている"]);
      const { outcome, recording } = await run([bad(), rewriteOf(bad(), rewrite)]);
      expect(recording.structured).toHaveLength(2);
      expect(blockOf(recording.structured[1]?.input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual(rewrite);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure.kind).toBe("unmet");
      expect(messagesOf(outcome)).toContain("checks の中身が重なっている");
    });

    it("手で組んだ targets 無しの表で同じ種類が 2 回も、今の固定文で落ちる", () => {
      const table: NameTable = {
        ...TABLE,
        verification: TABLE.verification.map((entry) =>
          entry.requirementId === "R3" ? { requirementId: "R3", kind: "structural" as const, reason: "操作の種類だけ", checks: ["action-kind", "action-kind"] as const } : entry,
        ),
        ownership: TABLE.ownership.map((entry) => (entry.requirementId === "R3" ? { ...entry, roles: [...entry.roles, { id: "OP1", basis: "stated" as const, reason: null }] } : entry)),
      };
      expect(checkMappedTable(LIST, table, FIXTURE_DOCUMENTS).map((problem) => problem.message)).toEqual(["checks の中身が重なっている"]);
    });
  });

  describe("負例 (6)：固定文で形のやり直し 1 回のあと 2 回で unmet", () => {
    // 落ちた対象は所属に足さないので、R3 だけが所属させる OP2 は所属に名指しして孤立行を作らない（問題を R3 に帰属させる）
    const withOp2 = [
      { id: "E2.F3", basis: "stated", reason: null },
      { id: "OP2", basis: "stated", reason: null },
    ];
    const cases = [
      { label: "空の並びの欄", bad: () => twoOperations(fields({ "action-kind": [{ targetId: "OP1" }], "write-anonymous": [] })), message: MAPPING_MESSAGES.checksEmpty },
      { label: "空の並びの欄だけ", bad: () => twoOperations(fields({ "action-kind": [] })), message: MAPPING_MESSAGES.checksEmpty },
      { label: "並びの 2 件目の種類が違う（action-kind に項目）", bad: () => twoOperations(fields({ "action-kind": [{ targetId: "OP1" }, { targetId: "E2.F3" }] }), withOp2), message: CHECK_TARGET_MESSAGES.targetKind },
      { label: "並びの 2 件目が表に無い", bad: () => twoOperations(fields({ "action-kind": [{ targetId: "OP1" }, { targetId: "OP9" }] }), withOp2), message: CHECK_TARGET_MESSAGES.unknownTarget },
      {
        label: "view-shows の 2 件目が同じ entity でない対",
        bad: () => twoOperations(fields({ "action-kind": [{ targetId: "OP2" }], "view-shows": [{ targetId: "V1", sourceId: "E2.F3" }, { targetId: "V1", sourceId: "E1.F1" }] }), withOp2),
        message: CHECK_TARGET_MESSAGES.sourcePair,
      },
      {
        label: "直す前の写像の欄（並びでない。schema では出ない）",
        bad: () => negative(twoOperations(rawFields({ "action-kind": { targetId: "OP1" } })), "欄は schema で並びか null"),
        message: MAPPING_MESSAGES.checksShape,
      },
    ] as const;
    it.each(cases)("$label", async ({ bad, message }) => {
      const { outcome, recording } = await run([bad(), rewriteOf(bad(), ["R3"])]);
      expect(recording.structured).toHaveLength(2);
      expect(blockOf(recording.structured[1]?.input, MAPPING_REWRITE_DATA_NAMES.requirements)).toEqual(["R3"]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure.kind).toBe("unmet");
      expect(messagesOf(outcome)).toContain(message);
      const fixed = await run([bad(), rewriteOf(twoOperations(), ["R3"])]);
      expect(fixed.outcome.ok).toBe(true);
    });
  });

  it("(7)：どの検査の対象にも所属にも無い行は今の固定文で落ちる（対象の並びから推測で足さない）", () => {
    // R3 の所属から操作を外し、検査の対象にも OP2 だけを書く（OP2 は R3 だけが所属させる行ではないので、E2.F3 を外して孤立させる）
    const orphan = withEntries(
      (twoOperations(fields({ "action-kind": [{ targetId: "OP2" }] }))["requirements"] as Entry[]).map((entry, index) =>
        index === 2 ? { ...entry, roles: [{ id: "OP2", basis: "stated", reason: null }] } : index === 0 ? { ...entry, roles: (entry["roles"] as Entry[]).filter((role) => role["id"] !== "E2.F3") } : entry,
      ),
    );
    const inspected = inspectMapping(LIST, TABLE.rows, orphan, FIXTURE_DOCUMENTS);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.problems.map((problem) => problem.message)).toEqual(["どの要件にも所属しない行がある"]);
  });

  it("要求：通常版・台帳版・書き直しの版の R-map-03 が同じ新しい文で、ID・why は直す前のまま・since に履歴がある", () => {
    const plain = MAPPING_RULE_DEFINITIONS.find((definition) => definition.id === "R-map-03");
    for (const [definitions, ledgerVersion] of [
      [MAPPING_RULE_DEFINITIONS, false],
      [mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW), true],
      [mappingRewriteRuleDefinitionsOf(), false],
      [mappingRewriteRuleDefinitionsOf(PROPERTY_LEDGER_VIEW), true],
    ] as const) {
      expect(ruleDefinitionDefects(definitions)).toEqual([]);
      const r3 = definitions.find((definition) => definition.id === "R-map-03");
      expect(r3?.text).toContain("同じ種類の検査を 2 つ以上の行に掛けて確かめる要件は、その種類の欄に行ごとに 1 件ずつ並べる。同じ組（view-shows は画面と表示元の組、ほかは行）を 2 回書かない。");
      expect(r3?.text).not.toContain("同じ種類の検査は要件ごとに 1 件");
      expect(r3?.text).not.toContain("structural にせず、kind を fixed-test にしてそれらの行を所属させる");
      expect(r3?.why).toBe(plain?.why);
      // 台帳版と台帳版の書き直しの since は、直す前の since の後ろに #725 の履歴を足したもの（Issue #725 で台帳版の期待を置き換えた）
      expect(r3?.since).toBe(
        ledgerVersion
          ? `${plain?.since ?? ""}。#682 は空の並び 34/129 件を理由に 1 件以上とした。根拠を文書に縛る理由（怠慢の持ち越しを塞ぐ）は保ち、台帳の未対応を根拠に足した（Issue #725）`
          : plain?.since,
      );
    }
    expect(plain?.why).toBe(
      "確かめ方を所属と組で固定し、書けない要件は理由と制約 ID つきで持ち越す（T1 の R-nt-08）。構造の検査の対象は規則の文で所属を求めず、応答の欄で行の ID を書かせて対と所属をコードが導く（方法論 03 の F4・H1・H2）",
    );
    expect(plain?.since).toContain("#682 は形の落ち率を理由に 1 種類 1 件とした。fixed-test にすると試験 0 本・操作が未検証になる要件があり（U1 の 30 本の分析）");
    expect(plain?.since).toContain("Issue #724");
    expectNoAcceptanceMaterial([JSON.stringify(twoOperations()), JSON.stringify(twoSources()), MAPPING_MESSAGES.checksEmpty, plain?.text ?? ""]);
  });
});

describe("台帳の未対応の観測を unresolved の根拠に足す（旗 ids と ledger が on の C2 だけ。v1.2 表の契約 A-U。Issue #725）", () => {
  /** 台帳を受けた C2 の行（計算の行に集計の欄）と、その行で書いた正しい応答 */
  const LEDGER_TABLE = withCodeIds(withAggregates(fixtureTable()));
  const LEDGER_GOOD = idsResponsesOf(LIST, LEDGER_TABLE, PROPERTY_LEDGER_VIEW).mapping;
  const LEDGER_ID = "state-after-set";
  const unresolvedIndex = (LEDGER_GOOD["requirements"] as Entry[]).findIndex((entry) => (entry["verification"] as Entry)["kind"] === "unresolved");
  /** 未解決の要件の constraintIds だけを差し替えた応答 */
  const withConstraintIds = (good: Record<string, unknown>, constraintIds: readonly string[]) => ({
    requirements: (good["requirements"] as Entry[]).map((entry, index) =>
      index === unresolvedIndex ? { ...entry, verification: { ...(entry["verification"] as Entry), constraintIds } } : entry,
    ),
  });
  /** 要求のデータの塊の名前の並び */
  const dataNamesOf = (input: string | undefined): readonly string[] => [...(input ?? "").matchAll(/<data name="([^"]+)">\n/gu)].map((match) => match[1] ?? "");
  const EXPECTED_BLOCK = { observations: [{ id: LEDGER_ID, message: PROPERTY_LEDGER_VIEW.unsupportedObservations[0]?.message }] };

  it("前提：未解決の要件が 1 件で、文書の制約 ID を挙げている。台帳の未対応の観測は state-after-set の 1 件で、文書の制約 ID ではない", () => {
    expect(unresolvedIndex).toBe(4);
    expect(((LEDGER_GOOD["requirements"] as Entry[])[unresolvedIndex]?.["verification"] as Entry | undefined)?.["constraintIds"]).toEqual([...constraintIdsIn(FIXTURE_DOCUMENTS)].slice(0, 1));
    expect(PROPERTY_LEDGER_VIEW.unsupportedObservations.map((entry) => entry.id)).toEqual([LEDGER_ID]);
    expect(constraintIdsIn(FIXTURE_DOCUMENTS).has(LEDGER_ID)).toBe(false);
  });

  it("(1) 台帳の未対応の観測の ID だけを挙げた unresolved は、台帳を受けた C2' で問題 0（1 回で通る）。表の確かめ方は unresolved のまま理由とその ID を持つ。台帳を受けない C2 では今までどおり「制約 ID が文書に無い」で落ちる", async () => {
    const response = withConstraintIds(LEDGER_GOOD, [LEDGER_ID]);
    const { outcome, recording } = await run([response], { table: LEDGER_TABLE, ledger: PROPERTY_LEDGER_VIEW });
    expect(recording.structured).toHaveLength(1);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.table.verification[unresolvedIndex]).toMatchObject({ kind: "unresolved", reason: "宣言で書けない", constraintIds: [LEDGER_ID] });
    }
    const inspected = inspectMapping(LIST, LEDGER_TABLE.rows, response, FIXTURE_DOCUMENTS, PROPERTY_LEDGER_VIEW);
    expect(inspected.ok).toBe(true);
    // 台帳を受けない C2（ids on・ledger off）は今のまま落ちる
    // （初回の問題は要件 R5 に帰属するので、2 本目は R5 だけの書き直し。同じ ID のまま書けば落ちる）
    const offResponse = withConstraintIds(GOOD, [LEDGER_ID]);
    const off = await run([offResponse, rewriteOf(offResponse, ["R5"])]);
    expect(off.outcome.ok).toBe(false);
    expect(messagesOf(off.outcome)).toEqual(["制約 ID が文書に無い"]);
  });

  it("(2) 文書の制約 ID の unresolved は、台帳を受けても直す前と同じ表（応答から組んだ表）で通る", async () => {
    const { outcome } = await run([LEDGER_GOOD], { table: LEDGER_TABLE, ledger: PROPERTY_LEDGER_VIEW });
    expect(outcome.ok).toBe(true);
    const inspected = inspectMapping(LIST, LEDGER_TABLE.rows, LEDGER_GOOD, FIXTURE_DOCUMENTS, PROPERTY_LEDGER_VIEW);
    expect(inspected.ok).toBe(true);
    if (outcome.ok && inspected.ok) {
      expect(outcome.value.table).toEqual(inspected.table);
      expect(outcome.value.table.verification[unresolvedIndex]).toMatchObject({ kind: "unresolved", constraintIds: [...constraintIdsIn(FIXTURE_DOCUMENTS)].slice(0, 1) });
    }
  });

  it("(3)(4) 負例：空の constraintIds・台帳の有効な観測の ID・どちらにも無い ID は、台帳を受けた C2' でも今の固定文で落ちる", () => {
    const problemsOf = (ids: readonly string[]) => {
      const inspected = inspectMapping(LIST, LEDGER_TABLE.rows, withConstraintIds(LEDGER_GOOD, ids), FIXTURE_DOCUMENTS, PROPERTY_LEDGER_VIEW);
      return inspected.ok ? [] : inspected.problems.map((problem) => problem.message);
    };
    expect(problemsOf([])).toEqual(["未解決の要件に制約 ID が無い"]);
    for (const id of ["when", "value", "default-value", "どちらにも無い"]) expect(problemsOf([id]), id).toEqual(["制約 ID が文書に無い"]);
  });

  it("要求：台帳を受けた C2 のデータは文書の塊の直後に未対応の観測の一覧（ID と文）を持ち、それを除けば台帳を受けない要求のデータと同じ。規則は R-map-03 だけが違う", async () => {
    const on = await run([LEDGER_GOOD], { table: LEDGER_TABLE, ledger: PROPERTY_LEDGER_VIEW });
    const off = await run([LEDGER_GOOD, LEDGER_GOOD], { table: LEDGER_TABLE });
    const onRequest = on.recording.structured[0];
    const offRequest = off.recording.structured[0];
    expect(dataNamesOf(onRequest?.input)).toEqual([
      MAPPING_DATA_NAMES.plan,
      MAPPING_DATA_NAMES.list,
      MAPPING_DATA_NAMES.rows,
      MAPPING_DATA_NAMES.documents,
      MAPPING_LEDGER_DATA_NAMES.unsupported,
    ]);
    expect(dataNamesOf(offRequest?.input)).toEqual([MAPPING_DATA_NAMES.plan, MAPPING_DATA_NAMES.list, MAPPING_DATA_NAMES.rows, MAPPING_DATA_NAMES.documents]);
    expect(blockOf(onRequest?.input, MAPPING_LEDGER_DATA_NAMES.unsupported)).toEqual(EXPECTED_BLOCK);
    const block = `\n<data name="${MAPPING_LEDGER_DATA_NAMES.unsupported}">\n${(onRequest?.input ?? "").split(`<data name="${MAPPING_LEDGER_DATA_NAMES.unsupported}">\n`)[1]?.split("\n</data>")[0] ?? ""}\n</data>`;
    expect(onRequest?.input.replace(block, "")).toBe(offRequest?.input);
    expect(MAPPING_LEDGER_DATA_NAMES).toEqual({ unsupported: "台帳の未対応の観測" });
    // 規則：R-map-03 のほかは同じ文・同じ順
    const onRules = mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW);
    expect(onRules.map((definition) => definition.id)).toEqual(MAPPING_RULE_DEFINITIONS.map((definition) => definition.id));
    expect(onRules.filter((definition) => definition.id !== "R-map-03")).toEqual(MAPPING_RULE_DEFINITIONS.filter((definition) => definition.id !== "R-map-03"));
    expect(onRequest?.rules).toEqual(ruleTexts(onRules));
    expect(offRequest?.rules).toEqual(ruleTexts(MAPPING_RULE_DEFINITIONS));
    expectNoAcceptanceMaterial([onRequest?.input ?? "", ...ruleTexts(onRules)]);
  });

  it("要求：落ちた要件だけの書き直しと C3 の拒否のあとの 2 回目の要求も、文書の塊の直後に同じ一覧を持ち、台帳版の書き直しの規則（新しい R-map-03）を使う", async () => {
    const rewriteRules = ruleTexts(mappingRewriteRuleDefinitionsOf(PROPERTY_LEDGER_VIEW));
    // 落ちた要件だけの書き直し（R1 の所属に行に無い ID）
    const bad = {
      requirements: (LEDGER_GOOD["requirements"] as Entry[]).map((entry, index) =>
        index === 0 ? { ...entry, roles: [...(entry["roles"] as Entry[]), { id: "X99", basis: "stated", reason: null }] } : entry,
      ),
    };
    const shape = await run([bad, rewriteOf(LEDGER_GOOD, ["R1"])], { table: LEDGER_TABLE, ledger: PROPERTY_LEDGER_VIEW });
    expect(shape.outcome.ok).toBe(true);
    const second = shape.recording.structured[1];
    expect(dataNamesOf(second?.input).slice(0, 5)).toEqual([
      MAPPING_DATA_NAMES.plan,
      MAPPING_DATA_NAMES.list,
      MAPPING_DATA_NAMES.rows,
      MAPPING_DATA_NAMES.documents,
      MAPPING_LEDGER_DATA_NAMES.unsupported,
    ]);
    expect(blockOf(second?.input, MAPPING_LEDGER_DATA_NAMES.unsupported)).toEqual(EXPECTED_BLOCK);
    expect(second?.rules).toEqual(rewriteRules);
    // C3 の拒否のあとの 2 回目
    const previous: MappingPrevious = {
      response: LEDGER_GOOD,
      rejections: [{ requirementId: "R2", verdict: "reject", kind: "unnecessary-ownership", quote: "一覧で見られる" }] as unknown as MappingPrevious["rejections"],
      advice: [],
    };
    const rejected = await run([rewriteOf(LEDGER_GOOD, ["R2"])], { table: LEDGER_TABLE, ledger: PROPERTY_LEDGER_VIEW, previous });
    expect(rejected.outcome.ok).toBe(true);
    const request = rejected.recording.structured[0];
    expect(dataNamesOf(request?.input)).toEqual([
      MAPPING_DATA_NAMES.plan,
      MAPPING_DATA_NAMES.list,
      MAPPING_DATA_NAMES.rows,
      MAPPING_DATA_NAMES.documents,
      MAPPING_LEDGER_DATA_NAMES.unsupported,
      MAPPING_DATA_NAMES.response,
      MAPPING_DATA_NAMES.rejections,
      MAPPING_DATA_NAMES.advice,
      MAPPING_REWRITE_DATA_NAMES.requirements,
    ]);
    expect(request?.rules).toEqual(rewriteRules);
    // 台帳版の書き直しの R-map-03 は新しい文（kind・reason の記入の指示と、根拠の一覧に台帳の未対応の観測）
    const r3 = mappingRewriteRuleDefinitionsOf(PROPERTY_LEDGER_VIEW).find((definition) => definition.id === "R-map-03")?.text ?? "";
    expect(r3).toContain("kind を unresolved にし、reason に理由を書き、constraintIds に根拠の ID を 1 件以上（文書の制約 ID の一覧か台帳の未対応の観測の一覧にあるものだけ）書く。");
    expect(r3).toContain("根拠を一覧から挙げられない要件は unresolved にしない。");
  });

  it("規則の定義の不備 0（台帳の文で組み直した版・書き直しの版）。台帳を受けない版の R-map-03 は直す前と同じ文・同じ since", () => {
    for (const definitions of [mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW), mappingRewriteRuleDefinitionsOf(PROPERTY_LEDGER_VIEW), MAPPING_RULE_DEFINITIONS, mappingRewriteRuleDefinitionsOf()]) {
      expect(ruleDefinitionDefects(definitions)).toEqual([]);
    }
    const plain = MAPPING_RULE_DEFINITIONS.find((definition) => definition.id === "R-map-03");
    expect(plain?.text).not.toContain("台帳");
    expect(plain?.since).not.toContain("#725");
    const ledger = mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW).find((definition) => definition.id === "R-map-03");
    expect(ledger?.id).toBe(plain?.id);
    expect(ledger?.why).toBe(plain?.why);
    expect(ledger?.since).toContain("#682 は空の並び 34/129 件を理由に 1 件以上とした。根拠を文書に縛る理由（怠慢の持ち越しを塞ぐ）は保ち、台帳の未対応を根拠に足した");
  });
});
