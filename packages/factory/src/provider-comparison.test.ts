import { describe, expect, it } from "vitest";
import { JobBudget } from "./budget.js";
import { openRouterArmPin } from "./openrouter-arm.js";
import { providerBillingReceipt, noteProviderBilling, type ProviderBillingSummary } from "./provider-billing.js";
import { responseIdentity } from "./openrouter-identity.js";
import { projectConfirmation } from "./openrouter-deferred.js";
import { assessProviderComparison } from "./provider-comparison.js";
const pin = openRouterArmPin("open-inference/fp4", "synthetic/model");
const route = { only: [pin.arm], allow_fallbacks: false, require_parameters: true };
function setup(extra: Record<string, unknown> = {}, timeoutKind = "timeout", knownHold = false) {
  const budget = new JobBudget(1);
  const reserve = budget.reserve(.1); if (!reserve.reserved) throw new Error("fixture");
  const a = budget.providerAttempt(pin, reserve.reservation, pin.rates, "generation");
  const c = new AbortController(); a.bind(c.signal);
  const wire = { id: "gen-synthetic", model: pin.model, usage: { input_tokens: 10, output_tokens: 10, cost: .01 },
    openrouter_metadata: { requested: pin.model, endpoints: { available: [{ provider: "OpenInference", model: pin.model, selected: true }] } }, ...extra };
  const receipt = providerBillingReceipt(wire, pin);
  const ev = responseIdentity(wire, receipt, pin, route);
  noteProviderBilling(c.signal, { ...receipt, identity_evidence: ev, identity_reasons: ev.reasons });
  a.close(!knownHold);
  const unknown = budget.reserve(.2); if (!unknown.reserved) throw new Error("fixture");
  budget.providerAttempt(pin, unknown.reservation, pin.rates, "generation").close(false, timeoutKind);
  return budget;
}
describe("stage identity vs invoice (S-175z addendum)", () => {
  it("timeout-only unknown preserves cost null/reservations; identity confirmed and range excludes known held reservation", () => {
    const budget = setup({}, "timeout", true), before = budget.providerBilling!;
    const after = projectConfirmation(before, new Map(), true);
    expect(after.identity_valid).toBe(true); expect(after.comparison_valid).toBe(false);
    expect(after.actual_cost_complete).toBe(false); expect(after.actual_cost_usd).toBeNull();
    expect(after.cost_range_usd).toMatchObject({ lower: .01, upper: .01 + .2 });
    expect(after.unsettled_reservations_usd).toBeCloseTo(.3);
    expect(after.guard_spent_usd).toBe(before.guard_spent_usd);
    expect(after.identity_confirmation!.state).toBe("confirmed");
    expect(after.invalid_reasons).toContain("billing-unconfirmed");
  });
  it.each(["network", "deadline", "missing-receipt", "http"])("non-timeout unknown remains invalid: %s", (kind) => {
    const s = setup({}, kind).providerBilling!;
    expect(s.identity_valid).toBe(false); expect(s.cost_range_usd!.upper).toBeNull();
  });
  it.each([{ model: "other/model" }, { usage: { cost: .01 } }, { usage: { input_tokens: 1, output_tokens: 1 } }, { id: null }])("returned contradiction or missing tokens/cost/id invalid: %j", (extra) => {
    expect(setup(extra).providerBilling!.identity_valid).toBe(false);
  });
  it("all-timeout is not evidence; empty ledger and duplicate cannot pass", () => {
    const b = new JobBudget(1); const r = b.reserve(.2); if (!r.reserved) throw new Error("fixture");
    b.providerAttempt(pin, r.reservation, pin.rates, "generation").close(false, "timeout");
    expect(b.providerBilling!.identity_valid).toBe(false);
    const s = setup().providerBilling!;
    expect(assessProviderComparison({ ...s, attempts: s.attempts.map((a) => ({ ...a, duplicate: true })) }).identity_valid).toBe(false);
  });
  it("budget refusal invalidates stage evidence without releasing reserves or changing invoices", () => {
    const b = setup(); const before = b.providerBilling!;
    expect(before.identity_valid).toBe(true); expect(b.reserve(2).reserved).toBe(false);
    const after = b.providerBilling!;
    expect(after.identity_valid).toBe(false); expect(after.budget_reached).toBe(true);
    expect(after.invalid_reasons).toContain("budget-reached");
    expect(after.unsettled_reservations_usd).toBe(before.unsettled_reservations_usd);
    expect(after.actual_cost_usd).toBeNull();
  });
  it("legacy metadata without identity evidence cannot be upgraded by absence of reasons", () => {
    const s = setup().providerBilling!;
    const attempts = s.attempts.map((a) => a.receipt ? { ...a, receipt: { ...a.receipt, identity_evidence: undefined } } : a);
    expect(assessProviderComparison({ ...s, attempts } as ProviderBillingSummary).identity_valid).toBe(false);
  });
});
