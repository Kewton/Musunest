// Request-bound accounting, independent of native output validation (S-175v).
// Unknown/late/duplicate receipts never release a reservation. No response body is retained.
import type { TokenRates } from "./budget.js";
import type { LlmUsage } from "./llm.js";

export interface ProviderBillingPin {
  readonly arm: string;
  readonly provider_aliases: readonly string[];
  readonly quantization: string;
  readonly model: string;
  readonly rates: TokenRates;
  readonly pricing_source: string;
  readonly pricing_observed_at: string;
}

export interface ProviderBillingReceipt {
  readonly generation_id: string | null;
  readonly returned_provider: string | null;
  readonly returned_model: string | null;
  readonly returned_quantization: string | null;
  readonly identity_reasons: readonly string[];
  readonly cost_status: "known" | "missing" | "invalid";
  readonly cost_usd: number | null;
  readonly is_byok: boolean | null;
  readonly cost_details: Readonly<Record<string, number | null>> | null;
  readonly usage: LlmUsage | null;
}

export interface ProviderBillingAttempt {
  readonly attempt: number;
  readonly purpose: "generation" | "judge";
  readonly pin: ProviderBillingPin;
  readonly reserved_usd: number;
  state: "pending" | "returned" | "late";
  duplicate: boolean;
  receipt: ProviderBillingReceipt | null;
  token_estimate_usd: number | null;
  guard_settled: boolean;
}

export interface ProviderBillingSummary {
  readonly schema: "factory/provider-billing/v1";
  readonly pins: readonly ProviderBillingPin[];
  readonly comparison_valid: boolean;
  readonly invalid_reasons: readonly string[];
  readonly actual_cost_usd: number | null;
  readonly observed_cost_subtotal_usd: number;
  readonly observed_generation_cost_subtotal_usd: number;
  readonly observed_judge_cost_subtotal_usd: number;
  readonly actual_generation_cost_usd: number | null;
  readonly actual_judge_cost_usd: number | null;
  readonly actual_cost_complete: boolean;
  readonly token_estimate_usd: number;
  readonly unsettled_reservations_usd: number;
  readonly guard_spent_usd: number;
  readonly unknown_attempts: number;
  readonly attempts: readonly ProviderBillingAttempt[];
}

const hooks = new WeakMap<AbortSignal, (receipt: ProviderBillingReceipt) => void>();
export function bindProviderBilling(signal: AbortSignal, note: (receipt: ProviderBillingReceipt) => void): void {
  hooks.set(signal, note);
}
export function noteProviderBilling(signal: AbortSignal | undefined, receipt: ProviderBillingReceipt): void {
  if (signal !== undefined) hooks.get(signal)?.(receipt);
}

/** Strictly validate numbers; don't turn absent/invalid billed cost into zero. */
export function providerBillingReceipt(wire: unknown, pin: ProviderBillingPin): ProviderBillingReceipt {
  const record = object(wire);
  const usage = object(record?.usage);
  const provider = identifier(record?.provider);
  const model = identifier(record?.model);
  const quantization = identifier(record?.quantization ?? record?.provider_quantization);
  const id = identifier(record?.id);
  const identity: string[] = [];
  if (provider === null) identity.push("provider-unconfirmed");
  else if (!pin.provider_aliases.includes(provider)) identity.push("provider-mismatch");
  if (model === null) identity.push("model-unconfirmed");
  else if (model !== pin.model) identity.push("model-mismatch");
  if (quantization === null) identity.push("quantization-unconfirmed");
  else if (quantization !== pin.quantization) identity.push("quantization-mismatch");
  if (id === null) identity.push("generation-id-unconfirmed");
  const details = object(usage?.cost_details);
  const copied: Record<string, number | null> = {};
  let invalid = usage?.cost !== undefined && !amount(usage.cost);
  if (usage?.is_byok !== undefined && typeof usage.is_byok !== "boolean") invalid = true;
  if (usage?.cost_details !== undefined && usage.cost_details !== null && details === null) invalid = true;
  if (details !== null) {
    for (const key of ["upstream_inference_cost", "upstream_inference_input_cost", "upstream_inference_output_cost", "upstream_inference_prompt_cost", "upstream_inference_completions_cost"]) {
      const value = details[key];
      if (value === undefined) continue;
      if (value === null || amount(value)) copied[key] = value;
      else invalid = true;
    }
  }
  return {
    generation_id: id,
    returned_provider: provider,
    returned_model: model,
    returned_quantization: quantization,
    identity_reasons: identity,
    cost_status: invalid ? "invalid" : amount(usage?.cost) ? "known" : "missing",
    cost_usd: !invalid && amount(usage?.cost) ? usage.cost : null,
    is_byok: typeof usage?.is_byok === "boolean" ? usage.is_byok : null,
    cost_details: details === null ? null : copied,
    usage: tokenUsage(usage),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(value)
    && !/^(sk-|Bearer )/i.test(value) ? value : null;
}
function tokenUsage(usage: Record<string, unknown> | null): LlmUsage | null {
  const count = (v: unknown): v is number => amount(v) && Number.isInteger(v);
  const input = usage?.input_tokens, output = usage?.output_tokens;
  const inputDetails = object(usage?.input_tokens_details), outputDetails = object(usage?.output_tokens_details);
  if (usage?.input_tokens_details !== undefined && inputDetails === null) return null;
  if (usage?.output_tokens_details !== undefined && outputDetails === null) return null;
  const cached = inputDetails?.cached_tokens === undefined ? 0 : inputDetails.cached_tokens, written = inputDetails?.cache_write_tokens === undefined ? 0 : inputDetails.cache_write_tokens;
  const reasoning = outputDetails?.reasoning_tokens === undefined ? 0 : outputDetails.reasoning_tokens;
  if (!count(input) || !count(output) || !count(cached) || !count(written) || !count(reasoning)) return null;
  if (cached + written > input || reasoning > output) return null;
  return { inputTokens: input, cachedInputTokens: cached, cacheWriteTokens: written, outputTokens: output, reasoningTokens: reasoning };
}

function incompleteBillingAttempt(a: ProviderBillingAttempt): boolean {
  return a.receipt?.cost_usd == null || a.receipt.generation_id === null || a.duplicate;
}

export class ProviderBillingLedger {
  readonly #pins = new Map<string, ProviderBillingPin>();
  readonly #attempts: ProviderBillingAttempt[] = [];
  readonly #generations = new Map<string, number>();
  #generationCost = 0;
  #judgeCost = 0;
  readonly #reasons = new Set<string>();

  register(pin: ProviderBillingPin): void {
    this.#pins.set(JSON.stringify(pin), pin);
  }

  begin(input: {
    pin: ProviderBillingPin; reservedUsd: number; purpose: "generation" | "judge";
    estimate: (usage: LlmUsage) => number;
    settle: (guardUsd: number) => void;
    holdExcess: (excessUsd: number) => void;
  }): { bind(signal: AbortSignal): void; close(allowSettlement?: boolean): void } {
    this.register(input.pin);
    const row: ProviderBillingAttempt = {
      attempt: this.#attempts.length + 1, purpose: input.purpose, pin: input.pin,
      reserved_usd: input.reservedUsd, state: "pending", duplicate: false,
      receipt: null, token_estimate_usd: null, guard_settled: false,
    };
    this.#attempts.push(row);
    let closed = false;
    let allowSettlement = false;
    let guardApplied = false;
    const applyGuard = (): void => {
      const cost = row.receipt?.cost_usd;
      if (!closed || guardApplied || row.duplicate || cost == null || row.receipt?.generation_id == null) return;
      guardApplied = true;
      if (allowSettlement && row.state !== "late" && row.token_estimate_usd !== null) {
        input.settle(Math.max(row.token_estimate_usd, cost));
        row.guard_settled = true;
      } else {
        // Preserve the legacy reservation on malformed/failed/late responses.
        input.holdExcess(Math.max(0, cost - input.reservedUsd));
      }
    };
    const note = (receipt: ProviderBillingReceipt, signal: AbortSignal): void => {
      if (row.receipt !== null) { this.#reasons.add("repeated-attempt-receipt"); return; }
      row.receipt = receipt;
      const late = closed || signal.aborted;
      row.state = late ? "late" : "returned";
      for (const reason of receipt.identity_reasons) this.#reasons.add(reason);
      if (receipt.usage !== null) row.token_estimate_usd = input.estimate(receipt.usage);
      const id = receipt.generation_id, cost = receipt.cost_usd;
      if (id === null || cost === null) return;
      if (this.#generations.has(id)) {
        row.duplicate = true;
        const conflict = this.#generations.get(id) !== cost;
        this.#reasons.add(conflict ? "conflicting-generation-cost" : "duplicate-generation-id");
        if (conflict) input.holdExcess(Math.max(0, cost - input.reservedUsd));
        return;
      }
      this.#generations.set(id, cost);
      if (input.purpose === "judge") this.#judgeCost += cost;
      else this.#generationCost += cost;
      applyGuard();
    };
    return {
      bind: (signal) => bindProviderBilling(signal, (receipt) => note(receipt, signal)),
      close: (allowed = false) => {
        if (closed) return;
        closed = true;
        allowSettlement = allowed;
        applyGuard();
      },
    };
  }

  snapshot(reservedUsd: number, spentUsd: number): ProviderBillingSummary {
    const unknown = this.#attempts.filter((a) => a.receipt?.cost_usd == null || a.receipt.generation_id === null).length;
    const reasons = new Set(this.#reasons);
    if (this.#attempts.length === 0) reasons.add("no-confirmed-attempts");
    if (unknown > 0) reasons.add("billing-unconfirmed");
    if (this.#attempts.some((a) => a.receipt !== null && a.receipt.usage === null)) reasons.add("token-usage-unconfirmed");
    if (this.#pins.size !== 1) reasons.add("mixed-arm-pins");
    const complete = this.#attempts.length > 0 && !this.#attempts.some(incompleteBillingAttempt);
    const invalidReasons = [...reasons];
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2022, sorting a fresh copy only.
    invalidReasons.sort();
    return {
      schema: "factory/provider-billing/v1", pins: [...this.#pins.values()],
      comparison_valid: reasons.size === 0, invalid_reasons: invalidReasons,
      actual_cost_usd: complete ? this.#generationCost + this.#judgeCost : null,
      observed_cost_subtotal_usd: this.#generationCost + this.#judgeCost,
      observed_generation_cost_subtotal_usd: this.#generationCost,
      observed_judge_cost_subtotal_usd: this.#judgeCost,
      actual_generation_cost_usd: this.#attempts.some((a) => a.purpose === "generation" && incompleteBillingAttempt(a)) ? null : this.#generationCost,
      actual_judge_cost_usd: this.#attempts.some((a) => a.purpose === "judge" && incompleteBillingAttempt(a)) ? null : this.#judgeCost,
      actual_cost_complete: complete,
      token_estimate_usd: this.#attempts.reduce((sum, a) => sum + (a.token_estimate_usd ?? 0), 0),
      unsettled_reservations_usd: reservedUsd, guard_spent_usd: spentUsd, unknown_attempts: unknown,
      attempts: this.#attempts.map((a) => ({ ...a })),
    };
  }
}
