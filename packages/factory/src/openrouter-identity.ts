// S-175w: Responses does not promise provider/precision fields. Resolve provider by
// generation ID; precision may be enforced by the exclusive variant endpoint.
// Never copy a requested value into a returned-value field or change billed cost.
import type { FetchLike } from "./openai.js";
import type { ProviderBillingPin, ProviderBillingReceipt, ProviderIdentityEvidence } from "./provider-billing.js";

export const OPENROUTER_IDENTITY_POLICY = "generation-provider+exclusive-endpoint/v1";
export const OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation";
export const GENERATION_LOOKUP_TIMEOUT_MS = 2000;

interface Lookup {
  status: "ok" | "http" | "invalid" | "network" | "timeout" | "aborted" | "not-requested";
  requests: number;
  http_status: number | null;
  id: string | null;
  provider: string | null;
  model: string | null;
  quantization: string | null;
}

const emptyLookup = (): Lookup => ({ status: "not-requested", requests: 0, http_status: null,
  id: null, provider: null, model: null, quantization: null });
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(value)
    && !/^(sk-|Bearer )/i.test(value) ? value : null;
}

/** Bound both headers and body; even a fetch ignoring abort cannot delay the caller. */
async function lookupGeneration(fetch: FetchLike, apiKey: string, id: string, parent: AbortSignal): Promise<Lookup> {
  const controller = new AbortController();
  let current = emptyLookup();
  let timedOut = false;
  let finishAbort!: (value: Lookup) => void;
  const aborted = new Promise<Lookup>((resolve) => { finishAbort = resolve; });
  const onAbort = (): void => {
    controller.abort();
    finishAbort({ ...current, status: timedOut ? "timeout" : "aborted" });
  };
  parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; onAbort(); }, GENERATION_LOOKUP_TIMEOUT_MS);
  const query = async (): Promise<Lookup> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (controller.signal.aborted || parent.aborted) return { ...current, status: timedOut ? "timeout" : "aborted" };
      current = { ...current, requests: current.requests + 1 };
      try {
        const response = await fetch(`${OPENROUTER_GENERATION_URL}?${new URLSearchParams({ id })}`, {
          method: "GET", headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: controller.signal,
        });
        current = { ...current, http_status: response.status };
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          current = { ...current, status: "http" };
          if (attempt === 0 && (response.status === 404 || response.status === 429 || response.status >= 500)) {
            // Metadata may lag the response. One bounded retry, no generation retry.
            await new Promise<void>((resolve) => {
              const done = (): void => { clearTimeout(delay); controller.signal.removeEventListener("abort", done); resolve(); };
              const delay = setTimeout(done, 100);
              controller.signal.addEventListener("abort", done, { once: true });
              if (controller.signal.aborted) done();
            });
            continue;
          }
          return current;
        }
        const text = await response.text();
        if (text.length > 64000) return { ...current, status: "invalid" };
        let wire: unknown;
        try { wire = JSON.parse(text); } catch { return { ...current, status: "invalid" }; }
        const data = object(object(wire)?.data);
        if (data === null) return { ...current, status: "invalid" };
        const rawQuantization = data.quantization ?? data.provider_quantization;
        // Missing precision is allowed only with exclusive-endpoint evidence below;
        // an explicitly malformed precision is a failed metadata lookup.
        if (rawQuantization !== undefined && identifier(rawQuantization) === null) return { ...current, status: "invalid" };
        return { ...current, status: "ok", id: identifier(data.id), provider: identifier(data.provider_name),
          model: identifier(data.model), quantization: identifier(rawQuantization) };
      } catch {
        return { ...current, status: controller.signal.aborted ? (timedOut ? "timeout" : "aborted") : "network" };
      }
    }
    return current;
  };
  try {
    if (parent.aborted) onAbort();
    return await Promise.race([aborted, query()]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }
}

/** The route is the actual immutable request body, not user supplied evidence. */
export async function openRouterIdentity(input: {
  receipt: ProviderBillingReceipt; pin: ProviderBillingPin; route: Readonly<Record<string, unknown>>;
  fetch: FetchLike; apiKey: string; signal: AbortSignal;
}): Promise<ProviderIdentityEvidence> {
  const { receipt, pin, route } = input;
  const started = Date.now();
  const lookup = receipt.generation_id === null || input.signal.aborted ? emptyLookup()
    : await lookupGeneration(input.fetch, input.apiKey, receipt.generation_id, input.signal);
  const reasons = receipt.identity_reasons.filter((r) => r !== "provider-unconfirmed" && r !== "quantization-unconfirmed");
  const exclusive = pin.identity_policy === OPENROUTER_IDENTITY_POLICY
    && Array.isArray(route.only) && route.only.length === 1 && route.only[0] === pin.arm
    && pin.arm.endsWith(`/${pin.quantization}`) && route.allow_fallbacks === false && route.require_parameters === true;
  let precision: ProviderIdentityEvidence["quantization_basis"] = null;
  if (input.signal.aborted) reasons.push("generation-lookup-aborted");
  if (lookup.status !== "ok") reasons.push("generation-lookup-unconfirmed");
  if (lookup.id === null) reasons.push("generation-metadata-id-unconfirmed");
  else if (lookup.id !== receipt.generation_id) reasons.push("generation-metadata-id-mismatch");
  if (lookup.model === null) reasons.push("generation-model-unconfirmed");
  else if (lookup.model !== pin.model || lookup.model !== receipt.returned_model) reasons.push("generation-model-mismatch");
  if (lookup.provider === null) reasons.push("provider-unconfirmed");
  else if (!pin.provider_aliases.includes(lookup.provider)) reasons.push("provider-mismatch");
  if (lookup.quantization !== null && lookup.quantization !== pin.quantization) reasons.push("quantization-mismatch");
  if (receipt.returned_quantization !== null) precision = "response";
  else if (lookup.quantization !== null) precision = "generation";
  else if (exclusive) precision = "exclusive-endpoint";
  else reasons.push("quantization-unconfirmed");
  if (!exclusive) reasons.push("routing-pin-unconfirmed");
  return { policy: OPENROUTER_IDENTITY_POLICY, generation_id: receipt.generation_id,
    lookup_generation_id: lookup.id, lookup_provider: lookup.provider, lookup_model: lookup.model,
    lookup_quantization: lookup.quantization, quantization_basis: precision,
    lookup_status: lookup.status, lookup_requests: lookup.requests, lookup_http_status: lookup.http_status,
    lookup_elapsed_ms: Math.max(0, Date.now() - started), reasons: [...new Set(reasons)] };
}
