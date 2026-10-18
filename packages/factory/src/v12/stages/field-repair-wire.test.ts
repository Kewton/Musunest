// 欄だけの直しの通信（偽物の fetch で adapter を通す。`envelope` は v1.1a。Issue #553）。
//
// この段の schema の名前は共通の封筒（v1・v1.1α）のどちらにも登録しないので、adapter は往復ごとに組んだ動的な schema
// （場所の enum つき）をそのまま `text.format` に載せる（判定の口と同じ道）。共通の封筒・その一覧・adapter のコードは変えない。
// **そのため、この段の要求は前置き（出力の schema）が他の段と別になり、段をまたぐキャッシュは当たらない**（往復ごとに場所の
// enum が違えば、この段どうしでも当たらない）。実 API・鍵は使わない。
import { describe, expect, it } from "vitest";
import type { FixedTest, TestSuite } from "../../fixed-test.js";
import type { LlmStructuredRequest } from "../../llm.js";
import { createOpenAiLlmClient, type FetchLike } from "../../openai.js";
import { ENVELOPE_SCHEMA_NAME_V11A, ENVELOPE_SCHEMA_V11A, envelopeStageFor } from "../../schema-envelope.js";
import { makeGateway } from "../../stages/__tests__/prompt.js";
import { FIXTURE_DOCUMENTS, FIXTURE_YAML, fixtureList, fixtureTable } from "../../v11a/__tests__/fixtures.js";
import { DECLARATION_V11A_SCHEMA, WRITE_V11A_SCHEMA_NAME } from "../../v11a/stages/write.js";
import { locateFailures } from "../locate.js";
import { FIELD_REPAIR_SCHEMA_NAME, fieldRepairSchemaOf, runFieldRepair } from "./field-repair.js";

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
