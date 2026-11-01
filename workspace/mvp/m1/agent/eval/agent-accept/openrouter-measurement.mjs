import { pinnedModelMatches } from "../../../../../../packages/factory/dist/provider-model.js";
import { assessProviderComparison } from "../../../../../../packages/factory/dist/provider-comparison.js";
// Metadata only. This module does not load subjects, keys, or launch generation.
const amount = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const canonical = (x) => x === undefined || x === null ? null : Array.isArray(x) ? x.map(canonical)
  : typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])])) : x;
export const sameArmPin = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function identityShape(pin, receipt) {
  const e = receipt.identity_evidence;
  return e && e.policy === pin.identity_policy && e.generation_id === receipt.generation_id && e.confirmation_state === "confirmed" && Array.isArray(e.reasons) && e.reasons.length === 0
    && ["response", "generation", "exclusive-endpoint"].includes(e.quantization_basis)
    && pin.provider_aliases?.includes(e.router_provider ?? e.lookup_provider ?? receipt.returned_provider)
    && pinnedModelMatches(pin, e.router_model ?? e.lookup_model ?? receipt.returned_model)
    && (receipt.returned_provider == null || pin.provider_aliases.includes(receipt.returned_provider))
    && pinnedModelMatches(pin, receipt.returned_model)
    && (receipt.returned_quantization == null || receipt.returned_quantization === pin.quantization)
    && (e.lookup_quantization == null || e.lookup_quantization === pin.quantization);
}
export function billingRecordOf(pin, ledger) {
  const validShape = ledger?.schema === "factory/provider-billing/v1" && Array.isArray(ledger.pins)
    && ledger.pins.length === 1 && sameArmPin(ledger.pins[0], pin)
    && ["observed_cost_subtotal_usd", "token_estimate_usd", "unsettled_reservations_usd", "guard_spent_usd"].every((k) => amount(ledger[k]))
    && ["actual_cost_usd", "actual_generation_cost_usd", "actual_judge_cost_usd"].every((k) => ledger[k] === null || amount(ledger[k]))
    && (ledger.actual_cost_complete !== true || amount(ledger.actual_cost_usd))
    && (ledger.budget_limit_usd === undefined || amount(ledger.budget_limit_usd))
    && (ledger.budget_reached === undefined || typeof ledger.budget_reached === "boolean")
    && Array.isArray(ledger.attempts) && (ledger.actual_cost_complete !== true || ledger.attempts.every((a) => a?.receipt != null) && ledger.unknown_attempts === 0) && Number.isInteger(ledger.unknown_attempts) && ledger.unknown_attempts >= 0;
  let assessed = null;
  try {
    if (validShape && Array.isArray(ledger.invalid_reasons) && ledger.attempts.every((a) => a && typeof a === "object" && typeof a.duplicate === "boolean" && sameArmPin(a.pin, pin)
      && amount(a.reserved_usd) && (a.receipt === null || (a.receipt && typeof a.receipt.generation_id === "string" && a.receipt.generation_id.trim() !== "" && amount(a.receipt.cost_usd) && identityShape(pin, a.receipt)
        && Array.isArray(a.receipt.identity_reasons) && a.receipt.usage && ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"].every((k) => amount(a.receipt.usage[k]))
        && a.receipt.usage.cachedInputTokens <= a.receipt.usage.inputTokens && a.receipt.usage.reasoningTokens <= a.receipt.usage.outputTokens)))) assessed = assessProviderComparison({ ...ledger, budget_reached: ledger.budget_reached === true || (amount(ledger.budget_limit_usd) && ledger.budget_limit_usd - ledger.unsettled_reservations_usd - ledger.guard_spent_usd <= 0) });
  } catch { assessed = null; }
  const identityValid = assessed?.identity_valid === true;
  return {
    schema: "factory/openrouter-measurement/v1",
    comparison_valid: validShape && identityValid && ledger.comparison_valid === true && ledger.actual_cost_complete === true,
    identity_valid: identityValid,
    comparison_policy: "returned-confirmed+timeout-only/v1",
    cost_range_usd: assessed?.cost_range_usd ?? { lower: validShape ? ledger.observed_cost_subtotal_usd : 0, upper: null },
    reason: !validShape ? "billing-or-arm-unconfirmed" : !identityValid ? "identity-invalid-or-unconfirmed" : ledger.comparison_valid !== true ? "attempts-invalid-or-unconfirmed" : ledger.actual_cost_complete !== true ? "billing-incomplete" : null,
    actual_cost_complete: validShape && ledger.actual_cost_complete === true,
    actual_cost_usd: validShape ? ledger.actual_cost_usd : null,
    observed_cost_subtotal_usd: validShape ? ledger.observed_cost_subtotal_usd : 0,
    actual_generation_cost_usd: validShape ? ledger.actual_generation_cost_usd : null,
    actual_judge_cost_usd: validShape ? ledger.actual_judge_cost_usd : null,
    token_estimate_usd: validShape ? ledger.token_estimate_usd : null,
    unsettled_reservations_usd: validShape ? ledger.unsettled_reservations_usd : null,
    guard_spent_usd: validShape ? ledger.guard_spent_usd : null,
    unknown_attempts: validShape ? ledger.unknown_attempts : null,
    metadata_record: "bundle/provider-billing.json",
  };
}
