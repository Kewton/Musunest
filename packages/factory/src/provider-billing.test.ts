import { describe, expect, it } from "vitest";
import { JobBudget, costOfUsageUsd, estimateMaxCostUsd } from "./budget.js";
import { CallGateway, estimateInputUpperBoundTokens, structuredInputParts } from "./call.js";
import { createOpenRouterLlmClient } from "./openrouter.js";
import { DEFAULT_OPENROUTER_ARM, openRouterArmPin, type OpenRouterArm } from "./openrouter-arm.js";
import { providerBillingReceipt } from "./provider-billing.js";
import { UsageMeter } from "./record.js";
import { parseCliArguments, ratesOf, runCli } from "./cli.js";
import { createLlmJudge } from "./judge-llm.js";
import { createBudgetedJudge } from "./judge-budget.js";
import { callStructuredChecked } from "./stages/prompt.js";
import type { LlmStructuredRequest } from "./llm.js";

const model = "synthetic/model";
const pin = openRouterArmPin(DEFAULT_OPENROUTER_ARM, model);
const request: LlmStructuredRequest = {
  instructions: "synthetic rules", documents: [], rules: [], input: "synthetic input",
  schemaName: "synthetic", schema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "number" } } },
  maxOutputTokens: 32,
};
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
  output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, cost: .001,
  is_byok: false, cost_details: { upstream_inference_input_cost: .0001, upstream_inference_output_cost: .0009 } };
function wire(extra: Record<string, unknown> = {}) {
  return { id: "gen-synthetic", provider: "Morph", model, quantization: "fp8", status: "completed", usage,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ value: 1 }), annotations: [] }] }], ...extra };
}
function setup(replies: readonly Record<string, unknown>[], arm: OpenRouterArm = DEFAULT_OPENROUTER_ARM) {
  const bodies: Record<string, unknown>[] = [];
  const client = createOpenRouterLlmClient({ apiKey: "fake-test-only", model, effort: "low", arm,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies[Math.min(bodies.length - 1, replies.length - 1)]), { status: 200 });
    } });
  const budget = new JobBudget(1);
  const gateway = new CallGateway({ client: new UsageMeter().wrap(client), budget, rates: ratesOf("openrouter", arm), now: () => 0, deadline: 1000, effort: "low", maxAttempts: 1 });
  return { bodies, client, budget, gateway };
}

describe("OpenRouter arm selection and request pin", () => {
  it.each(["morph/fp8", "open-inference/fp4"] as const)("pins %s without fallback and preserves low/strict", async (arm) => {
    const s = setup([wire()], arm);
    await s.gateway.callStructured(request);
    expect(s.bodies[0]?.provider).toEqual({ only: [arm], require_parameters: true, allow_fallbacks: false });
    expect(s.bodies[0]?.reasoning).toEqual({ effort: "low" });
    expect(s.bodies[0]?.text).toMatchObject({ format: { strict: true, type: "json_schema" } });
    expect(s.client.billingPin?.arm).toBe(arm);
  });
  it("defaults to Morph, carries a dated immutable price snapshot", () => {
    const client = createOpenRouterLlmClient({ apiKey: "fake-test-only", fetch: async () => new Response() });
    expect(client.billingPin?.arm).toBe("morph/fp8");
    expect(client.billingPin?.pricing_observed_at).toBe("2026-11-01T06:05:23Z");
    expect(Object.isFrozen(client.billingPin?.rates)).toBe(true);
    expect(ratesOf("openrouter", "open-inference/fp4").outputPerToken).toBe(.1702 / 1e6);
  });
  it("rejects an unknown arm before fetch and CLI rejects missing/conflicting selection", () => {
    expect(() => openRouterArmPin("other/provider", model)).toThrow("openrouter:unknown-arm");
    expect(() => createOpenRouterLlmClient({ apiKey: "fake-test-only", arm: "other/provider" as OpenRouterArm })).toThrow("openrouter:unknown-arm");
    for (const flags of [["--provider", "openrouter", "--openrouter-arm", "other"], ["--openrouter-arm", "morph/fp8"], ["--provider", "openrouter", "--openrouter-arm"]]) {
      expect(parseCliArguments(["request.txt", "--out", "out", ...flags])).toHaveProperty("error");
    }
    expect(parseCliArguments(["request.txt", "--out", "out", "--provider", "openrouter", "--openrouter-arm", "open-inference/fp4"])).toMatchObject({ openrouterArm: "open-inference/fp4" });
  });
  it.each([
    { provider: "OtherProvider" }, { model: "different/model" }, { quantization: "fp4" },
    { provider: undefined }, { quantization: undefined }, { id: undefined },
  ])("never substitutes a requested pin for missing/mismatched returned metadata: %j", async (changed) => {
    const s = setup([wire(changed)]);
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
    expect(s.budget.providerBilling?.invalid_reasons.length).toBeGreaterThan(0);
  });
});

describe("billed cost is independent of native acceptance and budget estimates", () => {
  it("confirms both explicitly returned OI fp4 metadata and its distinct prices", async () => {
    const s = setup([wire({ provider: "OpenInference", quantization: "fp4" })], "open-inference/fp4");
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.comparison_valid).toBe(true);
    expect(s.budget.providerBilling?.pins[0]?.rates.inputPerToken).toBe(.0098 / 1e6);
  });
  it("keeps concurrent requests bound to their own reservation and generation ID", async () => {
    const finish: ((r: Response) => void)[] = [];
    const client = createOpenRouterLlmClient({ apiKey: "fake-test-only", model,
      fetch: async () => new Promise<Response>((resolve) => { finish.push(resolve); }) });
    const budget = new JobBudget(1);
    const gateway = new CallGateway({ client, budget, rates: pin.rates, now: () => 0, deadline: 1000, maxAttempts: 1 });
    const first = gateway.callStructured(request), second = gateway.callStructured(request);
    finish[1]!(new Response(JSON.stringify(wire({ id: "gen-second", usage: { ...usage, cost: .002 } }))));
    await second;
    finish[0]!(new Response(JSON.stringify(wire({ id: "gen-first" }))));
    await first;
    expect(budget.providerBilling?.actual_cost_usd).toBe(.003);
    expect(budget.providerBilling?.attempts.map((a) => a.receipt?.generation_id)).toEqual(["gen-first", "gen-second"]);
    expect(budget.providerBilling?.comparison_valid).toBe(true);
    expect(budget.reservedUsd).toBe(0);
  });

  it("public CLI preserves paid schema failure in both sidecar and headless summary", async () => {
    const s = setup([wire({ provider: "OpenInference", quantization: "fp4" })], "open-inference/fp4");
    const writes = new Map<string, string>();
    const lines: string[] = [];
    let selected: unknown;
    const code = await runCli({
      argv: ["request.txt", "--out", "out", "--provider", "openrouter", "--openrouter-arm", "open-inference/fp4", "--model", model, "--effort", "low"],
      env: { OPENROUTER_API_KEY: "fake-test-only" },
      readFile: async () => "synthetic request", loadDocuments: async () => [],
      makeDirectory: async () => {}, writeFile: async (path, text) => { writes.set(path, text); },
      makeClient: (options) => { selected = options; return s.client; },
      log: (line) => { lines.push(line); },
    });
    expect(code).toBe(1);
    expect(selected).toMatchObject({ openrouterArm: "open-inference/fp4", model, effort: "low" });
    const receipt = JSON.parse(writes.get("out/provider-billing.json")!);
    expect(receipt.actual_cost_usd).toBe(.001);
    expect(receipt.attempts[0].receipt.returned_provider).toBe("OpenInference");
    const summary = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((value) => value?.schema_version === "commandagent.headless-summary/v1");
    expect(summary.exit_code).toBe(1);
    expect(summary.provider_billing).toEqual(receipt);
  });
  it("records paid success, cache and reasoning without double counting", async () => {
    const s = setup([wire()]);
    expect((await s.gateway.callStructured(request)).kind).toBe("ok");
    const record = s.budget.providerBilling!;
    expect(record.actual_cost_usd).toBe(.001);
    expect(record.attempts[0]?.receipt?.is_byok).toBe(false);
    expect(record.attempts[0]?.receipt?.cost_details).toEqual(usage.cost_details);
    expect(record.token_estimate_usd).toBeCloseTo((60 * .042 + 10 * .042 + 30 * .018 + 20 * .30) / 1e6, 12);
    expect(record.comparison_valid).toBe(true);
    expect(s.budget.spentUsd).toBe(.001);
  });
  it("unknown actual cost exhausts the original reservation gate before another fetch", async () => {
    const s = setup([wire({ usage: { ...usage, cost: undefined } })]);
    const max = estimateMaxCostUsd({ inputTokens: estimateInputUpperBoundTokens(structuredInputParts(request)), maxOutputTokens: request.maxOutputTokens, rates: pin.rates });
    const budget = new JobBudget(max);
    const gateway = new CallGateway({ client: s.client, budget, rates: pin.rates, now: () => 0, deadline: 1000, maxAttempts: 1 });
    expect((await gateway.callStructured(request)).kind).toBe("ok");
    expect((await gateway.callStructured(request)).kind).toBe("budgetExceeded");
    expect(s.bodies).toHaveLength(1);
    expect(budget.reservedUsd).toBe(max);
  });
  it("paid tool responses are accounted without changing tool semantics", async () => {
    const s = setup([wire()]);
    const result = await s.gateway.callWithTools({ instructions: "synthetic", documents: [], input: "synthetic", tools: [], turns: [], maxOutputTokens: 32 });
    expect(result.kind).toBe("ok");
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
  });
  it("conflicting repeated generation costs remain incomplete and cannot lower the gate", async () => {
    const s = setup([wire(), wire({ usage: { ...usage, cost: .01 } })]);
    await s.gateway.callStructured(request); await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.actual_cost_usd).toBeNull();
    expect(s.budget.providerBilling?.observed_cost_subtotal_usd).toBe(.001);
    expect(s.budget.providerBilling?.actual_cost_complete).toBe(false);
    expect(s.budget.providerBilling?.invalid_reasons).toContain("conflicting-generation-cost");
    expect(s.budget.spentUsd + s.budget.reservedUsd).toBeGreaterThanOrEqual(.01);
  });
  it("zero actual cost is known but never lowers the token-priced gate", async () => {
    const s = setup([wire({ usage: { ...usage, cost: 0 } })]);
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(0);
    expect(s.budget.providerBilling?.actual_cost_complete).toBe(true);
    expect(s.budget.spentUsd).toBe(costOfUsageUsd(s.budget.providerBilling!.attempts[0]!.receipt!.usage!, pin.rates));
    expect(s.budget.spentUsd).toBeGreaterThan(0);
  });
  it.each([undefined, null, -1, "0", Number.POSITIVE_INFINITY])("unknown/invalid cost %s retains the reservation", async (cost) => {
    const s = setup([wire({ usage: { ...usage, cost } })]);
    await s.gateway.callStructured(request);
    expect(s.budget.reservedUsd).toBeGreaterThan(0);
    expect(s.budget.providerBilling?.actual_cost_complete).toBe(false);
    expect(s.budget.providerBilling?.actual_cost_usd).toBeNull();
    expect(s.budget.providerBilling?.observed_cost_subtotal_usd).toBe(0);
    expect(s.budget.providerBilling?.unknown_attempts).toBe(1);
  });
  it.each([{ is_byok: "false" }, { cost_details: [] }, { cost_details: { upstream_inference_cost: -1 } }])("validates billing metadata: %j", (changed) => {
    expect(providerBillingReceipt(wire({ usage: { ...usage, ...changed } }), pin).cost_status).toBe("invalid");
  });
  it("schema failure is still billed and native failure is preserved", async () => {
    const s = setup([wire({ output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] })]);
    expect(await s.gateway.callStructured(request)).toMatchObject({ kind: "failed", errorKind: "malformed" });
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
    expect(s.budget.reservedUsd).toBeGreaterThan(0);
    expect(s.budget.providerBilling?.comparison_valid).toBe(true);
  });
  it("not-json is billed without accepting malformed output", async () => {
    const s = setup([wire({ output: [{ type: "message", content: [{ type: "output_text", text: "not JSON" }] }] })]);
    expect((await s.gateway.callStructured(request)).kind).toBe("failed");
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
  });
  it("incomplete is billed and never retried into a success", async () => {
    const s = setup([wire({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] })]);
    expect((await s.gateway.callStructured(request)).kind).toBe("incomplete");
    expect(s.bodies).toHaveLength(1);
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
  });
  it("content rejection and its retry each remain charged", async () => {
    const s = setup([wire(), wire({ id: "gen-synthetic-2" })]);
    const result = await callStructuredChecked(s.gateway, { request, check: () => ({ ok: false, problems: [{ field: "value", message: "synthetic rejection" }] }) });
    expect(result.ok).toBe(false);
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.002);
    expect(s.budget.providerBilling?.attempts).toHaveLength(2);
  });
  it("deduplicates generation ID once, retains duplicate reservation and invalidates the arm", async () => {
    const s = setup([wire()]);
    await s.gateway.callStructured(request); await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.actual_cost_usd).toBeNull();
    expect(s.budget.providerBilling?.observed_cost_subtotal_usd).toBe(.001);
    expect(s.budget.providerBilling?.attempts[1]?.duplicate).toBe(true);
    expect(s.budget.reservedUsd).toBeGreaterThan(0);
    expect(s.budget.providerBilling?.comparison_valid).toBe(false);
  });
  it.each([
    { input_tokens_details: { cached_tokens: 90, cache_write_tokens: 20 } },
    { output_tokens_details: { reasoning_tokens: 21 } }, { input_tokens: -1 },
  ])("invalid token accounting retains reservation even when cost is known: %j", async (changed) => {
    const s = setup([wire({ usage: { ...usage, ...changed } })]);
    await s.gateway.callStructured(request);
    expect(s.budget.providerBilling?.actual_cost_usd).toBe(.001);
    expect(s.budget.reservedUsd).toBeGreaterThan(0);
    expect(s.budget.providerBilling?.attempts[0]?.guard_settled).toBe(false);
  });
  it("timeout without a receipt is unknown; a late paid response never releases its reservation", async () => {
    let complete!: (r: Response) => void;
    const client = createOpenRouterLlmClient({ apiKey: "fake-test-only", model, fetch: async () => new Promise<Response>((resolve) => { complete = resolve; }) });
    const budget = new JobBudget(1);
    const gateway = new CallGateway({ client, budget, rates: pin.rates, now: () => 0, deadline: 1000, callTimeoutMs: 5, maxAttempts: 1 });
    expect((await gateway.callStructured(request)).kind).toBe("failed");
    const reserved = budget.reservedUsd;
    expect(budget.providerBilling?.unknown_attempts).toBe(1);
    complete(new Response(JSON.stringify(wire())));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(budget.providerBilling?.actual_cost_usd).toBe(.001);
    expect(budget.providerBilling?.attempts[0]?.state).toBe("late");
    expect(budget.reservedUsd).toBe(reserved);
  });
  it("separates OpenRouter judge charges and never releases an unknown judge reservation", async () => {
    for (const cost of [.001, undefined]) {
      const s = setup([wire({ usage: { ...usage, cost }, output: [{ type: "message", content: [{ type: "output_text", text: '{"answers":{}}' }] }] })]);
      const judge = createBudgetedJudge({ judge: createLlmJudge({ client: s.client, model }), budget: s.budget, rates: pin.rates });
      await judge.judge({ state: { label: "synthetic" }, questions: {} });
      expect(s.budget.providerBilling?.actual_generation_cost_usd).toBe(0);
      expect(s.budget.providerBilling?.actual_judge_cost_usd).toBe(cost ?? null);
      if (cost === undefined) expect(s.budget.reservedUsd).toBeGreaterThan(0);
    }
  });
});
