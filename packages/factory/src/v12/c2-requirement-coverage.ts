// A lossless wire codec for complete requirement keys. It never chooses ownership or repairs values.
type Node = { properties?: Record<string, Node>; items?: Node; anyOf?: Node[]; maxItems?: number; [key: string]: unknown };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const C2_REQUIREMENT_COVERAGE_POLICY = "c2-required-key-singleton-id/v1";
function validIds(ids: readonly string[]): boolean { return new Set(ids).size === ids.length && ids.every((id) => typeof id === "string" && id.trim() !== ""); }
function fixedId(item: Node, id: string): Node {
  const node = structuredClone(item);
  if (node.anyOf !== undefined) node.anyOf = node.anyOf.map((branch) => fixedId(branch, id));
  else node.properties!["requirementId"] = { type: "string", enum: [id] };
  return node;
}
export function c2CoverageSchema(base: Record<string, unknown>, ids: readonly string[]): Record<string, unknown> {
  if (!validIds(ids)) throw new Error("c2-coverage:invalid-input-ids");
  const schema = structuredClone(base) as Node, array = schema.properties!["requirements"]!;
  if (array.maxItems === 0 && ids.length > 0) throw new Error("c2-coverage:uninhabitable-input");
  schema.properties!["requirements"] = { type: "object", additionalProperties: false, required: [...ids],
    properties: Object.fromEntries(ids.map((id) => [id, fixedId(array.items!, id)])) };
  return schema;
}
/** Check every own key and explicit ID before restoring native order. Missing/wrong values are never filled. */
export function decodeC2Coverage(value: unknown, ids: readonly string[]): { readonly ok: true; readonly output: Record<string, unknown> } | { readonly ok: false; readonly code: string } {
  if (!validIds(ids) || !object(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "requirements") || !object(value["requirements"])) return { ok: false, code: "c2-coverage:shape" };
  const entries = value["requirements"];
  if (Object.keys(entries).length !== ids.length || ids.some((id) => !Object.hasOwn(entries, id))) return { ok: false, code: "c2-coverage:keys" };
  if (ids.some((id) => !object(entries[id]) || !Object.hasOwn(entries[id], "requirementId") || entries[id]["requirementId"] !== id)) return { ok: false, code: "c2-coverage:id" };
  return { ok: true, output: { requirements: ids.map((id) => structuredClone(entries[id])) } };
}
