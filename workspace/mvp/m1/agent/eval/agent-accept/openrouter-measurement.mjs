// Metadata only. This module does not load subjects, keys, or launch generation.
const amount = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const canonical = (x) => x === undefined || x === null ? null : Array.isArray(x) ? x.map(canonical)
  : typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canonical(x[k])])) : x;
export const sameArmPin = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function billingRecordOf(pin, ledger) {
  const validShape = ledger?.schema === "factory/provider-billing/v1" && Array.isArray(ledger.pins)
    && ledger.pins.length === 1 && sameArmPin(ledger.pins[0], pin)
    && ["observed_cost_subtotal_usd", "token_estimate_usd", "unsettled_reservations_usd", "guard_spent_usd"].every((k) => amount(ledger[k]))
    && ["actual_cost_usd", "actual_generation_cost_usd", "actual_judge_cost_usd"].every((k) => ledger[k] === null || amount(ledger[k]))
    && (ledger.actual_cost_complete !== true || amount(ledger.actual_cost_usd))
    && Array.isArray(ledger.attempts) && Number.isInteger(ledger.unknown_attempts) && ledger.unknown_attempts >= 0;
  return {
    schema: "factory/openrouter-measurement/v1",
    comparison_valid: validShape && ledger.comparison_valid === true && ledger.actual_cost_complete === true,
    reason: !validShape ? "billing-or-arm-unconfirmed" : ledger.comparison_valid !== true ? "attempts-invalid-or-unconfirmed" : ledger.actual_cost_complete !== true ? "billing-incomplete" : null,
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
