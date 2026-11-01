// S-175x: native CLI work completes before the independent confirmation window.
// Only host billing sidecars and the optional summary field are updated; bundles,
// verdicts, generation deadlines and reservations are not rewritten.
import type { CliDeps } from "./cli.js";
import type { ProviderBillingFinalizer, ProviderBillingSummary } from "./provider-billing.js";
import { GENERATION_CONFIRMATION_MS } from "./openrouter-identity.js";

function record(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function billing(value: unknown): value is ProviderBillingSummary {
  return value !== null && typeof value === "object" && (value as { schema?: unknown }).schema === "factory/provider-billing/v1";
}

export async function runWithDeferredBilling(deps: CliDeps, run: (deps: CliDeps) => Promise<number>): Promise<number> {
  const finalizers = new Set<ProviderBillingFinalizer>();
  const sidecars = new Map<string, number>();
  const summaries: { record: Record<string, unknown>; index: number }[] = [];
  const snapshots: ProviderBillingSummary[] = [];
  const keys = new Map<string, number>();
  const remember = (snapshot: ProviderBillingSummary): number => {
    const key = JSON.stringify(snapshot);
    const existing = keys.get(key);
    if (existing !== undefined) return existing;
    const index = snapshots.length;
    snapshots.push(snapshot); keys.set(key, index); return index;
  };
  const log = deps.log ?? (() => {});
  const code = await run({ ...deps,
    makeClient: (options) => {
      const client = deps.makeClient(options);
      if (client.finalizeProviderBilling !== undefined) finalizers.add(client.finalizeProviderBilling);
      return client;
    },
    writeFile: async (path, text) => {
      if (finalizers.size > 0 && /(?:^|\/)(?:plan-)?provider-billing\.json$/.test(path)) {
        const value = record(text);
        if (billing(value)) sidecars.set(path, remember(value));
      }
      await deps.writeFile(path, text);
    },
    log: (line) => {
      const value = finalizers.size === 0 ? null : record(line);
      if (value?.schema_version === "commandagent.headless-summary/v1" && billing(value.provider_billing)) {
        // Never emit a premature native summary that a collector could take as final.
        summaries.push({ record: value, index: remember(value.provider_billing) });
      } else log(line);
    },
  });
  if (snapshots.length === 0) return code;
  const deadline = Date.now() + GENERATION_CONFIRMATION_MS;
  let current: readonly ProviderBillingSummary[] = snapshots;
  const onProgress = async (next: readonly ProviderBillingSummary[]): Promise<void> => {
    for (const [path, index] of sidecars) {
      const snapshot = next[index]!;
      await deps.writeFile(path, JSON.stringify(snapshot));
      if (snapshot.identity_confirmation !== undefined) {
        await deps.writeFile(path.replace(/provider-billing\.json$/, "provider-identity-confirmation.json"), JSON.stringify({
          schema: "factory/provider-confirmation/v1", policy: snapshot.pins[0]?.identity_policy,
          ...snapshot.identity_confirmation, comparison_valid: snapshot.comparison_valid,
        }));
      }
    }
  };
  for (const finalize of finalizers) current = await finalize(current, { deadline, onProgress });
  await onProgress(current);
  for (const summary of summaries) log(JSON.stringify({ ...summary.record, provider_billing: current[summary.index] }));
  return code;
}
