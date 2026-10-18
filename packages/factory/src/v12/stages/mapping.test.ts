// C2 要件の写像の試験（Issue #593）。偽物の LLM（照合ありの記録）と固定の時計で回す。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import { ruleDefinitionDefects } from "../../stages/prompt.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../../stages/__tests__/prompt.js";
import {
  FIXTURE_DOCUMENTS,
  createCheckedRecordingClient,
  fixtureDefaultValueList,
  fixtureDefaultValueTable,
  fixtureList,
  fixtureTable,
  idsResponsesOf,
  planOf,
  recordedStructured,
  strictDefects,
  withCodeIds,
} from "../../v11a/__tests__/fixtures.js";
import { nameTableSha256, type NameTable } from "../../v11a/names.js";
import { PROPERTY_LEDGER_VIEW } from "../ledger.js";
import type { ReferenceCounts } from "../ids.js";
import {
  MAPPING_DATA_NAMES,
  MAPPING_RULE_DEFINITIONS,
  MAPPING_SCHEMA_NAME,
  mappingRuleDefinitionsOf,
  mappingSchemaOf,
  runMapping,
  type MappingPrevious,
} from "./mapping.js";

const LIST = fixtureList();
const PLAN = planOf(LIST);
const TABLE = withCodeIds(fixtureTable());
const GOOD = idsResponsesOf(LIST, TABLE).mapping;

async function run(outputs: readonly unknown[], options: { previous?: MappingPrevious; table?: NameTable; list?: typeof LIST } = {}) {
  const recording = createCheckedRecordingClient(outputs.map(recordedStructured));
  const outcome = await runMapping({
    plan: PLAN,
    list: options.list ?? LIST,
    documents: FIXTURE_DOCUMENTS,
    gateway: makeGateway(recording.client),
    rows: (options.table ?? TABLE).rows,
    ...(options.previous === undefined ? {} : { previous: options.previous }),
  });
  return { outcome, recording };
}

type Entry = Record<string, unknown>;
const entries = (): Entry[] => (GOOD["requirements"] as Entry[]).map((entry) => ({ ...entry }));
const withEntries = (list: readonly Entry[]) => ({ requirements: list });
const messagesOf = (outcome: Awaited<ReturnType<typeof runMapping>>): readonly string[] =>
  outcome.ok || outcome.failure.kind !== "unmet" ? [] : outcome.failure.problems.map((problem) => problem.message);

describe("C2 の規則と schema", () => {
  it("規則の定義に why・since があり不備 0（台帳の文で組み直しても）。schema は strict で写し・出典の欄が無い", () => {
    expect(ruleDefinitionDefects(MAPPING_RULE_DEFINITIONS)).toEqual([]);
    expect(ruleDefinitionDefects(mappingRuleDefinitionsOf(PROPERTY_LEDGER_VIEW))).toEqual([]);
    for (const ledger of [undefined, PROPERTY_LEDGER_VIEW]) {
      const schema = mappingSchemaOf(ledger);
      expect(strictDefects(schema)).toEqual([]);
      const text = JSON.stringify(schema);
      for (const key of ['"copy"', '"source"', '"quote"']) expect(text.includes(key), key).toBe(false);
    }
    expect(MAPPING_SCHEMA_NAME).toBe("mapping");
  });
});

describe("C2' の正例", () => {
  it("要件ごとに 1 件・行の ID で所属を書いた応答は問題 0 で、所属・確かめ方・分類が fixture の表と深く等しい。参照の照合の数は 0", async () => {
    const { outcome, recording } = await run([GOOD]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.table).toEqual(TABLE);
    expect(outcome.value.tableSha256).toBe(await nameTableSha256(TABLE));
    const roles = TABLE.ownership.reduce((total, entry) => total + entry.roles.length, 0);
    expect(outcome.references).toEqual({ checked: LIST.requirements.length + roles, unknown: 0, duplicate: 0, crossBundle: 0 });
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
    if (outcome.ok) expect(outcome.value.table).toEqual(TABLE);
  });

  it("default-value の要件（R6）は所属させた選択肢の項目の options の値で通る", async () => {
    const list = fixtureDefaultValueList();
    const table = withCodeIds(fixtureDefaultValueTable());
    const { outcome } = await run([idsResponsesOf(list, table).mapping], { list, table });
    expect(outcome.ok).toBe(true);
  });
});

describe("C2' の負例：固定文で落ち、形のやり直し 1 回のあと 2 回で unmet", () => {
  const rowOf = (index: number) => (entries()[index] as Entry);
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
    {
      label: "structural で checks 無し",
      bad: () => withEntries(entries().map((entry, index) => (index === 1 ? { ...entry, verification: { ...(entry["verification"] as Entry), checks: [] } } : entry))),
      message: "構造で確かめる要件に checks が無い",
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

  it("default-value の value が options の外・所属 0 行の要件でない文に所属を書いた、は固定文で落ちる", async () => {
    const list = fixtureDefaultValueList();
    const table = withCodeIds(fixtureDefaultValueTable());
    const good = idsResponsesOf(list, table).mapping["requirements"] as Entry[];
    const outside = good.map((entry, index) => (index === 5 ? { ...entry, verification: { ...(entry["verification"] as Entry), value: "gamma" } } : entry));
    const first = await run([withEntries(outside), withEntries(outside)], { list, table });
    expect(messagesOf(first.outcome)).toContain("既定値で確かめる要件の value が、所属させた選択肢の項目の options に無い");
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
