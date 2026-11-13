// F-2 generation-only contract. Native schemas, checks, retries and prompt rules remain authoritative.
import { validateSchema } from "../schema-check.js";
import type { VocabularyBundle } from "./ids.js";

type Node = { type?: string | string[]; properties?: Record<string, Node>; items?: Node; enum?: unknown[];
  anyOf?: Node[]; minItems?: number; maxItems?: number; [key: string]: unknown };
export const C1_CONDITIONAL_FIELDS_POLICY = "c1-discriminated-null-union/v1";
const nil = (): Node => ({ type: "null" });
function nonNull(node: Node, type: string): Node | undefined {
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (!types.includes(type)) return undefined;
  const result = { ...structuredClone(node), type };
  if (result.enum !== undefined) {
    result.enum = result.enum.filter((v) => v !== null);
    if (result.enum.length === 0) return undefined;
  }
  return result;
}
function union(array: Node, branches: readonly Node[]): void {
  if (branches.length === 0) array.maxItems = 0; // no dummy values and no empty anyOf.
  else array.items = { anyOf: [...branches] };
}
function singleton(node: Node, value: unknown): Node { return { ...node, enum: [value] }; }
/** Refine a base or F-1 schema, never mutate it or infer options/meaning from names. */
export function c1ConditionalSchema(base: Record<string, unknown>, bundle: VocabularyBundle): Record<string, unknown> {
  const schema = structuredClone(base) as Node, arrays = schema.properties!;
  if (bundle === "fields") {
    const array = arrays["fields"]!, item = array.items!, fields = item.properties!;
    const branches: Node[] = [];
    for (const type of fields["fieldType"]!.enum!) {
      const branch = structuredClone(item), p = branch.properties!;
      p["fieldType"] = singleton(p["fieldType"]!, type);
      p["options"] = type === "enum" ? { ...nonNull(p["options"]!, "array")!, minItems: 1 } : nil();
      if (type === "ref") {
        const ref = nonNull(p["refEntity"]!, "string");
        if (ref === undefined) continue;
        p["refEntity"] = ref;
      } else if (type !== "list") p["refEntity"] = nil();
      branches.push(branch);
    }
    union(array, branches);
  } else if (bundle === "behaviors") {
    const screens = arrays["screens"]!, screen = screens.items!, screenBranches: Node[] = [];
    for (const view of screen.properties!["view"]!.enum!) {
      const branch = structuredClone(screen), p = branch.properties!;
      p["view"] = singleton(p["view"]!, view);
      const entity = view === "dashboard" ? nil() : nonNull(p["entity"]!, "string");
      if (entity === undefined) continue;
      p["entity"] = entity; screenBranches.push(branch);
    }
    union(screens, screenBranches);
    const computations = arrays["computations"]!, item = computations.items!, p0 = item.properties!, branches: Node[] = [];
    for (const scope of p0["scope"]!.enum!) for (const form of p0["form"]!.enum!) {
      // Existing native type contract; no silent change to the model's selected discriminants.
      if ((scope === "groups" && form !== "aggregate") || (form === "settle" && scope !== "row")) continue;
      const branch = structuredClone(item), p = branch.properties!;
      p["scope"] = singleton(p["scope"]!, scope); p["form"] = singleton(p["form"]!, form);
      const entity = scope === "row" ? nonNull(p["entity"]!, "string") : nil();
      const group = scope === "groups" ? nonNull(p["groupBy"]!, "object") : nil();
      if (entity === undefined || group === undefined) continue;
      p["entity"] = entity; p["groupBy"] = group;
      if (p["aggregate"] !== undefined) {
        const aggregate = form === "aggregate" ? nonNull(p["aggregate"], "object") : nil();
        if (aggregate === undefined) continue;
        p["aggregate"] = aggregate;
      }
      branches.push(branch);
    }
    union(computations, branches);
  }
  return schema;
}
/** Offline generation-schema checker: add array bounds to the existing anyOf/type checker.
 * This is not installed in the receiver or used to change native acceptance/retry behavior. */
export function validateC1GenerationSchema(schema: unknown, value: unknown): string | undefined {
  const basic = validateSchema(schema, value);
  if (basic !== undefined) return basic;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return undefined;
  const s = schema as Node;
  if (s.anyOf !== undefined && !s.anyOf.some((branch) => validateC1GenerationSchema(branch, value) === undefined)) return "anyOf: no conditional branch";
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) return "minItems";
    if (s.maxItems !== undefined && value.length > s.maxItems) return "maxItems";
    if (s.items !== undefined) for (const item of value) {
      const error = validateC1GenerationSchema(s.items, item); if (error !== undefined) return error;
    }
  } else if (typeof value === "object" && value !== null && s.properties !== undefined) {
    for (const [key, child] of Object.entries(s.properties)) {
      const error = validateC1GenerationSchema(child, (value as Record<string, unknown>)[key]); if (error !== undefined) return error;
    }
  }
  return undefined;
}

export type ConditionalFieldClass = "options" | "refEntity" | "entity" | "aggregate" | "groupBy";
export interface ConditionalFieldProblem { readonly field: string; readonly category: ConditionalFieldClass }
/** Observe raw candidates before reference assembly; do not repair, reject or feed diagnostics back. */
export function conditionalFieldProblems(bundle: VocabularyBundle, value: unknown): readonly ConditionalFieldProblem[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const output = value as Record<string, unknown>, problems: ConditionalFieldProblem[] = [];
  const rows = (key: string): Record<string, unknown>[] => Array.isArray(output[key]) ? output[key].filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)) : [];
  const note = (bad: boolean, field: string, category: ConditionalFieldClass) => { if (bad) problems.push({ field, category }); };
  if (bundle === "fields") rows("fields").forEach((row, i) => {
    const type = row["fieldType"];
    if (!["enum", "string", "number", "date", "list", "ref"].includes(String(type))) return;
    note(type === "enum" ? !Array.isArray(row["options"]) || row["options"].length === 0 : row["options"] !== null, `fields[${i}].options`, "options");
    note(type === "ref" ? typeof row["refEntity"] !== "string" : type !== "list" && row["refEntity"] !== null, `fields[${i}].refEntity`, "refEntity");
  });
  if (bundle === "behaviors") {
    rows("screens").forEach((row, i) => note(row["view"] === "dashboard" ? row["entity"] !== null : typeof row["entity"] !== "string", `screens[${i}].entity`, "entity"));
    rows("computations").forEach((row, i) => {
      if (!["row", "app", "groups"].includes(String(row["scope"])) || !["expression", "aggregate", "settle"].includes(String(row["form"]))) return;
      note(row["scope"] === "row" ? typeof row["entity"] !== "string" : row["entity"] !== null, `computations[${i}].entity`, "entity");
      note(row["scope"] === "groups" ? row["groupBy"] === null || row["groupBy"] === undefined : row["groupBy"] !== null, `computations[${i}].groupBy`, "groupBy");
      if ("aggregate" in row) note(row["form"] === "aggregate" ? row["aggregate"] === null : row["aggregate"] !== null, `computations[${i}].aggregate`, "aggregate");
    });
  }
  return problems;
}
