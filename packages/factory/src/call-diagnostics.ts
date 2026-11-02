// Safe classifications only. Never retain exception text, headers, or arbitrary provider strings.
import type { CallAttemptEnd, CallAttemptObservation, CallAttemptObserver } from "./call.js";
export const INCOMPLETE_REASONS = ["max_output_tokens", "content_filter", "error", "cancelled"] as const;
export const RESPONSE_STATUSES = ["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"] as const;
export const incompleteReason = (value: unknown): string => INCOMPLETE_REASONS.includes(value as never) ? String(value) : "unknown";
export const responseStatus = (value: unknown): string => RESPONSE_STATUSES.includes(value as never) ? String(value) : "unknown";
export interface CallDiagnosticDetail { readonly incomplete_reason?: string; readonly response_status?: string; readonly http_status?: number }
const wireHooks = new WeakMap<AbortSignal, (detail: CallDiagnosticDetail) => void>();
export const bindCallDiagnostic = (signal: AbortSignal, hook: (detail: CallDiagnosticDetail) => void): void => { wireHooks.set(signal, hook); };
/** Called after reading a response body, before HTTP/JSON validation. No work without an observer. */
export function noteWireDiagnostic(signal: AbortSignal | undefined, status: number, text: string): void {
  const hook = signal === undefined ? undefined : wireHooks.get(signal);
  if (hook === undefined) return;
  try {
    let wire: Record<string, unknown> = {};
    try { const value = JSON.parse(text) as unknown; if (typeof value === "object" && value !== null && !Array.isArray(value)) wire = value as Record<string, unknown>; } catch { /* HTTP code remains useful for invalid JSON */ }
    const details = wire["incomplete_details"];
    const reason = typeof details === "object" && details !== null ? (details as Record<string, unknown>)["reason"] : undefined;
    hook({ http_status: status, ...(typeof wire["status"] === "string" ? { response_status: responseStatus(wire["status"]) } : {}),
      ...(typeof reason === "string" ? { incomplete_reason: incompleteReason(reason) } : {}) });
  } catch { /* diagnostic hooks never affect HTTP handling */ }
}
export function callDiagnosticDetail(error: unknown, end: CallAttemptEnd): CallDiagnosticDetail {
  const e = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  return { ...(end.kind === "incomplete" ? { incomplete_reason: incompleteReason(e["reason"]), response_status: responseStatus(e["responseStatus"]) } : {}),
    ...(typeof e["status"] === "number" && Number.isInteger(e["status"]) && e["status"] >= 100 && e["status"] <= 599 ? { http_status: e["status"] } : {}) };
}
const safely = (action: () => void): void => { try { action(); } catch { /* observation cannot alter the job */ } };
/** Preserve the existing observer's inputs; isolate the additional observer from control and mutation. */
export function addObserver(existing: CallAttemptObserver | undefined, extra: CallAttemptObserver): CallAttemptObserver {
  return {
    beginCall: () => { existing?.beginCall?.(); safely(() => extra.beginCall?.()); },
    beginAttempt: () => {
      const old = existing?.beginAttempt();
      let added: CallAttemptObservation | undefined;
      safely(() => { added = extra.beginAttempt(); });
      return {
        settle: (end) => { old?.settle(end); safely(() => added?.settle(structuredClone(end))); },
        late: (usage) => { old?.late(usage); safely(() => added?.late(structuredClone(usage))); },
        note: (bound) => { old?.note?.(bound); safely(() => added?.note?.(bound)); },
        ledger: (attempt) => { old?.ledger?.(attempt); safely(() => added?.ledger?.(attempt)); },
        detail: (detail) => { old?.detail?.(detail); safely(() => added?.detail?.(structuredClone(detail))); },
      };
    },
  };
}
