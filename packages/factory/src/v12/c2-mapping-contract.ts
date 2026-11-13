// Generation only: finite references and conditional fields; native C2/C3 remain authoritative.
import { STRUCTURAL_ASSERTIONS } from "../fixed-test.js";
import { constraintIdsIn, type Problem, type PromptDocument } from "../stages/prompt.js";
import { checkCheckTargets, type NameTableRow } from "../v11a/names.js";
import type { UpstreamLedgerView } from "./ledger.js";

type Node = { properties?: Record<string, Node>; items?: Node; enum?: unknown[]; anyOf?: Node[];
  minItems?: number; maxItems?: number; [key: string]: unknown };
export const C2_MAPPING_CONTRACT_POLICY = "c2-finite-reference+discriminated-null-union/v1";
const nil = (): Node => ({ type: "null" });
const text = (): Node => ({ type: "string", minLength: 1, pattern: "\\S" });
const finite = (ids: readonly string[]): Node => ({ type: "string", enum: [...new Set(ids)] });
const empty = (array: Node): Node => ({ ...array, maxItems: 0 });
function variants(array: Node, branches: readonly Node[]): void {
  if (branches.length === 0) array.maxItems = 0; // No dummy ID, empty enum or empty anyOf.
  else array.items = { anyOf: [...branches] };
}

function rolesOf(base: Node, ids: readonly string[]): Node {
  if (ids.length === 0) return empty(structuredClone(base));
  const array = structuredClone(base), item = array.items!, branches: Node[] = [];
  for (const basis of item.properties!["basis"]!.enum!) {
    const branch = structuredClone(item), p = branch.properties!;
    p["id"] = finite(ids);
    p["basis"] = { type: "string", enum: [basis] };
    p["reason"] = basis === "stated" ? nil() : text();
    branches.push(branch);
  }
  variants(array, branches);
  return array;
}

function checkArray(base: Node, check: (typeof STRUCTURAL_ASSERTIONS)[number], rows: readonly NameTableRow[]): Node | undefined {
  const array = { ...structuredClone(base), type: "array", minItems: 1 }, item = array.items!;
  const eligible = (targetId: string, sourceId: string | null): boolean => {
    const problems: Problem[] = [];
    checkCheckTargets(rows, [{ check, targetId, sourceId }], "", problems);
    return problems.length === 0;
  };
  if (check === "view-shows") {
    const branches: Node[] = [];
    for (const target of rows.filter((row) => row.kind === "screen")) {
      const sources = rows.filter((row) => eligible(target.id, row.id)).map((row) => row.id);
      if (sources.length === 0) continue;
      const branch = structuredClone(item);
      branch.properties!["targetId"] = finite([target.id]);
      branch.properties!["sourceId"] = finite(sources);
      branches.push(branch);
    }
    if (branches.length === 0) return undefined;
    variants(array, branches);
  } else {
    const targets = rows.filter((row) => eligible(row.id, null)).map((row) => row.id);
    if (targets.length === 0) return undefined;
    item.properties!["targetId"] = finite(targets);
  }
  return array;
}

/** At least one nonempty check field; each view/source pair uses native eligibility. */
function structuralChecks(base: Node, rows: readonly NameTableRow[]): Node | undefined {
  const object = { ...structuredClone(base), type: "object" }, available = new Map<string, Node>();
  for (const check of STRUCTURAL_ASSERTIONS) {
    const array = checkArray(object.properties![check]!, check, rows);
    if (array !== undefined) available.set(check, array);
    object.properties![check] = array === undefined ? nil() : { anyOf: [nil(), array] };
  }
  if (available.size === 0) return undefined;
  return { anyOf: [...available].map(([check, array]) => {
    const branch = structuredClone(object);
    branch.properties![check] = array;
    return branch;
  }) };
}

export interface MappingContractContext {
  readonly requirementIds: readonly string[];
  readonly rows: readonly NameTableRow[];
  readonly documents: readonly PromptDocument[];
  readonly ledger?: UpstreamLedgerView;
}

/** Refine only the schema. Do not normalize responses, choose ownership, or change native gates. */
export function c2MappingSchema(base: Record<string, unknown>, context: MappingContractContext): Record<string, unknown> {
  const schema = structuredClone(base) as Node, array = schema.properties!["requirements"]!, item = array.items!, p0 = item.properties!;
  if (context.requirementIds.length === 0) { array.maxItems = 0; return schema; }
  const verification = p0["verification"]!, v0 = verification.properties!;
  const constraintIds = [...new Set([...constraintIdsIn(context.documents), ...(context.ledger?.unsupportedObservations.map((entry) => entry.id) ?? [])])];
  const checks = structuralChecks(v0["checks"]!, context.rows), branches: Node[] = [];
  for (const kind of v0["kind"]!.enum! as string[]) {
    const t1 = context.ledger?.rowByVerificationKind.get(kind)?.t1;
    const branch = structuredClone(item), p = branch.properties!, v = p["verification"]!.properties!;
    p["requirementId"] = finite(context.requirementIds);
    v["kind"] = { type: "string", enum: [kind] };
    v["value"] = nil(); v["reason"] = nil(); v["checks"] = nil(); v["constraintIds"] = empty(v["constraintIds"]!);
    let roleIds = context.rows.map((row) => row.id);
    if (kind === "structural") {
      if (checks === undefined) continue;
      v["reason"] = text(); v["checks"] = checks;
    } else if (kind === "unresolved") {
      if (constraintIds.length === 0) continue;
      v["reason"] = text(); v["constraintIds"] = { ...v["constraintIds"], minItems: 1, items: finite(constraintIds) };
      delete v["constraintIds"]!.maxItems;
    } else if (t1 != null || kind === "default-value") {
      const want = t1?.ownership.row ?? (t1 == null ? { kind: "field", type: "enum" } : null);
      const count = t1?.ownership.count ?? 1;
      const targets = want === null ? [] : context.rows.filter((row) => row.kind === want.kind && row.type === want.type
        && (!(t1?.ownership.optionsNonEmpty || t1?.ownership.valueInOptions || kind === "default-value") || (row.options ?? []).length > 0));
      if (targets.length < count) continue;
      const ids = new Set(targets.flatMap((row) => [row.id, ...((t1?.ownership.entityAddedByCode ?? true) && row.entity !== null ? [row.entity] : [])]));
      roleIds = context.rows.filter((row) => ids.has(row.id)).map((row) => row.id);
      if (t1?.valueField != null || t1 == null) v["value"] = text();
      if (t1?.nature != null) p["nature"] = { type: "string", enum: [t1.nature] };
    } else if (kind !== "fixed-test") continue;
    if (kind === "fixed-test" && roleIds.length === 0) continue;
    p["roles"] = rolesOf(p["roles"]!, roleIds);
    if (kind === "fixed-test") p["roles"]!.minItems = 1;
    branches.push(branch);
  }
  variants(array, branches);
  return schema;
}
