import test from "node:test";
import assert from "node:assert/strict";
import { billingRecordOf, sameArmPin } from "./openrouter-measurement.mjs";

test("arm identity includes provider, quantization, model and dated rates for resume", () => {
  const pin = { arm: "morph/fp8", model: "synthetic", quantization: "fp8", rates: { input: 1 }, at: "2026-11-01" };
  assert.equal(sameArmPin(pin, { ...pin }), true);
  for (const altered of [{ arm: "open-inference/fp4" }, { quantization: "fp4" }, { model: "other" }, { rates: { input: 2 } }, { at: "later" }]) {
    assert.equal(sameArmPin(pin, { ...pin, ...altered }), false);
  }
  assert.equal(sameArmPin(null, undefined), true);
});

test("missing billing is unknown, never zero or a valid arm", () => {
  const result = billingRecordOf({ arm: "morph/fp8" }, null);
  assert.equal(result.comparison_valid, false);
  assert.equal(result.actual_cost_usd, null);
});

test("valid zero cost and explicit invalid/mismatched arms stay distinct", () => {
  const pin = { arm: "morph/fp8" };
  const ledger = { schema: "factory/provider-billing/v1", pins: [pin], comparison_valid: true,
    actual_cost_complete: true, actual_cost_usd: 0, observed_cost_subtotal_usd: 0, actual_generation_cost_usd: 0, actual_judge_cost_usd: 0,
    token_estimate_usd: 1, unsettled_reservations_usd: 0, guard_spent_usd: 1, unknown_attempts: 0, attempts: [] };
  assert.equal(billingRecordOf(pin, ledger).comparison_valid, true);
  assert.equal(billingRecordOf(pin, { ...ledger, comparison_valid: false }).comparison_valid, false);
  assert.equal(billingRecordOf({ arm: "open-inference/fp4" }, ledger).comparison_valid, false);
  assert.equal(billingRecordOf(pin, { ...ledger, actual_cost_usd: -1 }).actual_cost_usd, null);
});
