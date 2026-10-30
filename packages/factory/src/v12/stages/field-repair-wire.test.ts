// 欄だけの直しの通信（偽物の fetch で adapter を通す。`envelope` は v1.1a。Issue #553）。
//
// この段の schema の名前は共通の封筒（v1・v1.1α）のどちらにも登録しないので、adapter は往復ごとに組んだ動的な schema
// （場所の enum つき）をそのまま `text.format` に載せる（判定の口と同じ道）。共通の封筒・その一覧・adapter のコードは変えない。
// **そのため、この段の要求は前置き（出力の schema）が他の段と別になり、段をまたぐキャッシュは当たらない**（往復ごとに場所の
// enum が違えば、この段どうしでも当たらない）。実 API・鍵は使わない。
import { describe, expect, it } from "vitest";
import type { FixedTest, TestSuite } from "../../fixed-test.js";
import type { LlmStructuredRequest } from "../../llm.js";
import { createOllamaLlmClient } from "../../ollama.js";
import { createOpenAiLlmClient, type FetchLike } from "../../openai.js";
import { ENVELOPE_SCHEMA_NAME_V11A, ENVELOPE_SCHEMA_V11A, envelopeStageFor } from "../../schema-envelope.js";
import { makeGateway } from "../../stages/__tests__/prompt.js";
import { FIXTURE_DOCUMENTS, FIXTURE_YAML, fixtureList, fixtureTable, fixtureYaml } from "../../v11a/__tests__/fixtures.js";
import { requiredValidationsOf } from "../../v11a/bind-by-id.js";
import type { TestObserves } from "../../v11a/stages/test-spec.js";
import { DECLARATION_V11A_SCHEMA, WRITE_V11A_SCHEMA_NAME } from "../../v11a/stages/write.js";
import { locateFailures, buildRepairDiagnostic } from "../locate.js";
import { FIELD_REPAIR_DIAGNOSTIC_DATA_NAME, FIELD_REPAIR_SCHEMA_NAME, fieldRepairSchemaOf, runFieldRepair } from "./field-repair.js";

const LIST = fixtureList();
const SOURCE = LIST.requirements.map((requirement) => requirement.text).join("");

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

const USAGE_WIRE = { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20 };

/** 完了した応答（構造化出力の本文） */
function reply(output: unknown): Response {
  const body = {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }],
    usage: USAGE_WIRE,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** 送った body を記録し、渡した順に応答を返す偽物の fetch */
function recordingFetch(outputs: readonly unknown[]): { readonly fetch: FetchLike; readonly bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return reply(outputs[bodies.length - 1]);
  };
  return { fetch: fetchImpl, bodies };
}

const formatOf = (body: Record<string, unknown> | undefined): { readonly name: string; readonly schema: unknown; readonly strict: boolean } => {
  if (body === undefined) throw new Error("前提が壊れた：要求が無い");
  return (body["text"] as { format: { name: string; schema: unknown; strict: boolean } }).format;
};

/** v1.1α の封筒に載る段（B1）の要求 */
const WRITE_REQUEST: LlmStructuredRequest = {
  instructions: "規則",
  documents: ["文書"],
  rules: [],
  input: "依頼文",
  schemaName: WRITE_V11A_SCHEMA_NAME,
  schema: DECLARATION_V11A_SCHEMA,
  maxOutputTokens: 128,
};
const WRITE_OUTPUT = { result: { stage: WRITE_V11A_SCHEMA_NAME, declaration: "x" } };

const closeItem = "- name: closeItem\n  entity: item\n  kind: update\n  set:\n    kind: beta\n  when: amount > 1";

/** 送った body の入力（`input` の `input_text` を順につなぐ） */
const inputTextOf = (body: Record<string, unknown> | undefined): string => {
  const messages = body?.["input"] as readonly { readonly content?: readonly { readonly type: string; readonly text?: string }[] }[] | undefined;
  return (messages ?? [])
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "input_text")
    .map((part) => part.text ?? "")
    .join("\n");
};

describe("通信：この段の要求は封筒の外で、往復ごとの動的な schema（場所の enum）がそのまま text.format に載る", () => {
  it("(1)(2)(3) 場所の集合が違う 2 往復で送った enum がそれぞれ違い、封筒の anyOf に置き換わらない。同じ client の v1.1α の封筒の段の body は前後で同じ", async () => {
    const answer = { replacements: [{ location: "action:item.closeItem", element: closeItem }], disputes: [] };
    const { fetch, bodies } = recordingFetch([WRITE_OUTPUT, answer, answer, WRITE_OUTPUT]);
    const client = createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" });
    const gateway = makeGateway(client);
    const round = (mismatches: readonly string[]) => {
      const failures = locateFailures({
        source: FIXTURE_YAML,
        table: fixtureTable(),
        suite: SUITE,
        staticCheckPassed: true,
        diagnostics: [],
        correspondenceMisses: [],
        rejections: [],
        unmarked: [],
        mismatches: mismatches.map((testId) => ({ testId })),
        unresolved: [],
      });
      return { failures, run: () => runFieldRepair({ source: SOURCE, list: LIST, suite: SUITE, declaration: FIXTURE_YAML, failures, documents: FIXTURE_DOCUMENTS, gateway }) };
    };

    await client.callStructured(WRITE_REQUEST);
    const first = round(["r3-when", "r4-rate"]);
    const second = round(["r3-when"]);
    const firstOutcome = await first.run();
    const secondOutcome = await second.run();
    await client.callStructured(WRITE_REQUEST);
    expect(firstOutcome.ok).toBe(true);
    expect(secondOutcome.ok).toBe(true);

    // (1) この段の要求：名前はこの段の名前、schema は要求の動的な schema と深く等しく、場所の enum がそのまま残る
    const [writeBefore, repairFirst, repairSecond, writeAfter] = bodies;
    for (const [body, locations] of [
      [repairFirst, first.failures.locations],
      [repairSecond, second.failures.locations],
    ] as const) {
      const format = formatOf(body);
      expect(format.name).toBe(FIELD_REPAIR_SCHEMA_NAME);
      expect(format.strict).toBe(true);
      expect(format.schema).toEqual(fieldRepairSchemaOf(locations));
      expect(JSON.stringify(format.schema)).not.toContain("anyOf");
      expect(JSON.stringify(format.schema)).toContain(JSON.stringify(locations));
    }
    expect(first.failures.locations).toEqual(["action:item.closeItem", "computation:rate"]);
    expect(second.failures.locations).toEqual(["action:item.closeItem"]);
    expect(formatOf(repairFirst).schema).not.toEqual(formatOf(repairSecond).schema);

    // (2) この段の名前は v1・v1.1a のどちらの封筒からも引けない
    expect(envelopeStageFor(FIELD_REPAIR_SCHEMA_NAME, "v1")).toBeUndefined();
    expect(envelopeStageFor(FIELD_REPAIR_SCHEMA_NAME, "v1.1a")).toBeUndefined();

    // (3) 同じ client の v1.1α の封筒の段の body は、この段を挟む前と後で同じ。封筒の名前と schema のバイト列も同じ
    expect(JSON.stringify(writeAfter)).toBe(JSON.stringify(writeBefore));
    expect(formatOf(writeBefore).name).toBe(ENVELOPE_SCHEMA_NAME_V11A);
    expect(JSON.stringify(formatOf(writeBefore).schema)).toBe(JSON.stringify(ENVELOPE_SCHEMA_V11A));
  });
});

describe("通信（旗 v12.ids と探索がともに on。Issue #761）：診断が adapter の body に届く", () => {
  it("(1) 診断を渡すと、body の入力の末尾に「診断」の塊が 1 つあり、試験の観測する性質と表の行（実名へ引いた ID）が届く。渡さなければ届かない", async () => {
    const table = fixtureTable();
    const suite: TestSuite = {
      tests: [test("v-amount", "R1", "field", "f.item.amount", "validate"), ...SUITE.tests],
    };
    const observes = new Map<string, TestObserves>([
      ["v-amount", "validation"],
      ["r3-when", "when"],
      ["r4-rate", "value"],
    ]);
    const failures = locateFailures({
      source: FIXTURE_YAML,
      table,
      suite,
      staticCheckPassed: true,
      diagnostics: [],
      correspondenceMisses: [],
      rejections: [],
      unmarked: [],
      mismatches: [{ testId: "v-amount" }, { testId: "r3-when" }],
      unresolved: [],
      ids: { observes, requiredValidations: requiredValidationsOf(table, suite, observes) },
    });
    const diagnostic = buildRepairDiagnostic({
      table,
      suite,
      observes,
      mismatches: [
        { testId: "v-amount", detail: "検査 amount が落ちない（期待は落ちること）" },
        { testId: "r3-when", detail: "操作 closeItem が無い" },
      ],
      unresolved: [],
      correspondenceMisses: [],
      rejections: [],
      routes: [],
    });
    const answer = { replacements: [], disputes: [] };
    const { fetch, bodies } = recordingFetch([answer, answer]);
    const client = createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" });
    const gateway = makeGateway(client);
    const run = (extra: { readonly diagnostic?: typeof diagnostic }) =>
      runFieldRepair({ source: SOURCE, list: LIST, suite, declaration: FIXTURE_YAML, failures, documents: FIXTURE_DOCUMENTS, gateway, ...extra });
    expect((await run({ diagnostic })).ok).toBe(true);
    expect((await run({})).ok).toBe(true);
    const withDiagnostic = inputTextOf(bodies[0]);
    const without = inputTextOf(bodies[1]);
    const block = new RegExp(`<data name="${FIELD_REPAIR_DIAGNOSTIC_DATA_NAME}">\\n([\\s\\S]*?)\\n</data>`).exec(withDiagnostic);
    if (block === null) throw new Error("前提が壊れた：診断の塊が body に無い");
    expect(JSON.parse(block[1] ?? "null")).toEqual(diagnostic);
    expect(withDiagnostic.endsWith(`<data name="${FIELD_REPAIR_DIAGNOSTIC_DATA_NAME}">`)).toBe(false);
    expect(withDiagnostic.trimEnd().endsWith("</data>")).toBe(true);
    // 観測する性質・表の行（所属は実名。表の ID の e.item は出さない）
    const parsed = JSON.parse(block[1] ?? "null") as { readonly tests: readonly { readonly observes: string | null; readonly table: Record<string, unknown> | null }[] };
    expect(parsed.tests.map((entry) => entry.observes)).toEqual(["validation", "when"]);
    expect(parsed.tests[1]?.table).toMatchObject({ id: "o.closeItem", kind: "operation", entity: "item", name: "closeItem" });
    expect(block[1]).not.toContain('"e.item"');
    // 直す前の挙動：渡さなければ今の 4 つの塊のままで、診断は届かない
    expect(without).not.toContain(`<data name="${FIELD_REPAIR_DIAGNOSTIC_DATA_NAME}">`);
  });
});

describe("通信（旗 v12.ids。Issue #667）：追加の場所も往復ごとの動的な schema の enum に入って text.format に載る", () => {
  it("検査 0 の宣言で validate の不一致を追加の場所に写した往復は、送った enum に追加の場所があり、封筒の anyOf に置き換わらない", async () => {
    const source = fixtureYaml({ validation: false });
    const suite: TestSuite = { tests: [{ ...test("v-amount", "R1", "field", "f.item.amount", "validate") }, ...SUITE.tests] };
    const observes = new Map<string, TestObserves>([["v-amount", "validation"]]);
    const failures = locateFailures({
      source,
      table: fixtureTable(),
      suite,
      staticCheckPassed: true,
      diagnostics: [],
      correspondenceMisses: [],
      rejections: [],
      unmarked: [],
      mismatches: [{ testId: "v-amount" }, { testId: "r3-when" }],
      unresolved: [],
      ids: { observes, requiredValidations: requiredValidationsOf(fixtureTable(), suite, observes) },
    });
    expect(failures.locations).toEqual(["validation:item.amount", "action:item.closeItem"]);
    const answer = {
      replacements: [{ location: "validation:item.amount", element: "- name: amount\n  entity: item\n  expression: amount > 0" }],
      disputes: [],
    };
    const { fetch, bodies } = recordingFetch([answer]);
    const client = createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" });
    const outcome = await runFieldRepair({ source: SOURCE, list: LIST, suite, declaration: source, failures, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(client) });
    expect(outcome.ok).toBe(true);
    const format = formatOf(bodies[0]);
    expect(format.name).toBe(FIELD_REPAIR_SCHEMA_NAME);
    expect(format.schema).toEqual(fieldRepairSchemaOf(failures.locations));
    expect(JSON.stringify(format.schema)).toContain("validation:item.amount");
    expect(JSON.stringify(format.schema)).not.toContain("anyOf");
  });
});

// ── 囲みの付いた本文（Ollama の adapter。Issue #777）────────────────────
//
// この段の要求は往復ごとの動的な schema（場所の enum）をそのまま `text.format` に載せる（封筒の外）。
// **Ollama の adapter** に偽物の fetch を当て、囲み 1 組の本文を返す。囲みを読む設定が on なので中身が
// 読めて段が進む。同じ本文を OpenAI の adapter（設定は off）に返すと、今のとおり読めずに止まる。

/** 囲み 1 組で包んだ応答（Ollama の Responses API が返す形。Issue #777） */
function fencedReply(output: unknown): Response {
  const text = `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``;
  const body = {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: USAGE_WIRE,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** 送った body を記録し、囲み 1 組の応答を渡した順に返す偽物の fetch */
function recordingFencedFetch(outputs: readonly unknown[]): { readonly fetch: FetchLike; readonly bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return fencedReply(outputs[bodies.length - 1]);
  };
  return { fetch: fetchImpl, bodies };
}

/**
 * 囲みの**開始行**が不正な 3 反例（Issue #777 レビュー R1。閉じの行は正規の 3 個）。開始が
 * バッククォートちょうど 3 個＋印 1 語（印にバッククォートを含まない）でないので、囲みとみなさず
 * 今のとおり読めない（malformed になる）。
 */
const BAD_STARTS: readonly { readonly name: string; readonly start: string }[] = [
  { name: "開始行がバッククォート 4 個だけ", start: "````" },
  { name: "開始行がバッククォート 6 個だけ", start: "``````" },
  { name: "言語の印の末尾にバッククォート 3 個（```json```）", start: "```json```" },
];

/** 指定の開始行で包んだ応答（閉じは 3 個。Issue #777 レビュー R1） */
function badStartReply(start: string, output: unknown): Response {
  const text = `${start}\n${JSON.stringify(output)}\n\`\`\``;
  const body = {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: USAGE_WIRE,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("囲み 1 つの本文（Ollama の adapter。Issue #777）：動的な schema の要求でも中身を読む", () => {
  const failures = locateFailures({
    source: FIXTURE_YAML,
    table: fixtureTable(),
    suite: SUITE,
    staticCheckPassed: true,
    diagnostics: [],
    correspondenceMisses: [],
    rejections: [],
    unmarked: [],
    mismatches: [{ testId: "r3-when" }, { testId: "r4-rate" }],
    unresolved: [],
  });
  const ANSWER = { replacements: [{ location: "action:item.closeItem", element: closeItem }], disputes: [] };
  const run = (client: ReturnType<typeof createOllamaLlmClient> | ReturnType<typeof createOpenAiLlmClient>) =>
    runFieldRepair({ source: SOURCE, list: LIST, suite: SUITE, declaration: FIXTURE_YAML, failures, documents: FIXTURE_DOCUMENTS, gateway: makeGateway(client) });

  it("Ollama の client：囲み 1 つの本文を読み、欄だけの直しが進む（動的な schema は今のまま送る）", async () => {
    const { fetch, bodies } = recordingFencedFetch([ANSWER]);
    const outcome = await run(createOllamaLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" }));
    expect(outcome.ok).toBe(true);
    const format = formatOf(bodies[0]);
    expect(format.name).toBe(FIELD_REPAIR_SCHEMA_NAME);
    expect(format.schema).toEqual(fieldRepairSchemaOf(failures.locations));
    expect(JSON.stringify(format.schema)).not.toContain("anyOf");
  });

  it("OpenAI の client（囲みを読まない設定）は同じ本文で読めず、今のとおり止まる", async () => {
    const { fetch } = recordingFencedFetch([ANSWER]);
    const outcome = await run(createOpenAiLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("malformed");
  });

  it.each(BAD_STARTS)("開始行の余分なバッククォート（$name）は今のとおり読めず、欄だけの直しが止まる（R1）", async ({ start }) => {
    const fetch: FetchLike = async () => badStartReply(start, ANSWER);
    const outcome = await run(createOllamaLlmClient({ apiKey: "test-key", fetch, envelope: "v1.1a" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("malformed");
  });
});
