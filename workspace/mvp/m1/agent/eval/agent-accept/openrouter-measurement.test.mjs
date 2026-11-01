import test from "node:test";
import assert from "node:assert/strict";
import { billingRecordOf, sameArmPin } from "./openrouter-measurement.mjs";
import { openRouterArmPin } from "../../../../../../packages/factory/dist/openrouter-arm.js";
const pin=openRouterArmPin("open-inference/fp4","synthetic/model");
function ledger(timeout=false){
 const receipt={generation_id:"gen-synthetic",returned_provider:null,returned_model:pin.model,returned_quantization:null,
  cost_status:"known",cost_usd:0,usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningTokens:0},identity_reasons:[],
  identity_evidence:{policy:pin.identity_policy,generation_id:"gen-synthetic",confirmation_state:"confirmed",reasons:[],router_provider:"OpenInference",router_model:pin.model,quantization_basis:"exclusive-endpoint"}};
 return {schema:"factory/provider-billing/v1",pins:[pin],comparison_valid:!timeout,invalid_reasons:timeout?["billing-unconfirmed"]:[],budget_limit_usd:2,budget_reached:false,
  actual_cost_complete:!timeout,actual_cost_usd:timeout?null:0,observed_cost_subtotal_usd:0,actual_generation_cost_usd:timeout?null:0,actual_judge_cost_usd:0,
  token_estimate_usd:1,unsettled_reservations_usd:timeout?.2:0,guard_spent_usd:1,unknown_attempts:timeout?1:0,
  attempts:[{attempt:1,pin,purpose:"generation",reserved_usd:.1,state:"returned",duplicate:false,receipt},
   ...(timeout?[{attempt:2,pin,purpose:"generation",reserved_usd:.2,state:"closed-unknown",failure_kind:"timeout",duplicate:false,receipt:null}]:[])]};
}
test("arm identity includes provider, quantization, model and dated rates for resume",()=>{
 assert.equal(sameArmPin(pin,{...pin}),true);
 for(const changed of [{arm:"morph/fp8"},{quantization:"fp8"},{model:"other"},{rates:{input:2}},{pricing_observed_at:"later"}])assert.equal(sameArmPin(pin,{...pin,...changed}),false);
 assert.equal(sameArmPin(null,undefined),true);
});
test("missing billing is unknown, never zero or a valid arm",()=>{
 const r=billingRecordOf(pin,null);assert.equal(r.identity_valid,false);assert.equal(r.comparison_valid,false);assert.equal(r.actual_cost_usd,null);
});
test("confirmed zero cost is valid; explicit invalid, mismatched and negative accounts remain distinct",()=>{
 const l=ledger();assert.equal(billingRecordOf(pin,l).comparison_valid,true);assert.equal(billingRecordOf(pin,l).identity_valid,true);
 assert.equal(billingRecordOf(pin,{...l,comparison_valid:false}).comparison_valid,false);
 assert.equal(billingRecordOf({...pin,arm:"morph/fp8"},l).identity_valid,false);
 assert.equal(billingRecordOf(pin,{...l,actual_cost_usd:-1}).actual_cost_usd,null);
});
test("S-175ac timeout only preserves incomplete cost/range, while known-held reservation is not double-counted",()=>{
 const l=ledger(true),before=JSON.stringify(l),r=billingRecordOf(pin,l);
 assert.equal(r.identity_valid,true);assert.equal(r.comparison_valid,false);assert.equal(r.actual_cost_usd,null);assert.equal(r.actual_cost_complete,false);
 assert.deepEqual(r.cost_range_usd,{lower:0,upper:.2,basis:"observed-plus-timeout-reservations"});assert.equal(r.unsettled_reservations_usd,.2);assert.equal(r.guard_spent_usd,1);assert.equal(JSON.stringify(l),before);
});
test("S-175ac network/deadline/all-unknown fail; no metadata/usage/provider/model/budget bypass",()=>{
 for(const kind of ["network","deadline","http"]){const l=ledger(true);l.attempts[1].failure_kind=kind;assert.equal(billingRecordOf(pin,l).identity_valid,false);}
 const all=ledger(true);all.attempts=all.attempts.slice(1);assert.equal(billingRecordOf(pin,all).identity_valid,false);
 for(const change of [r=>{delete r.identity_evidence;},r=>{r.usage=null;},r=>{r.usage.outputTokens=-1;},r=>{r.identity_evidence.router_provider="Other";},r=>{r.returned_model="other/model";},r=>{r.identity_evidence.generation_id="other";}]){
  const l=ledger();change(l.attempts[0].receipt);const r=billingRecordOf(pin,l);assert.equal(r.identity_valid,false);assert.equal(r.comparison_valid,false);assert.ok(r.reason);
 }
 const budget=ledger();budget.budget_reached=true;assert.equal(billingRecordOf(pin,budget).identity_valid,false);
 const reached=ledger();reached.budget_limit_usd=1;assert.equal(billingRecordOf(pin,reached).identity_valid,false);
});
test("S-175ac duplicate/mixed pin fail and forged identity bool/range do not override raw evidence",()=>{
 const l=ledger(true);l.attempts[0].duplicate=true;l.identity_valid=true;l.cost_range_usd={lower:0,upper:0};assert.equal(billingRecordOf(pin,l).identity_valid,false);
 const mixed=ledger();mixed.attempts[0].pin={...pin,model:"other"};assert.equal(billingRecordOf(pin,mixed).identity_valid,false);
});
