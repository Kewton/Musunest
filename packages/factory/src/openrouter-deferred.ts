// Confirmation is outside generation deadlines. Missing facts never become a valid arm.
import type { FetchLike } from "./openai.js";
import { assessProviderComparison } from "./provider-comparison.js";
import type { ProviderBillingFinalizer, ProviderBillingPin, ProviderBillingReceipt, ProviderBillingSummary,
  ProviderConfirmationTransition, ProviderIdentityEvidence } from "./provider-billing.js";
import { emptyLookup, GENERATION_CONFIRMATION_MS, GENERATION_LOOKUP_TIMEOUT_MS, identifier,
  identityEvidence, object, OPENROUTER_GENERATION_URL, type IdentityLookup } from "./openrouter-identity.js";

/** One bounded, metadata-only GET. Do not read or merge cost from this response. */
async function lookupOnce(fetch: FetchLike, apiKey: string, id: string, deadline: number, requests: number): Promise<IdentityLookup> {
  const controller = new AbortController();
  const base = { ...emptyLookup(), requests };
  let finish!: (value: IdentityLookup) => void;
  const timeout = new Promise<IdentityLookup>((resolve) => { finish = resolve; });
  const timer = setTimeout(() => { controller.abort(); finish({ ...base, status: "timeout" }); },
    Math.max(0, Math.min(GENERATION_LOOKUP_TIMEOUT_MS, deadline - Date.now())));
  const query = async (): Promise<IdentityLookup> => {
    try {
      const response = await fetch(`${OPENROUTER_GENERATION_URL}?${new URLSearchParams({ id })}`, {
        method: "GET", headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: controller.signal,
      });
      const current = { ...base, http_status: response.status };
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { ...current, status: "http" }; }
      const text = await response.text();
      if (text.length > 64000) return { ...current, status: "invalid" };
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return { ...current, status: "invalid" }; }
      const data = object(object(parsed)?.data);
      if (data === null) return { ...current, status: "invalid" };
      const raw = data.quantization ?? data.provider_quantization;
      if (raw != null && identifier(raw) === null) return { ...current, status: "invalid" };
      return { ...current, status: "ok", id: identifier(data.id), provider: identifier(data.provider_name),
        model: identifier(data.model), quantization: identifier(raw) };
    } catch {
      return { ...base, status: controller.signal.aborted ? "timeout" : "network" };
    }
  };
  try { return await Promise.race([timeout, query()]); }
  finally { clearTimeout(timer); }
}

function retryable(lookup: IdentityLookup): boolean {
  return (lookup.status === "ok" && (lookup.id === null || lookup.model === null || lookup.provider === null))
    || lookup.status === "timeout" || lookup.status === "network"
    || (lookup.status === "http" && (lookup.http_status === 404 || lookup.http_status === 429 || (lookup.http_status ?? 0) >= 500));
}

/** Re-project identity only; invoice, dedup, estimates and reservations remain untouched. */
export function projectConfirmation(snapshot: ProviderBillingSummary, evidence: ReadonlyMap<number, ProviderIdentityEvidence>,
  terminal: boolean): ProviderBillingSummary {
  const previousIdentityReasons = new Set(snapshot.attempts.flatMap((a) => a.receipt?.identity_reasons ?? []));
  const reasons = new Set(snapshot.invalid_reasons.filter((r) => !previousIdentityReasons.has(r)));
  const attempts = snapshot.attempts.map((a) => {
    const next = evidence.get(a.attempt);
    if (a.receipt === null || next === undefined) return a;
    return { ...a, receipt: { ...a.receipt, identity_evidence: next, identity_reasons: next.reasons } };
  });
  for (const a of attempts) for (const reason of a.receipt?.identity_reasons ?? []) reasons.add(reason);
  const pending = attempts.filter((a) => a.receipt?.identity_evidence?.confirmation_state === "pending").length;
  const confirmed = attempts.filter((a) => a.receipt?.identity_evidence?.confirmation_state === "confirmed").length;
  const invalid = attempts.some((a) => a.receipt?.identity_evidence?.confirmation_state === "invalid");
  const valid = reasons.size === 0 && snapshot.actual_cost_complete && pending === 0;
  const assessment = assessProviderComparison({ ...snapshot, attempts, comparison_valid: valid, invalid_reasons: [...reasons] });
  const state: ProviderConfirmationTransition["state"] = invalid ? "invalid" : assessment.identity_valid ? "confirmed" : pending > 0 && !terminal ? "pending" : "unconfirmed";
  const transitions = [...(snapshot.identity_confirmation?.transitions ?? []), { at_ms: Date.now(), state, pending, confirmed }];
  return { ...assessment, identity_confirmation: { state, transitions } };
}

export function createDeferredConfirmation(input: {
  pin: ProviderBillingPin; route: Readonly<Record<string, unknown>>; fetch: FetchLike; apiKey: string;
}): ProviderBillingFinalizer {
  return async (snapshots, options) => {
    const started = Date.now();
    const deadline = Math.min(options.deadline, started + GENERATION_CONFIRMATION_MS);
    const matches = (snapshot: ProviderBillingSummary): boolean => snapshot.pins.some((p) => JSON.stringify(p) === JSON.stringify(input.pin));
    type Entry = { snapshot: number; attempt: number; receipt: ProviderBillingReceipt; evidence: ProviderIdentityEvidence };
    const entries: Entry[] = [];
    const maps = snapshots.map((snapshot, index) => {
      const map = new Map<number, ProviderIdentityEvidence>();
      if (matches(snapshot)) for (const a of snapshot.attempts) {
        const ev = a.receipt?.identity_evidence;
        if (a.receipt !== null && ev !== undefined) {
          map.set(a.attempt, ev);
          if (ev.confirmation_state === "pending" && a.receipt.generation_id !== null) entries.push({ snapshot: index, attempt: a.attempt, receipt: a.receipt, evidence: ev });
        }
      }
      return map;
    });
    let current: readonly ProviderBillingSummary[] = snapshots;
    const progress = async (terminal: boolean): Promise<void> => {
      current = current.map((snapshot, index) => matches(snapshot) ? projectConfirmation(snapshot, maps[index]!, terminal) : snapshot);
      await options.onProgress(current);
    };
    await progress(false);
    // Explicit contradictions are terminal; no later lookup may hide them.
    if (current.some((s) => matches(s) && s.identity_confirmation?.state === "invalid")) return current;
    const pending = new Set(entries.map((e) => e.receipt.generation_id!));
    const requests = new Map<string, number>();
    for (let round = 0; round < 8 && pending.size > 0 && Date.now() < deadline; round++) {
      if (round > 0) {
        const delay = Math.min(30000, 1000 * 2 ** (round - 1), Math.max(0, deadline - Date.now()));
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      const ids = [...pending];
      let cursor = 0;
      let contradiction = false;
      const worker = async (): Promise<void> => {
        while (cursor < ids.length && Date.now() < deadline && !contradiction) {
          const id = ids[cursor++]!;
          const count = (requests.get(id) ?? 0) + 1;
          requests.set(id, count);
          const lookup = await lookupOnce(input.fetch, input.apiKey, id, deadline, count);
          const expired = Date.now() >= deadline;
          const terminal = !retryable(lookup) || round === 7 || expired;
          const sameId = entries.filter((e) => e.receipt.generation_id === id);
          let stillPending = false;
          for (const e of sameId) {
            const ev = identityEvidence({ receipt: e.receipt, pin: input.pin, route: input.route, lookup,
              elapsed: Date.now() - started, source: "generation", terminal,
              ...((expired || (terminal && lookup.status !== "ok")) ? { extraReasons: ["generation-lookup-exhausted"] } : {}) });
            if (ev.confirmation_state === "invalid") contradiction = true;
            e.evidence = ev;
            maps[e.snapshot]!.set(e.attempt, ev);
            if (ev.confirmation_state === "pending") stillPending = true;
          }
          if (!stillPending) pending.delete(id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      await progress(false);
      if (current.some((s) => matches(s) && s.identity_confirmation?.state === "invalid")) return current;
    }
    for (const e of entries) if (e.evidence.confirmation_state === "pending") {
      maps[e.snapshot]!.set(e.attempt, { ...e.evidence, confirmation_state: "exhausted",
        lookup_elapsed_ms: Math.max(0, Date.now() - started), reasons: [...e.evidence.reasons, "generation-lookup-exhausted"] });
    }
    await progress(true);
    return current;
  };
}
