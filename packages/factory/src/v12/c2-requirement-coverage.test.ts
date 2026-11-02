import { describe, expect, it } from "vitest";
import { c2CoverageSchema, decodeC2Coverage } from "./c2-requirement-coverage.js";
import { mappingSchemaOf, runMapping, type MappingInput } from "./stages/mapping.js";
import { c2MappingSchema } from "./c2-mapping-contract.js";
import { PROPERTY_LEDGER_VIEW } from "./ledger.js";
import { createOpenRouterLlmClient } from "../openrouter.js";
import { makeGateway } from "../stages/__tests__/prompt.js";
import { fixtureList, fixtureTable, idsResponsesOf, planOf, withCodeIds, strictDefects, FIXTURE_DOCUMENTS } from "../v11a/__tests__/fixtures.js";
import { validateSchema } from "../schema-check.js";
import { structuredInputParts } from "../call.js";
import { parseCliArguments } from "../cli.js";
import type { LlmStructuredRequest } from "../llm.js";

type Obj = Record<string, any>;
const list = fixtureList(), table = withCodeIds(fixtureTable()), plan = planOf(list), ids = list.requirements.map((r) => r.id);
const good = idsResponsesOf(list, table, PROPERTY_LEDGER_VIEW).mapping as { requirements: Obj[] };
const keyed = (entries: Obj[]) => ({ requirements: Object.fromEntries(entries.map((e) => [e['requirementId'], structuredClone(e)])) });
const base = mappingSchemaOf(PROPERTY_LEDGER_VIEW);
const schema = (allowed = ids) => c2CoverageSchema(c2MappingSchema(base, { requirementIds: allowed, rows: table.rows, documents: FIXTURE_DOCUMENTS, ledger: PROPERTY_LEDGER_VIEW }), allowed);
function allowedIn(s: Obj): string[] {
  const a = s['properties']['requirements'];
  return a.type === 'object' ? a.required : a.items.anyOf?.[0]?.properties.requirementId.enum ?? ids;
}
async function run(coverage?: boolean, options: { badReason?: boolean; recover?: boolean; orphan?: boolean; contract?: boolean; extra?: Partial<MappingInput>; entries?: Obj[] } = {}) {
  const bodies: Obj[] = [], entries = options.entries ?? good.requirements;
  const client = createOpenRouterLlmClient({ apiKey: 'fake', arm: 'open-inference/fp4', envelope: 'v1.2', fetch: async (_url, init) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    const s = body.text.format.schema.properties.result, allowed = allowedIn(s), isKeyed = s.properties.requirements.type === 'object';
    const selected = structuredClone(entries.filter((e) => allowed.includes(e['requirementId'])));
    if (options.badReason && (!options.recover || bodies.length === 1)) selected[0]!['roles'][0]['reason'] = 'contradiction remains';
    const output = isKeyed ? keyed(selected) : { requirements: selected };
    return new Response(JSON.stringify({ id: 'gen-fake-' + bodies.length, model: 'z-ai/glm-5.3-flash', status: 'completed',
      usage: { input_tokens: 20, output_tokens: 10, cost: .001 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ result: { stage: 'mapping', ...output } }) }] }] }));
  } });
  const gateway = makeGateway(client);
  const result = await runMapping({ plan, list, rows: options.orphan ? [...table.rows, { ...table.rows.find((r) => r.kind === 'field')!, id: 'E1.F99' }] : table.rows,
    documents: FIXTURE_DOCUMENTS, gateway, ledger: PROPERTY_LEDGER_VIEW, ...(options.contract === false ? {} : { c2MappingContract: true }),
    ...(coverage === undefined ? {} : { c2RequirementCoverage: coverage }), ...options.extra });
  return { result, bodies, gateway };
}

describe('C2 required key wire codec, native receiver unchanged', () => {
  it.each([false, true])('strict closed schemas compose with C2 mapping contract=%s without mutating the base', (contract) => {
    const b = contract ? c2MappingSchema(base, { requirementIds: ids, rows: table.rows, documents: FIXTURE_DOCUMENTS, ledger: PROPERTY_LEDGER_VIEW }) : base;
    const bytes = JSON.stringify(b), s = c2CoverageSchema(b, ids);
    expect(JSON.stringify(b)).toBe(bytes); expect(strictDefects(s)).toEqual([]);
    const node = (s as Obj).properties.requirements;
    expect(node.required).toEqual(ids); expect(Object.keys(node.properties)).toEqual(ids);
    expect(validateSchema(s, keyed(good.requirements))).toBeUndefined();
  });
  it('preserves every supplied field/value in native order, including arbitrary key and insertion order', () => {
    const reversed = keyed([...good.requirements].reverse()), bytes = JSON.stringify(reversed);
    expect(decodeC2Coverage(reversed, ids)).toEqual({ ok: true, output: good }); expect(JSON.stringify(reversed)).toBe(bytes);
    const special = ['__proto__', 'constructor', '2', '1', 'X:arbitrary/α'];
    const entries = special.map((requirementId) => ({ ...good.requirements[0], requirementId }));
    const s = c2CoverageSchema(base, special); expect(strictDefects(s)).toEqual([]);
    const decoded = decodeC2Coverage(keyed([...entries].reverse()), special);
    expect(decoded).toEqual({ ok: true, output: { requirements: entries } });
  });
  it.each(['missing', 'extra', 'mismatch', 'missing-id', 'array', 'inherited'])('rejects %s without filling or dropping a value', (kind) => {
    const output = keyed(good.requirements) as Obj;
    if (kind === 'missing') delete output.requirements[ids[0]!];
    if (kind === 'extra') output.requirements.EXTRA = good.requirements[0];
    if (kind === 'mismatch') output.requirements[ids[0]!].requirementId = ids[1];
    if (kind === 'missing-id') delete output.requirements[ids[0]!].requirementId;
    if (kind === 'array') output.requirements = good.requirements;
    if (kind === 'inherited') output.requirements = Object.create(output.requirements);
    expect(decodeC2Coverage(output, ids).ok).toBe(false);
  });
  it('empty input has no dummy or empty enum/anyOf; invalid or impossible input fails closed', () => {
    const s = c2CoverageSchema(base, []); expect(validateSchema(s, { requirements: {} })).toBeUndefined();
    expect(decodeC2Coverage({ requirements: {} }, [])).toEqual({ ok: true, output: { requirements: [] } });
    expect(JSON.stringify(s)).not.toContain('"enum":[]'); expect(JSON.stringify(s)).not.toContain('"anyOf":[]');
    expect(() => c2CoverageSchema(base, ['A', 'A'])).toThrow(); expect(() => c2CoverageSchema(base, [''])).toThrow();
    const noTargets = { ...base, properties: { requirements: { type: 'array', maxItems: 0, items: {} } } };
    expect(() => c2CoverageSchema(noTargets, ['A'])).toThrow('uninhabitable');
  });
  it('off/omitted HTTP bodies are byte-identical; on changes only schema and native result stays equal', async () => {
    const omitted = await run(), off = await run(false), on = await run(true);
    expect(JSON.stringify(off.bodies)).toBe(JSON.stringify(omitted.bodies)); expect(on.result).toEqual(off.result); expect(on.result.ok).toBe(true);
    const strip = (body: Obj) => { const copy = structuredClone(body); delete copy.text.format.schema; return copy; };
    expect(on.bodies.map(strip)).toEqual(off.bodies.map(strip)); expect(on.bodies[0]!.text.format.strict).toBe(true);
  });
  it('is independent of the existing mapping-contract flag', async () => {
    expect((await run(true, { contract: false })).result.ok).toBe(true);
  });
  it('native conditional contradictions survive the codec and still fail after exactly one shape retry', async () => {
    const off = await run(false, { badReason: true }), on = await run(true, { badReason: true });
    expect(on.result).toEqual(off.result); expect(on.result).toMatchObject({ ok: false, failure: { kind: 'unmet', attempts: 2 } });
    expect(on.bodies).toHaveLength(2); expect(on.gateway.counts.retries.shape).toBe(1);
  });
  it('partial shape rewrite has exactly the failed key and merges untouched entries through all native checks', async () => {
    const on = await run(true, { badReason: true, recover: true });
    expect(on.result.ok).toBe(true); expect(on.bodies).toHaveLength(2);
    expect(allowedIn(on.bodies[1]!.text.format.schema.properties.result)).toEqual([ids[0]]);
  });
  it('global rebuild cannot invent an owner for an orphan row', async () => {
    const on = await run(true, { orphan: true });
    expect(on.result).toMatchObject({ ok: false, failure: { kind: 'unmet', attempts: 2 } }); expect(on.bodies).toHaveLength(2);
    expect(on.bodies.map((b) => allowedIn(b.text.format.schema.properties.result))).toEqual([ids, ids]);
  });
  it('each initial bundle has its own exact key set', async () => {
    const larger = { ...list, requirements: [...list.requirements, { ...list.requirements[0]!, id: 'R6' }] };
    const on = await run(true, { entries: [...good.requirements, { ...good.requirements[0], requirementId: 'R6' }], extra: { list: larger } });
    expect(on.result.ok).toBe(true); expect(on.bodies).toHaveLength(2);
    expect(on.bodies.map((b) => allowedIn(b.text.format.schema.properties.result))).toEqual([ids, ['R6']]);
  });
  it('C3 rejected rewrite also uses just its exact allowed key', async () => {
    const on = await run(true, { extra: { previous: { response: good, rejections: [{ requirementId: ids[0]!, verdict: 'reject', kind: 'unnecessary-ownership', quote: 'synthetic' }], advice: [] } } });
    expect(on.result.ok).toBe(true); expect(on.bodies).toHaveLength(1); expect(allowedIn(on.bodies[0]!.text.format.schema.properties.result)).toEqual([ids[0]]);
  });
  it('adapter refuses missing/extra/mismatched keys, wrong stage and nonnative fields before accepting anything', async () => {
    const wireSchema = schema(), request: LlmStructuredRequest = { instructions: '', documents: [], input: '', schemaName: 'mapping', schema: base, generationSchema: wireSchema, requirementCoverage: ids, maxOutputTokens: 100 };
    const bads: Obj[] = [];
    const missing = keyed(good.requirements); delete missing.requirements[ids[0]!]; bads.push(missing);
    bads.push({ requirements: { ...keyed(good.requirements).requirements, EXTRA: good.requirements[0] } });
    const mismatch = keyed(good.requirements); mismatch.requirements[ids[0]!]!.requirementId = 'wrong'; bads.push(mismatch);
    bads.push({ stage: 'semantic-check', ...keyed(good.requirements) });
    bads.push({ requirements: [] });
    const extra = keyed(good.requirements); extra.requirements[ids[0]!]!['unknownField'] = true; bads.push(extra);
    for (const raw of bads) {
      const client = createOpenRouterLlmClient({ apiKey: 'fake', arm: 'open-inference/fp4', envelope: 'v1.2', fetch: async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ result: { stage: 'mapping', ...raw } }) }] }] })) });
      expect(await makeGateway(client).callStructured(request)).toMatchObject({ kind: 'failed', errorKind: 'malformed' });
    }
    let calls = 0;
    const refused = createOpenRouterLlmClient({ apiKey: 'fake', arm: 'open-inference/fp4', fetch: async () => { calls++; return new Response(JSON.stringify({ error: { code: 'invalid_json_schema' } }), { status: 400 }); } });
    expect((await makeGateway(refused).callStructured(request)).kind).toBe('invalidRequest'); expect(calls).toBe(1);
  });
  it('existing budget estimation counts the full expanded generation schema', () => {
    const generationSchema = schema(); const request: LlmStructuredRequest = { instructions: '', documents: [], input: '', schemaName: 'mapping', schema: base, generationSchema, requirementCoverage: ids, maxOutputTokens: 10 };
    expect(structuredInputParts(request).schema).toEqual({ name: 'mapping', schema: generationSchema });
  });
  it('CLI independently parses on/off and rejects missing, invalid, duplicate and unsupported pipeline', () => {
    const args = ['request', '--out', 'out', '--plan-file', 'plan', '--pipeline', 'v1.2'];
    expect(parseCliArguments([...args, '--c2-requirement-coverage', 'off'])).toEqual(parseCliArguments(args));
    expect(parseCliArguments([...args, '--c2-requirement-coverage', 'on'])).toMatchObject({ c2RequirementCoverage: true });
    for (const suffix of [['--c2-requirement-coverage'], ['--c2-requirement-coverage', 'bad'], ['--c2-requirement-coverage', 'on', '--c2-requirement-coverage', 'off']]) expect(parseCliArguments([...args, ...suffix])).toHaveProperty('error');
    expect(parseCliArguments(['request', '--out', 'out', '--c2-requirement-coverage', 'on'])).toHaveProperty('error');
  });
});
