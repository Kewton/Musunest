import { afterEach, describe, expect, it, vi } from "vitest";
import { JobBudget } from "./budget.js";
import { CallGateway } from "./call.js";
import { createOpenRouterLlmClient } from "./openrouter.js";
import { openRouterArmPin, type OpenRouterArm } from "./openrouter-arm.js";
import { GENERATION_CONFIRMATION_MS, responseIdentity } from "./openrouter-identity.js";
import { ProviderBillingLedger, noteProviderBilling, providerBillingReceipt, type ProviderBillingSummary } from "./provider-billing.js";
import type { FetchLike } from "./openai.js";
import type { LlmStructuredRequest } from "./llm.js";

const model = "synthetic/model";
const pin = openRouterArmPin("morph/fp8", model);
const route = { only: [pin.arm], allow_fallbacks: false, require_parameters: true };
const request: LlmStructuredRequest = {
  instructions: "synthetic rules", documents: [], rules: [], input: "synthetic input", schemaName: "synthetic",
  schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "number" } } }, maxOutputTokens: 32,
};
function router(provider = "Morph", extra: Record<string, unknown> = {}) {
  return { requested: model, endpoints: { available: [{ provider, model, selected: true }] }, ...extra };
}
function wire(extra: Record<string, unknown> = {}) {
  return { id: "gen-synthetic", model, status: "completed", usage: { input_tokens: 100, output_tokens: 20, cost: .001 },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"value":1}', annotations: [] }] }], ...extra };
}
const json = (v: unknown) => new Response(JSON.stringify(v));
function metadata(extra: Record<string, unknown> = {}) { return { data: { id: "gen-synthetic", provider_name: "Morph", model, ...extra } }; }
function setup(get: FetchLike, extra: Record<string, unknown> = {}, arm: OpenRouterArm = "morph/fp8") {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createOpenRouterLlmClient({ apiKey: "fake-secret-only", model, arm, effort: "low", fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return init.method === "GET" ? get(url, init) : json(wire(extra));
  } });
  const budget = new JobBudget(1);
  const gateway = new CallGateway({ client, budget, rates: client.billingPin!.rates, now: () => 0, deadline: 100000, maxAttempts: 1 });
  const progress: ProviderBillingSummary[] = [];
  const finish = async (window = GENERATION_CONFIRMATION_MS) => {
    const result = await client.finalizeProviderBilling!([budget.providerBilling!], {
      deadline: Date.now() + window, onProgress: async (snapshots) => { progress.push(snapshots[0]!); },
    });
    return result[0]!;
  };
  return { calls, client, budget, gateway, finish, progress };
}
afterEach(() => vi.useRealTimers());

describe("router primary and deferred confirmation (S-175x)", () => {
  it.each(["morph/fp8", "open-inference/fp4"] as const)("uses explicit router selection for %s with no generation-path GET", async (arm) => {
    const provider = arm.startsWith("morph") ? "Morph" : "OpenInference";
    const s = setup(async () => { throw new Error("must not GET"); }, { openrouter_metadata: router(provider) }, arm);
    const native = await s.gateway.callStructured(request);
    expect(native.kind).toBe("ok");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.init.headers).toMatchObject({ "X-OpenRouter-Metadata": "enabled" });
    expect(JSON.parse(String(s.calls[0]?.init.body)).provider).toEqual({ only: [arm], allow_fallbacks: false, require_parameters: true });
    const result = await s.finish();
    expect(result.comparison_valid).toBe(true);
    expect(result.actual_cost_usd).toBe(.001);
    expect(result.attempts[0]?.receipt).toMatchObject({ returned_provider: null, returned_quantization: null,
      identity_evidence: { source: "router-metadata", confirmation_state: "confirmed", router_provider: provider, quantization_basis: "exclusive-endpoint", lookup_requests: 0 } });
    expect(JSON.stringify(result)).not.toContain("fake-secret-only");
  });
  it("uses a returned provider directly while keeping precision enforcement explicit", async () => {
    const s = setup(async () => { throw new Error("must not GET"); }, { provider: "Morph", quantization: "fp8" });
    await s.gateway.callStructured(request);
    expect((await s.finish()).comparison_valid).toBe(true);
    expect(s.calls).toHaveLength(1);
  });
  it.each([
    router("Other"), router("Morph", { requested: "other/model" }),
    { endpoints: { available: [{ provider: "Morph", model: "other/model", selected: true }] } },
    { endpoints: { available: [{ provider: "Morph", model, selected: true, quantization: "fp4" }] } },
    { endpoints: { available: [{ provider: "Morph", model, selected: true }, { provider: "Other", model, selected: true }] } },
    router("Morph", { attempts: [{ provider: "Other", model, status: 503 }, { provider: "Morph", model, status: 200 }] }),
  ])("rejects contradictory/ambiguous router metadata: %j", async (routerMetadata) => {
    const s = setup(async () => { throw new Error("must not GET"); }, { openrouter_metadata: routerMetadata });
    await s.gateway.callStructured(request);
    const result = await s.finish();
    expect(result.comparison_valid).toBe(false);
    expect(result.identity_confirmation?.state).toBe("invalid");
    expect(s.calls).toHaveLength(1);
  });
  it.each([{ model: "other/model" }, { model: undefined }, { provider: "Other" }, { quantization: "fp4" }, { provider: 12 }])(
    "a good router cannot hide invalid Responses identity: %j", async (changed) => {
      const s = setup(async () => json(metadata()), { openrouter_metadata: router(), ...changed });
      await s.gateway.callStructured(request);
      expect((await s.finish()).comparison_valid).toBe(false);
    });
  it.each([{ only: ["morph"] }, { only: ["morph/fp8", "other"] }, { allow_fallbacks: true }, { require_parameters: false }])(
    "never accepts nonexclusive routing evidence: %j", (changed) => {
      const receipt = providerBillingReceipt(wire(), pin);
      const ev = responseIdentity(wire({ openrouter_metadata: router() }), receipt, pin, { ...route, ...changed });
      expect(ev.reasons).toContain("routing-pin-unconfirmed");
    });
  it("keeps a cache omission pending until job finalization, then confirms without rebooking cost", async () => {
    const s = setup(async () => json(metadata({ total_cost: 999 })));
    await s.gateway.callStructured(request);
    expect(s.calls).toHaveLength(1);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
    expect(s.budget.providerBilling?.attempts[0]?.receipt?.identity_evidence?.confirmation_state).toBe("pending");
    const result = await s.finish();
    expect(result.comparison_valid).toBe(true);
    expect(result.actual_cost_usd).toBe(.001);
    expect(result.guard_spent_usd).toBe(.001);
    expect(result.identity_confirmation?.transitions.map((t) => t.state)).toContain("pending");
    expect(result.identity_confirmation?.state).toBe("confirmed");
    expect(s.calls[1]?.url).toBe("https://openrouter.ai/api/v1/generation?id=gen-synthetic");
  });
  it("does not infer provider from the only unselected candidate", async () => {
    const s = setup(async () => json(metadata()), { openrouter_metadata: router("Morph", { endpoints: { available: [{ provider: "Morph", model, selected: false }] } }) });
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
    expect((await s.finish()).comparison_valid).toBe(true);
    expect(s.calls).toHaveLength(2);
  });
  it("promotes a delayed 404 to confirmed after backoff outside generation", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const s = setup(async () => Date.now() - started < 10000 ? new Response("", { status: 404 }) : json(metadata()));
    await s.gateway.callStructured(request);
    const nativeCounts = s.gateway.counts;
    const pending = s.finish();
    await vi.advanceTimersByTimeAsync(16000);
    const result = await pending;
    expect(result.comparison_valid).toBe(true);
    expect(result.attempts[0]?.receipt?.identity_evidence?.lookup_elapsed_ms).toBeGreaterThanOrEqual(10000);
    expect(s.gateway.counts).toEqual(nativeCounts);
    expect(s.calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
    expect(s.progress.some((p) => p.identity_confirmation?.state === "pending")).toBe(true);
  });
  it.each([404, 429, 500])("exhausts %s within the independent 90s window without promotion", async (status) => {
    vi.useFakeTimers();
    const s = setup(async () => new Response("private-body", { status }));
    await s.gateway.callStructured(request);
    const pending = s.finish();
    await vi.advanceTimersByTimeAsync(GENERATION_CONFIRMATION_MS + 1);
    const result = await pending;
    expect(result.comparison_valid).toBe(false);
    expect(result.identity_confirmation?.state).toBe("unconfirmed");
    const ev = result.attempts[0]?.receipt?.identity_evidence;
    expect(ev?.confirmation_state).toBe("exhausted");
    expect(ev?.lookup_requests).toBeGreaterThan(2);
    expect(ev?.lookup_requests).toBeLessThanOrEqual(8);
    expect(ev?.lookup_elapsed_ms).toBeLessThanOrEqual(GENERATION_CONFIRMATION_MS);
    expect(JSON.stringify(result)).not.toContain("private-body");
  });
  it.each([{ id: "gen-other" }, { provider_name: "Other" }, { model: "other/model" }, { quantization: "fp4" }])(
    "a generation mismatch is immediately invalid: %j", async (changed) => {
      const s = setup(async () => json(metadata(changed)));
      await s.gateway.callStructured(request);
      const result = await s.finish();
      expect(result.identity_confirmation?.state).toBe("invalid");
      expect(result.comparison_valid).toBe(false);
      expect(s.calls).toHaveLength(2);
    });
  it("does not retry authorization failure or manufacture missing billed cost", async () => {
    const s = setup(async () => new Response("private-error", { status: 401 }), { usage: { input_tokens: 100, output_tokens: 20 } });
    await s.gateway.callStructured(request);
    const result = await s.finish();
    expect(result.actual_cost_usd).toBeNull();
    expect(result.actual_cost_complete).toBe(false);
    expect(result.unsettled_reservations_usd).toBeGreaterThan(0);
    expect(s.calls).toHaveLength(2);
  });
  it("bounds fetch and ignores successful identity arriving after confirmation expiry", async () => {
    vi.useFakeTimers();
    let finish!: (r: Response) => void;
    const s = setup(async () => new Promise<Response>((resolve) => { finish = resolve; }));
    await s.gateway.callStructured(request);
    const pending = s.finish(5000);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result.comparison_valid).toBe(false);
    finish(json(metadata()));
    await vi.advanceTimersByTimeAsync(1);
    expect(result.comparison_valid).toBe(false);
  });
  it("keeps paid schema failures native while identity is confirmed", async () => {
    const s = setup(async () => json(metadata()), { openrouter_metadata: router(),
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"value":"wrong"}', annotations: [] }] }] });
    expect(await s.gateway.callStructured(request)).toMatchObject({ kind: "failed", errorKind: "malformed" });
    const result = await s.finish();
    expect(result.actual_cost_usd).toBe(.001);
    expect(result.comparison_valid).toBe(true);
    expect(result.unsettled_reservations_usd).toBeGreaterThan(0);
  });
  it("closes a receipt-less transport failure honestly even when the retry succeeds", async () => {
    let posts = 0;
    const client = createOpenRouterLlmClient({ apiKey: "fake-only", model, fetch: async () => {
      if (++posts === 1) throw new Error("synthetic network failure");
      return json(wire({ openrouter_metadata: router() }));
    } });
    const budget = new JobBudget(1);
    const gateway = new CallGateway({ client, budget, rates: pin.rates, now: () => 0, deadline: 100000, callTimeoutMs: 1000, maxAttempts: 2 });
    expect((await gateway.callStructured(request)).kind).toBe("ok");
    const result = (await client.finalizeProviderBilling!([budget.providerBilling!], { deadline: Date.now() + 90000, onProgress: async () => {} }))[0]!;
    expect(result.attempts[0]).toMatchObject({ state: "closed-unknown", failure_kind: "network", receipt: null, guard_settled: false });
    expect(result.actual_cost_usd).toBeNull();
    expect(result.observed_cost_subtotal_usd).toBe(.001);
    expect(result.unsettled_reservations_usd).toBeGreaterThan(0);
    expect(result.comparison_valid).toBe(false);
    expect(posts).toBe(2);
  });
  it.each(["non-json", "array"])("rejects %s generation metadata without copying response text", async (kind) => {
    const s = setup(async () => new Response(kind === "array" ? "[]" : "private-invalid-json"));
    await s.gateway.callStructured(request);
    const result = await s.finish();
    expect(result.comparison_valid).toBe(false);
    expect(result.identity_confirmation?.state).toBe("unconfirmed");
    expect(JSON.stringify(result)).not.toContain("private-invalid-json");
  });
  it("allows initially incomplete generation metadata to become complete", async () => {
    vi.useFakeTimers();
    let gets = 0;
    const s = setup(async () => json(metadata(++gets === 1 ? { provider_name: undefined } : {})));
    await s.gateway.callStructured(request);
    const pending = s.finish();
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).comparison_valid).toBe(true);
    expect(gets).toBe(2);
  });
  it("cannot promote a successful body parsed after the confirmation deadline", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 3000;
    const response = new Response();
    response.text = async () => { vi.setSystemTime(deadline + 1); return JSON.stringify(metadata()); };
    const s = setup(async () => response);
    await s.gateway.callStructured(request);
    const result = await s.finish(3000);
    expect(result.comparison_valid).toBe(false);
    expect(result.attempts[0]?.receipt?.identity_evidence?.confirmation_state).toBe("exhausted");
  });
  it("bounds a metadata body that ignores abort", async () => {
    vi.useFakeTimers();
    const response = new Response(); response.text = async () => new Promise<string>(() => {});
    const s = setup(async () => response);
    await s.gateway.callStructured(request);
    const pending = s.finish(3000);
    await vi.advanceTimersByTimeAsync(3001);
    expect((await pending).comparison_valid).toBe(false);
  });
  it("keeps reverse-order parallel metadata attached to its generation ID", async () => {
    const resolvers = new Map<string, (r: Response) => void>();
    let posts = 0;
    const client = createOpenRouterLlmClient({ apiKey: "fake-only", model, fetch: async (url, init) => {
      if (init.method === "POST") return json(wire({ id: `gen-${++posts}` }));
      const id = new URL(String(url)).searchParams.get("id")!;
      return new Promise<Response>((resolve) => { resolvers.set(id, resolve); });
    } });
    const budget = new JobBudget(1);
    const gateway = new CallGateway({ client, budget, rates: pin.rates, now: () => 0, deadline: 100000, maxAttempts: 1 });
    await Promise.all([gateway.callStructured(request), gateway.callStructured(request)]);
    const pending = client.finalizeProviderBilling!([budget.providerBilling!], { deadline: Date.now() + 90000, onProgress: async () => {} });
    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    resolvers.get("gen-2")!(json(metadata({ id: "gen-2", provider_name: "Other" })));
    resolvers.get("gen-1")!(json(metadata({ id: "gen-1" })));
    const result = (await pending)[0]!;
    expect(result.attempts.map((a) => a.receipt?.identity_evidence?.lookup_provider)).toEqual(["Morph", "Other"]);
    expect(result.actual_cost_usd).toBe(.002);
    expect(result.comparison_valid).toBe(false);
  });
  it("rounds negative floating reservations outward without changing charges", () => {
    const budget = new JobBudget(1);
    const accounts = [.3, .6].map((amount, index) => {
      const reserved = budget.reserve(amount);
      if (!reserved.reserved) throw new Error("synthetic reservation failed");
      const accounting = budget.providerAttempt(pin, reserved.reservation, pin.rates, "generation");
      const signal = new AbortController().signal; accounting.bind(signal);
      noteProviderBilling(signal, providerBillingReceipt(wire({ id: `gen-${index}`, provider: "Morph", quantization: "fp8" }), pin));
      return accounting;
    });
    for (const accounting of accounts) accounting.close(true);
    expect(budget.reservedUsd).toBeLessThan(0);
    expect(budget.providerBilling).toMatchObject({ actual_cost_usd: .002, unsettled_reservations_usd: 0, reservation_roundoff_usd: budget.reservedUsd });
  });
  it("does not conceal negative reservations beyond roundoff", () => {
    expect(new ProviderBillingLedger().snapshot(-.01, 0).unsettled_reservations_usd).toBe(-.01);
  });
});
