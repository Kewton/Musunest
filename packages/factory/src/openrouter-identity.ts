import { pinnedModelMatches } from "./provider-model.js";
// S-175x: response router metadata is primary. Cache omissions are deferred;
// request pins never masquerade as returned provider or observed precision.
import type { ProviderBillingPin, ProviderBillingReceipt, ProviderIdentityEvidence } from "./provider-billing.js";

export const OPENROUTER_IDENTITY_POLICY = "router-metadata+catalog-model+deferred-generation/v3";
export const OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation";
export const GENERATION_CONFIRMATION_MS = 90000;
export const GENERATION_LOOKUP_TIMEOUT_MS = 3000;
export interface IdentityLookup {
  status: ProviderIdentityEvidence["lookup_status"];
  requests: number; http_status: number | null;
  id: string | null; provider: string | null; model: string | null; quantization: string | null;
}
export const emptyLookup = (): IdentityLookup => ({ status: "pending", requests: 0, http_status: null,
  id: null, provider: null, model: null, quantization: null });
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(value)
    && !/^(sk-|Bearer )/i.test(value) ? value : null;
}
export function exclusiveRoute(pin: ProviderBillingPin, route: Readonly<Record<string, unknown>>): boolean {
  return pin.identity_policy === OPENROUTER_IDENTITY_POLICY && Array.isArray(route.only)
    && route.only.length === 1 && route.only[0] === pin.arm && pin.arm.endsWith(`/${pin.quantization}`)
    && route.allow_fallbacks === false && route.require_parameters === true;
}

/** Validate corroborating facts while preserving all explicit response mismatches. */
export function identityEvidence(input: {
  receipt: ProviderBillingReceipt; pin: ProviderBillingPin; route: Readonly<Record<string, unknown>>;
  lookup: IdentityLookup; elapsed: number; source: "response" | "router-metadata" | "generation";
  terminal?: boolean; extraReasons?: readonly string[];
}): ProviderIdentityEvidence {
  const { receipt, pin, route, lookup, source } = input;
  const reasons = receipt.identity_reasons.filter((r) => r !== "provider-unconfirmed" && r !== "quantization-unconfirmed"
    && r !== "generation-metadata-id-unconfirmed" && r !== "generation-model-unconfirmed" && r !== "generation-lookup-unconfirmed");
  const exclusive = exclusiveRoute(pin, route);
  if (lookup.id === null) reasons.push("generation-metadata-id-unconfirmed");
  else if (lookup.id !== receipt.generation_id) reasons.push("generation-metadata-id-mismatch");
  if (lookup.model === null) reasons.push("generation-model-unconfirmed");
  else if (!pinnedModelMatches(pin, lookup.model) || !pinnedModelMatches(pin, receipt.returned_model)) reasons.push("generation-model-mismatch");
  if (lookup.provider === null) reasons.push("provider-unconfirmed");
  else if (!pin.provider_aliases.includes(lookup.provider)) reasons.push("provider-mismatch");
  if (lookup.quantization !== null && lookup.quantization !== pin.quantization) reasons.push("quantization-mismatch");
  let precision: ProviderIdentityEvidence["quantization_basis"] = null;
  if (receipt.returned_quantization !== null) precision = "response";
  else if (lookup.quantization !== null) precision = source === "generation" ? "generation" : "response";
  else if (exclusive) precision = "exclusive-endpoint";
  else reasons.push("quantization-unconfirmed");
  if (!exclusive) reasons.push("routing-pin-unconfirmed");
  reasons.push(...(input.extraReasons ?? []));
  const mismatch = reasons.some((r) => r.includes("mismatch") || r.includes("invalid") || r.includes("ambiguous"));
  const confirmed = reasons.length === 0 && (lookup.status === "ok" || lookup.status === "router-metadata");
  const state = confirmed ? "confirmed" : mismatch ? "invalid" : input.terminal === true ? "exhausted" : "pending";
  return { policy: OPENROUTER_IDENTITY_POLICY, source, confirmation_state: state,
    model_match_basis: lookup.model === null ? "unconfirmed" : !pinnedModelMatches(pin, lookup.model) ? "mismatch"
      : lookup.model === pin.model ? "requested-id" : "catalog-canonical",
    generation_id: receipt.generation_id,
    lookup_generation_id: source === "generation" ? lookup.id : null,
    lookup_provider: source === "generation" ? lookup.provider : null,
    lookup_model: source === "generation" ? lookup.model : null,
    lookup_quantization: source === "generation" ? lookup.quantization : null,
    ...(source === "router-metadata" ? { router_provider: lookup.provider, router_model: lookup.model } : {}),
    quantization_basis: precision, lookup_status: lookup.status, lookup_requests: lookup.requests,
    lookup_http_status: lookup.http_status, lookup_elapsed_ms: Math.max(0, input.elapsed), reasons: [...new Set(reasons)] };
}

/** Zero I/O on the generation path. Only an explicitly selected endpoint is proof. */
export function responseIdentity(wire: unknown, receipt: ProviderBillingReceipt, pin: ProviderBillingPin,
  route: Readonly<Record<string, unknown>>): ProviderIdentityEvidence {
  const base = emptyLookup();

  const metadata = object(object(wire)?.openrouter_metadata);
  const candidates = object(metadata?.endpoints)?.available;
  const selected = Array.isArray(candidates) ? candidates.map(object).filter((e) => e?.selected === true) : [];
  const extra: string[] = [];
  if (object(wire)?.openrouter_metadata != null && metadata === null) extra.push("router-metadata-invalid");
  if (selected.length > 1) extra.push("router-metadata-ambiguous");
  if (metadata?.requested !== undefined && metadata.requested !== pin.model) extra.push("router-model-mismatch");
  if (metadata?.attempts !== undefined) {
    if (!Array.isArray(metadata.attempts)) extra.push("router-metadata-invalid");
    else for (const a of metadata.attempts.map(object)) {
      const provider = identifier(a?.provider), model = identifier(a?.model);
      if (provider === null || model === null) extra.push("router-attempt-invalid");
      else if (!pin.provider_aliases.includes(provider) || !pinnedModelMatches(pin, model)) extra.push("router-attempt-mismatch");
    }
  }
  if (selected.length === 1) {
    const endpoint = selected[0]!;
    const rawPrecision = endpoint?.quantization ?? endpoint?.provider_quantization;
    if (rawPrecision != null && identifier(rawPrecision) === null) extra.push("router-quantization-invalid");
    return identityEvidence({ receipt, pin, route, elapsed: 0, source: "router-metadata", extraReasons: extra, terminal: receipt.returned_model === null || receipt.generation_id === null,
      lookup: { ...base, status: "router-metadata", id: receipt.generation_id,
        provider: identifier(endpoint?.provider), model: identifier(endpoint?.model), quantization: identifier(rawPrecision) } });
  }
  if (receipt.returned_provider !== null && receipt.returned_quantization !== null) {
    return identityEvidence({ receipt, pin, route, elapsed: 0, source: "response", terminal: true, extraReasons: extra,
      lookup: { ...base, status: "ok", id: receipt.generation_id, provider: receipt.returned_provider,
        model: receipt.returned_model, quantization: receipt.returned_quantization } });
  }
  return identityEvidence({ receipt, pin, route, elapsed: 0, source: "generation", lookup: base,
    terminal: receipt.generation_id === null, extraReasons: extra });
}
