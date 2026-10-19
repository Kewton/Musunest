// C2 要件の写像の試験（Issue #593・#594・#627・#682）。偽物の LLM（照合ありの記録）と固定の時計で回す。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { STRUCTURAL_ASSERTIONS, type StructuralAssertionKind } from "../../fixed-test.js";
import { validateSchema } from "../../schema-check.js";
import { ruleDefinitionDefects } from "../../stages/prompt.js";
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
import { PROPERTY_LEDGER_VIEW, type LedgerView } from "../ledger.js";
import type { ReferenceCounts } from "../ids.js";
import {
  MAPPING_DATA_NAMES,
  MAPPING_MESSAGES,
  MAPPING_RULE_DEFINITIONS,
  MAPPING_SCHEMA_NAME,
  inspectMapping,
  legacyMappingSchemaOf,
  mappingRuleDefinitionsOf,
  mappingSchemaOf,
  runMapping,
  type MappingPrevious,
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
  const cases: readonly { readonly label: string; readonly bad: () => unknown; readonly message: string; readonly count?: keyof ReferenceCounts }[] = [
    { label: "要件の欠落", bad: () => withEntries(entries().slice(1)), message: "要件の所属が無い" },
    { label: "同じ要件 2 件（重複）", bad: () => withEntries([...entries(), rowOf(0)]), message: "同じ要件の項目が重なっている", count: "duplicate" },
    { label: "一覧に無い要件 ID（知らない ID）", bad: () => withEntries([...entries(), { ...rowOf(0), requirementId: "R99" }]), message: "一覧に無い要件 ID である", count: "unknown" },
    {
      label: "行に無い ID の所属（知らない ID）",
      bad: () => withEntries(entries().map((entry, index) => (index === 0 ? { ...entry, roles: [...(entry["roles"] as unknown[]), { id: "E1.F99", basis: "stated", reason: null }] } : entry))),
      message: "所属の表の ID が表に無い",
      count: "unknown",
    },
    {
      label: "同じ要件の中で同じ行を 2 回所属（重複）",
      bad: () => withEntries(entries().map((entry, index) => (index === 0 ? { ...entry, roles: [...(entry["roles"] as unknown[]), (entry["roles"] as unknown[])[0]] } : entry))),
      message: "同じ要件の中で所属が重なっている",
      count: "duplicate",
    },
    {
      label: "所属の欄に要件 ID（別の束の ID）",
      bad: () => withEntries(entries().map((entry, index) => (index === 0 ? { ...entry, roles: [...(entry["roles"] as unknown[]), { id: "R2", basis: "stated", reason: null }] } : entry))),
      message: "所属の表の ID が表に無い",
      count: "crossBundle",
    },
    // checks の 6 欄が全部 null の structural（と checks が null の structural）は、表の検査の今の固定文で落ちる（Issue #682 の (5)）
    { label: "structural で checks の 6 欄が全部 null", bad: () => r2Checks(fields()), message: "構造で確かめる要件に checks が無い" },
    { label: "structural で checks が null", bad: () => r2Checks(null), message: "構造で確かめる要件に checks が無い" },
    // 構造の検査の対象（Issue #594。欄の写像は Issue #682）。R2 は画面 V2（entity E1）・V1（E2）、項目 E1.F1・E2.F1、計算 C1（E1）を所属させる
    { label: "検査の対象の種類が違う（view-shows に項目）", bad: () => r2Checks(viewShows("E1.F1", "E1.F1")), message: CHECK_TARGET_MESSAGES.targetKind },
    { label: "検査の対象の種類が違う（field-type に画面）", bad: () => r2Checks(fields({ "field-type": { targetId: "V2" } })), message: CHECK_TARGET_MESSAGES.targetKind },
    { label: "view-shows の対の entity が違う", bad: () => r2Checks(viewShows("V2", "E2.F1")), message: CHECK_TARGET_MESSAGES.sourcePair },
    { label: "dashboard の画面に entity を持つ項目を組にした", bad: () => r2Checks(viewShows("V3", "E2.F1")), message: CHECK_TARGET_MESSAGES.sourcePair },
    { label: "dashboard の画面に entity を持つ計算を組にした", bad: () => r2Checks(viewShows("V3", "C1")), message: CHECK_TARGET_MESSAGES.sourcePair },
    { label: "view-shows の組に画面を書いた", bad: () => r2Checks(viewShows("V2", "V1")), message: CHECK_TARGET_MESSAGES.sourcePair },
    { label: "検査の対象の ID が行に無い", bad: () => r2Checks(viewShows("V9", "E1.F1")), message: CHECK_TARGET_MESSAGES.unknownTarget, count: "unknown" },
    { label: "view-shows の組の ID が行に無い", bad: () => r2Checks(viewShows("V2", "E1.F9")), message: CHECK_TARGET_MESSAGES.unknownSource, count: "unknown" },
    // 欄の写像では書けない形（strict の schema では出ない。照合を外して流すと形の固定文で落ちる。Issue #682 の (6)）
    {
      label: "view-shows の sourceId が null（schema では出ない）",
      bad: () => negative(r2Checks(fields({ "view-shows": { targetId: "V2", sourceId: null } })), "view-shows の sourceId は schema では文字列"),
      message: MAPPING_MESSAGES.checksShape,
    },
    {
      label: "view-shows でない欄に sourceId（schema では出ない）",
      bad: () => negative(r2Checks(fields({ "field-type": { targetId: "E1.F1", sourceId: "E1.F1" } })), "view-shows でない欄は schema で sourceId を持たない"),
      message: MAPPING_MESSAGES.checksShape,
    },
    {
      label: "配列の形の checks（schema では出ない）",
      bad: () => negative(r2Checks([{ check: "view-shows", targetId: "V2", sourceId: "E1.F1" }]), "checks は schema で欄の写像か null"),
      message: MAPPING_MESSAGES.checksShape,
    },
    {
      label: "欄が欠けた checks（schema では出ない）",
      bad: () => {
        const { "write-anonymous": _omit, ...rest } = viewShows("V2", "E1.F1");
        return negative(r2Checks(rest), "checks の 6 欄は schema で全部 required");
      },
      message: MAPPING_MESSAGES.checksShape,
    },
    {
      label: "targetId が空の欄（構造の形）",
      bad: () => r2Checks(viewShows("", "E1.F1")),
      message: MAPPING_MESSAGES.checksShape,
    },
    // 未解決の要件の制約 ID が空（規則の文だけを直し、検査は今のまま。Issue #682 の (3)）
    {
      label: "unresolved の constraintIds が空",
      bad: () => withEntries(entries().map((entry, index) => (index === 4 ? { ...entry, verification: { ...(entry["verification"] as Entry), constraintIds: [] } } : entry))),
      message: "未解決の要件に制約 ID が無い",
    },
  ];

  it.each(cases)("$label", async ({ bad, message, count }) => {
    const { outcome, recording } = await run([bad(), bad()]);
    expect(recording.structured).toHaveLength(2);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unmet");
    expect(messagesOf(outcome)).toContain(message);
    if (count !== undefined) expect(outcome.references[count]).toBeGreaterThanOrEqual(1);
    const fixed = await run([bad(), GOOD]);
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
    const first = await run([withEntries(outside), withEntries(outside)], { list, table });
    expect(first.recording.structured).toHaveLength(2);
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
    const failed = await run([withEntries(owned), withEntries(owned)], options);
    expect(failed.recording.structured).toHaveLength(2);
    expect(failed.outcome.ok).toBe(false);
    if (!failed.outcome.ok) expect(failed.outcome.failure.kind).toBe("unmet");
    expect(messagesOf(failed.outcome)).toContain("要件でない文（non-requirement）には行を所属させないこと");
    const fixed = await run([withEntries(owned), withEntries(good)], options);
    expect(fixed.outcome.ok).toBe(true);
    expect(fixed.recording.structured).toHaveLength(2);
  });

  it("写し由来の固定文（長さ・一覧に無い写し・引用が原文に無い）は C2' の落ちに出ない", async () => {
    const copyMessages = [
      "要件の文の写しが指示した長さと合わない",
      "出典の要件の文の写しが一覧のどの要件とも合わない",
      "出典の引用が、写しが指す要件の原文に無い",
    ];
    for (const { bad } of cases) {
      const { outcome } = await run([bad(), bad()]);
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
    const { outcome } = await run([empty, empty]);
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

  it("要求：R-map-03 の新しい文（種類ごと 1 件・fixed-test への選び方・制約 ID 1 件以上）があり、ほかの規則の文・順・データの塊の名前は直す前と同じ", () => {
    for (const definitions of [MAPPING_RULE_DEFINITIONS, mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)]) {
      expect(definitions.map((definition) => definition.id)).toEqual(["R-map-01", "R-map-02", "R-map-03", "R-map-04"]);
      const r3 = definitions.find((definition) => definition.id === "R-map-03")?.text ?? "";
      for (const phrase of [
        "checks は検査の種類ごとの欄で、同じ種類の検査は要件ごとに 1 件である。",
        "view-shows の欄は sourceId に画面と同じ entity の項目か計算の行の ID",
        "使わない種類の欄は null にする。",
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
    const ok = await run([GOOD], { previous });
    expect(ok.outcome.ok).toBe(true);
    const input = ok.recording.structured[0]?.input ?? "";
    for (const name of [MAPPING_DATA_NAMES.response, MAPPING_DATA_NAMES.rejections, MAPPING_DATA_NAMES.advice]) expect(input).toContain(`<data name="${name}">`);
    // 前回の写像は新しい形（検査の種類ごとの欄）の raw のまま載る（Issue #682）
    const response = JSON.parse(input.split(`<data name="${MAPPING_DATA_NAMES.response}">\n`)[1]?.split("\n</data>")[0] ?? "null") as unknown;
    expect(response).toEqual(GOOD);
    expect(((GOOD["requirements"] as Entry[])[1] as Entry)["verification"]).toHaveProperty("checks", fields({ "view-shows": { targetId: "V2", sourceId: "E1.F1" } }));
    const bad = withEntries(entries().slice(1));
    const failed = await run([bad, GOOD], { previous });
    expect(failed.recording.structured).toHaveLength(1);
    expect(failed.outcome.ok).toBe(false);
    if (!failed.outcome.ok) expect(failed.outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
  });
});
