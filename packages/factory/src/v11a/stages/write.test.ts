// v1.1α の B1（書く段。stages/write.ts）の unit テスト（07-architecture-v1.1a.md §1・D4。Issue #509）。
//
// 偽物の LLM・偽物の時計だけで閉じる。外部の API は呼ばない。
import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../../limits.js";
import { ruleDefinitionDefects, ruleTexts, type RejectedCandidate } from "../../stages/prompt.js";
import { utf8ByteLength } from "../../stages/write.js";
import {
  expectNoAcceptanceMaterial,
  makeGateway,
  SAMPLE_DOCUMENTS,
} from "../../stages/__tests__/prompt.js";
import {
  createCheckedRecordingClient,
  negative,
  recordedStructured,
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
  WRITE_V11A_IDS_R07_DEFINITION,
  WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME,
  WRITE_V11A_RULE_DEFINITIONS,
  WRITE_V11A_REWRITE_DATA_NAME,
  WRITE_V11A_REWRITE_RULE_DEFINITIONS,
  WRITE_V11A_RULES,
  WRITE_V11A_SCHEMA_NAME,
  checkWriteV11aOutput,
  runWriteV11a,
  withIdsValidationRule,
  writeV11aRuleDefinitionsOf,
  type WriteV11aInput,
} from "./write.js";
import { requiredValidationsOf, type RequiredValidation } from "../bind-by-id.js";
import type { TestObserves } from "./test-spec.js";
import { NAMED_FAILURE_MESSAGES, type NamedFailure } from "../../v12/search-repair.js";

const structured = recordedStructured;

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
  client: ReturnType<typeof createCheckedRecordingClient>["client"],
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
    const recording = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
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
      inputWith(createCheckedRecordingClient([structured({ declaration })]).client, {
        gateway: makeGateway(createCheckedRecordingClient([structured({ declaration })]).client, { maxAttempts: 1 }),
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
    const recording = createCheckedRecordingClient([structured({ declaration: "" }), structured({ declaration: FIXTURE_YAML })]);
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
    const recording = createCheckedRecordingClient([
      structured(negative({}, "declaration が無い応答。strict の schema では出ないが、形の落ちとやり直しを観測する負例")),
      structured(negative({ declaration: 1 }, "declaration が文字列でない応答。strict の schema では出ないが、形の落ちとやり直しを観測する負例")),
    ]);
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
    const without = createCheckedRecordingClient(answers());
    const withHook = createCheckedRecordingClient(answers());
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
    const recording = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
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
    const recording = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
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
    const a = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const b = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
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
    const on = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const off = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const twoA = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
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
    const now = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const before = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
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

describe("空の文脈での作り直し（旗 v12.search-repair。Issue #551）：rewrite を渡したときだけ失敗の一覧と規則 1 つを末尾に足す", () => {
  const FAILURES: readonly NamedFailure[] = [
    { testId: "t1", requirementId: "R1", kind: "test-mismatch", message: NAMED_FAILURE_MESSAGES["test-mismatch"] },
    { testId: null, requirementId: "R2", kind: "decl-rejection", message: NAMED_FAILURE_MESSAGES["decl-rejection"] },
  ];

  it("作り直しの規則の定義に不備が無く、ID は R-w11r-nn。固定した試験・要件・表を変えないことを述べる", () => {
    expect(ruleDefinitionDefects(WRITE_V11A_REWRITE_RULE_DEFINITIONS)).toEqual([]);
    expect(ruleDefinitionDefects([...WRITE_V11A_RULE_DEFINITIONS, ...WRITE_V11A_REWRITE_RULE_DEFINITIONS])).toEqual([]);
    expect(WRITE_V11A_REWRITE_RULE_DEFINITIONS.every((rule) => /^R-w11r-\d\d$/.test(rule.id))).toBe(true);
    const text = WRITE_V11A_REWRITE_RULE_DEFINITIONS.map((rule) => rule.text).join("\n");
    expect(text).toContain("前の宣言は渡さない");
    expect(text).toContain("固定した試験・要件・名前の表は変えない");
  });

  it("要求の差は末尾のデータ「残った失敗の一覧」と規則 1 つだけで、一覧は試験 ID・要件 ID・種類・固定文だけ。省けば今の要求とバイト列で同じ", async () => {
    const plain = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(inputWith(plain.client));
    const again = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(inputWith(again.client, {}));
    const rewrite = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const outcome = await runWriteV11a(inputWith(rewrite.client, { rewrite: { failures: FAILURES } }));
    expect(outcome.ok).toBe(true);
    const [base] = plain.structured;
    const [same] = again.structured;
    const [rewritten] = rewrite.structured;
    if (base === undefined || same === undefined || rewritten === undefined) throw new Error("前提が壊れた");
    expect(JSON.stringify(same)).toBe(JSON.stringify(base));
    expect(base.rules).toEqual(WRITE_V11A_RULES);
    expect(rewritten.rules).toEqual([...WRITE_V11A_RULES, ...WRITE_V11A_REWRITE_RULE_DEFINITIONS.map((rule) => rule.text)]);
    const names = [...rewritten.input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1]);
    expect(names).toEqual([...WRITE_V11A_DATA_NAMES, WRITE_V11A_REWRITE_DATA_NAME]);
    expect(rewritten.input.startsWith(base.input)).toBe(true);
    const block = rewritten.input.split(`<data name="${WRITE_V11A_REWRITE_DATA_NAME}">`)[1]?.split("</data>")[0] ?? "";
    expect(JSON.parse(block)).toEqual(FAILURES.map((failure) => ({ ...failure })));
    for (const entry of JSON.parse(block) as Record<string, unknown>[]) {
      expect(Object.keys(entry)).toEqual(["testId", "requirementId", "kind", "message"]);
    }
    expect(rewritten.schema).toBe(base.schema);
    expect(rewritten.instructions).toBe(base.instructions);
    expect(rewritten.documents).toEqual(base.documents);
    expectNoAcceptanceMaterial([rewritten.instructions, rewritten.input, ...rewritten.documents, ...(rewritten.rules ?? [])]);
  });

  it("旗 on の台帳と組んでも、作り直しの規則は台帳の規則の後ろに足すだけ", async () => {
    const ledger = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(inputWith(ledger.client, { ledger: PROPERTY_LEDGER_VIEW, table: withAggregates(fixtureTable()) }));
    const both = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(
      inputWith(both.client, { ledger: PROPERTY_LEDGER_VIEW, table: withAggregates(fixtureTable()), rewrite: { failures: FAILURES } }),
    );
    expect(both.structured[0]?.rules).toEqual([
      ...(ledger.structured[0]?.rules ?? []),
      ...WRITE_V11A_REWRITE_RULE_DEFINITIONS.map((rule) => rule.text),
    ]);
  });
});

describe("旗 v12.ids：要る検査の骨組みを渡したときだけ、「固定した試験」の後に塊を足し、R-w11-07 を旗 ids の文にする（Issue #666）", () => {
  const SKELETON: readonly RequiredValidation[] = requiredValidationsOf(fixtureTable(), SUITE, new Map([["t1", "validation"]]));
  const original = WRITE_V11A_RULE_DEFINITIONS.find((definition) => definition.id === "R-w11-07");
  const blockOf = (input: string, name: string): unknown =>
    JSON.parse(input.split(`<data name="${name}">`)[1]?.split("</data>")[0] ?? "null");

  it("骨組みは固定した試験から導いた 1 件（item・amount）", () => {
    expect(SKELETON).toEqual([{ entity: "item", name: "amount", rowId: "f.item.amount", rowKind: "field", testIds: ["t1"], conflict: false }]);
  });

  it("R-w11-07 の旗 ids の文：ID・why は同じで since に履歴。元の禁止の文をそのまま含み、例外は骨組みに競合なしで列挙された検査だけ（j：骨組みに無い要素に表の名前を許す文が無い）。規則の不備は 0", () => {
    if (original === undefined) throw new Error("前提が壊れた：R-w11-07 が無い");
    expect(WRITE_V11A_IDS_R07_DEFINITION.id).toBe(original.id);
    expect(WRITE_V11A_IDS_R07_DEFINITION.why).toBe(original.why);
    expect(WRITE_V11A_IDS_R07_DEFINITION.since).toContain(original.since);
    expect(WRITE_V11A_IDS_R07_DEFINITION.since).toContain("Issue #666");
    const text = WRITE_V11A_IDS_R07_DEFINITION.text;
    expect(text.startsWith(original.text)).toBe(true);
    const added = text.slice(original.text.length);
    // 例外の文は 1 つで、骨組みに競合なしで列挙された検査だけを指す
    expect(added.match(/例外/g)).toHaveLength(1);
    expect(added).toContain("この禁止の唯一の例外は、データ「要る検査の骨組み」に競合なしで列挙された検査で、その entity と名前で validations に 1 つずつ書く");
    expect(added).toContain("競合の印の付いた件は書かない。");
    expect(added).toContain("骨組みに無い補助の要素には表の名前を使わない。");
    expect(added).not.toMatch(/計算.*例外|例外.*計算/);
    expect(added).not.toMatch(/使ってよい|奪ってよい/);
    // ほかの規則の文・順は同じ（台帳 on・off のどちらの組み立てにも同じに効く）
    for (const definitions of [WRITE_V11A_RULE_DEFINITIONS, writeV11aRuleDefinitionsOf(PROPERTY_LEDGER_VIEW)]) {
      const ids = withIdsValidationRule(definitions);
      expect(ids.map((definition) => definition.id)).toEqual(definitions.map((definition) => definition.id));
      ids.forEach((definition, index) => {
        expect(definition).toEqual(definition.id === "R-w11-07" ? WRITE_V11A_IDS_R07_DEFINITION : definitions[index]);
      });
      expect(ruleDefinitionDefects(ids)).toEqual([]);
      expect(ruleDefinitionDefects([...ids, ...WRITE_V11A_REWRITE_RULE_DEFINITIONS])).toEqual([]);
    }
    // off の文は不変
    expect(WRITE_V11A_RULES).toContain(original.text);
    expect(WRITE_V11A_RULES).not.toContain(text);
  });

  it("要求の差は「固定した試験」の後の塊 1 つと R-w11-07 の文だけ。塊は骨組みの JSON のまま。省けば今の要求とバイト列で同じ", async () => {
    const plain = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    const ids = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(inputWith(plain.client));
    expect((await runWriteV11a(inputWith(ids.client, { requiredValidations: SKELETON }))).ok).toBe(true);
    const [base, request] = [plain.structured[0], ids.structured[0]];
    if (base === undefined || request === undefined) throw new Error("要求が無い");
    expect(base.rules).toEqual(WRITE_V11A_RULES);
    const names = [...request.input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1]);
    expect(names).toEqual([...WRITE_V11A_DATA_NAMES, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME]);
    expect(request.input).toBe(`${base.input}\n<data name="${WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME}">\n${JSON.stringify(SKELETON, null, 2)}\n</data>`);
    expect(blockOf(request.input, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME)).toEqual(SKELETON);
    expect(request.rules).toEqual(ruleTexts(withIdsValidationRule(WRITE_V11A_RULE_DEFINITIONS)));
    expect(request.rules?.filter((text, index) => text !== base.rules?.[index])).toEqual([WRITE_V11A_IDS_R07_DEFINITION.text]);
    expect(request.instructions).toBe(base.instructions);
    expect(request.documents).toEqual(base.documents);
    expect(request.schema).toBe(base.schema);
    // 空の骨組みも渡せば塊（空の並び）として載る
    const empty = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(inputWith(empty.client, { requiredValidations: [] }));
    expect(blockOf(empty.structured[0]?.input ?? "", WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME)).toEqual([]);
    expectNoAcceptanceMaterial([request.input, ...(request.rules ?? [])]);
  });

  it("空の文脈での作り直しも同じ塊を持つ（固定した試験の後・残った失敗の一覧の前）。台帳と組んでも R-w11-07 だけが差し替わる", async () => {
    const failures: readonly NamedFailure[] = [
      { testId: "t1", requirementId: "R1", kind: "test-mismatch", message: NAMED_FAILURE_MESSAGES["test-mismatch"] },
    ];
    const ledgerOnly = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(inputWith(ledgerOnly.client, { ledger: PROPERTY_LEDGER_VIEW, table: withAggregates(fixtureTable()), rewrite: { failures } }));
    const both = createCheckedRecordingClient([structured({ declaration: FIXTURE_YAML })]);
    await runWriteV11a(
      inputWith(both.client, { ledger: PROPERTY_LEDGER_VIEW, table: withAggregates(fixtureTable()), rewrite: { failures }, requiredValidations: SKELETON }),
    );
    const [base, request] = [ledgerOnly.structured[0], both.structured[0]];
    if (base === undefined || request === undefined) throw new Error("要求が無い");
    const names = [...request.input.matchAll(/<data name="([^"]+)">/g)].map((match) => match[1]);
    expect(names).toEqual([...WRITE_V11A_DATA_NAMES, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME, WRITE_V11A_REWRITE_DATA_NAME]);
    expect(blockOf(request.input, WRITE_V11A_REQUIRED_VALIDATIONS_DATA_NAME)).toEqual(SKELETON);
    expect(request.rules).toEqual((base.rules ?? []).map((text) => (text === original?.text ? WRITE_V11A_IDS_R07_DEFINITION.text : text)));
    expect(request.rules?.slice(-1)).toEqual(ruleTexts(WRITE_V11A_REWRITE_RULE_DEFINITIONS));
  });
});
