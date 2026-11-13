// F-1: generation-only, kind-specific references; native C1 remains authoritative.
import type { NameTableRow } from "../v11a/names.js";
import { BUNDLE_REFERABLE_KINDS, idKindOf, type VocabularyBundle } from "./ids.js";

type Node = { properties?: Record<string, Node>; items?: Node; enum?: unknown[]; maxItems?: number; [key: string]: unknown };
export const C1_REFERENCE_ENUM_POLICY = "c1-kind-reference-enum/v1";
export const INVALID_REFERENCE_ROWS = "前段の採番済み ID・種類・一意性が不正である";

/** No names, roles, diagnostics, field types or subject-specific choices enter this schema. */
export function c1ReferenceSchema(base: Record<string, unknown>, bundle: VocabularyBundle,
  rows: readonly NameTableRow[]): { readonly ok: true; readonly schema: Record<string, unknown> } | { readonly ok: false } {
  const seen = new Set<string>();
  for (const row of rows) {
    if (idKindOf(row.id) !== row.kind || !BUNDLE_REFERABLE_KINDS[bundle].includes(row.kind) || seen.has(row.id)) return { ok: false };
    seen.add(row.id);
  }
  const entities = rows.filter((r) => r.kind === "entity").map((r) => r.id);
  const fields = rows.filter((r) => r.kind === "field").map((r) => r.id);
  const schema = structuredClone(base) as Node;
  const nullable = (node: Node, ids: readonly string[]): Node => ({ ...node, enum: [...ids, null] });
  const mandatory = (node: Node, ids: readonly string[]): Node => ({ ...node, enum: [...ids] });
  if (bundle === "fields") {
    const array = schema.properties!["fields"]!;
    const props = array.items!.properties!;
    // Empty mandatory target: only the legitimate empty bundle is generatable.
    if (entities.length === 0) array.maxItems = 0;
    else props["entity"] = mandatory(props["entity"]!, entities);
    props["refEntity"] = nullable(props["refEntity"]!, entities);
  } else if (bundle === "behaviors") {
    const props = schema.properties!;
    const comp = props["computations"]!.items!.properties!;
    comp["entity"] = nullable(comp["entity"]!, entities);
    if (comp["aggregate"] !== undefined) {
      if (entities.length === 0) comp["aggregate"] = { type: "null" };
      else comp["aggregate"].properties!["entity"] = mandatory(comp["aggregate"].properties!["entity"]!, entities);
    }
    if (fields.length === 0) comp["groupBy"] = { type: "null" };
    else comp["groupBy"]!.properties!["field"] = mandatory(comp["groupBy"]!.properties!["field"]!, fields);
    const ops = props["operations"]!;
    if (entities.length === 0) ops.maxItems = 0;
    else ops.items!.properties!["entity"] = mandatory(ops.items!.properties!["entity"]!, entities);
    const screen = props["screens"]!.items!.properties!;
    screen["entity"] = nullable(screen["entity"]!, entities);
  }
  return { ok: true, schema };
}
