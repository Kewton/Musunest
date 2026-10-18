// C2 要件の写像の試験（Issue #593・#594・#627）。偽物の LLM（照合ありの記録）と固定の時計で回す。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { STRUCTURAL_ASSERTIONS } from "../../fixed-test.js";
import { ruleDefinitionDefects } from "../../stages/prompt.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import {
  FIXTURE_DOCUMENTS,
  createCheckedRecordingClient,
  fixtureDefaultValueList,
  fixtureDefaultValueTable,
  fixtureList,
  fixtureNonRequirementList,
  fixtureNonRequirementTable,
  fixtureTable,
  idsResponsesOf,
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

describe("C2 の規則と schema", () => {
  it("規則の定義に why・since があり不備 0（台帳の文で組み直しても）。schema は strict で写し・出典の欄が無く、checks は検査ごとの対象の写像", () => {
    expect(ruleDefinitionDefects(MAPPING_RULE_DEFINITIONS)).toEqual([]);
    expect(ruleDefinitionDefects(mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW))).toEqual([]);
    for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
      const schema = mappingSchemaOf(ledger);
      expect(strictDefects(schema)).toEqual([]);
      const text = JSON.stringify(schema);
      for (const key of ['"copy"', '"source"', '"quote"']) expect(text.includes(key), key).toBe(false);
      const checks = (((schema["properties"] as Entry)["requirements"] as Entry)["items"] as Entry)["properties"] as Entry;
      const items = (((checks["verification"] as Entry)["properties"] as Entry)["checks"] as Entry)["items"] as Entry;
      expect(items["required"]).toEqual(["check", "targetId", "sourceId"]);
      expect(((items["properties"] as Entry)["check"] as Entry)["enum"]).toEqual([...STRUCTURAL_ASSERTIONS]);
    }
    expect(MAPPING_SCHEMA_NAME).toBe("mapping");
    // 規則の文は所属に含めよと求めず、対象の欄を書かせる（旗 on では「view-shows の検査に…所属が無い」を規則で求めない）
    const r3 = MAPPING_RULE_DEFINITIONS.find((definition) => definition.id === "R-map-03");
    expect(r3?.text).toContain("targetId");
    expect(r3?.text).not.toContain("検査ごとに合う種類の行を所属させる");
    expect(r3?.since).toContain("#594");
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
  const r2Checks = (checks: readonly unknown[]) =>
    withEntries(entries().map((entry, index) => (index === 1 ? { ...entry, verification: { ...(entry["verification"] as Entry), checks } } : entry)));
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
    { label: "structural で checks 無し", bad: () => r2Checks([]), message: "構造で確かめる要件に checks が無い" },
    // 構造の検査の対象（Issue #594）。R2 は画面 V2（entity E1）・V1（E2）、項目 E1.F1・E2.F1、計算 C1（E1）を所属させる
    { label: "検査の対象の種類が違う（view-shows に項目）", bad: () => r2Checks([{ check: "view-shows", targetId: "E1.F1", sourceId: "E1.F1" }]), message: CHECK_TARGET_MESSAGES.targetKind },
    { label: "view-shows の対の entity が違う", bad: () => r2Checks([{ check: "view-shows", targetId: "V2", sourceId: "E2.F1" }]), message: CHECK_TARGET_MESSAGES.sourcePair },
    { label: "dashboard の画面に entity を持つ項目を組にした", bad: () => r2Checks([{ check: "view-shows", targetId: "V3", sourceId: "E2.F1" }]), message: CHECK_TARGET_MESSAGES.sourcePair },
    { label: "dashboard の画面に entity を持つ計算を組にした", bad: () => r2Checks([{ check: "view-shows", targetId: "V3", sourceId: "C1" }]), message: CHECK_TARGET_MESSAGES.sourcePair },
    { label: "view-shows の組に画面を書いた", bad: () => r2Checks([{ check: "view-shows", targetId: "V2", sourceId: "V1" }]), message: CHECK_TARGET_MESSAGES.sourcePair },
    { label: "view-shows の sourceId が null", bad: () => r2Checks([{ check: "view-shows", targetId: "V2", sourceId: null }]), message: CHECK_TARGET_MESSAGES.sourceMissing },
    { label: "検査の対象の ID が行に無い", bad: () => r2Checks([{ check: "view-shows", targetId: "V9", sourceId: "E1.F1" }]), message: CHECK_TARGET_MESSAGES.unknownTarget, count: "unknown" },
    { label: "view-shows の組の ID が行に無い", bad: () => r2Checks([{ check: "view-shows", targetId: "V2", sourceId: "E1.F9" }]), message: CHECK_TARGET_MESSAGES.unknownSource, count: "unknown" },
    { label: "view-shows でない検査に sourceId", bad: () => r2Checks([{ check: "field-type", targetId: "E1.F1", sourceId: "E1.F1" }]), message: CHECK_TARGET_MESSAGES.sourceExtra },
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
        const problems = inspectMapping(LIST, TABLE.rows, r2Checks([{ check: "view-shows", targetId: screen.id, sourceId: source.id }]), FIXTURE_DOCUMENTS);
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
  it("検査が対象の写像でない（種類の文字列だけ。strict の schema では出ない）応答は、形の固定文で落ちる", () => {
    const strings = withEntries(entries().map((entry, index) => (index === 1 ? { ...entry, verification: { ...(entry["verification"] as Entry), checks: ["view-shows"] } } : entry)));
    const inspected = inspectMapping(LIST, TABLE.rows, strings, FIXTURE_DOCUMENTS);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.problems.map((problem) => problem.message)).toEqual([MAPPING_MESSAGES.checksShape]);
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
              verification: { ...(entry["verification"] as Entry), checks: [{ check: "view-shows", targetId: "V2", sourceId: "E1.F1" }] },
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
    const bad = withEntries(entries().slice(1));
    const failed = await run([bad, GOOD], { previous });
    expect(failed.recording.structured).toHaveLength(1);
    expect(failed.outcome.ok).toBe(false);
    if (!failed.outcome.ok) expect(failed.outcome.failure).toMatchObject({ kind: "unmet", attempts: 1 });
  });
});
