import { describe, expect, it } from "vitest";
import { STRUCTURAL_ASSERTIONS } from "../fixed-test.js";
import { validateSchema } from "../schema-check.js";
import { fixtureList, fixtureTable, strictDefects, withCodeIds, FIXTURE_DOCUMENTS } from "../v11a/__tests__/fixtures.js";
import { c2MappingSchema } from "./c2-mapping-contract.js";
import { PROPERTY_LEDGER_VIEW } from "./ledger.js";
import { mappingSchemaOf } from "./stages/mapping.js";

type Obj = Record<string, unknown>;
const list = fixtureList(), table = withCodeIds(fixtureTable());
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
});
