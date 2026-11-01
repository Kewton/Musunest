import { describe, expect, it } from "vitest";
import { STRUCTURAL_ASSERTIONS } from "../fixed-test.js";
import { validateSchema } from "../schema-check.js";
import { createOpenRouterLlmClient } from "../openrouter.js";
import { parseCliArguments } from "../cli.js";
import { makeGateway } from "../stages/__tests__/prompt.js";
import { createCheckedRecordingClient, fixtureList, fixtureTable, idsResponsesOf, planOf, recordedStructured,
  strictDefects, withCodeIds, FIXTURE_DOCUMENTS, requestListedIds } from "../v11a/__tests__/fixtures.js";
import { c2MappingSchema } from "./c2-mapping-contract.js";
import { PROPERTY_LEDGER_VIEW } from "./ledger.js";
import { mappingSchemaOf, runMapping, type MappingInput, type MappingPrevious } from "./stages/mapping.js";
import type { LlmStructuredRequest } from "../llm.js";

type Obj = Record<string, unknown>;
const list = fixtureList(), table = withCodeIds(fixtureTable()), plan = planOf(list);
const good = idsResponsesOf(list, table, PROPERTY_LEDGER_VIEW).mapping;
const entries = () => structuredClone(good["requirements"] as Obj[]);
const id = list.requirements[0]!.id, entity = table.rows.find((r) => r.kind === "entity")!.id;
const enumField = table.rows.find((r) => r.kind === "field" && r.type === "enum")!;
const simple = (kind = "fixed-test", extra: Obj = {}): Obj => ({ requirementId: id,
  roles: [{ id: entity, basis: "stated", reason: null }], nature: "ruled",
  verification: { kind, value: null, reason: null, checks: null, constraintIds: [], ...extra } });
const fields = (extra: Obj = {}) => Object.fromEntries(STRUCTURAL_ASSERTIONS.map((key) => [key, extra[key] ?? null]));
const schema = (ids = [id], rows = table.rows, documents = FIXTURE_DOCUMENTS, ledger = PROPERTY_LEDGER_VIEW) =>
  c2MappingSchema(mappingSchemaOf(ledger), { requirementIds: ids, rows, documents, ledger });

/** Offline test checker, never installed in the receiver. Includes the schema bounds/string keywords. */
function generationError(schemaValue: unknown, value: unknown): string | undefined {
  const basic = validateSchema(schemaValue, value);
  if (basic !== undefined) return basic;
  const s = schemaValue as Obj;
  if (Array.isArray(s["anyOf"]) && !s["anyOf"].some((branch) => generationError(branch, value) === undefined)) return "anyOf";
  if (typeof value === "string" && typeof s["pattern"] === "string" && !new RegExp(s["pattern"]).test(value)) return "pattern";
  if (Array.isArray(value)) {
    if (typeof s["minItems"] === "number" && value.length < s["minItems"]) return "minItems";
    if (typeof s["maxItems"] === "number" && value.length > s["maxItems"]) return "maxItems";
    if (s["items"] !== undefined) for (const item of value) { const error = generationError(s["items"], item); if (error) return error; }
  } else if (value !== null && typeof value === "object" && s["properties"] !== undefined) {
    for (const [key, child] of Object.entries(s["properties"] as Obj)) {
      const error = generationError(child, (value as Obj)[key]); if (error) return error;
    }
  }
  return undefined;
}
const accepts = (entry: Obj, s = schema()) => generationError(s, { requirements: [entry] }) === undefined;
const property = (entry: Obj, change: Obj): Obj => ({ ...entry, verification: { ...(entry["verification"] as Obj), ...change } });
async function run(outputs: unknown[], flag?: boolean, extra: Partial<MappingInput> = {}) {
  const recording = createCheckedRecordingClient(outputs.map(recordedStructured), { bundledC2: true });
  const outcome = await runMapping({ plan, list, rows: table.rows, documents: FIXTURE_DOCUMENTS,
    ledger: PROPERTY_LEDGER_VIEW, gateway: makeGateway(recording.client),
    ...(flag === undefined ? {} : { c2MappingContract: flag }), ...extra });
  return { outcome, recording };
}
function generatedRequirementIds(request: LlmStructuredRequest): string[] {
  const s = request.generationSchema as { properties: { requirements: { items: { anyOf: { properties: { requirementId: { enum: string[] } } }[] } } } };
  return s.properties.requirements.items.anyOf[0]!.properties.requirementId.enum;
}

describe("C2 generation contract; native receiver and prompt unchanged", () => {
  it("is strict nested anyOf, pure and independent of subject text/names", () => {
    const base = mappingSchemaOf(PROPERTY_LEDGER_VIEW), bytes = JSON.stringify(base), s = schema();
    expect(JSON.stringify(base)).toBe(bytes); expect(strictDefects(s)).toEqual([]);
    expect(s["type"]).toBe("object"); expect(JSON.stringify(s)).not.toMatch(/"(if|then|else|oneOf)":/);
    const renamed = table.rows.map((r) => ({ ...r, name: "arbitrary", role: "unrelated text" }));
    expect(schema([id], renamed)).toEqual(s);
  });
  it("closes requirement and role ID sets, without changing the supplied values", () => {
    expect(accepts(simple())).toBe(true);
    expect(accepts({ ...simple(), requirementId: list.requirements[1]!.id })).toBe(false);
    expect(accepts({ ...simple(), requirementId: "unknown" })).toBe(false);
    expect(accepts({ ...simple(), roles: [{ id: "unknown", basis: "stated", reason: null }] })).toBe(false);
  });
  it.each([
    ["stated", null, true], ["stated", "reason", false], ["dependency", "reason", true],
    ["dependency", null, false], ["dependency", "", false], ["dependency", "  ", false],
  ])("basis=%s reason=%j accepts=%s", (basis, reason, valid) => {
    expect(accepts({ ...simple(), roles: [{ id: entity, basis, reason }] })).toBe(valid);
  });
  it("unused value/reason/checks/constraints are null or the existing empty array", () => {
    const base = simple();
    for (const wrong of [{ value: "x" }, { reason: "x" }, { checks: fields() }, { constraintIds: ["外部への通知"] }]) expect(accepts(property(base, wrong))).toBe(false);
    expect(accepts(base)).toBe(true);
  });
  it("default-value and enum-membership use only eligible rows and correct conditional fields", () => {
    const role = [{ id: enumField.id, basis: "stated", reason: null }];
    const def = { ...simple("default-value", { value: enumField.options![0] }), roles: role };
    expect(accepts(def)).toBe(true);
    for (const value of [null, "", "  "]) expect(accepts(property(def, { value }))).toBe(false);
    expect(accepts({ ...def, roles: [{ id: table.rows.find((r) => r.kind === "operation")!.id, basis: "stated", reason: null }] })).toBe(false);
    const membership = property(def, { kind: "enum-membership", value: null });
    expect(accepts(membership)).toBe(true); expect(accepts(property(membership, { value: "x" }))).toBe(false);
    expect(accepts({ ...membership, nature: "existence-only" })).toBe(false);
  });
  it("structural has at least one nonempty, kind-appropriate target array and a reason", () => {
    const field = table.rows.find((r) => r.kind === "field")!;
    const s = simple("structural", { reason: "why", checks: fields({ "field-type": [{ targetId: field.id }] }) });
    expect(accepts(s)).toBe(true);
    for (const wrong of [null, fields(), fields({ "field-type": [] }), fields({ "field-type": [{ targetId: entity }] }), fields({ "field-type": [{ targetId: "unknown" }] })]) expect(accepts(property(s, { checks: wrong }))).toBe(false);
    for (const reason of [null, "", " "]) expect(accepts(property(s, { reason }))).toBe(false);
    expect(accepts(property(s, { value: "x" }))).toBe(false);
  });
  it("view-shows pairs match native eligibility across entities and the null-entity dashboard", () => {
    for (const screen of table.rows.filter((r) => r.kind === "screen")) for (const source of table.rows) {
      const value = simple("structural", { reason: "why", checks: fields({ "view-shows": [{ targetId: screen.id, sourceId: source.id }] }) });
      expect(accepts(value), screen.id + "/" + source.id).toBe(["field", "computation"].includes(source.kind) && source.entity === screen.entity);
    }
  });
  it("unresolved IDs are existing constraints or registered unsupported observations; neither may be invented", () => {
    const s = simple("unresolved", { reason: "why", constraintIds: ["外部への通知"] });
    expect(accepts(s)).toBe(true);
    for (const constraintIds of [[], ["unknown"]]) expect(accepts(property(s, { constraintIds }))).toBe(false);
    const observation = PROPERTY_LEDGER_VIEW.unsupportedObservations[0]!;
    expect(accepts(property(s, { constraintIds: [observation.id] }))).toBe(true);
    expect(accepts(property(s, { checks: fields() }))).toBe(false);
  });
  it("empty candidates never invent dummy IDs or empty enum/anyOf; zero-row non-requirement remains possible", () => {
    const s = schema([id], [], []);
    expect(JSON.stringify(s)).not.toContain('"enum":[]'); expect(JSON.stringify(s)).not.toContain('"anyOf":[]');
    expect(accepts(simple("default-value", { value: "x" }), s)).toBe(false);
    expect(accepts(simple("structural", { reason: "why", checks: fields() }), s)).toBe(false);
    expect(accepts({ ...simple("non-requirement"), roles: [] }, s)).toBe(true);
    expect(accepts({ ...simple("non-requirement"), roles: [{ id: "dummy", basis: "stated", reason: null }] }, s)).toBe(false);
    const noRequirements = schema([], [], []);
    expect(generationError(noRequirements, { requirements: [] })).toBeUndefined();
    expect(accepts(simple(), noRequirements)).toBe(false);
    const noLedger = c2MappingSchema(mappingSchemaOf(), { requirementIds: [id], rows: [], documents: [] });
    expect(accepts(simple(), noLedger)).toBe(false); expect(JSON.stringify(noLedger)).not.toContain('"anyOf":[]');
  });
  it("off/omitted requests are byte-identical; on changes only generationSchema, not native schema/data/rules/caps", async () => {
    const off = await run([good], false), omitted = await run([good]), on = await run([good], true);
    expect(off.outcome).toEqual(on.outcome); expect(on.outcome.ok).toBe(true);
    expect(JSON.stringify(off.recording.structured)).toBe(JSON.stringify(omitted.recording.structured));
    const { generationSchema: _s, ...unchanged } = on.recording.structured[0]!;
    expect(JSON.stringify(unchanged)).toBe(JSON.stringify(off.recording.structured[0]));
  });
  it("initial bundles get exactly their own allowed IDs", async () => {
    const larger = { ...list, requirements: [...list.requirements, { ...list.requirements[0]!, id: "R6" }] };
    const more = { requirements: [...entries(), { ...entries()[0], requirementId: "R6" }] };
    const { recording } = await run([more], true, { list: larger });
    expect(recording.structured.length).toBeGreaterThanOrEqual(2);
    for (const req of recording.structured.slice(0, 2)) expect(generatedRequirementIds(req)).toEqual(requestListedIds(req));
    expect(generatedRequirementIds(recording.structured[0]!)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
    expect(generatedRequirementIds(recording.structured[1]!)).toEqual(["R6"]);
  });
  it("partial shape rewrite restricts to the failed IDs, retains native diagnostics and the single retry", async () => {
    const bad = entries(); bad[0] = property(bad[0]!, { value: "wrong" });
    const results = await Promise.all([false, true].map((flag) => run([{ requirements: bad }, { requirements: [entries()[0]] }], flag)));
    for (const result of results) {
      expect(result.outcome.ok).toBe(true); expect(result.recording.structured).toHaveLength(2);
    }
    const req = results[1]!.recording.structured[1]!;
    expect(generatedRequirementIds(req)).toEqual([id]);
    expect(req.input).toContain("既定値で確かめる要件でない確かめ方の value は null");
    results[1]!.recording.structured.forEach((request, i) => { const { generationSchema: _s, ...rest } = request; expect(JSON.stringify(rest)).toBe(JSON.stringify(results[0]!.recording.structured[i])); });
  });
  it("global rebuild uses all IDs; C3 rewrite uses only rejected IDs; no extra calls or data changes", async () => {
    const bad = entries(); bad[0] = { ...bad[0]!, requirementId: "unknown" };
    const rebuilt = await run([{ requirements: bad }, good], true);
    expect(rebuilt.outcome.ok).toBe(true); expect(rebuilt.recording.structured).toHaveLength(2);
    expect(generatedRequirementIds(rebuilt.recording.structured[1]!)).toEqual(list.requirements.map((r) => r.id));
    const previous: MappingPrevious = { response: good, rejections: [{ requirementId: id, verdict: "reject", kind: "unnecessary-ownership", quote: "synthetic" }], advice: [] };
    const c3 = await run([{ requirements: [entries()[0]] }], true, { previous });
    expect(c3.outcome.ok).toBe(true); expect(c3.recording.structured).toHaveLength(1);
    expect(generatedRequirementIds(c3.recording.structured[0]!)).toEqual([id]);
  });
  it("native duplicate/coverage/orphan gates remain stronger than the local generation schema", async () => {
    const duplicate = { requirements: [...entries(), entries()[0]] };
    expect(generationError(schema(list.requirements.map((r) => r.id)), duplicate)).toBeUndefined();
    const result = await run([duplicate, duplicate], true);
    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "unmet", attempts: 2 } });
    expect(result.recording.structured).toHaveLength(2);
    const missing = { requirements: entries().slice(1) };
    const other = await run([missing, missing], true);
    expect(other.outcome).toMatchObject({ ok: false, failure: { kind: "unmet", attempts: 2 } });
    const orphan = await run([good, good], true, { rows: [...table.rows, { ...table.rows.find((r) => r.kind === "field")!, id: "E1.F99" }] });
    expect(orphan.outcome).toMatchObject({ ok: false, failure: { kind: "unmet", attempts: 2 } });
  });
  it("OpenInference fake receives the refined envelope schema; HTTP400 does not fall back", async () => {
    const req = (await run([good], true)).recording.structured[0]!;
    const bodies: Obj[] = [];
    const client = createOpenRouterLlmClient({ apiKey: "fake", arm: "open-inference/fp4", envelope: "v1.2", fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as Obj; bodies.push(body);
      const format = (body["text"] as { format: { schema: unknown; strict: boolean } }).format;
      expect(format.strict).toBe(true); expect(generationError(format.schema, { result: { stage: "mapping", ...good } })).toBeUndefined();
      const wrong = entries(); wrong[0] = { ...wrong[0]!, requirementId: "outside" };
      expect(generationError(format.schema, { result: { stage: "mapping", requirements: wrong } })).toBeDefined();
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ result: { stage: "mapping", ...good } }) }] }] }));
    } });
    expect((await client.callStructured(req)).output).toEqual(good); expect(bodies).toHaveLength(1);
    let calls = 0;
    const refused = createOpenRouterLlmClient({ apiKey: "fake", arm: "open-inference/fp4", envelope: "v1.2", fetch: async () => {
      calls++; return new Response(JSON.stringify({ error: { code: "invalid_json_schema" } }), { status: 400 });
    } });
    expect((await makeGateway(refused).callStructured(req)).kind).toBe("invalidRequest"); expect(calls).toBe(1);
  });
  it("CLI validates independent on/off and rejects invalid/missing/duplicate/wrong pipeline", () => {
    const args = ["request", "--out", "out", "--plan-file", "plan", "--pipeline", "v1.2"];
    expect(parseCliArguments([...args, "--c2-mapping-contract", "off"])).toEqual(parseCliArguments(args));
    expect(parseCliArguments([...args, "--c2-mapping-contract", "on"])).toMatchObject({ c2MappingContract: true });
    for (const suffix of [["--c2-mapping-contract"], ["--c2-mapping-contract", "bad"], ["--c2-mapping-contract", "on", "--c2-mapping-contract", "off"]]) expect(parseCliArguments([...args, ...suffix])).toHaveProperty("error");
    expect(parseCliArguments(["request", "--out", "out", "--c2-mapping-contract", "on"])).toHaveProperty("error");
  });
});
