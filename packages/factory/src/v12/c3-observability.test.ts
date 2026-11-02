import { describe, expect, it } from "vitest";
import { JobBudget } from "../budget.js";
import { CallGateway } from "../call.js";
import { OpenAiAdapterError, OpenAiIncompleteError } from "../openai.js";
import { noteProviderBilling, providerBillingReceipt } from "../provider-billing.js";
import { openRouterArmPin } from "../openrouter-arm.js";
import { fixtureList, fixtureTable, planOf, withCodeIds, FIXTURE_DOCUMENTS } from "../v11a/__tests__/fixtures.js";
import { runSemanticCheck } from "../v11a/stages/semantic-check.js";
import { C3Observability } from "./c3-observability.js";
import type { LlmClient, LlmStructuredRequest } from "../llm.js";
import { callDiagnosticDetail, incompleteReason, responseStatus } from "../call-diagnostics.js";
import { createOpenRouterLlmClient } from "../openrouter.js";

const pin = openRouterArmPin("open-inference/fp4", "z-ai/glm-5.3-flash");
const usage = { inputTokens: 20, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 2 };
const list = { ...fixtureList(), requirements: Array.from({ length: 11 }, (_, i) => ({ ...fixtureList().requirements[0]!, id: "Q" + (i + 1) })) };
const table = withCodeIds(fixtureTable());
const targets = (r: LlmStructuredRequest): string[] => (JSON.parse(r.input.split('<data name="要件の文と引用">\n')[1]!.split("\n</data>")[0]!) as { requirementId: string }[]).map((x) => x.requirementId);
async function scenario(observe: boolean) {
  const budget = new JobBudget(10), trace = new C3Observability(), requests: string[] = [], counts = new Map<string, number>();
  const client: LlmClient = {
    billingPin: pin,
    async callStructured<T>(request: LlmStructuredRequest) {
      const ids = targets(request), first = ids[0]!; const attempt = (counts.get(first) ?? 0) + 1; counts.set(first, attempt);
      const { signal: _signal, ...body } = request; requests.push(JSON.stringify(body));
      const wire = first === "Q6" ? { error: { message: "SECRET error body" } } : { id: "gen-" + first + "-" + attempt, model: pin.model, usage: { input_tokens: 20, output_tokens: 10, cost: .001 } };
      noteProviderBilling(request.signal, providerBillingReceipt(wire, pin));
      if (first === "Q6") throw new OpenAiAdapterError("http", "SECRET error body", 429);
      if (first === "Q1" && attempt === 2) throw new OpenAiIncompleteError("max_output_tokens", usage, "SECRET incomplete body", "incomplete");
      const output = { judgments: ids.map((requirementId) => ({ requirementId, verdict: "accept", kind: first === "Q1" ? "unnecessary-ownership" : null, quote: null })) };
      return { output: output as T, usage };
    },
    async callWithTools() { throw Error("not reached"); },
  };
  const gateway = new CallGateway({ client, budget, rates: pin.rates, now: () => 0, deadline: 60_000, effort: "low" });
  const result = await runSemanticCheck({ plan: planOf(list), list, table, documents: FIXTURE_DOCUMENTS, gateway, ids: true, ...(observe ? { observability: trace } : {}) });
  return { result, requests, counter: gateway.counts, budget: budget.providerBilling, trace: await trace.files() };
}
describe("C3 observation does not control execution", () => {
  it("off/on requests, outcome, retries, counters and exact billing snapshot remain identical", async () => {
    const off = await scenario(false), on = await scenario(true);
    expect(on.requests).toEqual(off.requests); expect(on.result).toEqual(off.result);
    expect(on.counter).toEqual(off.counter); expect(on.budget).toEqual(off.budget);
    expect(on.result).toMatchObject({ ok: false, failure: { kind: "incomplete", reason: "max_output_tokens", responseStatus: "incomplete" } });
    expect(on.counter.retries.shape).toBe(1); expect(off.trace).toEqual([]);
  });
  it("records all bundles including the nonselected HTTP error, ledger attempts and shape digest", async () => {
    const on = await scenario(true), text = on.trace[0]!.text, file = JSON.parse(text);
    expect(file.bundles).toHaveLength(3);
    expect(file.bundles.map((b: { terminal: string }) => b.terminal)).toEqual(["incomplete", "http", "ok"]);
    expect(file.bundles[0]).toMatchObject({ round: 1, bundle: 0, incomplete_reason: "max_output_tokens", response_status: "incomplete" });
    expect(file.bundles[0].rejections[0].candidate_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.bundles[0].rejections[0].problems[0]).toEqual({ field: "judgments[0]", message: "受理の判定の種類と引用は null であること" });
    expect(file.bundles[1].attempts[0]).toMatchObject({ error_kind: "http", http_status: 429 });
    const attempts = file.bundles.flatMap((b: { attempts: { ledger_attempt: number }[] }) => b.attempts);
    expect(attempts.map((a: { ledger_attempt: number }) => a.ledger_attempt).toSorted()).toEqual([1, 2, 3, 4]);
    expect(text).not.toContain("SECRET"); expect(text).not.toContain("authorization");
  });
  it("only whitelisted status/reason and numeric HTTP status survive", () => {
    expect(incompleteReason("arbitrary SECRET")).toBe("unknown"); expect(responseStatus("arbitrary SECRET")).toBe("unknown");
    expect(callDiagnosticDetail({ status: "SECRET", reason: "SECRET" }, { kind: "incomplete", usage: undefined })).toEqual({ incomplete_reason: "unknown", response_status: "unknown" });
    expect(callDiagnosticDetail({ status: 500, message: "SECRET" }, { kind: "error", errorKind: "http" })).toEqual({ http_status: 500 });
  });
  it("ledger-less clients record null and throwing/mutating additional observers cannot affect results", async () => {
    const plain: LlmClient = { callStructured: async <T>() => ({ output: { ok: true } as T, usage }), callWithTools: async () => { throw Error("unused"); } };
    const budget = new JobBudget(1), gateway = new CallGateway({ client: plain, budget, rates: pin.rates, now: () => 0, deadline: 60_000 });
    const request = { instructions: "", documents: [], input: "", schemaName: "fake", schema: { type: "object" }, maxOutputTokens: 10 };
    const result = await gateway.withObserver({ beginAttempt: () => { throw Error("observer only"); } }).callStructured(request);
    expect(result.kind).toBe("ok");
    let ledger: number | null | undefined;
    await gateway.withObserver({ beginAttempt: () => ({ ledger: (id) => { ledger = id; }, settle: (end) => { if (end.kind === "response" && end.usage) (end.usage as { inputTokens: number }).inputTokens = 0; }, late: () => {} }) }).callStructured(request);
    expect(ledger).toBeNull(); expect(usage.inputTokens).toBe(20); expect(gateway.calls).toBe(2);
  });
  it("captures timeout, communication retry and late delivery without reassigning a ledger id", async () => {
    const trace = new C3Observability(), row = trace.bundle(1, 0, 1); let calls = 0;
    const client: LlmClient = { callStructured: async <T>() => { calls++; if (calls === 1) await new Promise((r) => setTimeout(r, 15)); return { output: {} as T, usage }; }, callWithTools: async () => { throw Error("unused"); } };
    const gateway = new CallGateway({ client, budget: new JobBudget(1), rates: pin.rates, now: () => 0, deadline: 1000, callTimeoutMs: 5 }).withObserver(row.observer);
    const result = await gateway.callStructured({ instructions: "", documents: [], input: "", schemaName: "fake", schema: {}, maxOutputTokens: 10 });
    expect(result.kind).toBe("ok"); await new Promise((r) => setTimeout(r, 20)); row.finish();
    const file = JSON.parse((await trace.files())[0]!.text);
    expect(file.bundles[0].attempts.map((a: { terminal: string }) => a.terminal)).toEqual(["timeout", "response"]);
    expect(file.bundles[0].attempts[0]).toMatchObject({ ledger_attempt: null, late_responses: 1 });
    expect(gateway.counts.retries.communication).toBe(1);
  });
  it("empty trace emits no artifact and non-JSON candidates do not break control", async () => {
    const trace = new C3Observability(); expect(await trace.files()).toEqual([]);
    const row = trace.bundle(1, 0, 0), cycle: Record<string, unknown> = {}; cycle["self"] = cycle;
    row.reject(1, cycle, [{ field: "", message: "fixed" }]); row.finish();
    expect(JSON.parse((await trace.files())[0]!.text).bundles[0].rejections[0].candidate_sha256).toBeNull();
  });
  it("wire status and incomplete_details reach the safe diagnostic without provider error text", async () => {
    const trace = new C3Observability(), row = trace.bundle(1, 0, 1);
    const client = createOpenRouterLlmClient({ apiKey: "fake", arm: "open-inference/fp4", fetch: async () => new Response(JSON.stringify({
      id: "gen-fake", model: pin.model, status: "failed", incomplete_details: { reason: "content_filter" }, error: { message: "SECRET body" },
      usage: { input_tokens: 20, output_tokens: 10, cost: .001 }, output: [],
    })) });
    const gateway = new CallGateway({ client, budget: new JobBudget(1), rates: pin.rates, now: () => 0, deadline: 60_000 }).withObserver(row.observer);
    const result = await gateway.callStructured({ instructions: "", documents: [], input: "", schemaName: "fake", schema: { type: "object" }, maxOutputTokens: 10 });
    expect(result).toMatchObject({ kind: "incomplete", reason: "content_filter", responseStatus: "failed" });
    row.finish({ kind: "incomplete", reason: "content_filter", responseStatus: "failed" });
    const text = (await trace.files())[0]!.text;
    expect(JSON.parse(text).bundles[0].attempts[0]).toMatchObject({ ledger_attempt: 1, http_status: 200, incomplete_reason: "content_filter", response_status: "failed" });
    expect(text).not.toContain("SECRET");
  });
  it("a budget refusal remains unstarted, with a bundle terminal and no invented ledger id", async () => {
    const trace = new C3Observability(), row = trace.bundle(1, 0, 1); let calls = 0;
    const client: LlmClient = { callStructured: async <T>() => { calls++; return { output: {} as T, usage }; }, callWithTools: async () => { throw Error("unused"); } };
    const gateway = new CallGateway({ client, budget: new JobBudget(0), rates: pin.rates, now: () => 0, deadline: 60_000 }).withObserver(row.observer);
    const result = await gateway.callStructured({ instructions: "", documents: [], input: "", schemaName: "fake", schema: {}, maxOutputTokens: 10 });
    expect(result.kind).toBe("budgetExceeded"); expect(calls).toBe(0);
    row.finish({ kind: "budget", maxCostUsd: 1, remainingUsd: 0 });
    expect(JSON.parse((await trace.files())[0]!.text).bundles[0]).toMatchObject({ terminal: "budget", attempts: [] });
  });
});
