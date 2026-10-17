// v1.1α の B1（書く段。stages/write.ts）の unit テスト（07-architecture-v1.1a.md §1・D4。Issue #509）。
//
// 偽物の LLM・偽物の時計だけで閉じる。外部の API は呼ばない。
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../../limits.js";
import { ruleDefinitionDefects, type RejectedCandidate } from "../../stages/prompt.js";
import { utf8ByteLength } from "../../stages/write.js";
import {
  createRecordingClient,
  expectNoAcceptanceMaterial,
  makeGateway,
  SAMPLE_DOCUMENTS,
} from "../../stages/__tests__/prompt.js";
import {
  EMPTY_AGGREGATE_REQUEST_DIFF,
  ENUM_MEMBERSHIP_REQUEST_DIFF,
  FIXTURE_YAML,
  LEDGER_VIEW_2A,
  LEDGER_VIEW_2B,
  withAggregates,
  withoutEmptyAggregate,
  fixtureList,
  fixtureTable,
  requestDiffsOf,
  withoutEnumMembership,
} from "../__tests__/fixtures.js";
import { PROPERTY_LEDGER, PROPERTY_LEDGER_VIEW } from "../../v12/ledger.js";
import * as writeModule from "./write.js";
import {
  DECLARATION_V11A_SCHEMA,
  WRITE_V11A_DATA_NAMES,
  WRITE_V11A_RULE_DEFINITIONS,
  WRITE_V11A_RULES,
  WRITE_V11A_SCHEMA_NAME,
  checkWriteV11aOutput,
  runWriteV11a,
  writeV11aRuleDefinitionsOf,
  type WriteV11aInput,
} from "./write.js";
import type { TestObserves } from "./test-spec.js";

const structured = (output: unknown) => ({ kind: "structured" as const, output, usage: undefined });

const SUITE = {
  tests: [
    {
      id: "t1",
      target: { requirementId: "R1", kind: "field", roleId: "f.item.amount" },
      kind: "normal",
      operation: "validate",
      clock: "2026-09-16T12:00:00+09:00",
      input: { value: 1 },
      referenceData: [],
      expected: { kind: "ok", value: 1 },
    },
  ],
} as unknown as WriteV11aInput["suite"];

const inputWith = (
  client: ReturnType<typeof createRecordingClient>["client"],
  extra: Partial<WriteV11aInput> = {},
): WriteV11aInput => ({
  list: fixtureList(),
  table: fixtureTable(),
  suite: SUITE,
  observes: new Map([["t1", "validation"]]),
  documents: SAMPLE_DOCUMENTS,
  gateway: makeGateway(client),
  ...extra,
});

describe("B1 が送る要求を観測する", () => {
  it("schema に mappings が無く、declaration が必須で、additionalProperties が false", () => {
    expect(DECLARATION_V11A_SCHEMA.required).toEqual(["declaration"]);
    expect(DECLARATION_V11A_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(DECLARATION_V11A_SCHEMA.properties)).toEqual(["declaration"]);
    expect(JSON.stringify(DECLARATION_V11A_SCHEMA)).not.toContain("mappings");
  });

  it("データは仕様・名前の表・試験の順で、文書は共通の口で渡る。表の塊に name と持ち越しで除いた行がある", async () => {
    const recording = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const table = fixtureTable();
    const outcome = await runWriteV11a(inputWith(recording.client, { table }));
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.schemaName).toBe(WRITE_V11A_SCHEMA_NAME);
    expect(request.schema).toBe(DECLARATION_V11A_SCHEMA);
    const names = [...request.input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1]);
    expect(names).toEqual([...WRITE_V11A_DATA_NAMES]);
    expect(request.documents).toHaveLength(SAMPLE_DOCUMENTS.length);
    // 表の塊（全行。持ち越しで除いた行も見せる）
    const block = request.input.split('<data name="名前の表">')[1]?.split("</data>")[0] ?? "";
    const rows = JSON.parse(block) as { id: string; name: string }[];
    expect(rows.map((row) => row.id)).toEqual(table.rows.map((row) => row.id));
    for (const row of table.rows) expect(rows.find((r) => r.id === row.id)?.name).toBe(row.name);
    // 期待の裁定・合否の塊は無い
    expect(request.input.match(/<data name=/g)).toHaveLength(3);
    expect(request.input).not.toMatch(/裁定|合否|arbitrat|verdict/);
    expectNoAcceptanceMaterial([request.instructions, request.input, ...request.documents, ...(request.rules ?? [])]);
  });

  it("規則の定義に不備が無く、表の名前どおり・付け替えない・月の groupBy・表に無い要素の条件がある", () => {
    expect(ruleDefinitionDefects(WRITE_V11A_RULE_DEFINITIONS)).toEqual([]);
    expect(WRITE_V11A_RULE_DEFINITIONS.every((rule) => /^R-w11-\d\d$/.test(rule.id))).toBe(true);
    const text = WRITE_V11A_RULES.join("\n");
    expect(text).toContain("そのまま使う");
    expect(text).toContain("付け替えない");
    expect(text).toContain("月");
    expect(text).toContain("groupBy");
    expect(text).toContain("要件に要るときだけ");
    expect(text).toContain("名前を奪わない");
    expect(text).toContain("options");
    expect(text).toContain("refEntity");
  });
});

describe("B1 は書いた直後に宣言の大きさを確かめる（③ と同じ値）", () => {
  const run = (declaration: string) =>
    runWriteV11a(
      inputWith(createRecordingClient([structured({ declaration })]).client, {
        gateway: makeGateway(createRecordingClient([structured({ declaration })]).client, { maxAttempts: 1 }),
      }),
    );

  it("上限ちょうどは通る", async () => {
    const atLimit = "a".repeat(AGENT_LIMITS.declarationBytes);
    const outcome = await run(atLimit);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.byteLength).toBe(AGENT_LIMITS.declarationBytes);
  });

  it("1 バイト超過は limit で断る", async () => {
    const outcome = await run("a".repeat(AGENT_LIMITS.declarationBytes + 1));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("limit");
    if (outcome.failure.kind !== "limit") return;
    expect(outcome.failure.limit).toBe("declarationBytes");
    expect(outcome.failure.max).toBe(AGENT_LIMITS.declarationBytes);
    expect(outcome.failure.actual).toBe(AGENT_LIMITS.declarationBytes + 1);
  });
});

describe("B1 の形の落ちは共通の窓口が 1 回やり直す", () => {
  it("形に 1 回落ちて通る：calls 2・口が 1 回", async () => {
    const recording = createRecordingClient([structured({ declaration: "" }), structured({ declaration: FIXTURE_YAML })]);
    const candidates: RejectedCandidate[] = [];
    const input = inputWith(recording.client);
    const outcome = await runWriteV11a({ ...input, onRejected: (candidate) => candidates.push(candidate) });
    expect(outcome.ok).toBe(true);
    expect(input.gateway.calls).toBe(2);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe("shape");
    expect(candidates[0]?.attempt).toBe(1);
  });

  it("2 回落ちれば malformed・calls 2・口が 2 回", async () => {
    const recording = createRecordingClient([structured({}), structured({ declaration: 1 })]);
    const candidates: RejectedCandidate[] = [];
    const input = inputWith(recording.client);
    const outcome = await runWriteV11a({ ...input, onRejected: (candidate) => candidates.push(candidate) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("malformed");
    expect(input.gateway.calls).toBe(2);
    expect(candidates.map((candidate) => candidate.attempt)).toEqual([1, 2]);
  });

  it("口の有無で、偽物が受け取った要求が同じ", async () => {
    const answers = () => [structured({ declaration: "" }), structured({ declaration: FIXTURE_YAML })];
    const without = createRecordingClient(answers());
    const withHook = createRecordingClient(answers());
    await runWriteV11a(inputWith(without.client));
    await runWriteV11a({ ...inputWith(withHook.client), onRejected: () => undefined });
    expect(JSON.stringify(withHook.structured)).toBe(JSON.stringify(without.structured));
    expect(withHook.structured).toHaveLength(2);
  });

  it("形の確認：declaration だけを受け、mappings の欄は読まない", () => {
    expect(checkWriteV11aOutput({ declaration: FIXTURE_YAML })).toEqual({ ok: true, value: { declaration: FIXTURE_YAML } });
    expect(checkWriteV11aOutput({ declaration: FIXTURE_YAML, mappings: [] }).ok).toBe(true);
    expect(checkWriteV11aOutput({ declaration: "" }).ok).toBe(false);
    expect(checkWriteV11aOutput("nope").ok).toBe(false);
  });
});

describe("B1 の戻り値と、追加の要素の一覧を持たないこと", () => {
  it("戻り値は {declaration, byteLength, declarationSha256} で、SHA は sha256Hex(source) と等しい", async () => {
    const recording = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const outcome = await runWriteV11a(inputWith(recording.client));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.value).sort()).toEqual(["byteLength", "declaration", "declarationSha256"]);
    expect(outcome.value.declaration).toBe(FIXTURE_YAML);
    expect(outcome.value.byteLength).toBe(utf8ByteLength(FIXTURE_YAML));
    expect(outcome.value.declarationSha256).toBe(await sha256Hex(FIXTURE_YAML));
  });

  it("このファイルは追加の要素を抽出する関数を持たない（A1 の extraElementsOf・同名の関数を公開しない）", () => {
    const exported = Object.keys(writeModule);
    expect(exported.filter((name) => /extra|declarationElements/i.test(name))).toEqual([]);
  });
});

describe("B1 のデータ「固定した試験」に試験ごとの observes を添える（Issue #533）", () => {
  /** 既定値の試験を含む組（区分の項目の既定値。形は T2 が固定したものと同じ） */
  const DEFAULT_SUITE = {
    tests: [
      ...SUITE.tests,
      {
        id: "t2",
        target: { requirementId: "R1", kind: "field", roleId: "f.item.kind" },
        kind: "normal",
        operation: "validate",
        clock: "2026-09-16T12:00:00+09:00",
        input: {},
        referenceData: [],
        expected: { kind: "ok", value: "alpha" },
      },
    ],
  } as unknown as WriteV11aInput["suite"];
  const OBSERVES = new Map([
    ["t1", "validation" as const],
    ["t2", "default-value" as const],
  ]);

  const blockOf = (input: string, name: string): unknown =>
    JSON.parse(input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "null");

  it("各試験に observes があり、observes を除いた組は固定した組と同じ", async () => {
    const recording = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const outcome = await runWriteV11a(inputWith(recording.client, { suite: DEFAULT_SUITE, observes: OBSERVES }));
    expect(outcome.ok).toBe(true);
    const request = recording.structured[0];
    if (request === undefined) throw new Error("要求が無い");
    const shown = blockOf(request.input, WRITE_V11A_DATA_NAMES[2]) as { tests: Record<string, unknown>[] };
    expect(shown.tests.map((test) => test["observes"])).toEqual(["validation", "default-value"]);
    const withoutObserves = {
      ...shown,
      tests: shown.tests.map(({ observes: _observes, ...rest }) => rest),
    };
    expect(withoutObserves).toEqual(JSON.parse(JSON.stringify(DEFAULT_SUITE)));
  });

  it("規則に default の 1 文があり、schema・前置き・ほかの規則は今までどおり", async () => {
    const rule = WRITE_V11A_RULE_DEFINITIONS.find((definition) => definition.id === "R-w11-10");
    expect(rule?.text).toContain("default-value");
    expect(rule?.text).toContain("default に");
    expect(rule?.since).toBe("Issue #533");
    // 足したのは末尾の 1 つだけ（ほかの規則の並び・文は変えない）
    expect(WRITE_V11A_RULE_DEFINITIONS.map((definition) => definition.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `R-w11-${String(index + 1).padStart(2, "0")}`),
    );
    expect(DECLARATION_V11A_SCHEMA.required).toEqual(["declaration"]);
    // 同じ組で observes だけを変えても、データの「固定した試験」の塊のほかは変わらない
    const a = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const b = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(inputWith(a.client, { suite: DEFAULT_SUITE, observes: OBSERVES }));
    await runWriteV11a(inputWith(b.client, { suite: DEFAULT_SUITE, observes: new Map([["t1", "validation"]]) }));
    const [ra, rb] = [a.structured[0], b.structured[0]];
    if (ra === undefined || rb === undefined) throw new Error("要求が無い");
    expect(ra.instructions).toBe(rb.instructions);
    expect(ra.rules).toEqual(rb.rules);
    expect(ra.documents).toEqual(rb.documents);
    expect(ra.schema).toBe(rb.schema);
    expect(blockOf(ra.input, WRITE_V11A_DATA_NAMES[0])).toEqual(blockOf(rb.input, WRITE_V11A_DATA_NAMES[0]));
    expect(blockOf(ra.input, WRITE_V11A_DATA_NAMES[1])).toEqual(blockOf(rb.input, WRITE_V11A_DATA_NAMES[1]));
    // 写像に無い試験は null を添える（組から落とさない）
    const shown = blockOf(rb.input, WRITE_V11A_DATA_NAMES[2]) as { tests: Record<string, unknown>[] };
    expect(shown.tests.map((test) => test["observes"])).toEqual(["validation", null]);
    expectNoAcceptanceMaterial([ra.input, ...(ra.rules ?? [])]);
  });
});

describe("旗 on：B1 の規則の末尾に台帳の B1 の文を台帳の順で差し込む（Issue #548。今の台帳との比べは #548 の台帳＝empty-aggregate の行を除いた導出で。#549）", () => {
  const ROW = PROPERTY_LEDGER.find((entry) => entry.id === "enum-membership");
  /** 選択肢の集合の試験を含む組（区分の項目の options の並び。形は T2 が固定したものと同じ） */
  const ENUM_SUITE = {
    tests: [
      ...SUITE.tests,
      {
        id: "t2",
        target: { requirementId: "R1", kind: "field", roleId: "f.item.kind" },
        kind: "normal",
        operation: "validate",
        clock: "2026-09-16T12:00:00+09:00",
        input: {},
        referenceData: [],
        expected: { kind: "ok", value: ["alpha", "beta"] },
      },
    ],
  } as unknown as WriteV11aInput["suite"];
  // 台帳から入る観測する性質（off の型 `TestObserves` の外。走りでは台帳の導出で通る）
  const OBSERVES = new Map<string, TestObserves>([
    ["t1", "validation"],
    ["t2", "enum-membership" as TestObserves],
  ]);
  const blockOf = (input: string, name: string): unknown =>
    JSON.parse(input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "null");

  it("off は今の定数。手 2a の台帳で組んだ R-w11-10 は今の文とバイト列で同じ。#548 の台帳は R-w11-11 に enum-membership の 1 文が増えるだけ。規則の不備は 0", () => {
    expect(writeV11aRuleDefinitionsOf()).toBe(WRITE_V11A_RULE_DEFINITIONS);
    expect(writeV11aRuleDefinitionsOf(LEDGER_VIEW_2A)).toEqual(WRITE_V11A_RULE_DEFINITIONS);
    const on = writeV11aRuleDefinitionsOf(LEDGER_VIEW_2B);
    expect(on.slice(0, WRITE_V11A_RULE_DEFINITIONS.length)).toEqual(WRITE_V11A_RULE_DEFINITIONS);
    expect(on.map((definition) => definition.id)).toEqual(
      Array.from({ length: 11 }, (_, index) => `R-w11-${String(index + 1).padStart(2, "0")}`),
    );
    expect(on.at(-1)?.text).toBe(ROW?.rules.b1);
    expect(on.at(-1)?.text).toContain("observes が enum-membership の試験は");
    expect(on.at(-1)?.text).toContain("名前の表の行の options のキーの順で書く");
    expect(on.at(-1)?.since).toBe("Issue #548");
    for (const definitions of [WRITE_V11A_RULE_DEFINITIONS, writeV11aRuleDefinitionsOf(LEDGER_VIEW_2A), on]) {
      expect(ruleDefinitionDefects(definitions)).toEqual([]);
    }
  });

  it("旗 on の要求：規則に enum-membership の 1 文があり、固定した試験に observes が渡る。off は今の文で、差は規則の並びだけ", async () => {
    const on = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const off = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const twoA = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    expect((await runWriteV11a(inputWith(on.client, { suite: ENUM_SUITE, observes: OBSERVES, ledger: LEDGER_VIEW_2B }))).ok).toBe(true);
    expect((await runWriteV11a(inputWith(off.client, { suite: ENUM_SUITE, observes: OBSERVES }))).ok).toBe(true);
    expect((await runWriteV11a(inputWith(twoA.client, { suite: ENUM_SUITE, observes: OBSERVES, ledger: LEDGER_VIEW_2A }))).ok).toBe(true);
    const [ron, roff] = [on.structured[0], off.structured[0]];
    if (ron === undefined || roff === undefined) throw new Error("要求が無い");
    expect(ron.rules).toContain(ROW?.rules.b1);
    expect(roff.rules).toEqual(WRITE_V11A_RULES);
    expect(roff.rules).not.toContain(ROW?.rules.b1);
    const shown = blockOf(ron.input, WRITE_V11A_DATA_NAMES[2]) as { tests: Record<string, unknown>[] };
    expect(shown.tests.map((test) => test["observes"])).toEqual(["validation", "enum-membership"]);
    const onRequests = JSON.parse(JSON.stringify(on.structured)) as unknown[];
    const offRequests = JSON.parse(JSON.stringify(off.structured)) as unknown[];
    expect(requestDiffsOf(onRequests, offRequests).map((diff) => diff.paths)).toEqual([ENUM_MEMBERSHIP_REQUEST_DIFF[WRITE_V11A_SCHEMA_NAME]]);
    expect(JSON.stringify(withoutEnumMembership(onRequests))).toBe(JSON.stringify(offRequests));
    expect(JSON.stringify(twoA.structured)).toBe(JSON.stringify(off.structured));
    expectNoAcceptanceMaterial([ron.input, ...(ron.rules ?? [])]);
  });
});

describe("旗 on：今の台帳の B1 の規則は、#548 の台帳の末尾に empty-aggregate の 1 文（R-w11-12）が増えるだけ（Issue #549）", () => {
  const ROW = PROPERTY_LEDGER.find((entry) => entry.id === "empty-aggregate");

  it("規則に aggregate の 1 文がある（宣言の集計の種類と集計元を表の行のとおりに書く）。off は今の文。規則の不備は 0", () => {
    const on = writeV11aRuleDefinitionsOf(PROPERTY_LEDGER_VIEW);
    expect(on.slice(0, -1)).toEqual(writeV11aRuleDefinitionsOf(LEDGER_VIEW_2B));
    expect(on.at(-1)?.id).toBe("R-w11-12");
    expect(on.at(-1)?.text).toBe(ROW?.rules.b1);
    expect(on.at(-1)?.text).toContain("aggregate の種類（sum・count・avg）と集計元の entity");
    expect(on.at(-1)?.text).toContain("その行の aggregate の種類と、集計元の entity の行の名前のとおりに書く");
    expect(on.at(-1)?.since).toBe("Issue #549");
    expect(ruleDefinitionDefects(on)).toEqual([]);
    expect(writeV11aRuleDefinitionsOf()).toBe(WRITE_V11A_RULE_DEFINITIONS);
    expect(WRITE_V11A_RULES).not.toContain(ROW?.rules.b1);
  });

  it("要求：今の台帳と #548 の台帳の差は規則の並び（と、名前の表の計算の行の aggregate の欄）だけ。schema は変えない", async () => {
    const now = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const before = createRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    expect((await runWriteV11a(inputWith(now.client, { table: withAggregates(fixtureTable()), ledger: PROPERTY_LEDGER_VIEW }))).ok).toBe(true);
    expect((await runWriteV11a(inputWith(before.client, { ledger: LEDGER_VIEW_2B }))).ok).toBe(true);
    const nowRequests = JSON.parse(JSON.stringify(now.structured)) as unknown[];
    const beforeRequests = JSON.parse(JSON.stringify(before.structured)) as unknown[];
    const expected = [...(EMPTY_AGGREGATE_REQUEST_DIFF[WRITE_V11A_SCHEMA_NAME] ?? [])];
    expect(requestDiffsOf(nowRequests, beforeRequests).map((diff) => diff.paths)).toEqual([[...expected, "$.input"]]);
    expect(JSON.stringify(withoutEmptyAggregate(nowRequests))).toBe(JSON.stringify(beforeRequests));
    expect(now.structured[0]?.schema).toBe(DECLARATION_V11A_SCHEMA);
    // 名前の表の塊の計算の行に aggregate が載る
    const shown = JSON.parse(now.structured[0]!.input.split(`<data name="${WRITE_V11A_DATA_NAMES[1]}">`)[1]?.split("</data>")[0] ?? "null") as unknown;
    expect(JSON.stringify(shown)).toContain('"aggregate":{"kind":"count","entity":"e.item"}');
    expectNoAcceptanceMaterial([now.structured[0]!.input, ...(now.structured[0]!.rules ?? [])]);
  });
});
