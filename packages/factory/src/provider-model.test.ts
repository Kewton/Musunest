import { describe, expect, it } from "vitest";
import { modelIdentityPin, pinnedModelMatches } from "./provider-model.js";
import { openRouterArmPin } from "./openrouter-arm.js";
import { providerBillingReceipt } from "./provider-billing.js";
import { responseIdentity } from "./openrouter-identity.js";
import { createOpenRouterLlmClient } from "./openrouter.js";
import { JobBudget } from "./budget.js";
import { CallGateway } from "./call.js";
import type { LlmStructuredRequest } from "./llm.js";

const requested = "z-ai/glm-5.3-flash";
const canonical = "z-ai/glm-5.3-flash-20260826";
const pin = openRouterArmPin("open-inference/fp4", requested);
const route = { only: [pin.arm], require_parameters: true, allow_fallbacks: false };
function wire(model = requested, routerModel = canonical, provider = "OpenInference") {
  return { id: "gen-synthetic", model, status: "completed", usage: { input_tokens: 100, output_tokens: 20, cost: .001 },
    openrouter_metadata: { requested, endpoints: { available: [{ provider, model: routerModel, selected: true }] },
      attempts: [{ provider, model: routerModel, status: 200 }] },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"value":1}', annotations: [] }] }] };
}
const request: LlmStructuredRequest = { instructions: "synthetic rules", documents: [], rules: [], input: "synthetic input",
  schemaName: "synthetic", schema: { type: "object", required: ["value"], additionalProperties: false,
    properties: { value: { type: "number" } } }, maxOutputTokens: 32 };

describe("pinned Models API id to canonical_slug edges (S-175y)", () => {
  it("binds the exact catalog edge, timestamp and digest to an immutable pin", () => {
    expect(pin.model_identity).toMatchObject({ requested, canonical_slug: canonical, policy: "models-api-id-canonical/v1",
      source: "https://openrouter.ai/api/v1/models", catalog_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Object.isFrozen(pin.model_identity)).toBe(true);
    expect(pinnedModelMatches(pin, requested)).toBe(true);
    expect(pinnedModelMatches(pin, canonical)).toBe(true);
  });
  it.each([
    "z-ai/glm-5.3", "z-ai/glm-5.3-flash-20260825", "z-ai/glm-5.3-flash-2026-08-26",
    "z-ai/glm-5.3-flash-202608260", "z-ai/glm-5.3-flash-20260826-extra", "z-ai/glm-5.3-flash-20260826:free",
    "z-ai/glm-5.3-flash:batch", "other/glm-5.3-flash-20260826", "z-ai/glm-5.3-flash/20260826",
    "prefix-z-ai/glm-5.3-flash-20260826", null,
  ])("rejects unverified or differently shaped slugs: %s", (observed) => {
    expect(pinnedModelMatches(pin, observed)).toBe(false);
  });
  it("unknown requests remain exact-only, including arbitrary date suffixes", () => {
    const other = openRouterArmPin("open-inference/fp4", "synthetic/model");
    expect(other.model_identity?.policy).toBe("exact-only/v1");
    expect(pinnedModelMatches(other, "synthetic/model")).toBe(true);
    expect(pinnedModelMatches(other, "synthetic/model-20260826")).toBe(false);
  });
  it("does not accept another alias merely because it could share canonical weights", () => {
    const batch = openRouterArmPin("open-inference/fp4", requested + ":batch");
    expect(pinnedModelMatches(batch, canonical)).toBe(false);
    expect(pinnedModelMatches(pin, requested + ":batch")).toBe(false);
  });
  it.each([
    { canonical_slug: "other/model" }, { requested: "other/model" }, { catalog_sha256: "0".repeat(64) },
    { source: "https://untrusted.invalid/models" }, { observed_at: "changed" }, { policy: "exact-only/v1" as const },
  ])("rejects substituted model proof: %j", (changed) => {
    const forged = { ...pin, model_identity: { ...pin.model_identity!, ...changed } };
    expect(pinnedModelMatches(forged, canonical)).toBe(false);
    expect(pinnedModelMatches(forged, requested)).toBe(false);
  });
  it("legacy pins without a catalog proof retain strict equality", () => {
    expect(pinnedModelMatches({ model: requested }, requested)).toBe(true);
    expect(pinnedModelMatches({ model: requested }, canonical)).toBe(false);
    expect(modelIdentityPin(requested + "-other").canonical_slug).toBeNull();
  });
  it.each([requested, canonical])("accepts a verified router version with raw response %s", (responseModel) => {
    const body = wire(responseModel);
    const receipt = providerBillingReceipt(body, pin);
    const ev = responseIdentity(body, receipt, pin, route);
    expect(receipt.identity_reasons).toEqual(["provider-unconfirmed", "quantization-unconfirmed"]);
    expect(ev.confirmation_state).toBe("confirmed");
    expect(ev.model_match_basis).toBe("catalog-canonical");
    expect(ev.router_model).toBe(canonical);
    expect(receipt.returned_model).toBe(responseModel);
  });
  it("still rejects a different provider with a valid canonical model", () => {
    const body = wire(requested, canonical, "OtherProvider");
    expect(responseIdentity(body, providerBillingReceipt(body, pin), pin, route).reasons).toContain("provider-mismatch");
  });
  it("a good router cannot hide a different raw response model", () => {
    const body = wire("other/model");
    expect(responseIdentity(body, providerBillingReceipt(body, pin), pin, route).confirmation_state).toBe("invalid");
  });
  it("metadata.requested must still be the actual request id", () => {
    const body = wire(); body.openrouter_metadata.requested = canonical;
    expect(responseIdentity(body, providerBillingReceipt(body, pin), pin, route).reasons).toContain("router-model-mismatch");
  });
  it("canonical router replies preserve billing and need no fallback GET", async () => {
    let gets = 0;
    const client = createOpenRouterLlmClient({ apiKey: "fake-only", model: requested, arm: "open-inference/fp4", effort: "low", fetch: async (_url, init) => {
      if (init.method === "GET") { gets++; throw new Error("must not GET"); }
      return new Response(JSON.stringify(wire()));
    } });
    const budget = new JobBudget(1);
    const gateway = new CallGateway({ client, budget, rates: pin.rates, now: () => 0, deadline: 100000, maxAttempts: 1 });
    expect((await gateway.callStructured(request)).kind).toBe("ok");
    const result = (await client.finalizeProviderBilling!([budget.providerBilling!], { deadline: Date.now() + 90000, onProgress: async () => {} }))[0]!;
    expect(result.comparison_valid).toBe(true);
    expect(result.actual_cost_usd).toBe(.001);
    expect(result.attempts[0]?.receipt?.identity_evidence?.router_model).toBe(canonical);
    expect(gets).toBe(0);
  });
  it("deferred GET accepts only the same pinned canonical version", async () => {
    const response = wire();
    const { openrouter_metadata: _unused, ...cached } = response;
    const client = createOpenRouterLlmClient({ apiKey: "fake-only", model: requested, arm: "open-inference/fp4", fetch: async (_url, init) =>
      new Response(JSON.stringify(init.method === "GET" ? { data: { id: cached.id, provider_name: "OpenInference", model: canonical } } : cached)) });
    const budget = new JobBudget(1);
    const gateway = new CallGateway({ client, budget, rates: pin.rates, now: () => 0, deadline: 100000, maxAttempts: 1 });
    await gateway.callStructured(request);
    const result = (await client.finalizeProviderBilling!([budget.providerBilling!], { deadline: Date.now() + 90000, onProgress: async () => {} }))[0]!;
    expect(result.comparison_valid).toBe(true);
    expect(result.attempts[0]?.receipt?.identity_evidence).toMatchObject({ source: "generation", model_match_basis: "catalog-canonical", lookup_model: canonical });
  });
});
