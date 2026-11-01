import { describe, expect, it } from "vitest";
import { runWithDeferredBilling } from "./cli-provider-billing.js";
import { JobBudget } from "./budget.js";
import { CallGateway } from "./call.js";
import { createOpenRouterLlmClient } from "./openrouter.js";
import type { CliDeps } from "./cli.js";
import type { LlmStructuredRequest } from "./llm.js";

const model = "synthetic/model";
const request: LlmStructuredRequest = { instructions: "synthetic rules", documents: [], rules: [], input: "synthetic input",
  schemaName: "synthetic", schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, maxOutputTokens: 32 };
const wire = { id: "gen-synthetic", model, status: "completed", usage: { input_tokens: 100, output_tokens: 20, cost: .001 },
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"value":1}', annotations: [] }] }] };
function fixture(status = 200) {
  const writes = new Map<string, string>();
  const pendingStates: boolean[] = [];
  const logs: string[] = [];
  let nativeComplete = false;
  let gets = 0;
  const client = createOpenRouterLlmClient({ apiKey: "fake-secret-only", model, fetch: async (_url, init) => {
    if (init.method === "POST") return new Response(JSON.stringify(wire));
    expect(nativeComplete).toBe(true); gets++;
    expect(JSON.parse(writes.get("out/provider-billing.json") ?? writes.get("out/plan-provider-billing.json")!).comparison_valid).toBe(false);
    return new Response(JSON.stringify({ data: { id: wire.id, model, provider_name: "Morph" } }), { status });
  } });
  const budget = new JobBudget(1);
  const gateway = new CallGateway({ client, budget, rates: client.billingPin!.rates, now: () => 0, deadline: 100000, maxAttempts: 1 });
  const deps: CliDeps = { argv: [], env: {}, readFile: async () => "synthetic", loadDocuments: async () => [],
    makeDirectory: async () => {}, makeClient: () => client, log: (line) => { logs.push(line); },
    writeFile: async (path, text) => {
      writes.set(path, text);
      if (path.endsWith("provider-billing.json")) pendingStates.push(JSON.parse(text).comparison_valid);
    } };
  return { deps, writes, logs, pendingStates, budget, gateway, nativeDone: () => { nativeComplete = true; }, gets: () => gets };
}

describe("CLI confirmation after all native work (S-175x)", () => {
  it("persists pending, confirms once and emits only the final native summary", async () => {
    const f = fixture();
    const result = await runWithDeferredBilling(f.deps, async (deps) => {
      deps.makeClient({ apiKey: "fake-only", model, effort: "low" });
      await f.gateway.callStructured(request);
      await deps.writeFile("out/bundle-manifest.json", "immutable synthetic manifest");
      await deps.writeFile("out/provider-billing.json", JSON.stringify(f.budget.providerBilling));
      deps.log!(JSON.stringify({ schema_version: "commandagent.headless-summary/v1", verdict: "none", exit_code: 1,
        provider_cost_usd: .001, provider_billing: f.budget.providerBilling }));
      expect(f.logs).toHaveLength(0);
      f.nativeDone(); return 1;
    });
    expect(result).toBe(1);
    expect(f.gets()).toBe(1);
    expect(f.logs).toHaveLength(1);
    const final = JSON.parse(f.logs[0]!);
    expect(final).toMatchObject({ verdict: "none", exit_code: 1, provider_cost_usd: .001, provider_billing: { comparison_valid: true, actual_cost_usd: .001 } });
    expect(final.provider_billing).toEqual(JSON.parse(f.writes.get("out/provider-billing.json")!));
    expect(f.pendingStates[0]).toBe(false);
    expect(f.pendingStates.at(-1)).toBe(true);
    expect(f.writes.get("out/bundle-manifest.json")).toBe("immutable synthetic manifest");
    const history = JSON.parse(f.writes.get("out/provider-identity-confirmation.json")!);
    expect(history.transitions.map((t: { state: string }) => t.state)).toContain("pending");
    expect(history.state).toBe("confirmed");
    expect(JSON.stringify([...f.writes])).not.toContain("fake-secret-only");
  });
  it.each(["out/plan-provider-billing.json", "out/provider-billing.json"])("finalizes %s with native status unchanged on terminal failure", async (path) => {
    const f = fixture(401);
    const result = await runWithDeferredBilling(f.deps, async (deps) => {
      deps.makeClient({ apiKey: "fake-only", model, effort: "low" });
      await f.gateway.callStructured(request);
      await deps.writeFile(path, JSON.stringify(f.budget.providerBilling));
      f.nativeDone(); return 0;
    });
    expect(result).toBe(0);
    const final = JSON.parse(f.writes.get(path)!);
    expect(final.comparison_valid).toBe(false);
    expect(final.actual_cost_usd).toBe(.001);
    expect(final.identity_confirmation.state).toBe("unconfirmed");
    expect(f.gets()).toBe(1);
  });
  it("leaves non-OpenRouter logs and files byte-identical", async () => {
    const writes: string[] = [], logs: string[] = [];
    const deps: CliDeps = { argv: [], env: {}, readFile: async () => "", loadDocuments: async () => [], makeDirectory: async () => {},
      makeClient: () => ({ callStructured: async () => { throw new Error("unused"); }, callWithTools: async () => { throw new Error("unused"); } }),
      writeFile: async (_path, text) => { writes.push(text); }, log: (line) => { logs.push(line); } };
    expect(await runWithDeferredBilling(deps, async (wrapped) => {
      wrapped.log!("native line"); await wrapped.writeFile("native.json", "native bytes"); return 4;
    })).toBe(4);
    expect(logs).toEqual(["native line"]); expect(writes).toEqual(["native bytes"]);
  });
});
