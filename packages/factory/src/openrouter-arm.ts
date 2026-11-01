// Arm-specific routing and dated public prices (S-175v); no model-name branching.
import { OPENROUTER_IDENTITY_POLICY } from "./openrouter-identity.js";
import type { ProviderBillingPin } from "./provider-billing.js";

export const OPENROUTER_ARMS = ["open-inference/fp4", "morph/fp8"] as const;
export type OpenRouterArm = (typeof OPENROUTER_ARMS)[number];
export const DEFAULT_OPENROUTER_ARM: OpenRouterArm = "morph/fp8";

export function isOpenRouterArm(value: string): value is OpenRouterArm {
  return (OPENROUTER_ARMS as readonly string[]).includes(value);
}

/** Return an immutable snapshot. Neither caller mutation nor resume may change its meaning. */
export function openRouterArmPin(arm: string, model: string): ProviderBillingPin {
  if (!isOpenRouterArm(arm)) throw new RangeError("openrouter:unknown-arm");
  const oi = arm === "open-inference/fp4";
  return Object.freeze({
    identity_policy: OPENROUTER_IDENTITY_POLICY,
    arm, model, quantization: oi ? "fp4" : "fp8",
    provider_aliases: Object.freeze(oi ? ["OpenInference", "open-inference", arm] : ["Morph", "morph", arm]),
    rates: Object.freeze({ inputPerToken: (oi ? .0098 : .042) / 1e6,
      cachedInputPerToken: (oi ? .0098 : .018) / 1e6,
      cacheWritePerToken: (oi ? .0098 : .042) / 1e6, outputPerToken: (oi ? .1702 : .30) / 1e6 }),
    pricing_source: "https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints",
    pricing_observed_at: "2026-11-01T06:05:23Z",
  });
}
