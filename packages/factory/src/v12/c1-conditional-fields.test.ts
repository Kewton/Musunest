import { describe, expect, it } from "vitest";
import { VIEW_TYPES } from "@musunest/appspec-schema";
import { c1ConditionalSchema, conditionalFieldProblems, validateC1GenerationSchema } from "./c1-conditional-fields.js";
import { c1ReferenceSchema } from "./c1-reference-enum.js";
import { vocabularySchemaOf } from "./stages/vocabulary.js";
import { validateSchema } from "../schema-check.js";
import { strictDefects, fixtureTable, withCodeIds } from "../v11a/__tests__/fixtures.js";
import { PROPERTY_LEDGER_VIEW } from "./ledger.js";
import type { VocabularyBundle } from "./ids.js";
const table = withCodeIds(fixtureTable());
const before = (bundle: VocabularyBundle) => table.rows.filter((r) => bundle === "fields" ? r.kind === "entity" : bundle === "behaviors" ? ["entity", "field"].includes(r.kind) : false);
const entity = before("fields")[0]!.id, field = before("behaviors").find((r) => r.kind === "field")!.id;
const aggregate = { kind: PROPERTY_LEDGER_VIEW.aggregateKinds[0]!, entity };
const fieldRow = (extra: Record<string, unknown> = {}) => ({ entity, name: "sample", role: "記録する値", fieldType: "string", options: null, refEntity: null, ...extra });
const compRow = (scope = "row", form = "expression") => ({ entity: scope === "row" ? entity : null, name: "computedSample", role: "計算した値",
  valueType: scope === "groups" ? "groups" : "number", scope, form, aggregate: form === "aggregate" ? aggregate : null,
  groupBy: scope === "groups" ? { kind: "enum", field } : null });
const wrap = (c: unknown) => ({ computations: [c], operations: [], screens: [] });
function schema(bundle: VocabularyBundle, f1 = true, rows = before(bundle), ledger = true) {
  const base = vocabularySchemaOf(bundle, ledger ? PROPERTY_LEDGER_VIEW : undefined);
  const refined = c1ReferenceSchema(base, bundle, rows);
  if (f1 && !refined.ok) throw new Error("fixture prior rows");
  return c1ConditionalSchema(f1 && refined.ok ? refined.schema : base, bundle);
}
describe("F-2 generation union, native gates unchanged", () => {
  it.each([false, true])("strict closed unions compose independently with F-1=%s without mutating input", (f1) => {
    for (const bundle of ["entities", "fields", "behaviors"] as const) {
      const base = vocabularySchemaOf(bundle, PROPERTY_LEDGER_VIEW), bytes = JSON.stringify(base);
      const generated = schema(bundle, f1);
      expect(strictDefects(generated)).toEqual([]); expect(JSON.stringify(base)).toBe(bytes);
      expect(JSON.stringify(generated)).not.toMatch(/"(if|then|else|oneOf)":/);
      expect(generated).toHaveProperty("type", "object");
    }
  });
  it.each([
    ["enum", ["first"], null, true], ["enum", [], null, false], ["enum", null, null, false],
    ["string", [], null, false], ["number", ["first"], null, false], ["date", null, null, true],
    ["ref", null, entity, true], ["ref", null, null, false], ["list", null, null, true], ["list", null, entity, true],
    ["string", null, entity, false], ["ref", null, "E999", false], ["ref", null, field, false],
  ])("field %s / options=%j / ref=%j accepts=%s", (fieldType, options, refEntity, valid) => {
    const value = { fields: [fieldRow({ fieldType, options, refEntity })] };
    expect(validateC1GenerationSchema(schema("fields"), value) === undefined).toBe(valid);
  });
  it("minItems is checked separately from the legacy validator", () => {
    const value = { fields: [fieldRow({ fieldType: "enum", options: [] })] };
    expect(validateSchema(schema("fields"), value)).toBeUndefined(); // legacy helper does not implement minItems.
    expect(validateC1GenerationSchema(schema("fields"), value)).toBeDefined();
  });
  it("F-1 off leaves reference IDs free", () => {
    const value = { fields: [fieldRow({ fieldType: "ref", refEntity: "E999" })] };
    expect(validateC1GenerationSchema(schema("fields", false), value)).toBeUndefined();
  });
  it.each(VIEW_TYPES)("view %s fixes only the appropriate entity nullability", (view) => {
    const row = { entity: view === "dashboard" ? null : entity, name: "sampleView", role: "値を見る", view };
    const s = schema("behaviors");
    expect(validateC1GenerationSchema(s, { computations: [], operations: [], screens: [row] })).toBeUndefined();
    expect(validateC1GenerationSchema(s, { computations: [], operations: [], screens: [{ ...row, entity: row.entity === null ? entity : null }] })).toBeDefined();
  });
  it.each([["row", "expression"], ["row", "aggregate"], ["row", "settle"], ["app", "expression"], ["app", "aggregate"], ["groups", "aggregate"]])(
    "scope=%s form=%s constrains entity/aggregate/groupBy without synthesizing values", (scope, form) => {
      const row = compRow(scope, form), s = schema("behaviors");
      expect(validateC1GenerationSchema(s, wrap(row))).toBeUndefined();
      for (const key of ["entity", "aggregate", "groupBy"] as const) {
        const changed = { ...row, [key]: row[key] === null ? key === "entity" ? entity : key === "aggregate" ? aggregate : { kind: "enum", field } : null };
        expect(validateC1GenerationSchema(s, wrap(changed)), key).toBeDefined();
      }
    });
  it("empty candidates have no dummy/empty enum and permit legitimate empty arrays", () => {
    const s = schema("behaviors", true, []);
    expect(validateC1GenerationSchema(s, { computations: [], operations: [], screens: [] })).toBeUndefined();
    expect(validateC1GenerationSchema(s, { computations: [], operations: [], screens: [{ entity: null, name: "allRecords", role: "一覧", view: "dashboard" }] })).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('"enum":[]'); expect(JSON.stringify(s)).not.toContain('"anyOf":[]');
    expect(validateC1GenerationSchema(schema("fields", true, []), { fields: [fieldRow()] })).toBeDefined();
  });
  it("ledger off does not introduce aggregate, and invalid type is never repaired", () => {
    expect(JSON.stringify(schema("behaviors", false, before("behaviors"), false))).not.toContain('"aggregate":{');
    const row = compRow("row", "settle");
    expect(validateC1GenerationSchema(schema("behaviors"), { computations: [{ ...row, scope: "app" }], operations: [], screens: [] })).toBeDefined();
    expect(validateC1GenerationSchema(schema("fields"), { fields: [fieldRow({ fieldType: "invented" })] })).toBeDefined();
  });
  it("observer reports conditional violations without repairing the candidate", () => {
    const row = { ...compRow("groups", "aggregate"), groupBy: null };
    expect(conditionalFieldProblems("behaviors", { computations: [row], operations: [], screens: [] }))
      .toEqual([{ field: "computations[0].groupBy", category: "groupBy" }]);
    expect(validateC1GenerationSchema(schema("behaviors"), { computations: [row], operations: [], screens: [] })).toBeDefined();
  });
});
