import type { ProviderBillingSummary } from "./provider-billing.js";

export const IDENTITY_COMPARISON_POLICY = "returned-confirmed+timeout-only/v1";
/** Stage evidence may survive a receipt-less client timeout; invoice completeness may not. */
export function assessProviderComparison(snapshot: ProviderBillingSummary): ProviderBillingSummary {
  const returned = snapshot.attempts.filter((a) => a.receipt !== null);
  const unknown = snapshot.attempts.filter((a) => a.receipt === null);
  const timeoutsOnly = unknown.every((a) => a.state === "closed-unknown" && a.failure_kind === "timeout"
    && Number.isFinite(a.reserved_usd) && a.reserved_usd >= 0);
  const reasons = snapshot.invalid_reasons.filter((r) => !(r === "billing-unconfirmed" && unknown.length > 0 && timeoutsOnly));
  const identityValid = returned.length > 0 && snapshot.pins.length === 1 && reasons.length === 0 && timeoutsOnly
    && snapshot.budget_reached !== true && returned.every((a) => !a.duplicate && a.receipt!.generation_id !== null
      && a.receipt!.cost_status === "known" && a.receipt!.cost_usd !== null && a.receipt!.usage !== null
      && a.receipt!.identity_reasons.length === 0 && a.receipt!.identity_evidence?.confirmation_state === "confirmed");
  const lower = snapshot.observed_cost_subtotal_usd;
  const upper = snapshot.actual_cost_complete ? snapshot.actual_cost_usd
    : timeoutsOnly && unknown.length > 0 && returned.every((a) => a.receipt!.generation_id !== null && a.receipt!.cost_usd !== null)
      ? lower + unknown.reduce((sum, a) => sum + a.reserved_usd, 0) : null;
  return { ...snapshot, comparison_policy: IDENTITY_COMPARISON_POLICY, identity_valid: identityValid,
    cost_range_usd: { lower, upper, basis: "observed-plus-timeout-reservations" } };
}
