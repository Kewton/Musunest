// S-175y: exact catalog edges, never a prefix/date heuristic or an alias equivalence class.
import { OPENROUTER_MODEL_CATALOG } from "./openrouter-model-catalog.js";

export interface ProviderModelIdentity {
  readonly policy: "models-api-id-canonical/v1" | "exact-only/v1";
  readonly requested: string;
  readonly canonical_slug: string | null;
  readonly source: string;
  readonly observed_at: string;
  readonly catalog_sha256: string;
}

/** Immutable, reviewed public metadata. Unknown requests retain exact-only semantics. */
export function modelIdentityPin(requested: string): ProviderModelIdentity {
  const rows = OPENROUTER_MODEL_CATALOG.records.filter((row) => row.id === requested);
  const canonical = rows.length === 1 ? rows[0]!.canonical_slug : null;
  return Object.freeze({ policy: canonical === null ? "exact-only/v1" : "models-api-id-canonical/v1", requested,
    canonical_slug: canonical, source: OPENROUTER_MODEL_CATALOG.source,
    observed_at: OPENROUTER_MODEL_CATALOG.observed_at, catalog_sha256: OPENROUTER_MODEL_CATALOG.catalog_sha256 });
}

export function pinnedModelMatches(pin: { readonly model: string; readonly model_identity?: ProviderModelIdentity },
  observed: string | null): boolean {
  if (observed === null) return false;
  const proof = pin.model_identity;
  if (proof === undefined) return observed === pin.model;
  const expected = modelIdentityPin(pin.model);
  // A caller cannot substitute an unpinned edge or a proof for another request.
  if (proof.policy !== expected.policy || proof.requested !== expected.requested
    || proof.canonical_slug !== expected.canonical_slug || proof.source !== expected.source
    || proof.observed_at !== expected.observed_at || proof.catalog_sha256 !== expected.catalog_sha256) return false;
  return observed === pin.model || (expected.canonical_slug !== null && observed === expected.canonical_slug);
}
