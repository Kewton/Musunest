import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBudget } from "./budget.js";
import { CallGateway } from "./call.js";
import { createOpenRouterLlmClient } from "./openrouter.js";
import { openRouterArmPin, type OpenRouterArm } from "./openrouter-arm.js";
import { GENERATION_LOOKUP_TIMEOUT_MS, openRouterIdentity } from "./openrouter-identity.js";
import { ProviderBillingLedger, noteProviderBilling, providerBillingReceipt } from "./provider-billing.js";
import type { FetchLike } from "./openai.js";
import type { LlmStructuredRequest } from "./llm.js";

const model = "synthetic/model";
const pin = openRouterArmPin("morph/fp8", model);
const route = { only: [pin.arm], allow_fallbacks: false, require_parameters: true };
const request: LlmStructuredRequest = {
  instructions: "synthetic rules", documents: [], rules: [], input: "synthetic input",
  schemaName: "synthetic", schema: { type: "object", required: ["value"], additionalProperties: false,
    properties: { value: { type: "number" } } }, maxOutputTokens: 32,
};
function wire(extra: Record<string, unknown> = {}) {
  return { id: "gen-synthetic", model, status: "completed", usage: { input_tokens: 100, output_tokens: 20, cost: .001, is_byok: false },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"value":1}', annotations: [] }] }], ...extra };
}
function metadata(extra: Record<string, unknown> = {}) {
  return { data: { id: "gen-synthetic", provider_name: "Morph", model, ...extra } };
}
function setup(get: FetchLike, extra: Record<string, unknown> = {}, arm: OpenRouterArm = "morph/fp8") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    return init.method === "GET" ? get(url, init) : new Response(JSON.stringify(wire(extra)));
  };
  const client = createOpenRouterLlmClient({ apiKey: "fake-secret-only", model, arm, effort: "low", fetch });
  const budget = new JobBudget(1);
  const gateway = new CallGateway({ client, budget, rates: client.billingPin!.rates, now: () => 0,
    deadline: 100000, effort: "low", maxAttempts: 1 });
  return { calls, client, budget, gateway };
}
const json = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => vi.useRealTimers());

describe("generation identity with exclusive endpoint evidence (S-175w)", () => {
  it.each(["morph/fp8", "open-inference/fp4"] as const)("confirms %s without inventing returned provider/precision", async (arm) => {
    const provider = arm === "morph/fp8" ? "Morph" : "OpenInference";
    const s = setup(async () => json(metadata({ provider_name: provider, total_cost: 999, usage: { cost: 999 } })), {}, arm);
    await s.gateway.callStructured(request);
    const billing = s.budget.providerBilling!;
    expect(billing.comparison_valid).toBe(true);
    expect(billing.actual_cost_usd).toBe(.001);
    expect(billing.attempts).toHaveLength(1);
    expect(billing.attempts[0]?.receipt).toMatchObject({ returned_provider: null, returned_quantization: null,
      identity_evidence: { lookup_status: "ok", lookup_provider: provider, quantization_basis: "exclusive-endpoint", lookup_requests: 1 } });
    expect(s.calls[1]?.url).toBe("https://openrouter.ai/api/v1/generation?id=gen-synthetic");
    expect(s.calls[1]?.init).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: "Bearer fake-secret-only" } });
    expect(s.calls[1]?.init.body).toBeUndefined();
    expect(JSON.stringify(billing)).not.toContain("fake-secret-only");
    expect(JSON.parse(String(s.calls[0]?.init.body)).provider).toEqual({ only: [arm], require_parameters: true, allow_fallbacks: false });
  });
  it("rounds a negative floating reservation upward without changing charges", () => {
    const budget = new JobBudget(1);
    const accounts = [.3, .6].map((amount, index) => {
      const reserved = budget.reserve(amount);
      if (!reserved.reserved) throw new Error("synthetic reservation failed");
      const accounting = budget.providerAttempt(pin, reserved.reservation, pin.rates, "generation");
      const signal = new AbortController().signal;
      accounting.bind(signal);
      noteProviderBilling(signal, providerBillingReceipt(wire({ id: `gen-${index}`, provider: "Morph", quantization: "fp8" }), pin));
      return accounting;
    });
    for (const accounting of accounts) accounting.close(true);
    expect(budget.reservedUsd).toBeLessThan(0);
    expect(budget.reservedUsd).toBeGreaterThan(-Number.EPSILON);
    expect(budget.providerBilling).toMatchObject({ comparison_valid: true, actual_cost_usd: .002,
      unsettled_reservations_usd: 0, reservation_roundoff_usd: budget.reservedUsd, guard_spent_usd: .002 });
  });
  it("does not conceal a negative reservation beyond floating roundoff", () => {
    expect(new ProviderBillingLedger().snapshot(-.01, 0).unsettled_reservations_usd).toBe(-.01);
  });
  it("metadata cannot settle unknown Responses cost", async () => {
    const s = setup(async () => json(metadata({ total_cost: .001 })), {
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.actual_cost_usd).toBeNull();
    expect(s.budget.providerBilling?.actual_cost_complete).toBe(false);
    expect(s.budget.providerBilling?.invalid_reasons).toContain("billing-unconfirmed");
    expect(s.budget.reservedUsd).toBeGreaterThan(0);
  });
  it("keeps the existing fully returned identity path without an extra GET", async () => {
    const s = setup(async () => { throw new Error("must not GET"); }, { provider: "Morph", quantization: "fp8" });
    await s.gateway.callStructured(request);
    expect(s.calls).toHaveLength(1);
    expect(s.budget.providerBilling?.comparison_valid).toBe(true);
  });
  it.each([
    { provider_name: "Other" }, { model: "different/model" }, { id: "gen-other" },
    { quantization: "fp4" }, { provider_name: undefined }, { model: undefined }, { id: undefined }, { quantization: 7 },
  ])("rejects mismatched/unconfirmed generation metadata: %j", async (changed) => {
    const s = setup(async () => json(metadata(changed)));
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
  });
  it.each([
    { model: "different/model" }, { model: undefined }, { provider: "Other" }, { quantization: "fp4" },
    { provider: 12 }, { quantization: 12 },
  ])("a matching lookup cannot hide a bad Responses identity: %j", async (changed) => {
    const s = setup(async () => json(metadata()), changed);
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
  });
  it.each([
    { only: ["morph"] }, { only: ["morph/fp8", "other"] }, { allow_fallbacks: true }, { require_parameters: false },
  ])("does not accept nonexclusive routing evidence: %j", async (changed) => {
    const evidence = await openRouterIdentity({ receipt: providerBillingReceipt(wire(), pin), pin,
      route: { ...route, ...changed }, fetch: async () => json(metadata()), apiKey: "fake-only", signal: new AbortController().signal });
    expect(evidence.reasons).toContain("routing-pin-unconfirmed");
  });
  it("retries metadata visibility once, without another generation", async () => {
    let gets = 0;
    const s = setup(async () => ++gets === 1 ? new Response("", { status: 404 }) : json(metadata()));
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.comparison_valid).toBe(true);
    expect(s.calls.filter((x) => x.init.method === "POST")).toHaveLength(1);
    expect(s.budget.providerBilling?.attempts[0]?.receipt?.identity_evidence?.lookup_requests).toBe(2);
  });
  it.each([401, 404, 429, 500])("a failed GET %s cannot drop paid native schema failure", async (status) => {
    const s = setup(async () => new Response("private-error-body", { status }), {
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"value":"wrong"}', annotations: [] }] }],
    });
    await expect(s.gateway.callStructured(request)).resolves.toMatchObject({ kind: "failed", errorKind: "malformed" });
    expect(s.budget.providerBilling).toMatchObject({ actual_cost_usd: .001, actual_cost_complete: true, comparison_valid: false });
    expect(s.budget.reservedUsd).toBeGreaterThan(0);
    expect(JSON.stringify(s.budget.providerBilling)).not.toContain("private-error-body");
    expect(s.calls.filter((x) => x.init.method === "GET")).toHaveLength(status === 401 ? 1 : 2);
  });
  it.each(["non-json", "array", "network"])("fails closed on %s metadata", async (kind) => {
    const s = setup(async () => {
      if (kind === "network") throw new Error("fake-secret-only");
      return new Response(kind === "array" ? "[]" : "not JSON");
    });
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
    expect(JSON.stringify(s.budget.providerBilling)).not.toContain("fake-secret-only");
  });
  it("bounds a fetch ignoring abort and never accepts its late identity", async () => {
    vi.useFakeTimers();
    let finish!: (r: Response) => void;
    const s = setup(async () => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = s.gateway.callStructured(request);
    await vi.advanceTimersByTimeAsync(GENERATION_LOOKUP_TIMEOUT_MS + 1);
    await pending;
    expect(s.budget.providerBilling?.attempts[0]?.receipt?.identity_evidence?.lookup_status).toBe("timeout");
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
    finish(json(metadata()));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
  });
  it("bounds a metadata body ignoring abort", async () => {
    vi.useFakeTimers();
    const response = new Response();
    response.text = async () => new Promise<string>(() => {});
    const s = setup(async () => response);
    const pending = s.gateway.callStructured(request);
    await vi.advanceTimersByTimeAsync(GENERATION_LOOKUP_TIMEOUT_MS + 1);
    await pending;
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
    expect(s.budget.providerBilling?.attempts[0]?.receipt?.identity_evidence?.lookup_status).toBe("timeout");
  });
  it("honors the original request abort and keeps the paid receipt", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const s = setup(async () => { entered(); return new Promise<Response>(() => {}); });
    const reserved = s.budget.reserve(.01);
    if (!reserved.reserved) throw new Error("synthetic reservation failed");
    const accounting = s.budget.providerAttempt(pin, reserved.reservation, pin.rates, "generation");
    accounting.bind(controller.signal);
    const pending = s.client.callStructured({ ...request, signal: controller.signal });
    await ready;
    controller.abort();
    // Native decoding remains native; only identity confirmation fails closed.
    await pending;
    accounting.close(false);
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
    expect(s.budget.reservedUsd).toBe(.01);
    const receipt = providerBillingReceipt(wire(), pin);
    const evidence = await openRouterIdentity({ receipt, pin, route, fetch: async () => { throw new Error("must not GET"); },
      apiKey: "fake-only", signal: controller.signal });
    expect(evidence.reasons.length).toBeGreaterThan(0);
    expect(evidence.lookup_requests).toBe(0);
  });
  it("keeps concurrent reverse-order metadata bound to the correct receipt", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    let posts = 0;
    const client = createOpenRouterLlmClient({ apiKey: "fake-only", model, fetch: async (_url, init) => {
      if (init.method === "GET") return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      return json(wire({ id: `gen-${++posts}` }));
    } });
    const budget = new JobBudget(1);
    const gateway = new CallGateway({ client, budget, rates: pin.rates, now: () => 0, deadline: 100000, maxAttempts: 1 });
    const first = gateway.callStructured(request), second = gateway.callStructured(request);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!(json(metadata({ id: "gen-2", provider_name: "Other" })));
    await second;
    resolvers[0]!(json(metadata({ id: "gen-1" })));
    await first;
    expect(budget.providerBilling?.actual_cost_usd).toBe(.002);
    expect(budget.providerBilling?.attempts.map((a) => a.receipt?.identity_evidence?.lookup_provider)).toEqual(["Morph", "Other"]);
    expect(budget.providerBilling?.comparison_valid).toBe(false);
  });
});
